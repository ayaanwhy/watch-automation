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
