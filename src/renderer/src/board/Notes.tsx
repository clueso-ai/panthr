// Notes on a project's canvas: sticky notes (free, or on a video) and
// arrows from one tile to another saying what should happen. Each goes to
// the project's conversation when sent, and is then marked done.

import { useEffect, useRef, useState } from 'react'
import { motion } from 'motion/react'
import type { CanvasNote } from '@shared/types'
import { tr, MOVE } from '@/lib/motion'
import { Icon } from '@/ui/Icon'

export const NOTE_W = 220

/** What the agent is told for a note or an arrow (names from the canvas). */
export function noteMessage(n: CanvasNote, name: (key: string) => string): string {
  if (n.kind === 'arrow') return `On the canvas, an arrow from "${name(n.from!)}" to "${name(n.to!)}": ${n.text.trim() || 'make the second more like the first'}`
  return n.on ? `A note on the canvas about "${name(n.on)}": ${n.text.trim()}` : `A note on the canvas: ${n.text.trim()}`
}

export function NoteCard({ n, editing, onEdit, onText, onSend, onDone, onDelete, onDragStart }: {
  n: CanvasNote
  editing: boolean
  onEdit(on: boolean): void
  /** As typed (final: when the box is left, to save). */
  onText(text: string, final: boolean): void
  onSend(): void
  onDone(): void
  onDelete(): void
  onDragStart(e: React.PointerEvent): void
}) {
  const box = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (editing) box.current?.focus()
  }, [editing])
  return (
    <motion.div
      className={`canvas-note${n.done ? ' done' : ''}`}
      style={{ left: n.x, top: n.y, width: NOTE_W }}
      initial={{ opacity: 0, scale: 0.92 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={tr(MOVE)}
      onPointerDown={(e) => {
        e.stopPropagation()
        if (!(e.target as HTMLElement).closest('textarea, button')) onDragStart(e)
      }}
      onDoubleClick={(e) => {
        e.stopPropagation()
        onEdit(true)
      }}
    >
      {editing ? (
        <textarea ref={box} className="note-text-edit" defaultValue={n.text} rows={3} placeholder="What should change?" onChange={(e) => onText(e.target.value, false)} onBlur={(e) => { onText(e.target.value, true); onEdit(false) }} onKeyDown={(e) => {
          if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) (e.target as HTMLTextAreaElement).blur()
        }} />
      ) : (
        <div className="note-text">{n.text || <span className="faint">Double-click to write</span>}</div>
      )}
      <div className="note-row">
        {n.done ? <span className="faint">{n.kind === 'note' ? 'Sent' : 'Sent'}</span> : <button className="link" disabled={!n.text.trim()} onClick={onSend}>Send to the agent</button>}
        <span className="spacer" />
        <button className="icon-btn small" title={n.done ? 'Open again' : 'Done'} onClick={onDone}><Icon name="check" size={13} /></button>
        <button className="icon-btn small" title="Delete" onClick={onDelete}><Icon name="trash" size={13} /></button>
      </div>
    </motion.div>
  )
}

/** The words on an instruction arrow, at its middle. */
export function ArrowLabel({ n, x, y, editing, onEdit, onText, onSend, onDone, onDelete }: {
  n: CanvasNote
  x: number
  y: number
  editing: boolean
  onEdit(on: boolean): void
  onText(text: string, final: boolean): void
  onSend(): void
  onDone(): void
  onDelete(): void
}) {
  const [hover, setHover] = useState(false)
  return (
    <div className={`arrow-label${n.done ? ' done' : ''}`} style={{ left: x, top: y }} onPointerDown={(e) => e.stopPropagation()} onPointerEnter={() => setHover(true)} onPointerLeave={() => setHover(false)} onDoubleClick={() => onEdit(true)}>
      {editing ? (
        <input autoFocus className="arrow-text-edit" defaultValue={n.text} placeholder="What should happen?" onChange={(e) => onText(e.target.value, false)} onBlur={(e) => { onText(e.target.value, true); onEdit(false) }} onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLInputElement).blur()
        }} />
      ) : (
        <span>{n.text || <span className="faint">Double-click to say what should happen</span>}</span>
      )}
      {(hover || !n.done) && !editing && (
        <span className="arrow-actions">
          {!n.done && <button className="link" disabled={!n.text.trim()} onClick={onSend}>Send</button>}
          <button className="icon-btn small" title={n.done ? 'Open again' : 'Done'} onClick={onDone}><Icon name="check" size={12} /></button>
          <button className="icon-btn small" title="Delete" onClick={onDelete}><Icon name="trash" size={12} /></button>
        </span>
      )}
    </div>
  )
}
