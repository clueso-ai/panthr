// Transcripts found in a video's folder, and words fixed by hand.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: undefined, BrowserWindow: { getAllWindows: () => [] }, nativeTheme: {} }))
const { transcripts, saveWords } = await import('../src/main/captions')
const root = mkdtempSync(join(tmpdir(), 'panthr-test-captions-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('transcripts', () => {
  it('finds timed words, transcript.json first, and keeps the rest of a file', () => {
    mkdirSync(join(root, 'assets'))
    writeFileSync(join(root, 'transcript.json'), JSON.stringify([{ id: 'w0', text: 'Helo', start: 0, end: 0.4, confidence: 0.6 }, { id: 'w1', text: 'world', start: 0.5, end: 1 }]))
    writeFileSync(join(root, 'assets', 'other.json'), JSON.stringify({ words: [{ text: 'a', start: 0, end: 1 }, { text: 'b', start: 1, end: 2 }, { text: 'c', start: 2, end: 3 }] }))
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'x' }))
    const t = transcripts(root)
    expect(t.map((x) => x.file)).toEqual(['transcript.json', 'assets/other.json'])
    expect(t[1].words[2]).toEqual({ id: 'w2', text: 'c', start: 2, end: 3 })
    const r = saveWords(root, 'transcript.json', [{ id: 'w0', text: 'Hello', start: 0, end: 0.4 }])
    const v = JSON.parse(readFileSync(join(root, 'transcript.json'), 'utf8'))
    expect(v[0]).toEqual({ id: 'w0', text: 'Hello', start: 0, end: 0.4, confidence: 0.6 })
    expect(v[1].text).toBe('world')
    expect(r.before).toContain('Helo')
    expect(() => saveWords(root, '../x.json', [])).toThrow('outside')
  })
})
