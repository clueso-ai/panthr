// The usage view's numbers: every chat's turns added up by week, month and
// day, by project (with its newest turns) and by account; older turns
// without a date count in All time only.
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: undefined, nativeTheme: {} }))
vi.mock('../src/main/bus', () => ({ emit: () => {} }))

import { report } from '../src/main/usage'
import { createCanvas } from '../src/main/board'
import { chatPath, loadMeta, saveMetaFile } from '../src/main/projects'
import { saveTranscript } from '../src/main/chats'

const NOW = Date.UTC(2026, 9, 12, 12) // 12 Oct 2026, noon
const s = NOW / 1000

beforeAll(() => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'panthr-usage-')))
  process.env.PANTHR_ROOT = join(tmp, 'Panthr')
  process.env.PANTHR_DATA_DIR = join(tmp, 'data')
  process.env.HOME = join(tmp, 'home')
  mkdirSync(process.env.PANTHR_ROOT, { recursive: true })
  const a = createCanvas('Launch')
  const b = createCanvas('Changelog')
  const chat = (dir: string, id: string, engine: 'claude' | 'codex', items: any[]): void => {
    const m = loadMeta(dir)!
    saveMetaFile(dir, { ...m, chats: [...m.chats, { id, title: id, session_id: null, created_at: s - 20 * 86400, engine }] })
    saveTranscript(chatPath(dir, id), items)
  }
  chat(a.dir, 'c1', 'claude', [
    { User: 'Old one' }, { Meta: { cost_usd: 2, seconds: 60, error: false } },
    { User: 'Bigger title' }, { Meta: { cost_usd: 0.5, seconds: 30, error: false, at: s - 10 * 86400, engine: 'claude', account: 'work' } },
    { User: 'Make a teaser\nwith music' }, { Meta: { cost_usd: 1.5, seconds: 120, error: false, at: s - 3600, engine: 'claude', account: 'default', tokens: 1000 } }
  ])
  chat(b.dir, 'k1', 'codex', [{ User: 'Changelog for this week' }, { Meta: { cost_usd: 0, seconds: 90, error: true, at: s - 2 * 86400, engine: 'codex', account: 'codex', tokens: 50000 } }])
})

describe('usage', () => {
  it('adds every turn up by week, month and all time', () => {
    const r = report(NOW)
    expect(r.all).toEqual({ cost: 4, seconds: 300, turns: 4, tokens: 51000 })
    expect(r.week).toEqual({ cost: 1.5, seconds: 210, turns: 2, tokens: 51000 })
    // The older turn is dated between the chat's start (20 days ago) and the next turn (10 days ago).
    expect(r.month.turns).toBe(4)
    expect(r.undated).toBe(1)
    expect(r.days).toHaveLength(30)
    expect(r.days.at(-1)!.seconds).toBe(120)
  })
  it('by project, its newest turns first', () => {
    const [launch, changelog] = report(NOW).projects
    expect([launch.name, launch.cost, launch.turns]).toEqual(['Launch', 4, 3])
    expect(launch.recent.map((t) => t.label)).toEqual(['Make a teaser', 'Bigger title', 'Old one'])
    expect(launch.accounts.work.seconds).toBe(30)
    expect(changelog.recent[0]).toMatchObject({ engine: 'codex', error: true, tokens: 50000 })
  })
  it('by account', () => {
    const acc = Object.fromEntries(report(NOW).accounts.map((a) => [a.id, a.turns]))
    expect(acc).toEqual({ default: 2, work: 1, codex: 1 })
  })
})
