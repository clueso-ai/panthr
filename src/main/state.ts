// What the app remembers between launches (Application Support/Panthr/state.json).

import { join } from 'node:path'
import type { Api } from '@shared/api'
import type { AppState } from '@shared/types'
import { dataDir } from './paths'
import { readJson, writeJson } from './json'

const file = (): string => join(dataDir(), 'state.json')

export const getState = (): AppState => readJson<AppState>(file(), {})

export const state: Api['state'] = {
  async get() {
    return getState()
  },
  async set(patch) {
    writeJson(file(), { ...getState(), ...patch })
  }
}
