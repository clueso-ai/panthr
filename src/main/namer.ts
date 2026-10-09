// A short name for a new chat (and its project) from the first message,
// asked of the cheap model of the chat's own agent: Haiku for Claude Code,
// the fast and affordable one Codex lists for Codex. Best effort: no answer
// in time, or no agent, leaves the name as it was.

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Engine } from '@shared/types'
import { claudeBin } from './agents/claude'
import { codexBin } from './agents/codex'
import { home, toolEnv } from './paths'

const WAIT_MS = 30_000

export const namePrompt = (message: string): string =>
  `Name this video project in 2 to 5 words, Title Case, from what the person asked for. ` +
  `Say what the video is (its subject or kind), not a link, filename or instruction. ` +
  `Reply with the name only: no quotes, no punctuation at the end.\n\nThey asked:\n${message.slice(0, 2000)}`

/** The model's reply as a name: its first line, unquoted, at most 48 characters. */
export function cleanName(reply: string): string | null {
  const line = reply.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? ''
  const n = line.replace(/^(name|title)\s*:\s*/i, '').replace(/^["'“‘`*_]+|["'”’`*_.!]+$/g, '').trim()
  if (!n || n.length > 48 || /^(i |sorry|here)/i.test(n)) return null
  return n
}

/** Codex's cheapest listed model: the first described as fast, affordable or efficient. */
export function cheapCodexModel(): string | null {
  try {
    const v = JSON.parse(readFileSync(join(home(), '.codex/models_cache.json'), 'utf8'))
    const list: any[] = Array.isArray(v) ? v : v?.models ?? []
    const m = list.find((x) => x?.visibility !== 'hide' && /fast|affordable|efficient|mini|small/i.test(`${x?.description ?? ''} ${x?.slug ?? ''}`))
    return typeof m?.slug === 'string' ? m.slug : null
  } catch {
    return null
  }
}

function run(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((ok) => {
    let out = ''
    // Away from any project, so no project instructions or memory load.
    const child = spawn(cmd, args, { cwd: tmpdir(), env: toolEnv(), stdio: ['ignore', 'pipe', 'ignore'] })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      ok(null)
    }, WAIT_MS)
    child.stdout!.on('data', (d) => (out += d))
    child.on('error', () => {
      clearTimeout(timer)
      ok(null)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      ok(code === 0 ? out : null)
    })
  })
}

export async function suggestName(message: string, engine: Engine): Promise<string | null> {
  const prompt = namePrompt(message)
  if (engine === 'codex') {
    const out = join(tmpdir(), `panthr-name-${process.pid}-${Date.now()}.txt`)
    const args = ['exec', '--skip-git-repo-check', '--ephemeral', '-c', 'model_reasoning_effort="low"', '-o', out]
    const m = cheapCodexModel()
    if (m) args.push('-m', m)
    args.push(prompt)
    if ((await run(codexBin(), args)) === null) return null
    try {
      return cleanName(readFileSync(out, 'utf8'))
    } catch {
      return null
    }
  }
  const reply = await run(claudeBin(), ['-p', prompt, '--model', 'haiku', '--max-turns', '1', '--tools', ''])
  return reply === null ? null : cleanName(reply)
}
