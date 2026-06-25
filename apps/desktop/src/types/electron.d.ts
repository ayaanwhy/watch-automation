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
    }
  }
}
