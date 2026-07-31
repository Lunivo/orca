// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BROWSER_GUEST_RECOVERY_TIMEOUT_MS,
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
    onRecoveryFailed
  })
  return {
    recovery,
    reload,
    replaceGuest,
    onReplacementReady,
    onRecoveryFailed,
    validateRegistration,
    pending: () => pending
  }
}

afterEach(() => {
  vi.useRealTimers()
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
})
