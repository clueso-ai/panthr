// A video's storyboard, as the HyperFrames skills have the agent write it:
// STORYBOARD.md (the frames in order: title, length, what is on screen, the
// voiceover, and how far along each is: outline, built, animated) and
// storyboard.html (a sketch of each frame, in cells with id="frame-NN").
// Panther shows it as a board to review frame by frame: a still of each
// sketch, taken in a hidden window, and the person's notes and approvals
// (.studio/storyboard-review.json), which go to the agent as one message.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow } from 'electron'
import type { Api } from '@shared/api'
import type { Storyboard, StoryboardFrame, StoryboardReview } from '@shared/types'
import { readJson, writeJson } from './json'
import { fileUrl } from './preview'

/** A value without the quotes around it (only when it is quoted at both ends). */
const unquote = (v: string): string => {
  const t = v.trim()
  return t.length > 1 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0] && !t.slice(1, -1).includes(t[0]) ? t.slice(1, -1) : t
}

/** STORYBOARD.md, leniently: its frontmatter and its `## Frame N — Title` sections. */
export function parseStoryboard(md: string): { globals: Record<string, string>; frames: StoryboardFrame[] } {
  const globals: Record<string, string> = {}
  let body = md
  const fm = /^---\s*\n([\s\S]*?)\n---\s*\n?/.exec(md)
  if (fm) {
    for (const line of fm[1].split('\n')) {
      const m = /^([\w-]+)\s*:\s*(.*)$/.exec(line.trim())
      if (m) globals[m[1].toLowerCase()] = unquote(m[2])
    }
    body = md.slice(fm[0].length)
  }
  const frames: StoryboardFrame[] = []
  const heads = [...body.matchAll(/^#{2,3}\s+(?:Frame|Beat|Scene)\s+(\d+)\s*(?:[—–:-]+\s*(.*))?$/gim)]
  heads.forEach((h, i) => {
    const end = i + 1 < heads.length ? heads[i + 1].index! : body.length
    const section = body.slice(h.index! + h[0].length, end)
    const meta: Record<string, string> = {}
    const lines = section.split('\n')
    let k = 0
    // The `- key: value` bullets first; the rest is its narrative.
    for (; k < lines.length; k++) {
      const l = lines[k].trim()
      if (!l) continue
      const m = /^[-*]\s*([\w-]+)\s*:\s*(.*)$/.exec(l)
      if (!m) break
      meta[m[1].toLowerCase()] = unquote(m[2])
    }
    const status = (meta.status || 'outline').toLowerCase()
    frames.push({
      n: Number(h[1]),
      title: (h[2] || '').trim(),
      status: status === 'animated' ? 'animated' : status === 'built' ? 'built' : 'outline',
      duration: meta.duration || null,
      scene: meta.scene || meta.description || meta.summary || meta.caption || null,
      voiceover: meta.voiceover || meta.vo || meta.voice_over || meta.narration || null,
      transition: meta.transition_in || meta.transition || null,
      narrative: lines.slice(k).join('\n').trim(),
      still: null
    })
  })
  return { globals, frames }
}

const mdPath = (dir: string): string => join(dir, 'STORYBOARD.md')
const sheetPath = (dir: string): string => join(dir, 'storyboard.html')
const reviewPath = (dir: string): string => join(dir, '.studio', 'storyboard-review.json')
const stillsDir = (dir: string): string => join(dir, '.studio', 'storyboard')

const cellId = (n: number): string[] => [`frame-${String(n).padStart(2, '0')}`, `frame-${n}`]

/** Stills of the sheet's cells, taken again when the sheet changes (one run at a time per folder). */
const taking = new Map<string, Promise<Record<number, string>>>()
async function stills(dir: string, frames: number[]): Promise<Record<number, string>> {
  const sheet = sheetPath(dir)
  if (!existsSync(sheet)) return {}
  const stamp = String(statSync(sheet).mtimeMs)
  const out = stillsDir(dir)
  const done = readJson<{ stamp: string; files: Record<number, string> } | null>(join(out, 'stills.json'), null)
  if (done?.stamp === stamp) return done.files
  const running = taking.get(dir)
  if (running) return running
  const job = (async (): Promise<Record<number, string>> => {
    if (typeof (BrowserWindow as any) !== 'function') return {}
    mkdirSync(out, { recursive: true })
    const win = new BrowserWindow({ show: false, width: 1800, height: 1100, webPreferences: { javascript: true, sandbox: true } })
    const files: Record<number, string> = {}
    try {
      await win.loadFile(sheet)
      await win.webContents.executeJavaScript('document.fonts ? document.fonts.ready.then(() => 1) : 1')
      await new Promise((r) => setTimeout(r, 350))
      for (const n of frames) {
        const ids = cellId(n)
        const rect = await win.webContents.executeJavaScript(`(() => {
          const e = ${JSON.stringify(ids)}.map((i) => document.getElementById(i)).find(Boolean)
          if (!e) return null
          const r0 = e.getBoundingClientRect()
          scrollTo(0, Math.max(0, r0.top + scrollY - 16))
          const r = e.getBoundingClientRect()
          return { x: Math.max(0, Math.floor(r.left)), y: Math.max(0, Math.floor(r.top)), w: Math.ceil(r.width), h: Math.ceil(Math.min(r.height, innerHeight - r.top)) }
        })()`)
        if (!rect || rect.w < 8 || rect.h < 8) continue
        await new Promise((r) => setTimeout(r, 60))
        const img = await win.webContents.capturePage({ x: rect.x, y: rect.y, width: rect.w, height: rect.h })
        const file = join(out, `frame-${String(n).padStart(2, '0')}.png`)
        writeFileSync(file, img.toPNG())
        files[n] = file
      }
    } catch {
      // A sheet that won't load: the board shows its outline.
    } finally {
      win.destroy()
    }
    writeJson(join(out, 'stills.json'), { stamp, files })
    return files
  })()
  taking.set(dir, job)
  try {
    return await job
  } finally {
    taking.delete(dir)
  }
}

export async function getStoryboard(dir: string): Promise<Storyboard | null> {
  if (!existsSync(mdPath(dir))) return null
  const { globals, frames } = parseStoryboard(readFileSync(mdPath(dir), 'utf8'))
  if (!frames.length) return null
  const files = await stills(dir, frames.map((f) => f.n))
  const review = readJson<StoryboardReview>(reviewPath(dir), { approved: [], notes: {} })
  return {
    dir,
    message: globals.message ?? null,
    format: globals.format ?? null,
    duration: globals.duration ?? null,
    sheet: existsSync(sheetPath(dir)),
    frames: frames.map((f) => ({ ...f, still: files[f.n] ? `${fileUrl(files[f.n])}?v=${Math.round(statSync(files[f.n]).mtimeMs)}` : null })),
    review: { approved: review.approved ?? [], notes: review.notes ?? {} }
  }
}

export const storyboardApi: Api['storyboard'] = {
  async get(dir) {
    return getStoryboard(dir)
  },
  async review(dir, review) {
    writeJson(reviewPath(dir), review)
  }
}
