import assert from 'node:assert/strict'
import test from 'node:test'
import { createRebuilder } from '../src/Rebuilder.ts'

void test('a save during compilation supersedes the old output and coalesces queued saves', async () => {
  const first = Promise.withResolvers<string>()
  const started = Promise.withResolvers<void>()
  let builds = 0
  const published: string[] = []
  const rebuild = createRebuilder({
    build: async () => {
      builds++
      if (builds === 1) {
        started.resolve()
        return first.promise
      }
      return 'latest'
    },
    publish: async (code) => {
      published.push(code)
    },
    reportError: async () => {
      assert.fail('Unexpected compilation error')
    },
  })
  const initial = rebuild()
  await started.promise
  const second = rebuild()
  const third = rebuild()
  first.resolve('stale')
  await Promise.all([initial, second, third])
  assert.deepEqual(published, ['latest'])
  assert.equal(builds, 2)
})

void test('a failed build leaves output intact and a later corrected save publishes', async () => {
  let invalid = true
  const published: string[] = []
  const errors: unknown[] = []
  const rebuild = createRebuilder({
    build: async () => {
      if (invalid) throw new Error('Invalid TypeScript')
      return 'corrected'
    },
    publish: async (code) => {
      published.push(code)
    },
    reportError: async (error) => {
      errors.push(error)
    },
  })
  await rebuild()
  assert.deepEqual(published, [])
  assert.equal(errors.length, 1)
  invalid = false
  await rebuild()
  assert.deepEqual(published, ['corrected'])
})
