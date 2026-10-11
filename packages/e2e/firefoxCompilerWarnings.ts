import { expect } from '@playwright/test'
import { firefox } from 'playwright'

export const verifyFirefoxCompilerWarnings = async (url: string): Promise<void> => {
  const browser = await firefox.launch({ headless: true })
  try {
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
    const source = workspace['/node_modules/typescript-eslint/index.cjs']
    if (typeof source !== 'string') throw new Error('Bundled TypeScript ESLint source is missing')
    // Parse on a blank page: the product compiles this source in a worker with
    // its own CSP, rather than in the main page's restricted script context.
    await page.evaluate((source) => {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval -- same parser used by the ESLint evaluator
      new Function(source)
    }, source)
    const compilerResponse = await fetch(compilerUrl)
    if (!compilerResponse.ok) throw new Error(`Compiler request failed: ${compilerResponse.status}`)
    const compilerSource = await compilerResponse.text()
    const compilerResponses = await page.evaluate(async (source) => {
      const { ts } = await import(`data:text/javascript,${encodeURIComponent(source)}`)
      return ts.version
    }, compilerSource)
    expect(compilerResponses).toMatch(/^6\./)
    // Firefox delivers parser warnings asynchronously after compilation.
    await page.waitForTimeout(1000)
    expect(warnings).toEqual([])
  } finally {
    await browser.close()
  }
}
