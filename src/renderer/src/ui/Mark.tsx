// The Panther mark: Clueso's mark (the puzzle piece and its two stripes), in
// ember. It arrives with the stripes sliding into the corner, a light runs
// across it now and then, and while an agent works the stripes pulse in turn.

import { useEffect, useId, useRef, useState } from 'react'

/** Clueso's mark in a 100 × 100 box: the corner, the stripe, the piece. */
const CORNER = 'M97 0C98.6569 0 100 1.34315 100 3V29.0697C100 30.8515 97.8457 31.7438 96.5858 30.4839L69.5161 3.41421C68.2562 2.15428 69.1485 0 70.9303 0H97Z'
const STRIPE = 'M35.575 3.41421C34.315 2.15428 35.2074 0 36.9892 0H53.9598C54.4902 0 54.9989 0.210712 55.374 0.585784L99.4142 44.626C99.7893 45.0011 100 45.5098 100 46.0402V63.0108C100 64.7926 97.8457 65.685 96.5858 64.425L35.575 3.41421Z'
const PIECE = 'M21.4328 0.585786C21.0578 0.210714 20.5491 0 20.0186 0H3C1.34315 0 0 1.34315 0 3V30C0 31.1046 0.89543 32 2 32H6C15.9411 32 24 40.0589 24 50C24 59.9411 15.9411 68 6 68H2C0.895431 68 0 68.8954 0 70V97C0 98.6569 1.34315 100 3 100H30C31.1046 100 32 99.1046 32 98V94C32 84.0589 40.0589 76 50 76C59.9411 76 68 84.0589 68 94V98C68 99.1046 68.8954 100 70 100H97C98.6569 100 100 98.6569 100 97V79.9814C100 79.4509 99.7893 78.9422 99.4142 78.5672L21.4328 0.585786Z'

/** Ember, light in the top right to deep in the bottom left, as Clueso's pink runs. */
export const EMBER = ['#FF9A6A', '#E9440F'] as const

const f = (v: number): string => v.toFixed(2)

export function Mark({ size, slide = [0, 0, 0], dim = [1, 1, 1], light = -1, label = 'Panther' }: {
  size: number
  /** How far each part (piece, stripe, corner) is still out toward the top right, 0–1. */
  slide?: [number, number, number]
  /** Each part's opacity. */
  dim?: [number, number, number]
  /** A light running across, from bottom left (0) to top right (1); off below 0. */
  light?: number
  label?: string
}) {
  const id = useId()
  const parts = [PIECE, STRIPE, CORNER]
  const at = -40 + light * 180
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="none" style={{ display: 'block', flex: 'none', overflow: 'visible' }} aria-label={label}>
      <defs>
        <linearGradient id={`${id}g`} x1="108" y1="-8" x2="-14.5" y2="114.5" gradientUnits="userSpaceOnUse">
          <stop stopColor={EMBER[0]} />
          <stop offset="1" stopColor={EMBER[1]} />
        </linearGradient>
        {light >= 0 && (
          <linearGradient id={`${id}l`} x1={f(at - 30)} y1={f(130 - at)} x2={f(at + 30)} y2={f(70 - at)} gradientUnits="userSpaceOnUse">
            <stop stopColor="#fff" stopOpacity="0" />
            <stop offset="0.5" stopColor="#fff" stopOpacity="0.55" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </linearGradient>
        )}
      </defs>
      {parts.map((d, i) => {
        const s = slide[i] * 14
        return (
          <g key={i} transform={s ? `translate(${f(s)} ${f(-s)})` : undefined} opacity={dim[i] < 1 ? f(dim[i]) : undefined}>
            <path fillRule="evenodd" clipRule="evenodd" d={d} fill={`url(#${id}g)`} />
            {light >= 0 && <path fillRule="evenodd" clipRule="evenodd" d={d} fill={`url(#${id}l)`} />}
          </g>
        )
      })}
    </svg>
  )
}

/** A light across the mark every 5.5 s, taking its last 0.9 s. */
const SHOT_EVERY = 5.5
const SHOT_START = 4.6
const shotAt = (t: number): number => {
  const phase = t % SHOT_EVERY
  return phase > SHOT_START ? (phase - SHOT_START) / (SHOT_EVERY - SHOT_START) : -1
}

const ease = (x: number): number => {
  const t = Math.min(1, Math.max(0, x))
  return 1 - (1 - t) ** 4
}

/** The living mark: the parts slide in on arrival, a light runs across now
 *  and then, the stripes pulse in turn while `busy`. It only draws frames
 *  while something moves and sleeps between lights, so a resting window
 *  costs nothing. */
export function LiveMark({ size, busy = false, shots = true }: { size: number; busy?: boolean; shots?: boolean }) {
  const [t, setT] = useState(0)
  const t0 = useRef(performance.now())
  useEffect(() => {
    let raf = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const now = (): number => (performance.now() - t0.current) / 1000
    const tick = (): void => {
      const s = now()
      setT(s)
      if (busy || s < 1.4 || (shots && shotAt(s) >= 0)) {
        raf = requestAnimationFrame(tick)
        return
      }
      if (!shots) return
      // Still until the next light.
      const wait = (SHOT_START - (s % SHOT_EVERY)) * 1000
      timer = setTimeout(() => (raf = requestAnimationFrame(tick)), Math.max(16, wait))
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(timer)
    }
  }, [busy, shots])
  // Arrival: the piece first, then the stripe, then the corner.
  const slide = [0, 1, 2].map((i) => 1 - ease((t - 0.1 - i * 0.12) / 0.9)) as [number, number, number]
  const fade = slide.map((s) => 1 - s) as [number, number, number]
  // Working: a soft wave from the piece out to the corner.
  const dim = busy
    ? (fade.map((o, i) => o * (0.55 + 0.45 * (0.5 + 0.5 * Math.cos(t * 3.4 - i * 0.9)))) as [number, number, number])
    : fade
  const light = shots && !busy ? shotAt(t) : -1
  return <Mark size={size} slide={slide} dim={dim} light={light} />
}
