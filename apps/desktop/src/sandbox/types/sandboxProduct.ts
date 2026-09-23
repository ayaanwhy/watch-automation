// Sandbox product classification (Phase 15.0). Six values per the approved
// Phase 15 scope: Watch, Ring, Bracelet, Earring already have real
// processing pipelines (Watch via Phase 14's AI annotation flow; Ring/
// Bracelet/Earring via their existing subprocess runners — see
// electron/sandbox/processingBackend.ts). Necklace and Gemstone are
// deliberately modeled as real, listed product types with no backing
// pipeline yet, rather than omitted — Sandbox UI (15.2+) can show them as
// explicitly unavailable instead of the type system silently not knowing
// they exist. No pipeline for either is invented here or anywhere else in
// this phase.
export type SandboxProductType = 'watch' | 'ring' | 'bracelet' | 'earring' | 'necklace' | 'gemstone'

export interface SandboxProductAvailability {
  available: boolean
  // Set only when available is false — shown as-is in the Sandbox UI
  // (15.2+) so "why can't I pick this" never has to be guessed at call
  // sites.
  reason?: string
}

// Static, not derived — availability here is a product decision (which
// pipelines exist), not something inferred from runtime state.
export const SANDBOX_PRODUCT_AVAILABILITY: Record<SandboxProductType, SandboxProductAvailability> = {
  watch: { available: true },
  ring: { available: true },
  bracelet: { available: true },
  earring: { available: true },
  necklace: { available: false, reason: 'Necklace has no processing pipeline yet.' },
  gemstone: { available: false, reason: 'Gemstone has no processing pipeline yet.' },
}
