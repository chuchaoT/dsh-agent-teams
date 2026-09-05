/**
 * Subagent host facade — the two-generation API bridge.
 *
 * Alpha.2 exposed `ctx.subagents.followup(parent, childId, content, options)`
 * and `ctx.subagents.registerContinuableSetup(...)`. Alpha.5 replaced
 * followup with unified steering (`sendMessage(sender, targetId, content,
 * options)`, plus a manager-level `queuePrompt` for host-protocol messages)
 * and dropped the global setup hook entirely. Business code calls this
 * facade only; capability probe picks which surface exists at runtime, and
 * the same bundle compiles against both host generations.
 *
 * @module dsh-agent-teams/host/subagent-host
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentProvider } from '@deepseek-ai/dsh-subagent'

/** Minimal shape of the two command surfaces (one exists per host). */
interface SubagentRuntimeLike {
  followup?: (
    parent: Agent,
    childId: SessionId,
    content: readonly ContentBlock[],
    options: { readonly source: { readonly kind: 'plugin'; readonly plugin: string }; readonly signal: AbortSignal },
  ) => Promise<unknown>
  sendMessage?: (
    sender: Agent,
    targetId: SessionId,
    content: readonly ContentBlock[],
    options: { readonly signal: AbortSignal },
  ) => Promise<unknown>
  readonly interrupt?: (targetId: SessionId, authority: { readonly kind: 'ancestor'; readonly agent: Agent }) => void
  readonly getProvider?: (name: string) => SubagentProvider | undefined
}

/** Member-waking surface used by the scheduler and messaging tools. */
export interface SubagentHost {
  /** Deliver one host-authored turn to a continuable member (best effort). */
  wakeMember(captain: Agent, childId: string, text: string, signal: AbortSignal): Promise<boolean>
  /** Interrupt one live member's current turn (fire and return). */
  interruptMember(captain: Agent, childId: string): void
  /** Whether the legacy followup surface exists (implied by wakeMember's path). */
  readonly legacyFollowup: boolean
  /** Raw runtime, for the legacy setup-bridge consumer (alpha.2 only). */
  readonly runtime: SubagentRuntimeLike
}

function brandedSessionId(value: string): SessionId {
  return value as SessionId
}

/** Build the facade against one plugin context. */
export function createSubagentHost(ctx: Context): SubagentHost {
  const runtime = ctx.subagents as unknown as SubagentRuntimeLike
  return {
    get legacyFollowup() {
      return typeof runtime.followup === 'function'
    },
    runtime,
    async wakeMember(captain, childId, text, signal) {
      const content: ContentBlock[] = [{ type: 'text', text }]
      try {
        if (typeof runtime.sendMessage === 'function') {
          // Uniform steer semantics (alpha.5+): the sender must be the exact
          // live parent; an absent child cold-resumes through the manager.
          await runtime.sendMessage(captain, brandedSessionId(childId), content, { signal })
          return true
        }
        if (typeof runtime.followup === 'function') {
          await runtime.followup(captain, brandedSessionId(childId), content, {
            source: { kind: 'plugin', plugin: 'dsh-agent-teams' },
            signal,
          })
          return true
        }
        ctx.logger.warn('agent-teams: no member wake surface (followup/sendMessage) on this host')
        return false
      } catch (error: unknown) {
        ctx.logger.warn(`agent-teams: wake of member ${childId} failed: ${String(error)}`)
        return false
      }
    },
    interruptMember(captain, childId) {
      try {
        runtime.interrupt?.(brandedSessionId(childId), { kind: 'ancestor', agent: captain })
      } catch (error: unknown) {
        ctx.logger.warn(`agent-teams: interrupt of member ${childId} failed: ${String(error)}`)
      }
    },
  }
}
