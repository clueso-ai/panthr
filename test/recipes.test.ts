// A finished video's source, copied beside its recipe.
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: undefined, BrowserWindow: { getAllWindows: () => [] }, nativeTheme: {}, shell: {}, dialog: {} }))
const { copySource } = await import('../src/main/recipes')
const root = mkdtempSync(join(tmpdir(), 'panthr-test-recipes-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('a recipe’s source', () => {
  it('keeps what the video is made of, and its small assets', () => {
    const v = join(root, 'Video')
    mkdirSync(join(v, 'compositions'), { recursive: true })
    mkdirSync(join(v, 'assets'))
    mkdirSync(join(v, '.studio'))
    writeFileSync(join(v, 'index.html'), '<html></html>')
    writeFileSync(join(v, 'compositions', 'title.html'), '<div></div>')
    writeFileSync(join(v, 'STORYBOARD.md'), '## Frame 1 — Hook')
    writeFileSync(join(v, '.studio', 'controls.json'), '{}')
    writeFileSync(join(v, '.studio', 'chats.json'), '{}')
    writeFileSync(join(v, 'assets', 'logo.svg'), '<svg/>')
    writeFileSync(join(v, 'assets', 'huge.mov'), Buffer.alloc(26 * 1024 * 1024))
    const to = join(root, 'Recipe', 'source')
    const copied = copySource(v, to)
    expect(copied).toEqual(['index.html', 'compositions', 'STORYBOARD.md', '.studio/controls.json', 'assets/logo.svg'])
    expect(readdirSync(join(to, 'assets'))).toEqual(['logo.svg'])
    expect(readdirSync(join(to, '.studio'))).toEqual(['controls.json'])
  })
})
