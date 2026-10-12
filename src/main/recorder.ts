// Screen recording: a screen or a window recorded into a project, to make
// a product demo from. panthr-capture (ScreenCaptureKit) records it to an
// MP4, with the pointer in the picture or not, and the microphone if
// asked; panthr-input notes where the pointer goes and clicks either way,
// so a pointer can be drawn in later. Panthr's window steps aside
// meanwhile; a timer in the menu bar (or ⇧⌘2) stops it.
//
// Stopped, it becomes a video on the project's canvas: the recording
// playing full frame, and recording.json beside it with what the agent
// needs to make a demo of it: the clicks and the pointer's path in the
// video's own pixels, whether the pointer is in the picture, and the dead
// time (no input, nothing moving).
//
// From Home it makes no project: the take is held in the data folder and
// attached to Home's chat box; sending makes the project with it on the
// canvas (recorder.attach).

import { spawn, type ChildProcess } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { app, BrowserWindow, desktopCapturer, globalShortcut, nativeImage, screen, shell, systemPreferences, Tray, type DesktopCapturerSource } from 'electron'
import { anyWorking } from './chats'
import type { Api } from '@shared/api'
import type { HeldRecording, RecordingSource } from '@shared/types'
import { emit } from './bus'
import { board, canvasOf, newVideo, real } from './board'
import { dataDir, resource, toolEnv } from './paths'
import { exec } from './review'
import { fileUrl } from './preview'

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
  /** Its project; null from Home (held until a project is made with it). */
  canvas: string | null
  source: { id: string; name: string }
  file: string
  /** The display's frame (screen recordings), in points from the main display's top left. */
  display: { x: number; y: number; w: number; h: number } | null
  capture: ChildProcess | null
  helper: ChildProcess | null
  events: InputEvent[]
  /** ms (Date.now) when the picture began, and when the input helper did. */
  startedAt: number
  helperAt: number
  pointer: boolean
  mic: boolean
  tray: Tray | null
  timer: NodeJS.Timeout | null
}

let sources = new Map<string, DesktopCapturerSource>()
let take: Take | null = null

const win = (): BrowserWindow | null => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null

const clock = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

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

/** Stop: the capture finishes its file, then the take lands on the canvas. */
function stopTake(): void {
  const t = take
  if (!t || !t.capture) return
  emit('recorder:saving', { id: t.id })
  t.helper?.stdin?.end()
  t.helper = null
  t.capture.stdin?.end()
  endChrome(t)
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
  /** Whether the pointer is in the picture (if not, draw one from moves and clicks). */
  pointer: boolean
}

/** Points on screen to the video's pixels: by the display's frame, or the window's frame at that moment. */
export function toVideo(events: InputEvent[], shift: number, frame: { x: number; y: number; w: number; h: number } | null, size: { w: number; h: number }, duration: number): Omit<RecordingData, 'idle' | 'source' | 'duration' | 'width' | 'height' | 'pointer'> {
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

type Landing = Pick<Take, 'file' | 'events' | 'display' | 'startedAt' | 'helperAt'> & { source: { name: string }; pointer?: boolean }

/** The take, as a video on its canvas. */
export async function land(t: Landing & { canvas: string }, name: string, mic: boolean): Promise<string> {
  const v = newVideo(t.canvas, name)
  await fill(v.dir, t, mic)
  emit('board:changed', board(t.canvas))
  emit('board:focus', { canvas: t.canvas, key: v.dir, fresh: true })
  return v.dir
}

const heldRoot = (): string => join(dataDir(), 'recordings', 'held')

/** A take from Home: held in the data folder (a video folder of its own,
 *  with a still), until a project is made with it. */
export async function hold(t: Landing & { id: string }, name: string, mic: boolean): Promise<HeldRecording> {
  const dir = join(heldRoot(), t.id)
  mkdirSync(dir, { recursive: true })
  const duration = await fill(dir, t, mic)
  const poster = join(dir, 'poster.jpg')
  await exec('ffmpeg', ['-hide_banner', '-y', '-ss', String(Math.min(1, duration / 2)), '-i', join(dir, 'assets', 'recording.mp4'), '-frames:v', '1', '-vf', 'scale=480:-2', poster], { env: toolEnv() })
  writeFileSync(join(dir, 'held.json'), JSON.stringify({ name, duration }))
  return { dir, name, duration, poster: fileUrl(poster) }
}

/** A held take onto a project's canvas, as a video; its folder. */
export function attach(canvas: string, held: string): string {
  const from = resolve(held)
  if (!from.startsWith(heldRoot() + sep) || !existsSync(join(from, 'recording.json'))) throw new Error('That recording is gone')
  const { name } = JSON.parse(readFileSync(join(from, 'held.json'), 'utf8')) as { name: string }
  const v = newVideo(canvas, name)
  cpSync(join(from, 'assets'), join(v.dir, 'assets'), { recursive: true })
  for (const f of ['recording.json', 'index.html']) cpSync(join(from, f), join(v.dir, f))
  rmSync(from, { recursive: true, force: true })
  emit('board:changed', board(real(canvas)))
  return v.dir
}

/** The recording made into a video in `dir`: the MP4, recording.json and an
 *  index.html that plays it; its length. */
async function fill(dir: string, t: Landing, mic: boolean): Promise<number> {
  const assets = join(dir, 'assets')
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
    pointer: t.pointer !== false,
    idle: deadTime(frozen, [...input.clicks.map((c) => c.t), ...input.keys, ...input.scrolls.map((s) => s.t)])
  }
  writeFileSync(join(dir, 'recording.json'), JSON.stringify(data, null, 1))
  writeFileSync(join(dir, 'index.html'), recordingHtml(fw, fh, duration, mic))
  rmSync(t.file, { force: true })
  return duration
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
  async start(canvas0, sourceId, opts) {
    if (take) throw new Error('Already recording')
    const source = sources.get(sourceId)
    if (!source) throw new Error('That screen or window is gone: pick again')
    const capture = resource('bin/panthr-capture')
    if (!existsSync(capture)) throw new Error('The recorder is missing from this build')
    // Into this project, or (from Home) held for Home's chat box.
    const canvas = canvas0 ? canvasOf(real(canvas0)) : null
    const id = `rec-${Date.now().toString(36)}`
    const dir = join(dataDir(), 'recordings')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${id}.mp4`)
    const winId = /^window:(\d+):/.exec(source.id)?.[1]
    let display: Take['display'] = null
    if (!winId) {
      const d = screen.getAllDisplays().find((x) => String(x.id) === source.display_id) ?? screen.getPrimaryDisplay()
      display = { x: d.bounds.x, y: d.bounds.y, w: d.bounds.width, h: d.bounds.height }
    }
    const t: Take = { id, canvas, source: { id: source.id, name: source.name }, file, display, capture: null, helper: null, events: [], startedAt: 0, helperAt: 0, pointer: opts.pointer, mic: opts.mic, tray: null, timer: null }
    const args = [winId ? '--window' : '--display', winId ?? source.display_id ?? '', '--out', file, ...(opts.pointer ? [] : ['--no-cursor']), ...(opts.mic ? ['--mic'] : [])]
    const c = spawn(capture, args, { stdio: ['pipe', 'pipe', 'pipe'] })
    t.capture = c
    let err = ''
    c.stderr!.on('data', (b: Buffer) => (err = (err + b.toString('utf8')).slice(-2000)))
    // Its first word: recording, or why not.
    const first = await new Promise<{ type: string; message?: string }>((ok) => {
      const lines = createInterface({ input: c.stdout! })
      const timer = setTimeout(() => ok({ type: 'error', message: 'The recording did not start (is Screen Recording allowed for Panthr?)' }), 15000)
      lines.on('line', (l) => {
        let m: any
        try {
          m = JSON.parse(l)
        } catch {
          return
        }
        if (m.type === 'started' || (m.type === 'error' && !t.startedAt)) {
          clearTimeout(timer)
          ok(m)
        }
        if (m.type === 'done' || (m.type === 'error' && t.startedAt)) void ended(t, m.type === 'done' ? null : m.message ?? 'The recording failed')
      })
      c.on('close', (code) => {
        clearTimeout(timer)
        if (!t.startedAt) ok({ type: 'error', message: err.trim().split('\n').pop() || `The recorder stopped (${code})` })
        else if (take === t) void ended(t, 'The recorder stopped')
      })
    })
    if (first.type !== 'started') {
      c.kill()
      throw new Error(first.message ?? 'The recording did not start')
    }
    t.startedAt = Date.now()
    take = t
    // Where the pointer goes and clicks, in the picture or not.
    const input = resource('bin/panthr-input')
    if (existsSync(input)) {
      const h = spawn(input, winId ? ['--window', winId] : [], { stdio: ['pipe', 'pipe', 'ignore'] })
      t.helperAt = Date.now()
      t.helper = h
      h.on('error', () => {})
      createInterface({ input: h.stdout! }).on('line', (l) => {
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
    tray.on('click', stopTake)
    t.tray = tray
    t.timer = setInterval(() => tray.setTitle(`● ${clock((Date.now() - t.startedAt) / 1000)}`), 500)
    globalShortcut.register('CommandOrControl+Shift+2', stopTake)
    return { id, canvas }
  },
  async stop() {
    stopTake()
  },
  async attach(canvas, held) {
    return attach(canvas, held)
  }
}

/** The capture finished (or failed): land it, and say so. */
let landing: string | null = null
async function ended(t: Take, error: string | null): Promise<void> {
  if (landing === t.id) return
  landing = t.id
  if (take === t) take = null
  endChrome(t)
  t.helper?.stdin?.end()
  if (error) {
    emit('recorder:failed', { id: t.id, message: error })
    rmSync(t.file, { force: true })
    return
  }
  try {
    const name = `Recording · ${new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
    if (t.canvas) {
      const dir = await land({ ...t, canvas: t.canvas }, name, t.mic)
      emit('recorder:done', { id: t.id, canvas: t.canvas, dir, name })
    } else {
      const held = await hold(t, name, t.mic)
      emit('recorder:done', { id: t.id, canvas: null, dir: held.dir, name, held })
    }
  } catch (e) {
    emit('recorder:failed', { id: t.id, message: (e as Error).message })
  }
}
