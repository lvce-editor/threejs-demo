import type { ReadSource } from './Compiler.ts'

// Only the fixed first scene can reuse the shipped output. All later builds,
// including edits made during startup, use the live compiler.
export const createInitialBuild = (compile: (readSource: ReadSource) => Promise<string>, readSource: ReadSource): (() => Promise<string>) => {
  let initial = true
  return async (): Promise<string> => {
    if (initial) {
      initial = false
      const [source, initialSource, code] = await Promise.all([
        readSource('/src/main.ts'),
        readSource('/dist/main.source.ts'),
        readSource('/dist/main.js'),
      ])
      if (source === initialSource) return code
    }
    return compile(readSource)
  }
}
