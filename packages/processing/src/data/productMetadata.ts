import * as XLSX from "xlsx";
import type { ProductMetadataRow, ParsedProductMetadata, ProductMetadataMatchResult } from "../types/productMetadata.js";
import type { DiscoveredImages } from "./imageDiscovery.js";

const REQUIRED_COLUMNS = ["sku", "category", "sub-category", "dimensions"] as const;

export function parseProductMetadata(filePath: string): ParsedProductMetadata {
  let workbook: XLSX.WorkBook;

  try {
    workbook = XLSX.readFile(filePath);
  } catch {
    return { rows: [], duplicateSkus: [], errors: ["Failed to read product metadata file."] };
  }

  const sheetName = workbook.SheetNames[0];

  if (!sheetName) {
    return { rows: [], duplicateSkus: [], errors: ["Product metadata file contains no sheets."] };
  }

  const sheet = workbook.Sheets[sheetName];
  const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: "",
    raw: false
  });

  if (rawRows.length === 0) {
    return { rows: [], duplicateSkus: [], errors: ["Product metadata file contains no data rows."] };
  }

  // Detect missing required columns from first row's keys
  const headerKeys = Object.keys(rawRows[0]).map(k => k.trim().toLowerCase());
  const missingColumns = REQUIRED_COLUMNS.filter(col => !headerKeys.includes(col));

  if (missingColumns.length > 0) {
    return {
      rows: [],
      duplicateSkus: [],
      errors: [`Missing required columns: ${missingColumns.join(", ")}`]
    };
  }

  const rows: ProductMetadataRow[] = [];
  const skuFirstCase = new Map<string, string>();
  const skuCounts = new Map<string, number>();

  for (const raw of rawRows) {
    const normalized: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) {
      normalized[k.trim().toLowerCase()] = v;
    }

    const sku = String(normalized["sku"] ?? "").trim();
    if (!sku) continue;

    const category = String(normalized["category"] ?? "").trim();
    const subCategory = String(normalized["sub-category"] ?? "").trim();
    const dimensions = String(normalized["dimensions"] ?? "").trim();

    rows.push({ sku, category, subCategory, dimensions });

    const key = sku.toLowerCase();
    if (!skuFirstCase.has(key)) skuFirstCase.set(key, sku);
    skuCounts.set(key, (skuCounts.get(key) ?? 0) + 1);
  }

  const duplicateSkus = [...skuCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([key]) => skuFirstCase.get(key)!);

  return { rows, duplicateSkus, errors: [] };
}

export function matchProductMetadata(
  metadata: ParsedProductMetadata,
  images: DiscoveredImages
): ProductMetadataMatchResult {
  const { rows, duplicateSkus: duplicateMetadataSkus } = metadata;
  const { skus: imageSkus, totalCount: totalImages, duplicateSkus: duplicateImageSkus } = images;

  // Build metadata lookup — first occurrence wins for case conflicts
  const metadataMap = new Map<string, ProductMetadataRow>();
  const uniqueMetadataSkus = new Map<string, string>(); // lower → original

  for (const row of rows) {
    const key = row.sku.toLowerCase();
    if (!metadataMap.has(key)) {
      metadataMap.set(key, row);
      uniqueMetadataSkus.set(key, row.sku);
    }
  }

  // Build image lookup
  const imageSkuMap = new Map<string, string>(); // lower → original
  for (const sku of imageSkus) {
    imageSkuMap.set(sku.toLowerCase(), sku);
  }

  const matched: string[] = [];
  const missingImages: string[] = [];

  for (const [lower, original] of uniqueMetadataSkus) {
    if (imageSkuMap.has(lower)) {
      matched.push(original);
    } else {
      missingImages.push(original);
    }
  }

  const missingMetadataRecords: string[] = [];
  for (const [lower, original] of imageSkuMap) {
    if (!uniqueMetadataSkus.has(lower)) {
      missingMetadataRecords.push(original);
    }
  }

  const matchedRows: Record<string, ProductMetadataRow> = {};
  for (const sku of matched) {
    const row = metadataMap.get(sku.toLowerCase());
    if (row) matchedRows[sku] = row;
  }

  return {
    totalMetadataRecords: rows.length,
    totalImages,
    matched: matched.sort(),
    missingImages: missingImages.sort(),
    missingMetadataRecords: missingMetadataRecords.sort(),
    duplicateMetadataSkus: duplicateMetadataSkus.sort(),
    duplicateImageSkus: duplicateImageSkus.sort(),
    rows: matchedRows
  };
}
