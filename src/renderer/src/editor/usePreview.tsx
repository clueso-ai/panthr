// The preview iframe's conversation with the app. The page (bridge.js)
// reports time, scenes, layers, size and pen strokes; the picker reports
// what was clicked. The app sends playback, pick-mode, highlight and
// describe commands back.
//
// Two frames, one shown: a reload (the files changed) loads into the
// hidden one, which takes over once its video is ready, so the picture
// never goes blank while a page and its 3D scenes start up again.

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
  /** The frame shown now. */
  frame: { readonly current: HTMLIFrameElement | null }
  /** Both frames, for rendering (see PreviewFrames). */
  frames: [React.RefObject<HTMLIFrameElement | null>, React.RefObject<HTMLIFrameElement | null>]
  srcs: [string | null, string | null]
  front: 0 | 1
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
  /** Skimming: the picture shows `t` (one seek per frame at most) while the
   *  playhead keeps its place; null ends it and the picture goes back. */
  skim(t: number | null): void
  /** Load the page again at the same moment (its files changed), behind
   *  the one shown; it takes over when ready. */
  reload(): void
}

const EMPTY: PreviewState = { time: 0, playing: false, duration: 0, scenes: [], layers: [], size: null, ready: false, error: null }

export function usePreview(url: string | null, handlers: {
  onPicked?: (p: Picked) => void
  onPen?: (strokes: [number, number][][]) => void
  /** The shown page is ready for commands (a new page, or one just swapped in). */
  onReady?: () => void
}): PreviewApi {
  const a = useRef<HTMLIFrameElement>(null)
  const b = useRef<HTMLIFrameElement>(null)
  const [front, setFront] = useState<0 | 1>(0)
  const frontRef = useRef<0 | 1>(0)
  frontRef.current = front
  const [srcs, setSrcs] = useState<[string | null, string | null]>([url, null])
  /** The hidden frame is loading a newer page. */
  const pending = useRef(false)
  const [state, setState] = useState<PreviewState>(EMPTY)
  const live = useRef({ t: 0, at: performance.now(), playing: false, duration: 0 })
  const h = useRef(handlers)
  h.current = handlers
  /** While skimming: where the playhead is, and the moment to show next. */
  const skimming = useRef<{ from: number; next: number | null; raf: number } | null>(null)

  const el = (i: 0 | 1): HTMLIFrameElement | null => (i === 0 ? a.current : b.current)
  const shown = (): HTMLIFrameElement | null => el(frontRef.current)

  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      const f = frontRef.current
      const fromFront = !!el(f) && e.source === el(f)!.contentWindow
      const back = (1 - f) as 0 | 1
      const fromBack = pending.current && !!el(back) && e.source === el(back)!.contentWindow
      if (!fromFront && !fromBack) return
      const d = e.data
      if (!d || typeof d !== 'object') return
      const m = d.__panthr
      if (fromBack) {
        // The new page: its first moment of video means it is ready to show.
        if (m?.kind === 'time') {
          pending.current = false
          frontRef.current = back
          setFront(back)
          live.current = { t: m.t, at: performance.now(), playing: m.playing, duration: m.d }
          setState((s) => ({ ...s, time: m.t, playing: m.playing, duration: m.d, ready: true, error: null }))
          // The old one empties once it has faded out.
          setTimeout(() => setSrcs((x) => { const n = [...x] as [string | null, string | null]; n[f] = null; return n }), 400)
          h.current.onReady?.()
        } else if (m && (m.kind === 'layers' || m.kind === 'size' || m.kind === 'scenes')) {
          setState((s) => (m.kind === 'layers' ? { ...s, layers: m.layers } : m.kind === 'size' ? { ...s, size: [m.w, m.h] } : { ...s, scenes: m.scenes }))
        }
        return
      }
      if (m) {
        switch (m.kind) {
          case 'time':
            // Skimming moves the picture, not the playhead.
            if (skimming.current) break
            live.current = { t: m.t, at: performance.now(), playing: m.playing, duration: m.d }
            setState((s) => (s.time === m.t && s.playing === m.playing && s.duration === m.d && s.ready ? s : { ...s, time: m.t, playing: m.playing, duration: m.d, ready: true }))
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

  // A new project: start over, in the first frame.
  useEffect(() => {
    setState(EMPTY)
    live.current = { t: 0, at: performance.now(), playing: false, duration: 0 }
    pending.current = false
    frontRef.current = 0
    setFront(0)
    setSrcs([url, null])
  }, [url])

  const send = useCallback((m: Record<string, unknown>) => shown()?.contentWindow?.postMessage({ source: 'panthr', ...m }, '*'), []) // eslint-disable-line react-hooks/exhaustive-deps
  const post = useCallback((m: Record<string, unknown>) => shown()?.contentWindow?.postMessage({ ...m, source: 'clueso-editor' }, '*'), []) // eslint-disable-line react-hooks/exhaustive-deps

  const now = useCallback(() => {
    const l = live.current
    const t = l.playing ? l.t + (performance.now() - l.at) / 1000 : l.t
    return Math.min(t, l.duration || t)
  }, [])

  const reload = useCallback(() => {
    if (!url) return
    const l = live.current
    const back = (1 - frontRef.current) as 0 | 1
    pending.current = true
    const src = `${url}?r=${Date.now()}#t=${now().toFixed(3)}&p=${l.playing ? 1 : 0}`
    setSrcs((x) => { const n = [...x] as [string | null, string | null]; n[back] = src; return n })
    // A page that never gets ready (a script error): shown anyway, so its error shows.
    setTimeout(() => {
      if (pending.current && frontRef.current !== back) {
        pending.current = false
        frontRef.current = back
        setFront(back)
      }
    }, 8000)
  }, [url, now])

  return {
    frame: { get current() { return shown() } },
    frames: [a, b],
    srcs,
    front,
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
    skim: (t: number | null) => {
      const sk = skimming.current
      if (t === null) {
        if (!sk) return
        cancelAnimationFrame(sk.raf)
        skimming.current = null
        send({ op: 'seek', t: sk.from })
        return
      }
      if (!sk) {
        skimming.current = { from: now(), next: t, raf: 0 }
      } else sk.next = t
      const s2 = skimming.current!
      if (s2.raf) return
      // One seek per frame: the newest pointer position wins.
      s2.raf = requestAnimationFrame(() => {
        const cur = skimming.current
        if (!cur) return
        cur.raf = 0
        if (cur.next !== null) send({ op: 'seek', t: cur.next })
        cur.next = null
      })
    },
    pen: (on: boolean) => send({ op: 'pen', on }),
    penClear: () => send({ op: 'pen-clear' }),
    penUndo: () => send({ op: 'pen-undo' }),
    reload
  }
}

/** The two frames, stacked; the one shown fades in over the other. */
export function PreviewFrames({ preview }: { preview: PreviewApi }) {
  return (
    <>
      {([0, 1] as const).map((i) =>
        preview.srcs[i] ? (
          <iframe
            key={i}
            ref={preview.frames[i]}
            src={preview.srcs[i]!}
            title="Preview"
            className={`preview-frame${preview.front === i ? ' front' : ''}`}
          />
        ) : null
      )}
    </>
  )
}
