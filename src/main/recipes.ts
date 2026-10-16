// A finished video kept as a recipe: its latest export taken apart like any
// recipe video (so it can be @mentioned), with the video's own source copied
// beside it (source/: its compositions, storyboard, brief, design notes and
// small assets), so "another one like this" starts from what worked: the
// same structure, look and timing, with new content.

import { cpSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { Reference } from '@shared/types'
import { add } from './references'
import { review } from './review'
import { load } from './projects'

const KEEP = ['index.html', 'compositions', 'STORYBOARD.md', 'storyboard.html', 'BRIEF.md', 'SCRIPT.md', 'frame.md', 'design.md', 'DESIGN.md', 'BRAND.md', 'hyperframes.json', 'transcript.json', '.studio/controls.json']
const ASSET_MAX = 25 * 1024 * 1024

/** Copy what the video is made of into `to` (assets only up to a size, the biggest left out). */
export function copySource(dir: string, to: string): string[] {
  mkdirSync(to, { recursive: true })
  const copied: string[] = []
  for (const rel of KEEP) {
    const p = join(dir, rel)
    if (!existsSync(p)) continue
    mkdirSync(join(to, rel, '..'), { recursive: true })
    cpSync(p, join(to, rel), { recursive: true })
    copied.push(rel)
  }
  const assets = join(dir, 'assets')
  if (existsSync(assets)) {
    const files = readdirSync(assets).map((f) => ({ f, size: statSync(join(assets, f)).isFile() ? statSync(join(assets, f)).size : Infinity })).filter((x) => x.size !== Infinity).sort((a, b) => a.size - b.size)
    let total = 0
    for (const { f, size } of files) {
      if (total + size > ASSET_MAX) break
      mkdirSync(join(to, 'assets'), { recursive: true })
      cpSync(join(assets, f), join(to, 'assets', f))
      copied.push(`assets/${f}`)
      total += size
    }
  }
  return copied
}

export async function saveRecipe(dir: string, name?: string): Promise<Reference> {
  const versions = await review.versions(dir)
  const last = versions.sort((a, b) => b.n - a.n)[0]
  const file = last && (isAbsolute(last.file) ? last.file : join(dir, '.studio', 'versions', last.file))
  if (!last || !file || !existsSync(file)) throw new Error('Export it first: a recipe is made from its latest export')
  const title = name?.trim() || load(dir)?.meta.name || 'Recipe'
  const ref = await add(file, title)
  const copied = copySource(dir, join(ref.dir, 'source'))
  writeFileSync(join(ref.dir, 'RECIPE.md'), `# ${title}: a recipe made in Panther

This recipe is a finished Panther video (export v${last.n}), saved to make more like it. Besides the taken-apart video, its own source is in \`source/\`: ${copied.length ? copied.map((c) => `\`${c}\``).join(', ') : 'nothing could be copied'}.

To make another one like it: start from \`source/\` (its structure, scene order, timing, type, colours and motion), keep what made it work, and replace the content with the new subject. Read its STORYBOARD.md and BRIEF.md first when they are there.
`)
  return ref
}
