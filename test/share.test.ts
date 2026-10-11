// A .panthr round trip with real ditto: shared without history or caches;
// opened elsewhere as a new project with its paths made whole (a video from
// outside the folder included); sent back with a reviewer's note, which
// merges into the original instead of making a second project.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: undefined }))
vi.mock('../src/main/bus', () => ({ emit: () => {} }))

import { board, createCanvas, importPaths, listCanvases, newVideo } from '../src/main/board'
import { boardApi } from '../src/main/board'
import { openShare, saveShare } from '../src/main/share'
import { snap } from '../src/main/history'

const fresh = (): string => {
  const t = realpathSync(mkdtempSync(join(tmpdir(), 'panthr-share-')))
  process.env.PANTHR_ROOT = join(t, 'Panthr')
  process.env.PANTHR_DATA_DIR = join(t, 'data')
  process.env.HOME = join(t, 'home')
  mkdirSync(process.env.PANTHR_ROOT, { recursive: true })
  mkdirSync(process.env.HOME, { recursive: true })
  return t
}

describe('.panthr', () => {
  it('round-trips a project and brings a reviewer\'s notes home', async () => {
    // At home: a project with a video inside it, one from elsewhere, a note, history and caches.
    const home = fresh()
    const c = createCanvas('Launch')
    const v = newVideo(c.dir, 'Teaser', null, null)
    writeFileSync(join(v.dir, 'index.html'), '<div data-composition-id="m"></div>')
    mkdirSync(join(v.dir, '.studio', 'frames', '1'), { recursive: true })
    writeFileSync(join(v.dir, '.studio', 'frames', '1', 'f.png'), 'x')
    const away = join(home, 'elsewhere', 'Old Cut')
    mkdirSync(away, { recursive: true })
    writeFileSync(join(away, 'index.html'), 'old')
    await importPaths(c.dir, [away], { x: 900, y: 0 })
    await boardApi.notes(c.dir, [{ id: 'n1', kind: 'note', text: 'mine', x: 0, y: 0, on: v.dir, done: false, at: 1 }])
    await snap(c.dir, 'a checkpoint')
    const file = await saveShare(c.dir, join(home, 'Launch.panthr'))
    const listing = execFileSync('/usr/bin/unzip', ['-l', file]).toString()
    expect(listing).toContain('panthr.json')
    expect(listing).toContain('project/Teaser/index.html')
    expect(listing).toContain('project/_imported/Old Cut/index.html')
    for (const gone of ['history.git', '.studio/frames', '._']) expect(listing).not.toContain(gone)

    // On the reviewer's Mac: a new project, its paths whole again.
    fresh()
    const opened = await openShare(file)
    expect(opened.merged).toBe(false)
    const b = board(opened.dir)
    const keys = Object.keys(b.tiles)
    expect(keys).toContain(join(opened.dir, 'Teaser'))
    expect(keys).toContain(join(opened.dir, '_imported', 'Old Cut'))
    expect(b.notes[0].on).toBe(join(opened.dir, 'Teaser'))
    expect(readFileSync(join(opened.dir, '_imported', 'Old Cut', 'index.html'), 'utf8')).toBe('old')
    expect(listCanvases().map((x) => x.dir)).toEqual([opened.dir])
    // They add a note and send it back.
    await boardApi.notes(opened.dir, [...b.notes, { id: 'n2', kind: 'note', text: 'make the logo bigger', x: 10, y: 10, on: join(opened.dir, 'Teaser'), done: false, at: 2 }])
    const back = await saveShare(opened.dir, join(home, 'Launch-reviewed.panthr'))

    // At home again: the same project, its notes merged, no second project.
    process.env.PANTHR_ROOT = join(home, 'Panthr')
    process.env.PANTHR_DATA_DIR = join(home, 'data')
    const merged = await openShare(back)
    expect(merged.merged).toBe(true)
    expect(merged.dir).toBe(c.dir)
    const notes = board(c.dir).notes
    expect(notes.map((n) => n.text).sort()).toEqual(['make the logo bigger', 'mine'])
    expect(notes.find((n) => n.id === 'n2')!.on).toBe(v.dir)
    expect(readdirSync(join(home, 'Panthr')).filter((n) => !n.startsWith('.'))).toEqual(['Launch'])
    expect(existsSync(join(c.dir, '.studio', 'history.git'))).toBe(true)
  })
})
