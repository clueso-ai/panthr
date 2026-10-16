// The Panther mark, "Shutter": a camera iris of six curved blades in two
// tones of the accent, cut apart by thin lines of the ground. It opens when
// it appears, fires a quick shot every few seconds, and breathes (opening
// and closing, turning slowly) while an agent works.

import { useEffect, useId, useRef, useState } from 'react'

const BLADES = 6
/** How far each blade's edge turns from the radius, and how much it bows. */
const TWIST = (100 * Math.PI) / 180
const BOW = 7
/** The aperture at rest (the blades' inner corners, from the centre). */
export const OPEN = 11

const f = (v: number): string => v.toFixed(2)

/** The blades' outlines for an aperture (0: shut). */
function blades(open: number): string[] {
  const out: string[] = []
  for (let i = 0; i < BLADES; i++) {
    const step = (2 * Math.PI) / BLADES
    const a = i * step - Math.PI / 2
    const a2 = a + step
    const p = [50 + open * Math.cos(a), 50 + open * Math.sin(a)]
    const q = [50 + open * Math.cos(a2), 50 + open * Math.sin(a2)]
    const d = a + TWIST
    const d2 = a2 + TWIST
    const far = [p[0] + 60 * Math.cos(d), p[1] + 60 * Math.sin(d)]
    const far2 = [q[0] + 60 * Math.cos(d2), q[1] + 60 * Math.sin(d2)]
    // Both long edges bow the same way, so neighbouring blades meet exactly.
    const c = [(p[0] + far[0]) / 2 + Math.cos(d + Math.PI / 2) * BOW, (p[1] + far[1]) / 2 + Math.sin(d + Math.PI / 2) * BOW]
    const c2 = [(q[0] + far2[0]) / 2 + Math.cos(d2 + Math.PI / 2) * BOW, (q[1] + far2[1]) / 2 + Math.sin(d2 + Math.PI / 2) * BOW]
    out.push(`M${f(p[0])} ${f(p[1])}Q${f(c[0])} ${f(c[1])} ${f(far[0])} ${f(far[1])}L${f(far2[0])} ${f(far2[1])}Q${f(c2[0])} ${f(c2[1])} ${f(q[0])} ${f(q[1])}Z`)
  }
  return out
}

const REST = blades(OPEN)

export function Mark({ size, open = OPEN, turn = 0, color = 'var(--acc)', shade = 'var(--acc-deep)', cut = 'var(--page)' }: {
  size: number
  /** The aperture: 0 is shut, OPEN at rest. */
  open?: number
  /** Degrees the blades have turned. */
  turn?: number
  color?: string
  shade?: string
  /** The lines between the blades: the colour of what the mark sits on. */
  cut?: string
}) {
  const id = useId()
  const paths = open === OPEN ? REST : blades(open)
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" style={{ display: 'block', flex: 'none' }} aria-label="Panther">
      <defs>
        <clipPath id={id}><circle cx="50" cy="50" r="44" /></clipPath>
      </defs>
      <g clipPath={`url(#${id})`}>
        <g transform={turn ? `rotate(${f(turn)} 50 50)` : undefined}>
          {paths.map((d, i) => (
            <path key={i} d={d} fill={i % 2 ? shade : color} stroke={cut} strokeWidth={2.4} strokeLinejoin="round" />
          ))}
        </g>
      </g>
    </svg>
  )
}

/** A shot every 4.7 s: the blades snap shut and open again over its last 0.3 s. */
const SHOT_EVERY = 4.7
const SHOT_START = 4.4
function shotAt(t: number): number {
  const phase = t % SHOT_EVERY
  return phase > SHOT_START ? Math.sin(((phase - SHOT_START) / (SHOT_EVERY - SHOT_START)) * Math.PI) ** 2 : 0
}

const ease = (x: number): number => {
  const t = Math.min(1, Math.max(0, x))
  return 1 - (1 - t) ** 4
}

/** The living mark: opens on arrival, fires a shot now and then, breathes
 *  while `busy`. It only draws frames while something moves and sleeps
 *  between shots, so a resting window costs nothing. */
export function LiveMark({ size, busy = false, cut, shots = true }: { size: number; busy?: boolean; cut?: string; shots?: boolean }) {
  const [t, setT] = useState(0)
  const t0 = useRef(performance.now())
  useEffect(() => {
    let raf = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const now = (): number => (performance.now() - t0.current) / 1000
    const tick = (): void => {
      const s = now()
      setT(s)
      if (busy || s < 1.2 || (shots && (shotAt(s) > 0 || s % SHOT_EVERY > SHOT_START - 0.02))) {
        raf = requestAnimationFrame(tick)
        return
      }
      if (!shots) return
      // Still until the next shot.
      const wait = (SHOT_START - (s % SHOT_EVERY)) * 1000
      timer = setTimeout(() => (raf = requestAnimationFrame(tick)), Math.max(16, wait))
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(timer)
    }
  }, [busy, shots])
  const arrive = ease((t - 0.15) / 1)
  const shot = shots ? shotAt(t) : 0
  const breathe = busy ? 0.45 * Math.sin(t * 2.2) ** 2 : 0
  const open = OPEN * arrive * (1 - 0.85 * shot) * (1 - breathe)
  const turn = (1 - arrive) * -60 + (busy ? t * 24 : 0)
  return <Mark size={size} open={open} turn={turn} cut={cut} />
}
