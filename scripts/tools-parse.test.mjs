/**
 * Unit tests for the extracted tool parsers (src/tools-parse.ts).
 *
 * @module dsh-agent-teams/tools-parse.test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

let mod
try {
  mod = await import('../src/tools-parse.ts')
} catch {
  mod = await import('../lib/tools-parse.js')
}

const { parseFindings, parseAcceptanceResults, parseCommandResults, buildCommandEvidence } = mod

test('parseAcceptanceResults validates and normalizes', () => {
  const parsed = parseAcceptanceResults([
    { criterion: 'tests pass', status: 'passed', evidence: 'ci log' },
    { criterion: 'lint', status: 'failed' },
  ])
  assert.equal(parsed.length, 2)
  assert.deepEqual(parsed[0], { criterion: 'tests pass', status: 'passed', evidence: 'ci log' })
  assert.deepEqual(parsed[1], { criterion: 'lint', status: 'failed' })
  assert.equal(parseAcceptanceResults(undefined), undefined)
  assert.throws(() => parseAcceptanceResults([{ criterion: 'x', status: 'maybe' }]), /passed or failed/)
  assert.throws(() => parseAcceptanceResults('nope'), /must be an array/)
})

test('parseCommandResults keeps declared fields but rejects illegal status', () => {
  const parsed = parseCommandResults([{ command: 'pnpm test', status: 'passed', exitCode: 0 }])
  assert.deepEqual(parsed[0], { command: 'pnpm test', status: 'passed', exitCode: 0 })
  assert.throws(() => parseCommandResults([{ command: 'x', status: 'unknown' }]), /passed or failed/)
  assert.throws(() => parseCommandResults([{ status: 'passed' }]), /command is required/)
})

test('parseFindings requires id/severity/problem/requiredFix', () => {
  const parsed = parseFindings([{ id: 'SEC-1', severity: 'blocker', problem: 'x', requiredFix: 'y' }])
  assert.deepEqual(parsed[0], { id: 'SEC-1', severity: 'blocker', problem: 'x', requiredFix: 'y' })
  assert.throws(() => parseFindings([{ id: 'x', severity: 'severe', problem: 'p', requiredFix: 'r' }]), /invalid/)
  assert.throws(() => parseFindings([{ id: 'x', severity: 'low', problem: 'p' }]), /requiredFix/)
  // Blank optional file is omitted instead of persisted.
  const withBlank = parseFindings([{ id: 'x', severity: 'low', problem: 'p', requiredFix: 'r', file: '  ' }])
  assert.equal('file' in withBlank[0], false)
})

test('buildCommandEvidence assigns stable ids and attempt binding', () => {
  const records = buildCommandEvidence('team-x', 't9', 'att-7', [
    { command: 'pnpm test', status: 'passed' },
    { command: 'pnpm lint', status: 'failed', exitCode: 2 },
  ])
  assert.equal(records[0].id, 'ev:cmd:t9:0')
  assert.equal(records[0].attemptId, 'att-7')
  assert.equal(records[1].id, 'ev:cmd:t9:1')
  assert.equal(records[1].detail.exitCode, 2)
  assert.equal(records[1].detail.status, 'failed')
})
