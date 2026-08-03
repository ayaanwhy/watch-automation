import styles from './HeartbeatPulse.module.css'

interface HeartbeatPulseProps {
  // Caller-supplied label, e.g. "GPU busy" — this primitive has no opinion
  // on wording, only the pulse affordance itself.
  label?: string
  className?: string
}

// Heartbeat-driven "still alive" pulse (Phase 13B) — per Component System,
// "a heartbeat-driven 'GPU busy' pulse so long BiRefNet stages read as
// alive, not hung." Purely presentational: rendering this at all means the
// caller has recently received a `heartbeat` NDJSON event (that liveness
// decision belongs to 13F's real wiring, not here).
export function HeartbeatPulse({ label, className }: HeartbeatPulseProps) {
  return (
    <span className={[styles.pulse, className].filter(Boolean).join(' ')}>
      <span className={styles.dot} aria-hidden="true" />
      {label && <span className={styles.label}>{label}</span>}
    </span>
  )
}
