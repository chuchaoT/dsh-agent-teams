/**
 * Policy as code, layer 1: capability matrix for member roles.
 *
 * Member personas are model-facing text; enforcement belongs to the host.
 * This module maps a role to concrete DSH tool denials so a reviewer member
 * cannot write files, a researcher cannot run shells, and so on — the
 * persona can no longer be the only boundary. Host write interception for
 * filesystem paths remains future work; this layer denies whole tool
 * classes, which is enforceable through the subagent `toolFilter` today.
 *
 * Pure module: zero imports, so it runs in plain `node --test` unit tests and
 * inside the host process alike.
 * @module dsh-agent-teams/policy
 */

/** Coarse capability classes a member role may or may not hold. */
export interface MemberCapabilities {
  readonly read: boolean
  readonly write: boolean
  readonly execute: boolean
  readonly network: boolean
  /** Reserved for secret-retrieval tooling (no current DSH class maps here). */
  readonly secrets: boolean
}

/** Full capabilities (all classes granted). */
export const FULL_CAPABILITIES: MemberCapabilities = {
  read: true,
  write: true,
  execute: true,
  network: true,
  secrets: false,
}

/** Read-mostly capabilities (reviewers, analysts, researchers via network). */
export const REVIEW_CAPABILITIES: MemberCapabilities = {
  read: true,
  write: false,
  execute: true,
  network: false,
  secrets: false,
}

/** Read + research capabilities (no shells, no writes). */
export const RESEARCH_CAPABILITIES: MemberCapabilities = {
  read: true,
  write: false,
  execute: false,
  network: true,
  secrets: false,
}

/** Default per-role matrix used when a profile does not configure one. */
export const DEFAULT_CAPABILITY_MATRIX: Readonly<Record<string, MemberCapabilities>> = {
  reviewer: REVIEW_CAPABILITIES,
  review: REVIEW_CAPABILITIES,
  verifier: REVIEW_CAPABILITIES,
  verification: REVIEW_CAPABILITIES,
  researcher: RESEARCH_CAPABILITIES,
  research: RESEARCH_CAPABILITIES,
  implementer: FULL_CAPABILITIES,
  implement: FULL_CAPABILITIES,
  engineer: FULL_CAPABILITIES,
  developer: FULL_CAPABILITIES,
  integrator: FULL_CAPABILITIES,
}

/** Tool name → capability class (DSH host tool naming conventions). */
const TOOL_CLASS: Readonly<Record<string, 'read' | 'write' | 'execute' | 'network'>> = {
  read: 'read',
  read_file: 'read',
  read_document: 'read',
  read_image: 'read',
  grep: 'read',
  glob: 'read',
  search: 'read',
  list: 'read',
  view: 'read',
  write: 'write',
  edit: 'write',
  edit_file: 'write',
  'patch.apply': 'write',
  bash: 'execute',
  pwsh: 'execute',
  powershell: 'execute',
  shell: 'execute',
  run_code: 'execute',
  tool: 'execute',
  web_search: 'network',
  web_fetch: 'network',
  browser_navigate: 'network',
  browser_click: 'network',
  browser_scrape: 'network',
}

/**
 * Classify one tool name by prefix when no exact mapping exists
 * (e.g. `browser_*`, `bash_*`, `ps_*`, `run_*`, `exec_*`).
 */
function classifyByPrefix(name: string): 'read' | 'write' | 'execute' | 'network' | undefined {
  if (/^browser_/.test(name)) return 'network'
  if (/^(bash|ps|pwsh|run|exec|shell|cmd)/.test(name)) return 'execute'
  if (/^(edit|write|patch|create|delete|rm|mv|cp)/.test(name)) return 'write'
  if (/^(read|search|grep|find|list|view|glob)/.test(name)) return 'read'
  if (/^web_/.test(name)) return 'network'
  if (/^image/.test(name)) return 'read'
  return undefined
}

/** The class a given tool name belongs to, if the policy knows one. */
export function toolClassOf(name: string): 'read' | 'write' | 'execute' | 'network' | undefined {
  const exact = TOOL_CLASS[name]
  if (exact !== undefined) return exact
  return classifyByPrefix(name)
}

/** Whether one capability set grants the class. */
function classGranted(capabilities: MemberCapabilities, cls: 'read' | 'write' | 'execute' | 'network'): boolean {
  switch (cls) {
    case 'read': return capabilities.read
    case 'write': return capabilities.write
    case 'execute': return capabilities.execute
    case 'network': return capabilities.network
  }
}

/**
 * Resolve the tool names that must be denied for the given capabilities.
 * Unknown tools (no class mapping) are never denied by this layer — a
 * capability-blind tool stays usable, which is the safe conservative default
 * until per-tool policy lands.
 */
export function resolveToolDenials(capabilities: MemberCapabilities, tools?: readonly string[]): string[] {
  const denied = new Set<string>()
  for (const tool of tools ?? Object.keys(TOOL_CLASS)) {
    const cls = toolClassOf(tool)
    if (cls !== undefined && !classGranted(capabilities, cls)) denied.add(tool)
  }
  return [...denied]
}

/**
 * Merge a role's capability set with an optional member-level override
 * (partial overrides keep the role baseline). Unknown roles fall back to
 * full capabilities when no matrix entry exists.
 */
export function effectiveCapabilities(
  role: string | undefined,
  matrix: Readonly<Record<string, MemberCapabilities>>,
  override?: Partial<MemberCapabilities>,
): MemberCapabilities {
  const base = role === undefined
    ? FULL_CAPABILITIES
    : matrix[role] ?? FULL_CAPABILITIES
  if (override === undefined) return base
  return {
    read: override.read ?? base.read,
    write: override.write ?? base.write,
    execute: override.execute ?? base.execute,
    network: override.network ?? base.network,
    secrets: override.secrets ?? base.secrets,
  }
}

/** Validate a configured matrix: every entry must be a well-formed capability set. */
export function validateCapabilityMatrix(
  matrix: unknown,
): string[] {
  if (matrix === undefined) return []
  if (typeof matrix !== 'object' || matrix === null || Array.isArray(matrix)) {
    return ['capabilityMatrix must be an object keyed by role name']
  }
  const errors: string[] = []
  for (const [role, entry] of Object.entries(matrix as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      errors.push(`capabilityMatrix["${role}"] must be an object`)
      continue
    }
    for (const key of ['read', 'write', 'execute', 'network', 'secrets'] as const) {
      const value = (entry as Record<string, unknown>)[key]
      if (value === undefined) continue
      if (typeof value !== 'boolean') errors.push(`capabilityMatrix["${role}"].${key} must be a boolean`)
    }
  }
  return errors
}
