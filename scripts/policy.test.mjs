/**
 * Unit tests for the capability-matrix policy layer.
 *
 * @module dsh-agent-teams/policy.test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

let mod
try {
  mod = await import('../src/policy.ts')
} catch {
  mod = await import('../lib/policy.js')
}

const {
  DEFAULT_CAPABILITY_MATRIX,
  FULL_CAPABILITIES,
  REVIEW_CAPABILITIES,
  RESEARCH_CAPABILITIES,
  effectiveCapabilities,
  resolveToolDenials,
  toolClassOf,
  validateCapabilityMatrix,
} = mod

test('tool classes classify known and prefixed tools', () => {
  assert.equal(toolClassOf('read_file'), 'read')
  assert.equal(toolClassOf('edit'), 'write')
  assert.equal(toolClassOf('bash'), 'execute')
  assert.equal(toolClassOf('web_search'), 'network')
  assert.equal(toolClassOf('browser_click'), 'network')
  assert.equal(toolClassOf('grep'), 'read')
  assert.equal(toolClassOf('something-unknown'), undefined)
})

test('reviewer capabilities deny write and network tools but allow read/execute', () => {
  const denials = resolveToolDenials(REVIEW_CAPABILITIES)
  assert.ok(denials.includes('edit'))
  assert.ok(denials.includes('write'))
  assert.ok(denials.includes('web_fetch'))
  assert.ok(!denials.includes('read_file'))
  assert.ok(!denials.includes('bash'))
})

test('research capabilities deny shells and writes but allow reads and network', () => {
  const denials = resolveToolDenials(RESEARCH_CAPABILITIES)
  assert.ok(denials.includes('bash'))
  assert.ok(denials.includes('edit'))
  assert.ok(!denials.includes('web_search'))
  assert.ok(!denials.includes('read_file'))
})

test('full capabilities deny nothing', () => {
  assert.deepEqual(resolveToolDenials(FULL_CAPABILITIES), [])
})

test('effectiveCapabilities falls back to full for unknown roles', () => {
  const effective = effectiveCapabilities('mystery', DEFAULT_CAPABILITY_MATRIX)
  assert.equal(effective.write, true)
})

test('effectiveCapabilities applies member overrides on top of the role baseline', () => {
  const effective = effectiveCapabilities('reviewer', DEFAULT_CAPABILITY_MATRIX, { write: true })
  assert.equal(effective.write, true)
  assert.equal(effective.read, true)
  assert.equal(effective.network, false) // baseline preserved
})

test('validateCapabilityMatrix rejects malformed entries', () => {
  assert.deepEqual(validateCapabilityMatrix(undefined), [])
  assert.deepEqual(validateCapabilityMatrix({ reviewer: { read: true, write: false, execute: true, network: false, secrets: false } }), [])
  assert.equal(validateCapabilityMatrix([]).length > 0, true)
  assert.equal(validateCapabilityMatrix({ reviewer: { read: 'yes' } }).length > 0, true)
})
