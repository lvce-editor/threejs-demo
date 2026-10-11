import * as esbuild from 'esbuild-wasm'

export type ReadSource = (path: string) => Promise<string>

export const createCompiler = (): ((readSource: ReadSource) => Promise<string>) => {
  const initialized = esbuild.initialize({ wasmURL: new URL('esbuild.wasm', import.meta.url).href, worker: false })
  const loadThree = async (): Promise<string> => {
    const response = await fetch(new URL('three.js', import.meta.url))
    if (!response.ok) throw new Error(`Unable to load Three.js: ${response.status}`)
    return response.text()
  }
  const threeSource = loadThree()
  return async (readSource: ReadSource): Promise<string> => {
    await initialized
    const three = await threeSource
    const result = await esbuild.build({
      bundle: true,
      entryPoints: ['/src/main.ts'],
      format: 'iife',
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
      write: false,
    })
    return result.outputFiles[0].text
  }
}
