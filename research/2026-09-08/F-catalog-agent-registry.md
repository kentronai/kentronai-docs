# F. "Kentron Catalog" — what the code actually backs (Agent Registry, connector catalog, skills, Org Brain)

Verified against `<repo>` at git HEAD `c3c16be6` (main), 2026-09-07. All `path:line` citations are relative to that repo. The prior research corpus at `doc/research/02-org-settings-governance.md` and `doc/research/03c-app-pages-sidebar.md` (written at `41baea75`) was used as a map only; every claim below was re-read from HEAD source.

Positioning statement under test:

> "One governed registry for approved connectors, skills, and plugins, with clear ownership, dependencies, access controls, and usage visibility. Centralized registry with automated approval ensures only vetted connectors reach production. Clear accountability with role-based access rules. Real-time visibility into connector dependencies, adoption patterns, and security posture."

Classification vocabulary used throughout: **reachable** (implemented and linked from the UI/CLI), **hidden** (implemented, direct URL only), **inert** (UI exists but nothing executes or enforces), **absent**.

---

## 1. Executive summary

There is no single "catalog" surface in the product. Four separate, unrelated surfaces each hold one of the things the positioning bundles together:

| Marketing noun | Real surface | Route | Classification |
|---|---|---|---|
| "Agents" registry | **Agent Registry** — a cloud *discovery inventory* of AI agents and agent-like workloads found in connected AWS / Azure / Google Cloud accounts | `/agent-registry/registry` (tabs `?tab=inventory` and `?tab=dashboard`) | reachable, all org members can view; owner/admin can connect and scan |
| "Connectors" | **Global Integrations** — the organization-wide connector catalog (about 900 display entries, 63 connectable) | `/organization/settings/integrations`; workspace-scoped twin inside MCP Gateway | reachable, owner/admin only (org page); any member (workspace twin) |
| "Skills" | **Skills** — organization SKILL.md bundles, versioned and receipt-backed | `/organization/settings/skills` | reachable, owner/admin only |
| "Usage visibility" | **Org Brain** (`/organization/settings/knowledge-graph`) and the MCP Gateway **Gateway activity** dashboard | see §6, §7 | reachable, owner/admin (Org Brain route guard), any member for gateway pages |
| "Plugins" | nothing | — | **absent** |

The most important findings for the docs:

1. The **Agent Registry is a read-only discovery scanner, not a registry you register agents into.** It was a stub at `41baea75` ("Agent registration is not available yet") and, across nine commits, became a receipt-backed inventory built by scanning cloud accounts through Nango-held credentials. There is still no way to create, register, approve, edit, assign an owner to, or decommission an agent from the UI; the only row action is **"View details"** (`apps/start/src/components/agent-registry/agent-registry-table.tsx:164-166`).
2. "Ownership" in the Agent Registry means **a cloud tag or a CloudTrail creator identity read from the provider**, never an assignment made in Kentron (`packages/receipt-app/src/services/agent-cloud-discovery.ts:123-135, 144-172`).
3. **No approval workflow exists for connectors, skills, or agents.** The only "approval" concept in the codebase is a Policies record for tool-call approvals (`apps/start/src/lib/shared/policies.ts:105-112`), which is about pausing an agent's tool call for a human, not about vetting a connector into a catalog.
4. **No dependency graph exists.** "Dependencies" appear only as internal function-injection parameters in `receipt-connect-call.ts`, not as a product feature.
5. **Adoption/usage data does exist**, in two receipt-derived places: Org Brain's "Application usage across the organization" (distinct objectives per provider, from each objective's execution contract) and the MCP Gateway dashboard (calls per tool / per connector / per actor from `tool.called` / `tool.observed` receipts). Neither is "real-time"; Org Brain polls every 30 seconds and the gateway dashboard is refreshed on demand.
6. The Integrations page's authentication-method select and "Show connected only" switch are wrapped in `<div className="hidden">` at HEAD (`integrations-page.tsx:1254`) and are **hidden/inert**; the visible controls are search, category chips, and an All / Connected / Available / Popular segmented control.

---

## 2. Agent Registry

### 2.1 Purpose, navigation, and routes

- Sidebar area title **"Agents"**, description **"Browse registered agents"**, icon `Bot`, single child **"Registry"** → `/agent-registry/registry` (`apps/start/src/components/agent-registry/agent-registry-nav.config.tsx:15-33`). The former "Dashboard" child was removed; `/agent-registry/dashboard` is now a redirect to `/agent-registry/registry?tab=dashboard` with the comment "Preserve old dashboard bookmarks while keeping one Registry sidebar entry" (`apps/start/src/routes/(app)/_layout/agent-registry/dashboard.tsx:4-13`).
- The registry route validates a `tab` search param of `'inventory' | 'dashboard'` so "a refresh or shared link restores it" (`.../agent-registry/registry.tsx:5-11`).
- The layout route redirects anonymous or signed-out users to `/chat`, shows `LoadingState label="Loading agent registry"` while auth loads, and has **its own error boundary**: **"Agent Registry couldn't load."** with the error message in a `<pre>` and a **"Try again"** button (`.../agent-registry/route.tsx:20-44`). The comment explains this replaced the whole-app "Something went wrong" fallback.
- There is no index route under `/agent-registry`; the bare path still renders the app's not-found page (only `route.tsx`, `dashboard.tsx`, `registry.tsx` exist in that folder).
- The sidebar shows the "Agents" area to **every signed-in organization member**: `app-sidebar.tsx:196-206` only gates keys in `ORG_SETTINGS_AREA_KEYS` behind `canManageOrganizationSettings`, and `agent-registry` is not one of those keys (`-organization-settings-nav.ts:310`).
- Page chrome: title **"Agent Registry"**, description **"Discover cloud AI agents, classify autonomy, and review organization risk."** (`agent-registry-page.tsx:207-211`). Tabs **"Inventory"** and **"Dashboard"** in a `TabList label="Agent registry views"` (`:75-96`).
- No i18n: every string is hard-coded English. No docs page mentions the feature (grep of `docs/`, `README.md`, `AGENTS.md` for "agent registry" / "agent inventory" only hits an RCA entry in `docs/agent-fix-checklist.md`).
- No `receipt` CLI verb touches the inventory; a repo-wide grep for `agent-inventory` / `discoverCloudAgents` / `refreshAgentInventory` finds only the UI components and the two server modules.

### 2.2 How a cloud connection is made

**Its own connection, not the shared one.** Connecting from Agent Registry starts a Receipt Connect / Nango session with `connectionName: AGENT_REGISTRY_CONNECTION_NAME` = `'agent-registry'` (`agent-cloud-integrations-dialog.tsx:152-154`; constant in `agent-registry-connection-name.ts:9`). The file comment states the intent: "connecting AWS/Azure/GCP here never reuses, and is never reused by, the connection shown on the org's general Integrations settings page" (`:1-8`). Every other surface falls back to the connection named `"default"` (`packages/receipt-app/src/server/receipt-connect-routes.ts:340`, `:1836-1837`). The Global Integrations page explicitly filters out connections named `agent-registry` so they "never read as (or get reused as) the org's primary provider connection" (`integrations-page.tsx:243-246`).

**Scope.** The connection lives in the organization's hidden global scope: both the list and refresh actions call `receiptGlobalScopeId(auth.organizationId)` (`agent-registry.server.ts:69, 108`), and the dialog resolves the same id through `getOrganizationScopeWorkspaceId` before refreshing or disconnecting (`agent-cloud-integrations-dialog.tsx:102, 205`).

**Flow.** `startReceiptConnectSession` (`receipt-connect.functions.ts:96-104`, input schema `:17-20` allows `connectionName` up to 64 chars) → web action posts to the runtime's `POST /connect/nango/sessions` with `provider`, `connectionName`, `endUserEmail` (`receipt-connect.server.ts:528-566`) → the runtime tags the Nango connect session with `connection_name` (`receipt-connect-routes.ts:1849-1852`) → the dialog embeds the returned link in an iframe and listens for `connect` / `close` postMessages (`agent-cloud-integrations-dialog.tsx:72-146`) → on success it refreshes connections, toasts `"{AWS|Azure|Google Cloud} connected."`, and immediately runs a first scan. The dialog copy during connect: title **"Connect {provider}"**, description **"Credentials are collected and stored by Nango. Receipt keeps only the connection reference."** (`:247-255`). Connection status values are `valid | expired | invalid` (`packages/receipt-app/src/services/receipt-connect-connections.ts:31`).

**Connector ids and Nango providers** (from the connector manifests in `packages/receipt-app/src/integrations/nango/slugs/`):

| UI label | Receipt connector id | Nango provider slug | Auth | Credential mode | Extra config |
|---|---|---|---|---|---|
| AWS | `aws` | `aws-iam` | IAM access key / secret (form) | `aws-credential-process` | none — the comment at `agent-cloud-discovery.ts:375-382` notes the form "has no region field" |
| Azure | `azure` | `azure-service-principal` | Service principal (client id + secret, `auth_mode: TWO_STEP`) | `nango-credentials` | `tenantId` (required), `subscriptionId` ("The Azure subscription Receipt should scan", optional) — `deploy/patches/nango-azure-service-principal.mjs:54-64` |
| Google Cloud | `gcp` | `google` | OAuth 2.0 | `gcloud-config` | none |

Sources: `slugs/aws-iam/provider.json:1-15`, `slugs/azure-service-principal/provider.json:1-16`, `slugs/google/provider.json:1-16`. The Azure provider does not exist in the pinned self-hosted Nango image (`hosted-0.69.48`), so the deploy Dockerfile applies a patch that appends it to Nango's `providers.yaml` with a fail-closed check (`deploy/patches/nango-azure-service-principal.mjs:9-14, 66-89`); `docs/agent-fix-checklist.md` records this as RCA-522.

**Region / subscription scope.**
- AWS: an explicit `region` / `awsRegion` / `regions` / `awsRegions` value in the connection config is split on commas and whitespace (`agent-cloud-discovery.ts:361-367, 1165-1167`); otherwise the scan calls `ec2:DescribeRegions` and scans every enabled region in parallel, falling back to `us-east-1` if even that call fails (`:383-394, 1168-1175`).
- Azure: an explicit `subscriptionId` wins; otherwise every `Enabled` subscription the principal can see is listed from `management.azure.com/subscriptions` and queried through Resource Graph in batches of 50 (`:1372-1394, 1403-1422`). Zero visible subscriptions throws **"This service principal cannot see any Azure subscriptions."** (`:1411-1414`).
- GCP: every `ACTIVE` project from Cloud Resource Manager v3 (`:1240-1267`), then Cloud Asset `searchAllResources` per project per asset type (`:1275-1294`).

**Permissions required (AWS, inferred from the SDK commands invoked; the repo has no IAM policy document).** `ec2:DescribeRegions`, `ec2:DescribeInstances`, `bedrock:ListAgents`, `bedrock:GetAgent`, `bedrock:ListAgentActionGroups`, `bedrock:GetAgentActionGroup`, `bedrock:ListTagsForResource`, `bedrock-agentcore:ListAgentRuntimes`, `bedrock-agentcore:ListTagsForResource`, `lambda:ListFunctions`, `lambda:ListTags`, `states:ListStateMachines`, `states:DescribeStateMachine`, `states:ListTagsForResource`, `ecs:ListClusters`, `ecs:ListServices`, `ecs:DescribeServices`, `iam:ListAttachedRolePolicies`, `iam:ListRolePolicies`, `iam:GetPolicy`, `iam:GetPolicyVersion`, `iam:GetRolePolicy`, `cloudtrail:LookupEvents` (`agent-cloud-discovery.ts:4-50` imports; call sites throughout `:144-172, 383-394, 518-661, 675-746, 762-1145`). All are read-only. Most are best-effort: a missing tag, IAM, or CloudTrail permission leaves the field empty or sets `metadataUnavailableReason` instead of failing the scan; the scan as a whole only fails when **no** service in **any** region succeeded — **"AWS inventory could not read any supported service. …"** (`:1184-1188`). For GCP and Azure the code calls public REST APIs (Cloud Resource Manager, Cloud Asset, ARM subscriptions, Resource Graph); the repo does not enumerate the GCP IAM permissions or Azure RBAC role needed.

### 2.3 Scan lifecycle

Trigger points (all organization owner/admin only, see §2.9):
1. Automatic first scan after a successful connect (`agent-cloud-integrations-dialog.tsx:119-141`).
2. **"Scan inventory"** per provider inside the Integrations dialog (`:309-326`).
3. **"Refresh inventory"** on the page header, which scans every connected provider; it is rendered only when there is at least one agent and `canManage` is true (`agent-registry-page.tsx:280-294`).

There is no scheduler, webhook, or CLI trigger; nothing else in the repo calls `refreshAgentInventoryAction`.

Server side (`apps/start/src/lib/frontend/agent-registry/agent-registry.server.ts`):
- `refreshAgentInventoryAction` requires admin: **"Only organization owners or admins can scan cloud agents."** (`:105-107`). It selects connections with `status === 'valid'`, `name === 'agent-registry'`, provider in `aws | azure | gcp`, optionally narrowed to one provider (`:113-121`). None found → **"Connect AWS before scanning its agents."** (provider upper-cased) or **"Connect AWS, Azure, or Google Cloud before scanning agents."** (`:122-128`).
- For each connection it mints `scanId = scan_<uuid>` and appends **three possible receipt events** to one per-organization stream: `organization.agent_inventory.scan_requested`, then `scan_completed` (with the full agent list) or `scan_failed` (with a serialized error) (`:140-210`). Errors are flattened to one line and truncated to 500 characters "never raw credential-bearing response bodies" (`:59-64`).
- Stream name: **`organizations/<organizationId>/agent-inventory`** (`packages/receipt-app/src/services/agent-inventory.ts:129-130`). Receipts are hash-chained with `actor.kind: 'user'`, and the append retries up to 5 times on chain conflicts (`:255-289`). The reducer refuses cross-organization receipts (`:153-162`).
- After every append the whole stream is replayed and the serving projection rebuilt: rows of `entity_kind IN ('agent_inventory','agent_inventory_scan')` in the neutral **`receipt_entity_projection`** table are deleted and reinserted inside one transaction (`:306-377`; table schema `packages/receipt-app/src/db/schema.ts:82-111`). This table is not part of the Zero client schema (only server code references it), so the UI reads it through the `listAgentInventory` server function, not through Zero.
- Reducer semantics (`:146-245`): a `scan_completed` **replaces every agent belonging to that connection** with the new list; a `scan_failed` keeps the last good inventory and records the failure; agents are sorted by name; scans are sorted newest first and capped at `MAX_SCAN_HISTORY = 30`; receipt refs capped at 100. Unit tests pin both behaviours (`agent-inventory.test.ts:72-136`).
- Scan status values: `running | completed | failed` (`agent-inventory.ts:64`); `running` exists only between the `scan_requested` and terminal receipts, and no reaper exists for a scan whose process dies mid-flight.
- Rows persisted before the compliance-register fields existed are defaulted on read (`purpose: null`, empty arrays) so the UI never dereferences `undefined` (`:406-424`).

The scans list is returned to the page, which shows the newest as **"Last scan: AWS · completed · {date-time}"**, with a warning triangle when the last scan failed, or **"No scans yet"** (`agent-registry-page.tsx:347-360`).

Toasts after scans (`agent-cloud-integrations-dialog.tsx:46-49, 128-141, 172-175`; `agent-registry-page.tsx:169-186`):
- **"{AWS} scan completed: 0 agents found. Check the connected account's permissions and region if agents are deployed there."**
- **"{AWS} scan completed: {n} agent(s) found."**
- **"{AWS} connected, but inventory scanning needs attention: {error}"**
- Page-level refresh: **"Scan completed: 0 agents found across all connected accounts."**, **"Scan completed: {n} agent(s) found."**, **"{n} cloud scan(s) failed. Open Integrations for details."**

### 2.4 Providers and resource types scanned

`discoverCloudAgents` dispatches by provider (`agent-cloud-discovery.ts:1499-1508`). Each source is paged at most `MAX_PROVIDER_PAGES = 20` pages (`:83`).

**AWS** (per region, `:748-1147`):

| Resource | API | Platform label | Function label | Counted when | Owner source | Permissions read |
|---|---|---|---|---|---|---|
| Bedrock Agents | `ListAgents` + `GetAgent` + `ListAgentActionGroups` / `GetAgentActionGroup` | "AWS Bedrock" | "Bedrock agent" | always (native) | tags, then CloudTrail | execution role's IAM policies (`describeRolePermissions`) |
| Bedrock AgentCore runtimes | `ListAgentRuntimes` + `ListTagsForResource` | "AWS Bedrock AgentCore" | "AgentCore runtime" | always (native) | tags, then CloudTrail | **not resolved** (`AWS_ROLE_LOOKUP_NOT_ATTEMPTED`, `:479-483`) |
| Lambda functions | `ListFunctions` + `ListTags` | "AWS Lambda" | "Agent workload" | name or description matches `AI_SIGNAL` | tags, then CloudTrail | execution role's IAM policies |
| Step Functions | `ListStateMachines` + `ListTagsForResource` + `DescribeStateMachine` | "AWS Step Functions" | "Agent orchestration" | name matches `AI_SIGNAL` | tags, then CloudTrail | role from `DescribeStateMachine` |
| EC2 instances (running or stopped) | `DescribeInstances` | "AWS EC2" | "Self-hosted agent workload" | Name tag or any tag JSON matches `AI_SIGNAL` | tags, then CloudTrail | **not resolved** |
| ECS services | `ListClusters` → `ListServices` → `DescribeServices` (batches of 10, with tags) | "AWS ECS" | "Container agent workload" | name or tags match `AI_SIGNAL` | tags, then CloudTrail | **not resolved** |

**Google Cloud** (`:1192-1336`), via Cloud Asset `searchAllResources` per active project:

| Asset type | Platform label | Native? |
|---|---|---|
| `aiplatform.googleapis.com/ReasoningEngine` | "Google Vertex AI" | yes (always counted) |
| `dialogflow.googleapis.com/Agent` | "Google Dialogflow / Agent Builder" | yes |
| `run.googleapis.com/Service`, `run.googleapis.com/Job` | "Google Cloud Run" / "Google Cloud Run Jobs" | no (needs `AI_SIGNAL`) |
| `cloudfunctions.googleapis.com/CloudFunction` | "Google Cloud Functions" | no |
| `container.googleapis.com/Cluster` | "Google Kubernetes Engine" | no |
| `compute.googleapis.com/Instance` | "Google Compute Engine" | no |
| `workflows.googleapis.com/Workflow` | "Google Cloud Workflows" | no |

Function label "Managed AI agent" for native, "Agent workload" otherwise; owner from labels only (no CloudTrail equivalent); credential type "OAuth token"; permissions always `GCP_PERMISSIONS_UNAVAILABLE` with the reason text at `:459-463`. A non-OK response for one asset type is skipped rather than failing the scan (`:1294`).

**Azure** (`:1338-1497`), one Resource Graph query across subscriptions for nine resource types:

| Resource type | Platform label | Native? |
|---|---|---|
| `microsoft.cognitiveservices/accounts` | "Azure OpenAI" | yes |
| `microsoft.machinelearningservices/workspaces` | "Azure AI Foundry" | yes |
| `microsoft.web/sites` | "Azure Functions" | no |
| `microsoft.logic/workflows` | "Azure Logic Apps" | no |
| `microsoft.app/containerapps` | "Azure Container Apps" | no |
| `microsoft.containerservice/managedclusters` | "Azure Kubernetes Service" | no |
| `microsoft.compute/virtualmachines` | "Azure Virtual Machines" | no |
| `microsoft.containerinstance/containergroups` | "Azure Container Instances" | no |
| `microsoft.batch/batchaccounts` | "Azure Batch" | no |

Function label "Azure AI agent service" for native, "Agent workload" otherwise; credential type "Service principal"; owner from tags; `lastUsedAt` is never set for Azure, so the Last used column always reads "Not reported" and Azure rows can never be "dormant"; permissions always `AZURE_PERMISSIONS_UNAVAILABLE` (`:464-468`).

**The `AI_SIGNAL` heuristic** decides whether generic compute counts as an agent: `/(^|[punct])(ai|agent|llm|genai|copilot|assistant|langchain|crewai|autogen|factory|receipt|beetle)([punct]|$)/i` (`:81-82`), tested against the name plus a JSON blob of tags/labels. The regex includes this product's own names ("factory", "receipt", "beetle") because a self-hosted Receipt box was previously reported as "0 agents found" (`:65-80`; test `agent-cloud-discovery.test.ts:19-61`). Docs should say plainly that generic compute is matched by a **keyword heuristic on names and tags**, so unnamed agents are missed and unrelated resources named e.g. "ai-*" are included.

### 2.5 Classification: autonomy, risk, ownership, findings

`classify()` at `agent-cloud-discovery.ts:174-263` and `item()` at `:265-327`:

**Autonomy level** = `autonomyOverride ?? (autonomousWorkload ? "L4" : nativeAgent ? "L3" : "L2")` (`:191-193`). In practice:
- Every non-native compute workload (Lambda, Step Functions, EC2, ECS, GCP compute, Azure compute) is `autonomousWorkload: true` → **L4**.
- Native GCP (Vertex AI / Dialogflow) and native Azure (OpenAI / AI Foundry) are `nativeAgent: true, autonomousWorkload: false` → **L3**.
- Bedrock Agents and AgentCore runtimes set both flags → **L4**, except Bedrock Agents get a real override: no enabled action groups → **L2**; every inspected function requires confirmation → **L3**; any function with `requireConfirmation === "DISABLED"` → **L4**; up to 5 action groups inspected; any failure leaves the coarse default (`:663-711`).
- **L1 is never produced by discovery.** The only definitions of the levels are the dashboard labels **"L4 Autonomous", "L3 Approval", "L2 Advise", "L1 Observe"** (`agent-risk-dashboard.tsx:83-85`). The Inventory "Autonomy" filter offers L1-L4 checkboxes (`agent-registry-page.tsx:50-55, 242-258`), so selecting L1 alone always yields "No agents match this search and filter."

**Risk level** (`:205-212`): `critical` when (L4 and no owner) or the role grants a wildcard action; `high` when no owner, or L4, or a wildcard resource; `medium` when dormant; else `low`. Consequence: every generic workload is at least **high** because it is L4.

**Dormant** = `lastUsedAt` older than 30 days (`:285-287`), status `dormant` vs `active` (`:315`). Note the value behind "Last used" is not invocation telemetry: Bedrock `updatedAt`, AgentCore `lastUpdatedAt`, Lambda `LastModified`, Step Functions `creationDate`, EC2 `LaunchTime`, ECS `createdAt`, GCP `updateTime` (`:796, 861, 916, 994, 1049, 1132, 1324`). Docs should call the column "last modified/created as reported by the provider".

**Owner** = the first tag whose key matches `owner|team|managed-by|created-by|contact|maintainer|aws:createdby` (`:123-135`); for AWS, if no tag matches, CloudTrail `LookupEvents` on the resource name is queried and the earliest `Create*/Run*/Register*` event's `userIdentity.arn | userName | principalId` is used (`:144-172`). There is no way to set or override an owner in Kentron.

**Credential** column is a constant per provider — "IAM role" (all AWS sources), "OAuth token" (GCP), "Service principal" (Azure) — not an observed per-agent fact (`:792, 858, 913, 991, 1046, 1129, 1321, 1488`).

**Compliance register (ISM-2134/2135).** The `AgentInventoryItem` type documents these as "Best-effort compliance register fields (ISM-2134/2135: an agent register covering owner, purpose, credentials, tools, permissions, and data access). Populated from real cloud API responses only - never fabricated" (`agent-inventory.ts:42-54`). For Bedrock Agents, Lambda, and Step Functions, `describeRolePermissions` reads the execution role's attached and inline IAM policy documents and derives: **tools** = AWS services named in `Allow` actions (display-named via `:405-433`, with "All AWS services (wildcard)" prepended if `*`), **permissionsSummary** = "{n} allow statement(s) across {m} polic(y|ies)." plus "Grants a wildcard action (*) - least-privilege scoping is not in place." or "No attached or inline policies found on this role.", and **dataAccessSummary** = up to 10 resource ARNs from S3/DynamoDB/RDS/Secrets Manager/SSM/OpenSearch/Redshift/Glue, "+{n} more resources", "At least one statement scopes to Resource: * - data access is not scoped to specific resources.", or "No data-store resource (S3/DynamoDB/RDS/Secrets Manager/...) referenced by name." (`:518-661`). **Purpose** for Bedrock Agents is the agent's own `instruction` field (its system prompt) (`:719-746`); otherwise `purpose` falls back to the provider description (`:318`).

**ISM findings** (only emitted when the signal was observed, `:225-260`):
- "ISM-2133 / ISM-2134: no owner recorded - this agent's identity cannot be attributed to an accountable person or team."
- "ISM-2135: tools, permissions, and data access could not be read for this agent register entry - {reason}"
- "ISM-2134 / ISM-2135: the agent register entry is incomplete (owner and/or permissions missing)."
- "ISM-2141 / ISM-2143: this role grants a wildcard action (*) rather than the minimum required scope."
- "ISM-2135: this role's data access is not scoped to specific resources (Resource: *)."
- "ISM-2113 / ISM-2136: confirm a human-approval gate exists before this agent executes sensitive or high-impact actions, rather than relying on a successful login alone."

**Recommended action** strings (`:213-223`): "Assign an accountable owner and review this agent's cloud permissions."; "Replace this role's wildcard action grant with the specific actions the agent needs (ISM-2141/2143)."; "Verify a human approval gate and restrict write permissions to the minimum required scope."; "Confirm the human approval gate is configured and enforced before this agent executes actions."; "Confirm this agent is still needed; disable or remove stale credentials if it is dormant."; "No immediate action; keep ownership and least-privilege access under review."

The "ISM" references are described in a code comment as "The ISM references a customer pasted as their compliance requirement" (`:225-230`); the repo contains no mapping document for them. Docs should not expand "ISM" without confirming with the product owner (see Open questions).

### 2.6 Inventory tab

Toolbar (`agent-registry-page.tsx:213-275`): `SearchInput placeholder="Search agents" aria-label="Search agents"` matching name, external id, platform, function, owner, region (`:131-149`); an **"Autonomy"** dropdown (`Filter` icon, count badge when active) with label **"Filter by autonomy level"**, checkbox items L1-L4, and **"Clear filter"** (`:225-274`). Counter line **"Showing {visible} of {filtered} agents"** (`:343-346`). Client-side pagination via the shared `TablePagination` with page sizes 10 / 25 / 50 / 100 (`packages/ui/src/components/table-pagination.tsx:19`).

Table columns (`agent-registry-table.tsx:74-85`): **# / Agent / Platform / Function / Level / Risk / Owner / Credential / Last used / Actions**. The Agent cell is a button showing a self-contained provider badge ("AWS" orange, "AZ" blue, "GC" blue — `agent-cloud-provider-icon.tsx:4-11`), the name, and `"{PROVIDER} · {region}"`; clicking it opens the detail dialog. Owner renders **"Unowned"** in danger colour when null (`:135-141`); Last used renders **"Not reported"** when null (`:143-147`). The row Actions menu (`aria-label="Actions for {name}"`) has exactly one item: **"View details"** (`:149-168`). The former "Recommended action" column was dropped in `c3c16be6` in favour of the dialog.

Empty states: **"No agents discovered yet. Connect a cloud account and scan its inventory."** or, with a search/filter active, **"No agents match this search and filter."** (`agent-registry-page.tsx:367-371`). Loading: **"Loading agent inventory…"** (`:335-340`). Load errors render in a `role="alert"` banner; the fallback message is **"Agent inventory could not be loaded."** (`:119-125, 327-334`).

Detail dialog (`:386-526`): title = agent name; description `"{platform} · {region}"`; fields **Agent ID** (monospace external id), **Connection** (`"{PROVIDER} · {connectionName}"`), **Autonomy and risk** (two badges), **Owner** ("Unowned"), **Credential**, **Purpose** (`purpose || description || "No purpose or description reported."`), **Tools** (badges, else `metadataUnavailableReason` or "No tools reported."), **Permissions** (bullets, else reason or "No permissions reported."), **Data access** (bullets, else reason or "No resource-scoped data access reported."), **Description** ("No description reported."), **Recommended action**, and a warning box **"Policy findings"** listing `ismFindings` when present.

### 2.7 Dashboard tab

`AgentRiskDashboard` (`agent-risk-dashboard.tsx:77-170`) is computed **client-side from the same rows**, so it reflects the full inventory, not the Inventory tab's filter. Empty state: **"Connect a cloud account and scan it to build the executive risk dashboard."** Five count tiles: **"Total agents discovered"**, **"Critical risk"**, **"High risk"**, **"Agents with no owner"**, **"Dormant (30+ days)"**. Three bar-distribution cards: **"Agent distribution by autonomy level"** (L4 Autonomous, L3 Approval, L2 Advise, L1 Observe), **"Ownership status"** (Owned / Unowned), **"Credential types"** (one bar per distinct credential label). Each row shows `"{count} · {percent}%"`. There are no time series, no trend, and no per-provider breakdown.

### 2.8 Integrations dialog

Button **"Integrations"** (`Plug` icon) opens a dialog titled **"Cloud integrations"** with description **"Connect AWS, Azure, or Google Cloud, then scan the account for AI agents and agent-like workloads."** (`agent-cloud-integrations-dialog.tsx:231-256`). One card per provider (`aria-label="{AWS} integration"`) with a status dot and text **"1 connection"** / **"{n} connections"** / **"Reconnect required"** (`needsAttention` when any connection is not `valid`) / **"Not connected"** (`:268-305`). Buttons: **"Connect"** when not connected; **"Scan inventory"** and **"Disconnect"** when connected (`:306-365`). Disconnect removes *every* connection under that provider name (`:195-227`), toasting **"{label} disconnected."** or **"Unable to disconnect {label}."** Provider data comes from `listAgentInventoryAction`, which counts only connections whose `name === 'agent-registry'` and returns `connectionIds` for disconnect (`agent-registry.server.ts:77-97`).

### 2.9 canManage vs view

- `listAgentInventoryAction` requires an organization session (`requireOrgAuth`) and returns `canManage: isOrgAdmin(...)` (`agent-registry.server.ts:31-47, 98`). `isOrgAdmin` asks Better Auth `hasPermission({ organization: ['update'] })` (`organization-member-role.service.ts:6-33`), i.e. owner or admin.
- **Any organization member can view** the inventory, the dashboard, the detail dialog, and open the Integrations dialog (the sidebar area is not role-gated, see §2.1). For non-admins the Connect / Scan / Disconnect buttons are disabled (`disabled={!props.canManage || ...}`, `agent-cloud-integrations-dialog.tsx:314, 332, 351`) and the "Refresh inventory" button is not rendered (`agent-registry-page.tsx:280`).
- Server enforcement: `refreshAgentInventoryAction` throws for non-admins (`:105-107`); connect/disconnect go through the Receipt Connect actions, which have their own workspace-authority checks (out of scope here).

### 2.10 Limits and operational caveats

- `MAX_PROVIDER_PAGES = 20` per listing (`agent-cloud-discovery.ts:83`) — e.g. at most 2,000 Bedrock agents per region, 1,000 Lambda functions per region (page size 50).
- `MAX_ACTION_GROUPS_INSPECTED = 5` per Bedrock agent (`:663`).
- Data-access summary shows at most 10 ARNs (`:636-639`).
- Scan history capped at 30 (`agent-inventory.ts:16`); receipt refs at 100 (`:17`); error text at 2,000 characters in the reducer (`:228`) and 500 at the API boundary (`agent-registry.server.ts:63`).
- HTTP timeouts of 30 seconds per GCP/Azure request (`AbortSignal.timeout(30_000)`); nothing bounds total scan time, and the scan runs synchronously inside the server-function request.

### 2.11 What is NOT implemented (absent)

- **Agent registration / creation**: no create, edit, import, or "register a remote agent" flow; the stub's "Create New Agent" menu was removed. No "Receipt Managed" agents concept exists any more.
- **Approval workflow**: no approve/reject state, no reviewer, no gating of an agent before it "reaches production".
- **Ownership assignment**: owner is read-only from cloud tags / CloudTrail; there is no assign, reassign, or notify.
- **Dependency graph**: no relation between agents, connectors, skills, or tools is stored or drawn.
- **Adoption/usage** for discovered agents: no invocation counts, no call telemetry; "Last used" is a modification timestamp.
- **Alerts, exports, or reports**: none. No CSV/PDF, no scheduled scan, no notifications.
- **Permissions introspection for AgentCore, ECS, EC2, GCP, Azure**: explicitly reported as unavailable with reason text (`agent-cloud-discovery.ts:449-483`).
- **Per-row actions beyond View details**; no decommission, quarantine, or "disable credential".
- **Tests** cover only the reducer and the `AI_SIGNAL` regex; no `apps/start` component test references the registry.

### 2.12 Feature classification (Agent Registry)

| Feature | Status |
|---|---|
| Sidebar "Agents" → "Registry"; Inventory and Dashboard tabs | reachable |
| `/agent-registry/dashboard` bookmark redirect | reachable (redirect) |
| Connect AWS / Azure / Google Cloud with a dedicated `agent-registry` connection | reachable (owner/admin) |
| Scan inventory, Refresh inventory, Disconnect | reachable (owner/admin) |
| Receipt-backed scan history and projection | implemented (backend) |
| Inventory search, autonomy filter, pagination, detail dialog | reachable |
| L1 filter value | inert (no discovery path produces L1) |
| Executive risk dashboard tiles and distributions | reachable |
| IAM permission / tools / data-access register (AWS Bedrock Agent, Lambda, Step Functions) | reachable (best-effort) |
| Register fields for AgentCore, ECS, EC2, GCP, Azure | absent (reason text shown) |
| Registering, approving, owning, editing, or retiring an agent | absent |
| Scheduled scans, alerts, exports | absent |

---

## 3. The connector catalog: Global Integrations

### 3.1 Surface and access

Route `/organization/settings/integrations` renders `IntegrationsPage scope="organization"` with title **"Global Integrations"** and description **"Connected once for the whole organization and available to Receipt chat. Workspace-scoped connections for CLI and MCP clients live under MCP Gateway."** (`routes/(app)/_layout/organization/settings/integrations/route.tsx:11-19`). The route comment is the canonical explanation of the two scopes (`:4-10`). It is a rail item named **"Integrations"** (`-organization-settings-nav.ts:186-197`) and is owner/admin-only because the whole organization-settings layout bounces other roles to `/` (`settings/route.tsx:17-40`; `-organization-settings-access.ts:9-17`).

The workspace twin: the MCP Gateway workspace page's **"Open integrations"** tab renders `<IntegrationsPage scope="workspace" embedded />` (`mcp-gateway-workspace-page.tsx:38, 200`; tabs "Open integrations" / "LLM keys" / "Settings" plus a separate Dashboard link). MCP Gateway paths (including `/organization/settings/workspaces`) are open to any organization member (`-organization-settings-access.ts:15`). In workspace scope without a selected workspace the page shows **"Select an available workspace before managing integrations. No organization-wide connections are shown as a fallback."** (`integrations-page.tsx:1066-1071`). Connect-time copy differs by scope (`integration-connect-scope-copy.ts:7-11`): "Enter your credentials below to connect {name} to this organization's Global Integrations. Other organizations you belong to are not affected." vs "Enter your credentials below to connect {name} only to the {workspace} workspace."

### 3.2 Catalog composition and counts

- `integration-catalog.ts` starts from a curated seed (`CURATED_INTEGRATION_CATALOG`, first entries `aws`, `gcp`, `google-ads`…, `:56-70`), joins Receipt's runtime connector catalog (which decides *connectability*: `connectProviderId`, `authMode`, `toolSurface`, `enforcement`, static tool counts), and appends Nango's public provider list as display-only entries (`:560-681`). The file comment: "Connectability is joined from Receipt's canonical runtime connector catalog; live connection status comes only from Zero." (`:52-55`).
- `nango-provider-catalog.ts` is a "Display-only snapshot of Nango's public provider catalog" (snapshot date 2026-07-14, `:7-18`) with 853 tuple entries (count of `['…` lines).
- The test asserts `INTEGRATION_CATALOG.length >= 894` (`integration-catalog.test.ts:24`).
- The repo's integration-surface audit fixture pins **63 connectors, 91 static tools (88 read, 3 write)** (`scripts/audit-receipt-integration-surfaces.test.mjs:25-29`), i.e. only ~63 of the ~900 cards are actually connectable; the rest show as "coming soon" style cards (`isComingSoon = !isConnected && !isConnectable`, `integrations-page.tsx:360`).
- Tool-surface and enforcement vocab (`integration-catalog.ts:23-36`): `toolSurface ∈ typed-proxy | compatibility-read | provider-mcp | resource-aware-get | command-auth | auth-only`; `enforcement ∈ typed | dynamic-review | compatibility | runtime-only | authentication-only`.

### 3.3 Search, filters, pagination

At HEAD (`integrations-page.tsx:1175-1300`):
- Search input `placeholder="Search integrations"` (`:1181`).
- Category chips in a `role="group" aria-label="Filter integrations by category"`: **All** plus the groups that match something — **Development, Google, Microsoft, Project Management, Cloud & Data, Communication** (`integration-category-groups.ts:25-57, 81-87`). The file explains the 23 raw categories were "far too many chips to scan".
- Segmented control **All / Connected / Available / Popular** (`:1223-1251`); "Connected" keeps only integrations with connections, "Available" keeps only connectable ones (`:918-924`).
- The **"Authentication"** select (`All methods / API key / token / OAuth`) and the **"Show connected only"** switch are inside `<div className="hidden">` with the comment "The search box and category chips cover the same ground without a second row of controls." (`:1249-1298`). They are **hidden/inert** at HEAD and were already hidden at `41baea75` (the wrapper came in `c4ea0296`, an ancestor of `41baea75`); the map file overstated them.
- Pagination: `INTEGRATION_BATCH_SIZE = 60` (`:70`), **"Load more"** (`aria-label="Load more integrations"`) with **"{n} remaining"** (`:1320-1340`).
- No-match state: **"No integrations found"** (`:1349`).
- Error banners: `"{connectionRefreshError} Showing the last synced connection state."` and `"{catalogError} Connected integrations remain visible, but new connections are unavailable until the catalog recovers."` (`:1155-1164`).

### 3.4 Per-card actions

Each card (`aria-label="{name} integration"`, `:394`) offers **"Connect"** / **"Opening"** (`:495-504`), and when connected, per-connection **"Manage tools"** (`aria-label="Manage tools for {provider} {name}"`, `:447-460`) and **"Disconnect"** (`:469-480`). The disconnect confirmation is titled **"Disconnect integration?"** with body `Disconnect {provider}/{name}? Receipt will revoke the provider connection and new agent tasks will immediately lose access to it.` and button "Disconnect" / "Disconnecting" (`:1117-1148`). Connect success toast: **"{name} connected."** (`:811`).

**Manage tools and permissions dialog** (`integration-permissions-dialog.tsx`): title **"Manage tools and permissions"**, description `"{integrationName} · {connection}. Every published operation is controlled by this {organization|workspace} allowlist."` (`:229-234`); sections **"Read operations"** and **"Write and delete operations"** with switches reading **"Allowed"** / **"Never allow"** (`:331-401`); **"Save permissions"** / "Saving" (`:441`); toast **"Connection permissions saved."** (`:209`). This is the closest thing in the product to "access controls on connectors": an allowlist of published operations per connection per scope.

### 3.5 "Request an integration" = file a development task

When the search matches nothing, `IntegrationRequestPanel` renders **"Build {name} with Beetle Tasks"** with body "New integrations are code changes: Beetle opens a task with a connected objective for the catalog entry, Nango mapping, tests, and PR evidence. Connect GitHub first so the worker can create a branch and PR." and a button **"Create task"** (`aria-label="Create Beetle task for {name}"`), **"Connect GitHub first"** / "Opening", or disabled **"GitHub required"** (`integrations-page.tsx:540-582`). It deep-links to `/tasks?create=1&kind=integration&…`. Docs must describe this as filing a code-change task, not as enabling a connector.

### 3.6 Ownership and approval data on connections

`org_connection_secret` rows carry `created_by_user_id` (`packages/receipt-app/src/services/receipt-connect-connections.ts:81, 453, 494-497`) and `status` (`valid | expired | invalid`, `:31`), `last_validated_at`, and metadata. **The creator id is not surfaced on the Integrations page** (no "connected by" label appears in `integrations-page.tsx`). There is no approval state, reviewer, or "vetted" flag on a connection or on a catalog entry anywhere in the code (grep for `approv`/`vetted` across `components/organization/settings`, `components/mcp-gateway`, `receipt-connect-connections.ts`, `receipt-connect-connectors.ts` hits only the Policies tool-approval panel).

### 3.7 Feature classification (connector catalog)

| Feature | Status |
|---|---|
| Global Integrations page (org scope), workspace twin under MCP Gateway | reachable |
| Search, category chips, All/Connected/Available/Popular, Load more | reachable |
| Authentication-method select, "Show connected only" switch | hidden/inert (DOM `hidden`) |
| Connect via Nango session, Disconnect with confirmation | reachable |
| Manage tools and permissions allowlist per connection | reachable |
| "Build {name} with Beetle Tasks" request panel | reachable (files a task; enables nothing) |
| Connector approval / vetting state, approver, "approved for production" | absent |
| Connection owner shown in UI | absent (stored `created_by_user_id` only) |
| Dependency view between connectors and agents/skills | absent |

---

## 4. Organization skills as a catalog (brief)

Page `/organization/settings/skills`, rail item **"Skills"** (`-organization-settings-nav.ts:225-230`), owner/admin only. Title **"Skills"**, description **"Add organization instructions that agents can use in Factory and computer runs. Enabled skills are available to new runs."** (`skills-page.tsx:370-371`). Search `placeholder="Search skills"` / `aria-label="Search organization skills"` (`:422-423`); **"Add skill"** / "Adding skill" (`:435`); count line `Showing {n} of {m} matching skills ({total} total)` (`:451`); no-match **"No skills found. Try a different search."** (`:485`).

Table columns **# / Skill / Status / Version / Bundle / Updated / Actions** (`organization-skills-table.tsx:79-90`); status badge **"Archived" / "Enabled" / "Disabled"** (`:145`); row menu **"View details"**, **"Enable"/"Disable"** (absent for archived), **"Delete"** (`:190-224`). Empty state **"No organization skills yet"** / "Upload a SKILL.md bundle to make reusable instructions available to new agent and computer runs." / **"Add your first skill"** (`organization-skills-empty-state.tsx:88-93`).

Upload contract: the file must be named `SKILL.md` ("Choose a file named SKILL.md."), non-empty, and ≤ 256 KB ("Skill files must be 256 KB or smaller.") (`apps/start/src/lib/shared/org-skills.ts:2, 30-34`); server bundle limits `maxFiles 128`, `maxTotalBytes 1 MiB`, name ≤ 120, description ≤ 2000 (`packages/receipt-app/src/services/organization-skills.ts:10-14`). Versions are receipt events (`organization.skill.created`, `.version_added`, …) and each skill stores `createdBy` (`:60, 136`) — the only "ownership" data on skills, and it is the uploader's user id, not a chosen owner. Since `c3c16be6` the chat composer's "+" menu has a **"Skills"** submenu with **"Create skill"** that navigates to the Skills page (`prompt-input-actions-menu.tsx`, diff lines 125-141). No approval or review state exists on skills; enabling is a direct owner/admin toggle. The lifecycle and run-time mounting are covered by another agent.

Classification: reachable (owner/admin). "Catalog" is a fair word for the list; "approved" is not — "enabled" is the product's word.

---

## 5. Org Brain and Knowledge

### 5.1 Org Brain — `/organization/settings/knowledge-graph`

Rail item **"Org Brain"** (`-organization-settings-nav.ts:219-224`), route has no gate of its own (`knowledge-graph/route.tsx:8-12`) but sits under the owner/admin-only settings layout. Title **"Org Brain"**, description **"A shared view of how knowledge and tools connect across the organization."** (`org-knowledge-graph-page.tsx:973-974`). It is a **read-only analytics dashboard over receipt projections**, not a knowledge store and not a graph editor.

- Reporting period group (`aria-label="Reporting period"`) with 30 / 60 / 90 days (`org-knowledge-graph.types.ts:10`); freshness line ends in **"refreshes automatically"** (`:983`); placeholders **"Loading organization activity…"** / **"No activity to show yet."** (`:997-998`).
- Sections: **"Usage metrics across the organization"** (tiles **Runs, Job success, In progress, Connected apps, Avg duration, Total spend**, `:1012-1045`), **"Daily run activity"** (`:1074-1075`), **"Application usage across the organization"** — "Share of organization objectives that used each application, plus connection readiness." (`:1087-1088`) with rows like `"{valid} of {n} account(s) ready"` / "No saved account" and `aria-label="{name} used by {x} percent of objectives"` (`:512-529`), empty **"No connected applications or application activity to show yet."** (`:470`); **"Objectives"** table with "Search objectives", status filter, and "View details" (`:629-742, 1112-1113`).
- **"Not recorded"** convention: unmeasured values are rendered as "Not recorded", never zero (`:56-70`; rationale in `org-knowledge-graph.types.ts:1-8`).
- Data: `toolUsage` = distinct objectives per provider taken from each objective's `state_json->'execution'->'contract'->'capabilities'` in `receipt_objective_projection`, with provider aliases folded (github-app-oauth/github-pat → github, etc.) (`org-knowledge-graph.server.ts:216-265`); `connections` = counts of `valid/invalid/expired` per provider from `org_connection_secret` (`:196-212`).
- Server access is deliberately every member ("never per-user attribution, raw receipts, or run contents", `:19-34`), but the route guard still restricts the page to owners/admins — an inconsistency worth a doc note.

This is the strongest real evidence for "adoption patterns" and "connector health" in the positioning, at the granularity of *objectives per application* and *accounts ready per application*, refreshed every 30 seconds (`use-org-knowledge-graph.ts:11`, per the map; the "refreshes automatically" string is verified at HEAD).

### 5.2 Knowledge — `/organization/settings/knowledge` (hidden)

Nav item "Knowledge" is `hiddenFromRail` **and** `hiddenFromMenu` (`-organization-settings-nav.ts:292-299`) — direct URL only. Heading **"Organization Knowledge"**, description **"Upload Markdown or PDF files for your organization's knowledge base."**, columns File / Status / Last indexed, statuses **"Active" / "Inactive"** and **"Index error" / "Indexed" / "Pending index"**, actions **"Activate" / "Deactivate" / "Retry index" / "Delete"**, filter **"Filter knowledge files..."**, empty **"No organization knowledge files have been uploaded yet."**, button **"Upload file"** (`apps/start/messages/en.json:611-630`). Upload contract per the map (25 MB, `.pdf/.md/.markdown`) — unchanged since `41baea75` (no commits touched `org-knowledge` since then).

### 5.3 Do they belong under "Catalog"?

- **Org Brain**: partially. It is the product's only organization-wide *usage visibility* over connectors ("Application usage", "Connected apps", connection readiness). If the Catalog page needs a "usage visibility" subsection, point to Org Brain; do not describe Org Brain itself as a catalog or a knowledge graph.
- **Knowledge**: no. It is a document RAG store for chat, hidden from navigation, with no relation to connectors, skills, or agents. Leave it out of Catalog (and treat it as undocumented/hidden).

---

## 6. Approval, vetting, ownership, dependency, and adoption data — what exists

| Concept | Where it exists | What it really is |
|---|---|---|
| Approval | `ToolApprovalRule` in Policies: `tools[]`, `frequency`, `channel`, `approvers[]` (`apps/start/src/lib/shared/policies.ts:105-112`; panel `policies/tool-approval-panel.tsx:50-55` "which agent tools pause for a human before they run") | A policy record about pausing tool calls; not connector/skill/agent approval; enforcement is another agent's scope |
| "Vetted" / "approved connector" | none | absent |
| Owner (agents) | cloud tag or CloudTrail creator (`agent-cloud-discovery.ts:123-172`) | read-only, provider-derived |
| Owner (connections) | `org_connection_secret.created_by_user_id` (`receipt-connect-connections.ts:81`) | stored, not displayed |
| Owner (skills) | `createdBy` on skill events/projection (`organization-skills.ts:60, 136`) | uploader id |
| Owner (workspaces) | `receipt_workspace.created_by_user_id`, resolved to a person in "View details" since `46652e84` | shown in workspace row menu |
| Dependencies | only DI parameter names in `receipt-connect-call.ts` | absent as a feature |
| Adoption (connectors) | Org Brain `toolUsage` (objectives per provider) (`org-knowledge-graph.server.ts:216-265`) | receipt-derived, 30/60/90-day window |
| Adoption (tools/actors) | MCP Gateway "Gateway activity": `summary.totalCalls`, `successRate`, `avgResponseMs`, `activeActors`, `tools[]`, `connectors[]`, `calls[]`, timeline buckets (`mcp-gateway-activity.ts:12-100`) from `tool.called`/`tool.observed` receipts; page title **"Gateway activity"**, tabs **Dashboard / Users / Live activity**, ranges "Last 24 hours / 7 days / 30 days" (`mcp-gateway-dashboard-page.tsx:81-83, 252-262`) | workspace- or org-scoped; "Last updated {time}" on demand |
| Security posture | Agent Registry risk levels and ISM findings (§2.5); connection `status` counts in Org Brain | heuristic and best-effort |

---

## 7. Plugins

Absent. A repo-wide search for "plugin" in `apps/start/src` and `packages/receipt-app/src` returns only Better Auth plugins, Streamdown/remark rendering plugins, Codex isolation config, and the Nango display catalog's "Walmart Marketplace" entry; "marketplace" appears in two planning docs (`docs/receipt-authorization-mcp-product-plan.md:291` proposes splitting "Connections from Catalog"; `docs/slack-integration-playbook.md:35`). There is no plugin registry, plugin manifest, or plugin install flow. Docs should not use the word "plugins" for anything in the current product.

---

## 8. Access control summary

| Surface | Who can open | Who can change |
|---|---|---|
| Agent Registry (inventory, dashboard, detail, Integrations dialog) | any signed-in org member (layout only rejects anonymous; sidebar area not role-gated — `agent-registry/route.tsx:37-40`, `app-sidebar.tsx:196-206`) | owner/admin: connect, scan, refresh, disconnect (`canManage`, `agent-registry.server.ts:98, 105-107`) |
| Global Integrations | owner/admin (`settings/route.tsx:31-38`, `-organization-settings-access.ts:16`) | owner/admin (connect, disconnect, manage tools) |
| Workspace integrations (MCP Gateway) | any org member for the shell (`-organization-settings-access.ts:15`); workspace membership governs contents | workspace owner/admin (per receipt workspace roles) |
| Skills | owner/admin | owner/admin ("Only organization owners or admins can manage skills.") |
| Org Brain | owner/admin via route guard; server would allow any member | read-only |
| Knowledge | owner/admin, URL only | owner/admin |

The role model is Better Auth organization roles `owner | admin | member` (`useCanManageOrganizationSettings`, `use-auth.ts:77-99`; `isOrgAdmin`, `organization-member-role.service.ts:6-33`). There are no finer-grained roles (no "catalog curator", no per-connector approver).

---

## Changes since 41baea75

Commits: `git log --oneline 41baea75..HEAD` (43 commits). Behavioural changes relevant to this section:

**Agent Registry (stub → discovery inventory)**
- `26ec975a` — Added the receipt-backed cloud agent inventory: `agent-inventory.ts` (stream, reducer, projection), `agent-cloud-discovery.ts` (AWS Bedrock/Lambda/Step Functions, GCP Cloud Asset, Azure Resource Graph), server functions, Inventory table, Integrations dialog, risk dashboard, Azure `azure-service-principal` Nango provider and deploy patch, RCA-522 in `docs/agent-fix-checklist.md`. The placeholder "Receipt Managed / Remote" tabs, disabled "Create New Agent" menu, and "Agent registration is not available yet" footer were removed.
- `7163f21f` — Autonomy-level checkbox filter (L1-L4) in the Inventory toolbar; AWS scans every comma/whitespace-separated region in the connection config.
- `20d20f51` — Agent Registry uses its own Receipt Connect connection named `agent-registry`; Global Integrations hides connections with that name.
- `9a714448` — EC2 instance scanning (running/stopped) added to AWS.
- `296c6d22` — Bedrock agents classified L2/L3/L4 from action-group confirmation settings instead of a blanket L4.
- `cf3fadde` — Self-contained AWS/AZ/GC badges replace Nango-fetched logos.
- `a241a9b1` — AWS regions auto-discovered via `ec2:DescribeRegions` when none configured; Azure subscriptions auto-listed; owner read from tags for Bedrock/Lambda/Step Functions; Bedrock AgentCore runtimes and ECS services added; scan toasts state the real agent count; provider cards restyled.
- `b90c9070` — Disconnect per provider; `AI_SIGNAL` extended with "factory", "receipt", "beetle" and JSON-punctuation boundaries (with a regex test); every failure path reloads the inventory before toasting.
- `46652e84` (UI pass) — Row menu label "View" → "View details"; shared `Tab`/`TabList` components replace hand-rolled tabs; sidebar tooltips removed.
- `c3c16be6` — Row-level Actions menu replaces the "Recommended action" column; local error boundary for the area; the compliance register: execution-role IAM policy introspection (tools / permissions / data access) for Bedrock Agent, Lambda, Step Functions; Bedrock `instruction` as purpose; CloudTrail creator fallback for owner; ISM-coded findings and recommendations; safe defaults for old rows; detail dialog gains Credential, Purpose, Tools, Permissions, Data access, Policy findings; sidebar "Agents" area collapsed to a single "Registry" child with `/agent-registry/dashboard` redirecting to `?tab=dashboard`.

**Connector catalog / Integrations**
- `20d20f51` — hides `agent-registry` connections from Global Integrations.
- `46652e84` — "Connect" buttons restyled as green text links; MCP Gateway workspace Dashboard moved into the tab strip; CLI setup steps re-ordered.
- `68b7fa3a` — integration-surface audit fixture updated for the Azure connector (63 connectors, 91 static tools).
- No behavioural change to search, chips, tabs, pagination, permissions dialog, or the request panel. Note that the auth-method select and "Show connected only" switch were already `hidden` at `41baea75`; the map file overstated them.

**Skills**
- `46652e84` — "View" → "View details" in the row menu.
- `c3c16be6` — "Skills → Create skill" entry added to the chat composer "+" menu (an earlier Cmd+K placement was reverted within the same PR).

**Org Brain / Knowledge**
- `46652e84` — Org Brain objectives row menu "View" → "View details". No other change; Knowledge untouched.

**Access control**
- No change to `-organization-settings-access.ts` or the settings route guard (`git diff --stat 41baea75..HEAD` on both files is empty).

---

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

## Open questions

1. **What is "ISM"?** The code comment says the control ids (2113, 2133-2136, 2141-2143) came from "a customer's compliance requirement" (`agent-cloud-discovery.ts:225-230`). The docs need the framework's proper name and whether the numbers may be published.
2. **Is the "Agents" area intentionally visible to plain members?** The sidebar does not gate it and `listAgentInventoryAction` returns the full inventory (including IAM findings and owner identities) to any member; only mutations are admin-gated. Confirm whether this is the intended read policy before documenting "any member can view".
3. **Scan duration and timeouts.** Discovery runs synchronously in the server function with no overall time bound. Has a large multi-region AWS account been tested against the deployment's request timeout? A stuck `running` scan has no reaper.
4. **Should Org Brain be member-readable?** Server intent (every member) conflicts with the route guard (owner/admin).
5. **GCP and Azure permission lists.** The repo does not state which GCP IAM permissions or Azure RBAC role the scan needs; docs will have to derive them from the APIs called (Cloud Resource Manager `projects.list`, Cloud Asset `searchAllResources`, ARM `subscriptions` list, Resource Graph `resources`) or get them from the team.
6. **AWS region field.** The comment says the Nango `aws-iam` form has no region field; is there any supported way for an admin to set an explicit region list on the connection, or is the `region` config key only reachable through the API?
7. **Naming.** The sidebar says "Agents" / "Registry", the page says "Agent Registry", the code calls it "agent inventory", and the description says "Discover cloud AI agents". Which name should the public docs standardise on?
8. **Hidden Integrations filters.** Are the DOM-hidden auth-method select and "Show connected only" switch slated for removal or for return? Docs should omit them either way.
9. **Should "Kentron Catalog" be one page at all**, given the three surfaces have different audiences and navigation homes? The alternative is three pages plus an overview paragraph.
