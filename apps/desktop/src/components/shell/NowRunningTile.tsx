import { Layers } from 'lucide-react'
import { usePreprocessingJob } from '../../context/PreprocessingJobContext'
import { useRingBraceletJob } from '../../context/RingBraceletJobContext'
import { useEarringJob } from '../../context/EarringJobContext'
import { ProgressRing } from '../ui/ProgressRing'
import { RingGlyph, BraceletGlyph, EarringGlyph, type IconComponent } from '../icons/ProductGlyphs'
import type { BatchDetailRecord } from '../../types/batch'
import type { ProgressState } from '../../context/useSubprocessJob'
import styles from './NowRunningTile.module.css'

interface NowRunningTileProps {
  preprocessBatch: BatchDetailRecord | null
  editingBatch: BatchDetailRecord | null
  onOpenBatch: (id: string) => void
}

interface RunningEntry {
  id: string
  title: string
  glyph: IconComponent
  progress: ProgressState
}

// Sidebar tile (Phase 13C, Decision 10) — "when any job is live... a
// compact glass tile shows product glyph, batch title, progress, and
// current image; clicking it jumps to the run workspace from anywhere."
// Derives its list straight from the three existing job contexts (no new
// IPC, no job logic) — Sidebar is already a descendant of all three
// providers (see App.tsx), so this component can read them directly.
// Watch has no subprocess job context (its own workflow is interactive
// annotation, not a background batch), so it never appears here.
export function NowRunningTile({ preprocessBatch, editingBatch, onOpenBatch }: NowRunningTileProps) {
  const preprocessingJob = usePreprocessingJob()
  const ringBraceletJob = useRingBraceletJob()
  const earringJob = useEarringJob()

  const editingProduct = editingBatch?.stages.find(s => s.type === 'editing')?.config['product']

  const entries: RunningEntry[] = []

  if (preprocessingJob.phase === 'running' && preprocessBatch) {
    entries.push({
      id: preprocessBatch.id,
      title: preprocessBatch.title,
      glyph: Layers,
      progress: preprocessingJob.progress,
    })
  }
  if (ringBraceletJob.phase === 'running' && editingBatch) {
    entries.push({
      id: editingBatch.id,
      title: editingBatch.title,
      glyph: editingProduct === 'bracelet' ? BraceletGlyph : RingGlyph,
      progress: ringBraceletJob.progress,
    })
  }
  if (earringJob.phase === 'running' && editingBatch) {
    entries.push({
      id: editingBatch.id,
      title: editingBatch.title,
      glyph: EarringGlyph,
      progress: earringJob.progress,
    })
  }

  if (entries.length === 0) return null

  return (
    <div className={styles.group}>
      {entries.map(entry => {
        const Glyph = entry.glyph
        const percent = entry.progress.total > 0 ? (entry.progress.completed / entry.progress.total) * 100 : undefined
        return (
          <button key={entry.id} className={styles.tile} onClick={() => onOpenBatch(entry.id)}>
            <ProgressRing value={percent} size={28} strokeWidth={2.5} className={styles.ring} />
            <Glyph size={16} strokeWidth={1.5} className={styles.glyph} />
            <span className={styles.info}>
              <span className={styles.title}>{entry.title}</span>
              <span className={styles.detail}>
                {entry.progress.currentImage ?? `${entry.progress.completed}/${entry.progress.total}`}
              </span>
            </span>
          </button>
        )
      })}
    </div>
  )
}
