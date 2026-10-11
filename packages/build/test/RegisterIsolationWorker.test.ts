import assert from 'node:assert/strict'
import test from 'node:test'
import { registerIsolationWorker } from '../src/registerIsolationWorker.ts'

const createServiceWorker = (registration: () => Promise<void> = async () => {}) => {
  const listeners = new Set<() => void>()
  const serviceWorker = {
    addEventListener: (_type: string, listener: () => void): void => {
      listeners.add(listener)
    },
    controller: null as object | null,
    get ready(): never {
      throw new Error('Controller readiness must not depend on the separate ready promise')
    },
    register: registration,
    removeEventListener: (_type: string, listener: () => void): void => {
      listeners.delete(listener)
    },
  }
  const claim = (): void => {
    serviceWorker.controller = {}
    for (const listener of listeners) listener()
  }
  return { claim, listeners, serviceWorker }
}

void test('an existing controller does not wait for serviceWorker.ready', async () => {
  const { claim, listeners, serviceWorker } = createServiceWorker()
  claim()
  await registerIsolationWorker(serviceWorker, '/isolation.js', '/demo/')
  assert.equal(listeners.size, 0)
})

void test('control claimed before registration resolves is observed', async () => {
  const worker = createServiceWorker(async () => {
    worker.claim()
  })
  await registerIsolationWorker(worker.serviceWorker, '/isolation.js', '/demo/')
  assert.equal(worker.listeners.size, 0)
})

void test('registration alone does not imply control of the current document', async () => {
  const { claim, listeners, serviceWorker } = createServiceWorker()
  const controlled = registerIsolationWorker(serviceWorker, '/isolation.js', '/demo/')
  await Promise.resolve()
  assert.equal(listeners.size, 1)
  claim()
  await controlled
  assert.equal(listeners.size, 0)
})

void test('failed registration removes its control listener', async () => {
  const { listeners, serviceWorker } = createServiceWorker(async () => {
    throw new Error('registration failed')
  })
  await assert.rejects(registerIsolationWorker(serviceWorker, '/isolation.js', '/demo/'), /registration failed/)
  assert.equal(listeners.size, 0)
})

void test('control is sufficient even while the registration promise is pending', { timeout: 1000 }, async () => {
  const worker = createServiceWorker(async () => {
    worker.claim()
    await new Promise<never>(() => {})
  })
  await registerIsolationWorker(worker.serviceWorker, '/isolation.js', '/demo/')
  assert.equal(worker.listeners.size, 0)
})
