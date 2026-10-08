// The `app` namespace: the Mac around Panthr (Finder, files, URLs, tools).

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { app, BrowserWindow, dialog, shell } from 'electron'
import type { Api } from '@shared/api'
import { fileUrl, projectId } from './preview'
import { resource, toolEnv } from './paths'
import { chmodSync, lstatSync, mkdirSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const run = promisify(execFile)

async function has(tool: string): Promise<boolean> {
  try {
    await run('/bin/sh', ['-c', `command -v ${tool}`], { env: toolEnv() })
    return true
  } catch {
    return false
  }
}

/** Where the command goes: ~/.local/bin, where Claude Code puts its own. */
const cliLink = (): string => join(homedir(), '.local/bin/panthr')

async function cliStatus(): Promise<{ path: string; onPath: boolean; installed: boolean }> {
  const path = cliLink()
  let installed = false
  try {
    installed = lstatSync(path).isSymbolicLink() && readlinkSync(path) === resource('cli/panthr.mjs')
  } catch {}
  // The user's own shell PATH (a GUI app's is not theirs).
  let onPath = false
  try {
    const { stdout } = await run(process.env.SHELL || '/bin/zsh', ['-lic', 'echo $PATH'], { timeout: 5000 })
    onPath = stdout.split(':').map((x) => x.trim()).includes(join(homedir(), '.local/bin'))
  } catch {}
  return { path, onPath, installed }
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
  },
  async installCli() {
    const target = resource('cli/panthr.mjs')
    const link = cliLink()
    mkdirSync(join(homedir(), '.local/bin'), { recursive: true })
    try {
      chmodSync(target, 0o755)
    } catch {}
    // Ours, or nothing: never replace someone else's panthr.
    try {
      const st = lstatSync(link)
      if (!st.isSymbolicLink()) throw new Error(`${link} exists and is not Panthr's`)
      unlinkSync(link)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
    symlinkSync(target, link)
    return cliStatus()
  },
  cliStatus
}
