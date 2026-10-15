// STORYBOARD.md as the HyperFrames skills write it, read into frames.
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: undefined, BrowserWindow: { getAllWindows: () => [] }, nativeTheme: {} }))
const { parseStoryboard } = await import('../src/main/storyboard')

const MD = `---
format: 1920x1080
message: "Ship a launch video in an afternoon"
arc: Hook → Problem → Solution → Proof → CTA
---

## Frame 1 — Hook

- scene: Big type punches in on the beat
- duration: 3s
- poster: 2s
- transition_in: cut
- status: animated
- voiceover: "Ship a launch video in an afternoon."
- src: compositions/frames/01-hook.html

Open cold on the promise. This is the thesis.

## Frame 2 — The problem

- scene: "Old way" spins on a stack of rejected takes
- duration: 4s
- status: built

The old way.

### Beat 3: Proof

Numbers.
`

describe('STORYBOARD.md', () => {
  it('reads the frontmatter and each frame', () => {
    const { globals, frames } = parseStoryboard(MD)
    expect(globals).toMatchObject({ format: '1920x1080', message: 'Ship a launch video in an afternoon' })
    expect(frames.map((f) => [f.n, f.title, f.status, f.duration])).toEqual([[1, 'Hook', 'animated', '3s'], [2, 'The problem', 'built', '4s'], [3, 'Proof', 'outline', null]])
    expect(frames[0]).toMatchObject({ scene: 'Big type punches in on the beat', voiceover: 'Ship a launch video in an afternoon.', transition: 'cut', narrative: 'Open cold on the promise. This is the thesis.' })
    expect(frames[2].narrative).toBe('Numbers.')
    expect(frames[1].scene).toBe('"Old way" spins on a stack of rejected takes')
  })
  it('has no frames without frame headings', () => {
    expect(parseStoryboard('# Notes\n\nnothing here').frames).toEqual([])
  })
})
