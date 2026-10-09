// Skills: what the agents know how to do beyond code. Panthr keeps one
// shared set in ~/Panthr/Skills, installed with the open `skills` CLI
// (skills.sh) for Claude Code and Codex alike, and links it into every
// project (`.claude/skills`, `.agents/skills`), so a new project starts
// with all of them at once. A set of packs comes by default (HyperFrames,
// video-use, GSAP, motion design...); anyone can add more by package.
//
// Port of studio-mac/src/skills.rs.

import { spawn } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import type { Api } from '@shared/api'
import type { Pack, Skill, SkillHit, SkillsState } from '@shared/types'
import { emit } from './bus'
import { readJson, writeJson } from './json'
import { pathEnv, studioRoot } from './paths'

/** What Panthr starts with: video and motion craft, by their own names. */
export function defaults(): Pack[] {
  const p = (source: string, title: string, skills: string[] = []): Pack => ({ source, title, skills })
  return [
    p('heygen-com/hyperframes', 'HyperFrames'),
    p('browser-use/video-use', 'video-use'),
    p('greensock/gsap-skills', 'GSAP', ['gsap-core', 'gsap-timeline', 'gsap-plugins', 'gsap-utils', 'gsap-performance']),
    p('iart-ai/motion-design-skills', 'Motion design', [
      'animation-principles', 'motion-art-direction', 'shot-composition', 'color-motion', 'beat-sync-editing', 'logo-animation', 'motion-background'
    ]),
    p('iart-ai/explainer-video-skills', 'Explainer videos', ['diagram-animation', 'explainer-video', 'isometric-animation', 'whiteboard-animation']),
    p('iart-ai/data-animation-skills', 'Data animation'),
    p('iart-ai/kinetic-typography-skills', 'Kinetic typography'),
    p('csthink/dashmotion', 'Dashboard motion'),
    p('anthropics/skills', 'Frontend design', ['frontend-design'])
  ]
}

/** Where the shared skills live (a folder the `skills` CLI treats as a
 *  project). A test points it elsewhere. */
export const hub = (): string => process.env.PANTHR_SKILLS_HUB || join(studioRoot(), 'Skills')

/** The folder of projects every link goes into: the hub's parent (~/Panthr). */
const projectsRoot = (): string => dirname(hub())

/** The agents' skill folders, relative to a project. */
export const AGENT_DIRS = ['.agents/skills', '.claude/skills']

export interface Config {
  /** The packs installed (or to install). */
  packs: Pack[]
  /** Skills switched off: kept, but not linked into projects. */
  off: string[]
  /** The defaults were put in once (removing one keeps it removed). */
  seeded: boolean
  /** The user's own skills (written or imported here), by name. */
  own: string[]
}

const configPath = (): string => join(hub(), 'panthr.json')

export function config(): Config {
  const c = readJson<Partial<Config>>(configPath(), {})
  return {
    packs: (c.packs ?? []).map((p) => ({ source: p.source, skills: p.skills ?? [], title: p.title ?? '' })),
    off: c.off ?? [],
    seeded: !!c.seeded,
    own: c.own ?? []
  }
}

export function save(c: Config): void {
  writeJson(configPath(), c)
}

/** skill name -> source, from the CLI's skills-lock.json. */
function sources(): Map<string, string> {
  const v = readJson<{ skills?: Record<string, { source?: string }> }>(join(hub(), 'skills-lock.json'), {})
  return new Map(Object.entries(v.skills ?? {}).map(([k, x]) => [k, x?.source ?? '']))
}

const unquote = (s: string): string => s.replace(/^["']+|["']+$/g, '')

/** The `name:` and `description:` of a SKILL.md's front matter. */
export function frontMatter(text: string): { name: string | null; description: string | null } {
  const lines = text.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return { name: null, description: null }
  let name: string | null = null
  let desc: string | null = null
  let folded: string | null = null
  for (const l of lines.slice(1)) {
    if (l.trim() === '---') break
    if (folded !== null) {
      // A folded (>) or literal (|) description: its indented lines.
      if (l.startsWith(' ') || l.startsWith('\t')) {
        folded += (folded ? ' ' : '') + l.trim()
        continue
      }
      desc = folded
      folded = null
    }
    if (l.startsWith('name:')) name = unquote(l.slice(5).trim())
    else if (l.startsWith('description:')) {
      const v = l.slice(12).trim()
      if (['>', '|', '>-', '|-'].includes(v)) folded = ''
      else desc = unquote(v)
    }
  }
  if (folded !== null) desc = folded
  return { name, description: desc }
}

/** One installed skill, with where it is. */
export interface Installed {
  name: string
  description: string
  dir: string
  /** Where it came from (`owner/repo`), from the skills lock; null: by hand. */
  source: string | null
}

/** The skills in the shared folder (from any agent's copy, once each). */
export function installed(): Installed[] {
  const src = sources()
  const out: Installed[] = []
  for (const d of AGENT_DIRS) {
    let names: string[]
    try {
      names = readdirSync(join(hub(), d))
    } catch {
      continue
    }
    for (const name of names) {
      if (name.startsWith('.') || out.some((s) => s.name === name)) continue
      const dir = join(hub(), d, name)
      let text: string
      try {
        text = readFileSync(join(dir, 'SKILL.md'), 'utf8')
      } catch {
        continue
      }
      out.push({ name, description: frontMatter(text).description ?? '', dir, source: src.get(name) || null })
    }
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

// ── The skills CLI ────────────────────────────────────────────────────

/** The command line that installs a pack into the hub (for both agents). */
export function addArgs(pack: Pack): string[] {
  const a = ['-y', 'skills', 'add', pack.source]
  for (const s of pack.skills.length ? pack.skills : ['*']) a.push('--skill', s)
  a.push('--agent', 'claude-code', '--agent', 'codex', '-y')
  return a
}

export const removeArgs = (name: string): string[] => ['-y', 'skills', 'remove', name, '-y']

export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b[A-Za-z]/g, '').trim()
}

/** Run `npx <args>` in the hub. (A test swaps this out: no network.) */
let npx = (args: string[]): Promise<void> =>
  new Promise((res, rej) => {
    mkdirSync(hub(), { recursive: true })
    const c = spawn('npx', args, { cwd: hub(), env: { ...process.env, PATH: pathEnv(), CI: '1' }, stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    c.stderr.on('data', (b: Buffer) => (err += b.toString('utf8')))
    c.on('error', rej)
    c.on('close', (code) => {
      if (code === 0) return res()
      const line = err.split('\n').reverse().find((l) => l.trim()) ?? 'the skills tool failed'
      rej(new Error(stripAnsi(line)))
    })
  })

// ── Linking into projects ─────────────────────────────────────────────

function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

const inHub = (target: string): boolean => {
  const h = resolve(hub())
  const t = resolve(target)
  return t === h || t.startsWith(h + sep)
}

/** Link the shared skills (those switched on) into a project, and take out
 *  links to ones since removed or switched off. The project's own skills
 *  (real folders) are left alone. */
export function link(project: string): void {
  const cfg = config()
  const skills = installed()
  for (const d of AGENT_DIRS) {
    const dir = join(project, d)
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      continue
    }
    // Stale links into the hub.
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (!isLink(p)) continue
      const target = resolve(dir, readlinkSync(p))
      if (inHub(target) && (!existsSync(target) || cfg.off.includes(name))) {
        try {
          unlinkSync(p)
        } catch {}
      }
    }
    for (const s of skills) {
      if (cfg.off.includes(s.name)) continue
      const at = join(dir, s.name)
      if (existsSync(at) || isLink(at)) continue
      try {
        symlinkSync(s.dir, at)
      } catch {}
    }
  }
}

/** Every project gets the current set. */
export function linkAll(): void {
  let names: string[]
  try {
    names = readdirSync(projectsRoot())
  } catch {
    return
  }
  for (const n of names) {
    const p = join(projectsRoot(), n)
    if (resolve(p) === resolve(hub())) continue
    if (existsSync(join(p, 'index.html')) || existsSync(join(p, '.studio'))) link(p)
  }
}

/** Switch a skill on or off for every project. */
export function setOn(name: string, on: boolean): void {
  const c = config()
  c.off = c.off.filter((n) => n !== name)
  if (!on) c.off.push(name)
  save(c)
  linkAll()
}

// ── Installing in the background ──────────────────────────────────────

type Job = { kind: 'add'; pack: Pack } | { kind: 'remove'; source: string }

/** The installs waiting and running, for Settings to show. */
const jobs: { running: string | null; queue: Job[]; error: string | null } = { running: null, queue: [], error: null }
let idle: Promise<void> = Promise.resolve()
let wake: (() => void) | null = null

const title = (j: Job): string => (j.kind === 'add' ? j.pack.title || j.pack.source : `Removing ${j.source}`)

/** Where a skill came from: a default pack, one added later, or the user's own. */
export function originOf(s: Installed, cfg: Config): Skill['origin'] {
  if (cfg.own.includes(s.name) || !s.source) return 'yours'
  return defaults().some((p) => p.source === s.source) ? 'builtin' : 'added'
}

export function state(): SkillsState {
  const cfg = config()
  const skills: Skill[] = installed().map((s) => ({ name: s.name, description: s.description, pack: s.source, on: !cfg.off.includes(s.name), origin: originOf(s, cfg), dir: s.dir }))
  return { packs: cfg.packs, skills, running: jobs.running, waiting: jobs.queue.map(title), error: jobs.error }
}

function changed(): void {
  try {
    emit('skills:state', state())
  } catch {
    // No windows (a test, or before the app is ready).
  }
}

function enqueue(js: Job[]): void {
  jobs.queue.push(...js)
  jobs.error = null
  pump()
}

/** Run one job: an install, or a removal (a pack's skills, or one by name). */
async function runJob(j: Job): Promise<void> {
  if (j.kind === 'add') {
    await npx(addArgs(j.pack))
    const c = config()
    const had = c.packs.find((x) => x.source === j.pack.source)
    if (!had) c.packs.push(j.pack)
    // One more skill from a pack already here (a whole pack stays whole).
    else if (had.skills.length && j.pack.skills.length) had.skills = [...new Set([...had.skills, ...j.pack.skills])]
    else if (!j.pack.skills.length) had.skills = []
    save(c)
    return
  }
  const c = config()
  const pack = c.packs.find((p) => p.source === j.source)
  const names = pack ? installed().filter((s) => s.source === j.source).map((s) => s.name) : [j.source]
  for (const n of names) await npx(removeArgs(n))
  c.packs = c.packs.filter((p) => p.source !== j.source)
  save(c)
}

/** Start the next job when none is running. */
function pump(): void {
  if (jobs.running !== null) return changed()
  const next = jobs.queue.shift()
  if (!next) {
    changed()
    wake?.()
    wake = null
    return
  }
  if (!wake) idle = new Promise((r) => (wake = r))
  jobs.running = title(next)
  changed()
  runJob(next)
    .catch((e: Error) => {
      jobs.error = `${next.kind === 'add' ? next.pack.source : next.source}: ${e.message}`
    })
    .finally(() => {
      jobs.running = null
      linkAll()
      pump()
    })
}

/** The first launch: the default packs (once; removing one keeps it removed). */
export function seedSkills(): void {
  const c = config()
  if (c.seeded) return
  c.seeded = true
  save(c)
  enqueue(defaults().map((pack) => ({ kind: 'add', pack })))
}

// ── The user's own skills ─────────────────────────────────────────────

/** A skill's folder name: lower case, letters, digits and dashes. */
export function slug(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'skill'
}

/** Where the user's own skills are kept (beside the packs' copies). */
const ownDir = (): string => join(hub(), '.agents/skills')

/** A SKILL.md the agents can read: YAML front matter (the description
 *  folded, so a colon in it cannot turn it into a map), then the body. */
export function skillText(name: string, description: string, body: string): string {
  const desc = description.trim().replace(/\s+/g, ' ')
  return `---\nname: ${name}\ndescription: >-\n  ${desc}\n---\n\n${body.trim()}\n`
}

function freeName(base: string): string {
  let n = base
  for (let i = 2; existsSync(join(ownDir(), n)) || existsSync(join(hub(), '.claude/skills', n)); i++) n = `${base}-${i}`
  return n
}

function addOwn(names: string[]): void {
  const c = config()
  c.own = [...new Set([...c.own, ...names])]
  save(c)
  linkAll()
  changed()
}

export function createOwn(name: string, description: string, body: string): string {
  if (!name.trim()) throw new Error('A skill needs a name')
  if (!description.trim()) throw new Error('Say when the agent should use it (the description)')
  const n = freeName(slug(name))
  mkdirSync(join(ownDir(), n), { recursive: true })
  writeFileSync(join(ownDir(), n, 'SKILL.md'), skillText(n, description, body))
  addOwn([n])
  return n
}

/** Folders holding a SKILL.md: the folder itself, or its subfolders. */
function skillFolders(path: string): string[] {
  if (existsSync(join(path, 'SKILL.md'))) return [path]
  let names: string[] = []
  try {
    names = readdirSync(path)
  } catch {}
  return names.map((n) => join(path, n)).filter((d) => {
    try {
      return statSync(d).isDirectory() && existsSync(join(d, 'SKILL.md'))
    } catch {
      return false
    }
  })
}

export function importOwn(path: string): string[] {
  const found = skillFolders(path)
  if (!found.length) throw new Error('No SKILL.md in that folder (or in the folders inside it)')
  const names: string[] = []
  for (const d of found) {
    const fm = frontMatter(readFileSync(join(d, 'SKILL.md'), 'utf8'))
    const n = freeName(slug(fm.name || basename(d)))
    cpSync(d, join(ownDir(), n), { recursive: true })
    names.push(n)
  }
  addOwn(names)
  return names
}

function own(name: string): Installed {
  const s = installed().find((x) => x.name === name)
  // Yours: written or imported here, or put in the folder by hand (no package).
  if (!s || !(config().own.includes(name) || !s.source)) throw new Error(`${name} is not one of your skills`)
  return s
}

/** skills.sh's search, with what is here already marked. */
export async function search(query: string): Promise<SkillHit[]> {
  const q = query.trim()
  if (q.length < 2) return []
  const r = await fetch(`https://skills.sh/api/search?q=${encodeURIComponent(q)}`)
  if (!r.ok) throw new Error(`skills.sh answered ${r.status}`)
  const v = (await r.json()) as { skills?: { id: string; source: string; skillId: string; name: string; installs?: number; isDuplicate?: boolean }[] }
  const here = installed()
  return (v.skills ?? [])
    .filter((x) => !x.isDuplicate)
    .slice(0, 40)
    .map((x) => ({ id: x.id, name: x.skillId || x.name, source: x.source, installs: x.installs ?? 0, installed: here.some((s) => s.name === (x.skillId || x.name)) }))
}

export const skills: Api['skills'] = {
  async state() {
    return state()
  },
  async add(source) {
    const s = source.trim()
    if (s) enqueue([{ kind: 'add', pack: { source: s, skills: [], title: '' } }])
  },
  async remove(source) {
    const s = source.trim()
    if (s) enqueue([{ kind: 'remove', source: s }])
  },
  async setOn(name, on) {
    setOn(name, on)
    changed()
  },
  async link(dir) {
    link(dir)
  },
  search,
  async addOne(source, skill) {
    const s = source.trim()
    if (s && skill.trim()) enqueue([{ kind: 'add', pack: { source: s, skills: [skill.trim()], title: '' } }])
  },
  async create(name, description, body) {
    return createOwn(name, description, body)
  },
  async importFolder(path) {
    return importOwn(path)
  },
  async read(name) {
    const s = installed().find((x) => x.name === name)
    if (!s) throw new Error(`No skill called ${name}`)
    return { text: readFileSync(join(s.dir, 'SKILL.md'), 'utf8'), dir: s.dir, editable: config().own.includes(name) || !s.source }
  },
  async write(name, text) {
    writeFileSync(join(own(name).dir, 'SKILL.md'), text)
    changed()
  },
  async removeOwn(name) {
    const s = own(name)
    rmSync(s.dir, { recursive: true, force: true })
    const c = config()
    c.own = c.own.filter((n) => n !== name)
    c.off = c.off.filter((n) => n !== name)
    save(c)
    linkAll()
    changed()
  }
}

export const _test = {
  setNpx(f: (args: string[]) => Promise<void>) {
    npx = f
  },
  /** Resolves when the queue has run dry. */
  idle: () => idle
}
