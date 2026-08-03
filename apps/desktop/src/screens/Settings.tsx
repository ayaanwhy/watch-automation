import { useState } from 'react'
import { PageHeader } from '../components/ui/PageHeader'
import { SettingsSection } from '../components/ui/SettingsSection'
import { Button } from '../components/ui/Button'
import { Select } from '../components/ui/Select'
import { SegmentedControl } from '../components/ui/SegmentedControl'
import { PythonInterpreterStatus } from '../components/PythonInterpreterStatus'
import { PresetDefinitionEditor } from '../components/PresetDefinitionEditor'
import { ShadowProfileEditor } from '../components/ShadowProfileEditor'
import { usePythonInterpreter } from '../hooks/usePythonInterpreter'
import { usePreprocessingPresetDefinitions } from '../hooks/usePreprocessingPresetDefinitions'
import { useShadowProfileDefinitions } from '../hooks/useShadowProfileDefinitions'
import { useAppearancePrefs } from '../hooks/useAppearancePrefs'
import { PREPROCESSING_PRESET_OPTIONS, DEFAULT_PREPROCESSING_PRESET } from '../constants/preprocessingPresets'
import { SHADOW_PROFILE_OPTIONS, DEFAULT_SHADOW_PROFILES } from '../constants/shadowProfiles'
import type { PreprocessingPreset } from '../constants/preprocessingPresets'
import type { ShadowProfileName } from '../constants/shadowProfiles'
import type { AppearanceOverride } from '../types/ipc'
import styles from './Settings.module.css'

const REDUCED_MOTION_OPTIONS: { value: AppearanceOverride; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'on', label: 'Reduced' },
  { value: 'off', label: 'Full' },
]

const REDUCED_TRANSPARENCY_OPTIONS: { value: AppearanceOverride; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'on', label: 'Reduced' },
  { value: 'off', label: 'Full' },
]

const AMBIENT_INTENSITY_OPTIONS: { value: 'off' | 'subtle' | 'standard'; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'subtle', label: 'Subtle' },
  { value: 'standard', label: 'Standard' },
]

// Global Settings — a permanent, revisitable destination (not a modal).
// Built as a list of SettingsSections so future settings drop in as one more
// section with no structural redesign (Phase 13H: General / Presets /
// Shadow Profiles / Appearance).
export default function Settings() {
  const python = usePythonInterpreter()
  const presetDefs = usePreprocessingPresetDefinitions()
  const [editingPreset, setEditingPreset] = useState<PreprocessingPreset>(DEFAULT_PREPROCESSING_PRESET)
  const shadowDefs = useShadowProfileDefinitions()
  const [editingShadowProfile, setEditingShadowProfile] = useState<ShadowProfileName>(SHADOW_PROFILE_OPTIONS[0].value)
  const appearance = useAppearancePrefs()

  return (
    <div className={styles.page}>
      <div className={styles.container}>
        <PageHeader
          sticky
          title="Settings"
          subtitle="Application-wide configuration."
        />

        <div className={styles.sections}>
          <SettingsSection
            title="General"
            description="Python interpreter used by the Preprocessing pipeline. Auto-detected; override only if needed."
          >
            <PythonInterpreterStatus
              resolvedPath={python.resolvedPath}
              resolving={python.resolving}
              override={python.override}
              onOverrideChange={python.setOverride}
            />
            <div className={styles.actionRow}>
              <Button
                variant="secondary"
                size="sm"
                onClick={python.refresh}
                disabled={python.resolving}
              >
                {python.resolving ? 'Detecting…' : 'Re-detect'}
              </Button>
            </div>
          </SettingsSection>

          <SettingsSection
            title="Presets"
            description="Fast, Balanced, and Quality configure the entire preprocessing pipeline. Define what each one means here; the Preprocessing screen only selects between them per batch."
          >
            <Select
              label="Editing"
              options={PREPROCESSING_PRESET_OPTIONS}
              value={editingPreset}
              onChange={setEditingPreset}
            />
            {presetDefs.loaded && (
              <PresetDefinitionEditor
                preset={editingPreset}
                definition={presetDefs.definitions[editingPreset]}
                onCommit={values => void presetDefs.saveValues(editingPreset, values)}
                onReset={() => presetDefs.resetToDefault(editingPreset)}
              />
            )}
          </SettingsSection>

          <SettingsSection
            title="Shadow Profiles"
            description="The drop-shadow look Ring & Bracelet and Earring bake into frontImage. Reset returns a profile to the exact values shadow.py ships with — every batch that never touches this section already uses them unmodified."
          >
            <Select
              label="Editing"
              options={SHADOW_PROFILE_OPTIONS.map(o => ({ value: o.value, label: o.label }))}
              value={editingShadowProfile}
              onChange={setEditingShadowProfile}
            />
            {shadowDefs.loaded && (
              <ShadowProfileEditor
                name={editingShadowProfile}
                definition={shadowDefs.definitions[editingShadowProfile]}
                onCommit={values => void shadowDefs.saveValues(editingShadowProfile, values)}
                onReset={() => void shadowDefs.saveValues(editingShadowProfile, DEFAULT_SHADOW_PROFILES[editingShadowProfile])}
              />
            )}
          </SettingsSection>

          <SettingsSection
            title="Appearance"
            description="Motion, transparency, and ambient background intensity. System defers to your OS accessibility settings."
          >
            {appearance.loaded && (
              <>
                <SegmentedControl
                  label="Reduced Motion"
                  options={REDUCED_MOTION_OPTIONS}
                  value={appearance.prefs.reducedMotion}
                  onChange={value => appearance.savePrefs({ ...appearance.prefs, reducedMotion: value })}
                />
                <SegmentedControl
                  label="Reduced Transparency"
                  options={REDUCED_TRANSPARENCY_OPTIONS}
                  value={appearance.prefs.reducedTransparency}
                  onChange={value => appearance.savePrefs({ ...appearance.prefs, reducedTransparency: value })}
                />
                <SegmentedControl
                  label="Ambient Background Intensity"
                  options={AMBIENT_INTENSITY_OPTIONS}
                  value={appearance.prefs.ambientIntensity}
                  onChange={value => appearance.savePrefs({ ...appearance.prefs, ambientIntensity: value })}
                />
              </>
            )}
          </SettingsSection>
        </div>
      </div>
    </div>
  )
}
