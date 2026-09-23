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
  QueueAddPayload,
  QueueItemPublic,
  QueueRestorePayload,
  PreprocessStartPayload,
  PreprocessStartResult,
  PreprocessEventPayload,
  PreprocessDonePayload,
  PreprocessResolveResult,
  UpscaleFactor,
  ProductType,
  PreprocessingFolderPrefs,
  EditingHandoffPayload,
  EditingHandoffResult,
  EditingHandoffOptionsPrefs,
  PrepareProgressPayload,
  BatchCreatePayload,
  BatchStageUpdatePayload,
  BatchRenamePayload,
  BatchSetModePayload,
  BatchFindWatchPayload,
  BatchFindEditingPayload,
  BatchSetImageNeedsFixingPayload,
  BatchSetHoopSplitPayload,
  RingBraceletStartPayload,
  RingBraceletStartResult,
  RingBraceletEventPayload,
  RingBraceletDonePayload,
  RingBraceletFolderPrefs,
  RingBraceletFolderPrefsLoadPayload,
  RingBraceletFolderPrefsSavePayload,
  RingBraceletValidatePayload,
  PreprocessingPresetDefinitionSavePayload,
  ProductMetadataLoadPayload,
  ProductMetadataLoadResult,
  EarringStartPayload,
  EarringStartResult,
  EarringEventPayload,
  EarringDonePayload,
  EarringFolderPrefs,
  EarringValidatePayload,
  AppearancePrefs,
  ShadowProfileDefinitionSavePayload,
  ShadowPreviewRenderPayload,
  ShadowPreviewRenderResult,
  ThumbnailGetPayload,
  ThumbnailGetResult,
  BoundaryDetectPayload,
  BoundaryDetectResult,
} from './ipc'
import type { BatchDetailRecord, BatchSummaryRecord } from './batch'
import type {
  PreprocessingPreset,
  PreprocessingPresetDefinition,
  PreprocessingPresetDefinitions,
} from '../constants/preprocessingPresets'
import type {
  ShadowProfileDefinition,
  ShadowProfileDefinitions,
} from '../constants/shadowProfiles'
import type { SandboxTemporaryBatchDetail, SandboxTemporaryBatchSummary } from '../sandbox/types/sandboxTemporaryBatch'

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
      invoke(channel: 'prefs:load-preprocessing-preset'): Promise<PreprocessingPreset | null>
      invoke(channel: 'prefs:save-preprocessing-preset', payload: PreprocessingPreset): Promise<void>
      invoke(channel: 'prefs:load-preprocessing-preset-definitions'): Promise<PreprocessingPresetDefinitions>
      invoke(channel: 'prefs:save-preprocessing-preset-definition', payload: PreprocessingPresetDefinitionSavePayload): Promise<PreprocessingPresetDefinition>
      invoke(channel: 'prefs:load-upscale-factor'): Promise<UpscaleFactor | null>
      invoke(channel: 'prefs:save-upscale-factor', payload: UpscaleFactor): Promise<void>
      invoke(channel: 'prefs:load-product-type'): Promise<ProductType | null>
      invoke(channel: 'prefs:save-product-type', payload: ProductType): Promise<void>
      invoke(channel: 'prefs:load-preprocessing-folders'): Promise<PreprocessingFolderPrefs>
      invoke(channel: 'prefs:save-preprocessing-folders', payload: PreprocessingFolderPrefs): Promise<void>
      invoke(channel: 'queue:add', payload: QueueAddPayload): Promise<{ id: string }>
      invoke(channel: 'queue:retry', payload: { id: string }): Promise<{ ok: boolean }>
      invoke(channel: 'queue:restore', payload: QueueRestorePayload): Promise<void>
      on(channel: 'queue:update', listener: (items: QueueItemPublic[]) => void): () => void

      // Preprocessing
      invoke(channel: 'preprocess:start', payload: PreprocessStartPayload): Promise<PreprocessStartResult>
      invoke(channel: 'preprocess:cancel', payload: { jobId: string }): Promise<{ ok: boolean }>
      invoke(channel: 'preprocess:resolve-python'): Promise<PreprocessResolveResult>
      on(channel: 'preprocess:event', listener: (payload: PreprocessEventPayload) => void): () => void
      on(channel: 'preprocess:done', listener: (payload: PreprocessDonePayload) => void): () => void

      // Preprocessing → Editing hand-off preparation (Phase 10F)
      invoke(channel: 'preprocess:prepare-for-editing-handoff', payload: EditingHandoffPayload): Promise<EditingHandoffResult>
      on(channel: 'preprocess:prepare-progress', listener: (payload: PrepareProgressPayload) => void): () => void
      invoke(channel: 'prefs:load-editing-handoff-options'): Promise<EditingHandoffOptionsPrefs | null>
      invoke(channel: 'prefs:save-editing-handoff-options', payload: EditingHandoffOptionsPrefs): Promise<void>

      // Batch registry (Phase 9B)
      invoke(channel: 'batch-registry:create', payload: BatchCreatePayload): Promise<BatchDetailRecord>
      invoke(channel: 'batch-registry:list'): Promise<BatchSummaryRecord[]>
      invoke(channel: 'batch-registry:get', payload: { id: string }): Promise<BatchDetailRecord | null>
      invoke(channel: 'batch-registry:update-stage', payload: BatchStageUpdatePayload): Promise<BatchDetailRecord | null>
      invoke(channel: 'batch-registry:rename', payload: BatchRenamePayload): Promise<BatchDetailRecord | null>
      invoke(channel: 'batch-registry:set-mode', payload: BatchSetModePayload): Promise<BatchDetailRecord | null>
      invoke(channel: 'batch-registry:find-watch', payload: BatchFindWatchPayload): Promise<BatchDetailRecord | null>
      invoke(channel: 'batch-registry:find-editing', payload: BatchFindEditingPayload): Promise<BatchDetailRecord | null>
      invoke(channel: 'batch-registry:set-image-needs-fixing', payload: BatchSetImageNeedsFixingPayload): Promise<BatchDetailRecord | null>
      invoke(channel: 'batch-registry:set-hoop-split', payload: BatchSetHoopSplitPayload): Promise<BatchDetailRecord | null>
      invoke(channel: 'batch-registry:delete', payload: { id: string }): Promise<boolean>

      // Ring & Bracelet asset generation (Phase 10C)
      invoke(channel: 'ring-bracelet:start', payload: RingBraceletStartPayload): Promise<RingBraceletStartResult>
      invoke(channel: 'ring-bracelet:cancel', payload: { jobId: string }): Promise<{ ok: boolean }>
      on(channel: 'ring-bracelet:event', listener: (payload: RingBraceletEventPayload) => void): () => void
      on(channel: 'ring-bracelet:done', listener: (payload: RingBraceletDonePayload) => void): () => void
      invoke(channel: 'prefs:load-ring-bracelet-folders', payload: RingBraceletFolderPrefsLoadPayload): Promise<RingBraceletFolderPrefs>
      invoke(channel: 'prefs:save-ring-bracelet-folders', payload: RingBraceletFolderPrefsSavePayload): Promise<void>
      invoke(channel: 'ring-bracelet:validate-input', payload: RingBraceletValidatePayload): Promise<BatchValidationResult>

      // Generic product metadata (Phase 12B) — first consumed by Earring's
      // setup screen below (Phase 12C).
      invoke(channel: 'product-metadata:load', payload: ProductMetadataLoadPayload): Promise<ProductMetadataLoadResult>

      // Earring asset generation (Phase 12C)
      invoke(channel: 'earring:start', payload: EarringStartPayload): Promise<EarringStartResult>
      invoke(channel: 'earring:cancel', payload: { jobId: string }): Promise<{ ok: boolean }>
      on(channel: 'earring:event', listener: (payload: EarringEventPayload) => void): () => void
      on(channel: 'earring:done', listener: (payload: EarringDonePayload) => void): () => void
      invoke(channel: 'prefs:load-earring-folders'): Promise<EarringFolderPrefs>
      invoke(channel: 'prefs:save-earring-folders', payload: EarringFolderPrefs): Promise<void>
      invoke(channel: 'earring:validate-input', payload: EarringValidatePayload): Promise<BatchValidationResult>

      // Shadow profiles (Phase 13H)
      invoke(channel: 'prefs:load-shadow-profile-definitions'): Promise<ShadowProfileDefinitions>
      invoke(channel: 'prefs:save-shadow-profile-definition', payload: ShadowProfileDefinitionSavePayload): Promise<ShadowProfileDefinition>
      invoke(channel: 'shadow-preview:render', payload: ShadowPreviewRenderPayload): Promise<ShadowPreviewRenderResult>

      // Appearance (Phase 13H)
      invoke(channel: 'prefs:load-appearance'): Promise<AppearancePrefs>
      invoke(channel: 'prefs:save-appearance', payload: AppearancePrefs): Promise<void>

      // Review-sidebar thumbnails (Item 6, post-Phase-13 polish)
      invoke(channel: 'thumbnail:get', payload: ThumbnailGetPayload): Promise<ThumbnailGetResult>

      // Watch AI boundary detection (Phase 14B)
      invoke(channel: 'boundary:detect', payload: BoundaryDetectPayload): Promise<BoundaryDetectResult>
      invoke(channel: 'prefs:load-boundary-endpoint'): Promise<string | null>
      invoke(channel: 'prefs:save-boundary-endpoint', payload: string | null): Promise<void>

      // Sandbox Temporary Batch access (Phase 15.2) — read-only, backed by
      // MockSandboxApiClient for now (see electron/sandbox/sandboxApiClient.ts).
      invoke(channel: 'sandbox:list-temporary-batches'): Promise<SandboxTemporaryBatchSummary[]>
      invoke(channel: 'sandbox:get-temporary-batch-detail', payload: { id: string }): Promise<SandboxTemporaryBatchDetail | null>
    }
  }
}
