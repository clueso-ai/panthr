// The API's handlers, by namespace, and the one way in to them: the window
// (IPC), the command line (the control socket) and other Panthrs (a
// connection) all call `call`. Here (this Mac) a call is answered by the
// handlers; a call about a project on a connection goes to that machine.

import { METHODS } from '@shared/methods'
import type { Api } from '@shared/api'
import { settings } from './settings'
import { state } from './state'
import { appApi } from './app'
import { projects } from './projects'
import { chats } from './chats'
import { controls } from './controls'
import { review } from './review'
import { skills } from './skills'
import { hosts } from './hosts'
import { files } from './files'
import { references } from './references'
import { boardApi, canvasesApi } from './board'
import { historyApi } from './history'
import { brandApi } from './brand'
import { shareApi } from './share'
import { assistantApi } from './assistant'
import { connectionsApi, route } from './connections'
import { accountsApi } from './accounts'
import { usageApi } from './usage'
import { sizesApi } from './sizes'
import { schedulesApi } from './schedules'
import { recorderApi } from './recorder'

export const handlers: Api = {
  app: appApi, settings, state, projects, chats, controls, review, skills, files, hosts, references,
  board: { ...boardApi, ...sizesApi }, canvases: canvasesApi, history: historyApi, brand: brandApi, share: shareApi, assistant: assistantApi,
  connections: connectionsApi, accounts: accountsApi, usage: usageApi, schedules: schedulesApi, recorder: recorderApi
}

/** A method on this machine's handlers. */
export function local(method: string, params: unknown[]): Promise<unknown> {
  const [ns, m] = method.split('.')
  const methods = (METHODS as Record<string, Record<string, true>>)[ns]
  if (!methods || !methods[m]) return Promise.reject(new Error(`no such method: ${method}`))
  return (handlers as any)[ns][m](...params)
}

/** A method, wherever it belongs: on a connection when it is about one of its projects. */
export function call(method: string, params: unknown[]): Promise<unknown> {
  return route(method, params, local)
}
