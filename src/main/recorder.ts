// Screen recording: a screen or a window recorded into a project, to make
// a product demo from. The window records (getDisplayMedia, MediaRecorder,
// the microphone if asked) and streams the file here in pieces; Panthr's
// own window steps aside meanwhile, and a timer in the menu bar (or ⇧⌘2)
// stops it. panthr-input notes where the pointer goes and clicks.
//
// Stopped, it becomes a video on the project's canvas: the recording as an
// MP4 playing full frame, and recording.json beside it with what the agent
// needs to make a demo of it: the clicks and the pointer's path in the
// video's own pixels, and the dead time (no input, nothing moving).

import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { app, BrowserWindow, desktopCapturer, globalShortcut, nativeImage, screen, shell, systemPreferences, Tray, type DesktopCapturerSource } from 'electron'
import { anyWorking } from './chats'
import type { Api } from '@shared/api'
import type { RecordingSource } from '@shared/types'
import { emit } from './bus'
import { canvasOf, newVideo, real } from './board'
import { dataDir, resource, toolEnv } from './paths'
import { exec } from './review'

interface InputEvent {
  t: number
  type: 'click' | 'up' | 'move' | 'scroll' | 'key' | 'bounds'
  x?: number
  y?: number
  w?: number
  h?: number
  button?: string
}

interface Take {
  id: string
  canvas: string
  source: DesktopCapturerSource
  file: string
  /** The display's frame (screen recordings), in points from the main display's top left. */
  display: { x: number; y: number; w: number; h: number } | null
  helper: ChildProcess | null
  events: InputEvent[]
  /** ms (Date.now) when the recording began, and when the helper did. */
  startedAt: number
  helperAt: number
  tray: Tray | null
  timer: NodeJS.Timeout | null
}

let sources = new Map<string, DesktopCapturerSource>()
let chosen: DesktopCapturerSource | null = null
let take: Take | null = null

/** For getDisplayMedia in the window: the source picked in Panthr (no system picker). */
export function displayMediaSource(): DesktopCapturerSource | null {
  return chosen
}

const win = (): BrowserWindow | null => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null

const clock = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

function stopInput(t: Take): void {
  t.helper?.stdin?.end()
  t.helper = null
}

function endChrome(t: Take): void {
  if (t.timer) clearInterval(t.timer)
  t.timer = null
  t.tray?.destroy()
  t.tray = null
  globalShortcut.unregister('CommandOrControl+Shift+2')
  const w = win()
  if (w && !w.isVisible()) w.show()
  w?.focus()
}

/** Ask the window to stop (it stops its recorder, sends what is left, then finishes). */
function askStop(): void {
  if (take) emit('recorder:stop', { id: take.id })
}

// ── From the input helper's points to the video's pixels ──────────────

export interface RecordingData {
  duration: number
  width: number
  height: number
  source: string
  clicks: { t: number; x: number; y: number; button: string }[]
  moves: { t: number; x: number; y: number }[]
  keys: number[]
  scrolls: { t: number; x: number; y: number }[]
  idle: { from: number; to: number }[]
}

/** Points on screen to the video's pixels: by the display's frame, or the window's frame at that moment. */
export function toVideo(events: InputEvent[], shift: number, frame: { x: number; y: number; w: number; h: number } | null, size: { w: number; h: number }, duration: number): Omit<RecordingData, 'idle' | 'source' | 'duration' | 'width' | 'height'> {
  let f = frame
  const clicks: RecordingData['clicks'] = []
  const moves: RecordingData['moves'] = []
  const scrolls: RecordingData['scrolls'] = []
  const keys: number[] = []
  let lastMove = -1
  for (const e of events) {
    if (e.type === 'bounds') {
      f = { x: e.x!, y: e.y!, w: e.w!, h: e.h! }
      continue
    }
    // The helper's clock, on the recording's.
    const t = Math.round((e.t + shift) * 1000) / 1000
    if (t < 0 || t > duration) continue
    if (e.type === 'key') {
      keys.push(t)
      continue
    }
    if (!f || e.x == null || e.y == null) continue
    const x = Math.round(((e.x - f.x) * size.w) / f.w)
    const y = Math.round(((e.y - f.y) * size.h) / f.h)
    if (x < 0 || y < 0 || x > size.w || y > size.h) continue
    if (e.type === 'click') clicks.push({ t, x, y, button: e.button ?? 'left' })
    else if (e.type === 'scroll') scrolls.push({ t, x, y })
    else if (e.type === 'move' && t - lastMove >= 0.1) {
      lastMove = t
      moves.push({ t, x, y })
    }
  }
  return { clicks, moves, keys, scrolls }
}

/** Dead time: where the picture stands still (ffmpeg freezedetect) and nothing was done. */
export function deadTime(frozen: { from: number; to: number }[], input: number[], min = 1.5): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = []
  for (const f of frozen) {
    // Split a still stretch where something was done in it.
    let from = f.from
    for (const t of input.filter((x) => x > f.from && x < f.to).sort((a, b) => a - b)) {
      if (t - 0.3 - from >= min) out.push({ from: round(from), to: round(t - 0.3) })
      from = t + 0.5
    }
    if (f.to - from >= min) out.push({ from: round(from), to: round(f.to) })
  }
  return out
}
const round = (n: number): number => Math.round(n * 100) / 100

async function probe(file: string): Promise<{ w: number; h: number; duration: number }> {
  const r = await exec('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', file])
  const v = JSON.parse(r.stdout || '{}')
  return { w: v.streams?.[0]?.width ?? 0, h: v.streams?.[0]?.height ?? 0, duration: Number(v.format?.duration) || 0 }
}

async function frozenStretches(file: string): Promise<{ from: number; to: number }[]> {
  const r = await exec('ffmpeg', ['-hide_banner', '-i', file, '-vf', 'freezedetect=n=0.003:d=1', '-map', '0:v:0', '-f', 'null', '-'])
  const out: { from: number; to: number }[] = []
  let from: number | null = null
  for (const line of r.stderr.split('\n')) {
    const s = /freeze_start: ([\d.]+)/.exec(line)
    const e = /freeze_end: ([\d.]+)/.exec(line)
    if (s) from = Number(s[1])
    if (e && from != null) {
      out.push({ from, to: Number(e[1]) })
      from = null
    }
  }
  return out
}

/** The composition that plays the recording, full frame. */
export function recordingHtml(w: number, h: number, duration: number, hasAudio: boolean): string {
  const d = Math.round(duration * 1000) / 1000
  return `<!doctype html>
<html><head><meta charset="utf-8">
<style>
  html,body{margin:0;background:#000}
  #root{position:relative;width:${w}px;height:${h}px;overflow:hidden;background:#000}
  #rec{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}
</style></head>
<body>
<div id="root" data-composition-id="main" data-start="0" data-duration="${d}" data-width="${w}" data-height="${h}">
  <video id="rec" class="clip" data-label="Screen recording" data-start="0" data-duration="${d}" data-track-index="0" src="assets/recording.mp4"${hasAudio ? '' : ' muted'} playsinline></video>
</div>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js"></script>
<script>
  const tl = gsap.timeline({ paused: true });
  tl.to({}, { duration: ${d} }, 0);
  window.__timelines = window.__timelines || {};
  window.__timelines["main"] = tl;
</script>
</body></html>
`
}

/** The take, as a video on its canvas. */
export async function land(t: Pick<Take, 'canvas' | 'file' | 'events' | 'display' | 'startedAt' | 'helperAt'> & { source: { name: string } }, name: string, mic: boolean): Promise<string> {
  const v = newVideo(t.canvas, name)
  const assets = join(v.dir, 'assets')
  mkdirSync(assets, { recursive: true })
  const mp4 = join(assets, 'recording.mp4')
  // H.264, even sizes, seekable from the start; the voice as AAC.
  const conv = await exec('ffmpeg', ['-hide_banner', '-y', '-i', t.file, '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', '30', ...(mic ? ['-c:a', 'aac', '-b:a', '160k'] : ['-an']), '-movflags', '+faststart', mp4], { env: toolEnv() })
  if (!conv.ok) throw new Error(`Could not save the recording: ${conv.stderr.trim().split('\n').pop()}`)
  const { w, h, duration } = await probe(mp4)
  // The video's frame: its own shape, 1920 wide at most.
  const fw = Math.min(1920, w) - (Math.min(1920, w) % 2)
  const fh = Math.round((fw * h) / w / 2) * 2
  const input = toVideo(t.events, (t.helperAt - t.startedAt) / 1000, t.display, { w: fw, h: fh }, duration)
  const frozen = await frozenStretches(mp4)
  const data: RecordingData = {
    duration: round(duration), width: fw, height: fh, source: t.source.name,
    ...input,
    idle: deadTime(frozen, [...input.clicks.map((c) => c.t), ...input.keys, ...input.scrolls.map((s) => s.t)])
  }
  writeFileSync(join(v.dir, 'recording.json'), JSON.stringify(data, null, 1))
  writeFileSync(join(v.dir, 'index.html'), recordingHtml(fw, fh, duration, mic))
  rmSync(t.file, { force: true })
  emit('board:changed', (await import('./board')).board(t.canvas))
  emit('board:focus', { canvas: t.canvas, key: v.dir, fresh: true })
  return v.dir
}

export const recorderApi: Api['recorder'] = {
  async access() {
    const of = (what: 'screen' | 'microphone'): string => {
      try {
        return systemPreferences.getMediaAccessStatus(what)
      } catch {
        return 'unknown'
      }
    }
    return { screen: of('screen'), microphone: of('microphone') }
  },
  async openPrivacy(what) {
    // A test run never opens System Settings on the person's screen.
    if (process.env.PANTHR_SHOT) return
    await shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${what === 'microphone' ? 'Privacy_Microphone' : 'Privacy_ScreenCapture'}`)
  },
  async relaunch(force) {
    // macOS applies a new Screen Recording permission only to a fresh start.
    if (!force && (await anyWorking())) throw new Error('An agent is working: relaunching would stop it')
    if (process.env.PANTHR_SHOT) return
    app.relaunch()
    app.exit(0)
  },
  async sources() {
    const mine = new Set(BrowserWindow.getAllWindows().map((w) => w.getMediaSourceId()))
    const list = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 360, height: 225 } })
    sources = new Map(list.map((s) => [s.id, s]))
    return list
      .filter((s) => !mine.has(s.id) && s.name !== 'Panthr' && !s.thumbnail.isEmpty())
      .map((s): RecordingSource => ({ id: s.id, name: s.name, kind: s.id.startsWith('screen:') ? 'screen' : 'window', thumb: s.thumbnail.toDataURL() }))
  },
  async begin(canvas0, sourceId) {
    if (take) throw new Error('Already recording')
    const source = sources.get(sourceId)
    if (!source) throw new Error('That screen or window is gone: pick again')
    chosen = source
    const canvas = canvasOf(real(canvas0))
    const id = `rec-${Date.now().toString(36)}`
    const dir = join(dataDir(), 'recordings')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${id}.webm`)
    writeFileSync(file, '')
    let display: Take['display'] = null
    if (source.id.startsWith('screen:')) {
      const d = screen.getAllDisplays().find((x) => String(x.id) === source.display_id) ?? screen.getPrimaryDisplay()
      display = { x: d.bounds.x, y: d.bounds.y, w: d.bounds.width, h: d.bounds.height }
    }
    take = { id, canvas, source, file, display, helper: null, events: [], startedAt: 0, helperAt: 0, tray: null, timer: null }
    return { id }
  },
  async started(id) {
    const t = take
    if (!t || t.id !== id) return
    t.startedAt = Date.now()
    // Where the pointer goes and clicks.
    const helper = resource('bin/panthr-input')
    if (existsSync(helper)) {
      const winId = /^window:(\d+):/.exec(t.source.id)?.[1]
      const c = spawn(helper, winId ? ['--window', winId] : [], { stdio: ['pipe', 'pipe', 'ignore'] })
      t.helperAt = Date.now()
      t.helper = c
      c.on('error', () => {})
      createInterface({ input: c.stdout! }).on('line', (l) => {
        try {
          t.events.push(JSON.parse(l))
        } catch {}
      })
    }
    // Out of the way while it records; a timer in the menu bar stops it (so does ⇧⌘2).
    win()?.hide()
    const tray = new Tray(nativeImage.createEmpty())
    tray.setTitle('● 0:00')
    tray.setToolTip('Recording: click to stop (⇧⌘2)')
    tray.on('click', askStop)
    t.tray = tray
    t.timer = setInterval(() => tray.setTitle(`● ${clock((Date.now() - t.startedAt) / 1000)}`), 500)
    globalShortcut.register('CommandOrControl+Shift+2', askStop)
  },
  async chunk(id, data) {
    if (take?.id === id) appendFileSync(take.file, Buffer.from(data))
  },
  async stop() {
    askStop()
  },
  async finish(id, mic) {
    const t = take
    if (!t || t.id !== id) throw new Error('No such recording')
    take = null
    chosen = null
    stopInput(t)
    endChrome(t)
    const name = `Recording · ${new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
    return land(t, name, mic)
  },
  async cancel(id) {
    const t = take
    if (!t || t.id !== id) return
    take = null
    chosen = null
    stopInput(t)
    endChrome(t)
    rmSync(t.file, { force: true })
  }
}
