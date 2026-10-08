// What sits around the video: review comments (.studio/comments.json, the
// file the agent reads and resolves), versions (exports, .studio/versions/),
// the filmstrip frames under the timeline (.studio/frames/), drawings on a
// frame (.studio/annotations/) and the shared library (~/Panthr/Library).
// Port of studio-mac/src/review.rs and the parts of studio.rs that drive it.
//
// Exports and frames come from the same CLI the agent uses in the folder
// (`npx hyperframes render` / `snapshot`), run in the background; what they
// do arrives in the window as 'job' events.

import { spawn, type ChildProcess } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Api } from '@shared/api'
import type { Comment, JobEvent, LibraryItem, Settings, Version } from '@shared/types'
import { libraryDir, now, toolEnv } from './paths'
import { readJson, writeJson } from './json'
import { emit } from './bus'
import { getSettings } from './settings'
import { anyWorking } from './chats'
import * as remote from './remote'

const job = (e: JobEvent): void => emit('job', e)

// ── Comments ──────────────────────────────────────────────────────

const commentsPath = (dir: string): string => join(dir, '.studio/comments.json')

/** The comments, by time. The agent edits this file by hand, so missing
 *  `resolved` / `created_at` default (and a broken file is none). */
export function loadComments(dir: string): Comment[] {
  const raw = readJson<unknown>(commentsPath(dir), [])
  if (!Array.isArray(raw)) return []
  const out: Comment[] = []
  for (const c of raw) {
    if (!c || typeof c.id !== 'string' || typeof c.time !== 'number' || typeof c.body !== 'string') continue
    out.push(cleanComment({ ...c, resolved: c.resolved === true, created_at: typeof c.created_at === 'number' ? c.created_at : 0 }))
  }
  return out.sort((a, b) => a.time - b.time)
}

/** Empty optionals are left out of the file, as the Rust app writes it. */
function cleanComment(c: Comment): Comment {
  const out: Comment = { id: c.id, time: c.time, body: c.body, resolved: !!c.resolved, created_at: c.created_at ?? 0 }
  if (typeof c.end === 'number') out.end = c.end
  if (typeof c.x === 'number') out.x = c.x
  if (typeof c.y === 'number') out.y = c.y
  if (typeof c.reply === 'string') out.reply = c.reply
  return out
}

export function saveComments(dir: string, comments: Comment[]): void {
  // Same key order as serde: id, time, end, x, y, body, resolved, reply, created_at.
  const ordered = comments.map((c) => {
    const k = cleanComment(c)
    const o: Record<string, unknown> = { id: k.id, time: k.time }
    if (k.end != null) o.end = k.end
    if (k.x != null) o.x = k.x
    if (k.y != null) o.y = k.y
    o.body = k.body
    o.resolved = k.resolved
    if (k.reply != null) o.reply = k.reply
    o.created_at = k.created_at
    return o
  })
  writeJson(commentsPath(dir), ordered)
}

const round2 = (t: number): number => Math.round(t * 100) / 100

export function newComment(time: number, end: number | null, body: string): Comment {
  const c: Comment = { id: randomUUID().slice(0, 8), time: round2(time), body: body.trim(), resolved: false, created_at: now() }
  if (end != null) c.end = round2(end)
  return c
}

/** What the chat is sent by "Fix all". */
export function fixAllPrompt(open: number): string {
  return `Address the ${open} open review comment${open === 1 ? '' : 's'} in .studio/comments.json. For each: make the change at that moment of the video, then set "resolved": true and add a short "reply" saying what you did.`
}

// ── Versions ──────────────────────────────────────────────────────

const versionsPath = (dir: string): string => join(dir, '.studio/versions.json')
export const versionFile = (dir: string, v: Version): string => join(dir, '.studio/versions', v.file)
/** A version's poster: a frame from the middle of its video. */
export const posterFile = (dir: string, v: Version): string => join(dir, '.studio/versions', `v${v.n}.jpg`)

/** Newest first; versions whose video is gone are left out. */
export function loadVersions(dir: string): Version[] {
  const raw = readJson<unknown>(versionsPath(dir), [])
  if (!Array.isArray(raw)) return []
  const out: Version[] = []
  for (const v of raw) {
    if (!v || typeof v.n !== 'number' || typeof v.file !== 'string' || typeof v.created_at !== 'number') continue
    const x: Version = {
      n: v.n,
      file: v.file,
      created_at: v.created_at,
      bytes: typeof v.bytes === 'number' ? v.bytes : 0,
      render_seconds: typeof v.render_seconds === 'number' ? v.render_seconds : 0,
      duration: typeof v.duration === 'number' ? v.duration : 0
    }
    if (existsSync(versionFile(dir, x))) out.push(x)
  }
  return out.sort((a, b) => b.n - a.n)
}

/** Stored oldest first on disk. */
function writeVersions(dir: string, all: Version[]): void {
  writeJson(versionsPath(dir), [...all].sort((a, b) => a.n - b.n))
}

export function addVersion(dir: string, v: Version): void {
  writeVersions(dir, [...loadVersions(dir), v])
}

export function nextVersion(dir: string): number {
  return loadVersions(dir).reduce((m, v) => Math.max(m, v.n), 0) + 1
}

/** Run a program; resolves with its exit code and output (never rejects). */
function exec(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let child: ChildProcess
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? toolEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      resolve({ ok: false, stdout, stderr: String(e) })
      return
    }
    child.stdout?.on('data', (b) => (stdout += b))
    child.stderr?.on('data', (b) => (stderr += b))
    child.on('error', (e) => resolve({ ok: false, stdout, stderr: stderr || String(e) }))
    child.on('close', (code) => resolve({ ok: code === 0, stdout, stderr }))
  })
}

const postersRunning = new Set<string>()

/** Make the posters (and read the lengths) that are missing, in the
 *  background; 'posters' is sent when there is something new to show. */
export function posters(dir: string): void {
  if (postersRunning.has(dir)) return
  postersRunning.add(dir)
  void (async () => {
    try {
      const all = loadVersions(dir)
      let changed = false
      for (const v of all) {
        const video = versionFile(dir, v)
        if (v.duration <= 0) {
          const r = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', video])
          const d = parseFloat(r.stdout.trim())
          if (r.ok && Number.isFinite(d)) {
            v.duration = d
            changed = true
          }
        }
        const poster = posterFile(dir, v)
        if (!existsSync(poster)) {
          const at = Math.max(v.duration * 0.5, 0)
          const r = await exec('ffmpeg', ['-v', 'error', '-y', '-ss', at.toFixed(2), '-i', video, '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '3', poster])
          changed ||= r.ok
        }
      }
      if (changed) {
        writeVersions(dir, all)
        job({ type: 'posters', dir })
      }
    } finally {
      postersRunning.delete(dir)
    }
  })()
}

// ── Renderer output ───────────────────────────────────────────────

/** `npx --yes hyperframes …`: what every render and snapshot runs. */
function npx(args: string[]): { cmd: string; args: string[]; env: NodeJS.ProcessEnv } {
  const env: NodeJS.ProcessEnv = { ...toolEnv(), HYPERFRAMES_NO_UPDATE_CHECK: '1' }
  delete env.GEMINI_API_KEY
  return { cmd: 'npx', args: ['--yes', 'hyperframes', ...args], env }
}

export function stripAnsi(s: string): string {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '\x1b') {
      if (s[i + 1] === '[') {
        i += 2
        while (i < s.length && !/[A-Za-z]/.test(s[i])) i++
      }
      continue
    }
    out += c
  }
  return out
}

/** The last "NN%" in a line of CLI output. */
export function percent(line: string): number | null {
  let found: number | null = null
  for (const m of line.matchAll(/(\d+)%/g)) found = parseInt(m[1], 10)
  return found
}

/** One line of the renderer's stdout: its progress and stage, if it is a
 *  progress-bar line (others mention percentages too). */
export function progressOf(line: string): { percent: number; stage: string | null } | null {
  if (!line.includes('█') && !line.includes('░')) return null
  const p = percent(line)
  if (p == null) return null
  const stage = line.split('%')[1]?.trim() || null
  return { percent: p, stage }
}

/** Why a render failed: the last line that says so, from stderr then stdout's tail. */
export function failureOf(stderr: string, tail: string[]): string {
  const lines = [...stderr.split('\n'), ...tail].filter((l) => l.includes('rror') || l.includes('fail') || l.includes('Fail'))
  return (lines.pop() ?? 'The renderer stopped without a video').trim()
}

/** Splits a stream on \r and \n (progress bars redraw with \r on a
 *  terminal and \n into a pipe) and hands back clean, non-empty lines. */
export function lineSplitter(onLine: (line: string) => void): (chunk: string) => void {
  let pending = ''
  return (chunk) => {
    pending += chunk
    let i: number
    while ((i = pending.search(/[\r\n]/)) >= 0) {
      const line = stripAnsi(pending.slice(0, i)).trim()
      pending = pending.slice(i + 1)
      if (line) onLine(line)
    }
  }
}

// ── Export ────────────────────────────────────────────────────────

/** Settings ▸ Export quality as the CLI's -q flag. */
export function qualityFlag(s: Pick<Settings, 'export_quality'>): 'draft' | 'standard' | 'high' {
  return s.export_quality === 'draft' ? 'draft' : s.export_quality === 'high' ? 'high' : 'standard'
}

interface Render {
  child: ChildProcess | null
  /** The renderer's pid on the host (its first stdout line). */
  remotePid: number | null
  cancelled: boolean
}

/** One render per project at a time. */
const renders = new Map<string, Render>()

/** Render the project to .studio/versions/v<N>.mp4. */
async function renderNow(dir: string, r: Render): Promise<void> {
  const started = Date.now()
  const n = nextVersion(dir)
  const outDir = join(dir, '.studio/versions')
  mkdirSync(outDir, { recursive: true })
  const file = `v${n}.mp4`
  const out = join(outDir, file)
  const prefs = getSettings()
  const quality = qualityFlag(prefs)
  const fps = String(prefs.export_fps)
  const host = remote.hostOf(dir)
  let cmd: { cmd: string; args: string[]; env: NodeJS.ProcessEnv; cwd?: string }
  if (host) {
    // On a host: the latest edits there first, then render there.
    try {
      await remote.push(dir)
    } catch (e) {
      job({ type: 'failed', dir, error: `Could not reach ${host.host.name}: ${errText(e)}` })
      return
    }
    if (r.cancelled) {
      job({ type: 'failed', dir, error: 'Cancelled' })
      return
    }
    const args = ['HYPERFRAMES_NO_UPDATE_CHECK=1', 'npx', '--yes', 'hyperframes', 'render', '.', '-o', `.studio/versions/${file}`, '-q', quality, '-f', fps]
    try {
      cmd = { ...remote.remoteCommand(host.host, remote.remoteDir(host.host, host.name), 'env', args), env: toolEnv() }
    } catch (e) {
      job({ type: 'failed', dir, error: `Could not start the renderer: ${errText(e)}` })
      return
    }
  } else {
    cmd = { ...npx(['render', dir, '-o', out, '-q', quality, '-f', fps]), cwd: dir }
  }

  const tail: string[] = []
  let stderr = ''
  let last = 0
  // null: it never started (already said).
  const code = await new Promise<number | null>((resolve) => {
    let child: ChildProcess
    try {
      // Its own process group: cancelling stops npx and the browser it runs.
      child = spawn(cmd.cmd, cmd.args, { cwd: cmd.cwd, env: cmd.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    } catch (e) {
      job({ type: 'failed', dir, error: `Could not start the renderer: ${errText(e)}` })
      resolve(null)
      return
    }
    r.child = child
    let startFailed = false
    child.on('error', (e) => {
      startFailed = true
      job({ type: 'failed', dir, error: `Could not start the renderer: ${e.message}` })
      resolve(null)
    })
    const feed = lineSplitter((line) => {
      const pid = host ? remote.pidLine(line) : null
      if (pid != null && r.remotePid == null) {
        r.remotePid = pid
        return
      }
      const p = progressOf(line)
      if (p) {
        if (p.percent !== last && p.percent <= 100) {
          last = p.percent
          job({ type: 'progress', dir, percent: p.percent })
        }
        if (p.stage) job({ type: 'stage', dir, text: p.stage })
      }
      tail.push(line)
      if (tail.length > 12) tail.shift()
    })
    child.stdout?.setEncoding('utf8').on('data', feed)
    child.stderr?.setEncoding('utf8').on('data', (s: string) => (stderr += s))
    // Killed by a signal reads as a failed exit, not as never started.
    child.on('close', (c) => {
      if (!startFailed) resolve(c ?? -1)
    })
  })
  r.child = null
  if (code === null) return
  if (r.cancelled) {
    rmSync(out, { force: true })
    job({ type: 'failed', dir, error: 'Cancelled' })
    return
  }
  // Rendered on a host: bring the video here.
  if (host && code === 0) {
    job({ type: 'stage', dir, text: 'Bringing the video over' })
    try {
      await remote.fetch(dir, `.studio/versions/${file}`)
    } catch (e) {
      job({ type: 'failed', dir, error: `Rendered, but could not bring it over: ${errText(e)}` })
      return
    }
  }
  if (code !== 0 || !existsSync(out)) {
    job({ type: 'failed', dir, error: failureOf(stripAnsi(stderr), tail) })
    return
  }
  const v: Version = {
    n,
    file,
    created_at: now(),
    bytes: statSync(out).size,
    render_seconds: (Date.now() - started) / 1000,
    duration: 0
  }
  addVersion(dir, v)
  job({ type: 'rendered', dir, version: v })
  posters(dir)
}

function cancelNow(r: Render, dir: string): void {
  r.cancelled = true
  const c = r.child
  if (c?.pid != null) {
    try {
      process.kill(-c.pid, 'SIGTERM')
    } catch {
      c.kill('SIGTERM')
    }
  }
  // Closing ssh does not end a program on the host.
  const host = remote.hostOf(dir)
  if (host && r.remotePid != null) remote.kill(host.host, r.remotePid)
}

// ── Frames ────────────────────────────────────────────────────────

export const framesRoot = (dir: string): string => join(dir, '.studio/frames')

const isFrame = (n: string): boolean => n.startsWith('frame-') && n.endsWith('.png')

function list(p: string): string[] {
  try {
    return readdirSync(p)
  } catch {
    return []
  }
}

/** The newest set of filmstrip frames, if any, and its stamp. */
export function currentFrames(dir: string): { files: string[]; stamp: number } {
  const sets = list(framesRoot(dir))
    .filter((n) => /^\d+$/.test(n))
    .map((n) => Number(n))
    .sort((a, b) => a - b)
  const stamp = sets.pop()
  if (stamp == null) return { files: [], stamp: 0 }
  const set = join(framesRoot(dir), String(stamp))
  const files = list(set).filter(isFrame).sort().map((n) => join(set, n))
  return { files, stamp }
}

/** The newest time any file of the composition changed (what frames go stale against). */
export function contentMtime(dir: string): number {
  let best = 0
  const walk = (p: string, depth: number): void => {
    let entries
    try {
      entries = readdirSync(p, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const n = e.name
      if (n.startsWith('.') || n === 'node_modules' || n === 'renders' || n === 'snapshots') continue
      const path = join(p, n)
      let st
      try {
        st = statSync(path)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        if (depth < 4) walk(path, depth + 1)
      } else best = Math.max(best, Math.floor(st.mtimeMs / 1000))
    }
  }
  walk(dir, 0)
  return best
}

/** Whether the frames on disk need remaking. (On a host the files are
 *  there: only a missing set is remade; a new page asks again.) */
export function framesStale(dir: string, onHost: boolean): boolean {
  const { files, stamp } = currentFrames(dir)
  return files.length === 0 || (!onHost && stamp < contentMtime(dir))
}

/** The times of `count` frames: the middle of each slot. */
export function frameTimes(duration: number, count: number): string[] {
  return Array.from({ length: count }, (_, i) => (((i + 0.5) * duration) / count).toFixed(3))
}

/** Snapshot frames at `at` (comma-separated seconds) into `rel` under the
 *  project: on its host when it has one (and brought here). */
async function snapshot(dir: string, at: string, rel: string): Promise<boolean> {
  if (remote.hostOf(dir)) {
    try {
      await remote.snapshot(dir, at, rel)
      return true
    } catch {
      return false
    }
  }
  const c = npx(['snapshot', dir, '--no-end', '--at', at, '-o', join(dir, rel)])
  return (await exec(c.cmd, c.args, { cwd: dir, env: c.env })).ok
}

const framesBusy = new Map<string, { duration: number; count: number }>()

/** Snapshot `count` frames into a fresh set under .studio/frames/<stamp>/,
 *  then drop the older sets. Made again if the video changed meanwhile. */
async function makeFrames(dir: string, duration: number, count: number): Promise<void> {
  try {
    for (;;) {
      const stamp = now()
      const root = framesRoot(dir)
      const out = join(root, String(stamp))
      mkdirSync(out, { recursive: true })
      const ok = await snapshot(dir, frameTimes(duration, count).join(','), `.studio/frames/${stamp}`)
      const got = currentFrames(dir)
      if (!ok || got.stamp !== stamp || got.files.length === 0) {
        rmSync(out, { recursive: true, force: true })
        // Not a 'failed' job: that is the export's. The filmstrip just stays as it was.
        console.error('frames: could not make the timeline frames')
        return
      }
      // Older sets are this app's cache.
      for (const n of list(root)) if (n !== String(stamp)) rmSync(join(root, n), { recursive: true, force: true })
      job({ type: 'frames', dir, files: got.files })
      // Asked again while these were made (another length or count), or changed since.
      const again = framesBusy.get(dir)!
      const onHost = !!remote.hostOf(dir)
      if (again.duration === duration && again.count === count && !(!onHost && stamp < contentMtime(dir))) return
      ;({ duration, count } = again)
    }
  } finally {
    framesBusy.delete(dir)
  }
}

// ── Drawing on a frame ────────────────────────────────────────────

/** The pen's colour. */
export const PEN: [number, number, number] = [0xff, 0x4f, 0x9a]

/** A filled, soft-edged disc in the pen's colour on a 4-byte-per-pixel
 *  bitmap (`bgra`: Electron's native order on macOS). */
export function dot(img: Uint8Array, w: number, h: number, cx: number, cy: number, r: number, order: 'rgba' | 'bgra' = 'rgba'): void {
  const x0 = Math.max(Math.floor(cx - r), 0)
  const x1 = Math.min(Math.ceil(cx + r), w - 1)
  const y0 = Math.max(Math.floor(cy - r), 0)
  const y1 = Math.min(Math.ceil(cy + r), h - 1)
  const color = order === 'rgba' ? PEN : [PEN[2], PEN[1], PEN[0]]
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy)
      const a = Math.min(Math.max(r - d + 0.5, 0), 1)
      if (a <= 0) continue
      const i = (y * w + x) * 4
      for (let k = 0; k < 3; k++) img[i + k] = Math.trunc(img[i + k] * (1 - a) + color[k] * a)
      img[i + 3] = 255
    }
  }
}

/** Burn pen strokes (in composition pixels, scaled by sx/sy) into a bitmap. */
export function drawStrokes(img: Uint8Array, w: number, h: number, strokes: [number, number][][], sx: number, sy: number, order: 'rgba' | 'bgra' = 'rgba'): void {
  const radius = Math.max(w / 240, 3)
  for (const s of strokes) {
    const pts = (Array.isArray(s) ? s : [])
      .filter((p) => Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number')
      .map(([x, y]) => [x * sx, y * sy] as const)
    for (let i = 0; i + 1 < pts.length; i++) {
      const [x0, y0] = pts[i]
      const [x1, y1] = pts[i + 1]
      const steps = Math.max(Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (radius / 3)), 1)
      for (let k = 0; k <= steps; k++) {
        const f = k / steps
        dot(img, w, h, x0 + (x1 - x0) * f, y0 + (y1 - y0) * f, radius, order)
      }
    }
  }
}

/** data-width / data-height of the root composition in index.html. */
export function compositionSize(dir: string): [number, number] | null {
  let html: string
  try {
    html = readFileSync(join(dir, 'index.html'), 'utf8')
  } catch {
    return null
  }
  const attr = (name: string): number | null => {
    const i = html.indexOf(`${name}="`)
    if (i < 0) return null
    const v = html.slice(i + name.length + 2).split('"')[0]
    return num(v)
  }
  const w = attr('data-width')
  const h = attr('data-height')
  return w != null && h != null ? [w, h] : null
}

function num(s: string): number | null {
  return /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s) ? Number(s) : null
}

/** The frame at `t` with the user's pen strokes burned in, saved under
 *  .studio/annotations/ for the agent to look at. Strokes are in composition
 *  pixels; the frame is rendered by the same CLI as everything else. */
async function annotateNow(dir: string, t: number, strokes: [number, number][][]): Promise<string> {
  const id = `${now()}-${randomUUID().slice(0, 4)}`
  const root = join(dir, '.studio/annotations')
  const work = join(root, `.${id}`)
  mkdirSync(work, { recursive: true })
  try {
    const ok = await snapshot(dir, t.toFixed(3), `.studio/annotations/.${id}`)
    const frame = list(work).find(isFrame)
    if (!ok || !frame) throw new Error('Could not render that frame')
    // Electron decodes and encodes the PNG (no image library needed).
    const { nativeImage } = await import('electron')
    const img = nativeImage.createFromPath(join(work, frame))
    if (img.isEmpty()) throw new Error('Could not read that frame')
    const { width: w, height: h } = img.getSize()
    const bmp = img.toBitmap()
    // Strokes were measured against the composition's own size.
    const [cw, ch] = compositionSize(dir) ?? [w, h]
    drawStrokes(bmp, w, h, strokes, w / cw, h / ch, 'bgra')
    const out = join(root, `${id}.png`)
    writeFileSync(out, nativeImage.createFromBitmap(bmp, { width: w, height: h }).toPNG())
    writeFileSync(join(root, `${id}.json`), JSON.stringify({ time: t, strokes }))
    return out
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

// ── Library ───────────────────────────────────────────────────────

/** A folder's items: folders first, then by name (ignoring case). */
export function library(dir: string): LibraryItem[] {
  const out: LibraryItem[] = []
  for (const name of list(dir)) {
    if (name.startsWith('.')) continue
    try {
      const st = statSync(join(dir, name))
      out.push({ path: join(dir, name), name, is_dir: st.isDirectory(), bytes: st.size })
    } catch {}
  }
  const lower = (s: string): string => s.toLowerCase()
  return out.sort((a, b) => Number(b.is_dir) - Number(a.is_dir) || (lower(a.name) < lower(b.name) ? -1 : lower(a.name) > lower(b.name) ? 1 : 0))
}

/** Copy files (or folders) into a folder, never overwriting: "logo 2.png".
 *  Returns the names they got there (one per file copied). */
export function copyInto(lib: string, files: string[]): string[] {
  mkdirSync(lib, { recursive: true })
  const names: string[] = []
  for (const f of files) {
    const name = basename(f)
    if (!name || !existsSync(f)) continue
    let dest = join(lib, name)
    const ext = extname(name)
    const stem = ext ? name.slice(0, -ext.length) : name
    for (let k = 2; existsSync(dest); k++) dest = join(lib, `${stem || 'file'} ${k}${ext}`)
    try {
      if (statSync(f).isDirectory()) cpSync(f, dest, { recursive: true })
      else copyFileSync(f, dest)
      names.push(basename(dest))
    } catch {
      rmSync(dest, { recursive: true, force: true })
    }
  }
  return names
}

/** Copy files the user picked into the library folder (never overwriting). */
export function addToLibrary(lib: string, files: string[]): number {
  return copyInto(lib, files).length
}

// ── Formatting helpers (the Versions and Library lists) ──────────

export function size(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`
  return `${Math.max(bytes / 1e3, 1).toFixed(0)} KB`
}

export function ago(ts: number): string {
  const d = Math.max(now() - ts, 0)
  if (d < 60) return 'just now'
  if (d < 3600) return `${Math.floor(d / 60)} min ago`
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`
  return `${Math.floor(d / 86400)} d ago`
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

// ── The API ───────────────────────────────────────────────────────

export const review: Api['review'] = {
  async comments(dir) {
    return loadComments(dir)
  },
  async saveComments(dir, comments) {
    saveComments(dir, comments)
  },
  async versions(dir) {
    // Missing posters and lengths are made behind it ('posters' when ready).
    posters(dir)
    return loadVersions(dir)
  },
  async render(dir) {
    if (renders.has(dir)) return
    const r: Render = { child: null, remotePid: null, cancelled: false }
    renders.set(dir, r)
    job({ type: 'stage', dir, text: 'Starting' })
    void renderNow(dir, r)
      .catch((e) => job({ type: 'failed', dir, error: errText(e) }))
      .finally(() => renders.delete(dir))
  },
  async cancelRender(dir) {
    const r = renders.get(dir)
    if (r) cancelNow(r, dir)
  },
  async frames(dir, duration, count) {
    const { files } = currentFrames(dir)
    if (!getSettings().filmstrip || duration <= 0 || count < 1) return files
    count = Math.max(Math.round(count), 1)
    const busy = framesBusy.get(dir)
    if (busy) {
      // Remade with these once the running set is done.
      framesBusy.set(dir, { duration, count })
      return files
    }
    // Frames from before are shown at once; remade when the video changed
    // since, but not while an agent is still changing it.
    if (!framesStale(dir, !!remote.hostOf(dir)) || (await anyWorking())) return files
    framesBusy.set(dir, { duration, count })
    void makeFrames(dir, duration, count)
    return files
  },
  async annotate(dir, t, strokes) {
    const file = await annotateNow(dir, t, strokes)
    job({ type: 'annotated', dir, file })
    return file
  },
  async library() {
    return library(libraryDir())
  },
  async addToLibrary(files) {
    return addToLibrary(libraryDir(), files)
  },
  async importFiles(dir, files) {
    // Into the project's assets/, named as the agent will see them.
    return copyInto(join(dir, 'assets'), files).map((n) => `assets/${n}`)
  }
}
