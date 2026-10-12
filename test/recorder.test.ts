// Screen recordings: the input helper's points on the video's pixels (a
// display's frame, or a window's as it moves), the dead time (still and
// nothing done), and a real take through the pipeline: converted, the dead
// time found, the clicks noted, landed as a video HyperFrames can play.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: undefined, nativeTheme: {}, BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../src/main/bus', () => ({ emit: () => {} }))

import { deadTime, land, toVideo } from '../src/main/recorder'
import { createCanvas, board } from '../src/main/board'

describe('pointer to pixels', () => {
  it('a display: scaled to the frame, the helper’s clock on the recording’s', () => {
    const r = toVideo([{ t: 1, type: 'click', x: 640, y: 400, button: 'left' }, { t: 2, type: 'click', x: 2000, y: 10 }], 0.5, { x: 0, y: 0, w: 1280, h: 800 }, { w: 1920, h: 1200 }, 10)
    expect(r.clicks).toEqual([{ t: 1.5, x: 960, y: 600, button: 'left' }])
  })
  it('a window: by its frame at that moment, as it moves', () => {
    const r = toVideo([
      { t: 0, type: 'bounds', x: 100, y: 100, w: 800, h: 600 },
      { t: 1, type: 'click', x: 500, y: 400 },
      { t: 2, type: 'bounds', x: 300, y: 100, w: 800, h: 600 },
      { t: 3, type: 'click', x: 500, y: 400 }
    ], 0, null, { w: 800, h: 600 }, 10)
    expect(r.clicks.map((c) => [c.t, c.x, c.y])).toEqual([[1, 400, 300], [3, 200, 300]])
  })
  it('keeps keys as moments only, and moves ten a second at most', () => {
    const r = toVideo([{ t: 1, type: 'key' }, { t: 1, type: 'move', x: 1, y: 1 }, { t: 1.05, type: 'move', x: 2, y: 2 }, { t: 1.2, type: 'move', x: 3, y: 3 }], 0, { x: 0, y: 0, w: 100, h: 100 }, { w: 100, h: 100 }, 10)
    expect(r.keys).toEqual([1])
    expect(r.moves.map((m) => m.t)).toEqual([1, 1.2])
  })
})

describe('dead time', () => {
  it('still stretches, split where something was done', () => {
    expect(deadTime([{ from: 2, to: 10 }], [6])).toEqual([{ from: 2, to: 5.7 }, { from: 6.5, to: 10 }])
    expect(deadTime([{ from: 2, to: 3 }], [])).toEqual([])
  })
})

describe('a take', () => {
  it('lands as a video with its clicks and dead time', async () => {
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'panthr-rec-')))
    process.env.PANTHR_ROOT = join(tmp, 'Panthr')
    process.env.PANTHR_DATA_DIR = join(tmp, 'data')
    mkdirSync(process.env.PANTHR_ROOT, { recursive: true })
    const canvas = createCanvas('Demo').dir
    // Two seconds of motion, three still, two of motion.
    const file = join(tmp, 'take.webm')
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x400:rate=30:duration=2', '-f', 'lavfi', '-i', 'color=c=gray:s=640x400:r=30:d=3', '-f', 'lavfi', '-i', 'testsrc=size=640x400:rate=30:duration=2', '-filter_complex', '[0][1][2]concat=n=3:v=1[v]', '-map', '[v]', '-c:v', 'libvpx-vp9', '-b:v', '1M', file])
    const dir = await land({ canvas, file, events: [{ t: 1, type: 'click', x: 640, y: 400, button: 'left' }], display: { x: 0, y: 0, w: 1280, h: 800 }, startedAt: 1000, helperAt: 1000, source: { name: 'Built-in display' } }, 'Recording · test', false)
    expect(existsSync(join(dir, 'assets', 'recording.mp4'))).toBe(true)
    expect(existsSync(file)).toBe(false)
    const data = JSON.parse(readFileSync(join(dir, 'recording.json'), 'utf8'))
    expect(data).toMatchObject({ width: 640, height: 400, source: 'Built-in display', clicks: [{ t: 1, x: 320, y: 200, button: 'left' }] })
    expect(data.duration).toBeCloseTo(7, 0)
    expect(data.idle).toHaveLength(1)
    expect(data.idle[0].from).toBeGreaterThan(1.8)
    expect(data.idle[0].to).toBeLessThan(5.3)
    expect(Object.keys(board(canvas).tiles)).toContain(dir)
    // HyperFrames plays it.
    const out = execFileSync('npx', ['--yes', 'hyperframes', 'check', dir, '--json', '--samples', '3', '--no-contrast'], { env: { ...process.env, HYPERFRAMES_NO_UPDATE_CHECK: '1' } }).toString()
    const v = JSON.parse(out.slice(out.indexOf('{')))
    expect(v.ok).toBe(true)
    expect(v.layout.duration).toBeCloseTo(7, 0)
  }, 180000)
})
