/**
 * Unit tests for ready-task ordering (priority, deadline, FIFO).
 *
 * @module dsh-agent-teams/scheduler-priority.test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

let mod
try {
  mod = await import('../src/scheduler.ts')
} catch {
  mod = await import('../lib/scheduler.js')
}

const { sortReadyTasks } = mod

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

test('high priority claims before normal before low', () => {
  const ordered = sortReadyTasks([
    task({ id: 'low', priority: 'low' }),
    task({ id: 'high', priority: 'high' }),
    task({ id: 'normal' }),
  ])
  assert.deepEqual(ordered.map(t => t.id), ['high', 'normal', 'low'])
})

test('nearest deadline wins among equal priority', () => {
  const ordered = sortReadyTasks([
    task({ id: 'later', deadlineAt: 3000 }),
    task({ id: 'sooner', deadlineAt: 2000 }),
  ])
  assert.deepEqual(ordered.map(t => t.id), ['sooner', 'later'])
})

test('tasks without deadline trail tasks with deadline', () => {
  const ordered = sortReadyTasks([
    task({ id: 'none' }),
    task({ id: 'dead', deadlineAt: 2500 }),
  ])
  assert.deepEqual(ordered.map(t => t.id), ['dead', 'none'])
})

test('ties keep stable creation order', () => {
  const ordered = sortReadyTasks([
    task({ id: 'older', createdAt: 1000 }),
    task({ id: 'newer', createdAt: 2000 }),
  ])
  assert.deepEqual(ordered.map(t => t.id), ['older', 'newer'])
})

test('priority beats deadline', () => {
  const ordered = sortReadyTasks([
    task({ id: 'low-fast', priority: 'low', deadlineAt: 100 }),
    task({ id: 'high-slow', priority: 'high' }),
  ])
  assert.deepEqual(ordered.map(t => t.id), ['high-slow', 'low-fast'])
})
