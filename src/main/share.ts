// A project in one file: name.panthr, a zip of the project folder (and any
// videos it uses from elsewhere) with a small manifest, for sending however
// people send files. Nothing goes over the network.
//
// Opened, a .panthr becomes a project in ~/Panthr. If it is a project this
// Mac already has (the same id: a copy sent back after review), its canvas
// notes are merged in instead: what the reviewer wrote comes home.
//
// Left out: the private undo history, caches (frames, renders, snapshots,
// node_modules), exports, the conversation with the agent (the work is
// shared, not the talk) and the skills links.

import { execFile } from 'node:child_process'
import { app, BrowserWindow, dialog } from 'electron'
import { randomUUID } from 'node:crypto'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, relative } from 'node:path'
import type { Api } from '@shared/api'
import type { CanvasNote } from '@shared/types'
import { board, canvasDirs, isCanvas, real } from './board'
import { emit } from './bus'
import { readJson, writeJson } from './json'
import { folderName, loadMeta, saveMetaFile } from './projects'
import { now, studioRoot, toolEnv } from './paths'
import { link as linkSkills } from './skills'

const FORMAT = 1
const SKIP = new Set(['history.git', 'frames', 'versions', 'renders', 'snapshots', 'node_modules', 'chats', 'annotations', 'Exports', '.claude', '.agents', '.DS_Store'])
const SKIP_FILES = new Set(['checkpoints.json', 'canvas-view.json'])

interface Manifest {
  format: number
  id: string
  name: string
  exported_at: number
  /** Videos from outside the project folder: where they were put in the archive. */
  imported: Record<string, string>
}

const run = (cmd: string, args: string[]): Promise<void> =>
  new Promise((ok, fail) => execFile(cmd, args, { env: { ...toolEnv(), COPYFILE_DISABLE: '1' }, maxBuffer: 16 * 1024 * 1024 }, (e, _o, err) => (e ? fail(new Error(String(err || e.message).trim())) : ok())))

/** A project's lasting id (in its canvas file), made the first time it is asked for. */
export function projectId(dir: string): string {
  const f = join(dir, '.studio', 'canvas.json')
  const c = readJson<Record<string, unknown>>(f, {})
  if (typeof c.id === 'string' && c.id) return c.id
  const id = randomUUID()
  writeJson(f, { ...c, id })
  return id
}

function copyInto(from: string, to: string): void {
  mkdirSync(to, { recursive: true })
  for (const e of readdirSync(from, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue
    const f = join(from, e.name)
    const t = join(to, e.name)
    if (e.isDirectory()) copyInto(f, t)
    else if (e.isFile() && !(basename(from) === '.studio' && SKIP_FILES.has(e.name))) copyFileSync(f, t)
    else if (e.isSymbolicLink()) {
      try {
        cpSync(f, t, { dereference: true, recursive: true })
      } catch {}
    }
  }
}

/** Write a project as one .panthr file; returns its path. */
export async function saveShare(canvas0: string, out: string): Promise<string> {
  const canvas = real(canvas0)
  if (!isCanvas(canvas)) throw new Error('Not a project')
  const id = projectId(canvas)
  const b = board(canvas)
  const stage = mkdtempSync(join(tmpdir(), 'panthr-share-'))
  try {
    const root = join(stage, 'project')
    copyInto(canvas, root)
    // Videos from elsewhere come along, under _imported/.
    const imported: Record<string, string> = {}
    for (const key of Object.keys(b.tiles)) {
      if (key.startsWith('ref:') || key === canvas || key.startsWith(canvas + '/')) continue
      const rel = `_imported/${folderName(loadMeta(key)?.name ?? basename(key))}`
      copyInto(key, join(root, rel))
      imported[key] = rel
    }
    // The canvas with paths from the project folder, so it opens anywhere.
    const rel = (k: string): string => (k.startsWith('ref:') ? k : k === canvas ? '.' : imported[k] ?? relative(canvas, k))
    const c = readJson<Record<string, any>>(join(canvas, '.studio', 'canvas.json'), {})
    const tiles = Object.fromEntries(Object.entries(b.tiles).filter(([k]) => !k.startsWith('ref:')).map(([k, v]) => [rel(k), v]))
    const notes = (b.notes ?? []).map((n) => ({ ...n, ...(n.on ? { on: rel(n.on) } : {}), ...(n.from ? { from: rel(n.from) } : {}), ...(n.to ? { to: rel(n.to) } : {}) }))
    const links = b.links.filter((l) => !l.from.startsWith('ref:') && !l.to.startsWith('ref:')).map((l) => ({ from: rel(l.from), to: rel(l.to) }))
    writeJson(join(root, '.studio', 'canvas.json'), { ...c, id, tiles, links, notes })
    const manifest: Manifest = { format: FORMAT, id, name: loadMeta(canvas)?.name ?? basename(canvas), exported_at: now(), imported: Object.fromEntries(Object.entries(imported).map(([, r]) => [r, r])) }
    writeFileSync(join(stage, 'panthr.json'), JSON.stringify(manifest, null, 2))
    const file = out.endsWith('.panthr') ? out : `${out}.panthr`
    rmSync(file, { force: true })
    await run('/usr/bin/ditto', ['-c', '-k', '--norsrc', '--noextattr', '--noqtn', stage, file])
    return file
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

/** Open a .panthr: a new project, or (the same project, sent back) its notes merged in. */
export async function openShare(file: string): Promise<{ dir: string; merged: boolean; text: string }> {
  const stage = mkdtempSync(join(tmpdir(), 'panthr-open-'))
  try {
    await run('/usr/bin/ditto', ['-x', '-k', file, stage])
    const m = readJson<Manifest | null>(join(stage, 'panthr.json'), null)
    if (!m || m.format !== FORMAT || !existsSync(join(stage, 'project'))) throw new Error('Not a Panther project file')
    const incoming = readJson<{ notes?: CanvasNote[]; tiles?: Record<string, unknown> }>(join(stage, 'project', '.studio', 'canvas.json'), {})

    // The same project here already: bring its notes home.
    const mine = canvasDirs().find((d) => readJson<{ id?: string }>(join(d, '.studio', 'canvas.json'), {}).id === m.id)
    if (mine) {
      const abs = (k?: string | null): string | null | undefined => (k == null ? k : k.startsWith('ref:') ? k : k === '.' ? mine : join(mine, k))
      const c = readJson<Record<string, any>>(join(mine, '.studio', 'canvas.json'), {})
      const have = new Map<string, CanvasNote>((c.notes ?? []).map((n: CanvasNote) => [n.id, n]))
      let added = 0
      for (const n of incoming.notes ?? []) {
        const back = { ...n, on: abs(n.on) ?? null, from: abs(n.from) ?? undefined, to: abs(n.to) ?? undefined }
        const was = have.get(n.id)
        if (!was) added++
        // Theirs wins if newer or newly done; ours otherwise.
        if (!was || (back.at ?? 0) > (was.at ?? 0) || (back.done && !was.done)) have.set(n.id, back as CanvasNote)
      }
      writeJson(join(mine, '.studio', 'canvas.json'), { ...c, notes: [...have.values()] })
      emit('board:changed', board(mine))
      return { dir: mine, merged: true, text: added ? `${added} new note${added === 1 ? '' : 's'} from ${basename(file)}` : `Nothing new in ${basename(file)}` }
    }

    // New here: the project goes into ~/Panthr, its paths made whole again.
    const base = folderName(m.name || 'Shared project')
    let dir = join(studioRoot(), base)
    for (let n = 2; existsSync(dir); n++) dir = join(studioRoot(), `${base} ${n}`)
    cpSync(join(stage, 'project'), dir, { recursive: true })
    dir = real(dir)
    const abs = (k: string): string => (k.startsWith('ref:') ? k : k === '.' ? dir : join(dir, k))
    const c = readJson<Record<string, any>>(join(dir, '.studio', 'canvas.json'), {})
    const tiles = Object.fromEntries(Object.entries(c.tiles ?? {}).map(([k, v]) => [abs(k), v]))
    const links = (c.links ?? []).map((l: { from: string; to: string }) => ({ from: abs(l.from), to: abs(l.to) }))
    const notes = (c.notes ?? []).map((n: CanvasNote) => ({ ...n, ...(n.on ? { on: abs(n.on) } : {}), ...(n.from ? { from: abs(n.from) } : {}), ...(n.to ? { to: abs(n.to) } : {}) }))
    writeJson(join(dir, '.studio', 'canvas.json'), { ...c, tiles, links, notes })
    const meta = loadMeta(dir)
    if (meta) saveMetaFile(dir, { ...meta, name: m.name || meta.name, chats: [] })
    linkSkills(dir)
    return { dir, merged: false, text: `Opened ${basename(file)}` }
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

export const shareApi: Api['share'] = {
  async save(canvas, file) {
    let out = file
    if (!out) {
      const w = BrowserWindow.getFocusedWindow()
      const name = folderName(loadMeta(real(canvas))?.name ?? 'Project')
      const opts: Electron.SaveDialogOptions = { defaultPath: join(app.getPath('desktop'), `${name}.panthr`), filters: [{ name: 'Panther project', extensions: ['panthr'] }] }
      const r = await (w ? dialog.showSaveDialog(w, opts) : dialog.showSaveDialog(opts))
      if (r.canceled || !r.filePath) return ''
      out = r.filePath
    }
    return saveShare(canvas, out)
  },
  async open(file) {
    const r = await openShare(file)
    emit('share:opened', r)
    return r
  }
}
