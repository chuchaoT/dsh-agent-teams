/**
 * Run telemetry (runtime observability) for AgentTeams: the data model plus
 * pure computation for provider/model/effort, token usage, duration, queue
 * wait, and estimated cost per attempt.
 *
 * This module is intentionally self-contained: no imports at all (no DSH
 * packages, no other src modules, no node builtins) so it runs in plain
 * `node --test` unit tests via type stripping as well as inside the host
 * process. The scheduling / member layer wires it up later; nothing here
 * touches DSH or the team state.
 *
 * Wiring points (future work, NOT implemented here):
 * - Member lifecycle: create an `attempt_started` record when a member claims
 *   a task and an `attempt_finished` record when the attempt settles
 *   (completed, failed, or fallback-switched), attaching provider/model/
 *   effort and token usage.
 * - Scheduler: create a `task_queue_wait` record with `queuedAt`/`startedAt`
 *   so queue wait time can be derived.
 * - Gates / fallback: create `gate_result` and `fallback_switch` records.
 * - Persistence: write records into the team's telemetry directory (e.g.
 *   `telemetry/<teamId>.jsonl`), kept out of the state snapshot and appended
 *   from the wiring points above.
 * - Consumption: the panel/status layer reads stored records and renders them
 *   through {@link summarizeTelemetry} (human-readable lines) and
 *   {@link totalsOf} (aggregates for charts / cost dashboards).
 *
 * Statistics basis of {@link totalsOf} (single-attempt membership):
 * - `attempts`: distinct attempt records among `attempt_started` /
 *   `attempt_finished` kinds, keyed by `memberName|taskId|attemptId` (when
 *   `attemptId` is absent the key falls back to `memberName|taskId|-`, the
 *   simplified member/task dedupe). When both a started and a finished record
 *   share a key, `attempt_finished` wins and the pair counts once.
 * - `totalTokens` / `totalDurationMs` / `totalCostUsd`: plain sums over every
 *   record. Wiring convention: put attempt metrics on `attempt_finished`, so
 *   a started/finished pair does not double-count the same attempt.
 * - `byKind`: record count per kind, over every record.
 * - `byModel`: per-model sums of tokens/cost over every record carrying that
 *   model (records without a model bucket under `(unknown)`); `attempts` =
 *   distinct attempts attributed to that model with the same dedupe rule.
 * @module dsh-agent-teams/telemetry
 */

/** All lifecycle kinds a telemetry record can capture. */
export type TelemetryKind =
  | 'attempt_started'
  | 'attempt_finished'
  | 'task_queue_wait'
  | 'gate_result'
  | 'fallback_switch'
  | 'run_summary'

/** The six legal kinds; used to validate {@link createTelemetryRecord} input. */
const TELEMETRY_KINDS: readonly TelemetryKind[] = [
  'attempt_started',
  'attempt_finished',
  'task_queue_wait',
  'gate_result',
  'fallback_switch',
  'run_summary',
]

/**
 * One telemetry observation attached to a team run.
 *
 * `id`, `ts`, `teamId` and `kind` are required; everything else is optional so
 * a single interface covers sparse early events (a start has no token/cost
 * data) and rich finished events alike. `labels` is a free-form bag for
 * dashboards and panels.
 */
export interface RunTelemetryRecord {
  /** Stable unique id, for example `tl-1738000000000-a1b2c3`. */
  id: string
  /** Epoch milliseconds when the record was created. */
  ts: number
  /** Team id the record belongs to. */
  teamId: string
  /** Task id the record belongs to; absent for team-wide records. */
  taskId?: string
  /** Attempt id the record belongs to; absent outside an attempt. */
  attemptId?: string
  /** Name of the member that produced the observation. */
  memberName?: string
  /** Lifecycle point this record captures. */
  kind: TelemetryKind
  /** Provider id used for the attempt, for example `deepseek`. */
  provider?: string
  /** Model id used for the attempt, for example `deepseek-v4-flash`. */
  model?: string
  /** Reasoning effort id used for the attempt, for example `high`. */
  reasoningEffort?: string
  /** Epoch ms when the work entered the task queue. */
  queuedAt?: number
  /** Epoch ms when the attempt actually started running. */
  startedAt?: number
  /** Epoch ms when the attempt finished. */
  finishedAt?: number
  /** Wall-clock duration of the attempt in milliseconds. */
  durationMs?: number
  /** Input tokens consumed by the attempt. */
  inputTokens?: number
  /** Output tokens produced by the attempt. */
  outputTokens?: number
  /** Total tokens (input + output); set on `attempt_finished` records. */
  totalTokens?: number
  /** Estimated cost in USD for the attempt. */
  estimatedCostUsd?: number
  /** How many retries the attempt needed (0 = first try). */
  retryCount?: number
  /** Previous model/provider when a fallback happened. */
  fallbackFrom?: string
  /** Model/provider that took over after a fallback. */
  fallbackTo?: string
  /** Outcome of a quality gate (e.g. `pass`/`fail`). */
  gateVerdict?: string
  /** Machine-readable error code when the attempt failed. */
  errorCode?: string
  /** Free-form key/value labels for dashboards and panels. */
  labels?: Record<string, string>
}

/**
 * Create a telemetry record, filling `id` and `ts` when absent.
 *
 * Default `id` is `tl-<ts>-<6 hex chars>` (timestamp is the resolved `ts`),
 * default `ts` is `Date.now()`. Throws when `kind` is not a legal
 * {@link TelemetryKind}.
 */
export function createTelemetryRecord(
  input: Omit<RunTelemetryRecord, 'id' | 'ts'> & { id?: string; ts?: number },
): RunTelemetryRecord {
  const ts = input.ts ?? Date.now()
  const id = input.id ?? `tl-${ts}-${Math.floor(Math.random() * 0x1000000).toString(16).padStart(6, '0')}`
  if (!TELEMETRY_KINDS.includes(input.kind)) {
    throw new Error(`unknown telemetry kind: ${String(input.kind)}`)
  }
  return { ...input, id, ts }
}

/**
 * Compute total tokens from input/output token counts.
 *
 * Returns `undefined` when either count is missing, so callers can treat
 * `unknown` the same as `absent` without inventing zeroes.
 */
export function computeAttemptTokens(
  inputTokens?: number,
  outputTokens?: number,
): { totalTokens: number } | undefined {
  if (inputTokens === undefined || outputTokens === undefined) return undefined
  return { totalTokens: inputTokens + outputTokens }
}

/** Result of {@link estimateCostUsd}. */
export interface CostEstimate {
  /** Estimated cost in USD, rounded to 6 decimal places. */
  estimatedCostUsd: number
  /** Input tokens the estimate was based on. */
  inputTokens: number
  /** Output tokens the estimate was based on. */
  outputTokens: number
  /**
   * Blended per-million-token rate implied by the estimate, calculated as
   * `estimatedCostUsd / (totalTokens / 1_000_000)` and rounded to 6 decimal
   * places; `0` when the attempt consumed no tokens.
   */
  effectiveRate: number
}

/** Default USD input rate per million tokens. */
const DEFAULT_INPUT_RATE_PER_MILLION = 0.5

/** Default USD output rate per million tokens. */
const DEFAULT_OUTPUT_RATE_PER_MILLION = 1.5

/** Round to 6 decimal places (the smallest meaningful fraction of a USD cent). */
function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}

function requireNonNegative(name: string, value: number): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number`)
  }
}

/**
 * Estimate the USD cost of one attempt from token usage.
 *
 * Defaults to `inputRatePerMillion = 0.5` and `outputRatePerMillion = 1.5`
 * (typical cheap-LLM USD pricing); both are per million tokens. Validates
 * that all four inputs are non-negative finite numbers and throws otherwise.
 * The result is rounded to 6 decimal places.
 */
export function estimateCostUsd(input: {
  inputTokens: number
  outputTokens: number
  inputRatePerMillion?: number
  outputRatePerMillion?: number
}): CostEstimate {
  const inputRate = input.inputRatePerMillion ?? DEFAULT_INPUT_RATE_PER_MILLION
  const outputRate = input.outputRatePerMillion ?? DEFAULT_OUTPUT_RATE_PER_MILLION
  requireNonNegative('inputTokens', input.inputTokens)
  requireNonNegative('outputTokens', input.outputTokens)
  requireNonNegative('inputRatePerMillion', inputRate)
  requireNonNegative('outputRatePerMillion', outputRate)
  const estimatedCostUsd = round6(
    (input.inputTokens / 1_000_000) * inputRate
    + (input.outputTokens / 1_000_000) * outputRate,
  )
  const totalTokens = input.inputTokens + input.outputTokens
  return {
    estimatedCostUsd,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    effectiveRate: totalTokens === 0 ? 0 : round6(estimatedCostUsd / (totalTokens / 1_000_000)),
  }
}

/** Max characters per rendered summary line (an ellipsis marks truncation). */
const SUMMARY_LINE_LIMIT = 120

/** Max lines in a summary; the remainder is collapsed into `... and N more`. */
const SUMMARY_MAX_LINES = 12

/** Render one record as a single human-readable line, truncated to 120 chars. */
function renderTelemetryLine(record: RunTelemetryRecord): string {
  const scope = `${record.teamId}/${record.taskId ?? '-'}/${record.attemptId ?? '-'}`
  const parts: string[] = [`${scope} [${record.kind}]:`]
  if (record.model !== undefined) parts.push(record.model)
  if (record.totalTokens !== undefined) parts.push(`${record.totalTokens} tokens`)
  if (record.durationMs !== undefined) parts.push(`${record.durationMs}ms`)
  if (record.estimatedCostUsd !== undefined) parts.push(`~$${record.estimatedCostUsd}`)
  const line = parts.join(' ')
  if (line.length <= SUMMARY_LINE_LIMIT) return line
  return `${line.slice(0, SUMMARY_LINE_LIMIT - 1)}…`
}

/**
 * Render a human-readable, line-per-attempt summary of telemetry records.
 *
 * Line shape is `team/task/attempt [kind]: model N tokens Xms ~$cost`; fields
 * that are absent are simply omitted. Each line is truncated to 120
 * characters and the summary is capped at 12 lines; records beyond the cap
 * are reported as `... and N more`. Returns `''` for no records.
 */
export function summarizeTelemetry(records: readonly RunTelemetryRecord[]): string {
  if (records.length === 0) return ''
  const lines = records.slice(0, SUMMARY_MAX_LINES).map(renderTelemetryLine)
  const more = records.length - SUMMARY_MAX_LINES
  if (more > 0) lines.push(`... and ${more} more`)
  return lines.join('\n')
}

/** Per-model attribution bucket used by {@link totalsOf}. */
export interface ModelAttribution {
  /** Distinct attempts performed with this model (deduped as documented above). */
  attempts: number
  /** Sum of `totalTokens` over records carrying this model. */
  tokens: number
  /** Sum of `estimatedCostUsd` over records carrying this model. */
  costUsd: number
}

/**
 * Whether a run has spent the whole budget (or more). An unset/negative/
 * non-finite budget never trips; a zero budget trips at the first cent
 * spent, and zero spend never trips even against a zero budget.
 */
export function budgetExceeded(costUsd: number, budgetUsd: number | undefined): boolean {
  if (budgetUsd === undefined || !Number.isFinite(budgetUsd) || budgetUsd < 0) return false
  if (!Number.isFinite(costUsd) || costUsd < 0) return false
  return costUsd > 0 && costUsd >= budgetUsd
}

/** Aggregates produced by {@link totalsOf}. */
export interface TelemetryTotals {
  /** Distinct attempts (deduped, `attempt_finished` preferred). */
  attempts: number
  /** Sum of `totalTokens` over every record. */
  totalTokens: number
  /** Sum of `durationMs` over every record. */
  totalDurationMs: number
  /** Sum of `estimatedCostUsd` over every record, rounded to 6 decimals. */
  totalCostUsd: number
  /** Record count per kind (only kinds actually present). */
  byKind: Record<string, number>
  /** Per-model attribution; records without a model bucket under `(unknown)`. */
  byModel: Record<string, ModelAttribution>
}

/** Bucket used for records without a model id. */
const UNKNOWN_MODEL = '(unknown)'

/**
 * Aggregate telemetry records for dashboards and the status panel.
 *
 * See the module JSDoc for the exact statistics basis (attempt membership,
 * dedupe, unknown-model bucketing, rounding).
 */
export function totalsOf(records: readonly RunTelemetryRecord[]): TelemetryTotals {
  let totalTokens = 0
  let totalDurationMs = 0
  let totalCostUsd = 0
  const byKind: Record<string, number> = {}
  const byModel: Record<string, ModelAttribution> = {}
  const attempts = new Map<string, RunTelemetryRecord>()

  for (const record of records) {
    totalTokens += record.totalTokens ?? 0
    totalDurationMs += record.durationMs ?? 0
    totalCostUsd += record.estimatedCostUsd ?? 0
    byKind[record.kind] = (byKind[record.kind] ?? 0) + 1

    const model = record.model ?? UNKNOWN_MODEL
    const attribution = byModel[model] ?? { attempts: 0, tokens: 0, costUsd: 0 }
    attribution.tokens += record.totalTokens ?? 0
    attribution.costUsd += record.estimatedCostUsd ?? 0
    byModel[model] = attribution

    if (record.kind === 'attempt_started' || record.kind === 'attempt_finished') {
      const key = `${record.memberName ?? '-'}|${record.taskId ?? '-'}|${record.attemptId ?? '-'}`
      const existing = attempts.get(key)
      if (existing === undefined || existing.kind === 'attempt_started') {
        attempts.set(key, record)
      }
    }
  }

  let attemptCount = 0
  for (const record of attempts.values()) {
    attemptCount += 1
    const model = record.model ?? UNKNOWN_MODEL
    const attribution = byModel[model] ?? { attempts: 0, tokens: 0, costUsd: 0 }
    attribution.attempts += 1
    byModel[model] = attribution
  }

  return {
    attempts: attemptCount,
    totalTokens,
    totalDurationMs,
    totalCostUsd: round6(totalCostUsd),
    byKind,
    byModel,
  }
}
