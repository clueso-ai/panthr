// The panels beside the chat: Notes (review comments at moments of the
// video, each a thread with the agent's reply), Versions (every export) and
// the Library (files every project can use).

import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { Comment, LibraryItem, Version } from '@shared/types'
import { api } from '@/lib/api'
import { rise, tr, MOVE, QUICK } from '@/lib/motion'
import { ago, bytes, clock } from '@/lib/format'
import { Icon } from '@/ui/Icon'
import { Composer, type ComposerHandle } from '@/ui/Controls'

// ── Notes ─────────────────────────────────────────────────────

export function NotesPanel({ comments, time, range, selected, onAdd, onSelect, onResolve, onDelete, onFixAll, onClearRange }: {
  comments: Comment[]
  time: number
  range: [number, number] | null
  selected: string | null
  onAdd(body: string): void
  onSelect(c: Comment): void
  onResolve(c: Comment, resolved: boolean): void
  onDelete(c: Comment): void
  onFixAll(): void
  onClearRange(): void
}) {
  const [showDone, setShowDone] = useState(false)
  const box = useRef<ComposerHandle>(null)
  const open = comments.filter((c) => !c.resolved)
  const done = comments.filter((c) => c.resolved)
  useEffect(() => {
    if (range) box.current?.focus()
  }, [range])
  return (
    <div className="panel">
      <div className="panel-head">
        <span className="mono faint">{open.length} open</span>
        <span className="spacer" />
        {open.length > 0 && <button className="btn small warn" onClick={onFixAll}>Fix all</button>}
      </div>
      <div className="panel-scroll">
        {comments.length === 0 && <Empty icon="pin" title="No notes yet" body="Pin a note to a moment: pause where something is off and write it below, or drag a span on the timeline's notes lane." />}
        {open.map((c) => <NoteRow key={c.id} c={c} on={selected === c.id} onSelect={onSelect} onResolve={onResolve} onDelete={onDelete} />)}
        {done.length > 0 && (
          <button className="fold-line" onClick={() => setShowDone((s) => !s)}>
            Resolved · {done.length}
            <motion.span className="fold-mark" animate={{ rotate: showDone ? 90 : 0 }} transition={tr(QUICK)}>›</motion.span>
          </button>
        )}
        <AnimatePresence initial={false}>
          {showDone && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={tr(MOVE)} style={{ overflow: 'hidden' }}>
              {done.map((c) => <NoteRow key={c.id} c={c} on={selected === c.id} onSelect={onSelect} onResolve={onResolve} onDelete={onDelete} />)}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <div className="panel-composer">
        <div className="note-at mono">
          <Icon name="pin" size={12} />
          {range ? `${clock(Math.min(...range))} – ${clock(Math.max(...range))}` : clock(time)}
          {range && <button className="link" onClick={onClearRange}>Clear</button>}
        </div>
        <Composer ref={box} placeholder="A note at this moment…" onSubmit={onAdd} maxRows={6} />
      </div>
    </div>
  )
}

function NoteRow({ c, on, onSelect, onResolve, onDelete }: { c: Comment; on: boolean; onSelect(c: Comment): void; onResolve(c: Comment, r: boolean): void; onDelete(c: Comment): void }) {
  return (
    <motion.div layout="position" className={`note${on ? ' on' : ''}${c.resolved ? ' done' : ''}`} {...rise(6, MOVE)} onClick={() => onSelect(c)}>
      <div className="note-rail"><span className="avatar">Y</span>{c.reply && <i />}{c.reply && <span className="avatar agent">◆</span>}</div>
      <div className="note-main">
        <div className="note-who"><b>You</b><span className="faint">{ago(c.created_at)}</span><span className="note-time mono">{clock(c.time)}{c.end != null ? `–${clock(c.end)}` : ''}</span></div>
        <div className="note-body">{c.body}</div>
        {c.reply && (
          <>
            <div className="note-who agent"><b>Agent</b></div>
            <div className="note-body muted">{c.reply}</div>
          </>
        )}
        <div className="note-actions" onClick={(e) => e.stopPropagation()}>
          <button className="link" onClick={() => onResolve(c, !c.resolved)}>{c.resolved ? 'Reopen' : 'Resolve'}</button>
          <button className="link danger" onClick={() => onDelete(c)}>Delete</button>
        </div>
      </div>
    </motion.div>
  )
}

// ── Versions ──────────────────────────────────────────────────

export function VersionsPanel({ dir, versions, exporting, stage, onExport, onCancel }: {
  dir: string; versions: Version[]; exporting: number | null; stage: string; onExport(): void; onCancel(): void
}) {
  const [urls, setUrls] = useState<Record<number, { poster: string; video: string }>>({})
  const [playing, setPlaying] = useState<number | null>(null)
  useEffect(() => {
    let alive = true
    Promise.all(versions.map(async (v) => [v.n, {
      poster: await api.app.fileUrl(`${dir}/.studio/versions/v${v.n}.jpg`),
      video: await api.app.fileUrl(`${dir}/.studio/versions/${v.file}`)
    }] as const)).then((all) => alive && setUrls(Object.fromEntries(all)))
    return () => {
      alive = false
    }
  }, [dir, versions])
  return (
    <div className="panel">
      <div className="panel-head">
        <span className="mono faint">{versions.length} version{versions.length === 1 ? '' : 's'}</span>
        <span className="spacer" />
        {exporting === null && <button className="btn small primary" onClick={onExport}><Icon name="export" size={13} /> Export</button>}
      </div>
      <AnimatePresence>
        {exporting !== null && (
          <motion.div className="render-bar" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={tr(MOVE)}>
            <div className="render-row"><span>Exporting</span><span className="mono">{Math.round(exporting)}%</span><span className="spacer" /><button className="link" onClick={onCancel}>Cancel</button></div>
            <div className="render-track"><motion.i animate={{ width: `${exporting}%` }} transition={tr(MOVE)} /></div>
            <div className="faint ellipsis render-stage">{stage}</div>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="panel-scroll">
        {versions.length === 0 && exporting === null && <Empty icon="history" title="No versions yet" body="Export renders the video to MP4. Each export is kept here, to play or compare." />}
        {versions.map((v, i) => (
          <motion.div key={v.n} className={`version${i === 0 ? ' newest' : ''}`} {...rise(8, MOVE, i * 0.03)}>
            <div className="version-shot" onClick={() => setPlaying(playing === v.n ? null : v.n)}>
              {playing === v.n && urls[v.n] ? (
                <video src={urls[v.n].video} autoPlay controls onEnded={() => setPlaying(null)} />
              ) : (
                <>
                  {urls[v.n] && <img src={urls[v.n].poster} alt="" onError={(e) => ((e.target as HTMLImageElement).style.opacity = '0')} />}
                  <span className="version-play"><Icon name="play" size={i === 0 ? 16 : 12} /></span>
                  {v.duration > 0 && <span className="version-len mono">{clock(v.duration, false)}</span>}
                </>
              )}
            </div>
            <div className="version-words">
              <b>v{v.n}</b>
              <span className="faint">{ago(v.created_at)} · {bytes(v.bytes)}{v.render_seconds ? ` · rendered in ${Math.round(v.render_seconds)}s` : ''}</span>
              <span className="version-actions">
                <button className="link" onClick={() => api.app.openPath(`${dir}/.studio/versions/${v.file}`)}>Open</button>
                <button className="link" onClick={() => api.app.reveal(`${dir}/.studio/versions/${v.file}`)}>Show in Finder</button>
              </span>
            </div>
          </motion.div>
        ))}
        {versions.length > 0 && <div className="panel-foot faint">Every export is kept in the project's .studio/versions folder.</div>}
      </div>
    </div>
  )
}

// ── Library ───────────────────────────────────────────────────

const KIND: [RegExp, string][] = [[/\.(png|jpe?g|webp|gif|svg)$/i, '▣'], [/\.(mp4|mov|webm)$/i, '▶'], [/\.(mp3|wav|m4a|aac)$/i, '♪'], [/\.(ttf|otf|woff2?)$/i, 'Aa']]

export function LibraryPanel({ onUse }: { onUse(item: LibraryItem): void }) {
  const [items, setItems] = useState<LibraryItem[]>([])
  const load = (): void => {
    api.review.library().then(setItems)
  }
  useEffect(load, [])
  return (
    <div className="panel">
      <div className="panel-head">
        <span className="mono faint">{items.length} item{items.length === 1 ? '' : 's'}</span>
        <span className="spacer" />
        <button className="btn small" onClick={async () => {
          const f = await api.app.chooseFiles()
          if (f.length) {
            await api.review.addToLibrary(f)
            load()
          }
        }}><Icon name="plus" size={13} /> Add</button>
      </div>
      <div className="panel-scroll">
        {items.length === 0 && <Empty icon="library" title="Your library is empty" body="Logos, fonts, music and footage every project can use. Add files, or drop them on the window." />}
        {items.map((it, i) => (
          <motion.button key={it.path} className="lib-item" {...rise(6, MOVE, i * 0.02)} onClick={() => onUse(it)}>
            <span className="lib-glyph">{it.is_dir ? '▤' : KIND.find(([r]) => r.test(it.name))?.[1] ?? '◆'}</span>
            <span className="ellipsis">{it.name}</span>
            <span className="spacer" />
            <span className="faint mono">{it.is_dir ? 'folder' : bytes(it.bytes)}</span>
          </motion.button>
        ))}
      </div>
      <div className="panel-foot faint">
        Files here are shared by every project.{' '}
        <button className="link" onClick={async () => api.app.openPath((await api.review.library())[0]?.path.replace(/\/[^/]+$/, '') ?? '')}>Show in Finder ↗</button>
      </div>
    </div>
  )
}

export function Empty({ icon, title, body }: { icon: 'pin' | 'history' | 'library'; title: string; body: string }) {
  return (
    <motion.div className="empty" {...rise(8, MOVE)}>
      <span className="empty-icon"><Icon name={icon} size={20} /></span>
      <b>{title}</b>
      <span className="muted">{body}</span>
    </motion.div>
  )
}
