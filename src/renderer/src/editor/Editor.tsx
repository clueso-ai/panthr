// A project open: its conversation on the left, its canvas of videos in the
// middle, and for the active video its timeline below and the inspector on
// the right while something in it is picked. The conversation works on every
// video in the project; each message says which video is active. Every edit
// made here (a control, a dragged bar, a note) can be taken back with ⌘Z.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { ChatState, Checkpoint, Comment, Engine, Layer, LibraryItem, Picked, Project, TimingLayer, Version } from '@shared/types'
import { setRequest } from '@shared/controls'
import { api, useEvent, useReferences, useSettings } from '@/lib/api'
import { rise, tr, MOVE, QUICK, SETTLE } from '@/lib/motion'
import { clock } from '@/lib/format'
import { Icon } from '@/ui/Icon'
import { ThemeToggle } from '@/ui/ThemeToggle'
import { Composer, IconButton, ModelChip, type ComposerHandle } from '@/ui/Controls'
import { MenuItem, MenuSep, Popover } from '@/ui/Popover'
import { Tip } from '@/ui/Tooltip'
import { Chat } from './Chat'
import { Inspector, describe, whereLine, type ControlChange } from './Inspector'
import { LibraryPanel, NotesPanel, VersionsPanel } from './Panels'
import { LayerBar, Timeline, type Edit } from './Timeline'
import { PreviewFrames, usePreview } from './usePreview'
import { addVideos } from './References'
import { CanvasStage } from '../board/CanvasStage'
import './editor.css'
import '../home/home.css'

type Side = 'chat' | 'notes' | 'versions' | 'library'
type Tool = 'select' | 'draw'
type Op =
  | { kind: 'file'; rel: string; before: string; after: string; label: string }
  | { kind: 'control'; change: ControlChange }
  | { kind: 'comments'; before: Comment[]; after: Comment[]; label: string }

const CHAT_MIN = 300
const CHAT_MAX = 560
const INSP_MIN = 260
const INSP_MAX = 420

/** A project: `canvas` is its folder (the canvas and the conversation),
 *  `active` the video being edited (none: just the canvas and the chat). */
export function Editor({ canvas, active, first, onActivate, onHome, onSettings }: {
  canvas: string
  active: string | null
  /** A project started from Home: its idea goes to the conversation once. */
  first: string | null
  onActivate(dir: string | null): void
  onHome(): void
  onSettings(): void
}) {
  /** The active video's folder ('' when none). */
  const dir = active ?? ''
  const settings = useSettings()
  const [project, setProject] = useState<Project | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [side, setSide] = useState<Side>('chat')
  const [chatId, setChatId] = useState<string | null>(null)
  /** The project: its conversation, models and agents switch. */
  const [owner, setOwner] = useState<Project | null>(null)
  const [chat, setChat] = useState<ChatState | null>(null)
  const [tool, setTool] = useState<Tool>('select')
  const [picked, setPicked] = useState<Picked | null>(null)
  const [sel, setSel] = useState<number | null>(null)
  const [tween, setTween] = useState<number | null>(null)
  const [timing, setTiming] = useState<Record<string, TimingLayer>>({})
  const [comments, setComments] = useState<Comment[]>([])
  const [selComment, setSelComment] = useState<string | null>(null)
  const [range, setRange] = useState<[number, number] | null>(null)
  const [versions, setVersions] = useState<Version[]>([])
  const [exporting, setExporting] = useState<number | null>(null)
  const [stage, setStage] = useState('')
  const [frames, setFrames] = useState<string[]>([])
  const [layersOpen, setLayersOpen] = useState(true)
  const [rows, setRows] = useState(5)
  const [chatW, setChatW] = useState(380)
  const [inspW, setInspW] = useState(300)
  const [status, setStatus] = useState<{ text: string; id: number } | null>(null)
  const [hint, setHint] = useState<[string, string] | null>(null)
  const [scope, setScope] = useState(false)
  const [strokes, setStrokes] = useState<[number, number][][]>([])
  const [renaming, setRenaming] = useState(false)
  /** Save the typed name (blank or unchanged: keep the old one). */
  const commitRename = async (v: string): Promise<void> => {
    setRenaming(false)
    const n = v.trim()
    if (n && project && n !== project.meta.name) setProject(await api.projects.rename(dir, n))
  }
  const undo = useRef<Op[]>([])
  const redo = useRef<Op[]>([])
  const composer = useRef<ComposerHandle>(null)

  const say = useCallback((text: string) => setStatus({ text, id: Date.now() }), [])
  useEffect(() => {
    if (!status) return
    const id = setTimeout(() => setStatus((s) => (s?.id === status.id ? null : s)), 4000)
    return () => clearTimeout(id)
  }, [status])

  // ── The project: its conversation ──────────────────────────
  useEffect(() => {
    // A project opens on its conversation.
    setSide('chat')
    api.state.get().then((s) => {
      if (s.chat_w) setChatW(Math.min(CHAT_MAX, Math.max(CHAT_MIN, s.chat_w)))
      if (s.inspector_w) setInspW(Math.min(INSP_MAX, Math.max(INSP_MIN, s.inspector_w)))
      if (s.tl_rows) setRows(s.tl_rows)
    })
    api.projects.load(canvas).then(async (c) => {
      setOwner(c)
      // The project's newest conversation, or a first one.
      const last = c?.meta.chats[c.meta.chats.length - 1]
      setChatId(last ? last.id : await api.chats.create(canvas))
    })
    api.skills.link(canvas).catch(() => {})
  }, [canvas])
  // The project's checkpoints: every finished turn can be undone.
  const [history, setHistory] = useState<Checkpoint[]>([])
  useEffect(() => {
    api.history.list(canvas).then(setHistory)
  }, [canvas])
  useEvent('history:changed', (e) => {
    if (e.dir === canvas) api.history.list(canvas).then(setHistory)
  }, [canvas])
  const undoTurn = useCallback(async (turn: number, redo: boolean): Promise<void> => {
    if (!chatId) return
    try {
      const r = await api.history.undo(canvas, chatId, turn, redo)
      const n = r.restored.length
      setStatus({ text: `${redo ? 'Redid' : 'Undid'} the turn: ${n} file${n === 1 ? '' : 's'}${r.skipped.length ? `; kept ${r.skipped.length} you changed since` : ''}`, id: Date.now() })
    } catch (e) {
      setStatus({ text: `Couldn't ${redo ? 'redo' : 'undo'} it: ${(e as Error).message}`, id: Date.now() })
    }
  }, [canvas, chatId])

  // A project started from Home: its idea goes to the conversation once.
  const sentFirst = useRef(false)
  useEffect(() => {
    if (first && chat && chatId && !sentFirst.current && chat.items.length === 0) {
      sentFirst.current = true
      api.chats.send(canvas, chatId, first)
    }
  }, [first, chat, chatId, canvas])

  // ── The active video ───────────────────────────────────────
  useEffect(() => {
    api.state.set({ canvas, project: dir || null, home: false })
    setPicked(null)
    setSel(null)
    setTween(null)
    setScope(false)
    setRange(null)
    setFrames([])
    undo.current = []
    redo.current = []
    if (!dir) {
      setProject(null)
      setUrl(null)
      setComments([])
      setVersions([])
      if (side === 'notes' || side === 'versions') setSide('chat')
      return
    }
    let alive = true
    api.projects.load(dir).then(async (p) => {
      if (!alive || !p) return
      setProject(p)
      setUrl(await api.projects.previewUrl(dir))
      api.projects.watch(dir)
      api.skills.link(dir).catch(() => {})
    })
    api.review.comments(dir).then(setComments)
    api.review.versions(dir).then(setVersions)
    return () => {
      alive = false
      api.projects.unwatch(dir)
    }
  }, [dir]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!chatId) return
    api.chats.open(canvas, chatId).then(setChat)
  }, [canvas, chatId])
  useEvent('chat:state', (c) => {
    if (c.dir !== canvas) return
    if (c.chatId === chatId) setChat(c)
    // Another of the project's conversations started working (from the command line): show it.
    else if (c.working && !chat?.working) {
      setChatId(c.chatId)
      api.projects.load(canvas).then(setOwner)
    }
  }, [canvas, chatId, chat?.working])
  useEvent('project:renamed', (e) => {
    if (e.dir === canvas) setOwner((o) => (o ? { ...o, meta: { ...o.meta, name: e.name } } : o))
  }, [canvas])
  useEvent('project:renamed', (e) => {
    if (e.dir === dir) setProject((p) => (p ? { ...p, meta: { ...p.meta, name: e.name } } : p))
  }, [dir])
  useEvent('chat:titled', (e) => {
    if (e.dir === canvas) api.projects.load(canvas).then((p) => p && setOwner(p))
  }, [canvas])

  // ── The picture ────────────────────────────────────────────
  const preview = usePreview(url, {
    onPicked: (p) => {
      if (tool !== 'select') return
      setPicked(p)
      const lid = p.layer || p.id
      const ix = layersRef.current.findIndex((l) => !!lid && (l.id === lid || l.sel === lid))
      if (ix >= 0) {
        if (ix !== selRef.current) setTween(null)
        setSel(ix)
      }
    },
    onPen: setStrokes,
    onReady: () => {
      // A new page (or one just swapped in): pick mode and the outline again.
      preview.post({ type: 'pick', on: toolRef.current === 'select' })
      const ref = pickedRef.current?.layer || pickedRef.current?.id
      if (ref) preview.post({ type: 'highlight', id: ref })
    }
  })
  const toolRef = useRef(tool)
  toolRef.current = tool
  const pickedRef = useRef(picked)
  pickedRef.current = picked
  const layers = preview.state.layers
  const layersRef = useRef<Layer[]>([])
  // The chosen layer by what it is, not its row: rows re-sort when timing
  // changes (a bar moved), and the choice must follow its layer.
  const keyOf = (l: Layer): string => l.id || l.sel || `~${l.label}`
  const selKey = useRef<string | null>(null)
  if (layersRef.current !== layers) {
    layersRef.current = layers
    if (selKey.current !== null) {
      const ix = layers.findIndex((l) => keyOf(l) === selKey.current)
      if (ix !== sel) queueMicrotask(() => setSel(ix >= 0 ? ix : null))
    }
  }
  const selRef = useRef<number | null>(null)
  selRef.current = sel
  useEffect(() => {
    if (sel === null) selKey.current = null
    else if (layers[sel]) selKey.current = keyOf(layers[sel])
  }, [sel]) // eslint-disable-line react-hooks/exhaustive-deps
  const duration = preview.state.duration

  // Select mode (and the outline of what is picked) belong to the page
  // shown: set again whenever the tool or the shown page changes, so a
  // page swapped in after a reload answers clicks too.
  useEffect(() => {
    const again = (): void => {
      preview.post({ type: 'pick', on: tool === 'select' })
      const ref = pickedRef.current?.layer || pickedRef.current?.id
      if (ref) preview.post({ type: 'highlight', id: ref })
    }
    again()
    // A page still starting may not be listening yet: once more shortly.
    const id = window.setTimeout(again, 600)
    return () => window.clearTimeout(id)
  }, [tool, preview.front, url]) // eslint-disable-line react-hooks/exhaustive-deps

  const refreshTiming = useCallback(() => {
    if (!dir) return
    api.controls.timing(dir).then(setTiming).catch((e) => say(`Couldn't read the timeline's timing: ${String(e.message ?? e).split('\n')[0]}`))
  }, [dir, say])
  const layersKey = layers.map((l) => l.id + l.sel).join('|')
  useEffect(() => {
    if (layers.length) refreshTiming()
  }, [layersKey, refreshTiming]) // eslint-disable-line react-hooks/exhaustive-deps

  // Our own write (a control, a dragged bar): the picture reloads at once,
  // and the watcher's report of it shortly after is not reloaded again.
  const ownReload = useRef(0)
  const reloadNow = (): void => {
    ownReload.current = Date.now()
    preview.reload()
    askFrames.current(1500)
  }
  // Files changed (the agent, an edit): the picture reloads at the same moment.
  const reloadTimer = useRef<number | undefined>(undefined)
  useEvent('project:changed', (e) => {
    if (e.dir !== dir) return
    window.clearTimeout(reloadTimer.current)
    reloadTimer.current = window.setTimeout(() => {
      if (Date.now() - ownReload.current > 1500) preview.reload()
      refreshTiming()
      askFrames.current(1500)
      api.review.comments(dir).then(setComments)
    }, 300)
  }, [dir, preview.reload, refreshTiming])
  useEvent('chat:turn', (e) => {
    if (e.dir !== canvas || !dir) return
    // Frames wait while an agent works; once its turn ends, the new picture.
    askFrames.current(800)
    api.review.comments(dir).then(setComments)
    api.controls.timing(dir).then(setTiming).catch(() => {})
  }, [dir])

  // The filmstrip under the timeline: made when the video opens, and made
  // again a moment after anything changes it (a control, a dragged bar, an
  // undo, the agent), so it shows the video as it is now. A run of edits
  // (a slider dragged) asks once, after the last.
  // A ref, so handlers made on an earlier render (before the length was
  // known) still ask with the video as it is now.
  const framesTimer = useRef<number | undefined>(undefined)
  const askFrames = useRef((_wait = 0): void => {})
  askFrames.current = (wait = 0): void => {
    window.clearTimeout(framesTimer.current)
    framesTimer.current = window.setTimeout(() => {
      if (!dir || !settings.filmstrip || duration <= 0) return
      api.review.frames(dir, duration, 12).then(async (f) => setFrames(await Promise.all(f.map((x) => api.app.fileUrl(x)))))
    }, wait)
  }
  useEffect(() => askFrames.current(0), [dir, duration, settings.filmstrip])
  useEffect(() => () => window.clearTimeout(framesTimer.current), [])
  useEvent('job', async (j) => {
    if (j.dir !== dir) return
    switch (j.type) {
      case 'frames': setFrames(await Promise.all(j.files.map((x) => api.app.fileUrl(x)))); break
      case 'progress': setExporting(j.percent); break
      case 'stage': setStage(j.text); setExporting((e) => e ?? 0); break
      case 'rendered':
        setExporting(null)
        setVersions(await api.review.versions(dir))
        // Said, not shown: the export does not take you away from what you are doing.
        say(`Exported v${j.version.n} · in Versions`)
        break
      case 'posters': setVersions(await api.review.versions(dir)); break
      case 'failed':
        setExporting(null)
        if (j.error !== 'Cancelled') say(`Export failed: ${j.error}`)
        break
    }
  }, [dir])

  // ── Panels ─────────────────────────────────────────────────
  const showSide = (s: Side): void => {
    setSide(s)
    api.state.set({ side: s })
  }

  // ── Selection ──────────────────────────────────────────────
  const deselect = (): void => {
    setPicked(null)
    setSel(null)
    setTween(null)
    setScope(false)
    preview.post({ type: 'highlight', id: null })
  }

  /** Choose a layer on the timeline: its element opens in the inspector. */
  const selectLayer = (ix: number, tw: number | null): void => {
    if (ix !== sel) setTween(null)
    setSel(ix)
    if (tw !== null) setTween(tw)
    const l = layers[ix]
    if (!l) return
    if (tool !== 'select') setTool('select')
    const ref = l.id || l.sel
    // A script's state object has no element: it opens with its timing.
    setPicked(ref
      ? { id: ref, layer: l.id || null, hasId: !!l.id, file: 'index.html', tag: 'div', text: l.label, path: [] }
      : { id: '', layer: null, hasId: false, file: 'index.html', tag: 'script', text: l.label, path: [] })
    preview.post({ type: 'highlight', id: ref || null })
    if (ref) preview.post({ type: 'describe', ref, layer: l.id || null })
    if (!Object.keys(timing).length) refreshTiming()
  }

  // ── Undo ───────────────────────────────────────────────────
  const push = (op: Op): void => {
    undo.current.push(op)
    if (undo.current.length > 100) undo.current.shift()
    redo.current = []
  }
  const label = (op: Op): string => (op.kind === 'control' ? op.change.label : op.label)
  const replay = async (op: Op, forward: boolean): Promise<boolean> => {
    if (op.kind === 'file') {
      const [now, put] = forward ? [op.before, op.after] : [op.after, op.before]
      return api.files.replace(dir, op.rel, now, put)
    }
    if (op.kind === 'comments') {
      const c = forward ? op.after : op.before
      await api.review.saveComments(dir, c)
      setComments(c)
      return true
    }
    const all = await api.controls.all(dir)
    const set = all[op.change.key]
    const c = set?.controls[op.change.index]
    if (!set || !c) return false
    const v = forward ? op.change.to : op.change.from
    await api.controls.run(dir, setRequest(set, c, v))
    c.value = v
    await api.controls.save(dir, all)
    return true
  }
  const doUndo = async (): Promise<void> => {
    const op = undo.current.pop()
    if (!op) return
    if (await replay(op, false)) {
      redo.current.push(op)
      say(`Undid ${label(op)}`)
    } else say(`Couldn't undo ${label(op)}: it changed since`)
  }
  const doRedo = async (): Promise<void> => {
    const op = redo.current.pop()
    if (!op) return
    if (await replay(op, true)) {
      undo.current.push(op)
      say(`Redid ${label(op)}`)
    } else say(`Couldn't redo ${label(op)}`)
  }

  // ── Timeline edits through the editor tool ─────────────────
  const windowOf = (ix: number | null): TimingLayer | null => {
    const l = ix != null ? layers[ix] : null
    const w = l?.id ? timing[l.id] : undefined
    return w && w.movable && w.start != null && w.end != null ? w : null
  }
  const runEdit = async (req: Record<string, unknown>, what: string): Promise<void> => {
    try {
      const v = await api.controls.run(dir, req)
      if (v?.before != null && v?.file) {
        const after = await api.files.read(dir, v.file)
        if (after != null) push({ kind: 'file', rel: v.file, before: v.before, after, label: what })
      }
      say(`Changed ${what}`)
      reloadNow()
      refreshTiming()
    } catch (e) {
      say(`Couldn't change ${what}: ${String((e as Error).message ?? e).split('\n')[0]}`)
    }
  }
  const commitEdit = (e: Edit): void => {
    const l = layers[e.ix]
    const w = windowOf(e.ix)
    if (!l || !w) return
    if (e.kind === 'window') {
      const [a0, l0] = [w.start!, w.end! - w.start!]
      if (Math.abs(e.at - a0) < 1e-3 && Math.abs(e.len - l0) < 1e-3) return
      const req = Math.abs(e.len - l0) < 1e-3
        ? { op: 'move', file: w.file, layer: l.id, delta: Math.round((e.at - a0) * 1000) / 1000 }
        : { op: 'resize', file: w.file, layer: l.id, start: e.at, end: e.at + e.len }
      runEdit(req, `the timing of ${l.label}`)
    } else {
      const t = w.tweens[e.tw]
      if (!t || (Math.abs(e.start - t.start) < 1e-3 && Math.abs(e.dur - t.duration) < 1e-3)) return
      runEdit({ op: 'tween', file: w.file, animation: t.id, updates: { position: e.start, duration: e.dur } }, `a step of ${l.label}`)
    }
  }
  const nudge = (dStart: number, dLen: number): void => {
    if (sel == null) return
    const w = windowOf(sel)
    if (!w) return
    const t = tween != null ? w.tweens[tween] : null
    if (t) commitEdit({ kind: 'tween', ix: sel, tw: tween!, start: Math.max(0, t.start + dStart), dur: Math.max(0.05, t.duration + dLen) })
    else {
      const len = Math.max(0.1, w.end! - w.start! + dLen)
      commitEdit({ kind: 'window', ix: sel, at: Math.min(Math.max(0, w.start! + dStart), Math.max(0, duration - len)), len })
    }
  }
  const setEase = (ease: string): void => {
    const w = windowOf(sel)
    const t = w && tween != null ? w.tweens[tween] : null
    if (!w || !t) return
    runEdit({ op: 'tween', file: w.file, animation: t.id, updates: { ease } }, `the easing of ${layers[sel!].label}`)
  }

  // ── Talking to the agent ───────────────────────────────────
  const send = (text: string): void => {
    if (!chatId) return
    let msg = text
    if (scope && picked) msg = `${text}\n\n(About the element I clicked: ${describe(picked)} — ${whereLine(picked, preview.now())}.)`
    api.chats.send(canvas, chatId, withVideo(msg))
    showSide('chat')
  }
  const ask = (text: string): void => {
    if (!chatId) return
    api.chats.send(canvas, chatId, withVideo(text))
    showSide('chat')
  }
  const askAdjustable = (): void => {
    const l = sel != null ? layers[sel] : null
    if (!l) return
    const target = l.id ? `"${l.label}" (#${l.id})` : `"${l.label}"`
    ask(`Make ${target} adjustable on the timeline: follow the Timing section (data-start / data-duration on the layer, tweens placed relative to them), without changing how it looks.`)
  }
  const newChat = async (): Promise<void> => {
    const id = await api.chats.create(canvas, chat?.engine)
    setOwner(await api.projects.load(canvas))
    setChatId(id)
    showSide('chat')
    composer.current?.focus()
  }

  /** A message to the project's conversation from the canvas (other sizes, notes). */
  const askProject = useCallback((text: string): void => {
    if (chatId) api.chats.send(canvas, chatId, text)
  }, [canvas, chatId])
  const refs = useReferences()
  /** Put a reference's @handle into the message being written. */
  const mention = useCallback((handle: string): void => {
    const v = composer.current?.value() ?? ''
    composer.current?.set(`${v}${v && !v.endsWith(' ') ? ' ' : ''}@${handle} `)
    setSide('chat')
    api.state.set({ side: 'chat' })
  }, [])
  // A video dropped on the window: it shows in the Library while it is taken apart.
  useEffect(() => {
    const f = (): void => showSide('library')
    addEventListener('panthr:reference-added', f)
    return () => removeEventListener('panthr:reference-added', f)
  })

  const engine: Engine = chat?.engine ?? settings.agent
  const model = owner?.meta.models[engine] ?? (engine === 'codex' ? settings.codex_model : settings.model)
  const pickModel = async (e: Engine, m: string): Promise<void> => {
    if (!owner) return
    if (chatId && e !== engine) await api.chats.setEngine(canvas, chatId, e)
    const meta = { ...owner.meta, models: { ...owner.meta.models, [e]: m } }
    await api.projects.saveMeta(canvas, meta)
    setOwner({ ...owner, meta })
  }
  const setAgents = async (on: boolean): Promise<void> => {
    if (!owner) return
    const meta = { ...owner.meta, agents_enabled: on }
    await api.projects.saveMeta(canvas, meta)
    setOwner({ ...owner, meta })
  }
  /** The project's conversation hears which video is active. */
  const withVideo = (text: string): string => {
    if (!dir) return text
    const where = dir === canvas ? 'the project folder itself' : `folder "${dir.startsWith(`${canvas}/`) ? dir.slice(canvas.length + 1) : dir}"`
    const name = project?.meta.name ?? ''
    // The decision that matters most, put where the agent makes it: a new
    // video is its own tile, not more of this one. (The chat shows this line
    // as a chip, not as part of the message.)
    return `${text}\n\n(Active video: "${name}", in ${where}. If this asks for a new video, a variant, another style or a cut-down, make it its own tile first: \`panthr board new "<name>" --from "${name}"\`, then build it in the folder that prints. Never add another film to this video's timeline unless asked to combine them.)`
  }

  // ── Notes ──────────────────────────────────────────────────
  const saveComments = (next: Comment[], what: string): void => {
    push({ kind: 'comments', before: comments, after: next, label: what })
    setComments(next)
    api.review.saveComments(dir, next)
  }
  const addNote = (body: string): void => {
    const [a, b] = range ? [Math.min(...range), Math.max(...range)] : [preview.now(), undefined]
    const c: Comment = { id: Math.random().toString(16).slice(2, 10), time: Math.round(a * 100) / 100, ...(b != null ? { end: Math.round(b * 100) / 100 } : {}), body: body.trim(), resolved: false, created_at: Math.floor(Date.now() / 1000) }
    saveComments([...comments, c].sort((x, y) => x.time - y.time), 'the note')
    setRange(null)
    setSelComment(c.id)
  }

  // ── Drawing on the frame ───────────────────────────────────
  const toggleDraw = (): void => {
    const on = tool !== 'draw'
    setTool(on ? 'draw' : 'select')
    preview.pen(on)
    if (on) {
      preview.pause()
      deselect()
    } else setStrokes([])
  }
  const sendDrawing = async (): Promise<void> => {
    const t = preview.now()
    say('Sending the drawing…')
    try {
      const file = await api.review.annotate(dir, t, strokes)
      const rel = file.startsWith(dir) ? file.slice(dir.length + 1) : file
      const note = composer.current?.value().trim() ?? ''
      composer.current?.set('')
      ask(`I drew on the frame at ${clock(t)} — look at ${rel} (my marks are the orange strokes).${note ? ` ${note}` : ''}`)
      setTool('select')
      preview.pen(false)
      setStrokes([])
    } catch (e) {
      say(`Couldn't send the drawing: ${(e as Error).message}`)
    }
  }

  // ── Export ─────────────────────────────────────────────────
  const exportNow = (): void => {
    if (!dir || exporting !== null) return
    setExporting(0)
    setStage('Starting')
    api.review.render(dir)
  }

  // ── Keys and menu commands ─────────────────────────────────
  const typing = (): boolean => {
    const a = document.activeElement
    return !!a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT' || (a as HTMLElement).isContentEditable)
  }
  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        if (tool === 'draw') toggleDraw()
        else if (range) setRange(null)
        else if (picked) deselect()
        else if (dir && !typing()) onActivate(null)
        return
      }
      if (typing() || !dir) return
      if (e.key === ' ') {
        e.preventDefault()
        preview.state.playing ? preview.pause() : preview.play()
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        const d = (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 1 : 1 / 30)
        preview.seek(Math.min(duration, Math.max(0, preview.now() + d)))
      } else if (e.key === 'v' || e.key === 'V') setTool('select')
    }
    addEventListener('keydown', key)
    return () => removeEventListener('keydown', key)
  })
  useEvent('command', ({ name }) => {
    switch (name) {
      case 'export': exportNow(); break
      case 'rename': setRenaming(true); break
      case 'undo': if (!typing()) doUndo(); else document.execCommand('undo'); break
      case 'redo': if (!typing()) doRedo(); else document.execCommand('redo'); break
      case 'side-chat': showSide('chat'); break
      case 'side-notes': showSide('notes'); break
      case 'side-versions': showSide('versions'); break
      case 'side-library': showSide('library'); break
      case 'toggle-layers': setLayersOpen((o) => !o); break
      case 'draw': toggleDraw(); break
      case 'note': showSide('notes'); break
      case 'new-chat': newChat(); break
    }
  })

  // ── Resizing panels ────────────────────────────────────────
  const resize = (which: 'chat' | 'insp' | 'rows', e: React.PointerEvent): void => {
    e.preventDefault()
    const x0 = e.clientX
    const y0 = e.clientY
    const w0 = which === 'chat' ? chatW : which === 'insp' ? inspW : rows
    const move = (m: PointerEvent): void => {
      if (which === 'chat') setChatW(Math.min(CHAT_MAX, Math.max(CHAT_MIN, w0 + m.clientX - x0)))
      else if (which === 'insp') setInspW(Math.min(INSP_MAX, Math.max(INSP_MIN, w0 - (m.clientX - x0))))
      else setRows(Math.min(24, Math.max(1, Math.round(w0 - (m.clientY - y0) / 30))))
    }
    const up = (): void => {
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
      document.body.style.cursor = ''
      setChatW((w) => (api.state.set({ chat_w: w }), w))
      setInspW((w) => (api.state.set({ inspector_w: w }), w))
      setRows((r) => (api.state.set({ tl_rows: r }), r))
    }
    document.body.style.cursor = which === 'rows' ? 'ns-resize' : 'ew-resize'
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
  }

  const showInspector = !!dir && !!picked && tool === 'select'
  // The active video's frames, rebuilt only when what they show changes (not on each playback tick).
  const liveVideo = useMemo(() => (
    <div className="video-card">
      {url && <PreviewFrames preview={preview} />}
      {!preview.state.ready && url && <div className="video-wait"><span className="shine" data-text="Loading the video">Loading the video</span></div>}
    </div>
  ), [url, preview.srcs[0], preview.srcs[1], preview.front, preview.state.ready]) // eslint-disable-line react-hooks/exhaustive-deps
  const layer = sel != null ? layers[sel] ?? null : null
  const size = preview.state.size
  const aspect = size ? size[0] / size[1] : 16 / 9
  const openNotes = comments.filter((c) => !c.resolved).length
  const chats = owner?.meta.chats ?? []

  return (
    <div className="editor" style={{ gridTemplateColumns: `${chatW}px 1px minmax(0, 1fr) auto` }}>
      {/* ── Left: the conversation ─────────────────────────── */}
      <aside className="left">
        <div className="titlebar drag">
          <div className="no-drag titlebar-btns">
            <IconButton icon="back" tip="All projects" keys="⇧⌘H" onClick={onHome} />
          </div>
          <ProjectName dir={canvas} name={owner?.meta.name ?? ''} />
          {owner?.host && <span className="host-badge"><Icon name="cloud" size={12} /> {owner.host}</span>}
          <span className="spacer" />
          <div className="no-drag titlebar-btns">
            <ThemeToggle />
            <IconButton icon="new-chat" tip="New chat" keys="⌘T" onClick={newChat} />
          </div>
        </div>
        <div className="tabs">
          {(['chat', 'notes', 'versions', 'library'] as Side[]).map((s) => (
            <button key={s} className={side === s ? 'on' : ''} disabled={!dir && (s === 'notes' || s === 'versions')} title={!dir && (s === 'notes' || s === 'versions') ? 'Choose a video on the canvas' : undefined} onClick={() => showSide(s)}>
              {s === 'chat' ? 'Chat' : s === 'notes' ? 'Notes' : s === 'versions' ? 'Versions' : 'Library'}
              {s === 'notes' && openNotes > 0 && <span className="tab-count">{openNotes}</span>}
              {side === s && <motion.i layoutId="tab-line" className="tab-line" transition={tr(MOVE)} />}
            </button>
          ))}
        </div>
        <div className="left-body">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={side} className="left-pane" initial={{ opacity: 0, x: 6 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -6 }} transition={tr(QUICK)}>
              {side === 'chat' && (
                <>
                  {chats.length > 1 && <ChatPills chats={chats} active={chatId} onPick={setChatId} />}
                  {chat && chat.items.length > 0 ? <Chat chat={chat} history={history} onUndo={undoTurn} /> : <ProjectIntro />}
                </>
              )}
              {side === 'notes' && (
                <NotesPanel comments={comments} time={preview.state.time} range={range} selected={selComment}
                  onAdd={addNote}
                  onSelect={(c) => {
                    setSelComment(c.id)
                    preview.seek(c.time)
                  }}
                  onResolve={(c, r) => saveComments(comments.map((x) => (x.id === c.id ? { ...x, resolved: r } : x)), r ? 'resolving the note' : 'reopening the note')}
                  onDelete={(c) => saveComments(comments.filter((x) => x.id !== c.id), 'deleting the note')}
                  onFixAll={() => ask(`Address the ${openNotes} open review comment${openNotes === 1 ? '' : 's'} in .studio/comments.json. For each: make the change at that moment of the video, then set "resolved": true and add a short "reply" saying what you did.`)}
                  onClearRange={() => setRange(null)} />
              )}
              {side === 'versions' && (
                <VersionsPanel dir={dir} versions={versions} exporting={exporting} stage={stage} onExport={exportNow} onCancel={() => api.review.cancelRender(dir)} />
              )}
              {side === 'library' && <LibraryPanel
                onUse={(it: LibraryItem) => {
                  composer.current?.set(`${composer.current.value()}${composer.current.value() ? ' ' : ''}Use ${it.path} `)
                  showSide('chat')
                }}
                onMention={mention}
              />}
            </motion.div>
          </AnimatePresence>
        </div>
        {/* The composer: always here, whatever panel is open */}
        <div className="composer-card">
          <AnimatePresence>
            {scope && picked && (
              <motion.div className="scope-row" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={tr(QUICK)}>
                <span className="scope">@ {layer?.label || describe(picked)}</span>
                <button className="link" onClick={() => setScope(false)}>×</button>
              </motion.div>
            )}
          </AnimatePresence>
          {tool === 'draw' && (
            <div className="scope-row"><span className="scope draw"><Icon name="pen" size={12} /> Drawing on {clock(preview.state.time)} · {strokes.length} stroke{strokes.length === 1 ? '' : 's'}</span></div>
          )}
          <Composer ref={composer} mentions={refs} placeholder={tool === 'draw' ? 'Say what to change where you drew…' : scope && picked ? 'Ask for a change to it…' : dir ? `Ask for a change to ${project?.meta.name ?? 'this video'}, or anything in the project…` : 'Describe a video, or ask for variants…'}
            onSubmit={(t) => (tool === 'draw' && strokes.length ? (composer.current?.set(t), sendDrawing()) : send(t))} maxRows={10} />
          <div className="composer-row">
            <PlusMenu video={!!dir} onDraw={toggleDraw} onNote={() => showSide('notes')} onLibrary={() => showSide('library')} onReference={async () => {
              if (await addVideos(await api.app.chooseFiles())) showSide('library')
            }} />
            <span className="spacer" />
            <ModelChip engine={engine} model={model} locked={!!chat?.items.length} onPick={pickModel} agents={owner?.meta.agents_enabled} onAgents={setAgents} account={chat?.account} onAccount={(id) => chatId && api.chats.setAccount(canvas, chatId, id).then(() => api.chats.open(canvas, chatId).then(setChat)).catch((e) => setStatus({ text: (e as Error).message, id: Date.now() }))} />
            {chat?.working ? (
              <Tip title="Stop" body="Ends this turn. The chat keeps everything so far.">
                <button className="send stop" onClick={() => chatId && api.chats.stop(canvas, chatId)}><Icon name="stop" size={12} /></button>
              </Tip>
            ) : tool === 'draw' ? (
              <Tip title="Send the drawing" body="A frame with your marks goes to the agent.">
                <button className="send" disabled={!strokes.length} onClick={sendDrawing}><Icon name="up" size={16} /></button>
              </Tip>
            ) : (
              <Tip title="Send" keys="⏎">
                <button className="send" onClick={() => {
                  const v = composer.current?.value().trim()
                  if (v) {
                    composer.current?.set('')
                    send(v)
                  }
                }}><Icon name="up" size={16} /></button>
              </Tip>
            )}
          </div>
        </div>
      </aside>
      <div className="handle" onPointerDown={(e) => resize('chat', e)} onDoubleClick={() => setChatW(380)} />

      {/* ── Centre: the picture and its timeline ───────────── */}
      <main className="centre">
        <div className="stagebar drag">
          {dir ? (<>
          {renaming ? (
            <input className="rename no-drag video-rename" autoFocus defaultValue={project?.meta.name} onFocus={(e) => e.currentTarget.select()} onBlur={(e) => commitRename(e.currentTarget.value)} onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename(e.currentTarget.value)
              else if (e.key === 'Escape') setRenaming(false)
            }} />
          ) : (
            <Tip title="Rename" body="Click to rename this video.">
              <button className="pname no-drag video-name" onClick={() => setRenaming(true)}>
                <span className="ellipsis">{project?.meta.name ?? ''}</span>
                <Icon name="pen" size={12} className="pname-pen" />
              </button>
            </Tip>
          )}
          <div className="tools no-drag">
            <ToolButton icon="cursor" on={tool === 'select'} onHint={setHint} hint={['Select: click anything in the video to adjust it', 'V']} onClick={() => {
              if (tool === 'draw') toggleDraw()
              setTool('select')
            }} />
            <ToolButton icon="pen" on={tool === 'draw'} onHint={setHint} hint={['Draw on the frame and say what to change there', '⇧⌘D']} onClick={toggleDraw} />
            <ToolButton icon="pin" on={false} onHint={setHint} hint={['A note pinned to this moment', '⇧⌘K']} onClick={() => showSide('notes')} />
          </div>
          {tool === 'draw' && (
            <div className="no-drag draw-tools">
              <button className="btn small ghost" onClick={preview.penUndo} disabled={!strokes.length}>Undo stroke</button>
              <button className="btn small ghost" onClick={preview.penClear} disabled={!strokes.length}>Clear</button>
            </div>
          )}
          <div className="stage-hint">
            <AnimatePresence mode="wait">
              {hint && (
                <motion.span key={hint[0]} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={tr(QUICK)} className="faint">
                  {hint[0]} {hint[1] && <kbd>{hint[1]}</kbd>}
                </motion.span>
              )}
            </AnimatePresence>
          </div>
          {size && <span className="fit mono faint">Fit · {size[0]}×{size[1]}</span>}
          <div className="no-drag stagebar-right">
            <BranchButton at={preview.state.time} onBranch={async (note) => {
              if (!dir || !project) return
              const t = preview.now()
              try {
                const b = await api.board.branch(canvas, dir, `${project.meta.name} · from ${clock(t)}`)
                const rel = b.dir.startsWith(`${canvas}/`) ? b.dir.slice(canvas.length + 1) : b.dir
                askProject(`"${b.meta.name}" (folder ${rel}) is a copy of "${project.meta.name}" I just branched. In that folder only: keep everything up to ${t.toFixed(2)} s exactly as it is, and redo what comes after${note.trim() ? `: ${note.trim()}` : ', trying a clearly different direction'}. Leave "${project.meta.name}" as it is.`)
              } catch (e) {
                say(`Couldn't branch it: ${(e as Error).message}`)
              }
            }} />
            <Tip title="Versions" body="Every export, to play or compare.">
              <button className="btn" onClick={() => showSide('versions')}><Icon name="history" size={15} /><span className="btn-label">{versions.length ? `v${versions.length}` : 'Versions'}</span></button>
            </Tip>
            <Tip title="Export" keys="⌘E" body="Render the video to MP4; each export is kept in Versions.">
              <button className={`btn primary export${exporting !== null ? ' busy' : ''}`} onClick={exportNow}>
                {exporting !== null ? (
                  <>
                    <motion.i className="export-fill" animate={{ width: `${exporting}%` }} transition={tr(MOVE)} />
                    <span className="export-pct">{Math.round(exporting)}%</span>
                  </>
                ) : 'Export'}
              </button>
            </Tip>
          </div>
          </>) : (
            <span className="stage-hint faint">Choose a video on the canvas to edit it, or ask for one on the left.</span>
          )}
        </div>
        <div className="stage canvas-mode">
          <CanvasStage
            canvas={canvas}
            active={active}
            onActivate={onActivate}
            chatWorking={!!chat?.working}
            onSettings={onSettings}
            onMention={mention}
            onAsk={askProject}
            overlay={liveVideo}
          />
          <AnimatePresence>
            {preview.state.error && (
              <motion.div className="stage-error" {...rise(6, MOVE)}>
                <b>The page has an error.</b> {preview.state.error}
                <button className="link" onClick={() => ask(`The preview shows a script error: ${preview.state.error}. Fix it.`)}>Ask to fix it</button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        {dir && <div className="tl-panel">
          <AnimatePresence initial={false}>
            {layersOpen && <motion.div className="drawer-handle" onPointerDown={(e) => resize('rows', e)} onDoubleClick={() => setRows(5)} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={tr(QUICK)}><i /></motion.div>}
          </AnimatePresence>
          <Timeline
            duration={duration}
            time={preview.state.time}
            playing={preview.state.playing}
            now={preview.now}
            scenes={preview.state.scenes}
            layers={layers}
            timing={timing}
            comments={comments}
            frames={settings.filmstrip ? frames : []}
            selected={sel}
            tween={tween}
            pickedId={picked?.layer || picked?.id || null}
            selectedComment={selComment}
            layersOpen={layersOpen}
            rows={rows}
            skimming={settings.skimming}
            onPlay={() => (preview.state.playing ? preview.pause() : preview.play())}
            onSeek={(t) => {
              preview.skim(null)
              preview.seek(t)
            }}
            onSkim={(t) => preview.skim(t)}
            onSelect={selectLayer}
            onEdit={commitEdit}
            onRange={(a, b) => {
              setRange([a, b])
              showSide('notes')
            }}
            onComment={(id) => {
              setSelComment(id)
              showSide('notes')
              const c = comments.find((x) => x.id === id)
              if (c) preview.seek(c.time)
            }}
            onToggleLayers={() => setLayersOpen((o) => !o)}
            onRows={setRows}
            footer={<LayerBar layer={layer} win={windowOf(sel)} tween={tween} onNudge={nudge} onEase={setEase} onAdjustable={askAdjustable} />}
          />
        </div>}
      </main>

      {/* ── Right: the inspector, while something is picked ── */}
      <motion.aside className="right" initial={false} animate={{ width: showInspector ? inspW + 1 : 0, opacity: showInspector ? 1 : 0 }} transition={tr(SETTLE)}>
        {showInspector && <div className="handle insp-handle" onPointerDown={(e) => resize('insp', e)} onDoubleClick={() => setInspW(300)} />}
        <div style={{ width: inspW }} className="right-inner">
          {picked && (
            <Inspector
              dir={dir}
              engine={engine}
              picked={picked}
              at={preview.state.time}
              layer={layer}
              layerIx={sel}
              win={windowOf(sel)}
              tween={tween}
              onClose={deselect}
              onAskAbout={() => {
                setScope(true)
                showSide('chat')
                composer.current?.focus()
              }}
              onAsk={ask}
              onPreview={(m) => preview.post(m)}
              onWritten={reloadNow}
              onChanged={(change) => {
                push({ kind: 'control', change })
                say(`Changed ${change.label}`)
              }}
              onSelectTween={(k) => setTween(k)}
              onNudge={nudge}
              onAdjustable={askAdjustable}
              onSeek={(t) => preview.seek(t)}
            />
          )}
        </div>
      </motion.aside>

      {/* A line about what just happened */}
      <AnimatePresence>
        {status && (
          <motion.div key={status.id} className="toast" initial={{ opacity: 0, y: 8, x: '-50%' }} animate={{ opacity: 1, y: 0, x: '-50%' }} exit={{ opacity: 0, y: 4, x: '-50%' }} transition={tr(MOVE)}>
            {status.text}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}


function ToolButton({ icon, on, hint, onHint, onClick }: { icon: 'cursor' | 'pen' | 'pin'; on: boolean; hint: [string, string]; onHint(h: [string, string] | null): void; onClick(): void }) {
  return (
    <button className={`icon-btn tool${on ? ' on' : ''}`} onMouseEnter={() => onHint(hint)} onMouseLeave={() => onHint(null)} onClick={onClick}>
      <Icon name={icon} size={16} />
    </button>
  )
}

/** The project's name in the title row: click to rename. */
function ProjectName({ dir, name }: { dir: string; name: string }) {
  const [editing, setEditing] = useState(false)
  const save = async (v: string): Promise<void> => {
    setEditing(false)
    const n = v.trim()
    if (n && n !== name) await api.projects.rename(dir, n)
  }
  return editing ? (
    <input className="rename no-drag" autoFocus defaultValue={name} onFocus={(e) => e.currentTarget.select()} onBlur={(e) => save(e.currentTarget.value)} onKeyDown={(e) => {
      if (e.key === 'Enter') save(e.currentTarget.value)
      else if (e.key === 'Escape') setEditing(false)
    }} />
  ) : (
    <Tip title="Rename" body="Click to rename this project.">
      <button className="pname no-drag" onClick={() => setEditing(true)}>
        <span className="ellipsis">{name}</span>
        <Icon name="pen" size={12} className="pname-pen" />
      </button>
    </Tip>
  )
}

/** An empty conversation: what this screen is for. */
function ProjectIntro() {
  return (
    <motion.div className="board-intro" {...rise(8, SETTLE, 0.1)}>
      <b>What are we making?</b>
      <span className="muted">Describe a video and your agent makes it on this project's canvas. Ask for variants, cut-downs or other sizes and they land beside it. Click a video to make it active: its timeline opens below, and what you ask is about it.</span>
    </motion.div>
  )
}

/** Try another take from the playhead: a copy beside it, redone from there. */
function BranchButton({ at, onBranch }: { at: number; onBranch(note: string): void }) {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const go = (): void => {
    setOpen(false)
    onBranch(note)
    setNote('')
  }
  return (
    <>
      <Tip title="Branch from here" body="A copy beside this video that keeps everything up to the playhead; the agent redoes the rest.">
        <button ref={anchor} className="btn" onClick={() => setOpen((o) => !o)}><Icon name="branch" size={15} /><span className="btn-label">Branch</span></button>
      </Tip>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} side="bottom" align="end" width={300}>
        <div className="menu branch-pop">
          <b>Another take from {clock(at)}</b>
          <span className="faint">Everything before stays as it is. What should be different after?</span>
          <textarea className="text-input" autoFocus rows={3} placeholder="Leave empty for a different direction" value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              go()
            }
          }} />
          <div className="branch-go"><button className="btn small primary" onClick={go}>Branch</button></div>
        </div>
      </Popover>
    </>
  )
}

export function ChatPills({ chats, active, onPick }: { chats: { id: string; title: string }[]; active: string | null; onPick(id: string): void }) {
  return (
    <div className="chat-pills">
      {chats.map((c) => (
        <button key={c.id} className={`pill${c.id === active ? ' on' : ''}`} onClick={() => onPick(c.id)} title={c.title}>
          {c.id === active && <motion.span layoutId="pill-bg" className="pill-bg" transition={tr(MOVE)} />}
          <span className="ellipsis">{c.title || 'New chat'}</span>
        </button>
      ))}
    </div>
  )
}

function PlusMenu({ video, onDraw, onNote, onLibrary, onReference }: { video: boolean; onDraw(): void; onNote(): void; onLibrary(): void; onReference(): void }) {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const pick = (f: () => void) => () => {
    setOpen(false)
    f()
  }
  return (
    <>
      <Tip title="Add" body="A note at this moment, a drawing, or something from the library.">
        <button ref={anchor} className={`icon-btn${open ? ' on' : ''}`} style={{ width: 30, height: 30 }} onClick={() => setOpen((o) => !o)}>
          <Icon name="plus" size={16} />
        </button>
      </Tip>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} side="top" align="start" width={240}>
        <div className="menu">
          {video && <>
            <MenuItem icon={<Icon name="pen" size={15} />} label="Draw on the frame" hint="⇧⌘D" onSelect={pick(onDraw)} />
            <MenuItem icon={<Icon name="pin" size={15} />} label="Note at this moment" hint="⇧⌘K" onSelect={pick(onNote)} />
            <MenuSep />
          </>}
          <MenuItem icon={<Icon name="play" size={15} />} label="Reference a video…" hint="@" onSelect={pick(onReference)} />
          <MenuItem icon={<Icon name="library" size={15} />} label="From the library" onSelect={pick(onLibrary)} />
          <MenuSep />
          <MenuItem icon={<Icon name="spark" size={15} />} label="Skills…" onSelect={pick(() => window.dispatchEvent(new CustomEvent('panthr:settings', { detail: 'skills' })))} />
        </div>
      </Popover>
    </>
  )
}

void useMemo
