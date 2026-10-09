// Panthr: the window, the app menu, the panthr:// protocol and the API.
//
// Headless runs (tests, captures) never show a window: PANTHR_SHOT=<png>
// renders it hidden, runs PANTHR_EVAL (a script in the window) if given,
// waits PANTHR_SHOT_DELAY ms, saves a capture and quits.

import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, screen, shell } from 'electron'
import { METHODS } from '@shared/methods'
import type { Api } from '@shared/api'
import { handleProtocol, registerScheme } from './preview'
import { emit } from './bus'
import { socketPath, startControl } from './control'
import { dataDir } from './paths'
import { getState as readState } from './state'
import { settings, getSettings } from './settings'
import { state, getState } from './state'
import { appApi } from './app'
import { projects } from './projects'
import { chats, anyWorking, stopAll } from './chats'
import { controls } from './controls'
import { review } from './review'
import { skills, seedSkills } from './skills'
import { hosts } from './hosts'
import { files } from './files'
import { references, stopAllReferences } from './references'

const HEADLESS = !!process.env.PANTHR_SHOT
if (process.env.PANTHR_DATA_DIR) app.setPath('userData', process.env.PANTHR_DATA_DIR)
app.setName('Panthr')
app.setAboutPanelOptions({ applicationName: 'Panthr', credits: 'by Clueso', copyright: 'Panthr by Clueso' })
registerScheme()
// A test run never puts up a dialog: errors go to its log.
if (HEADLESS) process.on('uncaughtException', (e) => console.error('uncaught:', e))

const handlers: Api = { app: appApi, settings, state, projects, chats, controls, review, skills, files, hosts, references }

function registerApi(): void {
  for (const [ns, methods] of Object.entries(METHODS)) {
    for (const m of Object.keys(methods)) {
      const f = (handlers as any)[ns][m] as (...a: unknown[]) => Promise<unknown>
      ipcMain.handle(`${ns}:${m}`, (_e, ...args) => f(...args))
    }
  }
}

function applyAppearance(): void {
  const a = getSettings().appearance
  nativeTheme.themeSource = a === 'night' ? 'dark' : a === 'day' ? 'light' : 'system'
}

let win: BrowserWindow | null = null

function createWindow(): BrowserWindow {
  const s = getState()
  const work = screen.getPrimaryDisplay().workArea
  const [x, y, w, h] = s.frame ?? [work.x + 60, work.y + 40, Math.min(1440, work.width - 120), Math.min(900, work.height - 80)]
  const w0 = new BrowserWindow({
    x, y, width: w, height: h, minWidth: 900, minHeight: 600,
    show: false,
    title: 'Panthr',
    titleBarStyle: 'hiddenInset',
    // Centred on the 52 pt title row (14 pt controls), with the back arrow and the name.
    trafficLightPosition: { x: 18, y: 19 },
    vibrancy: 'under-window',
    visualEffectState: 'followWindow',
    backgroundColor: '#00000000',
    paintWhenInitiallyHidden: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: false,
      contextIsolation: true,
      backgroundThrottling: false,
      webSecurity: true
    }
  })
  if (s.maximized && !HEADLESS) w0.maximize()
  w0.once('ready-to-show', () => {
    if (!HEADLESS) w0.show()
  })
  const remember = (): void => {
    if (w0.isDestroyed() || HEADLESS) return
    const b = w0.getNormalBounds()
    state.set({ frame: [b.x, b.y, b.width, b.height], maximized: w0.isMaximized() })
  }
  w0.on('resized', remember)
  w0.on('moved', remember)
  w0.on('close', async (e) => {
    if (HEADLESS || (w0 as any).__closing) return
    if (await anyWorking()) {
      e.preventDefault()
      const r = await dialog.showMessageBox(w0, {
        type: 'warning', buttons: ['Stop and close', 'Keep working'], defaultId: 1, cancelId: 1,
        message: 'An agent is still working.', detail: 'Closing stops it. Its chat keeps everything so far.'
      })
      if (r.response === 0) {
        stopAll()
        ;(w0 as any).__closing = true
        w0.close()
      }
    }
  })
  w0.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env.ELECTRON_RENDERER_URL) w0.loadURL(process.env.ELECTRON_RENDERER_URL)
  else w0.loadFile(join(__dirname, '../renderer/index.html'))
  return w0
}

/** A headless run: capture the window once it has settled, then quit. */
function headlessCapture(w0: BrowserWindow): void {
  w0.webContents.once('did-finish-load', async () => {
    const delay = +(process.env.PANTHR_SHOT_DELAY || 2500)
    await new Promise((r) => setTimeout(r, Math.min(delay, 1500)))
    if (process.env.PANTHR_EVAL) {
      try {
        const out = await w0.webContents.executeJavaScript(process.env.PANTHR_EVAL)
        if (out !== undefined) console.log('eval:', typeof out === 'string' ? out : JSON.stringify(out))
      } catch (e) {
        console.log('eval failed:', e)
      }
    }
    // A script in the preview page itself (PANTHR_FRAME_EVAL), then one more
    // in the window (PANTHR_EVAL_AFTER): to click inside the video and see
    // what the app made of it.
    if (process.env.PANTHR_FRAME_EVAL) {
      const f = w0.webContents.mainFrame.framesInSubtree.find((x) => x.url.startsWith('panthr://p-') && x !== w0.webContents.mainFrame)
      try {
        console.log('frame:', JSON.stringify(f ? await f.executeJavaScript(process.env.PANTHR_FRAME_EVAL) : 'no preview frame'))
      } catch (e) {
        console.log('frame eval failed:', e)
      }
      await new Promise((r) => setTimeout(r, 1200))
    }
    if (process.env.PANTHR_EVAL_AFTER) {
      try {
        console.log('after:', JSON.stringify(await w0.webContents.executeJavaScript(process.env.PANTHR_EVAL_AFTER)))
      } catch (e) {
        console.log('after eval failed:', e)
      }
    }
    await new Promise((r) => setTimeout(r, Math.max(0, delay - 1500)))
    const img = await w0.webContents.capturePage()
    writeFileSync(process.env.PANTHR_SHOT!, img.toPNG())
    console.log('shot:', process.env.PANTHR_SHOT)
    app.exit(0)
  })
}

const command = (name: string) => () => emit('command', { name })

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'Panthr',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'Cmd+,', click: command('settings') },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Project', accelerator: 'Cmd+N', click: command('new-project') },
        { label: 'New Chat', accelerator: 'Cmd+T', click: command('new-chat') },
        { label: 'Open Folder…', accelerator: 'Cmd+O', click: command('open-folder') },
        { type: 'separator' },
        { label: 'Rename Project…', click: command('rename') },
        { label: 'Export', accelerator: 'Cmd+E', click: command('export') },
        { type: 'separator' },
        { label: 'Home', accelerator: 'Cmd+Shift+H', click: command('home') },
        { role: 'close' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'Cmd+Z', click: command('undo') },
        { label: 'Redo', accelerator: 'Cmd+Shift+Z', click: command('redo') },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Chat', accelerator: 'Cmd+1', click: command('side-chat') },
        { label: 'Notes', accelerator: 'Cmd+2', click: command('side-notes') },
        { label: 'Versions', accelerator: 'Cmd+3', click: command('side-versions') },
        { label: 'Library', accelerator: 'Cmd+4', click: command('side-library') },
        { type: 'separator' },
        { label: 'Light or Dark', accelerator: 'Cmd+Shift+L', click: command('theme') },
        { type: 'separator' },
        { label: 'Layers', accelerator: 'Cmd+L', click: command('toggle-layers') },
        { label: 'Draw on the Frame', accelerator: 'Cmd+Shift+D', click: command('draw') },
        { label: 'Note at This Moment', accelerator: 'Cmd+Shift+K', click: command('note') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' } as const, { role: 'reload' } as const])
      ]
    },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** The command line's requests: the API by "<namespace>.<method>", and
 *  the window itself by "ui.<what>". */
async function dispatch(method: string, params: unknown[]): Promise<unknown> {
  const [ns, m] = method.split('.')
  if (ns === 'ui') {
    const w = win && !win.isDestroyed() ? win : null
    switch (m) {
      case 'open':
        // A project in the window (and, given one, a first message for it).
        emit('open', { dir: String(params[0]), first: typeof params[1] === 'string' ? params[1] : null })
        return true
      case 'command':
        emit('command', { name: String(params[0]) })
        return true
      case 'status':
        return { version: app.getVersion(), window: !!w, visible: !!w?.isVisible(), working: await anyWorking(), state: readState() }
      case 'screenshot': {
        if (!w) throw new Error('no window')
        const img = await w.webContents.capturePage()
        const path = String(params[0] || join(app.getPath('temp'), `panthr-${Date.now()}.png`))
        writeFileSync(path, img.toPNG())
        return path
      }
      case 'show':
        w?.show()
        w?.focus()
        return true
    }
    throw new Error(`no such command: ${method}`)
  }
  const methods = (METHODS as Record<string, Record<string, true>>)[ns]
  if (!methods || !methods[m]) throw new Error(`no such method: ${method}`)
  return (handlers as any)[ns][m](...params)
}

app.whenReady().then(() => {
  applyAppearance()
  handleProtocol()
  registerApi()
  buildMenu()
  win = createWindow()
  if (HEADLESS) headlessCapture(win)
  // The default skills, put in once (not in a test run).
  else seedSkills()
  // The command line's way in (not in a test run unless asked).
  if (!HEADLESS || process.env.PANTHR_CONTROL) startControl(socketPath(dataDir()), dispatch)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) win = createWindow()
  })
})

app.on('window-all-closed', () => {
  stopAll()
  stopAllReferences()
  app.quit()
})

