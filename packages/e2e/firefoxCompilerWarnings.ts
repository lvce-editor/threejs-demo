import { expect } from '@playwright/test'
import { firefox } from 'playwright'

const phase = (name: string): void => {
  process.stdout.write(`[Firefox compiler] ${name}\n`)
}

export const verifyFirefoxCompilerWarnings = async (url: string): Promise<void> => {
  phase('launch')
  const browser = await firefox.launch({ headless: true })
  try {
    phase('blank page')
    const page = await browser.newPage()
    const warnings: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'warning' && message.text().includes('unreachable code')) warnings.push(message.text())
    })
    // Check that this Firefox exposes parser warnings to the collector.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- parser warning regression
    await page.evaluate(() => new Function('return; console.log("unreachable")'))
    await expect.poll(() => warnings.length).toBe(1)
    warnings.length = 0

    // Parse both shipped compiler copies, including the CJS source that ESLint
    // compiles dynamically. Runtime shims are exercised by the Chromium UI test.
    phase('fetch bundled compilers')
    const indexResponse = await fetch(url)
    if (!indexResponse.ok) throw new Error(`Index request failed: ${indexResponse.status}`)
    const index = await indexResponse.text()
    const configMatch = /<script id="Config" type="application\/json">(.*?)<\/script>/s.exec(index)
    if (!configMatch) throw new Error('Runtime configuration is missing')
    const config = JSON.parse(configMatch[1])
    const extensions = `${config.assetDir}/extensions`
    const compilerUrl = new URL(`${extensions}/builtin.language-features-typescript/typescript/lib/typescript-esm.js`, url)
    const workspaceUrl = new URL(`${extensions}/builtin.threejs-demo/dist/workspace.json`, url)
    const workspaceResponse = await fetch(workspaceUrl)
    if (!workspaceResponse.ok) throw new Error(`Workspace request failed: ${workspaceResponse.status}`)
    const workspace = await workspaceResponse.json()
    const sources = ['/node_modules/typescript-eslint/index.cjs', '/node_modules/typescript/lib/typescript.js'].map((path) => {
      const source = workspace[path]
      if (typeof source !== 'string') throw new Error(`Bundled compiler source is missing: ${path}`)
      return source
    })
    // Parse on a blank page: the product compiles this source in a worker with
    // its own CSP, rather than in the main page's restricted script context.
    phase('parse CJS compilers')
    for (const source of sources) {
      await page.evaluate((source) => {
        // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval -- same parser used by the ESLint evaluator
        new Function(source)
      }, source)
    }
    const compilerResponse = await fetch(compilerUrl)
    if (!compilerResponse.ok) throw new Error(`Compiler request failed: ${compilerResponse.status}`)
    const compilerSource = await compilerResponse.text()
    phase('parse ESM compiler')
    const compilerResponses = await page.evaluate(async (source) => {
      const { ts } = await import(`data:text/javascript,${encodeURIComponent(source)}`)
      return ts.version
    }, compilerSource)
    expect(compilerResponses).toMatch(/^6\./)
    // Firefox delivers parser warnings asynchronously after compilation.
    await page.waitForTimeout(1000)
    expect(warnings).toEqual([])
  } finally {
    phase('cleanup')
    await browser.close()
    phase('complete')
  }
}
