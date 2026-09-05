# Receipt — Local development, configuration, environment reference, testing, troubleshooting

Research source-of-truth report for the public documentation site.
Repo root used for every citation: `<receipt-repo>`.
All `path:line` references below are relative to that root.

Method: code first (implementation > config/schema/types > repo markdown > tests).
Where the repo's own markdown disagrees with the code, the code is reported and the
disagreement is listed in [§12 Repo markdown vs. code](#12-repo-markdown-vs-code).

**Not verified by execution.** Bun is not installed in the research environment
(`bun not found`), and Docker was not exercised. Everything below is read from
source. Timings quoted from `LOCAL_SETUP.md` §6A are the repo's own observations,
not mine.

---

## 1. What you are setting up

Receipt is a Bun + Turborepo monorepo containing two cooperating products that share
one PostgreSQL database:

1. **The web app** — `apps/start`, whose workspace/package name is `tanstack`
   (`apps/start/package.json:2`). TanStack Start + Vite + React 19 + Nitro, with
   Rocicorp Zero (`@rocicorp/zero` 1.4.0, `apps/start/package.json`) for sync-first
   client state and Better Auth for users/organizations.
2. **The Receipt runtime + Factory** — `packages/receipt-app`, an event-sourced
   agent orchestration plane. `AGENTS.md:20-25`: *"Receipt streams are the
   authoritative state and replay boundary … Projections, database read models,
   durable workflow rows, local caches, and UI fallbacks are read/serving layers
   only; they must be rebuildable from receipt replay."*

Supporting workspace packages: `packages/receipt-core`, `packages/receipt-durable`,
`packages/receipt-live`, `packages/receipt-dst`, `packages/ui`, `packages/utils`,
`packages/chat-scroll`, `packages/tailwind-config`.
Other apps: `apps/slack`, `apps/teams`. Worker: `workers/markdown-converter`.
Hosted product: <https://app.kentron.ai>.

Licensing note for docs: AGPL-3.0 core, with a separate commercial license for
`apps/start/src/routes/(ee)` and `apps/start/src/ee` (`README.md:193-200`).

---

## 2. Prerequisites

### 2.1 Required for any local run

| Tool | Version | Why (with citation) |
|---|---|---|
| **Node.js** | **24.x** (pinned by `.node-version` = `24`, `.nvmrc` = `24`) | `./bunw` is a Node script (`bunw:4` → `exec node scripts/bun.mjs`). `scripts/preflight.mjs:68-80` fails if `node --version`'s major does not equal `.node-version`. `scripts/start-all.mjs:120` and `scripts/local-up.sh:81` hard-require `node`. |
| **npm** | ships with Node 24 | `scripts/bun.mjs:131-138` uses `npm install --prefix …` to bootstrap the pinned Bun. `scripts/start-all.mjs:121` requires `npm`; `scripts/local-up.sh:82` requires `npm`. `npm run install` is also how the Zero native binding is rebuilt (`scripts/start-all.mjs:733-745`). |
| **Bun** | **exactly 1.3.12** (`.bun-version:1`, `package.json:10` `"packageManager": "bun@1.3.12"`) | The runtime for every repo command. You do **not** install it yourself — `./bunw` resolves or installs it. |
| **Docker** (daemon running) | any recent | Postgres (`docker-compose.postgres.yml`), Redis + Nango (`docker-compose.local.yml`), and every OpenSandbox sandbox container. `scripts/start-all.mjs:122` requires `docker` when Postgres or local infra is started; `scripts/local-up.sh:80` requires it unconditionally. |
| **curl** | any | `scripts/start-all.mjs:121` requires `curl`; `scripts/validate-stack.sh:1351` requires it. |
| **git** | any | `receipt doctor` treats a missing `git` or a non-git checkout as **blocking** (`packages/receipt-app/src/cli/doctor.ts:383,386`). |

### 2.2 Required for the full supervised stack (`start:all` / `local:up`)

| Tool | Version | Why |
|---|---|---|
| **`uv` / `uvx`** | any recent | `scripts/start-all.mjs:123` requires `uvx` when the OpenSandbox controller is started; it then runs `uvx opensandbox-server …` (`scripts/start-all.mjs:235,241`). `scripts/validate-stack.sh:1356` requires `uvx` when `VALIDATE_STACK_START=1`. |
| **`resonate` server binary** | **>= 0.9.7** | The Receipt runtime supervisor spawns the Resonate broker (`scripts/start-resonate-runtime.mjs:338-360`). `assertCompatibleResonateCommand` (`scripts/start-resonate-runtime.mjs:263-276`) throws below 0.9.7. If the broker exits, the supervisor calls `process.exit` and takes the runtime down (`scripts/start-resonate-runtime.mjs:354-359`). |
| **`python3`, `mktemp`, `df`** | any | `scripts/validate-stack.sh:1352-1353,71` |
| **Free disk >= 8 GiB** | — | `require_host_disk_space` (`scripts/validate-stack.sh:70-92`), default `VALIDATE_STACK_MIN_FREE_DISK_MB=8192`. Only enforced when `VALIDATE_STACK_START=1`. |

### 2.3 Optional, feature-specific

| Tool | Needed for |
|---|---|
| **`codex`** (`@openai/codex`) | Factory agent runs. **`receipt doctor` treats a missing `codex` as a blocking failure** (`packages/receipt-app/src/cli/doctor.ts:384`). Version pinned for the container images is `0.130.0` (`deploy/Dockerfile.receipt:3` `ARG CODEX_VERSION=0.130.0`). The OpenSandbox guest image installs it unpinned (`scripts/factory-computer-guest-setup.sh:131` `npm i -g @openai/codex`). |
| **`gh`** | GitHub-backed Factory flows. Missing `gh` is a **warning** only (`packages/receipt-app/src/cli/doctor.ts:390`). |
| **`aws`** | AWS-connected Factory flows. Missing/unauthenticated `aws` is a **warning** only (`packages/receipt-app/src/cli/doctor.ts:391`). |
| **`psql`** | Optional; `scripts/run-receipt-smoke.sh:100,74` silently skips its Zero-event-trigger optimization when `psql` is absent. |
| **Cloudflare account + `wrangler`** | Only for the markdown-converter worker (`scripts/setup-markdown-converter.sh`). |

### 2.4 Install commands (as written in the repo)

```bash
# uv (provides uvx) — LOCAL_SETUP.md:77
curl -LsSf https://astral.sh/uv/install.sh | sh

# resonate server — LOCAL_SETUP.md:81-85 (macOS arm64 example)
curl -fsSL -o /tmp/resonate.tgz \
  https://github.com/resonatehq/resonate/releases/download/v0.9.8/resonate_darwin_aarch64.tar.gz
tar -xzf /tmp/resonate.tgz -C /tmp
install -m 0755 /tmp/resonate ~/.local/bin/resonate-server
resonate-server --version

# codex — LOCAL_SETUP.md:88
npm install -g @openai/codex@0.130.0
```

Linux assets are `resonate_linux_x86_64.tar.gz` / `resonate_linux_aarch64.tar.gz`
(`LOCAL_SETUP.md:91-92`).

### 2.5 Non-obvious: how the Resonate binary NAME changes behaviour

`resolveResonateServerCommand` (`scripts/start-resonate-runtime.mjs:190-243`)
resolves the binary in this order:

1. `RESONATE_BIN`
2. `resonate-server` on `PATH`
3. `resonate` on `PATH`
4. the literal string `"resonate-server"`

Then:

- `isLegacyResonateServerBinary(bin)` (`scripts/start-resonate-runtime.mjs:171-174`)
  returns true when the **basename is `resonate-server`**. In that case the
  supervisor always emits the *legacy* flag set
  (`serve --server-bind … --server-port … --observability-metrics-port …
  --tasks-retry-timeout 500 --storage-type sqlite --storage-sqlite-path …`).
- Otherwise it probes `serve --help` (`supportsLegacyResonateServeFlags`,
  lines 176-188) and, if the modern CLI is detected, uses
  `serve --api-http-addr <bind>:<port> --metrics-addr <bind>:<metricsPort>
  --aio-store-sqlite-enable --aio-store-sqlite-path …`.
- **`assertCompatibleResonateCommand` returns early — skipping the >= 0.9.7
  version check entirely — when the binary is named `resonate-server`**
  (`scripts/start-resonate-runtime.mjs:264`).

Consequence a docs writer must not get wrong: the repo's own install instruction
(`install -m 0755 /tmp/resonate ~/.local/bin/resonate-server`) both **skips** the
version assertion and **forces** the legacy flag set. Installing the binary as
`resonate` on `PATH` instead is what actually exercises the version check and the
CLI-shape probe. This is worth calling out explicitly in the docs.

### 2.6 `./bunw` — the toolchain wrapper

Never run a bare `bun` for repo commands (`AGENTS.md:55-62`).

- `bunw` (POSIX) = `exec node "$(dirname "$0")/scripts/bun.mjs" "$@"` (`bunw:1-4`).
  `bunw.cmd` is the Windows entrypoint (`bunw.cmd:1-3`).
- Expected version comes from `.bun-version`, falling back to
  `package.json`'s `packageManager: "bun@…"` (`scripts/bun.mjs:52-59`).
- Candidate search order (`scripts/bun.mjs:71-81`):
  `RECEIPT_BUN_BIN` → `BUN_BIN` → `$BUN_INSTALL/bin/bun` →
  `<repo>/.bun/toolchains/<version>/node_modules/.bin/bun` → `<repo>/.bun/bin/bun` →
  `~/.bun/bin/bun` → `/opt/homebrew/bin/bun` → `/usr/local/bin/bun` → `PATH`.
  Only a binary whose `--version` matches **exactly** is accepted (line 84).
- If none matches, it `npm install`s Bun into the gitignored
  `.bun/toolchains/<version>/` using a staging directory and an atomic rename
  (`scripts/bun.mjs:140-200`). **The user's global Bun is never replaced or
  downgraded.**
- `RECEIPT_BUN_AUTO_INSTALL=0` disables the bootstrap (`scripts/bun.mjs:104-129`);
  you then must set `RECEIPT_BUN_BIN`.
- `RECEIPT_NPM_BIN` overrides which npm is used for the bootstrap
  (`scripts/bun.mjs:132`).
- When it runs Bun it exports `RECEIPT_BUN_BIN`, `BUN_BIN`, and prepends the Bun
  directory to `PATH` for the child (`scripts/bun.mjs:220-228`).
- Failure exits with code **127** and prints the error plus
  `Set RECEIPT_BUN_BIN=/absolute/path/to/bun to use an existing exact-version binary.`
  (`scripts/bun.mjs:207-215`).

Verify the toolchain at any time:

```bash
./bunw run toolchain:bootstrap   # node scripts/bun.mjs --version  (package.json:52)
./bunw run toolchain:check       # node scripts/preflight.mjs      (package.json:53)
```

`scripts/preflight.mjs` prints exactly `[preflight] Environment is ready.` on
success (line 40) or `[preflight] Environment is not ready:` followed by
`  - <failure>` lines and exit 1 (lines 34-38). Optional flags:
`--deploy` adds Docker-daemon and AWS-CLI checks (lines 19-28) and `--native`
checks that `@parcel/watcher` loads (lines 30-32). `package.json:17,25` wire these
as `build:preflight` and `deploy:preflight`.

---

## 3. Step-by-step local setup

### 3.1 Minimal path (chat app + Zero + runtime)

Consolidated from `AGENTS.md:66-77`, `DEVELOPMENT.md:50-84`, `LOCAL_SETUP.md:297-329`,
and verified against the scripts.

```bash
git clone <repo> Receipt && cd Receipt

# 1. Toolchain + dependencies (installs pinned Bun 1.3.12 if needed)
./bunw install

# 2. Config
cp apps/start/.env.example apps/start/.env.local
$EDITOR apps/start/.env.local          # see §4 for the values that matter

# 3. Infrastructure
docker compose -f docker-compose.postgres.yml up -d

# 4. Generated i18n — MUST run before db:reset
./bunw run --cwd apps/start i18n:compile

# 5. Schema
./bunw run web:db:reset

# 6. Run
./bunw run dev
```

Then open <http://localhost:3000>.

**Why step 4 is mandatory before step 5.** `web:db:reset` →
`apps/start` `db:reset` → `apps/start/scripts/db-reset.ts:87-95` spawns
`bunx @better-auth/cli migrate --yes --config src/lib/backend/auth/auth.server.ts`.
That config imports app modules, which import the Paraglide bundle generated into
`apps/start/src/paraglide` by
`paraglide-js compile --project ./project.inlang --outdir ./src/paraglide`
(`apps/start/package.json:9`).

**`./bunw run dev` compiles i18n itself** via the `predev` hook
(`apps/start/package.json:10`), so step 4 only exists for the `db:reset` ordering.

### 3.2 Full parity path (`local:up`)

`local:up` is the only entry point that brings up the whole product — Nango, the
OpenSandbox controller, the service gateway and the runtime together
(`LOCAL_SETUP.md:559-563`).

```bash
cd <repo root>

# 1. Load your local configuration INTO THE SHELL. Not optional — see below.
set -a; source apps/start/.env.local; set +a

# 2. The one value local-up.sh cannot derive from anything else.
export LOCAL_UP_ZERO_UPSTREAM_DB="$ZERO_UPSTREAM_DB"

# 3. Optional: skip surfaces you have no credentials for; allow a slower first boot.
export START_ALL_SLACK=0 START_ALL_TEAMS=0 START_ALL_WAIT_TIMEOUT_SECONDS=300

# 4. Go. Keep this terminal open — it is the supervisor.
./bunw run local:up
```

**Why step 1 is mandatory (very non-obvious).** `scripts/local-up.sh` never reads
`apps/start/.env.local`. It resolves every value from the *shell*, falling back to
repo defaults (`scripts/local-up.sh:169-227`), writes them to
`.deploy-artifacts/local-up/<ts>/local.env`, exports them
(`load_runtime_env_file`, lines 234-249) and then `exec`s `start-all.mjs`
(lines 397-403). Inside `start-all.mjs`, `loadEnvFile` **skips any key already
present in the environment** (`scripts/start-all.mjs:303`), so those exported
fallbacks outrank your `.env.local`. Sourcing the file first makes every fallback
the value you actually want.

The same applies to Docker Compose: `docker-compose.postgres.yml:21` publishes
`"${START_ALL_POSTGRES_PORT:-5432}:5432"`, and Compose reads the shell, not any
env file.

`local:up` also accepts one positional argument, the provider, which must be
`opensandbox` (alias `computer`); anything else prints usage and fails with
`Unknown provider '<x>'. Use opensandbox.` (`scripts/local-up.sh:46-60`).
`local:up:opensandbox` (`package.json:22`) passes it explicitly.

### 3.3 The three run modes

| | `./bunw run dev` | `./bunw run start:all` | `./bunw run local:up` |
|---|---|---|---|
| Entry point | `turbo run dev --filter=tanstack --ui tui` (`package.json:12`) → `apps/start` `dev` → `bun scripts/dev-with-receipt.mjs` (`apps/start/package.json:11`) | `bun ./scripts/start-all.mjs` (`package.json:19`) | `bash ./scripts/local-up.sh` (`package.json:21`), which `exec`s `start-all.mjs` |
| Web tier | **Vite dev server with HMR** (`apps/start/scripts/dev-with-receipt.mjs:42`) | Production Nitro build behind a gateway | same as `start:all` |
| Postgres | started via Docker unless `START_DEV_POSTGRES=0` (`dev-with-receipt.mjs:84-95`) | started unless `START_ALL_POSTGRES=0` (`start-all.mjs:161-176`) | always (`local-up.sh:400` forces `START_ALL_POSTGRES=1`) |
| Zero cache | yes (`dev-with-receipt.mjs:37`) | yes (`start-all.mjs:521`) | yes |
| Receipt runtime | yes, `receipt:dev` → `RECEIPT_SERVER_WATCH=api`, so the `api` role runs under `bun --watch` (`scripts/start-resonate-dev.mjs:7`, `start-resonate-runtime.mjs:142-143`) | `receipt:start`, no watch (`start-all.mjs:505`) | same as `start:all` |
| Resonate broker | yes (supervised by the runtime) | yes | yes |
| Redis | no | yes (`start-all.mjs:178-207`) | yes |
| Nango integrations | no | yes | yes |
| OpenSandbox controller | no | yes, unless `START_ALL_OPENSANDBOX=0` (`start-all.mjs:69-72`) | yes; `RECEIPT_FACTORY_COMPUTER_PROVIDER=opensandbox` is forced (`local-up.sh:220`) |
| Service gateway (3000) + internal web (3001) | no — Vite serves 3000 directly | yes (`start-all.mjs:576`) | yes |
| Slack / Teams | no | yes unless `START_ALL_SLACK=0` / `START_ALL_TEAMS=0`; both are *optional* children (`start-all.mjs:544,565`) | same |
| Production web build | no | yes unless `START_ALL_BUILD_WEB=0` (`start-all.mjs:477-500`) | `LOCAL_UP_BUILD_WEB` maps to `START_ALL_BUILD_WEB`, default `1` (`local-up.sh:219`) |
| Extra: DB reset | no | no | **yes, conditionally** — a schema probe decides (`local-up.sh:144-159, 361-389`) |
| Extra: env artifact | no | writes `.deploy-artifacts/local-up/latest.env` (`start-all.mjs:301-...` → `persistStartAllRuntimeEnv`) | writes `<run>/local.env` + `latest.env` symlink (`local-up.sh:161-232`) |
| Logs | stdio inherited | `.deploy-artifacts/start-all/<runId>/<name>.log` (`start-all.mjs:11-12, 660`) | same |

`dev` uses a Turbo TUI (`--ui tui`), which needs a real terminal. In a
non-interactive shell run `./bunw run --cwd apps/start dev` instead
(`LOCAL_SETUP.md:499-501`).

`dev` and `local:up` cannot run at the same time — they want the same ports
(`LOCAL_SETUP.md:813-815`).

### 3.4 The `local:up` startup sequence, in order

From `scripts/local-up.sh:405-417` then `scripts/start-all.mjs:27-55`:

1. `local-up.sh` normalises the provider, requires `bun`/`docker`/`node`/`npm`,
   runs `bun install` if `node_modules` is missing (`local-up.sh:78-88`).
2. Rebuilds the `@rocicorp/zero-sqlite3` native binding if `require()` fails
   (`local-up.sh:90-117`).
3. Writes the resolved env file and exports it.
4. Starts Postgres, waits up to 60 s for `select 1` through
   `docker compose … exec -T postgres psql` (`local-up.sh:119-142`).
5. **Schema probe** (`local_schema_ready`, `local-up.sh:144-159`): the DB is
   considered ready only if `user`, `organization`,
   `receipt_chat_context_projection`, `receipt_chat_history_projection`,
   `receipt_receipts` all exist, the legacy `threads`/`messages` tables do **not**
   exist, and publication `zero_data` exists. If the probe fails, it runs the
   **destructive** `bun run web:db:reset`. `LOCAL_UP_DB_RESET=0` disables this;
   `=1` forces it; `auto` (default) uses the probe.
6. Discovers an organization holding an OpenAI BYOK row in `org_provider_api_key`,
   preferring one with a valid `aws` connection secret, and mints a
   `RECEIPT_CONNECT_TOKEN` (12 h TTL) into the env file
   (`local-up.sh:251-359`). It logs `Using local BYOK organization <org>` or
   `Configured organization <x> has no local OpenAI BYOK row; using <y>`.
7. `exec bun ./scripts/start-all.mjs`, which then:
   1. loads env files, sets runtime defaults, creates the run dir;
   2. **preflight**: requires `bun`, `node`, `npm`, `curl`, plus `docker` and
      `uvx` conditionally; rebuilds the Zero native binding; asserts the worker
      gateway is reachable; asserts every port free on **both** `127.0.0.1` and
      `::1` (`start-all.mjs:117-146, 396-412`);
   3. Postgres → Redis + Nango (compose project `receiptfactory-local`,
      `start-all.mjs:187`), creating the separate `receipt_integrations` database
      (`start-all.mjs:444-470`);
   4. builds `receiptfactory/opensandbox-worker:local` if missing, generates
      `.opensandbox/sandbox.toml` via `uvx opensandbox-server init-config … --example docker --force`,
      rewrites its `port =` line, starts the controller with
      `OPENSANDBOX_INSECURE_SERVER=YES`, waits for `/health`
      (`start-all.mjs:209-268`);
   5. reads Nango's `secret_key` straight out of
      `nango._nango_environments` where `name='prod'`
      (`start-all.mjs:428-441`) and reconciles provider integrations
      (`start-all.mjs:390-409`);
   6. **pre-migrates the Receipt durable schema** (`start-all.mjs:851-889`),
      then runs Zero migrations (`start-all.mjs:475-478`), then **refreshes the
      `zero_data` publication** (`start-all.mjs:891-928`) — in that order,
      because the publication references Receipt projection tables;
   7. builds the production web bundle (the slow step);
   8. starts runtime, zero-cache, gateway (+ Slack/Teams/markdown worker),
      waits for health, supervises.

Success is the log line `start_all.ready  Local stack is up`
(`start-all.mjs:698`, `LOCAL_SETUP.md:628-630`).

### 3.5 Stopping the stack

There is no `local:down` script.

- **Ctrl-C** in the `local:up` terminal, or
  `pkill -f 'bun \./scripts/start-all\.mjs'` (SIGTERM).
  `installCleanupHandlers` registers `SIGINT`/`SIGTERM`/`exit` handlers
  (`start-all.mjs:1051-1058`) and `cleanup()` kills each child's process group
  (`start-all.mjs:1060-1080`).
- **Never `kill -9` the supervisor.** Children are spawned `detached`
  (`start-all.mjs:665`), so SIGKILL runs no handler and the whole Bun/Node tier
  survives reparented to PID 1 — ports still bound, health endpoints still
  answering 200, and the next `local:up` failing its port preflight. This is
  RCA-209 (`docs/agent-fix-checklist.md:10509`).
- `pkill -f local-up.sh` is not a substitute: `local-up.sh` installs no `trap`
  and `exec`s the supervisor in a subshell.
- Killing any non-optional child (runtime roles, Resonate, gateway, web) also
  takes the stack down through `supervise() → fail() → cleanup()`
  (`start-all.mjs:706-724`).
- Zero forks its workers detached, so `change-streamer.js` (which holds the
  zero-cache port + 1) can outlive shutdown. Reap with
  `pkill -f 'zero-cache/src/server/'` **after** the supervisor is stopped
  (`LOCAL_SETUP.md:711-722`).
- `cleanup()` contains no Docker calls, so Ctrl-C never stops the containers.
  Leaving them up between restarts is the intended fast path.
  Stop them with `docker compose -f docker-compose.postgres.yml stop postgres`
  and `docker compose -p receiptfactory-local -f docker-compose.local.yml stop redis nango`.
- **Destructive, never for a routine stop:**
  `docker compose -f docker-compose.postgres.yml down -v` (deletes the named
  volume `receipt_postgres_data`, i.e. the whole database, users, organizations,
  receipts, projections, encrypted BYOK keys, and the `receipt_integrations`
  database with Nango's saved connections). `docker system prune -a` also deletes
  `receiptfactory/opensandbox-worker:local` and costs a multi-minute rebuild.

### 3.6 Nothing in `local:up` hot-reloads

`LOCAL_SETUP.md:773-805`. The web tier is a prebuilt production bundle with no Vite
process, and every server process is spawned without `--watch`
(`RECEIPT_SERVER_WATCH` is unset on this path; see `start-resonate-runtime.mjs:121-143`).

Practical rules (verified against the code paths named):

| Changed | Minimum action |
|---|---|
| `packages/receipt-app/src/**` HTTP/UI handlers | kill the `api` role's listener; the role supervisor respawns it with exponential backoff (`start-resonate-runtime.mjs:296-335`) |
| `packages/receipt-app/src/**` services/agents/adapters/db | `pkill -f 'bun src/server.ts'` — all roles respawn |
| `packages/receipt-app/src/client/**` or its Tailwind CSS | `./bunw run receipt:build` — no restart; assets are re-read per request |
| `packages/receipt-core` / `-durable` / `-live` used by the runtime | restart the roles; they are consumed as TS source through workspace links |
| anything under `apps/start/src`, or `packages/ui`/`utils`/`chat-scroll` used by the web app | full rebuild + restart (`local:up`) |
| `apps/start/scripts/service-gateway.ts` | full restart |
| `apps/slack/**`, `apps/teams/**` | restart just that child (they are optional children) |
| the `receipt` CLI (`packages/receipt-app/src/cli.ts`, `src/cli/**`, `src/factory-cli/**`) | nothing — the wrapper runs TypeScript from source (`.receipt/bin/receipt:47-55`) |
| a `VITE_*` / `ENABLE_*` value | rebuild + restart — Vite inlines these into the browser **and** SSR bundles (`apps/start/vite.config.ts:349` `envPrefix: ['VITE_', 'ENABLE_']`) |
| a server-only env value | restart only: `LOCAL_UP_BUILD_WEB=0 ./bunw run local:up` |
| a Zero migration file | `./bunw run --cwd apps/start zero:migrate` — safe against a live stack; add a **new** timestamped file, never edit an applied one (checksums are enforced, `apps/start/scripts/zero-migrate.ts:19`) |
| Zero schema added/removed a **table** | schema **and** publication membership in one change, then stop, `zero:reset`, `local:up`, and clear browser site data |

For an `apps/start` UI edit loop, use `./bunw run dev` instead.

---

## 4. Configuration

### 4.1 Where config lives, and load order

- The canonical template is **`apps/start/.env.example`** (258 lines).
  Copy it to `apps/start/.env.local` (gitignored: `.gitignore:7-8`).
- A second, undocumented template exists for self-hosting:
  **`apps/start/.env.self-host.example`**. It is not referenced by `README.md`,
  `DEVELOPMENT.md`, or `LOCAL_SETUP.md`.
- **There is no central env schema** — no zod/t3-env. Each module validates
  lazily, so most mistakes surface as a runtime error on the feature you touch,
  not at boot. (A handful are read at module top level; see §4.2.)

Every entry point loads env files in the **same order**, and in all of them an
env file value **loses** to a value already exported in the shell:

| Loader | Files, in order |
|---|---|
| `scripts/start-all.mjs:290-306` | `<root>/.env`, `<root>/.env.local`, `apps/start/.env`, `apps/start/.env.local`, `$START_ALL_ENV_FILE`, then each of `$START_ALL_ENV_FILES` (comma-separated) |
| `apps/start/scripts/dev-with-receipt.mjs:284-306` | `<root>/.env`, `<root>/.env.local`, `apps/start/.env`, `apps/start/.env.local` |
| `scripts/validate-stack.sh:127-155` | the same four, then `$START_ALL_ENV_FILE`, `$VALIDATE_STACK_ENV_FILE`, then `$START_ALL_ENV_FILES` + `$VALIDATE_STACK_ENV_FILES` |
| the `receipt` CLI, `packages/receipt-app/src/cli/env.ts:148-188` | the same four, then `.deploy-artifacts/local-up/latest.env`, `$START_ALL_ENV_FILE`, `$RECEIPT_LOCAL_ENV_FILE`, `$VALIDATE_STACK_ENV_FILE`, `$START_ALL_ENV_FILES`, `$VALIDATE_STACK_ENV_FILES`. Set `RECEIPT_CLI_LOAD_LOCAL_ENV=0` to skip the repo/app `.env*` files and the `latest.env` artifact. |
| `apps/start/scripts/db-reset.ts:26-43`, `zero-dev-reset.ts:29-48`, `zero-migrate.ts` | `apps/start/.env.local`, then `apps/start/.env` |

The `receipt` CLI locates the repo root by walking up looking for a directory
containing `package.json` + `packages/receipt-app` + `apps/start`
(`packages/receipt-app/src/cli/env.ts:45-61`).

`zero-cache` is different: `apps/start/package.json:19` runs
`bun --env-file=.env --env-file=.env.local zero-cache-dev`, i.e. Bun's own env-file
loader rather than the repo's. `apps/start/.env.example:58` says
*"For Local Development, Zero requires separate '.env' file"*. **Nothing in the
repo creates `apps/start/.env`, and no checked-in code requires it** — see
[open questions](#14-open-questions).

### 4.2 Variables enforced at import time (the process dies without them)

| Variable | Enforced at | Exact error |
|---|---|---|
| `BETTER_AUTH_URL` | `apps/start/src/lib/backend/auth/services/auth.service.ts:101-108` | `Missing BETTER_AUTH_URL. Configure apps/start/.env before starting auth.` |
| `BETTER_AUTH_SECRET` | `auth.service.ts:95-99, 450` (`requireEnv`) | `Missing required environment variable BETTER_AUTH_SECRET.` |
| `ZERO_UPSTREAM_DB` | `apps/start/src/lib/backend/auth/infra/auth-pool.ts:8` → `zero-upstream-pool.ts:121-125` | `Missing required environment variable ZERO_UPSTREAM_DB.` |
| `ZERO_UPSTREAM_DB` (runtime side) | `packages/receipt-app/src/config/runtime-env.ts:20-26` | `Receipt Postgres storage requires ZERO_UPSTREAM_DB.` |
| `ZERO_UPSTREAM_DB` (db scripts) | `apps/start/scripts/db-reset.ts:71-77`, `zero-dev-reset.ts:114-120` | `ZERO_UPSTREAM_DB is not set. Set it in apps/start/.env or .env.local.` |

`ZERO_UPSTREAM_DB` is the **single canonical database variable**.
`resolveZeroUpstreamConnectionString` deliberately accepts no aliases:
*"Accepting multiple aliases here made app and Receipt runtime paths capable of
silently pointing at different databases"* (`apps/start/src/lib/backend/server-effect/infra/zero-upstream-pool.ts:34-44`).

### 4.3 A minimal working `apps/start/.env.local`

```bash
BETTER_AUTH_SECRET=$(openssl rand -base64 32)
BETTER_AUTH_URL=http://localhost:3000
VITE_BETTER_AUTH_URL=http://localhost:3000
ZERO_UPSTREAM_DB=postgresql://receipt:receipt@localhost:5432/receipt
VITE_ZERO_CACHE_URL=http://localhost:4848
BYOK_ENCRYPTION_KEY_B64=$(openssl rand -base64 32)
RECEIPT_CONNECTION_ENCRYPTION_KEY_B64=$(openssl rand -base64 32)
RECEIPT_CONNECT_JWT_SECRET=$(openssl rand -base64 32)
VITE_ENABLE_EMBEDDING=false
VITE_DISABLE_REDIS=true
AUTH_EMAIL_PROVIDER=disabled
```

`BETTER_AUTH_URL` and `VITE_BETTER_AUTH_URL` **must share the origin you actually
browse to**; a mismatch silently breaks auth with CORS errors (RCA-253,
`docs/agent-fix-checklist.md:12326`).

Postgres credentials come from `docker-compose.postgres.yml:16-19`:
user `receipt`, password `receipt`, database `receipt`.

### 4.4 How model credentials actually resolve (read before debugging "no model")

Model credentials are **organization-scoped BYOK rows in Postgres**
(`org_provider_api_key`), not a process env var.

`resolveFactoryModelFunding` (`packages/receipt-app/src/services/factory-model-funding.ts:40-104`):

1. A Slack-originated `billingRequestId` starting `slack_evt_` may authorize
   platform credit first.
2. Otherwise an encrypted BYOK key for the org/workspace, decrypted with
   `BYOK_ENCRYPTION_KEY_B64` (`services/receipt-openai-env.ts:86-166`).
   **This is the normal path** — you add it through the app's settings UI after
   signing in.
3. Failing that, and only with a billing request id, the process-wide
   `OPENAI_API_KEY` as platform credit
   (`services/platform-openai-key.ts:10-22`).

So: sign up locally, create an organization, and paste an OpenAI key into org
settings. Setting `OPENAI_API_KEY` in `.env.local` alone will not make Factory work.
`receipt doctor` deliberately prints `provider auth: organization BYOK required`
and does **not** validate a model key
(`packages/receipt-app/src/cli/doctor.ts:444`).

Web-chat errors you will see with neither BYOK nor `OPENAI_API_KEY`:

- `Platform-funded OpenAI access is unavailable: OPENAI_API_KEY is not configured.`
  (`apps/start/src/lib/backend/chat/services/model-gateway.service.ts:107`)
- `Platform-funded OpenAI embeddings are unavailable: OPENAI_API_KEY is not configured.`
  (`apps/start/src/lib/backend/chat/services/rag/attachment-content.pipeline.ts:148`)
- `Platform-funded OpenAI access is authorized, but OPENAI_API_KEY is unavailable.`
  (`packages/receipt-app/src/services/factory-model-funding.ts:66,100`)

`BYOK_ENCRYPTION_KEY_B64` is an AES-256-GCM key (`openssl rand -base64 32`).
**Do not rotate it after users have saved BYOK keys** unless you re-encrypt the
existing rows (`apps/start/.env.example:145-148`).

---

## 5. Environment variable reference

Grouped by concern. "Default" is the value in code when the variable is unset;
"—" means there is none. `★` marks variables **read by code but absent from
`apps/start/.env.example`**.

### 5.1 Core auth and identity (`apps/start`)

| Variable | Required | Default | Effect |
|---|---|---|---|
| `BETTER_AUTH_SECRET` | **yes** | — | Better Auth signing secret; module-level throw if missing (`auth.service.ts:450`). Also the fallback for `RECEIPT_CONNECT_JWT_SECRET` in `start:all` (`start-all.mjs:333`) and `local:up` (`local-up.sh:172`). |
| `BETTER_AUTH_URL` | **yes** | — | Server-side public auth origin (`auth.service.ts:101-108`). Trailing slashes stripped. |
| `VITE_BETTER_AUTH_URL` | in practice | — | Browser-bundle auth base URL; inlined at build time. Must match `BETTER_AUTH_URL`'s origin. |
| `BETTER_AUTH_COOKIE_DOMAIN` | no | — | Cookie domain for production cookie-based auth. |
| `BETTER_AUTH_USE_SECURE_COOKIES` ★ | no | derived from the auth origin's scheme | `true`/`1` or `false`/`0` overrides secure-cookie selection (`auth.service.ts:113-118`). |
| `RECEIPT_LEGACY_PUBLIC_ORIGINS` ★ | no | — | Extra trusted origins for Better Auth (`auth.service.ts:454`, `auth-trusted-origins.ts:70`). Invalid values throw `Invalid RECEIPT_LEGACY_PUBLIC_ORIGINS: <reason>.` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | no | — | Google social login (`auth.service.ts:89-90`). |
| `SELF_HOSTED_SETUP_TOKEN` ★ (in `.env.self-host.example` only) | self-hosted | — | One-time token used to create the first admin user (`instance-settings.service.ts`). |
| `ADMIN_EMAIL_ALLOWLIST` ★ | no | — | Comma list gating the admin surface (`apps/start/src/lib/backend/admin/admin-access.server.ts:35`). |
| `RECEIPT_PUBLIC_BASE_URL` ★ | deploy | — | Public gateway origin so Better Auth, Nango Connect, Slack and Receipt Connect agree (`README.md:105`). |

### 5.2 Auth email delivery (`apps/start`)

All read through `readEmailEnv` in
`apps/start/src/lib/backend/auth/services/auth-email.service.ts`.

| Variable | Default | Effect |
|---|---|---|
| `AUTH_EMAIL_PROVIDER` | auto-detected: `resend` if `RESEND_API_KEY` set, else `ses` if a SES/AUTH from-address plus SST identity, else `disabled` (`auth-email.service.ts:68-86`) | One of `disabled` \| `resend` \| `ses` \| `smtp` (line 26). |
| `AUTH_EMAIL_FROM` | — | Generic from-address; fallback for Resend/SES/SMTP. |
| `RESEND_API_KEY`, `RESEND_FROM_EMAIL` | — | Both needed when provider is `resend` (lines 32-39, 119-120). |
| `SES_REGION` (falls back to `AWS_REGION`), `SES_FROM_EMAIL`, `SES_CONFIGURATION_SET` | — | SES v2 client is only constructed when provider is `ses` **and** a region is present (lines 44-47). |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM_EMAIL` | port `587`, secure `false` | Nodemailer transport; auth is added only when both user and password are set (lines 48-64). |
| `SST_RESOURCE_AuthEmail` ★ | — | SST-provided SES identity/configuration set (line 90). |
| `AUTH_EMAIL_SST_SENDER`, `AUTH_EMAIL_SST_DNS`, `AUTH_EMAIL_DMARC` | — | Present in `.env.example`; consumed by the SST deploy path (`deploy/sst/auth-email-config*`), not by the app at runtime. |

### 5.3 Signup OTP behaviour

`apps/start/src/utils/app-feature-flags.ts:30-48`. Cloud sign-up skips the email
OTP step when either:

- running the Vite dev server (`import.meta.env.DEV`) and
  `VITE_REQUIRE_SIGNUP_EMAIL_OTP` is not `true`/`1`, or
- `VITE_DISABLE_EMAIL_VERIFICATION_OTP` is `true`/`1` at **build time**.

`start:all` exports `VITE_DISABLE_EMAIL_VERIFICATION_OTP=1` for the web build
unless `START_ALL_USE_SIGNUP_EMAIL_OTP=1` (`start-all.mjs:498`, `runtimeOptions` line 115).

### 5.4 Database, Zero and replication

| Variable | Required | Default | Effect |
|---|---|---|---|
| `ZERO_UPSTREAM_DB` | **yes** | — | The single canonical Postgres URL for app + runtime + Zero + all scripts. `sslmode=prefer\|require\|verify-ca` is rewritten to `verify-full` unless `uselibpqcompat=true` (`zero-upstream-pool.ts:16-32`). |
| `VITE_ZERO_CACHE_URL` | in practice | `http://localhost:4848` (`dev-with-receipt.mjs:48`) | Browser → zero-cache websocket URL; inlined into the bundle. |
| `ZERO_APP_ID` | no | `receipt` (`apps/start/package.json:19`, `start-all.mjs:524`) | Zero app namespace. |
| `ZERO_APP_PUBLICATIONS` | no | `zero_data` (same) | Publications zero-cache replicates. |
| `ZERO_QUERY_URL` / `ZERO_MUTATE_URL` | no | `http://127.0.0.1:<gatewayPort>/api/zero/{query,mutate}` under `start:all` (`start-all.mjs:526-527`) | zero-cache → app transform endpoints. |
| `ZERO_QUERY_FORWARD_COOKIES` / `ZERO_MUTATE_FORWARD_COOKIES` | no | `.env.example` sets `true` | Forward browser cookies to the transform routes. |
| `ZERO_QUERY_ALLOWED_CLIENT_HEADERS` / `ZERO_MUTATE_ALLOWED_CLIENT_HEADERS` | no | `x-receipt-zero-token,authorization` (`start-all.mjs:528-531`) | Without these, `zero:analyze` can connect to zero-cache but the transform route rejects it as unauthenticated. |
| `ZERO_REPLICA_FILE` ★ | no | `apps/start/zero.db` (`zero-dev-reset.ts:151-152`) | Path to zero-cache's local SQLite replica. `validate:stack` isolates it per run (`validate-stack.sh:227`). |
| `ZERO_PUBLICATION_EXTRA_TABLES` ★ | no | — | Comma list appended to the `zero_data` publication (`apps/start/scripts/zero-publication.ts:45-51`). |
| `RECEIPT_POSTGRES_SCHEMA` ★ | no | `public`, or a **derived per-DATA_DIR schema** — see below | Schema holding Receipt projections. |
| `RECEIPT_POSTGRES_SCHEMA_MODE` ★ | no | — | Alternative schema selector consulted by `ensureRuntimeDefaults` (`start-all.mjs:1015`). |
| `RECEIPT_POSTGRES_POOL_MAX` ★ | no | `2` (`packages/receipt-app/src/db/client.ts:232-235`); the runtime supervisor forces `1` locally (`start-resonate-runtime.mjs:23-26`) | node-postgres pool size per process. |
| `RECEIPT_POSTGRES_APPLICATION_NAME` ★ | no | `receipt-<role>-<instance>` (`start-resonate-runtime.mjs:312-314`) | Postgres `application_name`. |
| `RECEIPT_LOCAL_POSTGRES_POOL_MAX` ★ | no | — | Local fallback for pool size (`start-resonate-runtime.mjs:25`). |
| `RECEIPT_POSTGRES_MIRROR_URL` | — | — | **In `.env.example:65` but read by no code.** |
| `ZERO_ADMIN_PASSWORD`, `ZERO_COOKIE`, `ZERO_AUTH_TOKEN`, `ZERO_AUTH_JWT` ★ | no | — | Hosted Zero analyzer/readiness auth only (`scripts/prod-readiness-gate.mjs:532`, `apps/start/scripts/analyze-query.ts`). Not needed locally. |
| `TEST_ZERO_UPSTREAM_DB`, `RECEIPT_TEST_POSTGRES_URL`, `RECEIPT_TEST_DATABASE_URL` ★ | no | — | Test-only database URLs. |

**The derived-schema trap.** When `RECEIPT_POSTGRES_SCHEMA` is unset, the Receipt
DB helper derives a *private* schema from the data dir:
`receipt_data_<sha256(dataDir)[0:24]>`
(`packages/receipt-app/src/db/client.ts:216-231`). That is deliberate tenant
isolation, but it means CLI or worker processes can enqueue jobs into a schema the
running UI never reads. Both supervisors therefore pin the stack to a shared
schema: `start-all.mjs:1010-1020` sets `RECEIPT_POSTGRES_SCHEMA=public`
(overridable via `START_ALL_RECEIPT_POSTGRES_SCHEMA`), and
`dev-process-cleanup.mjs:14-15` does the same for `dev`.

### 5.5 Encryption keys and Receipt Connect

| Variable | Required | Default | Effect |
|---|---|---|---|
| `BYOK_ENCRYPTION_KEY_B64` | in practice | — | AES-256-GCM key wrapping organization provider keys in `org_provider_api_key`. Listed as required by `AGENTS.md:70`. Do not rotate after keys are saved. |
| `RECEIPT_CONNECTION_ENCRYPTION_KEY_B64` | in practice | falls back to `BYOK_ENCRYPTION_KEY_B64` (`start-all.mjs:1021-1023`, `local-up.sh:173`) | Encrypts Receipt Connect credential bundles. |
| `RECEIPT_CONNECT_JWT_SECRET` | in practice | falls back to `BETTER_AUTH_SECRET` (`start-all.mjs:333`, `local-up.sh:172`) | Shared by web app and runtime so `receipt connect` JWTs verify. |
| `RECEIPT_CONNECT_PROD_URL`, `RECEIPT_CONNECT_DEV_URL` | no | — | Named CLI targets. `receipt connect` uses production by default. |
| `RECEIPT_CONNECT_LOCAL_SERVER_URL` | no | `http://127.0.0.1:8787` (`.env.example:164`) | `receipt connect local` runtime target. |
| `RECEIPT_CONNECT_LOCAL_AUTH_URL` | no | `http://127.0.0.1:3000` (`.env.example:165`) | `receipt connect local` auth target. |
| `RECEIPT_CONNECT_PUBLIC_GATEWAY_URL` ★ | no | the resolved `start:all` gateway URL | Browser-facing gateway. |
| `RECEIPT_CONNECT_WORKER_GATEWAY_URL` ★ | no | `http://host.docker.internal:<gatewayPort>` when the local OpenSandbox controller runs, else the public gateway (`start-all.mjs:73-83`) | The gateway URL a sandbox worker can actually reach. |
| `RECEIPT_CONNECT_GATEWAY_URL`, `RECEIPT_CONNECT_SERVER_URL`, `RECEIPT_CONNECT_GATEWAY_HOSTPORT`, `RECEIPT_CONNECT_PUBLIC_URL`, `RECEIPT_CONNECT_URL`, `RECEIPT_CONNECT_CONTROLLER_GATEWAY_URL`, `RECEIPT_CONNECT_ENFORCE_PUBLIC_WORKER_GATEWAY`, `RECEIPT_CONNECT_PROD_GATEWAY_URL`, `RECEIPT_CONNECT_PROD_SERVER_URL` ★ | no | — | Additional Connect endpoint overrides (`apps/start/scripts/service-gateway.ts:168-205`, `packages/receipt-app/src`). |
| `RECEIPT_CONNECT_TOKEN`, `RECEIPT_CONNECT_USER_ID`, `RECEIPT_CONNECT_ORGANIZATION_ID`, `RECEIPT_CONNECT_WORKSPACE_ID`, `RECEIPT_CONNECT_WORKSPACE_NAME` ★ | no | minted/discovered by `local:up` (`local-up.sh:251-359`) | Actor context used by the CLI. |
| `RECEIPT_CONNECT_OPEN_BROWSER`, `RECEIPT_CONNECT_DEVICE_LOGIN_SECRET`, `RECEIPT_CONNECT_MANIFEST_RETRY_DELAY_MS` ★ | no | — | CLI login behaviour. |

`start-all.mjs:148-160` refuses to start when the computer provider is
`opensandbox`, the local controller is **not** started, and the worker gateway is a
private address:
`Remote OpenSandbox workers cannot use a private Receipt Connect gateway.`

### 5.6 Receipt runtime, jobs and Resonate (`packages/receipt-app`)

Documented table in `docs/api/config.md:5-14` (verified where noted):

| Variable | Default | Effect |
|---|---|---|
| `PORT` | `8787` (`packages/receipt-app/src/server/config.ts:73`) | Runtime HTTP listen port. |
| `RECEIPT_PORT` ★ | falls back to `PORT`, then `8787` (`start-resonate-runtime.mjs:16`) | Port the supervisor advertises to roles and the callback URL. |
| `DATA_DIR` / `RECEIPT_DATA_DIR` ★ | `<repo>/.receipt/data` (`start-resonate-runtime.mjs:17`) | Root for Receipt runtime artifacts, Factory packets, local config, the Resonate SQLite DB and the local hub git. |
| `JOB_WORKER_ID` | `worker_<role>_<instance>_<host>` (`start-resonate-runtime.mjs:114-119`); `docs/api/config.md:9` documents `worker_<pid>` | Worker identity for leasing/heartbeats. |
| `JOB_POLL_MS` | `100` (`docs/api/config.md:10`) | Queue poll interval. |
| `JOB_LEASE_MS` | `30000` (`docs/api/config.md:11`) | Lease duration. |
| `JOB_LEASE_GRACE_MS` | unset | Grace window before a missed lease is terminal. |
| `JOB_CONCURRENCY` | `2` (`docs/api/config.md:13`) | Max concurrent jobs per worker. |
| `HEARTBEAT_<AGENT>_INTERVAL_MS` | unset | Periodic collect-lane heartbeat (min 1000 ms). |
| `CHAT_JOB_CONCURRENCY`, `CODEX_JOB_CONCURRENCY`, `CODEX_JOB_LEASE_MS`, `ORCHESTRATION_JOB_CONCURRENCY`, `FACTORY_CONTROL_JOB_LEASE_MS`, `FACTORY_CONTROL_JOB_EXECUTION_TIMEOUT_MS` ★ | — | Lane-specific overrides. `validate:stack` sets `CODEX_JOB_CONCURRENCY=1` by default (`validate-stack.sh:205`). |
| `CONTROL_WORKER_PROCESSES` ★ | `1` (`start-resonate-runtime.mjs:77`) | `worker-control` process count. |
| `CHAT_WORKER_PROCESSES` ★ | `2` (line 78) | `worker-chat` process count. |
| `CODEX_WORKER_PROCESSES` ★ | `OPEN_SANDBOX_GLOBAL_MAX_ACTIVE` → `OPEN_SANDBOX_ORG_MAX_ACTIVE` → `1` (lines 68-71, 81) | `worker-codex` process count. |
| `RECEIPT_PROCESS_ROLE` ★ | unset (all roles) | Restrict this process to one of `api`, `driver`, `worker-control`, `worker-chat`, `worker-codex` (lines 73, 87-101). |
| `RECEIPT_SERVER_WATCH` ★ | unset (no watch); `receipt:dev` sets `api` (`start-resonate-dev.mjs:7`) | `0`/`false`/`none` → none; `1`/`true`/`api` → the `api` role only; `all` → every role; or a comma list of role names (lines 121-140). |
| `RESONATE_URL` ★ | `http://127.0.0.1:8001` (line 22) | Broker URL handed to every role. |
| `RESONATE_PORT` ★ | `8001` (line 198) | Broker listen port. |
| `RESONATE_METRICS_PORT` ★ | `9090` (line 199) | Broker metrics port. |
| `RESONATE_BIND` ★ | `127.0.0.1` (line 197) | Broker bind address. |
| `RESONATE_BIN` ★ | `resonate-server` then `resonate` on `PATH` (lines 200-204) | Explicit path to the broker binary. |
| `RESONATE_DATA_DIR` ★ | `<DATA_DIR>/resonate` (line 195); SQLite file `resonate.db` | Broker storage. |
| `RESONATE_START_SERVER` ★ | auto: start unless `RESONATE_URL` points somewhere non-loopback (lines 40-54) | `0` = never start a local broker, `1` = always. |
| `RESONATE_GROUP_API/CHAT/CODEX/CONTROL/DRIVER`, `RESONATE_STARTUP_SETTLE_MS`, `RESONATE_QUEUE_FULL_REFRESH_MS`, `RECEIPT_RESONATE_*` (heartbeat, redrive, concurrency, stale) ★ | — | Broker/queue tuning read in `packages/receipt-app/src`. |
| `RECEIPT_RESONATE_CALLBACK_URL` / `RECEIPT_EVENT_CALLBACK_URL` ★ | `http://127.0.0.1:<receiptPort>/receipt/callback` (lines 18-21) | Durable-promise callback target. |
| `RECEIPT_REPO_KEY` ★ | `receiptfactory` (`package.json:67`, `start-all.mjs:1005`, `.receipt/bin/receipt:19`) | Stable repo identity for repo-scoped memory/history. |
| `RECEIPT_REPO_ROOT` ★ | the resolved repo root (`.receipt/bin/receipt:18`) | Repo root for the CLI/runtime. |
| `RECEIPT_LOCAL_STACK` ★ | `1` under `start:all` (`start-all.mjs:1007`) | Marks a local supervised run so Receipt Connect keeps local-friendly error copy even though `NODE_ENV=production`. |
| `RECEIPT_TENANT_ROOT` ★ | — | Root for per-tenant data directories. |
| `RECEIPT_CODEX_BIN` ★ | `/Applications/Codex.app/Contents/Resources/codex` if present, else `codex` (lines 27-30; `bootstrap.ts:2730`) | Codex executable. |
| `RECEIPT_CODEX_TIMEOUT_MS`, `RECEIPT_CODEX_STARTUP_TIMEOUT_MS`, `RECEIPT_CODEX_STALL_TIMEOUT_MS`, `RECEIPT_CODEX_MODEL_PROVIDER`, `RECEIPT_CODEX_MODEL_OVERRIDE`, `RECEIPT_CODEX_MODEL_PREFIX`, `RECEIPT_CODEX_OPENAI_BASE_URL`, `CODEX_HOME`, `CODEX_MODEL_PROVIDER` ★ | — | Codex execution tuning. |
| `IMPROVEMENT_VALIDATE_CMD`, `IMPROVEMENT_HARNESS_CMD` | — | Required for `/improvement/:id/validate` (`docs/api/config.md:86-89`). |
| `PLANNER_STEP_TIMEOUT_MS` | `90000` (`docs/api/config.md:78`) | Factory planning step timeout. |
| `RECEIPT_SIMULATOR_UI_PORT` ★ | `4397` (`packages/receipt-app/src/factory-cli/simulator-ui.ts:84,1429`) | `receipt:simulate:ui` listen port. |
| `RECEIPT_FORCE_ASCII`, `NO_COLOR` ★ | — | CLI rendering. |
| `RECEIPT_CLI_LOAD_LOCAL_ENV` ★ | unset (loads repo env) | `0` limits the CLI to explicitly named env files (`cli/env.ts:128-136`). |
| `RECEIPT_CLI_CONFIG_DIR`, `RECEIPT_CLI_SESSION_FILE`, `RECEIPT_CLI_VERSION`, `RECEIPT_CLI_NO_FORCE_EXIT` ★ | — | CLI state. |

### 5.7 OpenAI / model access

| Variable | Default | Effect |
|---|---|---|
| `OPENAI_API_KEY` ★ **(not in `.env.example`)** | — | Platform-credit fallback only. `DEVELOPMENT.md:128` says it is required by `validate:stack` because the validator runs `receipt doctor`; the doctor code does not read it (`cli/doctor.ts`) — see §12. |
| `OPENAI_BASE_URL` / `OPENAI_API_BASE` ★ | — | OpenAI-compatible endpoint. Loopback values unlock the mock-key fallback (§6). |
| `MOCK_OPENAI_API_KEY` ★ | `mock-openai-key` when `OPENAI_BASE_URL` is loopback (`services/receipt-openai-env.ts:68-74`) | Dummy bearer for offline mode. |
| `OPENAI_MODEL` | `gpt-5.6-luna` (`docs/api/config.md:67`) | Default model for generic text/structured calls. |
| `OPENAI_MAX_RETRIES` | `3`; `OPENAI_RETRY_BASE_MS` `500` (`docs/api/config.md:71-72`) | Rate-limit retry. |
| `OPENAI_TIMEOUT_MS`, `OPENAI_STRUCTURED_TIMEOUT_MS`, `RECEIPT_STRUCTURED_TIMEOUT_MS` ★ | — | Request timeouts. |
| `RECEIPT_FACTORY_TASK_MODEL` | `gpt-5.6-luna` (`docs/api/config.md:68`) | Codex model for Factory task workers. |
| `RECEIPT_FACTORY_OBJECTIVE_SUPERVISOR_MODEL` | `gpt-5.6-terra` (`docs/api/config.md:69`) | Objective supervisor model. |
| `RECEIPT_FACTORY_SUPERVISOR_MODEL` | unset | Backward-compatible override used when the above is unset. |
| `RECEIPT_FACTORY_PLATFORM_CODEX_MODEL` / `RECEIPT_FACTORY_PLATFORM_SUPERVISOR_MODEL` ★ | `gpt-5.6-luna` (`services/factory-model-funding.ts:9-10`) | Platform-credit model choices. |
| `RECEIPT_FACTORY_CHAT_MODEL` ★ | — | Chat-lane model override. |
| `CHAT_TITLE_GENERATION_MODEL` | unset → follows the thread model | Background title-generation model. |
| `CHAT_RECEIPT_RECAP_MODEL` ★ | `openai/gpt-5-mini` (`apps/start/src/lib/frontend/chat/chat-receipts.server.ts:3431`) | Recap model. |
| `CHAT_REQUIRE_BYOK` | `false` (`.env.example:128`) | When true, every model request must use a workspace-managed provider key. |
| `AI_GATEWAY_API_KEY` | — | **In `.env.example:123` labelled required, but production code only *deletes* it from projected sandbox env** (`packages/receipt-app/src/services/factory/lima-auth-byok.ts:75`). |
| `ANTHROPIC_API_KEY` | — | **In `.env.example:124` but read only in tests** (`model-gateway.service.test.ts:130`). |

### 5.8 OpenSandbox / Factory execution

Defaults live in
`packages/receipt-app/src/services/factory/opensandbox-config-default-values.ts`.
**None of these appear in `apps/start/.env.example`.**

| Variable | Default | Effect |
|---|---|---|
| `RECEIPT_FACTORY_EXECUTION_PATH` ★ | `computer` (`modules/factory/execution-policy.ts:46-55`) | The type is `type FactoryExecutionPath = "computer"` (`modules/factory/types.ts:87`) — there is only one path. |
| `RECEIPT_FACTORY_COMPUTER_PROVIDER` ★ | `opensandbox` (`execution-policy.ts:22-30`) | The only value. `execution-backend-computer.ts:35` throws `Unsupported Factory computer provider '<x>'. OpenSandbox is the only supported provider.` `start-all.mjs:1146-1152` warns `Ignoring unsupported Factory computer provider; using OpenSandbox.` |
| `RECEIPT_FACTORY_COMPUTER_ENABLED` ★ | derived (`true` when provider is opensandbox) | `true`/`1`/`false`/`0` force it (`execution-policy.ts:36-44`). |
| `OPEN_SANDBOX_DOMAIN` ★ | `localhost:8080` (`opensandbox-config-default-values.ts:1`); `start:all` sets `127.0.0.1:<port>` | Controller host:port. |
| `OPEN_SANDBOX_PROTOCOL` ★ | `http` | Controller scheme. |
| `OPEN_SANDBOX_IMAGE` ★ | `receiptfactory/opensandbox-worker:local` (line 3) | Guest image. Refuses the local-only default when workers use a public gateway: `OPEN_SANDBOX_IMAGE must reference a published image when Receipt workers use a public gateway.` (`opensandbox-config-env-runtime.ts:71-80`). |
| `OPEN_SANDBOX_GLOBAL_MAX_ACTIVE` ★ | `1` (`services/factory/computer-capacity-ids.ts:55-60`) | Global concurrent-lease limit. |
| `OPEN_SANDBOX_ORG_MAX_ACTIVE` ★ | `1` (line 71) | Per-organization limit. |
| `OPEN_SANDBOX_ORG_<ORG_ID>_MAX_ACTIVE` ★ | falls back to the above (lines 63-72) | Per-organization override; the org id is upper-cased with non-alphanumerics replaced by `_`. |
| `OPEN_SANDBOX_HOST_READY_TIMEOUT_MS` ★ | `180000` in code (line 11); `start:all`/`local:up` export `240000` | Host-ready budget. |
| `OPEN_SANDBOX_READY_TIMEOUT_SECONDS` ★ | `120` (line 6) | Sandbox ready budget. |
| `OPEN_SANDBOX_REQUEST_TIMEOUT_SECONDS` ★ | `120` (line 7) | SDK request timeout. |
| `OPEN_SANDBOX_TIMEOUT_SECONDS` ★ | `3600` (line 8) | Sandbox lifetime. |
| `OPEN_SANDBOX_CPU` / `OPEN_SANDBOX_MEMORY` ★ | `2` / `4Gi` (lines 9-10) | Sandbox size. |
| `OPEN_SANDBOX_TEMPLATE_VERSION` ★ | `receipt-factory-opensandbox-v1` (line 4) | Template id. |
| `OPEN_SANDBOX_REMOTE_WORKSPACE_ROOT` ★ | `/workspace/receipt-workspaces` (line 5) | Remote workspace root. |
| `OPEN_SANDBOX_HOST_IDLE_STOP_MS` ★ | `1200000` (line 12) | Idle host stop. |
| `OPEN_SANDBOX_CLEANUP_ON_FINISH` ★ | `task` (`start-all.mjs:341`) | Sandbox cleanup granularity — **per task, not per shutdown**. |
| `OPEN_SANDBOX_USE_SERVER_PROXY` / `OPEN_SANDBOX_SECURE_ACCESS` ★ | forced to `false` locally (`start-all.mjs:250-251`) | Proxy / TLS access. |
| `OPEN_SANDBOX_API_KEY` ★ | — | Controller auth. Locally the controller runs **unauthenticated** because `start-all.mjs:242` sets `OPENSANDBOX_INSECURE_SERVER=YES`. Keep port 8080 on loopback. |
| `OPEN_SANDBOX_AUTO_START` / `OPEN_SANDBOX_AUTO_STOP` / `OPEN_SANDBOX_AWS_INSTANCE_ID` / `OPEN_SANDBOX_AWS_REGION` / `OPEN_SANDBOX_SKIP_WORKSPACE_BOOTSTRAP` / `OPEN_SANDBOX_REMOTE_PATH` ★ | — | Hosted on-demand host control. |
| `OPENSANDBOX_INSECURE_SERVER` ★ | `YES` under `start:all` | Disables controller auth. Local only. |
| `RECEIPT_OPENSANDBOX_WORKSPACE_SYNC_TIMEOUT_MS` ★ | — | `validate:stack` sets `240000` for the live AWS gate (`validate-stack.sh:211`). |
| `RECEIPT_FACTORY_OPEN_SANDBOX_FAIL_ON_DEGRADED` ★ | `false` under `dev` (`dev-process-cleanup.mjs:16-17`) | Whether a degraded sandbox fails the run. |
| `RECEIPT_FACTORY_REMOTE_CODEX_STUB`, `RECEIPT_FACTORY_OBJECTIVE_SUPERVISOR_STUB`, `RECEIPT_FACTORY_VALIDATION_STUBS` ★ | `1` in the smoke suite (`run-receipt-smoke.sh:61-63`) | Deterministic stubs. `validate:stack` sets all three when `VALIDATE_STACK_CODEX_MODE=stub` and refuses conflicting combinations (`validate-stack.sh:176-197`). |
| `RECEIPT_FACTORY_OBJECTIVE_WATCHDOG_{ENABLED,CRON,TIMEOUT_MS,SCAN_LIMIT}`, `RECEIPT_FACTORY_REPO_SLOT_CONCURRENCY`, `FACTORY_OBJECTIVE_AUDIT_SYSTEM_IMPROVEMENT` ★ | — | Factory control-plane tuning. |

### 5.9 Nango / Receipt integrations

| Variable | Default | Effect |
|---|---|---|
| `RECEIPT_INTEGRATIONS_PROVIDER` ★ | `nango` (`start-all.mjs:271`) | Integrations backend. |
| `RECEIPT_INTEGRATIONS_URL` ★ | `http://127.0.0.1:3003` (`start-all.mjs:272`) | Nango API base. |
| `RECEIPT_INTEGRATIONS_SECRET_KEY` ★ | read from Postgres (`nango._nango_environments.secret_key` where `name='prod'`, `start-all.mjs:428-441`) | Nango API key. Missing → `Local Nango secret key was not found. Receipt Connect provider auth may fail.` |
| `RECEIPT_INTEGRATIONS_WEBHOOK_SECRET` ★ | `receipt-local-webhook-secret` (`start-all.mjs:273`) | Webhook signature secret. |
| `RECEIPT_INTEGRATIONS_DATABASE_URL` ★ | `postgresql://receipt:receipt@127.0.0.1:<pgPort>/receipt_integrations` (`start-all.mjs:1187-1192`) | Direct Nango DB URL for read-repair. |
| `RECEIPT_INTEGRATIONS_INTERNAL_URL`, `RECEIPT_INTEGRATIONS_CONNECT_INTERNAL_URL`, `RECEIPT_INTEGRATIONS_PUBLIC_URL` ★ | derived | Gateway routing. |
| `LOCAL_NANGO_DATABASE_URL` ★ | `postgresql://receipt:receipt@host.docker.internal:<pgPort>/receipt_integrations` (`start-all.mjs:1183-1185`) | Nango container DB URL. |
| `LOCAL_NANGO_ENCRYPTION_KEY` ★ | a fixed base64 dev key (`docker-compose.local.yml:31`, `start-all.mjs:202`) | Nango encryption key. |
| `LOCAL_NANGO_DASHBOARD_USERNAME` / `_PASSWORD` ★ | `receipt` / `receipt` (`docker-compose.local.yml:32-33`) | Nango dashboard basic auth. |
| `START_ALL_INTEGRATIONS_DATABASE_NAME` ★ | `receipt_integrations` (`start-all.mjs:93`) | Separate database Nango needs. |
| `START_ALL_RESET_INTEGRATIONS` ★ | `0` | `1` drops and recreates that database (`start-all.mjs:454-462`). |
| `START_ALL_ENSURE_NANGO_INTEGRATIONS` ★ | on | `0` skips provider reconciliation (`start-all.mjs:381`). |
| `RECEIPT_NANGO_<PROVIDER>_INTEGRATION_ID` ★ (aws, gcp, gcs, github, gitlab, jira ×2, confluence ×2, slack, notion, linear, sentry, datadog, vercel, terraform, cloudflare, azure-devops, zendesk, incident.io, google-analytics, google-ads, meta-marketing-api, youtube, airtable) | — | Per-connector Nango integration ids (`packages/receipt-app/src`). |

### 5.10 Web app service graph and gateway

| Variable | Default | Effect |
|---|---|---|
| `PORT` | gateway `3000`, internal web `3001` (`apps/start/scripts/service-gateway.ts:21-22,136-148`) | Gateway public port; the internal Nitro child gets `PORT`/`NITRO_PORT` = internal port (line 894-895). |
| `RECEIPT_WEB_INTERNAL_PORT` | `3001` (line 144) | Internal Nitro port. |
| `RECEIPT_WEB_INTERNAL_URL`, `RECEIPT_RUNTIME_INTERNAL_URL`, `RECEIPT_ZERO_INTERNAL_URL`, `RECEIPT_INTEGRATIONS_INTERNAL_URL`, `RECEIPT_INTEGRATIONS_CONNECT_INTERNAL_URL`, `RECEIPT_SLACK_INTERNAL_URL`, `RECEIPT_TEAMS_INTERNAL_URL`, `RECEIPT_RESONATE_INTERNAL_URL`, `RECEIPT_COMPUTER_INTERNAL_URL`, `RECEIPT_OPENSANDBOX_INTERNAL_URL` | set by `start-all.mjs:576-598` | Backend targets for the gateway (`service-gateway.ts:164-206`). |
| `RECEIPT_SERVICE_RUNTIME_URL`, `RECEIPT_PROXY_SERVER_URL`, `RECEIPT_SERVER_URL` | — | Runtime fallbacks in the same resolver. |
| `RECEIPT_SERVICE_GATEWAY_URL` | the resolved public gateway URL | Public gateway origin. Also used to detect a "cloud" OpenSandbox runtime (`opensandbox-config-env-runtime.ts:41-45`). |
| `RECEIPT_SERVICE_GATEWAY_EXPOSURE` / `RECEIPT_SERVICE_GATEWAY_ALLOW_PRIVATE` ★ | — | `private` / `1` allow private service routes from non-local hosts (`service-gateway.ts:212-213`). |
| `RECEIPT_BUN_IDLE_TIMEOUT_SECONDS` ★ | — | Bun server idle timeout (`service-gateway.ts:154`). |
| `RECEIPT_DEV_BACKEND_URL` / `RECEIPT_CLOUD_BACKEND_URL` ★ | — | `dev:aws` mode: proxy `/api`, `/zero`, `/connect`, `/runtime`, `/integrations`, `/integrations-connect`, `/oauth`, `/slack`, `/resonate`, `/computer` to a remote backend (`apps/start/vite.config.ts:22-52`). |
| `RECEIPT_DEV_AUTH_COOKIE`, `RECEIPT_DEV_AUTH_SESSION_LINE_FILE`, `RECEIPT_DEV_FRONTEND_URL`, `RECEIPT_DEV_ZERO_CACHE_URL` ★ | — | `dev:aws` session install helper (`vite.config.ts:167-193`). |

Gateway prefixes are stable across local and AWS (`README.md:62`):
`/runtime`, `/zero`, `/integrations`, `/connect`, `/slack`, `/teams`, `/resonate`, `/computer`.

### 5.11 Feature flags (client-visible)

Vite exposes `VITE_*` **and** `ENABLE_*` to the client
(`apps/start/vite.config.ts:349`).

| Variable | Default in code | Effect |
|---|---|---|
| `VITE_APP_INSTANCE_MODE` | `cloud` unless exactly `self_hosted` (`app-feature-flags.ts:25-28`) | `self_hosted` removes Stripe, anonymous users, and quota limits. |
| `VITE_SELF_HOST_SOURCE` | `''` | Distribution label. |
| `VITE_ENABLE_EMBEDDING` | **`true`** (`app-feature-flags.ts:55`) | `false` disables embeddings + vector retrieval globally. `.env.example:143` ships `true`; set `false` locally unless you run Qdrant. |
| `VITE_DISABLE_REDIS` | **`false`** (`app-feature-flags.ts:62`) | `true` uses an in-memory stream-resume fallback. `.env.example:153` ships `true`. |
| `VITE_CHAT_OBJECTIVE_PUSH` ★ | `true` (`app-feature-flags.ts:67`) | Render objective-backed chat turns from the objective projection. |
| `VITE_REQUIRE_SIGNUP_EMAIL_OTP` | unset | `1`/`true` re-enables the OTP step under `bun run dev`. |
| `VITE_DISABLE_EMAIL_VERIFICATION_OTP` | unset | `1`/`true` at **build time** disables OTP in the production bundle. |
| `ALLOW_USER_COST_DISPLAY` | `false` | `true` exposes AI cost to end users (BYOK requests always show cost). |
| `VITE_ENABLE_ORGANIZATION_PROVIDER_KEYS` ★ | — | Listed in `turbo.json:10` and set in CI + image builds (`scripts/build-beetle-images.mjs:55`) but **read by no application code**. |
| `ENABLE_EMBEDDING` | — | Declared in `apps/start/src/vite-env.d.ts:6` and passed through `turbo.json:51`, but **no runtime code reads the unprefixed name**. |

### 5.12 Storage, uploads and markdown conversion

`apps/start/src/lib/backend/upload/storage-config.ts`.

| Variable | Default | Effect |
|---|---|---|
| `UPLOAD_STORAGE_PROVIDER` | `cloudflare_r2` in `.env.example:88` | `cloudflare_r2` \| `s3_compatible`. |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_PUBLIC_BASE_URL` | — | Required when provider is `cloudflare_r2`. |
| `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET_NAME`, `S3_REGION` (`auto`), `S3_PUBLIC_BASE_URL` | — | Required when provider is `s3_compatible`. `S3_PUBLIC_BASE_URL` defaults to `${BETTER_AUTH_URL}/api/files/object` (signed proxy). |
| `S3_AUTH_MODE` ★ / `S3_USE_IAM_ROLE` ★ | — | `S3_AUTH_MODE=aws_default` or `S3_USE_IAM_ROLE=1` uses the ambient AWS credential chain (`storage-config.ts:130-131`). |
| `ENDPOINT`, `ACCESS_KEY_ID`, `SECRET_ACCESS_KEY`, `BUCKET`, `REGION` ★ | — | Unprefixed aliases accepted by `storage-config.ts` and passed through `turbo.json:34-38`. |
| `CF_MARKDOWN_WORKER_URL`, `CF_MARKDOWN_WORKER_TOKEN` | — | Required for file→markdown conversion. |
| `CF_MARKDOWN_WORKER_TIMEOUT_MS` | `20000` (`.env.example:113`) | Conversion timeout. |
| `CF_MARKDOWN_MAX_CHARS` | `120000` (`.env.example:116`) | Max markdown characters per file. |

### 5.13 Redis, Qdrant, rate limits, billing, analytics

| Variable | Default | Effect |
|---|---|---|
| `REDIS_URL` | — | Rate limiting + chat stream resume. `local:up` writes `redis://localhost:<START_ALL_REDIS_PORT>` (`local-up.sh:207`). |
| `QDRANT_URL`, `QDRANT_API_KEY` | — | Vector store; required when `VITE_ENABLE_EMBEDDING=true`. `start-all.mjs:139-143` warns: *"VITE_ENABLE_EMBEDDING=true but QDRANT_URL is empty. The core stack will start, but attachment vector indexing/retrieval remains unavailable until Qdrant is configured."* |
| `QDRANT_COLLECTION_ATTACHMENTS` | `attachment_chunks_v1` | Collection name. |
| `QDRANT_TIMEOUT_MS` | `5000` | Request timeout. |
| `QDRANT_UPSERT_BATCH_SIZE` | `128` | Batch size. |
| `FREE_CHAT_RATE_LIMIT_WINDOW_MS` ★ | `60000` | `apps/start/src/lib/backend/access-control/index.ts:34-39`. |
| `FREE_CHAT_RATE_LIMIT_MAX_REQUESTS` ★ | `10` | same |
| `PAID_CHAT_RATE_LIMIT_WINDOW_MS` ★ | `60000` | same |
| `PAID_CHAT_RATE_LIMIT_MAX_REQUESTS` ★ | `30` | same |
| `FREE_CHAT_ALLOWANCE_WINDOW_MS` ★ | `86400000` | same |
| `FREE_CHAT_ALLOWANCE_MAX_REQUESTS` ★ | `100` | same |
| `RECEIPT_CHAT_CHAIN_TIMEOUT_MS` ★ | — | `apps/start/src/lib/backend/chat/services/receipt-chat.service.ts:140`. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | — | Billing. |
| `STRIPE_PRICE_PLUS_MONTHLY`, `STRIPE_PRICE_PRO_MONTHLY`, `STRIPE_PRICE_SCALE_MONTHLY` | — | Read indirectly through `plan.stripePriceEnvKey` (`apps/start/src/lib/shared/access-control/index.ts:105,114,124,234,264`). Missing value → `Missing required environment variable <KEY>`. |
| `WORKSPACE_USAGE_TARGET_MARGIN_PERCENT` and the `_PLUS_`/`_PRO_`/`_SCALE_`/`_ENTERPRISE_` variants | — | Built dynamically as `WORKSPACE_USAGE_${PLAN}_${SUFFIX}` with a fallback to `WORKSPACE_USAGE_${SUFFIX}` (`billing/services/workspace-usage/shared.ts:73-81`). Must parse as a number in 0..100. |
| `POSTHOG_PROJECT_API_KEY`, `POSTHOG_HOST` | host defaults to PostHog Cloud US | Chat error observability. |
| `POSTHOG_PROJECT_ID`, `POSTHOG_PERSONAL_API_KEY` | — | Source-map upload; `.env.example:229-231` notes `getPostHogSourceMapConfig()` **is not wired into the build yet**, so these are currently inert. |

### 5.14 Slack / Teams

| Variable | Read by | Effect |
|---|---|---|
| `SLACK_SIGNING_SECRET` | `apps/slack` | Request signature verification. |
| `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_API_BASE_URL` ★ | `apps/slack` | OAuth install flow. |
| `SLACK_DEFAULT_PROFILE_ID`, `SLACK_PROGRESS_UPDATE_INTERVAL_MS`, `SLACK_MAX_PROGRESS_MESSAGES_PER_RUN` | `apps/slack` | Behaviour tuning. |
| `TEAMS_DEFAULT_PROFILE_ID`, `CLIENT_ID`, `CLIENT_SECRET`, `TENANT_ID`, `RECEIPT_WEB_URL` ★ | `apps/teams` | Azure bot config. |
| `APP_URL` ★ | `apps/slack` | Public Slack app URL; `start-all.mjs:549` sets `${publicGatewayUrl}/slack`. |
| `SLACK_BOT_TOKEN` | — | In `.env.example:244` and passed into containers by `sst.config.ts:864` / `deploy/sst/single-host.ts:483`, but **no application code reads it**. |
| `SLACK_PRIMARY_TEAM_ID`, `SLACK_PRIMARY_RECEIPT_ORG_ID`, `SLACK_ALLOWED_TEAM_IDS` | — | **In `.env.example` but read by no code.** |

### 5.15 Supervisor / tooling variables (all ★ — none are in `.env.example`)

`START_ALL_*` (from `scripts/start-all.mjs`):

| Variable | Default | Effect |
|---|---|---|
| `START_ALL_GATEWAY_PORT` | `START_ALL_WEB_PORT` → `3000` | Public gateway port. |
| `START_ALL_WEB_PORT` | `3000` | Public web port (also the gateway default). |
| `START_ALL_WEB_INTERNAL_PORT` | `3001` | Internal Nitro port. |
| `START_ALL_ZERO_CACHE_PORT` | `4848` | zero-cache port (port + 1 is also preflighted). |
| `START_ALL_RECEIPT_PORT` | `8787` | Runtime port. |
| `START_ALL_SLACK_PORT` | `3010` | Slack app port. |
| `START_ALL_TEAMS_PORT` | `3011` | Teams app port. |
| `START_ALL_REDIS_PORT` | `6380` | Host port for the Redis container. |
| `START_ALL_INTEGRATIONS_PORT` | `3003` | Nango API port. |
| `START_ALL_INTEGRATIONS_CONNECT_PORT` | `3009` | Nango Connect UI port. |
| `START_ALL_RESONATE_PORT` | `8001` | Resonate broker port. |
| `START_ALL_RESONATE_METRICS_PORT` | `9090` | Resonate metrics port. |
| `START_ALL_OPENSANDBOX_PORT` | `8080` | OpenSandbox controller port. |
| `START_ALL_POSTGRES_PORT` | from `ZERO_UPSTREAM_DB`'s port when host is localhost, else `5432` (`start-all.mjs:1163-1178`) | Host port published by the Postgres container. |
| `START_ALL_POSTGRES` | on | `0` skips the Postgres container. |
| `START_ALL_LOCAL_INFRA` | on | `0` skips Redis + Nango. |
| `START_ALL_OPENSANDBOX` | on | `0` skips the controller. |
| `START_ALL_SLACK` / `START_ALL_TEAMS` | on | `0` skips those children. |
| `START_ALL_MARKDOWN_WORKER` | off | `1` also runs `worker:dev`. |
| `START_ALL_BUILD_WEB` | on | `0` reuses `apps/start/.output/server/index.mjs` if present. |
| `START_ALL_USE_SIGNUP_EMAIL_OTP` | off | `1` keeps signup email OTP in the production build. |
| `START_ALL_WAIT_TIMEOUT_SECONDS` | `120` | Readiness budget for every wait. |
| `START_ALL_PUBLIC_HTTP_HOST` | `localhost` | Host used in the public gateway URL and health probes. |
| `START_ALL_PUBLIC_GATEWAY_URL` | `http://<host>:<gatewayPort>` | Overrides the browser-facing origin. |
| `START_ALL_WORKER_GATEWAY_URL` | derived | Overrides the sandbox-reachable gateway. |
| `START_ALL_ENV_FILE` / `START_ALL_ENV_FILES` | — | Extra env files (single path / comma list). |
| `START_ALL_LOG_ROOT` | `.deploy-artifacts/start-all` | Log root. |
| `START_ALL_RECEIPT_POSTGRES_SCHEMA` | `public` | Shared Receipt schema for the integrated stack. |
| `START_ALL_RECEIPT_SCHEMA_MIGRATION` | on | `0` skips the durable-schema pre-migration. |
| `START_ALL_RECEIPT_SCHEMA_TIMEOUT_SECONDS` | `360` | Pre-migration timeout. |
| `START_ALL_ZERO_PUBLICATION_TIMEOUT_SECONDS` | `120` | Publication-refresh timeout. |
| `START_ALL_OPENSANDBOX_CONFIG_DIR` | `<root>/.opensandbox` | Controller config dir. |
| `START_ALL_OPENSANDBOX_CONFIG` | `<dir>/sandbox.toml` | Controller config path. |
| `START_ALL_OPENSANDBOX_INIT_CONFIG` | off | `1` regenerates the config even if it exists. |
| `START_ALL_OPENSANDBOX_BUILD_IMAGE` | on | `0` skips building the `:local` guest image. |
| `START_ALL_INTEGRATIONS_DATABASE_NAME` | `receipt_integrations` | Nango's database. |
| `START_ALL_RESET_INTEGRATIONS` | `0` | `1` drops+recreates it. |
| `START_ALL_ENSURE_NANGO_INTEGRATIONS` | on | `0` skips provider reconciliation. |

`LOCAL_UP_*` (from `scripts/local-up.sh:21-26`, documented by `local:up --help`):

| Variable | Default | Effect |
|---|---|---|
| `LOCAL_UP_DB_RESET` | `auto` | `auto` \| `1` \| `0`. Anything else fails with `Unsupported LOCAL_UP_DB_RESET='<x>'. Use auto, 1, or 0.` |
| `LOCAL_UP_BUILD_WEB` | `1` | Maps to `START_ALL_BUILD_WEB`. |
| `LOCAL_UP_ZERO_UPSTREAM_DB` | `postgresql://receipt:receipt@localhost:5432/receipt` | Overrides the local Postgres URL. |
| `LOCAL_UP_PROVIDER` | `opensandbox` | Same as the positional argument. |
| `LOCAL_UP_LOG_ROOT` | `.deploy-artifacts/local-up` | Artifact root. |
| `LOCAL_UP_RESET_INTEGRATIONS` | `0` | Maps to `START_ALL_RESET_INTEGRATIONS`. |
| `LOCAL_UP_RUNTIME_ENV_FILE` | written as `1` | Marker that lets `start-all.mjs` write hydrated Nango values back into the generated env file (`start-all.mjs:281-299`). |

`dev`-only:

| Variable | Default | Effect |
|---|---|---|
| `PORT` | `3000` (`dev-with-receipt.mjs:52`) | Vite dev server port. |
| `RECEIPT_PORT` | `8787` (line 53) | Runtime port. |
| `TANSTACK_DEVTOOLS_PORT` | `42069` (line 56) | Devtools port — preflighted for conflicts. |
| `START_DEV_POSTGRES` | on | `0` skips starting the Postgres container (line 84). |

Mock LLM proxy: `RECEIPT_MOCK_LLM_PORT` (`8789`), `RECEIPT_MOCK_LLM_HOST`
(`127.0.0.1`), `RECEIPT_MOCK_LLM_TEXT`, `RECEIPT_MOCK_LLM_FAILURES`,
`RECEIPT_MOCK_LLM_SCRIPT`, `RECEIPT_MOCK_LLM_TIMEOUT_MS` (`120000`) — see §6.

Smoke suite: `RECEIPT_SMOKE_TIMEOUT_MS` (`240000`, `run-receipt-smoke.sh:140`).

Simulations: `SIM_OUTPUT`, `SIM_REPEAT` (`2`), `SIM_PROD_REPLAY_INPUT`
(`packages/receipt-app/package.json:57-60`).

Toolchain: `RECEIPT_BUN_BIN`, `BUN_BIN`, `BUN_INSTALL`, `RECEIPT_BUN_AUTO_INSTALL`,
`RECEIPT_NPM_BIN`.

`VALIDATE_STACK_*`: see §7.4.

### 5.16 Variables in `.env.example` that no code reads

Verified by repo-wide grep excluding `node_modules`, `.git` and the env files
themselves:

| Variable | `.env.example` line | Status |
|---|---|---|
| `ANTHROPIC_API_KEY` | 124 | Only in Vitest `vi.stubEnv` calls. |
| `AI_GATEWAY_API_KEY` | 123 | Only *removed* from projected sandbox env (`services/factory/lima-auth-byok.ts:75`). |
| `AUTH_DEV_EMAIL_OTP_TO_CONSOLE` | 48 | Appears nowhere else in the repo. Do not expect console OTPs. |
| `RECEIPT_POSTGRES_MIRROR_URL` | 65 | Appears nowhere else. |
| `SLACK_PRIMARY_TEAM_ID` | 247 | Appears nowhere else. |
| `SLACK_PRIMARY_RECEIPT_ORG_ID` | 250 | Appears nowhere else. |
| `SLACK_ALLOWED_TEAM_IDS` | 253 | Appears nowhere else. |
| `SLACK_BOT_TOKEN` | 244 | Only injected into containers by the deploy configs; no reader. |
| `STRIPE_PRODUCT_ENTERPRISE` | 199 | Appears nowhere else. |
| `VITE_STRIPE_PUBLISHABLE_KEY` | 194 | Appears nowhere else. |

### 5.17 Variables read by code but missing from `.env.example`

Every entry marked ★ in §5.1–§5.15. The ones a local developer is most likely to
need:

`OPENAI_API_KEY`, `OPENAI_BASE_URL`, `MOCK_OPENAI_API_KEY`, `RECEIPT_REPO_KEY`,
`DATA_DIR` / `RECEIPT_DATA_DIR`, `RECEIPT_POSTGRES_SCHEMA`,
`RECEIPT_SERVER_WATCH`, every `RESONATE_*`, every `OPEN_SANDBOX_*`,
every `RECEIPT_FACTORY_*`, every `RECEIPT_INTEGRATIONS_*`, every `LOCAL_NANGO_*`,
every `START_ALL_*`, every `LOCAL_UP_*`, every `VALIDATE_STACK_*`,
`START_DEV_POSTGRES`, `TANSTACK_DEVTOOLS_PORT`, `ZERO_REPLICA_FILE`,
`ZERO_PUBLICATION_EXTRA_TABLES`, `SELF_HOSTED_SETUP_TOKEN`,
`BETTER_AUTH_USE_SECURE_COOKIES`, `RECEIPT_PUBLIC_BASE_URL`,
`ADMIN_EMAIL_ALLOWLIST`, `S3_AUTH_MODE`, `S3_USE_IAM_ROLE`,
the `FREE_CHAT_*` / `PAID_CHAT_*` rate-limit knobs, and `CHAT_RECEIPT_RECAP_MODEL`.

### 5.18 Turbo's strict env mode

`turbo.json:3` sets `"envMode": "strict"`. Only the variables in `globalEnv`
(lines 4-12) and `globalPassThroughEnv` (lines 13-77) reach turbo-run tasks.
`globalEnv` is `NODE_ENV`, `VITE_APP_INSTANCE_MODE`, `VITE_BETTER_AUTH_URL`,
`VITE_SELF_HOST_SOURCE`, `VITE_ZERO_CACHE_URL`,
`VITE_ENABLE_ORGANIZATION_PROVIDER_KEYS`, `VITE_DISABLE_REDIS` — these participate
in cache keys. `build` and `dev` also list `.env`, `.env.local`, `.env.production`,
`.env.development`, `.env.*` as task inputs (lines 82-100), so editing an env file
busts the build cache.

`globalPassThroughEnv` still carries a large block of variables from an upstream
template that this codebase no longer reads at all: `WORKOS_*`, `AUTUMN_*`,
`VALYU_API_KEY`, `SUPERMEMORY_API_KEY`, `KV_REST_API_*`, `NEXT_PUBLIC_*`,
`DUB_API_KEY`, `ADMIN_EMAILS`, `XAI_API_KEY`, `MISTRAL_API_KEY`,
`MOONSHOTAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`. Do not document these as
supported configuration.

---

## 6. The mock LLM proxy and offline development

`./bunw run llm:mock` → `node ./scripts/mock-llm-proxy.mjs` (`package.json:20`).

**What it is.** A dependency-free Node HTTP server implementing the subset of the
OpenAI API that `packages/receipt-app` uses. On boot it prints exactly
(`scripts/mock-llm-proxy.mjs:513-519`):

```
Receipt mock LLM proxy listening on http://127.0.0.1:8789/v1
Use OPENAI_BASE_URL=http://127.0.0.1:8789/v1 MOCK_OPENAI_API_KEY=mock-key
```

**Endpoints** (`scripts/mock-llm-proxy.mjs:478-511`):

| Method + path | Behaviour |
|---|---|
| `GET /health` | `{"ok":true,"service":"receipt-mock-llm-proxy","responses":<count>}` |
| `POST /v1/responses` | OpenAI Responses API. Honours `stream: true` with SSE, and structured output via `body.text.format` JSON Schema. |
| `WS upgrade /v1/responses` | WebSocket transport for the same API (lines 505-511, 340-415). Falls back to a default response after 2 s of silence. |
| `POST /v1/embeddings` | Deterministic 16-dimension embeddings derived from a SHA-256 of the input; supports `encoding_format: "base64"` (lines 452-465). |
| anything else | `404 {"error":{"message":"No mock route for <METHOD> <path>"}}` |

**Structured output synthesis.** For a JSON Schema it walks `const` → `enum` →
`anyOf`/`oneOf` → object/array/boolean/number/null, and for strings picks a value
by keyword (`thought`, `summary`, `title`, `reason`, `text`/`answer`, `input`)
(lines 57-98). Two schema names get hand-written shapes: `FactoryChatTurnAnalysis`
and `agent_action` (lines 101-115).

**Configuration:**

| Variable / flag | Default | Effect |
|---|---|---|
| `--port` / `RECEIPT_MOCK_LLM_PORT` | `8789` | Listen port. |
| `--host` / `RECEIPT_MOCK_LLM_HOST` | `127.0.0.1` | Bind address. |
| `RECEIPT_MOCK_LLM_TEXT` | `Mock model response.` | Default answer text. |
| `--script` / `RECEIPT_MOCK_LLM_SCRIPT` | — | Path to a JSON array of fixture responses; each entry may carry `match` (a substring, or `{schemaName, includes}`), `text`, `status`, `delayMs` (lines 25-28, 117-131). |
| `RECEIPT_MOCK_LLM_FAILURES` | — | Comma list consumed **one per call**: `429`, `500`, any three-digit status, `malformed`, `timeout` (lines 19-23, 416-440). |
| `RECEIPT_MOCK_LLM_TIMEOUT_MS` | `120000` | How long `timeout` mode hangs (line 442). |

**Wiring it up.** In the runtime env:

```bash
OPENAI_BASE_URL=http://127.0.0.1:8789/v1
MOCK_OPENAI_API_KEY=mock-openai-key   # optional; see below
```

`resolveLocalMockOpenAiApiKey` (`packages/receipt-app/src/services/receipt-openai-env.ts:68-74`)
returns `MOCK_OPENAI_API_KEY` or, if unset, the literal `mock-openai-key` — but
**only when `OPENAI_BASE_URL`'s hostname is `localhost`, `127.0.0.1` or `::1`**
(lines 52-60). The comment states the reason: *"Keep this fallback loopback-only so
production BYOK resolution cannot silently degrade into process-wide credentials."*
When the mock key is used, `readOrgOpenAiByokApiKey` short-circuits Postgres and
logs a JSON line with `"source":"local_mock_openai_proxy"` (lines 90-102).

Note the string mismatch to record in docs: the proxy prints
`MOCK_OPENAI_API_KEY=mock-key`, while the code's default is `mock-openai-key` and
`DEVELOPMENT.md:140` / `LOCAL_SETUP.md` say `mock-openai-key`. The value is
irrelevant (the proxy ignores the bearer), but the docs should not quote two
different strings without explaining that any value works.

The proxy has its own test suite, `tests/integration/mock-llm-proxy.test.ts`, run
in a fresh Bun process by `run-receipt-smoke.sh:147` because it mutates
process-wide OpenAI endpoint state.

---

## 7. Testing and checks

### 7.1 The check pyramid

| Command | Definition | What it runs |
|---|---|---|
| `./bunw run lint` | `turbo run lint` (`package.json:48`) | `apps/start` ESLint with `--max-warnings=0` (`apps/start/package.json:28`) and `apps/teams` `tsc --noEmit`. `packages/ui`, `packages/utils`, `apps/slack` define no `lint` script. |
| `./bunw run check` | `bun run check:fast` (`package.json:49`) | alias |
| `./bunw run check:fast` | `package.json:50` | `lint` → `sst:config:test` → `--cwd apps/start check-types` → `--cwd apps/teams test` → `receipt:check` |
| `./bunw run check:full` | `package.json:51` | `check:fast` → `build` (`build:web` + `build:receipt`) |
| `./bunw run receipt:check` | `package.json:66` | `receipt:check-types` → `receipt:test` → `receipt:simulate:repeat` |
| `./bunw run receipt:check-types` | `package.json:64` | `tsc --noEmit` in `receipt-core`, `-durable`, `-live`, `-dst`, `receipt-app` |
| `./bunw run receipt:test` | `package.json:65` | `bun test ./src` in `receipt-core`, `-durable`, `-live`, `-dst`, `receipt-app` |
| `./bunw run sst:config:test` | `package.json:37` | 17 explicitly named Bun test files under `deploy/sst/`, `scripts/` and `tests/smoke/validate-stack.test.ts` — the deployment/config contract suite. |
| `./bunw run --cwd apps/start test` | `apps/start/package.json:27` | Vitest (`vitest run`) over `src/**/*.test.ts(x)` (`apps/start/vitest.config.ts`). A `pretest` hook recompiles i18n (`apps/start/package.json:26`). |
| `./bunw run --cwd apps/start check-types` | `tsc --noEmit` | |
| `./bunw run receipt:test:smoke` | `package.json:72` → `bash ./scripts/run-receipt-smoke.sh` | `bun run build`, then `bun test ./tests/smoke --max-concurrency=1 --timeout=$RECEIPT_SMOKE_TIMEOUT_MS`, then `tests/integration/mock-llm-proxy.test.ts` in a fresh process. 64 files in `tests/smoke`. |
| `./bunw run receipt:test:perf` | `package.json:99` → `bun test ./tests/perf` | `tests/perf/stream-100k.test.ts` — replays 100 000 receipts through the Postgres store. **Skips itself** unless `RECEIPT_TEST_POSTGRES_URL` or `ZERO_UPSTREAM_DB` is set (`tests/perf/stream-100k.test.ts:16-32`). |
| `./bunw run validate:stack` | `package.json:23` → `bash ./scripts/validate-stack.sh` | See §7.4. |

**`check:fast` does NOT run `apps/start`'s Vitest suite, `tests/smoke`, or
`tests/perf`.** It only typechecks `apps/start`. That is an important expectation to
set for contributors. `AGENTS.md:189` also notes *"Current state: there are
few/no committed app tests yet"* — but `apps/start/src` does now contain many
`*.test.ts` files, so treat that sentence as stale.

**`bunfig.toml` sets `[test] root = "tests"`**, so a bare `bun test` at the repo
root runs only the repo-level smoke/perf suites, not workspace unit tests. Use the
workspace-scoped scripts.

### 7.2 The simulation suites

`packages/receipt-app/package.json:57-61`, exposed at the root as
`package.json:92-96`.

| Command | Underlying CLI invocation |
|---|---|
| `receipt:simulate` | `factory simulate search --corpus default --json --output-file ${SIM_OUTPUT:-/tmp/receipt-sim-search.json}` |
| `receipt:simulate:corpus` | same, `--corpus-only` |
| `receipt:simulate:repeat` (part of `receipt:check`) | `--input ${SIM_PROD_REPLAY_INPUT:-src/services/factory/sims/fixtures/prod-replay-smoke} --repeat ${SIM_REPEAT:-2} --require-property all` |
| `receipt:simulate:nightly` | same input, `--profile nightly --require-property all` |
| `receipt:simulate:ui` | `bun src/factory-cli/simulator-ui.ts` — a local web UI on `RECEIPT_SIMULATOR_UI_PORT` (default `4397`) |

Deterministic simulation testing lives in `packages/receipt-dst`
(`docs/receipt-dst.md`).

### 7.3 `receipt doctor`

```bash
./bunw run receipt:cli -- doctor     # human-readable
./bunw run receipt:doctor            # same checks, --json (package.json:71)
```

Both go through `./.receipt/bin/receipt` (`package.json:61,71`), a POSIX shell
wrapper that `cd`s to the repo root, exports `RECEIPT_REPO_ROOT` and
`RECEIPT_REPO_KEY`, resolves Bun (`RECEIPT_BUN_BIN` → `BUN_BIN` → `PATH` →
`$BUN_INSTALL/bin/bun` → `~/.bun/bin/bun`) and runs
`packages/receipt-app/src/cli.ts` directly from TypeScript
(`.receipt/bin/receipt:1-55`). Missing Bun prints
`receipt CLI requires Bun. Set RECEIPT_BUN_BIN or install Bun on PATH.`

Exact text output (`packages/receipt-app/src/cli/doctor.ts:438-460`):

```
doctor: ok|blocked
cwd: <cwd>
repo root: <root>
data dir: <resolved DATA_DIR>
factory config: <path>|missing (<path>)
provider auth: organization BYOK required
bun: <path> (<version>)
git: <path> (<version>)
gh: <path> (<gh auth summary>)
aws: <path> (<sts summary>)
codex: <path> (<version>)
repo status: <branch> clean|dirty (<n> changed)
remotes: origin=<url>
blocking issues:
- <issue>
warnings:
- <warning>
```

Blocking issue strings (lines 381-387):
`bun unavailable: <err>`, `git unavailable: <err>`,
`codex unavailable: <err>`, `repo invalid: <err>`.

Warning strings (lines 388-392):
`Factory config missing at <path>`,
`GitHub auth unavailable: <err|gh auth status failed>`,
`AWS auth unavailable: <err|aws sts get-caller-identity failed>`.

`doctor` reports `execution.path` and `execution.computerProvider` from the
execution policy, and it deliberately does **not** validate a model key.

`.receipt/config.json` is the Factory config it looks for. Checked-in contents:
`repoRoot: "."`, `dataDir: ".receipt/data"`, `codexBin: "codex"`,
`defaultChecks: ["bun run check"]`, plus a default policy (concurrency 20 active
tasks; budgets 50 task runs, 4 candidate passes/task, 8 reconciliation tasks,
1440 objective minutes; throttles 10 dispatches/react, 15 s mutation cooldown;
`aggressiveness: "balanced"`; `autoPromote: true`).

### 7.4 `validate:stack`

`bash ./scripts/validate-stack.sh`, with `--help`/`-h` printing the usage block at
`scripts/validate-stack.sh:2336-2375`.

**Prerequisites** (`require_validation_prereqs`, lines 1348-1361):
`bun`, `node`, `curl`, `python3`, `mktemp`, plus an executable
`.receipt/bin/receipt` (`Receipt CLI wrapper is missing at .receipt/bin/receipt`).
When `VALIDATE_STACK_START=1` it additionally requires `npm`, `uvx`, ≥ 8 GiB free
disk, and a responsive Docker daemon.

**Flow** (`main`, lines 2378-2421):

1. load env files, resolve options, apply runtime defaults;
2. resolve the validation auth context; reset the validator Receipt schema;
3. optionally start `bun ./scripts/start-all.mjs` in the background
   (`exec`ed so the tracked PID is the real supervisor — RCA-209);
4. wait for `<web>/health`, `<zero>/`, `<runtime>/healthz`, `<runtime>/readyz`;
5. record `web-health.json`, `zero-cache-health.json`, `receipt-health.json`,
   `receipt-readiness.json`, `app-sign-in.html` (from `/auth/sign-in`, redirects
   allowed), `receipt-browser.html` (from `/receipt`), `factory.html`
   (from `/factory`);
6. seed an isolated validation actor; run the OpenAI BYOK preflight; run the
   Nango auth check; optionally import a local AWS connection; run the AWS
   credential preflight;
7. `receipt doctor --json` → `receipt-doctor.json`;
8. optional Factory objective, AWS negative/negative-direct/positive-direct
   objectives, then the authenticated chat smoke; print a summary.

Artifacts land under `.deploy-artifacts/validate-stack/<runId>/`
(`VALIDATE_STACK_LOG_ROOT` overrides the root).

**Isolation** (lines 217-228). When the validator starts the stack itself and
neither `RECEIPT_DATA_DIR` nor `DATA_DIR` is set, it uses a per-run data dir
`<runDir>/receipt-data`, a reusable Postgres schema
`receipt_validate_stack`, and an isolated `ZERO_REPLICA_FILE` inside that data dir
— the last of these because a shared `apps/start/zero.db` retains DDL from earlier
schema lifecycles and Zero exits when it replays `CREATE TABLE` into a replica that
already has the table (RCA-499, `docs/agent-fix-checklist.md:20132`).
`reset_validator_receipt_schema` runs `CREATE SCHEMA IF NOT EXISTS` and then
`TRUNCATE … RESTART IDENTITY CASCADE` (lines 232-296).

**Environment flags** (defaults from the code, help text at lines 2336-2375):

| Variable | Default | Effect |
|---|---|---|
| `VALIDATE_STACK_START` | `0` | `1` starts `start:all` in the background first. |
| `VALIDATE_STACK_ENV_FILE` / `VALIDATE_STACK_ENV_FILES` | — | Extra env files. |
| `VALIDATE_STACK_WEB_URL` | `http://localhost:${START_ALL_WEB_PORT:-3000}` | Web base URL. |
| `VALIDATE_STACK_ZERO_CACHE_URL` | `http://127.0.0.1:${START_ALL_ZERO_CACHE_PORT:-4848}` | zero-cache base URL. |
| `VALIDATE_STACK_RECEIPT_URL` | `http://127.0.0.1:${START_ALL_RECEIPT_PORT:-8787}` | Runtime base URL. |
| `VALIDATE_STACK_WAIT_TIMEOUT_SECONDS` | `900` | Readiness budget. |
| `VALIDATE_STACK_WAIT_PROGRESS_SECONDS` | `30` | Progress log cadence (0 disables). |
| `VALIDATE_STACK_MIN_FREE_DISK_MB` | `8192` | Free-disk floor. |
| `VALIDATE_STACK_DISK_TARGET` | repo root | Path measured for free disk. |
| `VALIDATE_STACK_DOCKER_TIMEOUT_SECONDS` | `15` | Bounded `docker info` probe. |
| `VALIDATE_STACK_CODEX_MODE` | `real` | `stub` sets the three Factory stub flags; `real` refuses to run if any stub flag is `1`. `stub` is **not** a deploy gate. |
| `VALIDATE_STACK_FACTORY_RUN` | `0` | `1` runs a real non-mutating Factory objective plus investigation capture. |
| `VALIDATE_STACK_FACTORY_TIMEOUT_SECONDS` / `_AUDIT_TIMEOUT_SECONDS` | — / `120` | Objective + terminal-audit budgets. |
| `VALIDATE_STACK_FACTORY_MAX_RECEIPTS` / `_MAX_JOBS` | `80` / `3` | Receipt-budget assertion. |
| `VALIDATE_STACK_OPENAI_API_KEY` | — | Seeds an organization OpenAI BYOK row for this run. |
| `VALIDATE_STACK_AWS_NEGATIVE_RUN` / `_NEGATIVE_DIRECT_RUN` | `0` | Objectives that must block cleanly without AWS credentials. |
| `VALIDATE_STACK_AWS_NEGATIVE_TIMEOUT_SECONDS` | `300` | Budget for those. |
| `VALIDATE_STACK_AWS_POSITIVE_DIRECT_RUN` | `0` | A live read-only AWS objective. |
| `VALIDATE_STACK_AWS_POSITIVE_PREFLIGHT` | `1` | Fetch the Connect AWS bundle and run `sts get-caller-identity` locally first. |
| `VALIDATE_STACK_AWS_POSITIVE_GATEWAY_URL` | — | Worker-reachable gateway for that objective. |
| `VALIDATE_STACK_AWS_IMPORT_PROFILE` | — | Import a local AWS profile into local Receipt Connect. |
| `VALIDATE_STACK_CHAT_SMOKE` | `auto` | `0` \| `1` \| `auto` authenticated `/api/chat` smoke. |
| `VALIDATE_STACK_CHAT_EMAIL` / `_PASSWORD` / `_MODEL` | — | Credentials/model for that smoke. |
| `VALIDATE_STACK_NANGO_HEALTH` | `auto` | `0` \| `1` \| `auto` authenticated Receipt Connect Nango health. |
| `VALIDATE_STACK_ISOLATED_DATA_DIR` | `1` | `0` reuses your normal data dir/schema. |
| `VALIDATE_STACK_RECEIPT_POSTGRES_SCHEMA` | `receipt_validate_stack` | Validator schema name. |
| `VALIDATE_STACK_RESET_RECEIPT_SCHEMA` | `1` | `0` skips the truncate. |
| `VALIDATE_STACK_RESET_START_POSTGRES` | `1` | `0` skips starting Postgres before the schema reset. |
| `VALIDATE_STACK_ZERO_REPLICA_FILE` | `<dataDir>/zero.db` | Override the isolated replica. |
| `VALIDATE_STACK_ACTOR_USER_ID` / `_ORGANIZATION_ID` / `_WORKSPACE_ID`, `VALIDATE_STACK_BYOK_ORGANIZATION_ID` / `_WORKSPACE_ID` | — | Pin the validation actor/BYOK scope. |
| `VALIDATE_STACK_LOG_ROOT` | `.deploy-artifacts/validate-stack` | Artifact root. |

The documented "real local Factory gate" before an AWS deploy
(`AGENTS.md:81-88`, `README.md:139-145`):

```bash
VALIDATE_STACK_START=1 \
VALIDATE_STACK_FACTORY_RUN=1 \
VALIDATE_STACK_AWS_POSITIVE_DIRECT_RUN=1 \
VALIDATE_STACK_AWS_IMPORT_PROFILE=<local-aws-profile> \
VALIDATE_STACK_CODEX_MODE=real \
./bunw run validate:stack
```

### 7.5 Health endpoints

| Endpoint | Response | Source |
|---|---|---|
| `GET http://localhost:3000/health` | `{"ok":true}` (200); `HEAD` returns 200 empty | `apps/start/src/routes/health/route.tsx` |
| `GET http://localhost:4848/` | zero-cache liveness | probed by `start-all.mjs:611`, `validate-stack.sh:2396` |
| `GET http://localhost:8787/healthz` | 200 with `ok`, `ready`, `degraded`, `uptimeSec`, `dataDir`, `processRole`, `queue`, `postgres`, `codexBin`, `resonateUrl` | `packages/receipt-app/src/server/bootstrap.ts:2718-2733` |
| `GET http://localhost:8787/readyz` | **200 or 503** with `ok`, `ready`, `degraded`, `uptimeSec`, `processRole`, `postgres` | `bootstrap.ts:2736-2746` |
| `GET http://127.0.0.1:8080/health` | OpenSandbox controller | `start-all.mjs:243` |
| `GET http://localhost:3003/` | Nango API | `start-all.mjs:205` |
| `GET http://localhost:3009/` | Nango Connect UI | `start-all.mjs:206` |
| gateway `GET /runtime/healthz`, `/zero/`, `/integrations/…` | proxied | `service-gateway.ts` |

**Check `/readyz`, not just `/healthz`.** `healthz` always returns 200 and reports
readiness in the body; `readyz` returns 503 when not ready. `validate:stack` waits
on both (`validate-stack.sh:2397-2398`).

Nango caveat from the checklist (`docs/agent-fix-checklist.md:64-67`, RCA-138):
`GET /integrations/health` must return Nango's JSON health response;
`GET /integrations-connect/` only proves the static Connect UI is serving.

### 7.6 What CI runs on a pull request

`.github/workflows/ci.yml`. Triggers: every `pull_request`, and `push` to `main`.
Concurrency group `ci-v2-${{ github.ref }}` with `cancel-in-progress: true`.
Job `Verify` on `ubuntu-latest`, 45-minute job timeout.

Service container: **`postgres:17`** with `POSTGRES_USER/PASSWORD/DB = receipt`
on port 5432 and a `pg_isready` healthcheck. (Local compose uses
`postgres:16-alpine` — a version skew worth documenting.)

Workflow env: `CI=true`, `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24=true`,
`NODE_ENV=production`, `VITE_APP_INSTANCE_MODE=self_hosted`,
`VITE_SELF_HOST_SOURCE=render`, `VITE_BETTER_AUTH_URL=http://localhost:3000`,
`VITE_ZERO_CACHE_URL=http://localhost:4848`, `VITE_ENABLE_EMBEDDING=false`,
`VITE_ENABLE_ORGANIZATION_PROVIDER_KEYS=true`, `VITE_DISABLE_REDIS=false`,
`ALLOW_USER_COST_DISPLAY=true`, a placeholder `BETTER_AUTH_SECRET`, and
`ZERO_UPSTREAM_DB=postgresql://receipt:receipt@localhost:5432/receipt`.

Steps:

1. `actions/checkout@v4`
2. `oven-sh/setup-bun@v2` with `bun-version: 1.3.12`
3. `actions/setup-node@v4` with `node-version-file: .node-version`
4. cache `~/.bun/install/cache` keyed on `bun.lock`
5. cache `.turbo/cache`
6. `bun install --frozen-lockfile`
7. `bun run toolchain:check`
8. `bun run --cwd apps/start i18n:compile`
9. `bun run check:fast` (15-minute step timeout)

So a PR is gated on lint + `sst:config:test` + `apps/start` typecheck +
`apps/teams` tests + the whole `receipt:check` chain (types, unit tests, the
repeat simulation). CI does **not** run `apps/start`'s Vitest suite,
`tests/smoke`, `tests/perf`, or `validate:stack`.

`.github/workflows/deploy-factory.yml` runs only after a successful `CI` run on
`main` (or `workflow_dispatch`) and delegates to AWS CodeBuild — not part of PR
validation.

---

## 8. Ports

Complete list, with the variable that changes each one.

| Service | Default port | Env override | Started by |
|---|---|---|---|
| PostgreSQL 16 | 5432 | `START_ALL_POSTGRES_PORT` (compose `docker-compose.postgres.yml:21`) | `dev`, `start:all`, `local:up` |
| Web (Vite dev server) | 3000 | `PORT` (`dev-with-receipt.mjs:52`) | `dev` |
| Service gateway (public web origin) | 3000 | `START_ALL_GATEWAY_PORT`, else `START_ALL_WEB_PORT` | `start:all`, `local:up` |
| Web internal (Nitro, behind the gateway) | 3001 | `START_ALL_WEB_INTERNAL_PORT` / `RECEIPT_WEB_INTERNAL_PORT` | `start:all`, `local:up` |
| Nango API | 3003 | `START_ALL_INTEGRATIONS_PORT` | `start:all`, `local:up` |
| Nango Connect UI | 3009 | `START_ALL_INTEGRATIONS_CONNECT_PORT` | `start:all`, `local:up` |
| Slack app | 3010 | `START_ALL_SLACK_PORT` | `start:all`, `local:up` (optional child) |
| Teams app | 3011 | `START_ALL_TEAMS_PORT` | `start:all`, `local:up` (optional child) |
| Zero cache | 4848 | `START_ALL_ZERO_CACHE_PORT` / `VITE_ZERO_CACHE_URL` | all three |
| Zero cache change-streamer | 4849 (cache port + 1) | derived; preflighted (`start-all.mjs:132`) | all three |
| Redis | 6380 host port | `START_ALL_REDIS_PORT` (`start-all.mjs:92`); the compose file's own default is 6379 (`docker-compose.local.yml:5`) | `start:all`, `local:up` |
| OpenSandbox controller | 8080 | `START_ALL_OPENSANDBOX_PORT` / `OPEN_SANDBOX_DOMAIN` | `start:all`, `local:up` |
| Resonate broker | 8001 | `START_ALL_RESONATE_PORT` / `RESONATE_PORT` / `RESONATE_URL` | all three |
| Resonate metrics | 9090 | `START_ALL_RESONATE_METRICS_PORT` / `RESONATE_METRICS_PORT` | all three |
| Receipt runtime API | 8787 | `START_ALL_RECEIPT_PORT` / `RECEIPT_PORT` / `PORT` | all three |
| Mock LLM proxy | 8789 | `RECEIPT_MOCK_LLM_PORT` | `llm:mock` only |
| TanStack devtools | 42069 | `TANSTACK_DEVTOOLS_PORT` | `dev` only |
| Factory simulator UI | 4397 | `RECEIPT_SIMULATOR_UI_PORT` | `receipt:simulate:ui` only |

`start:all` preflights, on both IPv4 and IPv6, only: gateway, web internal,
zero-cache, zero-cache+1, receipt, resonate, resonate metrics, and (when enabled)
opensandbox, slack, teams (`start-all.mjs:126-140`). Postgres, Redis and Nango
ports are deliberately **not** preflighted, which is why leaving those containers
running between restarts is safe.

`dev` takes a different approach: it *kills* stale repo-owned listeners on its
ports and stale repo-owned zero-cache workers before starting, and only errors
when the listener does not belong to this repo:
`Port <n> is already in use by a non-repo process; stop it or change the port.`
(`dev-with-receipt.mjs:61-145`).

**Moving the web port safely.** `BETTER_AUTH_URL` and the browser-bundled
`VITE_BETTER_AUTH_URL` must share the origin you actually browse to (RCA-253):

```bash
START_ALL_WEB_PORT=3100 \
START_ALL_PUBLIC_GATEWAY_URL=http://localhost:3100 \
BETTER_AUTH_URL=http://localhost:3100 \
VITE_BETTER_AUTH_URL=http://localhost:3100 \
./bunw run start:all
```

For Postgres: `START_ALL_POSTGRES_PORT=5433 docker compose -f docker-compose.postgres.yml up -d`.

---

## 9. Database: migrations, resets, Zero publication, native binding

### 9.1 The Postgres container

`docker-compose.postgres.yml`:

- image `postgres:16-alpine`
- `command: postgres -c wal_level=logical` — **required**; Zero's logical
  replication does not work with the default `wal_level=replica`
- `shm_size: 256mb`
- user/password/database all `receipt`
- host port `${START_ALL_POSTGRES_PORT:-5432}`
- named volume `receipt_postgres_data`

`docker-compose.local.yml` adds Redis 7 (`redis-server --save "" --appendonly no`)
and Nango built from `deploy/Dockerfile.nango`, with
`extra_hosts: host.docker.internal:host-gateway` so the container can reach
host Postgres on plain Linux daemons too.

### 9.2 Commands

| Command | Effect |
|---|---|
| `./bunw run web:db:reset` | `bun run --cwd apps/start db:reset` (`package.json:57`) |
| `./bunw run --cwd apps/start db:reset` | **Destructive full reset** (`apps/start/scripts/db-reset.ts`): 1) `DROP PUBLICATION IF EXISTS zero_data` and `DROP TABLE … CASCADE` for every base table in `public`; 2) `bunx @better-auth/cli migrate --yes --config src/lib/backend/auth/auth.server.ts`; 3) `bun run scripts/zero-dev-reset.ts`. |
| `./bunw run --cwd apps/start zero:reset` | **Destructive Zero-only reset** (`zero-dev-reset.ts`): drop Zero event triggers and internal schemas (`zero_0/cdc`, `zero_0/cvr`, `zero_0`, `zero`); run `zero/scripts/drop-all-zero-tables.sql`; re-apply `zero/migrations/schema.sql`; apply every timestamped `zero/migrations/<digits>_*.sql` in lexical order; `CREATE INDEX IF NOT EXISTS member_organizationId_userId_idx`; `CREATE PUBLICATION zero_data FOR TABLE …`; delete `zero.db`, `zero.db-wal`, `zero.db-wal2`, `zero.db-shm`. |
| `./bunw run --cwd apps/start zero:migrate` | **Forward-only, production-safe** (`zero-migrate.ts`): loads env; takes a Postgres advisory lock (`4123771`); normalises Neon user-schema tables back into `public`; runs Better Auth migrations; creates the `zero_schema_migrations` ledger; bootstraps `schema.sql` on fresh databases; applies timestamped migrations; **refreshes the `zero_data` publication**; records filename + checksum and **fails if an already-applied file changed** (with a small allow-list of known compatible re-applies). Safe against a live stack. |
| `./bunw run --cwd apps/start postgres:drop-all-tables` | Drops every table (`postgres-drop-all-tables.ts`). |
| `./bunw run --cwd apps/start seed:dummy-chats` | Referenced in `DEVELOPMENT.md:261` and `LOCAL_SETUP.md:549` — **no such script exists** in `apps/start/package.json`. See §12. |
| `./bunw run --cwd apps/start zero:analyze -- --query=…` | Zero projection analyzer (`apps/start/scripts/analyze-query.ts`); reads the saved Receipt CLI login and mints a local Zero token (`AGENTS.md:168-174`). |

`zero:reset` finishes by printing:

```
Done. Next steps:
  - Restart zero-cache: bun run zero-cache
  - Restart the app dev server.
  - For a clean browser client, clear site data for localhost (DevTools → Application → Clear site data).
```

### 9.3 The `zero_data` publication

This is the single most important database concept for a Receipt developer.
`AGENTS.md:3-6` puts it first: *"a Zero schema table missing from the `zero_data`
publication silently breaks all client sync."* RCA-001
(`docs/agent-fix-checklist.md:1530`).

Membership is computed in `apps/start/scripts/zero-publication.ts`:

- `ZERO_UI_PUBLICATION_TABLES` (lines 5-20) = `user`, `organization`, `member`,
  `invitation`, `org_ai_policy`, `org_connection_secret`, `receipt_workspace`,
  `receipt_workspace_member`, `attachments`, `org_billing_account`,
  `org_subscription`, `org_entitlement_snapshot`, `org_member_access`,
  `org_user_usage_summary`, plus `ZERO_DEFAULT_RECEIPT_PUBLICATION_TABLES` from
  `@receipt/app/runtime-contracts`.
- `ZERO_PUBLICATION_EXTRA_TABLES` (comma list) is appended (lines 45-51).
- `getZeroPublicationTableRefs` qualifies each table with a schema (lines 66-75):
  Receipt runtime projections get `RECEIPT_POSTGRES_SCHEMA` (default `public`),
  everything else gets `public`. Four `receipt_`-prefixed tables are explicitly
  treated as **app-owned public** tables: `receipt_workspace`,
  `receipt_workspace_member`, `receipt_org_guardrail_group_projection`,
  `receipt_org_policy_rule_projection` (lines 27-40).

The checklist's rule for adding a table (`docs/agent-fix-checklist.md:23-28`):
a new/changed table in `apps/start/src/integrations/zero/schema.ts` **must** also be
`zeroPublication: "default"` in its `RECEIPT_RUNTIME_TABLE_CONTRACTS` entry in
`packages/receipt-app/src/services/runtime-contracts.ts`.

Refresh order matters: `start:all` pre-migrates the Receipt durable schema
**before** running `zero:migrate`, then explicitly re-runs the publication refresh
afterwards (`start-all.mjs:41-49, 851-928`) — because the publication references
Receipt projection tables that must already exist (RCA-295,
`docs/agent-fix-checklist.md:13946`).

**Logical replication does not backfill.** Adding a table to the publication does
not populate the existing replica. Deleting `zero.db*` (which `zero:reset` does) is
what forces a full initial sync (`LOCAL_SETUP.md:801-804`).

The browser also holds an IndexedDB Zero store that a hard refresh does **not**
rebuild — clear site data for the origin if the client looks stuck.

### 9.4 The Zero native binding caveat

`@rocicorp/zero-sqlite3` ships a native `better_sqlite3.node`. Without it,
`zero-cache` crashes with **"Could not locate the bindings file."**
(`AGENTS.md:201`, `DEVELOPMENT.md:192`).

Manual fix, handling Bun's hoisting (`AGENTS.md:73`, `DEVELOPMENT.md:185-189`):

```bash
if [ -d node_modules/@rocicorp/zero-sqlite3 ]; then
  (cd node_modules/@rocicorp/zero-sqlite3 && npm run install)
else
  (cd node_modules/.bun/@rocicorp+zero-sqlite3@*/node_modules/@rocicorp/zero-sqlite3 && npm run install)
fi
```

Verify with `node -e "require('@rocicorp/zero-sqlite3')"` — silence means success.

**Both supervisors already do this for you.**
`ensureZeroSqliteBinding` (`start-all.mjs:726-750`) tests `require()`, and on
failure locates the package (direct path, else `find node_modules/.bun -path
'*/node_modules/@rocicorp/zero-sqlite3'`), deletes
`build/Release/better_sqlite3.node`, runs `npm run install` with the current Node's
directory prepended to `PATH` and `npm_config_runtime`/`npm_config_target` cleared,
then re-tests. Failure messages:
`Missing @rocicorp/zero-sqlite3 package; run bun install before start-all.` and
`@rocicorp/zero-sqlite3 still does not load after rebuild. Check <runDir>/zero-sqlite3-install.log`.
`scripts/local-up.sh:90-117` does the equivalent, failing with
`@rocicorp/zero-sqlite3 still does not load after rebuild. Check your active node/npm install.`

`package.json:113-119` lists `@rocicorp/zero-sqlite3` in `trustedDependencies`
alongside `@tailwindcss/oxide`, `core-js`, `esbuild`, `unrs-resolver`, so Bun is
allowed to run their install scripts.

### 9.5 Migration hygiene

- Add a **new** timestamped file under `apps/start/zero/migrations/`; never edit
  an applied one. `zero-migrate.ts` records a SHA-256 checksum per filename and
  fails when it changes (except for a small documented allow-list at
  `zero-migrate.ts:91-129`).
- `zero:migrate` is safe to run against a live stack; `zero:reset` and `db:reset`
  are not.
- Publication membership must change **in the same migration** as a table
  addition/removal.

### 9.6 What survives a stop

Postgres named volume; `apps/start/zero.db*` (Zero resumes rather than
re-replicating); `.receipt/data/resonate/resonate.db` (an in-flight Factory job
resumes); `.receipt/data/hub/repo.git`; `.deploy-artifacts/` (accumulates forever,
never pruned); `apps/start/.output/`; `~/.opensandbox/opensandbox.db`; and the
browser's IndexedDB Zero store.

---

## 10. Troubleshooting (symptom → cause → fix)

Each entry is sourced from code or from `docs/agent-fix-checklist.md`.

### `Bun 1.3.12 is required and npm is unavailable for the repo-local bootstrap.`
**Cause:** `./bunw` needs `npm` to install the pinned Bun
(`scripts/bun.mjs:135-137`). **Fix:** install Node 24 (which bundles npm), or point
at an existing exact-version binary:
`RECEIPT_BUN_BIN=/path/to/bun-1.3.12 ./bunw install`. The wrapper exits 127 and
prints `Set RECEIPT_BUN_BIN=/absolute/path/to/bun to use an existing exact-version binary.`

### `Bun 1.3.12 is required and no exact binary was found.`
**Cause:** `RECEIPT_BUN_AUTO_INSTALL=0` blocks the bootstrap
(`scripts/bun.mjs:124-129`). **Fix:** unset it, or set `RECEIPT_BUN_BIN`.

### `[preflight] Environment is not ready: - Node 24.x is required by .node-version, but PATH resolves Node <x>.`
**Cause:** wrong Node major (`scripts/preflight.mjs:77-79`).
**Fix:** switch to Node 24 (`nvm use`, `.nvmrc` says `24`).

### `Resonate CLI <detail> is not compatible with @resonatehq/sdk. Install Resonate >= 0.9.7 or set RESONATE_BIN to a compatible server.`
**Cause:** a `resonate` binary older than 0.9.7 on `PATH`, or none at all — in
which case the spawn fails with ENOENT and the supervisor calls `process.exit`,
taking the runtime down (`scripts/start-resonate-runtime.mjs:263-276, 354-359`).
**Fix:** install >= 0.9.7 or set `RESONATE_BIN`. Note §2.5: naming the binary
`resonate-server` bypasses this check entirely and forces the legacy flag set.

### `Could not locate the bindings file` (zero-cache)
**Cause:** the `@rocicorp/zero-sqlite3` native module was built for a different
Node ABI or architecture. **Fix:** see §9.4. `start:all` and `local:up` rebuild it
automatically; `dev` does not.

### `Missing required command: docker` / a hung `docker info`
**Causes and fixes** (`validate-stack.sh:49-113`, RCA-039/RCA-043):
1. Docker Desktop has never been launched. On macOS a freshly downloaded
   `Docker.app` is Gatekeeper-quarantined and the CLI is killed with signal 9 until
   you open the app once from Finder and complete first-run setup.
2. Docker Desktop's UI is running but its VM disk is full. This presents as a
   **hung** `docker info`, not an error. `validate:stack` bounds the probe at
   `VALIDATE_STACK_DOCKER_TIMEOUT_SECONDS` (15 s) and greps Docker Desktop's logs
   for `no space left on device` and for EXT4/`I/O error, dev vda` messages,
   appending the finding to the failure message.
3. Genuinely low host disk. Zero crashes with `ENOSPC` and the failure masquerades
   as a Factory error (RCA-055). Use `./bunw run local:release-disk-report`
   (read-only, `package.json:54`), then `./bunw run local:lima:prune`
   (destructive, `package.json:55`).

### `validate:stack needs at least 8192 MiB free on <mount> before starting the local stack; found <n> MiB`
**Cause:** the free-disk floor (`validate-stack.sh:70-92`).
**Fix:** free disk, or lower `VALIDATE_STACK_MIN_FREE_DISK_MB` only for a
documented constrained run.

### `Port <n> is already in use on 127.0.0.1.` / `… on ::1.`
**Cause:** `start:all` asserts every service port free on **both** stacks
(`start-all.mjs:414-434`). A common source is an orphaned earlier stack — see the
next entry. **Fix:** free the port, or move it (see §8), remembering to move
`BETTER_AUTH_URL` + `VITE_BETTER_AUTH_URL` together.

### The stack answers health checks but `local:up` will not start / a new run reuses old processes
**Cause:** the previous supervisor was `kill -9`ed or a wrapper was killed instead
of `scripts/start-all.mjs`. Children are spawned `detached`, so SIGKILL runs no
handler and the whole tier survives under PID 1 with ports still bound (RCA-209,
`docs/agent-fix-checklist.md:10509`).
**Fix:** `pkill -f 'bun \./scripts/start-all\.mjs'` (SIGTERM, never `-9`), then
verify with `lsof -nP -iTCP -sTCP:LISTEN` that the app ports are free. Docker ports
staying up is correct.

### Port 4849 stays bound after shutdown
**Cause:** `@rocicorp/zero` forks its workers `detached`; `change-streamer.js` sits
in its own process group and can outlive shutdown. 4848 is not orphan-prone and
4849 is, so checking only 4848 can wrongly suggest nothing leaked.
**Fix:** after stopping the supervisor, `pkill -f 'zero-cache/src/server/'`.

### `Port <n> is already in use by a non-repo process; stop it or change the port.`
**Cause:** `dev` will only auto-kill listeners whose command line contains the repo
root (`dev-with-receipt.mjs:98-113`). **Fix:** stop the foreign process or change
the port.

### The UI loads but no data ever syncs
**Cause:** a table missing from the `zero_data` publication silently breaks **all**
client sync (RCA-001). **Fix:** `./bunw run --cwd apps/start zero:reset` (or
`zero:migrate` against a live stack), and confirm Postgres runs with
`wal_level=logical` — the bundled compose file sets it, a Postgres you brought
yourself probably does not.

### A newly published table shows no rows
**Cause:** logical replication does not backfill. **Fix:** `zero:reset` (which
deletes `zero.db*`) forces a full initial sync; also clear browser site data.

### zero-cache exits shortly after start following a schema reset
**Cause:** a stale `apps/start/zero.db` retains table DDL and replication
watermarks; Zero replays `CREATE TABLE` into a replica that already has the table
and SQLite rejects the duplicate (RCA-499). **Fix:** delete `zero.db*`, or let
`zero:reset` do it; `validate:stack` isolates `ZERO_REPLICA_FILE` per run for the
same reason.

### `relation "<schema>.receipt_job_projection" does not exist` during `zero:migrate`
**Cause:** the Zero migration (which refreshes `zero_data`) ran before Receipt's
durable projection tables existed in the configured schema (RCA-295).
**Fix:** current `start-all.mjs` pre-migrates the Receipt schema first; if you
drive the migration by hand, do the same ordering.

### `schema "receipt_validate_stack" does not exist`
**Cause:** historically the validator truncated but never created its isolated
schema on a fresh database (RCA-294). **Fixed in code** —
`reset_validator_receipt_schema` now runs `CREATE SCHEMA IF NOT EXISTS`
(`validate-stack.sh:281`). If you still see it, you are on an older checkout.

### `Missing required environment variable BETTER_AUTH_SECRET.` / `Missing BETTER_AUTH_URL. …` / `Missing required environment variable ZERO_UPSTREAM_DB.`
**Cause:** these three are read at module load; the process dies on import, not on
first request. **Fix:** set them in `apps/start/.env.local` (§4.2).

### Sign-in fails with CORS errors after changing the web port
**Cause:** `start:all` inherited an ambient `RECEIPT_CONNECT_PUBLIC_GATEWAY_URL`
and baked `VITE_BETTER_AUTH_URL=http://localhost:3000` into the production bundle
while you browsed a different port (RCA-253).
**Fix:** set `START_ALL_WEB_PORT`, `START_ALL_PUBLIC_GATEWAY_URL`,
`BETTER_AUTH_URL` and `VITE_BETTER_AUTH_URL` to the same origin, and rebuild.

### `local:up` ignores values in `apps/start/.env.local`
**Cause:** `local-up.sh` reads the shell, writes its own resolved env file and
exports it; `start-all.mjs` then refuses to override any already-set key.
**Fix:** `set -a; source apps/start/.env.local; set +a` before `./bunw run local:up`.

### Type errors about `@/paraglide/messages.js`
**Cause:** generated i18n was wiped by a build's clean phase
(`apps/start/scripts/clean-build-output.mjs` runs before `vite build`).
**Fix:** `./bunw run --cwd apps/start i18n:compile`, and do not run a build and a
typecheck in parallel.

### `ENOTEMPTY` while running app tests
**Cause:** every `apps/start` test command runs the `pretest` `i18n:compile` step
and rewrites `apps/start/src/paraglide`. Two Vitest commands started in parallel
race while replacing that directory (RCA-470,
`docs/agent-fix-checklist.md:19119`).
**Fix:** never run two `--cwd apps/start test` commands concurrently; combine their
file filters into one command.

### `Platform-funded OpenAI access is unavailable: OPENAI_API_KEY is not configured.` / "no model"
**Cause:** expected until you add an organization BYOK key through the app UI
(§4.4). **Fix:** sign in, create an organization, add an OpenAI key in its model
settings — or run offline with the mock proxy (§6).

### `Unsupported Factory computer provider '<x>'. OpenSandbox is the only supported provider.`
**Cause:** `RECEIPT_FACTORY_COMPUTER_PROVIDER` set to anything but `opensandbox`
(`execution-backend-computer.ts:35`). There is no local/non-sandboxed fallback.
**Fix:** unset it. `start-all.mjs` will also warn and coerce it back
(`Ignoring unsupported Factory computer provider; using OpenSandbox.`).

### `OPEN_SANDBOX_IMAGE must reference a published image when Receipt workers use a public gateway.`
**Cause:** the local-only `receiptfactory/opensandbox-worker:local` image cannot be
pulled by a remote worker (`opensandbox-config-env-runtime.ts:71-80`).
**Fix:** set `OPEN_SANDBOX_IMAGE` to a published image, or keep the gateway local.

### `Remote OpenSandbox workers cannot use a private Receipt Connect gateway.`
**Cause:** the local OpenSandbox controller is disabled but the worker gateway is a
loopback/private address (`start-all.mjs:148-160`).
**Fix:** set `RECEIPT_CONNECT_WORKER_GATEWAY_URL`, `START_ALL_WORKER_GATEWAY_URL`,
`START_ALL_PUBLIC_HTTP_HOST`, or `RECEIPT_CONNECT_PUBLIC_GATEWAY_URL` to a
worker-reachable host.

### `Local Nango secret key was not found. Receipt Connect provider auth may fail.`
**Cause:** `start-all.mjs` reads Nango's `secret_key` out of
`nango._nango_environments` where `name='prod'`; on a first boot the row may not
exist yet (`start-all.mjs:266-296, 428-441`).
**Fix:** let Nango finish its own first-run migration and restart, or set
`RECEIPT_INTEGRATIONS_SECRET_KEY` explicitly. Checklist RCA-139 adds: prove the key
is the live environment `secret_key`, not a bootstrap placeholder, and that
`POST /integrations/connect/sessions` returns a connect link.

### Sandbox containers left behind after a crash
**Cause:** `OPEN_SANDBOX_CLEANUP_ON_FINISH=task` cleans sandboxes per task, not per
shutdown, so a controller killed mid-task leaves them running.
**Fix:** list with `docker ps -a --filter 'ancestor=opensandbox/execd:<tag>'` and
remove only those belonging to a finished task. (The repo pins
`opensandbox/execd:v1.0.16` for AWS in `sst.config.ts:1332`; the local `uvx`
controller is unpinned, so check the tag actually present.)

### `<service> exited unexpectedly. Check .deploy-artifacts/start-all/<runId>/<service>.log`
**Cause:** a non-optional child died; the supervisor tears the stack down
(`start-all.mjs:706-724`). Slack, Teams and OpenSandbox are *optional* children
and only warn: `<name> exited; continuing with degraded local capabilities.`
**Fix:** read the named per-service log.

### `Timed out waiting for <label> at <url>. Check logs in <runDir>`
**Cause:** `START_ALL_WAIT_TIMEOUT_SECONDS` (default 120) elapsed. The first ever
Nango boot and the first OpenSandbox image build are far slower.
**Fix:** `START_ALL_WAIT_TIMEOUT_SECONDS=300` and retry.

### Longer history
`docs/agent-fix-checklist.md` is a running log of ~500 dated failure modes with
root causes and pre-flight checks (`RCA-001` … `RCA-521`). `AGENTS.md:3-6` asks you
to read it before applying or testing a fix, and to append new findings.

---

## 11. Why there is no full Docker Compose stack

`LOCAL_SETUP.md:347-375` gives four reasons; all four check out against the code:

1. **The sandbox controller drives the host Docker daemon.** OpenSandbox launches
   sandbox containers through Docker. Running the controller inside a container
   means mounting `/var/run/docker.sock`, which the repo explicitly refuses to do
   elsewhere (`deploy/coder/README.md` calls not mounting the socket a *"required
   security boundary"*).
2. **`deploy/Dockerfile.receipt` cannot build natively on Apple Silicon.**
   Line 46 hardcodes `resonate_linux_x86_64.tar.gz` with no arch branching.
3. **The web image is a heavy production build.** `deploy/Dockerfile.receipt-web`
   sets `NODE_OPTIONS=--max-old-space-size=12288`; you would pay that on every
   change and lose Vite HMR.
4. **No app-service Compose topology exists to reuse.** `deploy/sst/single-host.ts`
   generates a Compose file for a *remote EC2 host* against managed RDS and
   pre-pushed ECR image refs.

Existing compose files:

| File | Services | Started by |
|---|---|---|
| `docker-compose.postgres.yml` | Postgres 16, `wal_level=logical` | `dev`, `start:all`, `local:up` — automatically |
| `docker-compose.local.yml` | Redis 7, Nango (built from `deploy/Dockerfile.nango`) | `start:all`, `local:up` — automatically, under compose project `receiptfactory-local` |
| `deploy/Dockerfile.*` | production images (receipt runtime, web, zero-cache, slack, teams, nango, opensandbox-worker, runtime-hotfix) | AWS/SST deploy only |

**Non-Docker alternative:** not realistically supported. You could run Postgres 16
natively with `wal_level=logical` and `pg_trgm`, point `ZERO_UPSTREAM_DB` at it and
set `START_DEV_POSTGRES=0`, which covers the chat app. Nango exists only as a
container; OpenSandbox *is* Docker; and both supervisors hard-require `docker` in
preflight.

---

## 12. Repo markdown vs. code

Ordered roughly by how much a docs writer would be misled.

1. **`DEVELOPMENT.md` and `README.md` omit `uv`/`uvx` and the `resonate` server
   binary from prerequisites.** Both are hard requirements for `start:all` /
   `local:up` (`start-all.mjs:123`, `start-resonate-runtime.mjs:338-360`).
   `LOCAL_SETUP.md:60-61` documents them.
2. **`DEVELOPMENT.md`'s Quick Start omits `BYOK_ENCRYPTION_KEY_B64`**, which
   `AGENTS.md:70` lists as required.
3. **`DEVELOPMENT.md:280-284` documents 3 ports (3000/4848/5432)**; the supervised
   stack opens ~15 (§8).
4. **`DEVELOPMENT.md:124,128` tells you to set `OPENAI_API_KEY` and says it is
   "required by `./bunw run validate:stack` because the validator runs
   `receipt doctor`."** `receipt doctor` does not read `OPENAI_API_KEY` at all
   (`packages/receipt-app/src/cli/doctor.ts`); it prints
   `provider auth: organization BYOK required`. Model credentials resolve from
   organization BYOK rows (§4.4). `AGENTS.md:79` states the correct behaviour.
5. **`.env.example` section 4 (lines 118-124) labels `AI_GATEWAY_API_KEY` /
   `ANTHROPIC_API_KEY` as "REQUIRED for chat/title generation."** Neither is read
   by production code; the variable the code reads for platform-funded chat is
   `OPENAI_API_KEY`, which the template never mentions.
6. **`AUTH_DEV_EMAIL_OTP_TO_CONSOLE` is documented in `.env.example:47-48` but
   implemented nowhere.** Do not expect console OTPs.
7. **`DEVELOPMENT.md:261` and `LOCAL_SETUP.md:549` show
   `bun run seed:dummy-chats`. No such script exists** in
   `apps/start/package.json`.
8. **`DEVELOPMENT.md:248` shows `../../bunw run zero:migrate` under
   "Database"** — correct — but does not mention that `db:reset` and `zero:reset`
   are destructive while `zero:migrate` is not.
9. **`LOCAL_SETUP.md:961-964` still lists `schema "receipt_validate_stack" does not
   exist` as a live troubleshooting entry.** The code now creates the schema
   (`validate-stack.sh:281`, RCA-294).
10. **`LOCAL_SETUP.md:399-405` says the local controller is
    `PyPI opensandbox-server==0.2.2, run via uvx`.** The `==0.2.2` pin exists only
    in the AWS host user-data (`sst.config.ts:1309`,
    `scripts/deploy-aws.mjs:1548`). `scripts/start-all.mjs:235,241` runs
    **unpinned** `uvx opensandbox-server`.
11. **`LOCAL_SETUP.md` cites two different execd tags**: `opensandbox/execd:v1.0.16`
    at line 403 and `opensandbox/execd:v1.0.21` at line 769. The repo pins
    `v1.0.16` and `opensandbox/egress:v1.0.12` in `sst.config.ts:1332-1333`.
12. **`LOCAL_SETUP.md:1035-1038` says `deploy/Dockerfile.receipt` pinning
    `RESONATE_VERSION=0.9.5` is below the `>= 0.9.7` floor that
    `assertCompatibleResonateCommand` enforces.** True about the pin
    (`deploy/Dockerfile.receipt:3`), but the image renames the binary to
    `resonate-server` (line 48), and `isLegacyResonateServerBinary` makes the
    assertion return early (`start-resonate-runtime.mjs:264`) — so the check never
    fires there. `deploy/coder/template/build/Dockerfile:51` uses 0.9.8.
13. **`LOCAL_SETUP.md:146` lists Redis at 6380 in the component map**, which matches
    `start-all.mjs:92`, but `docker-compose.local.yml:5` defaults to 6379 when the
    compose file is used directly.
14. **`LOCAL_SETUP.md`'s component map omits the TanStack devtools port (42069)**
    that `dev` preflights (`dev-with-receipt.mjs:56`).
15. **`AGENTS.md:189-190`: "there are few/no committed app tests yet."** `apps/start/src`
    now contains many `*.test.ts(x)` files; the statement is stale.
16. **`AGENTS.md:12-14` describes the workspace packages as `apps/start`,
    `packages/ui`, `packages/utils`, `packages/chat-scroll`,
    `packages/tailwind-config`, plus `reference/`.** It omits `packages/receipt-app`,
    `receipt-core`, `receipt-durable`, `receipt-live`, `receipt-dst`, `apps/slack`,
    `apps/teams` and `workers/markdown-converter`, and there is no `reference/`
    directory in the checkout. `README.md:117-127` has the same omission.
17. **`README.md:3-11` and `DEVELOPMENT.md` never mention
    `apps/start/.env.self-host.example`**, the second env template.
18. **`turbo.json:13-77` `globalPassThroughEnv` lists many variables no code reads**
    (`WORKOS_*`, `AUTUMN_*`, `VALYU_API_KEY`, `SUPERMEMORY_API_KEY`,
    `KV_REST_API_*`, `NEXT_PUBLIC_*`, `DUB_API_KEY`, `ADMIN_EMAILS`, `XAI_API_KEY`,
    `MISTRAL_API_KEY`, `MOONSHOTAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`).
    Do not present them as configuration.
19. **CI uses `postgres:17`** (`.github/workflows/ci.yml:40`) while local dev uses
    `postgres:16-alpine`.
20. **`apps/start/scripts/dev-with-receipt.sh` still exists** alongside the `.mjs`
    version that `apps/start/package.json:11` actually runs.
21. **`.env.example:229-231` correctly notes that `getPostHogSourceMapConfig()` is
    not wired into the build**, so `POSTHOG_PROJECT_ID` /
    `POSTHOG_PERSONAL_API_KEY` are inert. Keep that caveat in the public docs.
22. **The mock proxy prints `MOCK_OPENAI_API_KEY=mock-key`**
    (`scripts/mock-llm-proxy.mjs:518`) while the code default and both markdown
    guides use `mock-openai-key`.

---

## 13. Details that must NOT be published

- **`AGENTS.md:130`** names `beetle` as the default AWS CLI profile for
  `receipt:agent:aws` / `receipt:aws:debug`, and `package.json:90-91` hardcodes
  `AWS_PROFILE=${AWS_PROFILE:-${RECEIPT_AGENT_AWS_PROFILE:-beetle}}` plus the
  production URL `https://app.kentron.ai` in a debug command. Internal operations.
- **`AGENTS.md:132-140`** instructs agents to use *"the designated operator's real production
  account"* for production debugging. A named employee account. Never publish.
- **`AGENTS.md:105-112`** points at
  `skills/receipt-production-analytics/SKILL.md` and an
  `aws_receipt_production_user_analytics` helper for live user counts and adoption.
  Internal analytics runbook.
- **`AGENTS.md:94-103`** the "Deployment Preference" section (prefer Receipt Lite
  single-host for live `app.kentron.ai` rollouts, `single-host:rollout --stage
  factory-lite`, `skills/deploy-beetle-aws-lite/SKILL.md`). Internal cutover
  policy.
- **`README.md:82`** shows `export RECEIPT_AWS_FACTORY_ACCOUNT_ID=123456789012` —
  a placeholder, but the surrounding `<deploy-project>` / CodeBuild flow and
  `RECEIPT_SKIP_LOCAL_VALIDATION_GUARD=1` break-glass escape hatch
  (`AGENTS.md:92`, `README.md:151`) are internal deploy governance.
- **`apps/start/vite.config.ts:382`** hardcodes a personal Tailscale hostname in
  `server.allowedHosts` (`<dev-hostname>`). Do not reproduce the
  hostname in public docs; describe the field generically if it must be mentioned.
- **`scripts/install-receipt-cli.sh:4`** defaults `RECEIPT_CLI_REPO_URL` to a
  personal GitHub account's repository. Do not publish that URL as the official
  install source without confirmation.
- **`apps/start/.env.local` and `apps/start/.env.local.bak-5100`** exist in this
  working copy and contain a developer's real local configuration. Never quote
  from them.
- **`packages/receipt-app/src/cli/prod-debug-guidance.ts`, `scripts/prod-*.mjs`,
  `receipt debug prod`, `receipt:prod:*` scripts, `docs/deploy/*`,
  `docs/production-release-handoff-*.md`, `docs/factory-run-rca-*.md`** — internal
  production operations and incident material.
- **`.receipt/config.json`'s live contents are fine to document** (they are
  checked in), but `.receipt/data/`, `.receipt/tenants/`, `.deploy-artifacts/` and
  `.opensandbox/` on a developer machine hold real receipts, tokens and
  credentials.
- **`docs/agent-fix-checklist.md`** should be cited as an internal engineering log
  and mined for troubleshooting content, not republished wholesale: individual
  entries reference production incidents, account-specific evidence and named
  infrastructure.

---

## 14. Open questions (need a human)

1. **Does `apps/start/.env` need to exist?** `apps/start/package.json:19` runs
   `bun --env-file=.env --env-file=.env.local zero-cache-dev`, and
   `apps/start/.env.example:58` claims *"For Local Development, Zero requires
   separate '.env' file."* Nothing in the repo creates `apps/start/.env`, it is
   gitignored, and this working copy does not have one. Whether Bun errors on a
   missing `--env-file` (making a stub `.env` mandatory) could not be tested — Bun
   is not installed in the research environment. Confirm and then either fix the
   comment or document the stub file.
2. **Is `seed:dummy-chats` gone or just missing?** Both `DEVELOPMENT.md:261` and
   `LOCAL_SETUP.md:549` advertise it; no such script exists.
3. **Is `deploy/Dockerfile.receipt-zero-cache` orphaned?** Both `sst.config.ts:421,537,586`
   and `deploy/sst/single-host.ts` default `ZERO_IMAGE` to the upstream
   `rocicorp/zero:1.5.0`, while `apps/start` depends on `@rocicorp/zero` 1.4.0.
   The client/server version relationship should be confirmed before documenting.
4. **Which OpenSandbox `execd`/`egress` tags does the local `uvx` controller
   actually pull?** The repo pins `v1.0.16`/`v1.0.12` only for the AWS host, and
   the local install is unpinned.
5. **Should `resonate` be installed as `resonate` or `resonate-server`?** The two
   names take different code paths (§2.5) and only one of them exercises the
   version assertion. The repo's install instruction picks the one that skips it.
6. **What are realistic first-run timings and disk requirements?**
   `LOCAL_SETUP.md:621-626` reports 80–110 s warm and a ~6.8 GB OpenSandbox worker
   image, but the appendix (`LOCAL_SETUP.md:1088-1100`) says the Docker-dependent
   steps were never executed by the author. A measured first-run number would be
   valuable for the public docs.
7. **Is `VITE_ENABLE_ORGANIZATION_PROVIDER_KEYS` dead?** It is in `turbo.json`
   `globalEnv`, set by CI and by `scripts/build-beetle-images.mjs:55`, but read by
   no application code. Confirm before documenting or removing.
8. **Which of the `.env.example` orphans (§5.16) are intended future work versus
   dead entries?** In particular `SLACK_PRIMARY_TEAM_ID`,
   `SLACK_PRIMARY_RECEIPT_ORG_ID`, `SLACK_ALLOWED_TEAM_IDS` and `SLACK_BOT_TOKEN`
   look like a Slack-mapping feature whose reader was removed.
9. **What is the supported Windows story?** `bunw.cmd`, PowerShell branches in
   `dev-with-receipt.mjs:147-171`, and Windows executable-extension handling in
   `start-resonate-runtime.mjs:145-150` all exist, but `start:all`/`local:up`'s
   process-group cleanup is POSIX-only (`start-all.mjs:1064-1080`) and `local:up`
   is a bash script. Confirm whether Windows is supported, WSL-only, or unsupported.
10. **Is `receipt:test:smoke` expected to be run by contributors?** It is not in
    `check:fast` or CI, it needs Docker Postgres, and it takes a 240 s per-test
    timeout with `--max-concurrency=1`.

---

## Suggested doc pages

| Slug | Title | Purpose | Audience |
|---|---|---|---|
| `develop/prerequisites` | Prerequisites and the `./bunw` toolchain | Install exactly the right versions of Node, npm, Docker, uv, resonate and codex, and understand why `./bunw` exists and never to run a bare `bun`. | developer |
| `develop/quickstart` | Local quickstart | Get the chat app, Zero sync and the Receipt runtime running from a fresh clone in six commands. | developer |
| `develop/run-modes` | Run modes: `dev`, `start:all`, `local:up` | Choose the right entry point, know exactly which services each starts, and start/stop the full stack safely. | developer |
| `develop/ports` | Port reference | Look up every port the stack uses, and move one without breaking auth. | developer |
| `configure/environment` | Environment variable reference | Find any variable Receipt reads, its default, whether it is required, and what it does. | both |
| `configure/env-file-loading` | Configuration files and load order | Understand which `.env` files are read by which entry point, and why shell values win. | developer |
| `configure/model-access-byok` | Model access and BYOK | Add an OpenAI key the way Receipt actually resolves it, and understand platform credit vs. BYOK. | both |
| `develop/offline-mock-llm` | Offline development with the mock LLM proxy | Run the runtime with no provider account, script fixture responses and inject failures. | developer |
| `develop/database` | Database, migrations and the Zero publication | Reset, migrate, and avoid the `zero_data` publication trap that silently breaks all sync. | developer |
| `develop/testing` | Testing and checks | Know what `check:fast`, `receipt:check`, the smoke/perf suites and the simulations cover, and what CI gates a PR on. | developer |
| `develop/validate-stack` | Validating a running stack | Run `validate:stack`, read its artifacts, and use its opt-in Factory/AWS gates. | developer |
| `develop/troubleshooting` | Troubleshooting local development | Diagnose the real failure modes by symptom, with the exact error strings. | developer |
| `develop/factory-sandbox` | Running Factory agents locally (OpenSandbox) | Start the sandbox controller, understand receipt-backed leases, and know the local security posture. | developer |
| `develop/architecture` | How the local stack fits together | Understand the two products, the receipt state model, and the request/execution flow. | both |
| `self-host/configuration` | Self-hosting configuration | Configure a `self_hosted` instance: instance mode, setup token, email provider, storage, Redis, Qdrant. | both |
