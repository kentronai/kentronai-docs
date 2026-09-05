# App pages and sidebar (apps/start) — verified against code

Big picture: Tasks, Sessions and Computers pages are deliberately absent from the sidebar (`hideFromPrimaryNavigation: true`). Ironclad is a pure redirect to `/tasks`. Agent Registry ships two pages that are placeholders/empty. Model Gateway → Playground is a one-line stub. None of these pages use i18n. README/docs never mention any of these pages.

## Sidebar (`/(app)/_layout`)
- Layout route: `apps/start/src/routes/(app)/_layout/route.tsx:5-38` → `DashboardLayout` (`components/layout/dashboard-layout.tsx:11-34`) mounting `MainNav sidebar={AppSidebar}` plus `ChatSearchCommand`.
- Gate: only under self-hosting (`isSelfHosted`, `utils/app-feature-flags.ts:77`, from `VITE_APP_INSTANCE_MODE=self_hosted`) does it check `getSelfHostedAppAccessSnapshot()` and redirect to `/setup` when `!setupComplete`, or to `/auth/sign-in?redirect=…` when `publicAppLocked` and no non-anonymous user. Cloud mode has no layout-level auth gate.
- Sidebar component: `components/layout/app-sidebar.tsx:69-476`, 248px resizable panel.

### Exact sidebar contents, render order
1. **"New"** → `/chat`.
2. Area rows (`app-sidebar-nav.config.tsx:119-130`) filtered by role/EE:
   - **"Beetle Chat"** → `/chat`, expandable chat sidebar. Description: "Chat with Beetle to ask questions, get answers, and collaborate on tasks." (`messages/en.json:268`).
   - **"Slack"** → external `href="/api/slack/install"`.
   - **"MCP Gateway"** → `/organization/settings/workspaces`; inside a workspace children become "All workspaces" and "Dashboard".
   - **"Model Gateway"** → children **"Models"** (`/organization/settings/models`) and **"Playground"** (`/model-gateway/playground`).
   - **"Agents"** → children **"Dashboard"** (`/agent-registry/dashboard`) and **"Registry"** (`/agent-registry/registry`).
   - Org-settings areas, only when `useCanManageOrganizationSettings()` (admin role via Better Auth `getActiveMemberRole`, `lib/frontend/auth/use-auth.ts:77-99`): **"Integrations"**, **"BYOK"**, **"Org Brain"**, **"Skills"**, **"Guardrails"**, **"Policies"** — order per `ORG_SETTINGS_ITEMS` (`routes/(app)/_layout/organization/settings/-organization-settings-nav.ts:147-308`).
   - **"Singularity"** → `/singularity`, only when `isSingularityOrganizationId(activeOrganizationId)` (EE gate).
3. Footer: **"Docs"** → `https://docs.kentron.ai/introduction` (`app-sidebar.tsx:58`), **"Beetle runners"** (only nav link to `/computers`), theme toggle.
4. Header: org switcher (`SidebarOrganizationMenu`) and "Collapse sidebar" button; resize handle.

### Not in the sidebar
- `tasks`, `sessions`, `computers` hidden. `settings` area excluded; Account/Security reached from the org-avatar dropdown (`sidebar-organization-menu.tsx:41-63, 596-621`).
- Bug: Usage and Billing are `railPlacement: 'utility'` but `isUtilityNavigationArea` is never used, so they render nowhere in the sidebar; only link is from the usage page itself.

## `/tasks` — Beetle Tasks
- Route `routes/(app)/_layout/tasks/route.tsx:5-19`; redirects to sign-in when no user or anonymous. No admin gate.
- Header: **"Beetle Tasks"** / "Task workspace for Beetle, backed by connected objectives and proof-oriented agent runs."
- Data: Zero queries `recentObjectives({limit:100})`, `recentJobs({limit:100})` over `receiptObjectiveProjection` / `receiptJobProjection`, org-scoped. Only objectives with channel in `{'tasks','ironclad','auto-fix'}`. Handoff jobs (`factory.dispatch`/`factory.run`) without an objective appear as pending rows.
- Stages: new | queued | running | blocked | reviewing | done | failed | archived.
- Metric tiles: Unresolved, Running, Blocked, Done. Button **"New Task"** → `/tasks?create=1`. Section "Live runs". Empty: "No Beetle tasks yet".
- Row actions: **"Receipts"** (opens ChatReceiptsDialog), **"Thread"** → `/chat?objective=<objectiveId>`, **"Cancel"**, delete icon. Confirm dialogs "Cancel task" / "Delete objective".
- Create panel (`?create=1`): header "New task"; lanes **"Improvement check"** and **"Add/improve integration"**; fields Title, Problem, Priority (P1–P4), Scope, "Context and constraints", "Done when"; "Attach context" evidence selector; buttons Discard / Save draft (localStorage `beetle-task-draft`) / Create task. Server fn `createBeetleTask` requires non-anonymous session with active organization; writes on channel `'tasks'`.
- Inbound link: Org Settings → Integrations builds `/tasks?create=1&kind=integration&title=Add <name> integration…`.

## `/sessions` — Sessions
- Route `routes/(app)/_layout/sessions/route.tsx`; same sign-in gate. Hidden from sidebar.
- Header "Sessions" / "Find token waste, compliance risks, replay gaps, and reusable lessons from Claude activity."
- Data via `GET /api/sessions/dashboard` (requires active org, else 401) and `POST /api/sessions/evidence` `{stream, limit≤50}`. Streams limited to `imports/clauden/` and `imports/claude-code/`, max 50.
- Metrics: Sessions, Prompts, Replies, Issues, Evidence; Refresh button. List panel "Agent sessions", search "Search sessions, tags, models", tag chips. Mode tabs Checks / Replay / Lessons / Evidence. Check cards: "Token optimization", "Replay completeness", "Compliance readiness", "Lesson candidate", "Agent computer review". Right rail "Reflection" and "Recommended actions".
- Empty: "No imported sessions yet". Error: "Session data unavailable" + Retry.

## `/computers` — Computers
- Route `routes/(app)/_layout/computers/route.tsx`; sign-in gate. Reached only via footer "Beetle runners" widget (tooltip "<idle> ready, <leased> working, <waiting> waiting, <creating> warming, <unhealthy> unhealthy.").
- Header "Computers" / "opensandbox capacity and live execution output".
- Data: five Zero queries over `receiptComputerInventoryProjection`, `receiptComputerLeaseProjection`, `receiptComputerRunProjection`, `receiptComputerLiveOutputProjection`, org-scoped.
- Tiles: Ready, Leased, Running jobs, Waiting jobs, Unhealthy. Panels: "Current work" (empty "No running jobs"), "Live output" (empty "No live computer output"), "Inventory" (empty "Beetle computer standby" / "Waiting for computer logs."), "Active runs" (empty "No active runs"). Only action: "Open output" dialog with Status/Task/Trace/Job/Lease/Computer and stdout/stderr.

## `/ironclad` — redirect only
`routes/(app)/_layout/ironclad/route.tsx:3-10`: unconditional redirect to `/tasks` preserving query.

## `/agent-registry` — Agents
- Layout gate: anonymous → `/chat`. No index route; bare path 404s ("Not found" / "This page doesn't exist yet.").
- `/agent-registry/dashboard`: placeholder. Title "Dashboard", "Activity and health across the agents registered to your organization." ComingSoonPanel "The agent dashboard is on the way", badge "Coming soon".
- `/agent-registry/registry`: title "Agent Registry", "Every agent registered to your organization, and what each one is allowed to do." Data: none (`rows = []`). Tabs "Receipt Managed" / "Remote"; "Create New Agent" dropdown with both items disabled ("Build with Agent Builder", "Integrate a Remote Agent"). Footer "Agent registration is not available yet, so this list is empty."

## `/model-gateway`
- Layout: anonymous → `/chat`. No index route.
- Sidebar "Model Gateway" → "Models" (`/organization/settings/models`) and "Playground" (`/model-gateway/playground`).
- `/model-gateway/playground` is a stub: single `<h1>Playground</h1>`.

## `/organization`
Bare `<Outlet />`; real pages under `/organization/settings/*`, gated by admin role.

## Docs vs code
- README and docs never mention Tasks, Sessions, Computers, Agent Registry, Model Gateway, Ironclad. Gap, not contradiction.
- In-code inconsistencies: Usage/Billing utility group never rendered in sidebar; "88px rail" comments/tests describe a rail that no longer exists.
