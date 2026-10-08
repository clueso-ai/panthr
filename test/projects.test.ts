// Projects on disk (port of studio-mac's tests/project.rs, plus list/create/
// openFolder/saveMeta/thumb). HOME and the data dir are temp folders: the real
// ~/Panthr is never touched.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: undefined }))
const emitted: [string, any][] = []
vi.mock('../src/main/bus', () => ({ emit: (n: string, p: any) => emitted.push([n, p]) }))

import {
  STARTER, chatPath, contentMtime, createIn, folderName, ignored, list, load, loadMeta, newChat, normalMeta, openFolder,
  parseMeta, projects, saveMetaFile, thumbOf
} from '../src/main/projects'

const env = { HOME: process.env.HOME, DATA: process.env.PANTHR_DATA_DIR }
let tmp = ''
let n = 0
const fresh = (name = 'p'): string => {
  const d = join(tmp, `t${n++}`, name)
  mkdirSync(d, { recursive: true })
  return d
}
const write = (path: string, text: string): void => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'panthr-projects-'))
  process.env.HOME = join(tmp, 'home')
  process.env.PANTHR_DATA_DIR = join(tmp, 'data')
  mkdirSync(process.env.HOME)
})
afterAll(() => {
  process.env.HOME = env.HOME
  process.env.PANTHR_DATA_DIR = env.DATA
})
beforeEach(() => {
  emitted.length = 0
})

describe('meta', () => {
  it('defaults for old files', () => {
    const m = parseMeta(JSON.parse('{"name":"Promo","created_at":5}'))!
    expect(m.name).toBe('Promo')
    expect(m.chats).toEqual([])
    expect(m.agents_enabled).toBe(true)
    expect(m.models).toEqual({})
    expect(parseMeta(JSON.parse('{"name":"P","created_at":5,"agents_enabled":false}'))!.agents_enabled).toBe(false)
    expect(parseMeta(JSON.parse('{"created_at":5}'))).toBeNull()
  })

  it('chat meta defaults for old files', () => {
    const c = parseMeta({ name: 'P', created_at: 1, chats: [{ id: 'c1', title: 'First', created_at: 9 }] })!.chats[0]
    expect(c.session_id).toBeNull()
    expect(c.engine).toBeNull()
    const d = parseMeta({ name: 'P', created_at: 1, chats: [{ id: 'c1', title: 't', created_at: 9, session_id: 's', engine: 'codex' }] })!.chats[0]
    expect(d.session_id).toBe('s')
    expect(d.engine).toBe('codex')
  })

  it('saves in Rust serde field order, pretty, models sorted', () => {
    const dir = fresh()
    saveMetaFile(dir, { models: { codex: 'gpt', claude: 'opus' }, agents_enabled: false, chats: [{ title: 'Hi', id: 'a', created_at: 2 } as any], created_at: 1, name: 'P' })
    expect(readFileSync(join(dir, '.studio/project.json'), 'utf8')).toBe(`{
  "name": "P",
  "created_at": 1,
  "chats": [
    {
      "id": "a",
      "title": "Hi",
      "session_id": null,
      "created_at": 2,
      "engine": null
    }
  ],
  "agents_enabled": false,
  "models": {
    "claude": "opus",
    "codex": "gpt"
  }
}`)
  })

  it('normalMeta is idempotent', () => {
    const m = normalMeta({ name: 'x', created_at: 1, chats: [], agents_enabled: true, models: {} })
    expect(normalMeta(m)).toEqual(m)
  })
})

describe('load', () => {
  it('adopts a folder with an index.html, writing nothing', () => {
    const dir = fresh('My Video')
    writeFileSync(join(dir, 'index.html'), STARTER)
    const p = load(dir)!
    expect(p.meta.name).toBe('My Video')
    expect(p.meta.chats).toEqual([])
    expect(p.meta.agents_enabled).toBe(true)
    expect(p.dir).toBe(dir)
    expect(p.host).toBeNull()
    expect(existsSync(join(dir, '.studio'))).toBe(false)
  })

  it('refuses folders that are not projects', () => {
    expect(load(fresh('empty'))).toBeNull()
    const lib = fresh('Library')
    writeFileSync(join(lib, 'index.html'), 'x')
    expect(load(lib)).toBeNull()
    const f = join(fresh(), 'file.txt')
    writeFileSync(f, 'x')
    expect(load(f)).toBeNull()
    expect(load(join(tmp, 'missing'))).toBeNull()
  })

  it('reads saved meta', () => {
    const dir = fresh('folder-name')
    write(join(dir, '.studio/project.json'), '{"name":"Shown Name","created_at":42,"chats":[{"id":"a","title":"Hi","created_at":43}],"agents_enabled":false}')
    const p = load(dir)!
    expect(p.meta.name).toBe('Shown Name')
    expect(p.meta.created_at).toBe(42)
    expect(p.meta.chats).toHaveLength(1)
    expect(p.meta.agents_enabled).toBe(false)
  })

  it('corrupt meta is not a project', () => {
    const dir = fresh()
    writeFileSync(join(dir, 'index.html'), 'x')
    write(join(dir, '.studio/project.json'), '{oops')
    expect(load(dir)).toBeNull()
  })
})

describe('chats in the project', () => {
  it('new chats are saved with the project', () => {
    const dir = fresh()
    writeFileSync(join(dir, 'index.html'), 'x')
    const a = newChat(dir, 'First')!
    const b = newChat(dir, 'Second', 'codex')!
    expect(a.id).not.toBe(b.id)
    expect(a.session_id).toBeNull()
    expect(a.engine).toBeNull()
    const back = loadMeta(dir)!
    expect(back.chats.map((c) => c.title)).toEqual(['First', 'Second'])
    expect(back.chats[1].engine).toBe('codex')
  })

  it('the transcript lives under .studio/chats', () => {
    expect(chatPath('/x/Proj', 'abc-123')).toBe('/x/Proj/.studio/chats/abc-123.json')
  })
})

describe('creating', () => {
  it('the starter is a playable composition', () => {
    for (const needle of ['data-composition-id="main"', 'data-duration="5"', 'data-width="1920"', 'data-height="1080"', 'gsap.timeline({ paused: true })', 'window.__timelines["main"] = tl', '<head>']) {
      expect(STARTER).toContain(needle)
    }
  })

  it('folder names keep letters, digits, spaces and dashes', () => {
    expect(folderName('  Launch: v2/teaser! ')).toBe('Launch- v2-teaser-')
    expect(folderName('Café 東京')).toBe('Café 東京')
    expect(folderName('   ')).toBe('Untitled')
  })

  it('createIn makes a new folder each time', () => {
    const root = fresh('root')
    const a = createIn(root, 'Promo')
    const b = createIn(root, 'Promo')
    expect(a.dir).toBe(join(root, 'Promo'))
    expect(b.dir).toBe(join(root, 'Promo 2'))
    expect(b.meta.name).toBe('Promo 2')
    expect(readFileSync(join(a.dir, 'index.html'), 'utf8')).toBe(STARTER)
    expect(existsSync(join(a.dir, 'assets'))).toBe(true)
    expect(existsSync(join(a.dir, 'compositions'))).toBe(true)
    expect(loadMeta(a.dir)!.name).toBe('Promo')
  })

  it('create puts it in ~/Panthr with the Agents default, and lists it', async () => {
    const p = await projects.create('First idea')
    expect(p.dir).toBe(join(process.env.HOME!, 'Panthr', 'First idea'))
    expect(p.meta.agents_enabled).toBe(true)
    expect((await projects.list()).map((x) => x.dir)).toContain(p.dir)
    expect(existsSync(join(process.env.HOME!, 'Panthr', 'Library'))).toBe(true)
    const r = await projects.rename(p.dir, '  Renamed ')
    expect(r.meta.name).toBe('Renamed')
    expect(r.dir).toBe(p.dir)
  })

  it('create on an unknown host fails', async () => {
    await expect(projects.create('x', 'nowhere')).rejects.toThrow()
  })
})

describe('opened folders and the list', () => {
  it('openFolder adopts, saves the meta, and remembers the folder', async () => {
    const dir = fresh('Elsewhere')
    writeFileSync(join(dir, 'index.html'), 'x')
    const p = (await projects.openFolder(dir))!
    expect(p.meta.name).toBe('Elsewhere')
    expect(existsSync(join(dir, '.studio/project.json'))).toBe(true)
    expect(JSON.parse(readFileSync(join(process.env.PANTHR_DATA_DIR!, 'opened.json'), 'utf8'))).toContain(dir)
    openFolder(dir)
    expect(JSON.parse(readFileSync(join(process.env.PANTHR_DATA_DIR!, 'opened.json'), 'utf8')).filter((d: string) => d === dir)).toHaveLength(1)
    expect(list().map((x) => x.dir)).toContain(dir)
    expect(await projects.openFolder(fresh('no-index'))).toBeNull()
  })

  it('the list is newest first', () => {
    const all = list()
    for (let i = 1; i < all.length; i++) expect(all[i - 1].meta.created_at).toBeGreaterThanOrEqual(all[i].meta.created_at)
  })
})

describe('saveMeta', () => {
  it('keeps the chats main wrote (the window may hold an older copy)', async () => {
    const dir = fresh()
    writeFileSync(join(dir, 'index.html'), 'x')
    const stale = loadMeta(dir)!
    saveMetaFile(dir, stale)
    const c = newChat(dir, 'New chat')!
    await projects.saveMeta(dir, { ...stale, models: { claude: 'opus' }, agents_enabled: false })
    const m = loadMeta(dir)!
    expect(m.models).toEqual({ claude: 'opus' })
    expect(m.agents_enabled).toBe(false)
    expect(m.chats.map((x) => x.id)).toEqual([c.id])
  })
})

describe('what Home shows', () => {
  it('thumb: a frame a third in, else the newest poster, else a snapshot', () => {
    const dir = fresh()
    expect(thumbOf(dir)).toBeNull()
    write(join(dir, '.studio/snapshots/a.png'), 'x')
    expect(thumbOf(dir)).toBe(join(dir, '.studio/snapshots/a.png'))
    write(join(dir, '.studio/versions/v2.jpg'), 'x')
    write(join(dir, '.studio/versions/v10.jpg'), 'x')
    write(join(dir, '.studio/versions/v3.mp4'), 'x')
    expect(thumbOf(dir)).toBe(join(dir, '.studio/versions/v10.jpg'))
    for (const i of [0, 1, 2, 3, 4, 5]) write(join(dir, `.studio/frames/200/frame-${i}.png`), 'x')
    write(join(dir, '.studio/frames/100/frame-0.png'), 'x')
    expect(thumbOf(dir)).toBe(join(dir, '.studio/frames/200/frame-2.png'))
  })

  it('edited_at: the newest composition file, skipping .studio and renders', () => {
    const dir = fresh()
    write(join(dir, 'index.html'), 'x')
    write(join(dir, 'compositions/a.html'), 'x')
    write(join(dir, '.studio/project.json'), '{}')
    write(join(dir, 'renders/out.mp4'), 'x')
    utimesSync(join(dir, 'index.html'), 1000, 1000)
    utimesSync(join(dir, 'compositions/a.html'), 2000, 2000)
    utimesSync(join(dir, 'compositions'), 500, 500)
    expect(contentMtime(dir)).toBe(2000)
  })

  it('the watcher ignores its own and tool folders', () => {
    expect(ignored('.studio/chats/a.json')).toBe(true)
    expect(ignored('node_modules/x/y.js')).toBe(true)
    expect(ignored('.git/HEAD')).toBe(true)
    expect(ignored('.hyperframes-cache/x')).toBe(true)
    expect(ignored('renders/v1.mp4')).toBe(true)
    expect(ignored('compositions/intro.html')).toBe(false)
    expect(ignored('index.html')).toBe(false)
  })

  it('watch reports changed files, settled', async () => {
    const dir = fresh()
    writeFileSync(join(dir, 'index.html'), 'x')
    await projects.watch(dir)
    await new Promise((r) => setTimeout(r, 100))
    writeFileSync(join(dir, 'index.html'), 'y')
    write(join(dir, '.studio/chats/c.json'), '[]')
    await new Promise((r) => setTimeout(r, 700))
    await projects.unwatch(dir)
    const ev = emitted.filter(([n]) => n === 'project:changed')
    expect(ev.length).toBeGreaterThanOrEqual(1)
    const files = ev.flatMap(([, p]) => p.files)
    expect(files).toContain('index.html')
    expect(files.some((f: string) => f.startsWith('.studio/chats'))).toBe(false)
  })
})
