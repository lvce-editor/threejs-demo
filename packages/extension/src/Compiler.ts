import * as esbuild from 'esbuild-wasm'

export type ReadSource = (path: string) => Promise<string>

const getBuildOptions = (three: string, readSource: ReadSource): esbuild.BuildOptions => ({
  bundle: true,
  entryPoints: ['/src/main.ts'],
  format: 'iife',
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

const getOutput = (result: esbuild.BuildResult): string => {
  const output = result.outputFiles?.[0]?.text
  if (!output) throw new Error('Compiler returned no output')
  return output
}

export const compileScene = async (build: typeof esbuild.build, three: string, readSource: ReadSource): Promise<string> => {
  return getOutput(await build(getBuildOptions(three, readSource)))
}

export const createCompiler = (): { compile: (readSource: ReadSource) => Promise<string>; dispose: () => Promise<void> } => {
  const initialized = esbuild.initialize({ wasmURL: new URL('esbuild.wasm', import.meta.url).href, worker: false })
  const loadThree = async (): Promise<string> => {
    const response = await fetch(new URL('three.js', import.meta.url))
    if (!response.ok) throw new Error(`Unable to load Three.js: ${response.status}`)
    return response.text()
  }
  const threeSource = loadThree()
  let context: Promise<esbuild.BuildContext> | undefined
  let currentReadSource: ReadSource
  let firstBuild = true
  let warmup: Promise<void> | undefined
  const createContext = async (): Promise<esbuild.BuildContext> => {
    const three = await threeSource
    return esbuild.context(getBuildOptions(three, (path) => currentReadSource(path)))
  }
  const build = async (): Promise<string> => {
    await initialized
    context ||= createContext()
    const ready = await context
    return getOutput(await ready.rebuild())
  }
  return {
    async compile(readSource): Promise<string> {
      await warmup
      currentReadSource = readSource
      if (firstBuild) {
        firstBuild = false
        const response = await fetch(new URL('initial-scene.json', import.meta.url))
        if (!response.ok) throw new Error(`Unable to load the initial scene: ${response.status}`)
        const initial = (await response.json()) as { code: string; inputs: Record<string, string> }
        const matches = await Promise.all(Object.entries(initial.inputs).map(async ([path, content]) => (await readSource(path)) === content))
        if (matches.every(Boolean)) {
          // Warm the syntax cache without delaying the validated initial scene.
          // Failed warmup still permits a normal build and error report on edit.
          const warm = async (): Promise<void> => {
            try {
              await build()
            } catch {
              // A later edit retries the foreground build and reports errors.
            }
          }
          warmup = warm()
          return initial.code
        }
      }
      return build()
    },
    async dispose(): Promise<void> {
      await warmup
      const ready = await context
      await ready?.dispose()
    },
  }
}
