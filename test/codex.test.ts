// Codex's `exec --json`, mapped onto the chat's events (port of studio-mac's tests/codex.rs).
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: undefined }))

import type { AgentEvent } from '@shared/types'
import { codexArgs, models, newRun, parse, step } from '../src/main/agents/codex'

/** Feed lines through parse as one run would. */
function run(lines: string[]): [AgentEvent[], boolean] {
  const st = newRun()
  const ev = lines.flatMap((l) => parse(l, st))
  return [ev, st.failed]
}

const THREAD = '{"type":"thread.started","thread_id":"01a1136e-5d2b-7c41-9a52-d6b0c3a1f001"}'
const TURN_STARTED = '{"type":"turn.started"}'
const CMD_START = `{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc 'cat note.txt'","aggregated_output":"","exit_code":null,"status":"in_progress"}}`
const CMD_DONE = `{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc 'cat note.txt'","aggregated_output":"hello\\n","exit_code":0,"status":"completed"}}`
const FILE_DONE = '{"type":"item.completed","item":{"id":"item_2","type":"file_change","changes":[{"path":"/tmp/x/done.txt","kind":"add"}],"status":"completed"}}'
const MSG_DONE = '{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"Done."}}'
const TURN_DONE = '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":2}}'

describe('step', () => {
  it('a command shows what is inside the shell', () => {
    expect(step({ type: 'command_execution', command: "/bin/zsh -lc 'cat note.txt'" })).toEqual(['Bash', 'cat note.txt'])
    expect(step({ type: 'command_execution', command: 'bash -lc "ls -la"' })![1]).toBe('ls -la')
    expect(step({ type: 'command_execution', command: 'ls' })![1]).toBe('ls')
  })

  it('keeps quotes inside the command', () => {
    expect(step({ type: 'command_execution', command: `/bin/zsh -lc 'echo "hi"'` })![1]).toBe('echo "hi"')
    expect(step({ type: 'command_execution', command: `/bin/zsh -lc 'grep -n "a b" index.html'` })![1]).toBe('grep -n "a b" index.html')
  })

  it('first line, at most 140 characters', () => {
    expect(Array.from(step({ type: 'command_execution', command: `/bin/zsh -lc 'echo ${'x'.repeat(300)}'` })![1])).toHaveLength(140)
    expect(step({ type: 'command_execution', command: "/bin/zsh -lc 'cat <<EOF\nline two\nEOF'" })![1]).toBe('cat <<EOF')
    expect(step({ type: 'command_execution' })).toEqual(['Bash', ''])
  })

  it('a file change lists file names', () => {
    expect(step({ type: 'file_change', changes: [{ path: '/p/a/index.html', kind: 'update' }, { path: '/p/a/compositions/title.html', kind: 'add' }] }))
      .toEqual(['Edit', 'Changed index.html, title.html'])
    expect(step({ type: 'file_change' })![1]).toBe('Changed ')
  })

  it('other kinds', () => {
    expect(step({ type: 'web_search', query: 'gsap ease' })).toEqual(['WebSearch', 'Searched the web for gsap ease'])
    expect(step({ type: 'mcp_tool_call', server: 'figma', tool: 'get_file' })).toEqual(['Tool', 'figma get_file'])
    expect(step({ type: 'todo_list', items: [] })).toEqual(['TodoWrite', 'Updated its plan'])
    expect(step({ type: 'agent_message', text: 'hi' })).toBeNull()
    expect(step({ type: 'reasoning', text: 'hmm' })).toBeNull()
    expect(step({})).toBeNull()
  })
})

describe('parse', () => {
  it('thread.started is the session', () => {
    expect(run([THREAD])[0]).toEqual([{ type: 'session', id: '01a1136e-5d2b-7c41-9a52-d6b0c3a1f001' }])
  })

  it('a whole turn maps onto chat events', () => {
    const [ev, failed] = run([THREAD, TURN_STARTED, CMD_START, CMD_DONE, FILE_DONE, MSG_DONE, TURN_DONE])
    expect(failed).toBe(false)
    expect(ev).toHaveLength(7)
    expect(ev[0].type).toBe('session')
    expect(ev[1]).toEqual({ type: 'tool', id: 'item_1', name: 'Bash', summary: 'cat note.txt', agent: false })
    expect(ev[2]).toEqual({ type: 'tool_done', id: 'item_1', error: false })
    // A file change is only ever reported done: it still shows as a step.
    expect(ev[3]).toEqual({ type: 'tool', id: 'item_2', name: 'Edit', summary: 'Changed done.txt', agent: false })
    expect(ev[4]).toEqual({ type: 'tool_done', id: 'item_2', error: false })
    expect(ev[5]).toEqual({ type: 'text', text: 'Done.', agent: false })
    expect(ev[6]).toMatchObject({ type: 'result', cost_usd: 0, turns: 1, error: false })
  })

  it('a started step is not announced twice', () => {
    expect(run([CMD_START, CMD_DONE])[0].filter((e) => e.type === 'tool')).toHaveLength(1)
  })

  it('a failing command is an error step', () => {
    const done = `{"type":"item.completed","item":{"id":"item_9","type":"command_execution","command":"/bin/zsh -lc 'false'","aggregated_output":"","exit_code":1,"status":"failed"}}`
    expect(run([done])[0].at(-1)).toEqual({ type: 'tool_done', id: 'item_9', error: true })
    // A failed status without an exit code is an error too.
    const declined = '{"type":"item.completed","item":{"id":"item_8","type":"command_execution","command":"rm -rf /","exit_code":null,"status":"failed"}}'
    expect(run([declined])[0].at(-1)).toMatchObject({ type: 'tool_done', error: true })
    expect(run([CMD_DONE])[0].at(-1)).toMatchObject({ type: 'tool_done', error: false })
  })

  it('web search and todo list', () => {
    const ws = '{"type":"item.completed","item":{"id":"item_4","type":"web_search","query":"hyperframes docs"}}'
    const todoStart = '{"type":"item.started","item":{"id":"item_5","type":"todo_list","items":[{"text":"a","completed":false}]}}'
    const todoDone = '{"type":"item.completed","item":{"id":"item_5","type":"todo_list","items":[{"text":"a","completed":true}]}}'
    const [ev] = run([ws, todoStart, todoDone])
    expect(ev).toHaveLength(4)
    expect(ev[0]).toMatchObject({ type: 'tool', name: 'WebSearch', summary: 'Searched the web for hyperframes docs' })
    expect(ev[1]).toMatchObject({ type: 'tool_done', id: 'item_4' })
    expect(ev[2]).toMatchObject({ type: 'tool', name: 'TodoWrite' })
    expect(ev[3]).toEqual({ type: 'tool_done', id: 'item_5', error: false })
  })

  it('an empty agent message is dropped and text trimmed', () => {
    const [ev] = run([
      '{"type":"item.completed","item":{"id":"m","type":"agent_message","text":"   \\n"}}',
      '{"type":"item.completed","item":{"id":"m2","type":"agent_message","text":"\\n  All set.  \\n"}}'
    ])
    expect(ev).toEqual([{ type: 'text', text: 'All set.', agent: false }])
  })

  it('reasoning and unknown events are ignored', () => {
    const [ev, failed] = run([
      '{"type":"item.started","item":{"id":"r","type":"reasoning","text":"thinking"}}',
      '{"type":"item.completed","item":{"id":"r","type":"reasoning","text":"thinking"}}',
      '{"type":"item.updated","item":{"id":"t","type":"todo_list","items":[]}}',
      '{"type":"something.new"}',
      'not json at all',
      ''
    ])
    expect(ev).toEqual([])
    expect(failed).toBe(false)
  })

  it('turn.failed reports the message', () => {
    const [ev, failed] = run(['{"type":"turn.failed","error":{"message":"usage limit reached"}}'])
    expect(failed).toBe(true)
    expect(ev).toHaveLength(2)
    expect(ev[0]).toEqual({ type: 'stderr', line: 'error: usage limit reached' })
    expect(ev[1]).toMatchObject({ type: 'result', error: true, turns: 1 })
  })

  it('an error event with a top-level message', () => {
    const [ev, failed] = run(['{"type":"error","message":"stream disconnected"}'])
    expect(failed).toBe(true)
    expect(ev[0]).toEqual({ type: 'stderr', line: 'error: stream disconnected' })
  })

  it('an error without a message has a default', () => {
    expect(run(['{"type":"turn.failed"}'])[0][0]).toEqual({ type: 'stderr', line: 'error: Codex stopped with an error' })
  })
})

describe('the command line', () => {
  it('a new thread', () => {
    const a = codexArgs({ dir: '/p', thread: null, text: 'Make it blue', model: null, instructions: 'Be "nice"\nok' }, null)
    expect(a.slice(0, 7)).toEqual(['exec', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode="workspace-write"', '-c', 'sandbox_workspace_write.network_access=true'])
    // `exec resume` rejects -s and --add-dir: only -c config works for both.
    expect(a).not.toContain('-s')
    expect(a).not.toContain('--add-dir')
    expect(a[8]).toBe('developer_instructions="Be \\"nice\\"\\nok"')
    expect(a.find((x) => x.startsWith('sandbox_workspace_write.writable_roots='))).toMatch(/\/Panthr\/Library"\]$/)
    expect(a).not.toContain('-m')
    expect(a.at(-1)).toBe('Make it blue')
  })

  it('resuming, with a model, on a host', () => {
    const a = codexArgs({ dir: '/p', thread: 't1', text: 'x', model: 'gpt-5', instructions: '' }, { name: 'b', target: 'b', root: '/srv/Panthr' })
    expect(a.slice(0, 3)).toEqual(['exec', 'resume', 't1'])
    expect(a[a.indexOf('-m') + 1]).toBe('gpt-5')
    expect(a).toContain('sandbox_workspace_write.writable_roots=["/srv/Panthr/Library"]')
    expect(a).not.toContain('-s')
  })
})

describe('models', () => {
  const home = process.env.HOME
  afterEach(() => {
    process.env.HOME = home
  })

  it('reads the cache, hiding hidden ones', () => {
    const h = mkdtempSync(join(tmpdir(), 'panthr-codex-'))
    process.env.HOME = h
    expect(models()).toEqual([])
    mkdirSync(join(h, '.codex'))
    writeFileSync(join(h, '.codex/models_cache.json'), JSON.stringify({ models: [
      { slug: 'gpt-5-codex', display_name: 'GPT-5 Codex' },
      { slug: 'secret', visibility: 'hide' },
      { id: 'o4' },
      { display_name: 'no id' }
    ] }))
    expect(models()).toEqual([{ id: 'gpt-5-codex', name: 'GPT-5 Codex' }, { id: 'o4', name: 'o4' }])
    writeFileSync(join(h, '.codex/models_cache.json'), JSON.stringify([{ slug: 'a' }]))
    expect(models()).toEqual([{ id: 'a', name: 'a' }])
  })
})
