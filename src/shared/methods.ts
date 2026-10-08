// Every API method, by namespace. The type makes this complete: a method
// added to Api and not listed here (or listed and not in Api) fails to
// compile. The preload builds window.panthr from it; main registers it.

import type { Api } from './api'

type All = { [N in keyof Api]: { [M in keyof Api[N]]: true } }

export const METHODS: All = {
  app: { missingTools: true, reveal: true, openPath: true, openExternal: true, fileUrl: true, chooseFolder: true, chooseFiles: true, quit: true },
  settings: { get: true, set: true },
  state: { get: true, set: true },
  projects: { list: true, create: true, load: true, saveMeta: true, rename: true, openFolder: true, previewUrl: true, watch: true, unwatch: true },
  chats: { open: true, create: true, send: true, stop: true, setEngine: true, note: true, remove: true, anyWorking: true, models: true },
  controls: { all: true, save: true, run: true, timing: true },
  review: { comments: true, saveComments: true, versions: true, render: true, cancelRender: true, frames: true, annotate: true, library: true, addToLibrary: true, importFiles: true },
  skills: { state: true, add: true, remove: true, setOn: true, link: true },
  files: { read: true, replace: true },
  hosts: { list: true, save: true, check: true, refresh: true }
}
