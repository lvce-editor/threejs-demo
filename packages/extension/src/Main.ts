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
const state: { initialized: boolean; previewOpened?: boolean; rebuild?: () => Promise<void>; changeSubscription?: { dispose: () => void } } = {
  initialized: false,
}

const initializeWorkspace = async (): Promise<void> => {
  if (await exists(`${workspace}/src/main.ts`)) {
    return
  }

  const response = await fetch(new URL('workspace.json', import.meta.url))
  if (!response.ok) throw new Error(`Unable to load the demo workspace: ${response.status}`)
  const files = (await response.json()) as Record<string, string>
  const entries = Object.entries(files)
  for (let offset = 0; offset < entries.length; offset += 16) {
    await Promise.all(entries.slice(offset, offset + 16).map(([path, content]) => writeFile(`${workspace}${path}`, content)))
  }
}

const openDemo = async (): Promise<void> => {
  await initializeWorkspace()
  if (!state.initialized) {
    const compile = createCompiler()
    state.rebuild = createRebuilder({
      build: () => compile((path) => readFile(`${workspace}${path}`)),
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

export const deactivate = (): void => {
  state.changeSubscription?.dispose()
}
