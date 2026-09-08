# Receipt — LLM Gateway ("Model Gateway") research report

Repo: `<repo>`, git HEAD `c3c16be6` on `main`
(2026-09-07). Prior corpus at commit `41baea75` (2026-09-04, 43 commits earlier) was used as a
map only; every claim below was re-read at HEAD. Paths are repo-relative; `path:line` cites the
checked-out source. No file in either repository was modified.

Positioning under test: "Route all LLM traffic through a single, policy-enforcing checkpoint that
prevents costly failures and compliance breaches. Real-time policy enforcement blocks non-compliant
requests before they generate costs. Unified audit trail tracks every LLM request. Intelligent rate
limiting and token budgets prevent runaway spending."

---

## 0. Executive shape and classification

The "Model Gateway" is not a network proxy. It is an in-process layer inside the web app's chat
backend (`ModelPolicyService` -> `ModelGatewayService` -> Vercel AI SDK `streamText`) plus a parallel
credential-resolution path inside the Factory runtime (Codex CLI in a sandbox). Nothing outside
Receipt's own chat, title-generation, embedding, and Factory code paths can send an LLM request
through it: there is no OpenAI-compatible endpoint, no `/v1/*` route, and no proxy (section 8).

| Feature | Classification | Evidence |
|---|---|---|
| "Model Gateway" sidebar area (rail icon, "Models", "Playground") | Implemented and reachable | `apps/start/src/components/model-gateway/model-gateway-nav.config.tsx:25-44`; registered at `apps/start/src/components/layout/sidebar/app-sidebar-nav.config.tsx:122` |
| `/model-gateway` (area root) | Stubbed: renders an empty layout (no index child) | `apps/start/src/routes/(app)/_layout/model-gateway/route.tsx:19-23`; only `route.tsx` and `playground.tsx` exist under that folder |
| `/model-gateway/playground` | Stubbed or inert: a heading "Playground" and nothing else; no model call, no usage, no receipt | `apps/start/src/routes/(app)/_layout/model-gateway/playground.tsx:9-17` |
| `/organization/settings/models` provider gallery (32 tiles) and "Models accounts" wizard | Implemented and reachable (via the Model Gateway rail); only OpenAI and Anthropic tiles execute | `model-gateway-catalog.ts:29-38`, `models-page.tsx:163-537` |
| `/organization/settings/models/$providerId` (per-manufacturer model toggles) | Implemented; reachable only via the "View all models" link on Provider policy (direct URL otherwise) | `provider-controls-section.tsx` link; `provider-models-page.tsx:59-79` |
| `/organization/settings/provider-policy` | Implemented but hidden (direct URL only; not in the org settings nav list) | `-organization-settings-nav.ts` has no `provider-policy` item; route exists at `routes/(app)/_layout/organization/settings/provider-policy` |
| `/organization/settings/compliance-policy` | Implemented but hidden (direct URL only) | same file; route exists |
| `/organization/settings/byok` | Implemented and reachable (rail item "BYOK"); renders OpenAI only | `-organization-settings-nav.ts:214-218`; `apps/start/src/lib/shared/byok/provider-meta.ts:30-37` |
| Workspace "LLM keys" tab (MCP Gateway workspace page) | Implemented and reachable | `apps/start/src/components/organization/settings/mcp-gateway/mcp-gateway-workspace-page.tsx:39,110,202-212` |
| Chat composer model picker and reasoning picker | Implemented but not mounted (components exist, nothing renders them) | `apps/start/src/components/chat/prompt-input/prompt-input-toolbar.tsx:87,113,170` (`afterAttach` slot unused); only `chat-input.test.tsx` references `ModelSelectorPanel` |
| Provider/model deny lists, ZDR flag, `CHAT_REQUIRE_BYOK` | Implemented and enforced server-side (HTTP 403) | `apps/start/src/lib/backend/chat/services/model-policy.service.ts:209-223,253-427` |
| "Require organization provider key" flag | Stubbed or inert (stored, toggle in UI, never read on the request path) | `apps/start/src/lib/shared/ai-catalog/compliance-map.ts:13-21` |
| "Enforce Study Mode" | Implemented, but at HEAD it pins a model no executable route can serve (every chat turn fails with a 502) | `apps/start/src/lib/shared/chat-modes/registry.ts:11`; `providers/openai.ts:569-571`; `model-gateway.service.ts:110-118` |
| Policies page rate limiting / budget limiting / logging config | Stubbed or inert (persisted as receipts, no consumer) | `apps/start/src/lib/shared/policies.ts:9-13` (unchanged since map; re-verified no consumer) |
| Guardrails in the chat path | Stubbed or inert (service exists, nothing calls it from chat) | `guardrail-enforcement.service.ts:1-12` vs. grep: only `guardrails.server.ts:95` imports it |
| Per-user request rate limit (30/min) | Implemented, but switched off entirely when `VITE_DISABLE_REDIS=true` | `chat-runtime.ts:30-34`; `rate-limit.service.ts:153-161` |
| Dollar budgets (platform credit, per-seat cycle, org monthly cap) | Implemented and enforced before the model call, bypassed for BYOK | `reservation-store.ts:60-65,346-686` |
| Token budgets | Absent | no code path caps tokens per org/user; only `maxOutputTokens` per call |
| Per-request usage/cost ledger | Implemented (`org_usage_event`, `org_monetization_event`, credit ledger) | `settlement-store.ts:30-175` |
| Receipt for a model call | Implemented for direct chat answers (`response.finalized` carries analytics) | `apps/start/src/lib/backend/receipt/chat-bridge.ts:308-345` |
| Request/response body logging | Absent (wide event logs metadata only; "Logging config" UI inert) | `wide-event.ts:50-107,250-310` |
| OTLP export | Implemented, opt-in via `EFFECT_OTLP_BASE_URL` | `server-observability.layer.ts:85-86,116-129` |
| External OpenAI-compatible or proxy endpoint | Absent | `apps/start/src/routes/api/*` listing (section 8) |
| Singularity (`/singularity`) | Implemented but hidden behind one hard-coded organization id | `apps/start/src/ee/singularity/shared/singularity.ts:1-7` |

---

## 1. UI surfaces

### 1.1 The Model Gateway rail area

`modelGatewayNavArea()` returns title **"Model Gateway"**, description **"Manage models and try them
in the playground"**, icon `Cpu`, and two items: **"Models"** (icon `Boxes`) and **"Playground"**
(icon `Play`) (`model-gateway-nav.config.tsx:25-44`). The "Models" item does not point at
`/model-gateway/models`; it points at `ORG_MODELS_HREF` = `/organization/settings/models`
(`model-gateway-nav.config.tsx:19`, `-organization-settings-nav.ts:42`). The source comment explains
why: the gateway "briefly had its own /model-gateway/models route, but it was a stub holding models
in component state - nothing it saved survived a reload - and it shadowed the working page"
(`model-gateway-nav.config.tsx:12-18`). `isModelGatewayPath` matches both `/model-gateway` and
`/organization/settings/models` (`:22-23`), and `getCurrentArea` resolves either to the
`model-gateway` area (`app-sidebar-nav.config.tsx:156`). The duplicate `organization-models` org
settings item is kept only for route resolution and is `hiddenFromRail: true`
(`-organization-settings-nav.ts:286-291`; RCA-484 at `docs/agent-fix-checklist.md:19510-19533`).

### 1.2 `/model-gateway` and `/model-gateway/playground`

The `/model-gateway` layout redirects anonymous or signed-out users to `/chat`, shows a
`LoadingState` labelled **"Loading model gateway"** while auth resolves, then renders `<Outlet />`
(`model-gateway/route.tsx:9-23`). There is no index route, so `/model-gateway` itself renders an empty
column. `/model-gateway/playground` is the whole of `PlaygroundPage`: a `<div className="p-6">` with an
`<h1>` reading **"Playground"** (`playground.tsx:9-17`). It has no form, no model selector, no
request, no usage recording, and no receipt. Classification: stubbed.

### 1.3 `/organization/settings/models` — provider gallery

Component `ModelsPage` (`apps/start/src/components/organization/settings/model-policy/models-page.tsx:163`).

- Title: `m.org_models_page_title()` = **"Models"** (`apps/start/messages/en.json:457`). Description
  is hardcoded: **"Connect model providers, choose workspace models, and manage organization-level
  access."** (`models-page.tsx:221`). The workspace badge is suppressed (`hideWorkspaceBadge`, `:222`).
- Two local tabs in a `TabList` labelled "Models sections": **"Models"** (`Box`) and **"Custom
  Endpoints"** (`Server`) (`:230-245`). Since 41baea75 these use the shared `Tab`/`TabList`
  components instead of hand-rolled `role="tab"` buttons (commit `46652e84`); strings are unchanged.
- Models tab controls: search `placeholder="Search providers"` / `aria-label="Search providers"`
  (`:255-256`), and a **"Filter"** toggle button (`aria-pressed`) that hides non-executable tiles
  (`:259-265`, filter at `:180-191`).
- Empty/add state: heading **"Start adding your Models here"**, sub-copy **"Configure a provider
  account, then choose the models available to this workspace."** (`:311-317`); when accounts exist,
  a **"Back to connected providers"** button (`:325-331`).
- Gallery tiles: `aria-label="Configure {name}"`, tooltip `title` = `"{n} models"` or
  **"Catalog preview"** when the tile maps to zero catalog models (`:138-146`). No-match state:
  **"No providers found"** / **"Try another search or clear the filter."** (`:120-123`).
- Connected view: rail heading **"Connected providers"**, then **"Add other providers"** with an
  **"Add new models"** button (`:346-396`); pane heading **"{Provider} Accounts"** with
  **"{n} configured models"** (`:404-409`); buttons **"Add {Provider} Account"** (`:412-414`),
  **"Copy FQN"** (`aria-label="Copy provider FQN"`, copies `"{providerId}/{accountName}"`,
  `:426-436`), **"Add model"** (`:437-442`), **"Edit"** (`:443-449`); account sub-label
  **"Models provider account"** (`:421-423`).
- Table columns: **Model / Type / Input / 1M / Output / 1M / Latency / Actions** (`:455-462`); empty
  row **"No models available for this provider."** (`:466-471`); per-row actions
  `aria-label="Copy {name} model ID"` and `aria-label="Configure {name}"` (`:494-511`).
- Custom Endpoints tab: heading **"Custom endpoints"**, body **"Add an OpenAI-compatible or
  self-hosted inference endpoint and then select the models it exposes."**, button **"Add custom
  endpoint"** which opens the `self-hosted` tile's dialog (`:279-301`). Because `self-hosted` is
  `adapter-required` (`model-gateway-catalog.ts:472-480`), that dialog cannot be saved (1.4).

Provider catalog (`model-gateway-catalog.ts:188-481`): exactly **32 tiles**, asserted by
`model-gateway-catalog.test.ts:11`. In declaration order: AWS Bedrock, Google Vertex, Google Gemini,
Azure OpenAI, Azure AI Foundry, Microsoft Foundry, OpenAI, Databricks, Cloudera, Cohere, Snowflake
Cortex, OpenRouter, AI21, Anthropic, AWS Claude Platform, AWS Bedrock Mantle, DeepInfra, Groq,
Mistral AI, ElevenLabs, Deepgram, Cartesia, Smallest AI, Perplexity AI, Together AI, xAI, Baseten,
SambaNova, AWS SageMaker, Cerebras, Wafer, Self-Hosted Model. Credential modes (`:4-7`): 2 tiles are
`optional-api-key` (OpenAI, Anthropic), 21 are `managed`, 9 are `adapter-required` (Cohere, AI21,
ElevenLabs, Deepgram, Cartesia, Smallest AI, Perplexity AI, Wafer, Self-Hosted Model). The
`adapter-required` tiles have `catalogProviderIds: []`, so they show "Catalog preview" and an empty
model list.

Executability is a hard-coded two-provider check:

```ts
export function isModelGatewayProviderExecutable(provider) {
  return provider.id === 'openai' || provider.id === 'anthropic'
}
```
(`model-gateway-catalog.ts:34-38`; comment at `:29-33`: "Every other provider remains a clickable
catalog preview until its runtime adapter lands.") The server refuses the other 30 with
**"This provider is a catalog preview and cannot be configured yet."**
(`apps/start/src/lib/frontend/model-provider-accounts/model-provider-accounts.server.ts:69-73`); the
store has its own guard, **"This provider is a catalog preview and has no executable runtime adapter
yet."** (`model-provider-account-store.ts:253-257`); and the dialog throws the first string
client-side before calling the server (`provider-setup-dialog.tsx:172-176`).

Model rows per tile come from `catalogProviderIds` mapped onto `AI_CATALOG` (`getGatewayProviderModels`,
`:497-519`); `openrouter` uses `['*']` = the whole catalog (`:295`, test `:37-38`). Displayed
**Type** is `Reasoning` / `Multimodal` / `Chat` (`:509-513`); **Input / Output per 1M** is
`pricing.*PerToken * 1e6` as `$X.XX` with `.00` stripped, or `—` (`:483-488`); **Latency** is a
heuristic: `≈ 3–8s` for reasoning models, `≈ 2–6s` for >= 1M context, else `≈ 0.8–3s`
(`:490-494`). Docs must present latency as an estimate.

### 1.4 The provider setup wizard

`ProviderSetupDialog` (`provider-setup-dialog.tsx:88`) is a right-anchored full-height dialog titled
**"Set up {Provider} and manage models"** with the tile description as subtitle (`:207-212`). Steps
(`:60-67`): **"Configure account"**, **"Model selection"**, **"Access control"**, then a success
screen.

Step 1 ("account"): label **"Account display name *"** with badge **"Models account"** and helper
**"This account belongs to Models. It is not the organization API Keys setting."** (`:253-260`);
section **"Authentication"** with the tile's `setupHint` and a badge reading **"Catalog preview"** or
**"Models account"** (`:271-280`); one input per `accountFields` entry, labelled `"{label} *"` or
`"{label} (optional)"`, password fields get a reveal toggle, inputs disabled for non-executable tiles
(`:283-315`); footer note **"Credentials are authenticated, encrypted, and stored only in the Models
account."** or **"This tile is informational until its executable runtime adapter is available."**
(`:317-322`). Button **"Continue to model selection"** is enabled only when the tile is executable,
the name is non-empty, and every required field is filled (`:149-156, 603-605`).

Provider-specific fields (`model-gateway-catalog.ts:82-167`):
- AWS family (`aws-bedrock`, `aws-claude-platform`, `aws-bedrock-mantle`, `aws-sagemaker`):
  **"AWS region"** (`us-east-1`), **"AWS access key ID"** (`AKIA…`), **"AWS secret access key"** (password).
- `google-vertex`: **"Google Cloud project ID"** (`my-project`), **"Vertex AI location"** (`us-central1`),
  **"Service account JSON"** (password, full-width).
- `google-gemini`: **"Gemini API key"** (`AIza…`).
- Azure family (`azure-openai`, `azure-ai-foundry`, `microsoft-foundry`): **"Azure endpoint"**
  (`https://…azure.com`), **"Azure API key"**.
- `databricks`: **"Workspace URL"** (`https://…cloud.databricks.com`), **"Personal access token"** (`dapi…`).
- `snowflake-cortex`: **"Snowflake account identifier"** (`org-account`), **"Programmatic access token"**.
- `self-hosted`: **"Inference endpoint"** (`https://models.example.com/v1`), optional **"Authentication token"** (`Optional token`).
- `openai`: **"OpenAI API key"** (`sk-…`); `anthropic`: **"Anthropic API key"** (`sk-ant-…`) (`:251, 315-317`).
- Everything else: **"{Provider} API key"** with placeholder **"Enter provider API key"** (`:159-166`).

Setup hints (`:174-178`): adapter-required tiles say **"This Models account form is a catalog preview.
Durable account storage and execution require a reviewed runtime adapter."**; all others say
**"These connection details belong to the Models provider account and are separate from organization
API Keys."** Only `accountValues.apiKey` is ever sent to the server (`:180`); the AWS/Vertex/Azure
fields are collected but discarded because those tiles cannot reach save.

Step 2 ("models"): **"Select models"** with **"{n} selected · per 1M tokens · approximate latency"**,
**"Select all"** / **"Clear all"**, search `placeholder="Search models"` (`:331-363`); empty state
**"Runtime adapter required"** / **"This provider remains non-actionable until Receipt can validate
its credentials and execute its models end to end."** (`:371-377`); table heads Model / Type /
Input / Output / Latency (`:388-394`); button **"Continue to access control"** (`:608-610`).

Step 3 ("access"): **"Workspace access"** / **"Access follows Receipt's existing workspace roles."**;
**"Managers"** (**"Can manage provider accounts and model policy."**) with **"Owners and admins"** /
**"Owners only"**; **"Users"** (**"Can use policy-allowed models."**) with **"Workspace members"** /
**"Managers only"** (`:460-510`); defaults `owners-admins` / `workspace-members` (`:104-105`);
**"Review"** block with Provider / Models account / Models / Can use (`:514-536`); button
**"Save models"** / **"Saving models…"** (`:613-619`).

Success: **"{n} model(s) configured"**, **"The encrypted workspace Models account is ready for
chat."**, **"Canonical model ID"** / **"Use this ID in chat or agent configuration."** with a
**"Copy"** button and the first selected id in a `<pre>`, then **"Done"** (`:548-576, 621`).
Failure text defaults to **"The model selection could not be saved."** (`:190-194`).

### 1.5 `/organization/settings/models/$providerId` — per-manufacturer model toggles

`ProviderModelsPage` (`provider-models-page.tsx:34`) is a model-policy list for one catalog
manufacturer, not a provider-account page. Title is a back link **"Go back"** (`aria-label="Go back
to models"`, `:85-92`; `en.json:501-502`); form title is the manufacturer name from `PROVIDER_NAMES`
(`provider-constants.ts:10-22`: OpenAI, Anthropic, Google, Alibaba, DeepSeek, Meta, Mistral, MiniMax,
Moonshot, xAI, Z.AI); description **"Enable or disable models for this provider in your
organization."**; help **"Changes apply immediately. Disabled models are unavailable to the
organization."** (`en.json:500,503`); empty **"No models available for this provider."** (`:505`).
Each row's toggle is **checked = enabled**: `checked: !payload.policy.disabledModelIds.includes(model.id)`
(`:69`). The invisible description placeholder is `org_models_page_description` = "Manage providers
and models for your organization." (`provider-constants.ts:7-8`, `:94-98`). Layout route states: no
active org -> "Switch to an organization to manage organization-level provider and model policies."
and "Select an organization in the sidebar or switch context to manage policies."
(`models/route.tsx:20-31`; `en.json:508,510`).

### 1.6 `/organization/settings/provider-policy` — "Provider policy"

`ProviderPolicyPage` (`provider-policy-page.tsx:15-54`): title **"Provider policy"**, description
**"Configure provider and model restrictions and compliance flags for your organization."**
(`en.json:506-507`). Three sections:

(a) `ComplianceFlagsSection` (`compliance-flags-section.tsx:111-141`), three header-toggle cards:

| Title | Description | Help | Backing value |
|---|---|---|---|
| **"Require ZDR (Zero Data Retention)"** | "Only allow models from AI providers that do not retain data. This is enforced at the provider level." | "Applies immediately to model availability." | `complianceFlags.require_zdr` (`:35`) |
| **"Require organization provider key"** | "Only allow models from providers that have an active organization API key." | "Applies immediately to provider availability." | `complianceFlags.require_org_provider_key` (`:66-68`) |
| **"Enforce Study Mode"** | "Force organization chat requests to use Study Mode and lock the toggle." | "Applies immediately to new chat requests." | `enforcedModeId === 'study'` (`:99`) |

(`en.json:393-401`). The "Require organization provider key" card defaults to disabled without
feature-access state (`byokEnabled = featureAccess?.allowed ?? false`, `:54`); the other two default
to enabled.

(b) `ProviderControlsSection`: title **"Providers"**, description **"Enable or disable AI providers
for your organization."**, help **"Changes apply immediately. Disabled providers and their models are
unavailable to the organization."** (`en.json:472-474`); one row per catalog manufacturer with a
blurb from `PROVIDER_META` (`provider-constants.ts:28-64`, e.g. OpenAI: "Models including GPT-4o and
o1 for chat, reasoning, and tool use.") and a **"View all models"** link
(`aria-label="View all models for {providerName}"`, `en.json:475-476`) to
`/organization/settings/models/$providerId`. Toggle checked = enabled.

(c) `ModelControlsSection` (`model-controls-section.tsx:21-63`): title **"Model Controls"**,
description **"Override model availability per model. Disabled by provider or compliance policy is
shown in the description."**, help **"Changes apply immediately. You can override a provider-level
denial per model here."**, section header **"Models"** (`en.json:450-454`). Row description is
`"{modelId} · Disabled by: {sources}"` (`:43-50`). **Here checked = disabled**:
`checked: payload.policy.disabledModelIds.includes(model.id)` (`:51`) — the opposite of 1.5. Docs must
describe each screen's toggle semantics separately.

This page is not in the org settings navigation list (`-organization-settings-nav.ts` has no
`provider-policy` entry), so it is reachable by URL only. Visiting it as a non-owner/admin redirects to
`/` (`routes/(app)/_layout/organization/settings/route.tsx:31-38`;
`-organization-settings-access.ts:9-17`).

### 1.7 `/organization/settings/compliance-policy` — "Compliance & Policy"

`CompliancePolicyPage` (`compliance-policy-page.tsx:13-39`): title **"Compliance & Policy"**,
description **"Configure organization-level AI rules and access policies."** (`en.json:407-408`). It
renders only the same `ComplianceFlagsSection` as 1.6(a). Also URL-only.

### 1.8 `/organization/settings/byok` — "BYOK"

`ByokPage` (`byok-page.tsx:16-89`). Title **"BYOK"**; description **"Optional: use your
organization's encrypted provider keys instead of platform credit (Bring Your Own Key)."**
(`en.json:384-385`). Rail item name "BYOK", icon `Key` (`-organization-settings-nav.ts:214-218`).

Which providers render: `BYOK_SUPPORTED_PROVIDERS = ['openai', 'anthropic']`
(`apps/start/src/lib/shared/model-policy/provider-keys.ts:4`), but `BYOK_HIDDEN_PROVIDERS` contains
`anthropic` and `BYOK_PROVIDER_ORDER` filters it out (`provider-meta.ts:30-37`). **The page shows one
card: "OpenAI API Key."** The comment says hiding is presentation-only: stored Anthropic keys "stay
encrypted and the gateway keeps honouring them".

Card copy (`byok-form.tsx:108-117, 189-290`; `en.json:380-389`): title **"{Provider} API Key"**;
description **"Configured, new requests for this provider will use your org key."** or **"Not
configured, requests will continue using Receipt defaults."**; help **"You can get your {providerName}
API key"** + link **"here"** (OpenAI -> `https://platform.openai.com/api-keys`, Anthropic ->
`https://console.anthropic.com/settings/keys`, `provider-meta.ts:11-22`); placeholder `sk-...` /
`sk-ant-...`; button **"Save key"** or **"Remove key"** (danger style) when configured. A configured
key renders as the mask `••••••••••••••••••••••••••••••` in a disabled password input
(`byok-form.tsx:62, 210`). Success strings: **"Provider key saved successfully."** / **"Provider key
removed successfully."** (`use-byok.ts:46-47`). Load-failure banner: **"Organization API keys could not
be loaded. Refresh and try again."** (`byok-page.tsx:73`).

ZDR interaction: when `require_zdr` is on, saving opens a dialog titled **"Disable ZDR for this
provider?"**, body **"Your organization requires ZDR right now. Saving a {providerName} API key will
turn off ZDR enforcement for {providerName} requests that use your org key. Other providers keep their
current ZDR behavior."**, confirm **"Save key and disable ZDR"** (`byok-form.tsx:132-176`;
`en.json:390-392`). That is literally the engine's behaviour (section 4.2).

Scope: the page resolves `getOrganizationScopeWorkspaceId` and writes to the organization's hidden
global scope `ws_global_<md5(orgId)>` (`byok-page.tsx:17-46`;
`packages/receipt-app/src/services/receipt-workspaces.ts:164-167`). See 6.3 for why that matters.

### 1.9 Workspace "LLM keys" (MCP Gateway workspace page)

The same `ByokForm` is embedded as the **"LLM keys"** tab of a workspace's MCP Gateway page, bound to
`useByok({ workspaceId })` from the URL (`mcp-gateway-workspace-page.tsx:39,110,202-212`; page
description **"Connections, LLM keys, and access for {workspace}."**, `:151`). Keys saved there are
stored at `(organization, workspaceId, provider)`; RCA-455 states the intended rule: "An explicit
workspace must resolve exactly and must not fall back to a sibling or global key"
(`docs/agent-fix-checklist.md:18719-18745`).

### 1.10 Chat composer model and reasoning selectors — not mounted

`ModelSelectorPanel` and `ReasoningSelectorPanel` exist and are exported
(`apps/start/src/components/chat/composer-bar/index.ts`), but no production component renders them:
the toolbar's `afterAttach` slot (`prompt-input-toolbar.tsx:87,113,170`) receives nothing, and the only
other reference is `chat-input.test.tsx`. Consequently the user cannot choose a model. The default is
`DEFAULT_CHAT_MODEL_ID = 'openai/gpt-5.6-luna'` (`model-selector-policy.ts:18`), and even if mounted the
picker is restricted to `MODEL_SELECTOR_ALLOWED_PROVIDER_IDS = ['openai']` (`:9-11`;
`chat-context.tsx:1930-1934`). The ready-made strings are: trigger/aria **"Select model"**, search
**"Search models..."** / **"Search models"**, capability chips **Images / PDF / Reasoning / Tools**,
reasoning labels **None / Minimal / Low / Medium / High / Extra high / Max** (`en.json:214-256`).

### 1.11 Access control for these pages

Every `/organization/settings/*` page except MCP Gateway requires an organization role of `owner`
or `admin`; others are redirected to `/` (`-organization-settings-access.ts:9-17`; settings
`route.tsx:17-41`). Models accounts additionally require workspace mutation authority
(`requireReceiptWorkspaceMutationAuthority`) and, for `owners`-only accounts, workspace role `owner`:
**"Only workspace owners can manage this Models account."** (`model-provider-accounts.server.ts:64-88`).
BYOK writes require `requireOrgAuth` plus a workspace id (**"A workspace is required to manage provider
keys."**) and `requireReceiptWorkspaceMutationAuthority` (`apps/start/src/lib/frontend/byok/byok.server.ts:25-57`).
Policy writes go through Zero mutators whose server pass re-reads the `member` row and throws **"Only
workspace owners or admins can manage organization settings."** (`org-policy.mutators.ts:122-158`).

---

## 2. The model catalog

`AI_CATALOG` (`apps/start/src/lib/shared/ai-catalog/index.ts:74-86`) concatenates 11 manufacturer
files. Counted at HEAD (`grep -c "^    id: '" providers/*.ts`):

| Manufacturer file | Models | Route providers declared | ZDR true / false | Rows with `pricing` |
|---|---:|---|---|---:|
| `openai.ts` | 17 | 15 x `['openai', …]`; `gpt-oss-120b` = `['azure','gateway']` (`:571`), `gpt-oss-20b` = `['azure','gateway','openrouter']` (`:597`) | 15 / 2 | 17 |
| `anthropic.ts` | 10 | all `['anthropic','gateway']` | 10 / 0 | 10 |
| `google.ts` | 6 | all `['gateway']` | 6 / 0 | 6 |
| `alibaba.ts` | 5 | all `['gateway']` | 2 / 3 | 5 |
| `deepseek.ts` | 5 | all `['gateway']` | 3 / 2 | 5 |
| `meta.ts` | 2 | all `['gateway']` | 2 / 0 | 2 |
| `mistral.ts` | 10 | all `['gateway']` | 10 / 0 | 10 |
| `minimax.ts` | 3 | all `['gateway']` | 1 / 2 | 3 |
| `moonshotai.ts` | 3 | all `['gateway']` | 2 / 1 | 0 |
| `xai.ts` | 5 | all `['gateway']` | 0 / 5 | 5 |
| `zai.ts` | 9 | all `['gateway']` | 2 / 7 | 8 |
| **Total** | **75** | | 53 / 22 | 71 |

Only two route providers have an executable client at HEAD: `openai` (platform key or OpenAI BYOK)
and `anthropic` (Anthropic BYOK only) (`model-gateway.service.ts:95-138`). There is no `gateway`,
`azure`, or `openrouter` client. Therefore **25 of 75 catalog models can execute** (15 OpenAI + 10
Anthropic); the other 50 are visible in policy screens and provider tiles but any attempt to run them
fails with `Selected model does not support platform OpenAI routing: <id>` /
`Selected model does not support organization provider routing: <id>` (`:114-118, 125-129`), surfaced
to the user as **"The AI provider is currently unavailable. Please retry."** (502, section 3.5). Since
the composer cannot pick a model, in practice every chat turn uses `openai/gpt-5.6-luna` unless a
thread was created with another id.

Per-model fields (`types.ts:85-133`): `id` (`provider/model`), `providerId`, `name`, `description`,
`contextWindow`, `zeroDataRetention` ("True when the provider does not retain training data", `:93`),
`capabilities` (`supportsTools/Streaming/Reasoning/ImageInput/FileInput/PdfInput`, `:27-34`),
`providerToolIds`, `skipDefaultProviderTools`, `reasoningEfforts` (subset of
`none|minimal|low|medium|high|xhigh|max`, `:8-15`), `defaultReasoningEffort`,
`providerOptionsByReasoning`, `defaultProviderOptions`, `defaultMaxOutputTokens`, `requirements`,
`providers` (route ids), `providerModelIds` (per-route id overrides), and optional `pricing`
("aligned with Vercel AI Gateway /v1/models response", per-token USD strings, with tiers and
`webSearchPerRequest`, `:55-71`). OpenAI rows attach Responses-API options (`store: false`,
`serviceTier: 'auto'`, `textVerbosity: 'medium'`, `reasoningSummary: 'auto'`, `providers/openai.ts:7-35`).
Default provider-native tools are added when a row names none: OpenAI `web_search`,
`code_interpreter`; Anthropic `web_search_20250305`, `web_fetch_20250910`; Google `google_search`,
`url_context`, `code_execution` (`index.ts:23-29`).

Context windows: `resolveModelContextWindow` infers a cheaper "standard" window from the first pricing
input tier and exposes a distinct "max" mode only when `baseContextWindow < maxContextWindow`
(`context-window.ts:22-63`); default mode is `standard` (`:7`).

`ADDING_PROVIDER.md` describes the eight-step process (install `@ai-sdk/<provider>`, verify ids
against `https://ai-gateway.vercel.sh/v1/models`, add provider-tools metadata, add a models file,
append to `AI_CATALOG`, run tests and `tsc`). It is a catalog-and-policy recipe; it does not add a
runtime client, which is why a new manufacturer becomes visible but not executable.

Exposure to the UI: the catalog reaches the browser through `AI_CATALOG` imports (models page,
provider tiles, provider policy payloads via `/api/org/model-policy` and Zero). The comment at
`index.ts:70-73` calls the list "append-only in practice" — docs should not freeze counts.

---

## 3. Request flow (diagram-ready)

Nodes and edges for a diagram, in order, for `POST /api/chat`
(`apps/start/src/routes/api/chat/route.tsx:139-260` and
`apps/start/src/lib/backend/chat/services/chat-orchestrator.service.ts:225-1240`):

1. **Auth** — `requireAppUserAuth`; fail -> `Unauthorized` / `Organization context is required` (401)
   (`route.tsx:144-165`).
2. **Parse** — `Invalid JSON body`, `Validation failed` (400) (`:176-190`).
3. **Access policy** — `resolveAccessContext` reads the entitlement snapshot to get a plan id, then
   `resolveChatAccessPolicy` fixes the rate-limit window; `isFreeTierContext` is hard-coded `false`, so
   every request gets the paid limits and no free allowance (`access-control/index.ts:94-152`;
   `shared/access-control/index.ts:405-407`).
4. **Workspace** — `requireReceiptWorkspaceMembership(organizationId, body.workspaceId)`; a missing id
   resolves to the visible Default workspace `ws_<md5>` (`receipt-workspaces.ts:1034-1035`); fail ->
   `Workspace is unavailable` (401) (`route.tsx:212-241`).
5. **Org policy load** — `modelPolicy.getOrgPolicy` reads `org_ai_policy` via Zero (`repository.ts:77-91`).
6. **Rate limit** — `rateLimit.assertAllowed` (`chat-orchestrator.service.ts:305-310`; section 3.6).
7. **Mode + thread access** — `resolveEffectiveChatMode` (org-enforced > request > thread,
   `chat-modes/resolver.ts:14-50`), `threads.assertThreadAccess`.
8. **Model policy resolution** — `modelPolicy.resolveThreadModel` (`:369-383`; section 3.1 and 4).
   All 403 denials happen here, before any reservation or provider call.
9. **Free allowance** — only when `accessPolicy.allowance` exists (never, today) (`:401-420`).
10. **Tool policy** and **context window** — `estimatePromptTokens(messages) < activeContextWindow`
    else `ContextWindowExceededError` (413) (`:678-693`).
11. **Quota reservation** — `usageQuota.reserveChatQuota({ bypassQuota: Boolean(providerApiKeyOverride) })`
    (`:760-786`; section 7.3). Fails with 429 `QuotaExceededError` before the model call.
12. **Title generation** (first turn only) — detached, separately metered under `<requestId>:thread-title`
    (`:790-838`).
13. **ReceiptChatService.streamResponse** (`:1066-1075`) — inside it:
    a. a transient heartbeat every 10 s keeps the SSE stream warm (`receipt-chat.service.ts:104, 403-415`);
    b. **router call**: `generateText` with `CHAT_LAYER_ROUTER_SYSTEM_PROMPT`, `maxOutputTokens: 1_200`,
       the same resolved model and credential as the turn (`:105, 1712-1743`; prompt text at
       `packages/receipt-app/src/services/chat-layer-routing.ts:16-17`). Since 41baea75 the router may
       run a second "review" pass and fails closed with **"Receipt couldn't determine the access needed
       for this request. Please retry; no task was started."** (`chat-layer-routing.ts:459-505`);
    c. decision `chat` -> **ModelGatewayService.streamResponse** with `tools: {}`, `activeTools: []`,
       the profile system prompt, and OpenAI provider options (`:3605-3652`);
       decision `factory` -> enqueue a Factory job (Codex in a sandbox; section 6.5);
       decision `organization_skill` -> skill drafting.
14. **ModelGatewayService** — `sanitizeMessagesForModel`, `convertToModelMessages`,
    `resolveRuntimeModel`, `streamText` (`model-gateway.service.ts:213-248`).
15. **Stream finish** — usage and provider metadata from every call in the turn are summed by the
    accumulator (`generation-metrics-accumulator.ts:32-149`), converted to persisted analytics
    (`generation-metrics.ts:38-69`), written to the assistant message, then
    `usageSettlement.recordChatUsage` + `settleMonetizationEvent` (`chat-orchestrator.service.ts:983-1005`),
    and a receipt `response.finalized` carrying the analytics (`chat-bridge.ts:308-345`).
16. **Observability** — one wide event per request is logged and failures mirrored to PostHog
    (`wide-event.ts:250-310`; section 10).

### 3.1 Model id -> provider -> credential (precedence)

`resolveThreadModel` (`model-policy.service.ts:121-438`):

1. Candidate model = mode's fixed model > requested `modelId` > thread model; none -> reason
   `no_model_selected`; unknown id -> `unknown_model` (`:166-190`).
2. `getModelAccess` (always allowed on the current contract) (`:192-207`).
3. `evaluateModelAvailability` -> 403 `policy_denied:<provider,model,compliance>` (`:209-223`).
4. Reasoning effort: requested > thread > model default, validated against the model's list; `none`
   becomes undefined (`:225-246`).
5. **Workspace Models account** (needs `workspaceId` and `userId`): `resolveModelProviderAccountCredential`
   decrypts the account key if the row lists this model and the caller passes `member_access`;
   wins outright (`:278-317`; store `:350-398`).
6. **Short-circuit**: if `CHAT_REQUIRE_BYOK` is not `true` and the persisted `providerKeyStatus`
   snapshot (synced from the org-global scope) says `hasAnyProviderKey === false`, return with no
   override -> platform credit (`:319-332`).
7. **Org/workspace BYOK key**: candidates = `model.providers` filtered by
   `isByokExecutableProviderId` (`openai`, `anthropic`), in declared order; a provider marked `false`
   in the snapshot is skipped; the first key found at `(organizationId, workspaceId)` becomes
   `providerApiKeyOverride` (`:340-414`).
8. Otherwise no override -> platform credit; in strict mode -> 403 (`:416-437`).

The contract for the override: "runtime model execution must use this key and must not fall back to
system credentials" (`shared/model-policy/types.ts:88-95`).

### 3.2 What the "shared gateway" is

Despite the naming, there is no third-party AI gateway in the chat path at HEAD. `resolveRuntimeModel`
routes non-BYOK requests **directly to OpenAI with the server's `OPENAI_API_KEY`**
(`readPlatformOpenAiApiKey`, `packages/receipt-app/src/services/platform-openai-key.ts:10-14`) and
only for models whose `providers` include `openai` (`model-gateway.service.ts:101-119`). Failure
strings: `Platform-funded OpenAI access is unavailable: OPENAI_API_KEY is not configured.` (`:106-108`)
and `Selected model does not support platform OpenAI routing: <id>` (`:115-117`). BYOK requests use
`createOpenAI({ apiKey })` or `createAnthropic({ apiKey })` with the catalog-prefix-stripped model id
(`:121-137`; `ai-catalog/index.ts:110-130`).

`AI_GATEWAY_API_KEY` and `ANTHROPIC_API_KEY` appear in `apps/start/.env.example:120-124` ("Hosted
requests without a workspace BYOK key use AI Gateway...") but **no runtime code reads either**: the
only references are tests and a Factory projection that deletes `AI_GATEWAY_API_KEY` from the sandbox
env (`packages/receipt-app/src/services/factory/lima-auth-byok.ts:75`). RCA-404 (2026-08-14) records
the switch: "Direct OpenAI uses the server-only `OPENAI_API_KEY`; never install an OpenAI key as
`AI_GATEWAY_API_KEY`" (`docs/agent-fix-checklist.md:17240-17272`). `OPENAI_API_KEY` is not declared in
`apps/start/.env.example` at all; `docs/receipt-runtime-readme.md:151` lists it as a prerequisite.
"Gateway cost" fields in the cost code (`generation-metrics-accumulator.ts:88-128`,
`openai-api-cost.ts:156-170`) are vestigial branches for a `gateway`/`vercel` provider that is never
instantiated.

### 3.3 Streaming, tools, output caps, provider options

`streamText` is called with the system prompt (default **"You are a helpful assistant."**,
`model-gateway.service.ts:26`), the tool set and `activeTools` passed by the caller (direct chat
passes `{}` / `[]`; Receipt Connect tools run in Factory, not here), `providerOptions`,
`maxOutputTokens` = 12 000 for `high|xhigh|max` reasoning else 8 000 (`:229-234`), the request abort
signal, `smoothStream({ delayInMs: 15, chunking: 'word' })` (`:236-239`), and `onError: () => {}` so the
orchestrator's wide event is the only error sink (`:245-247`). For OpenAI the options are
`{ store: false, promptCacheKey, reasoningEffort }`; `max` is not forwarded to OpenAI (`:63-87`), and
prompt-cache keys over 64 chars are hashed to `receipt-cache-v1-<sha256 prefix>` (`:35-56`). Nothing
is added for Anthropic. SSE keep-alive comments are sent every 5 s (`sse-keepalive.ts:1`).

### 3.4 Retries and timeouts

- The chat gateway sets no `maxRetries`; the AI SDK default applies (no repo code overrides it in
  `apps/start/src/lib/backend/chat`). The one explicit override is the replay recap, which uses
  `maxRetries: 0` and a 20 s `AbortSignal.timeout` (`chat-receipts.server.ts:3446-3455`, added since
  41baea75).
- Assistant finalization is bounded by `Effect.timeout(Duration.seconds(30))`
  (`chat-orchestrator.service.ts:1035`); resumed-stream persistence by `RESUME_STREAM_PERSIST_TIMEOUT`
  = 20 minutes (`:85`). Detached tasks (title generation) use `runDetachedObserved` with a default
  timeout (`server-effect/runtime/detached.ts:21-25`).
- The Factory runtime's OpenAI adapter retries only rate-limit errors, `OPENAI_MAX_RETRIES` (default
  3) with `OPENAI_RETRY_BASE_MS` (default 500) exponential backoff capped at 8 s plus jitter and a
  process-wide backoff window (`packages/receipt-app/src/adapters/openai.ts:174-200`). Since 41baea75,
  `isPermanentModelAuthenticationError` marks 401 / `invalid_api_key` failures non-retryable in the
  objective supervisor (`packages/receipt-app/src/services/factory/model-error-retry.ts:1-11`;
  `objective-supervisor-runner.ts:429`).

### 3.5 Error mapping to the envelope

Envelope shape `{ ok:false, error:{ code, i18nKey, i18nParams?, requestId, retryable }, requestId,
telemetry:{ owner:'server' }, details:{ tag, message?, threadId?, ... } }`
(`apps/start/src/lib/shared/chat-contracts/error-envelope.ts:7-27`). Classification
(`apps/start/src/lib/backend/chat/domain/error-classification.ts`):

| Domain error | HTTP | code | i18n text (`en.json:318-340`) | retryable |
|---|---:|---|---|---|
| `RateLimitExceededError` | 429 | `error_chat_rate_limited` | "Too many requests. Please wait about {retryAfterSeconds} seconds and retry." | true |
| `QuotaExceededError` (`seat_quota_exhausted`) | 429 | `error_chat_quota_exceeded` | "This seat has exhausted its current AI usage allowance. Please wait until the monthly reset and try again." | true |
| `QuotaExceededError` (`platform_credit_exhausted`) | 429 | `error_chat_quota_exceeded` | "Your $5 platform credit has been used. Add an optional provider key in Billing & Credits to continue without platform credit." | true |
| `ModelPolicyDeniedError` | 403 | `error_chat_model_not_allowed` | "The selected AI model is not allowed for your organization." (default); `missing_provider_api_key` -> "This provider requires an organization API key, but no key is configured."; `model_not_supported_for_provider_key` -> "This model cannot be used with your organization provider API key. Choose another model from that provider or remove the provider key."; `free_tier_model_denied:` -> "This model requires a paid plan to use." | false |
| `ContextWindowExceededError` | 413 | `error_chat_context_window_exceeded` (+`_max_available` in standard mode) | "This conversation has reached its current context limit ({maxTokens} tokens). Start a new chat to continue." / "...Switch to Max to continue with the larger window." | false |
| `ModelProviderError` (stream failed to start, incl. unroutable model) | 502 | `error_chat_provider_unavailable` | "The AI provider is currently unavailable. Please retry." | true |
| Stream transport error with 401/403 or "invalid api key" markers | 502 | `error_chat_provider_key_invalid` | "Unable to connect to the AI service. Verify that your organization OpenAI API key is valid." | false |
| Other stream transport error | 502 | `error_chat_stream_failed` | "The response stream failed. Please retry." | true |
| `MessagePersistenceError` / `RateLimitPersistenceError` | 500 | `error_chat_persistence_failed` | "Your message could not be saved. Please retry." | false |

(`error-classification.ts:78-163, 182-204, 314-338`.) Note the `Retry-After` header is not set; the
retry hint travels in `i18nParams.retryAfterSeconds`. The "Billing & Credits" page named in the
platform-credit string does not exist under that name (the rail item is "Billing").

### 3.6 Rate limiting

`RateLimitService.layer` is a fixed-window counter in Postgres table `chat_request_rate_limit_window`
keyed by `(user_id, window_started_at)`; windows older than 2x the window are pruned in a detached
query (`rate-limit.service.ts:15,36-107`). Limits: paid window 60 000 ms / 30 requests; free 60 000 ms
/ 10; env overrides `PAID_CHAT_RATE_LIMIT_WINDOW_MS`, `PAID_CHAT_RATE_LIMIT_MAX_REQUESTS`,
`FREE_CHAT_RATE_LIMIT_*`, `FREE_CHAT_ALLOWANCE_*` (must be positive integers or the resolver throws
`Expected {NAME} to be a positive integer`) (`access-control/index.ts:34-51`). Because
`isFreeTierContext` returns `false`, only the paid values apply. **The limiter is disabled wholesale
when `VITE_DISABLE_REDIS=true`**: `chat-runtime.ts:30-34` swaps in `RateLimitService.layerDisabled`,
which always returns `allowed: true` (`rate-limit.service.ts:153-161`), even though the live limiter
does not use Redis. `.env.example:153` ships `VITE_DISABLE_REDIS=true`. It is per user, not per
organization; there is no per-org or per-key limit.

### 3.7 Context limits and Max mode

Server check at `chat-orchestrator.service.ts:678-693` using the heuristic
`Math.max(1, Math.ceil(text.length / 4))` over text parts. The client mirrors it with the i18n strings
above and a composer banner. Max mode simply selects `maxContextWindow` instead of the inferred
standard window (`context-window.ts:65-73`).

---

## 4. Policy enforcement

### 4.1 Machine reasons and where they fire

`evaluateModelAvailability` (`shared/model-policy/policy-engine.ts:22-54`) is additive:
`disabledProviderIds.includes(model.providerId)` -> `provider`; `disabledModelIds.includes(model.id)`
-> `model`; `isDeniedByComplianceFlags` -> `compliance`. `resolveThreadModel` turns a non-empty
`deniedBy` into `ModelPolicyDeniedError` with message `Selected model is not allowed for this request`
and reason `policy_denied:<joined>` (`model-policy.service.ts:43-56, 214-223`). Strict-mode reasons:
`policy_denied:missing_org_context_for_provider_key`,
`policy_denied:provider_not_supported_by_byok:<providerId>`,
`policy_denied:missing_provider_api_key:<providerId>` (`:265-276, 345-355, 416-425`). All are 403.

### 4.2 ZDR semantics and bypass

`isDeniedByComplianceFlags` checks only `require_zdr && !model.zeroDataRetention`
(`compliance-map.ts:13-21`). Before that check the engine computes
`bypassesZdrCompliance = hasActiveOrgProviderKeyForModel(model.providers, policy.providerKeyStatus)`
(`policy-engine.ts:38-48`): if the org's persisted snapshot marks an executable route provider as
configured, the model skips the ZDR test entirely (`provider-keys.ts:38-63`). That is what the BYOK
dialog warns about. Note the snapshot is org-global (6.3), so a workspace-only key does not bypass ZDR.

### 4.3 "Require organization provider key" — not enforced

`require_org_provider_key` exists in the type (comment still says "configured in WorkOS Vault",
`compliance-map.ts:6-10`) and has a UI toggle, but nothing reads it: `isDeniedByComplianceFlags`
ignores it and no other file references the flag on the request path. Classification: stubbed or inert.
The only "require a key" behaviour is the environment-level `CHAT_REQUIRE_BYOK` (4.5).

### 4.4 Study Mode enforcement — enforced, but currently unservable

`set_enforced_mode` persists `enforcedModeId = 'study'`; the resolver makes the org mode win over
request and thread modes with `isEnforced: true` (`chat-modes/resolver.ts:19-27`); the orchestrator
passes `modeModelId = 'openai/gpt-oss-120b'` as the top-priority candidate
(`chat-orchestrator.service.ts:373`; `registry.ts:11`). That catalog row declares
`providers: ['azure', 'gateway']` (`providers/openai.ts:569-571`) — neither route has a client, and
neither is BYOK-executable, so `byokCandidateProviders` is empty and platform routing throws
`Selected model does not support platform OpenAI routing: openai/gpt-oss-120b`
(`model-gateway.service.ts:110-118`). By code reading, enabling "Enforce Study Mode" makes every chat
turn in that organization fail with **"The AI provider is currently unavailable. Please retry."**
(no test covers this combination: `model-gateway.service.test.ts` and `model-policy.service.test.ts`
contain no `gpt-oss`/`study` cases). Flag for verification before documenting Study Mode.

### 4.5 Provider toggles, model controls, `CHAT_REQUIRE_BYOK`

Provider and model deny lists are stored as arrays on `org_ai_policy` and applied on every turn
(4.1). `CHAT_REQUIRE_BYOK` is a plain `=== 'true'` read (`model-policy.service.ts:38-40`), declared in
`.env.example:126-128` as "Optional strict mode. Set true only when every model request must use a
workspace-managed provider key instead of the platform-credit gateway." When true, the org-context
short-circuit is skipped and a missing key is a 403 instead of a fallback to platform credit.

### 4.6 Storage and write paths

Single row per org in `org_ai_policy` (`apps/start/zero/migrations/schema.sql:57-88`; Zero table
`orgAiPolicy`, `integrations/zero/schema.ts:64-65`): `disabled_provider_ids`, `disabled_model_ids`,
`compliance_flags`, `provider_native_tools_enabled`, `external_tools_enabled`, `disabled_tool_keys`,
`org_knowledge_enabled`, `provider_key_status`, `enforced_mode_id`, `updated_at`. "No versioning;
policy is overwritten on each update" (`repository.ts:94`). It is **not** a receipt stream: policy
changes are not hash-chained and leave no audit record beyond `updated_at`. Two write paths:

- Zero mutators `orgPolicy.toggleProvider|toggleModel|toggleComplianceFlag|setEnforcedMode|
  toggleProviderNativeTools|toggleExternalTools|toggleTool` (`org-policy.mutators.ts:258+`), each
  gated by `requireOrgPolicyAdmin` and `requireOrgFeature` (`:122-182`). The settings UI uses these
  (`use-provider-policy.ts:113-172`).
- `GET/POST /api/org/model-policy` with the same seven actions validated by zod
  (`routes/api/org/model-policy/route.tsx:16-67`), `requireOrgAuth`, a
  `WorkspaceBillingService.assertFeatureEnabled` gate (`:146-159`), and `OrgModelPolicyService`
  (`org-model-policy.service.ts:171-270`; unknown ids -> `Unknown provider id: …`, `Unknown model id: …`,
  `Unknown tool key: …`, `Unknown mode id: …`). Errors: 401 / 400 / 403 / 500 (`http/error-response.ts:45-60`).

Feature gates are inert: `getFeatureAccessState` returns `allowed: true` unconditionally
(`shared/access-control/index.ts:354-367`) although `byok`, `providerPolicy`, `compliancePolicy`,
`toolPolicy` are nominally `plus` features (`:160-167`).

---

## 5. Provider accounts ("Models accounts")

Store: `apps/start/src/lib/backend/model-provider-accounts/model-provider-account-store.ts`.

- Storage is receipt-first: each save appends a `model.provider.account.configured` event to stream
  `organizations/<org>/workspaces/<ws>/model-provider-accounts/<provider>` with the **encrypted**
  credential inside the receipt body, actor `{ id: userId, kind: 'user' }`, up to 5 optimistic-append
  attempts (`:29, 38-50, 98-103, 134-165`), then rebuilds the serving row in `model_provider_account`
  from the chain (`:178-233`; migration `apps/start/zero/migrations/20260822_add_model_provider_accounts.sql`,
  columns include `credential_ciphertext/iv/auth_tag/key_version`, `credential_fingerprint`,
  `selected_model_ids`, `manager_access`, `member_access`, `stream`, `receipt_refs_json`). The
  projection upsert only applies when the incoming chain is at least as long as the stored one
  (`:209-210`). Account id = `model_account_<sha256(org\0ws\0provider)[0:32]>` (`:86-96, 280`), so one
  account per (org, workspace, provider).
- Fingerprint: `byokProviderKeyFingerprint` = first 12 hex of sha256 (`byok-crypto.ts:24-25`); it is
  the only key-derived value returned to the UI (`ModelProviderAccountSummary`,
  `shared/model-provider-accounts/types.ts:9-18`).
- Validation: format (`validateProviderApiKeyFormat`) then a **live call** (`validateProviderApiKey`,
  section 6.2) before encryption, receipt append, or projection (`model-provider-accounts.server.ts:90-103`).
  Model ids must be catalog rows whose `providers` include the account's provider:
  `Model '<id>' cannot execute through <provider>.`; at least one model: `Select at least one model.`
  (`store:266-278`).
- Access control: writes need workspace mutation authority (owner/admin) and `owners`-only accounts
  need workspace role `owner` (1.11). Reads at request time join `receipt_workspace_member` and
  `member`; if `member_access = 'managers'` and the caller is not a workspace or org owner/admin the
  credential is not returned (`store:350-398`). `manager_access` is stored but not consulted by the
  request path.
- Workspace scoping: the hook throws `Select a workspace first.` without an active workspace
  (`use-model-provider-accounts.ts:74`); accounts are per workspace and are the first credential
  source in 3.1.

---

## 6. BYOK

### 6.1 Table and crypto

`org_provider_api_key` keyed by `(organization_id, workspace_id, provider_id)` with `ciphertext`, `iv`,
`auth_tag`, `key_version`, `created_at`, `updated_at` (`schema.sql:91-106`; store upsert
`provider-key-store.ts:200-250`). Plaintext "only exist[s] in memory long enough to encrypt/decrypt"
(`:21-24`). Crypto is AES-256-GCM, 32-byte key, 12-byte IV, `KEY_VERSION = 1`
(`packages/receipt-app/src/services/byok-crypto.ts:3-6, 57-95`). The wrapping key is
`BYOK_ENCRYPTION_KEY_B64`, cached per process; errors: `Missing required environment variable
BYOK_ENCRYPTION_KEY_B64.`, `BYOK_ENCRYPTION_KEY_B64 must be valid base64.`,
`BYOK_ENCRYPTION_KEY_B64 must decode to exactly 32 bytes.`, `Unsupported BYOK key version: <n>`
(`:36-55, 80-82`). Operator-facing mapping: a missing table becomes **"BYOK key storage is not
initialized. Run the BYOK migration first."**; other failures **"BYOK persistence failed"**
(`byok-executor.service.ts:67-89`). `.env.example:146-149`: "Do not rotate after users have saved BYOK
keys unless existing rows are re-encrypted." There is no rotation tool in the repo.

### 6.2 Validation

Format: empty -> `Provider API key is required.`; OpenAI must start with `sk-` -> `OpenAI API keys must
start with "sk-".`; Anthropic `sk-ant-` -> `Anthropic API keys must start with "sk-ant-".`
(`provider-keys.ts:72-107`). Live: OpenAI `GET https://api.openai.com/v1/models` with a bearer header;
Anthropic `GET https://api.anthropic.com/v1/models?limit=1` with `x-api-key` and
`anthropic-version: 2023-06-01`; 10 000 ms timeout; 401/403 -> **"Unable to connect to {OpenAI|Anthropic}.
Verify that your {OpenAI|Anthropic} API key is valid."** (`retryable: false`); other status ->
**"{Provider} could not validate this API key right now. Try again shortly."**; network/abort ->
**"{Provider} could not validate this API key right now. Check your connection and try again."**;
bodies ignored (`provider-key-validation.service.ts:4-6, 24-78`). Validation precedes persistence
(`byok-executor.service.ts:150-162`).

### 6.3 Scoping: global vs workspace, and what chat actually reads

- `/organization/settings/byok` writes to `ws_global_<md5(org)>`; the workspace "LLM keys" tab writes
  to the named workspace (1.8, 1.9). `resolveWorkspaceId` falls back to the global scope only when no
  workspace id is supplied (`provider-key-store.ts:74-78`); tests assert exact isolation between the
  global scope and every visible workspace (`provider-key-store.test.ts:331-365`). Migration
  `20260825_separate_global_and_workspace_provider_keys.sql` moved legacy Default-workspace rows to
  the global scope.
- `/api/chat` always has a workspace (Default when none is selected) and passes it to
  `resolveThreadModel`, which passes it to `resolveOrgProviderApiKey`
  (`model-policy.service.ts:378-385`). So a web chat turn reads the **workspace** key, never the
  org-global BYOK key, per RCA-455's rule. The org-global key is read by paths that have no workspace:
  title generation (`thread.service.ts:478-489` calls `resolveThreadModel` without `workspaceId`),
  embeddings (`rag/attachment-content.pipeline.ts:128-131`), and Factory dispatch, whose auth context
  is pinned to `receiptGlobalScopeId` (`receipt-chat.service.ts:2171`).
- **Apparent gap (code reading, not runtime-verified):** `providerKeyStatus` on `org_ai_policy` is
  always rewritten from the org-global status even when a workspace key is saved
  (`byok-executor.service.ts:163-184, 213-234`: `organizationStatus = tryReadStatus(organizationId)`).
  `resolveThreadModel` short-circuits to platform credit when that snapshot says `hasAnyProviderKey ===
  false` (`:319-332`) and skips a provider marked `false` (`:360-367`). A workspace that saves an "LLM
  keys" OpenAI key while the organization has no global key therefore appears never to use it for chat;
  conversely an org with only a global key falls through to platform credit in every workspace. Only
  Models accounts (section 5) are immune, because they are resolved before the snapshot check. This
  needs a runtime check before documenting BYOK precedence.

### 6.4 Request-time precedence and the ZDR bypass

See 3.1: Models account > (snapshot short-circuit) > BYOK key at the request scope > platform credit.
`usedByok` is `Boolean(providerApiKeyOverride)` for both Models accounts and BYOK keys
(`chat-orchestrator.service.ts:1127`), which drives quota bypass and cost visibility (7.5).

### 6.5 Factory and the runtime

`packages/receipt-app/src/services/platform-openai-key.ts:10-26` defines `PLATFORM_OPENAI_API_KEY_ENV =
"OPENAI_API_KEY"`, `readPlatformOpenAiApiKey`, and `requirePlatformOpenAiApiKey`, whose error is
**"Platform-funded OpenAI access is authorized, but OPENAI_API_KEY is unavailable."**
`resolveFactoryModelFunding` (`factory-model-funding.ts:42-107`) decides the payer: a Slack-originated
reservation (`billingRequestId` starting `slack_evt_`) is authorized first; otherwise the org/workspace
OpenAI BYOK key (`readOrgOpenAiByokApiKey`, `receipt-openai-env.ts:80-160`, workspace id or global
scope) wins; otherwise platform credit requires an active app-chat reservation for the exact request id
(`assertPlatformCreditAuthorized`, `platform-credit-authorization.ts:26-73`, which also extends the
reservation lease by 2 h) and the server `OPENAI_API_KEY`; without a billing id the error is
**"Factory platform funding requires an app-chat billing request id."** The sandbox receives the key
only as `~/.codex/auth.json` plus `RECEIPT_MODEL_FUNDING_SOURCE=byok|platform_credit`; `AI_GATEWAY_API_KEY`,
`VERCEL_OIDC_TOKEN`, and provider/prefix overrides are deleted, and platform-funded runs pin
`RECEIPT_CODEX_MODEL_OVERRIDE` to `platformCodexModel()` = `RECEIPT_FACTORY_PLATFORM_CODEX_MODEL` or
`gpt-5.6-luna` (`lima-auth-byok.ts:59-96`; `factory-model-funding.ts:9-10, 109-115`). Default task
model `DEFAULT_FACTORY_TASK_CODEX_MODEL = "gpt-5.6-luna"` (`factory/runtime/factory-service-config.ts:8-11`).
**Factory supports OpenAI only**: `readOrgOpenAiByokApiKey` queries `provider_id = 'openai'`
(`receipt-openai-env.ts:126-131`) and the runtime adapter is the OpenAI SDK (`adapters/openai.ts`); an
Anthropic BYOK key is honoured by web chat direct answers but not by Factory. The adapter refuses to run
without an explicit key (`OpenAI adapter call missing explicit apiKey.`, `:207-212`) except behind a
loopback `OPENAI_BASE_URL` mock (`receipt-openai-env.ts:57-76`).

---

## 7. Usage, cost, budgets, audit

### 7.1 What is measured per turn

`createGenerationMetricsAccumulator` sums `inputTokens`, `outputTokens`, `totalTokens`,
`reasoningTokens`, cache read/write/no-cache tokens across every call in the turn ("routing, skill
authoring, and a final answer") and merges provider metadata, summing `gateway.cost` and
`billableWebSearchCalls` if present (`generation-metrics-accumulator.ts:27-128`). The router's
`generateText` feeds the same accumulator (`receipt-chat.service.ts:1737-1741, 3484`). Analytics are
persisted on the assistant message with `aiCost` (internal) and `publicCost` (user-visible)
(`generation-metrics.ts:7-22`), computed by `buildReceiptGenerationAnalytics` in
`packages/receipt-app/src/services/generation-analytics.ts`.

### 7.2 Cost computation

Web: `calculateActualUsageCostNanoUsd` prices tokens from the catalog's `pricing` with tier support,
cache-read/write rates, and `webSearchPerRequest`; embeddings use $0.02/1M for
`text-embedding-3-small`; unpriced models return `undefined` (`workspace-usage/shared.ts:317-389`).
Settlement prefers a provider-reported `actualCostUsd`, then this rate-card figure, then the
reservation estimate, then 0 ("a missing provider cost must not turn a completed platform-funded
request into a free request", `settlement-store.ts:64-77`). Factory: `estimateOpenAiApiCost` uses a
hard-coded price table for `gpt-5.4`, `gpt-5.3-codex`, `gpt-5.6-sol|terra|luna` and prefers an exact
gateway cost when present (`packages/receipt-app/src/services/openai-api-cost.ts:22-53, 172-192`);
`estimateOpenAiCacheSavings` reports the cache discount separately (`:203-218`).

### 7.3 Platform credit, reservations, per-seat allowance

- Signup credit: `PLATFORM_SIGNUP_CREDIT_NANO_USD = 5_000_000_000` ($5) granted to each new hosted
  organization's `org_billing_account` with a `signup_grant` ledger row; self-hosted gets 0
  (`shared.ts:19`; `auth/services/default-organization.service.ts:112-114, 169-174`; migration
  `20260813_add_platform_signup_credits.sql`).
- Reservation (`reservation-store.ts:346-686`): skipped when there is no org or `bypassQuota` (BYOK)
  (`:60-65`); otherwise, inside one transaction with `FOR UPDATE`: expire stale reservations (TTL 15
  min, `shared.ts:14`); if the account has granted credit, estimate the turn
  (`estimateReservedCostNanoUsd`: prompt tokens at input price + max(96, 12% of prompt, capped by
  `defaultMaxOutputTokens`) at output price, +10% headroom, floor $0.005; `shared.ts:397-439`) and
  debit `credit_remaining_nano_usd`, writing a `reserve` entry to `org_billing_credit_ledger`; if the
  balance is short and the org is free, fail with `platform_credit_exhausted` ("Your platform credit
  balance is exhausted.", `:511-521`); paid orgs continue into the seat engine: a seat slot per member
  per billing cycle with a prorated `seat_cycle` bucket (`seat-store.ts`, `core.ts:143-165`); failures
  `No seat quota is currently available for this member.` / `This seat has exhausted its current quota.`
  (`:543-592`). Seat budget = plan price minus `WORKSPACE_USAGE_TARGET_MARGIN_PERCENT` (required env
  on cloud for paid plans; `readPercentEnv` throws `Missing …`; `shared.ts:65-95, 133-152`;
  `.env.example:207-219`), or the Singularity "Usage cap" override
  (`organizationMonthlyBudgetNanoUsd`, `singularity-admin.service.ts:521-527`). Self-hosted disables the
  policy (`shared.ts:125-141`).
- Settlement (`settlement-store.ts:30-175, 249-340`): `org_usage_event` (one per request id, with token
  metadata JSON) and `org_monetization_event` (`pending` -> `settled`, or `bypassed` for BYOK / no
  reservation); `calculatePlatformCreditSettlement` refunds or captures the difference, forgiving any
  overage the balance cannot cover (`packages/receipt-app/src/services/platform-credit-settlement.ts:15-45`).
- Release on failure: `request_failed`, `title_generation_failed`, `reservation_expired`
  (`chat-orchestrator.service.ts:999`; `thread.service.ts:527`; `reservation-store.ts:339`).

### 7.4 Rate limits and budgets that exist vs. those shown in the UI

Enforced: per-user 30 requests/min (3.6, off when Redis is "disabled"); dollar budgets in 7.3. Not
enforced: everything on `/organization/settings/policies` ("Rate limiting", "Budget limiting",
"Logging config", "Tool approval") — rules are receipt streams
(`packages/receipt-app/src/services/policies.ts`) with no consumer; the type file still says "These
types describe the shape the eventual backend must return." (`shared/policies.ts:9-13`). There is no
token budget anywhere.

### 7.5 Cost display rules

`shouldExposeCost = usedByok || canExposeUserCost` where `canExposeUserCost` is the server env
`ALLOW_USER_COST_DISPLAY === 'true'` (`generation-metrics.ts:44`; `app-feature-flags.ts:58-61,83`;
`.env.example:150-151`). The composer's context hover card footer **"Total cost"**
(`en.json:196`) appears only when some message carries `publicCost`; the Replay dialog labels the row
**"Estimated provider cost"** and shows **"Not recorded"** when absent
(`chat-receipts-dialog.tsx:2341-2345`; `ChatReceiptUsageSummary` keeps missing distinct from zero,
`chat-receipts.functions.ts:105-125`).

### 7.6 Usage page

`/organization/settings/usage` ("Usage" / "Track your plan usage and model requests.",
`usage-page.tsx:169-170`; utility rail item) shows: Current plan + "Active" pill; resource tiles
**Workspaces**, **Integrations**, **Members** (`"{count} / {limit}"`, seats are "a genuine, enforced
entitlement"); headline metrics **"Requests this period"** ("total model requests"), **"Total
tokens"** ("input, output, and reasoning combined"), **"Credit used"** ("platform credit consumed");
**Credits and spend**: Credit remaining, Recorded spend, Top model; **Token breakdown**: Input,
Output, Reasoning, Cache-read (`usage-page.model.ts:110-207`). The query is **per signed-in user**
over a rolling **31-day** window of `org_usage_event`
(`org-usage-summary.server.ts:141, 183-187`), not organization-wide. Free seat ceiling default 5, now
overridable with `RECEIPT_DEFAULT_FREE_SEAT_COUNT` (`shared.ts:27-34`, since 41baea75).

### 7.7 What is recorded and audited per request

- `org_usage_event` + `org_monetization_event` rows (7.3) — request id, user, org, seat, model id,
  `used_byok`, estimated and actual nano-USD, token metadata.
- One `chat.request` wide-event log line per request with actor, thread, model (`requestedModelId`,
  `resolvedModelId`, `modelSource`, `reasoningEffort`, `providerOverride`), policy
  (`zeroDataRetentionRequired`, denied tool keys), stream, usage (`promptTokens`, `totalTokens`,
  `estimatedCostUsd`, `actualCostUsd`, `usedByok`), breadcrumbs, and outcome; **no prompt or
  completion text** (`wide-event.ts:50-107, 250-310`).
- A receipt `response.finalized` (with the analytics fields) and `run.status: completed` with note
  `chat turn completed from /api/chat` for each direct answer (`chat-bridge.ts:308-345`); Factory
  turns produce their own objective receipts. Router calls are not separately logged.
- Structured `byok.provider.resolve` / `byok.db.read` / `byok.update.*` log lines carry only a
  12-hex fingerprint (`provider-key-resolver.service.ts:50-69`; `provider-key-store.ts:56-72`);
  the Factory adapter logs `openai.key.debug` with a masked preview unless
  `RECEIPT_OPENAI_KEY_DEBUG_MODE` changes it (`adapters/openai.ts:18, 136-172`).
- Policy edits: `updated_at` only (4.6). Models-account edits: hash-chained receipts (5).

---

## 8. External access

There is no way for another application to route LLM traffic through Receipt. `apps/start/src/routes/api`
contains `admin-metrics`, `auth`, `chat`, `dev/session-login`, `files/*`, `org/model-policy`,
`receipt-connect/cli-login`, `receipt-ingest/receipts`, `receipt-trail/events`, `sessions/*`,
`slack/*`, and `zero/*`; a grep for `completions`, `/v1/`, or `proxy` matches only unrelated files
(`files/object`, `slack/events`, a CLI test). The Receipt runtime exposes `/chat/route` (a router
decision endpoint used by Slack, `apps/slack/slack-chat-routing.ts:62-75`) but no completion or proxy
endpoint. `POST /api/chat` is session-authenticated, thread-bound, and returns an AI SDK UI message
stream, not an OpenAI-shaped response. The "Custom Endpoints" tab and "Self-Hosted Model" tile are
inbound-provider previews, not outbound proxies.

---

## 9. `apps/start/src/ee/singularity`

Singularity is the enterprise-licensed admin control plane (`apps/start/src/ee/LICENSE.md`: "The
Receipt Enterprise License", production use requires a written commercial agreement). It renders at
`/singularity` (rail label **"Admin"**, title "Singularity", description "Enterprise admin control
plane", `singularity-nav.config.ts:10-31`) and is reachable only when the caller is signed in, has an
active organization equal to one hard-coded `SINGULARITY_ORG_ID` constant, and is still a member of it;
otherwise `beforeLoad` redirects to `/` (`shared/singularity.ts:1-7`;
`backend/auth/singularity-auth.server.ts:18-56`; `routes/(ee)/singularity/_layout/route.tsx:6-18`).
It lists organizations (columns Organization, Plan, Status, Seats) and, per organization, shows
Members, Pending invites, Seats, Plan, Billing, **Usage cap**, **AI spend this month**, **AI spend all
time**, Billing period, Subscription source, Subscribed since, a member table with role changes and
invites, and a **"Plan Override"** panel ("Configure manual subscriptions, usage caps, and feature
access for workspaces billed outside Stripe.") that writes manual subscriptions, the organization
monthly usage budget, and feature overrides (`components/singularity-org-detail-page.tsx:832-882,
942-943`; `backend/services/singularity-admin.service.ts:455-535`). It is the only UI that sets a
per-organization spend cap.

---

## 10. Observability

- Logging: Effect loggers with `EFFECT_LOG_FORMAT` (`pretty|json|logfmt|structured`, default json in
  production), `EFFECT_MIN_LOG_LEVEL` (default `Warn`), `EFFECT_SERVICE_NAME`,
  `EFFECT_SERVICE_VERSION` (`server-observability.layer.ts:5-7, 79-104`).
- OTLP: when `EFFECT_OTLP_BASE_URL` is set, `Observability.Otlp.layerJson` exports logs/traces/metrics
  with optional `EFFECT_OTLP_HEADERS_JSON` headers and resource attributes `serviceName`,
  `serviceVersion`, `deployment.environment` (`:85-86, 116-129`); the layer is merged into every server
  runtime (`runtime-runner.ts:24`). Neither variable is documented in `.env.example`.
- PostHog: only finalized **failures** with `captureMode !== 'none'` are sent, via
  `captureExceptionImmediate` with a fingerprint `route:code:tag:captureMode` and properties including
  `model_id`, `organization_id`, `thread_id`, usage, and breadcrumbs — no prompt text
  (`posthog.server.ts:55-100`). Model-policy denials are `none` except paid-plan/provider-key reasons
  (`signal`); provider failures are `exception` (`error-classification.ts:112-125, 263-275`).

---

## 11. Production considerations

| Variable | Read at | Default / effect |
|---|---|---|
| `OPENAI_API_KEY` | `platform-openai-key.ts:12-14`; chat gateway, title, embeddings, Factory | Required for every non-BYOK model call; absent -> 502 / Factory funding error. Not in `.env.example`. |
| `BYOK_ENCRYPTION_KEY_B64` | `byok-crypto.ts:36-55` | Required to save or read any key; must be exactly 32 bytes; never rotate. |
| `CHAT_REQUIRE_BYOK` | `model-policy.service.ts:38-40` | `false`; `true` = 403 without a key. |
| `ALLOW_USER_COST_DISPLAY` | `app-feature-flags.ts:58-61` | `false`; BYOK turns always expose cost. |
| `VITE_DISABLE_REDIS` | `chat-runtime.ts:30-37` | `.env.example` ships `true`, which disables the rate limiter and stream resume. |
| `VITE_APP_INSTANCE_MODE` | `app-feature-flags.ts:25-28` | `self_hosted` disables usage policies, zero signup credit, and (per `.env.example:138-140`) quota limits. |
| `PAID_CHAT_RATE_LIMIT_WINDOW_MS`, `PAID_CHAT_RATE_LIMIT_MAX_REQUESTS`, `FREE_*` | `access-control/index.ts:41-51` | 60 000 / 30; invalid values throw. |
| `WORKSPACE_USAGE_TARGET_MARGIN_PERCENT` (+ per-plan) | `shared.ts:65-95` | Required on cloud for paid plans; missing -> `Missing …` at policy resolution. |
| `RECEIPT_DEFAULT_FREE_SEAT_COUNT` | `shared.ts:27-34` | 5. |
| `CHAT_TITLE_GENERATION_MODEL` | `thread.service.ts:926` | `openai/gpt-5-mini`. |
| `RECEIPT_FACTORY_PLATFORM_CODEX_MODEL`, `RECEIPT_FACTORY_PLATFORM_SUPERVISOR_MODEL`, `RECEIPT_FACTORY_TASK_CODEX_MODEL` | `factory-model-funding.ts:109-115`; `factory-service-config.ts:9-11` | `gpt-5.6-luna`. |
| `OPENAI_MAX_RETRIES`, `OPENAI_RETRY_BASE_MS`, `RECEIPT_OPENAI_KEY_DEBUG_MODE` | `adapters/openai.ts:18, 181-182` | 3 / 500 / `masked`. |
| `EFFECT_OTLP_BASE_URL`, `EFFECT_OTLP_HEADERS_JSON`, `EFFECT_LOG_FORMAT`, `EFFECT_MIN_LOG_LEVEL` | section 10 | unset / json in prod / `Warn`. |
| `AI_GATEWAY_API_KEY`, `ANTHROPIC_API_KEY` | none | Listed in `.env.example` but unused. |

Failure modes worth documenting: missing `OPENAI_API_KEY` breaks chat for every org without a key;
missing `BYOK_ENCRYPTION_KEY_B64` breaks BYOK saves and any request that tries to decrypt a stored
key (the request fails with a 500 persistence error, `model-policy.service.ts:386-393`); a model
whose route is `gateway`-only (50 of 75) or the Study Mode model fails with a 502; running with
`VITE_DISABLE_REDIS=true` removes throttling; the platform-credit message points users to "Billing &
Credits", a page that does not exist under that name. Self-hosted differences: no signup credit, usage
policy disabled, org settings still owner/admin-only, BYOK optional but `OPENAI_API_KEY` still
required for the default model.

---

## Changes since 41baea75

Range `41baea75` (2026-09-04) to `c3c16be6` (2026-09-07), 43 commits. `git log 41baea75..HEAD` over
the gateway paths (`components/model-gateway`, `lib/shared/ai-catalog`, `model-gateway.service.ts`,
`chat/runtime`, `model-policy`, `model-provider-accounts`, `billing`, `routes/api`, `ee`,
`platform-openai-key.ts`, `openai-api-cost.ts`, `byok`, `integrations/zero`) returns only `c3c16be6`.
Behavioural changes that touch this area:

1. `apps/start/src/lib/backend/billing/services/workspace-usage/shared.ts` (`c3c16be6`):
   `DEFAULT_FREE_SEAT_COUNT` is now overridable through `RECEIPT_DEFAULT_FREE_SEAT_COUNT` (default 5).
2. `models-page.tsx` (`46652e84`): the Models / Custom Endpoints tabs now use the shared
   `Tab`/`TabList`; no string or behaviour change.
3. `packages/receipt-app/src/services/chat-layer-routing.ts` and
   `apps/start/src/lib/backend/chat/services/receipt-chat.service.ts` (`ab7b00b0`): the router no
   longer silently defaults to Factory or to "all active integrations"; an unusable router decision is
   retried once with a review prompt and then fails closed with the new user-facing string
   **"Receipt couldn't determine the access needed for this request. Please retry; no task was
   started."** This adds up to one extra router model call per turn (metered into the same turn).
   `apps/slack/slack-chat-routing.ts` adopts the same fail-closed rule.
4. `packages/receipt-app/src/services/factory/model-error-retry.ts` (new, `e6944514`): the Factory
   supervisor no longer retries 401 / `invalid_api_key` model failures.
5. `apps/start/src/lib/frontend/chat/chat-receipts.server.ts`: the replay recap generation gets a 20 s
   deadline and `maxRetries: 0`, with the message **"The AI recap took too long. Your recorded outcome
   remains available. You can try again."**

Map corrections (not changes in range, but places where the prior corpus and HEAD disagree):

- The map's §2.8 "AI Gateway / platform credit" describes `AI_GATEWAY_API_KEY` as the platform route.
  At HEAD the platform route is direct OpenAI with `OPENAI_API_KEY` (RCA-404, 2026-08-14) and no code
  reads `AI_GATEWAY_API_KEY`; the `.env.example` comment is stale.
- The map's §2.6 precedence omits that web chat resolves BYOK keys at the **workspace** scope while the
  BYOK page writes the **global** scope, and that the `providerKeyStatus` snapshot is global (6.3).
- The map's §3.3 treats "Enforce Study Mode" as working; at HEAD its fixed model has no executable route (4.4).
- The map's §1.3 model counts (75) and §1.1 tile count (32) are unchanged and re-verified.

---

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

## Open questions

1. Does a workspace "LLM keys" OpenAI key ever get used by web chat when the organization has no
   global key? By code reading the global `providerKeyStatus` snapshot short-circuits it (6.3);
   needs a runtime test. Same question inverted: does an org-global BYOK key apply to chat in any
   workspace?
2. Is "Enforce Study Mode" known to be broken at HEAD (fixed model `openai/gpt-oss-120b` has no
   executable route), or is a `gateway` adapter expected imminently (4.4)?
3. Is the Anthropic BYOK card intentionally hidden for launch, and should docs mention Anthropic at all?
4. `AI_GATEWAY_API_KEY` / `ANTHROPIC_API_KEY` remain in `.env.example` while `OPENAI_API_KEY` is
   missing from it — is `.env.example` going to be corrected, and should docs list `OPENAI_API_KEY`
   as required for hosted and self-hosted?
5. Should the Usage page be documented as per-user (current query) or is an org-wide view planned?
   The section copy and the query disagree.
6. Is the `/model-gateway/playground` stub scheduled, or should the rail item be hidden before docs ship?
7. The platform-credit exhaustion message points at "Billing & Credits"; which page name will ship?
8. Is disabling the rate limiter under `VITE_DISABLE_REDIS=true` intentional for self-hosted, given
   the limiter is Postgres-backed?
9. Should policy edits (`org_ai_policy`) become receipt-backed to support the "audit trail" claim?
10. Are the 21 `managed` provider tiles (AWS, Azure, Vertex, etc.) expected to gain adapters, or
    should docs describe the gallery as a roadmap surface?
