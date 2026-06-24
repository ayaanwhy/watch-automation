import type { SpreadsheetRow, MatchResult } from "../types/data.js";
import type { ParsedSpreadsheet } from "./spreadsheetParser.js";
import type { DiscoveredImages } from "./imageDiscovery.js";

export function matchSkus(
  spreadsheet: ParsedSpreadsheet,
  images: DiscoveredImages
): MatchResult {
  const { rows, duplicateSkus: duplicateSpreadsheetSkus } = spreadsheet;
  const { skus: imageSkus, totalCount: totalImages, duplicateSkus: duplicateImageSkus } = images;

  // Build spreadsheet lookup — first occurrence wins for case conflicts
  const spreadsheetMap = new Map<string, SpreadsheetRow>();
  const uniqueSheetSkus = new Map<string, string>(); // lower → original

  for (const row of rows) {
    const key = row.sku.toLowerCase();
    if (!spreadsheetMap.has(key)) {
      spreadsheetMap.set(key, row);
      uniqueSheetSkus.set(key, row.sku);
    }
  }

  // Build image lookup
  const imageSkuMap = new Map<string, string>(); // lower → original
  for (const sku of imageSkus) {
    imageSkuMap.set(sku.toLowerCase(), sku);
  }

  const matched: string[] = [];
  const missingImages: string[] = [];

  for (const [lower, original] of uniqueSheetSkus) {
    if (imageSkuMap.has(lower)) {
      matched.push(original);
    } else {
      missingImages.push(original);
    }
  }

  const missingSpreadsheetRecords: string[] = [];
  for (const [lower, original] of imageSkuMap) {
    if (!uniqueSheetSkus.has(lower)) {
      missingSpreadsheetRecords.push(original);
    }
  }

  const matchedRows: Record<string, SpreadsheetRow> = {};
  for (const sku of matched) {
    const row = spreadsheetMap.get(sku.toLowerCase());
    if (row) matchedRows[sku] = row;
  }

  return {
    totalSpreadsheetRecords: rows.length,
    totalImages,
    matched: matched.sort(),
    missingImages: missingImages.sort(),
    missingSpreadsheetRecords: missingSpreadsheetRecords.sort(),
    duplicateSpreadsheetSkus: duplicateSpreadsheetSkus.sort(),
    duplicateImageSkus: duplicateImageSkus.sort(),
    rows: matchedRows
  };
}
