import type { LaunchableModule } from '../types/navigation'
import { PageHeader } from '../components/ui/PageHeader'
import { Card } from '../components/ui/Card'
import styles from './ModuleSelector.module.css'

interface ModuleDescriptor {
  id: LaunchableModule
  title: string
  description: string
}

// Add a module by appending here — see types/navigation.ts and Sidebar.tsx.
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

// The Home landing content. Phase 9A reskins it onto the shared design system;
// Phase 9B evolves it into an execution-history view above these launchers.
export default function ModuleSelector({ onSelect }: ModuleSelectorProps) {
  return (
    <div className={styles.page}>
      <div className={styles.container}>
        <PageHeader title="Home" subtitle="Choose a module to get started." />

        <div className={styles.grid}>
          {MODULES.map(module => (
            <Card key={module.id} onClick={() => onSelect(module.id)} aria-label={module.title}>
              <span className={styles.cardTitle}>{module.title}</span>
              <span className={styles.cardDescription}>{module.description}</span>
            </Card>
          ))}
        </div>
      </div>
    </div>
  )
}
