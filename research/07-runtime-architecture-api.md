# Receipt Runtime Architecture, Receipt/Event Model, Durable Execution, HTTP/SSE APIs, SDK, and Agent Framework

Research report for the public Receipt documentation site.
Repo researched: `<receipt-repo>` (branch `main`, commit `add21f9`).
Every claim below was checked against the implementation. Where the checked-in Markdown disagrees with the
code, the code wins and the disagreement is called out.

**Reading rule used throughout:** implementation > config/schema/types > existing Markdown > tests.

---

## 0. TL;DR for a docs writer

* Receipt is a Bun + Turborepo monorepo. The **runtime** is one Bun/Hono process image
  (`packages/receipt-app/src/server.ts`) that is started **five different ways** by setting
  `RECEIPT_PROCESS_ROLE`. Only the `api` role binds an HTTP port. Everything else is a Resonate worker
  that opens no socket.
* The durable store is **Postgres**. There is no SQLite receipt store and no local job backend in the
  server any more. The connection string comes from **`ZERO_UPSTREAM_DB`** (not `RECEIPT_POSTGRES_URL`).
* `DATA_DIR` is no longer "where receipts live"; it is a **tenant key**. It is hashed into a Postgres
  schema name `receipt_data_<sha256[0:24]>` unless `RECEIPT_POSTGRES_SCHEMA` is set explicitly.
* The Factory web shell moved from **SSE `EventSource` to a WebSocket** at `GET /factory/live`. The old
  `/factory/events`, `/factory/chat/events`, `/factory/background/events` endpoints **no longer exist**.
  SSE is still used for `GET /receipt/stream` and `GET /jobs/:id/events`.
* `docs/api/http.md`, `docs/api/sse.md` and `docs/api/config.md` are all materially out of date. Section 14
  lists every disagreement.

---

## 1. Component and process map

### 1.1 The one runtime image, five roles

`packages/receipt-app/src/server.ts:1` is a single line: `import "./server/bootstrap";`. All runtime
behavior lives in `packages/receipt-app/src/server/bootstrap.ts` (3824 lines).

Role selection: `packages/receipt-app/src/server/config.ts:68-70` reads `RECEIPT_PROCESS_ROLE` and passes it
through `resolveProcessRole` (`packages/receipt-app/src/adapters/resonate-config.ts:26-35`). Unknown or
missing values map to `"all"`, but `resolveServerConfig` defaults to `"api"` when the env var is absent
(`server/config.ts:69-70`).

The role union is declared at `packages/receipt-app/src/adapters/resonate-config.ts:5-12`:

| Role | Binds HTTP? | Runs heartbeats? | Resonate function it registers | Default concurrency |
|---|---|---|---|---|
| `api` | yes (`PORT`, default 8787) | yes | none (client only, used to start driver RPCs) | 1 |
| `driver` | no | no | `receipt.job.driver` | 1 |
| `worker-chat` | no | no | `receipt.job.execute` + `receipt.agent.action.execute` | 4 (`CHAT_JOB_CONCURRENCY`) |
| `worker-control` | no | no | `receipt.job.execute` + Factory objective watchdog worker | 1 (`ORCHESTRATION_JOB_CONCURRENCY`) |
| `worker-codex` | no | no | `receipt.job.execute` | 1 (`CODEX_JOB_CONCURRENCY`) |
| `all` | no | no | falls back to the `api` group; registers nothing | 1 |

Evidence:
* HTTP/heartbeat gating: `server/config.ts:34-45` (`deriveServerRuntimeFlags` — `shouldServeHttp` and
  `shouldRunHeartbeats` are both `processRole === "api"`), applied at `bootstrap.ts:3752-3782`.
* Function registration per role: `adapters/resonate-runtime.ts:802-871` (`createResonateRoleRuntime`).
  `driver` registers `RESONATE_DRIVER_FUNCTION`; the three worker roles register
  `RESONATE_EXECUTE_FUNCTION`; `worker-control` additionally calls
  `registerResonateFactoryObjectiveWatchdogWorker`.
* `worker-chat` additionally registers the remote-agent-action worker: `bootstrap.ts:1917-1922` plus
  `engine/runtime/resonate-agent-actions.ts:254-260`.
* Concurrency: `adapters/resonate-runtime.ts:95-106`. A single `RECEIPT_RESONATE_EXECUTE_CONCURRENCY`
  overrides all roles.
* Function names: `adapters/resonate-config.ts:13-15` — `receipt.job.driver`, `receipt.job.execute`,
  `receipt.factory.objective_watchdog.enqueue`.
* Resonate task groups (`adapters/resonate-config.ts:49-62`): `receipt-api`, `receipt-driver`,
  `receipt-chat`, `receipt-control`, `receipt-codex`, overridable with `RESONATE_GROUP_API`,
  `RESONATE_GROUP_DRIVER`, `RESONATE_GROUP_CHAT`, `RESONATE_GROUP_CONTROL`, `RESONATE_GROUP_CODEX`.
* A non-API role parks forever instead of exiting: `bootstrap.ts:3822-3824`
  (`if (!httpServer) await new Promise<void>(() => {})`).

### 1.2 Local process supervisor

`scripts/start-resonate-runtime.mjs` is the supervisor that fans the single image out into role processes.

* Default fan-out (`scripts/start-resonate-runtime.mjs:74-97`, `resolveRuntimeRoles`):
  `worker-control` ×1 (`CONTROL_WORKER_PROCESSES`), `worker-chat` ×2 (`CHAT_WORKER_PROCESSES`),
  `worker-codex` ×1 (`CODEX_WORKER_PROCESSES`, else `OPEN_SANDBOX_GLOBAL_MAX_ACTIVE` /
  `OPEN_SANDBOX_ORG_MAX_ACTIVE`, else 1), `driver` ×1, `api` ×1.
* If `RECEIPT_PROCESS_ROLE` is already a known role, only that role is started, but its process count is
  still honored (lines 84-98). That is how a hosted single-role service scales pollers.
* It also starts a **local Resonate server** unless `RESONATE_START_SERVER=0` or `RESONATE_URL` points
  somewhere non-loopback (`scripts/start-resonate-runtime.mjs:40-53`). The Resonate server is invoked as
  `serve --api-http-addr <bind>:<port> --metrics-addr <bind>:<metricsPort> --aio-store-sqlite-enable
  --aio-store-sqlite-path <dataDir>/resonate/resonate.db`, with a legacy flag set for old
  `resonate-server` binaries (`scripts/start-resonate-runtime.mjs:180-232`).
* It requires Resonate CLI **>= 0.9.7** (`isCompatibleResonateVersion`, lines 236-243, error message at
  lines 253-255).
* Per-child env it injects (lines 293-311): `RESONATE_URL`, `RECEIPT_RESONATE_CALLBACK_URL` and
  `RECEIPT_EVENT_CALLBACK_URL` (both `http://127.0.0.1:<receiptPort>/receipt/callback`),
  `RECEIPT_PROCESS_ROLE`, `RECEIPT_PROCESS_INSTANCE`, `JOB_WORKER_ID`, `RECEIPT_POSTGRES_POOL_MAX`,
  `RECEIPT_POSTGRES_APPLICATION_NAME` (`receipt-<role>-<instance>`), and `RECEIPT_CODEX_BIN` when a Codex
  binary is found.
* `JOB_WORKER_ID` default is `worker_<role>_<instance>_<host>` (lines 105-113), **not** `worker_<pid>`.
* `RECEIPT_SERVER_WATCH` controls which roles run `bun --watch` (lines 115-140). `scripts/start-resonate-dev.mjs`
  sets it to `api` by default.
* Crash-restart backoff: `restartDelayMsForAttempt` doubles from 1s to a 30s cap (line 271).

### 1.3 The full local stack (`bun run start:all`)

`scripts/start-all.mjs:58-118` (`runtimeOptions`) is the authoritative port map for local development:

| Service | Default port | Env override | Notes |
|---|---|---|---|
| Receipt service gateway (public) | **3000** | `START_ALL_GATEWAY_PORT` / `START_ALL_WEB_PORT` | `apps/start/scripts/service-gateway.ts` |
| Web app (internal, behind gateway) | **3001** | `START_ALL_WEB_INTERNAL_PORT` | TanStack Start server |
| zero-cache | **4848** | `START_ALL_ZERO_CACHE_PORT` | port+1 is also reserved (`start-all.mjs:132-133`) |
| Receipt runtime API | **8787** | `START_ALL_RECEIPT_PORT` / `PORT` | Hono, role `api` |
| Resonate HTTP | **8001** | `START_ALL_RESONATE_PORT` / `RESONATE_PORT` | |
| Resonate metrics | **9090** | `START_ALL_RESONATE_METRICS_PORT` / `RESONATE_METRICS_PORT` | Prometheus scrape target |
| OpenSandbox ("computer") | **8080** | `START_ALL_OPENSANDBOX_PORT` | started only when the computer provider is `opensandbox` and the domain is loopback |
| Nango (integrations provider) | **3003** | `START_ALL_INTEGRATIONS_PORT` | Docker, `docker-compose.local.yml` |
| Nango Connect UI | **3009** | `START_ALL_INTEGRATIONS_CONNECT_PORT` | Docker |
| Slack adapter app | **3010** | `START_ALL_SLACK_PORT` | `apps/slack` |
| Teams adapter app | **3011** | `START_ALL_TEAMS_PORT` | `apps/teams` |
| Redis | **6380** on host | `START_ALL_REDIS_PORT` | Docker; container listens on 6379 |
| Postgres | from `ZERO_UPSTREAM_DB` | — | Docker via `docker-compose.postgres.yml` |

Readiness gates (`start-all.mjs:611-615`):
`http://<host>:8787/healthz`, `http://<host>:4848/`, and `http://<host>:3000/health`.

The "ready" summary it prints (`start-all.mjs:618-632`) advertises: gateway root, `/zero/`, `/runtime/`,
`/connect/`, `/integrations/`, `/teams/`.

**Qdrant and Redis are not part of the Receipt runtime plane.** Qdrant is only referenced by the web app's
attachment embedding path (`apps/start/src/lib/backend/chat/infra/vector-db.ts:50`, `QDRANT_URL`), and Redis
is used by the web app's stream-resume layer (`REDIS_URL`) and by Nango. Neither is read by
`packages/receipt-app`.

### 1.4 Service gateway and route prefixes

The gateway is a Bun server implemented in `apps/start/scripts/service-gateway.ts`. Its routing table comes
from a declarative service graph in `packages/receipt-core/src/service-graph.ts:78-183`
(`createReceiptServiceGraph`).

| Service | Route prefix | Default internal URL | Exposure | Health check | Strips prefix? |
|---|---|---|---|---|---|
| `web` | `/` | `http://127.0.0.1:3001` | public | `/health` | no |
| `runtime` | `/runtime` | `http://127.0.0.1:8787` | **private** | `/healthz` | yes |
| `connect` | `/connect` | `http://127.0.0.1:8787` | public | `/readyz` | **no** |
| `zero` | `/zero` | `http://127.0.0.1:4848` | public | `/` | yes |
| `integrations` | `/integrations` | `http://127.0.0.1:3003` | public | `/health` | yes |
| `integrations-connect` | `/integrations-connect` | `http://127.0.0.1:3009` | public | `/` | yes |
| `slack` | `/slack` | `http://127.0.0.1:3010` | public | `/health` | yes |
| `teams` | `/teams` | `http://127.0.0.1:3011` | public | `/health` | yes |
| `resonate` | `/resonate` | `http://127.0.0.1:8001` | **private** | `/health` | yes |
| `computer` | `/computer` | `http://127.0.0.1:8080` | **private** | `/health` | yes |

Semantics that matter for docs:

* Longest-prefix match wins, and `/` (web) is always last (`service-graph.ts:196-212`,
  `receiptServiceGraphNodes` / `findReceiptServiceForPath`). `/runtime-extra/health` therefore falls through
  to the web app, and `/integrations-connectivity` does **not** match `/integrations`.
* `stripRoutePrefix` rewrites `/runtime/healthz` → `/healthz` on the upstream
  (`service-graph.ts:227-245`, `buildInternalServiceUrl`). `connect` deliberately does **not** strip, so
  `/connect/...` reaches the runtime with its `/connect/...` path intact — which matches the runtime's own
  `app.post("/connect/...")` routes.
* `private` services return a bare `404 Not found` (plain text, `Cache-Control: no-store`) unless the
  request came from localhost, or `RECEIPT_SERVICE_GATEWAY_EXPOSURE=private`, or
  `RECEIPT_SERVICE_GATEWAY_ALLOW_PRIVATE=1` (`service-gateway.ts:208-222, 1029-1041`).
* `/receipt-debug/*` is an explicit exception: it is proxied to the runtime from the public gateway
  (`service-gateway.ts:66-68, 1009-1021`) because it carries its own bearer-token auth.
* Nango's browser bundle rewrites the path on its configured `apiURL`, so root paths such as
  `/connect/session` are special-cased to the integrations provider before the service graph is consulted
  (`service-gateway.ts:44-56, 977-1007`). Receipt's own `/connect/*` runtime API is unaffected.
* The gateway also proxies WebSocket upgrades for every service (`service-gateway.ts:1042-1049`), which is
  what makes `/runtime/factory/live` work.
* Internal URLs are overridable at `service-gateway.ts:164-195` via `RECEIPT_WEB_INTERNAL_URL`,
  `RECEIPT_RUNTIME_INTERNAL_URL` (and several fallbacks), `RECEIPT_ZERO_INTERNAL_URL`,
  `RECEIPT_INTEGRATIONS_INTERNAL_URL`, `RECEIPT_INTEGRATIONS_CONNECT_INTERNAL_URL`, and so on.

**Prefix collision worth documenting:** the runtime itself registers an HTML dashboard at `GET /runtime`
(`packages/receipt-app/src/agents/factory/route/register-runtime-routes.ts:23`). Through the gateway that
page is at `/runtime/runtime`, because `/runtime` is the gateway prefix that gets stripped. A bare
`GET <gateway>/runtime` maps to `GET <runtime>/` which has no route and returns the runtime's
`404 Not found` (`bootstrap.ts:3716`).

### 1.5 Who talks to whom

```
browser ──► service gateway :3000
              ├─ "/"                      → web app :3001 (TanStack Start)
              ├─ "/zero/*"                → zero-cache :4848 ──► Postgres (logical replication)
              ├─ "/integrations*"         → Nango :3003 / :3009
              ├─ "/slack/*", "/teams/*"   → apps/slack :3010, apps/teams :3011
              ├─ "/connect/*"             → runtime :8787   (public)
              ├─ "/receipt-debug/*"       → runtime :8787   (token-gated)
              └─ "/runtime/*"             → runtime :8787   (private/localhost only)

web app :3001 ──fetch──► runtime :8787   POST /agents/factory/jobs, POST /jobs/:id/abort,
                                          GET /jobs?status=..., GET /receipt/stream
                (apps/start/src/lib/frontend/tasks/objective-control.server.ts:124,174,211;
                 apps/start/src/lib/frontend/tasks/beetle-task.server.ts:169;
                 apps/start/src/routes/api/receipt-trail/events/route.tsx:31)

runtime api :8787 ──beginRpc──► Resonate :8001 ──task──► driver process
driver process    ──beginRpc──► Resonate :8001 ──task──► worker-chat / worker-control / worker-codex
every role        ──sql──────► Postgres (receipt streams, projections, durable tables)
worker-codex      ──http─────► OpenSandbox :8080 (computer execution)
runtime + workers ──http─────► Nango :3003 (Receipt Connect credentials)
resonate          ──sqlite or postgres──► its own store (RESONATE_POSTGRES_URL in prod)
```

The Resonate driver posts a JSON callback to `RECEIPT_RESONATE_CALLBACK_URL` /
`RECEIPT_EVENT_CALLBACK_URL` (default `http://127.0.0.1:8787/receipt/callback`) on each of
`dispatched | completed | failed | canceled`, with a 5s timeout and optional
`Authorization: Bearer $RECEIPT_CALLBACK_TOKEN` (`adapters/resonate-runtime.ts:231-268`).

---

## 2. The receipt / event model

### 2.1 Primitives (`@receipt/core`)

`packages/receipt-core/package.json` exports `./runtime`, `./chain`, `./execution`, `./graph`,
`./chat-media`, `./slack`, `./teams`, `./service-graph`, `./structured-logger`, `./types`.

A receipt (`packages/receipt-core/src/types.ts:32-41`):

```ts
type Receipt<Body = unknown> = {
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

Two fields are frequently confused and should be documented explicitly:

* **`context`** (`types.ts:19-30`) is *authoritative receipt scope*: `actor`, `tenantId`,
  `organizationId`, `objectiveId`, `taskId`, `jobId`, `runId`, `branch`, plus open extra keys. It **is**
  hashed.
* **`hints`** are transport metadata for indexes, tracing, and idempotency. They are **not** hashed
  (`chain.ts:20-29`).

### 2.2 Hash chaining

`packages/receipt-core/src/chain.ts:21-29`:

```ts
computeHash(r) = sha256(canonicalize({
  id, ts, stream, prev: r.prev ?? null, body,
  ...(context === undefined ? {} : { context }),
}))
```

`canonicalize` is `canonicalJson` with `errorPrefix: "receipt canonicalization"`
(`chain.ts:17-18` → `canonical-json.ts:14-79`). Canonical JSON:

* sorts object keys with `localeCompare`,
* rejects `undefined`, `bigint`, `function`, `symbol`, non-finite numbers, circular structures, and
  non-plain objects (error messages such as `"receipt canonicalization cannot serialize undefined"`,
  `"receipt canonicalization requires finite numbers"`),
* honors `toJSON()`.

Receipt ids are `` `${ts.toString(36)}-${8 random bytes hex}` `` (`chain.ts:45`). The random source is
overridable through the global symbol `Symbol.for("receipt.core.randomBytesSource")` (`chain.ts:33-42`) —
this is how deterministic simulation makes receipt ids replayable.

`verify(chain)` (`chain.ts:91-103`) walks the chain and returns
`{ ok: true, count, head? }` or `{ ok: false, at, reason }` where `reason` is `"broken prev"` or
`"hash mismatch"`.

### 2.3 Folds, views, and the runtime

`fold(chain, reducer, initial)` is the plain catamorphism (`chain.ts:75-81`).

`createRuntime(store, branchStore, decide, reducer, initial)`
(`packages/receipt-core/src/runtime.ts:88`) returns a `Runtime` (`runtime.ts:29-66`) with:

`execute`, `state`, `stateAt`, `chain`, `head?`, `chainAt`, `verify`, `fork`, `branch`, `branches`,
`children`, `listStreams`.

Behavior worth documenting:

* **Per-stream serialization.** `execute` takes an in-process stream lock (`runtime.ts:129-158`).
* **Snapshot cache with incremental fold.** `loadSnapshot` caches the chain + state per stream and only
  folds the suffix when the cached tail hash still matches (`runtime.ts:228-286`). The cache is
  invalidated by `store.version(stream)` (implemented in Postgres as the stream head hash).
* **Replay refuses corrupt chains.** `assertVerifiedChain` throws
  `Receipt runtime refused to replay invalid chain for stream '<stream>': <reason> at index <n>`
  (`runtime.ts:119-127`).
* **Idempotent event ids.** If a command carries `eventId`, the runtime writes hints
  `{ eventId }` (or `` `${eventId}#${i}` `` for a multi-event command) and skips the whole command when all
  of those hints already exist in the chain (`runtime.ts:307-334, 352-360`).
* **Expected-previous guard.** If a command carries `expectedPrev` and it does not equal the head hash, the
  runtime throws `Expected prev hash <x> but head is <y>` (`runtime.ts:362-365`).
* **`createScopedRuntime(runtime, context)`** (`runtime.ts:72-81`) binds a default
  `ReceiptExecutionContext` to every `execute`.

### 2.4 Branches (fork / rebase-on-read)

* `Branch = { name, parent?, forkAt?, createdAt }` (`types.ts:47-52`).
* `fork(stream, at, newName)` (`runtime.ts:401-437`) saves branch metadata only. It **copies no receipts**.
  It refuses when `at > parentChain.length`, when the branch name already exists, or when the target stream
  already has receipts (error strings: `Cannot fork <stream> at <n>; valid range is 0..<len>`,
  `Branch '<name>' already exists`, `Stream '<name>' already has receipts`).
* Reads *materialize* the branch: `materializeChain` (`runtime.ts:196-226`) loads the parent prefix
  `[0, forkAt)`, then **re-links and re-hashes** the branch's local receipts on top of it
  (`relinkLocalChain`, `runtime.ts:160-183`). Branch cycles throw
  `Branch cycle detected for stream '<stream>'`.
* Branch metadata is stored as receipts on the stream `__meta/branches` with event type
  `branch.meta.upsert` (`packages/receipt-app/src/adapters/postgres.ts:16-17`), and mirrored into the
  `receipt_branches` table.
* The CLI's default branch name is `` `${stream}/branches/fork_${Date.now().toString(36)}_${at}` ``
  (`packages/receipt-app/src/cli/commands.ts:456-457`), overridable with `--name`.

### 2.5 Stream families (verified names)

| Family | Pattern | Source |
|---|---|---|
| Queue index | `jobs` | `services/runtime-contracts.ts:18`, `bootstrap` uses `jobStream: "jobs"` (`server/config.ts:85`) |
| Job lifecycle | `jobs/<jobId>` | `services/runtime-contracts.ts:25-26` (`receiptJobStream`) |
| Factory objective | `factory/objectives/<objectiveId>` | `services/runtime-contracts.ts:19,34-35` |
| Factory objective step ref | `factory/objectives/<objectiveId>/steps/<taskId>` | `services/runtime-contracts.ts:67-70` |
| Memory | `memory/<safe-scope>` | `services/runtime-contracts.ts:20,74-77` |
| Eval run | `eval/runs/<runId>` | `services/runtime-contracts.ts:22,89-90` and `services/eval/receipts.ts:24-25` |
| Computer-use session | `computer_use/sessions/<sessionId>` | `services/runtime-contracts.ts:23,98-99` |
| Factory chat profile | `agents/factory/<repoKey>/receipt` | `services/factory-chat-profiles.ts:436-437` |
| Factory chat session | `agents/factory/<repoKey>/receipt/sessions/<chatId>` | `services/factory-chat-profiles.ts:442-443` |
| Factory chat objective | `agents/factory/<repoKey>/receipt/objectives/<objectiveId>` | `services/factory-chat-profiles.ts:439-440` |
| App chat session | `apps/start/<repoKey>/app-chat/sessions/<threadId>` | `apps/start/src/lib/backend/receipt/chat-bridge.ts:102-103` |
| Run stream (generic) | `<base>/runs/<runId>` | `engine/runtime/workflow.ts:19-20` (`runStream`) |
| Sub-run stream | `<runStream>/sub/<subRunId>` | matched at `agents/factory/shared.ts:82`, `agents/factory/live-jobs.ts:300` |
| Branch stream (CLI default) | `<stream>/branches/fork_<b36ts>_<at>` | `cli/commands.ts:456-457` |
| Branch metadata | `__meta/branches` | `adapters/postgres.ts:16` |

Naming details a writer will otherwise get wrong:

* `repoKey` is `RECEIPT_REPO_KEY` **only when the resolved repo root is one of the configured repo-key
  roots**; otherwise it is `sha256(resolvedRepoRoot)[0:12]`
  (`services/factory-chat-profiles.ts:427-434`). The repo's own wrapper sets
  `RECEIPT_REPO_KEY=receiptfactory` (`.receipt/bin/receipt`).
* There is exactly one canonical Factory chat profile id: `"receipt"`
  (`services/factory-chat-profiles.ts:17`, `CANONICAL_FACTORY_PROFILE_ID`). The factory profile stream
  ignores the requested profile id and always uses that constant (line 436-437).
* Memory scope → stream normalization is
  `(scope || "default").toLowerCase().replace(/[^a-z0-9_.-/]/g, "_")`
  (`services/runtime-contracts.ts:72-73`). Note the character class also matches `/`, so nested scopes
  survive. The original scope string is preserved on each memory entry.
* `parseReceiptMemoryStream` URI-decodes the suffix (`runtime-contracts.ts:79-87`) even though
  `receiptMemoryStream` never encodes — a mild asymmetry; treat the safe-scope form as canonical.

### 2.6 Projections

Receipts are the truth; Postgres tables are rebuildable projections
(`packages/receipt-app/src/db/schema.ts`). Core storage tables:

* `receipt_streams` — `name` (PK), `head_hash`, `receipt_count`, `updated_at`, `last_ts` (`schema.ts:22-30`).
* `receipt_receipts` — `global_seq` (bigserial PK), `stream`, `stream_seq`, `receipt_id`, `ts`, `prev_hash`,
  `hash`, `event_type`, `body_json`, `hints_json`, with unique indexes on `(stream, stream_seq)`,
  `(stream, hash)`, `(stream, receipt_id)` and a global unique index on `hash` (`schema.ts:32-51`).
* `receipt_branches` — `name` (PK), `parent`, `fork_at`, `created_at` (`schema.ts:53-60`).
* `receipt_projection_offsets` — `projector` (PK), `last_global_seq`, `updated_at` (`schema.ts:62-66`).
* `receipt_change_log` — `seq`, `global_seq`, `stream`, `event_type`, `changed_at` (`schema.ts:68-79`);
  projectors tail this.

Derived projections (all prefixed `receipt_`): `entity_projection`, `org_skill_projection`,
`org_skill_bundle_projection`, `org_guardrail_group_projection`, `org_policy_rule_projection`,
`job_projection`, `job_pending_commands`, `objective_projection`, `task_projection`,
`factory_action_projection`, `factory_wait_projection`, `factory_handoff_projection`,
`chat_context_projection`, `chat_history_projection`, `session_messages`, `session_recap_projection`,
`memory_entries`, `memory_accesses`, `memory_embeddings`, `durable_workflow`, `durable_signal`,
`durable_activity`, `durable_activity_attempt`, `eval_run_projection`,
`computer_use_session_projection`, `computer_session_projection`, `computer_inventory_projection`,
`computer_lease_projection`, `computer_run_projection`, `computer_live_output_projection`
(`schema.ts:81-943`).

**Note for `docs/memory.md`:** it names the tables `memory_entries` / `memory_accesses` /
`memory_embeddings`; the actual table names carry the `receipt_` prefix
(`schema.ts:628, 642, 664`).

### 2.7 Tenancy: `DATA_DIR` is a Postgres schema key

This is the single most surprising fact in the storage layer.

* `postgresReceiptStore(dataDir)` accepts a string; `normalizeStoreInput` turns it into
  `{ schema: resolveReceiptPostgresSchemaForDataDir(dataDir) }` (`adapters/postgres.ts:361-367`).
* `resolveReceiptPostgresSchemaForDataDir` (`db/client.ts:216-230`) returns `undefined` when
  `RECEIPT_POSTGRES_SCHEMA` is set, otherwise
  `` `receipt_data_${sha256(path.resolve(dataDir)).slice(0,24)}` ``.
* Connection string: `resolveReceiptPostgresUrl` → `resolveReceiptDatabaseUrl`, which reads **only**
  `ZERO_UPSTREAM_DB` and throws `Receipt Postgres storage requires ZERO_UPSTREAM_DB.` when unset
  (`db/client.ts:72-74`, `config/runtime-env.ts:1, 20-26`).
* Every pool sets `-c search_path="<schema>"` explicitly, including `public`
  (`db/client.ts:76-94`), so a role default cannot silently redirect unqualified queries.
* Pool size default is 2, overridable via `RECEIPT_POSTGRES_POOL_MAX` (`db/client.ts:232-235`).

Tenant directory layout (`packages/receipt-app/src/server/tenant-context.ts:83-125`):

```
<RECEIPT_TENANT_ROOT or <repoRoot>/.receipt/tenants>/<sanitized-org-label>-<sha256("receipt-org:"+orgId)[0:16]>/
  receipt/     -> DATA_DIR for that org  (=> its own Postgres schema)
  repos/
  worktrees/
  artifacts/
```

`ensureReceiptTenantDirectories` is idempotent (`tenant-context.ts:128-140`). The web app resolves the
same context in `apps/start/src/lib/backend/receipt/tenant-runtime.ts`.

---

## 3. Job queue

### 3.1 Vocabulary (verified against `packages/receipt-app/src/modules/job.ts`)

```ts
type QueueCommandLane = "steer" | "follow_up";                                  // :7
type JobLane          = "chat" | "collect" | "steer" | "follow_up";             // :8
type JobStatus        = "queued" | "leased" | "running"
                      | "completed" | "failed" | "canceled";                    // :9
type QueueCommandType = "steer" | "follow_up" | "abort";                        // :10
type SingletonMode    = "allow" | "cancel" | "steer";                           // :20, :110
```

**`chat` is a real lane and every doc that lists three lanes is wrong.** `POST /agents/:id/jobs` accepts all
four (`bootstrap.ts:2533-2540`), the receipt-queue default is `collect`
(`adapters/receipt-queue.ts:1403`), and `.receipt/config.json` schedules may use `lane: "chat"`
(`docs/api/config.md` example is correct here).

### 3.2 Lifecycle receipts

`JobEvent` union (`modules/job.ts:13-87`):

`job.enqueued`, `job.leased`, `job.heartbeat`, **`job.progress`**, `job.completed`, `job.failed`,
`job.canceled`, `queue.command`, `queue.command.consumed`, `job.lease_expired`.

`job.progress` is missing from `architecture.md` and `docs/api/streams.md`.

Reducer invariants that matter:
* `job.leased` is ignored unless the job is `queued` (`modules/job.ts:181-183`).
* `job.heartbeat` promotes `leased` → `running`, and only applies when
  `matchesActiveLease(prev, workerId, attempt)` holds (`modules/job.ts:135-148, 190-204`).
* A missing job for a non-`job.enqueued` event throws
  `Invariant: no job <jobId> for <type>`.

### 3.3 Singleton semantics

`receiptQueue.enqueue` (`adapters/receipt-queue.ts:1358-1428`):

* `singletonMode` defaults to `"allow"`.
* `cancel` and `steer` force an index reload plus discovery sync before the write (lines 1359-1363).
* An explicit `jobId` that already exists **returns the existing job unchanged** (line 1370-1371) — that is
  the enqueue-idempotency contract callers rely on.
* With a `sessionKey` and `mode: "cancel"`, every *active* job on that session key gets an abort command
  (`requestAbort(prior, "singleton cancel", changed)`, line 1384-1387).
* With `mode: "steer"`, the most recent active job on the session key receives a `queue.command` of type
  `steer` carrying `{ ...input.payload, fromSessionKey, fromEnqueue: true }`, and **the existing job is
  returned instead of creating a new one** (lines 1388-1397).
* Lease expiry is evaluated before the session scan so a dead worker's `running` job cannot swallow the
  steer (comment at lines 1375-1381).
* `maxAttempts` is clamped to `[1, 8]` (line 1407).

### 3.4 Job payload kinds and their routing contract

`services/runtime-contracts.ts:111-121` (`ReceiptJobKindSchema`) enumerates nine kinds:

`factory.dispatch`, `factory.run`, `factory.integration.publish`, `factory.integration.validate`,
`factory.objective.audit`, `factory.objective.control`, `factory.objective.watchdog`,
`factory.task.monitor`, `factory.task.run`.

Every payload except `factory.objective.watchdog` requires an `authContext`
(`{ userId, organizationId, workspaceId?, receiptConnectGatewayUrl?, sessionId?, source? }`,
`runtime-contracts.ts:143-150, 176-235`).

`RECEIPT_JOB_KIND_CONTRACTS` (`runtime-contracts.ts:268+`) declares, per kind: `workerGroup`
(`chat` | `codex` | `control`), optional `durableWorkflow` (`objective-control` | `run`),
`hasDurableActivity`, `objectiveScoped`, `reconcileObjectiveOnTerminalOrExpiredLease`, `liveExecution`,
`terminalObjectiveAudit`.

Actual Resonate routing is decided by `resolveWorkerTarget` (`adapters/resonate-config.ts:89-99`) and is
**agent-id first, kind second**:

```
job.agentId === "codex"                     -> receipt-codex
job.payload.kind startsWith "factory.integration."  -> receipt-codex
job.agentId === "factory-control"           -> receipt-control
otherwise                                   -> receipt-chat
```

So a `factory.dispatch` job (agentId `factory`) lands on the **chat** group even though its kind contract
says `workerGroup: "control"`. Flag this as an ambiguity rather than asserting either is "the" contract.

### 3.5 Registered job handlers

`bootstrap.ts:1756-1759`:

```ts
const jobHandlers = {
  factory: factoryJobHandler,   // routes factory.dispatch -> dispatch handler, else run handler (:1752-1755)
  ...factoryWorkerHandlers,
} satisfies Record<string, JobHandler>;
```

`createFactoryWorkerHandlers` (`services/factory-runtime.ts:1510-1515`) supplies exactly three more keys:
`factory-control`, `factory-monitor`, `codex`
(constants at `services/factory/runtime/factory-service-config.ts:4-5`).

**Total registered agent ids: `factory`, `factory-control`, `factory-monitor`, `codex`.** Posting to
`/agents/<anything-else>/jobs` still returns `202` and appends `job.enqueued`, but nothing will ever
execute it — this is called out correctly in `docs/agent-framework-integrations.md`.

### 3.6 Lease and timeout policy

`resolveExecutionLeaseMs` (`adapters/resonate-config.ts:106-135`):

| Job | Lease |
|---|---|
| default | `JOB_LEASE_MS`, default **300 000 ms** |
| `factory-control` + `factory.objective.control` | `max(default, FACTORY_CONTROL_JOB_LEASE_MS ?? 900 000)` |
| `factory-monitor` + `factory.task.monitor` with `executionPath === "computer"` | `max(CODEX_JOB_LEASE_MS ?? 900 000, default)` |
| `codex` | `max(CODEX_JOB_LEASE_MS ?? 900 000, min(payload.timeoutMs + 300 000, 3 600 000))` |

`resolveExecutionTimeoutMs` (`adapters/resonate-runtime.ts:57-71`) is `max(5 000, leaseMs - 1 000)`, with
`FACTORY_CONTROL_JOB_EXECUTION_TIMEOUT_MS` allowed to lower it for objective control only.

`resolveExecutionHeartbeatMs` (`adapters/resonate-runtime.ts:73-93`) derives the renewal cadence from
recovery policy: `min(RECEIPT_RESONATE_HEARTBEAT_INTERVAL_MS, max(1000, floor(min(leaseMs,
RECEIPT_RESONATE_ACTIVE_STALE_MS ?? 600 000) / 3)))` — i.e. two renewal opportunities before the fence
fires.

`resolveDriverInvocationTimeoutMs` = `max(leaseMs + 60 000, 120 000)` (`resonate-config.ts:102-103`).

### 3.7 The dead local job backend

`packages/receipt-app/src/engine/runtime/job-worker.ts` still exports a `JobWorker` class, but the only
importer of the class is its own test. The server imports only the `JobHandler` / `JobExecutionResult`
types (`bootstrap.ts:104`, `services/factory-runtime.ts:21`, `adapters/resonate-runtime.ts:25`).
`JOB_BACKEND` is set in deployment env (`sst.config.ts:650`, `deploy/sst/single-host.ts:415`,
`deploy/Dockerfile.receipt:56`) but is **never read** anywhere in `packages/` or `apps/`.
`JOB_BACKEND=local` is therefore inert.

---

## 4. Durable execution

### 4.1 The Resonate dispatch chain

1. **Enqueue.** `POST /agents/:id/jobs` (or a service call) appends `job.enqueued` to `jobs/<jobId>` and the
   `jobs` index (`adapters/receipt-queue.ts:1400-1424`).
2. **Outbox.** `createResonateDispatchOutbox` (`adapters/resonate-job-backend.ts:15-19`) wraps the queue and
   asks the driver starter to begin a driver RPC.
3. **Driver RPC.** `createResonateDriverStarter` (`adapters/resonate-runtime.ts:339-401`) calls
   `client.beginRpc(dispatchKey, "receipt.job.driver", { jobId, dispatchKey }, { target: receipt-driver,
   timeout: driverInvocationTimeout, tags: { agentId, lane, jobId, kind } })`. Base dispatch key is the job
   id. If a previous driver/execute promise exists and is terminal, it advances a *delivery generation*
   (`terminalRecoveryDispatchKey`, lines 322-329, max 32 generations, error
   `resonate delivery recovery exceeded 32 generations for <jobId>`). If a promise is still pending it
   returns `{ created: false, reason: "active_delivery" }`.
4. **Driver executes.** `driveResonateJob` (`adapters/resonate-runtime.ts:706-800`) reads the job, fails
   stale active leases (`stale active Resonate job lost execution; retrying through Resonate driver`),
   honours `abortRequested`, then begins the worker RPC
   `client.beginRpc(<jobId>:attempt:<n>[:dispatch:<key>], "receipt.job.execute", { jobId, attempt,
   dispatchKey? }, { target: workerTarget, timeout: leaseMs, tags })`. The driver deliberately does **not**
   lease the job (comment at lines 764-770).
5. **Worker executes and settles.** `executeAndSettleJob` (`adapters/resonate-runtime.ts:548-704`):
   leases if `queued`, checks `abortRequested`, takes a start-fence heartbeat, races
   `executeJob` / heartbeat loop / execution timeout, re-reads the job, then calls
   `queue.complete` / `queue.fail` / `queue.cancel` under an `{ attempt }` fence. Every settlement is
   wrapped in `withReceiptStorageRetry` (5 attempts, 150 ms × attempt backoff, transient storage errors
   only).
6. **Callback.** `postJobCallback` fires for each terminal transition (see §1.5).

Fencing identifiers a docs page should name:

* Worker id: `resolveResonateExecutionWorkerId(job, dispatchKey)` =
  `` `resonate:<group>` `` optionally suffixed `` `:delivery:<sha256(dispatchKey)[0:16]>` ``
  (`adapters/resonate-runtime.ts:201-217`).
* Failure result statuses surfaced in `job.result`: `settlement_conflict`, `stale_attempt`, `lease_lost`,
  `terminal_state`, `canceled`, `execution_timeout`, `failed`
  (`adapters/resonate-runtime.ts:219-231, 462-546, 548-704`).

### 4.2 Redrive loops

Three independent recovery loops run in the runtime image:

| Loop | Roles | Interval env | Default |
|---|---|---|---|
| Queued-job Resonate redrive | all roles (`shouldRunResonateQueuedJobRedrive`, `resonate-config.ts:37-44`) | `RECEIPT_RESONATE_QUEUED_REDRIVE_INTERVAL_MS` | 15 000 ms, first pass after `RECEIPT_RESONATE_QUEUED_REDRIVE_STARTUP_DELAY_MS` (5 000 ms) |
| Objective-control outbox redrive | `worker-control`, `all` (`bootstrap.ts:2031-2033`) | `RECEIPT_OBJECTIVE_CONTROL_OUTBOX_REDRIVE_INTERVAL_MS` | 5 000 ms, timeout `RECEIPT_OBJECTIVE_CONTROL_OUTBOX_REDRIVE_TIMEOUT_MS` (15 000 ms) |
| Factory objective watchdog (Resonate schedule) | installed by whichever role has a client (`bootstrap.ts:1983-2004`) | `RECEIPT_FACTORY_OBJECTIVE_WATCHDOG_CRON` | `* * * * *`; disable with `RECEIPT_FACTORY_OBJECTIVE_WATCHDOG_ENABLED=0`; `..._TIMEOUT_MS` 60 000; `..._SCAN_LIMIT` 200 (clamped 1..2000) |

Redrive tuning knobs: `RECEIPT_RESONATE_QUEUED_REDRIVE_MIN_AGE_MS` (30 000),
`RECEIPT_RESONATE_QUEUED_REDRIVE_COOLDOWN_MS` (15 000), `RECEIPT_RESONATE_ACTIVE_STALE_MS` (600 000)
(`bootstrap.ts:216-236`). The redrive dispatch key is
`` `${job.id}:redrive:${job.attempt}:${job.updatedAt}` `` so a scanner pass is idempotent for one observed
queue state (`adapters/resonate-job-backend.ts:94-104`).

Objective resume runs once at startup after `RESONATE_STARTUP_SETTLE_MS` (default 1 000, from
`server/config.ts:63-67`) on every redrive-eligible role (`bootstrap.ts:2006-2028`).

### 4.3 `@receipt/durable` — the execution ledger

`packages/receipt-durable` (exports `.`, `./contract`, `./postgres`) is a Postgres-backed workflow /
activity ledger that sits *beside* receipts, never above them.

Contract (`packages/receipt-durable/src/contract.ts`):

* `WorkflowStatus`: `idle | pending | running | completed | failed | canceled` (lines 3-17).
* `ActivityStatus`: `pending | running | completed | failed | canceled` (lines 49-62).
* `WorkflowSnapshot` carries `key`, `status`, `revision`, timestamps, `input`, `metadata`, `output`, `error`.
* `ActivitySnapshot` adds `attempts`, `activeAttempt`, `activeOwner`, `lastHeartbeatAt`,
  `checkpointRevision`, `checkpointOutput`, `checkpointMetadata`.
* `DurableBackend` (lines 166-233) exposes `startOrResumeWorkflow`, `signalWorkflow`,
  `consumeWorkflowSignals`, `listWorkflowSignals`, `setWorkflowStatus`, `cancelWorkflow`, `getWorkflow`,
  `listWorkflows`, `waitForWorkflowChange`, `getActivity`, `heartbeatActivity`, `checkpointActivity`,
  `completeActivity`, `failActivity`, `listActivities`, `runDurableActivity`.

Key builders (`packages/receipt-app/src/lib/durable-execution.ts:43-50`):

```
objectiveControlWorkflowKey(objectiveId) = `factory/objective/${objectiveId}/control`
runWorkflowKey(stream, runId)            = `factory/run/${encodeURIComponent(stream)}/${runId}`
codexActivityKey(jobId)                  = `factory/codex/${jobId}`
```

`createDurableQueueBackend(base, durable)` wraps the receipt queue so durable rows follow queue mutations,
but every durable side effect is best-effort: a failure logs `[durable <label>] <message>` and does **not**
fail the already-appended receipt mutation (`lib/durable-execution.ts:190-206`). Queue commands are a
deliberate straight pass-through so steer/follow-up never depend on workflow signal delivery
(lines 208-215).

Durable tables: `receipt_durable_workflow`, `receipt_durable_signal`, `receipt_durable_activity`,
`receipt_durable_activity_attempt` (`db/schema.ts:676-744`).

### 4.4 The generic agent loop (`engine/runtime/agent-loop.ts`)

`runAgentLoop(input)` (`agent-loop.ts:2029`) is the one durable executor for `defineAgent` specs and for
Factory's objective supervisor. On an uncaught error it appends `run.failed` and rethrows unless a terminal
`run.completed` already exists (lines 2039-2058).

Policy versions: `CONTROL_POLICY_VERSION = "runtime-policy-v2"`
(`engine/runtime/control-receipts.ts:195`) and `SCHEDULER_POLICY_VERSION = "scheduler-v2"`
(`engine/runtime/scheduler-policy.ts:14`).

Deterministic selection (`engine/runtime/scheduler-policy.ts:31-59`):

1. Sort runnable actions by kind priority — `human` 0, `assistant` 1, `action` 2, `tool` 3.
2. If any is `exclusive`, select exactly that one; reason `"exclusive"`.
3. Otherwise select `slice(0, hardCap)` where `hardCap` is the minimum of every selected action's
   `maxConcurrency` and the spec-level default; reason `"concurrency-cap"` or `"priority-order"`.
4. Nothing runnable → reason `"settled"`.

Deterministic identifiers (`agent-loop.ts:262-277, 1709-1724`):

```
selectionId    = "agent_selection_"          + sha256([runId, spec.id, spec.version, policyVersion,
                                                       SCHEDULER_POLICY_VERSION, selectedHead ?? "root",
                                                       actionIds])[0:32]
invocationId   = "agent_action_invocation_"  + sha256([selectionId, actionId, index])[0:32]
```

`receiptContentHash` sorts object keys before hashing so harmless key-order differences do not invalidate a
recovered output manifest (`agent-loop.ts:265-277`).

Defaults: `DEFAULT_ACTION_CLAIM_LEASE_MS = 130 000`, `CLAIM_POLL_MAX_MS = 5 000`,
`APPEND_RETRY_LIMIT = 32` (`agent-loop.ts:157-159`).

**Control receipts** (`engine/runtime/control-receipts.ts:1-193`, canonical list at lines 197-217):

```
run.started, run.completed, run.blocked, run.failed
action.selected, action.started, action.output.manifest,
action.completed, action.failed, action.superseded
human.requested, human.responded
goal.completed
merge.started, merge.output.manifest, merge.selected,
merge.applied, merge.skipped, merge.failed
```

`action.started` may carry `inlineSelection` so a local singleton can select+claim in one receipt
(`control-receipts.ts:56-66`, produced at `agent-loop.ts:1740-1760`).

**Remote action lane** (`engine/runtime/resonate-agent-actions.ts`):
`RESONATE_AGENT_ACTION_FUNCTION = "receipt.agent.action.execute"` (line 13),
`RESONATE_AGENT_ACTION_VERSION = 2` (line 19), pinned on **both** registration (line 259) and the RPC
options (line 310) so a rolling deploy cannot route the v2 payload to a v1 worker. The RPC id is the
`invocationId`, and the RPC timeout is 120 000 ms (line 309).

The remote worker re-loads the spec from `packages/receipt-app/src/agents/<id>.agent.ts`
(`sdk/agent-spec-loader.ts:16-17, 34-40`), enforces `spec.id`/`spec.version` provenance, re-derives the view
from `selectedHead`, and re-checks `kind`, `execution === "remote"`, and `when(...)` before running
(`resonate-agent-actions.ts:196-252`). Error strings include:

* `agent spec '<id>' does not support remote execution`
* `remote action '<id>' requires <agent>@<version>, but the worker loaded <agent>@<version>`
* `remote action '<id>' selected head '<hash>' is unavailable`
* `remote action '<id>' no longer matches selected kind/execution provenance`
* `remote action '<id>' is no longer runnable at its selected head`

---

## 5. HTTP API — what `server.ts` actually registers

Base URL: `http://localhost:8787` (or `PORT`). Through the gateway, prefix everything below with `/runtime`
except `/connect/*` and `/receipt-debug/*`.

Conventions confirmed in code:
* JSON responses are written with `Content-Type: application/json; charset=utf-8` and
  `Cache-Control: no-store` (`bootstrap.ts:2142-2149`).
* Error bodies from `text(status, msg)` are `text/plain` (`framework/http.ts:21`).
* Malformed JSON bodies raise `BadJsonError` → `400 "Malformed JSON body"`; a non-object JSON body →
  `400 "Request body must be a JSON object"`; any other unhandled error → `500 "Server error"`
  (`bootstrap.ts:2114-2118, 2158-2169`).
* Unmatched routes → `404 "Not found"` (`bootstrap.ts:3716`).
* Bun server idle timeout is 30 s (`bootstrap.ts:3742`).

### 5.1 Core runtime routes (registered directly in `bootstrap.ts`)

| Method | Path | Line | Purpose / body / response |
|---|---|---|---|
| POST | `/agents/:id/jobs` | 2529 | Enqueue. Body: `{ jobId?, lane?, maxAttempts?, sessionKey?, singletonMode?, singleton?: { key?, mode? }, payload }`. Lane accepts `chat|steer|follow_up|collect` (default `collect`); `maxAttempts` clamped 1..8 (default 2). Response **202** `{ ok: true, job, async: { jobId, stream: "jobs/<id>", events: { job: "/jobs/<id>/events", receipt: "/receipt/stream" }, status } }`. Publishes `jobs` topic. |
| POST | `/chat/route` | 2595 | Channel-neutral semantic routing for Slack/Teams adapters. Body needs `actorContext` (or `authContext`, or top-level `userId`/`organizationId`), `latestUserText`, `channel` (`slack|teams|web`), optional `priorProviders`, `boundObjectiveId`, `recentContext`, `receiptConnectCapabilities`. **200** `{ ok: true, decision }`. **400** `{ ok:false, error:"actor_context_required", detail }`. **409** `{ ok:false, error:"openai_byok_unavailable", detail:"The organization must configure OpenAI BYOK before semantic chat routing can run." }`. |
| POST | `/chat/respond` | 2651 | Writes an external-channel direct reply. **200** `{ ok:true, response: { text, profileId } }`. **400** `actor_context_required` or `latest_user_text_required`. **409** `openai_byok_unavailable` (detail mentions "before Beetle can write a direct chat response"). **502** `{ ok:false, error:"profile_response_unavailable" }`. |
| GET | `/healthz` | 2718 | Always **200**. Body: `{ ok: true, ready, degraded: false, uptimeSec, dataDir, processRole, queue, postgres, codexBin, resonateUrl }`. |
| GET | `/readyz` | 2736 | **200** when Postgres answers `SELECT 1`, else **503**. Body: `{ ok, ready, degraded: false, uptimeSec, processRole, postgres }`. |
| GET | `/receipt-debug/snapshot` | 2962 | Token-gated. Query `limit` (1..200, default 20), `status`, `jobId`. Returns runtime readiness + recent jobs + findings. On a transient storage error it still returns **200** with `ok:false` and finding code `debug_snapshot_transient_storage_error`. |
| GET | `/receipt-debug/jobs/:id` | 3021 | Token-gated. **200** `{ ok:true, scannedAt, ...summary, job }`; **404** `{ ok:false, error:"job_not_found", jobId }`; **503** `{ ok:false, error:"job_temporarily_unavailable", jobId, detail }`. |
| GET | `/receipt-debug/receipts` | 3051 | Token-gated. Query `stream` (required, must contain `/`), `recentLimit` (1..50, default 12), `replayLimit`/`limit` (1..10 000, default 250), `includeReceipts=1` or `replay=1` or `mode=replay`. **400** `missing_stream` / `invalid_stream`. |
| GET | `/receipt-debug/jobs/:id/artifacts` | 3111 | Token-gated. Returns Codex `prompt`, `lastMessage`, `stdout`, `stderr`, `result` artifacts, each truncated above 80 000 chars with `...[truncated N chars]...`. |
| POST | `/receipt-debug/jobs/:id/abort` | 3165 | Requires scope `debug:objective`. Body `{ reason?, by? }` (`by` defaults `"receipt-debug"`). **202** `{ ok:true, jobId, command }`; **404** `job_not_found`. |
| POST | `/receipt-debug/probes/objective` | 3198 | Requires scope `debug:objective`. Creates a bounded prod objective probe; returns a `monitor` link to `/receipt-debug/objectives/<id>`. |
| GET | `/receipt-debug/objectives/:id` | 3397 | Token-gated. Query `recoverControl=1|true` triggers an objective-control outbox redrive + background execute. Returns `{ ok, scannedAt, objectiveId, objective, debug, receipts, jobs, controlRecovery?, diagnosticReadErrors, findings }`. Read timeouts: 30 s primary, 15 s secondary. |
| POST | `/receipt/callback` | 3469 | Projection/invalidation callback. Optional `Authorization: Bearer $RECEIPT_CALLBACK_TOKEN` (**401** `unauthorized` on mismatch). Body needs `stream` (**400** `stream required`) and a resolvable event type (**400** `eventType required`). **202** `{ ok: true }`. Not an append API. |
| POST | `/jobs/:id/steer` | 3484 | Body `{ payload?, by? }` (falls back to the whole body as payload). **202** `{ ok:true, command }`; **404** `job not found`; **409** `job is <status>; continue through its objective`. |
| POST | `/jobs/:id/follow-up` | 3503 | Same shape as steer. |
| POST | `/jobs/:id/abort` | 3522 | Body `{ reason?, by? }` (reason default `"abort requested"`). **202** `{ ok:true, command }`; **404** `job not found`. |
| GET | `/jobs/:id` | 3539 | **200** `QueueJob`; **404** `job not found`; **503** `job temporarily unavailable`. Repairs stale leases in the background. |
| GET | `/jobs/:id/wait` | 3556 | Long poll. Query `timeoutMs` clamped 0..120 000 (default 15 000), 200 ms poll. **200** job; **404** `job not found`. **Response carries `Deprecation: true` and `Link: </jobs/<id>/events>; rel="successor-version"`.** |
| GET | `/jobs/:id/events` | 3574 | SSE stream on the `jobs` topic keyed by job id. |
| GET | `/jobs` | 3578 | Query `status`, `limit` (1..500, default 50). **200** `{ jobs: QueueJob[] }`. |
| POST | `/memory/:scope/read` | 3601 | Body `{ limit?, actorContext|authContext|... }`. **200** `{ entries }`. Appends a `memory.accessed` receipt. |
| POST | `/memory/:scope/search` | 3615 | Body `{ query, limit?, ...actor }`. **200** `{ entries }`. |
| POST | `/memory/:scope/summarize` | 3631 | Body `{ query?, limit?, maxChars?, ...actor }`. **200** `{ summary, entries }`. |
| POST | `/memory/:scope/commit` | 3650 | Body `{ text, tags?, meta?, ...actor }`. **201** `{ entry }`; **400** `text required`. Publishes the `receipt` topic. |
| POST | `/memory/:scope/diff` | 3672 | Body `{ fromTs, toTs?, ...actor }`. **200** `{ entries }`; **400** `fromTs required`. |
| GET | `/assets/:file` | 3698 | Serves built CSS/JS. **400** `invalid asset path` when the name contains `..` or `/`; **404** `asset not found`. `Cache-Control: no-cache` for `.css`/`.js`, `public, max-age=3600` otherwise. |

**All five `/memory/*` routes now require an actor context.** `actorAuditFromBody`
(`bootstrap.ts:2172-2179`) calls `requireReceiptActorContext(body.actorContext ?? body.authContext ?? body,
"<route> actor context")`, which throws for a missing `userId`/`organizationId` and surfaces as a `500`.
`docs/api/http.md` still documents them as anonymous.

### 5.2 Receipt Connect routes (`server/receipt-connect-routes.ts`)

Registered at `bootstrap.ts:2714` via `registerReceiptConnectRoutes({ app })`. 23 routes:

`POST /connect/mcp`; `GET|POST /connect/workspaces`; `DELETE /connect/workspaces/:id`;
`POST /connect/workspaces/:id/token`; `GET /connect/workspaces/:id/members`;
`PUT|DELETE /connect/workspaces/:id/members/:userId`; `GET /connect/agent/connections`;
`POST /connect/tools`; `POST /connect/call`; `GET /connect/capabilities`; `GET /connect/connectors`;
`GET /connect/connections`; `DELETE /connect/connections/:id`; `GET /connect/connections/:id/actions`;
`GET /connect/connections/:id/repositories`; `GET /connect/nango/health`; `POST /connect/nango/sessions`;
`POST /connect/nango/webhook`; `POST /connect/credential/:provider`;
`POST /connect/credential/github/import`; `POST /connect/credential/aws/import`.
(Line numbers 836–2254 in that file.) These belong to the Receipt Connect docs, not this report.

### 5.3 Factory / receipt-browser / runtime-dashboard routes (agent route module)

Loaded by `loadAgentRoutes` (`bootstrap.ts:2121-2138`), which scans
`packages/receipt-app/src/agents/*.agent.ts`. There is exactly **one** such file today:
`factory.agent.ts` → `agents/factory/route/handlers.ts`, id `"factory"`, kind `"factory"`, advertised
`paths: { shell: "/factory", state: "/factory/api/objectives", events: "/factory/live" }`
(`handlers.ts:2126-2132`).

`register(app)` (`handlers.ts:2134-2199`) mounts:

**UI shells (three base paths: `/factory`, `/factory-new`, `/factory-preview`)**

* `register-factory-ui-routes.ts` (basePath `/factory`): `GET /factory`, `GET /factory/control` (**303**
  redirect to `/factory` preserving the query string), `GET /factory/workbench` (**303** to the canonical
  workbench link), `GET /factory/new-chat`, `GET /factory/api/workbench-shell`, and HTMX islands
  `/factory/island/chat`, `/factory/island/workbench`, `.../workbench/board`, `.../workbench/block`,
  `.../workbench/focus`, `.../workbench/rail`, `.../workbench/chat-shell`, `.../workbench/chat-pane`,
  `.../workbench/chat-body`, `.../workbench/select`, `.../workbench/background-root`. A middleware on
  `/factory/island/*` redirects non-HTMX requests to the shell and sets `Vary: HX-Request`
  (`register-factory-ui-routes.ts:210-215`).
* `register-factory-ui-routes-linear.ts` (basePath `/factory-new`): the same shape minus `board`.
* `register-factory-preview-routes.ts` (basePath `/factory-preview`): `GET /factory-preview`, islands
  `header`, `rail`, `focus`, `timeline`, and `GET /factory-preview/island/drawer/:section` where section ∈
  `properties | self-improvement | tasks | artifacts | receipts | execution`
  (`register-factory-preview-routes.ts:353-368`). Unknown sections throw
  `Unknown preview drawer section: <x>`.

**API routes (registered three times, once per base path — `/factory`, `/factory-new`, `/factory-preview`)**
(`register-factory-api-routes.ts`)

| Method | Path (per base) | Line |
|---|---|---|
| POST | `<base>/compose` | 153 |
| POST | `<base>/api/objectives/:id/self-improvement/apply` | 520 |
| POST | `<base>/api/system-improvement/apply` | 584 |
| GET (WebSocket upgrade) | `<base>/live` | 636 |
| GET | `<base>/api/live-output` | 658 |
| GET | `<base>/api/user-preferences` | 672 |
| GET | `<base>/api/session-history` | 700 |
| GET | `<base>/api/objectives` | 751 |
| GET | `<base>/api/objectives/:id` | 759 |
| GET | `<base>/api/objectives/:id/live-status` | 764 |
| GET | `<base>/api/objectives/:id/debug` | 811 |
| GET | `<base>/api/objectives/:id/receipts` | 816 |

Notable payloads:
* `GET <base>/api/objectives` → `{ objectives, board }`.
* `GET <base>/api/objectives/:id/live-status` → `{ objectiveProgress: { objectiveId, status, phase,
  eventType, summary, detail, progressAt, active, jobId, taskId, candidateId, lastMessage, stdoutTail,
  stderrTail, activityLines, tokensUsed } }` (lines 764-810).
* `GET <base>/api/objectives/:id/receipts?limit=` → `{ receipts }` (default limit 40).
* `GET <base>/api/session-history` → `{ messages }` or `{ results }` when `query` is set; **400**
  `"Provide a chat or sessionStream when reading session history."`; **503** when `dataDir` is unset.
* `GET <base>/api/user-preferences?scope=repo|global|layered` → `{ scopeMode, summary, entries }`;
  **503** `"User preference memory is not configured."`.
* `POST <base>/compose` accepts browser composer submissions. Slash commands are parsed by
  `parseComposerDraft` (`factory-cli/composer.ts:151`). The registered command set
  (`factory-cli/composer.ts:67-82`) is: `/help` (aliases `/?`), `/analyze`, `/obj`, `/new`, `/react`,
  `/note`, `/watch`, `/promote`, `/cancel`, `/cleanup`, `/archive`, `/abort-job` (alias `/abortjob`),
  `/steer`, `/follow-up` (aliases `/followup`, `/follow_up`). With `Accept: application/json` the success
  response is `{ location, live? }` where `live` = `{ profileId, chatId, objectiveId?, runId }`. Empty
  prompt → **400** `"Enter a chat message or slash command."`; `/react` or `/note` without a selected
  objective → **409** `"Select an objective before reacting to it."` /
  `"Select an objective before noting it."`; `/watch` with an unknown id → **404**
  `"Objective '<id>' was not found."`.

**Receipt browser** (`register-receipt-routes.ts`): `GET /receipt`, `GET /receipt/island/folds`,
`GET /receipt/island/records`, `GET /receipt/island/view`, `GET /receipt/island/side`,
`GET /receipt/stream` (SSE, global `receipt` topic, line 236).

**Runtime dashboard** (`register-runtime-routes.ts`): `GET /runtime` (HTML), `GET /runtime/island` (HTML),
`GET /runtime/computers/summary` (JSON `{ generatedAt, computers }`).

### 5.4 Routes documented in `docs/api/http.md` that no longer exist

* `GET /factory/events`, `GET /factory/chat/events`, `GET /factory/background/events` — replaced by the
  WebSocket `GET /factory/live`. Nothing in `packages/` or `apps/` references those paths.
* The documented `/healthz` fields `jobBackend`, `checks`, `workers`, `stalledObjectives`,
  `oldestQueuedMsByLane`, `lastResumeAt`, `lastResumeError`, `watchdog` — none are produced
  (`bootstrap.ts:2718-2734`, `buildRuntimeReadiness` at `1563-1569` returns only `{ ok, postgres }`).
* `POST /improvement/:id/validate` (implied by the "Improvement Harness" section of
  `docs/api/config.md`) — no such route, and `IMPROVEMENT_VALIDATE_CMD` / `IMPROVEMENT_HARNESS_CMD` appear
  nowhere in the code.

### 5.5 Routes in code missing from `docs/api/http.md`

`GET /readyz`; `POST /chat/route`; `POST /chat/respond`; `POST /receipt/callback`; the whole
`/receipt-debug/*` family (6 routes); `GET /runtime`, `/runtime/island`, `/runtime/computers/summary`;
`GET /receipt`, `/receipt/island/{folds,records,view,side}`, `/receipt/stream`; the `/factory-new` and
`/factory-preview` shells and their island/API mirrors; `GET <base>/api/objectives/:id/live-status`;
`GET <base>/api/user-preferences`; `GET <base>/api/session-history`;
`POST <base>/api/objectives/:id/self-improvement/apply`; `POST <base>/api/system-improvement/apply`;
`GET <base>/live`; all 23 `/connect/*` routes.

---

## 6. Live API (SSE + WebSocket)

The hub is `LiveHub`, re-exported as `SseHub` (`packages/receipt-app/src/framework/sse-hub.ts` →
`@receipt/live`, `packages/receipt-live/src/hub.ts`).

### 6.1 Topics and refresh event names (`packages/receipt-live/src/protocol.ts:1-38`)

| Topic | Refresh event | Global fan-out key |
|---|---|---|
| `agent` | `agent-refresh` | *(none — agent is stream-scoped only)* |
| `receipt` | `receipt-refresh` | `receipt:*` |
| `jobs` | `job-refresh` | `jobs:*` |
| `factory` | `factory-refresh` | `factory:*` |
| `profile-board` | `profile-board-refresh` | `profile-board:*` |
| `objective-runtime` | `objective-runtime-refresh` | `objective-runtime:*` |

`profile-board` and `objective-runtime` are missing from `docs/api/sse.md`.

`publish(topic, stream?)` sends `data: <stream>` for the `factory` topic when a stream is given, otherwise
`data: <Date.now()>` (`hub.ts:166-174`). Every publish also fans out to the topic's global key
(`hub.ts:181-190`), which is why `GET /receipt/stream` (subscribed with `stream: undefined` → key
`receipt:*`) sees every receipt invalidation.

### 6.2 Data events (not refreshes)

Only two data events are published by the current server, both by the Factory ingress runner
(`bootstrap.ts:1340-1358`):

* `factory-stream-reset` — payload is an HTML fragment from `renderFactoryStreamingResetFragment()`.
  Published on topic `agent`, keyed by the chat stream.
* `agent-phase` — payload is `JSON.stringify({ runId, phase, summary })`. The first phase published is
  `("processing", "Binding the request to durable objective control.")`.

**`agent-token` is never published.** The browser clients still register listeners for it
(`client/factory-client/workbench.ts:1370`, `client/factory-preview-runtime.ts:438`), but no server code
calls `publishData(..., "agent-token", ...)`. `docs/api/sse.md` documents `agent-token` as a live event.

### 6.3 SSE transport (`packages/receipt-live/src/hub.ts:104-163`)

* `Content-Type: text/event-stream`, `Cache-Control: no-store`, `Connection: keep-alive`.
* On connect, each subscription immediately emits `event: <topic-refresh>` with `data: init`
  (`hub.ts:96-100`), unless `emitInit: false`.
* Keepalive: `event: ping\ndata: keepalive` every **5 000 ms** (`SSE_KEEPALIVE_MS`, `hub.ts:15`).

SSE endpoints that exist:

| Endpoint | Subscription | Source |
|---|---|---|
| `GET /receipt/stream` | `{ topic: "receipt" }` → key `receipt:*` | `register-receipt-routes.ts:236` |
| `GET /jobs/:id/events` | `{ topic: "jobs", stream: jobId }` | `bootstrap.ts:3574-3576` |

### 6.4 WebSocket transport — `GET <base>/live`

`register-factory-api-routes.ts:636-655` and `register-factory-preview-routes.ts:405-424` both mount a
`upgradeWebSocket` handler. Frames are JSON `LiveFrame`s (`{ kind: "event", topic, event, data, stream?,
id? }` or `{ kind: "ping" }`, `protocol.ts:12-25`), bound via `bindBunWebSocketToLiveHub`
(`packages/receipt-live/src/bun.ts:13-27`).

The subscription set is derived server-side by `resolveChatEventSubscriptions`
(`agents/factory/route/events.ts:28-115`) from query params, then mapped by
`liveSubscriptionsForFactoryChatEvents` (`events.ts:18-26`) to:

```
{ topic: "agent",             stream: chatViewStream }      // when a stream resolves
{ topic: "profile-board",     stream: profileId }
{ topic: "factory",           stream: objectiveId }         // when an objective resolves
{ topic: "objective-runtime", stream: objectiveId }         // when an objective resolves
{ topic: "jobs",              stream: jobId } × N           // scoped + explicitly selected jobs
```

Job scoping keeps at most 16 related jobs when no run/job is selected (`events.ts:100-103`).

The browser client is `createLiveEventSource` (`packages/receipt-live/src/browser.ts:94-165`): it upgrades
`http(s)` → `ws(s)`, reconnects after 1 000 ms on close, and re-dispatches decoded frames as DOM events
named after `frame.event`. **It requires `WebSocket`; it throws
`Live transport requires WebSocket support.` otherwise.** Documenting the Factory shell as SSE/EventSource
is wrong.

### 6.5 The app-side receipt trail proxy

`GET /api/receipt-trail/events` in the web app
(`apps/start/src/routes/api/receipt-trail/events/route.tsx`):

* Requires an authenticated app user **with an active organization**; otherwise `401 "Unauthorized"` or
  `401 "Organization context is required"` (lines 14-28).
* Proxies `GET <resolveReceiptServerUrl()>/receipt/stream` with `Accept: text/event-stream` (line 31).
* On upstream failure: `502 "Receipt event stream unavailable"` (line 37).
* Wraps the body in `withSseKeepAlive` and re-emits `text/event-stream`, `no-store`, `keep-alive`
  (lines 44-52).
* Comment in code makes the contract explicit: "Receipt runtime events are payload-free invalidation
  signals" — the browser must re-fetch after an event.

---

## 7. TypeScript SDK

### 7.1 Exact exports of `packages/receipt-app/src/sdk/index.ts`

```ts
export { receipt } from "./receipt";
export type { ReceiptDeclaration, ReceiptBody } from "./receipt";

export { defineAgent } from "./agent";
export type { ModernAgentSpec } from "./agent";

export { action, assistant, tool, human } from "./actions";
export type {
  ActionCommitContext, ActionExecutionMode, ActionKind, ActionRunContext,
  ActionSideEffects, AgentAction, DurableActionContext,
} from "./actions";

export { merge, rebracket } from "./merge";
export type { MergePolicy, MergeCandidate, MergeDecision, MergeScoreVector } from "./merge";
```

Values: `receipt`, `defineAgent`, `action`, `assistant`, `tool`, `human`, `merge`, `rebracket` — **eight**.
Types: `ReceiptDeclaration`, `ReceiptBody`, `ModernAgentSpec`, `ActionCommitContext`,
`ActionExecutionMode`, `ActionKind`, `ActionRunContext`, `ActionSideEffects`, `AgentAction`,
`DurableActionContext`, `MergePolicy`, `MergeCandidate`, `MergeDecision`, `MergeScoreVector`.

**There is no `goal(...)` export.** `architecture.md` §2 and `docs/agent-framework.md` "Public SDK" both list
`goal` as an SDK symbol; `goal` is a *field* of the `defineAgent` spec, not a helper. `docs/api/sdk.md` gets
this right. `ActionExecutionMode` is exported but not listed in `docs/api/sdk.md`.

### 7.2 The spec shape

`ModernAgentSpec` is defined in `engine/runtime/agent-loop.ts:87-119` and re-exported by
`sdk/agent.ts:4`:

```ts
type ModernAgentSpec<Receipts, View, Deps> = {
  readonly id: string;
  readonly version: string;
  readonly receipts: Receipts;                               // Record<string, ReceiptDeclaration<T>>
  readonly view: (helpers: ViewHelpers<Receipts>) => View;   // helpers: { on(type), chain() }
  readonly actions: (deps: Deps) => ReadonlyArray<AgentAction<View, EmitFn>>;
  readonly goal: (ctx: { view: View }) => boolean;
  readonly mergePolicy?: MergePolicy<MergeContext<View>, unknown>;
  readonly onMergeResult?: (ctx) => Promise<void> | void;
  readonly runtimePolicyVersion?: string;
  readonly maxIterations?: number;
  readonly maxConcurrency?: number;
};
```

`ViewHelpers.on(type)` returns `{ all(), last(), exists() }` and `chain()` returns the raw
`Chain<AnyEvent>` (`agent-loop.ts:36-43, 240-258`).

`receipt<T>()` returns `{ __receipt: true }` — it is a pure type marker
(`sdk/receipt.ts:1-9`).

### 7.3 The action contract (`sdk/actions.ts`)

```ts
type ActionKind          = "action" | "assistant" | "tool" | "human";      // :1
type ActionExecutionMode = "local" | "remote";                             // :2
type ActionSideEffects   = "receipt_only" | "query" | "external";          // :3

type DurableActionContext = {                                              // :16-22
  invocationId: string; selectionId: string; selectedHead?: string;
  claimId: string; claimOwnerId: string;
};

type ActionRunContext<View, EmitFn>  = DurableActionContext & { view: View; emit: EmitFn };   // :24
type ActionCommitContext<View>       = DurableActionContext & { view: View; selectedView: View }; // :29

type AgentAction<View, EmitFn> = {
  id: string;
  kind: ActionKind;
  when?: (ctx: { view: View }) => boolean;                                  // :36
  run: (ctx: ActionRunContext<View, EmitFn>) => Promise<void> | void;       // :37
  sideEffects?: ActionSideEffects;                                          // :45
  responseWhen?: (ctx: { view; invocationId; selectionId }) => boolean;     // :51  (human only)
  commitWhen?: (ctx: ActionCommitContext<View>) => boolean;                 // :63
  exclusive?: boolean;                                                      // :64
  maxConcurrency?: number;                                                  // :65
  execution?: ActionExecutionMode;                                          // :66
  targetGroup?: string;                                                     // :67
};
```

Semantics, quoting the doc comments in `sdk/actions.ts` and the loop:

* **`sideEffects: "receipt_only"`** — replay-safe local work.
* **`sideEffects: "query"`** — local, *at-least-once* model/read work after lease ambiguity; the buffered
  receipt output is still fenced and deduplicated by `invocationId` via `action.output.manifest`.
* **`sideEffects: "external"`** — a mutation. Must set `execution: "remote"` and must use `invocationId`
  as the downstream idempotency key, because remote delivery is at-least-once (`actions.ts:38-46`).
* **`commitWhen`** is an optimistic-validity fence re-evaluated inside every CAS retry against both the
  selected view and the latest view. Returning `false` records `action.superseded` and reselects from the
  new head (`actions.ts:53-62`, `control-receipts.ts:95-106`).
* **`exclusive`** forces a selection of one (`scheduler-policy.ts:42-45`).
* **`maxConcurrency`** lowers the per-selection cap; the effective cap is the minimum across selected
  actions and the spec default (`scheduler-policy.ts:47-58`).
* **`execution: "remote"`** dispatches through Resonate function `receipt.agent.action.execute` v2 with the
  RPC id equal to `invocationId` (`resonate-agent-actions.ts:288-311`).
* **`targetGroup`** picks the Resonate group for a remote action; it falls back to the caller's default
  group (`resonate-agent-actions.ts:306-308`).
* `human(...)` requires `responseWhen` at the type level (`actions.ts:97-102`). The controller emits
  `human.requested`, blocks, and resumes when a correlated domain receipt makes the predicate true.
* Kind priority in selection: `human` < `assistant` < `action` < `tool`
  (`scheduler-policy.ts:16-28`).

### 7.4 A minimal verified example

This compiles conceptually against the types above; it is the shape `receipt run` seeds and the shape
`receipt new` scaffolds.

```ts
// src/agents/hello-agent.agent.ts
import { defineAgent, receipt, action } from "../sdk/index";

export default defineAgent({
  id: "hello-agent",
  version: "1.0.0",

  receipts: {
    "task.requested": receipt<{ prompt: string }>(),
    "task.completed": receipt<{ output: string }>(),
  },

  view: ({ on }) => ({
    prompt: on("task.requested").last()?.prompt,
    done: on("task.completed").exists(),
  }),

  actions: () => [
    action("complete", {
      when: ({ view }) => Boolean(view.prompt) && !view.done,
      sideEffects: "receipt_only",
      run: async ({ view, emit }) => {
        await emit("task.completed", { output: `Echo: ${view.prompt ?? ""}` });
      },
    }),
  ],

  goal: ({ view }) => Boolean(view.done),
});
```

Running it:

```bash
./.receipt/bin/receipt run hello-agent --problem "say hello"
```

`commandRun` (`cli/commands.ts:209-296`):

* requires `--problem` (or `--prompt`), else throws `--problem is required`;
* defaults `runId` to `run_<b36 now>_<4 random chars>`, `stream` to `agents/<agentId>`, `runStream` to
  `<stream>/runs/<runId>`; `--run-id`, `--stream`, `--run-stream` override;
* **seeds the run** with `task.requested` if the spec declares it, else `prompt.received`, using eventId
  `seed:<runId>` (lines 236-249). A spec that declares neither gets no seed receipt;
* prints
  `{ ok, status, mode: "inline", runId, stream, runStream, reason? }` as pretty JSON;
* exits **2** when the loop result is not `completed` (line 288);
* throws
  `Agent '<id>' is not a receipt-native defineAgent spec. The legacy queued agent.run loop was removed; use
  Factory objective ingress or defineAgent.` when the module is not a spec (lines 292-295).

### 7.5 The two agent-spec loaders (a real footgun)

* **CLI loader** (`cli/runtime.ts:83-90`) reads `<process.cwd()>/src/agents/<id>.agent.ts`.
* **Remote-action loader** (`sdk/agent-spec-loader.ts:16-17`) reads
  `packages/receipt-app/src/agents/<id>.agent.ts`.

`receipt new <id>` writes to `<cwd>/src/agents/<id>.agent.ts` with `import ... from "../sdk/index"`
(`cli/commands.ts:127, 185`). A scaffolded root agent is therefore runnable from the CLI but **is not
deployable to the remote-action lane** without being moved into the package. `docs/agent-framework-integrations.md`
already flags this; it should be surfaced in the public "create an agent" page too.

### 7.6 Merge policy

`sdk/merge.ts:12-22`:

```ts
type MergePolicy<Ctx, Evidence = unknown> = {
  id: string;
  version: string;
  shouldRecompute?: (ctx: Ctx) => boolean;      // OPTIONAL
  candidates: (ctx: Ctx) => ReadonlyArray<MergeCandidate>;
  evidence: (ctx: Ctx) => Evidence;
  score: (candidate, evidence, ctx) => MergeScoreVector;   // Record<string, number>
  choose: (scored: ReadonlyArray<{ candidate; score }>) => MergeDecision;  // { candidateId, reason? }
};
export const merge = (policy) => policy;
export const rebracket = merge;   // alias
```

Durable merge lifecycle receipts are `merge.started` → `merge.output.manifest` → `merge.selected` →
exactly one of `merge.applied` | `merge.skipped` | `merge.failed`
(`control-receipts.ts:118-193`). **`architecture.md` §6's `merge.evidence.computed` and
`merge.candidate.scored` do not exist**, and its `MergePolicy` sketch marks `shouldRecompute` as required.

---

## 8. Agent framework integrations (CrewAI, LangGraph, OpenAI Agents SDK, AutoGen)

**Verification result: none of these adapters exist in the repository.**
`grep -ri "crewai|langgraph|autogen|openai-agents"` across `packages/`, `apps/`, `workers/` and `scripts/`
returns only two false positives (`autoGenerateTitle` in
`apps/start/src/lib/backend/chat/services/thread.service.ts:73,449,824` and
`chat-orchestrator.service.ts:801`). There is no `workers/crewai`, no `adapters/crewai*`, and no `crewai`
key in `jobHandlers`.

`docs/agent-framework-integrations.md` (1429 lines) is honest about this — it is a **prescriptive
implementation guide**, not a description of shipped adapters. Its own "What Exists Today" section (lines
75-125) states the three real surfaces and the explicit non-existence list. A public docs page must keep
that framing; presenting CrewAI/LangGraph/AutoGen as supported integrations would be a factual error.

What the doc gets right and a docs page can safely reuse:

* The recommended boundary: **one Receipt job per externally meaningful framework run**, with the framework
  loop behind a registered `JobHandler`.
* The identity table (`jobId`, `attempt`, `runId`, `stream`, `requestKey`, `frameworkRunId`,
  `invocationId`, `sessionKey`) — every one of those names is real in the code.
* The warning that `202` from `POST /agents/:id/jobs` proves only that `job.enqueued` was appended, not
  that a handler exists (verified: the route never checks `jobHandlers`, `bootstrap.ts:2529-2586`).
* The warning that `POST /receipt/callback` is an invalidation callback, not an append API (verified:
  `bootstrap.ts:3469-3482` only calls `publishReceiptAppendChange`).
* The recommended progress path — `queue.progress(job.id, ctx.workerId, ..., { attempt: ctx.attempt })` →
  a durable `job.progress` receipt. `progress` is a real `ReceiptQueue` method
  (`adapters/receipt-queue.ts:161-166`) and `job.progress` is a real event
  (`modules/job.ts:37-43`).
* The note that `JobStatus` has no `blocked` value (verified, `modules/job.ts:9`), so a framework adapter
  needs its own durable-wait model.

The `JobExecutionContext` a handler receives (`engine/runtime/job-worker.ts:14-19`) is:
`{ workerId, attempt, pullCommands(types?), registerLeaseProcess(p), clearLeaseProcess() }`. Under the
Resonate executor, `registerLeaseProcess` / `clearLeaseProcess` are **no-ops**
(`adapters/resonate-runtime.ts:456-461`) — worth documenting so an adapter author does not rely on them.
`JobExecutionResult` is `{ ok, result?, error?, noRetry?, afterComplete? }`
(`job-worker.ts:22-28`); `afterComplete` only runs when the queue settlement actually reached `completed`
(`adapters/resonate-runtime.ts:673-683`).

---

## 9. Deterministic simulation testing and the eval harness

### 9.1 `packages/receipt-dst`

Package `@receipt/dst`, exports `.` and `./simulation`
(`packages/receipt-dst/package.json`). Everything lives in
`packages/receipt-dst/src/simulation.ts` (898 lines) and is re-exported by `index.ts`.

Public surface (line numbers in `simulation.ts`):

| Export | Line | What it does |
|---|---|---|
| `createSimulationVirtualClock(seed)` | 141 | `{ now(), tick(ms?) }` virtual clock |
| `withSimulationDateNow(...)` | 152 | patches ambient `Date.now` for a scope |
| `createDeterministicSimulationRandom(...)` | 160 | seeded PRNG |
| `createDeterministicSimulationEntropy({...})` | 240 | labeled, domain-separated, replayable entropy tape (`float` / `int` / `choice` draws) |
| `createDeterministicSimulationIdSource(...)` | 377 | deterministic ids for queue/job/command/event ids |
| `withDeterministicSimulationEnvironment(...)` | 707 | patches `Date.now`, `Math.random`, and (optionally) timers for one scope |
| `traceSimulationEvent(...)` | 750 | append a `SimulationTraceEvent` |
| `createDeterministicSimulationScheduler({...})` | 767 | turns `setTimeout`/`setInterval` into ordered simulation steps |
| `createInMemorySimulationReceiptStore<B>()` | 864 | `Store<B>` in memory |
| `createInMemorySimulationBranchStore()` | 888 | `BranchStore` in memory |
| `DEFAULT_DETERMINISTIC_SIMULATION_MAX_STEPS` | 56 | 10 000 |

Three typed failure classes make simulation bugs legible:

* `DeterministicSimulationSchedulerLimitError` (code `deterministic_simulation_step_limit_exceeded`,
  message `Deterministic simulation scheduler exceeded <n> steps with <m> pending steps. lastStep=<actor>:<label>#<seq>`, line 58);
* `DeterministicSimulationTimerLeakError` (code `deterministic_simulation_timer_leak`, message
  `Deterministic simulation exited with <n> active timer(s): <label>:<kind>#<id>, ...`, line 92);
* `DeterministicSimulationEnvironmentIsolationError` (code
  `deterministic_simulation_environment_overlap`, message
  `Deterministic simulation environments patch process globals and cannot overlap.`, line 107).

Same-time scheduling order is configurable: `"fifo" | "lifo" | "actor" | "label" | { kind: "seeded", seed }`
(line 36-44), with a stable FNV-ish hash for the seeded ordering (line 121-134).

### 9.2 The Factory simulation corpus

58 files in `packages/receipt-app/src/services/factory/sims/`, each a deterministic runner returning a
`FactorySimulationReport` with invariant failures rather than throwing (see
`packages/receipt-app/src/services/factory/sims/README.md`). Examples: `queue-worker-drain.ts`,
`objective-control-runtime.ts`, `terminal-redrive-recovery.ts`, `opensandbox-lifecycle.ts`,
`zero-cache.ts`, `scheduler-interleavings.ts`, `fault-campaign.ts`, `incident-adversaries.ts`.

The README's rules are the ones a contributing-docs page should surface: build typed steps → replay them
through the *same* reducer/projector/decision boundary as live code → return a report; use
`createFactorySimulationEntropyTape` for new adversaries; use the timer-enabled deterministic environment
whenever the simulation drives real adapters, and drain the scheduler before returning.

### 9.3 How a developer runs simulations

Root `package.json`:

```bash
bun run receipt:simulate           # factory simulate search --corpus default --json --output-file /tmp/receipt-sim-search.json
bun run receipt:simulate:corpus    # ... --corpus-only
bun run receipt:simulate:repeat    # ... --input src/services/factory/sims/fixtures/prod-replay-smoke --repeat 2 --require-property all
bun run receipt:simulate:nightly   # ... --profile nightly --require-property all
bun run receipt:simulate:ui        # bun src/factory-cli/simulator-ui.ts (Ink TUI)
```

`bun run receipt:check` = `receipt:check-types && receipt:test && receipt:simulate:repeat`, so the repeat
simulation is part of the standard verification gate.

CLI surface (usage string at `packages/receipt-app/src/factory-cli/commands/index.ts:1989`):

```
receipt factory simulate [search|corpus add|corpus reduce|corpus promote|useful-gate|generic-agent-loop|
  projection-ui|prod-replay|deterministic-runtime|runtime-outbox|runtime-status-polling|
  projection-serving-fairness|funding-settlement|cross-channel-ingress|self-improvement|reliability-suite|
  ec2-list-happy|ec2-list-missing-scriptsrun|missing-semantic-result|missing-semantic-result-codex-takeover|
  missing-semantic-result-preserved-evidence|retry-after-useful-answer-sentinel]
  [--profile default|nightly|incident] [--seed <n>] [--seeds <n>] [--repeat <n>]
  [--corpus default|<path>] [--corpus-file <path>] [--corpus-only] [--reason <text>]
  [--coverage-floor <metric=value>] [--require-property <id|all>]
  [--expect-coverage-digest <sha256>|--coverage-baseline <artifact.json>] [--case <id>]
  [--fault <plan>|--fault-plan <plan>]
  [--input <prod-receipts-json-or-dir-or-search-artifact-or-reduced-corpus>] [--shrink]
  [--trace all|failures|none] [--json] [--output-file <path>]
```

`receipt dst` and `receipt simulate` are aliases of the same CLI command
(`cli/commands.ts:5330-5332` → `commandDst`).

### 9.4 `receipt dst` (the receipt audit)

Implemented in `packages/receipt-app/src/cli/dst.ts` (+ `dst-context.ts`). Documented in
`docs/receipt-dst.md`. Behavior verified against the doc:

* Base pass: list streams from runtime metadata → load chain + branch metadata + `runtime.verify(stream)` →
  classify as `factory.objective | job | agent.history | agent.control | generic` → summarize → **load a
  second fresh pass** → compare branch metadata, event-type counts, and summary.
* Three reported dimensions: `integrity`, `replay`, `deterministic`.
* `--context` adds a Factory worker-packet audit for historical `factory.task.run` jobs.
* `--strict` makes any receipt or context failure exit non-zero (`cli/commands.ts:439-441` throws
  `DST audit found receipt issues`).
* Accepts a stream prefix argument: `receipt dst factory/objectives/`, `receipt dst jobs/ --context`.

### 9.5 The eval harness (`eval/scenarios`, `receipt eval`)

Scenario roots (`packages/receipt-app/src/services/eval/scenarios.ts:6-8`):
`eval/scenarios` with `software/` and `computer-use/` subdirectories. Two scenarios are checked in:

* `eval/scenarios/software/repo-grounding-smoke.json` — `kind: "software_task"`, `publishMode: "simulate"`,
  budget `{ maxMinutes: 20, maxActions: 12, maxCheckRuns: 6 }`, `requiredChecks: ["bun run check"]`,
  grounding requirements (`ownership`, `buildGraph`, `testOwnership`, `envContracts`, `migrations`,
  `deployTopology`), handoff sections (`what_changed`, `why`, `risks`, `tests_run`, `self_review`,
  `failure_modes`), success criteria of type `changed_file` / `handoff_section` / `check_pass`.
* `eval/scenarios/computer-use/factory-workbench-flow.json` — `kind: "computer_use"`, a scripted state
  machine of `states` / `elements` / `transitions` (`home` → `eval-list` → ...).

Scenario resolution (`services/eval/scenarios.ts:44-70`) accepts an absolute path, a repo-relative path,
`<root>/<id>.json`, or an id matched by walking both roots.

CLI (`packages/receipt-app/src/cli/eval.ts:88-208`):

```bash
receipt eval run <scenario-id-or-path> [--organization-id <id>] [--json] [--output-file <path>]
receipt eval batch [<scenarioDir>] [--organization-id <id>] [--json] [--output-file <path>]
receipt eval report [--limit <1..200>] [--json]
receipt eval inspect <run-id> [--json]
receipt eval replay <run-id> [--json]
receipt eval list-scenarios [<scenarioDir>] [--json]
```

Behavior details:
* The semantic oracle is only enabled when `--organization-id` is supplied and that org has an OpenAI BYOK
  key (`cli/eval.ts:23-27`).
* Every command syncs the eval-run and computer-use-session projections first.
* `report` (non-JSON) prints exactly:
  `Receipt Eval Report`, `Runs: <n>`, `Pass rate: <p>/<n>`, `Abstraction miss rate: <x.xx>`,
  `Revert rate: <x.xx>`, `Strong handoff completeness rate: <x.xx>`, then one line per run
  `- <runId> [<kind>] status=<s> overall=<n>/<max> scenario=<id>` (`cli/eval.ts:64-86`).
* `inspect` (non-JSON) prints `Receipt Eval Inspect`, `Run ID:`, `Scenario:`, `Kind:`, `Status:`,
  `Started:`, `Completed:`, `Summary:`, `Artifacts:`, optional `Workspace:` and
  `Computer-use session: <id> state=<s> status=<s>` (`cli/eval.ts:51-62`).
* `replay` runs a `receipt dst` audit scoped to `eval/runs/<runId>` and, if present,
  `computer_use/sessions/<sessionId>` (`cli/eval.ts:161-186`).
* Error strings: `eval subcommand is required`, `eval run requires a scenario id or path`,
  `eval inspect requires a run id`, `eval replay requires a run id`,
  `eval run '<id>' not found`, `Unknown eval subcommand '<x>'`.
* Receipts: `eval/runs/<runId>` and `computer_use/sessions/<sessionId>`
  (`services/eval/receipts.ts:24-28`).

---

## 10. Observability and logging

### 10.1 Structured logs

`createStructuredLogger({ service, defaultContext })`
(`packages/receipt-core/src/structured-logger.ts:99-127`) emits one JSON object per line:

```json
{"ts":"<ISO>","level":"debug|info|warn|error","service":"...","event":"...","message":"...", ...context}
```

* `warn` and `error` go to **stderr**; `debug` and `info` go to **stdout** (lines 92-98).
* Keys matching `/authorization|cookie|password|secret|token|api[_-]?key|access[_-]?key|session/i` are
  replaced with `"[redacted]"` (lines 13, 29).
* Strings are clipped at 2 000 chars with a `...[truncated]` suffix (lines 15-17).
* `Error` values are serialized as `{ name, message, stack }`; circular values become `"[circular]"`.
* Reserved keys (`ts`, `level`, `service`, `event`, `message`) supplied by a caller are nested under
  `context` instead of overwriting the envelope (lines 12, 57-70).

The runtime logger is `service: "receipt-runtime"` with `defaultContext: { processRole }`
(`bootstrap.ts:198-203`). The gateway logger is `service: "receipt-service-gateway"`
(`apps/start/scripts/service-gateway.ts:25`).

Runtime log events a docs page can name: `runtime.http_listening` ("Receipt server is listening"),
`runtime.worker_connected` ("Receipt worker runtime connected"), `runtime.configured`,
`runtime.startup_failed` (followed by `process.exit(1)`), `runtime.shutting_down`,
`http.unhandled_error`, `projection.sync_latency` ("Receipt projection sync latency"),
`factory.watchdog_schedule`, `factory.resume_failed`, `factory.control_outbox_redrive_failed`,
`factory.ui_warmup_failed`, `resonate.role_runtime_error`, `resonate.queued_redrive_loop_error`,
`resonate.queued_redrive_startup_error`, `gateway.started`, `gateway.internal_app_exited`.

Projection latency logging is throttled by
`RECEIPT_PROJECTION_SYNC_LATENCY_LOG_THRESHOLD_MS` (default 250) and can be forced with
`RECEIPT_PROJECTION_SYNC_LATENCY_LOG_ALWAYS=true` (`bootstrap.ts:202-213, 344-380`).

Local `start:all` writes per-service log files under a run directory and prints their paths
(`scripts/start-all.mjs:658-676`).

### 10.2 Health endpoints

| Endpoint | Owner | Contract |
|---|---|---|
| `GET /healthz` | runtime :8787 | always 200; `{ ok, ready, degraded, uptimeSec, dataDir, processRole, queue, postgres, codexBin, resonateUrl }` |
| `GET /readyz` | runtime :8787 | 200/503 by Postgres reachability; `{ ok, ready, degraded, uptimeSec, processRole, postgres }` |
| `GET /health` | web app :3001 (and gateway root) | `{ ok: true }`; `HEAD` returns 204-style empty 200 (`apps/start/src/routes/health/route.tsx`) |
| `GET /` | zero-cache :4848 | used only as a liveness probe by `start:all` |
| `:9090/metrics` | Resonate | Prometheus metrics from the Resonate server; Receipt itself exposes **no** `/metrics` |

`postgres` in the health payload is `{ ok: true, target }` or `{ ok: false, target?, error }` where `target`
is a redacted description of the connection (`bootstrap.ts:1534-1561`). The readiness pool is opened with
`application_name: "receipt-runtime-readiness"`, `max: 1`, `connectionTimeoutMillis: 5000`.

`queue` is `queue.snapshot()`: `{ version, total, queued, leased, running, completed, failed, canceled,
updatedAt? }` (`adapters/receipt-queue.ts:118-128`). The comment at `bootstrap.ts:2725-2726` explains why it
is a cached snapshot: "Health is a liveness surface, not a replay boundary."

### 10.3 Debug endpoints and their auth

`authorizeReceiptDebugRequest(req, requiredScope = "debug:read")` (`bootstrap.ts:2232-2266`):

1. If neither `RECEIPT_DEBUG_TOKEN` nor a debug JWT secret is configured → **503**
   `{ ok:false, error:"receipt_debug_disabled", detail:"Set RECEIPT_DEBUG_JWT_SECRET or
   RECEIPT_DEBUG_TOKEN on receipt-runtime to enable protected prod diagnostics." }`.
2. No bearer token → **401** `{ ok:false, error:"unauthorized" }`.
3. Constant-time match against `RECEIPT_DEBUG_TOKEN` → allow.
4. Otherwise verify the JWT and check the scope (`debug:read` or `debug:objective`) → allow.
5. Else **401** `{ ok:false, error:"unauthorized" }`.

Mutating debug routes (`POST /receipt-debug/jobs/:id/abort`, `POST /receipt-debug/probes/objective`)
require `debug:objective`.

### 10.4 Receipt trail and ingest in the web app

**`GET /api/receipt-trail/events`** — see §6.5.

**`/api/receipt-ingest/receipts`** (`apps/start/src/routes/api/receipt-ingest/receipts/route.tsx`) is the
authenticated append endpoint for installed Receipt CLIs. Auth is a **Receipt Connect JWT** in
`Authorization: Bearer <token>` that must carry the `connect:write` scope
(`authenticatedClaims`, lines 64-71). The tenant store is derived from the token's `sub` (userId) and
`org_id` (organizationId), so a caller cannot choose a tenant.

* `GET ?prefix=<p>` → `{ ok:true, streams, organizationId }`.
* `GET ?stream=<s>[&limit=<n>]` → `{ ok:true, stream, count, version, receipts, organizationId }`.
  `version` is the last receipt hash (or `""`). `limit` is clamped to `MAX_STREAM_READ_LIMIT = 2000`.
* `POST { receipt, expectedPrev? }` → `{ ok:true, stream, hash, organizationId }`.
* `POST { receipts: [...], expectedPrev? }` → `{ ok:true, stream, hash, count, organizationId }`.
  `expectedPrev` applies to the first receipt only; the rest use their own `prev`.
* Limits: `MAX_RECEIPT_BODY_BYTES = 2 MiB` → **413** `receipt_too_large`;
  `MAX_BATCH_RECEIPTS = 100` → **413** `{ ok:false, error:"receipt_batch_too_large", maxReceipts:100 }`;
  empty batch → **400** `empty_batch`.
* Error codes: **401** `invalid_token` (GET), **403** `invalid_token` (POST — note the asymmetry),
  **400** `missing_stream_or_prefix`, **400** `invalid_receipt`, **400**
  `{ error:"unsupported_stream", detail:"Agent import ingestion requires streams under imports/clauden/ or
  imports/claude-code/." }`.
* **Stream allowlist:** only `imports/clauden/` and `imports/claude-code/` prefixes are accepted
  (`SUPPORTED_AGENT_IMPORT_PREFIXES`, lines 14-17). This is the Claude Code transcript import path, which
  another report covers; the important architectural fact here is that this endpoint is **not** a general
  receipt-append API.

---

## 11. Verified configuration reference

Only variables actually read by code are listed. `docs/api/config.md` contains several that are not.

### Runtime and server

| Variable | Default | Read at | Effect |
|---|---|---|---|
| `PORT` | `8787` | `server/config.ts:74` | HTTP listen port (`api` role only) |
| `RECEIPT_PROCESS_ROLE` | `api` | `server/config.ts:68-70` | one of `api`, `driver`, `worker-chat`, `worker-control`, `worker-codex`; anything else → `all` |
| `RECEIPT_PROCESS_INSTANCE` | `1` | `resonate-config.ts:81-82` | part of the Resonate pid |
| `ZERO_UPSTREAM_DB` | *(required)* | `config/runtime-env.ts:1,20-26` | **the** Receipt Postgres URL |
| `RECEIPT_POSTGRES_SCHEMA` | `public` | `db/client.ts:76-82` | when set, disables data-dir schema derivation |
| `RECEIPT_POSTGRES_POOL_MAX` | `2` | `db/client.ts:232-235` | pool size |
| `RECEIPT_POSTGRES_APPLICATION_NAME` | — | supervisor injects `receipt-<role>-<n>` | pg `application_name` |
| `RECEIPT_DATA_DIR` / `DATA_DIR` | `<repoRoot>/.receipt/data` | `factory-cli/config.ts:287-290, 332-335` | tenant key → Postgres schema; also holds worker packets, artifacts, logs |
| `RECEIPT_REPO_ROOT` | git root of cwd | `factory-cli/config.ts:268, 311` | repo root for Factory |
| `RECEIPT_REPO_KEY` | `sha256(repoRoot)[0:12]` | `factory-chat-profiles.ts:427-434` | stream namespace segment |
| `RECEIPT_TENANT_ROOT` | `<repoRoot>/.receipt/tenants` | `server/tenant-context.ts:74-80` | per-org storage root |
| `RECEIPT_CODEX_BIN` | `codex` | `factory-cli/config.ts:295-296`, `bootstrap.ts:2731` | Codex binary |
| `RECEIPT_FACTORY_REPO_SLOT_CONCURRENCY` | `20` | `factory-cli/config.ts:296-299` | repo slot concurrency |
| `RESONATE_STARTUP_SETTLE_MS` | `1000` | `server/config.ts:63-67` | delay before objective resume |
| `RECEIPT_SERVER_WATCH` | `api` (dev script) | `start-resonate-runtime.mjs:115-140` | which roles run `bun --watch` |

### Resonate / durable dispatch

| Variable | Default | Read at |
|---|---|---|
| `RESONATE_URL` | `http://127.0.0.1:8001` | `resonate-config.ts:46-47` |
| `RESONATE_GROUP_API` / `_DRIVER` / `_CHAT` / `_CONTROL` / `_CODEX` | `receipt-api` / `receipt-driver` / `receipt-chat` / `receipt-control` / `receipt-codex` | `resonate-config.ts:49-62` |
| `RESONATE_BIND` / `RESONATE_PORT` / `RESONATE_METRICS_PORT` / `RESONATE_DATA_DIR` / `RESONATE_BIN` / `RESONATE_START_SERVER` | `127.0.0.1` / `8001` / `9090` / `<dataDir>/resonate` / autodetect / auto | `start-resonate-runtime.mjs:192-232, 40-53` |
| `JOB_LEASE_MS` | `300000` | `resonate-config.ts:107` |
| `CODEX_JOB_LEASE_MS` | `900000` | `resonate-config.ts:108` |
| `FACTORY_CONTROL_JOB_LEASE_MS` | `900000` | `resonate-config.ts:22-23` |
| `FACTORY_CONTROL_JOB_EXECUTION_TIMEOUT_MS` | lease-bounded | `resonate-runtime.ts:60-70` |
| `RECEIPT_RESONATE_EXECUTE_CONCURRENCY` | per-role default | `resonate-runtime.ts:96-97` |
| `CHAT_JOB_CONCURRENCY` / `ORCHESTRATION_JOB_CONCURRENCY` / `CODEX_JOB_CONCURRENCY` | `4` / `1` / `1` | `resonate-runtime.ts:99-105` |
| `RECEIPT_RESONATE_HEARTBEAT_INTERVAL_MS` | derived | `resonate-runtime.ts:84-92` |
| `RECEIPT_RESONATE_ACTIVE_STALE_MS` | `600000` | `resonate-runtime.ts:76-79`, `bootstrap.ts:225-228` |
| `RECEIPT_RESONATE_CALLBACK_URL` / `RECEIPT_EVENT_CALLBACK_URL` | supervisor-injected | `resonate-runtime.ts:231-234` |
| `RECEIPT_CALLBACK_TOKEN` | unset | `resonate-runtime.ts:245-247`, `bootstrap.ts:3470-3474` |
| `RECEIPT_RESONATE_QUEUED_REDRIVE_INTERVAL_MS` / `_MIN_AGE_MS` / `_COOLDOWN_MS` / `_STARTUP_DELAY_MS` | `15000` / `30000` / `15000` / `5000` | `bootstrap.ts:216-236` |
| `RECEIPT_OBJECTIVE_CONTROL_OUTBOX_REDRIVE_INTERVAL_MS` / `_TIMEOUT_MS` | `5000` / `15000` | `bootstrap.ts:253-260` |
| `RECEIPT_FACTORY_OBJECTIVE_WATCHDOG_ENABLED` / `_CRON` / `_TIMEOUT_MS` / `_SCAN_LIMIT` | on / `* * * * *` / `60000` / `200` | `bootstrap.ts:261-274` |
| `RECEIPT_DURABLE_DEBUG_STALE_ACTIVITY_MS` / `_LIMIT` | `120000` / `100` (max 1000) | `bootstrap.ts:237-248` |
| `RECEIPT_DURABLE_RECONCILE_RECENT_JOB_LIMIT` | `200` (max 2000) | `bootstrap.ts:249-252` |
| `RESONATE_POSTGRES_URL` | unset | Resonate server config in deploy; SQLite is the local fallback |

### Projections

| Variable | Default | Read at |
|---|---|---|
| `RECEIPT_PROJECTION_SYNC_LATENCY_LOG_THRESHOLD_MS` | `250` | `bootstrap.ts:202-205` |
| `RECEIPT_PROJECTION_SYNC_LATENCY_LOG_ALWAYS` | `false` | `bootstrap.ts:206-207` |
| `RECEIPT_PROJECTION_RERUN_BASE_DELAY_MS` | `250` (min 25) | `bootstrap.ts:208-211` |
| `RECEIPT_PROJECTION_RERUN_MAX_NOOP_DELAY_MS` | `4000` | `bootstrap.ts:212-215` |

### Models

| Variable | Default | Read at |
|---|---|---|
| `OPENAI_API_KEY` | unset | `adapters/openai.ts` (org BYOK is preferred; see `readOrgOpenAiByokApiKey`) |
| `OPENAI_MODEL` | `gpt-5.6-luna` | `adapters/openai.ts:12-13` (`DEFAULT_OPENAI_MODEL`) |
| `RECEIPT_FACTORY_CHAT_MODEL` | `OPENAI_MODEL` else **`gpt-5.4-mini`** | `server/config.ts:81-84` |
| `RECEIPT_FACTORY_TASK_MODEL` | `gpt-5.6-luna` | `services/factory/runtime/factory-service-config.ts:8-11` |
| `RECEIPT_FACTORY_OBJECTIVE_SUPERVISOR_MODEL` | `gpt-5.6-terra` | `services/factory/runtime/objective-supervisor-runner.ts:109-115` |
| `RECEIPT_FACTORY_SUPERVISOR_MODEL` | unset | same, backward-compatible fallback |
| `OPENAI_MAX_RETRIES` | `3` | `adapters/openai.ts:184` |
| `OPENAI_RETRY_BASE_MS` | `500` | `adapters/openai.ts:185` |

### Debug / auth

| Variable | Effect |
|---|---|
| `RECEIPT_DEBUG_TOKEN` | static bearer token for `/receipt-debug/*` |
| `RECEIPT_DEBUG_JWT_SECRET` | HMAC secret for scoped debug JWTs (`debug:read`, `debug:objective`) |
| `RECEIPT_CONNECT_JWT_SECRET` | Receipt Connect JWT secret (used by `/api/receipt-ingest/receipts` too) |
| `RECEIPT_SERVICE_GATEWAY_EXPOSURE` / `RECEIPT_SERVICE_GATEWAY_ALLOW_PRIVATE` | allow private-service routing through the gateway |
| `RECEIPT_CONNECTION_ENCRYPTION_KEY_B64`, `BYOK_ENCRYPTION_KEY_B64`, `BETTER_AUTH_SECRET` | declared as required secrets in the service graph |

### Heartbeats and repo schedules

`HEARTBEAT_<AGENT>_INTERVAL_MS` (`adapters/heartbeat.ts:33-55`): key regex
`^HEARTBEAT_(\w+)_INTERVAL_MS$`; agent id is the lowercased capture; values below 1 000 ms are skipped;
the generated spec is `{ id: "heartbeat:<agent>", lane: "collect", singletonMode: "cancel",
sessionKey: "heartbeat:<agent>", maxAttempts: 1, payload: { kind: "<agent>.heartbeat" } }`.

`.receipt/config.json` `schedules[]` (`factory-cli/config.ts:190-227`):
`agentId` required; `intervalMs` required and **>= 1000** (else
`Factory config schedule '<agentId>' must set intervalMs >= 1000`); `payload` required object
(else `Factory config schedule '<agentId>' requires payload to be an object`);
`id` defaults to `schedule:<agentId>:<index+1>` (**1-based**, not 0-based as `docs/api/config.md` implies);
duplicate ids throw `Factory config has duplicate schedule id '<id>'`;
`sessionKey` defaults to `schedule:<id>`; `enabled: false` skips the entry;
`maxAttempts` clamped 1..8, default 1.
The checked-in `.receipt/config.json` also carries `defaultChecks: ["bun run check"]` and a
`defaultPolicy` with concurrency, budgets, throttles, mutation and promotion sub-objects.

---

## 12. CLI surface (for cross-reference only)

Top-level commands actually dispatched at `packages/receipt-app/src/cli/commands.ts:5298-5418`:

`setup`, `new`, `dev`, `run`, `trace`, `replay`, `dst` (alias `simulate`), `eval`, `import`, `observe`,
`fork`, `inspect`, `jobs`, `abort`, `connect`, `login`, `logout`, `whoami`, `workspace`, `tools`, `mcp`,
`proxy`, `memory`, `sessions`, `doctor`, `debug`, `factory`. Anything else throws
`Unknown command '<x>'`.

`architecture.md` §10 lists a "core commands" set that omits `setup`, `eval`, `import`, `observe`,
`connect`, `login`, `logout`, `whoami`, `workspace`, `tools`, `mcp`, `proxy`, `memory`, `sessions`,
`doctor`, `debug`, and `factory`.

`receipt dev` spawns `scripts/start-resonate-dev.mjs` from the repo root
(`cli/runtime.ts:109-118`), i.e. it starts the *whole* role fan-out plus a local Resonate server.

One inconsistency to flag rather than assert: `commandRun` and `commandFork` construct their Postgres stores
with **no** `DATA_DIR` argument (`cli/commands.ts:229-233, 467-472`), so they operate on the default schema,
while `resolveStream`, `readChain`, and the queue helpers pass `DATA_DIR`
(`cli/runtime.ts:26-33, 92-105`). In the default single-tenant repo layout both resolve to the same schema
only if `RECEIPT_POSTGRES_SCHEMA` is set; otherwise they differ.

---

## 13. Where the repo Markdown disagrees with the code

Ordered by how much damage a docs writer would do by trusting the Markdown.

1. **`docs/api/sse.md` / `docs/api/http.md`: `/factory/events`, `/factory/chat/events`,
   `/factory/background/events`.** Gone. The Factory shell uses a WebSocket at `GET /factory/live`
   (`register-factory-api-routes.ts:636`), and the client is `createLiveEventSource`, a WebSocket wrapper
   (`packages/receipt-live/src/browser.ts:94-102`), not `EventSource`. `docs/api/sse.md`'s note "The Factory
   shell uses one manual `EventSource`" is false.
2. **`docs/api/sse.md`: `agent-token`.** Never published by any server code. Only the browser listens.
   The events actually published on the `agent` topic are `agent-refresh`, `agent-phase`, and
   `factory-stream-reset` (`bootstrap.ts:1343, 1351`).
3. **`docs/api/sse.md`: topic list is incomplete.** `profile-board` / `profile-board-refresh` and
   `objective-runtime` / `objective-runtime-refresh` are missing (`packages/receipt-live/src/protocol.ts:1-38`).
4. **`docs/api/http.md`: the `/healthz` payload.** Documented fields `jobBackend`, `checks`, `workers`,
   `stalledObjectives`, `oldestQueuedMsByLane`, `lastResumeAt`, `lastResumeError`, `watchdog` do not exist;
   the actual payload adds `postgres` (`bootstrap.ts:2718-2734`). `/readyz` is undocumented.
5. **Lanes.** `architecture.md` §5, `docs/api/streams.md`, and `docs/api/http.md` all list three lanes
   (`steer`, `collect`, `follow_up`). The code has **four**: `chat | collect | steer | follow_up`
   (`modules/job.ts:8`), and the HTTP route accepts all four (`bootstrap.ts:2533-2540`).
6. **`docs/api/config.md`: several variables do not exist.** `JOB_POLL_MS`, `JOB_CONCURRENCY`,
   `JOB_LEASE_GRACE_MS`, `PLANNER_STEP_TIMEOUT_MS`, `IMPROVEMENT_VALIDATE_CMD`, `IMPROVEMENT_HARNESS_CMD`
   are read nowhere. `JOB_LEASE_MS` exists but defaults to **300 000**, not 30 000
   (`resonate-config.ts:107`). `JOB_WORKER_ID` is only read by the supervisor script and defaults to
   `worker_<role>_<instance>_<host>`, not `worker_<pid>`
   (`scripts/start-resonate-runtime.mjs:105-113`).
7. **`docs/api/config.md` / `docs/receipt-runtime-readme.md`: the Postgres URL.** They name
   `RECEIPT_POSTGRES_URL`. Production code reads **`ZERO_UPSTREAM_DB`** only
   (`config/runtime-env.ts:1, 20-26`); `RECEIPT_POSTGRES_URL` appears only in
   `packages/receipt-app/src/db/projectors.test.ts`.
8. **`docs/receipt-runtime-readme.md` / `docs/api/cli.md` / `docs/create-agent.md`: `JOB_BACKEND=local`.**
   `JOB_BACKEND` is never read in `packages/` or `apps/`. The `JobWorker` class it would have driven has no
   production importer. There is exactly one runtime topology now: Resonate.
9. **`architecture.md` §6: merge receipts.** `merge.evidence.computed` and `merge.candidate.scored` do not
   exist. Real merge control receipts: `merge.started`, `merge.output.manifest`, `merge.selected`,
   `merge.applied`, `merge.skipped`, `merge.failed` (`control-receipts.ts:118-193, 197-217`). The same
   section shows `shouldRecompute` as required; it is optional (`sdk/merge.ts:15`).
10. **`architecture.md` §2 and `docs/agent-framework.md`: `goal(...)` is listed as an SDK export.** It is
    not exported (`sdk/index.ts`).
11. **`architecture.md` §8: "Default store: SQLite-backed receipt tables."** The runtime store is Postgres
    (`server/composition.ts:18-42`). SQLite survives only as the local Resonate server's own store.
12. **`architecture.md` §7 / `docs/api/streams.md`: agent stream family.** They give
    `agents/<agentId>` / `agents/<agentId>/runs/<runId>` / `.../branches/<branchId>` / `.../sub/<subRunId>`.
    The Factory stream is actually `agents/factory/<repoKey>/receipt` and its sessions/objectives hang off
    that (`services/factory-chat-profiles.ts:436-448`). The generic `<base>/runs/<runId>` and
    `<runStream>/sub/<id>` shapes are real; the `branches/<branchId>` shape is only the CLI's default fork
    name (`cli/commands.ts:456-457`), not a runtime convention.
13. **`docs/api/streams.md`: "Data root: `DATA_DIR`… Stream registry: Postgres receipt-store metadata."**
    Understates the change: `DATA_DIR` now *determines the Postgres schema*
    (`db/client.ts:216-230`). It also lists an `improvement` stream family that no code produces.
14. **`docs/api/streams.md` / `architecture.md`: missing `job.progress`.** It is a real lifecycle receipt
    (`modules/job.ts:37-43`).
15. **`docs/api/http.md`: `/memory/*` routes are described as anonymous.** All five now require an actor
    context (`bootstrap.ts:2172-2179`).
16. **`docs/api/http.md`: `GET /jobs/:id/wait`.** The route now returns `Deprecation: true` and a
    `Link: rel="successor-version"` header pointing at `/jobs/:id/events` (`bootstrap.ts:3563-3572`). The
    docs present it as a first-class API.
17. **`docs/api/http.md`: the `POST /agents/:id/jobs` response.** It omits the `async` block the route
    actually returns (`bootstrap.ts:2578-2586`), and it omits `lane: "chat"`.
18. **`docs/memory.md`: table names.** `memory_entries` / `memory_accesses` / `memory_embeddings` are
    actually `receipt_memory_entries` / `receipt_memory_accesses` / `receipt_memory_embeddings`
    (`db/schema.ts:628, 642, 664`). The event list (`memory.committed`, `memory.accessed`,
    `memory.forgotten`) and the six operations (`read`, `search`, `summarize`, `commit`, `diff`, `reindex`)
    **are** accurate (`adapters/memory-tools.ts:29-31, 51-66, 163-170`).
19. **`docs/api/config.md`: schedule id default.** `schedule:<agentId>:<index>` — the code uses
    `index + 1` (`factory-cli/config.ts:210`).
20. **`docs/receipt-runtime-readme.md`: "Both modes expose … `http://localhost:9090/metrics`."**
    9090 is Resonate's metrics port, not a Receipt endpoint. Receipt exposes no `/metrics`.
21. **`docs/receipt-dst.md` and `docs/factory-self-improvement.md` and
    `docs/desktop-tauri-implementation.md` contain absolute paths under a former employee's home directory**
    (`<receipt-repo>/...`). Those must not be published (see §14).
22. **`docs/factory-on-receipt.md` §"Stream Model"** is accurate on the Factory/app-chat stream shapes,
    which is a good source for a stream reference page. Verified:
    `agents/factory/<repoKey>/receipt/sessions/<chatId>` and
    `apps/start/<repoKey>/app-chat/sessions/<threadId>` both match code.

---

## 14. Internal-only — must NOT be published

* **Named personal paths.** `docs/receipt-dst.md:80`, `docs/factory-self-improvement.md` (lines 69, 88,
  102, 132, 165, 167, 236 …), and `docs/desktop-tauri-implementation.md` (lines 34-37, 115-118, 207, 228,
  268, 279, 290) hard-code `<receipt-repo>/...`. This is a named personal account plus a
  local checkout path.
* **Internal AWS profile name `beetle`.** `package.json` scripts `receipt:aws:debug` and
  `receipt:aws:doctor` default `AWS_PROFILE` to `beetle`, and there is a whole
  `<deploy-project>:*` / `receipt:agent:beetle` script family. Also `deploy/` and
  `scripts/build-beetle-images.mjs`, `scripts/ensure-<deploy-project>-codebuild.mjs`,
  `scripts/start-<deploy-project>.mjs`, `scripts/local-agent-beetle.mjs`.
* **Internal product codename "Beetle" leaking into user-visible strings.** `POST /chat/respond` returns
  `"The organization must configure OpenAI BYOK before Beetle can write a direct chat response."`
  (`bootstrap.ts:2670-2673`) and its doc comment says "it always uses Beetle's resolved profile prompt".
  Decide whether "Beetle" is a public name before quoting these strings in docs.
* **Prod-debug flows that depend on a specific operator account.** `receipt:aws:debug` pins
  `RECEIPT_PROD_WEB_URL=https://app.kentron.ai` and requires the `beetle` AWS profile;
  `packages/receipt-app/src/server/prod-debug-*.ts`, `/receipt-debug/probes/objective`, and
  `?recoverControl=1` on `/receipt-debug/objectives/:id` are incident tooling that mutates production.
  Document `/healthz` and `/readyz` publicly; keep `/receipt-debug/*` out of the public reference, or
  document only that it exists and is token-gated.
* **Cutover checklists and deploy runbooks.** `docs/deploy/app-kentron-ai-cutover-todo.md`,
  `docs/deploy/aws-coder-two-developer-runbook.md`, `docs/deploy/neon-to-aws-zero-migration.md`,
  `docs/superpowers/plans/2026-08-31-app-kentron-ai-cutover.md`,
  `docs/production-release-handoff-2026-06-25.md`, `docs/factory-run-rca-2026-05-26.md`,
  `docs/prod-readiness-metrics.md`.
* **Local development default secrets.** `docker-compose.local.yml` contains a default
  `NANGO_ENCRYPTION_KEY`, `NANGO_DASHBOARD_USERNAME`, and `NANGO_DASHBOARD_PASSWORD`. Even though they are
  local-only placeholders, do not reproduce the literal values in public docs; refer to the variable names.
* **Internal service DNS names.** `http://runtime-api:8787` and `redis://redis:6379`
  (`deploy/sst/single-host.ts:415-421, 436, 522-584`) describe Kentron's own compose/ECS topology.
* **`docs/evidence/receipt-integration-live-config-2026-08-19.json`** — a captured live config snapshot.

---

## 15. Open questions for a human

1. **Is `JOB_BACKEND` meant to be revived, or is the local job backend formally retired?** The env var is
   still set in three deployment surfaces and documented in three Markdown files, but no runtime code reads
   it and `JobWorker` has no production importer. The docs need a decision, not a guess.
2. **Is `agent-token` streaming intentionally removed or accidentally broken?** Both browser clients still
   register a listener for it, and `docs/api/sse.md` documents it, but no publisher exists. If token
   streaming is a product feature, this is a regression; if it was removed, the client listeners and doc are
   dead code.
3. **Which Factory shell is public: `/factory`, `/factory-new`, or `/factory-preview`?** All three are
   registered unconditionally with full API mirrors. There is no feature flag in the registration code
   (`handlers.ts:2157-2193`). A public docs page must not present three shells.
4. **What is the intended `factory.dispatch` worker group?** `RECEIPT_JOB_KIND_CONTRACTS` says `control`
   (`runtime-contracts.ts:268+`) but `resolveWorkerTarget` routes it to `receipt-chat`
   (`resonate-config.ts:89-99`) because its agent id is `factory`. One of the two is wrong.
5. **Is the CLI/remote agent-spec loader split intentional?** `receipt new` scaffolds into
   `<cwd>/src/agents/`, which the remote-action loader cannot see. If remote actions are a public SDK
   feature, the scaffold target or the loader needs to change before it can be documented as usable.
6. **Is `receipt-live` intended to be a published package?** It is `workspace:*` only, with no `name`
   scoping issues, but it defines the public live-event protocol that a third-party client would need.
7. **Do `commandRun` / `commandFork` intentionally bypass `DATA_DIR`-derived schemas?** In a multi-tenant
   deployment this would point them at the wrong schema. Needs an owner's confirmation before documenting
   `receipt run` / `receipt fork` as tenant-safe.
8. **What is the supported self-hosting story for Resonate's own store?** `RESONATE_POSTGRES_URL` is
   mentioned in `docs/receipt-runtime-readme.md` and `deploy/`, but the local supervisor only ever
   configures the SQLite path (`start-resonate-runtime.mjs:186-232`). A self-hosting page needs the exact
   supported configuration.
9. **Is `/api/receipt-ingest/receipts` meant to accept streams outside the two `imports/` prefixes?** Right
   now it is exclusively the Claude Code / Clauden import path. If it is intended as a general CLI append
   API, the allowlist is the blocker.
10. **`docs/api/config.md` "Improvement Harness"** describes `IMPROVEMENT_VALIDATE_CMD`,
    `IMPROVEMENT_HARNESS_CMD`, and `POST /improvement/:id/validate`. Was this feature removed, or never
    shipped? The `improvement` stream family in `docs/api/streams.md` has the same problem.
11. **Model ids `gpt-5.6-luna`, `gpt-5.6-terra`, `gpt-5.4-mini`** appear as defaults. Confirm whether these
    are public model identifiers or internal aliases before printing them in a configuration reference.

---

## Suggested doc pages

| Slug | Title | Audience | What the reader can do afterwards |
|---|---|---|---|
| `platform/architecture` | Receipt Architecture Overview | both | Explain what Receipt is, how receipts/views/actions/replay fit together, and why state is derived rather than stored. |
| `platform/processes-and-ports` | Processes, Roles, and Ports | developer | Name every process role (`api`, `driver`, `worker-chat`, `worker-control`, `worker-codex`, `all`), know which one binds 8787, and read the local port map. |
| `platform/service-gateway` | The Service Gateway and Route Prefixes | developer | Know what `/runtime`, `/connect`, `/zero`, `/integrations`, `/integrations-connect`, `/slack`, `/teams`, `/resonate`, `/computer` map to, which are private, and which strip their prefix. |
| `concepts/receipts-and-streams` | Receipts, Chains, and Streams | both | Read a receipt, understand `prev`/`hash`/`context`/`hints`, verify a chain, and name every stream family correctly. |
| `concepts/folds-views-projections` | Folds, Views, and Projections | developer | Explain how state is derived, what the snapshot cache does, and why Postgres projections are disposable. |
| `concepts/branches-and-replay` | Branching, Forking, and Replay | both | Fork a run at index N, understand branch materialization and re-linking, and run `receipt replay` / `receipt dst`. |
| `concepts/job-queue` | The Job Queue: Lanes, Leases, and Singletons | both | Enqueue a job with the right lane and singleton mode, read every job lifecycle receipt, and interpret a `QueueJob`. |
| `concepts/durable-execution` | Durable Execution with Resonate | developer | Trace a job from enqueue → driver RPC → execute RPC → settlement, understand fencing and redrive, and read the durable workflow/activity ledger. |
| `concepts/memory` | Receipt-Backed Memory | both | Use the six memory operations, understand scopes and stream naming, and know that every read is audited. |
| `api/http` | HTTP API Reference | developer | Call every registered runtime route with correct method, body, status codes, and error strings. |
| `api/live-events` | Live Events (SSE and WebSocket) | developer | Subscribe to `/receipt/stream`, `/jobs/:id/events`, and `/factory/live`; handle every topic, refresh event, `agent-phase`, and keepalive. |
| `api/configuration` | Configuration Reference | developer | Configure a runtime deployment using only environment variables that are actually read. |
| `sdk/typescript` | TypeScript SDK | developer | Write a `defineAgent` spec, use every action option correctly, and know which side-effect class needs the remote lane. |
| `sdk/action-contract` | The Action Contract in Depth | developer | Choose `receipt_only` / `query` / `external`, use `commitWhen`, `exclusive`, `maxConcurrency`, `execution`, `targetGroup`, and use `invocationId` as an idempotency key. |
| `sdk/agent-loop-and-control-receipts` | The Agent Loop and Control Receipts | developer | Read a run's control trail and explain why a run is blocked, superseded, or settled. |
| `guides/create-an-agent` | Create a Receipt-Native Agent | developer | Scaffold with `receipt new`, run with `receipt run`, and understand the CLI-vs-remote spec loader split. |
| `guides/integrate-an-agent-framework` | Putting Another Agent Framework Behind Receipt | developer | Design a job-handler boundary for CrewAI/LangGraph/AutoGen, with the explicit caveat that no adapter ships today. |
| `guides/local-development` | Local Development and `start:all` | developer | Bring up the whole stack, know each service's port and health check, and read per-service logs. |
| `guides/self-hosting` | Self-Hosting Receipt | developer | Provision Postgres, Resonate, and the runtime roles, and configure the gateway and secrets. |
| `guides/testing-and-simulation` | Deterministic Simulation and DST | developer | Run `receipt dst`, run the Factory simulation corpus, and write a new deterministic simulation. |
| `guides/eval-harness` | The Eval Harness | developer | Author a scenario JSON, run `receipt eval run|batch|report|inspect|replay`, and read the scorecard output. |
| `operations/observability` | Logging, Health, and Debugging | developer | Parse structured logs, use `/healthz` and `/readyz`, and know that `/receipt-debug/*` exists and is token-gated. |
| `operations/receipt-trail` | The Receipt Trail in the App | both | Subscribe to `/api/receipt-trail/events`, understand payload-free invalidation, and re-fetch projections. |
