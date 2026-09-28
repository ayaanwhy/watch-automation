// The engine's structured job-state event bus. Transport-agnostic: the
// Electron IPC adapter subscribes and forwards to windows; a future API
// adapter would subscribe and stream/poll the very same state; a CLI could
// print it. Nothing in the engine knows or cares who is listening.
//
// Every event carries the FULL, persisted job state (a SandboxRunDetail) —
// listeners never have to merge partial deltas, and a late subscriber is
// exactly as informed as one that's been listening from the start.
import { EventEmitter } from 'node:events'
import type { SandboxRunDetail } from '../../../src/sandbox/types/sandboxRun'

export type AutomationJobState = SandboxRunDetail
export type JobProgressListener = (state: AutomationJobState) => void

const bus = new EventEmitter()
bus.setMaxListeners(100)
const JOB_STATE = 'job-state'

export function publishJobState(state: AutomationJobState): void {
  bus.emit(JOB_STATE, state)
}

// Subscribe to every job's updates, or only one job's (pass jobId).
// Returns an unsubscribe function.
export function subscribeToJobProgress(listener: JobProgressListener, jobId?: string): () => void {
  const wrapped: JobProgressListener = state => {
    if (jobId === undefined || state.id === jobId) listener(state)
  }
  bus.on(JOB_STATE, wrapped)
  return () => bus.off(JOB_STATE, wrapped)
}
