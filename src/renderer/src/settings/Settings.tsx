// Settings (⌘,): a sheet over the window. Sections on the left, one at a
// time on the right; every change is saved as it is made.

import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { Host, HostCheck, Model, Settings as S, SkillsState } from '@shared/types'
import { api, useEvent, useSettings } from '@/lib/api'
import { rise, tr, MOVE, QUICK, SETTLE } from '@/lib/motion'
import { Icon, type IconName } from '@/ui/Icon'
import { IconButton, Segmented, Switch } from '@/ui/Controls'
import { MenuItem, Popover } from '@/ui/Popover'
import { EyeMark } from '@/ui/Eye'
import './settings.css'

export type Pane = 'general' | 'agents' | 'skills' | 'hosts' | 'editor' | 'export' | 'about'
const PANES: [Pane, string, IconName][] = [
  ['general', 'General', 'settings'],
  ['agents', 'Agents', 'spark'],
  ['skills', 'Skills', 'library'],
  ['hosts', 'Hosts', 'cloud'],
  ['editor', 'Editor', 'layers'],
  ['export', 'Export', 'export'],
  ['about', 'About', 'agents']
]

export function Settings({ open, pane, onPane, onClose }: { open: boolean; pane: Pane; onPane(p: Pane): void; onClose(): void }) {
  useEffect(() => {
    if (!open) return
    const k = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    addEventListener('keydown', k)
    return () => removeEventListener('keydown', k)
  }, [open, onClose])
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="sheet-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={tr(MOVE)} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
          <motion.div className="sheet" initial={{ opacity: 0, y: 16, scale: 0.985 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 8, scale: 0.99 }} transition={tr(SETTLE)}>
            <nav className="sheet-nav">
              <div className="sheet-title">Settings</div>
              {PANES.map(([p, name, icon]) => (
                <button key={p} className={pane === p ? 'on' : ''} onClick={() => onPane(p)}>
                  {pane === p && <motion.span layoutId="nav-bg" className="nav-bg" transition={tr(MOVE)} />}
                  <Icon name={icon} size={15} />
                  <span>{name}</span>
                </button>
              ))}
            </nav>
            <div className="sheet-body">
              <div className="sheet-close"><IconButton icon="close" tip="Close" keys="Esc" onClick={onClose} /></div>
              <AnimatePresence mode="wait" initial={false}>
                <motion.div key={pane} className="sheet-pane" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={tr(QUICK)}>
                  <h2>{PANES.find((x) => x[0] === pane)![1]}</h2>
                  {pane === 'general' && <General />}
                  {pane === 'agents' && <Agents />}
                  {pane === 'skills' && <Skills />}
                  {pane === 'hosts' && <Hosts />}
                  {pane === 'editor' && <EditorPane />}
                  {pane === 'export' && <ExportPane />}
                  {pane === 'about' && <About />}
                </motion.div>
              </AnimatePresence>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

const set = (patch: Partial<S>): void => {
  api.settings.set(patch)
}

function Row({ title, body, children }: { title: string; body?: string; children: React.ReactNode }) {
  return (
    <div className="row">
      <div className="row-words"><b>{title}</b>{body && <span>{body}</span>}</div>
      <div className="row-control">{children}</div>
    </div>
  )
}
const Card = ({ children, title }: { children: React.ReactNode; title?: string }) => (
  <div className="card-group">
    {title && <div className="card-title">{title}</div>}
    <div className="card">{children}</div>
  </div>
)

function General() {
  const s = useSettings()
  return (
    <>
      <Card title="Look">
        <Row title="Theme" body="System follows macOS.">
          <Segmented id="theme" value={s.appearance} onChange={(v) => set({ appearance: v })} options={[{ value: 'system', label: 'System' }, { value: 'night', label: 'Night' }, { value: 'day', label: 'Day' }]} />
        </Row>
        <Row title="Frost" body="How much of the desktop shows through.">
          <Segmented id="frost" value={s.frost} onChange={(v) => set({ frost: v })} options={[{ value: 'solid', label: 'Solid' }, { value: 'light', label: 'Light' }, { value: 'medium', label: 'Medium' }, { value: 'strong', label: 'Strong' }]} />
        </Row>
      </Card>
      <Card title="Motion">
        <Row title="Reduce motion" body="Changes happen at once instead of easing."><Switch on={s.reduce_motion} onChange={(v) => set({ reduce_motion: v })} /></Row>
      </Card>
    </>
  )
}

function ModelMenu({ engine, value, onChange }: { engine: 'claude' | 'codex'; value: string; onChange(v: string): void }) {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [models, setModels] = useState<Model[]>([])
  useEffect(() => {
    api.chats.models(engine).then(setModels)
  }, [engine])
  const name = models.find((m) => m.id === value)?.name ?? value
  return (
    <>
      <button ref={anchor} className="select" onClick={() => setOpen((o) => !o)}>
        <span>{name}</span><Icon name="chevron" size={12} />
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} align="end" width={200}>
        <div className="menu">
          {models.map((m) => <MenuItem key={m.id} label={m.name} on={m.id === value} onSelect={() => {
            onChange(m.id)
            setOpen(false)
          }} />)}
        </div>
      </Popover>
    </>
  )
}

function Agents() {
  const s = useSettings()
  return (
    <>
      <Card>
        <Row title="New chats use" body="Whichever is signed in on this Mac.">
          <Segmented id="agent" value={s.agent} onChange={(v) => set({ agent: v })} options={[{ value: 'claude', label: 'Claude Code' }, { value: 'codex', label: 'Codex' }]} />
        </Row>
      </Card>
      <Card title="Default models">
        <Row title="Claude Code" body="Default is what Claude Code is set to."><ModelMenu engine="claude" value={s.model} onChange={(v) => set({ model: v })} /></Row>
        <Row title="Codex" body="Default is what Codex is set to."><ModelMenu engine="codex" value={s.codex_model} onChange={(v) => set({ codex_model: v })} /></Row>
      </Card>
      <Card>
        <Row title="Helper agents" body="New projects start with them. Better results on big jobs; more time and cost."><Switch on={s.agents_default} onChange={(v) => set({ agents_default: v })} /></Row>
      </Card>
      <p className="pane-note">Each project can pick its own model from the chip in its chat box.</p>
    </>
  )
}

function Skills() {
  const [st, setSt] = useState<SkillsState | null>(null)
  const [src, setSrc] = useState('')
  useEffect(() => {
    api.skills.state().then(setSt)
  }, [])
  useEvent('skills:state', setSt)
  if (!st) return null
  const byPack = new Map<string, typeof st.skills>()
  for (const k of st.skills) byPack.set(k.pack ?? 'Other', [...(byPack.get(k.pack ?? 'Other') ?? []), k])
  return (
    <>
      <p className="pane-lede">Skills teach the agents a craft. Panthr starts with a set for video and motion; add any from skills.sh or GitHub. Every project gets them, for Claude Code and Codex alike.</p>
      <Card>
        <div className="add-row">
          <input className="text-input" placeholder="owner/repo, a GitHub URL, or a skills.sh name" value={src} onChange={(e) => setSrc(e.target.value)} onKeyDown={(e) => {
            if (e.key === 'Enter' && src.trim()) {
              api.skills.add(src.trim())
              setSrc('')
            }
          }} />
          <button className="btn" disabled={!src.trim()} onClick={() => {
            api.skills.add(src.trim())
            setSrc('')
          }}>Add</button>
        </div>
        <AnimatePresence>
          {(st.running || st.waiting.length > 0) && (
            <motion.div className="job-line" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={tr(MOVE)}>
              <span className="shine" data-text={`Installing ${st.running ?? ''}`}>Installing {st.running}</span>
              {st.waiting.length > 0 && <span className="faint"> · {st.waiting.length} waiting</span>}
            </motion.div>
          )}
        </AnimatePresence>
        {st.error && <div className="error-line">{st.error}</div>}
      </Card>
      {[...byPack.entries()].map(([pack, skills]) => {
        const p = st.packs.find((x) => x.source === pack)
        return (
          <Card key={pack} title={p?.title || pack}>
            {skills.map((k) => (
              <Row key={k.name} title={k.name} body={k.description}><Switch on={k.on} onChange={(v) => api.skills.setOn(k.name, v)} small /></Row>
            ))}
            {p && <div className="card-foot"><span className="faint mono">{p.source}</span><button className="link danger" onClick={() => api.skills.remove(p.source)}>Remove</button></div>}
          </Card>
        )
      })}
    </>
  )
}

function Hosts() {
  const [hosts, setHosts] = useState<Host[]>([])
  const [checks, setChecks] = useState<Record<string, HostCheck | 'checking'>>({})
  const [draft, setDraft] = useState({ name: '', target: '', root: '~/Panthr' })
  useEffect(() => {
    api.hosts.list().then(setHosts)
  }, [])
  const save = (h: Host[]): void => {
    setHosts(h)
    api.hosts.save(h)
  }
  const check = async (h: Host): Promise<void> => {
    setChecks((c) => ({ ...c, [h.name]: 'checking' }))
    const r = await api.hosts.check(h)
    setChecks((c) => ({ ...c, [h.name]: r }))
  }
  return (
    <>
      <p className="pane-lede">A host is another machine where projects live and run: the agent, the page and renders all run there, while you work here. Use an SSH alias from ~/.ssh/config or user@host; keys must already work without a password.</p>
      {hosts.map((h) => {
        const c = checks[h.name]
        return (
          <motion.div key={h.name} {...rise(6, MOVE)}>
            <Card>
              <Row title={h.name} body={`${h.target} · ${h.root}`}>
                <button className="btn small" onClick={() => check(h)}>{c === 'checking' ? 'Checking…' : 'Check'}</button>
                <button className="btn small ghost danger" onClick={() => save(hosts.filter((x) => x.name !== h.name))}>Remove</button>
              </Row>
              {c && c !== 'checking' && (
                <div className="check-line">
                  {c.ok ? <span className="ok">Reachable</span> : <span className="bad">{c.error}</span>}
                  {c.tools.map(([t, has]) => <span key={t} className={has ? 'tool ok' : 'tool bad'}>{has ? '✓' : '×'} {t}</span>)}
                </div>
              )}
            </Card>
          </motion.div>
        )
      })}
      <Card title="Add a host">
        <div className="host-form">
          <input className="text-input" placeholder="Name (Studio box)" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <input className="text-input" placeholder="SSH target (alias or user@host)" value={draft.target} onChange={(e) => setDraft({ ...draft, target: e.target.value })} />
          <input className="text-input" placeholder="Folder there" value={draft.root} onChange={(e) => setDraft({ ...draft, root: e.target.value })} />
          <button className="btn primary" disabled={!draft.name.trim() || !draft.target.trim() || hosts.some((h) => h.name === draft.name.trim())} onClick={() => {
            const h = { name: draft.name.trim(), target: draft.target.trim(), root: draft.root.trim() || '~/Panthr' }
            save([...hosts, h])
            setDraft({ name: '', target: '', root: '~/Panthr' })
            check(h)
          }}>Add host</button>
        </div>
      </Card>
    </>
  )
}

function EditorPane() {
  const s = useSettings()
  return (
    <Card>
      <Row title="Skimming" body="The picture follows the pointer over the timeline."><Switch on={s.skimming} onChange={(v) => set({ skimming: v })} /></Row>
      <Row title="Frames under the timeline" body="Pictures along the track, made after each change."><Switch on={s.filmstrip} onChange={(v) => set({ filmstrip: v })} /></Row>
    </Card>
  )
}

function ExportPane() {
  const s = useSettings()
  return (
    <Card>
      <Row title="Quality" body="Draft to check; High for the final video.">
        <Segmented id="q" value={s.export_quality} onChange={(v) => set({ export_quality: v })} options={[{ value: 'draft', label: 'Draft' }, { value: 'standard', label: 'Standard' }, { value: 'high', label: 'High' }]} />
      </Row>
      <Row title="Frame rate" body="60 is smoother and slower to export.">
        <Segmented id="fps" value={String(s.export_fps) as '24' | '30' | '60'} onChange={(v) => set({ export_fps: Number(v) })} options={[{ value: '24', label: '24' }, { value: '30', label: '30' }, { value: '60', label: '60' }]} />
      </Row>
    </Card>
  )
}

function About() {
  const [missing, setMissing] = useState<string[] | null>(null)
  useEffect(() => {
    api.app.missingTools().then(setMissing)
  }, [])
  return (
    <>
      <div className="about-mark"><EyeMark width={64} /><div><div className="wordmark">Panthr</div><div className="faint">Make videos by talking to an agent.</div></div></div>
      <Card title="On this Mac">
        {missing === null ? <Row title="Checking tools…"><span /></Row> : missing.length === 0 ? (
          <Row title="Everything is installed" body="Claude Code or Codex, Node, npx and ffmpeg were found."><span className="ok">✓</span></Row>
        ) : missing.map((m) => (
          <Row key={m} title={`${m === 'claude' ? 'Claude Code' : m} is missing`} body={m === 'claude' ? 'curl -fsSL https://claude.ai/install.sh | bash' : `brew install ${m === 'npx' ? 'node' : m}`}><span className="bad">×</span></Row>
        ))}
      </Card>
    </>
  )
}
