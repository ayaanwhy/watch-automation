import unittest

from benchmark.build_ownership_correction_review import HTML


class OwnershipCorrectionReviewTests(unittest.TestCase):
    def test_lasso_remove_is_available_on_every_editable_layer(self):
        self.assertIn('id="lasso"', HTML)
        self.assertIn("function applyLasso()", HTML)
        self.assertIn("$('lasso').onclick=()=>setMode('lasso')", HTML)
        for layer in ("full", "front", "back"):
            self.assertIn(f'id="{layer}Lasso" class="lasso-overlay"', HTML)

    def test_lasso_operation_uses_existing_undoable_stroke_payload(self):
        self.assertIn("stroke=new Map()", HTML)
        self.assertIn("current.support[i]=0;current.back[i]=0", HTML)
        self.assertIn("endStroke()", HTML)

    def test_case_edits_can_be_copied_and_pasted_as_one_undo_step(self):
        self.assertIn('id="copyMask"', HTML)
        self.assertIn('id="pasteMask"', HTML)
        self.assertIn("function copyEdits()", HTML)
        self.assertIn("function pasteEdits()", HTML)
        self.assertIn("editClipboard.edits", HTML)
        self.assertIn("undoStack.push(changes)", HTML)


if __name__ == "__main__":
    unittest.main()
