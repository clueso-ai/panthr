// OpenCode as the one making the video: one `opencode run --format json` per
// message, resuming the chat's session, with the same instructions Claude
// Code and Codex get (as the prompt of an agent of its own, "panther",
// passed in OPENCODE_CONFIG_CONTENT). Its events are mapped onto the chat's
// own (AgentEvent), so the chat shows it as it shows the others.
//
// --standalone: a private OpenCode server for the run, a child of it, so
// the tools it runs get our environment (the `panthr` command on PATH) and
// stopping the run stops them too. A run reports no end of its own: its
// process ending is the end of the turn.

import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { createInterface } from 'node:readline'
import type { AgentEvent, Host, Model } from '@shared/types'
import { toolEnv, home } from '../paths'
import * as remote from '../remote'
import { firstLine } from './claude'

/** The `opencode` binary: the user's own, where its installer puts it. */
export function opencodeBin(): string {
  const h = home()
  for (const p of [join(h, '.opencode/bin/opencode'), join(h, '.local/bin/opencode'), '/opt/homebrew/bin/opencode', '/usr/local/bin/opencode']) {
    if (existsSync(p)) return p
  }
  return 'opencode'
}

/** `opencode models` as models: one provider/model a line. */
export function parseModels(text: string): Model[] {
  return text.split('\n').map((l) => l.trim()).filter((l) => /^[\w.-]+\/\S+$/.test(l)).map((id) => ({ id, name: id }))
}

/** The models OpenCode last used (its own record), newest first. */
export function recentModels(): string[] {
  try {
    const v = JSON.parse(readFileSync(join(home(), '.local/state/opencode/model.json'), 'utf8'))
    return (Array.isArray(v?.recent) ? v.recent : [])
      .filter((m: any) => typeof m?.providerID === 'string' && typeof m?.modelID === 'string')
      .map((m: any) => `${m.providerID}/${m.modelID}`)
  } catch {
    return []
  }
}

let listed: { at: number; models: Model[] } | null = null

/** The models OpenCode offers (the ones it was used with lately first).
 *  Asked of `opencode models` at most once a minute. */
export async function models(): Promise<Model[]> {
  if (!listed || Date.now() - listed.at > 60_000) {
    const text = await new Promise<string>((ok) =>
      execFile(opencodeBin(), ['models', '--standalone'], { env: toolEnv(), timeout: 20_000 }, (_e, stdout) => ok(stdout ?? ''))
    )
    const found = parseModels(text)
    // Nothing back (not installed, not signed in): ask again next time.
    if (!found.length) return []
    listed = { at: Date.now(), models: found }
  }
  const all = listed.models
  const recent = recentModels().filter((id) => all.some((m) => m.id === id))
  return [...recent.map((id) => ({ id, name: id })), ...all.filter((m) => !recent.includes(m.id))]
}

/** One line about a tool call, as a person reads it: [name, summary], in
 *  Claude Code's names (so the chat shows its steps the same way). */
export function step(tool: string, input: any): [string, string] {
  const o = input && typeof input === 'object' ? input : {}
  const s = (k: string): string => (typeof o[k] === 'string' ? o[k] : '')
  const path = (): string => {
    const p = s('path') || s('filePath') || s('file_path')
    return basename(p) || p
  }
  switch (tool) {
    case 'shell':
    case 'bash':
      return ['Bash', firstLine(s('description') || s('command'))]
    case 'read':
      return ['Read', firstLine(`Read ${path()}`)]
    case 'write':
      return ['Write', firstLine(`Wrote ${path()}`)]
    case 'edit':
    case 'multiedit':
      return ['Edit', firstLine(`Edited ${path()}`)]
    case 'patch':
    case 'apply_patch':
      return ['Edit', 'Changed files']
    case 'glob':
    case 'grep':
      return [tool === 'glob' ? 'Glob' : 'Grep', firstLine(`Searched ${s('pattern')}`)]
    case 'list':
    case 'ls':
      return ['Glob', firstLine(`Listed ${path() || 'the folder'}`)]
    case 'webfetch':
      return ['WebFetch', firstLine(`Read ${s('url')}`)]
    case 'websearch':
      return ['WebSearch', firstLine(`Searched the web for ${s('query')}`)]
    case 'task':
      return ['Task', firstLine(`Agent: ${s('description')}`)]
    case 'todowrite':
    case 'todoread':
      return ['TodoWrite', 'Updated its plan']
    case 'skill':
      return ['Skill', firstLine(`Skill: ${s('name')}`)]
    default:
      return ['Tool', firstLine(tool)]
  }
}

/** What one run remembers between lines. */
export interface RunState {
  /** When the run began (ms). */
  started: number
  failed: boolean
  /** The session, once announced. */
  session: string | null
  /** What OpenCode said went wrong (its error event), for the end. */
  error: string | null
  /** Added up over its steps: API dollars (none on a subscription) and tokens. */
  cost: number
  tokens: number
}

export const newRun = (): RunState => ({ started: Date.now(), failed: false, session: null, error: null, cost: 0, tokens: 0 })

const num = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0)

/** One stdout line of `opencode run --format json`, as chat events. */
export function parse(line: string, st: RunState): AgentEvent[] {
  let v: any
  try {
    v = JSON.parse(line)
  } catch {
    return []
  }
  if (!v || typeof v !== 'object') return []
  const out: AgentEvent[] = []
  // Every event names its session: the first one is the chat's.
  if (st.session == null && typeof v.sessionID === 'string') {
    st.session = v.sessionID
    out.push({ type: 'session', id: v.sessionID })
  }
  const part = v.part ?? {}
  switch (v.type) {
    case 'text': {
      const text = (typeof part.text === 'string' ? part.text : '').trim()
      if (text) out.push({ type: 'text', text, agent: false })
      break
    }
    case 'tool_use': {
      // Reported once it is over (done or failed): shown and finished at once.
      const state = part.state ?? {}
      if (state.status !== 'completed' && state.status !== 'error') break
      const id = typeof part.id === 'string' ? part.id : typeof part.partID === 'string' ? part.partID : ''
      const [name, summary] = step(typeof part.tool === 'string' ? part.tool : '', state.input)
      const exit = state.metadata?.metadata?.exit ?? state.metadata?.exit
      const error = state.status === 'error' || (Number.isInteger(exit) && exit !== 0)
      out.push({ type: 'tool', id, name, summary, agent: false })
      out.push({ type: 'tool_done', id, error })
      break
    }
    case 'step_finish': {
      const t = part.tokens ?? {}
      st.cost += num(part.cost)
      st.tokens += num(t.input) + num(t.output) + num(t.reasoning) + num(t.cache?.read) + num(t.cache?.write)
      break
    }
    case 'error': {
      st.failed = true
      const e = v.error ?? {}
      st.error = typeof e.message === 'string' ? e.message : typeof e.data?.message === 'string' ? e.data.message : typeof e.name === 'string' ? e.name : 'OpenCode stopped with an error'
      out.push({ type: 'stderr', line: `error: ${st.error}` })
      break
    }
  }
  return out
}

/** How the turn ended, once the process has: its cost and tokens, or why
 *  it stopped (`reason`: its last words on stderr). */
export function finish(st: RunState, code: number | null, reason?: string): AgentEvent[] {
  const result = (error: boolean): AgentEvent => ({
    type: 'result', cost_usd: st.cost, duration_ms: Date.now() - st.started, turns: 1, error, ...(st.tokens ? { tokens: st.tokens } : {})
  })
  if (st.failed) return [result(true)]
  if (code === 0) return [result(false)]
  return [{ type: 'exited', reason }]
}

export interface OpencodeOptions {
  dir: string
  session: string | null
  text: string
  model: string | null
  instructions: string
  env?: NodeJS.ProcessEnv
}

/** The agent Panther's chats run as: OpenCode's own, with the video-making
 *  instructions as its prompt. */
export const AGENT = 'panther'

/** The configuration added to the user's own for a run (OPENCODE_CONFIG_CONTENT). */
export function opencodeConfig(instructions: string): string {
  return JSON.stringify({ agent: { [AGENT]: { mode: 'primary', description: 'Makes videos in Panther', prompt: instructions } } })
}

/** The command line for one message. */
export function opencodeArgs(o: OpencodeOptions): string[] {
  // --auto: its asks for permission are answered yes (as Claude Code's acceptEdits,
  // and the shared library outside the project too).
  const args = ['run', '--standalone', '--format', 'json', '--auto', '--agent', AGENT]
  if (o.session) args.push('--session', o.session)
  if (o.model) args.push('--model', o.model)
  // The message after --, so one that starts with a dash is not read as a flag.
  args.push('--', o.text)
  return args
}

export class OpencodeRun {
  private child: ChildProcess | null = null
  /** On a remote host: the host and the program's pid there (to stop it). */
  private remotePid: { host: Host; pid: number } | null = null

  running(): boolean {
    const c = this.child
    return !!c && c.exitCode === null && c.signalCode === null
  }

  /** One message: an `opencode run` (resuming `session` when there is one).
   *  Throws when it cannot be started. */
  send(o: OpencodeOptions, out: (e: AgentEvent) => void): void {
    const where = remote.hostOf(o.dir)
    const args = opencodeArgs(o)
    const config = opencodeConfig(o.instructions)
    const child = where
      ? (() => {
          // There, the configuration goes in through env (ssh passes no environment).
          const r = remote.remoteCommand(where.host, remote.remoteDir(where.host, where.name), 'env', [`OPENCODE_CONFIG_CONTENT=${config}`, 'opencode', ...args])
          return spawn(r.cmd, r.args, { env: toolEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
        })()
      : spawn(opencodeBin(), args, { cwd: o.dir, env: { ...(o.env ?? toolEnv()), OPENCODE_CONFIG_CONTENT: config }, stdio: ['ignore', 'pipe', 'pipe'] })
    child.on('error', () => {})
    if (child.pid === undefined) throw new Error(`could not run ${where ? 'ssh' : opencodeBin()}`)
    this.child = child
    this.remotePid = null
    const st = newRun()
    createInterface({ input: child.stdout! }).on('line', (line) => {
      if (where) {
        const pid = remote.pidLine(line)
        if (pid != null) {
          this.remotePid = { host: where.host, pid }
          return
        }
      }
      for (const e of parse(line, st)) out(e)
    })
    // Its logs stay out of the chat; when a run fails, its last line is the reason.
    const said: string[] = []
    createInterface({ input: child.stderr! }).on('line', (line) => {
      const l = line.trim()
      if (l) said.push(l)
      if (said.length > 20) said.shift()
    })
    child.on('close', (code) => {
      for (const e of finish(st, code, said.at(-1))) out(e)
    })
  }

  stop(): void {
    if (this.remotePid) {
      remote.kill(this.remotePid.host, this.remotePid.pid)
      this.remotePid = null
    }
    if (this.child) {
      // Its private server is its child, and goes with it.
      this.child.kill('SIGKILL')
      this.child = null
    }
  }
}
