import { useState } from 'react'
import { PageHeader } from '../components/ui/PageHeader'
import { SettingsSection } from '../components/ui/SettingsSection'
import { Button } from '../components/ui/Button'
import { Select } from '../components/ui/Select'
import { PythonInterpreterStatus } from '../components/PythonInterpreterStatus'
import { PresetDefinitionEditor } from '../components/PresetDefinitionEditor'
import { usePythonInterpreter } from '../hooks/usePythonInterpreter'
import { usePreprocessingPresetDefinitions } from '../hooks/usePreprocessingPresetDefinitions'
import { PREPROCESSING_PRESET_OPTIONS, DEFAULT_PREPROCESSING_PRESET } from '../constants/preprocessingPresets'
import type { PreprocessingPreset } from '../constants/preprocessingPresets'
import styles from './Settings.module.css'

// Global Settings — a permanent, revisitable destination (not a modal).
// Built as a list of SettingsSections so future settings (Appearance, Default
// Folders, etc.) drop in as one more section with no structural redesign.
export default function Settings() {
  const python = usePythonInterpreter()
  const presetDefs = usePreprocessingPresetDefinitions()
  const [editingPreset, setEditingPreset] = useState<PreprocessingPreset>(DEFAULT_PREPROCESSING_PRESET)

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
            title="Python Interpreter"
            description="Used by the Preprocessing pipeline. Auto-detected; override only if needed."
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
            title="Preprocessing Presets"
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
        </div>
      </div>
    </div>
  )
}
