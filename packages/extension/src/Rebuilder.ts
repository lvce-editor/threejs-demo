export interface BuildDependencies {
  readonly build: () => Promise<string>
  readonly publish: (code: string) => Promise<void>
  readonly reportError: (error: unknown) => Promise<void>
}

export const createRebuilder = ({ build, publish, reportError }: BuildDependencies): (() => Promise<void>) => {
  let requested = 0
  let tail: Promise<void> = Promise.resolve()
  return (): Promise<void> => {
    const revision = ++requested
    const run = async (): Promise<void> => {
      if (revision !== requested) return
      try {
        const code = await build()
        if (revision === requested) await publish(code)
      } catch (error) {
        if (revision === requested) await reportError(error)
      }
    }
    const previous = tail
    tail = (async (): Promise<void> => {
      try {
        await previous
      } catch {
        /* A failed error notification must not prevent later builds. */
      }
      await run()
    })()
    return tail
  }
}
