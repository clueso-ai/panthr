// Settings (⌘,): Application Support/Panthr/settings.json, app-wide.

import { join } from 'node:path'
import { nativeTheme } from 'electron'
import type { Api } from '@shared/api'
import { DEFAULT_SETTINGS, type Settings } from '@shared/types'
import { dataDir } from './paths'
import { readJson, writeJson } from './json'
import { emit } from './bus'

const file = (): string => join(dataDir(), 'settings.json')

export function getSettings(): Settings {
  return { ...DEFAULT_SETTINGS, ...readJson<Partial<Settings>>(file(), {}) }
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
