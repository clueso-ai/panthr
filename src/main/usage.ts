// Usage: where the time and money go. Built from every chat's turns (each
// ends with how long it took and, for Claude Code, its cost in API dollars;
// newer turns also say when, on which agent and account, and how many
// tokens): by day, by project, by account, and the newest turns of each.
// Codex reports tokens, not dollars.

import { statSync } from 'node:fs'
import type { Api } from '@shared/api'
import type { Engine, Item, TurnMeta, UsageProject, UsageReport, UsageTotals, UsageTurn } from '@shared/types'
import { accountFor, accounts } from './accounts'
import { assistantDir } from './paths'
import { listCanvases } from './board'
import { chatPath, loadMeta } from './projects'
import { loadTranscript } from './chats'

const zero = (): UsageTotals => ({ cost: 0, seconds: 0, turns: 0, tokens: 0 })
const add = (t: UsageTotals, u: UsageTotals): void => {
  t.cost += u.cost
  t.seconds += u.seconds
  t.turns += u.turns
  t.tokens += u.tokens
}

/** A project's (or the assistant's) turns. */
function turnsOf(dir: string): UsageTurn[] {
  const meta = loadMeta(dir)
  if (!meta) return []
  const out: UsageTurn[] = []
  for (const c of meta.chats) {
    let label = ''
    const file = chatPath(dir, c.id)
    const mine: UsageTurn[] = []
    for (const it of loadTranscript(file) as Item[]) {
      if ('User' in it) label = it.User.split('\n')[0].slice(0, 120)
      if (!('Meta' in it)) continue
      const m: TurnMeta = it.Meta
      const engine: Engine = m.engine ?? c.engine ?? 'claude'
      mine.push({
        label, chat: c.title, at: m.at ?? null, engine, account: m.account ?? accountFor(c.account, engine).id, error: m.error,
        cost: Number(m.cost_usd) || 0, seconds: Number(m.seconds) || 0, turns: 1, tokens: Number(m.tokens) || 0
      })
    }
    // Older turns never said when they ended: each run of them is spread
    // between the dated turns around it (the chat's start before the first,
    // the transcript's last change after the last).
    let last = c.created_at
    try {
      last = Math.floor(statSync(file).mtimeMs / 1000)
    } catch {}
    for (let i = 0; i < mine.length; i++) {
      if (mine[i].at != null) continue
      let j = i
      while (j + 1 < mine.length && mine[j + 1].at == null) j++
      const from = i > 0 ? mine[i - 1].at! : Math.min(c.created_at || last, last)
      const to = j + 1 < mine.length ? mine[j + 1].at! : last
      for (let k = i; k <= j; k++) {
        mine[k].at = Math.round(from + ((Math.max(from, to) - from) * (k - i + 1)) / (j - i + 2))
        mine[k].estimated = true
      }
      i = j
    }
    out.push(...mine)
  }
  return out
}

const dayOf = (s: number): string => {
  const d = new Date(s * 1000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function report(nowMs = Date.now()): UsageReport {
  const now = nowMs / 1000
  const all = zero()
  const week = zero()
  const month = zero()
  const days = new Map<string, UsageTotals>()
  for (let i = 29; i >= 0; i--) days.set(dayOf(now - i * 86400), zero())
  const byAccount = new Map<string, UsageTotals>()
  const projects: UsageProject[] = []
  let undated = 0

  const places = [...listCanvases().map((c) => ({ dir: c.dir, name: c.name })), { dir: assistantDir(), name: 'Assistant' }]
  for (const p of places) {
    const turns = turnsOf(p.dir)
    if (!turns.length) continue
    const proj: UsageProject = { dir: p.dir, name: p.name, ...zero(), lastAt: null, accounts: {}, recent: [] }
    for (const t of turns) {
      add(proj, t)
      add(all, t)
      if (t.at != null) {
        proj.lastAt = Math.max(proj.lastAt ?? 0, t.at)
        if (now - t.at < 7 * 86400) add(week, t)
        if (now - t.at < 30 * 86400) add(month, t)
        const d = days.get(dayOf(t.at))
        if (d) add(d, t)
      }
      if (t.estimated) undated++
      add((proj.accounts[t.account] ??= zero()), t)
      if (!byAccount.has(t.account)) byAccount.set(t.account, zero())
      add(byAccount.get(t.account)!, t)
    }
    proj.recent = turns.map((t, i) => ({ t, i })).sort((a, b) => (b.t.at ?? 0) - (a.t.at ?? 0) || b.i - a.i).slice(0, 40).map((x) => x.t)
    projects.push(proj)
  }
  projects.sort((a, b) => b.cost - a.cost || b.seconds - a.seconds)

  const known = accounts()
  return {
    all, week, month,
    days: [...days.entries()].map(([day, t]) => ({ day, ...t })),
    projects,
    accounts: [...byAccount.entries()].map(([id, t]) => {
      const a = known.find((x) => x.id === id)
      return { id, label: a ? `${a.engine === 'codex' ? 'Codex' : 'Claude'} · ${a.label}` : id, engine: a?.engine ?? 'claude', color: a?.color ?? '#8a8a90', ...t }
    }).sort((a, b) => b.seconds - a.seconds),
    undated
  }
}

export const usageApi: Api['usage'] = {
  async report() {
    return report()
  }
}
