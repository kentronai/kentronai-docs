# Receipt — Chat product, attachments, RAG, and the receipts viewer

Research report for a public documentation site. Source of truth is the code in
`<receipt-repo>` at the commit checked out on 2026-09-05
(branch `main`, HEAD `add21f9`). Every substantive claim below carries a `file:line` citation.
Paths are repo-relative unless noted.

Product URL: `https://app.kentron.ai`.

---

## 0. Executive shape of the area

Receipt's chat is **not** a thin wrapper over `streamText`. A user turn goes through:

1. `POST /api/chat` (TanStack Start server route) → `apps/start/src/routes/api/chat/route.tsx:139`
2. `ChatOrchestratorService.streamChat` — authz, rate limit, model policy, tool policy, branch/CAS
   persistence, quota reservation → `apps/start/src/lib/backend/chat/services/chat-orchestrator.service.ts:216`
3. `ReceiptChatService.streamResponse` — a **router model call** classifies the turn, then either
   answers directly, authors an organization skill, or **enqueues a Factory job** on the Receipt
   runtime → `apps/start/src/lib/backend/chat/services/receipt-chat.service.ts:3226`
4. Every turn is recorded as **receipts** (event-sourced facts) that the user can replay in the
   "Replay" dialog.

The assistant persona is named **Beetle** in user-facing prose
(`apps/start/messages/en.json` → `chat_sidebar_description` = "Chat with Beetle to ask questions,
get answers, and collaborate on tasks."). The product is named **Receipt**; the rotating composer
placeholders all begin "Ask Receipt to …"
(`apps/start/src/components/chat/prompt-input/rotating-placeholder-prompts.ts:4-29`).

---

## 1. Routes and page structure

| URL | File | Notes |
|---|---|---|
| `/chat` | `apps/start/src/routes/(app)/_layout/chat/index.tsx:3` | New chat; component renders `null` — the shell lives in the parent layout |
| `/chat/$threadId` | `apps/start/src/routes/(app)/_layout/chat/$threadId/route.tsx:3` | Existing thread; also renders `null` |
| layout | `apps/start/src/routes/(app)/_layout/chat/route.tsx:13` | Mounts `ChatProvider` + `ChatPageShell` + `Outlet` |
| `POST/GET /api/chat` | `apps/start/src/routes/api/chat/route.tsx:31` | POST = new turn, GET = stream resume |

**Auth gate.** `beforeLoad` redirects unauthenticated *or anonymous* users to
`/auth/sign-in?redirect=<pathname+search>` — `apps/start/src/routes/(app)/_layout/chat/route.tsx:14-25`.
Anonymous sessions cannot use chat.

**Thread id resolution.** The layout reads the first path segment after `/chat/`, skipping the
reserved segment `projects` (`route.tsx:30`). If the segment *looks like a Factory objective id*
(`looksLikeFactoryObjectiveId`), it is surfaced as `objectiveId` instead of `threadId` so the
provider can map it back to the origin chat thread (`route.tsx:49-62`).

**Query parameters accepted on `/chat`** (`route.tsx:84-101`):

- objective: `?objectiveId=` | `?objective=` | `?objectId=`
- thread: `?threadId=` | `?chatId=` | `?chat=`

**Thread ids are generated client-side** as `objective_<32 alphanumeric chars>`:
`generateObjectiveChatId` — `apps/start/src/lib/shared/chat/objective-chat-id.ts:1-10`, called at
`apps/start/src/components/chat/chat-context.tsx:2903`. A chat thread id is deliberately *not* a
Factory objective id; `resolveObjectiveBackedChatId` always returns the thread id
(`objective-chat-id.ts:12-24`) — the comment there records that returning the objective id caused
the read path to render the wrong objective's answer.

**Page layout** (`apps/start/src/components/chat/chat-page-shell.tsx:64-119`):
- top-right pinned control: the **Replay** button (`ChatReceiptsDialog`)
- centre: `ChatThread` inside `max-w-5xl`
- bottom sticky composer inside `max-w-3xl`; on an empty new chat the composer floats vertically
  centred (`translateY(calc(-1 * min(38vh, 24rem)))`) and settles on focus (`chat-page-shell.tsx:99-113`)
- `Control+B` toggles the page sidebar (`chat-page-shell.tsx:53-62`)

**Empty state** (`apps/start/src/components/chat/chat-welcome-screen.tsx:17-28`):
- H1: `Hello,` + the signed-in user's name (`chat_welcome_greeting_prefix` = `Hello,`)
- Sub: `What would you like to explore?` (`chat_welcome_subtitle`)
- Six suggestion messages exist in `en.json` (`chat_welcome_suggestion_1..6_title` / `_prompt`,
  e.g. "Dark matter", "P vs NP", "Open problems", "Immune system", "Stellar lifecycle",
  "Economic growth"). **`ChatWelcomeScreen` renders only the greeting and subtitle** — the
  suggestion strings are not rendered by that component.

---

## 2. The composer

File: `apps/start/src/components/chat/chat-input.tsx`.

### 2.1 What is actually on screen

`PromptInputToolbar` (`apps/start/src/components/chat/prompt-input/prompt-input-toolbar.tsx:130-186`)
renders, left to right:

1. A `+` actions button — `aria-label` = **"Open input actions"** (`chat_prompt_actions_open_aria_label`)
2. The textarea (middle slot), `aria-label` = **"Message"** (`chat_input_message_aria_label`)
3. The submit/stop button

Placeholder: on a **new** chat it cycles through `ROTATING_PLACEHOLDER_PROMPTS` (25 strings, all of
the form `Ask Receipt to …`, covering AWS, GitHub, Jira, Google Workspace, YouTube/TikTok/Instagram
analytics, IAM, SSL, Slack retention, RDS backups, Lambda, 2FA) —
`prompt-input/rotating-placeholder-prompts.ts:4-29`. Inside a thread the placeholder is
**"Ask anything"** (`chat_prompt_placeholder`) — `chat-input.tsx:439`.

Submit button labels by status (`prompt-input/prompt-input-submit.tsx:34-39`):

| status | label |
|---|---|
| `ready` | **Send message** |
| `submitted` | **Sending...** (spinner) |
| `streaming` | **Stop generation** |
| `error` | **Error** |

While a response is in flight the control becomes a **stop** button and stays clickable even though
the composer is empty (`prompt-input-submit.tsx:61-87`).

### 2.2 The `+` actions menu

`apps/start/src/components/chat/prompt-input/prompt-input-actions-menu.tsx:52-133`. Items in order:

1. **Attach files** (`chat_prompt_actions_attach_files`). When the 10-file cap is reached the label
   becomes **"Attach files (max reached)"** (`chat_prompt_actions_attach_files_max_reached`). Disabled
   when `!canAddMore || !canUploadFiles`; when uploads are gated the `title` is the upgrade callout.
2. **Study Mode** checkbox (`chat_mode_study_label`). Tooltip is **"Enable Study Mode"**
   (`chat_mode_study_enable_title`) or, when the org enforces a mode, **"Study Mode is enforced by
   your organization"** (`chat_mode_study_enforced_by_org_title`) and the item is disabled.
3. **Max** checkbox — only rendered when the active model has a distinct max context window
   (`contextWindowSupportsMaxMode`). Label is the literal string `Max` (`prompt-input-actions-menu.tsx:104`).
4. A **Tools** group (`chat_prompt_actions_tools_label` = "Tools") listing every provider tool the
   active model exposes, as checkboxes. Checked = enabled; unchecking adds the tool key to the
   thread's `disabledToolKeys`. Tools blocked by org policy render disabled. Hidden entirely while
   Study Mode is on.

### 2.3 Model picker and reasoning-effort picker — IMPORTANT

`ModelSelectorPanel` and `ReasoningSelectorPanel` **exist and are exported**
(`apps/start/src/components/chat/composer-bar/index.ts:5-11`) but **no production component renders
them**. A repo-wide grep for `ModelSelectorPanel` outside its own file and tests returns only
`chat-input.test.tsx` mocks. The toolbar exposes an `afterAttach` slot for exactly this
(`prompt-input-toolbar.tsx:87,170`) and `ChatInput` passes nothing into it.

Consequently:
- The user does **not** currently pick a model or a reasoning effort in the composer.
- `selectedModelId` defaults to `DEFAULT_CHAT_MODEL_ID = 'openai/gpt-5.6-luna'`
  (`apps/start/src/components/chat/composer-bar/model-selector-policy.ts:18`), resolved by
  `resolveDefaultChatModel` (`model-selector-policy.ts:20-30`).
- `selectedReasoningEffort` defaults to the catalog model's `defaultReasoningEffort`
  (`chat-context.tsx:2496-2497`); for `openai/gpt-5.6-luna` that is `low`
  (`apps/start/src/lib/shared/ai-catalog/providers/openai.ts:93`).

If/when the picker is mounted, the panel's copy is already written:
- trigger/aria: **"Select model"** (`chat_model_select_trigger`, `chat_model_select_aria_label`)
- search: placeholder **"Search models..."**, aria **"Search models"**
- provider filter: **"All providers"**, aria **"Filter by provider"**
- empty: **"No models match your search."**
- capability chips: **Tools**, **Reasoning**, **Images**, **PDF**
  (`composer-bar/model-selector-panel.tsx:85-90`)
- reasoning labels: None / Minimal / Low / Medium / High / Extra high / Max
  (`chat_reasoning_effort_*`), aria **"Select reasoning effort"**

**The picker is also provider-restricted.** `MODEL_SELECTOR_ALLOWED_PROVIDER_IDS = ['openai']`
(`model-selector-policy.ts:9-11`) — even mounted, only OpenAI models would be listed, and
`chat-context.tsx:1930-1934` filters `visibleModels` through the same allowlist before it becomes
`selectableModels`.

This lines up with runtime routing: without an org BYOK key, `resolveRuntimeModel` routes only
through OpenAI and throws `Selected model does not support platform OpenAI routing: <modelId>` for
anything else (`apps/start/src/lib/backend/chat/services/model-gateway.service.ts:102-120`).

### 2.4 Context-window control ("Max") and the context meter

- Catalog models declare `contextWindow`; a *standard* window is inferred from the first pricing
  input tier, so `standard` stays inside the cheaper tier
  (`apps/start/src/lib/shared/ai-catalog/context-window.ts:22-46`).
- `resolveModelContextWindow` returns `{ baseContextWindow, maxContextWindow,
  defaultContextWindowMode: 'standard', supportsDistinctMaxMode }` (`context-window.ts:48-63`).
- The **Max** toggle only appears when `supportsDistinctMaxMode` is true.
- Default mode is `standard` — `DEFAULT_CONTEXT_WINDOW_MODE` (`context-window.ts:7`).
- Server-side enforcement happens before the model call: `estimatePromptTokens(messages)` must be
  `< activeContextWindow` or a `ContextWindowExceededError` is raised
  (`chat-orchestrator.service.ts:672-702`). Token estimation is a heuristic —
  `Math.max(1, Math.ceil(text.length / 4))` over text parts only
  (`apps/start/src/lib/shared/chat-contracts/prompt-usage.ts:7-9,36-44`).

The meter is the `Context` hover card in the composer's bottom slot, rendered **only inside a
thread** and only when a model is resolved (`chat-input.tsx:338-363`). It shows:

- trigger: a percentage (or `--`) plus a ring icon, `aria-label` **"Model context usage"**
  (`chat_context_aria_label`) — `composer-bar/context-window.tsx:74,111-131`
- header: `<pct>` and `<used> / <total>` in compact notation plus a progress bar (`context-window.ts:154-197`)
- body rows: **Input**, **Output**, **Reasoning**, **Cache read**, **Cache write**
  (`chat_context_input` / `_output` / `_reasoning` / `_cache_read` / `_cache_write`)
- footer: **Total cost** (`chat_context_total_cost`) — only when a cost is visible (see §7)

Usage shown is the **latest persisted assistant usage on the active branch**, never a client-side
estimate: `buildLatestAssistantUsage` + `resolveCurrentContextTokens`
(`apps/start/src/components/chat/token-usage.ts:89-118`). Current context = `inputTokens +
assistant text tokens`.

### 2.5 Context-limit messages the user can hit

Client-side pre-send guard (`chat-context.tsx:2879-2894`) uses the i18n strings:

- `error_chat_context_window_exceeded` = **"This conversation has reached its current context limit
  ({maxTokens} tokens). Start a new chat to continue."**
- `error_chat_context_window_exceeded_max_available` = **"This conversation has reached the standard
  context limit ({maxTokens} tokens). Switch to Max to continue with the larger window."**

Composer inline banner uses slightly different, hardcoded text (`chat-input.tsx:146-150`):

- **"This conversation has reached the standard context limit. Switch to Max to continue with the larger window."**
- **"This conversation has reached its current context limit. Start a new chat to continue."**

Server-side (`chat-orchestrator.service.ts:686-693`) raises yet a third variant without the token
count: **"This conversation has reached the standard context limit. Switch to Max to continue with
the larger window."** / **"This conversation has reached the current context limit."** (note:
"the current", not "its current"). *Docs should quote the i18n strings, which are what the user
normally sees.*

### 2.6 Drafts, drag-and-drop, long paste

- The draft lives in an external store, not React state, so it survives re-renders:
  `composer-draft-store.ts`; read via `useComposerDraftValue` (`chat-input.tsx:427,484`). On a send
  failure the draft is restored (`chat-input.tsx:299-301`).
- Global window drag listeners show a drop hint (`chat-input.tsx:187-239`). Drop hint copy
  (`prompt-input/slots/top/prompt-input-drop-hint.tsx:29-41`):
  - **"Drop files here to upload"** / **"Release to attach them to this message."**
    (or "…to this message too." when files are already staged)
  - **"Attachment limit reached"** / **"Remove one file first to upload more."**
  - **"File uploads aren't available"** / **"Upgrade to attach files in chat."**
- **Long paste becomes an attachment.** Pasting ≥ 2 000 characters of *plain* text (not rich text,
  not files) is converted into a `.txt` attachment named
  `pasted-text-YYYY-MM-DD-HH-MM-SS.txt` (`chat-input.tsx:46,68-77,311-331`). This path is gated on
  `isEmbeddingFeatureEnabled` — with `VITE_ENABLE_EMBEDDING=false` a long paste stays inline text
  (`chat-input.tsx:313`).

### 2.7 Send blocking

`isSendBlocked = isBusy || hasPendingUploads || isContextLimitReached` (`chat-input.tsx:151`).
`isBusy` also becomes true when the Receipt runtime reports an active run even before the model
stream opens (`chat-input.tsx:130-138`), and in that state the composer shows the `submitted`
spinner while remaining stoppable.

---

## 3. Chat modes

Only one mode ships today: **Study Mode** — `CHAT_MODE_IDS = ['study']`
(`apps/start/src/lib/shared/chat-modes/types.ts:1`).

Definition (`apps/start/src/lib/shared/chat-modes/registry.ts:7-26`):
- `label`: `Study Mode`
- `fixedModelId`: `openai/gpt-oss-120b` (UI name surfaced as **"GPT OSS 120B"**,
  `chat_mode_study_default_model_name`)
- system prompt: "You are a study assistant. — Explain concepts in a clear, structured way. —
  Prefer short learning steps, examples, and quick checks for understanding. — If the user asks for
  direct answers only, comply but include concise reasoning. — When uncertain, state assumptions and
  suggest what to verify."
- `providerToolAllowlistByProvider`: `{ openai: [], anthropic: [], google: [], xai: [] }` — i.e.
  Study Mode disables all provider-native tools by design.

Resolution precedence (`apps/start/src/lib/shared/chat-modes/resolver.ts:14-50`):
**org-enforced mode → request mode → thread mode**. When an org enforces a mode the composer
checkbox is disabled and `isModeEnforced` is true.

Unused-but-present copy: `chat_mode_study_enabled_locked_title` = "Study Mode enabled ({modelName}
locked)", `chat_mode_study_requires_thread_title` = "Send your first message to create a thread,
then you can toggle Study Mode."

---

## 4. What tools chat can actually call

This is the single most misleading area of the codebase for a docs writer. There are **three
different tool surfaces** and they are not the same thing.

### 4.1 Provider-native tool catalog (policy layer, currently not attached at runtime)

The catalog is derived from the model catalog: for each model, `providerToolIds` are expanded into
keys of the form `<providerId>.<providerToolId>` —
`apps/start/src/lib/shared/ai-catalog/tool-catalog.ts:40-99`.

Defaults applied when a model declares no tools and does not set `skipDefaultProviderTools`
(`apps/start/src/lib/shared/ai-catalog/index.ts:23-29`):

| provider | default tool ids |
|---|---|
| openai | `web_search`, `code_interpreter` |
| anthropic | `web_search_20250305`, `web_fetch_20250910` |
| google | `google_search`, `url_context`, `code_execution` |

Full per-provider definitions:
- OpenAI: `web_search` (basic), `code_interpreter` (advanced) — `provider-tools/openai.ts:3-12`
- Anthropic: version-suffixed families `web_search_*`, `web_fetch_*` (basic),
  `code_execution_*`, `computer_*`, `text_editor_*` (advanced) — `provider-tools/anthropic.ts:63-102`.
  Anthropic's *dynamic* revisions (`web_search_20260209`, `web_fetch_20260209`) silently downgrade to
  the stable ones unless a `code_execution_*` tool is also present (`provider-tools/anthropic.ts:22-51`).
- Google: `google_search`, `url_context` (basic), `code_execution`, `google_maps` (advanced) —
  `provider-tools/google.ts:3-20`
- xAI: `web_search`, `x_search`, … — `provider-tools/xai.ts:3-12`

User-facing tool labels/descriptions come from `getLocalizedToolCopy`
(`apps/start/src/lib/shared/ai-catalog/tool-ui.ts:58+`) and `en.json`:

| key | label | description |
|---|---|---|
| `openai.web_search`, `xai.web_search`, `anthropic.web_search_20250305` | **Web Search** | "Search the web and return grounded sources." |
| `anthropic.web_search_20260209` | **Web Search (Dynamic Filtering)** | "Search the web and return grounded sources with dynamic filtering. Requires Anthropic code execution." |
| web_fetch | **Web Fetch** | "Retrieve and summarize content from web pages and PDFs." |
| `xai.x_search` | **X Search** | "Search posts and threads on X." |
| `openai.code_interpreter` | **Code Interpreter** | "Run code to analyze data and compute results." |
| `google.google_search` | **Google Search** | "Search the web with Google grounding." |
| `google.url_context` | **URL Context** | "Open URLs from the prompt and reason over their contents." |
| code_execution | **Code Execution** | "Run code in a sandbox for calculations and data tasks." |
| view_image | **View Image** | "Open and inspect image inputs as a tool step." |
| view_x_video | **View X Video** | "Open and inspect videos linked from X." |

Duplicate labels across providers get disambiguated as `{label} ({providerName})`
(`tool_label_with_provider`) — `chat-context.tsx:2044-2054`.

**Gating** — `resolveToolPolicy` (`apps/start/src/lib/shared/chat/tool-policy.ts:68-148`) walks the
model's tool keys and records one or more `ToolAvailabilityReason`s:

| reason | trigger |
|---|---|
| `blocked_by_mode` | mode allowlist excludes the tool (Study Mode blocks all) |
| `blocked_by_org_master_switch` | provider-native tools disabled org-wide (`toolPolicy.providerNativeToolsEnabled = false`) |
| `blocked_by_external_tools_switch` | external tools disabled org-wide (`toolPolicy.externalToolsEnabled = false`) |
| `blocked_by_org_policy` | tool key in the org's `disabledToolKeys` |
| `blocked_by_thread_preference` | user unchecked it in this thread |
| `blocked_by_compliance` | org requires ZDR, no org provider key for that provider, and the tool is Anthropic code execution |
| `blocked_by_feature_flag` | tool is `advanced` and `canUseAdvancedProviderTools` is false |

`canUseAdvancedProviderTools` is currently hardcoded `true`
(`apps/start/src/utils/app-feature-flags.ts:53`), so the feature-flag reason never fires today.

Thread preferences store **disabled keys only**; keys blocked by org-level policy or compliance are
stripped before persistence (`tool-policy.ts:155-178`), so a user toggle can never re-enable a tool
an admin turned off.

**Runtime reality:** the direct-chat model call passes `tools: {}` and `activeTools: []` to the
model gateway — `receipt-chat.service.ts:3628-3629` (inside the `route === 'chat'` branch). The
gateway forwards those to `streamText`
(`apps/start/src/lib/backend/chat/services/model-gateway.service.ts:222-228`). **No provider-native
tool is attached on the direct app-chat path today.** The tool catalog is still computed and
recorded in generation analytics (`activeToolKeys`, `deniedToolKeysByReason`) —
`chat-orchestrator.service.ts:1094-1111` — and drives the composer's Tools menu, but the direct
answer path is tool-free. Real tool work happens through Factory (§4.2). Docs must not promise
"turn on Web Search in the composer and the model will search".

Org-level tool controls live at `/organization/settings/tools`
(`apps/start/src/routes/(app)/_layout/organization/settings/tools`), with copy:
- **"Tool Access"** / "Control whether provider-native and external tools can be used in this organization."
- "When disabled, tools are blocked server-side. Users cannot re-enable them from thread preferences."
- **"Allow provider-native tools"** / **"Allow external tools"**
- **"Provider Tools"** / "Enable or disable exact provider-native tools for this organization."

### 4.2 Receipt Connect tools (the real tool surface)

Receipt Connect is the connected-app layer. Before every turn the chat service fetches a **signed
capability snapshot** for the current user by issuing a short-lived Receipt Connect JWT with
scope `connect:read` and calling `<gateway>/connect/capabilities`
(`receipt-chat.service.ts:1222-1248`), with a 2 500 ms timeout
(`RECEIPT_CONNECT_PROMPT_CAPABILITY_TIMEOUT_MS`, `receipt-chat.service.ts:119`).

The connector catalog is generated from the Nango provider manifests: **62 provider slugs**
(`packages/receipt-app/src/integrations/nango/catalog.json` → `providerSlugs`), including
`aws-iam`, `github`, `github-app-oauth`, `github-pat`, `gitlab-pat`, `jira-basic`, `atlassian`,
`confluence`, `confluence-basic`, `notion`, `linear-mcp`, `slack`, `datadog`, `sentry`,
`cloudflare`, `vercel`, `terraform`, `incident-io`, `azure-devops`, `azure-blob-storage`,
`hubspot`, `stripe-app`, `airtable`, `attio`, `apollo`, `zendesk`, `zoom`, `zoominfo`, the Zoho
family, `outlook`, Google Workspace (`google-mail`, `google-sheet`, `google-drive`,
`google-calendar`, `google-calendar-mcp`, `google-docs`, `google-slides`, `google-chat`,
`google-tasks`, `google-ads`, `google-analytics`, `youtube`), `instagram`, `tiktok-ads`,
`tiktok-accounts`, `tiktok-personal`, `meta-marketing-api`, `linkedin`, `gong-oauth`,
`lagrowthmachine`, `anthropic`, `openai`. Registry shape:
`packages/receipt-app/src/services/receipt-connect-integration-registry.ts:32-92`;
catalog accessor `receiptConnectConnectorCatalog()`
(`packages/receipt-app/src/services/receipt-connect-connectors.ts:105-106`).

Each connector carries a `command` of the form `receipt connect <id>`
(`receipt-chat.service.ts:335-348`).

**Manage tools (action policy).** A connection can carry an `actionPolicy`. Schema version 2 with an
empty `enabledActions` array means an administrator explicitly published zero operations, and chat
short-circuits before enqueueing any work
(`formatReceiptConnectPolicyDeniedResponse`, `receipt-chat.service.ts:1419-1441`):

> `{Provider} is connected in Global Integrations, but you don't have access to any enabled {Provider} tools right now.`
>
> `Open [Integrations](/organization/settings/integrations), choose {Provider} > Manage tools, enable the required tool, then retry this chat request.`

Version-1 policies keep reviewed read actions enabled by default
(`receipt-chat.service.ts:1531-1552`: "legacy read tools enabled; explicitly enabled write tools: …").

**Not connected.** `formatReceiptConnectSetupResponse` (`receipt-chat.service.ts:1283-1324`):

> `{Provider} is not connected in Global Integrations yet.`
> …optional per-capability attention lines…
> `Open [Integrations](/organization/settings/integrations), connect {Provider}, then retry this chat request.`
> `Connected capabilities right now: {list}.` (only when the snapshot is online and non-empty)

**Status unknown** (snapshot fetch failed):

> `I cannot confirm {Provider} is connected right now because Receipt Connect status could not be checked.`
> `Open [Integrations](/organization/settings/integrations) if {Provider} should be connected, then retry this chat request.`

The integrations path is `/organization/settings/integrations`
(`RECEIPT_CONNECT_INTEGRATIONS_PATH`, `receipt-chat.service.ts:1260-1261`).

### 4.3 MCP gateway

`packages/receipt-app/src/services/receipt-connect-mcp.ts` implements an **MCP server that exposes
Receipt Connect tools to external agents** (Codex, IDE clients). Protocol versions supported:
`2025-11-25`, `2025-06-18` (`receipt-connect-mcp.ts:22-25`). Its `instructions` string is
user/agent-visible:

> "Receipt tools are reviewed operations scoped to the organization and workspace authenticated by
> the saved CLI session. Tool names from tools/list are opaque; use them exactly and never construct
> aliases. Read-only annotations are authoritative. Writes appear only when the token and connection
> policy allow them; do not bypass a missing tool. read-provider-resource is GET-only and accepts
> only a provider-relative path and query. Re-list tools after switching workspaces or reconnecting."

Direction matters: **MCP Gateway is an egress surface for other agents, not a tool source the web
chat calls.** The chat's own guidance to users, embedded in the Factory problem prompt
(`receipt-chat.service.ts:1962`), is:

> "When the user asks how to use MCP or MCP Gateway, distinguish workspace-scoped MCP access from
> organization chat integrations. Guide them through MCP Gateway > workspace > Open integrations,
> then use the CLI commands: `receipt mcp install codex`; `receipt mcp config codex`;
> `receipt mcp status codex` (optional); `receipt workspace current`; `receipt tools list` (optional)."

UI route: `/model-gateway` and `/organization/settings/mcp-gateway`.

### 4.4 Web search

There is **no first-party web-search tool** in chat. Web search exists only as provider-native tool
metadata (§4.1) — which is not attached on the direct path — and as whatever the Factory objective
runtime does with connected capabilities. Cost accounting has a `billableWebSearchCalls` field
(`apps/start/src/lib/backend/chat/domain/generation-metrics.ts:21`) and models can declare
`pricing.webSearchPerRequest` (`ai-catalog/types.ts:66`), so the plumbing exists.

---

## 5. How chat hands off to Factory objectives

### 5.1 The router

Every turn first runs a **classification-only model call**. System prompt
(`packages/receipt-app/src/services/chat-layer-routing.ts:16-17`):

> "You are the Beetle chat router. Return one routing decision only; do not perform tool work and do
> not write any user-facing answer, greeting, acknowledgement, or status update."

`maxOutputTokens` for the router is 1 200 (`CHAT_ROUTER_MAX_OUTPUT_TOKENS`,
`receipt-chat.service.ts:105`). The router prompt is built by `buildChatLayerRouterPrompt`
(`chat-layer-routing.ts:409-456`) and must return one of three JSON shapes:

- `{"route":"chat","contextProviders":[…]}`
- `{"route":"factory","action":"create|react|cancel|archive|promote|cleanup","objectiveMode":"investigation|delivery","requestedProviders":[…],"probeRouting":{…}}`
- `{"route":"organization_skill","operation":"draft|save"}`

Key routing rules stated in the prompt (`chat-layer-routing.ts:426-443`):
- choose `chat` when the turn is answerable from the visible conversation and capability facts
- choose `factory` when the answer needs current private/local/repository/terminal/connected-account
  evidence
- **naming a connector is not sufficient** to route to factory; a general/public-knowledge question
  stays `chat`
- `investigation` = read-only evidence; `delivery` = creates/updates/deletes/artifacts/code edits/
  deployments/PRs. "A generated downloadable file is an external artifact even when its source data
  is read-only."
- `organization_skill` only for authoring a **brand-new** organization skill; updating/enabling/
  archiving an existing skill is Factory delivery work

**Fail-closed behaviour:** an unparseable or throwing router call returns `{ route: "factory" }`
(`chat-layer-routing.ts:466-473`). `deriveProbeRoutingDecision` refuses to trust a model-authored
`recommendedExecution` and derives it from validated facts, widening to `objective` when anything is
inconsistent (`chat-layer-routing.ts:217-243`). `requestedProviders` are intersected with the signed
capability snapshot, so the router cannot name a provider the user has not connected
(`chat-layer-routing.ts:266-277`).

### 5.2 The three outcomes

**(a) `route: "chat"` — direct answer.** A second, profile-aware pass writes the user-visible text
(`receipt-chat.service.ts:3606-3679`). The system prompt is the resolved Beetle profile
(`PROFILE.md` + `SOUL.md` via `resolveFactoryChatProfile`, `receipt-chat.service.ts:1565-1580`)
concatenated with `buildProfileAwareDirectResponsePrompt`
(`chat-layer-routing.ts:387-407`), which grounds it in the authoritative Receipt Connect facts and
instructs, verbatim: "Your response is posted verbatim. Write only natural, helpful chat prose—never
JSON, routing commentary, a workflow acknowledgement, or an invented tool result." and
"Connection status and Manage tools policy are separate. When a provider is connected but the
required tool is not enabled, say that the user does not have access to that tool and direct them to
Global Integrations > Manage tools; do not call the provider disconnected or credential-invalid."

This path streams token-by-token via `streamText` with `smoothStream({ delayInMs: 15, chunking:
'word' })` and `maxOutputTokens` of 8 000 (12 000 for `high`/`xhigh`/`max` reasoning)
(`model-gateway.service.ts:229-239`).

**(b) `route: "organization_skill"`.** Drafts or saves an organization agent skill, then writes a
single final message. Saved skills land at `/organization/settings/skills`
(`ORGANIZATION_SKILLS_SETTINGS_PATH`, `receipt-chat.service.ts:106`).

**(c) `route: "factory"` — background objective.** Sequence
(`receipt-chat.service.ts:3679-3900`):
1. Check Receipt Connect setup / Manage-tools policy; short-circuit with the §4.2 messages if needed.
2. `POST <serverUrl>/agents/factory/jobs` with the payload from
   `buildReceiptFactoryChatJobPayload` (`receipt-chat.service.ts:2061-2225`):
   `kind: 'factory.run'`, `lane: 'chat'`, `sessionKey: factory-chat:<stream>`, `maxAttempts: 2`,
   `config: { maxIterations: 1, maxToolOutputChars: 6000, memoryScope: 'factory-chat:auto',
   workspace: '.' }`, plus `dispatchDefaults.action` (`create` when no bound objective, otherwise
   `react`), `objectiveMode`, `requiredCapabilities`, `probeRouting`, and a long `problem` prompt
   from `buildReceiptProblem` (`receipt-chat.service.ts:1937-2059`).
3. Immediately emit a transient progress part and record a chat-turn progress receipt with the text
   **`Beetle queued job <jobId>.`** (`receipt-chat.service.ts:3777`).
4. `onAsyncQueued` persists an **empty assistant shell** so the thread can show progress
   (`chat-orchestrator.service.ts:1243-1263`), and the HTTP request settles with status 202 in
   telemetry.
5. A detached task subscribes to job progress and waits for the terminal job; on completion it calls
   `recordChatTurnCompleted` / `recordChatTurnFailed` and `onAsyncSettled`, which finalizes the
   assistant message (`receipt-chat.service.ts:3896-4020`).

`objectiveId` on the request binds a follow-up to an existing objective. A `create` action
deliberately **drops** the prior objective's answer and message history from the worker packet so a
new receipt boundary cannot inherit unattestable evidence (`receipt-chat.service.ts:2113-2124`).

### 5.3 What the user sees while a background run is attached

The thread renders a **RuntimeThinkingPanel** above/instead of the answer
(`apps/start/src/components/chat/chat-thread.tsx:682-800`):

- A Beetle avatar, a one-line shimmering headline, an elapsed timer, and a chevron to expand
  **Progress details** (`aria-label="Progress details"`, `chat-thread.tsx:300`).
- Headline fallbacks: `Starting Beetle...` while streaming, `Finished` otherwise
  (`chat-thread.tsx:714`).
- Screen-reader prefixes on the headline: `Needs attention: ` / `Working: ` / `Completed: `
  (`chat-thread.tsx:753-757`).
- Detail rows carry accessible states: `Failed` / `Completed` / `In progress` / `Queued`
  (`chat-thread.tsx:308-316`). Only the last 6 de-duplicated steps are shown
  (`chat-thread.tsx:415`).
- Raw runtime text is humanized before display (`presentRuntimeActivityText`,
  `chat-thread.tsx:369-397`):
  - `Recorded reasoning for iteration N` → **"Captured reasoning"**
  - `planned factory.dispatch` → **"Planned background run"**
  - `factory.dispatch: started` → **"Started background run"**
  - `reconnected to the beetle runtime` → **"Reconnected to Beetle"**
  - `tracking beetle objective objective_…` → **"Tracking the objective"**
  - any remaining `factory.dispatch` → `background run`; any `objective_<id>` → `the objective`
- A **Computer preview** icon button (`aria-label="Open computer preview"`, `title="Computer
  preview"`) opens a **Computer Logs** dialog (`chat-thread.tsx:520-620`) with:
  - description **"Live output from the workspace computer"** when active, else **"Waiting for computer"**
  - search box (`aria-label="Search computer logs"`, placeholder `Search logs…`)
  - an **Errors {n}** toggle and an `N lines` / `N of M lines` counter
  - a mono terminal (`role="log"`, `aria-label="Computer log output"`) prefixing lines with
    `$ ` (stdout), `[err] ` (stderr), `> ` (activity)
  - empty states: **"No logs match your search or filter."**; otherwise ASCII art labelled
    **"Beetle computer offline"**
  - when the computer is active but silent: **"Computer is active; waiting for shell output."**
    (`chat-thread.tsx:673`)
- Max 80 buffered computer output lines (`MAX_COMPUTER_OUTPUT_LINES`, `chat-context.tsx:281`).

**Objective push.** When `VITE_CHAT_OBJECTIVE_PUSH` is on (default `true`,
`app-feature-flags.ts:67`) and the turn is objective-backed, status, computer output, and the final
answer are read from the Zero-synced **objective projection** keyed by `objectiveId`
(`chat-context.tsx:1599-1652`) instead of mirroring progress into the chat session stream
(`receipt-chat.service.ts:3838-3846`). This is what lets a user close the tab and come back to a
finished answer.

**Stopping.** The composer stop button calls `stop()`
(`chat-context.tsx:3469-3512`), which closes the local stream and then calls `stopObjectiveRun`
with the objective id and every active job id. On success the thread gets an appended assistant
message reading exactly **"This task is stopped."** (`chat-context.tsx:3463`). On cancel failure the
composer error banner reads **"Stopped the response, but could not cancel the agent run."**
(`chat-context.tsx:3507`).

### 5.4 Failure text from a Factory run

`formatReceiptJobFailureResponse` (`receipt-chat.service.ts:1113-1140`) renders:

```
Beetle stopped before completing this response.

Status: {status}.
Reason: {compacted failure, ≤400 chars}

This was reported by the Beetle runtime; it was not a normal completed answer.
```

Special cases:
- If the failure text names a missing Receipt Connect capability, the connect-setup message is shown
  instead (`receipt-chat.service.ts:1071-1085`).
- If the failure mentions `computer-unavailable|opensandbox|sandbox|controller acquire|econnrefused`
  (`receipt-chat.service.ts:1088-1111`):
  ```
  The Factory computer runtime is not available, so this objective did not run to completion.

  Runtime reason: {reason}

  Check that the OpenSandbox controller and local Receipt stack are running, then retry the request.
  ```
- Stopping mid-run records the note `chat stream stopped before Beetle finished`
  (`receipt-chat.service.ts:4034,4041`).

---

## 6. Branching: edit, regenerate, "fork", copy, delete

### 6.1 The data model

Messages form an immutable tree. Edges are `parentMessageId`; the canonical path is chosen by
`activeChildByParent[parentId] = childId`; siblings sort by `(branchIndex, createdAt, messageId)` —
`apps/start/src/lib/shared/chat-branching/branch-resolver.ts:1-8,48-66`. Root-level branches use the
synthetic key `__root__` (`ROOT_BRANCH_PARENT_KEY`, `branch-resolver.ts:46`).

`resolveCanonicalBranch` walks root→leaf and **stops** as soon as a parent has children but no valid
active selection (`branch-resolver.ts:158-165`) — resolution is fully deterministic, never
"most recent wins".

- `resolveRegenerationAnchor` (`branch-resolver.ts:184-216`): regeneration always branches from a
  **user** anchor; targeting an assistant message walks up to its parent user message.
- `resolveEditableUserTarget` (`branch-resolver.ts:222-262`): only **user** messages **on the current
  canonical path** are editable, so a stale UI cannot mutate a hidden branch.
- `resolveBranchSelectionPath` (`branch-resolver.ts:270-308`): computes the root→leaf selections
  needed to make an arbitrary message visible — used by chat search reveal.

### 6.2 Optimistic concurrency (CAS)

Every write carries `expectedBranchVersion` (`ChatStreamRequest`,
`apps/start/src/lib/backend/chat/domain/schemas.ts:48`) checked against the thread's projection
(`message-store/operations/append-user-message.ts:88-99`). Conflict handling differs by trigger
(`chat-orchestrator.service.ts`):

- **submit-message**: a stale-but-lower client version is *rebased* to the current tail and retried
  (breadcrumb `chat.submit.branch_version_rebased`, lines 705-737). This keeps resumed/older tabs
  working.
- **regenerate-message**: rebased once, then revalidated against the immutable target id
  (`chat.regenerate.branch_version_rebased`, lines 541-570).
- **edit-message**: rebased once, then revalidated; still rejects edits to hidden or obsolete nodes
  (`chat.edit.branch_version_rebased`, lines 601-628).

On unrecoverable conflict the user sees `error_chat_branch_version_conflict` = **"This chat changed
in another tab or session. Refresh and try again."** The same literal string is also set locally in
`revealMessageBranch` failure (`chat-context.tsx:3433-3437`).

Editing or regenerating while a stream is active is refused server-side with
`Cannot branch while stream is active` (`chat-orchestrator.service.ts:513-522`).

### 6.3 The message action UI

**User message** (`message-parts/actions/user-message-actions.tsx:98-205`) on hover:
- **Regenerate response** (`chat_message_action_regenerate`)
- **Edit message** (`chat_message_action_edit_message`)
- **Copy text** (`chat_message_action_copy_text`) — icon flips to a check when copied
- while editing: **Cancel edit** and **Save edit** (label becomes **Saving edit** / tooltip
  **Saving**)
- a branch pager when >1 sibling exists: **Previous branch version** / `n/m` / **Next branch
  version** (`chat_message_action_previous_branch_version`, `chat_message_action_next_branch_version`).
  Pending optimistic branches (ids prefixed `__pending_regen_branch__` / `__pending_edit_branch__`)
  are skipped by the pager (`user-message-actions.tsx:59-96`).

**Assistant message** (`message-parts/actions/assistant-message-actions.tsx:37-60`):
- **Regenerate response**
- **Copy text**

**There is no "fork" action and no per-message delete.** "Forking" is what edit/regenerate do
implicitly — each creates a sibling branch reachable through the `n/m` pager. Deletion exists only at
**thread** level, in the sidebar. The assistant action cluster deliberately omits the runtime model
name: "Runtime model identity is intentionally omitted from end-user chat; administrators can inspect
it in model and BYOK settings" (`assistant-message-actions.tsx:18-21`).

### 6.4 Thread-level actions (sidebar)

`apps/start/src/components/chat/chat-sidebar.tsx`:
- **New Chat** (`chat_sidebar_new_chat`), **Chat History** (`chat_sidebar_history_section`),
  **Projects** (`chat_sidebar_projects`), **Search chats** (`chat_search_trigger_label`)
- per-thread menu: **Rename**, **Copy link**, **Pin** / **Unpin**, **Delete**
- date groups: **Pinned**, **Today**, **Yesterday**, **Last 7 Days**, **Last 30 Days**, **Older**
- empty state: **"No chats yet"**; untitled thread label: **"Untitled"**
- toasts: **"Thread renamed"**, **"Failed to rename thread"**, **"Thread title cannot be empty"**,
  **"Objective deleted"** (note: this is the *delete-thread* success toast, keyed
  `chat_sidebar_thread_deleted`), **"Failed to delete thread"**, **"Failed to update pinned state"**
- per-thread status pills: **Pending** ("This chat is queued; a response will be generated
  shortly."), **Generating** ("Beetle has started generating the response."), **Error**
  ("Something went wrong and the response could not be generated.")
- free-workspace upgrade card: title **"Upgrade your workspace"**, badge **"Starting at $8/mo"**,
  CTA **"Start from $8/mo"**, body "Get file uploads, full model access, and more monthly usage for
  your workspace." (`chat-sidebar-upgrade-cta.tsx`, strings in `en.json`)

---

## 7. Chat search and highlighting

**Opening.** `Cmd/Ctrl+K` toggles the palette globally (`chat-search-command.tsx:75-87`, mounted in
`components/layout/dashboard-layout.tsx:24`). The sidebar's **Search chats** entry opens it in
search-only mode (`openChatSearchCommand({ hideActions: true })`, `chat-sidebar.tsx:149`), which
hides the Actions group.

**Dialog copy** (`chat-search-command-dialog.tsx`, strings in `en.json`):
- title **"Search chats"**, description "Search your threads and jump directly to matching messages."
- placeholder **"Search threads and messages..."**
- results group heading **"Threads"**
- idle empty state (search-only mode): **"Type a thread title or message text."** with a magnifier icon
- no-results empty state: **"No matching chats found."** with a crossed-magnifier icon
- error: **"Search failed. Try again."**
- result subtitle for a body match falls back to **"Message match"**; the title-match label
  **"Title match"** exists in `en.json` but is not rendered by the dialog
- loading string **"Searching chats..."** exists but `isLoading={false}` is passed to the dialog
  (`chat-search-command-dialog.tsx:299`), so the spinner state is currently inert
- Actions group (`heading: 'Actions'`, hardcoded): **New chat**, **Account**, and
  **Switch to dark mode** / **Switch to light mode** (`chat-search-command-dialog.tsx:236-283`)

**Behaviour.** 120 ms debounce, default limit 20 (`chat-search-command-dialog.tsx:25-26`).

**Backend** (`apps/start/src/lib/backend/chat/services/chat-search.service.ts`):
- default limit 20, max 30 (`:15-16`); queries longer than 200 chars fail with
  `Search query is too long` / issue `query_too_long` (`:82-90`)
- content (message-body) search requires ≥2 characters (`MIN_CONTENT_SEARCH_LENGTH`, `:17`)
- Postgres `websearch_to_tsquery('simple', …)` plus explicit title scoring: exact title 18,
  prefix 14, contains 10, plus `ts_rank_cd(...) * 6` (`:117-140`)
- content search scans the **projected receipt session messages**, so hidden branch messages remain
  discoverable (`:57-63`)

**Reveal + highlight.** Selecting a message result stores a pending reveal
(`threadId`, `messageId`, normalized `query`, nonce) and navigates to `/chat/$threadId`
(`chat-search-command-dialog.tsx:175-194`). `useChatSearchReveal` then calls `revealMessageBranch`,
which activates the whole root→leaf branch path in one CAS-protected mutator
(`chat-context.tsx:3384-3405`), scrolls the message into view with 72 px of top padding
(`use-chat-search-reveal.ts:27,46-80`), and wraps matches in `<mark
data-chat-search-highlight="true">` — skipping `code, pre, script, style, textarea, input`
(`chat-search-highlight.ts:34-107`). `revealMessageBranch` returns false while a response is
streaming (`chat-context.tsx:3352-3354`).

---

## 8. Stream resumability, Redis, and `VITE_DISABLE_REDIS`

`GET /api/chat?threadId=…` resumes an in-flight stream
(`apps/start/src/routes/api/chat/route.tsx:34-138`). Errors:
- `Unauthorized`
- `Organization context is required`
- `Missing threadId query param` (issue: "threadId is required for stream resume")
- 204 No Content when there is nothing to resume (`route.tsx:100-106`)

Implementation: `StreamResumeService`
(`apps/start/src/lib/backend/chat/services/stream-resume.service.ts`).

- Redis keys: active stream `chat:active:v1:<userId>:<threadId>`, stop channel
  `chat:stop:v1:<streamId>`, resumable prefix `chat:resume:v1` (`:37-40`)
- Active stream TTL: 300 s (`ACTIVE_STREAM_TTL_SECONDS`, `:37`)
- SSE chunks are batched to ≤16 384 chars or 100 ms before hitting Redis (`:41-42`)
- An in-process replay buffer of up to 256 000 chars is preferred over Redis for fast reconnects
  (`LOCAL_RESUME_MAX_BUFFER_CHARS`, `:43`; used at `:606-616`)
- Requires `REDIS_URL`; the layer throws `REDIS_URL is not configured` otherwise (`:263-265`)
- Detached SSE persistence has a 20-minute timeout (`RESUME_STREAM_PERSIST_TIMEOUT`,
  `chat-orchestrator.service.ts:43`)

**One active stream per user+thread.** Before starting a turn the orchestrator looks up any existing
stream id, stops it, and clears the key (`chat-orchestrator.service.ts:478-497`).

**`VITE_DISABLE_REDIS=true`** (`apps/start/src/utils/app-feature-flags.ts:62,84`) swaps in
`StreamResumeService.layerDisabled` **and** `RateLimitService.layerDisabled`
(`apps/start/src/lib/backend/chat/runtime/chat-runtime.ts:30-37`). Consequences a docs writer must
state plainly:

- resume always returns `null` → the `GET` endpoint always answers **204**; a reload during
  generation shows no live stream (the answer still lands via the Zero-synced projection)
- `stopStream`, `registerActiveStream`, `persistSseStream`, `clearActiveStream` become no-ops
  (`stream-resume.service.ts:806-836`)
- **rate limiting is fully disabled** — `assertAllowed` always returns allowed
  (`rate-limit.service.ts:153-161`)

There is a third `layerMemory` adapter used by tests only (`stream-resume.service.ts:750-805`).

**Client-side resume** is best-effort and deliberately skipped during a bootstrap send so the resume
GET cannot race the first POST and produce a false "thread not found"
(`chat-context.tsx:2666-2690`).

---

## 9. Rate limiting, allowances, and quota

`resolveChatAccessPolicy` (`apps/start/src/lib/backend/access-control/index.ts:94-152`) returns the
rate-limit window and an optional free allowance.

Defaults and overrides (`:34-51`):

| setting | default | env override |
|---|---|---|
| paid window | 60 000 ms | `PAID_CHAT_RATE_LIMIT_WINDOW_MS` |
| paid max requests | 30 | `PAID_CHAT_RATE_LIMIT_MAX_REQUESTS` |
| free window | 60 000 ms | `FREE_CHAT_RATE_LIMIT_WINDOW_MS` |
| free max requests | 10 | `FREE_CHAT_RATE_LIMIT_MAX_REQUESTS` |
| free allowance window | 86 400 000 ms (24 h) | `FREE_CHAT_ALLOWANCE_WINDOW_MS` |
| free allowance max | 100 | `FREE_CHAT_ALLOWANCE_MAX_REQUESTS` |

All four override vars must parse as positive integers or the resolver throws
`Expected {NAME} to be a positive integer` (`:41-51`).

**Critically: the free branch is currently unreachable.** `isFreeTierContext` returns `false`
unconditionally (`apps/start/src/lib/shared/access-control/index.ts:405-407`), so every request gets
the *paid* limits (30/min) and **no free allowance is applied**. Likewise `hasFeatureAccess` returns
`true` unconditionally (`:398-403`) and `getFeatureAccessState().allowed` is hardcoded `true`
(`:354-367`), and `getModelAccess` returns `allowed: true` with no `reason`
(`:413-423`), with the comment "The current no-paywall contract keeps every catalog model
selectable." Practical effect today:

- **File uploads are not plan-gated**, even though `RUNTIME_FEATURE_MINIMUM_PLANS['chat.fileUpload'] =
  'plus'` (`:179`) and the error strings exist.
- No model is `locked` in the picker.
- `error_chat_free_allowance_exhausted` and `error_chat_file_upload_plan_restricted` are
  effectively dead strings on the current contract.

Rate limiting is **Postgres-backed** (fixed window, `chat_request_rate_limit_window`,
`rate-limit.service.ts:36-107`) so replicas share counters; the free allowance uses
`chat_free_allowance_window` keyed by `policyKey` `free-chat-v1`
(`free-chat-allowance.service.ts:38-90`; policy key at `access-control/index.ts:140`).
Both tables prune windows older than 2× the window (`RATE_LIMIT_RETENTION_WINDOWS`,
`RETENTION_WINDOWS`).

**Workspace usage quota.** Before the model call the orchestrator reserves quota
(`usageQuota.reserveChatQuota`, `chat-orchestrator.service.ts:747-786`), bypassing it when an org
provider key (BYOK) is in play. The reservation is released with reason codes `request_failed`
(`:1444`), `title_generation_failed` (`thread.service.ts:527`), `embedding_failed`
(`rag/attachment-content.pipeline.ts:203`). Actual usage is settled in
`usageSettlement.recordChatUsage` + `settleMonetizationEvent`
(`chat-orchestrator.service.ts:975-1000`).

Title generation is deliberately reserved **after** the primary turn "so an optional title can never
consume the balance needed for the turn" (`chat-orchestrator.service.ts:786-789`).

---

## 10. Cost display and `ALLOW_USER_COST_DISPLAY`

Two cost fields are persisted per assistant message: `aiCost` (internal) and `publicCost` (visible).
Which one is populated is decided by `costVisibility`:

```ts
const shouldExposeCost = input.usedByok || canExposeUserCost
```
— `apps/start/src/lib/backend/chat/domain/generation-metrics.ts:44-51`

`canExposeUserCost` reads the **server** env var `ALLOW_USER_COST_DISPLAY === 'true'`
(`apps/start/src/utils/app-feature-flags.ts:58-61,83`). Note it is read from `process.env`, not
`import.meta.env`, and defaults to `false` in the browser bundle.

So a per-message `publicCost` exists when **either** the org used its own provider key (BYOK) **or**
the operator set `ALLOW_USER_COST_DISPLAY=true`.

The composer's context hover card sums `publicCost` across assistant messages on the active branch
(`buildBranchCost`, `chat-context.tsx:1331-1350`); `showBranchCost` is true only if at least one
message carried a `publicCost`. The footer then renders **"Total cost"** and a formatted USD value
(`composer-bar/context-window.tsx:220-240`). With no BYOK and the flag off, the footer does not
render at all.

The Replay dialog labels its cost row **"Estimated provider cost"** and shows **"Not recorded"**
when absent (`chat-receipts-dialog.tsx:2318-2322`), plus **Input**, **Output**, **Cache created**,
**Cache read**, and **"Saved by cache read"**. `ChatReceiptUsageSummary` explicitly keeps missing
values distinct from zero "so the replay UI does not present an unrecorded cost as `$0.00`"
(`chat-receipts.functions.ts:107-122`).

---

## 11. Automatic title generation

Trigger: only on the **first** turn of a thread (`createIfMissing && command.message`), run detached
so it never blocks the answer (`chat-orchestrator.service.ts:790-838`).

`ThreadService.autoGenerateTitle` (`apps/start/src/lib/backend/chat/services/thread.service.ts:449-600`):

- default thread title is `New Chat` (`DEFAULT_THREAD_TITLE`, `:30`)
- skipped when: message is blank, no projection, the projection belongs to a different user,
  `userSetTitle` is true, or the title is already something other than `New Chat` (`:460-470`)
- the prompt is truncated to 200 chars with a trailing `...` (`MAX_USER_MESSAGE_LENGTH`, `:918`)
- model: `CHAT_TITLE_GENERATION_MODEL` env override, default **`openai/gpt-5-mini`**
  (`:920,923-929`)
- prompt, verbatim: `Generate a short 3-4 word title for this user message. Return only the
  title.\n\nUser message: {trimmedMessage}` with `maxOutputTokens: 50` (`:512-518`)
- the result is stripped of `#*_\`"'~-` and all non-word punctuation, then capped at 8 words and 50
  characters (`cleanGeneratedTitle`, `:938-948`)
- a result equal to `New Chat` is discarded (`:573`)
- it is metered separately under request id `<requestId>:thread-title` and settles its own usage
- failures are non-fatal: `shouldReportDetachedTitleGenerationError` suppresses reporting when the
  failure is `ModelPolicyDeniedError`, because "the sidebar falls back to the first user message"
  (`chat-orchestrator.service.ts:83-92`). Telemetry events:
  `chat.thread.title.generation.failed`, `chat.thread.title.generation.timed_out`.

Users can rename a thread from the sidebar; that sets `userSetTitle: true` and permanently disables
auto-titling for that thread.

---

## 12. Conversation memory and preferences

Implemented in `packages/receipt-app/src/services/conversation-memory.ts`.

- Memory scopes are namespaced per organization and user:
  `organizations/<orgId>/users/<userId>/preferences` and `.../profile`, or `users/<userId>/…` with no
  org; repo-scoped variants use `repos/<repoKey>/…` (`:53-79`)
- Preference categories: `formatting | tone | depth | workflow | tool_behavior | assumptions | other`
  (`:25-31`)
- Each preference records `source: 'explicit_user' | 'model_inference'` and `status: 'active'`,
  with `originRunId`, `originSessionStream`, `originMessageIds` (`:33-41`)
- Scope modes: `global | repo | layered` (`:44`)
- `summarizeUserPreferences` returns a block rendered as `Preferences:\n…` and, optionally,
  `Profile conventions:\n…` (`:228-267`)
- `loadConversationProjection` returns `{ userPreferences?, recentSessionMessages, sessionRecall }`
  (`:46-50,406-470`) — session history is explicitly "a projection-backed recall path, not the
  authoritative chat state"

Chat memory scopes used by the app:
- app-chat receipts: `memoryScope: 'app-chat'` (`apps/start/src/lib/backend/receipt/chat-bridge.ts:144,266`)
- Factory chat jobs: `memoryScope: 'factory-chat:auto'`
  (`RECEIPT_FACTORY_CHAT_AUTO_MEMORY_SCOPE`, `receipt-chat.service.ts:91`; used at `:2140`)

**Bounded visible transcript.** Regardless of memory, both the router and the Factory problem prompt
receive at most **8 prior messages**, each clipped to **2 000 chars**, with the whole block clipped
to **8 000 chars** (`RECEIPT_CONTEXT_MESSAGE_LIMIT`, `RECEIPT_CONTEXT_MESSAGE_MAX_CHARS`,
`RECEIPT_CONTEXT_TOTAL_MAX_CHARS` — `receipt-chat.service.ts:116-118`; renderer at `:1797-1839`,
truncation marker `\n...[truncated]...\n` at `:1758-1768`).

**Reasoning is never replayed.** `sanitizeMessagesForModel` strips assistant `reasoning` parts before
prompt conversion (`apps/start/src/lib/backend/chat/services/model-prompt.ts:8-20`).

---

## 13. Attachments — the full pipeline

### 13.1 Allowed types and size (exact)

Single source of truth: `apps/start/src/lib/shared/upload/upload-validation.ts`.

**Chat attachments** (`CHAT_ATTACHMENT_UPLOAD_POLICY`, `:80-108`):

Accepted extensions (also the literal `accept=""` list, `:81-104`):
`.pdf, .jpeg, .jpg, .png, .webp, .svg, .txt, .html, .htm, .xml, .xlsx, .xlsm, .xlsb, .xls, .et,
.docx, .ods, .odt, .csv, .md, .markdown, .numbers`

Accepted MIME types (`:13-34`):
`application/pdf`, `application/x-pdf`, `image/jpeg`, `image/png`, `image/webp`, `image/svg+xml`,
`text/plain`, `text/html`, `application/xml`,
`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`,
`application/vnd.ms-excel.sheet.macroenabled.12`,
`application/vnd.ms-excel.sheet.binary.macroenabled.12`, `application/vnd.ms-excel`,
`application/vnd.openxmlformats-officedocument.wordprocessingml.document`,
`application/vnd.oasis.opendocument.spreadsheet`, `application/vnd.oasis.opendocument.text`,
`text/csv`, `text/markdown`, `text/x-markdown`, `application/vnd.apple.numbers`

**Size limit: 10 MB** — `CHAT_ATTACHMENT_MAX_UPLOAD_SIZE_BYTES = 10 * 1024 * 1024`
(`apps/start/src/lib/shared/upload/upload.model.ts:1-2`).

**File count limit: 10 per message** — `useFileAttachments({ maxFiles: 10 })`
(`chat-input.tsx:121-125`; default also 10 at `hooks/chat/upload/use-file-attachments.ts:30`).

Two sibling policies exist for other surfaces:
- **Organization knowledge** (`ORG_KNOWLEDGE_UPLOAD_POLICY`, `:110-121`): only `.pdf, .md,
  .markdown`; MIME `application/pdf`, `application/x-pdf`, `text/markdown`, `text/x-markdown`,
  `text/plain`; **25 MB** (`ORG_KNOWLEDGE_MAX_UPLOAD_SIZE_BYTES`, `upload.model.ts:3-4`)
- **Avatar** (`AVATAR_UPLOAD_POLICY`, `:123-128`): `.jpeg .jpg .png .webp .svg`, 10 MB

**Validation rules** (`isAcceptedUploadFile`, `:148-158`): a matching MIME type accepts immediately;
a non-matching, non-`application/octet-stream` MIME type rejects immediately; only when the MIME is
empty or `application/octet-stream` does the extension check run.

**Validation error strings** (`getUploadValidationError`, `:160-173`):
- **"File type is not supported for markdown conversion"**
- **"File is empty"** — the backend rewrites this to **"Uploaded file is empty"**
  (`apps/start/src/lib/backend/upload/upload.service.ts:239-247`)
- **"File exceeds limit of 10MB"** (template: `File exceeds limit of ${floor(bytes/1MB)}MB`)

The upload route re-checks size and returns the same message shape
(`apps/start/src/routes/api/files/upload/route.tsx:93-101`, issue `file_too_large`).

### 13.2 Client-side flow

`useFileAttachments` (`apps/start/src/hooks/chat/upload/use-file-attachments.ts`):
- validates each file, marks failures inline, and immediately uploads the rest
- when uploads are disabled it stages exactly **one** file with `uploadError = disabledMessage`
  (`:88-99`) so the user sees why
- `canAddMore = enabled && files.length < maxFiles` (`:188`)
- image files get an object URL preview which is revoked on remove/clear (`:163,174-176`)

`uploadFileToServer` posts `multipart/form-data` with fields `file` and `surface`
(`attachment` | `avatar`) to `/api/files/upload` with `credentials: 'same-origin'`
(`apps/start/src/lib/frontend/chat/upload.ts:59-88`). Failure message falls back to
`Upload failed with status {status}`.

Attachment pill strings (`en.json`, rendered in `attachment-preview-pill.tsx` and
`prompt-input-attachments.tsx`):
- **"Remove {fileName}"**, **"Uploading {fileName}"**
- **"Upload failed for {fileName}. Click to remove."**, **"Upload failed. Click to remove."**,
  **"{error}. Click to remove."**
- preview dialog: **"Preview is not available for this file type."**, **"Open in new tab"**,
  **"Download"**, **"Close"**

### 13.3 Server-side upload route

`POST /api/files/upload` — `apps/start/src/routes/api/files/upload/route.tsx:29-160`.

1. Requires a **non-anonymous** session (`requireNonAnonymousUserAuth`) → `Unauthorized`
2. `surface` field: `avatar` if literally `'avatar'`, otherwise `attachment` (`:50-51`)
3. For `attachment`, checks `accessPolicy.features['chat.fileUpload'].allowed`; on denial returns
   `getFeatureAccessGateMessage(minimumPlanId)` = **"This feature is available on the Plus plan and
   above."** (`shared/access-control/index.ts:309-317`). *Today this branch never fires — see §9.*
4. Missing `file` → **"Missing file field"** (issue `file is required`)
5. Size check → **"File exceeds limit of 10MB"**
6. **Self-hosted guard**: when the markdown worker is not configured and the file is not directly
   text-extractable →
   **"This self-hosted instance only accepts direct text attachments until the markdown worker is
   configured."** (issue `markdown_worker_disabled`) — `route.tsx:103-116`
7. `FileUploadOrchestratorService.upload(...)`
8. Response body: `{ id, key, url, name, size, contentType }`

`markdownWorkerAvailable` is simply "both `CF_MARKDOWN_WORKER_URL` and `CF_MARKDOWN_WORKER_TOKEN` are
non-empty" (`apps/start/src/lib/backend/self-host/instance-settings.service.ts:41-48`).

### 13.4 Storage providers

`apps/start/src/lib/backend/upload/storage-config.ts`.

`UPLOAD_STORAGE_PROVIDER` selects the backend; **default `cloudflare_r2`** (`:44-64`). Accepted
values: `cloudflare_r2` | `r2`, or `s3` | `s3_compatible` | `railway_s3` | `railway`. Anything else
throws
`Unsupported UPLOAD_STORAGE_PROVIDER value: {v}. Use cloudflare_r2 or s3_compatible.`

**Cloudflare R2** (`:70-103`) requires `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
`R2_BUCKET_NAME`, `R2_PUBLIC_BASE_URL`; endpoint is derived as
`https://<accountId>.r2.cloudflarestorage.com`, region `auto`, `publicUrlMode: 'path'`.
Missing vars throw `Cloudflare R2 upload requires env variables: missing {list}`.

**S3-compatible** (`:119-171`) reads `S3_ENDPOINT` or `ENDPOINT`, `S3_ACCESS_KEY_ID` or
`ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` or `SECRET_ACCESS_KEY`, `S3_BUCKET_NAME` or `BUCKET`,
`S3_REGION` or `REGION` (default `auto`). The Railway aliases are explicitly supported. Auth mode is
`aws_default` (IAM role) when `S3_AUTH_MODE=aws_default` or `S3_USE_IAM_ROLE=1`, otherwise
`static_keys`. `publicBaseUrl` is `S3_PUBLIC_BASE_URL`, or `{BETTER_AUTH_URL}/api/files/object`.
When the base URL ends in `/api/files/object`, `publicUrlMode` becomes `proxy_query`.
Missing vars throw `S3-compatible upload requires env variables: missing {list}`.

**Object key layout** (`upload.service.ts:126-139`):
`uploads/org/<orgId|personal>/<accessScope>/user/<userId>/<epochMs>-<uuid>.<ext>`
Segments are sanitized to `[a-zA-Z0-9._-]`; a missing extension becomes `bin`. Files named `*.pdf`
are forced to `Content-Type: application/pdf` regardless of the browser-reported type (`:122-124,255-257`).
`Content-Disposition: inline; filename="…"` with `"` and `\` replaced by `_` (`:185-190`).

**Signed proxy URLs.** In `proxy_query` mode the returned URL is
`{publicBaseUrl}?key=<key>&sig=<hmac>` where the signature is
`HMAC-SHA256(key, BETTER_AUTH_SECRET)` hex (`:145-183`). Without `BETTER_AUTH_SECRET` the service
throws `BETTER_AUTH_SECRET is required to generate signed proxy file URLs`.

**`GET /api/files/object`** (`apps/start/src/routes/api/files/object/route.tsx`) is the first-party
proxy for private buckets. It validates the key (≤512 chars, no `..`, no leading `/`) →
`{"error":"Invalid storage key"}` 400; verifies the signature with `timingSafeEqual` →
`{"error":"Invalid file signature"}` 403; otherwise streams the object with
`Cache-Control: private, max-age=300` and an `x-receipt-storage-provider` header
(`upload.service.ts:197-226`). Purpose per the file comment: "downstream services (like markdown
conversion workers) can fetch private objects without requiring user cookies."

Two runtime clients exist: Bun's `S3Client` for static keys and `@aws-sdk/client-s3` for
`aws_default` (`upload.service.ts:77-109`). With static keys the code requires the Bun runtime and
otherwise throws `Bun runtime with S3 bindings is required for uploads`.

### 13.5 Markdown conversion

Two extraction paths (`file-upload-orchestrator.service.ts:128-164`):

**(a) Direct text.** Files whose MIME is `text/plain`, `text/markdown`, `text/x-markdown`,
`text/csv`, `text/html`, or `application/xml`, or whose extension is `txt|md|markdown|csv|html|htm|xml`,
are read straight from the `File` object with no worker round-trip
(`apps/start/src/lib/backend/file/services/plain-text-file.ts:20-56`).

**(b) The Cloudflare worker.** Everything else (PDF, images, Office/OpenDocument/Numbers) goes to
`MarkdownConversionService.convertFromUrl`
(`apps/start/src/lib/backend/file/services/markdown-conversion.service.ts:40-181`):
- requires `CF_MARKDOWN_WORKER_URL` + `CF_MARKDOWN_WORKER_TOKEN`, else fails 503 with
  **"Markdown conversion is disabled because CF_MARKDOWN_WORKER_URL or CF_MARKDOWN_WORKER_TOKEN is missing."**
- the URL is normalized to end in `/convert` (`:190-194`)
- `POST` with `Authorization: Bearer <token>` and body `{ fileUrl, fileName }`
- timeout: `CF_MARKDOWN_WORKER_TIMEOUT_MS`, default **20 000 ms**, floor 1 000 ms (`:5,57-63`)
- failure messages: **"Markdown conversion timed out"** (504), **"Failed to convert uploaded file"**
  (502 or the worker's status), **"Failed to read markdown conversion response"** (502),
  **"Conversion response did not include markdown"** (502)

**The worker itself** — `workers/markdown-converter/src/index.ts`:
- Wrangler name `receipt-markdown-converter`, `compatibility_date` `2026-02-25`, binding `AI`
  (`workers/markdown-converter/wrangler.jsonc`)
- Only `POST /convert`; anything else → `{"error":"Not found"}` 404 (`:29-31`)
- Bearer token must equal the `INTERNAL_TOKEN` secret, else `{"error":"Unauthorized"}` 401 (`:33-36`)
- `{"error":"Invalid JSON body"}` 400; `{"error":"fileUrl is required"}` 400;
  `{"error":"Failed to fetch source file"}` 400
- Conversion uses Cloudflare Workers AI `env.AI.toMarkdown({ name, blob })`; a
  `format === 'error'` result returns 422 with the AI error (`:58-65`)
- Success body: `{ name, mimeType, tokens, markdown }`
- Default filename when none is supplied: `document.pdf` (`:46-47`)

**`POST /api/files/markdown`** (`apps/start/src/routes/api/files/markdown/route.tsx`) is a separate,
directly callable conversion endpoint (not used by the composer upload path). Extra guards:
- supported types exclude `text/plain`, `text/markdown` and `.txt/.md/.markdown` (they need no
  conversion) — `:19-58`
- unsupported → `{"error":"File type is not supported for markdown conversion"}` 400
- worker unavailable and not a direct-text file →
  `{"error":"Markdown conversion is disabled for binary documents because the Cloudflare markdown worker is not configured."}` 503
- **ownership check**: the key must start with
  `uploads/org/<orgId|personal>/user/user/<userId>/`, else
  `{"error":"File key is not owned by the user"}` 403 (`:149-155`).
  **Note the mismatch:** `buildObjectKey` writes `uploads/org/<org>/<accessScope>/user/<user>/…`
  (`upload.service.ts:138`), i.e. `user/user/` only when `accessScope === 'user'`. Workspace- or
  org-scoped uploads produce keys this route rejects.
- origin check: the URL must start with the configured `publicBaseUrl`, else
  `{"error":"File URL does not match configured storage domain"}` 403
- truncation: `CF_MARKDOWN_MAX_CHARS`, default **120 000**, floor 1 000; over-limit markdown gets
  `\n\n[Truncated due to context size limit]` appended (`:59,165-183`)
- response: `{ key, name, markdown, tokenCount }`

### 13.6 Chunking, embeddings, and Qdrant

`apps/start/src/lib/backend/chat/services/rag/attachment-content.pipeline.ts` +
`rag/pipeline-config.ts` + `infra/vector-db.ts`.

**Attachment RAG preset** (`pipeline-config.ts:14-22`):

| setting | value |
|---|---|
| `chunkTargetChars` | 1 600 |
| `chunkOverlapChars` | 260 |
| `maxChunksPerDocument` | 140 |
| `maxRetrievalChunks` | 8 |
| `maxRetrievalChars` | 12 000 |
| `fallbackExcerptChars` | 2 000 |
| `embeddingModel` | `openai/text-embedding-3-small` |

**Org-knowledge preset** (`pipeline-config.ts:24-32`): 1 800 / 280 / 260 / 10 / 14 000 / 2 200, same
embedding model.

Chunking is paragraph-aware (split on blank lines, pack up to the target, window very long
paragraphs with overlap) — `attachment-content.pipeline.ts:249-296`. Chunk ids are deterministic
UUID-v4-shaped hashes of `<attachmentId>:<chunkIndex>` because "Qdrant point IDs must be integers or
UUIDs" (`:225-243`).

**Embedding funding rule** (`resolveEmbeddingFundingDecision`, `:72-86`): an org OpenAI key pays the
provider directly and bypasses quota; **a non-OpenAI org key means embeddings are skipped entirely**
and the pipeline falls back to lexical excerpts rather than silently spending platform credit.
Errors surfaced internally:
- `Embedding skipped because the organization BYOK key is not compatible with OpenAI embeddings.`
- `Platform-funded OpenAI embeddings are unavailable: OPENAI_API_KEY is not configured.`

Embeddings are metered like generations (reserve → embed → `recordChatUsage` under
`embedding:<requestId>` → settle; release with `embedding_failed` on error) — `:109-208`.

**Failures are non-fatal.** `buildAttachmentChunkRows` catches and sets
`embeddingStatus: 'failed'` with empty embeddings — "Upload succeeds even when embedding provider is
down or misconfigured" (`:358-362`). `embeddingStatus` is one of `indexed | disabled | failed`
(`:47`); it is `disabled` when the flag is off.

**Qdrant** (`apps/start/src/lib/backend/chat/infra/vector-db.ts`):
- collection default `attachment_chunks_v1`, override `QDRANT_COLLECTION_ATTACHMENTS` (`:40,63-67`)
- `QDRANT_URL` (required; otherwise `Qdrant is not configured`), `QDRANT_API_KEY` (sent as the
  `api-key` header), `QDRANT_TIMEOUT_MS` (default 5 000), `QDRANT_UPSERT_BATCH_SIZE` (default 128)
  (`:41-96`)
- collection created with cosine distance and keyword payload indexes on `attachmentId`, `scopeType`,
  `userId`, `threadId`, `ownerOrgId`, `workspaceId`, `accessScope`, `accessGroupIds` (`:150-175`)
- `scopeType` is `attachment` or `org_knowledge`; both share the collection but stay isolated by
  payload filter (`rag/org-knowledge-rag.service.ts:26-30,62-93`)
- everything is gated on `isEmbeddingFeatureEnabled` (`vector-db.ts:45-47`)

**`VITE_ENABLE_EMBEDDING`** — `readBooleanEnv('VITE_ENABLE_EMBEDDING', true)`
(`app-feature-flags.ts:55`). **The code default is `true`**, i.e. embeddings on and Qdrant required,
unless the operator explicitly sets `false`. With it off:
- no embeddings are generated (`embeddingStatus: 'disabled'`)
- no vector index writes or reads
- retrieval logging is suppressed (`load-thread-messages.ts:326-337,359-367`)
- long pastes are no longer converted into `.txt` attachments (`chat-input.tsx:313`)

### 13.7 How an attachment actually changes a later answer

This is the concrete mechanism, in `apps/start/src/lib/backend/chat/services/message-store/operations/load-thread-messages.ts`.

1. **Linking.** On send, each attachment id is verified to belong to the user and is stamped with
   `messageId` + `threadId`; the same link is pushed to the vector store
   (`append-user-message.ts:101-136,181-185`).
2. **Native vs fallback.** For the resolved model, `supportsNativeAttachment` returns true only for
   images when `supportsImageInput`, and for PDFs when `supportsPdfInput`. Generic
   `supportsFileInput` is deliberately ignored: "non-image/PDF files should always use markdown
   fallback context" (`load-thread-messages.ts:45-59`).
   - Native attachments are appended to the user message as AI-SDK `file` parts carrying
     `mediaType`, `filename`, and the storage `url` (`:609-617`).
   - Everything else enters the fallback set.
3. **Retrieval.** If the latest user turn has text and there is ≥1 fallback attachment, the pipeline
   embeds the latest user text (`buildQueryEmbedding`) and searches the thread's attachment vectors
   with `limit = maxRetrievalChunks * 3` = 24 (`:310-369`). Chunks are then greedily selected up to
   **8 chunks / 12 000 chars** (`:371-379`).
4. **Prompt injection.** Selected chunks become a block appended **after** the user's text
   (`buildAttachmentContextBlock`, `:72-89`), rendered as:

   ```
   User-provided attachment context is available below.

   These excerpts come from files attached by the user in this conversation, not from system or organization knowledge.

   Use them as supporting context for the next user request when relevant.

   ## Source 1: <fileName> (<mimeType>)

   <chunk text>
   ```

5. **Fallback to excerpts.** If no ranked chunks come back (embeddings off, Qdrant down, or nothing
   indexed), the whole stored markdown of each attachment is truncated to **2 000 chars per file**
   and injected instead (`buildAttachmentExcerptFallback`,
   `attachment-content.pipeline.ts:447-471`) with the header:

   ```
   Use this extracted file content as supporting context for the next user request.
   If the user question is unrelated, ignore this context.

   ## File: <fileName> (<mimeType>)
   ```

6. **Organization knowledge** is a parallel, *system-provided* block prepended **before** the user's
   text, gated on `orgPolicy.orgKnowledgeEnabled` and only for attachments that are
   `orgKnowledgeActive`, `embeddingStatus = 'indexed'`, `status = 'uploaded'`
   (`load-thread-messages.ts:428-561`). Header text (`:97-115`):

   ```
   System-provided organization knowledge is available below.

   These excerpts come from organization knowledge attachments configured by the system for the active organization, not from the user in this conversation.

   Use them only when they are relevant as supporting background context for the next user request.

   ## Organization source 1: <fileName> (<mimeType>)
   ```

7. **Final assembled user turn** for the model is
   `[orgKnowledgeBlock, message.text, attachmentBlock].filter(Boolean).join('\n\n')`
   and only for the **latest** canonical user message (`:594-607`). Older turns are sent unmodified.

Docs sentence a writer can safely use: *"Attach a spreadsheet, then ask a question about it. Receipt
converts the file to Markdown, splits it into ~1 600-character chunks, embeds them, and — on your
next question — retrieves up to 8 of the most relevant chunks (max 12 000 characters) and appends
them to that question before the model sees it. Images and PDFs are instead handed to the model
natively when the model supports them."*

---

## 14. The chat receipts viewer ("Replay")

Component: `apps/start/src/components/chat/chat-receipts-dialog.tsx` (5 079 lines).
Data: `apps/start/src/lib/frontend/chat/chat-receipts.functions.ts` (server fns) →
`chat-receipts.server.ts`.

**Trigger.** A pill button in the top-right of the chat page labelled **"Replay"** with a scroll
icon; disabled until a thread or objective is available (`chat-receipts-dialog.tsx:4700-4711`).

**Dialog header** (`:4771-4869`):
- eyebrow: **"Agent replay"**
- title: the receipt-derived title, or the objective title, or the thread id, or
  **"Waiting for a run"**
- sr-only description: "Session summary and chronological agent transcript."
- below the title: shortened objective id (mono), session duration, first timestamp
- status chips: the generation status (underscores replaced by spaces), `N meaningful action(s)`,
  `N connected app(s)`, `N receipts`, a green **Live** dot whose tooltip is
  `Updated <time>` or **"Waiting for receipts"**
- buttons: **Refresh agent replay** and **Close agent replay** (sr-only labels; mobile variants add
  "on mobile"), a **Back** button on mobile

**Three tabs** (`:4880-4915`, `role="group"` `aria-label="Replay views"`):

1. **Summary** — sr label "Session summary"
2. **Transcript** — sr label "Transcript", or "Receipt log" when there are no reconstructed turns.
   Extra sr text: "A live, chronological transcript of every receipt. Expand any entry for its
   evidence and raw record."
3. **Work** — sr label "Work done", sr text "The commands, tools, and evidence that produced the
   result."

**Summary tab** shows:
- an AI-written session recap, generated on demand: button **"Generate summary"** (or **"Try
  again"** after a failure), loading label **"Writing session summary"**, and the placeholder
  "Generate a plain-language summary of this session from its receipts." (`:2070-2100`). The recap is
  a *separate* server call so the transcript never waits on a model round-trip
  (`chat-receipts.functions.ts:314-318`). `ChatReceiptRecap.status` is `ready | unavailable | failed`
  so "no provider key configured" is distinguishable from "generation failed"
  (`chat-receipts.functions.ts:75-89`).
- stat cards: **Tokens** (Estimated provider cost / Input / Output / Cache created / Cache read /
  Saved by cache read), **Latest request** (Duration, Scope = "This request only", Status),
  **Conversation** (Messages, User prompts, Assistant replies, Proof events), **Action outcomes**
  (`:2314-2420`)
- counters: **Commands**, **Tool calls**, **Connected-app calls**, **Verified outputs**;
  **Succeeded**, **Running**, **Warnings**, **Failed** (`:2241-2281`)
- tool stats: **Total tool calls**, **Unique tools called**, **Average success rate**,
  **Failed tool call(s)** (`:2475-2490`)

**Transcript tab** shows the real conversation reconstructed from `receipt_session_messages`
(the raw receipt stream never stores literal chat text —
`chat-receipts.functions.ts:161-168`). Each assistant turn carries the work items whose timestamps
fall inside that turn's window. Turn chips read **User** / **Assistant**; long messages collapse
behind **"Show full message"** / **"Collapse message"**. Search bar placeholder:
**"Search messages, tools, commands, or output"**.

**Work tab** lists reconstructed `ChatReceiptWorkItem`s
(`chat-receipts.functions.ts:131-158`), each with `kind: command | tool | connector | evidence` and
`status: running | succeeded | warning | failed | observed`. Filter chips:
**All work**, **Commands**, **Tools**, **Connected apps**, **Verified outputs** (`:3147-3151`).
Status labels: **Failed**, **Needs attention**, **Running**, **Succeeded**, **Observed**
(`:3197-3221`). Loading label: **"Reconstructing work from receipts"**. When an item has no readable
output the detail reads **"Still running; no outcome has been recorded yet."** or
**"The receipt confirms this action, but no readable output summary was recorded."**
A `redacted` flag marks items where credential-shaped text was removed.

**Stage/graph model.** Six stages with technical aliases and empty states (`:1309-1359`):

| stage | technical label | empty text | why |
|---|---|---|---|
| **Goal** | Objective | "No goal proof yet" | "Defines the user outcome the agent is trying to satisfy." |
| **Plan** | Tasks | "No planned steps yet" | "Shows how the agent broke the request into manageable work." |
| **Work** | Jobs | "No background work recorded yet" | "Shows the parts of the plan the agent processed." |
| **Tools & Commands** | Commands | "No tools or commands recorded yet" | "Captures the concrete commands, scripts, searches, and app calls." |
| **Evidence** | Evidence | "No evidence captured yet" | "Records the findings the final answer can point back to." |
| **Result** | Answer & status | "No result recorded yet" | "Combines the evidence into the answer and shows whether the request completed." |

Result-line phrasing (`:1512-1527`): "Prepared the answer from the available evidence", "Completed
the request and prepared the answer", "Still working on the request", "Waiting to finish the
request", "Stopped because the request needs attention", "Could not complete the request".
Node badges: `REQUEST`, `PLAN`, `WORK`, `ACTION`, `EVIDENCE`, `RESULT`, plus derived
`AUTH`, `SCOPE`, `FETCH`, `GUARD` (`:1533-1546`).

**Receipt inspector.** Selecting a proof event opens a panel with fields **Status**, **Recorded**,
**Agent**, **Source step**, **Receipt category**, **Source receipts**, a tab pair
**Overview** / **Raw receipt**, and a **Copy receipt** button (→ **Copied**). Default guidance:
**"Select a proof event to inspect what changed and why it matters."** (`:642`). A
**"Replay to this step"** button (loading text **"Replaying…"**) computes a projection diff
preview; failure reads **"Replay preview is not available for this receipt."** or
**"Unable to replay to the selected receipt."**

**Filters** (`chat-receipts.functions.ts:4-15`): `Problems`, `State changes`, `Evidence`,
`Commands`, `Jobs`, `Memory`, `Computer`. In the UI the "everything" option renders as
**"Everything"** and there is a dedicated **Problems** toggle. Receipt search placeholder:
**"Search hash or payload"** (`aria-label="Search receipts"`).

**Printing.** A print button titled **"Print all records to PDF"** opens the browser print dialog —
the comment notes that is "where 'Save as PDF' lives on every supported platform" (`:905,946`).

**Error / empty states** (`:4443-4472`):
- objective source: **"Receipts are not available for this task yet. Try again in a moment."** /
  **"Unable to load receipts for this task."**
- thread source: **"Receipts are not available for this thread yet. Try again in a moment."** /
  **"Unable to load receipts for this thread."**
- recap failure: **"Unable to generate a session summary."**

**Request parameters** (`chat-receipts.functions.ts:17-36`): one of `threadId`, `objectiveId`, or
`objectiveStream` is required; `limit` 1–1000, `depth` 1–3, `order` asc/desc, `page`, `eventType`
(≤120 chars), `intentFilter`, `query` (≤200 chars). Error when none supplied:
`Provide a threadId, objectiveId, or objectiveStream.`

---

## 15. Chat error catalogue (exact user-facing strings)

Codes: `apps/start/src/lib/shared/chat-contracts/error-codes.ts`.
i18n keys: `apps/start/src/lib/shared/chat-contracts/error-i18n.ts`.
English text: `apps/start/messages/en.json`.

| i18n key | text |
|---|---|
| `error_chat_unauthorized` | Please sign in and try again. |
| `error_chat_invalid_request` | Your request was invalid. Refresh and try again. |
| `error_chat_thread_not_found` | This chat thread could not be found. |
| `error_chat_thread_forbidden` | You do not have access to this chat thread. |
| `error_chat_branch_version_conflict` | This chat changed in another tab or session. Refresh and try again. |
| `error_chat_invalid_edit_target` | This message can no longer be edited. Refresh and try again. |
| `error_chat_model_not_allowed` | The selected AI model is not allowed for your organization. |
| `error_chat_model_requires_paid_plan` | This model requires a paid plan to use. |
| `error_chat_provider_key_missing` | This provider requires an organization API key, but no key is configured. |
| `error_chat_provider_key_invalid` | Unable to connect to the AI service. Verify that your organization OpenAI API key is valid. |
| `error_chat_provider_model_key_incompatible` | This model cannot be used with your organization provider API key. Choose another model from that provider or remove the provider key. |
| `error_chat_context_window_exceeded` | This conversation has reached its current context limit ({maxTokens} tokens). Start a new chat to continue. |
| `error_chat_context_window_exceeded_max_available` | This conversation has reached the standard context limit ({maxTokens} tokens). Switch to Max to continue with the larger window. |
| `error_chat_rate_limited` | Too many requests. Please wait about {retryAfterSeconds} seconds and retry. |
| `error_chat_quota_exceeded` | This seat has exhausted its current AI usage allowance. Please wait until the monthly reset and try again. |
| `error_chat_free_allowance_exhausted` | Your free chat allowance is exhausted for now. Upgrade for more access or wait and try again. |
| `error_chat_platform_credit_exhausted` | Your $5 platform credit has been used. Add an optional provider key in Billing & Credits to continue without platform credit. |
| `error_chat_provider_unavailable` | The AI provider is currently unavailable. Please retry. |
| `error_chat_tool_failed` | A tool failed while processing your request. |
| `error_chat_persistence_failed` | Your message could not be saved. Please retry. |
| `error_chat_stream_failed` | The response stream failed. Please retry. |
| `error_chat_file_upload_plan_restricted` | File uploads are available on paid plans only. Upgrade to attach files in chat. |
| `error_chat_unknown` | We ran into a server problem while generating your response. Please try again in a few moments. |

Non-i18n strings the assistant message itself can carry (`chat-orchestrator.service.ts:79-83`):
- **"Something went wrong on our side while generating the response. Please try again."**
- **"Unable to connect to the AI service. Verify that your organization OpenAI API key is valid."**
- **"The assistant response failed while streaming. Please retry."** (`:872`)

Error banner UI (`prompt-input/slots/top/prompt-input-error.tsx`): a red alert with a **Dismiss
error** button and, when the envelope carries a request id, a **Show TraceID** chevron revealing a
copyable **TraceID**. The envelope shape is `{ ok:false, error:{ code, i18nKey, i18nParams,
requestId, retryable }, requestId, telemetry:{owner:'server'}, details:{ tag, message?, threadId?,
expectedBranchVersion?, actualBranchVersion? } }`
(`apps/start/src/lib/shared/chat-contracts/error-envelope.ts:7-27`).

Route-level errors from `/api/chat` before the envelope exists: `Unauthorized`,
`Organization context is required`, `Invalid JSON body`, `Validation failed`,
`Failed to resolve access policy`, `Workspace is unavailable`
(`apps/start/src/routes/api/chat/route.tsx:150-243`).

---

## 16. Request contract for `POST /api/chat`

`ChatStreamRequest` — `apps/start/src/lib/backend/chat/domain/schemas.ts:35-62`:

```ts
{
  threadId: string                       // required
  workspaceId?: string
  objectiveId?: string
  trigger?: 'submit-message' | 'regenerate-message' | 'edit-message'
  messageId?: string
  editedText?: string
  expectedBranchVersion?: number
  message?: { id: string, role: 'user', parts: Array<{ type: string, text?: string }> }
  attachments?: Array<{ id: string }>    // ids only — the server re-reads metadata
  createIfMissing?: boolean
  modelId?: string
  modeId?: string
  reasoningEffort?: string
  contextWindowMode?: 'standard' | 'max'
  disabledToolKeys?: string[]
}
```

The client builds this in `prepareSendMessagesRequest` (`chat-context.tsx:2176-2242`).
Note that attachments are transmitted as **ids only**; the full manifest (`key`, `url`, `name`,
`size`, `contentType`) is used purely for optimistic UI rendering (`chat-input.tsx:261-281`).

Assistant message metadata streamed back
(`apps/start/src/lib/shared/chat-contracts/message-metadata.ts:7-19`):
`threadId, requestId, model, messageStatus ('streaming'|'done'|'error'), modelSource, startedAt,
completedAt, totalTokens, attachments[], readOnly`. On the Factory path `modelSource` is the literal
`'receipt-server'` (`receipt-chat.service.ts:3388,3410`), which is **not** one of the declared union
members `'thread' | 'request'`.

Progress is streamed as a transient data part `data-receipt-progress` with id `receipt-progress`
(`receipt-chat.service.ts:3370-3380`; client type at `chat-context.tsx:117-119`).

---

## 17. Message rendering

`apps/start/src/components/chat/message-parts/`:
- Markdown via Streamdown (`renderers/streamdown-components.tsx`), with remark plugins for inline
  citations (`renderers/inline-citation-remark-plugin.ts`) and math styles
- **Mermaid diagrams** render natively from ```` ```mermaid ```` blocks
  (`renderers/streamdown-mermaid.ts`). The Factory problem prompt explicitly tells the agent to use
  Mermaid "when architecture, topology, dependencies, or sequence are materially easier to
  understand visually" and never "to decorate a simple answer"
  (`receipt-chat.service.ts:2044-2048`).
- **Code blocks** (`components/code-block.tsx`) with **Download code**, **Toggle fullscreen**,
  **Toggle line wrap** (fallback language label: `text`)
- **Tables** (`components/table-block.tsx`) labelled **"Markdown table"** with
  **Copy table as tab-separated text**, **Download table as CSV**, **Toggle table fullscreen**
- **Reasoning** blocks (`components/reasoning.tsx`) labelled **Reasoning**, collapsed control
  **Show reasoning** / **Show reasoning (streaming)**, completion label **"Finished reasoning"**,
  and rotating verbs **Thinking**, **Moonwalking**, **Planning**, **Refining**
  (`chat_reasoning_thinking_word_1..4`)
- Inline citations (`components/inline-citation.tsx`) backed by `StoredChatSource`
  (`{ sourceId, url, title? }` — `chat-context.tsx:111-115`)
- Attachment pills / preview dialog (`attachment-preview-pill.tsx`)

The message list has `aria-label` **"Chat messages"** (`chat_thread_messages_aria_label`);
initial load shows **"Loading conversation"** (`chat-thread.tsx:188`).

---

## 18. Environment variables touched by this area

| Variable | Where | Default / effect |
|---|---|---|
| `VITE_ENABLE_EMBEDDING` | `app-feature-flags.ts:55` | **default `true`** — embeddings on, Qdrant required |
| `VITE_DISABLE_REDIS` | `app-feature-flags.ts:62` | default `false`; `true` disables stream resume **and** rate limiting |
| `VITE_CHAT_OBJECTIVE_PUSH` | `app-feature-flags.ts:67` | default `true` |
| `VITE_APP_INSTANCE_MODE` | `app-feature-flags.ts:26` | `self_hosted` or (default) `cloud` |
| `ALLOW_USER_COST_DISPLAY` | `app-feature-flags.ts:60` | `'true'` exposes per-message cost |
| `REDIS_URL` | `stream-resume.service.ts:263` | required unless Redis is disabled |
| `PAID_CHAT_RATE_LIMIT_WINDOW_MS` / `_MAX_REQUESTS` | `backend/access-control/index.ts:113-120` | 60000 / 30 |
| `FREE_CHAT_RATE_LIMIT_WINDOW_MS` / `_MAX_REQUESTS` | same, `:129-136` | 60000 / 10 (currently unreachable) |
| `FREE_CHAT_ALLOWANCE_WINDOW_MS` / `_MAX_REQUESTS` | same, `:141-148` | 86400000 / 100 (currently unreachable) |
| `CHAT_TITLE_GENERATION_MODEL` | `thread.service.ts:926` | `openai/gpt-5-mini` |
| `CF_MARKDOWN_WORKER_URL` / `_TOKEN` | `markdown-conversion.service.ts:44-45` | both required for binary conversion |
| `CF_MARKDOWN_WORKER_TIMEOUT_MS` | `markdown-conversion.service.ts:57` | 20000, floor 1000 |
| `CF_MARKDOWN_MAX_CHARS` | `routes/api/files/markdown/route.tsx:166` | 120000, floor 1000 |
| `UPLOAD_STORAGE_PROVIDER` | `storage-config.ts:46` | `cloudflare_r2` |
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET_NAME` / `R2_PUBLIC_BASE_URL` | `storage-config.ts:71-90` | all required for R2 |
| `S3_ENDPOINT`\|`ENDPOINT`, `S3_ACCESS_KEY_ID`\|`ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`\|`SECRET_ACCESS_KEY`, `S3_BUCKET_NAME`\|`BUCKET`, `S3_REGION`\|`REGION`, `S3_PUBLIC_BASE_URL`, `S3_AUTH_MODE`, `S3_USE_IAM_ROLE` | `storage-config.ts:120-149` | S3-compatible / Railway |
| `BETTER_AUTH_SECRET` | `upload.service.ts:145-150` | HMAC key for signed proxy file URLs |
| `BETTER_AUTH_URL` / `VITE_BETTER_AUTH_URL` | `storage-config.ts:105-107` | fallback public base for the object proxy |
| `QDRANT_URL`, `QDRANT_API_KEY`, `QDRANT_COLLECTION_ATTACHMENTS`, `QDRANT_TIMEOUT_MS`, `QDRANT_UPSERT_BATCH_SIZE` | `infra/vector-db.ts:50-88` | collection default `attachment_chunks_v1`, timeout 5000, batch 128 |
| `OPENAI_API_KEY` | `platform-openai-key` via `model-gateway.service.ts:104` | platform-funded fallback |
| `SELF_HOSTED_SETUP_TOKEN` | `instance-settings.service.ts:47` | self-host setup |

Worker-side: `INTERNAL_TOKEN` secret on `receipt-markdown-converter`
(`workers/markdown-converter/src/index.ts:3,34`), plus the `AI` binding
(`workers/markdown-converter/wrangler.jsonc:6-8`).

---

## 19. Where repo markdown disagrees with the code

1. **`LOCAL_SETUP.md:230` implies `VITE_ENABLE_EMBEDDING` defaults to `false`.** The table's "Local
   value" column says `false`, and `AGENTS.md:71` says "If you are not working on embeddings, set
   `VITE_ENABLE_EMBEDDING=false`". The code default when the var is unset is **`true`**
   (`apps/start/src/utils/app-feature-flags.ts:55`). Docs must say: unset = embeddings on = Qdrant
   required.
2. **`LOCAL_SETUP.md:231` presents `VITE_DISABLE_REDIS=true` as merely "uses in-memory stream-resume
   instead of Redis".** In the shipped code the disabled layer does **not** resume at all
   (`resumeStreamDisabled` returns `null`, `stream-resume.service.ts:814-816`) and it also silently
   turns **rate limiting off** (`chat-runtime.ts:32-34`). The "in-memory" adapter
   (`layerMemory`) exists but is not wired to the flag.
3. **`LOCAL_SETUP.md:236-238` says object storage vars are "Optional — leave blank locally" and that
   "File attachments … simply will not work".** More precisely: with no storage config the upload
   route returns a 500 `UploadServiceError` carrying the config message (e.g. "Cloudflare R2 upload
   requires env variables: missing …") — `upload.service.ts:62-75`. There is no graceful
   feature-off state for uploads.
4. **`workers/markdown-converter/README.md` says the worker "returns markdown extracted from a
   PDF".** It converts anything Workers AI `toMarkdown` accepts — the app sends PDFs, images, Office
   and OpenDocument files, and Apple Numbers (`routes/api/files/markdown/route.tsx:19-58`).
5. **Plan-gating copy vs. behaviour.** `error_chat_file_upload_plan_restricted`
   ("File uploads are available on paid plans only"), `chat_prompt_drop_hint_locked_*`,
   `chat_sidebar_upgrade_*`, and `RUNTIME_FEATURE_MINIMUM_PLANS['chat.fileUpload'] = 'plus'` all
   describe a paywall that `hasFeatureAccess`/`getFeatureAccessState`/`isFreeTierContext` currently
   short-circuit to "always allowed"
   (`apps/start/src/lib/shared/access-control/index.ts:354-407`). Any docs page that says
   "file uploads require Plus" would be wrong today.
6. **`README.md`/`architecture.md` framing of chat as a model call.** Nothing in the repo markdown
   explains that every turn first runs a *router* model call and may be executed as a background
   Factory objective. This is the single largest gap between the docs and the code.
7. **Ownership prefix mismatch in `/api/files/markdown`.** The route requires keys under
   `uploads/org/<org>/user/user/<user>/` (`routes/api/files/markdown/route.tsx:152`) while
   `buildObjectKey` emits `uploads/org/<org>/<accessScope>/user/<user>/`
   (`upload.service.ts:138`). Workspace- and org-scoped uploads are rejected by that route. Flagging
   as a code/code inconsistency a docs writer should not paper over.
8. **`ChatMessageMetadata.modelSource` union** declares `'thread' | 'request'`
   (`chat-contracts/message-metadata.ts:12`) but the Factory path writes `'receipt-server'`
   (`receipt-chat.service.ts:3388`).

---

## 20. Open questions for a human

1. Are the model picker and reasoning picker intentionally unmounted (feature-in-progress), or is
   this a regression? Docs cannot describe a model picker that does not render.
2. Is the composer's **Tools** menu intended to be visible while the direct-chat path attaches no
   tools? Today a user can toggle "Web Search" on and nothing changes on the direct path.
3. Is the no-paywall contract (`hasFeatureAccess` → always true) temporary? The pricing page, the
   sidebar upgrade card, and several error strings assume a live paywall.
4. Is **Beetle** a public product name for the assistant, or an internal codename that leaked into
   user-facing strings? It appears in `chat_sidebar_description`, `chat_sidebar_status_generating_description`,
   the runtime progress panel, and every Factory failure message — but `beetle` is *also* the default
   internal AWS CLI profile name (see §21).
5. What is the intended public name for the Replay dialog? The trigger says "Replay", the header
   eyebrow says "Agent replay", and the internal vocabulary is "receipts".
6. Is `text/plain`/`.txt` deliberately absent from `/api/files/markdown`'s supported set while being
   accepted by `/api/files/upload`? (It is, because direct text needs no conversion — but the docs
   should confirm the intent.)
7. What is the actual production value of `ALLOW_USER_COST_DISPLAY` on `app.kentron.ai`? This decides
   whether "Total cost" is a documented feature or a BYOK-only one.
8. `chat_sidebar_thread_deleted` reads **"Objective deleted"** for a *thread* delete. Intentional
   vocabulary alignment, or a copy bug?
9. Are the six `chat_welcome_suggestion_*` strings dead, or rendered by a surface I did not find?
10. What is the supported self-hosting story for attachments — is the "direct text attachments only"
    mode (no Cloudflare worker) a documented tier, or a stopgap?
11. Which Factory `dispatchDefaults.action` values are user-reachable from chat? The router prompt
    lists `create | react | cancel | archive | promote | cleanup`; only `create`/`react` appear in the
    payload builder's fallbacks.

---

## 21. Internal-only — do NOT publish

- **`beetle` as an internal AWS CLI profile.** `package.json:90-91` defines
  `receipt:aws:debug` and `receipt:aws:doctor` as
  `AWS_PROFILE=${AWS_PROFILE:-${RECEIPT_AGENT_AWS_PROFILE:-beetle}} … --web-url https://app.kentron.ai`.
  `AGENTS.md:130` documents this default profile explicitly. This is an employee-workstation
  credential convention, not a product feature.
- **Prod-debug flows bound to a specific operator account.** `receipt:aws:debug` writes
  `/tmp/receipt-prod-debug.json` against the live `https://app.kentron.ai` deployment;
  `packages/receipt-app/src/services/prod-debug-summary.ts` exists solely for that path.
  `./bunw run receipt:agent:aws` ("local agent control that must use hosted `app.kentron.ai` AWS
  credentials and worker callbacks", `AGENTS.md:130`) is likewise internal.
- **`RECEIPT_AGENT_AWS_PROFILE`** as an env var — internal operator knob, not a product setting.
- **Internal deploy/cutover tooling** referenced from `package.json:28-37`:
  `<deploy-project>:images`, `<deploy-project>:release-manifest`, `<deploy-project>:ensure`,
  `<deploy-project>:start`, `scripts/build-beetle-images.mjs`,
  `scripts/ensure-<deploy-project>-codebuild.mjs`, `scripts/single-host-rollout.*`,
  and the CodeBuild environment-override scripts.
- **`sst.config.ts` and `deploy/`** — Kentron's own AWS account topology, resource names, and
  CodeBuild wiring.
- **`docs/production-release-handoff-2026-06-25.md`, `docs/factory-run-rca-2026-05-26.md`,
  `docs/prod-readiness-metrics.md`, `pending todos.md`, `issues/`** — internal incident, cutover,
  and planning material.
- **`RECEIPT_MOCK_LLM_FAILURES` / `./bunw run llm:mock` loopback escape hatch**
  (`LOCAL_SETUP.md:275-286`) — safe to mention as a *contributor* testing aid only; do not present
  it as a supported self-hosting configuration.
- Do not publish any concrete bucket names, account ids, worker subdomains, or token values; every
  example in the docs should use placeholders (`<subdomain>`, `<bucket>`).

Note: **"Beetle" as the assistant persona in chat prose is user-facing** and appears in shipped
strings; it is only the *AWS profile named `beetle`* that is internal. These are two different
things that unfortunately share a name.

---

## Suggested doc pages

1. **`chat/quickstart`** — *user*. Start a conversation from `/chat`, the greeting empty state, the
   composer, Send/Stop, what a thread is, how a thread gets its title, where chats live in the
   sidebar (New Chat, history date groups, rename/pin/copy link/delete).
2. **`chat/composer`** — *user*. The `+` actions menu, Study Mode, the Max context toggle, the Tools
   list, the context-usage meter, drafts, drag-and-drop, long-paste-becomes-a-file. Must state
   honestly that model and reasoning-effort selection are not exposed in the composer today.
3. **`chat/conversation-branches`** — *user*. Edit, regenerate, copy, the `n/m` branch pager,
   deterministic branch resolution, and why "This chat changed in another tab or session" appears.
4. **`chat/search`** — *user*. `Cmd/Ctrl+K`, the sidebar Search chats entry, title vs. message
   matches, jumping to a message inside a hidden branch, highlighting behaviour, limits (20 results,
   200-char query, 2-char minimum for body search).
5. **`chat/background-runs`** — *user*. What "Beetle queued job …" means, the progress panel and its
   step vocabulary, Computer Logs, stopping a run ("This task is stopped."), and how a background run
   attaches to a thread via `?objectiveId=`.
6. **`chat/connected-apps-in-chat`** — *user*. How Receipt Connect capabilities gate chat answers,
   the exact "not connected" / "Manage tools" messages, and the
   `/organization/settings/integrations` remediation path.
7. **`chat/files`** — *user*. The exact allowed file types, 10 MB / 10-file limits, what happens to
   images and PDFs vs. everything else, and how an attachment changes a later answer (retrieval,
   8 chunks / 12 000 chars, excerpt fallback).
8. **`chat/receipts-replay`** — *user*. The Replay dialog: Summary / Transcript / Work, the six
   stages, generating a session summary, the receipt inspector, replay-to-step, filters, printing.
9. **`chat/errors-and-limits`** — *user*. The full error catalogue from §15, rate limits, quota and
   platform-credit messages, TraceID, and what to do about each.
10. **`platform/chat-architecture`** — *developer*. The request path: route → orchestrator → router →
    direct / organization-skill / Factory; wide events; the CAS branch model; the Effect service
    graph in `chat-runtime.ts`.
11. **`platform/model-catalog-and-tool-policy`** — *developer*. `AI_CATALOG`, provider tools,
    `resolveToolPolicy` reasons, mode allowlists, org tool policy, ZDR/compliance gating — with the
    explicit caveat that the direct path attaches no tools today.
12. **`platform/attachments-and-rag`** — *developer*. Upload validation, storage providers and env
    vars, the object proxy and signed keys, the Cloudflare markdown worker contract, chunking and
    embedding presets, Qdrant collection and payload indexes, embedding funding rules.
13. **`platform/markdown-worker`** — *developer*. Deploying `receipt-markdown-converter`, the
    `INTERNAL_TOKEN` secret, the `/convert` contract, timeouts and truncation, and the self-hosted
    "direct text only" fallback.
14. **`platform/streaming-and-resumability`** — *developer*. `UI_MESSAGE_STREAM_HEADERS`, the resume
    GET, Redis keys and TTLs, batching, the single-active-stream rule, and exactly what
    `VITE_DISABLE_REDIS=true` disables.
15. **`platform/self-hosting-chat`** — *developer*. The minimum env set for a working chat +
    attachments deployment, and which features degrade when each dependency is absent.
16. **`platform/api/chat`** — *developer*. The `POST /api/chat` request schema, triggers, CAS
    semantics, the streamed metadata and `data-receipt-progress` part, and the error envelope.
17. **`platform/api/files`** — *developer*. `POST /api/files/upload`, `POST /api/files/markdown`,
    `GET /api/files/object`, with request/response shapes and every error string.
