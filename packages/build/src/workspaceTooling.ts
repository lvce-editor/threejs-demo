import { build } from 'esbuild'
import { readdir, readFile } from 'node:fs/promises'
import { builtinModules, createRequire } from 'node:module'
import { join } from 'node:path'
import { removeUnreachableTypeScriptCode } from './removeUnreachableTypeScriptCode.ts'
import { root } from './root.ts'

const require = createRequire(import.meta.url)
const workspacePath = '/Three.js Demo | Lvce Editor'

export const workspaceTooling = async (): Promise<Record<string, string>> => {
  const files: Record<string, string> = {}
  const visited = new Set<string>()
  const addTypes = async (name: string): Promise<void> => {
    if (visited.has(name)) return
    visited.add(name)
    const directory = join(root, 'node_modules', name)
    const manifest = await readFile(join(directory, 'package.json'), 'utf8')
    files[`/node_modules/${name}/package.json`] = manifest
    const visit = async (relative: string): Promise<void> => {
      for (const entry of await readdir(join(directory, relative), { withFileTypes: true })) {
        if (entry.name === 'node_modules') continue
        const path = join(relative, entry.name)
        if (entry.isDirectory()) await visit(path)
        else if (/\.d\.(?:ts|mts|cts)$/.test(entry.name)) {
          files[`/node_modules/${name}/${path.replaceAll('\\', '/')}`] = await readFile(join(directory, path), 'utf8')
        }
      }
    }
    await visit('')
    for (const dependency of Object.keys(JSON.parse(manifest).dependencies || {})) await addTypes(dependency)
  }
  await addTypes('typescript')
  await addTypes('three')
  await addTypes('@types/three')
  for (const [name, entry] of [
    ['eslint', 'eslint/universal'],
    ['typescript-eslint', 'typescript-eslint'],
    ['typescript', 'typescript'],
  ]) {
    const result = await build({
      entryPoints: [require.resolve(entry)],
      bundle: true,
      platform: 'browser',
      format: 'cjs',
      external: ['node:*', ...builtinModules, 'jiti', 'jiti/package.json', ...(name === 'typescript-eslint' ? ['typescript'] : [])],
      write: false,
      plugins: [
        {
          name: 'typescript-browser-compatibility',
          setup(build) {
            // The virtual project supplies tsconfigRootDir explicitly. Browser engines
            // cannot infer a filesystem config directory through V8 stack frames.
            build.onLoad({ filter: /[/\\]typescript-eslint[/\\]dist[/\\]getTSConfigRootDirFromStack\.js$/ }, () => ({
              contents: 'exports.getTSConfigRootDirFromStack = () => undefined',
              loader: 'js',
            }))
            build.onLoad({ filter: /[/\\]typescript[/\\]lib[/\\]typescript\.js$/ }, async ({ path }) => ({
              contents: removeUnreachableTypeScriptCode(await readFile(path, 'utf8')),
              loader: 'js',
            }))
          },
        },
      ],
    })
    // Keep the compiler beside its lib.*.d.ts files so typed ESLint finds standard libraries.
    const main = name === 'typescript' ? 'lib/typescript.js' : 'index.cjs'
    files[`/node_modules/${name}/${main}`] = result.outputFiles[0].text
    files[`/node_modules/${name}/package.json`] = JSON.stringify({ name, main })
  }
  files['/eslint.config.js'] =
    `import tseslint from 'typescript-eslint'\nexport default [...tseslint.configs.recommendedTypeChecked.map(config => ({ ...config, files: ['**/*.ts'] })), { files: ['**/*.ts'], languageOptions: { parserOptions: { project: ['./tsconfig.json'], tsconfigRootDir: ${JSON.stringify(workspacePath)} } }, rules: { '@typescript-eslint/no-unused-vars': 'error' } }]\n`
  return files
}
