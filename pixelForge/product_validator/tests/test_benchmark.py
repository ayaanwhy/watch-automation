import numpy as np
import pytest

from product_validator.benchmark import _decision_report
from product_validator.policy import Thresholds
from product_validator.taxonomy import ROTATION_CLASSES


def report(expected, predicted):
    rotation = np.full((1, 4), 0.001)
    rotation[0, ROTATION_CLASSES.index(predicted)] = 0.997
    return _decision_report(
        [{"id": "ring", "labels": {
            "asset": "ring", "view": "front", "rotation": expected,
            "suitable": True, "quality": []}}],
        np.array([[0.998, 0.001, 0.001]]),
        np.array([[0.997, 0.001, 0.001, 0.001]]),
        rotation, np.array([0.999]), np.zeros((1, 5)), Thresholds())


@pytest.mark.parametrize("expected", ROTATION_CLASSES)
@pytest.mark.parametrize("predicted", ROTATION_CLASSES)
def test_rotation_decision_checks_operation(expected, predicted):
    result = report(expected, predicted)
    wrong = expected != predicted
    assert result["unsafe_accept_count"] == int(wrong)
    assert result["incorrect_correction_count"] == int(wrong and predicted != "none")
    if wrong and predicted != "none":
        assert result["incorrect_corrections"] == [
            {"id": "ring", "expected": expected, "predicted": predicted}]
    if not wrong:
        assert result["false_rejection_count"] == 0
