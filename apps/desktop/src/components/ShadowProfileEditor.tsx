import { Fragment, useEffect, useState } from 'react'
import { Button } from './ui/Button'
import { useShadowPreview } from '../hooks/useShadowPreview'
import { isShadowProfileModified, DEFAULT_SHADOW_PROFILES } from '../constants/shadowProfiles'
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
  onSave: (values: ShadowProfileValues) => void
}

// Settings-only editor for one shadow profile's active values, mirroring
// PresetDefinitionEditor.tsx's exact shape: editing is a local draft, no
// field persists (or bumps the version) until Save is explicitly pressed.
// The live preview (useShadowPreview) still tracks the draft continuously —
// only persistence is gated, not the render-as-you-type feedback loop.
// canvas_base is intentionally not exposed — see NUMBER_FIELDS above.
export function ShadowProfileEditor({ name, definition, onSave }: ShadowProfileEditorProps) {
  const { version, ...values } = definition
  const [draft, setDraft] = useState<ShadowProfileValues>(values)

  useEffect(() => {
    setDraft(values)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, version])

  const modified = isShadowProfileModified(name, values)
  const draftDiffersFromFactory = isShadowProfileModified(name, draft)
  const dirty = (Object.keys(values) as (keyof ShadowProfileValues)[]).some(key => draft[key] !== values[key])
  const preview = useShadowPreview(draft)

  function updateField<K extends keyof ShadowProfileValues>(key: K, value: ShadowProfileValues[K]) {
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
    if (clamped !== parsed) updateField(spec.key, clamped as ShadowProfileValues[typeof spec.key])
  }

  return (
    <div className={styles.editor}>
      <div className={styles.statusRow}>
        <span className={styles.version}>v{version}</span>
        <span className={modified ? styles.statusModified : styles.statusDefault}>
          {modified ? 'Modified' : 'Using factory defaults'}
        </span>
        {dirty && <span className={styles.statusDirty}>Unsaved changes</span>}
        <Button variant="secondary" size="sm" onClick={() => setDraft(DEFAULT_SHADOW_PROFILES[name])} disabled={!draftDiffersFromFactory}>
          Reset to Default
        </Button>
        <Button variant="primary" size="sm" onClick={() => onSave(draft)} disabled={!dirty}>
          Save
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
              onChange={e => updateField('color', e.target.value)}
            />
            <input
              className={styles.colorText}
              type="text"
              value={draft.color}
              spellCheck={false}
              onChange={e => setDraft(prev => ({ ...prev, color: e.target.value }))}
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

          {/* Watch's own shadow engine (shadowEngine.ts) has no proportional
              falloff concept — the flag would be a no-op there, so it's
              hidden rather than shown-but-inert (see constants/shadowProfiles.ts). */}
          {name !== 'watch' && (
            <>
              <label className={styles.label} htmlFor="shadow-horizontal-falloff">Horizontal Falloff</label>
              <input
                id="shadow-horizontal-falloff"
                className={styles.checkbox}
                type="checkbox"
                checked={draft.horizontal_falloff}
                onChange={e => updateField('horizontal_falloff', e.target.checked)}
              />
            </>
          )}
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
