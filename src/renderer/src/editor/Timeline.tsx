// The one timeline: the ruler (with play and the clock beside it), the
// film with its scenes, the notes lane, and one row per layer (what moves
// when). It is a window on the video: zoomed in, it scrolls.
//
// Pointer: hover skims (the picture follows; leaving goes back to the
// playhead), a press on the ruler or film scrubs, ⌘-scroll or a pinch zooms
// about the pointer, sideways scroll pans. On a layer: a press chooses it;
// a drag moves its bar, its ends stretch it, and on the chosen layer its
// steps (tweens) move and stretch too. Edges catch on the playhead.

import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as RPE } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { Comment, Layer, Scene, TimingLayer } from '@shared/types'
import { tr, MOVE, QUICK, SETTLE } from '@/lib/motion'
import { clock } from '@/lib/format'
import { Icon } from '@/ui/Icon'

import { MenuItem, Popover } from '@/ui/Popover'
import { Tip } from '@/ui/Tooltip'

export const RULER_H = 30
export const TRACK_H = 40
export const LANE_H = 14
export const GAP = 4
export const LAYER_H = 28
export const ROW_GAP = 2
export const GUTTER = 176
export const MAX_ZOOM = 40
const GRIP = 7

export type Edit =
  | { kind: 'window'; ix: number; at: number; len: number }
  | { kind: 'tween'; ix: number; tw: number; start: number; dur: number }

type Grab = 'move' | 'start' | 'end' | { tw: number; part: 'move' | 'start' | 'end' }

export function stepFor(visible: number, width: number): number {
  const perPx = visible / Math.max(1, width)
  for (const s of [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120]) if (s / perPx >= 60) return s
  return 300
}

const tickLabel = (t: number, step: number): string =>
  step < 1 ? `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}` : `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}`

export function clampView(duration: number, zoom: number, scroll: number): [number, number] {
  const z = Math.min(MAX_ZOOM, Math.max(1, zoom))
  const visible = duration / z
  return [z, Math.min(Math.max(0, scroll), Math.max(0, duration - visible))]
}

const GLYPH: Record<string, string> = { text: 'T', media: '▣', audio: '♪', scene: '▤', group: '❐', motion: '∿' }

export interface TimelineProps {
  duration: number
  time: number
  playing: boolean
  now: () => number
  scenes: Scene[]
  layers: Layer[]
  timing: Record<string, TimingLayer>
  comments: Comment[]
  frames: string[]
  selected: number | null
  tween: number | null
  pickedId: string | null
  selectedComment: string | null
  layersOpen: boolean
  rows: number
  skimming: boolean
  onPlay(): void
  onSeek(t: number): void
  onSkim(t: number | null): void
  onSelect(ix: number, tween: number | null): void
  onEdit(e: Edit): void
  onRange(a: number, b: number): void
  onComment(id: string): void
  onToggleLayers(): void
  onRows(n: number): void
  footer: React.ReactNode
}

export function Timeline(p: TimelineProps) {
  const dur = p.duration > 0 ? p.duration : 1
  const tracks = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(600)
  const [view, setView] = useState<[number, number]>([1, 0])
  const [zoom, scroll] = clampView(dur, view[0], view[1])
  const [skim, setSkim] = useState<number | null>(null)
  const [drag, setDrag] = useState<{ ix: number; grab: Grab; x0: number; a0: number; l0: number; moved: boolean } | null>(null)
  const [edit, setEdit] = useState<Edit | null>(null)
  const [hoverGrab, setHoverGrab] = useState<Grab | null>(null)
  const [range, setRange] = useState<[number, number] | null>(null)
  const scrubbing = useRef(false)
  const head = useRef<HTMLDivElement>(null)
  const clockEl = useRef<HTMLSpanElement>(null)

  useLayoutEffect(() => {
    const el = tracks.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(Math.max(1, el.clientWidth)))
    ro.observe(el)
    setWidth(Math.max(1, el.clientWidth))
    return () => ro.disconnect()
  }, [])

  const pps = (width * zoom) / dur
  const x = (t: number): number => (t - scroll) * pps
  const tAt = (px: number): number => Math.min(dur, Math.max(0, scroll + px / pps))
  const localX = (e: { clientX: number }): number => e.clientX - (tracks.current?.getBoundingClientRect().left ?? 0)

  // The playhead follows the picture every frame without re-rendering the rows.
  useEffect(() => {
    let raf = 0
    const tick = (): void => {
      const t = p.now()
      const hx = (t - scroll) * pps
      if (head.current) {
        head.current.style.transform = `translateX(${hx}px)`
        head.current.style.opacity = hx < -4 || hx > width + 4 ? '0' : '1'
      }
      if (clockEl.current && skim === null) clockEl.current.textContent = clock(t)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [p.now, scroll, pps, width, skim])

  // Zoom about a point; pan sideways.
  const zoomAt = (factor: number, px: number): void => {
    const t = scroll + px / pps
    const z = Math.min(MAX_ZOOM, Math.max(1, zoom * factor))
    const visible = dur / z
    setView(clampView(dur, z, t - (px / width) * visible))
  }
  useEffect(() => {
    const el = tracks.current?.parentElement?.parentElement
    if (!el) return
    const wheel = (e: WheelEvent): void => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        zoomAt(Math.exp(-e.deltaY * 0.01), localX(e))
      } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) {
        e.preventDefault()
        const d = e.shiftKey ? e.deltaY : e.deltaX
        setView(([z, s]) => clampView(dur, z, s + d / pps))
      }
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  })

  const windowOf = (ix: number): TimingLayer | null => {
    const l = p.layers[ix]
    const w = l && l.id ? p.timing[l.id] : undefined
    return w && w.movable && w.start != null && w.end != null ? w : null
  }

  /** Which part of layer ix's bar is at px (the chosen layer's tweens first). */
  const grabAt = (ix: number, px: number): Grab | null => {
    const w = windowOf(ix)
    if (!w) return null
    const la = x(w.start!)
    const lb = x(w.end!)
    const g = Math.min(GRIP, (lb - la) / 3)
    if (Math.abs(px - la) <= Math.min(g, 4)) return 'start'
    if (Math.abs(px - lb) <= Math.min(g, 4)) return 'end'
    if (p.selected === ix) {
      const tws = w.tweens.map((t, k) => ({ t, k })).filter(({ t }) => t.editable)
      for (const { t, k } of tws) {
        if (Math.abs(px - x(t.start)) <= 5) return { tw: k, part: 'start' }
        if (Math.abs(px - x(t.start + t.duration)) <= 5) return { tw: k, part: 'end' }
      }
      for (const { t, k } of tws) if (px > x(t.start) && px < x(t.start + t.duration)) return { tw: k, part: 'move' }
    }
    if (Math.abs(px - la) <= g) return 'start'
    if (Math.abs(px - lb) <= g) return 'end'
    return px > la && px < lb ? 'move' : null
  }

  const cursorFor = (g: Grab | null, held: boolean): string =>
    !g ? 'pointer' : g === 'start' || g === 'end' || (typeof g === 'object' && g.part !== 'move') ? 'ew-resize' : held ? 'grabbing' : 'grab'

  // ── Skimming ───────────────────────────────────────────────
  const skimTo = (t: number | null): void => {
    if (!p.skimming || p.playing) return
    setSkim(t)
    p.onSkim(t)
  }

  // ── Scrub (ruler, film) ────────────────────────────────────
  const startScrub = (e: RPE): void => {
    if (e.button !== 0) return
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    scrubbing.current = true
    setSkim(null)
    p.onSeek(tAt(localX(e)))
  }
  const moveScrub = (e: RPE): void => {
    if (scrubbing.current) p.onSeek(tAt(localX(e)))
    else skimTo(tAt(localX(e)))
  }
  const endScrub = (): void => {
    scrubbing.current = false
  }

  // ── The notes lane: a drag marks a span to comment on ─────
  const laneDown = (e: RPE): void => {
    if (e.button !== 0) return
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    const t = tAt(localX(e))
    setRange([t, t])
  }
  const laneMove = (e: RPE): void => {
    if (range) setRange([range[0], tAt(localX(e))])
    else skimTo(tAt(localX(e)))
  }
  const laneUp = (e: RPE): void => {
    if (!range) return
    const [a, b] = [Math.min(...range), Math.max(...range)]
    setRange(null)
    if ((b - a) * pps < 6) {
      // A click: a note under it, else seek there.
      const px = localX(e)
      const hit = p.comments.find((c) => px >= x(c.time) - 4 && px <= x(c.end ?? c.time) + 8)
      if (hit) p.onComment(hit.id)
      else p.onSeek(a)
    } else p.onRange(a, b)
  }

  // ── Layers ─────────────────────────────────────────────────
  const snap = (t: number): number => (Math.abs(x(t) - x(p.time)) < 6 ? p.time : Math.round(t * 20) / 20)

  const rowDown = (ix: number, e: RPE): void => {
    if (e.button !== 0) return
    const px = localX(e)
    const g = px >= 0 ? grabAt(ix, px) : null
    p.onSelect(ix, g && typeof g === 'object' ? g.tw : g ? null : p.tween)
    const w = windowOf(ix)
    if (g && w) {
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      const t = typeof g === 'object' ? w.tweens[g.tw] : null
      const [a0, l0] = t ? [t.start, t.duration] : [w.start!, w.end! - w.start!]
      if (e.detail === 2) {
        p.onSeek(a0)
        return
      }
      setDrag({ ix, grab: g, x0: px, a0, l0, moved: false })
      return
    }
    // On a bar it chooses the layer; elsewhere in the row it scrubs.
    const l = p.layers[ix]
    const a = Math.min(...l.spans.map((s) => s[0]))
    const b = Math.max(...l.spans.map((s) => s[1]))
    if (!(px >= x(a) - 4 && px <= x(b) + 4)) startScrub(e)
  }

  const rowMove = (ix: number, e: RPE): void => {
    const px = localX(e)
    if (drag) {
      const dt = (px - drag.x0) / pps
      const { a0, l0, grab } = drag
      let at = a0
      let len = l0
      const kind = typeof grab === 'object' ? grab.part : grab
      if (kind === 'move') {
        let s = snap(a0 + dt)
        const end = snap(a0 + dt + l0)
        if (Math.abs(end - (a0 + dt + l0)) < Math.abs(s - (a0 + dt))) s = end - l0
        at = Math.min(Math.max(0, s), Math.max(0, dur - l0))
      } else if (kind === 'start') {
        const s = Math.min(Math.max(0, snap(a0 + dt)), a0 + l0 - 0.05)
        len = a0 + l0 - s
        at = s
      } else {
        len = Math.min(Math.max(0.05, snap(a0 + l0 + dt) - a0), dur - a0)
      }
      const moved = drag.moved || Math.abs(px - drag.x0) > 2
      if (moved !== drag.moved) setDrag({ ...drag, moved })
      setEdit(typeof grab === 'object' ? { kind: 'tween', ix: drag.ix, tw: grab.tw, start: at, dur: len } : { kind: 'window', ix: drag.ix, at, len })
      return
    }
    if (scrubbing.current) p.onSeek(tAt(px))
    else {
      setHoverGrab(px >= 0 ? grabAt(ix, px) : null)
      skimTo(tAt(px))
    }
  }

  const rowUp = (): void => {
    if (drag) {
      if (edit && drag.moved) p.onEdit(edit)
      setDrag(null)
      // The bar keeps where it was let go until the file says otherwise.
      setTimeout(() => setEdit(null), 600)
    }
    endScrub()
  }

  const leave = (): void => {
    setHoverGrab(null)
    if (skim !== null) {
      setSkim(null)
      p.onSkim(null)
    }
  }

  // ── Drawing ────────────────────────────────────────────────
  const visible = dur / zoom
  const step = stepFor(visible, width)
  const ticks: number[] = []
  for (let t = Math.floor(scroll / step) * step; t <= scroll + visible + 1e-6; t += step) ticks.push(t)

  const rowsShown = Math.min(p.rows, Math.max(1, p.layers.length))
  const layersH = rowsShown * (LAYER_H + ROW_GAP)
  const sx = skim !== null ? x(skim) : null

  return (
    <div className="tl" onPointerLeave={leave}>
      {/* Ruler */}
      <div className="tl-row" style={{ height: RULER_H }}>
        <div className="tl-gutter tl-corner">
          <Tip title={p.playing ? 'Pause' : 'Play'} keys="Space">
            <button className="tl-play" onClick={p.onPlay}><Icon name={p.playing ? 'pause' : 'play'} size={12} /></button>
          </Tip>
          <span className="tl-clock mono">
            <span ref={clockEl}>{clock(skim ?? p.time)}</span>
            <span className="faint"> / {clock(p.duration)}</span>
          </span>
        </div>
        <div className="tl-track" ref={tracks} onPointerDown={startScrub} onPointerMove={moveScrub} onPointerUp={endScrub}>
          {ticks.map((t) => (
            <div key={t.toFixed(3)} className="tl-tick" style={{ left: x(t) }}>
              {x(t) < width - 36 && <span>{tickLabel(t, step)}</span>}
            </div>
          ))}
        </div>
      </div>
      {/* Film */}
      <div className="tl-row" style={{ height: TRACK_H, marginTop: GAP }}>
        <div className="tl-gutter" />
        <div className="tl-track" onPointerDown={startScrub} onPointerMove={moveScrub} onPointerUp={endScrub}>
          <div className="tl-film" style={{ left: x(0), width: dur * pps }}>
            {p.frames.map((f, i) => (
              <motion.img key={f} src={f} draggable={false} initial={{ opacity: 0 }} animate={{ opacity: 0.85 }} transition={tr(SETTLE, i * 0.02)}
                style={{ left: `${(i / p.frames.length) * 100}%`, width: `${100 / p.frames.length}%` }} />
            ))}
            {p.scenes.map((s, i) => (
              <div key={s.id + i} className="tl-scene" style={{ left: s.start * pps }}>
                {i > 0 && <i />}
                <span>{s.id.replace(/[-_]/g, ' ')}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
      {/* Notes lane */}
      <div className="tl-row" style={{ height: LANE_H, marginTop: GAP }}>
        <div className="tl-gutter" />
        <div className="tl-track tl-lane" onPointerDown={laneDown} onPointerMove={laneMove} onPointerUp={laneUp}>
          {p.comments.map((c) => {
            const l = x(c.time)
            const r = Math.max(l + 8, c.end != null ? x(c.end) : l + 8)
            return c.resolved
              ? <div key={c.id} className="tl-note done" style={{ left: l - 1, width: r - l }} />
              : <div key={c.id} className={`tl-note${p.selectedComment === c.id ? ' on' : ''}`} style={{ left: l - 1, width: r - l }} />
          })}
          {range && <div className="tl-range" style={{ left: x(Math.min(...range)), width: Math.max(2, Math.abs(x(range[1]) - x(range[0]))) }} />}
        </div>
      </div>
      {/* Layers (the drawer) */}
      <motion.div className="tl-layers" initial={false} animate={{ height: p.layersOpen ? layersH + GAP : 0, opacity: p.layersOpen ? 1 : 0 }} transition={tr(SETTLE)}>
        <div className="tl-layers-scroll" style={{ height: layersH }}>
          {p.layers.length === 0 && <div className="tl-empty faint">Layers appear as the video plays.</div>}
          {p.layers.map((l, ix) => (
            <LayerRow
              key={(l.id || l.sel || l.label) + ix}
              l={l}
              ix={ix}
              x={x}
              width={width}
              win={windowOf(ix)}
              edit={edit && edit.ix === ix ? edit : null}
              selected={p.selected === ix}
              tween={p.selected === ix ? p.tween : null}
              lit={p.selected === ix || (!!p.pickedId && !!l.id && p.pickedId === l.id)}
              cursor={cursorFor(drag?.ix === ix ? drag.grab : hoverGrab, !!drag)}
              onDown={(e) => rowDown(ix, e)}
              onMove={(e) => rowMove(ix, e)}
              onUp={rowUp}
            />
          ))}
        </div>
      </motion.div>
      {/* The playhead and the skimmer, over all of it */}
      <div className="tl-over" style={{ left: GUTTER }}>
        <div ref={head} className="tl-head"><i /></div>
        <AnimatePresence>
          {sx !== null && sx >= 0 && sx <= width && (
            <motion.div className="tl-skim" style={{ left: sx }} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={tr(QUICK)}>
              <span className="mono">{clock(skim!)}</span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      {/* Footer: the Layers toggle, the chosen layer's timing, zoom */}
      <div className="tl-foot">
        <div className="tl-gutter" style={{ height: 'auto' }}>
          <Tip title="Layers" keys="⌘L" body="Every element and when it moves.">
            <button className={`tl-layers-btn${p.layersOpen ? ' on' : ''}`} onClick={p.onToggleLayers}>
              <Icon name="layers" size={14} /> Layers · {p.layers.length}
            </button>
          </Tip>
        </div>
        <div className="tl-foot-mid">{p.footer}</div>
        <div className="tl-zoom">
          <button className="tl-zoom-btn" onClick={() => zoomAt(1 / 1.6, width / 2)} disabled={zoom <= 1}>−</button>
          <button className="tl-zoom-fit mono" onClick={() => setView([1, 0])}>{zoom > 1.01 ? `${zoom.toFixed(zoom < 10 ? 1 : 0)}×` : 'Fit'}</button>
          <button className="tl-zoom-btn" onClick={() => zoomAt(1.6, x(p.time))} disabled={zoom >= MAX_ZOOM}>+</button>
        </div>
      </div>
    </div>
  )
}

function LayerRow({ l, ix, x, width, win, edit, selected, tween, lit, cursor, onDown, onMove, onUp }: {
  l: Layer; ix: number; x: (t: number) => number; width: number; win: TimingLayer | null; edit: Edit | null
  selected: boolean; tween: number | null; lit: boolean; cursor: string
  onDown: (e: RPE) => void; onMove: (e: RPE) => void; onUp: () => void
}) {
  const glyph = GLYPH[l.kind] ?? '◆'
  let bar: React.ReactNode
  if (win) {
    const [at, len] = edit?.kind === 'window' ? [edit.at, edit.len] : [win.start!, win.end! - win.start!]
    const shift = at - win.start!
    const la = x(at)
    const lb = x(at + len)
    const w = Math.max(6, lb - la)
    const name = l.label
    const fits = w >= name.length * 6.4 + 30
    bar = (
      <>
        <div className={`tl-bar${selected ? ' on' : ''}`} style={{ left: la, width: w }}>
          {win.tweens.map((t, k) => {
            const [ts, td] = edit?.kind === 'tween' && edit.tw === k ? [edit.start, edit.dur] : [t.start + shift, t.duration]
            const a = x(ts) - la
            const b = x(ts + td) - la
            const on = selected && tween === k
            return (
              <div key={t.id + k} className={`tl-step${on ? ' on' : ''}${t.editable ? '' : ' fixed'}`} style={{ left: a, width: Math.max(4, b - a) }}>
                {selected && t.editable && <><i className="kf" style={{ left: 0 }} /><i className="kf" style={{ left: '100%' }} /></>}
              </div>
            )
          })}
          {fits && <span className="tl-bar-label"><b>{glyph}</b>{name}</span>}
        </div>
        {!fits && <span className="tl-after" style={{ left: lb + 8 }}><b>{glyph}</b>{name}</span>}
      </>
    )
  } else {
    // Can't move here: its spans, outlined.
    const a = Math.min(...l.spans.map((s) => s[0]))
    const b = Math.max(...l.spans.map((s) => s[1]))
    const la = x(a)
    const lb = x(b)
    const fits = lb - la >= l.label.length * 6.4 + 30
    bar = (
      <>
        {l.spans.map(([s0, s1], k) => (
          <div key={k} className={`tl-span${selected ? ' on' : ''}`} style={{ left: x(s0), width: Math.max(3, x(s1) - x(s0)) }} />
        ))}
        {fits ? <span className="tl-bar-label floating" style={{ left: la }}><b>{glyph}</b>{l.label}</span>
              : <span className="tl-after" style={{ left: Math.min(lb + 8, width - 60) }}><b>{glyph}</b>{l.label}</span>}
      </>
    )
  }
  return (
    <div className={`tl-row tl-layer${lit ? ' lit' : ''}`} style={{ height: LAYER_H }} data-ix={ix}>
      <div className="tl-gutter" />
      <div className="tl-track" style={{ cursor }} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}>
        {bar}
      </div>
    </div>
  )
}

/** The chosen layer's timing, under the timeline: nudges and the step's easing. */
export function LayerBar({ layer, win, tween, onNudge, onEase, onAdjustable }: {
  layer: Layer | null; win: TimingLayer | null; tween: number | null
  onNudge(dStart: number, dLen: number): void; onEase(ease: string): void; onAdjustable(): void
}) {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  if (!layer) return <span className="faint">Drag a bar to move it, its ends to stretch it · ⌘-scroll to zoom</span>
  if (!win) {
    return (
      <span className="tl-lbar">
        <b className="ellipsis">{layer.label}</b>
        <span className="faint">Can't move: {win === null && layer.id ? 'its timing is inside the script' : 'it has no element of its own'}.</span>
        <button className="btn ghost small" onClick={onAdjustable}>Make adjustable</button>
      </span>
    )
  }
  const t = tween != null ? win.tweens[tween] : null
  const [a, len] = t ? [t.start, t.duration] : [win.start!, win.end! - win.start!]
  const EASES = ['none', 'power1.out', 'power2.out', 'power3.out', 'power4.out', 'expo.out', 'back.out(1.7)', 'sine.inOut', 'power2.inOut', 'elastic.out(1, 0.5)']
  return (
    <span className="tl-lbar">
      <b className="ellipsis">{layer.label}</b>
      {t && <span className="faint">step: {t.method}</span>}
      <span className="nudge">
        <button onClick={() => onNudge(-0.1, 0)}>‹</button>
        <span className="faint">Starts</span><span className="mono">{a.toFixed(2)}s</span>
        <button onClick={() => onNudge(0.1, 0)}>›</button>
      </span>
      <span className="nudge">
        <button onClick={() => onNudge(0, -0.1)}>−</button>
        <span className="faint">Lasts</span><span className="mono">{len.toFixed(2)}s</span>
        <button onClick={() => onNudge(0, 0.1)}>+</button>
      </span>
      {t && (
        <>
          <button ref={anchor} className="nudge ease" onClick={() => setOpen((o) => !o)}>
            <span className="faint">Ease</span><span className="mono">{t.ease ?? 'power1.out'}</span><Icon name="chevron" size={11} />
          </button>
          <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} side="top" align="start" width={200}>
            <div className="menu">
              {EASES.map((e) => <MenuItem key={e} label={<span className="mono">{e}</span>} on={(t.ease ?? 'power1.out') === e} onSelect={() => {
                setOpen(false)
                onEase(e)
              }} />)}
            </div>
          </Popover>
        </>
      )}
    </span>
  )
}

export const _test = { stepFor, clampView, tickLabel }
void MOVE
