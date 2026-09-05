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

## Applied: 0.1.2-alpha.5 adapter (branch `feat/dsh-0.1.2-alpha5`)

The npm line moved on to `0.1.2-alpha.5` (alpha.3/4/5 published on npm; the
GitHub `0.1.3-alpha.1` tag is not yet on npm). The alpha5 branch is migrated
and green on the alpha.5 dependency graph:

- `package.json` devDependencies/peerDependencies: `0.1.2-alpha.2` →
  `0.1.2-alpha.5` (45 references; full graph one generation).
- `src/host/subagent-host.ts`: **SubagentHost facade**. Alpha.5 replaced
  `ctx.subagents.followup(...)` with unified steering
  (`sendMessage(sender, targetId, content, {signal})`) and dropped
  `registerContinuableSetup`. The facade probes the surface: `wakeMember`
  uses sendMessage when present, else followup; `installRetiredMemberGuard`
  patches whichever surface exists.
- `src/members.ts`: `installMemberSelectionRuntime` degrades gracefully —
  no setup hook → global `agent/error` membership-scoped failure observation
  (`installGlobalFailureObservation`); model routes are restored by the host
  itself from the durable descriptor on this generation. The legacy setup
  branch (alpha.2 hosts) stays and reads session events through a width
  bridge so it compiles on both type surfaces.
- `pnpm-workspace.yaml`/`.npmrc`: `minimumReleaseAge: 0` /
  `minimum-release-age=0` so the newest alpha installs the day it publishes.

Verification on this branch: `pnpm typecheck` + `pnpm build` + `pnpm verify`
green (no host processes involved; the e2e UI acceptance still needs a real
alpha.5 host run inside a DSH profile).

