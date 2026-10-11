// The assistant: a conversation outside the projects, opened from Home. It
// runs on the person's own agent (as every chat does) with its own
// instructions, and looks after Panthr itself through the `panthr` command:
// settings, skills, references. What is about a project it does not do
// itself: it hands the message to that project's conversation (handoff),
// and the window goes there to watch it happen.
//
// Its conversations live in the data folder (assistant/.studio), kept as a
// project's are, so they are never listed among the projects.

import { existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Api } from '@shared/api'
import { emit } from './bus'
import { chats, NEW_CHAT } from './chats'
import { createCanvas, keyFor, listCanvases } from './board'
import { loadMeta, metaPath, newChat, saveMetaFile } from './projects'
import { assistantDir, now } from './paths'

export const ASSISTANT_NAME = 'Panthr assistant'

export const isAssistant = (dir: string): boolean => resolve(dir) === resolve(assistantDir())

/** The assistant's folder, made the first time. */
function ensure(): string {
  const dir = assistantDir()
  if (!existsSync(metaPath(dir))) {
    mkdirSync(dir, { recursive: true })
    // No sub-agents: its work is a command or two, never long.
    saveMetaFile(dir, { name: ASSISTANT_NAME, created_at: now(), chats: [], agents_enabled: false, models: {} })
  }
  return dir
}

/** A project by name (or folder): exact first, then the one whose name holds the words. */
export function findProject(what: string): { dir: string; name: string } {
  const w = what.trim().toLowerCase()
  const all = listCanvases()
  const exact = all.find((c) => c.dir === resolve(what) || c.name.toLowerCase() === w)
  if (exact) return { dir: exact.dir, name: exact.name }
  const some = all.filter((c) => c.name.toLowerCase().includes(w))
  if (some.length === 1) return { dir: some[0].dir, name: some[0].name }
  if (!some.length) throw new Error(`No project called "${what}". Projects: ${all.map((c) => c.name).join(', ') || 'none yet'}`)
  throw new Error(`"${what}" could be: ${some.map((c) => c.name).join(', ')}`)
}

/** A project's conversation to send to: its newest (the one its window shows), or a first. */
async function chatOf(dir: string): Promise<string> {
  const last = loadMeta(dir)?.chats.at(-1)
  return last ? last.id : chats.create(dir)
}

/** A message for a project's agent: the window goes to the project, the
 *  message into its conversation (queued, if a turn is running). No
 *  project: a new one, named from the message. */
export async function handoff(project: string | null, text: string, video?: string | null): Promise<{ dir: string; name: string; chatId: string; queued: boolean }> {
  if (!text.trim()) throw new Error('Nothing to send')
  let target: { dir: string; name: string }
  if (project?.trim()) target = findProject(project)
  else {
    const name = text.split(/\s+/).slice(0, 5).join(' ').replace(/[^\p{L}\p{N}]+$/u, '') || 'Untitled'
    const c = createCanvas(name)
    target = { dir: c.dir, name: c.name }
  }
  // A video in it to work on: it is made the active one.
  let active: string | null = null
  if (video?.trim()) {
    active = keyFor(target.dir, video)
    if (!active || active.startsWith('ref:')) throw new Error(`No video called "${video}" in ${target.name}`)
  }
  const chatId = await chatOf(target.dir)
  const before = await chats.open(target.dir, chatId)
  emit('assistant:handoff', { canvas: target.dir, chatId, active })
  await chats.send(target.dir, chatId, text)
  return { ...target, chatId, queued: before.working }
}

export const assistantApi: Api['assistant'] = {
  async open() {
    const dir = ensure()
    const last = loadMeta(dir)?.chats.at(-1)
    return { dir, chatId: last ? last.id : newChat(dir, NEW_CHAT)!.id }
  },
  async fresh() {
    const dir = ensure()
    // An empty one already: use it.
    const last = loadMeta(dir)?.chats.at(-1)
    if (last && !(await chats.open(dir, last.id)).items.length) return { dir, chatId: last.id }
    return { dir, chatId: newChat(dir, NEW_CHAT)!.id }
  },
  async handoff(project, text, video) {
    return handoff(project, text, video)
  }
}
