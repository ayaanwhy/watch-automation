import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { registerBatchHandlers } from './ipc/batchHandlers'
import { registerDataHandlers } from './ipc/dataHandlers'
import { registerSessionHandlers } from './ipc/sessionHandlers'
import { registerPrefsHandlers } from './ipc/prefsHandlers'
import { registerQueueHandlers } from './ipc/queueHandlers'
import { registerPreprocessHandlers } from './ipc/preprocessHandlers'
import { registerBatchRegistryHandlers } from './ipc/batchRegistryHandlers'
import { registerRingBraceletHandlers } from './ipc/ringBraceletHandlers'
import { reconcileBatchesOnStartup } from './services/batchRegistry'
import { hydratePresetDefinitions } from './services/preprocessingPresetDefinitions'
import { logger, pruneOldLogs } from './logger'

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', err)
})

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', reason)
})

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    // Keep the persistent sidebar + content region usable; below this the
    // sidebar collapses to an icon rail (see Sidebar.module.css).
    minWidth: 960,
    minHeight: 640,
    title: 'VTO Automation',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      sandbox: false,
      webSecurity: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  logger.info(`App ready — v${app.getVersion()}`)
  // Runs before the window opens (and before any handler can be invoked)
  // so Home's first batch list is never stale: a stage still 'running' at
  // this point can only mean the previous run crashed or was force-quit —
  // no subprocess for it can possibly still be alive (Phase 11E).
  await reconcileBatchesOnStartup()
  // Must resolve before createWindow() — buildArgs/buildStageConfig read
  // preset definitions synchronously when a job starts, so the in-memory
  // cache needs to already be populated before the renderer can trigger one.
  await hydratePresetDefinitions()
  // Non-blocking — a slow prune shouldn't delay window startup, and a
  // failed one is already swallowed internally (see pruneOldLogs).
  void pruneOldLogs()
  registerBatchHandlers()
  registerDataHandlers()
  registerSessionHandlers()
  registerPrefsHandlers()
  registerQueueHandlers()
  registerPreprocessHandlers()
  registerBatchRegistryHandlers()
  registerRingBraceletHandlers()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('before-quit', () => {
  logger.info('App quitting')
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
