# @wpa/processing

Reusable watch processing engine for WPA.

This package owns the production processing pipeline:

- splice source PNG by original-image boundary coordinates
- scale by measured dial width
- center the dial on the standard canvas
- horizontally compress straps
- generate and mask shadow from the assembled watch alpha
- export a transparent PNG trimmed vertically to visible pixels

UI, backend APIs, queues, and future Sandbox integration should consume this package instead of reimplementing processing logic.

```ts
import { processWatch } from "@wpa/processing";

await processWatch({
  inputPath: "./input.png",
  outputPath: "./SKU;frontImage.png",
  widthMm: 44,
  leftBoundary: 390,
  rightBoundary: 3005
});
```
