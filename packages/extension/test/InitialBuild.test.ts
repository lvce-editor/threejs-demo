import assert from 'node:assert/strict'
import test from 'node:test'
import { createInitialBuild } from '../src/InitialBuild.ts'

void test('the shipped first scene does not wait for compilation, and later edits compile live source', async () => {
  let source = 'original'
  let builds = 0
  const build = createInitialBuild(
    async (readSource) => {
      builds++
      return `compiled ${await readSource('/src/main.ts')}`
    },
    async (path) => {
      if (path === '/src/main.ts') return source
      if (path === '/dist/main.source.ts') return 'original'
      return 'shipped'
    },
  )
  assert.equal(await build(), 'shipped')
  assert.equal(builds, 0)
  source = 'edited'
  assert.equal(await build(), 'compiled edited')
  assert.equal(builds, 1)
})

void test('a source changed before the first build cannot reuse the shipped scene', async () => {
  const build = createInitialBuild(
    async (readSource) => `compiled ${await readSource('/src/main.ts')}`,
    async (path) => {
      if (path === '/src/main.ts') return 'edited during startup'
      if (path === '/dist/main.source.ts') return 'original'
      return 'shipped'
    },
  )
  assert.equal(await build(), 'compiled edited during startup')
})
