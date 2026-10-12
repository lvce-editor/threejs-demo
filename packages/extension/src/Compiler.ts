import type { ReadSource } from './CompilerRuntime.ts'
import type { CompilerWorkerRequest, CompilerWorkerResponse } from './CompilerWorkerProtocol.ts'
export type { ReadSource } from './CompilerRuntime.ts'

interface PendingRequest {
  readonly readSource: ReadSource
  readonly reject: (error: Error) => void
  readonly resolve: (code: string) => void
}

const createWorker = (): Worker => new Worker(new URL('compilerWorker.js', import.meta.url), { type: 'module' })

export const createCompiler = (
  workerFactory: () => Worker = createWorker,
): ((readSource: ReadSource) => Promise<string>) & { dispose: () => Promise<void> } => {
  let worker: Worker | undefined
  let disposed = false
  let nextRequestId = 0
  const pending = new Map<number, PendingRequest>()
  const failWorker = (error: Error): void => {
    worker?.terminate()
    worker = undefined
    for (const request of pending.values()) request.reject(error)
    pending.clear()
  }
  const ensureWorker = (): Worker => {
    if (worker) return worker
    const activeWorker = workerFactory()
    worker = activeWorker
    activeWorker.onmessage = ({ data }: MessageEvent<CompilerWorkerResponse>): void => {
      if (data.type === 'read-source') {
        const request = pending.get(data.compileId)
        if (!request) return
        void request.readSource(data.path).then(
          (source) => activeWorker.postMessage({ requestId: data.requestId, source, type: 'read-source-result' }),
          (error: unknown) => activeWorker.postMessage({ error: String(error), requestId: data.requestId, type: 'read-source-result' }),
        )
        return
      }
      const request = pending.get(data.requestId)
      if (!request) return
      pending.delete(data.requestId)
      if (data.type === 'compiled') request.resolve(data.code)
      else request.reject(new Error(data.error))
    }
    activeWorker.onerror = (event): void => failWorker(new Error(event.message || 'Compiler worker failed'))
    activeWorker.onmessageerror = (): void => failWorker(new Error('Unable to read compiler worker response'))
    return activeWorker
  }
  const compile = (readSource: ReadSource): Promise<string> => {
    if (disposed) return Promise.reject(new Error('Scene compiler is disposed'))
    const requestId = ++nextRequestId
    let activeWorker: Worker
    try {
      activeWorker = ensureWorker()
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)))
    }
    return new Promise<string>((resolve, reject) => {
      pending.set(requestId, { readSource, reject, resolve })
      const message: CompilerWorkerRequest = { requestId, type: 'compile' }
      try {
        activeWorker.postMessage(message)
      } catch (error) {
        pending.delete(requestId)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }
  return Object.assign(compile, {
    dispose: async (): Promise<void> => {
      disposed = true
      failWorker(new Error('Scene compiler is disposed'))
    },
  })
}
