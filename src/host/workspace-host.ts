/**
 * Workspace resolution facade.
 *
 * The plugin previously fell back to `process.cwd()` in several places with
 * slightly different semantics, which is ambiguous under multi-workspace
 * hosts and test fixtures. This facade centralizes resolution: prefer the
 * workspace registry, then the caller-supplied cwd, then the process cwd as
 * a last resort — and exposes a single documented failure mode.
 *
 * @module dsh-agent-teams/host/workspace-host
 */

import type { Context } from '@deepseek-ai/cordis'
import { resolveWorkspaceKey } from './capabilities.ts'

/** A workspace-registry entry as consumed by the facade. */
export interface WorkspaceEntry {
  title: string
  path: string
}

/** Minimal shape of the workspace registry service. */
export interface WorkspaceRegistryLike {
  list(): readonly WorkspaceEntry[]
}

/**
 * Resolve the workspace registry service, or undefined in headless/webless
 * compositions.
 */
export function resolveWorkspaceRegistry(ctx: Context): WorkspaceRegistryLike | undefined {
  const key = resolveWorkspaceKey(ctx)
  if (key === undefined) return undefined
  const service = ctx.get(key) as WorkspaceRegistryLike | undefined
  if (service === undefined) return undefined
  if (typeof service.list !== 'function') {
    ctx.logger.warn(`agent-teams: workspace service "${key}" has no list(); treating as headless`)
    return undefined
  }
  return service
}

export interface WorkspaceResolution {
  /** Best resolved absolute workspace directory. */
  workspace: string
  /** Human title when matched via the registry, else the workspace path. */
  title: string
  /** Whether the registry could anchor the workspace. */
  registryMatch: boolean
}

/**
 * Resolve the workspace for a caller whose session carries a working
 * directory, degrading gracefully to the process cwd only when no better
 * anchor exists.
 * @param ctx - plugin context (for logging).
 * @param preferred - caller-session cwd, when available.
 */
export function resolveWorkspace(ctx: Context, preferred: string | undefined): WorkspaceResolution {
  const registry = resolveWorkspaceRegistry(ctx)
  const candidate = preferred?.trim() === '' ? undefined : preferred
  if (registry !== undefined && candidate !== undefined) {
    for (const entry of registry.list()) {
      const entryPath = entry.path.replace(/[\\/]+$/, '')
      const candidatePath = candidate.replace(/[\\/]+$/, '')
      if (candidatePath === entryPath || candidatePath.startsWith(`${entryPath}\\`) || candidatePath.startsWith(`${entryPath}/`)) {
        return { workspace: entry.path, title: entry.title, registryMatch: true }
      }
    }
  }
  if (candidate !== undefined) {
    return { workspace: candidate, title: candidate, registryMatch: false }
  }
  const fallback = process.cwd()
  ctx.logger.debug('agent-teams: workspace fell back to process.cwd()')
  return { workspace: fallback, title: fallback, registryMatch: false }
}
