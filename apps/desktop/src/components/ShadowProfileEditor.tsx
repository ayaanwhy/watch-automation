import { Fragment, useEffect, useState } from 'react'
import { Button } from './ui/Button'
import { useShadowPreview } from '../hooks/useShadowPreview'
import { isShadowProfileModified } from '../constants/shadowProfiles'
import { toFileUrl } from '../lib/paths'
import type { ShadowProfileDefinition, ShadowProfileName, ShadowProfileValues } from '../constants/shadowProfiles'
import styles from './ShadowProfileEditor.module.css'

interface NumberFieldSpec {
  key: keyof ShadowProfileValues
  label: string
  min: number
  max: number
  step: number
  isInt: boolean
}

// canvas_base is deliberately excluded — it's a compositing-canvas sizing
// concern (Phase 12's headroom math), not a visual look-and-feel parameter,
// so it stays fixed per profile rather than becoming user-editable.
const NUMBER_FIELDS: NumberFieldSpec[] = [
  { key: 'x_offset',    label: 'Horizontal Offset', min: -200, max: 200, step: 1,    isInt: true },
  { key: 'y_offset',    label: 'Vertical Offset',   min: -200, max: 400, step: 1,    isInt: true },
  { key: 'blur_radius', label: 'Blur Radius',       min: 0,    max: 150, step: 1,    isInt: true },
  { key: 'spread',      label: 'Spread',            min: 0,    max: 100, step: 1,    isInt: true },
  { key: 'density',     label: 'Density',           min: 0,    max: 5,   step: 0.05, isInt: false },
  { key: 'opacity',     label: 'Opacity',           min: 0,    max: 1,   step: 0.01, isInt: false },
]

interface ShadowProfileEditorProps {
  name: ShadowProfileName
  definition: ShadowProfileDefinition
  onCommit: (values: ShadowProfileValues) => void
  onReset: () => void
}

// Settings-only editor for one shadow profile's active values, mirroring
// PresetDefinitionEditor.tsx's exact shape (commit-on-blur for numbers,
// immediate commit for checkbox/color, version + modified + reset row).
// canvas_base is intentionally not exposed — see NUMBER_FIELDS above.
export function ShadowProfileEditor({ name, definition, onCommit, onReset }: ShadowProfileEditorProps) {
  const { version, ...values } = definition
  const [draft, setDraft] = useState<ShadowProfileValues>(values)

  useEffect(() => {
    setDraft(values)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, version])

  const modified = isShadowProfileModified(name, values)
  const preview = useShadowPreview(draft)

  function commitField<K extends keyof ShadowProfileValues>(key: K, value: ShadowProfileValues[K]) {
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

      <div className={styles.layout}>
        <div className={styles.grid}>
          <label className={styles.label}>Color</label>
          <div className={styles.colorPair}>
            <input
              className={styles.colorSwatch}
              type="color"
              value={draft.color}
              onChange={e => commitField('color', e.target.value)}
            />
            <input
              className={styles.colorText}
              type="text"
              value={draft.color}
              spellCheck={false}
              onChange={e => setDraft(prev => ({ ...prev, color: e.target.value }))}
              onBlur={() => commitField('color', draft.color)}
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

          <label className={styles.label} htmlFor="shadow-horizontal-falloff">Horizontal Falloff</label>
          <input
            id="shadow-horizontal-falloff"
            className={styles.checkbox}
            type="checkbox"
            checked={draft.horizontal_falloff}
            onChange={e => commitField('horizontal_falloff', e.target.checked)}
          />
        </div>

        <div className={styles.previewPane}>
          <div className={styles.previewBox}>
            {preview.previewPath && (
              <img
                key={preview.previewPath}
                className={styles.previewImage}
                src={toFileUrl(preview.previewPath)}
                alt=""
              />
            )}
            {preview.rendering && <div className={styles.previewOverlay}>Rendering…</div>}
            {!preview.rendering && preview.error && (
              <div className={styles.previewOverlay}>{preview.error}</div>
            )}
          </div>
          <p className={styles.previewCaption}>
            Rendered with the real shadow engine on a white backdrop — not a CSS approximation.
          </p>
        </div>
      </div>
    </div>
  )
}
