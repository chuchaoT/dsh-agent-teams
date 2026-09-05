/**
 * DSH host capability detection and compatibility gate.
 *
 * AgentTeams talks to host-plane services through a narrow, probe-able
 * interface so that a DSH upgrade (or a differently-shaped service set)
 * degrades into an explicit capability report instead of a silent
 * `plugin failed to load`. Business code must consult
 * {@link detectDshCapabilities} outputs through the host facade and never
 * hard-code service keys or private shapes.
 *
 * @module dsh-agent-teams/host/capabilities
 */

import type { Context } from '@deepseek-ai/cordis'
import { createRequire } from 'node:module'

/** Host API families the plugin recognizes. */
export type DshHostFamily = 'alpha2' | 'alpha1' | 'rc' | 'unknown'

/** Probed capabilities of the running DeepSeek Harness host. */
export interface DshCapabilities {
  /** Host version string, best-effort (may be undefined in bundled hosts). */
  hostVersion?: string
  /** Which host API family the detected services belong to. */
  family: DshHostFamily
  /** Web server service is exposed as `webServer` (new) vs `httpServer` (legacy). */
  webServerService: boolean
  /** Workspace registry is exposed as `workspaceRegistry` (new) vs `workspace` (legacy). */
  workspaceRegistryService: boolean
  /** Host session events accept unknown plugin event types (extensible). */
  extensibleSessionEvents: boolean
  /**
   * Host persists session state behind lifecycle-scoped handles with a
   * session lock (v0.1.3-alpha.1+). The plugin must not cache sessions
   * beyond a lifecycle when this is true.
   */
  sessionHandle: boolean
  /** Member/agent loop creation is asynchronous (v0.1.3-alpha.1+). */
  asyncAgentLoopCreate: boolean
  /** Agent-to-agent steering preserves sender attribution across restarts. */
  steeredSendMessage: boolean
}

/** Web server service key candidates, newest first. */
const WEB_SERVER_KEYS = ['webServer', 'httpServer'] as const
/** Workspace registry service key candidates, newest first. */
const WORKSPACE_KEYS = ['workspaceRegistry', 'workspace'] as const

/** Best-effort host version from the installed CLI package metadata. */
function readHostVersion(): string | undefined {
  try {
    // The dsh CLI package is an ancestor of every host profile composition,
    // so resolution from the plugin's own location finds it.
    const localRequire = createRequire(import.meta.url)
    const resolved = localRequire.resolve('@deepseek-ai/dsh/package.json')
    const pkg = localRequire(resolved) as { version?: string }
    return typeof pkg?.version === 'string' ? pkg.version : undefined
  } catch {
    return undefined
  }
}

/** Classify the host API family from the probed service set + version. */
function classifyFamily(hostVersion: string | undefined, services: {
  webServer: boolean
  workspaceRegistry: boolean
}): DshHostFamily {
  const version = hostVersion ?? ''
  if (version.includes('0.1.3-alpha')) return 'alpha1'
  if (version.includes('0.1.2-alpha')) return 'alpha2'
  if (version.startsWith('0.1.1') || version.startsWith('0.1.0')
    || /^0\.1\.\d+-rc\./.test(version)) return 'rc'
  if (version !== '') return 'unknown'
  // Versionless hosts: prefer the modern service keys when the new shape is
  // present, otherwise fall back to the legacy family.
  if (services.webServer && services.workspaceRegistry) return 'alpha2'
  return 'unknown'
}

/**
 * Probe the running host and return a normalized capability report.
 *
 * Every probe is defensive: a missing service simply reports false and the
 * caller decides whether that degrades or blocks.
 */
export function detectDshCapabilities(ctx: Context): DshCapabilities {
  const webServer = ctx.get('webServer') !== undefined
  const workspaceRegistry = ctx.get('workspaceRegistry') !== undefined
  const hostVersion = readHostVersion()
  const family = classifyFamily(hostVersion, { webServer, workspaceRegistry })

  return {
    hostVersion,
    family,
    webServerService: webServer,
    workspaceRegistryService: workspaceRegistry,
    // The alpha.2 line kept extensible session events (`ignorable` envelope
    // flag). Older RC runs fail-closed on unknown event types; the plugin
    // keeps its own durable event log regardless, so this only affects
    // whether host sessions may surface plugin events.
    extensibleSessionEvents: family === 'alpha2' || family === 'alpha1',
    sessionHandle: family === 'alpha1',
    asyncAgentLoopCreate: family === 'alpha1',
    steeredSendMessage: family === 'alpha2' || family === 'alpha1',
  }
}

/** Resolve the web server service key actually present in this host. */
export function resolveWebServerKey(ctx: Context): string | undefined {
  for (const key of WEB_SERVER_KEYS) {
    if (ctx.get(key) !== undefined) return key
  }
  return undefined
}

/** Resolve the workspace registry service key actually present in this host. */
export function resolveWorkspaceKey(ctx: Context): string | undefined {
  for (const key of WORKSPACE_KEYS) {
    if (ctx.get(key) !== undefined) return key
  }
  return undefined
}

export interface CompatibilityReport {
  ok: boolean
  required: string[]
  detected?: string
  family: DshHostFamily
  notes: string[]
}

/**
 * Report whether the probed host family is one the plugin explicitly
 * supports. The report is informational by design: `compatibilityStrict`
 * config (default false) converts it into an activation refusal.
 */
export function checkCompatibility(capabilities: DshCapabilities): CompatibilityReport {
  const supported: DshHostFamily[] = ['alpha2', 'alpha1']
  const notes: string[] = []
  if (capabilities.family === 'rc') {
    notes.push('RC host detected: no RC compatibility adapter is shipped; expect failures and pin the matching plugin release instead.')
  }
  if (capabilities.family === 'unknown') {
    notes.push('Host version could not be classified; proceeding with best-effort service probes.')
  }
  if (!capabilities.webServerService && !capabilities.workspaceRegistryService) {
    notes.push('No web/workspace services detected: running in tool-only (headless) mode.')
  }
  return {
    ok: supported.includes(capabilities.family),
    required: ['0.1.2-alpha.2'],
    detected: capabilities.hostVersion,
    family: capabilities.family,
    notes,
  }
}
