import { readdirSync } from "node:fs";
import { extname, basename } from "node:path";

export interface DiscoveredImages {
  skus: string[];
  totalCount: number;
  duplicateSkus: string[];
}

export function discoverImages(folderPath: string): DiscoveredImages {
  const files = readdirSync(folderPath);
  const pngFiles = files.filter(f => extname(f).toLowerCase() === ".png");
  const totalCount = pngFiles.length;

  const allSkus = pngFiles.map(f => basename(f, extname(f)));

  const skuFirstCase = new Map<string, string>();
  const skuCounts = new Map<string, number>();

  for (const sku of allSkus) {
    const key = sku.toLowerCase();
    if (!skuFirstCase.has(key)) skuFirstCase.set(key, sku);
    skuCounts.set(key, (skuCounts.get(key) ?? 0) + 1);
  }

  const duplicateSkus = [...skuCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([key]) => skuFirstCase.get(key)!);

  // Return unique SKUs (first-occurrence case wins for case conflicts)
  const skus = [...skuFirstCase.values()];

  return { skus, totalCount, duplicateSkus };
}
