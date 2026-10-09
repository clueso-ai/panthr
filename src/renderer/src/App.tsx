// Home or a project, and Settings over either. Where you were is kept:
// Panthr opens on the project that was open.

import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { Engine, Project } from '@shared/types'
import { api, useEvent, useSettings } from '@/lib/api'
import { tr, SETTLE } from '@/lib/motion'
import { Home } from './home/Home'
import { Editor } from './editor/Editor'
import { Settings, type Pane } from './settings/Settings'
import { isDark, toggleTheme } from './ui/ThemeToggle'
import { frostAlpha } from './ui/Controls'
import './ui/Activity' // starts listening for background work at once
import { DropVideos } from './editor/References'

type View = { kind: 'home' } | { kind: 'project'; dir: string; first: string | null }

export function App() {
  const s = useSettings()
  const [view, setView] = useState<View | null>(null)
  const [settings, setSettings] = useState<{ open: boolean; pane: Pane }>({ open: false, pane: 'general' })
  const [working, setWorking] = useState<Set<string>>(new Set())

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
      if (!st.home && st.project && (await api.projects.load(st.project))) setView({ kind: 'project', dir: st.project, first: null })
      else setView({ kind: 'home' })
    })
  }, [])

  useEvent('chat:state', (c) => {
    setWorking((w) => {
      if (c.working === w.has(c.dir)) return w
      const n = new Set(w)
      if (c.working) n.add(c.dir)
      else n.delete(c.dir)
      return n
    })
  })

  const open = (p: Project, first: string | null = null): void => {
    setView({ kind: 'project', dir: p.dir, first })
    api.state.set({ project: p.dir, home: false })
  }
  const home = (): void => {
    setView({ kind: 'home' })
    api.state.set({ home: true })
  }
  const start = async (idea: string, host: string | null, engine: Engine, model: string): Promise<void> => {
    const name = idea.split(/\s+/).slice(0, 5).join(' ').replace(/[^\p{L}\p{N}]+$/u, '')
    const p = await api.projects.create(name || 'Untitled', host)
    const meta = { ...p.meta, models: { ...p.meta.models, [engine]: model } }
    await api.projects.saveMeta(p.dir, meta)
    const chatId = p.meta.chats[0]?.id ?? (await api.chats.create(p.dir, engine))
    if (engine !== s.agent) await api.chats.setEngine(p.dir, chatId, engine)
    open({ ...p, meta }, idea)
  }

  // The command line opened a project here.
  useEvent('open', async ({ dir, first }) => {
    const p = await api.projects.load(dir)
    if (p) open(p, first)
  })
  useEvent('command', ({ name }) => {
    if (name === 'settings') setSettings((x) => ({ ...x, open: !x.open }))
    else if (name === 'theme') toggleTheme(s.appearance)
    else if (name === 'home' || name === 'new-project') home()
    else if (name === 'open-folder') {
      api.app.chooseFolder().then(async (d) => {
        const p = d && (await api.projects.openFolder(d))
        if (p) open(p)
      })
    }
  })
  useEffect(() => {
    const f = async (e: Event): Promise<void> => {
      const p = await api.projects.load((e as CustomEvent).detail as string)
      if (p) open(p)
    }
    addEventListener('panthr:open-project', f)
    return () => removeEventListener('panthr:open-project', f)
  })
  useEffect(() => {
    const f = (e: Event): void => setSettings({ open: true, pane: ((e as CustomEvent).detail as Pane) || 'general' })
    addEventListener('panthr:settings', f)
    return () => removeEventListener('panthr:settings', f)
  }, [])

  return (
    <>
      <AnimatePresence mode="wait">
        {view?.kind === 'home' && (
          <motion.div key="home" className="view" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={tr(SETTLE)}>
            <Home onOpen={(p) => open(p)} onStart={start} onSettings={() => setSettings({ open: true, pane: 'general' })} working={working} />
          </motion.div>
        )}
        {view?.kind === 'project' && (
          <motion.div key={view.dir} className="view" initial={{ opacity: 0, scale: 0.995 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={tr(SETTLE)}>
            <Editor dir={view.dir} firstMessage={view.first} onHome={home} onSettings={() => setSettings({ open: true, pane: 'general' })} />
          </motion.div>
        )}
      </AnimatePresence>
      <DropVideos onAdded={(n) => n && dispatchEvent(new CustomEvent('panthr:reference-added'))} />
      <Settings open={settings.open} pane={settings.pane} onPane={(pane) => setSettings({ open: true, pane })} onClose={() => setSettings((x) => ({ ...x, open: false }))} />
    </>
  )
}
