
################ A-coworker-chat :: Documentation implications ################
## Documentation implications

### Marketing claims versus code

| Claim | Status | Reason |
|---|---|---|
| "Lives in Slack or Teams" | **Supported (with caveats)** | Both adapters exist and run mention → route → Factory → result (`apps/slack/server.ts`, `apps/teams/server.ts`). Teams is custom-upload only, has no progress updates, no thread context, and needs OpenAI BYOK to run Factory at all (§10). Slack requires an org admin to install (§9.1). |
| "connected with 1000+ apps" | **Unsupported** | The connector catalog is generated from the Nango manifests: **63 provider slugs** at HEAD (`packages/receipt-app/src/integrations/nango/catalog.json` `providerSlugs`, counted 2026-09-07; one slug was added in `26ec975a`). Do not quote a number above what `receiptConnectConnectorCatalog()` returns. |
| "Give it a goal in plain language, not a workflow" | **Supported** | The router is semantic ("Do not decide from keywords, phrase matching, connector-name matching", `chat-layer-routing.ts:426`); the objective supervisor plans tasks (Replay stages Goal → Plan → Work). |
| "It plans, executes, and reports back on its own" | **Supported** | Chat-lane job dispatches one `factory.dispatch`; the objective supervisor iterates; the answer lands in the thread via `onAsyncSettled` and the objective projection (§1.6, §6.3). Slack/Teams post a terminal message. |
| "Works across every system you have connected" | **Partial** | Work is scoped to providers the router selects from the signed capability snapshot; since `e6944514` the inventory is explicitly *not* a dependency source. Write actions additionally need admin enablement. |
| "Read-only by default" | **Partial** | True at the connector-policy level: read actions are enabled by default under legacy policies and writes must be enabled by an owner/admin (`receipt-connect-call.ts:1584-1590`). Not true at the worker level: Factory grants `connect:write` whenever any capability is required (`objective-execution-contract.ts:49`). |
| "any action that changes state waits for your explicit approval" | **Unsupported** | No approval gate exists in web chat, Slack, Teams, or Factory. The **Tool approval** policy UI promises it but nothing enforces it (§13). Codex runs with approvals bypassed (`codex-executor.ts:775-777`). Only the SDK `human` action offers this to custom agent authors. |
| "Proof, not just output" | **Supported** | Every turn and run is receipt-backed; the Agent replay dialog exposes stages, counters, the receipt inspector, replay-to-step, and print (§7). |

### What to claim

- A single chat that either answers directly or launches a background objective, with the
  router's rules quoted from `chat-layer-routing.ts:426-442`.
- The exact composer surface: `+` → Attach files, Skills → Create skill (admin destination),
  Study Mode, Max (when available), Tools. Say plainly that there is no model or reasoning picker
  and that the default model is the org's OpenAI-routed default.
- Background-run UX strings from §6, the stop semantics ("This task is stopped."), and
  `/chat?objective=<id>` as the durable link.
- The Replay dialog as the proof surface, with its tab and stage names.
- Slack behaviour: mention-driven, `:eyes:` + "Working on it…", edited progress, terminal
  `View Receipt` link; admin-only install; identity by Slack email.
- Teams behaviour: acknowledgement then a single result message with `Job: <id>`; per-user claim
  links; `CLIENT_ID`/`CLIENT_SECRET`/`TENANT_ID` (fix `docs/ms-teams-testing-setup.md`).
- Errors: quote the i18n strings in §14 and the Factory failure prose in §1.7.
- The new routing failure sentence, which users will see on web and Slack.

### What to avoid claiming

- Any per-action human approval or "asks before it changes anything". If a page must mention
  the Policies → Tool approval screen, label it as configuration that is not yet enforced.
- "1000+ apps" or any integration count not derived from the catalog.
- Provider-native tools (Web Search, Code Interpreter) being used by the direct answer; they are
  not attached (`tools: {}`).
- Memory of user preferences across chats; the web chat does not inject preference memory.
- Guardrails constraining chat traffic; the helpers have no callers.
- Streaming or progress in Teams; objective re-binding on Teams follow-ups.
- Plan-gated uploads or free-tier allowances; both branches are inert today.

### Suggested page split

1. **Your first chat** — composer, `+` menu, placeholders, titles, the three routes in plain terms.
2. **Background runs** — progress panel, Computer Logs, stop, re-attach link, failure prose.
3. **Read the receipts** — Agent replay tabs, stages, inspector, print.
4. **Editing, branching, and finding messages** — tree, pager, search.
5. **Files and attachments** — accepted types, limits, when files go to the model natively.
6. **Receipt in Slack** and **Receipt in Teams** — separate pages; do not describe Teams as
   "works like Slack".
7. **Errors and limits** — §14 table, rate limit, context limit, routing failure.
8. **Manage tools and permissions** (platform tab) — read vs write actions, who can enable
   writes, and an explicit note that Tool approval and Guardrails are configuration-only at
   this release.
9. **Monitoring your runs** — `/tasks`, `/computers`, `/sessions`, with their direct URLs.

---


################ B-skills :: Documentation implications ################
## Documentation implications

What to claim:

- Organization skills are versioned, hash-chained, admin-managed SKILL.md instructions that every new Factory or computer run receives as a read-only catalog at `receipt/skills/index.json`, with the agent choosing which to read. Quote the page copy and the catalog skill.
- The SKILL.md contract: `---` frontmatter with `name` (≤120) and `description` (≤2000), folded/literal blocks supported, single file ≤256 KB, name becomes the slug.
- Lifecycle: upload creates v1 enabled; re-upload with changes adds a version; identical content is a no-op; Disable/Enable; Delete removes the skill from the list and from new runs while receipts keep version and content hash.
- Chat authoring: asking Beetle in the web app to draft a skill returns a preview; explicitly asking to save/create/install it persists v1 (or acknowledges an identical save) and links to Settings. Only org owners/admins can save; Slack/Teams cannot author skills.
- MCP clients need no skill because the server's `instructions` carry the rules (quote the string).

What to avoid claiming:

- Multi-file skill bundles as a user feature (format-only).
- Archive as a UI action.
- Any ranking, auto-selection, or "skill matching" of organization skills; any receipt that proves a skill was used.
- Editing, enabling, or archiving skills from chat.
- Plugins of any kind.
- Provider-specific integration `SKILL.md` files (none exist), or `factory-gcp-*`/`factory-azure-*` skills.
- The internal runbooks (`deploy-beetle-aws-lite`, `factory-aws-prod-runbook`, `factory-prod-run-debug`, `factory-prod-trace-debug`, `factory-aws-rds-objective-debug`, `receipt-connect-cli-prod-debug`, `receipt-production-analytics`, and the hosted section of `receipt-zero-analyzer`) must not be published; they embed deployment stages, a default AWS CLI profile name, and a named production actor.

Suggested page split:

1. `platform/organization-skills` — page tour, SKILL.md contract, lifecycle, limits, audit model (sections 2, 9).
2. `platform/skills-from-chat` — draft vs save, exact reply shapes, permissions, channel limits (section 3).
3. `factory/skills-in-runs` — `receipt/` layout, `receipt/skills/index.json` shape, repo skill selection, `CODEX_HOME` behavior, patch exclusions, helper catalog (sections 4-6).
4. `reference/repo-skills` (developer docs only) — the public-safe subset of the 25 with the consumer table (section 5).
5. A note in the CLI/MCP page reusing the verified `instructions` string (section 7).

Marketing claims:

| Claim | Status | Reason |
| --- | --- | --- |
| "Skills": organization-defined agent instructions available to runs | supported | Sections 2 and 4; page copy, receipt events, mount path all verified |
| Skills are versioned and auditable | supported | `created`/`version_added` events, content hash, delete dialog help text (2.7-2.9) |
| Create skills from chat | partial | Web only, draft/save only, org admin only, single file; no edit/enable from chat (3, 9.5-9.6) |
| Multi-file skill bundles | partial | Storage/mount format supports up to 128 files; no upload path exists (2.5) |
| Agents automatically use the right skill | unsupported | No ranking/selection; Codex decides; no usage receipt (RCA-377, section 6) |
| "Plugins" | unsupported | No plugin concept exists (section 8) |
| "Connectors" | n/a | Outside this report's scope; skills reference `receipt connect` tools only |
| MCP clients need no extra skill | supported | Section 7 |


################ C-factory-execution :: Documentation implications ################

################ D-mcp-gateway-connect :: Documentation implications ################
## Documentation implications

**Suggested page split.**

| Page | Content |
| --- | --- |
| Receipt Connect overview | §1.1–1.3: org vs workspace vs Global scope, connection addressing, what is and is not stored. |
| Connect an app (web) | §3.2, §7.10 card states and dialogs, Global vs workspace choice. |
| Manage tools and permissions | §1.5–1.7, Manage tools dialog, GitHub repositories, v1/v2 semantics stated as "after the first save, only ticked operations run". |
| MCP Gateway: workspaces | §7.2–7.7 (landing, Overview tabs, members, sharing, details). |
| MCP Gateway: connect a client | §6.2–6.4 setup panel commands plus `receipt workspace use`; Codex only for install; generic config for others; no remote OAuth. |
| Gateway activity | §7.9 with the honest scope note: receipts come from `/connect/call` paths; MCP-bridge calls are not yet recorded. |
| CLI reference | `receipt setup/login/logout/doctor/workspace/tools/mcp/connect` with the exact error strings from §12. |
| Connector catalog | §2 table; label auth mode and surface; keep the 894-row directory described as "browsable, not connectable". |
| Self-hosting integrations | §3.1 variables, webhook HMAC, read repair, `RECEIPT_INTEGRATIONS_DATABASE_URL` server-only rule. |
| Security model | §10 verbatim, including the credential-materialization route. |

**Claims to make.** Provider credentials never leave Nango for the tool path;
MCP client configs are token-free; tool names are opaque and workspace-bound;
writes are default-denied and require both token scope and an admin-saved
allowlist; every connection is isolated per workspace; `read-provider-resource`
is GET-only with a hardened path parser; the device login never puts a token in
a URL; `/connect/call` calls are receipted with duration and outcome.

**Claims to avoid.** "Every action emits a receipt" (MCP bridge calls do not);
"stolen .env is worthless" (the server .env holds the JWT and Nango secrets;
the CLI session file yields credentials for 12 h); "Cursor/ChatGPT/Claude
supported" (only Codex is automated; ChatGPT cannot attach); "one tool to find
any app" (63 connectable connectors, 894 browsable); "take action" as a
general capability (3 of 91 static tools are writes, all Apollo); "Global"
appears anywhere in the URL or id (it is hidden); the Activity page shows tool
receipts (it says it does not); "Slack" as an MCP client (the Slack app is a
chat surface reading Global Integrations; `receipt connect slack` is a Nango
connector).

**Marketing claims assessed.**

| Claim | Status | Reason |
| --- | --- | --- |
| "One tool to find any app, see what it can do, and take action." | **partial** | Find: 63 connectable connectors plus an 894-row browsable directory that cannot be connected (§2). See: `tools/list`, `receipt tools describe`, Manage tools (§4, §7.10) — supported. Take action: only 3 write tools exist in the static catalog; provider-MCP writes are excluded from the aggregate; everything else is GET-only (§2, §4). |
| "Because agents never touch real credentials (scoped passes at the gateway) a stolen .env file is worthless." | **partial** | Supported for the MCP/tool path and for sandbox/client configs (§10). Unsupported as stated: a server `.env` holds `RECEIPT_CONNECT_JWT_SECRET`, `RECEIPT_INTEGRATIONS_SECRET_KEY`, `RECEIPT_CONNECTION_ENCRYPTION_KEY_B64`; the CLI session JWT carries `connect:credential`, can call `/connect/credential/<provider>` to obtain raw provider credentials, lives 12 h, and cannot be revoked (§6.1, §10). |
| "Deploy governed agents across your entire stack (Slack, Claude, Cursor, ChatGPT, Codex, the web)." | **partial** | Codex: automated install (§6.4). Web: chat reads Global Integrations (§8). Slack: the Slack app routes mentions to Factory using Global Integrations (§8), not MCP. Claude and Cursor: only a manually pasted generic stdio config; nothing in the code names them (§6.4). ChatGPT: no OAuth/remote MCP surface, cannot attach (§6.4). Teams reads a different scope than web and Slack (§6.1). |
| "Approved tools, scoped identity, secure runtime." | **partial** | Approved tools: reviewed manifests, opaque aliases, fail-closed allowlist — supported (§1.5, §4). Scoped identity: three-scope JWT bound to org+workspace, membership re-checked per call — supported, minus revocation (§6.1). Secure runtime: true for Factory sandboxes (unchanged OpenSandbox path); an MCP client runs wherever the user runs it, and Receipt controls only the gateway hop. |
| "Every action emits a receipt." | **unsupported** as stated | `recordReceiptConnectToolCall` is invoked only by `POST /connect/call` (`receipt-connect-routes.ts:1185-1246`); `POST /connect/mcp` never records, so calls from the Codex bridge or `receipt tools call` (aggregate form) leave no `tool.called`/`tool.observed` receipt and are invisible on the dashboard (§4, §7.1). Policy changes and connection lifecycle are logged in `org_activity_log`, not receipts. Accurate form: "every `/connect/call` action and every Factory run emits a receipt". |


################ E-llm-gateway :: Documentation implications ################
## Documentation implications

**Safe to claim**

- Receipt's own chat and Factory model calls pass through one server-side resolution step that
  applies organization deny lists (provider, model), a Zero-Data-Retention requirement, an optional
  strict "keys required" mode, and credential selection (workspace Models account > workspace/org
  BYOK > platform-funded OpenAI) before any provider is contacted, and denials return HTTP 403 with
  stable machine codes.
- Provider keys are AES-256-GCM encrypted at rest with a deployment-owned wrapping key, validated
  live against the provider before they are stored, and only ever surfaced as a 12-character
  fingerprint. Models accounts are additionally recorded as hash-chained receipts.
- Spend is pre-authorized: every platform-funded or paid-seat turn reserves an estimated amount
  before the model runs, settles to actual cost afterwards, and is refused (HTTP 429) when the $5
  signup credit, the seat's cycle budget, or an admin-set organization cap is exhausted.
- Every turn produces a usage row (tokens, model, cost, BYOK flag), a structured request log, and,
  for direct answers, a receipt carrying the same analytics; the Usage page summarizes tokens, credit
  and top model for the signed-in user over 31 days.
- Executable providers today: OpenAI (platform-funded or your key) and Anthropic (your key, chat
  only). The provider gallery lists 32 providers and the catalog 75 models; the other tiles and the
  non-OpenAI/Anthropic models are catalog previews.

**Avoid claiming**

- "Route all LLM traffic": there is no proxy, OpenAI-compatible endpoint, or SDK entry point; only
  Receipt's own product surfaces are covered.
- "Playground": the page is a heading.
- "Require organization provider key" as a control; rate-limiting / budget / logging / tool-approval
  rules on the Policies page; guardrails on chat traffic; per-organization or per-key rate limits;
  any token budget; "intelligent" rate limiting (it is a fixed 60 s window per user, and it is off
  when `VITE_DISABLE_REDIS=true`).
- Full-request audit logs: no prompts or completions are stored outside the chat thread itself;
  policy changes are not versioned; router calls are folded into the turn.
- Model choice in chat (the picker is not mounted; the default model is `openai/gpt-5.6-luna`).
- Study Mode enforcement until 4.4 is fixed; Anthropic on the BYOK page (hidden) or in Factory
  (unsupported); AWS/Azure/Vertex/Databricks/Snowflake account fields (collected, never saved).
- Organization-wide usage totals (the page is per user); a "Billing & Credits" page.

**Suggested page split**

1. *Model Gateway overview* — what it is (in-process checkpoint), what executes today, the rail and
   the Models page, the 32-tile gallery with an explicit "preview vs. connected" legend.
2. *Connecting a provider (Models accounts)* — the three-step wizard, access levels, workspace
   scoping, validation errors.
3. *Bring your own key* — org-global vs. workspace LLM keys, encryption, validation, ZDR dialog,
   precedence table, `CHAT_REQUIRE_BYOK`, rotation warning.
4. *Provider and model policy* — provider toggles, model controls (with each screen's toggle
   semantics), ZDR, machine reasons and user-facing errors; a clearly labelled "not yet enforced"
   note for the org-key flag.
5. *Usage, credit and limits* — $5 credit, reservations, seat budgets, admin caps, per-user rate
   limit and its Redis caveat, Usage page fields, cost visibility rules.
6. *Self-hosting the gateway* — env var table and failure modes.

**Marketing claims**

| Claim | Status | Reason |
|---|---|---|
| Route all LLM traffic through a single, policy-enforcing checkpoint | partial | One checkpoint exists (`ModelPolicyService` + `ModelGatewayService`, plus Factory funding), but it covers only Receipt's own chat/Factory/title/embedding calls; there is no external endpoint, and only OpenAI/Anthropic execute (section 8, 3.2). |
| Real-time policy enforcement blocks non-compliant requests before they generate costs | partial | Provider/model/ZDR denials and strict-key mode fire before reservation and before the provider call (3, 4.1); but the org-key flag, Policies rules, and guardrails are inert, and Study Mode enforcement currently breaks requests (4.3-4.4, 7.4). |
| Unified audit trail tracks every LLM request | partial | Every turn yields a usage row, a metadata-only wide event, and (for direct answers) a receipt (7.7); there is no request/response body log, policy edits are unversioned, router sub-calls are not itemized, and the only UI is a per-user 31-day summary (7.6). |
| Intelligent rate limiting and token budgets prevent runaway spending | partial (rate limiting), unsupported (token budgets, "intelligent") | Fixed-window 30/min per user, disabled under the shipped `VITE_DISABLE_REDIS=true` (3.6); dollar budgets are real and pre-authorized but BYOK bypasses them (7.3); no token budget exists (7.4). |

---


################ F-catalog-agent-registry :: Documentation implications ################
## Documentation implications

### Suggested page split

1. **Agent Registry** (new page, most of the content above): what it discovers, per-provider resource tables, how to connect (dedicated `agent-registry` connection; credentials in Nango), permissions to grant, region/subscription scope, the scan lifecycle and receipts, autonomy and risk definitions, the compliance register fields and their honest gaps, the dashboard, roles, and a clear "what it does not do" box.
2. **Integrations (connector catalog)**: the ~900-entry directory vs 63 connectable connectors, filters actually visible (search, category chips, All/Connected/Available/Popular), Load more, connect/disconnect, "Manage tools and permissions" allowlist, org vs workspace scope, and "Build {name} with Beetle Tasks" as a development-task request.
3. **Skills**: link to the lifecycle page owned by the other agent; on the Catalog page only the table, statuses, versions, and bundle facts.
4. **Usage visibility**: a short subsection pointing to Org Brain ("Application usage across the organization", "Connected apps") and the MCP Gateway "Gateway activity" dashboard, with the "Not recorded" convention.
5. Do **not** include Knowledge (hidden RAG store) or "Plugins" (nothing exists).

### Marketing claim matrix

| Claim | Verdict | Reason |
|---|---|---|
| "One governed registry for approved connectors, skills, and plugins" | **unsupported** | Three separate surfaces, no plugins, no approval state anywhere (§1, §3.6, §4, §7). Say "a connector catalog, an organization skills library, and an agent inventory" instead. |
| "with clear ownership" | **partial** | Agents: owner is read from cloud tags/CloudTrail and shown ("Unowned" otherwise) but cannot be assigned. Connections and skills store a creator id that the UI does not show as an owner. |
| "dependencies" | **unsupported** | No dependency model or graph exists. |
| "access controls" | **partial** | Owner/admin vs member gating on every surface, and a per-connection read/write operation allowlist ("Manage tools and permissions"). No finer roles. |
| "usage visibility" | **partial** | Org Brain shows objectives per application and connection readiness over 30/60/90 days; the gateway dashboard shows tool calls, success rate, response time, actors. Nothing for skills usage or per-agent usage. |
| "Centralized registry with automated approval ensures only vetted connectors reach production" | **unsupported** | No approval automation or vetting flag; connectors are either in the checked-in runtime catalog (connectable) or display-only, and connecting one is a direct owner/admin action. "Request an integration" files a code task. |
| "Clear accountability with role-based access rules" | **partial** | Role-based rules exist (owner/admin/member); "accountability" is only the receipt trail (every scan, skill, and connection event is a receipt with an actor) — say "audit trail", not "accountability workflow". |
| "Real-time visibility into connector dependencies" | **unsupported** | No dependency visibility at all. |
| "… adoption patterns" | **partial** | Org Brain adoption by application; gateway activity by tool/connector/actor; polled every 30 s or on demand, not real-time push. |
| "… and security posture" | **partial** | Agent Registry risk levels, ISM findings, wildcard-permission detection for three AWS resource types; connection validity counts. Heuristic, best-effort, AWS-weighted; no posture scoring for connectors or skills. |

### What to claim (safely)

- "Discover AI agents and agent-like workloads across connected AWS, Azure, and Google Cloud accounts; every scan is recorded as a receipt."
- "Classify autonomy (L2-L4 in practice) and risk; see who owns each agent according to cloud tags, and which have no owner."
- "For AWS Bedrock Agents, Lambda, and Step Functions, read the execution role's IAM policies to list reachable services, permission counts, wildcard grants, and named data stores."
- "A dedicated, read-only scoped `agent-registry` connection keeps discovery credentials separate from the organization's general integrations."
- "Global Integrations: a ~900-entry directory with about 60 connectable connectors; per-connection allowlists for read and write operations; organization-wide or workspace-scoped."
- "Organization skills: versioned SKILL.md bundles with enable/disable and receipt-backed history."

### What to avoid claiming

- "Register", "approve", "vet", "certify", or "promote" agents or connectors; any "workflow".
- "Dependencies", "dependency graph", "plugins", "marketplace".
- "Real-time"; use "refreshes automatically every 30 seconds" (Org Brain) or "on demand".
- "L1 Observe" agents exist (nothing produces L1).
- "Last used" as usage telemetry (it is a provider modification timestamp).
- "Credential type" as per-agent introspection (it is a per-provider constant).
- Specific ISM control numbers or names without product-owner confirmation of the framework being referenced.
- Permissions/data access for AgentCore, ECS, EC2, GCP, or Azure agents (explicitly unimplemented).
- The auth-method and "Show connected only" filters on Integrations (hidden).

---


################ G-guard :: Documentation implications ################
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


################ H1-core-identity-config-deploy :: Documentation implications ################
## Documentation implications

**Claim freely (supported):** email + password accounts with 8..128-character passwords; cloud email-OTP verification (6 digits, 5 minutes, 5 attempts) and OTP-based password reset; up to 10 concurrent sessions with revocation from Settings; organizations auto-created at signup, up to 10 per user, owner/admin/member roles; batched invitations (10 per dialog) with 48-hour expiry and seat capacity enforcement; a per-deployment free seat ceiling via `RECEIPT_DEFAULT_FREE_SEAT_COUNT`; a Default workspace per organization plus named workspaces reachable to every member; a self-hosted mode with a token-claimed first admin, invite-only default signup, SMTP invitations, and no Stripe; encrypted BYOK keys and Connect bundles with a stable-key requirement; three local run modes with the exact port map; health endpoints; two AWS topologies; forward-only checksummed migrations; immutable production releases.

**Do not claim:** a "Sign in with Google" button (hidden, no UI); two-factor authentication as a user-enrollable feature (stubbed); passkeys (stubbed string only); SSO, SAML, verified domains, SCIM (stubbed page); a UI to change the self-hosted signup policy (absent); console-printed dev OTPs (`AUTH_DEV_EMAIL_OTP_TO_CONSOLE` is dead); `AI_GATEWAY_API_KEY`/`ANTHROPIC_API_KEY` as required configuration; `OPENAI_API_KEY` as the way to enable chat (BYOK rows are); a `local:down` command; hot reload under `local:up`; a `seed:dummy-chats` script; Docker Compose for the whole product; Qdrant or the markdown worker as part of the AWS topology; key rotation.

**Marketing claims evaluated** (no explicit claim list was supplied; these are the claims made by `README.md`, the pricing catalog, and the landing copy):

| Claim | Status | Reason |
|---|---|---|
| "Better Auth for auth, organizations, invitations, and roles" (README) | supported | section 1, 3 |
| "Stripe + Resend for billing and email flows" (README) | partial | Stripe is cloud-only and requires both keys; email is provider-selectable (`resend|ses|smtp`) and production deploys require SES |
| "PostgreSQL + Redis for persistence and stream continuity" | supported | `REDIS_URL` for rate limits and stream resume; in-memory fallback exists |
| "Qdrant for vector search/RAG workflows" | partial | wired behind `VITE_ENABLE_EMBEDDING`, but hosted builds hardcode it off and no Qdrant is provisioned |
| "One-command deploy" of the listed services (README) | partial | the service list is stale (no `receipt-zero-cache` service; two Zero services, four runtime role services, Teams omitted); several guards and a Nango two-pass deploy are required |
| Free plan "Single-member workspace" / `includedSeats: 1` | unsupported | enforced default is 5 seats (overridable) |
| Plus/Pro/Scale features "SAML SSO", "Verified domains", "Directory provisioning" | unsupported | stubbed UI, no implementation |
| "Self-hosted ... Unlimited usage" | supported | usage policy disabled and 100000 seats in self-hosted mode |
| "ZDR (Zero Data Retention) compliance at provider level" | partial | an organization compliance flag that filters models by catalog metadata; not an infrastructure control (prior corpus 09 §7.7, unchanged) |
| Landing "Audit-friendly agents that improve every run" | n/a | product positioning, outside this report's scope |

**Suggested page split:** `accounts/sign-in-and-sign-up`, `accounts/security-and-sessions`, `organizations/overview-and-roles`, `organizations/members-and-invitations`, `organizations/seats-and-plans`, `workspaces/overview` (brief, link to part 2), `configure/environment-reference` (section 6 verbatim), `configure/keys-and-rotation`, `develop/prerequisites-and-bunw`, `develop/run-modes-and-ports`, `develop/database-and-zero-publication`, `develop/validate-stack-and-mock-llm`, `develop/troubleshooting`, `deploy/topologies`, `deploy/self-hosting-aws`, `deploy/single-host`, `deploy/domains-tls-email-storage`, `deploy/health-and-observability`, `self-host/setup-wizard-and-signup-policy`, `architecture/core-services` (section 11 as the diagram source).

---


################ I-receipt-cli :: Documentation implications ################
## Documentation implications

**What to claim (supported by code and observed behaviour).**

- One-line install with checksum verification into `~/.local/bin`; macOS/Linux, arm64/x64; not on npm; re-install upgrades in place without signing out.
- The hosted origin is built in; a fresh install needs no configuration; `receipt doctor` is read-only and safe to run before signing in and in CI (exit code gates).
- `setup`/`login` reuse a live session, refuse an expired one, and make the chosen target active; `logout` removes it; the token lives 12 hours.
- `connect status|disconnect|<provider>` and `connect list|tools|call` work from the saved session; env identity wins for the agent surface; a saved token is only ever sent to its own gateway; one automatic re-login on 401.
- `workspace use` is the only command that re-scopes the token; connections and tool lists follow the token's workspace.
- MCP: Codex install/status/remove with backup and rollback; generic config for other clients; the config never contains the token; `mcp serve` is a stdio bridge to `POST /connect/mcp`.
- Import/observe: two sources, upload by default after sign-in, `--local-only` to stay local; launchd/systemd background observer for `clauden`.

**What to avoid claiming.**

- That `receipt setup` onboards providers (it does not), that the onboarding menu works for every entry (it does not), or that the CLI can name a connection (it cannot).
- That metadata mode redacts prompts from what is uploaded (only the raw payload is redacted; the normalized receipt carries prompt and tool text).
- That the installer installs the Claude observer companion, or that preview.7 bundles it.
- That `--help` works on every subcommand, or that `receipt` alone prints help.
- That `receipt whoami` or `--version` exist on both binaries (only `whoami` on the developer CLI; only `--version` on the public one).
- Any specific tool names, workspace ids, or connection counts.

**Suggested page split.** Keep the existing eight pages (`overview`, `install`, `setup`, `doctor`, `workspaces`, `connect`, `tools-and-mcp`, `observe-claude-code`) and (a) add a `connectors` reference page generated from the table in §4.15 so the 63 ids stop being inlined into prose; (b) add a short `environment-and-exit-codes` page from §5-6; (c) add a `troubleshooting` page from §7; (d) move the "Developer CLI (from source)" material (§8) to its own page under the repo tab, cross-linked from `overview`, and keep it explicit that `doctor` means two different things.

**Marketing-style claims found in the public README and help text, assessed** (no separate list of marketing claims was supplied with this task):

| Claim | Status | Reason |
|---|---|---|
| "works out of the box" on a fresh machine (README) | supported | baked origin verified under `env -i`; `doctor` ok; release published |
| "Your saved sessions in `~/.receipt` are kept" on upgrade (README) | supported | installer touches only the binary |
| "`receipt doctor` … never opens a browser and never prints your token" (README) | supported | `runDoctor` makes two GETs; tests assert no token in output |
| "The hosted Receipt origin is built into the binary, so there is nothing to configure" (README) | supported | §2.2 |
| "The saved token lasts 12 hours. When it expires, `receipt setup` notices and signs you in again" (README) | supported | JWT TTL 12h; expiry check in `setup` |
| "Receipt stores only encrypted org-scoped connection references" (README) | partial | true for Nango references per `docs/receipt-cli.md:82-84`; not verified in this report beyond the CLI, and the CLI session file itself stores a plaintext token |
| "Shows only non-secret metadata before anything is stored" (help item 5) | partial | `connect status` prints account id / principal ARN / expiry only; but the `Open:` link contains a Nango session token, and observe uploads prompt text |
| "Installs the local Claude observer in the background when bundled" (help item 7) | partial | code path exists; no current release bundles the companion and the installer would not install it if one did |
| "Lets you connect <63 providers> through Nango" (help item 4) | partial | all 63 ids are accepted; `oauth2`/`custom` connectors require the deployment's Nango integration to be configured, which the CLI cannot verify |
| "`receipt connect` lets a signed-in user connect … Confluence through Receipt's hosted Nango-backed Connect flow" (README) | supported | `connect <provider>` → `/connect/nango/sessions` |

---

