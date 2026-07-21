// Structured application logging (Phase 11F) — one NDJSON-formatted line per
// entry, consistent with the NDJSON convention already used for the Python
// pipeline protocol elsewhere in this app. Intended for troubleshooting and
// development, not normal operators — there is no in-app log viewer.
//
// Backward-compatible with every existing call site: `context` and the
// third `err`/`context` positions are optional additions, not new
// requirements — logger.info('x'), logger.warn('x', err), and
// logger.error('x', err) all still work exactly as before.
import { app } from 'electron'
import { appendFile, mkdir, readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'

// How long a daily log file is kept before being pruned at the next
// startup — see pruneOldLogs. Each day already gets its own file (see
// logFilePath), so this is the whole rotation policy: no size-based
// mid-day rotation, which this app's log volume has never warranted.
const LOG_RETENTION_DAYS = 14

function logsDir(): string {
  return join(app.getPath('userData'), 'logs')
}

function logFilePath(): string {
  return join(logsDir(), `wpa-${new Date().toISOString().slice(0, 10)}.log`)
}

let dirReady = false

export interface LogContext {
  [key: string]: unknown
}

function write(level: string, message: string, err?: unknown, context?: LogContext): void {
  const entry: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    message,
  }
  if (context) Object.assign(entry, context)
  if (err !== undefined) {
    if (err instanceof Error) {
      entry.error = err.message
      // Stack traces were never captured before Phase 11F — only
      // err.message was — losing exactly the information most useful for
      // tracking an error back to its source.
      if (err.stack) entry.stack = err.stack
    } else {
      entry.error = String(err)
    }
  }

  const line = JSON.stringify(entry) + '\n'
  const doWrite = (): void => { void appendFile(logFilePath(), line, 'utf-8').catch(() => {}) }

  if (dirReady) {
    doWrite()
  } else {
    void mkdir(logsDir(), { recursive: true })
      .then(() => { dirReady = true; doWrite() })
      .catch(() => {})
  }
}

export const logger = {
  // Developer-only detail (raw subprocess stderr, per-job resource
  // snapshots, etc.) — verbose enough that it would drown out real
  // signal at info/warn level, but still written to disk since these
  // files are already dev-diagnostic-only, never surfaced to operators.
  debug(message: string, context?: LogContext): void { write('DEBUG', message, undefined, context) },
  info(message: string, context?: LogContext): void { write('INFO', message, undefined, context) },
  warn(message: string, err?: unknown, context?: LogContext): void { write('WARN', message, err, context) },
  error(message: string, err?: unknown, context?: LogContext): void { write('ERROR', message, err, context) },
}

// Startup log retention (Phase 11F) — one file per day with no pruning
// meant the logs directory grew forever. Deletes any wpa-*.log older than
// LOG_RETENTION_DAYS; failures here are non-fatal (a stale log file left
// behind is harmless) so they're swallowed rather than surfaced.
export async function pruneOldLogs(): Promise<void> {
  let files: string[]
  try {
    files = await readdir(logsDir())
  } catch {
    return // No logs directory yet.
  }

  const cutoffMs = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000
  let prunedCount = 0

  for (const file of files) {
    if (!file.startsWith('wpa-') || !file.endsWith('.log')) continue
    const path = join(logsDir(), file)
    try {
      const info = await stat(path)
      if (info.mtimeMs < cutoffMs) {
        await unlink(path)
        prunedCount++
      }
    } catch {
      // Ignore — a file that vanished or couldn't be stat'd between
      // readdir and here isn't worth failing startup over.
    }
  }

  if (prunedCount > 0) {
    logger.info(`logger — pruned ${prunedCount} log file(s) older than ${LOG_RETENTION_DAYS} days`)
  }
}
