import { Fragment, useEffect, useState } from 'react'
import { Select } from './ui/Select'
import { Button } from './ui/Button'
import { isPresetModified, resolveFactoryPreset } from '../constants/preprocessingPresets'
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
  onSave: (values: PreprocessingPresetValues) => void
}

// Settings-only editor for one preset's active values. Editing is a local
// draft (post-Phase-13 change): every field just updates `draft` in place —
// nothing persists, and the definition's version doesn't advance, until
// Save is explicitly pressed. "Reset to Default" also only resets the
// draft, for the same reason — it takes Save to actually apply.
export function PresetDefinitionEditor({ preset, definition, onSave }: PresetDefinitionEditorProps) {
  const { version, ...values } = definition
  const [draft, setDraft] = useState<PreprocessingPresetValues>(values)

  useEffect(() => {
    setDraft(values)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset, version])

  // "Modified" describes the persisted definition (unchanged meaning);
  // "dirty" is new — the draft has unsaved edits the Save button acts on.
  const modified = isPresetModified(preset, values)
  const draftDiffersFromFactory = isPresetModified(preset, draft)
  const dirty = (Object.keys(values) as (keyof PreprocessingPresetValues)[]).some(key => draft[key] !== values[key])

  function updateField<K extends keyof PreprocessingPresetValues>(key: K, value: PreprocessingPresetValues[K]) {
    setDraft(prev => ({ ...prev, [key]: value }))
  }

  function updateNumberField(spec: NumberFieldSpec, raw: string) {
    setDraft(prev => ({ ...prev, [spec.key]: raw === '' ? prev[spec.key] : (spec.isInt ? parseInt(raw) : parseFloat(raw)) }))
  }

  function commitNumberField(spec: NumberFieldSpec) {
    const parsed = draft[spec.key] as number
    if (!Number.isFinite(parsed)) {
      updateField(spec.key, values[spec.key])
      return
    }
    const clamped = Math.min(spec.max, Math.max(spec.min, parsed))
    if (clamped !== parsed) updateField(spec.key, clamped as PreprocessingPresetValues[typeof spec.key])
  }

  return (
    <div className={styles.editor}>
      <div className={styles.statusRow}>
        <span className={styles.version}>v{version}</span>
        <span className={modified ? styles.statusModified : styles.statusDefault}>
          {modified ? 'Modified' : 'Using factory defaults'}
        </span>
        {dirty && <span className={styles.statusDirty}>Unsaved changes</span>}
        <Button variant="secondary" size="sm" onClick={() => setDraft(resolveFactoryPreset(preset))} disabled={!draftDiffersFromFactory}>
          Reset to Default
        </Button>
        <Button variant="primary" size="sm" onClick={() => onSave(draft)} disabled={!dirty}>
          Save
        </Button>
      </div>

      <div className={styles.grid}>
        <label className={styles.label} htmlFor="preset-refine-foreground">Refine Foreground</label>
        <input
          id="preset-refine-foreground"
          className={styles.checkbox}
          type="checkbox"
          checked={draft.refineForeground}
          onChange={e => updateField('refineForeground', e.target.checked)}
        />

        <label className={styles.label}>Edge Mode</label>
        <div className={styles.selectWrap}>
          <Select
            options={EDGE_MODE_OPTIONS}
            value={draft.edgeMode}
            onChange={value => updateField('edgeMode', value)}
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
            onChange={e => updateField('maskThreshold', e.target.checked ? MASK_THRESHOLD_DEFAULT : null)}
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
              if (clamped !== draft.maskThreshold) updateField('maskThreshold', clamped)
            }}
          />
        </div>

        <label className={styles.label} htmlFor="preset-sam-multimask">SAM Multimask Output</label>
        <input
          id="preset-sam-multimask"
          className={styles.checkbox}
          type="checkbox"
          checked={draft.samMultimaskOutput}
          onChange={e => updateField('samMultimaskOutput', e.target.checked)}
        />
      </div>
    </div>
  )
}
