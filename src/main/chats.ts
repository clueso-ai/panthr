// A chat with an agent on one project: its transcript, saved under
// .studio/chats/<id>.json, and its agent process (Claude Code: one per chat,
// kept alive; Codex and OpenCode: one per message). Main owns both; the
// window gets ChatState through 'chat:state'. Port of the non-UI half of
// studio-mac/src/chat.rs, with studio.rs's on_chat (session, title and
// engine into project.json).

import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { Api } from '@shared/api'
import { engineName, engineShort, modelKey, type AgentEvent, type ChatMeta, type ChatState, type Engine, type Item, type Model, type Step } from '@shared/types'
import { emit } from './bus'
import { readJson } from './json'
import { getSettings } from './settings'
import { chatPath, loadMeta, newChat, updateMeta } from './projects'
import * as remote from './remote'
import { ClaudeChat, promptText } from './agents/claude'
import { expandMentions } from './references'
import { CodexRun, models as codexModels } from './agents/codex'
import { OpencodeRun, models as opencodeModels } from './agents/opencode'
import { suggestName } from './namer'
import { isCanvas } from './board'
import { checkpoints, record, snap, tracked } from './history'
import { checkMessage, checkVideo } from './selfcheck'
import { assistantDir } from './paths'
import { accountFor, atLimit, claudeEnv, codexEnv, codexUsage, moveSession, nextAccount, noteUsage, opencodeEnv } from './accounts'

/** The instructions for a chat in this folder: the assistant's, a project's or a video's. */
const kindOf = (dir: string): boolean | 'assistant' => (resolve(dir) === resolve(assistantDir()) ? 'assistant' : isCanvas(dir))

/** Called when a chat's turn is over and nothing else follows it (no self-check fix, no queued message). */
export const onSettled: ((dir: string, chatId: string) => void)[] = []

/** A chat's title until its first message names it. */
export const NEW_CHAT = 'New chat'

/** What an event did, for the one who keeps the transcript. */
export interface Applied {
  /** A new session id to keep for resuming. */
  session?: string
  /** A turn ended (the project's files may have changed). */
  turnEnded?: boolean
  /** Only streamed text grew: show it, no need to save. */
  streamed?: boolean
  /** Nothing changed (a subagent's words). */
  none?: boolean
}

/** The transcript as shown, built from the agent's events (chat.rs on_event). */
export class Transcript {
  items: Item[]
  working = false
  startedAt: number | null = null
  /** The reply being written right now (an index into items). */
  streaming: number | null = null
  /** Typed while the agent works: sent when the turn ends. */
  queued: string[] = []

  constructor(
    items: Item[] = [],
    public engine: Engine = 'claude',
    public sessionId: string | null = null
  ) {
    this.items = items
  }

  isEmpty(): boolean {
    return !this.items.some((i) => 'User' in i)
  }

  apply(ev: AgentEvent): Applied {
    switch (ev.type) {
      case 'session':
        if (this.sessionId === ev.id) return { none: true }
        this.sessionId = ev.id
        return { session: ev.id }
      case 'delta': {
        if (ev.agent) return { none: true }
        const cur = this.streaming != null ? this.items[this.streaming] : undefined
        if (cur && 'Text' in cur) cur.Text += ev.text
        else {
          this.items.push({ Text: ev.text })
          this.streaming = this.items.length - 1
        }
        // Many a second: no save, just show it.
        return { streamed: true }
      }
      case 'text': {
        // A sub-agent's words go with it (its Task step), for the person to read; not into the chat.
        if (ev.agent) {
          const task = ev.parent ? this.step(ev.parent) : undefined
          if (!task) return { none: true }
          task.said = ((task.said ? `${task.said}\n\n` : '') + ev.text).slice(-8000)
          return {}
        }
        // The whole block: it replaces what streamed in.
        const cur = this.streaming != null ? this.items[this.streaming] : undefined
        this.streaming = null
        if (cur && 'Text' in cur) cur.Text = ev.text
        else this.items.push({ Text: ev.text })
        return {}
      }
      case 'tool': {
        if (!ev.agent) this.streaming = null
        const step: Step = { id: ev.id, name: ev.name, summary: ev.summary, agent: ev.agent, done: false, error: false, ...(ev.parent ? { parent: ev.parent } : {}), ...(ev.brief ? { brief: ev.brief } : {}) }
        const last = this.items[this.items.length - 1]
        if (last && 'Steps' in last) last.Steps.push(step)
        else this.items.push({ Steps: [step] })
        return {}
      }
      case 'tool_done':
        for (let i = this.items.length - 1; i >= 0; i--) {
          const it = this.items[i]
          const st = 'Steps' in it ? it.Steps.find((s) => s.id === ev.id) : undefined
          if (st) {
            st.done = true
            st.error = ev.error
            break
          }
        }
        return {}
      case 'result':
        this.working = false
        this.streaming = null
        this.items.push({ Meta: { cost_usd: ev.cost_usd, seconds: ev.duration_ms / 1000, error: ev.error, at: Math.floor(Date.now() / 1000), engine: this.engine, ...(ev.tokens ? { tokens: ev.tokens } : {}) } })
        return { turnEnded: true }
      case 'stderr':
        if (ev.line.toLowerCase().includes('error')) this.items.push({ Note: ev.line })
        return {}
      case 'limits':
        return { none: true }
      case 'exited':
        if (!this.working) return {}
        this.working = false
        this.streaming = null
        this.items.push({ Note: `${engineName(this.engine)} stopped${ev.reason ? `: ${ev.reason}` : ''}` })
        return { turnEnded: true }
    }
  }

  /** A step by its id, newest first. */
  step(id: string): Step | undefined {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i]
      const st = 'Steps' in it ? it.Steps.find((s) => s.id === id) : undefined
      if (st) return st
    }
    return undefined
  }

  /** The user's message goes in; a turn begins (again: the same message once more, not shown twice). */
  begin(text: string, again = false): void {
    if (!again) this.items.push({ User: text })
    this.working = true
    this.streaming = null
    this.startedAt = Date.now()
  }
}

/** The chat's title from its first message (40 characters). */
export const titleFrom = (text: string): string => Array.from(text).slice(0, 40).join('')

/** The model for an engine: the project's pick, else Settings' (null: the agent's own default). */
export function modelFor(dir: string, engine: Engine): string | null {
  const s = getSettings()
  const m = loadMeta(dir)?.models[engine] ?? s[modelKey(engine)]
  return m && m !== 'default' ? m : null
}

/** The models offered for an agent (studio.rs models_for). OpenCode's are
 *  asked of it (see modelsOf); here, only its Default. */
export function modelsFor(engine: Engine): Model[] {
  if (engine === 'codex') return [{ id: 'default', name: 'Default' }, ...codexModels().slice(0, 6)]
  if (engine === 'opencode') return [{ id: 'default', name: 'Default' }]
  return [
    { id: 'default', name: 'Default' },
    { id: 'opus', name: 'Opus' },
    { id: 'sonnet', name: 'Sonnet' },
    { id: 'haiku', name: 'Haiku' }
  ]
}

/** The models offered for an agent, OpenCode's from `opencode models`. */
export async function modelsOf(engine: Engine): Promise<Model[]> {
  if (engine === 'opencode') return [...modelsFor(engine), ...(await opencodeModels())]
  return modelsFor(engine)
}

/** Write a transcript compactly, as Rust's serde_json::to_vec does. */
export function saveTranscript(path: string, items: Item[]): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(items))
  renameSync(tmp, path)
}

export const loadTranscript = (path: string): Item[] => {
  const v = readJson<unknown>(path, [])
  return Array.isArray(v) ? (v as Item[]) : []
}

const STATE_MS = 1000 / 30
const SAVE_MS = 300

class Chat {
  t: Transcript
  private claude = new ClaudeChat()
  private codex = new CodexRun()
  private opencode = new OpencodeRun()
  /** Bumped when a process is stopped or replaced: its late events are dropped. */
  private gen = 0
  /** Sending (a remote push before the message): what comes meanwhile queues. */
  private busy = false
  private stateTimer: NodeJS.Timeout | null = null
  private lastState = 0
  private saveTimer: NodeJS.Timeout | null = null

  /** The Claude account it runs on (null: the one new chats use). */
  private account: string | null
  /** The account hit its limit during this turn (blocked). */
  private limited = false
  /** The account went past its limit during this turn, on extra usage. */
  private overage = false

  constructor(
    readonly dir: string,
    readonly chatId: string,
    meta: ChatMeta | undefined
  ) {
    this.account = meta?.account ?? null
    const engine: Engine = meta?.engine ?? getSettings().agent
    this.t = new Transcript(loadTranscript(chatPath(dir, chatId)), engine, meta?.session_id ?? null)
  }

  state(): ChatState {
    const t = this.t
    return {
      dir: this.dir, chatId: this.chatId, items: t.items, working: t.working || this.busy,
      startedAt: t.startedAt, streaming: t.streaming, queued: [...t.queued], engine: t.engine, account: accountFor(this.account, t.engine).id, checking: this.checking
    }
  }

  /** chat:state, at most ~30 a second (now: at once). */
  show(now = false): void {
    if (this.stateTimer) {
      if (!now) return
      clearTimeout(this.stateTimer)
      this.stateTimer = null
    }
    const wait = STATE_MS - (Date.now() - this.lastState)
    if (now || wait <= 0) {
      this.lastState = Date.now()
      emit('chat:state', this.state())
      return
    }
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null
      this.lastState = Date.now()
      emit('chat:state', this.state())
    }, wait)
  }

  save(now = false): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    if (now) saveTranscript(chatPath(this.dir, this.chatId), this.t.items)
    else this.saveTimer = setTimeout(() => this.save(true), SAVE_MS)
  }

  /** Save anything waiting. */
  flush(): void {
    if (this.saveTimer) this.save(true)
  }

  private note(text: string): void {
    this.t.items.push({ Note: text })
    this.save(true)
    this.show(true)
  }

  /** Send a message (typed, or from the editor: controls, edits, comments). */
  async send(text: string, again = false): Promise<void> {
    if (text.trim() === '') return
    // One turn at a time: what is typed meanwhile waits its turn.
    if (this.t.working || this.busy) {
      this.t.queued.push(text)
      this.show(true)
      return
    }
    const where = remote.hostOf(this.dir)
    if (where) {
      // On a host: notes made here (comments, a drawing) go over first, so
      // the agent there sees them.
      this.busy = true
      this.show(true)
      try {
        await remote.push(this.dir)
      } catch (e) {
        this.t.items.push({ Note: `Could not send your notes over: ${(e as Error).message}` })
      } finally {
        this.busy = false
      }
    }
    const first = this.t.isEmpty()
    // A checkpoint of the project's files before the agent touches them, so
    // this turn can be undone. Messages typed meanwhile wait their turn.
    if (isCanvas(this.dir) && tracked(this.dir)) {
      this.busy = true
      try {
        this.pending = { turn: this.t.items.length, before: await snap(this.dir, `before: ${text.slice(0, 80)}`), label: text.split('\n')[0].slice(0, 80) }
      } finally {
        this.busy = false
      }
    }
    if (this.t.engine === 'codex') {
      try {
        this.gen++
        this.codex.send({ dir: this.dir, thread: this.t.sessionId, text: expandMentions(text), model: modelFor(this.dir, 'codex'), instructions: promptText(kindOf(this.dir)), env: codexEnv(accountFor(this.account, 'codex').id) }, this.listener())
      } catch (e) {
        this.note(`Could not start Codex: ${(e as Error).message}`)
        return this.sendQueued()
      }
    } else if (this.t.engine === 'opencode') {
      try {
        this.gen++
        this.opencode.send({ dir: this.dir, session: this.t.sessionId, text: expandMentions(text), model: modelFor(this.dir, 'opencode'), instructions: promptText(kindOf(this.dir)), env: opencodeEnv() }, this.listener())
      } catch (e) {
        this.note(`Could not start OpenCode: ${(e as Error).message}`)
        return this.sendQueued()
      }
    } else {
      const agents = loadMeta(this.dir)?.agents_enabled ?? true
      const model = modelFor(this.dir, 'claude')
      const account = accountFor(this.account, 'claude').id
      // A new model, account or Agents switch: the next turn starts a process with them.
      const s = this.claude.started
      if (this.claude.running() && s && (s.agents !== agents || s.model !== model || s.account !== account)) this.stopProcesses()
      if (!this.claude.running()) {
        try {
          this.gen++
          this.claude.start({ dir: this.dir, resume: this.t.sessionId, agents, model, board: kindOf(this.dir), account, env: claudeEnv(account) }, this.listener())
        } catch (e) {
          this.note(`Could not start Claude Code: ${(e as Error).message}`)
          return this.sendQueued()
        }
      }
      try {
        // The agent gets the @-mentioned references spelled out; the chat
        // keeps what was typed.
        this.claude.send(expandMentions(text))
      } catch (e) {
        this.note(`Could not reach Claude Code: ${(e as Error).message}`)
        return this.sendQueued()
      }
    }
    if (first && !again) {
      this.title(titleFrom(text))
      void this.nameFrom(text)
    }
    this.limited = false
    this.overage = false
    this.t.begin(text, again)
    this.save(true)
    this.show(true)
  }

  /** Events from the process started now (later ones from a stopped process are dropped). */
  private listener(): (e: AgentEvent) => void {
    const gen = this.gen
    return (e) => {
      if (gen === this.gen) this.onEvent(e)
    }
  }

  onEvent(ev: AgentEvent): void {
    // How much of the account is used; at its limit, the turn may go on elsewhere.
    if (ev.type === 'limits') {
      noteUsage(accountFor(this.account, this.t.engine).id, ev.usage)
      // Blocked: the turn fails, so it goes again elsewhere. On extra usage
      // it goes on; the next turns move to a free account, if there is one.
      if (ev.usage.status === 'rejected') {
        if (ev.usage.overage) this.overage = true
        else this.limited = true
      }
      return
    }
    const r = this.t.apply(ev)
    if (r.none) return
    if (r.session) {
      const id = r.session
      updateMeta(this.dir, (m) => {
        const c = m.chats.find((c) => c.id === this.chatId)
        if (c) c.session_id = id
      })
      emit('chat:session', { dir: this.dir, chatId: this.chatId, sessionId: id })
      return
    }
    if (r.streamed) return this.show()
    if (r.turnEnded) {
      // Which account the turn ran on, for the usage view.
      const last = this.t.items[this.t.items.length - 1]
      if (last && 'Meta' in last) last.Meta.account = accountFor(this.account, this.t.engine).id
      this.save(true)
      this.show(true)
      const changes = this.turnEnded()
      // Codex says how much is used in its session file: read once the run is over.
      if (this.t.engine === 'codex' && this.t.sessionId) {
        const id = accountFor(this.account, 'codex').id
        const u = codexUsage(id, this.t.sessionId)
        if (u) {
          noteUsage(id, u)
          if (u.status === 'rejected') this.limited = true
        }
      }
      if (this.limited) void this.carryOn()
      else {
        if (this.overage) void this.moveOffOverage()
        void this.afterTurn(changes)
      }
      return
    }
    this.save()
    this.show()
  }

  /** The turn's starting checkpoint, until it ends. */
  private pending: { turn: number; before: string | null; label: string } | null = null

  /** The turn's closing checkpoint, and the files it changed (null: not known). */
  private async checkpoint(): Promise<string[] | null> {
    const p = this.pending
    this.pending = null
    if (!p?.before) return null
    const after = await snap(this.dir, `after: ${p.label}`)
    if (!after) return null
    await record(this.dir, { chatId: this.chatId, turn: p.turn, label: p.label, before: p.before, after })
    return checkpoints(this.dir).find((c) => c.chatId === this.chatId && c.turn === p.turn)?.files ?? []
  }

  /** Videos being self-checked now (their names), shown under the chat. */
  private checking: string | null = null
  /** This turn was the self-check's follow-up (one round only). */
  private checkRound = 0

  /** After a turn: check the videos it changed; what is wrong goes back to the agent, once. */
  private async afterTurn(changes: Promise<string[] | null>): Promise<void> {
    const round = this.checkRound
    this.checkRound = 0
    const files = await changes
    const last = this.t.items[this.t.items.length - 1]
    const failed = !last || ('Meta' in last && last.Meta.error) || ('Note' in last && /stopped/i.test(last.Note))
    // Not when off, after a failed turn, when the person has already said what is next, or when nothing changed.
    if (!getSettings().self_check || failed || this.t.queued.length || !files?.length || this.t.working) return this.settle()
    const videos = [...new Set(files.map((f) => f.split('/')[0]))]
      .map((seg) => (existsSync(join(this.dir, seg, 'index.html')) ? join(this.dir, seg) : null))
      .filter((d): d is string => !!d)
    if (!videos.length && files.some((f) => !f.includes('/')) && existsSync(join(this.dir, 'index.html'))) videos.push(this.dir)
    if (!videos.length) return this.settle()
    const mark = this.t.items.length
    this.checking = videos.map((v) => loadMeta(v)?.name ?? v.split('/').pop()).join(', ')
    this.show(true)
    let checks
    try {
      checks = await Promise.all(videos.slice(0, 4).map((v) => checkVideo(v)))
    } catch (e) {
      checks = null
      console.error('self-check:', (e as Error).message)
    }
    this.checking = null
    this.show(true)
    // The person moved on meanwhile: their word wins.
    if (!checks || this.t.working || this.t.items.length !== mark || this.t.queued.length) return this.settle()
    const problems = checks.reduce((n, c) => n + c.problems.length, 0)
    if (!problems) {
      this.note(`Self-check: no problems found in ${checks.map((c) => c.name).join(', ')}`)
      return this.settle()
    }
    if (round >= 1) {
      this.note(`Self-check still sees ${problems} problem${problems === 1 ? '' : 's'}: ${checks.flatMap((c) => c.problems).slice(0, 3).join('; ')}`)
      return this.settle()
    }
    this.checkRound = 1
    await this.send(checkMessage(checks))
  }

  /** The next queued message; or, with none, the turn is over for good. */
  private settle(): void {
    this.sendQueued()
    if (!this.t.working && !this.busy && !this.t.queued.length) for (const f of onSettled) f(this.dir, this.chatId)
  }

  private turnEnded(): Promise<string[] | null> {
    const changes = this.checkpoint()
    emit('chat:turn', { dir: this.dir, chatId: this.chatId })
    // On a host: the agent's notes there (controls, comments) come back.
    if (remote.hostOf(this.dir)) void pullKeeping(this.dir)
    return changes
  }

  /** The account hit its limit: the same message again on the next account
   *  (signed in, not at its own limit), its conversation brought along. */
  private async carryOn(): Promise<void> {
    this.limited = false
    const engine = this.t.engine
    const from = accountFor(this.account, engine)
    const last = [...this.t.items].reverse().find((i): i is { User: string } => 'User' in i)
    const next = getSettings().claude_failover ? await nextAccount(engine, from.id) : null
    if (!next || !last) {
      if (atLimit(from.id)) this.note(`${from.label === 'Default' ? `Your ${engineShort(engine)} account` : from.label} has reached its usage limit.`)
      return this.sendQueued()
    }
    this.useAccount(next.id)
    this.note(`${from.label} reached its usage limit. Carrying on with ${next.label}.`)
    await this.send(last.User, true)
  }

  /** Past its limit but carrying on on extra usage: the next turns go to a free account instead. */
  private async moveOffOverage(): Promise<void> {
    this.overage = false
    if (!getSettings().claude_failover) return
    const engine = this.t.engine
    const from = accountFor(this.account, engine)
    const next = await nextAccount(engine, from.id)
    if (!next || this.t.working) return
    this.useAccount(next.id)
    this.note(`${from.label} is past its usage limit and was using extra usage. Next messages go to ${next.label}.`)
  }

  /** Run on another account from the next turn on (the conversation goes along). */
  useAccount(id: string): void {
    const engine = this.t.engine
    const from = accountFor(this.account, engine).id
    const to = accountFor(id, engine).id
    if (from === to && this.account) return
    this.stopProcesses()
    if (this.t.sessionId && from !== to && !moveSession(engine, this.t.sessionId, from, to)) {
      // Its conversation could not be found to bring along: a fresh one there.
      this.t.sessionId = null
    }
    this.account = to
    updateMeta(this.dir, (m) => {
      const c = m.chats.find((c) => c.id === this.chatId)
      if (c) {
        c.account = to
        c.session_id = this.t.sessionId
      }
    })
    this.show(true)
  }

  /** The next queued message, once a turn has ended. */
  private sendQueued(): void {
    if (!this.t.working && !this.busy && this.t.queued.length) {
      const next = this.t.queued.shift()!
      void this.send(next)
    }
  }

  /** Ask the agent's cheap model for a name; it replaces the chat's stand-in
   *  title, and the project's while that is still its stand-in too. */
  private async nameFrom(text: string): Promise<void> {
    const name = await suggestName(text, this.t.engine)
    if (!name) return
    const stand = titleFrom(text)
    let chat = false
    let project = false
    updateMeta(this.dir, (m) => {
      const c = m.chats.find((c) => c.id === this.chatId)
      if (c && c.title === stand) {
        c.title = name
        chat = true
      }
      if (m.auto_name) {
        m.name = name
        delete m.auto_name
        project = true
      }
    })
    if (chat) emit('chat:titled', { dir: this.dir, chatId: this.chatId, title: name })
    if (project) emit('project:renamed', { dir: this.dir, name })
  }

  /** Name the chat after its first message (only while it has no name). */
  private title(title: string): void {
    let named = false
    updateMeta(this.dir, (m) => {
      const c = m.chats.find((c) => c.id === this.chatId)
      if (c && c.title === NEW_CHAT) {
        c.title = title
        named = true
      }
    })
    if (named) emit('chat:titled', { dir: this.dir, chatId: this.chatId, title })
  }

  private stopProcesses(): void {
    this.gen++
    this.claude.stop()
    this.codex.stop()
    this.opencode.stop()
  }

  stop(): void {
    this.stopProcesses()
    if (this.t.working) {
      this.t.working = false
      this.t.streaming = null
      this.t.items.push({ Note: 'Stopped' })
      this.save(true)
      void this.checkpoint()
      emit('chat:turn', { dir: this.dir, chatId: this.chatId })
    }
    this.show(true)
  }

  /** Switch agent, only while the chat has no messages yet. */
  setEngine(engine: Engine): void {
    if (!this.t.isEmpty() || this.t.engine === engine) return
    this.stopProcesses()
    this.t.engine = engine
    // Accounts are an agent's own: the new agent's default.
    this.account = null
    this.t.sessionId = null
    updateMeta(this.dir, (m) => {
      const c = m.chats.find((c) => c.id === this.chatId)
      if (c) {
        c.engine = engine
        c.session_id = null
        delete c.account
      }
    })
    this.show(true)
  }

  addNote(text: string): void {
    this.note(text)
  }

  close(): void {
    this.stopProcesses()
    this.flush()
    if (this.stateTimer) clearTimeout(this.stateTimer)
    this.stateTimer = null
  }
}

// ── All chats ─────────────────────────────────────────────────────

const live = new Map<string, Chat>()
const key = (dir: string, chatId: string): string => `${resolve(dir)}\n${chatId}`

/** Bring a host project's .studio over, keeping what main wrote here (the
 *  chats in project.json and the open transcripts): the host's copies may be
 *  older than ours. */
async function pullKeeping(dir: string): Promise<void> {
  const before = loadMeta(dir)
  try {
    await remote.pull(dir)
  } catch {
    return
  }
  if (before) {
    updateMeta(dir, (m) => {
      const ours = new Set(before.chats.map((c) => c.id))
      m.chats = [...before.chats, ...m.chats.filter((c) => !ours.has(c.id))]
    })
  }
  for (const c of live.values()) if (resolve(c.dir) === resolve(dir)) c.save(true)
  emit('project:changed', { dir, files: ['.studio'] })
}

async function open(dir: string, chatId: string): Promise<Chat> {
  const k = key(dir, chatId)
  let c = live.get(k)
  if (c) return c
  // On a host: its notes come over first.
  if (remote.hostOf(dir)) await pullKeeping(dir)
  c = live.get(k)
  if (c) return c
  const meta = loadMeta(dir)?.chats.find((m) => m.id === chatId)
  c = new Chat(dir, chatId, meta)
  live.set(k, c)
  return c
}

export async function anyWorking(): Promise<boolean> {
  for (const c of live.values()) if (c.t.working) return true
  return false
}

/** Quitting: every agent stops; transcripts keep everything so far. */
export function stopAll(): void {
  for (const c of live.values()) {
    if (c.t.working) c.stop()
    c.close()
  }
}

export const chats: Api['chats'] = {
  async open(dir, chatId) {
    return (await open(dir, chatId)).state()
  },
  async create(dir, engine) {
    const c = newChat(dir, NEW_CHAT, engine ?? null)
    if (!c) throw new Error(`Not a project: ${dir}`)
    return c.id
  },
  async send(dir, chatId, text) {
    await (await open(dir, chatId)).send(text)
  },
  async stop(dir, chatId) {
    live.get(key(dir, chatId))?.stop()
  },
  async setEngine(dir, chatId, engine) {
    ;(await open(dir, chatId)).setEngine(engine)
  },
  async note(dir, chatId, text) {
    ;(await open(dir, chatId)).addNote(text)
  },
  async setAccount(dir, chatId, account) {
    const c = await open(dir, chatId)
    if (c.t.working) throw new Error('Wait for this turn to finish')
    c.useAccount(account)
  },
  async remove(dir, chatId) {
    const k = key(dir, chatId)
    const c = live.get(k)
    if (c) {
      c.stop()
      c.close()
      live.delete(k)
    }
    updateMeta(dir, (m) => {
      m.chats = m.chats.filter((x) => x.id !== chatId)
    })
    // Only the transcript Panther wrote.
    rmSync(chatPath(dir, chatId), { force: true })
  },
  async anyWorking() {
    return anyWorking()
  },
  async models(engine) {
    return modelsOf(engine)
  }
}

export const _test = { live, open }
