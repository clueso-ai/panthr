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
  alive: false,
  codex: [] as any[],
  /** OpenCode: installed, and the providers it is signed in to. */
  opencode: { installed: true, providers: [] as string[] }
}))
vi.mock('node:child_process', async (orig) => {
  const real: any = await orig()
  return {
    ...real,
    execFile: (_cmd: string, args: string[], opts: any, cb: (e: any, out: string) => void) => {
      if (_cmd === '/bin/sh' && args[1] === 'command -v opencode') {
        cb(fake.opencode.installed ? null : new Error('not found'), fake.opencode.installed ? '/x/opencode\n' : '')
        return
      }
      if (args[0] === 'auth' && args[1] === 'list') {
        cb(null, JSON.stringify(fake.opencode.providers.map((name) => ({ id: name.toLowerCase(), name, connections: [{ type: 'credential', id: 'c', label: 'secret-ish', method: 'oauth' }] }))))
        return
      }
      if (args[0] === 'login' && args[1] === 'status') {
        cb(null, fake.signedIn.has(opts.env.CODEX_HOME ?? 'codex') ? 'Logged in using ChatGPT' : 'Not logged in')
        return
      }
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
vi.mock('../src/main/agents/codex', async (orig) => {
  const real: any = await orig()
  class CodexRun {
    running() { return false }
    send(o: any, out: (e: any) => void) { fake.codex.push(o); fake.out = out }
    stop() {}
  }
  return { ...real, CodexRun, codexBin: () => 'codex' }
})

import { parse } from '../src/main/agents/claude'
import { accountsApi, claudeEnv, codexEnv, codexUsage, moveSession, nextAccount, noteUsage } from '../src/main/accounts'
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
beforeEach(() => Object.assign(fake, { starts: [], sent: [], out: null, alive: false, codex: [] }))

describe('the stream', () => {
  it('reads how much of the account is used', () => {
    const line = '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","resetsAt":1793491200,"unifiedWindows":{"five_hour":{"utilization":0.34,"resetsAt":1791816000},"seven_day":{"utilization":0.27,"resetsAt":1792242000}}}}'
    expect(parse(line)).toEqual([{ type: 'limits', usage: { status: 'allowed_warning', overage: false, resetsAt: 1793491200, five_hour: { utilization: 0.34, resetsAt: 1791816000 }, seven_day: { utilization: 0.27, resetsAt: 1792242000 } } }])
  })
})

describe('accounts', () => {
  it('gives each its own folder, never another HOME', async () => {
    const a = await accountsApi.add('claude', 'Work')
    expect(a.id).toBe('work')
    expect(a.dir).toBe('~/.claude-work')
    const e = claudeEnv('work')
    expect(e.CLAUDE_CONFIG_DIR).toBe(join(process.env.HOME!, '.claude-work'))
    expect(e.HOME).toBe(process.env.HOME)
    expect(claudeEnv('default').CLAUDE_CONFIG_DIR).toBeUndefined()
    expect((await accountsApi.add('claude', 'Work')).id).toBe('work-2')
    await accountsApi.remove('work-2')
  })

  it('says who each is', async () => {
    fake.signedIn = new Set(['', join(process.env.HOME!, '.claude-work')])
    const list = await accountsApi.list(true)
    expect(list.filter((a) => a.engine === 'claude').map((a) => [a.id, a.signedIn, a.email, a.plan])).toEqual([['default', true, 'me@x.io', 'Max'], ['work', true, 'work@x.io', 'Max']])
  })

  it('brings a conversation to another account', () => {
    const from = join(process.env.HOME!, '.claude', 'projects', '-p-x')
    mkdirSync(from, { recursive: true })
    writeFileSync(join(from, 'sess-9.jsonl'), '{"a":1}\n')
    expect(moveSession('claude', 'sess-9', 'default', 'work')).toBe(true)
    expect(readFileSync(join(process.env.HOME!, '.claude-work', 'projects', '-p-x', 'sess-9.jsonl'), 'utf8')).toBe('{"a":1}\n')
    expect(moveSession('claude', 'nope', 'default', 'work')).toBe(false)
  })

  it('picks the next account: signed in, not at its limit', async () => {
    noteUsage('work', { status: 'rejected', resetsAt: Date.now() / 1000 + 3600, five_hour: null, seven_day: null })
    expect(await nextAccount('claude', 'default')).toBeNull()
    noteUsage('work', { status: 'allowed', resetsAt: null, five_hour: { utilization: 0.2, resetsAt: null }, seven_day: null })
    expect((await nextAccount('claude', 'default'))?.id).toBe('work')
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

  it('on extra usage: the turn stands, the next ones go to a free account', async () => {
    const dir = join(tmp, 'oproj')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'index.html'), 'x')
    saveMetaFile(dir, { name: 'P', created_at: 1, chats: [{ id: 'o1', title: 'x', session_id: null, created_at: 1, engine: 'claude' }], agents_enabled: true, models: {} })
    noteUsage('work', { status: 'allowed', resetsAt: null, five_hour: { utilization: 0.1, resetsAt: null }, seven_day: null })
    await chats.send(dir, 'o1', 'Make it green')
    fake.out!({ type: 'limits', usage: { status: 'rejected', overage: true, resetsAt: Date.now() / 1000 + 3600, five_hour: { utilization: 1.01, resetsAt: null }, seven_day: null } })
    fake.out!({ type: 'text', text: 'Green now.', agent: false })
    fake.out!({ type: 'result', cost_usd: 0.1, duration_ms: 10, turns: 1, error: false })
    await new Promise((r) => setTimeout(r, 50))
    // Not sent again.
    expect(fake.sent).toEqual(['Make it green'])
    const st = await chats.open(dir, 'o1')
    expect(st.account).toBe('work')
    expect(st.items.some((i) => 'Note' in i && /Default is past its usage limit and was using extra usage\. Next messages go to Work/.test(i.Note))).toBe(true)
  })

  it('switches by hand too, only between turns', async () => {
    const dir = join(tmp, 'proj')
    await chats.setAccount(dir, 'c1', 'default')
    expect((await chats.open(dir, 'c1')).account).toBe('default')
    await chats.send(dir, 'c1', 'Bigger')
    await expect(chats.setAccount(dir, 'c1', 'work')).rejects.toThrow('Wait for this turn')
  })
})

/** A Codex session file, as Codex writes it (with how much is used). */
function rollout(homeDir: string, thread: string, used: [number, number], reached: string | null): string {
  const d = join(homeDir, 'sessions', '2026', '10', '12')
  mkdirSync(d, { recursive: true })
  const f = join(d, `rollout-2026-10-12T10-00-00-${thread}.jsonl`)
  const rl = { limit_id: 'codex', primary: { used_percent: used[0], window_minutes: 300, resets_at: 1791800000 }, secondary: { used_percent: used[1], window_minutes: 10080, resets_at: 1792300000 }, plan_type: 'team', rate_limit_reached_type: reached }
  writeFileSync(f, JSON.stringify({ type: 'session_meta', payload: { id: thread } }) + '\n' + JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: rl } }) + '\n')
  return f
}

describe('OpenCode', () => {
  it('has one account: signed in when a provider is, not installed when it is missing', async () => {
    fake.opencode = { installed: true, providers: ['OpenAI', 'OpenCode Console'] }
    let list = (await accountsApi.list(true)).filter((a) => a.engine === 'opencode')
    expect(list.map((a) => [a.id, a.signedIn, a.plan, !!a.missing])).toEqual([['opencode', true, 'OpenAI, OpenCode Console', false]])
    fake.opencode = { installed: true, providers: [] }
    list = (await accountsApi.list(true)).filter((a) => a.engine === 'opencode')
    expect(list.map((a) => [a.signedIn, a.plan])).toEqual([[false, null]])
    fake.opencode = { installed: false, providers: [] }
    list = (await accountsApi.list(true)).filter((a) => a.engine === 'opencode')
    expect(list[0].missing).toBe(true)
    await expect(accountsApi.add('opencode', 'Work')).rejects.toThrow()
  })
})

describe('Codex accounts', () => {
  it('gives each its own CODEX_HOME, made if missing', async () => {
    const a = await accountsApi.add('codex', 'Work')
    expect(a.id).toBe('codex-work')
    expect(a.dir).toBe('~/.codex-work')
    const e = codexEnv('codex-work')
    expect(e.CODEX_HOME).toBe(join(process.env.HOME!, '.codex-work'))
    expect(existsSync(e.CODEX_HOME!)).toBe(true)
    expect(codexEnv('codex').CODEX_HOME).toBeUndefined()
    // Another agent's account is not one of Codex's.
    expect(codexEnv('work').CODEX_HOME).toBeUndefined()
  })

  it('says who each is', async () => {
    fake.signedIn = new Set(['codex', join(process.env.HOME!, '.codex-work')])
    const list = (await accountsApi.list(true)).filter((a) => a.engine === 'codex')
    expect(list.map((a) => [a.id, a.signedIn])).toEqual([['codex', true], ['codex-work', true]])
  })

  it('reads how much is used from its session file', () => {
    rollout(join(process.env.HOME!, '.codex'), 'th-1', [42, 63], null)
    expect(codexUsage('codex', 'th-1')).toEqual({ status: 'allowed', resetsAt: null, five_hour: { utilization: 0.42, resetsAt: 1791800000 }, seven_day: { utilization: 0.63, resetsAt: 1792300000 } })
    rollout(join(process.env.HOME!, '.codex'), 'th-2', [100, 70], 'primary')
    expect(codexUsage('codex', 'th-2')?.status).toBe('rejected')
  })

  it('carries a chat on to the next account at its limit, thread and all', async () => {
    const dir = join(tmp, 'cproj')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'index.html'), 'x')
    saveMetaFile(dir, { name: 'P', created_at: 1, chats: [{ id: 'k1', title: 'x', session_id: null, created_at: 1, engine: 'codex' }], agents_enabled: true, models: {} })
    await settings.set({ codex_account: 'codex', claude_failover: true })
    await chats.send(dir, 'k1', 'Make it blue')
    expect(fake.codex[0].env.CODEX_HOME).toBeUndefined()
    fake.out!({ type: 'session', id: 'th-9' })
    rollout(join(process.env.HOME!, '.codex'), 'th-9', [100, 50], 'primary')
    fake.out!({ type: 'result', cost_usd: 0, duration_ms: 10, turns: 1, error: true })
    await new Promise((r) => setTimeout(r, 50))
    const again = fake.codex.at(-1)
    expect(again.env.CODEX_HOME).toBe(join(process.env.HOME!, '.codex-work'))
    expect(again.thread).toBe('th-9')
    expect(again.text).toBe('Make it blue')
    expect(existsSync(join(process.env.HOME!, '.codex-work', 'sessions', '2026', '10', '12', 'rollout-2026-10-12T10-00-00-th-9.jsonl'))).toBe(true)
    const st = await chats.open(dir, 'k1')
    expect(st.account).toBe('codex-work')
    expect(st.items.some((i) => 'Note' in i && /Default reached its usage limit. Carrying on with Work/.test(i.Note))).toBe(true)
  })
})
