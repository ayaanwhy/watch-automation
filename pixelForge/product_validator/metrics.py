"""Dependency-free classification and calibration metrics."""

from __future__ import annotations

import numpy as np


def confusion_matrix(target, predicted, class_count):
    matrix = np.zeros((class_count, class_count), dtype=np.int64)
    for truth, guess in zip(target, predicted):
        if truth >= 0:
            matrix[int(truth), int(guess)] += 1
    return matrix


def classification_report(target, probabilities, classes):
    target = np.asarray(target, dtype=np.int64)
    probabilities = np.asarray(probabilities, dtype=np.float64)
    known = target >= 0
    if not np.any(known):
        return {"known": 0, "confusion": [], "macro_f1": None,
                "accuracy": None, "classes": {}}
    target = target[known]
    probabilities = probabilities[known]
    predicted = probabilities.argmax(axis=1)
    matrix = confusion_matrix(target, predicted, len(classes))
    rows = {}
    f1_values = []
    for index, name in enumerate(classes):
        tp = int(matrix[index, index])
        fp = int(matrix[:, index].sum() - tp)
        fn = int(matrix[index, :].sum() - tp)
        precision = tp / max(tp + fp, 1)
        recall = tp / max(tp + fn, 1)
        f1 = 2 * precision * recall / max(precision + recall, 1e-12)
        rows[name] = {"support": int(matrix[index].sum()),
                      "precision": precision, "recall": recall, "f1": f1}
        if rows[name]["support"]:
            f1_values.append(f1)
    return {
        "known": int(len(target)),
        "accuracy": float((predicted == target).mean()),
        "macro_f1": float(np.mean(f1_values)) if f1_values else None,
        "confusion": matrix.tolist(),
        "classes": rows,
        "ece": expected_calibration_error(target, probabilities),
    }


def expected_calibration_error(target, probabilities, bins=15):
    confidence = probabilities.max(axis=1)
    correct = probabilities.argmax(axis=1) == target
    error = 0.0
    edges = np.linspace(0.0, 1.0, bins + 1)
    for lower, upper in zip(edges[:-1], edges[1:]):
        selected = ((confidence >= lower) &
                    (confidence < upper if upper < 1.0 else confidence <= upper))
        if np.any(selected):
            error += (selected.mean() * abs(
                correct[selected].mean() - confidence[selected].mean()))
    return float(error)


def binary_report(target, probabilities, threshold=0.5):
    target = np.asarray(target, dtype=np.float64)
    probabilities = np.asarray(probabilities, dtype=np.float64)
    known = target >= 0
    if not np.any(known):
        return {"known": 0, "accuracy": None, "false_positive": None,
                "false_negative": None}
    truth = target[known] >= 0.5
    guess = probabilities[known] >= threshold
    return {
        "known": int(known.sum()),
        "accuracy": float((truth == guess).mean()),
        "false_positive": int((~truth & guess).sum()),
        "false_negative": int((truth & ~guess).sum()),
    }


def quality_report(target, probabilities, classes, threshold=0.5):
    target = np.asarray(target, dtype=np.float64)
    probabilities = np.asarray(probabilities, dtype=np.float64)
    if target.ndim != 2 or probabilities.shape != target.shape:
        raise ValueError("quality targets and probabilities must be 2-D matches")
    return {
        name: binary_report(target[:, index], probabilities[:, index], threshold)
        for index, name in enumerate(classes)
    }
