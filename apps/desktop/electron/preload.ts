import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('api', {
  invoke: (channel: string, payload?: unknown): Promise<unknown> =>
    ipcRenderer.invoke(channel, payload)
})
