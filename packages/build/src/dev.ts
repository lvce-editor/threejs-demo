import * as esbuild from 'esbuild'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { root } from './root.ts'

const extensionPath = join(root, 'packages', 'extension')
const context = await esbuild.context({
  bundle: true,
  entryPoints: {
    extensionMain: join(extensionPath, 'src', 'extensionMain.ts'),
  },
  external: ['electron', 'node:*'],
  format: 'esm',
  outdir: join(extensionPath, 'dist'),
  platform: 'browser',
  sourcemap: true,
  target: 'esnext',
})

await context.rebuild()
await context.watch()

const server = spawn(
  process.execPath,
  [join(root, 'node_modules', '@lvce-editor', 'server', 'bin', 'server.js'), root, '--only-extension=packages/extension', '--test-path=packages/e2e'],
  {
    cwd: root,
    env: {
      ...process.env,
      PORT: process.env.PORT || '3000',
    },
    stdio: 'inherit',
  },
)

const stop = async (): Promise<void> => {
  server.kill()
  await context.dispose()
}

process.on('SIGINT', async () => {
  await stop()
  process.exit(0)
})

process.on('SIGTERM', async () => {
  await stop()
  process.exit(0)
})

server.on('exit', async (code) => {
  await context.dispose()
  process.exit(code ?? 0)
})
