// The pure parts of remote.ts: quoting, the pid line, slugs, the command
// line run on a host, and which mirror belongs to which host.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: undefined, BrowserWindow: { getAllWindows: () => [] }, protocol: {} }))

const { hostOf, mirrorOf, pidLine, remoteCommand, remoteDir, saveHosts, shellPath, shQuote, slug, toolVersion, hosts } = await import('../src/main/remote')

describe('quoting', () => {
  it('quotes only when needed', () => {
    expect(shQuote('claude')).toBe('claude')
    expect(shQuote('--model=opus')).toBe('--model=opus')
    expect(shQuote('two words')).toBe("'two words'")
    expect(shQuote("it's")).toBe(`'it'\\''s'`)
    expect(shQuote('')).toBe("''")
    expect(shQuote('$HOME;rm -rf /')).toBe("'$HOME;rm -rf /'")
  })

  it('expands home paths on the host', () => {
    expect(shellPath('~/Panthr/Demo')).toBe('"$HOME"/Panthr/Demo')
    expect(shellPath('~/My Videos/x')).toBe(`"$HOME"/'My Videos/x'`)
    expect(shellPath('/srv/panthr')).toBe('/srv/panthr')
    expect(shellPath('~')).toBe('"$HOME"')
  })
})

it('reads the pid line', () => {
  expect(pidLine('PANTHR_PID 4242')).toBe(4242)
  expect(pidLine('{"type":"system"}')).toBeNull()
})

it('makes host names folder names', () => {
  expect(slug('Studio box')).toBe('Studio-box')
  expect(slug('dev@gpu-01')).toBe('dev-gpu-01')
})

it('keeps the GPUI editor version marker', () => {
  // len*31 + fold(b*131): "ab" = 2*31 + (97*131 + 98) = 12867 = 0x3243
  expect(toolVersion('ab')).toBe((2 * 31 + 97 * 131 + 98).toString(16))
})

describe('hosts and mirrors', () => {
  let tmp: string
  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'panthr-remote-'))
    process.env.PANTHR_HOSTS_FILE = join(tmp, 'hosts.json')
    process.env.PANTHR_MIRRORS = join(tmp, 'Remote')
  })
  afterAll(() => rmSync(tmp, { recursive: true, force: true }))

  it('finds the host of a mirror', () => {
    const h = { name: 'Studio box', target: 'dev@box', root: '~/Panthr/' }
    saveHosts([h])
    expect(hosts()).toEqual([h])
    const dir = mirrorOf(h, 'My Film')
    expect(dir).toBe(join(tmp, 'Remote', 'Studio-box', 'My Film'))
    expect(hostOf(dir)).toEqual({ host: h, name: 'My Film' })
    expect(hostOf(join(dir, 'sub'))?.name).toBe('My Film')
    expect(hostOf(join(tmp, 'Remote', 'Studio-box'))).toBeNull()
    expect(hostOf(join(tmp, 'elsewhere', 'x', 'y'))).toBeNull()
    expect(remoteDir(h, 'My Film')).toBe('~/Panthr/My Film')
  })

  it('defaults a missing root', () => {
    saveHosts([{ name: 'a', target: 'a' } as any])
    expect(hosts()[0].root).toBe('~/Panthr')
  })

  it('runs a program in the login shell, printing its pid first', () => {
    const h = { name: 'b', target: 'dev@box', root: '~/Panthr' }
    const c = remoteCommand(h, '~/Panthr/My Film', 'claude', ['-p', 'say "hi"'])
    expect(c.cmd).toBe('ssh')
    expect(c.args).toContain('BatchMode=yes')
    expect(c.args.some((a) => /^ControlPath=.*\/\.ssh\/panthr-%C$/.test(a))).toBe(true)
    expect(c.args.at(-2)).toBe('dev@box')
    const script = `mkdir -p "$HOME"/'Panthr/My Film' && cd "$HOME"/'Panthr/My Film' && echo PANTHR_PID $$ && exec claude -p 'say "hi"'`
    expect(c.args.at(-1)).toBe(`exec "$SHELL" -lc ${shQuote(script)}`)
  })
})
