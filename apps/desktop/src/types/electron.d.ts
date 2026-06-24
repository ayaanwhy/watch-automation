import type { OpenFileOptions, BatchValidatePayload, BatchValidationResult, BatchLoadPayload, BatchLoadResult } from './ipc'

declare global {
  interface Window {
    api: {
      invoke(channel: 'dialog:openFolder'): Promise<string | null>
      invoke(channel: 'dialog:openFile', options: OpenFileOptions): Promise<string | null>
      invoke(channel: 'batch:validate', payload: BatchValidatePayload): Promise<BatchValidationResult>
      invoke(channel: 'batch:load', payload: BatchLoadPayload): Promise<BatchLoadResult>
    }
  }
}
