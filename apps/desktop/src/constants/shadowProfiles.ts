// Shadow profile definitions (Phase 13H) — the editable, versioned
// counterpart to preprocessing/shadow.py's RING_BRACELET_SHADOW /
// EARRING_SHADOW dicts, mirroring constants/preprocessingPresets.ts's
// exact shape (values / definition-with-version / factory-defaults /
// isModified) for the same reasons: Settings needs to edit + reset + track
// provenance, and the "modified" indicator must be computed, never stored,
// so it can't drift from the actual values.
//
// Earring has two profiles (Stud/Drop and Hoop) even though both currently
// resolve to the exact same EARRING_SHADOW values in Python — see the
// Shadow Profiles design: "profile cards (Ring & Bracelet · Earring
// Stud/Drop · Earring Hoop)". Keeping them as independently-editable
// definitions from day one (rather than one shared Earring profile) means a
// future divergence between Stud/Drop and Hoop tuning needs no schema
// change later.
//
// 'watch' (post-Phase-13 addition) is the odd one out: its runtime is
// packages/processing/src/processing/shadowEngine.ts, a separate TypeScript
// port of this same algorithm (not preprocessing/shadow.py), consumed
// in-process by electron/ipc/processHandlers.ts rather than via a subprocess
// sidecar file. It shares this exact schema/editor/versioning because the
// seven tunable parameters are identical — see
// electron/ipc/processHandlers.ts's runProcessWatch for how the values
// actually reach the engine.
export type ShadowProfileName = 'ringBracelet' | 'earringStudDrop' | 'earringHoop' | 'watch'

// Mirrors preprocessing/shadow.py's settings dict shape exactly —
// horizontal_falloff/canvas_base are made required+explicit here (Python
// resolves them via settings.get(key, default) when absent; there is no
// equivalent implicit fallback on this side, so the factory values below
// spell out what that default resolves to for each profile). Watch's own
// engine (shadowEngine.ts) has no equivalent of either flag — falloff isn't
// proportional there and its canvas is a fixed constant (CANVAS_SIZE) — so
// both fields are inert for the 'watch' profile; ShadowProfileEditor.tsx
// hides the falloff control for 'watch' specifically to avoid presenting a
// no-op toggle.
export interface ShadowProfileValues {
  x_offset: number
  y_offset: number
  blur_radius: number
  spread: number
  density: number
  opacity: number
  color: string
  horizontal_falloff: boolean
  canvas_base: number
}

export interface ShadowProfileDefinition extends ShadowProfileValues {
  version: number
}

export type ShadowProfileDefinitions = Record<ShadowProfileName, ShadowProfileDefinition>

export const SHADOW_PROFILE_OPTIONS: { value: ShadowProfileName; label: string; description: string }[] = [
  { value: 'watch', label: 'Watch', description: 'Applied to every Watch frontImage.' },
  { value: 'ringBracelet', label: 'Ring & Bracelet', description: 'Applied to every Ring and Bracelet frontImage.' },
  { value: 'earringStudDrop', label: 'Earring — Stud/Drop', description: 'Applied to Stud and Drop earring frontImage assets.' },
  { value: 'earringHoop', label: 'Earring — Hoop', description: 'Applied to Hoop earring frontImage assets.' },
]

// Factory defaults — byte-identical to preprocessing/shadow.py's
// RING_BRACELET_SHADOW / EARRING_SHADOW dicts (both Automatic and Manual
// Hoop use EARRING_SHADOW's values today, per Phase 12's own architecture —
// see this file's module comment for why they're still separate
// definitions). Used to initialize persisted definitions on first run and
// to implement Settings' "Reset to default" — never used to build runner
// arguments at run time; see electron/services/shadowProfileDefinitions.ts
// for the live, possibly-edited values.
export const DEFAULT_SHADOW_PROFILES: Record<ShadowProfileName, ShadowProfileValues> = {
  // Byte-identical to shadowEngine.ts's own defaultShadowSettings (xOffset
  // 0, yOffset 54, blurRadius 16, spread 0, density 1.75, opacity 0.3,
  // color #2e170a) — Ring & Bracelet's own factory values were originally
  // tuned to match these, per preprocessing/shadow.py's module docstring.
  watch: {
    x_offset: 0,
    y_offset: 54,
    blur_radius: 16,
    spread: 0,
    density: 1.75,
    opacity: 0.3,
    color: '#2e170a',
    horizontal_falloff: false,
    canvas_base: 2000,
  },
  ringBracelet: {
    x_offset: 0,
    y_offset: 50,
    blur_radius: 40,
    spread: 0,
    density: 1.75,
    opacity: 0.3,
    color: '#2e170a',
    horizontal_falloff: true,
    canvas_base: 2000,
  },
  earringStudDrop: {
    x_offset: 0,
    y_offset: 20,
    blur_radius: 24,
    spread: 7,
    density: 1.75,
    opacity: 0.4,
    color: '#2e170a',
    horizontal_falloff: false,
    canvas_base: 1000,
  },
  earringHoop: {
    x_offset: 0,
    y_offset: 20,
    blur_radius: 24,
    spread: 7,
    density: 1.75,
    opacity: 0.4,
    color: '#2e170a',
    horizontal_falloff: false,
    canvas_base: 1000,
  },
}

// Builds the initial set of persisted definitions (factory values, version 1
// each) for when no shadow-profile-definitions.json exists yet — mirrors
// factoryPresetDefinitions() exactly.
export function factoryShadowProfileDefinitions(): ShadowProfileDefinitions {
  const names: ShadowProfileName[] = ['watch', 'ringBracelet', 'earringStudDrop', 'earringHoop']
  const result = {} as ShadowProfileDefinitions
  for (const name of names) {
    result[name] = { ...DEFAULT_SHADOW_PROFILES[name], version: 1 }
  }
  return result
}

// True when a profile's active values differ from its factory defaults —
// computed rather than stored, mirroring isPresetModified's exact rationale.
export function isShadowProfileModified(name: ShadowProfileName, values: ShadowProfileValues): boolean {
  const factory = DEFAULT_SHADOW_PROFILES[name]
  return (Object.keys(factory) as (keyof ShadowProfileValues)[]).some(key => factory[key] !== values[key])
}
