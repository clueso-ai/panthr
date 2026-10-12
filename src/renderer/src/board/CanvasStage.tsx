// A project's canvas: its videos and reference videos as tiles you pan and
// zoom, arrows from what each came from. One video is active: it plays live
// over its tile at screen size (sharp at any zoom), and the editor's timeline
// and inspector work on it. Clicking a video makes it active and brings it
// up big; clicking empty canvas lets it go.

import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, animate, motion, useMotionValue, useMotionValueEvent } from 'motion/react'
import type { Board as BoardData, BoardView, CanvasNote, Project, Reference } from '@shared/types'
import { api, settingsNow, useEvent, useReferences } from '@/lib/api'
import { EASE, rise, tr, MOVE, SETTLE } from '@/lib/motion'
import { ago } from '@/lib/format'
import { Icon } from '@/ui/Icon'
import { Mark } from '@/ui/Mark'
import { IconButton } from '@/ui/Controls'
import { ThemeToggle } from '@/ui/ThemeToggle'
import { ActivityStatus, useActivity } from '@/ui/Activity'
import { Tip } from '@/ui/Tooltip'
import { ReferencesSection, RefSheet } from '@/editor/References'
import { RecordButton } from './Record'
import { Compare } from './Compare'
import { BrandCard } from './Brand'
import { ArrowLabel, NoteCard, NOTE_W, noteMessage } from './Notes'
import { MenuItem, MenuSep, Popover } from '@/ui/Popover'
import './board.css'

/** A line for the canvas to show (from outside it: a .panthr opened, a share saved). */
let pendingNote: string | null = null
const noteSubs = new Set<(t: string) => void>()
export function sayOnCanvas(text: string): void {
  if (noteSubs.size) noteSubs.forEach((f) => f(text))
  else pendingNote = text
}

const ZOOM = { min: 0.15, max: 4 }
const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v))
const dur = (d: number): number => (settingsNow().reduce_motion ? 0 : d)
/** Where the picture sits inside a tile (its padding, and the words under it). */
const PAD = 8
const WORDS = 50

/** Memoised: the editor re-renders on every playback tick; the canvas only
 *  when what it shows changes. */
export const CanvasStage = memo(function CanvasStage({ canvas, active, onActivate, chatWorking, overlay, onSettings, onMention, onAsk }: {
  canvas: string
  /** The video being edited (its folder), or none. */
  active: string | null
  onActivate(dir: string | null): void
  /** The project's conversation is working (the videos it made light up). */
  chatWorking: boolean
  /** The active video, live: placed over its tile at screen size. */
  overlay: ReactNode
  onSettings(): void
  onMention(handle: string): void
  /** Ask the project's conversation (for what the agent makes, like other sizes). */
  onAsk(text: string): void
}) {
  const [board, setBoard] = useState<BoardData | null>(null)
  const [videos, setVideos] = useState<Map<string, Project>>(new Map())
  const refs = useReferences()
  const activity = useActivity()
  const [fresh, setFresh] = useState<Set<string>>(new Set())
  const [openRef, setOpenRef] = useState<string | null>(null)
  /** Videos picked with ⌘ or ⇧ for something done to several (compare, export). */
  const [picked, setPicked] = useState<string[]>([])
  const [comparing, setComparing] = useState<string[] | null>(null)
  // ── Exporting several: one after another, each with its progress on its tile ──
  const [exports, setExports] = useState<Record<string, { percent: number; stage: string; file?: string; failed?: string }>>({})
  const exportRun = useRef(false)
  useEvent('job', (j) => {
    if (!(j.dir in exports)) return
    setExports((x) => {
      const was = x[j.dir]
      if (!was) return x
      if (j.type === 'progress') return { ...x, [j.dir]: { ...was, percent: j.percent } }
      if (j.type === 'stage') return { ...x, [j.dir]: { ...was, stage: j.text } }
      if (j.type === 'rendered') return { ...x, [j.dir]: { ...was, percent: 100, stage: 'Done', file: j.version.file } }
      if (j.type === 'failed') return { ...x, [j.dir]: { ...was, stage: 'Failed', failed: j.error } }
      return x
    })
  }, [exports])
  const exportAll = async (dirs: string[]): Promise<void> => {
    if (exportRun.current || !dirs.length) return
    exportRun.current = true
    setExports(Object.fromEntries(dirs.map((d) => [d, { percent: 0, stage: 'Waiting' }])))
    const done: { dir: string; file: string }[] = []
    let failed = 0
    for (const dir of dirs) {
      const result = await new Promise<string | null>((ok) => {
        const off = api.on('job', (j) => {
          if (j.dir !== dir) return
          if (j.type === 'rendered') { off(); ok(j.version.file) }
          else if (j.type === 'failed') { off(); ok(null) }
        })
        api.review.render(dir)
      })
      if (result) done.push({ dir, file: result })
      else failed++
    }
    exportRun.current = false
    if (done.length) {
      const folder = await api.board.collect(canvas, done)
      api.app.reveal(folder)
      setNote(`Exported ${done.length} video${done.length === 1 ? '' : 's'} into ${folder.split('/').slice(-2).join('/')}${failed ? `; ${failed} failed (see its Versions)` : ''}.`)
    } else setNote('The export failed. Open a video and look at its Versions.')
    setTimeout(() => setExports({}), 4000)
  }

  const togglePick = (key: string): void => setPicked((ps) => (ps.includes(key) ? ps.filter((k) => k !== key) : [...ps, key]))
  const [refsOpen, setRefsOpen] = useState(false)

  /** The videos on the canvas (name, poster, when edited). */
  const loadVideos = useCallback((b: BoardData | null) => {
    if (!b) return
    const dirs = Object.keys(b.tiles).filter((k) => !k.startsWith('ref:'))
    Promise.all(dirs.map((d) => api.projects.load(d))).then((all) => setVideos(new Map(all.filter((p): p is Project => !!p).map((p) => [p.dir, p]))))
  }, [])
  useEffect(() => {
    api.board.get(canvas).then((b) => {
      setBoard(b)
      loadVideos(b)
    })
  }, [canvas, loadVideos])
  useEvent('board:changed', (b) => {
    if (b.dir !== canvas) return
    setBoard(b)
    loadVideos(b)
  }, [canvas])
  useEvent('project:renamed', () => loadVideos(board), [board])
  useEvent('chat:turn', () => loadVideos(board), [board])

  // ── The view: canvas → screen is o + p·z ──────────────────────
  const stage = useRef<HTMLDivElement>(null)
  const ox = useMotionValue(0)
  const oy = useMotionValue(0)
  const z = useMotionValue(1)
  // The zoom percentage, written straight into its label (not a re-render per frame).
  const zoomLabel = useRef<HTMLButtonElement>(null)
  useMotionValueEvent(z, 'change', (v) => {
    if (zoomLabel.current) zoomLabel.current.textContent = `${Math.round(v * 100)}%`
  })
  const size = (): { w: number; h: number } => {
    const r = stage.current?.getBoundingClientRect()
    return { w: r?.width ?? 800, h: r?.height ?? 600 }
  }
  /** The canvas point at the centre of the stage. */
  const centre = (): BoardView => {
    const { w, h } = size()
    return { x: (w / 2 - ox.get()) / z.get(), y: (h / 2 - oy.get()) / z.get(), zoom: z.get() }
  }
  const setView = (v: BoardView): void => {
    const { w, h } = size()
    z.set(v.zoom)
    ox.set(w / 2 - v.x * v.zoom)
    oy.set(h / 2 - v.y * v.zoom)
  }
  const anims = useRef<{ stop(): void }[]>([])
  const glide = (v: BoardView, d = 0.7): Promise<void> => {
    anims.current.forEach((a) => a.stop())
    const { w, h } = size()
    const opts = { duration: dur(d), ease: EASE }
    const a = [animate(z, v.zoom, opts), animate(ox, w / 2 - v.x * v.zoom, opts), animate(oy, h / 2 - v.y * v.zoom, opts)]
    anims.current = a
    return Promise.all(a).then(() => undefined)
  }
  // Remember where the canvas was looked at (a moment after it stops).
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const remember = (): void => {
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => api.board.setView(canvas, centre()), 400)
  }
  useMotionValueEvent(ox, 'change', remember)
  useMotionValueEvent(z, 'change', remember)

  const tile = board?.tile ?? { w: 320, h: 230 }
  const shot = { w: tile.w - PAD * 2, h: tile.h - WORDS }
  const at = (key: string): { x: number; y: number } | null => board?.tiles[key] ?? null
  const tileView = (key: string, zoom?: number): BoardView | null => {
    const p = at(key)
    if (!p) return null
    return { x: p.x + tile.w / 2, y: p.y + tile.h / 2, zoom: zoom ?? clamp(Math.max(z.get(), 0.7), ZOOM.min, 1) }
  }
  /** The active video brought up big: its picture fills the stage, with room around. */
  const bigView = (key: string): BoardView | null => {
    const p = at(key)
    if (!p) return null
    const { w, h } = size()
    // About three quarters of the stage, so the videos beside it peek in.
    const zoom = clamp(Math.min((w * 0.78) / shot.w, (h * 0.8) / shot.h), ZOOM.min, ZOOM.max)
    return { x: p.x + PAD + shot.w / 2, y: p.y + PAD + shot.h / 2, zoom }
  }

  // First view: the active video big, else where it was, else everything.
  const placed = useRef(false)
  useEffect(() => {
    if (!board || placed.current || !stage.current) return
    placed.current = true
    const big = active ? bigView(active) : null
    setView(big ?? board.view ?? fitView(board, size(), tile))
  }, [board]) // eslint-disable-line react-hooks/exhaustive-deps
  // A video made active (here, or by the agent): bring it up.
  const lastActive = useRef<string | null>(active)
  /** The person moved the view since the active video was brought up. */
  const moved = useRef(false)
  useEffect(() => {
    if (!placed.current || active === lastActive.current) return
    lastActive.current = active
    moved.current = false
    if (active) {
      const v = bigView(active)
      if (v) glide(v, 0.6)
    }
  }, [active]) // eslint-disable-line react-hooks/exhaustive-deps
  // The space changed (the timeline opening, the window resized): keep the
  // active video fitted, unless the view was moved by hand.
  useEffect(() => {
    const el = stage.current
    if (!el) return
    let last = { w: 0, h: 0 }
    const ro = new ResizeObserver(() => {
      const now = size()
      if (Math.abs(now.w - last.w) < 2 && Math.abs(now.h - last.h) < 2) return
      last = now
      if (!active || moved.current || !placed.current) return
      const v = bigView(active)
      if (v) glide(v, 0.35)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }) // eslint-disable-line react-hooks/exhaustive-deps

  /** A new tile from the agent: it drops in, plays, and becomes the active video. */
  const show = (key: string, isFresh: boolean): void => {
    if (isFresh) {
      setFresh((f) => new Set(f).add(key))
      if (!key.startsWith('ref:')) api.projects.watch(key)
    }
    if (!key.startsWith('ref:')) {
      if (key === active) {
        const v = bigView(key)
        if (v) glide(v)
      } else onActivate(key)
    } else {
      const v = tileView(key)
      if (v) glide(v)
    }
  }
  const pendingFocus = useRef<{ key: string; fresh: boolean } | null>(null)
  useEvent('board:focus', (e) => {
    if (e.canvas !== canvas) return
    if (board?.tiles[e.key]) show(e.key, e.fresh)
    else pendingFocus.current = e
  }, [board, canvas, active])
  useEffect(() => {
    const p = pendingFocus.current
    if (p && board?.tiles[p.key]) {
      pendingFocus.current = null
      show(p.key, p.fresh)
    }
  }, [board]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Pan and zoom: trackpad scroll pans, pinch (or ⌘-scroll) zooms ──
  const zoomAt = (factor: number, cx: number, cy: number): void => {
    anims.current.forEach((a) => a.stop())
    const z0 = z.get()
    const z1 = clamp(z0 * factor, ZOOM.min, ZOOM.max)
    const r = stage.current!.getBoundingClientRect()
    const sx = cx - r.left
    const sy = cy - r.top
    ox.set(sx - ((sx - ox.get()) * z1) / z0)
    oy.set(sy - ((sy - oy.get()) * z1) / z0)
    z.set(z1)
  }
  useEffect(() => {
    const el = stage.current
    if (!el) return
    const wheel = (e: WheelEvent): void => {
      if ((e.target as HTMLElement).closest('.board-ui')) return
      e.preventDefault()
      moved.current = true
      if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY)
      else {
        anims.current.forEach((a) => a.stop())
        ox.set(ox.get() - e.deltaX)
        oy.set(oy.get() - e.deltaY)
      }
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  })
  const panFrom = useRef<{ x: number; y: number; ox: number; oy: number; moved: boolean } | null>(null)
  const zoomBy = (f: number): void => {
    moved.current = true
    glide({ ...centre(), zoom: clamp(z.get() * f, ZOOM.min, ZOOM.max) }, 0.3)
  }
  /** Bring things in: placed from a canvas point (the drop point, else the view's centre). */
  const [note, setNote] = useState<string | null>(null)
  const bringIn = async (paths: string[], where?: { x: number; y: number }): Promise<void> => {
    if (!paths.length) return
    const r = await api.board.import(canvas, paths, where ?? null)
    const parts = [
      r.projects.length && `${r.projects.length} video${r.projects.length === 1 ? '' : 's'}`,
      r.references.length && `${r.references.length} reference${r.references.length === 1 ? '' : 's'} to take apart`,
      r.library.length && `${r.library.length} file${r.library.length === 1 ? '' : 's'} into the Library`
    ].filter(Boolean)
    const skipped = r.skipped.length ? `Skipped ${r.skipped.map((k) => `${k.path.split('/').pop()} (${k.why})`).join(', ')}` : ''
    setNote([parts.length ? `Brought in ${parts.join(', ')}.` : '', skipped].filter(Boolean).join(' '))
  }
  // Esc closes the references sheet (its button says so).
  useEffect(() => {
    if (!refsOpen) return
    const k = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !document.querySelector('.ref-sheet')) {
        e.stopPropagation()
        setRefsOpen(false)
      }
    }
    addEventListener('keydown', k, true)
    return () => removeEventListener('keydown', k, true)
  }, [refsOpen])
  useEffect(() => {
    if (pendingNote) {
      setNote(pendingNote)
      pendingNote = null
    }
    noteSubs.add(setNote)
    return () => {
      noteSubs.delete(setNote)
    }
  }, [])
  useEffect(() => {
    if (!note) return
    const id = setTimeout(() => setNote(null), 5000)
    return () => clearTimeout(id)
  }, [note])
  useEffect(() => {
    const f = (e: Event): void => {
      const d = (e as CustomEvent<{ paths: string[]; x: number; y: number }>).detail
      e.preventDefault()
      const r = stage.current?.getBoundingClientRect()
      const inside = r && d.x >= r.left && d.x <= r.right && d.y >= r.top && d.y <= r.bottom
      const where = inside ? { x: (d.x - r!.left - ox.get()) / z.get() - tile.w / 2, y: (d.y - r!.top - oy.get()) / z.get() - tile.h / 2 } : undefined
      void bringIn(d.paths, where)
    }
    addEventListener('panthr:drop-paths', f)
    return () => removeEventListener('panthr:drop-paths', f)
  })
  const fitAll = (): void => {
    if (board) glide(fitView(board, size(), tile), 0.6)
  }

  // ── Moving tiles ───────────────────────────────────────────────
  const [drag, setDrag] = useState<{ key: string; x: number; y: number } | null>(null)
  const dragFrom = useRef<{ key: string; px: number; py: number; x: number; y: number; moved: boolean } | null>(null)
  const pos = (key: string): { x: number; y: number } | null => (drag?.key === key ? drag : at(key))

  // ── The active video, over its tile at screen size ─────────────
  const ovX = useMotionValue(0)
  const ovY = useMotionValue(0)
  const ovW = useMotionValue(0)
  const ovH = useMotionValue(0)
  const ovS = useMotionValue(1)
  const activeAt = active ? pos(active) : null
  // While the zoom changes, the live video is scaled as a picture; its frame
  // takes the new size once the zoom rests, so the video lays itself out
  // once, not on every step of a pinch.
  const sized = useRef(0)
  const settle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const place = (): void => {
    if (!activeAt) return
    const k = z.get()
    if (!sized.current) sized.current = k
    ovX.set(ox.get() + (activeAt.x + PAD) * k)
    ovY.set(oy.get() + (activeAt.y + PAD) * k)
    ovW.set(shot.w * sized.current)
    ovH.set(shot.h * sized.current)
    ovS.set(k / sized.current)
    if (Math.abs(k - sized.current) > 1e-6) {
      clearTimeout(settle.current)
      settle.current = setTimeout(() => {
        sized.current = z.get()
        place()
      }, 140)
    }
  }
  useMotionValueEvent(ox, 'change', place)
  useMotionValueEvent(oy, 'change', place)
  useMotionValueEvent(z, 'change', place)
  useEffect(place, [activeAt?.x, activeAt?.y, shot.w, shot.h]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Notes and instruction arrows ────────────────────────────────
  const notes = board?.notes ?? []
  const [editingNote, setEditingNote] = useState<string | null>(null)
  const saveNotes = (next: CanvasNote[], persist = true): void => {
    setBoard((b) => (b ? { ...b, notes: next } : b))
    if (persist) api.board.notes(canvas, next)
  }
  const patchNote = (id: string, p: Partial<CanvasNote>, persist = true): void => saveNotes(notes.map((n) => (n.id === id ? { ...n, ...p } : n)), persist)
  const nameOf = (key: string): string => (key.startsWith('ref:') ? `@${refOf(key)?.handle ?? key}` : videos.get(key)?.meta.name ?? key.split('/').pop() ?? key)
  const sendNotes = (ns: CanvasNote[]): void => {
    const open = ns.filter((n) => !n.done && n.text.trim())
    if (!open.length) return
    onAsk(open.length === 1 ? noteMessage(open[0], nameOf) : `Notes on the canvas:\n${open.map((n) => `- ${noteMessage(n, nameOf)}`).join('\n')}`)
    saveNotes(notes.map((n) => (open.some((o) => o.id === n.id) ? { ...n, done: true } : n)))
  }
  /** A canvas point from a point on screen. */
  const toCanvas = (cx: number, cy: number): { x: number; y: number } => {
    const r = stage.current!.getBoundingClientRect()
    return { x: (cx - r.left - ox.get()) / z.get(), y: (cy - r.top - oy.get()) / z.get() }
  }
  const tileAt = (p: { x: number; y: number }): string | null =>
    Object.entries(board?.tiles ?? {}).find(([, t]) => p.x >= t.x && p.x <= t.x + tile.w && p.y >= t.y && p.y <= t.y + tile.h)?.[0] ?? null
  const newNote = (cx: number, cy: number): void => {
    const p = toCanvas(cx, cy)
    const n: CanvasNote = { id: Math.random().toString(16).slice(2, 10), kind: 'note', text: '', x: p.x - NOTE_W / 2, y: p.y - 30, on: tileAt(p), done: false, at: Math.floor(Date.now() / 1000) }
    saveNotes([...notes, n], false)
    setEditingNote(n.id)
  }
  /** Drag a note: it moves with the pointer, saved where it is let go (on a tile, it is about that tile). */
  const dragNote = (n: CanvasNote, e: React.PointerEvent): void => {
    const start = { px: e.clientX, py: e.clientY, x: n.x ?? 0, y: n.y ?? 0 }
    let moved = false
    const move = (m: PointerEvent): void => {
      const dx = (m.clientX - start.px) / z.get()
      const dy = (m.clientY - start.py) / z.get()
      if (!moved && Math.hypot(dx, dy) * z.get() < 3) return
      moved = true
      patchNote(n.id, { x: start.x + dx, y: start.y + dy }, false)
    }
    const up = (m: PointerEvent): void => {
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
      if (!moved) return
      const x = start.x + (m.clientX - start.px) / z.get()
      const y = start.y + (m.clientY - start.py) / z.get()
      patchNote(n.id, { x, y, on: tileAt({ x: x + NOTE_W / 2, y: y + 20 }) })
    }
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
  }
  /** Drag from a tile's handle to another tile: an arrow saying what should happen. */
  const [linking, setLinking] = useState<{ from: string; x: number; y: number } | null>(null)
  const startLink = (from: string, e: React.PointerEvent): void => {
    e.stopPropagation()
    e.preventDefault()
    setLinking({ from, ...toCanvas(e.clientX, e.clientY) })
    const move = (m: PointerEvent): void => setLinking({ from, ...toCanvas(m.clientX, m.clientY) })
    const up = (m: PointerEvent): void => {
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
      setLinking(null)
      const to = tileAt(toCanvas(m.clientX, m.clientY))
      if (!to || to === from) return
      const n: CanvasNote = { id: Math.random().toString(16).slice(2, 10), kind: 'arrow', text: '', from, to, done: false, at: Math.floor(Date.now() / 1000) }
      saveNotes([...notes, n])
      setEditingNote(n.id)
    }
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
  }
  const openNotes = notes.filter((n) => !n.done && n.text.trim())

  // ── What the tiles show ────────────────────────────────────────
  const keys = useMemo(() => Object.keys(board?.tiles ?? {}), [board])
  // The conversation is the project's: while it works, the videos it made this time show it.
  const working = (dir: string): boolean => activity.turns.has(dir) || (chatWorking && fresh.has(dir))
  const refOf = (key: string): Reference | undefined => refs.find((r) => `ref:${r.id}` === key)
  const empty = board && keys.length === 0

  return (
    <div
      ref={stage}
      className="board-stage"
      onPointerDown={(e) => {
        // Only presses on the canvas itself: React also passes up presses
        // from the sheets drawn above the window (a portal), which are not in it.
        if (!e.currentTarget.contains(e.target as Node)) return
        if ((e.target as HTMLElement).closest('.tile, .board-ui, .canvas-live')) return
        anims.current.forEach((a) => a.stop())
        e.currentTarget.setPointerCapture(e.pointerId)
        panFrom.current = { x: e.clientX, y: e.clientY, ox: ox.get(), oy: oy.get(), moved: false }
      }}
      onPointerMove={(e) => {
        const p = panFrom.current
        if (!p) return
        if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > 3) p.moved = moved.current = true
        ox.set(p.ox + e.clientX - p.x)
        oy.set(p.oy + e.clientY - p.y)
      }}
      onPointerUp={(e) => {
        if (!e.currentTarget.contains(e.target as Node) && !panFrom.current) return
        // A click on empty canvas (not a drag) lets the active video go.
        if (panFrom.current && !panFrom.current.moved) onActivate(null)
        panFrom.current = null
      }}
      onPointerCancel={() => (panFrom.current = null)}
      onDoubleClick={(e) => {
        if (!e.currentTarget.contains(e.target as Node)) return
        if ((e.target as HTMLElement).closest('.tile, .board-ui, .canvas-live, .canvas-note, .arrow-label')) return
        newNote(e.clientX, e.clientY)
      }}
    >
      <div className="board-dots" />
      <motion.div className="board-canvas" style={{ x: ox, y: oy, scale: z }}>
        <svg className="board-links" style={{ overflow: 'visible' }}>
          {board?.links.map((l) => {
            const a = pos(l.from)
            const b = pos(l.to)
            if (!a || !b) return null
            const x1 = a.x + tile.w
            const y1 = a.y + tile.h / 2 - 18
            const x2 = b.x
            const y2 = b.y + tile.h / 2 - 18
            const bend = Math.max(60, Math.abs(x2 - x1) / 2)
            return (
              <motion.path
                key={`${l.from}>${l.to}`}
                d={`M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2 - 6} ${y2}`}
                className="board-link"
                initial={{ pathLength: 0, opacity: 0 }}
                animate={{ pathLength: 1, opacity: 1 }}
                transition={tr(SETTLE)}
                markerEnd="url(#board-arrow)"
              />
            )
          })}
          {notes.filter((n) => n.kind === 'arrow').map((n) => {
            const a = pos(n.from!)
            const b = pos(n.to!)
            if (!a || !b) return null
            const [x1, y1, x2, y2] = [a.x + tile.w / 2, a.y + tile.h / 2, b.x + tile.w / 2, b.y + tile.h / 2]
            return <path key={n.id} d={`M ${x1} ${y1} Q ${(x1 + x2) / 2} ${Math.min(y1, y2) - 120}, ${x2} ${y2}`} className={`board-ask${n.done ? ' done' : ''}`} markerEnd="url(#board-arrow)" />
          })}
          {linking && pos(linking.from) && (() => {
            const a = pos(linking.from)!
            return <path d={`M ${a.x + tile.w / 2} ${a.y + tile.h / 2} L ${linking.x} ${linking.y}`} className="board-ask" />
          })()}
          <defs>
            <marker id="board-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 1 L 9 5 L 0 9" className="board-link-head" />
            </marker>
          </defs>
        </svg>
        <AnimatePresence>
          {keys.map((key) => {
            const p = pos(key)!
            const ref = key.startsWith('ref:') ? refOf(key) : undefined
            const video = ref ? undefined : videos.get(key)
            if (!ref && !video) return null
            const isActive = key === active
            return (
              <motion.div
                key={key}
                data-key={key}
                className={`tile${isActive ? ' on active-tile' : ''}${picked.includes(key) ? ' picked' : ''}${drag?.key === key ? ' dragging' : ''}${working(key) ? ' busy' : ''}`}
                style={{ left: p.x, top: p.y, width: tile.w }}
                initial={fresh.has(key) ? { opacity: 0, scale: 0.85, y: -24 } : { opacity: 0 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95 }}
                transition={tr(fresh.has(key) ? 0.6 : SETTLE)}
                onPointerDown={(e) => {
                  if (e.button !== 0) return
                  e.stopPropagation()
                  e.currentTarget.setPointerCapture(e.pointerId)
                  dragFrom.current = { key, px: e.clientX, py: e.clientY, x: p.x, y: p.y, moved: false }
                }}
                onPointerMove={(e) => {
                  const d = dragFrom.current
                  if (!d || d.key !== key) return
                  const dx = (e.clientX - d.px) / z.get()
                  const dy = (e.clientY - d.py) / z.get()
                  if (!d.moved && Math.hypot(dx, dy) * z.get() < 4) return
                  d.moved = true
                  setDrag({ key, x: d.x + dx, y: d.y + dy })
                }}
                onPointerUp={(e) => {
                  const d = dragFrom.current
                  dragFrom.current = null
                  if (!d) return
                  // ⌘ or ⇧: pick several videos.
                  if (!d.moved && !ref && (e.metaKey || e.shiftKey)) {
                    togglePick(key)
                    return
                  }
                  if (d.moved && drag) {
                    const { x, y } = drag
                    setBoard((b) => (b ? { ...b, tiles: { ...b.tiles, [key]: { x, y } } } : b))
                    setDrag(null)
                    api.board.move(canvas, key, x, y)
                  } else if (ref) setOpenRef(ref.id)
                  else if (isActive) {
                    const v = bigView(key)
                    if (v) glide(v, 0.5)
                  } else onActivate(key)
                }}
              >
                <span className="tile-handle" title="Drag to another video: say what should happen" onPointerDown={(e) => startLink(key, e)} />
                {ref ? <RefTile r={ref} h={tile.h} /> : <VideoTile p={video!} h={tile.h} live={!isActive && (fresh.has(key) || working(key))} active={isActive} working={working(key)} exporting={exports[key]} />}
              </motion.div>
            )
          })}
        </AnimatePresence>
        {notes.filter((n) => n.kind === 'arrow').map((n) => {
          const a = pos(n.from!)
          const b = pos(n.to!)
          if (!a || !b) return null
          const mid = { x: (a.x + b.x + tile.w) / 2, y: (Math.min(a.y, b.y) + tile.h / 2 + Math.min(a.y, b.y) + tile.h / 2 - 120) / 2 }
          return <ArrowLabel key={n.id} n={n} x={mid.x} y={mid.y} editing={editingNote === n.id} onEdit={(on) => setEditingNote(on ? n.id : null)}
            onText={(text, final) => patchNote(n.id, { text }, final)} onSend={() => sendNotes([n])} onDone={() => patchNote(n.id, { done: !n.done })} onDelete={() => saveNotes(notes.filter((x) => x.id !== n.id))} />
        })}
        <AnimatePresence>
          {notes.filter((n) => n.kind === 'note').map((n) => (
            <NoteCard key={n.id} n={n} editing={editingNote === n.id} onEdit={(on) => setEditingNote(on ? n.id : null)}
              onText={(text, final) => (!final ? patchNote(n.id, { text }, false) : text.trim() ? patchNote(n.id, { text }) : saveNotes(notes.filter((x) => x.id !== n.id)))}
              onSend={() => sendNotes([n])} onDone={() => patchNote(n.id, { done: !n.done })} onDelete={() => saveNotes(notes.filter((x) => x.id !== n.id))}
              onDragStart={(e) => dragNote(n, e)} />
          ))}
        </AnimatePresence>
      </motion.div>

      {/* The active video, live and editable, over its tile */}
      <AnimatePresence>
        {active && activeAt && (
          <motion.div
            key={active}
            className="canvas-live"
            style={{ left: ovX, top: ovY, width: ovW, height: ovH, scale: ovS, transformOrigin: '0 0' }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={tr(MOVE)}
          >
            {overlay}
          </motion.div>
        )}
      </AnimatePresence>

      {empty && (
        <motion.div className="board-empty board-ui" {...rise(10, SETTLE, 0.2)}>
          <LiveMark />
          <b>Nothing here yet</b>
          <span className="muted">Describe a video on the left. Each one your agent makes lands here; variants sit beside what they came from.</span>
        </motion.div>
      )}

      {/* Top right: import, references, skills, theme, settings */}
      <div className="board-ui board-tools no-drag">
        <Tip title="Share" keys="⇧⌘S" body="This project as one .panthr file, to send however you like. Opened, it becomes their project; sent back, their notes come home.">
          <button className="board-tool" onClick={() => dispatchEvent(new CustomEvent('panthr:share'))}><Icon name="export" size={15} /><span>Share</span></button>
        </Tip>
        <RecordButton canvas={canvas} onAsk={onAsk} onActivate={onActivate} />
        <Tip title="Import" body="Video folders (or a folder of them), video files and other files. Or drop them on the canvas.">
          <button className="board-tool" onClick={async () => bringIn(await api.app.chooseFiles(true))}><Icon name="import" size={15} /><span>Import</span></button>
        </Tip>
        {openNotes.length > 0 && (
          <Tip title="Send the notes" body="Every open note and arrow on the canvas, to the agent at once.">
            <button className="board-tool notes-tool" onClick={() => sendNotes(openNotes)}><Icon name="note" size={15} /><span>Send {openNotes.length} note{openNotes.length === 1 ? '' : 's'}</span></button>
          </Tip>
        )}
        <BrandCard dir={canvas} onRestyle={() => onAsk('Restyle every video in this project to the brand kit in BRAND.md: its colours, type, logo and voice exactly. Change each video in place, one after another, and check each.')} />
        <Tip title="References" body="Videos your agent has taken apart. Mention one with @.">
          <button className="board-tool" onClick={() => setRefsOpen(true)}><Icon name="film" size={15} /><span>References</span></button>
        </Tip>
        <Tip title="Skills" body="What your agents know how to do.">
          <button className="board-tool" onClick={() => dispatchEvent(new CustomEvent('panthr:settings', { detail: 'skills' }))}><Icon name="spark" size={15} /><span>Skills</span></button>
        </Tip>
        <ThemeToggle />
        <IconButton icon="settings" tip="Settings" keys="⌘," onClick={onSettings} />
      </div>

      {/* Bottom right: zoom */}
      <div className="board-ui board-zoom">
        <button onClick={() => zoomBy(1 / 1.25)} aria-label="Zoom out">−</button>
        <button ref={zoomLabel} className="mono" onClick={() => glide({ ...centre(), zoom: 1 }, 0.4)}>{Math.round(z.get() * 100)}%</button>
        <button onClick={() => zoomBy(1.25)} aria-label="Zoom in">+</button>
        <Tip title="Show everything" keys="⇧1"><button onClick={fitAll} aria-label="Show everything"><Icon name="layers" size={13} /></button></Tip>
      </div>

      {/* Several videos picked: what can be done to them together */}
      <AnimatePresence>
        {picked.length > 0 && (
          <motion.div className="board-ui pick-bar no-drag" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 10 }} transition={tr(MOVE)}>
            <span><b>{picked.length}</b> picked</span>
            <button className="btn small" disabled={picked.length < 2} onClick={() => setComparing(picked.slice(0, 6))}><Icon name="layers" size={13} /> Compare</button>
            <button className="btn small" disabled={exportRun.current} onClick={() => exportAll(picked)}><Icon name="export" size={13} /> Export</button>
            <SizesMenu onPick={(sizes, exportAfter) => {
              api.board.sizes(canvas, picked.filter((k) => !k.startsWith('ref:')), sizes, exportAfter).catch((e) => sayOnCanvas(`Couldn't make the sizes: ${(e as Error).message}`))
              setPicked([])
            }} />
            <button className="link" onClick={() => setPicked([])}>Clear</button>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {comparing && <Compare dirs={comparing} onClose={() => setComparing(null)} onPick={(dir) => { setComparing(null); setPicked([]); onActivate(dir) }} />}
      </AnimatePresence>
      <AnimatePresence>
        {note && (
          <motion.div className="board-note board-ui" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} transition={tr(MOVE)}>{note}</motion.div>
        )}
      </AnimatePresence>

      {/* Sheets go above the window, not inside the canvas (which takes pointers for panning). */}
      {createPortal(<>
      <AnimatePresence>
        {refsOpen && (
          <motion.div className="sheet-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={tr(MOVE)} onClick={() => setRefsOpen(false)}>
            <motion.div className="refs-sheet" initial={{ opacity: 0, y: 12, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 8, scale: 0.98 }} transition={tr(SETTLE)} onClick={(e) => e.stopPropagation()}>
              <div className="refs-sheet-close"><IconButton icon="close" tip="Close" keys="esc" onClick={() => setRefsOpen(false)} /></div>
              <ReferencesSection onMention={(h) => { setRefsOpen(false); onMention(h) }} onAdded={() => setRefsOpen(false)} />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      <RefSheet r={refs.find((r) => r.id === openRef) ?? null} onClose={() => setOpenRef(null)} onMention={(h) => { setOpenRef(null); onMention(h) }} />
      </>, document.body)}
      <CanvasKeys onFit={fitAll} onZoom={zoomBy} />
    </div>
  )
})

/** The view that shows every tile (or the origin, when there are none). */
function fitView(b: BoardData, stage: { w: number; h: number }, tile: { w: number; h: number }): BoardView {
  const ps = Object.values(b.tiles)
  if (!ps.length) return { x: tile.w / 2, y: tile.h / 2, zoom: 1 }
  const x0 = Math.min(...ps.map((p) => p.x))
  const y0 = Math.min(...ps.map((p) => p.y))
  const x1 = Math.max(...ps.map((p) => p.x + tile.w))
  const y1 = Math.max(...ps.map((p) => p.y + tile.h))
  const pad = 80
  const zoom = clamp(Math.min(stage.w / (x1 - x0 + pad * 2), stage.h / (y1 - y0 + pad * 2)), ZOOM.min, 1)
  return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, zoom }
}

/** Posters for videos that have none yet (new ones): a few stills made in
 *  the background, one video at a time, the way the editor's filmstrip is
 *  (not while an agent is working; asked again when a turn ends). */
const posterAsked = new Set<string>()
let posterChain: Promise<void> = Promise.resolve()
/** `version`: when the video last changed (asked again for each change). */
function askPoster(dir: string, version = 0): void {
  const key = `${dir}@${version}`
  if (posterAsked.has(key)) return
  posterAsked.add(key)
  posterChain = posterChain.then(async () => {
    // Its frames already newer than its last change: nothing to make.
    const p = await api.projects.load(dir)
    const stamp = Number(/\/\.studio\/frames\/(\d+)\//.exec(p?.thumb ?? '')?.[1] ?? 0)
    if (stamp && p && stamp > p.edited_at) return
    const html = await api.files.read(dir, 'index.html')
    const d = Number(/data-duration="([\d.]+)"/.exec(html ?? '')?.[1] ?? 0)
    if (!d) return
    await api.review.frames(dir, d, 6)
    await new Promise<void>((ok) => {
      const off = api.on('job', (j) => {
        if (j.dir === dir && j.type === 'frames') done()
      })
      const timer = setTimeout(done, 45000)
      function done(): void {
        clearTimeout(timer)
        off()
        ok()
      }
    })
  })
}
api.on('chat:turn', () => posterAsked.clear())

/** A video: its poster, or the video itself playing while it is new or
 *  being worked on. The active one shows its poster under the live picture. */
function VideoTile({ p, h, live, active, working, exporting }: { p: Project; h: number; live: boolean; active: boolean; working: boolean; exporting?: { percent: number; stage: string; failed?: string } }) {
  const [poster, setPoster] = useState<string | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [hover, setHover] = useState(false)
  const [nonce, setNonce] = useState(0)
  const frame = useRef<HTMLIFrameElement>(null)
  useEffect(() => {
    if (p.thumb) api.app.fileUrl(p.thumb).then(setPoster)
  }, [p.thumb, p.edited_at])
  // Live only while it is on screen: a tile panned away stops its preview.
  const box = useRef<HTMLDivElement>(null)
  const [seen, setSeen] = useState(true)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const io = new IntersectionObserver(([e]) => setSeen(e.isIntersecting), { root: el.closest('.board-stage'), rootMargin: '80px' })
    io.observe(el)
    return () => io.disconnect()
  }, [])
  const playing = !active && seen && (live || hover)
  // No picture yet, or the video changed since: make one (shown when it comes).
  // Frames that are already current come back at once, without a new render.
  useEffect(() => {
    if (!p.host) askPoster(p.dir, p.edited_at)
  }, [p.dir, p.host, p.edited_at])
  useEvent('job', (j) => {
    if (j.dir === p.dir && j.type === 'frames' && j.files.length) api.app.fileUrl(j.files[Math.floor(j.files.length / 3)]).then(setPoster)
  }, [p.dir])
  useEffect(() => {
    if (playing && !url) api.projects.previewUrl(p.dir).then(setUrl)
  }, [playing, url, p.dir])
  // Saved files reload it (the agent building it, seen as it goes).
  useEvent('project:changed', (e) => {
    if (e.dir === p.dir && playing) setNonce((n) => n + 1)
  }, [p.dir, playing])
  useEffect(() => {
    const f = (e: MessageEvent): void => {
      if (e.source !== frame.current?.contentWindow) return
      const m = (e.data as { __panthr?: { kind?: string } })?.__panthr
      if (m?.kind === 'ready') frame.current?.contentWindow?.postMessage({ source: 'panthr', op: 'play' }, '*')
    }
    addEventListener('message', f)
    return () => removeEventListener('message', f)
  }, [])
  return (
    <div ref={box} className="tile-body" onPointerEnter={() => setHover(true)} onPointerLeave={() => setHover(false)}>
      <div className="tile-shot" style={{ height: h - WORDS }}>
        {poster && <img src={poster} alt="" draggable={false} />}
        {!poster && !playing && <div className="tile-blank"><Icon name="film" size={20} /></div>}
        <AnimatePresence>
          {playing && url && (
            <motion.iframe
              key={nonce}
              ref={frame}
              src={url}
              className="tile-frame"
              title={p.meta.name}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={tr(MOVE)}
            />
          )}
        </AnimatePresence>
        {working && <span className="tile-working"><i /> Working</span>}
        {exporting && (
          <div className={`tile-export${exporting.failed ? ' failed' : ''}`}>
            <span>{exporting.failed ? 'Export failed' : exporting.stage === 'Done' ? 'Exported' : `${exporting.stage === 'Waiting' ? 'Waiting' : 'Exporting'} · ${Math.round(exporting.percent)}%`}</span>
            <i><motion.b animate={{ width: `${exporting.percent}%` }} transition={tr(MOVE)} /></i>
          </div>
        )}
      </div>
      <div className="tile-words">
        <b className="ellipsis">{p.meta.name}</b>
        <span className="faint">{p.host ? `On ${p.host}` : ago(p.edited_at || p.meta.created_at)}</span>
      </div>
    </div>
  )
}

function RefTile({ r, h }: { r: Reference; h: number }) {
  const [poster, setPoster] = useState<string | null>(null)
  useEffect(() => {
    if (r.poster) api.app.fileUrl(r.poster).then(setPoster)
  }, [r.poster])
  const busy = r.status !== 'ready' && r.status !== 'failed'
  return (
    <div className="tile-body ref">
      <div className="tile-shot" style={{ height: h - WORDS }}>
        {poster && <img src={poster} alt="" draggable={false} />}
        <span className="tile-badge">Reference</span>
        {busy && <span className="tile-working"><i /> Taking apart</span>}
      </div>
      <div className="tile-words">
        <b className="ellipsis">{r.name}</b>
        <span className={`faint ellipsis${r.status === 'failed' ? ' bad' : ''}`}>@{r.handle}{r.summary ? ` · ${r.summary}` : ''}</span>
      </div>
    </div>
  )
}

function LiveMark() {
  return <span className="board-empty-mark"><Mark size={40} /></span>
}


/** Other frame sizes for the picked videos: the agent lays each out again. */
/** Every size of a video: which frames, and whether to export them when the agent is done. */
export function SizesMenu({ onPick, label = 'Make sizes…', side = 'top' }: { onPick(sizes: string[], exportAfter: boolean): void; label?: string; side?: 'top' | 'bottom' }) {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [on, setOn] = useState<string[]>(['9:16', '1:1', '4:5'])
  const [exp, setExp] = useState(true)
  const SIZES: [string, string][] = [['9:16', 'Vertical (Reels, Shorts, TikTok)'], ['1:1', 'Square'], ['4:5', 'Portrait (feed)'], ['16:9', 'Wide']]
  return (
    <>
      <button ref={anchor} className="btn small" onClick={() => setOpen((o) => !o)}>{label}</button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} side={side} align="center" width={270}>
        <div className="menu sizes-menu">
          {SIZES.map(([k, label]) => (
            <MenuItem key={k} label={<>{k} <span className="faint">· {label}</span></>} on={on.includes(k)} onSelect={() => setOn((s) => (s.includes(k) ? s.filter((x) => x !== k) : [...s, k]))} />
          ))}
          <MenuSep />
          <MenuItem label="Export them when done" on={exp} onSelect={() => setExp((x) => !x)} />
          <div className="sizes-go"><button className="btn small primary" disabled={!on.length} onClick={() => { setOpen(false); onPick(on, exp) }}>Make {on.length} size{on.length === 1 ? '' : 's'}</button></div>
        </div>
      </Popover>
    </>
  )
}

/** ⇧1 shows everything, ⌘= / ⌘- zoom. */
function CanvasKeys({ onFit, onZoom }: { onFit(): void; onZoom(f: number): void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent): void => {
      const typing = (e.target as HTMLElement).closest('input, textarea, [contenteditable]')
      if (e.shiftKey && e.key === '!' && !typing) onFit()
      else if (e.metaKey && (e.key === '=' || e.key === '+')) {
        e.preventDefault()
        onZoom(1.25)
      } else if (e.metaKey && e.key === '-') {
        e.preventDefault()
        onZoom(1 / 1.25)
      }
    }
    addEventListener('keydown', k)
    return () => removeEventListener('keydown', k)
  })
  return null
}
