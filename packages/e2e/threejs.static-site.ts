/// <reference lib="dom" />
import { expect, type Locator, type Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname, join, normalize, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium, firefox } from 'playwright'
import { PNG } from 'pngjs'
import { verifyFirefoxCompilerWarnings } from './firefoxCompilerWarnings.ts'
import { measureStartup } from './startupMetrics.ts'

const responseDelay = Number(process.env.THREEJS_DEMO_LATENCY_MS || 0)
if (!Number.isSafeInteger(responseDelay) || responseDelay < 0) throw new Error('THREEJS_DEMO_LATENCY_MS must be a nonnegative integer')
const pathPrefix = '/threejs-demo'
const staticRoot = join(import.meta.dirname, '..', '..', '.tmp', 'static')
// Keep evidence outside browser RPCs: a stuck evaluate/screenshot or close must
// still fail before the CI job deadline and leave an uploadable phase record.
const runLabel = `${process.env.THREEJS_DEMO_BROWSER || 'chromium'}-${responseDelay}ms`
const artifactsDirectory = join(staticRoot, '..', 'e2e-artifacts', runLabel)
mkdirSync(artifactsDirectory, { recursive: true })
const startedAt = Date.now()
const progress = { phase: 'launch browser' }
let browserState = (): unknown => ({ launching: true })
const markPhase = (nextPhase: string): void => {
  progress.phase = nextPhase
  const entry = `${Date.now() - startedAt}ms ${progress.phase}`
  process.stdout.write(`[${runLabel}] ${entry}\n`)
  writeFileSync(
    join(artifactsDirectory, 'phase.json'),
    JSON.stringify({ elapsedMs: Date.now() - startedAt, phase: progress.phase, state: browserState() }, null, 2),
  )
}
// eslint-disable-next-line e2e/no-timeouts -- hard process deadline for stuck browser RPCs and cleanup, not a readiness wait
const watchdog = setTimeout(() => {
  markPhase(`watchdog expired during ${progress.phase}`)
  process.stderr.write(`Lifecycle exceeded 8 minutes: ${progress.phase}\n`)
  // The runner owns browser children and cleans them up after this failed step.
  // eslint-disable-next-line unicorn/no-process-exit -- browser RPCs may never settle; force a failed CLI exit after persisting evidence
  process.exit(1)
}, 8 * 60_000)
watchdog.unref()
markPhase(progress.phase)
const sandboxWorkerPathSuffix = join('preview-sandbox-worker', 'dist', 'previewSandBoxWorkerMain.js')
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
  const pointerRequests = []
  const observedPorts = new WeakSet()
  const addPortListener = MessagePort.prototype.addEventListener
  MessagePort.prototype.addEventListener = function (type, ...args) {
    if (type === 'message' && !observedPorts.has(this)) {
      observedPorts.add(this)
      addPortListener.call(this, type, event => {
        const { method, params } = event.data || {}
        if (typeof method === 'string' && method.startsWith('SandBox.handlePointer')) {
          pointerRequests.push({ method, params })
          if (pointerRequests.length > 64) pointerRequests.shift()
        }
      })
    }
    return addPortListener.call(this, type, ...args)
  }
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
  Object.defineProperty(globalThis, '__threejsTestResources', { value: { contexts, pointerRequests, timers } })
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
  if (new URL(request.url || '', 'http://localhost').pathname === `${pathPrefix}/demo-isolation.js`) {
    response.writeHead(200, { 'Content-Type': 'text/javascript' })
    response.end(`self.addEventListener('install', event => event.waitUntil(self.skipWaiting()))
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))
self.addEventListener('fetch', event => event.respondWith(fetch(event.request).then(response => {
  const headers = new Headers(response.headers)
  headers.set('Cross-Origin-Opener-Policy', 'same-origin')
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp')
  return new Response(response.body, { headers, status: response.status, statusText: response.statusText })
})))`)
    return
  }
  const filePath = getFilePath(request.url || '')
  if (!filePath) {
    response.writeHead(404)
    response.end('Not Found')
    return
  }
  try {
    let content = await readFile(filePath)
    if (filePath.endsWith(`${sep}${sandboxWorkerPathSuffix}`)) {
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

const expectColor = async (canvas: Locator, color: readonly number[], timeout: number = 5000): Promise<void> => {
  await expect
    .poll(
      async () => {
        const bounds = await canvas.boundingBox()
        if (!bounds) return []
        // Capture the rendered region even if a refresh replaces the DOM node.
        const bitmap = PNG.sync.read(await canvas.page().screenshot({ clip: bounds }))
        let matchingPixels = 0
        for (let offset = 0; offset < bitmap.data.length; offset += 4) {
          const red = bitmap.data[offset]
          const green = bitmap.data[offset + 1]
          const blue = bitmap.data[offset + 2]
          const matchesHue = color[0] > color[1] * 1.4
            ? red > green * 1.4 && red > blue * 1.4
            : color[1] > color[0] * 1.4
              ? green > red * 1.4 && green > blue * 1.4
              : color[0] > color[2] * 1.4
                ? red > blue * 1.4 && green > blue * 1.4
                : blue > red * 1.3 && blue > green * 1.05
          if (matchesHue && Math.max(red, green, blue) > 35)
            matchingPixels++
        }
        return matchingPixels
      },
      { timeout },
    )
    .toBeGreaterThan(25)
}

const expectMatcapShading = async (canvas: Locator): Promise<void> => {
  const bounds = await canvas.boundingBox()
  if (!bounds) throw new Error('Preview canvas has no bounding box')
  const bitmap = PNG.sync.read(await canvas.page().screenshot({ clip: bounds }))
  let highlightedPixels = 0
  let shadedPixels = 0
  for (let offset = 0; offset < bitmap.data.length; offset += 4) {
    const red = bitmap.data[offset]
    const green = bitmap.data[offset + 1]
    const blue = bitmap.data[offset + 2]
    if (blue > red * 1.3 && blue > green * 1.05 && Math.max(red, green, blue) > 35) {
      shadedPixels++
      if (Math.max(red, green, blue) > 180) highlightedPixels++
    }
  }
  expect(shadedPixels).toBeGreaterThan(100)
  expect(highlightedPixels).toBeGreaterThan(5)
}

const screenshotCanvas = async (canvas: Locator): Promise<Buffer | undefined> => {
  try {
    const bounds = await canvas.boundingBox()
    if (!bounds) return undefined
    return await canvas.page().screenshot({ clip: bounds })
  } catch (error) {
    if (error instanceof Error && error.message.includes('Element is not attached to the DOM')) return undefined
    throw error
  }
}

const waitForCanvasScreenshot = async (canvas: Locator): Promise<Buffer> => {
  let screenshot: Buffer | undefined
  await expect
    .poll(async () => {
      screenshot = await screenshotCanvas(canvas)
      return Boolean(screenshot)
    })
    .toBe(true)
  if (!screenshot) throw new Error('Preview canvas screenshot is unavailable')
  return screenshot
}

const expectAnimation = async (canvas: Locator): Promise<void> => {
  const bounds = await canvas.boundingBox()
  if (!bounds) throw new Error('Scene canvas has no bounds')
  const firstFrame = PNG.sync.read(await canvas.page().screenshot({ clip: bounds })).data
  await expect
    .poll(async () => {
      const nextFrame = PNG.sync.read(await canvas.page().screenshot({ clip: bounds })).data
      return firstFrame.equals(nextFrame)
    })
    .toBe(false)
}

const expectImageChanged = async (canvas: Locator, before: Buffer): Promise<void> => {
  const original = PNG.sync.read(before)
  await expect
    .poll(async () => {
      const screenshot = await screenshotCanvas(canvas)
      if (!screenshot) return 0
      const current = PNG.sync.read(screenshot)
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
  const input = page.locator('.Editor textarea')
  // eslint-disable-next-line e2e/no-direct-click -- establish native editor focus before setting the document selection
  await page.locator('.Editor').click({ position: { x: 200, y: 80 } })
  await expect(input).toBeFocused()
  const current = (await rendererCommand(page, 'GetActiveEditor.getTextDocument')) as { text: string }
  const lines = current.text.split('\n')
  await rendererCommand(page, 'GetActiveEditor.setSelections', [[0, 0, lines.length - 1, lines.at(-1)!.length]])
  await expect.poll(() => rendererCommand(page, 'GetActiveEditor.getSelections')).toEqual([0, 0, lines.length - 1, lines.at(-1)!.length])
  // Paste preserves the complete input while selection/render commands settle.
  await input.evaluate((target, text) => {
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', text)
    const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData })
    // Firefox's synthetic ClipboardEvent discards the supplied transfer contents.
    Object.defineProperty(event, 'clipboardData', { value: clipboardData })
    target.dispatchEvent(event)
  }, source)
  await expect
    .poll(async () => {
      const document = (await rendererCommand(page, 'GetActiveEditor.getTextDocument')) as { text: string } | undefined
      return document?.text
    })
    .toBe(source)
  if (save) await page.keyboard.press('Control+s')
}

const rendererCommand = async (page: Page, command: string, args: unknown[] = []): Promise<unknown> => {
  const worker = page.workers().find((worker) => worker.url().includes('/renderer-worker/'))
  if (!worker) throw new Error('Renderer worker is not running')
  const entry = worker.url().replace('/renderer-worker/dist/rendererWorkerMain.js', '/renderer-process/dist/rendererProcessMain.js')
  return page.evaluate(
    async ({ args, command, entry }) => {
      const renderer = await import(entry)
      return renderer.executeCommand(command, ...args)
    },
    { args, command, entry },
  )
}

const diagnostics = async (page: Page): Promise<string> => JSON.stringify(await rendererCommand(page, 'GetActiveEditor.getDiagnostics'))

const navigationErrors = (errors: readonly string[]): string[] => {
  return errors.filter((error) => error.includes('Cannot navigate to child: child not found at index'))
}

const indexHtml = await readFile(join(staticRoot, 'index.html'), 'utf8')
expect(indexHtml).not.toMatch(/<link\b[^>]*\brel=["']preload["']/i)
const workspaceFiles = JSON.parse(await readFile(join(import.meta.dirname, '..', 'extension', 'dist', 'workspace.json'), 'utf8'))
expect(workspaceFiles['/index.html']).toMatch(/<div>\s*<canvas id="scene" width="640" height="480"><\/canvas>\s*<\/div>/)
expect(workspaceFiles['/index.html']).toMatch(/<\/div>\s*<p>Edit src\/main\.ts and save to rebuild this scene\.<\/p>/)

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

const workspaceUri = 'memfs:///Three.js-Demo'
const browserType = process.env.THREEJS_DEMO_BROWSER === 'firefox' ? firefox : chromium
const browser = await browserType.launch({
  headless: true,
  // GPU-less CI runners otherwise reject WebGL2 with AllowWebgl2:false.
  ...(process.env.CI && browserType === firefox && { firefoxUserPrefs: { 'webgl.force-enabled': true } }),
})
const errors: string[] = [`browser ${browserType.name()} latency ${responseDelay}ms`]
browserState = (): unknown => ({
  errors,
  pages: browser.contexts().flatMap((context) =>
    context.pages().map((page) => ({
      closed: page.isClosed(),
      url: page.url(),
      workers: page.workers().map((worker) => worker.url()),
    })),
  ),
})
const fontResponses: { status: number; url: string }[] = []
const compilerWasmRequests: string[] = []
try {
  const page = await browser.newPage()
  page.on('crash', () => {
    errors.push('page crashed')
  })
  page.on('close', () => {
    errors.push('page closed')
  })
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) errors.push(`main frame navigated ${frame.url()}`)
  })
  page.on('pageerror', (error) => {
    errors.push(error.stack || error.message)
  })
  page.on('console', (message) => {
    if ((message.type() === 'error' || message.type() === 'warning') && !message.text().includes('https://example.com/')) errors.push(message.text())
  })
  page.on('response', (response) => {
    if (response.url().includes('/fonts/FiraCode-VariableFont.ttf')) {
      fontResponses.push({ status: response.status(), url: response.url() })
    }
    if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`)
    if (response.url().endsWith('/esbuild.wasm')) compilerWasmRequests.push(response.url())
  })
  page.on('requestfailed', (request) => {
    if (!request.url().startsWith('https://example.com/')) errors.push(`${request.failure()?.errorText} ${request.url()}`)
  })
  const forbiddenWorkers: string[] = []
  page.on('worker', (worker) => {
    if (/\/(?:panel-worker|icon-theme-worker|status-bar-worker|source-control-worker|output-view|activity-bar-worker)\//.test(worker.url())) {
      forbiddenWorkers.push(worker.url())
    }
    errors.push(`worker ${worker.url()}`)
  })
  const url = process.env.THREEJS_DEMO_URL || `http://127.0.0.1:${address.port}${pathPrefix}/`
  markPhase('Firefox compiler warnings')
  await verifyFirefoxCompilerWarnings(url)
  markPhase('initial navigation')
  const sourceFirstLine = page.locator('.EditorRow', { hasText: "import * as THREE from 'three'" })
  const previewCanvas = page.locator('.Viewlet.Preview #scene')
  const errorView = page.locator('.ViewletErrorMessage')

  await page.addInitScript(() => {
    const startup = { pointerEvents: [] as unknown[], visibleBars: [] as string[] }
    for (const type of ['pointerdown', 'pointermove', 'pointerup'] as const) {
      globalThis.document.addEventListener(
        type,
        ({ clientX, clientY, target, type }) => {
          if (!(target instanceof HTMLElement) || !target.closest('.Preview')) return
          startup.pointerEvents.push({ id: target.dataset.id, type, x: clientX, y: clientY })
          if (startup.pointerEvents.length > 64) startup.pointerEvents.shift()
        },
        { capture: true },
      )
    }
    Object.defineProperty(globalThis, '__threejsStartup', { value: startup })
    const observe = (): void => {
      for (const selector of ['.ActivityBar', '.StatusBar']) {
        const element = document.querySelector(selector)
        if (!element) continue
        const { height, width } = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        if (width > 0 && height > 0 && style.visibility !== 'hidden' && style.display !== 'none') startup.visibleBars.push(selector)
      }
      requestAnimationFrame(observe)
    }
    requestAnimationFrame(observe)
  })
  const assertLeanStartup = async (): Promise<void> => {
    expect(forbiddenWorkers).toEqual([])
    expect(page.workers().filter((worker) => worker.url().endsWith('/compilerWorker.js'))).toHaveLength(0)
    expect(page.workers().filter((worker) => worker.url().endsWith('/typescriptWorkerMain.js'))).toHaveLength(0)
    expect(await page.evaluate(() => Object.getOwnPropertyDescriptor(globalThis, '__threejsStartup')?.value.visibleBars)).toEqual([])
    const icon = page.getByRole('tab', { exact: true, name: 'main.ts Close' }).locator('img.TabIcon')
    await expect(icon).toBeVisible()
    await expect(icon).toHaveAttribute('src', /\/file_type_typescript\.svg$/)
    await expect.poll(() => icon.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true)
  }
  await page.goto(url)
  markPhase('CSP probe')
  const cspProbe = await page.evaluate(async () => {
    const violationPromise = new Promise<{ blockedURI: string; directive: string }>((resolve) => {
      globalThis.addEventListener(
        'securitypolicyviolation',
        (event) => resolve({ blockedURI: event.blockedURI, directive: event.effectiveDirective }),
        { once: true },
      )
    })
    const sameOriginResponse = await globalThis.fetch(globalThis.location.href)
    let externalConnectionBlocked = false
    try {
      await globalThis.fetch('https://example.com/')
    } catch {
      externalConnectionBlocked = true
    }
    return { externalConnectionBlocked, sameOriginStatus: sameOriginResponse.status, violation: await violationPromise }
  })
  expect(cspProbe.sameOriginStatus).toBe(200)
  expect(cspProbe.externalConnectionBlocked).toBe(true)
  expect(cspProbe.violation.directive).toBe('connect-src')
  expect(cspProbe.violation.blockedURI).toBe('https://example.com/')
  await expect(sourceFirstLine).toBeVisible()
  await expect(page).toHaveTitle('Three.js-Demo')
  expect(await page.evaluate(() => globalThis.crossOriginIsolated)).toBe(false)
  expect(await page.evaluate(() => globalThis.navigator.serviceWorker.controller)).toBeNull()
  expect(
    await page.evaluate(async () => {
      const registrations = await globalThis.navigator.serviceWorker.getRegistrations()
      return registrations.length
    }),
  ).toBe(0)
  expect(await page.evaluate(() => (globalThis.performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)?.type)).toBe(
    'navigate',
  )
  markPhase('initial preview structure')
  await expect(previewCanvas).toBeVisible({ timeout: 30_000 })
  // Keep this DOM assertion in Playwright's locator retry loop, including its
  // received-value diagnostics, rather than polling unbounded evaluate calls.
  const previewParent = previewCanvas.locator('..')
  await expect(previewParent).toHaveJSProperty('tagName', 'DIV')
  await expectColor(previewCanvas, [50, 184, 255, 255])
  await expectMatcapShading(previewCanvas)
  await expectAnimation(previewCanvas)
  const executeCommand = async (command: string, ...args: unknown[]): Promise<void> => {
    const config = await page.locator('#Config').textContent()
    const { assetDir } = JSON.parse(config!)
    await page.evaluate(
      async ({ args, command, entry }) => {
        const renderer = await import(entry)
        await renderer.executeCommand(command, ...args)
      },
      { args, command, entry: `${assetDir}/packages/renderer-process/dist/rendererProcessMain.js` },
    )
  }
  const assertFiraCode = async (targetPage: Page, responses: readonly { status: number; url: string }[]): Promise<void> => {
    expect(await rendererCommand(targetPage, 'Preferences.get', ['editor.fontFamily'])).toBe("'Fira Code'")
    const editor = targetPage.locator('.Editor')
    expect(await editor.evaluate((element) => getComputedStyle(element).fontFamily)).toContain('Fira Code')
    await expect.poll(() => responses.some(({ status, url }) => status === 200 && url.includes('/threejs-demo/'))).toBe(true)
  }
  await assertFiraCode(page, fontResponses)
  await assertLeanStartup()
  expect(compilerWasmRequests).toEqual([])
  markPhase('preview tab lifecycle')
  const previewCloseButtons = page.locator('.SimpleBrowserTabClose')
  for (let iteration = 0; iteration < 3; iteration++) {
    await executeCommand('Layout.showPreview', `${workspaceUri}/index.html`)
    await expect(previewCloseButtons).toHaveCount(2)
    await expect(page).toHaveTitle('Three.js-Demo')
    await expectColor(previewCanvas, [50, 184, 255, 255])
    // eslint-disable-next-line e2e/no-direct-click -- exercises the native preview-tab disposal handler
    await previewCloseButtons.last().click()
    await expect(previewCloseButtons).toHaveCount(1)
    await expectColor(previewCanvas, [50, 184, 255, 255])
  }
  const source = await readFile(join(import.meta.dirname, '../../src/main.ts'), 'utf8')
  expect(navigationErrors(errors)).toEqual([])
  const resourceCounts = async (): Promise<{ contexts: number; timers: number }> => {
    const workers = page.workers().filter((worker) => worker.url().includes('/preview-sandbox-worker/'))
    const counts = await Promise.all(
      workers.map((worker) =>
        worker.evaluate(() => {
          const resources = Object.getOwnPropertyDescriptor(globalThis, '__threejsTestResources')?.value
          return { contexts: resources.contexts.size, timers: resources.timers.size }
        }),
      ),
    )
    const total = { contexts: 0, timers: 0 }
    for (const count of counts) {
      total.contexts += count.contexts
      total.timers += count.timers
    }
    return total
  }
  const contextsCount = async (): Promise<number> => {
    const counts = await resourceCounts()
    return counts.contexts
  }
  await expect.poll(contextsCount).toBe(1)
  if (process.env.THREEJS_DEMO_METRICS) {
    await writeFile(process.env.THREEJS_DEMO_METRICS, JSON.stringify(await measureStartup(browser), null, 2))
  }
  await expect.poll(() => diagnostics(page), { timeout: 30_000 }).toBe('[]')
  markPhase('diagnostic edit')
  await replaceSource(page, `${source}\nexport const typeMismatch: number = "invalid"\n`, false)
  await expect.poll(() => diagnostics(page), { timeout: 30_000 }).toContain("Type 'string' is not assignable to type 'number'")
  markPhase('diagnostic edit')
  await replaceSource(page, `${source}\nexport const typeMismatch: number = "invalid"\nexport type Unsafe = any\nPromise.resolve()\n`, false)
  await expect.poll(() => diagnostics(page), { timeout: 30_000 }).toContain("Type 'string' is not assignable to type 'number'")
  // Cold typed ESLint resolves the config graph and parses its compiler before
  // replying to overlapping edits (38s locally, including a 29.6s second request).
  await expect.poll(() => diagnostics(page), { timeout: 60_000 }).toContain('Unexpected any')
  await expect.poll(() => diagnostics(page), { timeout: 30_000 }).toContain('Promises must be awaited')
  await replaceSource(page, source, false)
  await expect.poll(() => diagnostics(page), { timeout: 30_000 }).toBe('[]')
  markPhase('preview disposal and compiler startup')
  const initialResources = await resourceCounts()
  const initialTimers = initialResources.timers
  // Closing the final preview must release its contexts and sandbox worker.
  // eslint-disable-next-line e2e/no-direct-click -- exercises the native preview-tab disposal handler
  await page.locator('.PreviewCloseButton').click()
  await expect(previewCanvas).toHaveCount(0)
  await expect.poll(() => page.workers().filter((worker) => worker.url().includes('/preview-sandbox-worker/')).length).toBe(0)
  await expect.poll(contextsCount).toBe(0)
  await executeCommand('Layout.showPreview', `${workspaceUri}/index.html`)
  await expectColor(previewCanvas, [50, 184, 255, 255])
  await expect.poll(contextsCount).toBe(1)
  await replaceSource(page, source.replace('#32b8ff', '#ff0000'))
  await expect.poll(() => page.workers().filter((worker) => worker.url().endsWith('/compilerWorker.js')).length).toBe(1)
  await expect.poll(() => compilerWasmRequests.length).toBe(1)
  // The first edit loads and compiles esbuild.wasm; this can exceed the default timeout on ARM.
  await expectColor(previewCanvas, [255, 0, 0, 255], 30_000)
  await replaceSource(page, source.replace('#32b8ff', '#00ff00'))
  await expectColor(previewCanvas, [0, 255, 0, 255], 30_000)
  await replaceSource(page, source.replace('#32b8ff', '#0000ff'))
  await expectColor(previewCanvas, [0, 0, 255, 255])

  await replaceSource(page, `${source}\nconst =\n`)
  await expect(page.getByText(/Build failed:/).first()).toBeVisible()
  await expectColor(previewCanvas, [0, 0, 255, 255])
  await replaceSource(page, source)
  await expectColor(previewCanvas, [50, 184, 255, 255], 30_000)

  for (let iteration = 0; iteration < 20; iteration++) {
    markPhase(`resource cycle ${iteration}`)
    errors.push(`resource cycle ${iteration}`)
    const red = iteration % 2 === 0
    await replaceSource(
      page,
      source.replace('#32b8ff', () => (red ? '#ff0000' : '#00ff00')),
    )
    await expectColor(previewCanvas, red ? [255, 0, 0, 255] : [0, 255, 0, 255], 30_000)
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

  markPhase('reload main page')
  await page.reload()
  await expect(sourceFirstLine).toBeVisible()
  await expect(page).toHaveTitle('Three.js-Demo')
  await expect(previewCanvas).toBeVisible({ timeout: 30_000 })
  await expectColor(previewCanvas, [50, 184, 255, 255], 30_000)
  await expectAnimation(previewCanvas)
  expect(errors.filter((error) => error.includes('Failed to hash ESLint files in one batch'))).toEqual([])
  expect(errors.filter((error) => /(?:undefined.*send|send.*undefined)/.test(error))).toEqual([])
  await expect(errorView).toHaveCount(0)
  expect(navigationErrors(errors)).toEqual([])
  for (let iteration = 0; iteration < 2; iteration++) {
    await page.evaluate(() => {
      const settings = JSON.parse(globalThis.localStorage.getItem('settings') || '{}')
      settings['application.useOnLoadJson'] = false
      globalThis.localStorage.setItem('settings', JSON.stringify(settings))
    })
    markPhase('reload main page')
    await page.reload()
    await expect(sourceFirstLine).toBeVisible()
    expect(await rendererCommand(page, 'Preferences.get', ['application.useOnLoadJson'])).toBe(true)
    await expect(previewCanvas).toBeVisible()
    await expectColor(previewCanvas, [50, 184, 255, 255])
    markPhase('diagnostic edit')
    await replaceSource(page, `${source}\nexport const typeMismatch: number = "invalid"\n`, false)
    await expect.poll(() => diagnostics(page), { timeout: 30_000 }).toContain("Type 'string' is not assignable to type 'number'")
    const firstEditStartedAt = Date.now()
    await replaceSource(page, source.replace('#32b8ff', '#ff0000'))
    // This is the first saved edit after reload and includes cold WASM worker startup.
    await expectColor(previewCanvas, [255, 0, 0, 255], 15_000)
    process.stdout.write(`first edit after reload ${Date.now() - firstEditStartedAt}ms\n`)
    await expect.poll(() => diagnostics(page), { timeout: 30_000 }).toBe('[]')
    expect(navigationErrors(errors)).toEqual([])
  }
  markPhase('preview pointer interactions')
  const stableSource = source.replace('text.rotation.y += 0.003', 'text.rotation.y += 0').replace('#32b8ff', '#ffff00')
  await replaceSource(page, stableSource)
  await expectColor(previewCanvas, [255, 255, 0, 255])
  await expect.poll(() => diagnostics(page), { timeout: 30_000 }).toBe('[]')
  const previewBounds = await previewCanvas.boundingBox()
  if (!previewBounds) throw new Error('Preview canvas has no bounding box')
  const dragStart = await waitForCanvasScreenshot(previewCanvas)
  await page.mouse.move(previewBounds.x + previewBounds.width / 2, previewBounds.y + previewBounds.height / 2)
  await page.mouse.down()
  await page.mouse.move(previewBounds.x + previewBounds.width * 0.7, previewBounds.y + previewBounds.height / 2, { steps: 5 })
  await page.mouse.up()
  await expectImageChanged(previewCanvas, dragStart)
  const zoomStart = await waitForCanvasScreenshot(previewCanvas)
  await page.mouse.move(previewBounds.x + previewBounds.width / 2, previewBounds.y + previewBounds.height / 2)
  await page.mouse.wheel(0, -300)
  await expectImageChanged(previewCanvas, zoomStart)
  expect(await page.evaluate(() => (globalThis as unknown as { scrollY: number }).scrollY)).toBe(0)
  const panStart = await waitForCanvasScreenshot(previewCanvas)
  await page.mouse.move(previewBounds.x + previewBounds.width / 2, previewBounds.y + previewBounds.height / 2)
  await page.mouse.down({ button: 'right' })
  await page.mouse.move(previewBounds.x + previewBounds.width * 0.7, previewBounds.y + previewBounds.height * 0.7, { steps: 5 })
  await page.mouse.up({ button: 'right' })
  await expectImageChanged(previewCanvas, panStart)
  expect(errors.filter((error) => error.includes('setPointerCapture is not a function'))).toEqual([])
  expect(errors.filter((error) => error.includes('Failed to hash ESLint files in one batch'))).toEqual([])
  markPhase('reload main page')
  await page.reload()
  await expect(sourceFirstLine).toBeVisible()
  await expect(previewCanvas).toBeVisible()
  await expectColor(previewCanvas, [50, 184, 255, 255])
  await assertLeanStartup()
  markPhase('completion startup')
  // Request completions without editing the newly reloaded, verified document.
  await page.locator('.Editor textarea').focus()
  const completionRow = source.split('\n').findIndex((line) => line.startsWith('renderer.setSize'))
  if (completionRow === -1) throw new Error('Renderer completion location is missing')
  const completionSelection = [completionRow, 9, completionRow, 9]
  await rendererCommand(page, 'GetActiveEditor.setSelections', [completionSelection])
  await expect.poll(() => rendererCommand(page, 'GetActiveEditor.getSelections')).toEqual(completionSelection)
  await page.keyboard.press('Control+Space')
  const completionItem = page.locator('.EditorCompletionItem').filter({ hasText: 'autoClear' }).first()
  await expect(completionItem).toBeVisible({ timeout: 30_000 })
  expect(page.workers().filter((worker) => worker.url().endsWith('/typescriptWorkerMain.js'))).toHaveLength(1)
  await page.keyboard.press('Escape')
  await page.setViewportSize({ height: 700, width: 1000 })
  await expect(previewCanvas).toBeVisible()
  await expectColor(previewCanvas, [50, 184, 255, 255])
  expect(forbiddenWorkers).toEqual([])
  // Opening a panel explicitly is outside the lean startup assertions above.
  await executeCommand('Layout.openIntegratedTerminal')
  await expect(page.getByRole('tab', { exact: true, name: 'Terminals' })).toHaveCount(0)
  await expect(errorView).toHaveCount(0)
  await expectColor(previewCanvas, [50, 184, 255, 255])
  await executeCommand('Layout.hidePanel')
  expect(errors.filter((error) => /(?:undefined.*send|send.*undefined)/.test(error))).toEqual([])
  expect(errors.filter((error) => /preloaded with link preload was not used within a few seconds/.test(error))).toEqual([])

  // Check an existing browser profile with an obsolete editor font in an
  // isolated page, leaving the scene lifecycle stress sequence uninterrupted.
  markPhase('existing profile startup')
  const existingProfilePage = await browser.newPage()
  const existingProfileFontResponses: { status: number; url: string }[] = []
  existingProfilePage.on('response', (response) => {
    if (response.url().includes('/fonts/FiraCode-VariableFont.ttf')) {
      existingProfileFontResponses.push({ status: response.status(), url: response.url() })
    }
  })
  await existingProfilePage.addInitScript(() => {
    const settings = JSON.parse(globalThis.localStorage.getItem('settings') || '{}')
    settings['editor.fontFamily'] = 'monospace'
    globalThis.localStorage.setItem('settings', JSON.stringify(settings))
  })
  await existingProfilePage.goto(url)
  const existingProfileSource = existingProfilePage.locator('.EditorRow', { hasText: "import * as THREE from 'three'" })
  await expect(existingProfileSource).toBeVisible()
  expect(await existingProfilePage.evaluate(() => globalThis.crossOriginIsolated)).toBe(false)
  await assertFiraCode(existingProfilePage, existingProfileFontResponses)
  await existingProfilePage.evaluate(async () => {
    await globalThis.navigator.serviceWorker.register('/threejs-demo/demo-isolation.js', { scope: '/threejs-demo/' })
    await globalThis.navigator.serviceWorker.ready
  })
  markPhase('existing profile service-worker reload')
  await existingProfilePage.reload()
  await existingProfilePage.waitForFunction(() => globalThis.navigator.serviceWorker.controller?.scriptURL.endsWith('/demo-isolation.js'))
  expect(await existingProfilePage.evaluate(() => globalThis.crossOriginIsolated)).toBe(true)
  const existingProfilePreview = existingProfilePage.locator('.Viewlet.Preview #scene')
  // On ARM, the editor restores its preview after the service-worker reload asynchronously.
  await expect(existingProfilePreview).toBeVisible({ timeout: 15_000 })
  await expect.poll(() => diagnostics(existingProfilePage), { timeout: 30_000 }).toBe('[]')
  await replaceSource(existingProfilePage, `${source}\nexport const typeMismatch: number = "invalid"\n`, false)
  await expect.poll(() => diagnostics(existingProfilePage), { timeout: 30_000 }).toContain("Type 'string' is not assignable to type 'number'")
  await replaceSource(existingProfilePage, source.replace('#32b8ff', '#ff0000'))
  await expectColor(existingProfilePreview, [255, 0, 0, 255], 30_000)
  markPhase('sidebar icons')
  const sidebar = page.locator('.SideBar')
  const sidebarIcons = sidebar.locator('.FileIcon')
  const assertSidebarIcons = async (iconCount = 8): Promise<void> => {
    await expect(sidebar).toBeVisible()
    await expect(page.getByRole('treeitem', { name: 'dist' })).toBeVisible()
    await expect(page.getByRole('treeitem', { name: 'node_modules' })).toBeVisible()
    await expect(page.getByRole('treeitem', { name: 'src' })).toBeVisible()
    await expect(sidebarIcons).toHaveCount(iconCount)
    await expect
      .poll(() =>
        sidebarIcons.evaluateAll((icons) => icons.every((icon) => icon instanceof HTMLImageElement && icon.complete && icon.naturalWidth > 0)),
      )
      .toBe(true)
  }
  await executeCommand('Layout.showSideBar')
  await assertSidebarIcons()
  const srcFolder = page.getByRole('treeitem', { name: 'src' })
  // eslint-disable-next-line e2e/no-direct-click -- focuses the folder row before testing ArrowRight expansion
  await srcFolder.click()
  await srcFolder.press('ArrowRight')
  await expect(page.getByRole('treeitem', { name: 'main.ts' })).toBeVisible()
  await expect(sidebarIcons).toHaveCount(10)
  await expect
    .poll(() =>
      sidebarIcons.evaluateAll((icons) => icons.every((icon) => icon instanceof HTMLImageElement && icon.complete && icon.naturalWidth > 0)),
    )
    .toBe(true)
  await executeCommand('Layout.hideSideBar')
  await expect(sidebar).toBeHidden()
  await executeCommand('Layout.showSideBar')
  await assertSidebarIcons()
  // eslint-disable-next-line e2e/no-direct-click -- focuses the folder row before testing ArrowRight expansion
  await srcFolder.click()
  await srcFolder.press('ArrowRight')
  await expect(page.getByRole('treeitem', { name: 'main.ts' })).toBeVisible()
  await expect(sidebarIcons).toHaveCount(10)
  await expect
    .poll(() =>
      sidebarIcons.evaluateAll((icons) => icons.every((icon) => icon instanceof HTMLImageElement && icon.complete && icon.naturalWidth > 0)),
    )
    .toBe(true)
} catch (error) {
  markPhase(`failure capture during ${progress.phase}`)
  const artifacts = join(staticRoot, '..', 'e2e-artifacts')
  await mkdir(artifacts, { recursive: true })
  await writeFile(join(artifacts, 'failure-assertion.txt'), error instanceof Error ? error.stack || error.message : String(error))
  await writeFile(join(artifacts, 'failure-errors.json'), JSON.stringify(errors, null, 2))
  const page = browser.contexts()[0]?.pages()[0]
  if (page) {
    // Page evidence must survive independently of destroyed worker contexts.
    try {
      await writeFile(join(artifacts, 'failure.html'), await page.content())
      await page.screenshot({ path: join(artifacts, 'failure.png') })
    } catch (captureError) {
      await writeFile(join(artifacts, 'page-capture-error.txt'), String(captureError))
    }
    try {
      const typescript = page.workers().find((worker) => worker.url().endsWith('/typescriptWorkerMain.js'))
      const textDocument = await rendererCommand(page, 'GetActiveEditor.getTextDocument')
      const trace = typescript
        ? await Promise.race([
            typescript.evaluate(async (document) => {
              const { commandMap } = await import(globalThis.location.href)
              const firstPerformanceTrace = await commandMap['Diagnostic.getFirstPerformanceTrace'](document)
              const directDiagnostics = await commandMap['Diagnostic.getDiagnostics'](document)
              return { directDiagnostics, firstPerformanceTrace }
            }, textDocument),
            (async (): Promise<never> => {
              await delay(10_000, undefined, { ref: false })
              throw new Error('TypeScript failure trace timed out after 10 seconds')
            })(),
          ])
        : { workerMissing: true }
      await writeFile(join(artifacts, 'typescript-failure-trace.json'), JSON.stringify({ textDocument, trace }, null, 2))
    } catch (traceError) {
      await writeFile(join(artifacts, 'typescript-failure-trace.json'), JSON.stringify({ error: String(traceError) }, null, 2))
    }
    try {
      const sandbox = page.workers().find((worker) => worker.url().includes('/preview-sandbox-worker/'))
      const pointerRequests = sandbox
        ? await sandbox.evaluate(() => Object.getOwnPropertyDescriptor(globalThis, '__threejsTestResources')?.value.pointerRequests)
        : []
      const pointerEvents = await page.evaluate(() => Object.getOwnPropertyDescriptor(globalThis, '__threejsStartup')?.value.pointerEvents)
      await writeFile(join(artifacts, 'pointer-events.json'), JSON.stringify({ pointerEvents, pointerRequests }, null, 2))
    } catch (captureError) {
      await writeFile(join(artifacts, 'failure-capture-error.txt'), String(captureError))
    }
  }
  throw error
} finally {
  markPhase('browser cleanup')
  await browser.close()
  markPhase('server cleanup')
  server.close()
  clearTimeout(watchdog)
  markPhase('complete')
}
