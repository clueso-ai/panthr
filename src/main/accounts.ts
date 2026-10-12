// Agent accounts: several subscriptions at once, for Claude Code and for
// Codex. Each is signed in to its own folder: CLAUDE_CONFIG_DIR for Claude
// Code (default ~/.claude), CODEX_HOME for Codex (default ~/.codex). HOME is
// never changed: on a Mac that would move the keychain Claude Code keeps
// its sign-in in. A chat runs on one of its agent's accounts.
//
// Who an account is: `claude auth status`, or `codex login status` and the
// id token in its auth.json. How much is used: Claude Code's stream says so
// (rate_limit_event); Codex writes it into its session file (rate_limits),
// read after each run. When one hits its limit, a chat can carry on with
// the next account of the same agent: its session file is copied into that
// account's folder, so resuming finds it there.
//
// After T3 Code's provider instances (one config folder per instance).

import { execFile, spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { Api } from '@shared/api'
import type { AccountStatus, AccountUsage, AgentAccount, Engine, Settings, UsageWindow } from '@shared/types'
import { emit } from './bus'
import { readJson, writeJson } from './json'
import { dataDir, home, toolEnv } from './paths'
import { getSettings, settings } from './settings'
import { claudeBin } from './agents/claude'
import { codexBin } from './agents/codex'

/** Each agent's own account: whatever it uses on its own. */
export const DEFAULT_ID = 'default'
export const CODEX_DEFAULT_ID = 'codex'
const COLORS = ['#ff5b23', '#3d63ff', '#12b07a', '#7c5cff', '#ffb000', '#e5487f', '#06b6d4']

const ENGINES: Engine[] = ['claude', 'codex']
const listKey = (e: Engine): 'claude_accounts' | 'codex_accounts' => (e === 'codex' ? 'codex_accounts' : 'claude_accounts')
const pickKey = (e: Engine): 'claude_account' | 'codex_account' => (e === 'codex' ? 'codex_account' : 'claude_account')

const defaultAccount = (e: Engine): AgentAccount => ({ id: e === 'codex' ? CODEX_DEFAULT_ID : DEFAULT_ID, engine: e, label: 'Default', dir: '', color: '#8a8a90' })

/** An agent's accounts, its default first (no agent: both). */
export function accounts(engine?: Engine): AgentAccount[] {
  return (engine ? [engine] : ENGINES).flatMap((e) => [defaultAccount(e), ...getSettings()[listKey(e)]])
}

/** An account of an agent by id (unknown, or another agent's: the one its new chats use, else its default). */
export function accountFor(id: string | null | undefined, engine: Engine = 'claude'): AgentAccount {
  const all = accounts(engine)
  return all.find((a) => a.id === id) ?? all.find((a) => a.id === getSettings()[pickKey(engine)]) ?? all[0]
}

const engineOf = (id: string): Engine => accounts().find((a) => a.id === id)?.engine ?? 'claude'

/** An account's folder, as a path. */
export function configDir(a: AgentAccount): string {
  if (a.dir) return a.dir.replace(/^~(?=\/|$)/, home())
  return a.engine === 'codex' ? process.env.CODEX_HOME || join(home(), '.codex') : process.env.CLAUDE_CONFIG_DIR || join(home(), '.claude')
}

/** The environment an agent runs in for an account. */
export function agentEnv(engine: Engine, id?: string | null): NodeJS.ProcessEnv {
  const a = accountFor(id, engine)
  const env = toolEnv()
  if (!a.dir) return env
  const dir = configDir(a)
  // Codex will not start without its home folder.
  mkdirSync(dir, { recursive: true })
  env[engine === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'] = dir
  return env
}

export const claudeEnv = (id?: string | null): NodeJS.ProcessEnv => agentEnv('claude', id)
export const codexEnv = (id?: string | null): NodeJS.ProcessEnv => agentEnv('codex', id)

// ── Who each account is ────────────────────────────────────────────────

interface Who {
  signedIn: boolean
  email: string | null
  plan: string | null
  org: string | null
  at: number
}

const who = new Map<string, Who>()
const CHECK_MS = 60_000

const PLANS: Record<string, string> = { max: 'Max', pro: 'Pro', plus: 'Plus', team: 'Team', business: 'Business', enterprise: 'Enterprise', edu: 'Edu', free: 'Free' }
const planName = (p: string | null): string | null => (p ? PLANS[p] ?? p : null)

function exec(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((ok) => execFile(cmd, args, { env, timeout: 15_000 }, (_e, stdout, stderr) => ok(`${stdout ?? ''}\n${stderr ?? ''}`)))
}

/** The claims in a JWT (no checking: only to say who it is). */
function claims(jwt: unknown): any {
  if (typeof jwt !== 'string') return null
  try {
    return JSON.parse(Buffer.from(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
  } catch {
    return null
  }
}

async function authStatus(a: AgentAccount): Promise<Who> {
  if (a.engine === 'codex') {
    const out = await exec(codexBin(), ['login', 'status'], codexEnv(a.id))
    const signedIn = /logged in/i.test(out) && !/not logged in/i.test(out)
    const auth = readJson<any>(join(configDir(a), 'auth.json'), {})
    const c = claims(auth?.tokens?.id_token)
    const sub = c?.['https://api.openai.com/auth']?.chatgpt_plan_type ?? null
    return { signedIn, email: typeof c?.email === 'string' ? c.email : null, plan: signedIn ? planName(sub) ?? (auth?.OPENAI_API_KEY ? 'API key' : null) : null, org: null, at: Date.now() }
  }
  let v: any = null
  try {
    v = JSON.parse((await exec(claudeBin(), ['auth', 'status'], claudeEnv(a.id))).trim().split('\n\n')[0])
  } catch {}
  const sub = typeof v?.subscriptionType === 'string' ? v.subscriptionType : null
  return {
    signedIn: v?.loggedIn === true,
    email: typeof v?.email === 'string' ? v.email : null,
    plan: planName(sub) ?? (v?.authMethod === 'api-key' || v?.authMethod === 'apiKey' ? 'API key' : null),
    org: typeof v?.orgName === 'string' ? v.orgName : null,
    at: Date.now()
  }
}

// ── How much each is used ──────────────────────────────────────────────

const usageFile = (): string => join(dataDir(), 'agent-usage.json')
let usage: Record<string, AccountUsage> | null = null
// (The first version kept Claude's alone, in claude-usage.json.)
const usages = (): Record<string, AccountUsage> => (usage ??= readJson<Record<string, AccountUsage> | null>(usageFile(), null) ?? readJson<Record<string, AccountUsage>>(join(dataDir(), 'claude-usage.json'), {}))

/** Heard about an account: how much is used. */
export function noteUsage(id: string, u: Omit<AccountUsage, 'at'>): void {
  usages()[id] = { ...u, at: Date.now() }
  writeJson(usageFile(), usage)
  changed()
}

/** Past its limit (blocked, or on extra usage), and not reset since. */
export function overLimit(id: string): boolean {
  const u = usages()[id]
  if (!u || u.status !== 'rejected') return false
  return !u.resetsAt || u.resetsAt * 1000 > Date.now()
}

/** At its limit with nothing to carry on with: its turns fail. */
export const atLimit = (id: string): boolean => overLimit(id) && !usages()[id]?.overage

/** The account to carry on with after `from` hits its limit: the same agent, signed in, not at its own limit. */
export async function nextAccount(engine: Engine, from: string): Promise<AgentAccount | null> {
  const all = accounts(engine)
  const i = Math.max(0, all.findIndex((a) => a.id === accountFor(from, engine).id))
  for (let k = 1; k < all.length; k++) {
    const a = all[(i + k) % all.length]
    // Another account past its limit (blocked or paying extra) is no better.
    if (overLimit(a.id)) continue
    const w = who.get(a.id) && Date.now() - who.get(a.id)!.at < CHECK_MS ? who.get(a.id)! : await authStatus(a)
    who.set(a.id, w)
    if (w.signedIn) return a
  }
  return null
}

/** Codex's session file for a thread (sessions/YYYY/MM/DD/rollout-…-<id>.jsonl), newest days first. */
function codexSession(home: string, thread: string): string | null {
  const root = join(home, 'sessions')
  const desc = (d: string): string[] => {
    try {
      return readdirSync(d).sort().reverse()
    } catch {
      return []
    }
  }
  for (const y of desc(root)) for (const m of desc(join(root, y))) for (const d of desc(join(root, y, m))) {
    const f = desc(join(root, y, m, d)).find((n) => n.endsWith(`${thread}.jsonl`))
    if (f) return join(root, y, m, d, f)
  }
  return null
}

/** A chat's conversation, copied into another account's folder (resuming looks there). */
export function moveSession(engine: Engine, sessionId: string, from: string, to: string): boolean {
  const src = configDir(accountFor(from, engine))
  const dst = configDir(accountFor(to, engine))
  if (src === dst) return true
  if (engine === 'codex') {
    const f = codexSession(src, sessionId)
    if (!f) return false
    const target = join(dst, relative(src, f))
    mkdirSync(join(target, '..'), { recursive: true })
    copyFileSync(f, target)
    return true
  }
  let folders: string[] = []
  try {
    folders = readdirSync(join(src, 'projects'))
  } catch {
    return false
  }
  for (const f of folders) {
    const file = join(src, 'projects', f, `${sessionId}.jsonl`)
    if (!existsSync(file)) continue
    mkdirSync(join(dst, 'projects', f), { recursive: true })
    copyFileSync(file, join(dst, 'projects', f, `${sessionId}.jsonl`))
    return true
  }
  return false
}

/** What Codex wrote about its limits during a thread (the last of them), as usage. */
export function codexUsage(id: string, thread: string): Omit<AccountUsage, 'at'> | null {
  const f = codexSession(configDir(accountFor(id, 'codex')), thread)
  if (!f) return null
  let text = ''
  try {
    text = readFileSync(f, 'utf8')
  } catch {
    return null
  }
  const lines = text.trimEnd().split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"rate_limits"')) continue
    let r: any
    try {
      const v = JSON.parse(lines[i])
      r = v?.payload?.rate_limits ?? v?.rate_limits ?? v?.payload?.info?.rate_limits
    } catch {
      continue
    }
    if (!r) continue
    const win = (w: any): UsageWindow | null => (w && typeof w.used_percent === 'number' ? { utilization: w.used_percent / 100, resetsAt: typeof w.resets_at === 'number' ? w.resets_at : null } : null)
    // Codex's windows by length: five hours, and a week.
    const ws = [r.primary, r.secondary].filter(Boolean)
    const byLen = (min: number, max: number) => win(ws.find((w: any) => w.window_minutes >= min && w.window_minutes <= max))
    const five = byLen(1, 1440)
    const week = byLen(1441, 100000)
    const worst = Math.max(five?.utilization ?? 0, week?.utilization ?? 0)
    const hit = r.rate_limit_reached_type != null || worst >= 1
    const resets = hit ? (worst >= 1 && week && week.utilization >= 1 ? week.resetsAt : five?.resetsAt ?? week?.resetsAt ?? null) : null
    return { status: hit ? 'rejected' : worst >= 0.75 ? 'allowed_warning' : 'allowed', resetsAt: resets, five_hour: five, seven_day: week }
  }
  return null
}

// ── The list ───────────────────────────────────────────────────────────

const statusOf = (a: AgentAccount): AccountStatus => {
  const w = who.get(a.id)
  return { ...a, signedIn: w ? w.signedIn : null, email: w?.email ?? null, plan: w?.plan ?? null, org: w?.org ?? null, usage: usages()[a.id] ?? null }
}

let timer: NodeJS.Timeout | null = null
function changed(): void {
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    emit('accounts', accounts().map(statusOf))
  }, 60)
}

async function refresh(force: boolean): Promise<void> {
  await Promise.all(accounts().map(async (a) => {
    const w = who.get(a.id)
    if (!force && w && Date.now() - w.at < CHECK_MS) return
    who.set(a.id, await authStatus(a))
  }))
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'account'

async function setAccounts(engine: Engine, list: AgentAccount[]): Promise<void> {
  await settings.set({ [listKey(engine)]: list } as Partial<Settings>)
}

/** A sign-in that is waiting for the person in Terminal: checked until it lands. */
function watchSignIn(id: string): void {
  let n = 0
  const tick = async (): Promise<void> => {
    const a = accounts().find((x) => x.id === id)
    if (!a || n++ > 60) return
    const w = await authStatus(a)
    who.set(id, w)
    changed()
    if (!w.signedIn) setTimeout(tick, 5000)
  }
  setTimeout(tick, 4000)
}

export const accountsApi: Api['accounts'] = {
  async list(force) {
    await refresh(!!force)
    return accounts().map(statusOf)
  },
  async add(engine, label) {
    const name = label.trim() || 'Account'
    const taken = new Set(accounts().map((a) => a.id))
    const base = engine === 'codex' ? `codex-${slug(name)}` : slug(name)
    let id = base
    for (let n = 2; taken.has(id) || id === DEFAULT_ID || id === CODEX_DEFAULT_ID; n++) id = `${base}-${n}`
    const dir = engine === 'codex' ? `~/.codex-${id.replace(/^codex-/, '')}` : `~/.claude-${id}`
    const a: AgentAccount = { id, engine, label: name, dir, color: COLORS[(accounts(engine).length - 1) % COLORS.length] }
    mkdirSync(configDir(a), { recursive: true })
    await setAccounts(engine, [...getSettings()[listKey(engine)], a])
    who.set(id, await authStatus(a))
    changed()
    return statusOf(a)
  },
  async rename(id, label) {
    const e = engineOf(id)
    if (!label.trim()) return
    await setAccounts(e, getSettings()[listKey(e)].map((a) => (a.id === id ? { ...a, label: label.trim() } : a)))
    changed()
  },
  async remove(id) {
    if (id === DEFAULT_ID || id === CODEX_DEFAULT_ID) return
    const e = engineOf(id)
    await setAccounts(e, getSettings()[listKey(e)].filter((a) => a.id !== id))
    if (getSettings()[pickKey(e)] === id) await settings.set({ [pickKey(e)]: defaultAccount(e).id } as Partial<Settings>)
    who.delete(id)
    changed()
  },
  async signIn(id) {
    const a = accounts().find((x) => x.id === id)
    if (!a) throw new Error('No such account')
    const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`
    if (a.dir) mkdirSync(configDir(a), { recursive: true })
    const line = a.engine === 'codex'
      ? `${a.dir ? `CODEX_HOME=${q(configDir(a))} ` : ''}${q(codexBin())} login`
      : `${a.dir ? `CLAUDE_CONFIG_DIR=${q(configDir(a))} ` : ''}${q(claudeBin())} auth login`
    // A test run never opens Terminal on the person's screen.
    if (process.env.PANTHR_SHOT) return void console.log('sign in (skipped in a test run):', line)
    const script = `tell application "Terminal"\nactivate\ndo script "${line.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\nend tell`
    spawn('osascript', ['-e', script], { stdio: 'ignore' }).unref()
    watchSignIn(id)
  },
  async setDefault(id) {
    const a = accounts().find((x) => x.id === id)
    if (!a) return
    await settings.set({ [pickKey(a.engine)]: a.id } as Partial<Settings>)
    changed()
  }
}
