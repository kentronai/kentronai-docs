# Receipt — Organization settings and governance (web app)

Research report for the public documentation site. Source of truth: the code in
`<receipt-repo>` at the state of this
checkout (branch `main`, HEAD `add21f9`). Every substantive claim is cited as
`path:line`. Where behaviour is ambiguous or unimplemented, that is stated
explicitly rather than smoothed over.

Product URL: `https://app.kentron.ai`. All routes below are relative to that host.

---

## 0. Shape of the area

Everything in this report lives under the route folder
`apps/start/src/routes/(app)/_layout/organization/settings/` and its components in
`apps/start/src/components/organization/settings/**`.

There are **20 route files** under `settings/` (excluding `mcp-gateway/**`, covered by a
separate report):

| Path | Route file | Page component |
|---|---|---|
| `/organization/settings` | `settings/index.tsx:8` | `OrgGeneralPage` |
| `/organization/settings/models` | `settings/models/route.tsx:11` (layout) + `models/index.tsx:7` | `ModelsPage` |
| `/organization/settings/models/$providerId` | `settings/models/$providerId/route.tsx:13` | `ProviderModelsPage` |
| `/organization/settings/byok` | `settings/byok/route.tsx:5` | `ByokPage` |
| `/organization/settings/provider-policy` | `settings/provider-policy/route.tsx:8` | `ProviderPolicyPage` |
| `/organization/settings/compliance-policy` | `settings/compliance-policy/route.tsx:11` | `CompliancePolicyPage` |
| `/organization/settings/policies` | `settings/policies/route.tsx:12` | `PoliciesPage` |
| `/organization/settings/guardrails` | `settings/guardrails/route.tsx:8` | `GuardrailsPage` |
| `/organization/settings/tools` | `settings/tools/route.tsx:7` | **redirect only** (see §7) |
| `/organization/settings/skills` | `settings/skills/route.tsx:4` | `SkillsPage` |
| `/organization/settings/knowledge` | `settings/knowledge/route.tsx:8` | `OrgKnowledgePage` |
| `/organization/settings/knowledge-graph` | `settings/knowledge-graph/route.tsx:8` | `OrgKnowledgeGraphPage` ("Org Brain") |
| `/organization/settings/usage` | `settings/usage/route.tsx:13` | `UsagePage` |
| `/organization/settings/billing` | `settings/billing/route.tsx:9` | `BillingPage` |
| `/organization/settings/analytics` | `settings/analytics/route.tsx:11` | `AnalyticsPage` |
| `/organization/settings/integrations` | `settings/integrations/route.tsx:21` | `IntegrationsPage` (scope `organization`) |
| `/organization/settings/workspaces` | `settings/workspaces/route.tsx:4` | `WorkspacesPage` |
| `/organization/settings/members` | `settings/members/route.tsx` | `MembersPage` |
| `/organization/settings/security` | `settings/security/route.tsx` | `OrgSecurityPage` |
| `/organization/settings/mcp-gateway/**` | separate report | — |

### 0.1 Access rules (the single most important fact)

`apps/start/src/routes/(app)/_layout/organization/settings/route.tsx:17-40` is the
gate for the entire area:

1. While `useAppAuth()` or the active-member-role query is pending, the page renders
   `<LoadingState label="Checking workspace access" variant="page" />` (line 24).
2. No user / anonymous user / no `activeOrganizationId` → `<Navigate to="/" />` (line 28).
3. Otherwise the pathname is checked with `canAccessOrganizationSettingsPath`; a failure
   also redirects to `/` (lines 31-38). There is **no "access denied" screen** — the user
   is silently bounced to the app root.

`apps/start/src/routes/(app)/_layout/organization/settings/-organization-settings-access.ts:9-17`:

```ts
const role = input.organizationRole?.trim().toLowerCase()
if (!role) return false
if (isMcpGatewayPath(input.pathname)) return true
return role === 'owner' || role === 'admin'
```

So: **every organization settings page is owner/admin-only, with one exception** —
paths that `isMcpGatewayPath` matches are open to any organization member.
`isMcpGatewayPath` matches `/organization/settings/mcp-gateway` **and
`/organization/settings/workspaces`**
(`apps/start/src/components/mcp-gateway/mcp-gateway-nav.config.tsx:19-24`).
The test file confirms this is deliberate:
`-organization-settings-access.test.ts:5-19` asserts a plain `member` can reach
`/organization/settings/workspaces`, and `:21-34` asserts `/members` is denied to a
`member` while `/billing` is allowed to an `admin`.

Server-side authorization is enforced independently per feature (it does not rely on the
route guard):
- Guardrails: `apps/start/src/lib/frontend/guardrails/guardrails.server.ts:47-60` →
  `"Only organization owners or admins can manage guardrails."`
- Policies: `apps/start/src/lib/frontend/policies/policies.server.ts:32-45` →
  `"Only organization owners or admins can manage policies."`
- Skills: `apps/start/src/lib/frontend/org-skills/organization-skills.server.ts:33-45` →
  `"Only organization owners or admins can manage skills."`
- Model/provider policy (Zero mutators):
  `apps/start/src/integrations/zero/mutators/org-policy.mutators.ts:146-157` →
  `"Only workspace owners or admins can manage organization settings."`
- BYOK: workspace mutation authority via `requireReceiptWorkspaceMutationAuthority`
  (`apps/start/src/lib/frontend/byok/byok.server.ts:57-61`).

### 0.2 Navigation: exact labels, icons, ordering

Source: `apps/start/src/routes/(app)/_layout/organization/settings/-organization-settings-nav.ts:147-308`.
`ORG_SETTINGS_ITEMS` is declared in this order (label — icon — href — flags):

1. `organization-general` — "Organization" (`m.layout_organization_tooltip_name()`) — `Building2` — `/organization/settings` — `exact: true`, `hiddenFromRail: true` (lines 148-156). Description: `m.org_settings_nav_description()` = "Manage organization-wide controls and preferences." (`messages/en.json:588`).
2. `organization-mcp-gateway` — "MCP Gateway" — `Cable` — `/organization/settings/mcp-gateway` — `hiddenFromRail`, `hiddenFromMenu` (lines 157-180). Hidden here because the standalone MCP Gateway nav area owns the rail icon.
3. `organization-integrations` — "Integrations" — `Plug` — `/organization/settings/integrations` (lines 186-197). **Visible rail icon.**
4. `organization-workspaces` — "Workspaces" — `Layers3` — `/organization/settings/workspaces` — `hiddenFromRail: true` (lines 206-212). Menu-only.
5. `organization-byok` — "BYOK" — `Key` — `/organization/settings/byok` (lines 213-218). **Visible rail icon.**
6. `organization-knowledge-graph` — **"Org Brain"** — `Brain` — `/organization/settings/knowledge-graph` (lines 219-224). **Visible rail icon.** (This is the answer to "the sidebar calls one of these Org Brain" — it is `knowledge-graph/`, not `knowledge/`.)
7. `organization-skills` — "Skills" — `Sparkles` — `/organization/settings/skills` (lines 225-230). **Visible rail icon.**
8. `organization-guardrails` — "Guardrails" (`m.org_guardrails_page_title()`) — `ShieldCheck` — `/organization/settings/guardrails` (lines 231-236). **Visible rail icon.**
9. `organization-policies` — "Policies" (`m.org_policies_page_title()`) — `FileText` — `/organization/settings/policies` (lines 237-242). **Visible rail icon.**
10. `organization-usage` — "Usage" — `BarChart3` — `/organization/settings/usage` — `railPlacement: 'utility'` (lines 251-257).
11. `organization-billing` — "Billing" — `CreditCard` — `/organization/settings/billing` — `railPlacement: 'utility'` (lines 258-264).
12. `organization-analytics` — "Analytics & Insights" (`m.org_analytics_page_title()`) — `TrendingUp` — `hiddenFromRail`, `hiddenFromMenu` (lines 265-272). Reachable only by URL.
13. `organization-members` — "Members" — `Users` — `hiddenFromRail: true` (lines 273-279). Menu-only.
14. `organization-models` — "Models" (`m.org_models_page_title()`) — `Box` — `hiddenFromRail: true` (lines 285-291). Menu-only; the "Model Gateway" rail area owns this destination instead (see §1).
15. `organization-knowledge` — "Knowledge" (`m.org_knowledge_page_title()`) — `Database` — `hiddenFromRail`, `hiddenFromMenu` (lines 292-299). Reachable only by URL.
16. `organization-security` — "Security" (`m.org_security_page_title()`) — `Lock` — `hiddenFromRail`, `hiddenFromMenu` (lines 300-307). Reachable only by URL.

Derived lists:
- **Rail icons, primary group, in order**: Integrations, BYOK, Org Brain, Skills, Guardrails, Policies (`isPrimaryNavigationArea`, `apps/start/src/components/layout/sidebar/app-sidebar-nav.config.tsx:106-109`).
- **Rail icons, bottom utility group below a divider, Usage then Billing**: `ORG_UTILITY_AREA_KEYS` (nav.ts:32-35) and `isUtilityNavigationArea` (app-sidebar-nav.config.tsx:111-113). The code comment explains why (nav.ts:243-250): "plan consumption and plan selection are the two things people look for by name".
- **Workspace-switcher menu items** = items with `hiddenFromRail && !hiddenFromMenu`
  (`organizationSettingsMenuItems`, nav.ts:313-315): **Organization, Workspaces, Members, Models**.
- Pages with **no rail icon and no menu entry** (URL-only): MCP Gateway shell entry,
  Analytics, Knowledge, Security. `provider-policy`, `compliance-policy`, and `tools`
  have no `ORG_SETTINGS_ITEMS` entry at all; the comment at nav.ts:342-348 says such pages
  "do not need their own rail icon" and fall back to the `organization-general` area
  when visited directly.

Area resolution: `getOrgSettingsAreaKey` (nav.ts:339-349) is consulted *after*
`isMcpGatewayPath` in `getCurrentArea`
(`app-sidebar-nav.config.tsx:149-153`), which is why `/organization/settings/workspaces`
lights the MCP Gateway rail icon rather than an org-settings one.

### 0.3 Shared page chrome

`OrganizationSettingsPage` (`apps/start/src/components/organization/settings/organization-settings-page.tsx:22-45`)
wraps `ContentPage`, applies `organizationSettingsPageClassName`, and renders the active
**workspace badge** on every page unless `hideWorkspaceBadge` is passed. Pages that pass
`hideWorkspaceBadge`: Models, BYOK, Guardrails, Policies, Skills, Org Brain, Workspaces,
Integrations. The comment (lines 28-34) explains: pages that are deliberately
organization-wide, or already name their workspace, suppress the switcher.

Table pagination on Guardrails / Skills / Workspaces / Org Brain uses the shared control
re-exported at `apps/start/src/components/organization/settings/table-pagination.tsx:9-12`;
page-size options are `[10, 25, 50, 100]`
(`packages/ui/src/components/table-pagination.tsx:19`).

---

## 1. Models — `/organization/settings/models` and `/models/$providerId`

Two very different surfaces share the `models` prefix. **Read this section carefully; it
is the most easily mis-documented part of the area.**

### 1.1 `/organization/settings/models` — the Model Gateway provider catalog

Component: `apps/start/src/components/organization/settings/model-policy/models-page.tsx:162`.

- Page title: `m.org_models_page_title()` = **"Models"** (`messages/en.json:458`).
- Page description (hardcoded, *not* the message catalog string):
  **"Connect model providers, choose workspace models, and manage organization-level access."** (models-page.tsx:220).
  Note the message catalog also has `org_models_page_description` = "Manage providers and
  models for your organization." (`messages/en.json:457`) which this page does **not** use;
  it is used as an invisible height placeholder on the provider detail page
  (`provider-constants.ts:7-8`, `provider-models-page.tsx:94-98`).
- Two tabs, `role="tablist"` `aria-label="Models sections"`: **"Models"** (`Box` icon) and
  **"Custom Endpoints"** (`Server` icon) (models-page.tsx:228-257).
- Models tab controls: search input `placeholder="Search providers"` /
  `aria-label="Search providers"`, and a **"Filter"** toggle button that, when pressed,
  shows only *executable* providers (models-page.tsx:260-278, filter logic at 179-190).
- Empty / add state heading: **"Start adding your Models here"**, sub-copy
  **"Configure a provider account, then choose the models available to this workspace."**
  (models-page.tsx:324-329).
- Provider gallery: a grid of tiles, one per catalog provider, `aria-label="Configure {name}"`,
  `title` = `"{n} models"` or `"Catalog preview"` (models-page.tsx:129-153). No-match state:
  heading **"No providers found"**, body **"Try another search or clear the filter."** (117-124).
- Connected-provider view: left rail headed **"Connected providers"**, then
  **"Add other providers"** with a **"Add new models"** button; right pane heads
  **"{Provider} Accounts"** with **"{n} configured models"**, and buttons
  **"Add {Provider} Account"**, **"Copy FQN"** (copies `"{providerId}/{accountName}"`),
  **"Add model"**, **"Edit"** (models-page.tsx:357-461).
- Model table columns: **Model / Type / Input / 1M / Output / 1M / Latency / Actions**
  (models-page.tsx:466-475). Empty row message: **"No models available for this provider."** (481).
- Custom Endpoints tab: heading **"Custom endpoints"**, body **"Add an OpenAI-compatible or
  self-hosted inference endpoint and then select the models it exposes."**, button
  **"Add custom endpoint"** which opens the `self-hosted` provider dialog
  (models-page.tsx:299-312).

**Provider catalog** — `model-gateway-catalog.ts:188-481`. Exactly **32 provider tiles**
(asserted in `model-gateway-catalog.test.ts:11`). In declaration order:
AWS Bedrock, Google Vertex, Google Gemini, Azure OpenAI, Azure AI Foundry,
Microsoft Foundry, OpenAI, Databricks, Cloudera, Cohere, Snowflake Cortex, OpenRouter,
AI21, Anthropic, AWS Claude Platform, AWS Bedrock Mantle, DeepInfra, Groq, Mistral AI,
ElevenLabs, Deepgram, Cartesia, Smallest AI, Perplexity AI, Together AI, xAI, Baseten,
SambaNova, AWS SageMaker, Cerebras, Wafer, Self-Hosted Model.

Each tile has a `credentialMode` of `optional-api-key`, `managed`, or `adapter-required`
(`model-gateway-catalog.ts:4-7`). **Only OpenAI and Anthropic are actually executable**:

```ts
export function isModelGatewayProviderExecutable(provider) {
  return provider.id === 'openai' || provider.id === 'anthropic'
}
```
(`model-gateway-catalog.ts:34-38`, comment at 29-33: "Every other provider remains a
clickable catalog preview until its runtime adapter lands.")

Per-provider account fields are declared in `accountFieldsFor` (lines 82-167). Examples
worth quoting in docs:
- AWS family (`aws-bedrock`, `aws-claude-platform`, `aws-bedrock-mantle`, `aws-sagemaker`):
  "AWS region" (placeholder `us-east-1`), "AWS access key ID" (`AKIA…`),
  "AWS secret access key" (password).
- `google-vertex`: "Google Cloud project ID" (`my-project`), "Vertex AI location"
  (`us-central1`), "Service account JSON" (password).
- `google-gemini`: "Gemini API key" (`AIza…`).
- Azure family: "Azure endpoint" (`https://…azure.com`), "Azure API key".
- `databricks`: "Workspace URL", "Personal access token" (`dapi…`).
- `snowflake-cortex`: "Snowflake account identifier" (`org-account`), "Programmatic access token".
- `self-hosted`: "Inference endpoint" (`https://models.example.com/v1`) and an **optional**
  "Authentication token".
- `openai`: "OpenAI API key" (`sk-…`); `anthropic`: "Anthropic API key" (`sk-ant-…`).
- Default for anything else: "{Provider} API key" with placeholder "Enter provider API key".

Setup hints (`model-gateway-catalog.ts:174-179`):
- `adapter-required`: "This Models account form is a catalog preview. Durable account
  storage and execution require a reviewed runtime adapter."
- otherwise: "These connection details belong to the Models provider account and are
  separate from organization API Keys."

Models listed per tile come from `catalogProviderIds` mapped onto the canonical
`AI_CATALOG` (`getGatewayProviderModels`, lines 497-519). `openrouter` uses `['*']`, i.e.
the entire catalog. Displayed **Type** is `Reasoning` / `Multimodal` / `Chat` derived from
capabilities (508-513); **Input/Output per 1M** is `pricing.*PerToken × 1e6` formatted as
`$X.XX` with a trailing `.00` stripped, or `—` when unpriced (483-488); **Latency** is a
heuristic string — `≈ 3–8s` for reasoning models, `≈ 2–6s` for ≥1M context, otherwise
`≈ 0.8–3s` (490-494). Docs must present latency as an estimate, not a measurement.

**Provider setup dialog** (`provider-setup-dialog.tsx`) is a 3-step wizard plus a success
screen: steps are **"Configure account"**, **"Model selection"**, **"Access control"**
(lines 59-65). Notable copy:
- "Account display name *", badge "Models account", helper "This account belongs to Models.
  It is not the organization API Keys setting." (lines 250-259).
- Section "Authentication" with badge "Catalog preview" or "Models account" (264-275).
- Footer note: "Credentials are authenticated, encrypted, and stored only in the Models
  account." for executable providers, else "This tile is informational until its executable
  runtime adapter is available." (317-322).
- Models step: "Select models", "{n} selected · per 1M tokens · approximate latency",
  search `placeholder="Search models"` (455-462).
- Access step: "Workspace access", "Access follows Receipt's existing workspace roles."
  Two selects — **Managers** ("Can manage provider accounts and model policy.") with options
  **"Owners and admins"** / **"Owners only"**; **Users** ("Can use policy-allowed models.")
  with options **"Workspace members"** / **"Managers only"** (lines 456-515). Defaults:
  `managerAccess = 'owners-admins'`, `memberAccess = 'workspace-members'` (lines 101-102).

Server function chain for the wizard:
`saveModelProviderAccount` →
`apps/start/src/lib/frontend/model-provider-accounts/model-provider-accounts.server.ts:52-119`.
It requires org auth, then `requireReceiptWorkspaceMutationAuthority` (owner/admin of the
receipt workspace), rejects non-executable providers with
**"This provider is a catalog preview and cannot be configured yet."** (line 71), enforces
`owners`-only accounts against `workspace.role !== 'owner'` with
**"Only workspace owners can manage this Models account."** (line 86), format-checks the key,
then **authenticates the key against the provider before persisting** (comment at 96-97).
The returned summary is secret-free (`ModelProviderAccountSummary`,
`apps/start/src/lib/shared/model-provider-accounts/types.ts:9-18`) and carries only a
`credentialFingerprint`.

Models accounts are **workspace-scoped**, not organization-scoped: the hook uses
`useActiveReceiptWorkspace()` and throws "Select a workspace first." without one
(`use-model-provider-accounts.ts:22-24, 71`).

### 1.2 `/organization/settings/models/$providerId` — per-provider model toggles

Component: `provider-models-page.tsx:34`. This page is **not** part of the provider-account
catalog; it is the model-policy enable/disable list for one *manufacturer* (`openai`,
`anthropic`, `google`, `alibaba`, `deepseek`, `meta`, `mistral`, `minimax`, `moonshotai`,
`xai`, `zai` — `provider-constants.ts:10-22`).

- Title is a back link: **"Go back"** with `aria-label="Go back to models"` pointing at
  `/organization/settings/models` (provider-models-page.tsx:84-93; strings at
  `messages/en.json:502-503`).
- Form title = provider display name; description
  **"Enable or disable models for this provider in your organization."**; help text
  **"Changes apply immediately. Disabled models are unavailable to the organization."**
  (`messages/en.json:501, 504`).
- Empty: **"No models available for this provider."** (`messages/en.json:505`).
- Each row is a toggle whose **checked state means enabled** (`checked: !disabledModelIds.includes(id)`,
  line 69) — the inverse of the Model Controls section on `/provider-policy` (see §3.1).
- Route-level states: no active org → title "Models", description
  "Switch to an organization to manage organization-level provider and model policies." and body
  "Select an organization in the sidebar or switch context to manage policies."
  (`models/$providerId/route.tsx:23-34`, `messages/en.json:508-510`); loading →
  `m.org_models_loading()` = "Loading models..." (route.tsx:36-42).
- The `models` layout route shows the same "select an organization" panel when there is no
  active organization (`models/route.tsx:20-31`).

### 1.3 The model catalog itself

`apps/start/src/lib/shared/ai-catalog/index.ts:74-86` composes `AI_CATALOG` from 11
provider files. Counts at this checkout (from `apps/start/src/lib/shared/ai-catalog/providers/*.ts`):

| Provider id | Models | Examples |
|---|---:|---|
| `openai` | 17 | `openai/gpt-5.6-luna`, `openai/gpt-5.4`, `openai/o3`, `openai/gpt-oss-120b` |
| `anthropic` | 10 | `anthropic/claude-opus-4.6`, `anthropic/claude-sonnet-4.6`, `anthropic/claude-haiku-4.5` |
| `google` | 6 | `google/gemini-3.1-pro-preview`, `google/gemini-2.5-pro` |
| `alibaba` | 5 | `alibaba/qwen3-max` |
| `deepseek` | 5 | `deepseek/deepseek-v3.2` |
| `meta` | 2 | `meta/llama-4-maverick` |
| `mistral` | 10 | `mistral/mistral-large-3`, `mistral/codestral` |
| `minimax` | 3 | `minimax/minimax-m2.5` |
| `moonshotai` | 3 | `moonshotai/kimi-k2.5` |
| `xai` | 5 | `xai/grok-4.1-fast-reasoning` |
| `zai` | 9 | `zai/glm-5` |

**75 models total** at this checkout. The catalog is described as "append-only in practice"
(index.ts:70-73) — docs should say the list changes over releases and point at the app, not
freeze the numbers. Model ids are always `provider/model`. Each row carries
`contextWindow`, `zeroDataRetention`, capabilities, `reasoningEfforts`, `providers`
(routes it can execute through) and optional `pricing`
(`apps/start/src/lib/shared/ai-catalog/types.ts:85-132`).

Default provider-native tools are attached per provider when a model does not name its own
(`index.ts:23-29`): OpenAI → `web_search`, `code_interpreter`; Anthropic →
`web_search_20250305`, `web_fetch_20250910`; Google → `google_search`, `url_context`,
`code_execution`.

---

## 2. BYOK — `/organization/settings/byok`

Component: `apps/start/src/components/organization/settings/byok/byok-page.tsx:16`.
Form: `byok-form.tsx:64`.

- Title: `m.org_byok_page_title()` = **"BYOK"**.
- Description: **"Optional: use your organization's encrypted provider keys instead of
  platform credit (Bring Your Own Key)."** (`messages/en.json:381`).
- One `Form` card per provider, titled **"{Provider} API Key"** (byok-form.tsx:112).
- Card description when a key exists: **"Configured, new requests for this provider will use
  your org key."**; when absent: **"Not configured, requests will continue using Receipt
  defaults."** (`messages/en.json:383-384`).
- Help line: **"You can get your {providerName} API key"** + link labelled **"here"**
  (`messages/en.json:379-380`), href from `BYOK_PROVIDER_META`:
  OpenAI → `https://platform.openai.com/api-keys`,
  Anthropic → `https://console.anthropic.com/settings/keys`
  (`apps/start/src/lib/shared/byok/provider-meta.ts:12-22`).
- Button: **"Save key"** when unset, **"Remove key"** (danger style) when set
  (`messages/en.json:385-386`).
- A configured key renders as a masked value `••••••••••••••••••••••••••••••` and the input
  is disabled until the key is removed (byok-form.tsx:62, 210).
- Toast/inline success strings: **"Provider key saved successfully."** /
  **"Provider key removed successfully."** (`use-byok.ts:46-47`).
- Load-failure banner (organization scope could not be resolved):
  **"Organization API keys could not be loaded. Refresh and try again."** (byok-page.tsx:73).

### 2.1 Which providers appear

`BYOK_SUPPORTED_PROVIDERS = ['openai', 'anthropic']`
(`apps/start/src/lib/shared/model-policy/provider-keys.ts:4`) and
`BYOK_EXECUTABLE_PROVIDERS = ['openai', 'anthropic']` (line 29).

**But the page currently renders OpenAI only.** `BYOK_HIDDEN_PROVIDERS` contains
`'anthropic'` and `BYOK_PROVIDER_ORDER` filters it out
(`apps/start/src/lib/shared/byok/provider-meta.ts:30-37`). The comment states hiding is
presentation-only: "keys already stored for these providers stay encrypted and the gateway
keeps honouring them". Documentation must say **BYOK on this page = OpenAI**, with Anthropic
supported by the runtime but not exposed in the UI at this checkout.

### 2.2 Storage and encryption

- Table: `org_provider_api_key`, keyed by `(organization_id, workspace_id, provider_id)`
  (`apps/start/src/lib/backend/byok/infra/provider-key-store.ts:216-246`).
- Columns: `ciphertext`, `iv`, `auth_tag`, `key_version`, `created_at`, `updated_at` — never
  plaintext (comment at lines 21-24).
- Crypto: **AES-256-GCM**, 32-byte key, 12-byte IV, `KEY_VERSION = 1`
  (`packages/receipt-app/src/services/byok-crypto.ts:3-22`).
- The wrapping key comes from **`BYOK_ENCRYPTION_KEY_B64`** and is cached per process
  (`byok-crypto.ts:36-55`). Failure messages, verbatim:
  - `"Missing required environment variable BYOK_ENCRYPTION_KEY_B64."`
  - `"BYOK_ENCRYPTION_KEY_B64 must be valid base64."`
  - `"BYOK_ENCRYPTION_KEY_B64 must decode to exactly 32 bytes."`
  - `"Unsupported BYOK key version: {n}"` on decrypt with a different `keyVersion` (line 81).
- `.env.example:150-153`: "Stable AES-256-GCM key for encrypting organization BYOK provider
  keys. Generate with: `openssl rand -base64 32`. Do not rotate after users have saved BYOK
  keys unless existing rows are re-encrypted."
- Operator-facing error mapping (`byok-executor.service.ts:74-80`): a missing env key
  surfaces as `"Missing required environment variable BYOK_ENCRYPTION_KEY_B64."`; a missing
  table surfaces as **"BYOK key storage is not initialized. Run the BYOK migration first."**
- Only a **fingerprint** is ever logged: `sha256(key).hex.slice(0,12)`
  (`byok-crypto.ts:24-25`, and structured logs `byok.update.request` / `byok.update.success` /
  `byok.db.read` / `byok.db.upsert` / `byok.provider.resolve` in
  `byok.server.ts:44-53` and `provider-key-store.ts:56-72`).

### 2.3 Scoping (a subtle, documentable behaviour)

BYOK rows are stored per `(organization, workspace, provider)`. The organization BYOK page
deliberately writes to a **hidden global scope**, not to whichever workspace the user has
open: `ByokPage` calls the server function `getOrganizationScopeWorkspaceId` and passes the
result as an explicit `workspaceId` (byok-page.tsx:17-46). The store resolves an absent
`workspaceId` to `receiptGlobalScopeId(organizationId)` =
`ws_global_<md5>` (`provider-key-store.ts:74-78`;
`packages/receipt-app/src/services/receipt-workspaces.ts:149-150`). Tests assert the
isolation: an organization-wide key is not visible from a named workspace and vice versa
(`provider-key-store.test.ts:331-365`), and organizations do not see each other's keys
(`:367-397`).

### 2.4 Validation

Two layers, both must pass:
1. **Format** — `validateProviderApiKeyFormat`
   (`apps/start/src/lib/shared/model-policy/provider-keys.ts:72-107`):
   - empty → `"Provider API key is required."`
   - OpenAI must start with `sk-` → `"OpenAI API keys must start with \"sk-\"."`
   - Anthropic must start with `sk-ant-` → `"Anthropic API keys must start with \"sk-ant-\"."`
   - other providers get only the non-empty check.
2. **Live authentication** — `validateProviderApiKey`
   (`apps/start/src/lib/backend/byok/services/provider-key-validation.service.ts:24-78`).
   A bounded, non-mutating request:
   - OpenAI: `GET https://api.openai.com/v1/models` with `Authorization: Bearer <key>`.
   - Anthropic: `GET https://api.anthropic.com/v1/models?limit=1` with `x-api-key` and
     `anthropic-version: 2023-06-01`.
   - Timeout **10 000 ms** (`DEFAULT_VALIDATION_TIMEOUT_MS`, line 6).
   - `401`/`403` → `"Unable to connect to {OpenAI|Anthropic}. Verify that your
     {OpenAI|Anthropic} API key is valid."` (`retryable: false`).
   - Any other non-OK status → `"{OpenAI|Anthropic} could not validate this API key right
     now. Try again shortly."` (`retryable: true`).
   - Network/abort → `"{OpenAI|Anthropic} could not validate this API key right now. Check
     your connection and try again."`.
   - Response bodies are deliberately ignored (comment lines 16-23).

Validation runs **before** encryption and persistence
(`byok-executor.service.ts:150-162`), so a revoked key never becomes durable state.

### 2.5 ZDR interaction — the confirmation dialog

If the organization has `require_zdr` on, saving a BYOK key first opens a dialog
(byok-form.tsx:132-176, `messages/en.json:387-389`):
- Title: **"Disable ZDR for this provider?"**
- Body: **"Your organization requires ZDR right now. Saving a {providerName} API key will
  turn off ZDR enforcement for {providerName} requests that use your org key. Other
  providers keep their current ZDR behavior."**
- Confirm button: **"Save key and disable ZDR"**.

That is not marketing copy — it is literally how the policy engine behaves: an active
executable org provider key sets `bypassesZdrCompliance` and skips the compliance check for
that model (`apps/start/src/lib/shared/model-policy/policy-engine.ts:38-48`, with
`hasActiveOrgProviderKeyForModel` at `provider-keys.ts:53-63`).

### 2.6 Precedence at request time (platform credits vs BYOK vs Models account)

All of this is in
`apps/start/src/lib/backend/chat/services/model-policy.service.ts` (`resolveThreadModel`,
lines 121-438). Order of resolution once the model has passed catalog + policy checks:

1. **Workspace Models account** (§1.1) wins first: if `workspaceId` and `userId` are present
   and `resolveModelProviderAccountCredential` returns a credential that can route the model,
   the request uses that key (lines 278-317).
2. **Short-circuit to platform credit**: if strict mode is off *and* the persisted
   `providerKeyStatus` snapshot says the org has no provider keys at all, the request
   resolves with no override — i.e. it runs on the shared AI Gateway and consumes platform
   credit (lines 319-332).
3. **Org BYOK key**: candidate providers are `selectedModel.providers` filtered to
   `BYOK_EXECUTABLE_PROVIDERS`, evaluated in declared order; the first provider with a
   resolvable key wins and becomes `providerApiKeyOverride` (lines 340-414). The comment at
   334-339 states the rule: "derive candidate providers from model.providers, keep only
   providers the gateway can actually execute against, evaluate keys in declared order so
   behavior stays deterministic."
4. Otherwise, fall through to no override → gateway/platform credit (lines 429-437).

`EffectiveModelResolution.providerApiKeyOverride` carries the contract: "When present,
runtime model execution **must** use this key and must not fall back to system credentials."
(`apps/start/src/lib/shared/model-policy/types.ts:88-95`).

### 2.7 `CHAT_REQUIRE_BYOK`

Read once, as a plain string comparison:

```ts
function isStrictProviderKeyPolicyEnabled(): boolean {
  return process.env.CHAT_REQUIRE_BYOK === 'true'
}
```
(`model-policy.service.ts:38-40`). Declared in `apps/start/.env.example:128` as
`CHAT_REQUIRE_BYOK=false` under the comment "Optional strict mode. Set true only when every
model request must use a workspace-managed provider key instead of the platform-credit
gateway." (lines 126-127).

When `true`, three additional denials apply, each producing a
`ModelPolicyDeniedError` with message `"Selected model is not allowed for this request"`
and a machine `reason`:
- no organization on the request → `policy_denied:missing_org_context_for_provider_key` (lines 265-276);
- model has no BYOK-executable provider → `policy_denied:provider_not_supported_by_byok:{providerId}` (lines 345-355);
- no key found for any candidate provider → `policy_denied:missing_provider_api_key:{providerId}` (lines 416-425).

User-visible strings for those failures come from the error i18n mapping
(`apps/start/src/lib/backend/chat/domain/error-classification.ts:314-325`,
`apps/start/messages/en.json:324-328`):
- `missing_provider_api_key` → **"This provider requires an organization API key, but no key is configured."**
- `model_not_supported_for_provider_key` → **"This model cannot be used with your organization provider API key. Choose another model from that provider or remove the provider key."**
- `free_tier_model_denied:` → **"This model requires a paid plan to use."**
- anything else → **"The selected AI model is not allowed for your organization."**
- Invalid key at execution time → **"Unable to connect to the AI service. Verify that your organization OpenAI API key is valid."**
All model-policy denials return HTTP **403** (`error-classification.ts:119-125`).

### 2.8 AI Gateway / platform credit

`.env.example:120-124`: "Hosted requests without a workspace BYOK key use AI Gateway and
consume the workspace's platform-credit balance. Workspace BYOK keys take precedence." The
relevant env vars are `AI_GATEWAY_API_KEY` and `ANTHROPIC_API_KEY` (lines 123-124). Catalog
rows name `gateway` / `openrouter` as route provider ids and the runtime uses the **full
catalog id** for those, versus the id with the prefix stripped for direct providers
(`apps/start/src/lib/shared/ai-catalog/index.ts:110-130`, and the doc comment at
`types.ts:125-129`).

---

## 3. Provider policy, compliance policy, and policies

Three separate routes, easily confused. `provider-policy` and `compliance-policy` share one
underlying data model with the Models pages; `policies` is a different, receipt-backed
system.

### 3.1 `/organization/settings/provider-policy` — "Provider policy"

Component: `model-policy/provider-policy-page.tsx:15`.
Title **"Provider policy"**, description **"Configure provider and model restrictions and
compliance flags for your organization."** (`messages/en.json:507-508`).

Renders three sections in order:

**(a) Compliance flags** — `compliance-flags-section.tsx:111`, three independent `Form`
cards each with a header toggle:

| Card title | Description | Help | Backing value |
|---|---|---|---|
| **"Require ZDR (Zero Data Retention)"** | "Only allow models from AI providers that do not retain data. This is enforced at the provider level." | "Applies immediately to model availability." | `complianceFlags.require_zdr` |
| **"Require organization provider key"** | "Only allow models from providers that have an active organization API key." | "Applies immediately to provider availability." | `complianceFlags.require_org_provider_key` |
| **"Enforce Study Mode"** | "Force organization chat requests to use Study Mode and lock the toggle." | "Applies immediately to new chat requests." | `enforcedModeId === 'study'` |

(`messages/en.json:394-402`; component lines 17-109.) The "Require organization provider
key" card defaults to *disabled* when no feature-access state is supplied
(`byokEnabled = featureAccess?.allowed ?? false`, line 54) whereas the other two default to
enabled (`?? true`).

**(b) Provider controls** — `provider-controls-section.tsx:27`. Title **"Providers"**,
description **"Enable or disable AI providers for your organization."**, help
**"Changes apply immediately. Disabled providers and their models are unavailable to the
organization."** (`messages/en.json:473-475`). One toggle per catalog provider (11 rows),
each with the provider icon, a short blurb from `PROVIDER_META`
(`provider-constants.ts:28-64` — e.g. OpenAI "Models including GPT-4o and o1 for chat,
reasoning, and tool use."), and a **"View all models"** link
(`aria-label="View all models for {providerName}"`) to `/organization/settings/models/$providerId`.
Toggle checked = **enabled**.

**(c) Model controls** — `model-controls-section.tsx:21`. Title **"Model Controls"**,
description "Override model availability per model. Disabled by provider or compliance
policy is shown in the description.", help "Changes apply immediately. You can override a
provider-level denial per model here.", section header "Models"
(`messages/en.json:451-455`). Each row's description is `"{modelId} · Disabled by: {sources}"`
where sources is the comma-joined `deniedBy`. **Careful:** here `checked` means *disabled*
(`checked: payload.policy.disabledModelIds.includes(model.id)`, line 51) — the opposite of
the per-provider page in §1.2. This is a real inconsistency in the product and docs should
describe each screen's toggle semantics explicitly rather than generalise.

### 3.2 `/organization/settings/compliance-policy` — "Compliance & Policy"

Component: `compliance-policy/compliance-policy-page.tsx:13`. Title
**"Compliance & Policy"**, description **"Configure organization-level AI rules and access
policies."** (`messages/en.json:408-409`). It renders **only** the same
`ComplianceFlagsSection` as §3.1(a) — i.e. it is a subset of `/provider-policy`, not a
distinct feature. No-active-org body: "Switch to an organization to manage organization-level
compliance policies." (`compliance-policy/route.tsx:22`, `messages/en.json:509`).

### 3.3 The policy record and where it is enforced

All of §3.1/§3.2 writes one row in the Postgres table **`org_ai_policy`**, replicated to the
browser through Zero (`apps/start/src/integrations/zero/schema.ts:64-87`). Columns:
`disabled_provider_ids`, `disabled_model_ids`, `compliance_flags`,
`provider_native_tools_enabled`, `external_tools_enabled`, `disabled_tool_keys`,
`org_knowledge_enabled`, `provider_key_status`, `enforced_mode_id`, `updated_at`.

Read query: `queries.orgPolicy.current()`
(`apps/start/src/integrations/zero/queries/org-policy.queries.ts:21-32`) — visible to any
member of the active org; the comment (lines 15-20) says visibility deliberately does not
depend on role because the client does not hydrate roles, and the **write** path does the
authoritative check.

Writes: `mutators.orgPolicy.*`
(`apps/start/src/integrations/zero/mutators/org-policy.mutators.ts:256-...`), seven mutators:
`toggleProvider`, `toggleModel`, `toggleComplianceFlag`, `setEnforcedMode`,
`toggleProviderNativeTools`, `toggleExternalTools`, `toggleTool`
(also enumerated as the UI action union in `model-policy/types.ts:37-69`). Each one:
1. `requireOrgPolicyAdmin` — on the server, re-reads the `member` row and throws
   "Only workspace owners or admins can manage organization settings." if the role is not
   owner/admin (lines 122-158);
2. `requireOrgFeature` with a `WorkspaceFeatureId` (`providerPolicy` for provider/model/mode,
   `compliancePolicy` for flags, `toolPolicy` for tool switches) (lines 160-182);
3. validates the id against the catalog (`Unknown provider id: …` / `Unknown model id: …` /
   `Unknown mode id: …`);
4. reads-modifies-writes the whole snapshot (`persistOrgPolicy`, lines 213-251).

Defaults when no row exists (`toSnapshot`, lines 185-207):
`disabledProviderIds: []`, `disabledModelIds: []`, `complianceFlags: {}`,
`providerNativeToolsEnabled: true`, `externalToolsEnabled: true`, `disabledToolKeys: []`,
`orgKnowledgeEnabled: false`, `providerKeyStatus: { syncedAt: 0, hasAnyProviderKey: false,
providers: { openai: false, anthropic: false } }`, `enforcedModeId: undefined`.

**Enforcement points in the chat request path** (this is what docs need to state precisely):

| Rule | Where enforced | Effect |
|---|---|---|
| `disabledProviderIds` | `evaluateModelAvailability`, `apps/start/src/lib/shared/model-policy/policy-engine.ts:31-33`, called from `ModelPolicyService.resolveThreadModel` (`model-policy.service.ts:209-223`) | 403, reason `policy_denied:provider` |
| `disabledModelIds` | same, `policy-engine.ts:34-36` | 403, reason `policy_denied:model` |
| `require_zdr` | `isDeniedByComplianceFlags` (`apps/start/src/lib/shared/ai-catalog/compliance-map.ts:13-20`) via `policy-engine.ts:43-48` | 403, reason `policy_denied:compliance`; **bypassed for a model whose route provider has an active executable org key** (`policy-engine.ts:38-42`) |
| `enforcedModeId` | `resolveEffectiveChatMode`, `apps/start/src/lib/shared/chat-modes/resolver.ts:14-27` — the org mode wins over request and thread mode and is returned with `isEnforced: true` | Study Mode pins model `openai/gpt-oss-120b`, injects its system prompt, and disables provider-native tools for openai/anthropic/google/xai (`apps/start/src/lib/shared/chat-modes/registry.ts:8-25`) |
| `providerNativeToolsEnabled` / `externalToolsEnabled` / `disabledToolKeys` | `resolveToolPolicy`, `apps/start/src/lib/shared/chat/tool-policy.ts:99-118`, called via `ToolPolicyService` from the chat orchestrator (`chat-orchestrator.service.ts:213, 448`) | tool dropped from the request with reason `blocked_by_org_master_switch` / `blocked_by_external_tools_switch` / `blocked_by_org_policy` |
| `orgKnowledgeEnabled` | `apps/start/src/lib/backend/chat/services/message-store/operations/load-thread-messages.ts:428-432` | gates org-knowledge retrieval into the prompt |
| `providerKeyStatus` | `model-policy.service.ts:255-263, 319-332, 359-366` | short-circuits key lookup; also feeds the ZDR bypass |

**`require_org_provider_key` is a documented gap.** The flag exists in the type
(`compliance-map.ts:5-11`, "model usage is restricted to providers that have an active
organization API key configured in WorkOS Vault") and has a UI toggle, but
`isDeniedByComplianceFlags` only checks `require_zdr` (`compliance-map.ts:13-20`) — nothing
in the request path reads `require_org_provider_key`. Do not document it as enforced.
(Also note the type comment mentions "WorkOS Vault"; the actual store is the
`org_provider_api_key` Postgres table with `BYOK_ENCRYPTION_KEY_B64` — a stale comment.)

### 3.4 `/organization/settings/policies` — "Policies"

Component: `policies/policies-page.tsx:53`. Title **"Policies"**, description
**"Configure organization-wide policies."** (`messages/en.json:437-438`).
Five URL-backed tabs (`?tab=`), validated by zod at the route
(`policies/route.tsx:15-25`) and declared at `policies-page.tsx:30-36`:

| tab value | Label | Icon |
|---|---|---|
| `rate-limiting` (default) | **"Rate limiting"** | `Gauge` |
| `budgets` | **"Budget limiting"** | `CircleDollarSign` |
| `logging` | **"Logging config"** | `ScrollText` |
| `guardrails` | **"Guardrails"** | `ShieldCheck` |
| `tool-approval` | **"Tool approval"** | `FileCheck2` |

The **Guardrails tab is a hand-off**, not a duplicate: empty-state title
**"Guardrails live on their own page"**, body "Guardrail groups inspect what your agents
send and receive, and every change writes a receipt. They are configured on the Guardrails
page, which is fully connected — unlike the modules alongside it here.", button
**"Open Guardrails"** (policies-page.tsx:127-142). That copy also tells you the other four
modules are **not** connected to enforcement.

Rule shapes (`apps/start/src/lib/shared/policies.ts`):
- Windows: `minute | hour | day | week | month`, labelled "per minute" … "per month"
  (lines 16-24, 124-130).
- Filters: `PolicySubjectKind` = `users | teams | workspaces | models | metadata`,
  labelled Users/Teams/Workspaces/Models/Metadata; operator `in` | `not_in`
  (lines 33-49, 132-138). `describeScope([])` returns **"All requests"** (lines 167-172).
- **RateLimitRule**: `{ limit: number, unit, filters, enabled }` (51-59). Editor defaults
  `limit '1000'`, `unit 'day'` (`rate-limit-panel.tsx:37`). Column renders
  `"{limit} requests {per day}"` (128-130). Validation: whole number > 0, message
  "Enter a whole number greater than zero." (181-185).
- **BudgetRule**: `{ amountUsd: number, unit, filters, enabled }` — "Cap in whole currency
  units (USD)" (61-70). Editor defaults `amount '100'`, `unit 'month'`
  (`budget-panel.tsx:37`).
- **LoggingRule**: `{ logRequests: boolean, redactions: string[], filters, enabled }`
  (76-84). Defaults `logRequests: true`, no redactions (`logging-panel.tsx:29-34`). Doc
  comment: "A redaction removes a named field from the stored copy of a request. The request
  still reaches the model intact; only the log is altered." (72-75).
- **ToolApprovalRule**: `{ tools: string[], frequency, intervalHours, channel, approvers,
  enabled }` (105-115). Channels `email | slack | webhook | pagerduty` labelled
  Email/Slack/Webhook/PagerDuty (86-93, 140-145). Frequencies `once | session | interval`
  labelled **"Every time" / "Once per session" / "After an interval"** (101-103, 147-151).
  Defaults `frequency 'once'`, `intervalHours '24'`, `channel 'email'`
  (`tool-approval-panel.tsx:40-47`).

Evaluation-order copy shown above each list (`PolicyPanelIntro`):
- Rate limiting: "Each request is checked against these rules in order, and only the first
  match applies. Keep specific rules above general ones — a catch-all at the top will
  shadow everything beneath it." (`rate-limit-panel.tsx:95-98`).
- Budget: "Budgets cap spend for the traffic they match over a rolling window. Like rate
  limits, the first matching rule wins, so order specific budgets above organization-wide
  ones." (`budget-panel.tsx:96-98`).
- Logging: "Control which gateway requests are recorded and which fields are masked in the
  stored copy. Redaction changes only the log — the model still receives the original
  request." (`logging-panel.tsx:94-96`).
- Tool approval: "Require a human decision before sensitive agent tools run. Every policy
  covering a tool applies to it, and the agent waits until an approver responds on the
  channel you choose." (`tool-approval-panel.tsx:128-130`); the code comment adds that this
  module is unordered, unlike the first-match modules (lines 118-122).

**Persistence and audit.** Rules are receipt streams, not plain rows.
`packages/receipt-app/src/services/policies.ts` defines four events —
`organization.policy_rule.created|updated|enabled_changed|deleted` (lines 53-84) — folded
into `receipt_org_policy_rule_projection`. Rule ids are `pol_{module}_{hash(seed)}`
(lines 160-166; the comment explains they carry randomness so two rules may share a name,
unlike guardrail groups). Limits (`POLICY_LIMITS`, lines 25-33): `maxNameLength 120`,
`maxRulesPerOrganization 200`, `maxFilters 20`, `maxFilterValues 100`, `maxRedactions 50`,
`maxApprovers 50`, `maxTools 100`. Deletion drops the projection row but keeps the receipt
chain (comment lines 76-80).

**Enforcement status: none.** A repo-wide grep finds no consumer of `listPolicyRules` or the
`receipt_org_policy_rule_projection` table outside the settings UI and its own server
module. The shared type file states it plainly: "These types describe the shape the eventual
backend must return." (`apps/start/src/lib/shared/policies.ts:9-13`). Rate limits, budgets,
logging redaction, and tool approval are **configured and audited but not applied to
traffic** at this checkout. Docs must not imply otherwise.

---

## 4. Guardrails — `/organization/settings/guardrails`

Component: `apps/start/src/components/organization/settings/guardrails/guardrails-page.tsx:61`.

Header (`PageHeader`, lines 122-139):
- Title: **"Guardrails"**
- Description: **"Rules that inspect what your agents send and receive — catching secrets,
  personal data, and prompt injection before they reach a model or leave your organization."**
- Action button: **"New guardrails group"**.

Controls: search `placeholder="Search guardrails and groups"` / `aria-label="Search guardrails"`
(lines 157-166), and a **"Show archived"** switch (167-179).

Empty state (`GuardrailsEmptyState`, lines 375-388): title **"No guardrails yet"**, body
**"Create a group to hold your rules, then add guardrails to it. Every guardrail runs inside
Receipt."**, button "New guardrails group".

Table (`guardrail-table.tsx:82-223`), one row per guardrail, columns:
**# / Guardrail / Group / Mode / Enforcing strategy / Runs on / Enabled / Actions**.
Group badges: **"Archived"** or **"Group off"**. The Enabled switch toggles the **group**,
not the individual guardrail (`onToggleGroup`, line 156). Row menu: **"Edit guardrail"**,
**"Remove guardrail"**, then a group label with **"Add guardrail"**, **"Test group"**,
**"Edit group"**, **"Delete group"**.

### 4.1 The guardrail catalog

`apps/start/src/lib/shared/guardrails.ts:151-357` — **8 kinds**, all `family: 'receipt'`
(run in-process; the picker copy says "Every guardrail runs inside Receipt.",
`guardrail-picker.tsx:53-56`):

| id | Name | Default operation | Supported | Default stages | Config fields |
|---|---|---|---|---|---|
| `secrets_detection` | **Secrets Detection** | mutate | validate, mutate | input, output, tool | Minimum severity; Replacement text (default `[redacted]`); Allowed values |
| `pii_phi` | **PII / PHI** | mutate | validate, mutate | input, output | Categories (default `email, phone, ssn, credit_card`; also `ip_address`); Replacement text; Minimum severity |
| `prompt_injection` | **Prompt Injection** | validate | validate | input, tool | Minimum severity; "Also inspect tool results" (default true) |
| `regex_pattern` | **Regex Pattern Match** | validate | validate, mutate | input, output | Patterns (**required**, JS regex, case-insensitive); Replacement text |
| `content_moderation` | **Content Moderation** | validate | validate | input, output | Categories (default `harassment, hate, self_harm, sexual, violence`); Minimum severity |
| `code_safety` | **Code Safety Linter** | validate | validate | tool, output | Minimum severity; Allowed commands |
| `sql_sanitizer` | **SQL Sanitizer** | validate | validate | tool | "Block writes with no WHERE clause" (default true); Minimum severity |
| `word_blocklist` | **Word Blocklist** | mutate | validate, mutate | input, output | Blocked terms (**required**); Replacement text |
| `request_metadata` | **Request Metadata Validation** | validate | validate | input | Required keys (**required**) |

(That is 9 rows — `request_metadata` is the ninth entry; the detector map
`GUARDRAIL_DETECTORS` in `packages/receipt-app/src/services/guardrail-detectors.ts:488-497`
holds 8 and `request_metadata` is handled separately in the evaluator,
`guardrail-enforcement.ts:97-101`.)

Descriptions, verbatim, are worth reproducing in docs — e.g. Secrets Detection: "Finds
credentials that should never leave your systems — cloud keys, API tokens, JWTs, and private
key blocks."; Prompt Injection: "Catches attempts to override the system prompt, exfiltrate
instructions, or jailbreak the agent." (`guardrails.ts:151-357`).

Severity select options: **"Low — flag everything" / "Medium — balanced" / "High — only
strong matches"**, default `medium`, help "Matches below this severity are recorded but
never block." (`guardrails.ts:133-144`).

### 4.2 Vocabulary and semantics

- **Operation** (`guardrails.ts:15`): `validate` blocks the run; `mutate` masks the offending
  span and lets the run continue. Labels "Validate" / "Mutate" (48-50).
- **Enforcing strategy** (22-26, labels 52-63, hints 65-76): what happens when the guardrail
  *itself* fails.
  - `enforce` → **"Enforce"** — "Block the run if this guardrail trips, and also if the
    guardrail itself fails to run."
  - `enforce_but_ignore_on_error` → **"Enforce but ignore on error"** — "Block the run if
    this guardrail trips, but let the run through if the guardrail itself errors." *(default
    for new guardrails — `guardrail-editor-dialog.tsx:60-61`, and the server default at
    `guardrails.server.ts:188-189`)*
  - `monitor_only` → **"Monitor only"** — "Never block. Record every match so you can see
    what would have been caught."
- **Stage** (28, labels 78-87): `input` → **"Prompt"**, `output` → **"Response"**,
  `tool` → **"Tool traffic"**.
- Group summary helper: "{n} active guardrails · {n} blocking · {n} masking", or
  "No active guardrails" (`guardrails.ts:496-513`).
- Evaluation rules (`packages/receipt-app/src/services/guardrail-enforcement.ts`):
  `mutate` guardrails never block on their own (lines 64-72); a guardrail whose detector is
  missing throws "No detector is available for '{kindId}'. It is configured but not
  enforcing." and the strategy decides whether that stops the run (lines 104-116); findings
  below the severity threshold are ignored (129-133); the block explanation never echoes
  matched text (`describeGuardrailBlock`, 158-182) and reads
  `Blocked by guardrail "Name": reason.`

### 4.3 Limits

`GUARDRAIL_LIMITS` (`apps/start/src/lib/shared/guardrails.ts:405-413`):
`maxNameLength 120`, `maxDescriptionLength 2000`, `maxGuardrailsPerGroup 64`,
`maxAccessEntries 64`, `maxListEntries 128`, `maxListEntryLength 512`, `maxPatternLength 512`.
The server copy adds `maxConfigBytes 32768`
(`packages/receipt-app/src/services/guardrails.ts:18-26`).

Validation messages (`guardrails.ts:430-459`): "Enter a name for this group." /
"Enter a name for this guardrail." / "Names must be 120 characters or fewer." /
"Use at least one letter or number in the name." / "Enter a pattern." /
"Patterns must be 512 characters or fewer." / "This is not a valid regular expression."
Server-side additions (`guardrails.server.ts`): "Unknown guardrail type '{kindId}'.",
"{Name} does not support the '{operation}' operation.",
"Choose at least one place for this guardrail to run.",
"{Field} is required for {Name}.", "Add at least one guardrail to this group.",
"A guardrail group named '{name}' already exists.".

### 4.4 Events, storage, and access

Receipt-sourced. Events (`packages/receipt-app/src/services/guardrails.ts:59-119`):
`organization.guardrail_group.created`, `.updated`, `.enabled_changed`,
`organization.guardrail.added`, `.updated`, `.removed`,
`organization.guardrail_group.archived`, `.deleted`.
Stream id: `organizations/{orgId}/guardrail-groups/{groupId}` (lines 204-215).
Group id: `grp_{hash(orgId:slug)}` — deterministic, so two admins creating the same name
converge on one stream (lines 174-187). Guardrail id: `gr_{hash(groupId:kindId:seed)}` (201).
Projection table: **`receipt_org_guardrail_group_projection`** (505, 610, 625).
Deletion drops the projection row and frees the name but keeps the receipts (comment 109-113).

Zero replication is restricted to owners/admins **inside the query itself**
(`apps/start/src/integrations/zero/queries/guardrails.queries.ts:20-42`), with the reasoning
spelled out at lines 10-17: "Guardrail configuration reveals what an organization considers
sensitive — the regexes protecting internal identifiers, the terms it blocks."

Server functions (`apps/start/src/lib/frontend/guardrails/guardrails.functions.ts`):
`createGuardrailGroup`, `updateGuardrailGroup`, `setGuardrailGroupEnabled`, `addGuardrail`,
`updateGuardrail`, `removeGuardrail`, `archiveGuardrailGroup`, `deleteGuardrailGroup`,
`listGuardrailGroups`, `testGuardrailGroup`. Test input is capped at 20 000 characters
(line 131).

### 4.5 Test dialog

`guardrail-test-dialog.tsx`: title `Test {groupName}`, description **"Run this group's
guardrails against sample text. Nothing is saved and no live traffic is affected."**,
button **"Run test"**. Fields: **"Inspect as"** (Prompt / Response / Tool traffic) with note
"Only guardrails configured to run here will be applied.", and **"Sample text"** pre-filled
with `Here is my AWS key AKIAIOSFODNN7EXAMPLE and email me at person@example.com`
(lines 34-35, 82-118). Server: `testGuardrailGroupAction`
(`guardrails.server.ts:563-591`) runs `evaluateGuardrails` against the group's guardrails and
returns `{ allowed, text, violations, errors }`; "This guardrail group no longer exists."
if the group is gone.

### 4.6 Confirmation dialogs

- Remove guardrail: title `Remove {name}?`, body **"This guardrail stops inspecting traffic
  immediately. The change is recorded in the group's receipt history."**, confirm
  **"Remove guardrail"** (guardrails-page.tsx:291-308).
- Delete group: title `Delete {name}?`, body `This removes the group and its {n} guardrail(s).
  Its receipt history is kept, and the name becomes available again.`, confirm
  **"Delete group"**, destructive (310-325).

### 4.7 Missing-migration panel (self-hosting relevant)

If the projection table is absent (Postgres `42P01`), the page swaps in a panel
(guardrails-page.tsx:338-373) titled **"Guardrails storage is not set up yet"** with the
literal remediation:

```
docker compose -f docker-compose.postgres.yml up -d
cd apps/start && bun run zero:migrate
```

and the note "A restart is needed because the replication layer builds its table list at
startup."

### 4.8 Where guardrails are enforced — **currently nowhere in the chat path**

`apps/start/src/lib/backend/chat/services/guardrail-enforcement.service.ts` exists and is
fully written: `applyGuardrails` plus `guardPrompt` / `guardResponse` / `guardToolResult`
wrappers (lines 82-131), with a **10 s per-organization cache** (`CACHE_TTL_MS = 10_000`,
line 20) and `invalidateGuardrailCache` (lines 30-33). It loads
`listEnforceableGuardrails` — groups that are `enabled` **and** `status === 'active'`, then
each guardrail that is itself `enabled`
(`packages/receipt-app/src/services/guardrails.ts:635-646`). Config-load failure is
deliberately non-blocking (comment lines 73-81).

**However, a repo-wide grep for `guardPrompt|guardResponse|guardToolResult|applyGuardrails`
finds no call site.** The only importer of this module is
`guardrails.server.ts:94-97`, which imports `invalidateGuardrailCache` after a write. So at
this checkout guardrails are **authored, versioned, testable in the dialog, and cached — but
not applied to live chat traffic**. The Policies page's own copy already concedes the
inverse framing ("the Guardrails page, which is fully connected"), so this is a genuine
docs-vs-code conflict to resolve with the team before publishing.

---

## 5. Skills — `/organization/settings/skills`

Component: `apps/start/src/components/organization/settings/skills/skills-page.tsx:274`.

- Title **"Skills"**; description **"Add organization instructions that agents can use in
  Factory and computer runs. Enabled skills are available to new runs."** (lines 370-371).
- Search `placeholder="Search skills"` / `aria-label="Search organization skills"`; primary
  button **"Add skill"** (becomes **"Adding skill"** with a spinner while uploading)
  (lines 415-436).
- Count line: `Showing {n} of {m} matching skills ({total} total)` or "Loading skills"
  (lines 448-452).
- Table columns: **# / Skill / Status / Version / Bundle / Updated / Actions**
  (`organization-skills-table.tsx:78-91`). Skill cell shows name, `/slug` in monospace, and
  the description. Status badge: **"Archived" / "Enabled" / "Disabled"** (line 140).
  Version renders as `v{n}` (lines 40-43); bundle size uses B / KB / MB (45-49).
- Empty state (`organization-skills-empty-state.tsx:86-96`): title **"No organization skills
  yet"**, body **"Upload a SKILL.md bundle to make reusable instructions available to new
  agent and computer runs."**, button **"Add your first skill"**. The decorative preview
  cards are "Plan implementation", "Review pull request", "Investigate incident" (lines 10-26).
- No-search-match: **"No skills found. Try a different search."** (skills-page.tsx:484-486).
- Delete dialog: title **"Delete skill?"**, body `Delete {name}? It will be removed from this
  list and will no longer be available to new agent or computer runs.`, help
  **"Existing receipts keep their version and content hash for audit, and the skill name
  becomes available again."**, button **"Delete"** (lines 386-402).
- Detail dialog: description **"Read-only organization skill instructions from the
  authoritative receipt-backed bundle."**; shows **Slug / Version / Content hash**, a file
  picker (`aria-label="Skill file"`) when more than one file, and a **"Copy file"** button
  that becomes **"Copied"** (lines 139-266). Binary files show
  `Binary file · base64 encoded · {size}`. Copy failure:
  "Unable to copy this file. Select the text and copy it manually."

### 5.1 Format and limits

Upload contract (`apps/start/src/lib/shared/org-skills.ts:1-37`):
- Accept string: `.md,.markdown,text/markdown`.
- The file **must be named `SKILL.md`** (case-insensitive) → otherwise
  **"Choose a file named SKILL.md."**
- Empty → "The skill file is empty."
- `ORGANIZATION_SKILL_MAX_BYTES = 256 * 1024` → **"Skill files must be 256 KB or smaller."**

Server-side bundle limits (`packages/receipt-app/src/services/organization-skills.ts:9-16`):
`maxFiles 128`, `maxTotalBytes 1 MiB`, `maxPathBytes 240`, `maxNameLength 120`,
`maxDescriptionLength 2000`, `maxSourceIdBytes 256`. So the UI takes a single `SKILL.md`
(`parseOrganizationSkillUpload`, lines 401-412), while the underlying bundle format supports
up to 128 files — that difference is worth stating.

**Frontmatter contract** (`parseOrganizationSkillFrontmatter`, lines 254-297): the file must
open with a `---` line, close with another `---`, and provide `name:` and `description:`.
Folded (`>`) and literal (`|`) blocks are supported for the description; anything else is a
"deliberately small frontmatter contract… not a permissive general-purpose YAML parser"
(comment 249-253). Errors: "SKILL.md must start with YAML frontmatter.",
"SKILL.md frontmatter is not closed.", "Skill name exceeds 120 characters.",
"Skill description exceeds 2000 characters."

### 5.2 Versioning, receipts, storage

Events (`organization-skills.ts:53-107`): `organization.skill.created` (version must be 1),
`.version_added` (version ≥ 2), `.save_acknowledged`, `.enabled_changed`, `.archived`,
`.deleted`. Uploading the same slug again adds a **new version**; the UI clears the file
input so the same file can be re-uploaded as a replacement version
(`skills-page.tsx:331-334`). Two projections: `receipt_org_skill_projection` (metadata,
replicated to admins via Zero) and `receipt_org_skill_bundle_projection` (file bytes,
server-only). Deletion drops both rows (comment 650-661; events comment 93-101 explains why
deletion exists alongside archive).

Zero query is owner/admin-scoped
(`apps/start/src/integrations/zero/queries/org-skills.queries.ts:13-35`) with the comment
"Organization admins can inspect skill metadata; bundle contents stay server-only."
The `OrganizationSkillListItem` contract carries no file content by design
(`org-skills.ts:6-25`).

Server functions (`organization-skills.functions.ts`): `uploadOrganizationSkill` (multipart),
`setOrganizationSkillEnabled`, `archiveOrganizationSkill`, `deleteOrganizationSkill`,
`getOrganizationSkillDetail` (fetched only when the detail dialog opens — comment 72-76).

Skills can also be authored from app chat: `OrganizationSkillAppChatSource`
(`organization-skills.ts:45-51`) records `chatId`, `runId`, optional `objectiveId` and
`assistantMessageId`, and that path re-checks membership against the authoritative table
rather than ambient headers (`organization-skills.server.ts:47-77`) — the failure message is
**"Only organization owners or admins can save organization skills. No skill changed."**

### 5.3 How an enabled skill reaches a run

`listEnabledOrganizationSkillBundles` is called by the Factory task packet writer
(`packages/receipt-app/src/services/factory/runtime/task-runtime-packet-writer-service-deps.ts:31-45`),
threaded through `writeTaskPacket`
(`.../task-packet-writer-core.ts:39-51, 89-95`) into the workbench projection, and mounted
into the guest workspace at **`receipt/skills/organization/`** with an index at
**`receipt/skills/index.json`**
(`packages/receipt-app/src/services/factory/organization-skill-registry.ts:9-10`).
Registry guards: `MAX_FILES_PER_SKILL 256`, `MAX_FILE_BYTES 4 MiB`, `MAX_SKILL_BYTES 8 MiB`
(lines 11-13); files are chmod'd 0600/0700 (lines 20-37). The projection comment
(`workbench-projection.ts:32-37`) explains the placement: skills stay outside `CODEX_HOME`
"so Codex can discover them through the catalog without eagerly activating every skill
instruction."

---

## 6. Knowledge and Org Brain

Two distinct pages that are easy to conflate.

### 6.1 `/organization/settings/knowledge` — "Knowledge" (URL-only)

Component: `org-knowledge/org-knowledge-page.tsx:113`.
Heading `m.org_knowledge_page_heading()` = **"Organization Knowledge"**; description
**"Upload Markdown or PDF files for your organization's knowledge base."**
(`messages/en.json:626-627`). Nav name is "Knowledge" (`org_knowledge_page_title`,
`messages/en.json:628`) but the item is `hiddenFromRail` **and** `hiddenFromMenu`
(nav.ts:292-299) — reachable only by typing the URL.

This is organization-wide RAG over uploaded documents:
- Accept: `.pdf,.md,.markdown,text/markdown,application/pdf`
  (`apps/start/src/lib/shared/org-knowledge.ts:12`); allowed extensions `pdf, md, markdown`
  (`apps/start/src/lib/shared/upload/upload-validation.ts:69`); max size
  **25 MB** (`ORG_KNOWLEDGE_MAX_UPLOAD_SIZE_BYTES = 25 * 1024 * 1024`,
  `apps/start/src/lib/shared/upload/upload.model.ts:3`). Chat attachments are 10 MB by
  contrast (upload.model.ts:1).
- Rows are `attachments` records discriminated by `ORG_KNOWLEDGE_KIND = 'custom_rag'`
  (`org-knowledge.ts:1-5`).
- Table columns: **File / Status / Last indexed** plus an actions menu
  (`messages/en.json:625, 623, 622`; component lines 155-240).
- Status badges: **"Active" / "Inactive"** and index state **"Index error" / "Indexed" /
  "Pending index"** (`messages/en.json:629-630, 623-624`). "Not indexed yet" when never
  indexed (`messages/en.json:626`).
- Row menu: **"Activate"/"Deactivate"**, **"Retry index"**, **"Delete"**
  (`messages/en.json:617-620`); `aria-label` = "Actions for {name}".
- Filter input placeholder **"Filter knowledge files..."**; empty state
  **"No organization knowledge files have been uploaded yet."**; loading
  **"Loading organization knowledge..."** (`messages/en.json:621, 620, 625`).
- Upload button label **"Upload file"** (`messages/en.json:631`).
- Index errors are summarised rather than surfaced raw — "Vector indexing timed out",
  "Vector store request failed", "Vector indexing is not configured", "File conversion failed
  during indexing", "Vector indexing failed" (`org-knowledge.ts:19-37`), because raw errors
  "can include internal paths or backend details".
- Activating at least one file flips `org_ai_policy.org_knowledge_enabled` to true
  (`apps/start/src/lib/backend/org-knowledge/services/org-knowledge-repository.service.ts:254`,
  `orgKnowledgeEnabled: activeCount > 0`), and that flag is what gates retrieval into chat
  prompts (`load-thread-messages.ts:428-432`). There is **no manual toggle** for it in the UI.
- Requires the vector stack: `VITE_ENABLE_EMBEDDING` and `QDRANT_URL`
  (`apps/start/.env.example:155, 181`).

### 6.2 `/organization/settings/knowledge-graph` — "Org Brain"

Component: `org-knowledge-graph/org-knowledge-graph-page.tsx:929`.
Title **"Org Brain"**, description **"A shared view of how knowledge and tools connect
across the organization."** (lines 973-974). This is a **read-only analytics dashboard over
Factory/agent activity**, not a knowledge store, and not a graph editor.

- Reporting period control (`role="group" aria-label="Reporting period"`) with
  **"Last 30 days" / "Last 60 days" / "Last 90 days"**; `ORG_GRAPH_WINDOW_DAYS = [30, 60, 90]`,
  default 30 (`org-knowledge-graph.types.ts:10`; component 900-926, 930-932).
- Freshness line: `Updated {time} · refreshes automatically`; the hook polls every
  **30 seconds** (`REFRESH_INTERVAL_MS = 30_000`, `use-org-knowledge-graph.ts:11`).
- Placeholder states: "Loading organization activity…" / "No activity to show yet."
  (component 993-996).
- Sections (component 1012-1116):
  1. **"Usage metrics across the organization"** — `Agent run volume, reliability, and cost
     over the last {n} days.` Six stat tiles: **Runs, Job success, In progress,
     Connected apps, Avg duration, Total spend**.
  2. **"Daily run activity"** — "Completed, failed, and in-flight runs per day."
  3. **"Application usage across the organization"** — "Share of organization objectives that
     used each application, plus connection readiness."
  4. **"Objectives"** — "The most recent completed, failed, and blocked objectives. Filter by
     status to narrow the list." Table columns **# / Objective / Status / Recorded / Actions**,
     search `placeholder="Search objectives"`, a status filter (`aria-label="Filter by status"`).
- Unmeasured values render as **"Not recorded"**, never as zero — the types file states this
  explicitly (`org-knowledge-graph.types.ts:1-8`, formatters at component 54-72).
- Provider display names are brand-cased via an override map (aws → AWS, google-mail → Gmail,
  incident-io → incident.io, …) (component 82-118).
- Snapshot shape (`org-knowledge-graph.types.ts:20-90`): totals (objectives, runs, completed,
  failed, canceled, running, successRate, avgDurationSeconds, totalCost, avgCost,
  cacheSavings), daily points, connection health per provider (total/valid/invalid/expired/
  lastValidatedAt), tool usage, and recent completed/failed objectives.
- **Read access is every organization member**, by design:
  `requireOrgReader` only requires org auth (`org-knowledge-graph.server.ts:24-34`), with the
  comment "Read access is deliberately every member, not just admins… never per-user
  attribution, raw receipts, or run contents." In practice the route guard still restricts
  this page to owners/admins (§0.1) — worth flagging as an inconsistency.

---

## 7. Tools — `/organization/settings/tools` (removed from the UI)

`apps/start/src/routes/(app)/_layout/organization/settings/tools/route.tsx:7-12`:

```ts
beforeLoad: () => { throw redirect({ to: '/organization/settings' }) }
```

with the comment "Hidden organization tools route. Keep direct visits predictable while the
tools configuration surface is removed from the settings UI." **There is no Tools settings
page at this checkout.** The message catalog still carries the strings
(`org_tools_page_title` "Tools", `org_tool_access_title` "Tool Access",
`org_built_in_tools_toggle_title` "Allow provider-native tools",
`org_external_tools_toggle_title` "Allow external tools",
`org_provider_tools_title` "Provider Tools" — `messages/en.json:459-472`), and the mutators
`toggleProviderNativeTools` / `toggleExternalTools` / `toggleTool` still exist and are still
enforced (§3.3). So the **policy is live but currently unreachable from the UI**.

### 7.1 Tool catalog and native provider tool routing (still accurate for docs)

`TOOL_CATALOG` is **derived**, not hand-written: it walks `AI_CATALOG`, collects every
`providerToolId` on every model, and produces one entry per unique
`"{providerId}.{providerToolId}"` key
(`apps/start/src/lib/shared/ai-catalog/tool-catalog.ts:40-73`). Every entry currently has
`source: 'provider-native'` (line 63) — the `'external'` source exists in the type but
nothing produces it, so the "Allow external tools" switch has no catalog rows to act on.

Provider-native tool definitions:
- OpenAI (`provider-tools/openai.ts:3-12`): `web_search` (not advanced),
  `code_interpreter` (advanced).
- Google (`provider-tools/google.ts:3-20`): `google_search`, `url_context` (not advanced);
  `code_execution`, `google_maps` (advanced).
- xAI (`provider-tools/xai.ts:3-24`): `web_search`, `x_search` (not advanced);
  `code_execution`, `view_image`, `view_x_video` (advanced).
- Anthropic ids are **versioned by date suffix** (`web_fetch_20250910` etc.) and metadata is
  derived from the family prefix (`provider-tools/anthropic.ts:10-101`): `web_search_*` and
  `web_fetch_*` are not advanced; `code_execution_*`, `computer_*`, `text_editor_*` are.
  There is a downgrade rule: the dynamic `web_search_20260209` / `web_fetch_20260209`
  revisions require code execution, so without it they are rewritten to
  `web_search_20250305` / `web_fetch_20250910` at runtime (lines 16-51).
- Alibaba, DeepSeek, Meta, Mistral, MiniMax, Moonshot, Z.AI have **no built-in provider
  tools** — "tool use is user-defined only" (`provider-tools/index.ts:14-40`).

Category derivation from the tool id (search/files/code/computer/location/video/remote/other)
is a substring heuristic (`tool-catalog.ts:26-38`).

Tool labels for the UI live in `messages/en.json:474-493`, e.g. "Web Search" — "Search the web
and return grounded sources."; "Code Interpreter" — "Run code to analyze data and compute
results."; "X Search" — "Search posts and threads on X."; plus variant templates
`"{label} ({variant})"` and `"{label} ({providerName})"`.

Gating order in `resolveToolPolicy` (`apps/start/src/lib/shared/chat/tool-policy.ts:84-141`),
all reasons additive:
`blocked_by_mode` → `blocked_by_org_master_switch` → `blocked_by_external_tools_switch` →
`blocked_by_org_policy` → `blocked_by_thread_preference` → `blocked_by_compliance`
(ZDR + Anthropic code execution, unless an active org key for that provider) →
`blocked_by_feature_flag` (advanced tools, `canUseAdvancedProviderTools`, currently hardcoded
`true` at `apps/start/src/utils/app-feature-flags.ts:57`).
`sanitizeThreadDisabledToolKeys` (lines 155-178) strips thread-level preferences that are
already decided by org policy so a user cannot "re-enable" an org-disabled tool by editing
thread state — matching the help copy "These toggles are enforced server-side. A disabled
tool cannot be re-enabled by thread preferences." (`messages/en.json:469`).

---

## 8. Usage — `/organization/settings/usage`

Component: `usage/usage-page.tsx:253` (+ `usage-page.model.ts`).
Route comment (`usage/route.tsx:10-12`): "Previously redirected to Billing. Resource counts,
credit consumption, and token volume now live here so Billing is only about plan selection."

- Title **"Usage"**, description **"Track your plan usage and model requests."**
  (usage-page.tsx:169-170).
- No active organization → title "Usage", description "Select an organization to review
  usage.", body "Choose an organization in the sidebar before reviewing usage."
  (`usage/route.tsx:24-32`).
- **Current plan** card: label "Current plan", plan name (or "Loading…") plus an **"Active"**
  pill (lines 174-194).
- **Resource grid** header line: `{planName} plan · {activeWorkspace.name | 'no workspace'}`
  with an **"Upgrade"** button linking to `/organization/settings/billing` (lines 201-214).
  Three tiles (`usage-page.model.ts:128-148`):
  - **Workspaces** — uncapped, plain count.
  - **Integrations** — uncapped, plain count; counted **inside the active workspace only**,
    because "Receipt Connect scopes every connection to one workspace" (model comment 103-109;
    query at usage-page.tsx:137-150 filters to `status === 'valid'`).
  - **Members** — capped by `seatCount`, rendered `"{count} / {limit}"` with a progress ring;
    `atLimit` once count ≥ limit (model 68-101). The comment at 63-67 states seats are the
    only enforced per-plan limit today.
- **Headline metrics** (three cards, `usage-page.model.ts:149-168` — this is the block a
  recent commit added):
  - **"Requests this period"** — value `usage.monthlyActivityCount`, caption
    **"total model requests"**.
  - **"Total tokens"** — value `usage.monthlyTotalTokens`, caption
    **"input, output, and reasoning combined"**.
  - **"Credit used"** — `creditGranted − creditRemaining` in nano-USD, caption
    **"platform credit consumed"**.
- **"Credits and spend"** section (`model.spend`, lines 169-185): **Credit remaining**,
  **Recorded spend**, **Top model**.
- **"Token breakdown"** section (`model.tokens`, 186-207): **Input tokens**, **Output tokens**,
  **Reasoning tokens**, **Cache-read tokens**.
- Formatting: counts use `en-US` grouping; missing values render **"Not recorded"** in the
  stat rows but **"0"** in the headline cards (`formatInteger` vs `formatCompactInteger`,
  lines 38-46). Money is nano-USD ÷ 1e9 formatted as USD, with 4 decimals for amounts under
  a cent (48-58).

**Scope caveat, important for docs:** the usage numbers are **per signed-in user within the
organization**, not organization-wide totals. The SQL filters
`where organization_id = $org and user_id = $user`
(`apps/start/src/lib/frontend/billing/org-usage-summary.server.ts:183-186`) over a rolling
**31-day** window (`windowStartAt = windowEndAt - 31 days`, line 141) against
`org_usage_event`. Token figures come from JSON metadata on those events
(`inputTokens`, `outputTokens`, `totalTokens`, `reasoningTokens`, `textTokens`,
`cacheReadTokens`, `cacheWriteTokens`, `noCacheTokens`, `billableWebSearchCalls` — lines
162-183). "Top model" is the most frequently used `model_id`, tie-broken by most recent
(lines 190-197). The section heading says "across the organization" while the query is
per-user — flag this to the team.

---

## 9. Billing — `/organization/settings/billing`

Component: `billing/billing-page.tsx:65`. Title `m.org_billing_page_title()` = **"Billing"**;
description **"Manage your workspace subscription, seats, and billing details."**
(`messages/en.json:539`).

Route-level states (`billing/route.tsx:15-43`):
- **Self-hosted** (`isSelfHosted`, i.e. `VITE_APP_INSTANCE_MODE=self_hosted`): the page is
  replaced by "Billing" / "This workspace is running in self-hosted mode." /
  **"Stripe checkout, pricing upgrades, and the billing portal are disabled for self-hosted
  deployments."**
- No active organization: "Billing" / "Select a workspace to review subscriptions and
  credits." / "Choose a workspace in the sidebar before managing billing."

Plans (`apps/start/src/lib/shared/access-control/index.ts:89-151`, `WORKSPACE_PLANS`):

| id | Name | $/month | includedSeats | Stripe price env |
|---|---|---:|---:|---|
| `free` | Free | 0 | 1 | — |
| `plus` | Plus | 8 | 1 | `STRIPE_PRICE_PLUS_MONTHLY` |
| `pro` | Pro | 50 | 1 | `STRIPE_PRICE_PRO_MONTHLY` |
| `scale` | Scale | 100 | 1 | `STRIPE_PRICE_SCALE_MONTHLY` |
| `enterprise` | Enterprise | 0 (custom) | 1 | — |
| `self_hosted` | Self-Hosted | 0 | 100 000 | — |

The marketing catalog (`apps/start/src/lib/shared/pricing.ts:59-195`) lists Free / Plus $8 /
Pro $50 / Scale $100 plus an Enterprise card ("Contact sales") and a self-hosting plan.
Also relevant: `STRIPE_PRODUCT_ENTERPRISE`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
`VITE_STRIPE_PUBLISHABLE_KEY` (`.env.example:187-199`).

UI copy on the page (all from `messages/en.json:540-587`):
- Summary title `{planName} plan`; description "Billing period unavailable" or
  "No billing period on the Free plan".
- Seat progress bar labelled **"Seat allocation"**, value `"{activeMembers} of {seatCount}
  seats"`; over-capacity members render in rose
  (`billing-page.tsx:13-58`).
- Scheduled-change banners: "Scheduled cancellation to Free at period end on {date}." and
  "Scheduled change to {plan} with {n} seats on {date}."
- Non-admin notice: **"Only workspace owners and admins can change plans, seats, or billing
  details."** — shown when `resolveBillingManagementUiState` detects an explicit non-admin
  role (`billing-ui-policy.ts:10-29`; the comment says session role data is a UI hint and the
  server is the boundary).
- Seat input "Seats", help "Choose the seat count to apply to any plan change you make below.";
  warning "You selected {n} seats for {m} active members. Everyone keeps access until period
  end, and extra members will be auto-restricted after renewal."
- **"Manage billing details"** → "Open Stripe to manage payment methods, invoices, and
  billing profile details."
- **"Change plan"** — "Select a plan below. Upgrades apply immediately with proration, while
  downgrades take effect at the next renewal."
- **"Cancel to Free"** — "Keep your current paid plan until the end of the billing period,
  then move the workspace to Free."; button "Cancel to Free at period end"; dialog
  "Cancel subscription" / "Confirm cancellation".
- Plan buttons: "Current plan", "Scheduled", "Schedule downgrade" (help "This change takes
  effect at the end of the current billing period."), "Upgrade now" (help "Stripe applies
  this change immediately and invoices prorated charges now."), "Manage seats".
- Change dialog titles: "Start {plan}" / "Schedule {plan}" / "Switch to {plan}" /
  "Update {plan}"; confirms "Continue to checkout" / "Confirm downgrade" / "Confirm change";
  proration notice "Upgrades and seat increases are prorated automatically based on the
  remaining time in the current billing period."
- Error: "Subscription change could not be completed."

Sidebar billing strings (also from this catalog, `messages/en.json:517-537`): "Free allowance",
"Platform credit", "Monthly cycle", "{value} left", "Resets {time}", "Reset unavailable",
"One-time balance", "Restricted", "Over seat limit", "No paid seat assigned", and
"This member is outside the workspace's paid seat capacity. Upgrade seats or remove members
to restore paid usage."

### 9.1 Feature gating — currently inert (must be documented carefully)

`WorkspaceFeatureId` values and their advertised minimum plans
(`access-control/index.ts:19-26, 158-181`):

| Feature | Minimum plan |
|---|---|
| `byok` | Plus |
| `providerPolicy` | Plus |
| `compliancePolicy` | Plus |
| `toolPolicy` | Plus |
| `verifiedDomains` | Pro |
| `singleSignOn` | Enterprise |
| `directoryProvisioning` | Enterprise |
| runtime `chat.fileUpload` | Plus |
| runtime `chat.paidModels` | Plus |

**But every access check currently returns allowed.** `getPlanEffectiveFeatures` returns
`true` for all features regardless of plan (lines 319-325); `getFeatureAccessState` hardcodes
`allowed: true` (354-367); `hasFeatureAccess` returns `true` (398-403);
`isFreeTierContext` returns `false` (405-407); `getModelAccess` returns
`allowed: true` with the comment "The current no-paywall contract keeps every catalog model
selectable." (409-423). Because `assertFeatureEnabled`
(`apps/start/src/lib/backend/billing/services/workspace-billing.service.ts:108-144`) and the
Zero mutators' `requireOrgFeature` both go through `getWorkspaceFeatureAccessState`, the plan
gate never fires today. Docs may state which plan a feature is *intended* for, but must not
claim a free workspace is blocked from BYOK or policies at this checkout.

The upgrade CTAs are still wired: `getFeatureAccessAction` sends Enterprise features to a
`contact` action (href `'#'`) and everything else to `/pricing`
(`access-control/index.ts:183-184, 289-303`); localized labels come from
`feature_access_requires_plan` "This feature requires a {planName} subscription." /
`feature_access_upgrade_label` "Upgrade to {planName}" / `feature_access_contact_label`
"Contact us" (`messages/en.json:431-433`), rendered through
`getFeatureAccessFormProps` (`components/organization/settings/feature-access-form-helpers.ts:24-42`).

---

## 10. Analytics — `/organization/settings/analytics` (URL-only)

Component: `analytics/analytics-page.tsx:18`.
- Title **"Analytics & Insights"**; description **"Analytics are for your organization's
  internal admin use only. They are not shared with Receipt or any external parties and do
  not expose any user private data."** (`messages/en.json:410-411`).
- One card: **"Extraction Analytics"** / "Control extraction-based analytics derived from
  users' AI requests." / help **"Contact support to enable."** with a link labelled
  **"Contact us"** whose href is `'#'` (analytics-page.tsx:36-41).
- Section header "Settings"; three toggles, **all hardcoded `disabled: true`**
  (lines 56, 69, 82):
  - "Enable topic extraction" — "Extract and analyze topics from usage data." — flag
    `topic_extraction_enabled`
  - "Enable sentiment/emotion extraction" — "Extract sentiment and emotion signals from usage
    data." — flag `sentiment_emotion_extraction_enabled`
  - "Enable intention extraction" — "Extract and analyze user intentions from usage data." —
    flag `intention_extraction_enabled`
- Flags are stored in the same `org_ai_policy.compliance_flags` JSON as ZDR
  (analytics-page.tsx:9-11, 50-55). Nothing in the codebase reads them: this page is a
  **read-only preview of an unbuilt feature**.
- No-active-org body: "Switch to an organization to manage analytics settings."
  (`analytics/route.tsx:22`, `messages/en.json:424`).

---

## 11. Integrations — `/organization/settings/integrations`

Route wrapper: `integrations/route.tsx:11-19` renders
`<IntegrationsPage scope="organization" …>` with:
- Title **"Global Integrations"**
- Description **"Connected once for the whole organization and available to Receipt chat.
  Workspace-scoped connections for CLI and MCP clients live under MCP Gateway."**

The route comment (lines 4-10) is the canonical explanation of the two scopes: the
organization catalog is deliberately not workspace-bound because "chat talks to Receipt with
no workspace selected", while the gateway's Integrations tab is a separate, workspace-scoped
view of the same catalog — "not a replacement, and not the same set of connections."
`IntegrationsPage` accepts `scope: 'organization' | 'workspace'` and its own comment
(lines 592-607) repeats the distinction. In organization scope the component asks the server
for the hidden backing workspace via `getOrganizationScopeWorkspaceId` and never shows it
(lines 608-620).

Connect-time copy (`integration-connect-scope-copy.ts:1-12`):
- organization: `Enter your credentials below to connect {name} to this organization's Global
  Integrations. Other organizations you belong to are not affected.`
- workspace: `Enter your credentials below to connect {name} only to the {workspace} workspace.`

Catalog (`integrations/integration-catalog.ts`): a curated seed of ~61 entries joined with
Receipt's runtime connector catalog and the Nango provider catalog
(`nango-provider-catalog.ts`, 1080 lines). Each item carries `id`, `name`, `categories`,
`iconUrl`, optional `authMode`, `connectProviderId`, and tool-surface metadata
(`toolSurface`: `typed-proxy | compatibility-read | provider-mcp | resource-aware-get |
command-auth | auth-only`; `enforcement`: `typed | dynamic-review | compatibility |
runtime-only | authentication-only` — lines 23-36). The default page description when not
overridden is "Connect tools to give Receipt secure context across cloud, workspace, and
business systems." (integrations-page.tsx:1376).

Filters (integrations-page.tsx:1175-1281):
- Search `placeholder="Search integrations"`.
- Category chips from `INTEGRATION_CATEGORY_GROUPS`
  (`integration-category-groups.ts:25-57`): **Development, Google, Microsoft,
  Project Management, Cloud & Data, Communication**. Only groups that match something in the
  current catalog are rendered (`availableCategoryGroups`, lines 81-87). The file comment
  (3-15) explains the 23 raw categories were "far too many chips to scan".
- Auth-method select `aria-label="Filter by authentication method"` with
  `all | api-token | oauth` (line 65, classifier at 152-166).
- **"Show connected only"** switch (`aria-label="Show connected integrations only"`).
- Paging: `INTEGRATION_BATCH_SIZE = 60` per page with a **"Load more"** button and
  `"{n} remaining"` (lines 69, 1313-1334).
- No-match state: **"No integrations found"** / "Try a different search or turn off the
  connected-only filter." (1338-1348).

Per-connection management opens **"Manage tools and permissions"**
(`integration-permissions-dialog.tsx:229-234`), described as
`{integrationName} · {connection}. Every published operation is controlled by this
{organization|workspace} allowlist.` Operations are split into **"Read operations"** and
**"Write and delete operations"**, each row a switch reading **"Allowed"** or
**"Never allow"** (lines 337, 354, 374, 396).

### 11.1 Request-an-integration → `/tasks?create=1`

When the search query matches nothing in the catalog,
`requestIntegrationForQuery` synthesises a placeholder integration from the query
(`integrations-page.tsx:212-227`, fallback builder 552-566: id from a normalized key or
`new-integration`, name title-cased or `New integration`, category `requested`) and renders
`IntegrationRequestPanel` above the grid (1286-1293).

Panel copy (lines 529-576):
- Heading: **"Build {name} with Beetle Tasks"**
- Body: **"New integrations are code changes: Beetle opens a task with a connected objective
  for the catalog entry, Nango mapping, tests, and PR evidence. Connect GitHub first so the
  worker can create a branch and PR."**
- Button states: **"Create task"** (when a GitHub connection exists, `aria-label="Create
  Beetle task for {name}"`), **"Connect GitHub first"** / **"Opening"** (when GitHub can be
  connected), or a disabled **"GitHub required"**.

`beetleTaskHref` (lines 168-195) builds the deep link `/tasks?` with these query params:
`create=1`, `kind=integration`, `title="Add {name} integration"`,
`scope="Receipt Connect / Nango"`, `priority=p2`, `integrationId`, `integrationName`,
`provider` (the `connectProviderId` or the id), plus multi-line `problem`, `evidence`, and
`doneSignal` strings. The `problem` text, verbatim:

> Build {name} as a checked-in Receipt Connect integration.
> Add the connector manifest, provider skill or action metadata, Nango action/sync/webhook code when needed, and focused tests.
> Make it visible in Organization Settings > Integrations after merge and deploy.

and `doneSignal`:

> The integration is listed from the checked-in catalog, maps to the intended Nango integration id, has tests or dryrun evidence, and can start a Receipt Connect session.

Docs should describe this honestly: requesting an integration **files a development task**;
it does not enable anything at runtime.

---

## 12. Workspaces — `/organization/settings/workspaces`

Component: `workspaces/workspaces-page.tsx:67`.

- `PageHeader` title **"Workspaces"**, description **"Isolate connected accounts, action
  permissions, CLI sessions, and MCP tools inside your organization."**, action button
  **"New workspace"** (lines 240-250).
- Search `placeholder="Search workspaces"` / `aria-label="Search workspaces"` (259-268).
- Loading: "Loading workspaces…". Error panel shows the message with a **"Retry"** button
  (271-287).
- The table is `McpGatewayWorkspaceTable` — literally the MCP Gateway's own component
  (import at line 32) — with pagination (default page size 10, line 91). Sorting puts the
  default workspace first, then alphabetical (125-132).
- Clicking a row calls `openWorkspace` → records the selection and navigates to
  `ORG_MCP_OVERVIEW_ROUTE` = `/organization/settings/mcp-gateway/workspace/$workspaceId/overview`
  (lines 110-116, `-organization-settings-nav.ts:76-77`). **This is the MCP Gateway entry
  point**; the detail pages are covered by the separate MCP report.
- Row actions require workspace owner/admin (`canManageWorkspace`, lines 61-64):
  rename, delete, share.
- **Create dialog**: title "Create workspace", description **"Workspace names help people
  choose the correct authorization boundary."**, field "Workspace name" (`maxLength={80}`,
  line 373), submit **"Save workspace"** / "Saving…". Validation "Enter a workspace name."
  Creating **does not switch into** the new workspace — comment at 199-205 explains why.
  Toast: `{name} workspace created.`
- **Rename dialog**: title "Rename workspace", toast "Workspace renamed."
- **Delete is two steps** (comment 39-44):
  1. Title "Delete workspace", body `Delete {name}? This cannot be undone. Agents using this
     workspace will no longer be able to use its credentials. Connections in other workspaces
     are not affected.`, button **"Continue to delete"**.
  2. Title `Confirm you are deleting {name}`, body `This is permanent. Type the workspace name
     below to delete {name} and revoke its credentials for every agent using it.`, label
     `Type {name} to confirm`, button **"Delete workspace permanently"** — disabled until the
     typed name matches exactly (case-sensitive after trimming, lines 182-192, 419-423). A
     **"Back"** button returns to step one. Toast: `{name} workspace deleted.`
- Sharing opens `WorkspaceShareDialog`, with the org member list fetched on demand
  (lines 93-102, 313-329).
- Server functions: `createReceiptWorkspace`, `updateReceiptWorkspace`,
  `deleteReceiptWorkspace`, `listReceiptWorkspaceMembers`
  (`apps/start/src/lib/frontend/receipt-connect/receipt-connect.functions.ts`).
- Access: because `/organization/settings/workspaces` matches `isMcpGatewayPath`, **any
  organization member can open this page** (§0.1); the workspace list itself only returns
  workspaces the user is a member of.

---

## 13. Settings index — `/organization/settings` (General)

Component: `general/org-general-page.tsx` (rendered by `settings/index.tsx:12-14`).
Title **"General"**, description **"Manage your organization's profile, name, and logo."**
(`messages/en.json:596-597`).
Two cards:
- **"Logo"** — "This is your organization's logo. Click to upload a custom image.", help
  "A logo is optional but helps identify your organization.", success "Logo saved.",
  alt text "Organization logo" (`messages/en.json:589-593`). Avatar upload limits come from
  `AVATAR_UPLOAD_POLICY` — jpeg/jpg/png/webp/svg, 10 MB
  (`apps/start/src/lib/shared/upload/upload-validation.ts:123-128`,
  `upload.model.ts:1`); errors "Please upload a JPG, PNG, WEBP, or SVG image." and
  "File exceeds limit of {n}MB." (`messages/en.json:744-745`).
- **"Organization name"** — "The display name of your organization.", **`maxLength: 64`**
  (`org-general-page.tsx:66`), help "Use 64 characters or fewer.", placeholder "e.g. Acme
  Inc.", success "Organization name saved.", errors "Organization name cannot be empty." /
  "Unable to save organization name." / "No organization selected." / "You need to sign in
  and select an organization to edit." (`messages/en.json:594-600`).

Organization creation (from the sidebar switcher, not this page) is capped with the message
"You can create up to {max} organizations." (`messages/en.json:372`).

---

## 14. Security and Members (nav-adjacent, brief)

- **Security** (`/organization/settings/security`, URL-only): three cards —
  **"Domains"** ("Verify ownership of your email domain to enable Single Sign-On.",
  empty "You haven't added any verified domains yet.", button "Add domain"),
  **"Single Sign-On"** ("Require all team members to authenticate via your identity
  provider.", "You haven't set up Single Sign-On yet.", "Set up SSO"), and
  **"Directory Provisioning"** ("Automatically provision and deprovision accounts via your
  identity provider.", "You haven't set up a directory yet.", "Set up directory")
  (`security/security-page.tsx:24-80`, strings `messages/en.json:439-450`). **Every button is
  `buttonDisabled` and every href is `'#'`** (lines 9-11, 32, 55, 78) — the page is a
  placeholder. Related copy: "Organization security settings are coming soon.",
  "This feature is only available via Add-on or Enterprise plan.",
  "This feature will be available soon for self serve." (`messages/en.json:426-429`).
- **Members** (`/organization/settings/members`, menu-only): title "Members"; role labels
  **Owner / Admin / Member**; row actions "Change role", "View profile", "Remove member",
  "Cancel invitation"; `aria-label` "Actions for {name}" (`messages/en.json:509-516`).

---

## 15. Environment variables referenced by this area

From `apps/start/.env.example` unless noted.

| Variable | Line | Relevance |
|---|---:|---|
| `BYOK_ENCRYPTION_KEY_B64` | 153 | **Required** to save or read BYOK keys. AES-256-GCM, base64 of exactly 32 bytes; `openssl rand -base64 32`. Rotating it invalidates every stored key. |
| `CHAT_REQUIRE_BYOK` | 128 | `true` forces every model request through an org/workspace provider key; default `false`. |
| `AI_GATEWAY_API_KEY` | 123 | Platform-credit path for requests without a BYOK key. |
| `ANTHROPIC_API_KEY` | 124 | System Anthropic credential. |
| `VITE_APP_INSTANCE_MODE` | 143 | `cloud` or `self_hosted`; `self_hosted` disables Stripe billing UI (`billing/route.tsx:18-30`) and, per the comment, "removes stripe, anon users, and disabling the quota usage limits for all orgs". |
| `VITE_ENABLE_EMBEDDING` | 145 | Gates the vector pipeline behind Organization Knowledge. |
| `QDRANT_URL`, `QDRANT_API_KEY`, `QDRANT_COLLECTION_ATTACHMENTS`, `QDRANT_TIMEOUT_MS`, `QDRANT_UPSERT_BATCH_SIZE` | 181-192 | Vector store for Organization Knowledge retrieval. |
| `ZERO_UPSTREAM_DB` | 65 | Postgres behind `org_ai_policy`, `org_provider_api_key`, and every receipt projection. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `VITE_STRIPE_PUBLISHABLE_KEY`, `STRIPE_PRICE_PLUS_MONTHLY`, `STRIPE_PRICE_PRO_MONTHLY`, `STRIPE_PRICE_SCALE_MONTHLY`, `STRIPE_PRODUCT_ENTERPRISE` | 190-199 | Billing page. Missing a price env throws `Missing required environment variable {envKey}` (`access-control/index.ts:240-245`). |
| `RECEIPT_CONNECTION_ENCRYPTION_KEY_B64` | 154 | Receipt Connect connection secrets (Integrations). |
| `ALLOW_USER_COST_DISPLAY` | 156 | "Allow exposing AI cost data to end users. (BYOK requests display the cost even if set to 'false')." |
| `WORKSPACE_USAGE_TARGET_MARGIN_PERCENT` (+ `_PLUS_`, `_PRO_`, `_SCALE_`, `_ENTERPRISE_` variants) | 203-215 | Usage quota knobs. |
| `CF_MARKDOWN_WORKER_URL`, `CF_MARKDOWN_WORKER_TOKEN`, `CF_MARKDOWN_WORKER_TIMEOUT_MS` (20000), `CF_MARKDOWN_MAX_CHARS` (120000) | 108-118 | PDF→markdown conversion used by Organization Knowledge indexing. |

Migration command surfaced in-product (guardrails panel): `cd apps/start && bun run zero:migrate`.

---

## 16. Database objects touched by this area

| Table | Purpose | Reference |
|---|---|---|
| `org_ai_policy` | Provider/model deny lists, compliance flags, tool policy, enforced mode, provider-key status snapshot, `org_knowledge_enabled` | `apps/start/src/integrations/zero/schema.ts:64-87` |
| `org_provider_api_key` | Encrypted BYOK keys, PK `(organization_id, workspace_id, provider_id)` | `apps/start/src/lib/backend/byok/infra/provider-key-store.ts:216-246` |
| `receipt_org_guardrail_group_projection` | Guardrail groups folded from receipts | `packages/receipt-app/src/services/guardrails.ts:505` |
| `receipt_org_policy_rule_projection` | Policy rules folded from receipts | `packages/receipt-app/src/db/schema.ts:190-207` |
| `receipt_org_skill_projection` / `receipt_org_skill_bundle_projection` | Skill metadata (replicated) / skill file bytes (server-only) | `packages/receipt-app/src/services/organization-skills.ts:650-661` |
| `org_usage_event` | Per-request usage/cost/token events behind the Usage page | `apps/start/src/lib/frontend/billing/org-usage-summary.server.ts:183` |
| `org_entitlement_snapshot` | Plan + effective features consulted by feature gates | `apps/start/src/lib/shared/access-control/index.ts:153-157` |
| `org_connection_secret` | Receipt Connect connection status rows behind Integrations | `apps/start/src/integrations/zero/schema.ts:89-104` |
| `attachments` (kind `custom_rag`) | Organization Knowledge files | `apps/start/src/lib/shared/org-knowledge.ts:1-5` |

---

## 17. Places the repo markdown disagrees with the code

1. `README.md:30` — "BYOK controls (Bring Your Own Key) with organization-level enforcement".
   The BYOK page exposes **OpenAI only** (`provider-meta.ts:30-37`), and "enforcement" is only
   real with `CHAT_REQUIRE_BYOK=true` (`model-policy.service.ts:38-40`), which defaults to
   `false` (`.env.example:128`).
2. `README.md:36` — "Organization-level model, tool, and compliance policy controls". The
   **Tools settings page has been removed** and redirects to `/organization/settings`
   (`tools/route.tsx:7-12`), so the tool-policy toggles are unreachable from the UI even
   though the mutators and enforcement remain.
3. `docs/GLOSSARY.md:267-268` — "BYOK … Per-organization, encrypted provider API keys". True,
   but incomplete: keys are `(organization, workspace, provider)`-scoped, and the org page
   writes to a hidden global scope id `ws_global_<md5>`
   (`provider-key-store.ts:74-78`, `receipt-workspaces.ts:149-150`).
4. `apps/start/src/lib/shared/ai-catalog/compliance-map.ts:7-10` — `require_org_provider_key`
   is documented as restricting usage "to providers that have an active organization API key
   configured in **WorkOS Vault**". Neither claim holds: the store is the `org_provider_api_key`
   Postgres table with `BYOK_ENCRYPTION_KEY_B64`, and nothing in the request path reads the
   flag (`compliance-map.ts:13-20` only checks `require_zdr`).
5. `apps/start/src/lib/backend/byok/domain/errors.ts:53-55` — `ByokPersistenceError` is
   documented as "Persistence failed (**Vault**, policy repository)"; the implementation
   persists to Postgres.
6. `apps/start/src/components/organization/settings/policies/policies-page.tsx:131-133` — the
   Guardrails tab tells users the Guardrails page is "fully connected — unlike the modules
   alongside it here". Guardrail **configuration** is fully connected, but no chat/agent code
   path calls `applyGuardrails`, so guardrails do not currently inspect live traffic (§4.8).
7. `apps/start/src/lib/shared/policies.ts:9-13` self-documents the policy modules as "the shape
   the eventual backend must return"; that is accurate for enforcement but the page presents
   them as live rules with "This cannot be undone" delete dialogs. Docs must not describe rate
   limits, budgets, logging redaction, or tool approval as enforced.
8. `apps/start/src/lib/shared/pricing.ts:110-112` advertises BYOK, org policies, and ZDR as
   **Plus** features, and `ORG_FEATURE_MINIMUM_PLANS`
   (`access-control/index.ts:158-169`) agrees — but `getPlanEffectiveFeatures` and
   `getFeatureAccessState` return `allowed: true` unconditionally
   (`access-control/index.ts:319-367`), so no plan gate fires today.
9. `apps/start/src/components/organization/settings/model-policy/models-page.tsx:220` uses a
   hardcoded description while `messages/en.json:457` (`org_models_page_description`) holds a
   different, unused string — a localisation gap worth noting: the Models page description is
   English-only.
10. `apps/start/src/components/organization/settings/usage/usage-page.tsx:169-170` and the
    Org Brain heading say "across the organization", but the usage query is filtered to the
    signed-in user (`org-usage-summary.server.ts:183-186`).
11. `apps/start/src/components/model-gateway/model-gateway-nav.config.tsx:12-18` says the
    Models page has "32 providers" — correct today
    (`model-gateway-catalog.test.ts:11`), but it is a hardcoded prose count that will drift.
12. Two screens use **opposite toggle semantics** for the same underlying `disabledModelIds`
    list: `/models/$providerId` checked = enabled (`provider-models-page.tsx:69`), while
    `/provider-policy` Model Controls checked = disabled (`model-controls-section.tsx:51`).

---

## 18. Internal-only material found (must NOT be published)

- `apps/start/messages/en.json:357` — `home_title` is **`"beetle.run"`**, an internal
  codename that leaks into the marketing/home surface. The Integrations request panel also
  says **"Build {name} with Beetle Tasks"** and `beetleTaskHref`
  (`integrations-page.tsx:168-195, 541`). Decide with the team whether "Beetle" is public
  before quoting that copy.
- `README.md:135-150` — the pre-deploy gate requiring `VALIDATE_STACK_AWS_IMPORT_PROFILE=<local-aws-profile>`,
  `VALIDATE_STACK_CODEX_MODE=real`, `./bunw run deploy:aws`,
  `./bunw run <deploy-project>:start`, and the break-glass
  `RECEIPT_SKIP_LOCAL_VALIDATION_GUARD=1`. Internal release process; not user documentation.
- `apps/start/.env.example:236-249` — Slack wiring including
  `SLACK_PRIMARY_TEAM_ID` (with the example value `<slack-team-id>`) and
  `SLACK_PRIMARY_RECEIPT_ORG_ID`. Do not reproduce the example team id.
- `apps/start/src/lib/frontend/byok/byok.server.ts:44-53, 90-108` and
  `provider-key-store.ts:56-72` — the exact structured log shapes
  (`byok.update.request`, `byok.db.read`, `byok.provider.resolve`, with
  `organizationId`/`workspaceId`/`userId`/`keyFingerprint`). Useful to operators, but it is an
  internal observability contract; publishing it advertises the debugging surface.
- The `apps/start/.env.local.bak-5100` file exists in the working tree and mirrors
  `.env.example`. Never cite it; it is a local backup that may contain real values.
- Guardrails' `SchemaMissingPanel` remediation
  (`guardrails-page.tsx:363-364`) is fine for a self-hosting page but is an operator action,
  not end-user guidance — place it under self-hosting, not under Guardrails usage.
- `apps/start/src/lib/frontend/org-knowledge-graph/org-knowledge-graph.server.ts:7` imports
  through a long relative path into `packages/receipt-app/src/services/openai-api-cost.ts`;
  an internal code-organisation detail, not doc material.

---

## 19. Open questions for a human

1. **Are guardrails enforced anywhere?** No call site for `applyGuardrails`/`guardPrompt`/
   `guardResponse`/`guardToolResult` exists in this checkout. Is enforcement wired in another
   deployment/branch, or is the Guardrails page currently authoring-only? The whole
   "Guardrails" doc page hinges on this.
2. **Are the four Policies modules (rate limiting, budgets, logging, tool approval) meant to be
   documented at all yet?** They persist and audit but do not affect traffic.
3. **`require_org_provider_key`** — should the toggle be documented, hidden, or is the
   enforcement branch missing by accident?
4. **Anthropic BYOK** — is hiding it a temporary rollout hold, and should docs mention it as
   "coming" or omit it entirely?
5. **Feature/plan gating** — `getFeatureAccessState` returns `allowed: true` for everything.
   Is the no-paywall contract intentional and current, and how should the pricing page's
   "BYOK / org policies / ZDR on Plus" claims be reconciled?
6. **Usage scope** — should "Requests this period" / "Total tokens" be per-user (as
   implemented) or organization-wide (as the headings imply)? This changes the doc copy.
7. **Org Brain access** — the server allows any member while the route guard allows only
   owners/admins. Which is the intended audience?
8. **Workspaces page access** — any member can reach `/organization/settings/workspaces`
   because it matches `isMcpGatewayPath`. Intentional, or an accidental consequence of the
   path list?
9. **Tools page** — is `/organization/settings/tools` coming back? If not, how should users
   change `providerNativeToolsEnabled` / `externalToolsEnabled` / `disabledToolKeys` today?
10. **Analytics** — the three extraction toggles are permanently disabled and the "Contact us"
    link is `'#'`. Should this page be documented, or excluded until it works?
11. **Security page** — every action is disabled and every href is `'#'`. Same question.
12. **"Beetle"** — is the codename public? It appears in `home_title` and in the
    request-an-integration flow.
13. **Custom endpoints** — the Models tab offers "Add custom endpoint", but `self-hosted` is
    `adapter-required` and the server refuses non-executable providers
    ("This provider is a catalog preview and cannot be configured yet."). Is the button
    intentionally aspirational?
14. **`/organization/settings/knowledge`** is hidden from both the rail and the menu. Is
    Organization Knowledge a supported feature to document, or being retired in favour of
    Org Brain / Skills?
15. **Deep link `/tasks?create=1`** — the Tasks surface is outside this report's scope; a
    reviewer should confirm the parameter contract still matches on the Tasks side before we
    document the request-an-integration flow end to end.

---

## Suggested doc pages

1. **`platform/organization-settings`** — *Organization settings overview* (both audiences).
   The map of the area: what each destination does, exact nav labels and ordering, the
   owner/admin rule and its Workspaces/MCP-Gateway exception, and the silent redirect to `/`
   when access is denied. Sources: §0.
2. **`governance/models-and-providers`** — *Model catalog, providers, and model policy* (user).
   The 32-tile provider gallery, the executable-vs-preview distinction, the 3-step provider
   account wizard, and the per-provider / per-model enable-disable screens including the
   opposite toggle semantics. Sources: §1, §3.1.
3. **`governance/bring-your-own-key`** — *BYOK* (both). Which provider is exposed, how a key is
   validated (format + live models call, 10 s timeout), where it is stored and encrypted,
   what precedence it takes over platform credit and the AI Gateway, the ZDR trade-off dialog,
   and every error string. Sources: §2.
4. **`governance/compliance-policy`** — *Compliance flags: ZDR, provider key, Study Mode*
   (user). What each flag does, exactly where it is enforced in a chat request, and which one
   is not enforced today. Sources: §3.1-§3.3.
5. **`governance/guardrails`** — *Guardrails* (user). Groups, the nine guardrail kinds with
   their fields and defaults, operation vs enforcing strategy vs stage, the test dialog,
   limits, and the receipt-backed audit trail. Must carry an accurate status note about
   enforcement. Sources: §4.
6. **`governance/policies`** — *Rate limits, budgets, logging, tool approval* (user). Rule
   shapes, filter model, first-match vs per-tool evaluation, and an explicit status note that
   these are configured and audited but not yet applied. Sources: §3.4.
7. **`governance/tool-policy`** — *Provider-native tools and tool gating* (both). The derived
   tool catalog, per-provider native tools (including Anthropic's versioned ids and the
   dynamic-tool downgrade), the full gating order, and the current state of the removed Tools
   settings page. Sources: §7.
8. **`platform/organization-skills`** — *Organization skills* (both). The `SKILL.md`
   frontmatter contract, size limits, versioning, the detail viewer, and how an enabled skill
   is mounted into a Factory run at `receipt/skills/organization/`. Sources: §5.
9. **`platform/organization-knowledge`** — *Organization knowledge (RAG)* (user). Supported
   file types, the 25 MB limit, index states and retry, and the implicit
   `org_knowledge_enabled` behaviour. Sources: §6.1.
10. **`platform/org-brain`** — *Org Brain* (user). What the dashboard measures, the 30/60/90
    windows, the 30 s refresh, the "Not recorded" convention, and what it deliberately does
    not expose. Sources: §6.2.
11. **`platform/usage`** — *Usage* (user). Resource tiles and which are capped, the three
    headline metrics, credits and token breakdown, and the per-user 31-day scope caveat.
    Sources: §8.
12. **`platform/billing`** — *Billing, plans, and seats* (user). Plan table, upgrade vs
    scheduled downgrade semantics, seat allocation and over-seat behaviour, the Stripe portal,
    and self-hosted mode. Sources: §9.
13. **`platform/integrations`** — *Global integrations* (user). Organization vs workspace
    scope, the catalog filters, per-connection read/write allowlists, and the
    request-an-integration flow that files a Tasks item. Sources: §11.
14. **`platform/workspaces`** — *Workspaces* (user). What a workspace isolates, creating and
    renaming, the two-step delete with typed confirmation, sharing, and the fact that this is
    the doorway into the MCP Gateway. Sources: §12.
15. **`self-hosting/governance-configuration`** — *Configuring governance in a self-hosted
    deployment* (developer). `BYOK_ENCRYPTION_KEY_B64` generation and rotation warning,
    `CHAT_REQUIRE_BYOK`, `AI_GATEWAY_API_KEY`, `VITE_APP_INSTANCE_MODE=self_hosted` and what
    it disables, Qdrant/embedding requirements for Organization Knowledge, Stripe price env
    vars, and running `bun run zero:migrate` when the guardrails/policies projections are
    missing. Sources: §15, §16, §4.7, §9.
16. **`developers/organization-policy-model`** — *How organization policy is stored and
    enforced* (developer). `org_ai_policy` as a Zero-replicated row with seven mutators, the
    receipt-sourced projections for guardrails/policies/skills, the policy engine and tool
    policy resolvers, and the exact enforcement points in the chat request path with the error
    codes and HTTP statuses they produce. Sources: §3.3, §4.4, §7.1, §16.
