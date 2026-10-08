// Comments, versions, renderer output, frames, the library and the pen
// (port of studio-mac/src/tests/review.rs).

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Comment, Version } from '@shared/types'

const sent: unknown[] = []
vi.mock('electron', () => ({
  app: undefined,
  nativeTheme: {},
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: (_: string, p: unknown) => sent.push(p) } }] }
}))

const R = await import('../src/main/review')

const temps: string[] = []
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'panthr-test-review-'))
  temps.push(d)
  return d
}
function write(dir: string, rel: string, body: string, mtime?: number): string {
  const p = join(dir, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, body)
  if (mtime != null) utimesSync(p, mtime, mtime)
  return p
}
beforeAll(() => {
  process.env.PANTHR_DATA_DIR = temp()
})
afterEach(() => {
  for (const d of temps.splice(1)) rmSync(d, { recursive: true, force: true })
})

const comment = (id: string, time: number): Comment => ({ id, time, body: `note ${id}`, resolved: false, created_at: 1 })
const version = (n: number): Version => ({ n, file: `v${n}.mp4`, created_at: 100 + n, bytes: 10, render_seconds: 1.5, duration: 0 })

describe('comments', () => {
  it('missing or corrupt file is empty', () => {
    const d = temp()
    expect(R.loadComments(d)).toEqual([])
    write(d, '.studio/comments.json', '{not json')
    expect(R.loadComments(d)).toEqual([])
  })

  it('round-trips sorted by time, empty optionals left out', () => {
    const d = temp()
    R.saveComments(d, [comment('c', 9), { ...comment('b', 2), end: 3.5, x: 0.25, y: 0.75, reply: 'Done', resolved: true }, comment('a', 0.5)])
    const got = R.loadComments(d)
    expect(got.map((c) => c.id)).toEqual(['a', 'b', 'c'])
    expect(got[1]).toEqual({ id: 'b', time: 2, end: 3.5, x: 0.25, y: 0.75, body: 'note b', resolved: true, reply: 'Done', created_at: 1 })
    const raw = JSON.parse(readFileSync(join(d, '.studio/comments.json'), 'utf8'))
    expect(Object.keys(raw[2])).toEqual(['id', 'time', 'body', 'resolved', 'created_at'])
    expect(Object.keys(raw[1])).toEqual(['id', 'time', 'end', 'x', 'y', 'body', 'resolved', 'reply', 'created_at'])
  })

  it('comments the agent wrote with few fields load', () => {
    const d = temp()
    write(d, '.studio/comments.json', '[{"id":"x","time":4.2,"body":"Make it pop","reply":"Bigger title"}]')
    expect(R.loadComments(d)).toEqual([{ id: 'x', time: 4.2, body: 'Make it pop', resolved: false, reply: 'Bigger title', created_at: 0 }])
  })

  it('new comments round to hundredths and trim; fix-all plurals', () => {
    const c = R.newComment(12.3456, 14.999, '  tighten this  \n')
    expect([c.time, c.end, c.body, c.id.length, c.resolved]).toEqual([12.35, 15, 'tighten this', 8, false])
    expect(R.newComment(1, null, 'x').end).toBeUndefined()
    expect(R.newComment(1, null, 'a').id).not.toBe(R.newComment(1, null, 'b').id)
    expect(R.fixAllPrompt(1)).toMatch(/^Address the 1 open review comment in \.studio\/comments\.json\./)
    expect(R.fixAllPrompt(3)).toMatch(/^Address the 3 open review comments in/)
    expect(R.fixAllPrompt(1)).toContain('"resolved": true')
  })
})

describe('versions', () => {
  it('add, load newest first, stored oldest first, next number', () => {
    const d = temp()
    expect(R.nextVersion(d)).toBe(1)
    for (const n of [1, 3, 2]) {
      write(d, `.studio/versions/v${n}.mp4`, 'mp4')
      R.addVersion(d, version(n))
    }
    expect(R.loadVersions(d).map((v) => v.n)).toEqual([3, 2, 1])
    expect(R.nextVersion(d)).toBe(4)
    expect(JSON.parse(readFileSync(join(d, '.studio/versions.json'), 'utf8')).map((v: Version) => v.n)).toEqual([1, 2, 3])
  })

  it('versions whose video is gone are dropped; old JSON loads', () => {
    const d = temp()
    write(d, '.studio/versions/v1.mp4', 'mp4')
    write(d, '.studio/versions.json', '[{"n":1,"file":"v1.mp4","created_at":5},{"n":2,"file":"v2.mp4","created_at":6}]')
    expect(R.loadVersions(d)).toEqual([{ n: 1, file: 'v1.mp4', created_at: 5, bytes: 0, render_seconds: 0, duration: 0 }])
    expect(R.nextVersion(d)).toBe(2)
    expect(R.posterFile('/p/Proj', version(7))).toBe('/p/Proj/.studio/versions/v7.jpg')
  })

  it('export quality maps onto the CLI flag', () => {
    expect(R.qualityFlag({ export_quality: 'draft' })).toBe('draft')
    expect(R.qualityFlag({ export_quality: 'high' })).toBe('high')
    expect(R.qualityFlag({ export_quality: 'weird' as any })).toBe('standard')
  })
})

describe('renderer output', () => {
  it('strips ANSI', () => {
    expect(R.stripAnsi('\x1b[32m✓\x1b[0m done')).toBe('✓ done')
    expect(R.stripAnsi('\x1b[2K\x1b[1G  50%')).toBe('  50%')
    expect(R.stripAnsi('a\x1bb')).toBe('ab')
  })

  it('reads the last percentage', () => {
    expect(R.percent('  ██████░░░  25%  Streaming frame 1/180')).toBe(25)
    expect(R.percent('from 10% to 90%')).toBe(90)
    expect(R.percent('% alone')).toBeNull()
  })

  it('only progress-bar lines count', () => {
    expect(R.progressOf('timeline at-risk predictor: 0/180 frames (0%)')).toBeNull()
    expect(R.progressOf('██████░░░  37%  Streaming frame 65/180')).toEqual({ percent: 37, stage: 'Streaming frame 65/180' })
    expect(R.progressOf('██████████ 100%')).toEqual({ percent: 100, stage: null })
  })

  it('splits on \\r and \\n across chunks', () => {
    const lines: string[] = []
    const feed = R.lineSplitter((l) => lines.push(l))
    feed('\x1b[2K\x1b[36m  ██████░░░░\x1b[0m  37%  Streaming fr')
    feed('ame 65/180\r\x1b[2K  ███████░░░  40%  Streaming frame 70/180\r\n\nDone')
    expect(lines).toEqual(['██████░░░░  37%  Streaming frame 65/180', '███████░░░  40%  Streaming frame 70/180'])
  })

  it('the failure is the last line that says so', () => {
    expect(R.failureOf('warn\nError: Chrome crashed\n', ['Render failed at frame 3'])).toBe('Render failed at frame 3')
    expect(R.failureOf('', ['all good'])).toBe('The renderer stopped without a video')
  })
})

describe('frames', () => {
  it('none, then the newest numeric set, frames only, sorted', () => {
    const d = temp()
    expect(R.currentFrames(d)).toEqual({ files: [], stamp: 0 })
    for (const rel of ['100/frame-001.png', '900/frame-002.png', '900/frame-001.png', '900/notes.txt', '900/frame-003.jpg', 'tmp/frame-009.png', '20/frame-001.png'])
      write(d, `.studio/frames/${rel}`, 'x')
    const { files, stamp } = R.currentFrames(d)
    expect(stamp).toBe(900)
    expect(files).toEqual([join(d, '.studio/frames/900/frame-001.png'), join(d, '.studio/frames/900/frame-002.png')])
    write(d, '.studio/frames/1000/frame-1.png', 'x')
    expect(R.currentFrames(d).stamp).toBe(1000)
  })

  it('content mtime ignores app and tool folders, four levels deep only', () => {
    const d = temp()
    write(d, 'index.html', 'x', 1000)
    write(d, 'compositions/a.html', 'x', 2000)
    for (const rel of ['.studio/comments.json', 'node_modules/pkg/index.js', 'renders/out.mp4', 'snapshots/f.png', '.hidden', 'a/b/c/d/e/five.css'])
      write(d, rel, 'x', 9000)
    write(d, 'a/b/c/d/four.css', 'x', 3000)
    expect(R.contentMtime(d)).toBe(3000)
    expect(R.contentMtime('/definitely/not/here/panthr')).toBe(0)
  })

  it('stale when missing or older than the files (on this Mac)', () => {
    const d = temp()
    write(d, 'index.html', 'x', 5000)
    expect(R.framesStale(d, false)).toBe(true)
    write(d, '.studio/frames/4000/frame-1.png', 'x')
    expect(R.framesStale(d, false)).toBe(true)
    expect(R.framesStale(d, true)).toBe(false)
    write(d, '.studio/frames/6000/frame-1.png', 'x')
    expect(R.framesStale(d, false)).toBe(false)
  })

  it('frame times sit in the middle of each slot', () => {
    expect(R.frameTimes(10, 4)).toEqual(['1.250', '3.750', '6.250', '8.750'])
  })

  it('a current set is returned at once without making frames', async () => {
    const d = temp()
    write(d, 'index.html', 'x', 1000)
    write(d, '.studio/frames/2000/frame-1.png', 'x')
    expect(await R.review.frames(d, 10, 6)).toEqual([join(d, '.studio/frames/2000/frame-1.png')])
  })
})

describe('library', () => {
  it('lists folders first, then by name ignoring case', () => {
    const d = temp()
    write(d, 'zeta.png', '12345')
    write(d, 'Alpha.mp3', '1')
    write(d, 'beta.svg', '1')
    mkdirSync(join(d, 'Logos'))
    mkdirSync(join(d, 'fonts'))
    write(d, '.DS_Store', 'x')
    const items = R.library(d)
    expect(items.map((i) => i.name)).toEqual(['fonts', 'Logos', 'Alpha.mp3', 'beta.svg', 'zeta.png'])
    expect(items[4]).toEqual({ path: join(d, 'zeta.png'), name: 'zeta.png', is_dir: false, bytes: 5 })
    expect(R.library('/definitely/not/here/panthr-lib')).toEqual([])
  })

  it('never overwrites', () => {
    const src = temp()
    const lib = temp()
    const logo = write(src, 'logo.png', 'new')
    const readme = write(src, 'README', 'no ext')
    write(lib, 'logo.png', 'original')
    write(lib, 'logo 2.png', 'second')
    write(lib, 'README', 'orig')
    expect(R.addToLibrary(lib, [logo, readme])).toBe(2)
    expect(readFileSync(join(lib, 'logo.png'), 'utf8')).toBe('original')
    expect(readFileSync(join(lib, 'logo 3.png'), 'utf8')).toBe('new')
    expect(readFileSync(join(lib, 'README 2'), 'utf8')).toBe('no ext')
    expect(R.addToLibrary(lib, [logo])).toBe(1)
    expect(existsSync(join(lib, 'logo 4.png'))).toBe(true)
    expect(R.addToLibrary(lib, ['/definitely/not/here.png', '/'])).toBe(0)
  })

  it('copies folders and creates the library', () => {
    const src = temp()
    write(src, 'Brand/logo.svg', '<svg/>')
    write(src, 'Brand/fonts/a.woff2', 'font')
    const lib = join(temp(), 'Library')
    expect(R.addToLibrary(lib, [join(src, 'Brand')])).toBe(1)
    expect(readFileSync(join(lib, 'Brand/fonts/a.woff2'), 'utf8')).toBe('font')
    expect(R.addToLibrary(lib, [join(src, 'Brand')])).toBe(1)
    expect(existsSync(join(lib, 'Brand 2/fonts/a.woff2'))).toBe(true)
  })

  it('imports files into the project\'s assets/ and names them as the agent sees them', async () => {
    const src = temp()
    const proj = temp()
    const a = write(src, 'shot.png', 'a')
    write(proj, 'assets/shot.png', 'old')
    expect(await R.review.importFiles(proj, [a, a, '/nope.png'])).toEqual(['assets/shot 2.png', 'assets/shot 3.png'])
  })
})

describe('formatting', () => {
  it('size and ago', () => {
    expect([0, 10, 2400, 512000, 1e6, 23456789, 1e9, 4321000000].map(R.size)).toEqual(['1 KB', '1 KB', '2 KB', '512 KB', '1.0 MB', '23.5 MB', '1.0 GB', '4.3 GB'])
    const now = Math.floor(Date.now() / 1000)
    expect([now, now - 30, now + 500, now - 150, now - 3000, now - 7300, now - 86400 * 3 - 100].map(R.ago)).toEqual([
      'just now', 'just now', 'just now', '2 min ago', '50 min ago', '2 h ago', '3 d ago'
    ])
  })
})

describe('the pen', () => {
  it('composition size from the root attributes', () => {
    const d = temp()
    expect(R.compositionSize(d)).toBeNull()
    write(d, 'index.html', '<div id="root" data-composition-id="main" data-width="1080" data-height="1920"></div>')
    expect(R.compositionSize(d)).toEqual([1080, 1920])
    write(d, 'index.html', '<div data-width="wide" data-height="1080"></div>')
    expect(R.compositionSize(d)).toBeNull()
  })

  const px = (img: Uint8Array, w: number, x: number, y: number): number[] => [...img.slice((y * w + x) * 4, (y * w + x) * 4 + 4)]
  const filled = (w: number, h: number, rgba: number[]): Uint8Array => {
    const img = new Uint8Array(w * h * 4)
    for (let i = 0; i < w * h; i++) img.set(rgba, i * 4)
    return img
  }

  it('paints a pink disc', () => {
    const img = filled(40, 40, [0, 0, 0, 255])
    R.dot(img, 40, 40, 20, 20, 5)
    expect(px(img, 40, 20, 20)).toEqual([0xff, 0x4f, 0x9a, 255])
    expect(px(img, 40, 0, 0)).toEqual([0, 0, 0, 255])
    expect(px(img, 40, 20, 30)).toEqual([0, 0, 0, 255])
    let painted = 0
    for (let i = 0; i < 1600; i++) if (img[i * 4] || img[i * 4 + 1] || img[i * 4 + 2]) painted++
    expect(painted).toBeGreaterThanOrEqual(60)
    expect(painted).toBeLessThanOrEqual(110)
  })

  it('blends its soft edge, in BGRA too, and is safe at the edges', () => {
    const img = filled(40, 40, [0, 0, 0, 0])
    R.dot(img, 40, 40, 20, 20, 4.75)
    const edge = px(img, 40, 24, 20)
    expect(edge[0] > 0 && edge[0] < 0xff && edge[3] === 255).toBe(true)
    expect(px(img, 40, 25, 20)).toEqual([0, 0, 0, 0])
    const bgra = filled(10, 10, [0, 0, 0, 0])
    R.dot(bgra, 10, 10, 5, 5, 3, 'bgra')
    expect(px(bgra, 10, 5, 5)).toEqual([0x9a, 0x4f, 0xff, 255])
    const small = filled(10, 10, [0, 0, 0, 0])
    R.dot(small, 10, 10, -50, -50, 3)
    R.dot(small, 10, 10, 500, 500, 3)
    expect(small.every((v) => v === 0)).toBe(true)
    R.dot(small, 10, 10, 0, 0, 3)
    R.dot(small, 10, 10, 10, 10, 3)
    expect(px(small, 10, 0, 0)[3]).toBe(255)
    expect(px(small, 10, 9, 9)[3]).toBe(255)
  })

  it('strokes are scaled from composition pixels', () => {
    const img = filled(100, 100, [0, 0, 0, 255])
    // A stroke across a 200-wide composition lands at half scale.
    R.drawStrokes(img, 100, 100, [[[20, 100], [180, 100]], [[5, 5]]], 0.5, 0.5)
    expect(px(img, 100, 50, 50)).toEqual([0xff, 0x4f, 0x9a, 255])
    expect(px(img, 100, 50, 80)).toEqual([0, 0, 0, 255])
    // A single point draws nothing (no segment).
    expect(px(img, 100, 2, 2)).toEqual([0, 0, 0, 255])
  })
})

describe('render events', () => {
  it('nothing is sent for a project without a render to cancel', async () => {
    sent.length = 0
    await R.review.cancelRender(temp())
    expect(sent).toEqual([])
  })
})
