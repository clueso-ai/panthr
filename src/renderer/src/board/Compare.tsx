// Videos side by side, in step: one play button and one scrub bar drive
// them all. The longest sets the length; a shorter one rests on its last
// frame. A player that drifts more than a few frames from the first is
// put back in step.

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'motion/react'
import { api } from '@/lib/api'
import { tr, SETTLE } from '@/lib/motion'
import { clock } from '@/lib/format'
import { Icon } from '@/ui/Icon'
import { IconButton } from '@/ui/Controls'

type Player = { dir: string; name: string; url: string | null; d: number; t: number; ready: boolean }

export function Compare({ dirs, onClose, onPick }: { dirs: string[]; onClose(): void; onPick(dir: string): void }) {
  const [players, setPlayers] = useState<Player[]>(() => dirs.map((dir) => ({ dir, name: '', url: null, d: 0, t: 0, ready: false })))
  const frames = useRef<(HTMLIFrameElement | null)[]>([])
  const [playing, setPlaying] = useState(false)
  const [t, setT] = useState(0)
  const length = Math.max(0, ...players.map((p) => p.d))

  useEffect(() => {
    Promise.all(dirs.map(async (dir) => {
      const p = await api.projects.load(dir)
      return { dir, name: p?.meta.name ?? dir.split('/').pop() ?? dir, url: await api.projects.previewUrl(dir), d: 0, t: 0, ready: false }
    })).then(setPlayers)
  }, [dirs])

  const post = (i: number, m: Record<string, unknown>): void => frames.current[i]?.contentWindow?.postMessage({ source: 'panthr', ...m }, '*')
  const all = (m: Record<string, unknown>): void => players.forEach((_, i) => post(i, m))

  // Time and length from each player; the first one leads.
  useEffect(() => {
    const f = (e: MessageEvent): void => {
      const i = frames.current.findIndex((x) => x?.contentWindow === e.source)
      if (i < 0) return
      const m = (e.data as { __panthr?: { kind?: string; t?: number; d?: number } })?.__panthr
      if (!m) return
      if (m.kind === 'ready') {
        post(i, { op: 'pause' })
        setPlayers((ps) => ps.map((p, k) => (k === i ? { ...p, ready: true } : p)))
      } else if (m.kind === 'time') {
        // A player reporting its time is up, whether or not it said so.
        setPlayers((ps) => ps.map((p, k) => (k === i ? { ...p, t: m.t ?? p.t, d: m.d ?? p.d, ready: true } : p)))
        if (i === 0) setT(m.t ?? 0)
      }
    }
    addEventListener('message', f)
    return () => removeEventListener('message', f)
  })

  // Keep them in step while playing.
  useEffect(() => {
    if (!playing) return
    const id = setInterval(() => {
      players.forEach((p, i) => {
        if (i === 0 || !p.ready) return
        const want = Math.min(t, p.d || t)
        if (Math.abs(p.t - want) > 0.12 && t < p.d) post(i, { op: 'seek', t: want })
      })
      if (length && t >= length - 0.05) {
        setPlaying(false)
        all({ op: 'pause' })
      }
    }, 500)
    return () => clearInterval(id)
  })

  const play = (): void => {
    if (playing) {
      all({ op: 'pause' })
      setPlaying(false)
      return
    }
    const from = t >= length - 0.05 ? 0 : t
    all({ op: 'seek', t: from })
    all({ op: 'play' })
    setPlaying(true)
  }
  const seek = (to: number): void => {
    setT(to)
    players.forEach((p, i) => post(i, { op: 'seek', t: Math.min(to, p.d || to) }))
  }

  useEffect(() => {
    const k = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      } else if (e.key === ' ' && !(e.target as HTMLElement).closest('input, textarea')) {
        e.preventDefault()
        e.stopPropagation()
        play()
      }
    }
    addEventListener('keydown', k, true)
    return () => removeEventListener('keydown', k, true)
  })

  const cols = players.length <= 2 ? players.length : players.length <= 4 ? 2 : 3
  return createPortal(
    <motion.div className="compare" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={tr(SETTLE)}>
      <div className="compare-top no-drag">
        <b>Compare</b>
        <span className="faint">{players.length} videos, in step</span>
        <span className="spacer" />
        <IconButton icon="close" tip="Close" keys="esc" onClick={onClose} />
      </div>
      <div className="compare-grid" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
        {players.map((p, i) => (
          <div key={p.dir} className="compare-cell">
            <div className="compare-video">
              {p.url && <iframe ref={(el) => { frames.current[i] = el }} src={p.url} title={p.name} />}
              {!p.ready && <div className="video-wait"><span className="shine" data-text="Loading">Loading</span></div>}
            </div>
            <div className="compare-name">
              <b className="ellipsis">{p.name}</b>
              <span className="faint mono">{p.d ? clock(p.d, false) : ''}</span>
              <span className="spacer" />
              <button className="link" onClick={() => onPick(p.dir)}>Edit this one</button>
            </div>
          </div>
        ))}
      </div>
      <div className="compare-bar no-drag">
        <button className="send compare-play" onClick={play} aria-label={playing ? 'Pause' : 'Play'}><Icon name={playing ? 'pause' : 'play'} size={14} /></button>
        <span className="mono compare-time">{clock(t)} / {clock(length)}</span>
        <input className="compare-scrub" type="range" min={0} max={length || 1} step={0.01} value={Math.min(t, length || 1)} onChange={(e) => seek(+e.target.value)} />
      </div>
    </motion.div>,
    document.body
  )
}
