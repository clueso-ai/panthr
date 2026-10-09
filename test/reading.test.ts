// The reading pass's own measurements (no ffmpeg needed).

import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: undefined }))
const R = await import('../src/main/reading')

describe('reading a video', () => {
  it('finds a cut as a spike in motion', () => {
    // 3 s at 10 fps: still, a hard cut at 1.5 s, still.
    const w = 4, h = 2, n = 30
    const g = Buffer.alloc(w * h * n)
    for (let i = 15; i < n; i++) g.fill(200, i * w * h, (i + 1) * w * h)
    const m = R.motionCurve(g, w, h)
    expect(m[15]).toBeGreaterThan(0.7)
    expect(R.cutsFromMotion(m, 10)).toEqual([1.5])
    expect(R.shotsFrom([1.5], 3)).toEqual([{ start: 0, end: 1.5 }, { start: 1.5, end: 3 }])
  })
  it("reads PySceneDetect's scene list", () => {
    const csv = 'Timecode List:,00:00:01.500\nScene Number,Start Frame,Start Timecode,Start Time (seconds),End Frame,End Timecode,End Time (seconds),Length (frames)\n1,1,00:00:00.000,0.000,45,00:00:01.500,1.500,45\n2,46,00:00:01.500,1.500,90,00:00:03.000,3.000,45\n'
    expect(R.parseSceneCsv(csv)).toEqual([{ start: 0, end: 1.5 }, { start: 1.5, end: 3 }])
  })
  it('finds the main colours and their share', () => {
    const px = (r: number, g: number, b: number, n: number) => Array.from({ length: n }, () => [r, g, b]).flat()
    const p = R.palette(Buffer.from([...px(20, 10, 40, 70), ...px(255, 214, 245, 30)]), 2)
    expect(p).toEqual([{ hex: '#140a28', share: 0.7 }, { hex: '#ffd6f5', share: 0.3 }])
  })
  it('hears 120 BPM in a click track', () => {
    const sr = 11025
    const f = new Float32Array(sr * 8)
    for (let b = 0; b < 16; b++) for (let k = 0; k < 400; k++) f[Math.round(b * 0.5 * sr) + k] = Math.sin(k) * (1 - k / 400)
    const r = R.rhythm(R.rmsEnvelope(f))
    expect(r.bpm).toBeGreaterThan(115)
    expect(r.bpm).toBeLessThan(125)
    expect(r.beats.length).toBeGreaterThan(12)
  })
  it('groups words into lines at pauses and full stops', () => {
    const w = (text: string, start: number, end: number) => ({ text, start, end })
    expect(R.transcriptLines([w('Meet', 0, 0.4), w('it.', 0.4, 0.8), w('Then', 2, 2.3), w('go', 2.3, 2.6)])).toEqual(['[0.00–0.80] Meet it.', '[2.00–2.60] Then go'])
  })
})
