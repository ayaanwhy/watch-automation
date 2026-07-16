import { PageHeader } from '../components/ui/PageHeader'
import { SettingsSection } from '../components/ui/SettingsSection'
import { Button } from '../components/ui/Button'
import { PythonInterpreterStatus } from '../components/PythonInterpreterStatus'
import { SamTuningPanel } from '../components/SamTuningPanel'
import { usePythonInterpreter } from '../hooks/usePythonInterpreter'
import { useSamTuning } from '../hooks/useSamTuning'
import styles from './Settings.module.css'

// Global Settings — a permanent, revisitable destination (not a modal).
// Built as a list of SettingsSections so future settings (Appearance, Default
// Folders, etc.) drop in as one more section with no structural redesign.
//
// Phase 9A hosts the two settings that exist today. The Preprocessing screen's
// own ⚙ SAM modal remains in place for now; both read/write the same persisted
// prefs. That transitional duplication is consolidated when Preprocessing is
// rebuilt in Phase 9C.
export default function Settings() {
  const python = usePythonInterpreter()
  const sam = useSamTuning()

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
            title="Segmentation (SAM 2)"
            description="Advanced preprocessing tuning. Overrides the pipeline defaults; leave untouched for standard results."
          >
            <SamTuningPanel prefs={sam.prefs} onUpdate={sam.update} />
          </SettingsSection>
        </div>
      </div>
    </div>
  )
}
