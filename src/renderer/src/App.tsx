// Home (every project), a project (its canvas of videos and its
// conversation), or a video in the editor; Settings over any. Where you were
// is kept: Panthr opens where it was left.

import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { Engine } from '@shared/types'
import { api, useEvent, useSettings } from '@/lib/api'
import { tr, SETTLE } from '@/lib/motion'
import { Home } from './home/Home'
import { Board } from './board/Board'
import { Editor } from './editor/Editor'
import { Settings, type Pane } from './settings/Settings'
import { isDark, toggleTheme } from './ui/ThemeToggle'
import { frostAlpha } from './ui/Controls'
import './ui/Activity' // starts listening for background work at once
import { DropVideos } from './editor/References'

type View =
  | { kind: 'home' }
  /** from: the video just left (the canvas pulls back from it); focus: a tile to go to; first: an idea to send. */
  | { kind: 'canvas'; dir: string; from: string | null; focus: string | null; first: string | null }
  | { kind: 'video'; dir: string; canvas: string }

export function App() {
  const s = useSettings()
  const [view, setView] = useState<View | null>(null)
  const [settings, setSettings] = useState<{ open: boolean; pane: Pane }>({ open: false, pane: 'general' })

  // Theme, frost and motion follow Settings.
  useEffect(() => {
    const dark = isDark(s.appearance)
    document.documentElement.dataset.theme = dark ? 'night' : 'day'
    document.documentElement.dataset.motion = s.reduce_motion ? 'reduced' : 'full'
    document.documentElement.style.setProperty('--frost', String(frostAlpha(s.frost)))
  }, [s.appearance, s.reduce_motion, s.frost])
  useEffect(() => {
    const m = matchMedia('(prefers-color-scheme: dark)')
    const f = (): void => {
      if (s.appearance === 'system') document.documentElement.dataset.theme = m.matches ? 'night' : 'day'
    }
    m.addEventListener('change', f)
    return () => m.removeEventListener('change', f)
  }, [s.appearance])

  // Where we were.
  useEffect(() => {
    api.state.get().then(async (st) => {
      if (!st.home && st.project && (await api.projects.load(st.project))) {
        setView({ kind: 'video', dir: st.project, canvas: await api.canvases.of(st.project) })
      } else if (!st.home && st.canvas && (await api.projects.load(st.canvas))) {
        setView({ kind: 'canvas', dir: st.canvas, from: null, focus: null, first: null })
      } else setView({ kind: 'home' })
    })
  }, [])

  const home = (): void => {
    setView({ kind: 'home' })
    api.state.set({ home: true, project: null })
  }
  const openCanvas = (dir: string, extra: { from?: string | null; focus?: string | null; first?: string | null } = {}): void => {
    setView({ kind: 'canvas', dir, from: extra.from ?? null, focus: extra.focus ?? null, first: extra.first ?? null })
    api.state.set({ canvas: dir, project: null, home: false })
  }
  const openVideo = async (dir: string): Promise<void> => {
    const canvas = await api.canvases.of(dir)
    setView({ kind: 'video', dir, canvas })
    api.state.set({ project: dir, canvas, home: false })
  }
  /** A new project from Home: an empty canvas, its conversation given the idea. */
  const start = async (idea: string, host: string | null, engine: Engine, model: string): Promise<void> => {
    const name = idea.split(/\s+/).slice(0, 5).join(' ').replace(/[^\p{L}\p{N}]+$/u, '') || 'Untitled'
    // On a host, a project is still one video there (made as before).
    const dir = host ? await api.canvases.of((await api.projects.create(name, host)).dir) : (await api.canvases.create(name)).dir
    const p = await api.projects.load(dir)
    if (p) {
      await api.projects.saveMeta(dir, { ...p.meta, models: { ...p.meta.models, [engine]: model } })
      const chatId = p.meta.chats[0]?.id ?? (await api.chats.create(dir, engine))
      if (engine !== s.agent) await api.chats.setEngine(dir, chatId, engine)
    }
    openCanvas(dir, { first: idea })
  }

  // The command line (or the agent) opened a video here.
  useEvent('open', ({ dir }) => {
    openVideo(dir)
  })
  // The agent pointed at a tile while you were elsewhere: go and look.
  useEvent('board:focus', (e) => {
    if (view?.kind !== 'canvas' || view.dir !== e.canvas) openCanvas(e.canvas, { focus: e.key })
  }, [view])
  useEvent('command', ({ name }) => {
    if (name === 'settings') setSettings((x) => ({ ...x, open: !x.open }))
    else if (name === 'theme') toggleTheme(s.appearance)
    else if (name === 'new-project') home()
    else if (name === 'home') {
      // Up one level: a video goes back to its project, a project to Home.
      if (view?.kind === 'video') openCanvas(view.canvas, { from: view.dir })
      else home()
    } else if (name === 'open-folder') {
      api.app.chooseFolder().then(async (d) => {
        const p = d && (await api.projects.openFolder(d))
        if (p) openCanvas(await api.canvases.of(p.dir))
      })
    }
  })
  useEffect(() => {
    const f = (e: Event): void => {
      openVideo((e as CustomEvent).detail as string)
    }
    addEventListener('panthr:open-project', f)
    return () => removeEventListener('panthr:open-project', f)
  })
  useEffect(() => {
    const f = (e: Event): void => setSettings({ open: true, pane: ((e as CustomEvent).detail as Pane) || 'general' })
    addEventListener('panthr:settings', f)
    return () => removeEventListener('panthr:settings', f)
  }, [])
  const openSettings = (): void => setSettings({ open: true, pane: 'general' })

  return (
    <>
      <AnimatePresence mode="wait">
        {view?.kind === 'home' && (
          <motion.div key="home" className="view" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={tr(SETTLE)}>
            <Home onOpen={(dir) => openCanvas(dir)} onStart={start} onSettings={openSettings} />
          </motion.div>
        )}
        {view?.kind === 'canvas' && (
          <motion.div key={`canvas:${view.dir}`} className="view" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={tr(SETTLE)}>
            <Board canvas={view.dir} first={view.first} returnTo={view.from} focus={view.focus} onOpen={openVideo} onHome={home} onSettings={openSettings} />
          </motion.div>
        )}
        {view?.kind === 'video' && (
          <motion.div key={view.dir} className="view" initial={{ opacity: 0, scale: 0.995 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={tr(SETTLE)}>
            <Editor dir={view.dir} canvas={view.canvas} onHome={() => openCanvas(view.canvas, { from: view.dir })} onSettings={openSettings} />
          </motion.div>
        )}
      </AnimatePresence>
      <DropVideos board={view?.kind === 'canvas'} onAdded={(n) => n && dispatchEvent(new CustomEvent('panthr:reference-added'))} />
      <Settings open={settings.open} pane={settings.pane} onPane={(pane) => setSettings({ open: true, pane })} onClose={() => setSettings((x) => ({ ...x, open: false }))} />
    </>
  )
}
