// One video in every size: a copy of it for each frame (9:16, 1:1, 4:5,
// 16:9), its composition set to that size, beside it on the canvas with an
// arrow from it; then one message to the project's agent to lay each out
// again for its frame (not crop it); and, once the agent's turn is over
// (self-check and all), each exported, one after another.
//
// What is waiting to be exported is kept in the project's
// .studio/sizes.json, so a quit in between loses nothing: it goes when
// that chat next settles.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Api } from '@shared/api'
import { branch, real } from './board'
import { chats, onSettled } from './chats'
import { readJson, writeJson } from './json'
import { loadMeta } from './projects'
import { renderAndWait } from './review'

export const SIZES: Record<string, { w: number; h: number; what: string }> = {
  '9:16': { w: 1080, h: 1920, what: 'vertical (Reels, Shorts, TikTok)' },
  '1:1': { w: 1080, h: 1080, what: 'square' },
  '4:5': { w: 1080, h: 1350, what: 'portrait (feed)' },
  '16:9': { w: 1920, h: 1080, what: 'wide' }
}

interface Pending {
  chatId: string
  dirs: string[]
}

const file = (canvas: string): string => join(canvas, '.studio', 'sizes.json')
const pending = (canvas: string): Pending[] => readJson<Pending[]>(file(canvas), [])

/** Set a composition's frame: the root's data-width and data-height (its CSS is the agent's to follow). */
export function setFrame(dir: string, w: number, h: number): boolean {
  const p = join(dir, 'index.html')
  let html: string
  try {
    html = readFileSync(p, 'utf8')
  } catch {
    return false
  }
  // The first element that declares the composition's size.
  const m = /<[^>]*data-width="\d+"[^>]*>/.exec(html)
  if (!m) return false
  const tag = m[0].replace(/data-width="\d+"/, `data-width="${w}"`).replace(/data-height="\d+"/, `data-height="${h}"`)
  writeFileSync(p, html.slice(0, m.index) + tag + html.slice(m.index + m[0].length))
  return true
}

/** What the agent is asked. */
export function sizesMessage(made: { name: string; from: string; dir: string; size: string }[]): string {
  const lines = made.map((m) => `- "${m.name}" (folder "${m.dir}"): ${SIZES[m.size].w}×${SIZES[m.size].h}, ${SIZES[m.size].what}; a copy of "${m.from}"`)
  return [
    `Lay these out again for their frames. Each is a copy of its video with the composition already set to the new size (data-width and data-height on the root); make its CSS and every scene fit that frame.`,
    ...lines,
    `Re-compose, don't crop or letterbox: move and re-scale type, logos and shapes so each reads well in its frame (bigger type and stacked layouts for vertical, tighter for square). Keep the content, timing, motion and brand of the original. Work only in these folders. Run \`panthr check\` on each when you are done. Each is exported when you finish.`
  ].join('\n')
}

export async function makeSizes(canvas0: string, dirs: string[], sizes: string[], exportAfter: boolean): Promise<{ dirs: string[]; chatId: string }> {
  const canvas = real(canvas0)
  const wanted = sizes.filter((s) => SIZES[s])
  if (!wanted.length) throw new Error('Which sizes? 9:16, 1:1, 4:5 or 16:9')
  const made: { name: string; from: string; dir: string; size: string }[] = []
  for (const d of dirs) {
    const from = loadMeta(d)?.name ?? d.split('/').pop() ?? 'Video'
    for (const size of wanted) {
      const p = branch(canvas, d, `${from} ${size}`)
      setFrame(p.dir, SIZES[size].w, SIZES[size].h)
      made.push({ name: p.meta.name, from, dir: p.dir.slice(canvas.length + 1) || p.dir, size })
    }
  }
  const last = loadMeta(canvas)?.chats.at(-1)
  const chatId = last ? last.id : await chats.create(canvas)
  if (exportAfter) writeJson(file(canvas), [...pending(canvas), { chatId, dirs: made.map((m) => join(canvas, m.dir)) }])
  await chats.send(canvas, chatId, sizesMessage(made))
  return { dirs: made.map((m) => join(canvas, m.dir)), chatId }
}

/** Exporting what was waiting on this chat (one at a time). */
const exporting = new Set<string>()

onSettled.push((dir, chatId) => {
  const mine = pending(dir).filter((p) => p.chatId === chatId)
  if (!mine.length || exporting.has(dir)) return
  writeJson(file(dir), pending(dir).filter((p) => p.chatId !== chatId))
  exporting.add(dir)
  void (async () => {
    try {
      for (const d of mine.flatMap((p) => p.dirs)) await renderAndWait(d)
    } finally {
      exporting.delete(dir)
    }
  })()
})

export const sizesApi: Pick<Api['board'], 'sizes'> = {
  async sizes(canvas, dirs, sizes, exportAfter) {
    return makeSizes(canvas, dirs, sizes, exportAfter)
  }
}
