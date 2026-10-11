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
import { createInitialBuild } from './InitialBuild.ts'
import { createRebuilder } from './Rebuilder.ts'

const workspace = 'memfs:///threejs'
const state: {
  initialized: boolean
  previewOpened?: boolean
  rebuild?: () => Promise<void>
  disposeCompiler?: () => Promise<void>
  warmCompiler?: () => Promise<string>
  changeSubscription?: { dispose: () => void }
  workspaceReady?: Promise<void>
} = {
  initialized: false,
}

const writeWorkspaceFiles = async (entries: [string, string][]): Promise<void> => {
  for (let offset = 0; offset < entries.length; offset += 128) {
    await Promise.all(entries.slice(offset, offset + 128).map(([path, content]) => writeFile(`${workspace}${path}`, content)))
  }
}

const getWorkspaceFiles = async (name: string = 'workspace.json'): Promise<[string, string][]> => {
  const response = await fetch(new URL(name, import.meta.url))
  if (!response.ok) throw new Error(`Unable to load the demo workspace: ${response.status}`)
  return Object.entries((await response.json()) as Record<string, string>)
}

const installWorkspaceDependencies = async (): Promise<void> => {
  const entries = await getWorkspaceFiles()
  await writeWorkspaceFiles(entries.filter(([path]) => path.startsWith('/node_modules/')))
}

const completeWorkspace = async (): Promise<void> => {
  state.workspaceReady ||= installWorkspaceDependencies()
  await state.workspaceReady
}

const prepareLanguageFeatures = async (): Promise<void> => {
  await completeWorkspace()
  if (!state.initialized) return
  await executeCommand('ExtensionManagement.activateByEvent', 'onDiagnostic:typescript')
  await executeCommand('GetActiveEditor.updateDiagnostics')
  void state.warmCompiler?.().catch(() => {})
}

const initializeWorkspace = async (): Promise<void> => {
  if (await exists(`${workspace}/src/main.ts`)) {
    return
  }

  // Avoid downloading the compiler and declarations before showing the editor.
  await writeWorkspaceFiles(await getWorkspaceFiles('workspace-preview.json'))
}

const openDemo = async (): Promise<void> => {
  await initializeWorkspace()
  if (!state.initialized) {
    const compile = createCompiler()
    state.disposeCompiler = compile.dispose
    state.warmCompiler = (): Promise<string> => compile((path) => readFile(`${workspace}${path}`))
    state.rebuild = createRebuilder({
      build: createInitialBuild(compile, (path) => readFile(`${workspace}${path}`)),
      publish: async (code) => {
        await writeFile(`${workspace}/dist/main.js`, code)
        if (state.previewOpened) await executeCommand('SimpleBrowser.reload')
        else {
          await executeCommand('Layout.showPreview', `${workspace}/index.html`)
          state.previewOpened = true
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
  await executeCommand('Preferences.update', { 'editor.diagnostics': true })
  await executeCommand('Layout.showMain')
  await executeCommand('Main.openUri', `${workspace}/src/main.ts`)
  await state.rebuild?.()
  await executeCommand('Main.focus')
  await executeCommand('Layout.hidePanel')
  await executeCommand('Layout.hideSideBar')
  await executeCommand('Layout.hideActivityBar')
  await executeCommand('Layout.hideStatusBar')
  await executeCommand('Layout.hideTitleBar')
  // Prepare tooling after the initial layout is visible.
  void prepareLanguageFeatures().catch((error) => console.error(error))
}

export const activate = async (): Promise<void> => {
  await activateExtensionApi()
  registerCommand({ execute: initializeWorkspace, id: 'threejs.initializeWorkspace' })
  registerCommand({ execute: completeWorkspace, id: 'threejs.prepareLanguageFeatures' })
  registerCommand({ execute: openDemo, id: 'threejs.openDemo' })
}

export const deactivate = async (): Promise<void> => {
  state.initialized = false
  state.changeSubscription?.dispose()
  await state.disposeCompiler?.()
}
