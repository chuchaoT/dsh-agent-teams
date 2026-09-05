/**
 * Tool input parsers — the pure validation/normalization layer between
 * model-facing tool arguments and durable task fields.
 *
 * Extracted from the monolith `tools.ts` (hardening pass) so the parsers can
 * be unit-tested in isolation and reused by future hosts (headless CLI,
 * direct tool clients, staged-plan Web surface). All functions are pure:
 * they never read team state or touch the host.
 *
 * @module dsh-agent-teams/tools-parse
 */

import type { AcceptanceResult, CommandResult, ReviewFinding } from './types.ts'
import {
  normalizeCommandEvidence,
  summarizeEvidence,
  type EvidenceRecord,
} from './evidence.ts'

export function parseFindings(value: unknown): ReviewFinding[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error('findings must be an array')
  return value.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(`findings[${index}] must be an object`)
    }
    const raw = item as Record<string, unknown>
    if (typeof raw['id'] !== 'string' || raw['id'].trim() === '') throw new Error(`findings[${index}].id is required`)
    if (raw['severity'] !== 'low' && raw['severity'] !== 'medium' && raw['severity'] !== 'high' && raw['severity'] !== 'blocker') {
      throw new Error(`findings[${index}].severity is invalid`)
    }
    if (typeof raw['problem'] !== 'string' || raw['problem'].trim() === '') throw new Error(`findings[${index}].problem is required`)
    if (typeof raw['requiredFix'] !== 'string' || raw['requiredFix'].trim() === '') throw new Error(`findings[${index}].requiredFix is required`)
    return {
      id: raw['id'].trim(),
      severity: raw['severity'],
      problem: raw['problem'],
      requiredFix: raw['requiredFix'],
      // A blank optional file must be omitted, not persisted: durable-state
      // validation requires non-empty optional strings (issue #105 class).
      ...typeof raw['file'] === 'string' && raw['file'].trim() !== '' ? { file: raw['file'] } : {},
      ...typeof raw['line'] === 'number' ? { line: raw['line'] } : {},
      ...typeof raw['resolved'] === 'boolean' ? { resolved: raw['resolved'] } : {},
    }
  })
}

export function parseAcceptanceResults(value: unknown): AcceptanceResult[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error('acceptanceResults must be an array')
  return value.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(`acceptanceResults[${index}] must be an object`)
    }
    const raw = item as Record<string, unknown>
    if (typeof raw['criterion'] !== 'string' || raw['criterion'].trim() === '') {
      throw new Error(`acceptanceResults[${index}].criterion is required`)
    }
    if (raw['status'] !== 'passed' && raw['status'] !== 'failed') {
      throw new Error(`acceptanceResults[${index}].status must be passed or failed`)
    }
    return {
      criterion: raw['criterion'],
      status: raw['status'],
      ...typeof raw['evidence'] === 'string' ? { evidence: raw['evidence'] } : {},
    }
  })
}

export function parseCommandResults(value: unknown): CommandResult[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error('commandsRun must be an array')
  return value.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error(`commandsRun[${index}] must be an object`)
    }
    const raw = item as Record<string, unknown>
    if (typeof raw['command'] !== 'string' || raw['command'].trim() === '') {
      throw new Error(`commandsRun[${index}].command is required`)
    }
    if (raw['status'] !== 'passed' && raw['status'] !== 'failed') {
      throw new Error(`commandsRun[${index}].status must be passed or failed`)
    }
    return {
      command: raw['command'],
      status: raw['status'],
      ...typeof raw['exitCode'] === 'number' ? { exitCode: raw['exitCode'] } : {},
      ...typeof raw['evidence'] === 'string' ? { evidence: raw['evidence'] } : {},
    }
  })
}

/**
 * Normalize model-declared command results into audit evidence records.
 *
 * This is the member-declaration branch of the two-layer evidence model. When
 * a host observation (exit code/duration/stdout hash) becomes available at the
 * real command execution site, the same record is upgraded via the `host`
 * branch of `normalizeCommandEvidence` — member declarations are weak
 * evidence and must not be treated as host-verified results.
 */
export function buildCommandEvidence(
  teamId: string,
  taskId: string,
  attemptId: string | undefined,
  commands: readonly CommandResult[],
): EvidenceRecord[] {
  return commands.map((command, index) => {
    const normalized = normalizeCommandEvidence({
      command: command.command,
      status: command.status,
      ...command.exitCode === undefined ? {} : { exitCode: command.exitCode },
      ...command.evidence === undefined ? {} : { evidence: command.evidence },
    })
    return {
      id: `ev:cmd:${taskId}:${index}`,
      ts: Date.now(),
      teamId,
      taskId,
      ...attemptId === undefined ? {} : { attemptId },
      kind: 'command',
      summary: `${command.command}: ${normalized.status}`,
      producer: normalized.observedBy,
      detail: normalized,
    }
  })
}

/** Re-export for callers computing human-readable evidence summaries. */
export { summarizeEvidence }
