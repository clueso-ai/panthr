// Claude Code: one long-lived `claude -p` process per chat, fed user
// messages as stream-json on stdin and read as stream-json on stdout. The
// Panthr prompt is appended to Claude Code's own; the project folder is its
// working directory; the shared library is an extra dir. Agents are Claude
// Code's own subagents (the Task tool), allowed or not per project.
// Port of studio-mac/src/claude.rs.

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { createInterface } from 'node:readline'
import type { AgentEvent, Host } from '@shared/types'
import { dataDir, libraryDir, resource, toolEnv } from '../paths'
import * as remote from '../remote'

let prompt: string | null = null

/** The video-making instructions (Codex gets them too). */
export function promptText(): string {
  prompt ??= readFileSync(resource('studio_prompt.md'), 'utf8')
  return prompt
}

/** The `claude` binary: the user's own, where Claude Code installs it. */
export function claudeBin(): string {
  const home = homedir()
  for (const p of [join(home, '.local/bin/claude'), join(home, '.claude/local/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude']) {
    if (existsSync(p)) return p
  }
  return 'claude'
}

/** The prompt as a file (rewritten only when it changed). */
export function promptFile(): string {
  const dir = dataDir()
  mkdirSync(dir, { recursive: true })
  const p = join(dir, 'studio_prompt.md')
  let current: string | null = null
  try {
    current = readFileSync(p, 'utf8')
  } catch {}
  if (current !== promptText()) writeFileSync(p, promptText())
  return p
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** First line, at most `n` characters (by code point, as Rust's chars()). */
export function firstLine(s: string, n = 140): string {
  const line = s.split('\n')[0] ?? ''
  return Array.from(line).slice(0, n).join('')
}

/** One line about a tool call, as a person reads it. */
export function summarize(name: string, input: unknown): string {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const s = (k: string): string => str(o[k])
  // Path::file_name: the last component ("" stays "").
  const short = (p: string): string => (p ? basename(p) || p : p)
  let line: string
  switch (name) {
    case 'Bash': {
      const d = s('description')
      line = d === '' ? s('command') : d
      break
    }
    case 'Read': line = `Read ${short(s('file_path'))}`; break
    case 'Write': line = `Wrote ${short(s('file_path'))}`; break
    case 'Edit':
    case 'MultiEdit': line = `Edited ${short(s('file_path'))}`; break
    case 'Glob':
    case 'Grep': line = `Searched ${s('pattern')}`; break
    case 'WebFetch': line = `Read ${s('url')}`; break
    case 'WebSearch': line = `Searched the web for ${s('query')}`; break
    case 'Task': line = `Agent: ${s('description')}`; break
    case 'TodoWrite': line = 'Updated its plan'; break
    default: line = name
  }
  return firstLine(line)
}

/** One stdout line of Claude Code's stream-json, as chat events. */
export function parse(line: string): AgentEvent[] {
  let v: any
  try {
    v = JSON.parse(line)
  } catch {
    return []
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return []
  const out: AgentEvent[] = []
  const agent = v.parent_tool_use_id != null
  const blocks = (): any[] => (Array.isArray(v.message?.content) ? v.message.content : [])
  switch (v.type) {
    case 'system':
      if (v.subtype === 'init' && typeof v.session_id === 'string') out.push({ type: 'session', id: v.session_id })
      break
    case 'stream_event': {
      const e = v.event
      if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta' && typeof e.delta.text === 'string') {
        out.push({ type: 'delta', text: e.delta.text, agent })
      }
      break
    }
    case 'assistant':
      for (const b of blocks()) {
        if (b?.type === 'text') {
          const text = str(b.text)
          if (text.trim() !== '') out.push({ type: 'text', text, agent })
        } else if (b?.type === 'tool_use') {
          const name = str(b.name)
          out.push({ type: 'tool', id: str(b.id), name, summary: summarize(name, b.input), agent })
        }
      }
      break
    case 'user':
      for (const b of blocks()) {
        if (b?.type === 'tool_result') out.push({ type: 'tool_done', id: str(b.tool_use_id), error: b.is_error === true })
      }
      break
    case 'result':
      out.push({
        type: 'result',
        cost_usd: typeof v.total_cost_usd === 'number' ? v.total_cost_usd : 0,
        duration_ms: uint(v.duration_ms),
        turns: uint(v.num_turns),
        error: v.is_error === true
      })
      break
  }
  return out
}

/** serde's as_u64: a non-negative integer, else 0. */
const uint = (n: unknown): number => (typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : 0)

export interface ClaudeOptions {
  dir: string
  resume: string | null
  agents: boolean
  model: string | null
}

/** The command line for a chat's Claude Code (exactly claude.rs's). */
export function claudeArgs(o: ClaudeOptions, host: Host | null): string[] {
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']
  // Replies arrive word by word, not whole at the end of each block.
  args.push('--include-partial-messages')
  if (host) {
    // On a host the prompt goes inline, and the library is the host's.
    args.push('--append-system-prompt', promptText())
    args.push('--permission-mode', 'acceptEdits', '--add-dir', `${host.root.replace(/\/+$/, '')}/Library`)
  } else {
    args.push('--append-system-prompt-file', promptFile())
    args.push('--permission-mode', 'acceptEdits', '--add-dir', libraryDir())
  }
  const allowed = ['Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite', 'Skill']
  if (o.agents) allowed.push('Task')
  else args.push('--disallowedTools', 'Task')
  args.push('--allowedTools', allowed.join(','))
  // Settings ▸ Model (none: whatever Claude Code is set to).
  if (o.model) args.push('--model', o.model)
  if (o.resume) args.push('--resume', o.resume)
  return args
}

/** The user message Claude Code reads on stdin. */
export const userLine = (text: string): string => JSON.stringify({ type: 'user', message: { role: 'user', content: text } })

export class ClaudeChat {
  private child: ChildProcess | null = null
  /** On a remote host: the host and the program's pid there (to stop it). */
  private remotePid: { host: Host; pid: number } | null = null
  /** What the running process was started with (a change restarts it). */
  started: ClaudeOptions | null = null

  running(): boolean {
    const c = this.child
    return !!c && c.exitCode === null && c.signalCode === null
  }

  /** Start (or resume) the chat's Claude Code process. Events go to `out`
   *  ('exited' once its stdout ends); throws when it cannot be started. */
  start(o: ClaudeOptions, out: (e: AgentEvent) => void): void {
    const where = remote.hostOf(o.dir)
    const args = claudeArgs(o, where?.host ?? null)
    const child = where
      ? (() => {
          const r = remote.remoteCommand(where.host, remote.remoteDir(where.host, where.name), 'claude', args)
          return spawn(r.cmd, r.args, { env: toolEnv(), stdio: ['pipe', 'pipe', 'pipe'] })
        })()
      : spawn(claudeBin(), args, { cwd: o.dir, env: toolEnv(), stdio: ['pipe', 'pipe', 'pipe'] })
    child.on('error', () => {}) // reported below (no pid) or by the exit
    // A failed spawn has no pid right away: say so now, as Rust's spawn does.
    if (child.pid === undefined) throw new Error(`could not run ${where ? 'ssh' : claudeBin()}`)
    this.child = child
    this.started = { ...o }
    this.remotePid = null
    child.stdin!.on('error', () => {}) // a dead process: the write fails, the exit says so
    const lines = createInterface({ input: child.stdout! })
    lines.on('line', (line) => {
      if (where) {
        const pid = remote.pidLine(line)
        if (pid != null) {
          this.remotePid = { host: where.host, pid }
          return
        }
      }
      for (const e of parse(line)) out(e)
    })
    lines.on('close', () => out({ type: 'exited' }))
    createInterface({ input: child.stderr! }).on('line', (line) => {
      if (line.trim() !== '') out({ type: 'stderr', line })
    })
  }

  send(text: string): void {
    const stdin = this.child?.stdin
    if (!stdin || !stdin.writable || !this.running()) throw new Error('not running')
    stdin.write(userLine(text) + '\n')
  }

  /** Stop the turn: the process ends; the next message resumes the session. */
  stop(): void {
    // On a host, the program there too (closing ssh does not end it).
    if (this.remotePid) {
      remote.kill(this.remotePid.host, this.remotePid.pid)
      this.remotePid = null
    }
    if (this.child) {
      this.child.kill('SIGKILL')
      this.child = null
    }
    this.started = null
  }
}
