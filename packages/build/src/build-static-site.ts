import { cp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { root } from './root.ts'
import { installExtension } from './installExtension.ts'

const sharedProcessPath = join(root, 'node_modules', '@lvce-editor', 'shared-process', 'index.js')
const sharedProcessUrl = pathToFileURL(sharedProcessPath).toString()
const sharedProcess = await import(sharedProcessUrl)

process.env.PATH_PREFIX = '/threejs-demo'
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
config.syntaxHighlightingWorkerUrl ||=
  config.workerUrls['develop.syntaxHighlightingWorkerPath'] || config.workerUrls['developer.syntaxHighlightingWorkerPath']
if (!config.syntaxHighlightingWorkerUrl) throw new Error('Exported syntax highlighting worker URL not found')
await writeFile(indexPath, index.replace(configMatch[0], `${configMatch[1]}${JSON.stringify(config)}${configMatch[3]}`))

const defaultSettingsPath = join(root, 'dist', commitHash, 'config', 'defaultSettings.json')
const defaultSettings = JSON.parse(await readFile(defaultSettingsPath, 'utf8'))
defaultSettings['application.useOnLoadJson'] = true
await writeFile(defaultSettingsPath, `${JSON.stringify(defaultSettings, null, 2)}\n`)

for (const name of ['renderer-process', 'preview-sandbox-worker', 'preview-worker']) {
  await cp(new URL('./', import.meta.resolve(`@lvce-editor/${name}`)), join(root, 'dist', commitHash, 'packages', name, 'dist'), {
    force: true,
    recursive: true,
  })
}

const extensionId = 'builtin.threejs-demo'
await installExtension('eslint', '1.25.2', commitHash)
await installExtension('language-features-typescript', '5.31.0', commitHash)
await cp(join(root, 'packages', 'extension', 'dist'), join(root, 'dist', commitHash, 'extensions', extensionId, 'dist'), {
  force: true,
  recursive: true,
})

const staticDirectory = join(root, '.tmp', 'static')
await rm(staticDirectory, { force: true, recursive: true })
await cp(join(root, 'dist'), staticDirectory, { recursive: true })
