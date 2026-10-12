// Claude accounts in the window: the list (kept fresh by the 'accounts'
// event), a dot in each account's colour, and how much of it is used.

import { useEffect, useState } from 'react'
import type { AccountStatus, UsageWindow } from '@shared/types'
import { api, useEvent } from '@/lib/api'

let cache: AccountStatus[] = []

export function useAccounts(refresh = false): AccountStatus[] {
  const [list, setList] = useState<AccountStatus[]>(cache)
  useEffect(() => {
    api.accounts.list(refresh).then((l) => {
      cache = l
      setList(l)
    })
  }, [refresh])
  useEvent('accounts', (l) => {
    cache = l
    setList(l)
  })
  return list
}

export const AccountDot = ({ color, size = 8 }: { color: string; size?: number }) => (
  <i className="acct-dot" style={{ background: color, width: size, height: size }} />
)

/** When a window resets, in words ("in 2 h", "Mon 09:00"). */
export function resetsIn(at: number | null): string {
  if (!at) return ''
  const s = at - Date.now() / 1000
  if (s <= 0) return 'now'
  if (s < 3600) return `in ${Math.ceil(s / 60)} min`
  if (s < 86400) return `in ${Math.round(s / 3600)} h`
  return new Date(at * 1000).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })
}

/** A window's use as a thin bar, with how much and when it resets. */
export function UsageBar({ label, w }: { label: string; w: UsageWindow | null }) {
  if (!w) return null
  const pct = Math.round(Math.min(1, Math.max(0, w.utilization)) * 100)
  return (
    <div className="usage" title={w.resetsAt ? `Resets ${resetsIn(w.resetsAt)}` : undefined}>
      <span className="usage-label">{label}</span>
      <span className="usage-track"><i className={pct >= 90 ? 'hot' : pct >= 75 ? 'warm' : ''} style={{ width: `${pct}%` }} /></span>
      <span className="usage-pct">{pct}%</span>
    </div>
  )
}

/** The most used window, 0 to 1 (null: not heard yet). */
export const mostUsed = (a: AccountStatus): number | null => {
  const u = a.usage
  if (!u) return null
  if (u.status === 'rejected') return 1
  return Math.max(u.five_hour?.utilization ?? 0, u.seven_day?.utilization ?? 0)
}
