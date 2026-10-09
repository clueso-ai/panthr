// Reference videos: the parts that need no ffmpeg or agent.

import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: undefined, BrowserWindow: { getAllWindows: () => [] } }))
const R = await import('../src/main/references')
import type { Reference } from '../src/shared/types'

const ref = (handle: string, status: Reference['status'] = 'ready'): Reference => ({
  id: handle, name: handle, handle, source: '', status, step: null, error: null, created_at: 0, duration: 10, width: 1920, height: 1080,
  summary: null, dir: `/r/${handle}`, poster: null, video: `/r/${handle}/source.mp4`
})

describe('references', () => {
  it('makes unique handles', () => {
    expect(R.handleFor('Apple Vision Pro — launch!', [])).toBe('apple-vision-pro-launch')
    expect(R.handleFor('Intro', ['intro', 'intro-2'])).toBe('intro-3')
    expect(R.handleFor('!!!', [])).toBe('video')
  })
  it('names a file or a link', () => {
    expect(R.nameFrom('/Users/me/Movies/stripe_sessions-promo.mp4')).toBe('stripe sessions promo')
    expect(R.nameFrom('https://www.youtube.com/watch?v=abc')).toBe('youtube.com watch')
  })
  it('spreads stills through the video, 12 to 36 of them', () => {
    expect(R.stillTimes(6)).toHaveLength(12)
    expect(R.stillTimes(30)).toHaveLength(20)
    expect(R.stillTimes(600)).toHaveLength(36)
    expect(R.stillTimes(6)[0]).toBe(0.25)
  })
  it('reads cuts and the probe', () => {
    expect(R.parseCuts('pts_time:1.5 x pts_time:1.55 pts_time:4.0')).toEqual([1.5, 4])
    const p = R.parseProbe(JSON.stringify({ format: { duration: '12.5' }, streams: [{ codec_type: 'video', width: 1080, height: 1920, r_frame_rate: '30000/1001' }, { codec_type: 'audio' }] }))
    expect(p).toEqual({ duration: 12.5, width: 1080, height: 1920, fps: 29.97, hasAudio: true })
  })
  it('spells out @-mentions for the agent, only of references ready to use', () => {
    const refs = [ref('stripe-promo'), ref('raw-cut', 'analyzing')]
    expect(R.expandMentions('make it like @stripe-promo and @raw-cut, mail me@x.com', refs)).toContain('@stripe-promo ("stripe-promo"): its folder is /r/stripe-promo. Start with README.md')
    expect(R.mentioned('like @raw-cut', refs)).toEqual([])
    expect(R.mentioned('mail me@stripe-promo.com', refs)).toEqual([])
    expect(R.expandMentions('nothing here', refs)).toBe('nothing here')
  })
  it('lets the agent choose the shape, and asks only for an index and a summary', () => {
    const p = R.deconstructPrompt('Promo')
    expect(p).toContain('no required format')
    expect(p).toContain('README.md')
    expect(p).toContain('summary.txt')
  })
  it('lists a folder as a tree, folders first, and keeps reads inside it', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const d = mkdtempSync(join(tmpdir(), 'ref-'))
    mkdirSync(join(d, 'frames'))
    writeFileSync(join(d, 'frames', 't-0001.00.jpg'), 'x')
    writeFileSync(join(d, 'README.md'), '# hi')
    writeFileSync(join(d, 'meta.json'), '{}')
    expect(R.tree(d).map((f) => [f.path, f.kind, f.depth])).toEqual([['frames', 'folder', 0], ['frames/t-0001.00.jpg', 'image', 1], ['README.md', 'markdown', 0]])
  })
})
