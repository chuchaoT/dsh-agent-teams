/**
 * Host facade barrel: every host-plane interaction in AgentTeams goes through
 * this module's narrow interfaces, so a DSH upgrade only retouches the
 * facade and its capability probes instead of the business logic.
 *
 * @module dsh-agent-teams/host
 */

export {
  checkCompatibility,
  detectDshCapabilities,
  resolveWebServerKey,
  resolveWorkspaceKey,
} from './capabilities.ts'
export type { CompatibilityReport, DshCapabilities, DshHostFamily } from './capabilities.ts'

export {
  captainSessionOf,
  createSessionHost,
  teamEventLogPath,
} from './session-host.ts'
export type { SessionEventRecorder } from './session-host.ts'

export {
  resolveWorkspace,
  resolveWorkspaceRegistry,
} from './workspace-host.ts'
export type { WorkspaceEntry, WorkspaceRegistryLike, WorkspaceResolution } from './workspace-host.ts'
