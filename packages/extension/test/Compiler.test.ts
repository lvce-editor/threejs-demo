import * as esbuild from 'esbuild'
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createCompiler } from '../src/Compiler.ts'
import { compileScene } from '../src/CompilerRuntime.ts'

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

void test('the scene compiler resolves the bundled text geometry and font', async () => {
  const source =
    "import { TextGeometry } from 'three/addons/geometries/TextGeometry.js'; import { Font } from 'three/addons/loaders/FontLoader.js'; import fontData from './helvetiker_regular.typeface.json'; console.log(new TextGeometry('LVCE', { font: new Font(fontData) }))"
  const modules: Record<string, string> = {
    '/node_modules/three/examples/jsm/geometries/TextGeometry.js':
      "import { Font } from '../loaders/FontLoader.js'; export class TextGeometry { constructor(text, options) { this.font = options.font } }",
    '/node_modules/three/examples/jsm/loaders/FontLoader.js':
      "import { ShapePath } from 'three'; export class Font { constructor(data) { this.data = data } }",
    '/src/helvetiker_regular.typeface.json': '{"glyphs":{}}',
    '/src/main.ts': source,
  }
  const three = 'export class ShapePath {}'
  const output = await compileScene(esbuild.build, three, async (path) => {
    if (!(path in modules)) throw new Error(`Unexpected source path: ${path}`)
    return modules[path]
  })
  assert.match(output, /LVCE/)
  assert.match(output, /glyphs/)
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

void test('a compiler for the prebuilt scene needs no runtime loading before an edited build', async () => {
  let created = 0
  let terminated = 0
  const worker = {
    onerror: null,
    onmessage: null,
    onmessageerror: null,
    postMessage: (): void => {},
    terminate: (): void => {
      terminated++
    },
  } as unknown as Worker
  try {
    const compile = createCompiler(() => {
      created++
      return worker
    })
    assert.equal(created, 0)
    await compile.dispose()
    assert.equal(created, 0)
    assert.equal(terminated, 0)
    await assert.rejects(
      compile(async () => ''),
      /Scene compiler is disposed/,
    )
  } finally {
    mock.restoreAll()
  }
})

void test('the first live compilation creates a worker and disposal settles pending work', async () => {
  let created = 0
  let terminated = 0
  let messageHandler: Worker['onmessage']
  const messages: unknown[] = []
  const worker = {
    onerror: null,
    get onmessage() {
      return messageHandler
    },
    set onmessage(handler: Worker['onmessage']) {
      messageHandler = handler
    },
    onmessageerror: null,
    postMessage: (message: unknown): void => {
      messages.push(message)
    },
    terminate: (): void => {
      terminated++
    },
  } as unknown as Worker
  const compile = createCompiler(() => {
    created++
    return worker
  })
  assert.equal(created, 0)
  const pending = compile(async () => 'source')
  assert.equal(created, 1)
  assert.deepEqual(messages, [{ requestId: 1, type: 'compile' }])
  await compile.dispose()
  await assert.rejects(pending, /Scene compiler is disposed/)
  assert.equal(terminated, 1)
})
