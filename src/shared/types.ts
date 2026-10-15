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
  /** The Claude account it runs on (absent: the default for new chats). */
  account?: string | null
}

export interface ProjectMeta {
  name: string
  created_at: number
  chats: ChatMeta[]
  agents_enabled: boolean
  /** The model per agent; absent: the default from Settings. */
  models: Partial<Record<Engine, string>>
  /** Named from the first words for now: the first message's name may replace it. */
  auto_name?: boolean
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
  /** Claude Code accounts besides the default (~/.claude), each its own config folder. */
  claude_accounts: AgentAccount[]
  /** The Claude account new chats use ('default': ~/.claude). */
  claude_account: string
  /** Codex accounts besides the default (~/.codex), each its own CODEX_HOME. */
  codex_accounts: AgentAccount[]
  /** The Codex account new chats use ('codex': ~/.codex). */
  codex_account: string
  /** When an account hits its usage limit, carry on with the next one (of the same agent). */
  claude_failover: boolean
  /** After a turn that changed a video, check it (and have the agent fix what is found). */
  self_check: boolean
}

// ── Agent accounts ────────────────────────────────────────────────
// Several subscriptions at once, for Claude Code and for Codex: each
// signed in to its own folder (CLAUDE_CONFIG_DIR, CODEX_HOME); a chat runs
// on one of its agent's accounts.

export interface AgentAccount {
  id: string
  engine: Engine
  label: string
  /** Its folder ('' for the default: ~/.claude or ~/.codex). */
  dir: string
  color: string
}

/** One of an account's usage windows: how much is used (0 to 1) and when it resets (s since the epoch). */
export interface UsageWindow {
  utilization: number
  resetsAt: number | null
}

export interface AccountUsage {
  /** 'allowed', 'allowed_warning' or 'rejected' (at its limit). */
  status: string
  /** Past its limit but still working, on extra usage (paid beyond the plan). */
  overage?: boolean
  resetsAt: number | null
  five_hour: UsageWindow | null
  seven_day: UsageWindow | null
  /** When this was heard (ms since the epoch). */
  at: number
}

// ── Schedules (Application Support/Panthr/schedules.json) ─────────
// Videos made on their own, on a timetable: a message for a project's agent
// (or a new project each time), sent at a time on chosen days.

export interface Schedule {
  id: string
  name: string
  /** What to make: the message for the agent. */
  prompt: string
  /** The project it works in (null: a new project each run). */
  project: string | null
  /** Days of the week it runs (0 Sunday … 6 Saturday); all seven: every day. */
  days: number[]
  /** When, local time ("09:00"). */
  time: string
  /** Export the videos it changed when the agent is done. */
  exportAfter: boolean
  enabled: boolean
  created_at: number
  /** When it last ran (s since the epoch). */
  lastRun: number | null
  last: { at: number; dir: string; ok: boolean; note: string } | null
}

export interface ScheduleStatus extends Schedule {
  /** When it runs next (s since the epoch), null when off. */
  next: number | null
  /** Running now. */
  running: boolean
}

/** A screen or window to record. */
export interface RecordingSource {
  id: string
  name: string
  kind: 'screen' | 'window'
  /** A picture of it (a data URL). */
  thumb: string
}

/** A recording made from Home: held in the data folder, attached to Home's
 *  chat box, until a project is made with it. */
export interface HeldRecording {
  dir: string
  name: string
  duration: number
  /** A still from it (a panthr:// URL). */
  poster: string
}

// ── Usage (built from every chat's turns) ─────────────────────────

export interface UsageTotals {
  /** Claude Code's cost in API dollars (a subscription pays none of it; Codex reports none). */
  cost: number
  seconds: number
  turns: number
  tokens: number
}

export interface UsageTurn extends UsageTotals {
  /** What was asked (the message's first line). */
  label: string
  chat: string
  at: number | null
  engine: Engine
  account: string
  error: boolean
  /** Its time is a guess (from before Panthr noted when turns end). */
  estimated?: boolean
}

export interface UsageProject extends UsageTotals {
  dir: string
  name: string
  lastAt: number | null
  /** By account id. */
  accounts: Record<string, UsageTotals>
  /** Its newest turns, newest first. */
  recent: UsageTurn[]
}

export interface UsageReport {
  all: UsageTotals
  week: UsageTotals
  month: UsageTotals
  /** The last 30 days, oldest first (YYYY-MM-DD, local). */
  days: (UsageTotals & { day: string })[]
  projects: UsageProject[]
  accounts: (UsageTotals & { id: string; label: string; engine: Engine; color: string })[]
  /** Turns from before Panthr noted when each happened: their days are estimated. */
  undated: number
}

/** A video's self-check: what is wrong, and frames to look at. */
export interface VideoCheck {
  dir: string
  name: string
  duration: number
  problems: string[]
  frames: string[]
}

export interface AccountStatus extends AgentAccount {
  /** Null: not checked yet. */
  signedIn: boolean | null
  email: string | null
  /** The plan (Max, Pro, Team…) or how it signs in. */
  plan: string | null
  org: string | null
  usage: AccountUsage | null
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
  skimming: true,
  claude_accounts: [],
  claude_account: 'default',
  codex_accounts: [],
  codex_account: 'codex',
  self_check: true,
  claude_failover: true
}

// ── App state (Application Support/Panthr/state.json) ─────────────

export interface AppState {
  project?: string | null
  /** The project (canvas) last looked at. */
  canvas?: string | null
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
  /** A sub-agent's step: the id of the sub-agent (its Task step) that took it. */
  parent?: string
  /** A sub-agent (Task step): what it was asked to do. */
  brief?: string
  /** A sub-agent (Task step): what it said, as it worked and at the end. */
  said?: string
}

export type Item =
  | { User: string }
  | { Text: string }
  | { Steps: Step[] }
  | { Meta: TurnMeta }
  | { Note: string }

/** What an agent process reports (Claude Code's stream-json, Codex's
 *  --json, both mapped onto one shape). */
export type AgentEvent =
  | { type: 'session'; id: string }
  | { type: 'text'; text: string; agent: boolean; parent?: string }
  | { type: 'delta'; text: string; agent: boolean }
  | { type: 'tool'; id: string; name: string; summary: string; agent: boolean; parent?: string; brief?: string }
  | { type: 'tool_done'; id: string; error: boolean }
  | { type: 'result'; cost_usd: number; duration_ms: number; turns: number; error: boolean; tokens?: number }
  | { type: 'stderr'; line: string }
  | { type: 'exited'; reason?: string }
  /** How much of the account is used (Claude Code's rate_limit_event). */
  | { type: 'limits'; usage: Omit<AccountUsage, 'at'> }

/** How a turn ended: its cost (Claude Code's, in API dollars; Codex reports none) and time,
 *  and (newer turns) when, on which agent and account, and how many tokens. */
export interface TurnMeta {
  cost_usd: number
  seconds: number
  error: boolean
  /** When it ended (s since the epoch). */
  at?: number
  engine?: Engine
  account?: string
  tokens?: number
}

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
  /** The account it runs on (of its agent). */
  account: string
  /** Videos being self-checked after the turn (their names), or null. */
  checking: string | null
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

// ── Clips (HyperFrames' timeline: media and timed elements) ──────────

export interface Clip {
  id: string
  /** How HyperFrames' timeline tool names it (#id). */
  ref: string
  /** What it is: video, audio, img, h1, div... */
  kind: string
  /** HyperFrames' track kind: video, graphics, audio... */
  track: string
  trackIndex: number
  file: string
  start: number
  end: number
  src: string | null
  mediaStart: number
  /** data-volume (null: 1). */
  volume: number | null
  /** data-playback-rate (null: 1). */
  rate: number | null
  /** data-automation lanes. */
  lanes: { target: string; points: { t: number; v: number }[] }[]
  /** It has sound (an audio, or a video with a file). */
  audible: boolean
  linked: string | null
  /** Panthr's fades and ducking on it (seconds; duck: the voices, how far down). */
  mix: { in?: number; out?: number; duck?: { under: string[]; depth: number } } | null
}

export type ClipEdit =
  | { op: 'move'; ref: string; at: number }
  | { op: 'trim'; ref: string; start: number; end: number }
  | { op: 'split'; ref: string; at: number }
  | { op: 'delete'; ref: string; close?: boolean }
  | { op: 'duplicate'; ref: string; at?: number }
  | { op: 'set'; ref: string; volume?: number; rate?: number; track?: number }
  | { op: 'fade'; ref: string; in?: number; out?: number }
  | { op: 'duck'; ref: string; under: string[]; depth?: number }
  | { op: 'normalize'; ref: string; target?: number }
  | { op: 'freeze'; ref: string; at: number; len?: number }

export interface ClipEditResult {
  file: string
  before: string
  after: string
  changed: boolean
  label: string
}

/** A clip's sound as it plays: its waveform (`per` peaks a second, 0..1),
 *  its loudest moment (dBFS) and loudness (LUFS), at its volume. */
export interface ClipSound {
  peaks: number[]
  per: number
  peakDb: number | null
  lufs: number | null
  silent: boolean
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

// ── Connections (Application Support/Panthr/connections.json) ─────
// Other machines' Panthr: a server there, reached over SSH, whose projects
// show here beside this Mac's (their folders as /@<id>/<path there>).

export interface Connection {
  /** Short and stable: it is in every path from the connection (/@<id>/…). */
  id: string
  label: string
  /** 'ssh': a machine reached with ssh; 'command': a server started here (tests, a second data folder). */
  kind: 'ssh' | 'command'
  /** The ssh target (an alias from ~/.ssh/config, or user@host). */
  target: string
  /** Where its projects live there. */
  root: string
  enabled: boolean
  /** kind 'command': its data folder here. */
  dataDir?: string
}

export type ConnectionPhase = 'off' | 'connecting' | 'connected' | 'backoff' | 'blocked'

export interface ConnectionStatus extends Connection {
  phase: ConnectionPhase
  /** What it is doing (installing, starting…), or what went wrong. */
  step: string | null
  error: string | null
  /** The next try (ms since the epoch), while backing off. */
  retryAt: number | null
  /** About the machine, once connected. */
  machine: { hostname: string; platform: string; version: string } | null
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

// ── The Board (Application Support/Panthr/board.json) ─────────────

/** What one thing on the board came from (keys: a project folder, or "ref:<id>"). */
export interface BoardLink {
  from: string
  to: string
}

/** Where the board was looked at: the canvas point at the centre, and zoom. */
export interface BoardView {
  x: number
  y: number
  zoom: number
}

/** A note on a canvas, free or on a tile, or an arrow from one tile to
 *  another saying what should happen; sent to the agent when asked. */
export interface CanvasNote {
  id: string
  kind: 'note' | 'arrow'
  text: string
  /** A note: where it sits (top-left), and the tile it is on, if any. */
  x?: number
  y?: number
  on?: string | null
  /** An arrow: from this tile to that one. */
  from?: string
  to?: string
  /** Sent to the agent (or ticked off). */
  done: boolean
  at: number
}

export interface Board {
  /** The project (canvas folder) this is. */
  dir: string
  notes: CanvasNote[]
  /** Top-left corner of each tile, by key (a project folder, or "ref:<id>"). */
  tiles: Record<string, { x: number; y: number }>
  links: BoardLink[]
  view: BoardView | null
  /** A tile's size on the canvas. */
  tile: { w: number; h: number }
}

/** A project as Home lists it: a folder holding a canvas of videos. */
export interface Canvas {
  dir: string
  name: string
  created_at: number
  edited_at: number
  /** How many videos are on its canvas. */
  videos: number
  /** A poster: the first video's newest picture. */
  thumb: string | null
  host: string | null
}

/** What an import put on the board (keys as in Board.tiles; library: copied files). */
export interface BoardImport {
  projects: string[]
  references: string[]
  library: string[]
  skipped: { path: string; why: string }[]
}

// ── Checkpoints (a project's .studio/checkpoints.json) ────────────

/** One agent turn's files, before and after (commits in the project's own history). */
export interface Checkpoint {
  chatId: string
  /** The index of the turn's message in its chat. */
  turn: number
  label: string
  before: string
  after: string
  /** What the turn changed (paths from the project folder). */
  files: string[]
  /** Undone: the snapshot after the undo (redo goes back from it); null when not undone. */
  undone: string | null
  at: number
}

// ── A project's brand kit (.studio/brand.json, written out as BRAND.md) ──

export interface Brand {
  colors: { name: string; hex: string }[]
  fonts: { role: string; family: string }[]
  /** The logo, from the project folder (copied in as brand/logo.*). */
  logo: string | null
  /** How it sounds: tone, words to use and avoid. */
  voice: string
}
