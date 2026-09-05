I have a complete picture. Here are my findings.

# Analytics & Telemetry Privacy Review — `kentron/Receipt`

## 1. Analytics SDKs initialized

**PostHog is the only third-party analytics/telemetry SDK in the repo.** No Sentry, Langfuse, Braintrust, Datadog, Segment, Mixpanel or Amplitude SDK is installed — the only dependencies are `posthog-js@^1.364.1` and `posthog-node@^5.28.8` (`apps/start/package.json:71-72`). Datadog/Sentry/Amplitude/Mixpanel/PostHog names elsewhere are only *Nango integration catalog entries* the user can connect to (e.g. `apps/start/src/components/organization/settings/integrations/integration-catalog.ts:81-126`), not instrumentation.

### Client (browser)
- Init: `apps/start/src/lib/frontend/observability/posthog.client.ts:35-62`.
- Bootstrapped from the **root shell** for every route including marketing/landing pages: `apps/start/src/routes/__root.tsx:69` (loader), `:216`, `:232` → `apps/start/src/components/app/posthog-client-bootstrap.tsx:13-27`. Init is deferred until `load` + `requestIdleCallback` (`apps/start/src/lib/frontend/performance/page-settled.ts:12-35`).
- Uses the **slim** bundle plus the error-tracking extension bundle only (`posthog.client.ts:3-4`), and calls `posthog.startExceptionAutocapture()` (`:58`) — i.e. global `window.onerror` / `unhandledrejection` capture.
- Client is a no-op on the server (`apps/start/src/lib/frontend/observability/posthog.ts:53-105`, every isomorphic fn has `.server(() => false/undefined)`).

### Server (Node)
- Init: `apps/start/src/lib/backend/chat/observability/posthog.server.ts:22-40`, lazily on first drain, with `enableExceptionAutocapture: false` (`:36`). Shutdown flush hooks on `beforeExit`/`SIGINT`/`SIGTERM` (`:13-20`).

### Env vars (names only)
`apps/start/src/lib/backend/chat/observability/posthog-config.server.ts:15-39`:
- `POSTHOG_PROJECT_API_KEY` — enables both client and server; **if unset, both SDKs are fully disabled** (`posthog.client.ts:40-43`, `posthog.server.ts:29-32`).
- `POSTHOG_HOST` — defaults to `https://us.i.posthog.com` (`apps/start/src/lib/shared/observability/posthog-config.ts:1`), i.e. **PostHog Cloud US** by default even for EU visitors.
- `RAILWAY_ENVIRONMENT_NAME` / `NODE_ENV` → `environment` property.
- `RAILWAY_GIT_COMMIT_SHA` / `GITHUB_SHA` → `release` property.
- `POSTHOG_PROJECT_ID`, `POSTHOG_PERSONAL_API_KEY` — source-map upload only; `getPostHogSourceMapConfig()` has **zero callers** (verified repo-wide) and `.env.example:229-231` says so explicitly ("currently inert").

Documented at `apps/start/.env.example:223-234`.

### Dev vs prod
There is **no dev/prod gate**. The only gate is (a) the API key being present and (b) `isSelfHosted`. If `POSTHOG_PROJECT_API_KEY` is set in a local `.env`, PostHog fires in development identically to production. `LOCAL_SETUP.md:230` tells local devs to leave `POSTHOG_*` blank, which is the de facto dev opt-out.

**Self-host:** `posthog-config.server.ts:17` returns `apiKey: undefined` when `isSelfHosted` (`apps/start/src/utils/app-feature-flags.ts:77`, driven by build-time `VITE_APP_INSTANCE_MODE=self_hosted`). Self-hosted instances therefore never send anything to PostHog, and this is surfaced in the UI as `status: 'not_available_in_self_host'` (`apps/start/src/lib/frontend/self-host/instance.server.ts:87-91`).

---

## 2. Complete list of events captured

There are **no product-analytics events**. Repo-wide grep for `posthog.capture(`, `.identify(`, `.group(`, `.alias(` returns exactly six call sites, and none of them is a named product event. **Everything sent to PostHog is an exception.**

### 2.1 Server: `$exception` from the chat wide event
`apps/start/src/lib/backend/chat/observability/posthog.server.ts:70-95` — `captureExceptionImmediate(error, distinctId, props)`.

- **distinctId** = `event.actor.userId` (`:70`)
- **Error name** = `outcome.error.tag`; **error message** = `outcome.error.message` (`:67-68`)
- Properties (`:71-94`): `$exception_fingerprint` (route:code:tag:captureMode, built at `:42-52`), `event_name`, `request_id`, `route`, `method`, `trigger`, `thread_id`, `organization_id`, `model_id`, `error_code`, `error_tag`, `retryable`, `telemetry_disposition`, `release`, `environment`, plus **whole nested objects**: `actor`, `thread`, `model`, `policy`, `stream`, `usage`, `outcome`, `breadcrumbs`, `cause`.

Expanding the nested objects (schema at `apps/start/src/lib/backend/chat/observability/wide-event.ts:56-112`):

| Group | Fields | Privacy notes |
|---|---|---|
| `actor` | `userId`, `organizationId`, `isAnonymous` | **Org ID and user ID sent, including for anonymous users** (`posthog.server.ts:70` does not check `isAnonymous`) |
| `thread` | `threadId`, `objectiveId`, `createIfMissing`, `expectedBranchVersion`, `actualBranchVersion`, `targetMessageId` | opaque IDs |
| `model` | `requestedModelId`, `resolvedModelId`, `modelSource`, `reasoningEffort`, `contextWindowMode`, `providerOverride` | **model names sent** |
| `policy` | `deniedFeature`, `providerKeyRequired`, `zeroDataRetentionRequired`, `allowedToolKeys[]`, `deniedToolKeys[]` | tool keys reveal which integrations an org has enabled (populated at `chat-orchestrator.service.ts:471-478`) |
| `stream` | `streamId`, `resumed`, `activePhase`, `aborted`, `cleanupState` | — |
| `usage` | `promptTokens`, `totalTokens`, `outputTokens`, `reservationBypassed`, `estimatedCostUsd`, `actualCostUsd`, `usedByok` | **token counts and USD cost sent** |
| `outcome` | `ok`, `status`, `level`, `captureMode`, `suppressLog`, `retryable`, `latencyMs`, `finalizedAt`, `error{code,tag,message,cause,i18nKey,i18nParams}` | see §2.2 |
| `breadcrumbs` | `{at, name, detail}` | all 5 call sites are metadata-only: `chat-orchestrator.service.ts:297` (trigger), `:565`, `:629`, `:740` (branch version numbers), `:1424` (errorTag) |

**No emails, no file names, no message/prompt text, no IPs are placed in properties explicitly.** But see the caveats below.

### 2.2 Free-text fields that can carry user content — the real risk
`outcome.error.message` and `outcome.error.cause` are **not fixed strings**. They come from `toReadableErrorMessage()` (`apps/start/src/lib/backend/chat/domain/error-formatting.ts:7-21`), which walks provider/gateway payloads (`error.message`, `error.cause`, `record.data`, `record.responseBody`, gateway `routing.attempts[].error` — `:35-102`) and returns the first line of whatever the provider said. Wired in at `apps/start/src/lib/backend/chat/http/route-failure.ts:34,53,55-61` and `chat-orchestrator.service.ts:1201,1218,1222-1224` (`cause: error.message`).

Consequence: when a model provider rejects a request and **echoes the offending input** (common for content-policy rejections, invalid-image/attachment errors, oversized-field errors, JSON-schema tool-arg validation failures), that fragment of **user prompt / attachment / tool-argument content is forwarded to PostHog** as the exception message. `error-formatting.ts:104-136` truncates to the first line and strips class prefixes, but does **not** redact. There is no allow-list, no PII scrubber, and no `beforeSend`/`property_denylist` anywhere in the codebase.

The same applies to `outcome.error.i18nParams`, which for `ContextWindowExceededError` carries `usedTokens`/`maxTokens` (`error-classification.ts:134-137`) — benign, but it is a free-form record type.

### 2.3 Which failures actually reach PostHog
Gated by `captureMode` (`posthog.server.ts:64-65`: success and `captureMode === 'none'` are dropped). Classification: `apps/start/src/lib/backend/chat/domain/error-classification.ts:23-204`.
- **Suppressed (`none`)**: `UnauthorizedError` (`:40`), `ThreadNotFoundError` (`:56`), `InvalidEditTargetError` (`:76`), `RateLimitExceededError` (`:87`), `QuotaExceededError` (`:110`), `ContextWindowExceededError` (`:139`), file-upload plan denials (`:245`), most `ModelPolicyDeniedError` (`:274`).
- **Sent (`signal`/`exception`)**: `ThreadForbiddenError`, `BranchVersionConflictError`, `RateLimitPersistenceError`, `ModelProviderError`, `ToolExecutionError`, `MessagePersistenceError`, `StreamProtocolError`, schema-decode failures, free-tier/BYOK model denials, and everything unclassified.

### 2.4 `eventName` values that can reach PostHog
`chat.request`, `chat.resume.request`, `chat.route.failed`, `chat.resume.route.failed` (`apps/start/src/routes/api/chat/route.tsx:37,132,142,296`); `chat.thread.title.generation.timed_out`, `chat.stream.cleanup.failed`, `chat.stream.cleanup.timed_out`, `chat.stream.persist.failed`, `chat.stream.persist.timed_out`, `chat.stream.resume.persist.{failed,timed_out,interrupted}` (`chat-orchestrator.service.ts:830,899,914,1018,1047,1313,1331,1344`); `chat.branch.version.conflict`, `chat.edit.rejected_invalid_target` (`chat-orchestrator/failure-telemetry.ts:50,93`, also `routes/api/zero/mutate/route.tsx:107`); `file.upload.vector_index.failed` (`file/services/file-upload-orchestrator.service.ts:281`), `file.upload.route.failed` (`routes/api/files/upload/route.tsx:155`), `file.markdown.route.failed` (`routes/api/files/markdown/route.tsx:206`); and eight `singularity.*` admin events (`apps/start/src/ee/singularity/frontend/singularity.server.ts:48-203`).

Note: `emitWideErrorEvent` **always** sets `captureMode: 'exception'` (`wide-event.ts:344`), so every one of those background/detached failures is unconditionally sent. The file routes send only `errorTag` + `readableMessage` and no filename (`file/http/route-failure.ts:22-32`) — good; but the `readableMessage` caveat from §2.2 applies (an S3/parse error can embed the object key, which is derived from the user's file name).

### 2.5 Client: `$exception`
- `captureClientError` → `posthog.captureException(error, properties)` (`posthog.client.ts:140-154`). Free-form `properties`.
- `captureClientChatError` (`:160-184`) adds `capture_origin: 'chat_client'`, `telemetry_disposition: 'exception'`, `chat_error_code`, `request_id`, `thread_id`, `chat_status`, plus spread `details`. Its one caller passes `details: { parsedMessage: parsed?.message }` (`apps/start/src/components/chat/chat-context.tsx:2477-2488`) — again a server-derived free-text message.
- De-duplication guard: client capture is skipped whenever the server already owns the report (`shouldCaptureClientChatError`, `:191-207`; test at `posthog.client.test.ts:4-23`).
- **`startExceptionAutocapture()` (`:58`) is the broadest surface**: *any* uncaught JS error anywhere in the app — including React render errors whose messages can contain rendered user data — is auto-sent with the currently registered super-properties from §3.

---

## 3. `identify()` / `group()` / person properties

**No `posthog.group()` calls exist anywhere.** Organization is modeled as a plain property, not a PostHog group.

`apps/start/src/lib/frontend/observability/posthog.client.ts:73-96` — `setClientIdentity`:
- `posthog.identify(input.userId)` (`:82`) — distinct ID is the **app user ID**, memoized to fire once per user (`:81-84`).
- `posthog.setPersonProperties({ organization_id, chat_is_anonymous })` (`:85-88`). Note this call **forces creation of a person profile** under PostHog's default `person_profiles: 'identified_only'`.
- `posthog.reset()` on logout / when `userId` disappears (`:92-95`) — correct behavior.

Super-properties registered globally (attached to every subsequent event including autocaptured exceptions) via `setClientChatScope` → `posthog.register(scope)` (`:117-133`): `chat_scope`, `chat_is_anonymous`, `organization_id`, `thread_id`, `chat_model_id`, `chat_mode_id`, `chat_context_window_mode`, `chat_reasoning_effort`. Stale keys are cleared with `unregister` (`:22-30`).

Called from `apps/start/src/components/chat/chat-context.tsx:2453-2462`.

**Client/server anonymity inconsistency (flag):** the client deliberately withholds the user ID for anonymous users — `userId: isAnonymous ? undefined : user?.id` (`chat-context.tsx:2454`) — but the **server unconditionally uses `event.actor.userId` as the distinct ID** (`posthog.server.ts:70`) and also ships the full `actor` object (`:84`). Anonymous sessions are therefore pseudonymously identified server-side while being deliberately un-identified client-side. Additionally, `organization_id` and `thread_id` are still registered as super-properties for anonymous users (`posthog.client.ts:120-121`, guarded only by truthiness, not by `isAnonymous`).

No email address, display name, plan name, or organization *name* is ever sent — only opaque IDs. That is a genuinely good property of this design.

---

## 4. Session replay, autocapture, pageviews, masking

All explicitly configured in `apps/start/src/lib/frontend/observability/posthog.client.ts:45-57`:

| Setting | Value | Line |
|---|---|---|
| `autocapture` (clicks/inputs) | **`false`** | `:48` |
| `capture_pageview` | **`false`** | `:49` |
| `capture_pageleave` | **`false`** | `:50` |
| `disable_session_recording` | **`true`** | `:51` |
| `disable_surveys` | **`true`** | `:52` |
| `disable_persistence` | **`false`** (persistence enabled) | `:53` |
| Exception autocapture | **enabled** | `:58` |
| `defaults` | `'2026-01-30'` | `:47` |

So: **no session replay, no DOM autocapture, no pageview or pageleave events.** This is a deliberately minimal, error-tracking-only configuration and is the strongest privacy fact about this integration.

**Masking / redaction config is entirely absent**, which matters because the defaults are permissive (`node_modules/@posthog/types/dist/posthog-config.d.ts`):
- `property_denylist` defaults to `[]` (`:847`) — no properties are stripped.
- `mask_personal_data_properties` defaults to **`false`** (`:951`) — so ad IDs / campaign params (`gclid`, `fbclid`, …) present in `$current_url` and `$referrer` are **not** masked on captured exceptions.
- No `before_send` hook is registered anywhere in the repo.
- `ip` config is a no-op deprecated flag (`:1348-1350`); **IP address is collected by PostHog server-side ingestion** and can only be suppressed via the PostHog project's "Discard IP data" setting — nothing in this repo does that.
- Every `captureException` still auto-attaches `$current_url`, `$pathname`, `$referrer`, `$browser`, `$os`, `$device_type`, `$screen_*`, and `$ip`. Since chat/thread IDs appear in URLs (`apps/start/src/routes/(app)/_layout/chat/route.tsx:47,60`), thread identifiers leak via `$current_url` too.

**Cookies:** `disable_persistence: false` with PostHog's default `persistence: 'localStorage+cookie'` (`posthog-config.d.ts:581-583`) and `cross_subdomain_cookie: true` (`:571-577`) means a **persistent cross-subdomain `ph_<key>_posthog` cookie is set on every visitor, including logged-out marketing-page visitors, with no prior consent**.

---

## 5. Opt-out mechanisms

**There are none, for end users.** Exhaustively verified:

- **No consent banner / CMP.** No cookie-consent component exists (`grep -i cookie apps/start/src/components` → zero hits).
- **No DNT support.** PostHog's `respect_dnt` option defaults to `false` (`posthog-config.d.ts:839-841`) and is **not set** in `posthog.client.ts:45-57`. No `navigator.doNotTrack` reference anywhere in the repo.
- **No Global Privacy Control** handling — zero hits for `GPC` / `globalPrivacyControl`.
- **No `opt_out_capturing_by_default`** (default `false`, `posthog-config.d.ts:794-796`) and **no `posthog.opt_out_capturing()`** call anywhere.
- **No user-facing setting.** Nothing in `apps/start/src/components/organization/settings/**` or user settings toggles telemetry.
- **No org-level flag.** `zeroDataRetentionRequired` (from `orgPolicy.complianceFlags.require_zdr`, `chat-orchestrator.service.ts:395-398`) is *recorded into* the PostHog payload (`posthog.server.ts:87` via `policy`) but is **never consulted to suppress the capture**. An org that has opted into zero data retention still has its failure telemetry — including the provider error message from §2.2 — shipped to PostHog US.

The only opt-outs that exist are **operator-level**:
1. Unset `POSTHOG_PROJECT_API_KEY` (`posthog-config.server.ts:17`).
2. Build with `VITE_APP_INSTANCE_MODE=self_hosted` (`app-feature-flags.ts:25-28,77`).

---

## 6. Server-side / runtime telemetry that leaves the deployment

### 6.1 OpenTelemetry — opt-in, off by default
`apps/start/src/lib/backend/server-effect/runtime/server-observability.layer.ts`:
- OTLP/JSON exporter for **logs, traces and metrics**, wired at `:116-129`, gated on `EFFECT_OTLP_BASE_URL` (`:85`). If unset → `Layer.empty` (`:129`), i.e. **disabled by default**.
- Auth headers from `EFFECT_OTLP_HEADERS_JSON` (`:86`, parsed at `:57-77`).
- Resource attributes: `EFFECT_SERVICE_NAME` (default `'receipt'`), `EFFECT_SERVICE_VERSION`, `deployment.environment` = `NODE_ENV` (`:79-82`, `:120-125`).
- `loggerMergeWithExisting: true` (`:127`) → **all Effect log records are exported as OTLP logs**, not just spans.
- Applied to every server runtime via `makeRuntimeRunner` (`runtime-runner.ts:20-33`).

**Privacy consequence if enabled:** `drainWideEvent` annotates the log with `wide_event: event` — the **entire wide event object** (`wide-event.ts:270-300`), which is strictly a superset of the PostHog payload, plus `error_message`, `error_cause`, `error_i18n_params`, and full breadcrumb details (`:288-291`). This exporter is **undocumented** — `EFFECT_OTLP_BASE_URL` / `EFFECT_OTLP_HEADERS_JSON` appear nowhere in `apps/start/.env.example`, `LOCAL_SETUP.md`, or `docs/`. An operator enabling it has no documented warning about payload contents.

**Bug worth flagging:** `drainWideEvent` is invoked with bare `Effect.runPromise` outside `ChatRuntime` at `routes/api/chat/route.tsx:119,283`, `route-failure.ts:65`, and `chat-orchestrator.service.ts:1113,1173`. The bare default runtime does **not** carry `ServerObservabilityLayer`, so the wide-event log line silently bypasses the configured `EFFECT_LOG_FORMAT`, `EFFECT_MIN_LOG_LEVEL` **and the OTLP exporter** — while the PostHog capture inside it (`wide-event.ts:302-304`) still fires. So OTLP gets the *background* wide events (`emitWideErrorEvent` composed into runtime programs) but not the primary request ones. Whether that's intended or a latent bug, the two sinks currently disagree about what they see.

### 6.2 LLM observability — none
There is **no Langfuse, Braintrust, Helicone, Traceloop, LangSmith or W&B integration**, and **no AI SDK `experimental_telemetry`** anywhere (verified by grep across `apps` + `packages`). **No prompts are exported to any observability vendor.** Prompts leave the deployment only to the model providers themselves (OpenAI / Anthropic / Google / OpenRouter), which the privacy policy does disclose (`apps/start/src/routes/legal/privacy/route.tsx:429,449,470,491`).

### 6.3 `packages/receipt-app` (runtime / Factory)
**Zero outbound telemetry.** No `posthog`, `otlp`, `@opentelemetry`, or analytics dependency in `packages/receipt-app/package.json`. The names are misleading:
- `packages/receipt-app/src/telemetry/artifacts.ts` builds **local, on-disk** evidence records (SHA-256 file checksums, command stdout/stderr) — and notably applies secret redaction for `sk-*` and `xox[pbar]-*` tokens (`:25-28`). Never transmitted off-box.
- `packages/receipt-app/src/services/generation-analytics.ts` is a pure token/cost normalizer feeding the DB usage tab — no network calls.
- `investigation-report-telemetry.ts`, `investigation-result-evidence-telemetry.ts` etc. are internal Factory state machines.

`apps/slack`, `apps/teams`, and `workers/` contain **no analytics instrumentation at all**.

### 6.4 Operator tooling reading production user data
`skills/receipt-production-analytics/SKILL.md` + `skills/factory-helper-runtime/catalog/infrastructure/aws_receipt_production_user_analytics/run.py` let an agent query the production Postgres for per-user activity. Explicitly scoped to exclude email, message text, credentials, connection metadata (`AGENTS.md:110-112`, `SKILL.md` "Reporting"). Verified against the SQL: it selects `account.name` as `display_name` and `emailVerified` as a boolean (`run.py:159,161`) but never the email column, and never message bodies. This is local-operator access, not outbound telemetry — but it *is* a path by which production user names reach an LLM context, which the privacy policy does not contemplate.

### 6.5 Third-party asset hosts (incidental IP leakage)
Client code loads integration icons from `https://cdn.simpleicons.org` (14 refs) and `https://api.iconify.design` (7 refs) in `integration-catalog.ts` and `nango-provider-catalog.ts`, and Sanity CDN images (35 refs). These are direct browser requests, so **visitor IP + `Referer` are disclosed to those CDNs** on any page rendering the integrations grid. None are named in the privacy policy's processor list.

---

## 7. Legal pages vs. code

Three pages exist: `apps/start/src/routes/legal/privacy/route.tsx` (681 lines), `legal/terms/route.tsx` (361), `legal/acceptable-use/route.tsx` (271). Last updated `2025-10-27` (`privacy/route.tsx:38`).

### What the policy claims
- **Analytics** (`:188-201`): "We may use analytics tools… These analytics services use cookies to collect information such as how often users visit the Site or use the Services, **what pages they visit, types of files uploaded, storage usage, message volume**, and what other sites they used before reaching the Site… place persistent cookies in your browser to identify you as a unique user."
- **Auto-collected** (`:149-164`): device/OS/browser/language, referring site, "the pages you viewed, the time spent on each page, access times."
- **Cookies** (`:169-183`): session and persistent cookies, web beacons, pixel tags.
- **Opt-out** (`:568-590`): the *only* offered mechanism is "instruct your browser… to stop accepting cookies."
- **Named processors** (`:376,393,411,429,449,470,491`): Microsoft Azure, AWS, Vercel, OpenAI, Google Gemini, Anthropic, OpenRouter.

### Disagreements with the code

1. **PostHog is not disclosed.** It is the single third-party that receives identified user data, and it is absent from the named-processor list (`:363-500`). Every other subprocessor is enumerated by name with a link to its privacy notice. *(Contrast: the self-host UI does name PostHog — `instance.server.ts:87-91`.)*

2. **US data transfer is not disclosed.** Default ingest is `https://us.i.posthog.com` (`posthog-config.ts:1`) with no EU/regional routing and no transfer-mechanism language for EU/UK users. Combined with §5 (no consent banner, no DNT), a cookie is set and an identified profile created **before** any consent under GDPR/ePrivacy.

3. **The policy over-claims relative to the code.** It says analytics collect "what pages they visit… types of files uploaded, storage usage, message volume" and "time spent on each page." The code captures **none** of these: `capture_pageview: false`, `capture_pageleave: false`, `autocapture: false`, `disable_session_recording: true` (`posthog.client.ts:48-51`), and there is no upload/storage/message-volume event anywhere. The code is far more privacy-protective than the document. This is the safe direction legally, but it means the policy is not an accurate description of the system and invites reviewers to assume worse.

4. **The policy under-claims in one specific place.** It does not disclose that **application error payloads containing provider-returned text** are transmitted to a third party (§2.2). "Analytics information" does not naturally cover "the model provider's rejection message, which may quote your prompt."

5. **`require_zdr` is contradicted in practice.** The org-level zero-data-retention compliance flag is read (`chat-orchestrator.service.ts:395-398`), transmitted to PostHog (`posthog.server.ts:87`), and **never enforced against telemetry**. Any customer contract behind that toggle is at risk of being misrepresented.

6. **Opt-out section is not actionable.** `:568-590` tells users to disable cookies. Blocking the PostHog cookie does **not** stop `captureException` from firing — PostHog falls back to `localStorage` and events still transmit with `$ip`. `respect_dnt` is not enabled, so browser-level DNT is also ineffective.

7. **Processor list vs. actual infrastructure.** The policy names Azure, AWS and Vercel. The code reads `RAILWAY_ENVIRONMENT_NAME` / `RAILWAY_GIT_COMMIT_SHA` (`posthog-config.server.ts:20,23`) and the deployment path in `AGENTS.md:95-102` is an **AWS single-host** rollout to `app.kentron.ai`. Railway is not disclosed; Azure and Vercel appear stale.

8. **Entity/product-name mismatch.** The policy is written for "The Unreal Compound SA de CV ('Company', 'Receipt')" (`:36-41`), while the shipping app identifies itself as **beetle.run** (`apps/start/src/routes/__root.tsx:60-63`) on `app.kentron.ai`. A data subject cannot map the policy onto the product they are using.

9. **Third-party CDNs undisclosed** — simpleicons/iconify/Sanity (§6.5).

### README / docs vs. code
- `LOCAL_SETUP.md:230-234` is **accurate**: PostHog is listed as optional, gated, and safe to leave blank.
- `apps/start/.env.example:229-231` is **accurate and unusually honest** ("`getPostHogSourceMapConfig()` is not wired into the build yet, so these are currently inert") — I verified it has no callers.
- `turbo.json:70-72` declares `NEXT_PUBLIC_POSTHOG_KEY` and `NEXT_PUBLIC_POSTHOG_HOST` in the global env allow-list. **These names are dead** — the code reads `POSTHOG_PROJECT_API_KEY` and `POSTHOG_HOST` server-side and passes the config through the SSR loader instead (`__root.tsx:69`). Leftovers from a Next.js ancestor; harmless but misleading, and neither real var is declared in `turbo.json`, which can cause cache-key staleness across environments.
- `AGENTS.md:105-112` accurately describes the production-analytics skill's exclusions (verified against `run.py`).
- **No doc anywhere describes the OTLP exporter** (`EFFECT_OTLP_BASE_URL`) or its payload.
- **`SECURITY.md` contains no data-collection or telemetry statement**, and no `PRIVACY.md` / telemetry section exists in `README.md` for self-hosters — even though the self-host build genuinely sends nothing, which is a claim worth making.

---

## Summary of the highest-signal issues

| # | Issue | Evidence |
|---|---|---|
| 1 | Provider error text — which can quote prompts/attachment content — is forwarded verbatim to PostHog; no redaction, no `before_send`, no `property_denylist` | `error-formatting.ts:35-102`, `route-failure.ts:53`, `posthog.server.ts:67-68` |
| 2 | Persistent cross-subdomain cookie + identified person profile with **no consent banner, no DNT, no user opt-out** | `posthog.client.ts:45-57`; `respect_dnt`/`opt_out_capturing_by_default` unset |
| 3 | PostHog absent from the privacy policy's named-processor list, and US-region transfer undisclosed | `privacy/route.tsx:363-500`; `posthog-config.ts:1` |
| 4 | `require_zdr` orgs still have telemetry (incl. error text) exported | `chat-orchestrator.service.ts:395-398` vs `posthog.server.ts:64-65` |
| 5 | Anonymous users are pseudonymously identified server-side despite the client deliberately not identifying them | `chat-context.tsx:2454` vs `posthog.server.ts:70,84` |
| 6 | Privacy policy describes analytics the code does not perform (pageviews, file types, storage, dwell time) | `privacy/route.tsx:188-201` vs `posthog.client.ts:48-51` |
| 7 | Undocumented OTLP exporter ships the full wide event (incl. error messages) to an arbitrary operator-set URL | `server-observability.layer.ts:85-129`, `wide-event.ts:270-300`; absent from `.env.example` |
| 8 | Wide-event drain runs outside the configured runtime, so OTLP/log-level config silently doesn't apply to primary request events | `routes/api/chat/route.tsx:119,283` vs `runtime-runner.ts:20-33` |

**Credit where due:** the instrumentation surface is deliberately and unusually small — no product events, no autocapture, no replay, no pageviews, no LLM-observability vendor, no prompt export, IDs-only (never emails or org names), clean `reset()` on logout, honest `.env.example`, and a hard self-host kill switch. The gap is almost entirely between that restrained implementation and (a) unredacted free-text error fields and (b) a boilerplate privacy policy that describes a different, more invasive product.