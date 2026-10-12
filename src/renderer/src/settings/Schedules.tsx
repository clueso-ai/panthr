// Settings ▸ Schedules: videos made on their own. Each: what to make, in
// which project (or a new one each time), on which days and at what time,
// exported or not; with when it runs next and how the last run went.

import { useEffect, useState } from 'react'
import { motion } from 'motion/react'
import type { Canvas, ScheduleStatus } from '@shared/types'
import { api, useEvent } from '@/lib/api'
import { rise, MOVE } from '@/lib/motion'
import { Switch } from '@/ui/Controls'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
export const whenText = (s: Pick<ScheduleStatus, 'days' | 'time'>): string =>
  `${s.days.length === 7 ? 'Every day' : s.days.join() === '1,2,3,4,5' ? 'Weekdays' : s.days.map((d) => DAYS[d]).join(', ')} at ${s.time}`
export const nextText = (t: number | null): string => {
  if (!t) return 'Off'
  const d = new Date(t * 1000)
  const today = new Date()
  const same = d.toDateString() === today.toDateString()
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1).toDateString() === d.toDateString()
  const hm = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return same ? `Today ${hm}` : tomorrow ? `Tomorrow ${hm}` : d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) + ` ${hm}`
}

const blank = { name: '', prompt: '', project: '' as string, days: [5], time: '09:00', exportAfter: true }

export function SchedulesPane() {
  const [list, setList] = useState<ScheduleStatus[]>([])
  const [projects, setProjects] = useState<Canvas[]>([])
  const [draft, setDraft] = useState(blank)
  const [editing, setEditing] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<string | null>(null)
  useEffect(() => {
    api.schedules.list().then(setList)
    api.canvases.list().then((c) => setProjects(c.filter((x) => !x.host)))
  }, [])
  useEvent('schedules', setList)
  const save = async (): Promise<void> => {
    setError(null)
    try {
      await api.schedules.save({ ...(editing ? { id: editing } : {}), name: draft.name, prompt: draft.prompt, project: draft.project || null, days: draft.days, time: draft.time, exportAfter: draft.exportAfter, enabled: true })
      setDraft(blank)
      setEditing(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }
  const edit = (s: ScheduleStatus): void => {
    setEditing(s.id)
    setDraft({ name: s.name, prompt: s.prompt, project: s.project ?? '', days: s.days, time: s.time, exportAfter: s.exportAfter })
  }
  const toggleDay = (d: number): void => setDraft((x) => ({ ...x, days: x.days.includes(d) ? x.days.filter((y) => y !== d) : [...x.days, d].sort() }))
  return (
    <>
      <p className="pane-lede">Videos made on their own: at a time on the days you pick, the agent gets your message, in a project or a new one each time, while Panthr is open. It works without asking questions, checks its work, and (if you like) exports it; a notification says when it’s ready. A run missed while Panthr was closed happens when it next opens.</p>
      {list.map((s) => (
        <motion.div key={s.id} {...rise(6, MOVE)} className="card sched">
          <div className="sched-head">
            <b>{s.name}</b>
            <span className="faint">{whenText(s)} · {s.project ? projects.find((p) => p.dir === s.project)?.name ?? 'its project' : 'a new project each time'}{s.exportAfter ? ' · exported' : ''}</span>
            <span className="spacer" />
            <Switch on={s.enabled} onChange={(v) => api.schedules.save({ ...s, enabled: v })} />
          </div>
          <div className="sched-prompt">{s.prompt}</div>
          <div className="sched-foot">
            <span className={s.running ? 'sched-running' : 'faint'}>{s.running ? 'Running now' : `Next: ${nextText(s.next)}`}</span>
            {s.last && <span className={s.last.ok ? 'faint' : 'sched-bad'}>· Last: {s.last.note}</span>}
            <span className="spacer" />
            <button className="btn small" disabled={s.running} onClick={() => api.schedules.run(s.id)}>Run now</button>
            <button className="btn small ghost" onClick={() => edit(s)}>Edit</button>
            {confirm === s.id
              ? <button className="btn small danger" onClick={() => { setConfirm(null); api.schedules.remove(s.id) }}>Remove it</button>
              : <button className="btn small ghost danger" onClick={() => setConfirm(s.id)}>Remove</button>}
          </div>
        </motion.div>
      ))}
      <div className="card sched-form">
        <b className="sched-title">{editing ? 'Change it' : 'A new schedule'}</b>
        <input className="text-input" placeholder="Name (Weekly changelog)" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        <textarea className="text-input" rows={3} placeholder="What to make, with where to find it. “A 30-second changelog video from this week’s releases on github.com/acme/app, one card each.”" value={draft.prompt} onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} />
        <div className="sched-row">
          <select className="text-input" value={draft.project} onChange={(e) => setDraft({ ...draft, project: e.target.value })}>
            <option value="">A new project each time</option>
            {projects.map((p) => <option key={p.dir} value={p.dir}>{p.name}</option>)}
          </select>
          <input className="text-input sched-time" type="time" value={draft.time} onChange={(e) => setDraft({ ...draft, time: e.target.value })} />
        </div>
        <div className="sched-days">
          {DAYS.map((d, i) => <button key={d} className={`idea${draft.days.includes(i) ? ' on' : ''}`} onClick={() => toggleDay(i)}>{d}</button>)}
          <span className="spacer" />
          <label className="sched-check"><Switch on={draft.exportAfter} onChange={(v) => setDraft({ ...draft, exportAfter: v })} small /> Export when done</label>
        </div>
        {error && <div className="conn-line bad"><i />{error}</div>}
        <div className="sched-go">
          {editing && <button className="btn small ghost" onClick={() => { setEditing(null); setDraft(blank) }}>Cancel</button>}
          <button className="btn primary" disabled={!draft.name.trim() || !draft.prompt.trim() || !draft.days.length} onClick={save}>{editing ? 'Save' : 'Add schedule'}</button>
        </div>
      </div>
    </>
  )
}
