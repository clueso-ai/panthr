// What is going on behind the window: agent turns in any project, exports,
// references being taken apart and skills installing. One store, fed by
// the app's events from the moment the window loads, and a button beside
// Settings that shows a count and opens the list.

import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { Engine, Reference, SkillsState } from '@shared/types'
import { api } from '@/lib/api'
import { tr, MOVE, QUICK } from '@/lib/motion'
import { Icon, type IconName } from './Icon'
import { Popover } from './Popover'
import { Tip } from './Tooltip'

export interface Activity {
  /** Agent turns running, by project folder. */
  turns: Map<string, { chatId: string; startedAt: number | null; engine: Engine }>
  /** Exports rendering, by project folder. */
  exports: Map<string, { percent: number; stage: string }>
  references: Reference[]
  skills: { running: string | null; waiting: number }
  /** Project names, by folder (looked up once). */
  names: Map<string, string>
}

let now: Activity = { turns: new Map(), exports: new Map(), references: [], skills: { running: null, waiting: 0 }, names: new Map() }
const subs = new Set<(a: Activity) => void>()
const publish = (next: Partial<Activity>): void => {
  now = { ...now, ...next }
  subs.forEach((f) => f(now))
}
const nameOf = (dir: string): void => {
  if (now.names.has(dir)) return
  now.names.set(dir, dir.split('/').pop() ?? dir)
  api.projects.load(dir).then((p) => p && publish({ names: new Map(now.names).set(dir, p.meta.name) }))
}

api.on('chat:state', (c) => {
  const running = now.turns.get(c.dir)
  if (c.working) {
    if (running?.chatId === c.chatId && running.startedAt === c.startedAt) return
    nameOf(c.dir)
    publish({ turns: new Map(now.turns).set(c.dir, { chatId: c.chatId, startedAt: c.startedAt, engine: c.engine }) })
  } else if (running?.chatId === c.chatId) {
    const t = new Map(now.turns)
    t.delete(c.dir)
    publish({ turns: t })
  }
})
api.on('job', (j) => {
  const e = new Map(now.exports)
  if (j.type === 'progress' || j.type === 'stage') {
    const was = e.get(j.dir) ?? { percent: 0, stage: 'Starting' }
    nameOf(j.dir)
    e.set(j.dir, j.type === 'progress' ? { ...was, percent: j.percent } : { ...was, stage: j.text })
  } else if (j.type === 'rendered' || j.type === 'failed') e.delete(j.dir)
  else return
  publish({ exports: e })
})
const refs = (r: Reference[]): void => publish({ references: r.filter((x) => x.status !== 'ready' && x.status !== 'failed') })
api.on('references', refs)
api.references.list().then(refs)
const skills = (s: SkillsState): void => publish({ skills: { running: s.running, waiting: s.waiting.length } })
api.on('skills:state', skills)
api.skills.state().then(skills)

export function useActivity(): Activity {
  const [a, set] = useState(now)
  useEffect(() => {
    subs.add(set)
    set(now)
    return () => {
      subs.delete(set)
    }
  }, [])
  return a
}

const count = (a: Activity): number => a.turns.size + a.exports.size + a.references.length + (a.skills.running ? 1 + a.skills.waiting : 0)

/** "2m 05s" since a moment. */
const since = (t: number | null, at: number): string => {
  if (!t) return ''
  const s = Math.max(0, Math.round((at - t) / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

/** Open a project in the window (App listens). */
const openProject = (dir: string): void => {
  window.dispatchEvent(new CustomEvent('panthr:open-project', { detail: dir }))
}

/** One line for what is running: the job itself when there is one. */
function summary(a: Activity): string {
  const n = count(a)
  if (n !== 1) return `${n} running`
  const [turn] = a.turns
  if (turn) return `Agent working in ${a.names.get(turn[0]) ?? 'a project'}`
  const [ex] = a.exports
  if (ex) return `Exporting ${a.names.get(ex[0]) ?? ''} · ${Math.round(ex[1].percent)}%`
  if (a.references[0]) return `Taking apart ${a.references[0].name}`
  return `Installing ${a.skills.running}`
}

/** The bottom-left status line: there while anything runs, gone when not. */
export function ActivityStatus({ className }: { className?: string }) {
  const n = count(useActivity())
  return (
    <AnimatePresence initial={false}>
      {n > 0 && (
        <motion.div className={`activity-status ${className ?? ''}`} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={tr(MOVE)}>
          <ActivityButton />
        </motion.div>
      )}
    </AnimatePresence>
  )
}

export function ActivityButton() {
  const a = useActivity()
  const n = count(a)
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [at, setAt] = useState(Date.now())
  useEffect(() => {
    if (!open) return
    const id = setInterval(() => setAt(Date.now()), 1000)
    return () => clearInterval(id)
  }, [open])
  return (
    <>
      <Tip title="Activity" body="Agents working, exports, references and skills, wherever they are.">
        <button ref={anchor} className={`activity-btn${n ? ' busy' : ''}${open ? ' open' : ''}`} aria-label={`Activity: ${n} running`} onClick={() => setOpen((o) => !o)}>
          <span className="activity-ring" />
          <span className="activity-summary ellipsis">{n ? summary(a) : 'Nothing running'}</span>
        </button>
      </Tip>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} side="top" align="start" width={320}>
        <div className="activity">
          <div className="activity-head">{n ? `${n} running` : 'Nothing running'}</div>
          {n === 0 && <div className="activity-empty faint">Agent turns, exports, references being taken apart and skills installing show here while they run.</div>}
          <AnimatePresence initial={false}>
            {[...a.turns].map(([dir, t]) => (
              <Row key={`t${dir}`} icon="spark" title={a.names.get(dir) ?? dir} detail={`${t.engine === 'codex' ? 'Codex' : 'Claude'} is working · ${since(t.startedAt, at)}`}
                actions={<>
                  <button className="link" onClick={() => { setOpen(false); openProject(dir) }}>Open</button>
                  <button className="link danger" onClick={() => api.chats.stop(dir, t.chatId)}>Stop</button>
                </>} />
            ))}
            {[...a.exports].map(([dir, e]) => (
              <Row key={`e${dir}`} icon="export" title={`Exporting ${a.names.get(dir) ?? dir}`} detail={`${Math.round(e.percent)}% · ${e.stage}`} percent={e.percent}
                actions={<>
                  <button className="link" onClick={() => { setOpen(false); openProject(dir) }}>Open</button>
                  <button className="link danger" onClick={() => api.review.cancelRender(dir)}>Cancel</button>
                </>} />
            ))}
            {a.references.map((r) => (
              <Row key={`r${r.id}`} icon="film" title={`Taking apart ${r.name}`} detail={r.step ?? (r.status === 'importing' ? 'Bringing it in' : 'Deconstructing')} />
            ))}
            {a.skills.running && (
              <Row key="skills" icon="library" title={`Installing ${a.skills.running}`} detail={a.skills.waiting ? `${a.skills.waiting} more waiting` : 'Skills'} />
            )}
          </AnimatePresence>
        </div>
      </Popover>
    </>
  )
}

function Row({ icon, title, detail, percent, actions }: { icon: IconName; title: string; detail: string; percent?: number; actions?: React.ReactNode }) {
  return (
    <motion.div className="activity-row" layout="position" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={tr(MOVE)}>
      <span className="activity-icon"><Icon name={icon} size={14} /></span>
      <span className="activity-words">
        <b className="ellipsis">{title}</b>
        <span className="shine ellipsis" data-text={detail}>{detail}</span>
        {percent !== undefined && <span className="activity-bar"><motion.i animate={{ width: `${percent}%` }} transition={tr(QUICK)} /></span>}
      </span>
      {actions && <span className="activity-actions">{actions}</span>}
    </motion.div>
  )
}
