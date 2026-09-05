/**
 * Event-driven shared task scheduler.
 *
 * Claude Code teammates keep polling the shared task list after a turn. DSH
 * continuable agents instead expose explicit idle/running edges, so this
 * scheduler closes the same loop without keeping a polling turn alive: every
 * idle edge and every task-graph mutation attempts one atomic claim and wakes
 * the selected durable member. A resident member that becomes idle while it
 * still owns an open attempt is parked: only an explicit captain reassignment
 * may rotate that capability. Automatic retry is reserved for cold recovery,
 * when the durable owner is no longer resident in the live Agent registry.
 * @module dsh-agent-teams/scheduler
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { join } from 'node:path'
import { deliverToMember } from './members.ts'
import {
  acknowledgeMailbox,
  appendTeamTelemetry,
  beginTaskAttempt,
  CAPTAIN_KEY,
  claimMailboxDelivery,
  findTeamByParticipant,
  invalidateTaskAttempt,
  processRuntimeId,
  readTeam,
  readUnreadMailbox,
  releaseMailboxDelivery,
  unsatisfiedDependencies,
  withTeamLock,
  writeTeam,
} from './state.ts'
import {
  decideAttemptDisposition,
  parkAttempt,
  refreshAttemptHeartbeat,
  resumeAttempt,
  type AttemptDisposition,
} from './attempts.ts'
import { createTelemetryRecord } from './telemetry.ts'
import type { TeamMember, TeamState, TeamTask } from './types.ts'

/** Per-dependency output cap in the assignment prompt. */
export const DEPENDENCY_OUTPUT_MAX_CHARS = 2_000
/** Combined dependency-output budget in the assignment prompt. */
export const DEPENDENCY_OUTPUTS_TOTAL_MAX_CHARS = 12_000

export interface SchedulerConfig {
  readonly stateDir: string
  readonly executionPrompt?: string
}

export interface TeamScheduler {
  /** Try to give every genuinely idle/ready member one unit of ready work. */
  kickTeam(workspace: string, teamId: string, captain?: Agent): Promise<void>
  /** Try to flush fallback mail or give one member one ready task. */
  kickMember(workspace: string, teamId: string, memberName: string, captain?: Agent): Promise<void>
}

/** One completed recursive dependency shown to the assignee. */
export interface DependencyOutput {
  readonly id: string
  readonly subject: string
  readonly profileSeedId?: string
  readonly output?: string
}

export interface DispatchTicket {
  readonly taskId: string
  readonly memberName: string
  readonly memberId: string
  readonly attempt: number
  readonly attemptId: string
  readonly previousAssignee?: string
  readonly subject: string
  readonly description?: string
  readonly teamDescription?: string
  readonly profileProtocol?: string
  readonly profileSeedId?: string
  readonly dependencyOutputs: readonly DependencyOutput[]
  readonly executionPrompt?: string
  readonly kind?: string
  readonly round?: number
  readonly objective?: string
  readonly inScope?: readonly string[]
  readonly outOfScope?: readonly string[]
  readonly acceptance?: readonly string[]
  readonly verify?: readonly string[]
  readonly reviewedTaskId?: string
  /** Resolved route captured at dispatch (for telemetry attribution). */
  readonly provider?: string
  readonly model?: string
}

function taskProfileSeedId(task: TeamTask): string | undefined {
  const seed = task.profileSeedId?.trim()
  return seed === undefined || seed === '' ? undefined : seed
}

function teamProfileProtocol(team: TeamState): string | undefined {
  return team.profile?.protocol
}

/**
 * Recursively collect `status=completed` ancestors of `taskId` in topological
 * order (dependencies before dependents). Cycles stop that branch only.
 */
export function collectCompletedDependencyOutputs(
  tasks: readonly TeamTask[],
  taskId: string,
  warn?: (message: string) => void,
): DependencyOutput[] {
  const byId = new Map(tasks.map(task => [task.id, task]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const ordered: TeamTask[] = []

  const walk = (id: string): void => {
    if (visiting.has(id)) {
      warn?.(`agent-teams: dependency cycle involving "${id}" while collecting outputs; stopping this branch`)
      return
    }
    if (visited.has(id)) return
    visiting.add(id)
    const task = byId.get(id)
    if (task !== undefined) {
      for (const dependency of task.dependencies) walk(dependency)
      if (id !== taskId) ordered.push(task)
    }
    visiting.delete(id)
    visited.add(id)
  }

  walk(taskId)
  return ordered
    .filter(task => task.status === 'completed')
    .map((task) => {
      const profileSeedId = taskProfileSeedId(task)
      return {
        id: task.id,
        subject: task.subject,
        ...profileSeedId === undefined ? {} : { profileSeedId },
        ...task.output === undefined ? {} : { output: task.output },
      }
    })
}

/** Format completed-dependency outputs with per-item and total truncation. */
export function formatDependencyOutputs(items: readonly DependencyOutput[]): string {
  if (items.length === 0) return '(none)'
  const formatted = items.map((item) => {
    const seed = item.profileSeedId === undefined ? '' : ` [${item.profileSeedId}]`
    const raw = item.output === undefined || item.output === ''
      ? '(no output recorded)'
      : item.output
    const truncated = raw.length > DEPENDENCY_OUTPUT_MAX_CHARS
    const body = truncated ? `${raw.slice(0, DEPENDENCY_OUTPUT_MAX_CHARS)} [truncated]` : raw
    return `- ${item.id}${seed} ${item.subject}:\n  ${body}`
  })
  let selected = formatted
  while (selected.length > 1 && selected.join('\n').length > DEPENDENCY_OUTPUTS_TOTAL_MAX_CHARS) {
    selected = selected.slice(1)
  }
  const last = selected[0]
  if (selected.length === 1 && last !== undefined && last.length > DEPENDENCY_OUTPUTS_TOTAL_MAX_CHARS) {
    selected = [`${last.slice(0, DEPENDENCY_OUTPUTS_TOTAL_MAX_CHARS)} [truncated]`]
  }
  return selected.join('\n')
}

function stateRootOf(workspace: string, config: SchedulerConfig): string {
  return join(workspace, config.stateDir)
}

function teamLockKey(stateRoot: string, teamId: string): string {
  return `team:${stateRoot}:${teamId}`
}

function liveCaptain(ctx: Context, captainSessionId: string, supplied?: Agent): Agent | undefined {
  if (supplied !== undefined && supplied.id === captainSessionId) return supplied
  return ctx.agents.get(captainSessionId as SessionId)
}

function liveMember(ctx: Context, member: TeamMember): Agent | undefined {
  return ctx.agents.get(member.id as SessionId)
}

function isMemberAvailable(ctx: Context, member: TeamMember): boolean {
  const live = liveMember(ctx, member)
  return live === undefined || live.status === 'idle'
}

function ownedOpenTask(tasks: readonly TeamTask[], memberName: string): TeamTask | undefined {
  return tasks.find(task => task.assignee === memberName
    && (task.status === 'claimed' || task.status === 'in_progress'))
}

const PRIORITY_RANK: Readonly<Record<'low' | 'normal' | 'high', number>> = {
  high: 0,
  normal: 1,
  low: 2,
}

/**
 * Order ready tasks for fair claiming: higher priority first, then nearest
 * deadline, then oldest creation. Ties keep their original order (stable).
 */
export function sortReadyTasks(tasks: readonly TeamTask[]): TeamTask[] {
  return [...tasks].sort((a, b) => {
    const rankDelta = (PRIORITY_RANK[a.priority ?? 'normal'] ?? 1) - (PRIORITY_RANK[b.priority ?? 'normal'] ?? 1)
    if (rankDelta !== 0) return rankDelta
    const deadlineDelta = (a.deadlineAt ?? Number.POSITIVE_INFINITY) - (b.deadlineAt ?? Number.POSITIVE_INFINITY)
    if (deadlineDelta !== 0) return deadlineDelta
    return (a.createdAt ?? 0) - (b.createdAt ?? 0)
  })
}

function nextReadyTask(tasks: readonly TeamTask[], memberName: string): TeamTask | undefined {
  const ready = tasks.filter(task => task.status === 'pending'
    && task.reassigning !== true
    && unsatisfiedDependencies([...tasks], task.dependencies).length === 0)
  const ordered = sortReadyTasks(ready)
  return ordered.find(task => task.assignee === memberName)
    ?? ordered.find(task => task.assignee === undefined)
}

export function assignmentPrompt(ticket: DispatchTicket, stateDir: string, teamId: string): string {
  const description = ticket.description === undefined ? '' : `\n\n${ticket.description}`
  const seed = ticket.profileSeedId === undefined ? '' : ` [${ticket.profileSeedId}]`
  const goal = ticket.teamDescription?.trim() || '(not provided)'
  const protocol = ticket.profileProtocol?.trim() || '(none)'
  const executionPrompt = ticket.executionPrompt?.trim()
  const kind = ticket.kind?.trim() || 'work'
  const contract = [
    `Kind: ${kind}${ticket.round === undefined ? '' : ` (round ${ticket.round})`}`,
    ticket.objective === undefined || ticket.objective === '' ? '' : `Objective: ${ticket.objective}`,
    ticket.inScope === undefined || ticket.inScope.length === 0 ? '' : `In scope: ${ticket.inScope.join(', ')}`,
    ticket.outOfScope === undefined || ticket.outOfScope.length === 0 ? '' : `Out of scope: ${ticket.outOfScope.join(', ')}`,
    ticket.acceptance === undefined || ticket.acceptance.length === 0 ? '' : `Acceptance: ${ticket.acceptance.join('; ')}`,
    ticket.verify === undefined || ticket.verify.length === 0 ? '' : `Verify: ${ticket.verify.join('; ')}`,
    ticket.reviewedTaskId === undefined ? '' : `Reviewed task: ${ticket.reviewedTaskId}`,
  ].filter((line) => line !== '').join('\n')
  const structuredCompletion = ['implementation', 'repair', 'verification', 'integration'].includes(kind)
    ? `
Structured completion payload (keep these arrays in contract order):
acceptanceResults: ${JSON.stringify((ticket.acceptance ?? []).map((criterion) => ({ criterion, status: 'passed', evidence: '<what proved it>' })))}
commandsRun: ${JSON.stringify((ticket.verify ?? []).map((command) => ({ command, status: 'passed', exitCode: 0, evidence: '<observed result>' })))}
${kind === 'implementation' || kind === 'repair' ? 'changedPaths: list the actual workspace-relative POSIX paths you changed.\n' : ''}`
    : ''
  return `AgentTeams automatic task assignment from the shared task list.

You are executing as configured member "${ticket.memberName}".
Do not start a teammate's assigned task.

Team goal:
${goal}

Profile protocol:
${protocol}
${executionPrompt === undefined || executionPrompt === '' ? '' : `
Execution guidance:
${executionPrompt}
`}
Completed dependency results:
${formatDependencyOutputs(ticket.dependencyOutputs)}

Task: ${ticket.taskId}${seed} — ${ticket.subject}${description}
${contract === '' ? '' : `\nContract:\n${contract}\n`}
${structuredCompletion}
Attempt: ${ticket.attempt}
Attempt id: ${ticket.attemptId}

Call agent_teams_claim_task for ${ticket.taskId}; it will return this same attempt_id. Include attempt_id=${ticket.attemptId} in every agent_teams_update_task call. If it is rejected as stale, stop work because the task was reassigned. claimed cannot jump to completed. Mark in_progress first, then completed or failed. Include attempt_id on every update. Then send_message to captain and become idle.
When finishing: use status=completed only when the task's success criteria are satisfied; use status=failed when blocking findings or validation failures mean downstream work must not proceed; include a concise output in either case. Quality kinds must submit structured fields: review/requirements need verdict=pass to complete (needs_revision/reject must fail with findings); implementation/repair/verification/integration need acceptanceResults and commandsRun, while implementation/repair also need in-scope changedPaths. Use status values "passed" or "failed" inside those arrays. After the work and verification finish, call agent_teams_update_task immediately; do not wait for captain confirmation and do not continue exploring. Do not approve your own implementation. Mail is not a formal next review. Treat the dependency results above as source material. Do not ignore them. Work only this task and only its in-scope paths in this turn.

State policy: ${stateDir}/${teamId}/ is read-only diagnostics; mutate team state only through agent_teams_* tools.`
}

function fallbackMailboxPrompt(messages: Awaited<ReturnType<typeof readUnreadMailbox>>): string {
  return [
    'AgentTeams delivered messages that were persisted while live delivery was unavailable:',
    ...messages.map(message => `\nFrom ${message.from}:\n${message.content}`),
    '\nHandle these messages in this turn. Task assignments still require agent_teams_claim_task and the current attempt_id.',
  ].join('\n')
}

/** Install one scheduler and its member activity observer. */
export function installTeamScheduler(ctx: Context, config: SchedulerConfig): TeamScheduler {
  const memberQueues = new Map<string, Promise<unknown>>()
  // Attempt park/recovery state lives on the task record (durable), not here.
  // This process's runtime id distinguishes its own parked attempts from a
  // cold process's open work (see src/attempts.ts).

  const memberQueueKey = (stateRoot: string, teamId: string, memberName: string): string => (
    `${stateRoot}\u0000${teamId}\u0000${memberName}`
  )

  const serializeMember = async <T>(key: string, operation: () => Promise<T>): Promise<T> => {
    const previous = memberQueues.get(key) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const tail = previous.then(() => gate)
    memberQueues.set(key, tail)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (memberQueues.get(key) === tail) memberQueues.delete(key)
    }
  }

  const runtime: TeamScheduler = {
    async kickTeam(workspace, teamId, suppliedCaptain) {
      const stateRoot = stateRootOf(workspace, config)
      const team = await readTeam(stateRoot, teamId)
      if (team === undefined || team.halted === true || team.phase === 'staged') return
      const captain = liveCaptain(ctx, team.captainSessionId, suppliedCaptain)
      if (captain === undefined) return
      for (const member of team.members) {
        if (member.status === 'removed') continue
        await runtime.kickMember(workspace, teamId, member.name, captain)
      }
    },

    async kickMember(workspace, teamId, memberName, suppliedCaptain) {
      const stateRoot = stateRootOf(workspace, config)
      const queueKey = memberQueueKey(stateRoot, teamId, memberName)
      await serializeMember(queueKey, async () => {
        let team = await readTeam(stateRoot, teamId)
        if (team === undefined || team.halted === true || team.phase === 'staged') return
        const captain = liveCaptain(ctx, team.captainSessionId, suppliedCaptain)
        if (captain === undefined) return
        let member = team.members.find(candidate => candidate.name === memberName && candidate.status !== 'removed')
        if (member === undefined || member.id === '' || !isMemberAvailable(ctx, member)) return

        // A mailbox-only fallback is real pending work. Deliver it before a
        // fresh task and acknowledge only after Harness accepts the follow-up.
        const unread = await readUnreadMailbox(stateRoot, team.id, member.name)
        if (unread.length > 0) {
          await withTeamLock(teamLockKey(stateRoot, team.id), () => (
            claimMailboxDelivery(stateRoot, team!.id, member!.name, unread.map(message => message.id))
          ))
          const accepted = await deliverToMember(
            ctx,
            captain,
            member.id,
            fallbackMailboxPrompt(unread),
            new AbortController().signal,
          )
          if (accepted) {
            await withTeamLock(teamLockKey(stateRoot, team.id), () => (
              acknowledgeMailbox(stateRoot, team!.id, member!.name, unread.map(message => message.id))
            ))
          } else {
            await withTeamLock(teamLockKey(stateRoot, team.id), () => (
              releaseMailboxDelivery(stateRoot, team!.id, member!.name, unread.map(message => message.id))
            ))
          }
          return
        }

        const ticket = await withTeamLock(teamLockKey(stateRoot, team.id), async (): Promise<DispatchTicket | undefined> => {
          const fresh = await readTeam(stateRoot, team!.id)
          if (fresh === undefined || fresh.halted === true || fresh.phase === 'staged') return undefined
          const currentMember = fresh.members.find(candidate => candidate.name === memberName && candidate.status !== 'removed')
          if (currentMember === undefined || currentMember.id === '' || !isMemberAvailable(ctx, currentMember)) return undefined
          const owned = ownedOpenTask(fresh.tasks, currentMember.name)
          // A resident idle member can intentionally leave an attempt open
          // while waiting for guidance, or because the user paused its turn.
          // Re-dispatching here would revoke still-valid work on every idle
          // edge and every status kick. The disposition comes from durable
          // attempt fields + live registry facts, not process memory: a cold
          // process (different runtime id) or a stale heartbeat recovers, a
          // parked attempt stays parked until the captain messages it.
          const live = liveMember(ctx, currentMember)
          const disposition: AttemptDisposition = owned === undefined
            ? 'keep'
            : decideAttemptDisposition(owned, {
                runtimeId: processRuntimeId(),
                ownerResident: live !== undefined,
                ownerStatus: live === undefined ? 'absent' : live.status === 'idle' ? 'idle' : 'running',
                now: Date.now(),
              })
          let task: TeamTask | undefined
          if (owned !== undefined) {
            if (disposition === 'parked') {
              if (currentMember.status !== 'idle') {
                currentMember.status = 'idle'
                await writeTeam(stateRoot, fresh)
              }
              return undefined
            }
            if (disposition === 'keep') {
              // Same runtime, member just became idle: park durably. Only a
              // captain message may resume this exact capability.
              parkAttempt(owned, Date.now())
              if (currentMember.status !== 'idle') {
                currentMember.status = 'idle'
                await writeTeam(stateRoot, fresh)
              } else {
                await writeTeam(stateRoot, fresh)
              }
              return undefined
            }
            task = owned // recover (cold runtime / stale heartbeat / legacy)
          } else {
            task = nextReadyTask(fresh.tasks, currentMember.name)
          }
          if (task === undefined) {
            if (currentMember.status !== 'idle') {
              currentMember.status = 'idle'
              await writeTeam(stateRoot, fresh)
            }
            return undefined
          }
          const previousAssignee = task.assignee
          const attemptId = beginTaskAttempt(task, currentMember.name)
          currentMember.status = 'working'
          await writeTeam(stateRoot, fresh)
          const profileSeedId = taskProfileSeedId(task)
          const protocol = teamProfileProtocol(fresh)
          return {
            taskId: task.id,
            memberName: currentMember.name,
            memberId: currentMember.id,
            attempt: task.attempt ?? 1,
            attemptId,
            previousAssignee,
            subject: task.subject,
            description: task.description,
            teamDescription: fresh.description,
            ...protocol === undefined ? {} : { profileProtocol: protocol },
            ...profileSeedId === undefined ? {} : { profileSeedId },
            ...fresh.profile?.executionPrompt === undefined && config.executionPrompt === undefined
              ? {}
              : { executionPrompt: fresh.profile?.executionPrompt ?? config.executionPrompt },
            kind: task.kind ?? 'work',
            ...task.round === undefined ? {} : { round: task.round },
            ...task.objective === undefined ? {} : { objective: task.objective },
            ...task.inScope === undefined ? {} : { inScope: task.inScope },
            ...task.outOfScope === undefined ? {} : { outOfScope: task.outOfScope },
            ...task.acceptance === undefined ? {} : { acceptance: task.acceptance },
            ...task.verify === undefined ? {} : { verify: task.verify },
            ...task.reviewedTaskId === undefined ? {} : { reviewedTaskId: task.reviewedTaskId },
            provider: currentMember.activeProvider ?? currentMember.provider,
            model: currentMember.activeModel ?? currentMember.model,
            dependencyOutputs: collectCompletedDependencyOutputs(
              fresh.tasks,
              task.id,
              (message) => ctx.logger.warn(message),
            ),
          }
        })
        if (ticket === undefined) return

        const accepted = await deliverToMember(
          ctx,
          captain,
          ticket.memberId,
          assignmentPrompt(ticket, config.stateDir, team.id),
          new AbortController().signal,
        )
        if (accepted) {
          // Observability: the dispatch is the moment an attempt becomes
          // observable to the team. Measurements are best-effort; a telemetry
          // failure must never surface as a scheduling error.
          appendTeamTelemetry(stateRoot, team.id, createTelemetryRecord({
            kind: 'attempt_started',
            teamId: team.id,
            taskId: ticket.taskId,
            attemptId: ticket.attemptId,
            memberName: ticket.memberName,
            ...ticket.provider === undefined ? {} : { provider: ticket.provider },
            ...ticket.model === undefined ? {} : { model: ticket.model },
            queuedAt: Date.now(),
            startedAt: Date.now(),
          })).catch((error: unknown) => {
            ctx.logger.warn(`agent-teams: telemetry attempt_started failed for ${ticket.taskId}: ${String(error)}`)
          })
          return
        }

        // Roll back only our exact failed dispatch. A concurrent captain
        // handoff has already changed the capability and wins.
        await withTeamLock(teamLockKey(stateRoot, team.id), async () => {
          const fresh = await readTeam(stateRoot, team!.id)
          if (fresh === undefined) return
          const task = fresh.tasks.find(candidate => candidate.id === ticket.taskId)
          if (task?.attemptId !== ticket.attemptId) return
          task.status = 'pending'
          task.assignee = ticket.previousAssignee
          task.attemptId = undefined
          task.attemptStartedAt = undefined
          task.attemptHeartbeatAt = undefined
          task.attemptRuntimeId = undefined
          task.attemptParked = false
          task.attemptParkedAt = undefined
          task.handoffId = undefined
          task.reassigning = false
          task.updatedAt = Date.now()
          const currentMember = fresh.members.find(candidate => candidate.name === ticket.memberName)
          if (currentMember !== undefined && currentMember.status !== 'removed') currentMember.status = 'idle'
          await writeTeam(stateRoot, fresh)
        })
      })
    },
  }

  const syncMemberStatus = async (agent: Agent, status: AgentStatus): Promise<void> => {
    const workspace = agent.session.header.cwd ?? process.cwd()
    const stateRoot = stateRootOf(workspace, config)
    const located = await findTeamByParticipant(stateRoot, agent.id)
    if (located === undefined) return
    if (located.captainSessionId === agent.id) {
      // Captain takeover is scoped to the captain's current turn. Unlike a
      // durable member, the captain has no scheduler lane that can resume an
      // abandoned attempt later. Returning unfinished captain-owned work to
      // the shared pool on the idle edge prevents it from becoming a
      // permanently parked `claimed` task after the captain answers, is
      // interrupted, or the user switches conversations.
      if (status === 'running') return
      let requeued = false
      await withTeamLock(teamLockKey(stateRoot, located.id), async () => {
        const fresh = await readTeam(stateRoot, located.id)
        if (fresh === undefined || fresh.captainSessionId !== agent.id) return
        for (const task of fresh.tasks) {
          if (task.assignee !== CAPTAIN_KEY
            || task.status === 'completed'
            || task.status === 'failed'
            || task.status === 'cancelled') continue
          invalidateTaskAttempt(task)
          task.reassigning = false
          requeued = true
        }
        if (requeued) await writeTeam(stateRoot, fresh)
      })
      if (requeued) await runtime.kickTeam(workspace, located.id, agent)
      return
    }
    const member = located.members.find(candidate => candidate.id === agent.id && candidate.status !== 'removed')
    if (member === undefined) return
    await withTeamLock(teamLockKey(stateRoot, located.id), async () => {
      const fresh = await readTeam(stateRoot, located.id)
      const current = fresh?.members.find(candidate => candidate.id === agent.id && candidate.status !== 'removed')
      if (fresh === undefined || current === undefined) return
      const next = status === 'running' ? 'working' : 'idle'
      let needsParkWrite = false
      if (next === 'idle') {
        // Durable park: the member ended its turn while its attempt is still
        // open. Only a captain message may resume this exact capability;
        // every later kick/restart sees the same truthful park flag.
        const owned = ownedOpenTask(fresh.tasks, current.name)
        if (owned?.attemptId !== undefined && owned.attemptParked !== true) {
          parkAttempt(owned, Date.now())
          needsParkWrite = true
        }
      }
      if (current.status === next) {
        if (needsParkWrite) await writeTeam(stateRoot, fresh)
        return
      }
      current.status = next
      await writeTeam(stateRoot, fresh)
    })
    if (status === 'idle') await runtime.kickMember(workspace, located.id, member.name)
  }

  ctx.on('agent/status', ({ agent, status }) => {
    void syncMemberStatus(agent, status).catch((error: unknown) => {
      ctx.logger.warn(`agent-teams: member status scheduling failed for ${agent.id}: ${String(error)}`)
    })
  })

  return runtime
}
