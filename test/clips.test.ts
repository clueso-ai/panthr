// Clips: the volume envelope (fades and ducking as one lane), and the real
// edits on a small video through HyperFrames' timeline tool and the editor
// tool (needs npm and npx, so those run only with PANTHR_EDIT_E2E=1).

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: undefined, BrowserWindow: { getAllWindows: () => [] }, nativeTheme: {} }))

const root = mkdtempSync(join(tmpdir(), 'panthr-test-clips-'))
process.env.PANTHR_DATA_DIR = join(root, 'data')
const { envelope, clips, editClip, sound, beats } = await import('../src/main/clips')
const { install } = await import('../src/main/controls')
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('the volume envelope', () => {
  it('fades in and out at the clip’s level', () => {
    expect(envelope(10, 0.5, { in: 1, out: 2 })).toEqual([{ t: 0, v: 0 }, { t: 1, v: 0.5 }, { t: 8, v: 0.5 }, { t: 10, v: 0 }])
  })
  it('ducks under speech, down before and back up after', () => {
    const e = envelope(10, 1, { duck: { under: ['vo'], depth: 0.3, spans: [[2, 4]] } })
    expect(e.find((p) => p.t === 2)?.v).toBe(0.3)
    expect(e.find((p) => p.t === 4)?.v).toBe(0.3)
    expect(e.find((p) => p.t === 1.75)?.v).toBe(1)
    expect(e.find((p) => p.t === 4.4)?.v).toBe(1)
  })
  it('joins speech close together into one dip', () => {
    const e = envelope(10, 1, { duck: { under: ['vo'], depth: 0.3, spans: [[2, 3], [3.5, 5]] } })
    expect(e.filter((p) => p.t > 3 && p.t < 3.5)).toEqual([])
  })
  it('says nothing for a flat line', () => {
    expect(envelope(10, 0.8, {})).toEqual([])
  })
})

const HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="root" data-composition-id="main" data-width="640" data-height="360" data-duration="8">
  <video id="clip" class="clip" src="assets/clip.mp4" data-start="0" data-duration="6" data-track-index="0" data-has-audio="true" playsinline style="position:absolute;inset:0"></video>
  <h1 id="title" class="clip" data-start="1" data-duration="3" data-track-index="1">Hello</h1>
  <audio id="voice" src="assets/voice.wav" data-start="0" data-duration="8" data-track-index="2"></audio>
  <audio id="music" src="assets/music.mp3" data-start="0" data-duration="8" data-track-index="3" data-volume="0.8"></audio>
</div>
<script>window.__timelines = {}; const tl = gsap.timeline({ paused: true }); tl.from("#title", { opacity: 0, duration: 0.5 }, 1); window.__timelines.main = tl;</script>
</body></html>`

describe.skipIf(!process.env.PANTHR_EDIT_E2E)('edits', () => {
  const dir = join(root, 'Video')
  const html = (): string => readFileSync(join(dir, 'index.html'), 'utf8')
  it('reads the clips, their sound and the beats', async () => {
    mkdirSync(join(dir, 'assets'), { recursive: true })
    writeFileSync(join(dir, 'index.html'), HTML)
    const ff = (args: string[]): void => void execFileSync('ffmpeg', ['-v', 'error', '-y', ...args])
    ff(['-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(dir, 'assets/clip.mp4')])
    // A voice: speech from 2 to 4 s, silence around it.
    ff(['-f', 'lavfi', '-i', "aevalsrc='if(between(t,2,4),0.5*sin(2*PI*300*t),0)':d=8:s=44100", join(dir, 'assets/voice.wav')])
    ff(['-f', 'lavfi', '-i', "aevalsrc='0.8*sin(2*PI*60*t)*exp(-30*mod(t,0.5))':d=8:s=44100", '-c:a', 'libmp3lame', join(dir, 'assets/music.mp3')])
    await install()
    const all = await clips(dir)
    expect(all.map((c) => c.id).sort()).toEqual(['clip', 'music', 'title', 'voice'])
    const music = all.find((c) => c.id === 'music')!
    expect(music).toMatchObject({ kind: 'audio', start: 0, end: 8, volume: 0.8, audible: true })
    const s = await sound(dir, music)
    expect(s!.peaks.length).toBeGreaterThan(300)
    expect(s!.peakDb).toBeLessThan(0)
    expect(s!.lufs).not.toBeNull()
    const b = await beats(dir)
    expect(b.length).toBeGreaterThan(10)
    expect(b[1] - b[0]).toBeCloseTo(0.5, 1)
  }, 240_000)

  it('fades, ducks and evens out the loudness', async () => {
    let r = await editClip(dir, { op: 'fade', ref: '#music', in: 1, out: 2 })
    expect(r.changed).toBe(true)
    let m = (await clips(dir)).find((c) => c.id === 'music')!
    expect(m.lanes.find((l) => l.target === 'volume')!.points[0]).toEqual({ t: 0, v: 0 })
    r = await editClip(dir, { op: 'duck', ref: '#music', under: ['voice'], depth: 0.3 })
    m = (await clips(dir)).find((c) => c.id === 'music')!
    const pts = m.lanes.find((l) => l.target === 'volume')!.points
    const at3 = pts.filter((p) => p.t >= 2 && p.t <= 4)
    expect(at3.length).toBeGreaterThan(0)
    expect(Math.max(...at3.map((p) => p.v))).toBeCloseTo(0.24, 2)
    // The fades are still there.
    expect(pts[0]).toEqual({ t: 0, v: 0 })
    expect(r.before).not.toEqual(r.after)
    await editClip(dir, { op: 'normalize', ref: '#voice' })
    const v = (await clips(dir)).find((c) => c.id === 'voice')!
    expect(v.volume).not.toBeNull()
  }, 240_000)

  it('splits, freezes, duplicates, changes speed and closes the gap', async () => {
    await editClip(dir, { op: 'split', ref: '#title', at: 2 })
    expect((await clips(dir)).filter((c) => c.track === 'graphics').length).toBe(2)
    await editClip(dir, { op: 'freeze', ref: '#clip', at: 3, len: 1 })
    const vids = (await clips(dir)).filter((c) => c.trackIndex === 0).sort((a, b) => a.start - b.start)
    expect(vids.map((c) => [c.kind, c.start, c.end])).toEqual([['video', 0, 3], ['img', 3, 4], ['video', 4, 7]])
    expect(html()).toContain('assets/freeze-clip-3000.jpg')
    const d = await editClip(dir, { op: 'duplicate', ref: '#title', at: 6 })
    expect(d.changed).toBe(true)
    await editClip(dir, { op: 'set', ref: '#clip', rate: 2 })
    const c = (await clips(dir)).find((x) => x.id === 'clip')!
    expect(c.rate).toBe(2)
    expect(c.end - c.start).toBeCloseTo(1.5, 2)
    const hold = (await clips(dir)).find((x) => x.kind === 'img')!
    await editClip(dir, { op: 'delete', ref: hold.ref, close: true })
    const after = (await clips(dir)).filter((x) => x.trackIndex === 0).sort((a, b) => a.start - b.start)
    expect(after.map((x) => x.start)).toEqual([0, 3])
  }, 240_000)
})
