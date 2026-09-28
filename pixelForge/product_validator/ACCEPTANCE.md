# Validator promotion gates

The validator is allowed to protect the segmentation endpoint only after all
of these gates pass on a frozen holdout made from real merchant uploads.

## Data

- No product SKU, render variant or byte-identical image crosses the
  train/validation boundary.
- Every minimum reported by `python -m product_validator.manifest audit` is
  met.
- The holdout includes every supported merchant/source, metal colour, stone
  colour and difficult background represented in production.
- At least 500 holdout images are valid front-facing products and at least 500
  are invalid. Synthetic images may augment training but do not count toward
  this holdout.

## Accuracy and calibration

- Valid front-facing product recall is at least 99%. This limits accidental
  rejection of usable merchant images.
- At least 99% of hard rejections are genuinely invalid. Ambiguous cases must
  return `validation_uncertain`, not a hard error.
- Invalid-image recall is at least 95% when uncertain responses are treated as
  requiring fallback/manual handling.
- Ring-versus-gemstone accuracy is at least 99%, with no supported class below
  97% recall.
- Left, right and half-turn orientation corrections are evaluated separately;
  no direction may be inferred from a horizontal-flip augmentation.
- At least 99% of `correctable` responses name the correction that makes the
  product upright. The corrected image must pass validation again before it is
  sent to segmentation.
- Expected calibration error is at most 0.03 for product type, view and
  orientation correction.
- Every false rejection and unsafe acceptance in the ONNX benchmark is
  manually inspected before promotion.

## Runtime

- ONNX and PyTorch logits agree within `1e-4` absolute error.
- p95 validator inference is below 25 ms on the deployment CPU or below 5 ms
  on the deployment GPU, measured separately from upload/network time.
- The validator is run once per upload, before segmentation. It is not called
  once per output layer.

## Rollout

1. Deploy in shadow mode: record predictions but never block a request.
2. Review at least 5,000 real requests from at least two weeks of traffic.
3. Recalibrate thresholds from shadow results.
4. Enable hard rejection only for high-confidence failures. Keep uncertain
   requests on the existing segmentation path initially.
5. Preserve a kill switch that disables validation without changing the
   segmentation model.

Passing these gates still does not modify or replace `deploy/model.onnx` or
`deploy/ownership_refiner.onnx`. Integration requires an explicit, separate
approval.
