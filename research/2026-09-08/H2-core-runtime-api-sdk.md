# H2 — Kentron Core, part 2: receipt data model, runtime and APIs, sync layer, SDK, and the learning loop

Repo: `~/Desktop/Development/kentron/Receipt`, HEAD `c3c16be6` on `main` (2026-09-08).
Prior corpus used as a map only: `doc/research/07-runtime-architecture-api.md` and `05-repo-cli-core.md`, written at `41baea75` (43 commits ago).
Every claim below was re-read against HEAD source; where a file has zero commits in `41baea75..HEAD` (verified with `git log --oneline 41baea75..HEAD -- <path>`) the map's line numbers were spot-checked and reused. Line numbers are HEAD line numbers unless marked "(map, file unchanged)".

## 0. TL;DR

* **The receipt primitive is small and intact.** `packages/receipt-core` has zero commits since the baseline. A receipt is `{ id, ts, stream, prev?, body, context?, hash, hints? }`; `context` is hashed, `hints` are not (`packages/receipt-core/src/types.ts:32-41`, `chain.ts:20-29`). Hash chaining, `verify()`, fork-on-read branches, per-stream locks, `eventId` dedup and `expectedPrev` CAS all live in ~570 lines of pure TypeScript.
* **The durable store is Postgres, and receipts are the only truth.** Every other table is a projection with an explicit `stateRole` and `zeroPublication` contract (`packages/receipt-app/src/services/runtime-contracts.ts:373-715`). HEAD adds two new internal tables, `receipt_projection_work` and `receipt_reducer_checkpoints`, plus a Postgres trigger that marks projection work on every receipt insert (`packages/receipt-app/src/db/projection-work-schema.ts`). The 15 "projection durability" commits since the baseline are one continuous fix for a production incident (RCA-404) in which live chat progress replay saturated a host; their combined behavioural effect is summarised in "Changes since 41baea75".
* **The runtime HTTP surface is unchanged in shape** (26 routes registered in `bootstrap.ts`, 23 `/connect/*` routes, the Factory shells, the receipt browser and the runtime dashboard) but the route line numbers shifted by −8. `/jobs/:id/wait` still answers with `Deprecation: true`. `docs/api/http.md` and `docs/api/sse.md` remain materially stale.
* **The SDK is unchanged** (`packages/receipt-app/src/sdk/*`, zero commits). The `receipt new` scaffold defect is **still present at HEAD**: the wrapper `cd`s to the repo root (`.receipt/bin/receipt:16`), `commandNew` writes `<root>/src/agents/<id>.agent.ts` importing `../sdk/index` (`packages/receipt-app/src/cli/commands.ts:127,184`), and there is no `src/sdk/` at the repo root (`ls src` → "No such file or directory"). The generated file cannot resolve its import in a monorepo checkout.
* **There is no training-data pipeline.** Searching `apps/`, `packages/`, `scripts/`, `workers/` for `fine-tune|finetune`, `retrain`, `training data|training set`, `dataset`, and `jsonl` finds zero fine-tuning or retraining code, zero dataset export, zero labeling UI. `jsonl` hits are readers of Claude Code transcripts and Codex/OpenSandbox event logs, never writers of training sets. The `/sessions` page computes a "Lesson candidate" from turn counts, and its "Draft lesson" button has no handler (`apps/start/src/components/sessions/sessions-page.tsx:880-889`). Three of the four Kentron Core marketing claims given for this report are **unsupported**; one is **partial** (see "Documentation implications").
* **Memory search is keyword-only at HEAD.** All three `createMemoryTools({...})` call sites omit the optional `embed` dependency (`server/bootstrap.ts:297-300`, `cli/runtime.ts:56-59`, `services/factory-runtime.ts:1133-1136`), so `strategy` is always `"keyword"` or `"recent"` (`adapters/memory-tools.ts:586-616`), and `summarize` is a character-capped join of entry text, not a model summary (`memory-tools.ts:320-330, 604-611`). `docs/memory.md:173-175` claims semantic search when `OPENAI_API_KEY` is set; the code does not do that.

---

## 1. Receipt data model (`packages/receipt-core`)

`git log --oneline 41baea75..HEAD -- packages/receipt-core` returns nothing; every line number in this section is verified at HEAD and identical to the map.

### 1.1 The receipt shape; `context` vs `hints`

```ts
// packages/receipt-core/src/types.ts:32-41
export type Receipt<Body = unknown> = {
  readonly id: string;
  readonly ts: number;
  readonly stream: string;
  readonly prev?: string;
  readonly body: Body;
  readonly context?: ReceiptExecutionContext;
  readonly hash: string;
  readonly hints?: Record<string, unknown>;  // optional metadata (non-authoritative)
};
```

`ReceiptExecutionContext` (`types.ts:19-29`) is the authoritative scope: `actor?`, `tenantId?`, `organizationId?`, `objectiveId?`, `taskId?`, `jobId?`, `runId?`, `branch?`, plus open keys. `ReceiptActorContext` (`types.ts:9-14`) is `{ id, kind?: "user"|"agent"|"system"|"service"|string, name?, ... }`. The comment at `types.ts:16-18` states the rule the code enforces: context "is hashed with the receipt body and replayed with the chain, unlike hints which are transport metadata for indexes, tracing, or idempotency."

A `Chain` is `readonly Receipt<Body>[]` (`types.ts:44`). A `Branch` is `{ name, parent?, forkAt?, createdAt }` (`types.ts:47-52`). `Reducer<S,B> = (state, body, ts) => S` and `Decide<Cmd,Event> = (cmd) => Event[]` (`types.ts:55-58`). The `Store<B>` interface is `append(r, expectedPrev?)`, `read`, `take`, `count`, `head`, optional `version(stream)` and optional `listStreams(prefix?)` (`types.ts:61-69`); `BranchStore` is `save/get/list/children` (`types.ts:72-77`).

### 1.2 Canonical JSON and the hash

```ts
// packages/receipt-core/src/chain.ts:21-29
export const computeHash = <B>(r: Omit<Receipt<B>, "hash">): string =>
  sha256(canonicalize({
    id: r.id, ts: r.ts, stream: r.stream, prev: r.prev ?? null, body: r.body,
    ...(r.context === undefined ? {} : { context: r.context }),
  }));
```

`canonicalize` is `canonicalJson(x, { errorPrefix: "receipt canonicalization" })` (`chain.ts:17-18`). `canonicalJson` (`canonical-json.ts:17-79`) sorts plain-object keys with `localeCompare` (`:71`), honours `toJSON()` (`:52-58`), and throws on `undefined` (unless `undefinedMode: "sentinel"`, which substitutes the string `__undefined__`, `:7,35-37`), `bigint`/`function`/`symbol` (`:38-41`), non-finite numbers (`"... requires finite numbers"`, `:31-33`), circular structures (`:49-51`), and non-plain objects (`"... cannot serialize unsupported object <Ctor>"`, `:65-67`). Note the hash covers `prev` as `null` when absent, so a root receipt and a receipt with a missing `prev` hash identically to their own canonical form.

### 1.3 Ids and replayable entropy

`makeId(ts)` is `` `${ts.toString(36)}-${randomBytes(8).toString("hex")}` `` (`chain.ts:45`). The byte source is overridable through `globalThis[Symbol.for("receipt.core.randomBytesSource")]` (`chain.ts:35-43`); `@receipt/dst` uses this to make ids deterministic under simulation. `receipt(stream, prev, body, ts = Date.now(), hints?, context?)` (`chain.ts:47-69`) builds the base, computes the hash, then attaches `hints` outside the hashed base.

### 1.4 `verify()` and `fold()`

`verify(chain)` (`chain.ts:91-103`) walks the chain, requiring `r.prev === previousHash` (reason `"broken prev"`) and `r.hash === computeHash(r)` (reason `"hash mismatch"`), returning `{ ok: true, count, head? }` or `{ ok: false, at, reason }`. `fold(chain, reducer, initial)` (`chain.ts:75-81`) is the plain left fold over `(state, r.body, r.ts)`.

### 1.5 The runtime: streams, locks, snapshots, replay, dedup, CAS

`createRuntime(store, branchStore, decide, reducer, initial)` (`runtime.ts:88-471`) returns `Runtime` (`runtime.ts:29-66`): `execute`, `state`, `stateAt`, `chain`, optional `head`, `chainAt`, `verify`, `fork`, `branch`, `branches`, `children`, `listStreams`. `createScopedRuntime(runtime, context)` (`runtime.ts:72-82`) binds a default execution context to every `execute`.

Behaviour that matters for docs:

* **Per-stream in-process serialisation.** `enqueueStream` chains a promise per stream name (`runtime.ts:133-151`); `withStreamLocks` takes locks in sorted order so `fork` (which locks parent and child) cannot deadlock (`:153-164`, `:423-424`).
* **Snapshot cache with incremental fold.** `loadSnapshot` (`:241-294`) caches `{ chain, localChain, state, version, branchKey }`. It returns the cache when the branch key matches and `store.version(stream)` is unchanged (`:251-256`); otherwise it re-reads, re-materialises, and only folds the suffix if the cached tail hash still matches the new chain at the same index (`:266-279`). The Postgres store's `version` is `` `${stream_seq}:${head_hash}` `` of the tail row (`packages/receipt-app/src/adapters/postgres.ts:636-653`).
* **Replay refuses corrupt chains.** `assertVerifiedChain` throws `` `Receipt runtime refused to replay invalid chain for stream '${stream}': ${reason} at index ${at}` `` (`:124-131`) whenever `validateChain !== false`; `runtime.verify` reads with `validateChain: false` so it can report rather than throw (`:464`).
* **Idempotent commands.** If a command object carries a string `eventId`, the runtime computes hint ids `eventId` (single event) or `` `${eventId}#${i}` `` (multi-event) (`:332-338`), skips the whole command when every hint already exists in the chain (`:349-353, 368-370`), and — on an append error — force-reloads and re-checks so a concurrent writer's identical command still returns `[]` rather than throwing (`:394-404`). Blank `eventId`/`expectedPrev` strings throw `"Receipt runtime command eventId cannot be blank"` / `"... expectedPrev cannot be blank"` (`:320-325`). `decide` runs *before* the idempotency check on purpose so a partial multi-event write is distinguishable from a complete one (comment `:362-364`).
* **Optimistic concurrency.** `expectedPrev` must equal the materialised head hash or the runtime throws `` `Expected prev hash ${expectedPrev} but head is ${head?.hash ?? "undefined"}` `` (`:372-375`). The store is additionally asked to append with `localPrev` (the physical local-chain tail), which the Postgres adapter re-checks under a transaction lock (§1.7).
* **Receipt timestamps are `Date.now()` at execute time** (`:389`); the reducer sees the same `ts` (`:393`).

### 1.6 Branches: fork metadata, rebase-on-read

`fork(stream, at, newName)` (`runtime.ts:423-455`) validates `at` is a non-negative integer (`"fork point must be a non-negative integer"`, `:114-119, 425`), refuses `at > parentChain.length` (`` `Cannot fork ${stream} at ${forkAt}; valid range is 0..${len}` ``), an existing branch name (`` `Branch '${newName}' already exists` ``), and a target stream that already has receipts (`` `Stream '${newName}' already has receipts` ``) (`:427-437`). It saves `{ name, parent, forkAt, createdAt }` and, if the parent had no branch record, a root record for it (`:439-450`). **No receipts are copied.**

Reads materialise: `materializeChain` (`:207-239`) loads the parent snapshot, takes `parent.chain.slice(0, forkAt)`, trims the branch's local chain if it already physically contains that prefix (`parentPrefixMatches`, `:191-205`, compares `ts`, canonical body and canonical context), then `relinkLocalChain` re-links and **re-hashes** each local receipt on top of the parent prefix (`:166-189`). Cycles throw `` `Branch cycle detected for stream '${stream}'` `` (`:213-215`); a fork point beyond the parent throws `` `Branch '${stream}' fork point ${forkAt} exceeds parent '${parent}' length ${n}` `` (`:224-228`). Consequence for documentation: the hash of a branch receipt as *read* differs from the hash as *stored* whenever the branch has a parent, so branch receipts must not be cited by hash across the fork boundary.

Branch metadata is persisted two ways by the Postgres adapter: as receipts on the reserved stream `__meta/branches` with event type `branch.meta.upsert` (`adapters/postgres.ts:18-19`), and mirrored into `receipt_branches` inside the same append transaction (`:592-607`).

### 1.7 The Postgres store: append transaction, dedup, version

`postgresReceiptStore` (`adapters/postgres.ts:470-664`) implements `Store<B>` against four tables. `append` (`:498-587`) runs one transaction that:

1. takes `pg_advisory_xact_lock(hashtextextended($stream, 0))` (`:506`),
2. `SELECT ... FROM receipt_streams WHERE name = $1 FOR UPDATE` (`:507-510`),
3. reads the physical tail `(stream_seq, hash)` from `receipt_receipts` and compares it to `expectedPrev ?? r.prev`, throwing `` `Expected prev hash ${physicalPrev ?? "undefined"} but head is ${headHash ?? "undefined"}` `` on mismatch (`:511-528`),
4. derives `nextStreamSeq` from the **receipt table tail, not `receipt_streams`**, with an in-code rationale that `receipt_streams` "is an append accelerator, not the chain authority" and a stale head/count "can permanently wedge a stream" (`:529-538`),
5. inserts the receipt row returning `global_seq` (`:539-556`), upserts `receipt_streams` (`:559-570`), upserts `receipt_branches` for `branch.meta.upsert` events (`:571-590`), and inserts a `receipt_change_log` row (`:591-598`),
6. after commit, calls `dispatchReceiptAppendCallback` with `{ globalSeq, stream, eventType, changedAt }` (`:600-606`) — this is the in-process hook that schedules projections (§2.9).

Dedup is enforced by the table's unique indexes: `(stream, stream_seq)`, `(stream, hash)`, `(stream, receipt_id)`, and a global unique on `hash` (`db/schema.ts:44-47`). `version(stream)` returns `` `${stream_seq}:${hash}` `` of the tail (`:636-653`); `listStreams(prefix)` is `name LIKE '<prefix>%'` (`:655-663`).

### 1.8 Tables at HEAD and the table contract

`packages/receipt-app/src/db/schema.ts` declares **39 `pgTable`s** (line numbers: `receipt_streams` 23, `receipt_receipts` 33, `receipt_branches` 54, `receipt_projection_offsets` 63, `receipt_change_log` 69, `receipt_entity_projection` 82, `receipt_org_skill_projection` 119, `receipt_org_skill_bundle_projection` 143, `receipt_org_guardrail_group_projection` 162, `receipt_org_policy_rule_projection` 191, `receipt_job_projection` 211, `receipt_job_pending_commands` 270, `receipt_objective_projection` 284, `receipt_task_projection` 320, `receipt_factory_action_projection` 357, `receipt_factory_wait_projection` 394, `receipt_factory_handoff_projection` 431, `receipt_chat_context_projection` 466, `receipt_chat_history_projection` 522, `receipt_session_messages` 551, `receipt_session_recap_projection` 612, `receipt_memory_entries` 629, `receipt_memory_accesses` 643, `receipt_memory_embeddings` 665, `receipt_durable_workflow` 677, `receipt_durable_signal` 695, `receipt_durable_activity` 709, `receipt_durable_activity_attempt` 732, `receipt_eval_run_projection` 746, `receipt_computer_use_session_projection` 774, `receipt_computer_session_projection` 801, `receipt_computer_inventory_projection` 824, `receipt_computer_lease_projection` 850, `receipt_computer_run_projection` 884, `receipt_computer_live_output_projection` 920, **`receipt_projection_work` 945, `receipt_reducer_checkpoints` 950** — the last two are new since the baseline and carry the comment "Internal, rebuildable state; never published to Zero clients." (`schema.ts:944`).

The rule that projections are rebuildable is no longer just a doc convention; it is a typed contract. `RECEIPT_RUNTIME_TABLE_CONTRACTS` (`services/runtime-contracts.ts:373-715`) gives every table a `stateRole` of `canonical` (`receipt_receipts`), `canonical-index` (`receipt_streams`, `receipt_branches`), `operational` (`receipt_projection_offsets`, `receipt_change_log`, `receipt_memory_accesses`), `durable-execution` (the four `receipt_durable_*` tables), or `derived-read-model` (everything else), and a `zeroPublication` of `default`, `internal`, or `never`. Derived lists are exported: `ZERO_DEFAULT_RECEIPT_PUBLICATION_TABLES`, `ZERO_INTERNAL_RECEIPT_TABLES`, `RECEIPT_CANONICAL_TABLES` (`runtime-contracts.ts` immediately after the contract map). The tables published to Zero by default are `receipt_org_skill_projection`, `receipt_org_guardrail_group_projection`, `receipt_job_projection`, `receipt_objective_projection`, `receipt_task_projection`, `receipt_factory_handoff_projection`, `receipt_chat_context_projection`, `receipt_chat_history_projection`, `receipt_session_messages`, `receipt_memory_entries`, `receipt_memory_accesses`, `receipt_computer_inventory_projection`, `receipt_computer_lease_projection`, `receipt_computer_run_projection`, `receipt_computer_live_output_projection`; `receipt_session_recap_projection` is `never`; the raw receipt log, branches, change log, offsets, work/checkpoint tables, entity projection, skill bundles, policy rules, job pending commands, factory action/wait, memory embeddings, durable tables, eval and computer-use/session projections are `internal`.

**Doc discrepancy carried forward:** `docs/memory.md:44,56` still names the tables `memory_entries` / `memory_embeddings`; the real names carry the `receipt_` prefix (`schema.ts:629,643,665`).

### 1.9 Durable projection work and reducer checkpoints (new at HEAD)

`packages/receipt-app/src/db/projection-work-schema.ts` (75 lines) and its checked-in twin `packages/receipt-app/src/db/migrations/20260905_durable_projection_work.sql` create:

* indexes `receipt_streams_prefix_idx (name text_pattern_ops)`, `receipt_receipts_stream_global_idx (stream, global_seq)`, and expression indexes on `body_json->>'computerId'|'objectiveId'|'jobId'|'leaseId'|'traceId'` paired with `global_seq`;
* `receipt_projection_work (projector, stream, requested_seq, processed_seq DEFAULT 0, eligible_at DEFAULT 0, PK (projector, stream))` with a partial index `WHERE requested_seq > processed_seq`;
* `receipt_reducer_checkpoints (projector, stream, version, stream_seq, receipt_hash, state_json, PK (projector, stream))`;
* an immutable SQL function `receipt_projection_targets(source_stream, source_event)` that maps a stream/event to the projector names `job_projection`, `objective_projection`, `chat_context_projection`, `computer_inventory_projection`, `computer_lease_run_projection`, `eval_run_projection`, `computer_use_session_projection`;
* an `AFTER INSERT` trigger `receipt_projection_work_append` on `receipt_receipts` that upserts pending work with `requested_seq = GREATEST(existing, NEW.global_seq)`;
* a one-time backfill of pending work from existing receipts.

The comment in `projection-work-schema.ts:1-4` fixes the semantics: "Sequence values are compared only within a stream; consumption never assumes that different transactions commit in global sequence order. These tables are internal and must not enter Zero." `incrementalReceiptState` (`db/incremental-state.ts`) uses the checkpoint only when `version` matches and the anchor receipt at `stream_seq` still has the checkpointed hash; a mismatch resets to the initial state and re-folds (`incremental-state.ts:14-30`), and any stream with a `parent` branch row falls back to the verified full-replay path (`:14`). Legacy `receipt_projection_offsets` is still written (11 `setProjectionOffset` call sites in `db/projectors.ts`) but is documented as "diagnostic/compatibility values, not delivery authority" (`docs/projection-durability-fix.md:14-16`).

### 1.10 Tenancy: `DATA_DIR` is a Postgres schema key; pool and `search_path`

* `resolveReceiptPostgresSchemaForDataDir(dataDir)` (`db/client.ts:218-232`) returns `undefined` when `RECEIPT_POSTGRES_SCHEMA` is set, else `` `receipt_data_${sha256(path.resolve(dataDir)).slice(0,24)}` ``; the comment calls a data dir "a durable tenant boundary".
* `resolveReceiptPostgresSchema(explicit?)` defaults to `"public"` and asserts a safe identifier (`:78-83`); `resolveReceiptPostgresPoolOptions` always emits `-c search_path="<schema>"`, "so a role-level default cannot silently route unqualified Receipt queries to a legacy schema" (`:85-96`).
* `createReceiptPostgresPool(connectionString, schema)` (`:258-293`) memoises pools per `{connectionString, schema, max, applicationName}`; `max` is `RECEIPT_POSTGRES_POOL_MAX` or **2** (`:234-237`); `application_name` is `RECEIPT_POSTGRES_APPLICATION_NAME` or `"receipt-app"`; `connectionTimeoutMillis: 5_000`; `idle_in_transaction_session_timeout: 30_000`; `options` sets `search_path` for non-`public` schemas (`:288`). `getReceiptDb` also issues `SET search_path` / `SET LOCAL search_path` per checked-out client (`:379, 447`).
* Connection string: `resolveReceiptPostgresUrl` → `resolveReceiptDatabaseUrl` reads only `ZERO_UPSTREAM_DB` (`db/client.ts:74-76`; `config/runtime-env.ts` unchanged since the map).
* New at HEAD: `withProjectionConnectionPool` (`db/projection-connection.ts`) reserves a **separate single-connection pool** (`max: 1`, `application_name` suffixed `-projection`) for application-owned pools and serialises projection admission before checkout so a long catch-up transaction cannot starve request reads (`projection-connection.ts:3-8, 12-15, 18-23`). `connection-scope.ts` uses `AsyncLocalStorage` so every query inside a projector transaction reuses the one checked-out client (`connection-scope.ts:1-6`).
* Per-organisation tenant directories: `receiptTenantStorageKey(orgId)` hashes `` `receipt-org:${orgId}` `` (`server/tenant-context.ts:63-70`); `RECEIPT_TENANT_ROOT` overrides `<repoRoot>/.receipt/tenants` (`:42,75-80`); the tenant layout is `receipt/` (the `DATA_DIR`), `repos/`, `worktrees/`, `artifacts/` (`:120-122`). The web app derives the same directory through `apps/start/src/lib/backend/receipt/tenant-runtime.ts` and the `/sessions` server reads through `resolveReceiptTenantDataDir` → schema → pool (`apps/start/src/lib/frontend/sessions/agent-sessions.server.ts:503-521`).

### 1.11 Stream families at HEAD

`services/runtime-contracts.ts:18-104` (verified at HEAD):

| Family | Pattern | Source |
|---|---|---|
| Job index | `jobs` | `JOB_STREAM_PREFIX`, `:18` |
| Job lifecycle | `jobs/<jobId>` (no further `/`) | `receiptJobStream`/`parseReceiptJobStream`, `:25-31` |
| Factory objective | `factory/objectives/<objectiveId>` | `:19,33-45` |
| Objective step ref | `factory/objectives/<objectiveId>/steps/<taskId>` | `factoryObjectiveStepRef`, `:66-70` |
| Memory | `memory/<safe-scope>` where safe-scope is `(scope||"default").toLowerCase().replace(/[^a-z0-9_.-/]/g,"_")` | `:72-77` |
| Factory memory scopes | `factory/objectives/<id>`, `.../tasks/<taskId>`, `.../candidates/<candidateId>`, `.../integration`, `.../publish` | `:47-64` |
| Eval run | `eval/runs/<runId>` (URI-encoded by `services/eval/receipts.ts:24-25`) | `:21,89-96` |
| Computer-use session | `computer_use/sessions/<encoded sessionId>` | `:22,98-108` |
| Computer resource | `factory/resources/computer/opensandbox/...` | `server/receipt-append-projection-scheduling.ts:37-38` |
| App chat session | `apps/start/<repoKey>/app-chat/sessions/<encoded threadId>` and `.../runs/<encoded runId>` | `apps/start/src/lib/backend/receipt/chat-bridge.ts:102-106` |
| Factory chat profile/session/objective | `agents/factory/<repoKey>/receipt[/sessions/<chatId>|/objectives/<objectiveId>]` | map §2.5 (`services/factory-chat-profiles.ts`, unchanged) |
| Claude Code imports | `imports/clauden/...`, `imports/claude-code/...` | `agent-sessions.server.ts:35-38`; `apps/start/src/routes/api/receipt-ingest/receipts/route.tsx` (map §10.4, unchanged) |
| Branch metadata | `__meta/branches` | `adapters/postgres.ts:18` |

`parseReceiptMemoryStream` URI-decodes while `receiptMemoryStream` never encodes (`:79-87`), the mild asymmetry the map noted; treat the safe-scope form as canonical.

---

## 2. The runtime and its HTTP API (`packages/receipt-app/src/server.ts` → `server/bootstrap.ts`, 3,844 lines at HEAD)

### 2.1 Process image and roles (unchanged)

`adapters/resonate-config.ts` and `server/config.ts` have zero commits since the baseline, so the map's role table stands: one image, `RECEIPT_PROCESS_ROLE` ∈ `api | driver | worker-chat | worker-control | worker-codex` (anything else → `all`), only `api` binds `PORT` (default 8787) and runs heartbeats; workers register Resonate functions `receipt.job.driver` / `receipt.job.execute` / `receipt.agent.action.execute`; concurrency defaults 4/1/1 for chat/control/codex (map §1.1). New at HEAD: `adapters/resonate-poll-source.ts` replaces the default Resonate poll transport with an `EventSource` whose `fetch` passes `timeout: false` so an idle worker's long-poll is not killed by Bun's socket idle deadline (`resonate-poll-source.ts:1-4, 23-27`); reconnects back off per attempt and an explicit stop owns both the stream and the retry timer.

### 2.2 Response conventions (verified at HEAD)

* JSON: `Content-Type: application/json; charset=utf-8`, `Cache-Control: no-store` (`bootstrap.ts:2138-2139`).
* Text errors from `text(status, msg)` are `text/plain` (map, `framework/http.ts:21`).
* Malformed body → `400 "Malformed JSON body"`; non-object body → `400 "Request body must be a JSON object"` (`:2156-2159`); any other unhandled error → `500 "Server error"` (`:2110`), logged as `http.unhandled_error`.
* Unmatched route → `404 "Not found"` (`app.notFound`, `:3711`).
* Bun `idleTimeout: SERVER_IDLE_TIMEOUT_SECONDS` (`:3741`).
* There is **no request-id middleware** in the runtime: `grep -rn "x-request-id|requestId" packages/receipt-app/src/server packages/receipt-app/src/framework` returns nothing. Request ids exist only in the web app (§9).

### 2.3 Core routes registered directly in `bootstrap.ts`

| Method | Path | HEAD line | Body / query | Status codes and exact strings |
|---|---|---|---|---|
| POST | `/agents/:id/jobs` | 2521 | `{ jobId?, lane?: "chat"\|"steer"\|"follow_up"\|"collect" (default `collect`), maxAttempts? (clamped 1..8, default 2), sessionKey? or singleton.key, singletonMode? or singleton.mode ∈ allow\|cancel\|steer (default allow), payload }` — `payload` falls back to the whole body (`:2524`) | `202 { ok:true, job, async:{ jobId, stream:"jobs/<id>", events:{ job:"/jobs/<id>/events", receipt:"/receipt/stream" }, status } }` (`:2571-2584`). Publishes topic `jobs`. **Never checks that a handler exists for `:id`** — an unknown agent id still gets 202. |
| POST | `/chat/route` | 2587 | actor from `actorContext ?? authContext ?? body`; `latestUserText`, `channel` (`slack`\|`teams`, else `web`), `priorProviders[]`, `boundObjectiveId?`, `recentContext?`, receipt-connect capabilities | `200 { ok:true, decision }`; `400 { ok:false, error:"actor_context_required", detail }`; `409 { ok:false, error:"openai_byok_unavailable", detail:"The organization must configure OpenAI BYOK before semantic chat routing can run." }` (`:2603-2609`). Comment: "served on the private Runtime network … returns only a validated route; no objective or provider call is performed here." |
| POST | `/chat/respond` | 2643 | same actor rule; `latestUserText` required | `200 { ok:true, response:{ text, profileId } }`; `400 actor_context_required`; `400 { ok:false, error:"latest_user_text_required" }`; `409 openai_byok_unavailable` with detail "…before Beetle can write a direct chat response."; `502 { ok:false, error:"profile_response_unavailable" }` with the in-code rule "Do not replace a failed model response with router text or plausible synthetic content." (`:2700-2703`). |
| GET | `/healthz` | 2710 | — | always `200 { ok:true, ready, degraded:false, uptimeSec, dataDir, processRole, queue, postgres, codexBin, resonateUrl }` (`:2712-2725`). Comment: "Health is a liveness surface, not a replay boundary." |
| GET | `/readyz` | 2728 | — | `200`/`503` by Postgres `SELECT 1`; body `{ ok, ready, degraded:false, uptimeSec, processRole, postgres }` (`:2729-2738`). |
| GET | `/receipt-debug/snapshot` | 2954 | token-gated | see §2.7 |
| GET | `/receipt-debug/jobs/:id` | 3013 | token-gated | |
| GET | `/receipt-debug/receipts` | 3043 | token-gated | |
| GET | `/receipt-debug/jobs/:id/artifacts` | 3103 | token-gated | |
| POST | `/receipt-debug/jobs/:id/abort` | 3157 | token-gated, scope `debug:objective` | |
| POST | `/receipt-debug/probes/objective` | 3190 | token-gated, scope `debug:objective` | |
| GET | `/receipt-debug/objectives/:id` | 3389 | token-gated | |
| POST | `/receipt/callback` | 3461 | optional `Authorization: Bearer $RECEIPT_CALLBACK_TOKEN` → `401 "unauthorized"`; `stream` required → `400 "stream required"`; event type from `eventType`, or `type:"job"`+`reason` → `job.<reason>` (`receipt-append-projection-scheduling.ts:16-29`) else `400 "eventType required"` | `202 { ok:true }`. Only calls `publishReceiptAppendChange` — **an invalidation callback, not an append API**. |
| POST | `/jobs/:id/steer` | 3476 | `{ payload?, by? }` (payload defaults to whole body) | `202 { ok:true, command }`; `409 "job is <status>; continue through its objective"`; `404 "job not found"` |
| POST | `/jobs/:id/follow-up` | 3495 | same | same |
| POST | `/jobs/:id/abort` | 3514 | `{ reason? (default "abort requested"), by? }` | `202 { ok:true, command }`; `404 "job not found"` |
| GET | `/jobs/:id` | 3531 | — | `200 QueueJob`; `404 "job not found"`; `503 "job temporarily unavailable"`; background lease repair failures are logged with `[receipt-runtime] background lease reconciliation failed for <id>` |
| GET | `/jobs/:id/wait` | 3548 | `timeoutMs` clamped 0..120000 (default 15000), 200 ms poll | `200 job` with **`Deprecation: true`** and `` Link: </jobs/<id>/events>; rel="successor-version" `` (`:3556-3563`); `404 "job not found"` |
| GET | `/jobs/:id/events` | 3566 | — | SSE on topic `jobs`, stream `<id>` |
| GET | `/jobs` | 3570 | `status` ∈ queued\|leased\|running\|completed\|failed\|canceled, `limit` 1..500 (default 50) | `200 { jobs }` |
| POST | `/memory/:scope/read` | 3593 | `{ limit?, actorContext\|authContext\|userId+organizationId }` | `200 { entries }` |
| POST | `/memory/:scope/search` | 3607 | `{ query, limit?, ...actor }` | `200 { entries }` |
| POST | `/memory/:scope/summarize` | 3623 | `{ query?, limit?, maxChars?, ...actor }` | `200 { summary, entries }` |
| POST | `/memory/:scope/commit` | 3642 | `{ text, tags?, meta?, ...actor }` | `201 { entry }`; `400 "text required"`; publishes topic `receipt` |
| POST | `/memory/:scope/diff` | 3664 | `{ fromTs, toTs?, ...actor }` | `200 { entries }`; `400 "fromTs required"` |
| GET | `/assets/:file` | 3690 | — | `400 "invalid asset path"` on `..`/`/`; `404 "asset not found"`; `Cache-Control: no-cache` for `.css`/`.js`, else `public, max-age=3600` |

All five memory routes call `actorAuditFromBody` (`:2164-2170`), which throws through `requireReceiptActorContext(body.actorContext ?? body.authContext ?? body, "<route> actor context")` and therefore surfaces as **`500 "Server error"`**, not 400, when `userId`/`organizationId` are missing. `docs/api/http.md` does not document the memory routes at all at HEAD (grep for "memory" finds nothing), which is at least not wrong.

### 2.4 Receipt Connect routes (`server/receipt-connect-routes.ts`, 23 routes)

Registered at `bootstrap.ts:2706-2708`. HEAD lines: `POST /connect/mcp` 859; `GET|POST /connect/workspaces` 931/943; `DELETE /connect/workspaces/:id` 981; `POST /connect/workspaces/:id/token` 999; `GET /connect/workspaces/:id/members` 1023; `PUT|DELETE /connect/workspaces/:id/members/:userId` 1038/1055; `GET /connect/agent/connections` 1069; `POST /connect/tools` 1112; `POST /connect/call` 1155; `GET /connect/capabilities` 1272; `GET /connect/connectors` 1310; `GET /connect/connections` 1434; `DELETE /connect/connections/:id` 1466; `GET /connect/connections/:id/actions` 1514; `GET /connect/connections/:id/repositories` 1614; `GET /connect/nango/health` 1716; `POST /connect/nango/sessions` 1750; `POST /connect/nango/webhook` 1925; `POST /connect/credential/:provider` 2024; `POST /connect/credential/github/import` 2200; `POST /connect/credential/aws/import` 2277. Auth is a Receipt Connect JWT with scopes `connect:read | connect:write | connect:credential` (`services/receipt-connect-auth-token.ts:19-33`, default TTL 12 h at `:25`); `/connect/mcp` requires `connect:credential` plus current workspace membership (`receipt-connect-routes.ts:860-866`); the Nango webhook verifies `x-nango-hmac-sha256` against `RECEIPT_INTEGRATIONS_WEBHOOK_SECRET` (`:135-144, 1937`).

New since the baseline (commit `0a58ac52`): tool-execution routes no longer answer a bare `401 { error:"unauthorized" }`. `receiptConnectExecutionAuthorizationFailure` distinguishes a valid discovery token lacking execution scope — `403 { ok:false, error:"Receipt could not authorize this task to use the connection. This is a task permission problem; reconnecting the account will not fix it.", code:"receipt_connect_execution_scope_missing", retryable:false, reconnectRequired:false }` — from a missing/invalid token — `401 { ok:false, error:"Receipt could not authenticate this task. Its runtime access token must be renewed before retrying.", code:"receipt_connect_runtime_authentication_required", retryable:false, reconnectRequired:false }` (diff of `receipt-connect-routes.ts` in `0a58ac52`).

### 2.5 Factory, receipt-browser, and runtime-dashboard routes (agent route module)

`loadAgentRoutes` scans `packages/receipt-app/src/agents/*.agent.ts`; there is still exactly one file, `factory.agent.ts`, advertising `paths: { shell: "/factory", state: "/factory/api/objectives", events: "/factory/live" }` (`agents/factory/route/handlers.ts:2129-2132`). `agents/factory/route/*` has zero commits since the baseline, so the map's route list holds; HEAD lines:

* `register-factory-api-routes.ts` (mounted for `/factory`, `/factory-new`, `/factory-preview`): `POST <base>/compose` 153; `POST <base>/api/objectives/:id/self-improvement/apply` 520; `POST <base>/api/system-improvement/apply` 584; `GET <base>/live` (WebSocket upgrade) 636; `GET <base>/api/live-output` 658; `GET <base>/api/user-preferences` 672; `GET <base>/api/session-history` 700; `GET <base>/api/objectives` 751; `GET <base>/api/objectives/:id` 759; `.../live-status` 764; `.../debug` 811; `.../receipts` 816.
* `register-factory-ui-routes.ts`: middleware `app.use("<base>/island/*")` 211 (non-HTMX requests are redirected to the shell), `GET <base>/control` 217 (303), `GET <base>/workbench` 228, islands 250-350, `GET <base>/api/workbench-shell` 365, `GET <base>` 389, `GET <base>/new-chat` 416.
* `register-receipt-routes.ts`: `GET /receipt` 145, `/receipt/island/folds` 168, `/records` 184, `/view` 200, `/side` 209, **`GET /receipt/stream` 236** (SSE, global `receipt` topic).
* `register-runtime-routes.ts`: **`GET /runtime`** (HTML dashboard) 23, `GET /runtime/island` 30, `GET /runtime/computers/summary` 35 (JSON `{ generatedAt, computers }`).

The two "apply" routes are the only places the self-improvement loop creates work, and both are operator-initiated (§8.2). Their exact error strings: `503 "Objective audit artifacts are not configured."`, `400 "Provide a valid recommendation index."`, `409 "A fresh self-improvement recommendation snapshot is not available."`, `404 "That self-improvement recommendation no longer exists."`, `500 "Failed to create or locate the auto-fix objective."` (`register-factory-api-routes.ts:523-557`); and for the repo-wide route `503 "System improvement artifacts are not configured."`, `409 "A fresh repo-wide system improvement snapshot is not available."`, `500 "Failed to create or locate the repo-wide auto-fix objective."` (`:587-610`). Trigger labels written into the created objective: `"Operator-applied self-improvement recommendation."` and `"Operator-applied repo-wide system improvement recommendation."` (`:552, 604`).

Gateway note (from `packages/receipt-core/src/service-graph.ts`, unchanged): the gateway strips the `/runtime` prefix, so the dashboard is reachable at `<gateway>/runtime/runtime`, and `/connect/*` is forwarded unstripped.

### 2.6 Deprecations and stale documentation

* `GET /jobs/:id/wait` is the only route emitting `Deprecation: true` (`:3560`); successor is `GET /jobs/:id/events`.
* `docs/api/http.md:18` still documents `/healthz` fields `jobBackend, checks, workers, stalledObjectives, oldestQueuedMsByLane, lastResumeAt, lastResumeError, watchdog` that the handler does not produce (`:2712-2725` produces `postgres` instead). `docs/api/http.md:157` still lists `GET /factory/events`, which does not exist. `docs/api/sse.md:14,24,33,38,41` still documents `agent-token` and `/factory/events`; neither exists (the only two `publishData` calls at HEAD are `bootstrap.ts:1360` and `:1368`, publishing `factory-stream-reset` and `agent-phase`). `docs/api/streams.md:46-58` lists three lanes; the route accepts four including `chat` (`:2525-2531`).
* `docs/receipt-runtime-readme.md:163,220-227` still documents `JOB_BACKEND=local`; the map's finding that `JOB_BACKEND` is never read in `packages/` or `apps/` was rechecked by grep and still holds.

### 2.7 Internal diagnostics endpoints

The `/receipt-debug/*` family exists and is gated by `authorizeReceiptDebugRequest(req, requiredScope = "debug:read")` (`bootstrap.ts:2224-2260`). With neither `RECEIPT_DEBUG_TOKEN` nor a debug JWT secret configured the endpoints answer `503 { ok:false, error:"receipt_debug_disabled", ... }` (`:2233`); otherwise a bearer token is required and the mutating routes need scope `debug:objective`. These are operator diagnostics, not a product API; the public docs should mention only that they exist and are token-gated.

### 2.8 Job queue vocabulary (unchanged)

`modules/job.ts` and `adapters/receipt-queue.ts` have zero commits since the baseline. Lanes `chat | collect | steer | follow_up`, statuses `queued | leased | running | completed | failed | canceled`, events `job.enqueued, job.leased, job.heartbeat, job.progress, job.completed, job.failed, job.canceled, queue.command, queue.command.consumed, job.lease_expired`, singleton modes `allow | cancel | steer`, and the nine `ReceiptJobKindSchema` kinds (`runtime-contracts.ts:111-121`) are as the map recorded. The canonical status mapping (`leased` displays as `running`) is documented in `docs/receipt-contract-standardization.md:46-65` and implemented in `services/receipt-status-contract.ts`.

### 2.9 What happens after an append (new wiring at HEAD)

`receiptAppendProjectionSchedule({ stream, eventType })` (`server/receipt-append-projection-scheduling.ts:59-93`) decides, per append:

* `chatContextStream` — the one session stream to rebuild ("the global projector is reserved for startup/backfill catch-up instead of duplicating every live append");
* `computerInventory` — only for computer-resource or objective streams **and** an inventory event type;
* `computerLeaseRun` — any job stream, or resource/objective streams with a lease/run event type;
* `objectiveProgressMirror` — objective or job streams, **excluding** the high-volume set `computer.command.stdout.observed`, `computer.command.stderr.observed`, `computer.heartbeat`, `computer.lease.renewed`, `factory.task.output.observed`, `job.heartbeat` (`:47-55`).

Objective progress mirroring into app chat is coalesced by `createObjectiveProgressMirrorScheduler` with `RECEIPT_OBJECTIVE_PROGRESS_MIRROR_INTERVAL_MS` (default 1000) and one trailing pass if appends land mid-mirror (`server/objective-progress-mirror-scheduler.ts:8-13`, `bootstrap.ts:769-772`). In the `api` role, `createProjectionWorkPump` polls `receipt_projection_work` for due rows (`requested_seq > processed_seq AND eligible_at <= now`) and runs one bounded batch per projector per round for the seven projectors `job_projection`, `objective_projection`, `chat_context_projection`, `computer_inventory_projection`, `computer_lease_run_projection`, `eval_run_projection`, `computer_use_session_projection` (`bootstrap.ts:3779-3803`; `projection-work-pump.ts:1-4`). Failures log `projection.durable_catchup_failed` and the row keeps its backoff (`eligible_at`).

---

## 3. Live layer (`packages/receipt-live`, unchanged)

* Topics: `agent | receipt | jobs | factory | profile-board | objective-runtime`; refresh event names `agent-refresh`, `receipt-refresh`, `job-refresh`, `factory-refresh`, `profile-board-refresh`, `objective-runtime-refresh` (`packages/receipt-live/src/protocol.ts:1-36`). Global fan-out keys exist for every topic except `agent` (`:41-53`).
* Frames: `{ kind:"event", topic, event, data, stream?, id? }` or `{ kind:"ping" }` (`:14-27`); `decodeLiveFrame` rejects unknown topics (`:66-96`).
* SSE transport (`hub.ts`): on subscribe each subscription immediately emits `event: <topic-refresh>\ndata: init` (`:98`); keepalive `event: ping\ndata: keepalive` every **5 000 ms** (`SSE_KEEPALIVE_MS`, `:16, 131, 154-156`); headers `text/event-stream`, `no-store` (`:166-167`). `publish(topic, stream?)` sends `data: <stream>` for `factory`, else `data: <Date.now()>` (`:173-178`); `publishData` sends arbitrary string data (`:181-182`).
* Browser client `createLiveEventSource(path)` (`browser.ts:94-165`) **requires WebSocket** (`"Live transport requires WebSocket support."`, `:99-101`), rewrites `http(s)`→`ws(s)` (`resolveWebSocketUrl`, `:86`), reconnects after 1 000 ms (`:104`), and re-dispatches frames as DOM events named by `frame.event`. The Factory shell therefore uses `GET <base>/live` (WebSocket), while `GET /receipt/stream` and `GET /jobs/:id/events` remain SSE.
* Only two data events are ever published by the server (`bootstrap.ts:1360, 1368`): `factory-stream-reset` (HTML fragment) and `agent-phase` (`JSON.stringify({ runId, phase, summary })`). `agent-token` is never published.
* Web-app proxy: `GET /api/receipt-trail/events` (`apps/start/src/routes/api/receipt-trail/events/route.tsx`, unchanged) requires an app session with an active organisation (`401 "Unauthorized"` / `401 "Organization context is required"`), proxies `<runtime>/receipt/stream`, answers `502 "Receipt event stream unavailable"` on upstream failure, and its comment states the contract: "Receipt runtime events are payload-free invalidation signals" — clients re-fetch after an event.

---

## 4. Durable layer (`packages/receipt-durable`, unchanged; `lib/durable-execution.ts`, unchanged)

* Contract (`packages/receipt-durable/src/contract.ts`): `WorkflowStatus` (`:3`) `idle|pending|running|completed|failed|canceled`; `ActivityStatus` (`:51`) `pending|running|completed|failed|canceled`; `WorkflowSnapshot` (`:25-38`) carries `key, status, revision, createdAt, updatedAt, input, metadata, output, error`; `ActivitySnapshot` (`:71-89`) adds `attempts, activeAttempt, activeOwner, lastHeartbeatAt, checkpointRevision, checkpointOutput, checkpointMetadata`; `DurableBackend` (`:175-237`) exposes `startOrResumeWorkflow, signalWorkflow, consumeWorkflowSignals, listWorkflowSignals, setWorkflowStatus, cancelWorkflow, getWorkflow, listWorkflows, waitForWorkflowChange, getActivity, heartbeatActivity, checkpointActivity, completeActivity, failActivity, listActivities, runDurableActivity`. Tables: `receipt_durable_workflow`, `receipt_durable_signal`, `receipt_durable_activity`, `receipt_durable_activity_attempt` (`db/schema.ts:677-745`), all `stateRole: "durable-execution"`, `zeroPublication: "internal"`.
* Keys (`lib/durable-execution.ts:43-50`): `factory/objective/<objectiveId>/control`, `factory/run/<encodeURIComponent(stream)>/<runId>`, `factory/codex/<jobId>`.
* **What is best-effort.** `createDurableQueueBackend` wraps every durable side effect in `runDurableSideEffect`, which catches, logs `[durable <label>] <message>` via `console.warn`, and does not fail the receipt mutation: "Receipt queue mutations are authoritative. Durable tables are a recoverable execution ledger, so failures here must not make an already-appended receipt mutation look like it failed." (`:190-206`). `queueCommand` is a deliberate pass-through so steer/follow-up never depend on workflow signal delivery (`:208-216`). Several activity heartbeat/checkpoint calls swallow errors with `.catch(() => undefined)` (`:240, 256`).
* Resonate: dispatch, driver, execute-and-settle, fencing statuses (`settlement_conflict, stale_attempt, lease_lost, terminal_state, canceled, execution_timeout, failed`), redrive loops, lease/timeout policy — all as in map §3.6, §4.1, §4.2; `resonate-config.ts` is unchanged and `resonate-runtime.ts` changed only to adopt the poll source (`8c74802b`). The Resonate server keeps its own store (`RESONATE_POSTGRES_URL` in production, SQLite locally); it is an execution ledger, never a receipt store.

---

## 5. Sync layer: Rocicorp Zero (`apps/start/src/integrations/zero/*`, unchanged; `apps/start/scripts/zero-*.ts`, unchanged)

### 5.1 What the browser sees

`createSchema({ tables: [...29 tables...] })` (`apps/start/src/integrations/zero/schema.ts:875-905`): `user`, `organization`, `member`, `invitation`, `orgAiPolicy`, `orgConnectionSecret`, `receiptWorkspace`, `receiptWorkspaceMember`, `receiptOrgSkillProjection`, `receiptOrgGuardrailGroupProjection`, `orgBillingAccount`, `orgSubscription`, `orgEntitlementSnapshot`, `orgMemberAccess`, `orgUserUsageSummary`, `receiptJobProjection`, `receiptObjectiveProjection`, `receiptTaskProjection`, `receiptComputerInventoryProjection`, `receiptComputerLeaseProjection`, `receiptComputerRunProjection`, `receiptComputerLiveOutputProjection`, `receiptFactoryHandoffProjection`, `receiptChatContextProjection`, `receiptChatHistoryProjection`, `receiptSessionMessage`, `receiptMemoryEntry`, `receiptMemoryAccess`, `attachment` (table declarations at `:23-670`). The raw receipt log is **not** in the client schema; the browser only ever sees projections. Zero client version is `@rocicorp/zero 1.4.0` (`apps/start/package.json:49`).

`ZeroContext` is `{ userID, organizationId?, isAnonymous }` (`schema.ts:915-920`). `resolveZeroAuthSnapshot` refuses to boot Zero for a signed-in non-anonymous user with no active organisation ("Returning a personal-scope snapshot here would boot Zero against the wrong viewer context", `zero-auth.ts:22-30`). The provider (`provider.tsx`) reads `VITE_ZERO_CACHE_URL` (`:15`), passes `schema` and `mutators` (`:301-302`), keys the client on `userID:organizationId:token|cookie` (`:285-286`), and attaches a self-hosted access token header (`ZERO_ACCESS_TOKEN_HEADER`) obtained from `GET /api/zero/token` when required (`self-hosted-token.ts:14-121`, refreshed 60 s before `expiresAt`, `:99-113`).

### 5.2 The `zero_data` publication and why a missing table breaks sync

`apps/start/scripts/zero-publication.ts:5-20` builds `ZERO_UI_PUBLICATION_TABLES` = 14 app tables (`user, organization, member, invitation, org_ai_policy, org_connection_secret, receipt_workspace, receipt_workspace_member, attachments, org_billing_account, org_subscription, org_entitlement_snapshot, org_member_access, org_user_usage_summary`) plus `ZERO_DEFAULT_RECEIPT_PUBLICATION_TABLES` from the runtime table contract (§1.8); `ZERO_PUBLICATION_EXTRA_TABLES` (comma-separated) can opt in more (`:43-51`). `zero-migrate.ts:718` names the publication `zero_data`; `ensureZeroPublication` refreshes it to exactly that set, with column lists that keep encrypted Connect material server-side for `org_connection_secret`, `receipt_workspace`, `receipt_workspace_member` (`:725-770`). `zero-cache` is started with `ZERO_APP_ID=receipt` and `ZERO_APP_PUBLICATIONS=zero_data` (`apps/start/package.json:19`); its local replica is a SQLite file at `ZERO_REPLICA_FILE` or `apps/start/zero.db` (`zero-dev-reset.ts:150-154`), and `zero:reset` deletes `zero.db`, `zero.db-wal`, `zero.db-shm`.

The failure mode is documented in the guard test `schema-publication.test.ts:6-13`: "a table added to the Zero client schema but NOT to the `zero_data` publication makes the client schema mismatch the replicated set, which breaks ALL client sync (UI flicker + no data after login)." The test asserts every client-schema table's `serverName ?? name` is in `getZeroPublicationTables()` (`:15-29`). Postgres must run with `wal_level=logical` for the publication to be consumed (memory: `docker-compose.postgres.yml`).

### 5.3 `/api/zero/token`, `/api/zero/query`, `/api/zero/mutate`

* `GET /api/zero/token` (`apps/start/src/routes/api/zero/token/route.tsx`): requires an app user (`401 { error:"Unauthorized" }`), issues `{ token, expiresAt }` via `issueZeroAccessToken({ userId, organizationId, isAnonymous })`; configuration failure → `503 { error:"Zero token configuration failed.", cause }`.
* `POST /api/zero/query` (`query/route.tsx`): `requireZeroAppUserAuth` (cookie or the `ZERO_ACCESS_TOKEN_HEADER` bearer, `lib/backend/server-effect/http/zero-server-auth.ts:7,26-51`), builds `ZeroContext` from the **server** session, resolves the named query from the registry with `mustGetQuery(queries, name)` and `addContextToQuery` (`:55-68`), then `handleQueryRequest(transformQuery, schema, request, 'error')`; `transformFailed` → 400, processing error → 500 with `['transformFailed', { kind:'internal', message }]`, unauthenticated → 401.
* `POST /api/zero/mutate` (`mutate/route.tsx`): the comment fixes the security model — "Requires cookie auth: set ZERO_MUTATE_FORWARD_COOKIES=true on zero-cache so the session cookie is forwarded; we derive userID from server auth context, not from forwarded headers." (`:15-18`). Without `ZERO_UPSTREAM_DB` → `503 { kind:'PushFailed', message:'ZERO_UPSTREAM_DB not configured', mutationIDs:[] }`. Runs `new PushProcessor(zeroNodePg(schema, pool), context, 'error').process(mutators, request)`; `PushFailed` with reason `Parse`/`UnsupportedPushVersion` → 400, else 500. A `branch_version_conflict` in the result is logged as `zero_mutate_branch_version_conflict` with `request_id` (from `x-request-id` or a fresh UUID) and emitted as a wide error event `chat.branch.version.conflict`, `retryable: true` (`:85-117`).

### 5.4 Queries, mutators, permissions

* Query registry (`queries.ts:16-25`) composes `orgBilling`, `orgKnowledge`, `guardrails`, `organizationSkills`, `orgSettings`, `orgPolicy`, `receipt`, `receiptConnect` modules. Receipt queries (`queries/receipt.queries.ts:50-320`): `recentObjectives`, `recentTasks`, `tasksByObjectiveId`, `objectiveById`, `objectiveAnswerByObjectiveId`, `computerLiveOutputByObjectiveId`, `computerInventory`, `computerLeases`, `computerActiveLeases`, `computerRuns`, `computerLiveOutput`, `recentJobs`, `chatContextByChatId`, `chatContextByObjectiveId`, `chatContextsByChatId`, `chatHistoryByChatId`, `chatHistoryByObjectiveId`, `chatHistoryPage`; plus `receiptConnect.connections`.
* Permission model: there is no separate permissions file; scoping is inside each query. Example `recentObjectives` filters `ownerOrgId = organizationId` when `getOrgContext(ctx)` yields an org, else `userId = ctx.userID` (`receipt.queries.ts:52-64`). `getOrgContext` returns `null` for anonymous users or no active org (`org-access.ts:21-32`); `requireOrgContext` throws `"Organization context is required"` for writes (`:38-47`); `isOrgMember(userID)` is the membership predicate (`:53-55`); `missingOrganizationQuery()` returns a query that matches nothing (`:57-59`).
* Mutators (`mutators.ts:10-13`) compose `chatMutatorDefinitions` and `orgPolicyMutatorDefinitions`. `orgPolicy.*` includes `toggleProvider`, `toggleModel`, `toggleComplianceFlag`, `setEnforcedMode` and feature/tool toggles (`mutators/org-policy.mutators.ts:258-360`). **No mutator writes a receipt**; Zero mutations touch app-owned tables. Receipt-projection tables reach the browser read-only through replication.

---

## 6. Web app server routes (`apps/start/src/routes/api/*`, unchanged since baseline)

| Route | Method | Purpose | Auth |
|---|---|---|---|
| `/api/auth/$` | GET, POST | Better Auth handler passthrough (`auth/$.tsx:4-9`) | Better Auth |
| `/api/chat` | GET, POST | GET resumes a chat stream (`eventName: 'chat.resume.request'`); POST runs the chat orchestrator (`chat.request`). Both mint a `requestId` UUID and a wide event (`chat/route.tsx:34-60, 139-170`) | `requireAppUserAuth`; `401 "Unauthorized"`; `401 "Organization context is required"` |
| `/api/zero/token` | GET | issue Zero access token | app user (§5.3) |
| `/api/zero/query` | POST | Zero synced-query transform | cookie or Zero header (§5.3) |
| `/api/zero/mutate` | POST | Zero push processor | cookie (§5.3) |
| `/api/receipt-trail/events` | GET | SSE proxy to runtime `/receipt/stream` | app user + active org (§3) |
| `/api/receipt-ingest/receipts` | GET, POST | authenticated receipt append for CLI imports; allowlisted to `imports/clauden/` and `imports/claude-code/`; 2 MiB body, 100-receipt batch (map §10.4) | Receipt Connect JWT with `connect:write`; tenant from token `sub`/`org_id` |
| `/api/receipt-connect/cli-login` | GET, POST | device-login approval: GET needs `user_code` (`400 { ok:false, error:'user_code is required' }`), errors redirect to sign-in; POST completes the device flow (`cli-login/route.tsx:270-300`) | app session |
| `/api/sessions/dashboard` | GET | imported Claude Code session dashboard (§8.1) | `requireActiveSessionFromHeaders`; `401 { ok:false, error:'Unauthorized' }`; `500 { ok:false, error }` |
| `/api/sessions/evidence` | POST | `{ stream (1..500 chars), limit? 1..50 }` → bounded evidence rows (§8.1) | same; Zod error → 400 |
| `/api/org/model-policy` | GET, POST | read/update org model policy | `requireOrgAuth`; `401 "Unauthorized"` |
| `/api/files/upload` | POST | attachment upload | `requireNonAnonymousUserAuth` |
| `/api/files/markdown` | POST | markdown rendering for files | `requireNonAnonymousUserAuth` |
| `/api/files/object` | GET | signed object fetch; `?sig=` verified by `verifyStorageKeySignature` (`400`, `403 { error:'Invalid file signature' }`) | signature, no session |
| `/api/slack/events` | POST | proxies Slack Events API to `apps/slack` ("service owns signature verification, dedup, identity resolution", `slack/events/route.tsx:13`) | Slack signature (in the Slack service) |
| `/api/slack/install` | GET | Slack install redirect; `401 'Sign in and select a workspace before installing Slack.'`, `403 'Only workspace admins can install Slack.'` | app session, workspace admin |
| `/api/slack/oauth/callback` | GET | redirect to Slack service callback | — |
| `/api/admin-metrics` | GET | Kentron admin console metrics; `401 { error:'Sign in to continue.' }`, `403 { error:'This account does not have access to the admin console.' }`; logs `[admin-metrics] read by <viewer email>` | `resolveAdminViewer` |
| `/api/dev/session-login` | GET | dev-only session cookie minting; enabled only when `import.meta.env.DEV` and the host is local (`session-login/route.tsx:30`) | none (dev) |

Where receipts are written on the web path: the chat orchestrator writes app-chat receipts through `chat-bridge.ts` to `apps/start/<repoKey>/app-chat/sessions/<threadId>` and `.../runs/<runId>` (`chat-bridge.ts:102-106`), and objective control/tasks call the runtime's `POST /agents/factory/jobs`, `POST /jobs/:id/abort`, `GET /jobs?status=` (`lib/frontend/tasks/objective-control.server.ts:124,174,211`; `beetle-task.server.ts:169`; `lib/backend/chat/services/receipt-chat.service.ts:3195,3757`). The web app never writes to `receipt_receipts` directly except via the receipt-ingest route, which uses the same Postgres store.

---

## 7. The TypeScript SDK (`packages/receipt-app/src/sdk/*`, unchanged)

### 7.1 Exports (exact)

`sdk/index.ts:1-19` exports values `receipt`, `defineAgent`, `action`, `assistant`, `tool`, `human`, `merge`, `rebracket` and types `ReceiptDeclaration`, `ReceiptBody`, `ModernAgentSpec`, `ActionCommitContext`, `ActionExecutionMode`, `ActionKind`, `ActionRunContext`, `ActionSideEffects`, `AgentAction`, `DurableActionContext`, `MergePolicy`, `MergeCandidate`, `MergeDecision`, `MergeScoreVector`. There is no `goal` helper; `goal` is a spec field. `receipt<T>()` is a pure type marker returning `{ __receipt: true }` (`sdk/receipt.ts:6-8`); `defineAgent(spec)` returns `spec` unchanged (`sdk/agent.ts:6-14`); `merge(policy)` returns `policy` and `rebracket = merge` (`sdk/merge.ts:23-24`).

### 7.2 The action contract

```ts
// sdk/actions.ts:1-3, 15-21, 35-69
type ActionKind          = "action" | "assistant" | "tool" | "human";
type ActionExecutionMode = "local" | "remote";
type ActionSideEffects   = "receipt_only" | "query" | "external";
type DurableActionContext = { invocationId; selectionId; selectedHead?; claimId; claimOwnerId };
type AgentAction<View, EmitFn> = {
  id; kind; when?(ctx:{view}); run(ctx: DurableActionContext & { view; emit });
  sideEffects?; responseWhen?(ctx:{view; invocationId; selectionId});   // human only
  commitWhen?(ctx: DurableActionContext & { view; selectedView });
  exclusive?; maxConcurrency?; execution?; targetGroup?;
};
```

Doc comments in the source are the normative semantics and can be quoted: receipt-only local work is replay-safe; local `query` work "is explicitly at-least-once after lease ambiguity, while its buffered receipt output is fenced and deduplicated by `invocationId`"; "`external` mutations must use `execution: "remote"` and must pass `invocationId` as the downstream idempotency key. Remote delivery is at-least-once" (`actions.ts:5-14, 40-46`); `responseWhen` suspends a human action after `human.requested` until the predicate turns true "from a newly appended, receipt-derived view" and is required by the `human(...)` helper at the type level (`:48-57, 92-97`); `commitWhen` is "an optimistic-validity fence … evaluated against the selected and latest receipt-derived views inside the same CAS loop that appends each output. Returning false supersedes this invocation and causes the controller to select again from the new head" (`:58-64`).

`engine/runtime/*` has zero commits since the baseline, so the map's scheduler and control-receipt facts stand: kind priority `human 0 < assistant 1 < action 2 < tool 3`; `exclusive` selects exactly one; the effective concurrency cap is the minimum across selected actions and the spec default; deterministic `selectionId` / `invocationId` are sha256 prefixes over `(runId, spec.id, spec.version, policyVersion, SCHEDULER_POLICY_VERSION, selectedHead, actionIds)`; control receipts are `run.started/completed/blocked/failed`, `action.selected/started/output.manifest/completed/failed/superseded`, `human.requested/responded`, `goal.completed`, `merge.started/output.manifest/selected/applied/skipped/failed` (`control-receipts.ts:197-217`, map §4.4); `CONTROL_POLICY_VERSION = "runtime-policy-v2"`, `SCHEDULER_POLICY_VERSION = "scheduler-v2"`.

### 7.3 Remote execution and its refusals

`execution: "remote"` dispatches through Resonate function `receipt.agent.action.execute` version 2 with RPC id = `invocationId` and `targetGroup` selecting the Resonate group. The remote worker reloads the spec **from `packages/receipt-app/src/agents/<id>.agent.ts`** (`sdk/agent-spec-loader.ts:16-17`, `packagePath(import.meta.url, "src", "agents")`), verifies it is a spec (`:22-32`), and refuses with (map §4.4, `engine/runtime/resonate-agent-actions.ts`, unchanged): `agent spec '<id>' does not support remote execution`, `remote action '<id>' requires <agent>@<version>, but the worker loaded <agent>@<version>`, `remote action '<id>' selected head '<hash>' is unavailable`, `remote action '<id>' no longer matches selected kind/execution provenance`, `remote action '<id>' is no longer runnable at its selected head`.

### 7.4 Merge policy

`MergePolicy<Ctx, Evidence>` = `{ id, version, shouldRecompute?, candidates, evidence, score → MergeScoreVector (Record<string, number>), choose → { candidateId, reason? } }` (`sdk/merge.ts:13-21`). `shouldRecompute` is optional. Lifecycle receipts are `merge.started → merge.output.manifest → merge.selected → merge.applied | merge.skipped | merge.failed`.

### 7.5 `receipt new` scaffold defect: status at HEAD — **still broken in the monorepo**

* `.receipt/bin/receipt:15-16` resolves `ROOT_DIR` two directories above itself (the repo root) and `cd`s there; it then runs `packages/receipt-app/src/cli.ts` (`:47-52`). `cli/runtime.ts:21` sets `ROOT = process.cwd()`, so `ROOT` is the repo root.
* `commandNew` (`cli/commands.ts:123-207`) validates `^[a-z][a-z0-9-]*$` (`Invalid agent id '<id>'. Use kebab-case.`), writes `path.join(ROOT, "src", "agents", "<id>.agent.ts")` (`:127`), refuses an existing file (`Agent file already exists: <abs>`), and emits the header `import { defineAgent, receipt, action, assistant, human } from "../sdk/index";` (`:184`). It prints `created src/agents/<id>.agent.ts`.
* `ls src` at the repo root returns "No such file or directory"; the only `sdk/index.ts` is `packages/receipt-app/src/sdk/index.ts`. **The generated import path does not exist.** `receipt run <id>` loads `<ROOT>/src/agents/<id>.agent.ts` (`cli/runtime.ts:83-84`) and will fail to resolve `../sdk/index`.
* The wrapper has a fallback `CLI_PATH="$ROOT_DIR/src/cli.ts"` (`:49-51`) for a layout where the package *is* the root; in that layout `src/sdk/index.ts` exists and the scaffold works. No such layout is produced by any script in `scripts/` (the release scripts invoke `packages/receipt-app/src/cli.ts`), so the defect applies to every checkout of this repo.
* Secondary defects unchanged from the map: the `merge` template declares `candidate.generated`/`draft.finalized` but its action emits `task.completed` (`:132-137, 176-182`); `printUsage` advertises `--max-iterations`/`--workspace` that `commandRun` ignores; `docs/create-agent.md:43` and `docs/api/cli.md:201` describe the repo-root `src` tree as "the compatibility and developer authoring surface", which is aspirational.

---

## 8. Learning loop and the training-data claims

This section answers the question the caller posed directly: what in the code backs "automatically transform production conversations into high-quality training datasets", "extract and label production conversations automatically for instant model retraining", "turn customer interactions into validated training data without manual annotation", and "close the feedback loop: production insights powering continuous AI model improvement".

### 8.1 The `/sessions` page and `/api/sessions/*` — imported Claude Code sessions

**Classification: implemented and reachable in the UI (navigation entry "Sessions", description "Imported agent logs and receipts", `sessions-nav.config.tsx:17`) — but its "lesson" features are stubbed/inert.**

* Route `apps/start/src/routes/(app)/_layout/sessions/route.tsx:5-19` redirects unauthenticated or anonymous users to `/auth/sign-in`.
* Page title `"Sessions"`, description `"Find token waste, compliance risks, replay gaps, and reusable lessons from Claude activity."` (`components/sessions/sessions-page.tsx:586-587`); search placeholder `"Search sessions, tags, models"` (`:660`). Modes: `Checks`, `Replay`, `Lessons`, `Evidence` (`:33-44`, `WorkbenchMode`). There is **no "Metrics" mode**; metrics appear as `ValueMetric` tiles inside the Checks panel (e.g. label `"Optimization target"` with value `"Context churn"` or `"Stable"`, `:892-900`).
* Data source: streams under `imports/clauden/` and `imports/claude-code/` (`agent-sessions.server.ts:35-38`), at most 50 streams (`MAX_STREAMS`, `:39`), read from the tenant schema with a fresh pool that deliberately avoids `getReceiptDb()` so a dashboard read cannot wait on DDL locks (`:503-521`). Counts are SQL aggregates over `receipt_receipts` rows of `event_type = 'import.object.normalized'`: `requestCount` = rows whose `normalized.timeline.role` is `user` (or raw type `claude-code.user`), `responseCount` = `assistant`, `rotationCount` = `entityType = 'agent_rotation'`, `errorCount` = `entityType = 'agent_error'` (`:620-655`); latest model/account/status from the newest row (`:657-668`).
* Tags (`buildTags`, `:233-246`): source, project, first three model-id segments, `needs-review`, `rate-limit`, `long-run` (≥250 turns), `replay-ready`.
* Insights (`buildInsights`, `:277-333`): `"Replay coverage"`, `"Review interruptions"`/`"Clean run shape"`, and `"Reflection candidate"` — whose summary is `"Enough turn structure exists to mine lessons, tags, and reusable skills."` when `requestCount + responseCount >= 20`, else `"More activity is needed before this session is a strong lesson candidate."`; confidence `medium`/`low`.
* Checks (`buildChecks`, `:335-418`): five cards. `analysisReady = turnCount >= 20 && receiptCount >= 40` (`:346`). Exact strings:
  * **Token optimization** — metric `"High context churn"` (turns ≥150 or receipts ≥500) or `"<n> turns"`; button `"Find token waste"` / `"Review token shape"`.
  * **Replay completeness** — metric `"<coverage>% paired"` or `"No prompts"`; button `"Inspect gaps"` / `"Open replay"`.
  * **Compliance readiness** — metric `"Scan ready"` / `"Metadata only"`; detail `"The dashboard should not dump raw prompts by default. A compliance job should scan a capped evidence window and write findings back as receipts."`; button `"Run compliance scan"` / `"Wait for evidence"`.
  * **Lesson candidate** — metric `"Promotable"` / `"Too small"`; summary `"This session has enough structure to extract reusable lessons or draft a skill."` / `"More prompt and response structure is needed before promoting a lesson."`; detail `"Lesson extraction should produce concrete rules, not summaries: what failed, what changed, and what future agents should do differently."`; button `"Draft lesson"` / `"Collect more turns"`.
  * **Agent computer review** — metric `"Available"` / `"Not ready"`; detail `"Use this for deeper root-cause analysis, prompt rewrites, test suggestions, or runbook generation. Keep it explicit because it sends selected evidence to a model."`; button `"Ask the agent to analyze"` / `"Prepare evidence"`.
* **What the buttons do** (`sessions-page.tsx:880-889`): `coverage` → switch to Replay mode; `compliance`, `sandbox`, `token` → open the Evidence panel; **`lesson` → nothing** (no branch). No compliance scan job, no token-waste analysis, no sandbox review, and no lesson draft is started by any of these buttons. They navigate between read-only panels.
* Lessons mode (`LessonsPanel`, `:977-1024`) renders three static cards: `"Lesson candidate"` with `"This run has enough prompt and reply structure to extract a reusable lesson."` or `"This run needs more turn structure before it should become a durable lesson."` (threshold 20 turns); `"Review markers"`; and `"Skill draft"` with `"Tags and replay phases can seed a skill draft after evidence review."` Nothing is written; there is no draft, no export, no persisted lesson.
* Evidence and Replay modes call `POST /api/sessions/evidence` (limit ≤50) and render `import.object.normalized` rows with their timeline (`role`, `model`, `toolName`, `text`, `usage` token counts) and `rawJson` (`agent-sessions.server.ts:524-579`, `functions.ts:9-38`). This is the only place raw transcript text is shown, and it is bounded.
* Nothing on this page or its APIs exports data: `grep -rn "download|Content-Disposition|csv|toBlob" apps/start/src/components/sessions apps/start/src/routes/api` returns nothing.

**Verdict:** the page is an honest *readiness dashboard* over imported transcripts. "Lesson candidate" is `turns >= 20 && receipts >= 40`. No lesson, label, dataset, or model artefact is produced.

### 8.2 `docs/factory-self-improvement.md` and its implementation

**Classification: implemented and reachable (Factory workbench + CLI), scoped to Factory objectives, and explicitly recommendation-only.**

The doc's own framing (`docs/factory-self-improvement.md:9-38`) is accurate to the code: "not a hidden autonomous planner that rewrites itself"; it "does **not** currently mean automatic multi-objective strategy optimization, automatic code changes from audit findings alone, unrestricted repeated retries". Verified pieces:

* Objective contract before execution and an `alignment` block (`verdict: aligned|uncertain|drifted`, `satisfied`, `missing`, `outOfScope`, `rationale`) in delivery results, one corrective pass, then hard stop (`:65-127`; schema in `services/factory/result-contracts.ts`).
* Terminal objectives enqueue `factory.objective.audit` (`ReceiptJobKindSchema` includes it, `runtime-contracts.ts:116`; bootstrap logs `factory.audit_enqueue_failed` on failure); the audit writes `objective.audit.json`/`.md` under `${DATA_DIR}/factory/artifacts/<objectiveId>/` and commits compact summaries to memory scopes `factory/audits/objectives/<objectiveId>` and `factory/audits/repo` (`:161-193`).
* Workbench projection: `buildObjectiveSelfImprovement` (`services/factory/runtime/objective-control-self-improvement.ts:9-50`) yields `auditStatus` ∈ `pending|running|failed|ready|missing`, `stale`, `recommendations`, with messages `"Objective audit is queued."`, `"Objective audit is running."`, `"Objective audit failed: <lastError>"` / `"Objective audit failed before a fresh snapshot was recorded."`, `"Latest audit snapshot predates the current objective state."`, `"No fresh audit snapshot has been recorded for this objective yet."`. The web view labels are `"Audit failed"`, `"Audit running"`, `"Audit queued"`, `"Audit missing"`, `"Fix completed"`, `"Fix failed"`, `"Fix canceled"`, `"Fix needs review"`, `"Fix in progress"`, `"Auto-fix linked"`, `"Audit stale"`, `"Recommendations unavailable"`, `"Recommendations ready"`, `"Audit recorded"` (`views/factory/shared/self-improvement.ts:22-60`).
* Applying a recommendation requires the operator route `POST <base>/api/objectives/:id/self-improvement/apply` or `POST <base>/api/system-improvement/apply` (§2.5); "the audit worker itself has no creation capability" (`:208-211`). Historical auto-fix outcomes feed a deterministic *policy-feedback report* whose output is one of `wait | lower_threshold | keep_threshold | raise_threshold | manual_review` (`:213-232`) — it reports; it "does not yet mutate runtime policy without an operator-controlled policy store" (`:348-349`).
* Simulator: `receipt factory simulate self-improvement --json` (`:367`); sim source `services/factory/sims/self-improvement-loop.ts`; tests listed at `:373-381`.

**What it is not:** it improves *prompts, contracts, memory and objective planning inside Factory*. It never touches model weights, never emits a dataset, and its only "learning" store is compact memory entries plus JSON/Markdown audit artefacts.

### 8.3 The eval harness (`receipt eval`)

**Classification: implemented and reachable in the CLI only (no UI).**

`cli/eval.ts:88-210` dispatches `run <scenario>`, `batch [<dir>]`, `report [--limit 1..200]`, `inspect <runId>`, `replay <runId>`, `list-scenarios [<dir>]`; errors `"eval subcommand is required"`, `"eval run requires a scenario id or path"`, `"eval inspect requires a run id"`, `"eval replay requires a run id"`, `` `eval run '${runId}' not found` ``, `` `Unknown eval subcommand '${x}'` ``. The semantic oracle needs `--organization-id` **and** that organisation's OpenAI BYOK key (`:23-27`); a scenario must also set `oracle.semanticEnabled: true` (`services/eval/oracle.ts:320-324`; `eval/scenarios/software/repo-grounding-smoke.json:38-39` does, `computer-use/factory-workbench-flow.json:102-103` does not). The oracle is an `llmStructured` call returning bands `strong|acceptable|weak|not_evaluated` for `abstractionChoice, reviewQuality, proportionality, unnecessaryComplexity, wrongSubsystemChoice` (`oracle.ts:23-30, 336-349`). Runs write receipts `eval.run.seeded`, `eval.run.started`, `eval.scenario.registered`, `eval.grounding.snapshot`, `eval.oracle.checked`, `eval.score.computed`, `eval.handoff.recorded`, `eval.run.completed` to `eval/runs/<runId>` (`services/eval/run.ts`, `receipts.ts:24-25`), are projected into `receipt_eval_run_projection`, and `report` prints `Receipt Eval Report`, `Runs:`, `Pass rate:`, `Abstraction miss rate:`, `Revert rate:`, `Strong handoff completeness rate:` (`cli/eval.ts:65-86`). Two scenarios are checked in. **This evaluates Factory/agent runs against scenarios; it does not produce or consume training data.**

### 8.4 The deterministic simulation corpus (`receipt factory simulate corpus add | reduce | promote`)

**Classification: implemented and reachable in the CLI.** The "corpus" is a JSON list of **PRNG seeds** for the deterministic simulator, default file `packages/receipt-app/src/services/factory/sims/fixtures/search-regression-corpus.json` (`factory-cli/commands/index.ts:867`). `corpus add --seed <n> [--reason]` appends a seed (`:1075-1098`, error `"factory simulate corpus add requires --seed <non-negative-number>"`); `corpus reduce --input <search-artifact.json> --corpus-file <out> [--shrink]` materialises the failing seed prefix and re-verifies it (`:1436-1470`, `"factory simulate corpus reduce --shrink requires verification; remove --skip-verify"`); `corpus promote --input <reduced-corpus.json>` merges verified seeds into the default corpus (`:1619-1660`, `"factory simulate corpus promote requires a verified reduced corpus; pass --allow-unverified to override"`). The workflow is documented in `services/factory/sims/README.md:448-463` and `docs/factory-deterministic-simulation-harness.md:26-45`. `receipt:check` runs the repeat simulation as part of the standard gate (root `package.json`, map §9.3). **No production conversation content enters the corpus; seeds are integers, and `prod-replay` inputs are receipt JSON fixtures.**

### 8.5 Memory: commit, read, search, summarize, diff

**Classification: implemented and reachable (runtime HTTP `/memory/*`, CLI `receipt memory`, Factory packets).** `MemoryEvent` is `memory.committed` / `memory.accessed` (`adapters/memory-tools.ts:51-66`); accesses record `operation` ∈ `read|search|summarize|diff|reindex` and `strategy` ∈ `recent|keyword|semantic|time_window|reindex` (`:29-31`). At HEAD every `createMemoryTools` call omits `embed` (`bootstrap.ts:297-300`, `cli/runtime.ts:56-59`, `factory-runtime.ts:1133-1136`), so `semanticSearch` (which throws `"semantic search requires embed dependency"`, `:504-505`) is never selected and search is `keywordSearch` (`:527`, `:586-593`). `summarize` clamps `maxChars` to 100..12 000 (default 2 400) and `limit` to 1..500 (default 20), retrieves by keyword or recency, and returns `summarizeText(entries, maxChars)` — a joined, truncated string (`:320-330, 604-611`). Memory is a durable notes store with receipts; it is not an annotation store and not a training set.

### 8.6 Search results for dataset, labeling, fine-tuning, retraining

Commands run at HEAD (quoted `--include` globs, `apps packages scripts workers`):

| Pattern | Result |
|---|---|
| `fine[-_ ]?tun` (`.ts .tsx .mjs .json`) | **0 files** |
| `retrain` (`.ts .tsx`) | **0 files** |
| `training[ _-]?(data\|set\|example)`, `\bdatasets?\b` (`.ts .tsx`) | 13 files, all false positives: UI test files, `landing-page.tsx` marketing copy, `prompt-input-textarea.tsx`, `use-streamdown-plugins.ts`, `ai-catalog/types.ts`/`providers/google.ts` (model catalog metadata), `simulator-ui.ts`, `factory-preview-runtime.ts`, `factory-client/workbench.ts` (the word "dataset" as an HTML `data-` attribute or catalogue field) |
| `jsonl` (`.ts .tsx`) | 16 files, all **readers**: `cli/clauden-import.ts:240-250, 514` (discovers Claude Code `~/.claude/projects/**/*.jsonl` transcripts to import), `factory-runtime.ts:173` and `task-run-orchestrator-core.ts:44` (name a `*.worker-trace.jsonl` output log), `opensandbox-execution-codex-exec.ts:267` and `investigation-result-evidence-telemetry.ts:27` (parse Codex/OpenSandbox JSONL event logs), `error-formatting.ts` (`parseJsonLike`), plus sims and tests |
| `\blabel(ed\|ing\|er)\b\|annotat` (`.ts .tsx`, non-test) | 10 files, all UI labels / log labels / prompt text (`wide-event.ts`, rate-limit and allowance services, `zero/mutate/route.tsx`, `receipt-connect-call.ts`, `receipt-connect-mcp.ts`, `objective-supervisor-prompt.ts`); no annotation model, no labeling UI |
| `fine-tune\|retrain\|training data\|dataset` in `docs/*.md`, `README.md`, `AGENTS.md` | **0 files** |

There is no JSONL/CSV/Parquet export of conversations, no "export dataset" button, no OpenAI/Anthropic/Bedrock fine-tuning API call, no labeling queue, no human-review workflow for training examples, and no model registry. The only outward-bound conversation data paths are the Claude Code transcript **import** into the tenant's Postgres (`/api/receipt-ingest/receipts`) and the bounded evidence view on `/sessions`.

### 8.7 Feature classification table

| Feature | Classification | Evidence |
|---|---|---|
| Receipt chain, verify, fork, replay | implemented and reachable (CLI `receipt trace/replay/fork/inspect/dst`, runtime `/receipt` browser) | §1 |
| Runtime job API, memory API, SSE/WS live | implemented and reachable | §2, §3 |
| `/receipt-debug/*` | implemented but hidden (token-gated, operator-only) | §2.7 |
| `GET /runtime` dashboard, `GET /receipt` browser | implemented but hidden (direct URL; private gateway prefix) | §2.5 |
| `/jobs/:id/wait` | implemented, deprecated | §2.3 |
| Zero sync of projections | implemented and reachable | §5 |
| SDK `defineAgent` + `receipt run` | implemented and reachable in CLI; **`receipt new` scaffold produces an unresolvable import** | §7.5 |
| Remote action lane (`execution: "remote"`) | implemented; only for specs under `packages/receipt-app/src/agents/` | §7.3 |
| `/sessions` Checks/Replay/Evidence | implemented and reachable | §8.1 |
| `/sessions` "Draft lesson", "Run compliance scan", "Find token waste", "Ask the agent to analyze" | **stubbed or inert** (buttons navigate to panels or do nothing) | §8.1 |
| `/sessions` Lessons mode | **stubbed or inert** (static cards driven by a count threshold) | §8.1 |
| Factory self-improvement audit + recommendations | implemented and reachable (workbench, CLI `factory investigate/audit`) | §8.2 |
| Auto-apply of recommendations | absent by design (operator route only) | §8.2 |
| `receipt eval` | implemented and reachable (CLI only) | §8.3 |
| DST seed corpus | implemented and reachable (CLI only) | §8.4 |
| Memory semantic search | **stubbed or inert** at HEAD (no `embed` wired; keyword only) | §8.5 |
| Dataset export, labeling, fine-tuning, retraining | **absent** | §8.6 |

---

## 9. Error handling and logging conventions

* **Runtime structured logs.** `createStructuredLogger({ service, defaultContext })` (`packages/receipt-core/src/structured-logger.ts:102-127`) writes one JSON object per line with reserved keys `ts, level, service, event, message` (`:12`); caller-supplied reserved keys are nested under `context`. Keys matching `/(?:authorization|cookie|password|secret|token|api[_-]?key|access[_-]?key|session)/i` are replaced by `"[redacted]"` (`:13, 33`); strings are clipped at 2 000 chars with `...[truncated]` (`:14-17`); `Error`s serialise to `{ name, message, stack }` (`:23-27`); circular values become `"[circular]"`; `warn`/`error` go to stderr, `debug`/`info` to stdout (`:93-99`). The runtime logger is `service: "receipt-runtime"` (`bootstrap.ts:203-206`). Event names at HEAD (grep of `logger.<level>("...")` in `bootstrap.ts`): `runtime.configured`, `runtime.http_listening`, `runtime.worker_connected`, `runtime.startup_failed` (then `process.exit(1)`), `runtime.shutting_down`, `http.unhandled_error`, `projection.app_chat_sync_failed`, `projection.chat_stream_sync_failed`, `projection.computer_inventory_sync_failed`, `projection.computer_lease_run_sync_failed`, `projection.durable_catchup_failed`, `projection.objective_progress_mirror_failed`, `factory.audit_enqueue_failed`, `factory.control_outbox_redrive_failed`, `factory.control_outbox_redrive_slow`, `factory.reconcile_enqueue_failed`, `factory.resume_failed`, `factory.ui_warmup_failed`, `factory.watchdog_schedule`, `factory.watchdog_schedule_failed`, `resonate.dispatch_error`, `resonate.dispatch_outbox_error`, `resonate.queued_redrive`, `resonate.queued_redrive_loop_error`, `resonate.queued_redrive_startup_error`, `resonate.role_runtime_error`. Projection sync latency logging is gated by `RECEIPT_PROJECTION_SYNC_LATENCY_LOG_THRESHOLD_MS` (250) / `RECEIPT_PROJECTION_SYNC_LATENCY_LOG_ALWAYS` (`bootstrap.ts:210-214`); rerun backoff by `RECEIPT_PROJECTION_RERUN_BASE_DELAY_MS` (250) / `RECEIPT_PROJECTION_RERUN_MAX_NOOP_DELAY_MS` (4000) (`:217-221`); sync retries by `RECEIPT_PROJECTION_SYNC_MAX_ATTEMPTS` (5) / `RECEIPT_PROJECTION_SYNC_RETRY_BASE_MS` (100) (`:415-416`).
* **Legacy console lines** remain in hot paths (`console.warn("[chat/respond] profile-aware response failed", ...)`, `` `[receipt-runtime] background lease reconciliation failed for ${jobId}` ``, `[durable <label>]`), so a log pipeline must accept both JSON and prefixed text.
* **No request ids in the runtime** (§2.2). The web app mints `requestId = crypto.randomUUID()` per chat request and carries it in a "wide event" (`apps/start/src/lib/backend/chat/observability/wide-event.ts:15, 114-123`) that is drained as one Effect log line `chat.request` at `info|warning|error` with `request_id` (`:252-281`); `/api/zero/mutate` honours an inbound `x-request-id` (`mutate/route.tsx:85-86`).
* **HTTP error contract** (runtime): text errors for job/memory routes; JSON `{ ok:false, error:<snake_case_code>, detail? }` for chat, connect, and debug routes; `500 "Server error"` for anything unhandled. The web app uses Effect tagged errors mapped to JSON `{ error }` bodies.
* **`packages/receipt-app/src/telemetry/`** contains one file, `artifacts.ts` (70 lines): `buildTelemetryEvidenceRecord` captures `{ command, stdout, stderr, exitCode, startedAt, finishedAt, files:[{path, checksum(sha256), bytes}], proof:{ verified, how } }`, redacting `sk-…` and `xox[pbar]-…` tokens from stdout/stderr (`:25-28`), and `writeTelemetryEvidenceRecord` writes it as pretty JSON. It is evidence capture for Factory task runs, not metrics telemetry; there is no `/metrics` endpoint in Receipt (Resonate exposes Prometheus on its own port).

---

## 10. Architecture relationships (for a diagram)

```
Browser ──HTTP/WS──► service gateway (apps/start/scripts/service-gateway.ts)
   │                     ├─ "/"                  → web app (TanStack Start, Nitro)          [public]
   │                     ├─ "/zero/*"            → zero-cache                                [public]
   │                     ├─ "/connect/*"         → runtime, prefix kept                      [public]
   │                     ├─ "/receipt-debug/*"   → runtime (bearer-gated)                    [public]
   │                     ├─ "/runtime/*"         → runtime, prefix stripped                  [private/localhost]
   │                     ├─ "/integrations*"     → Nango (+ Connect UI)                      [public]
   │                     └─ "/slack/*", "/teams/*" → apps/slack, apps/teams                 [public]
   │
   ├─ Zero client (schema of 29 projection/app tables) ◄─websocket─ zero-cache ◄─logical replication (publication zero_data)─ Postgres
   │        └─ POST /api/zero/query, /api/zero/mutate, GET /api/zero/token  (web app, server-side auth)
   │
Web app ──fetch──► runtime: POST /agents/factory/jobs, POST /jobs/:id/abort, GET /jobs?status=, GET /receipt/stream (SSE proxy at /api/receipt-trail/events)
Web app ──sql────► Postgres tenant schema: app-chat receipts (apps/start/<repoKey>/app-chat/sessions/<threadId>), receipt-ingest appends (imports/clauden|claude-code/*), /sessions reads
Slack app (apps/slack/server.ts) ──► runtime POST /chat/route, POST /chat/respond (apps/slack/slack-chat-routing.ts:61,116), POST /agents/factory/jobs {lane:"chat", payload.kind:"factory.run", jobId:"slack_evt_<id>", sessionKey:"slack:<team>:<channel>:<thread>"} (server.ts:267-290), GET /jobs/:id (server.ts:1089)
Teams app (apps/teams/teams-routing.ts:30,67; teams-runtime.ts:28,138) ──► same four endpoints, jobId "teams_activity_<id>", profileId TEAMS_DEFAULT_PROFILE_ID ?? "receipt"
CLI / MCP clients ──► gateway /connect/* (JWT scopes connect:read|write|credential); MCP at POST /connect/mcp; device login at web /api/receipt-connect/cli-login; transcript import at web /api/receipt-ingest/receipts
Nango ──webhook (x-nango-hmac-sha256)──► runtime POST /connect/nango/webhook; runtime+workers ──► Nango for credentials
runtime api ──beginRpc──► Resonate ──task──► driver ──beginRpc──► worker-chat | worker-control | worker-codex   (workers long-poll Resonate via EventSource, resonate-poll-source.ts)
worker-codex ──► OpenSandbox controller (OPENSANDBOX_INTERNAL_URL / OPEN_SANDBOX_DOMAIN+PROTOCOL; host lifecycle via OPEN_SANDBOX_AUTO_START/AUTO_STOP, opensandbox-config-env-host.ts) ──► Codex CLI in sandbox
every role ──sql──► Postgres: receipt_receipts (append tx + advisory lock) → trigger → receipt_projection_work → projectors (api role pump + append callbacks) → projection tables → zero_data → browser
Resonate driver ──POST /receipt/callback──► runtime api (invalidation only)
```

Where receipts are written on each path:

* **Web chat**: app-chat session/run streams by the web server; objective/job streams by runtime workers once a Factory job is enqueued.
* **Slack/Teams**: only via the runtime — `/chat/route` and `/chat/respond` write nothing (routing and prose only); `POST /agents/factory/jobs` appends `job.enqueued` to `jobs` and `jobs/<jobId>`; Factory workers then write `factory/objectives/<id>` and `agents/factory/<repoKey>/receipt/...`.
* **CLI `receipt run`**: inline agent loop writes `agents/<agentId>/runs/<runId>` through the Postgres store directly (no HTTP).
* **CLI `receipt import|observe`**: appends `imports/claude-code/...` via the web app's ingest route using a `connect:write` token.
* **Eval**: `eval/runs/<runId>` and `computer_use/sessions/<sessionId>` directly through the store.
* **Memory**: `memory/<safe-scope>` via runtime `/memory/*`, CLI, or Factory packet writers.
* **Nango/Connect**: connection state receipts live under Receipt Connect streams owned by `receipt-connect-routes.ts` (out of scope here; see the Connect report).

---

## Changes since 41baea75

43 commits. `git log --oneline 41baea75..HEAD -- <path>` shows **zero** commits for `packages/receipt-core`, `packages/receipt-live`, `packages/receipt-durable`, `packages/receipt-dst`, `packages/receipt-app/src/sdk`, `packages/receipt-app/src/engine/runtime`, `packages/receipt-app/src/agents/factory/route`, `packages/receipt-app/src/cli/{commands,runtime,eval,clauden-import}.ts`, `packages/receipt-app/src/services/eval`, `packages/receipt-app/src/telemetry`, `apps/start/src/integrations/zero`, `apps/start/src/routes/api`, `apps/start/src/components/sessions`, `apps/start/src/lib/frontend/sessions`, `docs/api`, `docs/memory.md`, `docs/receipt-dst.md`, `docs/factory-self-improvement.md`, `docs/receipt-contract-standardization.md`, `docs/receipt-runtime-readme.md`. Everything in scope for this report that changed is in `packages/receipt-app/src/{db,adapters,server}` and two docs.

### The projection durability series (behavioural effect, in commit order)

All 15 commits respond to one incident, RCA-404 (`docs/agent-fix-checklist.md`, "Live app-chat progress replay saturated the Receipt Lite host", 2026-09-05): three overlapping objectives in one chat burst thousands of output/heartbeat receipts; every objective append synchronously rebuilt the app-chat mirror and scheduled both targeted and global chat projectors; projection latency exceeded 50 s and disk reads saturated the host.

| Commit | Behavioural effect |
|---|---|
| `6b79dc82` fix: bound live chat projection replay (#180) | Appends are classified by `receiptAppendProjectionSchedule`; chat appends run only the targeted session projector; objective progress mirroring is coalesced per objective at `RECEIPT_OBJECTIVE_PROGRESS_MIRROR_INTERVAL_MS` (1 s) with one trailing pass; stdout/stderr/heartbeat receipts no longer trigger objective replay. |
| `61751714` Simulate production projection replay storms (#181) | Adds `projection-replay-storm` to `receipt factory simulate` and the incident-correlation gate: three overlapping objectives, thousands of telemetry receipts, an append during an active mirror; must prove bounded mirrors and convergence. |
| `00ef6f17` fix: make projection work durable and reduce repeated replay | New `receipt_projection_work` outbox filled by an `AFTER INSERT` trigger on `receipt_receipts`; per-projector/per-stream `requested_seq`/`processed_seq` acknowledgement (never cross-stream ordering); failed streams stay pending with `eligible_at` backoff; new `receipt_reducer_checkpoints` so objective/job reducers fold only the `(stream, stream_seq)` delta; checked-in migration `20260905_durable_projection_work.sql`; Zero migration schema updated; `docs/projection-durability-fix.md` created. Legacy `receipt_projection_offsets` demoted to diagnostics. |
| `2010f1c7` fix: keep branch replay reads on the projection connection | Branch `get/list/children` now use the scoped query helper, fixing a one-connection-pool self-deadlock when `runtime.state()` read branch metadata during a projector transaction. |
| `8632713e` fix: order projection bootstrap and retry transient readiness failures | Shared core bootstrap completes before a serving connection is reserved; a rejected schema-readiness promise is cleared so a transient DB failure can recover on the same instance. |
| `ac50493f` fix: continuously drain durable projection work after restart | `createProjectionWorkPump`: the `api` role polls the pending-work predicate once per second after the previous round completes and runs one bounded batch per due projector, so restart/migration backlogs drain without waiting for a new append. |
| `71ffa060` fix: isolate projection capacity and skip published objective generations | `withProjectionConnectionPool` gives application-owned pools a separate single-connection projection pool with serialised admission; concurrent catch-up/read callers skip objective writes when an atomic checkpoint + matching head + serving row prove the generation is already published. |
| `bd26d484` fix: keep objective summary and watchdog reads independent of full state | Objective summary and watchdog reads no longer require a full objective state replay (touches `factory-service-core.ts`, `objective-watchdog-runner.ts`, sims). |
| `abe31bcc` fix: retain control maintenance ownership after slow deadlines | `createSingleFlightMaintenance`: a slow-deadline timer only *reports* slowness (`factory.control_outbox_redrive_slow`); ownership is retained until the operation settles so interval ticks cannot pile up duplicate DB work. |
| `888d1d9c` fix: bound command-heavy job replay and checkpoint serving generations | `reduceJobReceiptPage` appends consecutive `queue.command` receipts once per page instead of copying the command array per receipt (quadratic → linear), preserving the canonical reducer's invariant errors; serving generations are checkpointed. |
| `3c86b579` fix: preserve duplicate command semantics in projection batches | The paged job reducer keeps the exact duplicate-command behaviour of the canonical reducer. |
| `0a58ac52` fix: preserve retry capability scope and fence authorization churn | `/connect` tool routes return the distinguished 403 `receipt_connect_execution_scope_missing` vs 401 `receipt_connect_runtime_authentication_required` bodies (§2.4); objective compose continuation and supervisor failure circuit preserve capability scope on retry. |
| `8e4c429e` fix: bound optional recap loading and preserve recorded outcomes | Web chat "Smart recap" (`chat-receipts-dialog.tsx`) uses a 20 s `AbortSignal.timeout` with `maxRetries: 0`; on timeout the UI shows `"The AI recap took too long. Your recorded outcome remains available. You can try again."`; buttons `"Generate summary"` / `"Try again"`; loading text `"Preparing optional AI recap…"`. |
| `8c74802b` fix: keep idle worker polls connected and reduce projection overhead | `createResonatePollSource` (EventSource with `timeout: false`) keeps idle worker long-polls open; projector overhead reduced. |
| `d62e9136` fix: scope computer maintenance repairs to affected identities | Computer inventory refresh reconciles only affected computers and ages eligible rows in bounded batches instead of deleting/rebuilding the fleet; binding lookups no longer start a global chat repair. |

Net effect for a documentation author: (1) projections are now **durably scheduled** (trigger + outbox), acknowledged per generation, and drained by a pump — a crash before acknowledgement causes replay, not loss; (2) hot reducers are **incremental** with hash-anchored checkpoints and fall back to verified full replay on any mismatch or on branches; (3) projections run on a **dedicated connection** so request reads are not starved; (4) two new internal tables and several indexes exist and are excluded from Zero; (5) the documented boundaries remain: structural chat changes, new runs and late historical events still use canonical chat replay; branch materialisation is still full replay; no HA/archive/restore claims (`docs/projection-durability-fix.md:52-65`).

### Other in-scope changes

* `e6944514` fix: keep tool dependencies semantic and fence runtime failure retries — integration *inventory* is no longer promoted into required dependencies; permanent model-credential authentication errors stop supervisor retries; an audit whose objective head changed produces a superseded result; worker-owned OpenSandbox host auto-stop was removed (idle compute stays running until an operator stops it). Documented in the new `docs/tool-reliability-fixes-2026-09-05.md`.
* `c081ecbe` docs: record simulator evidence and authorized rollout exception — appends the rollout narrative to `docs/projection-durability-fix.md:81-122`.
* `48cdeca8` chore — `.gitignore` and code-review-graph documentation; no runtime effect.
* Commits touching Agent Registry, workspace invites, the public CLI onboarding (`3c52d87c`, `53f74bed`, `9b8b7574`, `a6a32fc7`, `21c2d6f0`, `c3c16be6`, `46652e84`, `ab7b00b0`, `b90c9070`, `a241a9b1`, `26ec975a`…`20d20f51`) are outside this report's scope (covered by the CLI and integrations reports) and did not alter the receipt model, runtime routes, Zero schema, SDK, or learning-loop code.

---

## Documentation implications

### What to claim

* **An append-only, hash-chained, verifiable event log** with a small, stable primitive (`Receipt`), canonical JSON hashing, `verify()`, fork-on-read branches, idempotent commands, and optimistic concurrency. All of it is in `packages/receipt-core` and can be quoted line by line.
* **Receipts are the only source of truth; every table is a typed projection** with a `stateRole` and a Zero publication mode, and projections are rebuildable and now durably scheduled. The `docs/projection-durability-fix.md` boundaries can be reused verbatim.
* **Durable execution with explicit fencing**: Resonate dispatch, lease/heartbeat, `invocationId` idempotency keys, at-least-once semantics spelled out in the SDK's own comments.
* **Real-time sync to the browser via Zero** with server-side auth context and a contract test that ties the client schema to the publication.
* **An operator learning loop inside Factory**: objective contracts, alignment gates, automatic post-run audits, recommendation-only self-improvement with an explicit operator apply step, deterministic simulation with a seed corpus, and a CLI eval harness.
* **Imported Claude Code sessions** get a readiness dashboard (token/coverage/compliance/lesson/sandbox checks) with bounded evidence views.

### What to avoid claiming

* Anything about **training datasets, labeling, annotation, fine-tuning, or retraining**. No code exists for it (§8.6).
* That `/sessions` **produces** lessons, skills, compliance findings, or token-waste reports. Its buttons navigate or do nothing (§8.1). Quote the card text as *guidance*, not as executed behaviour.
* That memory search is semantic or that `summarize` is an AI summary (§8.5) — unless `embed` is wired before publication.
* `agent-token`, `/factory/events`, `/factory/chat/events`, `/factory/background/events`, the extra `/healthz` fields, three lanes, `RECEIPT_POSTGRES_URL`, `JOB_BACKEND=local` — all stale in the checked-in docs (§2.6).
* That `receipt new` yields a runnable agent in a monorepo checkout (§7.5).
* Framework adapters (CrewAI/LangGraph/AutoGen): still absent (map §8; nothing changed).

### Marketing claims given for this report

| Claim | Status | Reason |
|---|---|---|
| "Automatically transform production conversations into high-quality training datasets for rapid model iteration." | **Unsupported** | No dataset export, no training-set format, no writer of JSONL/CSV/Parquet from conversations, no model-iteration hook (§8.6). Conversations are stored as receipts and projections for replay and audit, not as datasets. |
| "Extract and label production conversations automatically for instant model retraining." | **Unsupported** | No labeling model, no label store, no annotation UI, no retraining call. The only automatic "extraction" is the Claude Code transcript import into `import.object.normalized` receipts and SQL counts on `/sessions` (§8.1). |
| "Turn customer interactions into validated training data without manual annotation." | **Unsupported** | Nothing validates or annotates interactions as training data. `receipt eval` validates *agent runs against scenarios* with a BYOK semantic oracle (§8.3); DST validates *replay determinism* (§8.4). Neither yields training data. |
| "Close the feedback loop: production insights powering continuous AI model improvement." | **Partial** | A feedback loop exists, but it improves **Factory's contracts, prompts, memory and objective policy** through audits, recommendations, a deterministic policy-feedback report (`wait / lower_threshold / keep_threshold / raise_threshold / manual_review`), and operator-applied auto-fix objectives (§8.2). It never changes a *model*. "Continuous" is also overstated: recommendations are report-only until an operator applies them, and threshold feedback does not mutate policy (`docs/factory-self-improvement.md:197-211, 345-354`). A defensible phrasing is "production receipts feed post-run audits and recommendations that operators can turn into follow-up work." |

### Suggested page split

1. **Receipt model** — §1.1-1.7 (shape, hashing, verify, runtime semantics, branches, Postgres append). Quote error strings.
2. **Storage, projections and tenancy** — §1.8-1.11 plus the durability summary (trigger/outbox/checkpoints), `DATA_DIR`→schema, pool/search_path, stream families.
3. **Runtime HTTP API reference** — §2.2-2.6 (rewrite `docs/api/http.md` from this table; drop the stale fields and routes), with a short "diagnostics endpoints exist and are token-gated" note.
4. **Live events (SSE and WebSocket)** — §3 (replace `docs/api/sse.md`).
5. **Durable execution** — §4 with the "best-effort" boundary stated plainly.
6. **Sync (Zero)** — §5: what the browser sees, the publication rule, the three web endpoints, the missing-table failure mode.
7. **Web app API** — §6 table.
8. **SDK reference** — §7 (with a warning box on `receipt new` until fixed).
9. **Observability** — §9.
10. **Architecture overview** — §10 diagram.
11. **Learning loop (honest)** — §8.1-8.5: what Sessions, Factory self-improvement, eval, DST corpus and memory actually do, plus an explicit "not a training-data product" statement.

---

## Open questions

1. **Is `receipt new` meant to be fixed or removed?** At HEAD it writes an import (`../sdk/index`) that cannot resolve from the repo root (§7.5). Either the scaffold should target `packages/receipt-app/src/agents/` (which would also make the remote-action loader find it) or the repo-root `src/` tree should be created. `docs/create-agent.md:43` and `docs/api/cli.md:201` currently describe the broken layout as intended.
2. **Should memory embeddings be wired before docs claim semantic search?** `createMemoryTools` accepts `embed` but no caller passes it (§8.5). `docs/memory.md:173-175` and the `receipt_memory_embeddings` table imply a feature that is dormant.
3. **Do the `/sessions` action buttons have a planned backend?** The card copy describes compliance scans, token-waste analysis, lesson drafting and sandboxed review as if they exist. If they are roadmap, the copy should say so; if they are being built, the report's classification should be revisited then.
4. **Is the "training data" positioning intended for a product that does not yet exist in this repo?** Nothing in `apps/`, `packages/`, `docs/` mentions fine-tuning, datasets or labeling. If another repository holds that work, this report cannot see it.
5. **Should the memory routes return 400 instead of 500 on a missing actor context?** `actorAuditFromBody` throws through the generic handler (§2.3); `/chat/route` and `/chat/respond` already return a clean `400 actor_context_required`.
6. **Should `receipt_projection_offsets` be retired?** It is still written from 11 sites but is documented as diagnostic only (§1.9).
7. **Are `docs/api/*.md` going to be regenerated or deleted?** Every discrepancy the map found at `41baea75` is still present at HEAD (§2.6); none of those files changed in 43 commits.
8. **What are the intended public names for the Postgres tables?** `docs/memory.md` uses unprefixed names; the schema uses `receipt_` everywhere.
9. **Is the `factory.dispatch` routing ambiguity (agent-id-first vs kind contract `workerGroup: "control"`) resolved or documented?** `resonate-config.ts` is unchanged since the map flagged it.
10. **Should the runtime adopt request ids?** The web app has them; the runtime does not (§2.2, §9), which makes cross-service tracing of a Slack or Teams request depend on `jobId` alone.
