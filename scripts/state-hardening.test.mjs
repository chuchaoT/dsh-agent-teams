/**
 * Unit tests for the state-hardening pass: durable event log, revision
 * compare-and-swap, and the cross-process advisory lock.
 *
 * Runs against the TypeScript sources directly (Node >= 22.18 type
 * stripping) or the built `lib` in environments without stripping.
 * @module dsh-agent-teams/state-hardening.test
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

const {
  appendTeamEventLog,
  readTeamEventLog,
  readTeam,
  writeTeam,
  withCrossProcessLock,
  TeamConcurrencyError,
} = mod

/** Fresh temp state root per test. */
async function tempStateRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'agent-teams-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

/** Minimal valid team record (real paths would need full state; tests use the event log + CAS surfaces). */
function sampleTeam(stateRoot, id, name = 'team') {
  return {
    name,
    id,
    captainSessionId: 'sess-1',
    createdAt: Date.now(),
    members: [],
    tasks: [],
    taskSeq: 0,
  }
}

test('event log is append-only and survives re-read', async (t) => {
  const root = await tempStateRoot(t)
  await mkdir(join(root, 't1'), { recursive: true })
  await appendTeamEventLog(root, 't1', 'agent-teams/task-updated', { taskId: 't1' })
  await appendTeamEventLog(root, 't1', 'agent-teams/message-sent', { messageId: 'm1' })
  const entries = await readTeamEventLog(root, 't1')
  assert.equal(entries.length, 2)
  assert.equal(entries[0].type, 'agent-teams/task-updated')
  assert.equal(entries[1].type, 'agent-teams/message-sent')
  assert.equal(entries[1].teamId, 't1')
  assert.ok(typeof entries[0].id === 'string' && entries[0].id.length > 0)
})

test('event log tolerates a trailing partial line', async (t) => {
  const root = await tempStateRoot(t)
  await mkdir(join(root, 't1'), { recursive: true })
  await appendTeamEventLog(root, 't1', 'agent-teams/task-created', {})
  await writeFile(join(root, 't1', 'events.jsonl'), '{"broken":\n', { flag: 'a' })
  const entries = await readTeamEventLog(root, 't1')
  assert.equal(entries.length, 1)
  assert.equal(entries[0].type, 'agent-teams/task-created')
})

test('writeTeam stamps monotonic revisions', async (t) => {
  const root = await tempStateRoot(t)
  await mkdir(join(root, 't1', 'inbox'), { recursive: true })
  const first = sampleTeam(root, 't1')
  await mod.createTeamDir(root, first)
  const read1 = await readTeam(root, 't1')
  assert.equal(read1.revision, 1)
  read1.members.push({ id: 'm1', name: 'worker', joinedAt: Date.now(), status: 'idle' })
  await writeTeam(root, read1)
  const read2 = await readTeam(root, 't1')
  assert.equal(read2.revision, 2)
  assert.equal(read2.members.length, 1)
})

test('writeTeam refuses to overwrite a concurrently advanced revision', async (t) => {
  const root = await tempStateRoot(t)
  await mkdir(join(root, 't1', 'inbox'), { recursive: true })
  await mod.createTeamDir(root, sampleTeam(root, 't1'))
  const mine = await readTeam(root, 't1')
  // Another process bumps the file behind our back.
  const theirs = await readTeam(root, 't1')
  theirs.members.push({ id: 'other', name: 'other', joinedAt: Date.now(), status: 'idle' })
  await writeTeam(root, theirs)

  mine.name = 'stale write'
  await assert.rejects(() => writeTeam(root, mine), (error) => {
    assert.equal(error instanceof TeamConcurrencyError, true)
    assert.equal(error.expectedRevision, 1)
    assert.equal(error.actualRevision, 2)
    return true
  })
})

test('cross-process lock serializes concurrent holders', async (t) => {
  const root = await tempStateRoot(t)
  const order = []
  const first = withCrossProcessLock(root, 'team-x', async () => {
    order.push('first-start')
    await new Promise((resolve) => setTimeout(resolve, 80))
    order.push('first-end')
  })
  const second = withCrossProcessLock(root, 'team-x', async () => {
    order.push('second-start')
    order.push('second-end')
  })
  await Promise.all([first, second])
  assert.deepEqual(order, ['first-start', 'first-end', 'second-start', 'second-end'])
})

test('cross-process lock reclaims stale lock files', async (t) => {
  const root = await tempStateRoot(t)
  await mkdir(join(root, '.locks'), { recursive: true })
  // A lock file that looks abandoned (mtime older than the stale window).
  await writeFile(join(root, '.locks', 'team-y.lock'), JSON.stringify({ pid: 1, ts: 0 }))
  const past = new Date(Date.now() - 60_000)
  await import('node:fs/promises').then(({ utimes }) => utimes(join(root, '.locks', 'team-y.lock'), past, past))
  let entered = false
  await withCrossProcessLock(root, 'team-y', async () => { entered = true })
  assert.equal(entered, true)
})
