import type {
  OpenFileOptions,
  OpenFolderOptions,
  BatchValidatePayload,
  BatchValidationResult,
  BatchLoadPayload,
  BatchLoadResult,
  SessionSavePayload,
  SessionSaveResult,
  SessionLoadPayload,
  SessionLoadResult,
  LastBatchPrefs,
  ProcessWatchPayload,
  ProcessWatchResult,
  QueueAddPayload,
  QueueItemPublic,
  QueueRestorePayload,
  PreprocessStartPayload,
  PreprocessStartResult,
  PreprocessEventPayload,
  PreprocessDonePayload,
  PreprocessResolveResult,
  SamTuningPrefs,
  UpscaleFactor,
  ProductType,
  PreprocessingFolderPrefs,
  PrepareForWatchProcessingPayload,
  PrepareForWatchProcessingResult,
  PrepareProgressPayload,
  BatchCreatePayload,
  BatchStageUpdatePayload,
  BatchRenamePayload,
  BatchFindWatchPayload,
  RingBraceletStartPayload,
  RingBraceletStartResult,
  RingBraceletEventPayload,
  RingBraceletDonePayload,
  RingBraceletFolderPrefs,
  RingBraceletFolderPrefsLoadPayload,
  RingBraceletFolderPrefsSavePayload,
} from './ipc'
import type { BatchDetailRecord, BatchSummaryRecord } from './batch'

declare global {
  interface Window {
    api: {
      invoke(channel: 'dialog:openFolder', options?: OpenFolderOptions): Promise<string | null>
      invoke(channel: 'dialog:openFile', options: OpenFileOptions): Promise<string | null>
      invoke(channel: 'batch:validate', payload: BatchValidatePayload): Promise<BatchValidationResult>
      invoke(channel: 'batch:load', payload: BatchLoadPayload): Promise<BatchLoadResult>
      invoke(channel: 'session:save', payload: SessionSavePayload): Promise<SessionSaveResult>
      invoke(channel: 'session:load', payload: SessionLoadPayload): Promise<SessionLoadResult>
      invoke(channel: 'prefs:load-last-batch'): Promise<LastBatchPrefs>
      invoke(channel: 'prefs:save-last-batch', payload: LastBatchPrefs): Promise<void>
      invoke(channel: 'prefs:load-sam-tuning'): Promise<SamTuningPrefs | null>
      invoke(channel: 'prefs:save-sam-tuning', payload: SamTuningPrefs): Promise<void>
      invoke(channel: 'prefs:load-upscale-factor'): Promise<UpscaleFactor | null>
      invoke(channel: 'prefs:save-upscale-factor', payload: UpscaleFactor): Promise<void>
      invoke(channel: 'prefs:load-product-type'): Promise<ProductType | null>
      invoke(channel: 'prefs:save-product-type', payload: ProductType): Promise<void>
      invoke(channel: 'prefs:load-preprocessing-folders'): Promise<PreprocessingFolderPrefs>
      invoke(channel: 'prefs:save-preprocessing-folders', payload: PreprocessingFolderPrefs): Promise<void>
      invoke(channel: 'process:watch', payload: ProcessWatchPayload): Promise<ProcessWatchResult>
      invoke(channel: 'queue:add', payload: QueueAddPayload): Promise<{ id: string }>
      invoke(channel: 'queue:retry', payload: { id: string }): Promise<{ ok: boolean }>
      invoke(channel: 'queue:get'): Promise<QueueItemPublic[]>
      invoke(channel: 'queue:restore', payload: QueueRestorePayload): Promise<void>
      on(channel: 'queue:update', listener: (items: QueueItemPublic[]) => void): () => void

      // Preprocessing
      invoke(channel: 'preprocess:start', payload: PreprocessStartPayload): Promise<PreprocessStartResult>
      invoke(channel: 'preprocess:cancel', payload: { jobId: string }): Promise<{ ok: boolean }>
      invoke(channel: 'preprocess:resolve-python'): Promise<PreprocessResolveResult>
      on(channel: 'preprocess:event', listener: (payload: PreprocessEventPayload) => void): () => void
      on(channel: 'preprocess:done', listener: (payload: PreprocessDonePayload) => void): () => void

      // Watch Processing hand-off preparation
      invoke(channel: 'preprocess:prepare-for-watch-processing', payload: PrepareForWatchProcessingPayload): Promise<PrepareForWatchProcessingResult>
      on(channel: 'preprocess:prepare-progress', listener: (payload: PrepareProgressPayload) => void): () => void

      // Batch registry (Phase 9B)
      invoke(channel: 'batch-registry:create', payload: BatchCreatePayload): Promise<BatchDetailRecord>
      invoke(channel: 'batch-registry:list'): Promise<BatchSummaryRecord[]>
      invoke(channel: 'batch-registry:get', payload: { id: string }): Promise<BatchDetailRecord | null>
      invoke(channel: 'batch-registry:update-stage', payload: BatchStageUpdatePayload): Promise<BatchDetailRecord | null>
      invoke(channel: 'batch-registry:rename', payload: BatchRenamePayload): Promise<BatchDetailRecord | null>
      invoke(channel: 'batch-registry:find-watch', payload: BatchFindWatchPayload): Promise<BatchDetailRecord | null>
      invoke(channel: 'batch-registry:delete', payload: { id: string }): Promise<boolean>

      // Ring & Bracelet asset generation (Phase 10C)
      invoke(channel: 'ring-bracelet:start', payload: RingBraceletStartPayload): Promise<RingBraceletStartResult>
      invoke(channel: 'ring-bracelet:cancel', payload: { jobId: string }): Promise<{ ok: boolean }>
      on(channel: 'ring-bracelet:event', listener: (payload: RingBraceletEventPayload) => void): () => void
      on(channel: 'ring-bracelet:done', listener: (payload: RingBraceletDonePayload) => void): () => void
      invoke(channel: 'prefs:load-ring-bracelet-folders', payload: RingBraceletFolderPrefsLoadPayload): Promise<RingBraceletFolderPrefs>
      invoke(channel: 'prefs:save-ring-bracelet-folders', payload: RingBraceletFolderPrefsSavePayload): Promise<void>
    }
  }
}
