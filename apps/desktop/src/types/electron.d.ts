import type {
  OpenFileOptions,
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
} from './ipc'

declare global {
  interface Window {
    api: {
      invoke(channel: 'dialog:openFolder'): Promise<string | null>
      invoke(channel: 'dialog:openFile', options: OpenFileOptions): Promise<string | null>
      invoke(channel: 'batch:validate', payload: BatchValidatePayload): Promise<BatchValidationResult>
      invoke(channel: 'batch:load', payload: BatchLoadPayload): Promise<BatchLoadResult>
      invoke(channel: 'session:save', payload: SessionSavePayload): Promise<SessionSaveResult>
      invoke(channel: 'session:load', payload: SessionLoadPayload): Promise<SessionLoadResult>
      invoke(channel: 'prefs:load-last-batch'): Promise<LastBatchPrefs>
      invoke(channel: 'prefs:save-last-batch', payload: LastBatchPrefs): Promise<void>
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
    }
  }
}
