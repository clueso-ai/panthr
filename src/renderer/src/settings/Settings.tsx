// Settings (⌘,): a sheet over the window. Sections on the left, one at a
// time on the right; every change is saved as it is made.

import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { ConnectionStatus, Engine, Host, HostCheck, Model, Settings as S, Skill, SkillHit, SkillsState } from '@shared/types'
import { api, useEvent, useSettings } from '@/lib/api'
import { rise, tr, MOVE, QUICK, SETTLE } from '@/lib/motion'
import { Icon, type IconName } from '@/ui/Icon'
import { frostAlpha, IconButton, Segmented, Slider, Switch } from '@/ui/Controls'
import { MenuItem, Popover } from '@/ui/Popover'
import { Mark } from '@/ui/Mark'
import { AccountDot, UsageBar, resetsIn, useAccounts } from '@/ui/Accounts'
import { ByClueso } from '@/ui/CluesoMark'
import { setAppearance } from '@/ui/ThemeToggle'
import { AgentMark } from '@/ui/AgentMark'
import './settings.css'

export type Pane = 'general' | 'agents' | 'skills' | 'connections' | 'hosts' | 'editor' | 'export' | 'about'
const PANES: [Pane, string, IconName][] = [
  ['general', 'General', 'settings'],
  ['agents', 'Agents', 'agents'],
  ['skills', 'Skills', 'library'],
  ['connections', 'Connections', 'server'],
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
                  {pane === 'connections' && <Connections />}
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
          <Segmented id="theme" value={s.appearance} onChange={(v) => setAppearance(v)} options={[{ value: 'system', label: 'System' }, { value: 'night', label: 'Night' }, { value: 'day', label: 'Day' }]} />
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
      <AgentAccounts engine="claude" />
      <AgentAccounts engine="codex" />
      <Failover />
      <Card title="Default models">
        <Row title="Claude Code" body="Default is what Claude Code is set to." mark="claude"><ModelMenu engine="claude" value={s.model} onChange={(v) => set({ model: v })} /></Row>
        <Row title="Codex" body="Default is what Codex is set to." mark="codex"><ModelMenu engine="codex" value={s.codex_model} onChange={(v) => set({ codex_model: v })} /></Row>
      </Card>
      <Card title="Reference videos">
        <Row title="Claude Code" body="Takes a reference apart. Sonnet is quick and sees well; a bigger model looks longer." mark="claude"><ModelMenu engine="claude" value={s.reference_model} onChange={(v) => set({ reference_model: v })} /></Row>
        <Row title="Codex" body="Used when new chats use Codex." mark="codex"><ModelMenu engine="codex" value={s.reference_codex_model} onChange={(v) => set({ reference_codex_model: v })} /></Row>
      </Card>
      <Card>
        <Row title="Helper agents" body="New projects start with them. Better results on big jobs; more time and cost."><Switch on={s.agents_default} onChange={(v) => set({ agents_default: v })} /></Row>
        <Row title="Self-check" body="After a turn that changed a video, Panthr checks it (text off the frame, errors, flashes, the picture going blank) and has the agent fix what it finds, once."><Switch on={s.self_check} onChange={(v) => set({ self_check: v })} /></Row>
      </Card>
      <p className="pane-note">Each project can pick its own model from the chip in its chat box.</p>
    </>
  )
}

/** Several subscriptions per agent: each signed in to its own folder; chats pick one. */
function AgentAccounts({ engine }: { engine: Engine }) {
  const s = useSettings()
  const list = useAccounts(true).filter((a) => a.engine === engine)
  const [name, setName] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<string | null>(null)
  const picked = engine === 'codex' ? s.codex_account : s.claude_account
  const fallback = engine === 'codex' ? 'codex' : 'default'
  const add = async (): Promise<void> => {
    const a = await api.accounts.add(engine, name.trim() || `Account ${list.length + 1}`)
    setName('')
    api.accounts.signIn(a.id)
  }
  return (
    <Card title={engine === 'codex' ? 'Codex accounts' : 'Claude accounts'}>
      {list.map((a) => {
        const builtIn = a.id === fallback
        return (
          <div key={a.id} className="acct">
            <div className="acct-head">
              <AccountDot color={a.color} size={10} />
              {renaming === a.id ? (
                <input className="text-input acct-rename" autoFocus defaultValue={a.label} onBlur={(e) => { api.accounts.rename(a.id, e.target.value); setRenaming(null) }} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
              ) : (
                <b title={builtIn ? undefined : 'Double-click to rename'} onDoubleClick={() => !builtIn && setRenaming(a.id)}>{a.label}</b>
              )}
              <span className="faint ellipsis">
                {a.signedIn === null ? 'Checking…' : a.signedIn ? [a.email, a.plan, a.org].filter(Boolean).join(' · ') || 'Signed in' : 'Not signed in'}
              </span>
              <span className="spacer" />
              {picked === a.id || (builtIn && !list.some((x) => x.id === picked)) ? (
                <span className="acct-default">New chats</span>
              ) : (
                a.signedIn && <button className="btn small ghost" onClick={() => api.accounts.setDefault(a.id)}>Use for new chats</button>
              )}
              {a.signedIn === false && <button className="btn small primary" onClick={() => api.accounts.signIn(a.id)}>Sign in</button>}
              {!builtIn && (confirm === a.id
                ? <button className="btn small danger" onClick={() => { setConfirm(null); api.accounts.remove(a.id) }}>Remove it</button>
                : <button className="btn small ghost danger" onClick={() => setConfirm(a.id)}>Remove</button>)}
            </div>
            {a.usage && (
              <div className="acct-usage">
                {a.usage.status === 'rejected' && <span className="acct-limit">At its limit{a.usage.resetsAt ? ` · resets ${resetsIn(a.usage.resetsAt)}` : ''}</span>}
                <UsageBar label="5 hours" w={a.usage.five_hour} />
                <UsageBar label="Week" w={a.usage.seven_day} />
              </div>
            )}
            {confirm === a.id && <div className="acct-note faint">Panthr forgets it; its sign-in stays in {a.dir}. Chats on it move to the account new chats use.</div>}
          </div>
        )
      })}
      <div className="acct-add">
        <input className="text-input" placeholder={`Name another ${engine === 'codex' ? 'Codex' : 'Claude'} account (Work, Personal…)`} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
        <button className="btn" onClick={add}>Add and sign in</button>
      </div>
    </Card>
  )
}

function Failover() {
  const s = useSettings()
  return (
    <Card>
      <Row title="Carry on when one runs out" body="When an account hits its usage limit, the chat moves to the next signed-in account of the same agent and sends your message again, its conversation brought along.">
        <Switch on={s.claude_failover} onChange={(v) => set({ claude_failover: v })} />
      </Row>
    </Card>
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
  const [show, setShow] = useState<'on' | 'off' | 'all'>('on')
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
  const onCount = st.skills.filter((k) => k.on).length
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
        <section className="skill-group">
          <div className="skill-group-head"><b>{searching ? 'On skills.sh …' : `On skills.sh · ${hits.length}`}</b></div>
          {hits.length === 0 && !searching && <p className="pane-note">Nothing there for “{q.trim()}”.</p>}
          <div className="skill-grid">
            {hits.slice(0, 12).map((h) => {
              const busy = asked.has(h.id)
              return (
                <div key={h.id} className="skill-card hit">
                  <div className="skill-card-top">
                    <Monogram name={h.name} />
                    <b className="skill-name ellipsis">{nice(h.name)}</b>
                    <span className="spacer" />
                    {h.installed ? <span className="faint skill-added">Added</span> : (
                      <button className="btn small" disabled={busy} onClick={() => {
                        setAsked((a) => new Set(a).add(h.id))
                        api.skills.addOne(h.source, h.name)
                      }}>{busy ? 'Adding…' : 'Add'}</button>
                    )}
                  </div>
                  <span className="skill-desc faint ellipsis">{h.source} · {h.installs.toLocaleString()} installs</span>
                </div>
              )
            })}
          </div>
        </section>
      )}
      {groups.length > 0 && (
        <div className="skills-filter">
          <Segmented id="skills-filter" value={query ? 'all' : show} onChange={setShow} options={[
            { value: 'on', label: <>On <span className="seg-count">{onCount}</span></> },
            { value: 'off', label: <>Off <span className="seg-count">{st.skills.length - onCount}</span></> },
            { value: 'all', label: <>All <span className="seg-count">{st.skills.length}</span></> }
          ]} />
          <span className="faint skills-filter-note">{onCount} of {st.skills.length} on, in every project</span>
        </div>
      )}
      {groups.map(([key, title, all]) => {
        const pack = key.includes(':') ? key.split(':').slice(1).join(':') : null
        const ks = query ? all : all.filter((k) => show === 'all' || (show === 'on') === k.on)
        if (!ks.length) return null
        const on = all.filter((k) => k.on).length
        return (
          <motion.section key={key} className="skill-group" layout="position" transition={tr(MOVE)}>
            <div className="skill-group-head">
              <b>{title}</b>
              <span className="faint mono">{on}/{all.length}</span>
              <span className="spacer" />
              <button className="link" onClick={() => all.forEach((k) => k.on !== (on < all.length) && api.skills.setOn(k.name, on < all.length))}>{on < all.length ? 'All on' : 'All off'}</button>
              {pack && key.startsWith('added:') && <button className="link danger" onClick={() => api.skills.remove(pack)}>Remove</button>}
            </div>
            <div className="skill-grid">
              <AnimatePresence initial={false} mode="popLayout">
                {ks.map((k) => <SkillCard key={k.name} k={k} onOpen={() => setOpen(k.name)} />)}
              </AnimatePresence>
            </div>
          </motion.section>
        )
      })}
      {!query && groups.length > 0 && show !== 'all' && groups.every(([, , all]) => all.every((k) => (show === 'on') !== k.on)) && (
        <p className="pane-note">{show === 'on' ? 'No skills are on. Switch some on under All.' : 'Every skill is on.'}</p>
      )}
      {query && !groups.length && hits === null && <p className="pane-note">No skill here matches \u201c{q.trim()}\u201d.</p>}
      <SkillSheet name={open} onClose={() => setOpen(null)} />
    </>
  )
}

/** "gsap-timeline" → "Gsap timeline". */
const nice = (name: string): string => {
  const t = name.replace(/[-_]+/g, ' ').trim()
  return t.charAt(0).toUpperCase() + t.slice(1)
}

/** A description without the "This skill should be used when…" lead-in
 *  most skills share, so the part that differs is what shows. */
const gist = (d: string): string => {
  const t = d.replace(/^\s*(this skill (should|must|can) be used|use this skill|use (it|this)|use)\s+(when(ever)?|for|if|to)\s+/i, '').replace(/^the user (asks|wants|needs) (to|for)\s+/i, 'Asked to ').trim()
  return t.charAt(0).toUpperCase() + t.slice(1)
}

/** Two letters on a tint picked from the name, so a skill is findable by eye. */
function Monogram({ name }: { name: string }) {
  const words = name.split(/[-_\s]+/).filter(Boolean)
  const letters = (words.length > 1 ? words[0][0] + words[1][0] : name.slice(0, 2)).toUpperCase()
  let h = 0
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360
  return <span className="monogram" style={{ '--h': h } as React.CSSProperties}>{letters}</span>
}

function SkillCard({ k, onOpen }: { k: Skill; onOpen(): void }) {
  return (
    <motion.div
      layout="position"
      className={`skill-card${k.on ? '' : ' off'}`}
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={tr(MOVE)}
      onClick={onOpen}
    >
      <div className="skill-card-top">
        <Monogram name={k.name} />
        <b className="skill-name ellipsis">{nice(k.name)}</b>
        <span className="spacer" />
        <div onClick={(e) => e.stopPropagation()}><Switch on={k.on} onChange={(v) => api.skills.setOn(k.name, v)} small /></div>
      </div>
      {k.description && <span className="skill-desc faint clamp2">{gist(k.description)}</span>}
    </motion.div>
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

/** What a connection is doing, in a few words. */
function connectionLine(c: ConnectionStatus, now: number): { text: string; tone: 'ok' | 'busy' | 'bad' | 'off' } {
  switch (c.phase) {
    case 'connected':
      return { text: `Connected${c.machine ? ` · ${c.machine.hostname}` : ''}`, tone: 'ok' }
    case 'connecting':
      return { text: c.step ? `${c.step}…` : 'Connecting…', tone: 'busy' }
    case 'backoff': {
      const s = c.retryAt ? Math.max(0, Math.ceil((c.retryAt - now) / 1000)) : 0
      return { text: `${c.error ?? 'Lost'} · trying again ${s ? `in ${s}s` : 'now'}`, tone: 'busy' }
    }
    case 'blocked':
      return { text: c.error ?? 'Needs you', tone: 'bad' }
    default:
      return { text: 'Off', tone: 'off' }
  }
}

function Connections() {
  const [list, setList] = useState<ConnectionStatus[]>([])
  const [ssh, setSsh] = useState<string[]>([])
  const [draft, setDraft] = useState({ label: '', target: '', root: '~/Panthr' })
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    api.connections.list().then(setList)
    api.connections.sshHosts().then(setSsh)
  }, [])
  useEvent('connections', setList)
  // A countdown while one waits to try again.
  const waiting = list.some((c) => c.phase === 'backoff')
  useEffect(() => {
    if (!waiting) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [waiting])
  const add = async (): Promise<void> => {
    setError(null)
    try {
      await api.connections.save({ label: draft.label.trim() || draft.target.trim(), kind: 'ssh', target: draft.target.trim(), root: draft.root.trim() || '~/Panthr', enabled: true })
      setDraft({ label: '', target: '', root: '~/Panthr' })
    } catch (e) {
      setError((e as Error).message)
    }
  }
  return (
    <>
      <p className="pane-lede">Use another machine from here. Its projects show on Home beside this Mac’s, and their agents, previews and exports run there. Panthr installs and starts itself there over SSH: keys must already work without a password, and the machine needs Node 18 or newer.</p>
      <Card>
        <Row title="This Mac" body="Here: always on.">
          <span className="conn-state ok"><i />Here</span>
        </Row>
      </Card>
      {list.map((c) => {
        const line = connectionLine(c, now)
        return (
          <motion.div key={c.id} {...rise(6, MOVE)}>
            <Card>
              <Row title={c.label} body={c.kind === 'ssh' ? `ssh ${c.target} · ${c.root}` : `On this Mac · ${c.root}`}>
                {(c.phase === 'backoff' || c.phase === 'blocked') && <button className="btn small" onClick={() => api.connections.retry(c.id)}>Try again</button>}
                {confirm === c.id ? (
                  <button className="btn small danger" onClick={() => { setConfirm(null); api.connections.remove(c.id) }}>Remove it</button>
                ) : (
                  <button className="btn small ghost danger" onClick={() => setConfirm(c.id)}>Remove</button>
                )}
                <Switch on={c.enabled} onChange={(v) => api.connections.setEnabled(c.id, v)} />
              </Row>
              <div className={`conn-line ${line.tone}`}><i />{line.text}</div>
              {confirm === c.id && <div className="conn-line off">Its projects stay on {c.label}; its Panthr there stops. You can connect again any time.</div>}
            </Card>
          </motion.div>
        )
      })}
      <Card title="Connect a machine">
        <div className="host-form">
          <input className="text-input" placeholder="Name (Studio box)" value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
          <input className="text-input" list="ssh-hosts" placeholder="SSH target (alias or user@host)" value={draft.target} onChange={(e) => setDraft({ ...draft, target: e.target.value })} />
          <datalist id="ssh-hosts">{ssh.map((h) => <option key={h} value={h} />)}</datalist>
          <input className="text-input" placeholder="Folder there" value={draft.root} onChange={(e) => setDraft({ ...draft, root: e.target.value })} />
          <button className="btn primary" disabled={!draft.target.trim()} onClick={add}>Connect</button>
        </div>
        {error && <div className="conn-line bad"><i />{error}</div>}
      </Card>
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
      <p className="pane-lede">The older way to use another machine (Connections is the newer one). A host is another machine where projects live and run: the agent, the page and renders all run there, while you work here. Use an SSH alias from ~/.ssh/config or user@host; keys must already work without a password.</p>
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
      <div className="about-mark"><Mark size={56} cut="var(--pane)" /><div><div className="wordmark">Panthr</div><ByClueso height={12} /><div className="faint about-line">Make videos by talking to an agent.</div></div></div>
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
