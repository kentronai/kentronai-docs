I have everything I need. Here is the full report.

---

# Receipt: Slack app & Microsoft Teams app — code-level research

All paths are absolute-relative to `<receipt-repo>`.

Both channels are **standalone HTTP services** in the monorepo (`apps/slack`, `apps/teams`), fronted by the shared Receipt service gateway at path prefixes `/slack` and `/teams` (`packages/receipt-core/src/service-graph.ts:142-170`). Neither uses Bolt socket mode. Neither package has a README (`apps/slack` and `apps/teams` are flat `.ts` files, no `src/`).

---

# PART 1 — SLACK

## 1. Install flow, step by step

### 1.0 Two entry paths
`apps/slack/slack-oauth-state.ts:9-13` splits the OAuth callback into two trust levels:

```ts
export function classifySlackOAuthCallbackState(input: { hasState: boolean; state: string; verify: ... }): SlackOAuthCallbackContext {
  if (!input.hasState) return { kind: 'distribution' }
  const payload = input.verify(input.state)
  return payload ? { kind: 'receipt', payload } : { kind: 'invalid' }
}
```

- **Receipt-initiated path** (signed state present) → org is known up front, install is written immediately.
- **Distribution path** (no state, i.e. Slack's "Add to Slack" directory button) → bot token is encrypted, parked, and a claim link is issued.

### 1.1 Receipt-initiated path (signed-in admin required)

1. **UI entry.** Sidebar item labeled `Slack` linking to `/api/slack/install`, opened in a new tab (`apps/start/src/components/layout/app-sidebar.tsx:435-447`; href constant at `apps/start/src/components/layout/sidebar/app-sidebar-primary-actions.tsx:5`: `export const SLACK_INSTALL_HREF = '/api/slack/install'`).

2. **`GET /api/slack/install`** (`apps/start/src/routes/api/slack/install/route.tsx:9-30`). **A signed-in Receipt user IS required, and must be an org admin:**
   - No session / anonymous / no active org → **401** with body `'Sign in and select a workspace before installing Slack.'` (line 13)
   - Not an org admin → **403** with body `'Only workspace admins can install Slack.'` (line 21)
   - Otherwise builds the service install URL and 302-redirects.

3. **Signed state.** `buildReceiptSlackServiceInstallUrl` (`packages/receipt-core/src/slack.ts:116-130`) targets `${origin}/slack/install?state=…`. The state is an HMAC-SHA256-signed base64url payload `{organizationId, userId, expiresAt}` with a **10-minute TTL** (`packages/receipt-core/src/slack.ts:22, 48-61`), signed with `SLACK_OAUTH_STATE_SECRET` falling back to `BETTER_AUTH_SECRET` (line 29-33).

4. **`GET /slack/install`** on the Slack service (`apps/slack/server.ts:1248-1265`):
   - No state → 302 back to `${RECEIPT_WEB_URL}/api/slack/install` (line 1251).
   - Bad state → HTML 400: **`"Slack installation state is invalid or expired. Start again from Receipt."`** + `Try again` link (line 1256).
   - Otherwise 302 to `https://slack.com/oauth/v2/authorize`.

5. **Scopes requested** (`packages/receipt-core/src/slack.ts:3-12`, joined with `,` and set as `scope`):
   `app_mentions:read`, `channels:history`, `chat:write`, `reactions:write`, `users:read`, `users:read.email`
   `redirect_uri` = `${APP_URL}/oauth/callback` (`packages/receipt-core/src/slack.ts:140`). In production `APP_URL = ${publicBaseUrl}/slack` (`sst.config.ts:857`), i.e. **`https://app.kentron.ai/slack/oauth/callback`**. Note: no user-token scopes, no `commands` scope, no `message.im`.

6. **`GET /slack/oauth/callback`** (`apps/slack/server.ts:1269-1369`):
   - `error` or missing `code` → HTML: **`"Installation cancelled: <error>"`** (line 1276)
   - Token exchange `POST ${SLACK_API_BASE_URL}/oauth.v2.access` with the same `redirect_uri` (`apps/slack/server.ts:142-151`). Failure → **`"Installation failed: <detail>"`** (line 1294)
   - Receipt-state branch: `saveInstallation(...)` writes `public.slack_installations` (`apps/slack/slack-identity.ts:315-348`) with `organizationId` and `installedByUserId` taken from the signed state (server.ts:1358-1359).
   - Success HTML (server.ts:1365-1369), exact text:
     > 🎉
     > **`@receipt added to <team name>!`**
     > `Go to any channel, type /invite @receipt, then mention @receipt to get started.`

### 1.2 Distribution path (no state) — the claim flow

`apps/slack/server.ts:1297-1351`:
1. Generate a 32-byte base64url claim + SHA-256 hash (`packages/receipt-app/src/services/slack-installation-flow.ts:61-65`).
2. **Encrypt the bot token** via BYOK AES-GCM (`encryptSlackBotToken`, same file lines 67-75; key from `BYOK_ENCRYPTION_KEY_B64`, `packages/receipt-app/src/services/byok-crypto.ts:40`).
3. Append receipt event `slack.install.requested` to stream `integrations/slack/installations/<claimHash>` (`slack-installation-flow.ts:80-81`).
4. Project into `public.slack_pending_installations` (`apps/slack/slack-identity.ts:268-313`). TTL = **10 minutes** (`SLACK_INSTALLATION_FLOW.DEFAULT_CLAIM_TTL_MS`, `slack-installation-flow.ts:13`). On projection failure it appends `slack.install.failed` with `reason: 'pending_projection_failed'` (server.ts:1338-1344).
5. 303-redirect to `${RECEIPT_WEB_URL}/auth/slack-install?claim=<claim>`.

**`/auth/slack-install`** (`apps/start/src/routes/auth/slack-install/route.tsx`): claim must match `/^[A-Za-z0-9_-]{43}$/` (line 8). Loader calls `getSlackInstallationClaim`; if `sign_in_required`, redirects to `/auth/sign-in?redirect=/auth/slack-install?claim=…` (lines 15-22). **So a signed-in Receipt user IS required here too**, and completing requires `isOrgAdmin` (`apps/start/src/lib/frontend/slack/slack-install.server.ts:35-39` → `{ status: 'forbidden' }`).

**Claim consumption** (`apps/start/src/lib/backend/slack/slack-installation-claim.service.ts:81-223`) runs `SELECT … FOR UPDATE` on the pending row and on `slack_installations` for that `team_id`; if the team already belongs to a different org → `already_connected_elsewhere` (lines 113-118). Then it decrypts the bot token, upserts `slack_installations` with a `WHERE slack_installations.organization_id = EXCLUDED.organization_id` guard (line 133), and blanks the ciphertext columns while stamping `consumed_at/consumed_by_*` (lines 146-156). Finally appends receipt `slack.install.completed` (lines 195-210).

### 1.3 UI page — exact text (`apps/start/src/components/auth/slack-install/slack-install-page.tsx`)

Heading: **`Connect Slack to Receipt`** (line 169)
Body: `Choose the Receipt organization that should own **<teamName>**.` (lines 173-177)
Select label: **`Receipt organization`** (`slack-install-copy.ts:2`)
Submit: **`Connect Slack workspace`** / while submitting **`Connecting…`** (line 231)
Footnote (`slack-install-copy.ts:7-8`):
> `A Slack workspace belongs to exactly one Receipt organization. You must be an owner or administrator of the organization you select.`

Error strings (lines 34-46, 134-137, 212-214):
- expired → `This Slack installation link has expired. Start again from Slack.`
- already_used → `This Slack installation link has already been used.`
- already_connected_elsewhere → `This Slack workspace is already connected to another Receipt organization.` (`slack-install-copy.ts:4-5`)
- forbidden → `Only an organization owner or administrator can connect Slack.`
- default → `This Slack installation link is invalid. Start again from Slack.`
- thrown → `Receipt could not finish the Slack connection. Please try again.`
- no orgs → `Your account does not belong to a Receipt organization.`

Success screen (lines 149-158):
> **`Slack connected`**
> `<teamName> is now connected. Invite @receipt to a channel, then mention it to start a run.`
> Button: `Continue to Receipt`

### 1.4 Storage — tables and columns

| Table | Key | Notable columns | Written by |
|---|---|---|---|
| `public.slack_installations` | `team_id` PK | `team_name, bot_token (PLAINTEXT), organization_id, installed_by_user_id, bot_user_id, enterprise_id, installed_at, updated_at` | `apps/slack/slack-identity.ts:87-98, 315-348`; migration `apps/start/zero/migrations/20260605_add_slack_identity_tables.sql:1-33` |
| `public.slack_user_links` | `(team_id, slack_user_id, organization_id)` | `receipt_user_id, email, status ('linked'), created_at, updated_at` | `apps/slack/slack-identity.ts:100-111, 438-475` |
| `public.slack_pending_installations` | `claim_hash` PK | `team_id, team_name, bot_token_ciphertext, bot_token_iv, bot_token_auth_tag, key_version, bot_user_id, enterprise_id, source_receipt_stream, source_receipt_id, source_receipt_hash, receipt_refs_json, created_at, expires_at, consumed_at, consumed_by_organization_id, consumed_by_user_id` | `apps/slack/slack-identity.ts:112-141, 268-313`; migration `20260713_add_pending_slack_installations.sql` |
| `public.slack_thread_contexts` | `(team_id, channel_id, thread_ts)` | `organization_id, status, source_receipt_stream, receipt_refs_json, created_at, updated_at` | `apps/slack/slack-identity.ts:142-159, 162-182` |
| Better Auth `invitation` | | `id = slack_invitation_<uuid>`, role `member`, status `pending`, 48h TTL | `apps/slack/slack-identity.ts:492-516`, TTL const line 9 |
| Billing: `org_usage_reservation`, `org_billing_account`, `org_billing_credit_ledger`, `org_usage_event`, `org_monetization_event` | | metadata `{channel:'slack'}` | `apps/slack/slack-platform-credit.ts:247-309, 579-663` |

Receipt (audit) streams:
- `integrations/slack/installations/<claimHash>` (`slack-installation-flow.ts:80`)
- `integrations/slack/threads/<teamId>/<channelId>/<threadTs>` (`slack-thread-flow.ts:332-337`)

### 1.5 Workspace → org → user mapping

One `team_id` ⇒ exactly one Receipt organization (`slack_installations.team_id` is PK; cross-org rebinding is rejected in the claim service line 113-118). Per-message user resolution is `resolveSlackUser` (`apps/slack/slack-identity.ts:557-599`):

1. Existing row in `slack_user_links` with `status='linked'` → run as that Receipt user.
2. Else resolve email from Slack `users.info`; **no email → `{status:'email_unavailable'}`**.
3. Else match `lower(user.email)` against org members via `user` ⋈ `member` (lines 425-436) → auto-create the link.
4. Else create/reuse a pending Better Auth invitation and return a `signupUrl` = `${webBaseUrl}/auth/sign-up?invitationId=<id>` (line 81-83). Seat capacity is enforced first (lines 521-555), throwing:
   > `This workspace only has N seat(s) available. Remove pending invites or upgrade seats before inviting more members.`

**No signed-in Receipt user is required to *use* the bot** — but an unlinked user's request does not run; they get a signup link instead.

---

## 2. Slack runtime behavior

### 2.1 Transport and events handled

`Bun.serve` (`apps/slack/server.ts:1224`) with routes: `/health`, `/` (landing), `/install`, `/oauth/callback`, `/events` **and** `/api/slack/events` (line 1373). `normalizeSlackRoutePath` also accepts the `/slack/...`-prefixed forms (`packages/receipt-core/src/slack.ts:106-110`).

Event handling (`apps/slack/server.ts:1373-1436`):
- `url_verification` → echoes `challenge` as `text/plain` (line 1378-1380).
- HMAC signature verification: `v0=HMAC_SHA256(SLACK_SIGNING_SECRET, "v0:<ts>:<raw>")`, timing-safe, **±300s** window (lines 176-182). Failure → 401 body `'invalid signature'`.
- In-memory `event_id` dedup with a 5-minute window (lines 186-193). **Note: process-local `Map`, so it does not dedup across replicas or restarts.**
- Unknown `team_id` → logs `[slack] no installation for team_id=…` and returns `{ok:true}` (lines 1392-1396).

Two event types are handled:
1. **`app_mention`** (line 1399). If it carries `thread_ts` it looks up the active thread context and runs in `follow_up` mode, else `activate` mode (`slackAppMentionThreadCoordinates`, `apps/slack/slack-thread-events.ts:11-21`).
2. **Untagged `message` in an already-activated thread** (`isSlackThreadFollowUpEvent`, `packages/receipt-app/src/services/slack-thread-flow.ts:23-36`): requires `thread_ts`, no `subtype`, no `bot_id`, and the text must **not** contain `<@botUserId>`. Only runs if a matching `slack_thread_contexts` row exists **and** its `organization_id` matches the installation (server.ts:1425).

**Not implemented:** slash commands, interactive buttons / `block_actions`, modals, DMs (`message.im`), app home, file uploads, message shortcuts. A grep for `slash|block_actions|interactiv` across `apps/slack` and `apps/teams` returns nothing.

### 2.2 What happens on a mention (`handleMention`, `apps/slack/server.ts:572-1213`)

1. Strip `<@Uxxxx>` mentions from the text (line 582).
2. `users.info` (form-encoded POST — see the deliberate comment at `apps/slack/slack-api.ts:105-110`), then `resolveSlackUser`.
3. **Identity error replies** (posted into the thread):
   - `email_unavailable` (line 599), prefixed `:warning: <@user> `:
     > `Receipt needs access to your Slack email before it can add you to this workspace. Ask a Receipt admin to reinstall Slack with `users:read.email`, then mention Receipt again.`
   - `signup_required` (line 609):
     > `<@user> Sign up for Receipt as <email> to join this workspace. After signup, mention me again with your question:\n<signupUrl>`
4. Append the thread receipt (`slack.thread.activated` or `slack.thread.follow_up_received`) and upsert `slack_thread_contexts` (lines 634-684).
5. Rebuild conversation context by replaying the receipt stream — bounded to last **12 events / 3000 chars**, plus the sticky `boundObjectiveId` and last selected capability ids (`slack-thread-flow.ts:204-286`).
6. Fetch Receipt Connect capabilities: mints a `connect:read` JWT and calls `${gateway}/connect/capabilities` (`apps/slack/slack-receipt-connect-status.ts:30-64`).
7. **Route.** `POST ${RECEIPT_SERVER_URL}/chat/route` with `channel: 'slack'` (`apps/slack/slack-chat-routing.ts:47-102`). Any non-OK response silently falls back to `{route:'factory'}`. Web-only `organization_skill` decisions are downgraded to factory (`normalizeExternalChatLayerDecision`, `packages/receipt-app/src/services/chat-layer-routing.ts:88-95`).

**Model:** the router and the direct responder both use `FACTORY_CHAT_MODEL` (`packages/receipt-app/src/server/bootstrap.ts:2637, 2693`), which defaults to `RECEIPT_FACTORY_CHAT_MODEL || OPENAI_MODEL || "gpt-5.4-mini"` (`packages/receipt-app/src/server/config.ts:82-84`). Both endpoints **require org OpenAI BYOK** and return 409 `openai_byok_unavailable` otherwise (bootstrap.ts:2610-2618, 2670-2677).

#### Branch A — `route: 'chat'` (direct reply)
Calls `POST /chat/respond` (`slack-chat-routing.ts:109-156`), which runs the **Beetle profile** (`profiles/receipt/PROFILE.md`, `"id": "receipt"`, `"label": "Beetle"`) system prompt (bootstrap.ts:2681-2696). On failure the user sees (server.ts:724):
> `<@user> I couldn't generate a reply just now. Nothing was run—please try again.`

On success it appends `slack.thread.direct_turn_resolved` and posts **a new message** `<@user> <text>` in the thread (lines 756-761). No streaming, no edits, no objective.

#### Branch B — `route: 'factory'` (durable run)
1. If providers were selected, append `slack.thread.providers_selected` (lines 773-798).
2. Add the **`:eyes:` reaction** to the user's message (line 800-807).
3. Post the status message that everything afterwards **edits in place** (`chat.update`) — `slackLoadingMessage` (`slack-objective-response.ts:270-272`):
   > `:hourglass_flowing_sand: <@user> *Working on it…*`
   > `_I’ll post the result in this thread._`
4. **Funding authorization** (`apps/slack/slack-platform-credit.ts:141-318`): BYOK is validated live against `https://api.openai.com/v1/models` with an 8s timeout (lines 74-110); 401/403 ⇒ no usable BYOK; other failures fail closed. Without BYOK it reserves **5,000,000 nanoUSD** of platform credit under a row lock, TTL 15 min. Receipts: `funding_requested` → `funding_authorized` / `funding_failed`. Errors shown as `:warning: <@user> <msg>`:
   - `This workspace does not have platform credit or an OpenAI provider key.` (line 209)
   - `This workspace has exhausted its platform credit.` (line 240)
   - `Receipt could not verify the workspace OpenAI key right now. Please try again.` (lines 99, 104)
   - `The Slack request already has incompatible billing state.` (line 124)
   - Non-`SlackPlatformCreditError` fallback (server.ts:932): `Receipt could not verify this workspace's model funding. Please try again.`
5. **Enqueue** (`enqueueJob`, server.ts:242-346): `POST ${RECEIPT_SERVER_URL}/agents/factory/jobs`
   - `jobId: slack_evt_<event_id>`, `lane: 'chat'`, `sessionKey: slack:<team>:<channel>:<threadTs>`, `singletonMode: 'allow'`, `maxAttempts: 1`
   - payload `kind: 'factory.run'`, `runId: slack_run_<event_id>`, `profileId: PROFILE_ID` (default `'receipt'`), `chatId` = same session key, `userId` = **Receipt user id**, `organizationId`
   - `authContext.sessionId = billingRequestId` — the comment at server.ts:294-295 states: *"Factory accepts platform funding only when this exact id resolves to the reservation created for the current Slack ingress receipt."* Confirmed at `packages/receipt-app/src/services/factory/runtime/factory-service-openai-key.ts:26` and the `slack_evt_` special case at `packages/receipt-app/src/services/factory-model-funding.ts:54-70`.
   - `authContext.workspaceId = receiptGlobalScopeId(organizationId)` — Global Integrations scope.
   - `dispatchDefaults.action` = `create` on first turn, `react` bound to `boundObjectiveId` on follow-ups (`resolveSlackFactoryDispatchTarget`, `slack-chat-routing.ts:30-44`).
   - `config: { maxIterations: 8, maxToolOutputChars: 6000, memoryScope: 'factory-chat:auto', workspace: '.' }`
   - `problem` = latest turn + bounded thread history via `buildSlackFactoryProblem` (`slack-thread-flow.ts:312-323`), prefaced with `"Recent Slack thread conversation (context only; verify any current-state claims):"`.
   - Enqueue failure → `:warning: <@user> Receipt could not start a run: <message>` (server.ts:1059) and the reservation is released with `slack_enqueue_failed`.

**Does it create Factory objectives/tasks?** Yes. The chat-lane run does not go through a free-form tool loop — `packages/receipt-app/src/agents/factory/chat/run.ts:522` emits a single deterministic **`factory.dispatch`** tool call, which creates or reacts on a Factory objective (`packages/receipt-app/src/agents/factory/chat/tools.ts:431-620`). The only ingress-level tool is `factory.dispatch`; objective execution then owns the real toolset (Codex/computer lanes, Receipt Connect capabilities).

### 2.3 Progress and terminal delivery

- Poll `GET /jobs/<jobId>` every **5s**, deadline **10 minutes** (server.ts:1067-1198).
- Progress edits are throttled by `PROGRESS_INTERVAL_MS` (default 20 000) and capped at `MAX_PROGRESS_UPDATES` (default 12), and only fire when the objective **phase changes** and maps to a friendly label (`slack-objective-response.ts:274-291`):
  - `collecting_evidence` → `Checking the connected data…`
  - `reviewing` → `Reviewing the results…`
  - `synthesizing` / `finalizing` → `Preparing the answer…`
  - `agent_running` / `executing` / `running` → deliberately **no message** ("Avoids repeating the initial acknowledgment for internal running phases", line 284)
  - Rendered as `:hourglass_flowing_sand: <@user> _<label>_`
- **Replies are edited, not streamed.** One `chat.postMessage` creates the status message; everything else uses `chat.update` on that same `ts` (`apps/slack/slack-api.ts:57-96`; note the comment at line 84: *"thread_ts is intentionally not sent to chat.update"*). Slack 429 is honoured via `Retry-After`, 3 attempts (lines 38-44).
- Terminal message (`terminalObjectiveResponse`, `slack-objective-response.ts:381-430`): `<@user> :white_check_mark:|:warning: *<Status label>*` + body + `<url|View Receipt>`. Status labels (lines 180-200): `Completed in 6s`, `Failed after 1m 05s`, `Canceled after …`, `Blocked after …`. Markdown is down-converted to Slack mrkdwn, including flattening pipe tables into bulleted records (lines 206-268), and truncating at 2 800 chars with `\n...(truncated)`. Images become Block Kit `image` blocks; other artifacts become `:paperclip:`/`:page_facing_up:` links (lines 101-134).
- Link format: `<${RECEIPT_WEB_URL}/chat?objective=<id>|View Receipt>` (lines 298-310).

**Other exact user-visible strings:**
- Polling failure: `:warning: <@user> Receipt lost contact with the runtime: <message>` (server.ts:1078)
- Adapter deadline reached but objective still live (server.ts:1134-1143 / `slack-objective-response.ts:358-366`):
  > `:warning: <@user> The objective is still working and is taking longer than expected.` + `View Receipt` link
  The comment at server.ts:1130-1133 explains this deliberately never claims completion.
- Overall 10-min timeout (server.ts:1203): `:warning: <@user> This is taking longer than expected.` + link, or `\n\nPlease try again in a moment.` if no objective id.
- Completed with no objective (line 1189): `:white_check_mark: <@user> *Done*` + body.
- Non-completed job status (line 1193): `:warning: <@user> *<status>*` + body.
- Landing page `GET /` (server.ts:1237-1244): heading `@receipt for Slack`, body `Add the Receipt AI agent to your Slack workspace.` / `Mention @receipt in any channel to start a background AI run.`, button `Add to Slack` → `${RECEIPT_WEB_URL}/api/slack/install`.

### 2.4 Receipt / audit trail

Every meaningful step is a hash-chained receipt on `integrations/slack/threads/…` with actor + `organizationId` (`packages/receipt-app/src/services/slack-thread-flow.ts:339-373`, 5 retries on concurrent append). Event types (lines 47-192): `slack.thread.activated`, `follow_up_received`, `providers_selected`, `direct_turn_resolved`, `objective_delivery_requested|succeeded|failed`, `funding_requested|authorized|settled|released|failed`, plus legacy `capability_status_answered` and `conversational_reply_received`.

**Crash recovery:** on boot, `resumePendingSlackObjectiveDeliveries` (server.ts:548-568) lists active thread contexts updated within the last **125 minutes** (`BACKGROUND_FUNDING_SETTLEMENT_MS`, line 106), replays each stream, and re-drives any `objective_delivery_requested` not matched by a `succeeded` (`pendingSlackObjectiveDeliveries`, `slack-thread-flow.ts:292-309`). The projection table only *locates* streams; receipts are authoritative (comment at `slack-identity.ts:213-217`).

### 2.5 Env vars (Slack)

| Variable | Purpose | Where |
|---|---|---|
| `SLACK_CLIENT_ID` | OAuth client id (non-null asserted) | `apps/slack/server.ts:96` |
| `SLACK_CLIENT_SECRET` | OAuth client secret | `server.ts:97` |
| `SLACK_SIGNING_SECRET` | Webhook HMAC verification | `server.ts:98` |
| `PORT` | HTTP listen port, default `3000` | `server.ts:100` |
| `SLACK_DEFAULT_PROFILE_ID` | Factory profile, default `'receipt'` | `server.ts:103` |
| `SLACK_PROGRESS_UPDATE_INTERVAL_MS` | Progress throttle, default `20000` | `server.ts:104` |
| `SLACK_MAX_PROGRESS_MESSAGES_PER_RUN` | Progress cap, default `12` | `server.ts:105` |
| `APP_URL` | Public base of the Slack service; OAuth `redirect_uri` base | `server.ts:107` |
| `RECEIPT_WEB_URL` | Receipt web base for links/claims | `server.ts:108` |
| `BETTER_AUTH_URL` | Fallback for `RECEIPT_WEB_URL` | `server.ts:108` |
| `SLACK_API_BASE_URL` | Slack API base, default `https://slack.com/api` (test seam) | `server.ts:109` |
| `ZERO_UPSTREAM_DB` | Postgres connection (non-null asserted) | `server.ts:116` |
| `SLACK_OAUTH_STATE_SECRET` / `BETTER_AUTH_SECRET` | HMAC key for install state | `packages/receipt-core/src/slack.ts:30` |
| `BYOK_ENCRYPTION_KEY_B64` | AES-GCM key for pending bot tokens | `packages/receipt-app/src/services/byok-crypto.ts:40` |
| `RECEIPT_SERVER_URL` / `RECEIPT_RUNTIME_INTERNAL_URL` / … | Runtime URL resolution chain | `packages/receipt-app/src/services/service-url.ts:208-221` |
| `RECEIPT_CONNECT_GATEWAY_URL` / `RECEIPT_CONNECT_WORKER_GATEWAY_URL` / `RECEIPT_CONNECT_PUBLIC_GATEWAY_URL` | Receipt Connect gateway | `service-url.ts:223-290` |
| `RECEIPT_CONNECT_JWT_SECRET` (→ `BETTER_AUTH_SECRET`) | Mints `connect:read` JWT | `packages/receipt-app/src/services/receipt-connect-auth-token.ts:133, 150` |
| `RECEIPT_FACTORY_CHAT_MODEL` / `OPENAI_MODEL` | Router + direct-reply model | `packages/receipt-app/src/server/config.ts:82-84` |
| `RECEIPT_SLACK_INTERNAL_URL` | Gateway → Slack service (compat proxy default `http://127.0.0.1:3010`) | `apps/start/src/routes/api/slack/events/route.tsx:4` |
| `RECEIPT_SLACK_IMAGE_REF` | Prebuilt image override | `sst.config.ts:321` |
| `SLACK_BOT_TOKEN` | **Set in deploy, never read by any code** | `sst.config.ts:864`, `deploy/sst/single-host.ts:483` |
| `START_ALL_SLACK`, `START_ALL_SLACK_PORT` | Local supervisor toggles (port default `3010`) | `scripts/start-all.mjs:90, 109` |

### 2.6 Deployment (Slack)

- **HTTP only, no Bolt, no socket mode.** `Bun.serve` (`apps/slack/server.ts:1224`), CMD `bun apps/slack/server.ts` (`deploy/Dockerfile.receipt-slack:45`), `EXPOSE 3000`.
- SST: `createReceiptService("Slack", …)` — `0.25 vCPU / 0.5 GB`, `serviceRegistry.port 3000`, `APP_URL = ${publicBaseUrl}/slack`, linked to `database` + `runtime` (`sst.config.ts:845-867`).
- Public path: gateway `routePrefix: '/slack'`, `exposure: 'public'`, `stripRoutePrefix: true`, health `/health` (`packages/receipt-core/src/service-graph.ts:142-155`). Required secrets declared there: `BETTER_AUTH_SECRET`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`.
- Single-host compose variant at `deploy/sst/single-host.ts:598-608`.
- Legacy compatibility ingress `POST /api/slack/events` in the web app proxies raw bytes to the Slack service (`apps/start/src/routes/api/slack/events/route.tsx:6-25`); on connect failure returns **503 `'Slack service unavailable'`**. `GET /api/slack/oauth/callback` 302s to `/slack/oauth/callback` preserving the query (`apps/start/src/routes/api/slack/oauth/callback/route.tsx:4-9`).
- Startup: `initDb()` runs `CREATE TABLE IF NOT EXISTS` bootstrap (server.ts:121-123, 1442) — the comment at server.ts:113-114 says *"apps/start migrations are authoritative; this standalone app keeps the legacy create-if-missing bootstrap so local Slack-only deployments still run."*

---

## 3. SLACK — docs vs code

### 3.1 Documented but not in code

| Doc claim | Code reality |
|---|---|
| `docs/slack-integration-playbook.md:169-170`: ack message is “**Receipt accepted this request and started a background run.**” | Actual ack is `:hourglass_flowing_sand: <@user> *Working on it…*\n_I’ll post the result in this thread._` (`apps/slack/slack-objective-response.ts:271`). That doc string appears nowhere in `apps/slack`. |
| `:180-184`: “**Required identifiers in terminal message** — `jobId`, `objectiveId` (if present)” | `terminalObjectiveResponse` (`slack-objective-response.ts:381-430`) emits neither. The objective id is deliberately hidden — the comment at lines 293-297 says *"Builds the canonical objective-aware chat link **without exposing internal IDs as prose**"*. Only a `<…/chat?objective=…|View Receipt>` link is rendered. |
| `:56-60`: high-level flow step 2 — “The admin adds Slack from the Receipt integrations UI. **Nango Connect can authorize the Slack workspace connection**; tag the connection with `organization_id`, `end_user_id`, and `end_user_email` so Nango auth webhooks reconcile to the Receipt org.” and `:215-220` | No Nango code path exists for the bot install. `/api/slack/install` goes straight to Slack's own `oauth/v2/authorize` (`packages/receipt-core/src/slack.ts:132-143`). The Nango `slack` entry (`packages/receipt-app/src/integrations/nango/slugs/slack/provider.json`, registered at `packages/receipt-app/src/integrations/nango/catalog.ts:175`) is a **separate Receipt Connect data connector**, not the bot installation. |
| `:174-175`: progress updates should carry “**queued/running/blocked status with short summary**” | Running phases are explicitly suppressed: `agent_running/executing/running` map to `undefined` (`slack-objective-response.ts:275-277`), and `blocked` has no progress label at all — only `collecting_evidence`, `reviewing`, `synthesizing`, `finalizing` produce text. |
| `:172-175` update cadence “every **15-30s**” | Single default of 20 000 ms (`server.ts:104`) *and* gated on phase change, so many runs get zero progress updates. |
| `:262`: unit test for “**progress summarization formatter**”; `:274-275` suggests `apps/slack/server.test.ts` | No `apps/slack/server.test.ts` exists (see the `apps/slack` file listing). |
| `:33`: “Out of scope (V1): **Slack interactive buttons**” | Consistent with code — confirming absence, no interactivity endpoint exists. |

### 3.2 Code behavior that contradicts the docs

| Doc | Code |
|---|---|
| `docs/slack-integration-playbook.md:140`: `"singletonMode": "steer"` | `SLACK_THREAD_JOB_SINGLETON_MODE = "allow"` (`packages/receipt-app/src/services/slack-thread-flow.ts:20`), used at `apps/slack/server.ts:274`. The code comment (slack-thread-flow.ts:15-19) justifies it: *"Slack thread continuity is receipt-backed, not worker-job-backed. Every human turn therefore owns a distinct ingress job even while an earlier turn remains leased or running."* |
| `:147`: `"userId": "slack:<team_id>:<slack_user_id>"` | `userId: identity.link.receiptUserId` — the real Receipt user id (`server.ts:281, 1044`). |
| `:150`: `"maxIterations": 1` | `maxIterations: 8` (`server.ts:337`). |
| `:132`: dispatch payload contains only `problem` + `config` | Actual payload additionally carries `authContext`, `connect`, `capabilityContext`, `dispatchDefaults`, `chatRoute`, `turn`, `objective`, `receiptConnectGatewayUrl` (`server.ts:270-340`). |
| `:96`: `session/thread key = slack:{team_id}:{channel_id}:{thread_ts}` | Matches (`server.ts:273, 280`). ✅ |
| `:191-206` "Required env vars" lists `RECEIPT_SERVER_URL`, omits `APP_URL`, `ZERO_UPSTREAM_DB`, `BYOK_ENCRYPTION_KEY_B64`, `SLACK_API_BASE_URL`, `RECEIPT_CONNECT_*`, `RECEIPT_CONNECT_JWT_SECRET` — all of which are load-bearing. `SLACK_BOT_TOKEN` is set by both deploy paths but read nowhere. |
| `:35`: “Out of scope (V1): **Full OAuth distribution marketplace flow** across arbitrary tenants” | The distribution flow **is implemented** — `classifySlackOAuthCallbackState` `'distribution'` branch + encrypted pending-claim table + `/auth/slack-install` page (`server.ts:1297-1351`). |
| `:88-93` identity model | Matches `resolveSlackUser` exactly. ✅ |
| `:246-252` security requirements | Signature ✅ (176-182), 5-min staleness ✅, dedup ✅ (but process-local only), Slack 429 + `Retry-After` ✅ (`slack-api.ts:38-44`), runtime retries ✅ (`fetchRuntimeWithRetry`), failure message to thread ✅. |
| `:249` “Do not log secrets … or decrypted bot tokens” | Not violated in logs, **but** `slack_installations.bot_token` is stored **in plaintext** (`apps/slack/slack-identity.ts:90`, `apps/start/zero/migrations/20260605_add_slack_identity_tables.sql:4`) — while the transient pending row *is* encrypted (`bot_token_ciphertext`). The docs never state which. |

---

# PART 2 — MICROSOFT TEAMS

## 1. Install flow, step by step

There is **no OAuth flow** — Teams uses Bot Framework service-token auth plus a signed claim link. `docs/teams-app-private-distribution.md:55-56`: *"the signed Receipt claim page performs the product-side account binding without Receipt Connect/Nango."*

1. **Package.** `bun run teams:package` (`package.json:86` → `scripts/package-teams-app.mjs`) renders `apps/teams/app-package/manifest.json.template` and zips it with two icons into `dist/receipt-teams-app.zip`. Requires `TEAMS_BOT_ID` (GUID) and optionally `TEAMS_APP_ID`, `TEAMS_APP_VERSION` (must be `x.y.z`), `RECEIPT_WEB_URL`.
   Manifest: manifestVersion `1.25`, name short `Receipt` / full `Receipt durable background agent`, bot scopes `["personal","team","groupChat"]`, `supportsFiles: true`, one command `help` (`Show how to use Receipt`), `permissions: ["identity"]`, `validDomains: [<RECEIPT_DOMAIN>]`.
2. **Admin uploads** the ZIP in Teams admin center (no Store review for custom upload).
3. **`install.add`** (`apps/teams/server.ts:35-48`): extracts `tenantId` (from `conversation.tenantId` or `channelData.tenant.id`) and `teamsUserId` (`from.aadObjectId` || `from.id`), mints a claim, and sends:
   > `Receipt is ready. Connect this Teams tenant to a Receipt workspace to finish setup.`
   > `\n\n<claim link>`
4. **Claim token** (`packages/receipt-core/src/teams.ts:35-48`): HMAC-SHA256-signed base64url payload `{tenantId, tenantName, teamsUserId, userName, expiresAt}`, **10-minute TTL** (line 13), key from `TEAMS_CLAIM_SECRET` → `BETTER_AUTH_SECRET` (line 16). Link format `${webBaseUrl}/auth/teams-install?claim=<claim>` (line 74-75).
   **This is a stateless, self-contained token — it is not single-use and there is no pending/consumed table** (contrast Slack's `slack_pending_installations.consumed_at`). It carries no provider credential (comment lines 30-34).
5. **`/auth/teams-install`** (`apps/start/src/routes/auth/teams-install/route.tsx`): claim length 32-4096; loader calls `getTeamsClaim`, and on `sign_in_required` redirects to `/auth/sign-in?redirect=…` — **a signed-in Receipt user IS required.**
6. **Preview** (`apps/start/src/lib/backend/teams/teams-installation-claim.service.ts:20-34`): if an active `teams_installations` row exists for the tenant → `mode: 'link_user'` (with that org id pinned); else `mode: 'connect_tenant'`.
7. **Authorization** (`apps/start/src/lib/frontend/teams/teams-install.server.ts:23-26`): `connect_tenant` requires `isOrgAdmin`; `link_user` requires the chosen org to equal the preview org **and** `isOrgMember`. Otherwise `{status:'forbidden'}`.
8. **Completion** (`teams-installation-claim.service.ts:41-155`): takes `pg_advisory_xact_lock(hashtext('teams-install:<tenantId>'))` (line 61 — comment: *"Serialize the initial tenant binding even when two admins redeem claims concurrently before a teams_installations row exists to lock"*), `SELECT … FOR UPDATE` on installation and user link. Returns `already_connected_elsewhere` if bound to a different org (line 66-69), `identity_already_linked` if the Teams user maps to a different Receipt user (line 75-78). Writes both tables with a `WHERE teams_installations.organization_id = EXCLUDED.organization_id` guard (line 103). Receipts: `teams.install.claim_requested` + `teams.user.link_requested` before commit, `teams.install.claimed` + `teams.user.linked` after, `teams.install.projection_failed` on rollback.
9. **`install.remove`** (`apps/teams/server.ts:50-65`) appends `teams.install.removed` and calls `deactivateTeamsInstallation`, flipping installation → `removed`, all user links → `unlinked`, all thread contexts → `removed` (`apps/teams/teams-identity.ts:131-144`).

### Storage (Teams) — `apps/start/zero/migrations/20260804_add_teams_channel_tables.sql`, bootstrap `apps/teams/teams-identity.ts:26-50`

| Table | Key | Columns |
|---|---|---|
| `public.teams_installations` | `tenant_id` PK | `tenant_name, organization_id, installed_by_user_id, status, source_receipt_stream, receipt_refs_json, installed_at, updated_at` |
| `public.teams_user_links` | `(tenant_id, teams_user_id, organization_id)` | `receipt_user_id, status, source_receipt_stream, receipt_refs_json, created_at, updated_at` |
| `public.teams_thread_contexts` | `(tenant_id, conversation_id, root_activity_id)` | `organization_id, status, source_receipt_stream, receipt_refs_json, created_at, updated_at` |
| `public.teams_processed_activities` | `(tenant_id, activity_id)` | `status, source_receipt_stream, created_at, updated_at` |

**No table stores any Microsoft credential** — the migration header states this explicitly (lines 1-3). Receipt streams: `integrations/teams/installations/<tenantId>` (`packages/receipt-app/src/services/teams-installation-flow.ts:14-15`) and `integrations/teams/threads/<tenantId>/<conversationId>/<rootActivityId>` (`teams-thread-flow.ts:15-16`).

### Tenant → org → user mapping
One Microsoft tenant ⇒ exactly one Receipt organization (PK + advisory lock + cross-org guard). Each Teams user must **individually** open their own claim link and bind to an existing member of that org — **there is no email matching and no invitation creation** (contrast Slack's `readMemberByEmail` / `createOrReuseInvitation`). `getTeamsUserLink` (`apps/teams/teams-identity.ts:87-94`) is the only lookup.

### UI page — exact text (`apps/start/src/components/auth/teams-install/teams-install-page.tsx`)

Heading: **`Connect Microsoft Teams to Receipt`** (line 47)
Body, `connect_tenant`: `Choose the Receipt workspace that should own <tenantName>.` (line 49)
Body, `link_user`: `Link <userName> to the Receipt workspace already connected to this tenant.` (line 49)
Select placeholder: `Select a Receipt workspace` (line 51)
Button: **`Connect Teams tenant`** or **`Link my Teams identity`** (line 54)
Errors:
- invalid preview (line 17): `This Teams link is invalid or expired.`
- forbidden (line 38): `You do not have permission to connect this Teams identity.`
- any other non-connected status (line 38): `This Teams tenant is already connected elsewhere or the link is invalid.`

Success screen (lines 30-32):
> **`Microsoft Teams connected`**
> `Return to Teams and send your request again.`
> Button: `Continue to Receipt`

---

## 2. Teams runtime behavior

### 2.1 Events handled (`apps/teams/server.ts`)

`app.on("install.add")`, `app.on("install.remove")`, `app.on("message")`, `app.event("error")`. That's all. No Adaptive Card actions, no `message.update`, no `invoke`, no messaging extensions, no interactive buttons, no slash commands (Teams' `commandLists` only pre-fills the compose box; `help` is matched as plain text at line 87).

The `message` handler (lines 67-202):
- Extracts `tenantId`, `conversationId`, `activityId`, `teamsUserId` (`aadObjectId` || `from.id`), `userName`, `tenantName`.
- **Thread root** via `resolveTeamsConversationRoot` (`packages/receipt-app/src/services/teams-conversation.ts:14-18`): in a **channel** (`conversationType === "channel"` or a `channelData.team.id` is present) the root is `replyToId || activityId`; in **personal/group chat** it is `conversation:<conversationId>` — i.e. **the whole DM is one flat thread**. The comment at lines 9-13 notes this is shared with the ingress simulator so a transport refactor cannot silently change Receipt session identity.
- `normalizeTeamsMessageText` strips `<at>…</at>` and `&nbsp;` (`packages/receipt-core/src/teams.ts:78-84`).
- Drops silently if `threadStore` is undefined (i.e. **unconfigured deployment**), or if any of tenant/conversation/activity/user/text is empty.

**`help`** (case-insensitive, line 87-90):
> `Mention Receipt with the work you want done. I will acknowledge it here, run it through Receipt, and post the durable result back to this conversation.`

**No installation row** (line 95):
> `Receipt needs a Teams administrator to connect this tenant to a Receipt workspace.\n\n<claim link>`

**No user link** (line 100):
> `Link your Teams identity to your Receipt account before I run this request.\n\n<claim link>`

**Dedup**: `claimTeamsActivity` (`apps/teams/teams-identity.ts:52-67`) is an INSERT … ON CONFLICT that only re-claims when the prior row is `failed` or older than **2 minutes** — a durable, DB-backed dedup (Slack's is in-memory only). Returning falsy ⇒ silent drop.

**Ack** (line 105):
> `Receipt received this request. I’ll post the result here.`

### 2.2 Background processing (lines 109-201)

The handler returns immediately after the ack — the comment at lines 107-108 says *"Bot Framework deliveries must complete promptly. Durable routing, Factory dispatch, and polling continue with the SDK's conversation-bound sender."*

1. Append `teams.thread.activated` (first turn) or `teams.thread.follow_up_received`; upsert `teams_thread_contexts`.
2. `loadTeamsCapabilities` — `connect:read` JWT + `${gateway}/connect/capabilities` (`apps/teams/teams-runtime.ts:9-17`). **Note it does not pass a `workspaceId`**, unlike Slack.
3. `resolveTeamsChatDecision` → `POST /chat/route` with `channel: 'teams'`, `priorProviders: []` (hard-coded — Teams has **no provider continuity across turns**, unlike Slack), no `boundObjectiveId`, no `recentContext`. Falls back to `{route:'factory'}` on any error (`apps/teams/teams-routing.ts:28, 41-54`).
4. If providers selected → receipt `teams.thread.providers_selected`.
5. **`route: 'chat'`** → `resolveTeamsProfileAwareResponse` → `POST /chat/respond` (same Beetle profile, same `FACTORY_CHAT_MODEL`). If undefined, it **throws** `"Profile-aware direct response unavailable."` (line 155) which surfaces to the user via the catch block. Otherwise sends a `buildTeamsMediaMessage` and records `teams.reply.sent` with `replyKind: 'direct'`, then marks the activity `completed`.
6. **`route: 'factory'`** → receipt `teams.run.enqueue_requested`, then `enqueueTeamsJob` (`apps/teams/teams-runtime.ts:19-54`):
   - `jobId: teams_activity_<activityId>`, `lane: 'chat'`, `sessionKey: teams:<tenant>:<conversation>:<rootActivity>`, `singletonMode: "allow"` (string literal, not the shared constant), `maxAttempts: 1`
   - `profileId: process.env.TEAMS_DEFAULT_PROFILE_ID ?? "receipt"` — comment lines 33-34: *"The product-facing profile id is receipt. Keep an explicit override for controlled deployments, but never fall back to a generic agent."*
   - `authContext: { userId, organizationId, receiptConnectGatewayUrl, source: 'teams', teamsTenantId, teamsUserId }` — **no `sessionId` and no `workspaceId`.**
   - `config: { maxIterations: 8, maxToolOutputChars: 6000, memoryScope: "factory-chat:auto", workspace: "." }`
   - `problem: input.problem` — **raw latest turn only, no thread history** (Slack uses `buildSlackFactoryProblem`).
   - `dispatchDefaults` carries `action`/`objectiveMode`/`requiredCapabilities`/`probeRouting` but **never an `objectiveId`** — so follow-ups always start a new objective rather than reacting on the bound one.
   - Enqueue failure → `throw new Error(\`Enqueue failed: ${status} ${body}\`)`.
7. Receipt `teams.run.enqueued`, activity marked `enqueued`.
8. **`waitForTeamsJob`** (`teams-runtime.ts:131-155`): poll `GET /jobs/<id>` every 5s, deadline 10 min. On `completed` + objective id → `waitForTeamsObjective` polls `/factory/api/objectives/<id>/live-status` and, once terminal, fetches `/factory/api/objectives/<id>` and extracts the answer (`objectiveAnswer`, lines 72-88 — same precedence chain as Slack).
9. **One final message**, not edits (line 178-183): prefix marker `✅` (completed) / `⏳` (running) / `⚠️` (other), then the Markdown, then **`\n\nJob: <jobId>`**. Rendered as `{type:'message', textFormat:'markdown', attachments?}` — images/PDF/Office docs become real Teams attachments, other artifacts stay as Markdown links (`apps/teams/teams-media.ts:32-56`).
10. Receipt `teams.reply.sent` (`replyKind: 'terminal'`), activity `completed`.

**There are no progress updates in Teams at all.** No streaming, no message editing, no reactions.

**Timeout strings:**
- Objective still running past the deadline (`teams-runtime.ts:126-128`):
  > `This objective is still working and is taking longer than expected.` + `\n\n<webUrl>/chat?objective=<id>`
- Job still running past the deadline (line 154):
  > `This run is still working. Open Receipt to follow its live progress.`
- Terminal with no answer (line 117): `Receipt objective <status>.`; non-completed job (line 149): `Receipt run <status>.`

**Error path** (lines 190-200): appends `teams.run.failed`, marks the activity `failed`, and sends:
> `⚠️ Receipt could not complete the request: <message>`

The message is the raw `Error.message` — e.g. `Enqueue failed: 500 …`, `Profile-aware direct response unavailable.`, `Objective poll failed: 503`, `Job poll failed: 404`, or the Factory funding error `Factory platform funding requires an app-chat billing request id.`

**SDK errors** (`app.event("error")`, lines 204-217) log JSON `{type:"teams.sdk.error", activityId, message, stack}` and mark the activity `failed` — the user sees nothing.

### 2.3 Teams env vars

| Variable | Purpose | Where |
|---|---|---|
| `CLIENT_ID` | Entra application id — consumed directly by `@microsoft/teams.apps` | `apps/teams/server.ts:19` |
| `CLIENT_SECRET` | Bot client secret | `server.ts:19` |
| `TENANT_ID` | Home directory tenant id | `server.ts:19` |
| `PORT` | Listen port, **default `3978`** | `server.ts:16` |
| `RECEIPT_WEB_URL` → `BETTER_AUTH_URL` → `http://localhost:3000` | Claim-link and objective-link base | `server.ts:18` |
| `ZERO_UPSTREAM_DB` | Postgres (non-null asserted — **connects even when unconfigured**) | `server.ts:21` |
| `TEAMS_DEFAULT_PROFILE_ID` | Factory profile override, default `receipt` | `apps/teams/teams-runtime.ts:35` |
| `TEAMS_CLAIM_SECRET` / `BETTER_AUTH_SECRET` | Claim HMAC key | `packages/receipt-core/src/teams.ts:16` |
| `RECEIPT_SERVER_URL` (+ fallback chain) | Runtime URL | `service-url.ts:208-221` |
| `RECEIPT_CONNECT_GATEWAY_URL` / `RECEIPT_CONNECT_WORKER_GATEWAY_URL` | Capabilities gateway | `service-url.ts:268+` |
| `RECEIPT_CONNECT_JWT_SECRET` (→ `BETTER_AUTH_SECRET`) | `connect:read` JWT | `receipt-connect-auth-token.ts:133-150` |
| `BYOK_ENCRYPTION_KEY_B64` | Set in deploy (`sst.config.ts:882`); needed by shared BYOK code paths | `byok-crypto.ts:40` |
| `TEAMS_BOT_ID`, `TEAMS_APP_ID`, `TEAMS_APP_VERSION` | Build-time only (packaging) | `scripts/package-teams-app.mjs:8-17` |
| `RECEIPT_TEAMS_IMAGE_REF` | Prebuilt image override | `sst.config.ts:323` |
| `RECEIPT_TEAMS_INTERNAL_URL` | Gateway → Teams (default `http://127.0.0.1:3011`) | `service-graph.ts:160` |
| `START_ALL_TEAMS`, `START_ALL_TEAMS_PORT` | Local supervisor (default `3011`) | `scripts/start-all.mjs:91, 110` |

### 2.4 Deployment (Teams)

- **Bot Framework over HTTP**, not socket mode. `@microsoft/teams.apps` v2.0.15 (`apps/teams/package.json:13`) with an `ExpressAdapter` over an existing Express app (`server.ts:25-31`). The comment at lines 28-30 explains: *"Pass the existing Express app, not its http.Server. Passing the server makes the SDK attach a second Express request listener that races the health app's 404 response for `/api/messages`."*
- Messaging endpoint is the SDK default **`/api/messages`** (`node_modules/@microsoft/teams.apps/dist/app.js:248`), publicly reachable as `https://app.kentron.ai/teams/api/messages` because the gateway strips the `/teams` prefix (`packages/receipt-core/src/service-graph.ts:157-169`, `stripRoutePrefix: true`).
- `GET /health` → `{ ok: true, configured: <bool> }` (`server.ts:26`).
- **Config gate:** `teamsConfigured` requires all three of `CLIENT_ID`, `CLIENT_SECRET`, `TENANT_ID` (line 19-20). When false, `threadStore`/`installationStore` stay `undefined`, `app.initialize()` is skipped, `ensureTeamsTables` is skipped, and the process logs `{type:"teams.server.unconfigured", message:"CLIENT_ID, CLIENT_SECRET, and TENANT_ID are required before the Teams messaging endpoint is enabled."}` (lines 219-227). The HTTP server still listens on `0.0.0.0:PORT`.
- SST: `createReceiptService("Teams", …)` — `0.25 vCPU / 0.5 GB`, `serviceRegistry.port 3000`, `PORT: "3000"`, `CLIENT_ID`/`CLIENT_SECRET`/`TENANT_ID` from SST secrets `TeamsClientId`/`TeamsClientSecret`/`TeamsTenantId` (`sst.config.ts:869-887`, secrets at 141-143).
- Docker: `deploy/Dockerfile.receipt-teams:38` — `CMD ["bun", "apps/teams/server.ts"]`, `EXPOSE 3000`.
- Single-host compose: `deploy/sst/single-host.ts:611-623`.
- `bun run --cwd apps/teams test` is wired into `check:fast` (`package.json:50`); `apps/slack` tests are **not**.

---

## 3. TEAMS — docs vs code

### 3.1 Direct contradiction: the env var names

`docs/ms-teams-testing-setup.md:36-40` instructs:
```text
TEAMS_CLIENT_ID=<Application client ID>
TEAMS_CLIENT_SECRET=<Client secret value>
TEAMS_TENANT_ID=<Directory tenant ID>
```
and `:57-58`: *"`configured:false` means the service is safely running, but one or more of the three Microsoft values is missing."*

But the service reads **unprefixed** names:
```ts
const teamsConfigured = [process.env.CLIENT_ID, process.env.CLIENT_SECRET, process.env.TENANT_ID]
```
(`apps/teams/server.ts:19-20`). `docs/teams-app-private-distribution.md:23-24` gets it right — *"Configure the Teams service with `CLIENT_ID`, `CLIENT_SECRET`, and the home `TENANT_ID`. These names are consumed directly by Microsoft Teams SDK."* — so **the two docs contradict each other**, and `ms-teams-testing-setup.md` is wrong for the container env.

This is real, not cosmetic: `deploy/sst/single-host.ts:484-486` writes `TEAMS_CLIENT_ID/TEAMS_CLIENT_SECRET/TEAMS_TENANT_ID` into the **shared** `receipt.env` (which every service loads), and only the `teams` compose service body separately re-exports them as `CLIENT_ID/CLIENT_SECRET/TENANT_ID` (lines 620-622). Following the testing doc alone would produce `{"ok":true,"configured":false}`.

### 3.2 Other doc/code gaps

| Doc claim | Code reality |
|---|---|
| `docs/ms-teams-testing-setup.md:3-5`: “Receipt for Teams **works like Receipt for Slack**” | Materially different: no progress updates, no message editing, no reactions, no thread history in the prompt, no provider continuity, no objective rebinding on follow-up, no email-based identity matching, no invitations, no platform-credit funding. See §2.2 and the comparison below. |
| `:106-108`: “Personal follow-up: ask a related follow-up and **confirm Receipt retains the conversation context**.” | The Teams enqueue sends `problem: input.problem` — the raw latest message only (`apps/teams/teams-runtime.ts:45`). `resolveTeamsChatDecision` is called with no `recentContext` and no `boundObjectiveId` (`apps/teams/teams-routing.ts:33-39`). Thread receipts are written but **never replayed into the prompt** — there is no Teams equivalent of `buildSlackThreadConversationContext`. Cross-turn continuity exists only via the runtime's `chatId`/`sessionKey` session stream, not via anything this adapter passes. |
| `:109-111`: “Factory work: request a background task and confirm **exactly one run is created**” | Each activity creates its own `teams_activity_<activityId>` job with `singletonMode: "allow"`, and follow-ups pass no `objectiveId`, so a second question in the same thread creates a **second objective**. |
| `docs/teams-app-private-distribution.md:73-74`: “Reply in the same thread and confirm the **receipt stream and `chatId` are reused** while the ingress job ID remains activity-specific.” | Accurate for stream/`chatId` (`resolveTeamsConversationRoot` is stable) and for the job id. ✅ |
| `docs/teams-app-private-distribution.md:67`: “Confirm `/teams/health` returns `{ "ok": true }`” | Returns `{ ok: true, configured: <bool> }` (`server.ts:26`) — a superset; `ms-teams-testing-setup.md:52-54` documents the fuller shape. |
| `ms-teams-testing-setup.md:96-99`: “Each additional Teams user opens their own link once and links their Teams identity to an **existing member** of the same Receipt workspace.” | Correct and enforced (`teams-install.server.ts:25` requires `isOrgMember`). Note this is a hard difference from Slack, which auto-invites unknown emails. |
| `ms-teams-testing-setup.md:29-30` / `teams-app-private-distribution.md:53-54`: “Receipt does not need Microsoft Graph permissions … manifest requests only the Teams `identity` permission.” | Matches `apps/teams/app-package/manifest.json.template:31`. ✅ |
| `teams-app-private-distribution.md:5-7`: “dispatches work through the **same Factory chat lane as Slack**” | True at the lane level (`lane: "chat"`, `kind: "factory.run"`), but the payloads differ (no `sessionId`, no `workspaceId`, no `connect` continuity, no objective binding). |
| **Undocumented, functional gap:** Teams `authContext` omits `sessionId` (`apps/teams/teams-runtime.ts:37-38`). | `resolveFactoryModelFunding` (`packages/receipt-app/src/services/factory-model-funding.ts:83-87`) throws `"Factory platform funding requires an app-chat billing request id."` when there's no BYOK key **and** no billing request id. So a Teams org **without OpenAI BYOK cannot run Factory work at all**, and the user sees `⚠️ Receipt could not complete the request: Factory platform funding requires an app-chat billing request id.` No doc mentions this; `ms-teams-testing-setup.md` never mentions BYOK. Slack solves the same problem with `slackFactoryBillingRequestId` + the `slack_evt_` special case (`factory-model-funding.ts:54-70`). |
| **Undocumented:** Teams `authContext` omits `workspaceId` (Slack sets `receiptGlobalScopeId(organizationId)`, `apps/slack/server.ts:292`), and `loadTeamsCapabilities` mints the connect JWT without a `workspaceId` (`apps/teams/teams-runtime.ts:11`). The comment at `packages/receipt-app/src/agents/factory/chat/tools.ts:138` says *"Web chat and Slack use Global Integrations"* — Teams is conspicuously absent. |
| **Undocumented:** Teams claim links are replayable within their 10-minute window (stateless token, no consumption record). Slack claims are single-use (`consumed_at`). |
| `ms-teams-testing-setup.md:21`: messaging endpoint `https://app.kentron.ai/teams/api/messages` | Correct given `stripRoutePrefix: true` + SDK default `/api/messages`. ✅ |

---

# Quick Slack vs Teams comparison

| | Slack (`apps/slack`) | Teams (`apps/teams`) |
|---|---|---|
| Transport | `Bun.serve` HTTP, manual HMAC verify | Express + `@microsoft/teams.apps` `ExpressAdapter`, SDK service-token auth |
| Install auth | Slack OAuth v2, 6 bot scopes | None (Bot Framework) + signed claim link |
| Claim | single-use, hashed, encrypted token parked in DB | stateless signed JWT-ish token, replayable for 10 min |
| Unlinked user | auto-invite by email + signup link | manual per-user claim link only |
| Ack | `chat.postMessage`, then `chat.update` edits | one ack message, one final message |
| Progress | phase-driven, throttled edits (max 12) | none |
| Thread history in prompt | yes, replayed from receipts (12 events / 3000 chars) | no |
| Objective rebinding on follow-up | yes (`react` + `boundObjectiveId`) | no |
| Funding | BYOK validation + platform-credit reservation/settlement | BYOK only (no `sessionId` ⇒ no platform credit) |
| Dedup | in-memory `Map`, 5 min | `teams_processed_activities` table, 2 min stale window |
| Terminal ids shown | none (link only) | `Job: <jobId>` appended |
| Tests in `check:fast` | no | yes |