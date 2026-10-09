// Reference videos: a video someone wants to learn from or recreate, taken
// apart by their agent in whatever way it judges best (no fixed shape: notes,
// scene lists, palettes, code sketches, extracted assets...). Once ready it is
// mentioned in any chat as @handle, and the agent reads that folder.
//
//   ~/Panthr/References/<handle>/
//     meta.json        what the window shows (status, summary, size...)
//     source.<ext>     the video
//     poster.jpg       a frame a third of the way in
//     frames/          stills named by their time (t-0012.40.jpg), and one
//                      at each cut (cut-0004.10.jpg)
//     contact.jpg      the stills in one sheet
//     analysis.json    what ffmpeg could measure (length, size, cuts...)
//     README.md        the agent's index of what it wrote (and anything
//     ...              else it chose to write: no fixed shape)
//     summary.txt      its one-sentence summary

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { extname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import type { Api } from '@shared/api'
import type { Reference, RefFile } from '@shared/types'
import { emit } from './bus'
import { readJson, writeJson } from './json'
import { now, studioRoot, toolEnv } from './paths'
import { getSettings } from './settings'
import { claudeBin, parse as parseClaude } from './agents/claude'
import { codexBin, newRun, parse as parseCodex } from './agents/codex'

const run = promisify(execFile)

export const referencesDir = (): string => join(studioRoot(), 'References')

// ── Meta ──────────────────────────────────────────────────────────────

type Meta = Omit<Reference, 'dir' | 'poster' | 'video'>

const metaPath = (dir: string): string => join(dir, 'meta.json')

function withPaths(dir: string, m: Meta): Reference {
  const video = readdirSafe(dir).find((n) => n.startsWith('source.'))
  return {
    ...m,
    dir,
    poster: existsSync(join(dir, 'poster.jpg')) ? join(dir, 'poster.jpg') : null,
    video: video ? join(dir, video) : null
  }
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** The work under way (an import or an analysis), by id. */
const jobs = new Map<string, { child: ChildProcess | null; cancelled: boolean }>()

function load(dir: string): Reference | null {
  const m = readJson<Meta | null>(metaPath(dir), null)
  if (!m?.id) return null
  // Left half-done by a Panthr that quit: say so (it can be retried).
  if ((m.status === 'importing' || m.status === 'analyzing') && !jobs.has(m.id)) {
    m.status = 'failed'
    m.step = null
    m.error = 'Stopped before it finished.'
    writeJson(metaPath(dir), m)
  }
  return withPaths(dir, m)
}

export function list(): Reference[] {
  return readdirSafe(referencesDir())
    .map((n) => load(join(referencesDir(), n)))
    .filter((r): r is Reference => !!r)
    .sort((a, b) => b.created_at - a.created_at)
}

const find = (id: string): Reference | null => list().find((r) => r.id === id) ?? null

function update(dir: string, patch: Partial<Meta>): void {
  const m = { ...readJson<Meta>(metaPath(dir), {} as Meta), ...patch }
  writeJson(metaPath(dir), m)
  changed()
}

function changed(): void {
  try {
    emit('references', list())
  } catch {
    // No window (a test).
  }
}

/** A handle for @-mentions: lower case, letters, digits and dashes, unique. */
export function handleFor(name: string, taken: string[]): string {
  const base = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'video'
  let h = base
  for (let i = 2; taken.includes(h); i++) h = `${base}-${i}`
  return h
}

const isLink = (s: string): boolean => /^https?:\/\//i.test(s.trim())

/** A readable name from a file or a link. */
export function nameFrom(input: string): string {
  const s = input.trim()
  if (isLink(s)) {
    try {
      const u = new URL(s)
      const last = u.pathname.split('/').filter(Boolean).pop()
      return `${u.hostname.replace(/^www\./, '')}${last ? ` ${decodeURIComponent(last)}` : ''}`.slice(0, 60)
    } catch {
      return 'Video'
    }
  }
  return (s.split('/').pop() ?? 'Video').replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim() || 'Video'
}

// ── Mentions ──────────────────────────────────────────────────────────

/** The @handles in a message that name a reference ready to use. */
export function mentioned(text: string, refs: Reference[]): Reference[] {
  const handles = new Set([...text.matchAll(/(?:^|[^\w@])@([a-z0-9][a-z0-9_-]*)/gi)].map((m) => m[1].toLowerCase()))
  return refs.filter((r) => handles.has(r.handle) && r.status === 'ready')
}

/** A message as the agent gets it: what was typed, then where each
 *  mentioned reference's breakdown and frames are. */
export function expandMentions(text: string, refs: Reference[] = list()): string {
  const hit = mentioned(text, refs)
  if (!hit.length) return text
  const lines = hit.map((r) =>
    `- @${r.handle} ("${r.name}"): its folder is ${r.dir}. Start with README.md there, which says what each file holds; the stills are in frames/ (named by their time)${r.video ? ` and the video is ${r.video}` : ''}.`
  )
  return `${text}\n\nReference videos mentioned above (already taken apart by an agent; use them as the message asks):\n${lines.join('\n')}`
}

// ── Import and analysis ───────────────────────────────────────────────

async function has(tool: string): Promise<boolean> {
  try {
    await run('/bin/sh', ['-c', `command -v ${tool}`], { env: toolEnv() })
    return true
  } catch {
    return false
  }
}

async function bring(input: string, dir: string): Promise<void> {
  const s = input.trim()
  if (isLink(s)) {
    if (!(await has('yt-dlp'))) throw new Error('To add a link, install yt-dlp (brew install yt-dlp), or drop the video file in instead.')
    await run('yt-dlp', ['-f', 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b', '--merge-output-format', 'mp4', '--no-playlist', '-o', join(dir, 'source.%(ext)s'), s], { env: toolEnv(), maxBuffer: 16 << 20 })
    return
  }
  if (!existsSync(s)) throw new Error(`No file at ${s}`)
  copyFileSync(s, join(dir, `source${extname(s).toLowerCase() || '.mp4'}`))
}

export interface Probe {
  duration: number
  width: number
  height: number
  fps: number
  hasAudio: boolean
}

export function parseProbe(json: string): Probe {
  const v = JSON.parse(json) as { format?: { duration?: string }; streams?: { codec_type?: string; width?: number; height?: number; r_frame_rate?: string }[] }
  const video = v.streams?.find((s) => s.codec_type === 'video')
  const [a, b] = (video?.r_frame_rate ?? '0/1').split('/').map(Number)
  return {
    duration: Math.max(0, Number(v.format?.duration ?? 0)),
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    fps: b ? Math.round((a / b) * 100) / 100 : 0,
    hasAudio: !!v.streams?.some((s) => s.codec_type === 'audio')
  }
}

/** The times of the stills: evenly through the video, one every ~1.5 s,
 *  between 12 and 36 of them. */
export function stillTimes(duration: number): number[] {
  const n = Math.min(36, Math.max(12, Math.round(duration / 1.5)))
  return Array.from({ length: n }, (_, i) => Math.round(((i + 0.5) * duration * 100) / n) / 100)
}

/** Cut times from ffmpeg's scene detection (showinfo's pts_time). */
export function parseCuts(stderr: string): number[] {
  return [...stderr.matchAll(/pts_time:([\d.]+)/g)].map((m) => Math.round(Number(m[1]) * 100) / 100).filter((t, i, a) => i === 0 || t - a[i - 1] > 0.2)
}

const stamp = (t: number): string => t.toFixed(2).padStart(7, '0')

async function ff(args: string[]): Promise<string> {
  const { stderr } = await run('ffmpeg', ['-hide_banner', '-y', ...args], { env: toolEnv(), maxBuffer: 64 << 20 })
  return stderr
}

async function prepare(dir: string, video: string): Promise<Probe & { cuts: number[] }> {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height,r_frame_rate', '-of', 'json', video], { env: toolEnv() })
  const p = parseProbe(stdout)
  if (!p.duration || !p.width) throw new Error("That file doesn't look like a video ffmpeg can read.")
  const frames = join(dir, 'frames')
  rmSync(frames, { recursive: true, force: true })
  mkdirSync(frames, { recursive: true })
  const times = stillTimes(p.duration)
  for (const t of times) await ff(['-ss', String(t), '-i', video, '-frames:v', '1', '-vf', 'scale=768:-2', '-q:v', '4', join(frames, `t-${stamp(t)}.jpg`)])
  let cuts: number[] = []
  try {
    cuts = parseCuts(await ff(['-i', video, '-vf', "select='gt(scene,0.32)',showinfo", '-an', '-f', 'null', '-'])).slice(0, 60)
  } catch {}
  for (const t of cuts.slice(0, 24)) {
    const at = Math.min(p.duration - 0.05, t + 0.15)
    await ff(['-ss', String(at), '-i', video, '-frames:v', '1', '-vf', 'scale=768:-2', '-q:v', '4', join(frames, `cut-${stamp(t)}.jpg`)]).catch(() => '')
  }
  const cols = 6
  const rows = Math.ceil(times.length / cols)
  await ff(['-pattern_type', 'glob', '-i', join(frames, 't-*.jpg'), '-vf', `scale=320:-2,tile=${cols}x${rows}:padding=4:color=black`, '-frames:v', '1', join(dir, 'contact.jpg')]).catch(() => '')
  await ff(['-ss', String(p.duration / 3), '-i', video, '-frames:v', '1', '-vf', 'scale=960:-2', '-q:v', '3', join(dir, 'poster.jpg')]).catch(() => '')
  writeJson(join(dir, 'analysis.json'), {
    ...p,
    cuts,
    stills: times.map((t) => ({ file: `frames/t-${stamp(t)}.jpg`, time: t })),
    cut_stills: cuts.slice(0, 24).map((t) => ({ file: `frames/cut-${stamp(t)}.jpg`, time: t }))
  })
  return { ...p, cuts }
}

/** What the agent is asked to do with a reference's folder: take it apart
 *  however serves recreating it. No fixed shape. */
export function deconstructPrompt(name: string): string {
  return `Take apart this reference video ("${name}") so that another agent, later, can recreate it (or borrow from it) as a HyperFrames composition (HTML, CSS, GSAP). You are in its folder.

What is here to work from:
- the video itself (source.*)
- analysis.json: its length, size, frame rate, whether it has sound, and the scene cuts ffmpeg found
- frames/: stills named by their time (t-0012.40.jpg is at 12.40 s), and one just after each cut (cut-...jpg). Open and look at them.
- contact.jpg: the evenly spaced stills on one sheet

Decompose it however you judge best captures it: there is no required format. Write as many files and folders as help (notes, a scene-by-scene breakdown, timing maps, palettes, type specimens, motion studies, code sketches, assets you crop out of frames...). Be concrete: times, sizes, hex values, eases.

When you are done:
- write README.md: what this video is and what each file you wrote holds, so the next agent knows where to start
- write summary.txt: one sentence (under 25 words) on what the video is

Leave the video, frames/, contact.jpg and analysis.json as they are.`
}

function argsFor(engine: 'claude' | 'codex', model: string, prompt: string, dir: string): { cmd: string; args: string[] } {
  if (engine === 'codex') {
    const images = ['contact.jpg', ...readdirSafe(join(dir, 'frames')).filter((n) => n.startsWith('cut-')).slice(0, 8).map((n) => `frames/${n}`)].filter((f) => existsSync(join(dir, f)))
    const args = ['exec', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="workspace-write"']
    for (const i of images) args.push('-i', i)
    if (model && model !== 'default') args.push('-m', model)
    args.push(prompt)
    return { cmd: codexBin(), args }
  }
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--allowedTools', 'Read,Write,Edit,Glob,Grep,Bash']
  if (model && model !== 'default') args.push('--model', model)
  return { cmd: claudeBin(), args }
}

/** Run the agent in the reference's folder until it has written the breakdown. */
function deconstruct(r: Reference): Promise<void> {
  const s = getSettings()
  const engine = s.agent
  const model = engine === 'codex' ? s.codex_model : s.model
  const { cmd, args } = argsFor(engine, model, deconstructPrompt(r.name), r.dir)
  return new Promise((ok, fail) => {
    const child = spawn(cmd, args, { cwd: r.dir, env: toolEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
    const job = jobs.get(r.id)
    if (job) job.child = child
    const codexState = newRun()
    let err = ''
    let last = 0
    createInterface({ input: child.stdout! }).on('line', (line) => {
      const events = engine === 'codex' ? parseCodex(line, codexState) : parseClaude(line)
      for (const e of events) {
        // Its steps, as the reference's status (at most a few a second).
        if (e.type === 'tool' && e.summary && Date.now() - last > 300) {
          last = Date.now()
          update(r.dir, { step: e.summary.slice(0, 90) })
        }
      }
    })
    child.stderr!.on('data', (b: Buffer) => (err = (err + b.toString('utf8')).slice(-4000)))
    child.on('error', (e) => fail(new Error(`Could not start ${engine === 'codex' ? 'Codex' : 'Claude Code'}: ${e.message}`)))
    child.on('close', (code) => {
      if (jobs.get(r.id)?.cancelled) return fail(new Error('Cancelled'))
      if (existsSync(join(r.dir, 'README.md'))) return ok()
      const line = err.split('\n').map((l) => l.trim()).filter(Boolean).pop()
      fail(new Error(line || `The agent stopped (code ${code}) without writing its README.md.`))
    })
  })
}

async function work(r: Reference, input: string | null): Promise<void> {
  jobs.set(r.id, { child: null, cancelled: false })
  try {
    if (input !== null) {
      update(r.dir, { status: 'importing', step: 'Bringing the video in', error: null })
      await bring(input, r.dir)
    }
    const fresh = load(r.dir)!
    if (!fresh.video) throw new Error('The video is missing from its folder.')
    update(r.dir, { status: 'analyzing', step: 'Pulling stills and cuts', error: null })
    const p = await prepare(r.dir, fresh.video)
    update(r.dir, { duration: p.duration, width: p.width, height: p.height, step: 'Your agent is watching it' })
    rmSync(join(r.dir, 'README.md'), { force: true })
    await deconstruct(load(r.dir)!)
    let summary: string | null = null
    try {
      summary = readFileSync(join(r.dir, 'summary.txt'), 'utf8').trim().split('\n')[0].slice(0, 240) || null
    } catch {}
    update(r.dir, { status: 'ready', step: null, error: null, summary })
  } catch (e) {
    if (!jobs.get(r.id)?.cancelled && existsSync(r.dir)) update(r.dir, { status: 'failed', step: null, error: (e as Error).message })
  } finally {
    jobs.delete(r.id)
    changed()
  }
}

export async function add(input: string, name?: string): Promise<Reference> {
  const s = input.trim()
  if (!s) throw new Error('Give a video file or a link')
  const all = list()
  const nm = (name?.trim() || nameFrom(s)).slice(0, 80)
  const handle = handleFor(nm, all.map((r) => r.handle))
  const dir = join(referencesDir(), handle)
  mkdirSync(dir, { recursive: true })
  const meta: Meta = { id: randomBytes(4).toString('hex'), name: nm, handle, source: s, status: 'importing', step: 'Bringing the video in', error: null, created_at: now(), duration: 0, width: 0, height: 0, summary: null }
  writeJson(metaPath(dir), meta)
  const r = withPaths(dir, meta)
  jobs.set(r.id, { child: null, cancelled: false })
  changed()
  void work(r, s)
  return r
}

// ── Its files, as a tree ──────────────────────────────────────────────

const KIND: [RegExp, RefFile['kind']][] = [
  [/\.(md|markdown)$/i, 'markdown'], [/\.(png|jpe?g|webp|gif|svg)$/i, 'image'], [/\.(mp4|mov|webm|m4v)$/i, 'video'],
  [/\.(mp3|wav|m4a|aac)$/i, 'audio'], [/\.(json|js|mjs|ts|css|html?|txt|csv|ya?ml|py|sh)$/i, 'text']
]

/** Every file under a folder (depth-first, folders first), up to a limit. */
export function tree(dir: string, max = 600): RefFile[] {
  const out: RefFile[] = []
  const walk = (rel: string, depth: number): void => {
    let names: string[]
    try {
      names = readdirSync(join(dir, rel))
    } catch {
      return
    }
    const entries = names.filter((n) => !n.startsWith('.') && n !== 'meta.json').map((n) => {
      const p = join(dir, rel, n)
      let isDir = false
      let size = 0
      try {
        const st = statSync(p)
        isDir = st.isDirectory()
        size = st.size
      } catch {}
      return { n, isDir, size }
    })
    entries.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.n.localeCompare(b.n, undefined, { numeric: true }))
    for (const e of entries) {
      if (out.length >= max) return
      const path = rel ? `${rel}/${e.n}` : e.n
      out.push({ path, name: e.n, depth, dir: e.isDir, size: e.size, kind: e.isDir ? 'folder' : KIND.find(([r]) => r.test(e.n))?.[1] ?? 'other' })
      if (e.isDir && depth < 6) walk(path, depth + 1)
    }
  }
  walk('', 0)
  return out
}

/** A path inside a reference's folder (never outside it). */
function inside(dir: string, rel: string): string {
  if (isAbsolute(rel) || normalize(rel).split(sep).includes('..')) throw new Error('outside the reference')
  return resolve(dir, rel)
}

export const references: Api['references'] = {
  async list() {
    return list()
  },
  add,
  async remove(id) {
    const r = find(id)
    if (!r) return
    const j = jobs.get(id)
    if (j) {
      j.cancelled = true
      j.child?.kill('SIGKILL')
    }
    rmSync(r.dir, { recursive: true, force: true })
    changed()
  },
  async rename(id, name) {
    const r = find(id)
    if (!r) throw new Error('No such reference')
    const nm = name.trim().slice(0, 80) || r.name
    update(r.dir, { name: nm, handle: handleFor(nm, list().filter((x) => x.id !== id).map((x) => x.handle)) })
    return find(id)!
  },
  async retry(id) {
    const r = find(id)
    if (!r || jobs.has(id)) return
    void work(r, r.video ? null : r.source)
  },
  async files(id) {
    const r = find(id)
    return r ? tree(r.dir) : []
  },
  async readFile(id, rel) {
    const r = find(id)
    if (!r) return null
    const p = inside(r.dir, rel)
    try {
      if (statSync(p).size > 2 << 20) return null
      return readFileSync(p, 'utf8')
    } catch {
      return null
    }
  }
}

export function stopAllReferences(): void {
  for (const j of jobs.values()) {
    j.cancelled = true
    j.child?.kill('SIGKILL')
  }
}

export const _test = { writeFileSync }
