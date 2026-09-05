/**
 * Unit tests for the typed-artifact module: hashing, record computation,
 * ref creation, file blueprints, and the filesystem storage layer
 * (atomic write/read/delete/list with corruption handling).
 *
 * Runs against the TypeScript sources directly (Node >= 22.18 type
 * stripping) or the built `lib` in environments without stripping.
 * @module dsh-agent-teams/artifacts.test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

let mod
try {
  mod = await import('../src/artifacts.ts')
} catch {
  mod = await import('../lib/artifacts.js')
}

const {
  hashArtifactSha256,
  computeArtifactRecord,
  createArtifactRef,
  artifactFileBlueprint,
  writeArtifactFile,
  readArtifactFile,
  deleteArtifactFile,
  listArtifactIds,
} = mod

/** Convenience builder for a new-artifact input. */
function newInput(overrides = {}) {
  return {
    teamId: 'team-alpha',
    taskId: 'task-1',
    attemptId: 'attempt-1',
    kind: 'code_diff',
    schema: 'https://example.com/schemas/code_diff.v1.json',
    contentType: 'application/json',
    content: 'diff --git a/index.ts b/index.ts\n+console.log(1)\n',
    summary: 'added a single log line',
    producer: 'member',
    sourceTaskId: 'task-0',
    ...overrides,
  }
}

/** Create a temp state root and schedule cleanup. */
async function makeTempStateRoot(t) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-teams-artifacts-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('hashArtifactSha256 is the standard SHA-256 hex digest and deterministic', () => {
  assert.equal(
    hashArtifactSha256('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  )
  assert.equal(
    hashArtifactSha256(''),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  )
  assert.match(hashArtifactSha256('stdout'), /^[0-9a-f]{64}$/)
  assert.equal(hashArtifactSha256('repeat-me'), hashArtifactSha256('repeat-me'))
  // Multi-byte content hashes its UTF-8 bytes.
  assert.equal(hashArtifactSha256('你好'), hashArtifactSha256('你好'))
})

test('computeArtifactRecord fills uri/sizeBytes/contentType/producer/kind and keeps inputs', () => {
  const input = newInput({ content: '你好，artifacts 🚀' })
  const record = computeArtifactRecord(input)
  assert.equal(record.uri, `.agent-teams/${input.teamId}/artifacts/${record.id}.json`)
  assert.equal(record.sizeBytes, Buffer.byteLength(input.content, 'utf8'))
  assert.ok(record.sizeBytes > input.content.length, 'multi-byte content must count bytes, not chars')
  assert.equal(record.contentType, 'application/json')
  assert.equal(record.producer, 'member')
  assert.equal(record.kind, 'code_diff')
  assert.equal(record.teamId, input.teamId)
  assert.equal(record.taskId, input.taskId)
  assert.equal(record.attemptId, 'attempt-1')
  assert.equal(record.schema, input.schema)
  assert.equal(record.sourceTaskId, 'task-0')
  assert.equal(record.summary, input.summary)
  assert.equal(record.sha256, hashArtifactSha256(input.content))
  assert.equal(typeof record.ts, 'number')
  assert.ok(record.ts > 0)
  assert.match(record.sha256, /^[0-9a-f]{64}$/)
})

test('computeArtifactRecord omits optional fields when not provided', () => {
  const record = computeArtifactRecord(newInput({ attemptId: undefined, schema: undefined, sourceTaskId: undefined }))
  assert.equal('attemptId' in record, false)
  assert.equal('schema' in record, false)
  assert.equal('sourceTaskId' in record, false)
})

test('computeArtifactRecord default id has the expected shape and is unique', () => {
  const a = computeArtifactRecord(newInput())
  const b = computeArtifactRecord(newInput())
  assert.match(a.id, /^art-\d+-[0-9a-f]{6}$/)
  assert.notEqual(a.id, b.id)
  // Explicit id wins.
  const c = computeArtifactRecord(newInput(), 'art-fixed')
  assert.equal(c.id, 'art-fixed')
  assert.equal(c.uri, '.agent-teams/team-alpha/artifacts/art-fixed.json')
})

test('createArtifactRef slices the ref fields from the record', () => {
  const record = computeArtifactRecord(newInput())
  const ref = createArtifactRef(record, record.taskId)
  assert.deepEqual(ref, {
    artifactId: record.id,
    kind: record.kind,
    schema: record.schema,
    uri: record.uri,
    sha256: record.sha256,
    summary: record.summary,
  })
  assert.equal('content' in ref, false)
})

test('createArtifactRef omits schema when the record has none and rejects a foreign task', () => {
  const record = computeArtifactRecord(newInput({ schema: undefined }))
  const ref = createArtifactRef(record, record.taskId)
  assert.equal('schema' in ref, false)
  assert.throws(() => createArtifactRef(record, 'task-other'), /does not match record\.taskId/)
})

test('artifactFileBlueprint follows the .agent-teams layout', () => {
  assert.deepEqual(artifactFileBlueprint('team-alpha', 'art-123-abcdef'), {
    fileName: 'art-123-abcdef.json',
    relativePath: '.agent-teams/team-alpha/artifacts/art-123-abcdef.json',
  })
})

test('writeArtifactFile → readArtifactFile round-trips record and content', async (t) => {
  const root = await makeTempStateRoot(t)
  const input = newInput()
  const record = computeArtifactRecord(input)
  const absolute = await writeArtifactFile(root, record, input.content)
  assert.ok(isAbsolute(absolute), 'writeArtifactFile must return an absolute path')
  // stateRoot is the resolved <workspace>/<stateDir> root, so the artifact
  // lands directly under <stateRoot>/<teamId>/artifacts/ (no stateDir prefix).
  assert.ok(absolute.replace(/\\/g, '/').endsWith(`${record.teamId}/artifacts/${record.id}.json`))

  const got = await readArtifactFile(root, record.teamId, record.id)
  assert.ok(got, 'readArtifactFile must return the written artifact')
  assert.deepEqual(got.record, record)
  assert.equal(got.content, input.content)
  assert.ok((await listArtifactIds(root, record.teamId)).includes(record.id))
})

test('readArtifactFile returns undefined for a missing artifact', async (t) => {
  const root = await makeTempStateRoot(t)
  assert.equal(await readArtifactFile(root, 'team-alpha', 'art-nope-000000'), undefined)
})

test('deleteArtifactFile removes the file and is idempotent', async (t) => {
  const root = await makeTempStateRoot(t)
  const input = newInput()
  const record = computeArtifactRecord(input)
  await writeArtifactFile(root, record, input.content)
  const before = await readArtifactFile(root, record.teamId, record.id)
  assert.ok(before)

  await deleteArtifactFile(root, record.teamId, record.id)
  assert.equal(await readArtifactFile(root, record.teamId, record.id), undefined)
  await deleteArtifactFile(root, record.teamId, record.id) // force: must not throw
  assert.equal(await readArtifactFile(root, record.teamId, record.id), undefined)
})

test('listArtifactIds: missing dir is [], dotfiles are ignored, ids are stripped of .json', async (t) => {
  const root = await makeTempStateRoot(t)
  assert.deepEqual(await listArtifactIds(root, 'team-alpha'), [])

  const dir = join(root, 'team-alpha', 'artifacts')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, '.keep'), 'hidden marker')
  await writeFile(join(dir, '.art-0.tmp'), 'partial write')
  await writeFile(join(dir, 'art-1.json'), '{}')
  await writeFile(join(dir, 'art-2.json'), '{}')
  await writeFile(join(dir, 'README.md'), 'not an artifact')
  assert.deepEqual(await listArtifactIds(root, 'team-alpha'), ['art-1', 'art-2'])
})

test('readArtifactFile throws for corrupt files (missing fields or invalid JSON)', async (t) => {
  const root = await makeTempStateRoot(t)
  const dir = join(root, 'team-alpha', 'artifacts')
  await mkdir(dir, { recursive: true })

  const missingRecord = join(dir, 'art-broken-record.json')
  await writeFile(missingRecord, JSON.stringify({ content: 'no record here' }))
  await assert.rejects(
    readArtifactFile(root, 'team-alpha', 'art-broken-record'),
    /corrupt artifact art-broken-record/,
  )

  const missingContent = join(dir, 'art-broken-content.json')
  await writeFile(missingContent, JSON.stringify({ record: { id: 'x' } }))
  await assert.rejects(
    readArtifactFile(root, 'team-alpha', 'art-broken-content'),
    /corrupt artifact art-broken-content/,
  )

  const badJson = join(dir, 'art-broken-json.json')
  await writeFile(badJson, 'definitely not json')
  await assert.rejects(
    readArtifactFile(root, 'team-alpha', 'art-broken-json'),
    /corrupt artifact art-broken-json/,
  )
})

test('readArtifactFile still reads a sibling artifact after another was deleted', async (t) => {
  const root = await makeTempStateRoot(t)
  const a = computeArtifactRecord(newInput({ taskId: 'task-a' }), 'art-a')
  const b = computeArtifactRecord(newInput({ taskId: 'task-b', content: 'other content' }), 'art-b')
  await writeArtifactFile(root, a, 'content-a')
  await writeArtifactFile(root, b, 'content-b')
  await deleteArtifactFile(root, a.teamId, a.id)
  const got = await readArtifactFile(root, b.teamId, b.id)
  assert.ok(got)
  assert.equal(got.content, 'content-b')
  assert.equal(got.record.id, 'art-b')
})
