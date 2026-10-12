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
  entryPoints: {
    extensionMain: join(extensionPath, 'src', 'extensionMain.ts'),
    compilerWorker: join(extensionPath, 'src', 'compilerWorker.ts'),
    demoSyncRpcClient: join(extensionPath, 'src', 'demoSyncRpcClient.ts'),
  },
  external: ['electron', 'node:*'],
  format: 'esm',
  outdir: outputDirectory,
  platform: 'browser',
  sourcemap: true,
  target: 'esnext',
})
// Keep the fixed npm library outside the editable scene's rebuild graph.
const dependencies = await esbuild.build({
  bundle: true,
  entryPoints: [join(dirname(require.resolve('three')), 'three.module.js')],
  format: 'iife',
  globalName: '__threejsDependencies',
  platform: 'browser',
  minify: true,
  write: false,
})
const threeExports = Object.keys(await import('three'))
const threeModule = threeExports.map((name) => 'export const ' + name + ' = window.__threejsDependencies.' + name).join('\n')
await writeFile(join(outputDirectory, 'three.js'), threeModule)
await cp(join(dirname(require.resolve('esbuild-wasm')), '..', 'esbuild.wasm'), join(outputDirectory, 'esbuild.wasm'))

const tooling = await workspaceTooling()
const files: Record<string, string> = {
  ...tooling,
  '/dist/three-dependencies.js': dependencies.outputFiles[0].text,
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
  // Keep dependency declarations out of the editor language host's explicit root-file list.
  '/workspace-types.json': JSON.stringify({
    // The browser ESLint worker preloads explicitly listed declarations from node_modules.
    files: Object.keys(tooling)
      .filter((path) => /\.d\.(?:ts|mts|cts)$/.test(path))
      .map((path) => path.slice(1)),
  }),
  '/tsconfig.json': JSON.stringify(
    {
      compilerOptions: {
        target: 'es2022',
        module: 'esnext',
        moduleResolution: 'bundler',
        strict: true,
        skipLibCheck: true,
        noEmit: true,
      },
      files: ['src/main.ts'],
      include: ['src'],
      extends: './workspace-types.json',
    },
    null,
    2,
  ),
}
// Ship the fixed initial scene so opening the demo does not wait for a cold
// WebAssembly compilation. Edited scenes still compile in the browser.
const initialScene = await esbuild.build({
  bundle: true,
  entryPoints: [join(root, 'src', 'main.ts')],
  format: 'iife',
  minifyWhitespace: true,
  platform: 'browser',
  target: 'es2022',
  treeShaking: true,
  write: false,
  plugins: [
    {
      name: 'threejs-runtime',
      setup(build): void {
        build.onResolve({ filter: /^three$/ }, () => ({ namespace: 'runtime-three', path: 'three' }))
        build.onLoad({ filter: /.*/, namespace: 'runtime-three' }, () => ({ contents: threeModule, loader: 'js' }))
      },
    },
  ],
})
files['/dist/main.js'] = initialScene.outputFiles[0].text
files['/dist/main.source.ts'] = files['/src/main.ts']
await writeFile(join(outputDirectory, 'workspace.json'), `${JSON.stringify(files)}\n`)
const previewFiles = Object.fromEntries(
  Object.entries(files).filter(
    ([path]) => !path.startsWith('/node_modules/') || path === '/node_modules/three/examples/jsm/controls/OrbitControls.js',
  ),
)
await writeFile(join(outputDirectory, 'workspace-preview.json'), `${JSON.stringify(previewFiles)}\n`)
