import asyncio
from io import BytesIO
import os
import unittest

import cv2
import numpy as np
from fastapi import HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware


os.environ["RING_PROVIDER"] = "CPUExecutionProvider"

from deploy.serve import (_alpha_png, _crop_headers, _gem_dimensions,
                          _layout_gemstone, _ownership_png, _png,
                          _read_image, _tight_crop, app, segment_gem,
                          segment_gemstone)  # noqa: E402


class ServeImageTests(unittest.TestCase):
    def test_cors_allows_all_origins_methods_and_headers(self):
        middleware = next(
            item for item in app.user_middleware
            if item.cls is CORSMiddleware)

        self.assertEqual(middleware.kwargs["allow_origins"], ["*"])
        self.assertEqual(middleware.kwargs["allow_methods"], ["*"])
        self.assertEqual(middleware.kwargs["allow_headers"], ["*"])
        self.assertFalse(middleware.kwargs["allow_credentials"])
        self.assertIn("X-Crop-Width", middleware.kwargs["expose_headers"])
        self.assertIn("X-Gem-Width-Mm", middleware.kwargs["expose_headers"])
        self.assertIn("X-Output-Height", middleware.kwargs["expose_headers"])

    def test_gem_dimensions_default_and_require_a_pair(self):
        self.assertEqual(_gem_dimensions(None, None), (10.0, 10.0))
        with self.assertRaisesRegex(HTTPException, "sent together"):
            _gem_dimensions(6.5, None)

    def test_gem_layout_matches_physical_canvas_scale(self):
        bgr = np.full((40, 20, 3), 180, np.uint8)
        alpha = np.ones((40, 20), np.float32)

        output_bgr, output_alpha, metadata = _layout_gemstone(
            bgr, alpha, width_mm=8.0, height_mm=4.0)

        # Pixel content was portrait but physical dimensions say landscape,
        # so the script-compatible orientation check rotates it clockwise.
        self.assertTrue(metadata["rotated"])
        self.assertEqual(output_bgr.shape, (100, 500, 3))
        self.assertEqual(output_alpha.shape, (100, 500))
        ys, xs = np.nonzero(output_alpha > 0.5)
        self.assertEqual((xs.min(), xs.max() + 1), (150, 350))
        self.assertEqual((ys.min(), ys.max() + 1), (0, 100))

    def test_square_default_does_not_rotate_for_minor_aspect_difference(self):
        bgr = np.full((22, 20, 3), 180, np.uint8)
        alpha = np.ones((22, 20), np.float32)

        _, output_alpha, metadata = _layout_gemstone(
            bgr, alpha, width_mm=10.0, height_mm=10.0)

        self.assertFalse(metadata["rotated"])
        self.assertEqual(output_alpha.shape, (275, 500))

    def test_gem_endpoint_accepts_physical_dimensions(self):
        source = np.zeros((10, 20, 4), np.uint8)
        source[..., :3] = (40, 100, 210)
        source[2:8, 2:18, 3] = 255
        ok, encoded = cv2.imencode(".png", source)
        self.assertTrue(ok)

        upload = UploadFile(
            file=BytesIO(encoded.tobytes()), filename="gem.png")
        response = asyncio.run(segment_gemstone(
            upload, width=4.0, height=2.0))

        self.assertEqual(response.status_code, 200)
        output = cv2.imdecode(np.frombuffer(response.body, np.uint8),
                              cv2.IMREAD_UNCHANGED)
        self.assertEqual(output.shape, (38, 500, 4))
        self.assertEqual(response.headers["x-gem-width-mm"], "4")
        self.assertEqual(response.headers["x-gem-height-mm"], "2")
        self.assertEqual(response.headers["x-gem-rotated"], "false")
        self.assertEqual(response.headers["x-gem-canvas-px"], "500")
        self.assertEqual(response.headers["x-gem-canvas-mm"], "20")
        self.assertEqual(response.headers["x-output-width"], "500")
        self.assertEqual(response.headers["x-output-height"], "38")

    def test_gem_endpoint_uses_default_only_when_both_dimensions_omitted(self):
        source = np.zeros((10, 20, 4), np.uint8)
        source[..., :3] = (40, 100, 210)
        source[2:8, 2:18, 3] = 255
        ok, encoded = cv2.imencode(".png", source)
        self.assertTrue(ok)
        default_upload = UploadFile(
            file=BytesIO(encoded.tobytes()), filename="gem.png")
        defaulted = asyncio.run(segment_gemstone(
            default_upload, width=None, height=None))
        incomplete_upload = UploadFile(
            file=BytesIO(encoded.tobytes()), filename="gem.png")
        with self.assertRaisesRegex(HTTPException, "sent together") as caught:
            asyncio.run(segment_gemstone(
                incomplete_upload, width=4.0, height=None))

        self.assertEqual(defaulted.status_code, 200)
        default_output = cv2.imdecode(
            np.frombuffer(defaulted.body, np.uint8), cv2.IMREAD_UNCHANGED)
        self.assertEqual(default_output.shape, (94, 500, 4))
        self.assertEqual(defaulted.headers["x-gem-width-mm"], "10")
        self.assertEqual(defaulted.headers["x-gem-height-mm"], "10")
        self.assertEqual(caught.exception.status_code, 422)

    def test_tight_crop_uses_one_full_mask_box_for_all_layers(self):
        bgr = np.arange(10 * 12 * 3, dtype=np.uint8).reshape(10, 12, 3)
        full = np.zeros((10, 12), np.float32)
        full[2:8, 3:10] = 1.0
        full[0, 0] = 0.001  # rounds to zero in the encoded PNG
        front = full.copy()
        front[5:8] = 0.0
        back = full - front

        cropped_bgr, cropped, bounds = _tight_crop(
            bgr, (full, front, back))

        self.assertEqual(bounds, {"x": 3, "y": 2, "width": 7,
                                  "height": 6})
        self.assertEqual(cropped_bgr.shape, (6, 7, 3))
        self.assertTrue(all(mask.shape == (6, 7) for mask in cropped))
        np.testing.assert_array_equal(cropped_bgr, bgr[2:8, 3:10])
        np.testing.assert_array_equal(cropped[0], full[2:8, 3:10])
        np.testing.assert_allclose(cropped[1] + cropped[2], cropped[0])
        support = np.rint(cropped[0] * 255) > 0
        self.assertTrue(support[0].any() and support[-1].any())
        self.assertTrue(support[:, 0].any() and support[:, -1].any())

        headers = _crop_headers(bgr.shape, bounds)
        self.assertEqual(headers["X-Source-Width"], "12")
        self.assertEqual(headers["X-Source-Height"], "10")
        self.assertEqual(headers["X-Crop-X"], "3")
        self.assertEqual(headers["X-Crop-Y"], "2")

    def test_empty_matte_keeps_source_canvas(self):
        bgr = np.zeros((6, 9, 3), np.uint8)
        alpha = np.zeros((6, 9), np.float32)

        cropped_bgr, (cropped_alpha,), bounds = _tight_crop(bgr, (alpha,))

        self.assertEqual(cropped_bgr.shape, bgr.shape)
        self.assertEqual(cropped_alpha.shape, alpha.shape)
        self.assertEqual(bounds, {"x": 0, "y": 0, "width": 9,
                                  "height": 6})

    def test_decode_preserves_embedded_alpha(self):
        source = np.zeros((8, 10, 4), np.uint8)
        source[..., :3] = (17, 83, 191)
        source[..., 3] = 255
        source[2:6, 3:8, 3] = 96
        ok, encoded = cv2.imencode(".png", source)
        self.assertTrue(ok)

        bgr, alpha = _read_image(encoded.tobytes())

        np.testing.assert_array_equal(bgr, source[..., :3])
        np.testing.assert_allclose(alpha, source[..., 3] / 255.0,
                                   rtol=0, atol=1e-7)

    def test_transparent_gem_uses_source_alpha_without_rematting(self):
        bgr = np.full((9, 11, 3), (30, 90, 170), np.uint8)
        source_alpha = np.zeros((9, 11), np.float32)
        source_alpha[2:8, 3:9] = 1.0
        source_alpha[2, 4:8] = 0.4

        full, front, back, foreground = segment_gem(
            bgr, source_alpha=source_alpha)

        np.testing.assert_array_equal(full, source_alpha)
        np.testing.assert_array_equal(front, source_alpha)
        np.testing.assert_array_equal(back, np.zeros_like(source_alpha))
        np.testing.assert_array_equal(foreground, bgr)

        encoded = _png(foreground, full)
        decoded = cv2.imdecode(np.frombuffer(encoded, np.uint8),
                               cv2.IMREAD_UNCHANGED)
        np.testing.assert_array_equal(decoded[..., :3], bgr)
        np.testing.assert_array_equal(
            decoded[..., 3], np.rint(source_alpha * 255).astype(np.uint8))

    def test_webp_decode_preserves_embedded_alpha(self):
        source = np.zeros((7, 9, 4), np.uint8)
        source[..., :3] = (20, 80, 160)
        source[..., 3] = np.arange(9, dtype=np.uint8)[None, :] * 30
        ok, encoded = cv2.imencode(
            ".webp", source, [cv2.IMWRITE_WEBP_QUALITY, 100])
        self.assertTrue(ok)

        _, alpha = _read_image(encoded.tobytes())

        np.testing.assert_allclose(alpha, source[..., 3] / 255.0,
                                   rtol=0, atol=1e-7)

    def test_alpha_png_stores_matte_in_alpha_channel(self):
        matte = np.zeros((8, 10), np.float32)
        matte[2:7, 3:9] = 1.0
        matte[2, 4:8] = 0.4

        encoded = _alpha_png(matte)
        decoded = cv2.imdecode(np.frombuffer(encoded, np.uint8),
                               cv2.IMREAD_UNCHANGED)

        self.assertEqual(decoded.shape, (8, 10, 4))
        np.testing.assert_array_equal(decoded[..., :3], 0)
        np.testing.assert_array_equal(
            decoded[..., 3], np.rint(matte * 255).astype(np.uint8))

    def test_ownership_png_does_not_apply_full_edge_alpha_twice(self):
        full = np.array([[0.0, 0.2, 0.6, 1.0]], np.float32)
        layer = np.array([[0.0, 0.2, 0.0, 0.4]], np.float32)

        encoded = _ownership_png(full, layer)
        decoded = cv2.imdecode(np.frombuffer(encoded, np.uint8),
                               cv2.IMREAD_UNCHANGED)
        full_u8 = np.rint(full * 255.0).astype(np.uint8)
        reconstructed = np.rint(
            full_u8.astype(np.float32) *
            decoded[..., 3].astype(np.float32) / 255.0).astype(np.uint8)

        np.testing.assert_array_equal(
            reconstructed, np.rint(layer * 255.0).astype(np.uint8))


if __name__ == "__main__":
    unittest.main()
