// The self-check's look at the picture over time: a frame that flashes,
// and the picture going blank partway (a fade at either end is fine).
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: undefined }))
vi.mock('../src/main/bus', () => ({ emit: () => {} }))

import { checkMessage, scanPicture } from '../src/main/selfcheck'

type K = 'black' | 'white' | null
const series = (kinds: K[], step = 0.5) => kinds.map((kind, i) => ({ t: step / 2 + i * step, kind }))

describe('the picture over time', () => {
  it('finds a flash', () => {
    expect(scanPicture(series([null, null, 'white', null, null]), 2.5)).toEqual(['A white flash at 1.3s'])
  })
  it('finds the picture going blank partway, to the end', () => {
    expect(scanPicture(series([null, null, null, 'black', 'black', 'black', 'black', 'black']), 4)).toEqual(['The picture goes black from 1.8s to the end (4.0s)'])
  })
  it('finds a black frame in the middle of one picture', () => {
    const s = series([null, null, 'black', null, null]).map((x, i) => ({ ...x, mean: i === 2 ? 2 : 90 }))
    expect(scanPicture(s, 2.5)).toEqual(['A black flash at 1.3s'])
  })
  it('lets a fade in, a fade out and a short dip pass', () => {
    expect(scanPicture(series(['black', 'black', null, null, null, 'black', null, null, 'black', 'black']), 5)).toEqual([])
  })
  it('says when nothing shows at all', () => {
    expect(scanPicture(series(['black', 'black', 'black']), 1.5)).toEqual(['The picture is black the whole way through: nothing is showing'])
  })
})

describe('what the agent is told', () => {
  it('names the problems up front and the details in brackets', () => {
    const m = checkMessage([{ dir: '/p/Teaser', name: 'Teaser', duration: 10, problems: ['A white flash at 2.1s'], frames: ['/p/Teaser/.studio/check/1/frame-01.png'] }])
    expect(m.split('\n')[0]).toBe('Self-check found 1 problem in "Teaser". Fix them.')
    expect(m).toContain('(Self-check: "Teaser" (/p/Teaser, 10.0s):\n- A white flash at 2.1s')
    expect(m).toContain('Frames to look at: /p/Teaser/.studio/check/1/frame-01.png')
  })
})
