import { useEffect } from 'react'
import { useAppearancePrefs } from '../../hooks/useAppearancePrefs'
import type { AppearanceOverride } from '../../types/ipc'

// Off/Subtle/Standard multiplier applied to AmbientBackground's blob
// opacity via a CSS custom property (see AmbientBackground.module.css's
// .blob rule) — 'standard' (1) reproduces the exact pre-13H look.
const AMBIENT_INTENSITY_SCALE: Record<'off' | 'subtle' | 'standard', number> = {
  off: 0,
  subtle: 0.5,
  standard: 1,
}

function applyOverrideAttribute(attribute: string, override: AppearanceOverride): void {
  const root = document.documentElement
  if (override === 'system') {
    // Defer entirely to whatever main.tsx's one-time OS-preference read
    // already established at startup — no explicit override to layer on
    // top of it.
    root.removeAttribute(attribute)
  } else {
    root.setAttribute(attribute, override === 'on' ? 'true' : 'false')
  }
}

// Always-mounted applier (Phase 13H) — mirrors JobCompletionToasts' mounting
// pattern (App.tsx, alongside the shell) so persisted Appearance prefs take
// effect on every launch, not only while Settings happens to be open.
// Settings' own controls write through useAppearancePrefs' savePrefs, which
// updates the same underlying prefs.json this component reads — no direct
// coupling between the two beyond that shared source of truth.
export function AppearanceEffects() {
  const { prefs, loaded } = useAppearancePrefs()

  useEffect(() => {
    if (!loaded) return
    applyOverrideAttribute('data-reduced-motion', prefs.reducedMotion)
    applyOverrideAttribute('data-reduced-transparency', prefs.reducedTransparency)
    document.documentElement.style.setProperty('--ambient-intensity', String(AMBIENT_INTENSITY_SCALE[prefs.ambientIntensity]))
  }, [loaded, prefs])

  return null
}
