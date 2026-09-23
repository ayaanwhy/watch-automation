// Shared display metadata for Sandbox's six product types (Phase 15.2) —
// one place mapping SandboxProductType to a label/glyph, reused by the
// Temporary Batch picker, Editing configuration, and Post Processing
// configuration sections rather than each hardcoding its own copy.
import {
  RingGlyph,
  BraceletGlyph,
  EarringGlyph,
  NecklaceGlyph,
  WatchGlyph,
  GemstoneGlyph,
  type IconComponent,
} from '../../components/icons/ProductGlyphs'
import type { SandboxProductType } from '../types/sandboxProduct'

// Canonical display order used everywhere Sandbox lists product types, so
// the same batch always presents its products in the same order regardless
// of the order the API happened to return them in.
export const SANDBOX_PRODUCT_TYPE_ORDER: SandboxProductType[] = [
  'watch',
  'ring',
  'bracelet',
  'earring',
  'necklace',
  'gemstone',
]

export const SANDBOX_PRODUCT_LABELS: Record<SandboxProductType, string> = {
  watch: 'Watches',
  ring: 'Rings',
  bracelet: 'Bracelets',
  earring: 'Earrings',
  necklace: 'Necklaces',
  gemstone: 'Gemstones',
}

export const SANDBOX_PRODUCT_GLYPHS: Record<SandboxProductType, IconComponent> = {
  watch: WatchGlyph,
  ring: RingGlyph,
  bracelet: BraceletGlyph,
  earring: EarringGlyph,
  necklace: NecklaceGlyph,
  gemstone: GemstoneGlyph,
}

// Sorts a set of present product types into the canonical display order —
// used wherever a batch's productTypes array (API-supplied, order not
// guaranteed) needs to render consistently.
export function sortSandboxProductTypes(productTypes: SandboxProductType[]): SandboxProductType[] {
  const present = new Set(productTypes)
  return SANDBOX_PRODUCT_TYPE_ORDER.filter(p => present.has(p))
}
