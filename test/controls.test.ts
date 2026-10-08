// The controls file, key lookup, written values and inspect parsing
// (port of studio-mac/src/tests/controls.rs and parse_inspect).

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Control, ControlSet } from '@shared/types'

vi.mock('electron', () => ({ app: undefined, BrowserWindow: { getAllWindows: () => [] }, nativeTheme: {} }))

const { load, save, keyFor, fmtNum, written, setRequest, parseInspect, PARSERS } = await import('../src/main/controls')

const temps: string[] = []
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'panthr-test-controls-'))
  temps.push(d)
  return d
}
afterEach(() => {
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

const set = (file: string, element: string): ControlSet => ({ title: 'Title', file, element, controls: [], note: null })
const control = (type: string, write: string): Control => ({ label: 'Size', type, write })
const map = (keys: string[]): Record<string, ControlSet> => Object.fromEntries(keys.map((k) => [k, set('index.html', '#x')]))

describe('controls.json', () => {
  it('parses what the agent writes', () => {
    const d = temp()
    mkdirSync(join(d, '.studio'))
    writeFileSync(
      join(d, '.studio/controls.json'),
      JSON.stringify({
        'compositions/title.html#headline': {
          title: 'Headline', file: 'compositions/title.html', element: '#headline', note: 'Big type',
          controls: [
            { label: 'Size', type: 'number', write: 'style:font-size', min: 24, max: 200, step: 2, unit: 'px', primary: true, value: 96 },
            { label: 'Text', type: 'text', write: 'text' }
          ]
        },
        'bad#x': { file: 'index.html' }
      })
    )
    const all = load(d)
    expect(Object.keys(all)).toEqual(['compositions/title.html#headline'])
    const s = all['compositions/title.html#headline']
    expect(s.note).toBe('Big type')
    expect(s.controls[0].unit).toBe('px')
  })

  it('round-trips with sorted keys; minimal sets default', () => {
    const d = temp()
    expect(load(d)).toEqual({})
    save(d, { 'z.html#a': set('z.html', '#a'), 'a.html#b': { file: 'a.html', element: '#b', controls: [] } })
    const raw = JSON.parse(readFileSync(join(d, '.studio/controls.json'), 'utf8'))
    expect(Object.keys(raw)).toEqual(['a.html#b', 'z.html#a'])
    expect(load(d)['a.html#b'].title).toBe('')
  })

  it('a corrupt file is empty', () => {
    const d = temp()
    mkdirSync(join(d, '.studio'))
    writeFileSync(join(d, '.studio/controls.json'), '[1,2')
    expect(load(d)).toEqual({})
  })
})

describe('keyFor', () => {
  it('exact id, other file', () => {
    const all = map(['index.html#title', 'index.html#logo'])
    expect(keyFor(all, 'index.html', ['logo'], 0)).toBe('index.html#logo')
    expect(keyFor(all, 'compositions/a.html', ['title'], 0)).toBeNull()
    expect(keyFor(all, 'index.html', [], 0)).toBeNull()
  })

  it('time ranges are start-inclusive, end-exclusive', () => {
    const all = map(['index.html#box@0-2.5', 'index.html#box@2.5-6'])
    const k = (t: number): string | null => keyFor(all, 'index.html', ['box'], t)
    expect(k(0)).toBe('index.html#box@0-2.5')
    expect(k(2.49)).toBe('index.html#box@0-2.5')
    expect(k(2.5)).toBe('index.html#box@2.5-6')
    expect(k(5.999)).toBe('index.html#box@2.5-6')
    expect(k(6)).toBeNull()
    expect(k(-1)).toBeNull()
  })

  it('exact beats range; falls back to the ids around it', () => {
    expect(keyFor(map(['index.html#box', 'index.html#box@0-10']), 'index.html', ['box'], 3)).toBe('index.html#box')
    const all = map(['index.html#card', 'index.html#scene'])
    expect(keyFor(all, 'index.html', ['label', 'card', 'scene'], 0)).toBe('index.html#card')
    expect(keyFor(all, 'index.html', ['label', 'other', 'scene'], 0)).toBe('index.html#scene')
  })

  it('the prefix must be the whole id; subfolders', () => {
    expect(keyFor(map(['index.html#box2@0-5', 'index.html#box@x-y']), 'index.html', ['box'], 1)).toBeNull()
    const all = map(['compositions/intro.html#title@1-3'])
    expect(keyFor(all, 'compositions/intro.html', ['title'], 2)).toBe('compositions/intro.html#title@1-3')
    expect(keyFor(all, 'intro.html', ['title'], 2)).toBeNull()
  })
})

describe('written values', () => {
  it('fmtNum trims and never writes -0', () => {
    expect([1, 0.5, 1.23456, 100, 10.1, 0, -2.25, 1e-4, -0, -0.0001].map(fmtNum)).toEqual(['1', '0.5', '1.235', '100', '10.1', '0', '-2.25', '0', '0', '0'])
  })

  it('CSS numbers get their unit, attributes none, clamped only with both bounds', () => {
    expect(written({ ...control('number', 'style:font-size'), unit: 'px' }, 48)).toBe('48px')
    expect(written(control('number', 'style:font-size'), 0.75)).toBe('0.75')
    expect(written({ ...control('number', 'attr:data-duration'), unit: 's' }, 3)).toBe('3')
    const c = { ...control('number', 'style:opacity'), min: 0, max: 1 }
    expect(written(c, 1.7)).toBe('1')
    expect(written(c, -3)).toBe('0')
    expect(written({ ...c, max: null }, 1.7)).toBe('1.7')
    expect(written(control('color', 'style:color'), '#ff4f9a')).toBe('#ff4f9a')
    expect(written(control('number', 'style:width'), '50%')).toBe('50%')
    expect(written(control('text', 'text'), 5)).toBe(5)
  })

  it('set requests target the element, or the control\'s targets', () => {
    expect(setRequest(set('compositions/a.html', '#title'), { ...control('number', 'style:font-size'), unit: 'px' }, 64)).toEqual({
      op: 'set', file: 'compositions/a.html', target: '#title', targets: ['#title'], write: 'style:font-size', value: '64px'
    })
    const r = setRequest(set('index.html', '#root'), { ...control('color', 'style:color'), targets: ['#a', '#b'] }, 'red')
    expect([r.target, r.targets, r.value]).toEqual(['#a', ['#a', '#b'], 'red'])
  })

  it('the parsers pin matches the Rust app', () => {
    expect(PARSERS).toBe('@hyperframes/parsers@0.8.73')
  })
})

describe('parseInspect', () => {
  const inspect = {
    files: [
      {
        file: 'index.html',
        layers: [
          {
            id: 'title', label: 'Title', start: 0.5, end: 3, movable: true, why: null,
            tweens: [
              { id: 't1', start: 0.5, duration: 0.6, ease: 'power2.out', editable: true, method: 'from' },
              { id: 't2', start: 1, editable: false, why: 'built in a loop or helper' },
              { start: 2 }
            ]
          },
          { id: 'bg', label: 'bg', start: null, end: null, movable: false, why: 'nothing animates it', tweens: [] }
        ]
      },
      { file: 'compositions/outro.html', layers: [{ id: 'logo', start: 8, end: 10, movable: false, why: 'its target is computed' }] }
    ]
  }

  it('reads every file\'s layers with their file', () => {
    const t = parseInspect(inspect)
    expect(Object.keys(t).sort()).toEqual(['logo', 'title'])
    expect(t.title).toEqual({
      id: 'title', file: 'index.html', label: 'Title', start: 0.5, end: 3, movable: true, why: null,
      tweens: [
        { id: 't1', start: 0.5, duration: 0.6, ease: 'power2.out', editable: true, method: 'from', why: null },
        { id: 't2', start: 1, duration: 0, ease: null, editable: false, method: 'to', why: 'built in a loop or helper' }
      ]
    })
    expect(t.logo).toMatchObject({ file: 'compositions/outro.html', label: 'logo', movable: false, why: 'its target is computed', tweens: [] })
  })

  it('reads one file\'s inspect (an edit\'s reply)', () => {
    const t = parseInspect({ layers: [{ id: 'a', start: 0, end: 1 }] })
    expect(t.a.file).toBe('index.html')
    expect(parseInspect(null)).toEqual({})
  })
})
