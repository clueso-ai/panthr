// Electron, for the server on another machine (no window, no Mac): only
// what Panther's main-process modules touch. The panthr:// handler is kept
// for the server's HTTP to answer with; dialogs and Finder are not there.

import { dirname } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

type Handler = (req: Request) => Promise<Response> | Response
let handler: Handler | null = null
export const protocolHandler = (): Handler | null => handler

const here = typeof __filename === 'string' ? dirname(__filename) : process.cwd()

export const app = {
  isPackaged: false,
  getAppPath: (): string => here,
  getPath: (name: string): string => (name === 'temp' ? tmpdir() : name === 'home' ? homedir() : join(homedir(), '.panthr')),
  getVersion: (): string => process.env.PANTHR_BUILD || 'server',
  setPath: (): void => {},
  quit: (): void => process.exit(0),
  exit: (code = 0): void => process.exit(code)
}

export const BrowserWindow = {
  getAllWindows: (): never[] => [],
  getFocusedWindow: (): null => null
}

const notHere = async (): Promise<never> => {
  throw new Error('Not on this machine: it has no screen')
}
export const dialog = { showOpenDialog: notHere, showSaveDialog: notHere, showMessageBox: notHere }
export const shell = { showItemInFolder: (): void => {}, openPath: async (): Promise<string> => '', openExternal: async (): Promise<void> => {} }
export const nativeTheme = { themeSource: 'system' }
/** No screen to show a notification on. */
export class Notification {
  static isSupported(): boolean {
    return false
  }
  on(): void {}
  show(): void {}
}
export const protocol = {
  registerSchemesAsPrivileged: (): void => {},
  handle: (_scheme: string, f: Handler): void => {
    handler = f
  }
}

/** Recording a screen needs one. */
export const desktopCapturer = { getSources: notHere }
export const systemPreferences = { getMediaAccessStatus: (): string => 'unknown' }
export const globalShortcut = { register: (): boolean => false, unregister: (): void => {} }
export const nativeImage = { createEmpty: (): null => null }
export const screen = { getAllDisplays: (): never[] => [], getPrimaryDisplay: notHere }
export class Tray {
  constructor() {
    throw new Error('Not on this machine: it has no screen')
  }
}

export default { app, BrowserWindow, dialog, shell, nativeTheme, protocol, Notification, systemPreferences, desktopCapturer, globalShortcut, nativeImage, screen, Tray }
