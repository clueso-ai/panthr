// Settings (⌘,): Application Support/Panthr/settings.json, app-wide.

import { join } from 'node:path'
import { nativeTheme } from 'electron'
import type { Api } from '@shared/api'
import { DEFAULT_SETTINGS, type Settings } from '@shared/types'
import { dataDir } from './paths'
import { readJson, writeJson } from './json'
import { emit } from './bus'

const file = (): string => join(dataDir(), 'settings.json')

/** Frost was four steps before it was a slider. */
const OLD_FROST: Record<string, number> = { solid: 0, light: 18, medium: 40, strong: 73 }

export function getSettings(): Settings {
  const s = { ...DEFAULT_SETTINGS, ...readJson<Partial<Settings>>(file(), {}) }
  const f = s.frost as unknown
  s.frost = typeof f === 'number' && Number.isFinite(f) ? Math.min(100, Math.max(0, f)) : OLD_FROST[String(f)] ?? DEFAULT_SETTINGS.frost
  return s
}

export const settings: Api['settings'] = {
  async get() {
    return getSettings()
  },
  async set(patch) {
    const s = { ...getSettings(), ...patch }
    writeJson(file(), s)
    nativeTheme.themeSource = s.appearance === 'night' ? 'dark' : s.appearance === 'day' ? 'light' : 'system'
    emit('settings', s)
    return s
  }
}
