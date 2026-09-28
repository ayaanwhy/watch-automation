import json
import os
import tempfile
import unittest
import copy

import cv2
import numpy as np
import torch

from vto.gems import foreground_mask_all
from vto.data import CachedPairs
from vto.layer_refiner import (LayerRefiner, TO_BACK, TO_BACKGROUND, TO_FRONT,
                               apply_layer_actions, transition_targets)
from vto.model import (DualDecoderRingUNet, RingUNet, boundary_band, loss_fn,
                       model_from_checkpoint)
from vto.post import (antialias_inward, antialias_subpixel,
                      clean_gem_silhouette, decontaminate,
                      fill_metal_holes,
                      refine_plain_background_contour, regularize_back_band,
                      recover_plain_background_edges,
                      repair_abrupt_front_tip, repair_shoulder_slits,
                      repair_upper_ring_opening,
                      separate_thin_back_bridge,
                      remove_alpha_specks, reassign_back_specks,
                      smooth_gem_matte,
                      reassign_front_specks, scale_component_area,
                      select_layer_actions, resize_layer_actions,
                      resize_layer_partition,
                      split_layers, to_rgba,
                      trim_background_edge, veto_background,
                      veto_enclosed_background)
from vto.predict import output_name
from vto.refiner import HybridRingModel, MatteRefiner
from vto.ownership_refiner import OwnershipRefiner, apply_actions
from vto.train import configure_finetune, restore_matte_projection, split_groups


class VtoTests(unittest.TestCase):
    def test_predict_can_name_repeated_source_files_from_parent(self):
        self.assertEqual(output_name("/tmp/case-a/source.jpg", True), "case-a")
        self.assertEqual(output_name("/tmp/case-a/source.jpg", False), "source")

    def test_dual_decoder_is_exact_baseline_matte_and_candidate_back(self):
        baseline = RingUNet(pretrained=False).eval()
        candidate = copy.deepcopy(baseline).eval()
        with torch.no_grad():
            candidate.up0.block[0].weight.add_(0.001)
            candidate.head.bias[1].add_(0.1)
        fused = DualDecoderRingUNet(baseline, candidate).eval()
        image = torch.rand(1, 3, 64, 64)
        with torch.no_grad():
            expected = torch.cat((baseline(image)[:, :1],
                                  candidate(image)[:, 1:2]), dim=1)
            actual = fused(image)
        torch.testing.assert_close(actual, expected, rtol=0, atol=0)

    def test_checkpoint_loader_supports_dual_decoder(self):
        model = DualDecoderRingUNet().eval()
        loaded = model_from_checkpoint({
            "architecture": DualDecoderRingUNet.architecture,
            "model": model.state_dict(),
        }).eval()
        image = torch.rand(1, 3, 64, 64)
        with torch.no_grad():
            torch.testing.assert_close(loaded(image), model(image), rtol=0, atol=0)

    def test_back_refine_only_trains_only_native_resolution_decoder(self):
        model = RingUNet(pretrained=False)
        frozen, matte, freeze_matte = configure_finetune(
            model, back_refine_only=True)
        trainable = {name for name, parameter in model.named_parameters()
                     if parameter.requires_grad}
        self.assertTrue(trainable)
        self.assertTrue(all(name.startswith(("up1.", "up0.", "head."))
                            for name in trainable))
        self.assertTrue(any(name.startswith("up1.") for name in trainable))
        self.assertTrue(any(name.startswith("up0.") for name in trainable))
        self.assertTrue(freeze_matte)
        self.assertIsNotNone(matte)
        self.assertIn(model.up2, frozen)
        self.assertNotIn(model.up1, frozen)

    def test_matte_projection_is_restored_exactly_after_optimizer_step(self):
        model = RingUNet(pretrained=False)
        _, matte, _ = configure_finetune(model, freeze_matte_head=True)
        original_weight = matte["weight"].clone()
        original_bias = matte["bias"].clone()
        optimizer = torch.optim.AdamW(model.parameters(), lr=0.1, weight_decay=0.1)
        model.head.weight.grad = torch.ones_like(model.head.weight)
        model.head.bias.grad = torch.ones_like(model.head.bias)
        optimizer.step()
        restore_matte_projection(model, matte)
        torch.testing.assert_close(model.head.weight[:1], original_weight,
                                   rtol=0, atol=0)
        torch.testing.assert_close(model.head.bias[:1], original_bias,
                                   rtol=0, atol=0)

    def test_ownership_finetune_scopes_are_mutually_exclusive(self):
        with self.assertRaisesRegex(ValueError, "mutually exclusive"):
            configure_finetune(RingUNet(pretrained=False),
                               back_head_only=True, back_refine_only=True)

    def test_back_decoder_only_keeps_resnet_encoder_frozen(self):
        model = RingUNet(pretrained=False)
        frozen, _, _ = configure_finetune(model, back_decoder_only=True)
        trainable = {name for name, parameter in model.named_parameters()
                     if parameter.requires_grad}
        self.assertTrue(all(name.startswith(("up", "head.")) for name in trainable))
        self.assertTrue(any(name.startswith("up4.") for name in trainable))
        self.assertFalse(any(name.startswith("l4.") for name in trainable))
        self.assertIn(model.l4, frozen)
        self.assertNotIn(model.up4, frozen)

    def test_refiner_starts_as_exact_identity(self):
        refiner = MatteRefiner(band_radius=2).eval()
        rgb = torch.rand(1, 3, 24, 24)
        coarse = torch.randn(1, 1, 24, 24)
        torch.testing.assert_close(refiner(rgb, coarse), coarse)

    def test_refiner_residual_is_confined_to_contour_band(self):
        refiner = MatteRefiner(band_radius=2).eval()
        coarse = torch.full((1, 1, 24, 24), -8.0)
        coarse[:, :, 6:18, 6:18] = 8.0
        with torch.no_grad():
            refiner.head.bias.fill_(1.0)
        refined = refiner(torch.rand(1, 3, 24, 24), coarse)
        band = refiner.contour_band(coarse).bool()
        torch.testing.assert_close(refined[~band], coarse[~band])
        self.assertGreater(float((refined[band] - coarse[band]).abs().sum()), 0.0)

    def test_hybrid_passes_base_back_logit_unchanged(self):
        class TinyBase(torch.nn.Module):
            def forward(self, x):
                return torch.cat([x[:, :1], x[:, 1:2] * 2.0], dim=1)

        base = TinyBase().eval()
        model = HybridRingModel(base, MatteRefiner(2).eval(), base_size=16).eval()
        x = torch.rand(1, 3, 24, 24)
        expected = torch.nn.functional.interpolate(
            base(torch.nn.functional.interpolate(
                x, size=(16, 16), mode="bilinear", align_corners=False))[:, 1:2],
            size=(24, 24), mode="bilinear", align_corners=False)
        torch.testing.assert_close(model(x)[:, 1:2], expected)

    def test_ownership_refiner_starts_as_exact_binary_identity(self):
        model = OwnershipRefiner(no_edit_logit=-6.0).eval()
        rgb = torch.rand(1, 3, 32, 32)
        full = torch.zeros(1, 1, 32, 32)
        full[:, :, 3:29, 3:29] = 1.0
        back = torch.zeros_like(full)
        back[:, :, 20:29, 3:29] = 1.0
        with torch.no_grad():
            predicted = apply_actions(back, model(rgb, full, back))
        torch.testing.assert_close(predicted, back.bool())

    def test_layer_refiner_starts_as_exact_partition_identity(self):
        model = LayerRefiner().eval()
        rgb = torch.rand(2, 3, 32, 32)
        full = torch.zeros(2, 1, 32, 32)
        full[:, :, 4:28, 3:29] = 1.0
        back = torch.zeros_like(full)
        back[:, :, 20:28, 3:29] = 1.0
        with torch.no_grad():
            refined_full, refined_back, actions = apply_layer_actions(
                full, back, model(rgb, full, back))
        torch.testing.assert_close(refined_full, full.bool())
        torch.testing.assert_close(refined_back, back.bool())
        self.assertEqual(int(actions.sum()), 0)

    def test_layer_transition_targets_cover_matte_and_ownership_edits(self):
        full = torch.zeros(1, 1, 12, 12)
        full[:, :, 2:10, 2:10] = 1.0
        back = torch.zeros_like(full)
        back[:, :, 7:10, 2:10] = 1.0
        target_full = full.clone()
        target_back = back.clone()
        target_full[:, :, 2, 2] = 0.0
        target_full[:, :, 1, 6] = 1.0
        target_back[:, :, 1, 6] = 1.0
        target_back[:, :, 4, 4] = 1.0
        target_back[:, :, 8, 4] = 0.0
        labels = transition_targets(full, back, target_full, target_back)
        self.assertEqual(int(labels[0, 0, 2, 2]), TO_BACKGROUND)
        self.assertEqual(int(labels[0, 0, 1, 6]), TO_BACK)
        self.assertEqual(int(labels[0, 0, 4, 4]), TO_BACK)
        self.assertEqual(int(labels[0, 0, 8, 4]), TO_FRONT)

    def test_layer_actions_remain_an_exact_partition(self):
        full = torch.zeros(1, 1, 10, 10)
        full[:, :, 2:9, 1:9] = 1.0
        back = torch.zeros_like(full)
        back[:, :, 7:9, 1:9] = 1.0
        logits = torch.full((1, 4, 10, 10), -20.0)
        logits[:, 0] = 20.0
        for action, y, x in ((TO_BACKGROUND, 2, 2),
                             (TO_FRONT, 8, 3),
                             (TO_BACK, 1, 5)):
            logits[0, 0, y, x] = -20.0
            logits[0, action, y, x] = 20.0
        refined_full, refined_back, _ = apply_layer_actions(
            full, back, logits)
        self.assertFalse(bool(refined_full[0, 0, 2, 2]))
        self.assertFalse(bool(refined_back[0, 0, 8, 3]))
        self.assertTrue(bool(refined_full[0, 0, 1, 5]))
        self.assertTrue(bool(refined_back[0, 0, 1, 5]))
        self.assertFalse(bool((refined_back & ~refined_full).any()))

    def test_discrete_layer_actions_preserve_all_classes_when_resized(self):
        probability = np.zeros((4, 4, 4), np.float32)
        probability[0] = 1.0
        for action_class, y, x in ((1, 1, 1), (2, 1, 2), (3, 2, 2)):
            probability[:, y, x] = 0.0
            probability[action_class, y, x] = 1.0
        actions = select_layer_actions(
            probability, class_thresholds=(0.9, 0.9, 0.9))
        native = resize_layer_actions(actions, (2, 10, 3, 11), (12, 14))
        self.assertEqual(set(np.unique(native)), {0, 1, 2, 3})
        self.assertTrue(np.all(native[:2] == 0))
        self.assertTrue(np.all(native[:, :3] == 0))

    def test_forced_holdout_never_leaks_related_views(self):
        with tempfile.TemporaryDirectory() as root:
            items = []
            for name, design, family in (
                    ("halo_a_png", "halo_a", "halo"),
                    ("halo_a_jpg", "halo_a", "halo"),
                    ("halo_b_png", "halo_b", "halo"),
                    ("plain_a_1", "plain_a", "plain"),
                    ("plain_a_2", "plain_a", "plain"),
                    ("plain_b_1", "plain_b", "plain")):
                path = os.path.join(root, name)
                os.makedirs(path)
                with open(os.path.join(path, "meta.json"), "w") as f:
                    json.dump({"design_id": design, "family": family}, f)
                items.append((os.path.join(path, "img.png"),
                              os.path.join(path, "back.png"), True))
            train, val, _, _, keys = split_groups(items, 0.5, 0, ["halo_a"])
            self.assertIn("halo_a", keys)
            self.assertTrue(all("halo_a" not in x[0] for x in train))
            self.assertEqual(sum("halo_a" in x[0] for x in val), 2)

    def test_forced_train_family_keeps_reviewed_corrections_out_of_validation(self):
        with tempfile.TemporaryDirectory() as root:
            items = []
            for name, design, family in (
                    ("correction_a_1", "correction_a", "correction"),
                    ("correction_a_2", "correction_a", "correction"),
                    ("correction_b_1", "correction_b", "correction"),
                    ("plain_a_1", "plain_a", "plain"),
                    ("plain_b_1", "plain_b", "plain"),
                    ("plain_c_1", "plain_c", "plain")):
                path = os.path.join(root, name)
                os.makedirs(path)
                with open(os.path.join(path, "meta.json"), "w") as f:
                    json.dump({"design_id": design, "family": family}, f)
                items.append((os.path.join(path, "img.png"),
                              os.path.join(path, "back.png"), True))
            train, val, _, _, _ = split_groups(
                items, 0.5, 0, force_train_families=["correction"])
            self.assertEqual(sum("correction_" in x[0] for x in train), 3)
            self.assertFalse(any("correction_" in x[0] for x in val))

    def test_forced_train_family_cannot_also_be_a_holdout(self):
        with tempfile.TemporaryDirectory() as root:
            items = []
            for name, design in (("correction_a", "correction_a"),
                                 ("correction_b", "correction_b")):
                path = os.path.join(root, name)
                os.makedirs(path)
                with open(os.path.join(path, "meta.json"), "w") as f:
                    json.dump({"design_id": design, "family": "correction"}, f)
                items.append((os.path.join(path, "img.png"),
                              os.path.join(path, "back.png"), True))
            with self.assertRaisesRegex(ValueError, "both holdout and forced train"):
                split_groups(items, 0.5, 0, holdout_designs=["correction_a"],
                             force_train_families=["correction"])

    def test_explicit_holdout_only_does_not_add_random_validation_designs(self):
        with tempfile.TemporaryDirectory() as root:
            items = []
            for name in ("teacher_a", "teacher_b", "corrected_holdout"):
                path = os.path.join(root, name)
                os.makedirs(path)
                with open(os.path.join(path, "meta.json"), "w") as f:
                    json.dump({"design_id": name, "family": "final"}, f)
                items.append((os.path.join(path, "img.png"),
                              os.path.join(path, "back.png"), True))
            train, val, _, _, keys = split_groups(
                items, 0.5, 0, holdout_designs=["corrected_holdout"],
                explicit_holdout_only=True)
            self.assertEqual(keys, {"corrected_holdout"})
            self.assertEqual(len(val), 1)
            self.assertEqual(len(train), 2)

    def test_explicit_holdout_only_requires_a_holdout(self):
        with self.assertRaisesRegex(ValueError, "requires at least one"):
            split_groups([], 0.0, 0, explicit_holdout_only=True)

    def test_matte_only_sample_has_no_back_gradient(self):
        logits = torch.zeros(2, 2, 8, 8, requires_grad=True)
        target = torch.zeros_like(logits)
        weight = torch.tensor([[1.0, 0.0], [1.0, 1.0]])
        loss_fn(logits, target, weight).backward()
        self.assertEqual(float(logits.grad[0, 1].abs().sum()), 0.0)
        self.assertGreater(float(logits.grad[1, 1].abs().sum()), 0.0)

    def test_sparse_pixel_supervision_has_no_gradient_outside_edit(self):
        logits = torch.zeros(1, 2, 8, 8, requires_grad=True)
        target = torch.zeros_like(logits)
        target[:, 1, 3, 4] = 1.0
        pixel_weight = torch.zeros_like(logits)
        pixel_weight[:, 1, 3, 4] = 1.0
        loss_fn(logits, target, pixel_weight=pixel_weight).backward()
        self.assertGreater(float(logits.grad[0, 1, 3, 4].abs()), 0.0)
        outside = logits.grad.clone()
        outside[0, 1, 3, 4] = 0.0
        self.assertEqual(float(outside.abs().sum()), 0.0)

    def test_cached_pairs_returns_optional_sparse_edit_masks(self):
        with tempfile.TemporaryDirectory() as root:
            case = os.path.join(root, "case")
            os.makedirs(case)
            rgba = np.zeros((12, 16, 4), np.uint8)
            rgba[2:10, 3:13, :3] = 180
            rgba[2:10, 3:13, 3] = 255
            back = np.zeros((12, 16), np.uint8)
            back[7:10, 3:13] = 255
            matte_edit = np.zeros_like(back)
            back_edit = np.zeros_like(back)
            matte_edit[2, 4] = 255
            back_edit[8, 8] = 255
            for name, image in (("img.png", rgba), ("back.png", back),
                                ("matte_edit.png", matte_edit),
                                ("back_edit.png", back_edit)):
                cv2.imwrite(os.path.join(case, name), image)
            item = (os.path.join(case, "img.png"),
                    os.path.join(case, "back.png"), True)
            sample = CachedPairs([item], size=16, train=False,
                                 return_pixel_weight=True)[0]
            self.assertEqual(len(sample), 4)
            self.assertGreater(float(sample[3][0].sum()), 0.0)
            self.assertGreater(float(sample[3][1].sum()), 0.0)

    def test_boundary_band_covers_both_sides_of_contour(self):
        target = torch.zeros(1, 1, 11, 11)
        target[:, :, 3:8, 3:8] = 1.0
        band = boundary_band(target, radius=1)[0, 0]
        self.assertEqual(float(band[5, 5]), 0.0)   # easy interior
        self.assertEqual(float(band[3, 5]), 1.0)   # inside edge
        self.assertEqual(float(band[2, 5]), 1.0)   # outside edge
        self.assertEqual(float(band[0, 0]), 0.0)   # easy background

    def test_edge_weight_does_not_change_back_gradient(self):
        target = torch.zeros(1, 2, 12, 12)
        target[:, :, 3:9, 3:9] = 1.0
        plain = torch.zeros_like(target, requires_grad=True)
        edged = torch.zeros_like(target, requires_grad=True)
        loss_fn(plain, target, edge_weight=0).backward()
        loss_fn(edged, target, edge_weight=5).backward()
        torch.testing.assert_close(plain.grad[:, 1], edged.grad[:, 1])

    def test_back_edge_weight_focuses_ownership_boundary(self):
        target = torch.zeros(1, 2, 12, 12)
        target[:, 1, 3:9, 3:9] = 1.0
        plain = torch.zeros_like(target, requires_grad=True)
        edged = torch.zeros_like(target, requires_grad=True)
        loss_fn(plain, target, back_edge_weight=0).backward()
        loss_fn(edged, target, back_edge_weight=5).backward()
        self.assertGreater(float(edged.grad[0, 1, 3, 5].abs()),
                           float(plain.grad[0, 1, 3, 5].abs()))
        self.assertEqual(float(edged.grad[0, 0].abs().sum()),
                         float(plain.grad[0, 0].abs().sum()))

    def test_multi_gem_foreground_keeps_all_significant_objects(self):
        image = np.full((240, 320, 3), 180, np.uint8)
        cv2.circle(image, (85, 120), 35, (20, 40, 230), -1)
        cv2.circle(image, (235, 120), 32, (230, 40, 20), -1)
        mask = foreground_mask_all(image, tol=10)
        self.assertIsNotNone(mask)
        self.assertTrue(mask[120, 85])
        self.assertTrue(mask[120, 235])
        self.assertFalse(mask[5, 5])

    def test_background_veto_preserves_near_white_stone(self):
        image = np.full((64, 64, 3), 255, np.uint8)
        image[0:28, 25:39] = 253  # pale facet touching the white canvas
        alpha = np.zeros((64, 64), np.float32)
        alpha[0:28, 25:39] = 1.0
        kept = veto_background(alpha.copy(), image, tol=2.0, min_component=0)
        erased = veto_background(alpha.copy(), image, tol=6.0, min_component=0)
        self.assertGreater(int((kept > 0.5).sum()), 300)
        self.assertEqual(int((erased > 0.5).sum()), 0)

    def test_enclosed_veto_removes_flat_canvas_shelf(self):
        image = np.full((64, 64, 3), 247, np.uint8)
        image[18:46, 12:52] = (40, 80, 150)  # enclosing metal
        image[23:41, 18:46] = 247            # canvas in the opening
        alpha = np.zeros((64, 64), np.float32)
        alpha[18:46, 12:52] = 1.0
        alpha[27:41, 18:46] = 0.0
        # Four rows of canvas were incorrectly attached to the metal mask.
        cleaned = veto_enclosed_background(alpha, image)
        self.assertEqual(float(cleaned[25, 30]), 0.0)
        self.assertEqual(float(cleaned[19, 30]), 1.0)

    def test_enclosed_veto_keeps_textured_white_stone(self):
        image = np.full((64, 64, 3), 247, np.uint8)
        alpha = np.zeros((64, 64), np.float32)
        alpha[16:48, 16:48] = 1.0
        # Near-white facets have local contrast unlike a flat catalogue canvas.
        for y in range(16, 48):
            for x in range(16, 48):
                image[y, x] = 244 if (x + y) % 2 else 255
        cleaned = veto_enclosed_background(alpha, image)
        self.assertEqual(int((cleaned > 0.5).sum()), 32 * 32)

    def test_layer_split_is_exact_and_expands_back_seam(self):
        alpha = np.ones((9, 9), np.float32)
        back_prob = np.zeros_like(alpha)
        back_prob[4, 4] = 1.0
        full, front, back = split_layers(alpha, back_prob, sharpen=0, expand=1)
        np.testing.assert_allclose(front + back, full)
        self.assertEqual(int((back > 0.5).sum()), 9)
        self.assertEqual(int((front > 0.5).sum()), 72)

    def test_partition_resize_keeps_internal_ownership_hard(self):
        alpha = np.ones((8, 8), np.float32)
        alpha[:, 0] = 0.25
        back = np.zeros_like(alpha)
        # A seam through a 2x2 reduction block would become fractional if the
        # rear alpha were interpolated independently.
        back[3:, :] = alpha[3:, :]
        full, front, rear = resize_layer_partition(alpha, back, (4, 4))
        np.testing.assert_allclose(front + rear, full)
        self.assertFalse(np.any((front > 0) & (rear > 0)))
        self.assertTrue(np.all((front > 0) | (rear > 0)))
        self.assertTrue(np.all(rear[1:] > 0))
        self.assertTrue(np.all(front[:1] > 0))

    def test_front_speck_cleanup_can_use_encoded_png_support(self):
        alpha = np.zeros((12, 12), np.float32)
        alpha[2:8, 2:8] = 1.0
        alpha[9, 9:11] = 1.0
        # Float-space dust connects the dash to the main component, but these
        # values round to zero in an 8-bit PNG and therefore cannot make the
        # encoded dash visually connected.
        alpha[8, 8] = 0.1 / 255.0
        front = alpha.copy()
        back = np.zeros_like(alpha)
        cleaned_front, cleaned_back = reassign_front_specks(
            alpha, front, back, min_pixels=3,
            support_threshold=0.5 / 255.0)
        self.assertTrue(np.all(cleaned_front[2:8, 2:8] > 0))
        self.assertTrue(np.all(cleaned_front[9, 9:11] == 0))
        self.assertTrue(np.all(cleaned_back[9, 9:11] == 1))
        np.testing.assert_allclose(cleaned_front + cleaned_back, alpha)

    def test_inward_antialias_never_expands_silhouette(self):
        alpha = np.zeros((31, 31), np.float32)
        alpha[8:23, 8:23] = 1.0
        smooth = antialias_inward(alpha)
        self.assertEqual(float(smooth[7, 15]), 0.0)
        self.assertGreater(float(smooth[8, 15]), 0.0)
        self.assertLess(float(smooth[8, 15]), 1.0)
        self.assertEqual(float(smooth[15, 15]), 1.0)

    def test_subpixel_antialias_smooths_outside_without_changing_binary_shape(self):
        alpha = np.zeros((31, 31), np.float32)
        alpha[8:23, 8:23] = 1.0
        smooth = antialias_subpixel(alpha)
        self.assertGreater(float(smooth[7, 15]), 0.0)
        self.assertLess(float(smooth[7, 15]), 0.5)
        np.testing.assert_array_equal(smooth > 0.5, alpha > 0.5)

    def test_subpixel_antialias_preserves_one_pixel_diagonal_detail(self):
        alpha = np.zeros((31, 31), np.float32)
        alpha[8:23, 8:23] = 1.0
        alpha[7, 7] = 1.0  # 8-connected micro-prong/stone at the contour
        smooth = antialias_subpixel(alpha)
        self.assertGreater(float(smooth[7, 7]), 0.5)
        np.testing.assert_array_equal(smooth > 0.5, alpha > 0.5)

    def test_edge_colour_is_extended_into_subpixel_fringe(self):
        image = np.full((21, 21, 3), 255, np.uint8)
        image[6:15, 6:15] = (30, 70, 120)
        alpha = np.zeros((21, 21), np.float32)
        alpha[6:15, 6:15] = 1.0
        alpha[5, 6:15] = 0.2
        recovered = decontaminate(image, alpha)
        self.assertLess(int(recovered[5, 10].mean()), 150)

    def test_partial_alpha_specks_are_removed_before_encoding(self):
        alpha = np.zeros((30, 30), np.float32)
        alpha[5:25, 5:25] = 1.0
        alpha[1:3, 27:29] = 0.2
        cleaned = remove_alpha_specks(alpha, min_pixels=10)
        self.assertEqual(float(cleaned[1, 27]), 0.0)
        self.assertEqual(float(cleaned[10, 10]), 1.0)

    def test_single_object_cleanup_keeps_only_largest_component(self):
        alpha = np.zeros((30, 30), np.float32)
        alpha[5:25, 5:25] = 1.0
        alpha[1:5, 26:30] = 1.0
        cleaned = remove_alpha_specks(alpha, keep_largest=True)
        self.assertEqual(float(cleaned[2, 27]), 0.0)
        self.assertEqual(float(cleaned[10, 10]), 1.0)

    def test_component_area_threshold_scales_for_native_1000px_render(self):
        self.assertEqual(scale_component_area(16, (499, 499)), 16)
        self.assertEqual(scale_component_area(16, (1000, 1000)), 64)
        self.assertEqual(scale_component_area(16, (250, 250)), 16)

    def test_gem_cleanup_removes_one_pixel_canvas_shell(self):
        alpha = np.zeros((40, 40), np.float32)
        alpha[10:30, 10:30] = 1.0
        cleaned = clean_gem_silhouette(alpha)
        self.assertEqual(int(cleaned.sum()), 18 * 18)
        self.assertEqual(float(cleaned[10, 20]), 0.0)
        self.assertEqual(float(cleaned[11, 20]), 1.0)

    def test_gem_cleanup_removes_widening_reflection_tail(self):
        alpha = np.zeros((100, 100), np.float32)
        for y in range(15, 86):
            half_width = max(2, 38 - abs(50 - y) // 2)
            alpha[y, 50 - half_width:51 + half_width] = 1.0
        # Connected gray display reflection below a four-pixel neck.
        for y in range(86, 100):
            half_width = 4 + (y - 86)
            alpha[y, 50 - half_width:51 + half_width] = 1.0
        cleaned = clean_gem_silhouette(alpha, erode=0)
        self.assertTrue(cleaned[84].any())
        self.assertFalse(cleaned[87:].any())

    def test_gem_matte_smoothing_removes_single_pixel_stair_steps(self):
        alpha = np.zeros((48, 48), np.float32)
        alpha[12:36, 12:36] = 1.0
        alpha[16, 11] = 1.0
        alpha[23, 11] = 1.0
        alpha[30, 11] = 1.0
        smoothed = smooth_gem_matte(alpha, epsilon=1.2, supersample=8)
        self.assertTrue(np.all(smoothed[16:32, 16:32] > 0.99))
        self.assertFalse(smoothed[16, 11] > 0.5)
        self.assertFalse(smoothed[23, 11] > 0.5)
        self.assertFalse(smoothed[30, 11] > 0.5)
        self.assertTrue(np.any((smoothed > 0.0) & (smoothed < 1.0)))

    def test_gem_matte_smoothing_preserves_pointed_cut_tips(self):
        alpha = np.zeros((49, 49), np.float32)
        tips = np.array([[24, 3], [45, 24], [24, 45], [3, 24]],
                        np.int32)
        cv2.fillPoly(alpha, [tips], 1.0)

        smoothed = smooth_gem_matte(alpha, epsilon=1.2, supersample=8)

        for x, y in tips:
            self.assertGreater(smoothed[y, x], 0.5)

    def test_subpixel_back_fringe_does_not_leak_into_front(self):
        hard = np.zeros((31, 31), np.float32)
        hard[8:23, 8:23] = 1.0
        alpha = antialias_subpixel(hard)
        back_prob = np.zeros_like(alpha)
        back_prob[16:23, 8:23] = 1.0
        _, front, back = split_layers(
            alpha, back_prob, sharpen=0, expand=0)
        self.assertGreater(float(back[23, 15]), 0.0)
        self.assertEqual(float(front[23, 15]), 0.0)

    def test_rgba_rounds_numerically_opaque_alpha(self):
        rgba = to_rgba(np.zeros((1, 1, 3), np.uint8),
                       np.array([[0.99999994]], np.float32))
        self.assertEqual(int(rgba[0, 0, 3]), 255)

    def test_edge_trim_is_narrow_and_colour_aware(self):
        image = np.full((31, 31, 3), 255, np.uint8)
        image[8:23, 8:23] = 80
        image[8, 8:23] = 254              # canvas-like sliver at the edge
        alpha = np.zeros((31, 31), np.float32)
        alpha[8:23, 8:23] = 1.0
        trimmed = trim_background_edge(alpha, image, radius=1.5, tol=12)
        self.assertLess(float(trimmed[8, 15]), 0.5)
        self.assertEqual(float(trimmed[9, 15]), 1.0)  # only one-pixel edge
        self.assertEqual(float(trimmed[15, 8]), 1.0)  # dark material is kept

    def test_plain_background_contour_recovers_only_nearby_source_object(self):
        image = np.full((100, 100, 3), 255, np.uint8)
        image[30:70, 30:70] = 80
        alpha = np.zeros((100, 100), np.float32)
        alpha[34:66, 34:66] = 1.0
        refined = refine_plain_background_contour(alpha, image, radius=5)
        self.assertGreater(int((refined > 0.5).sum()), int(alpha.sum()))
        self.assertEqual(float(refined[30, 50]), 1.0)
        self.assertEqual(float(refined[20, 50]), 0.0)
        self.assertTrue(np.all(refined[alpha > 0.5] > 0.5))

    def test_plain_background_contour_skips_nonuniform_canvas(self):
        image = np.full((60, 60, 3), 255, np.uint8)
        image[:, :5] = np.arange(60, dtype=np.uint8)[:, None, None] * 3
        alpha = np.zeros((60, 60), np.float32)
        alpha[20:40, 20:40] = 1.0
        refined = refine_plain_background_contour(alpha, image, radius=5)
        np.testing.assert_array_equal(refined, alpha)

    def test_upper_ring_opening_repair_fills_only_a_bounded_notch(self):
        alpha = np.zeros((499, 499), np.float32)
        alpha[180:340, 40:459] = 1.0
        alpha[230:315, 80:419] = 0.0       # enclosed finger opening
        alpha[218:230, 130:160] = 0.0      # narrow model bite
        alpha[205:230, 280:360] = 0.0      # intentional wide opening
        repaired = repair_upper_ring_opening(
            alpha, window=41, max_depth=15)
        self.assertEqual(float(repaired[224, 145]), 1.0)
        self.assertEqual(float(repaired[215, 320]), 0.0)
        self.assertEqual(float(repaired[179, 145]), 0.0)
        self.assertTrue(np.all(repaired[alpha > 0.5] > 0.5))

    def test_post_repair_veto_removes_flat_canvas_filled_by_geometry(self):
        image = np.full((499, 499, 3), 247, np.uint8)
        alpha = np.zeros((499, 499), np.float32)
        alpha[180:340, 40:459] = 1.0
        alpha[230:315, 80:419] = 0.0
        alpha[218:230, 130:160] = 0.0
        # The surrounding ring is textured material, but this notch is true
        # catalogue canvas. Geometry closes it; source evidence must veto it.
        image[180:340, 40:459] = 80
        image[218:315, 80:419] = 247
        repaired = repair_upper_ring_opening(alpha, window=41, max_depth=15)
        self.assertEqual(float(repaired[224, 145]), 1.0)
        cleaned = veto_enclosed_background(repaired, image)
        self.assertEqual(float(cleaned[224, 145]), 0.0)
        self.assertEqual(float(cleaned[200, 145]), 1.0)

    def test_source_edge_recovery_keeps_only_attached_shoulder_evidence(self):
        image = np.full((499, 499, 3), 255, np.uint8)
        alpha = np.zeros((499, 499), np.float32)
        alpha[220:260, 50:450] = 1.0
        alpha[300:340, 50:450] = 1.0
        alpha[220:340, 50:100] = 1.0
        alpha[220:340, 400:450] = 1.0
        # A diagonal dark rail starts attached to the right shoulder and then
        # runs through otherwise white source pixels outside the coarse mask.
        for offset in range(10):
            image[219 - offset, 330 + offset] = 120
        image[214:217, 130:133] = 80       # nearby but detached source dust
        repaired = recover_plain_background_edges(
            alpha, image, radius=12, colour_tol=8)
        self.assertEqual(float(repaired[212, 337]), 1.0)
        self.assertEqual(float(repaired[215, 131]), 0.0)
        self.assertEqual(float(repaired[180, 250]), 0.0)
        self.assertTrue(np.all(repaired[alpha > 0.5] > 0.5))

    def test_source_edge_recovery_reaches_high_head_side_rail(self):
        image = np.full((499, 499, 3), 255, np.uint8)
        alpha = np.zeros((499, 499), np.float32)
        alpha[220:260, 50:450] = 1.0
        alpha[300:340, 50:450] = 1.0
        alpha[220:340, 50:100] = 1.0
        alpha[220:340, 400:450] = 1.0
        # A high diagonal rail begins at the shoulder and runs above the old
        # 12%-of-width search band.
        for offset in range(24):
            image[218 - offset, 376 + offset] = 110
        repaired = recover_plain_background_edges(
            alpha, image, radius=12, colour_tol=8)
        self.assertEqual(float(repaired[208, 386]), 1.0)

    def test_late_source_aware_hole_fill_removes_dark_metal_slit(self):
        image = np.full((80, 100, 3), 255, np.uint8)
        image[20:60, 10:90] = 170
        alpha = np.zeros((80, 100), np.float32)
        alpha[20:60, 10:90] = 1.0
        alpha[35, 22:44] = 0.0
        repaired = fill_metal_holes(alpha, image)
        self.assertTrue(np.all(repaired[35, 22:44] > 0.5))

    def test_shoulder_slit_repair_keeps_opening_and_fills_side_slit(self):
        alpha = np.zeros((499, 499), np.float32)
        alpha[180:340, 40:459] = 1.0
        alpha[230:315, 80:419] = 0.0
        alpha[205:207, 345:365] = 0.0
        repaired = repair_shoulder_slits(alpha)
        self.assertEqual(float(repaired[206, 355]), 1.0)
        self.assertEqual(float(repaired[260, 250]), 0.0)

    def test_back_band_regularization_closes_only_bounded_central_notch(self):
        alpha = np.zeros((499, 499), np.float32)
        alpha[340:401, 50:450] = 1.0
        back = alpha.copy()
        back[340:351, 220:280] = 0.0
        front = alpha - back
        front, back = regularize_back_band(
            alpha, front, back, window=81, max_depth=15)
        self.assertEqual(float(front[345, 250]), 0.0)
        self.assertEqual(float(back[345, 250]), 1.0)
        np.testing.assert_allclose(front + back, alpha)

    def test_back_band_regularization_preserves_supported_front_head_tip(self):
        alpha = np.zeros((499, 499), np.float32)
        alpha[340:401, 50:450] = 1.0
        alpha[260:351, 220:280] = 1.0
        back = np.zeros_like(alpha)
        back[340:401, 50:450] = 1.0
        back[340:351, 220:280] = 0.0
        front = alpha - back
        front, back = regularize_back_band(
            alpha, front, back, window=81, max_depth=15)
        self.assertEqual(float(front[345, 250]), 1.0)
        self.assertEqual(float(back[345, 250]), 0.0)
        np.testing.assert_allclose(front + back, alpha)

    def test_thin_back_bridge_rounds_under_front_occluder(self):
        alpha = np.zeros((499, 499), np.float32)
        back = np.zeros_like(alpha)
        back[340:380, 50:235] = 1.0
        back[340:380, 265:450] = 1.0
        back[374:380, 235:265] = 1.0
        alpha[250:380, 50:450] = 1.0
        front = alpha - back
        front, back = separate_thin_back_bridge(
            alpha, front, back, max_thickness=6)
        self.assertEqual(float(back[350, 236]), 1.0)
        self.assertEqual(float(front[350, 250]), 1.0)
        self.assertEqual(float(back[376, 250]), 1.0)
        self.assertEqual(float(back[360, 100]), 1.0)
        count, _ = cv2.connectedComponents((back > 0.5).astype(np.uint8), 8)
        self.assertEqual(count - 1, 1)
        np.testing.assert_allclose(front + back, alpha)

    def test_thin_back_bridge_uses_source_texture_to_avoid_band_tab(self):
        alpha = np.zeros((499, 499), np.float32)
        back = np.zeros_like(alpha)
        back[340:380, 50:235] = 1.0
        back[340:380, 265:450] = 1.0
        back[374:380, 235:265] = 1.0
        alpha[250:380, 50:450] = 1.0
        front = alpha - back
        image = np.full((499, 499, 3), 205, np.uint8)
        for y in range(250, 366):
            image[y, 220:280] = 80 if y % 2 else 235
        front, back = separate_thin_back_bridge(
            alpha, front, back, max_thickness=6, bgr=image,
            texture_threshold=12)
        self.assertEqual(float(front[367, 250]), 1.0)
        self.assertEqual(float(back[368, 250]), 1.0)
        self.assertEqual(float(front[370, 250]), 0.0)
        count, _ = cv2.connectedComponents((back > 0.5).astype(np.uint8), 8)
        self.assertEqual(count - 1, 1)
        np.testing.assert_allclose(front + back, alpha)

    def test_abrupt_front_tab_is_replaced_by_continuous_taper(self):
        alpha = np.zeros((260, 220), np.float32)
        alpha[80:220, 20:200] = 1.0
        front = np.zeros_like(alpha)
        front[80:161, 60:140] = 1.0
        front[161:179, 90:111] = 1.0
        back = alpha - front
        front, back = repair_abrupt_front_tip(
            alpha, front, back, max_tip_fraction=0.12)
        widths = [int((front[row] > 0.5).sum()) for row in range(160, 179)]
        self.assertGreater(widths[1], 21)
        self.assertTrue(all(left >= right for left, right in
                            zip(widths, widths[1:])))
        self.assertLessEqual(widths[-1], 3)
        count, _ = cv2.connectedComponents((back > 0.5).astype(np.uint8), 8)
        self.assertEqual(count - 1, 1)
        np.testing.assert_allclose(front + back, alpha)

    def test_abrupt_front_tip_ignores_full_width_double_shank(self):
        alpha = np.zeros((260, 220), np.float32)
        alpha[80:220, 10:210] = 1.0
        front = np.zeros_like(alpha)
        front[80:161, 12:208] = 1.0
        front[161:190, 90:111] = 1.0
        back = alpha - front
        expected_front = front.copy()
        expected_back = back.copy()
        front, back = repair_abrupt_front_tip(
            alpha, front, back, max_tip_fraction=0.12)
        np.testing.assert_array_equal(front, expected_front)
        np.testing.assert_array_equal(back, expected_back)

    def test_back_cleanup_retains_perspective_occluded_band_halves(self):
        alpha = np.zeros((180, 330), np.float32)
        # Same rear sweep and vertical centre, but the perspective/setting
        # hides substantially more of the left half at its lower edge.
        alpha[55:135, 10:140] = 1.0
        alpha[35:155, 190:320] = 1.0
        back = alpha.copy()
        front = np.zeros_like(alpha)
        front, back = reassign_back_specks(alpha, front, back)
        self.assertEqual(float(back[90, 40]), 1.0)
        self.assertEqual(float(back[90, 250]), 1.0)
        np.testing.assert_allclose(front + back, alpha)

    def test_back_cleanup_removes_detached_translucent_fringe(self):
        alpha = np.zeros((40, 60), np.float32)
        alpha[20:32, 8:52] = 1.0
        alpha[17, 24:36] = 0.25
        back = alpha.copy()
        front = np.zeros_like(alpha)
        front, back = reassign_back_specks(alpha, front, back)
        self.assertEqual(float(back[17, 30]), 0.0)
        self.assertEqual(float(front[17, 30]), 0.25)
        count, _ = cv2.connectedComponents((back > 0).astype(np.uint8), 8)
        self.assertEqual(count - 1, 1)
        np.testing.assert_allclose(front + back, alpha)

    def test_back_cleanup_retains_two_aligned_occluded_band_halves(self):
        alpha = np.zeros((120, 180), np.float32)
        alpha[70:100, 10:75] = 1.0
        alpha[71:100, 105:170] = 1.0
        alpha[35:45, 140:150] = 1.0      # detached head/support prediction
        back = alpha.copy()
        front = np.zeros_like(alpha)
        front, back = reassign_back_specks(alpha, front, back)
        self.assertEqual(float(back[80, 30]), 1.0)
        self.assertEqual(float(back[80, 130]), 1.0)
        self.assertEqual(float(back[40, 145]), 0.0)
        self.assertEqual(float(front[40, 145]), 1.0)
        np.testing.assert_allclose(front + back, alpha)

    def test_back_cleanup_preserves_repeated_lower_halo_details(self):
        alpha = np.zeros((110, 160), np.float32)
        alpha[70:90, 5:55] = 1.0
        alpha[70:90, 105:155] = 1.0
        for left in (60, 72, 84, 96):
            alpha[84:90, left:left + 6] = 1.0
        alpha[30:36, 74:80] = 1.0  # equally sized random upper fragment
        back = alpha.copy()
        front = np.zeros_like(alpha)
        front, back = reassign_back_specks(
            alpha, front, back, min_pixels=16,
            preserve_aligned_details=True)
        self.assertEqual(float(back[80, 20]), 1.0)
        self.assertEqual(float(back[80, 130]), 1.0)
        for left in (60, 72, 84, 96):
            self.assertEqual(float(back[86, left + 2]), 1.0)
        self.assertEqual(float(back[32, 76]), 0.0)
        self.assertEqual(float(front[32, 76]), 1.0)
        np.testing.assert_allclose(front + back, alpha)

    def test_back_cleanup_retains_tall_perspective_band_mate(self):
        alpha = np.zeros((120, 180), np.float32)
        # Regression for a catalogue render whose two rear-band halves are
        # split by the setting.  The perspective mate is 56x38 (aspect 1.47),
        # just below the old 1.5 cutoff, while both halves share the same
        # vertical sweep and are large enough to be semantic components.
        alpha[63:100, 112:168] = 1.0
        alpha[62:100, 12:68] = 1.0
        alpha[45:50, 84:90] = 1.0  # detached setting support
        back = alpha.copy()
        front = np.zeros_like(alpha)
        front, back = reassign_back_specks(
            alpha, front, back, min_pixels=300)
        self.assertEqual(float(back[80, 30]), 1.0)
        self.assertEqual(float(back[80, 140]), 1.0)
        self.assertEqual(float(back[47, 86]), 0.0)
        self.assertEqual(float(front[47, 86]), 1.0)
        np.testing.assert_allclose(front + back, alpha)

    def test_front_specks_move_to_back_without_breaking_partition(self):
        alpha = np.zeros((20, 20), np.float32)
        alpha[2:12, 2:12] = 1.0
        alpha[18, 18] = 1.0
        front, back = alpha.copy(), np.zeros_like(alpha)
        front, back = reassign_front_specks(alpha, front, back, min_pixels=4)
        self.assertEqual(float(front[18, 18]), 0.0)
        self.assertEqual(float(back[18, 18]), 1.0)
        np.testing.assert_allclose(front + back, alpha)

    def test_only_largest_back_component_is_retained(self):
        alpha = np.zeros((24, 24), np.float32)
        alpha[3:13, 3:13] = 1.0
        alpha[16:21, 2:7] = 1.0
        alpha[20:22, 20:22] = 0.75
        back = alpha.copy()
        front = np.zeros_like(alpha)
        front, back = reassign_back_specks(
            alpha, front, back, min_pixels=20)
        self.assertEqual(float(back[20, 20]), 0.0)
        self.assertEqual(float(front[20, 20]), 0.75)
        self.assertEqual(float(back[5, 5]), 1.0)
        self.assertEqual(float(back[18, 4]), 0.0)
        self.assertEqual(float(front[18, 4]), 1.0)
        np.testing.assert_allclose(front + back, alpha)

    def test_default_back_cleanup_moves_detached_head_detail_to_front(self):
        alpha = np.zeros((50, 50), np.float32)
        alpha[5:35, 5:35] = 1.0
        alpha[38:48, 38:48] = 1.0
        back = alpha.copy()
        front = np.zeros_like(alpha)
        front, back = reassign_back_specks(alpha, front, back)
        self.assertEqual(float(back[42, 42]), 0.0)
        self.assertEqual(float(front[42, 42]), 1.0)
        self.assertEqual(float(back[10, 10]), 1.0)
        np.testing.assert_allclose(front + back, alpha)

    def test_back_cleanup_moves_detached_mirrored_support_to_front(self):
        alpha = np.zeros((60, 80), np.float32)
        alpha[40:52, 8:72] = 1.0       # retained rear band
        alpha[20:26, 14:20] = 1.0      # 36px left support, retained
        alpha[20:26, 61:65] = 1.0      # 24px perspective mate, below cutoff
        alpha[15:17, 65:67] = 1.0      # mirrored-looking dust, too small
        front = np.zeros_like(alpha)
        back = alpha.copy()
        front, back = reassign_back_specks(
            alpha, front, back, min_pixels=30)
        self.assertEqual(float(back[22, 62]), 0.0)
        self.assertEqual(float(front[22, 62]), 1.0)
        self.assertEqual(float(back[22, 16]), 0.0)
        self.assertEqual(float(front[22, 16]), 1.0)
        self.assertEqual(float(back[15, 65]), 0.0)
        self.assertEqual(float(front[15, 65]), 1.0)
        np.testing.assert_allclose(front + back, alpha)

    def test_back_cleanup_moves_two_subthreshold_supports_to_front(self):
        alpha = np.zeros((60, 80), np.float32)
        alpha[40:52, 8:72] = 1.0       # retained rear band, symmetry axis 39.5
        alpha[20:24, 14:22] = 1.0      # 32px left support, below cutoff
        alpha[20:24, 58:66] = 1.0      # 32px exact mirrored mate
        alpha[13:15, 12:14] = 1.0      # two exact mirrored dust specks
        alpha[13:15, 66:68] = 1.0
        front = np.zeros_like(alpha)
        back = alpha.copy()
        front, back = reassign_back_specks(
            alpha, front, back, min_pixels=40)
        self.assertEqual(float(back[21, 16]), 0.0)
        self.assertEqual(float(back[21, 63]), 0.0)
        self.assertEqual(float(front[21, 16]), 1.0)
        self.assertEqual(float(front[21, 63]), 1.0)
        self.assertEqual(float(back[13, 12]), 0.0)
        self.assertEqual(float(back[13, 66]), 0.0)
        np.testing.assert_allclose(front + back, alpha)


if __name__ == "__main__":
    unittest.main()
