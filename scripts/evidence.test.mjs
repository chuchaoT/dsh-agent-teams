/**
 * Unit tests for the evidence module: model-declaration + host-observation
 * normalization, evidence summaries, completeness checks, and policy
 * validation.
 *
 * Runs against the TypeScript sources directly (Node >= 22.18 type
 * stripping) or the built `lib` in environments without stripping.
 * @module dsh-agent-teams/evidence.test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

let mod
try {
  mod = await import('../src/evidence.ts')
} catch {
  mod = await import('../lib/evidence.js')
}

const {
  hashSha256,
  normalizeCommandEvidence,
  summarizeEvidence,
  isEvidenceComplete,
  validateEvidencePolicy,
} = mod

/** Convenience builder for a command-kind evidence record. */
function commandRecord(command, detail, overrides = {}) {
  return {
    id: overrides.id ?? `ev:cmd:${command}`,
    ts: overrides.ts ?? 1_700_000_000_000,
    teamId: overrides.teamId ?? 't1',
    taskId: overrides.taskId ?? 'task-1',
    attemptId: overrides.attemptId ?? 'attempt-1',
    kind: 'command',
    summary: overrides.summary ?? command,
    producer: overrides.producer ?? 'host',
    detail,
  }
}

/** Convenience builder for a host observation. */
function hostObserved(exitCode = 0, overrides = {}) {
  return {
    exitCode,
    durationMs: overrides.durationMs ?? 12,
    stdoutSha256: overrides.stdoutSha256 ?? hashSha256('stdout'),
    stdoutPreview: overrides.stdoutPreview ?? 'ok',
    stderrPreview: overrides.stderrPreview ?? '',
    ...overrides,
  }
}

test('hashSha256 is the standard SHA-256 hex digest', () => {
  assert.equal(hashSha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  assert.equal(hashSha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  assert.equal(hashSha256('stdout').length, 64)
  assert.match(hashSha256('stdout'), /^[0-9a-f]{64}$/)
})

test('normalizeCommandEvidence: host observations produce passed status on exit 0', () => {
  const result = normalizeCommandEvidence({ command: 'pnpm test' }, hostObserved(0))
  assert.equal(result.status, 'passed')
  assert.equal(result.observedBy, 'host')
  assert.equal(result.command, 'pnpm test')
  assert.equal(result.exitCode, 0)
  assert.equal(result.durationMs, 12)
  assert.equal(result.stdoutSha256, hashSha256('stdout'))
  assert.equal(result.stdoutPreview, 'ok')
  assert.equal(result.stderrPreview, '')
})

test('normalizeCommandEvidence: host observations produce failed status on non-zero exit', () => {
  const result = normalizeCommandEvidence({ command: 'pnpm test', status: 'passed' }, hostObserved(2))
  assert.equal(result.status, 'failed')
  assert.equal(result.observedBy, 'host')
  assert.equal(result.exitCode, 2)
})

test('normalizeCommandEvidence: member declarations keep legal self-reported status', () => {
  const result = normalizeCommandEvidence({ command: 'pnpm test', status: 'failed', exitCode: 3, evidence: 'saw failure' })
  assert.equal(result.status, 'failed')
  assert.equal(result.observedBy, 'member')
  assert.equal(result.exitCode, 3)
  assert.equal(result.durationMs, 0)
  assert.equal(result.stdoutSha256, undefined)
})

test('normalizeCommandEvidence: illegal or missing member status becomes unobserved', () => {
  const illegal = normalizeCommandEvidence({ command: 'pnpm test', status: 'definitely-passed' })
  assert.equal(illegal.status, 'unobserved')
  assert.equal(illegal.observedBy, 'member')
  assert.equal(illegal.exitCode, null)
  const missing = normalizeCommandEvidence({ command: 'pnpm test' })
  assert.equal(missing.status, 'unobserved')
})

test('normalizeCommandEvidence: host observation overrides conflicting member status', () => {
  const result = normalizeCommandEvidence(
    { command: 'pnpm test', status: 'failed', exitCode: 7 },
    hostObserved(0, { durationMs: 42 }),
  )
  assert.equal(result.status, 'passed')
  assert.equal(result.observedBy, 'host')
  assert.equal(result.exitCode, 0)
  assert.equal(result.durationMs, 42)
})

test('summarizeEvidence renders command lines with exit code, duration, and hash prefix', () => {
  const records = [
    commandRecord('pnpm test', { command: 'pnpm test', exitCode: 0, durationMs: 12, stdoutSha256: hashSha256('abc') }),
    commandRecord('pnpm test', { command: 'pnpm test', exitCode: null, durationMs: 0, status: 'unobserved' }, {
      id: 'ev:cmd:2',
      producer: 'member',
    }),
    commandRecord('goal', { command: 'goal', exitCode: 1, durationMs: 500, stdoutSha256: undefined, status: 'failed' }, {
      id: 'ev:cmd:3',
    }),
  ]
  const summary = summarizeEvidence(records)
  const lines = summary.split('\n')
  assert.equal(lines.length, 3)
  assert.equal(lines[0], `pnpm test: exit=0, 12ms, sha:${hashSha256('abc').slice(0, 8)}`)
  assert.equal(lines[1], 'pnpm test: exit=null, 0ms, sha:-')
  assert.equal(lines[2], 'goal: exit=1, 500ms, sha:-')
})

test('summarizeEvidence renders non-command records as [kind] summary', () => {
  const records = [
    { id: 'ev:diff:1', ts: 1, teamId: 't1', taskId: 'task-1', kind: 'diff', summary: '2 files changed', producer: 'host' },
    { id: 'ev:verify:1', ts: 1, teamId: 't1', taskId: 'task-1', kind: 'verification', summary: 'grep found marker', producer: 'member' },
  ]
  const summary = summarizeEvidence(records)
  assert.equal(summary, '[diff] 2 files changed\n[verification] grep found marker')
})

test('summarizeEvidence returns empty string for no records', () => {
  assert.equal(summarizeEvidence([]), '')
  assert.equal(summarizeEvidence([], 80), '')
})

test('summarizeEvidence truncates at a line boundary with an ellipsis', () => {
  const records = Array.from({ length: 5 }, (_, i) =>
    commandRecord(`pnpm test ${i}`, { command: `pnpm test ${i}`, exitCode: 0, durationMs: 1000, stdoutSha256: hashSha256(String(i)) }))
  const summary = summarizeEvidence(records, 100)
  assert.ok(summary.length <= 100, `length ${summary.length} exceeds maxChars`)
  assert.ok(summary.length < summarizeEvidence(records).length)
  assert.ok(summary.endsWith('…'), 'truncated summary must end with an ellipsis')
  // Lines stay intact: every rendered line is either full or the summary ends at a newline.
  assert.ok(!summary.slice(0, -1).includes('…'), 'only the final ellipsis is allowed')
})

test('isEvidenceComplete is true only when every expected command has a record', () => {
  const records = [
    commandRecord('pnpm test', { command: 'pnpm test', exitCode: 0, durationMs: 10, stdoutSha256: hashSha256('a'), status: 'passed' }),
    commandRecord('pnpm lint', { command: 'pnpm lint', exitCode: 0, durationMs: 10, stdoutSha256: hashSha256('b'), status: 'passed' }, { id: 'ev:cmd:2' }),
  ]
  assert.equal(isEvidenceComplete(records, ['pnpm test', 'pnpm lint']), true)
  assert.equal(isEvidenceComplete(records, ['pnpm test']), true)
  assert.equal(isEvidenceComplete(records, ['pnpm test', 'pnpm lint', 'pnpm build']), false)
  // Exact matching: a near-miss command does not satisfy the expectation.
  assert.equal(isEvidenceComplete(records, ['pnpm test ']), false)
  assert.equal(isEvidenceComplete(records, ['PNPM TEST']), false)
})

test('isEvidenceComplete: non-command records never satisfy a command expectation', () => {
  const records = [
    { id: 'ev:diff:1', ts: 1, teamId: 't1', taskId: 'task-1', kind: 'diff', summary: 'pnpm test', producer: 'host' },
  ]
  assert.equal(isEvidenceComplete(records, ['pnpm test']), false)
  assert.equal(isEvidenceComplete(records, []), true)
})

test('validateEvidencePolicy: reject requireExitCode without host collection', () => {
  const errors = validateEvidencePolicy({ collectHost: false, requireExitCode: true, maxPreviewChars: 600 })
  assert.equal(errors.length, 1)
  assert.match(errors[0], /requireExitCode requires collectHost/)
})

test('validateEvidencePolicy: reject maxPreviewChars outside 1-20000', () => {
  const errorsLow = validateEvidencePolicy({ collectHost: true, requireExitCode: true, maxPreviewChars: 0 })
  assert.deepEqual(errorsLow, ['maxPreviewChars must be an integer between 1 and 20000'])
  const errorsHigh = validateEvidencePolicy({ collectHost: true, requireExitCode: true, maxPreviewChars: 20001 })
  assert.deepEqual(errorsHigh, ['maxPreviewChars must be an integer between 1 and 20000'])
  const errorsFloat = validateEvidencePolicy({ collectHost: true, requireExitCode: true, maxPreviewChars: 1.5 })
  assert.equal(errorsFloat.length, 1)
})

test('validateEvidencePolicy: accept boundary and unrestricted combinations', () => {
  assert.deepEqual(validateEvidencePolicy({ collectHost: true, requireExitCode: true, maxPreviewChars: 1 }), [])
  assert.deepEqual(validateEvidencePolicy({ collectHost: true, requireExitCode: true, maxPreviewChars: 20000 }), [])
  assert.deepEqual(validateEvidencePolicy({ collectHost: false, requireExitCode: false, maxPreviewChars: 600, allowedCommands: [] }), [])
  assert.deepEqual(validateEvidencePolicy({ collectHost: true, requireExitCode: false, maxPreviewChars: 600, allowedCommands: ['pnpm test', 'node --test'] }), [])
})

test('validateEvidencePolicy: reject empty command strings in allowedCommands', () => {
  const errors = validateEvidencePolicy({ collectHost: true, requireExitCode: true, maxPreviewChars: 600, allowedCommands: ['pnpm test', ''] })
  assert.deepEqual(errors, ['allowedCommands must not contain empty strings'])
})
