// Connections: other machines' Panthr, used from here. Each is a Panthr
// server running there (installed and started by us over SSH), reached by a
// bridge that speaks the control socket's JSON lines over the ssh session.
// The server keeps running when the link drops, so an agent's turn there
// goes on; we reconnect with backoff (3, 4, 8, 16 s; reset after 30 s up).
//
// A connection's folders show here as /@<id>/<path there>, and its file
// URLs as panthr://x-<id>-<host>/…, so the window needs nothing new: a call
// with such a path goes to that machine (route), its answers and events come
// back with their paths rewritten, and lists (projects, canvases) are the
// sum of every machine's. Files and previews come through a second channel
// in the same ssh session (a forwarded socket to the server's HTTP).
//
// After T3 Code's environments: one supervisor and one channel per
// environment, an id on every entity, merged lists.

import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import type { Api } from '@shared/api'
import type { Connection, ConnectionStatus } from '@shared/types'
import { emit } from './bus'
import { readJson, writeJson } from './json'
import { dataDir, home, pathEnv, resourcesDir } from './paths'
import { getSettings } from './settings'
import { loginShell, rsyncSsh, run, shellPath, shQuote, sshOpts } from './remote'

/** The wire's version: a server that speaks another is not used. */
export const PROTOCOL = 1
const DELAYS = [3, 4, 8, 16]
const STABLE_MS = 30_000
const HELLO_MS = 25_000

interface Hello {
  id: string
  hostname: string
  platform: string
  version: string
  protocol: number
  home: string
  root: string
  dataDir: string
  tmp: string
  /** Every folder whose paths come back (as given and real). */
  roots?: string[]
}

// ── Paths and URLs, both ways ──────────────────────────────────────────

const PREFIX = /^\/@([a-z0-9]{6})(?=\/|$)/
const URLX = /^panthr:\/\/x-([a-z0-9]{6})-/

/** The connection a value is about (the first path or URL from one). */
export function connectionOf(v: unknown): string | null {
  if (typeof v === 'string') return PREFIX.exec(v)?.[1] ?? URLX.exec(v)?.[1] ?? null
  if (Array.isArray(v)) {
    for (const x of v) {
      const id = connectionOf(x)
      if (id) return id
    }
  } else if (v && typeof v === 'object') {
    for (const x of Object.values(v)) {
      const id = connectionOf(x)
      if (id) return id
    }
  }
  return null
}

const deep = (v: unknown, f: (s: string) => string): unknown => {
  if (typeof v === 'string') return f(v)
  if (Array.isArray(v)) return v.map((x) => deep(x, f))
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [f(k), deep(x, f)]))
  return v
}

/** Our names for a connection's things, as that machine knows them. */
export function toRemote(v: unknown, id: string): unknown {
  const p = `/@${id}`
  const u = `panthr://x-${id}-`
  return deep(v, (s) => (s === p ? '/' : s.startsWith(p + '/') ? s.slice(p.length) : s.startsWith(u) ? 'panthr://' + s.slice(u.length) : s))
}

/** A connection's answers in our names: its folders under /@<id>, its URLs under x-<id>. */
export function toLocal(v: unknown, id: string, h: Pick<Hello, 'home' | 'root' | 'dataDir' | 'tmp' | 'roots'>): unknown {
  const roots = (h.roots ?? [h.root, h.dataDir, h.home, h.tmp]).filter(Boolean).map((r) => r.replace(/\/+$/, '')).filter(Boolean)
  return deep(v, (s) => {
    if (s.startsWith('panthr://') && !s.startsWith('panthr://x-')) return `panthr://x-${id}-` + s.slice('panthr://'.length)
    if (s.startsWith('/') && roots.some((r) => s === r || s.startsWith(r + '/'))) return `/@${id}${s}`
    return s
  })
}

// ── The server's bundle (installed on the far machine) ─────────────────

/** Where the server's build is here: out/server (dev) or the app's Resources/server. */
function bundleDir(): string {
  const packaged = join(process.resourcesPath ?? '', 'server')
  return existsSync(join(packaged, 'server.cjs')) ? packaged : join(resourcesDir(), '..', 'out', 'server')
}
export const serverEntry = (): string => join(bundleDir(), 'server.cjs')

/** The build's id: what it is installed under there, and what a running server must match. */
let build: string | null = null
export function buildId(): string {
  build ??= createHash('sha1').update(readFileSync(serverEntry())).digest('hex').slice(0, 12)
  return build
}

// ── One channel: JSON lines over a child's stdio ───────────────────────

class Link {
  private buf = ''
  private next = 1
  private pending = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>()
  closed = false
  err = ''

  constructor(
    readonly proc: ChildProcess,
    onEvent: (name: string, payload: unknown) => void,
    onClose: (why: string) => void
  ) {
    proc.stdout!.setEncoding('utf8')
    proc.stdout!.on('data', (chunk: string) => {
      this.buf += chunk
      let nl: number
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, nl).trim()
        this.buf = this.buf.slice(nl + 1)
        if (!line) continue
        let m: { id?: number; result?: unknown; error?: string; event?: string; payload?: unknown }
        try {
          m = JSON.parse(line)
        } catch {
          continue
        }
        if (m.event) onEvent(m.event, m.payload)
        else if (typeof m.id === 'number' && this.pending.has(m.id)) {
          const p = this.pending.get(m.id)!
          this.pending.delete(m.id)
          if (m.error) p.fail(new Error(m.error))
          else p.ok(m.result)
        }
      }
    })
    proc.stderr!.setEncoding('utf8')
    proc.stderr!.on('data', (s: string) => {
      this.err = (this.err + s).slice(-4000)
    })
    const end = (): void => {
      if (this.closed) return
      this.closed = true
      const why = lastLine(this.err) || 'The connection closed'
      for (const p of this.pending.values()) p.fail(new Error(why))
      this.pending.clear()
      onClose(why)
    }
    proc.on('close', end)
    proc.on('error', (e) => {
      this.err += `\n${e.message}`
      end()
    })
    proc.stdin!.on('error', () => {})
  }

  call(method: string, params: unknown[], timeoutMs = 0): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Not connected'))
    const id = this.next++
    return new Promise((ok, fail) => {
      let timer: NodeJS.Timeout | undefined
      if (timeoutMs) timer = setTimeout(() => {
        this.pending.delete(id)
        fail(new Error('No answer'))
      }, timeoutMs)
      this.pending.set(id, { ok: (v) => (clearTimeout(timer), ok(v)), fail: (e) => (clearTimeout(timer), fail(e)) })
      this.proc.stdin!.write(JSON.stringify({ id, method, params }) + '\n')
    })
  }

  close(): void {
    if (!this.proc.killed) this.proc.kill()
  }
}

const lastLine = (s: string): string => s.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('Warning: Permanently added')).pop() ?? ''

/** Failures retrying won't fix: the person has to (sign-in, a missing tool, an unknown host). */
const BLOCKED = /permission denied|host key verification|could not resolve hostname|no such file or directory|needs node|not supported|bad configuration|unknown connection kind/i

// ── A connection's supervisor ──────────────────────────────────────────

class Supervisor {
  phase: ConnectionStatus['phase'] = 'off'
  step: string | null = null
  error: string | null = null
  retryAt: number | null = null
  hello: Hello | null = null
  link: Link | null = null
  /** The forwarded socket to the server's HTTP (files, previews). */
  httpSock: string | null = null
  private attempt = 0
  private timer: NodeJS.Timeout | null = null
  private stable: NodeJS.Timeout | null = null
  private gen = 0

  constructor(public c: Connection) {}

  status(): ConnectionStatus {
    return {
      ...this.c, phase: this.phase, step: this.step, error: this.error, retryAt: this.retryAt,
      machine: this.hello ? { hostname: this.hello.hostname, platform: this.hello.platform, version: this.hello.version } : null
    }
  }

  private set(p: Partial<Pick<Supervisor, 'phase' | 'step' | 'error' | 'retryAt'>>): void {
    Object.assign(this, p)
    changed()
  }

  start(): void {
    this.stop()
    if (!this.c.enabled) return this.set({ phase: 'off', step: null, error: null, retryAt: null })
    void this.connect()
  }

  stop(): void {
    this.gen++
    if (this.timer) clearTimeout(this.timer)
    if (this.stable) clearTimeout(this.stable)
    this.timer = this.stable = null
    this.link?.close()
    this.link = null
    this.hello = null
  }

  retry(): void {
    this.attempt = 0
    this.start()
  }

  private async connect(): Promise<void> {
    const gen = ++this.gen
    this.set({ phase: 'connecting', step: `Reaching ${this.c.label}`, error: null, retryAt: null })
    try {
      const plan = await prepare(this.c, (step) => gen === this.gen && this.set({ step }))
      if (gen !== this.gen) return
      this.httpSock = plan.httpSock
      this.set({ step: 'Starting Panthr there' })
      const proc = spawn(plan.cmd, plan.args, { env: plan.env, stdio: ['pipe', 'pipe', 'pipe'] })
      const link = new Link(proc, (name, payload) => gen === this.gen && this.onEvent(name, payload), (why) => gen === this.gen && this.lost(why))
      this.link = link
      const hello = (await link.call('env.hello', [], HELLO_MS)) as Hello
      if (gen !== this.gen) return
      if (hello.protocol !== PROTOCOL) throw new Error(`Its Panthr is not supported here (protocol ${hello.protocol}, this Mac speaks ${PROTOCOL}). Update Panthr on both.`)
      this.hello = hello
      await link.call('subscribe', ['*'])
      this.set({ phase: 'connected', step: null, error: null, retryAt: null })
      this.stable = setTimeout(() => (this.attempt = 0), STABLE_MS)
      void this.syncSettings()
      // Its projects join the lists.
      emit('project:changed', { dir: `/@${this.c.id}`, files: [] })
    } catch (e) {
      if (gen === this.gen) this.fail((e as Error).message)
    }
  }

  private lost(why: string): void {
    if (this.phase === 'connected') this.fail(`Connection lost: ${why}`)
    else this.fail(why)
  }

  private fail(why: string): void {
    this.link?.close()
    this.link = null
    if (this.stable) clearTimeout(this.stable)
    if (BLOCKED.test(why)) return this.set({ phase: 'blocked', step: null, error: why, retryAt: null })
    const delay = DELAYS[Math.min(this.attempt, DELAYS.length - 1)] * 1000
    this.attempt++
    const gen = this.gen
    this.timer = setTimeout(() => gen === this.gen && void this.connect(), delay)
    this.set({ phase: 'backoff', step: null, error: why, retryAt: Date.now() + delay })
  }

  private onEvent(name: string, payload: unknown): void {
    // Its own app-wide state stays there: this window shows this Mac's.
    if (LOCAL_ONLY.has(name) || !this.hello) return
    emit(name as any, toLocal(payload, this.c.id, this.hello) as any)
  }

  /** The agents there use this Mac's choices (agent, models, exports). */
  async syncSettings(): Promise<void> {
    const s = getSettings()
    const pick = { agent: s.agent, model: s.model, codex_model: s.codex_model, opencode_model: s.opencode_model, agents_default: s.agents_default, export_quality: s.export_quality, export_fps: s.export_fps, reference_model: s.reference_model, reference_codex_model: s.reference_codex_model, reference_opencode_model: s.reference_opencode_model }
    await this.link?.call('settings.set', [pick]).catch(() => {})
  }

  async call(method: string, params: unknown[]): Promise<unknown> {
    if (!this.link || !this.hello || this.phase !== 'connected') throw new Error(`${this.c.label} is not connected`)
    const at = UPLOADS[method]
    if (at !== undefined && params[at] != null) {
      params = [...params]
      params[at] = await this.upload(params[at] as string | string[])
    }
    const r = await this.link.call(method, toRemote(params, this.c.id) as unknown[])
    return toLocal(r, this.c.id, this.hello)
  }

  /** Files from this Mac, copied there first (a drop, a logo, an import): their paths there. */
  private async upload(paths: string | string[]): Promise<string | string[]> {
    const list = Array.isArray(paths) ? paths : [paths]
    const mine = (p: string): boolean => typeof p === 'string' && p.startsWith('/') && !PREFIX.test(p) && existsSync(p)
    // The same machine: it reads them where they are.
    if (this.c.kind !== 'ssh' || !list.some(mine)) return paths
    const into = `.panthr/uploads/${Date.now().toString(36)}${randomBytes(3).toString('hex')}`
    const mk = await run('ssh', [...sshOpts(), this.c.target, `mkdir -p "$HOME/${into}"`])
    if (mk.code !== 0) throw new Error(lastLine(mk.stderr) || `Could not send files to ${this.c.label}`)
    const out: string[] = []
    for (const p of list) {
      if (!mine(p)) {
        out.push(p)
        continue
      }
      const r = await run('rsync', ['-az', '-e', rsyncSsh(), p.replace(/\/+$/, ''), `${this.c.target}:${into}/`])
      if (r.code !== 0) throw new Error(lastLine(r.stderr) || `Could not send ${p} to ${this.c.label}`)
      out.push(`${this.hello!.home}/${into}/${p.replace(/\/+$/, '').split('/').pop()}`)
    }
    return Array.isArray(paths) ? out : out[0]
  }
}

/** Calls that bring files from this Mac (the argument holding them). */
const UPLOADS: Record<string, number> = { 'review.importFiles': 1, 'board.import': 1, 'brand.logo': 1 }

/** Events about that machine's own app (its settings, its references, its skills, its window). */
const LOCAL_ONLY = new Set(['settings', 'references', 'skills:state', 'command', 'connections'])

// ── Starting a connection's server ─────────────────────────────────────

interface Plan {
  cmd: string
  args: string[]
  env: NodeJS.ProcessEnv
  httpSock: string
}

const sockDir = (): string => join(dataDir(), 'conn')

async function prepare(c: Connection, step: (s: string) => void): Promise<Plan> {
  const entry = serverEntry()
  if (!existsSync(entry)) throw new Error('The Panthr server is missing from this build (npm run build)')
  if (c.kind === 'command') {
    // A server started here: a second Panthr with its own data folder (tests use this).
    const data = c.dataDir || join(dataDir(), 'Local', c.id)
    mkdirSync(data, { recursive: true })
    return {
      cmd: process.execPath,
      args: [entry, '--bridge'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PATH: pathEnv(), PANTHR_DATA_DIR: data, PANTHR_ROOT: c.root.replace(/^~(?=\/|$)/, home()), PANTHR_BUILD: buildId(), PANTHR_RESOURCES: resourcesDir() },
      httpSock: join(data, 'http.sock')
    }
  }
  if (c.kind !== 'ssh') throw new Error(`Unknown connection kind: ${c.kind}`)

  // What is there: its home, Node, and whether this build is installed.
  const ver = buildId()
  const dir = `.panthr/server/${ver}`
  const probe = await run('ssh', [...sshOpts(), c.target, loginShell(`echo "HOME=$HOME"; command -v node >/dev/null && echo "NODE=$(node -p process.versions.node)"; test -f "$HOME/${dir}/server.cjs" && echo HAVE; true`)])
  const out = probe.stdout.toString('utf8')
  const homeThere = /^HOME=(.+)$/m.exec(out)?.[1]?.trim()
  if (probe.code !== 0 || !homeThere) throw new Error(lastLine(probe.stderr) || `Could not reach ${c.target}`)
  const node = /^NODE=(\d+)/m.exec(out)?.[1]
  if (!node) throw new Error(`Panthr needs Node 18 or newer on ${c.label} (none found in its login shell)`)
  if (+node < 18) throw new Error(`Panthr needs Node 18 or newer on ${c.label} (it has ${node})`)

  if (!/^HAVE$/m.test(out)) {
    step(`Installing Panthr on ${c.label}`)
    const mk = await run('ssh', [...sshOpts(), c.target, `mkdir -p "$HOME/${dir}.part/resources"`])
    if (mk.code !== 0) throw new Error(lastLine(mk.stderr) || 'Could not make its folder')
    for (const [from, to] of [[entry, `${dir}.part/server.cjs`], [resourcesDir() + '/', `${dir}.part/resources/`]] as const) {
      const r = await run('rsync', ['-az', '--exclude', 'bin/', '-e', rsyncSsh(), from, `${c.target}:${to}`])
      if (r.code !== 0) throw new Error(lastLine(r.stderr) || 'Could not copy Panthr there')
    }
    // Whole or not at all: a half-copied build is never run.
    const mv = await run('ssh', [...sshOpts(), c.target, `rm -rf "$HOME/${dir}" && mv "$HOME/${dir}.part" "$HOME/${dir}"`])
    if (mv.code !== 0) throw new Error(lastLine(mv.stderr) || 'Could not finish installing')
  }

  mkdirSync(sockDir(), { recursive: true })
  const httpSock = join(sockDir(), `${c.id}.sock`)
  rmSync(httpSock, { force: true })
  const script = `PANTHR_BUILD=${ver} PANTHR_ROOT=${shellPath(c.root)} exec node "$HOME/${dir}/server.cjs" --bridge`
  return {
    cmd: 'ssh',
    args: [
      '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
      // Its own session (not the shared one), so its forward lives and dies with it.
      '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'ExitOnForwardFailure=yes', '-o', 'StreamLocalBindUnlink=yes',
      '-L', `${httpSock}:${homeThere}/.panthr/data/http.sock`,
      c.target, loginShell(script)
    ],
    env: { ...process.env, PATH: pathEnv() },
    httpSock
  }
}

// ── All connections ────────────────────────────────────────────────────

const file = (): string => join(dataDir(), 'connections.json')
const sups = new Map<string, Supervisor>()

function catalog(): Connection[] {
  const raw = readJson<unknown>(file(), [])
  if (!Array.isArray(raw)) return []
  return raw.filter((c): c is Connection => !!c && typeof c.id === 'string' && /^[a-z0-9]{6}$/.test(c.id) && typeof c.label === 'string')
    .map((c) => ({ id: c.id, label: c.label, kind: c.kind === 'command' ? 'command' : 'ssh', target: c.target ?? '', root: c.root || '~/Panthr', enabled: c.enabled !== false, ...(c.dataDir ? { dataDir: c.dataDir } : {}) }))
}

const save = (): void => writeJson(file(), [...sups.values()].map((s) => s.c))

let pending: NodeJS.Timeout | null = null
function changed(): void {
  if (pending) return
  pending = setTimeout(() => {
    pending = null
    emit('connections', statuses())
  }, 50)
}

const statuses = (): ConnectionStatus[] => [...sups.values()].map((s) => s.status())

/** Start every saved connection (when the app is ready). */
export function startConnections(): void {
  for (const c of catalog()) {
    const s = new Supervisor(c)
    sups.set(c.id, s)
    s.start()
  }
}

/** Quitting: the links close; the servers there go on. */
export function stopConnections(): void {
  for (const s of sups.values()) s.stop()
}

/** The connections answering now. */
const live = (): Supervisor[] => [...sups.values()].filter((s) => s.phase === 'connected')

/** Lists every machine contributes to, and how a connection's entries are marked. */
const MERGED: Record<string, (x: any, s: Supervisor) => any> = {
  'canvases.list': (x, s) => ({ ...x, host: s.c.label }),
  'projects.list': (x, s) => ({ ...x, host: s.c.label })
}

/** A call, wherever it belongs. */
export async function route(method: string, params: unknown[], local: (m: string, p: unknown[]) => Promise<unknown>): Promise<unknown> {
  const ns = method.split('.')[0]
  const id = ns === 'state' || ns === 'connections' ? null : connectionOf(params)
  if (id) {
    const s = sups.get(id)
    if (!s) throw new Error('That connection is gone')
    return s.call(method, params)
  }
  // A new project on a connection.
  if (method === 'canvases.create' && typeof params[1] === 'string' && params[1]) {
    const s = sups.get(params[1])
    if (!s) throw new Error('That connection is gone')
    return s.call(method, [params[0]])
  }
  const mine = await local(method, params)
  const mark = MERGED[method]
  if (mark && Array.isArray(mine)) {
    const theirs = await Promise.all(live().map((s) => s.call(method, []).then((xs) => (Array.isArray(xs) ? xs.map((x) => mark(x, s)) : []), () => [])))
    return [...mine, ...theirs.flat()]
  }
  if (method === 'chats.anyWorking' && !mine) {
    for (const s of live()) if (await s.call(method, []).catch(() => false)) return true
  }
  if (method === 'settings.set') for (const s of live()) void s.syncSettings()
  return mine
}

/** A file or page from a connection (panthr://x-<id>-<host>/<path>), through its forwarded socket. */
export async function proxy(url: URL, req: Request): Promise<Response> {
  const m = /^x-([a-z0-9]{6})-(.+)$/.exec(url.hostname)
  const s = m ? sups.get(m[1]) : undefined
  if (!m || !s?.httpSock || s.phase !== 'connected') return new Response(null, { status: 502 })
  const headers: Record<string, string> = {}
  const range = req.headers.get('range')
  if (range) headers.range = range
  return new Promise((ok) => {
    const r = request({ socketPath: s.httpSock!, path: `/${m[2]}${url.pathname}${url.search}`, method: 'GET', headers }, (res) => {
      const h = new Headers()
      for (const [k, v] of Object.entries(res.headers)) if (typeof v === 'string') h.set(k, v)
      h.set('Cache-Control', 'no-store')
      h.set('Access-Control-Allow-Origin', '*')
      const body = res.statusCode === 204 || res.statusCode === 304 ? null : (Readable.toWeb(res) as ReadableStream)
      ok(new Response(body, { status: res.statusCode ?? 502, headers: h }))
    })
    r.on('error', () => ok(new Response(null, { status: 502 })))
    r.end()
  })
}

const newId = (): string => {
  let id = ''
  do id = randomBytes(6).toString('base64').replace(/[^a-z0-9]/gi, '').toLowerCase().padEnd(6, '0').slice(0, 6)
  while (sups.has(id))
  return id
}

export const connectionsApi: Api['connections'] = {
  async list() {
    return statuses()
  },
  async save(input) {
    const label = input.label.trim() || input.target.trim()
    if (!label) throw new Error('Give it a name')
    if (input.kind === 'ssh' && !input.target.trim()) throw new Error('Which machine? An ssh target, like devbox or me@10.0.0.4')
    const id = input.id && sups.has(input.id) ? input.id : newId()
    const c: Connection = { id, label, kind: input.kind, target: input.target.trim(), root: input.root.trim() || '~/Panthr', enabled: input.enabled, ...(input.dataDir ? { dataDir: input.dataDir } : {}) }
    const old = sups.get(id)
    old?.stop()
    const s = new Supervisor(c)
    sups.set(id, s)
    save()
    s.start()
    changed()
    return s.status()
  },
  async remove(id) {
    const s = sups.get(id)
    if (!s) return
    // Its server there stops too; its projects stay where they are.
    await s.link?.call('env.shutdown', [], 3000).catch(() => {})
    s.stop()
    sups.delete(id)
    save()
    changed()
    emit('project:changed', { dir: `/@${id}`, files: [] })
  },
  async setEnabled(id, on) {
    const s = sups.get(id)
    if (!s) return
    s.c = { ...s.c, enabled: on }
    save()
    s.start()
    if (!on) emit('project:changed', { dir: `/@${id}`, files: [] })
  },
  async retry(id) {
    sups.get(id)?.retry()
  },
  async sshHosts() {
    let text = ''
    try {
      text = readFileSync(join(home(), '.ssh', 'config'), 'utf8')
    } catch {
      return []
    }
    const out = new Set<string>()
    for (const line of text.split('\n')) {
      const m = /^\s*Host\s+(.+)$/i.exec(line)
      if (m) for (const h of m[1].split(/\s+/)) if (h && !/[*?!]/.test(h)) out.add(h)
    }
    return [...out]
  }
}

export const _test = { sups, Supervisor, shQuote }
