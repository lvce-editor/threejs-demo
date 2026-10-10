import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { brotliDecompressSync } from 'node:zlib'
import { x as extractTar } from 'tar'
import { root } from './root.ts'

export const installExtension = async (name: string, version: string, commitHash: string): Promise<void> => {
  const response = await fetch(`https://github.com/lvce-editor/${name}/releases/download/v${version}/${name}-v${version}.tar.br`)
  if (!response.ok) throw new Error(`Failed to download ${name}: ${response.status}`)
  const temporaryDirectory = join(root, '.tmp')
  await mkdir(temporaryDirectory, { recursive: true })
  const archivePath = join(temporaryDirectory, `${name}-extension.tar`)
  await writeFile(archivePath, brotliDecompressSync(Buffer.from(await response.arrayBuffer())))
  const extensionDirectory = join(root, 'dist', commitHash, 'extensions', `builtin.${name}`)
  await mkdir(extensionDirectory, { recursive: true })
  await extractTar({ cwd: extensionDirectory, file: archivePath })
  const manifest = JSON.parse(await readFile(join(extensionDirectory, 'extension.json'), 'utf8'))
  for (const name of ['extensions.json', 'webExtensions.json']) {
    const path = join(root, 'dist', commitHash, 'config', name)
    const extensions = JSON.parse(await readFile(path, 'utf8')) as { id: string }[]
    await writeFile(
      path,
      `${JSON.stringify([
        ...extensions.filter(({ id }) => id !== manifest.id),
        { ...manifest, isWeb: true, path: `/threejs-demo/${commitHash}/extensions/${manifest.id}` },
      ])}\n`,
    )
  }
}
