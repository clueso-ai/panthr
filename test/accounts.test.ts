// Claude accounts: each its own config folder (CLAUDE_CONFIG_DIR, never
// HOME), sign-in state from `claude auth status`, usage from the stream's
// rate_limit_event, and a chat that hits its account's limit carrying on
// with the next signed-in account: its session copied over, the same
// message sent again, a note saying so. No real claude runs here.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: undefined, nativeTheme: {} }))
vi.mock('../src/main/bus', () => ({ emit: () => {} }))
vi.mock('../src/main/namer', () => ({ suggestName: async () => null }))

const fake = vi.hoisted(() => ({
  /** Config folders signed in (by CLAUDE_CONFIG_DIR; '' for the default). */
  signedIn: new Set<string>(),
  starts: [] as any[],
  sent: [] as string[],
  out: null as null | ((e: any) => void),
  alive: false
}))
vi.mock('node:child_process', async (orig) => {
  const real: any = await orig()
  return {
    ...real,
    execFile: (_cmd: string, args: string[], opts: any, cb: (e: any, out: string) => void) => {
      if (args[0] === 'auth' && args[1] === 'status') {
        const dir = opts.env.CLAUDE_CONFIG_DIR ?? ''
        const ok = fake.signedIn.has(dir)
        cb(null, JSON.stringify(ok ? { loggedIn: true, authMethod: 'claude.ai', email: `${dir ? 'work' : 'me'}@x.io`, subscriptionType: 'max', orgName: 'X' } : { loggedIn: false, authMethod: 'none' }))
        return
      }
      return real.execFile(_cmd, args, opts, cb)
    }
  }
})
vi.mock('../src/main/agents/claude', async (orig) => {
  const real: any = await orig()
  class ClaudeChat {
    started: any = null
    running() { return fake.alive }
    start(o: any, out: (e: any) => void) { fake.starts.push(o); fake.out = out; fake.alive = true; this.started = o }
    send(text: string) { fake.sent.push(text) }
    stop() { fake.alive = false; this.started = null }
  }
  return { ...real, ClaudeChat, claudeBin: () => 'claude', promptText: () => 'PROMPT' }
})

import { parse } from '../src/main/agents/claude'
import { accountsApi, claudeEnv, moveSession, nextAccount, noteUsage } from '../src/main/accounts'
import { chats, stopAll } from '../src/main/chats'
import { settings } from '../src/main/settings'
import { loadMeta, saveMetaFile } from '../src/main/projects'

let tmp = ''
const env = { HOME: process.env.HOME, DATA: process.env.PANTHR_DATA_DIR, CCD: process.env.CLAUDE_CONFIG_DIR }
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'panthr-accounts-'))
  process.env.HOME = join(tmp, 'home')
  process.env.PANTHR_DATA_DIR = join(tmp, 'data')
  delete process.env.CLAUDE_CONFIG_DIR
  mkdirSync(process.env.PANTHR_DATA_DIR, { recursive: true })
})
afterAll(() => {
  stopAll()
  process.env.HOME = env.HOME
  process.env.PANTHR_DATA_DIR = env.DATA
  if (env.CCD) process.env.CLAUDE_CONFIG_DIR = env.CCD
})
beforeEach(() => Object.assign(fake, { starts: [], sent: [], out: null, alive: false }))

describe('the stream', () => {
  it('reads how much of the account is used', () => {
    const line = '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","resetsAt":1793491200,"unifiedWindows":{"five_hour":{"utilization":0.34,"resetsAt":1791816000},"seven_day":{"utilization":0.27,"resetsAt":1792242000}}}}'
    expect(parse(line)).toEqual([{ type: 'limits', usage: { status: 'allowed_warning', resetsAt: 1793491200, five_hour: { utilization: 0.34, resetsAt: 1791816000 }, seven_day: { utilization: 0.27, resetsAt: 1792242000 } } }])
  })
})

describe('accounts', () => {
  it('gives each its own folder, never another HOME', async () => {
    const a = await accountsApi.add('Work')
    expect(a.id).toBe('work')
    expect(a.dir).toBe('~/.claude-work')
    const e = claudeEnv('work')
    expect(e.CLAUDE_CONFIG_DIR).toBe(join(process.env.HOME!, '.claude-work'))
    expect(e.HOME).toBe(process.env.HOME)
    expect(claudeEnv('default').CLAUDE_CONFIG_DIR).toBeUndefined()
    expect((await accountsApi.add('Work')).id).toBe('work-2')
    await accountsApi.remove('work-2')
  })

  it('says who each is', async () => {
    fake.signedIn = new Set(['', join(process.env.HOME!, '.claude-work')])
    const list = await accountsApi.list(true)
    expect(list.map((a) => [a.id, a.signedIn, a.email, a.plan])).toEqual([['default', true, 'me@x.io', 'Max'], ['work', true, 'work@x.io', 'Max']])
  })

  it('brings a conversation to another account', () => {
    const from = join(process.env.HOME!, '.claude', 'projects', '-p-x')
    mkdirSync(from, { recursive: true })
    writeFileSync(join(from, 'sess-9.jsonl'), '{"a":1}\n')
    expect(moveSession('sess-9', 'default', 'work')).toBe(true)
    expect(readFileSync(join(process.env.HOME!, '.claude-work', 'projects', '-p-x', 'sess-9.jsonl'), 'utf8')).toBe('{"a":1}\n')
    expect(moveSession('nope', 'default', 'work')).toBe(false)
  })

  it('picks the next account: signed in, not at its limit', async () => {
    noteUsage('work', { status: 'rejected', resetsAt: Date.now() / 1000 + 3600, five_hour: null, seven_day: null })
    expect(await nextAccount('default')).toBeNull()
    noteUsage('work', { status: 'allowed', resetsAt: null, five_hour: { utilization: 0.2, resetsAt: null }, seven_day: null })
    expect((await nextAccount('default'))?.id).toBe('work')
  })
})

describe('a chat at its limit', () => {
  it('carries on with the next account, conversation and all', async () => {
    await settings.set({ claude_failover: true, claude_account: 'default' })
    const dir = join(tmp, 'proj')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'index.html'), 'x')
    saveMetaFile(dir, { name: 'P', created_at: 1, chats: [{ id: 'c1', title: 'x', session_id: null, created_at: 1, engine: 'claude' }], agents_enabled: true, models: {} })
    await chats.send(dir, 'c1', 'Make it red')
    expect(fake.starts[0].account).toBe('default')
    expect(fake.starts[0].env.CLAUDE_CONFIG_DIR).toBeUndefined()
    // The session, its file where Claude Code keeps it, then the limit.
    fake.out!({ type: 'session', id: 'sess-7' })
    const sdir = join(process.env.HOME!, '.claude', 'projects', '-proj')
    mkdirSync(sdir, { recursive: true })
    writeFileSync(join(sdir, 'sess-7.jsonl'), '{}\n')
    fake.out!({ type: 'limits', usage: { status: 'rejected', resetsAt: Date.now() / 1000 + 3600, five_hour: { utilization: 1, resetsAt: null }, seven_day: null } })
    fake.out!({ type: 'text', text: "You've hit your limit", agent: false })
    fake.out!({ type: 'result', cost_usd: 0, duration_ms: 10, turns: 1, error: true })
    await new Promise((r) => setTimeout(r, 50))

    // Started again on Work, resuming the same conversation, with the same message.
    const again = fake.starts.at(-1)
    expect(again.account).toBe('work')
    expect(again.env.CLAUDE_CONFIG_DIR).toBe(join(process.env.HOME!, '.claude-work'))
    expect(again.resume).toBe('sess-7')
    expect(existsSync(join(process.env.HOME!, '.claude-work', 'projects', '-proj', 'sess-7.jsonl'))).toBe(true)
    expect(fake.sent).toEqual(['Make it red', 'Make it red'])
    const s = await chats.open(dir, 'c1')
    expect(s.account).toBe('work')
    expect(s.items.filter((i) => 'User' in i)).toHaveLength(1)
    expect(s.items.some((i) => 'Note' in i && /Default reached its usage limit. Carrying on with Work/.test(i.Note))).toBe(true)
    expect(loadMeta(dir)!.chats[0].account).toBe('work')
    // That turn ends on Work.
    fake.out!({ type: 'result', cost_usd: 0, duration_ms: 10, turns: 1, error: false })
  })

  it('switches by hand too, only between turns', async () => {
    const dir = join(tmp, 'proj')
    await chats.setAccount(dir, 'c1', 'default')
    expect((await chats.open(dir, 'c1')).account).toBe('default')
    await chats.send(dir, 'c1', 'Bigger')
    await expect(chats.setAccount(dir, 'c1', 'work')).rejects.toThrow('Wait for this turn')
  })
})
