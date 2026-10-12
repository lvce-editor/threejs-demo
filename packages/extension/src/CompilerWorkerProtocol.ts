export type CompilerWorkerRequest =
  | { readonly type: 'compile'; readonly requestId: number }
  | { readonly type: 'read-source-result'; readonly requestId: number; readonly source?: string; readonly error?: string }

export type CompilerWorkerResponse =
  | { readonly type: 'read-source'; readonly requestId: number; readonly compileId: number; readonly path: string }
  | { readonly type: 'compiled'; readonly requestId: number; readonly code: string }
  | { readonly type: 'compile-error'; readonly requestId: number; readonly error: string }
