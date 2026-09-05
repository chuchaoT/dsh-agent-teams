# DSH 0.1.3-alpha.1 adapter map

The hardening branch targets the DSH **0.1.2-alpha.2** dependency graph
(`package.json` pins). DeepSeek Harness moved on (see
`v0.1.2-rc.1` → `v0.1.3-alpha.1` release notes); this page records the exact
adapter work needed to run AgentTeams on the newer host. Nothing here is
applied yet — the branch keeps the verified alpha.2 baseline and isolates
host touchpoints behind `src/host/` so the migration touches only the facade.

## Breaking changes on the host side

| Area | 0.1.2-alpha.2 (current baseline) | 0.1.3-alpha.1 | Adapter point |
| --- | --- | --- | --- |
| Session persistence | sessions owned by the agent runtime (`agent.session`) | lifecycle-scoped `SessionHandle`; `agentLoop.create()` async; one session per process lock | `src/host/session-host.ts` (`captainSessionOf`, recorder) |
| Session format | attempt-less log format | v2: streams aggregated into durable settlements | `src/client/session-navigation.ts` + event fold paths |
| Agent-to-agent send_message | plugin steering | unified steer semantics preserving sender attribution and cold-recovery order | `src/members.ts` (`steerCaptainReport`) |
| `send_message` / followup | current shapes | async follows; wake semantics | `src/members.ts` (`deliverToMember`) |

## Capability detection

`src/host/capabilities.ts` already probes and classifies:

- `sessionHandle` / `asyncAgentLoopCreate` / `steeredSendMessage` — `true` when
  the host version family is `alpha1` (0.1.3-alpha).
- `extensibleSessionEvents` — `true` for alpha.2/alpha.1; RC runs fail-closed
  on unknown event types, which is why the plugin owns `events.jsonl`.

To switch the branch to 0.1.3-alpha.1:

1. Re-pin devDependencies + peerDependencies to `0.1.3-alpha.1` (all
   `@deepseek-ai/*` packages, one graph).
2. `pnpm install --frozen-lockfile` after regenerating the lockfile.
3. Expect typecheck failures in exactly the areas above; fix them inside
   `src/host/` and the client session-navigation/staging surfaces.
4. Run `pnpm typecheck && pnpm build && pnpm verify`.
5. Re-verify the staged plan flow (StagingPlanEditor reads the host model
   catalog through `dsh-api-session-controller`).

## Why the two-phase approach

A dual-version adapter (alpha.2 + alpha.3 shims) keeps the verified pair
working while the next host line lands. The facade boundary is the migration
contract: business code never imports `dsh-session` internals directly
beyond `src/host/session-host.ts` and `src/events.ts`.
