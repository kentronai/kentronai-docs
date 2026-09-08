# J2 — Index of the Receipt monorepo's internal documentation

Repository: `~/Desktop/Development/kentron/Receipt` at `c3c16be6` (main), read 2026-09-08.
Prior corpus used as a map only: `~/Desktop/Development/kentron/doc/research/` (written at `41baea75`).
Every claim below was re-checked against HEAD; where a document and the code disagree the code is cited and the document is marked stale.

## 0. How to read this index

**Public section numbers** used in the tables map to the six tabs of the public docs site (`doc/docs.json`) plus one cross-cutting bucket:

| # | Public section | Directory in the docs repo |
|---|---|---|
| 1 | Guides (Start here, Working with Receipt, Channels and help) | `introduction.mdx`, `getting-started/`, `guides/` |
| 2 | Platform (tenancy, models/keys, org controls, connected apps, data & trust) | `platform/` |
| 3 | CLI (the released `receipt` binary) | `cli/` |
| 4 | Developers (architecture, receipts/streams, jobs, runtime API, SDK) | `develop/` |
| 5 | Self-hosting (overview, configuration, database, integrations provider, deploying) | `self-hosting/` |
| 6 | Working from source (local dev, in-repo CLI, Factory, authoring agents, testing) | `repo/` |
| 7 | Cross-cutting reference (glossary, naming, error/limit catalogue) | any |

**Publish status** values:

- **SAFE** — can be mined directly; contains no internal identifiers.
- **CARE** — useful, but strip cloud account ids, instance ids, IPs, named personal accounts, internal hostnames/profile names, or internal image digests before quoting.
- **DO NOT PUBLISH** — internal runbook, production-ops procedure, incident record, or contains credentials/named accounts; mine only for isolated facts and never link or quote.

**Feature classification** vocabulary (ground rule 3): *reachable* (implemented, in the UI/CLI navigation), *hidden* (implemented, direct URL/command only), *stubbed* (surface exists, nothing executes/enforces), *absent*.

Six in-scope files are gitignored or untracked and have no commit date: `docs/LOCAL_SETUP.md` (an untracked move of the tracked root `LOCAL_SETUP.md`), `CODEBUDDY.md`/`GEMINI.md`/`QODER.md` (gitignored copies of the MCP block in `CLAUDE.md`), and the two generated i18n readmes under `apps/start`. `apps/start|slack|teams/README*`, `packages/*/README*`, `nango-integrations/README*` and `eval/**/README*` **do not exist**; the extra readmes that do are listed in §1.5. Two referenced directories outside the requested list exist: `blog/` (7 essays cited by `docs/GLOSSARY.md`) and `docs/superpowers/` (8 dated plans/specs that `docs/README.md:24` calls historical).

---

## 1. Inventory

### 1.1 Repository root

| Path | Size | Last commit | What it documents | Audience | Staleness signals | Sections | Status |
|---|---|---|---|---|---|---|---|
| `README.md` | 8.9 KB | 2026-08-14 | Product pitch ("High-performance AI chat infrastructure built for teams"), feature bullets, tech stack, SST AWS deploy, repo layout, `start:all`, markdown-worker setup, AGPL-3.0 + enterprise license split (`:193-201`). | end user / self-hoster / developer | Lists absent `reference/` (`:127`); promises a React Native app (`:39`) that does not exist; quick start still sets `OPENAI_API_KEY` although keys are org-scoped BYOK rows (`AGENTS.md:79`). | 1, 4, 5 | SAFE (example account id is a placeholder) |
| `DEVELOPMENT.md` | 9.4 KB | 2026-08-14 | Quick start (install, `.env.local`, Postgres compose, Zero native binding, `i18n:compile`, `web:db:reset`, `dev`), `start:all`, `local:up`, OpenSandbox overrides, mock LLM proxy, validate:stack, script list, troubleshooting. | developer / self-hoster | Omits `uv`/`uvx`, the `resonate` binary, `BYOK_ENCRYPTION_KEY_B64`, and 11 of the ~14 stack ports (all documented in `docs/LOCAL_SETUP.md:1154-1178`). Quick start still sets `OPENAI_API_KEY` "required by validate:stack because the validator runs `receipt doctor`" (`:128`), while `docs/api/cli.md:53-55` says doctor treats it as a warning. | 6 | SAFE |
| `CONTRIBUTING.md` | 1.1 KB | 2026-04-17 | Issue-first policy for large changes, app/package placement rules. | developer | None. | 6 | SAFE |
| `SECURITY.md` | 1.1 KB | 2026-04-17 | Vulnerability reporting: "through your organization's designated security contact channel", 24-hour response, requested report fields. | end user / admin | Names no email address, no PGP key. | 1 (getting-help), 2 (data & trust) | SAFE |
| `architecture.md` | 5.0 KB | 2026-04-17 | The original upstream Receipt manifesto: receipts as truth, run loop, queue stream families, lanes `steer/collect/follow_up`, singleton modes, merge policy shape, stream families, "Default store: SQLite-backed receipt tables", UI contract, CLI contract. | developer | "Default store: SQLite" (`:164`) contradicts every later doc and `docs/api/streams.md:3` (Postgres). Lane list lacks `chat` (`packages/receipt-app/src/modules/job.ts:8`). Merge receipts `merge.evidence.computed`/`merge.candidate.scored` (`:140-141`) are explicitly not emitted (`docs/factory-on-receipt.md:681`). | 4 | SAFE |
| `AGENTS.md` | 20.1 KB | 2026-09-06 | The repo-wide operating contract for humans and coding agents: state model rule, `./bunw`, agent dev-setup order, validate:stack gate, deployment preference (Receipt Lite single-host), production analytics helper, Nango agent setup, AI-agent CLI onboarding, Factory worker bootstrap, MCP graph tools. | developer / Kentron-internal operator | Lists `reference/` (`:14`, absent). Says "few/no committed app tests yet" (`:189`) — thousands exist. Directs production debugging to a named staff member's account (`:132-140`). | 4, 6 (only the setup and state-model parts) | CARE — strip the named-account rule, AWS profile names, `app.kentron.ai` ops instructions |
| `CLAUDE.md` | 3.3 KB | 2026-09-06 | Claude Code pointer to `AGENTS.md`, the three CLI docs, the `.receipt/factory/<taskId>.*` packet files, and the code-review-graph MCP block. | developer (agent) | None. | none (internal agent config) | SAFE but not docs material |
| `CODEBUDDY.md`, `GEMINI.md`, `QODER.md` | 2.3 KB each | untracked (gitignored) | Identical copy of the MCP code-review-graph block. | agent tooling | Generated. | none | SAFE / ignore |
| `plan.md` | 2.2 KB | 2026-06-26 | Codex pointer: read `AGENTS.md`, `docs/agent-fix-checklist.md`, `receipt/current/*`; validation commands; keep runtime homes under `.receipt/`. | agent | Fine. | none | SAFE / ignore |
| `pending todos.md` | 8.4 KB | 2026-04-30 | Plan for a self-contained Tauri desktop app (bundled Bun/Postgres/Python, phases 1-8). | developer | **Absent feature**: `apps/desktop` and every referenced file are missing at HEAD. | none | SAFE — not a roadmap |

### 1.2 `docs/*.md`

| Path | Size | Last commit | What it documents | Audience | Staleness signals | Sections | Status |
|---|---|---|---|---|---|---|---|
| `docs/README.md` | 2.4 KB | 2026-08-18 | Entry-point list for the runtime/Factory docs; notes `docs/superpowers/` is historical. | developer | Says the repo-root `src` tree is a "compatibility and local authoring surface" — `src/agents` is absent at HEAD. | 4, 6 | SAFE |
| `docs/GLOSSARY.md` | 31.9 KB | 2026-07-11 | ~120 terms in sections A-L: receipt core, design principles, runtime layers, Factory hierarchy, orchestration, durable execution, capabilities/connectors, CLI surface, chat subsystem, billing/policy, tech stack, monorepo. Explicitly defines Beetle as the brand and Factory as the code term (`:152-154`). | developer / writer | Says "PostgreSQL (17)" (`:391`) — local compose is `postgres:16-alpine` (`docker-compose.postgres.yml:13`). Cites `blog/*` essays (present). Lists "Free chat allowance" as a daily allowance — the corpus notes the free-tier branch returns false today. | 7 | SAFE |
| `docs/LOCAL_SETUP.md` | 67.8 KB | untracked (root copy 2026-09-07) | The complete from-scratch local guide: prerequisites incl. `uv` and `resonate`>=0.9.7, component map with all 14 ports, the minimal `.env.local`, model-key resolution, `dev` vs `start:all` vs `local:up`, observed start/stop/reload procedures, troubleshooting, ten documentation/config bugs. | developer / self-hoster | Newest and most accurate setup source. Sections 6A-6C use a machine's non-default ports (3003/5xxx) — substitute defaults. Bug item 8 ("`Dockerfile.receipt-zero-cache` appears orphaned") is moot: `sst.config.ts:421` defaults to `rocicorp/zero:1.5.0`. Item 9 names a personal Tailscale hostname — do not reproduce. | 5, 6 | CARE — strip the hostname and machine-specific ports |
| `docs/agency-analytics-nango-enablement.md` | 20.0 KB | 2026-08-06 | Operator runbook to enable Google Ads/GA4/Meta/YouTube/TikTok/Instagram read-only reporting: scopes, developer tokens, `ensure-nango-integrations.mjs --only ...`, `nango dryrun`, named per-client connections (`google-ads:acme`), definition of done. | Kentron-internal operator / self-hoster | Secret key names for the hosted deployment (`NangoGoogleAdsClientId=` etc.) are deploy-specific. | 5 (integrations provider, facts only) | CARE — mine scope/provider facts; do not publish as a runbook |
| `docs/agent-fix-checklist.md` | 1.10 MB, 21,286 lines | 2026-09-07 | Running log of 523 numbered RCAs plus a pre-flight checklist; each entry has date, severity, finding, prevention. | Kentron-internal | Contains objective ids, instance ids, IAM user names. | 7 (gotchas only) | DO NOT PUBLISH — mine RCA-001 (`zero_data`), RCA-209 (supervisor kill), RCA-523 (CLI release gap) as anonymised facts |
| `docs/agent-framework-integrations.md` | 51.5 KB | 2026-08-18 | Putting CrewAI / LangGraph / OpenAI Agents SDK / AutoGen behind a Receipt job handler: boundary, identity table, versioned NDJSON worker contract, a Python `ReceiptClient`, per-framework adapters, retries, human input, test matrix, and "boundaries that do not exist" (`:118-130`). | developer | Registering a handler requires a code change (`:104-108`). | 4 | SAFE |
| `docs/agent-framework.md` | 3.8 KB | 2026-08-18 | Receipt runtime principles, SDK exports, the 8-step `runAgentLoop`, control receipt names, queue model, CLI list, exit codes (`receipt run` blocked → exit 2). | developer | Says agents auto-discover from `src/agents/*.agent.ts` — that root tree is absent at HEAD. | 4 | SAFE |
| `docs/ai-agent-receipt-cli.md` | 12.4 KB | 2026-09-01 | How AI agents learn the CLI: entry points, mounted files, envelope commands, hosted wrappers (`receipt:agent:hosted`, `receipt:agent:aws`), Zero analyzer, live control, computer commands, anti-patterns. | developer | Names a staff member's production actor as default (`:157-160`). | 6, 4 | CARE |
| `docs/ai-prompt-catalog.md` | 17.8 KB | 2026-07-11 | Every live model prompt with exact text: chat default, Study Mode, thread title, chat router ("You are the Beetle app chat router."), Factory job problem prompt, supervisor, task prompt skeleton ("User-facing agent name: Beetle."), continuation, intervention, doctor, audit, system-improvement, eval oracle. | developer / writer | Prompts embed the Beetle name (`:96`, `:123-133`, `:214-215`) — naming decision pending. | 1 (background runs), 4 | SAFE |
| `docs/context-management.md` | 21.7 KB | 2026-05-19 | The five context layers, ranked prompt context, overflow receipts, scoped memory, Factory task packet (13 files), six context channels, recursive context pack, memory scopes, prompt assembly, debug order. | developer | Consistent with `factory-agent-orchestration.md`. | 4, 6 | SAFE |
| `docs/create-agent.md` | 4.2 KB | 2026-05-19 | Scaffold → author (`receipts/view/actions/goal`) → run → inspect; templates `basic|assistant-tool|human-loop|merge` (verified `packages/receipt-app/src/cli/commands.ts:140-192`). | developer | Says scaffold writes `src/agents/<id>.agent.ts` at repo root — no root `src/` exists; verify where `receipt new` writes today. | 6 (authoring agents) | SAFE |
| `docs/desktop-tauri-implementation.md` | 16.0 KB | 2026-05-19 | Plan for a Tauri desktop shell with bundled Bun, `receipt desktop serve`, `RECEIPT_*_BIN` overrides. | developer | **Absent**: no `apps/desktop`, no `desktop serve` command. Links use an ex-maintainer's absolute home path. | none | SAFE — do not publish (roadmap) |
| `docs/factory-agent-orchestration.md` | 23.8 KB | 2026-07-11 | The execution path: router → ingress → objective supervisor → Codex worker → HubGit worktrees → integration → validation → promotion; task packet contents; probe class; quirks (`HUB_REPO_ROOT` still used, `hub-git.ts:770`). | developer | Current. | 4, 6 | SAFE |
| `docs/factory-category-correctness.md` | 13.0 KB | 2026-07-11 | Category-theory framed invariants (terminal absorption, scope preservation, idempotent projections), laws mapped to the May-26 bugs, required side effects per event, metrics, review checklist. | developer | Object list for objectives (`created/executing/…`) predates `status-contract.ts`. | 4 | SAFE |
| `docs/factory-deterministic-simulation-harness.md` | 98.4 KB | 2026-07-13 | `@receipt/dst` primitives, the `factory simulate` CLI family, phases 0-4, Zero/UI targets. | developer | Long working notes. | 6 | SAFE |
| `docs/factory-durable-execution-architecture.md` | 11.4 KB | 2026-06-19 | Accepted architecture: intent → outbox → Resonate → side effect → ack receipts → projections; nine non-negotiable rules; `effect.*` and `computer.*` event vocabularies; terminal I/O projections; completion invariants; local E2E gate. | developer | `/computer` gateway route naming rule (`:95`). | 4 | SAFE |
| `docs/factory-improvements-2026-07-12-to-13.md` | 5.3 KB | 2026-07-13 | Changelog of 23 commits / 50 RCAs (211-260) and why the simulator missed them. | Kentron-internal | Dated changelog. | none | CARE (commit hashes only) — historical |
| `docs/factory-infra-real-data-eval.md` | 9.2 KB | 2026-04-17 | Proposed eval plan: four axes, three AWS scenarios, rubric out of 8. Baseline: 17,280 streams, 0 integrity failures on 2026-04-10. | developer | Uses `--profile infrastructure` — profiles were collapsed to `receipt` (`docs/factory-on-receipt.md:66`). | none | SAFE — historical |
| `docs/factory-on-receipt.md` | 35.3 KB | 2026-07-11 | The Factory core as implemented: stream model, end-to-end flow, state machines, which receipts are actually emitted, react loop, planner effects, worker dispatch, Codex result contract, layered memory, Git branch model, integration flow, eight quirks. | developer | Objective status list (`:353-362`, starts with `decomposing`) is stale versus `modules/factory/status-contract.ts:8-21`. `maxActiveTasks` default 4 (`:612`) is overridden to 20 by the checked-in `.receipt/config.json`. | 4, 6 | SAFE |
| `docs/factory-outbox-event-sourcing-goals.md` | 29.2 KB | 2026-06-05 | Ten-goal handoff plan for the outbox migration with status snapshot (2026-06-04), deletion gates, milestones, Codex prompt. | developer | Status snapshot is a point in time. | 4 (background only) | SAFE |
| `docs/factory-run-rca-2026-05-26.md` | 16.0 KB | 2026-05-26 | Incident RCA: worker gateway URL conflation, cold OpenSandbox, duplicate answer cards, monitor churn, mirror CAS conflicts; fixes and files. | Kentron-internal | Contains objective ids and a cloud account id. | none | DO NOT PUBLISH |
| `docs/factory-self-improvement.md` | 17.0 KB | 2026-07-11 | Contract → alignment gate (one corrective pass) → `factory investigate` → automatic `factory.objective.audit` → `factory audit` rollup → memory hygiene; `FACTORY_OBJECTIVE_AUDIT_SYSTEM_IMPROVEMENT=false`; audits are recommendation-only (`:197-200`). | developer | Links use an ex-maintainer's home path. | 6 (Factory) | SAFE |
| `docs/frontend-rift-ownership.md` | 1.9 KB | 2026-08-13 | Which UI files are owned upstream by Compound Rift and which are Receipt adapters. | developer | — | none | SAFE |
| `docs/integration-factory-receipt.md` | 12.6 KB | 2026-07-31 | Checked-in connector catalog model: `provider.json` contract, `catalog.json` + `catalog.ts` static imports, capability manifests, admin-and-worker flow, session contract, rollout model. | developer / admin | "Admin enables an integration for the organization → DB writes enabled=true" (`:278-279`) conflicts with `:39-43` ("no second org-enablement table"); verify which is live. | 2 (integrations), 5 | SAFE |
| `docs/memory.md` | 11.6 KB | 2026-07-11 | Memory as receipt streams `memory/<scope>` + `memory_entries`/`memory_accesses` projections + optional `memory_embeddings`; six operations; events `memory.committed/accessed/forgotten`; preference scopes; Factory scope layout; CLI. | developer | — | 4 | SAFE |
| `docs/ms-teams-testing-setup.md` | 4.8 KB | 2026-09-01 | Azure bot creation, `/teams/api/messages` endpoint, `/teams/health`, `bun run teams:package`, admin upload, linking flow, test checklist. | admin / self-hoster | **Conflict**: names secrets `TEAMS_CLIENT_ID/…` (`:37-39`) but `apps/teams/server.ts:19` reads `CLIENT_ID`, `CLIENT_SECRET`, `TENANT_ID`. Hard-codes the hosted origin. | 1, 5 | CARE |
| `docs/prod-readiness-metrics.md` | 15.0 KB | 2026-09-01 | The production readiness gate: `receipt:prod:readiness`, domain preflight, AWS preflight, auth-email smoke, release gate; threshold table; projection tally table; blockers as of 2026-06-22 (SES denial, quota). | Kentron-internal | Contains an AWS support case number, a personal email, profile names. | none | DO NOT PUBLISH |
| `docs/production-release-handoff-2026-06-25.md` | 9.8 KB | 2026-06-24 | Release checklist with account id, cluster names, buckets, secrets names, break-glass vars. | Kentron-internal | Ex-maintainer home paths; "rotate the AWS key pasted into chat". | none | DO NOT PUBLISH |
| `docs/projection-durability-fix.md` | 7.7 KB | 2026-09-05 | The September projection-durability change: per-stream pending work, single projection connection, checkpoints, indexes, validation numbers, rollout notes, an authorized break-glass exception. | developer / Kentron-internal | Mentions a named staff account for the safe objective. | 4 (one paragraph) | CARE |
| `docs/receipt-authorization-mcp-product-plan.md` | 138.3 KB | 2026-08-20 | Product/architecture proposal (2026-08-19): org → workspace → connections/profiles/policies/budgets/principals, enforcement-mode table with honest labels, domain model, MCP surface, UX, phases, acceptance criteria, Norix lessons. | developer / product | A proposal; Allow/Ask/Never, budgets and remote OAuth MCP are follow-on. POC section names a staff account. | 2 (vocabulary only) | CARE |
| `docs/receipt-cli-debug-report.md` | 16.3 KB | 2026-09-07 | RCA-523 report: why `v0.1.0-preview.6` could not onboard a fresh user, root causes, files, production/local/MCP investigation, changes, validation table, remaining issues (release not yet published). | Kentron-internal | Contains an EC2 instance id, IAM user names, staff emails. | 3 (facts only) | DO NOT PUBLISH |
| `docs/receipt-cli-mcp-implementation-plan.md` | 8.2 KB | 2026-08-20 | The first CLI/MCP slice: runtime contract diagram, publication rules, CLI contract, UI contract, acceptance gates, "implemented MVP evidence" (58-connector audit). | developer | Superseded by real workspaces (`receipt-real-workspaces-dev-handoff.md`). | 2 (MCP gateway), 3 | SAFE |
| `docs/receipt-cli.md` | 11.8 KB | 2026-09-07 | The public CLI: installer, `RECEIPT_CLI_VERSION`, preview.6 vs preview.7, `doctor/login/logout/setup`, `connect <provider>` (16 providers), MCP for Codex, Claude observer, named connections, self-hosted and local targets, connector runtime, release process. | end user / self-hoster | preview.7 was **not yet published** at writing (`receipt-cli-debug-report.md:236-240`). | 3, 5 | CARE — strip the release section |
| `docs/receipt-connect-nango.md` | 34.1 KB | 2026-08-20 | Receipt Connect ownership model, `RECEIPT_INTEGRATIONS_*` env, per-provider `RECEIPT_NANGO_*` overrides, runtime flow, `receipt connect list/tools/call`, write policy, named connections, adding an integration, provider config keys, per-provider OAuth notes, callback rule, smoke tests. | self-hoster / developer | Dense but current. | 2, 5 | SAFE |
| `docs/receipt-contract-standardization.md` | 4.7 KB | 2026-06-17 | Canonical job lifecycle (`queued/leased/running/completed/failed/canceled`, display `leased→running`) and Factory domain lifecycles (matches `status-contract.ts`). | developer | — | 4 | SAFE |
| `docs/receipt-dst.md` | 12.5 KB | 2026-05-30 | `receipt dst` (integrity/replay/deterministic), `--context` packet audit, `--strict`, packet archive under `<DATA_DIR>/factory/task-packets/<jobId>/`. | developer | Home-path links. | 6 | SAFE |
| `docs/receipt-integration-surface-audit.md` | 17.8 KB | 2026-08-20 | The 61-connector matrix (surface, tools R/W, readiness, enforcement), nine missing hosted configs, gates 0-4, honest labels. | admin / developer | Catalog is now 63 slugs (`integrations/nango/catalog.json`); the evidence snapshot and CLI plan say 58 — count from `catalog.json`. | 2 | SAFE |
| `docs/receipt-real-workspaces-dev-handoff.md` | 36.5 KB | 2026-09-07 | Real workspace tenancy: deterministic Default workspace, migration, `/connect/workspaces*` API, CLI/MCP behaviour, public CLI install, MCP flow, UI, compatibility-read tool, ten security invariants, release and hosted acceptance records, follow-ups. | developer / end user | Acceptance sections carry image digests, a cloud account id, SSM command ids and a staff member's connection inventory. | 2, 3 | CARE |
| `docs/receipt-runtime-readme.md` | 15.2 KB | 2026-07-11 | Original runtime README: layers A-G, data flow, tech table (Hono, HTMX, Ink), repo map, prerequisites, quick start, common commands, runtime modes (`JOB_BACKEND=local` rollback only), web/API surfaces, Docker dev/prod containers. | developer | `bun run docker:dev:up` etc. and Docker ports 8787/8001/9090 predate the current compose layout; verify scripts exist. | 4, 6 | SAFE |
| `docs/slack-integration-playbook.md` | 14.2 KB | 2026-07-13 | Slack V1 plan: scope, topology, identity model, payload contract, message sequence, env vars, app setup checklist, security, `slack:real-smoke` test plan. | developer / admin | Planned message wording differs from shipped strings in `apps/slack/server.ts`; env defaults verified (`:103-105`). | 1, 5 | SAFE |
| `docs/teams-app-private-distribution.md` | 4.8 KB | 2026-09-01 | Teams as a first-party app (not Nango), single-tenant bot, package build, admin upload, claim-link binding, verification. | admin / self-hoster | Correct env names (`CLIENT_ID`…). | 1, 5 | SAFE |
| `docs/tool-reliability-fixes-2026-09-05.md` | 3.2 KB | 2026-09-05 | Seven production observations and their corrections (dependency inventory, routing, sandbox auto-stop, permanent 401s, audits, artifact paths, gateway/Zero readiness). | Kentron-internal | Named staff account context. | none | DO NOT PUBLISH |
| `docs/ui-design-system.md` | 4.1 KB | 2026-09-07 | The NORIX design mandate: chroma-zero neutrals, two themes, token names, component table, metrics (`h-9`, `h-10`, `0.5rem`), list-page section order, definition of done. | developer | — | none | SAFE |

### 1.3 `docs/api/*`

| Path | Size | Last commit | What it documents | Audience | Staleness signals | Sections | Status |
|---|---|---|---|---|---|---|---|
| `docs/api/README.md` | 0.7 KB | 2026-04-17 | Index of the six API docs. | developer | — | 4 | SAFE |
| `docs/api/cli.md` | 20.1 KB | 2026-07-12 | The **in-repo** CLI: `setup`, `doctor`, `debug local|prod`, `import/observe clauden`, `new`, `dev`, `run`, `trace`, `replay`, `dst`, `inspect`, `fork`, `jobs`, `abort`, `memory *`, `factory *` (panels, modes, severities, JSON shapes), resolution rules, `DATA_DIR` default. | developer | Companion skill `skills/receipt-cli-operator/SKILL.md` (`:20`) does **not exist**. `debug prod` token fallbacks reference `deploy/factory.secrets.env` and SST secrets. | 6 (in-repo CLI, receipts & jobs commands) | CARE — strip the prod-debug token chain |
| `docs/api/config.md` | 4.3 KB | 2026-07-13 | Runtime env table, `.receipt/config.json` schedules, model defaults, planner timeout, improvement harness. | self-hoster / developer | **Stale table**: `JOB_POLL_MS`, `JOB_CONCURRENCY`, `JOB_LEASE_GRACE_MS`, `JOB_WORKER_ID`, `HEARTBEAT_<AGENT>_INTERVAL_MS` are not read anywhere under `packages/receipt-app/src`; the live knobs are `JOB_LEASE_MS` (default 300000, `adapters/resonate-config.ts:107`), `CODEX_JOB_LEASE_MS` 900000 (`:108`), `FACTORY_CONTROL_JOB_LEASE_MS` 900000 (`:23`), `CODEX_JOB_CONCURRENCY` 1, `ORCHESTRATION_JOB_CONCURRENCY` 1, `CHAT_JOB_CONCURRENCY` 4 (`adapters/resonate-runtime.ts:102-106`). Model defaults verified (`adapters/openai.ts:12`, `objective-supervisor-runner.ts:111`). | 5 (configuration) | SAFE after correction |
| `docs/api/http.md` | 8.7 KB | 2026-07-11 | Runtime HTTP: `/healthz`, `POST /agents/:id/jobs` (202), `/jobs*`, steer/follow-up/abort, Factory web routes, `/memory/*`, `/assets`. | developer | Lane enum omits `chat`. `/readyz` (used by every runbook) is undocumented. Worker ids `factory-control`/`factory-monitor` need verification (`bootstrap.ts:1773` registers `factory`; `factory-runtime.ts:1654` `codex`). | 4 (runtime API) | SAFE |
| `docs/api/sdk.md` | 3.8 KB | 2026-07-11 | SDK exports, minimal agent, action runtime contract (`sideEffects: receipt_only|query|external`, `commitWhen`), merge policy contract and durable merge receipts. | developer | — | 4 (SDK) | SAFE |
| `docs/api/sse.md` | 1.8 KB | 2026-05-19 | SSE topics/events, `ping` every 5 s, `/factory/events`, `/receipt/stream`, `/jobs/:id/events`. | developer | — | 4 | SAFE |
| `docs/api/streams.md` | 2.1 KB | 2026-05-19 | Stream families, queue lifecycle receipts, commands `steer/follow_up/abort`, lanes, singleton modes, storage layout, integrity. | developer | Lane list omits `chat`. | 4 (receipts & streams) | SAFE |

### 1.4 `docs/deploy/*` and `docs/evidence/*`

| Path | Size | Last commit | What it documents | Audience | Staleness signals | Sections | Status |
|---|---|---|---|---|---|---|---|
| `docs/deploy/aws-sst-onboarding.md` | 21.0 KB | 2026-09-01 | Receipt Lite rollout path, factory-lite power lifecycle, account model, Identity Center groups, deploy guard vars, CodeBuild runner, SST secrets incl. the Nango `IntegrationSecretKey` bootstrap, CI/OIDC, on/offboarding, security baseline. | Kentron-internal | Account id, profile and bucket names. | 5 (guard-variable names, baseline list) | DO NOT PUBLISH |
| `docs/deploy/app-kentron-ai-cutover-todo.md` | 19.7 KB | 2026-09-01 | The `beetle.run` → `app.kentron.ai` cutover: live execution record (2026-09-02), eight gated phases, `RECEIPT_LEGACY_PUBLIC_ORIGINS`, callback URLs, rollback; states a product rebrand is a separate change (`:369-376`). | Kentron-internal | Instance id, EIP, SSM ids, digests, a principal ARN. | 7 (naming) | DO NOT PUBLISH |
| `docs/deploy/aws-coder-two-developer-runbook.md` | 32.9 KB | 2026-09-01 | Two-developer Coder-on-EC2 environment plan: decisions, security boundaries, eight phases, env rendering, gates 1-8, rollback. | Kentron-internal | — | none | DO NOT PUBLISH |
| `docs/deploy/neon-to-aws-zero-migration.md` | 20.6 KB | 2026-05-27 | Moving Postgres to RDS/Aurora while keeping Zero correct: direct-writer rule for `ZERO_UPSTREAM_DB`, `zero_data` publication, replica reset, slot monitoring, dump/restore vs DMS, cutover checklist. | self-hoster | Historical (Neon is gone) but the Zero constraints are the best written statement of them. | 5 (database & migrations) | SAFE |
| `docs/evidence/receipt-integration-live-config-2026-08-19.json` | 3.9 KB | 2026-08-20 | Sanitized hosted Nango snapshot: `catalogCount: 58`, 49 configured, 9 missing, 2 extra, scope readback. | developer | Older than the current 63-slug catalog. | none | SAFE (sanitized) |

### 1.5 App, package, worker and deploy readmes

| Path | Size | Last commit | What it documents | Audience | Staleness signals | Sections | Status |
|---|---|---|---|---|---|---|---|
| `apps/start/BACKEND_EFFECT_PLAYBOOK.md` | 6.3 KB | 2026-04-16 | Effect-TS conventions for `apps/start` backend: `Effect.fn`, `ServiceMap.Service`, folder shape, runtime template, error design, review checklist. | developer | — | none | SAFE |
| `apps/start/src/lib/README.md` | 1.1 KB | 2026-04-16 | `lib/backend`/`frontend`/`shared` layering and import boundaries. | developer | — | none | SAFE |
| `apps/start/src/lib/shared/ai-catalog/ADDING_PROVIDER.md` | 2.5 KB | 2026-07-13 | Steps to add an AI provider: SDK, model ids from the AI Gateway list, provider tool metadata, catalog entries, validation. | developer | — | 6 | SAFE |
| `apps/start/src/ee/LICENSE.md` | 1.2 KB | 2026-04-17 | The Receipt Enterprise License (production use requires a commercial agreement with the contracting entity). | end user / self-hoster | — | 5 (overview: licensing) | SAFE |
| `apps/start/project.inlang/README.md`, `apps/start/src/paraglide/README.md` | 3.9 / 3.2 KB | generated | inlang/Paraglide tooling readmes. | developer | Generated; ignored by git. | none | ignore |
| `workers/markdown-converter/README.md` | 1.0 KB | 2026-04-16 | Cloudflare Worker `POST /convert`; `INTERNAL_TOKEN` secret; app vars `CF_MARKDOWN_WORKER_URL`, `CF_MARKDOWN_WORKER_TOKEN`, `CF_MARKDOWN_MAX_CHARS`. | self-hoster | Says PDF "using Workers AI" — README.md says PDF/HTML/Office/etc.; verify supported inputs. | 5 | SAFE |
| `deploy/sst/README.md` | 1.2 KB | 2026-06-12 | How to add an SST service (`createReceiptService`, stable logical names). | developer | — | none | SAFE |
| `deploy/coder/README.md` | 5.1 KB | 2026-08-25 | Coder workspace template: two fixed slots, per-slot gateway ports, Postgres fallback container, SSM parameter names. | Kentron-internal | — | none | DO NOT PUBLISH |
| `deploy/coder/docs/OPERATIONS.md` | 10.2 KB | 2026-08-25 | Personal runbook for the Coder host: `receipt-dev` commands, restart sequence, repairs. | Kentron-internal | Contains an IP address and a cloud account id. | none | DO NOT PUBLISH |
| `packages/receipt-app/src/services/factory/sims/README.md` | 43.9 KB | 2026-09-05 | Every deterministic simulation runner and the entropy/clock/scheduler rules. | developer | — | 6 | SAFE |
| `receipt/README.md` | 0.7 KB | 2026-06-26 | The worker workbench: `./receipt/bin/receipt-workbench show` materialises `receipt/current/` (gitignored). | developer (agent) | — | 6 | SAFE |
| `receipt/skills/index.json` | 0.1 KB | 2026-06-17 | Empty skill selection manifest `{schemaVersion:1, kind:"receipt-workbench-skills", selected:[]}`. | agent | — | none | SAFE |

### 1.6 `skills/*/SKILL.md` (25)

| Path | Size | Last commit | What it documents | Audience | Staleness / notes | Sections | Status |
|---|---|---|---|---|---|---|---|
| `add-receipt-nango-integration` | 7.4 KB | 2026-07-31 | Recipe for adding a provider through Nango: prove support, choose execution shape, implement the Receipt slice, verify. | developer | — | 5, 6 | SAFE |
| `deploy-beetle-aws-lite` | 5.5 KB | 2026-09-01 | Guarded live rollout to the single-host stack. | Kentron-internal | — | none | DO NOT PUBLISH |
| `factory-agent-cli` | 9.2 KB | 2026-09-01 | `receipt factory agent …` envelope and computer commands, AWS wrappers, Zero checks, usage rules. | developer | Named staff actor default. | 6 | CARE |
| `factory-aws-cli-cookbook` | 1.4 KB | 2026-04-16 | AWS CLI defaults (`AWS_PAGER=''`, `AWS_MAX_ATTEMPTS=1`, …) for helpers. | developer (worker) | — | none | SAFE |
| `factory-aws-prod-runbook` | 16.6 KB | 2026-09-01 | Hosted AWS probe runbook incl. actor discovery via an ECS one-off SQL task. | Kentron-internal | Account id, cluster name, named actor. | none | DO NOT PUBLISH |
| `factory-aws-rds-objective-debug` | 8.7 KB | 2026-09-01 | Read-only local-vs-hosted debug path for objectives, RDS, CloudWatch. | Kentron-internal | Named staff actor. | none | DO NOT PUBLISH |
| `factory-confluence-connected-system` | 2.5 KB | 2026-07-12 | Worker rules for Confluence via Receipt Connect; output table shape. | developer (worker) | — | none | SAFE |
| `factory-connected-systems` | 5.6 KB | 2026-09-04 | Worker rules for connected systems: the single-execution write workflow and per-provider notes. | developer (worker) | — | 2 | SAFE |
| `factory-deep-research` | 2.8 KB | 2026-05-19 | Research contract and evidence rules for deep-research objectives. | developer (worker) | — | 1 (background runs: what research does) | SAFE |
| `factory-helper-authoring` | 1.7 KB | 2026-04-24 | How to add a Python helper (`manifest.json` + `run.py`). | developer | — | none | SAFE |
| `factory-helper-runtime` | 4.4 KB | 2026-06-01 | `runner.py` usage, catalog layout, manifest/result contracts. | developer | — | none | SAFE |
| `factory-infrastructure-aws` | 5.1 KB | 2026-05-30 | AWS defaults and investigation rules for the infrastructure worker. | developer (worker) | Still says "profile is `infrastructure`" (collapsed to `receipt`). | none | SAFE |
| `factory-organization-skill-catalog` | 1.3 KB | 2026-08-12 | Read `receipt/skills/index.json`; org skills mount read-only under `receipt/skills/organization/`. | developer (worker) | — | 2 (org skills) | SAFE |
| `factory-pr-publisher` | 2.8 KB | 2026-05-20 | Publisher worker: push, `gh pr create`, strict JSON return. | developer (worker) | — | 6 | SAFE |
| `factory-prod-run-debug` | 7.8 KB | 2026-09-01 | Hosted job debug from a local checkout (ECS role services, log groups). | Kentron-internal | — | none | DO NOT PUBLISH |
| `factory-prod-trace-debug` | 3.4 KB | 2026-09-01 | `scripts/prod-debug-trace.mjs` usage for trace ids. | Kentron-internal | — | none | DO NOT PUBLISH |
| `factory-receipt-worker` | 4.9 KB | 2026-06-21 | Worker first pass and rules inside a task worktree; references four `references/*.md` (exist). | developer (worker) | — | 6 | SAFE |
| `factory-run-orchestrator` | 2.8 KB | 2026-06-07 | Supervising profile rules (`factory.status`, `factory.receipts`, …). | developer | Tool names look pre-supervisor era. | none | SAFE |
| `factory-workspace-operator` | 2.5 KB | 2026-05-19 | Broad "build me X" operator objectives; mentions Lima provenance. | developer | "Lima" is a retired provider (only OpenSandbox exists). | none | SAFE |
| `receipt-chat-onboarding` | 2.9 KB | 2026-08-25 | User-facing guidance: Organization Settings > Integrations for Beetle chat/Slack vs MCP Gateway for CLI/MCP; `receipt mcp config generic --output receipt-mcp.json`; "Needs attention" → "Reconnect integration". | end user | Uses the Beetle name for chat. | 1 (connect an app), 2 (MCP gateway), 3 | SAFE |
| `receipt-connect-cli-prod-debug` | 11.1 KB | 2026-09-07 | Three-binaries-one-path table, public-CLI symptom→cause table, hosted checks via SSM, container env names. | Kentron-internal / self-hoster | Names an IAM user. | 3 (symptom table) | CARE |
| `receipt-integration-worker` | 3.9 KB | 2026-07-31 | Connector implementation contract and verification standard. | developer | — | 6 | SAFE |
| `receipt-production-analytics` | 2.7 KB | 2026-08-06 | The `aws_receipt_production_user_analytics` helper and reporting rules (no emails/message text). | Kentron-internal | — | none | DO NOT PUBLISH |
| `receipt-zero-analyzer` | 3.9 KB | 2026-09-01 | `zero:analyze` local (session-minted token) and hosted (`ZERO_ADMIN_PASSWORD`, cookie/token) workflows; probe list. | developer | — | 6 | CARE (hosted half) |
| `repo-software` | 2.2 KB | 2026-04-16 | Codebase map for workers; `.receipt/config.json` can override defaults. | developer | Lists `src/modules/` etc. relative to the package. | 6 | SAFE |

---

## 2. Facts of note (docs-worthy, with sources and conflicts)

Facts are grouped by public section. **[CONFLICT]** marks disagreements writers must settle against code (the code citation given is the current truth at HEAD).

### Toolchain and versions
- Bun is pinned to exactly `1.3.12` by `.bun-version`; Node `24` by `.nvmrc`; always run repo commands through `./bunw`, which installs an isolated copy under `.bun/toolchains/` when the global one differs (`AGENTS.md:55-62`, `docs/LOCAL_SETUP.md:107-117`). `RECEIPT_BUN_AUTO_INSTALL=0` disables downloads; `RECEIPT_BUN_BIN` points at an exact binary (`AGENTS.md:61-62`).
- Postgres 16 with `wal_level=logical` and `pg_trgm` (`docker-compose.postgres.yml:13`). **[CONFLICT]** `docs/GLOSSARY.md:391` says PostgreSQL 17; `docs/deploy/neon-to-aws-zero-migration.md:222` recommends RDS PG17 for hosted.
- Zero image default `rocicorp/zero:1.5.0` (`sst.config.ts:421`). Zero requires Postgres 15+ and a direct writer for `ZERO_UPSTREAM_DB` — never a pooler/proxy/reader (`docs/deploy/neon-to-aws-zero-migration.md:88-102`).
- Resonate broker floor `>= 0.9.7` enforced at `scripts/start-resonate-runtime.mjs:273`; resolved as `RESONATE_BIN`, then `resonate-server`, then `resonate` (`docs/LOCAL_SETUP.md:1243-1247`). **[CONFLICT]** `deploy/Dockerfile.receipt:5` still pins `RESONATE_VERSION=0.9.5`; `deploy/coder/template/build/Dockerfile:51` uses 0.9.8.
- Nango self-hosted image `nangohq/nango-server:hosted-0.69.48` (`deploy/Dockerfile.nango:1`) and CLI `0.69.48` (`nango-integrations/package.json:14`).
- OpenSandbox: controller `opensandbox-server==0.2.2` via `uvx`, client `@alibaba-group/opensandbox@0.1.7`, guest image built locally as `receiptfactory/opensandbox-worker:local` (~6.8 GB) (`docs/LOCAL_SETUP.md:436-446`). Local controller runs unauthenticated (`OPENSANDBOX_INSECURE_SERVER=YES`) — keep 8080 on loopback (`:499-501`).
- Codex comes from `CODEX_VERSION` in images (`deploy/Dockerfile.receipt:44`); `LOCAL_SETUP.md:98` suggests `@openai/codex@0.130.0` locally, the worker image reported `0.153.4` (`:1249-1255`).

### Ports (repo defaults; verified in `scripts/start-all.mjs:60-98` and `apps/start/scripts/dev-with-receipt.mjs:48-56`)
- Web/gateway 3000, web internal 3001 (`start:all` only), Nango 3003, Nango Connect UI 3009, Slack 3010, Teams 3011, Zero 4848 (+4849 change-streamer), Postgres 5432, Redis 6380, runtime 8787, Resonate 8001 (metrics 9090), OpenSandbox 8080, mock LLM 8789, TanStack devtools 42069. `DEVELOPMENT.md:280-282` documents only three of these.
- `BETTER_AUTH_URL` and `VITE_BETTER_AUTH_URL` must equal the origin the browser uses or sign-in silently breaks (`docs/LOCAL_SETUP.md:1050-1061`).

### Environment (self-hosting configuration)
- Hard import-time requirements: `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `ZERO_UPSTREAM_DB` (`docs/LOCAL_SETUP.md:229-238`). Practical minimum adds `VITE_BETTER_AUTH_URL`, `VITE_ZERO_CACHE_URL`, `BYOK_ENCRYPTION_KEY_B64` (32 bytes, never rotate), `RECEIPT_CONNECTION_ENCRYPTION_KEY_B64`, `RECEIPT_CONNECT_JWT_SECRET` (shared by web and runtime), `VITE_ENABLE_EMBEDDING=false`, `VITE_DISABLE_REDIS=true`, `AUTH_EMAIL_PROVIDER=disabled` (`:246-323`). There is no central env schema; mistakes surface lazily (`:224-226`).
- Model keys are organization-scoped BYOK rows, not `OPENAI_API_KEY`; the process-wide key is only platform-credit fallback (`docs/LOCAL_SETUP.md:279-292`, `AGENTS.md:79`). **[CONFLICT]** `DEVELOPMENT.md:122-128` and `README.md` quick starts still tell users to set `OPENAI_API_KEY`; `.env.example` section 4 labels `AI_GATEWAY_API_KEY`/`ANTHROPIC_API_KEY` as required for chat but neither is read (`LOCAL_SETUP.md:1162-1166`).
- `AUTH_DEV_EMAIL_OTP_TO_CONSOLE` is documented in `.env.example` but unimplemented (`docs/LOCAL_SETUP.md:1167-1168`).
- Sign-up email OTP is skipped in `dev`; `start:all` exports `VITE_DISABLE_EMAIL_VERIFICATION_OTP=1` unless `START_ALL_USE_SIGNUP_EMAIL_OTP=1` (`DEVELOPMENT.md:210`); production deploys refuse the bypass (`docs/prod-readiness-metrics.md:191-194`).
- `VITE_*` values are inlined at build time; a change needs a rebuild run inside `apps/start`, because `turbo.json` `envMode: "strict"` drops unlisted variables from the root build (`docs/LOCAL_SETUP.md:847`, `:867-881`).
- Receipt Connect provider env is `RECEIPT_INTEGRATIONS_PROVIDER|URL|PUBLIC_URL|DATABASE_URL|SECRET_KEY|WEBHOOK_SECRET`; `RECEIPT_CONNECT_NANGO_*`/`NANGO_*` names are rejected (`docs/receipt-connect-nango.md:66-85`, `:161-165`). Per-provider overrides are `RECEIPT_NANGO_<PROVIDER>_INTEGRATION_ID|_PROVIDER|_SCOPES|_CLIENT_ID|_CLIENT_SECRET` (`:87-147`); GitHub defaults to `repo,read:org,read:user` because a null scope set silently grants "public data only" (`:525-532`).
- OAuth callback for self-hosted Nango is `https://<public-receipt-host>/oauth/callback`, never `api.nango.dev` (`docs/receipt-connect-nango.md:653-665`); Nango webhook is `/connect/nango/webhook` (`:174`).
- Runtime knobs: `JOB_LEASE_MS` default 300000, `CODEX_JOB_LEASE_MS` 900000, `FACTORY_CONTROL_JOB_LEASE_MS` 900000 (`packages/receipt-app/src/adapters/resonate-config.ts:23,107-108`); `CODEX_JOB_CONCURRENCY` 1, `ORCHESTRATION_JOB_CONCURRENCY` 1, `CHAT_JOB_CONCURRENCY` 4 (`adapters/resonate-runtime.ts:102-106`). **[CONFLICT]** `docs/api/config.md:7-14` lists `JOB_POLL_MS=100`, `JOB_LEASE_MS=30000`, `JOB_CONCURRENCY=2`, `JOB_LEASE_GRACE_MS`, `JOB_WORKER_ID`, `HEARTBEAT_<AGENT>_INTERVAL_MS` — none of those except `JOB_LEASE_MS` are read from `process.env` in `packages/receipt-app/src`.
- Model defaults: `OPENAI_MODEL` → `gpt-5.6-luna` (`adapters/openai.ts:12`), task Codex model `gpt-5.6-luna` (`services/factory/runtime/factory-service-config.ts:8`), objective supervisor `gpt-5.6-terra` (`objective-supervisor-runner.ts:111`); `RECEIPT_FACTORY_SUPERVISOR_MODEL` is the backward-compatible override (`docs/api/config.md:69-70`).
- `DATA_DIR` defaults to `<cwd>/.receipt/data`; `PORT` 8787 (`docs/api/config.md:7-8`). The checked-in `.receipt/config.json` sets `maxActiveTasks: 20`, `maxTaskRuns: 50`, `maxCandidatePassesPerTask: 4`, `maxObjectiveMinutes: 1440`, `mutationCooldownMs: 15000`.
- Slack service env: `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`, `RECEIPT_SERVER_URL`, `RECEIPT_WEB_URL`; optional `SLACK_PROGRESS_UPDATE_INTERVAL_MS` (20000), `SLACK_MAX_PROGRESS_MESSAGES_PER_RUN` (12), `SLACK_DEFAULT_PROFILE_ID` (`receipt`) — `apps/slack/server.ts:96-105`.
- Teams service env is `CLIENT_ID`, `CLIENT_SECRET`, `TENANT_ID` (`apps/teams/server.ts:19`). **[CONFLICT]** `docs/ms-teams-testing-setup.md:37-39` says `TEAMS_CLIENT_ID` etc. Packaging uses `TEAMS_BOT_ID`, `TEAMS_APP_ID`, `TEAMS_APP_VERSION`, `RECEIPT_WEB_URL` → `dist/receipt-teams-app.zip`.
- `RECEIPT_LEGACY_PUBLIC_ORIGINS` (validated HTTPS only) feeds Better Auth trusted origins (`auth.service.ts:454`).

### Ordering rules and gotchas (local development)
- First-run order: `./bunw install` → copy `.env.example` → Postgres compose → Zero native binding (`npm run install` inside `@rocicorp/zero-sqlite3`, hoisted path under `node_modules/.bun/...`) → `./bunw run --cwd apps/start i18n:compile` (**must precede** `web:db:reset` because the Better Auth migrator imports the compiled i18n bundle) → `./bunw run web:db:reset` (destructive) → `./bunw run dev` (`AGENTS.md:66-77`, `docs/LOCAL_SETUP.md:349-354`).
- Three entry points are not interchangeable: `dev` (Vite HMR + runtime `--watch`, no Nango/OpenSandbox/gateway), `start:all` (production web build, supervisor, logs under `.deploy-artifacts/start-all/<runId>/`), `local:up` (superset: writes `.deploy-artifacts/local-up/latest.env`, may run the destructive reset unless `LOCAL_UP_DB_RESET=0`, forces `RECEIPT_FACTORY_COMPUTER_PROVIDER=opensandbox`) (`docs/LOCAL_SETUP.md:519-578`). They cannot run concurrently (`:889-890`).
- `local-up.sh` never reads `.env.local`; export the file into the shell first and set `LOCAL_UP_ZERO_UPSTREAM_DB` (`docs/LOCAL_SETUP.md:628-641`). Compose reads `START_ALL_POSTGRES_PORT` from the shell, not from any env file.
- Nothing in `local:up` hot-reloads; the change→action table in `docs/LOCAL_SETUP.md:835-855` is the authoritative reload guide (kill the `api` role for runtime handlers; `receipt:build` for runtime client assets; full restart for `apps/start`).
- Never `kill -9` the `start-all` supervisor — children are spawned detached and survive (RCA-209; `docs/LOCAL_SETUP.md:735-747`). Zero's change-streamer holds port+1 and can orphan (`:759-770`).
- Zero replicates only tables in the `zero_data` publication; a schema table missing from it silently breaks all client sync (RCA-001; `AGENTS.md:3-6`). Logical replication does not backfill a newly published table — `zero:reset` forces a full sync (`docs/LOCAL_SETUP.md:863-865`). Zero migrations are timestamped SQL files (51 at HEAD under `apps/start/zero/migrations`); never edit an applied one (`:849`).
- `validate:stack` refuses to start below 8 GiB free disk (`scripts/validate-stack.sh:72`), seeds an isolated `receipt_validate_stack` schema, and gates on `/readyz` (`docs/LOCAL_SETUP.md:912-913`, `:946-951`); `VALIDATE_STACK_CODEX_MODE=stub` is not a deploy gate (`AGENTS.md:90`).
- In-repo `receipt doctor`: missing `bun`, `git`, `codex` or an invalid repo is blocking; missing `gh`/`aws` warns; it does not validate a model key (`docs/LOCAL_SETUP.md:931-937`).
- Mock LLM: `./bunw run llm:mock` on 8789; `MOCK_OPENAI_API_KEY` is honoured only when `OPENAI_BASE_URL` is loopback; `RECEIPT_MOCK_LLM_FAILURES=429,400,malformed,timeout`; `RECEIPT_MOCK_LLM_SCRIPT` fixtures (`DEVELOPMENT.md:130-143`).
- Docker is mandatory beyond the plain web app (Nango is only a patched container; OpenSandbox *is* Docker); `deploy/Dockerfile.receipt:46` hard-codes an x86_64 Resonate tarball so it cannot build natively on Apple Silicon (`docs/LOCAL_SETUP.md:379-403`).
- Never `docker compose … down -v` or `docker volume rm receipt_receipt_postgres_data` (doubled prefix) for a routine stop; it deletes users, receipts, BYOK keys and the Nango database (`docs/LOCAL_SETUP.md:790-803`).

### Factory and runtime facts (developer sections)
- `FactoryExecutionPath` has exactly one value, `"computer"`, and the only computer provider is `opensandbox`; there is no non-sandboxed fallback (`packages/receipt-app/src/modules/factory/types.ts:87-97`, `docs/LOCAL_SETUP.md:197-200`).
- Queue lanes are `chat | collect | steer | follow_up` (`packages/receipt-app/src/modules/job.ts:7-8`). **[CONFLICT]** `architecture.md:110-113`, `docs/api/streams.md:50-53` and `docs/api/http.md:33` list only `collect/steer/follow_up`; `docs/api/config.md:44,59` and the Slack playbook use `lane: "chat"`.
- Singleton modes `allow | cancel | steer` (`docs/api/http.md:36`); in-flight commands `steer | follow_up | abort` (`docs/api/streams.md:45-48`).
- Job lifecycle `queued → leased → running → completed|failed|canceled`; display maps `leased→running` (`docs/receipt-contract-standardization.md:51-55`).
- Objective statuses: `planning, waiting_for_slot, collecting_evidence, evidence_ready, synthesizing, executing, integrating, promoting, completed, blocked, failed, canceled`; terminal = `completed|failed|canceled`; `blocked` stops work but is recoverable (`status-contract.ts:8-38`, `docs/receipt-contract-standardization.md:70-83`). Task statuses `pending, ready, running, reviewing, approved, integrated, blocked, superseded` (`status-contract.ts:49-58`). Candidate statuses `planned, running, awaiting_review, changes_requested, approved, integrated, rejected, conflicted`; integration `idle, queued, merging, validating, ready_to_promote, promoting, promoted, conflicted` (`docs/factory-on-receipt.md:375-395`).
- Stream families: `factory/objectives/<id>`, `jobs`, `jobs/<jobId>`, `memory/<scope>`, `agents/factory/<repoKey>/receipt/sessions/<chatId>[/runs/<runId>]`, `apps/start/<repoKey>/app-chat/sessions/<threadId>[/runs/<runId>]`, computer capacity `factory/resources/computer/opensandbox/organizations/<org>` (`docs/factory-on-receipt.md:289-302`, `docs/LOCAL_SETUP.md:491-495`).
- Task packet: 13 `<workspace>/.receipt/factory/<taskId>.*` files (`docs/factory-agent-orchestration.md:243-263`), archived under `<DATA_DIR>/factory/task-packets/<jobId>/` (`docs/receipt-dst.md:234-240`), projected to `receipt/current/*` inside a worktree.
- Codex result contract: `{ outcome: "approved"|"changes_requested"|"blocked"|"partial", summary, artifacts[], nextAction }`; delivery results must also carry an `alignment` block with verdict `aligned|uncertain|drifted` (`docs/factory-on-receipt.md:726-737`, `docs/factory-self-improvement.md:90-98`); one corrective pass then hard stop (`:118-126`).
- Memory scopes: `factory/agents/<workerType>`, `factory/repo/shared` (read-only to workers), `factory/objectives/<id>[/tasks/…|/candidates/…|/integration|/publish]`, `factory/audits/…`; preferences under `users/default/preferences` (`docs/memory.md:238-242`, `:274-286`).
- Git model: task branch `hub/<workerType>/<workspaceId>`, integration branch `hub/integration/factory_integration_<objectiveId>`; promotion fast-forwards source; no candidate promotes directly (`docs/factory-on-receipt.md:831-848`).
- Runtime HTTP: `GET /healthz` always 200 with readiness in the body; `GET /readyz` 503 when Postgres is unreachable; `POST /agents/:id/jobs` → 202 proves only the enqueue receipt (`docs/agent-framework-integrations.md:104-108`); `GET /jobs/:id/wait?timeoutMs=` clamps 0..120000 default 15000; SSE `ping` every 5 s (`docs/api/sse.md:9`).

### Public CLI (section 3)
- Distribution: a GitHub Release binary from the public `receipt-cli` repository, installed by `install.sh` to `~/.local/bin/receipt` (macOS/Linux, arm64/x86-64, SHA-256 verified); no npm, Homebrew or Windows; the npm package `receipt` is unrelated (`docs/receipt-cli.md:9-18`). Pin a tag with `RECEIPT_CLI_VERSION=<tag>`.
- `v0.1.0-preview.6` (2026-09-05) cannot onboard a fresh machine; `v0.1.0-preview.7` bakes the hosted origin, adds `login`/`logout`/read-only `doctor`, refuses expired sessions and lets `connect` reuse the session — but as of 2026-09-07 it was **not yet published** and `install.sh` still pinned preview.6 (`docs/receipt-cli.md:20-28`, `docs/receipt-cli-debug-report.md:236-240`).
- Session JWT lives 12 hours (`packages/receipt-app/src/services/receipt-connect-auth-token.ts:24`); saved under `~/.receipt/session.json` plus `session.<target>.json`, mode 0600; the most recent `setup` decides which target `mcp`, `workspace`, `tools` use (`docs/receipt-cli.md:73-77`, `skills/receipt-connect-cli-prod-debug/SKILL.md:62`).
- Three programs install to the same path: the public compiled binary (no `login` before preview.7), the operator CLI from `scripts/install-receipt-cli.sh` (has `login`), and the repo wrapper `.receipt/bin/receipt` (`skills/receipt-connect-cli-prod-debug/SKILL.md:20-41`). Both entrypoints now have `login` (`packages/receipt-app/src/cli/commands.ts:2287`, `connect-cli.ts:1136-1144`).
- `local` target defaults to `http://127.0.0.1:8787` (runtime) and `http://127.0.0.1:3000` (web origin); override with `RECEIPT_CONNECT_LOCAL_SERVER_URL` and `RECEIPT_CONNECT_LOCAL_AUTH_URL`, and the auth URL must be the browser origin (`docs/receipt-cli.md:198-210`). `RECEIPT_CONNECT_TOKEN`/`RECEIPT_CONNECT_GATEWAY_URL` are for sandboxes/CI and take precedence (`:98-101`).
- Verb list: `doctor [--json] [--target prod|dev|local]`, `login [target|url]`, `logout`, `setup [--json|--no-login|--no-background|--no-observer|--no-claude|--fresh-login|--target]`, `connect setup|list|tools|call|status|disconnect|<provider>`, `workspace list|current|create|rename|use|delete`, `tools list|describe|call`, `mcp config|install|status|remove|serve`, `observe clauden [install|status|stop|start|uninstall]`, `import clauden` (`docs/receipt-cli.md`, `docs/api/cli.md`, `docs/receipt-real-workspaces-dev-handoff.md:164-181`). Managed MCP install supports Codex only; other clients use `mcp config generic` (`docs/ai-agent-receipt-cli.md:257-259`).
- MCP: `receipt mcp serve` is a token-free stdio bridge that reads the 0600 session at start; `POST /connect/mcp` negotiated protocol `2025-11-25`; unauthenticated returns 401; `tools/list` is empty until a provider is connected — that is correct behaviour, not a defect (`docs/receipt-cli-debug-report.md:127-149`).
- Claude observer defaults to `--mode metadata` (redacts prompt/response fields); `--mode full` captures bodies; installs a launchd agent or systemd user service (`docs/api/cli.md:137-198`).
- Receipt never injects `AWS_ACCESS_KEY_ID` or raw tokens into Codex environments (`docs/receipt-cli.md:230-233`); `receipt connect call <conn> --path /…` is GET-only and the fixed `read-provider-resource` tool bounds responses to 5 MiB (`docs/receipt-real-workspaces-dev-handoff.md:353-362`).

### Platform facts (section 2)
- Workspace = isolation boundary for connections and tools; organization = billing/membership; every org gets a deterministic `Default` workspace with id `ws_ + lowercase_hex(md5(organizationId))` that cannot be deleted; workspaces with connections cannot be deleted; tokens carry `ws_id` and legacy tokens resolve to Default (`docs/receipt-real-workspaces-dev-handoff.md:66-76`, `:104-107`, `:374-392`).
- Workspace API: `GET/POST /connect/workspaces`, `PATCH/DELETE /connect/workspaces/:id`, `POST /connect/workspaces/:id/token` (`:118-124`); `connect:read` vs `connect:write` scopes (`:37-44`).
- Writes are default-denied and require both a `connect:write` token and per-connection admin enablement stored as `receipt_action_policy` in Nango metadata; GitHub repository allowlists are `receipt_github_repository_policy` and are enforced by the proxy (`docs/receipt-connect-nango.md:222-247`).
- Honest connector labels: `Typed tools`, `Dynamic review`, `Compatibility read`, `Runtime CLI`, `Authentication only`, `Setup required` (`docs/receipt-cli-mcp-implementation-plan.md:122-124`, `docs/receipt-integration-surface-audit.md:272-273`).
- Organization skills mount at `receipt/skills/organization/` with `receipt/skills/index.json` (`skills/factory-organization-skill-catalog/SKILL.md:14-25`).
- Slack: scopes `app_mentions:read, channels:history, chat:write, reactions:write, users:read, users:read.email` (`packages/receipt-core/src/slack.ts:4-9`); one team ↔ one org; email-less workspaces get "Receipt needs access to your Slack email before it can add you to this workspace. Ask a Receipt admin to reinstall Slack with `users:read.email`, then mention Receipt again." (`apps/slack/server.ts:599`); the Nango Slack connector and the Slack channel app are separate surfaces (`docs/receipt-cli.md:154-158`).
- Teams: first-party single-tenant Azure bot with only the Teams `identity` permission; admin upload needs no Store review; a workspace admin binds the tenant through a claim link (`docs/teams-app-private-distribution.md`).
- Agency analytics connectors are read-only; Google Ads needs `GOOGLE_ADS_DEVELOPER_TOKEN` in Nango environment settings; unpublished Google consent screens expire refresh tokens after seven days (`docs/agency-analytics-nango-enablement.md:84-95`, `:121-122`).
- Data-handling facts: Receipt stores only encrypted Nango references in `org_connection_secret` (AES-256-GCM, key version 1); provider credentials stay in Nango; Zero publishes sanitized columns only (`docs/receipt-connect-nango.md:16-19`, `docs/receipt-real-workspaces-dev-handoff.md:64-66`, `:386-388`). Exception: `aws-credential-process` and `github-token` imports are held encrypted by Receipt (prior corpus, `10-integrations-connect-mcp.md`; verify in `receipt-connect-connections.ts`).

### Deployment facts (section 5)
- The hosted app runs as "Receipt Lite": one EC2 host with Caddy → `gateway:3000` → `runtime-api:8787`, RDS Postgres, and a separate OpenSandbox host; the full SST/Fargate `production` stage exists but is not the routine path (`docs/deploy/aws-sst-onboarding.md:6-41`, `docs/receipt-cli-debug-report.md:75-79`). Neither runbook should be published, but the self-hosting overview may say the reference deployment is a single Docker Compose host plus managed Postgres.
- The SST entrypoint deploys `receipt-gateway`, `receipt-zero-cache`, `receipt-runtime`, `receipt-resonate`, `receipt-integrations` (Nango), `receipt-slack`, `receipt-opensandbox`, RDS, Redis/Valkey, EFS (`README.md:68-78`); worker roles are selected by `RECEIPT_PROCESS_ROLE=driver|worker-control|worker-chat|worker-codex` (`skills/factory-prod-run-debug/SKILL.md:48-53`).
- Deploy guards: `RECEIPT_AWS_FACTORY_ACCOUNT_ID`/`RECEIPT_AWS_PRODUCTION_ACCOUNT_ID`, `RECEIPT_ALLOW_IAM_USER_*=1`, `RECEIPT_SKIP_LOCAL_VALIDATION_GUARD=1` (break-glass), `RECEIPT_AWS_ACCOUNT_GUARD=0` (emergency) (`docs/deploy/aws-sst-onboarding.md:141-168`, `:321-328`); production requires `AUTH_EMAIL_PROVIDER=ses`, `VITE_DISABLE_EMAIL_VERIFICATION_OTP=false` and a non-factory HTTPS origin (`docs/prod-readiness-metrics.md:186-194`).
- RDS logical replication must be enabled in the parameter group and may need a reboot (`README.md:107`); `ZERO_APP_PUBLICATIONS=zero_data`; extra tables via `ZERO_PUBLICATION_EXTRA_TABLES` (`docs/deploy/neon-to-aws-zero-migration.md:126-129`).
- Hostname cutover from `beetle.run` to `app.kentron.ai` went live 2026-09-02 with dual-host compatibility; marketing apex stays on Vercel; a product rebrand is explicitly a separate change (`docs/deploy/app-kentron-ai-cutover-todo.md:30-74`, `:369-376`).

### Other conflicts and stale references to resolve
- Absent paths still referenced: `reference/` (README.md:127, AGENTS.md:14), root `src/agents` (docs/agent-framework.md:66), `skills/receipt-cli-operator/SKILL.md` (docs/api/cli.md:20).
- Profile ids `infrastructure`/`software` (docs/factory-infra-real-data-eval.md:191, docs/api/config.md:47) were collapsed into the single `receipt` profile (`docs/factory-on-receipt.md:66`); check whether `--profile` still accepts them.
- Connector counts: 63 slugs in `catalog.json` vs 61 (surface audit), 58 (evidence, CLI plan), 62 (prior corpus).

---

## 3. Glossary

One line each; (G) = defined in `docs/GLOSSARY.md`, otherwise the cited file.

| Term | Definition | Source |
|---|---|---|
| Receipt | An immutable, hash-chained record that "this happened"; also the runtime that stores them and derives all state by folding them. | `architecture.md:3-15`, G |
| Stream | A named, ordered sequence of receipts (`factory/objectives/<id>`, `jobs/<jobId>`); one receipt belongs to one stream. | G |
| Chain / prev / hash / hints | Each receipt hashes the previous hash (`expectedPrev` guards appends); hints are non-authoritative metadata excluded from the hash. | G |
| Fold / reducer / replay | Pure `(state, receipt) → state`; replay re-folds a chain prefix deterministically under pinned versions. | G, `architecture.md:76-81` |
| Projection / projector | A rebuildable read model (in-memory or a `receipt_*_projection` table) maintained by a projector that advances a `global_seq` watermark; never authoritative. | G, `AGENTS.md:20-25` |
| Branch / fork | A sibling stream forked at an index (`receipt fork --at N`); metadata in `__meta/branches`. | `docs/api/cli.md:294-303` |
| Merge / rebracket | Deterministic scoring of competing next effects, recorded as `rebracket.applied` / `merge.applied`. | G, `docs/factory-on-receipt.md:661-682` |
| DST | `receipt dst`: integrity, replayability and deterministic-stability audit; `--context` audits Factory packets. | `docs/receipt-dst.md` |
| Factory | The receipt-native control plane: objective → task DAG → workers → candidates → integration → validation → promotion. | `architecture.md:17-21` |
| Beetle | Brand name and chat persona; in code the canonical term is Factory. | G:152-154 |
| Objective | Top unit of Factory work; one per repo holds the execution slot; modes `delivery`/`investigation`, severity 1-5. | G, `docs/api/cli.md:407-408` |
| Task | A focused piece of an objective with `dependsOn` and `workerType`; approved tasks unlock dependents before integration. | `status-contract.ts:49-58`, `factory-on-receipt.md:473-478` |
| Candidate | One attempt at a task (`task_<id>_candidate_<nn>`) with `parentCandidateId` lineage. | `docs/factory-on-receipt.md:890-898` |
| Integration / promotion | Approved candidates merge into `hub/integration/factory_integration_<objectiveId>`, are validated, then source fast-forwards to that head. | `docs/factory-on-receipt.md:837-848` |
| Job | A receipt-backed unit of queued work (`kind`, lane, `maxAttempts`, lease); lifecycle `queued→leased→running→completed|failed|canceled`. | G, `receipt-contract-standardization.md:51-55` |
| Lane | Queue class selecting the worker pool: `chat`, `collect`, `steer`, `follow_up`. | `modules/job.ts:7-8` |
| Singleton mode | Treatment of an existing job with the same `sessionKey`: `allow`, `cancel`, `steer`. | `docs/api/http.md:36` |
| Lease / heartbeat | Time-bounded worker claim on a job; silence lets it lapse (`job.lease_expired`). | G |
| Queue command | In-flight `steer`, `follow_up` or `abort` recorded as `queue.command`. | `docs/api/streams.md:42-48` |
| Outbox | Durable intent receipt (`*.requested`) separated from its side effect and ack (`*.enqueued` / `*.enqueue_failed`). | `factory-durable-execution-architecture.md:9-36` |
| Resonate | Durable execution/wake-up engine; schedules work, never owns state. | G, same doc `:30` |
| Worker roles | Runtime processes `api`, `driver`, `worker-control`, `worker-chat`, `worker-codex` (`RECEIPT_PROCESS_ROLE`). | `docs/LOCAL_SETUP.md:158` |
| Watchdog / redrive | Scanners that detect stalled work and re-dispatch durable outbox requests. | G |
| Computer path / OpenSandbox | The only Factory execution path; the worker runs in an OpenSandbox container leased per org (`computer.lease.*`), capped by `OPEN_SANDBOX_*_MAX_ACTIVE` (default 1). | `modules/factory/types.ts:87-97`, `scripts/start-all.mjs:376-377` |
| Codex | Default task worker (`codex -a never exec …`) inside the sandbox; a bounded worker, not the orchestrator. | G, `docs/LOCAL_SETUP.md:201-203` |
| Objective supervisor | The only iterative semantic controller; picks `continue|apply_plan|synthesize|block` at receipt-derived boundaries. | `factory-agent-orchestration.md:97-106` |
| App router | One-shot chat model call returning `chat` (direct answer) or `factory`. | `docs/ai-prompt-catalog.md:87-105` |
| Ingress (`factory.dispatch`) / handoff | The prompt-free adapter recording one create/react/control command; handoff returns the terminal objective to the user. | G section E |
| Probe | Read-only single-provider objective class: 5-minute timeout, 2-minute stall threshold. | `factory-agent-orchestration.md:583-590` |
| Task packet / context pack / manifest / receipt CLI surface | Generated worker handoff files `.receipt/factory/<taskId>.*` (or `receipt/current/*`). | `docs/context-management.md:262-391` |
| Memory scope | Receipt-backed region `memory/<scope>` with `read/search/summarize/commit/diff/reindex`. | `docs/memory.md` |
| Envelope / artifactRefs / nextCommands | Versioned JSON from `receipt factory agent …`; follow refs for large files and next commands for safe continuation. | `skills/factory-agent-cli/SKILL.md:8` |
| Helper | Checked-in Python CLI under `skills/factory-helper-runtime/catalog/` run by `runner.py`. | `skills/factory-helper-runtime/SKILL.md` |
| Skill / skill bundle | A `SKILL.md` with `name`/`description` frontmatter; org skills are versioned bundles mounted read-only at `receipt/skills/organization/`. | `skills/factory-organization-skill-catalog/SKILL.md` |
| Profile | The single Factory chat profile `receipt`; delivery/investigation/QA are modes under it. | `docs/factory-on-receipt.md:66` |
| Organization | Better Auth tenant for membership, billing, SSO and org-wide controls. | `receipt-real-workspaces-dev-handoff.md:53-54` |
| Workspace | Isolation boundary for connections, tools, CLI sessions and MCP inside an org; `Default` (`ws_<md5(orgId)>`) is automatic and undeletable. | same doc `:53-76` |
| Receipt Connect | The capability system brokering third-party access through Nango without exposing credentials. | G section G |
| Connection | `provider:name` (default `default`); an encrypted reference `org + workspace + provider + name → integrationId + connectionId`. | `docs/receipt-connect-nango.md:311-336` |
| Capability / manifest | A connected-system operation available to a worker, keyed `aws` or `aws.<name>`, status `valid|expired|invalid`, listed by `GET /connect/capabilities`. | same doc `:328-336` |
| Connector / execution surface | A checked-in catalog entry (`provider.json`) exposing `typed-proxy`, `compatibility-read`, `provider-mcp`, `command-auth` or `resource-aware-get`. | `receipt-integration-surface-audit.md:76-83` |
| `read-provider-resource` | The fixed GET-only compatibility tool every ordinary Nango connector publishes. | same doc `:229-233` |
| Action policy | Per-connection enabled write actions (`receipt_action_policy`); reads always on. | `docs/receipt-connect-nango.md:232-239` |
| MCP Gateway | `POST /connect/mcp` (workspace-scoped aggregate MCP) plus the `receipt mcp serve` stdio bridge. | `receipt-real-workspaces-dev-handoff.md:190-197` |
| Nango | Self-hosted OAuth/API-key broker behind Receipt Connect; owns credentials and refresh. | G |
| BYOK / platform credit | Org-scoped encrypted provider keys (`org_provider_api_key`, wrapped by `BYOK_ENCRYPTION_KEY_B64`); platform credit is the process-wide fallback plus a one-time signup credit. | `docs/LOCAL_SETUP.md:279-292` |
| Guardrail group | Versioned set of guardrails with `validate|mutate` operation and an enforcing strategy; authored and testable, not enforced in chat today. | prior corpus `02` (verify) |
| ZDR / chat mode / chat branch | Zero-data-retention model filter; a preset (e.g. Study Mode); a sibling message from edit/regenerate guarded by `expectedBranchVersion`. | G sections I-J |
| Zero / `zero_data` | Rocicorp Zero replicates the curated `zero_data` publication into SQLite and syncs browsers; a table missing from it breaks all sync. | G, `AGENTS.md:3-6` |
| HubGit | The Git adapter owning worktrees, commits, merges and promotion. | G |
| Receipt Lite | The single-host AWS deployment (`factory-lite` stage) serving the hosted app. | `docs/deploy/aws-sst-onboarding.md:8-10` |
| Workbench | `receipt/current/` (worker projection from `receipt-workbench show`) and the `/factory` operator web shell. | `receipt/README.md`, `receipt-runtime-readme.md:248` |
| Clauden | The `receipt-claude-proxy` companion tailing Claude Code events into `imports/clauden/...` receipts. | `docs/api/cli.md:137-198` |

---

## 4. Naming: Beetle, beetle.run, Kentron, GovSig, Singularity, Ironclad, Norix

Counts are files containing the term (docs/markdown; non-test code under `apps`, `packages`, `scripts`, `deploy`, `sst.config.ts`; tests).

| Name | Docs | Code | Tests | How it is used |
|---|---|---|---|---|
| **Beetle** | 16 | 35 | 17 | Product/brand and chat persona. UI: `APP_BRAND_NAME = 'beetle.run'` (`sidebar-organization-menu.tsx:98`), "Beetle Tasks" (`tasks-page.tsx:172`), "Build {integration.name} with Beetle Tasks" (`integrations-page.tsx:544`), "Beetle runners" (`sidebar-computer-capacity.tsx:54`), "Beetle Chat" (`chat-sidebar.tsx:160`). Prompts: "You are the Beetle app chat router.", "User-facing agent name: Beetle." (`docs/ai-prompt-catalog.md:96`, `:214`), "You are Beetle, the product chat profile for beetle.run." (`receipt-chat.service.ts:93`). Operator identifiers: AWS profile `beetle`, CodeBuild `beetle-deploy`, `BEETLE_DEPLOY_STAGE`, `beetle-deploy:*` scripts, skill `deploy-beetle-aws-lite`. GLOSSARY:152-154: brand name; code term is Factory. The rename to Kentron is a separate reviewed change (`app-kentron-ai-cutover-todo.md:369-376`). |
| **beetle.run** | 14 | 19 | 25 | The legacy hosted origin, live until the 2026-09-02 cutover and kept as a dual-host compatibility origin (`docs/deploy/app-kentron-ai-cutover-todo.md:30-74`). Code: marketing landing hostnames `beetle.run`/`www.beetle.run` (`apps/start/src/routes/index.tsx:15`), landing `brandLabel="beetle.run"` (`landing-page.tsx:792`), login-header image alt, navbar sr-only label (`navbar.tsx:42`), `RECEIPT_LEGACY_PUBLIC_ORIGINS` allowlist (`auth.service.ts:454`). Tests deliberately keep it as an arbitrary legacy URL fixture. |
| **Kentron** / kentron | 4 / 23 | 3 / 22 | 6 / 16 | The platform/company: `app.kentron.ai` is the canonical application origin (baked into the public CLI via `RECEIPT_CLI_DEFAULT_PROD_GATEWAY_URL`, `docs/receipt-cli.md:59-61`); `docs.kentron.ai/introduction` is the hard-coded sidebar Docs link (`app-sidebar.tsx:57`); `kentron.ai`/`www.kentron.ai` is the Vercel marketing site; `ADMIN_EMAIL_DOMAIN = 'kentron.ai'` gates the staff admin console unless `ADMIN_EMAIL_ALLOWLIST` is set (`admin-access.server.ts:19-46`); `kentronai` is the GitHub org for `Receipt`, `receipt-cli` and `Norix`. |
| **GovSig** | 0 | 0 | 0 | No occurrence anywhere in the repository (docs, code, tests, config). Do not use it in public docs without an external decision. |
| **Singularity** | 0 | 22 | 4 | EE-only staff admin route group `apps/start/src/routes/(ee)/singularity/` backed by `apps/start/src/ee/singularity/*` (`assertSingularityAccess`, `SingularityOrgListPage`): an organisation-list console; **hidden**, access-gated, undocumented. |
| **Ironclad** | 0 | 3 | 2 | Route `/ironclad` (`routes/(app)/_layout/ironclad/route.tsx`, referenced by the tasks page) and "hosted Factory/Ironclad path" in `scripts/deploy-aws.mjs:1050,1057`; apparently an older name for the Tasks surface; **hidden** — confirm whether it aliases `/tasks`. |
| **Norix / NORIX** | 3 / 1 | 0 / 18 | 0 / 4 | (1) The NORIX design system ported into `packages/tailwind-config/theme.css` and `packages/ui` (`docs/ui-design-system.md:3-4`); (2) the separate `kentronai/Norix` AI-governance repository whose policy patterns the authorization plan borrows (`receipt-authorization-mcp-product-plan.md:744-799`). Neither is a user-facing name. |

Recommendation for the public docs: product = **Receipt**, platform/company = **Kentron**, hosted app = `app.kentron.ai`; mention once that the shipped UI still labels itself "beetle.run"/"Beetle" in the brand mark, the Tasks page, the runners widget and the assistant persona, so screenshots will show those strings until the separately planned rebrand lands.

---

## 5. Feature classification for documented surfaces

| Feature (as described in docs) | Classification at HEAD | Evidence |
|---|---|---|
| Chat with router → direct answer / Factory objective | reachable | `docs/ai-prompt-catalog.md:87-105`, `receipt-chat.service.ts` |
| Factory objectives, tasks, candidates, integration, promotion | reachable (chat, Slack, Teams, CLI) | `docs/factory-on-receipt.md`, `status-contract.ts` |
| `/factory` operator web shell (HTMX) in the runtime | reachable on the runtime port; inspect-only | `docs/api/http.md:141-166` |
| Tasks page ("Beetle Tasks") at `/tasks` and route `/ironclad` | hidden (no sidebar entry per prior corpus; route files exist) | `tasks-page.tsx:172`, `routes/(app)/_layout/ironclad/` |
| Workspaces, MCP Gateway, aggregate tools, `receipt workspace/tools/mcp` | reachable | `docs/receipt-real-workspaces-dev-handoff.md` |
| Public CLI `login/logout/doctor` | implemented in source; **not yet released** as of 2026-09-07 | `docs/receipt-cli.md:20-28`, `connect-cli.ts:1136-1144` |
| Guardrail groups | stubbed (authoring/testing UI exists; no enforcement in chat) | prior corpus `02`; re-verify `guardrail` enforcement call sites |
| "Require organization provider key" compliance toggle | stubbed | prior corpus `02` |
| Plan/feature gating (Plus/Pro) | stubbed (checks return allowed) | prior corpus `02` |
| Two-factor enrollment | absent (sign-in step exists) | prior corpus `01` |
| Desktop (Tauri) app, `receipt desktop serve` | absent | no `apps/desktop` |
| React Native mobile app | absent | `README.md:39` only |
| Python SDK, `POST /receipts`, full-control MCP server | absent | `docs/agent-framework-integrations.md:118-130` |
| Allow/Ask/Never policy, approvals, budgets, remote OAuth MCP | absent (planned) | `docs/receipt-real-workspaces-dev-handoff.md:724-737` |
| Local (non-sandbox) Factory execution | absent | `modules/factory/types.ts:87` |
| Agent Registry with AWS/Azure/GCP inventory | reachable (new since `41baea75`) | commits `26ec975a` … `c3c16be6` |

---

## 6. Exact user-visible strings collected in this pass

Only strings verified in code or in the newest docs are listed; the prior corpus holds the full chat/settings catalogue.

- Brand: `beetle.run` (sidebar org menu `APP_BRAND_NAME`, navbar sr-only label, login image alt); "Beetle Tasks"; "Beetle runners"; "Build {integration.name} with Beetle Tasks".
- Docs link: `https://docs.kentron.ai/introduction` (sidebar footer).
- Slack: "Receipt needs access to your Slack email before it can add you to this workspace. Ask a Receipt admin to reinstall Slack with `users:read.email`, then mention Receipt again."
- Teams health body: `{"ok":true,"configured":true}`; `configured:false` means a Microsoft value is missing.
- Public CLI errors: `receipt connect production URL is not configured yet`; `receipt connect target must be prod, dev, local, or an http(s) URL`; `not signed in; run 'receipt setup' first`; `Receipt Connect gateway is unavailable; set RECEIPT_CONNECT_GATEWAY_URL` (`skills/receipt-connect-cli-prod-debug/SKILL.md:56-65`).
- Runtime: `Unsupported Factory computer provider … OpenSandbox is the only supported provider.` (`docs/LOCAL_SETUP.md:452-453`); `Platform-funded OpenAI access is unavailable` (`:1095`); `Could not locate the bindings file` (Zero); `Resonate CLI … is not compatible with @resonatehq/sdk. Install Resonate >= 0.9.7 or set RESONATE_BIN to a compatible server.` (`scripts/start-resonate-runtime.mjs:273`); `start_all.ready  Local stack is up` (`docs/LOCAL_SETUP.md:673`).

---

## Changes since 41baea75

Forty-three commits. Documentation touched (`git diff --stat 41baea75..HEAD -- '*.md'`): `AGENTS.md` and `CLAUDE.md` (+46 each, the MCP block), `LOCAL_SETUP.md` (new, 1,275 lines; now the untracked `docs/LOCAL_SETUP.md`), `docs/agent-fix-checklist.md` (+425, RCA-519…523), new `docs/projection-durability-fix.md`, `docs/receipt-cli-debug-report.md`, `docs/tool-reliability-fixes-2026-09-05.md` and `skills/receipt-connect-cli-prod-debug/SKILL.md`, a rewritten `docs/receipt-cli.md`, and small edits to `receipt-real-workspaces-dev-handoff.md`, `ui-design-system.md` and the sims README.

Behavioural changes writers should know about (from the commit log and the new docs): the public CLI gained `login`, `logout` and a read-only `doctor`, expiry-aware session reuse, session-aware `connect` commands and a release build that bakes `https://app.kentron.ai` (`3c52d87c`, `9b8b7574`, `53f74bed`) — pending an actual release; Agent Registry (a receipt-backed cloud agent inventory with its own AWS/Azure/GCP connection, EC2 scanning, autonomy filters, Bedrock classification, registry actions, pending workspace invites and a self-hosted sign-up redirect) landed in `26ec975a` … `c3c16be6`; projection work became durable with a separate single-connection projection pool and bounded chat replay (`00ef6f17` … `d62e9136`, `docs/projection-durability-fix.md`); tool-dependency routing no longer promotes the whole integration inventory into required capabilities and permanent model 401s stop retries (`e6944514`, `docs/tool-reliability-fixes-2026-09-05.md`); a UI pass reworked workspace details, mobile tables, a single tab strip and removed sidebar tooltips (`46652e84`); a connected cloud provider can now be disconnected (`b90c9070`).

## Documentation implications

**What to claim.** Receipt is an AI chat product on the Kentron platform whose every turn and background run is recorded as hash-chained receipts that can be replayed (`architecture.md`, `docs/factory-on-receipt.md`). Background work runs only inside OpenSandbox containers (`types.ts:87`). Connected apps are brokered by a self-hosted Nango and Receipt stores encrypted references only (`docs/receipt-connect-nango.md:16-19`). Workspaces isolate connections and tools; the Default workspace is automatic (`receipt-real-workspaces-dev-handoff.md`). The released CLI installs from a GitHub release and exposes `setup`, `workspace`, `tools`, `mcp`, `connect`, plus `doctor/login/logout` once preview.7 ships. Self-hosting is Docker for infrastructure plus Bun-run application processes, with an SST/AWS reference deployment; Postgres must run `wal_level=logical`.

**What to avoid claiming.** `JOB_POLL_MS`/`JOB_CONCURRENCY`/`JOB_WORKER_ID`, `AUTH_DEV_EMAIL_OTP_TO_CONSOLE`, `AI_GATEWAY_API_KEY`/`ANTHROPIC_API_KEY` as chat requirements, `TEAMS_CLIENT_ID`-style names, a desktop or mobile app, a Python SDK, `POST /receipts`, guardrail enforcement, plan gating, 2FA enrollment, budgets/approvals, local non-sandbox execution, Slack slash commands, the never-emitted `merge.evidence.computed`/`merge.candidate.scored` receipts, or a `login` verb in the currently installed public binary. Never publish DO NOT PUBLISH runbooks, the named-staff-account rule, AWS profile names, account/instance ids, image digests or the personal hostname.

**Suggested page split (source → public page).** Guides ← README.md, GLOSSARY D, prompt catalog (naming caveat), `factory-agent-orchestration.md` "Short Version" and probe class, Slack playbook §7-8 with `apps/slack/server.ts` strings, and a new Teams page from the two Teams docs (corrected env names). Platform ← `receipt-connect-nango.md`, the surface audit, `factory-connected-systems` write workflow, `receipt-chat-onboarding`, `receipt-real-workspaces-dev-handoff.md` (CLI/MCP section), the honest labels from the CLI/MCP plan, `factory-organization-skill-catalog`. CLI ← `receipt-cli.md` minus its release section, the `receipt-connect-cli-prod-debug` symptom table (troubleshooting), `api/cli.md` observe/import. Developers ← `architecture.md` (corrected), `api/streams.md`, GLOSSARY A-B, `memory.md`, `factory-durable-execution-architecture.md`, `receipt-contract-standardization.md`, `api/http.md` plus `/readyz`, `api/sse.md`, `api/sdk.md`, `agent-framework-integrations.md`. Self-hosting ← `LOCAL_SETUP.md` §1-3 and §9-10, `api/config.md` (corrected), env lists from `receipt-connect-nango.md`, the markdown-worker README, license files, the Zero constraints in `neon-to-aws-zero-migration.md`, the generic parts of "Ensuring Provider Configs", README's SST section with guard-variable names only. Working from source ← `LOCAL_SETUP.md` §4-8, `DEVELOPMENT.md`, `api/cli.md`, `factory-on-receipt.md`, `create-agent.md`, the DST doc, the sims README and the harness doc.

**Marketing claims.** No explicit claim list was supplied with this task; the README "Features" bullets and the Slack playbook pitch were evaluated as the de-facto claims:

| Claim | Verdict | Reason |
|---|---|---|
| "Nested chat branches system with deterministic branch resolution and conflict handling" | supported | GLOSSARY I; CAS on `expectedBranchVersion` |
| "BYOK controls with organization-level enforcement" | partial | BYOK exists (`org_provider_api_key`); the "Require organization provider key" toggle is not enforced (prior corpus `02`) |
| "Native provider tools routing and policy-aware tool gating" | partial | tool policy exists, but direct answers send no tools (prior corpus `03`) |
| "ZDR compliance at provider level" | partial | flag exists and restricts models; bypassed when an executable org key exists (prior corpus `02`) |
| "Team management via organizations, members, invitations, and role-based setting" | supported | Better Auth org plugin; seat enforcement on invites |
| "Stream resumability with Redis-backed resume lifecycle" | supported | `stream-resume.service.ts`; `VITE_DISABLE_REDIS` uses in-memory locally |
| "Organization-level model, tool, and compliance policy controls" | supported | `/provider-policy`, `/compliance-policy` |
| "File uploads + markdown conversion pipeline supporting PDF, HTML/XML, Office, OpenDocument, CSV…" | supported | accepted extension list (prior corpus `03`); needs the Cloudflare worker |
| "Vector retrieval pipeline (Qdrant) for attachment-aware RAG" | supported | gated by `VITE_ENABLE_EMBEDDING` |
| "React Native mobile app currently in development (coming soon)" | unsupported | no mobile app in the repo |
| "One-command deploy" on AWS | partial | four commands plus secrets, validation artifact guard and account-id guard (`README.md:81-88`, `AGENTS.md:92`) |
| "`@receipt` runs durable background work with auditable, reproducible traces" (Slack pitch) | supported | Slack app dispatches `factory.run` jobs; receipts replayable |
| "Self-hosting is the canonical path" | partial | supported on AWS via SST, but the hosted product actually runs on a hand-rolled single-host Compose stack, and Docker alone cannot run the full product |

## Open questions

1. Has `v0.1.0-preview.7` of the public CLI been published and has `install.sh` been bumped? Until then every CLI page must warn that the installed binary lacks `login`/`doctor` and fails `setup` on a fresh machine.
2. Which product name will the UI carry (Receipt vs Beetle vs Kentron)? The cutover runbook defers the rebrand; the docs need a one-sentence naming statement approved by an owner.
3. Is `/ironclad` an alias of `/tasks`, and is `/singularity` meant to stay undocumented staff tooling?
4. Which worker ids does `POST /agents/:id/jobs` accept today (`factory`, `codex`, and are `factory-control`/`factory-monitor` still routed)? `bootstrap.ts:1773` registers `factory`; the rest needs a read of `factory-runtime.ts`.
5. Does `receipt new` still scaffold into a repo-root `src/agents/` (absent at HEAD) or into `packages/receipt-app/src/agents/`?
6. Does `receipt factory run --profile` still accept `infrastructure`/`software`, or only `receipt`?
7. Org-level integration enablement: is there an "enable for organization" DB write (`integration-factory-receipt.md:278-279`) or only the checked-in catalog plus connection projection (`:39-43`)?
8. The correct connector count for the catalog page (63 slugs at HEAD) and which of the nine "missing" hosted configs have since been configured.
9. Which support channel and security-report address should replace `SECURITY.md`'s "designated security contact channel"?
10. Is Postgres 16 (local compose) or 17 (GLOSSARY, hosted recommendation) the version to state for self-hosters, and will `deploy/Dockerfile.receipt`'s Resonate 0.9.5 pin be raised to the 0.9.7 floor?
11. Are the Docker helper scripts in `docs/receipt-runtime-readme.md` (`docker:dev:up`, `docker:prod:up`) still present in `package.json`?
12. Should `docs/LOCAL_SETUP.md` be committed at its new path (it is currently an untracked move of the tracked root file)?
