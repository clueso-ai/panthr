// Hover help: a title and one line on what a control does. It waits a
// moment, then fades in and settles from a few points lower.

import { cloneElement, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import { tr, QUICK } from '@/lib/motion'

export function Tip({ title, body, keys, children, side = 'bottom' }: { title: ReactNode; body?: ReactNode; keys?: string; children: ReactElement<any>; side?: 'top' | 'bottom' }) {
  const [at, setAt] = useState<{ x: number; y: number; side: 'top' | 'bottom' } | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const show = (e: React.MouseEvent): void => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      const s = side === 'bottom' && r.bottom + 70 > innerHeight ? 'top' : side
      setAt({ x: Math.min(Math.max(r.left + r.width / 2, 140), innerWidth - 140), y: s === 'bottom' ? r.bottom + 8 : r.top - 8, side: s })
    }, 450)
  }
  const hide = (): void => {
    window.clearTimeout(timer.current)
    setAt(null)
  }
  const child = cloneElement(children, {
    onMouseEnter: (e: React.MouseEvent) => {
      children.props.onMouseEnter?.(e)
      show(e)
    },
    onMouseLeave: (e: React.MouseEvent) => {
      children.props.onMouseLeave?.(e)
      hide()
    },
    onMouseDown: (e: React.MouseEvent) => {
      children.props.onMouseDown?.(e)
      hide()
    }
  })
  return (
    <>
      {child}
      {createPortal(
        <AnimatePresence>
          {at && (
            <motion.div
              className={`tip${body ? ' wide' : ''}`}
              style={{ position: 'fixed', left: at.x, top: at.y, zIndex: 2000, pointerEvents: 'none' }}
              initial={{ opacity: 0, y: at.side === 'bottom' ? 4 : -4, x: '-50%', translateY: at.side === 'top' ? '-100%' : '0%' }}
              animate={{ opacity: 1, y: 0, x: '-50%', translateY: at.side === 'top' ? '-100%' : '0%' }}
              exit={{ opacity: 0 }}
              transition={tr(QUICK)}
            >
              <div className="tip-title">
                {title}
                {keys && <span className="tip-keys">{keys}</span>}
              </div>
              {body && <div className="tip-body">{body}</div>}
            </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}
    </>
  )
}
