import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { createDemoFileClient } from '../src/demoSyncRpcClient.ts'
import { workspacePath, workspaceUri } from '../src/demoWorkspace.ts'

void test('fixed project reads support URI and normalized paths, directories, and cache identities', async () => {
  const source = 'export const value = 1'
  const client = await createDemoFileClient({
    '/node_modules/pkg/index.d.ts': 'export const value: number',
    '/src/main.ts': source,
    '/tsconfig.json': '{}',
  })
  assert.equal(client.invokeSync('SyncApi.readFileSync', `${workspaceUri}/src/main.ts`), source)
  assert.equal(client.invokeSync('SyncApi.readFileSync', new URL(`${workspaceUri}/src/main.ts`).href), source)
  assert.equal(client.invokeSync('SyncApi.readFileSync', `${workspacePath}/src/main.ts`), source)
  assert.equal(client.invokeSync('SyncApi.exists', `${workspaceUri}/node_modules/pkg`), true)
  assert.deepEqual(client.invokeSync('SyncApi.readDirSync', `${workspaceUri}/`), ['node_modules', 'src', 'tsconfig.json'])
  assert.deepEqual(client.invokeSync('SyncApi.getDirectoriesSync', `${workspacePath}/`), ['node_modules', 'src'])
  assert.deepEqual(client.invokeSync('FileCache.getHashes', [`${workspaceUri}/src/main.ts`, `${workspaceUri}/missing.ts`]), [
    createHash('sha256').update(source).digest('hex'),
    null,
  ])
})

void test('missing files and other workspaces cannot alias the fixed project', async () => {
  const client = await createDemoFileClient({ '/src/main.ts': 'original' })
  for (const uri of [
    'memfs:///elsewhere/src/main.ts',
    `file://${workspacePath}/src/main.ts`,
    `memfs://elsewhere${workspacePath}/src/main.ts`,
    `${workspaceUri}/src/missing.ts`,
  ]) {
    assert.equal(client.invokeSync('SyncApi.exists', uri), false)
    assert.equal(client.invokeSync('SyncApi.readFileSync', uri), undefined)
  }
  assert.throws(() => client.invokeSync('SyncApi.writeFile', `${workspaceUri}/src/main.ts`, 'edited'), /Unsupported demo file operation/)
  assert.equal(client.invokeSync('SyncApi.readFileSync', `${workspaceUri}/src/main.ts`), 'original')
})
