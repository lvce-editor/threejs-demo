import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.cwd()
const getPackageManifests = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true })
  const manifests: string[] = []
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      manifests.push(...(await getPackageManifests(path)))
    } else if (entry.name === 'package.json') {
      manifests.push(path)
    }
  }
  return manifests
}

const locations = [
  join(root, 'package.json'),
  join(root, 'package-lock.json'),
  join(root, '.nvmrc'),
  ...(await readdir(join(root, '.github/workflows')))
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .map((name) => join(root, '.github/workflows', name)),
  join(root, 'packages/build/src/computeNodeModulesCacheKey.ts'),
  ...(await getPackageManifests(join(root, 'packages'))),
].sort()

const hash = createHash('sha256')
for (const location of locations) {
  hash.update(location.slice(root.length))
  hash.update('\0')
  hash.update(await readFile(location))
  hash.update('\0')
}

process.stdout.write(hash.digest('hex'))
