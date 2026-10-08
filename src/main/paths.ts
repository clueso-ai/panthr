// Where Panthr keeps things. The same places the first (GPUI) Panthr used,
// so both see the same projects, settings and chats.

import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, readdirSync } from 'node:fs'
import { app } from 'electron'

/** ~/Panthr: the projects, the Library, the shared Skills. */
export const studioRoot = (): string => join(homedir(), 'Panthr')
export const libraryDir = (): string => join(studioRoot(), 'Library')

/** ~/Library/Application Support/Panthr. */
export const dataDir = (): string =>
  process.env.PANTHR_DATA_DIR || join(app?.getPath?.('appData') ?? join(homedir(), 'Library/Application Support'), 'Panthr')

/** The app's own files (runtime, picker, bridge, editor tool, prompt). */
export const resourcesDir = (): string =>
  app?.isPackaged ? join(process.resourcesPath, 'resources') : join(app?.getAppPath?.() ?? process.cwd(), 'resources')

export const resource = (name: string): string => join(resourcesDir(), name)

/** A GUI app does not inherit the shell's PATH: give the agents (and the
 *  npx / node / ffmpeg they run) the usual places. */
export function pathEnv(): string {
  const home = homedir()
  const parts = [join(home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin']
  const nvm = join(home, '.nvm/versions/node')
  if (existsSync(nvm)) {
    const v = readdirSync(nvm).sort()
    if (v.length) parts.push(join(nvm, v[v.length - 1], 'bin'))
  }
  if (process.env.PATH) parts.push(process.env.PATH)
  parts.push('/usr/bin:/bin:/usr/sbin:/sbin')
  return parts.join(':')
}

/** An environment for the tools we run. */
export const toolEnv = (): NodeJS.ProcessEnv => ({ ...process.env, PATH: pathEnv() })

export const now = (): number => Math.floor(Date.now() / 1000)
