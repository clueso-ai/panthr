// A project's brand kit on its canvas: a small pinned card with its
// swatches, type and logo, and the sheet that edits it. Saved, it is
// BRAND.md in the project folder, which the agent follows in every video.

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'motion/react'
import type { Brand } from '@shared/types'
import { api, useEvent } from '@/lib/api'
import { tr, MOVE, SETTLE } from '@/lib/motion'
import { Icon } from '@/ui/Icon'
import { IconButton } from '@/ui/Controls'
import { Tip } from '@/ui/Tooltip'

const empty = (b: Brand): boolean => !b.colors.length && !b.fonts.length && !b.logo && !b.voice.trim()

export function useBrand(dir: string): Brand | null {
  const [b, setB] = useState<Brand | null>(null)
  useEffect(() => {
    api.brand.get(dir).then(setB)
  }, [dir])
  useEvent('brand:changed', (e) => {
    if (e.dir === dir) api.brand.get(dir).then(setB)
  }, [dir])
  return b
}

/** The pinned card (or, with no kit yet, a button to make one). */
export function BrandCard({ dir, onRestyle }: { dir: string; onRestyle(): void }) {
  const brand = useBrand(dir)
  const [open, setOpen] = useState(false)
  const [logo, setLogo] = useState<string | null>(null)
  useEffect(() => {
    if (brand?.logo) api.app.fileUrl(`${dir}/${brand.logo}`).then(setLogo)
    else setLogo(null)
  }, [brand?.logo, dir])
  if (!brand) return null
  return (
    <>
      {empty(brand) ? (
        <Tip title="Brand kit" body="Colours, type, logo and voice every video in this project follows.">
          <button className="board-tool" onClick={() => setOpen(true)}><Icon name="spark" size={15} /><span>Brand</span></button>
        </Tip>
      ) : (
        <button className="brand-card" onClick={() => setOpen(true)} title="Brand kit">
          {logo && <img src={logo} alt="" />}
          <span className="brand-swatches">{brand.colors.slice(0, 6).map((c, i) => <i key={i} style={{ background: c.hex }} />)}</span>
          {brand.fonts[0] && <span className="brand-font">{brand.fonts[0].family}</span>}
        </button>
      )}
      <AnimatePresence>{open && <BrandSheet dir={dir} brand={brand} onClose={() => setOpen(false)} onRestyle={() => { setOpen(false); onRestyle() }} />}</AnimatePresence>
    </>
  )
}

function BrandSheet({ dir, brand, onClose, onRestyle }: { dir: string; brand: Brand; onClose(): void; onRestyle(): void }) {
  const [b, setB] = useState<Brand>(() => structuredClone(brand))
  const [logo, setLogo] = useState<string | null>(null)
  useEffect(() => {
    if (b.logo) api.app.fileUrl(`${dir}/${b.logo}`).then((u) => setLogo(`${u}?${Date.now()}`))
  }, [b.logo, dir])
  useEffect(() => {
    const k = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    addEventListener('keydown', k, true)
    return () => removeEventListener('keydown', k, true)
  }, [onClose])
  const save = async (): Promise<void> => {
    await api.brand.save(dir, {
      ...b,
      colors: b.colors.filter((c) => /^#[0-9a-f]{3,8}$/i.test(c.hex)),
      fonts: b.fonts.filter((f) => f.family.trim())
    })
  }
  return createPortal(
    <motion.div className="sheet-scrim" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={tr(MOVE)} onClick={onClose}>
      <motion.div className="brand-sheet" initial={{ opacity: 0, y: 12, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 8, scale: 0.98 }} transition={tr(SETTLE)} onClick={(e) => e.stopPropagation()}>
        <div className="brand-head">
          <b>Brand kit</b>
          <span className="faint">Every video in this project follows it. Saved as BRAND.md in the project folder.</span>
          <div className="refs-sheet-close"><IconButton icon="close" tip="Close" keys="esc" onClick={onClose} /></div>
        </div>

        <section>
          <h4>Colours</h4>
          <div className="brand-colors">
            {b.colors.map((c, i) => (
              <div key={i} className="brand-color">
                <input type="color" value={/^#[0-9a-f]{6}$/i.test(c.hex) ? c.hex : '#000000'} onChange={(e) => setB({ ...b, colors: b.colors.map((x, k) => (k === i ? { ...x, hex: e.target.value } : x)) })} />
                <input className="text-input" value={c.name} placeholder="Name (Primary, Ink…)" onChange={(e) => setB({ ...b, colors: b.colors.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)) })} />
                <input className="text-input mono hex" value={c.hex} onChange={(e) => setB({ ...b, colors: b.colors.map((x, k) => (k === i ? { ...x, hex: e.target.value } : x)) })} />
                <button className="link danger" onClick={() => setB({ ...b, colors: b.colors.filter((_, k) => k !== i) })}>Remove</button>
              </div>
            ))}
            <button className="btn small" onClick={() => setB({ ...b, colors: [...b.colors, { name: '', hex: '#e5487f' }] })}><Icon name="plus" size={13} /> Colour</button>
          </div>
        </section>

        <section>
          <h4>Type</h4>
          {b.fonts.map((f, i) => (
            <div key={i} className="brand-font-row">
              <input className="text-input" value={f.role} placeholder="Role (Headings, Body…)" onChange={(e) => setB({ ...b, fonts: b.fonts.map((x, k) => (k === i ? { ...x, role: e.target.value } : x)) })} />
              <input className="text-input" value={f.family} placeholder="Family (Inter, Geist…)" onChange={(e) => setB({ ...b, fonts: b.fonts.map((x, k) => (k === i ? { ...x, family: e.target.value } : x)) })} />
              <button className="link danger" onClick={() => setB({ ...b, fonts: b.fonts.filter((_, k) => k !== i) })}>Remove</button>
            </div>
          ))}
          <button className="btn small" onClick={() => setB({ ...b, fonts: [...b.fonts, { role: b.fonts.length ? 'Body' : 'Headings', family: '' }] })}><Icon name="plus" size={13} /> Font</button>
        </section>

        <section>
          <h4>Logo</h4>
          <div className="brand-logo">
            {logo ? <img src={logo} alt="" /> : <span className="faint">None yet</span>}
            <button className="btn small" onClick={async () => {
              const [f] = await api.app.chooseFiles()
              if (f) setB({ ...b, logo: await api.brand.logo(dir, f) })
            }}>{b.logo ? 'Replace' : 'Choose…'}</button>
            {b.logo && <button className="link danger" onClick={() => setB({ ...b, logo: null })}>Remove</button>}
          </div>
        </section>

        <section>
          <h4>Voice</h4>
          <textarea className="text-input brand-voice" rows={3} placeholder="How it sounds: confident, plain words, no exclamation marks…" value={b.voice} onChange={(e) => setB({ ...b, voice: e.target.value })} />
        </section>

        <div className="brand-go">
          <button className="btn" onClick={async () => { await save(); onRestyle() }} disabled={empty(b)}>Save and restyle every video</button>
          <button className="btn primary" onClick={async () => { await save(); onClose() }}>Save</button>
        </div>
      </motion.div>
    </motion.div>,
    document.body
  )
}
