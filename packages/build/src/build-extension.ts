import * as esbuild from 'esbuild'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { root } from './root.ts'
import { workspaceTooling } from './workspaceTooling.ts'

const require = createRequire(import.meta.url)
const extensionPath = join(root, 'packages', 'extension')
const outputDirectory = join(extensionPath, 'dist')
await rm(outputDirectory, { force: true, recursive: true })
await mkdir(outputDirectory, { recursive: true })

await esbuild.build({
  bundle: true,
  entryPoints: { extensionMain: join(extensionPath, 'src', 'extensionMain.ts') },
  external: ['electron', 'node:*'],
  format: 'esm',
  outdir: outputDirectory,
  platform: 'browser',
  sourcemap: true,
  target: 'esnext',
})
await esbuild.build({
  bundle: true,
  entryPoints: [join(dirname(require.resolve('three')), 'three.module.js')],
  format: 'esm',
  platform: 'browser',
  outfile: join(outputDirectory, 'three.js'),
})
await cp(join(dirname(require.resolve('esbuild-wasm')), '..', 'esbuild.wasm'), join(outputDirectory, 'esbuild.wasm'))

const files: Record<string, string> = {
  ...(await workspaceTooling()),
  '/src/main.ts': await readFile(join(root, 'src', 'main.ts'), 'utf8'),
  '/index.html': await readFile(join(root, 'index.html'), 'utf8'),
  '/package.json': JSON.stringify(
    {
      name: 'threejs-hello-world',
      type: 'module',
      dependencies: { three: JSON.parse(await readFile(join(root, 'node_modules/three/package.json'), 'utf8')).version },
      devDependencies: { '@types/three': JSON.parse(await readFile(join(root, 'node_modules/@types/three/package.json'), 'utf8')).version },
    },
    null,
    2,
  ),
  '/node_modules/three/examples/jsm/controls/OrbitControls.js': await readFile(
    join(root, 'node_modules/three/examples/jsm/controls/OrbitControls.js'),
    'utf8',
  ),
  '/tsconfig.json': JSON.stringify(
    {
      compilerOptions: { target: 'es2022', module: 'esnext', moduleResolution: 'bundler', strict: true, skipLibCheck: true, noEmit: true },
      include: ['src'],
    },
    null,
    2,
  ),
}
await writeFile(join(outputDirectory, 'workspace.json'), `${JSON.stringify(files)}\n`)

const { compileScene } = await import(new URL('../../extension/src/Compiler.ts', import.meta.url).href)
const inputs = Object.fromEntries(['/src/main.ts', '/node_modules/three/examples/jsm/controls/OrbitControls.js'].map((path) => [path, files[path]]))
const initialCode = await compileScene(esbuild.build, await readFile(join(outputDirectory, 'three.js'), 'utf8'), async (path: string) => {
  const content = files[path]
  if (content === undefined) throw new Error(`Missing initial scene input: ${path}`)
  return content
})
await writeFile(join(outputDirectory, 'initial-scene.json'), JSON.stringify({ code: initialCode, inputs }))
