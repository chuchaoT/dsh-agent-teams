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

## Known boundaries

- Team state remains file-backed; a *single* writer process is assumed.
  Concurrent independent processes editing the same team still race on final
  write order (revision CAS catches lost updates; it does not merge).
- Cross-process attempt recovery treats another runtime's open attempt as
  recoverable (documented boundary).
- Host session events may omit out-of-vocabulary types; `events.jsonl` is the
  authoritative audit trail.
