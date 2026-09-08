# G — "KENTRON GUARD": what the code actually enforces

Research report for the public documentation site. Source of truth: the Receipt
repository at git HEAD `c3c16be6` on `main`. Every substantive claim is cited as
`path:line` relative to the repository root. The prior corpus at commit `41baea75`
(`doc/research/02-org-settings-governance.md`, `03d-posthog-analytics-privacy.md`,
`10-integrations-connect-mcp.md`) was used only as a map; every finding below was
re-read at HEAD.

Classification vocabulary used throughout:

- **Reachable** — implemented and reachable in the UI or CLI.
- **Hidden** — implemented, but only reachable by direct URL or an unwired hook.
- **Inert** — UI exists but nothing executes or enforces it.
- **Absent** — does not exist in the codebase.

The single most important finding, stated up front: **at HEAD, organization
Guardrails are authoring-only.** The enforcement service exists and is complete,
but no chat, tool, Factory, or MCP-gateway code path calls it. The only place a
guardrail ever evaluates text is the admin "Test group" dialog. Everything in the
"Guard" positioning that implies real-time interception has to be documented
against that fact.

---

## 1. Enforcement matrix (surface × what is enforced × where in code)

| Surface | Control | Status at HEAD | Enforcement point (or its absence) |
|---|---|---|---|
| Chat prompt (input) | Guardrail groups | **Inert** | `guardPrompt` exists at `apps/start/src/lib/backend/chat/services/guardrail-enforcement.service.ts:118-122`; repo-wide grep for `guardPrompt\|guardResponse\|guardToolResult\|applyGuardrails` finds no caller outside that file. `chat-orchestrator.service.ts` has zero references to "guardrail". |
| Chat response (output) | Guardrail groups | **Inert** | `guardResponse` `…guardrail-enforcement.service.ts:124-127`, no caller. |
| Chat tool results | Guardrail groups | **Inert** | `guardToolResult` `…guardrail-enforcement.service.ts:129-132`, no caller. |
| Factory worker / sandbox | Guardrail groups | **Absent** | No "guardrail" reference under `packages/receipt-app/src/services/factory` or `packages/receipt-app/src/server`. |
| MCP gateway (`/connect/call`) | Guardrail groups | **Absent** | Same grep; gateway enforces only the action allowlist and scope (rows below). |
| Admin test dialog | Guardrail groups | **Reachable** | `testGuardrailGroupAction` `apps/start/src/lib/frontend/guardrails/guardrails.server.ts:562-591` runs `evaluateGuardrails` against pasted text; nothing is saved. |
| Chat model selection | Disabled providers / models | **Reachable, enforced** | `evaluateModelAvailability` `apps/start/src/lib/shared/model-policy/policy-engine.ts:22-54`, applied in `model-policy.service.ts:213-223`; 403 with reason `policy_denied:provider`, `policy_denied:model`. |
| Chat model selection | Require ZDR | **Reachable, enforced with a bypass** | `isDeniedByComplianceFlags` `apps/start/src/lib/shared/ai-catalog/compliance-map.ts:13-21`; bypassed when the org holds an executable BYOK key for a route provider (`policy-engine.ts:38-48`, `provider-keys.ts:29-50`). |
| Chat model selection | Require organization provider key | **Inert** | Toggle writes `compliance_flags.require_org_provider_key`, but `isDeniedByComplianceFlags` reads only `require_zdr` (`compliance-map.ts:13-21`); grep for `require_org_provider_key` finds only the type, the UI, and the mutator. |
| Chat model selection | `CHAT_REQUIRE_BYOK` env | **Reachable (operator), enforced** | `model-policy.service.ts:38-40`; denials `policy_denied:missing_org_context_for_provider_key`, `policy_denied:provider_not_supported_by_byok:<provider>`, `policy_denied:missing_provider_api_key:<provider>` (`:266-275`, `:345-355`, `:417-426`). |
| Chat mode | Enforce Study Mode | **Reachable, enforced** | `resolveEffectiveChatMode` `apps/start/src/lib/shared/chat-modes/resolver.ts:14-27` (org mode wins, `isEnforced: true`); Study Mode pins `openai/gpt-oss-120b` and empties provider-native tool allowlists (`registry.ts:7-25`). |
| Chat tools | Provider-native / external tool switches, disabled tool keys | **Hidden, enforced** | `resolveToolPolicy` `apps/start/src/lib/shared/chat/tool-policy.ts:88-126` (reasons `blocked_by_org_master_switch`, `blocked_by_external_tools_switch`, `blocked_by_org_policy`, `blocked_by_compliance`); the Tools settings page redirects away (`routes/(app)/_layout/organization/settings/tools/route.tsx:7-12`), so the switches are unreachable from the UI. |
| Policies page: rate limits, budgets, logging redaction, tool approval | Rule modules | **Inert** | Rules persist as receipts (`packages/receipt-app/src/services/policies.ts:53-88`), but `listPolicyRules` / `receipt_org_policy_rule_projection` have no consumer outside the settings UI, schema, publication list, and contracts table (grep). The shared type file says "the shape the eventual backend must return" (`apps/start/src/lib/shared/policies.ts:9-13`). |
| MCP gateway | Per-connection action allowlist (v1/v2) | **Reachable, enforced** | `enabledAction` `packages/receipt-app/src/services/receipt-connect-call.ts:1584-1590`; disabled or unknown tool → `404 "integration action not found or disabled"` (`:1900-1906`). |
| MCP gateway | Write requires `connect:write` | **Reachable, enforced** | `:1908-1909` → `ReceiptConnectWriteScopeRequiredError` (400, `"integration action '<tool>' requires connect:write"`, `:195-198`); routes pass `allowWrite: authorization.scopes.includes("connect:write")` (`packages/receipt-app/src/server/receipt-connect-routes.ts:888`, `:1177`). |
| MCP gateway | GitHub selected-repositories policy | **Reachable, enforced** | `receipt-connect-call.ts:2008-2055` (403 strings at `:2050`, `:2055`). |
| MCP gateway | Receipts for every call | **Reachable** | `receipt-connect-tool-receipts.ts:19-24` stream, `:85-133` `tool.called` / `tool.observed` pair. |
| Connection lifecycle / policy edits | Workspace mutation authority | **Reachable, enforced** | `receipt-connect-routes.ts:806-815` comment and `hasWorkspaceMutationAuthority` (`:811`), checked on e.g. `DELETE /connect/connections/:id` (`:1466-1475`). |
| Org settings pages | Owner/admin only | **Reachable, enforced (client + server)** | Client: `-organization-settings-access.ts:9-17`; server: `guardrails.server.ts:57`, `policies.server.ts:43`, `org-policy.mutators.ts:154`. |
| Plan gating (Plus/Pro/Enterprise) | Feature entitlement | **Inert (always allowed)** | `getFeatureAccessState` returns `allowed: true` unconditionally (`apps/start/src/lib/shared/access-control/index.ts:354-367`); `getPlanEffectiveFeatures` marks every feature `true` (`:319-325`). |
| Security page (SSO, domains, directory) | — | **Inert placeholder** | Every button `buttonDisabled`, every href `'#'` (`security-page.tsx:9-11`, `:33`, `:53`, `:75`). |
| Receipt integrity | SHA-256 hash chain, prev-hash CAS append | **Reachable, enforced** | `packages/receipt-core/src/chain.ts:15-29`, `:91-103`; `packages/receipt-app/src/adapters/postgres.ts:234-236`, `:498-526`; replay refuses an invalid chain (`packages/receipt-core/src/runtime.ts:123-130`). |
| Receipt origin authentication (signatures) | — | **Absent** | No ed25519, no per-receipt HMAC, no "GovSig" anywhere (see §10). |
| Telemetry suppression under ZDR | — | **Absent** | `require_zdr` is recorded into the wide event (`chat-orchestrator.service.ts:395-397`) but never consulted by the PostHog capture (`posthog.server.ts:59-95`). |

---

## 2. Guardrails — `/organization/settings/guardrails`

### 2.1 Page chrome and exact strings

Page component `apps/start/src/components/organization/settings/guardrails/guardrails-page.tsx`.

- Title **"Guardrails"**; description **"Rules that inspect what your agents send and receive — catching secrets, personal data, and prompt injection before they reach a model or leave your organization."** (`:124-125`).
- Loading label **"Loading guardrails…"** (`:153`).
- Search: `placeholder="Search guardrails and groups"`, `aria-label="Search guardrails"` (`:164-165`).
- Toggle **"Show archived"** (`:169-177`) bound to `includeArchived` state (`:62`).
- Empty state title **"No guardrails yet"**, body **"Create a group to hold your rules, then add guardrails to it. Every guardrail runs inside Receipt."** (`:379-380`).
- Remove confirmation: title `Remove {name}?`, body **"This guardrail stops inspecting traffic immediately. The change is recorded in the group's receipt history."** (`:296-297`).
- Delete group confirmation: title `Delete {name}?`, body `This removes the group and its {n} guardrail(s)…` (`:315-316`).
- Nav item **"Guardrails"** (`m.org_guardrails_page_title`) is a visible rail icon (`-organization-settings-nav.ts:232-235`). Note that the localized nav description `org_guardrails_page_description` is **"Configure guardrails that constrain agent behavior for your organization."** (`apps/start/messages/en.json:434`), different from the on-page description above.

Table (`guardrail-table.tsx:85-94`), one row per guardrail, columns in order:
**# / Guardrail / Group / Mode / Enforcing strategy / Runs on / Enabled / Actions**.
Group badges **"Archived"** (`:132`) and **"Group off"** (`:134`). The Enabled switch is
`checked={group.enabled && !archived}` and `disabled={busy || archived}` (`:153-154`),
i.e. it toggles the **group**, not the individual guardrail. Row menu: **"Edit
guardrail"**, **"Remove guardrail"**, then **"Add guardrail"**, **"Test group"**,
**"Edit group"**, **"Delete group"** (`:184-213`).

Group dialog (`guardrail-group-dialog.tsx`): titles **"Edit guardrails group"** /
**"Add new guardrails group"**, description **"Guardrails groups hold the rules that
inspect your agents' prompts, responses, and tool traffic."** (`:143-144`);
placeholders `"Enter name"` (`:159`) and `"What is this group for?"` (`:180`).
The **"Access control (optional)"** section reads **"Record who looks after this
group. Organization owners and admins can always manage guardrails."** (`:188-193`),
with subject placeholder `"name@example.com or everyone"` (`:213`) and role
**Manager** / User. The access list is a record only; nothing reads it for
authorization (the server checks `requireGuardrailAdmin` on every call,
`guardrails.server.ts:47-60`).

Picker (`guardrail-picker.tsx:54`): **"Every guardrail runs inside Receipt. Pick one to
configure how it…"**, search placeholder `"Search guardrails"` (`:69`).

Editor (`guardrail-editor-dialog.tsx`): title `Edit {Kind}` / `Add {Kind}` with the
kind description; fields **Operation**, **Enforcing strategy**, **Runs on**,
**Description**, **Enabled**; default strategy `enforce_but_ignore_on_error` (`:62`, `:78`).

### 2.2 The nine kinds, defaults, and config fields

Catalog: `apps/start/src/lib/shared/guardrails.ts:151-357` (`GUARDRAIL_KINDS`). All nine
have `family: 'receipt'`. The descriptor type also allows `family: 'connected'` with a
`requiresCapability`, but no shipped kind uses it (`:103-125`).

| id | Name | Default op | Ops | Default stages | Config fields (key → label, default) |
|---|---|---|---|---|---|
| `secrets_detection` | Secrets Detection | mutate | validate, mutate | input, output, tool | `minimumSeverity` (medium); `maskWith` "Replacement text" (`[redacted]`); `allowlist` "Allowed values" |
| `pii_phi` | PII / PHI | mutate | validate, mutate | input, output | `categories` (default `email, phone, ssn, credit_card`; also `ip_address`); `maskWith`; `minimumSeverity` |
| `prompt_injection` | Prompt Injection | validate | validate | input, tool | `minimumSeverity`; `blockOnToolOutput` "Also inspect tool results" (true) |
| `regex_pattern` | Regex Pattern Match | validate | validate, mutate | input, output | `patterns` "Patterns" (**required**, placeholder `ACME-[0-9]{6}`); `maskWith` |
| `content_moderation` | Content Moderation | validate | validate | input, output | `categories` (default `harassment, hate, self_harm, sexual, violence`); `minimumSeverity` |
| `code_safety` | Code Safety Linter | validate | validate | tool, output | `minimumSeverity`; `allowlist` "Allowed commands" |
| `sql_sanitizer` | SQL Sanitizer | validate | validate | tool | `blockUnboundedWrites` "Block writes with no WHERE clause" (true); `minimumSeverity` |
| `word_blocklist` | Word Blocklist | mutate | validate, mutate | input, output | `terms` "Blocked terms" (**required**, placeholder `project-atlas`); `maskWith` |
| `request_metadata` | Request Metadata Validation | validate | validate | input | `requiredKeys` "Required keys" (**required**, placeholder `x-cost-center`) |

Descriptions worth quoting verbatim (all from `:151-357`): Secrets Detection "Finds
credentials that should never leave your systems — cloud keys, API tokens, JWTs, and
private key blocks."; PII / PHI "Detects and masks personal and health information:
emails, phone numbers, national IDs, and payment card numbers."; Prompt Injection
"Catches attempts to override the system prompt, exfiltrate instructions, or jailbreak
the agent."; Request Metadata Validation "Requires specific metadata keys on every
request, so runs that skip your tenancy or cost headers never reach a model."

Severity select: **"Low — flag everything"**, **"Medium — balanced"**, **"High — only
strong matches"**, default `medium`, help **"Matches below this severity are recorded but
never block."** (`:133-144`). Note a small divergence: the evaluator's own fallback when
the field is missing is `low` (`packages/receipt-app/src/services/guardrail-enforcement.ts:57-62`),
while the detectors' fallback is `medium` (`guardrail-detectors.ts:42-48`); the catalog
default of `medium` is what the form writes, so this only matters for hand-written config.

One caveat for the `blockOnToolOutput` field on Prompt Injection: the descriptor carries
it, but the detector `detectPromptInjection` (`guardrail-detectors.ts:276-291`) never reads
it. Whether tool traffic is inspected is decided purely by the guardrail's `stages`.

### 2.3 Vocabulary and semantics

`apps/start/src/lib/shared/guardrails.ts:14-88`:

- **Operation**: `validate` (label "Validate") blocks the run; `mutate` ("Mutate") masks the span and lets the run continue.
- **Enforcing strategy** — what happens when the guardrail *itself* fails:
  `enforce` → "Enforce" — "Block the run if this guardrail trips, and also if the guardrail itself fails to run."
  `enforce_but_ignore_on_error` → "Enforce but ignore on error" — "Block the run if this guardrail trips, but let the run through if the guardrail itself errors." (default)
  `monitor_only` → "Monitor only" — "Never block. Record every match so you can see what would have been caught."
- **Stage** labels: `input` → "Prompt", `output` → "Response", `tool` → "Tool traffic".
- Group summary: `"{n} active guardrails · {n} blocking · {n} masking"` or "No active guardrails" (`:496-513`).

Evaluator rules (`packages/receipt-app/src/services/guardrail-enforcement.ts`):

- Only guardrails that are `enabled` and whose `stages` include the requested stage run (`:85-87`).
- `mutate` guardrails never block on their own (`:64-72`); a `validate` guardrail blocks unless `monitor_only` (`:70-72`).
- A guardrail whose detector is missing throws `No detector is available for '{kindId}'. It is configured but not enforcing.` and the strategy decides whether that blocks (`:103-116`); only `enforce` blocks on error (`:74-76`).
- Findings below `minimumSeverity` are dropped (`:129-133`).
- The block explanation never echoes the matched text: `Blocked by guardrail "Name": reason.` (multiple: `guardrails "A", "B": r1; r2.` capped at three reasons), or `Blocked because "Name" could not run: <message>`, or `Blocked by an organization guardrail.` (`:163-182`). Detector `reason` strings are themselves non-sensitive by contract (`guardrail-detectors.ts:21`).

### 2.4 Detectors — what they are (and are not)

`packages/receipt-app/src/services/guardrail-detectors.ts`. The file header states the design:
detectors are "pure and synchronous", run "inside the request", and use bounded scans
(`:1-12`). Concretely:

- Scan cap `MAX_SCAN_CHARS = 200_000` (`:75`); findings cap `MAX_FINDINGS = 200` (`:81`).
- **Secrets**: nine fixed regexes — AWS access key, GitHub token, Slack token, OpenAI key, Anthropic key, Google API key, PEM private-key header, JWT, URL with inline credentials (`:115-134`). Allowlist is literal substring match (`:105-106`).
- **PII**: email, phone, SSN (with the 000/666/9xx exclusion), credit card with a Luhn check (`:157-172`, `:174-205`), IPv4.
- **Prompt injection**: eight fixed phrases/markup patterns with hard-coded severity, e.g. "ignore … previous instructions" (high), "developer/god/admin mode" (medium), `<system>`-style markup (low) (`:229-274`).
- **Regex**: user patterns compiled with flags `giu`; an uncompilable pattern is skipped (`:295-317`).
- **Content moderation**: a short literal term list per category (`:321-331`) — e.g. self_harm: "kill myself", "suicide", "self-harm", "end my life". There is no external moderation API.
- **Code safety**: seven regexes (`rm -rf /`, `eval(`/`exec(`, `os.system`/`subprocess`, `curl … | sh`, `chmod 777`, `sudo`, `dd if=/dev/zero of=/`) (`:360-372`).
- **SQL**: `DROP`, `TRUNCATE TABLE`, `GRANT ALL`, and `DELETE`/`UPDATE` without `WHERE` (`:394-437`).
- **Word blocklist**: whole-word, case-insensitive (`:441-455`).
- **Request metadata**: required keys present and non-empty (`:464-484`).
- Overlapping findings are merged before masking; masking is applied right-to-left (`:500-539`).

**Nothing adaptive, statistical, or model-based exists in these detectors.** No
detector calls a model, no detector has state across calls, no feedback loop updates
any pattern, and no configuration field tunes thresholds from history. The only
"learning" a docs writer could honestly describe is the administrator editing
allowlists and terms. Classify "threat scanners that continuously learn and adapt" as
**absent**.

### 2.5 Limits and validation strings

Shared limits (`apps/start/src/lib/shared/guardrails.ts:405-413`): `maxNameLength 120`,
`maxDescriptionLength 2000`, `maxGuardrailsPerGroup 64`, `maxAccessEntries 64`,
`maxListEntries 128`, `maxListEntryLength 512`, `maxPatternLength 512`. Server limits
add `maxConfigBytes 32768` (`packages/receipt-app/src/services/guardrails.ts:18-26`).
Test input is capped at 20,000 characters (`guardrails.functions.ts:131`).

Form-side messages (`shared/guardrails.ts:430-459`): "Enter a name for this group.",
"Enter a name for this guardrail.", "Names must be 120 characters or fewer.", "Use at
least one letter or number in the name.", "Enter a pattern.", "Patterns must be 512
characters or fewer.", "This is not a valid regular expression."

Server-side (`guardrails.server.ts`): "Only organization owners or admins can manage
guardrails." (`:57`), `Unknown guardrail type '{kindId}'.` (`:166`), "Choose at least one
place for this guardrail to run." (`:197`), `{Field} is required for {Kind}.` (`:211`),
`A guardrail group named '{name}' already exists.` (`:295`), "Add at least one guardrail
to this group." (`:303`), "This guardrail group no longer exists." (`:575`).

### 2.6 Receipts, ids, storage, replication

Runtime module `packages/receipt-app/src/services/guardrails.ts`:

- Eight event types: `organization.guardrail_group.created`, `.updated`, `.enabled_changed`, `organization.guardrail.added`, `.updated`, `.removed`, `organization.guardrail_group.archived`, `.deleted` (`:59-119`).
- Stream id `organizations/{orgId}/guardrail-groups/{groupId}` (`:204-215`).
- Group id `grp_{hash(orgId:slug)}` — deterministic so two admins creating the same name converge on one stream (`:174-187`). Guardrail id `gr_{hash(groupId:kindId:seed)}` (`:201`). The hash is a small FNV-style function, not SHA (`:189-199`).
- Projection table `receipt_org_guardrail_group_projection`; `listEnforceableGuardrails` returns guardrails from groups that are `enabled` **and** `status === "active"`, each itself `enabled` (`:635-646`). Deleting drops the projection row and frees the name; receipts remain (`:109-113`).
- Runtime contract: `derived-read-model`, Zero publication `default`, source stream prefix `organizations/` (`packages/receipt-app/src/services/runtime-contracts.ts:463-471`).
- Zero replication is restricted to owners/admins **inside the query** (`apps/start/src/integrations/zero/queries/guardrails.queries.ts:10-42`); the replicated columns include `guardrails_json` and `access_json` (`schema.ts:163-181`). The publication list adds both projection tables as app-owned public tables (`apps/start/scripts/zero-publication.ts:29-41`).
- Server functions (`guardrails.functions.ts:50-127`): `createGuardrailGroup`, `updateGuardrailGroup`, `setGuardrailGroupEnabled`, `addGuardrail`, `updateGuardrail`, `removeGuardrail`, `archiveGuardrailGroup`, `deleteGuardrailGroup`, `listGuardrailGroups`, `testGuardrailGroup`.

**Archive is hidden.** `archiveGuardrailGroupAction` (`guardrails.server.ts:442-456`) and
the hook `archiveGroup` (`use-guardrails.ts:289-292`) exist, but no component calls
`archiveGroup` (grep across `apps/start/src/components`). The row menu offers only
"Delete group". "Show archived" therefore only ever shows groups archived by a direct
server-function call.

Cache: writes invalidate a 10-second per-organization cache
(`guardrails.server.ts:85-99`; `guardrail-enforcement.service.ts:20`, `:30-33`). Because
nothing reads through the cache in production, this is currently a no-op.

### 2.7 Test dialog and its boundary

`guardrail-test-dialog.tsx`: title `Test {groupName}`, description **"Run this group's
guardrails against sample text. Nothing is saved and no live traffic is affected."**,
buttons **"Run test"** / **"Close"** (`:88-93`). Field **"Inspect as"** (Prompt / Response /
Tool traffic) with note **"Only guardrails configured to run here will be applied."**
(`:98-116`); **"Sample text"** pre-filled with
`Here is my AWS key AKIAIOSFODNN7EXAMPLE and email me at person@example.com` (`:35-36`).
Result shows **Allowed** or a blocked state, the masked text, violations, and errors.
The server passes `metadata: {}` (`guardrails.server.ts:583`), so a Request Metadata
guardrail always reports its keys missing in the test dialog.

Boundary: this dialog is the **only** execution path for guardrails at HEAD. It is
admin-only (`requireGuardrailAdmin`) and passes the stored `group.guardrails` to the
evaluator, which filters on `enabled` (`guardrail-enforcement.ts:85-87`), so disabled
guardrails are skipped in tests too. The group's own enabled/archived state is not
consulted by the test path, so a switched-off group can still be tested.

### 2.8 Self-hosting panel

If Postgres returns `42P01` for the projection table, the page shows **"Guardrails storage
is not set up yet"** with the remediation `docker compose -f docker-compose.postgres.yml up -d`
then `cd apps/start && bun run zero:migrate`, and the note "A restart is needed because the
replication layer builds its table list at startup." (`guardrails-page.tsx:32-39`, `:348-367`).

### 2.9 Where guardrail decisions are recorded

Configuration changes: receipts on the group stream (above). **Evaluation outcomes:
nowhere.** The evaluator returns violations to its caller; there is no
`guardrail.violation` receipt type, no projection, and no log line in
`guardrail-enforcement.service.ts`. The "Monitor only" strategy copy ("Record every match
so you can see what would have been caught") describes an intent; at HEAD there is no
place where such matches are recorded or shown, other than the test dialog result.

---

## 3. Policies — `/organization/settings/policies`

Component `apps/start/src/components/organization/settings/policies/policies-page.tsx`.
Title **"Policies"**, description **"Configure organization-wide policies."**
(`en.json:435-436`). Five URL-backed tabs (`:31-37`): **Rate limiting** (default),
**Budget limiting**, **Logging config**, **Guardrails**, **Tool approval**. The tab strip
moved to the shared `TabList` component since `41baea75` (`:16`, `:67-78`); labels are
unchanged.

The Guardrails tab is a hand-off (`:112-127`): title **"Guardrails live on their own
page"**, body **"Guardrail groups inspect what your agents send and receive, and every
change writes a receipt. They are configured on the Guardrails page, which is fully
connected — unlike the modules alongside it here."**, button **"Open Guardrails"**.
Read literally, that sentence claims Guardrails are "fully connected". The code says
otherwise (§1). It also concedes, correctly, that the other four modules are not.

Per-module intro copy (unchanged at HEAD): rate limiting "Each request is checked against
these rules in order, and only the first match applies…" (`rate-limit-panel.tsx:97`);
budgets "…the first matching rule wins…" (`budget-panel.tsx:98`); logging "Control which
gateway requests are recorded and which fields are masked in the stored copy. Redaction
changes only the log — the model still receives the original request."
(`logging-panel.tsx:96`); tool approval "Require a human decision before sensitive agent
tools run. Every policy covering a tool applies to it, and the agent waits until an
approver responds on the channel you choose." (`tool-approval-panel.tsx:130`), with toasts
"Approval policy created." / "Approval policy updated." (`:117`, `:121`).

Runtime model (`packages/receipt-app/src/services/policies.ts`): modules `rate_limit`,
`budget`, `logging`, `tool_approval` (`:35-39`); events `organization.policy_rule.created|updated|enabled_changed|deleted` (`:53-88`); rule id `pol_{module}_{hash(seed)}` with deliberate randomness so two rules may share a name (`:168-176`); stream `organizations/{orgId}/policy-rules/{ruleId}` (`:178-186`); reducer enforces "a stale client cannot resurrect a deleted rule" (`:197-252`); limits `maxNameLength 120`, `maxRulesPerOrganization 200`, `maxFilters 20`, `maxFilterValues 100`, `maxRedactions 50`, `maxApprovers 50`, `maxTools 100` (`:25-33`). Server functions `listPolicyRules`, `createPolicyRule`, `updatePolicyRule`, `setPolicyRuleEnabled`, `deletePolicyRule` (`policies.functions.ts:37-65`) behind "Only organization owners or admins can manage policies." (`policies.server.ts:43`). The projection table is not in the Zero client schema (grep of `schema.ts`); the page reads through server functions.

**How policy objects are evaluated in the runtime: they are not.** The file's own header
says "the enforcement path evaluates it complete" (`:43-50`) as a design statement, but
there is no consumer of `listPolicyRules`/`getPolicyRule` beyond `policies.server.ts`,
and no reference to the projection table beyond schema/DDL/publication/contract files.
Rate limits, budgets, logging redaction, and tool approval are configured and audited,
not applied.

---

## 4. Compliance policy and provider policy

Routes: `/organization/settings/provider-policy` ("Provider policy" — "Configure provider
and model restrictions and compliance flags for your organization.", `en.json:506-507`)
and `/organization/settings/compliance-policy` ("Compliance & Policy" — "Configure
organization-level AI rules and access policies.", `en.json:407-408`). Neither has a nav
entry; both are URL-only (**hidden**). The compliance page renders only the flags section.

Flags (`compliance-flags-section.tsx:17-109`; strings `en.json:393-401`):

| Card | Description | Help | Backing value | Enforced? |
|---|---|---|---|---|
| **Require ZDR (Zero Data Retention)** | "Only allow models from AI providers that do not retain data. This is enforced at the provider level." | "Applies immediately to model availability." | `complianceFlags.require_zdr` | Yes, with bypass |
| **Require organization provider key** | "Only allow models from providers that have an active organization API key." | "Applies immediately to provider availability." | `complianceFlags.require_org_provider_key` | **No** |
| **Enforce Study Mode** | "Force organization chat requests to use Study Mode and lock the toggle." | "Applies immediately to new chat requests." | `enforcedModeId === 'study'` | Yes |

**ZDR exact semantics.** `isDeniedByComplianceFlags` denies a model when
`flags.require_zdr && !model.zeroDataRetention` (`compliance-map.ts:13-21`). The catalog
entry's `zeroDataRetention` flag is the whole test; there is no runtime check against the
provider. **Bypass:** before that check, `policy-engine.ts:38-48` asks
`hasActiveOrgProviderKeyForModel`, which is true only when the org's persisted
`providerKeyStatus` marks an **executable** BYOK provider (`openai` or `anthropic`,
`provider-keys.ts:29-50`) among the model's route providers. So an org with "Require ZDR"
on and an OpenAI BYOK key saved can use non-ZDR OpenAI-routed models. The BYOK page warns
about this: **"Disable ZDR for this provider?"** / "Your organization requires ZDR right
now. Saving a {providerName} API key will turn off ZDR enforcement for {providerName}
requests that use your org key. Other providers keep their current ZDR behavior." /
**"Save key and disable ZDR"** (`en.json:390-392`). The same bypass applies to the tool
policy's ZDR check for Anthropic code execution (`tool-policy.ts:88-93`, `:119-124`).

**Require organization provider key is inert.** The type comment still says the key is
"configured in WorkOS Vault" (`compliance-map.ts:6-10`) — stale; keys live in Postgres
under `BYOK_ENCRYPTION_KEY_B64`. Nothing in the request path reads the flag. The UI card
defaults to disabled unless a feature-access state is supplied (`:54`).

**Enforce Study Mode.** `resolveEffectiveChatMode` returns the org mode with
`isEnforced: true` ahead of request and thread modes (`resolver.ts:14-27`). Study Mode
pins `openai/gpt-oss-120b`, injects a study-assistant system prompt, and sets empty
provider-native tool allowlists for openai/anthropic/google/xai (`registry.ts:7-25`).

**403 machine reasons.** All policy denials are `ModelPolicyDeniedError` with message
"Selected model is not allowed for this request" (`model-policy.service.ts:47-56`),
classified as HTTP 403 (`error-classification.ts:119-125`). Reasons:
`policy_denied:provider`, `policy_denied:model`, `policy_denied:compliance` (joined when
several apply, `:220`), `policy_denied:missing_org_context_for_provider_key` (`:273`),
`policy_denied:provider_not_supported_by_byok:<providerId>` (`:352`),
`policy_denied:missing_provider_api_key:<providerId>` (`:422`). User-visible text:
**"The selected AI model is not allowed for your organization."**
(`en.json:324`, via `ChatErrorI18nKey.ModelNotAllowed`, `error-classification.ts:314-326`);
missing-key reasons map to `ProviderKeyMissing`. Telemetry: plain policy denials are
`captureMode: 'none'` (not sent to PostHog); the BYOK-related reasons are `'signal'`
(`:265-276`).

Mutators: `toggleProvider`, `toggleModel`, `toggleComplianceFlag`, `setEnforcedMode`,
`toggleProviderNativeTools`, `toggleExternalTools`, `toggleTool` in
`org-policy.mutators.ts`; each runs `requireOrgPolicyAdmin` ("Only workspace owners or
admins can manage organization settings.", `:122-154`) and `requireOrgFeature`
(`:160-182`), which resolves to always-allowed (§6). Operator env `CHAT_REQUIRE_BYOK=true`
(`model-policy.service.ts:38-40`) is the only hard "provider key required" gate.

---

## 5. Tool permissions (summary; the MCP report covers depth)

- **Classification.** Nango actions: any declared endpoint method in POST/PUT/PATCH/DELETE → write; otherwise read; with no endpoint metadata, only names matching the conventional read regex are reads and everything else is a write — "fail closed" (`receipt-connect-call.ts:785-800`). MCP tools: `annotations.readOnlyHint` is authoritative, else the same name regex (`:904-908`).
- **Two gates for a write.** The JWT must carry `connect:write` (`:1908-1909`, error `:195-198`; routes at `receipt-connect-routes.ts:888`, `:1177`), and the action must be enabled in the connection policy (`:1900-1906`).
- **Allowlist semantics.** `receipt_action_policy` metadata (`:648`), `schemaVersion 1`: reads enabled by default, writes only if listed; `schemaVersion 2`: only listed actions, reads included (`:1584-1590`). Unknown and disabled tools both return `404 "integration action not found or disabled"` so hidden tools cannot be probed.
- **GitHub.** `receipt_github_repository_policy` (`:649`) with `mode: "all" | "selected"`; in selected mode repo-scoped paths outside the selection get `403 "GitHub repository '<owner/repo>' is not selected for this connection"` and other endpoints `403 "this GitHub endpoint is unavailable while selected repositories are enforced"` (`:2008-2055`).
- **Scopes and TTL.** `connect:read`, `connect:write`, `connect:credential`; default all three; default TTL 12 h; HS256 JWT (`receipt-connect-auth-token.ts:19-33`, `:170`, `:210`). Web tokens carry `connect:read` + `connect:write` (`receipt-connect.server.ts:38-41`). Connection lifecycle and policy edits additionally require workspace mutation authority because "Web tokens intentionally carry broad runtime scopes" (`receipt-connect-routes.ts:806-815`, `:1466-1475`).
- **Factory.** An objective's execution contract adds `connect:write` whenever any Receipt Connect capability is detected for the task (`objective-execution-contract.ts:46-51`). Factory workers therefore get write scope by default when they use integrations; the per-connection allowlist is the remaining gate.
- **Receipts.** Every `/connect/call` writes `tool.called` and, on success, `tool.observed` to `receipt-connect/gateway/<orgId>/<workspaceId>` with `agentId: "mcp-gateway"`, output capped at 2,000 chars, write failures swallowed with a warning (`receipt-connect-tool-receipts.ts:19-24`, `:55`, `:85-133`).

---

## 6. Access control and plan gating

- **Route guard.** `apps/start/src/routes/(app)/_layout/organization/settings/route.tsx:17-41`: pending → "Checking workspace access"; no user / anonymous / no org → `Navigate to="/"`; otherwise `canAccessOrganizationSettingsPath`. There is no "access denied" screen.
- **Rule.** `-organization-settings-access.ts:9-17`: role required; MCP-gateway paths open to any member; everything else owner/admin. `isMcpGatewayPath` matches `/organization/settings/mcp-gateway` **and** `/organization/settings/workspaces` (`mcp-gateway-nav.config.tsx:18-22`).
- **Server authority.** `isOrgAdmin` asks Better Auth `hasPermission` for `organization: ['update']` (`organization-member-role.service.ts:6-31`). Workspace-scoped writes use `requireReceiptWorkspaceMutationAuthority`: workspace owner/admin, else organization workspace admin (`receipt-workspaces.ts:1079-1088`).
- **Roles.** Owner / Admin / Member (`en.json:517-519`).
- **Plan gating is inert.** `apps/start/src/lib/frontend/access-control/index.ts` is now a 32-line file of localized messages only; the logic lives in `apps/start/src/lib/shared/access-control/index.ts`. Advertised minimums: byok/providerPolicy/compliancePolicy/toolPolicy → Plus; verifiedDomains → Pro; singleSignOn/directoryProvisioning → Enterprise; runtime `chat.fileUpload`/`chat.paidModels` → Plus (`:158-177`). But `getPlanEffectiveFeatures` returns `true` for every feature (`:319-325`), `getFeatureAccessState` hard-codes `allowed: true` (`:354-367`), `hasFeatureAccess` returns `true`, `isFreeTierContext` returns `false` (`:398-407`), and `getModelAccess` is `visible: true, allowed: true` under "The current no-paywall contract" (`:409-423`). `requireOrgFeature` in the mutators goes through the same helper (`org-policy.mutators.ts:160-182`). Upgrade copy still exists: "This feature requires a {planName} subscription." / "Upgrade to {planName}" / "Contact us" (`en.json:428-430`).

---

## 7. Security page — `/organization/settings/security`

**Inert placeholder, hidden.** Nav entry `organization-security` is `hiddenFromRail` and
`hiddenFromMenu` (`-organization-settings-nav.ts:301-306`). `security-page.tsx` renders
three cards with all three hrefs `'#'` (`:9-11`) and every button `buttonDisabled`
(`:33`, `:53`, `:75`). Strings (`en.json:431-449`): title **"Security"**, description
**"Configure organization-level security and access controls."**; **"Domains"** — "Verify
ownership of your email domain to enable Single Sign-On." / "You haven't added any
verified domains yet." / **"Add domain"**; **"Single Sign-On"** — "Require all team members
to authenticate via your identity provider." / "You haven't set up Single Sign-On yet." /
**"Set up SSO"**; **"Directory Provisioning"** — "Automatically provision and deprovision
accounts via your identity provider." / "You haven't set up a directory yet." / **"Set up
directory"**. Help text **"This feature will be available soon for self serve."**
(`:40`, `:61`, `:82`; `en.json:427`). Also present but unused on this page: "Organization
security settings are coming soon." and "This feature is only available via Add-on or
Enterprise plan." (`en.json:425-426`). No SSO, domain verification, or SCIM code exists
behind these cards.

---

## 8. Agent risk: Agent Registry and the /sessions checks

**Agent Registry** (`/agent-registry`, reachable, any signed-in non-anonymous user —
`routes/(app)/_layout/agent-registry/route.tsx:36-40`). Title **"Agent Registry"**,
description **"Discover cloud AI agents, classify autonomy, and review organization
risk."** (`agent-registry-page.tsx:209-210`), tabs **Inventory** / **Dashboard** (`:76-77`).
Row action menu offers **"View details"** (`agent-registry-table.tsx:164-166`; added in
`c3c16be6`).

Autonomy levels `L1`–`L4` (`agent-inventory.ts:20`); dashboard labels **"L4 Autonomous"**,
**"L3 Approval"**, **"L2 Advise"**, **"L1 Observe"** (`agent-risk-dashboard.tsx:83-85`).
Classification (`agent-cloud-discovery.ts:174-262`): autonomy = override ?? (autonomous
workload → L4, native agent service → L3, else L2); for Bedrock agents the override reads
action-group function `requireConfirmation === "DISABLED"` → L4, else L3, no enabled
groups → L2 (`:691-710`). Risk: **critical** when L4 with no owner or a wildcard IAM
action; **high** when no owner, L4, or wildcard resource; **medium** when dormant; else
**low** (`:204-210`). Recommendations include "Verify a human approval gate and restrict
write permissions to the minimum required scope." (L4) and "Confirm the human approval
gate is configured and enforced before this agent executes actions." (L3) — these are
advice, not controls. ISM findings strings are emitted only when the signal was observed
(`:231-260`). Dashboard cards: **"Total agents discovered"**, **"Critical risk"**, **"High
risk"**, **"Agents with no owner"**, **"Dormant (30+ days)"**, distributions **"Agent
distribution by autonomy level"**, **"Ownership status"**, **"Credential types"**; empty
state "Connect a cloud account and scan it to build the executive risk dashboard."
(`agent-risk-dashboard.tsx:115-166`).

**/sessions "Compliance readiness" card.** `buildChecks`
(`apps/start/src/lib/frontend/sessions/agent-sessions.server.ts:340-420`) derives five
cards from counts only: turnCount = requests + responses; `analysisReady = turnCount >= 20 && receiptCount >= 40`. The compliance card: title **"Compliance readiness"**; status
`action` if any error markers, else `watch` when analysisReady, else `pass`; metric **"Scan
ready"** / **"Metadata only"**; summary **"Enough bounded evidence exists to run privacy,
secret, and policy checks."** / **"Not enough evidence for a meaningful compliance scan
yet."**; detail "The dashboard should not dump raw prompts by default. A compliance job
should scan a capped evidence window and write findings back as receipts."; button **"Run
compliance scan"** / **"Wait for evidence"** (`:384-392`). The button handler for
`compliance` simply opens the evidence panel (`sessions-page.tsx:880-888`); **no scan runs
and no findings are written**. Classify as **inert** (a readiness heuristic, not a check).

---

## 9. Data handling and telemetry

- **PostHog** (unchanged since `41baea75`; no commits touched these paths). Client init disables autocapture, pageview, pageleave, session recording, and surveys, keeps persistence, and starts exception autocapture (`posthog.client.ts:45-58`). Server capture is exception-only, keyed on the wide event, and sends `actor`, `thread`, `model`, `policy`, `stream`, `usage`, `outcome`, `breadcrumbs`, and `cause` objects (`posthog.server.ts:59-95`). The `policy` object carries `zeroDataRetentionRequired` (`wide-event.ts:86-92`, populated at `chat-orchestrator.service.ts:395-397`), but **ZDR never suppresses telemetry**: the only gates are `outcome.ok` and `captureMode === 'none'` (`posthog.server.ts:65-66`). Everything is off when `POSTHOG_PROJECT_API_KEY` is unset or the build is self-hosted. OTLP export is opt-in via `EFFECT_OTLP_BASE_URL` (`server-observability.layer.ts:85`).
- **BYOK at rest.** AES-256-GCM, 12-byte IV, key version 1, wrapping key from `BYOK_ENCRYPTION_KEY_B64` (must decode to 32 bytes), with the stated rationale "a database-only leak is not enough to recover plaintext provider credentials" (`packages/receipt-app/src/services/byok-crypto.ts:3-6`, `:33-56`, `:58-75`; `provider-key-store.ts:22-23`). A 12-hex-char SHA-256 fingerprint is kept for display (`byok-crypto.ts:24-25`). `org_provider_api_key` is not in the Zero client schema (grep), so ciphertext never replicates to browsers.
- **Connection references at rest.** AES-256-GCM under `RECEIPT_CONNECTION_ENCRYPTION_KEY_B64` (32 bytes) (`receipt-connect-connections.ts:123`, `:349-366`; `receipt-connect-config.ts:117-125`). Kinds: `nango-reference`, `local-aws-profile`, `aws-credential-process`, `github-token` (`:26-31`). Zero exposes only `id, organizationId, workspaceId, provider, name, kind, status, expiresAt, lastValidatedAt, createdAt, updatedAt` (`schema.ts:91-105`).
- **Zero column allowlists** are explicit per table; guardrail configuration replicates only to owners/admins (§2.6); policy rules do not replicate at all.
- **Slack.** Make no at-rest claim about Slack tokens in public docs.

---

## 10. GovSig and cryptographic proof — what exists

- **Hash chain.** `computeHash` is SHA-256 over canonical JSON of `{id, ts, stream, prev, body, context?}`; hints are excluded (`packages/receipt-core/src/chain.ts:15-29`). `receipt()` builds the record with `prev` and `hash` (`:47-69`). `verify(chain)` checks `prev` linkage and recomputes every hash, returning `{ok, count, head}` or `{ok: false, at, reason: "broken prev" | "hash mismatch"}` (`:91-103`).
- **Append integrity.** Postgres store: unique index on `hash` and on `(stream, hash)` (`adapters/postgres.ts:234-236`); append takes a per-stream advisory lock, compares the expected prev to the stored head, and throws `Expected prev hash … but head is …` on mismatch (`:498-526`).
- **Replay integrity.** The core runtime refuses to fold an invalid chain: `Receipt runtime refused to replay invalid chain for stream '…': <reason> at index <n>` (`packages/receipt-core/src/runtime.ts:123-130`); `runtime.verify(stream)` is exposed (`:464`).
- **`receipt dst`.** The CLI audit runs `runtime.verify` per stream and reports `Integrity failures: <n>` and per-stream `integrity=<reason> at receipt <n>` (`packages/receipt-app/src/cli/dst.ts:471-481`, `:534-537`, `:619`, `:641`, `:662`); `docs/receipt-dst.md:1-25` describes it as the audit for "are receipt streams structurally valid and replayable?" with `--json` and `--strict`. `packages/receipt-dst` itself is the deterministic-simulation harness, not a verifier.
- **Signing: absent.** Case-insensitive grep for `govsig` across `apps`, `packages`, `workers`, `docs`, `skills`, `scripts`, `README.md`, `AGENTS.md` and the sibling doc corpus returns nothing. Grep for `ed25519`, `createSign`, `crypto.sign`, `.sign(` in `receipt-core`, `receipt-durable`, and `receipt-app/services` finds only HMAC-SHA256 use for the Receipt Connect JWT (`receipt-connect-auth-token.ts:57`, `:170`), the debug token, and Slack/Teams OAuth state (`packages/receipt-core/src/slack.ts:68-70`, `teams.ts:55-58`). No receipt carries a signature field (`chain.ts:56-68`). The repo's own engineering note is explicit: "Treat public hashes as tamper detection, never origin authentication." (`docs/agent-fix-checklist.md:9275`). The glossary calls the chain "tamper-evident, blockchain-like" (`docs/GLOSSARY.md:37-42`), which is accurate as long as "tamper-evident" is not upgraded to "signed".

So: receipts are a SHA-256 hash-chained, append-only, replay-verified log. They are not
signed, there is no key material, no timestamping authority, and no artifact named
"GovSig".

---

## 11. Read-only by default and approval before state change

What a user can rely on at HEAD:

1. **MCP gateway writes need `connect:write` and an allowlisted action** (§5). A `schemaVersion 2` policy exposes nothing by default; a never-edited `schemaVersion 1` policy exposes reads by default. This is the only "read-only by default" behavior in the product, and it is per-connection, not global.
2. **Web tokens and Factory contracts carry `connect:write`** (`receipt-connect.server.ts:38-41`; `objective-execution-contract.ts:46-51`). Neither chat nor Factory is read-only by construction; the allowlist decides.
3. **Human approval primitive exists in the engine but no production agent uses it.** `human.requested` / `human.responded` are control receipts (`engine/runtime/control-receipts.ts:111-126`); the agent loop appends `human.requested` for `kind === "human"` actions and waits for `responseWhen` (`engine/runtime/agent-loop.ts:1805-1824`; `sdk/actions.ts:48-58`). Grep for `human(` / `kind: "human"` outside tests and `sims/` finds no user. The sims (`services/factory/sims/generic-agent-loop.ts:641-771`) exercise the primitive.
4. **Factory "blocked" is a heuristic, not an approval gate.** `HUMAN_INPUT_BLOCK_REASON_RE` (`factory/runtime/blocked-policy-constants.ts:2`) matches words like "approval", "permission denied", "credentials" in worker blocker text and marks a task blocked for human input; it does not intercept an action.
5. **Chat has no tool-approval step.** No `approval`/`needsApproval` reference in `apps/start/src/lib/backend/chat`; the only confirmations in the chat UI are destructive-thread dialogs (`chat-sidebar.tsx:342`). The "Tool approval" policy module is inert (§3).
6. **Dry-run** exists only for `receipt mcp install codex --dry-run` (`receipt-mcp-cli.ts:722`) and the guardrail test dialog.
7. **Agent Registry** advises to "Verify a human approval gate" for L3/L4 agents; it reads Bedrock `requireConfirmation` to classify, but does not configure or enforce anything.

---

## 12. Operational notes for docs

- **Where decisions are recorded.** Model-policy denials: HTTP 403 with `reason` in the wide event; not persisted as receipts. Gateway calls: receipts (§5). Guardrail and policy **configuration**: receipts on `organizations/<org>/guardrail-groups/<id>` and `organizations/<org>/policy-rules/<id>`. Guardrail **evaluations**: not recorded.
- **How an admin tests.** Only the Guardrails "Test group" dialog (§2.7).
- **Troubleshooting strings** to quote: "Guardrails storage is not set up yet"; "Only organization owners or admins can manage guardrails."; "Only organization owners or admins can manage policies."; "Only workspace owners or admins can manage organization settings."; "The selected AI model is not allowed for your organization."; `integration action not found or disabled`; `integration action '<tool>' requires connect:write`; `Expected prev hash … but head is …`; `Receipt runtime refused to replay invalid chain for stream …`.

---

## Changes since 41baea75

`git log --oneline 41baea75..HEAD` lists 43 commits. Diffs against the guard-relevant paths:

1. **Guardrails: no behavioral change.** Zero commits touched `apps/start/src/lib/shared/guardrails.ts`, `apps/start/src/lib/frontend/guardrails/**`, `apps/start/src/components/organization/settings/guardrails/**`, `packages/receipt-app/src/services/guardrails.ts`, `guardrail-enforcement.ts`, `guardrail-detectors.ts`, or `apps/start/src/lib/backend/chat/services/guardrail-enforcement.service.ts`. The enforcement service still has no caller; the prior "authoring-only" verdict stands.
2. **Policies page: cosmetic only.** `46652e84` replaced the hand-rolled tab strip with the shared `Tab`/`TabList` (`policies-page.tsx:16`, `:67-78`). Copy, including "fully connected", is unchanged. `packages/receipt-app/src/services/policies.ts` and `apps/start/src/lib/shared/policies.ts` are untouched.
3. **`runtime-contracts.ts`** gained two table contracts, `receipt_projection_work` and `receipt_reducer_checkpoints` (`:411-428`), from the projection-durability series (`00ef6f17` … `8c74802b`). No guard semantics changed.
4. **Security page, access-control, compliance-map, policy-engine, tool-policy, org-policy mutators, PostHog client/server, receipt-core, receipt-dst:** no commits.
5. **`receipt-connect-routes.ts`** changed by 27 lines (in `b90c9070`, cloud-provider disconnect) without altering the scope/allowlist gates cited above.
6. **Agent Registry** is new relative to the map (the `feat/agent-cloud-inventory` series `26ec975a` … `20d20f51`, then `a241a9b1`, `b90c9070`, `c3c16be6`): receipt-backed cloud agent inventory, autonomy filter, multi-region AWS and EC2 scanning, Bedrock capability-based classification (`296c6d22`), dedicated AWS/Azure/GCP connection, and at HEAD a row "Actions" menu with "View details" plus a scoped error boundary.
7. **`apps/start/src/lib/frontend/access-control/index.ts`** is now a 32-line localized-message module; the always-allow logic the prior report cited lives in `apps/start/src/lib/shared/access-control/index.ts` (same behavior).
8. `docs/tool-reliability-fixes-2026-09-05.md` (from `e6944514`) records production fixes to dependency promotion, semantic routing, sandbox auto-stop, permanent-auth retry termination, and Zero-readiness rollout ordering. None of it touches guardrails or policy enforcement; the only guard-adjacent statement is that permanent credential failures now stop supervisor retries.

---

## Documentation implications

**Suggested page split**

1. `governance/guardrails` — groups, the nine kinds with fields and defaults, operation vs strategy vs stage, the test dialog, limits, receipt audit trail. Must carry a status banner: guardrails are configured, versioned, and testable; they are not yet applied to live chat, tool, Factory, or gateway traffic.
2. `governance/model-and-compliance-policy` — disabled providers/models, Require ZDR and its BYOK bypass, Enforce Study Mode, `CHAT_REQUIRE_BYOK`, the 403 reasons and user-visible string. State plainly that "Require organization provider key" is not enforced.
3. `governance/policies` — rate limits, budgets, logging, tool approval: rule shapes, ordering copy, limits, receipts; status note "configured and audited, not applied".
4. `governance/tool-permissions` — read/write classification, `connect:write`, v1/v2 allowlists, GitHub selected repositories, 404 semantics, gateway receipts (link to the MCP report).
5. `platform/access-control` — owner/admin rule, the Workspaces/MCP exception, workspace mutation authority, roles; note that plan gating is not active.
6. `platform/agent-registry` — discovery, L1–L4, risk levels, ISM findings, recommendations as advice.
7. `developers/receipt-integrity` — hash chain, CAS append, replay refusal, `receipt dst`; explicit "hash-chained, not signed".
8. Omit or defer: the Security page (placeholder), the /sessions Compliance readiness card (heuristic with no scan).

**What to claim / avoid**, per the Kentron positioning:

| Claim | Status | Reason |
|---|---|---|
| "Intercept risky agent actions in real time before execution." | **unsupported** (for guardrails); **partial** only if rephrased to the gateway | Guardrail enforcement has no caller (§1). The one real pre-execution gate is the MCP gateway's scope + allowlist + GitHub repo policy, which blocks disallowed tool calls before they run (`receipt-connect-call.ts:1900-1909`). Say "blocks tool calls that are not allowlisted" rather than "intercepts risky actions". |
| "Threat scanners that continuously learn and adapt." | **unsupported** | Detectors are fixed regexes and literal term lists with no state, model, or feedback loop (`guardrail-detectors.ts`). Do not claim learning or adaptation. |
| "Detect and block PII leakage, policy violations, and unauthorized data access in a single dashboard." | **partial** | PII/secret detection exists and can be exercised in the test dialog; blocking of live traffic does not happen; there is no detections dashboard (evaluations are not recorded). Unauthorized-data-access blocking is real only at the gateway allowlist level. Rephrase as "define PII and secret rules" plus "gateway allowlists". |
| "One policy, every AI tool." | **partial** | Model/compliance policy applies to every chat request in the org; tool allowlists are per connection; guardrails and the Policies modules do not apply anywhere. Avoid "every AI tool"; say "organization-wide model and compliance policy". |
| "Stop risks before they execute." | **partial** | True for disallowed gateway actions, disabled providers/models, ZDR (with bypass), and Study Mode. Not true for content risks (guardrails inert) or spend/rate/approval (Policies inert). |
| "Auditable agent deployments: cryptographic proof documents every agent decision (GovSig)." | **partial**, with "GovSig" **unsupported** | Receipts are SHA-256 hash-chained, append-only with prev-hash CAS, refused on replay if broken, and auditable with `receipt dst`; gateway calls and configuration changes write receipts. There is no signing, no key, and no artifact called GovSig anywhere. Say "tamper-evident, hash-chained receipts"; never "cryptographically signed" or "GovSig" unless that product is built. Also note chat model-policy denials and guardrail test results are not receipts. |

Additional cautions: do not repeat the Policies page's "fully connected" sentence in
docs; do not describe "Monitor only" as producing a log until one exists; do not state a
plan is required for BYOK/policies/ZDR; do not describe SSO/domains/SCIM as available;
make no at-rest claim about Slack tokens; do not claim ZDR limits telemetry.

---

## Open questions

1. Is guardrail enforcement expected to be wired into `chat-orchestrator.service.ts` (prompt/response/tool) before the docs ship, or should the Guardrails page be documented as authoring-only for this release? The Policies page copy ("fully connected") should be corrected either way.
2. Should "Monitor only" matches be persisted (a receipt type or projection) so the "Record every match" copy becomes true? Where would admins see them?
3. Is "GovSig" a planned signing layer (e.g. per-receipt signatures over the existing hash) or a marketing label for the hash chain? The docs need one answer before using the word.
4. "Require organization provider key": fix the enforcement gap, hide the toggle, or document it as not enforced?
5. Should the `blockOnToolOutput` field on Prompt Injection be honored by the detector, or removed from the descriptor?
6. Is the intended audience for guardrail enforcement chat only, or also Factory workers and the MCP gateway? The matrix will need a row per surface once any of them is wired.
7. Should Factory objectives keep receiving `connect:write` by default whenever a capability is detected, given the "read-only by default" positioning?
8. Is the /sessions "Run compliance scan" action going to invoke a real scan job, or should the card be removed from public docs?
9. Archive for guardrail groups exists server-side but has no UI entry point; ship a menu item or drop "Show archived"?
10. Plan gating is universally allowed; is that the launch contract, and how should pricing-page claims about Plus features be reconciled?
