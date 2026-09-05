/**
 * Unit tests for the telemetry module: record creation and kind validation,
 * token/cost math, readable summaries with truncation, and totals/attribution
 * with attempt dedupe.
 *
 * Runs against the TypeScript sources directly (Node >= 22.18 type
 * stripping) or the built `lib` in environments without stripping.
 * @module dsh-agent-teams/telemetry.test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

let mod
try {
  mod = await import('../src/telemetry.ts')
} catch {
  mod = await import('../lib/telemetry.js')
}

const {
  createTelemetryRecord,
  computeAttemptTokens,
  estimateCostUsd,
  summarizeTelemetry,
  totalsOf,
} = mod

/** Convenience builder for an `attempt_finished` record on team t1. */
function record(overrides = {}) {
  return createTelemetryRecord({
    teamId: 't1',
    taskId: 'task-1',
    attemptId: 'attempt-1',
    memberName: 'alice',
    kind: 'attempt_finished',
    ...overrides,
  })
}

test('createTelemetryRecord: fills id and ts with stable defaults', () => {
  const before = Date.now()
  const rec = createTelemetryRecord({ teamId: 't1', kind: 'attempt_started' })
  const after = Date.now()
  assert.match(rec.id, /^tl-\d+-[0-9a-f]{6}$/)
  assert.ok(rec.ts >= before && rec.ts <= after, `ts ${rec.ts} outside [${before}, ${after}]`)
  assert.equal(rec.teamId, 't1')
  assert.equal(rec.kind, 'attempt_started')
})

test('createTelemetryRecord: accepts every legal kind', () => {
  for (const kind of [
    'attempt_started',
    'attempt_finished',
    'task_queue_wait',
    'gate_result',
    'fallback_switch',
    'run_summary',
  ]) {
    const rec = createTelemetryRecord({ teamId: 't1', kind })
    assert.equal(rec.kind, kind)
  }
})

test('createTelemetryRecord: throws on an unknown kind', () => {
  assert.throws(
    () => createTelemetryRecord({ teamId: 't1', kind: 'attempt_canceled' }),
    /unknown telemetry kind/,
  )
})

test('createTelemetryRecord: keeps custom id/ts and optional fields', () => {
  const rec = createTelemetryRecord({
    id: 'tl-custom-1',
    ts: 1_700_000_000_000,
    teamId: 't9',
    taskId: 'task-9',
    attemptId: 'attempt-9',
    memberName: 'bob',
    kind: 'fallback_switch',
    fallbackFrom: 'm1',
    fallbackTo: 'm2',
    labels: { phase: 'exec' },
  })
  assert.equal(rec.id, 'tl-custom-1')
  assert.equal(rec.ts, 1_700_000_000_000)
  assert.equal(rec.teamId, 't9')
  assert.equal(rec.taskId, 'task-9')
  assert.equal(rec.attemptId, 'attempt-9')
  assert.equal(rec.memberName, 'bob')
  assert.equal(rec.fallbackFrom, 'm1')
  assert.equal(rec.fallbackTo, 'm2')
  assert.deepEqual(rec.labels, { phase: 'exec' })
})

test('computeAttemptTokens: sums when both counts are present', () => {
  assert.deepEqual(computeAttemptTokens(100, 50), { totalTokens: 150 })
  assert.deepEqual(computeAttemptTokens(0, 0), { totalTokens: 0 })
})

test('computeAttemptTokens: returns undefined when either count is missing', () => {
  assert.equal(computeAttemptTokens(undefined, 50), undefined)
  assert.equal(computeAttemptTokens(100, undefined), undefined)
  assert.equal(computeAttemptTokens(), undefined)
})

test('estimateCostUsd: applies default USD rates per million tokens', () => {
  const result = estimateCostUsd({ inputTokens: 1_000_000, outputTokens: 1_000_000 })
  assert.equal(result.estimatedCostUsd, 2) // 0.5 + 1.5
  assert.equal(result.inputTokens, 1_000_000)
  assert.equal(result.outputTokens, 1_000_000)
  assert.equal(result.effectiveRate, 1) // blended $2 / 2M tokens = $1 per million
})

test('estimateCostUsd: honors custom rates', () => {
  const result = estimateCostUsd({
    inputTokens: 2_000_000,
    outputTokens: 500_000,
    inputRatePerMillion: 1,
    outputRatePerMillion: 4,
  })
  assert.equal(result.estimatedCostUsd, 4) // 2 * 1 + 0.5 * 4
  assert.equal(result.effectiveRate, 1.6)
})

test('estimateCostUsd: rounds to 6 decimal places', () => {
  const oneToken = estimateCostUsd({ inputTokens: 1, outputTokens: 0 })
  assert.equal(oneToken.estimatedCostUsd, 0.000001) // 0.0000005 rounds up
  const result = estimateCostUsd({ inputTokens: 0, outputTokens: 0 })
  assert.equal(result.estimatedCostUsd, 0)
  assert.equal(result.effectiveRate, 0)
})

test('estimateCostUsd: rejects negative and non-finite values', () => {
  assert.throws(() => estimateCostUsd({ inputTokens: -1, outputTokens: 0 }), /inputTokens must be a non-negative number/)
  assert.throws(() => estimateCostUsd({ inputTokens: 0, outputTokens: -1 }), /outputTokens must be a non-negative number/)
  assert.throws(
    () => estimateCostUsd({ inputTokens: 1, outputTokens: 0, inputRatePerMillion: -0.5 }),
    /inputRatePerMillion must be a non-negative number/,
  )
  assert.throws(
    () => estimateCostUsd({ inputTokens: 1, outputTokens: 0, outputRatePerMillion: 0 / 0 }),
    /outputRatePerMillion must be a non-negative number/,
  )
})

test('summarizeTelemetry: renders one line per attempt with filled fields', () => {
  const summary = summarizeTelemetry([
    record({ id: 'tl-1', model: 'm1', totalTokens: 100, durationMs: 50, estimatedCostUsd: 0.0035 }),
  ])
  assert.equal(summary, 't1/task-1/attempt-1 [attempt_finished]: m1 100 tokens 50ms ~$0.0035')
})

test('summarizeTelemetry: omits fields that are absent', () => {
  const summary = summarizeTelemetry([record({ id: 'tl-2' })])
  assert.equal(summary, 't1/task-1/attempt-1 [attempt_finished]:')
})

test('summarizeTelemetry: returns empty string for no records', () => {
  assert.equal(summarizeTelemetry([]), '')
})

test('summarizeTelemetry: truncates long lines to 120 characters', () => {
  const summary = summarizeTelemetry([record({ id: 'tl-3', model: 'm'.repeat(300) })])
  const lines = summary.split('\n')
  assert.equal(lines.length, 1)
  assert.equal(lines[0].length, 120)
  assert.ok(lines[0].endsWith('…'))
})

test('summarizeTelemetry: caps at 12 lines and reports the remainder', () => {
  const many = Array.from({ length: 14 }, (_, i) => record({ id: `tl-${i}`, attemptId: `attempt-${i}` }))
  const summary = summarizeTelemetry(many)
  const lines = summary.split('\n')
  assert.equal(lines.length, 13)
  assert.equal(lines[12], '... and 2 more')
  for (const line of lines) {
    assert.ok(line.length <= 120, `line longer than 120 chars: ${line.length}`)
  }

  const exact = summarizeTelemetry(Array.from({ length: 12 }, (_, i) => record({ id: `tl-${i}`, attemptId: `attempt-${i}` })))
  assert.ok(!exact.includes('... and'), 'no remainder marker for exactly 12 records')
})

test('totalsOf: returns zeroed aggregates for no records', () => {
  assert.deepEqual(totalsOf([]), {
    attempts: 0,
    totalTokens: 0,
    totalDurationMs: 0,
    totalCostUsd: 0,
    byKind: {},
    byModel: {},
  })
})

test('totalsOf: dedupes attempts by member/task/attempt and prefers attempt_finished', () => {
  const totals = totalsOf([
    record({ id: 'tl-1', kind: 'attempt_started', model: 'm1' }),
    record({ id: 'tl-2', kind: 'attempt_finished', model: 'm2', totalTokens: 10, durationMs: 100, estimatedCostUsd: 0.01 }),
    record({ id: 'tl-3', kind: 'attempt_finished', model: 'm2', totalTokens: 20, durationMs: 50, estimatedCostUsd: 0.02, memberName: 'bob', taskId: 'task-2' }),
  ])
  assert.equal(totals.attempts, 2) // started+finished on the same key collapse to one
  assert.equal(totals.totalTokens, 30)
  assert.equal(totals.totalDurationMs, 150)
  assert.equal(totals.totalCostUsd, 0.03)
  assert.deepEqual(totals.byKind, { attempt_started: 1, attempt_finished: 2 })
  assert.deepEqual(totals.byModel, {
    m1: { attempts: 0, tokens: 0, costUsd: 0 },
    m2: { attempts: 2, tokens: 30, costUsd: 0.03 },
  })
})

test('totalsOf: groups non-attempt kinds and unknown-model records', () => {
  const totals = totalsOf([
    record({ id: 'tl-4', kind: 'task_queue_wait', queuedAt: 1_000, startedAt: 1_500 }),
    record({ id: 'tl-5', kind: 'gate_result', gateVerdict: 'pass', memberName: 'carol', taskId: 'task-3', attemptId: undefined }),
    record({ id: 'tl-6', kind: 'run_summary', totalTokens: 5, estimatedCostUsd: 0.005 }),
  ])
  assert.equal(totals.attempts, 0)
  assert.equal(totals.totalTokens, 5)
  assert.equal(totals.totalCostUsd, 0.005)
  assert.deepEqual(totals.byKind, { task_queue_wait: 1, gate_result: 1, run_summary: 1 })
  assert.deepEqual(totals.byModel, {
    '(unknown)': { attempts: 0, tokens: 5, costUsd: 0.005 },
  })
})
