/**
 * Team memory: the first layer of a layered memory model for AgentTeams.
 *
 * Today team knowledge lives in `team.json` plus per-agent mailboxes and the
 * event log; there is no explicit layered memory, retrieval, or governance.
 * This module is that first layer:
 *
 * - Typed {@link MemoryEntry} records with four scopes (`project`, `team`,
 *   `task`, `decision`), a confidence score 0..1, an optional TTL
 *   (`expiresAt`), provenance (`source`), and a `supersedes` link so a
 *   decision history stays linear (the new record marks the old one
 *   `inactive`).
 * - Keyword retrieval over content via {@link searchMemory} (scope filter,
 *   case-insensitive substring match, active-only by default, `ts`
 *   descending, bounded limit).
 * - Persistence as a per-team append-only JSONL file (`memory.jsonl`) plus an
 *   atomic rewrite path for governance: {@link pruneMemory} folds expiry and
 *   superseding into a bounded inactive tail, then
 *   {@link rewriteMemoryEntries} replaces the file atomically (temp file +
 *   rename, with Windows `EPERM` retries).
 *
 * Future wiring points (this module stays standalone — node builtins only,
 * no imports of other project modules, so it runs in pure unit tests as well
 * as inside the host process):
 * - Task dispatch: call {@link searchMemory} with the relevant
 *   `scopes` (project/team/decision) and splice the top hits into the task
 *   context.
 * - New decisions: {@link createMemoryEntry} + {@link appendMemoryEntry},
 *   passing `supersedes: <previousDecisionId>` to keep the decision trail
 *   linear.
 * - Reads: `readMemoryEntries` -> `pruneMemory` (bounded inactive tail) ->
 *   `rewriteMemoryEntries` when pruning actually removed records.
 * @module dsh-agent-teams/team-memory
 */

import { randomBytes } from 'node:crypto'
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Memory scope: which slice of the team a record describes. */
export type MemoryScope = 'project' | 'team' | 'task' | 'decision'

/** Lifecycle status of a memory record. */
export type MemoryStatus = 'active' | 'inactive'

/** One typed memory record. */
export interface MemoryEntry {
  /** Stable unique id, for example `mem-1720000000000a1b2c3d`. */
  id: string
  /** Epoch milliseconds when the record was created. */
  ts: number
  /** Scope the record belongs to. */
  scope: MemoryScope
  /** Free-form memory content; the granularity is the embedding-less keyword layer. */
  content: string
  /** Who supplied the fact: a human, an agent, the host observing a run, or a quality gate. */
  source?: 'human' | 'agent' | 'observation' | 'gate'
  /** Confidence in the fact, 0..1 (absent means unrated, not zero confidence). */
  confidence?: number
  /** Epoch ms after which the record is obsolete; `expiresAt <= now` expires it. */
  expiresAt?: number
  /** Id of the previous record this one replaces (same scope only). */
  supersedes?: string
  /** Optionally linked task ids, for scoping retrieval back to tasks. */
  relatedTaskIds?: string[]
  /** `active` records participate in retrieval; `inactive` ones are archived. */
  status: MemoryStatus
}

/** Retrieval filters for {@link searchMemory}. */
export interface MemoryQuery {
  /** Only entries in one of these scopes; all scopes when omitted. */
  scopes?: readonly MemoryScope[]
  /** Case-insensitive substring match against `content`; no text filter when omitted. */
  text?: string
  /** Include `inactive` entries in the result (default false). */
  includeInactive?: boolean
  /** Maximum number of results, newest first (default 20). */
  limit?: number
}

const MEMORY_SCOPES: ReadonlySet<string> = new Set(['project', 'team', 'task', 'decision'])

const MEMORY_SOURCES: ReadonlySet<string> = new Set(['human', 'agent', 'observation', 'gate'])

/**
 * Build a complete {@link MemoryEntry} from user input.
 *
 * Defaults: `id` is `mem-<ts><6 hex chars>` where `<ts>` is the (given or
 * now) timestamp, `ts` is `Date.now()`, and `status` is `'active'`. Throws on
 * an unknown `scope` or a `confidence` outside 0..1.
 */
export function createMemoryEntry(
  input: Omit<MemoryEntry, 'id' | 'ts' | 'status'> & { id?: string; ts?: number; status?: MemoryStatus },
): MemoryEntry {
  if (!MEMORY_SCOPES.has(input.scope)) {
    throw new TypeError(`invalid memory scope: ${String(input.scope)}`)
  }
  if (
    input.confidence !== undefined
    && (typeof input.confidence !== 'number'
      || !Number.isFinite(input.confidence)
      || input.confidence < 0
      || input.confidence > 1)
  ) {
    throw new RangeError(`confidence must be a number between 0 and 1, got ${String(input.confidence)}`)
  }
  const ts = input.ts ?? Date.now()
  const id = input.id ?? `mem-${ts}${randomBytes(3).toString('hex')}`
  return {
    id,
    ts,
    scope: input.scope,
    content: input.content,
    source: input.source,
    confidence: input.confidence,
    expiresAt: input.expiresAt,
    supersedes: input.supersedes,
    relatedTaskIds: input.relatedTaskIds,
    status: input.status ?? 'active',
  }
}

/**
 * Keyword retrieval: scope filter, then active-only (unless
 * `includeInactive`), then case-insensitive substring match on `content`.
 * Results are ordered by `ts` descending and capped at `limit` (default 20).
 * The input array is not mutated.
 */
export function searchMemory(entries: readonly MemoryEntry[], query: MemoryQuery): MemoryEntry[] {
  const scopes = query.scopes ? new Set<string>(query.scopes) : null
  const needle = query.text?.toLowerCase()
  const limit = Math.max(0, query.limit ?? 20)
  return entries
    .filter((entry) => {
      if (scopes && !scopes.has(entry.scope)) return false
      if (!query.includeInactive && entry.status !== 'active') return false
      if (needle !== undefined && !entry.content.toLowerCase().includes(needle)) return false
      return true
    })
    .sort((a, b) => b.ts - a.ts)
    .slice(0, limit)
}

/**
 * Governance pass: any entry with `expiresAt <= now` becomes `inactive`.
 * Returns a new array; the input is not mutated (unchanged entries keep
 * their object identity).
 */
export function expireMemory(entries: readonly MemoryEntry[], now: number): MemoryEntry[] {
  return entries.map((entry) =>
    entry.expiresAt !== undefined && entry.expiresAt <= now
      ? { ...entry, status: 'inactive' }
      : entry)
}

/**
 * Governance pass: every entry whose id is named by some other entry's
 * `supersedes` (same scope only) becomes `inactive`. Returns a new array;
 * the input is not mutated.
 */
export function applySupersedes(entries: readonly MemoryEntry[]): MemoryEntry[] {
  const scopeById = new Map<string, MemoryScope>()
  for (const entry of entries) scopeById.set(entry.id, entry.scope)
  const superseded = new Set<string>()
  for (const entry of entries) {
    if (entry.supersedes !== undefined && scopeById.get(entry.supersedes) === entry.scope) {
      superseded.add(entry.supersedes)
    }
  }
  return entries.map((entry) =>
    superseded.has(entry.id) ? { ...entry, status: 'inactive' } : entry)
}

/**
 * Full governance pass: expire, then fold `supersedes`, then bound the
 * inactive tail. All `active` entries are kept; `inactive` entries are kept
 * newest-first up to `keepInactive` (default 200). Returns a new array
 * (active entries in input order, then the retained inactive entries); the
 * input is not mutated.
 */
export function pruneMemory(entries: readonly MemoryEntry[], now: number, keepInactive = 200): MemoryEntry[] {
  const governed = applySupersedes(expireMemory(entries, now))
  const actives = governed.filter((entry) => entry.status === 'active')
  const inactives = governed
    .filter((entry) => entry.status !== 'active')
    .sort((a, b) => b.ts - a.ts)
    .slice(0, Math.max(0, keepInactive))
  return [...actives, ...inactives]
}

/** Per-team append-only team-memory log file name. */
export const TEAM_MEMORY_FILE = 'memory.jsonl'

/**
 * Append one entry as a JSON line to `<stateRoot>/<teamId>/memory.jsonl`.
 * Creates the team directory (and `stateRoot`) when missing. Append-only: a
 * crash can only truncate the tail of one line.
 */
export async function appendMemoryEntry(stateRoot: string, teamId: string, entry: MemoryEntry): Promise<void> {
  const dir = join(stateRoot, teamId)
  await mkdir(dir, { recursive: true })
  await appendFile(join(dir, TEAM_MEMORY_FILE), `${JSON.stringify(entry)}\n`, 'utf8')
}

/** Parse a single JSONL line into an entry, or `null` when the line is not a valid entry. */
function parseMemoryLine(line: string): MemoryEntry | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  if (typeof record.id !== 'string') return null
  if (typeof record.content !== 'string') return null
  if (typeof record.scope !== 'string' || !MEMORY_SCOPES.has(record.scope)) return null
  if (typeof record.ts !== 'number' || !Number.isFinite(record.ts)) return null
  const entry: MemoryEntry = {
    id: record.id,
    ts: record.ts,
    scope: record.scope as MemoryScope,
    content: record.content,
    status: record.status === 'inactive' ? 'inactive' : 'active',
  }
  if (typeof record.source === 'string' && MEMORY_SOURCES.has(record.source)) {
    entry.source = record.source as MemoryEntry['source']
  }
  if (typeof record.confidence === 'number') entry.confidence = record.confidence
  if (typeof record.expiresAt === 'number') entry.expiresAt = record.expiresAt
  if (typeof record.supersedes === 'string') entry.supersedes = record.supersedes
  if (Array.isArray(record.relatedTaskIds) && record.relatedTaskIds.every((x) => typeof x === 'string')) {
    entry.relatedTaskIds = record.relatedTaskIds as string[]
  }
  return entry
}

/**
 * Read the whole per-team memory log. A missing file yields `[]`; torn tail
 * lines, unparsable lines, non-object lines, and lines without a valid
 * `id`/`scope`/`content` are skipped.
 */
export async function readMemoryEntries(stateRoot: string, teamId: string): Promise<MemoryEntry[]> {
  let raw: string
  try {
    raw = await readFile(join(stateRoot, teamId, TEAM_MEMORY_FILE), 'utf8')
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw error
  }
  const entries: MemoryEntry[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === '') continue
    const entry = parseMemoryLine(line)
    if (entry !== null) entries.push(entry)
  }
  return entries
}

/**
 * Atomically replace the team memory file with `entries` (typically the
 * result of `pruneMemory`): write a temp file in the same directory, then
 * rename over the target. Renaming on Windows can transiently fail with
 * `EPERM` when the target is briefly locked (antivirus, readers); it is
 * retried twice with a short backoff before failing. Resolves on success.
 */
export async function rewriteMemoryEntries(
  stateRoot: string,
  teamId: string,
  entries: readonly MemoryEntry[],
): Promise<void> {
  const dir = join(stateRoot, teamId)
  await mkdir(dir, { recursive: true })
  const target = join(dir, TEAM_MEMORY_FILE)
  const temp = join(dir, `.${TEAM_MEMORY_FILE}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`)
  const payload = entries.length
    ? `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`
    : ''
  await writeFile(temp, payload, 'utf8')
  try {
    let lastError: unknown
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await rename(temp, target)
        return
      } catch (error: unknown) {
        lastError = error
        const code = error instanceof Error && 'code' in error
          ? (error as NodeJS.ErrnoException).code
          : undefined
        if (code !== 'EPERM' && code !== 'EACCES') throw error
        await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)))
      }
    }
    throw lastError
  } catch (error: unknown) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}
