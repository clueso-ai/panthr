// Shared data shapes. Everything that is saved keeps the on-disk JSON of
// the first (GPUI) Panthr, so both read the same ~/Panthr projects and the
// same Application Support/Panthr files.

// ── Projects (~/Panthr/<name>/.studio/project.json) ───────────────

export type Engine = 'claude' | 'codex'

export interface ChatMeta {
  id: string
  title: string
  session_id?: string | null
  created_at: number
  /** The agent this chat talks to (absent: Claude Code). */
  engine?: Engine | null
}

export interface ProjectMeta {
  name: string
  created_at: number
  chats: ChatMeta[]
  agents_enabled: boolean
  /** The model per agent; absent: the default from Settings. */
  models: Partial<Record<Engine, string>>
}

export interface Project {
  dir: string
  meta: ProjectMeta
  /** The host it lives on (null: this Mac). */
  host: string | null
  /** A poster for Home: the newest snapshot or version frame, if any. */
  thumb: string | null
  /** Last change to its files (seconds). */
  edited_at: number
}

// ── Settings (Application Support/Panthr/settings.json) ───────────

export interface Settings {
  model: string
  agents_default: boolean
  export_quality: 'draft' | 'standard' | 'high'
  export_fps: number
  filmstrip: boolean
  reduce_motion: boolean
  appearance: 'system' | 'night' | 'day'
  /** How much of the desktop shows through the window, 0 (solid) to 100. */
  frost: number
  agent: Engine
  codex_model: string
  /** The model that takes reference videos apart (quicker than chats need). */
  reference_model: string
  reference_codex_model: string
  skimming: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  model: 'default',
  agents_default: true,
  export_quality: 'standard',
  export_fps: 30,
  filmstrip: true,
  reduce_motion: false,
  appearance: 'system',
  frost: 40,
  agent: 'claude',
  codex_model: 'default',
  reference_model: 'sonnet',
  reference_codex_model: 'default',
  skimming: true
}

// ── App state (Application Support/Panthr/state.json) ─────────────

export interface AppState {
  project?: string | null
  side?: string | null
  frame?: [number, number, number, number] | null
  maximized?: boolean
  home?: boolean
  chat_w?: number | null
  inspector_w?: number | null
  tl_rows?: number | null
}

// ── Chats (.studio/chats/<id>.json): Rust's externally tagged enum ─

export interface Step {
  id: string
  name: string
  summary: string
  agent?: boolean
  done?: boolean
  error?: boolean
}

export type Item =
  | { User: string }
  | { Text: string }
  | { Steps: Step[] }
  | { Meta: { cost_usd: number; seconds: number; error: boolean } }
  | { Note: string }

/** What an agent process reports (Claude Code's stream-json, Codex's
 *  --json, both mapped onto one shape). */
export type AgentEvent =
  | { type: 'session'; id: string }
  | { type: 'text'; text: string; agent: boolean }
  | { type: 'delta'; text: string; agent: boolean }
  | { type: 'tool'; id: string; name: string; summary: string; agent: boolean }
  | { type: 'tool_done'; id: string; error: boolean }
  | { type: 'result'; cost_usd: number; duration_ms: number; turns: number; error: boolean }
  | { type: 'stderr'; line: string }
  | { type: 'exited'; reason?: string }

/** A chat as the window shows it. */
export interface ChatState {
  dir: string
  chatId: string
  items: Item[]
  working: boolean
  /** When the running turn began (ms since epoch). */
  startedAt: number | null
  /** Index of the reply being streamed. */
  streaming: number | null
  /** Messages typed while it works, sent when the turn ends. */
  queued: string[]
  engine: Engine
}

// ── Controls (.studio/controls.json) ──────────────────────────────

export interface Control {
  label: string
  type: string
  write: string
  min?: number | null
  max?: number | null
  step?: number | null
  unit?: string | null
  options?: unknown[]
  targets?: string[]
  primary?: boolean
  value?: unknown
}

export interface ControlSet {
  title?: string
  file: string
  element: string
  controls: Control[]
  note?: string | null
}

// ── Review: comments, versions, library ───────────────────────────

export interface Comment {
  id: string
  time: number
  end?: number
  x?: number
  y?: number
  body: string
  resolved: boolean
  reply?: string
  created_at: number
}

export interface Version {
  n: number
  file: string
  created_at: number
  bytes: number
  render_seconds: number
  duration: number
}

export interface LibraryItem {
  path: string
  name: string
  is_dir: boolean
  bytes: number
}

export type JobEvent =
  | { type: 'progress'; dir: string; percent: number }
  | { type: 'stage'; dir: string; text: string }
  | { type: 'rendered'; dir: string; version: Version }
  | { type: 'frames'; dir: string; files: string[] }
  | { type: 'annotated'; dir: string; file: string }
  | { type: 'posters'; dir: string }
  | { type: 'failed'; dir: string; error: string }

// ── The editor tool (resources/edit.mjs) ──────────────────────────

export interface Tween {
  id: string
  start: number
  duration: number
  ease?: string | null
  editable: boolean
  method: string
  why?: string | null
}

export interface TimingLayer {
  id: string
  /** The composition file it lives in (edit requests name it). */
  file: string
  label: string
  start: number | null
  end: number | null
  movable: boolean
  why: string | null
  tweens: Tween[]
}

// ── The page (what the preview reports) ───────────────────────────

export interface Layer {
  id: string
  /** A CSS path when it has no id; empty for a script's state object. */
  sel: string
  label: string
  kind: 'text' | 'media' | 'audio' | 'shape' | 'scene' | 'group' | 'motion'
  spans: [number, number][]
}

export interface Scene {
  id: string
  start: number
  duration: number
}

/** A click on an element in the video (from the picker, v14). */
export interface Picked {
  id: string
  hasId: boolean
  layer: string | null
  file: string
  tag: string
  text: string
  path: string[]
  inside?: string[]
  rect?: { x: number; y: number; w: number; h: number }
  box?: { x: number; y: number; w: number; h: number }
  style?: { font: string; size: number; weight: string; color: string; opacity: number; align: string; rotate: number; text: boolean }
  fromLayer?: boolean
}

// ── Skills (~/Panthr/Skills) ──────────────────────────────────────

export interface Pack {
  source: string
  skills: string[]
  title: string
}

export interface Skill {
  name: string
  description: string
  pack: string | null
  on: boolean
  /** Where it came from: one of Panthr's defaults, a package added later,
   *  or the user's own (written or imported here; editable). */
  origin: 'builtin' | 'added' | 'yours'
  dir: string
}

/** A skill found on skills.sh. */
export interface SkillHit {
  id: string
  name: string
  source: string
  installs: number
  installed: boolean
}

export interface SkillsState {
  packs: Pack[]
  skills: Skill[]
  /** The install running now, and those waiting. */
  running: string | null
  waiting: string[]
  error: string | null
}

// ── Remote hosts (Application Support/Panthr/hosts.json) ──────────

export interface Host {
  name: string
  target: string
  root: string
}

export interface HostCheck {
  ok: boolean
  error: string | null
  tools: [string, boolean][]
}

export interface Model {
  id: string
  name: string
}

// ── Reference videos (~/Panthr/References/<handle>/) ──────────────

/** A video the agent has taken apart, to be referenced in chat as @handle. */
export interface Reference {
  id: string
  name: string
  /** What follows @ in a chat (letters, digits, - and _). */
  handle: string
  /** The file or link it came from. */
  source: string
  status: 'importing' | 'analyzing' | 'ready' | 'failed'
  /** What the agent is doing now, while analysing. */
  step: string | null
  error: string | null
  created_at: number
  duration: number
  width: number
  height: number
  /** One sentence on what it is (from the deconstruction). */
  summary: string | null
  dir: string
  /** Absolute paths, when they exist. */
  poster: string | null
  video: string | null
}

/** One file (or folder) in a reference's folder. */
export interface RefFile {
  /** Relative to the reference's folder, with / between parts. */
  path: string
  name: string
  depth: number
  dir: boolean
  size: number
  kind: 'folder' | 'markdown' | 'image' | 'video' | 'audio' | 'text' | 'other'
}
