# J1 — Audit of the existing Kentron documentation site

**Doc repository:** `~/Desktop/Development/kentron/doc` (Mintlify), HEAD `ed576e9` (2026-09-07, "docs(cli): update the CLI tab for receipt v0.1.0-preview.7").
**Implementation:** `~/Desktop/Development/kentron/Receipt`, HEAD `c3c16be6` on `main`. Paths below are repository-relative; `Receipt/` paths are in the implementation repo, everything else is in the doc repo.
**Research snapshot:** the doc site was written from `doc/research/` at commit `41baea75` (43 commits behind HEAD). Note that most research files cite a commit `add21f9` in their headers (`research/01-auth-orgs-workspaces.md:7`, `02-...:5`, `03-...:5`, `07-...:4`); that object does not exist in this clone (`git merge-base` fails), so "41baea75" is the only anchor that can be verified. Only `research/04-public-cli.md:3` cites `41baea75` explicitly, and three research files (`04`, `05`, `10`) were re-touched on 2026-09-07.

Every claim in this report was checked against source at `c3c16be6`; where a page was not re-verified line by line, the row says so.

---

## 1. What exists

### 1.1 Repository layout

| Item | Finding |
| --- | --- |
| Content files | **49** `.mdx` files: `introduction.mdx` plus 48 in six directories (`getting-started/` 5, `guides/` 6, `platform/` 12, `cli/` 8, `develop/` 5, `self-hosting/` 5, `repo/` 7). `README.md:13,72` and the spec say "48"; the real count is 49 because `introduction` sits at the root. |
| Navigation | `docs.json` declares six `tabs`, 18 `groups`, 49 page slugs (`docs.json:16-159`). No `anchors`, `dropdowns`, `products`, `versions`, `menu`, icons on tabs or groups, `root`/`directory` on groups, or `global` anchors are used. |
| Site chrome | Theme `mint`, name `Kentron`, colours `#0D9373`/`#07C983`/`#0D9373`, favicon `/favicon.svg`, logo pair `/logo/dark.svg` and `/logo/light.svg` (`docs.json:3-14`). Navbar has one link, **Contact Us** → `mailto:feedback@kentron.ai` (`docs.json:161-166`). Footer socials: LinkedIn and GitHub (`docs.json:168-173`). |
| Redirects | Twelve, all pointing legacy slugs at current pages (`docs.json:174-223`). Listed in section 5. |
| Build exclusions | `.mintignore` excludes `docs/`, `research/`, `scripts/`, `*.draft.mdx`, `README.md` (`.mintignore:3-7`). `.gitignore` excludes `.superpowers/` and `superpowers/`. |
| Working files | `docs/superpowers/specs/2026-09-05-receipt-documentation-design.md` (25.8 KB, the design spec), `research/` (15 files, ~1.3 MB of `file:line`-cited notes), `scripts/check-docs.mjs` (the validator). |
| Images | **None.** The only raster/vector assets are `favicon.svg`, `logo/dark.svg`, `logo/light.svg`. No `.mdx` file references an image, `<img>`, or `<Frame>` (grep of `![`, `<img`, `<Frame`, `/images/` across all pages returns nothing). There is no `images/` directory. |
| Total prose | **64,301 words** of body text across 49 pages (frontmatter, fenced code, and JSX tags excluded). Median page ≈1,150 words; smallest `getting-started/receipts-and-replay` (291); largest `repo/local-development` (4,435). |
| Doc history | Five commits, 2026-09-05 → 09-07. The last two rewrote the CLI tab for `v0.1.0-preview.7` (`login`, `logout`, `doctor`, baked hosted origin). Nothing else has changed since the initial import. |

### 1.2 Validator status right now

`node scripts/check-docs.mjs --complete` **fails** at HEAD with two problems, both introduced by the CLI rewrite:

```
1. safety: cli/doctor.mdx contains a personal home directory path ("/Users/you")
2. safety: cli/doctor.mdx contains a personal home directory path ("/Users/you")
```

The offenders are the two JSON samples at `cli/doctor.mdx:88,109` (`"sessionFile": "~/.receipt/session.json"`); `check-docs.mjs:120` permits only `/Users/me`. Replace with `~/.receipt/session.json`, as `cli/setup.mdx:120` already does. Fix before restructuring — the harness is the only gate the README asks writers to run.

### 1.3 Tabs at a glance

| Tab | Pages | Words | Audience per README | Reusability verdict |
| --- | --- | --- | --- | --- |
| Guides | 12 | 6,854 | product users | 8 keep, 4 rewrite |
| Platform | 12 | 17,159 | administrators | 6 keep (4 of them split), 4 rewrite (targeted), 2 rewrite+split |
| CLI | 8 | 8,213 | released binary users | 8 keep (2 need one-line fixes) |
| Developers | 5 | 5,976 | builders | 5 keep |
| Self-hosting | 5 | 8,157 | operators | 5 keep (3 need small edits) |
| Working from source | 7 | 17,942 | contributors | 6 keep, 1 rewrite (targeted) |

The prose quality is uniformly high: exact UI strings, `file:line`-grounded limits, and honest "this does not work" callouts. The problems are concentrated in (a) claims about *sidebar placement* that were wrong when written, (b) three UI surfaces that changed after the snapshot (Agent Registry, MCP Gateway workspace UI, composer menu), and (c) the released-CLI story, which the CLI tab already updated but two other pages still contradict.

---

## 2. Per-page audit

Columns: slug · title · words · Mintlify components · what it covers · quality and accuracy notes · proposed destination section (1–7) and new slug · verdict. Component counts are from a scan of `<Component` tags; false positives from TypeScript generics inside code fences (`<T>`, `<View>`, `<Label>`, `<Display Name>`) are excluded here.

### 2.1 Guides tab (12 pages)

| Slug | Title | Words | Components | Covers | Quality and accuracy notes | Destination / new slug | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `introduction` | What Receipt is | 317 | Note, CardGroup, Card×3 | The router's three decisions, hash-chained receipts, Receipt/Kentron/Beetle naming, the sidebar order, three next-step cards. | Line 32 was wrong at authoring time: the chat area is titled **Chat**, not "Beetle Chat" (`en.json:299`; §3.B). Order otherwise matches `NAV_AREAS` (`app-sidebar-nav.config.tsx:119-130`), with **New** above and **Slack** after Chat (`app-sidebar.tsx:431-451`). | Root `introduction` rewritten as the seven-product hub; product content moves to `co-worker/overview` | rewrite |
| `getting-started/your-account` | Create and manage your account | 391 | Steps, Step×4, Info | Sign-up form limits and errors, six-digit OTP, auto-created organization and one-time $5 credit, password reset, 2FA cannot be enabled, avatar/name/language, security page, session lifetime. | Auth backend unchanged since snapshot (0 commits under `apps/start/src/lib/backend/auth`). Add one sentence: `/` now redirects to `/auth/sign-up` on every host except the public marketing hostname (`Receipt/apps/start/src/routes/index.tsx:15,25-30`). | 6 · `core/accounts/your-account` | keep-as-is |
| `getting-started/your-first-chat` | Your first chat | 456 | Warning | Empty-state strings, submit-button lifecycle, the `+` menu, tools inert on direct answers, no model picker, context meter, titles, long pastes. | The `+` menu now has a **Skills** → **Create skill** submenu between Attach files and Study Mode (`prompt-input-actions-menu.tsx:91-107`; §3.A). Existing strings verified (`en.json:210-228`). "Model picker not mounted" (line 27) not re-verified; no picker component exists under `prompt-input/`. | 1 · `co-worker/your-first-chat` | rewrite (targeted) |
| `getting-started/connect-an-app` | Connect an app | 354 | Info | Where to connect, "Global Integrations" scope, search/chips/segmented control/Load more, connect dialog with two-minute poll, confirmation copy, three error strings, catalog-miss task offer. | Integrations page changed twice since snapshot, only to hide the Agent Registry's dedicated connection named `agent-registry` from this list (`integrations-page.tsx` diff; `agent-registry-connection-name.ts:9`) and to restyle one button. Add a note that cloud accounts connected inside the Agent Registry do not appear here. | 2 · `mcp-gateway/connect-an-app` | keep-as-is |
| `getting-started/background-runs` | Background runs | 377 | Note | Progress panel and step translation, Computer Logs viewer, closing the tab, Stop generation, failure banner. | No commits touched the progress or computer-log components. Not re-verified string by string. | 1 · `co-worker/background-runs` | keep-as-is |
| `getting-started/receipts-and-replay` | Read the receipts | 291 | none | Replay pill, Summary/Transcript/Work tabs, six stages, inspector fields, search filters, cost row. | The replay dialog was reworked in `46652e84` (tab strip moved to the shared `TabList`). Six stage labels verified (`chat-receipts-dialog.tsx:1310-1355`). The tab names Summary/Transcript/Work were not re-verified against the new tablist; check before republishing. | 1 · `co-worker/replay` | keep-as-is |
| `guides/files-and-attachments` | Files and attachments | 758 | Note×2, Warning | Accepted types table, 10 MB / 10 files, MIME-first validation order, exact errors, conversion worker, chunking numbers, plan gate not firing. | Backend unchanged. Strongest page in the tab. | 1 · `co-worker/files-and-attachments` | keep-as-is |
| `guides/managing-conversations` | Editing, branching, and finding messages | 712 | Tip; 1 mermaid | Message tree, canonical path, edit/regenerate rules, conflict messages, sidebar groups and thread menu toasts, Cmd/Ctrl+K search limits. | Two small drifts: sidebar status is no longer a hover pill but an icon whose accessible name is `Pending: …` / `Generating: …` / `Error: …` (`chat-sidebar.tsx` diff in `46652e84`); the Cmd+K palette gained a **Skills** action (`chat-search-command-dialog.tsx:271-281`). | 1 · `co-worker/conversations` | keep-as-is |
| `guides/errors-and-limits` | Errors and limits | 1,336 | Note×3 | Every chat error string grouped by cause, context-limit variants, rate limits, plan-gate strings that cannot fire, route-level failures, TraceID. | Backend unchanged; not re-verified string by string. One new string to add from the Slack adapter (see Slack row). | 1 · `co-worker/errors-and-limits` | keep-as-is |
| `guides/monitoring-your-runs` | Monitoring your runs | 614 | Info, Note | `/tasks`, `/sessions`, `/computers`, Usage and Billing, Org Brain, Replay, `/healthz` and `/readyz`. | **Wrong at authoring time:** Usage, Billing and Org Brain are rail icons (`-organization-settings-nav.ts:220-224,251-264`, unchanged since the snapshot); only `/tasks`, `/sessions`, `/computers` are hidden (`hideFromPrimaryNavigation: true` in each `*-nav.config.tsx`). The runners "tooltip" is now an `aria-label` (`sidebar-computer-capacity.tsx:44-48`). See §3. | Split: 1 · `co-worker/monitoring` (tasks, sessions, computers, replay); Org Brain → 4 · `catalog/org-brain`; Usage → 3 | rewrite |
| `guides/receipt-in-slack` | Receipt in Slack | 723 | Note | Install gate and errors, six scopes, mention flow and phase throttling, terminal message, identity resolution, seat refusal. | New since snapshot: a failed `/chat/route` call now yields `Receipt couldn't determine the access needed for this request. Please retry; no task was started.` instead of a silent Factory fallback (`apps/slack/slack-chat-routing.ts:81-96`; `chat-layer-routing.ts:460-461`). | 1 · `co-worker/slack` | keep-as-is (add the error) |
| `guides/getting-help` | Getting help | 525 | Warning, CardGroup, Card×3 | Docs link is the only escalation, two dead links, "Not yet available" list, security reporting checklist, health endpoints. | **Stale:** line 29 says the Agent Registry is not active; it is (§3.A). Playground still a stub (`model-gateway/playground.tsx:9-16`); guardrail enforcement still unwired; SSO and extraction analytics still inert; dead links still present (`en.json:415,841-842`). | Site-wide `getting-help` (root or 6) | rewrite |

### 2.2 Platform tab (12 pages)

| Slug | Title | Words | Components | Covers | Quality and accuracy notes | Destination / new slug | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `platform/organizations-and-workspaces` | Organizations and workspaces | 1,321 | Note, Steps, Step×2; 1 mermaid | Organization vs Receipt workspace, hidden global scope, org creation cap and switcher, naming/logo, Default workspace, Workspaces page table, create/rename/share, two-step delete, who can do what. | **Stale (UI pass `46652e84`):** the Created column is gone, the row menu now opens with **View details** (a dialog with Created by / Created / Last updated / Sharing / Tools / Workspace ID), and the second delete step asks you to type the word `Delete`, not the workspace name. Quotes and citations in §3.A. Access rules verified (`-organization-settings-access.ts:9-17`). | 6 · `core/organizations-and-workspaces` (the Workspaces-page UI could instead live under 2) | rewrite (targeted) |
| `platform/members-roles-and-invitations` | Members, roles, and invitations | 1,162 | Note, Warning, Info | Three roles, the settings access rule, Members table and badges, invite dialog and batch semantics, invitee flows, seats, workspace sharing token. | Access rule holds (`mcp-gateway-nav.config.tsx:17-21` covers both the gateway and `/workspaces` paths). Members page unchanged. **Add:** pending workspace invitations now appear in the gateway workspace's **Settings** tab with a **Pending** badge and **Cancel invitation** (§3.A); the free-plan seat default is `RECEIPT_DEFAULT_FREE_SEAT_COUNT` (5). | 6 · `core/members-roles-and-invitations` | keep-as-is (add two paragraphs) |
| `platform/model-policy` | Models, providers, and policy | 1,807 | Steps, Step×3, Info, Note, Warning | Two surfaces sharing `/models`, 32-tile gallery with 2 executable providers, setup wizard, catalogue and latency heuristic, two policy routes, three compliance flags, provider/model controls and the inverted toggle, denial reasons. | Models page tab strip rebuilt on the shared `Tab` (`46652e84`); labels **Models** / **Custom Endpoints** unchanged. Policy routes unchanged (0 commits). The compliance-flag section belongs to Guard. | Split: 3 · `llm-gateway/providers-and-models` + `llm-gateway/model-policy`; compliance flags → 5 · `guard/compliance-policy` | rewrite (split) |
| `platform/bring-your-own-key` | Bring your own key | 1,572 | Warning | Page copy, only OpenAI shown, two validation layers, AES-256-GCM storage and the fingerprint, scope invisibility, credential resolution order, strict mode, ZDR trade-off dialog. | `byok/` unchanged (0 commits). | 3 · `llm-gateway/bring-your-own-key` | keep-as-is |
| `platform/guardrails` | Guardrails | 1,564 | Warning×2, Note, AccordionGroup, Accordion×9, Info | Not enforced, page location and copy, table, nine kinds, operation/strategy/stage/severity, limits, test dialog, receipt streams. | **Still accurate.** `applyGuardrails`, `guardPrompt`, `guardResponse`, `guardToolResult` (`chat/services/guardrail-enforcement.service.ts:82-129`) have no callers anywhere in `apps/start/src` or `packages/receipt-app/src`; only `invalidateGuardrailCache` is imported (`guardrails.server.ts:94-97`). The Policies page still claims "fully connected" (`policies-page.tsx:117`). | 5 · `guard/guardrails` | keep-as-is |
| `platform/organization-skills-and-knowledge` | Organization skills and knowledge | 1,218 | Info×2, Note | Skills upload contract and frontmatter, versions, table/detail dialog, mount path in a run, delete; Knowledge upload, status/index states, retrieval flag. | Add the two new entry points: composer `+` → **Skills** → **Create skill** (`prompt-input-actions-menu.tsx:91-107`) and the Cmd+K **Skills** action. Skills row action renamed **View** → **View details** (`organization-skills-table.tsx` diff). Knowledge is still hidden from rail and menu (`-organization-settings-nav.ts:292-299`). | Split: 4 · `catalog/skills`, `catalog/knowledge` | keep (split) |
| `platform/usage-and-billing` | Usage, plans, and billing | 1,232 | Warning×2, Note, Info, AccordionGroup, Accordion×3 | Usage tiles and headline cards, the per-user caveat, Billing plans/seats/plan change/self-hosted, plan gating does not fire, what a plan changes. | **Wrong at authoring time:** line 6 "neither has a sidebar entry" — both are utility-rail icons (`-organization-settings-nav.ts:251-264`). Add `RECEIPT_DEFAULT_FREE_SEAT_COUNT`. Billing backend unchanged otherwise. | Split: 3 · `llm-gateway/usage-and-cost` (Usage); 6 · `core/billing-and-plans` (Billing) | rewrite (targeted, then split) |
| `platform/integrations` | Receipt Connect and the connector catalog | 2,207 | Warning, Note | Ownership split, encrypted reference storage, four connection kinds, addressing and AWS profile naming, capability manifest, five execution surfaces, `read-provider-resource`, 62-connector table. | Gateway service unchanged. Add the Agent Registry's hidden `agent-registry` connection (§3.A). The 62-connector and 89-tool counts were not recounted; the audit test's expected counts changed for Azure (`68b7fa3a`), so recount before publishing. | Split: 2 · `mcp-gateway/receipt-connect` (concepts) + 4 · `catalog/connectors` (table) | keep (split) |
| `platform/connection-scopes` | Where a connection lives | 735 | AccordionGroup, Accordion×3, Note; 1 mermaid | Per-workspace storage, the three scopes, surface→scope table, why, three authority levels, two token shapes. | Unchanged. | 2 · `mcp-gateway/connection-scopes` | keep-as-is |
| `platform/manage-tools-and-permissions` | Manage tools and permissions | 943 | Steps, Step×3, Check, Warning | Dialog copy, read/write classification order, two gates, v1/v2 policy, GitHub repository selection, Atlassian site resolution, receipts. | Unchanged. | 2 · `mcp-gateway/tools-and-permissions` | keep-as-is |
| `platform/mcp-gateway` | The MCP gateway | 1,022 | Warning | Aggregate server properties, the instructions string, opaque aliases, publishing rules, client setup panel, workspace Overview, redirect table. | **Stale (`46652e84`):** six setup commands (first `receipt setup`), a fourth **Dashboard** tab on the workspace strip, and a per-workspace **Gateway activity** page (Dashboard / Users / Live activity, 24h/7d/30d). Quotes and citations in §3.A. The org-level `/mcp-gateway/dashboard` redirect claim still holds (`mcp-gateway/dashboard.tsx:16-18`). | Split: 2 · `mcp-gateway/aggregate-server` + `mcp-gateway/workspaces-and-activity` | rewrite (targeted) |
| `platform/data-handling-and-security` | Data handling, telemetry, and security | 2,376 | Warning×2, Note×3, Accordion | Credentials at rest, replicated columns, what never reaches an agent, tool-call receipts, PostHog configuration/identity/captures/caveats, ZDR scope, sessions/cookies/origins, vulnerability reporting. | Unchanged (0 commits in the relevant directories). Too long for one page in the new structure. | Split: 5 · `guard/data-handling-and-telemetry`, `guard/zero-data-retention`, `guard/security-reporting` | keep (split) |

### 2.3 CLI tab (8 pages) — updated at doc commit `ed576e9` for `v0.1.0-preview.7`

| Slug | Title | Words | Components | Covers | Quality and accuracy notes | Destination / new slug | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `cli/overview` | The receipt CLI | 904 | Warning, Note | Two binaries, the released command surface including `login`/`logout`/`doctor`, parsing traps, `--version`, side-by-side table. | Verified against the usage text (`Receipt/packages/receipt-app/src/connect-cli.ts:61-134`) and the dispatch order (`:1209-1250`: `--version`, then `tools`, `mcp`, `workspace`, then the `connect list|tools|call` agent commands, then help). Two refinements: `receipt login` takes an optional positional target (`:72`), and the agent commands also precede the help check. | 7 · `cli/overview` | keep-as-is |
| `cli/install` | Install the CLI | 611 | Note×2 | Installer one-liner, quick start, what the installer does, `RECEIPT_CLI_*` variables, platforms, verify with doctor, dev/self-hosted overrides, `local` target. | The public `install.sh` lives in `kentronai/receipt-cli`, outside both repos, so it was checked only against `docs/receipt-cli.md:8-40`; `Receipt/scripts/install-receipt-cli.sh:4-8` is a different, from-source installer. **Release gap:** `preview.6` lacks the baked origin; pin `RECEIPT_CLI_VERSION=v0.1.0-preview.7` until the installer default is bumped (`docs/receipt-cli.md:19-30`). | 7 · `cli/install` | keep-as-is (add pin note) |
| `cli/setup` | Signing in with receipt setup | 1,546 | Warning×3, ParamField×8, Note, Steps, Step×5 | What setup does, flags, the three session-reuse conditions, device login steps, session file layout, 12-hour token, output. | Matches `3c52d87c`/`53f74bed`: reuse requires matching normalised gateway (`receipt-connect-command-proxy.ts:381`), non-expired token, no `--fresh-login`; most recent setup becomes active. | 7 · `cli/setup` | keep-as-is |
| `cli/doctor` | Diagnosing your setup with receipt doctor | 904 | Note×2, ParamField×4, Tip, AccordionGroup, Accordion×2 | Four checks, flags, text report, JSON envelope, exit codes, symptom table. | Verified against `connect-cli.ts:958-1078` (probe `/health` then `/healthz`, `HTTP 400` on sign-in is healthy, exit-code rule). **Validator failure:** `~/...` at lines 88 and 109 must become `~/.receipt/session.json`. | 7 · `cli/doctor` | keep-as-is (fix two lines) |
| `cli/workspaces` | Switching workspaces | 815 | Note, Tip | Requires a session, the two-flag parser, subcommand table, text output, `create` role, `use` re-scopes, `delete` refusals, selectors, self-healing, server errors. | `receipt-workspace-cli.ts` changed 2 lines (the not-signed-in hint now names `receipt setup`). | 7 · `cli/workspaces` | keep-as-is |
| `cli/connect` | Connecting providers from the CLI | 1,176 | Note×2, AccordionGroup, Accordion×2 | Authorize flow and endings, flags, server refusals, menu quirk, `default` naming, status, disconnect defaults, the agent surface and two call forms. | Session-aware behaviour matches `3c52d87c`. | 7 · `cli/connect` | keep-as-is |
| `cli/tools-and-mcp` | Calling tools and wiring MCP clients | 1,151 | Note, Warning×4 | `receipt tools` subcommands, identity, flags, envelope, opaque names, what lists; `receipt mcp` config/install/status/remove/serve. | `serve` verified (`receipt-mcp-cli.ts:645-656`). | 7 · `cli/tools-and-mcp` | keep-as-is |
| `cli/observe-claude-code` | Observing and importing Claude Code activity | 1,106 | Warning×2, Note×2 | Redaction warning, upload-by-default, two sources, flags, destination order, captured fields, background service and its paths, setup installs it, `/sessions`. | Unchanged. The service label contains `beetle` (allowed; the validator bans only the domain). | 7 · `cli/observe-claude-code` | keep-as-is |

### 2.4 Developers tab (5 pages)

| Slug | Title | Words | Components | Covers | Quality and accuracy notes | Destination / new slug | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `develop/architecture` | Processes, roles, and routing | 896 | Note, Warning; 1 mermaid | Five roles, gateway routing table, two prefix consequences, call graph, Postgres-only storage, `JOB_BACKEND` inert. | `packages/receipt-app/src/server.ts` unchanged. | 6 · `core/architecture` | keep-as-is |
| `develop/receipts-and-streams` | Receipts, chains, and streams | 1,077 | ResponseField×8, Note; 1 mermaid | Receipt shape, `context` vs `hints`, hash coverage, verify, execution rules, branching, stream families, projection tables, tenancy. | A new migration `20260905_durable_projection_work.sql` added durable-projection tables (`apps/start/zero/migrations`); the "core storage tables" list was not re-verified against it. | 6 · `core/receipts-and-streams` | keep-as-is (verify table list) |
| `develop/jobs-and-durable-execution` | Jobs, lanes, and durable execution | 1,259 | Warning×2, Info, Note; 1 mermaid | Four lanes, statuses, ten lifecycle receipts, singleton and idempotency, payload kinds, the four-handler trap, durable path, leases, three recovery loops. | Fourteen projection/durability fixes landed after the snapshot (`00ef6f17`…`888d1d9c`, `71ffa060`, `8c74802b`); they touch replay and projection serving rather than the queue contract, but spot-check the env-variable defaults table. | 6 · `core/jobs-and-durable-execution` | keep-as-is (spot-check) |
| `develop/runtime-api` | Runtime HTTP and live-event API | 1,699 | Warning×4, ParamField×26, ResponseField×23, Expandable, Note | Base URL and prefix, conventions, jobs routes, memory routes, channel-neutral chat, callback, health, assets, SSE/WebSocket live events, diagnostics. | `server.ts` unchanged; not re-verified route by route. | 6 · `core/runtime-api` | keep-as-is |
| `develop/typescript-sdk` | The TypeScript SDK and the action contract | 1,045 | Warning×2, AccordionGroup, Accordion×3, ParamField×6 | Eight exports, spec shape, action contract, selection, side-effect classes, determinism, control receipts, remote actions, merge policy, minimal agent. | `packages/receipt-app/src/sdk` unchanged (0 commits). | 6 · `core/typescript-sdk` | keep-as-is |

### 2.5 Self-hosting tab (5 pages)

| Slug | Title | Words | Components | Covers | Quality and accuracy notes | Destination / new slug | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `self-hosting/overview` | What self-hosted mode actually is | 1,250 | Warning×3, Note×2, Steps, Step×2 | Build-time mode flag, getting a self-hosted build, four gated things, cloud-vs-self-hosted table, `/setup` wizard, signup policies, readiness checklist, env template. | Two edits: the table row "free, 5 seats" (line 53) should read "`RECEIPT_DEFAULT_FREE_SEAT_COUNT`, default 5" (`workspace-usage/shared.ts:27-34`); and `/` now redirects to `/auth/sign-up` on a self-hosted build (`routes/index.tsx:27`), which then redirects to `/setup` or `/auth/sign-in` as line 50 already describes. | 6 · `core/self-hosting/overview` | keep-as-is (two edits) |
| `self-hosting/configuration` | Configuration, secrets, and keys | 1,991 | Note, Warning×2, CodeGroup | Three fatal variables, AES keys and shared secrets, object storage, optional subsystems, runtime knobs, variables that are not configuration. | Add rows for `RECEIPT_DEFAULT_FREE_SEAT_COUNT` and the two `local`-target CLI variables now documented in `.env.example:157-167` (`RECEIPT_CONNECT_LOCAL_SERVER_URL`, `RECEIPT_CONNECT_LOCAL_AUTH_URL`). | 6 · `core/self-hosting/configuration` | keep-as-is (add rows) |
| `self-hosting/database-and-migrations` | Postgres, migrations, and the sync publication | 1,782 | Warning×3, Note×2, Steps, Step×9, Info; 1 mermaid | `wal_level`, version skew, nine-step runner, checksum rule, safe vs destructive commands, the publication trap, ordering, symptoms, tenancy. | Line 72 "currently 49 timestamped migrations" → **50** (`20260905_durable_projection_work.sql`). | 6 · `core/self-hosting/database-and-migrations` | keep-as-is (one number) |
| `self-hosting/integrations-provider` | Running the integration provider | 1,343 | Warning×2, Steps, Step×4, Note×2, AccordionGroup, Accordion×2, Info | Three variables, the key that does not exist yet, webhook verification and shapes, membership-revoked handling, read repair, operational warnings. | The checked-in patch set (line 149) now includes an Azure service-principal provider patch used by the Agent Registry (`Receipt/deploy/patches/nango-azure-service-principal.mjs`, `deploy/Dockerfile.nango`). Supporting detail, not a correction. | 6 · `core/self-hosting/integrations-provider` | keep-as-is |
| `self-hosting/deploying` | Deploying Receipt | 1,791 | Warning×2, Note, AccordionGroup, Accordion×4 | Two topologies, preflight, origin rules, secrets by role, four release rules, email, IAM caution, rollback. | `scripts/single-host-rollout.mjs` changed 11 lines; no user-visible change. | 6 · `core/self-hosting/deploying` | keep-as-is |

### 2.6 Working from source tab (7 pages)

| Slug | Title | Words | Components | Covers | Quality and accuracy notes | Destination / new slug | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `repo/local-development` | Local development | 4,435 | Warning×5, Note×3, Steps, Step×6 | Prerequisites and why, `./bunw`, bring-up steps, the three run modes, `local:up` shell-only rule, full port table, stopping, reload matrix, model credentials, mock LLM proxy, 22-row symptom table. | Largest page. The supervisor scripts did not change in the range (the six `scripts/` commits touch CLI release/install, rollout, and audit scripts). Not re-verified line by line. Consider splitting ports and troubleshooting out. | 6 · `core/local-development` | keep-as-is |
| `repo/in-repo-cli` | The in-repo developer CLI | 1,908 | Warning×3, Note×3 | Wrapper start-up, env-file precedence, argument parsing, command list, sign-in and session seeding, `receipt doctor`, three `--output-file` envelopes. | **Stale and self-contradictory with the CLI tab:** line 6 "The released binary also has no `login` command" and the line-113 list place `login`, `logout`, `doctor` in the in-repo CLI only. The released binary has all three (`connect-cli.ts:72-74,1136-1146`); `cli/overview.mdx:8` on the same site says so. | 7 · `cli/from-source/in-repo-cli` | rewrite (targeted) |
| `repo/receipts-and-jobs-commands` | Reading receipts and driving jobs | 1,515 | Note, Warning×3 | Target resolution, trace/replay/inspect/fork, `dst` and `--strict`, jobs subcommands, memory and prefs, sessions, prerequisites. | `cli.ts` unchanged (0 commits). | 7 · `cli/from-source/receipts-and-jobs` | keep-as-is |
| `repo/factory-overview` | Factory concepts and configuration | 2,428 | Warning×4, Note, Info, ParamField×6; 1 mermaid | Objective statuses/states/phases, tasks and the DAG, candidates, jobs, checks, promotion gate, profile, execution path, packet, prerequisites, `.receipt/config.json` and the four policy groups. | `factory-cli` changed in four commits (`commands/index.ts` +12, `simulate.ts` +4) — spot-check for a new flag. | 6 · `core/factory` | keep-as-is |
| `repo/factory-cli-reference` | receipt factory command reference | 4,108 | Warning×9, Note×3, Info | Every subcommand, shared flags, init, run/create/compose, watch/inspect, analysis commands, resume, mutations, job controls, agent envelope, computer lane, board TUI hotkeys and slash commands. | Same spot-check as above. | 7 · `cli/from-source/factory-reference` | keep-as-is (spot-check) |
| `repo/authoring-agents` | Authoring an agent | 1,601 | Warning×2, Note×3 | The `receipt new` import defect, two loaders, templates, writing and running an agent, reading it back, the control-receipt trail, `receipt dev`. | `sdk` unchanged. | 6 · `core/authoring-agents` | keep-as-is |
| `repo/testing-and-simulation` | Testing, simulation, and stack validation | 1,947 | Warning, Steps×2, Step×7, Note | Check pyramid, what fast check omits, CI steps, DST primitives and typed failures, simulation profiles/floors/properties/corpus, eval, `dst --strict`, `validate:stack`. | `af042dec` fixed flaky simulation timeouts and `simulate.ts` gained 4 lines; confirm the profile seed/repeat numbers. | 6 · `core/testing-and-simulation` | keep-as-is (spot-check) |

---

## 3. Stale or wrong sentences that must change

Two groups. **Group A** drifted after the research snapshot (`41baea75..c3c16be6`). **Group B** was already wrong at the snapshot — an authoring error, not drift — but reads the same to the customer.

### 3.A Drifted since the snapshot

| Page:line | Sentence as published | What is true at `c3c16be6` | Evidence |
| --- | --- | --- | --- |
| `guides/getting-help.mdx:29` | "**Agents → Dashboard** and **Agents → Registry** are not active in this release." | The Agent Registry is a working page: title **Agent Registry**, description "Discover cloud AI agents, classify autonomy, and review organization risk.", tabs **Inventory** and **Dashboard**, autonomy filter with **L1–L4**, **Refresh inventory**, an Integrations dialog to **Connect** / **Scan inventory** / **Disconnect** AWS, Azure, or Google Cloud, and a row **Actions** menu with **View details**. `/agent-registry/dashboard` now redirects to `/agent-registry/registry?tab=dashboard`. | `agent-registry-page.tsx:50-55,76-77,209-210,222,230,292,369-370`; `agent-registry-table.tsx:74-84,165`; `agent-cloud-integrations-dialog.tsx:38-40,255,325,343,362`; `routes/(app)/_layout/agent-registry/dashboard.tsx:5-13`; commits `26ec975a`…`c3c16be6` |
| `getting-started/your-first-chat.mdx:14-19` | "Next to the message box, the `+` menu opens: Attach files … Study Mode … Max … Tools" | A **Skills** submenu now sits between Attach files and Study Mode; its one item, **Create skill**, opens `/organization/settings/skills`. | `prompt-input-actions-menu.tsx:91-107`; commit `c3c16be6` |
| `platform/mcp-gateway.mdx:70-78` | "The panel gives five numbered commands, each with its own copy button: receipt mcp install codex # 1. …" | Six commands. The first is now `receipt setup` — "Sign in and set up the Receipt CLI" — followed by `mcp install codex`, `mcp config codex`, `mcp status codex`, `workspace current`, `tools list`. | `mcp-gateway-setup-panel.tsx:27-49`; commit `46652e84` |
| `platform/mcp-gateway.mdx:84` | "Three tiles sit above three tabs, and each tile links to its tab" | The strip has four tabs: Open integrations, LLM keys, Settings, and **Dashboard**; Dashboard is a separate route (`…/workspace/$workspaceId/dashboard`) titled **Gateway activity** with tabs **Dashboard**, **Users**, **Live activity** and a `24h`/`7d`/`30d` range. | `mcp-gateway-workspace-page.tsx:37-41,76-87`; `dashboard/route.tsx:15-18`; `mcp-gateway-dashboard-page.tsx:81-83,252,363-422` |
| `platform/organizations-and-workspaces.mdx:89` | "The table is the MCP Gateway's own workspace table, with columns `#`, **Workspace**, **Sharing and tools**, **Created**, **Updated** and **Actions**" | **Created** is gone from the table. The row menu now begins with **View details**, which opens a dialog showing **Created by**, **Created**, **Last updated**, **Sharing**, **Tools**, **Workspace ID**; the Default workspace's creator reads `Created with the organization`. | `mcp-gateway-workspace-table.tsx:58-62,104-117,257-296`; `workspace-details-dialog.tsx:91-132` |
| `platform/organizations-and-workspaces.mdx:112` | "…reads `This is permanent. Type the workspace name below to delete {name} and revoke its credentials for every agent using it.` The field is labelled `Type {name} to confirm` and the button **Delete workspace permanently** stays disabled until what you type matches the name exactly — the comparison is case-sensitive after trimming." | The body now reads `This is permanent. Type Delete below to delete {name} and revoke its credentials for every agent using it.`, the field is labelled `Type Delete to confirm`, the button enables only when the trimmed input equals `Delete`, and the inline error is `Type Delete exactly to confirm this deletion.` | `workspaces-page.tsx:197-198,366,383-384,440` |
| `platform/organization-skills-and-knowledge.mdx` (no mention) | — | Two new entry points into Skills: the composer `+` → **Skills** → **Create skill**, and the Cmd/Ctrl+K palette's **Skills** action. | `prompt-input-actions-menu.tsx:91-107`; `chat-search-command-dialog.tsx:271-281` |
| `platform/members-roles-and-invitations.mdx:94-98` (Sharing a single workspace) | Describes the `wsinv_` token but not where a pending share is visible. | The workspace **Settings** tab now lists invitations that have not been accepted with a **Pending** badge and a **Cancel invitation** row action, and toasts `Invitation to {email} cancelled.`; both the organization-invite and workspace-only-invite paths surface there. | `mcp-gateway-settings-page.tsx:110-115,172-193,314-319,376-382`; `receipt-workspaces.ts` (pending invites query) |
| `self-hosting/overview.mdx:53` | "Default organization plan and seats — `free`, 5 seats" | 5 is the fallback of `RECEIPT_DEFAULT_FREE_SEAT_COUNT`, which any deployment can raise. | `workspace-usage/shared.ts:27-34`; commit `c3c16be6` |
| `self-hosting/configuration.mdx` (missing rows) | — | `RECEIPT_DEFAULT_FREE_SEAT_COUNT`; `RECEIPT_CONNECT_LOCAL_SERVER_URL` (default `http://127.0.0.1:8787`) and `RECEIPT_CONNECT_LOCAL_AUTH_URL` for the CLI `local` target. | `shared.ts:27-34`; `.env.example:157-167`; `receipt-connect-command-proxy.ts:569,577` |
| `self-hosting/database-and-migrations.mdx:72` | "currently 49 timestamped migrations, plus `schema.sql`" | 50 (`20260905_durable_projection_work.sql` was added). | `apps/start/zero/migrations/` |
| `guides/receipt-in-slack.mdx` (missing) | Nothing about the routing call failing. | When the runtime's `/chat/route` is unavailable the Slack reply is `Receipt couldn't determine the access needed for this request. Please retry; no task was started.` instead of a silent Factory fallback. | `apps/slack/slack-chat-routing.ts:81-96`; `chat-layer-routing.ts:460-461`; commit `ab7b00b0` |
| `guides/monitoring-your-runs.mdx:29` | "Its tooltip reports live counts in the form `<idle> ready, …`" | The row no longer has a hover tooltip; the same text is the widget's accessible name (`aria-label="Beetle runners: …"`). | `sidebar-computer-capacity.tsx:22,44-48`; commit `46652e84` |
| `guides/managing-conversations.mdx:51` | "its row in the sidebar carries a status pill: **Pending** … **Generating** … **Error**" | The states are now an icon with an accessible name (`Pending: …`, `Generating: …`, `Error: …`); no hover bubble. | `chat-sidebar.tsx` diff in `46652e84`; `en.json:287-291` |
| `repo/in-repo-cli.mdx:6` | "The released binary also has no `login` command; its sign-in command, `receipt setup`, is shared with this one." | The released binary has `login`, `logout` and `doctor`. | `connect-cli.ts:72-74,1136-1146`; commit `3c52d87c` |
| `repo/in-repo-cli.mdx:113` | "These exist only here: `login`, `logout`, `whoami`, `doctor`, `new`, …" | `login`, `logout` and `doctor` are shared; only `whoami` and the rest remain in-repo-only. | same |
| `cli/install.mdx:6` | "ships with the hosted origin `https://app.kentron.ai` baked in, so on the hosted app there is nothing to configure" | True for builds from `9b8b7574` onward (`v0.1.0-preview.7`). The repo's own doc says the installer default may still resolve `preview.6`, which fails with `production URL is not configured yet`, and instructs pinning `RECEIPT_CLI_VERSION=v0.1.0-preview.7`. | `docs/receipt-cli.md:19-40`; `scripts/build-receipt-cli-release.sh:9,73-76,106-107` |
| `getting-started/connect-an-app.mdx` / `platform/integrations.mdx` (missing) | — | Cloud accounts connected in the Agent Registry use the connection name `agent-registry` and are filtered out of Organization Settings → Integrations. | `agent-registry-connection-name.ts:1-9`; `integrations-page.tsx` diff |

### 3.B Wrong at authoring time (already wrong at `41baea75`)

| Page:line | Sentence as published | What is true (and was true at the snapshot) | Evidence |
| --- | --- | --- | --- |
| `introduction.mdx:32` | "The sidebar renders, in order: **New**, **Beetle Chat**, **Slack**, **MCP Gateway**, **Model Gateway**, and **Agents**." | The chat area is titled **Chat** (rail label `Chat`); "Beetle Chat" is not a label. The rest of the order is right. | `en.json:299` (unchanged since `4a31678f`, 2026-08-21); `chat-sidebar.tsx:66,160-162`; `app-sidebar-nav.config.tsx:119-130` |
| `introduction.mdx:27` | "The shipped interface labels several areas **Beetle** — Beetle Chat, Beetle Tasks, and the Beetle runners widget." | Beetle Tasks and Beetle runners are real labels; Beetle Chat is not. The chat description does say "Chat with Beetle…". | `tasks-nav.config.tsx:16`; `sidebar-computer-capacity.tsx:54`; `en.json:268` |
| `guides/monitoring-your-runs.mdx:3` (description) and `:6` | "none of them are in the sidebar" / "Every one below exists and works — you reach it by typing its URL directly." | Usage, Billing and Org Brain are rail icons for owners/admins; only `/tasks`, `/sessions`, `/computers` are URL-only. | `-organization-settings-nav.ts:220-224,251-264`; `tasks-nav.config.tsx:22` |
| `guides/monitoring-your-runs.mdx:34` | "`/organization/settings/usage` and `/organization/settings/billing` have no sidebar entry either." | Both are visible rail icons in the bottom utility group ("Usage above Billing"). | `-organization-settings-nav.ts:243-264` |
| `platform/usage-and-billing.mdx:6` | "Both are owner and admin only, and neither has a sidebar entry — you reach them by typing … directly." | Same as above. | same |
| Design spec §10 **A11** | "Usage and Billing have no sidebar entry." | Wrong; see above. | same |

Group B matters for the rewrite because it shows the research corpus itself carried an error on sidebar placement; do not re-derive sidebar claims from `research/03c-app-pages-sidebar.md` without re-reading `-organization-settings-nav.ts`.

---

## 4. Visual language inventory (so new pages match)

**Frontmatter.** Exactly two fields on every page: `title` and `description`, both double-quoted (49/49). No `icon`, `sidebarTitle`, `mode`, `tag`, or `og:` fields anywhere. Titles are sentence case and mostly noun phrases ("Members, roles, and invitations"), with a few imperative/gerund titles in the CLI tab ("Signing in with receipt setup"). Descriptions run 69–181 characters and often carry the page's key correction ("…and the one correction that matters: plan feature gating does not fire in this release.").

**Components actually used (site-wide counts):** `Warning` 73, `Note` 59, `Step` 45 inside `Steps` 11, `ParamField` 50, `ResponseField` 31, `Accordion` 29 inside `AccordionGroup` 8, `Info` 14, `Card` 6 inside `CardGroup` 2, `Tip` 3, `Check` 1, `CodeGroup` 1, `Expandable` 1. Never used: `Frame`, `Tabs`, `Icon`, `Tooltip`, `Columns`, `Snippet`. `ParamField` uses `path=`, `body=`, `query=`, `header=` attributes with `type`, `required`, `default`; `ResponseField` uses `name`, `type`, `required`; nesting via `<Expandable title="properties">` (`develop/runtime-api.mdx:79-90`).

**Callout conventions.** `Warning` opens with a bold one-line thesis, then the reason ("**Guardrails are an authoring and testing surface in this release.** …"). `Note` is used for product quirks and naming traps; `Info` for lifetimes, defaults, and deployment-only behaviour; `Tip` for workflow advice; `Check` once, for a security property. Callouts never contain headings; some contain a fenced block (`self-hosting/database-and-migrations.mdx:84-92`).

**Headings.** One `#`-less page body: the H1 comes from frontmatter. `##` for sections, `###` for subsections, no `####`. Headings are sentence case and frequently full clauses or questions ("Who can do what", "Why an organization key is invisible from a workspace", "The key you cannot have yet"). Product nouns keep their capitals ("The Usage page", "The Billing page"). Average 6 `##` and 4 `###` per page; reference pages go deeper (`runtime-api` 12/19, `factory-cli-reference` 12/18).

**Prose.** Second person, present tense. UI strings in backticks, control labels in bold, blockquotes for longer UI copy, monospace for paths, env vars and ids; placeholders as `<your-receipt-host>` or `{name}`. Secret values never appear; variable names do.

**Tables.** On 39/49 pages: "Message | Meaning | What to do" for errors, "Symptom | Cause | Fix" for troubleshooting, "Flag | Default | Effect" for CLI flags. Long enumerations are tables or comma lists, never nested bullets.

**Code blocks.** 159 fences: `bash` for commands (with `#` step comments), `json` for envelopes, bare or `text` for output and error strings, plus `toml`, `ts`, `mermaid`. Output follows the command in its own fence. One `CodeGroup` (R2 vs S3 env, `self-hosting/configuration.mdx:78-95`).

**Mermaid.** Eight diagrams: `flowchart TB/LR/TD` ×5, `graph TD` ×1, `stateDiagram-v2` ×1, `sequenceDiagram` ×1 (with an `%%{init}%%` sizing block, `develop/jobs-and-durable-execution.mdx:87`). One diagram uses `classDef` with the brand green `#0D9373` to highlight the canonical path (`guides/managing-conversations.mdx:20-21`). Each is introduced by a sentence and followed by a one-paragraph reading of it.

**Links.** Internal links are root-relative slugs without extension, written as descriptive anchor text (`[Bring your own key](/platform/bring-your-own-key)`), 113 of them site-wide. One external link (`http://localhost:3000` in `repo/local-development.mdx:172`). No `href=` JSX links except inside `Card`.

**The next-step convention.** Every page (49/49) ends with a single line `Next step: [verb phrase](/slug)…`, always the last line, always one link, forming a linear reading order across the whole site (the spec's "fourteen-page new-user path"). Two pages also carry a `CardGroup cols={3}` above that line (`introduction`, `guides/getting-help`). The seven-section restructure will break the single linear chain; decide whether each section gets its own chain or the line becomes "Next: …" cards.

**Images.** None. No `images/` directory, no `<Frame>`, no screenshots. The spec explicitly chose Mermaid over image assets (§9). If screenshots are added, `check-docs.mjs` already tolerates them (see §7).

---

## 5. Redirects

### 5.1 Existing redirects (`docs.json:174-223`)

| Source | Destination |
| --- | --- |
| `/user-guide` | `/getting-started/your-first-chat` |
| `/quickstart` | `/getting-started/your-account` |
| `/development` | `/repo/local-development` |
| `/connector` | `/platform/integrations` |
| `/connectors/:slug*` | `/platform/integrations` |
| `/regulations` | `/platform/data-handling-and-security` |
| `/regulation/:slug*` | `/platform/data-handling-and-security` |
| `/data-classification` | `/platform/data-handling-and-security` |
| `/search` | `/guides/managing-conversations` |
| `/support/contact-us` | `/guides/getting-help` |
| `/essentials/:slug*` | `/introduction` |
| `/api-reference/:slug*` | `/develop/runtime-api` |

All twelve point at pages that will move, so each needs its destination rewritten (Mintlify redirects do not chain reliably). The app's sidebar footer hard-codes `https://docs.kentron.ai/introduction` (`Receipt/apps/start/src/components/layout/app-sidebar.tsx:57`), so `introduction` must keep resolving.

### 5.2 Proposed redirect map (current slug → proposed slug)

Slugs follow the seven sections as `co-worker/`, `mcp-gateway/`, `llm-gateway/`, `catalog/`, `guard/`, `core/`, `cli/`. Where a page splits, the redirect goes to the part that keeps the page's primary subject.

| Current | Proposed | Section |
| --- | --- | --- |
| `introduction` | `introduction` (keep; becomes the hub) | root |
| `getting-started/your-account` | `core/accounts/your-account` | 6 |
| `getting-started/your-first-chat` | `co-worker/your-first-chat` | 1 |
| `getting-started/connect-an-app` | `mcp-gateway/connect-an-app` | 2 |
| `getting-started/background-runs` | `co-worker/background-runs` | 1 |
| `getting-started/receipts-and-replay` | `co-worker/replay` | 1 |
| `guides/files-and-attachments` | `co-worker/files-and-attachments` | 1 |
| `guides/managing-conversations` | `co-worker/conversations` | 1 |
| `guides/errors-and-limits` | `co-worker/errors-and-limits` | 1 |
| `guides/monitoring-your-runs` | `co-worker/monitoring` | 1 |
| `guides/receipt-in-slack` | `co-worker/slack` | 1 |
| `guides/getting-help` | `getting-help` (root) | — |
| `platform/organizations-and-workspaces` | `core/organizations-and-workspaces` | 6 |
| `platform/members-roles-and-invitations` | `core/members-roles-and-invitations` | 6 |
| `platform/model-policy` | `llm-gateway/providers-and-models` | 3 |
| `platform/bring-your-own-key` | `llm-gateway/bring-your-own-key` | 3 |
| `platform/guardrails` | `guard/guardrails` | 5 |
| `platform/organization-skills-and-knowledge` | `catalog/skills` | 4 |
| `platform/usage-and-billing` | `llm-gateway/usage-and-cost` | 3 |
| `platform/integrations` | `mcp-gateway/receipt-connect` | 2 |
| `platform/connection-scopes` | `mcp-gateway/connection-scopes` | 2 |
| `platform/manage-tools-and-permissions` | `mcp-gateway/tools-and-permissions` | 2 |
| `platform/mcp-gateway` | `mcp-gateway/aggregate-server` | 2 |
| `platform/data-handling-and-security` | `guard/data-handling-and-telemetry` | 5 |
| `cli/overview` … `cli/observe-claude-code` (8) | unchanged | 7 |
| `develop/<page>` (5, same basename) | `core/<page>` | 6 |
| `self-hosting/<page>` (5, same basename) | `core/self-hosting/<page>` | 6 |
| `repo/local-development`, `repo/factory-overview`, `repo/authoring-agents`, `repo/testing-and-simulation` | `core/local-development`, `core/factory`, `core/authoring-agents`, `core/testing-and-simulation` | 6 |
| `repo/in-repo-cli`, `repo/receipts-and-jobs-commands`, `repo/factory-cli-reference` | `cli/from-source/in-repo-cli`, `cli/from-source/receipts-and-jobs`, `cli/from-source/factory-reference` | 7 |

Wildcard form to add for the old tab prefixes once every page has moved: `/getting-started/:slug*`, `/guides/:slug*`, `/platform/:slug*`, `/develop/:slug*`, `/self-hosting/:slug*`, `/repo/:slug*` → the section overview page, placed *after* the explicit rows above. New pages with no predecessor (Agent Registry, MCP Gateway workspace UI, Org Brain, compliance policy, billing) need no redirect.

`check-docs.mjs:103-107` rejects a source that collides with a real page and requires every non-wildcard destination to be a navigation page, so add the explicit rows only once their destinations exist.

---

## 6. Design-spec sections 10–12 restated as a checklist

Status key: **holds** (verified at `c3c16be6`), **changed** (must be edited), **unverified** (no source change found, not re-read in this pass).

### 6.1 Accuracy requirements (§10)

| # | Requirement | Status | Evidence |
| --- | --- | --- | --- |
| A1 | Claude Code metadata mode does not redact prompts from the normalized receipt; warn against capturing sensitive sessions. | unverified — no commits under the observer/import paths in range | `cli/observe-claude-code.mdx:12-18` still states it |
| A2 | Imports upload by default after `receipt setup`; `--local-only` keeps them local; setup installs the observer unless declined. | holds | `connect-cli.ts:88-92` (usage), page unchanged |
| A3 | ZDR restricts model selection and gates tools; it does not suppress error telemetry; never "end-to-end". | unverified — policy and telemetry code unchanged in range | `platform/data-handling-and-security.mdx:124-136` |
| A4 | Guardrails can be authored and tested but no chat/agent path invokes enforcement. | **holds** (re-verified): `applyGuardrails`/`guardPrompt`/`guardResponse`/`guardToolResult` have zero callers; the service header's "The orchestrator calls this at three points" describes an intent, not a call site | `guardrail-enforcement.service.ts:1-12,82-129`; grep across both trees |
| A5 | Plan feature gating does not fire; what differs is seats, metered budget, support. | unverified in this pass; billing changed only to make the free seat count overridable | `workspace-usage/shared.ts:27-34` |
| A6 | Four lanes: `chat`, `collect`, `steer`, `follow_up`. | unverified — queue contract not touched by the range's projection fixes | `develop/jobs-and-durable-execution.mdx:12` |
| A7 | "The released binary has no baked-in gateway URL. A plain `receipt setup` fails until the host is supplied." | **changed — now the opposite.** Release builds bake `https://app.kentron.ai` (`RECEIPT_CLI_DEFAULT_PROD_GATEWAY_URL`) and the build fails unless `doctor --json` reports it from an empty environment. The CLI tab already says so; the spec and `repo/in-repo-cli.mdx` do not. Caveat: only from `v0.1.0-preview.7`; preview.6 still fails as A7 describes. | `build-receipt-cli-release.sh:9,73-76,106-107`; `receipt-connect-command-proxy.ts:51,616`; `docs/receipt-cli.md:19-30` |
| A8 | The Teams service reads unprefixed `CLIENT_ID`, `CLIENT_SECRET`, `TENANT_ID`. | unverified — `apps/teams` has 0 commits in range; no Teams page exists | — |
| A9 | `receipt new` writes a file whose import path does not exist. | unverified — `cli.ts` and `sdk` unchanged | `repo/authoring-agents.mdx:6-15` |
| A10 | Rotating either AES key is irreversible; stated once, prominently, on the configuration page. | holds (no change to the key paths) | `self-hosting/configuration.mdx:62-68` |
| A11 | "`/tasks`, `/sessions`, `/computers` are reached by direct URL; Computers also has a footer widget. Usage and Billing have no sidebar entry." | **changed / half wrong from the start.** First sentence holds (`hideFromPrimaryNavigation: true`). Second sentence is false and was false at the snapshot: Usage and Billing are utility-rail icons, and Org Brain is a primary rail icon. | `-organization-settings-nav.ts:220-224,243-264`; `tasks-nav.config.tsx:22` |
| A12 | Configuration and API references are generated from code, not from `docs/api/*.md`. | holds as a rule; note that `Receipt/docs/receipt-cli.md` is now the *authoritative* public-CLI doc in the repo and the CLI tab was written from it plus source | `docs/receipt-cli.md` |

**New accuracy requirements the rewrite must add (A13–A17):**

- **A13.** The Agent Registry is implemented and reachable (sidebar **Agents → Registry**). It inventories AWS, Azure and Google Cloud accounts, classifies autonomy **L1 Observe / L2 Advise / L3 Approval / L4 Autonomous**, assigns a risk level, and its Dashboard shows **Total agents discovered**, **Critical risk**, **High risk**, **Agents with no owner**, **Dormant (30+ days)** and three distribution charts (`agent-risk-dashboard.tsx:83-84,123-162`). Results are receipt-backed (`agent-inventory.ts`); its connection is named `agent-registry` and hidden from Integrations.
- **A14.** The Model Gateway **Playground** is still a stub (an `<h1>` only) and stays in the omissions register.
- **A15.** The released CLI has `login`, `logout`, `doctor`; `setup` refuses expired sessions; the most recent `setup` target becomes active; `connect` commands reuse the saved session and re-login once on 401. The `v0.1.0-preview.6` → `preview.7` gap must be stated on the install page until the installer default is bumped.
- **A16.** `/` redirects to `/auth/sign-up` on every host except the public marketing hostname; do not describe a landing page on the app origin. The marketing hostname itself is on the validator's forbidden list (`check-docs.mjs:123`), so name it generically.
- **A17.** Free-plan seats default to `RECEIPT_DEFAULT_FREE_SEAT_COUNT` (5). Do not print "5 seats" as a constant.

### 6.2 Publication safety (§11) — still binding, one addition

| Rule | Status |
| --- | --- |
| No cloud account numbers, ARNs, EIPs, instance ids, secret-store paths, CI role names, internal DNS, log groups, tailnet hosts, the internal Slack team id. | Enforced by `check-docs.mjs:112-124`; site currently clean of these. |
| No named individuals, personal emails, home-dir paths, or one-person workflows. The D4 carve-out for a personal-namespace installer URL **no longer applies**: the installer lives under `kentronai` now (`docs/receipt-cli.md:34`, `a6a32fc7`). | **Currently violated** by `cli/doctor.mdx:88,109` (`/Users/you`). Fix to `~`. |
| No internal runbooks, cutover checklists, release governance, or npm wrapper names. | Holds; note the repo added `docs/receipt-cli-debug-report.md` and `skills/receipt-connect-cli-prod-debug/SKILL.md` in range — internal, do not quote. |
| Name credential variables, never values. | Holds. |
| Debug credential-minting and webhook forging: existence only. | Holds (`develop/runtime-api.mdx:400-402`). |
| No at-rest claim about Slack bot tokens; Teams claim-link replay not documented. | Holds (`platform/data-handling-and-security.mdx:18-20`). |
| Convert local absolute paths to `~` or repo-relative. | Holds except the two doctor lines. |
| **Addition:** the marketing hostname literal is banned by the validator; the new root-redirect sentence must say "the marketing site" instead. | New |

### 6.3 Omissions register (§12) — re-evaluated

| Item | Original reason | Status at `c3c16be6` |
| --- | --- | --- |
| Model Gateway playground | stub | **still a stub** (`playground.tsx:9-16`); keep omitted, mention once on getting-help |
| Both Agent Registry pages | stub | **no longer a stub — remove from the register and give it a Catalog page.** The Dashboard route now redirects into the Registry's `?tab=dashboard`, so it is one page with two tabs, not two pages. |
| SSO/directory provisioning, extraction analytics, `/organization/settings/tools` (still redirects, `tools/route.tsx:10-12`), `/ironclad` (still → `/tasks`, `ironclad/route.tsx:4-9`), the enterprise console, `receipt factory doctor`, the experiment/helper harnesses and simulator UI, agent framework adapters, personal API keys, a public REST chat API, social sign-in and 2FA enrolment, the OTLP exporter | inert or absent | unchanged in range; keep omitted |
| Microsoft Teams page | withheld pending decision | `apps/teams` unchanged; decision still open |
| Per-plan pricing table | conflicting numbers | still withheld; `RECEIPT_DEFAULT_FREE_SEAT_COUNT` now makes the seat number deployment-specific, strengthening the case |
| Support channel on getting-help | no real channel | dead links still present (`en.json:415,841-842`) |
| Corporate relationship sentence | no source | still open (`routes/index.tsx:7-14` documents one build serving both sites but names no entity) |

**New omissions to register:** the Policies page's non-guardrail modules (its own copy calls them not connected — `policies-page.tsx:117`); the MCP Gateway **Users** and **Live activity** tabs' organization-wide totals are labelled "Across the organization" while living under a workspace URL (`mcp-gateway-dashboard-page.tsx:559-579`) — document the Dashboard tab, describe the other two carefully or omit until scoped.

---

## 7. The validator and the Mintlify navigation options

### 7.1 What `scripts/check-docs.mjs` enforces

Run from the repo root: `node scripts/check-docs.mjs` (construction mode) or `node scripts/check-docs.mjs --complete` (release mode). Zero dependencies; exits 1 with a numbered problem list, or prints `OK  <n> pages, <m> navigation entries[, complete]`.

| Check | Lines | Rule |
| --- | --- | --- |
| Navigation duplicates | 23-37 | Recursively collects strings under the keys `tabs`, `anchors`, `products`, `menu`, `groups`, `pages`; any slug listed twice fails. |
| Orphans / missing | 39-67 | Walks the repo for `.md`/`.mdx`, skipping `.git`, `.github`, `.superpowers`, `node_modules`, `docs`, `research`, `scripts`, `logo`, `public`, `images`, `snippets` and the file `README.md`. Every file must be in navigation; with `--complete`, every navigation entry must have a file. |
| Frontmatter | 69-78 | A leading `---` block with a non-empty `title` (quotes stripped, so `title: ""` fails). `description` is not checked. |
| Internal links | 80-98 | Every `](/…)` and `href="/…"` target must be a page slug or a declared redirect source; targets ending in a 2–4 character extension are treated as assets and skipped. |
| Redirects | 100-108 | A redirect source may not collide with a real page; a non-wildcard destination must be a navigation page. |
| Publication safety | 110-134 | 12-digit account numbers (placeholder `123456789012` allowed), IAM ARNs, EC2 instance ids, public IPs, `/Users/<anything but me>`, tailnet hostnames, two internal deploy names, the marketing domain, two named identifiers. |

### 7.2 Changes the restructure needs

1. **An `images/` directory needs no change.** `images` is already in `SKIP` (`:43`), so screenshots there are not treated as content, and any link ending in `.png`/`.svg`/`.jpg` is skipped by the asset rule (`:93`). Two things to watch: a link to `/images/foo.webp` passes (4-character extension) but `/images/foo.jpeg` also passes; `/images/foo` without extension fails as a broken link — always keep the extension. Do not put images under `docs/`, which `.mintignore` excludes from the build.
2. **A seven-section `docs.json` works with `tabs` or `products`, but not with `dropdowns` or `versions`.** `collect()` (`:27`) only descends into `tabs`, `anchors`, `products`, `menu`, `groups`, `pages`. If the new structure uses `dropdowns`, `versions`, or `languages`, every page becomes an "orphan" and the harness fails. Add `'dropdowns', 'versions', 'languages'` to the key list at `:27` before switching.
3. **Group-level `root` pages** (`"root": "co-worker/overview"`) are strings under a key the collector does not read, so a root page that is not also listed in `pages` would be flagged as an orphan; add `'root'` to the list or list the page in `pages` too.
4. **The expected green line in `README.md:72` is wrong today** ("48 pages"); the actual count is 49. Update the README with the new count after the move.
5. **Add a check that every page ends with the next-step line** if the convention is kept; the harness does not test it today.
6. Consider adding the string `/Users/you` to the README's writing guidance, since it is the only violation the site has ever had.

### 7.3 Mintlify navigation options relevant to seven sections

From `https://mintlify.com/docs/navigation` (fetched 2026-09-08):

| Structure | Key | Fit for seven product sections |
| --- | --- | --- |
| `tabs` (current) | `{"tab": "…", "icon": "…", "groups": [...]}` | Minimal-change path: seven tabs, each holding its groups as today. Tabs accept `icon`, `href`, and a `menu` array (`{"item", "icon", "groups"}`) for a multi-column dropdown if Core grows. |
| `products` | `{"product": "…", "description": "…", "icon": "…", "groups"|"pages"|"menu": [...]}` | Built for "separate documentation for distinct offerings" — the closest match. Each entry needs `product` and may hold groups, pages, a menu, or an `href`. The validator already collects `products`. |
| `anchors` | `{"anchor": "…", "icon": "…", "pages"|"groups": [...]}` | Persistent sidebar links; better for cross-cutting links (home, support) than seven peers. `"global": {"anchors": [...]}` shows them on every page. |
| `dropdowns` | `{"dropdown": "…", "icon": "…", "pages": [...]}` or `{"dropdown": "…", "href": "…"}` | A switcher at the top of the sidebar. Works for seven products but needs the validator change in 7.2. |
| `versions` / `languages` | — | Not applicable. |
| Group extras | `tag` ("NEW"), `root`, `directory` ("accordion"/"card"/"none"), `expanded` | `root` + `directory: "card"` would let each section's overview page auto-render its child list; note the validator caveat above. |

Two rules from the page: one root-level parent element is required, and "each navigation element can contain one type of child element at each level" — a `products` entry holds `groups` *or* `pages`, not both. Run `mint validate` before publishing.

Recommendation: `products` (or `tabs` with icons) for the seven sections, `global.anchors` for "Contact Us" and "GitHub" so they survive the loss of the Guides tab's cards, and `groups` with `root` overview pages inside each product.

---

## Changes since 41baea75

Forty-three implementation commits (`git log --oneline 41baea75..c3c16be6`, 192 files, +11,984/−1,513). The ones that change what a page must say:

1. **Public CLI rewrite (`9b8b7574`, `3c52d87c`, `53f74bed`, `a6a32fc7`).** Release builds bake `https://app.kentron.ai` and are smoke-tested for it with dotenv/bunfig autoload disabled (`scripts/build-receipt-cli-release.sh:9,73-76,106-107`). New verbs `login [target]`, `logout`, `doctor [--json]` (`connect-cli.ts:72-74`). `setup` refuses an expired session and activates the target it used; the `connect` commands reuse the saved session, send a token only to its own normalised host (`receipt-connect-command-proxy.ts:381`), and re-login once on 401. Installer references moved to the `kentronai` organization; `docs/receipt-cli.md:19-30,217-233` records that `preview.6` still fails on a fresh machine and that a fix ships only when a release exists and `install.sh` pins it. **Doc impact:** CLI tab already correct; `repo/in-repo-cli.mdx` and spec A7 are wrong; `cli/install.mdx` needs the pin.
2. **Agent Registry built out (`26ec975a`…`c3c16be6`, ten commits).** Receipt-backed inventory across AWS (Bedrock Agents, AgentCore, Lambda, Step Functions, ECS, EC2; regions auto-discovered), Azure (subscriptions auto-discovered) and GCP; autonomy L1–L4 with IAM-derived tools/permissions/data access; a risk dashboard; connect/scan/disconnect dialog with count-stating toasts (`{label} scan completed: N agents found.`); View details; a local error boundary (`Agent Registry couldn't load.`). **Doc impact:** `guides/getting-help.mdx:29` stale; new Catalog page; omissions entry removed.
3. **MCP Gateway UI pass (`46652e84`).** Workspace table drops Created and adds View details with a details dialog; one shared `TabList` across six pages; a Dashboard tab on the workspace strip; delete confirmation types `Delete`; sidebar tooltips become accessible names; `receipt setup` becomes step one of the setup panel. **Doc impact:** `platform/organizations-and-workspaces.mdx`, `platform/mcp-gateway.mdx`, `guides/monitoring-your-runs.mdx:29`, `guides/managing-conversations.mdx:51`.
4. **Pending workspace invites (`c3c16be6`).** The workspace Settings tab shows Pending rows with Cancel invitation for both invite paths (`mcp-gateway-settings-page.tsx:110-115,172-193,314-319,376-382`; `receipt-workspaces.ts` pending-invite query). **Doc impact:** add to members page.
5. **Root redirect (`c3c16be6`).** `/` → `/auth/sign-up` when self-hosted or when the request host is not the public marketing hostname (`routes/index.tsx:15,25-30`). **Doc impact:** `getting-started/your-account`, `self-hosting/overview`; wording constraint from the validator.
6. **Skills in the composer and palette (`c3c16be6`).** `+` → Skills → Create skill (`prompt-input-actions-menu.tsx:91-107`); Cmd+K "Skills" (`chat-search-command-dialog.tsx:271-281`). **Doc impact:** `your-first-chat`, `managing-conversations`, `organization-skills-and-knowledge`.
7. **`RECEIPT_DEFAULT_FREE_SEAT_COUNT` (`c3c16be6`).** Free-plan seat ceiling overridable per deployment, default 5 (`workspace-usage/shared.ts:27-34`). **Doc impact:** `self-hosting/overview:53`, `self-hosting/configuration`, members/billing pages.
8. **Slack routing failure is explicit (`ab7b00b0`).** `/chat/route` failures throw `Receipt couldn't determine the access needed for this request. Please retry; no task was started.` instead of a silent Factory fallback (`slack-chat-routing.ts:81-96`; `chat-layer-routing.ts:460-461`). **Doc impact:** `guides/receipt-in-slack`, `guides/errors-and-limits`.
9. **Projection durability series (`00ef6f17`…`2010f1c7`, `71ffa060`, `8c74802b`, `61751714`, `6b79dc82`).** Fourteen replay/checkpoint/redrive fixes plus migration `20260905_durable_projection_work.sql`. No user-visible strings; recount the migration total and the projection-table list.
10. **Nango Azure service-principal patch (`deploy/patches/nango-azure-service-principal.mjs`, `deploy/Dockerfile.nango`).** Supports the Agent Registry's Azure connection; the integration-surface audit's expected counts changed (`68b7fa3a`). **Doc impact:** recount the connector table before publishing it as the Catalog.
11. **Not changed in range:** auth backend, org Members page, BYOK, guardrails (still un-enforced), policy routes, Usage/Billing, Knowledge, Security, Analytics, Tasks/Sessions/Computers, Teams adapter, runtime `server.ts`, SDK, in-repo `cli.ts`, the Connect gateway service, the supervisor scripts, and the org-settings rail config — which is how the Usage/Billing sidebar claim is shown to have been wrong at authoring time, not drifted.

---

## Documentation implications

### What to claim, and where the existing text goes

- **Reuse ratio.** Of 49 pages, 38 carry over with at most a paragraph of edits, 7 need targeted rewrites of specific sections (`introduction`, `your-first-chat`, `monitoring-your-runs`, `getting-help`, `organizations-and-workspaces`, `usage-and-billing`, `mcp-gateway`, `in-repo-cli`), and 5 should be split into two or three pages to fit the product sections (`model-policy`, `organization-skills-and-knowledge`, `integrations`, `data-handling-and-security`, `usage-and-billing`). Nothing should be deleted outright; every page's subject survives.
- **Suggested page split by section (new pages marked ★):**
  1. **Receipt AI Co-Worker (10):** overview★, your-first-chat, background-runs, replay, files-and-attachments, conversations, errors-and-limits, monitoring, slack, teams (still withheld — see open questions).
  2. **MCP Gateway (7):** overview★, connect-an-app, receipt-connect, connection-scopes, tools-and-permissions, aggregate-server, workspaces-and-activity★ (workspace table, details dialog, Overview tabs, Gateway activity).
  3. **LLM Gateway (5):** overview★, providers-and-models, model-policy, bring-your-own-key, usage-and-cost; the Playground gets one sentence on the overview, not a page.
  4. **Kentron Catalog (6):** overview★, agent-registry★, connectors (the 62-row table), skills, knowledge, org-brain★.
  5. **Kentron Guard (5):** overview★, guardrails, compliance-policy★ (the three flags and ZDR, lifted from model-policy and data-handling), data-handling-and-telemetry, security-reporting (sessions/cookies/origins/vulnerability reporting).
  6. **Kentron Core (17):** overview★, accounts/your-account, organizations-and-workspaces, members-roles-and-invitations, billing-and-plans, architecture, receipts-and-streams, jobs-and-durable-execution, runtime-api, typescript-sdk, factory, authoring-agents, testing-and-simulation, local-development, self-hosting/{overview, configuration, database-and-migrations, integrations-provider, deploying}.
  7. **Receipt CLI (12):** the eight released-binary pages unchanged, plus a `from-source/` group holding in-repo-cli, receipts-and-jobs, factory-reference, and a one-page "which binary am I running" bridge★ (the side-by-side table from `cli/overview`).
- **What to avoid claiming.** Do not say guardrails enforce anything; do not say the Playground works; do not say Usage/Billing/Org Brain are hidden; do not say "5 seats" as a constant; do not name the marketing hostname; do not describe the released CLI as lacking `login`; do not present "Across the organization" gateway totals as workspace figures; do not carry the Beetle Chat label; do not say Teams is documented until the withheld decision is made.
- **Style to keep.** The exact-string-in-backticks convention, the "Symptom | Cause | Fix" tables, the opening-thesis `Warning`, Mermaid over screenshots, and the frontmatter pair. Decide explicitly what replaces the single linear "Next step" chain; a per-section chain with a "Where next" card group on each overview page is the least disruptive.

### The seven product-section claims, assessed

| Claim (from the restructure brief) | Status | Reason |
| --- | --- | --- |
| Co-Worker = chat app, background runs, replay, files, conversations, Slack and Teams, skills, monitoring pages | **partial** | Everything exists except a Teams page, which the spec withheld pending a decision (`apps/teams` unchanged, still no page). Skills authoring from chat exists (router "author a skill" decision; composer Create skill). |
| MCP Gateway = workspaces, connections/integrations, Receipt Connect, tool permissions, aggregate MCP server, gateway activity | **supported** | All implemented and reachable to any org member; gateway activity is per-workspace (`…/workspace/$id/dashboard`), with no org-level dashboard (`mcp-gateway/dashboard.tsx:16-18`). |
| LLM Gateway = model catalog, providers, BYOK, model/provider/compliance policy, playground, usage and cost | **partial** | Catalog, providers (2 of 32 executable), BYOK (OpenAI shown; Anthropic hidden), policy, and Usage are real. Playground is a stub; Usage numbers are per-user despite "across the organization" copy; "Require organization provider key" is never read. |
| Catalog = Agent Registry (cloud agent inventory), connector catalog, skills catalog, Org Brain and Knowledge | **supported** (as of `c3c16be6`) | Agent Registry now real with AWS/Azure/GCP and L1–L4; connector catalog is the 62-row manifest; skills page real; Org Brain is a read-only analytics dashboard (call it that, not a knowledge store); Knowledge is URL-only. |
| Guard = guardrails, policies, compliance, access control, security, data handling | **partial** | Guardrails author/test only; Policies page modules other than guardrails are "not connected" by its own copy; Require ZDR enforces (model selection + one tool), Require org key does not; Enforce Study Mode enforces; SSO/directory is a stub; access control (roles, settings gate, workspace authority) and data-handling facts are solid. |
| Core = identity, orgs, workspaces, members, billing, receipts and streams, runtime, jobs, APIs, SDK, configuration, local dev, self-hosting | **supported** | All documented from code; self-hosted mode is real but requires a custom build (`self-hosting/overview.mdx:6-12`). |
| CLI = released binary plus a from-source developer CLI | **supported, with a release caveat** | The two-binary split is documented and verified; the released binary's new verbs exist only from `v0.1.0-preview.7`, and the installer default may still be `preview.6` (`docs/receipt-cli.md:19-30`). |

---

## Open questions

1. **Which installer default ships today?** `Receipt/docs/receipt-cli.md:19-30` says pin `RECEIPT_CLI_VERSION=v0.1.0-preview.7` "until the installer default is bumped". The `install.sh` in `kentronai/receipt-cli` is outside both repositories, so whether the pin is still needed cannot be verified here. The install page's "nothing to configure" depends on the answer.
2. **What is `add21f9`?** Most research files cite it as their snapshot commit, but it is not an object in this clone. If the research was written from a different fork or a since-rewritten branch, the "41baea75" baseline for the corpus is itself approximate.
3. **Teams page.** Still withheld (§12). `apps/teams` did not change; the blocking question (a Teams org without an OpenAI key cannot run background work) remains unanswered.
4. **Gateway activity scoping.** The workspace Dashboard's Users and Live-activity tabs label their totals "Across the organization" while sitting under a workspace URL (`mcp-gateway-dashboard-page.tsx:559-579`), and the nav comment says tool receipts carry no workspace id (`-organization-settings-nav.ts:59-64`). Which scope should the docs describe?
5. **Org Brain's home.** It is an activity dashboard, not a knowledge store (`guides/monitoring-your-runs.mdx:38`). The brief puts it under Catalog with Knowledge; Co-Worker monitoring or LLM Gateway usage would be a more honest fit. Needs a product decision.
6. **Replay dialog tab labels.** Summary / Transcript / Work were not re-verified after the `46652e84` tablist rework; confirm before publishing `co-worker/replay`.
7. **Connector and tool counts.** "62 connectors" and "89 static tools: 86 read, 3 write" (`platform/integrations.mdx:101,172`) predate the Azure connector change in the audit test (`68b7fa3a`); recount from the manifests.
8. **Next-step convention.** The site's single linear chain cannot survive seven sections. Per-section chains, or overview cards only?
9. **Navigation structure.** `products` vs seven `tabs` vs `dropdowns` — the validator supports the first two today and needs a one-line change for the third (`check-docs.mjs:27`).
10. **Corporate relationship sentence** on the introduction (Receipt / Beetle / Kentron / the contracting entity) is still unsourced; the root route now shows one build serving both the marketing site and the app but names no entity.
