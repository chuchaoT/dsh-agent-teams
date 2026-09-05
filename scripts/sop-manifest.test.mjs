/**
 * Unit tests for SOP stage barriers and the run manifest.
 *
 * @module dsh-agent-teams/sop-manifest.test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

let profiles
try {
  profiles = await import('../src/profiles.ts')
} catch {
  profiles = await import('../lib/profiles.js')
}

let manifest
try {
  manifest = await import('../src/manifest.ts')
} catch {
  manifest = await import('../lib/manifest.js')
}

const { applyStageBarriers } = profiles
const { buildTeamManifest } = manifest

function task(id, overrides = {}) {
  return { id, subject: `task ${id}`, ...overrides }
}

test('single stage adds no barriers', () => {
  const input = [task('a', { stage: 's1' }), task('b', { stage: 's1' })]
  const output = applyStageBarriers(input)
  assert.equal(output, input)
})

test('next stage depends on every previous stage task (parallel within stage)', () => {
  const input = [
    task('a', { stage: 's1' }),
    task('b', { stage: 's1' }),
    task('c', { stage: 's2' }),
    task('d', { stage: 's2' }),
  ]
  const output = applyStageBarriers(input)
  const c = output.find((item) => item.id === 'c')
  const d = output.find((item) => item.id === 'd')
  assert.deepEqual([...c.dependencies].sort(), ['a', 'b'])
  assert.deepEqual([...d.dependencies].sort(), ['a', 'b'])
  // stage 1 tasks keep no injected dependencies
  const a = output.find((item) => item.id === 'a')
  assert.equal(a.dependencies === undefined || a.dependencies.length === 0, true)
})

test('explicit dependencies merge with stage barriers, deduplicated', () => {
  const input = [
    task('a', { stage: 's1' }),
    task('b', { stage: 's2', dependencies: ['a'] }),
    task('c', { stage: 's2', dependencies: ['b'] }),
  ]
  const output = applyStageBarriers(input)
  assert.deepEqual([...output.find((item) => item.id === 'b').dependencies].sort(), ['a'])
  assert.deepEqual([...output.find((item) => item.id === 'c').dependencies].sort(), ['a', 'b'])
})

test('stage-less tasks are never gated', () => {
  const input = [
    task('plain'),
    task('a', { stage: 's1' }),
    task('b', { stage: 's2' }),
  ]
  const output = applyStageBarriers(input)
  assert.equal(output.find((item) => item.id === 'plain').dependencies === undefined, true)
  assert.deepEqual(output.find((item) => item.id === 'b').dependencies, ['a'])
})

test('three stages chain sequentially', () => {
  const input = [
    task('a', { stage: 's1' }),
    task('b', { stage: 's2' }),
    task('c', { stage: 's3' }),
  ]
  const output = applyStageBarriers(input)
  assert.deepEqual(output.find((item) => item.id === 'b').dependencies, ['a'])
  assert.deepEqual(output.find((item) => item.id === 'c').dependencies, ['b'])
})

function sampleTeam(overrides = {}) {
  return {
    name: 'team',
    id: 'team-1',
    captainSessionId: 's1',
    createdAt: 1000,
    members: [{ id: 'm1', name: 'worker', status: 'idle', joinedAt: 1000 }],
    tasks: [
      {
        id: 't1', subject: 'spec', status: 'completed', dependencies: [], attempt: 1,
        createdAt: 1000, updatedAt: 1000, kind: 'requirements', stage: 's1',
        evidence: [{ id: 'e1' }],
        artifacts: [{ artifactId: 'art-1', kind: 'requirements', uri: 'u', sha256: 's', summary: 'x' }],
      },
      { id: 't2', subject: 'impl', status: 'pending', dependencies: ['t1'], attempt: 0, createdAt: 1000, updatedAt: 1000, kind: 'implementation' },
    ],
    taskSeq: 2,
    ...overrides,
  }
}

test('manifest summarizes the run contract', () => {
  const m = buildTeamManifest(sampleTeam(), {
    archivedAt: 2000,
    telemetryAttempts: 3,
    telemetryCostUsd: 0.42,
    memoryEntries: 5,
    auditEvents: 12,
  })
  assert.equal(m.schemaVersion, 1)
  assert.equal(m.teamId, 'team-1')
  assert.equal(m.archivedAt, 2000)
  assert.equal(m.tasks.length, 2)
  assert.equal(m.tasks[0].stage, 's1')
  assert.deepEqual(m.tasks[0].artifactIds, ['art-1'])
  assert.equal(m.tasks[0].evidenceCount, 1)
  assert.equal(m.artifacts, 1)
  assert.equal(m.telemetryAttempts, 3)
  assert.equal(m.telemetryCostUsd, 0.42)
  assert.equal(m.memoryEntries, 5)
  assert.equal(m.auditEvents, 12)
})
