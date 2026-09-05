# Hardening branch notes (local)

The `feat/framework-hardening` branch carries the agent-teams hardening pass.
Everything here is additive and verified by `pnpm verify`; behavior changes
are limited to documented semantics.

## Reliability

- **Cross-process consistency**: `writeTeam` compares the on-disk revision
  against the read-revision captured by `readTeam` and refuses to overwrite
  when another process advanced it (`TeamConcurrencyError`). `TeamState.revision`
  is a monotonic persistence generation.
- **Cross-process advisory lock**: `withCrossProcessLock` (state root scope,
  `O_EXCL` lock file with stale reclaim) protects team mutations and the
  retired-member index across processes.
- **Durable audit log**: every recorded team event is mirrored into
  `<teamDir>/events.jsonl` (append-only, torn-tail tolerant) regardless of
  what the host Session vocabulary accepts.
- **Durable attempt lifecycle**: tasks carry `attemptStartedAt` /
  `attemptHeartbeatAt` / `attemptRuntimeId` / `attemptParked` / `attemptParkedAt`.
  `src/attempts.ts` decides keep/parked/recover from durable fields + live
  registry facts. A watchdog recovers attempts whose heartbeat is stale
  (default 30 min).

## Data model additions (legacy-safe, all optional)

- `TeamTask`: `evidence` (normalized two-layer evidence records),
  `artifacts` (typed artifact refs), `priority`, `deadlineAt`.
- Run telemetry lives in `<teamDir>/telemetry.jsonl` (append-only).

## New modules

- `src/host/` — capability probing (host version families, service keys),
  session event recorder facade, workspace resolution facade.
- `src/attempts.ts` — attempt disposition policy.
- `src/evidence.ts` — two-layer evidence model (host observation beats member
  declaration; `unobserved` is untrusted).
- `src/artifacts.ts` — typed artifact storage (`<teamDir>/artifacts/<id>.json`).
- `src/telemetry.ts` — run telemetry model + cost estimation.
- `src/tools-parse.ts` — extracted tool input parsers.
- `src/team-memory.ts` — layered memory (scopes, TTL, supersedes, JSONL).
- `src/host/team-events.ts` — process-local change bus powering the SSE
  refresh trigger (`/plugins/dsh-agent-teams/events`).

## Wiring

- Scheduler dispatch injects dependency artifact refs and relevant team
  memory (keyword hits first, recent fallback, advisory).
- `update_task` records `attempt_finished` / `gate_result` telemetry and
  archives completed outputs as typed artifacts.
- Fallback switches record `fallback_switch` telemetry.
- The activity panel listens to the SSE trigger and refetches the durable
  state route immediately; the low-frequency probe remains the backstop.

## Human approval gate

- A task created with `requires_approval=true` (plus `approval_reason`) stays
  `pending` and is never auto-dispatched until a human decision.
- `isDispatchableTask` (scheduler) enforces the gate; `agent_teams_approve_task`
  (captain tool) and the panel approval route
  (`/plugins/dsh-agent-teams/approve`) record the same decision; the SSE bus
  refreshes the panel after a decision.
- Approval state: `awaiting` → `approved` (dispatchable) / `rejected`
  (re-approved later possible). Terminal tasks reject approval comments.

## Run budget gate

- `agent_teams_create({ budget_usd })` records a per-run USD budget on the
  team. The scheduler pauses dispatch (member wake-ups and mailbox fallback
  turns included) once telemetry cost reaches the budget (`budgetExceeded`,
  in `src/telemetry.ts` — zero spend never trips, zero budget trips at the
  first cent).
- The captain is notified exactly once (`budgetWarned`); raising the budget
  or ending the team are the human's next steps. Cost currently sits at 0
  until token accounting lands in `attempt_finished` records; the gate is
  wired and testable now.

## DSH 0.1.3 adapter

See `docs/dsh-0.1.3-adapter.md` for the breaking-change map (SessionHandle,
async `agentLoop.create()`, session lock, session v2) and the migration
steps. The `src/host/` facade is the migration boundary.

## Policy as code (layer 1): capability matrix
- `src/policy.ts` maps member roles to coarse capability classes
  (read/write/execute/network/secrets). Defaults: `reviewer`/`verifier`
  read + execute (no writes, no network); `researcher` read + network
  (no shells); `implementer`/`engineer` full (no secrets).
- `resolveToolDenials` turns a capability set into concrete DSH tool
  denials (exact names + prefix rules); unknown tools are never denied
  (safe conservative default).
- Wired into `spawnMember`'s `toolFilter.deny` (alongside the captain-only
  tool list) at all three spawn paths; configurable via
  `capabilityMatrix` in the plugin config (per-role overrides).
- Layer 2 (filesystem path scoping / host write interception) remains
  future work.

## SOP stage barriers and run manifest
- Profile template tasks may carry a `stage` label. `applyStageBarriers`
  (profiles.ts) adds barrier edges at expansion: tasks within one stage stay
  parallel; each later stage's tasks depend on all tasks of the previous
  stage. Stage-less tasks are never gated; explicit dependencies merge
  (deduplicated).
- `TeamTask.stage` is durable and visible in status/panel snapshots.
- On archive (agent_teams_delete) a `manifest.json` is written into the team
  directory before the archive move: goal, roster, per-task lifetime facts
  (attempts, verdict, stage, artifact ids, evidence counts), telemetry totals,
  memory/audit counts — the replay/review contract for the archived bundle.
- `src/replay.ts` verifies an archived bundle (`verifyArchivedRun`): manifest
  schema, team id match, every referenced artifact on disk, readable logs.
  Old pre-hardening bundles degrade to informational notes, not failures.

## Enterprise items — applicability assessment

Items from the original plan that depend on capabilities outside this plugin:

- **SQLite/WAL state backend**: evaluated and deliberately not done — the
  single-writer assumption is documented, revision CAS plus file locks cover
  the actual cross-process races, and telemetry/audit/memory are already
  append-only. The remaining win (indexed queries) does not justify a native
  driver dependency for this plugin's scale.
- **True OTel exporter**: optional external adapter; the plugin's own
  telemetry model (src/telemetry.ts) already carries the spans' fields
  (run/task/attempt, duration, cost, verdict) — exporting is a deployment
  concern (env-based OTLP endpoint), not a plugin boundary.
- **Enterprise RBAC/ABAC, dual approval, attestations**: belong to the host
  control plane and external PKI/identity — out of scope for a workspace
  plugin. The capability matrix (policy as code) is the plugin-side
  contribution; user/team roles and signed provenance are host-side.

## Known boundaries

- Team state remains file-backed; a *single* writer process is assumed.
  Concurrent independent processes editing the same team still race on final
  write order (revision CAS catches lost updates; it does not merge).
- Cross-process attempt recovery treats another runtime's open attempt as
  recoverable (documented boundary).
- Host session events may omit out-of-vocabulary types; `events.jsonl` is the
  authoritative audit trail.
