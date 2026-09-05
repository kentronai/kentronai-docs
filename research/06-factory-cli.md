# `receipt factory` — the Factory command subtree

Research report for the public Receipt documentation site.
Source of truth: the code in `<receipt-repo>` at the time of writing.
Every substantive claim is cited as `path:line`.

---

## 0. Orientation: how the subtree is reached

| Path | What it is |
|---|---|
| `packages/receipt-app/src/cli.ts:1` | The `receipt` binary entrypoint (`#!/usr/bin/env bun`). `packages/receipt-app/package.json:6-8` declares `bin.receipt = ./src/cli.ts`. |
| `packages/receipt-app/src/cli.ts:6` | `loadReceiptCliEnv()` runs **before** anything else, loading repo `.env` files. |
| `packages/receipt-app/src/cli.ts:26-30` | **`receipt` with no arguments in a TTY calls `handleFactoryCommand(ROOT, [], {})`** — i.e. the bare `receipt` command *is* the Factory board TUI. Non-interactive with no arguments prints the global usage. |
| `packages/receipt-app/src/cli/commands.ts:5418-5420` | `case "factory": await handleFactoryCommand(process.cwd(), parsed.args, parsed.flags)`. |
| `packages/receipt-app/src/factory-cli/commands.ts:1` | One-line re-export: `export { handleFactoryCommand } from "./commands/index"`. |
| `packages/receipt-app/src/factory-cli/commands/index.ts:3723` | `handleFactoryCommand(cwd, args, flags)` — the whole subtree dispatcher (4,643 lines). |
| `.receipt/bin/receipt` | Repo-local shell wrapper. It `cd`s to the repo root, exports `RECEIPT_REPO_ROOT` and `RECEIPT_REPO_KEY` (default `receiptfactory`), and resolves a Bun binary. |
| `package.json:61-62` | `bun run receipt:cli` → `./.receipt/bin/receipt`; `bun run receipt:factory` → `./.receipt/bin/receipt factory`. |
| `packages/receipt-app/package.json:61` | `bun run factory` (inside the package) → `bun src/cli.ts factory`. |

Note the **cwd difference**: bare `receipt` (TTY, no args) passes `ROOT` (the installed runtime root), whereas
`receipt factory …` passes `process.cwd()` (`packages/receipt-app/src/cli/commands.ts:5419`). Config discovery
walks up from that directory (`packages/receipt-app/src/factory-cli/config.ts:243-256`).

### Argument parsing model

`packages/receipt-app/src/cli/shared.ts:225-276` implements a minimal parser:

- `--flag value` and `--flag=value` both work.
- A flag repeated becomes an **array** (so `--check a --check b` and `--initial-task … --initial-task …` accumulate).
- `--flag` followed by another `--…` token or nothing becomes boolean `true`.
- A bare `--` pushes the remaining tokens into positional `args`.
- There is **no short-flag support** other than `-h` treated as a help token
  (`packages/receipt-app/src/factory-cli/commands/index.ts:1934`).

Flag readers used throughout the subtree
(`packages/receipt-app/src/factory-cli/commands/index.ts:203-249`):

- `parseBooleanFlag` → true only for boolean `true` or the literal string `"true"`.
- `parseIntegerFlag(flags, key, fallback, {min,max})` → non-numeric throws `--<key> must be a number`; otherwise clamped.
- `asString` → last value wins when repeated.
- `asStrings` → all values.

---

## 1. Concepts a reader must understand first

### 1.1 Objective

The top unit of Factory work: a durable, receipt-backed goal.
Stream name: `factory/objectives/<objectiveId>`; ids look like `objective_moc07bs6_ovbmts`
(`packages/receipt-app/src/factory-cli/commands/doctor.test.ts:78`).

Statuses (`packages/receipt-app/src/modules/factory/types.ts:4-16`):
`planning`, `waiting_for_slot`, `collecting_evidence`, `evidence_ready`, `synthesizing`,
`executing`, `integrating`, `promoting`, `completed`, `blocked`, `failed`, `canceled`.

The CLI also surfaces a *display state* and a finer *phase detail*
(`packages/receipt-app/src/services/factory-types.ts:296-326`):

- `displayState`: `Draft | Queued | Running | Awaiting Review | Stalled | Blocked | Completed | Archived | Failed | Canceled`
- `phaseDetail`: `draft | waiting_for_slot | waiting_for_computer_lease | waiting_for_control | waiting_for_synthesis | waiting_for_promotion | collecting_evidence | evidence_ready | synthesizing | integrating | promoting | cleaning_up | awaiting_review | stalled | completed | blocked | failed | canceled | archived`

Human-readable status labels/summaries the CLI prints are in
`packages/receipt-app/src/services/factory/live-status-phase.ts:11-64`, e.g.
`Queued — Waiting for the repo execution slot.`,
`Waiting for computer — Waiting for computer capacity before the agent starts.`,
`Collecting evidence — Gathering evidence for the active task.`,
`Synthesizing — Turning evidence into a final answer.`,
`Blocked — Waiting for operator guidance before continuing.`,
`Stalled — Execution stopped making visible progress.`

**Objective mode** (`packages/receipt-app/src/modules/factory/types.ts:68-70`): `delivery` or `investigation`.
The default comes from the profile, which for the checked-in `receipt` profile is
`investigation` (`profiles/receipt/PROFILE.md` frontmatter `defaultObjectiveMode`).

**Severity** is an integer `1..5` (`packages/receipt-app/src/modules/factory/types.ts:81-87`); profile default is `1`.

**Slot model**: only one objective holds the repo execution slot at a time; others queue
(board sections in `packages/receipt-app/src/factory-cli/view-model.ts:47-67`:
"Needs Attention / Active / Queued / Completed / Archived", with the exact descriptions
`"Objectives currently holding the repo execution slot."` and `"Objectives waiting for the repo execution slot."`).

### 1.2 Task and the task DAG

A task is a focused piece of an objective (`packages/receipt-app/src/modules/factory/types.ts:813-863`).
Key DAG fields: `nodeId`, `dependsOn: ReadonlyArray<string>`, `status`, `taskKind: "planned"`.

Task statuses (`types.ts:18-26`): `pending`, `ready`, `running`, `reviewing`, `approved`,
`integrated`, `blocked`, `superseded`.

Workflow buckets (`packages/receipt-app/src/modules/factory/defaults.ts:20-27`):

```
planned  : pending
ready    : ready
active   : running, reviewing
completed: approved, integrated, superseded
blocked  : blocked
terminal : approved, integrated, blocked, superseded
```

Tasks also have an **execution phase** (`types.ts:28-31`): `collecting_evidence`, `evidence_ready`, `synthesizing`,
and an **evidence semantic status** (`types.ts:33-37`): `empty`, `partial`, `sufficient`, `final`.

You seed the DAG from the CLI with `--initial-task 'title::prompt'` (repeatable),
`--parallel-task` (alias), or `--initial-tasks-json '[…]'`
(`packages/receipt-app/src/factory-cli/commands/index.ts:433-474`). The JSON form accepts
`{title, prompt|task, dependsOn: string[]}`.

### 1.3 Candidate

One sequential *attempt* at a task; ids contain `_candidate_`
(`packages/receipt-app/src/factory-cli/parse/index.ts:686-687` uses `trimmed.includes("_candidate_")` to resolve one).
Statuses (`packages/receipt-app/src/modules/factory/types.ts:39-47`): `planned`, `running`, `awaiting_review`,
`changes_requested`, `approved`, `integrated`, `rejected`, `conflicted`.

### 1.4 Job and run

A **job** is the queued unit of work behind a task/control action. Job ids start with `job_`
(`packages/receipt-app/src/factory-cli/commands/index.ts:3037`). Job statuses
(`packages/receipt-app/src/modules/job.ts:9`): `queued | leased | running | completed | failed | canceled`.
Job **lanes** (`packages/receipt-app/src/modules/job.ts:8,10`): `chat | collect | steer | follow_up | abort`.

A **run** is an agent-loop run inside a stream ending `/runs/<runId>`
(`packages/receipt-app/src/factory-cli/parse/index.ts:642-656`).

### 1.5 Check

A "check" is a shell validation command run against the integration worktree before promotion.
Two different resolvers with the same name exist and both matter:

1. **CLI-side** `resolveObjectiveChecks` (`packages/receipt-app/src/factory-cli/commands/index.ts:477-497`):
   - explicit `--check` values win;
   - if `--objective-mode investigation` was passed, send **no** checks;
   - otherwise resolve the profile; if the profile's `defaultValidationMode === "none"`, send no checks;
   - else send `config.defaultChecks` (from `.receipt/config.json`).
2. **Runtime-side** `resolveObjectiveChecks`
   (`packages/receipt-app/src/services/factory/runtime/objective-input-checks.ts:12-58`):
   - `checks !== undefined` (including `[]`) is an **explicit contract**;
   - investigation objectives → `[]`;
   - connected-system objectives (a `requiredCapabilities`/`capabilityContext` match) → `[]`;
   - profile `defaultValidationMode === "none"` → `[]`;
   - otherwise `DEFAULT_CHECKS = ["bun run build"]` (`objective-input-checks.ts:3`).

`--check` accepts comma- or newline-separated values and is repeatable
(`packages/receipt-app/src/factory-cli/commands/index.ts:382-386`).

### 1.6 Promotion

Promotion merges the approved integration branch into the source branch. Integration statuses
(`packages/receipt-app/src/modules/factory/types.ts:51-60`): `idle | queued | merging | validating |
validated | ready_to_promote | promoting | promoted | conflicted`.

`receipt factory promote` calls `promoteObjective`
(`packages/receipt-app/src/services/factory/runtime/objective-promote-action-runner.ts:5-19`), which:

- asserts the profile allows the `promote` dispatch action;
- runs the **promotion gate** (`packages/receipt-app/src/services/factory/promotion-gate.ts:28-49`);
- requires `integration.status === "ready_to_promote"` **and** an `activeCandidateId`, else
  `FactoryServiceError(409, "objective is not ready to promote")`.

Promotion-gate messages (exact strings, `promotion-gate.ts:31-48`) — the gate is skipped entirely
for investigation objectives:

- `Promotion gate blocked: planning receipt is missing.`
- `Promotion gate blocked: <taskId> is still blocked.`
- `Promotion gate blocked: no integrated task satisfied the objective.`
- `Promotion gate blocked: <taskId> is missing its completion contract.`
- `Promotion gate blocked: <taskId> did not record proof for the completed work.`
- `Promotion gate blocked: <taskId> still reports remaining work.`

**Auto-promote**: `policy.promotion.autoPromote` defaults to `true`
(`packages/receipt-app/src/modules/factory/defaults.ts:40-42`), **but the runtime forces it to `false`
for investigation objectives** (`packages/receipt-app/src/services/factory/runtime/objective-input-policy.ts:8-20`).
Because the checked-in profile defaults objectives to `investigation`, the practical default in this repo
is manual promotion.

### 1.7 Profile

Profiles live in `<profileRoot>/profiles/<id>/PROFILE.md` (+ optional `SOUL.md`)
(`packages/receipt-app/src/services/factory-chat-profiles.ts:14-17, 162-163`).
The canonical id is `receipt` (`factory-chat-profiles.ts:17`).

`profiles/` in this repo contains exactly one profile: `profiles/receipt/PROFILE.md` and `profiles/receipt/SOUL.md`.
Its YAML-ish JSON frontmatter declares:

- `id: "receipt"`, `label: "Beetle"`, `default: true`
- `skills`: 13 checked-in `skills/*/SKILL.md` paths
- `actionPolicy.allowedDispatchActions`: `create, react, promote, cancel, cleanup, archive`
- `actionPolicy.allowedCreateModes`: `delivery, investigation`
- `orchestration`: `executionMode: supervisor`, `discoveryBudget: 2`, `finalWhileChildRunning: reject`, `childDedupe: by_run_and_prompt`
- `defaultObjectiveMode: investigation`, `defaultValidationMode: repo_profile`,
  `defaultTaskExecutionMode: worktree`, `maxParallelChildren: 5`, `allowObjectiveCreation: true`

Resolved-profile defaults when a manifest omits a field
(`packages/receipt-app/src/services/factory-chat-profiles.ts:145-158`):
`allowedWorkerTypes: ["codex","infra","agent"]`, `defaultWorkerType: "codex"`,
`defaultTaskExecutionMode: "worktree"`, `defaultValidationMode: "repo_profile"`,
`defaultObjectiveMode: "investigation"`, `defaultSeverity: 1`, `maxParallelChildren: 5`,
`allowObjectiveCreation: true`.

Profile-root resolution walks candidates until one has a `profiles/` directory:
requested root → repoRoot → `RECEIPT_REPO_ROOT` → the installed package root
(`factory-chat-profiles.ts:177-196`).

Errors:

- `no factory profiles found under <root>/profiles` (`factory-chat-profiles.ts:506`)
- `factory profile '<id>' is not installed under <root>/profiles` (`factory-chat-profiles.ts:516`)
- `profile '<id>' is not allowed to create Factory objectives` — 403
  (`packages/receipt-app/src/services/factory/runtime/objective-create-runner-profile.ts:39-44`)

The `--profile <id>` flag on `run` / `create` / `compose` / `agent start` selects the profile
(`packages/receipt-app/src/factory-cli/commands/index.ts:4185, 4269, 4331, 3439`).
**Careful:** `--profile` means something completely different under `receipt factory simulate search`,
where it selects a search profile (`default|nightly|incident`)
(`packages/receipt-app/src/factory-cli/commands/index.ts:874-878`).

### 1.8 Execution path, computer lane, OpenSandbox

`FactoryExecutionPath` has exactly one legal value: `"computer"`
(`packages/receipt-app/src/modules/factory/types.ts:88`). There is no local/worktree-host execution path any more.

Computer execution targets: `FACTORY_COMPUTER_EXECUTION_TARGETS = ["opensandbox"]`
(`packages/receipt-app/src/modules/factory/types.ts:90-96`). `FactoryComputerProvider` is a deprecated alias.

Environment knobs (`packages/receipt-app/src/modules/factory/execution-policy.ts:22-56`):

- `RECEIPT_FACTORY_COMPUTER_PROVIDER` — defaults to `opensandbox`
- `RECEIPT_FACTORY_EXECUTION_PATH` — defaults to `computer`
- `RECEIPT_FACTORY_COMPUTER_ENABLED=true|1|false|0` — forces support on/off

OpenSandbox configuration defaults
(`packages/receipt-app/src/services/factory/opensandbox-config-default-values.ts:1-12`):

| Default | Value | Env override |
|---|---|---|
| domain | `localhost:8080` | `OPEN_SANDBOX_DOMAIN` |
| protocol | `http` | `OPEN_SANDBOX_PROTOCOL` |
| image | `receiptfactory/opensandbox-worker:local` | `OPEN_SANDBOX_IMAGE` |
| template version | `receipt-factory-opensandbox-v1` | `OPEN_SANDBOX_TEMPLATE_VERSION` |
| remote workspace root | `/workspace/receipt-workspaces` | `OPEN_SANDBOX_REMOTE_WORKSPACE_ROOT` |
| ready timeout | 120 s | `OPEN_SANDBOX_READY_TIMEOUT_SECONDS` |
| request timeout | 120 s | `OPEN_SANDBOX_REQUEST_TIMEOUT_SECONDS` |
| sandbox timeout | 3600 s | `OPEN_SANDBOX_TIMEOUT_SECONDS` |
| cpu / memory | `2` / `4Gi` | `OPEN_SANDBOX_CPU`, `OPEN_SANDBOX_MEMORY` |
| host ready timeout | 180000 ms | `OPEN_SANDBOX_HOST_READY_TIMEOUT_MS` |
| host idle stop | 1200000 ms (20 min) | `OPEN_SANDBOX_HOST_IDLE_STOP_MS` |

Additional env: `OPEN_SANDBOX_API_KEY`, `OPEN_SANDBOX_REMOTE_PATH`, `OPEN_SANDBOX_AWS_INSTANCE_ID`
(`opensandbox-config-env-optional.ts:11-20`); `OPEN_SANDBOX_AWS_REGION` (falls back to `AWS_REGION`,
`AWS_DEFAULT_REGION`, then `us-east-1`), `OPEN_SANDBOX_AUTO_START`, `OPEN_SANDBOX_AUTO_STOP`
(`opensandbox-config-env-host.ts:21-37`); `OPEN_SANDBOX_USE_SERVER_PROXY`, `OPEN_SANDBOX_SECURE_ACCESS`,
`OPEN_SANDBOX_SKIP_WORKSPACE_BOOTSTRAP`, `OPEN_SANDBOX_CLEANUP_ON_FINISH`
(`opensandbox-config-env-runtime.ts:100-140`).

Two hard guards worth documenting for self-hosters
(`opensandbox-config-env-runtime.ts:69-96`):

- `OPEN_SANDBOX_IMAGE is required for cloud OpenSandbox execution; refusing to use the local-only default image.`
- `OPEN_SANDBOX_IMAGE must reference a published image when Receipt workers use a public gateway. Refusing local-only image receiptfactory/opensandbox-worker:local. Set OPEN_SANDBOX_IMAGE to the published ECR/OpenSandbox worker image before running remote computer objectives.`

The lease object the CLI drives (`packages/receipt-app/src/services/factory/computer-lease-types.ts:7-43`):
`handle {provider, computerId, machineId?, remoteWorkspaceRoot?, capabilitySnapshot?, templateVersion?,
acquiredAt, reconstructedAt?, reconstructionCount?}` plus `exec`, `upload`, `download`, `readFile`,
`writeFile`, `probe`, `destroy`.
`exec` result: `{exitCode: number|null, signal?, stdout, stderr}`
(`computer-exec-types.ts:23-28`).

`ensureOpenSandboxHostReadyForFactory()` starts the host lifecycle and health-checks it; failure raises
`OpenSandbox host is not healthy after readiness check for <protocol>://<domain>`
(`packages/receipt-app/src/services/factory/opensandbox-computer-backend.ts:17-33`).

### 1.9 Task packet — `receipt/current/`

The worker-facing packet directory constant is
`FACTORY_TASK_PACKET_DIR = "receipt/current"`
(`packages/receipt-app/src/services/factory/task-packet-constants.ts:1`).
Paths inside a task workspace (`packages/receipt-app/src/services/factory/task-packet-paths.ts:9-30`):

```
receipt/current/objective.json           objectivePlanPath
receipt/current/task.json                planPath
receipt/current/manifest.json            manifestPath
receipt/current/context.md               contextSummaryPath
receipt/current/context-pack.json        contextPackPath
receipt/current/prompt.md                promptPath
receipt/current/output/result.json       resultPath
receipt/current/output/stdout.log        stdoutPath
receipt/current/output/stderr.log        stderrPath
receipt/current/output/last-message.md   lastMessagePath
receipt/current/evidence/evidence.json   evidencePath
receipt/current/skills/skill-bundle.json skillBundlePath
receipt/current/memory.cjs               memoryScriptPath
receipt/current/memory-scopes.json       memoryConfigPath
receipt/current/receipt-cli.md           receiptCliPath
```

Integration packets add `receipt/current/output/<candidateId>.integration.{json,stdout.log,stderr.log}`
(`task-packet-paths.ts:32-42`).

`receipt/current/` is git-ignored (`.gitignore:23`), as is `.receipt/data/`, `.receipt/factory/`,
`.receipt/tenants/`, `.receipt/efs/` and friends (`.gitignore:13-22`).

Hosted workbench storage (self-hosting readers): `buildReceiptWorkbenchPaths`
(`packages/receipt-app/src/services/factory/workbench-paths.ts:101-160`) lays out
`<storageRoot>/orgs/<orgKey>/users/<userKey>/workspaces/<workspaceKey>/repo` with `receipt/`,
`receipt/current/`, and a `.receipt` compat path, plus `orgs/<orgKey>/runs/<objectiveKey>/<taskKey>`.
`storageRoot` is `dirname(dataDir)/efs` (`workbench-paths.ts:79-80`).

### 1.10 Factory workbench — `receipt/bin/receipt-workbench`

A checked-in Node script (`receipt/bin/receipt-workbench`, ESM, no dependencies) with three commands:

- `./receipt/bin/receipt-workbench path` → prints the absolute `receipt/current` path and exits 0
  (`receipt/bin/receipt-workbench:141-144`).
- `./receipt/bin/receipt-workbench show` → materializes a **repo projection** into `receipt/current/`
  when none is mounted, then prints
  `Receipt workbench: <path>`, optional `Objective: <title>`, optional `Task: <title>`, and
  `Read receipt/current/context.md and receipt/current/receipt-cli.md.`
  (`receipt/bin/receipt-workbench:146-158`).
- `./receipt/bin/receipt-workbench finalize` → prints
  `{"resultPath": "…/receipt/current/output/result.json", "summaryPath": "…/receipt/current/output/summary.md"}`
  (`receipt/bin/receipt-workbench:160-166`).
- Anything else → stderr `Unknown receipt-workbench command: <cmd>` and exit code **2**
  (`receipt/bin/receipt-workbench:168-169`).

The repo projection is materialized only when `receipt/current` is missing, or its `config.json`
has `mode === "repo"` and `skills/registry.json` is absent
(`receipt/bin/receipt-workbench:136-140`). It writes `config.json`, `objective.json` (`objectiveId:
"repo_default"`), `task.json` (`taskId: "repo_context"`), `manifest.json`, `context-pack.json`,
`skills/{index,registry,skill-bundle}.json`, `memory-scopes.json`, `context.md`, `receipt-cli.md`,
`memory.cjs`, and `.projection/projection.json`
(`receipt/bin/receipt-workbench:26-134`).

Companion docs: `receipt/README.md` (the "Receipt Workbench" page) and `receipt/config.json`
(`{"schemaVersion":1,"kind":"receipt-workbench","current":"current","mutable":["current"]}`).

### 1.11 The `receipt` CLI session (login)

`resolveCliAuthContext` reads the saved login from `~/.receipt/session.json`
(`packages/receipt-app/src/services/receipt-cli-session.ts:23, 39-45`; override with
`RECEIPT_CLI_CONFIG_DIR` or `RECEIPT_CLI_SESSION_FILE`).

Actor resolution order (`packages/receipt-app/src/factory-cli/commands/index.ts:325-352`):

- `userId`: `--user-id` → `RECEIPT_FACTORY_USER_ID` → `RECEIPT_CONNECT_USER_ID` → session `userId` → `"cli"`
- `organizationId`: `--organization-id` → `RECEIPT_FACTORY_ORGANIZATION_ID` → `RECEIPT_CONNECT_ORGANIZATION_ID` → session `organizationId`
- `workspaceId`: `--workspace-id` → `RECEIPT_FACTORY_WORKSPACE_ID` → `RECEIPT_CONNECT_WORKSPACE_ID` → session `workspaceId` (only when the org matches)
- `source` is always `"factory-cli"`

If no organization can be resolved the CLI throws the exact message
`factory commands require --organization-id, RECEIPT_CONNECT_ORGANIZATION_ID, or a saved receipt login session`
(`commands/index.ts:341`).

Gateway resolution for objectives (`commands/index.ts:291-323`), in order:

1. `--receipt-connect-gateway-url <url>`
2. First non-empty of `RECEIPT_CONNECT_WORKER_GATEWAY_URL`, `RECEIPT_CONNECT_PUBLIC_GATEWAY_URL`,
   `RECEIPT_CONNECT_PUBLIC_URL`, `RECEIPT_CONNECT_PROD_GATEWAY_URL`, `RECEIPT_CONNECT_PROD_SERVER_URL`,
   `RECEIPT_CONNECT_PROD_URL`, `RECEIPT_CONNECT_URL`, `RECEIPT_APP_URL` — **but only if it is not a
   private/loopback URL** (`isLikelyPrivateReceiptConnectGatewayUrl`, `services/service-url.ts:106-130`).
3. The saved session's `gatewayUrl`.
4. The env value even if private.
5. `resolveReceiptConnectEndpoint({target: "prod"}).serverUrl`.

The inline comment at `commands/index.ts:311-317` explains why: the CLI loads repo `.env` files before
dispatch, so a local `RECEIPT_CONNECT_GATEWAY_URL=http://localhost:3000` would otherwise be handed to a
hosted OpenSandbox worker that cannot reach it.

---

## 2. Prerequisites

| Requirement | Where enforced |
|---|---|
| **Postgres** via `ZERO_UPSTREAM_DB` | `packages/receipt-app/src/config/runtime-env.ts:1, 20-26` — `Receipt Postgres storage requires ZERO_UPSTREAM_DB.` The Factory runtime always uses `postgresReceiptStore`/`postgresBranchStore` (`packages/receipt-app/src/factory-cli/runtime.ts:5, 106-112`). |
| **Git repo** | `receipt factory init` throws `Factory init requires a git repository. No repo found from <path>` (`commands/index.ts:2400-2404`). `resolveFactoryRuntimeConfig` throws `Factory runtime config requires a git repository or RECEIPT_REPO_ROOT. cwd=<cwd> failed: git -C <cwd> rev-parse --is-inside-work-tree` (`config.ts:319-323`). |
| **`.receipt/config.json`** | `ensureFactoryConfig` (`commands/index.ts:2551-2563`): if missing and non-interactive → `Factory is not initialized in this repo. Run \`receipt factory init\` first.` If interactive, it runs `init` inline. |
| **A `codex` binary** | Detected with `bunWhich("codex")` at init (`commands/index.ts:2417`). Init prints `Codex: <bin> (not found on PATH)` when missing (`commands/index.ts:681`). Override with `--codex-bin` or `RECEIPT_CODEX_BIN`. Task-run readiness reports `codex_missing` / `codex_auth_missing` (`modules/factory/types.ts:110-118`). |
| **A running runtime / queue worker** | `runtime.start()` only calls `service.ensureBootstrap()` (`factory-cli/runtime.ts:195-197`). Nothing in the CLI executes jobs — the jobs it enqueues are drained by the Receipt runtime (`bun run receipt:start` / `bun run start:all`). Attached commands (`run`, `resume`, `agent start --wait`) will otherwise poll forever. |
| **`receipt login`** | Needed for `organizationId` (see §1.11) and for connected-system capabilities. |
| **BYOK OpenAI key** | `receipt factory doctor` requires it and **currently always fails** — see §4.7. |
| **OpenSandbox host** | Required for anything that actually executes (`--execution-path computer` is the only path). `receipt factory agent computer status --host` probes it. |
| **`python3`** | Required by `receipt factory helper run` (`services/factory-helper-catalog.ts:602`). |

Env files loaded before dispatch, in order, later overriding earlier, but never overriding an
already-exported shell value (`packages/receipt-app/src/cli/env.ts:111-116, 138-183`):
`<repo>/.env`, `<repo>/.env.local`, `<repo>/apps/start/.env`, `<repo>/apps/start/.env.local`, then
`<repo>/.deploy-artifacts/local-up/latest.env`, `$START_ALL_ENV_FILE`, `$RECEIPT_LOCAL_ENV_FILE`,
`$VALIDATE_STACK_ENV_FILE`, `$START_ALL_ENV_FILES`, `$VALIDATE_STACK_ENV_FILES`.
Set `RECEIPT_CLI_LOAD_LOCAL_ENV=0` to skip the generated local-up file.

---

## 3. `.receipt/config.json` — the Factory CLI config

Written by `receipt factory init` and loaded by `loadFactoryConfig`
(`packages/receipt-app/src/factory-cli/config.ts:246-296`).
Discovery walks up from `cwd` looking for `<dir>/.receipt/config.json`
(`config.ts:243-256`); `--repo-root` or `RECEIPT_REPO_ROOT` pins it (`config.ts:247-250`).

### Stored shape (`config.ts:14-22`)

```jsonc
{
  "repoRoot": ".",              // relative to the dir containing .receipt/
  "dataDir": ".receipt/data",
  "codexBin": "codex",
  "repoSlotConcurrency": 20,    // optional
  "defaultChecks": ["bun run check"],
  "defaultPolicy": { … },
  "schedules": [ … ]            // optional
}
```

Resolution rules:

- `repoRoot`: `--repo-root` / `RECEIPT_REPO_ROOT` → stored `repoRoot` → `"."`, resolved against the
  directory that contains `.receipt/` (`config.ts:263-267`).
- `dataDir`: `RECEIPT_DATA_DIR` → `DATA_DIR` → stored `dataDir` → `.receipt/data` (`config.ts:268-272`).
- `codexBin`: `RECEIPT_CODEX_BIN` → stored `codexBin` → `"codex"` (`config.ts:277`).
- `repoSlotConcurrency`: `RECEIPT_FACTORY_REPO_SLOT_CONCURRENCY` → stored → **20**
  (`config.ts:62, 278-281`); coerced to `max(1, floor(n))`.
- `defaultChecks`: trimmed, de-duplicated (`config.ts:77-78, 282`).
- `defaultPolicy`: decoded then normalized (below).
- `schedules`: normalized into `HeartbeatSpec[]` (below).

Parse errors (all thrown from `parseFactoryCliStoredConfig`/helpers):

- `Factory config must be a JSON object` (`config.ts:159`)
- `Factory config defaultChecks must be an array` / `… at index <i> must be a string` (`config.ts:103-112`)
- `Factory config defaultPolicy must be an object`, and the same for
  `defaultPolicy.concurrency|budgets|throttles|promotion` (`config.ts:99-101, 114-124`)
- `Factory config schedules must be an array` (`config.ts:185`)
- `Factory config schedule at index <i> must be an object` (`config.ts:189`)
- `Factory config schedule at index <i> requires agentId` (`config.ts:191-193`)
- `Factory config schedule '<agentId>' must set intervalMs >= 1000` (`config.ts:194-198`)
- `Factory config schedule '<agentId>' requires payload to be an object` (`config.ts:199-201`)
- `Factory config has duplicate schedule id '<id>'` (`config.ts:203-205`)
- `Factory config already exists at <path>` from `writeFactoryConfig` without `--force` (`config.ts:352`)

### `defaultPolicy` — every field the loader actually reads

`decodeFactoryObjectivePolicy` (`config.ts:114-157`) reads **only** these keys; anything else in the
JSON is silently dropped. `normalizeFactoryObjectivePolicy`
(`packages/receipt-app/src/modules/factory/normalization.ts:1637-1682`) then clamps them.

| Path | Type | Default | Clamp | Meaning |
|---|---|---|---|---|
| `concurrency.maxActiveTasks` | number | **5** | 1–50 | Max tasks running concurrently for one objective |
| `budgets.maxTaskRuns` | number | **50** | 1–200 | Total task dispatch budget for the objective |
| `budgets.maxCandidatePassesPerTask` | number | **4** | 1–12 | Attempts (candidates) allowed per task |
| `budgets.maxObjectiveMinutes` | number | **1440** | 1–10080 | Wall-clock budget (24 h default, 7 d max) |
| `throttles.maxDispatchesPerReact` | number | **10** | 1–30 | Dispatches allowed per reconcile/react pass |
| `promotion.autoPromote` | boolean | **true** | — | Promote automatically once `ready_to_promote`; forced `false` for investigation objectives |

Defaults live in `DEFAULT_FACTORY_OBJECTIVE_POLICY`
(`packages/receipt-app/src/modules/factory/defaults.ts:29-43`).
Non-numeric strings are coerced with `Number()` (`config.ts:88-95`) — the test at
`packages/receipt-app/src/factory-cli/commands/index.test.ts:334-357` proves `"3"` decodes to `3`.

> **There is no `mutation` section, no `budgets.maxReconciliationTasks`, and no
> `throttles.mutationCooldownMs` in the loader or the type.** `FactoryObjectivePolicy`
> (`packages/receipt-app/src/modules/factory/types.ts:719-734`) has exactly four optional groups:
> `concurrency`, `budgets`, `throttles`, `promotion`. The repo's own `.receipt/config.json` still
> contains `budgets.maxReconciliationTasks: 8`, `throttles.mutationCooldownMs: 15000`, and
> `mutation: { aggressiveness: "balanced" }` — all three are read and discarded. Document the four
> supported groups only.

### `--policy-file <path>`

`readPolicyFile` (`commands/index.ts:685-694`) reads a JSON file and runs it through
`decodeFactoryObjectivePolicy(parsed, "policy file")`. Errors therefore read
`policy file must be an object`, `policy file.budgets must be an object`, etc.
(`commands/index.test.ts:359-367`). The parsed override is shallow-merged **per group** over
`config.defaultPolicy` by `mergePolicy` (`commands/index.ts:366-380`) — note `mergePolicy` merges
`concurrency`, `budgets`, `throttles`, `promotion` and drops any other group.

### `schedules`

Normalized into `HeartbeatSpec` entries (`config.ts:183-220`):
`enabled: false` entries are skipped; `agentId` required; `intervalMs >= 1000` required;
`payload` must be an object; `lane` defaults to `collect` (legal: `chat|collect|steer|follow_up`);
`sessionKey` defaults to `schedule:<id>`; `singletonMode` defaults to `cancel` (legal: `allow|cancel|steer`);
`maxAttempts` clamped to 1–8, default 1; `id` defaults to `schedule:<agentId>:<index+1>`.

---

## 4. Command reference

`handleFactoryCommand` order of operations (`commands/index.ts:3728-3755`):

1. If the subcommand is not `agent` and `--help` was passed → print usage for that subcommand.
2. If the subcommand itself is `help`/`--help`/`-h` → print usage for `args[1]`.
3. If `args[1]` is a help token (and subcommand ≠ `agent`) → print usage for the subcommand.
4. Parse the shared flags: `--json`, `--objective-mode`, `--execution-path`/`--execution-target`/`--computer-provider`, `--severity`.
5. Handle the **config-free** subcommands: `init`, `investigate`, `audit`, `insights`, `doctor`,
   `experiment`, `simulate`, `helper`, and bare `agent` help.
6. Everything else calls `ensureFactoryConfig` + `createFactoryCliRuntime`, then the big switch,
   with `runtime.stop()` in a `finally`.

Unknown subcommand → `Unknown factory subcommand '<x>'` (`commands/index.ts:4626`).

### 4.0 Shared flags

| Flag | Applies to | Values / default | Behaviour |
|---|---|---|---|
| `--json` | every subcommand | boolean, default off | Machine-readable output. See §5 for per-command nuances. |
| `--output-file <path>` | read commands + agent envelope | none | Writes the payload, creates parent dirs, prints a pointer instead. |
| `--objective-mode delivery\|investigation` | `run`, `create`, `compose`, `agent start/create` | unset → profile default | Anything else throws `--objective-mode must be 'delivery' or 'investigation'` (`commands/index.ts:501-509`). |
| `--severity 1..5` | same | unset → profile default (1) | Non-integer or out of range throws `--severity must be an integer between 1 and 5` (`commands/index.ts:585-595`). |
| `--execution-path computer` | same | unset → runtime default `computer` | Any other value throws `--execution-path must be 'computer'` (`commands/index.ts:510-517`). |
| `--computer-provider opensandbox` | same | unset | Other values throw `--computer-provider must be one of: opensandbox` (`commands/index.ts:519-526`). |
| `--execution-target opensandbox` | same | unset | Sets `executionPath=computer` **and** `computerProvider=<target>` (`commands/index.ts:528-545`). Other values throw `--execution-target must be one of: opensandbox`. |
| conflicts | — | — | `--execution-target conflicts with --execution-path`; `--execution-target conflicts with --computer-provider` (`commands/index.ts:562-573`). |
| `--required-capability <a,b>` (aliases `--capability`, `--connect`), `--aws` | same | none | Values are split on commas, trimmed, lower-cased, de-duplicated, sorted (`commands/index.ts:251-266`). `--aws` appends `aws`. |
| `--repo-root <path>` | most | git root of cwd | Pins the repo root / config location. |
| `--data-dir <path>` | `investigate`, `audit`, `insights`, `doctor` **only** | resolved runtime `dataDir` | `resolveFactoryReadContext` (`commands/index.ts:1911-1921`). Other read commands use the config's `dataDir`. |

> **`--model` is not a `receipt factory` flag.** The only `--model` in the CLI belongs to
> `receipt debug probe` (`packages/receipt-app/src/cli/commands.ts:3623`), defaulting to
> `DEFAULT_FACTORY_TASK_CODEX_MODEL = "gpt-5.6-luna"`
> (`packages/receipt-app/src/services/factory/runtime/factory-service-config.ts:8`). The Factory
> worker model is configured only through the `RECEIPT_FACTORY_TASK_MODEL` env var
> (`factory-service-config.ts:9-11`).

### 4.1 `receipt factory` / `receipt factory board`

```
receipt factory [--json]
receipt factory board [--json]
```

(`commands/index.ts:4159-4172`.) `case undefined:` and `case "board":` share one implementation.

- `runtime.start()` (bootstrap), then:
- `--json` **or** a non-TTY → `printBoardSnapshot` (`commands/index.ts:2757-2790`):
  - JSON: `{compose, board, selected?, live?}`
  - text: `renderBoardText` (`factory-cli/format.ts:62-105`), sections
    `== Repo ==`, `== Needs Attention ==`, `== Active ==`, `== Queued ==`, `== Completed ==`,
    `== Archived ==`, `== Selected Objective ==`, `== Live Tasks ==`.
- Interactive TTY without `--json` → the Ink terminal app (`runInteractiveFactoryApp`,
  `commands/index.ts:2565-2600`), exit code taken from the app's exit reason.

`compose` fields (`services/factory-types.ts:441-449`): `defaultBranch`, `sourceDirty`, `sourceBranch`,
`objectiveCount`, `defaultPolicy`, `profileSummary`, `defaultValidationCommands`.

> `buildComposeModel` always returns `profileSummary = "Using checked-in Factory profiles and skills only."`
> and `defaultValidationCommands = ["bun run build"]` and `defaultPolicy = DEFAULT_FACTORY_OBJECTIVE_POLICY`
> (`services/factory/runtime/objective-read-board-compose-live.ts:42-57`;
> `services/factory-types.ts:41-42`). Nothing is actually detected from the repo.

### 4.2 `receipt factory init`

```
receipt factory init [--repo-root <path>] [--data-dir <path>] [--codex-bin <path>]
                     [--yes] [--force] [--json]
```

(`commands/index.ts:2394-2549`.)

- Resolves `repoRoot` from `--repo-root` → git root of cwd → cwd, then requires a git repo.
- `--data-dir` default `.receipt/data` (resolved against `repoRoot`).
- `--codex-bin` default: the flag → `codex` if it is on `PATH` → `RECEIPT_CODEX_BIN` → `"codex"`
  (`commands/index.ts:2417-2422`).
- Interactive and not `--yes`: prints `Receipt Factory setup`, then prompts
  `Data directory` (placeholder `.receipt/data`) and `Codex executable` (placeholder `codex`).
  Cancelling prints `Factory setup canceled.` and throws `Factory setup canceled`
  (`commands/index.ts:2371-2392`).
- Shows a spinner `Profiling repository: collecting repository status and Factory defaults`, then
  `Repository profile collected in <dur>`.
- Prints a summary block (`printSetupSummary`, `commands/index.ts:656-684`):

```
Repository profiling
  › Using checked-in Factory profiles and skills only.

Detected setup
  › Repo root: <path>
  › Data dir: <path>
  › Branch: <branch>[ (dirty)]
  › Profile: Using checked-in Factory profiles and skills only.
  › Validation: bun run build
  › Codex: codex[ (not found on PATH)]
```

(`›` is `terminalTheme.glyphs.pointer`, which becomes `>` when `RECEIPT_FORCE_ASCII=1` or `TERM=dumb` —
`factory-cli/theme.tsx:19, 39`.)

- Then confirms `Use detected validation commands?\n<commands>`; declining prompts for
  `Validation commands (comma or newline separated)` (placeholder `bun run build`).
- Writes `.receipt/config.json`. Without `--force` an existing file raises
  `Factory config already exists at <path>` (`config.ts:352`).
- Output:
  - `--json`: `{ ok: true, config, profileSummary, environment: { bunRuntime, codexPath, codexAvailable, openAiReady: false, sourceBranch, sourceDirty } }` — note `openAiReady` is hard-coded `false` (`commands/index.ts:2517-2530`).
  - interactive: an outro with
    `Factory config written to <path>` / `Next: bun run factory` /
    `Create objective: bun run factory run --title "Mission" --prompt "Describe the change"`.
  - non-interactive: `factory config written: <path>`.

### 4.3 `receipt factory run`

```
receipt factory run [prompt words…] [--prompt <text>|--problem <text>] [--title <text>]
                    [--initial-task 'title::prompt']… [--parallel-task …]
                    [--initial-tasks-json '[…]'] [--check <cmd[,cmd]>]…
                    [--profile <id>] [--policy-file <path>] [--base-hash <sha>]
                    [--channel <name>] [--objective-mode …] [--severity …]
                    [--execution-path computer] [--execution-target opensandbox]
                    [--computer-provider opensandbox] [--required-capability …] [--aws]
                    [--user-id <id>] [--organization-id <id>] [--workspace-id <id>]
                    [--receipt-connect-gateway-url <url>] [--json]
```

(`commands/index.ts:4173-4253`.)

- Prompt: `--prompt` → `--problem` → trailing words. Missing → `factory run requires --prompt or trailing prompt text`.
- Title: `--title`, else derived from the prompt's first sentence, clipped to 96 chars with `…`
  (`factory-cli/composer.ts:118-127`).
- Creates the objective, then **stays attached**:
  - `--json` or non-TTY: `waitForObjectiveTerminal` then `printObjectiveSnapshot`, exit code from the wait.
  - interactive: the Ink app with `exitOnTerminal: true`, then prints the snapshot.

`waitForObjectiveTerminal` (`commands/index.ts:2643-2745`) polls every
`FACTORY_CLI_WAIT_POLL_MS = 2000` ms or wakes on a runtime event (`commands/index.ts:2602, 2611-2635`).
On a TTY it rewrites a single progress line built by `renderObjectiveWaitLine`
(`commands/index.ts:605-654`), which looks like:

```
[abc123] Collecting evidence · Gathering evidence for the active task. · <detail> · <highlight> · audit running · Next: <next action>
```

Non-TTY prints the line only when it changes, or at least every 10 s.

**Exit codes** (`commands/index.ts:2696-2716`, mirrored in `factory-cli/app.tsx:98-106`):

| Objective condition | code | reason |
|---|---|---|
| `status = completed` | 0 | `completed` |
| `status = failed` | 1 | `failed` |
| `status = canceled` | 1 | `canceled` |
| `status = blocked` | 2 | `blocked` |
| `integration.status = conflicted` | 1 | `integration_conflicted` |
| `!policy.promotion.autoPromote && integration.status = ready_to_promote` | 2 | `manual` |
| user quits the TUI | 0 | `quit` |

When the objective reaches a terminal status the CLI enqueues a `factory.objective.audit` job
(`ensureObjectiveAuditQueued`, `commands/index.ts:800-839`) on agent `factory-control`, lane `collect`,
session key `factory:audit:<objectiveId>`, `singletonMode: "steer"`, `maxAttempts: 1`. If the terminal
receipt snapshot is missing it throws
`cannot audit <objectiveId>: terminal receipt snapshot is unavailable`, which is reported as
`factory audit enqueue failed after terminal objective: <message>` and does not change the exit code.
The CLI then waits up to `FACTORY_CLI_TERMINAL_AUDIT_WAIT_MS = 10000` ms for the audit
(skipped entirely in `--json`/quiet mode) (`commands/index.ts:2603, 2718-2740`).

### 4.4 `receipt factory create`

Same flag surface as `run` (`commands/index.ts:4254-4310`) but returns immediately after the mutation.
Missing prompt → `factory create requires --prompt or trailing prompt text`.
Output is a mutation result (§5.1).

### 4.5 `receipt factory compose`

```
receipt factory compose [--objective <id>] --prompt <text> [ … same flags as create … ]
```

(`commands/index.ts:4311-4370`.) Missing prompt → `factory compose requires --prompt or trailing prompt text`.

Semantics (`services/factory/runtime/objective-note-action-runner.ts:64-72`):
with `--objective <id>` it *reacts* to the existing objective with the prompt as an operator note;
without it, it creates a new objective. The mutation result's `action` is always `"compose"`, with
`note` set to the prompt in the react case; the text renderer then prints `reacted <objectiveId>`
(`commands/index.ts:2358-2364`).

`compose` does **not** forward `--computer-provider` (only `--execution-path`) —
compare `commands/index.ts:4348` with `create` at `4287`.

### 4.6 `receipt factory watch` / `inspect`

```
receipt factory watch <objective-id>  [--panel <name>] [--json]
receipt factory inspect <objective-id> [--panel <name>] [--watch] [--interval-ms <n>] [--json]
```

(`commands/index.ts:4371-4438`.)

- Missing id → `factory watch requires <objective-id>` / `factory inspect requires <objective-id>`.
- `watch`: `--json` or non-TTY prints a one-shot snapshot; interactive TTY opens the TUI focused on
  that objective.
- `inspect`: never opens the TUI. With `--watch` it re-renders on an interval
  (`--interval-ms`, default **1000**, clamped 250–60000) and only prints when the rendered output
  changes, separated by `\n---\n` in text mode (`commands/index.ts:2827-2844`). Without `--watch`
  it calls `service.ensureBootstrap()` and prints once.

**Panels** (`parsePanel`, `commands/index.ts:747-766`) — accepted values:
`overview`, `report`, `tasks`, `candidates`, `evidence`, `activity`, `live`, `debug`, `receipts`.
Anything else silently falls back to `overview`.

- The TUI additionally has an `analysis` panel (`factory-cli/view-model.ts:11-45`), but
  `parsePanel` will never return it and `renderObjectivePanelText` has no case for it
  (`factory-cli/format.ts:126-233`), so `--panel analysis` behaves as `overview`.
- The default panel when `--panel` is omitted is chosen by `defaultObjectivePanelForDetail`
  (`factory-cli/investigation-report.ts:41-47`): `report` for an investigation objective that has a
  synthesized report (or is completed with reports), unless the latest handoff body looks like a
  Markdown table, in which case `overview`.

JSON payload: `{objectiveId, panel, data}` where `data` is the panel value
(`commands/index.ts:2802-2825`, `panelValue` at `696-745`):

| panel | `data` |
|---|---|
| `overview` | `{header, prompt, checks, policy, blockedExplanation, latestDecision}` |
| `report` | `{objectiveId, objectiveMode, severity, report, synthesized, reports, artifacts}` |
| `tasks` | `detail.tasks` |
| `candidates` | `detail.candidates` |
| `evidence` | `detail.evidenceCards` |
| `activity` | `detail.activity` |
| `live` | the live projection |
| `debug` | the debug projection |
| `receipts` | `detail.recentReceipts` |

Text mode prints the header (`factory-cli/format.ts:107-119`):

```
objective=<id>
title=<title>
state=<displayState> · <phaseDetail> · authority:<statusAuthority> slot=<slotState>[ q=<n>]
integration=<status>
mode=<mode> severity=<n>
execution=<executionPath>
elapsed=<n>m
task-runs=<used>/<maxTaskRuns>
head=<8-char sha>
next=<next action|none>
```

followed by a `== <Panel> ==` section.

### 4.7 Read/analysis commands

All four of these bypass `.receipt/config.json` loading and use `resolveFactoryReadContext`
(`--repo-root`, `--data-dir`).

#### `receipt factory investigate`

```
receipt factory investigate [<objectiveId|taskId|candidateId|jobId|runId>]
  [--json] [--compact] [--output-file <path>] [--as-of-ts <ts>]
  [--timeline-limit <n>] [--context-chars <n>] [--repo-root <p>] [--data-dir <p>]
```

(`commands/index.ts:3760-3768`, `2225-2262`.)

- The target argument is **optional in code** even though the usage string shows it as required; omitting
  it resolves the most recently updated objective stream (`parse/index.ts:589-600`).
- `--compact` changes two defaults: `--timeline-limit` 20 → 12 (clamped 1–1000) and
  `--context-chars` 1200 → 700 (clamped 200–20000).
- `--as-of-ts <epoch-ms>` replays the chain as of a timestamp.
- Text output starts `# Factory Receipt Investigation` with sections
  `## What Happened`, `## Latency`, `## Assessment`, plus task/candidate/job/timeline lines
  (`factory-cli/investigate.ts:1348-1447`).
- The JSON report (`investigate.ts:151-191`) carries `requestedId`, `resolved`, `links`, `warnings`,
  `summary.whatHappened`, `objectiveMode`, `window`, `inputs`, `outputs`, `latency`,
  `canonicalEvidenceBundle`, `dag`, `packetContext`, `timeline`, `tasks`, `candidates`, `jobs`,
  `agentRuns`, `anomalies`, `audit`, `recommendations`, `autoFixObjectiveId`, `interventions`,
  `assessment`.
- Warnings you can hit: `Persisted objective audit is stale relative to the latest objective update.`,
  `Audit recommendation generation failed: <error>`,
  `Invalid canonical evidence bundle at <path>: <error>` (`investigate.ts:1252-1281`).

#### `receipt factory audit`

```
receipt factory audit [--limit <n>] [--objective <id>] [--json] [--output-file <path>]
                      [--repo-root <p>] [--data-dir <p>]
```

(`commands/index.ts:3769-3777`, `2264-2284`.) `--limit` default **12**, clamped 1–200.
Text output starts `# Factory Receipt Audit` with `## Summary`, `## Improvement Signals`,
`## Top Anomalies`, `## Auto-Fix Feedback`, `## Memory Hygiene`, `## Objectives`, `## Warnings`
(`factory-cli/audit.ts:502-587`).
Failure on a targeted objective: `Failed to audit objective <id>: <message>` (`audit.ts:370`).

#### `receipt factory insights`

```
receipt factory insights [--limit <n>] [--objective <id>] [--json] [--output-file <path>]
```

(`commands/index.ts:3778-3786`, `2286-2306`.) `--limit` default **8**, clamped 1–50.
JSON carries `schema: "receipt.factory.insights.v1"` (`factory-cli/insights.ts:65`).
Text starts `# Factory Receipt Insights` with `## Summary`, `## Improvement Insights`,
`## Recurring Anomalies`, `## Objectives`, `## Agent Use` (which lists
`recommendedReadOrder` and `Next commands:`), `## Warnings` (`insights.ts:495-556`).

#### `receipt factory doctor`

```
receipt factory doctor <objectiveId|taskId|candidateId|jobId|runId>
  [--json] [--compact] [--output-file <path>] [--repo-root <p>] [--data-dir <p>]
```

(`commands/index.ts:3787-3794`, `2308-2327`.)
Missing target → `factory doctor requires <objectiveId|taskId|candidateId|jobId|runId>`.

It builds a deterministic evidence bundle and then asks an LLM for a structured review
(verdict `accept|steer|react|requeue|investigate_more`, confidence, memory/context/answer scores,
recommended action) (`factory-cli/doctor.ts:12-45`), writing
`<dataDir>/factory/artifacts/<objectiveId>/doctor.json` and `doctor.md`
(or `.../artifacts/doctor/<safeId>/…` when there is no objective) (`doctor.ts:462-487`).
Text output starts `# Factory Doctor` with `## Principal Engineer Summary`, `## Memory`,
`## Context`, `## Final Answer`, `## Recommended Action`, `## Evidence Signals`
(`doctor.ts:511-570`).

> **Known-broken today.** `runFactoryDoctorReview` opens with
> `const byokApiKey: string | undefined = undefined;` and immediately
> `if (!byokApiKey) throw new Error("Organization BYOK key required for factory doctor review");`
> (`packages/receipt-app/src/factory-cli/doctor.ts:449-451`). No code path can set it, so
> `receipt factory doctor <id>` **always** fails with
> `error: Organization BYOK key required for factory doctor review`. The deterministic-signal
> helpers are still unit-tested (`factory-cli/doctor.test.ts`) and reused by other commands.
> Document `factory doctor` as unavailable, or omit it, until this is wired to BYOK.

### 4.8 Receipt/stream read commands

These four **do** load `.receipt/config.json` (so they need `factory init` first) and use its `dataDir`.

| Command | Syntax | Notes |
|---|---|---|
| `replay` | `receipt factory replay <objective-id> [--json] [--output-file <path>]` | `commands/index.ts:4439-4450`. Missing id → `factory replay requires <objective-id>`. Returns `{objectiveId, stream, receiptCount, status, latestSummary, blockedReason, archivedAt, updatedAt, workflow:{activeTaskIds, readyTaskIds, pendingTaskIds, completedTaskIds, blockedTaskIds}, tasks[], candidates[], integration}` (`commands/index.ts:2055-2081`). |
| `replay-chat` | `receipt factory replay-chat <chat-or-run-stream> [--json] [--output-file <path>]` | `commands/index.ts:4451-4462`. Missing arg → `factory replay-chat requires <chat-or-run-stream>`. Returns `{stream, receiptCount, latestObjectiveId, runs[], threadTimeline[]}` (`commands/index.ts:2106-2200`). Errors with `No receipts found for <stream>`. |
| `analyze` | `receipt factory analyze <objective-id> [--json] [--output-file <path>]` | `commands/index.ts:4463-4477`. Missing id → `factory analyze requires <objective-id>`. Rich metrics report (`factory-cli/analyze.ts:278-370`) rendered as text by `renderObjectiveAnalysisText` (`analyze.ts:1531-1580`) with `Metrics:`, `Anomalies:`, `Recommendations:`, `Top Tools:`, `Top Tool Transitions:`, `Runs:`, `Objective Sequence:`. |
| `parse` | `receipt factory parse [<objectiveId\|taskId\|candidateId\|jobId\|runId>] [--json] [--output-file <path>]` | `commands/index.ts:4478-4490`. Target optional → latest objective. |

**Target resolution used by `parse`, `investigate`, `audit` (targeted), and `doctor`**
(`factory-cli/parse/index.ts:583-706`), in order, with the resulting `matchedBy`:

1. empty or `latest` → newest objective stream (`latest`); none → `No objective receipt streams found under <dataDir>`
2. exact stream name (`exact-stream`)
3. `factory/objectives/<id>` (`objective-id`)
4. `jobs/<id>` (`job-id`)
5. any stream ending `/runs/<id>` (`run-id`)
6. any stream ending `/sessions/<id>` without `/runs/` (`chat-id`)
7. ids starting `task_` or containing `_candidate_` → scan objective chains (`task-id` / `candidate-id`)
8. substring match on stream names (`fuzzy-stream`)
9. otherwise `Unable to resolve factory receipt target '<id>'`

### 4.9 `receipt factory resume`

```
receipt factory resume <objective-id> [--json]
```

(`commands/index.ts:4491-4512`.) Missing id → `factory resume requires <objective-id>`.
Calls `reactObjectiveMutation` and then attaches exactly like `run`.

**Critical behaviour:** reacting to an objective at a *continuation boundary* creates a **brand new
objective** with a fresh id rather than reviving the old one
(`services/factory/runtime/objective-note-action-runner.ts:42-62`). The default continuation message is:
`Retry the objective from its last durable state. Reuse verified prior evidence, but create fresh task,
candidate, and job authority instead of reviving superseded execution ids.`
That is why the CLI re-reads `resumed.objectiveId` before waiting.

### 4.10 Objective mutations

| Command | Syntax | Error when the argument is missing | Notes |
|---|---|---|---|
| `react` | `receipt factory react <objective-id> [message words…] [--message <text>]` | `factory react requires <objective-id>` | `commands/index.ts:4513-4526`. Message is optional. |
| `note` | `receipt factory note <objective-id> [message words…] [--message <text>]` | `factory note requires <objective-id>` / `factory note requires --message or trailing note text` | `commands/index.ts:4527-4545`. Appends an operator note **without** reacting. |
| `promote` | `receipt factory promote <objective-id>` | `factory promote requires <objective-id>` | `commands/index.ts:4546-4553`. See §1.6 for the gate errors. |
| `cancel` | `receipt factory cancel <objective-id> [--reason <text>]` | `factory cancel requires <objective-id>` | `commands/index.ts:4554-4564`. `--reason` defaults to the literal string `canceled from CLI`. Cancels objective-scoped jobs then emits the cancel + handoff receipts. |
| `cleanup` | `receipt factory cleanup <objective-id>` | `factory cleanup requires <objective-id>` | `commands/index.ts:4565-4572`. Cancels objective-scoped jobs with reason `factory objective cleanup` and removes task worktrees/runtime workspaces (`objective-lifecycle-action-runner.ts:49-68`). |
| `archive` | `receipt factory archive <objective-id>` | `factory archive requires <objective-id>` | `commands/index.ts:4573-4580`. Cancels jobs with reason `factory objective archived`, emits an archive receipt if not already archived, rebalances slots. |

All of these are wrapped in an optimistic-concurrency retry (4 attempts, 25/50/75 ms backoff) that
recognises `Expected prev hash …` and `… advanced before applying a mutation`
(`factory-cli/actions.ts:60-76`).

Profile gating: every action asserts `assertObjectiveProfileDispatchActionAllowed`, so a profile whose
`actionPolicy.allowedDispatchActions` omits an action will reject it.

### 4.11 Job control

| Command | Syntax | Errors |
|---|---|---|
| `abort-job` | `receipt factory abort-job <job-id> [reason words…] [--reason <text>]` | `factory abort-job requires <job-id>` (`commands/index.ts:4581-4592`) |
| `steer` | `receipt factory steer <job-id> [message words…] [--message <text>]` | `factory steer requires <job-id>`; `factory steer requires --message or trailing message text` (`commands/index.ts:4593-4608`) |
| `follow-up` | `receipt factory follow-up <job-id> [message words…] [--message <text>]` | `factory follow-up requires <job-id>`; `factory follow-up requires --message or trailing message text` (`commands/index.ts:4609-4624`) |

Runtime-side errors (`services/factory/runtime/queue-intervention-command.ts:26-49`,
`queue-intervention-runner.ts:34, 52`):

- `job not found` (404)
- `steer message required` / `follow-up message required` (400)
- `job <jobId> is <status>; send the follow-up to its objective to continue in a new run` (409)
- `job <jobId> became <status>; send the follow-up to its objective to continue in a new run` (409)

`abort` is exempt from the active-status check, so you can abort a finished job.
The `by` field defaults to `factory.cli` (`queue-intervention-runner.ts:24, 32, 49`).

### 4.12 `receipt factory experiment`

```
receipt factory experiment <long-run|inner-loop-ab>
  [--json] [--output-dir <path>] [--codex-bin <path>] [--keep-workdir] [--keep-worktrees]
  [--repo-root <path>]
```

(`commands/index.ts:3795-3840`.) Default scenario when omitted is `long-run`
(`commands/index.ts:3796`). Any other scenario →
`Unsupported factory experiment scenario '<x>'. Use 'long-run' or 'inner-loop-ab'.`

- `long-run` clones the repo into `<evidenceDir>/sandbox`, checks out `codex/<experimentId>`, and drives
  a full objective through a generated Codex stub unless `--codex-bin` supplies a real one
  (`factory-cli/experiment.ts:691-966`). `--keep-workdir` keeps the sandbox clone.
- `inner-loop-ab` runs two worktree arms (`current` vs `forward-looking`) and compares them
  (`experiment.ts:1128-1197`). `--keep-worktrees` keeps them.
- Report shapes: `FactoryLongRunExperimentReport` (`experiment.ts:176-202`) and
  `FactoryInnerLoopWorktreeExperimentReport` (`experiment.ts:226-…`).
- Text output starts `# Factory Long-Run Experiment` with `## Assessment` and `## Bundle`
  (`experiment.ts:657-689`), listing `Summary`, `Transcript`, `Artifacts`, `Timeline`,
  `Investigate JSON/Text`, `Audit JSON/Text` paths.
- Errors you can hit: `factory create returned a non-object JSON payload`,
  `factory create did not return an objectiveId`, `factory investigate JSON is missing outputs`,
  `Timed out waiting for an active Factory job for <objectiveId>`, `factory resume exited with <code>`,
  `inner-loop A/B experiment did not produce both arms`.

### 4.13 `receipt factory simulate`

The deterministic-simulation harness. Every scenario exits with `process.exitCode = 1` when it produces
failures.

```
receipt factory simulate [<scenario>] [flags]
receipt factory simulate search [flags]
receipt factory simulate corpus <add|reduce|promote> [flags]
```

Named sub-suites (`commands/index.ts:3841-4083`):
`search`, `corpus add|reduce|promote`, `useful-gate`, `generic-agent-loop`, `projection-ui`,
`prod-replay`, `deterministic-runtime`, `runtime-outbox`, `runtime-status-polling`,
`projection-serving-fairness`, `funding-settlement`, `cross-channel-ingress`, `self-improvement`,
`reliability-suite`.

Fixture scenarios (`factory-cli/simulate.ts:48-55`), the fallback path when `args[1]` is not one of the above:
`ec2-list-happy`, `ec2-list-missing-scriptsrun`, `missing-semantic-result`,
`missing-semantic-result-codex-takeover`, `missing-semantic-result-preserved-evidence`,
`retry-after-useful-answer-sentinel`. Default when omitted: `ec2-list-missing-scriptsrun`
(`simulate.ts:4178-4186`). Unknown scenario →
`Unsupported factory simulation scenario '<x>'. Use search, useful-gate, deterministic-runtime,
runtime-outbox, self-improvement, reliability-suite, or <the six fixture names>.`

Flags:

| Flag | Default | Notes |
|---|---|---|
| `--profile default\|nightly\|incident` (alias `--search-profile`) | `default` | Sets seeds/repeat: `default {seeds:25, repeat:1}`, `nightly {100, 2}`, `incident {250, 2}` (`commands/index.ts:848-865`). Invalid → `--profile must be one of: default, nightly, incident`. |
| `--seeds <n>` | from profile | clamped 1–1000 |
| `--repeat <n>` | from profile | clamped 1–5 |
| `--seed <n>` | unset | base seed; also the required arg for `corpus add` |
| `--corpus default\|none\|<path>` (alias `--seed-corpus`) | none | `default` resolves to `packages/receipt-app/src/services/factory/sims/fixtures/search-regression-corpus.json` (`commands/index.ts:866`) |
| `--corpus-file <path>` (alias `--seed-corpus-file`) | none | explicit corpus file |
| `--corpus-only` | off | seeds set to 0; requires a corpus, else `--corpus-only requires --corpus or --corpus-file` |
| `--coverage-floor <metric>=<value>` (repeatable) | built-in floors | metric must be one of the 60+ keys in `SEARCH_COVERAGE_FLOORS` (`simulate.ts:1527-1592`), else `--coverage-floor must be metric=value where metric is one of: …`; negative/NaN → `--coverage-floor <metric>=<value> must use a non-negative number` |
| `--require-property <id\|all>` (alias `--required-property`, repeatable, comma-separated) | none | ids listed below; unknown → `Unknown reliability property '<x>'. Use <list>.` |
| `--expect-coverage-digest <sha256>` (alias `--coverage-digest`) | none | mutually exclusive with `--coverage-baseline`: `use either --expect-coverage-digest or --coverage-baseline, not both` |
| `--coverage-baseline <artifact.json>` (alias `--coverage-baseline-file`) | none | must contain `coverageDigest`, else `coverage baseline <path> must contain coverageDigest` |
| `--input <path>` | none | prod-replay receipts JSON/dir, a search artifact, or a reduced corpus |
| `--case <id>` | none | focus one case |
| `--fault <plan>` / `--fault-plan <plan>` | none | `projection-ui` only |
| `--shrink` (alias `--minimize`) | off | `corpus reduce` only |
| `--skip-verify` / `--no-verify` | off | `corpus reduce` only |
| `--allow-unverified` | off | `corpus promote` only |
| `--reason <text>` / `--note <text>` | derived | corpus seed annotation |
| `--trace all\|failures\|none` | `failures` | JSON only; strips `trace` and `schedulerSteps` keys unless a failure is present (`commands/index.ts:1709-1743`). Invalid → `--trace must be one of: all, failures, none` |
| `--json`, `--output-file <path>`, `--repo-root <path>` | — | |

Reliability property ids (`simulate.ts:263-275`):
`deterministic_environment_control`, `scheduler_interleaving_exploration`, `fault_campaign_composition`,
`deterministic_replay`, `scheduled_fault_injection`, `state_space_expansion`,
`receipt_projection_convergence`, `external_system_faults`, `production_receipt_replay`,
`production_regression_adversaries`, `load_redrive_pressure`. `all` expands to every id.
A missing/failed required property yields failure code
`simulation_search_reliability_property_not_passed` with message
`Required Factory simulation reliability property '<id>' did not pass.` (`simulate.ts:2600-2613`).

`corpus` subactions:

- `corpus add --seed <n> [--corpus/--corpus-file <target>] [--reason <text>] [--json]`
  (`commands/index.ts:1073-1107`). Missing seed → `factory simulate corpus add requires --seed <non-negative-number>`.
  Text output: `Corpus file: …`, `Seed: …`, `Added: yes|no`, `Corpus seeds: <n>`.
- `corpus reduce --input <search-artifact.json> --corpus-file <out.json> [--shrink] [--skip-verify]`
  (`commands/index.ts:1435-1535`). Errors:
  `factory simulate corpus reduce requires --input <search-artifact.json>`,
  `factory simulate corpus reduce requires exactly one corpus target`,
  `factory simulate corpus reduce --shrink requires verification; remove --skip-verify`,
  `reduced simulation corpus did not reproduce <caseId>; first replay failure was <caseId|none>`.
  Text output lists `Corpus file`, `Input artifact`, `First failure`, `Verification`,
  `Minimization`, `Corpus seeds`, `Search replay`, `Next commands:`.
- `corpus promote --input <reduced-corpus.json> [--corpus/--corpus-file <target>] [--allow-unverified]`
  (`commands/index.ts:1618-1692`). Errors:
  `factory simulate corpus promote requires --input <reduced-corpus.json>`,
  `factory simulate corpus promote requires a verified reduced corpus; pass --allow-unverified to override`.
- Any other action → `receipt factory simulate corpus supports: add, reduce, promote`.

Repo scripts that wrap this (`packages/receipt-app/package.json:54-57`):
`simulate:search`, `simulate:search:corpus`, `simulate:search:repeat`, `simulate:search:nightly`.

### 4.14 `receipt factory helper` (undocumented in the CLI usage text)

```
receipt factory helper list [--provider aws|gcp|azure] [--domain <name>] [--repo-root <p>] [--json]
receipt factory helper run <helper-id> [helper args…] [--helper-arg <v>]…
                           [--provider aws|gcp|azure] [--domain <name>] [--json]
```

(`commands/index.ts:4085-4134`.)

- `--domain` defaults to `infrastructure`.
- `--provider` defaults to `aws`; anything other than `aws|gcp|azure` throws
  `Unsupported helper provider '<x>'. Use aws, gcp, or azure.` (`commands/index.ts:1923-1932`).
- `helper run` without an id → `factory helper run requires a helper id`.
- Any other subcommand → `Unsupported factory helper command '<x>'. Use 'list' or 'run'.`
- `helper list` text prints, per helper: `<id> (<provider>)`, an indented description, and `tags: …`.
- `helper run` shells out to `python3 skills/factory-helper-runtime/runner.py run --provider <p>
  --domain <d> --json <helperId> -- <args…>` from the profile root
  (`services/factory-helper-catalog.ts:580-611`), and sets `process.exitCode = 1` when
  `result.status === "error"`.
- The catalog lives at `skills/factory-helper-runtime/catalog/<domain>/<helperId>/manifest.json`
  (`factory-helper-catalog.ts:19, 426-439`); the repo ships ~20+ AWS helpers under
  `skills/factory-helper-runtime/catalog/infrastructure/`.

---

## 5. Output contracts

### 5.1 Mutation JSON (non-agent write commands)

`printMutationResult` (`commands/index.ts:2339-2369`):

```jsonc
// objective mutations: create | compose | note | react | promote | cancel | cleanup | archive
{ "ok": true, "kind": "objective", "action": "create",
  "objectiveId": "objective_…", "objective": { /* FactoryObjectiveDetail */ },
  "note": "…"            // only when a note/prompt was attached
}

// job mutations: abort | steer | follow_up
{ "ok": true, "kind": "job", "action": "steer",
  "jobId": "job_…", "job": { /* QueueJob */ }, "commandId": "…" }
```

Text mode prints one line: `<action> <objectiveId>` — with two special cases: `note` renders as
`noted <objectiveId>`, and a `compose` that carried a note renders as `reacted <objectiveId>`.
Job mutations print `<action> queued for <jobId>` (so `follow_up queued for job_…`).

Action names come from `factory-cli/actions.ts:21-30`:
objective actions `create | compose | note | react | promote | cancel | cleanup | archive`;
job actions `abort | steer | follow_up`.

### 5.2 The Factory agent envelope

Defined at `commands/index.ts:1741-1806`:

```jsonc
{
  "schema": "receipt-cli/factory-agent-envelope/1",
  "type": "factory.agent.envelope",
  "ok": true,
  "command": "factory.agent.inspect",       // or factory.agent.computer.exec, etc.
  "mode": "read",                            // "read" | "write"
  "data": { /* command-specific */ },
  "error": null,
  "artifactRefs": [
    { "kind": "artifact", "ref": "/abs/path", "label": "stdout",
      "bytes": 1234, "sha256": "…" }         // label/bytes/sha256 optional
  ],
  "nextCommands": ["receipt factory agent investigate objective_…"]
}
```

Error envelope (`commands/index.ts:1783-1810`):

```jsonc
{
  "schema": "receipt-cli/factory-agent-envelope/1",
  "type": "factory.agent.envelope",
  "ok": false,
  "command": "factory.agent.inspect",
  "mode": "read",
  "data": null,
  "error": {
    "code": "FACTORY_SERVICE_409",           // or "FACTORY_AGENT_COMMAND_FAILED"
    "message": "<error message>",
    "hint": "Run `receipt factory agent help` for the supported agent-first command surface.",
    "details": { "status": 409 }             // present only for FactoryServiceError
  },
  "artifactRefs": [],
  "nextCommands": []
}
```

`process.exitCode` is set to 1 on the error path (`commands/index.ts:3717`).
`code` is `FACTORY_SERVICE_<httpStatus>` when the thrown error is a `FactoryServiceError`, otherwise
`FACTORY_AGENT_COMMAND_FAILED`.

`command` is `factory.agent.<action>`, except computer commands which are
`factory.agent.computer.<subaction>` or `factory.agent.opensandbox.<subaction>`
(`commands/index.ts:3481-3486`).

`mode` is `"write"` for `start`, `create`, `steer`, `follow-up`, `react`, `resume`, and for
computer `exec|run|write|upload|download`; `"read"` otherwise (`commands/index.ts:3487-3496`).

**`--output-file` on an agent command** writes the *full* envelope to disk and prints a second,
small envelope whose `data` is `{outputFile, format: "json", bytes, sha256}`, whose
`artifactRefs[0]` is `{kind:"artifact", ref:<path>, label:"Factory agent envelope", bytes, sha256}`,
and whose `nextCommands` is `["cat <path>"]` (`commands/index.ts:1812-1845`).

### 5.3 `--output-file` on non-agent read commands

`printFactoryReadOutput` (`commands/index.ts:1872-1898`):

- JSON mode → writes the JSON and prints `{ "ok": true, "outputFile": "<abs>", "format": "json", "bytes": <n>, "sha256": "<hex>" }`.
- Text mode → writes the text and prints `wrote <abs path>` on stdout.
- Parent directories are created automatically.

### 5.4 TTY-sensitive JSON switching (an inconsistency to document)

- `replay`, `replay-chat`, `analyze`, `parse` use `asJson: json || !isInteractiveTerminal()`
  (`commands/index.ts:4444, 4457, 4470, 4484`) — **piping them produces JSON even without `--json`.**
- `investigate`, `audit`, `insights`, `doctor` use `asJson: json` only
  (`commands/index.ts:3763, 3772, 3781, 3790`) — they stay text when piped.
- `board`, `run`, `resume`, `watch` switch to the non-interactive code path when not a TTY but still
  honour `json` for the format.
- `inspect` always formats by `--json` alone.

---

## 6. `receipt factory agent …` — the machine surface

Dispatcher: `handleFactoryAgentCommand` (`commands/index.ts:3470-3721`).

`receipt factory agent`, `receipt factory agent help`, `receipt factory agent --help`, and
`receipt factory agent -h` print the help envelope **before** the config is loaded
(`commands/index.ts:4136-4140`), so they work in a repo without `.receipt/config.json`.
Every other agent action goes through `ensureFactoryConfig` first.

### 6.1 `agent board` (alias `list`)

`command: factory.agent.board`, mode `read` (`commands/index.ts:3500-3545`).
`data`: `{compose, board, selected?, live?, activeStreams?, activeStreamsByObjective?}` where
`activeStreamsByObjective` is `[{objectiveId, activeStreams}]` for every board objective with active
task streams. `nextCommands` are the five objective commands (below) when an objective is selected,
otherwise `["receipt factory agent start --prompt \"...\""]`.

`objectiveNextCommands` (`commands/index.ts:2923-2929`):

```
receipt factory agent inspect <objectiveId>
receipt factory agent output <objectiveId>
receipt factory agent computer status <objectiveId>
receipt factory agent investigate <objectiveId>
receipt factory agent context <objectiveId>
```

### 6.2 `agent start` / `agent create`

```
receipt factory agent start [prompt words…] --prompt <text> [--wait]
  [--title …] [--initial-task …] [--initial-tasks-json …] [--check …] [--profile …]
  [--policy-file …] [--base-hash …] [--channel …] [--objective-mode …] [--severity …]
  [--execution-path computer] [--execution-target opensandbox] [--computer-provider opensandbox]
  [--required-capability …|--capability …|--connect …|--aws]
  [--user-id …] [--organization-id …] [--workspace-id …] [--receipt-connect-gateway-url <url>]
  [--output-file <path>]
```

(`commands/index.ts:3546-3577`, `3406-3468`.)
Missing prompt → `factory agent start requires --prompt or trailing prompt text`.
`data` is `{mutation}`; with `--wait` it also carries `terminal` (the `FactoryAppExit`) and
`snapshot` (`{objectiveId, panel, detail, live, debug, panelData}`), and the process exit code is
taken from `terminal.code`.

Unlike the non-agent `create`, `agent start` **always** passes `computerProvider` through
(`commands/index.ts:3459`).

### 6.3 `agent inspect`

```
receipt factory agent inspect <objectiveId> [--panel overview|report|tasks|candidates|evidence|activity|live|debug|receipts]
```

(`commands/index.ts:3578-3596`.) Target may also come from `--target`, `--objective`, `--objective-id`,
`--job`, or `--job-id` (`resolveAgentTarget`, `commands/index.ts:3092-3101`).
Missing target → `factory agent inspect requires <objectiveId>`.
`data` = `{objectiveId, panel, detail, live, debug, panelData}` (`commands/index.ts:2931-2955`).

### 6.4 `agent output` (aliases `stdio`, `logs`)

```
receipt factory agent output [<objectiveId|taskId|jobId>]
```

(`commands/index.ts:3597-3620`, `3029-3090`.) Resolution:

- an id starting `objective_` or `factory/objectives/` → that objective (`resolvedBy: "objective"`)
- an id starting `task_` or `job_` → scan the selected objective first, then every board objective
  (`resolvedBy: "task" | "job"`); no match → `FactoryServiceError(404, "No Factory task stream found for <id>")`
- no id → the board's selected objective (`resolvedBy: "selected"`); none →
  `FactoryServiceError(404, "No selected objective; pass an objective id, task id, or job id")`

`data`: `{targetId?, resolvedBy, objectiveId, activeStreams[], selected?}`.
Each stream entry (`commands/index.ts:2957-2971`) has
`objectiveId, taskId, title, status, jobId?, jobStatus?, active, workspacePath?, promptPath?,
stdoutPath?, stderrPath?, lastMessagePath?, promptTail?, stdoutTail?, stderrTail?, lastMessage?,
artifactSummary?`. `promptTail` is the last 1200 chars of the prompt file, prefixed with `...` when
truncated (`commands/index.ts:278-289`).

`artifactRefs` are de-duplicated `{kind:"artifact", ref, label}` entries labelled `prompt`, `stdout`,
`stderr`, `lastMessage` (`commands/index.ts:2979-2990`).
`nextCommands` are `receipt factory agent inspect <objectiveId> --panel live` and
`receipt factory agent investigate <objectiveId>`.

### 6.5 `agent computer` (alias `agent opensandbox`)

```
receipt factory agent computer <status|inspect|probe|exec|run|read|cat|write|upload|download>
  [<objectiveId>] [flags]
```

(`commands/index.ts:3203-3331`.) Subaction defaults to `status`. Target is `--target`/`--objective`/
`--objective-id`/`args[2]`, else the board's selected objective, else
`FactoryServiceError(404, "No selected objective; pass an objective id")`
(`commands/index.ts:3114-3133`).

`nextCommands` for every computer command (`commands/index.ts:3213-3217`), where `<suffix>` is
` --acquire` when the objective has no recorded lease:

```
receipt factory agent output <objectiveId>
receipt factory agent computer probe <objectiveId><suffix>
receipt factory agent computer exec <objectiveId><suffix> --command "pwd && ls -la"
```

| Subaction | Flags | `data` | Notes |
|---|---|---|---|
| `status` / `inspect` | `--host` | `{objectiveId, execution, activeStreams, host?}` | No lease needed. `--host` runs `ensureOpenSandboxHostReadyForFactory()`; on failure `host` becomes `{ready:false, error:"…"}` instead of throwing (`commands/index.ts:3223-3250`). `artifactRefs` = the active task stream files. |
| `probe` | — | `{objectiveId, source, handle, acquireWaits, probe}` | `probe` is a capability snapshot. |
| `exec` / `run` | `--command <shell>` (alias `--cmd`, or trailing args from `args[3]`), `--cwd`, `--stdin`, `--timeout-ms <n>` | `{…base, command, result}` | Missing command → `computer exec requires --command <shell-command>`. |
| `read` / `cat` | `--remote <path>` (alias `--path`, or `args[3]`) | `{…base, remotePath, content}` | Missing path → `computer read requires --remote <path>`. |
| `write` | `--remote <path>`, and one of `--content <text>` / `--text <text>` / `--content-file <path>` / `--file <path>` | `{…base, remotePath, bytes}` | Missing path → `computer write requires --remote <path>`; missing body → `computer write requires --content <text> or --content-file <path>` (`commands/index.ts:3195-3201`). |
| `upload` | `--local <path>` (or `args[3]`), `--remote <path>` (or `args[4]`) | `{…base, localPath, remotePath}` | Missing either → `computer upload requires --local <path> --remote <path>`. `artifactRefs` = `[{kind:"artifact", ref:<localPath>, label:"uploaded local file"}]`. |
| `download` | `--remote <path>` (or `args[3]`), `--local <path>` (or `args[4]`) | `{…base, remotePath, localPath, bytes?}` | Missing either → `computer download requires --remote <path> --local <path>`. `artifactRefs` = `[{kind:"artifact", ref:<localPath>, label:"downloaded local file", bytes?}]`. |
| anything else | — | — | `computer action must be status, probe, exec, read, write, upload, or download` |

`base` is `{objectiveId, source, handle, acquireWaits}` where `source` is `"existing-lease"` or
`"acquired-lease"` (`commands/index.ts:3106-3112, 3255-3260`).

**Lease acquisition** (`connectAgentComputerLease`, `commands/index.ts:3135-3193`):

1. Reconnect to `detail.execution.lease.computerId` if one is recorded.
2. Otherwise, without `--acquire`, throw
   `FactoryServiceError(409, "No reconnectable OpenSandbox lease is recorded for this objective; pass --acquire to create a disposable probe lease")`.
3. With `--acquire`, acquire a disposable lease using `--scope <id>` (default `agent-cli:<Date.now()>`),
   recording human-readable wait summaries into `acquireWaits`.
4. A lease created by `--acquire` is destroyed on exit unless `--keep` is passed
   (`commands/index.ts:3262-3267`).

### 6.6 `agent investigate`

```
receipt factory agent investigate [<objectiveId|taskId|candidateId|jobId|runId>] [--as-of-ts <ts>]
```

(`commands/index.ts:3634-3653`.) `data` is the full investigation report (same shape as
`receipt factory investigate --json`). `nextCommands` are the five objective commands, or
`["receipt factory agent board"]` when no objective could be linked.

Unlike the non-agent form, this uses `config.dataDir`/`config.repoRoot` (not `--data-dir`).

### 6.7 `agent context` (alias `probe-context`)

```
receipt factory agent context [<objectiveId|taskId|candidateId|jobId|runId>]
```

(`commands/index.ts:3654-3676`, `3357-3404`.) `data`:

```
{ requestedId, resolved, links, warnings, packetContext, contextAvailable,
  packetPaths: { summaryPath, manifestPath, contextPackPath, resultPath,
                 evidenceBundlePath, lastMessagePath, stdoutPath, stderrPath },
  contract: { acceptanceCriteria, requiredChecks, proofExpectation },
  memory: { overview, objective, integration },
  selectedHelpers[], profileSkills[], recentReceipts[], frontierTasks[] }
```

Every defined `packetPaths` entry becomes an `artifactRefs` entry `{kind:"artifact", label:<key>, ref:<path>}`.
`nextCommands` are `receipt factory agent investigate <id>` and `receipt factory agent inspect <id>`.

### 6.8 `agent steer` / `agent follow-up`

```
receipt factory agent steer <jobId|objectiveId> [message words…] --message <text>
receipt factory agent follow-up <jobId|objectiveId> [message words…] --message <text>
```

(`commands/index.ts:3677-3699`.) Missing message →
`factory agent steer requires --message or trailing message text` (same for `follow-up`).

Job resolution (`resolveAgentControlJobId`, `commands/index.ts:3333-3355`):
`--job`/`--job-id` wins; else `--objective`/`--objective-id`/`args[1]`; if that value does not look
like an objective id and no explicit `--objective` was given it is used as a job id directly;
otherwise the CLI resolves the objective's active job, throwing
`FactoryServiceError(409, "selected objective has no active job to control")` when there is none
(`factory-cli/actions.ts:363-369`). With no target at all:
`factory agent control requires <jobId|objectiveId> or --job/--objective`.

`data` is `{mutation, resolvedFromObjectiveId?}`. `nextCommands` are the five objective commands when
the job was resolved from an objective, otherwise `["receipt factory parse <jobId> --json"]`.

### 6.9 `agent react` / `agent resume`

```
receipt factory agent react <objectiveId> [message words…] [--message <text>]
```

(`commands/index.ts:3700-3716`.) Missing target →
`factory agent react requires <objectiveId>` (or `… resume …`). Message optional.
`data` is `{mutation}`; `nextCommands` use `result.objectiveId` — which, as in §4.9, can be a *new*
objective id if a continuation was created.

Any other action → `Unknown factory agent action '<x>'` inside an error envelope.

### 6.10 `agent help`

`agentHelpEnvelope` (`commands/index.ts:2856-2921`) returns `command: "factory.agent.help"`,
`mode: "read"`, and `data.commands` — 14 `{command, description}` pairs. The exact strings are:

```
receipt factory agent board                                   List objectives and the currently selected objective.
receipt factory agent start --prompt <text>                   Create a new receipt-backed objective without entering the interactive UI.
receipt factory agent start --aws --prompt <text>             Create an objective that explicitly requires the workspace AWS Receipt Connect capability.
receipt factory agent start --required-capability aws --prompt <text>
                                                              Force an AWS connected-system requirement when the prompt is ambiguous.
receipt factory agent start --execution-target opensandbox --prompt <text>
                                                              Create an objective that runs through the OpenSandbox computer lane.
receipt factory agent inspect <objectiveId> [--panel overview|tasks|live|debug|receipts]
                                                              Read an objective projection and a focused panel payload.
receipt factory agent output <objectiveId|taskId|jobId>        Read active computer/Codex prompt, stdout, stderr, and last-message tails with artifact paths.
receipt factory agent computer status <objectiveId>            Inspect the objective's OpenSandbox execution/lease state and active stream artifacts.
receipt factory agent computer exec <objectiveId> --command <shell>
                                                              Run a shell command in the objective's reconnectable OpenSandbox computer.
receipt factory agent investigate <objectiveId|taskId|candidateId|jobId|runId>
                                                              Reconstruct what happened from receipts, packets, jobs, and artifacts.
receipt factory agent context <objectiveId|taskId|candidateId|jobId|runId>
                                                              Probe the worker packet context, contract, memory, helper, and artifact refs.
receipt factory agent steer <jobId|objectiveId> --message <text>
                                                              Queue a steer command for an active job, resolving objective ids to their active job.
receipt factory agent follow-up <jobId|objectiveId> --message <text>
                                                              Queue additional context for an active job.
```

`nextCommands`: `receipt factory agent board`, `receipt factory agent start --prompt "..."`,
`receipt factory agent investigate <id>`.

---

## 7. The interactive terminal app (`factory-cli/app.tsx`)

Rendered with Ink (`commands/index.ts:2565-2600`). Header text:
kicker `WORKBENCH`, title `Factory CLI`, subtitle
`One consolidated terminal surface for objective selection, execution state, inspection, and chat.`
(`app.tsx:930-934`).

### Hotkeys (`app.tsx:86-96`, handlers `app.tsx:1334-1450`)

| Key | Action |
|---|---|
| `j` / `k` / `↓` / `↑` | move selection in the rail |
| `h` / `l` / `←` / `→` | previous / next panel |
| `1`–`9`, `0` | jump to panel by index (`0` = the last panel, `analysis`) |
| `tab` | cycle focus: rail → timeline → composer |
| `/` | focus the composer and seed it with `/` |
| `enter` | focus the composer (rail/timeline) or send (composer) |
| `shift+enter` | newline in the composer |
| `esc` | close help → clear draft → return focus to timeline/rail |
| `r` | react to the selected objective (busy label `Reacting objective`) |
| `p` | promote (`Promoting objective`) |
| `c` | cancel with reason `canceled from CLI` (`Canceling objective`) |
| `x` | cleanup workspaces (`Cleaning workspaces`) |
| `a` | archive (`Archiving objective`) |
| `o` | toggle the objective rail |
| `?` | toggle the slash-command help overlay |
| `q` | quit (exit code 0, reason `quit`) |

Panels in order (`view-model.ts:23-45`): `Overview, Report, Tasks, Candidates, Evidence, Activity,
Live, Debug, Receipts, Analysis`.

### Composer slash commands (`factory-cli/composer.ts:66-80`)

```
/help or /?          Show slash command help.            (aliases: ?, help)
/analyze             Open the run analysis for the selected objective.
/obj <prompt>        Create a new objective from the prompt.
/new <prompt>        Start a new thread from the prompt.
/react [message]     React to the selected objective.
/note [message]      Add a note to the selected objective without mutating it.
/watch <objective-id>Focus an objective by id.
/promote             Promote the selected objective.
/cancel [reason]     Cancel the selected objective.
/cleanup             Clean up the selected objective.
/archive             Archive the selected objective.
/abort-job [reason]  Abort the active job.               (alias: abortjob)
/steer <message>     Steer the active job for the selected objective.
/follow-up <message> Send follow-up guidance to the active job for the selected objective.
                                                          (aliases: followup, follow_up)
```

Plain text with **no** objective selected creates a new objective; with one selected it *reacts*
(`composer.ts:158-183`). Composer validation strings (`composer.ts:151-303`):

- `Type a slash command or describe the objective.`
- `Unknown command '/<name>'. Try /help.`
- `Select an objective before analyzing it.` / `…before reacting to it.` / `…before noting it.` /
  `…before aborting its active job.` / `…before steering its active job.` / `…before sending follow-up guidance.`
- `Use /new followed by an objective prompt.` (and `/obj`)
- `Add the updated direction after /steer.`
- `Add the extra context after /follow-up.`

Help overlay subtitle (`app.tsx:882`):
`Plain text creates a new objective when nothing is selected, otherwise it reacts to the selected
objective. Use /note for a passive note. Active-job commands target the latest running or queued job
for the selected objective.`

Composer copy (`view-model.ts:255-266`): title `Create a new objective` or `React to <objectiveId>`;
placeholder `Describe the change you want Factory to make` or
`Write guidance for the selected objective or type /help`;
submit hint `Enter create objective · Shift+Enter newline` or `Enter send · Shift+Enter newline`.

Empty-state copy (`view-model.ts:246-253`):
`No objectives yet` /
`Commit or stash changes first, then describe the objective in the composer below.` (dirty repo) or
`Describe the first objective in the composer below or use /new.`

Theme (`factory-cli/theme.tsx:18-44`): colours are disabled when `NO_COLOR` is set; Unicode glyphs
(`•`, `›`, `─`, `…`) fall back to ASCII (`*`, `>`, `-`, `...`) when `RECEIPT_FORCE_ASCII=1` or `TERM=dumb`.

---

## 8. The Factory simulator UI (`factory-cli/simulator-ui.ts`)

Not a `receipt factory` subcommand — it is a standalone Bun server started with
`bun run --cwd packages/receipt-app simulate:ui` (`packages/receipt-app/package.json:58`) or
`bun src/factory-cli/simulator-ui.ts`.

- Default port **4397**, overridable with `RECEIPT_SIMULATOR_UI_PORT` (clamped 1–65535)
  (`simulator-ui.ts:84, 1425-1433`).
- Routes: `GET /` (HTML), `GET /healthz` → `{"ok":true}`, `POST /api/run` (JSON body →
  `{ok:false, error}` with HTTP 400 on failure), everything else → 404 `Not found`
  (`simulator-ui.ts:1404-1422`).
- Startup log: `Factory simulator UI listening on http://localhost:<port>`.
- Supported simulator kinds: `scenario`, `deterministic-runtime`, `runtime-outbox`,
  `reliability-suite`, `projection-ui`, `self-improvement`, `useful-gate`, `search`
  (`simulator-ui.ts:24-32`). Invalid values raise `Unsupported simulator kind '<x>'.` and
  `Unsupported search profile '<x>'.`

---

## 9. Full CLI help text (verbatim)

`receipt factory --help` (default branch of `printFactoryUsage`, `commands/index.ts:2020-2033`)
prints the global `printUsage()` first, then:

```
Factory read / inspect:
  receipt factory agent <board|start|inspect|investigate|context|steer|follow-up> [--json] [--output-file <path>]
  receipt factory inspect <objective-id> [--panel <name>] [--watch] [--json]
  receipt factory replay <objective-id> [--json] [--output-file <path>]
  receipt factory replay-chat <chat-or-run-stream> [--json] [--output-file <path>]
  receipt factory analyze <objective-id> [--json] [--output-file <path>]
  receipt factory parse [<objectiveId|taskId|candidateId|jobId|runId>] [--json] [--output-file <path>]
  receipt factory investigate <objectiveId|taskId|candidateId|jobId|runId> [--json] [--compact] [--output-file <path>] [--as-of-ts <ts>]
  receipt factory audit [--limit <n>] [--objective <id>] [--json] [--output-file <path>]
  receipt factory insights [--limit <n>] [--objective <id>] [--json] [--output-file <path>]
  receipt factory doctor <objectiveId|taskId|candidateId|jobId|runId> [--json] [--compact] [--output-file <path>]
  receipt factory simulate [ … long scenario list … ]

Factory write / control:
  receipt factory init [--repo-root <path>]
  receipt factory create --prompt <text> [--initial-task 'title::prompt']... [--objective-mode delivery|investigation] [--execution-target opensandbox] [--severity 1|2|3|4|5]
  receipt factory compose [--objective <id>] --prompt <text> [--initial-task 'title::prompt']... [--execution-target opensandbox]
  receipt factory note <objective-id> [--message <text>]
  receipt factory react <objective-id> [--message <text>]
  receipt factory promote <objective-id>
  receipt factory cancel <objective-id> [--reason <text>]
  receipt factory cleanup <objective-id>
  receipt factory archive <objective-id>
  receipt factory steer <job-id> [--message <text>]
  receipt factory follow-up <job-id> [--message <text>]
  receipt factory abort-job <job-id> [--reason <text>]

Notes:
  - Prefer read commands first and add --json when another tool or agent will consume the output.
  - Use --output-file <path> on large read commands to write the full payload and return the path.
  - Read commands do not mutate state; write / control commands do.

Factory experiments:
  receipt factory experiment <long-run|inner-loop-ab> [--json] [--output-dir <path>] [--codex-bin <path>] [--keep-workdir] [--keep-worktrees]
```

Per-subcommand usage lines (`commands/index.ts:1940-2019`) exist for `replay`, `replay-chat`,
`analyze`, `parse`, `investigate`, `audit`, `insights`, `doctor`, `experiment`, and `simulate`.
**No per-subcommand usage exists for** `run`, `create`, `compose`, `watch`, `inspect`, `resume`,
`react`, `note`, `promote`, `cancel`, `cleanup`, `archive`, `steer`, `follow-up`, `abort-job`,
`board`, `helper`, or `init` — asking for `receipt factory run --help` prints the whole default usage.

The global `printUsage()` (`packages/receipt-app/src/cli/shared.ts:73`) lists the subtree as:

```
receipt factory [init|run|create|compose|watch|inspect|replay|replay-chat|analyze|parse|investigate|audit|insights|resume|note|react|promote|cancel|cleanup|archive|abort-job|steer|follow-up|experiment]
```

which **omits `agent`, `board`, `doctor`, `simulate`, and `helper`.**

---

## 10. Docs-vs-code discrepancies

1. **`docs/api/cli.md`**: "`watch`, `inspect`, `run`, and `resume` accept
   `--panel overview|report|tasks|candidates|evidence|activity|live|debug|receipts`."
   Only `watch` (`commands/index.ts:4374`) and `inspect` (`4400`) read `--panel`; `run` (`4173-4253`)
   and `resume` (`4491-4512`) never do. `agent inspect` also accepts it (`3583`).
2. **`docs/api/cli.md`** subcommand list omits `agent`, `board`, `doctor`, `insights`, `simulate`,
   `helper`, and `note` is mentioned only in the "Common flags"/examples areas.
3. **`docs/api/cli.md`**: "Companion skill: `skills/receipt-cli-operator/SKILL.md`." That skill does
   not exist — `skills/` has no `receipt-cli-operator` directory.
4. **`docs/api/cli.md`** "Resolution Rules → Data directory: uses `DATA_DIR` env var or defaults to
   `<cwd>/.receipt/data`." For Factory the order is `RECEIPT_DATA_DIR` → `DATA_DIR` → the stored
   `dataDir` → `.receipt/data` relative to the directory containing `.receipt/`, not cwd
   (`config.ts:268-272`).
5. **`docs/api/cli.md`** lists `--output-file` support for `receipt factory replay|replay-chat|analyze|parse|investigate|audit`
   but omits `insights`, `doctor`, `simulate`, and the whole `agent` family, all of which support it.
6. **`skills/factory-agent-cli/SKILL.md`** tells agents to read
   `.receipt/factory/<taskId>.receipt-cli.md`. The real packet path is `receipt/current/receipt-cli.md`
   (`services/factory/task-packet-constants.ts:1`, `task-packet-paths.ts:9-29`). The old
   `.receipt/factory/<taskId>.*` naming survives only in simulation fixtures
   (`services/factory/sims/task-readiness-blocking.ts:157-170`) and tests.
   `docs/ai-agent-receipt-cli.md` already uses the correct `receipt/current/` paths, so the two docs
   disagree with each other.
7. **`docs/factory-agent-orchestration.md:328-329`** Mermaid diagram says
   `Task packet in .receipt/factory/` and `bun <taskId>.memory.cjs …`. Both are stale: the packet is
   `receipt/current/` and the script is `receipt/current/memory.cjs` (no taskId prefix).
8. **`skills/factory-agent-cli/SKILL.md`**: "If the objective mentions AWS, S3, EC2, RDS, Lambda, ECS,
   IAM, VPC, CloudWatch, CloudFormation, or STS, the CLI and runtime infer an AWS Receipt Connect
   requirement." The CLI no longer infers anything from prompt text:
   `inferObjectiveRequiredCapabilities` ignores `prompt`, `title`, and `initialTasks` and returns only
   the explicit flags (`commands/index.ts:268-276`), which is exactly what
   `commands/index.test.ts:388-412` asserts.
9. **`docs/GLOSSARY.md`** ("Computer lane"): "Factory routes computer-capable tasks (e.g. Codex)
   through the `codex` job lane." There is no `codex` lane. `JobLane` is
   `chat | collect | steer | follow_up | abort` (`packages/receipt-app/src/modules/job.ts:8,10`) and
   the Factory config loader accepts only `chat|collect|steer|follow_up` (`config.ts:174-177`).
10. **`docs/GLOSSARY.md`**: "Beetle — the product/brand name … (beetle.run)". The hosted product is
    `https://app.kentron.ai` (`packages/receipt-app/src/cli/shared.ts:161`, root `package.json:90`).
    `beetle.run` appears nowhere in the code paths I checked. Meanwhile
    `profiles/receipt/PROFILE.md` sets `label: "Beetle"` while the code's default profile snapshot
    hard-codes `rootProfileLabel: "Receipt"` (`modules/factory/defaults.ts:45-49`).
11. **`.receipt/config.json` in the repo** carries `budgets.maxReconciliationTasks`,
    `throttles.mutationCooldownMs`, and a whole `mutation` group that the loader silently discards
    (`config.ts:114-157`; type at `modules/factory/types.ts:719-734`). Any doc that copies this file
    verbatim will teach unsupported fields.
12. **`receipt factory doctor` is documented but non-functional**: `doctor.ts:449-451` hard-codes
    `byokApiKey = undefined` and always throws
    `Organization BYOK key required for factory doctor review`.
13. **`receipt factory init`'s "Repository profiling" is cosmetic.** The step list is the fixed string
    `Using checked-in Factory profiles and skills only.` (`commands/index.ts:2467`), and
    `buildComposeModel` always returns `["bun run build"]` and the hard-coded default policy
    (`objective-read-board-compose-live.ts:42-57`). Any doc claiming init "detects" your validation
    commands is wrong.
14. **`--json` behaviour is not uniform.** `replay`, `replay-chat`, `analyze`, and `parse` also switch
    to JSON when stdout is not a TTY (`commands/index.ts:4444, 4457, 4470, 4484`), whereas
    `investigate`, `audit`, `insights`, and `doctor` do not. No existing doc mentions this.
15. **`--data-dir` is not global.** It only reaches `investigate`, `audit`, `insights`, and `doctor`
    (`resolveFactoryReadContext`, `commands/index.ts:1911-1921`). `replay`, `replay-chat`, `analyze`,
    and `parse` use the config's `dataDir` and ignore `--data-dir`.
16. **`docs/api/cli.md`** says `factory compose` "with `--objective <id>` adds a note and reacts the
    existing objective" — correct, but it omits that `compose` drops `--computer-provider`
    (`commands/index.ts:4348` vs `4287`) and that the JSON `action` is still `"compose"` with a `note`
    field, while the text renderer prints `reacted <objectiveId>` (`commands/index.ts:2358-2362`).
17. **Auto-promote default.** `DEFAULT_FACTORY_OBJECTIVE_POLICY.promotion.autoPromote = true`
    (`defaults.ts:40-42`) but the runtime forces `false` for investigation objectives
    (`objective-input-policy.ts:12-20`), and the checked-in profile defaults new objectives to
    investigation. Docs that state "auto-promote is on by default" are misleading for this repo.
18. **`receipt factory` with no arguments is undocumented as an entrypoint.** `packages/receipt-app/src/cli.ts:26-30`
    makes bare `receipt` (TTY, no args) open the Factory board — a fact absent from `docs/api/cli.md`.

---

## 11. Internal-only material found (must NOT be published)

- `skills/factory-agent-cli/SKILL.md`: "For production commands that require actor/org or Receipt
  Connect context, resolve **the designated operator's** real production account by default …" — a named personal
  account. Also repeated in `docs/ai-agent-receipt-cli.md` ("Use the designated operator's real production actor and
  organization by default").
- `AWS_PROFILE=<your-aws-profile>` / `RECEIPT_AGENT_AWS_PROFILE` defaults — an internal AWS CLI profile name.
  Present in `skills/factory-agent-cli/SKILL.md`, `docs/ai-agent-receipt-cli.md`, and root
  `package.json:90-91` (`receipt:aws:debug`, `receipt:aws:doctor`).
- `bun run receipt:agent:beetle` / `receipt:agent:hosted` / `receipt:agent:aws` →
  `node scripts/local-agent-beetle.mjs` (root `package.json:87-89`) — an internal operator wrapper
  that pins the hosted gateway and preflights `https://app.kentron.ai/health`.
- `ZERO_ADMIN_PASSWORD` and the `$RECEIPT_PROD_WEB_URL/zero` admin analyzer flow
  (`skills/factory-agent-cli/SKILL.md`, `docs/ai-agent-receipt-cli.md`).
- The `receipt debug prod` / `/receipt-debug/*` token chain: `RECEIPT_PROD_DEBUG_TOKEN`,
  `RECEIPT_DEBUG_TOKEN`, `deploy/factory.secrets.env`, and `sst secret list --stage <stage>`
  (`docs/api/cli.md` "receipt debug", `packages/receipt-app/src/cli/commands.ts:3105-3119, 4812, 4935-4936`).
- Internal deploy/rollout scripts named in root `package.json`: `<deploy-project>:*`,
  `single-host:rollout`, `single-host:domain`, `factory-lite:*`, `factory:secrets:*`,
  `production:secrets:*`, `production:nango:promote-secret`, `factory:security:baseline`.
- SST parameter paths such as `/sst/cluster/receipt-factory-<stage>`
  (`packages/receipt-app/src/cli/commands.ts:4812`).
- `docs/factory-run-rca-2026-05-26.md`, `docs/production-release-handoff-2026-06-25.md`,
  `docs/prod-readiness-metrics.md`, `docs/factory-infra-real-data-eval.md` — internal incident /
  cutover material adjacent to this topic.
- `skills/factory-aws-prod-runbook/`, `skills/factory-prod-run-debug/`,
  `skills/factory-prod-trace-debug/`, `skills/factory-aws-rds-objective-debug/`,
  `skills/deploy-beetle-aws-lite/` — prod-debug runbooks that depend on employee accounts.
- `RECEIPT_REPO_KEY=receiptfactory` default baked into `.receipt/bin/receipt` — a Kentron-specific
  repo key; a public doc should present it as configurable, not as the value to copy.

---

## 12. Open questions a human must answer

1. Is `receipt factory doctor` intended to ship? It cannot run today
   (`doctor.ts:449-451`). Should the public docs omit it, mark it experimental, or is a BYOK wiring
   change imminent?
2. Which subcommands are *supported public surface* versus internal/dev-only? `simulate`, `experiment`,
   `helper`, and the simulator UI look like engineering tools; `board`, `run`, `create`, `inspect`,
   `agent …` look like product surface. The CLI's own usage text does not draw the line.
3. Is `receipt factory watch` deprecated in favour of `inspect --watch`? Both exist and neither
   appears in the `receipt factory --help` body.
4. Should the public docs use `receipt factory …` (globally installed), `.receipt/bin/receipt factory`,
   or `bun run receipt:factory`? All three appear in the repo, and the two of them differ in cwd
   handling.
5. What is the supported way to run the Factory CLI against a **hosted** Receipt without a local
   Postgres? Everything in `factory-cli/runtime.ts` binds to `postgresReceiptStore`, so `ZERO_UPSTREAM_DB`
   appears mandatory even for read commands. Is there a hosted/read-only mode planned?
6. Is `RECEIPT_FACTORY_TASK_MODEL` (default `gpt-5.6-luna`) a public knob, and does the default model
   name belong in public docs?
7. Is `Beetle` the public persona name (it is the `label` in `profiles/receipt/PROFILE.md` and appears
   in `docs/GLOSSARY.md` with a `beetle.run` domain) while the product is hosted at `app.kentron.ai`?
   Docs need one canonical answer, and the glossary's `beetle.run` reference needs verification.
8. Does the public product ship any profile other than `receipt`? The `profiles/` tree has exactly one,
   yet `docs/api/cli.md` shows `receipt factory run --profile infrastructure` as an example.
9. Is the `receipt/bin/receipt-workbench` script meant for end users or only for workers inside a task
   sandbox? Its `finalize` command prints paths but performs no write.
10. Are the `.receipt/config.json` fields `mutation`, `budgets.maxReconciliationTasks`, and
    `throttles.mutationCooldownMs` deprecated leftovers (safe to delete from the repo file) or
    planned features? Right now they are silently ignored.
11. Should self-hosting docs describe the OpenSandbox host lifecycle (`OPEN_SANDBOX_AUTO_START`,
    `OPEN_SANDBOX_AWS_INSTANCE_ID`, EC2 driver) or is that Kentron-hosted-only infrastructure?
12. `receipt factory helper run` shells out to `python3`. Is Python a documented prerequisite for
    self-hosters, and which version?

---

## Suggested doc pages

| Slug | Title | Purpose | Audience |
|---|---|---|---|
| `factory/concepts` | Factory concepts | Explain objective, task DAG, candidate, job, run, check, promotion, profile, execution path, and the receipt-backed model so every later page can use the vocabulary. | both |
| `factory/cli/getting-started` | Get started with the Factory CLI | Install/reach the `receipt` binary, run `receipt factory init`, and create + watch a first objective. | both |
| `factory/cli/reference` | `receipt factory` command reference | One page per-command reference: syntax, every flag with default, output shape, exit codes, and exact error messages. | both |
| `factory/cli/agent-envelope` | Agent-first Factory commands | Document `receipt factory agent …`, the `receipt-cli/factory-agent-envelope/1` schema, `artifactRefs`, `nextCommands`, and `--output-file` semantics. | developer |
| `factory/cli/computer-and-opensandbox` | Working with the computer lane | The OpenSandbox execution path, leases, `agent computer status/probe/exec/read/write/upload/download`, `--acquire`/`--keep`, and the env configuration for self-hosting. | developer |
| `factory/configuration` | `.receipt/config.json` reference | Every stored field, the `defaultPolicy` groups with defaults and clamps, `--policy-file` merging, schedules, and the env overrides. | both |
| `factory/workbench` | The Factory workbench and task packet | `receipt/current/` layout, `receipt/bin/receipt-workbench show|path|finalize`, and what a worker reads first. | developer |
| `factory/cli/terminal-ui` | The Factory terminal workbench | The interactive board: panels, hotkeys, slash commands, and exit codes. | user |
| `factory/cli/investigate-and-audit` | Investigating a Factory run | `parse`, `replay`, `replay-chat`, `analyze`, `investigate`, `audit`, `insights` — what each answers and in which order to use them. | both |
| `factory/simulation` | Deterministic simulation and the seed corpus | `receipt factory simulate` suites, search profiles, coverage floors, reliability properties, and the `corpus add/reduce/promote` workflow. | developer |
| `factory/self-hosting/prerequisites` | Running Factory yourself | `ZERO_UPSTREAM_DB`, git repo, codex binary, OpenSandbox host, python3, and the env-file load order. | developer |
