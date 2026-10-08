// The chat: transcripts built from recorded agent streams, and the chat
// lifecycle (send, queue, titles, sessions, stop, engines, notes) with fake
// agent processes: no real claude / codex ever runs here.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '@shared/types'

vi.mock('electron', () => ({ app: undefined }))
const emitted: [string, any][] = []
vi.mock('../src/main/bus', () => ({ emit: (n: string, p: any) => emitted.push([n, structuredClone(p)]) }))

/** What the fake agents were asked to do. */
const fake = vi.hoisted(() => ({
  starts: [] as any[],
  sent: [] as string[],
  codex: [] as any[],
  out: null as null | ((e: any) => void),
  alive: false,
  failStart: false
}))
vi.mock('../src/main/agents/claude', async (orig) => {
  const real: any = await orig()
  class ClaudeChat {
    started: any = null
    running() { return fake.alive }
    start(o: any, out: (e: any) => void) {
      if (fake.failStart) throw new Error('could not run claude')
      fake.starts.push(o)
      fake.out = out
      fake.alive = true
      this.started = o
    }
    send(text: string) { fake.sent.push(text) }
    stop() { fake.alive = false; this.started = null }
  }
  return { ...real, ClaudeChat, promptText: () => 'PROMPT' }
})
vi.mock('../src/main/agents/codex', async (orig) => {
  const real: any = await orig()
  class CodexRun {
    running() { return false }
    send(o: any, out: (e: any) => void) { fake.codex.push(o); fake.out = out }
    stop() {}
  }
  return { ...real, CodexRun }
})

import { parse as claudeParse } from '../src/main/agents/claude'
import { newRun, parse as codexParse } from '../src/main/agents/codex'
import { Transcript, chats, anyWorking, stopAll, titleFrom, modelsFor, _test } from '../src/main/chats'
import { chatPath, loadMeta, saveMetaFile } from '../src/main/projects'

const env = { HOME: process.env.HOME, DATA: process.env.PANTHR_DATA_DIR }
let tmp = ''
let n = 0
function project(meta: Partial<import('@shared/types').ProjectMeta> = {}): string {
  const dir = join(tmp, `p${n++}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'index.html'), 'x')
  saveMetaFile(dir, { name: 'P', created_at: 1, chats: [], agents_enabled: true, models: {}, ...meta })
  return dir
}
const feed = (...evs: AgentEvent[]) => evs.forEach((e) => fake.out!(e))
const flushSaves = () => new Promise((r) => setTimeout(r, 350))

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'panthr-chats-'))
  process.env.HOME = join(tmp, 'home')
  process.env.PANTHR_DATA_DIR = join(tmp, 'data')
})
afterAll(() => {
  stopAll()
  process.env.HOME = env.HOME
  process.env.PANTHR_DATA_DIR = env.DATA
})
beforeEach(() => {
  emitted.length = 0
  Object.assign(fake, { starts: [], sent: [], codex: [], out: null, alive: false, failStart: false })
})

// ── The transcript from recorded streams ───────────────────────────

const CLAUDE_TURN = [
  '{"type":"system","subtype":"init","session_id":"sess-1"}',
  '{"type":"stream_event","parent_tool_use_id":null,"event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Let me "}}}',
  '{"type":"stream_event","parent_tool_use_id":null,"event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"look."}}}',
  '{"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"text","text":"Let me look."},{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"/p/index.html"}}]}}',
  '{"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"tool_use","id":"t2","name":"Task","input":{"description":"Find fonts"}}]}}',
  '{"type":"assistant","parent_tool_use_id":"t2","message":{"content":[{"type":"text","text":"sub words"},{"type":"tool_use","id":"t3","name":"Bash","input":{"command":"ls"}}]}}',
  '{"type":"stream_event","parent_tool_use_id":"t2","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"sub"}}}',
  '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}',
  '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t3","content":"no","is_error":true}]}}',
  '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t2","content":"done"}]}}',
  '{"type":"stream_event","parent_tool_use_id":null,"event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Done"}}}',
  '{"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"text","text":"Done: blue now."}]}}',
  '{"type":"result","is_error":false,"duration_ms":4500,"num_turns":3,"total_cost_usd":0.12}'
]

describe('Transcript', () => {
  it('builds a Claude turn: streamed text replaced by the block, steps grouped, subagent words kept out', () => {
    const t = new Transcript([{ User: 'Make it blue' }])
    t.working = true
    const seen: any[] = []
    for (const l of CLAUDE_TURN) for (const e of claudeParse(l)) seen.push(t.apply(e))
    expect(t.sessionId).toBe('sess-1')
    expect(seen[0]).toEqual({ session: 'sess-1' })
    expect(t.items).toEqual([
      { User: 'Make it blue' },
      { Text: 'Let me look.' },
      { Steps: [
        { id: 't1', name: 'Read', summary: 'Read index.html', agent: false, done: true, error: false },
        { id: 't2', name: 'Task', summary: 'Agent: Find fonts', agent: false, done: true, error: false },
        { id: 't3', name: 'Bash', summary: 'ls', agent: true, done: true, error: true }
      ] },
      { Text: 'Done: blue now.' },
      { Meta: { cost_usd: 0.12, seconds: 4.5, error: false } }
    ])
    expect(t.working).toBe(false)
    expect(t.streaming).toBeNull()
  })

  it('streams deltas into one reply and points at it', () => {
    const t = new Transcript()
    expect(t.apply({ type: 'delta', text: 'Hel', agent: false })).toEqual({ streamed: true })
    t.apply({ type: 'delta', text: 'lo', agent: false })
    expect(t.items).toEqual([{ Text: 'Hello' }])
    expect(t.streaming).toBe(0)
    // A step ends the streamed reply: the next words are a new one.
    t.apply({ type: 'tool', id: 'a', name: 'Bash', summary: 'x', agent: false })
    t.apply({ type: 'delta', text: 'More', agent: false })
    expect(t.items).toHaveLength(3)
    expect(t.items[2]).toEqual({ Text: 'More' })
  })

  it('builds a Codex turn', () => {
    const t = new Transcript([], 'codex')
    t.begin('Hi')
    const st = newRun()
    for (const l of [
      '{"type":"thread.started","thread_id":"th-1"}',
      `{"type":"item.started","item":{"id":"i1","type":"command_execution","command":"/bin/zsh -lc 'ls'","exit_code":null}}`,
      `{"type":"item.completed","item":{"id":"i1","type":"command_execution","command":"/bin/zsh -lc 'ls'","exit_code":0,"status":"completed"}}`,
      '{"type":"item.completed","item":{"id":"i2","type":"file_change","changes":[{"path":"/p/index.html"}]}}',
      '{"type":"item.completed","item":{"id":"i3","type":"agent_message","text":"Done."}}',
      '{"type":"turn.completed"}'
    ]) for (const e of codexParse(l, st)) t.apply(e)
    expect(t.sessionId).toBe('th-1')
    expect(t.items.slice(1, 3)).toEqual([
      { Steps: [
        { id: 'i1', name: 'Bash', summary: 'ls', agent: false, done: true, error: false },
        { id: 'i2', name: 'Edit', summary: 'Changed index.html', agent: false, done: true, error: false }
      ] },
      { Text: 'Done.' }
    ])
    expect(t.items[3]).toMatchObject({ Meta: { cost_usd: 0, error: false } })
    expect(t.working).toBe(false)
  })

  it('stderr shows only errors; an exit mid-turn is a note', () => {
    const t = new Transcript([], 'codex')
    t.apply({ type: 'stderr', line: 'warming up' })
    t.apply({ type: 'stderr', line: 'Error: rate limited' })
    expect(t.items).toEqual([{ Note: 'Error: rate limited' }])
    expect(t.apply({ type: 'exited' })).toEqual({})
    t.begin('x')
    expect(t.apply({ type: 'exited' })).toEqual({ turnEnded: true })
    expect(t.items.at(-1)).toEqual({ Note: 'Codex stopped' })
    const c = new Transcript()
    c.begin('x')
    c.apply({ type: 'exited' })
    expect(c.items.at(-1)).toEqual({ Note: 'Claude Code stopped' })
  })

  it('a done tool finds its step in an earlier group', () => {
    const t = new Transcript([{ Steps: [{ id: 'old', name: 'Bash', summary: '', agent: false, done: false, error: false }] }, { Text: 'x' }, { Steps: [] }])
    t.apply({ type: 'tool_done', id: 'old', error: true })
    expect((t.items[0] as any).Steps[0]).toMatchObject({ done: true, error: true })
  })

  it('titles are the first 40 characters', () => {
    expect(titleFrom('a'.repeat(50))).toBe('a'.repeat(40))
    expect(Array.from(titleFrom('😀'.repeat(50)))).toHaveLength(40)
  })
})

// ── The chat ───────────────────────────────────────────────────────

describe('chats', () => {
  it('create, open (loading the transcript), engine from Settings', async () => {
    const dir = project()
    const id = await chats.create(dir)
    expect(loadMeta(dir)!.chats).toMatchObject([{ id, title: 'New chat', session_id: null, engine: null }])
    mkdirSync(join(dir, '.studio/chats'), { recursive: true })
    writeFileSync(chatPath(dir, id), JSON.stringify([{ User: 'old' }, { Text: 'reply' }]))
    const s = await chats.open(dir, id)
    expect(s).toMatchObject({ dir, chatId: id, working: false, engine: 'claude', queued: [], streaming: null })
    expect(s.items).toEqual([{ User: 'old' }, { Text: 'reply' }])
  })

  it('a whole Claude turn: start args, title, session, streaming, save, turn end', async () => {
    const dir = project({ models: { claude: 'opus' }, agents_enabled: false })
    const id = await chats.create(dir)
    await chats.send(dir, id, 'Make a launch teaser for our new feature please')
    expect(fake.starts).toEqual([{ dir, resume: null, agents: false, model: 'opus' }])
    expect(fake.sent).toEqual(['Make a launch teaser for our new feature please'])
    expect(loadMeta(dir)!.chats[0].title).toBe('Make a launch teaser for our new feature')
    expect(emitted.find(([n]) => n === 'chat:titled')![1]).toEqual({ dir, chatId: id, title: 'Make a launch teaser for our new feature' })
    expect(JSON.parse(readFileSync(chatPath(dir, id), 'utf8'))).toEqual([{ User: 'Make a launch teaser for our new feature please' }])
    expect(await anyWorking()).toBe(true)

    for (const l of CLAUDE_TURN) for (const e of claudeParse(l)) fake.out!(e)
    expect(loadMeta(dir)!.chats[0].session_id).toBe('sess-1')
    expect(emitted.some(([n, p]) => n === 'chat:session' && p.sessionId === 'sess-1')).toBe(true)
    expect(emitted.some(([n]) => n === 'chat:turn')).toBe(true)
    const last = emitted.filter(([n]) => n === 'chat:state').at(-1)![1]
    expect(last.working).toBe(false)
    expect(last.items.at(-1)).toEqual({ Meta: { cost_usd: 0.12, seconds: 4.5, error: false } })
    // Saved compactly, as Rust's to_vec.
    const text = readFileSync(chatPath(dir, id), 'utf8')
    expect(text).not.toContain('\n')
    expect(JSON.parse(text)).toHaveLength(5)
    expect(await anyWorking()).toBe(false)

    // The next message goes to the same process; the title stays.
    await chats.send(dir, id, 'Now make it red')
    expect(fake.starts).toHaveLength(1)
    expect(fake.sent.at(-1)).toBe('Now make it red')
    expect(loadMeta(dir)!.chats[0].title).toBe('Make a launch teaser for our new feature')
    fake.out!({ type: 'result', cost_usd: 0, duration_ms: 1, turns: 1, error: false })
  })

  it('messages typed while it works wait their turn', async () => {
    const dir = project()
    const id = await chats.create(dir)
    await chats.send(dir, id, 'one')
    await chats.send(dir, id, 'two')
    await chats.send(dir, id, '   ')
    expect(fake.sent).toEqual(['one'])
    expect(emitted.filter(([n]) => n === 'chat:state').at(-1)![1].queued).toEqual(['two'])
    feed({ type: 'result', cost_usd: 0, duration_ms: 10, turns: 1, error: false })
    await new Promise((r) => setTimeout(r, 0))
    expect(fake.sent).toEqual(['one', 'two'])
    const s = await chats.open(dir, id)
    expect(s.queued).toEqual([])
    expect(s.working).toBe(true)
    feed({ type: 'result', cost_usd: 0, duration_ms: 10, turns: 1, error: false })
  })

  it('resumes the saved session, and restarts for a new model', async () => {
    const dir = project()
    const id = await chats.create(dir)
    const m = loadMeta(dir)!
    m.chats[0].session_id = 'prev'
    saveMetaFile(dir, m)
    await chats.send(dir, id, 'hi')
    expect(fake.starts[0]).toMatchObject({ resume: 'prev', agents: true, model: null })
    feed({ type: 'result', cost_usd: 0, duration_ms: 10, turns: 1, error: false })
    await chats.send(dir, id, 'again')
    expect(fake.starts).toHaveLength(1)
    feed({ type: 'result', cost_usd: 0, duration_ms: 10, turns: 1, error: false })
    // The window picks another model: the next turn starts a new process with it.
    await import('../src/main/projects').then((p) => p.projects.saveMeta(dir, { ...loadMeta(dir)!, models: { claude: 'haiku' } }))
    await chats.send(dir, id, 'third')
    expect(fake.starts).toHaveLength(2)
    expect(fake.starts[1]).toMatchObject({ resume: 'prev', model: 'haiku' })
    feed({ type: 'result', cost_usd: 0, duration_ms: 10, turns: 1, error: false })
  })

  it('stop: a note, the turn ends, late events from the old process are dropped', async () => {
    const dir = project()
    const id = await chats.create(dir)
    await chats.send(dir, id, 'go')
    const old = fake.out!
    old({ type: 'delta', text: 'Work', agent: false })
    await chats.stop(dir, id)
    old({ type: 'exited' })
    const s = await chats.open(dir, id)
    expect(s.working).toBe(false)
    expect(s.streaming).toBeNull()
    expect(s.items).toEqual([{ User: 'go' }, { Text: 'Work' }, { Note: 'Stopped' }])
    expect(emitted.filter(([n]) => n === 'chat:turn')).toHaveLength(1)
    // The next message starts it again, resuming.
    await chats.send(dir, id, 'again')
    expect(fake.starts).toHaveLength(2)
    feed({ type: 'result', cost_usd: 0, duration_ms: 10, turns: 1, error: false })
  })

  it('a failed start is a note, and nothing is sent', async () => {
    const dir = project()
    const id = await chats.create(dir)
    fake.failStart = true
    await chats.send(dir, id, 'hello')
    const s = await chats.open(dir, id)
    expect(s.items).toEqual([{ Note: 'Could not start Claude Code: could not run claude' }])
    expect(s.working).toBe(false)
    expect(loadMeta(dir)!.chats[0].title).toBe('New chat')
  })

  it('codex: one run per message, resuming the thread, with its model', async () => {
    const dir = project({ models: { codex: 'gpt-5-codex' } })
    const id = await chats.create(dir, 'codex')
    await chats.send(dir, id, 'first')
    expect(fake.codex[0]).toEqual({ dir, thread: null, text: 'first', model: 'gpt-5-codex', instructions: 'PROMPT' })
    feed({ type: 'session', id: 'th-9' }, { type: 'text', text: 'ok', agent: false }, { type: 'result', cost_usd: 0, duration_ms: 1000, turns: 1, error: false })
    await chats.send(dir, id, 'second')
    expect(fake.codex[1]).toMatchObject({ thread: 'th-9', text: 'second' })
    // A run that ends without a turn.completed says so.
    feed({ type: 'exited' })
    const s = await chats.open(dir, id)
    expect(s.engine).toBe('codex')
    expect(s.items.at(-1)).toEqual({ Note: 'Codex stopped' })
    expect(fake.starts).toEqual([])
  })

  it('the engine switches only while the chat is empty', async () => {
    const dir = project()
    const id = await chats.create(dir)
    await chats.setEngine(dir, id, 'codex')
    expect(loadMeta(dir)!.chats[0]).toMatchObject({ engine: 'codex', session_id: null })
    expect((await chats.open(dir, id)).engine).toBe('codex')
    await chats.send(dir, id, 'x')
    feed({ type: 'result', cost_usd: 0, duration_ms: 1, turns: 1, error: false })
    await chats.setEngine(dir, id, 'claude')
    expect(loadMeta(dir)!.chats[0].engine).toBe('codex')
  })

  it('notes are saved and shown', async () => {
    const dir = project()
    const id = await chats.create(dir)
    await chats.note(dir, id, 'Moved Title to 1.2 s')
    expect(JSON.parse(readFileSync(chatPath(dir, id), 'utf8'))).toEqual([{ Note: 'Moved Title to 1.2 s' }])
    expect(emitted.filter(([n]) => n === 'chat:state').at(-1)![1].items).toEqual([{ Note: 'Moved Title to 1.2 s' }])
  })

  it('streaming updates are throttled and not saved each time', async () => {
    const dir = project()
    const id = await chats.create(dir)
    await chats.send(dir, id, 'go')
    emitted.length = 0
    for (let i = 0; i < 50; i++) feed({ type: 'delta', text: 'w', agent: false })
    expect(emitted.filter(([n]) => n === 'chat:state').length).toBeLessThanOrEqual(2)
    await new Promise((r) => setTimeout(r, 60))
    const last = emitted.filter(([n]) => n === 'chat:state').at(-1)![1]
    expect(last.items.at(-1)).toEqual({ Text: 'w'.repeat(50) })
    expect(last.streaming).toBe(1)
    expect(JSON.parse(readFileSync(chatPath(dir, id), 'utf8'))).toEqual([{ User: 'go' }])
    // A tool event is saved (debounced).
    feed({ type: 'tool', id: 'a', name: 'Bash', summary: 'ls', agent: false })
    await flushSaves()
    expect(JSON.parse(readFileSync(chatPath(dir, id), 'utf8'))).toHaveLength(3)
    feed({ type: 'result', cost_usd: 0, duration_ms: 1, turns: 1, error: false })
  })

  it('remove: the chat and its transcript go', async () => {
    const dir = project()
    const id = await chats.create(dir)
    await chats.note(dir, id, 'x')
    await chats.remove(dir, id)
    expect(loadMeta(dir)!.chats).toEqual([])
    expect(() => readFileSync(chatPath(dir, id))).toThrow()
    expect(_test.live.size).toBeGreaterThan(0)
  })

  it('models: Claude fixed, Codex its cache after Default', async () => {
    expect((await chats.models('claude')).map((m) => m.id)).toEqual(['default', 'opus', 'sonnet', 'haiku'])
    mkdirSync(join(process.env.HOME!, '.codex'), { recursive: true })
    writeFileSync(join(process.env.HOME!, '.codex/models_cache.json'), JSON.stringify({ models: Array.from({ length: 9 }, (_, i) => ({ slug: `m${i}` })) }))
    const c = modelsFor('codex')
    expect(c).toHaveLength(7)
    expect(c[0]).toEqual({ id: 'default', name: 'Default' })
  })
})
