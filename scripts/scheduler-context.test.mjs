/**
 * Unit tests for the dispatch-context wiring: dependency artifacts as refs,
 * and relevant team memory injected into the assignment prompt.
 *
 * @module dsh-agent-teams/scheduler-context.test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

let mod
try {
  mod = await import('../src/scheduler.ts')
} catch {
  mod = await import('../lib/scheduler.js')
}

const { assignmentPrompt, collectCompletedDependencyOutputs, formatDependencyOutputs } = mod

function task(overrides = {}) {
  return {
    id: 't1',
    subject: 'task',
    status: 'completed',
    dependencies: [],
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  }
}

function ticket(overrides = {}) {
  return {
    taskId: 't2',
    memberName: 'worker',
    memberId: 'm1',
    attempt: 1,
    attemptId: 'att-1',
    subject: 'Implement the feature',
    dependencyOutputs: [],
    ...overrides,
  }
}

test('dependency outputs carry artifact refs', () => {
  const tasks = [
    task({ id: 't1', artifacts: [{ artifactId: 'art-1', kind: 'code_diff', uri: 'x', sha256: 'y', summary: 'diff' }] }),
    task({ id: 't2', dependencies: ['t1'] }),
  ]
  const outputs = collectCompletedDependencyOutputs(tasks, 't2')
  assert.equal(outputs.length, 1)
  assert.deepEqual(outputs[0].artifactRefs, ['art-1'])
})

test('formatDependencyOutputs renders artifact refs line', () => {
  const formatted = formatDependencyOutputs([
    { id: 't1', subject: 'spec', output: 'the spec', artifactRefs: ['art-1', 'art-2'] },
  ])
  assert.match(formatted, /Artifacts: art-1, art-2/)
  assert.match(formatted, /the spec/)
})

test('assignmentPrompt includes the relevant memory section when present', () => {
  const prompt = assignmentPrompt(
    ticket({ relevantMemory: ['[decision] use test-first approach', '[team] prefer pnpm'] }),
    '.agent-teams',
    'team-1',
  )
  assert.match(prompt, /Relevant team memory/)
  assert.match(prompt, /\[decision\] use test-first approach/)
  assert.match(prompt, /\[team\] prefer pnpm/)
})

test('assignmentPrompt omits the memory section without entries', () => {
  const prompt = assignmentPrompt(ticket(), '.agent-teams', 'team-1')
  assert.doesNotMatch(prompt, /Relevant team memory/)
})
