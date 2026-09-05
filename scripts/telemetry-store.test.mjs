/**
 * Unit tests for the telemetry persistence layer in state.ts.
 *
 * @module dsh-agent-teams/telemetry-store.test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let mod
try {
  mod = await import('../src/state.ts')
} catch {
  mod = await import('../lib/state.js')
}

const { appendTeamTelemetry, readTeamTelemetry } = mod

let telemetry
try {
  telemetry = await import('../src/telemetry.ts')
} catch {
  telemetry = await import('../lib/telemetry.js')
}

const { createTelemetryRecord } = telemetry

async function tempStateRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'agent-teams-tel-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('telemetry append/read round-trips records', async (t) => {
  const root = await tempStateRoot(t)
  await mkdir(join(root, 'team-1'), { recursive: true })
  await appendTeamTelemetry(root, 'team-1', createTelemetryRecord({ kind: 'attempt_started', teamId: 'team-1', taskId: 't1' }))
  await appendTeamTelemetry(root, 'team-1', createTelemetryRecord({ kind: 'attempt_finished', teamId: 'team-1', taskId: 't1', durationMs: 42 }))
  const records = await readTeamTelemetry(root, 'team-1')
  assert.equal(records.length, 2)
  assert.equal(records[0].kind, 'attempt_started')
  assert.equal(records[1].kind, 'attempt_finished')
  assert.equal(records[1].durationMs, 42)
  assert.equal(records[1].teamId, 'team-1')
})

test('telemetry read tolerates a torn tail line', async (t) => {
  const root = await tempStateRoot(t)
  await mkdir(join(root, 'team-1'), { recursive: true })
  await appendTeamTelemetry(root, 'team-1', createTelemetryRecord({ kind: 'fallback_switch', teamId: 'team-1' }))
  await writeFile(join(root, 'team-1', 'telemetry.jsonl'), '{"partial":\n', { flag: 'a' })
  const records = await readTeamTelemetry(root, 'team-1')
  assert.equal(records.length, 1)
  assert.equal(records[0].kind, 'fallback_switch')
})

test('telemetry read returns [] for missing team/telemetry file', async (t) => {
  const root = await tempStateRoot(t)
  assert.deepEqual(await readTeamTelemetry(root, 'nope'), [])
})
