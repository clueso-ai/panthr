// Every size: a copy per frame with its composition set to that size,
// beside the original on the canvas; one message to the agent; each
// exported only once that chat's turn is over.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: undefined, nativeTheme: {} }))
vi.mock('../src/main/bus', () => ({ emit: () => {} }))
const fake = vi.hoisted(() => ({ sent: [] as [string, string, string][], rendered: [] as string[] }))
vi.mock('../src/main/chats', async (orig) => {
  const real: any = await orig()
  return { ...real, chats: { ...real.chats, create: async () => 'c1', send: async (d: string, c: string, t: string) => void fake.sent.push([d, c, t]) } }
})
vi.mock('../src/main/review', async (orig) => {
  const real: any = await orig()
  return { ...real, renderAndWait: async (d: string) => (fake.rendered.push(d), true) }
})

import { makeSizes, setFrame } from '../src/main/sizes'
import { onSettled } from '../src/main/chats'
import { board, createCanvas, newVideo } from '../src/main/board'

let canvas = ''
let video = ''
beforeAll(() => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'panthr-sizes-')))
  process.env.PANTHR_ROOT = join(tmp, 'Panthr')
  process.env.PANTHR_DATA_DIR = join(tmp, 'data')
  mkdirSync(process.env.PANTHR_ROOT, { recursive: true })
  canvas = createCanvas('Launch').dir
  video = newVideo(canvas, 'Teaser').dir
  writeFileSync(join(video, 'index.html'), '<div id="root" data-composition-id="main" data-width="1920" data-height="1080" data-duration="5"></div>')
})

describe('every size', () => {
  it('sets a composition’s frame', () => {
    const d = join(video, '..', 'x')
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'index.html'), '<div data-width="1920" data-height="1080"></div><div data-width="400" data-height="300"></div>')
    expect(setFrame(d, 1080, 1920)).toBe(true)
    expect(readFileSync(join(d, 'index.html'), 'utf8')).toBe('<div data-width="1080" data-height="1920"></div><div data-width="400" data-height="300"></div>')
  })

  it('copies it per frame, asks the agent once, and exports when the turn is over', async () => {
    const r = await makeSizes(canvas, [video], ['9:16', '1:1', '4:5'], true)
    expect(r.dirs.map((d) => d.split('/').pop())).toEqual(['Teaser 9-16', 'Teaser 1-1', 'Teaser 4-5'].map((n) => expect.stringContaining(n.split(' ')[0])) as any)
    expect(r.dirs).toHaveLength(3)
    expect(readFileSync(join(r.dirs[0], 'index.html'), 'utf8')).toContain('data-width="1080" data-height="1920"')
    expect(readFileSync(join(r.dirs[2], 'index.html'), 'utf8')).toContain('data-width="1080" data-height="1350"')
    const b = board(canvas)
    for (const d of r.dirs) expect(b.tiles[d]).toBeTruthy()
    expect(b.links.filter((l) => l.from === video)).toHaveLength(3)

    expect(fake.sent).toHaveLength(1)
    const [, chatId, text] = fake.sent[0]
    expect(text).toMatch(/^Lay these out again for their frames/)
    expect(text).toContain('1080×1920, vertical')
    expect(text).toContain("don't crop")

    // Nothing is exported until that chat's turn is over.
    expect(fake.rendered).toEqual([])
    for (const f of onSettled) f(canvas, 'another chat')
    expect(fake.rendered).toEqual([])
    for (const f of onSettled) f(canvas, chatId)
    await new Promise((r) => setTimeout(r, 20))
    expect(fake.rendered).toEqual(r.dirs)
    // Once.
    for (const f of onSettled) f(canvas, chatId)
    await new Promise((r) => setTimeout(r, 20))
    expect(fake.rendered).toHaveLength(3)
  })
})
