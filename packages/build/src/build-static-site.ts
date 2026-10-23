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
const vscodeIcons = `${config.assetDir}/extensions/builtin.vscode-icons/icons`
config.staticFileIcons = {
  'main.ts': `${vscodeIcons}/file_type_typescript.svg`,
  'folder:dist': `${vscodeIcons}/folder_type_dist.svg`,
  'folder:node_modules': `${vscodeIcons}/folder_type_node.svg`,
  'folder:src': `${vscodeIcons}/folder_type_src.svg`,
  defaultFileIcon: `${vscodeIcons}/default_file.svg`,
  defaultFolderIcon: `${vscodeIcons}/default_folder.svg`,
}
if (Array.isArray(config.preloadWorkers)) {
  config.preloadWorkers = config.preloadWorkers.filter(
    (worker: string) => !['activityBarWorker', 'statusBarWorker', 'iconThemeWorker'].includes(worker),
  )
}
config.previewOutputEnabled = false
config.syntaxHighlightingWorkerUrl ||=
  config.workerUrls['develop.syntaxHighlightingWorkerPath'] || config.workerUrls['developer.syntaxHighlightingWorkerPath']
if (!config.syntaxHighlightingWorkerUrl) throw new Error('Exported syntax highlighting worker URL not found')
const configuredIndex = index.replace(configMatch[0], `${configMatch[1]}${JSON.stringify(config)}${configMatch[3]}`)
await writeFile(indexPath, configuredIndex.replace('</head>', '<script src="/threejs-demo/demo-startup.js"></script>\n</head>'))

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
  'editor.fontFamily': "'Fira Code'",
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

for (const name of ['renderer-process', 'preview-sandbox-worker', 'preview-worker', 'extension-management-worker']) {
  await cp(new URL('./', import.meta.resolve(`@lvce-editor/${name}`)), join(root, 'dist', commitHash, 'packages', name, 'dist'), {
    force: true,
    recursive: true,
  })
}

const extensionId = 'builtin.threejs-demo'
await installExtension('eslint', '1.25.3', commitHash)
const eslintExtensionPath = join(root, 'dist', commitHash, 'extensions', 'builtin.eslint', 'dist', 'eslintMain.js')
const eslintExtension = await readFile(eslintExtensionPath, 'utf8')
// The verified initial scene returns before this hook; edited text needs all tooling.
const lintEditedText = "    const {\n      text\n    } = textDocument;\n    const filePath = textDocument.uri ?? 'file.js';"
if (!eslintExtension.includes(lintEditedText) || !eslintExtension.includes('const executeCommand$1 = async'))
  throw new Error('ESLint edited document hook not found')
await writeFile(
  eslintExtensionPath,
  eslintExtension.replace(lintEditedText, `    await executeCommand$1('threejs.prepareLanguageFeatures');\n${lintEditedText}`),
)
await installExtension('language-features-typescript', '5.33.0', commitHash)
// Early completion requests must not snapshot a partially installed virtual project.
const languageExtensionPath = join(
  root,
  'dist',
  commitHash,
  'extensions',
  'builtin.language-features-typescript',
  'dist',
  'languageFeaturesTypeScriptMain.js',
)
const languageExtension = await readFile(languageExtensionPath, 'utf8')
const launchWorker = 'const launchTypeScriptWorker = async () => {'
if (!languageExtension.includes(launchWorker) || !languageExtension.includes('const executeCommand$1 = async'))
  throw new Error('TypeScript worker startup hook not found')
await writeFile(
  languageExtensionPath,
  languageExtension.replace(launchWorker, `${launchWorker}\n  await executeCommand$1('threejs.prepareLanguageFeatures');`),
)
// The demo's fixed project files are already shipped as JSON. Serve TypeScript's
// synchronous host reads from that snapshot; edited text stays in its live
// document store. This avoids cross-worker OPFS locks and isolation on Firefox.
const typescriptWorkerPath = join(root, 'dist', commitHash, 'extensions', 'builtin.language-features-typescript', 'typescriptWorkerMain.js')
const typescriptWorker = await readFile(typescriptWorkerPath, 'utf8')
const transportStart = typescriptWorker.indexOf('const createSyncRpcClient = async ({')
const transportEnd = typescriptWorker.indexOf('const getTypeScriptPath = ', transportStart)
if (transportStart === -1 || transportEnd === -1) throw new Error('TypeScript synchronous transport hook not found')
await writeFile(
  typescriptWorkerPath,
  `import { createDemoSyncRpcClient } from '../builtin.threejs-demo/dist/demoSyncRpcClient.js'\n${typescriptWorker.slice(0, transportStart)}const createSyncRpcClient = createDemoSyncRpcClient;\n${typescriptWorker.slice(transportEnd)}`,
)
const compilerPath = join(root, 'dist', commitHash, 'extensions', 'builtin.language-features-typescript', 'typescript', 'lib', 'typescript-esm.js')
await writeFile(compilerPath, removeUnreachableTypeScriptCode(await readFile(compilerPath, 'utf8')))
await cp(join(root, 'packages', 'extension', 'dist'), join(root, 'dist', commitHash, 'extensions', extensionId, 'dist'), {
  force: true,
  recursive: true,
})

const staticDirectory = join(root, '.tmp', 'static')
await rm(staticDirectory, { force: true, recursive: true })
await cp(join(root, 'dist'), staticDirectory, { recursive: true })
