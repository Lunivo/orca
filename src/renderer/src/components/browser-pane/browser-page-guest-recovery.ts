export const BROWSER_GUEST_RECOVERY_ERROR_CODE = -10_000
export const BROWSER_GUEST_RECOVERY_TIMEOUT_MS = 8_000

type BrowserPageGuestRecoveryOptions = {
  webview: Electron.WebviewTag
  browserPageExists: () => boolean
  shouldValidate: () => boolean
  isCurrentWebview: () => boolean
  isPending: () => boolean
  setPending: (pending: boolean) => void
  validateRegistration: () => Promise<boolean>
  replaceGuest: () => Promise<void>
  onReplacementReady: () => void
  onRecoveryFailed: () => void
}

export type BrowserPageGuestRecovery = {
  dispose: () => void
  finish: () => void
  recoverRenderer: () => void
  validateAfterResume: () => void
}

export function createBrowserPageGuestRecovery(
  options: BrowserPageGuestRecoveryOptions
): BrowserPageGuestRecovery {
  let recoveryTimer: number | null = null
  let disposed = false
  let recoveryStarted = false
  let replacementRequested = false
  let validationInFlight = false

  const clearRecoveryTimer = (): void => {
    if (recoveryTimer !== null) {
      window.clearTimeout(recoveryTimer)
      recoveryTimer = null
    }
  }
  const finish = (): void => {
    recoveryStarted = false
    options.setPending(false)
    clearRecoveryTimer()
  }
  const showRecoveryFailure = (): void => {
    if (disposed || !options.browserPageExists()) {
      return
    }
    recoveryTimer = null
    options.setPending(false)
    options.onRecoveryFailed()
  }
  const watchRecovery = (): void => {
    clearRecoveryTimer()
    recoveryTimer = window.setTimeout(showRecoveryFailure, BROWSER_GUEST_RECOVERY_TIMEOUT_MS)
  }
  const replaceGuest = (): void => {
    if (disposed || replacementRequested || !options.browserPageExists()) {
      return
    }
    replacementRequested = true
    options.setPending(true)
    clearRecoveryTimer()
    void options.replaceGuest().finally(() => {
      if (disposed || !options.browserPageExists()) {
        options.setPending(false)
        return
      }
      options.onReplacementReady()
    })
  }
  const recoverRenderer = (): void => {
    if (recoveryStarted || !options.isCurrentWebview() || !options.browserPageExists()) {
      return
    }
    recoveryStarted = true
    options.setPending(true)
    watchRecovery()
    try {
      // Why: reload keeps Chromium history and guest identity while starting a fresh renderer.
      options.webview.reload()
    } catch {
      replaceGuest()
    }
  }
  const validateAfterResume = (): void => {
    if (validationInFlight || !options.shouldValidate() || !options.isCurrentWebview()) {
      return
    }
    validationInFlight = true
    void options
      .validateRegistration()
      .then((registered) => {
        if (!registered && options.isCurrentWebview()) {
          replaceGuest()
        }
      })
      .catch(() => {})
      .finally(() => {
        validationInFlight = false
      })
  }

  if (options.isPending()) {
    watchRecovery()
  }

  return {
    dispose: () => {
      disposed = true
      clearRecoveryTimer()
    },
    finish,
    recoverRenderer,
    validateAfterResume
  }
}
