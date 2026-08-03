import { Fragment, useEffect, useState } from 'react'
import { Select } from './ui/Select'
import { Button } from './ui/Button'
import { isPresetModified } from '../constants/preprocessingPresets'
import type { PreprocessingPreset, PreprocessingPresetDefinition, PreprocessingPresetValues } from '../constants/preprocessingPresets'
import styles from './PresetDefinitionEditor.module.css'

const EDGE_MODE_OPTIONS: { value: PreprocessingPresetValues['edgeMode']; label: string }[] = [
  { value: 'none',    label: 'None' },
  { value: 'sharpen', label: 'Sharpen' },
  { value: 'crisp',   label: 'Crisp' },
  { value: 'soften',  label: 'Soften' },
]

interface NumberFieldSpec {
  key: keyof PreprocessingPresetValues
  label: string
  min: number
  max: number
  step: number
  isInt: boolean
}

// Every numeric field on PreprocessingPresetValues except maskThreshold,
// which gets its own enable/disable + number pairing below (it's the only
// nullable field).
const NUMBER_FIELDS: NumberFieldSpec[] = [
  { key: 'analysisLongestSide',   label: 'Analysis Longest Side',    min: 64, max: 4096, step: 32,  isInt: true },
  { key: 'maskBlur',              label: 'Mask Blur',                min: 0,  max: 50,   step: 1,   isInt: true },
  { key: 'maskOffset',            label: 'Mask Offset',              min: -50, max: 50,  step: 1,   isInt: true },
  { key: 'maskContrast',          label: 'Mask Contrast',            min: 0.1, max: 3,   step: 0.01, isInt: false },
  { key: 'maskAntialiasScale',    label: 'Mask Antialias Scale',     min: 1,  max: 4,    step: 1,   isInt: true },
  { key: 'edgeStrength',          label: 'Edge Strength',            min: 0,  max: 5,    step: 0.1, isInt: false },
  { key: 'alphaSharpen',          label: 'Alpha Sharpen',            min: 0,  max: 5,    step: 0.1, isInt: false },
  { key: 'samMaxImageSize',       label: 'SAM Max Image Size',       min: 64, max: 4096, step: 32,  isInt: true },
  { key: 'samPointsPerSide',      label: 'SAM Points/Side',          min: 1,  max: 64,   step: 1,   isInt: true },
  { key: 'samPointsPerBatch',     label: 'SAM Points/Batch',         min: 1,  max: 256,  step: 1,   isInt: true },
  { key: 'samPredIouThresh',      label: 'SAM Pred IoU Threshold',   min: 0,  max: 1,    step: 0.01, isInt: false },
  { key: 'samStabilityScoreThresh', label: 'SAM Stability Score',    min: 0,  max: 1,    step: 0.01, isInt: false },
  { key: 'samMaxMasks',           label: 'SAM Max Masks',            min: 1,  max: 256,  step: 1,   isInt: true },
]

const MASK_THRESHOLD_DEFAULT = 0.5

interface PresetDefinitionEditorProps {
  preset: PreprocessingPreset
  definition: PreprocessingPresetDefinition
  onCommit: (values: PreprocessingPresetValues) => void
  onReset: () => void
}

// Settings-only editor for one preset's active values. Commits number/text
// fields on blur (not per-keystroke) so the definition's version — meant as
// lightweight provenance, not a per-character change counter — only
// advances once per completed edit. Checkboxes and selects commit
// immediately, since a single change event is already the whole edit.
export function PresetDefinitionEditor({ preset, definition, onCommit, onReset }: PresetDefinitionEditorProps) {
  const { version, ...values } = definition
  const [draft, setDraft] = useState<PreprocessingPresetValues>(values)

  useEffect(() => {
    setDraft(values)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset, version])

  const modified = isPresetModified(preset, values)

  function commitField<K extends keyof PreprocessingPresetValues>(key: K, value: PreprocessingPresetValues[K]) {
    if (values[key] === value) return
    const next = { ...draft, [key]: value }
    setDraft(next)
    onCommit(next)
  }

  function updateNumberField(spec: NumberFieldSpec, raw: string) {
    setDraft(prev => ({ ...prev, [spec.key]: raw === '' ? prev[spec.key] : (spec.isInt ? parseInt(raw) : parseFloat(raw)) }))
  }

  function commitNumberField(spec: NumberFieldSpec) {
    const parsed = draft[spec.key] as number
    const clamped = Number.isFinite(parsed) ? Math.min(spec.max, Math.max(spec.min, parsed)) : (values[spec.key] as number)
    commitField(spec.key, clamped)
  }

  return (
    <div className={styles.editor}>
      <div className={styles.statusRow}>
        <span className={styles.version}>v{version}</span>
        <span className={modified ? styles.statusModified : styles.statusDefault}>
          {modified ? 'Modified' : 'Using factory defaults'}
        </span>
        <Button variant="secondary" size="sm" onClick={onReset} disabled={!modified}>
          Reset to Default
        </Button>
      </div>

      <div className={styles.grid}>
        <label className={styles.label} htmlFor="preset-refine-foreground">Refine Foreground</label>
        <input
          id="preset-refine-foreground"
          className={styles.checkbox}
          type="checkbox"
          checked={draft.refineForeground}
          onChange={e => commitField('refineForeground', e.target.checked)}
        />

        <label className={styles.label}>Edge Mode</label>
        <div className={styles.selectWrap}>
          <Select
            options={EDGE_MODE_OPTIONS}
            value={draft.edgeMode}
            onChange={value => commitField('edgeMode', value)}
          />
        </div>

        {NUMBER_FIELDS.map(spec => (
          <Fragment key={spec.key}>
            <label className={styles.label}>{spec.label}</label>
            <input
              className={styles.input}
              type="number"
              min={spec.min}
              max={spec.max}
              step={spec.step}
              value={draft[spec.key] as number}
              onChange={e => updateNumberField(spec, e.target.value)}
              onBlur={() => commitNumberField(spec)}
            />
          </Fragment>
        ))}

        <label className={styles.label} htmlFor="preset-mask-threshold-enabled">Mask Threshold</label>
        <div className={styles.thresholdPair}>
          <input
            id="preset-mask-threshold-enabled"
            className={styles.checkbox}
            type="checkbox"
            checked={draft.maskThreshold !== null}
            onChange={e => commitField('maskThreshold', e.target.checked ? MASK_THRESHOLD_DEFAULT : null)}
          />
          <input
            className={styles.input}
            type="number"
            min={0}
            max={1}
            step={0.01}
            disabled={draft.maskThreshold === null}
            value={draft.maskThreshold ?? MASK_THRESHOLD_DEFAULT}
            onChange={e => setDraft(prev => ({ ...prev, maskThreshold: e.target.value === '' ? prev.maskThreshold : parseFloat(e.target.value) }))}
            onBlur={() => {
              if (draft.maskThreshold === null) return
              const clamped = Number.isFinite(draft.maskThreshold) ? Math.min(1, Math.max(0, draft.maskThreshold)) : (values.maskThreshold ?? MASK_THRESHOLD_DEFAULT)
              commitField('maskThreshold', clamped)
            }}
          />
        </div>

        <label className={styles.label} htmlFor="preset-sam-multimask">SAM Multimask Output</label>
        <input
          id="preset-sam-multimask"
          className={styles.checkbox}
          type="checkbox"
          checked={draft.samMultimaskOutput}
          onChange={e => commitField('samMultimaskOutput', e.target.checked)}
        />
      </div>
    </div>
  )
}
