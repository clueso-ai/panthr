// The name a cheap model gives a new project: its reply cleaned up, and
// which Codex model counts as the cheap one.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { cheapCodexModel, cleanName, namePrompt } from '../src/main/namer'

describe('namer', () => {
  it('keeps the first line, without quotes, labels or a full stop', () => {
    expect(cleanName('Recreating Viral AI Video Clip\n')).toBe('Recreating Viral AI Video Clip')
    expect(cleanName('"Brazil World Cup Ident".')).toBe('Brazil World Cup Ident')
    expect(cleanName('Name: Launch Teaser')).toBe('Launch Teaser')
    expect(cleanName('\n\n**Logo Reveal**')).toBe('Logo Reveal')
  })
  it('gives up on a refusal, nothing, or a paragraph', () => {
    expect(cleanName('')).toBeNull()
    expect(cleanName("I can't see the video, but here is a name")).toBeNull()
    expect(cleanName('x'.repeat(60))).toBeNull()
  })
  it('asks with the message, cut to a sensible length', () => {
    const p = namePrompt('y'.repeat(5000))
    expect(p).toContain('2 to 5 words')
    expect(p.length).toBeLessThan(2600)
  })

  const env = process.env.HOME
  afterAll(() => {
    process.env.HOME = env
  })
  it("picks Codex's fast, affordable model from its cache, skipping hidden ones", () => {
    const h = mkdtempSync(join(tmpdir(), 'panthr-namer-'))
    mkdirSync(join(h, '.codex'))
    writeFileSync(join(h, '.codex/models_cache.json'), JSON.stringify({ models: [
      { slug: 'big', description: 'Latest workhorse model.', visibility: 'list' },
      { slug: 'secret', description: 'Fast and affordable.', visibility: 'hide' },
      { slug: 'luna', description: 'Fast and affordable model for easier tasks.', visibility: 'list' }
    ] }))
    process.env.HOME = h
    expect(cheapCodexModel()).toBe('luna')
  })
})
