# G-guard.md — adversarial fact-check

Checked against the repository at `c3c16be6` (the report's stated HEAD). Note: the
working tree has since moved to `d004ba19` (two commits: `c87b2692`, `d004ba19`); those
touched `agent-registry-page.tsx`, `agent-registry-table.tsx`, `agent-cloud-discovery.ts`,
and `receipt-connect.server.ts`. Every citation into those four files was verified with
`git show c3c16be6:<path>`; everything else is byte-identical between the two commits.

Verdict key: **confirmed** = source matches; **wrong** = source contradicts, with citation;
**unverifiable** = no evidence either way (or the cited artifact is outside the repo).
"Nuance" notes are places where the claim is true but the wording would mislead a docs
writer if copied verbatim.

## 1. Claim table (most consequential claims, ranked by documentation impact)

| # | Claim | Verdict | Correction | Evidence (path:line) |
|---|---|---|---|---|
| 1 | Guardrail enforcement is authoring-only: `guardPrompt`/`guardResponse`/`guardToolResult`/`applyGuardrails` have no caller outside the service; `chat-orchestrator.service.ts` has zero "guardrail" references | **confirmed** | — | Repo-wide grep for those four names returns only `apps/start/src/lib/backend/chat/services/guardrail-enforcement.service.ts:82-132`; `grep -ic guardrail chat-orchestrator.service.ts` = 0; the only importer of the service is `apps/start/src/lib/frontend/guardrails/guardrails.server.ts:95` (cache invalidation only) |
| 2 | MCP gateway "Receipts for every call" (matrix row) / "gateway calls … write receipts" (GovSig verdict) | **wrong** (over-broad) | Only `POST /connect/call` records `tool.called`/`tool.observed`. `POST /connect/mcp` — the JSON-RPC MCP transport that `receipt mcp install` points clients at — never calls `recordReceiptConnectToolCall`, and the JSON-RPC handler writes no receipts. Docs must say "REST `/connect/call` invocations are receipted"; MCP-protocol tool calls through the gateway are not. (§5's sentence "Every `/connect/call` writes…" is accurate; the matrix and the marketing verdict are not.) | `packages/receipt-app/src/server/receipt-connect-routes.ts:859-900` (`/connect/mcp`, passes `allowWrite`, no receipt call) vs `:1155-1235` (`/connect/call`, four `recordReceiptConnectToolCall` sites at 1185/1196/1224/1235); `grep recordReceiptConnectToolCall` repo-wide hits only routes.ts and the tool-receipts module; `packages/receipt-app/src/services/receipt-connect-mcp.ts` contains no `tool.called`/`runtime.execute`; `packages/receipt-app/src/services/receipt-mcp-cli.ts:13` `RECEIPT_MCP_PATH = "/connect/mcp"`, `:126` client endpoint |
| 3 | "Require organization provider key" is **inert**; "grep … finds only the type, the UI, and the mutator"; "Nothing in the request path reads the flag" | **wrong** (partially) | The flag is read client-side: the chat model picker drops every model whose route providers lack an active executable org key when the flag is on. It is still not enforced server-side (`isDeniedByComplianceFlags` reads only `require_zdr`), so a crafted request can bypass it. Correct classification: **client-side filter only, not server-enforced**, not "inert". | `apps/start/src/components/chat/chat-context.tsx:1891-1904` (`if (!orgPolicy?.complianceFlags?.require_org_provider_key) return true; return hasActiveOrgProviderKeyForModel(...)`); server side unchanged at `apps/start/src/lib/shared/ai-catalog/compliance-map.ts:13-21` |
| 4 | Matrix: "Require ZDR — **Reachable**, enforced with a bypass" and "Enforce Study Mode — **Reachable**, enforced" | **wrong** (internally inconsistent) | The only UI for these toggles is `ComplianceFlagsSection`, rendered solely on `/organization/settings/provider-policy` and `/organization/settings/compliance-policy`, which §4 itself classifies as URL-only ("hidden"). By the report's own vocabulary the rows should read **Hidden (URL-only), enforced**. Disabled providers/models, by contrast, are genuinely reachable via the in-menu Models page. | `ComplianceFlagsSection` used only in `apps/start/src/components/organization/settings/model-policy/provider-policy-page.tsx:35` and `.../compliance-policy/compliance-policy-page.tsx:32`; no nav entry for either route in `apps/start/src/routes/(app)/_layout/organization/settings/-organization-settings-nav.ts:147-309`; no in-app link (grep for `provider-policy\|compliance-policy` in `apps/start/src` hits only `routeTree.gen.ts`); model toggles at `.../model-policy/provider-models-page.tsx:63-72` under the `organization-models` nav item (`-organization-settings-nav.ts:286-291`, `hiddenFromRail` but in menu) |
| 5 | "`receipt-connect-routes.ts` changed by 27 lines (in `b90c9070`, cloud-provider disconnect)" | **wrong** | The 27-line change (25+/2−) is commit `0a58ac52` "fix: preserve retry capability scope and fence authorization churn". `b90c9070` did not touch `receipt-connect-routes.ts` at all (it touched agent-registry server/discovery files). The substantive claim — scope/allowlist gates unchanged — still holds. | `git log --oneline 41baea75..c3c16be6 -- packages/receipt-app/src/server/receipt-connect-routes.ts` → only `0a58ac52`; `git show --stat 0a58ac52 -- …routes.ts` → 27 lines; `git show --stat b90c9070` lists no routes.ts |
| 6 | "Telemetry: plain policy denials are `captureMode: 'none'`; the BYOK-related reasons are `'signal'`" | **wrong** (partially) | Only reasons containing `missing_provider_api_key` or `model_not_supported_for_provider_key`, or starting with `free_tier_model_denied:`, are `'signal'`. Two of the three `CHAT_REQUIRE_BYOK` reasons the report lists — `policy_denied:missing_org_context_for_provider_key` and `policy_denied:provider_not_supported_by_byok:<id>` — fall through to `'none'`. | `apps/start/src/lib/backend/chat/domain/error-classification.ts:263-275` |
| 7 | Prior corpus cited as `doc/research/02-org-settings-governance.md`, `03d-posthog-analytics-privacy.md`, `10-integrations-connect-mcp.md` "at commit `41baea75`" | **unverifiable** (paths do not exist in the repo) | No `doc/research/` directory exists at `41baea75` or at HEAD; the only "research" path in the tree at `41baea75` is `skills/factory-deep-research/SKILL.md`. The scratchpad corpus uses different names (`D-mcp-gateway-connect.md`, etc.). Either cite the real location or drop the commit-pinned attribution. | `git ls-tree -r 41baea75 --name-only \| grep -i research`; `find . -type d -name research` (working tree) → none |
| 8 | "Dry-run exists only for `receipt mcp install codex --dry-run`" | **wrong** (incomplete) | The `--dry-run` branch runs for both `install` and `remove` subcommands (it prints `action: subcommand`); only the help text advertises `install`. | `packages/receipt-app/src/services/receipt-mcp-cli.ts:715-726`; help text `packages/receipt-app/src/cli/shared.ts:35`, `packages/receipt-app/src/connect-cli.ts:85` |
| 9 | Policies page rate limits / budgets / logging / tool approval are **inert** (no consumer of `listPolicyRules` beyond the settings UI) | **confirmed**, with a material omission | True for the org-configured Policies module. But the report never mentions that a **built-in, non-configurable chat rate limiter and free-tier allowance do exist and are enforced** (Postgres fixed-window, per user: paid default 30 req/60 s, free 10 req/60 s, free allowance 100 req/24 h, env-overridable). A docs page saying "rate limiting is not applied" would be false. | Consumers: `apps/start/src/lib/frontend/policies/policies.server.ts:7-8,97,133`, `use-policies.ts:8,98` only. Built-in limiter: `apps/start/src/lib/backend/chat/services/rate-limit.service.ts:10-15,44-60`; `free-chat-allowance.service.ts:12-40,88-92`; defaults `apps/start/src/lib/backend/access-control/index.ts:34-39`, env `PAID_CHAT_RATE_LIMIT_WINDOW_MS` etc. `:113-117` |
| 10 | "Factory worker / sandbox: **Absent** — No 'guardrail' reference under `packages/receipt-app/src/services/factory` or `…/server`" | **confirmed** (nuance) | Three factory **test** files contain the word "guardrail" in unrelated test titles/fixtures; no production code references guardrails. | `packages/receipt-app/src/services/factory/runtime/{objective-handoff-renderer,task-runner,objective-input}.test.ts` |
| 11 | Human-approval primitive "no user" outside tests and `sims/` | **confirmed** (nuance) | The `receipt` CLI's `human-loop` scaffold template emits `human("approve", …)` into generated user code; that is a template string, not a runtime caller. Worth a footnote so a grep-based reviewer does not "refute" the docs. | `packages/receipt-app/src/cli/commands.ts:153-160` |
| 12 | `testGuardrailGroupAction` (`guardrails.server.ts:562-591`) runs `evaluateGuardrails` with `metadata: {}`; group enabled/archived state not consulted; test input capped at 20,000 chars | **confirmed** | Function body is `:563-591`; `metadata: {}` at `:583`. | `apps/start/src/lib/frontend/guardrails/guardrails.server.ts:563-591`; cap `guardrails.functions.ts:127-134` (`z.string().max(20_000)`) |
| 13 | ZDR bypass: `hasActiveOrgProviderKeyForModel` short-circuits the compliance check when the org holds an executable BYOK key (`openai`/`anthropic`) | **confirmed** | — | `apps/start/src/lib/shared/model-policy/policy-engine.ts:38-48`; `provider-keys.ts:29-50` (`BYOK_EXECUTABLE_PROVIDERS = ['openai','anthropic']`) |
| 14 | `CHAT_REQUIRE_BYOK=true` gate and the three denial reason strings at `:266-275`, `:345-355`, `:417-426` | **confirmed** | — | `apps/start/src/lib/backend/chat/services/model-policy.service.ts:38-40, 273, 352, 422` |
| 15 | Allowlist semantics (`enabledAction`, v1 reads-by-default vs v2 listed-only), `404 "integration action not found or disabled"`, `connect:write` required for writes (400 error text) | **confirmed** | Also applies to the compatibility-read tool path (`enabledAction` checked before the call). | `packages/receipt-app/src/services/receipt-connect-call.ts:1584-1590, 1903-1909, 195-198`; compat path `:1867-1882`; routes pass `allowWrite` at `receipt-connect-routes.ts:888, 1177` |
| 16 | GitHub selected-repositories 403 strings | **confirmed** | — | `receipt-connect-call.ts:2049-2056` |
| 17 | Plan gating inert: `getFeatureAccessState` → `allowed: true`; `getPlanEffectiveFeatures` all `true`; `hasFeatureAccess` true; `isFreeTierContext` false; `getModelAccess` visible/allowed | **confirmed** | The paid/free distinction still drives the built-in rate-limit tier (row 9), so "plan has no effect anywhere" would overstate it. | `apps/start/src/lib/shared/access-control/index.ts:319-325, 354-367, 398-423`; tier limits `apps/start/src/lib/backend/access-control/index.ts:34-39` |
| 18 | Security page inert: all hrefs `'#'`, every button `buttonDisabled`; nav entry `hiddenFromRail`+`hiddenFromMenu` | **confirmed** | — | `apps/start/src/components/organization/settings/security/security-page.tsx:9-11, 33, 53, 75`; nav `-organization-settings-nav.ts:301-306` (identical at c3c16be6) |
| 19 | Hash chain: SHA-256 over canonical `{id, ts, stream, prev, body, context?}`, hints excluded; `verify` returns `broken prev` / `hash mismatch`; unique indexes on `hash` and `(stream, hash)`; CAS append error `Expected prev hash … but head is …`; replay refusal message | **confirmed** | — | `packages/receipt-core/src/chain.ts:15-29, 91-103`; `packages/receipt-app/src/adapters/postgres.ts:234-236, 498-526`; `packages/receipt-core/src/runtime.ts:123-130`, `:464` |
| 20 | Signing absent: no `govsig`, no ed25519/`createSign`/`crypto.sign`; only HMAC-SHA256 for Connect JWT, debug token, Slack/Teams state | **confirmed** (nuance) | Grep also finds HMAC in `receipt-connect-device-login.ts:86` (device-login codes), which the report omits. The Slack/Teams citations (`slack.ts:68-70`, `teams.ts:55-58`) point at verify call sites; the `sign` helpers are at `slack.ts:35-36` and `teams.ts:21-22`. | `grep -rli govsig` → none; `createHmac` sites: `packages/receipt-core/src/slack.ts:36`, `teams.ts:22`, `packages/receipt-app/src/services/receipt-connect-auth-token.ts:57`, `receipt-debug-auth-token.ts:52`, `receipt-connect-device-login.ts:86`; `docs/agent-fix-checklist.md:9275` quote verified |
| 21 | ZDR never suppresses telemetry (only `outcome.ok` and `captureMode === 'none'` gate capture) | **confirmed** | — | `apps/start/src/lib/backend/chat/observability/posthog.server.ts:64-66`; `zeroDataRetentionRequired` set at `chat-orchestrator.service.ts:394-397` |
| 22 | Nine guardrail kinds with the listed default operation, ops, stages, config keys, labels, defaults, `required` flags and placeholders | **confirmed** | — | `apps/start/src/lib/shared/guardrails.ts:151-357` (ids at 153/180/207/227/254/274/293/312/339; defaults `[redacted]`, `['email','phone','ssn','credit_card']`, `['harassment','hate','self_harm','sexual','violence']`, `true`) |
| 23 | Limits: 120/2000/64/64/128/512/512; server `maxConfigBytes 32768`; evaluator fallback severity `low` vs detector fallback `medium`; `blockOnToolOutput` never read by the detector | **confirmed** | — | `apps/start/src/lib/shared/guardrails.ts:405-413`; `packages/receipt-app/src/services/guardrails.ts:18-26`; `guardrail-enforcement.ts:57-62`; `guardrail-detectors.ts:42-48, 276-291` |
| 24 | Detectors: `MAX_SCAN_CHARS = 200_000`, `MAX_FINDINGS = 200`, nine secret regexes, eight injection patterns, seven code-safety regexes, literal moderation terms, nothing model-based/stateful | **confirmed** | — | `packages/receipt-app/src/services/guardrail-detectors.ts:75, 81, 115-134, 229-274, 321-331, 360-372, 394-437` |
| 25 | Archive is hidden: `archiveGuardrailGroupAction` and hook `archiveGroup` exist, no component calls them; row menu has no Archive item | **confirmed** | — | `guardrails.server.ts:442-456`; `use-guardrails.ts:289-292`; grep `archiveGroup\|archiveGuardrailGroup` in `apps/start/src/components` and `routes` → none; menu items `guardrail-table.tsx:182-215` |
| 26 | Exact UI strings: page description, "Loading guardrails…", search placeholder/aria-label, "Show archived", empty state, Remove/Delete confirmations, table column order, "Archived"/"Group off" badges, group-dialog/picker/editor/test-dialog copy, sample text | **confirmed** | — | `guardrails-page.tsx:124-125, 153, 164-165, 169-177, 296-297, 315-316, 379-380`; `guardrail-table.tsx:85-94, 132-134, 153-154`; `guardrail-group-dialog.tsx:143-144, 159, 180, 188-193, 213`; `guardrail-picker.tsx:52-56, 69`; `guardrail-editor-dialog.tsx:60-64, 76-80`; `guardrail-test-dialog.tsx:35-36, 88-116` |
| 27 | Policies page: five tabs, "fully connected" hand-off copy, per-module intro copy, toasts, `POLICY_LIMITS`, four event types, random rule id, stream shape, admin error string; projection not in Zero client schema | **confirmed** | — | `policies-page.tsx:31-37, 112-127`; `rate-limit-panel.tsx:97`; `budget-panel.tsx:98`; `logging-panel.tsx:96`; `tool-approval-panel.tsx:117-130`; `packages/receipt-app/src/services/policies.ts:25-39, 53-88, 168-186`; `policies.server.ts:43`; `grep policy_rule apps/start/src/integrations/zero/schema.ts` → none |
| 28 | Access control: `canAccessOrganizationSettingsPath` (MCP-gateway paths open to any member, else owner/admin); `isMcpGatewayPath` covers `/mcp-gateway` and `/workspaces`; route guard redirects to `/` with no denied screen; `isOrgAdmin` via `hasPermission organization:['update']`; workspace mutation authority rule | **confirmed** | — | `-organization-settings-access.ts:9-17`; `mcp-gateway-nav.config.tsx:17-21`; `settings/route.tsx:17-41`; `organization-member-role.service.ts:6-31`; `packages/receipt-app/src/services/receipt-workspaces.ts:1079-1088` |
| 29 | Agent Registry: open to any signed-in non-anonymous user; `L1`–`L4`; risk rule (critical/high/medium/low); Bedrock `requireConfirmation === "DISABLED"` → L4; L3/L4 recommendation strings; dashboard card labels; "View details" menu | **confirmed** (at c3c16be6) | Line numbers shift at `d004ba19` (`c87b2692` rewrote the autonomy filter in `agent-registry-page.tsx` and extended `agent-cloud-discovery.ts` by ~240 lines). | `git show c3c16be6:…agent-registry-page.tsx:75-78, 207-210`; `…agent-registry-table.tsx:164-166`; `git show c3c16be6:packages/receipt-app/src/services/agent-cloud-discovery.ts:174-224, 700-707`; `agent-inventory.ts:20-21`; `agent-risk-dashboard.tsx:83-85, 123-162`; `routes/(app)/_layout/agent-registry/route.tsx:36-40` |
| 30 | /sessions "Compliance readiness" card is a heuristic; button only opens the evidence panel | **confirmed** | — | `apps/start/src/lib/frontend/sessions/agent-sessions.server.ts:349, 381-392`; `apps/start/src/components/sessions/sessions-page.tsx:880-888` |
| 31 | JWT scopes (`connect:read/write/credential`), default all three, TTL 12 h, HS256; web tokens carry read+write; Factory contract adds `connect:write` whenever a capability is detected | **confirmed** | — | `receipt-connect-auth-token.ts:19-33, 170, 210`; `git show c3c16be6:apps/start/src/lib/frontend/receipt-connect/receipt-connect.server.ts:38-41`; `objective-execution-contract.ts:46-51` |
| 32 | BYOK at rest AES-256-GCM / 12-byte IV / key v1 / 32-byte key; 12-hex fingerprint; connection refs AES-256-GCM under `RECEIPT_CONNECTION_ENCRYPTION_KEY_B64` (32 bytes); four connection kinds; Zero exposes only the listed `orgConnectionSecret` columns; guardrail projection replicates `guardrails_json`/`access_json` to owners/admins only | **confirmed** | — | `byok-crypto.ts:3-6, 24-25, 31-40`; `receipt-connect-connections.ts:26-31, 123-125, 356-368`; `receipt-connect-config.ts:117-125`; `apps/start/src/integrations/zero/schema.ts:90-105, 163-183`; `guardrails.queries.ts:19-42` |
| 33 | Zero publication lists both projection tables; runtime contract `derived-read-model` / `default` / `organizations/`; `receipt_projection_work` and `receipt_reducer_checkpoints` added in the projection-durability series | **confirmed** | — | `apps/start/scripts/zero-publication.ts:29-41`; `runtime-contracts.ts:414-428, 463-471`; `git log 41baea75..c3c16be6 -- runtime-contracts.ts` → `00ef6f17` |
| 34 | "43 commits since `41baea75`"; guardrail paths, security page, access-control, compliance-map, policy-engine, tool-policy, mutators, PostHog, receipt-core, receipt-dst untouched; `46652e84` = tab strip; `e6944514` added `docs/tool-reliability-fixes-2026-09-05.md`; Agent Registry series hashes | **confirmed** | The `41baea75..c3c16be6` range is 43 commits; the working tree is now 45 ahead. `apps/start/src/lib/frontend/access-control/index.ts` was **also** untouched in the range (0 commits), so the report's "is **now** a 32-line file" wording implies a change that did not happen in this window. | `git log --oneline 41baea75..c3c16be6 \| wc -l` = 43; per-path logs = 0 for the listed sets; `git show --stat e6944514`; `git merge-base --is-ancestor` for `26ec975a 20d20f51 a241a9b1 00ef6f17 8c74802b` → all in range |
| 35 | Marketing verdicts (six rows) | **confirmed** with one required edit | Verdicts and reasoning hold. Edit the GovSig row: "gateway calls … write receipts" → "`/connect/call` REST invocations write receipts; MCP-protocol calls via `/connect/mcp` do not" (row 2). Edit "Stop risks before they execute": add that a built-in per-user chat rate limit and free allowance are enforced even though the Policies rate-limit module is not (row 9). | rows 2 and 9 above |

Tally: 35 claims examined; **6 wrong** (rows 2, 3, 4, 5, 6, 8), **1 unverifiable** (row 7),
28 confirmed (5 of them with a nuance worth carrying into the docs).

## 2. Path existence

All 112 distinct path-like citations in the report were resolved. Every abbreviated
citation (`guardrails.server.ts:57`, `en.json:434`, `-organization-settings-nav.ts:232-235`,
`schema.ts:163-181`, etc.) maps to exactly one real file once the section's full path is
applied. Two ambiguities a copy-editor should expand before publishing:

- `security-page.tsx` — the report means `apps/start/src/components/organization/settings/security/security-page.tsx`; a second `apps/start/src/components/settings/security/security-page.tsx` also exists.
- `receipt-connect-connections.ts` and `receipt-workspaces.ts` — the report means the `packages/receipt-app/src/services/` copies; same-named files exist under `apps/start/src/lib/frontend/receipt-connect/`.

Paths that do **not** exist in the repository at `41baea75`, `c3c16be6`, or `d004ba19`:
`doc/research/02-org-settings-governance.md`, `doc/research/03d-posthog-analytics-privacy.md`,
`doc/research/10-integrations-connect-mcp.md` (row 7).

Line-number drift worth fixing (claim true, cite off): `receipt-dst.md:1-25` is cited for
`--json`/`--strict`, but `--json` first appears at `docs/receipt-dst.md:32`; Slack/Teams
HMAC `sign` helpers are at `slack.ts:35-36` / `teams.ts:21-22` (the cited 68-70 / 55-58 are
the verify call sites); `testGuardrailGroupAction` starts at `:563`, not `:562`.

## 3. Leak check

**Clean.** Scanned the report for AWS key shapes, ARNs, IPv4 literals, 12-digit account
ids, home-directory paths (`/Users/`, `/home/`, `~/`), e-mail addresses, personal or
account names, API-token shapes, and `KEY=value` secrets.

- The only key-shaped string is `AKIAIOSFODNN7EXAMPLE` (line 228), which is AWS's published
  documentation example key and is the literal sample text shipped in
  `guardrail-test-dialog.tsx:35-36`. Not a secret.
- The only e-mail addresses are `name@example.com` (a UI placeholder, line 86) and
  `person@example.com` (the same sample text, line 228).
- No ARN, IP, cloud account id, home path, git author, or organization account name appears.

## 4. Missing or thin topics within the report's scope ("what the code actually enforces")

1. **`/connect/mcp` JSON-RPC transport.** The report analyses gateway enforcement only
   through `/connect/call`. The MCP-protocol endpoint (the one `receipt mcp install`
   configures for Codex and other clients) inherits the scope/allowlist checks via
   `callReceiptConnectTool` but writes **no** tool receipts. This is the single biggest gap
   for a "Guard" page and for any audit claim (`receipt-connect-routes.ts:859-900`,
   `receipt-mcp-cli.ts:13,126`).
2. **Built-in chat rate limiting and free-tier allowance** (row 9). Enforced, Postgres-backed,
   per user, with env overrides — absent from the report, which discusses rate limiting only
   as an inert Policies module (`rate-limit.service.ts`, `free-chat-allowance.service.ts`,
   `backend/access-control/index.ts:34-39,113-117`).
3. **Client-side `require_org_provider_key` filtering** (row 3) and the general point that
   several "policy" effects are client-only model-picker filtering rather than server
   enforcement — the report should state which controls are server-checked on the request
   path versus which only shape the UI.
4. **Workspace membership boundary on Receipt Connect** (`hasCurrentWorkspaceMembership`,
   `requireReceiptWorkspaceMembership`) is mentioned only via the mutation-authority helper;
   the read-side rule (any request must belong to a workspace the user is a member of) is
   not stated (`receipt-connect-routes.ts:867, 1473`).
5. **Other token surfaces**: the debug auth token (`receipt-debug-auth-token.ts`) and device
   login codes (`receipt-connect-device-login.ts`) are HMAC-signed credentials that grant
   gateway access; neither is described, and the `connect:credential` scope is named but
   its effect (raw credential retrieval on `/connect/credentials`-style routes) is not.
6. **Factory sandbox isolation** as an enforced control (OpenSandbox-only execution, no
   non-sandboxed path) is a guard-relevant fact the report omits even though it argues about
   Factory write scope.
7. **Tool-policy reasons** `blocked_by_mode`, `blocked_by_thread_preference`, and
   `blocked_by_feature_flag` exist alongside the four the report lists
   (`tool-policy.ts:95-124`); a docs table of denial reasons would be incomplete.
8. **Compatibility-read tool** on the gateway (`RECEIPT_CONNECT_COMPATIBILITY_READ_TOOL_NAME`)
   is its own allowlisted read path (`receipt-connect-call.ts:1865-1898`) and is not covered.
9. **Post-`c3c16be6` drift.** `d004ba19` adds an organization Skills settings page and the
   `c87b2692` Agent Registry autonomy-filter rewrite; if the docs are cut from current
   `main`, §8's Agent Registry line numbers and the settings nav order are already stale.
10. **Slack token at-rest** is deliberately left unverified ("make no claim"); a one-line
    finding either way would close the gap rather than defer it.
