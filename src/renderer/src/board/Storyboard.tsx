// The storyboard, reviewed frame by frame: a still of each frame's sketch
// (from storyboard.html), what is on screen, its voiceover and length, and
// how far along it is (planned, sketched, built). A note on a frame says
// what to change there; a tick approves it. "Send notes" asks the agent to
// redo just those frames; "Approve and build" lets it build on the layouts.

import { useEffect, useMemo, useState } from 'react'
import { motion } from 'motion/react'
import type { Storyboard, StoryboardFrame, StoryboardReview } from '@shared/types'
import { api } from '@/lib/api'
import { tr, MOVE, SETTLE } from '@/lib/motion'
import { Icon } from '@/ui/Icon'
import { IconButton } from '@/ui/Controls'

const STATUS: Record<StoryboardFrame['status'], string> = { outline: 'Planned', built: 'Sketched', animated: 'Built' }

const name = (f: StoryboardFrame): string => `${String(f.n).padStart(2, '0')}${f.title ? ` · ${f.title}` : ''}`

/** The message to the agent: the notes, frame by frame, and what to do next. */
export function reviewMessage(sb: Storyboard, review: StoryboardReview, build: boolean): string {
  const notes = sb.frames.filter((f) => review.notes[f.n]?.trim()).map((f) => `- Frame ${f.n}${f.title ? ` (${f.title})` : ''}: ${review.notes[f.n].trim()}`)
  if (build) {
    return [
      `The storyboard is approved${notes.length ? ', with these changes' : ''}.`,
      ...notes,
      notes.length ? 'Make those changes on the sketches, then build the video on the confirmed layouts.' : 'Build the video on the confirmed layouts.',
      'Keep STORYBOARD.md current as frames are built.'
    ].join('\n')
  }
  const ok = sb.frames.filter((f) => review.approved.includes(f.n) && !review.notes[f.n]?.trim()).map((f) => f.n)
  return [
    'Storyboard notes:',
    ...notes,
    `Redo only these frames${ok.length ? `; frames ${ok.join(', ')} are approved as they are` : ''}. Update STORYBOARD.md and storyboard.html, then show me the storyboard again.`
  ].join('\n')
}

export function StoryboardSheet({ dir, onClose, onSend }: { dir: string; onClose(): void; onSend(text: string): void }) {
  const [sb, setSb] = useState<Storyboard | null>(null)
  const [review, setReview] = useState<StoryboardReview>({ approved: [], notes: {} })
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let alive = true
    const load = (): void => {
      api.storyboard.get(dir).then((s) => {
        if (!alive) return
        setSb(s)
        if (s) setReview(s.review)
        setLoading(false)
      })
    }
    load()
    const off = api.on('project:changed', (e) => e.dir === dir && load())
    const off2 = api.on('chat:turn', load)
    return () => {
      alive = false
      off()
      off2()
    }
  }, [dir])
  useEffect(() => {
    const k = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !(document.activeElement instanceof HTMLTextAreaElement)) {
        e.stopPropagation()
        onClose()
      }
    }
    addEventListener('keydown', k, true)
    return () => removeEventListener('keydown', k, true)
  }, [onClose])
  const save = (r: StoryboardReview): void => {
    setReview(r)
    api.storyboard.review(dir, r)
  }
  const nNotes = useMemo(() => Object.values(review.notes).filter((n) => n.trim()).length, [review])
  const total = useMemo(() => (sb ? sb.frames.reduce((a, f) => a + (parseFloat(f.duration ?? '') || 0), 0) : 0), [sb])
  const send = (build: boolean): void => {
    if (!sb) return
    onSend(reviewMessage(sb, review, build))
    save({ approved: build ? sb.frames.map((f) => f.n) : review.approved, notes: {} })
    onClose()
  }
  return (
    <motion.div className="sheet-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={tr(MOVE)} onClick={onClose}>
      <motion.div className="sb-sheet" initial={{ opacity: 0, y: 12, scale: 0.985 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 8, scale: 0.985 }} transition={tr(SETTLE)} onClick={(e) => e.stopPropagation()}>
        <div className="sb-head">
          <div className="sb-title">
            <b>Storyboard</b>
            {sb && <span className="faint">{sb.frames.length} frames{total ? ` · about ${Math.round(total)} s` : ''}{sb.format ? ` · ${sb.format}` : ''}</span>}
          </div>
          {sb?.message && <p className="sb-message">“{sb.message}”</p>}
          <div className="refs-sheet-close"><IconButton icon="close" tip="Close" keys="esc" onClick={onClose} /></div>
        </div>
        <div className="sb-body">
          {loading && <div className="faint sb-wait"><span className="shine" data-text="Taking stills of the sketches…">Taking stills of the sketches…</span></div>}
          {!loading && !sb && <div className="faint sb-wait">No storyboard here yet. Ask for one: “storyboard it first”.</div>}
          {sb && (
            <div className="sb-grid">
              {sb.frames.map((f) => {
                const ok = review.approved.includes(f.n)
                return (
                  <div key={f.n} className={`sb-frame${ok ? ' ok' : ''}`}>
                    <div className="sb-still">
                      {f.still ? <img src={f.still} alt="" draggable={false} /> : (
                        <div className="sb-outline"><span>{f.scene || f.title || `Frame ${f.n}`}</span></div>
                      )}
                      <span className={`sb-status ${f.status}`}>{STATUS[f.status]}</span>
                    </div>
                    <div className="sb-row">
                      <b className="ellipsis">{name(f)}</b>
                      {f.duration && <span className="mono faint">{f.duration}</span>}
                      <button className={`sb-ok${ok ? ' on' : ''}`} title={ok ? 'Approved' : 'Approve this frame'} onClick={() => save({ ...review, approved: ok ? review.approved.filter((n) => n !== f.n) : [...review.approved, f.n] })}>
                        <Icon name="check" size={13} />
                      </button>
                    </div>
                    {f.scene && f.still && <div className="sb-scene">{f.scene}</div>}
                    {f.voiceover && <div className="sb-vo">“{f.voiceover}”</div>}
                    <textarea className="sb-note" rows={1} placeholder="What should change here?" value={review.notes[f.n] ?? ''}
                      onChange={(e) => setReview({ ...review, notes: { ...review.notes, [f.n]: e.target.value } })}
                      onBlur={() => save(review)} />
                  </div>
                )
              })}
            </div>
          )}
        </div>
        {sb && (
          <div className="rec-go">
            <span className="faint sb-count">{review.approved.length} of {sb.frames.length} approved{nNotes ? ` · ${nNotes} note${nNotes === 1 ? '' : 's'}` : ''}</span>
            <span className="spacer" />
            <button className="btn" disabled={!nNotes} onClick={() => send(false)}>Send notes{nNotes ? ` (${nNotes})` : ''}</button>
            <button className="btn primary" onClick={() => send(true)}><Icon name="check" size={13} /> Approve and build</button>
          </div>
        )}
      </motion.div>
    </motion.div>
  )
}
