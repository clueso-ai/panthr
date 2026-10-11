// The Board: every project (and reference video) as a tile on one canvas,
// with arrows from what a project came from. Positions, arrows and the last
// view live in Application Support/Panthr/board.json; the projects stay
// where they are. The Board's own conversation is a chat of ~/Panthr itself,
// whose agent makes projects with `panthr board new` and shows them to you.

import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Api } from '@shared/api'
import type { Board, BoardLink, BoardView, Project } from '@shared/types'
import { emit } from './bus'
import { readJson, writeJson } from './json'
import { dataDir, now, studioRoot } from './paths'
import { createIn, list as listProjects, load, loadMeta, saveMetaFile } from './projects'
import { list as listReferences } from './references'

/** A tile's footprint on the board (the window draws it at this size). */
export const TILE = { w: 320, h: 230 }
const GAP = { x: 80, y: 60 }
const STEP = { x: TILE.w + GAP.x, y: TILE.h + GAP.y }

interface Stored {
  tiles: Record<string, { x: number; y: number }>
  links: BoardLink[]
  view: BoardView | null
}

const file = (): string => join(dataDir(), 'board.json')
const read = (): Stored => {
  const v = readJson<Partial<Stored>>(file(), {})
  return { tiles: v.tiles ?? {}, links: Array.isArray(v.links) ? v.links : [], view: v.view ?? null }
}
const write = (s: Stored): void => writeJson(file(), s)

export const refKey = (id: string): string => `ref:${id}`

/** The Board's conversation lives in ~/Panthr itself (its own project.json). */
export function boardDir(): string {
  const dir = studioRoot()
  if (!loadMeta(dir) || !existsSync(join(dir, '.studio', 'project.json'))) {
    mkdirSync(dir, { recursive: true })
    saveMetaFile(dir, { name: 'Board', created_at: now(), chats: [], agents_enabled: true, models: {} })
  }
  return dir
}
export const isBoard = (dir: string): boolean => resolve(dir) === resolve(studioRoot())

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

/** Every project and reference with a place. Ones never placed (older
 *  projects, ones made outside the board) are laid out in a grid, newest
 *  first, with references in a column to the left. */
export function board(): Board {
  const s = read()
  const projects = listProjects()
  const refs = listReferences()
  let changed = false
  const cols = 4
  let i = 0
  for (const p of [...projects].reverse()) {
    if (s.tiles[p.dir]) continue
    const want = { x: (i % cols) * STEP.x, y: Math.floor(i / cols) * STEP.y }
    s.tiles[p.dir] = freeSpot(s.tiles, want.x, want.y)
    i++
    changed = true
  }
  let j = 0
  for (const r of refs) {
    const k = refKey(r.id)
    if (s.tiles[k]) continue
    s.tiles[k] = freeSpot(s.tiles, -STEP.x, j * STEP.y)
    j++
    changed = true
  }
  // Forget tiles (and arrows) whose project or reference is gone.
  const live = new Set([...projects.map((p) => p.dir), ...refs.map((r) => refKey(r.id))])
  for (const k of Object.keys(s.tiles)) {
    if (!live.has(k)) {
      delete s.tiles[k]
      changed = true
    }
  }
  const links = s.links.filter((l) => live.has(l.from) && live.has(l.to))
  if (links.length !== s.links.length) changed = true
  s.links = links
  if (changed) write(s)
  return { tiles: s.tiles, links: s.links, view: s.view, tile: TILE }
}

/** A project or reference by what someone might call it: a folder, a
 *  folder name, a project name or an @handle. */
export function keyFor(what: string): string | null {
  const w = what.trim().replace(/^@/, '')
  if (!w) return null
  const refs = listReferences()
  const r = refs.find((x) => x.id === w || x.handle === w || x.name === w)
  if (r) return refKey(r.id)
  const projects = listProjects()
  const abs = resolve(w.startsWith('~/') ? join(studioRoot(), '..', w.slice(2)) : w)
  const p =
    projects.find((x) => resolve(x.dir) === abs) ??
    projects.find((x) => resolve(x.dir) === resolve(studioRoot(), w)) ??
    projects.find((x) => x.meta.name === w) ??
    projects.find((x) => x.meta.name.toLowerCase() === w.toLowerCase())
  return p?.dir ?? null
}

export const boardApi: Api['board'] = {
  async get() {
    return board()
  },
  async move(key, x, y) {
    const s = read()
    s.tiles[key] = { x: Math.round(x), y: Math.round(y) }
    write(s)
  },
  async setView(view) {
    const s = read()
    s.view = view
    write(s)
  },
  async chatDir() {
    return boardDir()
  },
  async create(name, from, near) {
    const n = name.trim() || 'Untitled'
    const p: Project = createIn(studioRoot(), n)
    // The folder can't hold every character (a ':' in "9:16"); the name can.
    if (p.meta.name !== n) {
      p.meta.name = n
      saveMetaFile(p.dir, p.meta)
    }
    const s = read()
    const src = from ? keyFor(from) : null
    const at = src && s.tiles[src] ? besideSpot(s.tiles, s.tiles[src]) : freeSpot(s.tiles, near?.x ?? s.view?.x ?? 0, near?.y ?? s.view?.y ?? 0)
    s.tiles[p.dir] = at
    if (src) s.links.push({ from: src, to: p.dir })
    write(s)
    emit('board:changed', board())
    emit('board:focus', { key: p.dir, fresh: true })
    return load(p.dir) ?? p
  },
  async link(from, to) {
    const a = keyFor(from)
    const b = keyFor(to)
    if (!a || !b) throw new Error(`No project or reference called ${a ? to : from}`)
    const s = read()
    if (!s.links.some((l) => l.from === a && l.to === b)) s.links.push({ from: a, to: b })
    write(s)
    emit('board:changed', board())
  },
  async unlink(from, to) {
    const s = read()
    s.links = s.links.filter((l) => !(l.from === from && l.to === to))
    write(s)
    emit('board:changed', board())
  },
  async focus(what) {
    const key = keyFor(what)
    if (!key) throw new Error(`No project or reference called ${what}`)
    emit('board:focus', { key, fresh: false })
    return key
  },
  async open(what) {
    const key = keyFor(what)
    if (!key || key.startsWith('ref:')) throw new Error(`No project called ${what}`)
    emit('open', { dir: key, first: null })
    return key
  }
}
