# Factory: the agent/workflow execution engine behind Receipt background runs

Research report for the public Receipt documentation site.
Repository: `<receipt-repo>` at git HEAD `c3c16be6` on `main` (2026-09-07).
Prior corpus used as a map only: `06-factory-cli.md` and `07-runtime-architecture-api.md` (written at `41baea75`, 43 commits ago). Every claim below was re-verified against HEAD; paths are repo-relative and cited as `path:line`.

Reading rule: implementation > config/schema/types > checked-in Markdown > tests. Where the repo's own docs disagree with the code, the code wins and the disagreement is called out.

---

## 0. TL;DR for a docs writer

* **Factory** is Receipt's background execution engine. Its unit of work is an **objective** (a durable, receipt-backed goal) that the runtime decomposes into a **task DAG**, executes through **jobs** on a queue, runs inside disposable **OpenSandbox computers** with the **Codex CLI** as the agent, and settles back into hash-chained receipts on the stream `factory/objectives/<objectiveId>`.
* There is exactly one execution path (`"computer"`) and one computer provider (`"opensandbox"`) at HEAD (`packages/receipt-app/src/modules/factory/types.ts:87-96`). There is no local/host execution lane.
* Durable execution is **Resonate** durable promises (`receipt.job.driver` → `receipt.job.execute`) fronted by a receipt-backed job queue with lease/heartbeat/attempt fences (`packages/receipt-app/src/adapters/resonate-runtime.ts:553-806`). Resonate executes; receipts are the only state.
* The 43 commits since `41baea75` are dominated by a **projection durability rewrite**: a Postgres trigger now marks per-projector/per-stream pending work on every receipt insert, an API-side pump drains it, reducer state is checkpointed, projection work runs on a dedicated single-connection pool, and the Resonate poll transport was replaced so idle workers stay connected (`packages/receipt-app/src/db/projection-work-schema.ts`, `packages/receipt-app/src/server/projection-work-pump.ts`, `packages/receipt-app/src/adapters/resonate-poll-source.ts`, `docs/projection-durability-fix.md`). Section 13 lists the behavioral changes.
* Connected-system credentials (AWS, GCP, Jira, kubectl) are materialized inside the sandbox as **credential helpers that fetch short-lived material from the Receipt Connect gateway at call time** using a job-scoped Receipt Connect JWT; provider secrets are not placed in the sandbox environment. Two exceptions a docs page must not gloss over: the organization's OpenAI BYOK key is written to `~/.codex/auth.json` inside the sandbox, and when the controller host has `gh` logged in, its token is projected as `GH_TOKEN`/`GITHUB_TOKEN` plus `~/.config/gh/hosts.yml` (`packages/receipt-app/src/services/factory/lima-auth-byok.ts:73-97`, `packages/receipt-app/src/services/factory/lima-auth-gh.ts:15-60`).
* The product-facing surfaces are the app's `/tasks` page ("Beetle Tasks") with its "New task" panel, the chat thread (a chat turn becomes a `factory.run` job), and the `receipt factory …` CLI. The runtime's own `/factory` HTMX shell exists but is private behind the gateway.
* `receipt factory doctor` is still inert (always throws `Organization BYOK key required for factory doctor review`, `packages/receipt-app/src/factory-cli/doctor.ts:449-451`).

---

## 1. Concepts

### 1.1 Objective

The top-level unit of Factory work. Stream: `factory/objectives/<objectiveId>` (`packages/receipt-app/src/services/runtime-contracts.ts:19,34-35`).

**Lifecycle statuses** (`packages/receipt-app/src/modules/factory/types.ts:4-16`, canonical list at `packages/receipt-app/src/modules/factory/status-contract.ts:8-21`):

| Status | Class |
|---|---|
| `planning` | active |
| `waiting_for_slot` | active |
| `collecting_evidence` | active (investigation) |
| `evidence_ready` | active (investigation) |
| `synthesizing` | active (investigation) |
| `executing` | active |
| `integrating` | active |
| `promoting` | active |
| `completed` | terminal |
| `blocked` | stopped, not terminal ("operator receipts can unblock or redirect it during replay", `status-contract.ts:167-170`) |
| `failed` | terminal |
| `canceled` | terminal |

Terminal set = `completed | failed | canceled` (`status-contract.ts:23-27`); stopped set adds `blocked` (`status-contract.ts:29-34`).

> **Docs discrepancy:** `docs/factory-on-receipt.md:351-361` still lists `decomposing`/`planning`/`executing`/… and a `phase` projection of `preparing_repo`/`planning_graph`/…. Neither matches HEAD. Use the table above.

**Display state and phase detail** (`packages/receipt-app/src/services/factory-types.ts:296-327`):

* `displayState`: `Draft | Queued | Running | Awaiting Review | Stalled | Blocked | Completed | Archived | Failed | Canceled`
* `phaseDetail`: `draft | waiting_for_slot | waiting_for_computer_lease | waiting_for_control | waiting_for_synthesis | waiting_for_promotion | collecting_evidence | evidence_ready | synthesizing | integrating | promoting | cleaning_up | awaiting_review | stalled | completed | blocked | failed | canceled | archived`
* `statusAuthority`: `objective | reconcile | cleanup` (`factory-types.ts:329-332`)

**Phase lines** (exact label/summary pairs, `packages/receipt-app/src/services/factory/live-status-phase.ts:11-64`):

| phaseDetail | Label | Summary |
|---|---|---|
| terminal `completed` | `Completed` | `Objective finished successfully.` |
| terminal `failed` | `Failed` | `Objective failed.` |
| terminal `canceled` | `Canceled` | `Objective was canceled.` |
| `draft` | `Drafting objective` | `Preparing the objective before dispatch.` |
| `waiting_for_slot` | `Queued` | `Waiting for the repo execution slot.` |
| `waiting_for_control` | `Reconciling` | `Controller is deciding the next step.` |
| `waiting_for_computer_lease` | `Waiting for computer` | `Waiting for computer capacity before the agent starts.` |
| `collecting_evidence` | `Collecting evidence` | `Gathering evidence for the active task.` |
| `evidence_ready` | `Evidence ready` | `Evidence is ready and synthesis is next.` |
| `synthesizing` | `Synthesizing` | `Turning evidence into a final answer.` |
| `integrating` | `Integrating` | `Applying the approved changes and validating them.` |
| `waiting_for_promotion` | `Waiting for promotion` | `Approved work is queued for promotion.` |
| `promoting` | `Publishing` | `Publishing the promoted result.` |
| `awaiting_review` | `Awaiting review` | `Waiting for the current pass to be reviewed.` |
| `blocked` | `Blocked` | `Waiting for operator guidance before continuing.` |
| `stalled` | `Stalled` | `Execution stopped making visible progress.` |
| `cleaning_up` | `Cleaning up` | `Retiring lingering jobs and workspaces.` |
| anything else | labelized value | `Objective state updated.` |

**Objective mode** is `delivery` or `investigation` (`types.ts:68-70`). The checked-in profile defaults to `investigation` (`profiles/receipt/PROFILE.md` frontmatter `defaultObjectiveMode`; `packages/receipt-app/src/modules/factory/defaults.ts:62`). Mode drives three things: investigation objectives get no repo checks, never auto-promote, and do not consume the repo execution slot (`packages/receipt-app/src/services/factory/runtime/objective-input-checks.ts:33-38`, `objective-input-policy.ts:13-19`, `objective-control-slots.ts:9-14`).

**Severity** is an integer `1..5` (`types.ts:80-86`), profile default `1` (`defaults.ts:63`). It feeds the worker reasoning effort (`severityWorkerReasoningEffort`, `packages/receipt-app/src/services/factory/runtime/task-execution-codex-run-input.ts:37-43`). The app's task composer maps `P1..P4` priority to severity (`apps/start/src/lib/frontend/tasks/beetle-task.server.ts:132`).

**Repo execution slot.** Delivery objectives consume a slot; investigation objectives do not (`objective-control-slots.ts:9-14`). A slot is released when the objective is terminal, `blocked`, `promoting`, or its integration status is promotion-releasing (`objective-control-slots.ts:16-21`). Admission happens at creation (`objective.slot.queued` vs `objective.slot.admitted`, `packages/receipt-app/src/services/factory/runtime/objective-creation-created.ts:39-53`) and on rebalance, which admits queued delivery objectives up to `repoSlotConcurrency - activeRepoSlotCount` (`objective-slot-control-rebalance-admit.ts:46-53`). `repoSlotConcurrency` defaults to **20** (`packages/receipt-app/src/factory-cli/config.ts:62`, env `RECEIPT_FACTORY_REPO_SLOT_CONCURRENCY`). So "single repo slot" is the *board's vocabulary* ("Objectives currently holding the repo execution slot."), not a hard single-objective limit; the runtime default admits up to 20 delivery objectives per repo.

### 1.2 Task and the task DAG

Task statuses (`types.ts:18-26`): `pending | ready | running | reviewing | approved | integrated | blocked | superseded`. Workflow buckets (`defaults.ts:20-27`): planned=`pending`; ready=`ready`; active=`running, reviewing`; completed=`approved, integrated, superseded`; blocked=`blocked`; terminal=`approved, integrated, blocked, superseded`.

Each task carries `dependsOn`, an `executionPhase` (`collecting_evidence | evidence_ready | synthesizing`, `types.ts:28-31`) and an `evidenceSemanticStatus` (`empty | partial | sufficient | final`, `types.ts:33-37`). The reducer only ever *raises* the semantic status (`strongestEvidenceSemanticStatus`, `packages/receipt-app/src/modules/factory/reducer.ts:109-120`).

The DAG is produced by the **objective supervisor** (an LLM decision at explicit receipt boundaries) and applied deterministically. Supervisor decision kinds: `continue | apply_plan | synthesize | block` (`packages/receipt-app/src/services/factory/objective-supervisor-schema.ts:129`); assessment `on_track | needs_more_evidence | needs_replan | sufficient | blocked` (`:147`). Default supervisor model `gpt-5.6-terra`, env `RECEIPT_FACTORY_OBJECTIVE_SUPERVISOR_MODEL` (fallback `RECEIPT_FACTORY_SUPERVISOR_MODEL`) (`objective-supervisor-runner.ts:111-117`).

### 1.3 Candidate

One attempt at a task. Statuses (`types.ts:39-47`): `planned | running | awaiting_review | changes_requested | approved | integrated | rejected | conflicted`. Ids contain `_candidate_`.

### 1.4 Job

The queued unit behind every task, control, monitor, audit, integration, or chat action. Statuses (`packages/receipt-app/src/modules/job.ts:9`): `queued | leased | running | completed | failed | canceled`. Lanes (`job.ts:7-8`): `chat | collect | steer | follow_up` (`abort` is a command type, not a lane, `job.ts:10`).

Job payload kinds (`runtime-contracts.ts:111-121`): `factory.dispatch`, `factory.run`, `factory.integration.publish`, `factory.integration.validate`, `factory.objective.audit`, `factory.objective.control`, `factory.objective.watchdog`, `factory.task.monitor`, `factory.task.run`. Per-kind contract flags (`runtime-contracts.ts:276-360`) declare `workerGroup` (`control | chat | codex`), optional `durableWorkflow` (`objective-control | run`), `hasDurableActivity`, `objectiveScoped`, `reconcileObjectiveOnTerminalOrExpiredLease`, `liveExecution`, `terminalObjectiveAudit`. Only `factory.task.run` has `hasDurableActivity: true` (`:353-359`).

### 1.5 Check

A shell command run against the integration worktree before promotion. Runtime resolution (`objective-input-checks.ts:12-58`): explicit `checks` (including `[]`) win → investigation → `[]` → connected-system objective → `[]` → profile `defaultValidationMode === "none"` → `[]` → else `DEFAULT_CHECKS = ["bun run build"]` (`:3`). The app's task composer sends `checks: ['bun run check:full']` (`beetle-task.server.ts:133`); the repo's own `.receipt/config.json` sets `defaultChecks: ["bun run check"]`.

Checks execute **inside the OpenSandbox computer**, not on the controller: `runPreparedOpenSandboxCheckCommands` runs each command through `lease.exec` in the remote workspace with a 60-minute timeout and a one-shot "missing tracked file" repair-and-retry (`packages/receipt-app/src/services/factory/opensandbox-execution-checks-run.ts:10-60`). `docs/factory-agent-orchestration.md:489-501` still says validation is "local shell check execution in the Factory service"; that is stale.

### 1.6 Evidence

Evidence has two faces. (a) The per-task semantic status above. (b) The evidence bundle the worker writes to `receipt/current/evidence/evidence.json` and readable artifacts the controller collects (`packages/receipt-app/src/services/factory/task-packet-paths.ts:20`, `task-packet-evidence.ts:7-8,38-59`; per-file cap 32 KiB, total 64 KiB). Investigation results carry findings with `confidence: confirmed | inferred | uncertain` and a result `status: answered | partial | blocked` (`result-contract-investigation-schemas.ts:11-60`). Delivery results carry `outcome: approved | changes_requested | blocked | partial`, a `completion {changed, proof, remaining}` and an `alignment {verdict: aligned | uncertain | drifted, …}` (`result-contract-task-result-schema.ts:13-33`, `result-contract-task-completion-schema.ts:1-40`).

### 1.7 Promotion

Integration statuses (`types.ts:51-60`): `idle | queued | merging | validating | validated | ready_to_promote | promoting | promoted | conflicted`. The promotion gate (`packages/receipt-app/src/services/factory/promotion-gate.ts:28-48`) is skipped for investigation objectives and otherwise emits exactly one of:

* `Promotion gate blocked: planning receipt is missing.`
* `Promotion gate blocked: <taskId> is still blocked.`
* `Promotion gate blocked: no integrated task satisfied the objective.`
* `Promotion gate blocked: <taskId> is missing its completion contract.`
* `Promotion gate blocked: <taskId> did not record proof for the completed work.`
* `Promotion gate blocked: <taskId> still reports remaining work.`

`policy.promotion.autoPromote` defaults `true` (`defaults.ts:40-42`) but is forced `false` for investigation objectives (`objective-input-policy.ts:13-19`). Because the profile default mode is investigation, the *practical* default is manual promotion.

### 1.8 Profile

`profiles/receipt/PROFILE.md` is the only profile. Frontmatter: `id: "receipt"`, `label: "Beetle"`, 13 skills, `actionPolicy.allowedDispatchActions: create, react, promote, cancel, cleanup, archive`, `allowedCreateModes: delivery, investigation`, `orchestration: { executionMode: supervisor, discoveryBudget: 2, finalWhileChildRunning: reject, childDedupe: by_run_and_prompt }`, `defaultObjectiveMode: investigation`, `defaultValidationMode: repo_profile`, `defaultTaskExecutionMode: worktree`, `maxParallelChildren: 5` (`profiles/receipt/PROFILE.md:1-53`). The code's fallback snapshot uses `rootProfileLabel: "Receipt"` (`defaults.ts:46-48`), so "Beetle" is the profile label while "Receipt" is the code default.

Objective policy (`defaults.ts:29-43`): `concurrency.maxActiveTasks 5`, `budgets.maxTaskRuns 50`, `maxCandidatePassesPerTask 4`, `maxObjectiveMinutes 1440`, `throttles.maxDispatchesPerReact 10`, `promotion.autoPromote true`. The repo's `.receipt/config.json` also carries `budgets.maxReconciliationTasks`, `throttles.mutationCooldownMs` and a `mutation` group that the loader does not read.

---

## 2. Runtime topology

### 2.1 Process roles

One Bun/Hono image (`packages/receipt-app/src/server.ts` → `server/bootstrap.ts`, 3844 lines) started under `RECEIPT_PROCESS_ROLE`. `resolveProcessRole` accepts `api | driver | worker-chat | worker-control | worker-codex`, anything else → `all` (`packages/receipt-app/src/adapters/resonate-config.ts:26-35`). Only `api` serves HTTP and runs heartbeats (`packages/receipt-app/src/server/config.ts:36-45`); a non-API role parks forever (`bootstrap.ts:3842-3844`).

| Role | Registers | Also runs | Default concurrency |
|---|---|---|---|
| `api` | nothing (Resonate client only) | HTTP on `PORT` (8787), heartbeats, projection work pump, app-chat mirror, computer projections (`bootstrap.ts:3750-3811`) | n/a |
| `driver` | `receipt.job.driver` v1 (`resonate-runtime.ts:829-834`) | queued-job redrive | 1 |
| `worker-chat` | `receipt.job.execute` v1 (`:837-856`) | remote agent actions | `CHAT_JOB_CONCURRENCY` = 4 (`:106`) |
| `worker-control` | `receipt.job.execute` + objective watchdog worker (`:861-863`) | objective-control outbox redrive (`bootstrap.ts:2048-2050`) | `ORCHESTRATION_JOB_CONCURRENCY` = 1 (`:104`) |
| `worker-codex` | `receipt.job.execute` | — | `CODEX_JOB_CONCURRENCY` = 1 (`:102`) |

`RECEIPT_RESONATE_EXECUTE_CONCURRENCY` overrides all (`:98`). Resonate groups default to `receipt-api`, `receipt-driver`, `receipt-chat`, `receipt-control`, `receipt-codex` (`resonate-config.ts:49-62`). Function names: `receipt.job.driver`, `receipt.job.execute`, `receipt.factory.objective_watchdog.enqueue` (`:13-15`).

Routing is agent-id first (`resolveWorkerTarget`, `resonate-config.ts:89-99`): `agentId === "codex"` or kind starts with `factory.integration.` → codex group; `factory-control` → control group; otherwise chat group. Registered handlers are exactly `factory`, `factory-control`, `factory-monitor`, `codex` (`bootstrap.ts:1773-1776`; `services/factory-runtime.ts:1514-1519`). Note the `factory` agent (kinds `factory.run` and `factory.dispatch`) lands on the **chat** group although `RECEIPT_JOB_KIND_CONTRACTS["factory.dispatch"].workerGroup` says `control` (`runtime-contracts.ts:277-285`); unchanged since the prior report.

The Resonate client now uses a custom SSE poll adapter with `timeout: false` on the poll request and exponential reconnect (1 s doubling to 30 s), so idle workers no longer drop their poll connection (`packages/receipt-app/src/adapters/resonate-poll-source.ts:1-72`, wired at `resonate-runtime.ts:280-287`). `RESONATE_TOKEN` is forwarded as a bearer when set.

### 2.2 Lanes, statuses, lifecycle receipts

Job lifecycle receipts on `jobs/<jobId>` (`job.ts:12-91`): `job.enqueued`, `job.leased`, `job.heartbeat`, `job.progress`, `job.completed`, `job.failed`, `job.canceled`, `queue.command` (`steer | follow_up | abort`), `queue.command.consumed`, `job.lease_expired`.

Singleton semantics on `enqueue` (`packages/receipt-app/src/adapters/receipt-queue.ts:1359-1397`): `singletonMode` defaults `allow`; `cancel` aborts every active job on the `sessionKey` (`requestAbort(prior, "singleton cancel")`, `:1384-1387`); `steer` appends a `steer` command to the newest active job and returns it instead of creating a new job (`:1388-1397`). Expired leases are handled before the session scan (`:1382`). `maxAttempts` is clamped to 1..8.

### 2.3 Lease, heartbeat, timeout, settlement fences

* Lease per job (`resonate-config.ts:106-138`): default `JOB_LEASE_MS` 300 000; `factory-control` + `factory.objective.control` → `max(default, FACTORY_CONTROL_JOB_LEASE_MS ?? 900 000)`; `factory-monitor` on the computer path → `max(CODEX_JOB_LEASE_MS ?? 900 000, default)`; `codex` → `max(CODEX_JOB_LEASE_MS, min(payload.timeoutMs + 300 000, 3 600 000))`.
* Execution timeout `max(5 000, leaseMs - 1 000)` (`resonate-runtime.ts:58-73`); heartbeat cadence derived from `RECEIPT_RESONATE_ACTIVE_STALE_MS` (600 000) so two renewals fit before the stale fence (`:76-93`).
* `executeAndSettleJob` (`resonate-runtime.ts:553-709`): refuses stale attempts (`stale_attempt`), leases if `queued`, cancels if `abortRequested`, takes a start-fence heartbeat only for redelivered work (`lease_lost` on mismatch, `terminal_state` if already terminal), races handler / heartbeat loop / timeout (`execution_timeout`, `:470-551`), re-reads the job, then completes/fails/cancels under an `{ attempt }` fence inside `withReceiptStorageRetry` (`:685-690`); `settlement_conflict` if the fence lost. `afterComplete` runs only when settlement actually reached `completed` (`:694-702`).
* The driver never leases (comment `resonate-runtime.ts:762-768`); it fails stale active leases with `stale active Resonate job lost execution; retrying through Resonate driver` (`:735-750`) and begins the execute RPC with id `<jobId>:attempt:<n>[:dispatch:<key>]` (`:330-331, 776-796`).
* Delivery generations: `createResonateDriverStarter` walks up to 32 `…:recovery:<n>:<state>:<terminalAt>` keys when a prior promise is terminal, and returns `{created:false, reason:"active_delivery"}` when one is still pending (`:333-401`).
* A JSON callback is posted to `RECEIPT_RESONATE_CALLBACK_URL` / `RECEIPT_EVENT_CALLBACK_URL` on `dispatched | completed | failed | canceled` with optional `Authorization: Bearer $RECEIPT_CALLBACK_TOKEN` (`:236-270`).

### 2.4 Recovery loops

| Loop | Roles | Knobs (default) | Source |
|---|---|---|---|
| Queued-job Resonate redrive | every role | `RECEIPT_RESONATE_QUEUED_REDRIVE_INTERVAL_MS` 15 000, `_MIN_AGE_MS` 30 000, `_COOLDOWN_MS` 15 000, `_STARTUP_DELAY_MS` 5 000 | `bootstrap.ts:226-244`, `resonate-config.ts:37-44` |
| Objective-control outbox redrive | `worker-control`, `all` | `RECEIPT_OBJECTIVE_CONTROL_OUTBOX_REDRIVE_INTERVAL_MS` 5 000, `_TIMEOUT_MS` 15 000 (now an *observational* deadline: `createSingleFlightMaintenance` keeps ownership until the run settles and logs `factory.control_outbox_redrive_slow`) | `bootstrap.ts:2047-2069`, `server/single-flight-maintenance.ts` |
| Objective watchdog (Resonate cron) | whichever role has a client; worker runs on `worker-control` | `RECEIPT_FACTORY_OBJECTIVE_WATCHDOG_ENABLED` (on), `_CRON` `* * * * *`, `_TIMEOUT_MS` 60 000, `_SCAN_LIMIT` 200 (1..2000) | `bootstrap.ts:271-283, 1998-2021` |
| Objective resume at startup | redrive-eligible roles, after `RESONATE_STARTUP_SETTLE_MS` (1 000) | — | `bootstrap.ts:2023-2045` |
| Projection work pump | `api` only | 1 s tick, one bounded batch per projector per round | `bootstrap.ts:3780-3803`, `server/projection-work-pump.ts` |

Watchdog decisions (`packages/receipt-app/src/services/factory/runtime/objective-watchdog-runner.ts:25-36`): `no_active_objective_work`, `phase_supersession_has_active_stale_job`, `active_objective_work_stalled` → enqueue objective control with reason `reconcile`. Stale thresholds: live jobs 90 s (`live-job-status.ts:6`), computer execution recovery 15 min (`objective-resume-stale-jobs.ts:15`). Since `bd26d484` the watchdog scans `StoredObjectiveProjectionSummary` rows instead of full projections (`objective-watchdog-runner.ts:46-56`).

### 2.5 Text flow: enqueue → dispatch → driver → worker → settle

```
caller (POST /agents/factory/jobs | FactoryService | CLI)
  └─ receiptQueue.enqueue  → receipts: jobs/<id> job.enqueued (+ jobs index)
       └─ resonate dispatch outbox → createResonateDriverStarter
            └─ client.beginRpc(dispatchKey, "receipt.job.driver", {jobId}) → group receipt-driver
                 └─ driver role: driveResonateJob
                      • fail stale active lease / honour abortRequested
                      • beginRpc("<jobId>:attempt:<n>", "receipt.job.execute") → group by resolveWorkerTarget
                      • callback "dispatched"
                           └─ worker role (chat|control|codex): executeAndSettleJob
                                • lease (job.leased) or start-fence heartbeat
                                • handler(job, ctx) under heartbeat loop + timeout
                                • re-read job; complete/fail/cancel with {attempt} fence
                                • afterComplete (e.g. reactObjective) only if settled=completed
                                • callback completed|failed|canceled → POST /receipt/callback
                                     └─ api: receipt-append projection schedule + Postgres trigger
                                        marks receipt_projection_work → pump/projectors → Zero/UI
```

If any hop dies: the queued-job redrive re-begins the driver RPC with key `<jobId>:redrive:<attempt>:<updatedAt>`; the objective-control outbox redrive re-enqueues control jobs; the watchdog reconciles stalled objectives; an expired lease produces `job.lease_expired` and, if `attempt < maxAttempts`, a retry.

---

## 3. The objective control loop

`runObjectiveControl` (`services/factory/runtime/factory-service-objective-control-runtime-base.ts:55`) → `runObjectiveControlWithDeps` → loop passes. Each pass either processes **startup/admitted** or **reconcile** (`objective-control-runner-pass.ts:47-79`), and terminal objectives get `cleanupTerminalObjective` (`objective-control-runner-loop-pass.ts:19-25`). The control job is `factory.objective.control` on agent `factory-control`, lane `collect`.

The mechanics (verified against `docs/factory-agent-orchestration.md:357-430`, which is accurate here): `objective.created` → `objective.supervisor.triggered` → validated semantic decision (`apply_plan` → `task.added*`; terminal model failure → block) → `reactObjective()` activates ready tasks and dispatches worker jobs up to policy limits → worker results append receipts → `reactObjective()` again. Compare-and-append discipline: mutations carry `expectedPrev` and are retried on `Expected prev hash …` (`packages/receipt-app/src/factory-cli/actions.ts:60-76` for the CLI side).

Deterministic failure circuit: two consecutive sandbox-backed tasks blocked with the same failure family block the objective without another model call (`objective-supervisor-failure-circuit.ts:11-95`, model tag `deterministic:repeated-execution-failure-circuit-v1`). Since `e6944514`, a permanent model authentication failure (HTTP 401 / `invalid_api_key`) is non-retryable and surfaces as `Your OpenAI API key is invalid or expired. Update it in BYOK settings and retry. (<raw>)` (`model-error-retry.ts:1-11`, `objective-supervisor-runner.ts:124-133, 429-431`).

**Task monitor** (`factory.task.monitor`, agent `factory-monitor`): a loop polling every 10 s that records liveness/evidence checkpoints (`monitor-job-runner-core.ts:13-29`, `monitor-job-runner-checkpoint-decision.ts:3-13`); receipts `monitor.checkpoint`, `monitor.checkpoint.failed`, `monitor.recommendation*`. The doc's statement that "every production checkpoint is continue-only" matches the code comment in `investigation-lifecycle-evidence.ts:13-18` ("new monitor checkpoints never mint [`sufficient`]").

Factory receipt event families produced by the reducer (`packages/receipt-app/src/modules/factory/reducer.ts`, `case` labels): `objective.{created,blocked,canceled,completed,failed,archived,handoff,operator.noted,slot.queued,slot.admitted,slot.released,supervisor.triggered,supervisor.requested,supervisor.decided,supervisor.failed,control.enqueue.*}`, `planning.receipt`, `task.{added,ready,dispatch.requested,dispatch.enqueued,dispatch.payload_persisted,dispatch.preflight_failed,dispatch.enqueue_failed,dispatched,evidence.observed,phase.transitioned,approved,blocked,unblocked,integrated,noop_completed,superseded,review.requested,synthesis.dispatched,synthesis.completed,synthesis.blocked,workbench.*}`, `candidate.{created,produced,reviewed,conflicted}`, `integration.{queued,merging,validating,validated,validation.*,ready_to_promote,promoting,promoted,conflicted,publish.*}`, `investigation.{synthesized,reported}`, `merge.applied`, `rebracket.applied`, `monitor.*`, `worker.handoff`, `effect.{requested,enqueued,started,succeeded,failed,expired,canceled}`, and the `computer.*` family (lease, command, credential_setup, artifacts).

---

## 4. Execution: the computer path on OpenSandbox

### 4.1 Configuration

Defaults (`packages/receipt-app/src/services/factory/opensandbox-config-default-values.ts:1-12`): domain `localhost:8080`, protocol `http`, image `receiptfactory/opensandbox-worker:local`, template `receipt-factory-opensandbox-v1`, remote workspace root `/workspace/receipt-workspaces`, ready/request timeouts 120 s, sandbox timeout 3600 s, cpu `2`, memory `4Gi`, host ready timeout 180 000 ms, host idle stop 20 min (the last value is now unused; see 4.2). Env overrides carry the `OPEN_SANDBOX_*` prefix (`opensandbox-config-env-*.ts`). Two hard guards remain: `OPEN_SANDBOX_IMAGE is required for cloud OpenSandbox execution; refusing to use the local-only default image.` and the published-image requirement when workers use a public gateway (`opensandbox-config-env-runtime.ts:69-96`).

Sandbox creation passes image, entrypoint, `RECEIPT_FACTORY_OBJECTIVE_ID` / `RECEIPT_FACTORY_COMPUTER_SCOPE_ID` env, metadata, `timeoutSeconds`, `readyTimeoutSeconds`, `secureAccess`, and `resource: { cpu, memory }` to `Sandbox.create` from `@alibaba-group/opensandbox` (`opensandbox-sandbox-create.ts:11-37`). The lease handle is `{ provider: "opensandbox", computerId, machineId, remoteWorkspaceRoot: <root>/<objectiveId>, templateVersion, acquiredAt }` (`opensandbox-sandbox-lease.ts:17-27`).

### 4.2 Capacity and lease acquisition

Capacity is a receipt-backed ledger: global limit `OPEN_SANDBOX_GLOBAL_MAX_ACTIVE` (default 1) and per-organization `OPEN_SANDBOX_ORG_<ORG>_MAX_ACTIVE` or `OPEN_SANDBOX_ORG_MAX_ACTIVE` (default 1) (`computer-capacity-ids.ts:56-73`). Capacity leases last 240 s, poll every 1 s, notify waits after 15 s, and stale claims expire after 3 min (`computer-capacity-defaults.ts:4-8`).

The Codex run emits progress receipts with these exact summaries (`opensandbox-execution-codex.ts:34-129, 176-181`): `Requesting a computer.` (`computer.lease.requested`), a wait summary (`computer.lease.waiting`), `Computer acquired; resolving the workspace.`, `Computer acquired.` (`computer.lease.acquired`), `Preparing the computer workspace.` with detail `Syncing task files, selected skills, credentials, and execution metadata.`, `Computer workspace is ready; starting the agent.`, `Starting the agent in the computer.`, and `Released the computer.` (`computer.lease.released`).

Host lifecycle change (`d62e9136` / `e6944514`): the per-worker `OpenSandboxHostLifecycle` no longer schedules an idle EC2 stop; "Host shutdown is an explicit operator action until a global controller can fence admissions" (`opensandbox-host-lifecycle.ts:16-20`; `opensandbox-host-stop.ts` deleted). Idle hosts now run until an operator stops them (`docs/tool-reliability-fixes-2026-09-05.md`).

### 4.3 Workspace sync and the task packet

Workspace sync runs under `RECEIPT_OPENSANDBOX_WORKSPACE_SYNC_TIMEOUT_MS` (default 180 000, 1 000..900 000) (`opensandbox-execution-workspace-sync.ts:16-27`). Investigation workers get a **receipt-only** workspace (packet plus helper roots, no application repo, no dependency bootstrap) (`task-execution-codex-run-input.ts:19-22, 45-49`); delivery workers get the repository worktree.

Packet directory constant `FACTORY_TASK_PACKET_DIR = "receipt/current"` (`task-packet-constants.ts:1`); files (`task-packet-paths.ts:9-30`): `objective.json`, `task.json`, `manifest.json`, `context.md`, `context-pack.json`, `prompt.md`, `output/result.json`, `output/stdout.log`, `output/stderr.log`, `output/last-message.md`, `evidence/evidence.json`, `skills/skill-bundle.json`, `memory.cjs`, `memory-scopes.json`, `receipt-cli.md`. Integration packets add `output/<candidateId>.integration.{json,stdout.log,stderr.log}` (`:32-42`). The remote fallback prompt/last-message paths are `.receipt/factory/prompt.md` and `.receipt/factory/last-message.txt` (`opensandbox-execution-codex-paths.ts:37-41`). The `.receipt/factory/<taskId>.*` naming referenced by `CLAUDE.md` and `skills/factory-agent-cli/SKILL.md` survives only in simulation fixtures; `receipt/current/` is the packet a worker actually sees.

`receipt/current/receipt-cli.md` is generated by `renderFactoryReceiptCliSurface` (`task-packet-cli-surface.ts:3-84`). Its exact headings: `# Factory Receipt CLI Surface`, `## Read First`, `## Receipt-Only Workspace` or `## Task-Worktree Safe Receipt Commands`, `## Connected Systems`, `## Objective Repair Commands`, `## Do Not Run From This Task Worktree`, `## Working Rule`. It tells the worker `Receipt applies provider credentials server-side; never request or print them.` (`:52`).

The checked-in helper `receipt/bin/receipt-workbench` has three commands: `path`, `show` (prints `Receipt workbench: <path>`, optional `Objective:`/`Task:`, and `Read receipt/current/context.md and receipt/current/receipt-cli.md.`), and `finalize` (`receipt/bin/receipt-workbench:141-166`).

### 4.4 What runs inside: the Codex CLI

The remote command is `buildRemoteCodexArgs` (`packages/receipt-app/src/services/factory/lima-remote-codex-args.ts:293-322`):

```
codex -a never [--search] exec [-m <model>] [-c model_provider=…] [-c openai_base_url=…]
  -c model_reasoning_effort="<low|medium|high>" --cd <remoteWorkspacePath>
  --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --color never
  [--json] --output-last-message <path> [--output-schema <path>] -   < prompt.md
```

The Codex kernel sandbox is bypassed because "Docker workers intentionally do not allow the nested namespace operations used by Codex's bubblewrap sandbox" (`:305-311`); OpenSandbox is the isolation boundary. `--search` is enabled only for `executionClass === "broad"` tasks (`task-execution-codex-run-input.ts:35`). Task model default `gpt-5.6-luna` via `RECEIPT_FACTORY_TASK_MODEL` (`factory-service-config.ts:8-11`); publisher runs at `reasoningEffort: "low"` (`integration-publish-codex-input.ts:46`). Codex home is isolated per workspace with a fixed `config.toml` (`[features] multi_agent = true, js_repl = false`, `adapters/codex-isolation-config.ts:6-9`). A dev stub replaces Codex when `RECEIPT_FACTORY_REMOTE_CODEX_STUB` is truthy (`lima-remote-codex-args.ts:61-63`).

Exec supervision (`opensandbox-execution-codex-exec.ts:34-36, 84-97`): startup timeout 60 s (`RECEIPT_CODEX_STARTUP_TIMEOUT_MS`), stall timeout 300 s (`RECEIPT_CODEX_STALL_TIMEOUT_MS`), abort poll 500 ms; a control abort or stall destroys the lease and raises `CodexControlSignalError` so it is logged as `codex_remote_aborted`, not an infra failure (`opensandbox-execution-codex.ts:149-160`).

### 4.5 Credentials inside the sandbox

Preparation order (`remote-execution-auth-env.ts:63-140`): (1) build the auth projection; (2) `applyAuthProjection` writes files under the remote home and runs post-apply commands (`lima-auth-apply.ts:9-40`); (3) build the remote env; (4) emit `computer.credential_setup.started` with `Installing and validating remote credentials before command startup.`; (5) `ensureRemoteReceiptConnectCliConfig`; (6) `computer.credential_setup.succeeded` with `Remote credential setup completed with <n> helper file(s).` or `…; no Receipt Connect helpers were required.`, else `computer.credential_setup.failed`.

**Receipt Connect helpers (the real-CLI path).** The controller mints a job-scoped Receipt Connect JWT with scopes `connect:read` plus, when the contract requires it, `connect:credential` and the contract's write scopes (`runtime/receipt-connect-env.ts:23-36`); it is written to `<workspace>/.receipt/connect/token` (mode 600) (`lima-receipt-connect-context.ts:36-48`). The capability manifest is fetched from the controller gateway, filtered to remote-capable transports (`nango-cli`, GitHub token, AWS `local-aws-profile` / `aws-credential-process`) (`lima-receipt-connect-manifest.ts:9-19`), narrowed to the objective's selected providers (`lima-receipt-connect-configure.ts:19-22`), then per provider:

| Provider | Materialization | Source |
|---|---|---|
| AWS | `~/.aws/config` and `<configDir>/aws-config` with `[default]`/`[profile receipt…]` entries whose `credential_process` is a generated script; env `AWS_PROFILE`, `AWS_CONFIG_FILE`, `AWS_EC2_METADATA_DISABLED=true`; region hard-coded `us-east-1` in the profile | `lima-receipt-connect-provider-aws.ts:16-72` |
| GCP/GCS | `CLOUDSDK_CONFIG` dir, `BASH_ENV` that prepends `<ws>/.receipt/bin`, and wrappers for `gcloud`, `bq`, `gsutil` that fetch a fresh token per command into a mode-0600 temp file and export `CLOUDSDK_AUTH_ACCESS_TOKEN_FILE`; `gsutil` is routed to `gcloud storage` | `lima-receipt-connect-provider-gcp.ts:96-190` |
| kubectl | generated kubeconfig with an exec credential plugin per connection | `lima-receipt-connect-provider-kubectl.ts:11-40` |
| Jira | `JIRA_CONFIG_DIR` + credential script | `lima-receipt-connect-configure.ts:37-44` |
| Generic HTTP integrations | **not installed**; the worker uses `receipt connect call …` so "their credentials never enter the sandbox" | `lima-receipt-connect-provider-simple.ts:11-14` |

Every helper is the same shell script: it reads the token file, `curl -X POST <gateway>/connect/credential/<provider>[?connection=…]`, and pipes the JSON through `jq` (`lima-receipt-connect-helpers.ts:3-40`); a non-retryable error prints `Receipt Connect terminal credential error [<code>]: <message>`, a retryable one prints `Receipt Connect credential request failed (HTTP <status>): <message>`, exit 22. The gateway endpoint requires the `connect:credential` scope and current workspace membership, then serves a stored AWS credential-process bundle, a local AWS profile bundle, a stored GitHub token, or a Nango-backed connection (`server/receipt-connect-routes.ts:2024-2135`).

**What the guarantee actually is.** Provider secrets for AWS/GCP/kubectl/Jira are not placed in the sandbox environment or in static files; each CLI call fetches them from the gateway at use time under a job-scoped token, and generic integrations are proxied server-side. The worker prompt discipline also says `Never print or persist raw secret, token, password, API key, or credential values in stdout, stderr, artifacts, or the final JSON.` (`prompt/task-prompt-discipline.ts:26`). Three things *are* placed in the sandbox and a docs page must say so:

1. The organization's OpenAI BYOK key (or platform-credit key) is written to `~/.codex/auth.json` (`lima-auth-byok.ts:73-97`, `sensitive: true`). Factory refuses to run without an org-scoped key: `Factory runtime requires organization-scoped BYOK context.` / `Factory runtime requires an organization OpenAI BYOK key.` (`:26-36`).
2. If the controller host's `gh` CLI is logged in, its token is projected as `GH_TOKEN`/`GITHUB_TOKEN` plus `~/.config/gh/{config,hosts}.yml` and `gh auth setup-git` runs post-apply (`lima-auth-gh.ts:15-60`, `lima-auth-projection-default.ts:13-22`). The host `~/.codex/auth.json` is also projected when present (`lima-auth-host-codex.ts:9-18`) but is replaced by the BYOK file.
3. Ambient env keys copied from the controller when set: `OPENAI_BASE_URL`, `OPENAI_API_BASE`, `OPENAI_ORGANIZATION`, `OPENAI_ORG_ID`, `OPENAI_PROJECT`, `GH_TOKEN`, `GITHUB_TOKEN`, `GH_HOST`, `OPENAI_MODEL`, `RECEIPT_FACTORY_CHAT_MODEL`, the Factory ids, and the `RECEIPT_CONNECT_*` set (`lima-auth-env-keys.ts:1-30`, `lima-remote-env.ts:24-29`). The AWS auth fragment is intentionally empty (`lima-auth-fragment-aws.ts:3-8`).

**`--required-capability`.** The CLI flag (aliases `--capability`, `--connect`, `--aws`) splits, lower-cases, de-duplicates, and sorts values (`factory-cli/commands/index.ts:251-266`); the CLI no longer infers capabilities from prompt text. On the runtime side, since `e6944514` "Discovery describes what an actor can access; it is not a request to require every provider" — a capability context whose `source === "active-integrations"` is ignored as a dependency source; only explicit or model-selected providers become execution dependencies (`capability-selection.ts:1-10`, `objective-connected-delivery.ts:8-23`). Readiness codes when the contract cannot be satisfied: `workspace_missing`, `codex_missing`, `codex_auth_missing`, `receipt_cli_missing`, `receipt_connect_unavailable`, `credential_helper_missing`, `provider_cli_missing` (`types.ts:109-118`); `receipt_connect_unavailable` details include `Receipt Connect gateway URL must be reachable from the remote worker before credential installation. … Set RECEIPT_CONNECT_WORKER_GATEWAY_URL or RECEIPT_CONNECT_PUBLIC_GATEWAY_URL to a worker-reachable Receipt web URL.` (`run-readiness-credential-prerequisites.ts:12-53`).

---

## 5. Tool interaction and result handling

### 5.1 From worker output to receipts

After the Codex command exits, `finalizeOpenSandboxCodexRunResult` records child exit, retries artifact/patch collection up to 3 times on transport interruption (750 ms × attempt), writes `stdout.log`/`stderr.log`, reads `last-message.md`, extracts token usage from the JSON event stream, and flushes the stdout projection (`opensandbox-execution-codex-result.ts:31-90, 152-195`). Raw stream bytes are persisted as artifacts and deliberately do not become transport-chunk receipts (`:180-182`).

The structured result is `result.json` if present, else the last message parsed as JSON; otherwise `FactoryServiceError(500, "missing structured factory task result from codex")` (`worker-result-task.ts:7-38`). Outcome handling (verified against `docs/factory-on-receipt.md:722-728`, still accurate): `approved` → `candidate.reviewed` approved (and `task.noop_completed` if the worktree is clean and checks pass); `changes_requested` → task back to `ready`; `blocked` → `task.blocked`; `partial` preserved for investigation reports and treated as blocked for delivery.

Every codex-lane job (`factory.task.run`, `factory.integration.validate`, `factory.integration.publish`) ends with `afterComplete: reactObjective(objectiveId)` unless the result is `skipped_terminal_state` (`services/factory-runtime.ts:1804-1815`). Steer/follow-up commands are pulled during execution and can restart the Codex turn; abort is honored within ~500 ms (`:1687-1717`, `opensandbox-execution-codex-exec.ts:70-82`).

### 5.2 Integration worktrees, validation, promotion

HubGit keeps a bare repo and worktrees under `<dataDir>/hub/worktrees` (`adapters/hub-git.ts:216`). Task worktrees are on branch `hub/<agentId>/<workspaceId>` (`:450`); the integration worktree is `factory_integration_<objectiveId>` on branch `hub/integration/factory_integration_<objectiveId>` (`:592-620`). Merge is a real git merge (`mergeCommitIntoWorkspace`, `:626`); promotion is `promoteCommit` (`:648`), a fast-forward into the source branch. The tenant layout puts `repos/`, `worktrees/`, `artifacts/` under `<RECEIPT_TENANT_ROOT>/<org>` (`server/tenant-context.ts:120-122`).

Validation (`integration-validation-runner-core.ts:15-78`): emits `integration.validating`, runs the checks for the state (in the sandbox, 1.5), writes validation artifacts, then either `handleFailedIntegrationValidation` or emits validated events with summary `Integration checks passed for <candidateId>.` and handoff `… Controller may continue toward promotion.`, commits integration memory tagged `integration, validated`, and reacts the objective. A computer-unavailable error becomes `FactoryServiceError(501, …)`.

### 5.3 PR publishing

`factory.integration.publish` runs Codex once more with the `factory-pr-publisher` skill and a strict output schema `{summary, handoff, prUrl, prNumber, headRefName, baseRefName}` (`result-contract-publish-schemas.ts:1-14`). The skill's steps are: read history with `receipt memory summarize factory/objectives/<id>` and `receipt inspect …`, `git push -u origin HEAD`, `gh pr view --json …` then `gh pr create --title "<Objective Title>" --body "…"`, retry transient GitHub errors up to 2 more times, and return the JSON (`skills/factory-pr-publisher/SKILL.md:12-45`). The publisher must not run builds or tests. The result is normalized by `normalizeFactoryPublishResult`; a missing or non-http(s) `prUrl` fails with the worker's own blocker summary or `factory publish result missing valid prUrl` (`worker-result-publish.ts:22-50`). Publish requires the GitHub token described in 4.5 (`integration-publish-codex-input.ts:59-60` passes `publishGitHubAuthEnv`).

Since `e6944514`, terminal replay no longer attempts to publish media artifacts from ephemeral workspaces; task result publication is authoritative (`runtime/terminal-render-artifacts.ts:40-46`).

### 5.4 Helper catalog

`skills/factory-helper-runtime/catalog/infrastructure/` ships 40 helpers at HEAD (20 `aws_*`, 19 `gcp_*`, plus `ec2_terminated_instance_audit` and `nat_gateway_cost_spike`), each a `manifest.json`. `receipt factory helper list|run` shells out to `python3 skills/factory-helper-runtime/runner.py` (`services/factory-helper-catalog.ts`), and the packet's context selects helpers for the task (`task-packet-summary-helper-selection.ts`). Python 3 is therefore a prerequisite for helper execution.

---

## 6. Chat integration

### 6.1 Chat turn → objective → sandbox → receipts → thread

```
user message in app thread
  └─ apps/start receipt-chat.service: one-shot LLM router ("You are the Beetle chat router…")
       route "chat"  → direct streamed answer
       route "factory" → POST <runtime>/agents/factory/jobs
            {kind:"factory.run", lane:"chat", sessionKey:"factory-chat:<sessionStream>",
             singletonMode:"allow", maxAttempts:2, objectiveMode, capabilityContext, authContext{source:"app-chat"}}
            └─ worker-chat: createFactoryIngressJobHandler → one create/react/control action
                 └─ objective.created on factory/objectives/<id>  (+ chat binding)
                      └─ factory-control: objective control → supervisor plan → task.dispatched
                           └─ worker-codex: factory.task.run → OpenSandbox lease → Codex → result.json
                                └─ computer.* / task.* / candidate.* receipts; job settles; reactObjective
  ◄─ api: objectiveProgressMirrorScheduler (1 s coalesced) → writeObjectiveProgressToAppChatSession
  ◄─ app polls /factory/api/objectives/:id/live-status, emits progress + activity lines,
     heartbeats on fresh progressAt, and posts the terminal objective answer into the thread
```

Evidence: router prompt and decision types `services/chat-layer-routing.ts:15-79`; job payload `apps/start/src/lib/backend/chat/services/receipt-chat.service.ts:2144-2200`; enqueue `:3757-3775`; ingress handler `server/bootstrap.ts:1641-1670`; mirror `bootstrap.ts:705-780` and `server/objective-progress-mirror-scheduler.ts` (`RECEIPT_OBJECTIVE_PROGRESS_MIRROR_INTERVAL_MS`, default 1000); app-side progress loop `receipt-chat.service.ts:2724-2760, 3079-3150`. A bare or malformed router decision "fails closed to delivery" (`:2127-2135`); a `create` action never leaks the previous objective's context (`:2116-2124`).

The runtime's own `/factory` shell posts the same job with `singletonMode: "cancel"` and `maxAttempts: 1` (`agents/factory/route/register-factory-api-routes.ts:471-483`), and turns a follow-up on an objective with no consumer into `reactObjectiveWithNote` (`:445-465`). Chat streams: profile `agents/factory/<repoKey>/receipt`, sessions `…/sessions/<chatId>`, objectives `…/objectives/<objectiveId>` (`services/factory-chat-profiles.ts:436-443`).

### 6.2 Objective board sections

`BOARD_SECTION_META` (`packages/receipt-app/src/factory-cli/view-model.ts:49-67`): `Needs Attention` — `Blocked or conflicted objectives that need review.`; `Active` — `Objectives currently holding the repo execution slot.`; `Queued` — `Objectives waiting for the repo execution slot.`; `Completed` — `Recently finished or canceled objectives.`; `Archived` — `Retired objectives kept out of the active operator queue.` The same sections render as `== Needs Attention ==` etc. in `receipt factory board` text mode.

### 6.3 The `/tasks` page and its "New Task" panel

Route `apps/start/src/routes/(app)/_layout/tasks/route.tsx` (auth-gated, redirects to `/auth/sign-in`). Page title `Beetle Tasks`, description `Task workspace for Beetle, backed by connected objectives and proof-oriented agent runs.` (`apps/start/src/components/tasks/tasks-page.tsx:172-173`). Metrics: `Unresolved`, `Running`, `Blocked`, `Done` (`:178-181`). Button `New Task` opens the create panel via search param (`:183-188`). Rows come from the Zero query `receipt.recentObjectives` over `receiptObjectiveProjection` scoped by `ownerOrgId` (`apps/start/src/integrations/zero/queries/receipt.queries.ts:52-64`).

Stage labels (`:1219-1275`): `New`, `Queued`, `Running`, `Blocked`, `Reviewing`, `Done`, `Failed`, `Archived`; derivation at `:1183-1192` (archived → `archived`; `completed` → `done`; terminal-failed → `failed`; `blocked`/`blockedReason` → `blocked`; review integration statuses → `reviewing`; active tasks or `executing` → `running`; `slotState === 'queued'` or `waiting_for_slot` → `queued`; else `new`).

"New task" panel (`:415-636`): heading `New task`, badges `Draft`, `Catalog task` / `Receipt-backed`; description `Receipt-backed task composer with scoped context, proof target, and PR handoff.` or `Connector catalog task with implementation scope, proof target, and PR handoff.`; section `Task intent` (`Work definition and execution controls.`); lane cards `Improvement check` (`Investigate a Receipt signal, reproduce it, and return a scoped fix with proof.`) and `Add/improve integration` (`Build the checked-in connector catalog path, Nango mapping, tests, and PR-ready change.`); fields `Title` (placeholder `Bound durable debug snapshot scans`), `Problem` (`What should the agent change, build, or investigate?`), `Priority` (`P1`..`P4`), `Scope` (`ReceiptFactory`), `Additional evidence` / `Context and constraints`, `Done when` (`What must be true before this is considered fixed?`); aside `Agent handoff`; buttons `Discard`, `Save draft`, `Create task`; queued notice `Queued run <jobId>. The task will appear in the queue when it starts.`; error fallback `Beetle task creation failed.`

Submission posts `POST /agents/factory/jobs` with `{kind:"factory.dispatch", action:"create", channel:"tasks", lane:"chat", sessionKey:"tasks:<org>:<user>", singletonMode:"allow", maxAttempts:2, severity, checks:['bun run check:full']}` (`apps/start/src/lib/frontend/tasks/beetle-task.server.ts:104-134, 169-180`). Cancel aborts the objective's jobs first (`reason: "stopped by the user"`), then dispatches `action:"cancel"`; delete dispatches `action:"archive"` with reason `deleted from the tasks page` (`objective-control.server.ts:252-258, 271-277`). Toasts: `<title> deleted.` (`tasks-page.tsx:1027`). The dispatch handler resolves the profile and runs `executeFactoryDispatch` with `computerProvider: "opensandbox"` (`bootstrap.ts:1689-1758`).

The app also has a `Computers` page (`<provider> capacity and live execution output`, cards `Current work`, `Live output`, `Inventory`, `Active runs`) at `/computers` (`apps/start/src/components/computers/computers-page.tsx:343-438`).

---

## 7. Memory

Memory is receipt-backed: scope `foo/bar` → stream `memory/<safe-scope>` (`runtime-contracts.ts:72-77`), events `memory.committed | memory.accessed | memory.forgotten`, operations `read | search | summarize | commit | diff | reindex` (`docs/memory.md:95-175`, verified table names carry the `receipt_` prefix in `db/schema.ts`). Search is semantic when an embedding function is configured, else keyword.

Factory scopes per task packet (`task-packet-memory-scopes.ts:10-58`): `factory/agents/<workerType>` (read-only), the repo-shared scope `repos/<repoKey>/shared` (read-only; the doc's `factory/repo/shared` is the fallback name), `factory/objectives/<id>`, `…/tasks/<taskId>`, `…/candidates/<candidateId>`, `…/integration`; plus `…/publish` (`runtime-contracts.ts:62-63`). Audit scopes: `factory/audits/objectives/<id>` and `factory/audits/repo` (`services/factory-runtime.ts:1247, 1389, 1404`). The packet's `memory.cjs` exposes `context | objective | overview | scope | search | read | commit` (`docs/memory.md:300-320`). Preferences live in `users/default/preferences`, `repos/<repoKey>/users/default/preferences` and the `…/profile` scopes; CLI `receipt memory prefs list|add|remove` (`cli/commands.ts:2523`). Session recall is a projection (`session_messages`), not a memory scope.

---

## 8. Self-improvement, eval, deterministic simulation

* **Self-improvement** is an audit loop, not autonomous self-modification (`docs/factory-self-improvement.md:9-40`). A terminal objective enqueues `factory.objective.audit`; `runFactoryObjectiveAudit` reconstructs the run, writes `objective.audit.{json,md}`, commits to the audit scopes, and — only when `FACTORY_OBJECTIVE_AUDIT_SYSTEM_IMPROVEMENT=true` — produces a repo-wide system-improvement report (`factory-runtime.ts:1176-1510`, `bootstrap.ts:223-224`). Since `e6944514` an audit whose objective head moved returns `{status:"superseded"}` instead of throwing (`factory-runtime.ts:1061-1069, 1196-1203`). Operators apply a recommendation through `POST /factory/api/objectives/:id/self-improvement/apply` / `…/api/system-improvement/apply` (errors `Provide a valid recommendation index.`, `A fresh self-improvement recommendation snapshot is not available.`, `That self-improvement recommendation no longer exists.`, `Failed to create or locate the auto-fix objective.`; `register-factory-api-routes.ts:520-580`). These routes are on the private runtime shell only; the app UI does not reach them.
* **Eval**: `receipt eval run|batch|report|inspect|replay|list-scenarios` (`cli/eval.ts:96-190`) over two checked-in scenarios (`eval/scenarios/software/repo-grounding-smoke.json`, `eval/scenarios/computer-use/factory-workbench-flow.json`).
* **Deterministic simulation**: `@receipt/dst` supplies virtual clocks, seeded entropy, deterministic ids, and a scheduler; `receipt factory simulate …` runs named suites; `receipt dst [--context] [--strict]` audits receipt chains and Factory packets (`docs/receipt-dst.md:1-60`). Since `61751714` a `projection-replay-storm` suite ("RCA-404 … three-objective telemetry burst") is registered and required in the production incident reliability gate (`factory-cli/commands/index.ts:4039-4045`).

---

## 9. The in-repo `receipt factory` CLI surface (brief)

Dispatcher `handleFactoryCommand` (`packages/receipt-app/src/factory-cli/commands/index.ts`). Bare `receipt` in a TTY opens the Factory board (`cli.ts:24-29`). Subcommands at HEAD: config-free `init`, `investigate`, `audit`, `insights`, `doctor`, `experiment`, `simulate`, `helper`, `agent help`; config-backed `agent`, `board`, `run`, `create`, `compose`, `watch`, `inspect`, `replay`, `replay-chat`, `analyze`, `parse`, `resume`, `react`, `note`, `promote`, `cancel`, `cleanup`, `archive`, `abort-job`, `steer`, `follow-up` (switch cases from `index.ts:4159+`). The agent envelope schema is `receipt-cli/factory-agent-envelope/1` with `artifactRefs` and `nextCommands` (`:1744-1810`). `run`/`resume` exit codes: completed 0, failed/canceled/integration_conflicted 1, blocked/manual-promotion 2 (`:2696-2716`). The only CLI change since `41baea75` is the added `projection-replay-storm` simulate suite. Another report covers CLI details.

---

## 10. Observability

* **Receipts are the audit trail.** Every objective, task, candidate, integration, computer lease/command, credential setup, and job transition is a hash-chained receipt; `receipt factory investigate|audit|insights|replay|parse`, `receipt dst`, and the `/receipt` browser read them.
* **Structured logs**: `service: "receipt-runtime"`, one JSON object per line, secrets redacted by key pattern. Runtime events at HEAD (`bootstrap.ts`, verified by grep): `runtime.http_listening`, `runtime.worker_connected`, `runtime.configured`, `runtime.startup_failed`, `runtime.shutting_down`, `http.unhandled_error`, `factory.watchdog_schedule`, `factory.watchdog_schedule_failed`, `factory.resume_failed`, `factory.reconcile_enqueue_failed`, `factory.audit_enqueue_failed`, `factory.control_outbox_redrive_failed`, `factory.control_outbox_redrive_slow`, `factory.ui_warmup_failed`, `projection.app_chat_sync_failed`, `projection.chat_stream_sync_failed`, `projection.computer_inventory_sync_failed`, `projection.computer_lease_run_sync_failed`, `projection.durable_catchup_failed`, `projection.objective_progress_mirror_failed`, `projection.sync_latency` (threshold `RECEIPT_PROJECTION_SYNC_LATENCY_LOG_THRESHOLD_MS` 250), `resonate.dispatch_error`, `resonate.dispatch_outbox_error`, `resonate.queued_redrive`, `resonate.queued_redrive_loop_error`, `resonate.queued_redrive_startup_error`, `resonate.role_runtime_error`. OpenSandbox events are JSON lines on stderr typed `factory.opensandbox.<event>` with events `lease_acquire_start|lease_acquired|lease_acquire_failed|workspace_sync_start|workspace_sync_ready|workspace_sync_failed|codex_remote_start|codex_remote_completed|codex_remote_aborted|codex_remote_failed|lease_released|lease_release_failed|post_result_collection_retry` (`opensandbox-logging.ts:8-16`).
* **Health**: `GET /healthz` always 200 with `{ ok, ready, degraded:false, uptimeSec, dataDir, processRole, queue, postgres, codexBin, resonateUrl }`; `GET /readyz` 200/503 on Postgres (`bootstrap.ts:2710-2737`). Readiness, not liveness, is the real gate.
* **Metrics**: Receipt exposes no `/metrics`; the only Prometheus endpoint is the local Resonate server's (`RESONATE_METRICS_PORT`, default 9090, `scripts/start-resonate-runtime.mjs:199,236`). No OpenTelemetry integration exists in `packages/receipt-app`.
* **Live UI**: WebSocket `GET /factory/live`; SSE `GET /receipt/stream` and `GET /jobs/:id/events`; `GET /factory/api/objectives/:id/live-status` for progress.

---

## 11. Limitations and feature classification

| Feature | Classification | Evidence |
|---|---|---|
| Create/cancel/delete tasks from `/tasks` | implemented, reachable in UI | `tasks-page.tsx`, `beetle-task.server.ts` |
| Chat turn → objective | implemented, reachable in UI | `receipt-chat.service.ts:2144-2200` |
| Objective board, inspect, steer, follow-up | implemented, reachable in CLI (`receipt factory …`) | `factory-cli/commands/index.ts` |
| Runtime `/factory`, `/factory-new`, `/factory-preview` shells | implemented but hidden (private gateway route; direct URL only) | prior report §1.4, unchanged |
| Self-improvement apply | implemented but hidden (runtime shell routes only) | `register-factory-api-routes.ts:520` |
| `receipt factory doctor` | stubbed/inert (always throws) | `doctor.ts:449-451` |
| `receipt factory init` "Repository profiling" | cosmetic (fixed string, hard-coded `bun run build`) | prior report §4.2, unchanged |
| Auto-promotion | implemented but off in practice (investigation default) | `objective-input-policy.ts:13-19` |
| OpenSandbox host auto-stop | removed (absent at HEAD) | `opensandbox-host-lifecycle.ts:16-20` |
| Local/host execution path | absent | `types.ts:87` |
| GPU compute | absent by design | `docs/factory-durable-execution-architecture.md:23` |
| CrewAI/LangGraph/AutoGen adapters | absent | prior report §8, unchanged |
| Prompt-text capability inference | absent (explicit or model-selected only) | `capability-selection.ts` |
| `/metrics` on Receipt | absent | grep |

Other limits worth stating: one computer per organization by default (`OPEN_SANDBOX_ORG_MAX_ACTIVE` 1) and one globally (`OPEN_SANDBOX_GLOBAL_MAX_ACTIVE` 1); a worker-codex process runs one job at a time; delivery objectives per repo capped by `repoSlotConcurrency` (20); objective wall-clock budget 24 h; AWS region in generated profiles is fixed to `us-east-1`; investigation is the default mode and is manual-promotion only; Factory requires an organization OpenAI BYOK key; helpers require `python3`; publishing requires a GitHub token available to the controller.

---

## 12. Text flows for diagrams

**A. Enqueue → dispatch → driver → worker → settle** — see §2.5.

**B. Chat turn → objective → sandbox → receipts → thread** — see §6.1.

**C. Delivery objective end-to-end**: `objective.created` → slot admitted/queued → `factory.objective.control` → supervisor `apply_plan` → `task.added` → `task.dispatched` (`factory.task.run` + `factory.task.monitor`) → `computer.lease.requested/acquired` → `computer.credential_setup.*` → `computer.command.started` → Codex writes `receipt/current/output/result.json` → `candidate.produced` / `candidate.reviewed` → `integration.queued → merging → validating` (checks in sandbox) → `integration.validated → ready_to_promote` → promotion gate → `integration.promoting → promoted` → optional `factory.integration.publish` (PR) → `objective.completed` → `factory.objective.audit`.

**D. Investigation objective**: `objective.created` (no slot) → supervisor plan → `task.dispatched` with receipt-only workspace → `task.evidence.observed` / `monitor.checkpoint` → `task.phase.transitioned` (`collecting_evidence → evidence_ready`) → `task.synthesis.dispatched` → `investigation.synthesized` → `investigation.reported` → `objective.completed` (no checks, no promotion).

---

## 13. Changes since 41baea75

`git log --oneline 41baea75..HEAD` lists 43 commits; 33 touch `packages/receipt-app`, `docs`, or `skills`. Behavioral changes relevant to Factory:

**Projection durability (commits `6b79dc82`, `61751714`, `00ef6f17`, `2010f1c7`, `8632713e`, `ac50493f`, `71ffa060`, `bd26d484`, `abe31bcc`, `888d1d9c`, `3c86b579`, `0a58ac52`, `8c74802b`, `d62e9136`; summarized in `docs/projection-durability-fix.md`):**

1. A migration-owned Postgres trigger (`receipt_projection_work_append`) now marks `(projector, stream, requested_seq)` pending work on every receipt insert, with a backfill and new identity indexes on `computerId`, `objectiveId`, `jobId`, `leaseId`, `traceId`; two new internal tables `receipt_projection_work` and `receipt_reducer_checkpoints`, excluded from Zero (`db/projection-work-schema.ts`, `db/schema.ts:944-956`, `runtime-contracts.ts:414-429`). Notifications are latency hints; persisted pending rows are delivery authority, so a crash before ack replays instead of losing work.
2. The `api` role runs a projection work pump that polls due-work predicates every second and gives each projector one bounded batch per round (`server/projection-work-pump.ts`, `bootstrap.ts:3780-3803`).
3. Projection transactions run on a dedicated single-connection pool per application pool, serialized before checkout, so a long catch-up cannot starve receipt acceptance (`db/projection-connection.ts`); all projector reads/writes share one scoped client (`db/connection-scope.ts`); branch metadata reads were moved onto that scoped connection (`2010f1c7`).
4. Objective/job reducer state is checkpointed per `(projector, stream, version)` and refreshed by verified delta pages (sequence, prev-hash, and hash checked; mismatch discards the checkpoint and replays) (`db/incremental-state.ts`); job replay coalesces consecutive `queue.command` receipts to avoid quadratic copies while preserving duplicate-command semantics (`db/job-reducer-page.ts`, `3c86b579`).
5. Receipt-append scheduling is event-aware: chat appends target one session; computer inventory/lease projections only run for their event types; objective progress mirroring skips `computer.command.stdout.observed`, `computer.command.stderr.observed`, `computer.heartbeat`, `computer.lease.renewed`, `factory.task.output.observed`, `job.heartbeat` (`server/receipt-append-projection-scheduling.ts:44-52`), and the app-chat mirror is coalesced to one pass per objective per `RECEIPT_OBJECTIVE_PROGRESS_MIRROR_INTERVAL_MS` with one trailing pass (`server/objective-progress-mirror-scheduler.ts`).
6. Objective summary and watchdog reads no longer load full objective state (`bd26d484`); already-published objective generations are skipped by concurrent writers (`71ffa060`); computer maintenance repairs are scoped to affected identities instead of rebuilding the fleet (`d62e9136`).
7. The objective-control outbox redrive keeps ownership past its deadline and logs `factory.control_outbox_redrive_slow` instead of stacking duplicate runs (`abe31bcc`, `server/single-flight-maintenance.ts`).
8. The Resonate client uses a custom SSE poll adapter that never times out while idle and reconnects with backoff (`8c74802b`, `adapters/resonate-poll-source.ts`); previously idle worker polls could disconnect.
9. A `projection-replay-storm` deterministic simulation was added and is required in the reliability gate (`61751714`).

**Tool reliability (`e6944514`, PR #179; `docs/tool-reliability-fixes-2026-09-05.md`):**

10. Available-integration inventory (`capabilityContext.source === "active-integrations"`) is no longer promoted to required execution dependencies at any ingress or runtime boundary (`services/factory/capability-selection.ts`); explicit and model-selected providers still are.
11. Permanent model authentication failures (401 / `invalid_api_key`) stop supervisor retries and produce the BYOK guidance message (`model-error-retry.ts`, `objective-supervisor-runner.ts:124-133, 429-431`).
12. Per-worker OpenSandbox host idle auto-stop was removed; hosts stop only by operator action (`opensandbox-host-lifecycle.ts`, `opensandbox-host-stop.ts` deleted).
13. An objective audit whose snapshot head is stale now completes with `status: "superseded"` rather than failing repeatedly (`factory-runtime.ts:1061-1069`).
14. Terminal render artifacts are previewed from existing refs; replay no longer publishes media from ephemeral workspaces (`terminal-render-artifacts.ts:40-46`).
15. Slack semantic routing re-reviews contextual targets against the latest request (`chat-layer-routing.ts`, `slack-thread-flow.ts`); supervisor prompt guidance emphasizes current eligible targets and blocker evidence.

**Other:**

16. `ab7b00b0` recovers a missing connection selection before chat dispatch (`agents/app/chat-context.ts`).
17. The objective supervisor failure detail for invalid keys and the "Workspace details / one tab strip" UI pass (`46652e84`) touched the app, not Factory semantics.
18. Agent Registry and cloud inventory commits (`26ec975a` … `c3c16be6`) add `services/agent-cloud-discovery.ts` / `agent-inventory.ts`; they do not change Factory execution.
19. Docs added: `docs/projection-durability-fix.md`, `docs/tool-reliability-fixes-2026-09-05.md`, `docs/agent-fix-checklist.md`, `docs/receipt-cli-debug-report.md`; `skills/receipt-connect-cli-prod-debug/SKILL.md` (internal prod-debug runbook).

Nothing in the diff changed objective/task/candidate/integration statuses, promotion-gate strings, phase lines, the Codex invocation, the packet layout, or the `receipt factory` command set (other than the new simulate suite).

---

## 14. Documentation implications

**What to claim (supported by code):**

* Factory runs objectives as hash-chained receipt streams; every projection, queue row, and UI view is rebuildable from replay, and the new pending-work outbox makes projection delivery crash-safe.
* Durable execution through Resonate with explicit lease/heartbeat/attempt fences, delivery generations, and three independent recovery loops (redrive, outbox, watchdog).
* All agent execution is sandboxed in a disposable OpenSandbox computer with bounded CPU/memory, timeouts, and lease-scoped capacity; there is no unsandboxed path.
* Connected-system CLIs (`aws`, `gcloud`/`bq`/`gsutil`, `kubectl`, Jira) work inside the sandbox through credential helpers that fetch material from the Receipt Connect gateway at call time under a job-scoped token; generic integrations are proxied server-side.
* Delivery work flows through task worktrees → integration worktree → checks → promotion gate → optional PR, never directly to the source branch.
* Investigation objectives produce structured findings with confidence levels and never mutate the repo.

**What to avoid claiming:**

* "No secrets ever enter the sandbox." The BYOK OpenAI key is written to `~/.codex/auth.json`, and a host `gh` login is projected. Say "provider credentials for connected systems are fetched at call time and are not placed in the environment."
* "Single repo slot." The default admits 20 concurrent delivery objectives; use "repo execution slots".
* "Auto-promotes by default." Investigation is the default mode and never auto-promotes.
* "Self-improving." It is an audit-and-recommend loop with operator apply.
* "Idle computers stop automatically." That path was removed.
* Any GPU, local-execution, or framework-adapter capability.
* `receipt factory doctor`, the `.receipt/factory/<taskId>.*` packet naming, the stale objective status list in `docs/factory-on-receipt.md`, or "validation runs locally" from `docs/factory-agent-orchestration.md`.

**Marketing claims.** No explicit claim list was supplied with this task; the claims implied by its scope are rated in the structured output: durable execution (supported), receipts as audit trail (supported), sandboxed execution (supported), real CLIs with connected-system credentials (supported), raw secrets not injected (partial), automatic PR publishing (supported for delivery objectives with a GitHub token), self-improvement (partial), background chat tasks (supported), single repo slot (partial), doctor command (unsupported).

**Suggested page split:**

1. *Factory concepts* — objective/task/candidate/job/check/evidence/promotion/profile/mode/severity with the status tables and phase lines (§1).
2. *How a background run executes* — the two text flows (§2.5, §6.1) and the delivery/investigation end-to-end sequences (§12).
3. *Durable execution and recovery* — roles, Resonate, fences, recovery loops, projection durability (§2, §13).
4. *The computer lane* — OpenSandbox configuration, capacity, workspace, packet, Codex invocation, credential helpers, readiness codes (§4).
5. *Results, integration, and PRs* — result contract, checks, worktrees, promotion gate, publisher (§5).
6. *Tasks page and chat* — exact UI strings and what each action enqueues (§6).
7. *Memory for Factory* (§7). 8. *Audits, eval, and simulation* for developers (§8). 9. *Observability* (§10). 10. *Limits* (§11).

---

## 15. Open questions

1. Is the `factory.dispatch` worker group meant to be `control` (per `RECEIPT_JOB_KIND_CONTRACTS`) or `chat` (per `resolveWorkerTarget`)? The two still disagree.
2. Is `receipt factory doctor` going to be wired to BYOK or removed from the public surface?
3. Should public docs describe `repoSlotConcurrency` (default 20) or keep the board's "the repo execution slot" wording?
4. Is projecting the controller host's `gh` token into every sandbox intended for hosted deployments, or only for local operator runs? It is the one credential that is not job-scoped.
5. The generated AWS profiles hard-code `region = us-east-1`; is region selection planned, and should docs tell users to pass `--region`?
6. With host auto-stop removed, what is the documented operator procedure for stopping idle OpenSandbox hosts?
7. Which of `/factory`, `/factory-new`, `/factory-preview` is the supported runtime shell, or is `/tasks` the only product surface to document?
8. Are model ids `gpt-5.6-luna` / `gpt-5.6-terra` public names safe to print in a configuration reference?
9. `docs/factory-on-receipt.md` and `docs/factory-agent-orchestration.md` are partly stale (status list, local validation); should they be corrected before the public docs cite them?
10. Is `FACTORY_OBJECTIVE_AUDIT_SYSTEM_IMPROVEMENT` intended to ship, and does the app UI ever surface self-improvement recommendations?
