// The `app` namespace: the Mac around Panthr (Finder, files, URLs, tools).

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { app, BrowserWindow, dialog, shell } from 'electron'
import type { Api } from '@shared/api'
import { fileUrl, projectId } from './preview'
import { toolEnv } from './paths'

const run = promisify(execFile)

async function has(tool: string): Promise<boolean> {
  try {
    await run('/bin/sh', ['-c', `command -v ${tool}`], { env: toolEnv() })
    return true
  } catch {
    return false
  }
}

export const appApi: Api['app'] = {
  async missingTools() {
    const out: string[] = []
    if (!(await has('claude')) && !(await has('codex'))) out.push('claude')
    for (const t of ['node', 'npx', 'ffmpeg']) if (!(await has(t))) out.push(t)
    return out
  },
  async reveal(path) {
    shell.showItemInFolder(path)
  },
  async openPath(path) {
    await shell.openPath(path)
  },
  async openExternal(url) {
    if (/^https?:\/\//.test(url)) await shell.openExternal(url)
  },
  async fileUrl(path) {
    return fileUrl(path)
  },
  async chooseFolder() {
    const w = BrowserWindow.getFocusedWindow()
    const r = await (w ? dialog.showOpenDialog(w, { properties: ['openDirectory'] }) : dialog.showOpenDialog({ properties: ['openDirectory'] }))
    if (r.canceled || !r.filePaths[0]) return null
    projectId(r.filePaths[0])
    return r.filePaths[0]
  },
  async chooseFiles() {
    const w = BrowserWindow.getFocusedWindow()
    const opts: Electron.OpenDialogOptions = { properties: ['openFile', 'multiSelections'] }
    const r = await (w ? dialog.showOpenDialog(w, opts) : dialog.showOpenDialog(opts))
    return r.canceled ? [] : r.filePaths
  },
  async quit() {
    app.quit()
  }
}
