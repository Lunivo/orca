import { AI_VAULT_SCAN_CANCELLED_MESSAGE } from '../../shared/ai-vault-types'

export function throwIfAiVaultScanCancelled(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return
  }
  throw aiVaultScanCancelledError()
}

// Why: the runtime RPC transport has no abort hook, so cancellation can only
// stop the caller waiting on it — the in-flight request settles on its own
// timeout instead of holding an 'all'-scope merge open after every waiter left.
export function abandonRemoteSessionScanOnCancel<T>(
  promise: Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (!signal) {
    return promise
  }
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(aiVaultScanCancelledError())
      return
    }
    const onAbort = (): void => reject(aiVaultScanCancelledError())
    signal.addEventListener('abort', onAbort, { once: true })
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

function aiVaultScanCancelledError(): Error {
  const error = new Error(AI_VAULT_SCAN_CANCELLED_MESSAGE)
  error.name = 'AbortError'
  return error
}
