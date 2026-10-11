import assert from 'node:assert/strict'
import test from 'node:test'
import { createBuildCache } from '../src/BuildCache.ts'

void test('reverting a source reuses its build only while imported inputs also match', async () => {
  const files = new Map([
    ['/src/main.ts', 'red'],
    ['/src/color.ts', 'first'],
  ])
  const read = async (path: string): Promise<string> => {
    const content = files.get(path)
    if (content === undefined) throw new Error(`Missing ${path}`)
    return content
  }
  let builds = 0
  const compile = createBuildCache(async (readSource) => {
    builds++
    return `${await readSource('/src/main.ts')}:${await readSource('/src/color.ts')}`
  })
  assert.equal(await compile(read), 'red:first')
  files.set('/src/main.ts', 'green')
  assert.equal(await compile(read), 'green:first')
  files.set('/src/main.ts', 'red')
  assert.equal(await compile(read), 'red:first')
  assert.equal(builds, 2)
  files.set('/src/color.ts', 'second')
  assert.equal(await compile(read), 'red:second')
  assert.equal(builds, 3)
  files.delete('/src/color.ts')
  await assert.rejects(compile(read), /Missing/)
})

void test('failed builds are retried and older snapshots are evicted', async () => {
  let source = 'invalid'
  let builds = 0
  const compile = createBuildCache(async (readSource) => {
    builds++
    const input = await readSource('/src/main.ts')
    if (input === 'invalid') throw new Error('Syntax error')
    return input
  })
  const read = async (): Promise<string> => source
  await assert.rejects(compile(read), /Syntax error/)
  await assert.rejects(compile(read), /Syntax error/)
  for (source of ['first', 'second', 'third', 'first']) assert.equal(await compile(read), source)
  assert.equal(builds, 6)
})

void test('large source snapshots are not retained beyond the cache budget', async () => {
  let builds = 0
  const compile = createBuildCache(async (readSource) => {
    builds++
    await readSource('/src/main.ts')
    return 'compiled'
  })
  const source = 'x'.repeat(300_000)
  const read = async (): Promise<string> => source
  assert.equal(await compile(read), 'compiled')
  assert.equal(await compile(read), 'compiled')
  assert.equal(builds, 2)
})
