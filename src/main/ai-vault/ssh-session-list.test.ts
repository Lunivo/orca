import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultListResult } from '../../shared/ai-vault-types'

const requestActiveSshAiVaultSessionList = vi.fn()
const getActiveSshAiVaultHostInfo = vi.fn()
const getSshFilesystemProvider = vi.fn()
const scanRemoteAiVaultSessions = vi.fn()

vi.mock('../ipc/ssh', () => ({
  requestActiveSshAiVaultSessionList: (...args: unknown[]) =>
    requestActiveSshAiVaultSessionList(...args),
  getActiveSshAiVaultHostInfo: (...args: unknown[]) => getActiveSshAiVaultHostInfo(...args)
}))

vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProvider: (...args: unknown[]) => getSshFilesystemProvider(...args),
  SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE: 'SSH filesystem is unavailable.'
}))

vi.mock('./remote-session-scanner', () => ({
  scanRemoteAiVaultSessions: (...args: unknown[]) => scanRemoteAiVaultSessions(...args)
}))

const { scanSshAiVaultSessions } = await import('./ssh-session-list')

describe('scanSshAiVaultSessions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
    getActiveSshAiVaultHostInfo.mockReturnValue({ remoteHome: '/home/dev', hostPlatform: 'linux' })
    getSshFilesystemProvider.mockReturnValue({})
  })

  it('bounds the legacy crawl when an older relay has no list method', async () => {
    // Relay without the method resolves null, so the leg falls through to the
    // desktop crawl — which used to run unbounded even under an all-host budget.
    requestActiveSshAiVaultSessionList.mockResolvedValue(null)
    scanRemoteAiVaultSessions.mockImplementation(
      ({ signal }: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            const error = new Error('Agent Session History scan was cancelled')
            error.name = 'AbortError'
            reject(error)
          })
        })
    )

    const result = await scanSshAiVaultSessions('dev-box', undefined, { timeoutMs: 20 })

    expect(result.sessions).toEqual([])
    expect(result.issues).toEqual([
      expect.objectContaining({
        executionHostId: 'ssh:dev-box',
        kind: 'host',
        message: 'Agent Session History scan timed out after 20ms on this SSH host.'
      })
    ])
  })

  it('leaves the crawl unbounded when no budget was requested', async () => {
    requestActiveSshAiVaultSessionList.mockResolvedValue(null)
    scanRemoteAiVaultSessions.mockResolvedValue(emptyResult())

    await scanSshAiVaultSessions('dev-box')

    expect(scanRemoteAiVaultSessions).toHaveBeenCalledWith(
      expect.objectContaining({ signal: undefined })
    )
  })

  it('reports an unexpected crawl failure as a host issue instead of rejecting', async () => {
    // Why: `all` scope awaits every host leg together, so a throw here would
    // discard the local sessions alongside this host's.
    requestActiveSshAiVaultSessionList.mockResolvedValue(null)
    scanRemoteAiVaultSessions.mockRejectedValue(new TypeError('provider blew up'))

    const result = await scanSshAiVaultSessions('dev-box')

    expect(result.sessions).toEqual([])
    expect(result.issues).toEqual([
      expect.objectContaining({ executionHostId: 'ssh:dev-box', message: 'provider blew up' })
    ])
  })

  it('still propagates a caller cancellation', async () => {
    const controller = new AbortController()
    requestActiveSshAiVaultSessionList.mockResolvedValue(null)
    scanRemoteAiVaultSessions.mockImplementation(() => {
      controller.abort()
      const error = new Error('Agent Session History scan was cancelled')
      error.name = 'AbortError'
      return Promise.reject(error)
    })

    await expect(
      scanSshAiVaultSessions('dev-box', undefined, { signal: controller.signal, timeoutMs: 5_000 })
    ).rejects.toMatchObject({ name: 'AbortError' })
  })
})

function emptyResult(): AiVaultListResult {
  return { sessions: [], issues: [], scannedAt: '2026-08-02T00:00:00.000Z' }
}
