import type { Api, Events } from '../shared/api'

declare global {
  interface Window {
    panthr: Api & { on<K extends keyof Events>(name: K, cb: (payload: Events[K]) => void): () => void }
  }
}
export {}
