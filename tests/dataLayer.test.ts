import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as XLSX from "xlsx";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { parseSpreadsheet, discoverImages, matchSkus } from "../packages/processing/src/index.js";

const tmpDir = join(process.cwd(), ".tmp-data-layer-tests");

function makeWorkbook(rows: string[][]): Buffer {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

beforeAll(async () => {
  await mkdir(tmpDir, { recursive: true });
  await mkdir(join(tmpDir, "images"), { recursive: true });
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("parseSpreadsheet", () => {
  it("parses a valid XLSX with required columns", async () => {
    const buf = makeWorkbook([
      ["SKU", "Width", "Height", "Measure By"],
      ["WT001", "44", "50", "Dial"],
      ["WT002", "40", "45", "Case"],
    ]);
    const filePath = join(tmpDir, "valid.xlsx");
    await writeFile(filePath, buf);

    const result = parseSpreadsheet(filePath);
    expect(result.errors).toHaveLength(0);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({ sku: "WT001", widthMm: 44, heightMm: 50, measureBy: "Dial" });
    expect(result.duplicateSkus).toHaveLength(0);
  });

  it("accepts case-insensitive column headers", async () => {
    const buf = makeWorkbook([
      ["sku", "width", "height", "measure by"],
      ["WT003", "38", "42", "Case"],
    ]);
    const filePath = join(tmpDir, "lowercase-headers.xlsx");
    await writeFile(filePath, buf);

    const result = parseSpreadsheet(filePath);
    expect(result.errors).toHaveLength(0);
    expect(result.rows).toHaveLength(1);
  });

  it("returns error when required column is missing", async () => {
    const buf = makeWorkbook([
      ["SKU", "Width", "Height"],
      ["WT004", "44", "50"],
    ]);
    const filePath = join(tmpDir, "missing-column.xlsx");
    await writeFile(filePath, buf);

    const result = parseSpreadsheet(filePath);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("measure by");
    expect(result.rows).toHaveLength(0);
  });

  it("detects duplicate SKUs", async () => {
    const buf = makeWorkbook([
      ["SKU", "Width", "Height", "Measure By"],
      ["WT001", "44", "50", "Dial"],
      ["WT001", "44", "50", "Dial"],
      ["WT002", "40", "45", "Case"],
    ]);
    const filePath = join(tmpDir, "duplicates.xlsx");
    await writeFile(filePath, buf);

    const result = parseSpreadsheet(filePath);
    expect(result.rows).toHaveLength(3);
    expect(result.duplicateSkus).toContain("WT001");
    expect(result.duplicateSkus).not.toContain("WT002");
  });

  it("parses a valid CSV file", async () => {
    const csvContent = "SKU,Width,Height,Measure By\nWT010,41,47,Dial\nWT011,39,44,Case\n";
    const filePath = join(tmpDir, "valid.csv");
    await writeFile(filePath, csvContent, "utf8");

    const result = parseSpreadsheet(filePath);
    expect(result.errors).toHaveLength(0);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].sku).toBe("WT010");
  });

  it("returns error for empty spreadsheet", async () => {
    const buf = makeWorkbook([]);
    const filePath = join(tmpDir, "empty.xlsx");
    await writeFile(filePath, buf);

    const result = parseSpreadsheet(filePath);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("returns error for non-existent file", () => {
    const result = parseSpreadsheet(join(tmpDir, "does-not-exist.xlsx"));
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.rows).toHaveLength(0);
  });
});

describe("discoverImages", () => {
  it("finds PNG files and extracts SKUs", async () => {
    await writeFile(join(tmpDir, "images", "WT001.png"), "");
    await writeFile(join(tmpDir, "images", "WT002.png"), "");
    await writeFile(join(tmpDir, "images", "notes.txt"), "");

    const result = discoverImages(join(tmpDir, "images"));
    expect(result.totalCount).toBe(2);
    expect(result.skus).toContain("WT001");
    expect(result.skus).toContain("WT002");
    expect(result.skus).not.toContain("notes");
    expect(result.duplicateSkus).toHaveLength(0);
  });

  it("returns empty results for a folder with no PNGs", async () => {
    const emptyDir = join(tmpDir, "no-images");
    await mkdir(emptyDir, { recursive: true });
    await writeFile(join(emptyDir, "readme.txt"), "");

    const result = discoverImages(emptyDir);
    expect(result.totalCount).toBe(0);
    expect(result.skus).toHaveLength(0);
    expect(result.duplicateSkus).toHaveLength(0);
  });
});

describe("matchSkus", () => {
  it("matches SKUs present in both spreadsheet and images", async () => {
    const buf = makeWorkbook([
      ["SKU", "Width", "Height", "Measure By"],
      ["WT001", "44", "50", "Dial"],
      ["WT002", "40", "45", "Case"],
      ["WT003", "38", "42", "Dial"],
    ]);
    const filePath = join(tmpDir, "match-test.xlsx");
    await writeFile(filePath, buf);

    const matchDir = join(tmpDir, "match-images");
    await mkdir(matchDir, { recursive: true });
    await writeFile(join(matchDir, "WT001.png"), "");
    await writeFile(join(matchDir, "WT002.png"), "");
    await writeFile(join(matchDir, "WT099.png"), ""); // not in spreadsheet

    const parsed = parseSpreadsheet(filePath);
    const images = discoverImages(matchDir);
    const result = matchSkus(parsed, images);

    expect(result.totalSpreadsheetRecords).toBe(3);
    expect(result.totalImages).toBe(3);
    expect(result.matched).toEqual(["WT001", "WT002"]);
    expect(result.missingImages).toEqual(["WT003"]);
    expect(result.missingSpreadsheetRecords).toEqual(["WT099"]);
    expect(result.duplicateSpreadsheetSkus).toHaveLength(0);
    expect(result.duplicateImageSkus).toHaveLength(0);
  });

  it("matches case-insensitively", async () => {
    const buf = makeWorkbook([
      ["SKU", "Width", "Height", "Measure By"],
      ["WT001", "44", "50", "Dial"],
    ]);
    const filePath = join(tmpDir, "case-match.xlsx");
    await writeFile(filePath, buf);

    const caseDir = join(tmpDir, "case-images");
    await mkdir(caseDir, { recursive: true });
    await writeFile(join(caseDir, "wt001.png"), ""); // lowercase

    const parsed = parseSpreadsheet(filePath);
    const images = discoverImages(caseDir);
    const result = matchSkus(parsed, images);

    expect(result.matched).toHaveLength(1);
    expect(result.missingImages).toHaveLength(0);
  });

  it("includes matched row data in rows record", async () => {
    const buf = makeWorkbook([
      ["SKU", "Width", "Height", "Measure By"],
      ["WT001", "44", "50", "Dial"],
    ]);
    const filePath = join(tmpDir, "rows-test.xlsx");
    await writeFile(filePath, buf);

    const rowDir = join(tmpDir, "rows-images");
    await mkdir(rowDir, { recursive: true });
    await writeFile(join(rowDir, "WT001.png"), "");

    const parsed = parseSpreadsheet(filePath);
    const images = discoverImages(rowDir);
    const result = matchSkus(parsed, images);

    expect(result.rows["WT001"]).toMatchObject({ sku: "WT001", widthMm: 44, heightMm: 50, measureBy: "Dial" });
  });

  it("propagates duplicate counts from both sources", async () => {
    const buf = makeWorkbook([
      ["SKU", "Width", "Height", "Measure By"],
      ["WT001", "44", "50", "Dial"],
      ["WT001", "44", "50", "Dial"], // duplicate
    ]);
    const filePath = join(tmpDir, "dup-match.xlsx");
    await writeFile(filePath, buf);

    const dupDir = join(tmpDir, "dup-match-images");
    await mkdir(dupDir, { recursive: true });
    await writeFile(join(dupDir, "WT001.png"), "");

    const parsed = parseSpreadsheet(filePath);
    const images = discoverImages(dupDir);
    const result = matchSkus(parsed, images);

    expect(result.totalSpreadsheetRecords).toBe(2);
    expect(result.duplicateSpreadsheetSkus).toContain("WT001");
    expect(result.matched).toContain("WT001");
  });
});
