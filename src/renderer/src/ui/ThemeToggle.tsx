// One click between night and day, beside Settings (and ⇧⌘L). Settings
// still offers System, for following the Mac.

import { AnimatePresence, motion } from 'motion/react'
import { api, settingsNow, useSettings } from '@/lib/api'
import { tr, MOVE, EASE } from '@/lib/motion'
import { Icon } from './Icon'
import { Tip } from './Tooltip'

/** Is the window dark right now (System follows the Mac)? */
export const isDark = (appearance: string): boolean =>
  appearance === 'night' || (appearance === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)

type Appearance = 'system' | 'night' | 'day'

/** Change the appearance with the new look spreading out in a circle from
 *  `from` (a point in the window; default: the sun/moon button, else the
 *  top right). The page flips at once inside a view transition, so the old
 *  and new looks are two pictures and only the circle moves. */
export function setAppearance(next: Appearance, from?: { x: number; y: number }): void {
  const root = document.documentElement
  const theme = isDark(next) ? 'night' : 'day'
  const save = (): void => {
    api.settings.set({ appearance: next })
  }
  const start = (document as Document & { startViewTransition?: (f: () => void) => { ready: Promise<void> } }).startViewTransition
  if (root.dataset.theme === theme || !start || settingsNow().reduce_motion) {
    root.dataset.theme = theme
    return save()
  }
  const at = from ?? (() => {
    const b = document.querySelector('.theme-toggle')?.getBoundingClientRect()
    return b ? { x: b.left + b.width / 2, y: b.top + b.height / 2 } : { x: innerWidth - 40, y: 26 }
  })()
  const r = Math.hypot(Math.max(at.x, innerWidth - at.x), Math.max(at.y, innerHeight - at.y))
  root.dataset.switching = 'theme'
  const t = start.call(document, () => {
    root.dataset.theme = theme
  })
  t.ready.then(() => {
    root.animate(
      { clipPath: [`circle(0px at ${at.x}px ${at.y}px)`, `circle(${r}px at ${at.x}px ${at.y}px)`] },
      { duration: 620, easing: `cubic-bezier(${EASE.join(',')})`, pseudoElement: '::view-transition-new(root)' }
    ).finished.finally(() => delete root.dataset.switching)
  }).catch(() => delete root.dataset.switching)
  save()
}

export function toggleTheme(appearance: string, from?: { x: number; y: number }): void {
  setAppearance(isDark(appearance) ? 'day' : 'night', from)
}

export function ThemeToggle() {
  const s = useSettings()
  const dark = isDark(s.appearance)
  return (
    <Tip title={dark ? 'Day' : 'Night'} keys="⇧⌘L" body="Switch between light and dark.">
      <button className="icon-btn theme-toggle" aria-label="Switch between light and dark" onClick={(e) => toggleTheme(s.appearance, { x: e.clientX, y: e.clientY })}>
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={dark ? 'moon' : 'sun'}
            style={{ display: 'grid', placeItems: 'center' }}
            initial={{ opacity: 0, rotate: -60, scale: 0.7 }}
            animate={{ opacity: 1, rotate: 0, scale: 1 }}
            exit={{ opacity: 0, rotate: 60, scale: 0.7 }}
            transition={tr(MOVE)}
          >
            <Icon name={dark ? 'moon' : 'sun'} size={16} />
          </motion.span>
        </AnimatePresence>
      </button>
    </Tip>
  )
}
