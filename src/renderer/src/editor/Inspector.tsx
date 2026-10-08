// The inspector, on the right while something is picked: what it is, a
// way to ask about it, the controls your agent made for it (dragged live,
// written on release), where it is and how it looks, and its animation:
// each step with its ease, and its timing.

import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { Control, ControlSet, Engine, Layer, Picked, TimingLayer } from '@shared/types'
import { fmtNum, keyFor, setRequest, written } from '@shared/controls'
import { api } from '@/lib/api'
import { rise, tr, MOVE, QUICK } from '@/lib/motion'
import { Icon } from '@/ui/Icon'
import { IconButton, Switch } from '@/ui/Controls'
import { AgentMark } from '@/ui/AgentMark'

const SWATCHES = ['#ffffff', '#0b0b0f', '#da5cc7', '#7c3aed', '#2563eb', '#06b6d4', '#16a34a', '#f59e0b', '#ef4444', '#71717a']

export interface ControlChange { key: string; index: number; label: string; from: unknown; to: unknown }

export function describe(p: Picked): string {
  const text = (p.text || '').trim()
  if (text) return `${p.tag} “${text.slice(0, 40)}”`
  return p.id ? `${p.tag} #${p.id}` : p.tag
}

export function whereLine(p: Picked, at: number): string {
  return `file ${p.file || 'index.html'}, element ${p.id || '?'} (id given: ${!!p.hasId}), at ${at.toFixed(2)}s in the video${p.layer ? `, inside layer ${p.layer}` : ''}`
}

function kindOf(p: Picked): [string, string] {
  if (p.tag === 'script') return ['Animation', '∿']
  if (['img', 'video', 'picture'].includes(p.tag)) return ['Media', '▣']
  if (['canvas', 'svg'].includes(p.tag)) return ['Drawing', '◆']
  if (p.style?.text) return ['Text', 'T']
  return ['Group', '❐']
}

/** cubic-bezier control points for a GSAP ease name (close enough to draw). */
function easeCurve(name: string): [number, number, number, number] {
  const n = name.toLowerCase()
  if (n === 'none' || n === 'linear') return [0, 0, 1, 1]
  const inOut = n.includes('inout')
  const isIn = !inOut && /\.in\b|\.in$/.test(n)
  const k = n.startsWith('power4') || n.startsWith('expo') ? 0.95 : n.startsWith('power3') ? 0.8 : n.startsWith('power2') ? 0.65 : n.startsWith('sine') ? 0.4 : n.startsWith('back') ? 1.2 : 0.5
  if (inOut) return [k * 0.7, 0, 1 - k * 0.7, 1]
  if (isIn) return [k * 0.6, 0, 1, 1 - k * 0.3]
  return [0, k * 0.6 + 0.2, 1 - k * 0.6, 1]
}

function Curve({ ease }: { ease: string }) {
  const [x1, y1, x2, y2] = easeCurve(ease)
  const pts: string[] = []
  for (let i = 0; i <= 24; i++) {
    const u = i / 24
    const bx = 3 * (1 - u) ** 2 * u * x1 + 3 * (1 - u) * u * u * x2 + u ** 3
    const by = 3 * (1 - u) ** 2 * u * y1 + 3 * (1 - u) * u * u * y2 + u ** 3
    pts.push(`${i ? 'L' : 'M'}${(2 + bx * 30).toFixed(1)} ${(20 - by * 18).toFixed(1)}`)
  }
  return <svg width={34} height={22} viewBox="0 0 34 22"><path d={pts.join('')} fill="none" stroke="var(--acc-text)" strokeWidth={1.6} strokeLinecap="round" /></svg>
}

export function Section({ title, note, children }: { title: string; note?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="insp-sec">
      <div className="insp-sh"><span>{title}</span>{note && <em>{note}</em>}</div>
      {children}
    </section>
  )
}

export const Field = ({ label, value, unit }: { label: string; value: React.ReactNode; unit?: string }) => (
  <div className="field">
    {label && <s>{label}</s>}
    <span className="ellipsis">{value}</span>
    {unit && <u>{unit}</u>}
  </div>
)

export function Inspector({
  dir, engine, picked, at, layer, layerIx, win, tween, onClose, onAskAbout, onAsk, onPreview, onWritten, onChanged, onSelectTween, onNudge, onAdjustable, onSeek
}: {
  dir: string
  /** The agent the question goes to: its mark on the ask box. */
  engine: Engine
  picked: Picked
  at: number
  layer: Layer | null
  layerIx: number | null
  win: TimingLayer | null
  tween: number | null
  onClose(): void
  onAskAbout(): void
  onAsk(msg: string): void
  onPreview(msg: Record<string, unknown>): void
  /** A value went into the file: show it now (don't wait for the watcher). */
  onWritten(): void
  onChanged(c: ControlChange): void
  onSelectTween(k: number): void
  onNudge(dStart: number, dLen: number): void
  onAdjustable(): void
  onSeek(t: number): void
}) {
  const [all, setAll] = useState<Record<string, ControlSet>>({})
  const [asked, setAsked] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [history, setHistory] = useState<ControlChange[]>([])

  useEffect(() => {
    api.controls.all(dir).then(setAll)
  }, [dir, picked])
  useEffect(() => {
    setAsked(false)
    setError(null)
  }, [picked.id, picked.layer])

  const key = useMemo(() => {
    const ids = [picked.id, ...(picked.path ?? []), ...(picked.layer ? [picked.layer] : [])].filter(Boolean)
    return keyFor(all, picked.file || 'index.html', ids, at)
  }, [all, picked, at])
  const set = key ? all[key] : null
  const name = layer?.label || ((picked.text || '').trim().slice(0, 28) || picked.tag || 'Element')
  const [kind, glyph] = kindOf(picked)

  // A value the page's script reads when it starts (a data- attribute)
  // only shows once the page runs again: while dragging, it goes into the
  // file (one write at a time, the newest value winning) and the page
  // reloads behind the picture.
  const scrub = useRef<{ busy: boolean; next: [number, unknown] | null }>({ busy: false, next: null })
  const scrubWrite = async (i: number, v: unknown): Promise<void> => {
    if (!set) return
    if (scrub.current.busy) {
      scrub.current.next = [i, v]
      return
    }
    scrub.current.busy = true
    try {
      await api.controls.run(dir, setRequest(set, set.controls[i], v))
      onWritten()
    } catch {}
    scrub.current.busy = false
    const n = scrub.current.next
    scrub.current.next = null
    if (n) scrubWrite(n[0], n[1])
  }
  /** Show a value in the picture now: styles and words at once, values the
   *  script reads through the file. */
  const live = (c: Control, v: unknown): void => {
    if (!set) return
    if (c.write.startsWith('attr:')) {
      scrubWrite(set.controls.indexOf(c), v)
      return
    }
    for (const id of c.targets?.length ? c.targets : [set.element]) onPreview({ type: 'set', id, write: c.write, value: written(c, v) })
  }
  /** Write a value into the file and controls.json; it becomes a change. */
  const apply = async (i: number, v: unknown, from?: unknown): Promise<void> => {
    if (!key || !set) return
    const c = set.controls[i]
    try {
      await api.controls.run(dir, setRequest(set, c, v))
      onWritten()
      const next = { ...all, [key]: { ...set, controls: set.controls.map((x, k) => (k === i ? { ...x, value: v } : x)) } }
      setAll(next)
      await api.controls.save(dir, next)
      const ch = { key, index: i, label: c.label, from: from === undefined ? c.value : from, to: v }
      setHistory((h) => [...h, ch])
      onChanged(ch)
      setError(null)
    } catch (e) {
      setError(`Could not change ${c.label}: ${(e as Error).message}`)
    }
  }

  return (
    <div className="insp">
      <div className="insp-head">
        <span className="insp-tag">{glyph}</span>
        <b className="ellipsis">{name}</b>
        <span className="faint">{kind}</span>
        <span className="spacer" />
        <IconButton icon="close" size={26} tip="Close" keys="Esc" onClick={onClose} />
      </div>
      <button className="insp-ask" onClick={onAskAbout}>
        <AgentMark engine={engine} size={14} />
        <span className="ellipsis">Ask about {name}…</span>
      </button>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={`${picked.id}|${layerIx}`} className="insp-body" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={tr(QUICK)}>
          {/* Controls your agent made for it */}
          {picked.tag !== 'script' && (set ? (
            <Section title="Controls" note="made by your agent">
              {[...set.controls.keys()].sort((a, b) => Number(!!set.controls[b].primary) - Number(!!set.controls[a].primary)).map((i) => (
                <ControlRow key={i} c={set.controls[i]} onLive={(v) => live(set.controls[i], v)} onApply={(v, from) => apply(i, v, from)} />
              ))}
              {set.note && <div className="insp-note">{set.note}</div>}
            </Section>
          ) : (
            <Section title="Controls">
              <div className="insp-note">{asked ? 'Asked your agent. The controls appear here when it is done.' : 'No controls for this yet.'}</div>
              {!asked && (
                <button className="btn" onClick={() => {
                  setAsked(true)
                  onAsk(`Make controls for the element I clicked in the video: ${describe(picked)} — ${whereLine(picked, at)}. Write them to .studio/controls.json as the Controls section says (a primary control first). If it is part of a repeated set, add set-wide controls too.`)
                }}>Make controls for this</button>
              )}
            </Section>
          ))}
          {/* Where it is and how big (composition pixels) */}
          {picked.box && (
            <Section title="Transform">
              <div className="g2"><Field label="X" value={Math.round(picked.box.x)} unit="px" /><Field label="Y" value={Math.round(picked.box.y)} unit="px" /></div>
              <div className="g2"><Field label="W" value={Math.round(picked.box.w)} unit="px" /><Field label="H" value={Math.round(picked.box.h)} unit="px" /></div>
              <div className="g2"><Field label="↻" value={picked.style?.rotate ?? 0} unit="°" /><Field label="◐" value={Math.round((picked.style?.opacity ?? 1) * 100)} unit="%" /></div>
            </Section>
          )}
          {picked.style?.text && <TextSection st={picked.style} />}
          {/* Its animation */}
          {layerIx != null && layer && (
            <AnimationSection layer={layer} win={win} tween={tween} onSelectTween={onSelectTween} onNudge={onNudge} onAdjustable={onAdjustable} onSeek={onSeek} />
          )}
          {error && <div className="insp-error">{error}</div>}
          {history.length > 0 && (
            <Section title="Changes">
              {history.slice(-6).reverse().map((ch, k) => (
                <motion.div key={history.length - k} className="insp-change" {...rise(4, MOVE)}>
                  <span className="ellipsis">{ch.label}: {fmt(ch.from)} → {fmt(ch.to)}</span>
                  {ch.from !== undefined && ch.from !== null && key === ch.key && (
                    <button className="btn ghost small" onClick={() => apply(ch.index, ch.from)}>Revert</button>
                  )}
                </motion.div>
              ))}
            </Section>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  )
}

const fmt = (v: unknown): string => (v === undefined || v === null ? '—' : typeof v === 'number' ? fmtNum(v) : String(v))

function TextSection({ st }: { st: NonNullable<Picked['style']> }) {
  const m = /rgba?\(([^)]+)\)/.exec(st.color || '')
  const [r, g, b] = m ? m[1].split(/[ ,/]+/).map(Number) : [255, 255, 255]
  const hex = [r, g, b].map((x) => Math.round(x).toString(16).padStart(2, '0')).join('').toUpperCase()
  const weight: Record<string, string> = { '100': 'Thin', '200': 'Extra light', '300': 'Light', '500': 'Medium', '600': 'Semibold', '700': 'Bold', '800': 'Extra bold', '900': 'Black' }
  return (
    <Section title="Text">
      <Field label="Aa" value={st.font} />
      <div className="g2"><Field label="" value={weight[st.weight] ?? 'Regular'} /><Field label="pt" value={st.size} unit="px" /></div>
      <div className="field"><i className="sw" style={{ background: `#${hex}` }} /><span className="mono">{hex}</span><u>{st.align}</u></div>
    </Section>
  )
}

function AnimationSection({ layer, win, tween, onSelectTween, onNudge, onAdjustable, onSeek }: {
  layer: Layer; win: TimingLayer | null; tween: number | null
  onSelectTween(k: number): void; onNudge(a: number, b: number): void; onAdjustable(): void; onSeek(t: number): void
}) {
  if (!win) {
    const n = layer.spans.length
    return (
      <Section title="Animation" note={`${n} step${n === 1 ? '' : 's'}`}>
        {layer.spans.slice(0, 8).map(([a, b], k) => (
          <button key={k} className="insp-span" onClick={() => onSeek(a)}>
            <span className="muted">Moves {k + 1}</span>
            <span className="mono faint">{a.toFixed(2)}–{b.toFixed(2)} s</span>
          </button>
        ))}
        <div className="insp-note">Not adjustable here: {layer.id ? 'its timing is inside the script' : 'it has no element of its own'}.</div>
        <button className="btn" onClick={onAdjustable}>Make adjustable</button>
      </Section>
    )
  }
  return (
    <>
      <Section title="Animation" note={`${win.tweens.length} step${win.tweens.length === 1 ? '' : 's'}`}>
        {win.tweens.map((t, k) => (
          <button key={t.id + k} className={`insp-step${tween === k ? ' on' : ''}`} onClick={() => onSelectTween(k)}>
            <Curve ease={t.ease ?? 'power1.out'} />
            <b className="ellipsis">{t.method}</b>
            <span className="mono faint">{t.start.toFixed(2)}s · {t.duration.toFixed(2)}s</span>
          </button>
        ))}
      </Section>
      <Section title="Timing" note={tween != null ? 'the chosen step' : 'the whole layer'}>
        <div className="g2">
          <Nudge label="Starts" value={tween != null ? win.tweens[tween].start : win.start!} onLess={() => onNudge(-0.1, 0)} onMore={() => onNudge(0.1, 0)} />
          <Nudge label="Lasts" value={tween != null ? win.tweens[tween].duration : win.end! - win.start!} onLess={() => onNudge(0, -0.1)} onMore={() => onNudge(0, 0.1)} />
        </div>
      </Section>
    </>
  )
}

function Nudge({ label, value, onLess, onMore }: { label: string; value: number; onLess(): void; onMore(): void }) {
  return (
    <div className="field nudge-field">
      <button onClick={onLess}>‹</button>
      <s>{label}</s>
      <span className="mono">{fmtNum(value)}s</span>
      <button onClick={onMore}>›</button>
    </div>
  )
}

function ControlRow({ c, onLive, onApply }: { c: Control; onLive(v: unknown): void; onApply(v: unknown, from?: unknown): void }) {
  switch (c.type) {
    case 'number': return <Slider c={c} onLive={onLive} onApply={onApply} />
    case 'color': {
      const cur = String(c.value ?? '')
      return (
        <div className="ctl-color">
          <div className="ctl-row"><span className="ctl-label">{c.label}</span><i className="sw" style={{ background: cur }} /><span className="mono">{cur.replace('#', '').toUpperCase()}</span></div>
          <div className="swatches">
            {SWATCHES.map((s) => (
              <button key={s} className={`swatch${cur.toLowerCase() === s ? ' on' : ''}`} style={{ background: s }} onClick={() => {
                onLive(s)
                onApply(s)
              }} />
            ))}
          </div>
        </div>
      )
    }
    case 'toggle': {
      const on = c.value === true || c.value === 'true'
      return <div className="ctl-row"><span className="ctl-label">{c.label}</span><span className="spacer" /><Switch on={on} onChange={(v) => onApply(v)} small /></div>
    }
    case 'choice': {
      const opts = (c.options ?? []).map((o) => (o && typeof o === 'object' ? { label: String((o as any).label ?? ''), value: (o as any).value } : { label: String(o), value: o }))
      return (
        <div className="ctl-choice">
          <span className="ctl-label">{c.label}</span>
          <div className="segmented full">
            {opts.map((o, k) => {
              const on = JSON.stringify(o.value) === JSON.stringify(c.value)
              return (
                <button key={k} className={on ? 'on' : ''} onClick={() => {
                  onLive(o.value)
                  onApply(o.value)
                }}>
                  {on && <motion.span layoutId={`choice-${c.label}`} className="seg-pill" transition={tr(MOVE)} />}
                  <span className="seg-label">{o.label}</span>
                </button>
              )
            })}
          </div>
        </div>
      )
    }
    default:
      return <TextControl c={c} onLive={onLive} onApply={onApply} />
  }
}

function TextControl({ c, onLive, onApply }: { c: Control; onLive(v: unknown): void; onApply(v: unknown): void }) {
  const [v, setV] = useState(String(c.value ?? ''))
  useEffect(() => setV(String(c.value ?? '')), [c.value])
  return (
    <div className="ctl-choice">
      <span className="ctl-label">{c.label}</span>
      <input className="ctl-text" value={v} onChange={(e) => {
        setV(e.target.value)
        onLive(e.target.value)
      }} onKeyDown={(e) => {
        if (e.key === 'Enter') onApply(v)
      }} onBlur={() => v !== String(c.value ?? '') && onApply(v)} />
    </div>
  )
}

function Slider({ c, onLive, onApply }: { c: Control; onLive(v: unknown): void; onApply(v: unknown, from?: unknown): void }) {
  const lo = c.min ?? 0
  const hi = Math.max(c.max ?? 100, lo + 1e-6)
  const step = c.step ?? (hi - lo > 20 ? 1 : 0.01)
  const toNum = (v: unknown): number => (typeof v === 'number' ? v : parseFloat(String(v ?? lo))) || lo
  const [v, setV] = useState(toNum(c.value))
  const from = useRef<unknown>(undefined)
  const track = useRef<HTMLDivElement>(null)
  useEffect(() => setV(toNum(c.value)), [c.value]) // eslint-disable-line react-hooks/exhaustive-deps
  const at = (clientX: number): number => {
    const r = track.current!.getBoundingClientRect()
    const f = Math.min(1, Math.max(0, (clientX - r.left) / Math.max(1, r.width)))
    return Math.round((lo + f * (hi - lo)) / step) * step
  }
  const frac = Math.min(1, Math.max(0, (v - lo) / (hi - lo)))
  return (
    <div className="slider">
      <span className="ctl-label ellipsis">{c.label}</span>
      <div
        className="slider-track"
        ref={track}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          from.current = c.value
          const n = at(e.clientX)
          setV(n)
          onLive(n)
        }}
        onPointerMove={(e) => {
          if (from.current === undefined) return
          const n = at(e.clientX)
          setV(n)
          onLive(n)
        }}
        onPointerUp={() => {
          if (from.current === undefined) return
          const f = from.current
          from.current = undefined
          onApply(v, f)
        }}
      >
        <i style={{ width: `${frac * 100}%` }} />
        <b style={{ left: `${frac * 100}%` }} />
      </div>
      <span className="mono slider-value">{fmtNum(v)}{c.unit ?? ''}</span>
    </div>
  )
}
