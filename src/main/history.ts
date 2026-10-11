// Checkpoints: every agent turn in a project is bracketed by two snapshots
// of the project's files, so the turn can be undone exactly (and the undo
// redone). The history is a private git repository in the project's
// .studio/history.git, its work tree the project folder: separate from any
// git the person uses, and leaving out what is rebuilt or exported anyway
// (frames, versions, renders, snapshots, chats, node_modules).

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Api } from '@shared/api'
import type { Checkpoint } from '@shared/types'
import { emit } from './bus'
import { readJson, writeJson } from './json'
import { now, toolEnv } from './paths'
import * as remote from './remote'

const gitDir = (dir: string): string => join(dir, '.studio', 'history.git')
const logPath = (dir: string): string => join(dir, '.studio', 'checkpoints.json')

/** Never in the history: rebuilt, exported, or the history itself. */
const IGNORE = [
  '.studio/history.git/', '.studio/checkpoints.json', '.studio/project.json', '.studio/canvas-view.json',
  '**/.studio/frames/', '**/.studio/versions/', '**/.studio/chats/', '**/.studio/annotations/',
  '**/node_modules/', '**/renders/', '**/snapshots/', '**/.hyperframes*/', '.DS_Store', '**/.DS_Store',
  '.claude/', '.agents/'
]

function git(dir: string, args: string[], timeout = 120_000): Promise<string> {
  return new Promise((ok, fail) => {
    execFile('git', ['--git-dir', gitDir(dir), '--work-tree', dir, ...args], { cwd: dir, env: { ...toolEnv(), GIT_TERMINAL_PROMPT: '0' }, timeout, maxBuffer: 64 * 1024 * 1024 }, (e, out, err) => {
      if (e) fail(new Error(String(err || e.message).trim().split('\n')[0]))
      else ok(String(out))
    })
  })
}

let gitOk: boolean | null = null
const hasGit = (): Promise<boolean> =>
  gitOk !== null
    ? Promise.resolve(gitOk)
    : new Promise((ok) => execFile('git', ['--version'], { env: toolEnv() }, (e) => ok((gitOk = !e))))

/** Projects on this Mac only (a host's files are its own). */
export const tracked = (dir: string): boolean => !remote.hostOf(dir)

async function ensure(dir: string): Promise<void> {
  if (existsSync(join(gitDir(dir), 'HEAD'))) {
    // Kept current as this list grows.
    const p = join(gitDir(dir), 'info', 'exclude')
    if (!existsSync(p) || readFileSync(p, 'utf8') !== IGNORE.join('\n') + '\n') writeFileSync(p, IGNORE.join('\n') + '\n')
    return
  }
  mkdirSync(join(dir, '.studio'), { recursive: true })
  await git(dir, ['init', '-q'])
  await git(dir, ['config', 'user.name', 'Panthr'])
  await git(dir, ['config', 'user.email', 'panthr@localhost'])
  await git(dir, ['config', 'core.quotePath', 'false'])
  mkdirSync(join(gitDir(dir), 'info'), { recursive: true })
  writeFileSync(join(gitDir(dir), 'info', 'exclude'), IGNORE.join('\n') + '\n')
}

/** Snapshot the project's files now; the commit, or null (no git, a host, a failure). */
export async function snap(dir: string, label: string): Promise<string | null> {
  if (!tracked(dir) || !(await hasGit())) return null
  try {
    await ensure(dir)
    await git(dir, ['add', '-A', '.'])
    await git(dir, ['commit', '-q', '--allow-empty', '--no-verify', '-m', label.slice(0, 200)])
    return (await git(dir, ['rev-parse', 'HEAD'])).trim()
  } catch (e) {
    console.error('history: could not snapshot', dir, (e as Error).message)
    return null
  }
}

type Change = { status: 'A' | 'M' | 'D'; path: string }

async function changes(dir: string, a: string, b: string): Promise<Change[]> {
  const out = await git(dir, ['diff', '--name-status', '--no-renames', '-z', a, b])
  const parts = out.split('\0').filter(Boolean)
  const list: Change[] = []
  for (let i = 0; i + 1 < parts.length; i += 2) list.push({ status: parts[i][0] as Change['status'], path: parts[i + 1] })
  return list
}

export const checkpoints = (dir: string): Checkpoint[] => readJson<Checkpoint[]>(logPath(dir), [])

/** Record a finished turn: what changed between its two snapshots. */
export async function record(dir: string, cp: Omit<Checkpoint, 'files' | 'undone' | 'at'>): Promise<void> {
  if (!cp.before || !cp.after) return
  let files: string[] = []
  try {
    files = (await changes(dir, cp.before, cp.after)).map((c) => c.path)
  } catch {}
  const all = checkpoints(dir).filter((x) => !(x.chatId === cp.chatId && x.turn === cp.turn))
  all.push({ ...cp, files, undone: null, at: now() })
  writeJson(logPath(dir), all.slice(-300))
  emit('history:changed', { dir })
}

/** Put a turn's files back as they were before it (or, `redo`, as it left them).
 *  Files changed by hand since are left alone and reported. */
export async function undo(dir: string, chatId: string, turn: number, redo = false): Promise<{ restored: string[]; skipped: string[] }> {
  const all = checkpoints(dir)
  const cp = all.find((x) => x.chatId === chatId && x.turn === turn)
  if (!cp?.before || !cp.after) throw new Error('No checkpoint for that turn')
  if (redo ? !cp.undone : cp.undone) throw new Error(redo ? 'That turn is not undone' : 'That turn is already undone')
  // Where the files should be now, and where they go.
  const [from, to] = redo ? [cp.undone!, cp.after] : [cp.after, cp.before]
  // The current state first, so this is itself undoable and edits since are seen.
  const current = await snap(dir, `${redo ? 'before redo' : 'before undo'}: ${cp.label}`)
  if (!current) throw new Error('Could not snapshot the project first')
  const restored: string[] = []
  const skipped: string[] = []
  for (const c of await changes(dir, to, from)) {
    // Changed again since (by hand, or a later turn): not ours to put back.
    const since = (await git(dir, ['diff', '--name-only', from, current, '--', c.path])).trim()
    if (since) {
      skipped.push(c.path)
      continue
    }
    const abs = join(dir, c.path)
    if (c.status === 'A') rmSync(abs, { force: true })
    else await git(dir, ['checkout', to, '--', c.path])
    restored.push(c.path)
  }
  const after = await snap(dir, `${redo ? 'redo' : 'undo'}: ${cp.label}`)
  cp.undone = redo ? null : after
  writeJson(logPath(dir), all)
  emit('history:changed', { dir })
  emit('project:changed', { dir, files: restored })
  return { restored, skipped }
}

export const historyApi: Api['history'] = {
  async list(dir) {
    return checkpoints(dir)
  },
  async undo(dir, chatId, turn, redo) {
    return undo(dir, chatId, turn, !!redo)
  }
}
