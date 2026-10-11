// The Board or a project, and Settings over either. Where you were is kept:
// Panthr opens on the project that was open.

import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import type { Project } from '@shared/types'
import { api, useEvent, useSettings } from '@/lib/api'
import { tr, SETTLE } from '@/lib/motion'
import { Board } from './board/Board'
import { Editor } from './editor/Editor'
import { Settings, type Pane } from './settings/Settings'
import { isDark, toggleTheme } from './ui/ThemeToggle'
import { frostAlpha } from './ui/Controls'
import './ui/Activity' // starts listening for background work at once
import { DropVideos } from './editor/References'

type View = { kind: 'home'; from: string | null; focus: string | null } | { kind: 'project'; dir: string; first: string | null }

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
      if (!st.home && st.project && (await api.projects.load(st.project))) setView({ kind: 'project', dir: st.project, first: null })
      else setView({ kind: 'home', from: null, focus: null })
    })
  }, [])


  const open = (p: Project, first: string | null = null): void => {
    setView({ kind: 'project', dir: p.dir, first })
    api.state.set({ project: p.dir, home: false })
  }
  /** Back to the board (zooming out of the project left, or gliding to a tile). */
  const home = (focus: string | null = null): void => {
    setView((v) => ({ kind: 'home', from: v?.kind === 'project' ? v.dir : null, focus }))
    api.state.set({ home: true })
  }
  // The board's agent pointed at a tile while a project was open: go and look.
  useEvent('board:focus', (e) => {
    if (view?.kind === 'project') home(e.key)
  }, [view])

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
            <Board returnTo={view.from} focus={view.focus} onOpen={async (dir) => {
              const p = await api.projects.load(dir)
              if (p) open(p)
            }} onSettings={() => setSettings({ open: true, pane: 'general' })} />
          </motion.div>
        )}
        {view?.kind === 'project' && (
          <motion.div key={view.dir} className="view" initial={{ opacity: 0, scale: 0.995 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={tr(SETTLE)}>
            <Editor dir={view.dir} firstMessage={view.first} onHome={() => home()} onSettings={() => setSettings({ open: true, pane: 'general' })} />
          </motion.div>
        )}
      </AnimatePresence>
      <DropVideos board={view?.kind === 'home'} onAdded={(n) => n && dispatchEvent(new CustomEvent('panthr:reference-added'))} />
      <Settings open={settings.open} pane={settings.pane} onPane={(pane) => setSettings({ open: true, pane })} onClose={() => setSettings((x) => ({ ...x, open: false }))} />
    </>
  )
}
