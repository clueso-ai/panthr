// Projects are folders under ~/Panthr (the library is ~/Panthr/Library).
// Each keeps its app state in .studio/: project.json (name, chats,
// settings), chats/<id>.json (the transcript as shown), controls.json,
// comments.json, versions/ (exports). Port of studio-mac/src/project.rs
// (and of what studio.rs / home.rs do with projects).

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import type { Api } from '@shared/api'
import type { ChatMeta, Engine, Project, ProjectMeta } from '@shared/types'
import { dataDir, libraryDir, now, studioRoot } from './paths'
import { readJson, writeJson } from './json'
import { emit } from './bus'
import { getSettings } from './settings'
import { previewUrl } from './preview'
import * as remote from './remote'

export const metaPath = (dir: string): string => join(dir, '.studio', 'project.json')
export const chatPath = (dir: string, chatId: string): string => join(dir, '.studio', 'chats', `${chatId}.json`)

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** project.json as Rust's serde reads it: name and created_at required,
 *  the rest defaulted (agents on, no chats, no models). Null when broken. */
export function parseMeta(raw: unknown): ProjectMeta | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const m = raw as Record<string, any>
  if (typeof m.name !== 'string' || typeof m.created_at !== 'number') return null
  if (m.chats != null && !Array.isArray(m.chats)) return null
  const chats: ChatMeta[] = []
  for (const c of m.chats ?? []) {
    if (!c || typeof c.id !== 'string' || typeof c.title !== 'string' || typeof c.created_at !== 'number') return null
    chats.push({ id: c.id, title: c.title, session_id: c.session_id ?? null, created_at: c.created_at, engine: c.engine ?? null })
  }
  const models: Partial<Record<Engine, string>> = {}
  if (m.models && typeof m.models === 'object') {
    for (const [k, v] of Object.entries(m.models)) if (typeof v === 'string') models[k as Engine] = v
  }
  return { name: m.name, created_at: m.created_at, chats, agents_enabled: m.agents_enabled ?? true, models }
}

/** The meta in Rust's field order (so both apps write the same bytes):
 *  every ChatMeta field present, models sorted (a BTreeMap). */
export function normalMeta(m: ProjectMeta): ProjectMeta {
  const models: Partial<Record<Engine, string>> = {}
  for (const k of Object.keys(m.models ?? {}).sort()) models[k as Engine] = m.models[k as Engine]
  return {
    name: m.name,
    created_at: m.created_at,
    chats: (m.chats ?? []).map((c) => ({ id: c.id, title: c.title, session_id: c.session_id ?? null, created_at: c.created_at, engine: c.engine ?? null })),
    agents_enabled: m.agents_enabled ?? true,
    models
  }
}

/** A project's meta, or a fresh one for a folder with an index.html but no
 *  metadata yet (adopted; nothing is written). Null: not a project. */
export function loadMeta(dir: string): ProjectMeta | null {
  if (!isDir(dir) || basename(dir) === 'Library') return null
  let text: string
  try {
    text = readFileSync(metaPath(dir), 'utf8')
  } catch {
    if (!existsSync(join(dir, 'index.html'))) return null
    return { name: basename(dir), created_at: now(), chats: [], agents_enabled: true, models: {} }
  }
  try {
    return parseMeta(JSON.parse(text))
  } catch {
    return null
  }
}

export function saveMetaFile(dir: string, meta: ProjectMeta): void {
  writeJson(metaPath(dir), normalMeta(meta))
}

/** Change a project's saved meta (read fresh, so others' changes stay). */
export function updateMeta(dir: string, f: (m: ProjectMeta) => void): ProjectMeta | null {
  const m = loadMeta(dir)
  if (!m) return null
  f(m)
  saveMetaFile(dir, m)
  return m
}

/** A new chat, saved with the project. */
export function newChat(dir: string, title: string, engine: Engine | null = null): ChatMeta | null {
  const c: ChatMeta = { id: randomUUID(), title, session_id: null, created_at: now(), engine }
  return updateMeta(dir, (m) => m.chats.push(c)) ? c : null
}

// ── What Home shows ────────────────────────────────────────────────

/** The newest set of filmstrip frames (.studio/frames/<stamp>/frame-*.png). */
export function currentFrames(dir: string): string[] {
  const root = join(dir, '.studio', 'frames')
  let sets: [number, string][]
  try {
    sets = readdirSync(root)
      .filter((n) => /^\d+$/.test(n))
      .map((n) => [Number(n), join(root, n)] as [number, string])
  } catch {
    return []
  }
  sets.sort((a, b) => a[0] - b[0])
  const set = sets.pop()
  if (!set) return []
  try {
    return readdirSync(set[1])
      .filter((n) => n.startsWith('frame-') && n.endsWith('.png'))
      .sort()
      .map((n) => join(set[1], n))
  } catch {
    return []
  }
}

/** A poster: a frame a third in (as Home's card shows when not hovered),
 *  else the newest version's poster, else the newest snapshot. */
export function thumbOf(dir: string): string | null {
  const frames = currentFrames(dir)
  if (frames.length) return frames[Math.floor(frames.length / 3)]
  const newest = (folder: string, pick: (n: string) => number | null): string | null => {
    let best: [number, string] | null = null
    try {
      for (const n of readdirSync(folder)) {
        const k = pick(n)
        if (k != null && (!best || k > best[0])) best = [k, join(folder, n)]
      }
    } catch {}
    return best?.[1] ?? null
  }
  const poster = newest(join(dir, '.studio', 'versions'), (n) => {
    const m = /^v(\d+)\.jpg$/.exec(n)
    return m ? Number(m[1]) : null
  })
  if (poster) return poster
  const snaps = join(dir, '.studio', 'snapshots')
  return newest(snaps, (n) => {
    if (!/\.(png|jpe?g|webp)$/i.test(n)) return null
    try {
      return statSync(join(snaps, n)).mtimeMs
    } catch {
      return null
    }
  })
}

/** The newest time any file of the composition changed (seconds); review.rs content_mtime. */
export function contentMtime(dir: string): number {
  let best = 0
  const walk = (p: string, depth: number): void => {
    let names: string[]
    try {
      names = readdirSync(p)
    } catch {
      return
    }
    for (const n of names) {
      if (n.startsWith('.') || n === 'node_modules' || n === 'renders' || n === 'snapshots') continue
      const path = join(p, n)
      try {
        const st = statSync(path)
        if (st.isDirectory()) {
          if (depth < 4) walk(path, depth + 1)
        } else best = Math.max(best, Math.floor(st.mtimeMs / 1000))
      } catch {}
    }
  }
  walk(dir, 0)
  return best
}

export function load(dir: string): Project | null {
  const meta = loadMeta(dir)
  if (!meta) return null
  return { dir, meta, host: remote.hostOf(dir)?.host.name ?? null, thumb: thumbOf(dir), edited_at: contentMtime(dir) }
}

// ── Creating ──────────────────────────────────────────────────────

export const STARTER = `<!doctype html>
<html><head><meta charset="utf-8">
<style>
  html,body{margin:0;background:#000}
  #root{position:relative;width:1920px;height:1080px;overflow:hidden;background:#0b0b0f;color:#fff;font-family:-apple-system,Helvetica,sans-serif}
  #hint{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:56px;color:#5b5b66}
</style></head>
<body>
<div id="root" data-composition-id="main" data-start="0" data-duration="5" data-width="1920" data-height="1080">
  <div id="hint">Describe your video in the chat</div>
</div>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js"></script>
<script>
  const tl = gsap.timeline({ paused: true });
  tl.to({}, { duration: 5 });
  window.__timelines = window.__timelines || {};
  window.__timelines["main"] = tl;
</script>
</body></html>
`

/** A folder name from a project name: letters, digits, spaces, dashes. */
export function folderName(name: string): string {
  const base = Array.from(name)
    .map((c) => (/[\p{Alphabetic}\p{N}]/u.test(c) || c === ' ' || c === '-' ? c : '-'))
    .join('')
    .trim()
  return base || 'Untitled'
}

/** A new project in `root` with a playable empty composition. */
export function createIn(root: string, name: string): Project {
  mkdirSync(root, { recursive: true })
  const base = folderName(name)
  let dir = join(root, base)
  for (let n = 2; existsSync(dir); n++) dir = join(root, `${base} ${n}`)
  mkdirSync(join(dir, 'assets'), { recursive: true })
  mkdirSync(join(dir, 'compositions'), { recursive: true })
  writeFileSync(join(dir, 'index.html'), STARTER)
  const meta: ProjectMeta = { name: basename(dir), created_at: now(), chats: [], agents_enabled: true, models: {} }
  saveMetaFile(dir, meta)
  return { dir, meta, host: null, thumb: null, edited_at: contentMtime(dir) }
}

// ── Opened folders and the list ───────────────────────────────────

/** Folders opened from elsewhere on disk (File ▸ Open Folder…). */
const openedPath = (): string => join(dataDir(), 'opened.json')
const opened = (): string[] => readJson<string[]>(openedPath(), [])

const inside = (p: string, root: string): boolean => {
  const a = resolve(p)
  const r = resolve(root)
  return a === r || a.startsWith(r + sep)
}

/** Adopt a folder outside ~/Panthr as a project (it needs an index.html). */
export function openFolder(dir: string): Project | null {
  const meta = loadMeta(dir)
  if (!meta) return null
  if (!existsSync(metaPath(dir))) saveMetaFile(dir, meta)
  if (!inside(dir, studioRoot())) {
    const all = opened()
    if (!all.includes(dir)) writeJson(openedPath(), [...all, dir])
  }
  return load(dir)
}

const subdirs = (root: string): string[] => {
  try {
    return readdirSync(root).map((n) => join(root, n))
  } catch {
    return []
  }
}

/** Every project, newest first: ~/Panthr's, folders opened from elsewhere,
 *  and hosts' projects as last brought over (their mirrors). */
export function list(): Project[] {
  mkdirSync(libraryDir(), { recursive: true })
  const dirs = [...subdirs(studioRoot()), ...opened()]
  const mirrors = remote.mirrors()
  if (mirrors) for (const h of remote.hosts()) dirs.push(...subdirs(join(mirrors, remote.slug(h.name))))
  const out = dirs.map(load).filter((p): p is Project => p !== null)
  // Stable, like Rust's sort_by: equal times keep their order.
  return out.sort((a, b) => b.meta.created_at - a.meta.created_at)
}

// ── Watching ──────────────────────────────────────────────────────

/** Changes that do not reload the preview (studio.rs `ignored`). */
export function ignored(rel: string): boolean {
  return rel.split(/[\\/]/).some((c) => c === '.studio' || c === 'node_modules' || c === 'renders' || c === 'snapshots' || c === '.git' || c.startsWith('.hyperframes'))
}

/** .studio files whose changes the window wants to hear about (the agent
 *  writing controls, comments, versions): studio.rs's Meta events. */
const META_FILES = new Set(['.studio/controls.json', '.studio/comments.json', '.studio/versions.json'])

const watchers = new Map<string, { w: FSWatcher; timer: NodeJS.Timeout | null; files: Set<string> }>()

/** Projects on hosts: their page's stamp there, checked every second
 *  (the files change there, so there is nothing here to watch). */
const polls = new Map<string, { timer: NodeJS.Timeout; stamp: string | null }>()

function pollRemote(dir: string): void {
  const p = { stamp: null as string | null, timer: setInterval(async () => {
    const st = await remote.liveStamp(dir).catch(() => null)
    if (st === null) return
    if (p.stamp !== null && st !== p.stamp) emit('project:changed', { dir, files: ['index.html'] })
    p.stamp = st
  }, 1000) }
  polls.set(dir, p)
}

function unwatch(dir: string): void {
  const p = polls.get(dir)
  if (p) {
    clearInterval(p.timer)
    polls.delete(dir)
    // Its page server there is not needed while it is closed.
    remote.stopLive(dir)
  }
  const e = watchers.get(dir)
  if (!e) return
  e.w.close()
  if (e.timer) clearTimeout(e.timer)
  watchers.delete(dir)
}

function watchDir(dir: string): void {
  unwatch(dir)
  // A project on a host: its page there is checked instead.
  if (remote.hostOf(dir)) return pollRemote(dir)
  let w: FSWatcher
  try {
    w = watch(dir, { recursive: true })
  } catch {
    return
  }
  const e = { w, timer: null as NodeJS.Timeout | null, files: new Set<string>() }
  w.on('error', () => unwatch(dir))
  w.on('change', (_kind, name) => {
    if (name == null) return
    const rel = String(name).split(sep).join('/')
    if (ignored(rel) && !META_FILES.has(rel)) return
    e.files.add(rel)
    // Settle: an agent writes many files at once.
    if (e.timer) clearTimeout(e.timer)
    e.timer = setTimeout(() => {
      e.timer = null
      const files = [...e.files]
      e.files.clear()
      emit('project:changed', { dir, files })
    }, 250)
  })
  watchers.set(dir, e)
}

// ── The API ───────────────────────────────────────────────────────

/** Keep the chats main owns (session ids, titles, engines written while
 *  the window held an older copy): the window's meta brings the rest. */
export function mergeMeta(dir: string, meta: ProjectMeta): ProjectMeta {
  const disk = loadMeta(dir)
  if (!disk || !existsSync(metaPath(dir))) return meta
  return { ...meta, chats: disk.chats }
}

export const projects: Api['projects'] = {
  async list() {
    return list()
  },
  async create(name, host) {
    const h = host ? remote.hosts().find((x) => x.name === host) : null
    if (host && !h) throw new Error(`No host named ${host}`)
    // Here, or on the host (made in its mirror, then sent over whole).
    const p = h ? createIn(join(remote.mirrors(), remote.slug(h.name)), name) : createIn(studioRoot(), name)
    // Settings ▸ Agents for new projects.
    p.meta.agents_enabled = getSettings().agents_default
    saveMetaFile(p.dir, p.meta)
    if (h) {
      try {
        await remote.pushAll(p.dir)
      } catch (e) {
        throw new Error(`Could not reach ${h.name}: ${(e as Error).message}`)
      }
    }
    return load(p.dir) ?? p
  },
  async load(dir) {
    return load(dir)
  },
  async saveMeta(dir, meta) {
    saveMetaFile(dir, mergeMeta(dir, meta))
  },
  async rename(dir, name) {
    const n = name.trim()
    if (n) updateMeta(dir, (m) => (m.name = n))
    const p = load(dir)
    if (!p) throw new Error(`Not a project: ${dir}`)
    return p
  },
  async openFolder(dir) {
    return openFolder(dir)
  },
  async previewUrl(dir) {
    return previewUrl(dir)
  },
  async watch(dir) {
    watchDir(dir)
  },
  async unwatch(dir) {
    unwatch(dir)
  }
}
