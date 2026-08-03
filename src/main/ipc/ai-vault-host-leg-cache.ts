import type { AiVaultListResult } from '../../shared/ai-vault-types'

export const AI_VAULT_CACHE_TTL_MS = 15_000

type CachedHostLeg = {
  result: AiVaultListResult
  expiresAt: number
}

// Why: the merged result is only cacheable when every host answered, so one
// flaky host used to force a full rescan of every healthy host on each panel
// open. Legs are cached individually and the failing host is the only one
// rescanned.
const cachedHostLegs = new Map<string, CachedHostLeg>()

/** Serves one host's leg from the per-host TTL cache, and stores it only when
 * that host answered without a host issue — a failing host is retried on the
 * next open while its healthy neighbours stay cached. */
export async function scanHostLegWithCache(args: {
  cacheKey: string
  force: boolean
  scan: () => Promise<AiVaultListResult>
}): Promise<AiVaultListResult> {
  const now = Date.now()
  const cached = cachedHostLegs.get(args.cacheKey)
  if (!args.force && cached && cached.expiresAt > now) {
    return cached.result
  }
  const result = await args.scan()
  if (result.issues.some((issue) => issue.kind === 'host')) {
    cachedHostLegs.delete(args.cacheKey)
    return result
  }
  pruneExpiredHostLegs(now)
  cachedHostLegs.set(args.cacheKey, {
    result,
    expiresAt: Date.now() + AI_VAULT_CACHE_TTL_MS
  })
  return result
}

function pruneExpiredHostLegs(now: number): void {
  for (const [cacheKey, entry] of cachedHostLegs) {
    if (entry.expiresAt <= now) {
      cachedHostLegs.delete(cacheKey)
    }
  }
}

export function resetAiVaultHostLegCacheForTests(): void {
  cachedHostLegs.clear()
}
