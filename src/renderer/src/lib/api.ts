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
