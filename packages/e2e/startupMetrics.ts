import type { Browser } from 'playwright'
import { readFile } from 'node:fs/promises'

// Chromium process memory includes JavaScript heaps, workers and native allocations.
// Linux proportional set size avoids counting shared pages more than once.
export const measureStartup = async (browser: Browser): Promise<unknown> => {
  const session = await browser.newBrowserCDPSession()
  try {
    const { targetInfos } = await session.send('Target.getTargets')
    const { processInfo } = await session.send('SystemInfo.getProcessInfo')
    const processes = await Promise.all(
      processInfo.map(async (process) => {
        const memory = await readFile(`/proc/${process.id}/smaps_rollup`, 'utf8')
        const rssKiB = Number(/^Rss:\s+(\d+)/m.exec(memory)?.[1])
        const pssKiB = Number(/^Pss:\s+(\d+)/m.exec(memory)?.[1])
        return { pssKiB, rssKiB, type: process.type }
      }),
    )
    return {
      processes,
      rendererPssKiB: processes.filter((process) => process.type === 'renderer').reduce((sum, process) => sum + process.pssKiB, 0),
      totalPssKiB: processes.reduce((sum, process) => sum + process.pssKiB, 0),
      workers: targetInfos
        .filter((target) => target.type === 'worker')
        .map((target) => target.url)
        .toSorted((left, right) => left.localeCompare(right)),
    }
  } finally {
    await session.detach()
  }
}
