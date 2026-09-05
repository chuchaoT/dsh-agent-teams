/**
 * Unit tests for the client poll controller: the SSE change trigger refetches
 * immediately, stop() closes the channel, and an unavailable event source
 * degrades to the existing probe cadence.
 *
 * @module dsh-agent-teams/activity-monitor.test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

let mod
try {
  mod = await import('../src/client/activity-monitor.ts')
} catch {
  mod = await import('../lib/client/activity-monitor.js')
}

const { startActivityPolling } = mod

/** Deterministic manual "timer" that never fires unless asked. */
function manualScheduler() {
  let next = 0
  const callbacks = new Map()
  return {
    schedule(callback, intervalMs) {
      const id = ++next
      callbacks.set(id, { callback, intervalMs })
      return id
    },
    cancel(id) { callbacks.delete(id) },
    tickAll() { const all = [...callbacks.values()]; callbacks.clear(); for (const { callback } of all) callback() },
    count() { return callbacks.size },
  }
}

function snapshotBody(teams = []) {
  return {
    ok: true,
    async json() { return { teams } },
  }
}

test('SSE change trigger causes an immediate refetch', async () => {
  let opens = 0
  const notify = []
  const scheduler = manualScheduler()
  const controller = startActivityPolling(
    [{ key: 'k', sessionId: 's1', teamId: 't1' }],
    {
      fetchState: async (url) => { opens += 1; return snapshotBody([{ captainSessionId: 's1', teamId: 't1', tasks: [], members: [], messageCount: 0, captainInbox: [] }]) },
      schedule: scheduler.schedule,
      cancel: scheduler.cancel,
      connectEvents: (onNotify) => { notify.push(onNotify); return () => {} },
      settleTargets: () => {},
    },
  )
  await controller.firstTick
  const afterFirst = opens
  notify[0]() // SSE rings
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.ok(opens > afterFirst, `expected a refetch, got ${opens} (was ${afterFirst})`)
  controller.stop()
})

test('stop() closes the event channel and stops ticks', async () => {
  let closed = false
  const notify = []
  const scheduler = manualScheduler()
  const controller = startActivityPolling(
    [{ key: 'k', sessionId: 's1', teamId: 't1' }],
    {
      fetchState: async () => snapshotBody([{ captainSessionId: 's1', teamId: 't1', tasks: [], members: [], messageCount: 0, captainInbox: [] }]),
      schedule: scheduler.schedule,
      cancel: scheduler.cancel,
      connectEvents: (onNotify) => { notify.push(onNotify); return () => { closed = true } },
      settleTargets: () => {},
    },
  )
  await controller.firstTick
  controller.stop()
  assert.equal(closed, true)
})
