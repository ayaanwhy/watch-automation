import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as XLSX from "xlsx";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { parseProductMetadata, discoverImages, matchProductMetadata } from "../packages/processing/src/index.js";
import { classifyEarringType } from "../apps/desktop/src/constants/earringClassification.js";

const tmpDir = join(process.cwd(), ".tmp-metadata-layer-tests");

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

describe("parseProductMetadata", () => {
  it("parses a valid XLSX with required columns", async () => {
    const buf = makeWorkbook([
      ["SKU", "Category", "Sub-Category", "Dimensions"],
      ["ER001", "Earring", "Stud", "10mm"],
      ["ER002", "Earring", "Hoop", "25mm"],
    ]);
    const filePath = join(tmpDir, "valid.xlsx");
    await writeFile(filePath, buf);

    const result = parseProductMetadata(filePath);
    expect(result.errors).toHaveLength(0);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({ sku: "ER001", category: "Earring", subCategory: "Stud", dimensions: "10mm" });
    expect(result.duplicateSkus).toHaveLength(0);
  });

  it("accepts case-insensitive column headers", async () => {
    const buf = makeWorkbook([
      ["sku", "category", "sub-category", "dimensions"],
      ["ER003", "Earring", "Drop", "40mm"],
    ]);
    const filePath = join(tmpDir, "lowercase-headers.xlsx");
    await writeFile(filePath, buf);

    const result = parseProductMetadata(filePath);
    expect(result.errors).toHaveLength(0);
    expect(result.rows).toHaveLength(1);
  });

  it("returns error when a required column is missing", async () => {
    const buf = makeWorkbook([
      ["SKU", "Category", "Dimensions"],
      ["ER004", "Earring", "10mm"],
    ]);
    const filePath = join(tmpDir, "missing-column.xlsx");
    await writeFile(filePath, buf);

    const result = parseProductMetadata(filePath);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("sub-category");
    expect(result.rows).toHaveLength(0);
  });

  it("detects duplicate SKUs", async () => {
    const buf = makeWorkbook([
      ["SKU", "Category", "Sub-Category", "Dimensions"],
      ["ER001", "Earring", "Stud", "10mm"],
      ["ER001", "Earring", "Stud", "10mm"],
      ["ER002", "Earring", "Hoop", "25mm"],
    ]);
    const filePath = join(tmpDir, "duplicates.xlsx");
    await writeFile(filePath, buf);

    const result = parseProductMetadata(filePath);
    expect(result.rows).toHaveLength(3);
    expect(result.duplicateSkus).toContain("ER001");
    expect(result.duplicateSkus).not.toContain("ER002");
  });

  it("parses a valid CSV file", async () => {
    const csvContent = "SKU,Category,Sub-Category,Dimensions\nER010,Earring,Stud,8mm\nER011,Earring,Drop,35mm\n";
    const filePath = join(tmpDir, "valid.csv");
    await writeFile(filePath, csvContent, "utf8");

    const result = parseProductMetadata(filePath);
    expect(result.errors).toHaveLength(0);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].sku).toBe("ER010");
  });

  it("tolerates an empty Dimensions cell rather than erroring", async () => {
    const buf = makeWorkbook([
      ["SKU", "Category", "Sub-Category", "Dimensions"],
      ["ER012", "Earring", "Stud", ""],
    ]);
    const filePath = join(tmpDir, "empty-dimensions.xlsx");
    await writeFile(filePath, buf);

    const result = parseProductMetadata(filePath);
    expect(result.errors).toHaveLength(0);
    expect(result.rows[0]).toMatchObject({ sku: "ER012", dimensions: "" });
  });

  it("returns error for empty metadata file", async () => {
    const buf = makeWorkbook([]);
    const filePath = join(tmpDir, "empty.xlsx");
    await writeFile(filePath, buf);

    const result = parseProductMetadata(filePath);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("returns error for non-existent file", () => {
    const result = parseProductMetadata(join(tmpDir, "does-not-exist.xlsx"));
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.rows).toHaveLength(0);
  });
});

describe("matchProductMetadata", () => {
  it("matches SKUs present in both metadata and images", async () => {
    const buf = makeWorkbook([
      ["SKU", "Category", "Sub-Category", "Dimensions"],
      ["ER001", "Earring", "Stud", "10mm"],
      ["ER002", "Earring", "Hoop", "25mm"],
      ["ER003", "Earring", "Drop", "40mm"],
    ]);
    const filePath = join(tmpDir, "match-test.xlsx");
    await writeFile(filePath, buf);

    const matchDir = join(tmpDir, "match-images");
    await mkdir(matchDir, { recursive: true });
    await writeFile(join(matchDir, "ER001.png"), "");
    await writeFile(join(matchDir, "ER002.png"), "");
    await writeFile(join(matchDir, "ER099.png"), ""); // not in metadata

    const parsed = parseProductMetadata(filePath);
    const images = discoverImages(matchDir);
    const result = matchProductMetadata(parsed, images);

    expect(result.totalMetadataRecords).toBe(3);
    expect(result.totalImages).toBe(3);
    expect(result.matched).toEqual(["ER001", "ER002"]);
    expect(result.missingImages).toEqual(["ER003"]);
    expect(result.missingMetadataRecords).toEqual(["ER099"]);
    expect(result.duplicateMetadataSkus).toHaveLength(0);
    expect(result.duplicateImageSkus).toHaveLength(0);
  });

  it("matches case-insensitively", async () => {
    const buf = makeWorkbook([
      ["SKU", "Category", "Sub-Category", "Dimensions"],
      ["ER001", "Earring", "Stud", "10mm"],
    ]);
    const filePath = join(tmpDir, "case-match.xlsx");
    await writeFile(filePath, buf);

    const caseDir = join(tmpDir, "case-images");
    await mkdir(caseDir, { recursive: true });
    await writeFile(join(caseDir, "er001.png"), ""); // lowercase

    const parsed = parseProductMetadata(filePath);
    const images = discoverImages(caseDir);
    const result = matchProductMetadata(parsed, images);

    expect(result.matched).toHaveLength(1);
    expect(result.missingImages).toHaveLength(0);
  });

  it("includes matched row data (including subCategory, for classification) in rows record", async () => {
    const buf = makeWorkbook([
      ["SKU", "Category", "Sub-Category", "Dimensions"],
      ["ER001", "Earring", "Stud", "10mm"],
    ]);
    const filePath = join(tmpDir, "rows-test.xlsx");
    await writeFile(filePath, buf);

    const rowDir = join(tmpDir, "rows-images");
    await mkdir(rowDir, { recursive: true });
    await writeFile(join(rowDir, "ER001.png"), "");

    const parsed = parseProductMetadata(filePath);
    const images = discoverImages(rowDir);
    const result = matchProductMetadata(parsed, images);

    expect(result.rows["ER001"]).toMatchObject({ sku: "ER001", category: "Earring", subCategory: "Stud", dimensions: "10mm" });
  });

  it("propagates duplicate counts from both sources", async () => {
    const buf = makeWorkbook([
      ["SKU", "Category", "Sub-Category", "Dimensions"],
      ["ER001", "Earring", "Stud", "10mm"],
      ["ER001", "Earring", "Stud", "10mm"], // duplicate
    ]);
    const filePath = join(tmpDir, "dup-match.xlsx");
    await writeFile(filePath, buf);

    const dupDir = join(tmpDir, "dup-match-images");
    await mkdir(dupDir, { recursive: true });
    await writeFile(join(dupDir, "ER001.png"), "");

    const parsed = parseProductMetadata(filePath);
    const images = discoverImages(dupDir);
    const result = matchProductMetadata(parsed, images);

    expect(result.totalMetadataRecords).toBe(2);
    expect(result.duplicateMetadataSkus).toContain("ER001");
    expect(result.matched).toContain("ER001");
  });
});

describe("classifyEarringType (Phase 12B)", () => {
  it("classifies the three canonical singular forms", () => {
    expect(classifyEarringType("Stud")).toBe("stud");
    expect(classifyEarringType("Drop")).toBe("drop");
    expect(classifyEarringType("Hoop")).toBe("hoop");
  });

  it("classifies the three approved plural forms", () => {
    expect(classifyEarringType("Studs")).toBe("stud");
    expect(classifyEarringType("Drops")).toBe("drop");
    expect(classifyEarringType("Hoops")).toBe("hoop");
  });

  it("normalizes whitespace and case before matching", () => {
    expect(classifyEarringType("  STUD  ")).toBe("stud");
    expect(classifyEarringType("hOoP")).toBe("hoop");
    expect(classifyEarringType(" drops ")).toBe("drop");
  });

  it("reports an unmapped value explicitly rather than guessing", () => {
    expect(classifyEarringType("Dangle")).toBeNull();
    expect(classifyEarringType("Chandelier")).toBeNull();
    expect(classifyEarringType("")).toBeNull();
  });
});
