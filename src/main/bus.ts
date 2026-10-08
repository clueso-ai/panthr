// Events to the window(s): window.panthr.on(name, cb) in the renderer.

import { BrowserWindow } from 'electron'
import type { Events } from '@shared/api'
import { forward } from './control'

export function emit<K extends keyof Events>(name: K, payload: Events[K]): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(`ev:${name}`, payload)
  }
  // And to the command line, for whoever is listening there.
  forward(name, payload)
}
