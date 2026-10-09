// One click between night and day, beside Settings (and ⇧⌘L). Settings
// still offers System, for following the Mac.

import { AnimatePresence, motion } from 'motion/react'
import { api, useSettings } from '@/lib/api'
import { tr, MOVE } from '@/lib/motion'
import { Icon } from './Icon'
import { Tip } from './Tooltip'

/** Is the window dark right now (System follows the Mac)? */
export const isDark = (appearance: string): boolean =>
  appearance === 'night' || (appearance === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)

export function toggleTheme(appearance: string): void {
  api.settings.set({ appearance: isDark(appearance) ? 'day' : 'night' })
}

export function ThemeToggle() {
  const s = useSettings()
  const dark = isDark(s.appearance)
  return (
    <Tip title={dark ? 'Day' : 'Night'} keys="⇧⌘L" body="Switch between light and dark.">
      <button className="icon-btn theme-toggle" aria-label="Switch between light and dark" onClick={() => toggleTheme(s.appearance)}>
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
