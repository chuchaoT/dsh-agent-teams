/**
 * Archive replay verification.
 *
 * An archived team bundle is self-describing (manifest.json) but a manifest
 * alone does not prove the bundle is intact. This module verifies the
 * replay contract of an archived run:
 *
 * 1. `manifest.json` exists, parses, and carries `schemaVersion: 1`.
 * 2. Every task's recorded `artifactIds` has its artifact file on disk under
 *    `artifacts/`.
 * 3. `team.json` exists, parses, and matches the manifest's team id.
 * 4. The durable logs (events/telemetry/memory) are present (optional — old
 *    archives predate them) and readable when present.
 *
 * Pure module (node builtins only), unit-testable with temp directories.
 * @module dsh-agent-teams/replay
 */

import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { RunManifest } from './manifest.ts'

/** One problem found while verifying an archived run. */
export interface ReplayIssue {
  readonly code: 'missing-manifest' | 'bad-manifest' | 'missing-team' | 'team-id-mismatch'
    | 'missing-artifact' | 'missing-log' | 'unreadable-log'
  readonly detail: string
}

export interface ReplayVerification {
  readonly ok: boolean
  readonly teamId?: string
  readonly manifest?: RunManifest
  readonly issues: readonly ReplayIssue[]
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}

/**
 * Verify one archived team bundle under the team archive root.
 * @param archiveRoot - the state root's `archive/` directory.
 * @param teamId - the archived team directory name.
 */
export async function verifyArchivedRun(archiveRoot: string, teamId: string): Promise<ReplayVerification> {
  const dir = join(archiveRoot, teamId)
  const issues: ReplayIssue[] = []

  const manifestFile = join(dir, 'manifest.json')
  if (!(await exists(manifestFile))) {
    issues.push({ code: 'missing-manifest', detail: `no manifest.json in ${dir}` })
  }
  let manifest: RunManifest | undefined
  try {
    const raw = await readFile(manifestFile, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || (parsed as RunManifest).schemaVersion !== 1) {
      throw new Error('schemaVersion is not 1')
    }
    manifest = parsed as RunManifest
  } catch (error: unknown) {
    issues.push({
      code: 'bad-manifest',
      detail: error instanceof Error ? error.message : String(error),
    })
  }

  const teamFile = join(dir, 'team.json')
  if (!(await exists(teamFile))) {
    issues.push({ code: 'missing-team', detail: `no team.json in ${dir}` })
  } else if (manifest !== undefined) {
    try {
      const state: unknown = JSON.parse(await readFile(teamFile, 'utf8'))
      const stateId = typeof state === 'object' && state !== null
        ? (state as { id?: unknown }).id
        : undefined
      if (stateId !== manifest.teamId) {
        issues.push({ code: 'team-id-mismatch', detail: `team.json id ${String(stateId)} != manifest ${manifest.teamId}` })
      }
    } catch (error: unknown) {
      issues.push({ code: 'unreadable-log', detail: `team.json unreadable: ${String(error)}` })
    }
  }

  if (manifest !== undefined) {
    for (const task of manifest.tasks) {
      for (const artifactId of task.artifactIds ?? []) {
        const artifactFile = join(dir, 'artifacts', `${artifactId}.json`)
        if (!(await exists(artifactFile))) {
          issues.push({ code: 'missing-artifact', detail: `${task.id} references ${artifactId} but ${artifactFile} is missing` })
        }
      }
    }
    for (const log of ['events.jsonl', 'telemetry.jsonl', 'memory.jsonl']) {
      const logFile = join(dir, log)
      if (await exists(logFile)) {
        try {
          await readFile(logFile, 'utf8')
        } catch (error: unknown) {
          issues.push({ code: 'unreadable-log', detail: `${log} unreadable: ${String(error)}` })
        }
      } else if (log === 'events.jsonl') {
        // events.jsonl is produced by the hardening line; missing means the
        // archive predates it — informational, not a failure.
        issues.push({ code: 'missing-log', detail: `${dir} has no ${log} (pre-hardening archive)` })
      }
    }
  }

  return {
    ok: issues.filter((issue) => issue.code !== 'missing-log').length === 0,
    ...manifest === undefined ? {} : { teamId: manifest.teamId },
    ...manifest === undefined ? {} : { manifest },
    issues,
  }
}
