import type { ReactNode } from 'react'
import styles from './BatchDetailsSection.module.css'

interface BatchDetailsSectionProps {
  title: string
  actions?: ReactNode
  children: ReactNode
}

// Generic section shell for a stage's Batch Details screen. Phase 9D ships
// only Overview + Images (Preprocessing); later phases add Logs, QA, Export,
// Analytics, Notes, etc. as more instances of this same shell — no
// redesign of the page required. Deliberately dark to match the rest of a
// stage's execution experience (Run + Batch Details share one visual
// language, mirroring Watch Processing's Annotation + Dashboard pairing).
export function BatchDetailsSection({ title, actions, children }: BatchDetailsSectionProps) {
  return (
    <section className={styles.section}>
      <div className={styles.header}>
        <h2 className={styles.title}>{title}</h2>
        {actions && <div className={styles.actions}>{actions}</div>}
      </div>
      <div className={styles.body}>{children}</div>
    </section>
  )
}
