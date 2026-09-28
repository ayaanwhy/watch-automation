// Phase 15.3 — waits for a specific subprocess-backed job's completion via
// subprocessRunner.ts's mainProcessJobEvents, filtering by jobId (several
// jobs across different products can be in flight on different done
// channels at once). This is the one place the Sandbox orchestrator
// bridges "a runner reports completion by emitting an event" into "an
// async function the orchestrator can await" — no polling, no IPC.
import { mainProcessJobEvents } from '../services/subprocessRunner'

interface DoneLike {
  jobId: string
}

export function waitForJobDone<T extends DoneLike>(doneChannel: string, jobId: string): Promise<T> {
  return new Promise<T>(resolve => {
    function handler(payload: T) {
      if (payload.jobId !== jobId) return
      mainProcessJobEvents.off(doneChannel, handler)
      resolve(payload)
    }
    mainProcessJobEvents.on(doneChannel, handler)
  })
}

// Observes a running job's per-image NDJSON events (the same events the
// Legacy renderer's live job contexts consume — 'progress'/'complete'/
// 'error') from the main process, filtered by jobId. Events that arrive
// before the jobId is known (start() resolves after the process has
// already begun emitting) are buffered and replayed, so nothing is lost.
// The runners are single-flight per channel, so this only ever sees the
// one job the caller started.
export function observeJobEvents(
  eventChannel: string,
  onEvent: (event: Record<string, unknown>) => void,
): { setJobId: (jobId: string) => void; stop: () => void } {
  let jobId: string | null = null
  const buffered: Record<string, unknown>[] = []
  function handler(payload: Record<string, unknown>) {
    if (jobId === null) {
      buffered.push(payload)
      return
    }
    if (payload['jobId'] === jobId) onEvent(payload)
  }
  mainProcessJobEvents.on(eventChannel, handler)
  return {
    setJobId(id) {
      jobId = id
      for (const e of buffered.splice(0)) if (e['jobId'] === id) onEvent(e)
    },
    stop() {
      mainProcessJobEvents.off(eventChannel, handler)
    },
  }
}
