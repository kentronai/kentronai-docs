# Receipt Connect, Nango integrations, the connector catalog, the MCP gateway, and tools

Research report for the public Receipt documentation site.
Repo: `<receipt-repo>` (Bun + Turborepo monorepo).
Product host: `https://app.kentron.ai`.

Every claim below is anchored to `file:line`. Where repo markdown disagrees with the
code, the code wins and the disagreement is listed in "Docs vs code".

A companion report covers the public connector catalog table; this report does **not**
re-derive that 62-row table. It covers concepts, the gateway UI, admin/self-host setup,
runtime consumption, and the CLI-vs-web connect paths.

---

## 1. Concepts a user needs first

### 1.1 What Receipt Connect is

Receipt Connect is the boundary between Receipt and external systems (AWS, GitHub, Jira,
Google Workspace, Slack, Notion, Zoho, …). It splits ownership deliberately:

- **Nango owns** external authorization (OAuth / API key / basic auth), provider
  credentials, and token refresh. (`docs/receipt-connect-nango.md:38-42`)
- **Receipt owns** user/workspace authentication, Receipt Connect JWT issuance, the
  mapping from a workspace connection name to a Nango connection, credential
  materialization for real CLIs, and runtime policy/receipts/audit.
  (`docs/receipt-connect-nango.md:44-50`)

Receipt Connect is provider-agnostic in its configuration surface: the env vars are
generic `RECEIPT_INTEGRATIONS_*`, and only `nango` is an accepted provider value today
(`packages/receipt-app/src/services/receipt-connect-config.ts:15-23,46-50`).

### 1.2 What Receipt stores and never stores

Receipt stores **only an encrypted reference** to the provider connection, never the
provider credential:

```text
organization_id + workspace_id + provider + name -> nangoIntegrationId + nangoConnectionId
```

- Table: `org_connection_secret`
  (`packages/receipt-app/src/services/receipt-connect-connections.ts:445-469`). Columns
  include `ciphertext`, `iv`, `auth_tag`, `key_version`, `metadata_json`, `status`.
- Encryption: AES-256-GCM with a 12-byte IV, key version 1
  (`packages/receipt-app/src/services/receipt-connect-connections.ts:123-125`), key from
  `RECEIPT_CONNECTION_ENCRYPTION_KEY_B64`, which must decode to exactly 32 bytes
  (`packages/receipt-app/src/services/receipt-connect-config.ts:114-128`).
- The stored payload for a Nango connection is only
  `{ provider, nangoIntegrationId, nangoConnectionId }`
  (`packages/receipt-app/src/services/receipt-connect-connections.ts:38-42`).

The browser sees even less. The Zero replication schema for `org_connection_secret`
exposes only `id, organizationId, workspaceId, provider, name, kind, status, expiresAt,
lastValidatedAt, createdAt, updatedAt` — no ciphertext, no metadata
(`apps/start/src/integrations/zero/schema.ts:90-105`;
`apps/start/src/integrations/zero/queries/receipt-connect.queries.ts:6-38`).

There are two exceptions to "Receipt never holds a credential", both explicitly
user-initiated imports, both encrypted in the same table:

- `POST /connect/credential/aws/import` stores an AWS `credential_process` bundle
  (`packages/receipt-app/src/server/receipt-connect-routes.ts:2254-2350`, kind
  `aws-credential-process`).
- `POST /connect/credential/github/import` stores a GitHub token
  (`packages/receipt-app/src/server/receipt-connect-routes.ts:2177-2253`, kind
  `github-token`).
- Plus `local-aws-profile`, which stores only a local AWS profile *name*, not keys
  (`packages/receipt-app/src/services/receipt-connect-connections.ts:44-47`).

The four connection kinds are `nango-reference`, `local-aws-profile`,
`aws-credential-process`, `github-token`
(`packages/receipt-app/src/services/receipt-connect-connections.ts:26-31`).

### 1.3 Connections and named connections

A connection is addressed by **provider + name**. `default` is the implicit name.

- Selector forms accepted by the gateway: a connection `id`, or `provider:name`
  (`packages/receipt-app/src/services/receipt-connect-connections.ts:1368-1400`).
- Name normalization: trimmed, whitespace → `-`, lowercased; empty → `default`
  (`packages/receipt-app/src/services/receipt-connect-connections.ts:533-534`).
- Capability keys use the bare provider id for the default connection and
  `provider.name` for a named one
  (`packages/receipt-app/src/services/receipt-connect-connections.ts:543-549`).
  Example capability manifest:
  `{"aws": {"provider":"aws","name":"default"}, "aws.prod": {"provider":"aws","name":"prod"}}`
  (`docs/receipt-connect-nango.md:331-336`).
- The UI label helper follows the same rule: `provider` for `default`, else
  `provider.name` (`apps/start/src/lib/frontend/receipt-connect/receipt-connect-connections.ts:85-91`).
- The credential endpoint selects a named connection with `?connection=<name>` (or
  `?name=`, or header `x-receipt-connect-connection`)
  (`packages/receipt-app/src/server/receipt-connect-routes.ts:310-318`).
- For AWS, named connections become AWS CLI profiles: `receipt` for the default,
  `receipt-<name>` otherwise
  (`packages/receipt-app/src/services/factory/lima-receipt-connect-provider-aws.ts:24-29`).

Use case worth documenting: an agency workspace can hold `google-ads:acme` and
`meta-marketing-api:acme` per client so evidence stays separated
(`docs/receipt-connect-nango.md:286-290`).

### 1.4 Capabilities

`GET /connect/capabilities` returns `{ ok, capabilities: string[], manifest, sessions: [] }`
(`packages/receipt-app/src/server/receipt-connect-routes.ts:1249-1286`). The manifest is
`kind: "receipt-connect.capability-manifest"`, schemaVersion 1, transport
`receipt-connect`, with per-capability `{ command, provider, transport, status,
connectionId, name, metadata, expiresAt, discoveredAt }`
(`packages/receipt-app/src/services/receipt-connect-command-proxy.ts:10-40`).

`status` on a capability is `valid | expired | invalid`; the manifest-level status is
`online` when any capability exists, else `offline`
(`packages/receipt-app/src/server/receipt-connect-routes.ts:1272-1276`).

A capability is *usable* only if its status has no failure word and it carries no error
signal — the matcher rejects `invalid|expired|failed|failure|error|disconnected|revoked|
unauthorized|unauthenticated|missing|blocked`
(`packages/receipt-app/src/services/receipt-connect-chat-status.ts:48-83`).

### 1.5 The four execution surfaces (kinds of tools)

Receipt classifies each catalog connector into exactly one surface. The classification is
derived purely from the checked-in manifest — never from connection metadata
(`packages/receipt-app/src/services/receipt-connect-connectors.ts:122-177`):

| Surface | Trigger in `provider.json` | Enforcement label | Tool count |
| --- | --- | --- | --- |
| `typed-proxy` | `apiProxy.kind === "proxy-tools"` | `typed` | counted from the manifest |
| `provider-mcp` | `apiProxy.kind === "mcp"` | `dynamic-review` | dynamic, 0 static |
| `resource-aware-get` | `apiProxy.kind === "atlassian-cloud-resource"` | `compatibility` | 1 read |
| `command-auth` | `credentialMode !== "nango-credentials"` | `runtime-only` | 0 |
| `compatibility-read` | everything else (plain `nango-credentials`) | `compatibility` | 1 read |

There is also an `auth-only` surface value in the type but nothing returns it today
(`packages/receipt-app/src/services/receipt-connect-connectors.ts:13-19`).

**1. Typed proxy tools.** Reviewed, checked-in tools with a fixed provider method+path, a
closed JSON Schema (`additionalProperties: false` is enforced at manifest decode), an
explicit `read`/`write` access class, and a `retries` value 0–3. `GET` endpoints must be
`read`. Path placeholders must match `pathParameters` in order and each must be a
required string input. `baseUrlOverride` must be an HTTPS origin with no path/query/hash.
All of this is validated when the catalog loads, so an invalid manifest fails the app
(`packages/receipt-app/src/integrations/nango/catalog.ts:326-455`).
At call time, arguments are validated against the manifest schema, path parameters are
URL-encoded into the path, and remaining arguments become query (GET) or a JSON body
(`packages/receipt-app/src/services/receipt-connect-call.ts:1473-1580`). Request bodies
are capped at 1 MiB (`…:1539-1542`).

Examples (name, access, method, path):
- Apollo: `list-contacts` read POST `/v1/contacts/search`; `create-contact` write POST
  `/v1/contacts`; `update-contact` write PATCH `/v1/contacts/{id}`; `delete-contact`
  write DELETE `/v1/contacts/{contact_id}`
  (`packages/receipt-app/src/integrations/nango/slugs/apollo/provider.json`).
- Google Cloud (`gcp`): `list-projects`, `get-project`, `list-storage-buckets`,
  `list-compute-instances`, `list-compute-zones` — all read GET.
- Gmail (`google-mail`): `get-profile`, `search-messages`, `get-message`, `list-labels`.
- Outlook: `get-profile`, `search-messages`, `get-message`, `list-mail-folders`.
- Airtable: `list-bases`, `get-base-schema`, `list-records`, `get-record`.

**2. Provider-native dynamic MCP tools.** For `apiProxy.kind === "mcp"`, Receipt speaks
MCP JSON-RPC to the upstream provider *through Nango Proxy*: it POSTs to
`<nango>/proxy<proxyPath>` with `Base-Url-Override: <baseUrl>`, `Retries: 0`, and
`Accept: application/json, text/event-stream`
(`packages/receipt-app/src/services/receipt-connect-call.ts:936-975`). `tools/list`
results are decoded into actions; a tool's access class comes from
`annotations.readOnlyHint` if present, otherwise from a read-name regex
(`…:891-922`). Two connectors use this: Linear (`linear-mcp`, `https://mcp.linear.app`,
default proxyPath `/mcp`) and Google Calendar (MCP)
(`https://calendarmcp.googleapis.com/mcp`, proxyPath `/v1`)
(`packages/receipt-app/src/integrations/nango/slugs/linear-mcp/provider.json`,
`…/google-calendar-mcp/provider.json`; default `/mcp` at
`packages/receipt-app/src/integrations/nango/catalog.ts:312-315`).

**3. The GET-only escape hatch (`read-provider-resource`).** Every ordinary
Nango-credential connector without a narrower manifest gets one Receipt-owned
compatibility tool. Public name: **`read-provider-resource`**
(`packages/receipt-app/src/services/receipt-connect-connectors.ts:42-43`).
Its description string, verbatim:

> "Read one provider-relative API resource through Receipt and Nango. This tool permits
> GET only; absolute URLs, request bodies, headers, and proxy routing overrides are
> rejected."
> (`packages/receipt-app/src/services/receipt-connect-call.ts:723-724`)

Its input schema accepts only `path` (required, `^/(?!/)`, ≤4096 chars) and an optional
`query` object of scalars/arrays-of-scalars (≤100 properties, string values ≤8192 chars,
≤100 array items), `additionalProperties: false`
(`packages/receipt-app/src/services/receipt-connect-call.ts:683-722`, plus runtime
re-checks at `…:745-776`).

The path parser rejects: non-GET methods, paths not starting with `/`, `//`-prefixed
paths, backslashes, `#`, `.`/`..` segments, `%2f`/`%5c` encodings (repeatedly decoded up
to 10 times), `/https:`-style absolute-URL smuggling, and any request `body`
(`packages/receipt-app/src/services/receipt-connect-call.ts:331-403`). Caller headers are
filtered: `authorization`, `connection-id`, `provider-config-key`, `cookie`, `host`,
`content-length`, `transfer-encoding`, `base-url-override`, `retries`, `retry-on`,
`decompress`, and anything starting `nango-`, `proxy-`, `x-forwarded-` are rejected
(`…:27-38,277-301`).

Response handling: bounded at 5 MiB
(`packages/receipt-app/src/services/receipt-connect-call.ts:24`), 30 s timeout
(`…:23`), and only a safe header allowlist is echoed back: `content-language`,
`content-type`, `etag`, `last-modified`, `link`, `retry-after`,
`x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset` (`…:40-50`).

**4. Command-backed (credential projection).** Connectors whose `credentialMode` is not
`nango-credentials` do not get Receipt tools at all; they get real CLI config in a Factory
worker. Today: `aws` (`aws-credential-process`), `gcp` (`gcloud-config`), `jira-oauth`
and `jira-api` (`jira-config`). A `kubeconfig-exec` mode exists in the type union but no
checked-in connector uses it
(`packages/receipt-app/src/services/receipt-connect-integration-registry.ts:9-14`; per-slug
values verified across all 62 `provider.json` files).
Note `gcp` is *both* command-auth-ish and typed-proxy: it declares
`credentialMode: "gcloud-config"` **and** `apiProxy.kind: "proxy-tools"`, and the
classifier checks `proxy-tools` first, so `gcp` reports as `typed-proxy`
(`packages/receipt-app/src/services/receipt-connect-connectors.ts:131-143`).

Current totals from the live audit script (`./bunw scripts/audit-receipt-integration-surfaces.mjs`,
run 2026-09-05): **62 catalog connectors, 89 static Receipt tools (86 read, 3 write),
0 manifest issues.**

### 1.6 What the MCP gateway is

Receipt exposes one aggregate MCP server over HTTP at **`POST /connect/mcp`**
(`packages/receipt-app/src/server/receipt-connect-routes.ts:836`, path constant
`RECEIPT_MCP_PATH = "/connect/mcp"` at
`packages/receipt-app/src/services/receipt-mcp-cli.ts:13`).

- Server identity: `{ name: "receipt-connect", version: "1.0.0" }`; capabilities
  `{ tools: { listChanged: false } }`
  (`packages/receipt-app/src/services/receipt-connect-mcp.ts:325-330`).
- Supported protocol versions: `2025-11-25`, `2025-06-18`; an unknown requested version
  falls back to the first (`…:22-25,276-281`).
- Methods: `initialize`, `notifications/initialized` (202, no body), `tools/list`,
  `tools/call`. Anything else → JSON-RPC `-32601 Method not found`
  (`…:283-396`). `tools/list` rejects a `cursor` param (`…:333-339`).
- Server `instructions` string, verbatim, is worth quoting in docs:
  "Receipt tools are reviewed operations scoped to the organization and workspace
  authenticated by the saved CLI session. Tool names from tools/list are opaque; use them
  exactly and never construct aliases. Read-only annotations are authoritative. Writes
  appear only when the token and connection policy allow them; do not bypass a missing
  tool. read-provider-resource is GET-only and accepts only a provider-relative path and
  query. Re-list tools after switching workspaces or reconnecting."
  (`packages/receipt-app/src/services/receipt-connect-mcp.ts:27-28`)

**Tool naming.** The gateway flattens every connection's tools into one namespace with
opaque aliases: `receipt_<provider>_<connectionName>_<tool>_<20-hex-digest>`, where the
digest is `sha256([connectionId, provider, name, upstreamToolName])` truncated to 20 hex
chars and the readable prefix is trimmed so the whole name stays ≤128 chars
(`packages/receipt-app/src/services/receipt-connect-mcp.ts:101-139`). Callers never see
the connection id or the upstream tool name outside the alias. `tools/call` validates
`^[A-Za-z0-9_-]+$` and ≤128 chars (`…:356-364`).

**What the gateway will and will not publish.** `reviewedStaticToolNames` gates
aggregation (`packages/receipt-app/src/services/receipt-connect-mcp.ts:154-170`):
- typed-proxy connectors publish exactly their manifest tool names;
- compatibility connectors publish only `read-provider-resource`;
- **provider-MCP connectors publish nothing through the aggregate gateway** until their
  tool names/schemas are pinned in the checked-in catalog. The comment is explicit: "a
  new upstream read tool would silently become organization-callable" (`…:166-169`).
  Those tools remain reachable through the per-connection routes
  (`/connect/tools`, `/connect/call`) but not `/connect/mcp`.
- Write tools appear in `tools/list` only when the token carries `connect:write`
  (`…:203-208`).
- One unhealthy connection is skipped with a warning rather than failing the whole list
  (`…:224-233`).
- Every published tool carries `annotations.readOnlyHint` derived from its access class
  (`…:219`).

---

## 2. Gateway routes (server API)

All routes are registered by `registerReceiptConnectRoutes`
(`packages/receipt-app/src/server/receipt-connect-routes.ts:733-…`). Auth is a Receipt
Connect JWT (HS256) passed as `Authorization: Bearer …` or `x-receipt-connect-token`
(`…:672-704`).

| Route | Method | Required scope | Extra authority | Notes |
| --- | --- | --- | --- | --- |
| `/connect/mcp` | POST | `connect:credential` | workspace membership | JSON-RPC MCP endpoint (`:836`) |
| `/connect/workspaces` | GET | `connect:read` | — | `:908` |
| `/connect/workspaces` | POST | `connect:write` | org owner/admin | `:920` |
| `/connect/workspaces/:id` | PATCH / DELETE | `connect:write` | workspace mutation authority | `:938`, `:958` |
| `/connect/workspaces/:id/token` | POST | `connect:read` | membership | mints a workspace-bound JWT (`:976`) |
| `/connect/workspaces/:id/members` | GET | `connect:read` | — | `:1000` |
| `/connect/workspaces/:id/members/:userId` | PUT / DELETE | `connect:write` | — | roles `owner|admin|member` (`:1015`, `:1032`) |
| `/connect/agent/connections` | GET | `connect:read` | membership | only `nango-reference` + `status=valid` (`:1046`) |
| `/connect/tools` | POST | `connect:credential` | membership | body `{connection}` (`:1089`) |
| `/connect/call` | POST | `connect:credential` | membership | dual-mode, see below (`:1132`) |
| `/connect/capabilities` | GET | `connect:read` | membership | schedules background read-repair (`:1249`) |
| `/connect/connectors` | GET | `connect:read` | membership | catalog joined with live Nango integrations (`:1287`) |
| `/connect/connections` | GET | `connect:read` | membership | awaits read-repair first (`:1411`) |
| `/connect/connections/:id` | DELETE | `connect:write` | mutation authority | deletes in Nango, then the projection (`:1443`) |
| `/connect/connections/:id/actions` | GET | `connect:read` | membership (`canEdit` from mutation authority) | tool allowlist (`:1491`) |
| `/connect/connections/:id/actions` | PATCH | `connect:write` | mutation authority | ≤200 names, each ≤256 chars (`:1532`) |
| `/connect/connections/:id/repositories` | GET | `connect:read` | membership | GitHub repo policy (`:1591`) |
| `/connect/connections/:id/repositories` | PATCH | `connect:write` | mutation authority | ≤1000 ids, each ≤64 chars (`:1631`) |
| `/connect/nango/health` | GET | `connect:read` | membership | `{ok,status,reachable}` (`:1693`) |
| `/connect/nango/sessions` | POST | `connect:write` | mutation authority | creates the Connect link (`:1727`) |
| `/connect/nango/webhook` | POST | *none* — HMAC only | — | `:1902` |
| `/connect/credential/:provider` | POST | `connect:credential` | membership | materializes CLI config (`:2001`) |
| `/connect/credential/github/import` | POST | `connect:write` | membership | `:2177` |
| `/connect/credential/aws/import` | POST | `connect:write` | membership | `:2254` |

### 2.1 `/connect/call` has two modes

If the body has `tool` or `arguments`, it is a **named tool call**
(`{connection, tool, arguments}`). Otherwise it is the **legacy provider-relative GET**
(`{connection, method, path, query?, headers?}`)
(`packages/receipt-app/src/server/receipt-connect-routes.ts:1140-1230`).
Both paths write a `tool.called`/`tool.observed` receipt pair; the compatibility path
names the tool `"<connection>:<METHOD> <path>"` (`…:1195-1199`).

### 2.2 Failure codes and user-facing messages

- `401 {"ok":false,"error":"unauthorized"}` — no/invalid token.
- `403 {"ok":false,"error":"workspace_membership_required"}` — membership or mutation
  authority missing (`…:806-807`).
- `409` with `code: "receipt_connect_reauthorization_required"`, `retryable: false`,
  `reconnectRequired: true` — the provider credential is terminally invalid; the matching
  Receipt row is marked invalid before responding
  (`packages/receipt-app/src/services/receipt-connect-nango-connection.ts:34-57,74-88`).
  Message: `"Your <Label> connection is no longer valid. Open Organization Settings >
  Integrations, reconnect <Label>, then retry."`
- `502 {"ok":false,"error":"integration_request_failed"}` — generic upstream failure.
- `503 {"ok":false,"error":"receipt_connect_storage_unavailable"}`.
- Missing connection: `"No active <Label> connection[ named <name>]. Open Organization
  Settings > Integrations, connect <Label>, then retry."`
  (`packages/receipt-app/src/services/receipt-connect-nango-connection.ts:118-127`)
- Inactive-but-present connection: `"<Label> connection named <name> exists as <kind> but
  is <status>[ at <expiry>]. Open Organization Settings > Integrations and reconnect
  <Label>, or replace it with an active Nango-backed <Label> connection."`
  (`packages/receipt-app/src/server/receipt-connect-routes.ts:315-327`)
- Unsupported connector on session create: `"Unsupported connector. Use one of: <ids>, or
  any integration configured in Nango."`
  (`packages/receipt-app/src/server/receipt-connect-routes.ts:1782-1786`)
- Nango 400 on session create appends: `"Nango expects an integration unique_key '<id>'
  for <Label>. Set <RECEIPT_NANGO_*_INTEGRATION_ID> if your Nango integration uses a
  different unique_key."` (`…:640-660`)
- Not configured: `"Self-hosted Nango is not configured. Set RECEIPT_INTEGRATIONS_URL,
  RECEIPT_INTEGRATIONS_SECRET_KEY, and RECEIPT_INTEGRATIONS_WEBHOOK_SECRET."`
  (`packages/receipt-app/src/services/receipt-connect-config.ts:43-44`)

---

## 3. Scoping: actor-visible vs workspace-bound, and the hidden Global scope

This is the single most misunderstood part of the product and the docs must get it right.

Connections are stored **per workspace**, not per organization:
`listReceiptConnectConnections` filters on `organization_id AND workspace_id`
(`packages/receipt-app/src/services/receipt-connect-connections.ts:600-638`).
When no workspace is given, it falls back to `receiptDefaultWorkspaceId(orgId)`.

Three workspace-shaped scopes exist:

1. **Default workspace** — `ws_<md5(organizationId)>`
   (`packages/receipt-app/src/services/receipt-workspaces.ts:133-137`), name `Default`,
   slug `default` (`…:439`). Created automatically for every organization.
2. **Named workspaces** — created by users; each is an isolated authorization boundary
   with its own connections, LLM keys, members, and activity.
3. **Global scope** — `ws_global_<md5(organizationId)>` with reserved slug
   `receipt-system-global-<md5>` (`…:149-162`). It is stored as a workspace row but is
   **excluded from every workspace list** (`…:962`) and is never selectable in the UI.

The comment in the code states the reason exactly and should be paraphrased into the
docs (`packages/receipt-app/src/services/receipt-workspaces.ts:139-148`):

> "Global integrations are what Receipt chat uses, and chat runs with no workspace
> selected. They previously resolved to the organization's Default workspace, which meant
> connecting an app for chat also connected it for whoever used Default with an MCP
> client, and vice versa. Those are different audiences, so the global scope is its own
> row."

Consequences:

- **Organization Settings → Integrations** ("Global Integrations") writes into the Global
  scope. The browser never sees or picks that id; a server function resolves it
  (`apps/start/src/lib/frontend/receipt-connect/receipt-connect.server.ts:720-725`;
  UI at `apps/start/src/components/organization/settings/integrations/integrations-page.tsx:594-620`).
- **MCP Gateway → workspace → Open integrations** writes into that workspace.
- **Web chat** reads capabilities from the Global scope only
  (`apps/start/src/lib/backend/chat/services/receipt-chat.service.ts:1214-1247`).
- **Receipt CLI / MCP clients** use the workspace bound into their saved session token.
- Legacy Nango connections that carry only an `organization_id` tag (no `workspace_id`)
  are read-repaired into the **Global** scope, not Default
  (`packages/receipt-app/src/services/receipt-connect-nango-sync.ts:298-307`).

**Authority levels** (`packages/receipt-app/src/services/receipt-workspaces.ts:971-1037`):
- `requireReceiptWorkspaceMembership` — the actor must be a member of that workspace in
  that organization.
- `requireReceiptOrganizationWorkspaceAdmin` — org `owner` or `admin`
  (from Better Auth's `member` table).
- `requireReceiptWorkspaceMutationAuthority` — workspace `owner`/`admin`, else fall back
  to org owner/admin.
- Effective role shown in the UI = the org role when it is owner/admin, else the
  workspace role (`…:571-580`).

The route file's comment is worth quoting: connection lifecycle and policy changes are
"workspace administration, not ordinary `connect:write` operations. Web tokens
intentionally carry broad runtime scopes, so the workspace role must be checked at this
boundary" (`packages/receipt-app/src/server/receipt-connect-routes.ts:783-787`).

---

## 4. Authorization: the Receipt Connect JWT

- Algorithm HS256; claims `iss:"receipt"`, `aud:"receipt-connect"`, `sub` (userId),
  optional `sid`, `org_id`, `ws_id`, `scp[]`, `iat`, `exp`, `jti`
  (`packages/receipt-app/src/services/receipt-connect-auth-token.ts:6-17`).
- Scopes: `connect:read`, `connect:write`, `connect:credential`
  (`…:19-22`). Default when unspecified = all three (`…:30-34`).
- Default TTL 12 h; minimum 60 s (`…:24,157`).
- Signing secret: `RECEIPT_CONNECT_JWT_SECRET`, falling back to `BETTER_AUTH_SECRET`
  (`…:131-136`).
- `ws_id` defaults to the org's Default workspace when omitted (`…:98-99,164`).

Web server functions mint a **10-minute** token with only `connect:read` + `connect:write`
(`apps/start/src/lib/frontend/receipt-connect/receipt-connect.server.ts:37-40,191-204`),
then exchange it at `/connect/workspaces/:id/token` for a workspace-bound token
(`…:206-241`).

---

## 5. Connection registry and Nango connection sync

### 5.1 Webhook (primary consistency path)

`POST /connect/nango/webhook` verifies an HMAC-SHA256 of the raw body against
`RECEIPT_INTEGRATIONS_WEBHOOK_SECRET`, read from header `x-nango-hmac-sha256`, compared
with `timingSafeEqual` over hex
(`packages/receipt-app/src/server/receipt-connect-routes.ts:123-145,1902-1925`).
Unsigned or wrongly signed requests get `401 {"ok":false,"error":"invalid Nango webhook signature"}`.

Two webhook shapes are handled:

- **auth creation/override** — `type:"auth"`, `operation:"creation"|"override"`,
  `success:true`. Org/user come from `tags.organization_id` / `tags.end_user_id`, falling
  back to `endUser.organizationId` / `endUser.endUserId`. Workspace from
  `tags.workspace_id`, else the org's Default workspace. Connection name from
  `tags.connection_name`, else `default`
  (`…:181-241`). It upserts an encrypted `nango-reference` row.
  If the actor has since lost workspace membership, Receipt **acknowledges the webhook
  (200) but refuses the projection and best-effort deletes the just-created Nango
  connection**, returning `{"ok":true,"ignored":true,"reason":"workspace_membership_revoked"}`
  (`…:1932-1958`).
- **auth refresh failure** — `type:"auth"`, `operation:"refresh"`, `success:false` →
  marks the matching stored reference `invalid` with reason
  `nango_auth_refresh_failed` (`…:243-303,1979-2000`).

Webhook configuration is applied directly into Nango's private schema by
`scripts/ensure-nango-webhook-config.mjs`: it sets `webhook_url` to
`<publicBaseUrl>/connect/nango/webhook`, clears `webhook_url_secondary`, sets
`send_auth_webhook=true`, `always_send_webhook=false`, `hmac_enabled=true`, and
`hmac_key=RECEIPT_INTEGRATIONS_WEBHOOK_SECRET` on `nango._nango_environments`, plus the
`nango._nango_external_webhooks` rows (`scripts/ensure-nango-webhook-config.mjs:13-26,120-142`).
It takes exactly one of `--apply` or `--check` and runs inside a transaction that rolls
back on any failure (`…:5-11,63-70`).

### 5.2 Read repair (secondary)

`syncReceiptConnectConnectionsFromNango` reconciles two sources
(`packages/receipt-app/src/services/receipt-connect-nango-sync.ts`):

1. Nango's HTTP connection list, paginated (default page 100, max 100 pages → up to
   10 000 rows) (`…:68-69`).
2. A direct read of Nango's private `nango._nango_connections` table, filtered on
   `tags->>'organization_id'` and `tags->>'workspace_id'` (with the null-workspace →
   Global-scope fallback) (`…:196-238`). This uses server-only
   `RECEIPT_INTEGRATIONS_DATABASE_URL` (`…:183`) and exists because Nango's HTTP list can
   omit a provider-only connection.

A stored ref not observed by list is direct-checked with
`GET /connections/{id}?provider_config_key=…`; a healthy direct result leaves the row
alone, while auth errors, `refresh_exhausted`, or 404/410 invalidate only that row
(`docs/receipt-connect-nango.md:176-184`; invalidation reasons
`nango_connection_errors` / `nango_refresh_exhausted` at
`packages/receipt-app/src/services/receipt-connect-nango-sync.ts:251-265`).

Read repair runs:
- **awaited** on `GET /connect/connections` (`receipt-connect-routes.ts:1419-1422`);
- **deferred via `queueMicrotask`** on `GET /connect/capabilities` and
  `GET /connect/connectors`, because capabilities sit on the chat preflight path and must
  not hold the request open (`…:700-732`);
- failures are logged and swallowed so a briefly unreachable Nango never deletes stored
  connections (`…:686-699`).

---

## 6. Connection action policy and write authority

### 6.1 Access classification

Every discovered action is classified `read` or `write` before anything runs
(`packages/receipt-app/src/services/receipt-connect-call.ts:785-800`):

- If any declared endpoint method is `POST|PUT|PATCH|DELETE` → **write**.
- Else if endpoint metadata exists → **read**.
- Else (no endpoint metadata) → **fail closed**: only a conventional read name counts as
  a read. The regex is
  `^(?:get|list|search|find|read|fetch|lookup|whoami|who-am-i|check|describe)(?:[-_]|$)`
  (`…:646`). Anything else is a write.

For MCP tools, `annotations.readOnlyHint === true|false` is authoritative; when absent the
same name regex applies (`…:900-908`).

### 6.2 Two independent gates for a write

A write tool executes only when **both** hold:

1. The caller's JWT carries `connect:write` — the routes pass
   `allowWrite: authorization.scopes.includes("connect:write")`
   (`packages/receipt-app/src/server/receipt-connect-routes.ts:865,1154`), and
   `callReceiptConnectTool` throws `ReceiptConnectWriteScopeRequiredError` (HTTP 400,
   `"integration action '<tool>' requires connect:write"`) otherwise
   (`packages/receipt-app/src/services/receipt-connect-call.ts:195-200,1906-1908`).
2. The action is enabled in the connection's stored allowlist (§6.3).

Missing/disabled tools return `404 "integration action not found or disabled"` — the same
message for "no such tool" and "not enabled", so a caller cannot probe for hidden tools
(`…:1903-1905`).

### 6.3 The allowlist lives in Nango connection metadata

Receipt stores the policy under the metadata key **`receipt_action_policy`** on the Nango
connection, written with `PATCH <nango>/connections/metadata`
(`packages/receipt-app/src/services/receipt-connect-call.ts:648,1735-1760`).
Shape: `{ schemaVersion: 1 | 2, enabledActions: string[] }`.

Semantics (`…:1584-1590`):
- **schemaVersion 1** (legacy / never edited): reads are enabled by default; writes only
  if explicitly listed.
- **schemaVersion 2** (after any admin save): *only* the listed actions are enabled —
  including reads. An empty version-2 list means "expose nothing".

Saving always writes version 2 (`…:1743-1747`). Unknown action names are rejected with
`400 "integration action '<name>' is not available"` (`…:1728-1734`).

The design note in the doc — one permission store, following Nango's per-customer
configuration guidance rather than a second independent store — is accurate
(`docs/receipt-connect-nango.md:232-238`), but the doc's claim that the Integrations page
"intentionally does not show the Actions editor" is **stale**: the Manage tools dialog is
shipped (§7.5).

### 6.4 GitHub repository policy

GitHub connections carry a second policy, `receipt_github_repository_policy`
(`packages/receipt-app/src/services/receipt-connect-call.ts:649`), shape
`{ schemaVersion: 1, mode: "all" | "selected", repositories: [{id, fullName}] }`
(`…:653-661`). Enforcement is real, not cosmetic
(`…:2013-2076`):

- `/user` → allowed (identity).
- `/user/repos`, `/repositories`, `/orgs/{org}/repos` → allowed but the **response array
  is filtered** to the selected ids/full names.
- `/repos/{owner}/{repo}/…` → allowed only if selected; otherwise
  `403 "GitHub repository '<owner/repo>' is not selected for this connection"`.
- Any other GitHub path under `selected` mode →
  `403 "this GitHub endpoint is unavailable while selected repositories are enforced"`.

Repository discovery pages GitHub at 100 per page, max 10 pages (so ≤1000 repos, with a
`truncated` flag) (`…:650-651`).

### 6.5 Atlassian resource-aware GET

For `apiProxy.kind === "atlassian-cloud-resource"`, Receipt resolves the site by calling
`/oauth/token/accessible-resources` and rewrites the requested path to
`/ex/{jira|confluence}/{cloudId}{path}`. If the connection can reach more than one
Atlassian site, the call fails with `"<Label> connection exposes multiple Atlassian
sites; call the explicit /ex/<product>/{cloudId}/... path"`
(`packages/receipt-app/src/services/receipt-connect-call.ts:592-644`). `product` is
required in the manifest — a Confluence connector that inherited Jira's prefix 404'd on
every call (`packages/receipt-app/src/integrations/nango/catalog.ts:78-86`).

### 6.6 Receipts for every gateway call

Every `/connect/call` (both modes) writes a `tool.called` receipt and, on success, a
`tool.observed` receipt, into a per-workspace stream
`receipt-connect/gateway/<orgId>/<workspaceId>`
(`packages/receipt-app/src/services/receipt-connect-tool-receipts.ts:19-24`).
`agentId` is `"mcp-gateway"`; each call gets its own `runId`
(`gateway_<base36 time>_<random>`) (`…:85-98`). Output is truncated to 2000 chars with a
`truncated` flag (`…:55,110-119`). A failed call gets only `tool.called` (with `error`),
which is how the dashboard scores outcomes (`…:105-109`). Receipt-writing failures are
logged and swallowed — never allowed to fail a working tool call (`…:127-129`).
Disconnecting is deliberately **not** recorded as a tool call any more
(`packages/receipt-app/src/server/receipt-connect-routes.ts:1477-1483`).

---

## 7. The MCP gateway UI in `apps/start`

Route tree: `apps/start/src/routes/(app)/_layout/organization/settings/mcp-gateway/**`.
Nav constants: `apps/start/src/routes/(app)/_layout/organization/settings/-organization-settings-nav.ts:48-101`.

### 7.1 Route map (including the redirects)

| Path | Behavior |
| --- | --- |
| `/organization/settings/mcp-gateway/` | Landing page — `McpGatewayLandingPage` (`mcp-gateway/index.tsx:1-6`) |
| `/…/mcp-gateway/dashboard` | **Redirect** → `/organization/settings/workspaces`. There is deliberately no org-level dashboard: with no workspace open the page could not say what its figures describe (`mcp-gateway/dashboard.tsx:1-19`) |
| `/…/mcp-gateway/integrations/` | **Redirect** → the current/default/first workspace's Overview with `?tab=apps#workspace-tools`; falls back to the workspace list when the org has none (`integrations/index.tsx:1-32`) |
| `/…/mcp-gateway/workspace/` | **Redirect** → the gateway landing page (`workspace/index.tsx:1-13`) |
| `/…/mcp-gateway/workspace/$workspaceId/` | **Redirect** → `.../overview` (`workspace/$workspaceId/index.tsx:1-12`) |
| `/…/workspace/$workspaceId/overview` | `McpGatewayWorkspacePage`, search `tab ∈ {apps, llm-keys, settings}` (`overview/route.tsx:1-11`) |
| `/…/workspace/$workspaceId/connections` | **Redirect** → Overview `?tab=<tab ?? apps>#workspace-tools` (`connections/route.tsx:1-23`) |
| `/…/workspace/$workspaceId/settings` | **Redirect** → Overview `?tab=settings#workspace-tools` (`settings/route.tsx:1-13`) |
| `/…/workspace/$workspaceId/activity` | `McpGatewayActivityPage` (`activity/route.tsx:1-6`) |
| `/…/workspace/$workspaceId/dashboard` | `McpGatewayDashboardPage`, search `tab ∈ {dashboard, users, team-usage}`, `range ∈ {24h, 7d, 30d}` (`dashboard/route.tsx:1-21`) |

The workspace id is a **path param, not a search param**, deliberately, so a refresh, a
back button, or a shared link restores the page with no racing state write
(`workspace/$workspaceId/route.tsx:5-11`).

`$workspaceId/route.tsx` renders a sticky full-width breadcrumb strip above the outlet
(`…:16-45`).

### 7.2 Landing page — "MCP Gateway"

`apps/start/src/components/organization/settings/mcp-gateway/mcp-gateway-landing-page.tsx`.

- Page title **"MCP Gateway"**; description: *"Set up an MCP client against this
  organization, then open a workspace to manage its isolated connections, keys,
  permissions, and activity."* (`:92-97`)
- Then the shared **setup panel** (§7.3).
- Then a **"Workspaces"** section: *"Each workspace has its own connections, LLM keys,
  permissions, and activity. Open one to manage it."* with a **"New workspace"** button
  (`:100-129`).
- Empty state: *"No workspaces yet. Create one to get started."*; loading:
  *"Loading workspaces…"* (`:131-138`).
- Create dialog: title **"Create workspace"**, description *"Workspace names help people
  choose the correct authorization boundary."*, field label **"Workspace name"**
  (maxLength 80), buttons **Cancel** / **Create workspace** ("Creating…" while pending),
  validation error *"Enter a workspace name."*, success toast
  `"<name> workspace created."` (`:59-89,153-219`). Creating a workspace navigates
  straight into it.
- Table columns: `#`, **Workspace**, **Sharing and tools**, **Created**, **Updated**, and
  **Actions** only when a management callback is supplied — the gateway landing page
  passes none, so it is a read-only index
  (`mcp-gateway-workspace-table.tsx:83-107`). Timestamps render as
  `dd Mon yyyy, hh:mm` (`…:36-47`). Sorting is default-first, then alphabetical
  (`mcp-gateway-landing-page.tsx:49-57`). The whole row is one link into the workspace
  Overview (`mcp-gateway-workspace-table.tsx:130-140`).

### 7.3 Setup panel (shared by the landing page and workspace Overview)

`mcp-gateway-setup-panel.tsx`.

- Heading **"Use connections with Receipt CLI and MCP clients"**, body: *"Receipt CLI and
  the local MCP bridge use a workspace-bound token. The selected workspace is
  **&lt;name&gt;**; its connections and permissions are isolated from other workspaces in
  this organization."* (`:79-95`)
- A badge reading **"Default workspace"** or **"Workspace scoped"** (`:97-102`).
- Five numbered commands with a per-row **Copy** button (`:18-41`):
  1. Install the Codex MCP bridge — `receipt mcp install codex`
  2. Preview Codex MCP configuration — `receipt mcp config codex`
  3. Check the installed bridge — `receipt mcp status codex` *(optional)*
  4. Confirm the active organization workspace — `receipt workspace current`
  5. List available tools — `receipt tools list` *(optional)*
- Copy failure toast: *"Could not copy the command. Select and copy it instead."* (`:63`).

### 7.4 Workspace Overview

`mcp-gateway-workspace-page.tsx`.

- Title **"Overview"**, description ``Connections, LLM keys, and access for <workspace>.``
  (`:131-137`).
- Three metric tiles, each a link to its tab (`:110-129`):
  **Open integrations** = count of *distinct providers* with at least one `valid`
  connection (`:98-102`); **LLM keys** = count of configured BYOK providers;
  **Your access** = the viewer's effective workspace role.
- Three URL-backed tabs (`role="tablist"` labelled "Workspace tools", anchor
  `#workspace-tools`) (`:32-36,178-183`):
  - **Open integrations** (`tab=apps`) → `<IntegrationsPage scope="workspace" embedded />`
  - **LLM keys** (`tab=llm-keys`) → the BYOK form
  - **Settings** (`tab=settings`) → `McpGatewaySettingsPage` (workspace access/members)

### 7.5 The integrations surface (shared by both scopes)

`apps/start/src/components/organization/settings/integrations/integrations-page.tsx`.
The same component serves two scopes (`:576-593`):

- `scope="organization"` → **"Global Integrations"**, description *"Connected once for the
  whole organization and available to Receipt chat. Workspace-scoped connections for CLI
  and MCP clients live under MCP Gateway."*
  (`apps/start/src/routes/(app)/_layout/organization/settings/integrations/route.tsx:11-18`).
- `scope="workspace"` (embedded in the gateway Overview) → default title
  **"Integrations"**, description *"Connect tools to give Receipt secure context across
  cloud, workspace, and business systems."* (`integrations-page.tsx:1366-1370`).

Controls (`:1155-1263`):
- A search box, placeholder **"Search integrations"**.
- Vendor/domain chips, rendered only when they match something in the current catalog:
  **All**, **Development**, **Google**, **Microsoft**, **Project Management**,
  **Cloud & Data**, **Communication**
  (`integration-category-groups.ts:25-57,76-87`).
- Segmented tabs: **All**, **Connected**, **Available**, **Popular**.
- An Authentication-method select and a "Show connected only" switch exist in the tree but
  are inside a `className="hidden"` wrapper — currently not shown
  (`integrations-page.tsx:1237-1263`).
- Paging: 60 cards per batch, then a **Load more** button with "<n> remaining"
  (`:67,1287-1305`).
- Empty state: **"No integrations found"** / *"Try a different search or turn off the
  connected-only filter."* (`:1307-1320`).

Card states (`:322-505`):
- Connected + healthy → green-tinted card; **Manage tools** button (only when a workspace
  id is known) and **Disconnect** per Nango-backed connection.
- Connected but unhealthy → amber card, detail line *"1 saved connection needs attention"*
  or *"<n> saved connections need attention"*.
- More than one healthy connection → *"<n> connections"*. A single healthy connection
  shows no detail line at all (deliberate: the button already says it).
- Connectable but not connected → **Connect** button with an external-link icon; while
  opening, the label is **"Opening"**.
- In the catalog but not connectable → detail line **"Coming soon"**, no button.
- A connection whose provider is not in the catalog still renders as a fallback card built
  from the connection itself (`:104-118`).

Connect dialog (`:1064-1097`): title `Connect <name>`; description comes from
`integrationConnectScopeDescription` (`integration-connect-scope-copy.ts:1-12`):
- organization scope: *"Enter your credentials below to connect &lt;name&gt; to this
  organization's Global Integrations. Other organizations you belong to are not affected."*
- workspace scope: *"Enter your credentials below to connect &lt;name&gt; only to the
  &lt;workspace&gt; workspace."*
The Nango Connect UI is rendered **inside an iframe in a shadcn dialog** (65vh), and
Receipt performs Nango's `connect`/`close` postMessage handshake itself, validating both
`event.origin` and `event.source` (`:763-830`). On success it toasts
`"<name> connected."` and polls connection state every 5 s for 2 minutes
(`:64-66,795-810`).

Disconnect dialog (`:1098-1140`): title **"Disconnect integration?"**, body
``Disconnect <provider>/<name>? Receipt will revoke the provider connection and new agent
tasks will immediately lose access to it.``, plus a warning box *"Existing receipts remain
available for audit. This action removes only the selected named connection."*
Success toast: `"<provider>/<name> disconnected."` or
`"<provider>/<name> was already disconnected."`

Warning banners:
- No workspace selected (workspace scope): *"Select an available workspace before managing
  integrations. No organization-wide connections are shown as a fallback."* (`:1057-1062`)
- Refresh failure: `"<error> Showing the last synced connection state."` (`:1141-1145`)
- Catalog failure: `"<error> Connected integrations remain visible, but new connections
  are unavailable until the catalog recovers."` (`:1146-1151`)

**Request-an-integration panel.** When the search query matches nothing, a panel appears:
title `Build <name> with Beetle Tasks`, body *"New integrations are code changes: Beetle
opens a task with a connected objective for the catalog entry, Nango mapping, tests, and
PR evidence. Connect GitHub first so the worker can create a branch and PR."* The button
is **Create task** when GitHub is connected, **Connect GitHub first** when it is not, and
a disabled **GitHub required** otherwise (`:505-580`). The link goes to
`/tasks?create=1&kind=integration&...` with a pre-filled objective
(`:170-196`). *(Naming caveat: "Beetle" is legacy internal branding — see §12.)*

**Manage tools dialog** (`integration-permissions-dialog.tsx`):
- Title **"Manage tools and permissions"**; description
  ``<Integration> · <connection label>. Every published operation is controlled by this
  <organization|workspace> allowlist.`` (`:229-235`)
- Read-only banner for non-admins: *"You can review these permissions. Only workspace
  owners and admins can change access."* (`:298-303`)
- Section **"Read operations"** with a count and *"Enable only the data this workspace is
  allowed to retrieve."*; empty → *"No read operations are published for this connection."*
  (`:326-364`)
- Section **"Write and delete operations"** with *"Fail closed by default. Enable only the
  operations this connection should perform."*; empty → *"No write or delete operations
  are published. This is not a grant of unrestricted provider access."* (`:365-410`)
- Each row is a Switch labelled **"Allowed"** / **"Never allow"** (`:344-349,384-395`).
- Footer: **Close** / **Save permissions** ("Saving" while pending), disabled unless
  dirty and editable. Success toast: *"Connection permissions saved."* (`:210,411-434`)
- Error state: **"Permissions unavailable"** with either a **Reconnect integration**
  button (when `reconnectRequired`) or a **Retry** button; when reconnection is required
  but the catalog entry cannot start a session: *"Reauthorization is required, but this
  catalog entry cannot start a new authorization session from Receipt."* (`:249-291`)
- For GitHub connections with `status === 'valid'`, a **"GitHub repositories"** section
  with *"Choose which repositories this connection can use."* and a popover selector
  (`:303-325`). The popover trigger label is `All repos` / `<n> repos` / `Repositories`
  (`github-repository-selector.tsx:154-159`); options are **All repositories**
  ("Keep the current connection behavior.") and **Selected repositories** ("Limit Receipt
  to the repositories checked below.") with a `Search repositories…` box
  (`…:198-250`).

### 7.6 Activity page (per workspace)

`mcp-gateway-activity-page.tsx`. Title **"Activity"**, description *"Connection lifecycle
events visible only in the selected workspace."* Section **"Recent activity"** with the
caveat *"Tool request receipts will appear here when gateway execution reporting is
available. Connection events below are live now."* Each row shows
`provider · name`, `Connection status: <status>`, and the updated time. Empty state:
*"No activity in this workspace yet."* (`:25-67`). The data is the Zero-replicated
connection list, sorted newest-updated first — no credential material reaches the client
(`:12-23`).

### 7.7 Dashboard ("Gateway activity") — per workspace

`mcp-gateway-dashboard-page.tsx`. Page title **"Gateway activity"**. Description depends
on scope (`:263-269`):
- in a workspace: *"Live view of this workspace's MCP tool activity, derived from
  execution receipts. Counts calls attributable to this workspace's connected
  applications."*
- org-wide: *"Live view of MCP tool activity across your organization, derived from
  execution receipts."*

Header controls: *"Last updated &lt;time&gt;"* / *"Loading activity…"*, a time-range select
(**Last 24 hours**, **Last 7 days**, **Last 30 days** —
`mcp-gateway-activity.ts:13-25`), and a **Refresh** button (`:268-310`).

Three tabs, URL-backed (`:76-80`):

**Tab 1 — "Dashboard"** (`tab=dashboard`, the default):
- Four stat tiles: **Total calls**, **Success rate**, **Avg response time**,
  **Active actors**, each with a delta vs the immediately preceding window of equal length
  (`:346-433`).
- **"Activity timeline"** panel; bucket description is *"Calls per hour"* (24h),
  *"Calls per six hours"* (7d), *"Calls per day"* (30d)
  (`:435-449`, bucket sizes at `mcp-gateway-activity.ts:135-140`). Empty:
  *"No calls in this period."*
- **"Activity log"** panel: *"Tools enabled or disabled on this workspace's connected
  applications."* rendering `AdminActivitySection` (`:466-482`).

**Tab 2 — "Users"** (`tab=users`) — this is the tab the commit calls the "Usage tab":
- Three tiles: **Requests**, **Total tokens used**, **Total spend**, each with the
  sub-label **"Across the organization"** (`:563-590`). Spend formats as `$0.xxxx` under a
  dollar, `$x.xx` otherwise (`:509-514`).
- A per-actor table: **User**, **Requests**, **Tools used** (distinct tools),
  **Failed**, **Last seen** (`:591-634`). Empty: *"No one has used this gateway yet.
  People and agents appear here once they make a request."*

**Tab 3 — "Live activity"** (`tab=team-usage`):
- Search box `Search tool, connector, or actor…`, a status filter (**All statuses**,
  **Succeeded**, **Failed**, **Running**), and an "<n> of <m> calls" counter
  (`:653-700`).
- Table: **Request** (operation or tool, with the actor and any error underneath),
  **Connector**, **Status** badge (Succeeded / Failed / Running), **Duration**,
  **Actions** (a row menu carrying **Created** timestamp and the full **Tool** name)
  (`:702-800`). Paginated (default 25/page).
- Empty: *"No gateway entries found. Agent activity will appear here as your team makes
  requests."*; filtered-empty: *"No requests match these filters."*

**Admin activity table** (`mcp-gateway-admin-activity.tsx`): search box
`Search tool or app`; columns **Tool**, **App**, **Status**, **Actions**; timestamps in
the row menu, formatted with a timezone name so they can be lined up with UTC logs
(`:63-78`). Action → Type/Status mapping (`:40-60`):

| action | Type | Status |
| --- | --- | --- |
| `tool.enabled` | Tool | Enabled |
| `tool.disabled` | Tool | Disabled |
| `connection.created` | Integration | Connected |
| `connection.removed` | Integration | Disconnected |
| `member.invited` | Member | Invited |
| `member.removed` | Member | Removed |
| `workspace.created` | Workspace | Created |
| `workspace.removed` | Workspace | Removed |

Empty: *"No tool or integration changes recorded yet. Enabling a tool or connecting an
integration will appear here."*; error: `Activity could not be loaded: <error>`;
loading: *"Loading activity…"* (`:168-181`). Client-side search over target+detail, capped
at 50 rows (`:137-145`).

### 7.8 Where the numbers come from

- **Gateway activity** (calls, success rate, latency, actors, timeline, live activity) is
  derived from `tool.called` / `tool.observed` receipts read out of the org's receipt log,
  never from a separate analytics table
  (`apps/start/src/lib/frontend/mcp-gateway/mcp-gateway-activity.server.ts:25-30,289-315`).
  Each event type is fetched with `limit: 5000`, newest first, then merged ascending by
  `globalSeq` so an observation is always processed after its call (`…:297-315`).
- A call with no error and no observation is **still running** and is excluded from the
  success-rate denominator; success rate is `undefined` (not 0) when nothing has settled
  (`mcp-gateway-activity.ts:27-51,108-118`).
- **Workspace attribution** is by the workspace recorded on the receipt when present; only
  receipts written before that field existed fall back to connector attribution (the tool
  name resolving to one of that workspace's connections)
  (`mcp-gateway-activity.server.ts:330-352`). Tool names are matched against three
  conventions: `receipt_<provider>_<name>_<op>`, `<provider>__<name>__<op>`, and
  `mcp__<server>__<tool>` (`…:79-118`).
- **Requests / Total tokens used / Total spend** come from `receipt_job_projection`
  (`count(*)`, `sum(total_tokens)`, `sum(public_cost)`) filtered by `owner_org_id` and
  `created_at >= sinceMs` (`apps/start/src/lib/frontend/usage/org-usage.server.ts:53-70`).
  That table is keyed by organization with no workspace column, "because an MCP tool call
  consumes no tokens itself, the agent that decided to call it does" (`…:6-18`). Hence the
  "Across the organization" sub-label. A missing receipt database returns zeroes, not an
  error (`…:71-77`).
- **Admin activity** rows come from a separate `org_activity_log` table in the auth
  database, written best-effort (never blocking the action it describes)
  (`apps/start/src/lib/backend/activity/org-activity-log.service.ts:7-19,56-95`). Reads
  are newest-first, limit ≤500, and a workspace-scoped read also includes org-wide rows
  (`…:97-120`). `tool.enabled` / `tool.disabled` rows are written by diffing the previous
  and next allowlists after the runtime accepts the change
  (`apps/start/src/lib/frontend/receipt-connect/receipt-connect.server.ts:480-514`).
- Sidebar sub-nav inside a workspace shows only **All workspaces** (back out) and
  **Dashboard**; at gateway level it shows only **Workspaces**
  (`apps/start/src/components/mcp-gateway/mcp-gateway-nav.config.tsx:37-94`).
- Breadcrumb: `All workspaces › <workspace> › <tab>` where tab labels are
  Overview / Integrations / Activity / Dashboard / Workspace settings
  (`workspace-breadcrumb.tsx:11-18`).

---

## 8. Enabling or requesting a new integration (admin path)

### 8.1 What "available" actually means

There is **no per-org integration enablement table**. The doc `integration-factory-receipt.md`
describes one (`docs/integration-factory-receipt.md:277-280` — "DB writes
`organization_id + integration_id + enabled=true`"), but the code has none, and
`docs/integration-factory-receipt.md:39-43` states the correction: "There is intentionally
no second org-enablement table. Until org-specific integration policy is implemented,
connectability comes from the checked-in runtime catalog and connection status comes from
this projection."

Verified in code: `GET /connect/connectors` returns the checked-in catalog joined with the
live Nango integration list plus stored connection status; there is no org filter
(`packages/receipt-app/src/server/receipt-connect-routes.ts:1287-1408`). Each row carries
`configured` (true when a Nango integration matched, or true for all rows when the Nango
list could not be fetched), `status` (from the default connection or `"disconnected"`),
and `connectionCount`. Integrations present in Nango but absent from the catalog are
appended as dynamic rows with `toolSurface: "compatibility-read"` (`…:1370-1400`).

So: a connector is connectable when (a) it is in the checked-in catalog **or** configured
in the deployment's Nango, and (b) the org admin clicks Connect. There is no separate
"enable for org" step today.

`POST /connect/nango/sessions` additionally auto-creates a **provider-only** Nango
integration (API-key/PAT style) if the catalog declares it and Nango does not have it yet
(`…:1789-1810`, helper at `…:554-604`). OAuth integrations are not synthesized.

### 8.2 Adding a brand-new connector (a code change)

The documented and enforced path (`docs/receipt-connect-nango.md:346-386`,
`docs/integration-factory-receipt.md:8-23,207-224`,
`skills/add-receipt-nango-integration/SKILL.md:88-114`):

1. Confirm Nango supports the provider and identify its exact provider slug and auth mode.
2. Add `packages/receipt-app/src/integrations/nango/slugs/<nango-slug>/provider.json`.
3. Add the slug to `packages/receipt-app/src/integrations/nango/catalog.json`.
4. Add the static import and exact-slug mapping to
   `packages/receipt-app/src/integrations/nango/catalog.ts` — **the loader does not
   discover folders dynamically** (`catalog.ts:1-64,128-198,505-514`).
5. Add a typed credential renderer in `receipt-connect-connectors.ts` only when a
   provider-native CLI needs one.
6. Add or extend remote setup so a Factory worker gets isolated CLI config.
7. Add tests; run the connector catalog + Receipt Connect suites.
8. Configure the integration in self-hosted Nango; set
   `RECEIPT_NANGO_<PROVIDER>_INTEGRATION_ID` only when the Nango unique key differs.

`provider.json` contract (decoded and validated at import time,
`packages/receipt-app/src/integrations/nango/catalog.ts:66-110,455-503`):
- Required: `schemaVersion: 1`, `receiptId`, `providerSlug` (**must equal the folder
  name**), `displayName`, `aliases` (non-empty, **must include `receiptId`**), `command`,
  `defaultIntegrationId`, `integrationEnv`, `credentialMode`, `setup`.
- Optional: `productId` (defaults to `receiptId`), `authMode` (defaults to
  `{id:"default", label:"Default", default:true}`), `apiProxy`, `docs`.
- `setup.kind` ∈ `provider-only` | `oauth2` (needs `envPrefix`, `credentialHint`, optional
  `credentialEnvPrefix`, optional `defaultScopes`) | `custom` (needs `envPrefix`,
  `credentialHint`).

`productId` + `authMode` drive UI grouping. Product-level ids resolve to the connector
whose `authMode.default` is true (`receipt-connect-integration-registry.ts:101-111`), which
is why `jira` and `confluence` are grouping ids only, not connectable ids. The UI keeps a
single card for `airtable` and `apollo` (`SINGLE_CARD_PRODUCT_IDS`) and multiple cards for
`jira` and `confluence` (`MULTI_AUTH_PRODUCT_IDS`)
(`apps/start/src/components/organization/settings/integrations/integration-catalog.ts:510-527`).

### 8.3 The Factory-worker route (how a user request becomes a connector)

Receipt ticket/objective → Factory worker edits this repo with `profileId: receipt` →
PR → merge → deploy → the UI shows the connector → users connect it
(`docs/integration-factory-receipt.md:10-12,207-224`). Normal users cannot bypass the
catalog and review flow (`…:222-224`). In the product, that request is started from the
"Build &lt;name&gt; with Beetle Tasks" panel described in §7.5.

Optional per-provider extras that a worker may add: `SKILL.md` (worker prompt context),
`actions/*.action.json` / `syncs/*.sync.json` (declarative routing metadata that grant no
credentials), and deployable Nango function code under `nango-integrations/`
(`docs/integration-factory-receipt.md:80-119,151-182,186-195`).

### 8.4 Provisioning provider configs in Nango

```bash
bun run factory:integrations:check     # = ensure-nango-integrations.mjs --from-aws --check
bun run factory:integrations:ensure    # = ensure-nango-integrations.mjs --from-aws --apply
bun run factory:integrations:audit     # = audit-receipt-integration-surfaces.mjs
bun run factory:integrations:reconcile # --from-aws --apply --refresh-oauth --allow-missing-credentials
```
(`package.json:43-46`)

The underlying script (`scripts/ensure-nango-integrations.mjs`) supports:
`--check`, `--apply`, `--provider-only`, `--from-aws`, `--refresh-oauth`,
`--allow-missing-credentials`, `--only <ids>` (`:46-55,87-93`). It needs
`RECEIPT_INTEGRATIONS_URL` (or `RECEIPT_INTEGRATIONS_PUBLIC_URL`),
`RECEIPT_INTEGRATIONS_SECRET_KEY`, and `NANGO_SERVER_URL` or
`RECEIPT_NANGO_OAUTH_CALLBACK_URL` (`:59-63`). `--check` also prints `oauthCallbackUrl`,
the URL that must be registered in each OAuth developer app
(`docs/receipt-connect-nango.md:398-403`; resolution logic at
`scripts/ensure-nango-integrations.mjs:214-230`). An unsupported `--only` value errors with
`Unsupported --only connector(s): … Use one of: <connector list>.` (`:297`).

Self-hosted Receipt does **not** need Nango's admin dashboard for this: Receipt creates
integrations through Nango's authenticated public API. For catalog providers declaring
`MCP_OAUTH2` with dynamic client registration, the pinned image registers the OAuth client
during that call and repairs older rows whose client material is missing
(`docs/receipt-connect-nango.md:405-413`; patch at
`deploy/Dockerfile.nango:108-114`).

⚠️ `--from-aws` reads a deployed AWS ECS task definition using the local `aws` CLI
(`scripts/ensure-nango-integrations.mjs:110-125`). That is an internal operations flow, not
a self-hosting instruction — see §12.

### 8.5 Env vars

**Receipt services** (canonical, generic; `packages/receipt-app/src/services/receipt-connect-config.ts:15-21`):

```text
RECEIPT_INTEGRATIONS_PROVIDER=nango          # only "nango" is accepted
RECEIPT_INTEGRATIONS_URL=<internal integration provider base URL>
RECEIPT_INTEGRATIONS_PUBLIC_URL=<public URL, e.g. https://host/integrations>
RECEIPT_INTEGRATIONS_SECRET_KEY=<Nango environment secret key>
RECEIPT_INTEGRATIONS_WEBHOOK_SECRET=<HMAC secret shared with Nango>
RECEIPT_INTEGRATIONS_DATABASE_URL=<server-only; the DB owning Nango's private `nango` schema>
RECEIPT_CONNECTION_ENCRYPTION_KEY_B64=<32-byte base64 key>
RECEIPT_CONNECT_JWT_SECRET=<or falls back to BETTER_AUTH_SECRET>
```

Only `RECEIPT_INTEGRATIONS_URL`, `_SECRET_KEY`, and `_WEBHOOK_SECRET` are required for the
provider config to resolve at all (`receipt-connect-config.ts:55-59`).
`RECEIPT_INTEGRATIONS_DATABASE_URL` is used only for organization-tagged connection
read-repair and must never reach web clients, CLI artifacts, Factory task packets, or
sandbox workers (`docs/receipt-connect-nango.md:79-84`;
`packages/receipt-app/src/services/receipt-connect-nango-sync.ts:183`).

Provider-native names (`NANGO_SECRET_KEY`, `NANGO_API_KEY`, `NANGO_INTERNAL_URL`,
`NANGO_WEBHOOK_SECRET`) and the old `RECEIPT_CONNECT_NANGO_*` names are intentionally
**not** accepted by Receipt (`docs/receipt-connect-nango.md:161-165`; verified — the config
module reads only the five `RECEIPT_INTEGRATIONS_*` keys).

**The Nango container itself** takes `NANGO_*` vars. Hosted single-host values
(`deploy/sst/single-host.ts:469-479`):

```text
NANGO_LOGS_ENABLED=false
FLAG_SERVE_CONNECT_UI=true
CONNECT_UI_PORT=3009
NANGO_CONNECT_UI_PORT=3009
NANGO_SERVER_URL=<public base URL>              # this is why the OAuth callback is <host>/oauth/callback
NANGO_PUBLIC_SERVER_URL=<public base URL>/integrations
NANGO_PUBLIC_CONNECT_URL=<public base URL>/integrations-connect
NANGO_DATABASE_URL=<postgres>
NANGO_ENCRYPTION_KEY=<secret>
NANGO_DASHBOARD_USERNAME / NANGO_DASHBOARD_PASSWORD
```

Ports: the Nango server listens on **3003** and the Connect UI on **3009**
(`deploy/Dockerfile.nango:135`; `docker-compose.local.yml:33-35`).

**Per-connector overrides.** Each connector declares an
`integrationEnv` (e.g. `RECEIPT_NANGO_GITHUB_INTEGRATION_ID`) used only when the Nango
unique key differs from the connector default
(`packages/receipt-app/src/services/receipt-connect-connectors.ts:74-80`). OAuth app
credentials follow `RECEIPT_NANGO_<PREFIX>_CLIENT_ID` / `_CLIENT_SECRET`, where `<PREFIX>`
is `setup.envPrefix` with `setup.credentialEnvPrefix` as a shared fallback (so, e.g.,
`google-calendar-mcp` reuses `GOOGLE_ANALYTICS` unless its own pair is set)
(`scripts/ensure-nango-integrations.mjs:232-245`; manifest example
`slugs/google-calendar-mcp/provider.json`). Scope overrides use
`RECEIPT_NANGO_<PREFIX>_SCOPES`. The `github-app-oauth` connector uses CUSTOM auth and
additionally needs `_APP_ID`, `_APP_LINK`, `_PRIVATE_KEY`
(`scripts/ensure-nango-integrations.mjs:30-36`; `docs/receipt-connect-nango.md:537-544`).

### 8.6 The self-hosted Nango requirement

- Receipt pins **`nangohq/nango-server:hosted-0.69.48`** (`deploy/Dockerfile.nango:1`) and
  the checked-in Nango project pins the matching CLI (`nango-integrations/package.json:14`).
- The image applies four checked-in patches, each of which **fails the build** if the
  pinned upstream shape drifts (`deploy/Dockerfile.nango:9-133`):
  1. Knex migration runners get `disableTransactions: true` so `CREATE INDEX CONCURRENTLY`
     works; the patch asserts ≥12 patched call sites across ten named files (`:9-95`).
  2. `nango-records-migration-transaction.mjs` routes the records migration's trailing
     statements through its own transaction (`:97-106`).
  3. `nango-dynamic-mcp-oauth.mjs` mirrors Nango's private-controller dynamic MCP
     registration into the public API, and repairs rows created by older images
     (`:108-114`).
  4. `nango-zendesk-api-token.mjs` keeps the retired Zendesk API-token provider definition
     decodable during the OAuth migration (`:116-120`).
  5. `nango-google-calendar-mcp.mjs` back-ports Google Calendar's MCP provider, which
     landed after 0.69.48 (`:122-126`).
  6. `nango-azure-devops-oauth.mjs` replaces upstream's BASIC-auth `azure-devops`
     definition with an OAUTH2 one aliasing the generic `microsoft` provider and
     requesting `499b84ac-1321-427f-aa17-267ca6975798/.default`, keeping the
     `organizationUrl` connection field (`:128-133`;
     `docs/receipt-connect-nango.md:560-571`).
- **Free self-hosted Nango includes Auth and Proxy but not Functions or Nango's MCP
  server**, so ordinary REST coverage must never depend on Nango Actions — this is exactly
  why Receipt owns the `read-provider-resource` baseline and the typed proxy manifests
  (`docs/receipt-integration-surface-audit.md:65-72`). Receipt Lite uses proxy tools for
  Google Analytics/YouTube because its single-host topology does not run the separate
  Orchestrator and Runner services that execute deployed Nango Functions
  (`docs/agency-analytics-nango-enablement.md:52-58`).
- Local development: `docker-compose.local.yml` builds the same Dockerfile, publishes
  3003/3009, and defaults `NANGO_DATABASE_URL` to a **separate `receipt_integrations`
  database** on the host (`docker-compose.local.yml:8-35`). `LOCAL_SETUP.md:386,611`
  confirms the setup script creates that database. `nango-integrations/**` has **no bind
  mount**, so editing a Nango function locally changes nothing until it is deployed with
  the Nango CLI (`LOCAL_SETUP.md:800`). To reconcile provider configs against a running
  local container:
  `./bunw scripts/ensure-nango-integrations.mjs --provider-only --apply`
  (`LOCAL_SETUP.md:801`).

### 8.7 Checked-in Nango functions

`nango-integrations/` is a Zero-YAML TypeScript Nango project (`index.ts` + per-provider
folders, no `nango.yaml`). Build:

```bash
npm --prefix nango-integrations install
npm --prefix nango-integrations run compile   # NANGO_CLI_UPGRADE_MODE=ignore nango compile --no-interactive --no-dependency-update
```
(`docs/receipt-connect-nango.md:267-273`; `nango-integrations/package.json:9-11`)

Thirteen actions are registered in `index.ts`:
- `google-ads`: `get-campaign-performance`, `list-accessible-customers`
- `google-analytics`: `get-campaign-performance`, `list-account-summaries`
- `instagram`: `get-account-insights`, `get-account`
- `jira-oauth`: `create-issue` ← the only write
- `meta-marketing-api`: `get-campaign-performance`, `list-ad-accounts`
- `tiktok-ads`: `get-campaign-performance`, `list-advertisers`
- `youtube`: `get-channel-performance`, `list-channels`

`jira-oauth/actions/create-issue.ts` is the reference write implementation: input schema
`{projectKey, summary, description?, issueTypeName?, priorityName?, labels?(≤50),
assigneeAccountId?, cloudId?}`, output `{id, key, url}`, endpoint
`POST /receipt/jira/issues`, scopes `read:jira-work` + `write:jira-work`, `retries: 0`
on both the accessible-resources GET and the issue POST, and a typed `ActionError` of
`cloud_id_required` / `jira_site_unavailable` when the site cannot be selected
(`nango-integrations/jira-oauth/actions/create-issue.ts:1-107`). Its connection must be
reauthorized after adding `write:jira-work`, since an issued grant does not gain scopes
retroactively (`docs/receipt-connect-nango.md:276-278`).

Google Ads needs a platform developer token stored **only** in Nango
Environment Settings → Environment Variables as `GOOGLE_ADS_DEVELOPER_TOKEN`; it must not
be passed in action input, stored in Receipt, or exposed to Factory workers. Manager
accounts pass `managerCustomerId`, which the action sends as Google's
`login-customer-id` header (`docs/receipt-connect-nango.md:292-297`;
`docs/agency-analytics-nango-enablement.md:86-99`).

---

## 9. How chat and Factory consume connections at run time

### 9.1 Web chat

1. Before routing a turn, chat mints a `connect:read`-only JWT bound to the org's **Global
   scope** and fetches `/connect/capabilities` with a short timeout
   (`apps/start/src/lib/backend/chat/services/receipt-chat.service.ts:1214-1247`).
2. Capability details are sanitized into a snapshot including the connection's
   `receipt_action_policy` (`packages/receipt-app/src/services/receipt-connect-chat-status.ts:93-148`).
3. The router prompt receives "Authoritative Receipt Connect capability facts" and is
   instructed to use only the visible conversation plus those facts, and never to infer
   connection status (`packages/receipt-app/src/services/chat-layer-routing.ts:387-457`).
4. Deterministic pre-answers (no Factory run) for three states:
   - not connected → *"&lt;Label&gt; is not connected in Global Integrations yet."* +
     *"Open [Integrations](/organization/settings/integrations), connect &lt;Label&gt;,
     then retry this chat request."*
     (`receipt-chat.service.ts:1264-1324`)
   - connected but a **version-2 empty allowlist** →
     *"&lt;Label&gt; is connected in Global Integrations, but you don't have access to any
     enabled &lt;Label&gt; tools right now."* + *"Open [Integrations](…), choose
     &lt;Label&gt; > Manage tools, enable the required tool, then retry this chat
     request."* (`…:1412-1440`)
   - status unknown → *"I cannot confirm &lt;Label&gt; is connected right now because
     Receipt Connect status could not be checked."* + *"Open [Integrations](…) if
     &lt;Label&gt; should be connected, then retry this chat request."* (`…:1278-1281`)
5. A routing rule worth documenting: naming a connector does **not** force a Factory run.
   Public/general questions stay in chat even when they mention a connector by name; only
   a request for this workspace's own private/current data routes to Factory
   (`chat-layer-routing.ts:429-434`).

### 9.2 Factory objectives and `--required-capability`

`--required-capability` declares which Receipt Connect providers a Factory run needs.

- CLI surface: `receipt factory agent start --required-capability aws --prompt "<text>"`
  (`packages/receipt-app/src/factory-cli/commands/index.ts:2875`) and
  `receipt debug objective … --required-capability aws[,vercel]`
  (`packages/receipt-app/src/cli/shared.ts:72`).
- Parsing: `--required-capability`, `--capability`, and `--connect` are all accepted and
  merged; `--aws` adds `aws`. Values are comma-split, trimmed, lowercased, de-duplicated,
  and sorted (`packages/receipt-app/src/factory-cli/commands/index.ts:244-266`).
- **Capability selection is an authorization boundary and is never inferred from prompt
  text.** It comes from the structured routing result, an explicit caller requirement, or
  the selected execution profile's cloud provider. The comment is explicit: prompt
  keywords "would silently widen authority"
  (`packages/receipt-app/src/services/factory-infrastructure-guidance.ts:15-34`).
- The execution contract then computes the scope envelope: always
  `connect:credential` + `connect:read`, plus `connect:write` **whenever at least one
  capability is required**, plus any explicitly requested scopes
  (`packages/receipt-app/src/services/factory/runtime/objective-execution-contract.ts:46-61`).
  This is what "connected-system tasks receive the complete scope envelope so prompt
  classification cannot accidentally remove valid mutation authority" means
  (`docs/receipt-connect-nango.md:227-229`).
- Readiness: with zero required capabilities the check passes immediately. Otherwise
  Receipt fetches the capability manifest with three attempts (delays 0 / 500 / 1500 ms,
  overridable via `RECEIPT_CONNECT_MANIFEST_RETRY_DELAY_MS`) and requires every capability
  to be present **and usable**
  (`packages/receipt-app/src/services/factory/run-readiness-credentials.ts:8-41`;
  `…/run-readiness-manifest.ts:10-91`).
- Failure code `receipt_connect_unavailable`, `retryable: true`, with the message:
  *"Open Organization Settings > Integrations, reconnect &lt;AWS|GCP|…&gt;, then retry.
  Required remote credential unavailable: &lt;list&gt;."* plus, when known,
  *"Unusable connected capabilities: &lt;key&gt; is &lt;status&gt;; error …; expires at …"*
  (`…/run-readiness-credential-manifest.ts:9-84`).

### 9.3 The credential packet a worker receives

`taskReceiptConnectEnv` builds the packet
(`packages/receipt-app/src/services/factory/runtime/receipt-connect-env.ts:9-52`):

```text
RECEIPT_CONNECT_USER_ID
RECEIPT_CONNECT_ORGANIZATION_ID
RECEIPT_CONNECT_WORKSPACE_ID
RECEIPT_CONNECT_GATEWAY_URL
RECEIPT_CONNECT_TOKEN          # freshly minted, actor-scoped, sessionId = jobId
```

Scope minting is graduated: discovery runs get **`connect:read` only**; only when the task
actually requires credentials are `connect:credential` and the contract's scopes added
(`…:24-38`). An ambient `RECEIPT_CONNECT_TOKEN` cannot be narrowed, so it is used only for
required runs and only when no JWT signing secret is available locally (`…:40-51`).

The allowlist of env keys projected into a remote worker is exactly
`RECEIPT_CONNECT_USER_ID`, `_ORGANIZATION_ID`, `_WORKSPACE_ID`, `_WORKSPACE_NAME`,
`_GATEWAY_URL`, `_SERVER_URL`, `RECEIPT_PROXY_SERVER_URL`, `_TOKEN`, plus a small set of
general keys (`packages/receipt-app/src/services/factory/lima-auth-env-keys.ts:1-36`).
When a gateway URL, user id, and token are all present, `RECEIPT_CONNECT_SERVER_URL` and
`RECEIPT_PROXY_SERVER_URL` are deleted so only the gateway URL remains
(`…/lima-remote-env.ts:46-50`). `AWS_EC2_METADATA_DISABLED=true` is forced, with the
comment: "Hosted Factory must not fall back to EC2/ECS/OpenSandbox metadata for user cloud
objectives. Receipt Connect config is the only supported AWS credential source in remote
workers" (`…/lima-remote-env.ts:33-36`).

### 9.4 What is installed inside the sandbox

`ensureRemoteReceiptConnectCliConfig` runs before Codex starts
(`packages/receipt-app/src/services/factory/lima-receipt-connect.ts:11-31`):

1. Create `<workspace>/.receipt/connect/`, write the JWT to `…/connect/token`, `chmod 600`
   (`…/lima-receipt-connect-context.ts:37-47`).
2. Fetch the capability manifest and keep only remote-installable entries: transport
   `nango-cli`, GitHub `github-token`, or AWS `local-aws-profile` /
   `aws-credential-process` (`…/lima-receipt-connect-manifest.ts:9-42`).
3. Write per-provider **credential helper scripts** — never credentials
   (`…/lima-receipt-connect-configure.ts:14-44`).
4. `chmod +x` every helper, then **smoke-test each one** by running it; a terminal
   `receipt_connect_reauthorization_required` in stderr becomes a
   `FactoryComputerCredentialUnavailableError` (`…/lima-receipt-connect-validate.ts:18-48`).

**The credential helper** is a POSIX shell script that POSTs
`<gateway>/connect/credential/<provider>[?connection=<name>]` with the token read from the
token file, writes the response to a `mktemp` file under `umask 077`, traps-and-deletes it,
and pipes it through `jq`. Non-2xx responses print either
`Receipt Connect terminal credential error [<code>]: <message>` (when `retryable=false`) or
`Receipt Connect credential request failed (HTTP <status>): <message>`, then `exit 22`
(`…/lima-receipt-connect-helpers.ts:3-36`).

**AWS** (`…/lima-receipt-connect-provider-aws.ts:11-76`):
- One `aws-credential-process` helper per connection (`aws-credential-process` for
  `default`, `aws-credential-process-<name>` otherwise) with `jq` expression `.credentials`.
- An AWS config file at `<configDir>/aws-config` containing `[default]` (only when a
  default connection exists, as a fallback for Codex subprocesses that lose
  `AWS_CONFIG_FILE`/`AWS_PROFILE`) plus `[profile receipt]` / `[profile receipt-<name>]`,
  each with `credential_process = <script>` and `region = us-east-1`.
- The same content is also written to `$HOME/.aws/config`.
- Sets `AWS_PROFILE`, `AWS_CONFIG_FILE`, `AWS_EC2_METADATA_DISABLED=true`.
- Validation additionally clears `~/.aws/cli/cache` (OpenSandbox pools reuse HOME and can
  shadow a fresh credential with a cached session token) and runs
  `aws sts get-caller-identity`. On failure: *"Your AWS connection failed validation. Open
  Organization Settings > Integrations, reconnect AWS, then retry."*
  (`…/lima-receipt-connect-validate.ts:50-77`)

**Google Cloud — an isolated gcloud config** (`…/lima-receipt-connect-provider-gcp.ts:90-169`):
- Creates `<configDir>/gcloud` and sets `CLOUDSDK_CONFIG` to it, so nothing touches a
  shared `~/.config/gcloud`.
- Writes one credential helper per connection (`gcp-cli-config`, or
  `gcp-cli-config-<name>`).
- Writes **wrapper shims** for `gcloud`, `bq`, and `gsutil` into
  `<workspace>/.receipt/bin`. Each wrapper fetches a fresh token per invocation, stores it
  in a `mktemp` file under `umask 077`, exports
  `CLOUDSDK_AUTH_ACCESS_TOKEN_FILE`, runs the real binary, and traps-deletes the file on
  exit (`…:58-72`).
- Because OpenSandbox launches commands through `bash -lc` and Debian's login profile
  replaces PATH, it also writes a `gcp-bash-env` file exporting the bin dir onto PATH and
  sets `BASH_ENV` to it (`…:106-117`).
- `gsutil` cannot consume the access-token-file property, so authenticated `gsutil` calls
  are routed to `gcloud storage`; a bare `gsutil ls` enumerates every visible project
  (there is no persistent default project), and `gsutil version` still runs the packaged
  binary (`…:20-89`).

**Jira CLI config** (`…/lima-receipt-connect-configure.ts:35-42`,
`…/lima-receipt-connect-provider-simple.ts:16-47`):
- Applies to `jira-oauth` and `jira-api`.
- Sets `JIRA_CONFIG_DIR=<configDir>/jira` and writes a helper named `jira-cli-config`
  (or `jira-cli-config-<name>`) whose `jq` expression is `.` — the whole credential bundle.
- The module's own comment states the boundary: "Generic HTTP-backed integrations
  intentionally bypass this path and use `receipt connect call` so their credentials never
  enter the sandbox" (`…/lima-receipt-connect-provider-simple.ts:10-15`).

**The Nango credential helper for everything else.** Generic Nango-backed connections get
**no** credential file at all. They are used through
`receipt connect list|tools|call`, which speak to the gateway with the task token; the
provider credential stays in Nango and is injected server-side by Nango Proxy
(`docs/receipt-connect-nango.md:197-220`; agent CLI at
`packages/receipt-app/src/services/receipt-connect-agent-cli.ts:113-221`).

### 9.5 What is never injected into an agent environment

Verified in code:

- **Raw provider API keys, OAuth access/refresh tokens, and provider client secrets** for
  generic Nango connectors. Only a Receipt JWT plus helper scripts are written; the JWT is
  workspace/actor-scoped and short-lived.
- **The Nango environment secret key** (`RECEIPT_INTEGRATIONS_SECRET_KEY`). It is used only
  server-side to authenticate Receipt→Nango calls
  (`packages/receipt-app/src/services/receipt-connect-call.ts:531-544`,
  `…:1035-1060`) and is not in `RECEIPT_CONNECT_ENV_KEYS`
  (`…/lima-auth-env-keys.ts:17-26`).
- **`RECEIPT_INTEGRATIONS_DATABASE_URL`** — server-only, explicitly barred from web
  clients, CLI artifacts, Factory task packets, and OpenSandbox workers
  (`docs/receipt-connect-nango.md:82-84`).
- **`GOOGLE_ADS_DEVELOPER_TOKEN`** — lives only in Nango Environment Settings
  (`docs/receipt-connect-nango.md:292-297`).
- **The MCP client config never contains the token.** `assertTokenFreeClientConfig` checks
  the generated config, the file written, and the config Codex reports back
  (`packages/receipt-app/src/services/receipt-mcp-cli.ts:660-663,700-707,758-762`); the
  bridge is a `stdio` launcher that reads the saved session at run time.
- **Ambient AWS instance credentials** are disabled (`AWS_EC2_METADATA_DISABLED=true`).
- Investigation reports are sanitized for `RECEIPT_CONNECT_TOKEN` mentions
  (`packages/receipt-app/src/services/factory/runtime/investigation-report-sanitize.ts:18`).
- Worker guidance forbids printing secret/token/credential values into stdout, stderr,
  artifacts, or final JSON (`packages/receipt-app/src/services/factory-infrastructure-guidance.ts:70`).

### 9.6 Worker tool discipline

The prescribed loop for a worker using a connection
(`docs/receipt-connect-nango.md:253-265`): discover tools before every provider workflow;
for a write, first run a read/search tool to prevent duplicates or identify the exact
target, execute the enabled write once, then perform a bounded read-back where the provider
offers one. A missing write tool means the policy has not enabled it or the connector does
not support it — the worker must not fall back to an arbitrary provider-relative mutation.
Provider authorization is still a separate boundary: an HTTP 403 from the provider must not
be retried or bypassed (e.g. Apollo contact writes need a key scoped to
`api/v1/contacts/create`, `api/v1/contacts/update`, `contact_destroy`).

---

## 10. Connecting a provider: web UI vs CLI

### 10.1 Web UI path

1. Sign in; open **Organization Settings → Integrations** (Global) or **MCP Gateway →
   &lt;workspace&gt; → Overview → Open integrations** (workspace-scoped).
2. Click **Connect** on a card.
3. `startReceiptConnectSession` mints a 10-minute web token, exchanges it for a
   workspace-bound token, and POSTs `/connect/nango/sessions` with
   `{provider, connectionName?, endUserEmail}`
   (`apps/start/src/lib/frontend/receipt-connect/receipt-connect.server.ts:528-575`).
   The organization surface passes no `workspaceId`, so the server substitutes the Global
   scope (`…:536`).
4. The gateway creates a Nango Connect session tagged with
   `organization_id`, `workspace_id`, `end_user_id`, `connection_name`, and optionally
   `end_user_email` / `end_user_display_name`. Deprecated `end_user` and `organization`
   owner fields are sent too, because the pinned self-hosted server can drop tags for
   provider-only flows (`packages/receipt-app/src/server/receipt-connect-routes.ts:1811-1866`).
   `allowed_integrations` is a single value: the resolved integration id (`…:1866`).
   If a reference for that provider+name already exists, Receipt calls
   `/connect/sessions/reconnect` with the existing ids instead
   (`…:1830-1845`).
5. The returned connect link gets an `apiURL` query param pointing at the public
   integration URL, so the embedded Connect UI talks to the right origin
   (`…:422-455`, `resolveReceiptIntegrationProviderPublicUrl` at
   `packages/receipt-app/src/services/receipt-connect-config.ts:90-104`).
6. The link is rendered **in an iframe inside a dialog**; Receipt handles Nango's
   `connect` / `close` postMessage events itself.
7. Nango fires the signed auth webhook; Receipt stores the encrypted reference. The page
   also polls for two minutes so the card flips even if webhook delivery lags.

### 10.2 CLI path

```bash
receipt login                 # or: receipt login https://app.kentron.ai
receipt connect               # guided onboarding
receipt connect <connector>   # e.g. receipt connect github
receipt connect list [--json]
receipt connect tools <connection>
receipt connect call <connection> <tool> --json '{...}'
receipt connect call <connection> --path /provider/api/path [--query-json '{...}']
receipt connect status
receipt connect disconnect [--provider aws] [--name default]
```
(`packages/receipt-app/src/cli/shared.ts:36-46,107-160`)

`receipt connect <provider>` (`packages/receipt-app/src/cli/commands.ts:1255-1310`):
1. POSTs `/connect/nango/sessions`.
2. Prints `Step 2 of 2: authorize <provider>` and `  Open: <connect link>`
   (`…:1148-1176`). In a TTY it pauses with
   `  Press Enter to open <provider> authorization...` before opening the browser, unless
   `--yes` or `--auto-open`. With browser auto-open disabled it prints
   `  Browser auto-open is disabled; open the URL above to continue.`
3. Then prints `Waiting for <provider> authorization to complete...` and polls
   `/connect/connections` every 2 s (default timeout 10 minutes, `--timeout-ms` to change)
   until a `valid` connection for that provider appears
   (`…:1209-1256`). On success:
   `receipt connect: <provider> connection '<name>' is ready for server jobs.`
   With `--no-wait`: `After authorization completes, run 'receipt connect status' to
   verify the <provider> connection.`
4. Timeout error: `Timed out waiting for <provider> connection; saw <provider:name=status, …>.`

Other CLI outputs:
- `receipt connect status` with no connections:
  `receipt connect status: no server-side connections configured`, else
  `receipt connect status:` followed by one line per connection with optional
  `account <id>`, principal ARN, and `expires <ts>` detail
  (`…:1300-1345`).
- `receipt connect list` (worker/agent form): `Current connections: none` or
  `Current connections:` then `  <provider>:<name> <status>`
  (`packages/receipt-app/src/services/receipt-connect-agent-cli.ts:97-111`).
- `receipt connect disconnect`: `receipt connect disconnect: no <provider>:<name>
  connection found` or `receipt connect disconnect: removed <provider>:<name>`. Defaults
  are `--provider aws --name default` (`packages/receipt-app/src/cli/commands.ts:1621-1656`).
- `receipt connect check [local|dev|prod]`: prints `receipt connect check: ok (<url>)`,
  `  Nango health: ok`, `  Nango webhook: accepted`, `  Connections: <n>`. It requires
  `RECEIPT_INTEGRATIONS_WEBHOOK_SECRET` locally because it sends a **signed webhook probe**
  (`…:1360-1420`).
- `receipt connect setup`: prints `Receipt account: connected to workspace <name> (<id>)`
  or `Receipt account: not connected (<reason>)`, then `Receipt Connect connectors:` with
  `  <id>: <label> via real '<command>' CLI` for every catalog entry, then the Claude
  observer status (`…:640-677`).
- `receipt connect relay` was removed and now errors with the list of valid connector ids
  (`…:2262-2266`).

### 10.3 How the two paths differ

| | Web UI | CLI |
| --- | --- | --- |
| Scope written to | Global scope (Organization → Integrations) **or** the open workspace (MCP Gateway tab) | The workspace bound into the saved CLI session (`receipt workspace use`) |
| Auth | Better Auth session → 10-min `connect:read,connect:write` token → workspace-bound token | Device/browser login → saved session token, default scopes `connect:read,connect:write,connect:credential` |
| Provider UI | Nango Connect embedded in an iframe dialog, with Receipt doing the postMessage handshake | Nango Connect opened in the system browser |
| Completion signal | `connect`/`close` postMessage + 2-minute polling | Polls `/connect/connections` every 2 s up to 10 min |
| Who can start it | Requires workspace mutation authority (owner/admin at workspace or org level) | Same server-side check applies to the CLI's token |
| Naming a connection | Always `default` from the UI (no name field is exposed) | `connectionName` is supported by the API; the CLI's provider flow does not expose a flag for it today |
| Tool discovery | Manage tools dialog | `receipt connect tools <connection>` / `receipt tools list` |

Endpoint targets for the CLI: `prod` (default), `dev`, `local`, or an explicit
`http(s)://` URL. `local` defaults to `http://127.0.0.1:8787` for the gateway and
`http://127.0.0.1:3000` for auth (`packages/receipt-app/src/services/receipt-connect-command-proxy.ts:492-585`).
An invalid target errors with `receipt connect target must be prod, dev, local, or an
http(s) URL`.

### 10.4 The MCP client path

```bash
receipt mcp config [codex|generic] [--output <path>] [--json]
receipt mcp install codex [--dry-run]
receipt mcp status codex
receipt mcp remove codex
receipt mcp serve
```
(`packages/receipt-app/src/cli/shared.ts:32-35`)

- `install`/`status`/`remove` support **codex only**; other clients must use
  `receipt mcp config --client generic`
  (`packages/receipt-app/src/services/receipt-mcp-cli.ts:688-692`).
- Codex config is written by delegating to `codex mcp add|remove`, always at
  `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`). An arbitrary
  `--client-config` path is rejected: *"Codex does not accept an arbitrary config path;
  expected &lt;path&gt;. Set CODEX_HOME before running Receipt if Codex uses another
  home."* (`…:243-250,699-706`)
- The file is backed up before mutation and restored on any failure (`…:265-289,749-780`).
- Config is `mcp_servers.<name>` (default name `receipt`) with `command` + `args` pointing
  at the local Receipt CLI running `mcp serve`; the generic form additionally reports
  `remote.url` (the `/connect/mcp` endpoint) and a `workspace` identity block
  (`…:185-228`).
- `receipt mcp serve` bridges stdio JSON-RPC to `POST /connect/mcp` and never answers
  notifications (`…:600-630`).
- Not signed in: `receipt mcp: not signed in; run 'receipt login' first` (`…:120-122`).

### 10.5 `receipt tools` (connection-agnostic vocabulary)

`receipt tools list|describe|call` speaks to the **aggregate** gateway by default and to a
single connection when `--connection <provider:name>` (or a positional connection on
`list`) is given (`packages/receipt-app/src/services/receipt-mcp-cli.ts:465-560`). Errors:
`receipt tools describe requires a tool name`, `receipt tools call requires a tool name`,
`Receipt tool '<name>' was not found`, `receipt tools supports list, describe, and call`.
Output always includes a `workspace` identity block so the caller can see which scope
answered.

---

## 11. Docs vs code — disagreements found

1. **Catalog size.** `docs/receipt-integration-surface-audit.md:4,15` says "61 checked-in
   connectors" and "88 static Receipt tools: 85 read and 3 write". The current catalog has
   **62** slugs (`packages/receipt-app/src/integrations/nango/catalog.json`) and the audit
   script reports **89 static tools (86 read, 3 write)**. `attio` is the new row and is
   absent from the audit's matrix.
2. **Confluence OAuth surface.** The audit table lists `confluence-oauth` as
   `compatibility-read` (`…:130`); the manifest declares
   `apiProxy.kind: "atlassian-cloud-resource"`, so the current classification is
   `resource-aware-get` (confirmed by re-running the audit script).
3. **The Actions editor.** `docs/receipt-connect-nango.md:234-236` says "The Integrations
   page intentionally does not show the Actions editor while write workflows are unused."
   It does: **Manage tools** is shipped with read and write sections
   (`apps/start/src/components/organization/settings/integrations/integration-permissions-dialog.tsx`).
4. **Org enablement table.** `docs/integration-factory-receipt.md:277-280` describes a
   DB write of `organization_id + integration_id + enabled=true`. No such table or write
   exists; `…:39-43` in the same file states the correction. Connectability comes from the
   checked-in catalog plus the live Nango integration list.
5. **`/connect/capabilities` example.** `docs/receipt-connect-nango.md:185-187` says
   runtime "sees available named connections, for example `aws`, `aws.prod`, `gcp`,
   `jira-oauth`, `notion`, and `github`" — correct in shape, but the doc's
   capability-manifest sample (`…:331-336`) omits the `command`, `transport`, `status`,
   `connectionId`, and `discoveredAt` fields the endpoint actually returns.
6. **`docs/integration-factory-receipt.md:305-319`** shows a capability manifest with
   `"transport": "nango-action"`. The real transport values are `nango-cli`,
   `local-aws-profile`, `aws-credential-process`, `github-token`
   (`packages/receipt-app/src/services/receipt-connect-connections.ts:32-36`).
7. **Env-var list.** `docs/receipt-connect-nango.md:88-132` lists
   `RECEIPT_NANGO_*_INTEGRATION_ID` overrides for ~44 connectors but omits several that
   now exist in the catalog: `attio`, `google-chat`, `google-tasks`, `azure-blob-storage`,
   `tiktok-accounts`, `tiktok-personal`, `anthropic`, `openai`, `zoom`, `zoominfo`, and the
   whole Zoho family beyond the base `zoho` entry. The env name is derived mechanically per
   manifest (`integrationEnv` in each `provider.json`), so the doc's list is illustrative,
   not exhaustive.
8. **Zendesk.** The prose is correct — the manifest's `defaultIntegrationId` really is
   `zendesk-oauth` while `providerSlug` is `zendesk`, and its aliases include the legacy
   `zendesk-api-key`
   (`packages/receipt-app/src/integrations/nango/slugs/zendesk/provider.json`). But the
   audit matrix still labels Zendesk `missing`
   (`docs/receipt-integration-surface-audit.md:119`) from a snapshot dated 2026-08-19;
   that is deployment state, not catalog state.
9. **Missing-config list is a point-in-time snapshot.** `docs/receipt-integration-surface-audit.md:155-177`
   lists nine "missing" Nango configs against an evidence file dated 2026-08-19. Do not
   publish those as current product facts; they are deployment state, not catalog state.
   The audit file itself says `unreconciled` "makes no assertion about current hosted
   state" (`…:16-17`).
10. **`nango-integrations` compile command.** `docs/receipt-connect-nango.md:270-272` uses
    `npm --prefix nango-integrations`, while the repo is otherwise Bun-based. That is
    intentional (the Nango CLI is an npm devDependency in that sub-project,
    `nango-integrations/package.json`), but it will look inconsistent to a reader.
11. **UI comment vs data.** `integrations-page.tsx:1239-1241` calls the directory
    "a 900-entry directory"; the pinned snapshot has **894** rows
    (`apps/start/src/components/organization/settings/integrations/nango-provider-catalog.ts`).
12. **Commit vs label.** Commit `dee86034` is titled "requests, tokens and spend on the
    Usage tab", but the tab's visible label is **"Users"** (`tab=users`). There is no tab
    labelled "Usage".

---

## 12. Internal-only — must NOT be published

- **AWS account id `<aws-account-id>`** and IAM principal `<iam-user-arn>`
  (`docs/deploy/app-kentron-ai-cutover-todo.md:56-58`;
  `docs/production-release-handoff-2026-06-25.md:84,90,251`).
- **The `beetle` AWS CLI profile** as a default for `receipt:agent:aws` /
  `receipt:aws:debug` (`AGENTS.md:130`), and the CLI usage example
  `receipt connect import-local-aws --local-profile-reference --aws-profile <your-aws-profile> …`
  (`packages/receipt-app/src/cli/shared.ts:167`). Publish that example with a neutral
  profile name, or drop it.
- **`--from-aws`** on `ensure-nango-integrations.mjs` and the `factory:integrations:*`
  npm scripts that hard-code it: they shell out to the `aws` CLI to read a deployed ECS
  task definition (`scripts/ensure-nango-integrations.mjs:110-125`; `package.json:43-46`).
  Self-hosting docs should show the env-var form (`--check` / `--apply` with
  `RECEIPT_INTEGRATIONS_URL` + `RECEIPT_INTEGRATIONS_SECRET_KEY` set) instead.
- **The whole `docs/deploy/app-kentron-ai-cutover-todo.md`** cutover runbook: legacy origin
  `beetle.run`, Elastic IP `<elastic-ip>`, EC2 instance `<ec2-instance-id>`, SSM
  command ids, CodeBuild run ids, image digests, SecureString versions, `/opt/receipt/…`
  host paths, and a named employee ("the designated operator's unambiguous production actor").
- **`docs/production-release-handoff-2026-06-25.md`**: S3 bucket names containing the AWS
  account id, the `<deploy-secrets-prefix>/production-secrets-env` SSM path, and the instruction that
  it "has the real Nango prod environment `secret_key`".
- **"Beetle" as user-facing branding.** The Integrations page renders "Build &lt;name&gt;
  with Beetle Tasks" and a `/tasks?...` link
  (`apps/start/src/components/organization/settings/integrations/integrations-page.tsx:170-196,505-580`).
  It is a real product string, so record it, but flag that it references legacy internal
  naming; confirm with the team before putting "Beetle" in public docs.
- **Prod-debug capability flows**: `receipt debug objective --required-capability …`,
  `RECEIPT_DEBUG_TOKEN` / `RECEIPT_DEBUG_JWT_SECRET`, and
  `packages/receipt-app/src/server/prod-debug-*.ts`. These depend on a deployment debug
  token and a specific production actor; they are operations tooling, not a documented user
  or self-host feature.
- **Default local Nango secrets** in `docker-compose.local.yml:30-32`
  (`LOCAL_NANGO_ENCRYPTION_KEY` default, dashboard `receipt`/`receipt`). Safe to mention as
  "local defaults exist" but do not print the values as if they were guidance.
- **The Receipt CLI install URL** `https://raw.githubusercontent.com/kentronai/receipt-cli/main/install.sh`
  (`packages/receipt-app/src/cli/shared.ts:175`) points at a personal GitHub account;
  confirm the canonical distribution URL before publishing it.

---

## 13. Open questions for a human

1. Is "Beetle" / "Beetle Tasks" acceptable in public documentation, or should the
   request-an-integration panel be described generically ("open an integration request")?
2. Should the docs publish the connector availability matrix at all? It is deployment
   state (which Nango configs exist in *your* install), not catalog state, and the checked
   in evidence snapshot is stale.
3. Is the Receipt CLI published under a stable, org-owned distribution URL? The usage text
   points at a personal GitHub repo.
4. `receipt connect <provider>` has no `--connection-name` flag even though the API accepts
   `connectionName`, and the web UI never names a connection either. How is a user supposed
   to create `aws.prod` / `google-ads:acme` today — is it API-only?
5. `kubeconfig-exec` is a supported `credentialMode` and there is a
   `configureKubectlReceiptConnectEntries` implementation, but no checked-in connector uses
   it. Is Kubernetes a shipped capability or dead code?
6. `receipt connect setup` also installs a "Claude observer". Is that in scope for the
   integrations documentation, or a separate feature?
7. Is the Nango dashboard (port 3009 Connect UI / dashboard credentials) something
   self-hosters are expected to use, or is `ensure-nango-integrations.mjs` the only
   supported provisioning surface?
8. What is the intended user story for the `Activity` page now that the `Dashboard` page
   exists? Activity's own copy says tool receipts "will appear here when gateway execution
   reporting is available", but that reporting now exists on the Dashboard.
9. Should self-hosting docs describe the six Nango image patches as required, or is there a
   supported path on an unpatched upstream Nango image?
10. `docs/receipt-connect-nango.md` mixes user guidance with production-readiness checklists
    for the Kentron deployment. Which parts are intended to be public?

---

## Suggested doc pages

| Slug | Title | Purpose | Audience |
| --- | --- | --- | --- |
| `integrations/overview` | Receipt Connect overview | Understand what a connection is, what Receipt stores versus what stays in Nango, and the difference between Global and workspace-scoped connections. | user |
| `integrations/connect-an-app` | Connect an app from the web | Connect, reconnect, and disconnect an integration from Organization Settings, and read the card states correctly. | user |
| `integrations/manage-tools` | Manage tools and permissions | Control exactly which read and write operations a connection exposes, including the GitHub repository selector and the fail-closed write rules. | user |
| `integrations/workspaces-and-scopes` | Workspaces, Global Integrations, and scope | Choose the right scope for chat, MCP clients, and the CLI, and understand why a connection visible in one place is invisible in another. | both |
| `mcp-gateway/overview` | The MCP gateway | Point an MCP client at Receipt, understand aggregate tool names, and know which tools are published and which are held back. | both |
| `mcp-gateway/connect-a-client` | Connect Codex and other MCP clients | Run the five-command setup, verify the bridge, and troubleshoot install/remove failures. | user |
| `mcp-gateway/activity-and-usage` | Gateway activity and usage | Read the Dashboard, Users, and Live activity tabs, and know exactly what each number counts and does not count. | user |
| `cli/receipt-connect` | `receipt connect` and `receipt tools` | Connect providers, discover tools, and call them from the terminal or from inside an agent sandbox. | both |
| `agents/using-connected-systems` | How agents use connected systems | Understand `--required-capability`, the scope envelope, the credential helpers installed in a sandbox, and what an agent never receives. | developer |
| `platform/architecture-receipt-connect` | Receipt Connect architecture | The gateway routes, the JWT, the connection registry, webhook plus read-repair, and the four execution surfaces. | developer |
| `self-hosting/integrations` | Self-hosting the integration provider | Stand up the pinned self-hosted Nango, set the `RECEIPT_INTEGRATIONS_*` and `NANGO_*` env vars, and configure the signed webhook. | developer |
| `self-hosting/provider-apps` | Registering provider OAuth apps | Per-connector OAuth app requirements, callback URL, scope defaults, and the `RECEIPT_NANGO_*` credential/scope overrides. | developer |
| `contributing/add-a-connector` | Adding a connector | Author `provider.json`, register the slug in both catalog files, choose an execution surface, and ship it through PR → merge → deploy. | developer |
| `reference/connector-surfaces` | Connector surfaces and tools reference | Look up which surface a connector uses, what `read-provider-resource` allows, and which typed tools each connector publishes. | both |
