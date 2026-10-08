// Skills: front matter, the CLI's command line, the hub's state, linking
// into projects, and the install queue (with the CLI swapped out: no network).
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: undefined, BrowserWindow: { getAllWindows: () => [] } }))

const tmp = mkdtempSync(join(tmpdir(), 'panthr-skills-'))
const root = join(tmp, 'Panthr')
process.env.PANTHR_SKILLS_HUB = join(root, 'Skills')

const S = await import('../src/main/skills')
const { addArgs, config, defaults, frontMatter, hub, removeArgs, skills, stripAnsi, _test } = S

afterAll(() => rmSync(tmp, { recursive: true, force: true }))

describe('front matter', () => {
  it('reads plain front matter', () => {
    expect(frontMatter('---\nname: video-use\ndescription: Edit any video by conversation.\n---\n# Body')).toEqual({
      name: 'video-use',
      description: 'Edit any video by conversation.'
    })
  })

  it('reads quoted and folded descriptions', () => {
    expect(frontMatter('---\nname: x\ndescription: "Quoted: yes"\n---\n').description).toBe('Quoted: yes')
    const f = frontMatter('---\nname: hyperframes-cli\ndescription: >\n  Use the CLI loop:\n  init, add.\nlicense: Apache-2.0\n---\n')
    expect(f).toEqual({ name: 'hyperframes-cli', description: 'Use the CLI loop: init, add.' })
    expect(frontMatter('---\ndescription: |\n  last\n  lines').description).toBe('last lines')
  })

  it('no front matter is nothing', () => {
    expect(frontMatter('# Just a title')).toEqual({ name: null, description: null })
  })
})

it('keeps upstream names in the defaults', () => {
  const d = defaults()
  expect(d.some((p) => p.source === 'heygen-com/hyperframes')).toBe(true)
  expect(d.some((p) => p.source === 'browser-use/video-use')).toBe(true)
  expect(d.flatMap((p) => p.skills).every((s) => !s.includes('clueso'))).toBe(true)
})

it('builds the skills CLI command line', () => {
  expect(addArgs({ source: 'browser-use/video-use', skills: [], title: '' })).toEqual([
    '-y', 'skills', 'add', 'browser-use/video-use', '--skill', '*', '--agent', 'claude-code', '--agent', 'codex', '-y'
  ])
  expect(addArgs({ source: 'anthropics/skills', skills: ['frontend-design', 'x'], title: '' })).toEqual([
    '-y', 'skills', 'add', 'anthropics/skills', '--skill', 'frontend-design', '--skill', 'x', '--agent', 'claude-code', '--agent', 'codex', '-y'
  ])
  expect(removeArgs('gsap-core')).toEqual(['-y', 'skills', 'remove', 'gsap-core', '-y'])
  expect(stripAnsi('\x1b[31mError:\x1b[0m nope ')).toBe('Error: nope')
})

/** What `skills add` leaves in the hub: a folder per agent, and the lock. */
function fakeInstall(source: string, names: string[]): void {
  for (const n of names) {
    for (const d of ['.agents/skills', '.claude/skills']) {
      mkdirSync(join(hub(), d, n), { recursive: true })
      writeFileSync(join(hub(), d, n, 'SKILL.md'), `---\nname: ${n}\ndescription: Does ${n}.\n---\n`)
    }
  }
  const lockPath = join(hub(), 'skills-lock.json')
  const lock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, 'utf8')) : { skills: {} }
  for (const n of names) lock.skills[n] = { source }
  writeFileSync(lockPath, JSON.stringify(lock))
}

describe('the hub', () => {
  const calls: string[][] = []
  const project = join(root, 'Film')

  beforeAll(() => {
    mkdirSync(project, { recursive: true })
    writeFileSync(join(project, 'index.html'), '<html></html>')
    _test.setNpx(async (args) => {
      calls.push(args)
      if (args[2] === 'add' && args[3] === 'fail/me') throw new Error('no such package')
      if (args[2] === 'add') fakeInstall(args[3], args[3] === 'me/pack' ? ['alpha', 'beta'] : [args[3].split('/')[1]])
      if (args[2] === 'remove') {
        for (const d of ['.agents/skills', '.claude/skills']) rmSync(join(hub(), d, args[3]), { recursive: true, force: true })
      }
    })
  })

  it('seeds the defaults once, through the queue', async () => {
    S.seedSkills()
    expect((await skills.state()).running).toBe('HyperFrames')
    await _test.idle()
    expect(calls.length).toBe(defaults().length)
    expect(config().seeded).toBe(true)
    expect(config().packs.map((p) => p.source)).toEqual(defaults().map((p) => p.source))
    S.seedSkills()
    await _test.idle()
    expect(calls.length).toBe(defaults().length)
  })

  it('lists installed skills with their pack, and links them into projects', async () => {
    await skills.add('me/pack')
    await _test.idle()
    const st = await skills.state()
    expect(st.running).toBeNull()
    expect(st.skills.find((s) => s.name === 'alpha')).toEqual({ name: 'alpha', description: 'Does alpha.', pack: 'me/pack', on: true })
    // Linked into the project (by the queue's link-all), both agents.
    for (const d of ['.agents/skills', '.claude/skills']) {
      const l = join(project, d, 'alpha')
      expect(lstatSync(l).isSymbolicLink()).toBe(true)
      expect(readlinkSync(l).startsWith(hub())).toBe(true)
    }
  })

  it('leaves the project its own skills, and unlinks ones switched off', async () => {
    const own = join(project, '.claude/skills/beta')
    rmSync(own)
    mkdirSync(own)
    await skills.setOn('alpha', false)
    expect(existsSync(join(project, '.claude/skills/alpha'))).toBe(false)
    expect(lstatSync(own).isDirectory()).toBe(true)
    expect((await skills.state()).skills.find((s) => s.name === 'alpha')?.on).toBe(false)
    await skills.setOn('alpha', true)
    expect(lstatSync(join(project, '.agents/skills/alpha')).isSymbolicLink()).toBe(true)
  })

  it('removes a pack by its source, and drops dead links', async () => {
    await skills.remove('me/pack')
    await _test.idle()
    expect(calls.slice(-2)).toEqual([removeArgs('alpha'), removeArgs('beta')])
    expect(config().packs.some((p) => p.source === 'me/pack')).toBe(false)
    expect(existsSync(join(project, '.agents/skills/alpha'))).toBe(false)
    expect(lstatSync(join(project, '.agents/skills/alpha'), { throwIfNoEntry: false })).toBeUndefined()
    // The project's own folder stays.
    expect(existsSync(join(project, '.claude/skills/beta'))).toBe(true)
  })

  it('reports a failed install and keeps going', async () => {
    await skills.add('fail/me')
    await skills.add('ok/next')
    await _test.idle()
    const st = await skills.state()
    expect(st.error).toBe('fail/me: no such package')
    expect(config().packs.some((p) => p.source === 'fail/me')).toBe(false)
    expect(st.skills.some((s) => s.name === 'next' && s.pack === 'ok/next')).toBe(true)
  })
})
