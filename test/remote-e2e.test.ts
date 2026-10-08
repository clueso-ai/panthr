// End to end against a stand-in host: an `ssh` on PATH that drops its
// options and target and runs the command here (the tunnel is a no-op: the
// same machine). HOME points at a temp folder so ~/.panthr and the
// ControlPath stay out of the real home. Paths with spaces on both sides,
// for the rsync remote-side quoting.
//
// The editor tool needs npm (the network): run with PANTHR_TEST_NETWORK=1.
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: undefined, BrowserWindow: { getAllWindows: () => [] }, protocol: {} }))

const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'panthr-e2e-')))
const bin = join(tmp, 'bin')
mkdirSync(bin)
writeFileSync(
  join(bin, 'ssh'),
  `#!/bin/bash
while [ $# -gt 0 ]; do case "$1" in -o|-p|-i|-l|-F|-e|-L) shift 2;; -*) shift;; *) break;; esac; done
shift
exec /bin/sh -c "$*"
`
)
chmodSync(join(bin, 'ssh'), 0o755)
const saved = { HOME: process.env.HOME, PATH: process.env.PATH, SHELL: process.env.SHELL }
process.env.HOME = join(tmp, 'home')
process.env.SHELL = '/bin/bash'
process.env.PATH = `${bin}:${process.env.PATH}`
process.env.PANTHR_DATA_DIR = join(tmp, 'data')
process.env.PANTHR_HOSTS_FILE = join(tmp, 'data', 'hosts.json')
process.env.PANTHR_MIRRORS = join(tmp, 'data', 'Remote')
mkdirSync(process.env.HOME, { recursive: true })

const remote = await import('../src/main/remote')
const { hosts: hostsApi } = await import('../src/main/hosts')

const root = join(tmp, 'host root')
const host = { name: 'Test host', target: 'fake', root }
const name = 'Remote test'
const there = join(root, name)
let dir: string

beforeAll(() => {
  remote.saveHosts([host])
  dir = remote.mirrorOf(host, name)
  mkdirSync(join(dir, '.studio'), { recursive: true })
  writeFileSync(join(dir, 'index.html'), '<html><head></head><body>hi</body></html>')
  writeFileSync(join(dir, '.studio/project.json'), JSON.stringify({ name, created_at: 1, chats: [], agents_enabled: true, models: {} }))
})

afterAll(() => {
  remote.stopLive()
  Object.assign(process.env, saved)
  rmSync(tmp, { recursive: true, force: true })
})

it('checks the host and its tools', async () => {
  const c = await remote.check(host)
  expect(c.ok).toBe(true)
  expect(c.tools.find(([t]) => t === 'python3')?.[1]).toBe(true)
  expect(c.tools.find(([t]) => t === 'rsync')?.[1]).toBe(true)
})

it('sends a new project over whole, keeping only its notes here', async () => {
  expect(remote.hostOf(dir)?.name).toBe(name)
  await remote.pushAll(dir)
  expect(readdirSync(dir)).toEqual(['.studio'])
  expect(readFileSync(join(there, 'index.html'), 'utf8')).toContain('hi')
  expect(existsSync(join(there, '.studio/project.json'))).toBe(true)
  expect(await remote.list(host)).toEqual([name])
})

it('runs a command there, pid first', async () => {
  const c = remote.remoteCommand(host, remote.remoteDir(host, name), 'sh', ['-c', 'echo it is $(basename "$(pwd)")'])
  const out = await new Promise<string>((res) => {
    let s = ''
    const p = spawn(c.cmd, c.args)
    p.stdout.on('data', (b) => (s += b))
    p.on('close', () => res(s))
  })
  const [first, second] = out.trim().split('\n')
  expect(remote.pidLine(first)).toBeGreaterThan(0)
  expect(second).toBe(`it is ${name}`)
})

it('serves the page there through the tunnel, and its stamp moves', async () => {
  const port = await remote.livePort(dir)
  expect(port).toBeGreaterThan(0)
  expect(await remote.livePort(dir)).toBe(port) // kept
  const page = await remote.httpGet(port!, '/index.html')
  expect(page.status).toBe(200)
  expect(page.type).toContain('text/html')
  expect(page.body.toString()).toContain('hi')
  const s1 = await remote.liveStamp(dir)
  await new Promise((r) => setTimeout(r, 20))
  writeFileSync(join(there, 'hello.txt'), 'hello')
  const s2 = await remote.liveStamp(dir)
  expect(s1).not.toBeNull()
  expect(s2).not.toBe(s1)
  expect((await remote.httpGet(port!, '/hello.txt')).body.toString()).toBe('hello')
  remote.stopLive(dir)
  await new Promise((r) => setTimeout(r, 200))
  await expect(remote.httpGet(port!, '/index.html')).rejects.toThrow()
})

it('pulls and pushes notes, fetches files and folders', async () => {
  writeFileSync(join(there, '.studio/comments.json'), '[1]')
  await remote.pull(dir)
  expect(readFileSync(join(dir, '.studio/comments.json'), 'utf8')).toBe('[1]')
  writeFileSync(join(dir, '.studio/drawing.json'), '{}')
  await remote.push(dir)
  expect(existsSync(join(there, '.studio/drawing.json'))).toBe(true)
  // Only .studio comes back with a pull.
  expect(existsSync(join(dir, 'hello.txt'))).toBe(false)
  mkdirSync(join(there, 'renders'), { recursive: true })
  writeFileSync(join(there, 'renders/out file.mp4'), 'mp4')
  await remote.fetch(dir, 'renders/out file.mp4')
  expect(readFileSync(join(dir, 'renders/out file.mp4'), 'utf8')).toBe('mp4')
  mkdirSync(join(there, 'snapshots/a b'), { recursive: true })
  writeFileSync(join(there, 'snapshots/a b/f1.png'), 'png')
  await remote.fetchDir(dir, 'snapshots/a b')
  expect(readFileSync(join(dir, 'snapshots/a b/f1.png'), 'utf8')).toBe('png')
})

it('refreshes a host: its projects, notes pulled into mirrors', async () => {
  mkdirSync(join(root, 'Other'), { recursive: true })
  writeFileSync(join(root, 'Other/index.html'), '')
  mkdirSync(join(root, 'not a project'), { recursive: true })
  const ps = await hostsApi.refresh('Test host')
  expect(ps.map((p) => p.meta.name).sort()).toEqual(['Other', name])
  const other = ps.find((p) => p.meta.name === 'Other')!
  expect(other.host).toBe('Test host')
  expect(other.dir).toBe(remote.mirrorOf(host, 'Other'))
  expect(existsSync(join(other.dir, '.studio'))).toBe(true)
  expect(ps.find((p) => p.meta.name === name)!.meta.created_at).toBe(1)
})

it.runIf(!!process.env.PANTHR_TEST_NETWORK)('runs the editor tool there', async () => {
  const v = await remote.edit(dir, { op: 'inspect' })
  expect(Array.isArray(v.files)).toBe(true)
}, 300_000)
