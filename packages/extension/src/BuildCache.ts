import type { ReadSource } from './Compiler.ts'

interface Entry {
  readonly inputs: Map<string, string>
  readonly output: Uint8Array<ArrayBuffer>
  readonly size: number
}

// Reverting an edit should reuse a validated build without retaining large bundles.
export const createBuildCache = (build: (readSource: ReadSource) => Promise<string>): ((readSource: ReadSource) => Promise<string>) => {
  const entries: Entry[] = []
  const maxBytes = 512 * 1024
  return async (readSource): Promise<string> => {
    for (const entry of entries) {
      const matches = await Promise.all(Array.from(entry.inputs, async ([path, content]) => (await readSource(path)) === content))
      if (matches.every(Boolean)) {
        const restored = new Blob([entry.output]).stream().pipeThrough(new DecompressionStream('gzip'))
        return new Response(restored).text()
      }
    }
    const inputs = new Map<string, string>()
    const output = await build(async (path) => {
      const content = await readSource(path)
      inputs.set(path, content)
      return content
    })
    const compressed = new Blob([output]).stream().pipeThrough(new CompressionStream('gzip'))
    const bytes = new Uint8Array(await new Response(compressed).arrayBuffer())
    const size = bytes.byteLength + [...inputs].reduce((sum, [path, content]) => sum + 2 * (path.length + content.length), 0)
    if (size <= maxBytes) {
      entries.unshift({ inputs, output: bytes, size })
      while (entries.length > 2 || entries.reduce((sum, entry) => sum + entry.size, 0) > maxBytes) entries.pop()
    }
    return output
  }
}
