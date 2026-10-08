// The command line against the control socket, with a stand-in app behind it.

import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Server } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { forward, startControl } from '../src/main/control'

const CLI = resolve('resources/cli/panthr.mjs')
let data: string
let server: Server
const comments: any[] = []
let settings: Record<string, unknown> = { agent: 'claude', model: 'default', skimming: true, export_fps: 30 }
const project = { dir: '/p/Demo', host: null, edited_at: 0, thumb: null, meta: { name: 'Demo', created_at: 1, chats: [{ id: 'c1', title: 'x', created_at: 1 }], agents_enabled: true, models: {} } }
let items: any[] = []

async function dispatch(method: string, params: any[]): Promise<unknown> {
  switch (method) {
    case 'ui.status': return { version: '0.2.0', working: false, state: { project: '/p/Demo', home: false } }
    case 'projects.list': return [project]
    case 'projects.load': return params[0] === '/p/Demo' ? project : null
    case 'review.comments': return comments
    case 'review.saveComments': comments.splice(0, comments.length, ...params[1]); return null
    case 'settings.get': return settings
    case 'settings.set': settings = { ...settings, ...params[0] }; return settings
    case 'chats.open': return { dir: '/p/Demo', chatId: 'c1', items, working: false }
    case 'chats.send': {
      // The agent: works a moment, streams a reply, ends the turn.
      items = [...items, { User: params[2] }]
      const st = (working: boolean) => forward('chat:state', { dir: '/p/Demo', chatId: 'c1', items, working })
      setTimeout(() => { items = [...items, { Steps: [{ id: 's', name: 'Edit', summary: 'Edited index.html', done: true }] }]; st(true) }, 20)
      setTimeout(() => { items = [...items, { Text: 'Made the ' }]; st(true) }, 40)
      setTimeout(() => { items[items.length - 1] = { Text: 'Made the title bigger.' }; st(true) }, 60)
      setTimeout(() => { items = [...items, { Meta: { cost_usd: 0.12, seconds: 4, error: false } }]; st(false) }, 80)
      return null
    }
    case 'review.render':
      setTimeout(() => forward('job', { type: 'progress', dir: '/p/Demo', percent: 50 }), 20)
      setTimeout(() => forward('job', { type: 'rendered', dir: '/p/Demo', version: { n: 3, file: 'v3.mp4', created_at: 1, bytes: 1, render_seconds: 1, duration: 6 } }), 40)
      return null
  }
  throw new Error(`no such method: ${method}`)
}

function cli(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((ok) => execFile('node', [CLI, ...args], { env: { ...process.env, PANTHR_DATA_DIR: data, PANTHR_NO_LAUNCH: '1' } }, (e, out, err) => ok({ code: e ? (e as any).code ?? 1 : 0, out, err })))
}

beforeAll(async () => {
  data = mkdtempSync(join(tmpdir(), 'panthr-cli-'))
  server = startControl(join(data, 'panthr.sock'), dispatch)
  await new Promise((r) => server.once('listening', r))
})
afterAll(() => {
  server.close()
  rmSync(data, { recursive: true, force: true })
})

describe('panthr', () => {
  it('lists projects as JSON', async () => {
    const r = await cli('projects', '--json')
    expect(r.code).toBe(0)
    expect(JSON.parse(r.out)[0].meta.name).toBe('Demo')
  })
  it('finds a project by part of its name', async () => {
    const r = await cli('note', 'Logo too small', '--at', '2.5-4', '-p', 'dem')
    expect(r.code).toBe(0)
    expect(comments[0]).toMatchObject({ time: 2.5, end: 4, body: 'Logo too small', resolved: false })
  })
  it('resolves a note', async () => {
    await cli('resolve', comments[0].id)
    expect(comments[0].resolved).toBe(true)
  })
  it('reads and changes settings with their types', async () => {
    expect((await cli('settings', 'skimming', 'off')).code).toBe(0)
    expect(settings.skimming).toBe(false)
    await cli('settings', 'export_fps', '60')
    expect(settings.export_fps).toBe(60)
    expect((await cli('settings', 'nope', '1')).code).toBe(1)
  })
  it('follows a turn to its end', async () => {
    const r = await cli('chat', 'Make the title bigger', '--wait')
    expect(r.code).toBe(0)
    expect(r.out).toContain('Edited index.html')
    expect(r.out).toContain('Made the title bigger.')
    expect(r.out).toContain('Worked for 4s · $0.12')
  })
  it('exports and waits for the file', async () => {
    const r = await cli('export', '--wait', '--json')
    expect(JSON.parse(r.out)).toMatchObject({ ok: true, file: '/p/Demo/.studio/versions/v3.mp4' })
  })
  it('says what is wrong', async () => {
    const r = await cli('chat', 'x', '-p', 'nothing-like-this')
    expect(r.code).toBe(1)
    expect(r.err).toContain('No project called')
    expect((await cli('frobnicate')).code).toBe(2)
  })
})
