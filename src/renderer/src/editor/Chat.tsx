// A chat's transcript. While the agent works: your message, "Working for
// 12s" with a light running across it, its words as they stream (each new
// paragraph fades in) and one live row for the step under way. Once the
// turn ends it folds to "Worked for 39s · $0.47 ›" and its final reply;
// the fold opens on click.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { ChatState, Item, Step } from '@shared/types'
import { rise, tr, MOVE, QUICK } from '@/lib/motion'
import { EyeMark } from '@/ui/Eye'
import { Block, blocks } from './Markdown'

type Kind = 'command' | 'edit' | 'read' | 'search' | 'web' | 'agent' | 'plan' | 'other'
const kindOf = (name: string): Kind =>
  name === 'Bash' ? 'command'
  : ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(name) ? 'edit'
  : name === 'Read' ? 'read'
  : name === 'Glob' || name === 'Grep' ? 'search'
  : name === 'WebFetch' || name === 'WebSearch' ? 'web'
  : name === 'Task' ? 'agent'
  : name === 'TodoWrite' ? 'plan' : 'other'
const GLYPH: Record<Kind, string> = { command: '❯', edit: '✎', read: '◉', search: '⌕', web: '◎', agent: '◇', plan: '☰', other: '•' }

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** "Read 3 files and ran 2 commands, and 4 other steps": two kinds at most. */
export function summary(steps: Step[]): string {
  const order: Kind[] = ['command', 'edit', 'read', 'search', 'web', 'agent', 'plan']
  const counts = new Map<Kind, number>()
  for (const s of steps) counts.set(kindOf(s.name), (counts.get(kindOf(s.name)) ?? 0) + 1)
  const phrase = (k: Kind, n: number): string =>
    ({ command: `ran ${plural(n, 'command', 'commands')}`, edit: `changed ${plural(n, 'file', 'files')}`, read: `read ${plural(n, 'file', 'files')}`,
       search: `searched ${plural(n, 'time', 'times')}`, web: `looked on the web ${plural(n, 'time', 'times')}`, agent: `started ${plural(n, 'agent', 'agents')}`,
       plan: 'updated its plan', other: '' })[k]
  const kinds = order.filter((k) => counts.has(k))
  const shown = kinds.slice(0, 2).map((k) => phrase(k, counts.get(k)!))
  const rest = (counts.get('other') ?? 0) + kinds.slice(2).reduce((a, k) => a + counts.get(k)!, 0)
  let out = shown.join(' and ')
  if (rest) out = out ? `${out}, and ${plural(rest, 'other step', 'other steps')}` : plural(rest, 'step', 'steps')
  return out.charAt(0).toUpperCase() + out.slice(1)
}

export function duration(secs: number): string {
  const s = Math.round(Math.max(0, secs))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(s / 3600)}h ${String(Math.floor(s / 60) % 60).padStart(2, '0')}m`
}

interface Turn { user: number | null; from: number; to: number }
function turns(items: Item[]): Turn[] {
  const out: Turn[] = []
  let start = 0
  let user: number | null = null
  items.forEach((it, i) => {
    if ('User' in it) {
      if (i > start || user !== null) out.push({ user, from: start, to: i })
      user = i
      start = i + 1
    }
  })
  out.push({ user, from: start, to: items.length })
  return out
}

/** The working line: a light passes across the words. */
function Shine({ text }: { text: string }) {
  return <span className="shine" data-text={text}>{text}</span>
}

function useTicker(on: boolean): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!on) return
    const id = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(id)
  }, [on])
  return now
}

export function Chat({ chat }: { chat: ChatState }) {
  const scroller = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const [unfolded, setUnfolded] = useState<Set<number>>(new Set())
  const [full, setFull] = useState<Set<number>>(new Set())
  const [away, setAway] = useState(false)
  const now = useTicker(chat.working)
  const opened = useRef(chat.items.length)

  // Stick to the bottom while new things arrive, unless the user scrolled up.
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && follow.current) el.scrollTop = el.scrollHeight
  })
  const onScroll = (): void => {
    const el = scroller.current!
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    follow.current = atBottom
    setAway(!atBottom)
  }

  const all = turns(chat.items)
  const last = all.length - 1
  if (chat.items.length === 0) {
    return (
      <div className="chat-empty">
        <motion.div {...rise(8, MOVE)}>
          <div className="chat-empty-title">New chat</div>
          <div className="chat-empty-body">Ask for a change to this video, or click something in it first to ask about just that.</div>
        </motion.div>
      </div>
    )
  }
  return (
    <div className="chat-wrap">
      <div className="chat" ref={scroller} onScroll={onScroll}>
        {all.map((turn, ti) => {
          const active = chat.working && ti === last
          const body = chat.items.slice(turn.from, turn.to)
          const meta = body.find((x): x is Extract<Item, { Meta: unknown }> => 'Meta' in x)?.Meta
          const steps = body.flatMap((x) => ('Steps' in x ? x.Steps : []))
          const texts = body.map((x, k) => ({ x, i: turn.from + k })).filter(({ x }) => 'Text' in x)
          const finalText = texts[texts.length - 1]
          const foldable = !active && turn.user !== null && (steps.length > 0 || texts.length > 1) && !meta?.error
          const key = turn.user ?? -1
          const folded = foldable && !unfolded.has(key)
          const isNew = (i: number): boolean => i >= opened.current
          return (
            <div className="turn" key={key}>
              {turn.user !== null && (
                <UserMessage text={(chat.items[turn.user] as { User: string }).User} long={!full.has(turn.user)} onMore={() => setFull((s) => new Set(s).add(turn.user!))} fresh={isNew(turn.user)} />
              )}
              {active && (
                <div className="worked"><Shine text={`Working for ${duration((now - (chat.startedAt ?? now)) / 1000)}`} /></div>
              )}
              {!active && foldable && (
                <button className="worked fold" onClick={() => setUnfolded((s) => {
                  const n = new Set(s)
                  if (n.has(key)) n.delete(key)
                  else n.add(key)
                  return n
                })}>
                  {meta && meta.cost_usd > 0 ? `Worked for ${duration(meta.seconds)} · $${meta.cost_usd.toFixed(2)}` : `Worked for ${duration(meta?.seconds ?? 0)}`}
                  <motion.span animate={{ rotate: folded ? 0 : 90 }} transition={tr(QUICK)} className="fold-mark">›</motion.span>
                </button>
              )}
              <AnimatePresence initial={false}>
                {!folded && (
                  <motion.div key="body" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={tr(MOVE)} style={{ overflow: 'hidden' }}>
                    {body.map((it, k) => {
                      const i = turn.from + k
                      if (active && 'Steps' in it) return null
                      if ('Text' in it && finalText && i === finalText.i && foldable) return null
                      return <ItemView key={i} item={it} streaming={chat.streaming === i} fresh={isNew(i)} />
                    })}
                  </motion.div>
                )}
              </AnimatePresence>
              {active && steps.length > 0 && <LiveStep steps={steps} />}
              {foldable && finalText && <ItemView item={finalText.x} streaming={false} fresh={isNew(finalText.i)} />}
              {active && !steps.length && !texts.length && (
                <div className="thinking"><EyeMark width={18} watch={0.7} /> <Shine text="Thinking" /></div>
              )}
            </div>
          )
        })}
        {chat.queued.map((q, i) => (
          <motion.div key={`q${i}`} className="queued" {...rise(6, MOVE)}>
            <span className="faint">Next</span> {q}
          </motion.div>
        ))}
      </div>
      <AnimatePresence>
        {away && (
          <motion.button className="to-bottom" {...rise(6, QUICK)} onClick={() => {
            follow.current = true
            scroller.current!.scrollTo({ top: scroller.current!.scrollHeight, behavior: 'smooth' })
          }}>↓ Latest</motion.button>
        )}
      </AnimatePresence>
    </div>
  )
}

function UserMessage({ text, long, onMore, fresh }: { text: string; long: boolean; onMore: () => void; fresh: boolean }) {
  const clip = long && text.length > 420
  return (
    <motion.div className="um" {...(fresh ? rise(8, MOVE) : {})}>
      {clip ? text.slice(0, 400) + '…' : text}
      {clip && <button className="um-more" onClick={onMore}>Show all</button>}
    </motion.div>
  )
}

function ItemView({ item, streaming, fresh }: { item: Item; streaming: boolean; fresh: boolean }) {
  if ('Text' in item) {
    const bs = blocks(item.Text)
    return (
      <motion.div className="am" {...(fresh && !streaming ? rise(6, MOVE) : {})}>
        {bs.map((b, i) => (
          <motion.div key={i} initial={streaming ? { opacity: 0, y: 4 } : false} animate={{ opacity: 1, y: 0 }} transition={tr(MOVE)}>
            <Block b={b} />
          </motion.div>
        ))}
      </motion.div>
    )
  }
  if ('Steps' in item) return <StepGroup steps={item.Steps} />
  if ('Note' in item) return <motion.div className="note-line" {...(fresh ? rise(4, MOVE) : {})}>{item.Note}</motion.div>
  if ('Meta' in item) return item.Meta.error ? <div className="meta-line err">The turn ended with an error.</div> : null
  return null
}

function StepGroup({ steps }: { steps: Step[] }) {
  const [open, setOpen] = useState(false)
  if (steps.length === 1) return <StepRow s={steps[0]} />
  return (
    <div className="steps">
      <button className="steps-head" onClick={() => setOpen((o) => !o)}>
        {summary(steps)}
        <motion.span animate={{ rotate: open ? 90 : 0 }} transition={tr(QUICK)} className="fold-mark">›</motion.span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={tr(MOVE)} style={{ overflow: 'hidden' }}>
            {steps.map((s, i) => (
              <motion.div key={s.id || i} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={tr(MOVE, Math.min(i, 12) * 0.03)}>
                <StepRow s={s} />
              </motion.div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function StepRow({ s, live }: { s: Step; live?: boolean }) {
  const k = kindOf(s.name)
  return (
    <div className={`step-row${s.error ? ' err' : ''}${s.agent ? ' sub' : ''}`}>
      <span className={`step-glyph${live && !s.done ? ' live' : ''}${s.done && !s.error ? ' done' : ''}`}>{GLYPH[k]}</span>
      <span className="ellipsis">{live && !s.done ? <Shine text={s.summary || s.name} /> : s.summary || s.name}</span>
    </div>
  )
}

/** While it works: the step under way, shining, and how many so far. A
 *  click opens them all (and folds them again). */
function LiveStep({ steps }: { steps: Step[] }) {
  const [open, setOpen] = useState(false)
  const step = steps[steps.length - 1]
  return (
    <div className="live">
      <button className="live-step" onClick={() => setOpen((o) => !o)}>
        <motion.span className="fold-mark live-fold" animate={{ rotate: open ? 90 : 0 }} transition={tr(QUICK)}>›</motion.span>
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span key={step.id} className="live-now" initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} transition={tr(MOVE)}>
            <StepRow s={step} live />
          </motion.span>
        </AnimatePresence>
        {steps.length > 1 && <span className="faint live-count">{steps.length} steps</span>}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div className="live-all" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={tr(MOVE)} style={{ overflow: 'hidden' }}>
            {steps.slice(0, -1).map((s, i) => (
              <motion.div key={s.id || i} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={tr(MOVE, Math.min(i, 12) * 0.02)}>
                <StepRow s={s} />
              </motion.div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
