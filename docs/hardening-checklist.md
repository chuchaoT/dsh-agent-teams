# Hardening checklist — analysis vs implementation audit

Every item from the three-part analysis (architecture/code, features/product,
DSH adaptation) is listed with its status. Three states: **done** (implemented
+ verified), **assessed** (evaluated, deliberately scoped out — see note), or
**external** (belongs to the host control plane / deployment side / needs a
real host run to accept).

## P0 — reliability & architecture

| # | Analysis item | Status | Evidence |
|---|---|---|---|
| 1 | Cross-process consistency (lost update prevention) | done | `writeTeam` revision CAS (`TeamConcurrencyError`), `TeamState.revision`, `withCrossProcessLock` (O_EXCL + stale reclaim), retired-members under the same lock. Tests: `state-hardening` |
| 2 | Attempt lifecycle durable (parkedAttempts was in-memory; watchdog; cold recovery semantics) | done | `src/attempts.ts` (keep/parked/recover from durable fields + live facts; 30min heartbeat watchdog), `scheduler` no longer keeps process-local parked map. Tests: `attempts` |
| 3 | tools.ts monolith split | done (first slice) | `src/tools-parse.ts` (parsers + evidence builder extracted, 4 tests). Remaining handler regrouping was assessed: closures share config/ctx/scheduler, mechanical extraction adds risk without behavior gain — documented. |
| 4 | Host adapter isolation (DSH API coupling) | done | `src/host/` — capabilities probe + compatibility report + strict gate, session recorder facade, workspace resolver, subagent bridge, team change bus. `src/events.ts` no longer touches host internals. |
| 5 | Host session events as audit source (unknown types dropped) | done | `events.jsonl` append-only audit log mirrored on every event; host Session append stays best-effort. |
| 6 | Model-reported evidence untrusted | done (two layers) | `src/evidence.ts` (host observation beats declaration; `unobserved` untrusted) + wiring in `update_task` (`TeamTask.evidence`, `evidence_summary`) + `src/tools-parse.ts::buildCommandEvidence`. |
| 7 | Runtime enforcement (persona was the only boundary) | done (layer 1) | `src/policy.ts` capability matrix → per-role tool denials merged into `toolFilter.deny` at all three spawn paths; config `capabilityMatrix`. Layer 2 (path scoping) assessed — see note. |
| 8 | Cost / model routing telemetry | done | `src/telemetry.ts` (records, estimateCostUsd, summarize, totalsOf w/ dedupe + model attribution), wired into scheduler/tools/members; budget gate (pure + dispatch pause + once-only captain notice). |
| 9 | Observability (queued/start/duration/cost/fallback/gates) | done | `telemetry.jsonl` (attempt_started/finished, gate_result, fallback_switch), status `telemetry_summary`, panel badge. |
| 10 | Layered memory | done (layer 1, wired) | `src/team-memory.ts` (scopes/confidence/TTL/supersedes/search/prune/JSONL) + dispatch injection (keyword hits → recent fallback). |
| 11 | Windows/build hygiene | done | clean-build Windows path fix; pnpm native-build allowlist; NODE_ENV/production React pitfall avoided. |

## P1 — product capabilities

| # | Analysis item | Status | Evidence |
|---|---|---|---|
| 1 | Typed artifacts (output → refs) | done | `src/artifacts.ts` storage + `update_task` auto-archive on completion + `artifact_id`/`artifactIds` everywhere + scheduler refs in dependency outputs. |
| 2 | Run workspace / panel upgrade | done (progressive) | snapshots carry evidence/artifact/priority/deadline/approval/telemetry; panel badges + approval block; see "panel evidence detail" for the last slice. |
| 3 | Task priority / deadline | done | `sortReadyTasks` (priority → deadline → FIFO), create_task params, status/snapshot expose. |
| 4 | DAG barrier/conditional/fan-out | done (declarative + dynamic) | SOP `stage` barriers (`applyStageBarriers` — intra-stage parallel, stage-gated downstream); fan-out via shared ready pool; human approval node (panel + captain tool + `isDispatchableTask` gate). Conditional edges: assessed — profile/captain planning already expresses genuine prerequisites; conditional runtime edges add uncontrollable semantics for little gain — documented. |
| 5 | Budget circuit breaker / routing | done (skeleton, live) | `budgetExceeded` + dispatch pause + once-only notice; cost lands when token accounting is added. |
| 6 | SSE incremental updates | done | `/plugins/dsh-agent-teams/events` + client EventSource trigger w/ probe fallback; server-side `team-events` bus. |
| 7 | Memory wiring | done | dispatch-level injection in assignment prompt. |
| 8 | Evidence drawer in panel | done (this round) | task detail shows evidence/artifact summaries. |

## P2 — platform

| # | Analysis item | Status | Evidence |
|---|---|---|---|
| 1 | SQLite/WAL state backend | assessed | Single-writer + revision CAS + file locks + append-only logs cover the real races; native driver dependency not justified at this scale. Documented in hardening-notes. |
| 2 | SOP template/subgraph (versioned) | done (stage barriers + template versioning point) | `stage` barriers at profile expansion; `profile` snapshot preserved on team. |
| 3 | Policy-as-code | done (layer 1) | capability matrix; path-level interception is host-side (assessed). |
| 4 | OTel exporter | external | Model carries span fields; export is a deployment concern. |
| 5 | Replay | done (contract + verifier) | `manifest.json` + `src/replay.ts::verifyArchivedRun`. |
| 6 | Cross-team/workspace runtime | done-adjacent | One team per captain is the documented boundary; multi-workspace discovery works (`collectTeamsActivity` over registry roots). |
| 7 | Enterprise RBAC/ABAC, dual approval, attestations | external | Host control plane + external PKI; plugin side contributes the capability matrix. |

## DSH adaptation

| Item | Status | Evidence |
|---|---|---|
| npm line reality check | done | alpha.3/4/5 published; `0.1.3-alpha.1` is GitHub-only (npm 404). |
| 0.1.2-alpha.5 migration | done | `feat/dsh-0.1.2-alpha5` branch: 45 dep refs, `SubagentHost` dual-generation bridge, global failure observation fallback, `minimumReleaseAge` unblock. typecheck/build/verify green. |
| Breaking-change map | done | `docs/dsh-0.1.3-adapter.md` (SessionHandle / async agentLoop / session lock / session v2). |
| Real-host e2e UI acceptance | external | Requires a live alpha.5 host run inside a DSH profile (user's machine is on rc.1). |

**Note on "assessed"**: every assessed item was evaluated against the actual
codebase and its failure modes, and the decision (keep file-based single-writer;
keep framework closures; keep genuine-prerequisite DAGs; keep path scoping
host-side) is documented with rationale rather than silently dropped.
