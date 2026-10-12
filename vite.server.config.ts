// The server for other machines (src/server/main.ts): one file of plain
// Node, with Electron replaced by src/server/electron.ts.
import { builtinModules } from 'node:module'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared'), electron: resolve('src/server/electron.ts') } },
  ssr: { noExternal: true },
  build: {
    ssr: 'src/server/main.ts',
    outDir: 'out/server',
    emptyOutDir: true,
    target: 'node18',
    minify: false,
    rollupOptions: {
      external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
      output: { format: 'cjs', entryFileNames: 'server.cjs', inlineDynamicImports: true }
    }
  }
})
