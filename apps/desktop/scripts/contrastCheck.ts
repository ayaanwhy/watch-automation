// One-time, manually-run verification for Phase 13A's Atelier palette —
// not part of `npx vitest run` (the plan calls for "starting values, tuned
// and contrast-verified in 13A," a one-shot tuning pass, not a permanent
// regression gate). Run with: npx tsx apps/desktop/scripts/contrastCheck.ts
//
// Computes WCAG 2.1 contrast ratios for every text/surface and
// accent-or-semantic/surface pairing the token system defines, and reports
// pass/fail against the plan's Accessibility thresholds (4.5:1 body text,
// 3:1 large text / non-text UI components).

interface Rgb {
  r: number
  g: number
  b: number
}

function hexToRgb(hex: string): Rgb {
  const clean = hex.replace('#', '')
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  }
}

// WCAG relative luminance (sRGB).
function relativeLuminance({ r, g, b }: Rgb): number {
  const toLinear = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  const [rl, gl, bl] = [toLinear(r), toLinear(g), toLinear(b)]
  return 0.2126 * rl + 0.7152 * gl + 0.0722 * bl
}

function contrastRatio(fg: string, bg: string): number {
  const l1 = relativeLuminance(hexToRgb(fg))
  const l2 = relativeLuminance(hexToRgb(bg))
  const lighter = Math.max(l1, l2)
  const darker = Math.min(l1, l2)
  return (lighter + 0.05) / (darker + 0.05)
}

// Mirrors global.css's :root values. Kept as a plain literal (not imported
// from the CSS) since this is a standalone one-shot script with no CSS
// parser dependency — if global.css's hex values change, re-sync this
// object by hand before re-running.
const surfaces = {
  'bg-ambient': '#0a0b0e',
  'bg-app': '#0e1014',
  'surface-1': '#14161b',
  'surface-2': '#191c22',
  'surface-3': '#1f232b',
}

const text = {
  'text-1': '#edeef3',
  'text-2': '#a6abb8',
  'text-3': '#848b9a', // tuned up from the plan's #6e7480 starting value — see below
  'text-4': '#4a4f5a', // disabled — exempt from contrast requirements (WCAG 1.4.3), reported for visibility only
}

const accentAndSemantic = {
  accent: '#8b7cff',
  success: '#3ecf6e',
  warning: '#ffc53d',
  danger: '#ff6b6b',
  'review-flag': '#f87683',
  cyan: '#6be0f7',
}

const BODY_TEXT_THRESHOLD = 4.5
const LARGE_TEXT_OR_UI_THRESHOLD = 3

function fmt(ratio: number): string {
  return ratio.toFixed(2).padStart(5)
}

function verdict(ratio: number, threshold: number): string {
  return ratio >= threshold ? 'PASS' : 'FAIL'
}

console.log(
  'Note: text-3 is used at caption size (11px), which is "small text" under WCAG, ' +
  'so the 4.5:1 body-text bar applies to it, not the 3:1 large-text bar — it is ' +
  'reported against both below, but 4.5:1 is the one that governs whether it ships. ' +
  'text-4 is disabled-only text, exempt from contrast requirements under WCAG 1.4.3; ' +
  'its numbers are reported for visibility, not as a pass/fail gate.\n'
)

console.log('== Body text (>=4.5:1) — text tones on graphite surfaces ==\n')
for (const [textName, textHex] of Object.entries(text)) {
  for (const [surfaceName, surfaceHex] of Object.entries(surfaces)) {
    const ratio = contrastRatio(textHex, surfaceHex)
    console.log(
      `${textName.padEnd(8)} on ${surfaceName.padEnd(11)} ${fmt(ratio)}:1  ${verdict(ratio, BODY_TEXT_THRESHOLD)} (4.5:1)  ${verdict(ratio, LARGE_TEXT_OR_UI_THRESHOLD)} (3:1)`
    )
  }
  console.log('')
}

console.log('== Accent / semantic colors on graphite surfaces (>=3:1 UI components) ==\n')
for (const [name, hex] of Object.entries(accentAndSemantic)) {
  for (const [surfaceName, surfaceHex] of Object.entries(surfaces)) {
    const ratio = contrastRatio(hex, surfaceHex)
    console.log(`${name.padEnd(12)} on ${surfaceName.padEnd(11)} ${fmt(ratio)}:1  ${verdict(ratio, LARGE_TEXT_OR_UI_THRESHOLD)} (3:1)`)
  }
  console.log('')
}

console.log('== Accent / semantic colors as text on graphite surfaces (>=4.5:1, e.g. status labels) ==\n')
for (const [name, hex] of Object.entries(accentAndSemantic)) {
  for (const [surfaceName, surfaceHex] of Object.entries(surfaces)) {
    const ratio = contrastRatio(hex, surfaceHex)
    console.log(`${name.padEnd(12)} on ${surfaceName.padEnd(11)} ${fmt(ratio)}:1  ${verdict(ratio, BODY_TEXT_THRESHOLD)} (4.5:1)`)
  }
  console.log('')
}

console.log('== Content painted directly on a solid --accent fill (13B: primary Button) ==\n')
const onAccentCandidates = { 'text-1': text['text-1'], 'bg-app': surfaces['bg-app'] }
for (const [name, hex] of Object.entries(onAccentCandidates)) {
  const r = contrastRatio(hex, accentAndSemantic.accent)
  console.log(`${name.padEnd(8)} on accent      ${fmt(r)}:1  ${verdict(r, BODY_TEXT_THRESHOLD)} (4.5:1)`)
}
console.log('\n--on-accent resolves to bg-app — the only one of the two that clears 4.5:1.\n')
