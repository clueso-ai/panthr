// Codex (OpenAI's coding agent) as the one making the video: one
// `codex exec --json` per message, resuming the chat's thread, with the same
// instructions Claude Code gets. Its events are mapped onto the chat's own
// (AgentEvent), so the chat shows either agent the same way.
// Port of studio-mac/src/codex.rs.

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { createInterface } from 'node:readline'
import type { AgentEvent, Host, Model } from '@shared/types'
import { libraryDir, toolEnv } from '../paths'
import * as remote from '../remote'
import { firstLine } from './claude'

/** The `codex` binary: the user's own. */
export function codexBin(): string {
  const home = homedir()
  for (const p of [join(home, '.local/bin/codex'), '/opt/homebrew/bin/codex', '/usr/local/bin/codex']) {
    if (existsSync(p)) return p
  }
  return 'codex'
}

/** The models Codex lists (its own cache). */
export function models(): Model[] {
  let v: any
  try {
    v = JSON.parse(readFileSync(join(homedir(), '.codex/models_cache.json'), 'utf8'))
  } catch {
    return []
  }
  const list = v && typeof v === 'object' && 'models' in v ? v.models : v
  if (!Array.isArray(list)) return []
  const out: Model[] = []
  for (const m of list) {
    if (m?.visibility === 'hide') continue
    const id = typeof m?.slug === 'string' ? m.slug : typeof m?.id === 'string' ? m.id : null
    if (id == null) continue
    out.push({ id, name: typeof m.display_name === 'string' ? m.display_name : id })
  }
  return out
}

/** One line about a step, as a person reads it: [name, summary]. */
export function step(item: any): [string, string] | null {
  const short = (p: string): string => basename(p) || p
  switch (item?.type) {
    case 'command_execution': {
      const cmd = typeof item.command === 'string' ? item.command : ''
      // `/bin/zsh -lc '…'`: show what is inside.
      // Only the one pair of outer quotes: quotes inside the command stay.
      const unquote = (c: string): string => {
        for (const q of ["'", '"']) {
          if (c.length >= 2 && c.startsWith(q) && c.endsWith(q)) return c.slice(1, -1)
        }
        return c
      }
      const at = cmd.indexOf('-lc ')
      const inner = at >= 0 ? unquote(cmd.slice(at + 4)) : cmd
      return ['Bash', firstLine(inner)]
    }
    case 'file_change': {
      const files = (Array.isArray(item.changes) ? item.changes : [])
        .map((c: any) => c?.path)
        .filter((p: unknown): p is string => typeof p === 'string')
        .map(short)
      return ['Edit', `Changed ${files.join(', ')}`]
    }
    case 'web_search':
      return ['WebSearch', `Searched the web for ${typeof item.query === 'string' ? item.query : ''}`]
    case 'mcp_tool_call':
      return ['Tool', `${typeof item.server === 'string' ? item.server : ''} ${typeof item.tool === 'string' ? item.tool : ''}`]
    case 'todo_list':
      return ['TodoWrite', 'Updated its plan']
    default:
      return null
  }
}

/** What one run remembers between lines. */
export interface RunState {
  /** When the run began (ms). */
  started: number
  failed: boolean
  /** The steps already announced (item.started), so a step Codex only
   *  reports once it is done (a file change, a web search) still shows. */
  shown: Set<string>
}

export const newRun = (): RunState => ({ started: Date.now(), failed: false, shown: new Set() })

/** One stdout line of `codex exec --json`, as chat events. */
export function parse(line: string, st: RunState): AgentEvent[] {
  let v: any
  try {
    v = JSON.parse(line)
  } catch {
    return []
  }
  if (!v || typeof v !== 'object') return []
  const out: AgentEvent[] = []
  const elapsed = (): number => Date.now() - st.started
  const id = (item: any): string => (typeof item?.id === 'string' ? item.id : '')
  switch (v.type) {
    case 'thread.started':
      if (typeof v.thread_id === 'string') out.push({ type: 'session', id: v.thread_id })
      break
    case 'item.started': {
      const s = step(v.item)
      if (s) {
        st.shown.add(id(v.item))
        out.push({ type: 'tool', id: id(v.item), name: s[0], summary: s[1], agent: false })
      }
      break
    }
    case 'item.completed': {
      const item = v.item
      if (item?.type === 'agent_message') {
        const text = (typeof item.text === 'string' ? item.text : '').trim()
        if (text) out.push({ type: 'text', text, agent: false })
      } else if (typeof item?.type === 'string') {
        const s = step(item)
        if (!s) break
        const i = id(item)
        if (!st.shown.delete(i)) out.push({ type: 'tool', id: i, name: s[0], summary: s[1], agent: false })
        const error = (Number.isInteger(item.exit_code) && item.exit_code !== 0) || item.status === 'failed'
        out.push({ type: 'tool_done', id: i, error })
      }
      break
    }
    case 'turn.completed':
      // Codex reports tokens, not dollars.
      out.push({ type: 'result', cost_usd: 0, duration_ms: elapsed(), turns: 1, error: false })
      break
    case 'turn.failed':
    case 'error': {
      st.failed = true
      const msg = typeof v.error?.message === 'string' ? v.error.message : typeof v.message === 'string' ? v.message : 'Codex stopped with an error'
      out.push({ type: 'stderr', line: `error: ${msg}` })
      out.push({ type: 'result', cost_usd: 0, duration_ms: elapsed(), turns: 1, error: true })
      break
    }
  }
  return out
}

export interface CodexOptions {
  dir: string
  thread: string | null
  text: string
  model: string | null
  instructions: string
}

/** The command line for one message (exactly codex.rs's). */
export function codexArgs(o: CodexOptions, host: Host | null): string[] {
  const args = ['exec']
  if (o.thread) args.push('resume', o.thread)
  // The sandbox as config values, not -s/--add-dir: `exec resume` takes
  // only -c (newer Codex rejects the flags there, and every follow-up died).
  args.push('--json', '--skip-git-repo-check', '-c', 'sandbox_mode="workspace-write"', '-c', 'sandbox_workspace_write.network_access=true')
  // The same video-making instructions Claude Code gets (as a TOML string).
  args.push('-c', `developer_instructions=${JSON.stringify(o.instructions)}`)
  // The shared library is writable too (TOML array; a JSON string is valid TOML).
  args.push('-c', `sandbox_workspace_write.writable_roots=[${JSON.stringify(host ? `${host.root.replace(/\/+$/, '')}/Library` : libraryDir())}]`)
  if (o.model) args.push('-m', o.model)
  args.push(o.text)
  return args
}

/** A stderr line as a person reads it: Codex's own timestamped log lines
 *  (`2026-…Z ERROR codex_core::…: what`) lose their prefix; blank is none. */
export function reason(line: string): string | null {
  const l = line.trim()
  if (!l) return null
  const m = /^\d{4}-\d\d-\d\dT\S+\s+(?:ERROR|WARN|INFO|DEBUG|TRACE)\s+\S+:\s*(.*)$/.exec(l)
  return (m ? m[1] : l).trim() || null
}

export class CodexRun {
  private child: ChildProcess | null = null
  /** On a remote host: the host and the program's pid there (to stop it). */
  private remotePid: { host: Host; pid: number } | null = null

  running(): boolean {
    const c = this.child
    return !!c && c.exitCode === null && c.signalCode === null
  }

  /** One message: a `codex exec` (resuming `thread` when there is one).
   *  Throws when it cannot be started. */
  send(o: CodexOptions, out: (e: AgentEvent) => void): void {
    const where = remote.hostOf(o.dir)
    const args = codexArgs(o, where?.host ?? null)
    const child = where
      ? (() => {
          const r = remote.remoteCommand(where.host, remote.remoteDir(where.host, where.name), 'codex', args)
          return spawn(r.cmd, r.args, { env: toolEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
        })()
      : spawn(codexBin(), args, { cwd: o.dir, env: toolEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
    child.on('error', () => {})
    if (child.pid === undefined) throw new Error(`could not run ${where ? 'ssh' : codexBin()}`)
    this.child = child
    this.remotePid = null
    const st = newRun()
    let ended = false
    const lines = createInterface({ input: child.stdout! })
    lines.on('line', (line) => {
      if (where) {
        const pid = remote.pidLine(line)
        if (pid != null) {
          this.remotePid = { host: where.host, pid }
          return
        }
      }
      if (line.includes('"turn.completed"') || line.includes('"turn.failed"')) ended = true
      for (const e of parse(line, st)) out(e)
    })
    // Codex logs to stderr as it works (skills it skipped, history it
    // repaired): kept out of the chat. Only when a run fails is its last
    // real complaint shown, as the reason.
    const said: string[] = []
    createInterface({ input: child.stderr! }).on('line', (line) => {
      const l = reason(line)
      if (l) said.push(l)
      if (said.length > 20) said.shift()
    })
    lines.on('close', () => {
      if (!ended) out({ type: 'exited', reason: said.at(-1) })
    })
  }

  stop(): void {
    if (this.remotePid) {
      remote.kill(this.remotePid.host, this.remotePid.pid)
      this.remotePid = null
    }
    if (this.child) {
      this.child.kill('SIGKILL')
      this.child = null
    }
  }
}
