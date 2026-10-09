// Settings (⌘,): a sheet over the window. Sections on the left, one at a
// time on the right; every change is saved as it is made.

import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { Host, HostCheck, Model, Settings as S, Skill, SkillHit, SkillsState } from '@shared/types'
import { api, useEvent, useSettings } from '@/lib/api'
import { rise, tr, MOVE, QUICK, SETTLE } from '@/lib/motion'
import { Icon, type IconName } from '@/ui/Icon'
import { frostAlpha, IconButton, Segmented, Slider, Switch } from '@/ui/Controls'
import { MenuItem, Popover } from '@/ui/Popover'
import { EyeMark } from '@/ui/Eye'
import { ByClueso } from '@/ui/CluesoMark'
import { AgentMark } from '@/ui/AgentMark'
import './settings.css'

export type Pane = 'general' | 'agents' | 'skills' | 'hosts' | 'editor' | 'export' | 'about'
const PANES: [Pane, string, IconName][] = [
  ['general', 'General', 'settings'],
  ['agents', 'Agents', 'agents'],
  ['skills', 'Skills', 'library'],
  ['hosts', 'Hosts', 'cloud'],
  ['editor', 'Editor', 'layers'],
  ['export', 'Export', 'export'],
  ['about', 'About', 'note']
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

function Row({ title, body, children, mark }: { title: string; body?: string; children: React.ReactNode; mark?: 'claude' | 'codex' }) {
  return (
    <div className="row">
      {mark && <span className="row-mark"><AgentMark engine={mark} size={18} /></span>}
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
          <Slider
            label="Frost"
            value={s.frost}
            left="Solid"
            right="Clear"
            width={240}
            onInput={(v) => {
              // Follow the finger at once; the eased change is for the saved value.
              const root = document.documentElement
              root.dataset.dragging = 'frost'
              root.style.setProperty('--frost', String(frostAlpha(v)))
            }}
            onChange={(v) => {
              delete document.documentElement.dataset.dragging
              set({ frost: v })
            }}
          />
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
          <Segmented id="agent" value={s.agent} onChange={(v) => set({ agent: v })} options={[{ value: 'claude', label: <span className="seg-mark"><AgentMark engine="claude" size={13} />Claude Code</span> }, { value: 'codex', label: <span className="seg-mark"><AgentMark engine="codex" size={13} />Codex</span> }]} />
        </Row>
      </Card>
      <Card title="Default models">
        <Row title="Claude Code" body="Default is what Claude Code is set to." mark="claude"><ModelMenu engine="claude" value={s.model} onChange={(v) => set({ model: v })} /></Row>
        <Row title="Codex" body="Default is what Codex is set to." mark="codex"><ModelMenu engine="codex" value={s.codex_model} onChange={(v) => set({ codex_model: v })} /></Row>
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
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<SkillHit[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [asked, setAsked] = useState<Set<string>>(new Set())
  const [making, setMaking] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    api.skills.state().then(setSt)
  }, [])
  useEvent('skills:state', setSt)
  // skills.sh, a moment after typing stops.
  useEffect(() => {
    const query = q.trim()
    if (query.length < 2) {
      setHits(null)
      return
    }
    setSearching(true)
    const id = setTimeout(() => {
      api.skills.search(query).then(setHits).catch((e) => setErr(String(e.message ?? e))).finally(() => setSearching(false))
    }, 300)
    return () => clearTimeout(id)
  }, [q])
  if (!st) return null
  const query = q.trim().toLowerCase()
  const mine = st.skills.filter((k) => !query || k.name.includes(query) || k.description.toLowerCase().includes(query))
  const groups: [string, string, Skill[]][] = []
  const yours = mine.filter((k) => k.origin === 'yours')
  if (yours.length) groups.push(['yours', 'Yours', yours])
  for (const origin of ['builtin', 'added'] as const) {
    const byPack = new Map<string, Skill[]>()
    for (const k of mine.filter((x) => x.origin === origin)) byPack.set(k.pack ?? '', [...(byPack.get(k.pack ?? '') ?? []), k])
    for (const [pack, ks] of byPack) groups.push([`${origin}:${pack}`, `${origin === 'builtin' ? 'Built in' : 'Added'} \u00b7 ${st.packs.find((p) => p.source === pack)?.title || pack}`, ks])
  }
  return (
    <>
      <p className="pane-lede">Skills teach the agents a craft. Every project gets the ones switched on, for Claude Code and Codex alike. Find more on skills.sh, write your own, or bring a folder of them.</p>
      <div className="skills-bar">
        <input className="text-input skills-search" placeholder="Search your skills and skills.sh" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="btn" onClick={() => setMaking((m) => !m)}><Icon name="plus" size={13} /> New skill</button>
        <button className="btn" onClick={async () => {
          const d = await api.app.chooseFolder()
          if (!d) return
          try {
            await api.skills.importFolder(d)
            setErr(null)
          } catch (e) {
            setErr((e as Error).message)
          }
        }}><Icon name="folder" size={13} /> Import a folder</button>
      </div>
      <AnimatePresence initial={false}>
        {making && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={tr(MOVE)} style={{ overflow: 'hidden' }}>
            <NewSkill onDone={(name) => {
              setMaking(false)
              if (name) setOpen(name)
            }} />
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {(st.running || st.waiting.length > 0) && (
          <motion.div className="job-line" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={tr(MOVE)}>
            <span className="shine" data-text={`Installing ${st.running ?? ''}`}>Installing {st.running}</span>
            {st.waiting.length > 0 && <span className="faint"> \u00b7 {st.waiting.length} waiting</span>}
          </motion.div>
        )}
      </AnimatePresence>
      {(err || st.error) && <div className="error-line">{err ?? st.error}</div>}
      {hits !== null && (
        <Card title={searching ? 'On skills.sh \u2026' : `On skills.sh \u00b7 ${hits.length}`}>
          {hits.length === 0 && !searching && <div className="row faint">Nothing there for \u201c{q.trim()}\u201d.</div>}
          {hits.slice(0, 12).map((h) => {
            const busy = asked.has(h.id)
            return (
              <Row key={h.id} title={h.name} body={`${h.source} \u00b7 ${h.installs.toLocaleString()} installs`}>
                {h.installed ? <span className="faint">Added</span> : (
                  <button className="btn small" disabled={busy} onClick={() => {
                    setAsked((a) => new Set(a).add(h.id))
                    api.skills.addOne(h.source, h.name)
                  }}>{busy ? 'Installing\u2026' : 'Add'}</button>
                )}
              </Row>
            )
          })}
        </Card>
      )}
      {groups.map(([key, title, ks]) => {
        const pack = key.includes(':') ? key.split(':').slice(1).join(':') : null
        return (
          <Card key={key} title={title}>
            {ks.map((k) => (
              <div key={k.name} className="row skill-row">
                <button className="row-words skill-open" onClick={() => setOpen(k.name)}>
                  <b>{k.name}</b>
                  {k.description && <span className="clamp2">{k.description}</span>}
                </button>
                <div className="row-control"><Switch on={k.on} onChange={(v) => api.skills.setOn(k.name, v)} small /></div>
              </div>
            ))}
            {pack && <div className="card-foot"><span className="faint mono">{pack}</span><button className="link danger" onClick={() => api.skills.remove(pack)}>Remove pack</button></div>}
          </Card>
        )
      })}
      {query && !groups.length && hits === null && <p className="pane-note">No skill here matches \u201c{q.trim()}\u201d.</p>}
      <SkillSheet name={open} onClose={() => setOpen(null)} />
    </>
  )
}

function NewSkill({ onDone }: { onDone(name: string | null): void }) {
  const [name, setName] = useState('')
  const [when, setWhen] = useState('')
  const [body, setBody] = useState('')
  const [err, setErr] = useState<string | null>(null)
  return (
    <div className="card-group">
      <div className="card new-skill">
        <input className="text-input" placeholder="Name (Brand voice)" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        <input className="text-input" placeholder="When the agent should use it (Use for any captions or on-screen copy)" value={when} onChange={(e) => setWhen(e.target.value)} />
        <textarea className="text-input skill-body" placeholder={'What it says. Markdown: rules, examples, colours, fonts, anything the agent should follow.'} value={body} onChange={(e) => setBody(e.target.value)} />
        {err && <div className="error-line">{err}</div>}
        <div className="new-skill-row">
          <button className="btn ghost" onClick={() => onDone(null)}>Cancel</button>
          <button className="btn primary" disabled={!name.trim() || !when.trim()} onClick={async () => {
            try {
              onDone(await api.skills.create(name, when, body))
            } catch (e) {
              setErr((e as Error).message)
            }
          }}>Add skill</button>
        </div>
      </div>
    </div>
  )
}

/** A skill opened: its SKILL.md (editable when it is yours). */
function SkillSheet({ name, onClose }: { name: string | null; onClose(): void }) {
  const [doc, setDoc] = useState<{ text: string; dir: string; editable: boolean } | null>(null)
  const [draft, setDraft] = useState('')
  const [saved, setSaved] = useState(true)
  const [confirm, setConfirm] = useState(false)
  useEffect(() => {
    setDoc(null)
    setConfirm(false)
    if (name) api.skills.read(name).then((d) => {
      setDoc(d)
      setDraft(d.text)
      setSaved(true)
    })
  }, [name])
  return (
    <AnimatePresence>
      {name && doc && (
        <motion.div className="skill-sheet" initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 12 }} transition={tr(MOVE)}>
          <div className="skill-sheet-top">
            <b className="ellipsis">{name}</b>
            <span className="spacer" />
            <IconButton icon="folder" tip="Show in Finder" onClick={() => api.app.reveal(doc.dir)} />
            {doc.editable && (confirm ? (
              <span className="ref-confirm">Delete it? <button className="btn small danger" onClick={async () => {
                await api.skills.removeOwn(name)
                onClose()
              }}>Delete</button><button className="btn small ghost" onClick={() => setConfirm(false)}>Keep</button></span>
            ) : <IconButton icon="trash" tip="Delete this skill" onClick={() => setConfirm(true)} />)}
            <IconButton icon="close" tip="Close" onClick={onClose} />
          </div>
          {doc.editable ? (
            <>
              <textarea className="viewer-pre skill-edit" value={draft} onChange={(e) => {
                setDraft(e.target.value)
                setSaved(false)
              }} />
              <div className="new-skill-row">
                <span className="faint">{saved ? 'Saved' : 'Not saved'}</span>
                <button className="btn primary small" disabled={saved} onClick={async () => {
                  await api.skills.write(name, draft)
                  setSaved(true)
                }}>Save</button>
              </div>
            </>
          ) : (
            <pre className="viewer-pre skill-read">{doc.text}</pre>
          )}
        </motion.div>
      )}
    </AnimatePresence>
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

function CommandLine() {
  const [st, setSt] = useState<{ path: string; onPath: boolean; installed: boolean } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    api.app.cliStatus().then(setSt)
  }, [])
  return (
    <Card title="Command line">
      <Row title="panthr" body={st?.installed ? (st.onPath ? `Installed at ${st.path}` : `Installed at ${st.path}; add ~/.local/bin to your PATH to use it.`) : 'Drive Panthr from a terminal, a script, or another agent.'}>
        <button className="btn small" onClick={async () => {
          try {
            setSt(await api.app.installCli())
            setErr(null)
          } catch (e) {
            setErr((e as Error).message)
          }
        }}>{st?.installed ? 'Reinstall' : 'Install'}</button>
      </Row>
      {err && <div className="error-line">{err}</div>}
      <pre className="cli-example">{'panthr new "A 15-second logo reveal" --wait\npanthr chat "Make the title bigger" --wait\npanthr export --wait\npanthr help'}</pre>
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
      <div className="about-mark"><EyeMark width={64} /><div><div className="wordmark">Panthr</div><ByClueso height={12} /><div className="faint about-line">Make videos by talking to an agent.</div></div></div>
      <Card title="On this Mac">
        {missing === null ? <Row title="Checking tools…"><span /></Row> : missing.length === 0 ? (
          <Row title="Everything is installed" body="Claude Code or Codex, Node, npx and ffmpeg were found."><span className="ok">✓</span></Row>
        ) : missing.map((m) => (
          <Row key={m} title={`${m === 'claude' ? 'Claude Code' : m} is missing`} body={m === 'claude' ? 'curl -fsSL https://claude.ai/install.sh | bash' : `brew install ${m === 'npx' ? 'node' : m}`}><span className="bad">×</span></Row>
        ))}
      </Card>
      <CommandLine />
    </>
  )
}
