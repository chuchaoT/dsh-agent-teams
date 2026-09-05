/**
 * Run manifest — the replay/review contract for an archived team.
 *
 * A manifest is a stable, self-contained summary of one run: the goal, the
 * roster, every task with its lifetime facts (attempts, verdicts, stage,
 * artifacts, evidence counts), and telemetry totals. It is written into the
 * team directory before archiving, so the archived bundle stays
 * self-describing; a future replay harness can start from the manifest
 * without re-deriving the story from JSONL logs.
 *
 * Pure module: types + one builder, no imports, unit-testable everywhere.
 * @module dsh-agent-teams/manifest
 */

import type { TeamState } from './types.ts'

/** One task row of the manifest (content stays in artifacts; ids suffice). */
export interface ManifestTask {
  readonly id: string
  readonly subject: string
  readonly status: string
  readonly assignee?: string
  readonly kind?: string
  readonly round?: number
  readonly verdict?: string
  readonly stage?: string
  readonly attempt: number
  readonly artifactIds?: readonly string[]
  readonly evidenceCount: number
  readonly requiresApproval?: boolean
  readonly approvalStatus?: string
}

export interface RunManifest {
  schemaVersion: 1
  teamId: string
  name: string
  description?: string
  captainSessionId: string
  createdAt: number
  archivedAt: number
  profileName?: string
  taskPlanning?: 'captain' | 'seed'
  members: readonly { name: string; role?: string; provider?: string; model?: string }[]
  tasks: readonly ManifestTask[]
  telemetryAttempts: number
  telemetryCostUsd: number
  artifacts: number
  memoryEntries: number
  auditEvents: number
}

/** Build the manifest for one (to-be-archived) team record. */
export function buildTeamManifest(
  state: TeamState,
  options: {
    archivedAt?: number
    telemetryAttempts?: number
    telemetryCostUsd?: number
    memoryEntries?: number
    auditEvents?: number
  } = {},
): RunManifest {
  const taskSummaries: ManifestTask[] = state.tasks.map((task) => ({
    id: task.id,
    subject: task.subject,
    status: task.status,
    ...task.assignee === undefined ? {} : { assignee: task.assignee },
    ...task.kind === undefined ? {} : { kind: task.kind },
    ...task.round === undefined ? {} : { round: task.round },
    ...task.verdict === undefined ? {} : { verdict: task.verdict },
    ...task.stage === undefined ? {} : { stage: task.stage },
    attempt: task.attempt ?? 0,
    ...task.artifacts === undefined || task.artifacts.length === 0
      ? {}
      : { artifactIds: task.artifacts.map((artifact) => artifact.artifactId) },
    evidenceCount: task.evidence?.length ?? 0,
    ...task.requiresApproval === undefined ? {} : { requiresApproval: task.requiresApproval },
    ...task.approvalStatus === undefined ? {} : { approvalStatus: task.approvalStatus },
  }))
  return {
    schemaVersion: 1,
    teamId: state.id,
    name: state.name,
    ...state.description === undefined ? {} : { description: state.description },
    captainSessionId: state.captainSessionId,
    createdAt: state.createdAt,
    archivedAt: options.archivedAt ?? Date.now(),
    ...state.profile === undefined ? {} : { profileName: state.profile.name },
    ...state.profile?.taskPlanning === undefined ? {} : { taskPlanning: state.profile.taskPlanning },
    members: state.members.map((member) => ({
      name: member.name,
      ...member.role === undefined ? {} : { role: member.role },
      ...member.provider === undefined ? {} : { provider: member.provider },
      ...member.model === undefined ? {} : { model: member.model },
    })),
    tasks: taskSummaries,
    telemetryAttempts: options.telemetryAttempts ?? 0,
    telemetryCostUsd: options.telemetryCostUsd ?? 0,
    artifacts: state.tasks.reduce((count, task) => count + (task.artifacts?.length ?? 0), 0),
    memoryEntries: options.memoryEntries ?? 0,
    auditEvents: options.auditEvents ?? 0,
  }
}
