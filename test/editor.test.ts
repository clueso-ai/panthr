// The real editor tool on a small composition: installs @hyperframes/parsers
// and linkedom with npm into a temp data dir, so it needs the network and
// runs only with PANTHR_EDIT_E2E=1.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: undefined, BrowserWindow: { getAllWindows: () => [] }, nativeTheme: {} }))

const root = mkdtempSync(join(tmpdir(), 'panthr-test-editor-'))
process.env.PANTHR_DATA_DIR = join(root, 'data')
const { controls, install } = await import('../src/main/controls')
afterAll(() => rmSync(root, { recursive: true, force: true }))

const HTML = `<!doctype html><html><body>
<div id="root" data-composition-id="main" data-width="1920" data-height="1080" data-duration="6">
  <h1 id="title" style="font-size: 80px">Hello</h1>
  <div id="box"></div>
</div>
<script>
  const tl = gsap.timeline({ paused: true });
  tl.from("#title", { opacity: 0, duration: 0.6 }, 0.5);
  tl.to("#box", { x: 200, duration: 1 }, 2);
  window.__timelines = { main: tl };
</script>
</body></html>`

describe.skipIf(!process.env.PANTHR_EDIT_E2E)('edit.mjs', () => {
  it('installs, inspects, moves and sets', async () => {
    const dir = join(root, 'Proj')
    mkdirSync(dir)
    writeFileSync(join(dir, 'index.html'), HTML)
    await Promise.all([install(), install()]) // serialized, not two npm runs at once
    const t = await controls.timing(dir)
    expect(t.title).toMatchObject({ file: 'index.html', start: 0.5, movable: true })
    expect(t.box.tweens[0]).toMatchObject({ start: 2, duration: 1, editable: true })
    const r = await controls.run(dir, { op: 'move', file: 'index.html', layer: 'box', delta: 1 })
    expect(r.ok).toBe(true)
    expect((await controls.timing(dir)).box.start).toBe(3)
    await controls.run(dir, { op: 'set', file: 'index.html', target: 'title', targets: ['title'], write: 'style:font-size', value: '64px' })
    expect(readFileSync(join(dir, 'index.html'), 'utf8')).toContain('64px')
    await expect(controls.run(dir, { op: 'nope' })).rejects.toThrow('unknown op nope')
  }, 180_000)
})
