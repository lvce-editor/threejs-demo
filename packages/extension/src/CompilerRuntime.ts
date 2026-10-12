import * as esbuild from 'esbuild-wasm'
import { createBuildCache } from './BuildCache.ts'

export type ReadSource = (path: string) => Promise<string>

export const compileScene = async (
  build: (options: esbuild.BuildOptions) => Promise<esbuild.BuildResult>,
  three: string,
  readSource: ReadSource,
): Promise<string> => {
  const result = await build({
    bundle: true,
    entryPoints: ['/src/main.ts'],
    format: 'iife',
    keepNames: true,
    minifyIdentifiers: true,
    minifySyntax: true,
    minifyWhitespace: true,
    platform: 'browser',
    plugins: [
      {
        name: 'threejs-workspace',
        setup(build): void {
          build.onResolve({ filter: /.*/ }, ({ importer, path }) => {
            if (path === 'three') return { namespace: 'three', path: 'three' }
            if (path === 'three/addons/controls/OrbitControls.js') {
              return { namespace: 'workspace', path: '/node_modules/three/examples/jsm/controls/OrbitControls.js' }
            }
            if (importer && !path.startsWith('.')) return { errors: [{ text: `Unsupported package: ${path}` }] }
            return { namespace: 'workspace', path: new URL(path, `https://workspace${importer || '/'}`).pathname }
          })
          build.onLoad({ filter: /.*/, namespace: 'three' }, () => ({ contents: three, loader: 'js' }))
          build.onLoad({ filter: /.*/, namespace: 'workspace' }, async ({ path }) => ({
            contents: await readSource(path),
            loader: path.endsWith('.ts') ? 'ts' : 'js',
          }))
        },
      },
    ],
    target: 'es2022',
    treeShaking: true,
    write: false,
  })
  const output = result.outputFiles?.[0]?.text
  if (!output) throw new Error('Compiler returned no output')
  return output
}

export const createCompilerRuntime = (): ((readSource: ReadSource) => Promise<string>) & { dispose: () => Promise<void> } => {
  let initialized: Promise<void> | undefined
  const loadThree = async (): Promise<string> => {
    const response = await fetch(new URL('three.js', import.meta.url))
    if (!response.ok) throw new Error(`Unable to load Three.js: ${response.status}`)
    return response.text()
  }
  let threeSource: Promise<string> | undefined
  let context: Promise<esbuild.BuildContext> | undefined
  let currentReadSource: ReadSource
  let tail: Promise<void> = Promise.resolve()
  let disposed = false
  const build = async (options: esbuild.BuildOptions): Promise<esbuild.BuildResult> => {
    context ||= esbuild.context(options)
    const activeContext = await context
    return activeContext.rebuild()
  }
  const cachedBuild = createBuildCache(async (readSource) => {
    if (disposed) throw new Error('Scene compiler is disposed')
    initialized ||= esbuild.initialize({ wasmURL: new URL('esbuild.wasm', import.meta.url).href, worker: false })
    threeSource ||= loadThree()
    await initialized
    const three = await threeSource
    if (disposed) throw new Error('Scene compiler is disposed')
    currentReadSource = readSource
    return compileScene(build, three, (path) => currentReadSource(path))
  })
  const compile = (readSource: ReadSource): Promise<string> => {
    const run = async (): Promise<string> => {
      if (disposed) throw new Error('Scene compiler is disposed')
      return cachedBuild(readSource)
    }
    const previous = tail
    const result = (async (): Promise<string> => {
      await previous
      return run()
    })()
    tail = (async (): Promise<void> => {
      try {
        await result
      } catch {
        // A failed scene must not prevent a later corrected save from compiling.
      }
    })()
    return result
  }
  return Object.assign(compile, {
    dispose: async (): Promise<void> => {
      disposed = true
      if (context) {
        const activeContext = await context
        await activeContext.dispose()
      }
    },
  })
}
