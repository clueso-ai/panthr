// A project's brand kit: saved, written out as BRAND.md for the agent, and
// BRAND.md gone again when the kit is emptied. A logo is copied in.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: undefined }))
vi.mock('../src/main/bus', () => ({ emit: () => {} }))

import { copyLogo, EMPTY, getBrand, saveBrand } from '../src/main/brand'

describe('brand kit', () => {
  it('saves, writes BRAND.md, copies a logo, and clears', () => {
    const d = mkdtempSync(join(tmpdir(), 'panthr-brand-'))
    mkdirSync(join(d, '.studio'))
    expect(getBrand(d)).toEqual(EMPTY)
    writeFileSync(join(d, '..', 'logo-src.svg'), '<svg/>')
    const logo = copyLogo(d, join(d, '..', 'logo-src.svg'))
    expect(logo).toBe('brand/logo.svg')
    saveBrand(d, { colors: [{ name: 'Primary', hex: '#e5487f' }], fonts: [{ role: 'Headings', family: 'Bricolage Grotesque' }], logo, voice: 'Plain, confident.' })
    const md = readFileSync(join(d, 'BRAND.md'), 'utf8')
    expect(md).toContain('Primary: `#e5487f`')
    expect(md).toContain('Headings: Bricolage Grotesque')
    expect(md).toContain('`brand/logo.svg`')
    expect(md).toContain('Plain, confident.')
    expect(getBrand(d).colors).toHaveLength(1)
    saveBrand(d, EMPTY)
    expect(existsSync(join(d, 'BRAND.md'))).toBe(false)
  })
})
