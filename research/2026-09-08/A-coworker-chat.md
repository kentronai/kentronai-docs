# Receipt AI co-worker chat, verified at HEAD `c3c16be6`

Research report for the public documentation site. Source of truth is the repository at
`<repo>`, branch `main`, HEAD `c3c16be6`
(2026-09-07). The prior corpus at `doc/research/03-chat-files-rag.md`, `03c-app-pages-sidebar.md`,
`03e-slack-teams-apps.md`, `03b-claude-code-observe-import.md` (written at `41baea75`, 43 commits
ago) was used as a map only; every claim below was re-read at HEAD and carries a `path:line`
citation. Paths are repo-relative. Environment variables are named, never valued.

Positioning statement under test (Kentron): *"Lives in Slack or Teams, connected with 1000+ apps to
automate tasks. Give it a goal in plain language, not a workflow. It plans, executes, and reports
back on its own. Works across every system you have connected. Read-only by default; any action
that changes state waits for your explicit approval. Proof, not just output."*

Classification legend used throughout:

| Tag | Meaning |
|---|---|
| **Reachable** | Implemented and reachable from the UI or CLI by normal navigation |
| **Hidden** | Implemented, but only reachable by direct URL or a non-obvious path |
| **Inert** | UI or storage exists, but nothing executes or enforces it |
| **Absent** | Not implemented |

---

## 1. The end-to-end chat turn

### 1.1 `POST /api/chat` and `GET /api/chat`

`apps/start/src/routes/api/chat/route.tsx` is the only HTTP surface for a chat turn.

- `GET` resumes an in-flight stream. It requires an authenticated app user
  (`Unauthorized`, `route.tsx:48`), an active organization (`Organization context is required`,
  `:55`), and a `threadId` query param (`Missing threadId query param`, issue
  `threadId is required for stream resume`, `:72-75`). Thread access is asserted with
  `createIfMissing: false` (`:87-93`). When nothing is resumable it returns **204 No Content**
  (`:100-106`); otherwise an SSE stream with keep-alives (`:109-113`).
- `POST` starts a turn. Same auth and org checks (`:150-165`). Body errors: `Invalid JSON body`
  (`:179`), `Validation failed` with the schema issue (`:187-190`). `resolveObjectiveBackedChatId`
  canonicalises the thread id (`:193-198`). Access policy failure surfaces as
  `Failed to resolve access policy` (`:224`); workspace membership failure as
  `Workspace is unavailable` (`:240`). The org model policy is resolved server-side (`:249-252`)
  and `orchestrator.streamChat` is called with the full request (`:253-276`).

Route-level failures go through `handleRouteFailure` (`:128-136`, `:292-300`) with default
messages `Chat stream resume failed unexpectedly` / `Chat route failed unexpectedly`.

**Classification: Reachable.**

### 1.2 `ChatOrchestratorService.streamChat`

`apps/start/src/lib/backend/chat/services/chat-orchestrator.service.ts` (1,456 lines) owns
authorization, rate limit, branch CAS, context-window enforcement, quota reservation, title
generation, and the persistence of the assistant message.

- Rate limit: `rateLimit.assertAllowed` (`:305`); free allowance `freeChatAllowance.assertAllowed`
  (`:403`). Defaults live in `apps/start/src/lib/backend/access-control/index.ts:34-39`
  (paid 30 req / 60 s; free 10 req / 60 s; free allowance 100 / 24 h) with env overrides
  `PAID_CHAT_RATE_LIMIT_WINDOW_MS`, `PAID_CHAT_RATE_LIMIT_MAX_REQUESTS`,
  `FREE_CHAT_RATE_LIMIT_WINDOW_MS`, `FREE_CHAT_RATE_LIMIT_MAX_REQUESTS`,
  `FREE_CHAT_ALLOWANCE_WINDOW_MS`, `FREE_CHAT_ALLOWANCE_MAX_REQUESTS`; a non-positive-integer value
  throws `Expected {NAME} to be a positive integer` (`:41-51`). `isFreeTierContext` returns `false`
  unconditionally (`apps/start/src/lib/shared/access-control/index.ts:405`), so every request gets
  the paid limits and the free allowance never applies.
- Branching while streaming is refused: `Cannot branch while stream is active` (`:524`).
  Stale `expectedBranchVersion` is rebased once for regenerate (`:566`), edit (`:630`) and submit
  (`:741`) before a conflict is raised.
- Context window: `estimatePromptTokens(nextMessages)` must be `< activeContextWindow` or a
  `ContextWindowExceededError` is raised (`:677-695`) with server text
  `This conversation has reached the standard context limit. Switch to Max to continue with the larger window.`
  or `This conversation has reached the current context limit.` (`:688-691`). The client renders the
  i18n strings instead (see §14).
- Quota is reserved before the model call (`usageQuota.reserveChatQuota`, `:760`); the title
  generation reservation happens after the turn (`autoGenerateTitle`, `:801`).
- When the Receipt service reports an async (Factory) job, the request settles as HTTP 202 in
  telemetry (`:1111`) and `onAsyncQueued` persists an empty assistant shell
  (`messageStore.startAssistantMessage`, `:1244-1263`); `onAsyncSettled` finalises it later with
  `ok`, `finalContent`, and `errorMessage` (`:1265-1281`).
- Non-i18n assistant-message failure strings:
  `Something went wrong on our side while generating the response. Please try again.` and
  `Unable to connect to the AI service. Verify that your organization OpenAI API key is valid.`
  (`:80-83`).

`ChatRuntime` (`apps/start/src/lib/backend/chat/runtime/chat-runtime.ts:30-37`) swaps in
`RateLimitService.layerDisabled` and `StreamResumeService.layerDisabled` when
`VITE_DISABLE_REDIS=true` (`apps/start/src/utils/app-feature-flags.ts:62`). With Redis disabled
there is no rate limiting and `GET /api/chat` always answers 204.

### 1.3 `ReceiptChatService.streamResponse` and the router

`apps/start/src/lib/backend/chat/services/receipt-chat.service.ts` (4,202 lines).

Before routing, a signed **Receipt Connect capability snapshot** for the user is fetched by
minting a `connect:read` JWT scoped to the organization's global workspace and calling
`<gateway>/connect/capabilities` with a 2,500 ms timeout (`:1222-1247`,
`RECEIPT_CONNECT_PROMPT_CAPABILITY_TIMEOUT_MS` at `:119`). `recordChatTurnStartedOnce()` runs
before the router (`:3448`), so a turn is recorded as started even if routing fails.

The router is a classification-only model call (`resolveChatLayerModelDecision`, `:1688-1745`)
that uses `CHAT_LAYER_ROUTER_SYSTEM_PROMPT`:

> "You are the Beetle chat router. Return one routing decision only; do not perform tool work and do not write any user-facing answer, greeting, acknowledgement, or status update."
> (`packages/receipt-app/src/services/chat-layer-routing.ts:16-17`)

with `maxOutputTokens` 1,200 (`CHAT_ROUTER_MAX_OUTPUT_TOKENS`, `receipt-chat.service.ts:105`).
The prompt (`chat-layer-routing.ts:409-457`) asks for one of three JSON shapes:
`{"route":"chat","contextProviders":[…]}`,
`{"route":"factory","action":…,"objectiveMode":…,"requestedProviders":[…],"probeRouting":{…}}`,
or `{"route":"organization_skill","operation":"draft|save"}` (`:420-424`). Rules the docs can
quote: choose `chat` when the visible conversation and capability facts answer the turn (`:427`);
choose `factory` when the answer needs "current private, local, repository, terminal,
connected-account, or other external evidence" (`:429`); naming a connector is not sufficient
(`:430`); `investigation` is read-only evidence, `delivery` is "creates, updates, deletes, external
artifacts, code/configuration edits, deployments, and pull requests" (`:439`); a generated
downloadable file counts as delivery (`:440`). A rule added since `41baea75` (`:442`):
"Select dependencies from the meaning of the latest request, not the number of integrations
available… never select every integration as a fallback."

`parseChatLayerModelDecision` (`:284-355`) validates structurally and intersects any provider
list with the signed snapshot (`filterProvidersToActiveSnapshot`, `:266-277`), and derives the
probe/objective execution class from facts rather than trusting the model
(`deriveProbeRoutingDecision`, `:217-243`). A mutation flagged by `artifactOrMutation` forces
`objectiveMode: "delivery"` (`:328-330`).

**Fail-closed behaviour at HEAD (changed).** At `41baea75` an unparseable or throwing router call
returned `{ route: "factory" }`. At HEAD `resolveChatLayerModelDecision` (`:463-506`) reads the
decision once, then, if it is missing, or is a `factory` decision with no `requestedProviders`, or
there is prior context, re-asks the model to "Review this candidate routing decision for dependency
scope" (`:492-503`). If the second read also fails it **throws**
`CHAT_ROUTING_UNAVAILABLE_MESSAGE`:

> "Receipt couldn't determine the access needed for this request. Please retry; no task was started."
> (`:460-461`, thrown at `:505`)

So the web router no longer defaults to Factory; it refuses the turn. On the web the throw reaches
the outer catch (`receipt-chat.service.ts:4102-4118`): because `chatTurnStarted` is already true,
the turn is recorded as failed and `formatReceiptRuntimeFailureResponse` (`:1153-1165`) writes the
final assistant message through `formatReceiptJobFailureResponse` (`:1113-1140`), which renders:

```
Beetle stopped before completing this response.

Status: failed.
Reason: Receipt couldn't determine the access needed for this request. Please retry; no task was started.

This was reported by the Beetle runtime; it was not a normal completed answer.
```

A separate, older fail-closed rule survives inside the payload builder: a factory decision with no
parseable `objectiveMode` defaults to `delivery` ("Fail closed to delivery so unknown work receives
integration and strict verification", `receipt-chat.service.ts:2132-2137`).

After routing, a progress receipt is recorded with one of `Chat router selected Factory for
tool-backed work.`, `Chat router selected organization skill authoring.`, or
`Chat router selected the app chat layer.` (`:3491-3504`). A heartbeat shows
`Beetle is preparing the response.` while the router runs (`:3466-3471`).

### 1.4 `route: "chat"` (direct answer)

`receipt-chat.service.ts:3605-3679`. The system prompt is the resolved Beetle profile
(`resolveFactoryChatProfile`, `:1568`; fallback prompt "You are Beetle, the product chat profile
for beetle.run…" at `:93-99` if the profile cannot be loaded) plus
`buildDirectChatSystemPrompt` wrapping `buildProfileAwareDirectResponsePrompt`
(`chat-layer-routing.ts:387-407`). That prompt instructs, verbatim: "Your response is posted
verbatim. Write only natural, helpful chat prose—never JSON, routing commentary, a workflow
acknowledgement, or an invented tool result." (`:393`) and "Connection status and Manage tools
policy are separate… direct them to Global Integrations > Manage tools" (`:397`).

The model call is `modelGateway.streamResponse` with **`tools: {}` and `activeTools: []`**
(`receipt-chat.service.ts:3624-3631`). No provider-native tool is attached on the direct path.
Streaming uses `smoothStream({ delayInMs: 15 … })` (`model-gateway.service.ts:236-237`). Only
OpenAI-routed models are accepted without BYOK: `Selected model does not support platform OpenAI
routing: <modelId>` (`model-gateway.service.ts:116`).

Context passed: the sanitised message list (reasoning stripped) plus a bounded "recent context"
of at most 8 prior messages, 2,000 chars each, 8,000 chars total
(`RECEIPT_CONTEXT_*` at `receipt-chat.service.ts:116-118`; renderer `:1797-1839`).

**Classification: Reachable.**

### 1.5 `route: "organization_skill"`

`receipt-chat.service.ts:3505-3560`. The system prompt is `You author one organization agent skill
from the current user request.` (`:3510`). `draft` previews; `save` persists to the organization's
skills, which live at `/organization/settings/skills` (`ORGANIZATION_SKILLS_SETTINGS_PATH`,
`:106`). External channels never reach this branch: `normalizeExternalChatLayerDecision`
downgrades it to Factory (`chat-layer-routing.ts:91-97`).

**Classification: Reachable (web only).**

### 1.6 `route: "factory"` (background objective)

Sequence (`receipt-chat.service.ts:3679-3830`):

1. `recordChatTurnStartedOnce` (`:3681`), then required capabilities are derived from the
   router's `requestedProviders` (`:3684-3687`).
2. **Not connected** short-circuit: `formatReceiptConnectSetupResponse` (`:1283-1324`) writes
   `{Provider} is not connected in Global Integrations yet.` … `Open [Integrations](/organization/settings/integrations), connect {Provider}, then retry this chat request.`
   and, when the snapshot is online, `Connected capabilities right now: {list}.`; when the
   snapshot could not be fetched: `I cannot confirm {Provider} is connected right now because Receipt Connect status could not be checked.`
3. **Policy denied** short-circuit (`formatReceiptConnectPolicyDeniedResponse`, `:1419-1441`):
   when every usable connection has an `actionPolicy.schemaVersion === 2` with an empty
   `enabledActions`, the reply is
   `{Provider} is connected in Global Integrations, but you don't have access to any enabled {Provider} tools right now.` … `Open [Integrations](/organization/settings/integrations), choose {Provider} > Manage tools, enable the required tool, then retry this chat request.`
4. `POST <serverUrl>/agents/factory/jobs` (`:3757-3787`) with
   `buildReceiptFactoryChatJobPayload` (`:2061-2225`):
   `kind: 'factory.run'` (`:2145`), `jobId: <requestId>` (`:2146`), `lane: 'chat'` (`:2147`),
   `sessionKey: factory-chat:<sessionStream>` (`:2148`), `singletonMode: 'allow'` (`:2149`),
   `maxAttempts: 2` (`:2150`), `profileId` (default `receipt`, env override
   `RECEIPT_APP_CHAT_PROFILE_ID` / `RECEIPT_FACTORY_CHAT_PROFILE_ID`, `:90-91, 122-125`),
   `config: { maxIterations: 1, maxToolOutputChars: 6000, memoryScope: 'factory-chat:auto', workspace: '.' }`
   (`:2138-2143`), `authContext: { userId, organizationId, workspaceId: <org global scope>, receiptConnectGatewayUrl, sessionId: <requestId>, source: 'app-chat' }`
   (`:2169-2176`), `dispatchDefaults: { action, objectiveId?, objectiveMode, checks: [], requiredCapabilities?, probeRouting? }`
   (`:2204-2215`), and a long `problem` prompt (`:2218`).
   `action` is the router's action, else `react` when an objective is bound and `create`
   otherwise (`:2114-2116`); a `create` on a bound thread deliberately drops the prior objective's
   messages and context so a new receipt boundary cannot inherit unattestable evidence
   (`:2117-2128`).
   **Changed since `41baea75`:** `requestedProviders` is now `[]` when there is no router decision
   (`:2094-2098`) and `capabilityContext.source` is always `'latest-user-turn'` (`:2190-2195`);
   previously the whole active-integration inventory became requested providers.
5. A transient progress part and a chat-turn progress receipt with the text
   **`Beetle queued job <jobId>.`** (`:3800-3813`), then `onAsyncQueued` (`:3816`).
6. A detached task follows progress and waits for the terminal job (`:3820-3985`). On
   `completed`, `resolveReceiptFinalResponse` supplies the answer; otherwise
   `formatReceiptJobFailureResponse` (`:3903-3913`). `onAsyncSettled` finalises the message
   (`:3983`, `:4008`).

Inside the runtime, the chat-lane job is not a free-form tool loop: `packages/receipt-app/src/agents/factory/chat/run.ts:505-560`
plans and executes exactly one `factory.dispatch` tool call (`action.planned` → `tool.called` →
`tool.observed`), which creates or reacts on a Factory objective. The objective supervisor then
owns every iterative decision ("Factory ingress performs one create/react/control action",
`receipt-chat.service.ts:2135-2137`).

**Classification: Reachable.**

### 1.7 Stop and failure text from a Factory run

- Stopping mid-run (abort signal) records the note `chat stream stopped before Beetle finished`,
  aborts the job, and writes the failure response with `status: 'canceled'`
  (`receipt-chat.service.ts:4027-4060`).
- `formatReceiptJobFailureResponse` (`:1113-1140`) renders
  `Beetle stopped before completing this response.` / `Status: {status}.` / `Reason: {≤400 chars}` /
  `This was reported by the Beetle runtime; it was not a normal completed answer.` Two special
  cases run first: a failure that names a missing Receipt Connect capability shows the
  "not connected" message instead (`:1071-1085`); a failure matching
  `computer-unavailable|opensandbox|sandbox|controller acquire|econnrefused` shows
  `The Factory computer runtime is not available, so this objective did not run to completion.` /
  `Runtime reason: {reason}` / `Check that the OpenSandbox controller and local Receipt stack are running, then retry the request.`
  (`:1088-1111`).

---

## 2. The composer

Component `apps/start/src/components/chat/chat-input.tsx` (514 lines) with
`prompt-input/prompt-input-actions-menu.tsx` (158 lines).

### 2.1 The `+` menu (order at HEAD)

`prompt-input-actions-menu.tsx:79-155`, trigger `aria-label` **"Open input actions"**
(`chat_prompt_actions_open_aria_label`, `en.json:227`):

1. **Attach files** / **Attach files (max reached)** (`:79-90`; strings `en.json:225-226`).
   Disabled when `!canAddMore || !canUploadFiles`.
2. **Skills** submenu → **Create skill** (`:91-107`) — **new in `c3c16be6`**. It only navigates to
   `/organization/settings/skills` (`:99-101`). That page is owner/admin-gated (see §12), and its
   primary button is labelled **"Add skill"**, not "Create skill"
   (`apps/start/src/components/organization/settings/skills/skills-page.tsx:435`); page copy is
   **"Skills"** / "Add organization instructions that agents can use in Factory and computer runs.
   Enabled skills are available to new runs." (`:370-371`). A plain member who clicks Create skill
   is bounced by the org-settings layout to `/` (`routes/(app)/_layout/organization/settings/route.tsx:31-38`).
3. **Study Mode** checkbox (`:108-120`), tooltips **"Enable Study Mode"** /
   **"Study Mode is enforced by your organization"** (`en.json:208, 210`). Study Mode pins
   `openai/gpt-oss-120b` and disables all provider tools
   (`apps/start/src/lib/shared/chat-modes/registry.ts:7-26`).
4. **Max** checkbox, literal string, only when the model has a distinct max context window
   (`:121-129`).
5. **Tools** group of checkboxes, hidden while Study Mode is on (`:130-154`, label `en.json:228`).
   Unchecking adds the key to the thread's `disabledToolKeys`. Because the direct path sends
   `tools: {}` (§1.4), these checkboxes affect analytics and policy recording only —
   **Inert at runtime** for the direct answer.

### 2.2 Model and reasoning pickers

`ModelSelectorPanel` and `ReasoningSelectorPanel` exist only in
`apps/start/src/components/chat/composer-bar/{model-selector-panel,reasoning-selector-panel}.tsx`
and are not referenced by any non-test component (repo grep). The toolbar's `afterAttach` slot
is unused by `ChatInput`. **Absent from the UI at HEAD.** Defaults still apply:
`DEFAULT_CHAT_MODEL_ID = 'openai/gpt-5.6-luna'` and
`MODEL_SELECTOR_ALLOWED_PROVIDER_IDS = ['openai']`
(`composer-bar/model-selector-policy.ts:9-18`).

### 2.3 Context hover card

Rendered only inside a thread when a model is resolved (`chat-input.tsx:338-363`): trigger
`aria-label` **"Model context usage"**, rows **Input**, **Output**, **Reasoning**, **Cache read**,
**Cache write**, footer **Total cost** when a public cost exists
(`en.json:190-196`; `composer-bar/context-window.tsx:237`). Cost is shown when the org used BYOK
or the server sets `ALLOW_USER_COST_DISPLAY=true` (`app-feature-flags.ts:60`).

### 2.4 Send/stop states, placeholders, paste, titles

- Submit labels: **Send message**, **Sending...**, **Stop generation**, **Error**
  (`en.json:245-248`). `isSendBlocked = isBusy || hasPendingUploads || isContextLimitReached`
  (`chat-input.tsx:151`).
- Placeholder: new chat cycles `ROTATING_PLACEHOLDER_PROMPTS` ("Ask Receipt to …" set,
  `prompt-input/rotating-placeholder-prompts.ts`); inside a thread **"Ask anything"**
  (`chat-input.tsx:439`, `en.json:224`).
- Inline context banners: when the limit is reached the composer shows
  `This conversation has reached the standard context limit. Switch to Max to continue with the larger window.`
  or `This conversation has reached its current context limit. Start a new chat to continue.`
  (`chat-input.tsx:144-150`).
- Paste-to-attachment: plain-text pastes of ≥ 2,000 characters become a `.txt` attachment named
  `pasted-text-YYYY-MM-DD-HH-MM-SS.txt` (`chat-input.tsx:46, 76, 320`); gated on the embedding flag.
- Empty state: **"Hello,"** + user name and **"What would you like to explore?"**
  (`chat-welcome-screen.tsx:20-26`; `en.json:341-342`). The six suggestion strings in `en.json`
  (`:343-354`) are not rendered.
- Thread titles: default **`New Chat`** (`thread.service.ts:30`); auto-titled once from the first
  message using `openai/gpt-5-mini` unless `CHAT_TITLE_GENERATION_MODEL` is set (`:920-926`),
  prompt `Generate a short 3-4 word title for this user message. Return only the title.` (`:518`),
  message truncated to 200 chars (`:918`); skipped when `userSetTitle` (`:469`).
- `Control+B` toggles the page sidebar (`chat-page-shell.tsx:54`).

---

## 3. Threads

### 3.1 Message tree, edit, regenerate

`apps/start/src/lib/shared/chat-branching/branch-resolver.ts`: root key `__root__` (`:46`),
`resolveCanonicalBranch` (`:84`), `resolveRegenerationAnchor` (always a user anchor, `:184`),
`resolveEditableUserTarget` (only user messages on the canonical path, `:222`),
`resolveBranchSelectionPath` (`:270`). Every write carries `expectedBranchVersion` and is rebased
once on conflict (§1.2); the unrecoverable case shows
`This chat changed in another tab or session. Refresh and try again.` (`en.json:322`).

User-message hover actions (`message-parts/actions/user-message-actions.tsx:105-190`):
**Regenerate response**, **Edit message**, **Copy text**, while editing **Cancel edit** /
**Save edit** (**Saving edit** / **Saving**), and a **Previous branch version** / **Next branch
version** pager (`en.json:198-206`). Pending optimistic branches are prefixed
`__pending_regen_branch__` / `__pending_edit_branch__` (`:10-11`). Assistant actions:
**Regenerate response**, **Copy text** (`assistant-message-actions.tsx:41-53`). There is no
per-message delete and no explicit "fork" verb. **Reachable.**

### 3.2 Sidebar groups, actions, status pills

`apps/start/src/components/chat/chat-sidebar.tsx`; strings `en.json:266-300`: **New Chat**,
**Chat History**, **Projects**, **Search chats**; per-thread **Rename**, **Copy link**, **Pin** /
**Unpin**, **Delete**; groups **Pinned**, **Today**, **Yesterday**, **Last 7 Days**,
**Last 30 Days**, **Older**; empty **No chats yet**; untitled **Untitled**; toasts
**Thread renamed**, **Failed to rename thread**, **Thread title cannot be empty**,
**Objective deleted** (the delete-thread success toast, key `chat_sidebar_thread_deleted`),
**Failed to delete thread**, **Failed to update pinned state**. Status pills **Pending** /
**Generating** / **Error** with descriptions ("This chat is queued; a response will be generated
shortly.", "Beetle has started generating the response.", "Something went wrong and the response
could not be generated.", `en.json:287-292`). **Changed in `46652e84`:** these no longer open a
hover tooltip; the spinner/warning icon carries `role="img"` with `aria-label`
`"<state>: <description>"` (`chat-sidebar.tsx:260-289`). Upgrade card strings
(`en.json:283-286`) still exist.

### 3.3 Search (Cmd/Ctrl+K)

`chat-search-command-dialog.tsx`: 120 ms debounce (`:27`), title **Search chats**, placeholder
**Search threads and messages...**, empty states **Type a thread title or message text.** /
**No matching chats found.**, error **Search failed. Try again.** (`en.json:301-312`).
`isLoading={false}` is still passed (`:317`), so **Searching chats...** never shows. Actions
group **New chat**, **Account**, **Skills** (new in `c3c16be6`, navigates to
`/organization/settings/skills`, `:268-280`), **Switch to dark mode** / **Switch to light mode**
(`:243`). The sidebar entry opens the dialog with `hideActions: true` (`chat-sidebar.tsx:147-148`).
**Reachable.**

---

## 4. Files and attachments

- Accepted extensions (`apps/start/src/lib/shared/upload/upload-validation.ts:80-104`):
  `.pdf .jpeg .jpg .png .webp .svg .txt .html .htm .xml .xlsx .xlsm .xlsb .xls .et .docx .ods .odt .csv .md .markdown .numbers`.
- Size 10 MB (`upload.model.ts:1`), organization knowledge 25 MB (`:3`); 10 files per message
  (`use-file-attachments.ts:30`, `chat-input.tsx:122`).
- Validation strings: **File type is not supported for markdown conversion**, **File is empty**
  (backend rewrites to **Uploaded file is empty**), **File exceeds limit of 10MB**; drop-hint
  strings `en.json:229-235`; attachment pill strings `en.json:236-241`.
- Conversion: text-like types are read directly; PDF, images, Office/OpenDocument/Numbers go to
  the Cloudflare worker (`CF_MARKDOWN_WORKER_URL`, `CF_MARKDOWN_WORKER_TOKEN`,
  `CF_MARKDOWN_WORKER_TIMEOUT_MS`), else self-hosted instances answer
  `This self-hosted instance only accepts direct text attachments until the markdown worker is configured.`
  (unchanged since the map; `routes/api/files/upload/route.tsx`).
- Retrieval preset (`rag/pipeline-config.ts:14-22`): chunk 1,600 chars, overlap 260, max 140
  chunks/doc, retrieve up to 8 chunks / 12,000 chars, fallback excerpt 2,000 chars, embedding
  `openai/text-embedding-3-small`. Org knowledge: 1,800 / 280 / 260 / 10 / 14,000 / 2,200 (`:24-32`).
- Native vs fallback: images go to the model natively only if `supportsImageInput`, PDFs only if
  `supportsPdfInput`; generic file support is deliberately ignored
  (`message-store/operations/load-thread-messages.ts:45-59`).
- Organization knowledge injection is gated on `orgPolicy.orgKnowledgeEnabled` and only uses
  attachments with `orgKnowledgeActive = true` and `embeddingStatus = 'indexed'`
  (`load-thread-messages.ts:431, 512-513`).
- File uploads are not plan-gated today (`hasFeatureAccess` returns `true`,
  `shared/access-control/index.ts:398-403`), even though **"File uploads are available on paid
  plans only. Upgrade to attach files in chat."** (`en.json:339`) exists.

**Classification: Reachable** (attachment pipeline); org-knowledge injection **Reachable** when
enabled by an admin.

---

## 5. Memory and context

`docs/memory.md` and `docs/context-management.md` describe the model accurately at HEAD:
memory is receipt-backed (`memory/<scope>` streams), projected into `memory_entries` /
`memory_accesses` (`docs/memory.md:32-70`), with `read | search | summarize | commit | diff |
reindex` operations and `memory.committed / accessed / forgotten` events (`:86-160`).

What chat actually uses:

- App-chat receipts are written with `memoryScope: 'app-chat'`
  (`apps/start/src/lib/backend/receipt/chat-bridge.ts:144, 266`).
- Factory chat jobs carry `memoryScope: 'factory-chat:auto'`
  (`receipt-chat.service.ts:91, 2140`); the chat lane resolves the effective scope from the
  bound objective at run time (`agents/factory/chat/run.ts:361-365`).
- Conversation memory (`packages/receipt-app/src/services/conversation-memory.ts`) composes durable
  user preferences from `organizations/<org>/users/<user>/preferences` and `/profile` (or
  `users/<user>/…`, repo-scoped variants under `repos/<repoKey>/…`, `:61-79`) with session recall
  from projected `session_messages` (`:47-49`). Nothing in `apps/start/src/lib/backend` or the
  chat lane calls `loadConversationProjection` / `summarizeUserPreferences` (repo grep), so
  **preference memory is not injected into the web chat prompt at HEAD**; it is a CLI / runtime
  surface (`bun src/cli.ts memory prefs …`, `docs/memory.md:289-296`).
- What persists across turns for the model is the bounded transcript (8 messages / 2,000 chars /
  8,000 chars, `receipt-chat.service.ts:116-118`), the bound objective's latest summary and output
  (`:2086, 3769-3779`), and the Factory objective's own scoped memory
  (`factory/objectives/<objectiveId>`, `docs/memory.md:213-233`).

**Classification:** memory subsystem **Reachable** via CLI/runtime; preference injection into web
chat **Absent**.

---

## 6. Background runs from chat

### 6.1 Progress panel

`apps/start/src/components/chat/chat-thread.tsx`: a `RuntimeThinkingPanel` with an `aria-label`
**"Progress details"** list (`:301`), rows announced as **Failed** / **Completed** /
**In progress** / **Queued** (`:308-316`), last 6 de-duplicated steps (`:420`), headline fallback
**Starting Beetle...** while streaming and **Finished** otherwise (`:714`), screen-reader prefixes
**Needs attention:** / **Working:** / **Completed:** (`:754-757`). Humanised strings
(`presentRuntimeActivityText`, `:377-393`): **Captured reasoning**, **Planned background run**,
**Started background run**, **Reconnected to Beetle**, **Tracking the objective**.

### 6.2 Computer preview / Computer Logs

Button `title="Computer preview"` (`:529`) opens the **Computer Logs** dialog (`:542`) described
as **Live output from the workspace computer** or **Waiting for computer** (`:551-554`), with a
search box (`aria-label="Search computer logs"`, placeholder `Search logs…`, `:569-570`), an
**Errors {n}** toggle (`:584-586`), empty **No logs match your search or filter.** (`:480`), ASCII
art labelled **Beetle computer offline** (`:485`), and **Computer is active; waiting for shell
output.** when silent (`:673`). Buffer is 80 lines (`chat-context.tsx:281`).

### 6.3 Re-attach and objective push

`/chat?objective=<id>` (also `?objectiveId=`, `?objectId=`, or a `/chat/<objectiveId>` path segment)
resolves the objective's origin thread (`routes/(app)/_layout/chat/route.tsx:49-62, 84-92`). With
`VITE_CHAT_OBJECTIVE_PUSH` on (default `true`, `app-feature-flags.ts:67`) the thread reads status,
computer output and the final answer from the Zero-synced objective projection
(`chat-context.tsx:1603`), which is what lets a user close the tab and return to a finished
answer. **Reachable.**

### 6.4 Stop / cancel semantics

`chat-context.tsx:3455-3511`: the stop button closes the local stream; with no objective that is
the whole stop. With an objective it calls `stopObjectiveRun` with the objective id and every
visible job id (`:3498-3500`), then appends an assistant message reading exactly
**"This task is stopped."** (`:3464`). On failure the composer error reads
**"Stopped the response, but could not cancel the agent run."** (`:3509`). Server-side
(`lib/frontend/tasks/objective-control.server.ts`): each job is aborted via
`POST <runtime>/jobs/<id>/abort` (`:174`) and a control job of `kind: 'factory.dispatch'` with
`action: 'cancel'` is enqueued on `lane: 'chat'`, `sessionKey: tasks:<org>:<user>`
(`:55-75`); the result carries `pending: true` while the runtime has not yet reached a terminal
status (`:153`, type comment at `objective-control.functions.ts:17-22`).

### 6.5 Failure banners

Error envelope UI: red alert with **Dismiss error** and **Show TraceID** / **TraceID**
(`en.json:242-244`). Factory failure prose is the assistant message described in §1.7.

---

## 7. Replay dialog ("Agent replay")

`apps/start/src/components/chat/chat-receipts-dialog.tsx` (5,138 lines), mounted in the chat page
shell (`chat-page-shell.tsx:88`) and from the Tasks page (`tasks-page.tsx:918`).

- Header eyebrow **Agent replay** (`:4833`), title fallback **Waiting for a run** (`:4839`),
  sr description **Session summary and chronological agent transcript.** (`:4842`), buttons
  **Refresh agent replay** / **Close agent replay** (`:4919, 4929`; "on mobile" variants
  `:4816, 4826`).
- Tabs (**changed in `46652e84`** from `aria-pressed` buttons to a `TabList` labelled
  **Replay views**): **Summary**, **Transcript**, **Work** (`:4946-4962`), with live-region
  labels **Session summary** / **Transcript** or **Receipt log** / **Work done** (`:4966-4972`).
- Summary tab: a new **"Recorded outcome: {status}"** section shows the latest assistant text (up
  to 2,000 chars) or "The recorded status and activity below are available without an AI recap."
  (`:2311-2325`, new in `8e4c429e`); the optional AI recap with **Generate summary** / **Try again**
  (`:2102`), loading **Preparing optional AI recap…** (`:2071`), a 25 s client timeout that fails
  with "The AI recap took too long. Your recorded outcome remains available. You can try again."
  (`:4568`); stat rows **Estimated provider cost** / **Not recorded** (`:2341-2345`);
  counters **Commands**, **Tool calls**, **Connected-app calls**, **Verified outputs**
  (`:2243-2262`).
- Stages (`:1307-1358`): **Goal** (Objective, "No goal proof yet"), **Plan** (Tasks,
  "No planned steps yet"), **Work** (Jobs, "No background work recorded yet"),
  **Tools & Commands** (Commands, "No tools or commands recorded yet"), **Evidence**
  ("No evidence captured yet"), **Result** (Answer & status, "No result recorded yet").
- Receipt inspector default text **Select a proof event to inspect what changed and why it
  matters.** (`:643`); **Replay to this step** / **Replaying…** (`:2896, 2917`).
- Filters `Problems, State changes, Evidence, Commands, Jobs, Memory, Computer`
  (`lib/frontend/chat/chat-receipts.functions.ts:5-11`), "all" renders as **Everything**
  (`:1008, 1111`); search placeholders **Search hash or payload** (`:993`) and
  **Search messages, tools, commands, or output** (`:1096`); Work filters **All work**,
  **Connected apps**, **Verified outputs** (`:3178-3182`); loading
  **Reconstructing work from receipts** (`:3278`).
- Print: **Print all records to PDF** opens the browser print dialog (`:947-955`).
- Errors: **Receipts are not available for this task yet. Try again in a moment.** /
  **…for this thread yet…** (`:4482-4483`), **Unable to load receipts for this task.** /
  **…for this thread.** (`:4503-4504`).

**Classification: Reachable.**

---

## 8. Monitoring pages: `/tasks`, `/sessions`, `/computers`

All three nav areas set `hideFromPrimaryNavigation: true`
(`components/tasks/tasks-nav.config.tsx:22`, `sessions/sessions-nav.config.tsx:20`,
`computers/computers-nav.config.tsx:20`), so none has a sidebar row. Each route redirects
unauthenticated or anonymous users to `/auth/sign-in?redirect=…` and has no admin gate
(`routes/(app)/_layout/{tasks,sessions,computers}/route.tsx:5-19`).

| Page | Reach | Header | Notable strings |
|---|---|---|---|
| `/tasks` | **Hidden** (direct URL; also linked from Slack/Teams "View Receipt"-style links only via `/chat?objective=`) | **Beetle Tasks** / "Task workspace for Beetle, backed by connected objectives and proof-oriented agent runs." (`tasks-page.tsx:172-173`) | Tiles **Unresolved**, **Running**, **Blocked**, **Done** (`:178-181`); **New Task** (`:186`); **Live runs** (`:198`); empty **No Beetle tasks yet** (`:253`); row actions **Receipts** (opens Agent replay, `:918-927`), **Thread**, confirm **Cancel task** / **Delete objective** (`:986, 1022`); create panel lanes **Improvement check** / **Add/improve integration** (`:667, 692`), fields **Title**, **Problem**, **Priority**, **Scope**, **Context and constraints**, **Done when**, **Attach context**, buttons **Discard** / **Save draft** / **Create task** (`:495-635, 761`), draft key `beetle-task-draft` (`:106`) |
| `/sessions` | **Hidden** | **Sessions** / "Find token waste, compliance risks, replay gaps, and reusable lessons from Claude activity." (`sessions-page.tsx:586-587`) | Modes **Checks**, **Replay**, **Lessons**, **Evidence** (`:40-43`); list **Agent sessions** (`:652`); empty **No imported sessions yet** (`:436`); error **Session data unavailable** (`:461`) |
| `/computers` | **Reachable** via the footer **Beetle runners** row only (`sidebar-computer-capacity.tsx`, tooltip removed in `46652e84`, description now the `aria-label`) | **Computers** / "{provider} capacity and live execution output" (`computers-page.tsx:343-344`) | Panels **Current work** (**No running jobs**), **Live output** (**No live computer output**), **Inventory** (**Beetle computer standby**), **Active runs** (**No active runs**) (`:374-442`) |

`/agent-registry/dashboard` now redirects to `/agent-registry/registry?tab=dashboard`
(`routes/(app)/_layout/agent-registry/dashboard.tsx:4-13`, new in `c3c16be6`); the Agents sidebar
area has a single child **Registry** (`agent-registry-nav.config.tsx:21-30`).

---

## 9. Slack app (`apps/slack`)

### 9.1 Install flow

- Sidebar row **Slack** under the Chat area links to `/api/slack/install` in a new tab
  (`app-sidebar.tsx:429-448`; `SLACK_INSTALL_HREF`, `sidebar/app-sidebar-primary-actions.tsx:5`).
- `GET /api/slack/install` (`routes/api/slack/install/route.tsx:9-31`): no session / anonymous /
  no active org → 401 `Sign in and select a workspace before installing Slack.`; not an org
  admin → 403 `Only workspace admins can install Slack.`; else 302 to the Slack service's signed
  install URL.
- Scopes (`packages/receipt-core/src/slack.ts:3-10`): `app_mentions:read`, `channels:history`,
  `chat:write`, `reactions:write`, `users:read`, `users:read.email`.
- Service (`apps/slack/server.ts`): invalid state → `Slack installation state is invalid or
  expired. Start again from Receipt.` (`:1272, 1301`); `Installation cancelled: …` (`:1292`);
  `Installation failed: …` (`:1310`); success `@receipt added to <team>!` (`:1383`) with
  "Go to any channel, type /invite @receipt, then mention @receipt to get started." Landing page
  **@receipt for Slack** / "Add the Receipt AI agent to your Slack workspace." / "Mention
  @receipt in any channel to start a background AI run." / **Add to Slack** (`:1254-1258`).
- Distribution path without signed state parks an encrypted bot token and redirects to
  `/auth/slack-install?claim=…`, which requires a signed-in org owner/admin to claim; page copy
  **Connect Slack to Receipt**, **Connect Slack workspace**, **Slack connected** (unchanged from
  the map; `components/auth/slack-install/slack-install-page.tsx`).

### 9.2 Identity and message lifecycle

- `resolveSlackUser`: linked row → run as that Receipt user; else email from `users.info`;
  no email → `Receipt needs access to your Slack email before it can add you to this workspace.
  Ask a Receipt admin to reinstall Slack with users:read.email, then mention Receipt again.`
  (`server.ts:599`); unknown email → invitation and
  `Sign up for Receipt as <email> to join this workspace. After signup, mention me again with your question:` + link (`:609`).
- Routing (`:698-729`, **changed in `ab7b00b0`**): `resolveSlackChatLayerDecision` now throws
  when `/chat/route` fails or returns nothing (`apps/slack/slack-chat-routing.ts:78-95`). The
  server appends a `slack.thread.routing_failed` receipt
  (`packages/receipt-app/src/services/slack-thread-flow.ts:50`) and posts
  `<@user> Receipt couldn't determine the access needed for this request. Please retry; no task was started.`
  Previously it silently fell back to Factory with the prior providers.
- `route: 'chat'` (`:727-786`): `POST /chat/respond`; on failure
  `I couldn't generate a reply just now. Nothing was run—please try again.` (`:740`); on success one
  new message `<@user> <text>` and a `slack.thread.direct_turn_resolved` receipt.
- `route: 'factory'`: `providers_selected` receipt (`:788-807`), `:eyes:` reaction (`:808-815`),
  status message `:hourglass_flowing_sand: <@user> *Working on it…*` / `_I’ll post the result in this thread._`
  (`slack-objective-response.ts:271`), then funding, enqueue (`lane: 'chat'`,
  `sessionKey: slack:<team>:<channel>:<threadTs>`, `maxIterations: 8`), 5 s polling, throttled
  edits (`SLACK_PROGRESS_UPDATE_INTERVAL_MS` default 20,000, `SLACK_MAX_PROGRESS_MESSAGES_PER_RUN`
  default 12, `server.ts:104-105`), terminal message with a `View Receipt` link
  (`slack-objective-response.ts:306`).
- Funding (`apps/slack/slack-platform-credit.ts`): BYOK validated live; without BYOK it reserves
  5,000,000 nanoUSD of platform credit with a 15-minute TTL (`:5-6`). Errors:
  `This workspace does not have platform credit or an OpenAI provider key.` (`:209`),
  `This workspace has exhausted its platform credit.` (`:239`),
  `Receipt could not verify the workspace OpenAI key right now. Please try again.` (`:99, 105`).
- Other user-visible strings: `Receipt could not start a run: <message>` (`server.ts:1075`),
  `Receipt lost contact with the runtime: <message>` (`:1094`),
  `The objective is still working and is taking longer than expected.` (`slack-objective-response.ts:365`),
  `This is taking longer than expected.` + link or `Please try again in a moment.` (`server.ts:1218-1219`).

### 9.3 Not implemented in Slack

Slash commands, interactive buttons/`block_actions`, modals, DMs (`message.im`), app home, file
uploads, message shortcuts (no such handlers exist in `apps/slack`). There is no approval prompt
in the thread. Progress is edited, never streamed.

**Classification: Reachable** (mention → run → result). Approval interactions **Absent**.

---

## 10. Teams app (`apps/teams`)

- Transport: Express + `@microsoft/teams.apps` `ExpressAdapter` (`server.ts:25-31`),
  `GET /health` → `{ ok, configured }` (`:26`), messaging endpoint the SDK default `/api/messages`
  behind the gateway's `/teams` prefix. Listens on `PORT` default `3978` (`:16`).
- Env: `CLIENT_ID`, `CLIENT_SECRET`, `TENANT_ID` (all three required, `:19-20`),
  `RECEIPT_WEB_URL` → `BETTER_AUTH_URL` (`:18`), `ZERO_UPSTREAM_DB` (`:21`),
  `TEAMS_DEFAULT_PROFILE_ID` default `receipt` (`teams-runtime.ts:35`). Unconfigured: logs
  `CLIENT_ID, CLIENT_SECRET, and TENANT_ID are required before the Teams messaging endpoint is enabled.`
  (`:223-226`) and still listens.
- **Docs contradiction persists:** `docs/ms-teams-testing-setup.md:36-40` tells operators to set
  `TEAMS_CLIENT_ID` / `TEAMS_CLIENT_SECRET` / `TEAMS_TENANT_ID`, while
  `docs/teams-app-private-distribution.md:23-24` and the code use the unprefixed names.
- Install: `install.add` sends `Receipt is ready. Connect this Teams tenant to a Receipt workspace to finish setup.` + claim link (`:47`);
  the claim is a 10-minute signed token, replayable, no consumed record.
- Messages (`:67-202`): `help` → `Mention Receipt with the work you want done. I will acknowledge it here, run it through Receipt, and post the durable result back to this conversation.` (`:88`);
  no installation → `Receipt needs a Teams administrator to connect this tenant to a Receipt workspace.` + link (`:95`);
  no user link → `Link your Teams identity to your Receipt account before I run this request.` + link (`:100`);
  ack `Receipt received this request. I’ll post the result here.` (`:105`); DB-backed dedup
  `claimTeamsActivity` (`:104`).
- Routing: `resolveTeamsChatDecision` **still falls back to `{route:'factory'}`** on any error
  (`teams-routing.ts:28, 41-54`) — Teams did not adopt the fail-closed change that web and Slack
  received in `ab7b00b0`. It sends `priorProviders: []` and no `recentContext` (`:33-39`).
- `chat` → `POST /chat/respond`; undefined result throws
  `Profile-aware direct response unavailable.` (`server.ts:155`).
- `factory` → `enqueueTeamsJob` (`teams-runtime.ts:25-49`): `jobId: teams_activity_<activityId>`,
  `lane: "chat"`, `sessionKey: teams:<tenant>:<conversation>:<root>`, `maxAttempts: 1`,
  `config: { maxIterations: 8, … memoryScope: "factory-chat:auto" }`, `problem` = raw latest
  turn, `dispatchDefaults` without an `objectiveId`, `authContext` without `sessionId` or
  `workspaceId` (`:37-38`). Poll 5 s, deadline 10 min (`:132, 135`); final message
  `✅ | ⏳ | ⚠️` + Markdown + `Job: <jobId>` (`server.ts:178-183`); timeouts
  `This objective is still working and is taking longer than expected.` + `/chat?objective=<id>` link
  (`teams-runtime.ts:122-128`) or `This run is still working. Open Receipt to follow its live progress.` (`:154`).
- Error: `⚠️ Receipt could not complete the request: <message>` (`server.ts:199`). Without an
  OpenAI BYOK key the Factory funding layer throws
  `Factory platform funding requires an app-chat billing request id.`
  (`packages/receipt-app/src/services/factory-model-funding.ts:85`) because Teams passes no
  `sessionId`; Slack is special-cased via `slack_evt_` ids (`:54`).
- No progress updates, no message edits, no reactions, no thread history in the prompt, no
  objective rebinding on follow-ups, no approval prompts.
- Packaging: `bun run teams:package` → `scripts/package-teams-app.mjs` requires `TEAMS_BOT_ID`
  (GUID), optional `TEAMS_APP_ID`, `TEAMS_APP_VERSION` (`x.y.z`) (`:8-17`); manifest name
  **Receipt** / **Receipt durable background agent**, scopes personal/team/groupChat,
  `supportsFiles: true`, one command `help` ("Show how to use Receipt"), permissions `identity`
  (`apps/teams/app-package/manifest.json.template:13-31`).

**Classification: Reachable** (custom-upload distribution). Approval interactions **Absent**.

---

## 11. Runtime channel-neutral endpoints

`packages/receipt-app/src/server/bootstrap.ts`:

- `POST /chat/route` (`:2587-2636`): requires an actor context (400 `actor_context_required`),
  requires the organization's OpenAI BYOK key (409 `openai_byok_unavailable`, "The organization
  must configure OpenAI BYOK before semantic chat routing can run.", `:2607-2611`), accepts
  `channel` (`slack`/`teams`, else `web`), `latestUserText`, `priorProviders`,
  `boundObjectiveId`, `recentContext`, `receiptConnectCapabilities`, and returns
  `{ ok: true, decision }` using `FACTORY_CHAT_MODEL` (`:2627-2632`). Because it calls the shared
  `resolveChatLayerModelDecision`, it now throws on an unusable decision (§1.3), which the Slack
  adapter turns into the "couldn't determine the access" message and the Teams adapter turns into a
  Factory fallback.
- `POST /chat/respond` (`:2643-2700`): 400 `latest_user_text_required` (`:2657`), 409
  `openai_byok_unavailable` ("…before Beetle can write a direct chat response.", `:2668-2672`),
  resolves the Beetle profile (`:2678-2682`) and returns `{ ok: true, response: { text, profileId } }`;
  an empty model answer is an error (`:2692`) and is never replaced by router text.

**Classification: Reachable** (private runtime network; used by Slack and Teams).

---

## 12. The sidebar at HEAD

`apps/start/src/components/layout/app-sidebar.tsx`. All hover tooltips were removed in
`46652e84` (`SidebarGroupTooltip` imports dropped from `app-sidebar.tsx`,
`sidebar-computer-capacity.tsx`, `sidebar-organization-menu.tsx`, `chat-sidebar.tsx`); the
i18n key `layout_organization_tooltip_description` was deleted (`en.json` diff).

Render order (`:196-206` filter, `:300-467` render):

1. Header: organization switcher (`SidebarOrganizationMenu`) and **Collapse sidebar** (`:286-297`).
2. Primary action **New** → `/chat` (`sidebar/app-sidebar-primary-actions.tsx:12-19`).
3. Areas from `NAV_AREAS` in this order (`sidebar/app-sidebar-nav.config.tsx:119-130`), filtered
   by `isPrimaryNavigationArea` (drops `hideFromPrimaryNavigation` and `railPlacement: 'utility'`,
   `:106-108`), by Singularity eligibility, and by `canManageOrganizationSettings` for every
   `ORG_SETTINGS_AREA_KEYS` entry:
   - **Chat** (title `chat_sidebar_title` = "Chat", `en.json:299`; `chat-sidebar.tsx:66, 159`;
     description "Chat with Beetle to ask questions, get answers, and collaborate on tasks.",
     `en.json:268`), expandable to the thread list; followed by the **Slack** row (`:429-448`).
   - **MCP Gateway** → `/organization/settings/workspaces`, child **Workspaces**; inside a workspace
     the child becomes **All workspaces** (`mcp-gateway-nav.config.tsx:35-83`).
   - **Model Gateway** → children **Models** (`/organization/settings/models`) and **Playground**
     (`/model-gateway/playground`) (`model-gateway-nav.config.tsx:25-44`).
   - **Agents** → child **Registry** (`agent-registry-nav.config.tsx:15-32`).
   - Owner/admin only, in `ORG_SETTINGS_ITEMS` order (`-organization-settings-nav.ts:147-308`):
     **Integrations**, **BYOK**, **Org Brain**, **Skills**, **Guardrails**, **Policies**.
     `Usage` and `Billing` are `railPlacement: 'utility'` (`:251-264`) and are filtered out of the
     primary list; `isUtilityNavigationArea` (`app-sidebar-nav.config.tsx:110-112`) has no caller,
     so they render nowhere in the sidebar (still true at HEAD).
   - **Singularity** only for the EE organization (`:198`).
4. Footer: **Docs** → `https://docs.kentron.ai/introduction` (`:57, 456-463`), **Beetle runners**
   (`SidebarComputerCapacity`, `:464-466`), theme toggle (`:467`).

Role gate: `useCanManageOrganizationSettings` calls Better Auth `getActiveMemberRole` and applies
`isAdminRole` (`lib/frontend/auth/use-auth.ts:77-105`); the settings layout allows `owner` or
`admin` (`-organization-settings-access.ts:9-17`).

**Normal member sees:** New, Chat (+ Slack), MCP Gateway, Model Gateway, Agents, Docs, Beetle
runners, theme. The organization menu shows **Account** only
(`sidebar-organization-menu.tsx:40-63`; label `en.json:663`) plus **Sign out** (`en.json:651`).

**Owner/admin additionally sees:** Integrations, BYOK, Org Brain, Skills, Guardrails, Policies,
and in the organization menu **Organization**, **Workspaces**, **Members**, **Models**
(`organizationSettingsMenuItems` = hidden-from-rail and not hidden-from-menu,
`-organization-settings-nav.ts:313-315`).

**Never in the sidebar:** Tasks, Sessions, Computers (except the footer widget), Usage, Billing,
Analytics, Knowledge, Security, Account.

---

## 13. Approval and "read-only by default": exactly what exists

Searched for `approval`, `approve`, `human.requested`, `confirm`, `connect:write`, `dry-run`
across `packages/receipt-app/src`, `apps/start/src`, `apps/slack`, `apps/teams`. Findings:

| Mechanism | Where | What it does | Class |
|---|---|---|---|
| Receipt Connect action access | `packages/receipt-app/src/services/receipt-connect-call.ts:1584-1590` | Each connector action has `access: "read" \| "write"`. Legacy (`schemaVersion 1`) policies enable every **read** action by default and only explicitly enabled **write** actions; `schemaVersion 2` policies enable only listed actions. | **Reachable** (admin policy) |
| `connect:write` scope check | `receipt-connect-call.ts:1904-1909` | A write action throws `integration action '<tool>' requires connect:write` unless the caller's token carries `connect:write`. | **Reachable** |
| Factory worker scopes | `services/factory/runtime/objective-execution-contract.ts:46-51` | The execution contract grants `connect:credential`, `connect:read`, and **`connect:write` whenever the objective has any required capability**. So a delivery objective holds write scope from the start; the only remaining gate is the admin's enabled-action list. | **Reachable** (no human step) |
| Manage tools policy editing | `server/receipt-connect-routes.ts:1555-1590` | `PATCH /connect/connections/:id/actions` requires `connect:write` **and** workspace mutation authority (owner/admin). Chat surfaces the denial message from §1.6. | **Reachable** |
| MCP gateway instructions | `services/receipt-connect-mcp.ts:28` | "Read-only annotations are authoritative. Writes appear only when the token and connection policy allow them; do not bypass a missing tool." Egress surface for external agents, not the chat. | **Reachable** |
| Tool approval policies | `services/policies.ts:36-39, 122-127`; UI `components/organization/settings/policies/tool-approval-panel.tsx:129-176` | The **Policies → Tool approval** panel says "Require a human decision before sensitive agent tools run… the agent waits until an approver responds on the channel you choose." Rules (tools, approval frequency, notify channel, approvers) are stored as receipts and projected. **No code outside `policies.ts` and the frontend reads `tool_approval` rules** (repo grep of `apps/start/src/lib/backend`, `packages/receipt-app/src/{server,services/factory,agents,engine}` returns nothing). | **Inert** |
| Guardrails | `apps/start/src/lib/backend/chat/services/guardrail-enforcement.service.ts:82-132` | `guardPrompt`, `guardResponse`, `guardToolResult` exist with `validate \| mutate` operations and `enforce \| enforce_but_ignore_on_error \| monitor_only` strategies (`packages/receipt-app/src/services/guardrails.ts:31-36`). **None of the three helpers has a caller**; the orchestrator never invokes them, and the only import is a cache invalidation from the settings server function (`lib/frontend/guardrails/guardrails.server.ts:93-98`). Factory code references guardrails only in tests. | **Inert** |
| SDK `human` action | `packages/receipt-app/src/sdk/actions.ts:49-51, 92-97`; runtime `engine/runtime/agent-loop.ts:1807-1823` (`human.requested`), `:980-990` (`human.responded`) | A durable human-in-the-loop primitive for **custom agents built on the SDK** (`receipt create agent --template human-loop` scaffold at `cli/commands.ts:155`; `docs/create-agent.md:84`). The Factory chat lane and objective supervisor do not use it. | **Reachable for SDK authors; Absent from chat/Factory** |
| Codex approvals | `adapters/codex-executor.ts:764-777` | Codex is launched with `-a never` and either `--sandbox <mode>` or `--dangerously-bypass-approvals-and-sandbox`. Codex itself never pauses for approval. | n/a |
| Factory review gate | `services/factory/delivery-diff-gate.ts:31-40`; `modules/factory/types.ts:42` (`awaiting_review`) | Candidates are reviewed and `approved` / `changes_requested` / `rejected` by the **model-driven reviewer** inside Factory, then merged ("merge approved candidate into integration worktree", `docs/factory-on-receipt.md:337`). Not a human gate. | **Reachable (automatic)** |
| Router objective mode | `chat-layer-routing.ts:439-440`; `receipt-chat.service.ts:2132-2137` | `investigation` (read-only evidence) vs `delivery` (mutations). Unknown intent fails closed to **delivery**, i.e. to the stricter verification path, not to a human. | **Reachable (classification only)** |
| Web/Slack/Teams confirm dialogs before running | `chat-context.tsx`, `apps/slack`, `apps/teams` | None. The only confirm dialogs are **Cancel task** / **Delete objective** on `/tasks` (`tasks-page.tsx:978-1022`) and **Delete skill?** (`skills-page.tsx:391`). | **Absent** |

Net: "read-only by default" is true only in the narrow sense that connector **read** actions
are enabled by default while **write** actions must be enabled by an owner/admin in Global
Integrations → Manage tools (for legacy policies) or listed explicitly (for v2 policies). Once a
write action is enabled, a delivery objective can call it without any per-action human approval;
Factory workers receive `connect:write` automatically. The Tool approval UI describes a wait-for-
approver behaviour that nothing implements.

---

## 14. User-visible error catalogue, rate limits, context limits

i18n (`apps/start/messages/en.json:318-340`), unchanged since the map:

| Key | Text |
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

`ModelProviderError` maps to `error_chat_provider_unavailable` with HTTP 502
(`lib/backend/chat/domain/error-classification.ts:112-117`). Rate limits: 30 requests / minute
per user (paid defaults; the free branch is unreachable, §1.2). Context limits: estimated as
`ceil(text.length / 4)` over text parts; the `Max` toggle only exists for models with a distinct
max window. Effectively dead strings on the current no-paywall contract:
`error_chat_free_allowance_exhausted`, `error_chat_file_upload_plan_restricted`,
`error_chat_model_requires_paid_plan`.

---

## Changes since 41baea75

`git log --oneline 41baea75..HEAD` lists 43 commits; seven touch the scoped paths. Behavioural
changes for this area:

1. **Router fails closed by refusing, not by defaulting to Factory** (`ab7b00b0`,
   `e6944514`). `resolveChatLayerModelDecision` retries once with a "review this candidate routing
   decision" prompt and then throws `CHAT_ROUTING_UNAVAILABLE_MESSAGE` ("Receipt couldn't determine
   the access needed for this request. Please retry; no task was started.")
   (`chat-layer-routing.ts:459-506`). A factory decision whose `requestedProviders` list is missing
   or contains unknown providers is treated as invalid rather than silently emptied (`:481-486`).
   Web users see the "Beetle stopped before completing this response." message with that reason;
   Slack users get the sentence directly and a `slack.thread.routing_failed` receipt
   (`apps/slack/server.ts:698-729`, `slack-chat-routing.ts:78-95`). **Teams was not updated** and
   still falls back to `{route:'factory'}` (`apps/teams/teams-routing.ts:28-54`).
2. **Inventory is no longer a dependency source** (`e6944514`). With no router decision the web
   payload sends `requestedProviders: []` and `capabilityContext.source: 'latest-user-turn'`
   (`receipt-chat.service.ts:2094-2098, 2190-2195`); the runtime ignores any legacy
   `source: "active-integrations"` context via `selectedFactoryCapabilityProviders`
   (`services/factory/capability-selection.ts:6-10`; used in `agents/factory/chat/run.ts:290` and
   `tools.ts:240, 386, 425, 512`). A new router rule forbids "select every integration as a
   fallback" (`chat-layer-routing.ts:442`). Rationale is recorded in
   `docs/tool-reliability-fixes-2026-09-05.md:9-11`.
3. **Composer `+` menu gained a Skills → Create skill submenu** (`c3c16be6`,
   `prompt-input-actions-menu.tsx:91-107`) that navigates to `/organization/settings/skills`; the
   Cmd/Ctrl+K Actions group gained a **Skills** entry (`chat-search-command-dialog.tsx:268-280`).
4. **Sidebar tooltips removed** (`46652e84`): `SidebarGroupTooltip` dropped from the app sidebar,
   the Beetle runners row, the organization menu, and chat thread status pills; descriptions moved
   into `aria-label`s. `layout_organization_tooltip_description` deleted from `en.json`.
5. **Replay dialog** (`46652e84`, `8e4c429e`): tabs are a proper `TabList` labelled "Replay views";
   a **Recorded outcome** section always shows the latest assistant text without waiting for the
   AI recap; recap loading label changed to "Preparing optional AI recap…"; recap requests are
   bounded to 25 s and invalidated when the source changes; the tool-stats table no longer forces
   a 660 px minimum width on phones.
6. **Agent Registry**: `/agent-registry/dashboard` redirects to `/agent-registry/registry?tab=dashboard`;
   the area now has one child (**Registry**); a scoped error boundary prints
   "Agent Registry couldn't load." with the error and a **Try again** button
   (`routes/(app)/_layout/agent-registry/route.tsx:19-33`).
7. **Chat-thread table rendering** (`message-parts/components/table-block.tsx`) was reworked with
   tests (`46652e84`); no string changes.

Not changed in scope: `/api/chat` route, orchestrator, thread/branching, attachments and RAG,
memory services, Teams adapter, Slack install flow, monitoring pages' copy, error catalogue.

The prior map contained one inaccuracy that predates these commits: the Chat area title is
**"Chat"** (`chat_sidebar_title`), not "Beetle Chat"; the latter survives only in a code comment
(`chat-sidebar.tsx:160`).

---

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

## Open questions

1. Is the Teams adapter intended to keep falling back to Factory on routing failure
   (`apps/teams/teams-routing.ts:28-54`), or was it missed in `ab7b00b0`? This is now the only
   channel that can launch a run without a validated provider selection.
2. Is Tool approval (`policies.ts` `tool_approval`) scheduled for runtime enforcement, and on which
   boundary: `receipt-connect-call.ts` (per action), the objective supervisor, or the SDK `human`
   action? The panel copy currently promises behaviour that does not exist.
3. Are the guardrail helpers (`guardPrompt` / `guardResponse` / `guardToolResult`) meant to be
   wired into `ChatOrchestratorService`? The service header comment says the orchestrator calls
   them at three points; it does not.
4. Should Factory workers receive `connect:write` only for `delivery` objectives rather than
   whenever any capability is required (`objective-execution-contract.ts:49`)? That single change
   would make "read-only by default" true at the worker level for investigations.
5. The Skills → Create skill composer item sends non-admin members to a page that redirects them
   home. Should the item be hidden for members, or should it open a member-safe flow?
6. Usage and Billing are `railPlacement: 'utility'` but never rendered by the sidebar; is a
   utility group planned, or should those items move into the organization menu?
7. The Chat area is titled "Chat" while descriptions and progress prose say "Beetle"; docs need a
   ruling on whether the assistant is publicly named Beetle or Receipt.
8. `docs/ms-teams-testing-setup.md` still documents `TEAMS_CLIENT_ID` / `TEAMS_CLIENT_SECRET` /
   `TEAMS_TENANT_ID`; the service reads unprefixed names. Which document is canonical?
9. The prior corpus counted 62 Nango provider slugs; `catalog.json` now lists 63 (one added in
   `26ec975a`). A docs page that states a number should regenerate it from
   `receiptConnectConnectorCatalog()` rather than hard-coding it.
