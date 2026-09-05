/**
 * Cross-module team-change signal bus.
 *
 * The server emits "team changed" notifications whenever a team mutation is
 * recorded (see events.ts). The activity-panel SSE route subscribes to this
 * bus and pushes a lightweight `changed` event to connected browsers, which
 * then refetch the snapshot immediately — the browser still reads the state
 * route (durable truth), so the connection carries no data and any missed
 * signal degrades to the existing low-frequency probe. This keeps the
 * panel live without turning every mutation into a WebSocket message.
 *
 * @module dsh-agent-teams/host/team-events
 */

import { EventEmitter } from 'node:events'

/** Process-local change bus for one plugin activation. */
export interface TeamChangeBus {
  /** Record one team mutation (all team ids observed so far). */
  notify(teamId: string): void
  /** Subscribe to team mutations; returns an unsubscribe. */
  subscribe(listener: (teamId: string) => void): () => void
}

const emitter = new EventEmitter()
emitter.setMaxListeners(100)

/** The default activation-wide bus. */
export const teamChangeBus: TeamChangeBus = {
  notify(teamId) {
    emitter.emit('changed', teamId)
  },
  subscribe(listener) {
    const wrapped = (teamId: string): void => listener(teamId)
    emitter.on('changed', wrapped)
    return () => { emitter.off('changed', wrapped) }
  },
}
