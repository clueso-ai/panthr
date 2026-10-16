// Settings ▸ Usage: where the time and money go, from every chat's turns.
// Totals for the week, the month and all time; the last 30 days; each
// account (with how much of its plan is used now); each project, opening
// on its newest turns. Cost is Claude Code's, in API dollars (what the
// work would cost on the API; a subscription pays none of it); Codex
// reports tokens instead.

import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { UsageReport, UsageTotals } from '@shared/types'
import { api, useEvent } from '@/lib/api'
import { tr, MOVE } from '@/lib/motion'
import { AccountDot, UsageBar, useAccounts } from '@/ui/Accounts'
import { Segmented } from '@/ui/Controls'
import { Icon } from '@/ui/Icon'

export const money = (n: number): string => (n >= 100 ? `$${Math.round(n)}` : n >= 0.995 ? `$${n.toFixed(2)}` : n > 0 ? `${Math.round(n * 100)}¢` : '$0')
export const time = (s: number): string => {
  if (s < 60) return `${Math.round(s)}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(Math.round(s % 60)).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}
const tokens = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n))
const when = (s: number | null): string => {
  if (!s) return 'earlier'
  const d = Date.now() / 1000 - s
  if (d < 3600) return `${Math.max(1, Math.round(d / 60))} min ago`
  if (d < 86400) return `${Math.round(d / 3600)} h ago`
  return new Date(s * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

function Tile({ title, t }: { title: string; t: UsageTotals }) {
  return (
    <div className="use-tile">
      <span className="faint">{title}</span>
      <b>{time(t.seconds)}</b>
      <span className="faint">{money(t.cost)} · {t.turns} turn{t.turns === 1 ? '' : 's'}{t.tokens ? ` · ${tokens(t.tokens)} tokens` : ''}</span>
    </div>
  )
}

export function UsagePane() {
  const [r, setR] = useState<UsageReport | null>(null)
  const [by, setBy] = useState<'time' | 'cost'>('time')
  const [open, setOpen] = useState<string | null>(null)
  const live = useAccounts()
  const load = (): void => {
    api.usage.report().then(setR)
  }
  useEffect(load, [])
  useEvent('chat:turn', load)
  if (!r) return <p className="pane-lede">Adding it up…</p>
  if (!r.all.turns) return <p className="pane-lede">Nothing yet: once an agent has worked on something, its time and cost show here.</p>
  const val = (t: UsageTotals): number => (by === 'time' ? t.seconds : t.cost)
  const max = Math.max(...r.days.map(val), 1e-9)
  return (
    <>
      <p className="pane-lede">Where the agents’ time goes, from every chat. Cost is Claude Code’s, in API dollars: what the work would cost on the API (a subscription pays none of it). Codex reports tokens instead.</p>
      <div className="use-tiles">
        <Tile title="This week" t={r.week} />
        <Tile title="This month" t={r.month} />
        <Tile title="All time" t={r.all} />
      </div>

      <div className="use-chart-head">
        <b>Last 30 days</b>
        <Segmented id="use-by" value={by} onChange={setBy} options={[{ value: 'time', label: 'Time' }, { value: 'cost', label: 'Cost' }]} />
      </div>
      <div className="use-chart">
        {r.days.map((d) => (
          <div key={d.day} className="use-bar" title={`${d.day}: ${time(d.seconds)} · ${money(d.cost)} · ${d.turns} turn${d.turns === 1 ? '' : 's'}`}>
            <i style={{ height: `${Math.max(val(d) ? 4 : 0, (val(d) / max) * 100)}%` }} />
          </div>
        ))}
      </div>
      <div className="use-axis faint"><span>{r.days[0]?.day.slice(5)}</span><span>Today</span></div>
      {r.undated > 0 && <p className="pane-note">{r.undated} older turn{r.undated === 1 ? '' : 's'} from before Panther noted when each happened: {r.undated === 1 ? 'its day is' : 'their days are'} estimated from when the chat began and was last used.</p>}

      <h3 className="use-h">Accounts</h3>
      <div className="use-table">
        {r.accounts.map((a) => {
          const now = live.find((x) => x.id === a.id)
          return (
            <div key={a.id} className="use-row">
              <span className="use-name"><AccountDot color={a.color} /> {a.label}</span>
              <span>{time(a.seconds)}</span>
              <span>{a.engine === 'codex' ? (a.tokens ? `${tokens(a.tokens)} tok` : '—') : money(a.cost)}</span>
              <span className="faint">{a.turns} turns</span>
              {now?.usage && <span className="use-live"><UsageBar label="5 h" w={now.usage.five_hour} /><UsageBar label="Week" w={now.usage.seven_day} /></span>}
            </div>
          )
        })}
      </div>

      <h3 className="use-h">Projects</h3>
      <div className="use-table">
        {r.projects.map((p) => (
          <div key={p.dir} className="use-proj">
            <button className="use-row use-click" onClick={() => setOpen(open === p.dir ? null : p.dir)}>
              <span className="use-name"><motion.span className="fold-mark" animate={{ rotate: open === p.dir ? 90 : 0 }} transition={tr(MOVE)}><Icon name="chevron-right" size={12} /></motion.span>{p.name}</span>
              <span>{time(p.seconds)}</span>
              <span>{money(p.cost)}</span>
              <span className="faint">{p.turns} turns · {when(p.lastAt)}</span>
            </button>
            <AnimatePresence initial={false}>
              {open === p.dir && (
                <motion.div className="use-turns" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={tr(MOVE)}>
                  {p.recent.map((t, i) => {
                    const acct = live.find((x) => x.id === t.account)
                    return (
                      <div key={i} className="use-turn">
                        <span className="use-label ellipsis" title={t.label}>{t.error && <span className="use-err">failed · </span>}{t.label || '(no message)'}</span>
                        <span className="faint">{when(t.at)}</span>
                        <span className="use-acct">{acct && <AccountDot color={acct.color} size={7} />}{acct ? acct.label : t.engine === 'codex' ? 'Codex' : 'Claude'}</span>
                        <span>{time(t.seconds)}</span>
                        <span>{t.engine === 'codex' ? (t.tokens ? `${tokens(t.tokens)} tok` : '—') : money(t.cost)}</span>
                      </div>
                    )
                  })}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        ))}
      </div>
    </>
  )
}
