// A chat with an agent on one project: its transcript, saved under
// .studio/chats/<id>.json, and its agent process (Claude Code: one per chat,
// kept alive; Codex: one per message). Main owns both; the window gets
// ChatState through 'chat:state'. Port of the non-UI half of
// studio-mac/src/chat.rs, with studio.rs's on_chat (session, title and
// engine into project.json).

import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { Api } from '@shared/api'
import type { AgentEvent, ChatMeta, ChatState, Engine, Item, Model, Step } from '@shared/types'
import { emit } from './bus'
import { readJson } from './json'
import { getSettings } from './settings'
import { chatPath, loadMeta, newChat, updateMeta } from './projects'
import * as remote from './remote'
import { ClaudeChat, promptText } from './agents/claude'
import { expandMentions } from './references'
import { CodexRun, models as codexModels } from './agents/codex'

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
        if (ev.agent) return { none: true } // an agent's own words stay in its steps
        // The whole block: it replaces what streamed in.
        const cur = this.streaming != null ? this.items[this.streaming] : undefined
        this.streaming = null
        if (cur && 'Text' in cur) cur.Text = ev.text
        else this.items.push({ Text: ev.text })
        return {}
      }
      case 'tool': {
        if (!ev.agent) this.streaming = null
        const step: Step = { id: ev.id, name: ev.name, summary: ev.summary, agent: ev.agent, done: false, error: false }
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
        this.items.push({ Meta: { cost_usd: ev.cost_usd, seconds: ev.duration_ms / 1000, error: ev.error } })
        return { turnEnded: true }
      case 'stderr':
        if (ev.line.toLowerCase().includes('error')) this.items.push({ Note: ev.line })
        return {}
      case 'exited':
        if (!this.working) return {}
        this.working = false
        this.streaming = null
        this.items.push({ Note: `${this.engine === 'codex' ? 'Codex' : 'Claude Code'} stopped${ev.reason ? `: ${ev.reason}` : ''}` })
        return { turnEnded: true }
    }
  }

  /** The user's message goes in; a turn begins. */
  begin(text: string): void {
    this.items.push({ User: text })
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
  const m = loadMeta(dir)?.models[engine] ?? (engine === 'codex' ? s.codex_model : s.model)
  return m && m !== 'default' ? m : null
}

/** The models offered for an agent (studio.rs models_for). */
export function modelsFor(engine: Engine): Model[] {
  if (engine === 'codex') return [{ id: 'default', name: 'Default' }, ...codexModels().slice(0, 6)]
  return [
    { id: 'default', name: 'Default' },
    { id: 'opus', name: 'Opus' },
    { id: 'sonnet', name: 'Sonnet' },
    { id: 'haiku', name: 'Haiku' }
  ]
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
  /** Bumped when a process is stopped or replaced: its late events are dropped. */
  private gen = 0
  /** Sending (a remote push before the message): what comes meanwhile queues. */
  private busy = false
  private stateTimer: NodeJS.Timeout | null = null
  private lastState = 0
  private saveTimer: NodeJS.Timeout | null = null

  constructor(
    readonly dir: string,
    readonly chatId: string,
    meta: ChatMeta | undefined
  ) {
    const engine: Engine = meta?.engine ?? getSettings().agent
    this.t = new Transcript(loadTranscript(chatPath(dir, chatId)), engine, meta?.session_id ?? null)
  }

  state(): ChatState {
    const t = this.t
    return {
      dir: this.dir, chatId: this.chatId, items: t.items, working: t.working || this.busy,
      startedAt: t.startedAt, streaming: t.streaming, queued: [...t.queued], engine: t.engine
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
  async send(text: string): Promise<void> {
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
    if (this.t.engine === 'codex') {
      try {
        this.gen++
        this.codex.send({ dir: this.dir, thread: this.t.sessionId, text: expandMentions(text), model: modelFor(this.dir, 'codex'), instructions: promptText() }, this.listener())
      } catch (e) {
        this.note(`Could not start Codex: ${(e as Error).message}`)
        return this.sendQueued()
      }
    } else {
      const agents = loadMeta(this.dir)?.agents_enabled ?? true
      const model = modelFor(this.dir, 'claude')
      // A new model or Agents switch: the next turn starts a process with them.
      const s = this.claude.started
      if (this.claude.running() && s && (s.agents !== agents || s.model !== model)) this.stopProcesses()
      if (!this.claude.running()) {
        try {
          this.gen++
          this.claude.start({ dir: this.dir, resume: this.t.sessionId, agents, model }, this.listener())
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
    if (first) this.title(titleFrom(text))
    this.t.begin(text)
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
      this.save(true)
      this.show(true)
      this.turnEnded()
      this.sendQueued()
      return
    }
    this.save()
    this.show()
  }

  private turnEnded(): void {
    emit('chat:turn', { dir: this.dir, chatId: this.chatId })
    // On a host: the agent's notes there (controls, comments) come back.
    if (remote.hostOf(this.dir)) void pullKeeping(this.dir)
  }

  /** The next queued message, once a turn has ended. */
  private sendQueued(): void {
    if (!this.t.working && !this.busy && this.t.queued.length) {
      const next = this.t.queued.shift()!
      void this.send(next)
    }
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
  }

  stop(): void {
    this.stopProcesses()
    if (this.t.working) {
      this.t.working = false
      this.t.streaming = null
      this.t.items.push({ Note: 'Stopped' })
      this.save(true)
      emit('chat:turn', { dir: this.dir, chatId: this.chatId })
    }
    this.show(true)
  }

  /** Switch agent, only while the chat has no messages yet. */
  setEngine(engine: Engine): void {
    if (!this.t.isEmpty() || this.t.engine === engine) return
    this.stopProcesses()
    this.t.engine = engine
    this.t.sessionId = null
    updateMeta(this.dir, (m) => {
      const c = m.chats.find((c) => c.id === this.chatId)
      if (c) {
        c.engine = engine
        c.session_id = null
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
    // Only the transcript Panthr wrote.
    rmSync(chatPath(dir, chatId), { force: true })
  },
  async anyWorking() {
    return anyWorking()
  },
  async models(engine) {
    return modelsFor(engine)
  }
}

export const _test = { live, open }
