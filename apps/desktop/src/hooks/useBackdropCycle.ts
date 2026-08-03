import { useEffect } from 'react'
import type { ComparisonBackground } from '../components/shared/BeforeAfterSlider'

const CYCLE: ComparisonBackground[] = ['neutral', 'white', 'checkerboard']

// Keyboard 'B' cycling for the Stage backdrop toggle (Phase 13F, Visual
// Direction: "Neutral / White / Checkerboard, keyboard B"). Each preview
// panel owns its own `background` state independently, so this hook is
// called from within each one rather than centralized — see
// ImagePreviewPanel.tsx / RingBraceletImagePreviewPanel.tsx.
export function useBackdropCycle(
  background: ComparisonBackground,
  onChange: (next: ComparisonBackground) => void,
  enabled = true,
) {
  useEffect(() => {
    if (!enabled) return
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key.toLowerCase() !== 'b') return
      // Don't hijack 'b' while the user is typing into a real text field —
      // but the range input driving the compare slider itself has no native
      // use for the letter, so it's deliberately not excluded here.
      const target = e.target
      if (target instanceof HTMLInputElement && target.type !== 'range') return
      if (target instanceof HTMLTextAreaElement) return
      const idx = CYCLE.indexOf(background)
      onChange(CYCLE[(idx + 1) % CYCLE.length])
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [background, onChange, enabled])
}
