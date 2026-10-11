// A project's brand kit: colours, fonts, a logo and a voice, kept in
// .studio/brand.json and written out as BRAND.md in the project folder, the
// file the agent reads and follows in every video of the project.

import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import type { Api } from '@shared/api'
import type { Brand } from '@shared/types'
import { emit } from './bus'
import { readJson, writeJson } from './json'

const file = (dir: string): string => join(dir, '.studio', 'brand.json')
export const EMPTY: Brand = { colors: [], fonts: [], logo: null, voice: '' }

export function getBrand(dir: string): Brand {
  const b = readJson<Partial<Brand>>(file(dir), {})
  return { colors: b.colors ?? [], fonts: b.fonts ?? [], logo: b.logo ?? null, voice: b.voice ?? '' }
}

const isEmpty = (b: Brand): boolean => !b.colors.length && !b.fonts.length && !b.logo && !b.voice.trim()

/** BRAND.md: the kit in words, for the agent (and anyone opening the folder). */
export function brandMarkdown(b: Brand): string {
  const lines = ['# Brand kit', '', 'Every video in this project follows this. Use these exact values; do not invent others.', '']
  if (b.colors.length) lines.push('## Colours', '', ...b.colors.map((c) => `- ${c.name || 'Colour'}: \`${c.hex}\``), '')
  if (b.fonts.length) lines.push('## Type', '', ...b.fonts.map((f) => `- ${f.role || 'Text'}: ${f.family}`), '')
  if (b.logo) lines.push('## Logo', '', `- \`${b.logo}\` (from the project folder; copy it into a video's assets/ to use it)`, '')
  if (b.voice.trim()) lines.push('## Voice', '', b.voice.trim(), '')
  return lines.join('\n')
}

export function saveBrand(dir: string, b: Brand): void {
  writeJson(file(dir), b)
  const md = join(dir, 'BRAND.md')
  if (isEmpty(b)) rmSync(md, { force: true })
  else writeFileSync(md, brandMarkdown(b))
  emit('brand:changed', { dir })
}

export function copyLogo(dir: string, from: string): string {
  if (!existsSync(from)) throw new Error('No such file')
  mkdirSync(join(dir, 'brand'), { recursive: true })
  const rel = `brand/logo${extname(from).toLowerCase() || '.png'}`
  copyFileSync(from, join(dir, rel))
  return rel
}

export const brandApi: Api['brand'] = {
  async get(dir) {
    return getBrand(dir)
  },
  async save(dir, b) {
    saveBrand(dir, b)
  },
  async logo(dir, from) {
    return copyLogo(dir, from)
  }
}
