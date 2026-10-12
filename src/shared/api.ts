// The app's API between the window (renderer) and the main process.
// Each namespace is one module in src/main/<namespace>.ts that exports a
// handler object of this shape; the preload exposes it as window.panthr.
// Calls are `ipcRenderer.invoke('<ns>:<fn>', ...args)`.

import type {
  AccountStatus, AppState, ChatState, Connection, ConnectionStatus, Comment, Reference, RefFile, SkillHit, ControlSet, Engine, Host, HostCheck, Item, LibraryItem,
  Model, Project, ProjectMeta, Settings, SkillsState, TimingLayer, Version
} from './types'

export interface Api {
  app: {
    /** Tools missing on this Mac ("claude", "node", ...). */
    missingTools(): Promise<string[]>
    /** Reveal in Finder / open with the default app / open a URL. */
    reveal(path: string): Promise<void>
    openPath(path: string): Promise<void>
    openExternal(url: string): Promise<void>
    /** A file URL the window may load (images, videos under ~/Panthr or a project). */
    fileUrl(path: string): Promise<string>
    /** Choose a folder (File ▸ Open Folder…) or files (Library ▸ Add). */
    chooseFolder(): Promise<string | null>
    chooseFiles(folders?: boolean): Promise<string[]>
    quit(): Promise<void>
    /** Put the `panthr` command on the PATH (~/.local/bin); where it went and whether the shell will find it. */
    installCli(): Promise<{ path: string; onPath: boolean; installed: boolean }>
    /** Whether `panthr` is installed (and where). */
    cliStatus(): Promise<{ path: string; onPath: boolean; installed: boolean }>
  }
  settings: {
    get(): Promise<Settings>
    /** Merge, save, broadcast (event 'settings'). */
    set(patch: Partial<Settings>): Promise<Settings>
  }
  state: {
    get(): Promise<AppState>
    set(patch: Partial<AppState>): Promise<void>
  }
  projects: {
    /** Every project, newest first: ~/Panthr's, opened folders, hosts' mirrors. */
    list(): Promise<Project[]>
    /** A new project (on a host when `host` names one). */
    create(name: string, host?: string | null): Promise<Project>
    load(dir: string): Promise<Project | null>
    saveMeta(dir: string, meta: ProjectMeta): Promise<void>
    rename(dir: string, name: string): Promise<Project>
    openFolder(dir: string): Promise<Project | null>
    /** The URL the preview iframe loads for this project. */
    previewUrl(dir: string): Promise<string>
    /** Start watching the project's files (event 'project:changed'). */
    watch(dir: string): Promise<void>
    unwatch(dir: string): Promise<void>
  }
  chats: {
    /** Open (load) a chat; its state comes back and then as 'chat:state' events. */
    open(dir: string, chatId: string): Promise<ChatState>
    /** A new chat in the project (returns its id). */
    create(dir: string, engine?: Engine): Promise<string>
    send(dir: string, chatId: string, text: string): Promise<void>
    stop(dir: string, chatId: string): Promise<void>
    setEngine(dir: string, chatId: string, engine: Engine): Promise<void>
    /** Append a note line (e.g. "Moved Title to 1.2 s"). */
    note(dir: string, chatId: string, text: string): Promise<void>
    remove(dir: string, chatId: string): Promise<void>
    /** Run the chat on another of its agent's accounts (its conversation goes along). */
    setAccount(dir: string, chatId: string, account: string): Promise<void>
    /** Any chat in any project working right now. */
    anyWorking(): Promise<boolean>
    models(engine: Engine): Promise<Model[]>
  }
  controls: {
    all(dir: string): Promise<Record<string, ControlSet>>
    save(dir: string, all: Record<string, ControlSet>): Promise<void>
    /** Run the editor tool (inspect, move, resize, tween, set, ...). */
    run(dir: string, req: Record<string, unknown>): Promise<any>
    /** inspect, parsed into timing per layer id. */
    timing(dir: string): Promise<Record<string, TimingLayer>>
  }
  review: {
    comments(dir: string): Promise<Comment[]>
    saveComments(dir: string, comments: Comment[]): Promise<void>
    versions(dir: string): Promise<Version[]>
    /** Export: progress comes as 'job' events. */
    render(dir: string): Promise<void>
    cancelRender(dir: string): Promise<void>
    /** The filmstrip under the timeline ('job' frames event). */
    frames(dir: string, duration: number, count: number): Promise<string[]>
    /** A frame at t with the user's drawing on it ('job' annotated). */
    annotate(dir: string, t: number, strokes: [number, number][][]): Promise<string>
    library(): Promise<LibraryItem[]>
    addToLibrary(files: string[]): Promise<number>
    /** Check a video: HyperFrames' check, flashes and blank stretches, a few frames to look at. */
    check(dir: string): Promise<import('./types').VideoCheck>
    /** Write a file into the project (dropped/pasted images). */
    importFiles(dir: string, files: string[]): Promise<string[]>
  }
  skills: {
    state(): Promise<SkillsState>
    add(source: string): Promise<void>
    remove(source: string): Promise<void>
    setOn(name: string, on: boolean): Promise<void>
    /** Link the shared skills into a project. */
    link(dir: string): Promise<void>
    /** Search skills.sh. */
    search(query: string): Promise<SkillHit[]>
    /** Install one skill from a package (adds it to that pack's set). */
    addOne(source: string, skill: string): Promise<void>
    /** The user's own skill, written here: its name, when to use it, what it says. */
    create(name: string, description: string, body: string): Promise<string>
    /** Copy in a folder that holds a SKILL.md (or folders of them). */
    importFolder(path: string): Promise<string[]>
    /** A skill's SKILL.md; `editable` for the user's own. */
    read(name: string): Promise<{ text: string; dir: string; editable: boolean }>
    /** Save a user's own skill. */
    write(name: string, text: string): Promise<void>
    /** Delete a user's own skill (packs are removed with `remove`). */
    removeOwn(name: string): Promise<void>
  }
  references: {
    list(): Promise<Reference[]>
    /** A video file or a link; the deconstruction starts at once. */
    add(input: string, name?: string): Promise<Reference>
    remove(id: string): Promise<void>
    rename(id: string, name: string): Promise<Reference>
    /** Deconstruct again (after a failure, or with a newer agent). */
    retry(id: string): Promise<void>
    /** Everything in its folder: what the agent wrote, the frames, the video. */
    files(id: string): Promise<RefFile[]>
    /** A text file from its folder (null: missing, or too big to show). */
    readFile(id: string, path: string): Promise<string | null>
  }
  history: {
    /** Every recorded turn of a project. */
    list(dir: string): Promise<import('./types').Checkpoint[]>
    /** Put a turn's files back as they were before it (or, redo, as it left them). */
    undo(dir: string, chatId: string, turn: number, redo?: boolean): Promise<{ restored: string[]; skipped: string[] }>
  }
  brand: {
    /** A project's brand kit (empty when it has none). */
    get(dir: string): Promise<import('./types').Brand>
    /** Save it (and BRAND.md beside it, for the agent). */
    save(dir: string, brand: import('./types').Brand): Promise<void>
    /** Copy a logo into the project's brand/ folder (returns its path from the project). */
    logo(dir: string, from: string): Promise<string>
  }
  share: {
    /** The project as one .panthr file (asks where, when no file is given); returns its path, or '' when cancelled. */
    save(canvas: string, file?: string): Promise<string>
    /** Open a .panthr: a new project, or the same project's notes merged in. */
    open(file: string): Promise<{ dir: string; merged: boolean; text: string }>
  }
  assistant: {
    /** The assistant's folder and its newest conversation (made the first time). */
    open(): Promise<{ dir: string; chatId: string }>
    /** A new conversation with it. */
    fresh(): Promise<{ dir: string; chatId: string }>
    /** A message for a project's own agent (no project: a new one, named from it); the window goes there. */
    handoff(project: string | null, text: string, video?: string | null): Promise<{ dir: string; name: string; chatId: string; queued: boolean }>
  }
  canvases: {
    /** Every project (a canvas of videos), newest first. */
    list(): Promise<import('./types').Canvas[]>
    /** A new, empty project (on a connection, given its id). */
    create(name: string, on?: string | null): Promise<import('./types').Canvas>
    /** The project a video belongs to. */
    of(dir: string): Promise<string>
    /** A project by folder or name. */
    find(what: string): Promise<string>
  }
  board: {
    /** A project's canvas: tiles, arrows, the last view. */
    get(canvas: string): Promise<import('./types').Board>
    move(canvas: string, key: string, x: number, y: number): Promise<void>
    setView(canvas: string, view: import('./types').BoardView): Promise<void>
    /** A new video in the project, placed beside what it came from (or near `near`), and shown. */
    create(canvas: string, name: string, from?: string | null, near?: { x: number; y: number } | null): Promise<Project>
    /** Video folders (or folders of them), video files (as references) and other files (into the Library), placed from `at`. */
    import(canvas: string, paths: string[], at?: { x: number; y: number } | null): Promise<import('./types').BoardImport>
    /** The canvas's notes and instruction arrows, all of them. */
    notes(canvas: string, notes: import('./types').CanvasNote[]): Promise<void>
    /** Every size of videos: a copy per frame (9:16, 1:1, 4:5, 16:9) laid out again by the agent, each exported when it is done. */
    sizes(canvas: string, dirs: string[], sizes: string[], exportAfter: boolean): Promise<{ dirs: string[]; chatId: string }>
    /** A copy of a video beside it (an arrow from it), to redo from a moment on. */
    branch(canvas: string, dir: string, name: string): Promise<Project>
    /** Exported videos copied into the project's Exports/<when>/ (returns the folder). */
    collect(canvas: string, files: { dir: string; file: string }[]): Promise<string>
    link(canvas: string, from: string, to: string): Promise<void>
    unlink(canvas: string, from: string, to: string): Promise<void>
    /** Take the window to a tile (returns its key). */
    focus(canvas: string, what: string): Promise<string>
    /** Open a video in the window. */
    open(canvas: string, what: string): Promise<string>
  }
  files: {
    /** A project file's text (null: missing). */
    read(dir: string, rel: string): Promise<string | null>
    /** Write `next` only if the file still holds `expected` (undo/redo:
     *  never over a change someone else made since). */
    replace(dir: string, rel: string, expected: string, next: string): Promise<boolean>
  }
  schedules: {
    list(): Promise<import('./types').ScheduleStatus[]>
    /** Add one, or change it (by id). */
    save(s: Omit<import('./types').Schedule, 'id' | 'created_at' | 'lastRun' | 'last'> & { id?: string }): Promise<import('./types').ScheduleStatus>
    remove(id: string): Promise<void>
    /** Run it now (as if its time had come). */
    run(id: string): Promise<void>
  }
  usage: {
    /** Time, cost and tokens across every project's chats: by day, project, account and turn. */
    report(): Promise<import('./types').UsageReport>
  }
  accounts: {
    /** Every account of both agents: who it is, its plan, how much is used (refresh: ask the agents again now). */
    list(refresh?: boolean): Promise<AccountStatus[]>
    /** A new account for an agent (its own folder); sign in to it next. */
    add(engine: import('./types').Engine, label: string): Promise<AccountStatus>
    rename(id: string, label: string): Promise<void>
    /** Forget it (its folder and sign-in stay on disk). */
    remove(id: string): Promise<void>
    /** Open Terminal to sign in to it (claude auth login, codex login). */
    signIn(id: string): Promise<void>
    /** The account new chats use (for its agent). */
    setDefault(id: string): Promise<void>
  }
  connections: {
    /** This Mac's connections to other machines, with how each is doing. */
    list(): Promise<ConnectionStatus[]>
    /** Add one (or change it, by id); it connects at once if enabled. */
    save(c: Omit<Connection, 'id'> & { id?: string }): Promise<ConnectionStatus>
    remove(id: string): Promise<void>
    setEnabled(id: string, on: boolean): Promise<void>
    /** Try again now (after a failure). */
    retry(id: string): Promise<void>
    /** Hosts named in ~/.ssh/config, to pick from. */
    sshHosts(): Promise<string[]>
  }
  hosts: {
    list(): Promise<Host[]>
    save(hosts: Host[]): Promise<void>
    check(host: Host): Promise<HostCheck>
    /** Bring a host's projects' notes over (and list them). */
    refresh(name: string): Promise<Project[]>
  }
}

/** Events from the main process (window.panthr.on(name, cb)). */
export interface Events {
  settings: Settings
  'chat:state': ChatState
  /** A turn ended in a project (its files may have changed). */
  'chat:turn': { dir: string; chatId: string }
  'chat:titled': { dir: string; chatId: string; title: string }
  /** A project got a new name (by the person, or from its first message). */
  'project:renamed': { dir: string; name: string }
  /** A .panthr was opened (from Finder, a drop, or the menu): go to its project. */
  'share:opened': { dir: string; merged: boolean; text: string }
  /** A project's brand kit changed. */
  'brand:changed': { dir: string }
  /** A project's checkpoints changed. */
  'history:changed': { dir: string }
  /** The board's tiles or arrows changed. */
  'board:changed': import('./types').Board
  /** The assistant sent a message to a project's conversation: go there (with this video active, if one). */
  'assistant:handoff': { canvas: string; chatId: string; active: string | null }
  /** The schedules changed (saved, ran, finished). */
  schedules: import('./types').ScheduleStatus[]
  /** The Claude accounts changed (signed in, usage heard). */
  accounts: AccountStatus[]
  /** The connections changed (added, removed, connecting, connected, failed). */
  connections: ConnectionStatus[]
  /** Show this tile (fresh: it was just made). */
  'board:focus': { canvas: string; key: string; fresh: boolean }
  'chat:session': { dir: string; chatId: string; sessionId: string }
  'project:changed': { dir: string; files: string[] }
  job: import('./types').JobEvent
  'skills:state': SkillsState
  /** The references, whenever one changes (added, a step, done). */
  references: Reference[]
  /** Open a project in the window (from the command line), with a first message. */
  open: { dir: string; first: string | null }
  /** A menu command (from the app menu or a shortcut). */
  command: { name: string }
}

export type Namespace = keyof Api
export type ItemOf = Item
