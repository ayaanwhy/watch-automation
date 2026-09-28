import { AlertTriangle, PackageSearch } from 'lucide-react'
import { Card } from '../../components/ui/Card'
import { EmptyState } from '../../components/ui/EmptyState'
import type { SandboxTemporaryBatchSummary } from '../types/sandboxTemporaryBatch'
import { SANDBOX_PRODUCT_GLYPHS, sortSandboxProductTypes } from '../constants/productDisplay'
import styles from './TemporaryBatchPicker.module.css'

interface TemporaryBatchPickerProps<T extends SandboxTemporaryBatchSummary> {
  batches: T[]
  loading: boolean
  error: string | null
  selectedId: string | null
  onSelect: (id: string) => void
  onRetry: () => void
  // Optional extra line of facts under a batch's image count (used by the
  // development-only local test source to show status/date).
  describe?: (batch: T) => string | null
  emptyMessage?: string
}

// The Sandbox batch picker (Phase 15.2) — lists Temporary Batches sourced
// through the Sandbox API abstraction (currently MockSandboxApiClient), one
// selectable Card per batch. No thumbnails: the mock data's imagePath
// fields are intentionally empty (no real files back them), so this shows
// only what the API contract actually provides — name, product types,
// image count.
export function TemporaryBatchPicker<T extends SandboxTemporaryBatchSummary>({
  batches,
  loading,
  error,
  selectedId,
  onSelect,
  onRetry,
  describe,
  emptyMessage,
}: TemporaryBatchPickerProps<T>) {
  if (loading) {
    return <div className={styles.loadingRow}>Loading Temporary Batches…</div>
  }

  if (error) {
    return (
      <EmptyState icon={AlertTriangle} message={error} actionLabel="Retry" onAction={onRetry} />
    )
  }

  if (batches.length === 0) {
    return (
      <EmptyState
        icon={PackageSearch}
        message={emptyMessage ?? "No Temporary Batches are available right now."}
        actionLabel="Retry"
        onAction={onRetry}
      />
    )
  }

  return (
    <div className={styles.list}>
      {batches.map(batch => (
        <Card
          key={batch.id}
          onClick={() => onSelect(batch.id)}
          className={batch.id === selectedId ? styles.selected : undefined}
          aria-label={`Select Temporary Batch ${batch.name}`}
        >
          <div className={styles.item}>
            <div className={styles.itemMain}>
              <span className={styles.itemName}>{batch.name}</span>
              <span className={styles.itemMeta}>
                {batch.imageCount} image{batch.imageCount === 1 ? '' : 's'}
              </span>
              {describe && describe(batch) && <span className={styles.itemMeta}>{describe(batch)}</span>}
            </div>
            <div className={styles.glyphRow}>
              {sortSandboxProductTypes(batch.productTypes).map(productType => {
                const Glyph = SANDBOX_PRODUCT_GLYPHS[productType]
                return <Glyph key={productType} size={18} strokeWidth={1.5} className={styles.glyph} />
              })}
            </div>
          </div>
        </Card>
      ))}
    </div>
  )
}
