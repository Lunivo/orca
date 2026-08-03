import {
  AI_VAULT_SCAN_CANCELLED_MESSAGE,
  type AiVaultListResult
} from '../../shared/ai-vault-types'

// Matches the renderer's forced-rescan throttle: forced callers that arrive
// inside this window share one scan, later ones may preempt a scan that hung.
const FORCED_SCAN_PREEMPT_AFTER_MS = 5_000

type ScanEntry = {
  controller: AbortController
  force: boolean
  startedAt: number
  promise: Promise<AiVaultListResult>
  waiterCount: number
}

export class AiVaultScanCoordinator {
  private readonly entries = new Map<string, ScanEntry>()

  run(args: {
    key: string
    force?: boolean
    signal?: AbortSignal
    start: (signal: AbortSignal) => Promise<AiVaultListResult>
  }): Promise<AiVaultListResult> {
    if (args.signal?.aborted) {
      return Promise.reject(scanCancellationError())
    }
    let entry = this.entries.get(args.key)
    if (entry && args.force === true && canPreemptForForcedScan(entry)) {
      this.removeEntry(args.key, entry)
      entry.controller.abort()
      entry = undefined
    }
    if (!entry) {
      entry = this.createEntry(args.key, args.force === true, args.start)
      this.entries.set(args.key, entry)
    }
    return this.attach(args.key, entry, args.signal)
  }

  private createEntry(
    key: string,
    force: boolean,
    start: (signal: AbortSignal) => Promise<AiVaultListResult>
  ): ScanEntry {
    const controller = new AbortController()
    const entry: ScanEntry = {
      controller,
      force,
      startedAt: Date.now(),
      promise: Promise.resolve().then(() => {
        if (controller.signal.aborted) {
          throw scanCancellationError()
        }
        return start(controller.signal)
      }),
      waiterCount: 0
    }
    void entry.promise.then(
      () => this.removeEntry(key, entry),
      () => this.removeEntry(key, entry)
    )
    return entry
  }

  private attach(key: string, entry: ScanEntry, signal?: AbortSignal): Promise<AiVaultListResult> {
    entry.waiterCount++
    return new Promise((resolve, reject) => {
      let attached = true
      const detach = (): void => {
        if (!attached) {
          return
        }
        attached = false
        signal?.removeEventListener('abort', onAbort)
        entry.controller.signal.removeEventListener('abort', onAbort)
        entry.waiterCount--
        if (entry.waiterCount === 0 && !entry.controller.signal.aborted) {
          this.removeEntry(key, entry)
          entry.controller.abort()
        }
      }
      const onAbort = (): void => {
        detach()
        reject(scanCancellationError())
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      entry.controller.signal.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted || entry.controller.signal.aborted) {
        onAbort()
        return
      }
      void entry.promise.then(
        (result) => {
          if (attached) {
            detach()
            resolve(result)
          }
        },
        (error) => {
          if (attached) {
            detach()
            reject(error)
          }
        }
      )
    })
  }

  private removeEntry(key: string, entry: ScanEntry): void {
    if (this.entries.get(key) === entry) {
      this.entries.delete(key)
    }
  }
}

// Why: without this a forced scan that never settles (no inactivity timer on the
// legacy SSH file-stream reader, see #11364) makes every later Refresh join the
// dead promise, so the panel stays empty until the app restarts.
function canPreemptForForcedScan(entry: ScanEntry): boolean {
  return !entry.force || Date.now() - entry.startedAt >= FORCED_SCAN_PREEMPT_AFTER_MS
}

function scanCancellationError(): Error {
  const error = new Error(AI_VAULT_SCAN_CANCELLED_MESSAGE)
  error.name = 'AbortError'
  return error
}
