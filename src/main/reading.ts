// Reading a reference video before the agent looks at it: the things an
// agent cannot get from stills. Everything runs on this Mac, and each step is
// skipped (and says so) when its tool is missing, so a reading never fails
// for want of one.
//
//   reading/shots.json            shots (PySceneDetect's adaptive detector
//                                 via uvx, else Panthr's own from motion)
//   reading/transcript.json|.txt  what is said, word by word (hyperframes
//                                 transcribe: Whisper or Parakeet)
//   reading/text-on-screen.json|.md  text in the frames (Apple's Vision)
//   reading/rhythm.json           tempo, beats, onsets, loudness (from the
//                                 audio, decoded by ffmpeg)
//   reading/palette.json          the main colours of each shot
//   reading/motion.json           how much the picture changes, 10 times a second
//   reading/README.md             what is here, and what was skipped and why

import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { resource, toolEnv } from './paths'

const run = promisify(execFile)

export interface Shot { start: number; end: number }
export interface Word { text: string; start: number; end: number }

/** A program's raw stdout (ffmpeg decoding to raw samples or pixels). */
function raw(cmd: string, args: string[], timeoutMs = 300_000): Promise<Buffer> {
  return new Promise((ok, fail) => {
    const c = spawn(cmd, args, { env: toolEnv(), stdio: ['ignore', 'pipe', 'ignore'] })
    const chunks: Buffer[] = []
    const t = setTimeout(() => c.kill('SIGKILL'), timeoutMs)
    c.stdout.on('data', (b: Buffer) => chunks.push(b))
    c.on('error', fail)
    c.on('close', (code) => {
      clearTimeout(t)
      code === 0 ? ok(Buffer.concat(chunks)) : fail(new Error(`${cmd} exited ${code}`))
    })
  })
}

// ── Motion, and cuts from it ──────────────────────────────────────────

const W = 96
const H = 54

/** How much each frame differs from the one before (0..1), at `fps`. */
export function motionCurve(gray: Buffer, w = W, h = H): number[] {
  const n = Math.floor(gray.length / (w * h))
  const out = [0]
  for (let i = 1; i < n; i++) {
    let d = 0
    const a = (i - 1) * w * h
    const b = i * w * h
    for (let k = 0; k < w * h; k++) d += Math.abs(gray[b + k] - gray[a + k])
    out.push(Math.round((d / (w * h * 255)) * 1000) / 1000)
  }
  return out
}

/** Cuts: frames that change far more than their neighbourhood (and enough
 *  in absolute terms), at least `minGap` seconds apart. */
export function cutsFromMotion(m: number[], fps: number, minGap = 0.4): number[] {
  const out: number[] = []
  const win = Math.max(3, Math.round(fps * 2))
  for (let i = 1; i < m.length; i++) {
    const lo = Math.max(1, i - win)
    const hi = Math.min(m.length, i + win + 1)
    const around = m.slice(lo, hi).filter((_, k) => lo + k !== i)
    const mean = around.reduce((a, b) => a + b, 0) / Math.max(1, around.length)
    const sd = Math.sqrt(around.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, around.length))
    const peak = m[i] >= (m[i - 1] ?? 0) && m[i] >= (m[i + 1] ?? 0)
    if (peak && m[i] > 0.08 && m[i] > mean + 4 * sd + 0.02) {
      const t = Math.round((i / fps) * 100) / 100
      if (!out.length || t - out[out.length - 1] >= minGap) out.push(t)
    }
  }
  return out
}

export const shotsFrom = (cuts: number[], duration: number): Shot[] => {
  const edges = [0, ...cuts.filter((c) => c > 0.05 && c < duration - 0.05), duration]
  return edges.slice(1).map((e, i) => ({ start: edges[i], end: Math.round(e * 100) / 100 }))
}

/** PySceneDetect's list-scenes CSV: the start and end of each scene, in seconds. */
export function parseSceneCsv(csv: string): Shot[] {
  const rows = csv.trim().split(/\r?\n/)
  const head = rows.findIndex((r) => /Scene Number/i.test(r))
  if (head < 0) return []
  const cols = rows[head].split(',')
  const s = cols.findIndex((c) => /Start Time \(seconds\)/i.test(c))
  const e = cols.findIndex((c) => /End Time \(seconds\)/i.test(c))
  if (s < 0 || e < 0) return []
  return rows.slice(head + 1).map((r) => r.split(',')).filter((c) => c.length > e).map((c) => ({ start: Number(c[s]), end: Number(c[e]) }))
}

// ── Colour ────────────────────────────────────────────────────────────

const hex = (r: number, g: number, b: number): string => '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')

/** The k main colours of an RGB image, by share (k-means, seeded by spread). */
export function palette(rgb: Buffer, k = 5): { hex: string; share: number }[] {
  const n = Math.floor(rgb.length / 3)
  if (!n) return []
  const px = (i: number): [number, number, number] => [rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]]
  // Seeds: evenly through the pixels sorted by brightness.
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => px(a).reduce((x, y) => x + y) - px(b).reduce((x, y) => x + y))
  let cs = Array.from({ length: k }, (_, j) => px(order[Math.floor(((j + 0.5) * n) / k)]))
  const assign = new Array<number>(n).fill(0)
  for (let it = 0; it < 12; it++) {
    for (let i = 0; i < n; i++) {
      const p = px(i)
      let best = 0
      let bd = Infinity
      cs.forEach((c, j) => {
        const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2
        if (d < bd) {
          bd = d
          best = j
        }
      })
      assign[i] = best
    }
    cs = cs.map((c, j) => {
      const sum = [0, 0, 0]
      let m = 0
      for (let i = 0; i < n; i++) if (assign[i] === j) {
        const p = px(i)
        sum[0] += p[0]
        sum[1] += p[1]
        sum[2] += p[2]
        m++
      }
      return m ? ([sum[0] / m, sum[1] / m, sum[2] / m] as [number, number, number]) : c
    })
  }
  const counts = cs.map((_, j) => assign.filter((a) => a === j).length)
  return cs.map((c, j) => ({ hex: hex(...c), share: Math.round((counts[j] / n) * 100) / 100 })).filter((c) => c.share > 0).sort((a, b) => b.share - a.share)
}

// ── Rhythm ────────────────────────────────────────────────────────────

const SR = 11025
const HOP = 256

/** Loudness per hop (RMS) of mono f32 samples. */
export function rmsEnvelope(f32: Float32Array, hop = HOP): number[] {
  const out: number[] = []
  for (let i = 0; i + hop <= f32.length; i += hop) {
    let s = 0
    for (let k = i; k < i + hop; k++) s += f32[k] * f32[k]
    out.push(Math.sqrt(s / hop))
  }
  return out
}

/** Tempo and beats from a loudness envelope: onsets are rises in loudness;
 *  the beat period is the lag (60–180 BPM) where onsets line up best, its
 *  phase where they fall most strongly on it. */
export function rhythm(env: number[], rate = SR / HOP): { bpm: number | null; beats: number[]; onsets: number[]; confidence: number } {
  const on = env.map((v, i) => Math.max(0, v - (env[i - 1] ?? v)))
  const mean = on.reduce((a, b) => a + b, 0) / Math.max(1, on.length)
  const onsets: number[] = []
  for (let i = 1; i < on.length - 1; i++) {
    if (on[i] > mean * 3 && on[i] >= on[i - 1] && on[i] >= on[i + 1]) {
      const t = Math.round((i / rate) * 100) / 100
      if (!onsets.length || t - onsets[onsets.length - 1] > 0.08) onsets.push(t)
    }
  }
  const minLag = Math.round((rate * 60) / 180)
  const maxLag = Math.round((rate * 60) / 60)
  const score = (lag: number): number => {
    let s = 0
    for (let i = lag; i < on.length; i++) s += on[i] * on[i - lag]
    return s
  }
  let best = 0
  let bestLag = 0
  let total = 0
  for (let lag = minLag; lag <= maxLag && lag < on.length; lag++) {
    const s = score(lag)
    total += s
    if (s > best) {
      best = s
      bestLag = lag
    }
  }
  if (!bestLag || !best) return { bpm: null, beats: [], onsets, confidence: 0 }
  // Octave errors: a beat every p also lines up every 2p. Prefer the shorter
  // period whenever it fits nearly as well (and is still a tempo).
  for (;;) {
    const half = Math.round(bestLag / 2)
    if (half < minLag) break
    const sh = Math.max(score(half - 1), score(half), score(half + 1))
    if (sh < best * 0.7) break
    bestLag = [half - 1, half, half + 1].reduce((a, b) => (score(b) > score(a) ? b : a))
    best = sh
  }
  const avg = total / (maxLag - minLag + 1)
  const confidence = Math.round(Math.min(1, (best / Math.max(1e-9, avg) - 1) / 3) * 100) / 100
  let phase = 0
  let ps = -1
  for (let p = 0; p < bestLag; p++) {
    let s = 0
    for (let i = p; i < on.length; i += bestLag) s += on[i]
    if (s > ps) {
      ps = s
      phase = p
    }
  }
  const beats: number[] = []
  for (let i = phase; i < on.length; i += bestLag) beats.push(Math.round((i / rate) * 100) / 100)
  return { bpm: Math.round((rate * 60 * 10) / bestLag) / 10, beats, onsets, confidence }
}

// ── The pass ──────────────────────────────────────────────────────────

export interface Reading {
  shots: { method: string; list: Shot[] }
  words: number
  textLines: number
  bpm: number | null
  notes: string[]
}

/** Group words into lines (a pause or a full stop ends one). */
export function transcriptLines(words: Word[]): string[] {
  const lines: string[] = []
  let cur: Word[] = []
  const flush = (): void => {
    if (!cur.length) return
    lines.push(`[${cur[0].start.toFixed(2)}–${cur[cur.length - 1].end.toFixed(2)}] ${cur.map((w) => w.text).join(' ')}`)
    cur = []
  }
  words.forEach((w, i) => {
    if (cur.length && w.start - cur[cur.length - 1].end > 0.6) flush()
    cur.push(w)
    if (/[.!?]$/.test(w.text) || i === words.length - 1) flush()
  })
  return lines
}

async function shotsByPySceneDetect(video: string, out: string): Promise<Shot[] | null> {
  try {
    await run('uvx', ['--from', 'scenedetect[opencv-headless]', 'scenedetect', '-q', '-i', video, '-o', out, 'detect-adaptive', 'list-scenes', '-f', 'scenes'], { env: toolEnv(), timeout: 240_000, maxBuffer: 16 << 20 })
    const f = readdirSync(out).find((n) => /^scenes.*\.csv$/i.test(n))
    return f ? parseSceneCsv(readFileSync(join(out, f), 'utf8')) : null
  } catch {
    return null
  }
}

export async function readVideo(dir: string, video: string, info: { duration: number; hasAudio: boolean; stills: string[] }, step: (s: string) => void): Promise<Reading> {
  const out = join(dir, 'reading')
  mkdirSync(out, { recursive: true })
  const notes: string[] = []
  const save = (name: string, v: unknown): void => writeFileSync(join(out, name), typeof v === 'string' ? v : JSON.stringify(v, null, 1))
  const d = info.duration

  // Motion (and Panthr's own cuts), 10 frames a second (fewer for long videos).
  step('Measuring motion')
  const fps = d > 300 ? 4 : 10
  let motion: number[] = []
  try {
    motion = motionCurve(await raw('ffmpeg', ['-v', 'error', '-i', video, '-vf', `fps=${fps},scale=${W}:${H},format=gray`, '-f', 'rawvideo', '-']))
    save('motion.json', { fps, note: 'mean absolute change from the frame before, 0 to 1', values: motion })
  } catch (e) {
    notes.push(`motion: skipped (${(e as Error).message})`)
  }

  step('Finding the shots')
  let shots = await shotsByPySceneDetect(video, out)
  let method = 'PySceneDetect adaptive detector'
  if (!shots || !shots.length) {
    method = shots ? 'PySceneDetect found one shot' : 'Panthr motion detector (PySceneDetect unavailable: needs uv)'
    shots = shots && shots.length ? shots : shotsFrom(cutsFromMotion(motion, fps), d)
  }
  save('shots.json', { method, shots })

  step('Reading the colours')
  const palettes: { start: number; end: number; colors: { hex: string; share: number }[] }[] = []
  for (const s of shots.slice(0, 80)) {
    try {
      const rgb = await raw('ffmpeg', ['-v', 'error', '-ss', String((s.start + s.end) / 2), '-i', video, '-frames:v', '1', '-vf', 'scale=64:36', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
      palettes.push({ ...s, colors: palette(rgb) })
    } catch {}
  }
  save('palette.json', { note: 'the main colours of the middle frame of each shot, with the share of the frame each covers', shots: palettes })

  let bpm: number | null = null
  let words = 0
  if (info.hasAudio) {
    step('Listening for the beat')
    try {
      const pcm = await raw('ffmpeg', ['-v', 'error', '-i', video, '-t', '600', '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'])
      const f32 = new Float32Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 4))
      const env = rmsEnvelope(f32)
      const r = rhythm(env)
      bpm = r.bpm
      const per = Math.round(SR / HOP / 10)
      const loud = Array.from({ length: Math.floor(env.length / per) }, (_, i) => {
        const v = Math.max(...env.slice(i * per, (i + 1) * per))
        return v > 0 ? Math.round(20 * Math.log10(v) * 10) / 10 : -99
      })
      save('rhythm.json', { note: 'tempo and beats estimated from rises in loudness; trust it when confidence is high and the beats match the cuts', ...r, loudness_dbfs_10hz: loud })
    } catch (e) {
      notes.push(`rhythm: skipped (${(e as Error).message})`)
    }
    step('Listening for words')
    try {
      await run('npx', ['-y', 'hyperframes', 'transcribe', video, '--json', '-d', out, '-m', 'base.en', '--optional'], { env: toolEnv(), timeout: 900_000, maxBuffer: 64 << 20 })
      const t = JSON.parse(readFileSync(join(out, 'transcript.json'), 'utf8'))
      const ws: Word[] = (Array.isArray(t) ? t : t.words ?? t.segments?.flatMap((s: { words?: Word[] }) => s.words ?? []) ?? []).filter((w: Word) => w && typeof w.start === 'number')
      words = ws.length
      save('transcript.txt', ws.length ? transcriptLines(ws).join('\n') + '\n' : 'No speech found.\n')
    } catch (e) {
      notes.push(`transcript: skipped (${(e as Error).message.split('\n')[0]})`)
    }
  } else notes.push('rhythm, transcript: the video has no sound')

  step('Reading the text on screen')
  let textLines = 0
  const ocr = resource('bin/panthr-ocr')
  if (existsSync(ocr) && info.stills.length) {
    try {
      const { stdout } = await run(ocr, info.stills, { env: toolEnv(), timeout: 240_000, maxBuffer: 32 << 20 })
      const per = stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { file: string; lines: { text: string; confidence: number; box: number[] }[] })
      const rows = per.map((p) => {
        const m = /(?:t|cut)-(\d+\.\d+)\.jpg$/.exec(p.file)
        return { time: m ? Number(m[1]) : null, file: p.file.slice(dir.length + 1), lines: p.lines.filter((l) => l.confidence >= 0.3) }
      }).sort((a, b) => (a.time ?? 0) - (b.time ?? 0))
      textLines = rows.reduce((a, r) => a + r.lines.length, 0)
      save('text-on-screen.json', { note: 'text found in each still by Apple Vision; box is [x, y, w, h] in fractions of the frame from the top left', stills: rows })
      let last = ''
      const md = rows.filter((r) => r.lines.length).map((r) => {
        const txt = r.lines.map((l) => l.text).join(' / ')
        if (txt === last) return null
        last = txt
        return `- ${r.time?.toFixed(2) ?? '?'} s: ${txt}`
      }).filter(Boolean)
      save('text-on-screen.md', `# Text on screen\n\n${md.length ? md.join('\n') : 'None found in the stills.'}\n`)
    } catch (e) {
      notes.push(`text on screen: skipped (${(e as Error).message.split('\n')[0]})`)
    }
  } else notes.push('text on screen: skipped (the OCR helper is not in this build)')

  const readme = `# What Panthr measured

Before the agent looked, Panthr read this video with tools that run on this Mac.

| File | What it holds |
|---|---|
| shots.json | ${shots.length} shot${shots.length === 1 ? '' : 's'}, by ${method}. |
| palette.json | The main colours of each shot, with the share of the frame each covers. |
| motion.json | How much the picture changes, ${fps} times a second (spikes are cuts or fast moves). |
${info.hasAudio ? `| rhythm.json | ${bpm ? `About ${bpm} BPM` : 'No steady tempo found'}; beat and onset times; loudness 10 times a second. |\n| transcript.json, transcript.txt | ${words ? `${words} words, each with its time` : 'No speech found'}. |\n` : ''}| text-on-screen.json, .md | ${textLines} line${textLines === 1 ? '' : 's'} of text found in the stills, with where they sit. |
${notes.length ? `\nSkipped or missing:\n${notes.map((n) => `- ${n}`).join('\n')}\n` : ''}`
  save('README.md', readme)
  return { shots: { method, list: shots }, words, textLines, bpm, notes }
}
