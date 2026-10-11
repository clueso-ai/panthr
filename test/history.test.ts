// Checkpoints with real git in a temp project: a turn undone exactly (an
// edit, a file it made, a file it deleted), a file changed by hand since
// left alone, redo, and caches kept out of the history.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: undefined }))
vi.mock('../src/main/bus', () => ({ emit: () => {} }))

import { checkpoints, record, snap, undo } from '../src/main/history'

const project = (): string => {
  const d = join(realpathSync(mkdtempSync(join(tmpdir(), 'panthr-history-'))), 'P')
  mkdirSync(join(d, 'Cut', 'compositions'), { recursive: true })
  writeFileSync(join(d, 'Cut', 'index.html'), 'v1')
  writeFileSync(join(d, 'Cut', 'compositions', 'old.html'), 'old')
  return d
}
const read = (p: string): string => readFileSync(p, 'utf8')

describe('checkpoints', () => {
  it('undoes a turn exactly, and redoes it', async () => {
    const d = project()
    const before = await snap(d, 'before: make it red')
    // The agent's turn: an edit, a new file, a deleted file.
    writeFileSync(join(d, 'Cut', 'index.html'), 'v2 red')
    writeFileSync(join(d, 'Cut', 'compositions', 'new.html'), 'new')
    rmSync(join(d, 'Cut', 'compositions', 'old.html'))
    const after = await snap(d, 'after: make it red')
    await record(d, { chatId: 'c', turn: 0, label: 'make it red', before: before!, after: after! })
    expect(checkpoints(d)[0].files.sort()).toEqual(['Cut/compositions/new.html', 'Cut/compositions/old.html', 'Cut/index.html'])

    const r = await undo(d, 'c', 0)
    expect(r.skipped).toEqual([])
    expect(read(join(d, 'Cut', 'index.html'))).toBe('v1')
    expect(existsSync(join(d, 'Cut', 'compositions', 'new.html'))).toBe(false)
    expect(read(join(d, 'Cut', 'compositions', 'old.html'))).toBe('old')
    expect(checkpoints(d)[0].undone).toBeTruthy()

    await undo(d, 'c', 0, true)
    expect(read(join(d, 'Cut', 'index.html'))).toBe('v2 red')
    expect(read(join(d, 'Cut', 'compositions', 'new.html'))).toBe('new')
    expect(existsSync(join(d, 'Cut', 'compositions', 'old.html'))).toBe(false)
    expect(checkpoints(d)[0].undone).toBeNull()
  })

  it('leaves a file changed by hand since the turn, and says so', async () => {
    const d = project()
    const before = await snap(d, 'before')
    writeFileSync(join(d, 'Cut', 'index.html'), 'agent')
    writeFileSync(join(d, 'Cut', 'compositions', 'old.html'), 'agent too')
    const after = await snap(d, 'after')
    await record(d, { chatId: 'c', turn: 2, label: 't', before: before!, after: after! })
    writeFileSync(join(d, 'Cut', 'index.html'), 'mine')
    const r = await undo(d, 'c', 2)
    expect(r.skipped).toEqual(['Cut/index.html'])
    expect(read(join(d, 'Cut', 'index.html'))).toBe('mine')
    expect(read(join(d, 'Cut', 'compositions', 'old.html'))).toBe('old')
  })

  it('keeps caches, exports and its own files out of the history', async () => {
    const d = project()
    const before = await snap(d, 'before')
    for (const p of ['.studio/canvas-view.json', 'Cut/.studio/frames/1/a.png', 'Cut/.studio/versions/v1.mp4', 'Cut/renders/x.mp4', 'Cut/node_modules/m/i.js', 'Cut/snapshots/s.png']) {
      mkdirSync(join(d, p, '..'), { recursive: true })
      writeFileSync(join(d, p), 'x')
    }
    writeFileSync(join(d, 'Cut', 'index.html'), 'v2')
    const after = await snap(d, 'after')
    await record(d, { chatId: 'c', turn: 0, label: 't', before: before!, after: after! })
    expect(checkpoints(d)[0].files).toEqual(['Cut/index.html'])
  })
})
