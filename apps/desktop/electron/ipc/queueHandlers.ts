import { ipcMain, BrowserWindow } from 'electron'
import { runProcessWatch } from './processHandlers'
import { logger } from '../logger'
import type { QueueAddPayload, QueueItemPublic, QueueRestorePayload } from '../../src/types/ipc'

interface QueueItemInternal {
  id: string
  sku: string
  inputFolder: string
  outputFolder: string
  spliceBoundaries: { leftBoundary: number; rightBoundary: number }
  scaleBoundaries: { leftBoundary: number; rightBoundary: number } | null
  widthMm: number
  status: 'queued' | 'processing' | 'complete' | 'failed'
  error: string | null
  enqueuedAt: string
  completedAt: string | null
}

let queue: QueueItemInternal[] = []
let isProcessing = false
let itemCounter = 0

function toPublic(item: QueueItemInternal): QueueItemPublic {
  return {
    id: item.id,
    sku: item.sku,
    status: item.status,
    error: item.error,
    enqueuedAt: item.enqueuedAt,
    completedAt: item.completedAt,
    spliceBoundaries: item.spliceBoundaries,
    scaleBoundaries: item.scaleBoundaries,
    widthMm: item.widthMm,
  }
}

function notifyRenderer(): void {
  const payload = queue.map(toPublic)
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('queue:update', payload)
  }
}

async function processNext(): Promise<void> {
  if (isProcessing) return
  const next = queue.find(item => item.status === 'queued')
  if (!next) return

  isProcessing = true
  next.status = 'processing'
  notifyRenderer()

  try {
    const result = await runProcessWatch({
      inputFolder: next.inputFolder,
      outputFolder: next.outputFolder,
      sku: next.sku,
      spliceBoundaries: next.spliceBoundaries,
      scaleBoundaries: next.scaleBoundaries,
      widthMm: next.widthMm,
    })

    if (result.ok) {
      next.status = 'complete'
    } else {
      next.status = 'failed'
      next.error = result.error ?? 'Processing failed'
    }
  } catch (err) {
    next.status = 'failed'
    next.error = 'Unexpected processing error'
    logger.error(`Unexpected error processing ${next.sku}`, err)
  }

  next.completedAt = new Date().toISOString()
  isProcessing = false
  notifyRenderer()
  void processNext()
}

export function registerQueueHandlers(): void {
  ipcMain.handle('queue:add', async (_event, payload: QueueAddPayload): Promise<{ id: string }> => {
    // If SKU already exists, update in-place and re-queue rather than duplicate.
    const existing = queue.find(i => i.sku === payload.sku)
    if (existing) {
      existing.spliceBoundaries = payload.spliceBoundaries
      existing.scaleBoundaries = payload.scaleBoundaries
      existing.widthMm = payload.widthMm
      existing.error = null
      existing.completedAt = null
      existing.enqueuedAt = new Date().toISOString()
      if (existing.status !== 'processing') {
        existing.status = 'queued'
        notifyRenderer()
        void processNext()
      } else {
        notifyRenderer()
      }
      logger.info(`queue:add — re-queued ${payload.sku}`)
      return { id: existing.id }
    }

    itemCounter += 1
    const id = `wpa-q-${Date.now()}-${itemCounter}`
    const item: QueueItemInternal = {
      id,
      sku: payload.sku,
      inputFolder: payload.inputFolder,
      outputFolder: payload.outputFolder,
      spliceBoundaries: payload.spliceBoundaries,
      scaleBoundaries: payload.scaleBoundaries,
      widthMm: payload.widthMm,
      status: 'queued',
      error: null,
      enqueuedAt: new Date().toISOString(),
      completedAt: null,
    }
    queue.push(item)
    logger.info(`queue:add — ${payload.sku} (queue length: ${queue.length})`)
    notifyRenderer()
    void processNext()
    return { id }
  })

  ipcMain.handle('queue:retry', async (_event, payload: { id: string }): Promise<{ ok: boolean }> => {
    const item = queue.find(i => i.id === payload.id)
    if (!item || item.status !== 'failed') return { ok: false }
    item.status = 'queued'
    item.error = null
    item.completedAt = null
    logger.info(`queue:retry — ${item.sku}`)
    notifyRenderer()
    void processNext()
    return { ok: true }
  })

  ipcMain.handle('queue:get', async (): Promise<QueueItemPublic[]> => {
    return queue.map(toPublic)
  })

  ipcMain.handle('queue:restore', async (_event, payload: QueueRestorePayload): Promise<void> => {
    queue = []
    isProcessing = false

    for (const sessionItem of payload.items) {
      const item: QueueItemInternal = {
        id: sessionItem.id,
        sku: sessionItem.sku,
        inputFolder: payload.inputFolder,
        outputFolder: payload.outputFolder,
        spliceBoundaries: sessionItem.spliceBoundaries,
        scaleBoundaries: sessionItem.scaleBoundaries,
        widthMm: sessionItem.widthMm,
        status: sessionItem.status === 'queued' ? 'queued' : sessionItem.status,
        error: sessionItem.error,
        enqueuedAt: sessionItem.enqueuedAt,
        completedAt: sessionItem.completedAt,
      }
      queue.push(item)
    }

    const queued = queue.filter(i => i.status === 'queued').length
    const complete = queue.filter(i => i.status === 'complete').length
    logger.info(`queue:restore — ${queue.length} items (${queued} queued, ${complete} complete)`)

    notifyRenderer()
    void processNext()
  })
}
