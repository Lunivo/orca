import { AI_VAULT_SCAN_CANCELLED_MESSAGE } from '../../shared/ai-vault-types'

export function throwIfRemoteSessionScanCancelled(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return
  }
  throw remoteSessionScanCancelledError()
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
      reject(remoteSessionScanCancelledError())
      return
    }
    const onAbort = (): void => reject(remoteSessionScanCancelledError())
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

function remoteSessionScanCancelledError(): Error {
  const error = new Error(AI_VAULT_SCAN_CANCELLED_MESSAGE)
  error.name = 'AbortError'
  return error
}
