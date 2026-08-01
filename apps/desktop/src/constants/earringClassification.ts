// Earring Sub-Category → earring type classification (Phase 12B).
//
// Deliberately app-side, not part of @wpa/processing's generic product
// metadata system (packages/processing/src/data/productMetadata.ts) —
// parsing/matching a metadata sheet is product-agnostic; interpreting what
// a given Sub-Category value *means* is Earring-specific and will differ
// for whatever product reuses the metadata system next.
//
// Minimal exact-match mapping only (singular/plural of the three canonical
// names, normalized/case-insensitive) — no broader synonym guessing. An
// unrecognized Sub-Category must be reported explicitly, never silently
// defaulted (Phase 12 Resolved Decision 1).
export type EarringType = 'stud' | 'drop' | 'hoop'

const SUB_CATEGORY_MAP: Record<string, EarringType> = {
  stud: 'stud',
  studs: 'stud',
  drop: 'drop',
  drops: 'drop',
  hoop: 'hoop',
  hoops: 'hoop',
}

export function classifyEarringType(subCategory: string): EarringType | null {
  const normalized = subCategory.trim().toLowerCase()
  return SUB_CATEGORY_MAP[normalized] ?? null
}

// Classifies every matched SKU from a product-metadata match result in one
// pass — the shared step behind both metadataHandlers.ts's match-summary
// response (which needs the unmapped list too, for the setup screen) and
// earringHandlers.ts's resolveEarringTypes (which only needs bySku, for the
// runner sidecar). Structurally typed against `rows` rather than importing
// @wpa/processing's ProductMetadataRow, matching this file's existing
// no-external-type-dependency design (see module docstring).
export function classifyMatchedSkus(
  matched: string[],
  rows: Record<string, { subCategory: string }>,
): { bySku: Record<string, EarringType>; unmapped: string[] } {
  const bySku: Record<string, EarringType> = {}
  const unmapped: string[] = []
  for (const sku of matched) {
    const type = classifyEarringType(rows[sku].subCategory)
    if (type === null) {
      unmapped.push(sku)
    } else {
      bySku[sku] = type
    }
  }
  return { bySku, unmapped }
}
