// The control socket: how the `panthr` command line drives the app.
//
// A Unix socket in the data folder (only this user can open it). Each
// line is one JSON message:
//   → {"id": 1, "method": "projects.list", "params": []}
//   ← {"id": 1, "result": [...]}            or {"id": 1, "error": "..."}
//   → {"id": 2, "method": "subscribe", "params": ["chat:state", "job"]}
//   ← {"event": "chat:state", "payload": {...}}   (as they happen)
// Methods are the window's own API ("<namespace>.<method>") plus a few
// for the window itself ("ui.*"), so the CLI can do what a person can.

import { chmodSync, existsSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

/** The socket for a data folder. A Unix socket path is capped (~104
 *  bytes on macOS), so a long folder gets a short stand-in in /tmp, named
 *  by a hash of it; resources/cli/panthr.mjs works it out the same way. */
export function socketPath(dataDir: string): string {
  const p = join(dataDir, 'panthr.sock')
  if (Buffer.byteLength(p) <= 100) return p
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0
  return `/tmp/panthr-${uid}-${createHash('sha1').update(dataDir).digest('hex').slice(0, 12)}.sock`
}

export type Dispatch = (method: string, params: unknown[]) => Promise<unknown>

interface Client {
  sock: Socket
  events: Set<string>
}

const clients = new Set<Client>()

/** Hand an app event to every client that asked for it. */
export function forward(event: string, payload: unknown): void {
  for (const c of clients) {
    if (c.events.has(event) || c.events.has('*')) write(c.sock, { event, payload })
  }
}

function write(sock: Socket, msg: unknown): void {
  if (!sock.destroyed) sock.write(JSON.stringify(msg) + '\n')
}

export function startControl(path: string, dispatch: Dispatch): Server {
  // A socket left by an app that did not close cleanly.
  if (existsSync(path)) rmSync(path, { force: true })
  const server = createServer((sock) => {
    const c: Client = { sock, events: new Set() }
    clients.add(c)
    let buf = ''
    sock.setEncoding('utf8')
    sock.on('data', (chunk: string) => {
      buf += chunk
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (line) handle(c, line, dispatch)
      }
    })
    sock.on('close', () => clients.delete(c))
    sock.on('error', () => clients.delete(c))
  })
  // Without it the command line is unavailable; the app itself is fine.
  server.on('error', (e) => console.error(`control socket: ${e.message}`))
  server.listen(path, () => {
    try {
      chmodSync(path, 0o600)
    } catch {}
  })
  return server
}

async function handle(c: Client, line: string, dispatch: Dispatch): Promise<void> {
  let msg: { id?: unknown; method?: unknown; params?: unknown }
  try {
    msg = JSON.parse(line)
  } catch {
    return write(c.sock, { error: 'not JSON' })
  }
  const id = msg.id ?? null
  const method = typeof msg.method === 'string' ? msg.method : ''
  const params = Array.isArray(msg.params) ? msg.params : []
  if (method === 'subscribe') {
    for (const e of params) if (typeof e === 'string') c.events.add(e)
    return write(c.sock, { id, result: [...c.events] })
  }
  try {
    write(c.sock, { id, result: (await dispatch(method, params)) ?? null })
  } catch (e) {
    write(c.sock, { id, error: e instanceof Error ? e.message : String(e) })
  }
}
