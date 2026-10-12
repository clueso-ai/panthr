// Recording the screen into a project: pick a screen or a window (and the
// microphone if you like), a 3-2-1, and Panthr steps aside while it records;
// the menu-bar timer or ⇧⌘2 stops it. The recording lands as a video on the
// canvas, with a card offering to make a demo of it.
//
// The recorder runs here (getDisplayMedia, MediaRecorder) and streams the
// file to main in one-second pieces; it lives outside any component, so a
// re-render never loses a take.

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import type { RecordingSource } from '@shared/types'
import { api } from '@/lib/api'
import { tr, MOVE, SETTLE } from '@/lib/motion'
import { Icon } from '@/ui/Icon'
import { IconButton, Switch } from '@/ui/Controls'
import { Tip } from '@/ui/Tooltip'

type Done = { dir: string; name: string; seconds: number }

/** The take in progress (module-level: it outlives any component). */
let current: { id: string; rec: MediaRecorder; streams: MediaStream[]; queue: Promise<unknown>; mic: boolean; onDone: (d: Done | null, err?: string) => void } | null = null

api.on('recorder:stop', ({ id }) => {
  if (current?.id === id && current.rec.state !== 'inactive') current.rec.stop()
})

async function record(canvas: string, source: RecordingSource, mic: boolean, onDone: (d: Done | null, err?: string) => void): Promise<void> {
  const { id } = await api.recorder.begin(canvas, source.id)
  const streams: MediaStream[] = []
  try {
    const screen = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false })
    streams.push(screen)
    const tracks = [...screen.getVideoTracks()]
    if (mic) {
      const voice = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
      streams.push(voice)
      tracks.push(...voice.getAudioTracks())
    }
    const type = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp9', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t))
    const rec = new MediaRecorder(new MediaStream(tracks), { mimeType: type, videoBitsPerSecond: 10_000_000 })
    const take = { id, rec, streams, queue: Promise.resolve() as Promise<unknown>, mic, onDone }
    current = take
    rec.ondataavailable = (e) => {
      if (!e.data.size) return
      take.queue = take.queue.then(async () => api.recorder.chunk(id, new Uint8Array(await e.data.arrayBuffer())))
    }
    rec.onstart = () => void api.recorder.started(id)
    rec.onstop = async () => {
      for (const s of streams) s.getTracks().forEach((t) => t.stop())
      await take.queue
      current = null
      try {
        const dir = await api.recorder.finish(id, mic)
        const p = await api.projects.load(dir)
        onDone({ dir, name: p?.meta.name ?? 'Recording', seconds: 0 })
      } catch (e) {
        onDone(null, (e as Error).message)
      }
    }
    rec.start(1000)
  } catch (e) {
    for (const s of streams) s.getTracks().forEach((t) => t.stop())
    current = null
    await api.recorder.cancel(id)
    throw e
  }
}

/** The Record button on the canvas, and everything after it. */
export function RecordButton({ canvas, onAsk, onActivate }: { canvas: string; onAsk(text: string): void; onActivate(dir: string): void }) {
  const [open, setOpen] = useState(false)
  const [count, setCount] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [done, setDone] = useState<Done | null>(null)
  const [error, setError] = useState<string | null>(null)
  const start = async (source: RecordingSource, mic: boolean): Promise<void> => {
    setOpen(false)
    setError(null)
    for (let n = 3; n > 0; n--) {
      setCount(n)
      await new Promise((r) => setTimeout(r, 800))
    }
    setCount(null)
    try {
      await record(canvas, source, mic, (d, err) => {
        setSaving(false)
        if (d) {
          setDone(d)
          onActivate(d.dir)
        } else setError(err ?? 'The recording could not be saved')
      })
    } catch (e) {
      setError(`Could not record: ${(e as Error).message}. Panthr needs Screen Recording in System Settings › Privacy & Security.`)
    }
  }
  // Once it stops, the saving takes a moment (converting, finding the dead time).
  useEffect(() => api.on('recorder:stop', () => setSaving(true)), [])
  return (
    <>
      <Tip title="Record" keys="⇧⌘2 stops" body="Record your screen or a window into this project, then have the agent make a demo of it.">
        <button className="board-tool" onClick={() => setOpen(true)}><Icon name="record" size={15} /><span>Record</span></button>
      </Tip>
      {createPortal(
        <>
          <AnimatePresence>{open && <RecordSheet onClose={() => setOpen(false)} onStart={start} />}</AnimatePresence>
          <AnimatePresence>
            {count != null && (
              <motion.div className="rec-count" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={tr(MOVE)}>
                <motion.b key={count} initial={{ scale: 1.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={tr(SETTLE)}>{count}</motion.b>
                <span>Recording starts. Panthr steps aside; stop it from the menu bar or with ⇧⌘2.</span>
              </motion.div>
            )}
          </AnimatePresence>
          <AnimatePresence>
            {(saving || done || error) && (
              <motion.div className="rec-card" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} transition={tr(SETTLE)}>
                {saving && !done && !error && <span className="shine" data-text="Saving the recording…">Saving the recording…</span>}
                {error && (
                  <>
                    <span className="rec-err">{error}</span>
                    <IconButton icon="close" tip="Close" onClick={() => setError(null)} />
                  </>
                )}
                {done && (
                  <>
                    <div className="rec-words"><b>{done.name}</b><span className="faint">On the canvas. The clicks and the dead time are noted for the agent.</span></div>
                    <button className="btn small primary" onClick={() => {
                      onAsk(`Turn "${done.name}" into a product demo of about 45 seconds: cut the dead time, zoom in on each click, add a short caption for each step, and a title card at the start. Make it its own tile first with \`panthr board new "${done.name} demo" --from "${done.name}"\` and build it there; leave the recording as it is.`)
                      setDone(null)
                    }}>Make it a demo</button>
                    <IconButton icon="close" tip="Keep it as it is" onClick={() => setDone(null)} />
                  </>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </>,
        document.body
      )}
    </>
  )
}

function RecordSheet({ onClose, onStart }: { onClose(): void; onStart(s: RecordingSource, mic: boolean): void }) {
  const [list, setList] = useState<RecordingSource[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pick, setPick] = useState<string | null>(null)
  const [mic, setMic] = useState(false)
  useEffect(() => {
    api.recorder.sources().then((l) => {
      setList(l)
      setPick(l.find((s) => s.kind === 'screen')?.id ?? l[0]?.id ?? null)
    }).catch((e) => setError(`${(e as Error).message}. Panthr needs Screen Recording in System Settings › Privacy & Security.`))
  }, [])
  useEffect(() => {
    const k = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    addEventListener('keydown', k, true)
    return () => removeEventListener('keydown', k, true)
  }, [onClose])
  const chosen = list?.find((s) => s.id === pick) ?? null
  const groups: [string, RecordingSource[]][] = [['Screens', list?.filter((s) => s.kind === 'screen') ?? []], ['Windows', list?.filter((s) => s.kind === 'window') ?? []]]
  return (
    <motion.div className="sheet-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={tr(MOVE)} onClick={onClose}>
      <motion.div className="rec-sheet" initial={{ opacity: 0, y: 12, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 8, scale: 0.98 }} transition={tr(SETTLE)} onClick={(e) => e.stopPropagation()}>
        <div className="rec-head">
          <b>Record your screen</b>
          <span className="faint">It lands on this canvas; the agent can make a demo of it.</span>
          <div className="refs-sheet-close"><IconButton icon="close" tip="Close" keys="esc" onClick={onClose} /></div>
        </div>
        {error && <div className="rec-err">{error}</div>}
        {!list && !error && <div className="faint rec-wait">Looking for screens and windows…</div>}
        <div className="rec-body">
          {groups.map(([title, items]) => items.length > 0 && (
            <section key={title}>
              <h4>{title}</h4>
              <div className="rec-grid">
                {items.map((s) => (
                  <button key={s.id} className={`rec-src${pick === s.id ? ' on' : ''}`} onClick={() => setPick(s.id)} onDoubleClick={() => onStart(s, mic)}>
                    <img src={s.thumb} alt="" />
                    <span className="ellipsis">{s.name}</span>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
        <div className="rec-go">
          <label className="rec-mic"><Switch on={mic} onChange={setMic} small /> Record my voice too</label>
          <span className="spacer" />
          <button className="btn primary" disabled={!chosen} onClick={() => chosen && onStart(chosen, mic)}><Icon name="record" size={13} /> Start recording</button>
        </div>
      </motion.div>
    </motion.div>
  )
}
