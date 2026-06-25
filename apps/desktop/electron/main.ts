import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { registerBatchHandlers } from './ipc/batchHandlers'
import { registerDataHandlers } from './ipc/dataHandlers'
import { registerSessionHandlers } from './ipc/sessionHandlers'
import { registerPrefsHandlers } from './ipc/prefsHandlers'
import { registerProcessHandlers } from './ipc/processHandlers'

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'Watch Processing Automation',
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

app.whenReady().then(() => {
  registerBatchHandlers()
  registerDataHandlers()
  registerSessionHandlers()
  registerPrefsHandlers()
  registerProcessHandlers()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
