import type { LaunchableModule } from '../types/navigation'
import styles from './ModuleSelector.module.css'

interface ModuleDescriptor {
  id: LaunchableModule
  title: string
  description: string
}

// Add a module by appending here — see types/navigation.ts.
const MODULES: ModuleDescriptor[] = [
  {
    id: 'preprocessing',
    title: 'Preprocessing',
    description: 'Prepare raw product imagery — background removal, segmentation, and upscaling.',
  },
  {
    id: 'watch',
    title: 'Watch Processing',
    description: 'Match, annotate, and export a batch of measured watch images.',
  },
]

interface ModuleSelectorProps {
  onSelect: (module: LaunchableModule) => void
}

export default function ModuleSelector({ onSelect }: ModuleSelectorProps) {
  return (
    <div className={styles.page}>
      <div className={styles.container}>
        <h1 className={styles.title}>Watch Automation</h1>
        <p className={styles.subtitle}>Choose a module to get started.</p>

        <div className={styles.grid}>
          {MODULES.map(module => (
            <button key={module.id} className={styles.card} onClick={() => onSelect(module.id)}>
              <span className={styles.cardTitle}>{module.title}</span>
              <span className={styles.cardDescription}>{module.description}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
