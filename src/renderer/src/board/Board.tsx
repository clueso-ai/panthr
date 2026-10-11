// The Board: every project and reference video as a tile on one canvas you
// pan and zoom, with arrows from what each came from, and one conversation
// docked beside it. Its agent makes projects (`panthr board new`); a new
// tile drops in where you are looking and the view glides to it. Double-
// clicking a tile zooms into it and opens the editor; coming back zooms out.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, animate, motion, useMotionValue, useMotionValueEvent } from 'motion/react'
import type { Board as BoardData, BoardView, ChatState, Engine, Project, Reference } from '@shared/types'
import { api, settingsNow, useEvent, useReferences, useSettings } from '@/lib/api'
import { EASE, rise, tr, MOVE, QUICK, SETTLE } from '@/lib/motion'
import { ago } from '@/lib/format'
import { Icon } from '@/ui/Icon'
import { EyeMark } from '@/ui/Eye'
import { Composer, IconButton, ModelChip, type ComposerHandle } from '@/ui/Controls'
import { ThemeToggle } from '@/ui/ThemeToggle'
import { ActivityStatus, useActivity } from '@/ui/Activity'
import { Tip } from '@/ui/Tooltip'
import { Chat } from '@/editor/Chat'
import { ChatPills } from '@/editor/Editor'
import { addVideos, ReferencesSection, RefSheet } from '@/editor/References'
import '@/editor/editor.css'
import '@/home/home.css'
import './board.css'

const ZOOM = { min: 0.15, max: 2.5 }
const clamp = (v: number, a: number, b: number): number => Math.min(b, Math.max(a, v))
const dur = (d: number): number => (settingsNow().reduce_motion ? 0 : d)

export function Board({ canvas, first, returnTo, focus, onOpen, onHome, onSettings }: {
  /** The project: its folder holds the canvas and the conversation. */
  canvas: string
  /** A project started from Home: its idea goes to the conversation. */
  first: string | null
  /** The project just left: the board starts zoomed into it and pulls back. */
  returnTo: string | null
  /** A tile to glide to once the board is up (from the agent, while away). */
  focus: string | null
  onOpen(dir: string): void
  onHome(): void
  onSettings(): void
}) {
  const [board, setBoard] = useState<BoardData | null>(null)
  const [projects, setProjects] = useState<Map<string, Project>>(new Map())
  const refs = useReferences()
  const activity = useActivity()
  const [selected, setSelected] = useState<string | null>(null)
  const [fresh, setFresh] = useState<Set<string>>(new Set())
  const [openRef, setOpenRef] = useState<string | null>(null)
  const [refsOpen, setRefsOpen] = useState(false)

  /** The videos on the canvas, as projects (name, poster, when edited). */
  const loadProjects = useCallback((b: BoardData | null) => {
    if (!b) return
    const dirs = Object.keys(b.tiles).filter((k) => !k.startsWith('ref:'))
    Promise.all(dirs.map((d) => api.projects.load(d))).then((all) => setProjects(new Map(all.filter((p): p is Project => !!p).map((p) => [p.dir, p]))))
  }, [])
  useEffect(() => {
    api.board.get(canvas).then((b) => {
      setBoard(b)
      loadProjects(b)
    })
  }, [canvas, loadProjects])
  useEvent('board:changed', (b) => {
    if (b.dir !== canvas) return
    setBoard(b)
    loadProjects(b)
  }, [canvas])
  useEvent('project:renamed', () => loadProjects(board), [board])
  useEvent('chat:turn', () => loadProjects(board), [board])

  // ── The view: canvas → screen is o + p·z ──────────────────────
  const stage = useRef<HTMLDivElement>(null)
  const ox = useMotionValue(0)
  const oy = useMotionValue(0)
  const z = useMotionValue(1)
  const [zoomShown, setZoomShown] = useState(1)
  useMotionValueEvent(z, 'change', (v) => setZoomShown(v))
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
  // Remember where the board was looked at (a moment after it stops).
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const leaving = useRef(false)
  const remember = (): void => {
    if (leaving.current) return
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => api.board.setView(canvas, centre()), 400)
  }
  useMotionValueEvent(ox, 'change', remember)
  useMotionValueEvent(z, 'change', remember)

  const tile = board?.tile ?? { w: 320, h: 230 }
  const at = (key: string): { x: number; y: number } | null => board?.tiles[key] ?? null
  const tileView = (key: string, zoom?: number): BoardView | null => {
    const p = at(key)
    if (!p) return null
    return { x: p.x + tile.w / 2, y: p.y + tile.h / 2, zoom: zoom ?? clamp(Math.max(z.get(), 0.7), ZOOM.min, 1) }
  }
  /** Zoom that makes a tile fill the stage (for going in and out of it). */
  const fillZoom = (): number => {
    const { w, h } = size()
    return Math.min(w / tile.w, h / tile.h) * 1.05
  }

  // First view: back out of the project just left, else where it was, else all.
  const placed = useRef(false)
  useEffect(() => {
    if (!board || placed.current || !stage.current) return
    placed.current = true
    const back = returnTo ? tileView(returnTo, fillZoom()) : null
    const rest = board.view ?? fitView(board, size(), tile)
    if (back) {
      setView(back)
      setSelected(returnTo)
      glide(rest, 0.55)
    } else setView(rest)
    if (focus) setTimeout(() => show(focus, false), 300)
  }, [board]) // eslint-disable-line react-hooks/exhaustive-deps

  /** Glide to a tile; a fresh one drops in and keeps playing for a while. */
  const show = (key: string, isFresh: boolean): void => {
    const v = tileView(key)
    if (!v) return
    setSelected(key)
    if (isFresh) {
      setFresh((f) => new Set(f).add(key))
      if (!key.startsWith('ref:')) api.projects.watch(key)
    }
    glide(v)
  }
  const pendingFocus = useRef<{ key: string; fresh: boolean } | null>(null)
  useEvent('board:focus', (e) => {
    if (e.canvas !== canvas) return
    if (board?.tiles[e.key]) show(e.key, e.fresh)
    else pendingFocus.current = e
  }, [board, canvas])
  useEffect(() => {
    const p = pendingFocus.current
    if (p && board?.tiles[p.key]) {
      pendingFocus.current = null
      show(p.key, p.fresh)
    }
  }, [board]) // eslint-disable-line react-hooks/exhaustive-deps

  /** Into a project: the view zooms until its tile fills the stage, then the editor takes over. */
  const enter = async (dir: string): Promise<void> => {
    // Where the board was is where coming back lands (not the zoomed-in view).
    clearTimeout(saveTimer.current)
    leaving.current = true
    await api.board.setView(canvas, centre())
    const v = tileView(dir, fillZoom())
    if (v) await glide(v, 0.42)
    onOpen(dir)
  }

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
  const panFrom = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)
  const zoomBy = (f: number): void => {
    glide({ ...centre(), zoom: clamp(z.get() * f, ZOOM.min, ZOOM.max) }, 0.3)
  }
  /** Bring things in: placed from a canvas point (the drop point, else the view's centre). */
  const [note, setNote] = useState<string | null>(null)
  const bringIn = async (paths: string[], at?: { x: number; y: number }): Promise<void> => {
    if (!paths.length) return
    const r = await api.board.import(canvas, paths, at ?? null)
    const parts = [
      r.projects.length && `${r.projects.length} project${r.projects.length === 1 ? '' : 's'}`,
      r.references.length && `${r.references.length} video${r.references.length === 1 ? '' : 's'} to take apart`,
      r.library.length && `${r.library.length} file${r.library.length === 1 ? '' : 's'} into the Library`
    ].filter(Boolean)
    const skipped = r.skipped.length ? `Skipped ${r.skipped.map((k) => `${k.path.split('/').pop()} (${k.why})`).join(', ')}` : ''
    setNote([parts.length ? `Brought in ${parts.join(', ')}.` : '', skipped].filter(Boolean).join(' '))
  }
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
      const at = inside ? { x: (d.x - r!.left - ox.get()) / z.get() - tile.w / 2, y: (d.y - r!.top - oy.get()) / z.get() - tile.h / 2 } : undefined
      void bringIn(d.paths, at)
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

  // ── The project's conversation (a chat of its folder) ─────────
  const settings = useSettings()
  const chatDir = canvas
  const [meta, setMeta] = useState<Project | null>(null)
  const [chatId, setChatId] = useState<string | null>(null)
  const [chat, setChat] = useState<ChatState | null>(null)
  const composer = useRef<ComposerHandle>(null)
  useEffect(() => {
    api.projects.load(canvas).then(async (p) => {
      setMeta(p)
      const last = p?.meta.chats[p.meta.chats.length - 1]
      setChatId(last ? last.id : await api.chats.create(canvas))
    })
    api.state.set({ canvas, home: false, project: null })
  }, [canvas])
  useEvent('project:renamed', (e) => {
    if (e.dir === canvas) setMeta((m) => (m ? { ...m, meta: { ...m.meta, name: e.name } } : m))
  }, [canvas])
  // A project started from Home: its idea goes to the conversation once.
  const sentFirst = useRef(false)
  useEffect(() => {
    if (first && chat && chatId && !sentFirst.current && chat.items.length === 0) {
      sentFirst.current = true
      api.chats.send(canvas, chatId, first)
    }
  }, [first, chat, chatId, canvas])
  useEffect(() => {
    if (chatDir && chatId) api.chats.open(chatDir, chatId).then(setChat)
  }, [chatDir, chatId])
  useEvent('chat:state', (c) => {
    if (c.dir !== chatDir) return
    if (c.chatId === chatId) setChat(c)
    // Another board conversation started working (from the command line): show it.
    else if (c.working && !chat?.working) {
      setChatId(c.chatId)
      api.projects.load(c.dir).then(setMeta)
    }
  }, [chatDir, chatId, chat?.working])
  useEvent('chat:titled', (e) => {
    if (e.dir === chatDir) api.projects.load(e.dir).then(setMeta)
  }, [chatDir])
  const engine: Engine = chat?.engine ?? settings.agent
  const model = meta?.meta.models[engine] ?? (engine === 'codex' ? settings.codex_model : settings.model)
  const pickModel = async (e: Engine, m: string): Promise<void> => {
    if (!meta || !chatDir) return
    if (chatId && e !== engine) await api.chats.setEngine(chatDir, chatId, e)
    const next = { ...meta.meta, models: { ...meta.meta.models, [e]: m } }
    await api.projects.saveMeta(chatDir, next)
    setMeta({ ...meta, meta: next })
  }
  const send = (text: string): void => {
    if (!chatDir || !chatId || !text.trim()) return
    // What the person is looking at, so "this one" means something.
    const sel = selected ? (selected.startsWith('ref:') ? `@${refs.find((r) => `ref:${r.id}` === selected)?.handle}` : projects.get(selected)?.meta.name) : null
    api.chats.send(chatDir, chatId, sel ? `${text}\n\n(On the canvas I have "${sel}" selected${selected && !selected.startsWith('ref:') ? `: ${selected}` : ''}.)` : text)
  }
  const newChat = async (): Promise<void> => {
    if (!chatDir) return
    const id = await api.chats.create(chatDir, chat?.engine)
    setMeta(await api.projects.load(chatDir))
    setChatId(id)
    composer.current?.focus()
  }
  const mention = (handle: string): void => {
    const v = composer.current?.value() ?? ''
    composer.current?.set(`${v}${v && !v.endsWith(' ') ? ' ' : ''}@${handle} `)
    composer.current?.focus()
  }

  // ── What the tiles show ────────────────────────────────────────
  const keys = useMemo(() => Object.keys(board?.tiles ?? {}), [board])
  // The conversation is the project's: while it works, the videos it made this time show it.
  const working = (dir: string): boolean => activity.turns.has(dir) || (!!chat?.working && fresh.has(dir))
  const refOf = (key: string): Reference | undefined => refs.find((r) => `ref:${r.id}` === key)
  const live = (key: string): boolean => key === selected || fresh.has(key) || working(key)
  const empty = board && keys.length === 0

  return (
    <div className="board">
      {/* The conversation */}
      <aside className="board-chat">
        <div className="titlebar drag board-title">
          <div className="no-drag titlebar-btns">
            <IconButton icon="back" tip="All projects" keys="⇧⌘H" onClick={onHome} />
          </div>
          <ProjectName dir={canvas} name={meta?.meta.name ?? ''} />
          <span className="spacer" />
          <div className="no-drag titlebar-btns">
            <IconButton icon="new-chat" tip="New conversation" keys="⌘T" onClick={newChat} />
          </div>
        </div>
        <div className="left-body board-chat-body">
          {(meta?.meta.chats.length ?? 0) > 1 && <ChatPills chats={meta!.meta.chats} active={chatId} onPick={setChatId} />}
          {chat && chat.items.length > 0 ? <Chat chat={chat} /> : <BoardIntro />}
        </div>
        <div className="composer-card">
          <AnimatePresence>
            {selected && (
              <motion.div className="scope-row" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={tr(QUICK)}>
                <span className="scope">◎ {selected.startsWith('ref:') ? `@${refOf(selected)?.handle ?? ''}` : projects.get(selected)?.meta.name ?? ''}</span>
                <button className="link" onClick={() => setSelected(null)}>×</button>
              </motion.div>
            )}
          </AnimatePresence>
          <Composer ref={composer} mentions={refs} placeholder={selected && !selected.startsWith('ref:') ? 'Ask about this one, or for something new…' : 'Describe a video, or ask for variants…'} onSubmit={send} maxRows={10} autoFocus />
          <div className="composer-row">
            <Tip title="Reference a video" body="Your agent takes it apart; mention it with @.">
              <button className="icon-btn" style={{ width: 30, height: 30 }} onClick={async () => addVideos(await api.app.chooseFiles())}><Icon name="film" size={15} /></button>
            </Tip>
            <span className="spacer" />
            <ModelChip engine={engine} model={model} locked={!!chat?.items.length} onPick={pickModel} agents={meta?.meta.agents_enabled} onAgents={async (on) => {
              if (!meta || !chatDir) return
              const next = { ...meta.meta, agents_enabled: on }
              await api.projects.saveMeta(chatDir, next)
              setMeta({ ...meta, meta: next })
            }} />
            {chat?.working ? (
              <Tip title="Stop" body="Ends this turn. The conversation keeps everything so far.">
                <button className="send stop" onClick={() => chatDir && chatId && api.chats.stop(chatDir, chatId)}><Icon name="stop" size={12} /></button>
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

      {/* The canvas */}
      <div
        ref={stage}
        className="board-stage"
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest('.tile, .board-ui')) return
          anims.current.forEach((a) => a.stop())
          e.currentTarget.setPointerCapture(e.pointerId)
          panFrom.current = { x: e.clientX, y: e.clientY, ox: ox.get(), oy: oy.get() }
          setSelected(null)
        }}
        onPointerMove={(e) => {
          const p = panFrom.current
          if (!p) return
          ox.set(p.ox + e.clientX - p.x)
          oy.set(p.oy + e.clientY - p.y)
        }}
        onPointerUp={() => (panFrom.current = null)}
        onPointerCancel={() => (panFrom.current = null)}
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
              const project = ref ? undefined : projects.get(key)
              if (!ref && !project) return null
              return (
                <motion.div
                  key={key}
                  className={`tile${key === selected ? ' on' : ''}${drag?.key === key ? ' dragging' : ''}${working(key) ? ' busy' : ''}`}
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
                  onPointerUp={() => {
                    const d = dragFrom.current
                    dragFrom.current = null
                    if (!d) return
                    if (d.moved && drag) {
                      const { x, y } = drag
                      setBoard((b) => (b ? { ...b, tiles: { ...b.tiles, [key]: { x, y } } } : b))
                      setDrag(null)
                      api.board.move(canvas, key, x, y)
                    } else setSelected(key)
                  }}
                  onDoubleClick={() => (ref ? setOpenRef(ref.id) : enter(key))}
                >
                  {ref ? <RefTile r={ref} h={tile.h} /> : <ProjectTile p={project!} h={tile.h} live={live(key)} working={working(key)} />}
                </motion.div>
              )
            })}
          </AnimatePresence>
        </motion.div>

        {empty && (
          <motion.div className="board-empty board-ui" {...rise(10, SETTLE, 0.2)}>
            <LiveMark />
            <b>Nothing here yet</b>
            <span className="muted">Describe a video on the left. Each one your agent makes lands here as a tile; variants sit beside what they came from.</span>
          </motion.div>
        )}

        {/* Top right: references, skills, theme, settings */}
        <div className="board-ui board-tools no-drag">
          <Tip title="Import" body="Project folders (or a folder of them), videos and files. Or drop them on the board.">
            <button className="board-tool" onClick={async () => bringIn(await api.app.chooseFiles(true))}><Icon name="import" size={15} /><span>Import</span></button>
          </Tip>
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
          <button className="mono" onClick={() => glide({ ...centre(), zoom: 1 }, 0.4)}>{Math.round(zoomShown * 100)}%</button>
          <button onClick={() => zoomBy(1.25)} aria-label="Zoom in">+</button>
          <Tip title="Show everything" keys="⇧1"><button onClick={fitAll} aria-label="Show everything"><Icon name="layers" size={13} /></button></Tip>
        </div>

        <ActivityStatus className="board-activity board-ui" />
        <AnimatePresence>
          {note && (
            <motion.div className="board-note board-ui" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} transition={tr(MOVE)}>{note}</motion.div>
          )}
        </AnimatePresence>
      </div>

      <AnimatePresence>
        {refsOpen && (
          <motion.div className="sheet-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={tr(MOVE)} onClick={() => setRefsOpen(false)}>
            <motion.div className="refs-sheet" initial={{ opacity: 0, y: 12, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 8, scale: 0.98 }} transition={tr(SETTLE)} onClick={(e) => e.stopPropagation()}>
              <div className="refs-sheet-close"><IconButton icon="close" tip="Close" keys="esc" onClick={() => setRefsOpen(false)} /></div>
              <ReferencesSection onMention={(h) => { setRefsOpen(false); mention(h) }} onAdded={() => setRefsOpen(false)} />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      <RefSheet r={refs.find((r) => r.id === openRef) ?? null} onClose={() => setOpenRef(null)} onMention={(h) => { setOpenRef(null); mention(h) }} />
      <BoardKeys onFit={fitAll} onZoom={zoomBy} onNewChat={newChat} />
    </div>
  )
}

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
function askPoster(dir: string): void {
  if (posterAsked.has(dir)) return
  posterAsked.add(dir)
  posterChain = posterChain.then(async () => {
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

/** A video: its poster, or the video itself playing while it is selected,
 *  new, or being worked on. */
function ProjectTile({ p, h, live, working }: { p: Project; h: number; live: boolean; working: boolean }) {
  const [poster, setPoster] = useState<string | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const [hover, setHover] = useState(false)
  const [nonce, setNonce] = useState(0)
  const frame = useRef<HTMLIFrameElement>(null)
  useEffect(() => {
    if (p.thumb) api.app.fileUrl(p.thumb).then(setPoster)
  }, [p.thumb, p.edited_at])
  const playing = live || hover
  // No picture yet: make one (and show it when it comes).
  useEffect(() => {
    if (!p.thumb && !p.host) askPoster(p.dir)
  }, [p.thumb, p.dir, p.host, p.edited_at])
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
    <div className="tile-body" onPointerEnter={() => setHover(true)} onPointerLeave={() => setHover(false)}>
      <div className="tile-shot" style={{ height: h - 50 }}>
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
      <div className="tile-shot" style={{ height: h - 50 }}>
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

function BoardIntro() {
  return (
    <motion.div className="board-intro" {...rise(8, SETTLE, 0.1)}>
      <b>What are we making?</b>
      <span className="muted">Describe a video and your agent makes it here, on this project's canvas. Ask for variants, cut-downs or other sizes and they land beside it. Select a tile to talk about that one; double-click it to go in.</span>
    </motion.div>
  )
}

function LiveMark() {
  return <span className="board-empty-mark"><EyeMark width={44} /></span>
}

/** ⇧1 shows everything, ⌘= / ⌘- zoom, ⌘T a new conversation. */
function BoardKeys({ onFit, onZoom, onNewChat }: { onFit(): void; onZoom(f: number): void; onNewChat(): void }) {
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
  useEvent('command', ({ name }) => {
    if (name === 'new-chat') onNewChat()
  })
  return null
}
