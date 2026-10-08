// The preview iframe's conversation with the app. The page (bridge.js)
// reports time, scenes, layers, size and pen strokes; the picker reports
// what was clicked. The app sends playback, pick-mode, highlight and
// describe commands back.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Layer, Picked, Scene } from '@shared/types'

export interface PreviewState {
  time: number
  playing: boolean
  duration: number
  scenes: Scene[]
  layers: Layer[]
  size: [number, number] | null
  ready: boolean
  error: string | null
}

export interface PreviewApi {
  frame: React.RefObject<HTMLIFrameElement | null>
  state: PreviewState
  /** The time right now, between reports (playing advances it). */
  now(): number
  play(): void
  pause(): void
  seek(t: number): void
  /** A command for the picker (pick, highlight, describe, set, ...). */
  post(msg: Record<string, unknown>): void
  pen(on: boolean): void
  penClear(): void
  penUndo(): void
  /** Load the page again at the same moment (its files changed). */
  reload(): void
}

const EMPTY: PreviewState = { time: 0, playing: false, duration: 0, scenes: [], layers: [], size: null, ready: false, error: null }

export function usePreview(url: string | null, handlers: {
  onPicked?: (p: Picked) => void
  onPen?: (strokes: [number, number][][]) => void
  onReady?: () => void
}): PreviewApi {
  const frame = useRef<HTMLIFrameElement>(null)
  const [state, setState] = useState<PreviewState>(EMPTY)
  const live = useRef({ t: 0, at: performance.now(), playing: false, duration: 0 })
  const h = useRef(handlers)
  h.current = handlers

  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      if (!frame.current || e.source !== frame.current.contentWindow) return
      const d = e.data
      if (!d || typeof d !== 'object') return
      const m = d.__panthr
      if (m) {
        switch (m.kind) {
          case 'time':
            live.current = { t: m.t, at: performance.now(), playing: m.playing, duration: m.d }
            setState((s) => (s.time === m.t && s.playing === m.playing && s.duration === m.d ? s : { ...s, time: m.t, playing: m.playing, duration: m.d, ready: true }))
            break
          case 'scenes': setState((s) => ({ ...s, scenes: m.scenes })); break
          case 'layers': setState((s) => ({ ...s, layers: m.layers })); break
          case 'size': setState((s) => ({ ...s, size: [m.w, m.h] })); break
          case 'error': setState((s) => ({ ...s, error: m.message })); break
          case 'pen': h.current.onPen?.(m.strokes); break
          case 'editor': if (m.data?.type === 'picked') h.current.onPicked?.(m.data); break
        }
        return
      }
      // The picker talks to its parent directly.
      if (d.source === 'clueso-editor') {
        if (d.type === 'picked') h.current.onPicked?.(d as Picked)
        else if (d.type === 'ready') h.current.onReady?.()
        else if (d.type === 'script-error') setState((s) => ({ ...s, error: d.message }))
      }
    }
    addEventListener('message', onMessage)
    return () => removeEventListener('message', onMessage)
  }, [])

  // A new project: start over.
  useEffect(() => {
    setState(EMPTY)
    live.current = { t: 0, at: performance.now(), playing: false, duration: 0 }
  }, [url])

  const send = useCallback((m: Record<string, unknown>) => frame.current?.contentWindow?.postMessage({ source: 'panthr', ...m }, '*'), [])
  const post = useCallback((m: Record<string, unknown>) => frame.current?.contentWindow?.postMessage({ ...m, source: 'clueso-editor' }, '*'), [])

  const now = useCallback(() => {
    const l = live.current
    const t = l.playing ? l.t + (performance.now() - l.at) / 1000 : l.t
    return Math.min(t, l.duration || t)
  }, [])

  return {
    frame,
    state,
    now,
    play: () => send({ op: 'play' }),
    pause: () => send({ op: 'pause' }),
    seek: (t: number) => {
      live.current = { ...live.current, t, at: performance.now() }
      setState((s) => ({ ...s, time: t }))
      send({ op: 'seek', t })
    },
    post,
    pen: (on: boolean) => send({ op: 'pen', on }),
    penClear: () => send({ op: 'pen-clear' }),
    penUndo: () => send({ op: 'pen-undo' }),
    reload: () => {
      const f = frame.current
      if (!f || !url) return
      const l = live.current
      f.src = `${url}?r=${Date.now()}#t=${now().toFixed(3)}&p=${l.playing ? 1 : 0}`
    }
  }
}
