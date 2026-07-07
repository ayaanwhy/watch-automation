import type { ReactNode } from 'react'
import styles from './SettingsSection.module.css'

interface SettingsSectionProps {
  title: string
  description?: string
  children: ReactNode
}

// A labeled section within the global Settings screen. The Settings screen is
// deliberately a list of these so future settings (Appearance, Default Folders,
// etc.) drop in as one more section with no structural redesign.
export function SettingsSection({ title, description, children }: SettingsSectionProps) {
  return (
    <section className={styles.section}>
      <div className={styles.heading}>
        <h2 className={styles.title}>{title}</h2>
        {description && <p className={styles.description}>{description}</p>}
      </div>
      <div className={styles.body}>{children}</div>
    </section>
  )
}
