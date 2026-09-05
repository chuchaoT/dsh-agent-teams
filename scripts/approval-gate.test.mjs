/**
 * Unit tests for the human approval gate: approval-gated tasks never dispatch
 * before a human decision; approved ones and normal tasks dispatch freely.
 *
 * @module dsh-agent-teams/approval-gate.test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

let mod
try {
  mod = await import('../src/scheduler.ts')
} catch {
  mod = await import('../lib/scheduler.js')
}

const { isDispatchableTask } = mod

function task(overrides = {}) {
  return {
    id: 't1',
    subject: 'task',
    status: 'pending',
    dependencies: [],
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  }
}

const emptyTasks = []

test('normal pending task is dispatchable', () => {
  assert.equal(isDispatchableTask(task(), emptyTasks), true)
})

test('approval-gated awaiting task is NOT dispatchable', () => {
  const gate = task({ requiresApproval: true, approvalStatus: 'awaiting' })
  assert.equal(isDispatchableTask(gate, emptyTasks), false)
})

test('approval-gated task without a recorded status is NOT dispatchable', () => {
  const gate = task({ requiresApproval: true })
  assert.equal(isDispatchableTask(gate, emptyTasks), false)
})

test('approved task becomes dispatchable', () => {
  const gate = task({ requiresApproval: true, approvalStatus: 'approved' })
  assert.equal(isDispatchableTask(gate, emptyTasks), true)
})

test('rejected task stays non-dispatchable until re-approved', () => {
  const gate = task({ requiresApproval: true, approvalStatus: 'rejected' })
  assert.equal(isDispatchableTask(gate, emptyTasks), false)
})

test('unfinished dependencies block dispatch regardless of approval', () => {
  const dep = task({ id: 't0', status: 'pending' })
  const gate = task({ id: 't1', requiresApproval: true, approvalStatus: 'approved', dependencies: ['t0'] })
  assert.equal(isDispatchableTask(gate, [dep, gate]), false)
})
