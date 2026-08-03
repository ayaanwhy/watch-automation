import { Check, X } from 'lucide-react'
import styles from './StageTracker.module.css'

export type StageSegmentStatus = 'pending' | 'active' | 'done' | 'error'

export interface StageSegment {
  label: string
  status: StageSegmentStatus
}

// The canonical five stages, in order, per Component System / Resolved
// Decision 11 ("Upscale → Background Removal → Segmentation → Plugin →
// Save"). Exported so 13F's real wiring (deriving each segment's status
// from the NDJSON `stage`/`heartbeat` events — stage is a free-form string
// there, not a strict union, so that mapping is the caller's job, not this
// component's) can build its segment list off one shared source of labels.
export const CANONICAL_PIPELINE_STAGES = ['Upscale', 'Background Removal', 'Segmentation', 'Plugin', 'Save'] as const

interface StageTrackerProps {
  segments: StageSegment[]
  className?: string
}

// Per-image pipeline tracker (Phase 13B) — five segments connected by a
// line, each showing pending/active/done/error. Purely presentational: it
// renders whatever segment statuses the caller derived from real stage
// events; no NDJSON/job knowledge lives here. Consumed starting 13F (run
// workspaces' right rail).
export function StageTracker({ segments, className }: StageTrackerProps) {
  return (
    <ol className={[styles.tracker, className].filter(Boolean).join(' ')}>
      {segments.map((segment, i) => (
        <li key={segment.label} className={styles.segment} data-status={segment.status}>
          <span className={styles.node}>
            {segment.status === 'done' && <Check size={12} strokeWidth={2} aria-hidden="true" />}
            {segment.status === 'error' && <X size={12} strokeWidth={2} aria-hidden="true" />}
            {segment.status === 'active' && <span className={styles.activeDot} aria-hidden="true" />}
          </span>
          <span className={styles.label}>{segment.label}</span>
          {i < segments.length - 1 && <span className={styles.connector} aria-hidden="true" />}
        </li>
      ))}
    </ol>
  )
}
