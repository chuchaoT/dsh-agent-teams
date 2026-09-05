/**
 * Unit tests for the run budget gate: telemetry cost vs configured budget.
 *
 * @module dsh-agent-teams/budget-gate.test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

let mod
try {
  mod = await import('../src/telemetry.ts')
} catch {
  mod = await import('../lib/telemetry.js')
}

const { budgetExceeded, totalsOf, createTelemetryRecord } = mod

test('unset budget never trips', () => {
  assert.equal(budgetExceeded(999, undefined), false)
})

test('negative or non-finite budgets never trip', () => {
  assert.equal(budgetExceeded(1, -1), false)
  assert.equal(budgetExceeded(1, Number.NaN), false)
  assert.equal(budgetExceeded(1, Number.POSITIVE_INFINITY), false)
})

test('budget trips at and above the limit', () => {
  assert.equal(budgetExceeded(1.0, 1.0), true)
  assert.equal(budgetExceeded(1.01, 1.0), true)
  assert.equal(budgetExceeded(0.99, 1.0), false)
})

test('zero budget trips at the first recorded cent', () => {
  assert.equal(budgetExceeded(0.000001, 0), true)
  assert.equal(budgetExceeded(0, 0), false)
})

test('totalsOf cost feeds the gate end-to-end', () => {
  const records = [
    createTelemetryRecord({ kind: 'attempt_finished', teamId: 't', taskId: 't1', inputTokens: 100, outputTokens: 100, estimatedCostUsd: 0.1 }),
    createTelemetryRecord({ kind: 'attempt_finished', teamId: 't', taskId: 't2', inputTokens: 200, outputTokens: 200, estimatedCostUsd: 0.2 }),
  ]
  const cost = totalsOf(records).totalCostUsd
  assert.equal(budgetExceeded(cost, 0.31), false)
  assert.equal(budgetExceeded(cost, 0.29), true)
  assert.equal(budgetExceeded(cost, 0.3), true)
})
