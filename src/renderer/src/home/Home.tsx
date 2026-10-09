// Home: one job, a composer for the next video. The eye opens as it
// appears; the word after "What are we" changes; recent projects sit below,
// and hovering one scrubs through its frames.

import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { Engine, Host, Project, Skill } from '@shared/types'
import { api, useEvent, useReferences, useSettings } from '@/lib/api'
import { rise, tr, MOVE, SETTLE } from '@/lib/motion'
import { ago } from '@/lib/format'
import { LiveEye, EyeMark } from '@/ui/Eye'
import { ByClueso } from '@/ui/CluesoMark'
import { Icon } from '@/ui/Icon'
import { Composer, IconButton, ModelChip, type ComposerHandle } from '@/ui/Controls'
import { MenuItem, MenuSep, Popover } from '@/ui/Popover'
import { Tip } from '@/ui/Tooltip'
import { ThemeToggle } from '@/ui/ThemeToggle'
import { ActivityStatus } from '@/ui/Activity'
import { addVideos, ReferencesSection } from '@/editor/References'
import './home.css'

const IDEAS: [string, string][] = [
  ['Launch teaser', 'A 20-second launch teaser for a new feature: bold kinetic type, one big reveal, a punchy music bed'],
  ['Explainer', 'A 45-second explainer of how our product works, three steps, calm pacing, clear captions'],
  ['Changelog', "An animated changelog for this week's release: five items, each a quick card with an icon"],
  ['Logo reveal', 'A 6-second logo reveal with light leaks and a soft whoosh'],
  ['Social cut', 'A vertical 15-second social cut with big captions and fast cuts']
]
const WORDS = ['making', 'launching', 'explaining', 'teasing', 'cutting']
const WORD_MS = 2600

export function Home({ onOpen, onStart, onSettings, working }: {
  onOpen: (p: Project) => void
  onStart: (idea: string, host: string | null, engine: Engine, model: string) => void
  onSettings: () => void
  working: Set<string>
}) {
  const s = useSettings()
  const [projects, setProjects] = useState<Project[]>([])
  const [word, setWord] = useState(0)
  const [engine, setEngine] = useState<Engine>(s.agent)
  const [model, setModel] = useState<string | null>(null)
  const [host, setHost] = useState<string | null>(null)
  const [text, setText] = useState('')
  const box = useRef<ComposerHandle>(null)
  const refs = useReferences()
  const [refsOpen, setRefsOpen] = useState(false)
  /** A reference still being taken apart (it goes on in the background). */
  const busyRef = refs.find((r) => r.status !== 'ready' && r.status !== 'failed')
  const [skills, setSkills] = useState<Skill[]>([])
  useEffect(() => {
    api.skills.state().then((st) => setSkills(st.skills))
  }, [])
  useEvent('skills:state', (st) => setSkills(st.skills))
  const openSkills = (): void => {
    window.dispatchEvent(new CustomEvent('panthr:settings', { detail: 'skills' }))
  }
  useEffect(() => {
    if (!refsOpen) return
    const k = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !document.querySelector('.ref-sheet')) setRefsOpen(false)
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [refsOpen])
  /** Put "@handle " at the end of the idea, for the agent to look at. */
  const mention = (handle: string): void => {
    const v = box.current?.value() ?? ''
    box.current?.set(`${v}${v && !/\s$/.test(v) ? ' ' : ''}@${handle} `)
    setRefsOpen(false)
    box.current?.focus()
  }

  const load = (): void => {
    api.projects.list().then(setProjects)
  }
  useEffect(load, [])
  useEvent('chat:turn', load)
  useEvent('project:renamed', load)
  useEffect(() => setEngine(s.agent), [s.agent])
  useEffect(() => {
    const id = setInterval(() => setWord((w) => w + 1), WORD_MS)
    return () => clearInterval(id)
  }, [])
  useEffect(() => box.current?.focus(), [])

  const chosen = model ?? (engine === 'codex' ? s.codex_model : s.model)
  const start = (idea: string): void => {
    if (idea.trim()) onStart(idea.trim(), host, engine, chosen)
  }

  return (
    <div className="home">
      <div className="home-top drag">
        <EyeMark width={30} />
        <span className="wordmark">Panthr</span>
        <ByClueso height={12} />
        <span className="spacer" />
        <div className="no-drag home-top-btns">
          <ThemeToggle />
          <IconButton icon="settings" tip="Settings" keys="⌘," onClick={onSettings} />
        </div>
      </div>
      <div className="home-scroll">
        <div className="home-col">
          <motion.div className="home-eye" {...rise(10, SETTLE, 0)}>
            <LiveEye width={84} pulse={0} />
          </motion.div>
          <motion.h1 className="home-head" {...rise(14, SETTLE, 0.1)}>
            <span>What are we</span>
            <span className="home-word">
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span
                  key={word}
                  initial={{ opacity: 0, y: 14 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -14 }}
                  transition={tr(0.45)}
                >
                  {WORDS[word % WORDS.length]}?
                </motion.span>
              </AnimatePresence>
            </span>
          </motion.h1>
          <motion.div className="home-box" {...rise(14, SETTLE, 0.2)} onClick={() => box.current?.focus()}>
            <Composer ref={box} mentions={refs} placeholder="Describe a video, then press Return" onSubmit={start} onChange={setText} className="home-input" maxRows={8} />
            <div className="home-box-row" onClick={(e) => e.stopPropagation()}>
              <AddChip onVideo={async () => {
                await addVideos(await api.app.chooseFiles())
              }} onReferences={() => setRefsOpen(true)} onSkills={openSkills} />
              <WhereChip host={host} onHost={setHost} />
              <span className="spacer" />
              <ModelChip engine={engine} model={chosen} onPick={(e, m) => {
                setEngine(e)
                setModel(m)
              }} />
              <Tip title="Start" keys="⏎" body="Make a project from this and send it to the agent.">
                <button className="send" disabled={!text.trim()} onClick={() => start(box.current?.value() ?? '')}>
                  <Icon name="up" size={16} />
                </button>
              </Tip>
            </div>
          </motion.div>
          <motion.div className="home-ideas" {...rise(10, SETTLE, 0.3)}>
            {IDEAS.map(([label, idea]) => (
              <button key={label} className="idea" onClick={() => box.current?.set(idea)}>{label}</button>
            ))}
          </motion.div>
          <motion.div className="kit" {...rise(10, SETTLE, 0.35)}>
            <button className="kit-tile" onClick={() => setRefsOpen(true)}>
              <span className="kit-icon"><Icon name="film" size={16} /></span>
              <span className="kit-words">
                <b>References</b>
                {busyRef ? (
                  <span className="shine ellipsis" data-text={`Taking apart ${busyRef.name}…`}>Taking apart {busyRef.name}…</span>
                ) : (
                  <span className="faint">{refs.length ? `${refs.length} video${refs.length === 1 ? '' : 's'} taken apart · mention with @` : 'Drop a video to learn from'}</span>
                )}
              </span>
              <Icon name="chevron-right" size={14} className="faint" />
            </button>
            <button className="kit-tile" onClick={openSkills}>
              <span className="kit-icon"><Icon name="spark" size={16} /></span>
              <span className="kit-words">
                <b>Skills</b>
                <span className="faint">{skills.length ? `${skills.filter((k) => k.on).length} on · find more or write your own` : 'Find skills or write your own'}</span>
              </span>
              <Icon name="chevron-right" size={14} className="faint" />
            </button>
          </motion.div>
          {projects.length > 0 && (
            <motion.section className="recent" {...rise(10, SETTLE, 0.4)}>
              <div className="recent-head">
                <span>Recent</span>
                <span className="spacer" />
                {projects.length > 8 && <span className="faint">{projects.length} projects</span>}
              </div>
              <div className="recent-grid">
                {projects.slice(0, 8).map((p, i) => (
                  <Card key={p.dir} p={p} i={i} working={working.has(p.dir)} onOpen={() => onOpen(p)} onRenamed={load} />
                ))}
              </div>
            </motion.section>
          )}
        </div>
      </div>
      <ActivityStatus className="home-activity" />
      <AnimatePresence>
        {refsOpen && (
          <motion.div className="sheet-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={tr(MOVE)} onClick={() => setRefsOpen(false)}>
            <motion.div className="refs-sheet" initial={{ opacity: 0, y: 12, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 8, scale: 0.98 }} transition={tr(SETTLE)} onClick={(e) => e.stopPropagation()}>
              <div className="refs-sheet-close"><IconButton icon="close" tip="Close" keys="esc" onClick={() => setRefsOpen(false)} /></div>
              <ReferencesSection onMention={mention} onAdded={() => setRefsOpen(false)} />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/** The + in the idea box: bring in a video to learn from, or skills. */
function AddChip({ onVideo, onReferences, onSkills }: { onVideo(): void; onReferences(): void; onSkills(): void }) {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const pick = (f: () => void) => () => {
    setOpen(false)
    f()
  }
  return (
    <>
      <Tip title="Add" body="A reference video for the agent to learn from, or skills it can use.">
        <button ref={anchor} className={`chip icon-only${open ? ' open' : ''}`} onClick={() => setOpen((o) => !o)}>
          <Icon name="plus" size={15} />
        </button>
      </Tip>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} side="bottom" align="start" width={240}>
        <div className="menu">
          <MenuItem icon={<Icon name="film" size={15} />} label="Reference a video…" onSelect={pick(onVideo)} />
          <MenuItem icon={<Icon name="library" size={15} />} label="Your references" hint="@" onSelect={pick(onReferences)} />
          <MenuSep />
          <MenuItem icon={<Icon name="spark" size={15} />} label="Skills…" onSelect={pick(onSkills)} />
        </div>
      </Popover>
    </>
  )
}

function Card({ p, i, working, onOpen, onRenamed }: { p: Project; i: number; working: boolean; onOpen: () => void; onRenamed: () => void }) {
  const [thumb, setThumb] = useState<string | null>(null)
  const [menu, setMenu] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const anchor = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (p.thumb) api.app.fileUrl(p.thumb).then(setThumb)
  }, [p.thumb])
  const commit = async (v: string): Promise<void> => {
    if (!renaming) return
    setRenaming(false)
    const n = v.trim()
    if (n && n !== p.meta.name) {
      await api.projects.rename(p.dir, n)
      onRenamed()
    }
  }
  return (
    <motion.div className="card" role="button" tabIndex={0} onClick={() => !renaming && onOpen()} onKeyDown={(e) => e.key === 'Enter' && !renaming && onOpen()}
      onContextMenu={(e) => {
        e.preventDefault()
        setMenu(true)
      }} {...rise(12, SETTLE, 0.45 + i * 0.05)}>
      <div className="card-shot" ref={anchor}>
        {thumb && <img src={thumb} alt="" draggable={false} />}
        <AnimatePresence>
          {working && (
            <motion.div className="card-working" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={tr(MOVE)}>
              <i /> Working
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      {renaming ? (
        <input className="card-rename" autoFocus defaultValue={p.meta.name} onClick={(e) => e.stopPropagation()} onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => commit(e.currentTarget.value)} onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') commit(e.currentTarget.value)
            else if (e.key === 'Escape') setRenaming(false)
          }} />
      ) : (
        <div className="card-name ellipsis" onDoubleClick={(e) => {
          e.stopPropagation()
          setRenaming(true)
        }}>{p.meta.name}</div>
      )}
      <div className="card-meta">{p.host ? `On ${p.host}` : `Edited ${ago(p.edited_at || p.meta.created_at)}`}</div>
      <Popover anchor={anchor} open={menu} onClose={() => setMenu(false)} side="bottom" align="start" width={200}>
        <div className="menu" onClick={(e) => e.stopPropagation()}>
          <MenuItem icon={<Icon name="pen" size={14} />} label="Rename" onSelect={() => {
            setMenu(false)
            setRenaming(true)
          }} />
          {!p.host && <MenuItem icon={<Icon name="folder" size={14} />} label="Show in Finder" onSelect={() => {
            setMenu(false)
            api.app.reveal(p.dir)
          }} />}
        </div>
      </Popover>
    </motion.div>
  )
}

/** Where a new project is made: this Mac, or one of the hosts. */
function WhereChip({ host, onHost }: { host: string | null; onHost: (h: string | null) => void }) {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [hosts, setHosts] = useState<Host[]>([])
  useEffect(() => {
    if (open) api.hosts.list().then(setHosts)
  }, [open])
  const pick = (h: string | null): void => {
    onHost(h)
    setOpen(false)
  }
  return (
    <>
      <Tip title="Where it runs" body="This Mac, or a remote host you added in Settings: the agent and renders run there.">
        <button ref={anchor} className={`chip${open ? ' open' : ''}`} onClick={() => setOpen((o) => !o)}>
          <Icon name={host ? 'cloud' : 'laptop'} size={15} className="faint" />
          <span>{host ?? 'This Mac'}</span>
          <Icon name="chevron" size={12} className="faint" />
        </button>
      </Tip>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} side="bottom" align="start" width={240}>
        <div className="menu">
          <MenuItem label="This Mac" on={!host} onSelect={() => pick(null)} />
          {hosts.map((h) => (
            <MenuItem key={h.name} label={<>{h.name} <span className="faint">· {h.target}</span></>} on={host === h.name} onSelect={() => pick(h.name)} />
          ))}
          <MenuSep />
          <MenuItem icon={<Icon name="plus" size={14} />} label="Add a remote host…" onSelect={() => {
            setOpen(false)
            window.dispatchEvent(new CustomEvent('panthr:settings', { detail: 'hosts' }))
          }} />
        </div>
      </Popover>
    </>
  )
}
