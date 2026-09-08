# D. MCP Gateway and Receipt Connect at HEAD (c3c16be6)

Research report for the public Receipt documentation site. Repo:
`<repo>`, HEAD `c3c16be6` on
`main`, 43 commits after the prior corpus commit `41baea75`. Every claim below
was re-verified by reading source at HEAD; `path:line` anchors are to HEAD. The
prior corpus (`doc/research/10-integrations-connect-mcp.md`,
`04-public-cli.md`) was used only as a map. Nothing in either repository was
modified.

Feature classification key used throughout:

| Class | Meaning |
| --- | --- |
| **Reachable** | Implemented and reachable in the UI or CLI. |
| **Hidden** | Implemented but reachable only by direct URL, API call, or flag. |
| **Inert** | UI or code exists but nothing executes or enforces it. |
| **Absent** | Not implemented. |

---

## 1. Concepts

### 1.1 Organization, workspace, Default, and the hidden Global scope

Receipt has two tenancy layers. The **organization** is the Better Auth
organization (billing, members, org role `owner|admin|member`). Inside it,
**workspaces** are the authorization boundary for Receipt Connect: every
connection row carries `organization_id` **and** `workspace_id`
(`packages/receipt-app/src/services/receipt-connect-connections.ts:449-467`),
and every list, resolve, and delete query filters on both
(`…:600-638`, `…:1393-1416`).

Three workspace-shaped rows exist per organization:

| Row | Id | Slug | How it appears |
| --- | --- | --- | --- |
| **Default** | `ws_<md5(organizationId)>` (`packages/receipt-app/src/services/receipt-workspaces.ts:148-151`) | `default` | Listed first, name `Default`, cannot be deleted (`…:111-113`: `"the Default workspace cannot be deleted"`). Membership mirrors the org member table (`…:128-140`). |
| **Named workspaces** | `ws_<uuid>` (`…:1503`) | slugified name | Created by org owners/admins only (`…:1492-1500`); every org owner/admin is auto-declared a member with their org role (`…:1514-1523`). |
| **Global scope** | `ws_global_<md5(organizationId)>` (`…:164-167`) | `receipt-system-global-<md5>` (`…:174-177`) | Declared on demand with name `"Global integrations"` (`…:895-903`); **excluded from every workspace list** (`…:1013,1018`: `w.id <> $3`), never selectable in the UI. |

The code comment states the reason for the Global scope
(`receipt-workspaces.ts:153-163`): chat runs with no workspace selected, and
resolving chat integrations to Default "meant connecting an app for chat also
connected it for whoever used Default with an MCP client, and vice versa. Those
are different audiences, so the global scope is its own row."

**Effective role** shown in the UI and used for authority is the org role when
it is `owner`/`admin`, otherwise the workspace role
(`receipt-workspaces.ts:588-594`). Three authority checks exist:

- `requireReceiptWorkspaceMembership` – member of that workspace in that org;
  404 `"workspace not found or unavailable"` otherwise (`…:1027-1064`).
- `requireReceiptOrganizationWorkspaceAdmin` – org `owner`/`admin`; 403
  `"organization owner or admin permission is required"` (`…:1066-1077`).
- `requireReceiptWorkspaceMutationAuthority` – workspace `owner`/`admin`, else
  fall back to org admin (`…:1079-1088`).

The route file's comment on why the workspace role is checked at the route
boundary: "Connection lifecycle and policy changes are workspace administration,
not ordinary `connect:write` operations. Web tokens intentionally carry broad
runtime scopes, so the workspace role must be checked at this boundary"
(`packages/receipt-app/src/server/receipt-connect-routes.ts:806-810`).

### 1.2 Connections: `provider:name` addressing and four kinds

A connection is addressed by **provider + name**; `default` is the implicit
name. Name normalization: trim, whitespace to `-`, lowercase, empty becomes
`default` (`receipt-connect-connections.ts:533-534`). The gateway accepts a
selector that is either a connection `id` or `provider:name`
(`…:1368-1391`); the organization and workspace predicates are part of the same
SQL as the selector "so a valid id from another organization can never be used
as a confused-deputy credential lookup" (`…:1362-1367`, `…:1396-1406`).

Kinds (`…:26-30`) and what the encrypted payload holds (`…:38-70`):

| `kind` | Stored payload (encrypted) | Holds a real credential? |
| --- | --- | --- |
| `nango-reference` | `{provider, nangoIntegrationId, nangoConnectionId}` | No – a pointer into Nango. |
| `local-aws-profile` | `{provider:"aws", profile}` | No – an AWS profile **name**. |
| `aws-credential-process` | `{provider:"aws", credentials:{Version:1, AccessKeyId, SecretAccessKey, SessionToken?, Expiration?}, identity?}` | **Yes** – imported via `POST /connect/credential/aws/import`. |
| `github-token` | `{provider:"github", token, login?, scopes?}` | **Yes** – imported via `POST /connect/credential/github/import`. |

Status is `valid | expired | invalid` (`…:31`). Storage is `org_connection_secret`
with `ciphertext`, `iv`, `auth_tag`, `key_version`, `metadata_json`, `status`,
`expires_at`, `last_validated_at` (`…:449-467`), AES-256-GCM, 12-byte IV, key
version 1 (`…:123-125`), key from `RECEIPT_CONNECTION_ENCRYPTION_KEY_B64` which
must decode to exactly 32 bytes
(`packages/receipt-app/src/services/receipt-connect-config.ts:114-128`).

Capability keys: bare provider id for `default`, `provider.name` otherwise
(`receipt-connect-connections.ts:543-549`), e.g. `aws` and `aws.prod`.

### 1.3 Capability manifest (`GET /connect/capabilities`)

Response: `{ ok, capabilities: string[] (sorted keys), manifest, sessions: [] }`
(`receipt-connect-routes.ts:1272-1308`). The manifest is
`kind: "receipt-connect.capability-manifest"`, `schemaVersion: 1`,
`transport: "receipt-connect"`, with per-key entries
`{command, provider, source, transport, status, connectionId, name, metadata,
expiresAt?, discoveredAt}` (`receipt-connect-connections.ts:559-598`;
manifest type at `packages/receipt-app/src/services/receipt-connect-command-proxy.ts:10-40`).
Manifest-level `status` is `online` when any capability exists, else `offline`
(`receipt-connect-routes.ts:1295`). Transport/source values are `nango-cli`,
`local-aws-profile`, `aws-credential-process`, `github-token`
(`receipt-connect-connections.ts:32-36`). The route schedules a background
read repair with `queueMicrotask` rather than awaiting it, because
"Capability checks sit on the chat preflight path and have a short timeout"
(`receipt-connect-routes.ts:745-757`).

A capability is treated as *usable* by chat only when its status contains none
of `invalid|expired|failed|failure|error|disconnected|revoked|unauthorized|
unauthenticated|missing|blocked` and it carries no error signal
(`packages/receipt-app/src/services/receipt-connect-chat-status.ts:49-72`).

### 1.4 The five tool surfaces

Classification is derived purely from the checked-in manifest, never from
connection metadata (`packages/receipt-app/src/services/receipt-connect-connectors.ts:122-178`).
Order of checks matters:

| Surface | Trigger | Enforcement label | Static tools |
| --- | --- | --- | --- |
| `typed-proxy` | `apiProxy.kind === "proxy-tools"` (checked first, `:131`) | `typed` | counted from manifest |
| `provider-mcp` | `apiProxy.kind === "mcp"` (`:144`) | `dynamic-review` | 0 static, dynamic |
| `resource-aware-get` | `apiProxy.kind === "atlassian-cloud-resource"` (`:153`) | `compatibility` | 1 read |
| `command-auth` | `credentialMode !== "nango-credentials"` (`:162`) | `runtime-only` | 0 |
| `compatibility-read` | everything else (`:171`) | `compatibility` | 1 read |

Consequences: `gcp` declares `credentialMode: "gcloud-config"` **and**
`proxy-tools`, so it is `typed-proxy`; `jira-oauth` declares `jira-config`
**and** `atlassian-cloud-resource`, so it is `resource-aware-get`, not
`command-auth`. `auth-only` exists in the type union (`:19`) but nothing returns
it (**Inert**). `kubeconfig-exec` exists in the credential-mode union
(`packages/receipt-app/src/services/receipt-connect-integration-registry.ts:9-14`)
but no checked-in connector uses it (**Absent** as a shipped connector).

The compatibility tool that every ordinary Nango connector (and both Atlassian
OAuth connectors) gets is `read-provider-resource`
(`receipt-connect-connectors.ts:42-43`, `:114-120`). Its description, verbatim
(`packages/receipt-app/src/services/receipt-connect-call.ts:723-724`):

> Read one provider-relative API resource through Receipt and Nango. This tool permits GET only; absolute URLs, request bodies, headers, and proxy routing overrides are rejected.

Input schema (`…:683-721`): `path` (required, `^/(?!/)`, 1–4096 chars) and
optional `query` (object, ≤100 properties, scalar or array-of-scalar values,
strings ≤8192 chars, arrays ≤100 items), `additionalProperties: false`. Runtime
re-checks reject `path must not contain a query string`, `query has too many
parameters`, `query key is too long`, `query '<name>' has too many values`,
`query '<name>' value is too long` (`…:745-776`). Limits: 30 s call timeout,
5 MiB response cap, 1 MiB action request body cap (`…:23-25`).

### 1.5 Tool policy allowlist (read/write classification, v1/v2)

Every discovered action is classified before anything runs
(`receipt-connect-call.ts:785-800`): any endpoint method in
`POST|PUT|PATCH|DELETE` is `write`; endpoint metadata with only other methods is
`read`; no endpoint metadata fails closed and only a conventional read name
(`^(?:get|list|search|find|read|fetch|lookup|whoami|who-am-i|check|describe)(?:[-_]|$)`,
`…:646`) counts as `read`. For provider-MCP tools, `annotations.readOnlyHint`
is authoritative when present, else the same regex (`…:903-910`).

The allowlist lives in Nango connection metadata under
`receipt_action_policy` (`…:648`), written with
`PATCH <nango>/connections/metadata` (`…:1738-1762`). Semantics (`…:1584-1590`):

- `schemaVersion: 1` (never edited): reads enabled by default, writes only if
  listed.
- `schemaVersion: 2` (after any save): **only** listed actions are enabled,
  reads included. Saving always writes version 2 (`…:1742-1745`).

A write executes only when the token carries `connect:write` (else
`ReceiptConnectWriteScopeRequiredError`, HTTP 400,
`"integration action '<tool>' requires connect:write"`, `…:195-197`,
`…:1908-1910`) **and** the action is enabled. Unknown and disabled tools share
one message, `404 "integration action not found or disabled"`
(`…:1873`, `:1882`, `:1906`), so callers cannot probe for hidden tools. Saving
an unknown name fails with `400 "integration action '<name>' is not available"`
(`…:1731-1735`). The PATCH route caps the list at 200 names of ≤256 chars
(`receipt-connect-routes.ts:1568-1579`).

### 1.6 GitHub repository policy

Stored as `receipt_github_repository_policy` in Nango metadata
(`receipt-connect-call.ts:649`), shape
`{schemaVersion:1, mode:"all"|"selected", repositories:[{id, fullName}]}`
(`…:653-660`). Enforcement (`…:2013-2075`): `/user` allowed; `/user/repos`,
`/repositories`, `/orgs/{org}/repos` allowed with the response array filtered
to selected ids/names; `/repos/{owner}/{repo}/…` allowed only if selected,
else `403 "GitHub repository '<owner/repo>' is not selected for this
connection"`; anything else under `selected` mode is
`403 "this GitHub endpoint is unavailable while selected repositories are
enforced"`. Discovery pages GitHub at 100 per page, max 10 pages (`…:650-651`).
The PATCH route caps at 1000 ids of ≤64 chars (`receipt-connect-routes.ts:1668-1680`).

### 1.7 Atlassian site resolution

For `atlassian-cloud-resource` connectors the requested path is rewritten to
`/ex/{jira|confluence}/{cloudId}{path}` after calling
`/oauth/token/accessible-resources`; paths already starting with `/ex/<product>/`
pass through (`receipt-connect-call.ts:592-644`). Errors: `502 "<Label>
connection did not expose an accessible Atlassian site"` and `409 "<Label>
connection exposes multiple Atlassian sites; call the explicit
/ex/<product>/{cloudId}/... path"` (`…:631-642`).

---

## 2. Connector catalog at HEAD

Source of truth: `packages/receipt-app/src/integrations/nango/catalog.json`
(63 `providerSlugs`) and one `provider.json` per slug under
`packages/receipt-app/src/integrations/nango/slugs/`. The loader does not
discover folders; each slug is also statically imported in `catalog.ts`.
Aliases must include `receiptId` (`catalog.ts:481`); product-level ids resolve
to the connector whose `authMode.default` is true
(`receipt-connect-integration-registry.ts:101-111`). Verified count by
`./bunw scripts/audit-receipt-integration-surfaces.mjs` on 2026-09-07:
**63 connectors, 91 static Receipt tools (88 read, 3 write), 0 manifest issues.**

Auth-mode totals: **45 OAuth2** (`setup.kind: oauth2`, Nango-hosted OAuth),
**17 provider-only** (API key / token / service-principal entered in Nango
Connect), **1 custom** (`github-app-oauth`). Surface totals: 18 typed-proxy
(50 tools: 47 read, 3 write), 2 provider-mcp, 2 resource-aware-get,
2 command-auth, 39 compatibility-read.

| # | `receiptId` | Label | Slug (folder) | Aliases | Setup / auth mode | Surface | Tools R/W |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `airtable` | Airtable | airtable | airtable, airtable-oauth | oauth2 / OAuth 2.0 | typed-proxy | 4/0 |
| 2 | `anthropic` | Anthropic | anthropic | anthropic | provider-only | compatibility-read | 1/0 |
| 3 | `apollo` | Apollo | apollo | apollo, apollo-api-key | provider-only / API Key | typed-proxy | 1/3 |
| 4 | `attio` | Attio | attio | attio | oauth2 | compatibility-read | 1/0 |
| 5 | `aws` | AWS | aws-iam | aws, cloudwatch, ec2, ecs, eks, elb, iam, lambda, rds, s3, vpc | provider-only; `credentialMode: aws-credential-process` | command-auth | 0/0 |
| 6 | `azure` | Azure | azure-service-principal | azure, azure-cloud, azure-resource-manager | provider-only / Service principal | typed-proxy | 2/0 |
| 7 | `azure-blob-storage` | Azure Blob Storage | azure-blob-storage | azure-blob-storage, azure-blob, azure-storage | oauth2 / OAuth 2.0 | typed-proxy | 2/0 |
| 8 | `azure-devops` | Azure DevOps | azure-devops | azure-devops, ado, azuredevops | oauth2 / OAuth 2.0 | compatibility-read | 1/0 |
| 9 | `cloudflare` | Cloudflare | cloudflare | cloudflare, cf | provider-only | compatibility-read | 1/0 |
| 10 | `confluence-api` | Confluence API Token | confluence-basic | confluence-api, confluence-basic | provider-only / API Token (product `confluence`) | compatibility-read | 1/0 |
| 11 | `confluence-oauth` | Confluence OAuth | confluence | confluence-oauth | oauth2 / OAuth (product `confluence`, default) | resource-aware-get | 1/0 |
| 12 | `datadog` | Datadog | datadog | datadog, dd | provider-only | compatibility-read | 1/0 |
| 13 | `gcp` | Google Cloud | google | gcp, gcloud, gcs, google, google-cloud, googlecloud, gsutil, bq, bigquery | oauth2 / OAuth 2.0; `credentialMode: gcloud-config` | typed-proxy | 5/0 |
| 14 | `github` | GitHub | github | github, gh | oauth2 | compatibility-read | 1/0 |
| 15 | `github-app-oauth` | GitHub (App OAuth) | github-app-oauth | github-app-oauth | custom | compatibility-read | 1/0 |
| 16 | `github-pat` | GitHub (Personal Access Token) | github-pat | github-pat | provider-only | compatibility-read | 1/0 |
| 17 | `gitlab` | GitLab | gitlab-pat | gitlab | provider-only | compatibility-read | 1/0 |
| 18 | `gong-oauth` | Gong (Oauth) | gong-oauth | gong-oauth | oauth2 | compatibility-read | 1/0 |
| 19 | `google-ads` | Google Ads | google-ads | google-ads, googleads, adwords | oauth2 / OAuth 2.0 | compatibility-read | 1/0 |
| 20 | `google-analytics` | Google Analytics | google-analytics | google-analytics, ga4 | oauth2 / OAuth 2.0 | typed-proxy | 2/0 |
| 21 | `google-calendar` | Google Calendar | google-calendar | google-calendar, gcal, googlecalendar | oauth2 / OAuth 2.0 | compatibility-read | 1/0 |
| 22 | `google-calendar-mcp` | Google Calendar (MCP) | google-calendar-mcp | google-calendar-mcp, gcal-mcp | oauth2 / OAuth 2.0 | provider-mcp | dynamic |
| 23 | `google-chat` | Google Chat | google-chat | google-chat, googlechat, gchat | oauth2 / OAuth 2.0 | typed-proxy | 3/0 |
| 24 | `google-docs` | Google Docs | google-docs | google-docs, googledocs, gdocs | oauth2 / OAuth 2.0 | typed-proxy | 2/0 |
| 25 | `google-drive` | Google Drive | google-drive | google-drive, gdrive, googledrive | oauth2 / OAuth 2.0 | typed-proxy | 2/0 |
| 26 | `google-mail` | Gmail | google-mail | google-mail, gmail | oauth2 / OAuth 2.0 | typed-proxy | 4/0 |
| 27 | `google-sheet` | Google Sheets | google-sheet | google-sheet, google-sheets, gsheets, googlesheets | oauth2 / OAuth 2.0 | compatibility-read | 1/0 |
| 28 | `google-slides` | Google Slides | google-slides | google-slides, gslides, googleslides | oauth2 / OAuth 2.0 | typed-proxy | 2/0 |
| 29 | `google-tasks` | Google Tasks | google-tasks | google-tasks, googletasks, gtasks | oauth2 / OAuth 2.0 | typed-proxy | 3/0 |
| 30 | `hubspot` | HubSpot | hubspot | hubspot | oauth2 | compatibility-read | 1/0 |
| 31 | `incident-io` | Incident.io | incident-io | incident-io, incident.io, incidentio | provider-only | compatibility-read | 1/0 |
| 32 | `instagram` | Instagram Insights | instagram | instagram, instagram-analytics, instagram-insights | oauth2 / OAuth 2.0 | typed-proxy | 3/0 |
| 33 | `jira-api` | Jira API Token | jira-basic | jira-api, jira-basic | provider-only / API Token (product `jira`); `credentialMode: jira-config` | command-auth | 0/0 |
| 34 | `jira-oauth` | Jira OAuth | atlassian | jira-oauth | oauth2 / OAuth (product `jira`, default); `credentialMode: jira-config` | resource-aware-get | 1/0 |
| 35 | `lagrowthmachine` | La Growth Machine | lagrowthmachine | lagrowthmachine | provider-only / API Key | compatibility-read | 1/0 |
| 36 | `linear` | Linear | linear-mcp | linear | provider-only | provider-mcp | dynamic |
| 37 | `linkedin` | LinkedIn | linkedin | linkedin | oauth2 | compatibility-read | 1/0 |
| 38 | `meta-marketing-api` | Meta Marketing API | meta-marketing-api | meta-marketing-api, meta-ads, facebook-ads, facebook-analytics | oauth2 / OAuth 2.0 | compatibility-read | 1/0 |
| 39 | `notion` | Notion | notion | notion | oauth2 | compatibility-read | 1/0 |
| 40 | `openai` | OpenAI | openai | openai | provider-only | compatibility-read | 1/0 |
| 41 | `outlook` | Outlook | outlook | outlook, microsoft-outlook, outlook-mail | oauth2 / OAuth 2.0 | typed-proxy | 4/0 |
| 42 | `sentry` | Sentry | sentry | sentry | provider-only | compatibility-read | 1/0 |
| 43 | `slack` | Slack | slack | slack | oauth2 | compatibility-read | 1/0 |
| 44 | `stripe-app` | Stripe App | stripe-app | stripe-app | oauth2 | compatibility-read | 1/0 |
| 45 | `terraform` | Terraform Cloud | terraform | terraform, terraform-cloud, tfcloud, tfc | provider-only | compatibility-read | 1/0 |
| 46 | `tiktok-accounts` | TikTok Accounts | tiktok-accounts | tiktok-accounts, tiktok-business-accounts | oauth2 / OAuth 2.0 | typed-proxy | 2/0 |
| 47 | `tiktok-ads` | TikTok Ads Analytics | tiktok-ads | tiktok, tiktok-ads, tiktok-analytics (product `tiktok`) | oauth2 / OAuth 2.0 | typed-proxy | 2/0 |
| 48 | `tiktok-personal` | TikTok Personal | tiktok-personal | tiktok-personal, tiktok-login-kit | oauth2 / OAuth 2.0 | typed-proxy | 2/0 |
| 49 | `vercel` | Vercel | vercel | vercel | provider-only | compatibility-read | 1/0 |
| 50 | `youtube` | YouTube Analytics | youtube | youtube, youtube-analytics | oauth2 / OAuth 2.0 | typed-proxy | 2/0 |
| 51 | `zendesk` | Zendesk | zendesk | zendesk, zendesk-oauth, zendesk-api-key | oauth2 / OAuth 2.0 (default Nango key `zendesk-oauth`) | compatibility-read | 1/0 |
| 52 | `zoho` | Zoho | zoho | zoho | oauth2 | compatibility-read | 1/0 |
| 53 | `zoho-books` | Zoho Books | zoho-books | zoho-books | oauth2 | compatibility-read | 1/0 |
| 54 | `zoho-calendar` | Zoho Calendar | zoho-calendar | zoho-calendar | oauth2 | compatibility-read | 1/0 |
| 55 | `zoho-crm` | Zoho CRM | zoho-crm | zoho-crm | oauth2 | compatibility-read | 1/0 |
| 56 | `zoho-desk` | Zoho Desk | zoho-desk | zoho-desk | oauth2 | compatibility-read | 1/0 |
| 57 | `zoho-inventory` | Zoho Inventory | zoho-inventory | zoho-inventory | oauth2 | compatibility-read | 1/0 |
| 58 | `zoho-invoice` | Zoho Invoice | zoho-invoice | zoho-invoice | oauth2 | compatibility-read | 1/0 |
| 59 | `zoho-mail` | Zoho Mail | zoho-mail | zoho-mail | oauth2 | compatibility-read | 1/0 |
| 60 | `zoho-people` | Zoho People | zoho-people | zoho-people | oauth2 | compatibility-read | 1/0 |
| 61 | `zoho-recruit` | Zoho Recruit | zoho-recruit | zoho-recruit | oauth2 | compatibility-read | 1/0 |
| 62 | `zoom` | Zoom | zoom | zoom | oauth2 | compatibility-read | 1/0 |
| 63 | `zoominfo` | ZoomInfo | zoominfo | zoominfo | oauth2 | compatibility-read | 1/0 |

Notes on the table:

- The three write tools are all Apollo: `create-contact`, `update-contact`,
  `delete-contact` (audit output; manifest under `slugs/apollo/provider.json`).
- `azure` is new since `41baea75` (commit `26ec975a`): provider-only
  service-principal auth, two read tools `list-subscriptions` (GET
  `/subscriptions`) and `query-resources` (POST to Resource Graph, classified
  `read` by manifest declaration), both with `baseUrlOverride`
  `https://management.azure.com`
  (`packages/receipt-app/src/integrations/nango/slugs/azure-service-principal/provider.json`).
- `jira` and `confluence` are grouping product ids only, never connectable ids.
  The UI keeps one card for `airtable` and `apollo` and multiple cards for
  `jira` and `confluence`
  (`apps/start/src/components/organization/settings/integrations/integration-catalog.ts:515-528`).
- Each connector declares an `integrationEnv` of the form
  `RECEIPT_NANGO_<ID>_INTEGRATION_ID` used only when the Nango unique key
  differs from `defaultIntegrationId` (`receipt-connect-connectors.ts:74-80`).
- The UI additionally renders a **display-only** 894-row snapshot of Nango's
  public provider directory (`nango-provider-catalog.ts`, header comment:
  "Receipt's runtime connector manifest remains the authority for whether a
  card is connectable"). Those rows render as "Coming soon" cards
  (`integrations-page.tsx:383-387`).
- Integrations present in a deployment's Nango but absent from the catalog are
  appended as dynamic `compatibility-read` rows by `GET /connect/connectors`
  (`receipt-connect-routes.ts:1393-1427`).

Typed-manifest validation at load time (an invalid manifest fails the app):
`inputSchema.additionalProperties` must be `false` (`catalog.ts:422`),
`pathParameters` must match path placeholders in order (`…:371-376`),
`retries` is an integer 0–3 (`…:379-380`), `baseUrlOverride` must be an HTTPS
origin (`…:382-401`), MCP `proxyPath` defaults to `/mcp` and must be a
provider-relative path without a query (`…:316-329`).

---

## 3. Nango integration

### 3.1 What Nango owns vs what Receipt owns

From `docs/receipt-connect-nango.md:36-50` (last changed 2026-08-20) and
verified in code: Nango owns OAuth/API-key authorization UX (Nango Connect),
provider credentials and refresh, and provider connection/integration ids.
Receipt owns user and workspace auth, Receipt Connect JWT issuance, the mapping
`organization_id + workspace_id + provider + name → nangoIntegrationId +
nangoConnectionId`, credential materialization for real CLIs, and policy,
receipts, and audit. Receipt Connect is provider-agnostic in configuration:
only `RECEIPT_INTEGRATIONS_*` names are read and only `nango` is accepted as
provider (`receipt-connect-config.ts:15-21`, `:46-50`).

Configuration variables (`receipt-connect-config.ts:15-21`, `:55-59`;
`packages/receipt-app/src/services/receipt-connect-nango-sync.ts:180-183`):

| Variable | Required | Purpose |
| --- | --- | --- |
| `RECEIPT_INTEGRATIONS_PROVIDER` | no (default `nango`) | Only `nango` accepted. |
| `RECEIPT_INTEGRATIONS_URL` | yes | Internal Nango base URL. |
| `RECEIPT_INTEGRATIONS_PUBLIC_URL` | no | Public URL placed into the Connect link as `apiURL` (`receipt-connect-routes.ts:422-455`, `receipt-connect-config.ts:90-104`). |
| `RECEIPT_INTEGRATIONS_SECRET_KEY` | yes | Nango environment secret; server-side only. |
| `RECEIPT_INTEGRATIONS_WEBHOOK_SECRET` | yes | HMAC key for `/connect/nango/webhook`. |
| `RECEIPT_INTEGRATIONS_DATABASE_URL` | no (server-only) | Direct read of Nango's private `nango._nango_connections` for read repair. |
| `RECEIPT_CONNECTION_ENCRYPTION_KEY_B64` | yes | 32-byte key for `org_connection_secret`. |
| `RECEIPT_CONNECT_JWT_SECRET` | no (falls back to `BETTER_AUTH_SECRET`) | HS256 signing secret (`receipt-connect-auth-token.ts:131-136`). |
| `RECEIPT_CONNECT_DEVICE_LOGIN_SECRET` | no (falls back to the JWT secret) | HMAC for device/user code hashes (`receipt-connect-device-login.ts:72-80`). |
| `RECEIPT_NANGO_<ID>_INTEGRATION_ID`, `RECEIPT_NANGO_<PREFIX>_CLIENT_ID/_CLIENT_SECRET/_SCOPES` | per connector | Nango unique-key and OAuth app overrides (`docs/receipt-connect-nango.md:86-160`). |

When the three required values are absent every Nango-backed route returns
`503 "Self-hosted Nango is not configured. Set RECEIPT_INTEGRATIONS_URL,
RECEIPT_INTEGRATIONS_SECRET_KEY, and RECEIPT_INTEGRATIONS_WEBHOOK_SECRET."`
(`receipt-connect-config.ts:43-44`). The web layer rewrites that into
user-facing copy: local development gets `"Integrations are not configured for
this local app. Start the integrated stack with bun run start:all, then try
again."`, hosted gets `"Integrations are temporarily unavailable because the
connection service is not configured. Contact your Receipt administrator."`
(`apps/start/src/lib/frontend/receipt-connect/receipt-connect-errors.ts:13-29`).

### 3.2 The Connect UI flow from the web app

1. A server function requires a Better Auth session and an active organization
   (`apps/start/src/lib/frontend/receipt-connect/receipt-connect.server.ts:180-189`:
   `"Sign in before connecting an integration."`, `"Select a workspace before
   connecting an integration."`).
2. It mints a **10-minute** web token with scopes `connect:read` and
   `connect:write` only (`…:38-41`, `:192-204`).
3. It exchanges that token at `POST /connect/workspaces/:id/token` for a
   workspace-bound token (`…:206-243`); the organization-wide surface passes
   no `workspaceId`, so the server substitutes the Global scope
   (`…:536`, `:743`, `:720-725`).
4. It POSTs `/connect/nango/sessions` with `{provider, connectionName?,
   endUserEmail}` (`…:544-561`). The runtime creates a Nango Connect session
   tagged `organization_id`, `workspace_id`, `end_user_id`,
   `connection_name`, plus deprecated `end_user`/`organization` owner fields
   because "the pinned self-hosted server used in production can drop tags for
   provider-only Connect flows" (`receipt-connect-routes.ts:1847-1890`).
   `allowed_integrations` is a single integration id (`…:1889`). If a
   reference for that provider+name already exists, `/connect/sessions/reconnect`
   is used instead (`…:1865-1872`). Provider-only integrations missing from
   Nango are auto-created (`…:1812-1834`, `:560-593`); OAuth ones are not.
5. The web UI renders the Connect link **inside an iframe in a dialog** and
   performs Nango's `connect`/`close` postMessage handshake itself, then toasts
   `"<name> connected."` and polls connection state for two minutes
   (`apps/start/src/components/organization/settings/integrations/integrations-page.tsx:811`;
   dialog title `Connect <name>` at `:1101`). The dialog description depends on
   scope (`integration-connect-scope-copy.ts:2-12`): organization: `"Enter
   your credentials below to connect <name> to this organization's Global
   Integrations. Other organizations you belong to are not affected."`;
   workspace: `"Enter your credentials below to connect <name> only to the
   <workspace> workspace."`
6. Nango fires the signed auth webhook and Receipt stores the encrypted
   reference.

The web UI never exposes a connection-name field; every web-created
connection is `default`. The CLI's `receipt connect <provider>` also sends no
name (`packages/receipt-app/src/connect-cli.ts:676-682`). Named connections
are therefore **Hidden**: reachable only through the API's `connectionName`
body field.

### 3.3 Webhooks (`POST /connect/nango/webhook`)

No JWT; the raw body is verified against `RECEIPT_INTEGRATIONS_WEBHOOK_SECRET`
using HMAC-SHA256 from header `x-nango-hmac-sha256`, compared with
`timingSafeEqual` over hex (`receipt-connect-routes.ts:123-145`, `:1934-1942`).
Failure: `401 {"ok":false,"error":"invalid Nango webhook signature"}`.

Two shapes are handled (`…:181-308`):

- `type:"auth"`, `operation:"creation"|"override"`, `success:true` — upserts
  a `nango-reference` row named from `tags.connection_name` (default `default`);
  workspace from `tags.workspace_id`, else the org's Default workspace
  (`…:200-202`, `:1986-1998`). If the actor has since lost workspace
  membership, Receipt acknowledges with 200, refuses the projection, and
  best-effort deletes the Nango connection, returning
  `{"ok":true,"ignored":true,"reason":"workspace_membership_revoked"}`
  (`…:1960-1985`).
- `type:"auth"`, `operation:"refresh"`, `success:false` — marks the matching
  row `invalid` with reason `nango_auth_refresh_failed` (`…:247-308`,
  `:2000-2021`). Anything else returns `{"ok":true,"ignored":true}`.

Webhook configuration is applied to Nango's private schema by
`scripts/ensure-nango-webhook-config.mjs` (exists at HEAD).

### 3.4 Read repair

`syncReceiptConnectConnectionsFromNango` reconciles Nango's HTTP connection
list with a direct read of `nango._nango_connections` filtered by
`tags->>'organization_id'` and `tags->>'workspace_id'`, where a null workspace
tag maps to the **Global** scope, not Default (`receipt-connect-nango-sync.ts:185-238`,
`:300-307`: "Nango connections created before workspace isolation only
carried an organization tag. They powered organization-wide chat, so their
compatible destination is Global—not Default, which is reserved for MCP
clients"). Invalidation reasons are `nango_connection_errors` and
`nango_refresh_exhausted` (`…:259-265`). Read repair is awaited on
`GET /connect/connections` (`receipt-connect-routes.ts:1443-1446`) and deferred
on `GET /connect/capabilities` and `GET /connect/connectors`; failures are
logged and swallowed so a briefly unreachable Nango never deletes rows
(`…:724-757`).

### 3.5 Reauthorization (409)

A terminal Nango credential failure (`invalid_credentials`, or a message
matching `invalid|expired|revoked credentials` or `refresh limit`) becomes
`ReceiptConnectReauthorizationRequiredError`: HTTP 409, code
`receipt_connect_reauthorization_required`, `retryable:false`,
`reconnectRequired:true`, message `"Your <Label> connection is no longer valid.
Open Organization Settings > Integrations, reconnect <Label>, then retry."`
(`packages/receipt-app/src/services/receipt-connect-nango-connection.ts:34-88`).
Every route that can hit it marks the row invalid before responding
(`receipt-connect-routes.ts:831-857`).

---

## 4. The aggregate MCP server: `POST /connect/mcp`

Implementation: `packages/receipt-app/src/services/receipt-connect-mcp.ts`;
route: `receipt-connect-routes.ts:859-918`. Path constant
`RECEIPT_MCP_PATH = "/connect/mcp"` (`packages/receipt-app/src/services/receipt-mcp-cli.ts:13`).
**Reachable** via `receipt mcp serve` / `receipt tools`; **Hidden** as a raw
HTTP endpoint (no UI shows the URL; `receipt doctor` prints it).

| Aspect | Value | Anchor |
| --- | --- | --- |
| Auth | `connect:credential` scope + current-workspace membership; `401 {"ok":false,"error":"unauthorized"}` / `403 {"ok":false,"error":"workspace_membership_required"}` | routes `859-867`, `828-829` |
| Protocol versions | `2025-11-25`, `2025-06-18`; unknown falls back to the first | mcp `22-25`, `276-281` |
| Server identity | `serverInfo {name:"receipt-connect", version:"1.0.0"}`, `capabilities {tools:{listChanged:false}}` | mcp `325-330` |
| Methods | `initialize`, `notifications/initialized` (202, empty body), `tools/list` (rejects `cursor`), `tools/call`; other requests `-32601 "Method not found"`; any notification is 202 | mcp `297-396` |
| Invalid JSON | `400 {"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}` | mcp `92-93`, routes `869-882` |
| Invalid envelope | `-32600 "Invalid Request"` (400) | mcp `288-307` |
| Bad params | `-32602 "Invalid params"` | mcp `311-323`, `334-338`, `356-363` |
| Discovery failure | `-32603 "Receipt MCP discovery failed"` | mcp `345-347`, `368-369` |
| Unknown tool | `-32602 "Unknown or unavailable tool"` | mcp `372-373` |
| Provider failure | JSON-RPC **result** with `isError:true` and `content[0].text` = the `ReceiptConnectCallError` message, or `"Receipt could not complete the integration tool call."` | mcp `263-274`, `385-393` |
| Success | `{content:[{type:"text", text}], structuredContent? (when result is an object), isError:false}` | mcp `249-261` |
| Session header | The CLI bridge forwards `Mcp-Session-Id` if the server returns one; the server never sets it | receipt-mcp-cli `367`, `393-397` |

The `instructions` string returned by `initialize`, verbatim
(`receipt-connect-mcp.ts:27-28`):

> Receipt tools are reviewed operations scoped to the organization and workspace authenticated by the saved CLI session. Tool names from tools/list are opaque; use them exactly and never construct aliases. Read-only annotations are authoritative. Writes appear only when the token and connection policy allow them; do not bypass a missing tool. read-provider-resource is GET-only and accepts only a provider-relative path and query. Re-list tools after switching workspaces or reconnecting.

**Alias naming** (`…:101-139`): `receipt_<provider>_<connectionName>_<tool>_<20 hex>`
where each part is NFKD-normalized, lowercased, non-alphanumerics replaced by
`_`; the digest is `sha256(JSON([connectionId, provider, name, upstreamToolName]))`
truncated to 20 hex chars; the readable prefix is trimmed so the total is ≤128
chars. Callers never receive the connection id or upstream tool name outside
the alias. `tools/call` validates `^[A-Za-z0-9_-]+$` and ≤128 chars
(`…:356-363`). A duplicate alias throws `"Receipt MCP tool alias collision"`
(`…:240`). Tests: "builds deterministic collision-safe names for the same
provider tool on two connections", "cannot call an alias composed for another
organization", "cannot call an alias composed for a sibling workspace"
(`receipt-connect-mcp.test.ts:103`, `:362`, `:396`).

**Publication rules** (`…:154-170`, `:172-247`):

- Only connections with `kind === "nango-reference"` and `status === "valid"`
  in the token's workspace participate (`…:183-186`). Imported
  `github-token`/`aws-credential-process`/`local-aws-profile` rows never
  publish MCP tools.
- Typed-proxy connectors publish exactly their manifest tool names;
  compatibility and Atlassian connectors publish only `read-provider-resource`;
  **provider-MCP connectors publish nothing through the aggregate** — comment:
  "Otherwise a new upstream read tool would silently become
  organization-callable" (`…:166-169`). Linear and Google Calendar (MCP) tools
  remain reachable only via `/connect/tools` + `/connect/call`.
- Write tools appear only when the token carries `connect:write` (`…:207`);
  every tool carries `annotations.readOnlyHint` (`…:219`); description is
  trimmed to 4096 chars (`…:216`).
- One broken connection is omitted with a console warning rather than failing
  the whole list (`…:224-233`).
- `tools/call` recomposes the full binding set on every call, then dispatches to
  `callReceiptConnectTool` with `allowWrite` from the token (`…:365-384`), so
  policy and connection health are re-checked per call.

**A finding for the receipts claim:** the `/connect/mcp` route does **not** call
`recordReceiptConnectToolCall`. The only call sites are the two branches of
`POST /connect/call` (`receipt-connect-routes.ts:1185`, `:1196`, `:1224`,
`:1235`); `receipt-connect-mcp.ts` does not import the receipts module. A tool
call made through the Codex bridge or `receipt tools call` (without
`--connection`) therefore produces no `tool.called`/`tool.observed` receipt and
never appears on the Gateway activity dashboard. Calls through `receipt tools
call --connection`, `receipt connect call`, and sandbox agent commands do.

### 4.1 Per-connection routes and the `/connect/call` dual mode

`POST /connect/tools {connection}` lists a single connection's actions with
their `enabled` state (`routes:1112-1153`). `POST /connect/call` is
dual-mode (`…:1166-1246`): with `tool`/`arguments` it is a named tool call;
otherwise `{connection, method, path, query?, headers?}` is the legacy
provider-relative GET, recorded with tool name
`"<connection>:<METHOD> <path>"` (`…:1215`). Both branches write a
`tool.called` receipt and, on success, a `tool.observed` receipt, awaited
"rather than fired and forgotten: a serverless request can be frozen the moment
it responds" (`…:1179-1184`).

Since `0a58ac52`, an execution route reached with a token that lacks
`connect:credential` no longer returns a bare `unauthorized`. If the token is
valid for `connect:read` it gets
`403 {"error":"Receipt could not authorize this task to use the connection. This is a task permission problem; reconnecting the account will not fix it.","code":"receipt_connect_execution_scope_missing","retryable":false,"reconnectRequired":false}`;
otherwise
`401 {"error":"Receipt could not authenticate this task. Its runtime access token must be renewed before retrying.","code":"receipt_connect_runtime_authentication_required",…}`
(`…:701-722`, applied at `:1118` and `:1161`; test at
`receipt-connect-routes.test.ts:1221`). The MCP route still returns the bare
`unauthorized` (`…:865`).

---

## 5. All `/connect/*` routes at HEAD

Registered by `registerReceiptConnectRoutes` (`receipt-connect-routes.ts:759`).
Auth is a Receipt Connect JWT as `Authorization: Bearer …` or header
`x-receipt-connect-token`; query-string tokens are rejected (`…:674-699`;
test "rejects query-token auth and enforces route scopes",
`receipt-connect-routes.test.ts:1499`). "Membership" means
`hasCurrentWorkspaceMembership` on the token's `ws_id`; "mutation" means
`hasWorkspaceMutationAuthority`.

| Route | Method | Scope | Extra check | Purpose | Line |
| --- | --- | --- | --- | --- | --- |
| `/connect/mcp` | POST | `connect:credential` | membership | Aggregate MCP JSON-RPC | 859 |
| `/connect/workspaces` | GET | `connect:read` | — | List workspaces + `currentWorkspaceId` | 931 |
| `/connect/workspaces` | POST | `connect:write` | org owner/admin | Create (201) | 943 |
| `/connect/workspaces/:id` | PATCH | `connect:write` | mutation | Rename | 961 |
| `/connect/workspaces/:id` | DELETE | `connect:write` | mutation | Delete | 981 |
| `/connect/workspaces/:id/token` | POST | `connect:read` | membership of `:id` | Mint a workspace-bound JWT with the caller's scopes | 999 |
| `/connect/workspaces/:id/members` | GET | `connect:read` | mutation (inside service) | Active members + pending invites | 1023 |
| `/connect/workspaces/:id/members/:userId` | PUT | `connect:write` | (service) | Set role `owner|admin|member` | 1038 |
| `/connect/workspaces/:id/members/:userId` | DELETE | `connect:write` | (service) | Revoke | 1055 |
| `/connect/agent/connections` | GET | `connect:read` | membership | Only `nango-reference` + `valid`, fields `id, provider, name, status` | 1069 |
| `/connect/tools` | POST | `connect:credential` | membership | One connection's actions | 1112 |
| `/connect/call` | POST | `connect:credential` | membership | Named tool call or legacy GET; writes receipts | 1155 |
| `/connect/capabilities` | GET | `connect:read` | membership | Capability manifest; background read repair | 1272 |
| `/connect/connectors` | GET | `connect:read` | membership | Catalog joined with live Nango integrations | 1310 |
| `/connect/connections` | GET | `connect:read` | membership | Stored connections after awaited read repair | 1434 |
| `/connect/connections/:id` | DELETE | `connect:write` | membership + mutation | Delete in Nango, then locally; `502 integration_connection_delete_failed` | 1466 |
| `/connect/connections/:id/actions` | GET | `connect:read` | membership; `canEdit` from mutation | Tool allowlist | 1514 |
| `/connect/connections/:id/actions` | PATCH | `connect:write` | membership + mutation | Save allowlist (≤200 names) | 1555 |
| `/connect/connections/:id/repositories` | GET | `connect:read` | membership | GitHub repo policy | 1614 |
| `/connect/connections/:id/repositories` | PATCH | `connect:write` | membership + mutation | Save repo policy (≤1000 ids) | 1654 |
| `/connect/nango/health` | GET | `connect:read` | membership | `{ok, status, reachable}` | 1716 |
| `/connect/nango/sessions` | POST | `connect:write` | membership + mutation | Create Connect/reconnect session | 1750 |
| `/connect/nango/webhook` | POST | none (HMAC) | — | Auth creation/override/refresh-failure | 1925 |
| `/connect/credential/:provider` | POST | `connect:credential` | membership | Materialize a CLI credential bundle | 2024 |
| `/connect/credential/github/import` | POST | `connect:write` | membership | Store a GitHub token | 2200 |
| `/connect/credential/aws/import` | POST | `connect:write` | membership | Store an AWS credential_process bundle | 2277 |

Generic failures: `503 receipt_connect_storage_unavailable`,
`503 receipt_workspace_unavailable`, `502 integration_request_failed`,
`400 "Malformed JSON body"`, `400 "Request body must be a JSON object"`
(`…:109-121`, `:920-929`, `:1105-1108`, `:1151`).

The CLI login endpoint lives in the web app, not the runtime:
`GET|POST /api/receipt-connect/cli-login`
(`apps/start/src/routes/api/receipt-connect/cli-login/route.tsx:270`).

---

## 6. Authentication

### 6.1 The Receipt Connect JWT

HS256; claims `iss:"receipt"`, `aud:"receipt-connect"`, `sub` (user id),
optional `sid` (Better Auth session id), `org_id`, `ws_id`, `scp[]`, `iat`,
`exp`, `jti` (`packages/receipt-app/src/services/receipt-connect-auth-token.ts:6-17`).
Scopes `connect:read`, `connect:write`, `connect:credential` (`…:19-22`);
when a caller passes no scopes the default is **all three** (`…:30-34`,
`:59-67`). Default TTL 12 h, minimum 60 s (`…:24`, `:157`). `ws_id` defaults to
the org's Default workspace when omitted (`…:98-99`, `:164`). Verification
checks signature (timing-safe), header `alg/typ`, claim shape, and `exp <= now`
(`…:176-217`). **No revocation**: `jti` is minted (`…:168`) but never looked up,
and `sid` is decoded but not checked against session state anywhere in the
route layer (`receipt-connect-routes.ts:674-699`). A leaked token is valid
until `exp`.

Token flavours actually minted:

| Issuer | Scopes | TTL | `ws_id` | Anchor |
| --- | --- | --- | --- | --- |
| Web server functions | `connect:read`, `connect:write` | 10 min | org Default, then exchanged for the chosen workspace or Global | `receipt-connect.server.ts:38-41`, `:192-243` |
| CLI device login | `connect:credential`, `connect:read`, `connect:write` | 12 h | org **Default** always | `cli-login/route.tsx:17-21`, `:365-374` |
| `receipt workspace use` | caller's scopes preserved | 12 h | chosen workspace | `receipt-connect-routes.ts:999-1021` |
| Web chat capability probe | `connect:read` | 12 h | **Global** scope | `apps/start/src/lib/backend/chat/services/receipt-chat.service.ts:1230-1236` |
| Slack app capability probe | `connect:read` | 12 h | **Global** scope | `apps/slack/slack-receipt-connect-status.ts:35-47` |
| Teams app capability probe | `connect:read` | 12 h | omitted → **Default** workspace | `apps/teams/teams-runtime.ts:9-17` |
| Factory worker task token | graduated (`connect:read` for discovery; `+credential/+write` when required) | 12 h | task workspace | prior corpus §9.3, unchanged files |

The Teams row is a scope inconsistency worth flagging: web chat and Slack read
Global Integrations, Teams reads the Default workspace.

Because the web token never carries `connect:credential`, the browser session
**cannot** call `/connect/mcp`, `/connect/tools`, `/connect/call`, or
`/connect/credential/*`. Tool execution is reserved to CLI, MCP-bridge, and
sandbox tokens.

### 6.2 Device login (`receipt setup` / `receipt login`)

Server: `apps/start/src/routes/api/receipt-connect/cli-login/route.tsx` and
`packages/receipt-app/src/services/receipt-connect-device-login.ts`.

- `POST {"action":"start_device"}` — per-client-IP rate limit of 10 starts per
  60 s and 3 concurrently pending logins; over limit returns
  `429 {"ok":false,"error":"rate_limited","retryAfter":60}` (`route.tsx:14-16`,
  `:128-146`, `:307-313`). Creates a 32-byte base64url `deviceCode` and an
  8-character user code `XXXX-XXXX` from alphabet
  `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (`device-login.ts:43-45`, `:92-96`),
  both stored only as HMAC hashes in table `receipt_connect_device_login`
  (`…:101-125`). TTL 10 min (`route.tsx:12`). Response
  `{ok, deviceCode, userCode, verificationUri, verificationUriComplete,
  expiresIn, interval:2}` (`…:331-342`). The public origin is the first
  parseable of `RECEIPT_CONNECT_PUBLIC_GATEWAY_URL`,
  `RECEIPT_CONNECT_GATEWAY_URL`, `RECEIPT_SERVICE_GATEWAY_URL`,
  `BETTER_AUTH_URL`, `VITE_BETTER_AUTH_URL`, else forwarded host headers
  (`…:50-88`).
- Browser `GET …?user_code=…` — no session: 302 to `/auth/sign-in?redirect=…`
  (`…:90-100`); session without an active organization: 409 page
  **"Select a workspace first"** / "Receipt Connect credentials are stored at
  the workspace level. Open Receipt, select a workspace, then run the CLI
  command again." (`…:212-225`); approved: 200 page **"Receipt Connect is
  approved"** / "You can return to the terminal. This page can be closed."
  (`…:247-257`); unknown/expired: 404 "This Receipt Connect code is invalid or
  expired." (`…:234-239`); reused: 409 "This Receipt Connect code was already
  used. Run the CLI command again." (`…:240-245`).
- `POST {"action":"poll_device","deviceCode"}` — `428 authorization_pending`
  while waiting, `400 expired_token` when expired or consumed, else
  `{ok, token, userId, userEmail, organizationId, workspaceId, workspaceName:"Default"}`
  and the row is consumed (single use, `device-login.ts:342-351`). The token is
  never placed in a URL or rendered in HTML (`route.tsx:260-269`).

Client (`packages/receipt-app/src/services/receipt-connect-cli-login.ts`):
prints `Starting Receipt Connect sign-in at <authUrl>...`, then
`Step 1 of 2: sign in to Receipt` / `  Open: <url>` / `  Code: XXXX-XXXX` /
`  Approve the CLI from the workspace that should own these connections.`
(`…:87`, `:105-112`), opens the browser unless `RECEIPT_CONNECT_OPEN_BROWSER=0`
(`…:18-32`), polls every 2 s for up to 10 min, then prints
`Receipt sign-in approved.` (`…:141`).

### 6.3 CLI session file and target selection

Session shape `{kind:"receipt.cli-session", schemaVersion:1, target,
gatewayUrl, authUrl, token, userId?, userEmail?, organizationId, workspaceId?,
workspaceName?, savedAt}` (`packages/receipt-app/src/services/receipt-cli-session.ts:8-21`),
written mode 0600 to `~/.receipt/session.json` (override
`RECEIPT_CLI_CONFIG_DIR` / `RECEIPT_CLI_SESSION_FILE`) plus a per-target copy
`session.<prod|dev|local>.json` (`…:39-65`). New since `41baea75`
(`3c52d87c`): `activateReceiptCliSession` makes a reused target session the
active one; `isReceiptCliSessionExpired` decodes the JWT `exp` so an expired
session is never reused; `receipt logout` deletes the session; `receipt doctor`
probes `<gateway>/health` (falling back to `/healthz`) and
`<auth>/api/receipt-connect/cli-login` without signing in and prints
`receipt doctor: ok|attention needed`, `target:`, `gateway:`, `sign-in:`,
`mcp: <gateway>/connect/mcp`, `session:` and `Next steps:` lines
(`connect-cli.ts:920-1072`).

Endpoint resolution (`receipt-connect-command-proxy.ts:545-630`): targets
`prod` (default), `dev`, `local`, or an explicit URL; invalid target errors
`"receipt connect target must be prod, dev, local, or an http(s) URL"`
(`…:553`). `local` defaults to `http://127.0.0.1:8787` (gateway) and
`http://127.0.0.1:3000` (auth) (`…:573`, `:578`). Release binaries bake the
hosted origin in with `bun build --define RECEIPT_CLI_DEFAULT_PROD_GATEWAY_URL`
(`…:56-73`; `scripts/build-receipt-cli-release.sh:9`, `:106-107`); built from
source the prod target still requires `RECEIPT_CONNECT_PUBLIC_GATEWAY_URL`,
failing with `"receipt connect production URL is not configured yet. Set
RECEIPT_CONNECT_PUBLIC_GATEWAY_URL=https://app.kentron.ai and re-run, or set
RECEIPT_CONNECT_PROD_GATEWAY_URL, RECEIPT_CONNECT_PROD_URL, or
RECEIPT_CONNECT_URL."` (`…:615-616`).

### 6.4 How MCP clients authenticate, and which are supported

- **Stdio bridge (`receipt mcp serve`)** reads the saved session at start
  (env fallback `RECEIPT_CONNECT_GATEWAY_URL` + `RECEIPT_CONNECT_TOKEN` +
  `RECEIPT_CONNECT_ORGANIZATION_ID` is allowed only for `serve` and `tools`,
  `receipt-mcp-cli.ts:79-127`, `:645`), then relays each stdin JSON-RPC line to
  `POST <gateway>/connect/mcp` with `Authorization: Bearer <session token>`,
  `Accept: application/json, text/event-stream`, 35 s timeout, forwarding any
  `Mcp-Session-Id` (`…:351-398`, `:582-629`). Notifications never get a
  response; other failures become `{"jsonrpc":"2.0","id":…,"error":{"code":-32603,…}}`.
  Not signed in: `receipt mcp: not signed in; run 'receipt setup' first`
  (`…:121`; the hint changed from `receipt login` since `41baea75`).
- **Remote `/connect/mcp`** needs a bearer JWT with `connect:credential`.
  There is no OAuth authorization server, no protected-resource metadata, and
  no dynamic client registration; the product plan lists "remote MCP
  OAuth/RFC 9728 metadata" as follow-on work
  (`docs/receipt-cli-mcp-implementation-plan.md:172-178`;
  `docs/receipt-authorization-mcp-product-plan.md:1523-1552`). A client that
  can only do OAuth (ChatGPT connectors) or no-auth cannot be attached.
- **Client support matrix** (`receipt-mcp-cli.ts:631-778`):

| Client | `config` | `install` / `status` / `remove` | Class |
| --- | --- | --- | --- |
| Codex | TOML `[mcp_servers."receipt"]` with `command`/`args = [..., "mcp", "serve"]` (`…:186-198`) | Yes, via `codex mcp add|get|remove`; `$CODEX_HOME/config.toml` only; backup `<config>.receipt-backup-<ts>` and rollback on failure (`…:244-250`, `:269-288`, `:741-777`) | **Reachable** |
| Any other stdio client (Claude Desktop, Cursor, VS Code, Windsurf…) | `receipt mcp config generic [--json]` → `{kind:"receipt.mcp-client-config", schemaVersion:1, name, transport:"stdio", command, args, remote:{url}, workspace}` (`…:214-230`) | No; error `"receipt mcp install/status/remove currently supports codex; use 'receipt mcp config --client generic' for other clients"` (`…:688-692`) | **Hidden** (manual paste) |
| ChatGPT, hosted remote clients | `remote.url` is informational only | No OAuth surface | **Absent** |

No source file names Cursor, Claude Desktop, or ChatGPT as supported clients
(repo-wide grep of the MCP CLI, MCP server, and gateway UI). Every generated
config is checked by `assertTokenFreeClientConfig`, which refuses to write a
config containing the session token or anything matching
`nango|provider.?secret|authorization.?bearer` (`…:312-327`).

---

## 7. Gateway receipts and the MCP Gateway UI

### 7.1 Receipts

`recordReceiptConnectToolCall` writes a `tool.called` and, on success, a
`tool.observed` event into a per-workspace stream
`receipt-connect/gateway/<orgId>/<workspaceId>` with `agentId: "mcp-gateway"`
and a fresh `runId` `gateway_<base36 time>_<random>` per call
(`packages/receipt-app/src/services/receipt-connect-tool-receipts.ts:19-24`,
`:85-98`). Output is truncated to 2000 chars with a `truncated` flag
(`…:55`, `:110-119`); a failed call gets only `tool.called` with `error`
(`…:105-109`); write failures are logged and swallowed (`…:127-129`); calls
without a workspace id are not recorded at all (`…:67`). As noted in §4, only
`/connect/call` invokes it.

### 7.2 Routes and redirects

All under `/organization/settings/mcp-gateway` (nav constants at
`apps/start/src/routes/(app)/_layout/organization/settings/-organization-settings-nav.ts:48-100`):

| Path | Behaviour | Class |
| --- | --- | --- |
| `/mcp-gateway/` | `McpGatewayLandingPage` | Reachable |
| `/mcp-gateway/dashboard` | **Redirect** to `/organization/settings/workspaces`; comment: "there is no organization-level dashboard: with no workspace open the page could not say which workspace its figures described" (`dashboard.tsx`) | Hidden (redirect only) |
| `/mcp-gateway/integrations/` | **Redirect** to the current/default/first workspace's Overview `?tab=apps#workspace-tools`, else the workspace list (`integrations/index.tsx`) | Hidden |
| `/mcp-gateway/workspace/` | **Redirect** to the landing page | Hidden |
| `/mcp-gateway/workspace/$workspaceId/` | **Redirect** to `…/overview` | Hidden |
| `…/$workspaceId/overview` | `McpGatewayWorkspacePage`; `tab ∈ {apps, llm-keys, settings}` | Reachable |
| `…/$workspaceId/connections` | **Redirect** to Overview with the tab preserved | Hidden |
| `…/$workspaceId/settings` | **Redirect** to Overview `?tab=settings` | Hidden |
| `…/$workspaceId/activity` | `McpGatewayActivityPage` | Hidden (no nav link; breadcrumb label only) |
| `…/$workspaceId/dashboard` | `McpGatewayDashboardPage`; `tab ∈ {dashboard, users, team-usage}`, `range ∈ {24h, 7d, 30d}` | Reachable (tab in the workspace strip) |

The workspace id is a path param so a refresh, back button, or shared link
restores the page (`workspace/$workspaceId/route.tsx`). An unknown id renders
**"Workspace not found"** / "This workspace does not exist, or you no longer
have access to it." / "Pick a workspace from the MCP Gateway to continue." /
link **Back to MCP Gateway** (`active-workspace-from-path.tsx:37-52`). While
the context catches up it shows "Loading workspace…" (`…:68`).

Sidebar (`apps/start/src/components/mcp-gateway/mcp-gateway-nav.config.tsx:35-82`):
the **MCP Gateway** area's href points at Workspaces ("MCP Gateway is a
grouping, not a page"); at gateway level it lists only **Workspaces**; inside a
workspace it lists only **All workspaces**. The settings nav entry for the
gateway is `hiddenFromRail` and `hiddenFromMenu` (`-organization-settings-nav.ts:158-180`);
**Integrations** is its own rail destination (`…:186-197`); **Workspaces** is
a menu item only (`…:206-212`). Breadcrumb: `All workspaces › <workspace> ›
<tab>` with tab labels Overview / Integrations / Activity / Dashboard /
Workspace settings (`workspace-breadcrumb.tsx:12-18`, `:45`).

### 7.3 Landing page ("MCP Gateway")

`mcp-gateway-landing-page.tsx`: title **"MCP Gateway"**, description "Set up an
MCP client against this organization, then open a workspace to manage its
isolated connections, keys, permissions, and activity." (`:106-108`). Then the
shared setup panel, then section **"Workspaces"** / "Each workspace has its
own connections, LLM keys, permissions, and activity. Open one to manage it."
with button **"New workspace"** (`:121-139`). States: "Loading workspaces…",
"No workspaces yet. Create one to get started." (`:144-149`). Create dialog:
**"Create workspace"** / "Workspace names help people choose the correct
authorization boundary." / label **"Workspace name"** (max 80) / **Cancel** /
**Create workspace** ("Creating…") / error "Enter a workspace name." / toast
"<name> workspace created." then navigates into the workspace (`:75`, `:82-91`,
`:185-238`). The table on this page carries a **View details** action (new in
`46652e84`) but no Rename/Delete.

### 7.4 Setup panel (shared)

`mcp-gateway-setup-panel.tsx`: heading **"Use connections with Receipt CLI and
MCP clients"**; body "Receipt CLI and the local MCP bridge use a workspace-bound
token. The selected workspace is **<name>**; its connections and permissions
are isolated from other workspaces in this organization." (`:94-106`); badge
**"Default workspace"** or **"Workspace scoped"** (`:110-112`). Six numbered
commands, each with a **Copy**/**Copied** button (`:18-52`, `:162`):

1. Sign in and set up the Receipt CLI — `receipt setup` (new since `41baea75`;
   comment: the list "used to open at `mcp install`, which fails on a machine
   that has never run `receipt setup`")
2. Install the Codex MCP bridge — `receipt mcp install codex`
3. Preview Codex MCP configuration — `receipt mcp config codex`
4. Check the installed bridge — `receipt mcp status codex` *(optional)*
5. Confirm the active organization workspace — `receipt workspace current`
6. List available tools — `receipt tools list` *(optional)*

Copy failure toast: "Could not copy the command. Select and copy it instead."
(`:74`).

Note the mismatch the panel does not mention: device login always binds the
CLI to the **Default** workspace, so a user who opens a named workspace here
and follows the six commands still lands in Default until they run
`receipt workspace use <name>`, which the panel does not list.

### 7.5 Workspace Overview

`mcp-gateway-workspace-page.tsx`: title **"Overview"**, description
"Connections, LLM keys, and access for <workspace>." (`:150-151`). Three tiles,
each a link to a tab (`:125-144`): **Open integrations** = distinct providers
with a `valid` connection (`:113-117`); **LLM keys** = configured BYOK
providers; **Your access** = effective role. One tab strip labelled
"Workspace tools" (`:58`, new shared `TabList` from `46652e84`):
**Open integrations** (`tab=apps` → `<IntegrationsPage scope="workspace" embedded />`),
**LLM keys** (BYOK form), **Settings** (`McpGatewaySettingsPage embedded`), and
a fourth tab **Dashboard** that navigates to the dashboard route (`:37-41`,
`:76-88`, `:199-215`).

### 7.6 Settings tab (members and sharing)

`mcp-gateway-settings-page.tsx` (standalone title **"Workspace settings"** /
"Who can use this workspace.", `:443-444`). For owners/admins a section
**"Share workspace"** / "Give someone in your organization access to this
workspace." with button **Share workspace** (`:218-231`). Section **"Members"**
with "1 person can use this workspace." / "<n> people can use this workspace."
(`:240-246`), search placeholder **"Search members"** (`:258`), "Loading
members…", "Nobody has been given access yet." (`:265-270`), columns
**Member / Role / Actions** (`:277-280`), role badges, and, new in `c3c16be6`,
a **Pending** badge for unaccepted invitations with a **Cancel invitation**
action (`:314-321`, `:376-384`; toast "Invitation to <email> cancelled." /
"Invitation could not be cancelled.", `:192-195`). **Remove from workspace** is
disabled on yourself ("You cannot remove your own access.") and on Default
("Default membership follows the organization.") (`:386-399`); success toast
"<email> no longer has access." (`:161`).

Share dialog (`workspace-share-dialog.tsx`): **"Share workspace"** / "Send an
invitation to your workspace." (`:177-180`), label **Email address**,
placeholder `teammate@company.com`, **Add another** (max 5), **Done** /
**Send invitation** (`:190-306`). Two invitation paths: an existing org member
gets a workspace-only invitation; a new person gets a Better Auth org
invitation carrying `workspaceId` (`:37-45`; `workspace-share-invitation.ts`).
Toasts: "Invitation email sent. Workspace access is granted after acceptance."
/ "<n> invitation emails sent…" / "Invitation created. Copy the link below."
(self-hosted, no mail) (`:158-166`); "Invitation link copied." (`:276`);
per-row error "<email>: already has access to this workspace." (`:91`, `:100`).
Pending invitations count as **shared** in the workspace table
(`receipt-workspaces.ts:924-947`).

### 7.7 Workspace table and details (Workspaces page and landing page)

`mcp-gateway-workspace-table.tsx`: columns **# / Workspace / Sharing and tools /
Updated** (+ **Actions**) (`:104-118`); Created is no longer a column
(`46652e84`). Sharing icon appears when shared (aria "<name> is shared"), wrench
when the workspace has any connection (aria "<name> has tools enabled")
(`:194-215`); note `RECEIPT_WORKSPACE_HAS_TOOLS_SQL` now tests connection
existence, not an enabled policy, because the policy lives in Nango metadata
(`receipt-workspaces.ts:949-968`). Row menu: **View details**, **Rename**,
**Share**, **Delete** (Default: tooltip "The Default workspace cannot be
deleted.") (`:253-297`). Empty: "No workspaces yet." / "No workspace matches
this search." (`:125-126`).

`workspace-details-dialog.tsx` (new in `46652e84`): description "How this
authorization boundary was set up and what it currently exposes." (`:74-77`);
badges Active / Default / role; rows **Created by** ("Created with the
organization" for Default, "No creator recorded" when unresolved), **Created**,
**Last updated**, **Sharing** ("Shared with other members" / "Only you have
access"), **Tools** ("Publishing tools to agents" / "No tools enabled"),
**Workspace ID** (`:91-136`). The creator comes from a new
`LEFT JOIN "user" creator` in the list query (`receipt-workspaces.ts:979-980`,
`:1003-1012`).

The org-level **Workspaces** settings page (`workspaces-page.tsx`): title
**"Workspaces"** / "Isolate connected accounts, action permissions, CLI
sessions, and MCP tools inside your organization." (`:250-251`), search
"Search workspaces", dialogs **Create workspace / Rename workspace / Delete
workspace**, delete confirmation "Type Delete to confirm" with buttons
**Continue to delete** then **Delete workspace permanently** (`:353-453`);
toasts "<name> workspace created.", "Workspace renamed.", "<name> workspace
deleted." (`:215-231`). Server rules: delete refuses Default and refuses a
workspace with connections (`"workspace connections must be removed before
deleting the workspace"`, `receipt-workspaces.ts:114-118`, `:1625-1630`);
duplicate names fail `409 "a workspace with this name already exists"`
(`…:1508`, `:1575`).

### 7.8 Activity page

`mcp-gateway-activity-page.tsx`: title **"Activity"** / "Connection lifecycle
events visible only in the selected workspace." (`:28-29`); section **"Recent
activity"** with the caveat "Tool request receipts will appear here when gateway
execution reporting is available. Connection events below are live now."
(`:37-40`); rows `provider · name` / "Connection status: <status>" / updated
time; empty "No activity in this workspace yet." (`:50-64`). Data is the Zero
replicated connection list, not receipts. **Class: Hidden** (no nav link) and
partly **Inert** (its own copy says tool receipts are not shown).

### 7.9 Dashboard ("Gateway activity")

`mcp-gateway-dashboard-page.tsx`: title **"Gateway activity"** (`:252`);
in a workspace the description is "Live view of this workspace's MCP tool
activity, derived from execution receipts. Counts calls attributable to this
workspace's connected applications." (`:261`); the org-wide description
(`:262`) is unreachable since the org route redirects. Controls: "Last updated
<time>" / "Loading activity…", range select **Last 24 hours / Last 7 days /
Last 30 days**, **Refresh** (`:266-310`;
`apps/start/src/lib/frontend/mcp-gateway/mcp-gateway-activity.ts:21-25`).
Errors: "Gateway activity could not be loaded.", "Loading gateway activity…",
"Sign in to an organization to see gateway activity." (`:225`, `:322`, `:326`).

Tabs (`:80-84`): **Dashboard** — tiles **Total calls / Success rate / Avg
response time / Active actors** with deltas vs the preceding window (delta
label "No prior data to compare" when absent, `mcp-gateway-dashboard-parts.tsx:113`);
panel **"Activity timeline"** ("Calls per hour" / "Calls per six hours" /
"Calls per day"; empty "No calls in this period."); panel **"Activity log"** /
"Tools enabled or disabled on this workspace's connected applications."
(`:363-481`). **Users** — tiles **Requests / Total tokens used / Total spend**
each sub-labelled "Across the organization" because those come from the
org-keyed job projection, not receipts (`:556-580`); table **User / Requests /
Tools used / Failed / Last seen**; empty "No one has used this gateway yet.
People and agents appear here once they make a request." (`:587-598`).
**Live activity** — search "Search tool, connector, or actor…", status filter
**All statuses / Succeeded / Failed / Running**, "<n> of <m> calls", table
**Request / Connector / Status / Duration / Actions**, row menu with
**Created** and **Tool**; empty "No gateway entries found. Agent activity will
appear here as your team makes requests." / "No requests match these filters."
(`:680-801`).

Metrics semantics (`mcp-gateway-activity.ts`): success rate is over settled
calls only and is `undefined` rather than 0 when nothing settled (`:108-118`);
a `tool.called` with no error and no `tool.observed` is "Running"; bucket
sizes 1 h / 6 h / 24 h (`:135-140`). The server loader fetches up to 5000
`tool.called` and 5000 `tool.observed` events, merges by `globalSeq`, and
attributes by the receipt's `workspaceId` when present, else by resolving the
tool name against the workspace's connections using the patterns
`receipt_<provider>_<name>_<op>`, `<provider>__<name>__<op>`, and
`mcp__<server>__<tool>` (`mcp-gateway-activity.server.ts:83-123`, `:306-316`,
`:346-355`).

Admin activity table (`mcp-gateway-admin-activity.tsx:40-60`): actions map to
Type/Status pairs — `tool.enabled`→Tool/Enabled, `tool.disabled`→Tool/Disabled,
`connection.created`→Integration/Connected, `connection.removed`→
Integration/Disconnected, `member.invited`→Member/Invited,
`member.removed`→Member/Removed, `workspace.created`→Workspace/Created,
`workspace.removed`→Workspace/Removed. Search "Search tool or app"; empty "No
tool or integration changes recorded yet. Enabling a tool or connecting an
integration will appear here." (`:153`, `:178`).

### 7.10 Integrations surface (shared by both scopes)

`integrations-page.tsx` serves two scopes. Organization: route title
**"Global Integrations"** / "Connected once for the whole organization and
available to Receipt chat. Workspace-scoped connections for CLI and MCP clients
live under MCP Gateway." (`apps/start/src/routes/(app)/_layout/organization/settings/integrations/route.tsx:15-16`).
Workspace (embedded): default title **"Integrations"** / "Connect tools to give
Receipt secure context across cloud, workspace, and business systems."
(`integrations-page.tsx:1378-1379`). Controls: search **"Search
integrations"** (`:1181`), category chips **All / Development / Google /
Microsoft / Project Management / Cloud & Data / Communication**
(`integration-category-groups.ts:28-53`), segmented tabs **All / Connected /
Available / Popular** (`:1239-1244`), **Load more** with "<n> remaining"
(`:1335-1338`), empty **"No integrations found"** / "Try a different search or
turn off the connected-only filter." (`:1349-1352`). Card states: connected
cards show **Manage tools** (only when a workspace id is known, `:441-461`)
and **Disconnect**; "1 saved connection needs attention" / "<n> saved
connections need attention" (`:375-376`); not connectable → "Coming soon"
(`:387`). Disconnect dialog **"Disconnect integration?"** / "Disconnect
<provider>/<name>? Receipt will revoke the provider connection and new agent
tasks will immediately lose access to it." / warning "Existing receipts remain
available for audit. This action removes only the selected named connection."
(`:1117-1126`). Banners: "Select an available workspace before managing
integrations. No organization-wide connections are shown as a fallback."
(`:1067-1068`), "<error> Showing the last synced connection state." (`:1155`),
"<error> Connected integrations remain visible, but new connections are
unavailable until the catalog recovers." (`:1160-1161`). Request panel:
"Build <name> with Beetle Tasks" / "New integrations are code changes: Beetle
opens a task…" with **Create task** / **Connect GitHub first** / **GitHub
required** (`:544-582`; legacy internal branding, unchanged). New since
`41baea75` (`20d20f51`): connections named `agent-registry` are filtered out
of this page because Agent Registry scans use their own read-only-scoped
connection (`:242-247`;
`apps/start/src/components/agent-registry/agent-registry-connection-name.ts`).

**Manage tools dialog** (`integration-permissions-dialog.tsx`): title
**"Manage tools and permissions"** / "<Integration> · <connection>. Every
published operation is controlled by this <organization|workspace> allowlist."
(`:229-233`); read-only banner "You can review these permissions. Only
workspace owners and admins can change access." (`:301`); sections **"Read
operations"** / "Enable only the data this workspace is allowed to retrieve." /
"No read operations are published for this connection." (`:337-363`) and
**"Write and delete operations"** / "Fail closed by default. Enable only the
operations this connection should perform." / "No write or delete operations
are published. This is not a grant of unrestricted provider access."
(`:374-414`); switches **Allowed / Never allow** (`:354`); **Save permissions**
("Saving") (`:441`); toasts "Connection permissions saved." / "Connection
permissions could not be saved." / "Connection permissions could not be
loaded." (`:119`, `:209`, `:214`); error state **"Permissions unavailable"**
with **Reconnect integration** or **Retry**, and "Reauthorization is required,
but this catalog entry cannot start a new authorization session from Receipt."
(`:263-290`). GitHub section **"GitHub repositories"** / "Choose which
repositories this connection can use." with popover **All repositories**
("Keep the current connection behavior.") / **Selected repositories** ("Limit
Receipt to the repositories checked below."), search "Search repositories…",
trigger label `All repos` / `Repositories` (`:321`;
`github-repository-selector.tsx:158-159`, `:210-231`, `:250`).

---

## 8. Global Integrations vs workspace connections

| Reader | Scope read | Anchor |
| --- | --- | --- |
| Organization Settings → Integrations (web) | **Global** (`ws_global_<md5>`), resolved server-side; the browser never picks the id | `receipt-connect.server.ts:536`, `:720-725`, `:743` |
| Web chat capability preflight | **Global** | `receipt-chat.service.ts:1214-1248` |
| Slack app | **Global** | `apps/slack/slack-receipt-connect-status.ts:35-47`; `apps/slack/server.ts:292` |
| Teams app | **Default** workspace (no `workspaceId` passed) | `apps/teams/teams-runtime.ts:11` + `receipt-connect-auth-token.ts:164` |
| MCP Gateway → workspace → Open integrations (web) | that workspace | `mcp-gateway-workspace-page.tsx:199-200` |
| CLI (`receipt tools`, `receipt connect list/tools/call`, `receipt mcp serve`) | the workspace bound into the session token (Default after login; changed only by `receipt workspace use`) | `cli-login/route.tsx:365-374`; `receipt-workspace-cli.ts:175-180` |
| Factory sandbox worker | the task's workspace | prior corpus §9.3 |
| Legacy Nango rows with only an `organization_id` tag | read-repaired into **Global** | `receipt-connect-nango-sync.ts:300-307` |

Consequence for docs: connecting GitHub on the Integrations page makes it
available to chat and Slack, but `receipt tools list` will not show it until
the same provider is connected inside the workspace the CLI is bound to. The
"Open integrations" tile on a workspace Overview counts only that workspace.

---

## 9. Workspace management summary

- **Create**: org owner/admin only; every org owner/admin becomes a member with
  their org role; `POST /connect/workspaces` returns 201; name max 80 in the UI.
- **Rename**: workspace owner/admin or org admin; slug uniqueness enforced;
  `403 "workspace owner or admin permission is required"` (`receipt-workspaces.ts:1568-1570`).
- **Share**: owners/admins; invitations are receipts in the workspace stream
  (`workspace.member.invited`) or Better Auth org invitations; pending invites
  now appear in the members list with a **Pending** badge and can be cancelled
  (`c3c16be6`; `receipt-workspaces.ts:1240-1292`).
- **Delete**: refuses Default and any workspace that still has connections.
- **Roles**: `owner | admin | member`; PUT member accepts only those, anything
  else becomes `member` (`receipt-connect-routes.ts:1043`).
- **Zero-exposed columns**: `receipt_workspace` exposes `id, organizationId,
  name, slug, isDefault, stream, receiptRefs, createdAt, updatedAt`;
  `receipt_workspace_member` exposes `workspaceId, organizationId, userId,
  role, stream, receiptRefs, createdAt, updatedAt`; `org_connection_secret`
  exposes `id, organizationId, workspaceId, provider, name, kind, status,
  expiresAt, lastValidatedAt, createdAt, updatedAt` — no ciphertext, no
  metadata (`apps/start/src/integrations/zero/schema.ts:90-139`). The
  connections query additionally requires the reader to be a member of the
  workspace (`apps/start/src/integrations/zero/queries/receipt-connect.queries.ts:23-36`).
- **Never exposed to browsers**: ciphertext/iv/auth_tag, `metadata_json`,
  `created_by_user_id` (on connections), Nango ids, the Nango secret key, the
  connection encryption key, `RECEIPT_INTEGRATIONS_DATABASE_URL`, any JWT
  (server functions mint and consume tokens server-side).

---

## 10. Security model summary

**What the MCP/tool path guarantees.** Provider credentials stay in Nango and
are injected by Nango Proxy server-side; MCP client configs are token-free by
construction; the sandbox worker receives helper scripts and a JWT, never
provider keys; writes require both token scope and an explicit allowlist;
aliases cannot be forged across organizations or workspaces. All verified above.

**What a stolen CLI session token can do.** `~/.receipt/session.json` holds a
12-hour JWT with `connect:credential`, `connect:read`, `connect:write`, bound to
one workspace. Until `exp`, its holder can list and call every tool that
workspace's policy enables (including writes), and — this is the part the
"scoped passes" framing must not hide — call
`POST /connect/credential/<provider>` for any connected catalog connector in
that workspace. That route fetches the Nango connection record and returns it
with its `credentials` object intact
(`receipt-connect-routes.ts:2116-2129`, `:2178-2182`;
`receipt-connect-nango-connection.ts:158-185`;
`receipt-connect-connectors.ts:250-271`), which for AWS is a
`credential_process` bundle and for an OAuth connector is the access token.
There is no revocation short of rotating `RECEIPT_CONNECT_JWT_SECRET` /
`BETTER_AUTH_SECRET` (which invalidates every token) or disconnecting the
provider connection. `receipt logout` deletes the local file only.

**What a stolen web session cannot do.** Web tokens never carry
`connect:credential`, so a browser session can manage connections and policy
but cannot execute tools or materialize credentials.

**What a stolen server `.env` can do.** It is not worthless:
`RECEIPT_CONNECT_JWT_SECRET`/`BETTER_AUTH_SECRET` lets an attacker mint any
token; `RECEIPT_INTEGRATIONS_SECRET_KEY` is the Nango environment key that
reads every connection's credentials directly from Nango;
`RECEIPT_CONNECTION_ENCRYPTION_KEY_B64` decrypts the two credential-import
kinds. The accurate narrow claim is: an **agent's** environment, an MCP client
config, and a sandbox's `.env` contain no provider credentials.

**Where raw credentials live.** Nango (all `nango-reference` rows); Receipt's
`org_connection_secret` for the two import kinds `aws-credential-process` and
`github-token`; transiently in a sandbox's `mktemp` file under `umask 077`
when a credential helper runs (prior corpus §9.4; those files are unchanged
since `41baea75`).

---

## 11. Request/response flow (for diagrams)

```text
MCP client (Codex)                      receipt CLI                     Receipt runtime                      Nango / provider
-----------------                      -----------                     ---------------                      ----------------
stdio JSON-RPC line  ───────────────▶  receipt mcp serve
                                       reads ~/.receipt/session.json (0600)
                                       POST /connect/mcp  Bearer <JWT>  ──▶  authorizeReceiptConnectRequest
                                                                             scope connect:credential
                                                                             hasCurrentWorkspaceMembership(ws_id)
                                       tools/list                            composeReceiptConnectMcpTools
                                                                               listReceiptConnectConnections(org, ws)  [valid nango-reference only]
                                                                               per connection: listReceiptConnectTools ──▶ GET /connections/{id} (policy metadata)
                                                                               reviewedStaticToolNames  ∩  policy  ∩  (read | connect:write)
                                                                               alias = receipt_<p>_<n>_<t>_<sha256[:20]>
                                       tools/call {name, arguments}           binding lookup (recomposed)  ──▶ callReceiptConnectTool
                                                                               validate args ▸ resolve connection ▸ read policy ▸ access class
                                                                               typed-proxy: POST <nango>/proxy<path> (Base-Url-Override, Retries)
                                                                               compat: GET-only path parser ▸ Nango Proxy
                                                                               atlassian: /oauth/token/accessible-resources ▸ /ex/<product>/<cloudId>
                                                                               github: repository policy filter
                                                                               ◀── provider response (≤5 MiB, 30 s)
                                       ◀── {content:[text], structuredContent?, isError}
                                       (no gateway receipt on this path)

receipt tools call --connection / receipt connect call / sandbox worker
                                       POST /connect/call  Bearer <JWT>  ──▶  same policy chain
                                                                             recordReceiptConnectToolCall → stream receipt-connect/gateway/<org>/<ws>
                                                                               tool.called (+ tool.observed on success, output ≤2000 chars)
                                                                             ◀── result
Dashboard (web)                        server fn getMcpGatewayActivity ──▶  reads tool.called/tool.observed (≤5000 each), attributes by workspaceId
```

Connection creation:

```text
Web Integrations page ── server fn ── 10-min web JWT (read,write) ── POST /connect/workspaces/<ws|global>/token ── workspace JWT
   ── POST /connect/nango/sessions {provider} ── Nango /connect/sessions (tags org, ws, user, connection_name)
   ── iframe Connect UI ── provider OAuth ── Nango webhook (HMAC) ── POST /connect/nango/webhook ── upsert org_connection_secret (encrypted ref)
   ── UI polls /connect/connections (2 min) and Zero replicates the non-secret row
```

---

## 12. Troubleshooting: user-visible errors

| Where | Exact string | Cause | Fix |
| --- | --- | --- | --- |
| CLI | `receipt connect production URL is not configured yet. Set RECEIPT_CONNECT_PUBLIC_GATEWAY_URL=https://app.kentron.ai and re-run, or set RECEIPT_CONNECT_PROD_GATEWAY_URL, RECEIPT_CONNECT_PROD_URL, or RECEIPT_CONNECT_URL.` | Running from source, or a pre-`preview.7` binary without a baked origin | Set the variable or install a release with the baked origin (`receipt-connect-command-proxy.ts:615-616`; `docs/receipt-cli.md:22-33`) |
| CLI | `receipt connect target must be prod, dev, local, or an http(s) URL` | Bad positional target | Use a listed target or URL |
| CLI | `receipt connect device login failed to start: rate_limited` | >10 starts/min or 3 pending from one IP | Wait 60 s (`cli-login/route.tsx:307-313`) |
| CLI | `receipt connect device login failed to start: receipt_connect_storage_unavailable` | Web app cannot reach Postgres | Check the web tier's database |
| CLI | `receipt connect device login failed to start: http_404` | `--auth-url` is not the web app origin | Point auth URL at the app, gateway URL at the runtime |
| CLI | `receipt connect device login expired` / `receipt connect device login timed out` | Approval not completed in 10 min | Re-run and approve |
| CLI | `receipt connect login did not return a workspace; select a Receipt workspace and try again` | Approved with no active organization | Select an organization in the app, retry |
| Browser | "Select a workspace first" (409) | Session has no active organization | Open Receipt, pick an organization |
| Browser | "This Receipt Connect code is invalid or expired." / "This Receipt Connect code was already used. Run the CLI command again." | Typo, expiry, or reuse | Re-run the CLI command |
| CLI | `receipt mcp: not signed in; run 'receipt setup' first` / `receipt workspace: not signed in; run 'receipt setup' first` | No session file | `receipt setup` |
| CLI | `Receipt Connect gateway is unavailable; run 'receipt setup' or set RECEIPT_CONNECT_TOKEN` / `Receipt Connect task token is unavailable; …` | `connect list/tools/call` with no session and no env | `receipt setup` or export the env pair (`receipt-connect-agent-cli.ts:191-200`) |
| CLI | `Saved Receipt session was rejected by the gateway; signing in again.` | 401 on a saved token (rotated secret, expiry) | Automatic re-login (`connect-cli.ts:1198-1205`) |
| CLI | `Saved session expired at <iso>; run 'receipt setup' to sign in again.` (doctor) | 12-h JWT elapsed | `receipt setup` |
| CLI | `receipt mcp install/status/remove currently supports codex; use 'receipt mcp config --client generic' for other clients` | Non-Codex client | Paste the generic config manually |
| CLI | `Codex MCP server 'receipt' is already installed; remove it first` | Re-install | `receipt mcp remove codex` |
| CLI | `Codex does not accept an arbitrary config path; expected <path>. Set CODEX_HOME before running Receipt if Codex uses another home.` | `--client-config` differs | Set `CODEX_HOME` |
| CLI | `codex mcp install failed and the prior config was restored: …` / `codex did not report the installed Receipt MCP server; the prior config was restored` / `codex still reports the Receipt MCP server after removal; the prior config was restored` / `codex did not create its expected config: <path>` | `codex` binary failure | Check `codex` on PATH; config was rolled back |
| CLI | `refusing to install an MCP client config containing the Receipt session token` / `…containing credential material` | Config would embed a secret | Never happens with generated config; indicates tampering |
| CLI | `workspace '<x>' is ambiguous; use its id` / `workspace '<x>' was not found` / `refusing to persist a workspace from another organization` | `receipt workspace use` selector problems | Use the id |
| CLI | `receipt tools describe requires a tool name` / `receipt tools call requires a tool name` / `Receipt tool '<name>' was not found` / `receipt tools supports list, describe, and call` / `receipt mcp supports config, install, status, remove, and serve` | Usage | — |
| CLI | `receipt connect call is read-only and supports GET only` / `receipt connect call requires --path beginning with /` / `receipt connect <tools|call> requires a connection id or provider:name` | Legacy path form misuse | Use `--path /…` or a named tool |
| Gateway | `401 unauthorized` | Missing/invalid/expired JWT, or wrong scope on non-execution routes | Re-login; check scope |
| Gateway | `403 workspace_membership_required` | Token's `ws_id` not a workspace the user belongs to, or mutation authority missing | `receipt workspace use` a workspace you belong to; ask an owner/admin |
| Gateway | `403 receipt_connect_execution_scope_missing` "…This is a task permission problem; reconnecting the account will not fix it." | Token has `connect:read` but not `connect:credential` on `/connect/tools` or `/connect/call` | Use a CLI/sandbox token, not a web token |
| Gateway | `401 receipt_connect_runtime_authentication_required` "…Its runtime access token must be renewed before retrying." | Expired task token on an execution route | Re-mint the token |
| Gateway | `409 receipt_connect_reauthorization_required` "Your <Label> connection is no longer valid. Open Organization Settings > Integrations, reconnect <Label>, then retry." | Provider credential revoked/exhausted | Reconnect (row is marked invalid) |
| Gateway | `No active <Label> connection[ named <n>]. Open Organization Settings > Integrations, connect <Label>, then retry.` | No valid row for provider+name in that workspace | Connect it **in that workspace** |
| Gateway | `<Label> connection named <n> exists as <kind> but is <status>[ at <expiry>]. Open Organization Settings > Integrations and reconnect <Label>, or replace it with an active Nango-backed <Label> connection.` | Row exists but is invalid/expired | Reconnect |
| Gateway | `404 integration action not found or disabled` | Tool unknown or not in the allowlist | Enable it in Manage tools |
| Gateway | `400 integration action '<tool>' requires connect:write` | Write tool with a read-only token | Use a token with `connect:write` |
| Gateway | `400 integration action '<name>' is not available` | Saving an unknown action name | Refresh the dialog |
| Gateway | `403 GitHub repository '<owner/repo>' is not selected for this connection` / `403 this GitHub endpoint is unavailable while selected repositories are enforced` | Repo policy | Select the repo or switch to All repositories |
| Gateway | `409 <Label> connection exposes multiple Atlassian sites; call the explicit /ex/<product>/{cloudId}/... path` / `502 <Label> connection did not expose an accessible Atlassian site` | Multi-site Atlassian grant | Use the explicit path |
| Gateway | `400 Unsupported connector. Use one of: <ids>, or any integration configured in Nango.` | Unknown provider on session create | Use a catalog id |
| Gateway | `… Nango expects an integration unique_key '<id>' for <Label>. Set <RECEIPT_NANGO_*_INTEGRATION_ID> if your Nango integration uses a different unique_key.` | Nango 400 on session create | Set the override or create the integration |
| Gateway | `503 Self-hosted Nango is not configured. Set RECEIPT_INTEGRATIONS_URL, RECEIPT_INTEGRATIONS_SECRET_KEY, and RECEIPT_INTEGRATIONS_WEBHOOK_SECRET.` | Missing env | Configure Nango (web UI shows the friendlier copy in §3.1) |
| Gateway | `401 invalid Nango webhook signature` | HMAC mismatch | Align `RECEIPT_INTEGRATIONS_WEBHOOK_SECRET` with Nango's `hmac_key` |
| Gateway | `502 integration_connection_delete_failed` | Nango refused the delete | Retry; check Nango |
| Gateway | `409 the Default workspace cannot be deleted` / `409 workspace connections must be removed before deleting the workspace` / `409 a workspace with this name already exists` / `403 organization owner or admin permission is required` / `404 workspace not found or unavailable` | Workspace rules | As stated |
| MCP | `-32602 Unknown or unavailable tool` | Alias not in the current list (workspace switched, connection invalid, policy changed) | Re-run `tools/list` |
| MCP | `-32603 Receipt MCP discovery failed` | Storage/Nango failure during composition | Retry; check runtime logs |
| MCP | `isError:true` "Receipt could not complete the integration tool call." | Non-`ReceiptConnectCallError` failure | Check runtime logs |
| Web | "Workspace authorization failed with HTTP <n>." / "Receipt Connect returned invalid workspace authorization." / "Receipt Connect session failed with HTTP <n>." / "Receipt Connect catalog failed with HTTP <n>." | Runtime unreachable or refused | Check the runtime and the user's workspace membership |
| Web | "Workspace not found" page | Path id unknown or access lost | Back to MCP Gateway |

---

## 13. Feature classification

| Feature | Class | Evidence |
| --- | --- | --- |
| Aggregate MCP server `/connect/mcp` | Reachable (via CLI bridge), Hidden as raw URL | §4 |
| Codex install/status/remove | Reachable | §6.4 |
| Generic MCP client config | Hidden (manual) | §6.4 |
| Remote OAuth MCP (ChatGPT etc.) | Absent | §6.4 |
| Named connections (`provider:name` ≠ default) | Hidden (API body only) | §3.2 |
| `read-provider-resource` and legacy `--path` GET | Reachable | §1.4 |
| Provider-MCP tools (Linear, Google Calendar MCP) on the aggregate | Absent by design; reachable per-connection | §4 |
| Tool allowlist (Manage tools) | Reachable | §7.10 |
| GitHub repository policy | Reachable | §7.10 |
| Gateway receipts for `/connect/call` | Reachable | §7.1 |
| Gateway receipts for `/connect/mcp` | Absent | §4 |
| Workspace Dashboard | Reachable | §7.9 |
| Org-level Dashboard | Hidden (redirect) | §7.2 |
| Workspace Activity page | Hidden, partly Inert | §7.8 |
| Workspace create/rename/share/delete, pending invites, View details | Reachable | §7.6–7.7 |
| Global Integrations page | Reachable | §7.10 |
| `receipt login`/`logout`/`doctor` | Reachable (CLI) | §6.3 |
| `receipt connect relay` | Inert (errors) | prior corpus, `connect-cli.ts` still routes it to an error |
| `auth-only` surface, `kubeconfig-exec` mode | Inert / Absent | §1.4 |
| JWT revocation | Absent | §6.1 |
| Authentication-method select and "Show connected only" switch on Integrations | Inert (inside a hidden wrapper) | `integrations-page.tsx:1261-1285` |

---

## Changes since 41baea75

Behavioural changes in the scope of this report, from
`git log 41baea75..HEAD` on the Connect/MCP paths (11 commits touching them):

1. **New connector `azure`** (`26ec975a`, folded into main by `abac3d76`): slug
   `azure-service-principal`, provider-only service-principal auth,
   typed-proxy with two read tools. Catalog 62 → 63; static tools 89 → 91
   (88 read, 3 write). `68b7fa3a` updated the audit script's tests to match;
   `docs/receipt-integration-surface-audit.md` still says 61.
2. **Execution-route auth errors split** (`0a58ac52`): `/connect/tools` and
   `/connect/call` now return `403 receipt_connect_execution_scope_missing`
   for a valid read-only token and `401 receipt_connect_runtime_authentication_required`
   otherwise, both with `reconnectRequired:false`, so a scope problem is no
   longer reported as "reconnect the account".
3. **Agent Registry connections hidden from the Integrations page**
   (`20d20f51`): connections named `agent-registry` are filtered out; the
   Connect button became a link-style button.
4. **CLI onboarding rewrite** (`9b8b7574`, `3c52d87c`, `53f74bed`,
   `a6a32fc7`, `21c2d6f0`): release binaries bake the hosted gateway origin
   (`RECEIPT_CLI_DEFAULT_PROD_GATEWAY_URL`); new verbs `receipt login`,
   `receipt logout`, `receipt doctor`; expired sessions are detected from the
   JWT `exp` and never reused; `receipt setup` activates the reused target
   session; `receipt connect status|<provider>|disconnect` reuse the saved
   session instead of forcing a browser login and retry once after a 401;
   `receipt connect list|tools|call` on the public binary read the saved
   session when `RECEIPT_CONNECT_TOKEN` is unset; the not-signed-in hints
   changed from `run 'receipt login' first` to `run 'receipt setup' first`;
   `sameNormalizedReceiptConnectUrl` became the single URL normalizer; the
   install URL in `--help` moved to `kentronai/receipt-cli`; `docs/receipt-cli.md`
   was rewritten (preview.6 vs preview.7 caveat, `doctor`, local-target
   variables, release process).
5. **UI pass** (`46652e84`): workspace table dropped the Created column and
   gained **View details** (new `workspace-details-dialog.tsx` with Created by,
   resolved through a new `LEFT JOIN "user"`); one shared `TabList`/`Tab`
   component now backs the workspace Overview strip (with **Dashboard** as a
   fourth tab) and the dashboard tabs; the setup panel gained step 1
   `receipt setup`; dashboard page layout changes.
6. **Pending workspace invites** (`c3c16be6`): `GET /connect/workspaces/:id/members`
   now appends rows with `status:"pending"` and `invitationId` from both
   invitation paths; the Settings tab shows a **Pending** badge and **Cancel
   invitation**; new server function `cancelReceiptWorkspaceInvitation`.
7. **Chat routing** (`ab7b00b0`): when the model router is unavailable, web
   chat and Slack no longer fall back to a Factory run with stale provider
   scope; they surface a routing-unavailable message instead ("no task was
   started"). Not a gateway change, but it affects how Global Integrations
   are consumed.
8. Unchanged since `41baea75`: `receipt-connect-mcp.ts`, `receipt-connect-call.ts`,
   `receipt-connect-connections.ts`, `receipt-connect-auth-token.ts`,
   `receipt-connect-device-login.ts`, `cli-login/route.tsx`, the four repo
   docs named in the brief (all last modified 2026-08-20), the Zero schema,
   and the integrations catalog/permissions components other than the two
   edits above.

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

## Open questions

1. Is the missing receipt write on `/connect/mcp` a known gap or an oversight?
   The dashboard copy ("derived from execution receipts") and the Activity
   page copy both imply gateway calls are recorded; MCP-bridge calls are not.
2. Should the Teams app read Global Integrations like web chat and Slack, or is
   the Default-workspace read (`apps/teams/teams-runtime.ts:11`) intentional?
3. Is token revocation planned? `jti` is minted but never checked; `receipt
   logout` only deletes the local file. Documentation must describe the 12-hour
   exposure honestly until then.
4. Which MCP clients will be named as supported? Only Codex has an install
   path; Cursor/Claude Desktop need a manual generic config; ChatGPT needs the
   remote OAuth surface the product plan defers.
5. Should named connections (`aws:prod`, `google-ads:acme`) be documented?
   Neither the web UI nor `receipt connect <provider>` exposes a name; only the
   API body does.
6. The setup panel omits `receipt workspace use`, yet device login always binds
   Default. Is the intended story "set up, then switch", or should login pick
   the workspace?
7. "Beetle Tasks" still renders on the Integrations page; is that acceptable in
   public docs?
8. `docs/receipt-integration-surface-audit.md` (61 connectors) and
   `docs/receipt-connect-nango.md` (Actions editor "intentionally not shown";
   env list missing newer connectors) are stale relative to HEAD; should they
   be updated before public docs cite them?
9. Is the display-only 894-row Nango directory meant to stay in the catalog UI
   as "Coming soon" cards, or should public docs describe only the 63
   connectable connectors?
10. The Activity page is unreachable from navigation and describes itself as
    incomplete; should it be removed or finished before documentation mentions
    it?
