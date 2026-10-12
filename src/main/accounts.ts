// Claude accounts: several Claude Code subscriptions at once. Each is
// signed in to its own config folder (CLAUDE_CONFIG_DIR; the default is
// ~/.claude), and a chat runs on one of them. HOME is never changed: on a
// Mac that would move the keychain Claude Code keeps its sign-in in.
//
// Who an account is comes from `claude auth status`; how much of it is used
// comes from the rate_limit_event lines in every turn's stream. When one
// hits its limit, a chat can carry on with the next: its session file is
// copied into the other account's folder, so --resume finds it there.
//
// After T3 Code's provider instances (one config folder per instance).

import { execFile, spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Api } from '@shared/api'
import type { AccountStatus, AccountUsage, ClaudeAccount } from '@shared/types'
import { emit } from './bus'
import { readJson, writeJson } from './json'
import { dataDir, home, toolEnv } from './paths'
import { getSettings, settings } from './settings'
import { claudeBin } from './agents/claude'

export const DEFAULT_ID = 'default'
const COLORS = ['#ff5b23', '#3d63ff', '#12b07a', '#7c5cff', '#ffb000', '#e5487f', '#06b6d4']

/** The default account: whatever Claude Code uses on its own (~/.claude). */
const defaultAccount = (): ClaudeAccount => ({ id: DEFAULT_ID, label: 'Default', dir: '', color: '#8a8a90' })

/** Every account, the default first. */
export function accounts(): ClaudeAccount[] {
  return [defaultAccount(), ...getSettings().claude_accounts]
}

/** An account by id (unknown or none: the one new chats use, else the default). */
export function accountFor(id?: string | null): ClaudeAccount {
  const all = accounts()
  return all.find((a) => a.id === id) ?? all.find((a) => a.id === getSettings().claude_account) ?? all[0]
}

/** An account's config folder, as a path. */
export const configDir = (a: ClaudeAccount): string => (a.dir ? a.dir.replace(/^~(?=\/|$)/, home()) : process.env.CLAUDE_CONFIG_DIR || join(home(), '.claude'))

/** The environment Claude Code runs in for an account. */
export function claudeEnv(id?: string | null): NodeJS.ProcessEnv {
  const a = accountFor(id)
  const env = toolEnv()
  if (a.dir) env.CLAUDE_CONFIG_DIR = configDir(a)
  return env
}

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

const PLANS: Record<string, string> = { max: 'Max', pro: 'Pro', team: 'Team', enterprise: 'Enterprise', free: 'Free' }

function authStatus(a: ClaudeAccount): Promise<Who> {
  return new Promise((ok) => {
    execFile(claudeBin(), ['auth', 'status'], { env: claudeEnv(a.id), timeout: 15_000 }, (_e, stdout) => {
      let v: any = null
      try {
        v = JSON.parse(String(stdout))
      } catch {}
      const sub = typeof v?.subscriptionType === 'string' ? v.subscriptionType : null
      ok({
        signedIn: v?.loggedIn === true,
        email: typeof v?.email === 'string' ? v.email : null,
        plan: sub ? PLANS[sub] ?? sub : v?.authMethod === 'api-key' || v?.authMethod === 'apiKey' ? 'API key' : null,
        org: typeof v?.orgName === 'string' ? v.orgName : null,
        at: Date.now()
      })
    })
  })
}

// ── How much each is used ──────────────────────────────────────────────

const usageFile = (): string => join(dataDir(), 'claude-usage.json')
let usage: Record<string, AccountUsage> | null = null
const usages = (): Record<string, AccountUsage> => (usage ??= readJson<Record<string, AccountUsage>>(usageFile(), {}))

/** Heard from an account's stream: how much is used. */
export function noteUsage(id: string, u: Omit<AccountUsage, 'at'>): void {
  usages()[accountFor(id).id] = { ...u, at: Date.now() }
  writeJson(usageFile(), usage)
  changed()
}

/** At its limit, and not reset since. */
export function atLimit(id: string): boolean {
  const u = usages()[accountFor(id).id]
  if (!u || u.status !== 'rejected') return false
  return !u.resetsAt || u.resetsAt * 1000 > Date.now()
}

/** The account to carry on with after `from` hits its limit: signed in, not at its limit itself. */
export async function nextAccount(from: string): Promise<ClaudeAccount | null> {
  const all = accounts()
  const i = all.findIndex((a) => a.id === accountFor(from).id)
  for (let k = 1; k < all.length; k++) {
    const a = all[(i + k) % all.length]
    if (atLimit(a.id)) continue
    const w = who.get(a.id) && Date.now() - who.get(a.id)!.at < CHECK_MS ? who.get(a.id)! : await authStatus(a)
    who.set(a.id, w)
    if (w.signedIn) return a
  }
  return null
}

/** A chat's conversation, copied into another account's folder (--resume looks there). */
export function moveSession(sessionId: string, from: string, to: string): boolean {
  const src = join(configDir(accountFor(from)), 'projects')
  const dst = join(configDir(accountFor(to)), 'projects')
  if (src === dst) return true
  let folders: string[] = []
  try {
    folders = readdirSync(src)
  } catch {
    return false
  }
  for (const f of folders) {
    const file = join(src, f, `${sessionId}.jsonl`)
    if (!existsSync(file)) continue
    mkdirSync(join(dst, f), { recursive: true })
    copyFileSync(file, join(dst, f, `${sessionId}.jsonl`))
    return true
  }
  return false
}

// ── The list ───────────────────────────────────────────────────────────

const statusOf = (a: ClaudeAccount): AccountStatus => {
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

async function setAccounts(list: ClaudeAccount[]): Promise<void> {
  await settings.set({ claude_accounts: list })
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
  async add(label) {
    const name = label.trim() || 'Account'
    const taken = new Set(accounts().map((a) => a.id))
    let id = slug(name)
    for (let n = 2; taken.has(id); n++) id = `${slug(name)}-${n}`
    const a: ClaudeAccount = { id, label: name, dir: `~/.claude-${id}`, color: COLORS[(accounts().length - 1) % COLORS.length] }
    mkdirSync(configDir(a), { recursive: true })
    await setAccounts([...getSettings().claude_accounts, a])
    who.set(id, await authStatus(a))
    changed()
    return statusOf(a)
  },
  async rename(id, label) {
    if (id === DEFAULT_ID || !label.trim()) return
    await setAccounts(getSettings().claude_accounts.map((a) => (a.id === id ? { ...a, label: label.trim() } : a)))
    changed()
  },
  async remove(id) {
    if (id === DEFAULT_ID) return
    await setAccounts(getSettings().claude_accounts.filter((a) => a.id !== id))
    if (getSettings().claude_account === id) await settings.set({ claude_account: DEFAULT_ID })
    who.delete(id)
    changed()
  },
  async signIn(id) {
    const a = accounts().find((x) => x.id === id)
    if (!a) throw new Error('No such account')
    const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`
    const line = `${a.dir ? `CLAUDE_CONFIG_DIR=${q(configDir(a))} ` : ''}${q(claudeBin())} auth login`
    // A test run never opens Terminal on the person's screen.
    if (process.env.PANTHR_SHOT) return void console.log('sign in (skipped in a test run):', line)
    const script = `tell application "Terminal"\nactivate\ndo script "${line.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\nend tell`
    spawn('osascript', ['-e', script], { stdio: 'ignore' }).unref()
    watchSignIn(id)
  },
  async setDefault(id) {
    await settings.set({ claude_account: accounts().some((a) => a.id === id) ? id : DEFAULT_ID })
    changed()
  }
}
