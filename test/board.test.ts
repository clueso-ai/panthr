// The Board: tiles placed for every project, new ones beside what they came
// from (with an arrow), names resolved the way the agent writes them, and
// the board's conversation living in ~/Panthr. Temp folders only.
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: undefined }))
const emitted: [string, any][] = []
vi.mock('../src/main/bus', () => ({ emit: (n: string, p: any) => emitted.push([n, structuredClone(p)]) }))

const refsAdded: string[] = []
vi.mock('../src/main/references', async (orig) => {
  const real: any = await orig()
  return { ...real, references: { ...real.references, add: async (p: string) => (refsAdded.push(p), { id: 'r1', handle: 'clip' }) } }
})

import { board, boardApi, boardDir, freeSpot, importPaths, isBoard, keyFor, TILE } from '../src/main/board'
import { createIn, list, loadMeta } from '../src/main/projects'

const env = { HOME: process.env.HOME, DATA: process.env.PANTHR_DATA_DIR, ROOT: process.env.PANTHR_ROOT }
let tmp = ''
let n = 0

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'panthr-board-'))
  process.env.HOME = join(tmp, 'home')
  mkdirSync(process.env.HOME)
})
beforeEach(() => {
  // A fresh ~/Panthr and data folder per test.
  const t = join(tmp, `t${n++}`)
  process.env.PANTHR_ROOT = join(t, 'Panthr')
  process.env.PANTHR_DATA_DIR = join(t, 'data')
  mkdirSync(process.env.PANTHR_ROOT, { recursive: true })
  emitted.length = 0
})
afterAll(() => {
  process.env.HOME = env.HOME
  process.env.PANTHR_DATA_DIR = env.DATA
  process.env.PANTHR_ROOT = env.ROOT
})

const step = { x: TILE.w + 80, y: TILE.h + 60 }

describe('board', () => {
  it('finds the nearest free spot, ring by ring', () => {
    expect(freeSpot({}, 0, 0)).toEqual({ x: 0, y: 0 })
    const taken = { a: { x: 0, y: 0 } }
    const s = freeSpot(taken, 0, 0)
    expect(Math.max(Math.abs(s.x) / step.x, Math.abs(s.y) / step.y)).toBe(1)
  })

  it('places every project once, without overlaps, and keeps them', () => {
    for (const name of ['One', 'Two', 'Three']) createIn(process.env.PANTHR_ROOT!, name)
    const b = board()
    const spots = Object.values(b.tiles)
    expect(spots).toHaveLength(3)
    expect(new Set(spots.map((p) => `${p.x},${p.y}`)).size).toBe(3)
    expect(board().tiles).toEqual(b.tiles)
  })

  it('a new project lands beside what it came from, with an arrow, and is shown', async () => {
    const root = process.env.PANTHR_ROOT!
    const src = createIn(root, 'Launch Film')
    const at = board().tiles[src.dir]
    const p = await boardApi.create('Launch Film 9:16', 'Launch Film', null)
    expect(p.meta.name).toBe('Launch Film 9:16')
    const b = board()
    expect(b.tiles[p.dir]).toEqual({ x: at.x + step.x, y: at.y })
    expect(b.links).toEqual([{ from: src.dir, to: p.dir }])
    expect(emitted.find(([n]) => n === 'board:focus')![1]).toEqual({ key: p.dir, fresh: true })
    // A second variant goes below the first, not on top of it.
    const q = await boardApi.create('Launch Film 1:1', src.dir, null)
    expect(board().tiles[q.dir]).toEqual({ x: at.x + step.x, y: at.y + step.y })
  })

  it('resolves what the agent calls a project: folder, folder name, name (any case)', () => {
    const root = process.env.PANTHR_ROOT!
    const p = createIn(root, 'Brand Film')
    expect(keyFor(p.dir)).toBe(p.dir)
    expect(keyFor('Brand Film')).toBe(p.dir)
    expect(keyFor('brand film')).toBe(p.dir)
    expect(keyFor('nothing like it')).toBeNull()
  })

  it('forgets tiles and arrows whose project is gone', async () => {
    const root = process.env.PANTHR_ROOT!
    const a = createIn(root, 'A')
    const b = await boardApi.create('B', a.dir, null)
    const { rmSync } = await import('node:fs')
    rmSync(b.dir, { recursive: true })
    const after = board()
    expect(after.tiles[b.dir]).toBeUndefined()
    expect(after.links).toEqual([])
  })

  it('imports a project from elsewhere where it is, a folder of projects, files and videos', async () => {
    const away = join(tmp, `away${n}`)
    const one = join(away, 'Old Film')
    mkdirSync(one, { recursive: true })
    writeFileSync(join(one, 'index.html'), '<html></html>')
    const shelf = join(away, 'Shelf')
    for (const name of ['A', 'B']) {
      mkdirSync(join(shelf, name), { recursive: true })
      writeFileSync(join(shelf, name, 'index.html'), 'x')
    }
    mkdirSync(join(away, 'Nothing'), { recursive: true })
    writeFileSync(join(away, 'logo.png'), 'png')
    writeFileSync(join(away, 'clip.mp4'), 'mp4')
    const r = await importPaths([one, one, shelf, join(away, 'Nothing'), join(away, 'logo.png'), join(away, 'clip.mp4'), join(away, 'gone')], { x: 1000, y: 0 })
    expect(r.projects.sort()).toEqual([one, join(shelf, 'A'), join(shelf, 'B')].sort())
    expect(r.references).toEqual(['r1'])
    expect(refsAdded.at(-1)).toBe(join(away, 'clip.mp4'))
    expect(r.library).toEqual([join(away, 'logo.png')])
    expect(r.skipped.map((k) => k.path.split('/').pop())).toEqual(['Nothing', 'gone'])
    // Opened where they are, listed, and placed in a row from the drop point.
    const b = board()
    expect(b.tiles[one]).toEqual({ x: 1000, y: 0 })
    expect(r.projects.every((d) => b.tiles[d])).toBe(true)
    expect(emitted.some(([n, p]) => n === 'board:focus' && p.fresh)).toBe(true)
  })

  it('the conversation lives in ~/Panthr, which is not listed as a project', () => {
    const dir = boardDir()
    expect(dir).toBe(process.env.PANTHR_ROOT)
    expect(isBoard(dir)).toBe(true)
    expect(loadMeta(dir)!.name).toBe('Board')
    // Its agent works from here, so the skills are linked here too.
    expect(existsSync(join(dir, '.claude/skills'))).toBe(true)
    writeFileSync(join(dir, 'index.html'), 'x')
    expect(list().some((p) => p.dir === dir)).toBe(false)
  })
})
