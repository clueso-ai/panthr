// Home (every project) or a project (its canvas of videos, its conversation,
// and the active video's timeline); Settings over either. Where you were is
// kept: Panthr opens where it was left.

import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { Engine } from '@shared/types'
import { api, useEvent, useSettings } from '@/lib/api'
import { tr, SETTLE } from '@/lib/motion'
import { Home } from './home/Home'
import { Editor } from './editor/Editor'
import { Settings, type Pane } from './settings/Settings'
import { isDark, toggleTheme } from './ui/ThemeToggle'
import { frostAlpha } from './ui/Controls'
import './ui/Activity' // starts listening for background work at once
import { DropVideos } from './editor/References'
import { sayOnCanvas } from './board/CanvasStage'
import { openAssistant, toggleAssistant } from './assistant/Assistant'
import { RecordOverlay } from './board/Record'

type View =
  | { kind: 'home' }
  /** active: the video being edited; first: an idea to send the conversation. */
  | { kind: 'project'; canvas: string; active: string | null; first: string | null }

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
      // A project on another machine may not be reachable yet: then Home.
      const load = (dir: string) => api.projects.load(dir).catch(() => null)
      // On another machine: a moment for its connection to come up first.
      const far = /^\/@([a-z0-9]{6})\//.exec((!st.home && (st.canvas || st.project)) || '')?.[1]
      for (let i = 0; far && i < 40; i++) {
        const c = (await api.connections.list()).find((x) => x.id === far)
        if (!c || c.phase === 'connected' || c.phase === 'off' || c.phase === 'blocked') break
        await new Promise((r) => setTimeout(r, 200))
      }
      try {
        if (!st.home && st.project && (await load(st.project))) {
          return setView({ kind: 'project', canvas: await api.canvases.of(st.project), active: st.project, first: null })
        }
        if (!st.home && st.canvas && (await load(st.canvas))) return setView({ kind: 'project', canvas: st.canvas, active: null, first: null })
      } catch {}
      setView({ kind: 'home' })
    })
  }, [])

  const home = (): void => {
    setView({ kind: 'home' })
    api.state.set({ home: true, project: null })
  }
  const openProject = (canvas: string, active: string | null = null, first: string | null = null): void => {
    setView({ kind: 'project', canvas, active, first })
    api.state.set({ canvas, project: active, home: false })
  }
  /** A video: its project, with it active. */
  const openVideo = async (dir: string): Promise<void> => {
    openProject(await api.canvases.of(dir), dir)
  }
  /** A new project from Home: an empty canvas, its conversation given the idea. */
  const start = async (idea: string, host: string | null, engine: Engine, model: string): Promise<void> => {
    const name = idea.split(/\s+/).slice(0, 5).join(' ').replace(/[^\p{L}\p{N}]+$/u, '') || 'Untitled'
    // On a connection, a project there; on an older host, one video there (made as before).
    const dir = host?.startsWith('conn:') ? (await api.canvases.create(name, host.slice(5))).dir : host ? await api.canvases.of((await api.projects.create(name, host)).dir) : (await api.canvases.create(name)).dir
    const p = await api.projects.load(dir)
    if (p) {
      await api.projects.saveMeta(dir, { ...p.meta, models: { ...p.meta.models, [engine]: model } })
      const chatId = p.meta.chats[0]?.id ?? (await api.chats.create(dir, engine))
      if (engine !== s.agent) await api.chats.setEngine(dir, chatId, engine)
    }
    openProject(dir, null, idea)
  }

  // A .panthr opened (Finder, a drop, the menu): its project, with a word about what came in.
  useEvent('share:opened', (r) => {
    sayOnCanvas(r.text)
    openProject(r.dir)
  })
  const openShareFile = async (path: string): Promise<void> => {
    try {
      await api.share.open(path)
    } catch (e) {
      sayOnCanvas(`Couldn't open it: ${(e as Error).message}`)
    }
  }

  // The command line (or the agent) opened a video here.
  useEvent('open', ({ dir }) => {
    openVideo(dir)
  })
  // The agent pointed at a tile in another project (or from Home): go and look.
  useEvent('board:focus', (e) => {
    if (view?.kind !== 'project' || view.canvas !== e.canvas) openProject(e.canvas, e.key.startsWith('ref:') ? null : e.key)
  }, [view])
  // The assistant handed a message to a project's conversation: go and watch.
  useEvent('assistant:handoff', (e) => {
    if (view?.kind === 'project' && view.canvas === e.canvas) {
      if (e.active && e.active !== view.active) openProject(e.canvas, e.active)
    } else openProject(e.canvas, e.active)
  }, [view])
  useEvent('command', ({ name }) => {
    if (name === 'settings') setSettings((x) => ({ ...x, open: !x.open }))
    // The assistant lives on Home.
    else if (name === 'assistant') {
      if (view?.kind === 'home') toggleAssistant()
      else {
        home()
        openAssistant()
      }
    }
    else if (name === 'theme') toggleTheme(s.appearance)
    else if (name === 'new-project') home()
    else if (name === 'open-share') {
      api.app.chooseFiles().then((fs) => fs.filter((f) => f.endsWith('.panthr')).forEach(openShareFile))
    } else if (name === 'share' && view?.kind === 'project') {
      api.share.save(view.canvas).then((f) => f && (api.app.reveal(f), sayOnCanvas(`Saved ${f.split('/').pop()}: send it however you like`))).catch((e) => sayOnCanvas(`Couldn't share it: ${(e as Error).message}`))
    }
    else if (name === 'home') home()
    else if (name === 'open-folder') {
      api.app.chooseFolder().then(async (d) => {
        const p = d && (await api.projects.openFolder(d))
        if (p) openProject(await api.canvases.of(p.dir), p.dir)
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
    const f = (): void => {
      if (view?.kind !== 'project') return
      api.share.save(view.canvas).then((p) => p && (api.app.reveal(p), sayOnCanvas(`Saved ${p.split('/').pop()}: send it however you like`))).catch((e) => sayOnCanvas(`Couldn't share it: ${(e as Error).message}`))
    }
    addEventListener('panthr:share', f)
    return () => removeEventListener('panthr:share', f)
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
            <Home onOpen={(dir) => openProject(dir)} onStart={start} onSettings={openSettings} />
          </motion.div>
        )}
        {view?.kind === 'project' && (
          <motion.div key={view.canvas} className="view" initial={{ opacity: 0, scale: 0.995 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={tr(SETTLE)}>
            <Editor canvas={view.canvas} active={view.active} first={view.first} onActivate={(active) => openProject(view.canvas, active)} onHome={home} onSettings={openSettings} />
          </motion.div>
        )}
      </AnimatePresence>
      <RecordOverlay />
      <DropVideos board={view?.kind === 'project'} onAdded={(n) => n && dispatchEvent(new CustomEvent('panthr:reference-added'))} />
      <Settings open={settings.open} pane={settings.pane} onPane={(pane) => setSettings({ open: true, pane })} onClose={() => setSettings((x) => ({ ...x, open: false }))} />
    </>
  )
}
