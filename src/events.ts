/**
 * Durable AgentTeams session events and their emitter.
 *
 * Every team-state mutation appends one event to the captain's Session, so
 * the web client's Conversation Node mechanism can fold the tree view from
 * the session log deterministically (same mechanism as `tool-workflow`'s
 * `tool-workflow/*` record events). Events append to the captain's session
 * even when a member agent performed the mutation, so the captain's
 * conversation stream stays the single authoritative monitor surface.
 *
 * Since the hardening pass, every event is *also* mirrored into the
 * plugin-owned append-only audit log (`<teamDir>/events.jsonl`) when the
 * caller supplies the team scope: host Session events may be declined for
 * out-of-repo types, but the durable audit trail is never lost.
 *
 * Types and the `SessionEventMap` merge live in `event-types.ts` (zero
 * imports) so the browser program can load them without host augmentations.
 * @module dsh-agent-teams/events
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { SessionEventMap } from '@deepseek-ai/dsh-session/types'
import type { AgentTeamsEventType } from './event-types.ts'
import { createSessionHost, captainSessionOf as hostCaptainSessionOf } from './host/session-host.ts'

/** Re-export the resolved-captain helper (kept for compatible imports). */
export const captainSessionOf = hostCaptainSessionOf

/** Team scope used to mirror an event into the durable audit log. */
export interface TeamEventAuditScope {
  stateRoot: string
  teamId: string
}

/** Shared host-agnostic event recorder. */
const recorder = createSessionHost()

/**
 * Append one AgentTeams event to a Session, containing failures (a broken
 * durable record must never break team tool execution).
 * @param ctx - the plugin context (for logging).
 * @param session - the session to record into (the captain's, normally).
 * @param type - the event type.
 * @param data - the event payload.
 * @param audit - optional team scope; when given the event is mirrored into
 *   the plugin-owned append-only audit log as durable truth.
 */
export function appendTeamEvent(
  ctx: Context,
  session: Session,
  type: AgentTeamsEventType,
  data: SessionEventMap[AgentTeamsEventType],
  audit?: TeamEventAuditScope,
): void {
  recorder.appendEvent(ctx, session, type, data, audit)
}

/**
 * Append one event and always mirror it into the team's durable audit log.
 * Convenience overload for call sites holding a resolved team scope.
 */
export function appendAuditedTeamEvent(
  ctx: Context,
  session: Session,
  type: AgentTeamsEventType,
  data: SessionEventMap[AgentTeamsEventType],
  stateRoot: string,
  teamId: string,
): void {
  recorder.appendEvent(ctx, session, type, data, { stateRoot, teamId })
}
