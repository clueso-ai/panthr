// The self-check: what Panthr looks for in a video before the agent's work
// is called done. HyperFrames' own check (lint, runtime errors, layout:
// text or shapes running off the frame, contrast) and a look at the picture
// itself over time (a frame that flashes black or white, or the picture
// going blank partway: "broken after 18 seconds"). Also a few frames for
// the agent to look at against the request and BRAND.md.
//
// `panthr check` runs it (the agent runs it before it finishes); after a
// turn that changed a video, the app runs it too, and sends the agent one
// follow-up with what it found.

import { spawn } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { exec, npx, snapshot } from './review'
import { now, toolEnv } from './paths'
import { loadMeta } from './projects'

import type { VideoCheck } from '@shared/types'
export type { VideoCheck }

const fmt = (t: number): string => `${(Math.round(t * 10) / 10).toFixed(1)}s`

/** A HyperFrames finding as one line. */
function line(section: string, f: any): string {
  const what = f?.message ?? f?.msg ?? f?.description ?? f?.rule ?? f?.code ?? JSON.stringify(f).slice(0, 160)
  const at = typeof f?.time === 'number' ? ` at ${fmt(f.time)}` : typeof f?.t === 'number' ? ` at ${fmt(f.t)}` : Array.isArray(f?.times) && f.times.length ? ` at ${f.times.slice(0, 3).map(fmt).join(', ')}` : ''
  const where = f?.selector ?? f?.element ?? f?.file ?? ''
  return `${section}: ${what}${where ? ` (${String(where).slice(0, 80)})` : ''}${at}`
}

/** HyperFrames' check: errors from every section, warnings from those that matter (layout, runtime). */
async function hyperframesCheck(dir: string): Promise<{ duration: number; problems: string[]; failed: string | null }> {
  const c = npx(['check', dir, '--json', '--samples', '9'])
  const r = await exec(c.cmd, c.args, { cwd: dir, env: c.env })
  let v: any
  try {
    v = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')))
  } catch {
    return { duration: 0, problems: [], failed: (r.stderr || r.stdout).trim().split('\n').pop() || 'HyperFrames could not check it' }
  }
  const problems: string[] = []
  const names: Record<string, string> = { lint: 'Code', runtime: 'Error while playing', layout: 'Layout', contrast: 'Contrast', motion: 'Motion' }
  for (const [k, label] of Object.entries(names)) {
    const sec = v?.[k]
    for (const f of sec?.findings ?? []) {
      const sev = String(f?.severity ?? 'error')
      if (sev === 'error' || (sev === 'warning' && (k === 'layout' || k === 'runtime'))) problems.push(line(label, f))
    }
  }
  return { duration: Number(v?.layout?.duration) || 0, problems: problems.slice(0, 20), failed: null }
}

/** The mean brightness (0-255) and spread of a frame, tiny. */
async function brightness(png: string): Promise<{ mean: number; spread: number } | null> {
  const r = await new Promise<Buffer | null>((ok) => {
    const c = spawn('ffmpeg', ['-v', 'error', '-i', png, '-vf', 'scale=32:18,format=gray', '-f', 'rawvideo', '-'], { env: toolEnv() })
    const out: Buffer[] = []
    c.stdout.on('data', (b: Buffer) => out.push(b))
    c.on('error', () => ok(null))
    c.on('close', (code) => ok(code === 0 ? Buffer.concat(out) : null))
  })
  if (!r || !r.length) return null
  let sum = 0
  for (const b of r) sum += b
  const mean = sum / r.length
  let v = 0
  for (const b of r) v += (b - mean) ** 2
  return { mean, spread: Math.sqrt(v / r.length) }
}

/** Blank: one flat colour, near black or near white. */
const blankOf = (b: { mean: number; spread: number }): 'black' | 'white' | null => (b.spread > 4 ? null : b.mean < 14 ? 'black' : b.mean > 241 ? 'white' : null)

/** Flashes (one blank frame between pictures) and blank stretches (the picture gone for a while).
 *  A single black frame counts only when the picture is the same either side
 *  of it (a glitch, not a dip to black between scenes); a white one always does. */
export function scanPicture(series: { t: number; kind: 'black' | 'white' | null; mean?: number }[], duration: number): string[] {
  const out: string[] = []
  const n = series.length
  const first = series.findIndex((s) => !s.kind)
  if (first < 0) return n ? [`The picture is ${series[0].kind} the whole way through: nothing is showing`] : []
  for (let i = first + 1; i < n - 1; i++) {
    const s = series[i]
    if (!s.kind || series[i - 1].kind || series[i + 1].kind) continue
    const a = series[i - 1].mean
    const b = series[i + 1].mean
    const sameEitherSide = a != null && b != null && Math.abs(a - b) < 8
    if (s.kind === 'white' || sameEitherSide) out.push(`A ${s.kind} flash at ${fmt(s.t)}`)
  }
  // Runs of blank after the picture has begun (a fade at either end is fine).
  for (let i = first; i < n; i++) {
    if (!series[i].kind) continue
    let j = i
    while (j + 1 < n && series[j + 1].kind) j++
    const from = series[i].t
    const to = j + 1 < n ? series[j + 1].t : duration
    const toEnd = j === n - 1
    if (j > i && to - from >= 1.5 && !(toEnd && to - from <= 1.5)) {
      out.push(toEnd ? `The picture goes ${series[i].kind} from ${fmt(from)} to the end (${fmt(duration)})` : `The picture goes ${series[i].kind} from ${fmt(from)} to ${fmt(to)}`)
    }
    i = j
  }
  return out.slice(0, 8)
}

/** Check one video. */
export async function checkVideo(dir: string): Promise<VideoCheck> {
  const name = loadMeta(dir)?.name ?? dir.split('/').pop() ?? dir
  const hf = await hyperframesCheck(dir)
  const problems = hf.failed ? [`HyperFrames could not check it: ${hf.failed}`] : [...hf.problems]
  const duration = hf.duration
  const frames: string[] = []
  if (duration > 0) {
    // The picture every half second or so (at most 120 frames).
    const step = Math.max(0.25, duration / 120)
    const times: number[] = []
    for (let t = step / 2; t < duration; t += step) times.push(Math.round(t * 1000) / 1000)
    const rel = `.studio/check/${now()}`
    const out = join(dir, rel)
    rmSync(join(dir, '.studio', 'check'), { recursive: true, force: true })
    mkdirSync(out, { recursive: true })
    if (await snapshot(dir, times.join(','), rel)) {
      const files = readdirSync(out).filter((f) => f.endsWith('.png')).sort()
      const timed = files.map((f) => ({ f: join(out, f), t: Number(/-at-([\d.]+)s/.exec(f)?.[1] ?? NaN) })).filter((x) => !Number.isNaN(x.t)).sort((a, b) => a.t - b.t)
      const series: { t: number; kind: 'black' | 'white' | null; mean: number }[] = []
      for (let i = 0; i < timed.length; i += 8) {
        const got = await Promise.all(timed.slice(i, i + 8).map(async (x) => ({ t: x.t, b: await brightness(x.f) })))
        for (const g of got) if (g.b) series.push({ t: g.t, kind: blankOf(g.b), mean: g.b.mean })
      }
      problems.push(...scanPicture(series, duration))
      // Six frames across it, for the agent to look at.
      for (let k = 0; k < 6 && timed.length; k++) frames.push(timed[Math.min(timed.length - 1, Math.floor(((k + 0.5) / 6) * timed.length))].f)
    } else problems.push('Its frames could not be made (the page may not load)')
  }
  return { dir, name, duration, problems, frames: [...new Set(frames)] }
}

/** What the agent is told about a check, as a message. */
export function checkMessage(checks: VideoCheck[]): string {
  const bad = checks.filter((c) => c.problems.length)
  const head = bad.length
    ? `Self-check found ${bad.reduce((n, c) => n + c.problems.length, 0)} problem${bad.reduce((n, c) => n + c.problems.length, 0) === 1 ? '' : 's'} in ${bad.map((c) => `"${c.name}"`).join(', ')}. Fix them.`
    : 'Self-check: nothing wrong found.'
  const detail = checks.map((c) => [
    `"${c.name}" (${c.dir}, ${c.duration ? fmt(c.duration) : 'length unknown'}):`,
    ...(c.problems.length ? c.problems.map((p) => `- ${p}`) : ['- no problems found']),
    c.frames.length ? `Frames to look at: ${c.frames.join(', ')}` : ''
  ].filter(Boolean).join('\n')).join('\n\n')
  return `${head}\n\n(Self-check: ${detail}\n\nLook at the frames against what was asked and BRAND.md (if there is one) as well. Fix what is wrong, then run \`panthr check\` again on what you changed. If something here is intended, say so in one line and leave it.)`
}
