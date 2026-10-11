import {
  activate as activateExtensionApi,
  executeCommand,
  exists,
  readFile,
  registerCommand,
  registerFileChangeHandler,
  writeFile,
} from '@lvce-editor/api'
import { createCompiler } from './Compiler.ts'
import { createRebuilder } from './Rebuilder.ts'

const workspace = 'memfs:///threejs'
const state: {
  compiler?: ReturnType<typeof createCompiler>
  initialized: boolean
  previewOpened?: boolean
  rebuild?: () => Promise<void>
  changeSubscription?: { dispose: () => void }
  dependencyFiles?: [string, string][]
  workspaceReady?: Promise<void>
} = {
  initialized: false,
}

const writeWorkspaceFiles = async (entries: [string, string][]): Promise<void> => {
  for (let offset = 0; offset < entries.length; offset += 128) {
    await Promise.all(entries.slice(offset, offset + 128).map(([path, content]) => writeFile(`${workspace}${path}`, content)))
  }
}

const getWorkspaceFiles = async (): Promise<[string, string][]> => {
  const response = await fetch(new URL('workspace.json', import.meta.url))
  if (!response.ok) throw new Error(`Unable to load the demo workspace: ${response.status}`)
  return Object.entries((await response.json()) as Record<string, string>)
}

const installWorkspaceDependencies = async (): Promise<void> => {
  // Setting the workspace can restart the extension host after the seed command.
  const entries = state.dependencyFiles || (await getWorkspaceFiles())
  await writeWorkspaceFiles(entries.filter(([path]) => path.startsWith('/node_modules/')))
  delete state.dependencyFiles
}

const completeWorkspace = async (): Promise<void> => {
  state.workspaceReady ||= installWorkspaceDependencies()
  await state.workspaceReady
}

const initializeWorkspace = async (): Promise<void> => {
  if (await exists(`${workspace}/src/main.ts`)) {
    return
  }

  const entries = await getWorkspaceFiles()
  state.dependencyFiles = entries.filter(([path]) => path.startsWith('/node_modules/'))
  await writeWorkspaceFiles(entries.filter(([path]) => !path.startsWith('/node_modules/')))
}

const openDemo = async (): Promise<void> => {
  await initializeWorkspace()
  if (!state.initialized) {
    const compiler = createCompiler()
    state.compiler = compiler
    state.rebuild = createRebuilder({
      build: () => compiler.compile((path) => readFile(`${workspace}${path}`)),
      publish: async (code) => {
        await writeFile(`${workspace}/dist/main.js`, code)
        if (state.previewOpened) await executeCommand('SimpleBrowser.reload')
        else {
          await executeCommand('Layout.showPreview', `${workspace}/index.html`)
          state.previewOpened = true
          await completeWorkspace()
          await executeCommand('ExtensionManagement.activateByEvent', 'onDiagnostic:typescript')
          await executeCommand('Preferences.update', { 'editor.diagnostics': true })
          await executeCommand('GetActiveEditor.updateDiagnostics')
        }
      },
      reportError: async (error) => {
        await executeCommand('Notification.create', 'error', `Build failed: ${String(error)}`)
      },
    })
    state.initialized = true
  }
  if (!state.changeSubscription) {
    state.changeSubscription = registerFileChangeHandler(({ changed = [], deleted = [], renamed = [] }) => {
      if ([...changed, ...deleted, ...renamed.flat()].some((uri) => uri.startsWith(`${workspace}/src/`)))
        void state.rebuild?.().catch((error) => console.error(error))
    })
  }
  await executeCommand('Main.closeAllEditors')
  await executeCommand('Preferences.update', { 'editor.diagnostics': false })
  await executeCommand('Layout.showMain')
  await executeCommand('Main.openUri', `${workspace}/src/main.ts`)
  await completeWorkspace()
  await state.rebuild?.()
  await executeCommand('Main.openUri', `${workspace}/src/main.ts`)
  await executeCommand('Layout.hidePanel')
  await executeCommand('Layout.hideSideBar')
  await executeCommand('Layout.hideActivityBar')
  await executeCommand('Layout.hideStatusBar')
  await executeCommand('Layout.hideTitleBar')
}

export const activate = async (): Promise<void> => {
  await activateExtensionApi()
  registerCommand({ execute: initializeWorkspace, id: 'threejs.initializeWorkspace' })
  registerCommand({ execute: openDemo, id: 'threejs.openDemo' })
}

export const deactivate = async (): Promise<void> => {
  state.changeSubscription?.dispose()
  await state.compiler?.dispose()
}
