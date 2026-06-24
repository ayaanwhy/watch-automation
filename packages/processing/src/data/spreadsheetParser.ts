import * as XLSX from "xlsx";
import type { SpreadsheetRow } from "../types/data.js";

const REQUIRED_COLUMNS = ["sku", "width", "height", "measure by"] as const;

export interface ParsedSpreadsheet {
  rows: SpreadsheetRow[];
  duplicateSkus: string[];
  errors: string[];
}

export function parseSpreadsheet(filePath: string): ParsedSpreadsheet {
  let workbook: XLSX.WorkBook;

  try {
    workbook = XLSX.readFile(filePath);
  } catch {
    return { rows: [], duplicateSkus: [], errors: ["Failed to read spreadsheet file."] };
  }

  const sheetName = workbook.SheetNames[0];

  if (!sheetName) {
    return { rows: [], duplicateSkus: [], errors: ["Spreadsheet contains no sheets."] };
  }

  const sheet = workbook.Sheets[sheetName];
  const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: "",
    raw: false
  });

  if (rawRows.length === 0) {
    return { rows: [], duplicateSkus: [], errors: ["Spreadsheet contains no data rows."] };
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

  const rows: SpreadsheetRow[] = [];
  const skuFirstCase = new Map<string, string>();
  const skuCounts = new Map<string, number>();

  for (const raw of rawRows) {
    const normalized: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) {
      normalized[k.trim().toLowerCase()] = v;
    }

    const sku = String(normalized["sku"] ?? "").trim();
    if (!sku) continue;

    const widthMm = parseFloat(String(normalized["width"]));
    const heightMm = parseFloat(String(normalized["height"]));
    const measureBy = String(normalized["measure by"] ?? "").trim();

    rows.push({
      sku,
      widthMm: Number.isFinite(widthMm) ? widthMm : 0,
      heightMm: Number.isFinite(heightMm) ? heightMm : 0,
      measureBy
    });

    const key = sku.toLowerCase();
    if (!skuFirstCase.has(key)) skuFirstCase.set(key, sku);
    skuCounts.set(key, (skuCounts.get(key) ?? 0) + 1);
  }

  const duplicateSkus = [...skuCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([key]) => skuFirstCase.get(key)!);

  return { rows, duplicateSkus, errors: [] };
}
