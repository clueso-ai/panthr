// A small Markdown reader for replies: paragraphs, headings, lists, quotes,
// code, bold/italic/code/links inline. A ```pitches block (concepts the
// agent pitches) shows as cards to pick from. Built as React elements (never raw
// HTML), so nothing in a reply can run.

import { Fragment, useState, type ReactNode } from 'react'
import { api } from '@/lib/api'

type Block =
  | { k: 'p'; text: string }
  | { k: 'h'; level: number; text: string }
  | { k: 'ul' | 'ol'; items: string[] }
  | { k: 'code'; text: string; lang: string }
  | { k: 'quote'; text: string }
  | { k: 'table'; head: string[]; rows: string[][] }

export function blocks(src: string): Block[] {
  const out: Block[] = []
  const lines = src.replace(/\r/g, '').split('\n')
  let i = 0
  while (i < lines.length) {
    const l = lines[i]
    if (/^```/.test(l)) {
      const lang = l.slice(3).trim().toLowerCase()
      const body: string[] = []
      i++
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++])
      i++
      out.push({ k: 'code', text: body.join('\n'), lang })
      continue
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(l)
    if (h) {
      out.push({ k: 'h', level: h[1].length, text: h[2] })
      i++
      continue
    }
    if (/^\s*([-*•]|\d+[.)])\s+/.test(l)) {
      const ordered = /^\s*\d/.test(l)
      const items: string[] = []
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*•]|\d+[.)])\s+/, ''))
        i++
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) items[items.length - 1] += ' ' + lines[i++].trim()
      }
      out.push({ k: ordered ? 'ol' : 'ul', items })
      continue
    }
    // A table: a | row, a |---| rule, then rows.
    if (/^\s*\|.*\|\s*$/.test(l) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? '')) {
      const cells = (row: string): string[] => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
      const head = cells(l)
      const rows: string[][] = []
      i += 2
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]))
      out.push({ k: 'table', head, rows })
      continue
    }
    if (/^>\s?/.test(l)) {
      const body: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i])) body.push(lines[i++].replace(/^>\s?/, ''))
      out.push({ k: 'quote', text: body.join(' ') })
      continue
    }
    if (!l.trim()) {
      i++
      continue
    }
    const body: string[] = []
    while (i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|>\s?|\s*([-*•]|\d+[.)])\s+)/.test(lines[i])) body.push(lines[i++])
    out.push({ k: 'p', text: body.join('\n') })
  }
  return out
}

function inline(s: string, key = 0): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\([^)]+\))/g
  let last = 0
  let m: RegExpExecArray | null
  let n = 0
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index))
    const t = m[0]
    const k = `${key}-${n++}`
    if (t.startsWith('`')) out.push(<code key={k}>{t.slice(1, -1)}</code>)
    else if (t.startsWith('**')) out.push(<b key={k}>{inline(t.slice(2, -2), n)}</b>)
    else if (t.startsWith('*')) out.push(<i key={k}>{inline(t.slice(1, -1), n)}</i>)
    else {
      const lm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(t)!
      out.push(
        <a key={k} href="#" onClick={(e) => {
          e.preventDefault()
          api.app.openExternal(lm[2])
        }}>{lm[1]}</a>
      )
    }
    last = m.index + t.length
  }
  if (last < s.length) out.push(s.slice(last))
  return out.map((x, i) => (typeof x === 'string' ? <Fragment key={`t${i}`}>{x}</Fragment> : x))
}

export function Block({ b }: { b: Block }) {
  switch (b.k) {
    case 'p': return <p>{inline(b.text)}</p>
    case 'h': return b.level <= 2 ? <h3>{inline(b.text)}</h3> : <h4>{inline(b.text)}</h4>
    case 'ul': return <ul>{b.items.map((t, i) => <li key={i}>{inline(t)}</li>)}</ul>
    case 'ol': return <ol>{b.items.map((t, i) => <li key={i}>{inline(t)}</li>)}</ol>
    case 'code': return b.lang === 'pitches' ? <Pitches text={b.text} /> : <pre><code>{b.text}</code></pre>
    case 'quote': return <blockquote>{inline(b.text)}</blockquote>
    case 'table':
      return (
        <div className="md-table">
          <table>
            <thead><tr>{b.head.map((h, i) => <th key={i}>{inline(h)}</th>)}</tr></thead>
            <tbody>{b.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{inline(c)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      )
  }
}

interface Pitch { title: string; concept?: string; world?: string; hook?: string; recommended?: boolean }

/** The agent's pitches as cards: go with one, or tick two and mix them. */
function Pitches({ text }: { text: string }) {
  const [mix, setMix] = useState<number[]>([])
  const [chosen, setChosen] = useState<string | null>(null)
  let list: Pitch[] | null = null
  try {
    const v = JSON.parse(text)
    list = Array.isArray(v) ? v.filter((p) => p && typeof p.title === 'string') : null
  } catch {
    list = null
  }
  // Still arriving (or not readable): a quiet placeholder, not raw JSON.
  if (!list?.length) return <div className="pitches-wait faint"><span className="shine" data-text="Pitching directions…">Pitching directions…</span></div>
  const send = (msg: string, label: string): void => {
    setChosen(label)
    dispatchEvent(new CustomEvent('panthr:send', { detail: msg }))
  }
  return (
    <div className="pitches">
      {list.map((p, i) => {
        const n = i + 1
        const ticked = mix.includes(n)
        return (
          <div key={i} className={`pitch${p.recommended ? ' rec' : ''}${ticked ? ' ticked' : ''}`}>
            <div className="pitch-head">
              <span className="pitch-n mono">{n}</span>
              <b>{p.title}</b>
              {p.recommended && <span className="pitch-tag">Recommended</span>}
            </div>
            {p.concept && <div className="pitch-concept">{inline(p.concept)}</div>}
            {p.world && <div className="pitch-line"><span className="faint">World</span> {inline(p.world)}</div>}
            {p.hook && <div className="pitch-line"><span className="faint">Opens on</span> {inline(p.hook)}</div>}
            <div className="pitch-go">
              <button className="btn small primary" disabled={!!chosen} onClick={() => send(`Pitch ${n}: ${p.title}. Go with this one.`, p.title)}>Go with this</button>
              <label className="pitch-mix"><input type="checkbox" checked={ticked} disabled={!!chosen || (!ticked && mix.length >= 2)} onChange={() => setMix((m) => (ticked ? m.filter((x) => x !== n) : [...m, n]))} /> Mix</label>
            </div>
          </div>
        )
      })}
      {!chosen && mix.length === 2 && (
        <button className="btn primary pitch-mix-go" onClick={() => {
          const [a, b] = mix.map((n) => list![n - 1])
          send(`Mix pitch ${mix[0]} (${a.title}) and pitch ${mix[1]} (${b.title}): take the best of both and say how you'd combine them before building.`, `${a.title} + ${b.title}`)
        }}>Mix {mix[0]} and {mix[1]}</button>
      )}
      {chosen && <div className="pitch-chosen faint">Chose {chosen}</div>}
    </div>
  )
}
