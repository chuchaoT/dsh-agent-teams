/**
 * Wiring tests for the two-layer evidence model in the tool layer:
 * `buildCommandEvidence` turns model-declared commandsRun into normalized
 * audit records, and `summarizeEvidence` renders them for humans/gates.
 *
 * @module dsh-agent-teams/evidence-wiring.test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

let tools
try {
  tools = await import('../src/tools-parse.ts')
} catch {
  tools = await import('../lib/tools-parse.js')
}
let evidence
try {
  evidence = await import('../src/evidence.ts')
} catch {
  evidence = await import('../lib/evidence.js')
}

const { buildCommandEvidence } = tools
const { summarizeEvidence, isEvidenceComplete, normalizeCommandEvidence } = evidence

function sampleCommand(overrides = {}) {
  return { command: 'pnpm test', status: 'passed', ...overrides }
}

test('buildCommandEvidence maps declared passes to member records', () => {
  const records = buildCommandEvidence('team-1', 't1', 'att-1', [sampleCommand()])
  assert.equal(records.length, 1)
  const record = records[0]
  assert.equal(record.kind, 'command')
  assert.equal(record.producer, 'member')
  assert.equal(record.teamId, 'team-1')
  assert.equal(record.taskId, 't1')
  assert.equal(record.attemptId, 'att-1')
  assert.equal(record.detail.command, 'pnpm test')
  // Member declaration: legal status is preserved, but the record is weak
  // evidence (observedBy='member', no host exit code) — gates must treat it
  // as declared, not host-verified.
  assert.equal(record.detail.status, 'passed')
  assert.equal(record.detail.observedBy, 'member')
  assert.equal(record.detail.exitCode, null)
})

test('host observation upgrades a member declaration to host evidence', () => {
  const declared = normalizeCommandEvidence({ command: 'pnpm test', status: 'passed' })
  const observed = normalizeCommandEvidence(
    { command: 'pnpm test', status: 'passed' },
    { exitCode: 1, durationMs: 1234, stdoutSha256: 'abc123', stdoutPreview: 'x', stderrPreview: 'y' },
  )
  assert.equal(declared.observedBy, 'member')
  assert.equal(observed.observedBy, 'host')
  assert.equal(observed.status, 'failed') // exit code 1 beats the declared 'passed'
  assert.equal(observed.durationMs, 1234)
})

test('evidence_summary renders human-readable lines', () => {
  const records = buildCommandEvidence('team-1', 't1', 'att-1', [sampleCommand(), sampleCommand({ command: 'pnpm lint', status: 'failed' })])
  const summary = summarizeEvidence(records, 600)
  assert.match(summary, /pnpm test/)
  assert.match(summary, /pnpm lint/)
  assert.ok(summary.length > 0)
})

test('isEvidenceComplete consumes normalized evidence records', () => {
  const records = buildCommandEvidence('team-1', 't1', 'att-1', [sampleCommand(), sampleCommand({ command: 'pnpm lint', status: 'passed' })])
  assert.equal(isEvidenceComplete(records, ['pnpm test', 'pnpm lint']), true)
  assert.equal(isEvidenceComplete(records, ['pnpm test', 'pnpm lint', 'pnpm build']), false)
})
