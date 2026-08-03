import { describe, expect, it } from 'vitest'
import type { AiVaultListResult, AiVaultScanIssue } from '../../shared/ai-vault-types'
import { mergeAiVaultListResults } from './session-list-results'

function listResult(issues: AiVaultScanIssue[]): AiVaultListResult {
  return { sessions: [], issues, scannedAt: '2026-08-02T00:00:00.000Z' }
}

const SCOPE_TRUNCATION: AiVaultScanIssue = {
  executionHostId: 'ssh:dev-box',
  agent: 'codex',
  kind: 'scope',
  path: '/home/ada',
  message: 'Only the first 64 project paths were scanned.'
}

describe('mergeAiVaultListResults', () => {
  it('keeps a per-host scope truncation notice when merging all-host results', () => {
    const merged = mergeAiVaultListResults(
      [listResult([]), listResult([SCOPE_TRUNCATION])],
      undefined
    )

    expect(merged.issues).toEqual([SCOPE_TRUNCATION])
  })

  it('keeps one scope notice per host rather than collapsing them', () => {
    const otherHost: AiVaultScanIssue = { ...SCOPE_TRUNCATION, executionHostId: 'ssh:build-box' }

    const merged = mergeAiVaultListResults(
      [listResult([SCOPE_TRUNCATION]), listResult([otherHost])],
      undefined
    )

    expect(merged.issues.map((issue) => issue.executionHostId)).toEqual([
      'ssh:dev-box',
      'ssh:build-box'
    ])
  })

  it('keeps a scope notice alongside a failing host so one bad host is not the whole story', () => {
    const hostDown: AiVaultScanIssue = {
      executionHostId: 'ssh:build-box',
      agent: 'codex',
      kind: 'host',
      path: 'build-box',
      message: 'Remote connection dropped.'
    }

    const merged = mergeAiVaultListResults(
      [listResult([SCOPE_TRUNCATION]), listResult([hostDown])],
      undefined
    )

    expect(merged.issues).toEqual([SCOPE_TRUNCATION, hostDown])
    // Kinded issues render as their own banner rows, never as skipped transcripts.
    expect(merged.issues.filter((issue) => !issue.kind)).toEqual([])
  })
})
