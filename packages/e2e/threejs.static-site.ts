import { expect, type Locator, type Page } from '@playwright/test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname, join, normalize, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'
import { PNG } from 'pngjs'
import { verifyFirefoxCompilerWarnings } from './firefoxCompilerWarnings.ts'

const responseDelay = Number(process.env.THREEJS_DEMO_LATENCY_MS || 0)
if (!Number.isSafeInteger(responseDelay) || responseDelay < 0) throw new Error('THREEJS_DEMO_LATENCY_MS must be a nonnegative integer')
const pathPrefix = '/threejs-demo'
const staticRoot = join(import.meta.dirname, '..', '..', '.tmp', 'static')
const contentTypes: Readonly<Record<string, string>> = {
  '.css': 'text/css',
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}
const sandboxInstrumentation = `{
  const timers = new Set()
  const contexts = new Set()
  const nativeSetTimeout = globalThis.setTimeout
  const nativeClearTimeout = globalThis.clearTimeout
  globalThis.setTimeout = (callback, delay, ...args) => {
    let handle
    handle = nativeSetTimeout(() => {
      timers.delete(handle)
      callback(...args)
    }, delay)
    timers.add(handle)
    return handle
  }
  globalThis.clearTimeout = (handle) => {
    timers.delete(handle)
    return nativeClearTimeout(handle)
  }
  const getContext = OffscreenCanvas.prototype.getContext
  OffscreenCanvas.prototype.getContext = function (...args) {
    const context = getContext.apply(this, args)
    if (context && (args[0] === 'webgl' || args[0] === 'webgl2')) {
      contexts.add(context)
      this.addEventListener('webglcontextlost', () => contexts.delete(context), { once: true })
    }
    return context
  }
  Object.defineProperty(globalThis, '__threejsTestResources', { value: { contexts, timers } })
}
`

const getFilePath = (requestUrl: string): string | undefined => {
  const url = new URL(requestUrl, 'http://localhost')
  let pathname = decodeURIComponent(url.pathname)
  if (pathname === pathPrefix || pathname === `${pathPrefix}/`) {
    pathname = '/index.html'
  } else if (pathname.startsWith(`${pathPrefix}/`)) {
    pathname = pathname.slice(pathPrefix.length)
  } else {
    return undefined
  }
  const relativePath = normalize(pathname).replace(/^[/\\]+/, '')
  const filePath = join(staticRoot, relativePath)
  if (!filePath.startsWith(`${staticRoot}${sep}`)) {
    return undefined
  }
  return filePath
}

const handleRequest = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
  if (responseDelay) await delay(responseDelay)
  const filePath = getFilePath(request.url || '')
  if (!filePath) {
    response.writeHead(404)
    response.end('Not Found')
    return
  }
  try {
    let content = await readFile(filePath)
    if (filePath.endsWith('/preview-sandbox-worker/dist/previewSandBoxWorkerMain.js')) {
      content = Buffer.concat([Buffer.from(sandboxInstrumentation), content])
    }
    response.writeHead(200, {
      'Content-Type': contentTypes[extname(filePath)] || 'application/octet-stream',
      ...(responseDelay && { 'Cache-Control': 'public, max-age=600' }),
    })
    response.end(content)
  } catch {
    response.writeHead(404)
    response.end('Not Found')
  }
}

const expectColor = async (canvas: Locator, color: readonly number[]): Promise<void> => {
  await expect
    .poll(async () => {
      const bounds = await canvas.boundingBox()
      if (!bounds) return []
      // Capture the rendered region even if a refresh replaces the DOM node.
      const bitmap = PNG.sync.read(await canvas.page().screenshot({ clip: bounds }))
      const offset = (Math.floor(bitmap.height / 2) * bitmap.width + Math.floor(bitmap.width / 2)) * 4
      return [...bitmap.data.subarray(offset, offset + 4)]
    })
    .toEqual(color)
}

const expectImageChanged = async (canvas: Locator, before: Buffer): Promise<void> => {
  const original = PNG.sync.read(before)
  await expect
    .poll(async () => {
      const current = PNG.sync.read(await canvas.screenshot())
      let changedPixels = 0
      for (let offset = 0; offset < original.data.length; offset += 4) {
        if (
          Math.abs(original.data[offset] - current.data[offset]) > 12 ||
          Math.abs(original.data[offset + 1] - current.data[offset + 1]) > 12 ||
          Math.abs(original.data[offset + 2] - current.data[offset + 2]) > 12
        ) {
          changedPixels++
        }
      }
      return changedPixels
    })
    .toBeGreaterThan(100)
}

const replaceSource = async (page: Page, source: string, save: boolean = true): Promise<void> => {
  await page.locator('.Editor textarea').focus()
  await page.keyboard.press('Control+a')
  await page.keyboard.insertText(source)
  if (save) await page.keyboard.press('Control+s')
}

const diagnostics = async (page: Page): Promise<string> => {
  const worker = page.workers().find((worker) => worker.url().includes('/renderer-worker/'))
  if (!worker) throw new Error('Renderer worker is not running')
  const entry = worker.url().replace('/renderer-worker/dist/rendererWorkerMain.js', '/renderer-process/dist/rendererProcessMain.js')
  return page.evaluate(async (entry) => {
    const renderer = await import(entry)
    return JSON.stringify(await renderer.executeCommand('GetActiveEditor.getDiagnostics'))
  }, entry)
}

const server = createServer((request, response) => {
  void handleRequest(request, response)
})

await new Promise<void>((resolve) => {
  server.listen(0, '127.0.0.1', resolve)
})

const address = server.address()
if (!address || typeof address === 'string') {
  throw new Error('Failed to start static test server')
}

const browser = await chromium.launch({ headless: true })
const errors: string[] = []
try {
  const page = await browser.newPage()
  page.on('pageerror', (error) => {
    errors.push(error.stack || error.message)
  })
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') errors.push(message.text())
  })
  page.on('response', (response) => {
    if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`)
  })
  page.on('requestfailed', (request) => {
    errors.push(`${request.failure()?.errorText} ${request.url()}`)
  })
  page.on('worker', (worker) => {
    errors.push(`worker ${worker.url()}`)
  })
  const url = process.env.THREEJS_DEMO_URL || `http://127.0.0.1:${address.port}${pathPrefix}/`
  await verifyFirefoxCompilerWarnings(url)
  const sourceFirstLine = page.locator('.EditorRow', { hasText: "import * as THREE from 'three'" })
  const previewCanvas = page.locator('.Viewlet.Preview #scene')

  await page.goto(url)
  try {
    await expect(sourceFirstLine).toBeVisible()
  } catch (error) {
    const artifacts = join(staticRoot, '..', 'e2e-artifacts')
    await mkdir(artifacts, { recursive: true })
    await writeFile(join(artifacts, 'startup-errors.json'), JSON.stringify(errors, null, 2))
    await writeFile(join(artifacts, 'startup.html'), await page.content())
    await page.screenshot({ path: join(artifacts, 'startup.png') })
    throw error
  }
  await expect(previewCanvas).toBeVisible()
  await expectColor(previewCanvas, [50, 184, 255, 255])
  const source = await readFile(join(import.meta.dirname, '../../src/main.ts'), 'utf8')
  const resourceCounts = async (): Promise<{ contexts: number; timers: number }> => {
    const worker = page.workers().find((worker) => worker.url().includes('/preview-sandbox-worker/'))
    if (!worker) throw new Error('Sandbox worker is missing')
    return worker.evaluate(() => {
      const resources = Object.getOwnPropertyDescriptor(globalThis, '__threejsTestResources')?.value
      return { contexts: resources.contexts.size, timers: resources.timers.size }
    })
  }
  const contextsCount = async (): Promise<number> => {
    const counts = await resourceCounts()
    return counts.contexts
  }
  await expect.poll(contextsCount).toBe(1)
  const initialResources = await resourceCounts()
  const initialTimers = initialResources.timers
  await replaceSource(page, `${source}\nexport const typeMismatch: number = "invalid"\n`, false)
  await expect.poll(() => diagnostics(page), { timeout: 30_000 }).toContain("Type 'string' is not assignable to type 'number'")
  await replaceSource(page, `${source}\nexport type Unsafe = any\n`, false)
  await expect.poll(() => diagnostics(page), { timeout: 30_000 }).toContain('Unexpected any')
  await replaceSource(page, source, false)
  await expect.poll(() => diagnostics(page), { timeout: 30_000 }).toBe('[]')

  await replaceSource(page, source.replace('#32b8ff', '#ff0000'))
  await expectColor(previewCanvas, [255, 0, 0, 255])
  await replaceSource(page, source.replace('#32b8ff', '#00ff00'))
  await replaceSource(page, source.replace('#32b8ff', '#0000ff'))
  await expectColor(previewCanvas, [0, 0, 255, 255])

  await replaceSource(page, `${source}\nconst =\n`)
  await expect(page.getByText(/Build failed:/).first()).toBeVisible()
  await expectColor(previewCanvas, [0, 0, 255, 255])
  await replaceSource(page, source)
  await expectColor(previewCanvas, [50, 184, 255, 255])

  for (let iteration = 0; iteration < 20; iteration++) {
    const red = iteration % 2 === 0
    await replaceSource(
      page,
      source.replace('#32b8ff', () => (red ? '#ff0000' : '#00ff00')),
    )
    await expectColor(previewCanvas, red ? [255, 0, 0, 255] : [0, 255, 0, 255])
    await expect.poll(contextsCount).toBe(1)
    await expect
      .poll(async () => {
        const counts = await resourceCounts()
        return counts.timers <= initialTimers + 1
      })
      .toBe(true)
    expect(page.workers().filter((worker) => worker.url().includes('/preview-sandbox-worker/'))).toHaveLength(1)
  }
  expect(errors.filter((error) => error.includes('Too many active WebGL contexts'))).toEqual([])

  await page.reload()
  await expect(sourceFirstLine).toBeVisible()
  await expect(previewCanvas).toBeVisible()
  await expectColor(previewCanvas, [50, 184, 255, 255])
  const stableSource = source.replace('cube.rotation.y += 0.01', 'cube.rotation.y += 0')
  await replaceSource(page, stableSource)
  await expect.poll(() => diagnostics(page), { timeout: 30_000 }).toBe('[]')
  const previewBounds = await previewCanvas.boundingBox()
  if (!previewBounds) throw new Error('Preview canvas has no bounding box')
  const dragStart = await previewCanvas.screenshot()
  await page.mouse.move(previewBounds.x + previewBounds.width / 2, previewBounds.y + previewBounds.height / 2)
  await page.mouse.down()
  await page.mouse.move(previewBounds.x + previewBounds.width * 0.7, previewBounds.y + previewBounds.height / 2, { steps: 5 })
  await page.mouse.up()
  await expectImageChanged(previewCanvas, dragStart)
  const zoomStart = await previewCanvas.screenshot()
  await page.mouse.move(previewBounds.x + previewBounds.width / 2, previewBounds.y + previewBounds.height / 2)
  await page.mouse.wheel(0, -300)
  await expectImageChanged(previewCanvas, zoomStart)
  expect(await page.evaluate(() => (globalThis as unknown as { scrollY: number }).scrollY)).toBe(0)
  const panStart = await previewCanvas.screenshot()
  await page.mouse.move(previewBounds.x + previewBounds.width / 2, previewBounds.y + previewBounds.height / 2)
  await page.mouse.down({ button: 'right' })
  await page.mouse.move(previewBounds.x + previewBounds.width * 0.7, previewBounds.y + previewBounds.height * 0.7, { steps: 5 })
  await page.mouse.up({ button: 'right' })
  await expectImageChanged(previewCanvas, panStart)
  expect(errors.filter((error) => error.includes('setPointerCapture is not a function'))).toEqual([])
  expect(errors.filter((error) => error.includes('Failed to hash ESLint files in one batch'))).toEqual([])
} catch (error) {
  const artifacts = join(staticRoot, '..', 'e2e-artifacts')
  await mkdir(artifacts, { recursive: true })
  await writeFile(join(artifacts, 'failure-errors.json'), JSON.stringify(errors, null, 2))
  const page = browser.contexts()[0]?.pages()[0]
  if (page) {
    await writeFile(join(artifacts, 'failure.html'), await page.content())
    await page.screenshot({ path: join(artifacts, 'failure.png') })
  }
  throw error
} finally {
  await browser.close()
  server.close()
}
