// Remote hosts: projects that live and run on another machine while Panthr
// is used here. Port of studio-mac/src/remote.rs.
//
// STUB SIGNATURES — the remote port fills these in. Other modules (chats,
// controls, review, preview) call only what is declared here.

import type { Host, HostCheck } from '@shared/types'

/** The host a project lives on, and its name there (null: this Mac). */
export function hostOf(_dir: string): { host: Host; name: string } | null {
  return null
}

export function hosts(): Host[] {
  return []
}

export function saveHosts(_h: Host[]): void {}

/** Where remote projects' mirrors live here: <dataDir>/Remote/<host slug>/<project>. */
export function mirrors(): string {
  return ''
}

export function slug(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '-').replace(/^-+|-+$/g, '')
}

export function mirrorOf(_host: Host, _project: string): string {
  return ''
}

/** A project's folder on its host, as a shell path. */
export function remoteDir(_host: Host, _project: string): string {
  return ''
}

/** How to run `program args` in `dir` on the host: an ssh invocation whose
 *  first stdout line is `PANTHR_PID <pid>` (see pidLine). */
export function remoteCommand(_host: Host, _dir: string, _program: string, _args: string[]): { cmd: string; args: string[] } {
  throw new Error('remote: not ported yet')
}

/** The pid from a `PANTHR_PID <pid>` line, else null. */
export function pidLine(_line: string): number | null {
  return null
}

/** Stop a program on the host (closing ssh does not end it). */
export function kill(_host: Host, _pid: number): void {}

/** Bring the project's .studio over from the host / send it back. */
export async function pull(_dir: string): Promise<void> {}
export async function push(_dir: string): Promise<void> {}
/** Send a whole new project to its host (then keep only .studio here). */
export async function pushAll(_dir: string): Promise<void> {}
/** Bring one file (or a folder) from the project on the host here. */
export async function fetch(_dir: string, _rel: string): Promise<void> {}
export async function fetchDir(_dir: string, _rel: string): Promise<void> {}
/** A snapshot of the page at `at` seconds, made on the host, saved at rel here. */
export async function snapshot(_dir: string, _at: string, _rel: string): Promise<void> {}

/** The editor tool (resources/edit.mjs) run on the host, on the files there. */
export async function edit(_dir: string, _req: Record<string, unknown>): Promise<any> {
  throw new Error('remote: not ported yet')
}

/** The page server on the host, reached here at the returned port (started
 *  on first use, kept while the project is open). */
export async function livePort(_dir: string): Promise<number | null> {
  return null
}
export function stopLive(_dir?: string): void {}

/** The project names on a host. */
export async function list(_host: Host): Promise<string[]> {
  return []
}

export async function check(_host: Host): Promise<HostCheck> {
  return { ok: false, error: 'not ported yet', tools: [] }
}
