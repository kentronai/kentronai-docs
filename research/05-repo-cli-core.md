# Research report 05 — The in-repo `receipt` CLI (excluding the `factory` subtree)

Repo: `<receipt-repo>`
Scope: `packages/receipt-app/src/cli.ts` + `packages/receipt-app/src/cli/**` + the shared services those handlers call.
Explicitly out of scope: `packages/receipt-app/src/factory-cli/**` (`receipt factory …`) — covered by a separate report. Everything below covers every other command the dispatcher can reach.

Everything here was read from implementation source. Every substantive claim carries a `file:line`.

---

## 0. TL;DR for a docs writer

There are **two different binaries both named `receipt`** in this repo:

| | In-repo / developer CLI | Public / installed CLI |
|---|---|---|
| Entry file | `packages/receipt-app/src/cli.ts` | `packages/receipt-app/src/connect-cli.ts` |
| Launched by | `.receipt/bin/receipt` (POSIX shell wrapper that `exec`s Bun) | a compiled/bundled release binary (`install.sh`) |
| Needs | a Receipt git checkout + Bun (+ Postgres for most commands) | nothing but the binary |
| Command surface | everything below | `setup`, `workspace`, `tools`, `mcp`, `connect`, `import`, `observe`, `--version` only |
| `package.json` bin | `packages/receipt-app/package.json:6-8` maps `receipt` → `./src/cli.ts` | separate release build |

The public binary’s surface is a strict subset. Commands marked **[repo-only]** below exist **only** in the in-repo CLI.

---

## 1. Entry point and process lifecycle

### 1.1 The wrapper: `.receipt/bin/receipt`

A `#!/bin/sh` script (not TypeScript). Behaviour, in order:

1. Resolves symlinks to find its own real path, then `ROOT_DIR = <script>/../..` and `cd "$ROOT_DIR"`. This is why the wrapper can be symlinked onto `PATH` from anywhere.
2. `export RECEIPT_REPO_ROOT="${RECEIPT_REPO_ROOT:-$ROOT_DIR}"`.
3. `export RECEIPT_REPO_KEY="${RECEIPT_REPO_KEY:-receiptfactory}"`.
4. Resolves the Bun runtime, in this precedence: `$RECEIPT_BUN_BIN` (if executable) → `$BUN_BIN` (if executable) → `bun` on `PATH` → `$BUN_INSTALL/bin/bun` → `$HOME/.bun/bin/bun`. On failure it prints exactly:
   `receipt CLI requires Bun. Set RECEIPT_BUN_BIN or install Bun on PATH.` to stderr and returns 127.
5. `CLI_PATH="$ROOT_DIR/packages/receipt-app/src/cli.ts"`, falling back to `"$ROOT_DIR/src/cli.ts"` if the first does not exist.
6. `exec "$BUN_RUNTIME" "$CLI_PATH" "$@"`.

### 1.2 `packages/receipt-app/src/cli.ts` (59 lines)

- `cli.ts:1` — `#!/usr/bin/env bun`.
- `cli.ts:3-5` — **`loadReceiptCliEnv()` runs at module load, before anything else is imported.** Env files are therefore in place for every later import.
- `cli.ts:8-20` — lazily imports `./cli/commands`, `./cli/runtime`, `./cli/shared`, `./factory-cli/commands`, `./services/receipt-cli-session` in parallel.
- `cli.ts:21` — `parseArgs(process.argv.slice(2))`.
- `cli.ts:23-31` — **no command at all**: if stdin *and* stdout are TTYs (`shared.ts:11-12`) it applies the saved CLI session env defaults and opens the Factory board (`handleFactoryCommand(ROOT, [], {})`); otherwise it prints the usage text and returns.
- `cli.ts:33-36` — `help`, `--help`, `-h` as the first token print usage.
- `cli.ts:38` — otherwise `runCliCommand(parsed)`.
- `cli.ts:41-49` — after `main()` settles, `exitCli()` flushes stdout then stderr and calls `process.exit(code)`. **Set `RECEIPT_CLI_NO_FORCE_EXIT=1` to disable the forced exit** (used by the CLI’s own subprocess tests, e.g. `cli/mcp-workspace-commands.test.ts:39`).
- `cli.ts:52-56` — uncaught errors print exactly `error: <message>` to stderr and set `process.exitCode = 1`.

**There is no `--version` / `-V` in the in-repo CLI.** `receipt --version` falls through the switch and throws `Unknown command '--version'` (`cli/commands.ts:5421-5423`). Only the public binary handles `--version`/`-V` (`connect-cli.ts:922-925`, printing `receipt <version>` where the version comes from the build-time `RECEIPT_CLI_BUILD_VERSION` define or `RECEIPT_CLI_VERSION`, defaulting to `development` — `connect-cli.ts:38-43`).

---

## 2. Argument parsing (`cli/shared.ts:181-238`)

`parseArgs(argv)` returns `{ command?, args, flags }`.

- Leading `--` tokens are shifted off before the command is taken (`shared.ts:183`).
- The **first** token becomes `command`; everything after is scanned.
- A bare `--` stops flag parsing: all remaining tokens are pushed into `args` (`shared.ts:191-194`).
- Tokens not starting with `--` become positional `args`.
- `--key=value` sets `flags.key = "value"` (`shared.ts:200-212`).
- `--key value` sets `flags.key = "value"` and consumes the next token (`shared.ts:214-226`).
- `--key` followed by end-of-args or another `--…` token sets `flags.key = true`.
- **Repeating a flag accumulates into an array** (`string`, then `[string, string]`, then appended) — `shared.ts:205-210, 220-225`.
- There are **no single-dash short flags** anywhere except `-h` recognised as a help token.

Accessors:
- `asString(flags, key)` — returns the **last** value if the flag repeated (`shared.ts:240-244`).
- `asIntegerFlag(flags, ...keys)` — first key that parses as a finite number, floored (`shared.ts:246-258`).
- `parseNumberFlag(flags, key)` — throws `--<key> must be a number` on a non-finite value (`shared.ts:260-269`).
- `parseJsonFlag(flags, key)` — `JSON.parse`; throws `--<key> must be a JSON object` if the result is not a plain object (`shared.ts:274-285`).

Boolean flags are compared inconsistently across handlers: most use `flags.json === true || flags.json === "true"`; `debugBooleanFlag` (`commands.ts:3421-3431`) also accepts the string `"false"`; `isTruthyFlagValue` (`commands.ts:2848-2853`) accepts `true | "1" | "true" | "yes" | "on"`; `isFalseFlag` (`commands.ts:1108-1117`) accepts `false | "0" | "false" | "no" | "off"`. Document `--json` as “pass the bare flag”.

**Gotcha worth calling out in docs:** `--json` is a *boolean* flag for read commands, but is the **JSON argument payload** for `receipt tools call`, `receipt connect call <conn> <tool>` and `receipt mcp` (`commands.ts:1520` uses `parseJsonFlag(flags, "json")`; `services/receipt-mcp-cli.ts:536`). So `receipt connect call github:work list_issues --json '{"state":"open"}'` is correct, and there is no way to ask those commands for “JSON output mode” — they always print JSON.

---

## 3. `cli/env.ts` — how env files are loaded (188 lines)

`loadReceiptCliEnv({ cwd?, moduleDir?, env? })` returns `{ repoRoot?, loadedFiles }`.

### 3.1 Repo-root detection (`env.ts:45-61`)

Walks **up** from `process.cwd()` and then from the module directory, taking the first directory that contains all three of:
- `package.json`
- `packages/receipt-app/`
- `apps/start/`

If none is found, **nothing is loaded** and it returns `{ loadedFiles: [] }` (`env.ts:155`). This is what makes the same code safe inside a released public binary.

### 3.2 Precedence

Two ordered passes. Within each pass **later files override earlier files**, but a variable that is already set to a non-empty value in the incoming environment is *never* overwritten (`env.ts:157-161, 170-172, 179-181`). The protected-key snapshot is taken **once, before any file is read**, so a value written by an earlier file *can* be overridden by a later file.

Pass 1 — repo/app files (`env.ts:112-117`):
1. `<repoRoot>/.env`
2. `<repoRoot>/.env.local`
3. `<repoRoot>/apps/start/.env`
4. `<repoRoot>/apps/start/.env.local`

Pass 2 — generated files (`env.ts:124-146`), de-duplicated by resolved path (`env.ts:32-43`):
5. `<repoRoot>/.deploy-artifacts/local-up/latest.env` — **skipped when `RECEIPT_CLI_LOAD_LOCAL_ENV=0`**
6. `$START_ALL_ENV_FILE`
7. `$RECEIPT_LOCAL_ENV_FILE`
8. `$VALIDATE_STACK_ENV_FILE`
9. every comma-separated path in `$START_ALL_ENV_FILES`
10. every comma-separated path in `$VALIDATE_STACK_ENV_FILES`

Missing files are silently skipped (`env.ts:167, 176`).

The comment at `env.ts:164-165` states the intent: “Keep the same repo/app env-file order used by start-all and validate-stack. Later files override earlier files, while already-exported shell values win.”

### 3.3 `.env` syntax accepted (`env.ts:63-110`)

- Blank lines and `#`-prefixed lines are skipped.
- Line regex: `^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$`. Lines that do not match are silently ignored.
- Double-quoted values: content up to the **last** `"`, with `\n`, `\r`, `\t`, `\"`, `\\` unescaped.
- Single-quoted values: content up to the last `'`, no escape processing.
- Unquoted values: trailing ` #comment` is stripped, then trimmed.

Tests confirming the order and the shell-wins rule: `cli/env.test.ts:23-87`.

---

## 4. The CLI session file (`services/receipt-cli-session.ts`, 234 lines)

### 4.1 Location

- Config dir: `$RECEIPT_CLI_CONFIG_DIR` if set and non-empty, else `~/.receipt` (`receipt-cli-session.ts:39-41`).
- Active session file: `$RECEIPT_CLI_SESSION_FILE` if set, else `<configDir>/session.json` (`receipt-cli-session.ts:43-45`).
- Per-target file: `<configDir>/session.<target>.json` — e.g. `session.prod.json`, `session.dev.json`, `session.local.json` (`receipt-cli-session.ts:57-65`). **Per-target files are suppressed entirely when `RECEIPT_CLI_SESSION_FILE` is set** (`receipt-cli-session.ts:60`). Target names are normalised to `prod|dev|local`; anything else is lowercased, non-`[a-z0-9._-]` replaced with `_`, and truncated to 64 chars; the literal `custom` yields no per-target file (`receipt-cli-session.ts:47-55`).

### 4.2 Permissions

- Directory created with `mode: 0o700` (`receipt-cli-session.ts:159, 168`).
- Written atomically: write `<file>.tmp` with `mode: 0o600`, then `rename`, then a best-effort `chmod 0o600` (`receipt-cli-session.ts:160-175`).

### 4.3 Field names (the on-disk schema)

`ReceiptCliSession` (`receipt-cli-session.ts:8-21`):

| field | required | notes |
|---|---|---|
| `kind` | yes | literal `"receipt.cli-session"` |
| `schemaVersion` | yes | literal `1` |
| `target` | yes | `prod` \| `dev` \| `local` \| `custom` (defaults to `"custom"` when absent on read — `:86`) |
| `gatewayUrl` | yes | Receipt Connect gateway base URL |
| `authUrl` | yes | falls back to `gatewayUrl` when absent (`:77`) |
| `token` | yes | **the Receipt Connect JWT — this file DOES contain a bearer secret** |
| `userId` | no | |
| `userEmail` | no | |
| `organizationId` | yes | |
| `workspaceId` | no | |
| `workspaceName` | no | |
| `savedAt` | yes | ISO string; defaults to `new Date(0).toISOString()` on read (`:91`) |

A file missing any of `gatewayUrl`, `token`, `organizationId` (or an unparsable file) is treated as **no session at all** (`receipt-cli-session.ts:80, 112-113`).

> **Correction to the brief:** the session file is *not* secret-free. It stores the short-lived Receipt Connect bearer token in plaintext, protected only by `0600`/`0700` file modes. What *is* secret-free is the **MCP client config** the CLI generates (`services/receipt-mcp-cli.ts:312-327` actively refuses to write a client config that contains the session token or anything matching `/nango|provider.?secret|authorization.?bearer/i`).

### 4.4 Read/write/delete semantics

- `readReceiptCliSession({ target })` tries the per-target file first; if that misses it reads the active file and returns it only if its normalised target matches the requested one (`receipt-cli-session.ts:126-144`). Without `target`, the active file is returned unconditionally.
- `writeReceiptCliSession` writes **both** the active file and the per-target file (`receipt-cli-session.ts:157-176`).
- `deleteReceiptCliSession({ target })` unlinks the active file and, when `target` is given, the per-target file; returns `true` if at least one was removed (`receipt-cli-session.ts:179-201`).

### 4.5 Session → environment defaults

`applyReceiptCliSessionEnvDefaults()` is called at the very top of `runCliCommand` (`commands.ts:5280`) and again for the no-command interactive path (`cli.ts:25`). It maps the session onto env vars **only when they are not already set** (`receipt-cli-session.ts:219-233`):

| env var | source field |
|---|---|
| `RECEIPT_CONNECT_GATEWAY_URL` | `gatewayUrl` |
| `RECEIPT_CONNECT_PUBLIC_GATEWAY_URL` | `gatewayUrl` |
| `RECEIPT_CONNECT_TOKEN` | `token` |
| `RECEIPT_CONNECT_ORGANIZATION_ID` | `organizationId` |
| `RECEIPT_CONNECT_WORKSPACE_ID` | `workspaceId` (if present) |
| `RECEIPT_CONNECT_WORKSPACE_NAME` | `workspaceName` (if present) |
| `RECEIPT_CONNECT_USER_ID` | `userId` (if present) |

The comment at `receipt-cli-session.ts:227-228` states the rule: “The session is a default for CLI invocations. Explicit environment values still win so CI, local dev, and one-off commands can target another gateway.”

---

## 5. `.receipt/config.json` — the Factory runtime config, field by field

Loaded by `factory-cli/config.ts` and consumed by `cli/runtime.ts:22-23` (`FACTORY_RUNTIME = await resolveFactoryRuntimeConfig(ROOT)`; `DATA_DIR = FACTORY_RUNTIME.dataDir`). This happens at **module import time**, so a broken config makes *every* CLI command fail.

### 5.1 Discovery (`factory-cli/config.ts:252-272`)

- If `repoRootOverride` or `$RECEIPT_REPO_ROOT` is set: the config path is exactly `<thatRoot>/.receipt/config.json`; no search.
- Otherwise walk **up** from `cwd` looking for `.receipt/config.json`; the first hit wins.
- If nothing is found, or the file cannot be read, `loadFactoryConfig` returns `undefined` and `resolveFactoryRuntimeConfig` falls back (§5.4).

### 5.2 Parse + validation (`factory-cli/config.ts:162-178`)

An empty file parses as `{}` (`:163`). A non-object throws `Factory config must be a JSON object` (`:165`).

| key | type accepted | validation | error message |
|---|---|---|---|
| `repoRoot` | non-empty string | trimmed; anything else ignored (`asNonEmptyString`, `:87-88`) | — |
| `dataDir` | non-empty string | trimmed | — |
| `codexBin` | non-empty string | trimmed | — |
| `repoSlotConcurrency` | number or numeric string | `asFiniteNumber` (`:90-97`); later `Math.max(1, floor(v))` | — |
| `defaultChecks` | array of strings | each element must be a string | `Factory config defaultChecks must be an array` / `Factory config defaultChecks at index <i> must be a string` (`:105-114`) |
| `defaultPolicy` | object | see §5.3 | `Factory config defaultPolicy must be an object` (`:99-103`) |
| `schedules` | array of objects | see §5.5 | see §5.5 |

Unknown top-level keys are **silently dropped** — the decoder builds a fresh object rather than spreading (`:166-177`).

### 5.3 `defaultPolicy` (`factory-cli/config.ts:116-160`, normalised at `modules/factory/normalization.ts:1637-1682`)

Only these five leaves are decoded. Everything else in `defaultPolicy` is **silently discarded**.

| path | type | clamp | default (`modules/factory/defaults.ts:29-44`) |
|---|---|---|---|
| `concurrency.maxActiveTasks` | number | 1 … 50 | `5` |
| `budgets.maxTaskRuns` | number | 1 … 200 | `50` |
| `budgets.maxCandidatePassesPerTask` | number | 1 … 12 | `4` |
| `budgets.maxObjectiveMinutes` | number | 1 … 10 080 | `1440` |
| `throttles.maxDispatchesPerReact` | number | 1 … 30 | `10` |
| `promotion.autoPromote` | boolean | — | `true` |

Sub-objects that are present but not objects throw `Factory config defaultPolicy.<section> must be an object`.

> **The checked-in `.receipt/config.json` contains three keys that the loader ignores**: `defaultPolicy.budgets.maxReconciliationTasks`, `defaultPolicy.throttles.mutationCooldownMs`, and the whole `defaultPolicy.mutation` object (`.receipt/config.json` lines 14, 18, 20-22 vs `factory-cli/config.ts:137-151`). Docs must not present these as supported knobs.

### 5.4 Resolution with env overrides (`factory-cli/config.ts:267-343`)

Given a found config file, with `configBaseDir = dirname(dirname(configPath))` (i.e. the directory that owns `.receipt/`):

| field | resolution order |
|---|---|
| `configPath` | the found `.receipt/config.json` |
| `repoRoot` | `repoRootOverride` → `$RECEIPT_REPO_ROOT` → `config.repoRoot` → `"."`; resolved against `configBaseDir` (`:282-286`) |
| `dataDir` | `$RECEIPT_DATA_DIR` → `$DATA_DIR` (absolute) → `config.dataDir` resolved against `configBaseDir` → `.receipt/data` (`:287-290`) |
| `codexBin` | `$RECEIPT_CODEX_BIN` → `config.codexBin` → `"codex"` (`:295`) |
| `repoSlotConcurrency` | `$RECEIPT_FACTORY_REPO_SLOT_CONCURRENCY` → `config.repoSlotConcurrency` → `20` (`:296-299`, `:62`) |
| `defaultChecks` | trimmed, de-duplicated, empties dropped (`:81-82, :300`) |
| `defaultPolicy` | normalised as §5.3 |
| `schedules` | normalised as §5.5 |

With **no config file at all** (`:324-342`): `repoRoot` = `$RECEIPT_REPO_ROOT` or the detected git root (`git -C <cwd> rev-parse --show-toplevel`, `:235-250`); `dataDir` = `$RECEIPT_DATA_DIR`/`$DATA_DIR` or `<repoRoot>/.receipt/data`; `codexBin` = `$RECEIPT_CODEX_BIN` or `codex`; `schedules` = `[]`. If there is neither a git repo nor `RECEIPT_REPO_ROOT`, it throws:
`Factory runtime config requires a git repository or RECEIPT_REPO_ROOT. cwd=<cwd> failed: git -C <cwd> rev-parse --is-inside-work-tree` (`:326-328`).

### 5.5 `schedules` (`factory-cli/config.ts:190-227`)

Each entry becomes a `HeartbeatSpec`. `enabled: false` entries are skipped.

| field | rule |
|---|---|
| `enabled` | optional; `false` skips the entry |
| `agentId` | **required non-empty string**; else `Factory config schedule at index <i> requires agentId` |
| `intervalMs` | **required finite number ≥ 1000**; else `Factory config schedule '<agentId>' must set intervalMs >= 1000` |
| `payload` | **required object**; else `Factory config schedule '<agentId>' requires payload to be an object` |
| `id` | optional; defaults to `schedule:<agentId>:<index+1>`; duplicates throw `Factory config has duplicate schedule id '<id>'` |
| `lane` | `chat`\|`collect`\|`steer`\|`follow_up`, anything else → `collect` (`:180-183`) |
| `sessionKey` | optional; defaults to `schedule:<id>` |
| `singletonMode` | `allow`\|`cancel`\|`steer`, anything else → `cancel` (`:185-188`) |
| `maxAttempts` | number clamped 1 … 8; default `1` |

A non-array `schedules` throws `Factory config schedules must be an array`; a non-object entry throws `Factory config schedule at index <i> must be an object`.

The checked-in `.receipt/config.json` has no `schedules` key at all.

---

## 6. The dispatcher (`cli/commands.ts:5279-5424`)

```
runCliCommand(parsed):
  await applyReceiptCliSessionEnvDefaults()                 // :5280
  if command === "connect" && (help flag || args[0] is help) -> printConnectUsage()   // :5283-5288
  if command !== "factory" && (help flag || args[0] is help) -> printUsage()          // :5290-5296
  switch (command) { … }                                    // :5298
```

`hasHelpFlag` accepts `--help`, `--help true`, `-h`, `-h true` (`commands.ts:5273-5277`). `isHelpToken` accepts `help`, `--help`, `-h` as `args[0]` (`:5270-5271`).

Full switch (`commands.ts:5299-5423`):

| case | line | handler |
|---|---|---|
| `setup` | 5299 | `commandConnectSetup` |
| `new` | 5302 | `commandNew`; requires `args[0]`, else `agent id is required` |
| `dev` | 5309 | `spawnDevServer` |
| `run` | 5312 | `commandRun`; requires `args[0]`, else `agent id is required` |
| `trace` | 5318 | `commandTrace`; requires `args[0]`, else `run-id or stream is required` |
| `replay` | 5324 | `commandReplay`; same requirement |
| `dst`, `simulate` | 5330-5331 | `commandDst` (**`simulate` is an undocumented alias**) |
| `eval` | 5334 | `commandEval` |
| `import` | 5337 | `commandImport` |
| `observe` | 5340 | `commandObserve` |
| `fork` | 5343 | `commandFork` |
| `inspect` | 5349 | `commandInspect` |
| `jobs` | 5355 | `commandJobs` |
| `abort` | 5358 | `commandAbort`; requires `args[0]`, else `job id is required` |
| `connect` | 5364 | `commandConnect` |
| `login` | 5367 | `commandLogin` |
| `logout` | 5370 | `commandLogout` |
| `whoami` | 5373 | `commandWhoami` |
| `workspace` | 5376 | re-serialises argv and calls `runReceiptWorkspaceCommand` |
| `tools` | 5385 | re-serialises argv and calls `runReceiptToolsCommand` |
| `mcp` | 5394 | re-serialises argv and calls `runReceiptMcpCommand` |
| `proxy` | 5403 | `commandProxy` — **always throws** (removed command) |
| `memory` | 5406 | `commandMemory` |
| `sessions` | 5409 | `commandSessions` |
| `doctor` | 5412 | `commandDoctor` |
| `debug` | 5415 | `commandDebug` |
| `factory` | 5418 | `handleFactoryCommand` (separate report) |
| default | 5421 | throws `Unknown command '<command>'` |

**Commands the topic brief guessed at that do NOT exist:** there is no `serve`, no `server`, no Zero-related command, no top-level `import-local-aws-workspace`, and no top-level `prod-objective`. `import-local-aws` is a `connect` subcommand (`commands.ts:2279`); `prod-objective` is a `debug` subcommand (`commands.ts:5185`); the file `cli/commands.import-local-aws-workspace.test.ts` is a unit test of workspace isolation inside `commandConnectImportLocalAws`, not a command.

### 6.1 The `workspace` / `tools` / `mcp` re-serialisation

`commands.ts:5376-5401` rebuilds an argv array as
`[<name>, ...args, ...Object.entries(flags).flatMap(([k,v]) => v === true ? ["--"+k] : ["--"+k, String(v)])]`.
Consequences worth documenting: flag order is not preserved, and a repeated flag (which `parseArgs` turns into an array) is re-emitted as a single comma-joined value. These three sub-CLIs have their own, simpler parser (`services/receipt-mcp-cli.ts:45-69`, `services/receipt-workspace-cli.ts:191-203`) that does **not** support repeated flags at all.

---

## 7. Shared output helpers

### 7.1 `printCliReadOutput` (`commands.ts:298-337`)

Used by `trace`, `replay`, `inspect`, `dst`, `jobs list`, `jobs wait`, `memory *`, `sessions *`, `doctor`, `debug *`, `import`, `observe`, `connect status/check/list/tools/call`.

- `asJson: true` → `JSON.stringify(value, null, 2)` + `\n`.
- `asJson: false` → the string as-is, with a trailing newline guaranteed.
- Without `--output-file` the payload goes to stdout.
- With `--output-file <path>`: the path is resolved, parent dirs are created, the payload is written UTF-8, and then:
  - in JSON mode stdout gets the envelope
    ```json
    { "ok": true, "outputFile": "<abs path>", "format": "json", "bytes": <n> }
    ```
  - in text mode stdout gets `wrote <abs path>` (`commands.ts:321-336`).

### 7.2 `printEvalOutput` (`cli/eval.ts:32-49`) — **different envelope**

`receipt eval …` writes `{ "ok": true, "outputFile": "<abs path>" }` — **no `format`, no `bytes`** (`eval.ts:46-48`). Text mode prints `wrote <abs path>`.

### 7.3 `receipt tools` output-file envelope (`services/receipt-mcp-cli.ts:563-573`)

`receipt tools …` accepts `--output` **or** `--output-file`, writes atomically at `0600`, and prints `{ "ok": true, "outputFile": "<abs>", "bytes": <n> }` — no `format`.

So there are **three** slightly different `--output-file` envelopes in one binary.

---

## 8. Command reference

Legend: **[repo-only]** = absent from the public installed CLI. **[shared]** = also present in `connect-cli.ts`.

---

### 8.1 `receipt setup` **[shared]**

Syntax: `receipt setup [--json] [--no-login|--skip-login|--local-only] [--no-background|--no-observer|--no-claude|--skip-claude] [--target prod|dev|local] [--server-url <url>] [--auth-url <url>] [--fresh-login] [--no-open]`

Handler `commandConnectSetup` (`commands.ts:640-677`); also reachable as `receipt connect setup` (`commands.ts:2256-2261`).

Two independent steps:

1. **`setupReceiptLogin`** (`commands.ts:685-772`). Skipped if any of `--no-login`, `--skip-login`, `--localOnly`, `--local-only` (`commands.ts:679-683`), returning `{ ok: true, skipped: true, reason: "disabled by setup flag" }`. Otherwise it resolves the endpoint, reads the existing per-target session, and **reuses it** unless `--fresh-login` is passed and the saved gateway matches (`commands.ts:704-725`). A fresh login runs the device flow (§10) and writes the session.
2. **`setupClaudenObserver`** (`commands.ts:780-806`). Skipped if any of `--no-claude`, `--no-observer`, `--no-background`, `--skip-claude` (`commands.ts:774-778`). It first resolves the `receipt-claude-proxy`/`clauden` companion binary; if that throws, the step is reported as skipped with the resolution error as `reason`. Otherwise it runs the observer `install` service action.

Text output (`commands.ts:659-676`), exact strings:
```
Receipt account: connected to workspace <name> (<workspaceId|organizationId|unknown>)
Receipt account: not connected (<reason>)
Receipt Connect connectors:
  <id>: <label> via real '<command>' CLI
Claude observer: installed (<platform> <serviceFile>)
Claude observer: not installed (<reason>)
```

`--json` output: `{ ok: true, receiptAccount, connectors, claudeObserver }` where `connectors` is the whole connector catalog (62 entries — §11).

---

### 8.2 `receipt login` **[repo-only]**

Syntax: `receipt login [prod|dev|local|<https URL>] [--target <t>] [--server-url <url>] [--auth-url <url>] [--fresh-login] [--login] [--no-open] [--json]`

Handler `commandLogin` (`commands.ts:848-953`). Also reachable as `receipt connect login` (`commands.ts:2287-2290`).

Target resolution (`resolveReceiptConnectTargetArg`, `commands.ts:808-818`), in order: `--target <value>` → `--prod`/`--production` → `--local`/`--localhost` → `--dev`/`--development`/`--staging` → the positional argument.

Session reuse: unless `--login` or `--fresh-login` is passed, an existing per-target session whose gateway URL matches is reused (`commands.ts:862-866`). Matching is `savedSessionMatchesEndpoint` (`commands.ts:834-846`): for `local` a target-name match is enough (the comment at `:840-842` explains that local dev ports move around); otherwise the gateway URLs must be equal after normalising `localhost`→`127.0.0.1` and stripping a trailing `/`.

Text output when reusing (`commands.ts:892-898`):
```
receipt login: already signed in <email|userId|user> for workspace <name|Default> (<workspaceId|organizationId>)
receipt login: target <target>
receipt login: gateway <gatewayUrl>
receipt login: use --fresh-login to sign in again
```
Text output after a fresh login (`commands.ts:948-952`):
```
receipt login: signed in <email|userId|user> for workspace <name|Default> (<workspaceId|organizationId>)
receipt login: gateway <gatewayUrl>
receipt login: saved <sessionFilePath>
```
`--json` envelope (`commands.ts:869-890` reuse / `:925-946` fresh):
```json
{ "ok": true, "reused": true,          // "reused" only present on the reuse path
  "target": "...", "gatewayUrl": "...", "authUrl": "...",
  "userId": "...", "userEmail": "...", "organizationId": "...",
  "workspaceId": "...", "workspaceName": "...",
  "sessionFile": "/…/.receipt/session.json",
  "targetSessionFile": "/…/.receipt/session.prod.json" }
```

Browser auto-open is on unless `RECEIPT_CONNECT_OPEN_BROWSER=0`, `--no-open`, or `--open false|0|no|off` (`commands.ts:1119-1122`).

---

### 8.3 `receipt logout` **[repo-only]**

Syntax: `receipt logout [--target prod|dev|local] [--prod|--dev|--local] [--json]`
Handler `commandLogout` (`commands.ts:955-969`). Deletes the session file(s) and `delete process.env.RECEIPT_CONNECT_TOKEN`.

Text: `receipt logout: removed saved CLI session` or `receipt logout: no saved CLI session found`.
JSON: `{ "ok": true, "removed": <bool> }`.

---

### 8.4 `receipt whoami` **[repo-only]**

Syntax: `receipt whoami [--target …] [--json]`
Handler `commandWhoami` (`commands.ts:971-1012`).

Text (`commands.ts:1006-1011`):
```
Signed in: <email|userId|user>
Target: <target>
Workspace: <name|Default> (<workspaceId|organizationId>)
Gateway: <gatewayUrl>
```
or `receipt whoami: not signed in`.

JSON: `{ ok: <boolean, false when no session>, session?: { target, gatewayUrl, authUrl, userId, userEmail, organizationId, workspaceId, workspaceName, savedAt, sessionFile, targetSessionFile } }`. **The token is never printed.**

---

### 8.5 `receipt doctor` **[repo-only]**

Syntax: `receipt doctor [--json] [--output-file <path>] [--repo-root <path>]`
Handler `commandDoctor` (`commands.ts:2710-2723`) → `runReceiptDoctor` (`cli/doctor.ts:258-436`).

`--repo-root` defaults to `ROOT` (= `process.cwd()`, `cli/runtime.ts:21`).

#### What it probes

Five binaries, resolved in parallel (`doctor.ts:263-285`). For each: `$<OVERRIDE>` env var → a known runtime path → `Bun.which(name)` → `which`/`where` (`doctor.ts:158-206`). Then `<path> --version` is executed; the first non-empty line of stdout+stderr becomes `version`.

| binary | override env var | runtime path | line |
|---|---|---|---|
| `bun` | `RECEIPT_BUN_BIN` | `resolveBunRuntime()` | 264-268 |
| `git` | `RECEIPT_GIT_BIN` | — | 269-272 |
| `gh` | `RECEIPT_GH_BIN` | — | 273-276 |
| `aws` | `RECEIPT_AWS_BIN` | — | 277-280 |
| `codex` | `RECEIPT_CODEX_BIN` | — | 281-284 |

Repo probe (`doctor.ts:294-319`), only if `git` resolved: `git -C <requestedRepoRoot> rev-parse --show-toplevel`, then in parallel `rev-parse --abbrev-ref HEAD`, `status --porcelain`, `remote -v`.

Factory-config probe (`doctor.ts:225-256`): reads `<detectedRepoRoot|requestedRepoRoot>/.receipt/config.json`; reports `configPath` + `configPresent`; an unparsable file is still `configPresent: true` but yields no `dataDir`.

Data dir (`doctor.ts:323-326`): `$RECEIPT_DATA_DIR` → `$DATA_DIR` → config `dataDir` → `<detectedRepoRoot>/.receipt/data` → the `DATA_DIR` passed in.

GitHub auth (`doctor.ts:328-340`): `gh auth status`; the first non-empty output line becomes `summary` or `error`.
AWS auth (`doctor.ts:342-377`): `aws sts get-caller-identity --output json`, decoded defensively into `{ accountId, arn, userId }` (`doctor.ts:101-113`); invalid JSON yields the error `aws sts get-caller-identity returned invalid JSON`.

Execution info (`doctor.ts:379-380`): `resolveDefaultFactoryExecutionPath()` = `$RECEIPT_FACTORY_EXECUTION_PATH` or `"computer"`; `resolveFactoryComputerProvider()` = `$RECEIPT_FACTORY_COMPUTER_PROVIDER` or `"opensandbox"` (`modules/factory/execution-policy.ts:22-30, 46-55`).

#### Blocking vs warning — the authoritative list

**Blocking** (`doctor.ts:381-386`) — these and only these set `ok: false`:
1. `bun unavailable: <error|missing>`
2. `git unavailable: <error|missing>`
3. `codex unavailable: <error|missing>`
4. `repo invalid: <repoError|"not a git repository">`

**Warnings** (`doctor.ts:388-392`) — never affect `ok`:
1. `Factory config missing at <configPath>`
2. `GitHub auth unavailable: <error|"gh auth status failed">`
3. `AWS auth unavailable: <error|"aws sts get-caller-identity failed">`

> **`gh` and `aws` being missing entirely are warnings, not blockers** — the missing-binary error is folded into the corresponding auth warning.
> **`receipt doctor` never changes the exit code.** `commandDoctor` (`commands.ts:2710-2723`) does not set `process.exitCode`, so `receipt doctor` exits `0` even when `ok` is `false`. Automation must read `.ok` / `.blockingIssues`, not `$?`.

#### JSON shape (`ReceiptDoctorReport`, `doctor.ts:38-71`)

```json
{
  "ok": true,
  "cwd": "…",
  "requestedRepoRoot": "…",
  "dataDir": "…",
  "configPath": "…/.receipt/config.json",
  "configPresent": true,
  "execution": { "path": "computer", "computerProvider": "opensandbox" },
  "binaries": {
    "bun":   { "ok": true, "path": "…", "source": "override|runtime|lookup", "version": "…", "error": "…" },
    "git":   { … }, "gh": { … }, "aws": { … }, "codex": { … }
  },
  "repo": { "ok": true, "root": "…", "branch": "main", "dirty": false,
            "changedCount": 0, "remotes": [{ "name": "origin", "fetchUrl": "…", "pushUrl": "…" }], "error": "…" },
  "auth": {
    "github": { "ok": true, "summary": "…", "error": "…" },
    "aws":    { "ok": true, "summary": "<accountId> <arn>", "accountId": "…", "arn": "…", "userId": "…", "error": "…" }
  },
  "blockingIssues": [], "warnings": []
}
```
Optional keys are omitted, not set to `null` (`exactOptionalObject`, `lib/exact-optional.ts:5-19`).

#### Text output (`renderReceiptDoctorText`, `doctor.ts:438-464`) — exact line templates

```
doctor: ok|blocked
cwd: <cwd>
repo root: <repo.root|requestedRepoRoot>
data dir: <dataDir>
factory config: <configPath>  |  missing (<configPath|unknown>)
provider auth: organization BYOK required
bun: <path> (<version>)   |  <error|missing>
git: <path> (<version>)   |  <error|missing>
gh: <path> (<github summary>)  |  <error|missing>
aws: <path> (<aws summary>)    |  <error|missing>
codex: <path> (<version>)      |  <error|missing>
repo status: <branch|HEAD> clean | <branch> dirty (<n> changed)  |  <error|not a git repo>
remotes: <name>=<url>, …                     (only when remotes exist)
blocking issues:
- <issue>                                    (only when non-empty)
warnings:
- <warning>                                  (only when non-empty)
```

The literal line `provider auth: organization BYOK required` replaces the old OpenAI-key check.

---

### 8.6 `receipt new <agent-id>` **[repo-only]**

Syntax: `receipt new <agent-id> [--template basic|assistant-tool|human-loop|merge]` (default `basic`, `commands.ts:5304`).
Handler `commandNew` (`commands.ts:123-207`).

- ID must match `^[a-z][a-z0-9-]*$`; else `Invalid agent id '<id>'. Use kebab-case.` (`:124-126`).
- Target: `<ROOT>/src/agents/<id>.agent.ts` — the **repo-root `src/` tree**, not `packages/receipt-app/src` (`:127`). Existing file → `Agent file already exists: <abs path>` (`:128-130`).
- Templates change the declared receipts and the single generated action:
  - `basic` → receipts `task.requested`, `task.completed`; `action("complete", …)`.
  - `assistant-tool` → same receipts; `assistant("draft", …)` emitting `` `Draft: ${prompt}` ``.
  - `human-loop` → receipts `task.requested`, `approval.received`, `task.completed`; `human("approve", …)`; the view also exposes `approval`.
  - `merge` → receipts `task.requested`, `candidate.generated`, `draft.finalized`; falls back to the `basic` action body (`:153-182`) — i.e. the generated `merge` file emits `task.completed`, a receipt it never declares. **This template produces code that will not type-check.** Worth a docs caveat or an issue.
- An unrecognised `--template` value silently behaves like `basic`.
- Prints `created <path relative to ROOT>` (`:206`).

---

### 8.7 `receipt dev` **[repo-only]**

Syntax: `receipt dev` — takes no flags or arguments.
Handler `spawnDevServer` (`cli/runtime.ts:110-128`): `spawn(resolveBunRuntime(), ["scripts/start-resonate-dev.mjs"], { cwd: ROOT, env: process.env, stdio: "inherit" })`. Exit code `0` resolves; anything else rejects with `receipt dev exited with code <code|null>` (`runtime.ts:124`). The script exists at `scripts/start-resonate-dev.mjs`.

---

### 8.8 `receipt run <agent-id>` **[repo-only]**

Syntax: `receipt run <agent-id> --problem <text> [--prompt <text>] [--run-id <id>] [--stream <stream>] [--run-stream <stream>]`
Handler `commandRun` (`commands.ts:209-296`).

- `--problem`, aliased `--prompt`; missing → `--problem is required` (`:210-211`).
- `--run-id` defaults to `run_<base36 now>_<4 random base36 chars>` (`:212-214`).
- `--stream` defaults to `agents/<agentId>` (`:215`).
- `--run-stream` defaults to `<stream>/runs/<runId>` (`:216`).
- Loads `<ROOT>/src/agents/<agentId>.agent.ts` and takes its default export (`runtime.ts:83-90`).
- The export must look like a `defineAgent` spec: object with string `id`, string `version`, function `view`, function `actions`, function `goal`, and a truthy object `receipts` (`runtime.ts:71-81`).
- Seeds `task.requested` if the spec declares it, else `prompt.received` if declared, else nothing (`commands.ts:236-249`).
- Runs the agent loop **inline** with a Resonate-backed remote-action adapter.
- Prints
  ```json
  { "ok": <status === "completed">, "status": "…", "mode": "inline",
    "runId": "…", "stream": "…", "runStream": "…", "reason": "…" }
  ```
  (`reason` only when `status === "blocked"`.) A non-`completed` status sets `process.exitCode = 2` (`:288`).
- **The queued mode is gone.** A non-`defineAgent` export throws:
  `Agent '<id>' is not a receipt-native defineAgent spec. The legacy queued agent.run loop was removed; use Factory objective ingress or defineAgent.` (`:292-295`).

**Usage-text bug:** `printUsage` (`shared.ts:100`) advertises `--max-iterations <n>` and `--workspace <path>`; `commandRun` reads neither.

---

### 8.9 `receipt trace <run-id|stream>` **[repo-only]**

Syntax: `receipt trace <run-id|stream> [--json] [--output-file <path>]`
Handler `commandTrace` (`commands.ts:339-368`).

- Resolves the stream (§13), reads the chain, maps each receipt to `{ index, ts, isoTs, type }` (`type` falls back to `"unknown"`).
- Text mode: one line per receipt, `<index padStart(4," ")>  <ISO ts>  <type>` (`:362-366`).
- JSON mode: `{ "stream": "…", "receipts": [ { index, ts, isoTs, type } ] }`.

---

### 8.10 `receipt replay <run-id|stream>` **[repo-only]**

Syntax: `receipt replay <run-id|stream> [--output-file <path>]`
Handler `commandReplay` (`commands.ts:370-381`). **Always JSON** — `asJson: true` is hard-coded (`:378`); `--json` is a no-op.
Output: `{ "stream": "…", "receipts": [ <full receipt body>, … ] }`.

---

### 8.11 `receipt inspect <run-id|stream>` **[repo-only]**

Syntax: `receipt inspect <run-id|stream> [--output-file <path>]`
Handler `commandInspect` (`commands.ts:383-398`). Always JSON.
Output: `{ "stream": "…", "count": <n>, "head": <last receipt body|null> }`. Note `head` is the **last** entry of the chain (`:395`), i.e. the newest receipt.

---

### 8.12 `receipt fork <run-id|stream>` **[repo-only]**

Syntax: `receipt fork <run-id|stream> --at <index> [--name <branch-stream>]`
Handler `commandFork` (`commands.ts:444-483`).

- `--at` required → `--at is required`; must be a finite non-negative number → `--at must be a non-negative number` (`:448-452`). It is floored.
- `--name` defaults to `<stream>/branches/fork_<base36 now>_<floor(at)>` (`:455-457`).
- Prints `{ "ok": true, "stream": "…", "at": <n>, "branch": "…" }`.

---

### 8.13 `receipt dst [<prefix>]` (alias `receipt simulate`) **[repo-only]**

Syntax: `receipt dst [<prefix>] [--prefix <prefix>] [--context] [--json] [--limit <n>] [--strict] [--output-file <path>]`
Handler `commandDst` (`commands.ts:400-442`) → `runReceiptDstAudit` (`cli/dst.ts:565-628`).

- `<prefix>` may be positional or `--prefix`.
- `--context` additionally audits Factory task packets (`runReceiptContextDstAudit`), requiring `repoRoot` (always supplied as `ROOT`) (`dst.ts:601-610`).
- `--limit <n>` affects **text mode only**; the renderer defaults to 20 and shows `- ... <n> more stream(s) omitted` when truncated (`dst.ts:636, 675-677`).
- `--strict` throws `DST audit found receipt issues` **after** printing, when any of `integrityFailures`, `replayFailures`, `deterministicFailures` (receipt or context) is non-zero (`commands.ts:430-441`). That makes the process exit `1` with `error: DST audit found receipt issues` on stderr.

JSON shape (`ReceiptDstAuditReport`, `dst.ts:139-150`):
```json
{ "scannedAt": "ISO", "dataDir": "…", "streamCount": 12,
  "kinds": { "factory.objective": 0, "job": 0, "agent.history": 0,
             "agent.control": 0, "eval.run": 0, "computer_use.session": 0, "generic": 0 },
  "statusCounts": { "<kind>": { "<status>": <n> } },
  "integrityFailures": 0, "replayFailures": 0, "deterministicFailures": 0,
  "streams": [ { "stream", "kind", "receiptCount", "branch?": {"parent","forkAt"},
                 "integrity": {"ok","error?"}, "replay": {…}, "deterministic": {…},
                 "eventTypes": {"<type>": <n>}, "summary": { … per-kind … } } ],
  "context": { … only with --context … } }
```
Streams are sorted failures-first, then by descending receipt count, then by name (`dst.ts:572-578`).

Text shape (`renderReceiptDstAuditText`, `dst.ts:630-684`):
```
Receipt DST Audit
Data dir: <dataDir>
Scanned: <n> streams
Integrity failures: <n>
Replay failures: <n>
Deterministic failures: <n>

Kinds:
- <kind>: <count> (<status>:<n>, …)

Issues:                                   (only when failures exist)
- <stream> [<kind>] integrity=<err> | replay=<err> | deterministic=<err>

Streams:
- <stream> [<kind>] receipts=<n> <summary>
- ... <n> more stream(s) omitted          (only when truncated)

<context section>                         (only with --context)
```

Stream kinds recognised (`dst.ts:34-41`): `factory.objective`, `job`, `agent.history`, `agent.control`, `eval.run`, `computer_use.session`, `generic`.

---

### 8.14 `receipt jobs …` **[repo-only]**

Handler `commandJobs` (`commands.ts:610-638`). Subcommands: `list` (also the default when no subcommand), `enqueue`, `wait`, `steer`, `follow-up`, `abort`. Anything else → `Unknown jobs subcommand '<x>'`.

All of these instantiate `getJobBackend()` (`cli/runtime.ts:36-43`), which needs both Postgres (`ZERO_UPSTREAM_DB`) and a reachable Resonate server.

#### `receipt jobs [list]`
`[--status queued|leased|running|completed|failed|canceled] [--limit <n>] [--output-file <path>]`
`commandJobsList` (`commands.ts:485-505`). `--limit` defaults to 50 and is clamped 1…500; a non-numeric value falls back to 50 (`:489-494`). `--status` is passed straight through without validation. **Always JSON**: `{ "jobs": [ … ] }`.

#### `receipt jobs enqueue <agent-id>`
`[--lane chat|collect|steer|follow_up] [--payload-json '<json>'] [--job-id <id>] [--max-attempts <n>] [--session-key <key>] [--singleton-mode allow|cancel|steer]`
`commandJobsEnqueue` (`commands.ts:526-566`). Missing agent id → `agent id is required`. Invalid `--lane` / `--singleton-mode` values are silently dropped (the backend defaults apply: lane `collect`, singletonMode `allow`, maxAttempts `2` clamped 1…8 — `adapters/receipt-queue.ts:1359, 1403, 1409`). `--payload-json` must be a JSON object; defaults to `{}`.
Output: `{ "ok": true, "job": { … } }`.

#### `receipt jobs wait <job-id>`
`[--timeout-ms <n>] [--output-file <path>]`
`commandJobsWait` (`commands.ts:568-583`). Default timeout **15 000 ms**, poll interval 200 ms (`:576`). Missing job id → `job id is required`; not found → `job not found: <jobId>`. Always JSON: `{ "job": { … } }`.

#### `receipt jobs steer <job-id>` / `receipt jobs follow-up <job-id>`
`[--payload-json '<json>']` — `commandJobsCommand` (`commands.ts:585-608`). Queues a `steer` / `follow_up` queue command with `by: "receipt-cli"`. Not found → `job not found: <jobId>`.
Output: `{ "ok": true, "jobId": "…", "commandId": "…" }`.

#### `receipt jobs abort <job-id>` and `receipt abort <job-id>`
`[--reason <text>]` — both route to `commandAbort` (`commands.ts:507-524`, `:592-595`). `--reason` defaults to `abort requested`. `by: "receipt-cli"`. Not found → `job not found: <jobId>`.
Output: `{ "ok": true, "jobId": "…", "commandId": "…" }`.

---

### 8.15 `receipt memory …` **[repo-only]**

Handler `commandMemory` (`commands.ts:2517-2645`). Subcommands: `read`, `search`, `summarize`, `commit`, `diff`, plus `prefs`. Missing subcommand → `memory subcommand is required`; unknown → `Unknown memory subcommand '<x>'`.

**All memory subcommands (except `prefs`) require a `<scope>` positional** (`commands.ts:2527-2528`, `memory scope is required`).

**All memory subcommands require an actor identity** via `resolveCliActorAudit` (`commands.ts:1666-1689`):
- user id from `--user-id` or `$RECEIPT_CONNECT_USER_ID`; missing → `memory.<sub> requires --user-id or RECEIPT_CONNECT_USER_ID`
- org id from `--organization-id` / `--org-id` or `$RECEIPT_CONNECT_ORGANIZATION_ID`; missing → `memory.<sub> requires --organization-id or RECEIPT_CONNECT_ORGANIZATION_ID`

Since `applyReceiptCliSessionEnvDefaults` seeds those from the saved session, `receipt login` is normally enough. The audit record sent to the memory tools is `{ userId, organizationId, source: "cli", actor: "cli", command: "memory.<sub>" }`.

| subcommand | syntax | flags | output |
|---|---|---|---|
| `read` | `receipt memory read <scope>` | `--limit <n>` (default 20, clamped 1…500 — `adapters/memory-tools.ts:572`), `--output-file` | `{ "entries": [...] }` |
| `search` | `receipt memory search <scope> [query…]` | `--query <text>` **or** trailing text (required → `memory search requires --query or trailing query text`), `--limit <n>` (default 20, 1…500), `--output-file` | `{ "entries": [...] }` |
| `summarize` | `receipt memory summarize <scope> [query…]` | `--query`, `--limit` (default 20, 1…500), `--max-chars <n>` (default 2 400, clamped 100…12 000 — `memory-tools.ts:605`), `--output-file` | `{ "summary": "…", "entries": [...] }` |
| `commit` | `receipt memory commit <scope> [text…]` | `--text <text>` **or** trailing text (required → `memory commit requires --text or trailing text`), `--tags a,b,c` (comma-split, trimmed, empties dropped) | `{ "entry": { … } }` |
| `diff` | `receipt memory diff <scope>` | `--from-ts <epoch-ms>` **required** (`memory diff requires --from-ts`), `--to-ts <epoch-ms>`, `--output-file` | `{ "entries": [...] }` |

`read`, `search`, `summarize`, `diff` are always JSON. `commit` prints its JSON with `console.log` (so `--output-file` is ignored there).

#### `receipt memory prefs <list|add|remove>`
`commandMemoryPrefs` (`commands.ts:2405-2515`). Subcommand defaults to `list`. Same actor-audit requirement, with `command` set to `memory.prefs.<sub>`.

- `--scope layered|repo|global` (default `layered`, lowercased/trimmed — `:2413-2415`).
- Repo scope key comes from `--repo-root <path>` or the detected git root, hashed by `repoKeyForRoot` (`commands.ts:2400-2403`).
- `layered` → repo scope then global scope; `repo` → repo only; `global` → global only.
- `list` → `{ "scopes": ["…"], "entries": [...] }` (JSON, honours `--output-file`).
- `add [text…]` → `--text` or trailing text required (`memory prefs add requires --text or trailing text`); commits with `source: "explicit_user"`, `runId: "cli_memory_prefs_add"`. Prints `{ "entry": … }`.
- `remove <entry-id>` → entry id required (`memory prefs remove requires an entry id`); unknown id → `Unknown preference entry '<id>'`. Prints `{ "removed": …, "entryId": "…", "scope": "…" }`.
- Unknown subcommand → `Unknown memory prefs subcommand '<x>'`.

---

### 8.16 `receipt sessions <search|read>` **[repo-only]**

Handler `commandSessions` (`commands.ts:2647-2708`). Missing subcommand → `sessions subcommand is required`; unknown → `Unknown sessions subcommand '<x>'`. **No actor audit required.** Reads Postgres directly.

- `receipt sessions search [query…] [--query <text>] [--limit <n>] [--repo-key <k>] [--profile <id>] [--session-stream <stream>] [--output-file <path>]`
  Query required (`sessions search requires --query or trailing query text`). Limit default 10, clamped 1…100 (`services/session-history.ts:245`). Uses Postgres full-text search over `session_messages`. Output `{ "results": [...] }`.
- `receipt sessions read <chat-id|session-stream> [--limit <n>] [--output-file <path>]`
  Target required (`sessions read requires a chat id or session stream`). A target containing `/sessions/` is treated as a session stream, otherwise as a chat id (`commands.ts:2693-2694`). Limit default 200, clamped 1…1 000 (`session-history.ts:212`). Output `{ "messages": [...] }`.

---

### 8.17 `receipt eval …` **[repo-only]**

Handler `commandEval` (`cli/eval.ts:88-209`). Missing subcommand → `eval subcommand is required`; unknown → `Unknown eval subcommand '<x>'`. All subcommands accept `--json` and `--output-file` (envelope per §7.2).

| subcommand | syntax | notes |
|---|---|---|
| `run` | `receipt eval run <scenario-id\|path>` | required (`eval run requires a scenario id or path`). Text output: `completed <runId> (<status>)` (`eval.ts:109`). |
| `batch` | `receipt eval batch [<scenario-dir>]` | Text output: `ran <n> scenario(s): passed=<p> failed=<f>` (`eval.ts:133`). |
| `report` | `receipt eval report [--limit <n>]` | limit default 20, clamped 1…200 (`eval.ts:139`). |
| `inspect` | `receipt eval inspect <run-id>` | required (`eval inspect requires a run id`); unknown → `eval run '<id>' not found`. JSON: `{ run, session }`. |
| `replay` | `receipt eval replay <run-id>` | same errors; JSON: `{ run, evalDst, sessionDst }`. |
| `list-scenarios` | `receipt eval list-scenarios [<scenario-dir>]` | JSON `{ scenarios: [<abs paths>] }`; text = newline-joined paths. |

`--organization-id <id>` is read by every subcommand that runs scenarios, to fetch the org’s BYOK OpenAI key for the semantic oracle (`eval.ts:23-27`). Without it, the semantic oracle is not configured.

Scenario root default: `<repoRoot>/eval/scenarios` (`services/eval/scenarios.ts:6, 83-86`); the repo ships `eval/scenarios/software` and `eval/scenarios/computer-use`.

`run`, `batch`, `report`, `inspect`, `replay` all call `syncChangedEvalRunProjections(DATA_DIR)` (and, except `report`, `syncChangedComputerUseSessionProjections`) first, so they need the Postgres store.

Text renderers:
```
Receipt Eval Inspect                        (eval.ts:51-63)
Run ID: … / Scenario: … / Kind: … / Status: … / Started: … / Completed: … |n/a
Summary: … |n/a / Artifacts: … / Workspace: …            (workspace line optional)
Computer-use session: <id> state=<stateId|unknown> status=<status>   (optional)

Receipt Eval Report                         (eval.ts:65-86)
Runs: <n> / Pass rate: <passed>/<total>
Abstraction miss rate: <0.00> / Revert rate: <0.00>
Strong handoff completeness rate: <0.00>

- <runId> [<kind>] status=<s> overall=<x>/<y> scenario=<id>
```

---

### 8.18 `receipt debug …` **[repo-only]**

Handler `commandDebug` (`commands.ts:5162-5197`). Subcommand defaults to `local`. Unknown subcommand error:
`Unknown debug subcommand '<x>'. Use token, local, prod, probe, objective, job-abort, prod-probe, prod-objective, or prod-job-abort.`

| subcommand | aliases | handler |
|---|---|---|
| `token` | `jwt`, `mint` | `commandDebugToken` (`:2117`) |
| `local` | `snapshot` | `commandDebugLocal` (`:4443`) |
| `prod` | — | `commandDebugProd` (`:4662`) |
| `probe` | `prod-probe` | `commandDebugProdProbe` (`:3593`) |
| `objective` | `prod-objective` | `commandDebugProdObjective` (`:4014`) |
| `job-abort` | `prod-job-abort` | `commandDebugProdJobAbort` (`:4246`) |

Shared target resolution (`resolveReceiptDebugTarget`, `commands.ts:3310-3365`):
- Mode from `--target` or `--mode` (`debugTargetModeFromFlags`, `:3284-3292`). `local`/`dev` → `local`; `prod`/`production`/`remote` → `prod`; anything else throws `Unsupported debug target '<raw>'. Use local or prod.`
- `--stage` → `.sst/outputs.json` `stage` → `"factory"`.
- `--region` → `$AWS_REGION` → `$AWS_DEFAULT_REGION` → `"us-east-1"`.
- Prod base URL precedence (`prodDebugBaseUrlFromInputs`, `:3221-3264`), each candidate rejected if empty, localhost/`127.0.0.1`/`::1`, or `*.cloudfront.net` (`:3196-3219`):
  1. `--web-url`
  2. `$RECEIPT_PROD_WEB_URL` ?? `$RECEIPT_PROD_DEBUG_WEB_URL`
  3. the saved **prod** CLI session’s `gatewayUrl`
  4. `$RECEIPT_PUBLIC_BASE_URL` ?? `$RECEIPT_CONNECT_PUBLIC_GATEWAY_URL`
  5. `.sst/outputs.json` `gatewayHttps` ?? `gateway`
  Missing → `receipt debug <name> requires a production web URL from --web-url, RECEIPT_PUBLIC_BASE_URL, or deployed stack outputs.`
- Local base URL (`:3294-3301`): `--local-url` → `--runtime-url` → `$RECEIPT_LOCAL_DEBUG_URL` → `$RECEIPT_RUNTIME_URL` → `http://127.0.0.1:8787` (`:3082`). Missing → `… requires a local runtime URL from --local-url, --runtime-url, or RECEIPT_LOCAL_DEBUG_URL.`
- Prod token precedence (`resolveProdDebugToken`, `:3158-3175`): `--debug-token` → `$RECEIPT_PROD_DEBUG_TOKEN` → `$RECEIPT_DEBUG_TOKEN` → key `ReceiptDebugToken` in `$RECEIPT_FACTORY_SECRETS_FILE` or `deploy/factory.secrets.env` → `sst secret list --stage <stage>` (via `$RECEIPT_SST_BIN` or `bunx sst`), suppressed by `RECEIPT_DISABLE_SST_SECRET_LOOKUP=1` (`:3131-3156`).
- Local token (`:3303-3308`): `--debug-token` → `$RECEIPT_DEBUG_TOKEN` only.
- Missing required token → `receipt debug <name> requires ReceiptDebugToken, RECEIPT_PROD_DEBUG_TOKEN, RECEIPT_DEBUG_TOKEN, or --debug-token.<optional resolution error>`

HTTP checks are made by shelling out to `curl -sS --max-time … --request … --header 'Connection: close' … --write-out '\n__RECEIPT_HTTP_STATUS__:%{http_code}'` (`commands.ts:2905-2988`), not `fetch`. Errors are redacted: `Authorization: Bearer <x>` → `Authorization: Bearer [redacted]`, `Bearer <x>` → `Bearer [redacted]` (`:2990-2993`).

#### 8.18.1 `receipt debug token` (aliases `jwt`, `mint`)

`--operator-id <id>` (alias `--operator`) **required** → `receipt debug token requires --operator-id`.
`--reason <text>` **required** → `receipt debug token requires --reason`.
`--ttl-seconds <n>` / `--ttl <n>`, else `--ttl-minutes <n>` × 60 (default 15 min), floor 60 s (`:2126-2128`).
`--organization-id` / `--org-id` optional.
`--scopes debug:read,debug:write,debug:objective` — invalid entries throw `Unsupported Receipt debug token scope "<x>". Use debug:read, debug:write, or debug:objective.` (`:2089-2112`).
Requires `$RECEIPT_DEBUG_JWT_SECRET`, else `RECEIPT_DEBUG_JWT_SECRET is required` (`services/receipt-debug-auth-token.ts:116-118`). HS256, `iss: "receipt"`, `aud: "receipt-debug"`.

Output modes (`:2144-2172`):
- `--json` → `{ ok, operatorId, organizationId, reason, ttlSeconds, scopes, token }` (scopes defaults to all three).
- `--export` / `--env` / `--print-env` → `export RECEIPT_PROD_DEBUG_TOKEN='<token>'` (single-quote escaped, `:2114-2115`).
- otherwise the bare token on stdout.

#### 8.18.2 `receipt debug local` (alias `snapshot`)

`[--context] [--json] [--job-limit <n>|--limit <n>] [--dst-prefix <prefix>|--prefix <prefix>] [--repo-root <path>] [--output-file <path>]`
`commandDebugLocal` (`commands.ts:4443-4660`).

Runs three probes, each catching its own failure into a check + finding rather than aborting:
1. `runReceiptDoctor` (same as `receipt doctor`).
2. `getJobBackend().listJobs({ limit })` — `--job-limit` default 50, clamped 1…500.
3. `runReceiptDstAudit(DATA_DIR, { includeContext, repoRoot, prefix })`.

Findings emitted (`:4515-4594`):
| severity | layer | message |
|---|---|---|
| error | receipt | `Receipt doctor reported blocking runtime issues.` |
| warning | local | `Receipt doctor reported warnings.` |
| error | receipt | `DST found receipt stream integrity, replay, or determinism failures.` |
| error | receipt | `Context DST found Factory worker packet failures.` |
| info | receipt | `Active jobs are present.` |
| warning | receipt | `Recent jobs include completed or terminal runs with degraded results.` |
| error | local | `Receipt doctor failed before producing a report.` |
| error | receipt | `Receipt queue inspection failed.` |
| error | receipt | `DST audit failed before producing a report.` |

“Degraded” recent jobs are classified by `classifyRecentJobForDebug` (`:4390-4441`): a `result.failure.message`, a `job.lastError`, or a `result.finalResponse` matching any of `/please retry/i`, `/timed? out/i`, `/failed/i`, `/policy:/i`, `/not in the .*command index/i`, `/if you tell me/i`, `/paste .*output/i`, `/i need to see/i`.

`ok` = no `error`-severity finding (`:4596`). **Exit code is not affected.**

JSON shape:
```json
{ "ok": true, "target": "local", "scannedAt": "ISO", "dataDir": "…",
  "findings": [ { "severity", "layer", "message", "evidence?", "next?" } ],
  "summary": { "jobs": { "<status>": n }, "degradedJobs": [ … ],
               "dst": { "streamCount", "integrityFailures", "replayFailures",
                        "deterministicFailures", "context": { … } } },
  "doctor": { …full doctor report… },
  "recentJobs": [ …first 20… ] }
```

Text shape (`renderDebugText`, `:4301-4368`):
```
Receipt debug local: ok|issues found

Findings:
  none
  [<severity>] <layer>: <message>
    evidence: <…>
    next: <…>

Receipt Stream:                             (prod only, when --receipt-stream used)
  <stream> receipts=<n> source=prod-debug|local
  latest <ISO>: <status> <note>
  no-visible-progress run.status count=<n>
  failed <stream>: <error>

Checks:
  ok|failed <name> (<command…>) (<METHOD> <url> -> <status>)
    <first error/stderr/stdout line, ≤240 chars>
```

#### 8.18.3 `receipt debug prod`

`[--json] [--job <job-id>|--job-id <id>] [--status queued|leased|running|completed|failed|canceled] [--job-limit <n>] [--receipt-stream <stream>] [--receipt-limit <n>] [--receipt-replay] [--receipt-replay-limit <n>] [--debug-token <token>] [--web-url <url>] [--stage <name>] [--region <name>] [--aws-checks] [--log-limit <n>] [--log-minutes <n>] [--require-debug-token] [--output-file <path>]`
`commandDebugProd` (`commands.ts:4662-5160`). `requireBaseUrl: false` — it degrades gracefully when no prod URL is known.

Defaults and clamps:
- `--log-limit` default 30 (`:4663`); used as `--limit` for `describe-log-groups` clamped 1…50 and for `filter-log-events` clamped 1…100.
- `--log-minutes` default 120, clamped 5…1440 (`:4832`).
- `--job-limit` default 20, clamped 1…200 for the snapshot query (`:4702, :4716`).
- `--receipt-limit` default 12, clamped 1…50 (`:4682-4685`).
- `--receipt-replay-limit` (alias `--replay-limit`) default 250, clamped to 10 000 (`MAX_RECEIPT_DEBUG_REPLAY_LIMIT`, `:121, :4692-4700`).
- Stream flag aliases: `--receipt-stream`, `--receiptStream`, `--chat-stream`, `--chatStream`, `--stream` (`:3379-3384`).
- Replay flag aliases: `--receipt-replay`, `--receiptReplay`, `--include-receipts`, `--includeReceipts`, `--replay` (`:4686-4691`).
- AWS-check aliases: `--aws-checks`, `--aws`, `--control-plane` (`:4676-4679`).

Unauthenticated checks when a web URL is known (`:4736-4750`):
- `prod-web-health` → `GET <web>/health`, expect 200
- `prod-chat-page` → `GET <web>/chat`, expect 200/302/307/308
- `prod-connect-capabilities-unauthenticated` → `GET <web>/connect/capabilities`, **expect 401** (401 is the healthy answer)

Authenticated check when a token and web URL exist: `prod-runtime-debug-snapshot` → `GET <web>/receipt-debug/snapshot?limit=<n>[&jobId=…][&status=…]`.

With `--aws-checks`, six local `aws` CLI calls run against the operator’s own credentials (`:4760-4820`): `sts get-caller-identity`, `cloudformation list-stacks`, `ecs list-clusters`, `elbv2 describe-load-balancers`, `rds describe-db-instances`, `logs describe-log-groups --log-group-name-prefix /sst/cluster/receipt-factory-<stage>`. Then up to 8 discovered `Runtime`/`Gateway`/`Resonate` log groups get `logs filter-log-events` (`:4835-4860`, `:3266-3282`). Without the flag, a single synthetic check is emitted:
`{ name: "prod-local-aws-diagnostics", ok: true, data: { skipped: true, reason: "Pass --aws-checks to run local AWS/ECS/CloudWatch diagnostics." } }` (`:4821-4828`).

`--receipt-stream` with a token reads `GET <web>/receipt-debug/receipts?stream=…&recentLimit=…[&includeReceipts=1&replayLimit=…]`; **without** a token it falls back to reading the local receipt store (`:4919-4922`).

Notable findings and their `next` text (`:4929-5112`):
- token missing while `--job` or `--require-debug-token`: error/receipt, next `Run \`bun run factory:secrets:load\` and redeploy, or pass --debug-token for this invocation.` ← internal-only guidance.
- receipt stream unreadable without a token: warning/receipt, next `Pass --debug-token or set RECEIPT_PROD_DEBUG_TOKEN, then rerun with --receipt-stream.`
- missing local capabilities (only when `--aws-checks`): error/connect.
- any failed command check → error, layer inferred from the check name prefix (`aws` → aws, `sst` → sst, else `opensandbox`).
- any failed URL check → error, layer `connect` when the name contains `connect`, else `aws`.
- classified runtime-log categories (via `services/prod-debug-summary`).
- Resonate poll failures: warning/aws, next mentions `RESONATE_URL`, Cloud Map, ECS.
- repeated stalled progress in the receipt stream: warning/receipt.
- `receipt connect upstream unavailable` in the logs: error/connect, next comes from `cli/prod-debug-guidance.ts:1-6`, exactly:
  `Verify the workspace connection in Organization Settings > Integrations. Then confirm the public gateway URL routes /connect/* to the Receipt runtime.`

JSON report keys (`:5113-5153`): `ok`, `target: "prod"`, `scannedAt`, `stage`, `region`, `services`, `findings`, `checks`, `nextCommands`, and optionally `webUrl`, `debugTokenSource`, `sstOutputs`, `prodRuntimeDebug`, `runtimeLogSummary`, `receiptStreamDebug`. `nextCommands` is a fixed six-entry list of suggested follow-ups (`:5134-5141`).

#### 8.18.4 `receipt debug probe` / `prod-probe`

`commandDebugProdProbe` (`commands.ts:3593-3796`). **By default this is now a thin wrapper**: unless `--legacy-job-probe` is passed, it rewrites the flags and delegates to `commandDebugProdObjective` with `objective-mode=investigation`, `execution-path=computer`, `require-connect=false`, and a prompt of `Return exactly this string and nothing else: <reply>` (`:3594-3605`).

The legacy path (`--legacy-job-probe`) posts to `POST <web>/receipt-debug/probes/codex` and polls `GET <web>/receipt-debug/snapshot?jobId=…&limit=8`:
- `--preset <name>` default `exact-reply`; `--prompt <text>`; `--reply <text>` default `receipt-prod-probe-<base36 now>-<cycle>` (`:3466-3483`)
- `--cycles <n>` default 1, clamped 1…20
- `--timeout-ms <n>` default 120 000, clamped 30 000…300 000
- `--poll-ms <n>` default 5 000, clamped 1 000…30 000
- `--model <id>` default `DEFAULT_FACTORY_TASK_CODEX_MODEL`; `--model-provider <openai|amazon-bedrock>`
- `--read-only true|false` default `false`
- `--wait` (default true; `--wait false` disables), `--artifacts` (default true), `--stream-logs`
- `--user-id`, `--organization-id`

With `--stream-logs`, Codex stdout/stderr deltas are written to **stderr** prefixed `[codex stdout] ` / `[codex stderr] ` (`:3532-3564`).

Text output (`:3783-3794`):
```
prod probe ok=<bool> cycles=<n>
<preset> <jobId|no-job> queue=<status|unknown> result=<status|unknown> summary=<≤220 chars>
```

#### 8.18.5 `receipt debug objective` / `prod-objective`

`commandDebugProdObjective` (`commands.ts:4014-4244`).

Flags:
- `--target local|prod` (default prod), plus every shared target/token flag.
- `--objective-id <id>`, `--prompt <text>`, `--title <text>`, `--objective-mode <mode>`, `--execution-path <path>`, `--receipt-connect-gateway-url <url>`, `--chat-id <id>` (`:4046-4054`).
- `--user-id` / `--organization-id`, defaulting to the saved prod session’s `userId`/`organizationId` (`:4043-4044`).
- `--severity <n>`.
- `--required-capability aws[,vercel]` — comma/newline split, repeatable (`:3433-3444`). Sent twice for API-migration compatibility: `requiredCapability` (first entry) **and** `requiredCapabilities` (whole list) — `:3456-3464`.
- `--checks '<cmd>[,<cmd>]'` or `--no-checks`. Both together → `receipt debug prod-objective accepts either --checks or --no-checks, not both` (`:4039-4041`).
- `--require-connect true|false` default **true** (`:4031-4036`).
- `--recover-control true|false` default **true**; when true, `recoverControl=1` is added to the **first** monitor poll only (`:3999-4012, :4103`).
- `--wait` default true; `--timeout-ms` default 300 000, clamped 30 000…900 000; `--poll-ms` default 5 000, clamped 1 000…30 000.

Two request modes: if only `--objective-id` is given and no creation flags, it does a read (`GET <web>/receipt-debug/objectives/<id>`); otherwise it creates (`POST <web>/receipt-debug/probes/objective`) — `:4066-4091`.

Polling stops on a terminal objective status (`completed|blocked|failed|canceled|archived`, `:3414-3419`), or as soon as a blocking finding or blocking receipt appears. A final authoritative read is always made if the last poll was non-terminal (`:4149-4180`).

Blocking classification (exported and unit-tested):
- explicit finding codes `provider_quota_or_billing_block`, `job_failed` (`:3826-3829`)
- `stale active Resonate job lost execution` → normalised to code `stale_resonate_execution`, **unless** the message says `; retrying through Resonate driver`, in which case it is ignored (`:3831-3865`)
- receipt-summary heuristics (`:3900-3957`): quota/billing text → `provider_quota_or_billing_block`; `stale execution unrecoverable|lease_expired` → `stale_startup_reconciliation`; `turn.failed` or `no helper-backed evidence was captured` → `worker_turn_failed`

`ok` requires: submit succeeded, an `objectiveId`, objective status `completed`, and zero blocking findings and zero blocking receipts (`:4188-4194`).

Text output (`:4218-4242`):
```
prod objective ok=<bool> objective=<id|none> submit=<statusCode|unknown>
status=<s|unknown> phase=<p|unknown> jobs=<n>
finding <code|unknown>: <message>            (up to 5)
blocking receipt <type|unknown>: <summary>   (up to 5)
error=<error> <detail>                        (only on submit failure)
```

#### 8.18.6 `receipt debug job-abort` / `prod-job-abort`

`--job-id <id>` (alias `--job`) required → `receipt debug prod-job-abort requires --job-id <job-id>`.
`--reason <text>` default `operator requested prod debug job abort`.
POSTs `<web>/receipt-debug/jobs/<jobId>/abort` with `{ reason, by: "receipt-debug-cli" }`, 20 s timeout (`:4261-4270`).
Text: `prod job abort ok=<bool> job=<id> status=<code|unknown>` plus `error=<…>` on failure.
JSON: `{ ok, target, scannedAt, webUrl, jobId, statusCode, abort }`.

---

### 8.19 `receipt connect …` **[shared]** (with repo-only extras)

Handler `commandConnect` (`commands.ts:2247-2387`). `receipt connect help`, `receipt connect --help`, `receipt connect -h` print `printConnectUsage()` (`shared.ts:103-178`).

Dispatch order (`commands.ts:2251-2386`):

| subcommand | behaviour |
|---|---|
| `setup` | → `commandConnectSetup` (same as `receipt setup`) |
| `relay` | **always throws**: `receipt connect relay has been removed. Use \`receipt connect <id\|id\|…>\` to create Nango-backed connections.` (`:2262-2266`) |
| `list` | `commandConnectAgentList` — `GET <gw>/connect/agent/connections` (35 s timeout). Output `{ ok: true, connections: [...] }`; `--json` controls formatting but the value is JSON either way (`:1483-1491`). |
| `tools <connection>` | `POST <gw>/connect/tools` `{ connection }`. Missing arg → `receipt connect tools requires a connection id or provider:name` (`:1493-1507`). |
| `call <connection> <tool>` | `POST <gw>/connect/call` `{ connection, tool, arguments }` where `arguments` comes from `--json '<object>'`. |
| `call <connection> --path /x` | `POST <gw>/connect/call` `{ connection, method, path, query?, headers? }`. `--method` must be `GET` → `receipt connect call is read-only and supports GET only`. Missing path/tool → `receipt connect call requires a tool or --path beginning with /`. Optional `--query-json`, `--headers-json` (`:1529-1550`). Missing connection → `receipt connect call requires a connection id or provider:name`. |
| `import-local-aws` | **[repo-only]** § below |
| `import-local-github` | **[repo-only]** § below |
| `login` / `logout` / `whoami` | → the top-level handlers (`:2287-2298`) |
| `token` / `jwt` / `mint` | **[repo-only]** § below |
| `<connector-id>` or `nango [<id>] [<target>]` | Nango OAuth flow (`:2304-2327`) |
| `doctor` / `check` | `commandConnectCheck` **[repo-only]** |
| `status` | `commandConnectStatus` |
| `disconnect` / `remove` / `revoke` | `commandConnectDisconnect` |
| bare / `onboard` / `onboarding` / `start` / `prod` / `dev` / `local` / an `http(s)://` URL | `commandConnectOnboarding` |
| anything else | throws `unsupported Receipt Connect provider. Use <id list>.` |

#### `receipt connect` (onboarding) — `commandConnectOnboarding` (`commands.ts:1575-1619`)

Prints, verbatim:
```
Receipt Connect onboarding
Credentials are approved with your Receipt account and stored for the active workspace only.
The CLI will show account metadata, not secret values.
Signed in: <email|userId|unknown user>
Workspace: <name|Default> (<workspaceId|organizationId|unknown workspace>)
Current connections: none
Current connections:
  <provider>:<name> <status> - account <accountId> / expires <expiresAt>
```
Then either uses `--provider <id>` or prompts interactively with a numbered menu of every connector label plus `Show status only` (`promptChoice`, `:1078-1106`; non-TTY silently picks the default index). `Show status only`/`status` returns without connecting. An unrecognised choice throws `unsupported Receipt Connect onboarding choice: <choice>`.

#### `receipt connect <connector>` — `commandConnectNangoProvider` (`commands.ts:1260-1303`)

`POST <gw>/connect/nango/sessions` with `{ provider, endUserEmail? }` (`--email`). Missing link → `Nango did not return a connect link.`
Prints:
```
Step 2 of 2: authorize <provider>
  Open: <connectLink>
  Browser auto-open is disabled; open the URL above to continue.
  Press Enter to open <provider> authorization...
```
The Enter pause is skipped with `--yes` or `--auto-open`, or when not a TTY (`:1163-1175`).
With `--no-wait` or `--wait false`:
`After authorization completes, run 'receipt connect status' to verify the <provider> connection.`
Otherwise it polls `GET <gw>/connect/connections` every 2 s until a `status === "valid"` connection for the provider appears, up to `--timeout-ms` (default **10 minutes**, `:1298`). Success:
`receipt connect: <provider> connection '<name|default>' is ready for server jobs.`
Timeout: `Timed out waiting for <provider> connection; saw <provider>:<name>=<status>, …` (`:1255-1257`).

#### `receipt connect status` — `commandConnectStatus` (`commands.ts:1305-1347`)

`GET <gw>/connect/connections`. JSON when `--json` **or** `--output-file` is given:
`{ ok: true, target, gatewayUrl, organizationId, userId, connections }`.
Text:
```
receipt connect status: no server-side connections configured
receipt connect status:
  <provider>:<name> <status> - account <accountId> / <principalArn> / expires <expiresAt>
```

#### `receipt connect check|doctor [local|dev|prod]` **[repo-only]** — `commandConnectCheck` (`commands.ts:1349-1421`)

1. `GET <gw>/connect/nango/health` — must return `ok: true` **and** `reachable: true`, else throws `Receipt Connect Nango health did not report ok=true and reachable=true`.
2. Signed webhook probe: requires `$RECEIPT_INTEGRATIONS_WEBHOOK_SECRET`, else `receipt connect check requires RECEIPT_INTEGRATIONS_WEBHOOK_SECRET for the signed webhook probe`. Posts `{"type":"receipt-cli-check","operation":"probe","success":false}` to `<gw>/connect/nango/webhook` with an HMAC-SHA256 `x-nango-hmac-sha256` header.
3. `GET <gw>/connect/connections`.

JSON: `{ ok: true, target, gatewayUrl, organizationId, userId, checkedAt, nangoHealth, webhook: { ok, ignored }, connectionCount, connections }`.
Text:
```
receipt connect check: ok (<gatewayUrl>)
  Nango health: ok
  Nango webhook: accepted
  Connections: <n>
```

#### `receipt connect disconnect|remove|revoke` — `commandConnectDisconnect` (`commands.ts:1621-1656`)

`--provider <p>` default `aws`; `--name <n>` default `default`. Lists connections, finds the match, then `DELETE <gw>/connect/connections/<id>`.
`receipt connect disconnect: no <provider>:<name> connection found` or `receipt connect disconnect: removed <provider>:<name>`.

#### `receipt connect token|jwt|mint` **[repo-only]** — `commandConnectToken` (`commands.ts:2175-2245`)

`--user-id <id>` or `$RECEIPT_CONNECT_USER_ID` — else `receipt connect token requires --user-id or RECEIPT_CONNECT_USER_ID`.
`--organization-id`/`--org-id` or `$RECEIPT_CONNECT_ORGANIZATION_ID` — else `receipt connect token requires --organization-id or RECEIPT_CONNECT_ORGANIZATION_ID`.
`--ttl-seconds`/`--ttl`, else `--ttl-hours` × 3600 (default 12 h), floor 60 s.
`--session-id <id>`, `--scopes connect:read,connect:write,connect:credential` — invalid → `Unsupported Receipt Connect token scope "<x>". Use connect:read, connect:write, or connect:credential.`
Requires `$RECEIPT_CONNECT_JWT_SECRET` or `$BETTER_AUTH_SECRET` (`services/receipt-connect-auth-token.ts:131-136`).
Output: `--json` → `{ ok, target, gatewayUrl, userId, organizationId, ttlSeconds, token }`; `--export`/`--env`/`--print-env` → four `export …` lines (`RECEIPT_CONNECT_GATEWAY_URL`, `RECEIPT_CONNECT_USER_ID`, `RECEIPT_CONNECT_ORGANIZATION_ID`, `RECEIPT_CONNECT_TOKEN`); otherwise the bare token.

#### `receipt connect import-local-aws` **[repo-only]** — `commandConnectImportLocalAws` (`commands.ts:1867-2062`)

Flags: `--organization-id`/`--org-id`, `--user-id`, `--workspace-id`, `--name`, `--aws-profile`, `--local-profile-reference`, `--connection-id`, `--integration-id`, `--nango-url`, `--nango-api-key`, plus the usual target flags.

Identity resolution (`:1871-1893`): org id from flag → saved session → `$RECEIPT_CONNECT_ORGANIZATION_ID`; user id from flag → saved session → `$RECEIPT_CONNECT_USER_ID`. Missing → `--organization-id or RECEIPT_CONNECT_ORGANIZATION_ID is required` / `--user-id or RECEIPT_CONNECT_USER_ID is required`.

**Workspace safety (the point of the `commands.import-local-aws-workspace.test.ts` suite):** an explicit `--workspace-id` that disagrees with the active session/env workspace throws
`--workspace-id must match the active Receipt workspace (<activeWorkspaceId>)` (`:1903-1911`). The doc comment at `:1862-1866` states the rule: “Explicit workspace overrides are accepted only when they agree with the active saved session/environment so a local import cannot silently cross workspaces.”

Three paths:
1. `--local-profile-reference` — reads `aws sts get-caller-identity` for `--aws-profile` (default `$AWS_PROFILE` or `default`) and stores a **profile reference**, no credentials. Output:
   `{ ok:true, provider:"aws", source:"local-aws-profile", profile, accountId, principalArn, receiptConnectionId }`.
2. Temporary credentials (`SessionToken` present) — stores an encrypted credential-process bundle. Output:
   `{ ok:true, provider:"aws", source:"aws-credential-process", accountId, principalArn, expiresAt, receiptConnectionId }`.
3. Long-lived credentials — imports through Nango; requires `--nango-url` or `$RECEIPT_INTEGRATIONS_URL` (`--nango-url or RECEIPT_INTEGRATIONS_URL is required`) and `--nango-api-key` or `$RECEIPT_INTEGRATIONS_SECRET_KEY` (`--nango-api-key or RECEIPT_INTEGRATIONS_SECRET_KEY is required`). Output:
   `{ ok:true, provider:"aws", nangoConnectionId, nangoIntegrationId, accountId, principalArn, receiptConnectionId }`.

#### `receipt connect import-local-github` **[repo-only]** — `commandConnectImportLocalGithub` (`commands.ts:1762-1849`)

`--host <host>` default `github.com`; anything else → `receipt connect import-local-github currently supports github.com only.`
Reads the token via `git credential fill`; failure → `git credential fill failed for <host>: <stderr>`; no token → `No GitHub token was returned by git credential fill for <host>.`
Validates with `GET https://api.github.com/user`; failure → `Local GitHub token validation failed with HTTP <status>: <message>`.
Optional `--repo owner/repo` (alias `--repository`) validates `GET /repos/<repo>`; failures →
`Local GitHub token cannot access <repo>: HTTP <status> <message>` and
`Local GitHub token can read <repo> but does not have push permission.`
Then `POST <gw>/connect/credential/github/import` with `{ token, login, scopes, name }`, and prints
`{ ok:true, provider:"github", source:"git-credential", login, scopes, repository, receiptConnectionId, name, status }`.

#### `receipt proxy` — removed

`commandProxy` (`commands.ts:2389-2398`) always throws:
`receipt proxy has been removed. Provider access now uses real CLIs configured from Nango-backed Receipt Connect credentials.`

---

### 8.20 `receipt workspace …` **[shared]**

`runReceiptWorkspaceCommand` (`services/receipt-workspace-cli.ts:181-387`). Its own tiny parser understands only `--json` and `--target <t>`; everything else non-`--` is a positional (`:191-203`).

Requires a saved session: `receipt workspace: not signed in; run 'receipt login' first` (`:207-211`).
All requests hit `<gatewayUrl>/connect/workspaces…` with a 35 s timeout (`:78-105`).

| subcommand | syntax | behaviour |
|---|---|---|
| `current` (default) / `identity` | `receipt workspace current [--json]` | `GET /connect/workspaces`; reconciles the saved session with the server’s `currentWorkspaceId` |
| `list` | `receipt workspace list [--json]` | same fetch, lists all |
| `create` | `receipt workspace create <name…> [--json]` | positional words joined with spaces; empty → `receipt workspace create requires a name`; `POST /connect/workspaces` |
| `use` | `receipt workspace use <id\|slug\|name> [--json]` | `POST /connect/workspaces/<id>/token`; **the only operation that replaces the JWT** (`:180`) |
| `rename` | `receipt workspace rename [<workspace>] <name…> [--json]` | with ≥2 positionals the first selects the workspace; empty name → `receipt workspace rename requires a name`; `PATCH /connect/workspaces/<id>` |
| `delete` | `receipt workspace delete <id\|slug\|name> [--json]` | `DELETE /connect/workspaces/<id>`; refuses the current one |
| anything else | | `receipt workspace supports list, current, create, rename, use, and delete` |

Selector resolution (`:154-170`): case-insensitive match on `id`, `slug`, or `name`; ambiguity → `workspace '<sel>' is ambiguous; use its id`; no match → `workspace '<sel>' was not found`. Deleting the current workspace → `cannot delete the current workspace; switch to another workspace first`. Cross-org persistence is refused: `refusing to persist a workspace from another organization` (`:144-148`).

Self-healing behaviour worth documenting: on `current`/`list`, if the saved `workspaceId` no longer exists server-side the CLI mints a fresh token for the server’s current workspace and rewrites the session; if it merely drifted (different id/name) it rewrites the session without a new token (`:229-265`).

Text output (`:370-385`):
```
<name> (<id>) [Default]           # single workspace; the [Default] suffix only for isDefault
* <name> (<id>) [Default]         # list: leading "*" marks the current workspace, otherwise a space
Deleted workspace <id>
```
JSON output shapes: `{ ok:true, workspace }`, `{ ok:true, currentWorkspaceId, workspaces }`, `{ ok:true, workspace, sessionFile, targetSessionFile }` (for `use`), `{ ok:true, deleted:true, workspaceId }`.

A workspace record is `{ id, organizationId, name, slug, isDefault, role, createdAt, updatedAt }` and every field is required — a missing one throws `Receipt workspace response is missing <key>` / `Receipt workspace response has invalid <key>` (`:35-76`).

---

### 8.21 `receipt tools …` **[shared]**

`runReceiptToolsCommand` (`services/receipt-mcp-cli.ts:472-575`). Subcommand defaults to `list`.

Identity (`:79-127`): saved session for `--target`, **or**, because `allowEnvironment = true` for `tools`, an ambient identity built from `$RECEIPT_CONNECT_GATEWAY_URL`/`$RECEIPT_CONNECT_PUBLIC_GATEWAY_URL` + `$RECEIPT_CONNECT_TOKEN` + `$RECEIPT_CONNECT_ORGANIZATION_ID`. Neither → `receipt mcp: not signed in; run 'receipt login' first`.
`--server-url <url>` overrides the gateway. The MCP endpoint is `<gateway>/connect/mcp` (`:13, :126`).

| subcommand | syntax | route |
|---|---|---|
| `list` | `receipt tools list [<connection>] [--connection <p:n>]` | with a connection: `POST <gw>/connect/tools`; without: JSON-RPC `tools/list` on `<gw>/connect/mcp` |
| `describe` | `receipt tools describe <tool> [--connection <p:n>]` | lists then filters by `name`; missing name → `receipt tools describe requires a tool name`; not found → `Receipt tool '<name>' was not found` |
| `call` | `receipt tools call <tool> [--connection <p:n>] --json '<object>'` | with a connection: `POST <gw>/connect/call`; without: JSON-RPC `tools/call` |
| other | | `receipt tools supports list, describe, and call` |

Always JSON. The payload is `{ ok: true, ...result, workspace: <workspace identity> }` (`:554-562`), where `workspace` is either `{ kind:"workspace", id, name, organizationId }` or `{ kind:"organization-default", id, organizationId }` (`:200-212`).
`--output` / `--output-file <path>` writes the payload atomically at `0600` and prints `{ ok:true, outputFile, bytes }`.

---

### 8.22 `receipt mcp …` **[shared]**

`runReceiptMcpCommand` (`services/receipt-mcp-cli.ts:631-778`). Subcommand defaults to `status`; client defaults to `codex` (positional `args[1]` or `--client`); server name defaults to `receipt` (`--name`).

| subcommand | syntax | notes |
|---|---|---|
| `config` | `receipt mcp config [codex\|generic] [--output\|--output-file <path>] [--json] [--receipt-bin <path>] [--name <n>]` | `codex` emits TOML `[mcp_servers."<name>"] command=… args=[…]`; anything else emits the generic JSON config. `--json` prints `{ ok, client, config, content, output }`. |
| `install` | `receipt mcp install codex [--dry-run] [--client-bin <bin>] [--client-config <path>]` | runs `<client-bin> mcp add <name> -- <command> <args…>` |
| `status` | `receipt mcp status codex` | runs `<client-bin> mcp get <name> --json`; prints `{ ok, client, name, installed, configPath, config, workspace, remote }` |
| `remove` | `receipt mcp remove codex` | runs `<client-bin> mcp remove <name>` |
| `serve` | `receipt mcp serve` | stdio↔Streamable-HTTP bridge; this is what installed clients launch |
| other | | `receipt mcp supports config, install, status, remove, and serve` |

Details and error strings:
- Non-`codex` client for install/status/remove → `receipt mcp install/status/remove currently supports codex; use 'receipt mcp config --client generic' for other clients` (`:688-692`).
- Codex config path is `$CODEX_HOME/config.toml` or `~/.codex/config.toml` (`:244-250`). Passing a different `--client-config` throws `Codex does not accept an arbitrary config path; expected <path>. Set CODEX_HOME before running Receipt if Codex uses another home.` (`:700-704`).
- The existing config is backed up to `<path>.receipt-backup-<ISO with : and . replaced by ->` before mutation, and **restored on any failure** (`:269-288, 748-769`).
- Refuses to touch a symlink or non-regular file: `refusing to modify non-regular client config: <path>` (`:252-267`).
- `install` when already installed → `Codex MCP server '<name>' is already installed; remove it first`.
- `remove` when not installed → `{ ok:true, client, name, removed:false, installed:false, configPath }`.
- Post-condition failures → `codex did not report the installed Receipt MCP server; the prior config was restored` / `codex still reports the Receipt MCP server after removal; the prior config was restored` / `codex did not create its expected config: <path>`.
- Token-leak guard on every generated/observed config: `refusing to install an MCP client config containing the Receipt session token` and `refusing to install an MCP client config containing credential material` (`:312-327`).
- `--dry-run` (install/remove only) prints `{ ok:true, dryRun:true, action, client, name, configPath, command, launcher, workspace, remote }` and changes nothing.
- Launcher resolution (`:159-182`): `--receipt-bin <path>` → `[<abs path>, "mcp", "serve"]`; else, when running under Bun, `[<bun path>, <abs entrypoint>, "mcp", "serve"]`; else `[<execPath>, "mcp", "serve"]`. Unresolvable entrypoint → `receipt mcp could not resolve the Receipt CLI entrypoint`.
- `mcp serve` allows the ambient-env identity (`:645`); the other subcommands require the saved session file.
- Bridge errors surface as JSON-RPC `{ code: -32603, message }`; JSON-RPC **notifications** (requests with no `id`) never get a response even on failure (`:611-627`).

---

### 8.23 `receipt import …` and `receipt observe …` **[shared]**

`commandImport` (`commands.ts:5199-5223`), `commandObserve` (`commands.ts:5225-5268`). Sources: `clauden` and `claude-code`.
Missing source → `import source is required. Supported sources: clauden, claude-code` (resp. `observe source is required. …`). Unknown → `Unknown import source '<x>'. Supported sources: clauden, claude-code`.

`observe` is `import --follow` with `forceFollow: true` (`commands.ts:5258`), plus the background-service subcommands `install|start|stop|status|uninstall` (`cli/clauden-service.ts:58-60`). `observe claude-code install` is rejected: `observe claude-code supports live file tailing only; use observe clauden install for proxy service install` (`commands.ts:5235`).

Flags read by `runClaudenImport` (`cli/clauden-import.ts:1672-1800`):
- positional path, or `--event-log <path>`, or `--path <path>` (`:1429`). Default `~/.claudeN/events.ndjson`, or `~/.claudeN/clauden.log` when the resolved companion binary is named `clauden` (`:190-195, 1412-1423`). For `claude-code` the default source dir is `~/.claude/projects` (`:196`).
- `--mode metadata|full` (default `metadata`); `--stream <stream>` (default `imports/<source>/<project>/<sourceId>`); `--project <name>`; `--source-id <id>`; `--import-id <id>` (default `clauden_<base36 now>_<8 hex>`); `--max-lines <n>`; `--follow`; `--poll-ms <n>` (default 1 000, floor 100); `--launch`/`--launch-proxy`; `--proxy-bin <path>`/`--clauden-bin <path>` or `$RECEIPT_CLAUDE_PROXY_BIN`.
- `--launch` without `--follow` → `--launch requires --follow or receipt observe clauden`.

**Storage selection — important and undocumented (`clauden-import.ts:1172-1212, 1394-1408, 1719-1736`):**
1. If a CLI session exists (any target, or `--target <t>`), imports go to the **hosted cloud store** (`storage: "cloud"`).
2. Otherwise, if `$ZERO_UPSTREAM_DB` is set, imports go to **Postgres** (`storage: "postgres"`).
3. Otherwise they go to a **local file-backed store** (`storage: "local"`).
Cloud upload is disabled by any of `--local-only`, `--localOnly`, `--no-cloud`, `--noCloud`, `--no-upload`, `--noUpload`.

Result (always JSON, honours `--output-file`) — `ClaudenImportResult` (`clauden-import.ts:106-120`):
```json
{ "ok": true, "source": "clauden|claude-code", "importId": "…", "stream": "…",
  "sourcePath": "…", "mode": "metadata|full", "follow": false,
  "storage": "cloud|local|postgres",
  "cloud": { "gatewayUrl": "…", "organizationId": "…" },
  "counts": { "lines": 0, "captured": 0, "normalized": 0, "rejected": 0, "duplicateReceipts": 0 } }
```

Background observer (`cli/clauden-service.ts`):
- Platforms: macOS (launchd) and Linux (systemd user). Anything else → `Background Claude observation is currently supported on macOS and Linux.` (`:67-69`).
- Service label / name: **`run.beetle.clauden-observer`** (launchd) and **`beetle-clauden-observer`** (systemd) (`:46-47`) — a legacy internal codename that is nonetheless user-visible.
- Files: `~/Library/LaunchAgents/run.beetle.clauden-observer.plist` or `~/.config/systemd/user/beetle-clauden-observer.service` (`:130-133`).
- Logs: `<dataDir>/logs/clauden-observer.out.log` and `.err.log` (`:170-172, 189-190`).
- Generated command: `<receiptBin> observe clauden --event-log <path> --mode <metadata|full> --launch` plus optional `--proxy-bin`, `--poll-ms`, `--stream` (`:113-128`). The unit sets `RECEIPT_DATA_DIR=<dataDir>` and, on systemd, `Restart=always`, `RestartSec=5`; launchd sets `RunAtLoad` and `KeepAlive`.
- `--mode` other than `metadata`/`full` → `--mode must be metadata or full` (`:88-92`).
- Result: `{ ok:true, action, platform, label, serviceFile, active?, dataDir, eventLog, mode }` (`:34-44`).

---

## 9. Usage texts (exact, for copy into docs)

`printUsage()` — `cli/shared.ts:14-101`. Sections in order: header `receipt <command> [args]`, then **User commands**, **Developer commands**, a “Use: receipt connect --help” pointer, **Worker/debug commands** (prefixed with three agent-facing guidance bullets), and **Legacy agent-framework commands**.

Two lines are generated at runtime from the connector catalog (§11):
- `receipt connect ${connectorPipeList} [prod|dev|local]` where `connectorPipeList` is all **62** connector ids joined with `|` (`shared.ts:15-17, 39`). This makes one usage line several hundred characters long — worth rendering as a list in docs rather than verbatim.
- `printConnectUsage()` (`shared.ts:103-178`) enumerates `receipt connect <id>` once per connector, twice (in *Usage* and in *Common examples*).

Verbatim guidance block from the usage text (`shared.ts:62-65`):
```
Worker/debug commands:
  use --json for machine-readable reads
  use --output-file <path> on large read commands
  keep mutations explicit: receipt abort, receipt factory note|react|promote|cancel|cleanup|archive|steer|follow-up|abort-job
```

`printConnectUsage()` also documents the distribution channel (`shared.ts:176-178`):
```
Distribution:
  curl -fsSL https://raw.githubusercontent.com/kentronai/receipt-cli/main/install.sh | bash
  See docs/receipt-cli.md for the full public release process.
```

---

## 10. The device-login flow (`services/receipt-connect-cli-login.ts`, 182 lines)

1. `POST <authUrl>/api/receipt-connect/cli-login` with `{ action: "start_device" }`, 15 s timeout (`:47-72`). Failure → `receipt connect device login request failed for <endpoint>: <message>` or `receipt connect device login failed to start: <error|http_<status>>`.
2. Prints, verbatim (`:105-112`):
   ```
   Step 1 of 2: sign in to Receipt
     Open: <verificationUriComplete>
     Code: <userCode>
     Approve the CLI from the workspace that should own these connections.
   ```
3. Opens the browser unless `openBrowser === false` or `RECEIPT_CONNECT_OPEN_BROWSER=0` (`:18-19, 113`).
4. Polls `{ action: "poll_device", deviceCode }` on the server-supplied `interval` (default 2 s), overall timeout **10 minutes** (`:15, 115-124`).
   - HTTP 428 or `error: "authorization_pending"` → keep polling.
   - `error: "expired_token"` → `receipt connect device login expired`.
   - other errors → `receipt connect device login failed: <error|http_<status>>`.
   - success with no token → `receipt connect device login returned an empty token`.
   - success with no organization → `receipt connect login did not return a workspace; select a Receipt workspace and try again`.
5. Prints `Receipt sign-in approved.` and returns `{ token, userId?, userEmail?, organizationId, workspaceId?, workspaceName? }`.

### Endpoint resolution (`services/receipt-connect-command-proxy.ts:492-586`)

`normalizeReceiptConnectTargetName`: `prod|production` → `prod`; `dev|development|staging` → `dev`; `local|localhost` → `local`; anything else → undefined.
A target that is neither a known name nor an `http(s)` URL throws `receipt connect target must be prod, dev, local, or an http(s) URL` (`:510-512`).
An explicit `--server-url` or a URL positional yields `{ name: "custom", serverUrl, authUrl: authUrl ?? serverUrl }`.

**local** (`:524-539`): serverUrl = `$RECEIPT_CONNECT_LOCAL_SERVER_URL` → `$RECEIPT_CONNECT_GATEWAY_URL` → `$RECEIPT_PROXY_SERVER_URL` → `http://127.0.0.1:${RECEIPT_PORT|PORT|8787}`; authUrl = `--auth-url` → `$RECEIPT_CONNECT_LOCAL_AUTH_URL` → `$RECEIPT_AUTH_URL` → `$BETTER_AUTH_URL` → `$VITE_BETTER_AUTH_URL` → `http://127.0.0.1:${WEB_PORT|3000}`.

**prod** (`:541-585`): serverUrl from `$RECEIPT_CONNECT_PUBLIC_GATEWAY_URL`, `$RECEIPT_CONNECT_WORKER_GATEWAY_URL`, `$RECEIPT_CONNECT_PUBLIC_URL`, `$RECEIPT_CONNECT_PROD_GATEWAY_URL`, `$RECEIPT_CONNECT_PROD_SERVER_URL`, `$RECEIPT_CONNECT_PROD_URL`, `$RECEIPT_CONNECT_URL`, `$RECEIPT_APP_URL`, else `$RECEIPT_CONNECT_PUBLIC_GATEWAY_URL`/`$RECEIPT_PUBLIC_BASE_URL` captured at module load (`:51-54`), else `.sst/outputs.json`. Nothing found → `receipt connect production URL is not configured yet. Set RECEIPT_CONNECT_PUBLIC_GATEWAY_URL, RECEIPT_CONNECT_PROD_GATEWAY_URL, RECEIPT_CONNECT_PROD_URL, or RECEIPT_CONNECT_URL.`

**dev**: same shape with the `DEV` prefix; nothing found → `receipt connect dev URL is not configured. Set RECEIPT_CONNECT_DEV_GATEWAY_URL or RECEIPT_CONNECT_DEV_URL.`

**`https://app.kentron.ai` is nowhere hard-coded in the CLI’s endpoint resolution** — see Open questions.

---

## 11. The connector catalog (62 connectors)

Built from JSON manifests at build/load time: `src/integrations/nango/catalog.json` lists `providerSlugs`, each loading `src/integrations/nango/slugs/<slug>/provider.json` (`src/integrations/nango/catalog.ts:504-514`), then mapped to connector definitions (`services/receipt-connect-integration-registry.ts:77-95`). Each manifest must declare `schemaVersion: 1`, a `providerSlug` equal to its directory name, and an `aliases` array that includes its own `receiptId` (`catalog.ts:470-481`).

Ids, labels and the real CLI each one shims (`id | label | command`):

```
aws | AWS | aws                              gcp | Google Cloud | gcloud
google-ads | Google Ads | nango              google-analytics | Google Analytics | nango
youtube | YouTube Analytics | nango          google-docs | Google Docs | nango
google-mail | Gmail | nango                  google-calendar | Google Calendar | nango
google-calendar-mcp | Google Calendar (MCP) | nango
google-sheet | Google Sheets | nango         google-drive | Google Drive | nango
google-slides | Google Slides | nango        google-chat | Google Chat | nango
google-tasks | Google Tasks | nango          jira-oauth | Jira OAuth | jira
jira-api | Jira API Token | jira             notion | Notion | nango
lagrowthmachine | La Growth Machine | nango  linkedin | LinkedIn | nango
gong-oauth | Gong (Oauth) | nango            stripe-app | Stripe App | nango
github | GitHub | nango                      github-app-oauth | GitHub (App OAuth) | nango
github-pat | GitHub (Personal Access Token) | nango
hubspot | HubSpot | nango                    airtable | Airtable | nango
meta-marketing-api | Meta Marketing API | nango
apollo | Apollo | nango                      attio | Attio | nango
zendesk | Zendesk | nango                    gitlab | GitLab | nango
slack | Slack | nango                        linear | Linear | nango
datadog | Datadog | nango                    sentry | Sentry | nango
cloudflare | Cloudflare | nango              vercel | Vercel | nango
terraform | Terraform Cloud | nango          incident-io | Incident.io | nango
azure-devops | Azure DevOps | nango          confluence-oauth | Confluence OAuth | nango
confluence-api | Confluence API Token | nango
anthropic | Anthropic | nango                openai | OpenAI | nango
zoom | Zoom | nango                          zoominfo | ZoomInfo | nango
zoho | Zoho | nango                          zoho-crm | Zoho CRM | nango
zoho-books | Zoho Books | nango              zoho-desk | Zoho Desk | nango
zoho-calendar | Zoho Calendar | nango        zoho-inventory | Zoho Inventory | nango
zoho-mail | Zoho Mail | nango                zoho-recruit | Zoho Recruit | nango
zoho-people | Zoho People | nango            zoho-invoice | Zoho Invoice | nango
instagram | Instagram Insights | nango       tiktok-ads | TikTok Ads Analytics | nango
tiktok-accounts | TikTok Accounts | nango    tiktok-personal | TikTok Personal | nango
outlook | Outlook | nango                    azure-blob-storage | Azure Blob Storage | nango
```

`receipt connect <alias>` also accepts each connector’s declared aliases, plus the bare `productId` for the connector marked as its product’s default auth mode (`registry.ts:101-111`) — e.g. `confluence` resolves to whichever of `confluence-oauth`/`confluence-api` sets `authMode.default`.

`receipt connect nango [<connector>] [<target>]` is an alternate spelling; with no connector it defaults to `jira-oauth` (`commands.ts:2305-2325`).

---

## 12. Environment variables read by the CLI (consolidated)

### Wrapper / runtime
`RECEIPT_BUN_BIN`, `BUN_BIN`, `BUN_INSTALL`, `HOME`, `RECEIPT_REPO_ROOT`, `RECEIPT_REPO_KEY`, `RECEIPT_CLI_NO_FORCE_EXIT`.

### Env loading
`RECEIPT_CLI_LOAD_LOCAL_ENV`, `START_ALL_ENV_FILE`, `START_ALL_ENV_FILES`, `RECEIPT_LOCAL_ENV_FILE`, `VALIDATE_STACK_ENV_FILE`, `VALIDATE_STACK_ENV_FILES`.

### Session / config
`RECEIPT_CLI_CONFIG_DIR`, `RECEIPT_CLI_SESSION_FILE`, `RECEIPT_DATA_DIR`, `DATA_DIR`, `RECEIPT_CODEX_BIN`, `RECEIPT_FACTORY_REPO_SLOT_CONCURRENCY`.

### Receipt Connect
`RECEIPT_CONNECT_TOKEN`, `RECEIPT_CONNECT_ORGANIZATION_ID`, `RECEIPT_CONNECT_USER_ID`, `RECEIPT_CONNECT_WORKSPACE_ID`, `RECEIPT_CONNECT_WORKSPACE_NAME`, `RECEIPT_CONNECT_GATEWAY_URL`, `RECEIPT_CONNECT_PUBLIC_GATEWAY_URL`, `RECEIPT_CONNECT_WORKER_GATEWAY_URL`, `RECEIPT_CONNECT_PUBLIC_URL`, `RECEIPT_CONNECT_{PROD,DEV}_{GATEWAY_URL,SERVER_URL,AUTH_URL,URL}`, `RECEIPT_CONNECT_LOCAL_SERVER_URL`, `RECEIPT_CONNECT_LOCAL_AUTH_URL`, `RECEIPT_CONNECT_URL`, `RECEIPT_CONNECT_DEV_URL`, `RECEIPT_APP_URL`, `RECEIPT_DEV_APP_URL`, `RECEIPT_PROXY_SERVER_URL`, `RECEIPT_PUBLIC_BASE_URL`, `RECEIPT_AUTH_URL`, `BETTER_AUTH_URL`, `VITE_BETTER_AUTH_URL`, `RECEIPT_PORT`, `PORT`, `WEB_PORT`, `RECEIPT_CONNECT_OPEN_BROWSER`.

### Tokens / secrets
`RECEIPT_CONNECT_JWT_SECRET`, `BETTER_AUTH_SECRET`, `RECEIPT_DEBUG_JWT_SECRET`, `RECEIPT_INTEGRATIONS_WEBHOOK_SECRET`, `RECEIPT_INTEGRATIONS_URL`, `RECEIPT_INTEGRATIONS_SECRET_KEY`.

### Debug
`RECEIPT_PROD_DEBUG_TOKEN`, `RECEIPT_DEBUG_TOKEN`, `RECEIPT_FACTORY_SECRETS_FILE`, `RECEIPT_SST_BIN`, `RECEIPT_DISABLE_SST_SECRET_LOOKUP`, `RECEIPT_PROD_WEB_URL`, `RECEIPT_PROD_DEBUG_WEB_URL`, `RECEIPT_LOCAL_DEBUG_URL`, `RECEIPT_RUNTIME_URL`, `AWS_REGION`, `AWS_DEFAULT_REGION`, `AWS_PROFILE`, `AWS_PAGER`.

### Storage / runtime
`ZERO_UPSTREAM_DB` (**the Postgres connection string**; `config/runtime-env.ts:1`), `RECEIPT_POSTGRES_SCHEMA`, `RECEIPT_POSTGRES_POOL_MAX`, `RECEIPT_POSTGRES_APPLICATION_NAME`, `RESONATE_URL` (default `http://127.0.0.1:8001`, `adapters/resonate-config.ts:47`), `RESONATE_GROUP_{API,DRIVER,CHAT,CONTROL,CODEX}`, `RECEIPT_FACTORY_EXECUTION_PATH`, `RECEIPT_FACTORY_COMPUTER_PROVIDER`, `RECEIPT_CLAUDE_PROXY_BIN`, `CODEX_HOME`.

Missing Postgres URL error: `Receipt Postgres storage requires ZERO_UPSTREAM_DB.` (`config/runtime-env.ts:25`).

---

## 13. Resolution rules

**`<run-id|stream>`** (`cli/runtime.ts:92-102`): if the value contains `/` it is used as a stream verbatim; otherwise the store’s `listStreams()` is searched for an exact name, then for any stream ending in `/runs/<value>`. Failure → `Unable to resolve run/stream '<value>'`.

**`ROOT`** (`cli/runtime.ts:21`) = `process.cwd()`. The wrapper `cd`s to the repo root first, so in normal use `ROOT` is the repo root.

**`DATA_DIR`** (`cli/runtime.ts:22-23`) = `resolveFactoryRuntimeConfig(ROOT).dataDir`, per §5.4. This is a *different* precedence from the one `receipt doctor` computes internally (`doctor.ts:323-326`), though they agree in practice.

---

## 14. Prerequisites, by command group

| group | needs |
|---|---|
| `login`, `logout`, `whoami`, `setup`, `connect`, `workspace`, `tools`, `mcp` | network + a reachable Receipt gateway. **No Postgres.** |
| `doctor` | nothing beyond a filesystem; probes `bun`, `git`, `gh`, `aws`, `codex` |
| `new` | write access to `<ROOT>/src/agents/` |
| `dev` | Bun + `scripts/start-resonate-dev.mjs` |
| `run` | a `defineAgent` spec at `<ROOT>/src/agents/<id>.agent.ts`, Postgres, Resonate |
| `trace`, `replay`, `inspect`, `fork`, `dst`, `simulate` | Postgres (`ZERO_UPSTREAM_DB`) |
| `jobs`, `abort` | Postgres **and** a reachable Resonate server (`getJobBackend`, `cli/runtime.ts:36-43`) |
| `memory`, `memory prefs` | Postgres + an actor identity (`--user-id`/`--organization-id` or a session) |
| `sessions` | Postgres |
| `eval` | Postgres; `--organization-id` for the semantic oracle |
| `debug local` | Postgres + Resonate (it degrades to findings if they fail) |
| `debug prod`/`probe`/`objective`/`job-abort` | a prod web URL and, except for the unauthenticated part of `debug prod`, a `ReceiptDebugToken`; `curl` on `PATH`; `aws` CLI only with `--aws-checks` |
| `debug token`, `connect token` | the corresponding JWT signing secret |
| `import`/`observe` | a session (cloud), or Postgres, or neither (local file store) |

Everything except the connect/session family loads `cli/runtime.ts` at import time, so a broken `.receipt/config.json` or a missing git root fails **every** such command before the handler runs.

---

## 15. Discrepancies: repo markdown vs. code

### 15.1 `docs/api/cli.md`

Claims in the doc that the code contradicts:

1. **`docs/api/cli.md:3`** — “Binary entrypoint: `receipt` (runs `src/cli.ts` through Bun)”. The wrapper runs `packages/receipt-app/src/cli.ts`; `$ROOT/src/cli.ts` is only a fallback (`.receipt/bin/receipt`). Line 8’s `bun src/cli.ts <command>` will not work from the repo root.
2. **`docs/api/cli.md:20`** — “Companion skill: `skills/receipt-cli-operator/SKILL.md`.” **That directory does not exist** (`skills/` contains 24 other skills).
3. **`docs/api/cli.md:53-55`** — doctor “missing `OPENAI_API_KEY` is reported as a warning”. Doctor has **no** OpenAI check at all; the text output prints the fixed line `provider auth: organization BYOK required` (`doctor.ts:445`).
4. **`docs/api/cli.md:62`** — doctor JSON listed as `{ ok, cwd, requestedRepoRoot, dataDir, configPath, configPresent, openAiApiKey, binaries, repo, auth, blockingIssues, warnings }`. `openAiApiKey` **does not exist**; the actual report also has an `execution: { path, computerProvider }` key that the doc omits (`doctor.ts:38-71`).
5. **`docs/api/cli.md:30-37`** — `receipt setup` “Uses local file-backed Receipt storage for Claude imports, independent of `ZERO_UPSTREAM_DB`.” False for the in-repo binary: a saved session sends imports to the **cloud** store, and otherwise `ZERO_UPSTREAM_DB` selects Postgres (`clauden-import.ts:1183-1194`). Only `--local-only`/`--no-cloud`/`--no-upload` forces local.
6. **`docs/api/cli.md:38-42`** — `receipt setup` flags list is incomplete: it omits `--skip-login`, `--local-only`, `--skip-claude`, `--target`, `--server-url`, `--auth-url`, `--fresh-login`, `--no-open`.
7. **`docs/api/cli.md:226-234`** — `receipt run` documents a **queued mode** returning `{ ok, mode: "queued", jobId, … }`. That path was removed; a non-`defineAgent` agent now throws (`commands.ts:292-295`). The doc also omits that a non-completed run sets exit code `2`.
8. **`docs/api/cli.md:69-135`** — `receipt debug` documents only `local` and `prod`. Missing entirely: `token`/`jwt`/`mint`, `probe`/`prod-probe`, `objective`/`prod-objective`, `job-abort`/`prod-job-abort`, and the `snapshot` alias. Also missing flags for `prod`: `--receipt-replay`, `--receipt-replay-limit`, `--log-minutes`, `--status`, `--require-debug-token`, and the `--aws`/`--control-plane` aliases.
9. **`docs/api/cli.md:263-282`** — `receipt dst` does not mention the `simulate` alias, and `--strict` “exits non-zero” understates it: the message on stderr is exactly `error: DST audit found receipt issues`.
10. **`docs/api/cli.md:305-315`** — `receipt jobs` documents only `list`. Missing: `enqueue`, `wait`, `steer`, `follow-up`, `abort`.
11. **`docs/api/cli.md:327-388`** — `receipt memory` omits the mandatory `--user-id`/`--organization-id` actor audit and the whole `memory prefs` subcommand tree.
12. **`docs/api/cli.md:18`** — lists `--output-file` support but claims one uniform behaviour; there are three different envelopes (§7).
13. **`docs/api/cli.md:430-431`** — “Data directory: uses `DATA_DIR` env var or defaults to `<cwd>/.receipt/data`.” Actual precedence is `RECEIPT_DATA_DIR` → `DATA_DIR` → `.receipt/config.json` `dataDir` (resolved against the config’s owning directory) → `<repoRoot>/.receipt/data` (`factory-cli/config.ts:287-290`).
14. **Entire command groups absent from the doc**: `login`, `logout`, `whoami`, `connect` (all subcommands), `workspace`, `tools`, `mcp`, `sessions`, `eval`, `proxy` (removed), and `simulate`.
15. **`docs/api/cli.md:433-435`** — “Exit Behavior: Success 0, Errors print `error: <message>` and exit non-zero.” Correct in shape, but incomplete: `receipt doctor` and `receipt debug *` return `0` even when they report `ok: false`, and `receipt run` uses exit code `2`.

### 15.2 `architecture.md` §10 “CLI contract”

`architecture.md:193-205` lists exactly nine commands: `new`, `dev`, `run`, `trace`, `replay`, `fork`, `inspect`, `jobs`, `abort`. The dispatcher has **27 top-level cases**. Everything in §8 other than those nine is missing. It is also arguably backwards as a *contract*: those nine are the legacy agent-framework surface, which `printUsage` itself labels “Legacy agent-framework commands” (`shared.ts:97-100`).

Also from architecture.md:
- **`architecture.md:164`** — “Default store: SQLite-backed receipt tables.” The store is **Postgres** (`adapters/postgres.ts`, `config/runtime-env.ts:1` requiring `ZERO_UPSTREAM_DB`). No SQLite path exists in the CLI.
- **`architecture.md:108-112`** — lanes listed as `steer`, `collect`, `follow_up`. The CLI and the queue also accept **`chat`** (`commands.ts:536-541`; `factory-cli/config.ts:181`).

### 15.3 Internal inconsistencies inside the CLI itself

- `printUsage` advertises `receipt run … --max-iterations <n> --workspace <path>` (`shared.ts:100`); `commandRun` reads neither.
- `printUsage` advertises `receipt import clauden … [--import-id]`? — no; `docs/api/cli.md:156` does, and `--import-id` **is** read (`clauden-import.ts:1715`), but `printUsage` (`shared.ts:81`) omits it.
- `printConnectUsage` shows `receipt connect check [local|dev|prod]` and `receipt connect token` (`shared.ts:125, 128`), but `printUsage` does not list either.
- `printUsage:67-68` shows `receipt trace/replay <run-id|stream> [--json]` for `replay`; `commandReplay` ignores `--json` (always JSON).
- The `merge` template of `receipt new` generates an action emitting a receipt it does not declare (§8.6).

---

## 16. Internal-only material found (must NOT be published)

1. **`--aws-profile <your-aws-profile>` example** in `printConnectUsage` (`cli/shared.ts:166`): `receipt connect import-local-aws --local-profile-reference --aws-profile <your-aws-profile> --organization-id <org> --user-id <user>`. `beetle` is an internal AWS profile name; replace with a neutral placeholder in docs.
2. **Prod-debug token discovery chain**: `deploy/factory.secrets.env`, the secret key name `ReceiptDebugToken`, `$RECEIPT_FACTORY_SECRETS_FILE`, and `sst secret list --stage factory` (`commands.ts:3101-3156`). This is an operator flow tied to Kentron’s deployment, not a user or self-hosting flow.
3. **The remediation string** `Run \`bun run factory:secrets:load\` and redeploy, or pass --debug-token for this invocation.` (`commands.ts:4936`).
4. **SST stage/infra identifiers**: default stage `factory`, log-group prefix `/sst/cluster/receipt-factory-<stage>`, and the SST output keys `runtime`, `gateway`, `zero`, `resonate`, `gatewayHttps` (`commands.ts:4703-4708, 4812, 3258-3259`).
5. **`receipt debug prod --aws-checks`**: runs `sts get-caller-identity`, `cloudformation list-stacks`, `ecs list-clusters`, `elbv2 describe-load-balancers`, `rds describe-db-instances`, `logs describe-log-groups/filter-log-events` against whatever AWS account the operator is logged into (`commands.ts:4760-4860`). Any published version must strip the account-shaped detail.
6. **`receipt debug token`** mints an HS256 JWT from `RECEIPT_DEBUG_JWT_SECRET` with `aud: "receipt-debug"` and scopes `debug:read|write|objective`. This is an internal operator credential; documenting it publicly invites misuse.
7. **`receipt connect check`** requires `RECEIPT_INTEGRATIONS_WEBHOOK_SECRET` and forges a signed Nango webhook (`commands.ts:1365-1394`). Internal integration-plumbing verification.
8. **`https://beetle.run`** appears as the prod host in tests (`cli/commands.prod-objective.test.ts:36, 39`) and repeatedly in `docs/agent-fix-checklist.md`. A legacy internal domain — do not publish alongside `app.kentron.ai`.
9. **Legacy `beetle` codename in user-visible artifacts**: launchd label `run.beetle.clauden-observer`, systemd unit `beetle-clauden-observer.service`, systemd `Description=Beetle Claude observer` (`cli/clauden-service.ts:46-47, 180`). These *are* real user-visible paths, so docs cannot rename them — but flag the naming to the team before publishing, and never explain the codename.
10. **`.receipt/tenants/`** exists in the working tree next to `.receipt/data`; nothing in the CLI reads it. Do not document it without checking what writes it.

---

## 17. Open questions for a human

1. **What is the default hosted gateway for the in-repo CLI?** `DEFAULT_RECEIPT_CONNECT_PROD_URL` is `$RECEIPT_CONNECT_PUBLIC_GATEWAY_URL || $RECEIPT_PUBLIC_BASE_URL || ""` (`receipt-connect-command-proxy.ts:51-54`), so with no env and no `.sst/outputs.json`, `receipt login` throws “receipt connect production URL is not configured yet”. `https://app.kentron.ai` is only hard-coded in deploy scripts. Does the published binary bake a default in at build time, and if so where? Docs need a definitive “what happens when you run `receipt login` on a fresh machine”.
2. **Which of the debug subcommands should appear on a public docs site at all?** `debug local` and `debug prod` (without `--aws-checks`) look publishable; `debug token`, `debug probe`, `debug objective`, `debug job-abort`, `connect check` look internal. Needs a product call.
3. **Is `receipt new`’s `merge` template intended to be broken?** It declares `candidate.generated` / `draft.finalized` but generates an action emitting `task.completed` (`commands.ts:132-182`).
4. **Is `receipt simulate` a supported alias or a leftover?** It is undocumented everywhere including `printUsage`.
5. **Is the repo-root `src/agents/` tree still the intended authoring surface for `receipt new`/`receipt run`?** `docs/api/cli.md:201` says yes (“compatibility and developer authoring surface”), but nothing else in the repo uses it.
6. **What is the intended public story for `import`/`observe` cloud upload?** A user who has run `receipt login` gets their Claude Code traffic uploaded to the hosted gateway by default. That is a privacy-relevant default that the existing docs do not state.
7. **Is `receipt doctor` meant to exit non-zero when blocked?** Right now it never does, which makes `receipt doctor && …` in a shell script misleading. `package.json:71` (`receipt:doctor`) relies on it.
8. **Should the three `--output-file` envelopes be unified** before they are documented as an API?
9. **Are `defaultPolicy.mutation`, `budgets.maxReconciliationTasks`, and `throttles.mutationCooldownMs` supposed to be honoured?** They are present in the checked-in `.receipt/config.json` and silently ignored by the loader.
10. **What is the intended relationship between `receipt connect list/tools/call` and `receipt tools list/describe/call`?** Both exist, hit overlapping endpoints, and print different envelopes.

---

## Suggested doc pages

| slug | title | audience | what the reader can do afterwards |
|---|---|---|---|
| `cli/overview` | Receipt CLI overview | both | Tell the two `receipt` binaries apart, know which commands each has, and know how to get help (`receipt help`, `receipt connect --help`). |
| `cli/install-and-run` | Running the CLI from a checkout | developer | Run `.receipt/bin/receipt`, understand the Bun resolution order and `RECEIPT_REPO_ROOT`/`RECEIPT_REPO_KEY`, and put the wrapper on `PATH`. |
| `cli/authentication` | Signing in: `login`, `logout`, `whoami`, `setup` | user | Complete the device-login flow, understand per-target sessions, and reuse or refresh a session. |
| `cli/session-file` | The CLI session file | both | Find `~/.receipt/session.json`, read every field, understand the `0600`/`0700` permissions, know which env vars it seeds, and rotate or delete it. |
| `cli/workspaces` | Managing workspaces from the CLI | user | List, create, rename, switch and delete workspaces, and understand that switching mints a new token. |
| `cli/connect` | Connecting third-party tools (`receipt connect`) | user | Run the onboarding flow, connect any of the 62 connectors, check status, disconnect, and import local AWS/GitHub credentials. |
| `cli/connectors-reference` | Connector catalog | user | Look up a connector id, its label, its aliases and the real CLI it shims. |
| `cli/tools-and-mcp` | Calling tools and wiring MCP clients | both | Use `receipt tools list/describe/call`, generate a Codex or generic MCP config, install/remove the Codex server, and run the stdio bridge. |
| `cli/doctor` | `receipt doctor` | developer | Run the check, read every line of text and JSON output, and tell blocking issues from warnings. |
| `cli/configuration` | `.receipt/config.json` and environment | developer | Author a valid config file field by field, know every env override and its precedence, and know which `.env` files are loaded in what order. |
| `cli/receipts-and-streams` | Reading receipts: `trace`, `replay`, `inspect`, `fork` | developer | Resolve a run id to a stream and read, dump, summarise, or fork a receipt chain. |
| `cli/jobs` | Working with the job queue | developer | List, enqueue, wait on, steer, follow-up and abort jobs, with every default and clamp. |
| `cli/memory-and-sessions` | Memory and chat history from the CLI | developer | Read, search, summarise, commit and diff memory scopes; manage user preferences; search and read chat sessions. |
| `cli/dst` | Deterministic-simulation audits (`receipt dst`) | developer | Audit receipt streams for integrity/replay/determinism, use `--context` and `--strict`, and read both output formats. |
| `cli/eval` | Running evaluations (`receipt eval`) | developer | Run one scenario or a batch, list scenarios, and read reports, inspections and replays. |
| `cli/agents` | Legacy agent commands: `new`, `dev`, `run` | developer | Scaffold a `defineAgent` agent, start the local dev runtime, and run an agent inline. |
| `cli/debug-local` | Local diagnostics (`receipt debug local`) | developer | Get a one-shot health snapshot of doctor + queue + DST and interpret every finding. |
| `cli/claude-observer` | Observing Claude Code (`import`/`observe`) | user | Import or tail a Claude event log, choose `metadata` vs `full`, install the background service, and understand where the data is stored. |
| `cli/output-and-exit-codes` | Output formats, `--json`, `--output-file`, exit codes | both | Predict what any command prints, know the three `--output-file` envelopes, and know which commands actually fail the process. |
