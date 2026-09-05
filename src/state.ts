/**
 * Team state persistence and pure team-logic rules.
 *
 * State lives on disk under `<workspace>/<stateDir>/<teamId>/`:
 * - `team.json` — the durable {@link TeamState} record
 * - `inbox/<agentKey>.jsonl` — one JSONL mailbox per agent (`captain` or a
 *   member name), mirroring the Claude Code AgentTeams mailbox layout
 *
 * All mutations run through an in-process per-team queue so read-modify-write
 * stays serial; `fs/promises` is used directly because the plugin owns this
 * bookkeeping (host-plane state, like session persistence) and the abstract
 * `fs` service offers no directory deletion.
 * @module dsh-agent-teams/state
 */

import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { appendFile, mkdir, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { TERMINAL_TASK_STATUSES, type TaskStatus, type TeamMember, type TeamMessage, type TeamProfileSnapshot, type TeamState, type TeamTask } from './types.ts'
import { hasValidQualityTaskFields, isReviewPolicy, normalizeBlankOptionalTaskFields } from './quality-gates.ts'

export {
  buildCoverageMatrix,
  canDeclareDelivery,
  classifyChangedPath,
  collectChangedPaths,
  defaultQualityDeliveryGraph,
  describeQualityLoop,
  evaluateQualityCompletion,
  hasValidQualityTaskFields,
  isQualityKind,
  normalizeBlankOptionalTaskFields,
  pathMatchesScope,
  planQualityFollowUp,
  qualityPlanningPrompt,
  resumeTeamState,
  sanitizeReviewAcceptance,
  sanitizeReviewObjective,
  taskKindOf,
  validateCreateTask,
} from './quality-gates.ts'

/** Mailbox key of the captain. */
export const CAPTAIN_KEY = 'captain'
/** A crashed live-delivery attempt becomes retryable after this interval. */
const MAILBOX_DELIVERY_LEASE_MS = 60_000
/** Durable deny-list for AgentTeams members that must never be resumed. */
const RETIRED_MEMBERS_FILE = 'retired-members.json'
/** Append-only per-team audit event log (plugin-owned, host-independent truth). */
export const TEAM_EVENT_LOG = 'events.jsonl'
/** Append-only per-team run telemetry log (attempts, queues, gates, fallbacks). */
export const TEAM_TELEMETRY_LOG = 'telemetry.jsonl'

/**
 * Append one run-telemetry record to the team's append-only telemetry log.
 * Telemetry is observational: a failed append must never fail the operation
 * that produced the measurement, so callers `catch` and log.
 */
export async function appendTeamTelemetry(
  stateRoot: string,
  teamId: string,
  record: unknown,
): Promise<void> {
  const entry = {
    ts: Date.now(),
    teamId,
    ...(typeof record === 'object' && record !== null ? record as Record<string, unknown> : { record }),
  }
  await mkdir(stateRoot, { recursive: true })
  await appendFile(join(stateRoot, teamId, TEAM_TELEMETRY_LOG), `${JSON.stringify(entry)}\n`, 'utf8')
}

/** Read the complete telemetry log for one team (torn tail lines skipped). */
export async function readTeamTelemetry(stateRoot: string, teamId: string): Promise<unknown[]> {
  try {
    const raw = await readFile(join(stateRoot, teamId, TEAM_TELEMETRY_LOG), 'utf8')
    const entries: unknown[] = []
    for (const line of raw.split(/\r?\n/)) {
      if (line.trim() === '') continue
      try {
        entries.push(JSON.parse(line) as unknown)
      } catch {
        continue
      }
    }
    return entries
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw error
  }
}

/**
 * One durable audit record. The plugin-owned event log is the authoritative
 * mutation trail for a team; host Session events are a best-effort surface
 * folded by the client conversation node.
 */
export interface TeamEventLogEntry {
  id: string
  ts: number
  teamId: string
  type: string
  data: unknown
}

/**
 * Append one audit record to the team's append-only event log.
 *
 * Unlike `team.json` (full rewrite) the log is single-writer append-only:
 * cost is O(1) per record and a crash can only truncate the tail of one
 * line, never corrupt the whole file. Callers must treat failures as
 * non-fatal — a broken audit trail must never break team tool execution.
 */
export async function appendTeamEventLog(
  stateRoot: string,
  teamId: string,
  type: string,
  data: unknown,
): Promise<void> {
  const record: TeamEventLogEntry = {
    id: randomUUID(),
    ts: Date.now(),
    teamId,
    type,
    data,
  }
  await mkdir(stateRoot, { recursive: true })
  await appendFile(join(stateRoot, teamId, TEAM_EVENT_LOG), `${JSON.stringify(record)}\n`, 'utf8')
}

/** Read the complete durable audit log for one team (newest not assumed). */
export async function readTeamEventLog(
  stateRoot: string,
  teamId: string,
): Promise<TeamEventLogEntry[]> {
  try {
    const raw = await readFile(join(stateRoot, teamId, TEAM_EVENT_LOG), 'utf8')
    const entries: TeamEventLogEntry[] = []
    for (const line of raw.split(/\r?\n/)) {
      if (line.trim() === '') continue
      try {
        const entry: unknown = JSON.parse(line)
        if (typeof entry === 'object' && entry !== null
          && typeof (entry as TeamEventLogEntry).type === 'string'
          && typeof (entry as TeamEventLogEntry).teamId === 'string') {
          entries.push(entry as TeamEventLogEntry)
        }
      } catch {
        // A torn tail line (crash mid-append) must not fail the whole read.
        continue
      }
    }
    return entries
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw error
  }
}

/** In-process per-team mutation queues (promise chains). */
const locks = new Map<string, Promise<unknown>>()

/** Lock directory prefix for the cross-process lock, under the state root. */
const LOCK_DIR = '.locks'
/** A lock file abandoned longer than this is considered stale. */
const STALE_LOCK_MS = 10_000
/** Max wait to acquire a cross-process lock before failing loudly. */
const CROSS_PROCESS_LOCK_WAIT_MS = 20_000
/** Poll interval while waiting for a cross-process lock. */
const LOCK_POLL_MS = 60

/**
 * Cross-process advisory lock keyed by state root + team id.
 *
 * The lock file is created with `O_EXCL` (`wx`), so at most one process
 * holds it. A file whose mtime is older than {@link STALE_LOCK_MS} is
 * treated as abandoned (crashed holder) and reclaimed. The lock is
 * best-effort: it prevents the common Web+Headless lost-update pattern, not
 * a hostile writer, and does not replace the in-process queue serialization.
 * @param stateRoot - resolved absolute state root directory.
 * @param key - lock scope key (team id, retired-members scope, …).
 * @param fn - the mutation to run exclusively.
 */
export async function withCrossProcessLock<T>(
  stateRoot: string,
  key: string,
  fn: () => Promise<T>,
  options?: { waitMs?: number; staleMs?: number },
): Promise<T> {
  const waitMs = options?.waitMs ?? CROSS_PROCESS_LOCK_WAIT_MS
  const staleMs = options?.staleMs ?? STALE_LOCK_MS
  const lockFile = join(stateRoot, LOCK_DIR, `${sanitizeKey(key)}.lock`)
  await mkdir(join(stateRoot, LOCK_DIR), { recursive: true })
  const deadline = Date.now() + waitMs
  const owner = JSON.stringify({ pid: process.pid, ts: Date.now() })
  for (;;) {
    let handle
    try {
      handle = await open(lockFile, 'wx')
    } catch (error: unknown) {
      const code = error instanceof Error && 'code' in error ? (error as NodeJS.ErrnoException).code : undefined
      if (code !== 'EEXIST') throw error
      // Attempt stale reclaim: the file existed. If its mtime is older than
      // the stale window, unlink it and retry immediately.
      try {
        const info = await stat(lockFile)
        if (Date.now() - info.mtimeMs > staleMs) {
          await unlink(lockFile)
          continue
        }
      } catch (statError: unknown) {
        const statCode = statError instanceof Error && 'code' in statError
          ? (statError as NodeJS.ErrnoException).code : undefined
        if (statCode === 'ENOENT') continue // released between open failure and stat
        throw statError
      }
      if (Date.now() > deadline) {
        throw new Error(`AgentTeams cross-process lock "${key}" was not released within ${waitMs}ms`)
      }
      await sleep(LOCK_POLL_MS)
      continue
    }
    try {
      await handle.writeFile(owner, 'utf8')
    } finally {
      await handle.close()
    }
    try {
      return await fn()
    } finally {
      await unlink(lockFile).catch(() => undefined)
    }
  }
}

/**
 * Serialize mutations of one team across the whole process.
 * @param key - the team id (or any mutation scope).
 * @param fn - the mutation to run exclusively.
 * @returns the mutation's result.
 */
export async function withTeamLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  locks.set(key, previous.then(() => gate))
  await previous
  try {
    return await fn()
  } finally {
    release()
  }
}

/** Longest key emitted before truncating and appending a digest. */
const MAX_KEY_LENGTH = 48

/** Short stable digest, used to keep otherwise-colliding keys distinct. */
function keyDigest(name: string): string {
  return createHash('sha256').update(name).digest('hex').slice(0, 8)
}

/**
 * Fold a free-form name into a safe path/key segment.
 *
 * Unicode letters and digits survive, so CJK/Cyrillic/Greek names stay
 * distinct and readable; everything else — spaces, punctuation, path
 * separators, control characters — folds to `-`. An ASCII-only whitelist
 * mapped *every* non-Latin name onto one shared fallback, which silently
 * merged their mailboxes and rejected the second such member as a duplicate.
 *
 * A name with no letters or digits at all (pure emoji or punctuation) cannot
 * yield a readable key, so it gets a digest rather than a shared constant.
 * Over-long names are truncated with a digest appended, so names sharing a
 * long prefix stay distinct and the result stays within filesystem limits
 * (CJK costs 3 bytes per character in UTF-8).
 *
 * @param name - any user-supplied name.
 * @returns a non-empty key safe as a single path segment.
 */
export function sanitizeKey(name: string): string {
  const cleaned = name.normalize('NFC').trim().toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  if (cleaned === '') return `k-${keyDigest(name)}`
  const points = [...cleaned]
  if (points.length > MAX_KEY_LENGTH) {
    return `${points.slice(0, MAX_KEY_LENGTH).join('')}-${keyDigest(name)}`
  }
  return cleaned
}

/**
 * Whether `dependencies` are all satisfied (every named task exists and
 * completed) for the given task list.
 * @param tasks - the team's tasks.
 * @param dependencies - task ids the candidate depends on.
 * @returns the ids that are still unsatisfied, empty when claimable.
 */
export function unsatisfiedDependencies(tasks: TeamTask[], dependencies: string[]): string[] {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  return dependencies.filter((id) => byId.get(id)?.status !== 'completed')
}

/**
 * The allowed task status transitions, keyed by current status.
 * Terminal statuses have no outgoing transitions.
 */
export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  pending: ['claimed', 'cancelled'],
  claimed: ['in_progress', 'failed', 'cancelled'],
  in_progress: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
}

/**
 * Validate one task status transition.
 * @param current - the task's current status.
 * @param next - the requested status.
 * @returns the transition error, or undefined when allowed.
 */
export function transitionError(current: TaskStatus, next: TaskStatus): string | undefined {
  if (current === next) return undefined
  if (!TASK_TRANSITIONS[current].includes(next)) {
    return `task status cannot move from "${current}" to "${next}"`
  }
  return undefined
}

/** Activate the task's current generation for one owner and return its capability id. */
export function activateTaskAttempt(task: TeamTask, assignee: string): string {
  const attemptId = randomUUID()
  const now = Date.now()
  task.status = 'claimed'
  task.assignee = assignee
  task.attemptId = attemptId
  task.attemptStartedAt = now
  task.attemptHeartbeatAt = now
  task.attemptRuntimeId = PROCESS_RUNTIME_ID
  task.attemptParked = false
  task.attemptParkedAt = undefined
  task.handoffId = undefined
  task.reassigning = false
  task.output = undefined
  task.updatedAt = now
  return attemptId
}

/** Start a fresh task generation for one owner. */
export function beginTaskAttempt(task: TeamTask, assignee: string): string {
  task.attempt = (task.attempt ?? 0) + 1
  return activateTaskAttempt(task, assignee)
}

/**
 * Revoke the current worker immediately. Clearing its capability makes old
 * updates stale; a separate handoff generation serializes async quiescence.
 */
/** Cancel one unfinished task without returning it to the ready pool. */
export function cancelUnfinishedTask(task: TeamTask, output?: string): void {
  if (TERMINAL_TASK_STATUSES.includes(task.status)) return
  task.status = 'cancelled'
  task.attemptId = undefined
  task.attemptParked = false
  task.attemptParkedAt = undefined
  task.handoffId = undefined
  task.reassigning = false
  if (output !== undefined) task.output = output
  task.updatedAt = Date.now()
}

export function invalidateTaskAttempt(
  task: TeamTask,
  nextAssignee?: string,
  reassigning = false,
): void {
  task.attemptId = undefined
  task.attemptStartedAt = undefined
  task.attemptHeartbeatAt = undefined
  task.attemptRuntimeId = undefined
  task.attemptParked = false
  task.attemptParkedAt = undefined
  task.handoffId = randomUUID()
  task.status = 'pending'
  task.assignee = nextAssignee
  task.reassigning = reassigning
  task.output = undefined
  task.updatedAt = Date.now()
}

/**
 * Create the team directory structure and the initial team record.
 * @param stateRoot - resolved absolute state root directory.
 * @param state - the initial team record.
 */
export async function createTeamDir(stateRoot: string, state: TeamState): Promise<void> {
  const dir = join(stateRoot, state.id)
  state.revision = 1
  delete (state as unknown as Record<symbol, number | undefined>)[READ_REVISION]
  await mkdir(join(dir, 'inbox'), { recursive: true })
  await atomicWriteText(join(dir, 'team.json'), JSON.stringify(state, null, 2))
}

/** Symbol carrying the on-disk revision observed at read time. */
const READ_REVISION = Symbol('agent-teams:read-revision')

/**
 * Per-process scheduler runtime identity. Persisted on every attempt so a
 * cold process (or an HMR'd runtime) can distinguish its own parked attempts
 * from another runtime's open work.
 */
const PROCESS_RUNTIME_ID = randomUUID()

/** The current process's AgentTeams scheduler runtime id. */
export function processRuntimeId(): string {
  return PROCESS_RUNTIME_ID
}

/** Error raised when a write would overwrite a concurrently changed team. */
export class TeamConcurrencyError extends Error {
  readonly teamId: string
  readonly expectedRevision: number
  readonly actualRevision: number

  constructor(teamId: string, expectedRevision: number, actualRevision: number) {
    super(`team "${teamId}" changed on disk (revision ${actualRevision}) while this process held revision ${expectedRevision}; refusing to overwrite it`)
    this.name = 'TeamConcurrencyError'
    this.teamId = teamId
    this.expectedRevision = expectedRevision
    this.actualRevision = actualRevision
  }
}

/** Read the persisted revision of one team file (0 for legacy records). */
function revisionOf(value: unknown): number {
  if (typeof value !== 'object' || value === null) return 0
  const revision = (value as { revision?: unknown }).revision
  return typeof revision === 'number' && Number.isInteger(revision) && revision >= 0 ? revision : 0
}

/** Read the persisted revision of one team file (0 for legacy records). */
async function readTeamRevision(stateRoot: string, teamId: string): Promise<number> {
  try {
    const raw = await readFile(join(stateRoot, teamId, 'team.json'), 'utf8')
    return revisionOf(JSON.parse(stripLeadingBom(raw)))
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 0
    }
    throw error
  }
}

/** Attach the on-disk revision to a freshly read record. */
function attachReadRevision<T extends TeamState>(team: T, onDisk: number): T {
  Object.defineProperty(team, READ_REVISION, { value: onDisk, enumerable: false, configurable: true })
  return team
}

/**
 * Read one team record; `undefined` when absent.
 * @param stateRoot - resolved absolute state root directory.
 * @param teamId - the team's sanitized id.
 */
export async function readTeam(stateRoot: string, teamId: string): Promise<TeamState | undefined> {
  try {
    const raw = await readFile(join(stateRoot, teamId, 'team.json'), 'utf8')
    const value: unknown = JSON.parse(stripLeadingBom(raw))
    const team = coerceTeamState(value, teamId)
    if (team === undefined) {
      throw new Error(`invalid AgentTeams state in team "${teamId}"`)
    }
    return attachReadRevision(team, revisionOf(value))
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }
    throw error
  }
}

/** Synchronously read one team record while a continuable child is being
 * composed. Harness requires child setup contributions to be synchronous;
 * this narrow boundary lets a cold-resumed member restore its durable model
 * selection before its first request can be published.
 * @param stateRoot - resolved absolute state root directory.
 * @param teamId - the team's sanitized id.
 * @returns the team record, or `undefined` when absent.
 */
export function readTeamSync(stateRoot: string, teamId: string): TeamState | undefined {
  try {
    const raw = readFileSync(join(stateRoot, teamId, 'team.json'), 'utf8')
    const value: unknown = JSON.parse(stripLeadingBom(raw))
    const team = coerceTeamState(value, teamId)
    if (team === undefined) {
      throw new Error(`invalid AgentTeams state in team "${teamId}"`)
    }
    return attachReadRevision(team, revisionOf(value))
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }
    throw error
  }
}

/**
 * Persist one team record (inside the caller's lock) with compare-and-swap:
 * when the record carries a read-revision (always, via {@link readTeam}), the
 * write refuses to proceed if the on-disk revision moved — protecting teams
 * from cross-process lost updates. The next revision is stamped before the
 * atomic rename.
 * @param stateRoot - resolved absolute state root directory.
 * @param state - the record to persist.
 * @throws {TeamConcurrencyError} when the on-disk revision moved.
 */
export async function writeTeam(stateRoot: string, state: TeamState): Promise<void> {
  const readRevision = (state as unknown as Record<symbol, number | undefined>)[READ_REVISION]
  const onDisk = await readTeamRevision(stateRoot, state.id)
  if (readRevision !== undefined && readRevision !== onDisk) {
    throw new TeamConcurrencyError(state.id, readRevision, onDisk)
  }
  state.revision = onDisk + 1
  delete (state as unknown as Record<symbol, number | undefined>)[READ_REVISION]
  await atomicWriteText(join(stateRoot, state.id, 'team.json'), JSON.stringify(state, null, 2))
}

/** Read the durable set of member session ids retired by remove/delete. */
export async function readRetiredMemberIds(stateRoot: string): Promise<Set<string>> {
  try {
    const parsed: unknown = JSON.parse(stripLeadingBom(
      await readFile(join(stateRoot, RETIRED_MEMBERS_FILE), 'utf8'),
    ))
    if (!Array.isArray(parsed) || parsed.some(value => typeof value !== 'string' || value === '')) {
      throw new Error('invalid AgentTeams retired member index')
    }
    return new Set(parsed)
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return new Set()
    }
    throw error
  }
}

/** Atomically add session ids to the durable retired-member deny-list. */
export async function recordRetiredMemberIds(stateRoot: string, memberIds: readonly string[]): Promise<void> {
  const additions = memberIds.filter(id => id !== '')
  if (additions.length === 0) return
  await withCrossProcessLock(stateRoot, 'retired-members', async () => {
    const retired = await readRetiredMemberIds(stateRoot)
    for (const id of additions) retired.add(id)
    await mkdir(stateRoot, { recursive: true })
    await atomicWriteText(
      join(stateRoot, RETIRED_MEMBERS_FILE),
      `${JSON.stringify([...retired].sort(), null, 2)}\n`,
    )
  })
}

/**
 * Find the team owned by one captain session (at most one per captain).
 * @param stateRoot - resolved absolute state root directory.
 * @param captainSessionId - the owning session id.
 * @returns the team record, or undefined when the captain leads no team.
 */
export async function findTeamByCaptain(
  stateRoot: string,
  captainSessionId: string,
): Promise<TeamState | undefined> {
  let entries
  try {
    entries = await readdir(stateRoot, { withFileTypes: true })
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }
    throw error
  }
  let found: TeamState | undefined
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const team = await readTeam(stateRoot, entry.name)
    if (team?.captainSessionId === captainSessionId) {
      if (found !== undefined && found.id !== team.id) {
        throw new Error(`captain session leads multiple active teams ("${found.id}", "${team.id}"); archive one before continuing`)
      }
      found = team
    }
  }
  return found
}

/**
 * Find the team in which one session is an active participant.
 * Captains match `captainSessionId`; members match their durable child session
 * id. Removed members no longer have access to team-scoped tools.
 * @param stateRoot - resolved absolute state root directory.
 * @param agentSessionId - calling captain/member session id.
 * @returns the team record, or undefined when the caller belongs to no team.
 */
export async function findTeamByParticipant(
  stateRoot: string,
  agentSessionId: string,
): Promise<TeamState | undefined> {
  let entries
  try {
    entries = await readdir(stateRoot, { withFileTypes: true })
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }
    throw error
  }
  let found: TeamState | undefined
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const team = await readTeam(stateRoot, entry.name)
    const participates = team?.captainSessionId === agentSessionId
      || team?.members.some((member) => member.id === agentSessionId && member.status !== 'removed') === true
    if (participates && team !== undefined) {
      if (found !== undefined && found.id !== team.id) {
        throw new Error(`agent session belongs to multiple active teams ("${found.id}", "${team.id}"); the target team is ambiguous`)
      }
      found = team
    }
  }
  return found
}

/** Build a fresh message record. */
export function createMessage(from: string, to: string, content: string): TeamMessage {
  return { id: randomUUID(), from, to, content, ts: Date.now() }
}

/**
 * Append one message to an agent's mailbox (JSONL).
 * @param stateRoot - resolved absolute state root directory.
 * @param teamId - the team id.
 * @param agentKey - `captain` or a member name.
 * @param message - the message to append.
 */
export async function appendMailbox(
  stateRoot: string,
  teamId: string,
  agentKey: string,
  message: TeamMessage,
): Promise<void> {
  const file = join(stateRoot, teamId, 'inbox', `${sanitizeKey(agentKey)}.jsonl`)
  await mkdir(join(stateRoot, teamId, 'inbox'), { recursive: true })
  let existing = ''
  try {
    existing = await readFile(file, 'utf8')
  } catch (error: unknown) {
    if (!(error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT')) {
      throw error
    }
  }
  const separator = existing !== '' && !existing.endsWith('\n') ? '\n' : ''
  await atomicWriteText(file, `${existing}${separator}${JSON.stringify(message)}\n`)
}

/**
 * Read one agent's whole mailbox, oldest first.
 * @param stateRoot - resolved absolute state root directory.
 * @param teamId - the team id.
 * @param agentKey - `captain` or a member name.
 * @param onMalformedLine - optional diagnostic hook; malformed records are
 * skipped so one manually damaged line cannot make the whole team unreadable.
 * @returns the messages, empty when the mailbox does not exist yet.
 */
export async function readMailbox(
  stateRoot: string,
  teamId: string,
  agentKey: string,
  onMalformedLine?: (lineNumber: number, error: unknown) => void,
): Promise<TeamMessage[]> {
  const file = join(stateRoot, teamId, 'inbox', `${sanitizeKey(agentKey)}.jsonl`)
  try {
    const raw = await readFile(file, 'utf8')
    const messages: TeamMessage[] = []
    for (const [index, rawLine] of raw.split('\n').entries()) {
      const line = stripLeadingBom(rawLine)
      if (line.trim() === '') continue
      let value: unknown
      try {
        value = JSON.parse(line)
      } catch {
        onMalformedLine?.(index + 1, new Error('invalid JSON'))
        continue
      }
      if (!isTeamMessage(value)) {
        onMalformedLine?.(index + 1, new Error('invalid message shape'))
        continue
      }
      messages.push(value)
    }
    return messages
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw error
  }
}

/** Read only messages that have not been acknowledged by their recipient. */
export async function readUnreadMailbox(
  stateRoot: string,
  teamId: string,
  agentKey: string,
  onMalformedLine?: (lineNumber: number, error: unknown) => void,
): Promise<TeamMessage[]> {
  const now = Date.now()
  return (await readMailbox(stateRoot, teamId, agentKey, onMalformedLine))
    .filter(message => message.readAt === undefined
      && (message.deliveryClaimedAt === undefined
        || now - message.deliveryClaimedAt >= MAILBOX_DELIVERY_LEASE_MS))
}

async function mutateMailbox(
  stateRoot: string,
  teamId: string,
  agentKey: string,
  messageIds: readonly string[],
  mutate: (message: TeamMessage) => TeamMessage,
): Promise<void> {
  if (messageIds.length === 0) return
  const file = join(stateRoot, teamId, 'inbox', `${sanitizeKey(agentKey)}.jsonl`)
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const selected = new Set(messageIds)
  const lines = raw.split('\n').map((rawLine) => {
    const line = stripLeadingBom(rawLine)
    if (line.trim() === '') return rawLine
    try {
      const value: unknown = JSON.parse(line)
      if (!isTeamMessage(value) || !selected.has(value.id)) return rawLine
      return JSON.stringify(mutate(value))
    } catch {
      return rawLine
    }
  })
  await atomicWriteText(file, lines.join('\n'))
}

/** Lease selected fallback messages to one delivery path. */
export async function claimMailboxDelivery(
  stateRoot: string,
  teamId: string,
  agentKey: string,
  messageIds: readonly string[],
): Promise<void> {
  const now = Date.now()
  await mutateMailbox(stateRoot, teamId, agentKey, messageIds, message => ({
    ...message,
    deliveryClaimedAt: now,
  }))
}

/** Release a failed delivery lease so the scheduler can retry it later. */
export async function releaseMailboxDelivery(
  stateRoot: string,
  teamId: string,
  agentKey: string,
  messageIds: readonly string[],
): Promise<void> {
  await mutateMailbox(stateRoot, teamId, agentKey, messageIds, (message) => {
    const { deliveryClaimedAt: _claimed, ...released } = message
    return released
  })
}

/**
 * Mark selected durable mailbox records delivered/read while preserving
 * malformed lines for diagnostics. Callers serialize this with the team lock.
 */
export async function acknowledgeMailbox(
  stateRoot: string,
  teamId: string,
  agentKey: string,
  messageIds: readonly string[],
): Promise<void> {
  const now = Date.now()
  await mutateMailbox(stateRoot, teamId, agentKey, messageIds, (message) => {
    const { deliveryClaimedAt: _claimed, ...rest } = message
    return {
      ...rest,
      deliveredAt: message.deliveredAt ?? now,
      readAt: message.readAt ?? now,
    }
  })
}

/** Remove the optional UTF-8 BOM some editors prepend to JSON text. */
function stripLeadingBom(value: string): string {
  return value.charCodeAt(0) === 0xFEFF ? value.slice(1) : value
}

/** Rename attempts before falling back to a direct overwrite. */
const ATOMIC_RENAME_RETRIES = 3
/** Pause between rename attempts, giving a briefly-locking owner time to finish. */
const ATOMIC_RENAME_RETRY_DELAY_MS = 50
/**
 * Rename error codes worth retrying before the direct-write fallback. On
 * Windows, replacing an existing file whose target is momentarily held open
 * without FILE_SHARE_DELETE surfaces as EPERM (or EACCES/EBUSY variants);
 * EEXIST/ENOTEMPTY cover other "target busy" edge shapes.
 */
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'EEXIST', 'ENOTEMPTY'])

function isRetryableRenameError(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && RETRYABLE_RENAME_CODES.has((error as NodeJS.ErrnoException).code ?? '')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Filesystem primitives used by {@link replaceFileAtomicOrDirect}; injectable for tests. */
export interface AtomicReplacePrimitives {
  rename: (from: string, to: string) => Promise<void>
  writeFile: (file: string, content: string) => Promise<void>
  remove: (file: string) => Promise<void>
}

/** Tuning knobs for {@link replaceFileAtomicOrDirect} (defaults match production). */
export interface AtomicReplaceOptions {
  /** Rename attempts before the direct-write fallback (default 3). */
  retries?: number
  /** Delay between rename attempts in ms (default 50). */
  retryDelayMs?: number
}

/**
 * Replace `file` with `content`, preferring an atomic same-directory rename of
 * an already-written temp file.
 *
 * On Windows, `rename(tmp, file)` over an existing target throws EPERM while
 * any other process keeps the target open without FILE_SHARE_DELETE (editors,
 * indexers, antivirus scans, preview panes). By that point the payload has
 * already been fully written to the temp file, so a direct overwrite of the
 * target is a content-equivalent degraded path: retry the rename a few times
 * (transient locks clear quickly), then write the target in place. Every path
 * removes the temp file; when both the atomic rename and the direct write
 * fail, the combined error surfaces as an {@link AggregateError}.
 *
 * @returns nothing once the file has been replaced by one of the two paths.
 */
export async function replaceFileAtomicOrDirect(
  temporary: string,
  file: string,
  content: string,
  primitives: AtomicReplacePrimitives,
  options: AtomicReplaceOptions = {},
): Promise<void> {
  const retries = options.retries ?? ATOMIC_RENAME_RETRIES
  const retryDelayMs = options.retryDelayMs ?? ATOMIC_RENAME_RETRY_DELAY_MS
  for (let attempt = 0; ; attempt += 1) {
    try {
      await primitives.rename(temporary, file)
      return
    } catch (error: unknown) {
      if (isRetryableRenameError(error) && attempt < retries) {
        await sleep(retryDelayMs)
        continue
      }
      let fallbackError: unknown
      try {
        await primitives.writeFile(file, content)
      } catch (writeError: unknown) {
        fallbackError = writeError
      }
      await primitives.remove(temporary).catch(() => undefined)
      if (fallbackError !== undefined) {
        throw new AggregateError(
          [error, fallbackError],
          `failed to replace "${file}" atomically (${String(error)}) or by direct write (${String(fallbackError)})`,
        )
      }
      return
    }
  }
}

/**
 * Atomically replace one UTF-8 state file from a same-directory temp file,
 * degrading to a direct overwrite when the atomic rename cannot proceed
 * (see {@link replaceFileAtomicOrDirect} for the Windows EPERM rationale).
 */
async function atomicWriteText(file: string, content: string): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' })
  } catch (error: unknown) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
  await replaceFileAtomicOrDirect(temporary, file, content, {
    rename: (from, to) => rename(from, to),
    writeFile: (target, payload) => writeFile(target, payload, 'utf8'),
    remove: (path) => rm(path, { force: true }),
  })
}

/** Whether a parsed JSON value is a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether a value is an optional string. */
function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string'
}

/** Whether a value is a finite timestamp/counter number. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Validate one member record at the durable JSON boundary. */
function isTeamMember(value: unknown): value is TeamMember {
  if (!isRecord(value)) return false
  return typeof value['id'] === 'string'
    && typeof value['name'] === 'string'
    && value['name'].trim() !== ''
    && isOptionalString(value['role'])
    && isOptionalString(value['provider'])
    && isOptionalString(value['model'])
    && isOptionalString(value['reasoningEffort'])
    && isOptionalString(value['activeProvider'])
    && isOptionalString(value['activeModel'])
    && (value['executionPrompt'] === undefined || typeof value['executionPrompt'] === 'string')
    && (value['fallback'] === undefined || (isRecord(value['fallback']) && typeof value['fallback']['provider'] === 'string' && typeof value['fallback']['model'] === 'string'))
    && (value['fallbackActive'] === undefined || typeof value['fallbackActive'] === 'boolean')
    && isFiniteNumber(value['joinedAt'])
    && (value['status'] === 'idle' || value['status'] === 'working' || value['status'] === 'removed')
}

/** Validate one task record at the durable JSON boundary. */
function isTeamProfileSnapshot(value: unknown): value is TeamProfileSnapshot {
  return isRecord(value)
    && typeof value['name'] === 'string'
    && value['name'].trim() !== ''
    && isOptionalString(value['description'])
    && isOptionalString(value['protocol'])
    && (value['executionPrompt'] === undefined || typeof value['executionPrompt'] === 'string')
    && (value['fallback'] === undefined || (isRecord(value['fallback']) && typeof value['fallback']['provider'] === 'string' && typeof value['fallback']['model'] === 'string'))
    && (value['taskPlanning'] === undefined || value['taskPlanning'] === 'captain' || value['taskPlanning'] === 'seed')
    && (value['reviewPolicy'] === undefined || isReviewPolicy(value['reviewPolicy']))
}

function coerceProfileSnapshot(value: unknown): TeamProfileSnapshot | undefined {
  if (typeof value === 'string') {
    const name = value.trim()
    return name === '' ? undefined : { name }
  }
  if (!isRecord(value)) return undefined
  if (!isTeamProfileSnapshot(value)) return undefined
  return {
    name: value.name.trim(),
    ...value.description === undefined ? {} : { description: value.description },
    ...value.protocol === undefined ? {} : { protocol: value.protocol },
    ...value.taskPlanning === undefined ? {} : { taskPlanning: value.taskPlanning },
  }
}

function coerceTeamState(value: unknown, expectedId: string): TeamState | undefined {
  if (!isRecord(value)) return undefined
  if (value['profile'] !== undefined && !isTeamProfileSnapshot(value['profile']) && typeof value['profile'] !== 'string') {
    const next = { ...value }
    delete next['profile']
    value = next
  } else if (typeof value['profile'] === 'string') {
    const upgraded = coerceProfileSnapshot(value['profile'])
    value = upgraded === undefined
      ? (() => {
        const next = { ...value as Record<string, unknown> }
        delete next['profile']
        return next
      })()
      : { ...value, profile: upgraded }
  }
  if (!isRecord(value) || !Array.isArray(value['tasks'])) {
    return isTeamState(value, expectedId) ? value : undefined
  }
  const tasks = (value['tasks'] as unknown[]).map((task) => {
    if (!isRecord(task)) return task
    // Tolerate legacy dirty records instead of bricking the whole team on
    // reload: blank optional fields written by older builds (or by models that
    // materialize optionals as "") are normalized to omitted, matching the
    // profileSeedId handling below and the tool-input normalization.
    const cleaned = normalizeBlankOptionalTaskFields(task)
    if (cleaned['profileSeedId'] !== undefined && (typeof cleaned['profileSeedId'] !== 'string' || cleaned['profileSeedId'].trim() === '')) {
      const next = { ...cleaned }
      delete next['profileSeedId']
      return next
    }
    return cleaned
  })
  const coerced = { ...value, tasks }
  return isTeamState(coerced, expectedId) ? coerced : undefined
}

export function isTeamTask(value: unknown): value is TeamTask {
  if (!isRecord(value)) return false
  return typeof value['id'] === 'string'
    && isOptionalString(value['profileSeedId'])
    && (value['profileSeedId'] === undefined || value['profileSeedId'].trim() !== '')
    && typeof value['subject'] === 'string'
    && isOptionalString(value['description'])
    && (value['status'] === 'pending'
      || value['status'] === 'claimed'
      || value['status'] === 'in_progress'
      || value['status'] === 'completed'
      || value['status'] === 'failed'
      || value['status'] === 'cancelled')
    && isOptionalString(value['assignee'])
    && Array.isArray(value['dependencies'])
    && value['dependencies'].every((dependency) => typeof dependency === 'string')
    && isOptionalString(value['output'])
    && (value['attempt'] === undefined
      || (Number.isSafeInteger(value['attempt']) && (value['attempt'] as number) >= 0))
    && isOptionalString(value['attemptId'])
    && isOptionalString(value['handoffId'])
    && (value['reassigning'] === undefined || typeof value['reassigning'] === 'boolean')
    && (value['priority'] === undefined
      || value['priority'] === 'low' || value['priority'] === 'normal' || value['priority'] === 'high')
    && (value['deadlineAt'] === undefined || isFiniteNumber(value['deadlineAt']))
    && (value['requiresApproval'] === undefined || typeof value['requiresApproval'] === 'boolean')
    && (value['approvalStatus'] === undefined
      || value['approvalStatus'] === 'awaiting'
      || value['approvalStatus'] === 'approved'
      || value['approvalStatus'] === 'rejected')
    && (value['approvalReason'] === undefined || isOptionalString(value['approvalReason']))
    && (value['approvedAt'] === undefined || isFiniteNumber(value['approvedAt']))
    && (value['evidence'] === undefined || Array.isArray(value['evidence']))
    && (value['artifacts'] === undefined || Array.isArray(value['artifacts']))
    && isFiniteNumber(value['createdAt'])
    && isFiniteNumber(value['updatedAt'])
    && hasValidQualityTaskFields(value)
}

/** Validate the full team record before it can participate in authorization. */
function isTeamState(value: unknown, expectedId: string): value is TeamState {
  if (!isRecord(value)) return false
  const validShape = value['id'] === expectedId
    && typeof value['name'] === 'string'
    && value['name'].trim() !== ''
    && isOptionalString(value['description'])
    && (value['profile'] === undefined || isTeamProfileSnapshot(value['profile']))
    && typeof value['captainSessionId'] === 'string'
    && value['captainSessionId'] !== ''
    && isFiniteNumber(value['createdAt'])
    && Array.isArray(value['members'])
    && value['members'].every(isTeamMember)
    && Array.isArray(value['tasks'])
    && value['tasks'].every(isTeamTask)
    && Number.isSafeInteger(value['taskSeq'])
    && (value['taskSeq'] as number) >= 0
    && (value['phase'] === undefined || value['phase'] === 'staged' || value['phase'] === 'running')
    && (value['planReviewState'] === undefined
      || value['planReviewState'] === 'awaiting_review'
      || value['planReviewState'] === 'awaiting_feedback')
    && (value['approvedAt'] === undefined || isFiniteNumber(value['approvedAt']))
    && (value['halted'] === undefined || typeof value['halted'] === 'boolean')
    && (value['haltedAt'] === undefined || isFiniteNumber(value['haltedAt']))
    && (value['reviewPolicy'] === undefined || isReviewPolicy(value['reviewPolicy']))
    && (value['escalated'] === undefined || typeof value['escalated'] === 'boolean')
    && (value['budgetUsd'] === undefined
      || (typeof value['budgetUsd'] === 'number' && Number.isFinite(value['budgetUsd']) && value['budgetUsd'] >= 0))
    && (value['budgetWarned'] === undefined || typeof value['budgetWarned'] === 'boolean')
  if (!validShape) return false

  const members = value['members'] as TeamMember[]
  const tasks = value['tasks'] as TeamTask[]
  const memberIds = new Set<string>()
  const memberKeys = new Set<string>()
  const staged = value['phase'] === 'staged'
  for (const member of members) {
    const key = sanitizeKey(member.name)
    if ((!staged && member.id === '') || key === CAPTAIN_KEY || memberKeys.has(key)) return false
    if (member.id !== '') {
      if (memberIds.has(member.id)) return false
      memberIds.add(member.id)
    }
    memberKeys.add(key)
  }
  const taskIds = new Set<string>()
  for (const task of tasks) {
    if (task.id === '' || taskIds.has(task.id)) return false
    taskIds.add(task.id)
  }
  return true
}

/** Validate a mailbox record so later rendering cannot crash on `{}`/`null`. */
function isTeamMessage(value: unknown): value is TeamMessage {
  if (!isRecord(value)) return false
  return typeof value['id'] === 'string'
    && typeof value['from'] === 'string'
    && typeof value['to'] === 'string'
    && typeof value['content'] === 'string'
    && isFiniteNumber(value['ts'])
    && (value['deliveryClaimedAt'] === undefined || isFiniteNumber(value['deliveryClaimedAt']))
    && (value['deliveredAt'] === undefined || isFiniteNumber(value['deliveredAt']))
    && (value['readAt'] === undefined || isFiniteNumber(value['readAt']))
}

/**
 * Remove a team's whole directory (members should be interrupted first).
 * @param stateRoot - resolved absolute state root directory.
 * @param teamId - the team id.
 */
export async function removeTeamDir(stateRoot: string, teamId: string): Promise<void> {
  await rm(join(stateRoot, teamId), { recursive: true, force: true })
}

/**
 * `rename` with the same transient retry policy as the state-file atomic
 * write, for paths (like archiving a whole team directory) where there is no
 * content-equivalent direct-write degradation on Windows. A short-lived
 * delete-sharing lock on any file below the renamed path is retried a few
 * times before the error propagates.
 * @param from - source path.
 * @param to - destination path.
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to)
      return
    } catch (error: unknown) {
      if (isRetryableRenameError(error) && attempt < ATOMIC_RENAME_RETRIES) {
        await sleep(ATOMIC_RENAME_RETRY_DELAY_MS)
        continue
      }
      throw error
    }
  }
}

/**
 * Archive a team instead of deleting it: the whole directory (team.json with
 * tasks and dependency graph, plus the mailboxes) moves under
 * `<stateRoot>/archive/<teamId>/` so later sessions can review how tasks were
 * planned and rebuild dependency relationships. The archive directory has no
 * team.json of its own, so the live activity scan skips it naturally.
 * @param stateRoot - resolved absolute state root directory.
 * @param teamId - the team id.
 */
export async function archiveTeamDir(stateRoot: string, teamId: string): Promise<void> {
  const archiveRoot = join(stateRoot, 'archive')
  await mkdir(archiveRoot, { recursive: true })
  const source = join(stateRoot, teamId)
  const target = join(archiveRoot, teamId)
  const previous = join(archiveRoot, `.${teamId}.previous-${randomUUID()}`)
  let displaced = false
  try {
    // The same Windows EPERM-on-rename applies at the directory boundary: a
    // delete-sharing violation on any file below `target` blocks the move, so
    // retry the transient-lock case before giving up.
    await renameWithRetry(target, previous)
    displaced = true
  } catch (error: unknown) {
    // Only ENOENT means there was nothing to displace; any other failure
    // (including a persistent EPERM lock) surfaces to the caller.
    if (!(error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT')) {
      throw error
    }
  }

  try {
    await renameWithRetry(source, target)
  } catch (error: unknown) {
    if (displaced) {
      try {
        await renameWithRetry(previous, target)
      } catch (restoreError: unknown) {
        throw new AggregateError(
          [error, restoreError],
          `failed to archive team "${teamId}" and restore its previous archive`,
        )
      }
    }
    throw error
  }

  // The new generation is authoritative. A failed cleanup only leaves a
  // hidden recovery directory, which archive discovery deliberately ignores.
  if (displaced) await rm(previous, { recursive: true, force: true }).catch(() => undefined)
}

/**
 * Read one archived team (already moved under `archive/`), or undefined when
 * it was never archived.
 * @param stateRoot - resolved absolute state root directory.
 * @param teamId - the team id.
 */
export async function readArchivedTeam(stateRoot: string, teamId: string): Promise<TeamState | undefined> {
  return readTeam(join(stateRoot, 'archive'), teamId)
}

/**
 * List every archived team id under the state root.
 * @param stateRoot - resolved absolute state root directory.
 * @returns the archived team ids, empty when the archive does not exist.
 */
export async function listArchivedTeamIds(stateRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(join(stateRoot, 'archive'), { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw error
  }
}

// ── activity snapshot (server-side, like the Claude Code desktop watcher) ──

/** Visual task state for the activity panel. */
export type VisualTaskState = 'blocked' | 'open' | 'running' | 'completed' | 'failed' | 'cancelled'

/**
 * The visual state of one task: `running` while in_progress, `completed`
 * when done, `failed`/`cancelled` when terminal without success, `blocked`
 * while any dependency is unfinished, else `open`.
 */
export function taskVisualState(
  status: string,
  dependencies: readonly string[],
  tasks: readonly TeamTask[],
): VisualTaskState {
  if (status === 'completed') return 'completed'
  if (status === 'failed') return 'failed'
  if (status === 'cancelled') return 'cancelled'
  if (status === 'in_progress') return 'running'
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const openDependency = dependencies.some((dependencyId) => {
    const dependency = byId.get(dependencyId)
    return dependency !== undefined && dependency.status !== 'completed'
  })
  return openDependency ? 'blocked' : 'open'
}

/**
 * Longest dependency path depth per task id (each depth = one lane column).
 */
export function taskDepthsById(tasks: readonly TeamTask[]): Map<string, number> {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const depths = new Map<string, number>()
  const visiting = new Set<string>()
  const depthOf = (taskId: string): number => {
    const cached = depths.get(taskId)
    if (cached !== undefined) return cached
    if (visiting.has(taskId)) return 0
    const task = byId.get(taskId)
    if (task === undefined) return 0
    visiting.add(taskId)
    const dependencies = task.dependencies
      .filter((dependencyId) => byId.has(dependencyId))
      .sort()
    const depth = dependencies.length === 0
      ? 0
      : 1 + Math.max(...dependencies.map(depthOf))
    visiting.delete(taskId)
    depths.set(taskId, depth)
    return depth
  }
  for (const task of tasks) depthOf(task.id)
  return depths
}
