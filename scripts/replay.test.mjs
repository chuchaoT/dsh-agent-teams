/**
 * Unit tests for the archive replay verification.
 *
 * @module dsh-agent-teams/replay.test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let mod
try {
  mod = await import('../src/replay.ts')
} catch {
  mod = await import('../lib/replay.js')
}

const { verifyArchivedRun } = mod

async function tempArchive(t, extraFiles = []) {
  const root = await mkdtemp(join(tmpdir(), 'agent-teams-archive-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const dir = join(root, 'team-1')
  await mkdir(join(dir, 'artifacts'), { recursive: true })
  await writeFile(join(dir, 'team.json'), JSON.stringify({ id: 'team-1', name: 'team', tasks: [] }))
  await writeFile(join(dir, 'events.jsonl'), '{}\n')
  for (const file of extraFiles) await writeFile(join(dir, file[0]), file[1])
  return { root, dir }
}

function manifestBody(overrides = {}) {
  return {
    schemaVersion: 1,
    teamId: 'team-1',
    name: 'team',
    captainSessionId: 's1',
    createdAt: 1000,
    archivedAt: 2000,
    members: [],
    tasks: [],
    telemetryAttempts: 0,
    telemetryCostUsd: 0,
    artifacts: 0,
    memoryEntries: 0,
    auditEvents: 1,
    ...overrides,
  }
}

test('a complete bundle verifies ok', async (t) => {
  const { root } = await tempArchive(t, [
    ['manifest.json', JSON.stringify(manifestBody())],
  ])
  const result = await verifyArchivedRun(root, 'team-1')
  assert.equal(result.ok, true)
  assert.equal(result.issues.length, 0)
  assert.equal(result.manifest.teamId, 'team-1')
})

test('missing artifact files are reported per task', async (t) => {
  const { root } = await tempArchive(t, [
    ['manifest.json', JSON.stringify(manifestBody({
      tasks: [{ id: 't1', subject: 'x', status: 'completed', attempt: 1, evidenceCount: 0, artifactIds: ['art-1', 'art-2'] }],
      artifacts: 2,
    }))],
    ['artifacts/art-1.json', '{"record":{}}'],
  ])
  const result = await verifyArchivedRun(root, 'team-1')
  assert.equal(result.ok, false)
  const missing = result.issues.filter((issue) => issue.code === 'missing-artifact')
  assert.equal(missing.length, 1)
  assert.match(missing[0].detail, /art-2/)
})

test('manifest/team id mismatch is reported', async (t) => {
  const { root } = await tempArchive(t, [
    ['manifest.json', JSON.stringify(manifestBody({ teamId: 'other' }))],
  ])
  const result = await verifyArchivedRun(root, 'team-1')
  assert.equal(result.ok, false)
  assert.ok(result.issues.some((issue) => issue.code === 'team-id-mismatch'))
})

test('missing manifest is reported (pre-hardening bundle)', async (t) => {
  const { root } = await tempArchive(t)
  const result = await verifyArchivedRun(root, 'team-1')
  assert.equal(result.ok, false)
  assert.ok(result.issues.some((issue) => issue.code === 'missing-manifest'))
})

test('corrupt manifest is reported', async (t) => {
  const { root } = await tempArchive(t, [
    ['manifest.json', '{not json'],
  ])
  const result = await verifyArchivedRun(root, 'team-1')
  assert.equal(result.ok, false)
  assert.ok(result.issues.some((issue) => issue.code === 'bad-manifest'))
})
