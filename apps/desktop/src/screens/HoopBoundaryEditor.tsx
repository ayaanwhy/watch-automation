import { useEffect, useState } from 'react'
import { ArrowLeft, Images } from 'lucide-react'
import { ThumbnailGrid, type ThumbnailGridImage } from '../components/shared/ThumbnailGrid'
import { HoopSplitEditor } from '../components/earring/HoopSplitEditor'
import { EmptyState } from '../components/ui/EmptyState'
import { Button } from '../components/ui/Button'
import { usePythonInterpreter } from '../hooks/usePythonInterpreter'
import { useEarringJob } from '../context/EarringJobContext'
import { joinPath, toFileUrl } from '../lib/paths'
// Shares RunWorkspace's layout stylesheet (Phase 11C/10D/12C) — same
// preview+sidebar shape as every other live/interactive editing screen.
import workspaceStyles from '../components/shared/RunWorkspace.module.css'
import styles from './HoopBoundaryEditor.module.css'

interface HoopBoundaryEditorProps {
  batchId: string
  onBack: () => void
}

// New-SKU default (Phase 12E, explicit requirement) — the visual starting
// position only; nothing is persisted until the operator actually places a
// split (HoopSplitEditor.onChange fires on pointer-up, never on mount), so
// merely viewing an unplaced SKU does not silently count it as placed.
const CENTERED_SPLIT = 0.5

// Purpose-built Hoop Manual boundary-placement screen (Phase 12E). Always
// loads its own state from the batch registry by batchId alone — the same
// data-loading path whether this is a fresh entry (just navigated here from
// EditingSetup) or a resumed one (batch reopened from Home after an
// interruption) — there is no separate "resume" code path to drift from the
// normal one. See EditingSetup.tsx's EarringFields.handleStart for how
// config.hoopSkus/hoopSplits are first seeded, and batchRegistry.setHoopSplit
// for how each placement is persisted immediately.
export default function HoopBoundaryEditor({ batchId, onBack }: HoopBoundaryEditorProps) {
  const [loading, setLoading] = useState(true)
  const [inputDir, setInputDir] = useState('')
  const [outputDir, setOutputDir] = useState('')
  const [metadataFilePath, setMetadataFilePath] = useState('')
  const [hoopSkus, setHoopSkus] = useState<string[]>([])
  const [splits, setSplits] = useState<Record<string, number>>({})
  const [selectedSku, setSelectedSku] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const python = usePythonInterpreter()
  const job = useEarringJob()

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    window.api.invoke('batch-registry:get', { id: batchId }).then(detail => {
      if (cancelled || !detail) return
      const stage = detail.stages.find(s => s.type === 'editing')
      const skus = (stage?.config['hoopSkus'] as string[] | undefined) ?? []
      setInputDir(stage?.inputDir ?? '')
      setOutputDir(stage?.outputDir ?? '')
      setMetadataFilePath((stage?.config['metadataFilePath'] as string | undefined) ?? '')
      setHoopSkus(skus)
      setSplits((stage?.config['hoopSplits'] as Record<string, number> | undefined) ?? {})
      setSelectedSku(prev => prev ?? skus[0] ?? null)
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [batchId])

  // Electron generates --splits-file at job-start time from whatever's
  // persisted here — this call is the only thing that ever writes
  // config.hoopSplits; the renderer stays state-only (Phase 12E approved
  // architecture), just reflecting back whatever the registry now holds.
  async function handleSplitChange(sku: string, splitX: number) {
    const detail = await window.api.invoke('batch-registry:set-hoop-split', {
      id: batchId,
      stageType: 'editing',
      sku,
      splitX,
    })
    const stage = detail?.stages.find(s => s.type === 'editing')
    if (stage) setSplits((stage.config['hoopSplits'] as Record<string, number> | undefined) ?? {})
  }

  async function handleRun() {
    if (starting || !python.isValid) return
    setStarting(true)
    const overridePath = python.override.trim()
    await job.start({
      inputDir,
      outputDir,
      batchId,
      metadataFilePath,
      processingMode: 'manual',
      ...(overridePath !== '' ? { pythonPath: overridePath } : {}),
    })
    setStarting(false)
  }

  if (loading) {
    return <div className={styles.loading}>Loading…</div>
  }

  const placedCount = hoopSkus.filter(sku => splits[sku] !== undefined).length
  const unplacedCount = hoopSkus.length - placedCount
  const gridImages: ThumbnailGridImage[] = hoopSkus.map(sku => ({
    name: `${sku}.png`,
    status: splits[sku] !== undefined ? 'completed' : 'pending',
  }))
  const selectedSrc = selectedSku ? toFileUrl(joinPath(inputDir, `${selectedSku}.png`)) : null

  return (
    <div className={workspaceStyles.workspace}>
      <div className={workspaceStyles.previewArea}>
        {selectedSrc && selectedSku ? (
          <HoopSplitEditor
            key={selectedSku}
            imageSrc={selectedSrc}
            splitX={splits[selectedSku] ?? CENTERED_SPLIT}
            onChange={splitX => handleSplitChange(selectedSku, splitX)}
          />
        ) : (
          <div className={styles.empty}>
            <EmptyState icon={Images} message="No Hoop SKUs to place." />
          </div>
        )}
      </div>
      <div className={workspaceStyles.sidebar}>
        <div className={styles.header}>
          <button className={styles.backButton} onClick={onBack}>
            <ArrowLeft size={14} strokeWidth={1.5} aria-hidden="true" /> Back
          </button>
          <div className={styles.title}>Hoop Boundaries</div>
          <div className={styles.count}>{placedCount} of {hoopSkus.length} placed</div>
        </div>
        {unplacedCount > 0 && (
          <p className={styles.hint}>
            {unplacedCount} hoop{unplacedCount === 1 ? '' : 's'} without a split will fail individually when run — the rest of the batch is unaffected.
          </p>
        )}
        {job.startError && <div className={styles.errorBanner}>{job.startError}</div>}
        <Button variant="primary" onClick={handleRun} loading={starting} disabled={!python.isValid}>
          Run
        </Button>
        <div className={workspaceStyles.gridArea}>
          <ThumbnailGrid
            images={gridImages}
            inputDir={inputDir}
            selectedImage={selectedSku ? `${selectedSku}.png` : null}
            onSelect={name => setSelectedSku(name.replace(/\.png$/, ''))}
          />
        </div>
      </div>
    </div>
  )
}
