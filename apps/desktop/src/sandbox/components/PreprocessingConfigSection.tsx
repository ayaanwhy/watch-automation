import { Card } from '../../components/ui/Card'
import { SegmentedControl } from '../../components/ui/SegmentedControl'
import { Select } from '../../components/ui/Select'
import { SnapSlider } from '../../components/SnapSlider'
import { ROTATION_OPTIONS } from '../../constants/rotation'
import type { SandboxPreprocessOperationChoice, SandboxPreprocessingConfig, SandboxUpscaleFactor } from '../types/sandboxUniversalConfig'
import styles from './ConfigSection.module.css'

interface PreprocessingConfigSectionProps {
  config: SandboxPreprocessingConfig
  onChange: (next: SandboxPreprocessingConfig) => void
}

const OPERATION_OPTIONS: { value: SandboxPreprocessOperationChoice; label: string }[] = [
  { value: 'both', label: 'Background Removal + Upscaling' },
  { value: 'background_removal', label: 'Background Removal Only' },
  { value: 'upscale', label: 'Upscaling Only' },
  // Sandbox-only (Phase 15.1) — Legacy's OperationsChoice has no equivalent
  // value and must never gain one.
  { value: 'none', label: 'None' },
]

// Real factors only — upscaling is switched on/off by the Operation choice
// above, not by a "None" factor.
const UPSCALE_OPTIONS: { value: SandboxUpscaleFactor; label: string }[] = [
  { value: 2, label: '2×' },
  { value: 4, label: '4×' },
]

const DEFAULT_RESIZE_HEIGHT = 1000

// Sandbox Preprocessing configuration (Phase 15.2) — reuses Legacy's
// existing preprocessing concepts (operation choice, upscale factor,
// optional Trim/Rotate/Resize mini-configuration from
// workflowPreparation.ts's prepareForEditingHandoff) plus the Sandbox-only
// 'None' operation (Phase 15.1) and the shared RotationDegrees rotation
// operation in place of Legacy's axis-aligned EditingHandoffRotate. This
// only stores configuration — nothing here executes it (that's 15.3).
export function PreprocessingConfigSection({ config, onChange }: PreprocessingConfigSectionProps) {
  const includesUpscale = config.operation === 'both' || config.operation === 'upscale'

  return (
    <Card className={styles.card}>
      <h3 className={styles.title}>Preprocessing</h3>

      <Select
        label="Operation"
        options={OPERATION_OPTIONS}
        value={config.operation}
        onChange={operation => onChange({ ...config, operation })}
      />
      {config.operation === 'none' && (
        <p className={styles.note}>
          Sandbox-only: copies images through unmodified and proceeds directly to Editing. No background removal
          or upscaling runs.
        </p>
      )}

      <SnapSlider
        label="Upscale Factor"
        options={UPSCALE_OPTIONS}
        value={config.upscaleFactor}
        onChange={upscaleFactor => onChange({ ...config, upscaleFactor })}
        disabled={!includesUpscale}
      />

      <label className={styles.checkboxRow}>
        <input type="checkbox" checked={config.trim} onChange={e => onChange({ ...config, trim: e.target.checked })} />
        Trim to non-transparent bounds
      </label>

      <SegmentedControl
        label="Rotate"
        options={ROTATION_OPTIONS}
        value={config.rotate}
        onChange={rotate => onChange({ ...config, rotate })}
      />

      <label className={styles.checkboxRow}>
        <input
          type="checkbox"
          checked={config.resizeToHeight !== null}
          onChange={e => onChange({ ...config, resizeToHeight: e.target.checked ? DEFAULT_RESIZE_HEIGHT : null })}
        />
        Resize to fixed height
      </label>
      {config.resizeToHeight !== null && (
        <input
          type="number"
          className={styles.numberInput}
          value={config.resizeToHeight}
          min={1}
          onChange={e => onChange({ ...config, resizeToHeight: Number(e.target.value) })}
          aria-label="Resize height in pixels"
        />
      )}
    </Card>
  )
}
