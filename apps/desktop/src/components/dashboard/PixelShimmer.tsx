import styles from './PixelShimmer.module.css'

// Sparse grid cells, each on its own offset, so they never pulse in unison —
// deliberately not evenly filled (Design Language, Decision 7: "sparse grid
// cells that occasionally breathe"). Positions are a fixed 12-column,
// 4-row virtual grid so the layout is stable across renders, not
// randomized per-mount.
const CELLS: { col: number; row: number; delayMs: number; durationMs: number }[] = [
  { col: 2,  row: 1, delayMs: 0,    durationMs: 4200 },
  { col: 6,  row: 2, delayMs: 900,  durationMs: 3800 },
  { col: 10, row: 1, delayMs: 1600, durationMs: 4600 },
  { col: 4,  row: 3, delayMs: 400,  durationMs: 4000 },
  { col: 8,  row: 4, delayMs: 2000, durationMs: 3600 },
  { col: 12, row: 3, delayMs: 1200, durationMs: 4400 },
  { col: 1,  row: 4, delayMs: 2600, durationMs: 3900 },
  { col: 3,  row: 2, delayMs: 1800, durationMs: 4300 },
  { col: 9,  row: 2, delayMs: 300,  durationMs: 4100 },
  { col: 11, row: 4, delayMs: 2200, durationMs: 3700 },
]

// Pixel-shimmer motif (Decision 7: "used sparingly: dashboard hero/idle
// moments and empty states only. Never on Stage surfaces, never during
// runs.") — this component's only mount site is Home.tsx's idle "Now" zone,
// exactly the case the decision names, and only while no job is running.
// Purely decorative (aria-hidden), CSS-driven (no animation library):
// collapses under prefers-reduced-motion the same way AmbientBackground
// does, and scales with the same --ambient-intensity Settings > Appearance
// control (Phase 13H) since it's part of the same ambient system, not a
// separate one.
export function PixelShimmer() {
  return (
    <div className={styles.grid} aria-hidden="true">
      {CELLS.map((cell, i) => (
        <span
          key={i}
          className={styles.cell}
          style={{
            gridColumn: cell.col,
            gridRow: cell.row,
            animationDelay: `${cell.delayMs}ms`,
            animationDuration: `${cell.durationMs}ms`,
          }}
        />
      ))}
    </div>
  )
}
