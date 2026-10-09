#!/usr/bin/env node
// panthr: Panthr from the command line. It drives the app (starting it,
// out of the way, when it is not running), so what you do here is what
// the window shows, and the other way round.
//
//   panthr new "A 20-second launch teaser..." --wait
//   panthr chat "Make the title bigger" --wait
//   panthr export --wait
//
// `panthr help` lists everything. Add --json to any command for output a
// script (or an agent) can read.

import { connect } from 'node:net'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

const DATA = process.env.PANTHR_DATA_DIR || join(homedir(), 'Library/Application Support/Panthr')
// As the app works it out (src/main/control.ts socketPath): a long folder's
// socket is a short stand-in in /tmp.
const SOCK = Buffer.byteLength(join(DATA, 'panthr.sock')) <= 100 ? join(DATA, 'panthr.sock') : `/tmp/panthr-${process.getuid()}-${createHash('sha1').update(DATA).digest('hex').slice(0, 12)}.sock`
const TTY = process.stdout.isTTY
const c = (code, s) => (TTY ? `\x1b[${code}m${s}\x1b[0m` : s)
const dim = (s) => c(2, s)
const bold = (s) => c(1, s)
const rose = (s) => c('38;5;204', s)
const green = (s) => c(32, s)
const red = (s) => c(31, s)

// ── Arguments ───────────────────────────────────────────────────

function parse(argv) {
  const pos = []
  const opt = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') {
      pos.push(...argv.slice(i + 1))
      break
    }
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split(/=(.*)/s)
      if (v !== undefined) opt[k] = v
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('-') && VALUED.has(k)) opt[k] = argv[++i]
      else opt[k] = true
    } else if (a.startsWith('-') && a.length === 2 && a !== '-') {
      const k = SHORT[a[1]] ?? a[1]
      if (VALUED.has(k) && argv[i + 1] !== undefined) opt[k] = argv[++i]
      else opt[k] = true
    } else pos.push(a)
  }
  return { pos, opt }
}
const SHORT = { p: 'project', w: 'wait', j: 'json', h: 'help', c: 'chat', m: 'model', a: 'agent' }
const VALUED = new Set(['project', 'chat', 'host', 'agent', 'model', 'at', 'name', 'when', 'file', 'skill'])

// ── The connection to the app ───────────────────────────────────

class App {
  constructor(sock) {
    this.sock = sock
    this.next = 1
    this.pending = new Map()
    this.listeners = []
    let buf = ''
    sock.setEncoding('utf8')
    sock.on('data', (chunk) => {
      buf += chunk
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (!line.trim()) continue
        const m = JSON.parse(line)
        if (m.event) for (const f of this.listeners) f(m.event, m.payload)
        else if (this.pending.has(m.id)) {
          const { ok, fail } = this.pending.get(m.id)
          this.pending.delete(m.id)
          m.error ? fail(new Error(m.error)) : ok(m.result)
        }
      }
    })
    sock.on('close', () => {
      for (const { fail } of this.pending.values()) fail(new Error('Panthr closed the connection'))
    })
  }
  call(method, ...params) {
    const id = this.next++
    return new Promise((ok, fail) => {
      this.pending.set(id, { ok, fail })
      this.sock.write(JSON.stringify({ id, method, params }) + '\n')
    })
  }
  async on(events, f) {
    this.listeners.push(f)
    await this.call('subscribe', ...events)
  }
  close() {
    this.sock.end()
  }
}

const tryConnect = () =>
  new Promise((ok, fail) => {
    const s = connect(SOCK)
    s.once('connect', () => ok(s))
    s.once('error', fail)
  })

/** The running app, or the app started (behind other windows) and waited for. */
async function app() {
  try {
    return new App(await tryConnect())
  } catch {}
  if (process.env.PANTHR_NO_LAUNCH) throw new Error('Panthr is not running.')
  const target = process.env.PANTHR_APP ? ['-g', '-a', process.env.PANTHR_APP] : ['-g', '-b', 'io.clueso.panthr']
  await new Promise((ok) => execFile('open', target, () => ok()))
  for (let i = 0; i < 60; i++) {
    await sleep(500)
    try {
      return new App(await tryConnect())
    } catch {}
  }
  throw new Error('Could not reach Panthr. Is it installed? (Set PANTHR_APP to the app if it is somewhere unusual.)')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── Helpers ─────────────────────────────────────────────────────

/** A project by path or name; with none given, the one open in the window. */
async function project(a, ref) {
  if (!ref) {
    const st = await a.call('ui.status')
    if (!st.state?.project || st.state.home) throw new Error('No project is open. Name one with -p <name>.')
    return st.state.project
  }
  if (existsSync(ref) && statSync(ref).isDirectory()) {
    const dir = resolve(ref)
    if (await a.call('projects.load', dir)) return dir
    const p = await a.call('projects.openFolder', dir)
    if (p) return p.dir
    throw new Error(`${ref} is not a project (it needs an index.html).`)
  }
  const all = await a.call('projects.list')
  const q = ref.toLowerCase()
  const exact = all.filter((p) => p.meta.name.toLowerCase() === q || basename(p.dir).toLowerCase() === q)
  const some = exact.length ? exact : all.filter((p) => p.meta.name.toLowerCase().includes(q) || basename(p.dir).toLowerCase().includes(q))
  if (some.length === 1) return some[0].dir
  if (!some.length) throw new Error(`No project called "${ref}". See: panthr projects`)
  throw new Error(`"${ref}" could be:\n${some.map((p) => `  ${p.meta.name}`).join('\n')}`)
}

/** The chat to talk to: the one named, a new one, or the newest. */
async function chatOf(a, dir, opt) {
  if (opt.new) return a.call('chats.create', dir, opt.agent || undefined)
  if (typeof opt.chat === 'string') return opt.chat
  const p = await a.call('projects.load', dir)
  const last = p?.meta.chats.at(-1)
  return last ? last.id : a.call('chats.create', dir, opt.agent || undefined)
}

function ago(ts) {
  const d = Date.now() / 1000 - ts
  if (d < 60) return 'just now'
  if (d < 3600) return `${Math.floor(d / 60)} min ago`
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`
  return `${Math.floor(d / 86400)} d ago`
}

const clock = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(2).padStart(5, '0')}`
const out = (opt, value, human) => (opt.json ? console.log(JSON.stringify(value, null, 2)) : human())

/** Print a chat's turn as it happens (from index `from`), until it ends. */
function follow(a, dir, chatId, from, opt) {
  return new Promise((done) => {
    const printed = new Map()
    let seen = false
    let lastStep = 0
    const show = (s) => {
      const items = s.items
      for (let i = from; i < items.length; i++) {
        const it = items[i]
        if ('User' in it) continue
        if ('Text' in it) {
          const was = printed.get(i) ?? ''
          if (!was && i > from) process.stdout.write('\n')
          if (it.Text.startsWith(was) && it.Text.length > was.length) process.stdout.write(it.Text.slice(was.length))
          printed.set(i, it.Text)
        } else if ('Steps' in it) {
          const done = printed.get(i) ?? 0
          for (const st of it.Steps.slice(done)) {
            process.stdout.write(`${lastStep === i ? '' : '\n'}${dim(`  ${st.agent ? '  ' : ''}› ${st.summary || st.name}`)}\n`)
            lastStep = i
          }
          printed.set(i, it.Steps.length)
        } else if ('Note' in it && !printed.has(i)) {
          process.stdout.write(dim(`\n  ${it.Note}\n`))
          printed.set(i, true)
        } else if ('Meta' in it && !printed.has(i)) {
          const m = it.Meta
          process.stdout.write('\n' + (m.error ? red('The turn ended with an error.') : dim(`Worked for ${Math.round(m.seconds)}s${m.cost_usd > 0 ? ` · $${m.cost_usd.toFixed(2)}` : ''}`)) + '\n')
          printed.set(i, true)
        }
      }
    }
    a.on(['chat:state'], (ev, s) => {
      if (s.dir !== dir || s.chatId !== chatId) return
      if (s.working) seen = true
      if (!opt.json) show(s)
      if (seen && !s.working) done(s)
    })
  })
}

// ── Commands ────────────────────────────────────────────────────

const commands = {
  async status(a, { opt }) {
    const st = await a.call('ui.status')
    out(opt, st, () => {
      console.log(`${bold('Panthr')} ${st.version}  ${st.working ? green('● an agent is working') : dim('idle')}`)
      console.log(st.state?.project && !st.state.home ? `Open: ${st.state.project}` : 'On Home')
    })
  },

  async projects(a, { opt }) {
    const all = await a.call('projects.list')
    out(opt, all, () => {
      if (!all.length) return console.log(dim('No projects yet. Start one: panthr new "…"'))
      for (const p of all) console.log(`${bold(p.meta.name)}  ${dim(p.host ? `on ${p.host}` : `edited ${ago(p.edited_at || p.meta.created_at)}`)}\n  ${dim(p.dir)}`)
    })
  },

  async new(a, { pos, opt }) {
    const idea = pos.join(' ').trim()
    if (!idea) throw new Error('Say what the video is: panthr new "A 20-second launch teaser…"')
    const name = idea.split(/\s+/).slice(0, 5).join(' ').replace(/[^\p{L}\p{N}]+$/u, '') || 'Untitled'
    const s = await a.call('settings.get')
    const engine = opt.agent || s.agent
    const p = await a.call('projects.create', name, opt.host || null)
    if (opt.model) await a.call('projects.saveMeta', p.dir, { ...p.meta, models: { ...p.meta.models, [engine]: opt.model } })
    const chatId = p.meta.chats[0]?.id ?? (await a.call('chats.create', p.dir, engine))
    if (engine !== s.agent) await a.call('chats.setEngine', p.dir, chatId, engine)
    const wait = opt.wait ? follow(a, p.dir, chatId, 1, opt) : null
    await a.call('chats.send', p.dir, chatId, idea)
    if (!opt['no-open']) await a.call('ui.open', p.dir)
    if (!opt.json) console.log(`${rose('●')} ${bold(p.meta.name)} ${dim(p.dir)}`)
    if (wait) {
      const s2 = await wait
      if (opt.json) console.log(JSON.stringify({ dir: p.dir, chat: chatId, items: s2.items }, null, 2))
    } else out(opt, { dir: p.dir, chat: chatId }, () => console.log(dim('The agent is on it. Follow along: panthr log -p ' + JSON.stringify(p.meta.name) + ' --wait')))
  },

  async open(a, { opt }) {
    const dir = await project(a, opt.project)
    await a.call('ui.open', dir)
    if (opt.show) await a.call('ui.show')
    out(opt, { dir }, () => console.log(dir))
  },

  async chat(a, { pos, opt }) {
    const text = pos.join(' ').trim()
    if (!text) throw new Error('What should the agent do? panthr chat "Make the title bigger"')
    const dir = await project(a, opt.project)
    const chatId = await chatOf(a, dir, opt)
    const before = await a.call('chats.open', dir, chatId)
    const wait = opt.wait ? follow(a, dir, chatId, before.items.length + 1, opt) : null
    await a.call('chats.send', dir, chatId, text)
    if (wait) {
      const s = await wait
      if (opt.json) console.log(JSON.stringify(s.items.slice(before.items.length), null, 2))
    } else out(opt, { dir, chat: chatId, queued: before.working }, () => console.log(dim(before.working ? 'Queued: it goes when the current turn ends.' : 'Sent.')))
  },

  async stop(a, { opt }) {
    const dir = await project(a, opt.project)
    const chatId = await chatOf(a, dir, opt)
    await a.call('chats.stop', dir, chatId)
    out(opt, { stopped: true }, () => console.log('Stopped.'))
  },

  async log(a, { opt }) {
    const dir = await project(a, opt.project)
    const chatId = await chatOf(a, dir, opt)
    const s = await a.call('chats.open', dir, chatId)
    if (opt.json && !opt.wait) return console.log(JSON.stringify(s, null, 2))
    for (const it of s.items) {
      if ('User' in it) console.log(`\n${rose('›')} ${bold(it.User)}`)
      else if ('Text' in it) console.log(`\n${it.Text}`)
      else if ('Steps' in it) for (const st of it.Steps) console.log(dim(`  › ${st.summary || st.name}`))
      else if ('Note' in it) console.log(dim(`  ${it.Note}`))
      else if ('Meta' in it) console.log(dim(`Worked for ${Math.round(it.Meta.seconds)}s${it.Meta.cost_usd > 0 ? ` · $${it.Meta.cost_usd.toFixed(2)}` : ''}`))
    }
    if (opt.wait && s.working) await follow(a, dir, chatId, s.items.length, opt)
  },

  async export(a, { opt }) {
    const dir = await project(a, opt.project)
    let result = null
    const done = new Promise((ok) => {
      a.on(['job'], (ev, j) => {
        if (j.dir !== dir) return
        if (j.type === 'progress' && TTY && !opt.json) process.stdout.write(`\r${rose('Exporting')} ${String(Math.round(j.percent)).padStart(3)}%`)
        if (j.type === 'stage' && !TTY && !opt.json) console.log(j.text)
        if (j.type === 'rendered') ok((result = { ok: true, version: j.version, file: join(dir, '.studio/versions', j.version.file) }))
        if (j.type === 'failed') ok((result = { ok: false, error: j.error }))
      })
    })
    await a.call('review.render', dir)
    if (!opt.wait) return out(opt, { started: true }, () => console.log(dim('Exporting. It appears in Versions when done (panthr versions).')))
    await done
    if (TTY && !opt.json) process.stdout.write('\r\x1b[K')
    out(opt, result, () => console.log(result.ok ? `${green('✓')} v${result.version.n}  ${result.file}` : red(`Export failed: ${result.error}`)))
    if (!result.ok) process.exitCode = 1
  },

  async versions(a, { opt }) {
    const dir = await project(a, opt.project)
    const v = await a.call('review.versions', dir)
    out(opt, v.map((x) => ({ ...x, path: join(dir, '.studio/versions', x.file) })), () => {
      if (!v.length) return console.log(dim('No versions yet: panthr export --wait'))
      for (const x of v) console.log(`${bold(`v${x.n}`)}  ${dim(`${ago(x.created_at)} · ${(x.bytes / 1e6).toFixed(1)} MB${x.duration ? ` · ${x.duration.toFixed(1)}s` : ''}`)}\n  ${join(dir, '.studio/versions', x.file)}`)
    })
  },

  async notes(a, { opt }) {
    const dir = await project(a, opt.project)
    const n = await a.call('review.comments', dir)
    out(opt, n, () => {
      if (!n.length) return console.log(dim('No notes. Add one: panthr note "…" --at 2.5'))
      for (const x of n) console.log(`${x.resolved ? green('✓') : c(33, '●')} ${dim(x.id)}  ${clock(x.time)}${x.end != null ? `–${clock(x.end)}` : ''}  ${x.body}${x.reply ? `\n    ${dim('↳ ' + x.reply)}` : ''}`)
    })
  },

  async note(a, { pos, opt }) {
    const body = pos.join(' ').trim()
    if (!body) throw new Error('panthr note "The logo is too small here" --at 2.5[-4]')
    const dir = await project(a, opt.project)
    const [t0, t1] = String(opt.at ?? '0').split('-').map(Number)
    if (Number.isNaN(t0)) throw new Error('--at takes seconds, or a span like 2.5-4')
    const all = await a.call('review.comments', dir)
    const n = { id: Math.random().toString(16).slice(2, 10), time: Math.round(t0 * 100) / 100, ...(t1 >= 0 ? { end: Math.round(t1 * 100) / 100 } : {}), body, resolved: false, created_at: Math.floor(Date.now() / 1000) }
    await a.call('review.saveComments', dir, [...all, n].sort((x, y) => x.time - y.time))
    out(opt, n, () => console.log(`${c(33, '●')} ${dim(n.id)}  ${clock(n.time)}  ${body}`))
  },

  async resolve(a, { pos, opt }) {
    const dir = await project(a, opt.project)
    const all = await a.call('review.comments', dir)
    const hit = all.filter((x) => pos.includes(x.id))
    if (!hit.length) throw new Error('Which note? panthr resolve <id> (ids: panthr notes)')
    await a.call('review.saveComments', dir, all.map((x) => (pos.includes(x.id) ? { ...x, resolved: !opt.reopen } : x)))
    out(opt, { ids: pos }, () => console.log(opt.reopen ? 'Reopened.' : 'Resolved.'))
  },

  async fix(a, { opt }) {
    // Hand every open note to the agent, as the Notes panel's "Fix all" does.
    const dir = await project(a, opt.project)
    const open = (await a.call('review.comments', dir)).filter((x) => !x.resolved).length
    if (!open) return out(opt, { open: 0 }, () => console.log('No open notes.'))
    return commands.chat(a, { pos: [`Address the ${open} open review comment${open === 1 ? '' : 's'} in .studio/comments.json. For each: make the change at that moment of the video, then set "resolved": true and add a short "reply" saying what you did.`], opt: { ...opt, project: dir } })
  },

  async layers(a, { opt }) {
    const dir = await project(a, opt.project)
    const t = await a.call('controls.timing', dir)
    out(opt, t, () => {
      const rows = Object.entries(t)
      if (!rows.length) return console.log(dim('Nothing the timeline can move yet.'))
      for (const [id, w] of rows) {
        console.log(`${bold(id)}  ${w.start != null ? `${w.start.toFixed(2)}–${w.end.toFixed(2)}s` : ''}  ${w.movable ? green('movable') : dim(`fixed: ${w.why ?? ''}`)}`)
        for (const tw of w.tweens) console.log(dim(`  ${tw.method.padEnd(6)} ${tw.start.toFixed(2)}s +${tw.duration.toFixed(2)}s  ${tw.ease ?? ''}  ${tw.id}`))
      }
    })
  },

  async edit(a, { pos, opt }) {
    // One editor-tool request, as JSON: {"op":"move","file":"index.html","layer":"title","delta":0.5}
    const dir = await project(a, opt.project)
    let req
    try {
      req = JSON.parse(pos.join(' '))
    } catch {
      throw new Error(`panthr edit '{"op":"move","file":"index.html","layer":"title","delta":0.5}'`)
    }
    const r = await a.call('controls.run', dir, req)
    out(opt, r, () => console.log(green('✓') + ' ' + (r?.file ? `Changed ${r.file}` : 'Done')))
  },

  async shot(a, { pos, opt }) {
    const path = await a.call('ui.screenshot', pos[0] ? resolve(pos[0]) : null)
    out(opt, { path }, () => console.log(path))
  },

  async settings(a, { pos, opt }) {
    const s = await a.call('settings.get')
    if (!pos.length) return out(opt, s, () => Object.entries(s).forEach(([k, v]) => console.log(`${k.padEnd(16)} ${v}`)))
    const [k, v] = pos
    if (!(k in s)) throw new Error(`No setting "${k}". Settings: ${Object.keys(s).join(', ')}`)
    if (v === undefined) return out(opt, { [k]: s[k] }, () => console.log(s[k]))
    const typed = typeof s[k] === 'boolean' ? ['true', 'on', 'yes', '1'].includes(v) : typeof s[k] === 'number' ? Number(v) : v
    const next = await a.call('settings.set', { [k]: typed })
    out(opt, next, () => console.log(`${k} = ${next[k]}`))
  },

  async skills(a, { pos, opt }) {
    const [verb, ...rest] = pos
    const arg = rest.join(' ')
    if (verb === 'search') {
      const hits = await a.call('skills.search', arg)
      return out(opt, hits, () => hits.length ? hits.forEach((h) => console.log(`${h.installed ? green('\u2713') : ' '} ${bold(h.name)}  ${dim(`${h.source} \u00b7 ${h.installs} installs`)}\n    ${dim(`panthr skills add ${h.source} --skill ${h.name}`)}`)) : console.log(dim('Nothing on skills.sh for that.')))
    }
    if (verb === 'new') {
      if (!arg || !opt.when) throw new Error('panthr skills new "<name>" --when "when the agent should use it" [--file body.md]')
      const body = typeof opt.file === 'string' ? readFileSync(resolve(opt.file), 'utf8') : ''
      const n = await a.call('skills.create', arg, opt.when, body)
      return out(opt, { name: n }, () => console.log(`${green('\u2713')} ${n}  ${dim('(edit it in Settings \u203a Skills)')}`))
    }
    if (verb === 'import' && arg) {
      const n = await a.call('skills.importFolder', resolve(arg))
      return out(opt, { names: n }, () => console.log(`${green('\u2713')} ${n.join(', ')}`))
    }
    if (verb === 'add' && rest[0]) {
      if (typeof opt.skill === 'string') await a.call('skills.addOne', rest[0], opt.skill)
      else await a.call('skills.add', rest[0])
    } else if (verb === 'remove' && arg) await a.call('skills.remove', arg)
    else if ((verb === 'on' || verb === 'off') && arg) await a.call('skills.setOn', arg, verb === 'on')
    else if (verb) throw new Error('panthr skills [search <words> | add <source> [--skill name] | new "<name>" --when "\u2026" | import <folder> | remove <source> | on|off <name>]')
    const s = await a.call('skills.state')
    out(opt, s, () => {
      for (const k of s.skills) console.log(`${k.on ? green('\u25cf') : dim('\u25cb')} ${k.name}  ${dim(k.origin === 'yours' ? 'yours' : k.pack ?? '')}`)
      if (s.running) console.log(rose(`Installing ${s.running}\u2026`) + (s.waiting.length ? dim(` (${s.waiting.length} waiting)`) : ''))
      if (s.error) console.log(red(s.error))
    })
  },

  async refs(a, { opt }) {
    const rs = await a.call('references.list')
    out(opt, rs, () => {
      if (!rs.length) return console.log(dim('No reference videos. Add one: panthr ref add <file or link>'))
      for (const r of rs) console.log(`${r.status === 'ready' ? green('\u25cf') : r.status === 'failed' ? red('\u25cf') : rose('\u25cf')} ${bold('@' + r.handle)}  ${r.name}  ${dim(r.status === 'ready' ? r.summary ?? '' : r.status === 'failed' ? r.error ?? '' : r.step ?? r.status)}`)
    })
  },

  async ref(a, { pos, opt }) {
    const [verb, ...rest] = pos
    const arg = rest.join(' ')
    const byHandle = async (h) => {
      const r = (await a.call('references.list')).find((x) => x.handle === h.replace(/^@/, '') || x.id === h)
      if (!r) throw new Error(`No reference @${h.replace(/^@/, '')}. See: panthr refs`)
      return r
    }
    if (verb === 'add' && arg) {
      const input = /^https?:/i.test(arg) ? arg : resolve(arg)
      let r = await a.call('references.add', input, typeof opt.name === 'string' ? opt.name : undefined)
      if (!opt.wait) return out(opt, r, () => console.log(`${rose('\u25cf')} @${r.handle}  ${dim('Your agent is taking it apart. Follow it: panthr refs')}`))
      const done = new Promise((ok) => a.on(['references'], (ev, list) => {
        const x = list.find((y) => y.id === r.id)
        if (!x) return
        if (TTY && !opt.json && x.step) process.stdout.write(`\r\x1b[K${dim(x.step)}`)
        if (x.status === 'ready' || x.status === 'failed') ok(x)
      }))
      r = await done
      if (TTY && !opt.json) process.stdout.write('\r\x1b[K')
      out(opt, r, () => console.log(r.status === 'ready' ? `${green('\u2713')} @${r.handle}  ${r.summary ?? ''}\n  ${dim(r.dir)}` : red(`Could not take it apart: ${r.error}`)))
      if (r.status !== 'ready') process.exitCode = 1
      return
    }
    if (verb === 'show' && arg) {
      const r = await byHandle(arg)
      const text = await a.call('references.readFile', r.id, 'README.md')
      return out(opt, { ...r, readme: text }, () => console.log(text ?? dim(`Not taken apart yet (${r.status}).`)))
    }
    if ((verb === 'rm' || verb === 'remove') && arg) {
      const r = await byHandle(arg)
      await a.call('references.remove', r.id)
      return out(opt, { removed: r.handle }, () => console.log(`Removed @${r.handle}.`))
    }
    throw new Error('panthr ref add <file or link> [--name "\u2026"] [--wait] | show <handle> | rm <handle>')
  },

  async hosts(a, { opt }) {
    const h = await a.call('hosts.list')
    out(opt, h, () => (h.length ? h.forEach((x) => console.log(`${bold(x.name)}  ${dim(`${x.target} · ${x.root}`)}`)) : console.log(dim('No hosts. Add one in Settings › Hosts.'))))
  }
}

const HELP = `${bold('panthr')} — Panthr from the command line

${bold('Make')}
  new "<idea>" [--agent claude|codex] [--model m] [--host h] [--wait] [--no-open]
                         Start a project from an idea and hand it to the agent
  chat "<message>" [--wait] [--new]
                         Ask the agent for a change (--wait prints its work as it goes)
  stop                   Stop the agent's turn
  log [--wait]           The conversation (--wait follows a running turn)
  fix [--wait]           Have the agent address every open note

${bold('Review and ship')}
  notes                  Notes pinned to moments of the video
  note "<text>" --at 2.5[-4]   Pin a note to a moment (or a span)
  resolve <id>... [--reopen]
  export [--wait]        Render to MP4 (kept in Versions)
  versions               Every export, with its file

${bold('Inside the video')}
  layers                 What moves when, and what the timeline can move
  edit '<json>'          One editor-tool request, e.g. '{"op":"move","file":"index.html","layer":"title","delta":0.5}'

${bold('The app')}
  status                 Running? Which project is open? Is an agent working?
  projects               Every project
  open                   Show a project in the window [--show to bring it forward]
  shot [file.png]        A picture of the window
  settings [key [value]] Read or change a setting
  skills [search <words> | add <source> [--skill name] | new "<name>" --when "\u2026" | import <folder> | on|off <name>]
  refs                   Reference videos (mention one in chat as @handle)
  ref add <file|link> [--wait]   Have your agent take a video apart
  ref show <handle>      What it wrote about it
  hosts                  Remote hosts

${bold('Options')}
  -p, --project <name|path>   Which project (default: the one open in the window)
  --chat <id>                 Which chat (default: the newest)
  -j, --json                  Output for scripts and agents
`

async function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  const args = parse(rest)
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.opt.help) return console.log(HELP)
  const f = commands[cmd]
  if (!f) {
    console.error(`No command "${cmd}". See: panthr help`)
    process.exitCode = 2
    return
  }
  const a = await app()
  try {
    await f(a, args)
  } finally {
    a.close()
  }
}

main().catch((e) => {
  console.error(red(e.message ?? String(e)))
  process.exitCode = 1
})
