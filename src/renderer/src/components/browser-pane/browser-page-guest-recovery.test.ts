// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BROWSER_GUEST_RECOVERY_TIMEOUT_MS,
  BROWSER_GUEST_VALIDATION_MAX_ATTEMPTS,
  BROWSER_GUEST_VALIDATION_RETRY_DELAY_MS,
  createBrowserPageGuestRecovery
} from './browser-page-guest-recovery'

function createRecovery(
  overrides: {
    active?: boolean
    current?: boolean
    exists?: boolean
    pending?: boolean
    registered?: boolean
    reload?: () => void
  } = {}
) {
  let pending = overrides.pending ?? false
  const reload = vi.fn(overrides.reload ?? (() => {}))
  const replaceGuest = vi.fn(() => Promise.resolve())
  const onReplacementReady = vi.fn()
  const onRecoveryFailed = vi.fn()
  const onRecoverySucceeded = vi.fn()
  const validateRegistration = vi.fn(() => Promise.resolve(overrides.registered ?? true))
  const recovery = createBrowserPageGuestRecovery({
    webview: { reload } as unknown as Electron.WebviewTag,
    browserPageExists: () => overrides.exists ?? true,
    shouldValidate: () => overrides.active ?? true,
    isCurrentWebview: () => overrides.current ?? true,
    isPending: () => pending,
    setPending: (next) => {
      pending = next
    },
    validateRegistration,
    replaceGuest,
    onReplacementReady,
    onRecoveryFailed,
    onRecoverySucceeded
  })
  return {
    recovery,
    reload,
    replaceGuest,
    onReplacementReady,
    onRecoveryFailed,
    onRecoverySucceeded,
    validateRegistration,
    pending: () => pending
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('browser page guest recovery', () => {
  it('reloads a lost renderer in place and cancels the failure surface after recovery', () => {
    vi.useFakeTimers()
    const state = createRecovery()

    state.recovery.recoverRenderer()

    expect(state.reload).toHaveBeenCalledOnce()
    expect(state.pending()).toBe(true)

    state.recovery.finish()
    vi.advanceTimersByTime(BROWSER_GUEST_RECOVERY_TIMEOUT_MS)

    expect(state.pending()).toBe(false)
    expect(state.onRecoveryFailed).not.toHaveBeenCalled()
  })

  it('recreates a guest when in-place reload is unavailable', async () => {
    const state = createRecovery({
      reload: () => {
        throw new Error('guest destroyed')
      }
    })

    state.recovery.recoverRenderer()
    await vi.waitFor(() => expect(state.onReplacementReady).toHaveBeenCalledOnce())

    expect(state.replaceGuest).toHaveBeenCalledOnce()
    expect(state.pending()).toBe(true)
  })

  it('recreates an active guest missing from the authoritative registry after resume', async () => {
    const state = createRecovery({ registered: false })

    state.recovery.validateAfterResume()
    await vi.waitFor(() => expect(state.onReplacementReady).toHaveBeenCalledOnce())

    expect(state.validateRegistration).toHaveBeenCalledOnce()
    expect(state.replaceGuest).toHaveBeenCalledOnce()
  })

  it('does not probe inactive guests on resume', async () => {
    const state = createRecovery({ active: false, registered: false })

    state.recovery.validateAfterResume()
    await Promise.resolve()

    expect(state.validateRegistration).not.toHaveBeenCalled()
    expect(state.replaceGuest).not.toHaveBeenCalled()
  })

  it('surfaces an explicit recovery failure instead of leaving a permanent blank page', () => {
    vi.useFakeTimers()
    const state = createRecovery()

    state.recovery.recoverRenderer()
    vi.advanceTimersByTime(BROWSER_GUEST_RECOVERY_TIMEOUT_MS)

    expect(state.pending()).toBe(false)
    expect(state.onRecoveryFailed).toHaveBeenCalledOnce()
  })

  it('keeps the original recovery deadline across repeated renderer loss events', () => {
    vi.useFakeTimers()
    const state = createRecovery()

    state.recovery.recoverRenderer()
    vi.advanceTimersByTime(BROWSER_GUEST_RECOVERY_TIMEOUT_MS - 1)
    state.recovery.recoverRenderer()
    vi.advanceTimersByTime(1)

    expect(state.reload).toHaveBeenCalledOnce()
    expect(state.onRecoveryFailed).toHaveBeenCalledOnce()
  })

  it('deduplicates concurrent registration validation', async () => {
    let resolveValidation: ((registered: boolean) => void) | undefined
    const state = createRecovery()
    state.validateRegistration.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveValidation = resolve
        })
    )

    state.recovery.validateAfterResume()
    state.recovery.validateAfterResume()
    expect(state.validateRegistration).toHaveBeenCalledOnce()

    resolveValidation?.(true)
    await vi.waitFor(() => expect(state.pending()).toBe(false))
  })

  it('does not validate while renderer recovery is pending', async () => {
    const state = createRecovery()

    state.recovery.recoverRenderer()
    state.recovery.validateAfterResume()
    await Promise.resolve()

    expect(state.validateRegistration).not.toHaveBeenCalled()
    expect(state.replaceGuest).not.toHaveBeenCalled()
    state.recovery.finish()
  })

  it('reports validation IPC failures without replacing a healthy guest', async () => {
    vi.useFakeTimers()
    const state = createRecovery()
    const error = new Error('ipc unavailable')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    state.validateRegistration.mockRejectedValueOnce(error)

    state.recovery.validateAfterResume()
    await vi.advanceTimersByTimeAsync(0)

    expect(warn).toHaveBeenCalledWith('[browser] guest registration validation failed:', error)
    expect(state.replaceGuest).not.toHaveBeenCalled()
    state.recovery.dispose()
  })

  it('ignores a stale validation result when renderer recovery starts', async () => {
    let resolveValidation: ((registered: boolean) => void) | undefined
    const state = createRecovery()
    state.validateRegistration
      .mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            resolveValidation = resolve
          })
      )
      .mockResolvedValue(true)

    state.recovery.validateAfterResume()
    state.recovery.recoverRenderer()
    state.recovery.finish()
    resolveValidation?.(false)
    await Promise.resolve()
    await Promise.resolve()

    expect(state.pending()).toBe(false)
    expect(state.replaceGuest).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(state.validateRegistration).toHaveBeenCalledTimes(2))
    expect(state.onRecoverySucceeded).toHaveBeenCalledOnce()
  })

  it('surfaces repeated validation failures after bounded retries', async () => {
    vi.useFakeTimers()
    const state = createRecovery()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    state.validateRegistration.mockRejectedValue(new Error('ipc unavailable'))

    state.recovery.validateAfterResume()
    await vi.advanceTimersByTimeAsync(0)
    for (let attempt = 1; attempt < BROWSER_GUEST_VALIDATION_MAX_ATTEMPTS; attempt += 1) {
      state.recovery.finish()
      await vi.advanceTimersByTimeAsync(BROWSER_GUEST_VALIDATION_RETRY_DELAY_MS)
    }

    expect(state.validateRegistration).toHaveBeenCalledTimes(BROWSER_GUEST_VALIDATION_MAX_ATTEMPTS)
    expect(state.onRecoveryFailed).toHaveBeenCalledOnce()
    expect(state.replaceGuest).not.toHaveBeenCalled()
  })

  it('cancels a pending validation retry when disposed', async () => {
    vi.useFakeTimers()
    const state = createRecovery()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    state.validateRegistration.mockRejectedValue(new Error('ipc unavailable'))

    state.recovery.validateAfterResume()
    await vi.advanceTimersByTimeAsync(0)
    state.recovery.dispose()
    await vi.advanceTimersByTimeAsync(BROWSER_GUEST_VALIDATION_RETRY_DELAY_MS)

    expect(state.validateRegistration).toHaveBeenCalledOnce()
    expect(state.onRecoveryFailed).not.toHaveBeenCalled()
  })

  it('retries a failed recovery until registration ownership converges', async () => {
    vi.useFakeTimers()
    const state = createRecovery()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    state.validateRegistration.mockRejectedValue(new Error('ipc unavailable'))

    state.recovery.validateAfterResume()
    await vi.advanceTimersByTimeAsync(0)
    for (let attempt = 1; attempt < BROWSER_GUEST_VALIDATION_MAX_ATTEMPTS; attempt += 1) {
      await vi.advanceTimersByTimeAsync(BROWSER_GUEST_VALIDATION_RETRY_DELAY_MS)
    }
    expect(state.onRecoveryFailed).toHaveBeenCalledOnce()

    state.validateRegistration.mockResolvedValue(true)
    state.recovery.retryRecovery()
    expect(state.reload).toHaveBeenCalledOnce()
    state.recovery.finish()
    state.recovery.validateAfterResume()
    await vi.advanceTimersByTimeAsync(0)

    expect(state.onRecoverySucceeded).toHaveBeenCalledOnce()
    expect(state.replaceGuest).not.toHaveBeenCalled()
  })

  it('keeps a renderer timeout visible until document readiness', async () => {
    vi.useFakeTimers()
    const state = createRecovery()

    state.recovery.recoverRenderer()
    await vi.advanceTimersByTimeAsync(BROWSER_GUEST_RECOVERY_TIMEOUT_MS)
    state.recovery.validateAfterResume()
    await vi.advanceTimersByTimeAsync(0)

    expect(state.onRecoveryFailed).toHaveBeenCalledOnce()
    expect(state.validateRegistration).not.toHaveBeenCalled()
    expect(state.onRecoverySucceeded).not.toHaveBeenCalled()

    state.recovery.retryRecovery()
    state.recovery.finish()
    state.recovery.validateAfterResume()
    await vi.advanceTimersByTimeAsync(0)

    expect(state.onRecoverySucceeded).toHaveBeenCalledOnce()
  })

  it('deduplicates manual retry while recovery is pending', () => {
    vi.useFakeTimers()
    const state = createRecovery()

    state.recovery.retryRecovery()
    state.recovery.retryRecovery()
    vi.advanceTimersByTime(BROWSER_GUEST_RECOVERY_TIMEOUT_MS)

    expect(state.reload).toHaveBeenCalledOnce()
    expect(state.onRecoveryFailed).toHaveBeenCalledOnce()
  })
})
