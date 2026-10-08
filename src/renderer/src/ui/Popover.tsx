// A menu or panel from a control: it rises a few points into place as it
// fades in and sinks back as it fades out (drawn until it is gone). It
// opens on the side with room, closes on Esc or a click outside.

import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import { tr, QUICK } from '@/lib/motion'
import { useEffect } from 'react'

export type Side = 'top' | 'bottom'
export type Align = 'start' | 'end' | 'center'

export function Popover({
  anchor, open, onClose, side = 'bottom', align = 'start', gap = 6, children, className, width
}: {
  anchor: RefObject<HTMLElement | null>
  open: boolean
  onClose: () => void
  side?: Side
  align?: Align
  gap?: number
  children: ReactNode
  className?: string
  width?: number
}) {
  const box = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number; side: Side } | null>(null)

  useLayoutEffect(() => {
    if (!open || !anchor.current) return
    const place = (): void => {
      const a = anchor.current!.getBoundingClientRect()
      const b = box.current?.getBoundingClientRect()
      const w = b?.width ?? width ?? 220
      const h = b?.height ?? 200
      // The side with room wins.
      let s = side
      if (s === 'bottom' && a.bottom + gap + h > innerHeight - 8 && a.top - gap - h > 8) s = 'top'
      if (s === 'top' && a.top - gap - h < 8 && a.bottom + gap + h < innerHeight - 8) s = 'bottom'
      let x = align === 'start' ? a.left : align === 'end' ? a.right - w : a.left + a.width / 2 - w / 2
      x = Math.max(8, Math.min(x, innerWidth - w - 8))
      const y = s === 'bottom' ? a.bottom + gap : a.top - gap - h
      setPos({ x, y: Math.max(8, y), side: s })
    }
    place()
    const raf = requestAnimationFrame(place)
    addEventListener('resize', place)
    return () => {
      cancelAnimationFrame(raf)
      removeEventListener('resize', place)
    }
  }, [open, anchor, side, align, gap, width])

  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent): void => {
      const t = e.target as Node
      if (box.current?.contains(t) || anchor.current?.contains(t)) return
      onClose()
    }
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    addEventListener('mousedown', down, true)
    addEventListener('keydown', key, true)
    return () => {
      removeEventListener('mousedown', down, true)
      removeEventListener('keydown', key, true)
    }
  }, [open, onClose, anchor])

  const dy = (pos?.side ?? side) === 'bottom' ? -6 : 6
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          ref={box}
          className={`popover ${className ?? ''}`}
          style={{ position: 'fixed', left: pos?.x ?? -9999, top: pos?.y ?? -9999, width, zIndex: 1000 }}
          initial={{ opacity: 0, y: dy }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: dy / 2, pointerEvents: 'none' }}
          transition={tr(QUICK)}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  )
}

/** A row in a menu. */
export function MenuItem({ icon, label, hint, on, disabled, onSelect, trailing }: {
  icon?: ReactNode; label: ReactNode; hint?: ReactNode; on?: boolean; disabled?: boolean; onSelect?: () => void; trailing?: ReactNode
}) {
  return (
    <button className={`menu-item${disabled ? ' disabled' : ''}`} onMouseDown={(e) => e.preventDefault()} onClick={() => !disabled && onSelect?.()}>
      <span className="menu-check">{on === undefined ? icon : on ? '✓' : ''}</span>
      {on !== undefined && icon}
      <span className="menu-label">{label}</span>
      {hint && <span className="menu-hint">{hint}</span>}
      {trailing}
    </button>
  )
}

export const MenuSep = () => <div className="menu-sep" />
export const MenuTitle = ({ children }: { children: ReactNode }) => <div className="menu-title">{children}</div>
