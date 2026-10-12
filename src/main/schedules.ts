// Schedules: videos made on their own. At a time on chosen days, a message
// goes to a project's agent (or a new project is made for it), in the
// background: the window stays where it is. When the agent's turn is over
// (self-check and all), the videos it changed are exported and a
// notification says so; the result waits on Home.
//
// A run missed while Panthr was closed happens once when it next opens.
// The message carries the date and when it last ran, so "this week's
// releases" means something to the agent.

import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Notification } from 'electron'
import type { Api } from '@shared/api'
import type { Schedule, ScheduleStatus } from '@shared/types'
import { emit } from './bus'
import { createCanvas, real } from './board'
import { chats, onSettled } from './chats'
import { checkpoints } from './history'
import { readJson, writeJson } from './json'
import { dataDir, now } from './paths'
import { loadMeta } from './projects'
import { renderAndWait } from './review'

const file = (): string => join(dataDir(), 'schedules.json')
const all = (): Schedule[] => readJson<Schedule[]>(file(), [])
const saveAll = (list: Schedule[]): void => writeJson(file(), list)

/** The next time it is due after `after` (s since the epoch), local time; null if it never runs. */
export function nextRun(s: Pick<Schedule, 'days' | 'time'>, after: number): number | null {
  const days = [...new Set(s.days)].filter((d) => d >= 0 && d <= 6)
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.time)
  if (!days.length || !m) return null
  const base = new Date(after * 1000)
  for (let i = 0; i <= 7; i++) {
    const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i, +m[1], +m[2], 0, 0)
    if (days.includes(d.getDay()) && d.getTime() / 1000 > after) return Math.floor(d.getTime() / 1000)
  }
  return null
}

/** When it was last due (≤ now), to catch a run missed while closed. */
const dueSince = (s: Schedule): number => s.lastRun ?? s.created_at

/** Runs going now: by chat (canvas + chat id), with the turn they started at. */
const running = new Map<string, { id: string; canvas: string; chatId: string; turn: number }>()

const status = (s: Schedule): ScheduleStatus => ({
  ...s,
  next: s.enabled ? nextRun(s, Math.max(now(), dueSince(s))) : null,
  running: [...running.values()].some((r) => r.id === s.id)
})

const changed = (): void => emit('schedules', all().map(status))

const day = (t: number): string => new Date(t * 1000).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })

/** What the agent is asked: the schedule's message, with when it is and when it last ran. */
export function runMessage(s: Schedule, at: number): string {
  const since = s.lastRun ? `The last run was on ${day(s.lastRun)}.` : 'This is its first run.'
  return `${s.prompt.trim()}\n\n(Scheduled: "${s.name}", today is ${day(at)}. ${since} Nobody is watching this run: make the video without asking questions, check it with \`panthr check\`, and say in a line or two what you made and from what.)`
}

async function run(s: Schedule): Promise<void> {
  if ([...running.values()].some((r) => r.id === s.id)) return
  const at = now()
  let canvas: string
  if (s.project && existsSync(s.project)) canvas = real(s.project)
  else canvas = createCanvas(`${s.name} · ${new Date(at * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`).dir
  const last = loadMeta(canvas)?.chats.at(-1)
  const chatId = last ? last.id : await chats.create(canvas)
  const before = await chats.open(canvas, chatId)
  running.set(`${canvas}\n${chatId}`, { id: s.id, canvas, chatId, turn: before.items.length })
  saveAll(all().map((x) => (x.id === s.id ? { ...x, lastRun: at } : x)))
  changed()
  await chats.send(canvas, chatId, runMessage(s, at))
}

/** Its turn is over: export what it changed, say so. */
onSettled.push((dir, chatId) => {
  const k = `${dir}\n${chatId}`
  const r = running.get(k)
  if (!r) return
  running.delete(k)
  void (async () => {
    const s = all().find((x) => x.id === r.id)
    const files = checkpoints(dir).filter((c) => c.chatId === chatId && c.turn >= r.turn).flatMap((c) => c.files)
    const videos = [...new Set(files.map((f) => f.split('/')[0]))].map((seg) => join(dir, seg)).filter((d) => existsSync(join(d, 'index.html')))
    let ok = true
    if (s?.exportAfter) for (const v of videos) ok = (await renderAndWait(v)) && ok
    const name = loadMeta(dir)?.name ?? 'the project'
    const note = videos.length ? `${videos.length} video${videos.length === 1 ? '' : 's'} in ${name}${s?.exportAfter ? (ok ? ', exported' : ', export failed') : ''}` : `Nothing changed in ${name}`
    saveAll(all().map((x) => (x.id === r.id ? { ...x, last: { at: now(), dir, ok: ok && videos.length > 0, note } } : x)))
    changed()
    if (!process.env.PANTHR_SHOT && Notification?.isSupported?.()) {
      const n = new Notification({ title: s?.name ?? 'Scheduled video', body: note })
      n.on('click', () => emit('board:focus', { canvas: dir, key: videos[0] ?? dir, fresh: false }))
      n.show()
    }
  })()
})

let timer: NodeJS.Timeout | null = null

/** Run what is due (and, at start, what was missed while closed); then every half minute. */
export function startSchedules(): void {
  const tick = (): void => {
    const t = now()
    for (const s of all()) {
      if (!s.enabled) continue
      const due = nextRun(s, dueSince(s))
      if (due != null && due <= t) void run(s).catch((e) => console.error('schedule:', (e as Error).message))
    }
  }
  tick()
  timer = setInterval(tick, 30_000)
}

export function stopSchedules(): void {
  if (timer) clearInterval(timer)
  timer = null
}

export const schedulesApi: Api['schedules'] = {
  async list() {
    return all().map(status)
  },
  async save(input) {
    if (!input.name.trim()) throw new Error('Give it a name')
    if (!input.prompt.trim()) throw new Error('Say what to make')
    if (!input.days.length) throw new Error('Pick at least one day')
    if (!/^\d{1,2}:\d{2}$/.test(input.time)) throw new Error('A time like 09:00')
    const list = all()
    const old = input.id ? list.find((x) => x.id === input.id) : undefined
    const s: Schedule = {
      id: old?.id ?? randomBytes(4).toString('hex'),
      name: input.name.trim(), prompt: input.prompt.trim(), project: input.project ? real(input.project) : null,
      days: [...new Set(input.days)].sort(), time: input.time, exportAfter: input.exportAfter, enabled: input.enabled,
      // A new or changed timetable starts counting from now (no instant catch-up).
      created_at: old?.created_at ?? now(), lastRun: old && old.days.join() === input.days.join() && old.time === input.time ? old.lastRun : now(), last: old?.last ?? null
    }
    saveAll(old ? list.map((x) => (x.id === s.id ? s : x)) : [...list, s])
    changed()
    return status(s)
  },
  async remove(id) {
    saveAll(all().filter((x) => x.id !== id))
    changed()
  },
  async run(id) {
    const s = all().find((x) => x.id === id)
    if (!s) throw new Error('No such schedule')
    await run(s)
  }
}
