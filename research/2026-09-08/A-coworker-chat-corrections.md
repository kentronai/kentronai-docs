# Fact-check of `A-coworker-chat.md` against HEAD `c3c16be6`

Checked 2026-09-08 against the working tree at `c3c16be6` (`git status` clean apart from three
untracked/deleted files outside the report's scope). Every cited path in the report exists; the
report abbreviates several paths (see "Path notes"). All line numbers below are at HEAD.

Verdict legend: **confirmed** = evidence matches the claim; **wrong** = evidence contradicts the
claim (citation given); **unverifiable** = no evidence either way found.

## Claim table

| # | Claim (report section) | Verdict | Correction | Evidence (path:line) |
|---|---|---|---|---|
| 1 | Rate-limit defaults paid 30/60 s, free 10/60 s, free allowance 100/24 h; env names `PAID_CHAT_RATE_LIMIT_WINDOW_MS`, `PAID_CHAT_RATE_LIMIT_MAX_REQUESTS`, `FREE_CHAT_RATE_LIMIT_WINDOW_MS`, `FREE_CHAT_RATE_LIMIT_MAX_REQUESTS`, `FREE_CHAT_ALLOWANCE_WINDOW_MS`, `FREE_CHAT_ALLOWANCE_MAX_REQUESTS`; non-positive value throws `Expected {NAME} to be a positive integer` (§1.2) | confirmed | — | `apps/start/src/lib/backend/access-control/index.ts:34-39, 41-51, 113-148` |
| 2 | `isFreeTierContext` returns `false` unconditionally, so the free allowance never applies (§1.2, §14) | confirmed | — | `apps/start/src/lib/shared/access-control/index.ts:405-407`; `apps/start/src/lib/backend/access-control/index.ts:108` (allowance only built in the free branch); `chat-orchestrator.service.ts:401-403` (`if (allowance)`) |
| 3 | `VITE_DISABLE_REDIS=true` swaps in `RateLimitService.layerDisabled` / `StreamResumeService.layerDisabled`; no rate limiting and `GET /api/chat` always 204 (§1.2) | confirmed | — | `apps/start/src/lib/backend/chat/runtime/chat-runtime.ts:30-36`; `apps/start/src/utils/app-feature-flags.ts:62`; `apps/start/src/lib/backend/chat/services/rate-limit.service.ts:153-159` (always `allowed: true`); `stream-resume.service.ts:804-807` (`getActiveStreamId` → `null`); `apps/start/src/routes/api/chat/route.tsx:100-106` |
| 4 | Router system prompt text "You are the Beetle chat router. Return one routing decision only; …" and `CHAT_ROUTER_MAX_OUTPUT_TOKENS` 1,200 (§1.3) | confirmed | — | `packages/receipt-app/src/services/chat-layer-routing.ts:16-17`; `apps/start/src/lib/backend/chat/services/receipt-chat.service.ts:105` |
| 5 | Fail-closed change: at `41baea75` an unusable router result returned `{ route: "factory" }`; at HEAD `resolveChatLayerModelDecision` re-asks once ("Review this candidate routing decision for dependency scope") then throws `CHAT_ROUTING_UNAVAILABLE_MESSAGE` = "Receipt couldn't determine the access needed for this request. Please retry; no task was started." (§1.3, Changes #1) | confirmed | — | `chat-layer-routing.ts:459-506` (throw at 505); `git show 41baea75:packages/receipt-app/src/services/chat-layer-routing.ts` lines 470-472 return `{ route: "factory" }` and the constant does not exist there |
| 6 | Direct answer calls `modelGateway.streamResponse` with `tools: {}` and `activeTools: []`; the Tools checkboxes are inert at runtime (§1.4, §2.1) | confirmed | Stronger than stated: `disabledToolKeys` is never read by `receipt-chat.service.ts` at all, so the checkboxes are inert for the Factory path too, not only the direct path. The orchestrator only sanitises/records them. | `receipt-chat.service.ts:3624-3631`; `chat-orchestrator.service.ts:1066` (only `streamResponse` call site); `chat-orchestrator.service.ts:319-326` (`toolPolicy.sanitizeThreadDisabledToolKeys`); grep of `disabledToolKeys` in `receipt-chat.service.ts` returns nothing |
| 7 | Factory job payload: `kind: 'factory.run'`, `lane: 'chat'`, `sessionKey: factory-chat:<stream>`, `singletonMode: 'allow'`, `maxAttempts: 2`, `config { maxIterations: 1, maxToolOutputChars: 6000, memoryScope: 'factory-chat:auto', workspace: '.' }`, `authContext.source: 'app-chat'`, `requestedProviders: []` without a router decision, `capabilityContext.source` "always" `'latest-user-turn'` (§1.6) | confirmed (one nuance) | `capabilityContext` is omitted entirely when `requestedProviders` is empty; "always" applies only when the object is present. | `receipt-chat.service.ts:2094-2098, 2138-2150, 2169-2176, 2190-2195` |
| 8 | `+` menu order Attach files → Skills ▸ Create skill → Study Mode → Max → Tools; aria-label "Open input actions"; Skills submenu new in `c3c16be6`; destination page button reads "Add skill" (§2.1) | confirmed | — | `apps/start/src/components/chat/prompt-input/prompt-input-actions-menu.tsx:79-155`; `apps/start/messages/en.json:227`; `git show c3c16be6 -- …/prompt-input-actions-menu.tsx` adds the submenu; `skills-page.tsx:435` |
| 9 | Study Mode pins `openai/gpt-oss-120b` and disables provider tools (§2.1) | confirmed | — | `apps/start/src/lib/shared/chat-modes/registry.ts:7-26` (empty allowlists for openai/anthropic/google/xai) |
| 10 | Model and reasoning pickers are absent from the UI; `DEFAULT_CHAT_MODEL_ID = 'openai/gpt-5.6-luna'`; `MODEL_SELECTOR_ALLOWED_PROVIDER_IDS = ['openai']` (§2.2) | confirmed | — | `composer-bar/model-selector-policy.ts:9-18`; only references to `ModelSelectorPanel`/`ReasoningSelectorPanel` outside tests are re-exports in `composer-bar/index.ts:5-11`; `afterAttach` is defined in `prompt-input-toolbar.tsx:87,113,170` and never passed by `chat-input.tsx` |
| 11 | Accepted extensions list; 10 MB chat / 25 MB org knowledge; 10 files per message (§4) | confirmed | — | `apps/start/src/lib/shared/upload/upload-validation.ts:80-104`; `apps/start/src/lib/shared/upload/upload.model.ts:1-3`; `apps/start/src/hooks/chat/upload/use-file-attachments.ts:30`; `chat-input.tsx:122` |
| 12 | RAG presets 1,600/260/140/8/12,000/2,000 and 1,800/280/260/10/14,000/2,200, `openai/text-embedding-3-small` (§4) | confirmed | — | `apps/start/src/lib/backend/chat/services/rag/pipeline-config.ts:14-32` |
| 13 | Preference memory is not injected into web chat; it is "a CLI / runtime surface (`bun src/cli.ts memory prefs …`, `docs/memory.md:289-296`)" (§5) | confirmed (claim) / **wrong** (citation) | No caller in `apps/start/src/lib/backend` or `agents/factory/chat` — correct. But `docs/memory.md:289-296` is the "Read-only vs writable scopes" section; the `memory prefs` command is at `docs/memory.md:217`. Also note the runtime exposes it over HTTP: `GET <basePath>/api/user-preferences` calls `summarizeUserPreferences`. | `docs/memory.md:217, 289-296`; `packages/receipt-app/src/agents/factory/route/register-factory-api-routes.ts:672-685` |
| 14 | `/tasks`, `/sessions`, `/computers` set `hideFromPrimaryNavigation: true`; routes redirect unauthenticated/anonymous users to `/auth/sign-in?redirect=…` with no admin gate (§8) | confirmed | — | `tasks-nav.config.tsx:22`, `sessions-nav.config.tsx:20`, `computers-nav.config.tsx:20`; `routes/(app)/_layout/tasks/route.tsx:6-16` (same shape in sessions/computers) |
| 15 | Slack install scopes `app_mentions:read, channels:history, chat:write, reactions:write, users:read, users:read.email` (§9.1) | confirmed | — | `packages/receipt-core/src/slack.ts:3-10` |
| 16 | Slack funding: "BYOK validated live; without BYOK it reserves 5,000,000 nanoUSD of platform credit with a 15-minute TTL" (§9.2) | **wrong** as a description of Slack behaviour | The constants are right, but Slack never reaches funding without an OpenAI BYOK row: routing runs first (`server.ts:703`) via `POST /chat/route`, which returns 409 `openai_byok_unavailable` when `readOrgOpenAiByokApiKey` finds no `provider_id = 'openai'` row (no platform-key fallback), and the Slack adapter then throws and posts `<@user> Receipt couldn't determine the access needed…`. The platform-credit reservation is only reachable when a BYOK row exists but fails live validation (or the local mock proxy is configured). | `apps/slack/slack-platform-credit.ts:5-6`; `apps/slack/server.ts:703, 716-724`; `apps/slack/slack-chat-routing.ts:81-95`; `packages/receipt-app/src/server/bootstrap.ts:2602-2611`; `packages/receipt-app/src/services/receipt-openai-env.ts:86-140` |
| 17 | Teams `resolveTeamsChatDecision` still falls back to `{route:'factory'}` on any error, sends `priorProviders: []` and no `recentContext` (§10, Changes #1, Open Q1) | confirmed | — | `apps/teams/teams-routing.ts:28, 36, 41-54`; `git log 41baea75..HEAD -- apps/teams/teams-routing.ts` is empty |
| 18 | Teams env `CLIENT_ID`/`CLIENT_SECRET`/`TENANT_ID`, `PORT` default `3978`, `RECEIPT_WEB_URL → BETTER_AUTH_URL`; docs contradiction with `TEAMS_CLIENT_ID` etc. (§10) | confirmed | Minor omission: `WEB_URL` has a third fallback `http://localhost:3000`. | `apps/teams/server.ts:16-20, 225`; `docs/ms-teams-testing-setup.md:37-39`; `docs/teams-app-private-distribution.md:23-24` |
| 19 | Teams without BYOK throws `Factory platform funding requires an app-chat billing request id.` (`factory-model-funding.ts:85`); Slack special-cased via `slack_evt_` ids (`:54`) (§10) | confirmed | Same nuance as #16: Teams also fails earlier, at routing, without BYOK (falls back to `{route:'factory'}` then hits this funding error). | `packages/receipt-app/src/services/factory-model-funding.ts:54, 83-87` |
| 20 | Teams claim link is a 10-minute signed token, replayable, no consumed record (§10) | confirmed | — | `packages/receipt-core/src/teams.ts:13` (`CLAIM_TTL_MS = 10 * 60 * 1000`); `apps/start/src/lib/backend/teams/teams-installation-claim.service.ts` (156 lines) contains no consumed/nonce/jti handling |
| 21 | Runtime `POST /chat/route` (400 `actor_context_required`, 409 `openai_byok_unavailable` "…before semantic chat routing can run.") and `POST /chat/respond` (400 `latest_user_text_required`, 409 "…before Beetle can write a direct chat response.") (§11) | confirmed | — | `packages/receipt-app/src/server/bootstrap.ts:2587-2636, 2643-2671` |
| 22 | Tool approval policies are **Inert**: nothing outside `policies.ts` and the frontend reads `tool_approval` rules (§13) | confirmed | — | non-test references to `tool_approval`: `packages/receipt-app/src/services/policies.ts`, `apps/start/src/lib/frontend/policies/use-policies.ts`, `apps/start/src/lib/frontend/policies/policies.functions.ts` only; no `toolApproval`/`requiresApproval`/`approvalRule` in `packages/receipt-app/src` or `apps/start/src/lib/backend`; panel copy at `tool-approval-panel.tsx:130` |
| 23 | Guardrails are **Inert**: `guardPrompt`/`guardResponse`/`guardToolResult` have no callers; only import is cache invalidation from `guardrails.server.ts:93-98`; service header says the orchestrator calls it at three points (§13, Open Q3) | confirmed | — | grep of the three names outside `guardrail-enforcement.service.ts` (non-test) returns nothing; `apps/start/src/lib/frontend/guardrails/guardrails.server.ts:93-98`; `guardrail-enforcement.service.ts:4`; the only file under `apps/start/src/lib/backend/chat` mentioning guardrails is the service itself |
| 24 | Factory execution contract grants `connect:write` whenever the objective has any required capability (§13, marketing "Read-only by default") | confirmed | — | `packages/receipt-app/src/services/factory/runtime/objective-execution-contract.ts:46-51` |
| 25 | Codex runs with `-a never` and `--sandbox <mode>` or `--dangerously-bypass-approvals-and-sandbox` (§13) | confirmed | — | `packages/receipt-app/src/adapters/codex-executor.ts:764-777` |
| 26 | Write actions throw `integration action '<tool>' requires connect:write` unless the token carries `connect:write`; legacy v1 policies enable all read actions, v2 only listed ones; `PATCH /connect/connections/:id/actions` needs `connect:write` + owner/admin mutation authority (§13) | confirmed | Add: the write-scope error is HTTP 400; `allowWrite` is derived from `authorization.scopes.includes("connect:write")`; "owner/admin" is the *workspace* role. | `receipt-connect-call.ts:195-199, 1584-1590, 1908-1909`; `receipt-connect-routes.ts:888, 1177, 1555-1570, 811-826`; `packages/receipt-app/src/services/receipt-workspaces.ts:1085` |
| 27 | "The only confirm dialogs are Cancel task / Delete objective on `/tasks` and Delete skill?" (§13 last row) | **wrong** | The chat sidebar's per-thread **Delete** also opens a `ConfirmDialog` (title `Delete {title}?`, body "Deleting this objective is permanent and cannot be undone. It will also stop and remove any running tasks it started…", confirm **Delete objective**); Guardrails has **Remove guardrail** / **Delete group**. The narrower point (no confirm before *running* anything) stands. | `apps/start/src/components/chat/chat-sidebar.tsx:892-902`; `tasks-page.tsx:986, 1022`; `skills-page.tsx:391`; `guardrails-page.tsx:298, 319` |
| 28 | Nango catalog has 63 provider slugs; one (`azure-service-principal`) added in `26ec975a` (marketing "1000+ apps", Open Q9) | confirmed | — | `node -e` count of `providerSlugs` in `packages/receipt-app/src/integrations/nango/catalog.json` = 63; `git show 26ec975a -- …/catalog.json` adds `"azure-service-principal"`; `catalog.ts:506-507` reads that array |
| 29 | `/agent-registry/dashboard` redirect to `/agent-registry/registry?tab=dashboard` is "new in `c3c16be6`"; Agents area has a single child Registry (§8, Changes #6) | **wrong** (attribution) | The redirect and the single-child nav were introduced in `26ec975a` ("Add receipt-backed cloud agent inventory"); `c3c16be6` did not touch `dashboard.tsx` or the nav config. Only the error boundary ("Agent Registry couldn't load." / Try again) in `agent-registry/route.tsx` is from `c3c16be6`. | `git log --follow -- "apps/start/src/routes/(app)/_layout/agent-registry/dashboard.tsx"` → `26ec975a`; `git show 26ec975a --stat` lists `dashboard.tsx` and `agent-registry-nav.config.tsx` (removes `AGENT_REGISTRY_DASHBOARD_HREF`); `git log 41baea75..HEAD -- …/agent-registry/route.tsx` → `c3c16be6`; strings at `route.tsx:24, 30` |
| 30 | 43 commits since `41baea75`; `46652e84` removed `SidebarGroupTooltip` everywhere and deleted `layout_organization_tooltip_description` (Changes, §12) | confirmed | — | `git log --oneline 41baea75..HEAD | wc -l` = 43; `git show 46652e84 -- apps/start/messages/en.json` removes the key; no non-test `SidebarGroupTooltip` references remain |
| 31 | Usage and Billing are `railPlacement: 'utility'`, `isUtilityNavigationArea` has no caller, so they render nowhere in the sidebar; org menu shows Organization, Workspaces, Members, Models for admins and Account for everyone (§12) | confirmed | Wording nit: the report also lists **Account** under "Never in the sidebar" while stating the organization menu (in the sidebar header) shows Account. | `-organization-settings-nav.ts:251-264, 313-315`; `app-sidebar-nav.config.tsx:106-112` (only definition of `isUtilityNavigationArea`); `app-sidebar.tsx:196-206`; `sidebar-organization-menu.tsx:40-63`; items with `hiddenFromRail && !hiddenFromMenu` = general ("Organization"), workspaces, members, models |
| 32 | Normal members see MCP Gateway (§12) | confirmed | — | `MCP_GATEWAY_AREA_KEY = 'mcp-gateway'` (`mcp-gateway-nav.config.tsx:15`) is not in `ORG_SETTINGS_AREA_KEYS` (that list has `organization-mcp-gateway`, which is `hiddenFromRail`+`hiddenFromMenu`); `-organization-settings-access.ts:15` allows MCP paths for any role |
| 33 | i18n error catalogue `en.json:318-340` quoted verbatim (§14) | confirmed | — | `apps/start/messages/en.json:318-340` (all 23 strings match) |
| 34 | Thread titles: default `New Chat`, model `openai/gpt-5-mini` unless `CHAT_TITLE_GENERATION_MODEL`, prompt "Generate a short 3-4 word title…", 200-char truncation, skipped when `userSetTitle` (§2.4) | confirmed | — | `thread.service.ts:30, 469, 518, 918, 920, 926` |
| 35 | Slack implements only mentions: no slash commands, `block_actions`, modals, DMs, app home, shortcuts (§9.3) | confirmed | — | `apps/slack/server.ts:1389` (single `/events` POST route) and `:1415` (`event?.type === 'app_mention'` is the only event branch) |
| 36 | Marketing row "Lives in Slack or Teams": Teams "needs OpenAI BYOK to run Factory at all" (implying Slack does not) | **wrong** (incomplete) | Both channels need an OpenAI BYOK row before anything runs, because both route through `POST /chat/route`, which 409s without BYOK (see #16). The web chat differs: its router runs through the app model gateway, which accepts OpenAI-routed models without BYOK (`model-gateway.service.ts:116`). | `bootstrap.ts:2602-2611`; `receipt-openai-env.ts:104-140`; `apps/slack/slack-chat-routing.ts:81`; `apps/teams/teams-routing.ts:41` |
| 37 | Marketing row "any action that changes state waits for your explicit approval" = Unsupported (§13, marketing table) | confirmed | — | #22–#25 above; `sdk/actions.ts:92-97` (`human` action exists only for SDK authors); `agent-loop.ts:1816, 984` |
| 38 | Stop semantics: "This task is stopped." / "Stopped the response, but could not cancel the agent run."; abort via `POST <runtime>/jobs/<id>/abort`; control job `factory.dispatch` `action: 'cancel'` on `lane: 'chat'`, `sessionKey: tasks:<org>:<user>`; `pending` = non-terminal status (§6.4) | confirmed | — | `chat-context.tsx:3464, 3498, 3509`; `objective-control.server.ts:64-71, 153, 174` |
| 39 | Slack `View Receipt` link points at `/chat?objective=<id>`; `/chat` also accepts `objectiveId`, `objectId`, and a `/chat/<objectiveId>` segment (§6.3, §8) | confirmed | — | `apps/slack/slack-objective-response.ts:298-306`; `routes/(app)/_layout/chat/route.tsx:50-62, 84-92` |
| 40 | Report cites the toast for deleting a thread as **Objective deleted** (`chat_sidebar_thread_deleted`) (§3.2) | confirmed | — | `en.json:294` |

Totals: 40 claims checked; 4 wrong (#16, #27, #29, #36) plus one wrong citation inside an otherwise
correct claim (#13); 0 unverifiable; the rest confirmed (three with nuances: #6, #7, #26).

## Path notes (not errors, but the report abbreviates)

| Report path | Actual path |
|---|---|
| `message-store/operations/load-thread-messages.ts` | `apps/start/src/lib/backend/chat/services/message-store/operations/load-thread-messages.ts` |
| `rag/pipeline-config.ts` | `apps/start/src/lib/backend/chat/services/rag/pipeline-config.ts` |
| `upload.model.ts` | `apps/start/src/lib/shared/upload/upload.model.ts` |
| `use-file-attachments.ts` | `apps/start/src/hooks/chat/upload/use-file-attachments.ts` |
| `sidebar-computer-capacity.tsx`, `sidebar-organization-menu.tsx` | `apps/start/src/components/layout/sidebar/…` |
| `scripts/package-teams-app.mjs` | repo root `scripts/package-teams-app.mjs` (correct as written; `teams:package` is in root `package.json:86`) |
| `-organization-settings-nav.ts`, `-organization-settings-access.ts` | `apps/start/src/routes/(app)/_layout/organization/settings/…` |

No cited path is missing at HEAD.

## Leak check

- **One leak:** line 4 of the report embeds the absolute local checkout path
  `<repo>`, which exposes a personal home
  directory and the author's macOS account name. Replace with "the repository root" before anything
  derived from this report is published.
- No secrets, API keys, tokens, cloud account IDs, ARNs, IP addresses, or email addresses were
  found (regex sweep for `arn:aws`, `AKIA…`, 12-digit account ids, `sk-…`, `xox…`, `ghp_…`, IPv4
  literals, PEM headers, `password=`/`secret=`).
- `beetle.run` and `docs.kentron.ai` are product domains quoted from source, not personal data.
- Environment variables are named but never valued, as the report promises.

## Missing or too-thin topics (within the report's assigned scope)

1. **BYOK as a hard prerequisite for Slack and Teams.** The report documents the 409 on
   `/chat/route` (§11) but never says that this means no Slack or Teams turn can start without an
   OpenAI BYOK key; §9.2's platform-credit narrative is therefore misleading (claims #16, #36).
2. **Thread delete confirmation.** §3.2 lists the sidebar **Delete** action without its confirm
   dialog copy (`chat-sidebar.tsx:892-902`), which is user-visible and calls the thread an
   "objective".
3. **Web progress cadence and job-wait limits.** Slack/Teams poll intervals are documented, but the
   web constants are not: `FACTORY_OBJECTIVE_PROGRESS_POLL_MS = 3_000`,
   `FACTORY_OBJECTIVE_PROGRESS_HEARTBEAT_MS = 20_000`, `CHAT_LAYER_PROGRESS_HEARTBEAT_MS = 10_000`,
   `DEFAULT_JOB_WAIT_TIMEOUT_MS = 30_000`, `MAX_JOB_WAIT_TIMEOUT_MS = 120_000`
   (`receipt-chat.service.ts:100-104`).
4. **`POST /api/chat` request schema.** The body fields (`threadId`, `modelId`, `modeId`,
   `disabledToolKeys`, `expectedBranchVersion`, attachments, etc.) in
   `apps/start/src/lib/backend/chat/domain/schemas.ts` are not enumerated; the docs cannot describe
   the API from the report.
5. **Seat quota and platform credit on the web.** `usageQuota.reserveChatQuota`,
   `error_chat_quota_exceeded`, and `error_chat_platform_credit_exhausted` ("$5 platform credit",
   "Billing & Credits") are listed but not explained: where the $5 credit is granted, how the seat
   quota is sized, and how a user reaches Billing when the sidebar never renders it (§12).
6. **Platform OpenAI key for the web chat.** "Only OpenAI-routed models are accepted without BYOK"
   is stated, but not how the platform key is configured for self-hosted deployments
   (`packages/receipt-app/src/services/platform-openai-key.ts`, `readPlatformOpenAiApiKey`).
7. **Teams media/attachments.** `apps/teams/server.ts:14` imports `buildTeamsMediaMessage` from
   `teams-media.ts` and the manifest declares `supportsFiles: true`; how files reach Teams users
   is not covered.
8. **Slack follow-ups in an existing thread.** The report covers Teams' lack of objective
   rebinding but does not state Slack's behaviour for a second mention in the same thread
   (`getSlackThreadContext` / bound objective handling in `apps/slack/server.ts`).
9. **Runtime HTTP surface for preference memory.** `GET <basePath>/api/user-preferences`
   (`register-factory-api-routes.ts:672-685`) exists alongside the CLI; §5 mentions only the CLI.
10. **Localisation.** `es.json` and `he.json` exist beside `en.json` (`git show 46652e84 --stat`);
    the docs should know the UI ships in three locales even if only English strings are quoted.
11. **Rate limiting for Slack/Teams.** §14 covers web rate limits only; whether external channels
    have any per-user throttle is not stated.
