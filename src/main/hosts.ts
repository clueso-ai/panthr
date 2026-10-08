// Remote hosts in Settings and on Home: the list, a check of what each has,
// and its projects (their notes pulled into mirrors here). The work itself
// is in remote.ts.

import { mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Api } from '@shared/api'
import type { Host, Project, ProjectMeta } from '@shared/types'
import { readJson } from './json'
import { setRemotePort } from './preview'
import * as remote from './remote'

// The preview of a project on a host comes from its server there.
setRemotePort((dir) => remote.livePort(dir))

/** A mirror as a project: its notes if pulled, else a placeholder by name.
 *  (A minimal read of .studio/project.json, not projects.ts's load.) */
export function mirrorProject(host: Host, name: string): Project {
  const dir = remote.mirrorOf(host, name)
  const metaPath = join(dir, '.studio/project.json')
  const m = readJson<Partial<ProjectMeta> | null>(metaPath, null)
  const meta: ProjectMeta = {
    name: m?.name || name,
    created_at: m?.created_at ?? 0,
    chats: m?.chats ?? [],
    agents_enabled: m?.agents_enabled ?? true,
    models: m?.models ?? {}
  }
  let edited = 0
  try {
    edited = Math.floor(statSync(metaPath).mtimeMs / 1000)
  } catch {}
  return { dir, meta, host: host.name, thumb: null, edited_at: edited }
}

export const hosts: Api['hosts'] = {
  async list() {
    return remote.hosts()
  },
  async save(hs) {
    const names = new Set(hs.map((h) => h.name))
    // A host taken out: its projects stay there; stop serving them here.
    for (const h of remote.hosts()) if (!names.has(h.name)) stopHost(h)
    remote.saveHosts(hs.map((h) => ({ name: h.name.trim(), target: h.target.trim(), root: h.root.trim() || '~/Panthr' })))
  },
  async check(host) {
    return remote.check(host)
  },
  async refresh(name) {
    const host = remote.hosts().find((h) => h.name === name)
    if (!host) throw new Error(`no host named ${name}`)
    const names = await remote.list(host)
    return Promise.all(
      names.map(async (n) => {
        const dir = remote.mirrorOf(host, n)
        mkdirSync(dir, { recursive: true })
        // One project that will not sync still lists (by name).
        await remote.pull(dir).catch(() => {})
        return mirrorProject(host, n)
      })
    )
  }
}

/** Each served project of a host is keyed by its mirror folder. */
function stopHost(h: Host): void {
  remote.stopLiveUnder(join(remote.mirrors(), remote.slug(h.name)))
}
