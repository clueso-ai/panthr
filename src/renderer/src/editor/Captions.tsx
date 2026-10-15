// The Captions panel: the video's transcript word by word, in lines as they
// are spoken, the word playing now lit. Click a word to go to it; double-
// click to fix it (a name misheard, a typo), which writes the transcript the
// captions are made from. With no transcript yet, a clip's sound can be
// transcribed here, and the agent asked to caption from it.

import { useEffect, useMemo, useState } from 'react'
import type { Clip, Transcript, Word } from '@shared/types'
import { api, useEvent } from '@/lib/api'
import { clock } from '@/lib/format'
import { Icon } from '@/ui/Icon'
import { isVoice } from './ClipMenu'

/** Words into lines: a new line after a pause or the end of a sentence. */
export function linesOf(words: Word[]): Word[][] {
  const out: Word[][] = []
  let cur: Word[] = []
  words.forEach((w, i) => {
    const prev = words[i - 1]
    if (cur.length && prev && (w.start - prev.end > 0.7 || /[.?!]["”']?$/.test(prev.text) || cur.length >= 14)) {
      out.push(cur)
      cur = []
    }
    cur.push(w)
  })
  if (cur.length) out.push(cur)
  return out
}

export function CaptionsPanel({ dir, time, clips, onSeek, onSaved, onAsk, say }: {
  dir: string
  time: number
  clips: Clip[]
  onSeek(t: number): void
  onSaved(file: string, before: string, after: string, label: string): void
  onAsk(text: string): void
  say(text: string): void
}) {
  const [list, setList] = useState<Transcript[] | null>(null)
  const [pick, setPick] = useState(0)
  const [editing, setEditing] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const load = (): void => {
    api.captions.list(dir).then(setList).catch(() => setList([]))
  }
  useEffect(load, [dir])
  useEvent('project:changed', (e) => {
    if (e.dir === dir && !editing) load()
  }, [dir, editing])
  const t = list?.[pick] ?? null
  const lines = useMemo(() => (t ? linesOf(t.words) : []), [t])
  const sound = clips.filter((c) => c.audible && c.src).sort((a, b) => Number(isVoice(b)) - Number(isVoice(a)))

  const fix = async (w: Word, text: string): Promise<void> => {
    setEditing(null)
    const v = text.trim()
    if (!t || !v || v === w.text) return
    try {
      const r = await api.captions.save(dir, t.file, [{ ...w, text: v }])
      onSaved(r.file, r.before, r.after, `the word “${w.text}”`)
      setList((l) => l && l.map((x, i) => (i === pick ? { ...x, words: x.words.map((y) => (y.id === w.id ? { ...y, text: v } : y)) } : x)))
    } catch (e) {
      say(`Couldn't change it: ${(e as Error).message}`)
    }
  }
  const run = async (c: Clip): Promise<void> => {
    setBusy(c.id)
    try {
      await api.captions.transcribe(dir, c.src!)
      load()
      say('Transcribed: the words are in transcript.json')
    } catch (e) {
      say(`Couldn't transcribe it: ${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  if (list === null) return <div className="cap-empty faint">Looking for the words…</div>
  if (!t) {
    return (
      <div className="cap-empty">
        <b>No transcript yet</b>
        <span className="faint">Transcribe a clip’s sound to get its words with their times, then fix any word and have the agent caption from them.</span>
        {sound.length === 0 && <span className="faint">This video has no sound to transcribe.</span>}
        {sound.map((c) => (
          <button key={c.id} className="btn small" disabled={!!busy} onClick={() => run(c)}>
            <Icon name="captions" size={13} /> {busy === c.id ? <span className="shine" data-text="Transcribing…">Transcribing…</span> : `Transcribe ${c.id}`}
          </button>
        ))}
        {busy && <span className="faint cap-wait">The first time, the speech model downloads; that takes a minute.</span>}
      </div>
    )
  }
  return (
    <div className="cap">
      <div className="cap-head">
        {list.length > 1 ? (
          <select className="cap-file" value={pick} onChange={(e) => setPick(Number(e.target.value))}>
            {list.map((x, i) => <option key={x.file} value={i}>{x.file}</option>)}
          </select>
        ) : <span className="mono faint cap-file">{t.file}</span>}
        <span className="faint">{t.words.length} words · double-click one to fix it</span>
      </div>
      <div className="cap-lines">
        {lines.map((ln, i) => (
          <div key={i} className="cap-line">
            <button className="cap-at mono faint" onClick={() => onSeek(ln[0].start)}>{clock(ln[0].start)}</button>
            <span className="cap-words">
              {ln.map((w) => editing === w.id ? (
                <input key={w.id} className="cap-edit" autoFocus defaultValue={w.text} size={Math.max(2, w.text.length + 1)}
                  onBlur={(e) => fix(w, e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') fix(w, e.currentTarget.value)
                    else if (e.key === 'Escape') setEditing(null)
                  }} />
              ) : (
                <span key={w.id} className={`cap-word${time >= w.start && time < w.end ? ' on' : ''}`}
                  onClick={() => onSeek(w.start + 0.01)} onDoubleClick={() => setEditing(w.id)}>{w.text}</span>
              ))}
            </span>
          </div>
        ))}
      </div>
      <div className="cap-foot">
        <button className="btn small" onClick={() => onAsk(`Caption this video from ${t.file}, word by word as the captions guidance says (a caption track, nothing over the caption keep-out zone). Use the words exactly as they are in the file: I fixed some by hand.`)}>
          <Icon name="spark" size={13} /> Ask for captions from these words
        </button>
      </div>
    </div>
  )
}
