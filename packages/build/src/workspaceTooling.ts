import { build } from 'esbuild'
import { readdir, readFile } from 'node:fs/promises'
import { builtinModules, createRequire } from 'node:module'
import { join } from 'node:path'
import { root } from './root.ts'

const require = createRequire(import.meta.url)

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
  await addTypes('three')
  await addTypes('@types/three')
  for (const [name, entry] of [
    ['eslint', 'eslint/universal'],
    ['typescript-eslint', 'typescript-eslint'],
  ]) {
    const result = await build({
      entryPoints: [require.resolve(entry)],
      bundle: true,
      platform: 'browser',
      format: 'cjs',
      external: ['node:*', ...builtinModules, 'jiti', 'jiti/package.json'],
      write: false,
    })
    files[`/node_modules/${name}/index.cjs`] = result.outputFiles[0].text
    files[`/node_modules/${name}/package.json`] = JSON.stringify({ name, main: 'index.cjs' })
  }
  files['/eslint.config.js'] =
    "import tseslint from 'typescript-eslint'\nexport default [...tseslint.configs.recommended, { files: ['**/*.ts'], rules: { '@typescript-eslint/no-unused-vars': 'error' } }]\n"
  return files
}
