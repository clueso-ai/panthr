// Editing on the picture: what is chosen gets a box with handles. Drag it
// to move (CSS translate), a corner to resize (scale, about its centre),
// the knob above it to rotate (⇧: 15° steps). Its edges and centre catch
// on the frame's edges and centre and on everything else in it, with a
// guide line while they hold. ⌥-drag over the picture chooses everything
// it touches; ⇧-click adds to the choice. The chosen step's end point (where
// it moves to, when it moves in x or y) is a dot to drag.
//
// What moves is shown at once in the page and written when let go: an
// inline translate / scale / rotate on the element, which add to whatever
// its animation does. Safe margins, thirds, the centre and rulers can be
// laid over the picture too.

import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as RPE } from 'react'
import type { Box, Geom } from './usePreview'

export interface Guides { safe: boolean; thirds: boolean; center: boolean; rulers: boolean }
export const NO_GUIDES: Guides = { safe: false, thirds: false, center: false, rulers: false }

export interface Change { id: string; file: string; prop: 'translate' | 'scale' | 'rotate'; value: string }

/** A step that moves in x or y, to be dragged on the picture. */
export interface MotionStep { id: string; label: string; to: { x?: number; y?: number }; file: string }

const SNAP_PX = 6

const num = (v: string, i: number, d: number): number => {
  const p = v.trim().split(/\s+/)
  const n = parseFloat(p[i] ?? (i === 1 ? p[0] ?? '' : ''))
  return Number.isFinite(n) ? n : d
}
const translateOf = (v: string): [number, number] => (v.trim() ? [num(v, 0, 0), v.trim().split(/\s+/).length > 1 ? num(v, 1, 0) : 0] : [0, 0])
const r1 = (n: number): number => Math.round(n * 10) / 10
const union = (bs: Box[]): Box => {
  const x0 = Math.min(...bs.map((b) => b.x))
  const y0 = Math.min(...bs.map((b) => b.y))
  const x1 = Math.max(...bs.map((b) => b.x + b.w))
  const y1 = Math.max(...bs.map((b) => b.y + b.h))
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

type Drag =
  | { kind: 'move'; x0: number; y0: number }
  | { kind: 'scale'; cx: number; cy: number; d0: number; s0: number }
  | { kind: 'rotate'; cx: number; cy: number; a0: number; r0: number }
  | { kind: 'path'; cx: number; cy: number }
  | { kind: 'marquee'; x0: number; y0: number; x1: number; y1: number }

export function Handles({ geom, guides, editable, motion, live, onCommit, onMotion, onMarquee }: {
  geom: Geom | null
  guides: Guides
  /** Handles show (paused, select tool, something chosen). */
  editable: boolean
  motion: MotionStep | null
  /** Show a change in the page at once. */
  live(id: string, prop: string, value: string | null): void
  onCommit(changes: Change[]): void
  onMotion(step: MotionStep, to: { x?: number; y?: number }): void
  onMarquee(ids: string[]): void
}) {
  const root = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 1, h: 1 })
  const [drag, setDrag] = useState<Drag | null>(null)
  /** The offset being dragged (composition px), the scale, the angle, a path end. */
  const [delta, setDelta] = useState<{ dx: number; dy: number; scale: number | null; rot: number | null; path: [number, number] | null }>({ dx: 0, dy: 0, scale: null, rot: null, path: null })
  const [lines, setLines] = useState<{ x: number[]; y: number[] }>({ x: [], y: [] })
  const [alt, setAlt] = useState(false)

  useLayoutEffect(() => {
    const el = root.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth || 1, h: el.clientHeight || 1 }))
    ro.observe(el)
    setSize({ w: el.clientWidth || 1, h: el.clientHeight || 1 })
    return () => ro.disconnect()
  }, [])
  useEffect(() => {
    const k = (e: KeyboardEvent): void => setAlt(e.altKey)
    addEventListener('keydown', k)
    addEventListener('keyup', k)
    addEventListener('blur', () => setAlt(false))
    return () => {
      removeEventListener('keydown', k)
      removeEventListener('keyup', k)
    }
  }, [])

  if (!geom) return <div ref={root} className="hd-root" />
  const s = Math.min(size.w / geom.w, size.h / geom.h)
  const ox = (size.w - geom.w * s) / 2
  const oy = (size.h - geom.h * s) / 2
  const sx = (x: number): number => ox + x * s
  const sy = (y: number): number => oy + y * s
  const toComp = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = root.current!.getBoundingClientRect()
    return [(e.clientX - r.left - ox) / s, (e.clientY - r.top - oy) / s]
  }
  const items = geom.items
  const sel = items.length ? union(items.map((i) => i.box)) : null
  const single = items.length === 1 ? items[0] : null
  const shown: Box | null = sel && { x: sel.x + delta.dx, y: sel.y + delta.dy, w: sel.w, h: sel.h }

  // ── Snapping a moved box to the frame and everything else ──────────
  const snapMove = (dx: number, dy: number): [number, number, { x: number[]; y: number[] }] => {
    if (!sel) return [dx, dy, { x: [], y: [] }]
    const xs = [0, geom.w / 2, geom.w, ...geom.others.flatMap((o) => [o.box.x, o.box.x + o.box.w / 2, o.box.x + o.box.w])]
    const ys = [0, geom.h / 2, geom.h, ...geom.others.flatMap((o) => [o.box.y, o.box.y + o.box.h / 2, o.box.y + o.box.h])]
    const tol = SNAP_PX / s
    const best = (edges: number[], cands: number[]): [number, number] | null => {
      let b: [number, number] | null = null
      for (const e of edges) for (const c of cands) if (Math.abs(c - e) < tol && (!b || Math.abs(c - e) < Math.abs(b[0]))) b = [c - e, c]
      return b
    }
    const bx = best([sel.x + dx, sel.x + sel.w / 2 + dx, sel.x + sel.w + dx], xs)
    const by = best([sel.y + dy, sel.y + sel.h / 2 + dy, sel.y + sel.h + dy], ys)
    return [dx + (bx?.[0] ?? 0), dy + (by?.[0] ?? 0), { x: bx ? [bx[1]] : [], y: by ? [by[1]] : [] }]
  }

  const start = (kind: 'move' | 'scale' | 'rotate' | 'path', e: RPE): void => {
    if (e.button !== 0 || !sel) return
    e.stopPropagation()
    try {
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    } catch {}
    const [x, y] = toComp(e)
    const cx = sel.x + sel.w / 2
    const cy = sel.y + sel.h / 2
    if (kind === 'move') setDrag({ kind, x0: x, y0: y })
    else if (kind === 'scale' && single) setDrag({ kind, cx, cy, d0: Math.hypot(x - cx, y - cy) || 1, s0: num(single.scale || '1', 0, 1) })
    else if (kind === 'rotate' && single) setDrag({ kind, cx, cy, a0: Math.atan2(y - cy, x - cx), r0: parseFloat(single.rotate) || 0 })
    else if (kind === 'path') setDrag({ kind, cx, cy })
  }
  const move = (e: RPE): void => {
    if (!drag) return
    const [x, y] = toComp(e)
    if (drag.kind === 'move') {
      const [dx, dy, l] = snapMove(x - drag.x0, y - drag.y0)
      setLines(l)
      setDelta({ dx, dy, scale: null, rot: null, path: null })
      for (const it of items) {
        const [tx, ty] = translateOf(it.translate)
        live(it.id, 'translate', `${r1(tx + dx)}px ${r1(ty + dy)}px`)
      }
    } else if (drag.kind === 'scale' && single) {
      const f = Math.max(0.05, (Math.hypot(x - drag.cx, y - drag.cy) / drag.d0) * drag.s0)
      setDelta({ dx: 0, dy: 0, scale: Math.round(f * 1000) / 1000, rot: null, path: null })
      live(single.id, 'scale', String(Math.round(f * 1000) / 1000))
    } else if (drag.kind === 'rotate' && single) {
      let a = drag.r0 + ((Math.atan2(y - drag.cy, x - drag.cx) - drag.a0) * 180) / Math.PI
      if (e.shiftKey) a = Math.round(a / 15) * 15
      a = Math.round(a * 10) / 10
      setDelta({ dx: 0, dy: 0, scale: null, rot: a, path: null })
      live(single.id, 'rotate', `${a}deg`)
    } else if (drag.kind === 'path') {
      setDelta({ dx: 0, dy: 0, scale: null, rot: null, path: [x, y] })
    } else if (drag.kind === 'marquee') {
      setDrag({ ...drag, x1: x, y1: y })
    }
  }
  const up = (): void => {
    if (!drag) return
    if (drag.kind === 'move' && (Math.abs(delta.dx) > 0.5 || Math.abs(delta.dy) > 0.5)) {
      onCommit(items.filter((i) => i.hasId).map((it) => {
        const [tx, ty] = translateOf(it.translate)
        return { id: it.id, file: it.file, prop: 'translate', value: `${r1(tx + delta.dx)}px ${r1(ty + delta.dy)}px` }
      }))
    } else if (drag.kind === 'scale' && single && delta.scale != null) onCommit([{ id: single.id, file: single.file, prop: 'scale', value: String(delta.scale) }])
    else if (drag.kind === 'rotate' && single && delta.rot != null) onCommit([{ id: single.id, file: single.file, prop: 'rotate', value: `${delta.rot}deg` }])
    else if (drag.kind === 'path' && motion && single && delta.path) {
      const [px, py] = delta.path
      const cx = drag.cx
      const cy = drag.cy
      const to: { x?: number; y?: number } = {}
      if (motion.to.x !== undefined) to.x = Math.round(single.x + (px - cx))
      if (motion.to.y !== undefined) to.y = Math.round(single.y + (py - cy))
      onMotion(motion, to)
    } else if (drag.kind === 'marquee') {
      const box = { x: Math.min(drag.x0, drag.x1), y: Math.min(drag.y0, drag.y1), w: Math.abs(drag.x1 - drag.x0), h: Math.abs(drag.y1 - drag.y0) }
      const hit = (b: Box): boolean => b.x < box.x + box.w && b.x + b.w > box.x && b.y < box.y + box.h && b.y + b.h > box.y
      if (box.w > 2 && box.h > 2) onMarquee([...geom.others, ...items].filter((o) => hit(o.box)).map((o) => o.id))
    }
    setDrag(null)
    setLines({ x: [], y: [] })
    // The new place shows until the page reloads with it written.
    setTimeout(() => setDelta({ dx: 0, dy: 0, scale: null, rot: null, path: null }), 700)
  }

  // The chosen step's end point: where it moves to, from where it is now.
  let pathEnd: [number, number] | null = null
  if (motion && single && editable) {
    const cx = single.box.x + single.box.w / 2
    const cy = single.box.y + single.box.h / 2
    pathEnd = delta.path ?? [cx + ((motion.to.x ?? single.x) - single.x), cy + ((motion.to.y ?? single.y) - single.y)]
  }

  return (
    <div ref={root} className={`hd-root${alt && editable ? ' marquee' : ''}`}
      onPointerDown={(e) => {
        if (!alt || !editable || e.button !== 0) return
        try {
          ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
        } catch {}
        const [x, y] = toComp(e)
        setDrag({ kind: 'marquee', x0: x, y0: y, x1: x, y1: y })
      }}
      onPointerMove={move} onPointerUp={up}>
      {/* Guides over the frame */}
      {guides.safe && <>
        <div className="hd-safe" style={{ left: sx(geom.w * 0.05), top: sy(geom.h * 0.05), width: geom.w * 0.9 * s, height: geom.h * 0.9 * s }} />
        <div className="hd-safe title" style={{ left: sx(geom.w * 0.1), top: sy(geom.h * 0.1), width: geom.w * 0.8 * s, height: geom.h * 0.8 * s }} />
      </>}
      {guides.thirds && [1, 2].map((k) => <div key={`t${k}`}>
        <div className="hd-line v" style={{ left: sx((geom.w * k) / 3), top: oy, height: geom.h * s }} />
        <div className="hd-line h" style={{ top: sy((geom.h * k) / 3), left: ox, width: geom.w * s }} />
      </div>)}
      {guides.center && <>
        <div className="hd-line v c" style={{ left: sx(geom.w / 2), top: oy, height: geom.h * s }} />
        <div className="hd-line h c" style={{ top: sy(geom.h / 2), left: ox, width: geom.w * s }} />
      </>}
      {guides.rulers && <Rulers w={geom.w} h={geom.h} s={s} ox={ox} oy={oy} />}
      {/* Where a moved edge caught */}
      {lines.x.map((x) => <div key={`sx${x}`} className="hd-snap v" style={{ left: sx(x), top: oy, height: geom.h * s }} />)}
      {lines.y.map((y) => <div key={`sy${y}`} className="hd-snap h" style={{ top: sy(y), left: ox, width: geom.w * s }} />)}
      {/* The chosen things */}
      {editable && shown && (
        <>
          {items.length > 1 && items.map((it) => <div key={it.id} className="hd-member" style={{ left: sx(it.box.x + delta.dx), top: sy(it.box.y + delta.dy), width: it.box.w * s, height: it.box.h * s }} />)}
          <div className={`hd-box${items.every((i) => i.hasId) ? '' : ' locked'}`} style={{ left: sx(shown.x), top: sy(shown.y), width: shown.w * s, height: shown.h * s }}
            title={items.every((i) => i.hasId) ? undefined : 'It has no id of its own: ask the agent to give it one to move it here'}
            onPointerDown={(e) => items.every((i) => i.hasId) && start('move', e)}>
            {single && single.hasId && <>
              {(['nw', 'ne', 'sw', 'se'] as const).map((c) => <i key={c} className={`hd-corner ${c}`} onPointerDown={(e) => start('scale', e)} />)}
              <i className="hd-rot" onPointerDown={(e) => start('rotate', e)} />
              {(delta.scale != null || delta.rot != null) && <span className="hd-readout mono">{delta.scale != null ? `${Math.round(delta.scale * 100)}%` : `${delta.rot}°`}</span>}
            </>}
            {(Math.abs(delta.dx) > 0.5 || Math.abs(delta.dy) > 0.5) && <span className="hd-readout mono">{Math.round(delta.dx)}, {Math.round(delta.dy)}</span>}
          </div>
        </>
      )}
      {pathEnd && single && (
        <>
          <svg className="hd-path" width={size.w} height={size.h}>
            <line x1={sx(single.box.x + single.box.w / 2)} y1={sy(single.box.y + single.box.h / 2)} x2={sx(pathEnd[0])} y2={sy(pathEnd[1])} />
          </svg>
          <i className="hd-path-end" style={{ left: sx(pathEnd[0]), top: sy(pathEnd[1]) }} title={`${motion!.label}: where it moves to`} onPointerDown={(e) => start('path', e)} />
        </>
      )}
      {drag?.kind === 'marquee' && <div className="hd-marquee" style={{ left: sx(Math.min(drag.x0, drag.x1)), top: sy(Math.min(drag.y0, drag.y1)), width: Math.abs(drag.x1 - drag.x0) * s, height: Math.abs(drag.y1 - drag.y0) * s }} />}
    </div>
  )
}

/** Composition-pixel rulers along the top and left of the frame. */
function Rulers({ w, h, s, ox, oy }: { w: number; h: number; s: number; ox: number; oy: number }) {
  const step = [50, 100, 200, 500].find((st) => st * s >= 40) ?? 1000
  const xs: number[] = []
  const ys: number[] = []
  for (let x = 0; x <= w; x += step) xs.push(x)
  for (let y = 0; y <= h; y += step) ys.push(y)
  return (
    <>
      <div className="hd-ruler top" style={{ left: ox, top: oy, width: w * s }}>
        {xs.map((x) => <span key={x} style={{ left: x * s }}>{x}</span>)}
      </div>
      <div className="hd-ruler left" style={{ left: ox, top: oy, height: h * s }}>
        {ys.map((y) => <span key={y} style={{ top: y * s }}>{y}</span>)}
      </div>
    </>
  )
}
