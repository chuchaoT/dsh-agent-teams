/**
 * Attempt lifecycle policy.
 *
 * An attempt is one execution generation of a task, identified by its
 * capability (`attemptId`) and owned by one member. The scheduler previously
 * kept the "parked" knowledge only in process memory, so a hot-reloaded
 * runtime or a second process could mis-read a still-valid attempt as a cold
 * recovery candidate. This module centralizes the disposition decision on
 * durable task fields (see `TeamTask.attempt*`) plus the live Agent registry
 * status — everything else stays out of the scheduler.
 *
 * @module dsh-agent-teams/attempts
 */

import type { TeamTask } from './types.ts'

/** An open attempt with no liveness signal for this long is considered stuck. */
export const STALE_ATTEMPT_MS = 30 * 60_000

/** What the scheduler should do with one open attempt. */
export type AttemptDisposition = 'keep' | 'parked' | 'recover'

/** Live ownership facts available to the decision. */
export interface AttemptOwnerFacts {
  /** Scheduler runtime id of the current process (see `processRuntimeId`). */
  runtimeId: string
  /** Whether the owning agent is resident in the live Agent registry. */
  ownerResident: boolean
  /** Registry status of the owning agent when resident. */
  ownerStatus: 'idle' | 'running' | 'absent'
  /** Wall-clock now (injectable for tests). */
  now: number
  /** Stale-at threshold override (defaults to STALE_ATTEMPT_MS). */
  staleAfterMs?: number
}

/** True when the task is in a non-terminal state with an open capability. */
export function hasOpenAttempt(task: TeamTask): boolean {
  return (task.status === 'claimed' || task.status === 'in_progress') && task.attemptId !== undefined
}

/**
 * Decide the disposition of one open attempt.
 *
 * Rules, in order:
 * 1. No capability (legacy open task) → `recover`: there is nothing to revoke.
 * 2. No runtime id recorded (legacy open task) → `recover`.
 * 3. Owned by this runtime:
 *    - already parked → `parked` (only the captain message resumes it)
 *    - owner absent from the registry → `recover` (cold recovery)
 *    - liveness heartbeat older than the stale window → `recover` (watchdog;
 *      the old capability is revoked, so a stuck member's late update is
 *      rejected)
 *    - otherwise → `keep` (the member is or just became idle; the idle edge
 *      parks it)
 * 4. Owned by another runtime → `recover` (cross-process takeover remains a
 *    documented boundary: a fresh runtime cannot prove the old holder is
 *    gone, and the capability revocation keeps late results from winning).
 */
export function decideAttemptDisposition(
  task: TeamTask,
  facts: AttemptOwnerFacts,
): AttemptDisposition {
  if (task.attemptId === undefined) return 'recover'
  if (task.attemptRuntimeId === undefined) return 'recover'
  const staleAfter = facts.staleAfterMs ?? STALE_ATTEMPT_MS
  if (task.attemptRuntimeId !== facts.runtimeId) {
    return 'recover'
  }
  if (task.attemptParked === true) return 'parked'
  if (!facts.ownerResident || facts.ownerStatus === 'absent') return 'recover'
  if (task.attemptHeartbeatAt !== undefined
    && facts.now - task.attemptHeartbeatAt > staleAfter) {
    return 'recover'
  }
  return 'keep'
}

/** Park an open attempt in place (member idle mid-attempt). */
export function parkAttempt(task: TeamTask, now: number): void {
  task.attemptParked = true
  task.attemptParkedAt = now
  task.attemptHeartbeatAt = now
  task.updatedAt = now
}

/** Clear a park so the attempt may be dispatched again (captain message path). */
export function resumeAttempt(task: TeamTask, now: number): void {
  task.attemptParked = false
  task.attemptParkedAt = undefined
  task.attemptHeartbeatAt = now
  task.updatedAt = now
}

/** Record liveness on an actively worked attempt. */
export function refreshAttemptHeartbeat(task: TeamTask, now: number): void {
  task.attemptHeartbeatAt = now
  task.updatedAt = now
}
