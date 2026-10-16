// Panther's server, for using another machine from a Mac (see
// src/main/connections.ts). Two modes:
//
//   server.cjs --daemon   the server: the API on the control socket (as the
//                         app's own, so the agents' `panthr` works here too),
//                         and files and previews over HTTP on a Unix socket
//                         (<data>/http.sock). It outlives the connection.
//   server.cjs --bridge   what ssh runs: starts the daemon if it is not
//                         running (or is another build), then joins this
//                         process's stdin and stdout to its control socket.
//
// Data: $PANTHR_DATA_DIR, else ~/.panthr/data. Projects: $PANTHR_ROOT, else ~/Panthr.

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { createServer as createHttp } from 'node:http'
import { homedir, hostname, platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

process.env.PANTHR_DATA_DIR ||= join(homedir(), '.panthr', 'data')
const DATA = process.env.PANTHR_DATA_DIR
const BUILD = process.env.PANTHR_BUILD || 'dev'
const PROTOCOL = 1

async function daemon(): Promise<void> {
  // Anything printed goes to the log, never into the channel.
  console.log = console.error
  console.info = console.error
  const { protocolHandler } = await import('./electron')
  const { socketPath, startControl } = await import('../main/control')
  const { local } = await import('../main/handlers')
  const { handleProtocol } = await import('../main/preview')
  const { emit } = await import('../main/bus')
  const { dataDir, studioRoot, writeAgentCli } = await import('../main/paths')
  const { seedSkills } = await import('../main/skills')
  const { stopAll } = await import('../main/chats')
  const { stopAllReferences } = await import('../main/references')

  mkdirSync(DATA, { recursive: true })
  mkdirSync(studioRoot(), { recursive: true })
  writeAgentCli()
  handleProtocol()
  // The default skills, once (not in a test).
  if (!process.env.PANTHR_NO_SEED) seedSkills()

  const envFile = join(dataDir(), 'environment.json')
  let id: string
  try {
    id = JSON.parse(readFileSync(envFile, 'utf8')).id
  } catch {
    id = randomUUID()
    writeFileSync(envFile, JSON.stringify({ id }))
  }

  const quit = (): void => {
    stopAll()
    stopAllReferences()
    setTimeout(() => process.exit(0), 300)
  }

  const dispatch = async (method: string, params: unknown[]): Promise<unknown> => {
    switch (method) {
      case 'env.hello':
        // Each folder as given and as it really is (/tmp is /private/tmp on a Mac): paths come back either way.
        return { id, hostname: hostname(), platform: platform(), version: BUILD, protocol: PROTOCOL, home: homedir(), root: studioRoot(), dataDir: dataDir(), tmp: tmpdir(), roots: [...new Set([studioRoot(), dataDir(), homedir(), tmpdir()].flatMap((p) => [p, real(p)]))] }
      case 'env.shutdown':
        setTimeout(quit, 50)
        return true
      // What the agents' `panthr` asks of the window: the Mac's window is
      // the one listening, so these become events for it.
      case 'ui.status':
        return { version: BUILD, window: false, visible: false, working: false, state: {} }
      case 'ui.open':
        emit('open', { dir: String(params[0]), first: typeof params[1] === 'string' ? params[1] : null })
        return true
      case 'ui.command':
        return true
    }
    return local(method, params)
  }
  startControl(socketPath(dataDir()), dispatch)

  // Files and previews: the panthr:// handler, over HTTP on a Unix socket.
  const httpSock = join(dataDir(), 'http.sock')
  rmSync(httpSock, { force: true })
  createHttp(async (req, res) => {
    const h = protocolHandler()
    const m = /^\/([^/]+)(\/.*)?$/.exec(req.url || '/')
    if (!h || !m) {
      res.writeHead(404).end()
      return
    }
    const headers = new Headers()
    if (typeof req.headers.range === 'string') headers.set('range', req.headers.range)
    try {
      const r = await h(new Request(`panthr://${m[1]}${m[2] || '/'}`, { headers }))
      const out: Record<string, string> = {}
      r.headers.forEach((v, k) => (out[k] = v))
      res.writeHead(r.status, out)
      if (r.body) Readable.fromWeb(r.body as any).pipe(res)
      else res.end()
    } catch {
      res.writeHead(500).end()
    }
  }).listen(httpSock)

  process.on('SIGTERM', quit)
  process.on('SIGINT', quit)
  console.error(`panthr server ${BUILD} on ${hostname()}: ${socketPath(dataDir())}`)
}

const real = (p: string): string => {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/** The daemon's control socket, connected (null: nothing there). */
function reach(path: string): Promise<Socket | null> {
  return new Promise((ok) => {
    const s = connect(path)
    s.once('connect', () => ok(s))
    s.once('error', () => ok(null))
  })
}

/** One request on a fresh connection, and its answer. */
async function ask(path: string, method: string): Promise<any> {
  const s = await reach(path)
  if (!s) return null
  return new Promise((ok) => {
    let buf = ''
    s.setEncoding('utf8')
    s.on('data', (c: string) => {
      buf += c
      const nl = buf.indexOf('\n')
      if (nl >= 0) {
        s.end()
        try {
          ok(JSON.parse(buf.slice(0, nl)).result ?? null)
        } catch {
          ok(null)
        }
      }
    })
    s.on('error', () => ok(null))
    s.on('close', () => ok(null))
    s.write(JSON.stringify({ id: 1, method, params: [] }) + '\n')
  })
}

async function bridge(): Promise<void> {
  const { socketPath } = await import('../main/control')
  mkdirSync(DATA, { recursive: true })
  const path = socketPath(DATA)
  // Another build running there (Panther was updated): it makes way.
  const hello = await ask(path, 'env.hello')
  if (hello && hello.version !== BUILD) {
    await ask(path, 'env.shutdown')
    for (let i = 0; i < 40 && (await reach(path).then((s) => (s?.end(), !!s))); i++) await new Promise((r) => setTimeout(r, 100))
  }
  let sock = await reach(path)
  if (!sock) {
    const log = openSync(join(DATA, 'server.log'), 'a')
    spawn(process.execPath, [process.argv[1], '--daemon'], { detached: true, stdio: ['ignore', log, log], env: process.env }).unref()
    for (let i = 0; i < 100 && !sock; i++) {
      await new Promise((r) => setTimeout(r, 100))
      sock = await reach(path)
    }
  }
  if (!sock) {
    console.error('Panther could not start its server (see ~/.panthr/data/server.log)')
    process.exit(1)
  }
  process.stdin.pipe(sock)
  sock.pipe(process.stdout)
  sock.on('close', () => process.exit(0))
  process.stdin.on('end', () => sock!.end())
}

const mode = process.argv.includes('--daemon') ? daemon : bridge
mode().catch((e) => {
  console.error(e)
  process.exit(1)
})
