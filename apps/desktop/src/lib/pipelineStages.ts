import { CANONICAL_PIPELINE_STAGES, type StageSegment } from '../components/ui/StageTracker'

// Real stage-event keys the Universal Preprocessing runner emits (see
// preprocessing/UBG/electron_runner.py's `_stage()` calls) — position-wise
// aligned with StageTracker's CANONICAL_PIPELINE_STAGES labels. Only
// meaningful for the Preprocessing job: Ring/Bracelet/Earring's editing
// stage has its own, much simpler pipeline with no such 5-step breakdown
// (their progress.currentStage is always null), so callers that pass null
// here naturally get an all-pending tracker rather than a misleading one.
const PIPELINE_STAGE_KEYS = ['upscale', 'birefnet', 'sam', 'plugin', 'save']

// Derives StageTracker segment statuses from a job's raw `currentStage`
// string — the one place this mapping lives, shared by the Dashboard's Now
// zone (Phase 13D) and the run workspace's rich progress panel (Phase 13F)
// so the two can never drift into showing different stage breakdowns for
// the same job. Deliberately not part of StageTracker itself (see that
// component's own doc comment) — it stays a pure presentational primitive
// with no NDJSON/job knowledge.
export function buildStageSegments(currentStage: string | null): StageSegment[] {
  const idx = currentStage ? PIPELINE_STAGE_KEYS.indexOf(currentStage) : -1
  return CANONICAL_PIPELINE_STAGES.map((label, i) => ({
    label,
    status: idx === -1 ? 'pending' : i < idx ? 'done' : i === idx ? 'active' : 'pending',
  }))
}
