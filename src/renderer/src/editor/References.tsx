// Reference videos in the window: the list (in the Library panel), adding
// one (a file, a link, or a drop anywhere on the window), and a reference
// opened as its folder: the files the agent wrote, as a tree, beside a
// viewer for whichever is chosen.

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import type { Reference, RefFile } from '@shared/types'
import { api, useReferences } from '@/lib/api'
import { rise, tr, MOVE, QUICK, SETTLE } from '@/lib/motion'
import { clock, bytes } from '@/lib/format'
import { Icon } from '@/ui/Icon'
import { IconButton, RefThumb } from '@/ui/Controls'
import { Block, blocks } from './Markdown'

const VIDEO = /\.(mp4|mov|m4v|webm|mkv|avi)$/i

/** Add references from dropped or chosen files (videos only). */
export async function addVideos(paths: string[]): Promise<number> {
  const vids = paths.filter((p) => VIDEO.test(p))
  for (const p of vids) await api.references.add(p)
  return vids.length
}

const statusLine = (r: Reference): string =>
  r.status === 'ready' ? `@${r.handle}` : r.status === 'failed' ? r.error ?? 'It stopped' : r.step ?? 'Deconstructing…'

/** `onAdded`: a video went in (Home closes its sheet; the work goes on behind). */
export function ReferencesSection({ onMention, onAdded }: { onMention(handle: string): void; onAdded?(): void }) {
  const refs = useReferences()
  const [open, setOpen] = useState<string | null>(null)
  const [link, setLink] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const chosen = refs.find((r) => r.id === open) ?? null
  const addLink = async (): Promise<void> => {
    try {
      await api.references.add(link.trim())
      setLink('')
      setErr(null)
      onAdded?.()
    } catch (e) {
      setErr((e as Error).message)
    }
  }
  return (
    <div className="refs">
      <div className="refs-head">
        <b>References</b>
        <span className="faint">Videos your agent has taken apart. Mention one in chat with @.</span>
      </div>
      <div className="refs-add">
        <button className="btn small" onClick={async () => {
          if (await addVideos(await api.app.chooseFiles())) onAdded?.()
        }}><Icon name="plus" size={13} /> Add a video</button>
        <input className="refs-link" placeholder="…or paste a link" value={link} onChange={(e) => setLink(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && link.trim() && addLink()} />
      </div>
      {err && <div className="refs-err">{err}</div>}
      <div className="refs-list">
        {refs.length === 0 && <div className="refs-empty faint">Drop a video anywhere on the window, or add one above. Your agent looks at it and writes down how it is made.</div>}
        {refs.map((r, i) => (
          <motion.button key={r.id} className={`ref-card ${r.status}`} {...rise(6, MOVE, Math.min(i, 8) * 0.03)} onClick={() => setOpen(r.id)}>
            <RefThumb r={r} />
            <span className="ref-words">
              <b className="ellipsis">{r.name}</b>
              {r.status === 'ready' || r.status === 'failed'
                ? <span className={`ellipsis ${r.status === 'failed' ? 'bad' : ''}`}>{statusLine(r)}{r.summary ? ` · ${r.summary}` : ''}</span>
                : <span className="shine ellipsis" data-text={statusLine(r)}>{statusLine(r)}</span>}
            </span>
          </motion.button>
        ))}
      </div>
      <RefSheet r={chosen} onClose={() => setOpen(null)} onMention={(h) => {
        setOpen(null)
        onMention(h)
      }} />
    </div>
  )
}

/** A reference opened: its folder as a tree, and the chosen file. */
export function RefSheet({ r, onClose, onMention }: { r: Reference | null; onClose(): void; onMention(handle: string): void }) {
  useEffect(() => {
    if (!r) return
    const k = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    addEventListener('keydown', k)
    return () => removeEventListener('keydown', k)
  }, [r, onClose])
  return createPortal(
    <AnimatePresence>
      {r && (
        <motion.div className="sheet-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={tr(MOVE)} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
          <motion.div className="sheet ref-sheet" initial={{ opacity: 0, y: 16, scale: 0.985 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 8, scale: 0.99 }} transition={tr(SETTLE)}>
            <RefBody r={r} onClose={onClose} onMention={onMention} />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  )
}

function RefBody({ r, onClose, onMention }: { r: Reference; onClose(): void; onMention(handle: string): void }) {
  const [files, setFiles] = useState<RefFile[]>([])
  const [sel, setSel] = useState<string | null>(null)
  const [shut, setShut] = useState<Set<string>>(new Set())
  const [naming, setNaming] = useState(false)
  const [confirm, setConfirm] = useState(false)
  // The folder as it is now (it grows while the agent writes).
  useEffect(() => {
    api.references.files(r.id).then((f) => {
      setFiles(f)
      setSel((s) => s ?? (f.find((x) => x.path === 'README.md')?.path ?? f.find((x) => x.path === 'contact.jpg')?.path ?? f.find((x) => !x.dir)?.path ?? null))
    })
  }, [r.id, r.status, r.step])
  // Folders start open, except the stills (there are many).
  useEffect(() => setShut(new Set(['frames'])), [r.id])
  // A file shows unless a folder above it is folded.
  const visible = files.filter((f) => {
    const parts = f.path.split('/')
    for (let i = 1; i < parts.length; i++) if (shut.has(parts.slice(0, i).join('/'))) return false
    return true
  })
  const file = files.find((f) => f.path === sel) ?? null
  return (
    <div className="ref-body">
      <div className="ref-top">
        <RefThumb r={r} />
        <div className="ref-title">
          {naming ? (
            <input className="rename" autoFocus defaultValue={r.name} onBlur={() => setNaming(false)} onKeyDown={async (e) => {
              if (e.key === 'Enter') {
                await api.references.rename(r.id, (e.target as HTMLInputElement).value)
                setNaming(false)
              } else if (e.key === 'Escape') setNaming(false)
            }} />
          ) : (
            <b className="ellipsis" onDoubleClick={() => setNaming(true)}>{r.name}</b>
          )}
          <span className="faint ellipsis">
            {r.status === 'ready' ? <span className="mono">@{r.handle}</span> : r.status === 'failed' ? <span className="bad">{r.error}</span> : <span className="shine" data-text={r.step ?? 'Deconstructing…'}>{r.step ?? 'Deconstructing…'}</span>}
            {r.duration > 0 && <span className="mono"> · {clock(r.duration, false)} · {r.width}×{r.height}</span>}
          </span>
        </div>
        {r.status === 'ready' && <button className="btn small primary" onClick={() => onMention(r.handle)}>Mention in chat</button>}
        {r.status === 'failed' && <button className="btn small" onClick={() => api.references.retry(r.id)}>Try again</button>}
        <IconButton icon="folder" tip="Show in Finder" onClick={() => api.app.reveal(r.dir)} />
        {confirm ? (
          <span className="ref-confirm">
            Delete it?
            <button className="btn small danger" onClick={async () => {
              await api.references.remove(r.id)
              onClose()
            }}>Delete</button>
            <button className="btn small ghost" onClick={() => setConfirm(false)}>Keep</button>
          </span>
        ) : (
          <IconButton icon="trash" tip="Delete this reference" onClick={() => setConfirm(true)} />
        )}
        <IconButton icon="close" tip="Close" keys="Esc" onClick={onClose} />
      </div>
      <div className="ref-split">
        <div className="ref-tree">
          {visible.map((f) => (
            <button
              key={f.path}
              className={`tree-row${sel === f.path ? ' on' : ''}`}
              style={{ paddingLeft: 10 + f.depth * 14 }}
              onClick={() => {
                if (f.dir) setShut((s) => {
                  const n = new Set(s)
                  if (n.has(f.path)) n.delete(f.path)
                  else n.add(f.path)
                  return n
                })
                else setSel(f.path)
              }}
            >
              {f.dir ? <motion.span className="tree-caret" animate={{ rotate: shut.has(f.path) ? 0 : 90 }} transition={tr(QUICK)}>›</motion.span> : <span className="tree-caret" />}
              <Icon name={f.dir ? 'folder' : f.kind === 'image' ? 'image' : f.kind === 'video' ? 'film' : 'note'} size={13} className="faint" />
              <span className="ellipsis">{f.name}</span>
            </button>
          ))}
          {files.length === 0 && <div className="faint tree-empty">Nothing yet.</div>}
        </div>
        <div className="ref-view">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={file?.path ?? 'none'} className="ref-view-inner" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={tr(QUICK)}>
              {file ? <Viewer r={r} f={file} /> : <div className="faint">Pick a file.</div>}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>
  )
}

function Viewer({ r, f }: { r: Reference; f: RefFile }) {
  const [text, setText] = useState<string | null>(null)
  const [url, setUrl] = useState<string | null>(null)
  const abs = `${r.dir}/${f.path}`
  useEffect(() => {
    setText(null)
    setUrl(null)
    if (f.kind === 'markdown' || f.kind === 'text' || f.kind === 'other') api.references.readFile(r.id, f.path).then(setText)
    else api.app.fileUrl(abs).then(setUrl)
  }, [r.id, f.path, f.kind, f.size, abs])
  const md = useMemo(() => (f.kind === 'markdown' && text ? blocks(text) : []), [f.kind, text])
  const head = <div className="viewer-head"><span className="mono">{f.path}</span><span className="faint">{bytes(f.size)}</span></div>
  if (f.kind === 'image') return <>{head}{url && <img className="viewer-img" src={url} alt={f.name} />}</>
  if (f.kind === 'video') return <>{head}{url && <video className="viewer-img" src={url} controls />}</>
  if (f.kind === 'audio') return <>{head}{url && <audio src={url} controls />}</>
  if (f.kind === 'markdown') return <>{head}<div className="am viewer-md">{md.map((b, i) => <Block key={i} b={b} />)}</div></>
  return <>{head}<pre className="viewer-pre">{text ?? (f.size > 2 << 20 ? 'Too big to show here.' : '')}</pre></>
}

/** A window-wide drop zone: videos dropped anywhere become references. */
export function DropVideos({ onAdded }: { onAdded?(n: number): void }) {
  const [over, setOver] = useState(false)
  const depth = useRef(0)
  useEffect(() => {
    const hasFiles = (e: DragEvent): boolean => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files')
    const enter = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      depth.current++
      setOver(true)
    }
    const leave = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      depth.current = Math.max(0, depth.current - 1)
      if (!depth.current) setOver(false)
    }
    const overF = (e: DragEvent): void => {
      if (hasFiles(e)) e.preventDefault()
    }
    const drop = async (e: DragEvent): Promise<void> => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth.current = 0
      setOver(false)
      const paths = [...(e.dataTransfer?.files ?? [])].map((f) => window.panthr.pathForFile(f)).filter(Boolean)
      const n = await addVideos(paths)
      onAdded?.(n)
    }
    addEventListener('dragenter', enter)
    addEventListener('dragleave', leave)
    addEventListener('dragover', overF)
    addEventListener('drop', drop)
    return () => {
      removeEventListener('dragenter', enter)
      removeEventListener('dragleave', leave)
      removeEventListener('dragover', overF)
      removeEventListener('drop', drop)
    }
  }, [onAdded])
  return createPortal(
    <AnimatePresence>
      {over && (
        <motion.div className="drop-zone" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={tr(QUICK)}>
          <div className="drop-card">
            <Icon name="play" size={20} />
            <b>Drop to add as a reference video</b>
            <span className="faint">Your agent takes it apart, then you can mention it in chat with @.</span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  )
}
