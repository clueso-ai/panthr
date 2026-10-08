// One curve, three lengths (seconds), shared with tokens.css.
import { settingsNow } from './api'

export const EASE = [0.25, 1, 0.5, 1] as const
export const QUICK = 0.16
export const MOVE = 0.24
export const SETTLE = 0.42

/** A transition of `d` seconds on the house curve (none with Reduce motion). */
export const tr = (d: number = MOVE, delay = 0) => ({ duration: settingsNow().reduce_motion ? 0 : d, ease: EASE, delay })

/** How an element enters: rising a few points as it fades in. */
export const rise = (y = 8, d: number = MOVE, delay = 0) => ({
  initial: { opacity: 0, y },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: y / 2 },
  transition: tr(d, delay)
})
