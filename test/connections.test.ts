// Connections end to end: a real Panthr server (the build in out/server)
// started as a second machine, used through the same router and file proxy
// the window uses. Its projects come back under /@<id>, merged into the
// lists; calls about them go there; its pages load through the proxy; its
// events arrive in our names; and removing it stops it.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: undefined, protocol: { registerSchemesAsPrivileged() {}, handle() {} }, nativeTheme: {}, BrowserWindow: { getAllWindows: () => [] } }))
const emitted: [string, any][] = []
vi.mock('../src/main/bus', () => ({ emit: (n: string, p: any) => emitted.push([n, p]) }))

import { connectionOf, connectionsApi, proxy, route, toLocal, toRemote } from '../src/main/connections'

let tmp = ''
let id = ''
const none = async (): Promise<unknown> => []
const until = async (f: () => Promise<boolean> | boolean, ms = 20000): Promise<void> => {
  const end = Date.now() + ms
  while (!(await f())) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 100))
  }
}

beforeAll(() => {
  execFileSync('npx', ['vite', 'build', '-c', 'vite.server.config.ts', '--logLevel', 'silent'], { stdio: 'inherit' })
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'panthr-conn-')))
  process.env.PANTHR_DATA_DIR = join(tmp, 'here')
  process.env.PANTHR_ROOT = join(tmp, 'here-root')
  process.env.PANTHR_NO_SEED = '1'
  mkdirSync(process.env.PANTHR_DATA_DIR, { recursive: true })
}, 60000)

afterAll(async () => {
  if (id) await connectionsApi.remove(id)
})

describe('names, both ways', () => {
  const h = { home: '/home/me', root: '/home/me/Panthr', dataDir: '/home/me/.panthr/data', tmp: '/tmp' }
  it('rewrites paths and URLs, and only theirs', () => {
    const v = toLocal({ dir: '/home/me/Panthr/A', url: 'panthr://p-1/index.html', other: '/usr/bin/x', note: 'a /home/me path', tiles: { '/home/me/Panthr/A/v': { x: 1 } } }, 'abc123', h) as any
    expect(v).toEqual({ dir: '/@abc123/home/me/Panthr/A', url: 'panthr://x-abc123-p-1/index.html', other: '/usr/bin/x', note: 'a /home/me path', tiles: { '/@abc123/home/me/Panthr/A/v': { x: 1 } } })
    expect(toRemote(v, 'abc123')).toEqual({ dir: '/home/me/Panthr/A', url: 'panthr://p-1/index.html', other: '/usr/bin/x', note: 'a /home/me path', tiles: { '/home/me/Panthr/A/v': { x: 1 } } })
    expect(connectionOf(['x', { a: ['/@abc123/home/me/Panthr/A'] }])).toBe('abc123')
    expect(connectionOf(['/Users/me/Panthr/A'])).toBeNull()
  })
})

describe('a second machine', () => {
  it('connects, and its projects join ours', async () => {
    const s = await connectionsApi.save({ label: 'Second', kind: 'command', target: '', root: join(tmp, 'far-root'), enabled: true, dataDir: join(tmp, 'far-data') })
    id = s.id
    await until(async () => (await connectionsApi.list())[0].phase === 'connected')
    const st = (await connectionsApi.list())[0]
    expect(st.machine?.version).toBeTruthy()

    const c = (await route('canvases.create', ['Far Project', id], none)) as any
    expect(c.dir).toBe(`/@${id}${join(tmp, 'far-root', 'Far Project')}`)
    const all = (await route('canvases.list', [], async () => [{ dir: '/here/Mine', name: 'Mine', host: null }])) as any[]
    expect(all.map((x) => [x.name, x.host])).toEqual([['Mine', null], ['Far Project', 'Second']])

    // A call about its project goes there, and comes back in our names.
    const v = (await route('board.create', [c.dir, 'Teaser', null, null], none)) as any
    expect(v.dir.startsWith(`/@${id}/`)).toBe(true)
    const b = (await route('board.get', [c.dir], none)) as any
    expect(Object.keys(b.tiles)).toContain(v.dir)
    // Its events too.
    await until(() => emitted.some(([n, p]) => n === 'board:changed' && JSON.stringify(p).includes(`/@${id}/`)))
  }, 40000)

  it('serves its pages through the proxy', async () => {
    const all = (await route('canvases.list', [], none)) as any[]
    const far = all.find((x) => x.name === 'Far Project')
    const b = (await route('board.get', [far.dir], none)) as any
    const video = Object.keys(b.tiles)[0]
    const url = (await route('projects.previewUrl', [video], none)) as string
    expect(url).toMatch(new RegExp(`^panthr://x-${id}-p-[0-9a-f]+/index.html$`))
    const r = await proxy(new URL(url), new Request(url))
    expect(r.status).toBe(200)
    expect(await r.text()).toContain('/__panthr/bridge.js')
    const bad = await proxy(new URL(`panthr://x-${id}-file/etc/passwd`), new Request('panthr://x/etc/passwd'))
    expect(bad.status).toBe(403)
  }, 20000)

  it('goes offline when switched off, and its projects leave the lists', async () => {
    await connectionsApi.setEnabled(id, false)
    expect((await connectionsApi.list())[0].phase).toBe('off')
    expect(((await route('canvases.list', [], none)) as any[]).length).toBe(0)
    await expect(route('board.get', [`/@${id}/x`], none)).rejects.toThrow('not connected')
    await connectionsApi.setEnabled(id, true)
    await until(async () => (await connectionsApi.list())[0].phase === 'connected')
  }, 30000)
})
