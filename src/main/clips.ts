// The clips on a video's timeline: its media and timed elements, read and
// edited with HyperFrames' own timeline tool (`hyperframes timeline`), which
// splits, trims, moves, duplicates, deletes and sets volume and speed. On
// top of it, Panther's own: fades and ducking under a voice (one volume lane
// in the clip's data-automation), evening out loudness (data-volume from a
// measurement), a freeze frame, closing the gap a delete leaves, and what
// the timeline draws: waveforms, peaks and the music's beats.
//
// Every edit returns the file before and after, so the editor can undo it.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import type { Api } from '@shared/api'
import type { Clip, ClipEdit, ClipEditResult, ClipSound } from '@shared/types'
import { exec, npx } from './review'
import { runEdit } from './controls'
import { toolEnv } from './paths'

const r3 = (n: number): number => Math.round(n * 1000) / 1000

const VERBS = new Set(['split', 'trim', 'move', 'delete', 'set', 'duplicate'])

/** HyperFrames' timeline tool on a video (a verb, or none to read it); its JSON answer. */
async function timeline(dir: string, args: string[]): Promise<any> {
  const n = npx(['timeline', ...(VERBS.has(args[0]) ? [...args, '--dir', dir] : [dir]), '--json'])
  const r = await exec(n.cmd, n.args, { cwd: dir, env: n.env })
  const text = r.stdout.trim() || r.stderr.trim()
  let v: any
  try {
    v = JSON.parse(text.slice(text.indexOf('{')))
  } catch {
    throw new Error((r.stderr || r.stdout).trim().split('\n').pop() || 'the timeline tool gave no answer')
  }
  if (v.ok === false) throw new Error(`${v.reason}${v.fix ? ` (${v.fix})` : ''}`)
  return v
}

const SOUND = new Set(['audio'])

function toClip(r: any): Clip {
  const automation = (r.lanes ?? []) as { target: string; points: { t: number; v: number }[] }[]
  return {
    id: r.elementId ?? r.id,
    ref: r.ref ?? `#${r.id}`,
    kind: r.kind,
    track: r.trackKind,
    trackIndex: r.trackIndex ?? 0,
    file: r.file ?? 'index.html',
    start: r3(r.absStart ?? r.start),
    end: r3(r.absEnd ?? r.end),
    src: r.src ?? null,
    mediaStart: r.mediaStart ?? 0,
    volume: r.volume ?? null,
    rate: r.playbackRate ?? null,
    lanes: automation,
    audible: SOUND.has(r.kind) || (r.kind === 'video' && !!r.src),
    linked: r.audioGroup ?? null,
    mix: null
  }
}

/** Every clip of the video, flat (nested compositions' rows too). */
export async function clips(dir: string): Promise<Clip[]> {
  const v = await timeline(dir, [])
  const out: Clip[] = []
  const walk = (rows: any[]): void => {
    for (const r of rows ?? []) {
      if (r.elementId || r.id) out.push(toClip(r))
      if (r.children?.length) walk(r.children)
    }
  }
  for (const t of v.timeline?.tracks ?? []) walk(t.rows)
  // Panther's own fades and ducking, from the files.
  const files = new Map<string, string>()
  for (const c of out) {
    if (!c.audible) continue
    if (!files.has(c.file)) files.set(c.file, existsSync(join(dir, c.file)) ? readFileSync(join(dir, c.file), 'utf8') : '')
    const m = readMix(files.get(c.file)!, c.id)
    if (Object.keys(m).length) c.mix = { in: m.in, out: m.out, duck: m.duck && { under: m.duck.under, depth: m.duck.depth } }
  }
  return out
}

// ── Sound: measuring it ────────────────────────────────────────────────

/** The stretch of the source file a clip plays, in source seconds. */
function sourceSpan(c: Clip): { from: number; len: number } {
  return { from: c.mediaStart || 0, len: (c.end - c.start) * (c.rate || 1) }
}

function abs(dir: string, src: string): string | null {
  if (/^(https?:)?\/\//.test(src)) return null
  const p = resolve(dir, src)
  return existsSync(p) ? p : null
}

const soundCache = new Map<string, ClipSound>()

/** A clip's waveform (peaks, 0..1, `per` a second), its loudest moment and
 *  its loudness, as it plays at its volume. */
export async function sound(dir: string, c: Clip, per = 40): Promise<ClipSound | null> {
  if (!c.src) return null
  const file = abs(dir, c.src)
  if (!file) return null
  const { from, len } = sourceSpan(c)
  const key = `${file}@${statSync(file).mtimeMs}:${from}:${len}:${per}`
  let s = soundCache.get(key)
  if (!s) {
    const rate = Math.max(200, per * 50)
    const raw = await new Promise<Buffer | null>((ok) => {
      const p = spawn('ffmpeg', ['-hide_banner', '-v', 'error', '-ss', String(from), '-t', String(len), '-i', file, '-vn', '-ac', '1', '-ar', String(rate), '-f', 's16le', '-'], { env: toolEnv() })
      const bufs: Buffer[] = []
      p.stdout.on('data', (b: Buffer) => bufs.push(b))
      p.on('error', () => ok(null))
      p.on('close', () => ok(Buffer.concat(bufs)))
    })
    if (!raw || raw.length < 4) return { peaks: [], per, peakDb: null, lufs: null, silent: true }
    const n = Math.floor(raw.length / 2)
    const step = Math.max(1, Math.round(rate / per))
    const peaks: number[] = []
    let max = 0
    for (let i = 0; i < n; i += step) {
      let m = 0
      for (let j = i; j < Math.min(n, i + step); j++) m = Math.max(m, Math.abs(raw.readInt16LE(j * 2)))
      peaks.push(m / 32768)
      max = Math.max(max, m / 32768)
    }
    const loud = await exec('ffmpeg', ['-hide_banner', '-nostats', '-ss', String(from), '-t', String(len), '-i', file, '-vn', '-af', 'ebur128=peak=true', '-f', 'null', '-'], { env: toolEnv() })
    const I = /I:\s+(-?[\d.]+) LUFS/.exec(loud.stderr.split('Summary:').pop() ?? '')
    s = { peaks: peaks.map((p) => Math.round(p * 1000) / 1000), per, peakDb: max > 0 ? Math.round(20 * Math.log10(max) * 10) / 10 : null, lufs: I ? Number(I[1]) : null, silent: max < 0.001 }
    soundCache.set(key, s)
  }
  // As it plays: its volume (and the loudest point of its lane) on top.
  const gain = Math.max(c.volume ?? 1, ...volumeLane(c).map((p) => p.v))
  const db = gain > 0 ? 20 * Math.log10(gain) : -Infinity
  return { ...s, peakDb: s.peakDb == null ? null : Math.round((s.peakDb + db) * 10) / 10, lufs: s.lufs == null ? null : Math.round((s.lufs + db) * 10) / 10 }
}

const volumeLane = (c: Clip): { t: number; v: number }[] => c.lanes.find((l) => l.target === 'volume')?.points ?? []

/** When a voice speaks, in its clip's own time: silencedetect on what it plays. */
async function speech(dir: string, c: Clip): Promise<[number, number][]> {
  if (!c.src) return [[0, c.end - c.start]]
  const file = abs(dir, c.src)
  if (!file) return [[0, c.end - c.start]]
  const { from, len } = sourceSpan(c)
  const r = await exec('ffmpeg', ['-hide_banner', '-nostats', '-ss', String(from), '-t', String(len), '-i', file, '-vn', '-af', 'silencedetect=noise=-35dB:d=0.35', '-f', 'null', '-'], { env: toolEnv() })
  const silences: [number, number][] = []
  let open: number | null = null
  for (const line of r.stderr.split('\n')) {
    const s = /silence_start: (-?[\d.]+)/.exec(line)
    const e = /silence_end: (-?[\d.]+)/.exec(line)
    if (s) open = Math.max(0, Number(s[1]))
    if (e) {
      silences.push([open ?? 0, Number(e[1])])
      open = null
    }
  }
  if (open != null) silences.push([open, len])
  // The spoken stretches between the silences, in clip time.
  const rate = c.rate || 1
  const out: [number, number][] = []
  let at = 0
  for (const [a, b] of silences) {
    if (a > at + 0.05) out.push([at / rate, a / rate])
    at = b
  }
  if (len > at + 0.05) out.push([at / rate, len / rate])
  return out
}

// ── The volume lane: fades and ducking, as one envelope ────────────────

interface Mix { in?: number; out?: number; duck?: { under: string[]; depth: number; spans: [number, number][] } }

function readMix(html: string, id: string): Mix {
  const m = new RegExp(`<[^>]*\\sid=["']${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>`).exec(html)
  const a = m && /\sdata-panthr-mix=("([^"]*)"|'([^']*)')/.exec(m[0])
  if (!a) return {}
  try {
    return JSON.parse((a[2] ?? a[3]).replace(/&quot;/g, '"').replace(/&amp;/g, '&'))
  } catch {
    return {}
  }
}

/** The volume envelope (clip time) from fades and ducking, at `base`. */
export function envelope(len: number, base: number, mix: Mix): { t: number; v: number }[] {
  const fi = Math.min(mix.in ?? 0, len / 2)
  const fo = Math.min(mix.out ?? 0, len / 2)
  const depth = mix.duck?.depth ?? 1
  const spans = (mix.duck?.spans ?? []).map(([a, b]) => [Math.max(0, a), Math.min(len, b)] as [number, number]).filter(([a, b]) => b > a)
  // Ducked stretches: down 0.25 s before speech, back up 0.4 s after; close ones joined.
  const dips: [number, number][] = []
  for (const [a, b] of spans.sort((x, y) => x[0] - y[0])) {
    const last = dips[dips.length - 1]
    if (last && a - 0.25 <= last[1] + 0.4 + 0.3) last[1] = Math.max(last[1], b)
    else dips.push([a, b])
  }
  const fade = (t: number): number => Math.min(1, fi > 0 ? t / fi : 1, fo > 0 ? (len - t) / fo : 1)
  const duck = (t: number): number => {
    let f = 1
    for (const [a, b] of dips) {
      if (t >= a && t <= b) return depth
      if (t > a - 0.25 && t < a) f = Math.min(f, 1 - ((t - (a - 0.25)) / 0.25) * (1 - depth))
      if (t > b && t < b + 0.4) f = Math.min(f, depth + ((t - b) / 0.4) * (1 - depth))
    }
    return f
  }
  const at = new Set<number>([0, len, fi, len - fo])
  for (const [a, b] of dips) [a - 0.25, a, b, b + 0.4].forEach((t) => t >= 0 && t <= len && at.add(t))
  const ts = [...at].filter((t) => t >= 0 && t <= len).sort((a, b) => a - b)
  const pts = ts.map((t) => ({ t: r3(t), v: Math.round(base * Math.max(0, fade(t)) * duck(t) * 1000) / 1000 }))
  // A flat line at the clip's own level says nothing: no lane.
  return pts.every((p) => Math.abs(p.v - base) < 1e-3) ? [] : pts.filter((p, i) => i === 0 || p.t !== pts[i - 1].t)
}

async function writeMix(dir: string, c: Clip, mix: Mix): Promise<void> {
  const base = c.volume ?? 1
  const lanes = c.lanes.filter((l) => l.target !== 'volume')
  const pts = envelope(c.end - c.start, base, mix)
  if (pts.length) lanes.push({ target: 'volume', points: pts })
  const automation = lanes.length ? JSON.stringify({ version: 1, lanes }) : ''
  await runEdit(dir, { op: 'set', file: c.file, target: c.id, write: 'attr:data-automation', value: automation })
  await runEdit(dir, { op: 'set', file: c.file, target: c.id, write: 'attr:data-panthr-mix', value: JSON.stringify(mix) })
}

// ── Edits ─────────────────────────────────────────────────────────────

/** A new volume: the fades and ducking follow it to the new level. */
async function relevel(dir: string, path: string, id: string): Promise<void> {
  const mix = readMix(readFileSync(path, 'utf8'), id)
  if (!Object.keys(mix).length) return
  const now = (await clips(dir)).find((x) => x.id === id)
  if (now) await writeMix(dir, now, mix)
}

/** Make the file's composition last at least until `end` (never shorter). */
function grow(path: string, end: number): void {
  const html = readFileSync(path, 'utf8')
  const m = /<[a-zA-Z][\w-]*\b[^>]*\sdata-composition-id\s*=[^>]*>/.exec(html)
  if (!m) return
  const d = /\sdata-duration\s*=\s*["']([\d.]+)["']/.exec(m[0])
  if (!d || Number(d[1]) >= end - 1e-3) return
  const tag = m[0].replace(d[0], ` data-duration="${r3(end)}"`)
  writeFileSync(path, html.slice(0, m.index) + tag + html.slice(m.index + m[0].length))
}

const fileOf = (dir: string, rel: string): string => {
  const p = resolve(dir, rel)
  if (p !== resolve(dir) && !p.startsWith(resolve(dir) + sep)) throw new Error('outside the video')
  return p
}

/** One edit to the clips; the file as it was and is, for undo. */
export async function editClip(dir: string, e: ClipEdit): Promise<ClipEditResult> {
  const all = await clips(dir)
  const c = all.find((x) => x.ref === e.ref || x.id === e.ref.replace(/^#/, ''))
  if (!c) throw new Error('that clip is no longer in the video')
  const path = fileOf(dir, c.file)
  const before = readFileSync(path, 'utf8')
  let label = 'the clip'
  switch (e.op) {
    case 'move': {
      grow(path, Math.max(0, e.at) + (c.end - c.start))
      await timeline(dir, ['move', c.ref, String(r3(Math.max(0, e.at)))])
      label = `the timing of ${c.id}`
      break
    }
    case 'trim': {
      const [a, b] = [r3(Math.max(0, e.start)), r3(e.end)]
      if (Math.abs(a - c.start) < 1e-3 && Math.abs(b - c.end) < 1e-3) break
      grow(path, b)
      await timeline(dir, ['trim', c.ref, '--start', String(a), '--end', String(b)])
      // Its left edge moved: what it plays starts that much later (or earlier) in its file.
      if (c.src && Math.abs(a - c.start) > 1e-3) {
        const ms = r3(Math.max(0, (c.mediaStart || 0) + (a - c.start) * (c.rate || 1)))
        await runEdit(dir, { op: 'set', file: c.file, target: c.id, write: 'attr:data-media-start', value: String(ms) })
      }
      label = `the length of ${c.id}`
      break
    }
    case 'split': {
      if (!(e.at > c.start + 0.04 && e.at < c.end - 0.04)) throw new Error('the playhead is not inside it')
      await timeline(dir, ['split', c.ref, String(r3(e.at))])
      label = `splitting ${c.id}`
      break
    }
    case 'delete': {
      await timeline(dir, ['delete', c.ref])
      if (e.close) {
        // The clips after it on its track close up the gap.
        const gap = c.end - c.start
        const after = all.filter((x) => x.id !== c.id && x.trackIndex === c.trackIndex && x.file === c.file && x.start >= c.end - 1e-3).sort((a, b) => a.start - b.start)
        for (const x of after) await timeline(dir, ['move', x.ref, String(r3(x.start - gap))])
      }
      label = `deleting ${c.id}`
      break
    }
    case 'duplicate': {
      if (e.at != null) grow(path, e.at + (c.end - c.start))
      await timeline(dir, ['duplicate', c.ref, ...(e.at != null ? ['--start', String(r3(e.at))] : [])])
      label = `duplicating ${c.id}`
      break
    }
    case 'set': {
      const sets: string[] = []
      if (e.volume != null) sets.push(`volume=${r3(Math.max(0, Math.min(2, e.volume)))}`)
      if (e.rate != null) sets.push(`rate=${r3(Math.max(0.1, Math.min(8, e.rate)))}`)
      if (e.track != null) sets.push(`track=${Math.round(e.track)}`)
      if (!sets.length) break
      await timeline(dir, ['set', c.ref, ...sets])
      // A faster or slower clip plays the same stretch of its source: its length follows.
      if (e.rate != null && c.src && Math.abs((c.rate || 1) - e.rate) > 1e-3) {
        const len = ((c.end - c.start) * (c.rate || 1)) / e.rate
        grow(path, c.start + len)
        await timeline(dir, ['trim', c.ref, '--end', String(r3(c.start + len))])
      }
      if (e.volume != null) await relevel(dir, path, c.id)
      label = e.rate != null ? `the speed of ${c.id}` : e.volume != null ? `the volume of ${c.id}` : `the track of ${c.id}`
      break
    }
    case 'fade': {
      const mix = readMix(before, c.id)
      if (e.in != null) mix.in = Math.max(0, r3(e.in))
      if (e.out != null) mix.out = Math.max(0, r3(e.out))
      await writeMix(dir, c, mix)
      label = `the fades of ${c.id}`
      break
    }
    case 'duck': {
      const mix = readMix(before, c.id)
      if (!e.under.length) delete mix.duck
      else {
        const spans: [number, number][] = []
        for (const id of e.under) {
          const v = all.find((x) => x.id === id)
          if (!v) continue
          for (const [a, b] of await speech(dir, v)) spans.push([r3(v.start + a - c.start), r3(v.start + b - c.start)])
        }
        mix.duck = { under: e.under, depth: e.depth ?? 0.3, spans }
      }
      await writeMix(dir, c, mix)
      label = e.under.length ? `ducking ${c.id} under the voice` : `ducking ${c.id}`
      break
    }
    case 'normalize': {
      const s = await sound(dir, { ...c, volume: 1, lanes: [] })
      if (!s || s.lufs == null || s.silent) throw new Error('it has no sound to measure')
      // Speech and a video's own sound around -16 LUFS; music under a voice lower.
      const voices = all.some((x) => x.id !== c.id && x.audible && x.kind === 'audio' && /voice|vo\b|narrat|speech/i.test(`${x.id} ${x.src}`))
      const target = e.target ?? (c.kind === 'audio' && voices && !/voice|vo\b|narrat|speech/i.test(`${c.id} ${c.src}`) ? -24 : -16)
      const volume = Math.min(2, Math.max(0.02, 10 ** ((target - s.lufs) / 20)))
      await timeline(dir, ['set', c.ref, `volume=${r3(volume)}`])
      await relevel(dir, path, c.id)
      label = `the loudness of ${c.id}`
      break
    }
    case 'freeze': {
      if (c.kind !== 'video' || !c.src) throw new Error('only a video clip can hold a frame')
      if (!(e.at > c.start + 0.04 && e.at < c.end - 0.04)) throw new Error('the playhead is not inside it')
      const file = abs(dir, c.src)
      if (!file) throw new Error('its file is missing')
      const len = r3(Math.max(0.2, e.len ?? 1))
      const at = r3(e.at)
      const still = `assets/freeze-${c.id}-${Math.round(at * 1000)}.jpg`
      mkdirSync(join(dir, 'assets'), { recursive: true })
      const t = (c.mediaStart || 0) + (at - c.start) * (c.rate || 1)
      const shot = await exec('ffmpeg', ['-hide_banner', '-v', 'error', '-y', '-ss', String(t), '-i', file, '-frames:v', '1', '-q:v', '2', join(dir, still)], { env: toolEnv() })
      if (!shot.ok) throw new Error('could not take the frame')
      await timeline(dir, ['split', c.ref, String(at)])
      const second = (await clips(dir)).find((x) => x.id !== c.id && x.src === c.src && Math.abs(x.start - at) < 0.01)
      if (second) {
        grow(path, at + len + (second.end - second.start))
        await timeline(dir, ['move', second.ref, String(r3(at + len))])
      }
      // The still, in the gap, on the same track and in the same place.
      const html = readFileSync(path, 'utf8')
      const anchor = second ? new RegExp(`<video\\b[^>]*\\sid=["']${second.id}["']`).exec(html) : null
      const tag = new RegExp(`<video\\b[^>]*\\sid=["']${c.id}["'][^>]*>`).exec(html)
      const style = tag && /\sstyle=("[^"]*"|'[^']*')/.exec(tag[0])
      const cls = tag && /\sclass=("[^"]*"|'[^']*')/.exec(tag[0])
      const img = `<img id="${c.id}-hold-${Math.round(at * 1000)}" src="${still}" data-start="${at}" data-duration="${len}" data-track-index="${c.trackIndex}"${cls ? ` class=${cls[1]}` : ' class="clip"'}${style ? ` style=${style[1]}` : ''} alt="">`
      const pos = anchor ? anchor.index : (() => {
        const close = html.indexOf('</video>', tag ? tag.index : 0)
        return close < 0 ? -1 : close + '</video>'.length
      })()
      if (pos < 0) throw new Error('could not place the frame')
      writeFileSync(path, html.slice(0, pos) + img + html.slice(pos))
      label = `a freeze frame in ${c.id}`
      break
    }
  }
  const after = readFileSync(path, 'utf8')
  return { file: relative(dir, path), before, after, changed: after !== before, label }
}

// ── Beats ─────────────────────────────────────────────────────────────

/** The music's beats on the video's clock (HyperFrames finds them, once). */
export async function beats(dir: string): Promise<number[]> {
  const all = await clips(dir)
  const music = all.filter((c) => c.kind === 'audio' && c.src)
  if (!music.length) return []
  const read = (): { audio: string; beats: { time: number; strength: number }[] }[] => {
    const root = join(dir, 'beats')
    if (!existsSync(root)) return []
    const out: any[] = []
    const walk = (d: string): void => {
      for (const f of readdirSync(d)) {
        const p = join(d, f)
        if (statSync(p).isDirectory()) walk(p)
        else if (f.endsWith('.json')) {
          try {
            out.push(JSON.parse(readFileSync(p, 'utf8')))
          } catch {}
        }
      }
    }
    walk(root)
    return out
  }
  let found = read()
  if (!music.some((m) => found.some((b) => b.audio === m.src))) {
    const n = npx(['beats', dir, '--json'])
    await exec(n.cmd, n.args, { cwd: dir, env: n.env })
    found = read()
  }
  const out: number[] = []
  for (const m of music) {
    const b = found.find((x) => x.audio === m.src)
    if (!b) continue
    for (const { time } of b.beats) {
      const t = m.start + (time - (m.mediaStart || 0)) / (m.rate || 1)
      if (t >= m.start - 1e-3 && t <= m.end + 1e-3) out.push(r3(t))
    }
  }
  return [...new Set(out)].sort((a, b) => a - b)
}

export const clipsApi: Api['clips'] = {
  list: clips,
  edit: editClip,
  async sound(dir, ref) {
    const c = (await clips(dir)).find((x) => x.ref === ref || x.id === ref.replace(/^#/, ''))
    return c ? sound(dir, c) : null
  },
  beats
}
