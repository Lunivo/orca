import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, getActiveWorktreeId, waitForActiveWorktree } from './helpers/store'

type BrowserGuestState = {
  chromePresent: boolean
  marker: string | null
  url: string | null
  webContentsId: number | null
}

async function readGuestProcessId(
  electronApp: ElectronApplication,
  webContentsId: number
): Promise<number | null> {
  return electronApp.evaluate(({ webContents }, targetId) => {
    const guest = webContents.fromId(targetId)
    return guest && !guest.isDestroyed() ? guest.getOSProcessId() : null
  }, webContentsId)
}

type RuntimeResponse = {
  ok: boolean
  result?: { tabs?: { browserPageId: string; url: string }[] }
}

type BrowserFixture = {
  browserTab: { id: string; activePageId: string }
  fixtureUrl: string
  worktreeId: string
}

async function createBrowserFixture(
  page: Page,
  registerCleanup: (cleanup: () => Promise<void>) => void
): Promise<BrowserFixture> {
  const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'orca-browser-recovery-'))
  registerCleanup(async () => {
    rmSync(fixtureDir, { recursive: true, force: true })
  })
  const fixturePath = path.join(fixtureDir, 'recovery.html')
  writeFileSync(
    fixturePath,
    '<!doctype html><html><head><title>Recovery fixture</title></head><body style="background:#fff"><h1 id="recovery-marker">painted-file-guest</h1></body></html>'
  )
  const fixtureUrl = pathToFileURL(fixturePath).href
  await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  const worktreeId = await getActiveWorktreeId(page)
  if (!worktreeId) {
    throw new Error('Expected an active worktree')
  }
  const browserTab = await page.evaluate(
    ({ targetWorktreeId, targetUrl }) =>
      window.__store?.getState().createBrowserTab(targetWorktreeId, targetUrl, {
        title: 'Recovery fixture',
        activate: true
      }),
    { targetWorktreeId: worktreeId, targetUrl: fixtureUrl }
  )
  if (!browserTab?.activePageId) {
    throw new Error('Failed to create browser recovery fixture tab')
  }
  return {
    browserTab: { id: browserTab.id, activePageId: browserTab.activePageId },
    fixtureUrl,
    worktreeId
  }
}

async function readBrowserGuestState(page: Page, browserTabId: string): Promise<BrowserGuestState> {
  return page.evaluate(async (targetBrowserTabId) => {
    const chromePresent = Boolean(document.querySelector(`[data-tab-id="${targetBrowserTabId}"]`))
    const overlay = document.querySelector(`[data-browser-overlay-tab-id="${targetBrowserTabId}"]`)
    const webview = overlay?.querySelector('webview') as Electron.WebviewTag | null
    if (!webview) {
      return { chromePresent, marker: null, url: null, webContentsId: null }
    }
    try {
      const webContentsId = webview.getWebContentsId()
      const guest = (await webview.executeJavaScript(`({
        marker: document.querySelector('#recovery-marker')?.textContent ?? null,
        url: location.href
      })`)) as { marker: string | null; url: string }
      return { chromePresent, marker: guest.marker, url: guest.url, webContentsId }
    } catch {
      return { chromePresent, marker: null, url: null, webContentsId: null }
    }
  }, browserTabId)
}

async function listRegisteredBrowserPages(
  page: Page,
  worktreeId: string
): Promise<RuntimeResponse> {
  return page.evaluate(
    (targetWorktreeId) =>
      window.api.runtime.call({
        method: 'browser.tabList',
        params: { worktree: `id:${targetWorktreeId}` }
      }),
    worktreeId
  ) as Promise<RuntimeResponse>
}

async function crashGuestRenderer(
  electronApp: ElectronApplication,
  webContentsId: number
): Promise<Electron.RenderProcessGoneDetails> {
  return electronApp.evaluate(async ({ webContents }, targetId) => {
    const guest = webContents.fromId(targetId)
    if (!guest) {
      throw new Error(`Missing guest webContents ${targetId}`)
    }
    return new Promise<Electron.RenderProcessGoneDetails>((resolve) => {
      guest.once('render-process-gone', (_event, details) => resolve(details))
      guest.forcefullyCrashRenderer()
    })
  }, webContentsId)
}

test('browser chrome recovers a live registered file guest after renderer loss', async ({
  electronApp,
  orcaPage,
  registerPostElectronShutdownCleanup
}) => {
  const { browserTab, fixtureUrl, worktreeId } = await createBrowserFixture(
    orcaPage,
    registerPostElectronShutdownCleanup
  )

  await expect
    .poll(() => readBrowserGuestState(orcaPage, browserTab.id), { timeout: 10_000 })
    .toMatchObject({
      chromePresent: true,
      marker: 'painted-file-guest',
      url: fixtureUrl
    })
  const before = await readBrowserGuestState(orcaPage, browserTab.id)
  expect(before.webContentsId).not.toBeNull()
  const beforeProcessId = await readGuestProcessId(electronApp, before.webContentsId!)
  await expect
    .poll(() => listRegisteredBrowserPages(orcaPage, worktreeId), { timeout: 10_000 })
    .toMatchObject({
      ok: true,
      result: { tabs: [{ browserPageId: browserTab.activePageId, url: fixtureUrl }] }
    })

  const crashDetails = await crashGuestRenderer(electronApp, before.webContentsId!)
  expect(['crashed', 'killed']).toContain(crashDetails.reason)

  await expect
    .poll(() => readBrowserGuestState(orcaPage, browserTab.id), { timeout: 10_000 })
    .toMatchObject({
      chromePresent: true,
      marker: 'painted-file-guest',
      url: fixtureUrl
    })
  const recovered = await readBrowserGuestState(orcaPage, browserTab.id)
  expect(recovered.webContentsId).toBe(before.webContentsId)
  await expect
    .poll(() => readGuestProcessId(electronApp, recovered.webContentsId!), { timeout: 10_000 })
    .not.toBe(beforeProcessId)
  await expect
    .poll(() => listRegisteredBrowserPages(orcaPage, worktreeId), { timeout: 10_000 })
    .toMatchObject({
      ok: true,
      result: { tabs: [{ browserPageId: browserTab.activePageId, url: fixtureUrl }] }
    })

  const backgroundTab = await orcaPage.evaluate(
    ({ targetWorktreeId }) =>
      window.__store?.getState().createBrowserTab(targetWorktreeId, 'about:blank', {
        title: 'Background control',
        activate: true
      }),
    { targetWorktreeId: worktreeId }
  )
  expect(backgroundTab?.id).toBeTruthy()
  await expect
    .poll(() => readBrowserGuestState(orcaPage, backgroundTab!.id), { timeout: 10_000 })
    .toMatchObject({ chromePresent: true })

  await orcaPage.evaluate((browserPageId) => {
    return window.api.browser.unregisterGuest({ browserPageId })
  }, browserTab.activePageId)
  await expect
    .poll(
      async () =>
        (await listRegisteredBrowserPages(orcaPage, worktreeId)).result?.tabs?.some(
          (tab) => tab.browserPageId === browserTab.activePageId
        ) ?? false
    )
    .toBe(false)
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('system:resumed')
  })
  await orcaPage.evaluate(
    ({ targetWorktreeId, targetBrowserTabId }) => {
      const state = window.__store?.getState()
      state?.setActiveWorktree(targetWorktreeId)
      state?.setActiveBrowserTab(targetBrowserTabId)
    },
    { targetWorktreeId: worktreeId, targetBrowserTabId: browserTab.id }
  )
  await expect
    .poll(() => readBrowserGuestState(orcaPage, browserTab.id), { timeout: 10_000 })
    .toMatchObject({ chromePresent: true, marker: 'painted-file-guest', url: fixtureUrl })
  const resumeRecovered = await readBrowserGuestState(orcaPage, browserTab.id)
  expect(resumeRecovered.webContentsId).not.toBe(recovered.webContentsId)
  await expect
    .poll(async () =>
      (await listRegisteredBrowserPages(orcaPage, worktreeId)).result?.tabs?.find(
        (tab) => tab.browserPageId === browserTab.activePageId
      )
    )
    .toMatchObject({ browserPageId: browserTab.activePageId, url: fixtureUrl })

  const beforeRendererReloadId = resumeRecovered.webContentsId
  await orcaPage.reload()
  await waitForActiveWorktree(orcaPage)
  await expect
    .poll(() => readBrowserGuestState(orcaPage, browserTab.id), { timeout: 10_000 })
    .toMatchObject({ chromePresent: true, marker: 'painted-file-guest', url: fixtureUrl })
  const rendererReloaded = await readBrowserGuestState(orcaPage, browserTab.id)
  expect(rendererReloaded.webContentsId).not.toBe(beforeRendererReloadId)

  await orcaPage.evaluate((targetBrowserTabId) => {
    window.__store?.getState().setActiveBrowserTab(targetBrowserTabId)
  }, backgroundTab!.id)
  const hiddenBefore = await readBrowserGuestState(orcaPage, browserTab.id)
  const hiddenProcessId = await readGuestProcessId(electronApp, hiddenBefore.webContentsId!)
  await crashGuestRenderer(electronApp, hiddenBefore.webContentsId!)
  await expect
    .poll(() => readGuestProcessId(electronApp, hiddenBefore.webContentsId!), {
      timeout: 10_000
    })
    .not.toBe(hiddenProcessId)
  await orcaPage.evaluate((targetBrowserTabId) => {
    window.__store?.getState().setActiveBrowserTab(targetBrowserTabId)
  }, browserTab.id)
  await expect
    .poll(() => readBrowserGuestState(orcaPage, browserTab.id), { timeout: 10_000 })
    .toMatchObject({ chromePresent: true, marker: 'painted-file-guest', url: fixtureUrl })
})

test('minimized browser guest stays painted and registered after restore @headful', async ({
  electronApp,
  orcaPage,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  const { browserTab, fixtureUrl, worktreeId } = await createBrowserFixture(
    orcaPage,
    registerPostElectronShutdownCleanup
  )
  await expect
    .poll(() => readBrowserGuestState(orcaPage, browserTab.id))
    .toMatchObject({ marker: 'painted-file-guest', url: fixtureUrl })
  const before = await readBrowserGuestState(orcaPage, browserTab.id)

  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.minimize()
  })
  await expect
    .poll(() =>
      electronApp.evaluate(({ BrowserWindow }) =>
        Boolean(BrowserWindow.getAllWindows()[0]?.isMinimized())
      )
    )
    .toBe(true)
  await electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window?.restore()
    window?.show()
  })

  await expect
    .poll(() => readBrowserGuestState(orcaPage, browserTab.id))
    .toMatchObject({ chromePresent: true, marker: 'painted-file-guest', url: fixtureUrl })
  const restored = await readBrowserGuestState(orcaPage, browserTab.id)
  expect(restored.webContentsId).toBe(before.webContentsId)
  await expect
    .poll(() => listRegisteredBrowserPages(orcaPage, worktreeId))
    .toMatchObject({
      ok: true,
      result: { tabs: [{ browserPageId: browserTab.activePageId, url: fixtureUrl }] }
    })
  const screenshotPath = testInfo.outputPath('browser-minimize-restore.png')
  await orcaPage.screenshot({ path: screenshotPath, fullPage: true })
  await testInfo.attach('browser-minimize-restore', {
    path: screenshotPath,
    contentType: 'image/png'
  })
})
