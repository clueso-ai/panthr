// The preview: a project's page in an iframe, served over panthr://.
//
//   panthr://p-<id>/index.html   the project's files (each project its own
//                                origin), with the HyperFrames runtime, the
//                                picker and Panthr's bridge put in its <head>
//   panthr://file/<abs path>     a file the window shows (frames, posters,
//                                versions, library items), byte ranges too
//
// A project on a host is fetched from its server there, through the tunnel.

import { createHash } from 'node:crypto'
import { createReadStream, readFileSync, statSync } from 'node:fs'
import { extname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { protocol } from 'electron'
import { dataDir, resource, studioRoot } from './paths'

export const SCHEME = 'panthr'

/** Call before the app is ready. */
export function registerScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }
  ])
}

const projects = new Map<string, string>()
/** Folders the window may load files from (projects opened from elsewhere). */
const allowed = new Set<string>()

export function projectId(dir: string): string {
  const id = 'p-' + createHash('sha1').update(dir).digest('hex').slice(0, 16)
  projects.set(id, dir)
  allowed.add(resolve(dir))
  return id
}

export const previewUrl = (dir: string): string => `${SCHEME}://${projectId(dir)}/index.html`

export function fileUrl(path: string): string {
  return `${SCHEME}://file${path.split(sep).map(encodeURIComponent).join('/')}`
}

/** Where a project on a host is served here (its tunnel's port); set by hosts.ts. */
let remotePort: (dir: string) => Promise<number | null> = async () => null
export function setRemotePort(f: (dir: string) => Promise<number | null>): void {
  remotePort = f
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf'
}
export const mime = (p: string): string => MIME[extname(p).toLowerCase()] ?? 'application/octet-stream'

const HEADERS = { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }

let cache: { runtime: string; bridge: string; picker: string } | null = null
function assets() {
  cache ??= {
    runtime: readFileSync(resource('hyperframe.runtime.iife.js'), 'utf8'),
    bridge: readFileSync(resource('bridge.js'), 'utf8'),
    picker: readFileSync(resource('picker.html'), 'utf8')
  }
  return cache
}

/** The runtime (unless the page brings its own), the bridge and the picker
 *  go at the top of <head>, before the composition's own scripts: a
 *  timeline registers on the runtime's `__timelines`. */
export function inject(html: string): string {
  const own = html.includes('hyperframe.runtime') || html.includes('__studio/runtime.js')
  const tag = `${own ? '' : '<script src="/__panthr/runtime.js"></script>'}<script src="/__panthr/bridge.js"></script>${assets().picker}`
  const m = /<head[^>]*>/i.exec(html)
  return m ? html.slice(0, m.index + m[0].length) + tag + html.slice(m.index + m[0].length) : tag + html
}

function ok(type: string, body: BodyInit, extra: Record<string, string> = {}, status = 200): Response {
  return new Response(body, { status, headers: { 'Content-Type': type, ...HEADERS, ...extra } })
}

const fail = (status: number): Response => new Response(null, { status, headers: HEADERS })

/** A file from disk, with byte ranges (video seeking needs them). */
function sendFile(path: string, req: Request): Response {
  let st
  try {
    st = statSync(path)
  } catch {
    return fail(404)
  }
  if (!st.isFile()) return fail(404)
  const type = mime(path)
  if (type.startsWith('text/html')) return ok(type, inject(readFileSync(path, 'utf8')))
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') ?? '')
  if (range && (range[1] || range[2])) {
    let start = range[1] ? +range[1] : st.size - +range[2]
    let end = range[1] && range[2] ? +range[2] : st.size - 1
    start = Math.max(0, start)
    end = Math.min(end, st.size - 1)
    if (start > end) return fail(416)
    const body = Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream
    return ok(type, body, { 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1) }, 206)
  }
  const body = Readable.toWeb(createReadStream(path)) as ReadableStream
  return ok(type, body, { 'Accept-Ranges': 'bytes', 'Content-Length': String(st.size) })
}

/** Only plain names under the folder: no `..`, no absolute path. */
function under(root: string, rel: string): string | null {
  const decoded = decodeURIComponent(rel)
  if (isAbsolute(decoded) || normalize(decoded).split(sep).includes('..')) return null
  const full = resolve(root, decoded)
  return full === resolve(root) || full.startsWith(resolve(root) + sep) ? full : null
}

function mayRead(path: string): boolean {
  const roots = [studioRoot(), dataDir(), ...allowed]
  const p = resolve(path)
  return roots.some((r) => p === resolve(r) || p.startsWith(resolve(r) + sep))
}

async function serveProject(dir: string, path: string, req: Request): Promise<Response> {
  if (path === '__panthr/runtime.js' || path === '__studio/runtime.js') return ok(MIME['.js'], assets().runtime)
  if (path === '__panthr/bridge.js') return ok(MIME['.js'], assets().bridge)
  const port = await remotePort(dir)
  if (port) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/${path}`)
      if (!r.ok) return fail(r.status)
      const type = r.headers.get('content-type') || mime(path)
      return type.startsWith('text/html') ? ok(type, inject(await r.text())) : ok(type, await r.arrayBuffer())
    } catch {
      return fail(502)
    }
  }
  const full = under(dir, path || 'index.html')
  return full ? sendFile(full, req) : fail(403)
}

export function handleProtocol(): void {
  protocol.handle(SCHEME, async (req) => {
    const url = new URL(req.url)
    const path = url.pathname.replace(/^\/+/, '')
    if (url.hostname === 'file') {
      const full = decodeURIComponent(url.pathname)
      return mayRead(full) ? sendFile(full, req) : fail(403)
    }
    const dir = projects.get(url.hostname)
    if (!dir) return fail(404)
    return serveProject(dir, path || 'index.html', req)
  })
}

export const _test = { inject, under, join }
