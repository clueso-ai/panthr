// Captions, word by word: the transcript a video's captions are made from
// (HyperFrames' shape: [{ id, text, start, end }], usually transcript.json),
// found in the video's folder, its words fixed one at a time, and made in
// the first place by transcribing a clip's sound (`hyperframes transcribe`).

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import type { Api } from '@shared/api'
import type { Transcript, Word } from '@shared/types'
import { exec, npx } from './review'

const isWords = (v: unknown): v is Word[] =>
  Array.isArray(v) && v.length > 0 && v.every((w) => w && typeof w.text === 'string' && typeof w.start === 'number' && typeof w.end === 'number')

/** Where its words are: the array itself, or { words: [...] }. */
function wordsOf(v: any): Word[] | null {
  if (isWords(v)) return v
  if (v && isWords(v.words)) return v.words
  return null
}

const SKIP = new Set(['node_modules', '.studio', '.hyperframes', 'beats', 'renders', 'out', '.git'])

/** The video's transcripts: JSON files of timed words in its folder (two levels down). */
export function transcripts(dir: string): Transcript[] {
  const out: Transcript[] = []
  const walk = (d: string, depth: number): void => {
    let names: string[] = []
    try {
      names = readdirSync(d)
    } catch {
      return
    }
    for (const n of names) {
      const p = join(d, n)
      let st
      try {
        st = statSync(p)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        if (depth < 2 && !SKIP.has(n) && !n.startsWith('.')) walk(p, depth + 1)
      } else if (n.endsWith('.json') && st.size < 4_000_000 && !/^(package|hyperframes|tsconfig|meta)\.json$/.test(n)) {
        try {
          const words = wordsOf(JSON.parse(readFileSync(p, 'utf8')))
          if (words && words.length >= 2) out.push({ file: relative(dir, p), words: words.map((w, i) => ({ id: w.id ?? `w${i}`, text: w.text, start: w.start, end: w.end })) })
        } catch {}
      }
    }
  }
  walk(dir, 0)
  // transcript.json first, then the longest.
  return out.sort((a, b) => Number(/(^|\/)transcript\.json$/.test(b.file)) - Number(/(^|\/)transcript\.json$/.test(a.file)) || b.words.length - a.words.length)
}

function inside(dir: string, rel: string): string {
  const p = resolve(dir, rel)
  if (!p.startsWith(resolve(dir) + sep)) throw new Error('outside the video')
  return p
}

/** Words fixed by hand: their text (and times) written back, everything else in the file kept. */
export function saveWords(dir: string, file: string, words: Word[]): { before: string; after: string } {
  const p = inside(dir, file)
  const before = readFileSync(p, 'utf8')
  const v = JSON.parse(before)
  const list = wordsOf(v)
  if (!list) throw new Error('that file has no words')
  const byId = new Map(words.map((w) => [w.id, w]))
  list.forEach((w: any, i) => {
    const n = byId.get(w.id ?? `w${i}`)
    if (!n) return
    w.text = n.text
    w.start = n.start
    w.end = n.end
  })
  const after = JSON.stringify(v, null, 2) + '\n'
  writeFileSync(p, after)
  return { before, after }
}

/** Transcribe a clip's sound into the video's transcript.json. */
export async function transcribe(dir: string, src: string): Promise<Transcript> {
  const file = inside(dir, src)
  if (!existsSync(file)) throw new Error('that file is missing')
  const n = npx(['transcribe', file, '--dir', dir, '--json'])
  const r = await exec(n.cmd, n.args, { cwd: dir, env: n.env })
  if (!r.ok) throw new Error((r.stderr || r.stdout).trim().split('\n').filter((l) => !l.startsWith('{')).pop() || 'transcribing failed')
  const t = transcripts(dir).find((x) => /(^|\/)transcript\.json$/.test(x.file)) ?? transcripts(dir)[0]
  if (!t) throw new Error('no words came back')
  return t
}

export const captionsApi: Api['captions'] = {
  async list(dir) {
    return transcripts(dir)
  },
  async save(dir, file, words) {
    return { file, ...saveWords(dir, file, words) }
  },
  transcribe
}
