// The Panthr mark, "Cat's eye": an almond stone tilted up at the outer
// corner with one vertical slit. It opens when it appears, blinks every few
// seconds, and its slit widens (watches) while an agent thinks.

import { useEffect, useRef, useState } from 'react'

type Pt = [number, number]
const TILT = -0.21
const C: Pt = [50, 50]

/** The lens where two equal circles (centres a, b, radius r) overlap. */
function lens(a: Pt, b: Pt, r: number, n: number): Pt[] {
  const d = Math.hypot(b[0] - a[0], b[1] - a[1])
  const h = Math.sqrt(Math.max(0, r * r - (d * d) / 4))
  const mid: Pt = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
  const [ux, uy] = [(b[0] - a[0]) / d, (b[1] - a[1]) / d]
  const p: Pt = [mid[0] - uy * h, mid[1] + ux * h]
  const q: Pt = [mid[0] + uy * h, mid[1] - ux * h]
  const out: Pt[] = []
  for (const [c, from, to] of [[a, p, q], [b, q, p]] as [Pt, Pt, Pt][]) {
    let a0 = Math.atan2(from[1] - c[1], from[0] - c[0])
    let a1 = Math.atan2(to[1] - c[1], to[0] - c[0])
    if (a1 < a0) a1 += Math.PI * 2
    if (a1 - a0 > Math.PI) {
      ;[a0, a1] = [a1, a0]
      a1 += Math.PI * 2
    }
    for (let i = 0; i <= n; i++) {
      const t = a0 + ((a1 - a0) * i) / n
      out.push([c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)])
    }
  }
  return out
}

function place(pts: Pt[], open: number): string {
  return pts
    .map(([x, y], i) => {
      const dx = x - C[0]
      const dy = (y - C[1]) * open
      const px = C[0] + dx * Math.cos(TILT) - dy * Math.sin(TILT)
      const py = C[1] + dx * Math.sin(TILT) + dy * Math.cos(TILT)
      return `${i ? 'L' : 'M'}${px.toFixed(2)} ${py.toFixed(2)}`
    })
    .join('') + 'Z'
}

/** How shut the eye is at t seconds: a blink every few seconds (sin², never a jerk). */
function blinkAt(t: number): number {
  const phase = t % 4.7
  return phase > 4.44 ? Math.sin(((phase - 4.44) / 0.26) * Math.PI) ** 2 : 0
}

export function EyeMark({ width, blink = 0, watch = 0, color = 'var(--acc)', cut = 'var(--page)' }: { width: number; blink?: number; watch?: number; color?: string; cut?: string }) {
  const open = Math.max(0.05, 1 - Math.min(1, Math.max(0, blink)))
  const spread = 27 - 7 * Math.min(1, Math.max(0, watch))
  return (
    <svg width={width} height={width * 0.46} viewBox="15 34 70 32" style={{ display: 'block', flex: 'none' }} aria-label="Panthr">
      <path d={place(lens([50, 18], [50, 82], 46, 40), open)} fill={color} />
      <path d={place(lens([50 - spread, 50], [50 + spread, 50], 30, 24), open)} fill={cut} />
    </svg>
  )
}

/** The living eye: opens on arrival, blinks, watches while `busy`. */
export function LiveEye({ width, busy = false, pulse = 0 }: { width: number; busy?: boolean; pulse?: number }) {
  const [t, setT] = useState(0)
  const t0 = useRef(performance.now())
  useEffect(() => {
    let raf = 0
    const tick = (): void => {
      setT((performance.now() - t0.current) / 1000)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])
  const opening = 1 - ease((t - 0.2) / 0.8)
  const blink = Math.max(opening, blinkAt(t))
  const watch = busy ? 0.55 + 0.25 * Math.sin(t * 2.4) ** 2 : pulse
  return <EyeMark width={width} blink={blink} watch={watch} />
}

const ease = (x: number): number => {
  const t = Math.min(1, Math.max(0, x))
  return 1 - (1 - t) ** 4
}
