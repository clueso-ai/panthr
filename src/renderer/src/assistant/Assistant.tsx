// The assistant, from Home: a button at the bottom right opens a small chat
// box, which can grow to fill the window. It runs on the person's own agent
// and looks after Panther itself (settings, skills, references); what is
// about a project it hands to that project's conversation, and the window
// goes there. Open or not, and how big, outlives a visit to a project.

import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { ChatState } from '@shared/types'
import { api, useEvent } from '@/lib/api'
import { rise, tr, MOVE, QUICK, SETTLE } from '@/lib/motion'
import { Chat } from '@/editor/Chat'
import { Composer, IconButton, type ComposerHandle } from '@/ui/Controls'
import { LiveMark, Mark } from '@/ui/Mark'
import { Icon } from '@/ui/Icon'
import { Tip } from '@/ui/Tooltip'
import './assistant.css'

const IDEAS = ['Switch to dark mode', 'Add a skill from a link', 'Which skills are on?', 'Use Sonnet for new chats']

type Shown = { open: boolean; full: boolean }
let shown: Shown = { open: false, full: false }
const subs = new Set<(s: Shown) => void>()
const show = (s: Partial<Shown>): void => {
  shown = { ...shown, ...s }
  subs.forEach((f) => f(shown))
}
/** Open the assistant (the menu's ⌘J, from anywhere: App takes the window Home first). */
export const toggleAssistant = (): void => show({ open: !shown.open })
export const openAssistant = (): void => show({ open: true })

function useShown(): Shown {
  const [s, set] = useState(shown)
  useEffect(() => {
    subs.add(set)
    return () => {
      subs.delete(set)
    }
  }, [])
  return s
}

/** The window's size (the box's room changes with it). */
function useViewport(): { w: number; h: number } {
  const [v, set] = useState({ w: innerWidth, h: innerHeight })
  useEffect(() => {
    const f = (): void => set({ w: innerWidth, h: innerHeight })
    addEventListener('resize', f)
    return () => removeEventListener('resize', f)
  }, [])
  return v
}

const TOP = 52
const FAB = 44

export function Assistant() {
  const { open, full } = useShown()
  const vp = useViewport()
  const [where, setWhere] = useState<{ dir: string; chatId: string } | null>(null)
  const [chat, setChat] = useState<ChatState | null>(null)
  const [text, setText] = useState('')
  const box = useRef<ComposerHandle>(null)

  useEffect(() => {
    api.assistant.open().then(setWhere)
  }, [])
  useEffect(() => {
    if (where) api.chats.open(where.dir, where.chatId).then(setChat)
  }, [where])
  useEvent('chat:state', (c) => {
    if (where && c.dir === where.dir && c.chatId === where.chatId) setChat(c)
  }, [where])
  useEffect(() => {
    if (open) requestAnimationFrame(() => box.current?.focus())
  }, [open, full])
  useEffect(() => {
    if (!open) return
    const k = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || document.querySelector('.sheet-scrim, .settings-scrim')) return
      e.stopPropagation()
      show(full ? { full: false } : { open: false })
    }
    addEventListener('keydown', k, true)
    return () => removeEventListener('keydown', k, true)
  }, [open, full])

  const send = (t: string): void => {
    const v = t.trim()
    if (!v || !where) return
    box.current?.set('')
    setText('')
    api.chats.send(where.dir, where.chatId, v)
  }
  const fresh = async (): Promise<void> => {
    setWhere(await api.assistant.fresh())
  }

  const working = !!chat?.working
  // The box sits above the button; grown, it fills the window below the title bar.
  const rect = full
    ? { right: 12, bottom: 12, width: vp.w - 24, height: vp.h - TOP - 12 }
    : { right: 16, bottom: 16 + FAB + 12, width: Math.min(400, vp.w - 32), height: Math.min(580, vp.h - TOP - FAB - 40) }

  return (
    <>
      <AnimatePresence>
        {open && (
          <motion.div
            className={`assistant${full ? ' full' : ''}`}
            initial={{ opacity: 0, y: 12, scale: 0.97, ...rect }}
            animate={{ opacity: 1, y: 0, scale: 1, ...rect }}
            exit={{ opacity: 0, y: 10, scale: 0.97 }}
            transition={tr(SETTLE)}
            style={{ transformOrigin: 'bottom right' }}
          >
            <div className="assistant-head">
              {working ? <LiveMark size={20} busy shots={false} /> : <Mark size={20} />}
              <b>Assistant</b>
              <span className="faint ellipsis">Settings, skills, and anything for your projects</span>
              <span className="spacer" />
              <IconButton icon="new-chat" tip="New conversation" onClick={fresh} disabled={!chat?.items.length} />
              <IconButton icon={full ? 'shrink' : 'expand'} tip={full ? 'Smaller' : 'Fill the window'} onClick={() => show({ full: !full })} />
              <IconButton icon="close" tip="Close" keys="esc" onClick={() => show({ open: false, full: false })} />
            </div>
            <div className="assistant-body">
              <div className="assistant-col">
                {chat && chat.items.length > 0 ? (
                  <Chat chat={chat} />
                ) : (
                  <div className="assistant-empty">
                    <motion.div {...rise(8, MOVE)}>
                      <div className="assistant-empty-title">What should Panther do?</div>
                      <div className="assistant-empty-body">
                        Change a setting, add a skill from a link, or ask for something in one of your projects. Project work goes to that project's own agent, and you're taken there.
                      </div>
                      <div className="assistant-ideas">
                        {IDEAS.map((i) => (
                          <button key={i} className="idea" onClick={() => (i.endsWith('link') ? box.current?.set('Add this skill: ') : send(i))}>{i}</button>
                        ))}
                      </div>
                    </motion.div>
                  </div>
                )}
                <div className="composer-card assistant-composer">
                  <Composer ref={box} placeholder="Ask Panther…" onSubmit={send} onChange={setText} maxRows={8} />
                  <div className="composer-row">
                    <span className="faint assistant-hint">Runs on your own agent, on this Mac</span>
                    <span className="spacer" />
                    {working ? (
                      <Tip title="Stop" body="Ends this turn.">
                        <button className="send stop" onClick={() => where && api.chats.stop(where.dir, where.chatId)}><Icon name="stop" size={12} /></button>
                      </Tip>
                    ) : (
                      <Tip title="Send" keys="⏎">
                        <button className="send" disabled={!text.trim()} onClick={() => send(box.current?.value() ?? '')}><Icon name="up" size={16} /></button>
                      </Tip>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {!(open && full) && (
          <motion.div className="assistant-fab-wrap" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }} transition={tr(QUICK)}>
            <Tip side="top" title={open ? "Close the assistant" : "Assistant"} keys="⌘J" body={open ? undefined : 'Change settings, add skills, or send work to a project.'}>
              <button className={`assistant-fab${open ? ' on' : ''}`} onClick={toggleAssistant} aria-label="Assistant">
                {open ? <Icon name="close" size={16} /> : working ? <LiveMark size={24} busy shots={false} /> : <Mark size={24} />}
                {working && !open && <i className="assistant-dot" />}
              </button>
            </Tip>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
