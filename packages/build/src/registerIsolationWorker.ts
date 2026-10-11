export interface IsolationServiceWorker {
  readonly controller: unknown
  addEventListener: (type: 'controllerchange', listener: () => void) => void
  register: (url: string, options: { scope: string }) => Promise<unknown>
  removeEventListener: (type: 'controllerchange', listener: () => void) => void
}

export const registerIsolationWorker = async (serviceWorker: IsolationServiceWorker, url: string, scope: string): Promise<void> => {
  const { promise, reject, resolve } = Promise.withResolvers<void>()
  const onControllerChange = (): void => {
    if (serviceWorker.controller) resolve()
  }
  // Control can arrive while registration is pending. Observe it before registering,
  // and check the current controller without depending on the separate ready promise.
  serviceWorker.addEventListener('controllerchange', onControllerChange)
  try {
    void (async (): Promise<void> => {
      try {
        await serviceWorker.register(url, { scope })
        onControllerChange()
      } catch (error) {
        reject(error)
      }
    })()
    onControllerChange()
    await promise
  } finally {
    serviceWorker.removeEventListener('controllerchange', onControllerChange)
  }
}
