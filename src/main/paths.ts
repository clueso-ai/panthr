// Where Panthr keeps things. The same places the first (GPUI) Panthr used,
// so both see the same projects, settings and chats.

import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { app } from 'electron'

/** Inside the App Sandbox (the TestFlight / App Store build) HOME is the
 *  app's container; the real home, where the sandbox exceptions point
 *  (~/Panthr, ~/.claude, ~/.local, ...), comes from the user database. */
export const sandboxed = (): boolean => !!process.env.APP_SANDBOX_CONTAINER_ID

/** The user's home folder, also when sandboxed. */
export const home = (): string => (sandboxed() ? userInfo().homedir : homedir())

/** ~/Panthr: the projects, the Library, the shared Skills. */
export const studioRoot = (): string => process.env.PANTHR_ROOT || join(home(), 'Panthr')
export const libraryDir = (): string => join(studioRoot(), 'Library')

/** ~/Library/Application Support/Panthr. */
export const dataDir = (): string =>
  process.env.PANTHR_DATA_DIR ||
  join(sandboxed() ? join(home(), 'Library/Application Support') : (app?.getPath?.('appData') ?? join(homedir(), 'Library/Application Support')), 'Panthr')

/** The assistant's folder: its conversations (in .studio, as a project's), kept out of ~/Panthr. */
export const assistantDir = (): string => join(dataDir(), 'assistant')

/** The app's own files (runtime, picker, bridge, editor tool, prompt). */
export const resourcesDir = (): string =>
  app?.isPackaged ? join(process.resourcesPath, 'resources') : join(app?.getAppPath?.() ?? process.cwd(), 'resources')

export const resource = (name: string): string => join(resourcesDir(), name)

/** A GUI app does not inherit the shell's PATH: give the agents (and the
 *  npx / node / ffmpeg they run) the usual places. */
export function pathEnv(): string {
  const h = home()
  const parts = [join(h, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin']
  const nvm = join(h, '.nvm/versions/node')
  if (existsSync(nvm)) {
    const v = readdirSync(nvm).sort()
    if (v.length) parts.push(join(nvm, v[v.length - 1], 'bin'))
  }
  if (process.env.PATH) parts.push(process.env.PATH)
  parts.push('/usr/bin:/bin:/usr/sbin:/sbin')
  return parts.join(':')
}

/** An environment for the tools we run. */
// (Sandboxed, the tools get the real HOME too: Claude Code's sign-in and
// settings live in ~/.claude.)
// The agents get Panthr's own `panthr` first on PATH (agentBin), talking to
// this app's data folder.
export const toolEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  PATH: `${agentBin()}:${pathEnv()}`,
  PANTHR_DATA_DIR: dataDir(),
  ...(sandboxed() ? { HOME: home() } : {})
})

/** Where the agents' `panthr` lives: a script that runs the bundled command
 *  line (with node if there is one, else with Panthr itself as node). */
export const agentBin = (): string => join(dataDir(), 'bin')

export function writeAgentCli(): void {
  const dir = agentBin()
  const cli = resource('cli/panthr.mjs')
  const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`
  const text = `#!/bin/sh\n# Panthr's command line for the agents it runs (written by Panthr).\nif command -v node >/dev/null 2>&1; then exec node ${q(cli)} "$@"; fi\nELECTRON_RUN_AS_NODE=1 exec ${q(process.execPath)} ${q(cli)} "$@"\n`
  const p = join(dir, 'panthr')
  try {
    if (readFileSync(p, 'utf8') === text) return
  } catch {}
  mkdirSync(dir, { recursive: true })
  writeFileSync(p, text, { mode: 0o755 })
  chmodSync(p, 0o755)
}

export const now = (): number => Math.floor(Date.now() / 1000)
