// What can be done to a clip on the timeline, from a right-click on it or
// the "Clip" button under the timeline: split it at the playhead, hold a
// frame, duplicate, copy and paste, its speed, its volume, fades, ducking
// under a voice, evening out its loudness, and deleting it (closing the
// gap or not). Every one is an edit that ⌘Z takes back.

import { useEffect, useRef, useState } from 'react'
import type { Clip, ClipEdit } from '@shared/types'
import { MenuItem, MenuSep, MenuTitle, Popover } from '@/ui/Popover'
import { Icon } from '@/ui/Icon'

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2]
const FADES = [0, 0.25, 0.5, 1, 2]

const db = (v: number): string => (v <= 0 ? '−∞ dB' : `${(20 * Math.log10(v)).toFixed(1)} dB`)

/** A voice, by its name or file (a narration, a voiceover). */
export const isVoice = (c: Clip): boolean => /voice|\bvo\b|narrat|speech|dialog/i.test(`${c.id} ${c.src ?? ''}`)

export function ClipMenu({ clip, clips, at, canPaste, onEdit, onCopy, onPaste, onAsk, onClose }: {
  clip: Clip
  clips: Clip[]
  /** The playhead. */
  at: number
  canPaste: boolean
  onEdit(e: ClipEdit): void
  onCopy(): void
  onPaste(): void
  onAsk(): void
  onClose(): void
}) {
  const [volume, setVolume] = useState(clip.volume ?? 1)
  useEffect(() => setVolume(clip.volume ?? 1), [clip.volume])
  const go = (e: ClipEdit) => () => {
    onClose()
    onEdit(e)
  }
  const inside = at > clip.start + 0.04 && at < clip.end - 0.04
  const media = !!clip.src && (clip.kind === 'video' || clip.kind === 'audio')
  const voices = clips.filter((c) => c.id !== clip.id && c.audible && (isVoice(c) || (c.kind === 'audio' && !isVoice(clip))) && c.kind === 'audio')
  const ducked = clip.mix?.duck?.under ?? []
  const fin = clip.mix?.in ?? 0
  const fout = clip.mix?.out ?? 0
  return (
    <div className="menu clip-menu">
      <MenuTitle>{clip.id}</MenuTitle>
      <MenuItem icon={<Icon name="split" size={14} />} label="Split at the playhead" hint="S" disabled={!inside} onSelect={go({ op: 'split', ref: clip.ref, at })} />
      {clip.kind === 'video' && <MenuItem icon={<Icon name="pause" size={14} />} label="Hold this frame for 1 s" disabled={!inside} onSelect={go({ op: 'freeze', ref: clip.ref, at, len: 1 })} />}
      <MenuItem icon={<Icon name="copy" size={14} />} label="Duplicate" hint="⌘D" onSelect={go({ op: 'duplicate', ref: clip.ref, at: clip.end })} />
      <MenuItem label="Copy" hint="⌘C" onSelect={() => {
        onClose()
        onCopy()
      }} />
      <MenuItem label="Paste at the playhead" hint="⌘V" disabled={!canPaste} onSelect={() => {
        onClose()
        onPaste()
      }} />
      {media && <>
        <MenuSep />
        <MenuTitle>Speed</MenuTitle>
        <div className="clip-speeds">
          {SPEEDS.map((r) => <button key={r} className={`chip small${Math.abs((clip.rate ?? 1) - r) < 1e-3 ? ' on' : ''}`} onClick={go({ op: 'set', ref: clip.ref, rate: r })}>{r}×</button>)}
        </div>
      </>}
      {clip.audible && <>
        <MenuSep />
        <MenuTitle>Volume <span className="mono faint">{Math.round(volume * 100)}% · {db(volume)}</span></MenuTitle>
        <div className="clip-volume">
          <input type="range" min={0} max={1.5} step={0.01} value={volume} onChange={(e) => setVolume(Number(e.target.value))}
            onPointerUp={() => volume !== (clip.volume ?? 1) && onEdit({ op: 'set', ref: clip.ref, volume })}
            onKeyUp={() => volume !== (clip.volume ?? 1) && onEdit({ op: 'set', ref: clip.ref, volume })} />
        </div>
        <MenuItem icon={<Icon name="spark" size={14} />} label="Even out its loudness" onSelect={go({ op: 'normalize', ref: clip.ref })} />
        <MenuTitle>Fade in · out</MenuTitle>
        <div className="clip-speeds"><span className="clip-row-label faint">In</span>
          {FADES.map((f) => <button key={`in${f}`} className={`chip small${Math.abs(fin - f) < 1e-3 ? ' on' : ''}`} onClick={go({ op: 'fade', ref: clip.ref, in: f })}>{f ? `${f}s` : 'none'}</button>)}
        </div>
        <div className="clip-speeds"><span className="clip-row-label faint">Out</span>
          {FADES.map((f) => <button key={`out${f}`} className={`chip small${Math.abs(fout - f) < 1e-3 ? ' on' : ''}`} onClick={go({ op: 'fade', ref: clip.ref, out: f })}>{f ? `${f}s` : 'none'}</button>)}
        </div>
        {clip.kind === 'audio' && !isVoice(clip) && voices.length > 0 && <>
          <MenuSep />
          {ducked.length > 0
            ? <MenuItem label={`Stop ducking under ${ducked.join(', ')}`} onSelect={go({ op: 'duck', ref: clip.ref, under: [] })} />
            : voices.slice(0, 4).map((v) => <MenuItem key={v.id} label={`Duck under ${v.id}`} hint="while it speaks" onSelect={go({ op: 'duck', ref: clip.ref, under: [v.id], depth: 0.3 })} />)}
        </>}
      </>}
      <MenuSep />
      <MenuItem icon={<Icon name="spark" size={14} />} label="Ask the agent about it" onSelect={() => {
        onClose()
        onAsk()
      }} />
      <MenuItem icon={<Icon name="trash" size={14} />} label="Delete" hint="⌫" onSelect={go({ op: 'delete', ref: clip.ref })} />
      <MenuItem label="Delete and close the gap" hint="⇧⌫" onSelect={go({ op: 'delete', ref: clip.ref, close: true })} />
    </div>
  )
}

/** The clip menu where the pointer was: a popover at a point. */
export function ClipMenuAt({ x, y, children, onClose }: { x: number; y: number; children: React.ReactNode; onClose(): void }) {
  const anchor = useRef<HTMLDivElement>(null)
  return (
    <>
      <div ref={anchor} style={{ position: 'fixed', left: x, top: y, width: 1, height: 1, pointerEvents: 'none' }} />
      <Popover anchor={anchor} open onClose={onClose} side="top" align="start" width={260}>{children}</Popover>
    </>
  )
}
