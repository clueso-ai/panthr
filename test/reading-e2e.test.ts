// The reading pass on real videos (ffmpeg, uvx, hyperframes): PANTHR_READ_E2E=<dir with videos>.
import { cpSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { it, vi } from 'vitest'
vi.mock('electron', () => ({ app: undefined }))
const dir = process.env.PANTHR_READ_E2E
it.runIf(!!dir)('reads real videos', async () => {
  const R = await import('../src/main/reading')
  for (const name of readdirSync(dir!).filter((n) => n.endsWith('.mp4'))) {
    const out = join(dir!, name.replace('.mp4', '-read'))
    mkdirSync(join(out, 'frames'), { recursive: true })
    const stills = readdirSync(join(dir!, 'frames-' + name.replace('.mp4', ''))).map((f) => join(dir!, 'frames-' + name.replace('.mp4', ''), f))
    const t0 = Date.now()
    const r = await R.readVideo(out, join(dir!, name), { duration: Number(process.env['D_' + name.replace(/\W/g, '_')]), hasAudio: true, stills }, (s) => console.log(name, '…', s))
    console.log(name, `${((Date.now() - t0) / 1000).toFixed(1)}s`, JSON.stringify({ shots: r.shots.list.length, method: r.shots.method, words: r.words, text: r.textLines, bpm: r.bpm, notes: r.notes }))
    console.log(readFileSync(join(out, 'reading/README.md'), 'utf8'))
  }
}, 900_000)
