// This transport is specific to the demo's fixed project. TypeScript overlays
// current editor text in its document store before diagnostics and completions.
interface DemoFileClient {
  invokeSync(method: string, ...params: readonly unknown[]): unknown
}

const workspace = 'memfs:///threejs'

const toPath = (uri: unknown): string | undefined => {
  if (typeof uri !== 'string') return undefined
  if (uri.startsWith('memfs:') && uri !== workspace && !uri.startsWith(`${workspace}/`)) return undefined
  const path = uri.startsWith('memfs:') ? new URL(uri).pathname : uri
  if (path === '/threejs' || path === '/threejs/') return '/'
  return path.startsWith('/threejs/') ? path.slice('/threejs'.length).replace(/\/$/, '') : undefined
}

export const createDemoFileClient = async (files: Readonly<Record<string, string>>): Promise<DemoFileClient> => {
  const hashes = new Map<string, string>()
  const directories = new Map<string, Set<string>>()
  for (const [path, content] of Object.entries(files)) {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content))
    hashes.set(path, Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join(''))
    const segments = path.split('/')
    for (let index = 1; index < segments.length; index++) {
      const parent = segments.slice(0, index).join('/') || '/'
      const entries = directories.get(parent) || new Set<string>()
      entries.add(segments[index])
      directories.set(parent, entries)
    }
  }
  return {
    invokeSync(method: string, ...params: readonly unknown[]): unknown {
      if (method === 'SyncApi.getWorkspaceUri') return workspace
      if (method === 'FileCache.getHashes') {
        if (!Array.isArray(params[0])) throw new Error('Expected file URI list')
        return params[0].map((uri: unknown) => hashes.get(toPath(uri) || '') || null)
      }
      const path = toPath(params[0])
      if (method === 'SyncApi.exists') return path !== undefined && (Object.hasOwn(files, path) || directories.has(path))
      if (method === 'SyncApi.readFileSync') return path === undefined ? undefined : files[path]
      if (method === 'SyncApi.readDirSync') return [...(directories.get(path || '') || [])].toSorted((a, b) => a.localeCompare(b))
      if (method === 'SyncApi.getDirectoriesSync') {
        return [...(directories.get(path || '') || [])]
          .toSorted((a, b) => a.localeCompare(b))
          .filter((name) => directories.has(`${path === '/' ? '' : path}/${name}`))
      }
      throw new Error(`Unsupported demo file operation: ${method}`)
    },
  }
}

export const createDemoSyncRpcClient = async (): Promise<DemoFileClient> => {
  const response = await fetch(new URL('workspace.json', import.meta.url))
  if (!response.ok) throw new Error(`Unable to load the demo language files: ${response.status}`)
  const files = (await response.json()) as Record<string, string>
  // Preview output is unrelated to the language host and can be large.
  return createDemoFileClient(Object.fromEntries(Object.entries(files).filter(([path]) => !path.startsWith('/dist/'))))
}
