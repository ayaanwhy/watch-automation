// Main-process single-flight FIFO (Phase 15.0) — runs at most one async job
// at a time, queuing anything requested while busy rather than dropping or
// overlapping it. This is the *authoritative* concurrency arbiter for
// boundary-detection requests (see boundaryDetection.ts): the watchdialcoord
// API cannot tolerate concurrent requests without hanging the entire
// service (reproduced directly during Phase 14C/14D). The earlier fix put
// the guarantee inside AnnotationContext.tsx (a React component) — correct
// for Legacy's own UX bookkeeping, but insufficient once Sandbox's headless
// Watch runner needs to call the same detection service from the main
// process without going through that component at all. Every caller
// (Legacy's boundary:detect IPC handler, Sandbox's headless runner calling
// the service directly) now shares this one instance instead.
//
// Deliberately unkeyed (unlike AnnotationContext.tsx's per-SKU
// SingleFlightQueue<K>, which also caches "do we already have a result for
// this key") — that renderer-side class solves a different problem (avoid
// re-fetching a SKU that already resolved, track per-SKU UI status). This
// one solves "never send two requests to this API at once," full stop, so
// every job just runs in the order it arrived — no de-duplication, no
// caching, just strict FIFO serialization.
export class SingleFlightQueue {
  private queue: Array<() => Promise<void>> = []
  private draining = false

  /** Enqueues `job`; resolves/rejects with exactly what `job()` does, once it's had its turn. */
  run<T>(job: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push(async () => {
        try {
          resolve(await job())
        } catch (err) {
          reject(err)
        }
      })
      void this.drain()
    })
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      while (this.queue.length > 0) {
        const task = this.queue.shift()!
        await task()
      }
    } finally {
      this.draining = false
    }
  }
}
