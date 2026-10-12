// Recording the screen into a project: pick a screen or a window (and the
// microphone if you like), a 3-2-1, and Panthr steps aside while it records;
// the menu-bar timer or ⇧⌘2 stops it. The recording lands as a video on the
// canvas, with a card offering to make a demo of it. From Home it goes into
// a new project, opened when it lands.
//
// The recorder runs here (getDisplayMedia, MediaRecorder) and streams the
// file to main in one-second pieces. It and everything around it (the
// sheet, the 3-2-1, the card) live outside any one screen, in
// RecordOverlay at the top of the app, so going from Home to the project
// loses nothing.

import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { RecordingSource } from '@shared/types'
import { api } from '@/lib/api'
import { tr, MOVE, SETTLE } from '@/lib/motion'
import { Icon } from '@/ui/Icon'
import { IconButton, Switch } from '@/ui/Controls'
import { Tip } from '@/ui/Tooltip'

// ── The take, and what is shown about it ───────────────────────────────

interface State {
  /** The picker is open, for this project (null: a new one, from Home). */
  sheet: { canvas: string | null } | null
  count: number | null
  saving: boolean
  done: { canvas: string; dir: string; name: string } | null
  error: string | null
}

let state: State = { sheet: null, count: null, saving: false, done: null, error: null }
const subs = new Set<(s: State) => void>()
const set = (p: Partial<State>): void => {
  state = { ...state, ...p }
  subs.forEach((f) => f(state))
}

/** Open the picker: recording into this project, or (null) into a new one. */
export const openRecorder = (canvas: string | null): void => set({ sheet: { canvas }, error: null })

let current: { id: string; rec: MediaRecorder } | null = null

api.on('recorder:stop', ({ id }) => {
  if (current?.id === id && current.rec.state !== 'inactive') {
    set({ saving: true })
    current.rec.stop()
  }
})

const day = (): string => new Date().toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

async function start(target: string | null, source: RecordingSource, mic: boolean): Promise<void> {
  set({ sheet: null, error: null, done: null })
  for (let n = 3; n > 0; n--) {
    set({ count: n })
    await new Promise((r) => setTimeout(r, 800))
  }
  set({ count: null })
  const canvas = target ?? (await api.canvases.create(`Screen recording · ${day()}`)).dir
  const { id } = await api.recorder.begin(canvas, source.id)
  const streams: MediaStream[] = []
  const stopAll = (): void => streams.forEach((s) => s.getTracks().forEach((t) => t.stop()))
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
    let queue: Promise<unknown> = Promise.resolve()
    current = { id, rec }
    rec.ondataavailable = (e) => {
      if (!e.data.size) return
      queue = queue.then(async () => api.recorder.chunk(id, new Uint8Array(await e.data.arrayBuffer())))
    }
    rec.onstart = () => void api.recorder.started(id)
    rec.onstop = async () => {
      stopAll()
      await queue
      current = null
      try {
        const dir = await api.recorder.finish(id, mic)
        const p = await api.projects.load(dir)
        set({ saving: false, done: { canvas, dir, name: p?.meta.name ?? 'Recording' } })
        // From Home: its new project opens, with the recording chosen.
        if (!target) dispatchEvent(new CustomEvent('panthr:open-project', { detail: dir }))
      } catch (e) {
        set({ saving: false, error: (e as Error).message })
      }
    }
    rec.start(1000)
  } catch (e) {
    stopAll()
    current = null
    await api.recorder.cancel(id)
    set({ error: `Could not record: ${(e as Error).message}. Panthr needs Screen Recording in System Settings › Privacy & Security.` })
  }
}

/** The demo, asked of the project's agent (its newest conversation). */
async function makeDemo(d: NonNullable<State['done']>): Promise<void> {
  const p = await api.projects.load(d.canvas)
  const chatId = p?.meta.chats.at(-1)?.id ?? (await api.chats.create(d.canvas))
  dispatchEvent(new CustomEvent('panthr:open-project', { detail: d.dir }))
  await api.chats.send(d.canvas, chatId, `Turn "${d.name}" into a product demo of about 45 seconds: cut the dead time, zoom in on each click, add a short caption for each step, and a title card at the start. Make it its own tile first with \`panthr board new "${d.name} demo" --from "${d.name}"\` and build it there; leave the recording as it is.`)
}

function useRecordState(): State {
  const [s, setS] = useState(state)
  useEffect(() => {
    subs.add(setS)
    return () => {
      subs.delete(setS)
    }
  }, [])
  return s
}

// ── What is shown ──────────────────────────────────────────────────────

/** The Record button on a project's canvas. */
export function RecordButton({ canvas }: { canvas: string }) {
  return (
    <Tip title="Record" keys="⇧⌘2 stops" body="Record your screen or a window into this project, then have the agent make a demo of it.">
      <button className="board-tool" onClick={() => openRecorder(canvas)}><Icon name="record" size={15} /><span>Record</span></button>
    </Tip>
  )
}

/** The picker, the 3-2-1 and the card: once, at the top of the app. */
export function RecordOverlay() {
  const s = useRecordState()
  return (
    <>
      <AnimatePresence>{s.sheet && <RecordSheet fromHome={!s.sheet.canvas} onClose={() => set({ sheet: null })} onStart={(src, mic) => void start(s.sheet!.canvas, src, mic)} />}</AnimatePresence>
      <AnimatePresence>
        {s.count != null && (
          <motion.div className="rec-count" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={tr(MOVE)}>
            <motion.b key={s.count} initial={{ scale: 1.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={tr(SETTLE)}>{s.count}</motion.b>
            <span>Recording starts. Panthr steps aside; stop it from the menu bar or with ⇧⌘2.</span>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {(s.saving || s.done || s.error) && (
          <motion.div className="rec-card" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} transition={tr(SETTLE)}>
            {s.saving && !s.done && !s.error && <span className="shine" data-text="Saving the recording…">Saving the recording…</span>}
            {s.error && (
              <>
                <span className="rec-err">{s.error}</span>
                <IconButton icon="close" tip="Close" onClick={() => set({ error: null })} />
              </>
            )}
            {s.done && (
              <>
                <div className="rec-words"><b>{s.done.name}</b><span className="faint">On the canvas. The clicks and the dead time are noted for the agent.</span></div>
                <button className="btn small primary" onClick={() => {
                  const d = s.done!
                  set({ done: null })
                  void makeDemo(d)
                }}>Make it a demo</button>
                <IconButton icon="close" tip="Keep it as it is" onClick={() => set({ done: null })} />
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}

function RecordSheet({ fromHome, onClose, onStart }: { fromHome: boolean; onClose(): void; onStart(s: RecordingSource, mic: boolean): void }) {
  const [list, setList] = useState<RecordingSource[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pick, setPick] = useState<string | null>(null)
  const [mic, setMic] = useState(false)
  const [access, setAccess] = useState<{ screen: string; microphone: string } | null>(null)
  const [relaunchErr, setRelaunchErr] = useState<string | null>(null)
  useEffect(() => {
    // Asking for the list is what makes macOS ask the first time; then what it said.
    api.recorder.sources().then((l) => {
      setList(l)
      setPick(l.find((s) => s.kind === 'screen')?.id ?? l[0]?.id ?? null)
    }).catch((e) => setError((e as Error).message)).finally(() => api.recorder.access().then(setAccess))
  }, [])
  // Back from System Settings: look again.
  useEffect(() => {
    const f = (): void => void api.recorder.access().then(setAccess)
    addEventListener('focus', f)
    return () => removeEventListener('focus', f)
  }, [])
  const blocked = access && access.screen !== 'granted'
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
          <span className="faint">{fromHome ? 'It goes into a new project; the agent can make a demo of it.' : 'It lands on this canvas; the agent can make a demo of it.'}</span>
          <div className="refs-sheet-close"><IconButton icon="close" tip="Close" keys="esc" onClick={onClose} /></div>
        </div>
        {blocked ? (
          <div className="rec-perm">
            <b>Panthr needs permission to record your screen</b>
            <ol>
              <li>
                Open Screen Recording in System Settings.
                <button className="btn small" onClick={() => api.recorder.openPrivacy('screen')}>Open Screen Recording</button>
              </li>
              <li>Turn Panthr on. If Panthr is listed more than once (an older copy), remove those with − and turn this one on, or add it with +.</li>
              <li>
                Relaunch Panthr: macOS only applies it to a fresh start.
                <button className="btn small primary" onClick={() => api.recorder.relaunch().catch((e) => setRelaunchErr((e as Error).message))}>Relaunch Panthr</button>
              </li>
            </ol>
            {relaunchErr && (
              <div className="rec-err">
                {relaunchErr}. <button className="link" onClick={() => api.recorder.relaunch(true)}>Relaunch anyway</button>
              </div>
            )}
          </div>
        ) : (
          <>
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
          </>
        )}
        {mic && access?.microphone === 'denied' && (
          <div className="rec-err">The microphone is off for Panthr. <button className="link" onClick={() => api.recorder.openPrivacy('microphone')}>Turn it on in System Settings</button>, then relaunch Panthr.</div>
        )}
        <div className="rec-go">
          <label className="rec-mic"><Switch on={mic} onChange={setMic} small /> Record my voice too</label>
          <span className="spacer" />
          <button className="btn primary" disabled={!chosen || !!blocked} onClick={() => chosen && onStart(chosen, mic)}><Icon name="record" size={13} /> Start recording</button>
        </div>
      </motion.div>
    </motion.div>
  )
}
