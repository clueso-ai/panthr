// One project file at a time, for undo: read it, and put text back only if
// nobody (the agent, say) changed it since.

import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, normalize, resolve, sep } from 'node:path'
import type { Api } from '@shared/api'

function inside(dir: string, rel: string): string {
  if (isAbsolute(rel) || normalize(rel).split(sep).includes('..')) throw new Error('outside the project')
  return resolve(dir, rel)
}

export const files: Api['files'] = {
  async read(dir, rel) {
    try {
      return await readFile(inside(dir, rel), 'utf8')
    } catch {
      return null
    }
  },
  async replace(dir, rel, expected, next) {
    const p = inside(dir, rel)
    const now = await readFile(p, 'utf8').catch(() => null)
    if (now !== expected) return false
    await writeFile(p, next)
    return true
  }
}
