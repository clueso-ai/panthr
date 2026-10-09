// window.panthr: the API (src/shared/api.ts) and events from the app.

import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { METHODS } from '@shared/methods'

const api: Record<string, unknown> = {}
for (const [ns, methods] of Object.entries(METHODS)) {
  const o: Record<string, (...a: unknown[]) => Promise<unknown>> = {}
  for (const m of Object.keys(methods)) o[m] = (...args) => ipcRenderer.invoke(`${ns}:${m}`, ...args)
  api[ns] = o
}
api.on = (name: string, cb: (payload: unknown) => void) => {
  const f = (_: unknown, payload: unknown): void => cb(payload)
  ipcRenderer.on(`ev:${name}`, f)
  return () => ipcRenderer.removeListener(`ev:${name}`, f)
}
// A dropped file's path (Electron no longer puts it on the File).
api.pathForFile = (f: File) => webUtils.getPathForFile(f)
contextBridge.exposeInMainWorld('panthr', api)
