// Projects as canvases: older single videos adopted as projects in place,
// new projects empty, videos made inside a project beside what they came
// from (with an arrow), names resolved the way the agent writes them,
// imports, and a video's project found from the video. Temp folders only.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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

import { board, canvasOf, createCanvas, freeSpot, importPaths, isCanvas, keyFor, listCanvases, newVideo, TILE } from '../src/main/board'
import { createIn, loadMeta } from '../src/main/projects'

const env = { HOME: process.env.HOME, DATA: process.env.PANTHR_DATA_DIR, ROOT: process.env.PANTHR_ROOT }
let tmp = ''
let n = 0
const root = (): string => process.env.PANTHR_ROOT!

beforeAll(() => {
  // Real paths: the temp folder is behind a symlink (/var → /private/var), as /tmp is.
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'panthr-board-')))
  process.env.HOME = join(tmp, 'home')
  mkdirSync(process.env.HOME)
})
beforeEach(() => {
  // A fresh ~/Panthr and data folder per test.
  const t = join(tmp, `t${n++}`)
  process.env.PANTHR_ROOT = join(t, 'Panthr')
  process.env.PANTHR_DATA_DIR = join(t, 'data')
  mkdirSync(root(), { recursive: true })
  emitted.length = 0
})
afterAll(() => {
  process.env.HOME = env.HOME
  process.env.PANTHR_DATA_DIR = env.DATA
  process.env.PANTHR_ROOT = env.ROOT
})

const step = { x: TILE.w + 80, y: TILE.h + 60 }

describe('projects as canvases', () => {
  it('finds the nearest free spot, ring by ring', () => {
    expect(freeSpot({}, 0, 0)).toEqual({ x: 0, y: 0 })
    const s = freeSpot({ a: { x: 0, y: 0 } }, 0, 0)
    expect(Math.max(Math.abs(s.x) / step.x, Math.abs(s.y) / step.y)).toBe(1)
  })

  it('a video from before canvases becomes a project holding it, in place, chats and all', () => {
    const old = createIn(root(), 'Launch Teaser')
    const chats = loadMeta(old.dir)!.chats
    for (const shared of ['Library', 'References', 'Skills']) mkdirSync(join(root(), shared), { recursive: true })
    const all = listCanvases()
    expect(all.map((c) => c.dir)).toEqual([old.dir])
    expect(isCanvas(old.dir)).toBe(true)
    expect(board(old.dir).tiles).toEqual({ [old.dir]: { x: 0, y: 0 } })
    expect(all[0]).toMatchObject({ name: 'Launch Teaser', videos: 1 })
    expect(loadMeta(old.dir)!.chats).toEqual(chats)
  })

  it('a new project is empty, named for now; its videos are subfolders beside what they came from', () => {
    const c = createCanvas('Spring launch')
    expect(c.videos).toBe(0)
    expect(loadMeta(c.dir)!.auto_name).toBe(true)
    const a = newVideo(c.dir, 'Launch Film', null, null)
    expect(a.dir).toBe(join(c.dir, 'Launch Film'))
    const at = board(c.dir).tiles[a.dir]
    const v = newVideo(c.dir, 'Launch Film 9:16', 'Launch Film', null)
    expect(v.meta.name).toBe('Launch Film 9:16')
    expect(board(c.dir).tiles[v.dir]).toEqual({ x: at.x + step.x, y: at.y })
    expect(board(c.dir).links).toEqual([{ from: a.dir, to: v.dir }])
    expect(emitted.filter(([n]) => n === 'board:focus').at(-1)![1]).toEqual({ canvas: c.dir, key: v.dir, fresh: true })
    // A second variant goes below the first, not on top of it.
    const w = newVideo(c.dir, 'Launch Film 1:1', a.dir, null)
    expect(board(c.dir).tiles[w.dir]).toEqual({ x: at.x + step.x, y: at.y + step.y })
    // Videos inside a project are not projects of their own.
    expect(listCanvases().map((x) => x.dir)).toEqual([c.dir])
    expect(listCanvases()[0].videos).toBe(3)
  })

  it('resolves what the agent calls a video: its folder, from the project, folder name, name', () => {
    const c = createCanvas('P')
    const v = newVideo(c.dir, 'Brand Film', null, null)
    expect(keyFor(c.dir, v.dir)).toBe(v.dir)
    expect(keyFor(c.dir, 'Brand Film')).toBe(v.dir)
    expect(keyFor(c.dir, 'brand film')).toBe(v.dir)
    expect(keyFor(c.dir, 'nothing like it')).toBeNull()
  })

  it("finds a video's project: the folder above it, else the video itself", () => {
    const c = createCanvas('P')
    const v = newVideo(c.dir, 'Cut', null, null)
    expect(canvasOf(v.dir)).toBe(c.dir)
    const lone = createIn(root(), 'Lone')
    expect(canvasOf(lone.dir)).toBe(lone.dir)
    expect(isCanvas(lone.dir)).toBe(true)
  })

  it('one folder reached through a symlink is one project, with one tile per video', () => {
    const c = createCanvas('Linked')
    const { symlinkSync } = require('node:fs') as typeof import('node:fs')
    const alias = join(tmp, `alias${n}`)
    symlinkSync(c.dir, alias)
    const v = newVideo(alias, 'Cut', null, null)
    expect(v.dir.startsWith(c.dir)).toBe(true)
    expect(Object.keys(board(c.dir).tiles)).toEqual([v.dir])
    expect(canvasOf(join(alias, 'Cut'))).toBe(c.dir)
  })

  it('forgets tiles and arrows whose video is gone', () => {
    const c = createCanvas('P')
    const a = newVideo(c.dir, 'A', null, null)
    const b = newVideo(c.dir, 'B', a.dir, null)
    rmSync(b.dir, { recursive: true })
    const after = board(c.dir)
    expect(after.tiles[b.dir]).toBeUndefined()
    expect(after.links).toEqual([])
    expect(JSON.parse(readFileSync(join(c.dir, '.studio/canvas.json'), 'utf8')).links).toEqual([])
  })

  it('imports a video folder from elsewhere where it is, a folder of them, files and video files', async () => {
    const c = createCanvas('P')
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
    const r = await importPaths(c.dir, [one, one, shelf, join(away, 'Nothing'), join(away, 'logo.png'), join(away, 'clip.mp4'), join(away, 'gone')], { x: 1000, y: 0 })
    expect(r.projects.sort()).toEqual([one, join(shelf, 'A'), join(shelf, 'B')].sort())
    expect(r.references).toEqual(['r1'])
    expect(refsAdded.at(-1)).toBe(join(away, 'clip.mp4'))
    expect(r.library).toEqual([join(away, 'logo.png')])
    expect(r.skipped.map((k) => k.path.split('/').pop())).toEqual(['Nothing', 'gone'])
    const b = board(c.dir)
    expect(b.tiles[one]).toEqual({ x: 1000, y: 0 })
    expect(r.projects.every((d) => b.tiles[d])).toBe(true)
    expect(existsSync(join(one, '.studio/project.json'))).toBe(true)
    // Imported into this project, not made projects of their own.
    expect(listCanvases().map((x) => x.dir)).toEqual([c.dir])
    expect(emitted.some(([n, p]) => n === 'board:focus' && p.fresh && p.canvas === c.dir)).toBe(true)
  })
})
