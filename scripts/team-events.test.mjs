/**
 * Unit tests for the team-change signal bus (server side).
 *
 * @module dsh-agent-teams/team-events.test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { teamChangeBus } = await import('../src/host/team-events.ts')

test('bus notifies subscribers with the team id', (t) => {
  const seen = []
  const unsubscribe = teamChangeBus.subscribe((teamId) => seen.push(teamId))
  t.after(() => unsubscribe())
  teamChangeBus.notify('team-1')
  teamChangeBus.notify('team-2')
  assert.deepEqual(seen, ['team-1', 'team-2'])
})

test('bus stops notifying after unsubscribe', (t) => {
  const seen = []
  const unsubscribe = teamChangeBus.subscribe((teamId) => seen.push(teamId))
  teamChangeBus.notify('team-1')
  unsubscribe()
  teamChangeBus.notify('team-2')
  assert.deepEqual(seen, ['team-1'])
})
