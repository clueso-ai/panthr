// Small controls shared by every screen.

import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { motion } from 'motion/react'
import type { Engine, Model, Reference } from '@shared/types'
import { api, useSettings } from '@/lib/api'
import { tr, QUICK, MOVE } from '@/lib/motion'
import { Icon, type IconName } from './Icon'
import { MenuItem, MenuSep, MenuTitle, Popover } from './Popover'
import { Tip } from './Tooltip'
import { AgentMark } from './AgentMark'

/** A square icon button (26-30 pt), tinted when on. */
export function IconButton({ icon, on, size = 28, onClick, tip, keys, body, disabled, className }: {
  icon: IconName; on?: boolean; size?: number; onClick?: () => void; tip?: string; keys?: string; body?: string; disabled?: boolean; className?: string
}) {
  const b = (
    <button className={`icon-btn${on ? ' on' : ''} ${className ?? ''}`} style={{ width: size, height: size }} onClick={onClick} disabled={disabled}>
      <Icon name={icon} size={16} />
    </button>
  )
  return tip ? <Tip title={tip} keys={keys} body={body}>{b}</Tip> : b
}

export function Switch({ on, onChange, small }: { on: boolean; onChange: (v: boolean) => void; small?: boolean }) {
  return (
    <button className={`switch${on ? ' on' : ''}${small ? ' small' : ''}`} role="switch" aria-checked={on} onClick={() => onChange(!on)}>
      <motion.i layout transition={tr(MOVE)} />
    </button>
  )
}

/** A segmented choice; the chosen segment's pill slides between them. */
export function Segmented<T extends string>({ value, options, onChange, id }: { value: T; options: { value: T; label: ReactNode }[]; onChange: (v: T) => void; id: string }) {
  return (
    <div className="segmented">
      {options.map((o) => (
        <button key={o.value} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.value === value && <motion.span layoutId={`seg-${id}`} className="seg-pill" transition={tr(MOVE)} />}
          <span className="seg-label">{o.label}</span>
        </button>
      ))}
    </div>
  )
}

export interface ComposerHandle {
  focus(): void
  set(text: string): void
  value(): string
}

/** The message box: words wrap and it grows with them (up to a limit,
 *  then scrolls). Enter sends, Shift-Enter makes a new line. Typing @
 *  offers the reference videos (`mentions`); Enter or Tab puts one in. */
export const Composer = forwardRef<ComposerHandle, {
  placeholder: string; onSubmit: (text: string) => void; maxRows?: number; className?: string; autoFocus?: boolean; onChange?: (t: string) => void
  mentions?: Reference[]
}>(function Composer({ placeholder, onSubmit, maxRows = 10, className, autoFocus, onChange, mentions }, ref) {
  const el = useRef<HTMLTextAreaElement>(null)
  const [text, setText] = useState('')
  /** The @-query before the caret (null: no menu), and the row chosen. */
  const [q, setQ] = useState<{ at: number; query: string } | null>(null)
  const [sel, setSel] = useState(0)
  const fit = (): void => {
    const t = el.current
    if (!t) return
    t.style.height = '0px'
    const line = parseFloat(getComputedStyle(t).lineHeight) || 20
    t.style.height = `${Math.min(t.scrollHeight, line * maxRows)}px`
  }
  useLayoutEffect(fit, [text])
  const put = (s: string, caret = s.length): void => {
    setText(s)
    onChange?.(s)
    requestAnimationFrame(() => {
      el.current?.focus()
      el.current?.setSelectionRange(caret, caret)
    })
  }
  useImperativeHandle(ref, () => ({
    focus: () => el.current?.focus(),
    set: (s: string) => put(s),
    value: () => text
  }))
  /** Is the caret right after an @word? */
  const look = (value: string, caret: number): void => {
    if (!mentions) return
    const m = /(^|[^\w@])@([a-z0-9_-]*)$/i.exec(value.slice(0, caret))
    if (m) {
      setQ({ at: caret - m[2].length - 1, query: m[2].toLowerCase() })
      setSel(0)
    } else setQ(null)
  }
  const options = (mentions ?? [])
    .filter((r) => !q || r.handle.includes(q.query) || r.name.toLowerCase().includes(q.query))
    .sort((a, b) => Number(b.status === 'ready') - Number(a.status === 'ready'))
    .slice(0, 8)
  const choose = (r: Reference): void => {
    if (!q || r.status !== 'ready') return
    const caret = el.current?.selectionStart ?? text.length
    const next = `${text.slice(0, q.at)}@${r.handle} ${text.slice(caret)}`
    setQ(null)
    put(next, q.at + r.handle.length + 2)
  }
  const open = !!q && !!mentions
  return (
    <>
      <textarea
        ref={el}
        className={`composer-input ${className ?? ''}`}
        rows={1}
        value={text}
        placeholder={placeholder}
        autoFocus={autoFocus}
        spellCheck
        onChange={(e) => {
          setText(e.target.value)
          onChange?.(e.target.value)
          look(e.target.value, e.target.selectionStart)
        }}
        onClick={(e) => look(text, (e.target as HTMLTextAreaElement).selectionStart)}
        onBlur={() => setTimeout(() => setQ(null), 120)}
        onKeyDown={(e) => {
          if (open) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault()
              const n = options.length || 1
              setSel((s) => (s + (e.key === 'ArrowDown' ? 1 : -1) + n) % n)
              return
            }
            if ((e.key === 'Enter' || e.key === 'Tab') && options[sel]) {
              e.preventDefault()
              choose(options[sel])
              return
            }
            if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              setQ(null)
              return
            }
          }
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            const v = text.trim()
            if (!v) return
            setText('')
            onChange?.('')
            onSubmit(v)
          }
        }}
      />
      <Popover anchor={el} open={open} onClose={() => setQ(null)} side="top" align="start" width={320} gap={10}>
        <div className="menu mention-menu">
          <MenuTitle>Reference videos</MenuTitle>
          {options.length === 0 && <div className="mention-empty">{mentions?.length ? 'No reference by that name' : 'No references yet. Add one in Library \u203a References, or drop a video on the window.'}</div>}
          {options.map((r, i) => (
            <button key={r.id} className={`mention-row${i === sel ? ' on' : ''}${r.status !== 'ready' ? ' busy' : ''}`} onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => setSel(i)} onClick={() => choose(r)}>
              <RefThumb r={r} />
              <span className="mention-words">
                <b className="ellipsis">{r.name}</b>
                <span className="ellipsis">{r.status === 'ready' ? `@${r.handle}${r.summary ? ` \u00b7 ${r.summary}` : ''}` : r.status === 'failed' ? 'Could not deconstruct it' : r.step ?? 'Deconstructing\u2026'}</span>
              </span>
            </button>
          ))}
        </div>
      </Popover>
    </>
  )
})

/** A reference's poster, small. */
export function RefThumb({ r, size = 'sm' }: { r: Reference; size?: 'sm' | 'lg' }) {
  const [src, setSrc] = useState<string | null>(null)
  useLayoutEffect(() => {
    if (r.poster) api.app.fileUrl(r.poster).then(setSrc)
  }, [r.poster])
  return <span className={`ref-thumb ${size}`}>{src ? <img src={src} alt="" draggable={false} /> : null}</span>
}

const CLAUDE_FALLBACK: Model[] = [
  { id: 'default', name: 'Default' },
  { id: 'opus', name: 'Opus' },
  { id: 'sonnet', name: 'Sonnet' },
  { id: 'haiku', name: 'Haiku' }
]

/** The agent-and-model chip: a mark for the agent (spark: Claude Code,
 *  prompt: Codex) and the model. Its menu lists one agent's models; the
 *  other agent is one row that swaps the list (crossfading). */
export function ModelChip({ engine, model, onPick, locked, agents, onAgents }: {
  engine: Engine
  model: string
  onPick: (engine: Engine, model: string) => void
  /** The chat has begun: switching agent needs a new chat. */
  locked?: boolean
  agents?: boolean
  onAgents?: (on: boolean) => void
}) {
  const anchor = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [shown, setShown] = useState<Engine>(engine)
  const [models, setModels] = useState<Record<Engine, Model[]>>({ claude: CLAUDE_FALLBACK, codex: [{ id: 'default', name: 'Default' }] })
  useLayoutEffect(() => {
    if (!open) return
    setShown(engine)
    for (const e of ['claude', 'codex'] as Engine[]) {
      api.chats.models(e).then((m) => m?.length && setModels((x) => ({ ...x, [e]: m }))).catch(() => {})
    }
  }, [open, engine])
  const list = models[engine]
  const name = list.find((m) => m.id === model)?.name ?? model
  const label = name === 'Default' || model === 'default' ? (engine === 'codex' ? 'Codex' : 'Claude') : name
  const other: Engine = shown === 'codex' ? 'claude' : 'codex'
  const off = locked && other !== engine
  const title = (e: Engine): string => (e === 'codex' ? 'Codex' : 'Claude Code')
  return (
    <>
      <Tip title={title(engine)} body="The agent and model for this project.">
        <button ref={anchor} className={`chip model-chip${open ? ' open' : ''}`} onClick={() => setOpen((o) => !o)}>
          <AgentMark engine={engine} size={15} />
          <span>{label}</span>
          <Icon name="chevron" size={12} className="faint" />
        </button>
      </Tip>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} side="top" align="end" width={236}>
        <div className="menu">
          <motion.div key={shown} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={tr(QUICK)}>
            <MenuTitle>
              <AgentMark engine={shown} size={12} /> {title(shown)}
            </MenuTitle>
            {models[shown].map((m) => (
              <MenuItem key={m.id} label={m.name} on={shown === engine && m.id === model} onSelect={() => {
                onPick(shown, m.id)
                setOpen(false)
              }} />
            ))}
          </motion.div>
          <MenuSep />
          <MenuItem
            icon={<AgentMark engine={other} size={14} />}
            label={title(other)}
            disabled={off}
            trailing={off ? <span className="menu-hint">New chat to switch</span> : <Icon name="chevron-right" size={12} className="faint" />}
            onSelect={() => setShown(other)}
          />
          {shown === 'claude' && engine === 'claude' && onAgents && (
            <>
              <MenuSep />
              <div className="menu-item" onMouseDown={(e) => e.preventDefault()} onClick={() => onAgents(!agents)}>
                <span className="menu-check"><Icon name="agents" size={14} /></span>
                <span className="menu-label">Helper agents</span>
                <Switch on={!!agents} onChange={onAgents} small />
              </div>
            </>
          )}
        </div>
      </Popover>
    </>
  )
}

/** Settings' defaults for a new project's agent and model. */
export function useDefaultModel(): { engine: Engine; model: string } {
  const s = useSettings()
  return { engine: s.agent, model: s.agent === 'codex' ? s.codex_model : s.model }
}
