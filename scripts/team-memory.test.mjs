/**
 * Unit tests for the team-memory module: typed memory entries, keyword
 * retrieval, TTL/supersedes governance, JSONL persistence, and atomic
 * rewrite.
 *
 * Runs against the TypeScript sources directly (Node >= 22.18 type
 * stripping) or the built `lib` in environments without stripping.
 * @module dsh-agent-teams/team-memory.test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let mod
try {
  mod = await import('../src/team-memory.ts')
} catch {
  mod = await import('../lib/team-memory.js')
}

const {
  TEAM_MEMORY_FILE,
  appendMemoryEntry,
  applySupersedes,
  createMemoryEntry,
  expireMemory,
  pruneMemory,
  readMemoryEntries,
  rewriteMemoryEntries,
  searchMemory,
} = mod

/** Convenience builder for a plain MemoryEntry-shaped record. */
function makeEntry(overrides = {}) {
  return {
    id: 'mem-1',
    ts: 1000,
    scope: 'team',
    content: 'default content',
    status: 'active',
    ...overrides,
  }
}

/** Fresh temp state root, removed when the test finishes. */
async function tempStateRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'agent-teams-mem-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

// ---------------------------------------------------------------------------
// createMemoryEntry
// ---------------------------------------------------------------------------

test('createMemoryEntry fills defaults (id, ts, status) and carries explicit fields', () => {
  const generated = createMemoryEntry({ scope: 'decision', content: 'use sqlite' })
  assert.match(generated.id, /^mem-\d+[0-9a-f]{6}$/)
  assert.equal(typeof generated.ts, 'number')
  assert.equal(generated.status, 'active')
  assert.equal(generated.scope, 'decision')
  assert.equal(generated.content, 'use sqlite')

  const fixed = createMemoryEntry({
    scope: 'task', content: 'finish schema', id: 'mem-fixed', ts: 42, status: 'inactive',
    source: 'human', confidence: 0.8, expiresAt: 999, supersedes: 'mem-old',
    relatedTaskIds: ['t1', 't2'],
  })
  assert.deepEqual(fixed, {
    id: 'mem-fixed', ts: 42, scope: 'task', content: 'finish schema',
    source: 'human', confidence: 0.8, expiresAt: 999, supersedes: 'mem-old',
    relatedTaskIds: ['t1', 't2'], status: 'inactive',
  })

  const timestamped = createMemoryEntry({ scope: 'team', content: 'x', ts: 1_700_000_000_000 })
  assert.match(timestamped.id, /^mem-1700000000000[0-9a-f]{6}$/)
})

test('createMemoryEntry rejects an illegal scope', () => {
  assert.throws(() => createMemoryEntry({ scope: 'gossip', content: 'x' }), /invalid memory scope/)
})

test('createMemoryEntry validates confidence within 0..1', () => {
  for (const bad of [-0.01, 1.01, NaN, Infinity, '0.5']) {
    assert.throws(
      () => createMemoryEntry({ scope: 'team', content: 'x', confidence: bad }),
      /confidence/,
      `expected throw for confidence ${String(bad)}`,
    )
  }
  for (const good of [0, 1, 0.5]) {
    assert.equal(createMemoryEntry({ scope: 'team', content: 'x', confidence: good }).confidence, good)
  }
})

// ---------------------------------------------------------------------------
// searchMemory
// ---------------------------------------------------------------------------

test('searchMemory filters by scope, active status, and case-insensitive text', () => {
  const entries = [
    makeEntry({ id: 'a', ts: 1, scope: 'project', content: 'Use TypeScript everywhere' }),
    makeEntry({ id: 'b', ts: 2, scope: 'team', content: 'Standup at 10am' }),
    makeEntry({ id: 'c', ts: 3, scope: 'decision', content: 'TypeSystem: strict mode', status: 'inactive' }),
    makeEntry({ id: 'd', ts: 4, scope: 'team', content: 'Typescript builds on CI' }),
  ]

  // No filters: everything active, ordered by ts descending (default limit 20);
  // the inactive 'c' stays hidden.
  assert.deepEqual(searchMemory(entries, {}).map((e) => e.id), ['d', 'b', 'a'])

  // Scope filter.
  assert.deepEqual(searchMemory(entries, { scopes: ['team'] }).map((e) => e.id), ['d', 'b'])

  // Text filter, case-insensitive.
  assert.deepEqual(searchMemory(entries, { text: 'typescript' }).map((e) => e.id), ['d', 'a'])

  // Scope + text combined; inactive stays hidden unless included.
  assert.deepEqual(searchMemory(entries, { scopes: ['team'], text: 'TYPE' }).map((e) => e.id), ['d'])
  assert.deepEqual(
    searchMemory(entries, { text: 'type', includeInactive: true }).map((e) => e.id),
    ['d', 'c', 'a'],
  )
})

test('searchMemory caps results at limit with newest first', () => {
  const entries = Array.from({ length: 25 }, (_, i) => makeEntry({ id: `mem-${i}`, ts: i }))
  const top = searchMemory(entries, {})
  assert.equal(top.length, 20)
  assert.equal(top[0].id, 'mem-24')
  assert.equal(top[19].id, 'mem-5')
  assert.equal(searchMemory(entries, { limit: 5 }).length, 5)
  assert.equal(searchMemory(entries, { limit: 0 }).length, 0)
})

// ---------------------------------------------------------------------------
// expireMemory / applySupersedes / pruneMemory
// ---------------------------------------------------------------------------

test('expireMemory marks expired entries inactive without mutating the input', () => {
  const entries = [
    makeEntry({ id: 'fresh', ts: 1, expiresAt: 500 }),
    makeEntry({ id: 'expired', ts: 2, expiresAt: 100 }),
    makeEntry({ id: 'never', ts: 3 }),
  ]
  const result = expireMemory(entries, 100)
  assert.equal(result[0].status, 'active')
  assert.equal(result[1].status, 'inactive')
  assert.equal(result[2].status, 'active')
  assert.equal(entries[1].status, 'active', 'input must not be mutated')
  assert.notEqual(result[1], entries[1], 'changed entry must be a copy')
  assert.equal(result[0], entries[0], 'unchanged entry keeps identity')

  // Boundary: expiresAt <= now expires; expiresAt > now stays.
  assert.equal(expireMemory([makeEntry({ id: 'x', expiresAt: 100 })], 100)[0].status, 'inactive')
  assert.equal(expireMemory([makeEntry({ id: 'y', expiresAt: 101 })], 100)[0].status, 'active')
})

test('applySupersedes deactivates same-scope superseded entries only', () => {
  const entries = [
    makeEntry({ id: 'v1', ts: 1, scope: 'decision', content: 'old' }),
    makeEntry({ id: 'v2', ts: 2, scope: 'decision', content: 'new', supersedes: 'v1' }),
    makeEntry({ id: 'v3', ts: 3, scope: 'decision', content: 'newer', supersedes: 'v2' }),
    makeEntry({ id: 'note', ts: 4, scope: 'team', content: 'note about v1', supersedes: 'v1' }),
  ]
  const result = applySupersedes(entries)
  const statusById = Object.fromEntries(result.map((e) => [e.id, e.status]))
  assert.equal(statusById['v1'], 'inactive')
  assert.equal(statusById['v2'], 'inactive')
  assert.equal(statusById['v3'], 'active')
  assert.equal(statusById['note'], 'active')
  assert.equal(entries[0].status, 'active', 'input must not be mutated')

  // Cross-scope supersede does not deactivate the target.
  const crossScope = applySupersedes([
    makeEntry({ id: 'w1', ts: 1, scope: 'decision', content: 'old' }),
    makeEntry({ id: 'w2', ts: 2, scope: 'team', content: 'note', supersedes: 'w1' }),
  ])
  assert.equal(crossScope[0].status, 'active')

  // Unknown target id is a no-op.
  const ghost = applySupersedes([makeEntry({ id: 'a' }), makeEntry({ id: 'b', supersedes: 'ghost' })])
  assert.deepEqual(ghost.map((e) => e.status), ['active', 'active'])
})

test('pruneMemory expires, supersedes, and bounds the inactive tail', () => {
  const entries = [
    makeEntry({ id: 'old', ts: 1, scope: 'decision', content: 'old', expiresAt: 50 }),
    makeEntry({ id: 'su', ts: 2, scope: 'decision', content: 'new', supersedes: 'old' }),
    makeEntry({ id: 'stale-1', ts: 30, status: 'inactive', content: 'stale oldest' }),
    makeEntry({ id: 'stale-2', ts: 40, status: 'inactive', content: 'stale newer' }),
    makeEntry({ id: 'keep-1', ts: 10, content: 'keep oldest active' }),
    makeEntry({ id: 'keep-2', ts: 20, content: 'keep newest active' }),
  ]
  // now=100 expires 'old' (expiresAt 50); 'old' also is superseded by 'su'.
  // actives: su, keep-1, keep-2 (input order); inactives by ts desc:
  // stale-2 (40), stale-1 (30), old (1) -> keep only the newest with keepInactive=1.
  assert.deepEqual(pruneMemory(entries, 100, 1).map((e) => e.id), ['su', 'keep-1', 'keep-2', 'stale-2'])
  // Default keepInactive retains all inactive entries.
  assert.deepEqual(pruneMemory(entries, 100).map((e) => e.id), ['su', 'keep-1', 'keep-2', 'stale-2', 'stale-1', 'old'])
  // keepInactive=0 drops every inactive entry.
  assert.deepEqual(pruneMemory(entries, 100, 0).map((e) => e.id), ['su', 'keep-1', 'keep-2'])
  // Input untouched.
  assert.equal(entries[0].status, 'active')
  assert.equal(entries[2].status, 'inactive')
})

// ---------------------------------------------------------------------------
// JSONL persistence
// ---------------------------------------------------------------------------

test('appendMemoryEntry -> readMemoryEntries round-trips entries', async (t) => {
  const root = await tempStateRoot(t)
  await appendMemoryEntry(root, 'team-a', createMemoryEntry({
    scope: 'project', content: 'repo uses pnpm', source: 'human', confidence: 0.9,
  }))
  await appendMemoryEntry(root, 'team-a', createMemoryEntry({
    scope: 'decision', content: 'adopt sqlite', supersedes: 'mem-0',
    relatedTaskIds: ['t1', 't2'], expiresAt: 12_345, status: 'inactive',
  }))
  const entries = await readMemoryEntries(root, 'team-a')
  assert.equal(entries.length, 2)
  assert.equal(entries[0].scope, 'project')
  assert.equal(entries[0].content, 'repo uses pnpm')
  assert.equal(entries[0].source, 'human')
  assert.equal(entries[0].confidence, 0.9)
  assert.equal(entries[1].supersedes, 'mem-0')
  assert.deepEqual(entries[1].relatedTaskIds, ['t1', 't2'])
  assert.equal(entries[1].expiresAt, 12_345)
  assert.equal(entries[1].status, 'inactive')
})

test('appendMemoryEntry creates the team directory when missing', async (t) => {
  const root = await tempStateRoot(t)
  const entry = createMemoryEntry({ scope: 'team', content: 'hello' })
  await appendMemoryEntry(root, 'brand-new-team', entry)
  assert.equal((await readMemoryEntries(root, 'brand-new-team')).length, 1)
  const raw = await readFile(join(root, 'brand-new-team', TEAM_MEMORY_FILE), 'utf8')
  assert.equal(raw, `${JSON.stringify(entry)}\n`)
})

test('readMemoryEntries returns [] for a missing team or file', async (t) => {
  const root = await tempStateRoot(t)
  assert.deepEqual(await readMemoryEntries(root, 'nobody'), [])
  await mkdir(join(root, 'empty-team'), { recursive: true })
  assert.deepEqual(await readMemoryEntries(root, 'empty-team'), [])
})

test('readMemoryEntries skips torn tail, bad JSON, non-object, and invalid rows', async (t) => {
  const root = await tempStateRoot(t)
  const dir = join(root, 'team-x')
  await mkdir(dir, { recursive: true })
  const good1 = `${JSON.stringify(makeEntry({ id: 'good-1', ts: 1, content: 'fine' }))}\n`
  const good2 = `${JSON.stringify(makeEntry({ id: 'good-2', ts: 2, scope: 'decision', content: 'also fine' }))}\n`
  await writeFile(join(dir, TEAM_MEMORY_FILE), [
    good1,
    '{"id":"torn","partial":',         // torn line: JSON.parse fails
    'not json at all',                 // bad line
    '[1,2,3]',                         // array, not an object entry
    '"just a string"',                 // not an object
    '{"id":42,"ts":1,"scope":"team","content":"bad id"}',       // id not a string
    '{"id":"no-ts","scope":"team","content":"missing ts"}',     // ts missing
    '{"id":"no-content","ts":1,"scope":"team","status":"active"}', // content missing
    '{"id":"bad-scope","ts":1,"scope":"gossip","content":"x"}', // illegal scope
    good2,
  ].join('\n'), 'utf8')
  assert.deepEqual(
    (await readMemoryEntries(root, 'team-x')).map((e) => e.id),
    ['good-1', 'good-2'],
  )
})

test('rewriteMemoryEntries atomically replaces the file and reads back consistently', async (t) => {
  const root = await tempStateRoot(t)
  await appendMemoryEntry(root, 'team-r', makeEntry({ id: 'a', ts: 1, content: 'first' }))
  await appendMemoryEntry(root, 'team-r', makeEntry({ id: 'b', ts: 2, content: 'second' }))
  const rewritten = [
    makeEntry({ id: 'a', ts: 1, content: 'first' }),
    makeEntry({ id: 'c', ts: 3, content: 'third', status: 'inactive' }),
  ]
  await rewriteMemoryEntries(root, 'team-r', rewritten)
  assert.deepEqual(await readMemoryEntries(root, 'team-r'), rewritten)
  // Only the target file remains: no temp-file litter.
  assert.deepEqual(await readdir(join(root, 'team-r')), [TEAM_MEMORY_FILE])
  // Rewriting over a team without an existing file also works.
  await rewriteMemoryEntries(root, 'team-fresh', [makeEntry({ id: 'z', ts: 9, content: 'new' })])
  assert.deepEqual((await readMemoryEntries(root, 'team-fresh')).map((e) => e.id), ['z'])
})
