import * as esbuild from 'esbuild'
import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { compileScene } from '../src/Compiler.ts'

void test('the scene compiler keeps used Three.js exports and removes unused ones', async () => {
  const threeBuild = await esbuild.build({
    bundle: true,
    entryPoints: [fileURLToPath(new URL('../../../node_modules/three/build/three.module.js', import.meta.url))],
    format: 'esm',
    platform: 'browser',
    write: false,
  })
  const three = threeBuild.outputFiles?.[0]?.text
  assert.ok(three)
  const source = "import { BoxGeometry, WebGLRenderer } from 'three'; console.log(BoxGeometry, WebGLRenderer)"
  const output = await compileScene(esbuild.build, three, async (path) => {
    if (path === '/src/main.ts') return source
    throw new Error(`Unexpected source path: ${path}`)
  })
  assert.match(output, /BoxGeometry/)
  assert.match(output, /WebGLRenderer/)
  assert.doesNotMatch(output, /TextureLoader/)
})

void test('incremental scene compilation reloads edited virtual source', async () => {
  let source = "import { value } from 'three'; console.log(value, 'initial')"
  let context: esbuild.BuildContext | undefined
  const build = async (options: esbuild.BuildOptions): Promise<esbuild.BuildResult> => {
    context ||= await esbuild.context(options)
    return context.rebuild()
  }
  const readSource = async (): Promise<string> => source
  try {
    const first = await compileScene(build, 'export const value = 42', readSource)
    assert.match(first, /initial/)
    source = "import { value } from 'three'; console.log(value, 'edited')"
    const second = await compileScene(build, 'export const value = 42', readSource)
    assert.match(second, /edited/)
    assert.doesNotMatch(second, /initial/)
  } finally {
    await context?.dispose()
  }
})
