// Remote hosts: projects that live and run on another machine (a dev box,
// a beefy desktop) while Panthr is used here. Everything runs there: the
// page itself (a small server on the host, reached through an SSH tunnel),
// the agent (Claude Code or Codex), the editor tool behind the timeline and
// inspector, snapshots and renders. Here there is only the app's own notes
// on the project (.studio: chats, comments, versions), kept in step with
// rsync, and the videos and frames brought over to show.
//
// A host is an SSH target (an alias from ~/.ssh/config, or user@host) and a
// folder there that holds its projects. SSH connections are shared
// (ControlMaster), so syncing every second or two costs little.
//
// Port of studio-mac/src/remote.rs.

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { Host, HostCheck } from '@shared/types'
import { dataDir, pathEnv, resource } from './paths'
import { readJson, writeJson } from './json'

// ── Hosts and mirrors ─────────────────────────────────────────────────

const DEFAULT_ROOT = '~/Panthr'

function hostsPath(): string {
  // (A test points this elsewhere.)
  return process.env.PANTHR_HOSTS_FILE || join(dataDir(), 'hosts.json')
}

export function hosts(): Host[] {
  const raw = readJson<unknown>(hostsPath(), [])
  if (!Array.isArray(raw)) return []
  return raw
    .filter((h): h is Host => !!h && typeof h.name === 'string' && typeof h.target === 'string')
    .map((h) => ({ name: h.name, target: h.target, root: h.root || DEFAULT_ROOT }))
}

export function saveHosts(h: Host[]): void {
  writeJson(hostsPath(), h)
}

/** Where remote projects' mirrors live here: <dataDir>/Remote/<host slug>/<project>. */
export function mirrors(): string {
  return process.env.PANTHR_MIRRORS || join(dataDir(), 'Remote')
}

/** A host's name, safe as a folder name. */
export function slug(name: string): string {
  return name.replace(/[^\p{L}\p{N}_-]/gu, '-').replace(/^-+|-+$/g, '')
}

export function mirrorOf(host: Host, project: string): string {
  return join(mirrors(), slug(host.name), project)
}

/** The host a project lives on, and its name there (null: this Mac). */
export function hostOf(dir: string): { host: Host; name: string } | null {
  const rel = relative(mirrors(), dir)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
  const [h, p] = rel.split(sep)
  if (!h || !p) return null
  const host = hosts().find((x) => slug(x.name) === h)
  return host ? { host, name: p } : null
}

/** A project's folder on its host, as a shell path. */
export function remoteDir(host: Host, project: string): string {
  return `${host.root.replace(/\/+$/, '')}/${project}`
}

// ── Shell quoting ─────────────────────────────────────────────────────

/** Quote for a POSIX shell (only when needed). */
export function shQuote(s: string): string {
  if (s && /^[A-Za-z0-9\-_./=:,@%+]+$/.test(s)) return s
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** A path on the host as the shell should see it (a leading ~ expands). */
export function shellPath(p: string): string {
  if (p.startsWith('~/')) return `"$HOME"/${shQuote(p.slice(2))}`
  if (p === '~') return '"$HOME"'
  return shQuote(p)
}

// ── ssh ───────────────────────────────────────────────────────────────

/** Short: a socket path has a length limit. */
const controlPath = (): string => `${homedir()}/.ssh/panthr-%C`

const BASE_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10']

/** ssh's options to share one connection; never prompts (no TTY to ask on). */
function sshOpts(): string[] {
  return [...BASE_OPTS, '-o', 'ServerAliveInterval=15', '-o', 'ControlMaster=auto', '-o', `ControlPath=${controlPath()}`, '-o', 'ControlPersist=10m']
}

export function sshArgs(host: Host, ...command: string[]): string[] {
  return [...sshOpts(), host.target, ...command]
}

/** Run in the user's login shell on the host (their PATH: claude, codex, node). */
const loginShell = (script: string): string => `exec "$SHELL" -lc ${shQuote(script)}`

/** How to run `program args` in `dir` on the host: an ssh invocation whose
 *  first stdout line is `PANTHR_PID <pid>` (see pidLine). `exec` keeps the
 *  pid, so the program can be stopped by it. */
export function remoteCommand(host: Host, dir: string, program: string, args: string[]): { cmd: string; args: string[] } {
  const line = [program, ...args.map(shQuote)].join(' ')
  const d = shellPath(dir)
  const script = `mkdir -p ${d} && cd ${d} && echo PANTHR_PID $$ && exec ${line}`
  return { cmd: 'ssh', args: sshArgs(host, loginShell(script)) }
}

/** The pid from a `PANTHR_PID <pid>` line, else null. */
export function pidLine(line: string): number | null {
  const m = /^PANTHR_PID (\d+)\s*$/.exec(line)
  return m ? Number(m[1]) : null
}

interface Out {
  code: number | null
  stdout: Buffer
  stderr: string
}

/** Run a program to its end (with our PATH: a GUI app has none). */
function run(cmd: string, args: string[], input?: string | Buffer): Promise<Out> {
  return new Promise((res, rej) => {
    const c = spawn(cmd, args, { env: { ...process.env, PATH: pathEnv() }, stdio: ['pipe', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    const err: Buffer[] = []
    c.stdout.on('data', (b: Buffer) => out.push(b))
    c.stderr.on('data', (b: Buffer) => err.push(b))
    c.on('error', rej)
    c.on('close', (code) => res({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8') }))
    c.stdin.on('error', () => {}) // the far end may not read it all
    c.stdin.end(input ?? '')
  })
}

const lastLine = (s: string, fallback: string): string =>
  s.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? fallback

async function ensure(p: Promise<Out>, fallback: string): Promise<Out> {
  const o = await p
  if (o.code !== 0) throw new Error(lastLine(o.stderr, fallback))
  return o
}

/** Stop a program on the host (closing ssh does not end it). */
export function kill(host: Host, pid: number): void {
  run('ssh', sshArgs(host, `kill ${pid} 2>/dev/null; sleep 2; kill -9 ${pid} 2>/dev/null; true`)).catch(() => {})
}

// ── Syncing ───────────────────────────────────────────────────────────

/** Files that stay on each side: dependencies, renders (pulled on their
 *  own), and the skills links Panthr makes locally. */
const EXCLUDE = ['node_modules/', '.git/', '.studio/versions/', '.claude/skills/', '.agents/skills/']

/** The `-e` rsync takes to ride the same connection. */
const rsyncSsh = (): string =>
  `ssh -o BatchMode=yes -o ConnectTimeout=10 -o ControlMaster=auto -o ControlPath=${controlPath()} -o ControlPersist=10m`

function rsyncArgs(excludes = true): string[] {
  const a = ['-az', '-e', rsyncSsh()]
  if (excludes) for (const e of EXCLUDE) a.push('--exclude', e)
  return a
}

// The remote side of each rsync spec is shell-quoted: the host's shell
// reads it (macOS's openrsync cannot protect arguments), so a name with a
// space would split.
const remoteSpec = (host: Host, path: string): string => `${host.target}:${shellPath(path)}`
const makeThere = (path: string): string => `--rsync-path=mkdir -p ${shellPath(path)} && rsync`

/** One sync at a time per project. */
const locks = new Map<string, Promise<unknown>>()
function locked<T>(dir: string, f: () => Promise<T>): Promise<T> {
  const prev = locks.get(dir) ?? Promise.resolve()
  const next = prev.catch(() => {}).then(f)
  locks.set(dir, next)
  next.finally(() => locks.get(dir) === next && locks.delete(dir)).catch(() => {})
  return next
}

const rsync = (args: string[]): Promise<Out> => ensure(run('rsync', args), 'rsync failed')

/** Bring the host's notes on the project here (chats, comments, controls). */
export async function pull(dir: string): Promise<void> {
  const at = hostOf(dir)
  if (!at) return
  await locked(dir, async () => {
    mkdirSync(join(dir, '.studio'), { recursive: true })
    const there = `${remoteDir(at.host, at.name)}/.studio`
    await rsync([...rsyncArgs(), makeThere(there), `${remoteSpec(at.host, there)}/`, `${join(dir, '.studio')}/`])
  })
}

/** Send the notes made here (comments, drawings) to the host. */
export async function push(dir: string): Promise<void> {
  const at = hostOf(dir)
  if (!at) return
  await locked(dir, async () => {
    mkdirSync(join(dir, '.studio'), { recursive: true })
    const there = `${remoteDir(at.host, at.name)}/.studio`
    await rsync([...rsyncArgs(), makeThere(there), `${join(dir, '.studio')}/`, `${remoteSpec(at.host, there)}/`])
  })
}

/** A project made here goes over whole, once; then only its notes stay here. */
export async function pushAll(dir: string): Promise<void> {
  const at = hostOf(dir)
  if (!at) return
  await locked(dir, async () => {
    const there = remoteDir(at.host, at.name)
    await rsync([...rsyncArgs(), makeThere(there), `${dir}/`, `${remoteSpec(at.host, there)}/`])
    for (const e of readdirSync(dir)) {
      if (e !== '.studio') rmSync(join(dir, e), { recursive: true, force: true })
    }
  })
}

/** Bring one file from the project on the host here (a render). */
export async function fetch(dir: string, rel: string): Promise<void> {
  const at = hostOf(dir)
  if (!at) return
  const to = join(dir, rel)
  mkdirSync(dirname(to), { recursive: true })
  await rsync([...rsyncArgs(false), remoteSpec(at.host, `${remoteDir(at.host, at.name)}/${rel}`), to])
}

/** Bring a folder of the host's project here (snapshots). */
export async function fetchDir(dir: string, rel: string): Promise<void> {
  const at = hostOf(dir)
  if (!at) return
  const to = join(dir, rel)
  mkdirSync(to, { recursive: true })
  await rsync([...rsyncArgs(false), `${remoteSpec(at.host, `${remoteDir(at.host, at.name)}/${rel}`)}/`, `${to}/`])
}

/** Snapshot frames on the host into `rel` of the project there, and bring
 *  them here (the filmstrip, a frame to draw on). */
export async function snapshot(dir: string, at: string, rel: string): Promise<void> {
  const h = hostOf(dir)
  if (!h) throw new Error('not on a host')
  const args = ['HYPERFRAMES_NO_UPDATE_CHECK=1', 'npx', '--yes', 'hyperframes', 'snapshot', '.', '--no-end', '--at', at, '-o', rel]
  const c = remoteCommand(h.host, remoteDir(h.host, h.name), 'env', args)
  await ensure(run(c.cmd, c.args), 'snapshot failed')
  await fetchDir(dir, rel)
}

// ── The editor tool, on the host ──────────────────────────────────────

/** The parsers the editor tool needs (the same pin as here). */
export const PARSERS = '@hyperframes/parsers@0.8.73'

/** The tool's version marker: the same number the GPUI Panthr wrote, so a
 *  host set up by either is not set up again. */
export function toolVersion(tool: string): string {
  const M = (1n << 64n) - 1n
  const bytes = Buffer.from(tool, 'utf8')
  let a = 0n
  for (const b of bytes) a = (a * 131n + BigInt(b)) & M
  return ((BigInt(bytes.length) * 31n + a) & M).toString(16)
}

/** The editor tool (resources/edit.mjs) run on the host, on the files there.
 *  Put on the host once per version (in ~/.panthr/editor), then run. */
export async function edit(dir: string, req: Record<string, unknown>): Promise<any> {
  const at = hostOf(dir)
  if (!at) throw new Error('not on a host')
  const tool = readFileSync(resource('edit.mjs'), 'utf8')
  const ver = toolVersion(tool)
  const setup =
    `mkdir -p ~/.panthr/editor && cd ~/.panthr/editor && [ -f .v${ver} ] && exit 0; cat > edit.mjs && ` +
    `echo '{"name":"panthr-editor","private":true,"type":"module"}' > package.json && ` +
    `npm install --no-audit --no-fund --loglevel=error ${PARSERS} linkedom >/dev/null && touch .v${ver}`
  const put = await run('ssh', sshArgs(at.host, loginShell(setup)), tool)
  if (put.code !== 0) throw new Error(`could not set up the editor on ${at.host.name}: ${put.stderr.trim()}`)
  const line = `CLUESO_PROJECT=${shellPath(remoteDir(at.host, at.name))} node ~/.panthr/editor/edit.mjs /dev/stdin`
  const o = await run('ssh', sshArgs(at.host, loginShell(line)), JSON.stringify(req))
  try {
    return JSON.parse(o.stdout.toString('utf8'))
  } catch {
    throw new Error(o.stderr.trim() || 'the editor tool failed on the host')
  }
}

// ── The page, served from the host ────────────────────────────────────

/** A tiny file server for the project folder there, with one extra route:
 *  /__panthr/stamp, the newest change to the composition's files (the app
 *  polls it to reload). It ends when its SSH session does (stdin closes). */
export const SERVE_PY = `import http.server, os, sys, threading
port = int(sys.argv[1]); root = os.getcwd()
SKIP = {'node_modules', '.git', '.studio', 'renders', 'snapshots'}
def stamp():
    m = 0
    for d, ds, fs in os.walk(root):
        ds[:] = [x for x in ds if x not in SKIP and not x.startswith('.')]
        for f in fs:
            try: m = max(m, os.stat(os.path.join(d, f)).st_mtime_ns)
            except OSError: pass
    return m
class H(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store'); super().end_headers()
    def do_GET(self):
        if self.path.startswith('/__panthr/stamp'):
            b = str(stamp()).encode()
            self.send_response(200); self.send_header('Content-Type', 'text/plain'); self.send_header('Content-Length', str(len(b))); self.end_headers(); self.wfile.write(b)
            return
        return super().do_GET()
def bye():
    sys.stdin.read(); os._exit(0)
threading.Thread(target=bye, daemon=True).start()
try:
    s = http.server.ThreadingHTTPServer(('127.0.0.1', port), H)
except OSError:
    print('PANTHR_BUSY', flush=True); sys.exit(3)
print('PANTHR_READY', flush=True)
s.serve_forever()
`

interface Live {
  port: number
  child: ChildProcess
}

function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer()
    s.on('error', rej)
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => res(port))
    })
  })
}

/** The first stdout line of a child, or null when it ends first. */
function firstLine(c: ChildProcess, timeoutMs: number): Promise<string | null> {
  return new Promise((res) => {
    let buf = ''
    const done = (v: string | null): void => {
      clearTimeout(t)
      c.stdout!.off('data', onData)
      c.off('close', onClose)
      // Keep reading so the pipe never fills.
      c.stdout!.resume()
      res(v)
    }
    const onData = (b: Buffer): void => {
      buf += b.toString('utf8')
      const i = buf.indexOf('\n')
      if (i >= 0) done(buf.slice(0, i))
    }
    const onClose = (): void => done(null)
    const t = setTimeout(() => done(null), timeoutMs)
    c.stdout!.on('data', onData)
    c.on('close', onClose)
  })
}

/** Serve a project's folder on its host, tunnelled to a port here. */
async function serve(host: Host, project: string): Promise<Live> {
  // The server script, put on the host (small; each time is fine).
  await ensure(run('ssh', sshArgs(host, 'mkdir -p ~/.panthr && cat > ~/.panthr/serve.py'), SERVE_PY), `could not set up the preview on ${host.name}`)
  const dir = remoteDir(host, project)
  for (let i = 0; i < 4; i++) {
    // The same port number on both ends (free here; tried there).
    const port = await freePort()
    const script = `cd ${shellPath(dir)} && exec python3 -u ~/.panthr/serve.py ${port}`
    const args = [
      ...BASE_OPTS, '-o', 'ServerAliveInterval=15', '-o', 'ExitOnForwardFailure=yes',
      // Its own connection: the tunnel lives and dies with this process.
      '-o', 'ControlMaster=no', '-o', 'ControlPath=none',
      '-L', `${port}:127.0.0.1:${port}`,
      host.target, loginShell(script)
    ]
    const child = spawn('ssh', args, { env: { ...process.env, PATH: pathEnv() }, stdio: ['pipe', 'pipe', 'pipe'] })
    let err = ''
    child.stderr!.on('data', (b: Buffer) => (err += b.toString('utf8')))
    child.on('error', (e) => (err += String(e)))
    child.stdin!.on('error', () => {})
    const line = await firstLine(child, 30_000)
    if (line?.includes('PANTHR_READY')) return { port, child }
    child.kill()
    if (line?.includes('PANTHR_BUSY')) continue
    throw new Error(lastLine(err, 'the preview server did not start (is python3 on the host?)'))
  }
  throw new Error('no free port for the preview')
}

const live = new Map<string, Live>()
const starting = new Map<string, Promise<number | null>>()
/** The last failure per project, and when (not retried on every request). */
const failed = new Map<string, { at: number; error: string }>()
const RETRY_MS = 5000

/** The page server on the host, reached here at the returned port (started
 *  on first use, kept while the project is open). Null: not on a host, or
 *  the host could not be reached (see liveError). */
export async function livePort(dir: string): Promise<number | null> {
  const l = live.get(dir)
  if (l && l.child.exitCode === null && l.child.signalCode === null) return l.port
  const pending = starting.get(dir)
  if (pending) return pending
  const at = hostOf(dir)
  if (!at) return null
  const f = failed.get(dir)
  if (f && Date.now() - f.at < RETRY_MS) return null
  const p = serve(at.host, at.name)
    .then((s) => {
      live.set(dir, s)
      failed.delete(dir)
      s.child.on('close', () => live.get(dir) === s && live.delete(dir))
      return s.port
    })
    .catch((e: Error) => {
      failed.set(dir, { at: Date.now(), error: e.message })
      return null
    })
    .finally(() => starting.delete(dir))
  starting.set(dir, p)
  return p
}

/** Why the page could not be served from the host, if it could not. */
export function liveError(dir: string): string | null {
  return failed.get(dir)?.error ?? null
}

export function stopLive(dir?: string): void {
  for (const [d, l] of [...live]) {
    if (dir !== undefined && d !== dir) continue
    live.delete(d)
    l.child.kill()
  }
  if (dir === undefined) failed.clear()
  else failed.delete(dir)
}
process.on('exit', () => stopLive())

/** Stop serving every project under a folder (a host's mirrors). */
export function stopLiveUnder(folder: string): void {
  for (const d of [...live.keys()]) if (d.startsWith(folder + sep)) stopLive(d)
}

/** GET through the tunnel. */
export async function httpGet(port: number, path: string): Promise<{ status: number; type: string; body: Buffer }> {
  const r = await globalThis.fetch(`http://127.0.0.1:${port}/${path.replace(/^\/+/, '')}`, { signal: AbortSignal.timeout(20_000) })
  return { status: r.status, type: r.headers.get('content-type') ?? '', body: Buffer.from(await r.arrayBuffer()) }
}

/** The newest change to the composition's files on the host (null: not
 *  served). Polled to reload the preview when it moves. */
export async function liveStamp(dir: string): Promise<string | null> {
  const port = await livePort(dir)
  if (!port) return null
  try {
    const r = await httpGet(port, '/__panthr/stamp')
    return r.status === 200 ? r.body.toString('utf8') : null
  } catch {
    return null
  }
}

// ── Listing and checking ──────────────────────────────────────────────

/** The project names on a host (folders with an index.html). */
export async function list(host: Host): Promise<string[]> {
  const script = `cd ${shellPath(host.root)} 2>/dev/null && for d in */; do [ -f "$d/index.html" ] && printf '%s\\n' "\${d%/}"; done; true`
  const o = await run('ssh', sshArgs(host, script))
  if (o.code !== 0) throw new Error(o.stderr.trim() || `could not reach ${host.name}`)
  return o.stdout.toString('utf8').split('\n').filter(Boolean)
}

const TOOLS = ['claude', 'codex', 'node', 'npx', 'python3', 'rsync', 'ffmpeg']

/** What a host has, for Settings: can we reach it, and its tools. */
export async function check(host: Host): Promise<HostCheck> {
  const probe = TOOLS.map((t) => `command -v ${t} >/dev/null && echo has:${t}`).join('; ')
  try {
    const o = await run('ssh', sshArgs(host, loginShell(`echo panthr-ok; ${probe}; true`)))
    const s = o.stdout.toString('utf8')
    if (!s.includes('panthr-ok')) return { ok: false, error: lastLine(o.stderr, 'could not connect'), tools: [] }
    const has = new Set(s.split('\n').map((l) => l.trim()))
    return { ok: true, error: null, tools: TOOLS.map((t) => [t, has.has(`has:${t}`)]) }
  } catch (e) {
    return { ok: false, error: (e as Error).message, tools: [] }
  }
}
