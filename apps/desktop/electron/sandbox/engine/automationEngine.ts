// The Automation Engine's transport-agnostic interface.
//
//   Sandbox / Electron UI / CLI / future API
//                  |
//        AutomationEngine (this file)
//                  |
//   job lifecycle - persistence - orchestration - progress - errors
//                  |
//     ProcessingBackend (local today) -> Python / AI services
//
// Callers speak ONLY in these terms: create a job, start it, read its state,
// subscribe to structured progress, cancel it, fetch its result artifacts.
// Nothing here knows whether the caller is an Electron window, an HTTP
// adapter or a script — and nothing here needs a React component to exist.
// Job state is a SandboxRunDetail: the persisted SandboxRun record IS the
// job (see ../../../src/sandbox/types/sandboxRun.ts), enriched with
// per-image stages, structured failures and timestamps.
import {
  cancelSandboxRun,
  createJob,
  recoverInterruptedJobs,
  retryImage,
  startJob,
  type CreateJobResult,
  type RetryImageResult,
} from '../sandboxOrchestrator'
import { getSandboxRun, listSandboxRuns } from '../sandboxRunRegistry'
import { subscribeToJobProgress, type AutomationJobState, type JobProgressListener } from './events'
import type { SandboxRunSummary } from '../../../src/sandbox/types/sandboxRun'
import type { SandboxTemporaryBatchDetail } from '../../../src/sandbox/types/sandboxTemporaryBatch'
import type { SandboxUniversalConfig } from '../../../src/sandbox/types/sandboxUniversalConfig'
import type { SandboxProductType } from '../../../src/sandbox/types/sandboxProduct'
import type { SandboxPostProcessingArtifactRecord } from '../../../src/sandbox/types/sandboxRun'
import type { AutomationError } from '../../../src/sandbox/types/automationError'

export type { AutomationJobState, JobProgressListener, CreateJobResult, RetryImageResult }

export interface AutomationJobArtifacts {
  jobId: string
  products: {
    productType: SandboxProductType
    status: AutomationJobState['pipelines'][number]['status']
    // The directory holding this product's FINAL post-processed images, once
    // (and only once) post-processing genuinely completed.
    finalArtifactDir: string | null
    // Non-image results (dimensions.csv, measurements.xlsx, ...) — distinct
    // from images, never disguised as one.
    metadataArtifacts: SandboxPostProcessingArtifactRecord[]
    failure: AutomationError | null
  }[]
}

export interface AutomationEngine {
  // Validates + preflights + persists a job (status 'draft') with its full
  // per-image plan. Nothing executes yet. No job is created on failure.
  createJob(batch: SandboxTemporaryBatchDetail, config: SandboxUniversalConfig): Promise<CreateJobResult>
  // Begins executing a created job in the background; resolves immediately.
  startJob(jobId: string): Promise<{ ok: boolean; error?: string; failure?: AutomationError }>
  // createJob + startJob.
  submitJob(batch: SandboxTemporaryBatchDetail, config: SandboxUniversalConfig): Promise<CreateJobResult>
  // The latest persisted state — the source of truth, valid after any
  // client reload/restart.
  getJobState(jobId: string): Promise<AutomationJobState | null>
  listJobs(): Promise<SandboxRunSummary[]>
  // Live structured updates (each carries the full state). Returns
  // unsubscribe. jobId omitted = every job.
  subscribeToJobProgress(listener: JobProgressListener, jobId?: string): () => void
  // Cooperative: queued work never starts; in-flight work finishes;
  // completed work is never relabelled.
  cancelJob(jobId: string): Promise<{ ok: boolean }>
  getJobArtifacts(jobId: string): Promise<AutomationJobArtifacts | null>
  // Re-runs ONE failed image of an existing job — same runners, queues and
  // SingleFlight rules as a normal run — from the stage boundary its own
  // persisted state says it failed at, reusing upstream artifacts that
  // exist. Successful images are never touched. Resolves as soon as the
  // image is reset and running; progress then streams like any image.
  retryImage(jobId: string, productType: SandboxProductType, sku: string): Promise<RetryImageResult>
  // Records jobs left in-flight by a dead engine process as interrupted.
  recoverInterruptedJobs(): Promise<string[]>
}

export const automationEngine: AutomationEngine = {
  createJob,
  startJob,
  async submitJob(batch, config) {
    const created = await createJob(batch, config)
    if (!created.ok || !created.runId) return created
    const started = await startJob(created.runId)
    return started.ok ? created : { ok: false, runId: created.runId, error: started.error, failure: started.failure }
  },
  getJobState: jobId => getSandboxRun(jobId),
  listJobs: () => listSandboxRuns(),
  subscribeToJobProgress,
  cancelJob: cancelSandboxRun,
  async getJobArtifacts(jobId) {
    const run = await getSandboxRun(jobId)
    if (!run) return null
    return {
      jobId,
      products: run.pipelines.map(p => ({
        productType: p.productType,
        status: p.status,
        finalArtifactDir: p.status === 'completed' ? (p.postProcessingOutputDir ?? null) : null,
        metadataArtifacts: (p.postProcessingArtifacts ?? []).filter(a => a.kind === 'measurementData'),
        failure: p.failure ?? null,
      })),
    }
  },
  retryImage,
  recoverInterruptedJobs,
}
