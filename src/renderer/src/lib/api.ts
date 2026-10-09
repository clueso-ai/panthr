// The app's API (window.panthr) and React hooks around it.

import { useEffect, useState } from 'react'
import type { Events } from '@shared/api'
import { DEFAULT_SETTINGS, type Settings } from '@shared/types'

export const api = window.panthr

/** Listen to an app event for as long as the component lives. */
export function useEvent<K extends keyof Events>(name: K, cb: (payload: Events[K]) => void, deps: unknown[] = []): void {
  useEffect(() => api.on(name, cb), deps) // eslint-disable-line react-hooks/exhaustive-deps
}

let current: Settings = DEFAULT_SETTINGS
const subs = new Set<(s: Settings) => void>()
api.settings.get().then((s) => {
  current = s
  subs.forEach((f) => f(s))
})
api.on('settings', (s) => {
  current = s
  subs.forEach((f) => f(s))
})

/** Settings, kept current. */
export function useSettings(): Settings {
  const [s, set] = useState(current)
  useEffect(() => {
    subs.add(set)
    set(current)
    return () => {
      subs.delete(set)
    }
  }, [])
  return s
}

export const settingsNow = (): Settings => current

// ── References, kept current for every component that shows them ─────

import type { Reference } from '@shared/types'
let refs: Reference[] = []
const refSubs = new Set<(r: Reference[]) => void>()
api.references.list().then((r) => {
  refs = r
  refSubs.forEach((f) => f(r))
})
api.on('references', (r) => {
  refs = r
  refSubs.forEach((f) => f(r))
})

export function useReferences(): Reference[] {
  const [r, set] = useState(refs)
  useEffect(() => {
    refSubs.add(set)
    set(refs)
    return () => {
      refSubs.delete(set)
    }
  }, [])
  return r
}
