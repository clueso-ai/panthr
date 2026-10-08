// Claude Code's stream-json, as the chat reads it (port of studio-mac's tests/claude.rs).
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: undefined }))

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeArgs, parse, promptText, summarize, userLine } from '../src/main/agents/claude'

const one = (line: string) => {
  const v = parse(line)
  expect(v).toHaveLength(1)
  return v[0]
}

describe('parse', () => {
  it('system init is the session', () => {
    expect(one('{"type":"system","subtype":"init","session_id":"5f0c-abc","cwd":"/p","tools":["Bash"],"model":"claude-opus"}')).toEqual({ type: 'session', id: '5f0c-abc' })
  })

  it('other system messages are ignored', () => {
    expect(parse('{"type":"system","subtype":"compact_boundary","session_id":"x"}')).toEqual([])
    expect(parse('{"type":"system","subtype":"init"}')).toEqual([])
  })

  it('assistant text and tool use', () => {
    const line = `{"type":"assistant","parent_tool_use_id":null,"session_id":"s","message":{"role":"assistant","content":[
      {"type":"text","text":"Let me look."},
      {"type":"tool_use","id":"toolu_01","name":"Read","input":{"file_path":"/Users/me/Panthr/Promo/index.html"}},
      {"type":"thinking","thinking":"..."}
    ]}}`
    expect(parse(line)).toEqual([
      { type: 'text', text: 'Let me look.', agent: false },
      { type: 'tool', id: 'toolu_01', name: 'Read', summary: 'Read index.html', agent: false }
    ])
  })

  it('blank assistant text is dropped', () => {
    expect(parse('{"type":"assistant","message":{"content":[{"type":"text","text":"  \\n "}]}}')).toEqual([])
  })

  it('subagent messages are marked', () => {
    expect(one('{"type":"assistant","parent_tool_use_id":"toolu_task","message":{"content":[{"type":"tool_use","id":"t2","name":"Bash","input":{"command":"ls"}}]}}')).toMatchObject({ type: 'tool', agent: true })
    expect(one('{"type":"assistant","parent_tool_use_id":"toolu_task","message":{"content":[{"type":"text","text":"sub"}]}}')).toMatchObject({ type: 'text', agent: true })
  })

  it('tool results are tool_done', () => {
    const line = `{"type":"user","message":{"role":"user","content":[
      {"type":"tool_result","tool_use_id":"toolu_01","content":"ok"},
      {"type":"tool_result","tool_use_id":"toolu_02","content":"boom","is_error":true},
      {"type":"text","text":"ignored"}
    ]}}`
    expect(parse(line)).toEqual([
      { type: 'tool_done', id: 'toolu_01', error: false },
      { type: 'tool_done', id: 'toolu_02', error: true }
    ])
  })

  it('a user message with string content is ignored', () => {
    expect(parse('{"type":"user","message":{"role":"user","content":"hello"}}')).toEqual([])
  })

  it('result carries cost, duration, turns', () => {
    expect(one('{"type":"result","subtype":"success","is_error":false,"duration_ms":12345,"num_turns":7,"total_cost_usd":0.4721,"session_id":"s"}'))
      .toEqual({ type: 'result', cost_usd: 0.4721, duration_ms: 12345, turns: 7, error: false })
  })

  it('error result and missing fields', () => {
    expect(one('{"type":"result","subtype":"error_during_execution","is_error":true}')).toEqual({ type: 'result', cost_usd: 0, duration_ms: 0, turns: 0, error: true })
  })

  it('streamed text deltas', () => {
    expect(one('{"type":"stream_event","parent_tool_use_id":null,"event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}}')).toEqual({ type: 'delta', text: 'Hel', agent: false })
    expect(one('{"type":"stream_event","parent_tool_use_id":"toolu_x","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"sub"}}}')).toMatchObject({ type: 'delta', agent: true })
  })

  it('other stream events are ignored', () => {
    for (const l of [
      '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{\\"a"}}}',
      '{"type":"stream_event","event":{"type":"message_start","message":{}}}',
      '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"hm"}}}'
    ]) expect(parse(l)).toEqual([])
  })

  it('garbage and unknown lines are ignored', () => {
    for (const l of ['', 'not json', '[1,2]', '{"type":"rate_limit_event"}', '{"no":"type"}', 'null', '5']) expect(parse(l)).toEqual([])
  })
})

describe('summarize', () => {
  it('Bash prefers the description', () => {
    expect(summarize('Bash', { command: 'npx hyperframes lint', description: 'Check the composition' })).toBe('Check the composition')
    expect(summarize('Bash', { command: 'npx hyperframes lint' })).toBe('npx hyperframes lint')
    expect(summarize('Bash', { command: 'npx hyperframes lint', description: '' })).toBe('npx hyperframes lint')
  })

  it('file tools use the file name', () => {
    expect(summarize('Read', { file_path: '/a/b/index.html' })).toBe('Read index.html')
    expect(summarize('Write', { file_path: '/a/b/compositions/intro.html' })).toBe('Wrote intro.html')
    expect(summarize('Edit', { file_path: '/a/style.css' })).toBe('Edited style.css')
    expect(summarize('MultiEdit', { file_path: '/a/x.js' })).toBe('Edited x.js')
    expect(summarize('Read', {})).toBe('Read ')
  })

  it('search, web, task, todo', () => {
    expect(summarize('Glob', { pattern: '**/*.html' })).toBe('Searched **/*.html')
    expect(summarize('Grep', { pattern: 'data-start' })).toBe('Searched data-start')
    expect(summarize('WebFetch', { url: 'https://hyperframes.dev' })).toBe('Read https://hyperframes.dev')
    expect(summarize('WebSearch', { query: 'gsap stagger' })).toBe('Searched the web for gsap stagger')
    expect(summarize('Task', { description: 'Find fonts' })).toBe('Agent: Find fonts')
    expect(summarize('TodoWrite', { todos: [] })).toBe('Updated its plan')
    expect(summarize('mcp__figma__get_file', {})).toBe('mcp__figma__get_file')
  })

  it('is one line of at most 140 characters', () => {
    expect(summarize('Bash', { command: 'cd x &&\nnpm i\nnpm run build' })).toBe('cd x &&')
    expect(Array.from(summarize('Bash', { command: 'y'.repeat(500) }))).toHaveLength(140)
    expect(Array.from(summarize('Bash', { command: 'é'.repeat(200) }))).toHaveLength(140)
    expect(Array.from(summarize('Bash', { command: '😀'.repeat(200) }))).toHaveLength(140)
    expect(summarize('Bash', {})).toBe('')
  })

  it('non-string fields are empty', () => {
    expect(summarize('Bash', { command: 5 })).toBe('')
    expect(summarize('Read', null)).toBe('Read ')
  })
})

describe('the command line', () => {
  const host = { name: 'box', target: 'me@box', root: '/home/me/Panthr/' }

  it('local: prompt file, library, tools, model, resume', () => {
    process.env.PANTHR_DATA_DIR = mkdtempSync(join(tmpdir(), 'panthr-claude-'))
    const a = claudeArgs({ dir: '/p', resume: 'sess', agents: true, model: 'opus' }, null)
    expect(a.slice(0, 7)).toEqual(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'])
    const at = (flag: string) => a[a.indexOf(flag) + 1]
    expect(at('--append-system-prompt-file')).toBe(join(process.env.PANTHR_DATA_DIR, 'studio_prompt.md'))
    expect(readFileSync(at('--append-system-prompt-file'), 'utf8')).toBe(promptText())
    expect(at('--permission-mode')).toBe('acceptEdits')
    expect(at('--add-dir').endsWith('/Panthr/Library')).toBe(true)
    expect(at('--allowedTools')).toBe('Bash,Read,Write,Edit,MultiEdit,Glob,Grep,WebFetch,WebSearch,TodoWrite,Skill,Task')
    expect(a).not.toContain('--disallowedTools')
    expect(at('--model')).toBe('opus')
    expect(at('--resume')).toBe('sess')
  })

  it('agents off disallows Task; no model, no resume', () => {
    const a = claudeArgs({ dir: '/p', resume: null, agents: false, model: null }, null)
    expect(a[a.indexOf('--disallowedTools') + 1]).toBe('Task')
    expect(a[a.indexOf('--allowedTools') + 1]).toBe('Bash,Read,Write,Edit,MultiEdit,Glob,Grep,WebFetch,WebSearch,TodoWrite,Skill')
    expect(a).not.toContain('--model')
    expect(a).not.toContain('--resume')
  })

  it('on a host: the prompt inline and the host library', () => {
    const a = claudeArgs({ dir: '/p', resume: null, agents: true, model: null }, host)
    expect(a[a.indexOf('--append-system-prompt') + 1]).toBe(promptText())
    expect(a).not.toContain('--append-system-prompt-file')
    expect(a[a.indexOf('--add-dir') + 1]).toBe('/home/me/Panthr/Library')
  })

  it('the user message on stdin', () => {
    expect(JSON.parse(userLine('hi "there"'))).toEqual({ type: 'user', message: { role: 'user', content: 'hi "there"' } })
  })
})

describe('the video instructions', () => {
  it('has its sections', () => {
    const p = promptText()
    expect(p.length).toBeGreaterThan(5000)
    for (const h of ['# Your machine', '# Controls (edit mode)', '# Review comments', '# Motion', '# HyperFrames entry point']) expect(p).toContain(h)
    expect(p).toContain('.studio/comments.json')
    expect(p).toContain('controls.json')
  })
})
