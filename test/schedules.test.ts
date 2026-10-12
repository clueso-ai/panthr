// Schedules: when each runs next (local time, on its days), the message the
// agent gets (with the date and when it last ran), and a run: the message
// sent to its project in the background, then on settling the videos it
// changed exported and the result kept.
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: undefined, nativeTheme: {}, Notification: undefined }))
vi.mock('../src/main/bus', () => ({ emit: () => {} }))
const fake = vi.hoisted(() => ({ sent: [] as [string, string, string][], rendered: [] as string[] }))
vi.mock('../src/main/chats', async (orig) => {
  const real: any = await orig()
  return {
    ...real,
    chats: {
      ...real.chats,
      create: async () => 'c1',
      open: async (dir: string, chatId: string) => ({ dir, chatId, items: [{ User: 'x' }, { Meta: {} }], working: false }),
      send: async (d: string, c: string, t: string) => void fake.sent.push([d, c, t])
    }
  }
})
vi.mock('../src/main/review', async (orig) => {
  const real: any = await orig()
  return { ...real, renderAndWait: async (d: string) => (fake.rendered.push(d), true) }
})
vi.mock('../src/main/history', async (orig) => {
  const real: any = await orig()
  return { ...real, checkpoints: () => [{ chatId: 'c1', turn: 2, files: ['Teaser/index.html', 'Teaser/compositions/a.html'] }] }
})

import { nextRun, runMessage, schedulesApi } from '../src/main/schedules'
import { onSettled } from '../src/main/chats'
import { createCanvas, newVideo } from '../src/main/board'

let canvas = ''
let video = ''
beforeAll(() => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'panthr-sched-')))
  process.env.PANTHR_ROOT = join(tmp, 'Panthr')
  process.env.PANTHR_DATA_DIR = join(tmp, 'data')
  mkdirSync(process.env.PANTHR_ROOT, { recursive: true })
  mkdirSync(process.env.PANTHR_DATA_DIR, { recursive: true })
  canvas = createCanvas('Changelog').dir
  video = newVideo(canvas, 'Teaser').dir
  writeFileSync(join(video, 'index.html'), 'x')
})

describe('when it runs', () => {
  const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m, d, h, min).getTime() / 1000
  it('the next chosen day, at its time', () => {
    // Monday 12 Oct 2026, 10:00: Fridays at 09:00 → Friday 16 Oct 09:00.
    expect(nextRun({ days: [5], time: '09:00' }, at(2026, 9, 12, 10))).toBe(at(2026, 9, 16, 9))
    // Later today when today is one of its days.
    expect(nextRun({ days: [1], time: '17:30' }, at(2026, 9, 12, 10))).toBe(at(2026, 9, 12, 17, 30))
    // Exactly at its time: the next one.
    expect(nextRun({ days: [1], time: '10:00' }, at(2026, 9, 12, 10))).toBe(at(2026, 9, 19, 10))
    expect(nextRun({ days: [], time: '10:00' }, at(2026, 9, 12))).toBeNull()
  })
})

describe('a run', () => {
  it('tells the agent the date and the last run', () => {
    const m = runMessage({ name: 'Changelog', prompt: 'This week’s releases', lastRun: null } as any, new Date(2026, 9, 16, 9).getTime() / 1000)
    expect(m).toMatch(/^This week’s releases\n\n\(Scheduled: "Changelog", today is .*Friday.*2026\. This is its first run\. Nobody is watching/)
  })

  it('sends it to its project, then exports what changed', async () => {
    const s = await schedulesApi.save({ name: 'Changelog', prompt: 'This week’s releases', project: canvas, days: [5], time: '09:00', exportAfter: true, enabled: true })
    expect(s.next).toBeGreaterThan(Date.now() / 1000)
    await schedulesApi.run(s.id)
    expect(fake.sent[0][0]).toBe(canvas)
    expect(fake.sent[0][2]).toMatch(/^This week’s releases\n\n\(Scheduled: "Changelog"/)
    expect((await schedulesApi.list())[0].running).toBe(true)
    for (const f of onSettled) f(canvas, 'c1')
    await new Promise((r) => setTimeout(r, 30))
    expect(fake.rendered).toEqual([video])
    const [after] = await schedulesApi.list()
    expect(after.running).toBe(false)
    expect(after.lastRun).toBeTruthy()
    expect(after.last).toMatchObject({ dir: canvas, ok: true, note: '1 video in Changelog, exported' })
  })
})
