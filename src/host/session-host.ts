/**
 * Session event facade.
 *
 * Wraps the two concerns of recording an AgentTeams event: the host Session
 * append (best-effort, may be declined for unknown event types) and the
 * plugin-owned durable audit log (always attempted). Business code records
 * through {@link SessionHost} instead of touching `dsh-session` internals, so
 * a future SessionHandle / v2 host upgrade stays inside this module.
 *
 * @module dsh-agent-teams/host/session-host
 */

import type { Context } from '@deepseek-ai/cordis'
import * as dshSession from '@deepseek-ai/dsh-session'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { AgentTeamsEventType } from '../event-types.ts'
import type { SessionEventMap } from '@deepseek-ai/dsh-session/types'
import { appendTeamEventLog, TEAM_EVENT_LOG } from '../state.ts'
import { join } from 'node:path'

/** Event types already reported as unsupported, to avoid repetitive logs. */
const skippedEventTypes = new Set<string>()

/** Host-side session event recording surface. */
export interface SessionEventRecorder {
  /**
   * Append one AgentTeams event to a Session, containing failures (a broken
   * durable record must never break team tool execution) and always best-effort
   * mirroring the record into the plugin-owned audit log.
   * @param ctx - the plugin context (for logging).
   * @param session - the session to record into (the captain's, normally).
   * @param type - the event type.
   * @param data - the event payload.
   * @param stateRoot - optional team state root; when given the event is also
   *   appended to `<stateRoot>/<teamId>/events.jsonl` as durable audit truth.
   */
  appendEvent(
    ctx: Context,
    session: Session,
    type: AgentTeamsEventType,
    data: SessionEventMap[AgentTeamsEventType],
    options?: { stateRoot?: string; teamId?: string },
  ): void
}

/** Build the session event facade for one plugin context. */
export function createSessionHost(): SessionEventRecorder {
  return {
    appendEvent(ctx, session, type, data, options) {
      const stateRoot = options?.stateRoot
      const teamId = options?.teamId
      if (stateRoot !== undefined && teamId !== undefined) {
        appendTeamEventLog(stateRoot, teamId, type, data).catch((error: unknown) => {
          ctx.logger.warn(`agent-teams: durable audit log append failed for "${teamId}": ${String(error)}`)
        })
      }
      // Out-of-repo events are not in the harness's generated vocabulary until
      // an official `ignorable: true` writer surface exists. The plugin-owned
      // audit log above is the durable truth; host Session records are a
      // best-effort fold surface. Readability of a session must never depend
      // on which plugins happen to be loaded.
      const known = (dshSession as unknown as {
        KNOWN_SESSION_EVENT_TYPES?: ReadonlySet<string>
      }).KNOWN_SESSION_EVENT_TYPES
      if (known?.has(type) !== true) {
        if (!skippedEventTypes.has(type)) {
          skippedEventTypes.add(type)
          ctx.logger.debug(`agent-teams: session event "${type}" omitted because this harness does not recognize it`)
        }
        return
      }
      try {
        session.append(type, data)
      } catch (error: unknown) {
        ctx.logger.warn(`agent-teams: session record failed after ${type}: ${String(error)}`)
      }
    },
  }
}

/**
 * Resolve the captain's live Session for event recording. The captain agent
 * may be offline (its team outlives the session), in which case the caller's
 * own session is used as the fallback record target.
 * @param ctx - the plugin context (injects `agents`).
 * @param captainSessionId - the captain's durable session id.
 * @param fallback - the calling agent's session, used when the captain is not live.
 * @returns the session to record into.
 */
export function captainSessionOf(
  ctx: Context,
  captainSessionId: string,
  fallback: Session,
): Session {
  const captain = ctx.agents.get(captainSessionId as SessionId)
  return captain?.session ?? fallback
}

/** Human-readable audit log path for one team (documentation/diagnostics). */
export function teamEventLogPath(stateRoot: string, teamId: string): string {
  return join(stateRoot, teamId, TEAM_EVENT_LOG)
}
