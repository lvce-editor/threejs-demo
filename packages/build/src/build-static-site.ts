import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { removeUnreachableTypeScriptCode } from './removeUnreachableTypeScriptCode.ts'
import { root } from './root.ts'
import { installExtension } from './installExtension.ts'

const sharedProcessPath = join(root, 'node_modules', '@lvce-editor', 'shared-process', 'index.js')
const sharedProcessUrl = pathToFileURL(sharedProcessPath).toString()
const sharedProcess = await import(sharedProcessUrl)

process.env.PATH_PREFIX = '/threejs-demo'
// The exporter requires a test source directory, including in a fresh checkout.
await mkdir(join(root, 'packages', 'e2e', 'src'), { recursive: true })
const { commitHash } = await sharedProcess.exportStatic({
  extensionPath: 'packages/extension',
  onLoadCommands: [
    { args: [], command: 'threejs.initializeWorkspace', name: 'Load Demo Files' },
    { args: ['memfs:///threejs'], command: 'Workspace.setPath', name: 'Open Demo Workspace' },
    {
      args: [],
      command: 'threejs.openDemo',
      name: 'Setup Demo',
    },
  ],
  root,
  testPath: 'packages/e2e',
})

// Supply the renderer's explicit URL from the exported worker configuration.
// Older published runtimes used the developer prefix for this worker.
const indexPath = join(root, 'dist', 'index.html')
const index = await readFile(indexPath, 'utf8')
const configMatch = /(<script id="Config" type="application\/json">)(.*?)(<\/script>)/s.exec(index)
if (!configMatch) throw new Error('Exported runtime configuration not found')
const config = JSON.parse(configMatch[2])
config.initialLayout = {
  activityBarVisible: false,
  statusBarVisible: false,
  titleBarVisible: false,
  sideBarVisible: false,
  secondarySideBarVisible: false,
  panelVisible: false,
}
config.staticFileIcons = { 'main.ts': `${config.assetDir}/extensions/builtin.vscode-icons/icons/file_type_typescript.svg` }
config.previewOutputEnabled = false
config.syntaxHighlightingWorkerUrl ||=
  config.workerUrls['develop.syntaxHighlightingWorkerPath'] || config.workerUrls['developer.syntaxHighlightingWorkerPath']
if (!config.syntaxHighlightingWorkerUrl) throw new Error('Exported syntax highlighting worker URL not found')
const configuredIndex = index.replace(configMatch[0], `${configMatch[1]}${JSON.stringify(config)}${configMatch[3]}`)
await writeFile(indexPath, configuredIndex.replace('</head>', `<script src="/threejs-demo/demo-startup.js"></script>\n</head>`))

// This exported application always runs on the web, including eager module initialization.
const rendererPath = join(root, 'dist', commitHash, 'packages', 'renderer-worker', 'dist', 'rendererWorkerMain.js')
const renderer = await build({
  bundle: true,
  entryPoints: [rendererPath],
  define: { PLATFORM: '1' },
  external: ['electron', 'node:*'],
  format: 'esm',
  minify: true,
  platform: 'browser',
  write: false,
})
await writeFile(rendererPath, renderer.outputFiles[0].contents)

const defaultSettingsPath = join(root, 'dist', commitHash, 'config', 'defaultSettings.json')
const defaultSettings = JSON.parse(await readFile(defaultSettingsPath, 'utf8'))
defaultSettings['application.useOnLoadJson'] = true
const workspaceFiles = JSON.parse(await readFile(join(root, 'packages/extension/dist/workspace.json'), 'utf8'))
const textHash = (text: string): string => createHash('sha256').update(text).digest('hex')
// The scene type-check and generated fixed project dependencies validate this text.
// Changed text/configuration resumes checking before the TypeScript worker is started.
defaultSettings['typescript.verifiedDiagnostics'] = [
  {
    uri: 'memfs:///threejs/src/main.ts',
    hash: textHash(workspaceFiles['/src/main.ts']),
    configUri: 'memfs:///threejs/tsconfig.json',
    configHash: textHash(workspaceFiles['/tsconfig.json']),
  },
]
defaultSettings['eslint.ignoreHashes'] = [textHash(workspaceFiles['/src/main.ts'])]
await writeFile(defaultSettingsPath, `${JSON.stringify(defaultSettings, null, 2)}\n`)

// Local settings replace exported defaults in the web runtime. Seed the fixed
// demo settings before startup, including profiles with useOnLoadJson=false.
const demoSettings = {
  'application.useOnLoadJson': true,
  'typescript.verifiedDiagnostics': defaultSettings['typescript.verifiedDiagnostics'],
  'eslint.ignoreHashes': defaultSettings['eslint.ignoreHashes'],
}
const demoStartup = `try {
  const settings = JSON.parse(localStorage.getItem('settings') || '{}')
  Object.assign(settings, ${JSON.stringify(demoSettings)})
  localStorage.setItem('settings', JSON.stringify(settings))
} catch {
  // Storage may be unavailable; exported defaults still configure the demo.
}
`
await writeFile(join(root, 'dist', 'demo-startup.js'), demoStartup)

// Pages cannot configure response headers. Enable the shared-memory TypeScript
// transport before starting workers; Firefox cannot share the fallback OPFS locks.
await cp(new URL('./isolation-worker.js', import.meta.url), join(root, 'dist', 'isolation-worker.js'))
const bootstrap = `if (!globalThis.crossOriginIsolated) {
  await navigator.serviceWorker.register('/threejs-demo/isolation-worker.js', { scope: '/threejs-demo/', updateViaCache: 'none' })
  await navigator.serviceWorker.ready
  if (!navigator.serviceWorker.controller) {
    await new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }))
  }
  if (sessionStorage.getItem('threejs.isolationReload')) throw new Error('Cross-origin isolation is unavailable')
  sessionStorage.setItem('threejs.isolationReload', '1')
  location.reload()
  await new Promise(() => {})
}
sessionStorage.removeItem('threejs.isolationReload')
const config = JSON.parse(document.getElementById('Config').textContent)
await import(config.assetDir + '/packages/renderer-process/dist/rendererProcessMain.js')
`
await writeFile(join(root, 'dist', 'demo-bootstrap.js'), bootstrap)
const bootIndex = await readFile(indexPath, 'utf8')
const rendererScript = /<script\b[^>]*src="[^"]*rendererProcessMain\.js"[^>]*><\/script>/
if (!rendererScript.test(bootIndex)) throw new Error('Renderer bootstrap script is missing')
await writeFile(indexPath, bootIndex.replace(rendererScript, '<script type="module" src="/threejs-demo/demo-bootstrap.js"></script>'))

for (const name of ['renderer-process', 'preview-sandbox-worker', 'preview-worker']) {
  await cp(new URL('./', import.meta.resolve(`@lvce-editor/${name}`)), join(root, 'dist', commitHash, 'packages', name, 'dist'), {
    force: true,
    recursive: true,
  })
}

const extensionId = 'builtin.threejs-demo'
await installExtension('eslint', '1.25.3', commitHash)
await installExtension('language-features-typescript', '5.33.0', commitHash)
const compilerPath = join(root, 'dist', commitHash, 'extensions', 'builtin.language-features-typescript', 'typescript', 'lib', 'typescript-esm.js')
await writeFile(compilerPath, removeUnreachableTypeScriptCode(await readFile(compilerPath, 'utf8')))
await cp(join(root, 'packages', 'extension', 'dist'), join(root, 'dist', commitHash, 'extensions', extensionId, 'dist'), {
  force: true,
  recursive: true,
})

const staticDirectory = join(root, '.tmp', 'static')
await rm(staticDirectory, { force: true, recursive: true })
await cp(join(root, 'dist'), staticDirectory, { recursive: true })
