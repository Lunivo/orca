import type {
  AiVaultListResult,
  AiVaultScanIssue,
  AiVaultSession
} from '../../shared/ai-vault-types'
import { isPathInsideOrEqual } from '../../shared/cross-platform-path'
import type { ExecutionHostId } from '../../shared/execution-host'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import type { RemoteHostPlatform } from '../ssh/ssh-remote-platform'
import {
  codexRolloutHardlinkIdentity,
  dedupeCodexRolloutFileAliases,
  dedupeCodexSessionsBySessionId
} from './codex-session-root-dedup'
import { discoverRemoteSourceCandidates } from './remote-session-scanner-discovery'
import { remoteSessionSources } from './remote-session-scanner-sources'
import type {
  RemoteScannerContext,
  RemoteSessionCandidate,
  RemoteSessionFilesystemProvider
} from './remote-session-scanner-types'
import { sessionSortTime } from './session-scanner-accumulator'
import { createAntigravityWorkspaceResolver } from './session-scanner-antigravity-history'
import { errorMessage } from './session-scanner-values'
import { mapRemoteScanBatches } from './remote-session-scan-batching'
import { throwIfAiVaultScanCancelled } from './ai-vault-scan-cancellation'
import { recordRemoteSessionScanIssue } from './remote-session-scan-issues'
import { limitRemoteScanFilesystemConcurrency } from './remote-session-scan-concurrency'

const DEFAULT_REMOTE_SCAN_LIMIT = 1000
const REMOTE_SCAN_CONCURRENCY = 8
const REMOTE_SCOPE_PARSE_LIMIT = 2000

export async function scanRemoteAiVaultSessions(args: {
  provider: RemoteSessionFilesystemProvider
  executionHostId: ExecutionHostId
  remoteHome: string
  hostPlatform: RemoteHostPlatform
  limit?: number
  scopePaths?: readonly string[]
  signal?: AbortSignal
}): Promise<AiVaultListResult> {
  throwIfAiVaultScanCancelled(args.signal)
  const limit = args.limit && args.limit > 0 ? Math.floor(args.limit) : DEFAULT_REMOTE_SCAN_LIMIT
  const issues: AiVaultScanIssue[] = []
  // One ceiling for the whole scan: discovery walks, stats and transcript reads
  // all queue behind it instead of multiplying into a nested fan-out.
  const provider = limitRemoteScanFilesystemConcurrency(args.provider)
  const context: RemoteScannerContext = {
    provider,
    executionHostId: args.executionHostId,
    hostPlatform: args.hostPlatform,
    signal: args.signal,
    titleCaches: new Map(),
    antigravityWorkspaceResolver: createAntigravityWorkspaceResolver(async (historyPath) => {
      try {
        throwIfAiVaultScanCancelled(args.signal)
        const read = await provider.readFile(historyPath)
        throwIfAiVaultScanCancelled(args.signal)
        return read.isBinary ? null : read.content
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          throw error
        }
        return null
      }
    })
  }
  const candidates = dedupeCodexRolloutFileAliases(
    (
      await mapRemoteScanBatches(
        remoteSessionSources(args.remoteHome, args.hostPlatform),
        REMOTE_SCAN_CONCURRENCY,
        (source) => discoverRemoteSourceCandidates({ source, context, issues }),
        args.signal
      )
    )
      .flat()
      .sort((left, right) => right.file.mtimeMs - left.file.mtimeMs),
    {
      isCodex: (candidate) => candidate.source.agent === 'codex',
      getFilePath: (candidate) => candidate.file.path,
      getCodexHome: (candidate) => candidate.source.codexHome ?? null,
      getHardlinkIdentity: (candidate) => codexRolloutHardlinkIdentity(candidate.file)
    }
  )

  const parsed = await parseRemoteSessionCandidates({ candidates, context, issues, limit })
  const parsedSessions = dedupeCodexSessionsBySessionId(parsed.sessions)
  const cappedSessions = parsedSessions
    .sort((left, right) => sessionSortTime(right) - sessionSortTime(left))
    .slice(0, limit)
  const scopePaths = normalizeRemoteScopePaths(args.scopePaths ?? [])
  const parsedScopeSessions = parsedSessions.filter((session) =>
    isRemoteSessionInScope(session, scopePaths)
  )
  const extraScopeSessions = await scanRemoteInScopeSessions({
    candidates,
    context,
    issues,
    scopePaths,
    alreadyParsedFilePaths: parsed.parsedFilePaths
  })
  const scopeSessions = dedupeCodexSessionsBySessionId([
    ...parsedScopeSessions,
    ...extraScopeSessions
  ])

  return {
    sessions: mergeRemoteSessions(cappedSessions, scopeSessions),
    issues,
    scannedAt: new Date().toISOString()
  }
}

async function parseRemoteSessionCandidates(args: {
  candidates: readonly RemoteSessionCandidate[]
  context: RemoteScannerContext
  issues: AiVaultScanIssue[]
  limit: number
}): Promise<{ sessions: AiVaultSession[]; parsedFilePaths: Set<string> }> {
  const sessions: AiVaultSession[] = []
  const parsedFilePaths = new Set<string>()
  let index = 0

  while (index < args.candidates.length) {
    if (canStopParsingRemoteSessions(sessions, args.limit, args.candidates[index]?.file.mtimeMs)) {
      break
    }

    const batch = args.candidates.slice(index, index + REMOTE_SCAN_CONCURRENCY)
    for (const candidate of batch) {
      parsedFilePaths.add(candidate.file.path)
    }
    throwIfAiVaultScanCancelled(args.context.signal)
    const results = await Promise.all(
      batch.map((candidate) => parseRemoteSessionCandidate(candidate, args.context, args.issues))
    )
    sessions.push(...results.filter(isAiVaultSession))
    const uniqueSessions = dedupeCodexSessionsBySessionId(sessions)
    sessions.splice(0, sessions.length, ...uniqueSessions)
    index += batch.length
    await yieldToEventLoop()
  }

  // The loop can terminate on the yield after its final batch, so re-check
  // rather than letting a cancelled scan return a partial parse as a success.
  throwIfAiVaultScanCancelled(args.context.signal)
  return { sessions, parsedFilePaths }
}

async function scanRemoteInScopeSessions(args: {
  candidates: readonly RemoteSessionCandidate[]
  context: RemoteScannerContext
  issues: AiVaultScanIssue[]
  scopePaths: readonly string[]
  alreadyParsedFilePaths: ReadonlySet<string>
}): Promise<AiVaultSession[]> {
  if (args.scopePaths.length === 0) {
    return []
  }

  const candidates = args.candidates
    .filter((candidate) => !args.alreadyParsedFilePaths.has(candidate.file.path))
    .slice(0, REMOTE_SCOPE_PARSE_LIMIT)
  const results = await mapRemoteScanBatches(
    candidates,
    REMOTE_SCAN_CONCURRENCY,
    (candidate) => parseRemoteSessionCandidate(candidate, args.context, args.issues),
    args.context.signal
  )

  return results.filter(
    (session): session is AiVaultSession =>
      isAiVaultSession(session) && isRemoteSessionInScope(session, args.scopePaths)
  )
}

async function parseRemoteSessionCandidate(
  candidate: RemoteSessionCandidate,
  context: RemoteScannerContext,
  issues: AiVaultScanIssue[]
): Promise<AiVaultSession | null> {
  try {
    throwIfAiVaultScanCancelled(context.signal)
    const read = await context.provider.readFile(candidate.file.path)
    throwIfAiVaultScanCancelled(context.signal)
    if (read.isBinary) {
      return null
    }
    const session = await candidate.source.parse(candidate.file, read.content, context)
    throwIfAiVaultScanCancelled(context.signal)
    // Mirror the local rule: every session carries its sibling subagent
    // transcript count (row badge; recoverable signal at zero turns). The
    // walk listing supplies it — the parser can't readdir a remote disk.
    const subagentTranscriptCount = candidate.subagentTranscriptCount ?? 0
    if (session && subagentTranscriptCount > 0) {
      return { ...session, subagentTranscriptCount }
    }
    return session
  } catch (err) {
    throwIfAiVaultScanCancelled(context.signal)
    recordRemoteSessionScanIssue(issues, {
      executionHostId: context.executionHostId,
      agent: candidate.source.agent,
      path: candidate.file.path,
      message: errorMessage(err)
    })
    return null
  }
}

function mergeRemoteSessions(
  cappedSessions: AiVaultSession[],
  scopeSessions: AiVaultSession[]
): AiVaultSession[] {
  if (scopeSessions.length === 0) {
    return cappedSessions
  }
  const byId = new Map<string, AiVaultSession>()
  for (const session of cappedSessions) {
    byId.set(session.id, session)
  }
  for (const session of scopeSessions) {
    byId.set(session.id, session)
  }
  return [...byId.values()].sort((left, right) => sessionSortTime(right) - sessionSortTime(left))
}

function isRemoteSessionInScope(session: AiVaultSession, scopePaths: readonly string[]): boolean {
  const cwd = session.cwd
  return Boolean(cwd && scopePaths.some((scopePath) => isPathInsideOrEqual(scopePath, cwd)))
}

function normalizeRemoteScopePaths(scopePaths: readonly string[]): string[] {
  return scopePaths.map((scopePath) => scopePath.trim()).filter(Boolean)
}

function canStopParsingRemoteSessions(
  sessions: AiVaultSession[],
  limit: number,
  nextCandidateMtimeMs: number | undefined
): boolean {
  if (sessions.length < limit || typeof nextCandidateMtimeMs !== 'number') {
    return false
  }
  const visibleCutoff = sessions
    .map(sessionSortTime)
    .sort((left, right) => right - left)
    .at(limit - 1)

  // Transcript mtimes bound the remaining candidate order; once the visible
  // cutoff is newer, older files cannot enter the unscoped top-N result.
  return typeof visibleCutoff === 'number' && nextCandidateMtimeMs < visibleCutoff
}

function isAiVaultSession(session: AiVaultSession | null): session is AiVaultSession {
  return Boolean(session)
}
