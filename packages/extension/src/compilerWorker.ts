import type { CompilerWorkerRequest, CompilerWorkerResponse } from './CompilerWorkerProtocol.ts'
import { createCompilerRuntime } from './CompilerRuntime.ts'

const compiler = createCompilerRuntime()
const pendingReads = new Map<number, { readonly reject: (error: Error) => void; readonly resolve: (source: string) => void }>()
const state = { nextReadId: 0, tail: Promise.resolve() }

const readSource = (compileId: number, path: string): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    const requestId = ++state.nextReadId
    pendingReads.set(requestId, { reject, resolve })
    const message: CompilerWorkerResponse = { compileId, path, requestId, type: 'read-source' }
    globalThis.postMessage(message)
  })

globalThis.addEventListener('message', ({ data }: MessageEvent<CompilerWorkerRequest>): void => {
  if (data.type === 'read-source-result') {
    const pending = pendingReads.get(data.requestId)
    if (!pending) return
    pendingReads.delete(data.requestId)
    if (data.error) pending.reject(new Error(data.error))
    else pending.resolve(data.source || '')
    return
  }
  const run = async (): Promise<void> => {
    try {
      const code = await compiler((path) => readSource(data.requestId, path))
      const message: CompilerWorkerResponse = { code, requestId: data.requestId, type: 'compiled' }
      globalThis.postMessage(message)
    } catch (error) {
      const message: CompilerWorkerResponse = { error: String(error), requestId: data.requestId, type: 'compile-error' }
      globalThis.postMessage(message)
    }
  }
  const previous = state.tail
  state.tail = (async (): Promise<void> => {
    await previous
    await run()
  })()
})

globalThis.addEventListener('close', () => {
  void compiler.dispose()
  for (const pending of pendingReads.values()) pending.reject(new Error('Compiler worker closed'))
  pendingReads.clear()
})
