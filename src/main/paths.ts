// Where Panthr keeps things. The same places the first (GPUI) Panthr used,
// so both see the same projects, settings and chats.

import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { existsSync, readdirSync } from 'node:fs'
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
export const toolEnv = (): NodeJS.ProcessEnv => ({ ...process.env, PATH: pathEnv(), ...(sandboxed() ? { HOME: home() } : {}) })

export const now = (): number => Math.floor(Date.now() / 1000)
