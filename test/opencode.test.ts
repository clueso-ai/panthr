// OpenCode's `run --format json`, mapped onto the chat's events. The lines
// are from real runs of OpenCode 2.0.29 (paths and long fields trimmed).
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: undefined }))

import type { AgentEvent } from '@shared/types'
import { finish, newRun, opencodeArgs, opencodeConfig, parse, parseModels, recentModels, step } from '../src/main/agents/opencode'
import { opencodeProviders } from '../src/main/accounts'

const SID = 'ses_ebc2acee9ffechQXd9mLmWeS3T'
const STEP_START = `{"type":"step_start","timestamp":1792139412011,"sessionID":"${SID}","part":{"id":"prt_1","sessionID":"${SID}","messageID":"msg_1","type":"step-start"}}`
const TEXT = `{"type":"text","timestamp":1792139412318,"sessionID":"${SID}","part":{"id":"prt_2","sessionID":"${SID}","messageID":"msg_1","type":"text","text":"I'll do these one at a time.\\n\\n**Step 1: read a.txt**","time":{"start":1792139412036,"end":1792139412318}}}`
const READ = `{"type":"tool_use","timestamp":1792139412323,"sessionID":"${SID}","part":{"partID":"prt_3","sessionID":"${SID}","messageID":"msg_1","type":"tool","id":"call_00_c6irjd14ftka2qogrvgcqdqt","tool":"read","state":{"status":"completed","input":{"path":"a.txt"},"title":"read","metadata":{"metadata":{"truncated":false}},"time":{"start":1792139412295,"end":1792139412323}}}}`
const STEP_DONE = `{"type":"step_finish","timestamp":1792139412325,"sessionID":"${SID}","part":{"id":"prt_4","sessionID":"${SID}","messageID":"msg_1","type":"step-finish","reason":"tool-calls","cost":0.0125,"tokens":{"input":100,"output":55,"reasoning":10,"cache":{"read":10112,"write":0}}}}`
const EDIT = `{"type":"tool_use","sessionID":"${SID}","part":{"partID":"prt_5","type":"tool","id":"call_00_eyi1zibasacy03h245rin2bw","tool":"edit","state":{"status":"completed","input":{"path":"/p/video/index.html","oldString":"one","newString":"two"},"title":"edit","metadata":{"metadata":{"truncated":false}}}}}`
const SHELL_FAILED = `{"type":"tool_use","sessionID":"${SID}","part":{"partID":"prt_6","type":"tool","id":"call_00_ehkaaj2r2ncn4sh5k08pgkcg","tool":"shell","state":{"status":"completed","input":{"command":"sleep 2; false"},"title":"shell","metadata":{"metadata":{"status":"completed","truncated":false,"exit":1}}}}}`
const READ_MISSING = `{"type":"tool_use","sessionID":"${SID}","part":{"partID":"prt_7","type":"tool","id":"call_00_gfox9bggx25glrbapp4iy63q","tool":"read","state":{"status":"error","input":{"path":"nope/missing.txt"},"error":"File not found: nope/missing.txt"}}}`
const LAST_TEXT = `{"type":"text","sessionID":"${SID}","part":{"id":"prt_8","sessionID":"${SID}","messageID":"msg_2","type":"text","text":"done"}}`
const NO_MODEL = '{"type":"error","timestamp":1792139402089,"sessionID":"ses_ebc2ae979ffe8rUSTGJk5cSmxY","error":{"type":"provider.no-route","message":"Model unavailable: nope/not-a-model"}}'

/** Feed lines through parse as one run would, and end it with `code`. */
function run(lines: string[], code: number | null = 0, reason?: string): AgentEvent[] {
  const st = newRun()
  return [...lines.flatMap((l) => parse(l, st)), ...finish(st, code, reason)]
}

describe('step', () => {
  it('names steps as Claude Code does, so the chat shows them alike', () => {
    expect(step('shell', { command: 'ls -la' })).toEqual(['Bash', 'ls -la'])
    expect(step('bash', { command: 'npx hyperframes render', description: 'Render the video' })).toEqual(['Bash', 'Render the video'])
    expect(step('read', { path: '/p/a/index.html' })).toEqual(['Read', 'Read index.html'])
    expect(step('write', { filePath: '/p/a/title.html' })).toEqual(['Write', 'Wrote title.html'])
    expect(step('edit', { path: 'b.txt', oldString: 'one', newString: 'two' })).toEqual(['Edit', 'Edited b.txt'])
    expect(step('glob', { pattern: '*.txt' })).toEqual(['Glob', 'Searched *.txt'])
    expect(step('grep', { pattern: 'two', path: '.' })).toEqual(['Grep', 'Searched two'])
    expect(step('webfetch', { url: 'https://gsap.com' })).toEqual(['WebFetch', 'Read https://gsap.com'])
    expect(step('task', { description: 'Check the captions' })).toEqual(['Task', 'Agent: Check the captions'])
    expect(step('todowrite', { todos: [] })).toEqual(['TodoWrite', 'Updated its plan'])
    expect(step('linear_list_issues', {})).toEqual(['Tool', 'linear_list_issues'])
  })

  it('first line, at most 140 characters', () => {
    expect(Array.from(step('shell', { command: `echo ${'x'.repeat(300)}` })[1])).toHaveLength(140)
    expect(step('shell', { command: 'cat <<EOF\nline two\nEOF' })[1]).toBe('cat <<EOF')
    expect(step('shell', undefined)).toEqual(['Bash', ''])
  })
})

describe('parse', () => {
  it('a whole turn maps onto chat events', () => {
    const ev = run([STEP_START, TEXT, READ, STEP_DONE, EDIT, SHELL_FAILED, READ_MISSING, STEP_DONE, LAST_TEXT])
    expect(ev[0]).toEqual({ type: 'session', id: SID })
    expect(ev[1]).toEqual({ type: 'text', text: "I'll do these one at a time.\n\n**Step 1: read a.txt**", agent: false })
    // A step is only reported once it is over: shown and finished at once.
    expect(ev[2]).toEqual({ type: 'tool', id: 'call_00_c6irjd14ftka2qogrvgcqdqt', name: 'Read', summary: 'Read a.txt', agent: false })
    expect(ev[3]).toEqual({ type: 'tool_done', id: 'call_00_c6irjd14ftka2qogrvgcqdqt', error: false })
    expect(ev[4]).toMatchObject({ type: 'tool', name: 'Edit', summary: 'Edited index.html' })
    expect(ev[5]).toMatchObject({ type: 'tool_done', error: false })
    // A command that exits non-zero, and a tool that failed, are failed steps.
    expect(ev[6]).toMatchObject({ type: 'tool', name: 'Bash', summary: 'sleep 2; false' })
    expect(ev[7]).toEqual({ type: 'tool_done', id: 'call_00_ehkaaj2r2ncn4sh5k08pgkcg', error: true })
    expect(ev[9]).toEqual({ type: 'tool_done', id: 'call_00_gfox9bggx25glrbapp4iy63q', error: true })
    expect(ev[10]).toEqual({ type: 'text', text: 'done', agent: false })
    // The process ending is the turn's end: its steps' cost and tokens added up.
    expect(ev[11]).toMatchObject({ type: 'result', turns: 1, error: false, cost_usd: 0.025, tokens: 2 * (100 + 55 + 10 + 10112) })
    expect(ev).toHaveLength(12)
  })

  it('the session is announced once', () => {
    const ev = run([STEP_START, TEXT, STEP_DONE])
    expect(ev.filter((e) => e.type === 'session')).toHaveLength(1)
  })

  it('an error ends the turn as failed, saying why', () => {
    const ev = run([NO_MODEL], 1)
    expect(ev).toEqual([
      { type: 'session', id: 'ses_ebc2ae979ffe8rUSTGJk5cSmxY' },
      { type: 'stderr', line: 'error: Model unavailable: nope/not-a-model' },
      expect.objectContaining({ type: 'result', error: true, cost_usd: 0 })
    ])
  })

  it('dying without an error is an exit, with its last words', () => {
    expect(run([STEP_START], 137, 'Killed')).toEqual([{ type: 'session', id: SID }, { type: 'exited', reason: 'Killed' }])
    expect(run([], null)).toEqual([{ type: 'exited', reason: undefined }])
  })

  it('ignores what is not its JSON', () => {
    expect(run(['not json', '', '[]', '{"type":"reasoning"}'], 0)).toEqual([expect.objectContaining({ type: 'result', error: false })])
  })
})

describe('the command line', () => {
  it('a first message: its own agent, permissions answered, a private server', () => {
    expect(opencodeArgs({ dir: '/p', session: null, text: 'Make it blue', model: null, instructions: 'x' }))
      .toEqual(['run', '--standalone', '--format', 'json', '--auto', '--agent', 'panther', '--', 'Make it blue'])
  })

  it('a follow-up resumes its session, with the chosen model; a dash is not a flag', () => {
    expect(opencodeArgs({ dir: '/p', session: 'ses_1', text: '-- shorter', model: 'openai/gpt-5.5', instructions: '' }))
      .toEqual(['run', '--standalone', '--format', 'json', '--auto', '--agent', 'panther', '--session', 'ses_1', '--model', 'openai/gpt-5.5', '--', '-- shorter'])
  })

  it('the instructions are the prompt of its agent', () => {
    const c = JSON.parse(opencodeConfig('Be "nice"\nok'))
    expect(c.agent.panther).toMatchObject({ mode: 'primary', prompt: 'Be "nice"\nok' })
  })
})

describe('models and sign-in', () => {
  const saved = process.env.HOME
  afterEach(() => {
    process.env.HOME = saved
  })

  it('reads `opencode models`', () => {
    expect(parseModels('openai/gpt-5.5\nopencode-go/glm-5.3\n\nopencode/deepseek-v4.1-flash-free\nWarning: something\n')).toEqual([
      { id: 'openai/gpt-5.5', name: 'openai/gpt-5.5' },
      { id: 'opencode-go/glm-5.3', name: 'opencode-go/glm-5.3' },
      { id: 'opencode/deepseek-v4.1-flash-free', name: 'opencode/deepseek-v4.1-flash-free' }
    ])
  })

  it('knows the models it used last', () => {
    const h = mkdtempSync(join(tmpdir(), 'panthr-opencode-'))
    process.env.HOME = h
    expect(recentModels()).toEqual([])
    mkdirSync(join(h, '.local/state/opencode'), { recursive: true })
    writeFileSync(join(h, '.local/state/opencode/model.json'), JSON.stringify({ recent: [{ providerID: 'openai', modelID: 'gpt-5.5' }, { providerID: 'x' }], favorite: [] }))
    expect(recentModels()).toEqual(['openai/gpt-5.5'])
  })

  it('signed in: a provider with a connection (only names read)', () => {
    expect(opencodeProviders('[{"id":"openai","name":"OpenAI","connections":[{"type":"credential","id":"c1","method":"oauth"}]},{"id":"x","name":"X","connections":[]}]')).toEqual(['OpenAI'])
    expect(opencodeProviders('[]')).toEqual([])
    expect(opencodeProviders('')).toBeNull()
  })
})
