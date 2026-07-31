// Job-context factory (Phase 12C) — extracts the boilerplate that was
// ~100% duplicated between PreprocessingJobContext.tsx and
// RingBraceletJobContext.tsx on top of the already-shared useSubprocessJob
// (Phase 11C): context creation, the "must be used within its Provider"
// accessor hook, and the event/done IPC subscription effect. Both existing
// contexts were migrated onto this at the same time it was introduced —
// see their own files for what (nothing, behaviorally) changed.
//
// Deliberately mechanical: this is NOT a redesign. Each existing context's
// exact public shape — including RingBraceletJobContext's start() returning
// Promise<void> (discarding useSubprocessJob's native boolean) vs
// PreprocessingJobContext's start() returning that Promise<boolean>
// straight through — is preserved by leaving `buildValue` a caller-supplied
// function, not a factory-decided behavior. The factory only owns wiring
// that was already byte-for-byte identical between the two.
import { createContext, useContext, useEffect, type ReactNode, type ReactElement } from 'react'
import {
  useSubprocessJob,
  type BaseImageState,
  type BaseDonePayload,
  type UseSubprocessJobConfig,
  type SubprocessJobHandle,
} from './useSubprocessJob'

export interface JobContextFactoryOptions<
  TImage extends BaseImageState,
  TStart,
  TDone extends BaseDonePayload,
  TValue,
> {
  // Preserved verbatim from each existing context's own throw — not
  // regenerated from some other option, so the exact message a caller might
  // already be relying on (e.g. in an error boundary or a test) is unchanged.
  hookErrorMessage: string
  eventChannel: string
  doneChannel: string
  jobConfig: UseSubprocessJobConfig<TImage, TStart, TDone>
  // Shapes the raw useSubprocessJob handle into this context's own public
  // value type. This is where RingBraceletJobContext's start()-wrapping
  // (and any other per-context difference) lives — the factory itself is
  // agnostic to it.
  buildValue: (job: SubprocessJobHandle<TImage, TStart, TDone>) => TValue
}

export interface JobContextInstance<TValue> {
  useJob: () => TValue
  Provider: (props: { children: ReactNode }) => ReactElement
}

export function createJobContext<
  TImage extends BaseImageState,
  TStart,
  TDone extends BaseDonePayload,
  TValue,
>(options: JobContextFactoryOptions<TImage, TStart, TDone, TValue>): JobContextInstance<TValue> {
  const Context = createContext<TValue | null>(null)

  function useJob(): TValue {
    const ctx = useContext(Context)
    if (!ctx) throw new Error(options.hookErrorMessage)
    return ctx
  }

  function Provider({ children }: { children: ReactNode }) {
    const job = useSubprocessJob<TImage, TStart, TDone>(options.jobConfig)

    useEffect(() => {
      // window.api.on's type is a closed overload set keyed by literal
      // channel-name strings (see types/electron.d.ts) — a generic factory
      // can't statically name which overload applies, so the channel name
      // and its payload are necessarily untyped at this one boundary. Every
      // other line here is exactly as type-safe as the code it replaces.
      const onApi = window.api.on as (channel: string, listener: (payload: { jobId: string }) => void) => () => void
      const offEvent = onApi(options.eventChannel, (payload) => {
        if (payload.jobId !== job.jobIdRef.current) return
        job.dispatchEvent(payload as unknown as Record<string, unknown>)
      })
      const offDone = onApi(options.doneChannel, (payload) => {
        if (payload.jobId !== job.jobIdRef.current) return
        job.dispatchDone(payload as unknown as TDone)
      })
      return () => {
        offEvent()
        offDone()
      }
    }, [job])

    const value = options.buildValue(job)

    return <Context.Provider value={value}>{children}</Context.Provider>
  }

  return { useJob, Provider }
}
