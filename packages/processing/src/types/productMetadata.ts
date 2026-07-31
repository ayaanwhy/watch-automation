// Generic product metadata (Phase 12B) — kept in its own types file rather
// than added to types/data.ts, so Watch's existing spreadsheet types stay
// completely untouched. SKU/Category/Sub-Category/Dimensions is a
// product-agnostic shape: Earring is the first consumer, not the reason
// this exists. Dimensions is deliberately an unparsed string — stored with
// the batch but not consumed by the processing pipeline (Phase 12 Resolved
// Decision 1).
export interface ProductMetadataRow {
  sku: string;
  category: string;
  subCategory: string;
  dimensions: string;
}

export interface ParsedProductMetadata {
  rows: ProductMetadataRow[];
  duplicateSkus: string[];
  errors: string[];
}

// Same 8-field shape as Watch's MatchResult (types/data.ts), renamed for a
// generic (non-spreadsheet-specific) context.
export interface ProductMetadataMatchResult {
  totalMetadataRecords: number;
  totalImages: number;
  matched: string[];
  missingImages: string[];
  missingMetadataRecords: string[];
  duplicateMetadataSkus: string[];
  duplicateImageSkus: string[];
  rows: Record<string, ProductMetadataRow>;
}
