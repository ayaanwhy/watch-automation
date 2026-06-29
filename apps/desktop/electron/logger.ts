import { app } from 'electron'
import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

function logsDir(): string {
  return join(app.getPath('userData'), 'logs')
}

function logFilePath(): string {
  return join(logsDir(), `wpa-${new Date().toISOString().slice(0, 10)}.log`)
}

let dirReady = false

function write(level: string, message: string): void {
  const line = `[${new Date().toISOString()}] [${level}] ${message}\n`
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
  info(message: string): void { write('INFO', message) },
  warn(message: string): void { write('WARN', message) },
  error(message: string, err?: unknown): void {
    const detail = err instanceof Error
      ? ` — ${err.message}`
      : err !== undefined ? ` — ${String(err)}` : ''
    write('ERROR', message + detail)
  },
}
