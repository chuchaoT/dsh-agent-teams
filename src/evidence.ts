/**
 * First layer of the two-layer evidence model for AgentTeams quality gates.
 *
 * Layer 1 (this module): the data model and pure helpers that represent what
 * a member *declares* it ran (model self-report) and what the host *factually
 * observed* (exit codes, durations, stdout hashes, previews). Declared
 * results are weak evidence; host observations are strong evidence and take
 * precedence whenever both exist.
 *
 * Layer 2 (future wiring, not implemented here): the tool layer collects host
 * observations when it actually executes a command (or asks the host to),
 * converts them with {@link normalizeCommandEvidence}, stores them as
 * {@link EvidenceRecord}s, and feeds {@link summarizeEvidence} /
 * {@link isEvidenceComplete} into the quality gates. This module is the
 * intended entry point for that wiring: it depends only on `node:` builtins
 * and stays free of DSH packages, so it runs in pure unit tests as well as
 * inside the host process.
 * @module dsh-agent-teams/evidence
 */

import { createHash } from 'node:crypto'

/** What kind of fact one evidence record captures. */
export type EvidenceKind = 'command' | 'diff' | 'artifact' | 'verification'

/** Who produced the evidence: the host (factual) or a member (declared). */
export type EvidenceProducer = 'host' | 'member'

/** Whether a command evidence record passed, failed, or was never observed. */
export type CommandStatus = 'passed' | 'failed' | 'unobserved'

/** One evidence record attached to a team task attempt. */
export interface EvidenceRecord {
  /** Stable unique id, for example `ev:cmd:1`. */
  id: string
  /** Epoch milliseconds when the evidence was recorded. */
  ts: number
  /** Team id the record belongs to. */
  teamId: string
  /** Task id the record belongs to. */
  taskId: string
  /** Attempt id the record belongs to; absent for records outside an attempt. */
  attemptId?: string
  /** Fact category: a command result, a diff, an artifact, or an acceptance check. */
  kind: EvidenceKind
  /** Short human-readable summary, for example `pnpm test: exit 0`. */
  summary: string
  /** Fact producer. `host` records are observed; `member` records are declared. */
  producer: EvidenceProducer
  /** Optional machine-readable source reference, for example a log path or URL. */
  source?: string
  /** Optional structured payload; for `command` records a {@link CommandEvidence}. */
  detail?: unknown
}

/** A command result after normalization (declared and/or host-observed). */
export interface CommandEvidence {
  /** The exact command string that was executed (or claimed to be). */
  command: string
  /** Observed exit code; `null` when no exit code is known (member declaration without a host run). */
  exitCode: number | null
  /** Observed wall-clock duration in ms; `0` when unknown (member declaration). */
  durationMs: number
  /** SHA-256 hex digest of the full stdout, when observed. */
  stdoutSha256?: string
  /** Short stdout preview, truncated by the collection layer. */
  stdoutPreview?: string
  /** Short stderr preview, truncated by the collection layer. */
  stderrPreview?: string
  /** Passed when exit code is 0; failed otherwise; unobserved for untrusted declarations. */
  status: CommandStatus
  /** Who vouches for this record: the host observed it, or the member declared it. */
  observedBy: 'host' | 'member'
}

/** Shape of a member's self-reported command result (weak evidence). */
export interface ReportedCommand {
  /** The command string the member claims to have run. */
  command: string
  /** Declared status; anything other than the three legal values is treated as `unobserved`. */
  status?: string
  /** Declared exit code, if the member chose to include one. */
  exitCode?: number
  /** Free-text declaration evidence, for example `see output above`. */
  evidence?: string
}

/** Shape of a host observation captured when a command actually ran (strong evidence). */
export interface HostCommandObservation {
  /** Exit code as seen by the host. */
  exitCode: number
  /** Wall-clock duration in ms as measured by the host. */
  durationMs: number
  /** SHA-256 hex digest of the full stdout captured by the host. */
  stdoutSha256: string
  /** Short stdout preview captured by the host (already truncated). */
  stdoutPreview: string
  /** Short stderr preview captured by the host (already truncated). */
  stderrPreview: string
}

/** SHA-256 hex digest of `text` (UTF-8). */
export function hashSha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * Merge a member declaration with an optional host observation.
 *
 * When `observed` is present the host observation wins: `observedBy` is
 * `'host'` and `status` is derived from the observed exit code (0 -> passed,
 * anything else -> failed). When it is missing the result is a member
 * declaration: `observedBy` is `'member'`, `status` is whatever legal value
 * (`passed` | `failed` | `unobserved`) the member declared (illegal or
 * missing values become `unobserved`), and `durationMs` is 0 because no host
 * timing exists.
 */
export function normalizeCommandEvidence(
  reported: ReportedCommand,
  observed?: HostCommandObservation,
): CommandEvidence {
  if (observed) {
    return {
      command: reported.command,
      exitCode: observed.exitCode,
      durationMs: observed.durationMs,
      stdoutSha256: observed.stdoutSha256,
      stdoutPreview: observed.stdoutPreview,
      stderrPreview: observed.stderrPreview,
      status: observed.exitCode === 0 ? 'passed' : 'failed',
      observedBy: 'host',
    }
  }
  const status = reported.status === 'passed' || reported.status === 'failed' ? reported.status : 'unobserved'
  return {
    command: reported.command,
    exitCode: reported.exitCode ?? null,
    durationMs: 0,
    status,
    observedBy: 'member',
  }
}

/**
 * Render one evidence record as a single display line.
 *
 * Command records with a structured `detail` produce:
 *   `<command>: exit=<code>, <duration>ms, sha:<hash8>`
 * where `<code>` is the observed exit code or `null`, `<duration>` the
 * observed duration in ms, and `<hash8>` the first 8 hex chars of the stdout
 * SHA-256 (or `-` when absent). Any other record produces `[<kind>] <summary>`.
 */
function evidenceLine(record: EvidenceRecord): string {
  if (record.kind === 'command' && record.detail !== null && typeof record.detail === 'object') {
    const detail = record.detail as Record<string, unknown>
    if (typeof detail.command === 'string') {
      const code = typeof detail.exitCode === 'number' ? String(detail.exitCode) : 'null'
      const ms = typeof detail.durationMs === 'number' ? `${detail.durationMs}ms` : '?'
      const sha8 = typeof detail.stdoutSha256 === 'string' ? detail.stdoutSha256.slice(0, 8) : '-'
      return `${detail.command}: exit=${code}, ${ms}, sha:${sha8}`
    }
  }
  const summary = record.summary.length > 80 ? `${record.summary.slice(0, 80)}…` : record.summary
  return `[${record.kind}] ${summary}`
}

/**
 * Build a human/gate-readable evidence summary, one line per record, capped
 * at `maxChars` (cut at a line boundary; an ellipsis marks truncation).
 * Returns '' for an empty record list.
 */
export function summarizeEvidence(records: readonly EvidenceRecord[], maxChars = 600): string {
  if (records.length === 0) return ''
  const full = records.map(evidenceLine).join('\n')
  if (full.length <= maxChars) return full
  const budget = Math.max(0, maxChars - 1)
  const cut = full.lastIndexOf('\n', budget)
  const end = cut < 0 ? budget : cut
  return `${full.slice(0, end)}…`
}

/**
 * True when every command in `expectedCommands` has a matching evidence
 * record (exact `command` match against the `detail.command` of records whose
 * `kind` is `'command'`). An empty expected list is vacuously complete.
 */
export function isEvidenceComplete(records: readonly EvidenceRecord[], expectedCommands: readonly string[]): boolean {
  if (expectedCommands.length === 0) return true
  const found = new Set<string>()
  for (const record of records) {
    if (record.kind !== 'command' || record.detail === null || typeof record.detail !== 'object') continue
    const command = (record.detail as { command?: unknown }).command
    if (typeof command === 'string') found.add(command)
  }
  return expectedCommands.every((command) => found.has(command))
}

/** Policy controlling what evidence the tool layer should collect. */
export interface EvidencePolicy {
  /** Whether host observations are collected at all. */
  collectHost: boolean
  /** Whether an exit code is required for a command record to be trusted. */
  requireExitCode: boolean
  /** Maximum number of preview chars to keep (1-20000). */
  maxPreviewChars: number
  /** Commands the gate is allowed to run; an empty array means unrestricted. */
  allowedCommands?: readonly string[]
}

/**
 * Validate an evidence policy and return a list of human-readable problems
 * (empty list means the policy is valid). `allowedCommands: []` is treated as
 * "unrestricted" and is not an error; `collectHost: false` forces
 * `requireExitCode: false`; `maxPreviewChars` must be an integer in
 * [1, 20000].
 */
export function validateEvidencePolicy(policy: EvidencePolicy): string[] {
  const errors: string[] = []
  if (!policy.collectHost && policy.requireExitCode) {
    errors.push('requireExitCode requires collectHost=true')
  }
  if (!Number.isInteger(policy.maxPreviewChars) || policy.maxPreviewChars < 1 || policy.maxPreviewChars > 20000) {
    errors.push('maxPreviewChars must be an integer between 1 and 20000')
  }
  if (policy.allowedCommands?.some((command) => typeof command !== 'string' || command.length === 0)) {
    errors.push('allowedCommands must not contain empty strings')
  }
  return errors
}
