export const BROWSER_GUEST_RECOVERY_ERROR_CODE = -10_000
export const BROWSER_GUEST_RECOVERY_TIMEOUT_MS = 8_000
export const BROWSER_GUEST_VALIDATION_RETRY_DELAY_MS = 1_000
export const BROWSER_GUEST_VALIDATION_TIMEOUT_MS = 3_000
export const BROWSER_GUEST_VALIDATION_MAX_ATTEMPTS = 3

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
  onRecoverySucceeded: () => void
}

export type BrowserPageGuestRecovery = {
  dispose: () => void
  finish: () => boolean
  recoverRenderer: () => void
  retryRecovery: () => void
  validateAfterResume: () => void
}

export function createBrowserPageGuestRecovery(
  options: BrowserPageGuestRecoveryOptions
): BrowserPageGuestRecovery {
  let recoveryTimer: number | null = null
  let disposed = false
  let recoveryStarted = options.isPending()
  let replacementRequested = false
  let validationInFlight = false
  let validationFailureCount = 0
  let validationRetryTimer: number | null = null
  let validationTimeoutTimer: number | null = null
  let lifecycleGeneration = 0

  const clearRecoveryTimer = (): void => {
    if (recoveryTimer !== null) {
      window.clearTimeout(recoveryTimer)
      recoveryTimer = null
    }
  }
  const clearValidationRetry = (): void => {
    if (validationRetryTimer !== null) {
      window.clearTimeout(validationRetryTimer)
      validationRetryTimer = null
    }
  }
  const clearValidationTimeout = (): void => {
    if (validationTimeoutTimer !== null) {
      window.clearTimeout(validationTimeoutTimer)
      validationTimeoutTimer = null
    }
  }
  const finish = (): boolean => {
    const completedRecovery = recoveryStarted
    recoveryStarted = false
    options.setPending(false)
    clearRecoveryTimer()
    return completedRecovery
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
    lifecycleGeneration += 1
    validationFailureCount = 0
    options.setPending(true)
    clearRecoveryTimer()
    clearValidationRetry()
    void options.replaceGuest().then(
      () => {
        if (disposed || !options.browserPageExists()) {
          options.setPending(false)
          return
        }
        options.onReplacementReady()
      },
      (error: unknown) => {
        options.setPending(false)
        replacementRequested = false
        if (disposed || !options.browserPageExists()) {
          return
        }
        console.warn('[browser] guest replacement failed:', error)
        options.onRecoveryFailed()
      }
    )
  }
  const recoverRenderer = (): void => {
    if (
      disposed ||
      recoveryStarted ||
      !options.isCurrentWebview() ||
      !options.browserPageExists()
    ) {
      return
    }
    recoveryStarted = true
    lifecycleGeneration += 1
    validationFailureCount = 0
    options.setPending(true)
    clearValidationRetry()
    watchRecovery()
    try {
      // Why: reload keeps Chromium history and guest identity while starting a fresh renderer.
      options.webview.reload()
    } catch {
      replaceGuest()
    }
  }
  const scheduleValidationRetry = (): void => {
    clearValidationRetry()
    validationRetryTimer = window.setTimeout(() => {
      validationRetryTimer = null
      validateAfterResume()
    }, BROWSER_GUEST_VALIDATION_RETRY_DELAY_MS)
  }
  const validateRegistrationWithTimeout = (): Promise<boolean> => {
    const deadline = new Promise<never>((_resolve, reject) => {
      validationTimeoutTimer = window.setTimeout(() => {
        validationTimeoutTimer = null
        reject(new Error('Guest registration validation timed out'))
      }, BROWSER_GUEST_VALIDATION_TIMEOUT_MS)
    })
    return Promise.race([options.validateRegistration(), deadline]).finally(clearValidationTimeout)
  }
  function validateAfterResume(): void {
    if (
      disposed ||
      recoveryStarted ||
      validationInFlight ||
      options.isPending() ||
      !options.shouldValidate() ||
      !options.isCurrentWebview()
    ) {
      return
    }
    validationInFlight = true
    clearValidationRetry()
    const validationGeneration = lifecycleGeneration
    let retryValidation = false
    void validateRegistrationWithTimeout()
      .then((registered) => {
        if (validationGeneration !== lifecycleGeneration) {
          return
        }
        validationFailureCount = 0
        if (registered) {
          options.onRecoverySucceeded()
        } else if (!options.isPending() && options.isCurrentWebview()) {
          replaceGuest()
        }
      })
      .catch((error: unknown) => {
        if (validationGeneration !== lifecycleGeneration) {
          return
        }
        console.warn('[browser] guest registration validation failed:', error)
        if (
          disposed ||
          options.isPending() ||
          !options.browserPageExists() ||
          !options.shouldValidate() ||
          !options.isCurrentWebview()
        ) {
          return
        }
        validationFailureCount += 1
        if (validationFailureCount >= BROWSER_GUEST_VALIDATION_MAX_ATTEMPTS) {
          validationFailureCount = 0
          options.onRecoveryFailed()
          return
        }
        retryValidation = true
      })
      .finally(() => {
        validationInFlight = false
        if (
          validationGeneration !== lifecycleGeneration &&
          !disposed &&
          !options.isPending() &&
          options.shouldValidate() &&
          options.isCurrentWebview()
        ) {
          validateAfterResume()
        } else if (retryValidation) {
          scheduleValidationRetry()
        }
      })
  }

  if (options.isPending()) {
    watchRecovery()
  }

  return {
    dispose: () => {
      disposed = true
      lifecycleGeneration += 1
      clearRecoveryTimer()
      clearValidationRetry()
      clearValidationTimeout()
    },
    finish,
    recoverRenderer,
    retryRecovery: () => {
      if (
        disposed ||
        options.isPending() ||
        !options.isCurrentWebview() ||
        !options.browserPageExists()
      ) {
        return
      }
      recoveryStarted = false
      options.setPending(false)
      recoverRenderer()
    },
    validateAfterResume
  }
}
