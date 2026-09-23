import type { ReactNode, SVGProps } from 'react'

export interface ProductGlyphProps extends SVGProps<SVGSVGElement> {
  size?: number
}

// Shared "either a lucide icon or a product glyph" contract (Phase 13C) —
// a plain call signature, deliberately not React.ComponentType/FunctionComponent:
// those carry a static `propTypes` field typed against the full prop set
// (lucide's `size` accepts string|number; ProductGlyphProps' is number-only),
// and TS's structural check on that field rejects the union even though
// every real call site here only ever passes a number. A bare function type
// has no such field, so both component families satisfy it. Return type is
// ReactNode, not ReactElement — lucide's own render signature returns
// ReactNode (includes undefined), which is what its actual type declares.
export type IconComponent = (props: { size?: number; strokeWidth?: number; className?: string }) => ReactNode

// Shared shell every glyph below renders into — same viewBox, stroke width,
// and prop contract (size/className/color via currentColor) as
// lucide-react's own icon components, so a product glyph and a lucide icon
// are interchangeable at a call site (Phase 13 Decision 8: "drawn on the
// same stroke grid as the general icon set").
function GlyphBase({ size = 24, children, ...rest }: ProductGlyphProps & { children: ReactNode }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      {children}
    </svg>
  )
}

// Case + band + crown + hands.
export function WatchGlyph(props: ProductGlyphProps) {
  return (
    <GlyphBase {...props}>
      <circle cx="12" cy="12" r="6" />
      <path d="M12 9v3l2.5 0" />
      <path d="M18 11h1.5" />
      <path d="M10 2v5.7M14 2v5.7" />
      <path d="M10 22v-5.7M14 22v-5.7" />
    </GlyphBase>
  )
}

// Band + faceted stone.
export function RingGlyph(props: ProductGlyphProps) {
  return (
    <GlyphBase {...props}>
      <circle cx="12" cy="14.5" r="5.5" />
      <path d="M9 8L12 3l3 5-3 3-3-3z" />
    </GlyphBase>
  )
}

// Wide bangle with a beaded top edge.
export function BraceletGlyph(props: ProductGlyphProps) {
  return (
    <GlyphBase {...props}>
      <ellipse cx="12" cy="12" rx="8" ry="5" />
      <circle cx="8" cy="8.2" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="12" cy="7.3" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="16" cy="8.2" r="0.9" fill="currentColor" stroke="none" />
    </GlyphBase>
  )
}

// Stud + post + dangling hoop.
export function EarringGlyph(props: ProductGlyphProps) {
  return (
    <GlyphBase {...props}>
      <circle cx="12" cy="5" r="1.8" />
      <path d="M12 6.8v2.2" />
      <circle cx="12" cy="15" r="5.5" />
    </GlyphBase>
  )
}

// Draped chain + pendant.
export function NecklaceGlyph(props: ProductGlyphProps) {
  return (
    <GlyphBase {...props}>
      <path d="M4 5c0 7 4 10 8 10s8-3 8-10" />
      <path d="M12 15v1.4" />
      <circle cx="12" cy="18" r="1.6" />
    </GlyphBase>
  )
}

// Faceted gem — table + crown facets, on the same stroke grid as the other
// product glyphs (Phase 15.2, Sandbox's sixth product type).
export function GemstoneGlyph(props: ProductGlyphProps) {
  return (
    <GlyphBase {...props}>
      <path d="M7 9h10l-5 12L7 9z" />
      <path d="M4.5 9L7 4h10l2.5 5" />
      <path d="M7 9l2.5-5M17 9l-2.5-5M9.5 4l1 5M14.5 4l-1 5" />
    </GlyphBase>
  )
}
