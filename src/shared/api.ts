// The app's API between the window (renderer) and the main process.
// Each namespace is one module in src/main/<namespace>.ts that exports a
// handler object of this shape; the preload exposes it as window.panthr.
// Calls are `ipcRenderer.invoke('<ns>:<fn>', ...args)`.

import type {
  AppState, ChatState, Comment, ControlSet, Engine, Host, HostCheck, Item, LibraryItem,
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
    chooseFiles(): Promise<string[]>
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
  }
  files: {
    /** A project file's text (null: missing). */
    read(dir: string, rel: string): Promise<string | null>
    /** Write `next` only if the file still holds `expected` (undo/redo:
     *  never over a change someone else made since). */
    replace(dir: string, rel: string, expected: string, next: string): Promise<boolean>
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
  'chat:session': { dir: string; chatId: string; sessionId: string }
  'project:changed': { dir: string; files: string[] }
  job: import('./types').JobEvent
  'skills:state': SkillsState
  /** Open a project in the window (from the command line), with a first message. */
  open: { dir: string; first: string | null }
  /** A menu command (from the app menu or a shortcut). */
  command: { name: string }
}

export type Namespace = keyof Api
export type ItemOf = Item
