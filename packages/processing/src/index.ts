export { parseSpreadsheet } from "./data/spreadsheetParser.js";
export { discoverImages } from "./data/imageDiscovery.js";
export { matchSkus } from "./data/skuMatcher.js";
export type { ParsedSpreadsheet } from "./data/spreadsheetParser.js";
export type { DiscoveredImages } from "./data/imageDiscovery.js";
export type { SpreadsheetRow, MatchResult } from "./types/data.js";
export { CANVAS_SIZE, PX_PER_MM, REFERENCE_WIDTH_MM } from "./processing/constants.js";
export { createCompressedLayout } from "./processing/compressionEngine.js";
export { exportAssembly } from "./processing/exportEngine.js";
export { processWatch } from "./processing/processWatch.js";
export { scaleToMeasurement } from "./processing/scalingEngine.js";
export { createDropShadow, defaultShadowSettings } from "./processing/shadowEngine.js";
export { spliceImage } from "./processing/spliceEngine.js";
export type {
  AssemblyLayout,
  BoundaryData,
  BoundarySource,
  ProcessWatchInput,
  ProcessWatchResult,
  ScaleResult,
  SegmentBox,
  ShadowSettings,
  SourceImageInfo,
  SpliceResult
} from "./types/processing.js";
