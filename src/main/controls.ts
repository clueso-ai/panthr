// Controls the agent made for parts of the video (.studio/controls.json)
// and the editor tool that writes their values into the files
// (resources/edit.mjs, the same tool the cloud Studio runs on its machines).
// Port of studio-mac/src/controls.rs, plus timeline.rs's parse_inspect.

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Api } from '@shared/api'
import type { Control, ControlSet, TimingLayer, Tween } from '@shared/types'
import { dataDir, resource, toolEnv } from './paths'
import { readJson, writeJson } from './json'
import * as remote from './remote'

export const PARSERS = '@hyperframes/parsers@0.8.73'

const controlsPath = (dir: string): string => join(dir, '.studio/controls.json')

/** Every set, by key (`file#id` or `file#id@start-end`). A missing or broken
 *  file is no controls; sets without `file`/`element` are dropped, as the
 *  Rust app's serde would refuse them. */
export function load(dir: string): Record<string, ControlSet> {
  const raw = readJson<unknown>(controlsPath(dir), {})
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, ControlSet> = {}
  for (const [k, v] of Object.entries(raw as Record<string, any>)) {
    if (!v || typeof v.file !== 'string' || typeof v.element !== 'string') continue
    out[k] = { ...v, title: v.title ?? '', controls: Array.isArray(v.controls) ? v.controls : [], note: v.note ?? null }
  }
  return out
}

/** Saved with sorted keys, like the Rust app's BTreeMap. */
export function save(dir: string, all: Record<string, ControlSet>): void {
  const sorted: Record<string, ControlSet> = {}
  for (const k of Object.keys(all).sort()) sorted[k] = all[k]
  writeJson(controlsPath(dir), sorted)
}

/** The set for a picked element: by its id, by a time range around `at`
 *  (a drawn element keyed `file#id@start-end`), then by the ids around it. */
export function keyFor(all: Record<string, ControlSet>, file: string, ids: string[], at: number): string | null {
  const keys = Object.keys(all).sort()
  for (const id of ids) {
    const exact = `${file}#${id}`
    if (exact in all) return exact
    const prefix = `${file}#${id}@`
    for (const k of keys) {
      if (!k.startsWith(prefix)) continue
      const range = k.slice(prefix.length)
      const i = range.indexOf('-')
      if (i < 0) continue
      const a = num(range.slice(0, i))
      const b = num(range.slice(i + 1))
      if (a != null && b != null && at >= a && at < b) return k
    }
  }
  return null
}

/** A strict float parse (Rust's `parse::<f64>`): "x" and "" are not numbers. */
function num(s: string): number | null {
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s.trim()) || s.trim() !== s) return null
  return Number(s)
}

export function fmtNum(n: number): string {
  const s = n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
  // A tiny negative rounds to "-0.000": write plain 0.
  return s === '-0' ? '0' : s
}

/** The value a control writes, as the file needs it (a number gets its
 *  unit for CSS, none for an attribute). */
export function written(c: Control, v: unknown): unknown {
  if (c.type === 'number' && typeof v === 'number') {
    let n = v
    if (c.min != null && c.max != null) n = Math.min(Math.max(n, c.min), c.max)
    return c.write.startsWith('style:') ? `${fmtNum(n)}${c.unit ?? ''}` : fmtNum(n)
  }
  return v
}

export function setRequest(set: ControlSet, c: Control, v: unknown): Record<string, unknown> {
  const targets = c.targets?.length ? c.targets : [set.element]
  return { op: 'set', file: set.file, target: targets[0], targets, write: c.write, value: written(c, v) }
}

// ── The editor tool ───────────────────────────────────────────────

export const toolDir = (): string => join(dataDir(), 'editor')

const editMjs = (): string => readFileSync(resource('edit.mjs'), 'utf8')

function run1(cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd: opts.cwd, env: opts.env ?? toolEnv(), maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0
      resolve({ code, stdout: String(stdout), stderr: String(stderr || (err && !stdout ? err.message : '')) })
    })
  })
}

// One install at a time: two edits racing would run two npm installs into
// the same node_modules.
let installing: Promise<void> | null = null

/** Put the editor tool in place (once, and again when it changes). */
export function install(): Promise<void> {
  const next = (installing ?? Promise.resolve()).catch(() => {}).then(installNow)
  installing = next
  return next
}

async function installNow(): Promise<void> {
  const d = toolDir()
  mkdirSync(d, { recursive: true })
  const mjs = join(d, 'edit.mjs')
  const want = editMjs()
  let have: string | null = null
  try {
    have = readFileSync(mjs, 'utf8')
  } catch {}
  if (have !== want) writeFileSync(mjs, want)
  const pkg = join(d, 'package.json')
  if (!existsSync(pkg)) writeFileSync(pkg, '{"name":"clueso-studio-editor","private":true,"type":"module"}')
  if (!existsSync(join(d, 'node_modules/@hyperframes/parsers')) || !existsSync(join(d, 'node_modules/linkedom'))) {
    const r = await run1('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', PARSERS, 'linkedom'], { cwd: d })
    if (r.code !== 0) throw new Error(`npm install failed${r.stderr.trim() ? `: ${r.stderr.trim().split('\n').pop()}` : ''}`)
  }
}

/** One request to the editor tool, on the project's files. */
export async function runEdit(dir: string, req: Record<string, unknown>): Promise<any> {
  // A project on a host: the tool runs there, on the files there.
  if (remote.hostOf(dir)) {
    const v = await remote.edit(dir, req)
    if (v && v.ok === false) throw new Error(typeof v.error === 'string' ? v.error : 'edit failed')
    return v
  }
  await install()
  const d = toolDir()
  const tmp = join(tmpdir(), `studio-edit-${randomUUID()}.json`)
  writeFileSync(tmp, JSON.stringify(req))
  try {
    const out = await run1('node', [join(d, 'edit.mjs'), tmp], { cwd: d, env: { ...toolEnv(), CLUESO_PROJECT: dir } })
    let v: any
    try {
      v = JSON.parse(out.stdout)
    } catch {
      throw new Error(out.stderr.trim() || 'the editor tool said nothing')
    }
    if (v && v.ok === false) throw new Error(typeof v.error === 'string' ? v.error : 'edit failed')
    return v
  } finally {
    rmSync(tmp, { force: true })
  }
}

/** The tool's inspect (all files, or one file's) as timing by layer id. */
export function parseInspect(v: any): Record<string, TimingLayer> {
  const out: Record<string, TimingLayer> = {}
  const files: any[] = Array.isArray(v?.files) ? v.files : [v]
  const n = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null)
  for (const f of files) {
    const file = typeof f?.file === 'string' ? f.file : 'index.html'
    for (const l of Array.isArray(f?.layers) ? f.layers : []) {
      if (typeof l?.id !== 'string') continue
      // Without a window there is nothing to place on the timeline.
      const start = n(l.start)
      const end = n(l.end)
      if (start == null || end == null) continue
      const tweens: Tween[] = []
      for (const t of Array.isArray(l.tweens) ? l.tweens : []) {
        if (typeof t?.id !== 'string' || n(t.start) == null) continue
        tweens.push({
          id: t.id,
          start: t.start,
          duration: n(t.duration) ?? 0,
          ease: typeof t.ease === 'string' ? t.ease : null,
          editable: t.editable === true,
          method: typeof t.method === 'string' ? t.method : 'to',
          why: typeof t.why === 'string' ? t.why : null
        })
      }
      out[l.id] = {
        id: l.id,
        file,
        label: typeof l.label === 'string' ? l.label : l.id,
        start,
        end,
        movable: l.movable === true,
        why: typeof l.why === 'string' ? l.why : null,
        tweens
      }
    }
  }
  return out
}

export const controls: Api['controls'] = {
  async all(dir) {
    return load(dir)
  },
  async save(dir, all) {
    save(dir, all)
  },
  async run(dir, req) {
    return runEdit(dir, req)
  },
  async timing(dir) {
    return parseInspect(await runEdit(dir, { op: 'inspect' }))
  }
}
