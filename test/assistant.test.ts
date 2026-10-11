// The assistant's handoff, with real projects in temp folders: a project
// found by name (or the words in it), its newest conversation given the
// message, the window told to go there (with a video active when one is
// named), a new project when none is named, and the assistant's own
// conversations kept out of the projects.
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: undefined }))
const emitted: [string, any][] = []
vi.mock('../src/main/bus', () => ({ emit: (n: string, p: any) => emitted.push([n, structuredClone(p)]) }))
const sent: [string, string, string][] = []
vi.mock('../src/main/chats', async (orig) => {
  const real: any = await orig()
  return {
    ...real,
    chats: {
      ...real.chats,
      open: async (dir: string, chatId: string) => ({ dir, chatId, items: [], working: false }),
      send: async (dir: string, chatId: string, text: string) => void sent.push([dir, chatId, text])
    }
  }
})

import { assistantApi, findProject, handoff } from '../src/main/assistant'
import { createCanvas, listCanvases, newVideo } from '../src/main/board'
import { loadMeta } from '../src/main/projects'

let tmp = ''
let n = 0
beforeAll(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'panthr-assistant-')))
})
beforeEach(() => {
  const t = join(tmp, `t${n++}`)
  process.env.PANTHR_ROOT = join(t, 'Panthr')
  process.env.PANTHR_DATA_DIR = join(t, 'data')
  mkdirSync(process.env.PANTHR_ROOT, { recursive: true })
  emitted.length = 0
  sent.length = 0
})

describe('the assistant', () => {
  it('hands a message to the project named, in its newest conversation', async () => {
    const c = createCanvas('Launch Reel')
    createCanvas('Changelog')
    const r = await handoff('launch', 'Make the intro shorter')
    expect(r).toMatchObject({ dir: c.dir, name: 'Launch Reel', queued: false })
    expect(loadMeta(c.dir)!.chats.at(-1)!.id).toBe(r.chatId)
    expect(sent).toEqual([[c.dir, r.chatId, 'Make the intro shorter']])
    expect(emitted.find(([e]) => e === 'assistant:handoff')?.[1]).toEqual({ canvas: c.dir, chatId: r.chatId, active: null })
    // The same conversation next time.
    expect((await handoff('Launch Reel', 'And the music')).chatId).toBe(r.chatId)
  })

  it('makes a video active when one is named', async () => {
    const c = createCanvas('Launch Reel')
    const v = newVideo(c.dir, 'Teaser 9:16')
    await handoff('Launch Reel', 'Bigger captions', 'Teaser 9:16')
    expect(emitted.find(([e]) => e === 'assistant:handoff')?.[1].active).toBe(v.dir)
    await expect(handoff('Launch Reel', 'x', 'No such video')).rejects.toThrow('No video called')
  })

  it('a new project when none is named', async () => {
    const r = await handoff(null, 'A 10-second logo reveal with light leaks')
    expect(r.name).toBe('A 10-second logo reveal with')
    expect(listCanvases().map((c) => c.dir)).toContain(r.dir)
    expect(sent[0][2]).toBe('A 10-second logo reveal with light leaks')
  })

  it('says when a name is unknown or could be two', () => {
    createCanvas('Launch Reel')
    createCanvas('Launch Teaser')
    expect(() => findProject('Launch')).toThrow('could be')
    expect(() => findProject('Nope')).toThrow('No project called')
    expect(findProject('teaser').name).toBe('Launch Teaser')
  })

  it('keeps its own conversations out of the projects', async () => {
    const a = await assistantApi.open()
    expect(a.dir).toBe(join(process.env.PANTHR_DATA_DIR!, 'assistant'))
    expect(loadMeta(a.dir)!.chats.map((c) => c.id)).toEqual([a.chatId])
    expect((await assistantApi.open()).chatId).toBe(a.chatId)
    // Still empty: a new conversation is the same one.
    expect((await assistantApi.fresh()).chatId).toBe(a.chatId)
    expect(listCanvases()).toEqual([])
  })
})
