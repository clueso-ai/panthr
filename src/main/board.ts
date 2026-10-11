// Projects as canvases. A project is a folder holding an infinite canvas:
// its videos (each a folder with an index.html, usually a subfolder) and
// reference videos as tiles, with arrows from what each came from, and the
// project's one conversation, whose agent makes the videos (`panthr board
// new`) and shows them. The canvas lives in the folder (.studio/canvas.json),
// the conversation in its .studio/project.json, as a single video's did.
//
// A project from before canvases (a video folder at the top of ~/Panthr)
// becomes a project whose canvas holds that video, its first tile: nothing
// moves, and its chat becomes the project's conversation.

import { copyFileSync, existsSync, mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import type { Api } from '@shared/api'
import type { Board, BoardImport, BoardLink, BoardView, Canvas, Project } from '@shared/types'
import { emit } from './bus'
import { readJson, writeJson } from './json'
import { libraryDir, now, studioRoot } from './paths'
import { contentMtime, createIn, folderName, load, loadMeta, opened, saveMetaFile, thumbOf } from './projects'
import * as remote from './remote'
import { list as listReferences, references } from './references'
import { addToLibrary } from './review'
import { link as linkSkills } from './skills'

/** A tile's footprint on the canvas (the window draws it at this size). */
export const TILE = { w: 320, h: 230 }
const GAP = { x: 80, y: 60 }
const STEP = { x: TILE.w + GAP.x, y: TILE.h + GAP.y }

interface Stored {
  tiles: Record<string, { x: number; y: number }>
  links: BoardLink[]
  view: BoardView | null
}

const canvasFile = (dir: string): string => join(dir, '.studio', 'canvas.json')
export const isCanvas = (dir: string): boolean => existsSync(canvasFile(dir))
/** Where the canvas was looked at: its own file, kept out of the project's
 *  history (panning is not a change to undo). */
const viewFile = (dir: string): string => join(dir, '.studio', 'canvas-view.json')
const read = (dir: string): Stored => {
  const v = readJson<Partial<Stored>>(canvasFile(dir), {})
  const view = readJson<BoardView | null>(viewFile(dir), null) ?? v.view ?? null
  return { tiles: v.tiles ?? {}, links: Array.isArray(v.links) ? v.links : [], view }
}
const write = (dir: string, s: Stored): void => writeJson(canvasFile(dir), { tiles: s.tiles, links: s.links })

export const refKey = (id: string): string => `ref:${id}`

/** A folder by its real path, so one folder reached two ways (/tmp and
 *  /private/tmp, a symlinked home) is one project and one tile. */
export const real = (p: string): string => {
  try {
    return realpathSync.native(p)
  } catch {
    return resolve(p)
  }
}

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}
const isVideo = (dir: string): boolean => existsSync(join(dir, 'index.html')) || existsSync(join(dir, '.studio', 'project.json'))

/** A video folder from before canvases becomes a project of its own: its
 *  canvas holds it as the first tile. */
function adopt(dir0: string): void {
  const dir = real(dir0)
  if (isCanvas(dir)) return
  const meta = loadMeta(dir)
  if (!meta) return
  if (!existsSync(join(dir, '.studio', 'project.json'))) saveMetaFile(dir, meta)
  write(dir, { tiles: { [dir]: { x: 0, y: 0 } }, links: [], view: null })
}

/** Folders at the top of ~/Panthr that are not projects. */
const SHARED = new Set(['Library', 'References', 'Skills'])

/** Every project: ~/Panthr's, folders opened from elsewhere, and hosts'
 *  (as last brought over). Older single videos are adopted on the way. */
export function canvasDirs(): string[] {
  const root = studioRoot()
  const dirs: string[] = []
  const top = (r: string): string[] => {
    try {
      return readdirSync(r).filter((n) => !n.startsWith('.') && !SHARED.has(n)).map((n) => join(r, n)).filter(isDir)
    } catch {
      return []
    }
  }
  dirs.push(...top(root), ...opened())
  const mirrors = remote.mirrors()
  if (mirrors) for (const h of remote.hosts()) dirs.push(...top(join(mirrors, remote.slug(h.name))))
  const out: string[] = []
  for (const d of [...new Set(dirs.map(real))]) {
    if (!isCanvas(d) && loadMeta(d)) adopt(d)
    if (isCanvas(d)) out.push(d)
  }
  return out
}

/** The videos on a project's canvas (folders), in the order they were placed. */
const videosOf = (dir: string, s = read(dir)): string[] => Object.keys(s.tiles).filter((k) => !k.startsWith('ref:'))

/** A project as Home shows it. */
export function canvasInfo(dir: string): Canvas | null {
  const meta = loadMeta(dir)
  if (!meta) return null
  const s = read(dir)
  const videos = videosOf(dir, s).filter(isDir)
  // The poster: the first video with a picture.
  let thumb: string | null = null
  for (const v of videos) {
    thumb = thumbOf(v)
    if (thumb) break
  }
  const edited = Math.max(contentMtime(dir), ...videos.filter((v) => v !== dir).map(contentMtime))
  return { dir, name: meta.name, created_at: meta.created_at, edited_at: edited, videos: videos.length, thumb, host: remote.hostOf(dir)?.host.name ?? null }
}

export function listCanvases(): Canvas[] {
  return canvasDirs()
    .map(canvasInfo)
    .filter((c): c is Canvas => c !== null)
    .sort((a, b) => b.created_at - a.created_at)
}

/** The project a video belongs to: the nearest folder up with a canvas, else
 *  a canvas with it as a tile, else the video itself (adopted). */
export function canvasOf(dir: string): string {
  const d = real(dir)
  const top = dirname(real(studioRoot()))
  for (let p = d; p !== dirname(p) && p.startsWith(top); p = dirname(p)) {
    if (isCanvas(p)) return p
  }
  for (const c of canvasDirs()) if (read(c).tiles[d]) return c
  adopt(d)
  return d
}

/** A new, empty project (a canvas with nothing on it yet, named for now). */
export function createCanvas(name: string): Canvas {
  const root = studioRoot()
  mkdirSync(root, { recursive: true })
  const base = folderName(name.trim() || 'Untitled')
  let dir = join(root, base)
  for (let n = 2; existsSync(dir); n++) dir = join(root, `${base} ${n}`)
  mkdirSync(dir, { recursive: true })
  saveMetaFile(dir, { name: name.trim() || 'Untitled', created_at: now(), chats: [], agents_enabled: true, models: {}, auto_name: true })
  write(dir, { tiles: {}, links: [], view: null })
  linkSkills(dir)
  return canvasInfo(real(dir))!
}

const overlaps = (tiles: Stored['tiles'], x: number, y: number): boolean =>
  Object.values(tiles).some((t) => Math.abs(t.x - x) < STEP.x - 1 && Math.abs(t.y - y) < STEP.y - 1)

/** The nearest free spot to (x, y), looking outward ring by ring on the grid. */
export function freeSpot(tiles: Stored['tiles'], x: number, y: number): { x: number; y: number } {
  for (let r = 0; r < 60; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue
        const px = x + dx * STEP.x
        const py = y + dy * STEP.y
        if (!overlaps(tiles, px, py)) return { x: px, y: py }
      }
    }
  }
  return { x, y }
}

/** Beside the tile it came from: to its right, then down that column. */
function besideSpot(tiles: Stored['tiles'], from: { x: number; y: number }): { x: number; y: number } {
  for (let i = 0; i < 40; i++) {
    const p = { x: from.x + STEP.x, y: from.y + i * STEP.y }
    if (!overlaps(tiles, p.x, p.y)) return p
  }
  return freeSpot(tiles, from.x + STEP.x, from.y)
}

/** A project's canvas, without tiles (and arrows) whose video or reference is gone. */
export function board(dir: string): Board {
  const s = read(dir)
  const refs = new Set(listReferences().map((r) => refKey(r.id)))
  let changed = false
  for (const k of Object.keys(s.tiles)) {
    const live = k.startsWith('ref:') ? refs.has(k) : isDir(k) && isVideo(k)
    if (!live) {
      delete s.tiles[k]
      changed = true
    }
  }
  const links = s.links.filter((l) => s.tiles[l.from] && s.tiles[l.to])
  if (links.length !== s.links.length) changed = true
  s.links = links
  if (changed) write(dir, s)
  return { dir, tiles: s.tiles, links: s.links, view: s.view, tile: TILE }
}

/** A video or reference on this canvas by what someone might call it: its
 *  folder (absolute, or from the project), folder name, name, or @handle. */
export function keyFor(canvas: string, what: string): string | null {
  const w = what.trim().replace(/^@/, '')
  if (!w) return null
  const r = listReferences().find((x) => x.id === w || x.handle === w || x.name === w)
  if (r) return refKey(r.id)
  const vids = videosOf(canvas)
  const abs = real(resolve(canvas, w.startsWith('~/') ? join(studioRoot(), '..', w.slice(2)) : w))
  const name = (d: string): string => loadMeta(d)?.name ?? basename(d)
  return (
    vids.find((d) => resolve(d) === abs) ??
    vids.find((d) => basename(d) === w) ??
    vids.find((d) => name(d) === w) ??
    vids.find((d) => name(d).toLowerCase() === w.toLowerCase()) ??
    null
  )
}

const changed = (canvas: string): void => emit('board:changed', board(canvas))
const focus = (canvas: string, key: string, fresh: boolean): void => emit('board:focus', { canvas, key, fresh })

/** A new video in a project: a subfolder, its tile beside what it came from
 *  (with an arrow) or near `near`, and the view taken to it. */
export function newVideo(canvas0: string, name: string, from?: string | null, near?: { x: number; y: number } | null): Project {
  const canvas = real(canvas0)
  const n = name.trim() || 'Untitled'
  const p = createIn(canvas, n)
  // The folder can't hold every character (a ':' in "9:16"); the name can.
  if (p.meta.name !== n) {
    p.meta.name = n
    saveMetaFile(p.dir, p.meta)
  }
  const s = read(canvas)
  const src = from ? keyFor(canvas, from) : null
  const at = src && s.tiles[src] ? besideSpot(s.tiles, s.tiles[src]) : freeSpot(s.tiles, near?.x ?? (s.view ? s.view.x - TILE.w / 2 : 0), near?.y ?? (s.view ? s.view.y - TILE.h / 2 : 0))
  s.tiles[p.dir] = at
  if (src) s.links.push({ from: src, to: p.dir })
  write(canvas, s)
  linkSkills(p.dir)
  changed(canvas)
  focus(canvas, p.dir, true)
  return load(p.dir) ?? p
}

const VIDEO_FILE = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi'])

/** Bring things onto a project's canvas: a video folder (used where it is),
 *  a folder of them (each one), a video file (taken apart as a reference)
 *  or any other file (into the Library). They are placed in a row from `at`
 *  (else the view's centre), and the view goes to the last. */
export async function importPaths(canvas0: string, paths: string[], at?: { x: number; y: number } | null): Promise<BoardImport> {
  const canvas = real(canvas0)
  const out: BoardImport = { projects: [], references: [], library: [], skipped: [] }
  const videoDirs: string[] = []
  for (const raw of paths) {
    const p = resolve(canvas, raw.startsWith('~/') ? join(studioRoot(), '..', raw.slice(2)) : raw)
    if (!existsSync(p)) {
      out.skipped.push({ path: raw, why: 'Not found' })
      continue
    }
    if (isDir(p)) {
      if (loadMeta(p)) {
        videoDirs.push(real(p))
        continue
      }
      // A folder of videos: each one inside it.
      const inner = readdirSync(p).filter((n) => !n.startsWith('.')).map((n) => join(p, n)).filter((d) => isDir(d) && loadMeta(d))
      if (inner.length) videoDirs.push(...inner.map(real))
      else out.skipped.push({ path: raw, why: 'No video in it (a video folder has an index.html)' })
      continue
    }
    if (VIDEO_FILE.has(extname(p).toLowerCase())) {
      try {
        out.references.push((await references.add(p)).id)
      } catch (e) {
        out.skipped.push({ path: raw, why: (e as Error).message })
      }
      continue
    }
    if (addToLibrary(libraryDir(), [p])) out.library.push(p)
    else out.skipped.push({ path: raw, why: 'Could not copy it into the Library' })
  }
  for (const d of [...new Set(videoDirs)]) {
    const meta = loadMeta(d)
    if (!meta) {
      out.skipped.push({ path: d, why: 'Not a video' })
      continue
    }
    if (!existsSync(join(d, '.studio', 'project.json'))) saveMetaFile(d, meta)
    out.projects.push(d)
    linkSkills(d)
  }
  const s = read(canvas)
  const start = at ?? (s.view ? { x: s.view.x - TILE.w / 2, y: s.view.y - TILE.h / 2 } : { x: 0, y: 0 })
  const keys = [...out.projects, ...out.references.map(refKey)]
  let x = start.x
  for (const k of keys) {
    if (s.tiles[k]) continue
    const spot = freeSpot(s.tiles, x, start.y)
    s.tiles[k] = spot
    x = spot.x + STEP.x
  }
  write(canvas, s)
  changed(canvas)
  const last = keys[keys.length - 1]
  if (last) focus(canvas, last, true)
  return out
}

/** Where a folder is, said from the project (for the agent). */
export const fromProject = (canvas: string, dir: string): string => {
  const r = relative(canvas, dir)
  return r === '' ? '.' : r.startsWith('..') ? dir : r
}

/** Exported videos gathered in one place: the project's Exports/<when>/,
 *  each named after its video. Returns the folder. */
export function collect(canvas0: string, files: { dir: string; file: string }[]): string {
  const canvas = real(canvas0)
  const d = new Date()
  const p2 = (n: number): string => String(n).padStart(2, '0')
  const out = join(canvas, 'Exports', `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}.${p2(d.getMinutes())}`)
  mkdirSync(out, { recursive: true })
  const used = new Set<string>()
  for (const f of files) {
    const src = join(f.dir, '.studio', 'versions', f.file)
    if (!existsSync(src)) continue
    let name = folderName(loadMeta(f.dir)?.name ?? basename(f.dir))
    for (let n = 2; used.has(name); n++) name = `${folderName(loadMeta(f.dir)?.name ?? basename(f.dir))} ${n}`
    used.add(name)
    copyFileSync(src, join(out, `${name}${extname(f.file) || '.mp4'}`))
  }
  return out
}

export const canvasesApi: Api['canvases'] = {
  async list() {
    return listCanvases()
  },
  async create(name) {
    return createCanvas(name)
  },
  async of(dir) {
    return canvasOf(dir)
  },
  async find(what) {
    const w = what.trim()
    const all = listCanvases()
    const abs = real(resolve(studioRoot(), w))
    const c = all.find((x) => x.dir === abs) ?? all.find((x) => x.name === w) ?? all.find((x) => x.name.toLowerCase() === w.toLowerCase())
    if (!c) throw new Error(`No project called ${what}`)
    return c.dir
  }
}

export const boardApi: Api['board'] = {
  async get(canvas) {
    return board(real(canvas))
  },
  async move(canvas, key, x, y) {
    canvas = real(canvas)
    const s = read(canvas)
    s.tiles[key] = { x: Math.round(x), y: Math.round(y) }
    write(canvas, s)
  },
  async setView(canvas, view) {
    writeJson(viewFile(real(canvas)), view)
  },
  async create(canvas, name, from, near) {
    return newVideo(canvas, name, from, near)
  },
  async import(canvas, paths, at) {
    return importPaths(canvas, paths, at)
  },
  async collect(canvas, files) {
    return collect(canvas, files)
  },
  async link(canvas, from, to) {
    canvas = real(canvas)
    const a = keyFor(canvas, from)
    const b = keyFor(canvas, to)
    if (!a || !b) throw new Error(`Nothing on this canvas called ${a ? to : from}`)
    const s = read(canvas)
    if (!s.links.some((l) => l.from === a && l.to === b)) s.links.push({ from: a, to: b })
    write(canvas, s)
    changed(canvas)
  },
  async unlink(canvas, from, to) {
    canvas = real(canvas)
    const s = read(canvas)
    s.links = s.links.filter((l) => !(l.from === from && l.to === to))
    write(canvas, s)
    changed(canvas)
  },
  async focus(canvas, what) {
    canvas = real(canvas)
    const key = keyFor(canvas, what)
    if (!key) throw new Error(`Nothing on this canvas called ${what}`)
    focus(canvas, key, false)
    return key
  },
  async open(canvas, what) {
    canvas = real(canvas)
    const key = keyFor(canvas, what)
    if (!key || key.startsWith('ref:')) throw new Error(`No video on this canvas called ${what}`)
    emit('open', { dir: key, first: null })
    return key
  }
}
