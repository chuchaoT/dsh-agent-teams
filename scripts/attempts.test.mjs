/**
 * Unit tests for the attempt lifecycle policy (src/attempts.ts).
 *
 * @module dsh-agent-teams/attempts.test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

let mod
try {
  mod = await import('../src/attempts.ts')
} catch {
  mod = await import('../lib/attempts.js')
}

const {
  STALE_ATTEMPT_MS,
  decideAttemptDisposition,
  hasOpenAttempt,
  parkAttempt,
  refreshAttemptHeartbeat,
  resumeAttempt,
} = mod

const RUNTIME = 'runtime-test-1'

function openTask(overrides = {}) {
  return {
    id: 't1',
    subject: 'task',
    status: 'in_progress',
    assignee: 'worker',
    dependencies: [],
    attempt: 1,
    attemptId: 'attempt-1',
    attemptStartedAt: 1000,
    attemptHeartbeatAt: 1000,
    attemptRuntimeId: RUNTIME,
    attemptParked: false,
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  }
}

function facts(overrides = {}) {
  return {
    runtimeId: RUNTIME,
    ownerResident: true,
    ownerStatus: 'idle',
    now: 2000,
    ...overrides,
  }
}

test('legacy open task without capability is recoverable', () => {
  const task = openTask({ attemptId: undefined, attemptRuntimeId: undefined })
  assert.equal(decideAttemptDisposition(task, facts()), 'recover')
})

test('open task without runtime id is recoverable', () => {
  const task = openTask({ attemptRuntimeId: undefined })
  assert.equal(decideAttemptDisposition(task, facts()), 'recover')
})

test('own runtime + parked stays parked', () => {
  const task = openTask({ attemptParked: true, attemptParkedAt: 1500 })
  assert.equal(decideAttemptDisposition(task, facts()), 'parked')
})

test('own runtime + idle owner + fresh heartbeat keeps (scheduler parks it)', () => {
  const task = openTask()
  assert.equal(decideAttemptDisposition(task, facts()), 'keep')
})

test('own runtime + running owner keeps', () => {
  const task = openTask()
  assert.equal(decideAttemptDisposition(task, facts({ ownerStatus: 'running' })), 'keep')
})

test('own runtime + absent owner recovers (cold recovery)', () => {
  const task = openTask()
  assert.equal(decideAttemptDisposition(task, facts({ ownerResident: false, ownerStatus: 'absent' })), 'recover')
})

test('own runtime + stale heartbeat recovers (watchdog)', () => {
  const task = openTask({ attemptHeartbeatAt: 1000 })
  const now = 1000 + STALE_ATTEMPT_MS + 1
  assert.equal(decideAttemptDisposition(task, facts({ now, ownerStatus: 'running' })), 'recover')
})

test('another runtime recovers (cross-process takeover)', () => {
  const task = openTask({ attemptRuntimeId: 'runtime-other' })
  assert.equal(decideAttemptDisposition(task, facts()), 'recover')
})

test('park/resume/heartbeat update durable fields', () => {
  const task = openTask()
  parkAttempt(task, 2500)
  assert.equal(task.attemptParked, true)
  assert.equal(task.attemptParkedAt, 2500)
  assert.equal(task.attemptHeartbeatAt, 2500)

  resumeAttempt(task, 3000)
  assert.equal(task.attemptParked, false)
  assert.equal(task.attemptParkedAt, undefined)
  assert.equal(task.attemptHeartbeatAt, 3000)

  refreshAttemptHeartbeat(task, 4000)
  assert.equal(task.attemptHeartbeatAt, 4000)
})

test('hasOpenAttempt only for non-terminal claimed/in_progress with capability', () => {
  assert.equal(hasOpenAttempt(openTask()), true)
  assert.equal(hasOpenAttempt(openTask({ status: 'pending' })), false)
  assert.equal(hasOpenAttempt(openTask({ status: 'completed' })), false)
  assert.equal(hasOpenAttempt(openTask({ attemptId: undefined })), false)
})
