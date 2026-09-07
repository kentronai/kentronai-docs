# Research 04 — The public `receipt` CLI (validated against code)

Repo: `<receipt-repo>` (HEAD `41baea75`, 2026-09-04).
All paths below are relative to `packages/receipt-app/src/` unless they start with `apps/`, `scripts/`, `docs/`, or `/`.

Primary sources read in full:

| File | Role |
|---|---|
| `connect-cli.ts` (955 lines) | Public binary entrypoint (`scripts/build-receipt-cli-release.sh:7`) |
| `services/receipt-connect-command-proxy.ts` | Target/endpoint resolution (`resolveReceiptConnectEndpoint`, L503-586) |
| `services/receipt-connect-cli-login.ts` | Device-code login client |
| `services/receipt-cli-session.ts` | `~/.receipt/session*.json` store |
| `services/receipt-connect-connectors.ts`, `services/receipt-connect-integration-registry.ts`, `integrations/nango/catalog.ts`, `integrations/nango/catalog.json`, `integrations/nango/slugs/*/provider.json` | Connector catalog (62 entries) |
| `services/receipt-mcp-cli.ts` | `receipt tools *` and `receipt mcp *` |
| `services/receipt-workspace-cli.ts` | `receipt workspace *` |
| `services/receipt-connect-agent-cli.ts` | `receipt connect list|tools|call` (env-only worker surface) |
| `services/receipt-connect-mcp.ts` | Server-side aggregate MCP (`POST /connect/mcp`), opaque tool names |
| `services/receipt-connect-call.ts`, `services/receipt-connect-connections.ts`, `services/receipt-connect-auth-token.ts` | Request parsers, selector resolution, JWT |
| `server/receipt-connect-routes.ts` | Gateway `/connect/*` handlers |
| `apps/start/src/routes/api/receipt-connect/cli-login/route.tsx`, `services/receipt-connect-device-login.ts` | Server side of the browser login |
| `scripts/build-receipt-cli-release.sh`, `scripts/install-receipt-cli.sh`, public `install.sh` (fetched from `skishore23/receipt-cli@main`, saved to `scratchpad/research/public-install.sh`) | Distribution |
| `docs/receipt-cli.md`, `docs/ai-agent-receipt-cli.md`, `docs/receipt-cli-mcp-implementation-plan.md`, `docs/receipt-real-workspaces-dev-handoff.md`, `docs/superpowers/plans/2026-09-05-mcp-gateway-connect-cli-fixes.md` | Existing prose and the (unimplemented) fix plan |

> **Important framing.** There are three CLI entrypoints in the monorepo: the operator CLI `cli.ts` (`receipt login/logout/whoami/factory/...`), the OpenSandbox worker `connect-worker-cli.ts`, and the public binary `connect-cli.ts`. The public binary is the only one end users install. It has **no** `login`, `logout`, or `whoami` command; sign-in is `receipt setup`. Several shared error strings still say `run 'receipt login' first`, which on the public binary is parsed as a bad target and fails (`docs/superpowers/plans/2026-09-05-mcp-gateway-connect-cli-fixes.md:2968-2990`). None of that plan's fixes have landed at HEAD; the last commits touching `connect-cli.ts`, `receipt-mcp-cli.ts`, and `receipt-connect-command-proxy.ts` are from 2026-08-20 (`bed10db8`, `83c376b9`).

---

## 0. Dispatch order, argument parsing, exit codes

`main()` (`connect-cli.ts:920-950`) runs in this order; the first handler that returns `true` wins:

1. `--version` / `-V` as the only argument → prints `receipt <version>` (`connect-cli.ts:922-925`). Version is the build-time constant `RECEIPT_CLI_BUILD_VERSION` (set by `bun build --define`, `scripts/build-receipt-cli-release.sh:50`), else `RECEIPT_CLI_VERSION` env, else `development` (`connect-cli.ts:40-43`).
2. `runReceiptToolsCommand` — argv[0] === `tools`.
3. `runReceiptMcpCommand` — argv[0] === `mcp`.
4. `runReceiptWorkspaceCommand` — argv[0] === `workspace`.
5. `runReceiptConnectAgentCommand` — after stripping a leading `connect`, argv[0] ∈ {`list`, `tools`, `call`}.
6. `parseArgs` → `help`/`--help`/`-h` → usage (`connect-cli.ts:931-940`).
7. `import <source>` → `runImport`; `observe <source>` → `runObserve`.
8. Everything else → `runConnect` (setup, onboarding, providers, status, disconnect).

Consequences you must document:

- **`receipt tools --help`, `receipt mcp --help`, `receipt workspace --help` do not print help.** They are dispatched before the help check and require a saved session; signed out they fail with `receipt mcp: not signed in; run 'receipt login' first` (or the workspace equivalent). With a session, `receipt mcp --help` runs `mcp status codex` (`receipt-mcp-cli.ts:637-646`). Only top-level `receipt --help` / `receipt help` / `receipt connect --help` print usage.
- **The `connect` word is optional.** `parseArgs` drops a leading `connect` (`connect-cli.ts:125`), so `receipt status` ≡ `receipt connect status`, `receipt aws` ≡ `receipt connect aws`, and bare `receipt` runs the interactive onboarding (which starts a browser login).
- **Flag parsing quirk (`connect-cli.ts:129-167`).** `--flag value` consumes the next token as the value unless that token starts with `--`. So `receipt connect --no-open status` sets `no-open="status"` and the browser still opens (the check is `flags["no-open"] === true`, `connect-cli.ts:226-229`). Put boolean flags last, or use `--flag=value` form. `--` ends flag parsing. Repeated flags accumulate; `asString` takes the last (`connect-cli.ts:172-176`).
- The `tools`/`mcp`/`workspace`/agent parsers are simpler: `--key value`, `--key=value`, boolean if no value (`receipt-mcp-cli.ts:45-69`, `receipt-workspace-cli.ts:187-203`, `receipt-connect-agent-cli.ts:14-43`). `-h` is a positional there.
- Errors: message to stderr, `process.exitCode = 1` (`connect-cli.ts:952-955`). Success output goes to stdout.

---

## 1. Target resolution and environment variables

`resolveReceiptConnectEndpoint({ target, serverUrl, authUrl })` (`receipt-connect-command-proxy.ts:503-586`) returns `{ name: "prod"|"dev"|"local"|"custom", serverUrl, authUrl }`. `serverUrl` is the Receipt Connect gateway (all `/connect/*` calls); `authUrl` hosts `/api/receipt-connect/cli-login` (the web app). Trailing slashes are stripped.

| Input | Result |
|---|---|
| no target | `prod` |
| `prod`, `production` | `prod` |
| `dev`, `development`, `staging` | `dev` |
| `local`, `localhost` | `local` |
| `http://…` / `https://…` | `custom`, `serverUrl` = that URL, `authUrl` = `--auth-url` or the same URL (`:514-522`) |
| `--server-url <url>` | `custom` regardless of target word |
| anything else | error `receipt connect target must be prod, dev, local, or an http(s) URL` (`:510-512`) |

Env lookup order (first non-empty wins; for `prod`, values whose host is `localhost`/`127.0.0.1`/`::1` are ignored via `publicEnvString`, `:312-315`):

**prod serverUrl**: `RECEIPT_CONNECT_PUBLIC_GATEWAY_URL`, `RECEIPT_CONNECT_WORKER_GATEWAY_URL`, `RECEIPT_CONNECT_PUBLIC_URL`, `RECEIPT_CONNECT_PROD_GATEWAY_URL`, `RECEIPT_CONNECT_PROD_SERVER_URL`, `RECEIPT_CONNECT_PROD_URL`, then (only when `--auth-url` is not given) `RECEIPT_CONNECT_URL`, `RECEIPT_APP_URL`; then `DEFAULT_RECEIPT_CONNECT_PROD_URL` = `RECEIPT_CONNECT_PUBLIC_GATEWAY_URL || RECEIPT_PUBLIC_BASE_URL || ""` evaluated at module load (`:51-54`); then `.sst/outputs.json` (`gatewayHttps`/`gateway`/`url`, walking up to 8 parent dirs from cwd, CloudFront hosts ignored, `:329-351`). If still empty:
`receipt connect production URL is not configured yet. Set RECEIPT_CONNECT_PUBLIC_GATEWAY_URL, RECEIPT_CONNECT_PROD_GATEWAY_URL, RECEIPT_CONNECT_PROD_URL, or RECEIPT_CONNECT_URL.` (`:570-572`).

**prod authUrl**: `--auth-url`, `RECEIPT_CONNECT_PROD_AUTH_URL`, `RECEIPT_CONNECT_PROD_URL`, `RECEIPT_CONNECT_URL`, `RECEIPT_APP_URL`, else `serverUrl` (`:579-584`).

**dev**: `RECEIPT_CONNECT_DEV_GATEWAY_URL`, `RECEIPT_CONNECT_DEV_SERVER_URL`, `RECEIPT_CONNECT_DEV_URL`, then `RECEIPT_CONNECT_DEV_URL`, `RECEIPT_DEV_APP_URL`; no default → `receipt connect dev URL is not configured. Set RECEIPT_CONNECT_DEV_GATEWAY_URL or RECEIPT_CONNECT_DEV_URL.` authUrl: `RECEIPT_CONNECT_DEV_AUTH_URL`, `RECEIPT_CONNECT_DEV_URL`, `RECEIPT_DEV_APP_URL`, else serverUrl.

**local** (`:524-539`): serverUrl = `RECEIPT_CONNECT_LOCAL_SERVER_URL` | `RECEIPT_CONNECT_GATEWAY_URL` | `RECEIPT_PROXY_SERVER_URL` | `http://127.0.0.1:${RECEIPT_PORT|PORT|8787}`; authUrl = `--auth-url` | `RECEIPT_CONNECT_LOCAL_AUTH_URL` | `RECEIPT_AUTH_URL` | `BETTER_AUTH_URL` | `VITE_BETTER_AUTH_URL` | `http://127.0.0.1:${WEB_PORT|3000}`. The public binary has no `.env` loader, so `local` means `127.0.0.1:8787`/`:3000` unless env is exported (plan Appendix A).

> **Shipped-binary reality (P0, confirmed in code):** the release build defines only `RECEIPT_CLI_BUILD_VERSION`; nothing bakes a hosted URL. On a fresh install with no env, plain `receipt setup` fails with the "production URL is not configured yet" error, and the help text "Default hosted endpoint: Uses the hosted Receipt gateway" (`connect-cli.ts:102-104`) is false (plan doc `:87`, Task 2.1 not yet implemented). Working forms today: `RECEIPT_CONNECT_PUBLIC_GATEWAY_URL=https://app.kentron.ai receipt setup` (a `prod` session) or `receipt setup --server-url https://app.kentron.ai` (a `custom` session; see §2 on target session files). Whether `app.kentron.ai` fronts both the web app and `/connect/*` is flagged for the deploy owner in plan Appendix E #9; single-host SST config `deploy/sst/single-host.ts:435` suggests yes.

Other env vars read by the CLI:

| Var | Where | Effect |
|---|---|---|
| `RECEIPT_CONNECT_OPEN_BROWSER=0` | `connect-cli.ts:227`, `receipt-connect-cli-login.ts:19` | Never spawn a browser |
| `RECEIPT_CLI_CONFIG_DIR` | `receipt-cli-session.ts:39-41` | Session dir (default `~/.receipt`) |
| `RECEIPT_CLI_SESSION_FILE` | `:43-45`, `:60` | Exact active-session path; disables per-target files |
| `RECEIPT_CONNECT_GATEWAY_URL`, `RECEIPT_CONNECT_PUBLIC_GATEWAY_URL`, `RECEIPT_CONNECT_TOKEN`, `RECEIPT_CONNECT_ORGANIZATION_ID`, `RECEIPT_CONNECT_WORKSPACE_ID`, `RECEIPT_CONNECT_WORKSPACE_NAME`, `RECEIPT_CONNECT_USER_ID` | `receipt-mcp-cli.ts:86-119`, `receipt-connect-agent-cli.ts:164-179`, `receipt-cli-session.ts:203-217` | Env identity fallback for `tools *`, `mcp serve`, and the only identity for `connect list/tools/call`; also what `setup` exports into its own process after login |
| `RECEIPT_PROXY_SERVER_URL` | agent CLI, local target | Alternate gateway var |
| `RECEIPT_DATA_DIR` | `connect-cli.ts:330-334` | Local data dir for import/observe (default `~/.receipt/data`) |
| `CODEX_HOME` | `receipt-mcp-cli.ts:244-250` | Codex config location |
| `RECEIPT_CLAUDE_PROXY_BIN`, `CLAUDEN_BIN` | `cli/clauden-import.ts:522-541` | Companion binary override |
| `RECEIPT_CLI_VERSION` | `connect-cli.ts:43` | Version string when not a compiled build |

---

## 2. Session file

Written by `writeReceiptCliSession` (`receipt-cli-session.ts:146-177`):

- Active session: `$RECEIPT_CLI_CONFIG_DIR/session.json` (default `~/.receipt/session.json`), or `$RECEIPT_CLI_SESSION_FILE`.
- Per-target copy: `session.<target>.json` for `prod`/`dev`/`local`; a `custom` target (URL or `--server-url`) writes **no** target file (`:47-65`). Non-standard names are sanitized to `[a-z0-9._-]`, max 64 chars.
- Directory created `0700`; file written to `<path>.tmp` with mode `0600`, renamed, then `chmod 0600`.
- Shape (`:8-21`):

```json
{
  "kind": "receipt.cli-session",
  "schemaVersion": 1,
  "target": "prod | dev | local | custom",
  "gatewayUrl": "https://…",
  "authUrl": "https://…",
  "token": "<Receipt Connect JWT>",
  "userId": "…", "userEmail": "…",
  "organizationId": "…",
  "workspaceId": "…", "workspaceName": "Default",
  "savedAt": "2026-…Z"
}
```

Reading (`:126-144`): with a target, try `session.<target>.json` first, then `session.json` if its `target` normalizes to the same name (a `custom` request matches any active session because `custom` normalizes to `undefined`, `:116-124`). `deleteReceiptCliSession` exists (`:179-201`) but **no public command calls it** — there is no logout; delete the files by hand (`docs/receipt-real-workspaces-dev-handoff.md:246-252` says the same).

`applyReceiptCliSessionEnvDefaults` (`:219-234`) exports `RECEIPT_CONNECT_GATEWAY_URL`, `RECEIPT_CONNECT_PUBLIC_GATEWAY_URL`, `RECEIPT_CONNECT_TOKEN`, `RECEIPT_CONNECT_ORGANIZATION_ID`, `RECEIPT_CONNECT_WORKSPACE_ID/NAME`, `RECEIPT_CONNECT_USER_ID` into the current process only, and only from `setup` (`connect-cli.ts:414,464`).

The token is an HS256 JWT (`receipt-connect-auth-token.ts:6-35`): `iss: receipt`, `aud: receipt-connect`, `sub: userId`, `org_id`, `ws_id`, `scp: ["connect:credential","connect:read","connect:write"]` (all three for CLI logins, `cli-login/route.tsx:17-21`), **12-hour TTL** (`DEFAULT_RECEIPT_CONNECT_JWT_TTL_SECONDS = 12*60*60`, `:24`). Nothing in the CLI checks expiry; after 12h every gateway call returns `unauthorized` and `receipt setup` still says "reused" — run `receipt setup --fresh-login`.

---

## 3. Browser / device login flow (end to end)

Client: `loginReceiptConnectCli` (`receipt-connect-cli-login.ts:77-182`). Server: `apps/start/src/routes/api/receipt-connect/cli-login/route.tsx` + `services/receipt-connect-device-login.ts` (Postgres table `receipt_connect_device_login`, codes stored as HMAC hashes, `:98-126`).

1. CLI prints `Starting Receipt Connect sign-in at <authUrl>...` and `POST <authUrl>/api/receipt-connect/cli-login` `{"action":"start_device"}` (15 s request timeout, `:16,55-66`).
   Server (`route.tsx:304-343`): rate limit per client IP — max 10 starts per 60 s and max 3 concurrently pending → `429 {"error":"rate_limited","retryAfter":60}`; creates a 32-byte base64url `deviceCode` and an 8-char `userCode` `XXXX-XXXX` from alphabet `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (`device-login.ts:43-45,92-96`); TTL 10 min. Response: `{ok, deviceCode, userCode, verificationUri, verificationUriComplete: "<publicOrigin>/api/receipt-connect/cli-login?user_code=XXXX-XXXX", expiresIn: 600, interval: 2}`. `publicOrigin` = first parseable of `RECEIPT_CONNECT_PUBLIC_GATEWAY_URL`, `RECEIPT_CONNECT_GATEWAY_URL`, `RECEIPT_SERVICE_GATEWAY_URL`, `BETTER_AUTH_URL`, `VITE_BETTER_AUTH_URL`, else `X-Forwarded-Host`/`Host` (`route.tsx:50-88`).
2. CLI prints:
   ```
   Step 1 of 2: sign in to Receipt
     Open: https://…/api/receipt-connect/cli-login?user_code=ABCD-EFGH
     Code: ABCD-EFGH
     Approve the CLI from the workspace that should own these connections.
   ```
   and opens the URL with `open` / `xdg-open` / `cmd /c start` unless disabled (`:105-113`).
3. Browser `GET …?user_code=` (`route.tsx:195-258`): no Better Auth session → `302 /auth/sign-in?redirect=<path>`; session without `activeOrganizationId` → `409` page "Select a workspace first … Open Receipt, select a workspace, then run the CLI command again."; valid → row marked approved with user id/email/org/session id → `200` page "Receipt Connect is approved. You can return to the terminal."; unknown/expired → `404` "This Receipt Connect code is invalid or expired."; already consumed → `409` "This Receipt Connect code was already used. Run the CLI command again."
4. CLI polls `POST {"action":"poll_device","deviceCode"}` every `interval` s (default 2 s) for up to 10 min (`:115-180`). `428 {"error":"authorization_pending"}` → keep polling; `400 {"error":"expired_token"}` → `receipt connect device login expired`; success → `{ok, token, userId, userEmail, organizationId, workspaceId, workspaceName:"Default"}` and the row is consumed (single use, `device-login.ts:342-351`). The workspace is always the organization's deterministic **Default** workspace (`route.tsx:31-34,365-373`).
5. CLI prints `Receipt sign-in approved.`

Client-side errors: `receipt connect device login request failed for <url>: <msg>` (network/timeout), `receipt connect device login failed to start: <error|http_NNN>` (e.g. `rate_limited`, `receipt_connect_storage_unavailable`, `http_404` when `authUrl` is not the web app), `receipt connect device login returned an empty token`, `receipt connect login did not return a workspace; select a Receipt workspace and try again`, `receipt connect device login failed: <error>`, `receipt connect device login timed out`.

---

## 4. `receipt setup` (aliases `receipt connect setup|doctor|check`)

`runSetup` (`connect-cli.ts:613-650`) = `setupReceiptLogin` + `setupClaudenObserver` + print. Despite `docs/receipt-cli.md:56-58`, it does **not** start provider onboarding; it signs in, installs the Claude observer if the companion binary exists, and prints the connector catalog.

| Flag | Type | Default | Effect (source) |
|---|---|---|---|
| `--target <prod|dev|local|url>` | string | prod | endpoint selection (`:400`) |
| `--server-url <url>` | string | — | custom gateway (`:401`) |
| `--auth-url <url>` | string | — | web origin for login (`:402`) |
| `--fresh-login` | bool | false | ignore saved session (`:410`) |
| `--no-login`, `--skip-login`, `--local-only`, `--localOnly` | bool | false | skip sign-in entirely (`:365-369`) |
| `--no-claude`, `--no-observer`, `--no-background`, `--skip-claude` | bool | false | skip observer install (`:359-363`) |
| `--no-open`, `--open=false`, env `RECEIPT_CONNECT_OPEN_BROWSER=0` | bool | — | print URL, do not open browser (`:226-229`) |
| `--json` | bool | false | JSON envelope, suppresses status lines (`:430,616`) |
| `--proxy-bin <path>`, `--mode`, `--event-log`, … | | | forwarded to observer install (`cli/clauden-import.ts:522-541`) |

Steps: resolve endpoint → `readReceiptCliSession({target})` → if a session exists, `--fresh-login` is absent, and its `gatewayUrl` equals `serverUrl` (localhost/127.0.0.1 normalized), reuse it and return `{reused:true,…}` (`:406-428`); else device login → `writeReceiptCliSession` → export env defaults.

Text output:

```
Receipt account: connected to workspace Default (<workspaceId>)
Receipt Connect connectors:
  aws: AWS via real 'aws' CLI
  gcp: Google Cloud via real 'gcloud' CLI
  google-ads: Google Ads via real 'nango' CLI
  … (62 lines)
Claude observer: not installed (Unable to find the Claude observer companion binary. Install a Receipt CLI release that bundles receipt-claude-proxy, or pass --proxy-bin <path> / set RECEIPT_CLAUDE_PROXY_BIN.)
```
or `Receipt account: not connected (disabled by setup flag)` and `Claude observer: installed (launchd <serviceFile>)`.

`--json` output: `{ ok, receiptAccount: {ok, reused|skipped, target, gatewayUrl, userId, userEmail, organizationId, workspaceId, workspaceName, sessionFile, targetSessionFile}, connectors: [<full catalog definitions>], claudeObserver: {...} }` (`:616-629`).

Observer install (`setupClaudenObserver`, `:480-506`) resolves the companion from `--proxy-bin`/`--clauden-bin`/`RECEIPT_CLAUDE_PROXY_BIN`/`CLAUDEN_BIN`, then `receipt-claude-proxy` or `clauden` next to the binary or on PATH; if missing it is reported as skipped, not an error. Background service is launchd (macOS) or systemd (Linux) only (`cli/clauden-service.ts:62-70`).

---

## 5. `receipt workspace …`

`runReceiptWorkspaceCommand` (`receipt-workspace-cli.ts:181-387`). Requires a saved session (env fallback is **not** accepted here): `receipt workspace: not signed in; run 'receipt login' first` (`:207-210` — the hint is wrong for the public binary; use `receipt setup`). All requests go to `<gatewayUrl>/connect/workspaces…` with `Authorization: Bearer <token>`, 35 s timeout (`:78-105`).

| Flag | Applies to | Effect |
|---|---|---|
| `--json` | all | JSON envelope |
| `--target <name>` | all | choose `session.<target>.json` |

| Subcommand | Positionals | Request | Output (text) |
|---|---|---|---|
| `current` (default), `identity` | — | `GET /connect/workspaces` | `Name (id) [Default]` |
| `list` | — | `GET /connect/workspaces` | `* Name (id) [Default]` per row, `*` marks current |
| `create <name…>` | name (words joined) | `POST /connect/workspaces {name}` (needs org owner/admin: `organization owner or admin permission is required`, 403) | `Name (id)` |
| `rename [<workspace>] <name…>` | selector optional (only when ≥2 positionals), else current | `PATCH /connect/workspaces/:id {name}` | `Name (id)` |
| `use <workspace>` | id, slug, or name (case-insensitive; ambiguous → `workspace 'x' is ambiguous; use its id`; missing → `workspace 'x' was not found`) | `POST /connect/workspaces/:id/token` → new JWT with `ws_id` = that workspace; session rewritten | `Name (id)`; JSON adds `sessionFile`, `targetSessionFile` |
| `delete <workspace>` | selector | `DELETE /connect/workspaces/:id` | `Deleted workspace <id>`; refuses current: `cannot delete the current workspace; switch to another workspace first`; server refuses Default: `the Default workspace cannot be deleted` (409) |

Side effects on `current`/`list` (`:220-273`): if the saved `workspaceId`/`workspaceName` differ from the server's current workspace, the session file is rewritten; if the saved workspace no longer exists, a token for the server's current workspace is minted and saved. `persistCurrentWorkspace` refuses a workspace from another org (`:144-148`).

Server errors surface verbatim (`server/receipt-connect-routes.ts:896-905`, `services/receipt-workspaces.ts`): `unauthorized` (401), `workspace_membership_required` (403), `workspace not found` (404), `a workspace with this name already exists` (409), `workspace name is too long` / `workspace name uses a reserved system prefix` (400), `receipt_workspace_unavailable` (503). Unknown subcommand: `receipt workspace supports list, current, create, rename, use, and delete`.

**"Workspace-bound token"**: the JWT carries `ws_id`; every `/connect/*` handler checks `hasCurrentWorkspaceMembership` (`routes.ts:766-806`) and lists/calls only connections bound to that workspace. Device login always binds to Default; `workspace use` is the only command that replaces the JWT (`receipt-workspace-cli.ts:175-180`).

---

## 6. `receipt tools …` (aggregate, workspace-wide)

`runReceiptToolsCommand` (`receipt-mcp-cli.ts:472-575`). Identity: saved session (optionally `--target`) **or** env fallback (`RECEIPT_CONNECT_GATEWAY_URL`/`RECEIPT_CONNECT_PUBLIC_GATEWAY_URL` + `RECEIPT_CONNECT_TOKEN` + `RECEIPT_CONNECT_ORGANIZATION_ID`, `:79-127`). Signed out: `receipt mcp: not signed in; run 'receipt login' first` (note the `receipt mcp:` prefix even for `tools`).

| Flag | Type | Effect |
|---|---|---|
| `--connection <id|provider:name>` | string | narrow to one connection via `/connect/tools` + `/connect/call` instead of the aggregate MCP |
| `--json '<object>'` | JSON object | tool arguments (`call`); default `{}`; invalid → `--json must be a JSON object` |
| `--target <name>` | string | session selection |
| `--server-url <url>` | string | override gateway |
| `--output <path>` / `--output-file <path>` | string | write envelope to file (atomic, 0600) and print `{ok, outputFile, bytes}` |

| Subcommand | Behaviour |
|---|---|
| `list [<connection>]` | no connection → JSON-RPC `tools/list` to `POST <gateway>/connect/mcp`; with connection → `POST /connect/tools {connection}` |
| `describe <tool>` | lists (aggregate or `--connection`) and returns `{ok, tool}` for the exact name; else `Receipt tool '<name>' was not found` |
| `call <tool> [--json …]` | aggregate: JSON-RPC `tools/call {name, arguments}`; with `--connection`: `POST /connect/call {connection, tool, arguments}` |

Output envelope: `{ ok: true, ...result, workspace: {kind:"workspace", id, name, organizationId} }` (or `{kind:"organization-default", id:<orgId>, organizationId}` for legacy sessions without `workspaceId`, `:200-212`). For aggregate calls, a provider-side failure is a normal MCP result with `isError: true` and `content[0].text` (`receipt-connect-mcp.ts:263-274`), so the CLI still prints `ok: true`; JSON-RPC errors (`Unknown or unavailable tool`, `Invalid params`, `Receipt MCP discovery failed`) throw. HTTP failures: `unauthorized` / `workspace_membership_required` / `Receipt MCP returned HTTP <n>`.

**"Published tool name" / "opaque alias"** (`receipt-connect-mcp.ts:110-139`): `receipt_<provider>_<connection-name>_<upstream-tool>_<20-hex>` where the hex is the first 20 chars of sha256 over `[connection.id, provider, name, upstreamToolName]`; non-alphanumerics become `_`; total ≤128 chars. Example shape: `receipt_github_work_list_repositories_3f9a…`. It maps server-side to the exact stored connection id and reviewed upstream tool; clients must copy it from `tools list`, never construct it (MCP `instructions`, `:27-28`). Two same-provider connections therefore never collide (collision → `Receipt MCP tool alias collision`).

What appears in `tools list` (`receipt-connect-mcp.ts:154-247`): only connections with `kind: nango-reference` and `status: valid` in the token's workspace; per connector: typed manifest tools (`apiProxy.kind: proxy-tools`), or the single GET-only `read-provider-resource` for Nango-credential connectors without a manifest and for Atlassian OAuth; **provider-native MCP connectors (`linear`, `google-calendar-mcp`) are excluded** from the aggregate list; write tools appear only when the token has `connect:write` and the connection policy enables them.

---

## 7. `receipt mcp …`

`runReceiptMcpCommand` (`receipt-mcp-cli.ts:631-778`). Identity is resolved **before** any subcommand (env fallback only for `serve`), so `config`/`status` need a session.

| Flag | Type | Default | Effect |
|---|---|---|---|
| positional 2 / `--client <name>` | string | `codex` | client; `codex` → TOML, **any other name** → generic JSON (`:666-670`) |
| `--name <n>` | string | `receipt` | MCP server name |
| `--receipt-bin <path>` | string | current executable | launcher command in generated config (`:159-182`) |
| `--target`, `--server-url` | string | — | identity/gateway |
| `--output <path>` / `--output-file` | string | — | `config` only: write file (whole-file replace, 0600) |
| `--json` | bool | — | `config` only: `{ok, client, config, content, output}` |
| `--dry-run` | bool | — | `install|remove`: print plan, change nothing |
| `--client-bin <path>` | string | `codex` | Codex executable |
| `--client-config <path>` | string | — | must equal the Codex config path or error `Codex does not accept an arbitrary config path; expected …` |

Subcommands (default `status`):

- `serve` — stdio bridge (`serveReceiptMcpStdio`, `:582-629`): reads one JSON-RPC message per stdin line, `POST <gateway>/connect/mcp` with `Authorization: Bearer <session token>`, `Accept: application/json, text/event-stream`, forwards `Mcp-Session-Id`; writes each response line to stdout; failures become `{"jsonrpc":"2.0","id":…,"error":{"code":-32603,"message":…}}`, notifications never get a response. 35 s per request.
- `config [codex|generic] [--output …]` — Codex TOML:
  ```toml
  [mcp_servers."receipt"]
  command = "/Users/me/.local/bin/receipt"
  args = ["mcp", "serve"]
  ```
  Generic JSON (`:214-230`):
  ```json
  { "kind": "receipt.mcp-client-config", "schemaVersion": 1, "name": "receipt",
    "transport": "stdio", "command": "/abs/receipt", "args": ["mcp","serve"],
    "remote": { "url": "https://<gateway>/connect/mcp" },
    "workspace": { "kind": "workspace", "id": "…", "name": "Default", "organizationId": "…" } }
  ```
  `remote.url` is informational; the token is never written (`assertTokenFreeClientConfig`, `:312-327`). Warning: `--output` overwrites the whole target file with no merge — do not point it at `~/.cursor/mcp.json` (plan Appendix A).
- `status [codex]` — runs `codex mcp get receipt --json`; prints `{ok, client, name, installed, configPath, config, workspace, remote}`.
- `install codex` — refuses non-codex (`receipt mcp install/status/remove currently supports codex; use 'receipt mcp config --client generic' for other clients`); refuses if already installed (`Codex MCP server 'receipt' is already installed; remove it first`); backs up `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`) to `<config>.receipt-backup-<timestamp>`, runs `codex mcp add receipt -- <receipt> mcp serve`, re-reads `codex mcp get`, restores backup on any failure (`codex mcp install failed and the prior config was restored: …`, `codex did not report the installed Receipt MCP server; …`). Prints `{ok, client, name, installed, removed:false, configPath, backupPath, workspace, remote}`.
- `remove codex` — `codex mcp remove receipt` with the same backup/rollback; not installed → `{ok, removed:false, installed:false}`.
- unknown → `receipt mcp supports config, install, status, remove, and serve`.

Server side of `mcp serve` (`server/receipt-connect-routes.ts:836-895`, `services/receipt-connect-mcp.ts:283-397`): requires `connect:credential` scope and workspace membership; `initialize` (protocol `2025-11-25` or `2025-06-18`, else the first) returns `serverInfo {name:"receipt-connect", version:"1.0.0"}`, `capabilities.tools.listChanged=false`, and the `instructions` string; `notifications/initialized` → 202; `tools/list` (no cursor support); `tools/call`; others → `Method not found`.

---

## 8. `receipt connect …` (onboarding, providers, status, disconnect)

All of these go through `runConnect` (`connect-cli.ts:828-918`) and **always start a fresh browser device login** (`login()` at `:802-813`, called at `:885`) — the saved session from `receipt setup` is not consulted (plan Issue 4, Task 4.2 unimplemented). Target word or URL may follow the subcommand: `receipt connect status local`, `receipt connect aws dev`, `receipt connect github https://gw.example.com` (`:860-872`).

Common flags: `--server-url`, `--auth-url`, `--no-open`/`--open=false`, `--help`/`-h`.

### 8.1 `receipt connect` / `onboard` / `onboarding` / `start` / `prod` / `dev` / `local` / `<url>`
`commandConnectOnboarding` (`:733-775`). Prints:
```
Receipt Connect onboarding
Credentials are approved with your Receipt account and stored for the active workspace only.
The CLI will show account metadata, not secret values.
Signed in: user@example.com
Workspace: Default (<workspaceId>)
Current connections: none            # or one line per connection, see 8.3
What do you want to connect?
  1. AWS
  2. Google Cloud
  …
  63. Show status only
Choose [1]:
```
Non-TTY picks the default (index 1 = AWS). `--provider <id>` skips the menu. **Bug (plan Issue 3, confirmed at `:753-774`)**: a numbered pick returns the display label, lower-cases it, and looks it up in the alias map; labels with spaces/parentheses (`Google Cloud`, `Terraform Cloud`, `Azure DevOps`, `Jira OAuth`, `Zoho CRM`, …) fail with `unsupported Receipt Connect onboarding choice: <Label>` before any request. Use `receipt connect <id>` or `--provider <id>` instead.

### 8.2 `receipt connect <provider-id-or-alias>`
`commandConnectNangoProvider` (`:652-693`).

| Flag | Type | Default | Effect |
|---|---|---|---|
| `--email <addr>` | string | — | sent as `endUserEmail` to Nango |
| `--yes`, `--auto-open` | bool | — | skip the "Press Enter" pause |
| `--no-wait` | bool | — | return right after opening the link (`--wait false` does **not** work: `flags.wait === false` is never true, `:677`) |
| `--timeout-ms <n>` | number | 600000 | polling budget |
| `--no-open` | bool | — | print link only |

Steps: (1) device login; (2) `POST <gateway>/connect/nango/sessions {provider[, endUserEmail]}` — server requires `connect:write` **and** workspace mutation authority (403 `workspace_membership_required`), Nango configured (503 `Receipt Connect Nango is not configured…`), a known connector or Nango integration (400 `Unsupported connector. Use one of: aws, gcp, …, or any integration configured in Nango.`); connection name is always `default` because the CLI sends none (`routes.ts:1807-1810`); if a `provider:default` reference already exists a Nango **reconnect** session is created instead (`:1839-1852`); (3) prints
```
Step 2 of 2: authorize aws
  Open: https://<nango>/connect?session_token=…
  Press Enter to open aws authorization...
```
(4) unless `--no-wait`, prints `Waiting for aws authorization to complete...` and polls `GET /connect/connections` every 2 s until a connection with that provider has `status: "valid"` (`:295-313`) — note it matches any valid connection of that provider, so an existing valid one returns immediately; timeout → `Timed out waiting for aws connection.`; success → `receipt connect: aws connection 'default' is ready for server jobs.`; with `--no-wait` → `After authorization completes, run 'receipt connect status' to verify the aws connection.`; no link → `Nango did not return a connect link.`

Unknown provider word → `unsupported Receipt Connect provider. Use aws, gcp, google-ads, ….` (`:913-917`). `receipt connect relay` → `receipt connect relay has been removed. Use \`receipt connect aws|gcp|…\` …` (`:815-826`).

**Named connections (`aws.prod`)**: the public CLI cannot create them (no `--name`). They are created in the web UI; the gateway then exposes them as capability keys `<provider>` for `default` and `<provider>.<name>` otherwise (`receipt-connect-connections.ts:543-549`) and Factory runtimes write AWS profiles `receipt` (default) and `receipt-<name>` (`services/factory/lima-receipt-connect-provider-aws.ts:22-28`). Selectors for `tools`/`call` are `<connection id>` or `<provider>:<name>` (`receipt-connect-connections.ts:1370-1400`).

### 8.3 `receipt connect status [<target>]`
`GET /connect/connections` (server also runs a best-effort Nango sync first, `routes.ts:1421-1424`). Output:
```
receipt connect status:
Current connections:
  aws:default valid - account 123456789012 / arn:aws:iam::…:user/x / expires 2026-…
  github:work valid
```
or `receipt connect status: no server-side connections configured`. Errors: `unauthorized`, `workspace_membership_required`, `receipt_connect_storage_unavailable`, `HTTP <n>`.

### 8.4 `receipt connect disconnect|remove|revoke [--provider <p>] [--name <n>]`
Defaults `--provider aws --name default` (`:782-783`). Finds the match in `/connect/connections`, then `DELETE /connect/connections/<id>` (needs `connect:write` + mutation authority; Nango deletion failure → 502 `integration_connection_delete_failed`). Prints `receipt connect disconnect: removed aws:default` or `receipt connect disconnect: no aws:default connection found`.

### 8.5 `receipt connect list | tools | call` (agent surface; env-only)
`runReceiptConnectAgentCommand` (`receipt-connect-agent-cli.ts:118-221`). Identity comes **only** from `--server-url` / `RECEIPT_CONNECT_GATEWAY_URL` / `RECEIPT_PROXY_SERVER_URL` and `RECEIPT_CONNECT_TOKEN`; the saved session is not read (plan Issue 4). Errors: `Receipt Connect gateway is unavailable; set RECEIPT_CONNECT_GATEWAY_URL`, `Receipt Connect task token is unavailable; set RECEIPT_CONNECT_TOKEN`. Workaround for a human: `export RECEIPT_CONNECT_GATEWAY_URL=$(jq -r .gatewayUrl ~/.receipt/session.json) RECEIPT_CONNECT_TOKEN=$(jq -r .token ~/.receipt/session.json)`.

| Command | Request | Output |
|---|---|---|
| `list [--json]` | `GET /connect/agent/connections` (only valid `nango-reference` rows; fields `id, provider, name, status`, `routes.ts:1046-1088`) | `Current connections:` + `  github:work valid` lines, or `{ok, connections}` |
| `tools <connection>` | `POST /connect/tools {connection}` | `{ok, connection:{…}, tools:[{name, description, access:"read"|"write", inputSchema…}]}` |
| `call <connection> <tool> [--json '{…}']` | `POST /connect/call {connection, tool, arguments}` | `{ok, connection, tool, access, result, artifacts}` |
| `call <connection> --path /x [--query-json '{…}'] [--headers-json '{…}'] [--method GET]` | `POST /connect/call {connection, method:"GET", path, query?, headers?}` | provider JSON |

Client errors: `receipt connect tools requires a connection id or provider:name`, `--json must contain valid JSON`, `--json must contain a JSON object`, `receipt connect call is read-only and supports GET only`, `receipt connect call requires --path beginning with /`. Server errors (400 unless noted, `receipt-connect-call.ts:190-400`): `connection must be a non-empty string`, `unexpected field 'x'`, `arguments must be an object`, `path must be a safe provider-relative absolute path` (no `//`, `\`, `#`, `.`/`..` segments, encoded slashes, or `/https:` prefix; ≤4096 chars), `body is not allowed on read-only integration calls`, `header 'x' is not allowed`, `query 'k' has an unsupported value`, `integration action '<tool>' requires connect:write`, `integration action not found or disabled` (404), reauthorization → 409 with `reconnectRequired: true`, `integration_request_failed` (502).

**"GET-only `--path` escape hatch"**: the provider-relative read. On the CLI it is `connect call <connection> --path …`; in MCP/`tools` it is the reviewed tool `read-provider-resource` with arguments `{path, query}` (`receipt-connect-connectors.ts:42-43`, `receipt-connect-call.ts:746-775`, ≤100 query params, values ≤8192 chars). Every call is recorded as a tool receipt named `<connection>:GET <path>` (`routes.ts:1188-1220`). Plan Appendix A notes the raw route is not gated for typed connectors (open decision).

---

## 9. `receipt import clauden` / `receipt observe clauden …` (brief; researched elsewhere)

`runImport`/`runObserve` (`connect-cli.ts:508-571`). Sources: `clauden` or `claude-code`; observer service actions `install|status|…` from `cli/clauden-service.ts:58-60` (macOS launchd / Linux systemd only); `install` requires the companion binary; data dir `RECEIPT_DATA_DIR` or `~/.receipt/data`; `--output-file` writes the JSON result. Errors: `import source is required. Supported sources: clauden, claude-code`, `observe source is required…`, `observe claude-code supports live file tailing only; use observe clauden install for proxy service install`.

---

## 10. Connector catalog (62 entries, `integrations/nango/catalog.json` + `slugs/*/provider.json`)

Resolution: `normalizeReceiptConnectConnectorId` is an exact lower-case lookup in a map built from each entry's `aliases` plus its `productId` when the entry is the product's default auth mode (`receipt-connect-integration-registry.ts:101-111`). So `jira` → `jira-oauth`, `confluence` → `confluence-oauth`, `tiktok` → `tiktok-ads`. Display labels are not aliases.

Runtime column: **native CLI** = a real provider CLI is configured in Factory runtimes (`credentialMode` ≠ `nango-credentials`); **Nango helper** = `command: nango`, credentials materialized through Receipt's credential helper. Tool surface per `receiptConnectConnectorToolCapability` (`receipt-connect-connectors.ts:128-178`).

| id | Label | Aliases | Auth mode (Nango slug) | Runtime / credentialMode | Tool surface |
|---|---|---|---|---|---|
| `aws` | AWS | aws, cloudwatch, ec2, ecs, eks, elb, iam, lambda, rds, s3, vpc | provider-only (`aws-iam`, access key pair) | native `aws` / aws-credential-process | command-auth (no tools) |
| `gcp` | Google Cloud | gcp, gcloud, gcs, google, google-cloud, googlecloud, gsutil, bq, bigquery | OAuth 2.0 (`google`) | native `gcloud` / gcloud-config | typed: 5 read |
| `google-ads` | Google Ads | google-ads, googleads, adwords | OAuth 2.0 | Nango helper | compatibility-read |
| `google-analytics` | Google Analytics | google-analytics, ga4 | OAuth 2.0 | Nango helper | typed: 2 read |
| `youtube` | YouTube Analytics | youtube, youtube-analytics | OAuth 2.0 | Nango helper | typed: 2 read |
| `google-docs` | Google Docs | google-docs, googledocs, gdocs | OAuth 2.0 | Nango helper | typed: 2 read |
| `google-mail` | Gmail | google-mail, gmail | OAuth 2.0 | Nango helper | typed: 4 read |
| `google-calendar` | Google Calendar | google-calendar, gcal, googlecalendar | OAuth 2.0 | Nango helper | compatibility-read |
| `google-calendar-mcp` | Google Calendar (MCP) | google-calendar-mcp, gcal-mcp | OAuth 2.0 | Nango helper | provider-mcp (dynamic; excluded from aggregate) |
| `google-sheet` | Google Sheets | google-sheet, google-sheets, gsheets, googlesheets | OAuth 2.0 | Nango helper | compatibility-read |
| `google-drive` | Google Drive | google-drive, gdrive, googledrive | OAuth 2.0 | Nango helper | typed: 2 read |
| `google-slides` | Google Slides | google-slides, gslides, googleslides | OAuth 2.0 | Nango helper | typed: 2 read |
| `google-chat` | Google Chat | google-chat, googlechat, gchat | OAuth 2.0 | Nango helper | typed: 3 read |
| `google-tasks` | Google Tasks | google-tasks, googletasks, gtasks | OAuth 2.0 | Nango helper | typed: 3 read |
| `jira-oauth` | Jira OAuth | jira-oauth, **jira** (product default) | OAuth (`atlassian`) | native `jira` / jira-config | resource-aware-get (1 read) |
| `jira-api` | Jira API Token | jira-api, jira-basic | API Token (`jira-basic`) | native `jira` / jira-config | command-auth |
| `notion` | Notion | notion | OAuth 2.0 | Nango helper | compatibility-read |
| `lagrowthmachine` | La Growth Machine | lagrowthmachine | API Key | Nango helper | compatibility-read |
| `linkedin` | LinkedIn | linkedin | OAuth 2.0 | Nango helper | compatibility-read |
| `gong-oauth` | Gong (Oauth) | gong-oauth | OAuth 2.0 | Nango helper | compatibility-read |
| `stripe-app` | Stripe App | stripe-app | OAuth 2.0 | Nango helper | compatibility-read |
| `github` | GitHub | github, gh | OAuth 2.0 | Nango helper | compatibility-read (+ repository selection policy) |
| `github-app-oauth` | GitHub (App OAuth) | github-app-oauth | custom | Nango helper | compatibility-read |
| `github-pat` | GitHub (Personal Access Token) | github-pat | provider-only | Nango helper | compatibility-read |
| `hubspot` | HubSpot | hubspot | OAuth 2.0 | Nango helper | compatibility-read |
| `airtable` | Airtable | airtable, airtable-oauth | OAuth 2.0 | Nango helper | typed: 4 read |
| `meta-marketing-api` | Meta Marketing API | meta-marketing-api, meta-ads, facebook-ads, facebook-analytics | OAuth 2.0 | Nango helper | compatibility-read |
| `apollo` | Apollo | apollo, apollo-api-key | API Key | Nango helper | typed: 1 read, 3 write |
| `attio` | Attio | attio | OAuth 2.0 | Nango helper | compatibility-read |
| `zendesk` | Zendesk | zendesk, zendesk-oauth, zendesk-api-key | OAuth 2.0 | Nango helper | compatibility-read |
| `gitlab` | GitLab | gitlab | provider-only (`gitlab-pat`) | Nango helper | compatibility-read |
| `slack` | Slack | slack | OAuth 2.0 | Nango helper | compatibility-read |
| `linear` | Linear | linear | provider-only (`linear-mcp`) | Nango helper | provider-mcp (dynamic; excluded from aggregate) |
| `datadog` | Datadog | datadog, dd | provider-only | Nango helper | compatibility-read |
| `sentry` | Sentry | sentry | provider-only | Nango helper | compatibility-read |
| `cloudflare` | Cloudflare | cloudflare, cf | provider-only | Nango helper | compatibility-read |
| `vercel` | Vercel | vercel | provider-only | Nango helper | compatibility-read |
| `terraform` | Terraform Cloud | terraform, terraform-cloud, tfcloud, tfc | provider-only | Nango helper | compatibility-read |
| `incident-io` | Incident.io | incident-io, incident.io, incidentio | provider-only | Nango helper | compatibility-read |
| `azure-devops` | Azure DevOps | azure-devops, ado, azuredevops | OAuth 2.0 | Nango helper | compatibility-read |
| `confluence-oauth` | Confluence OAuth | confluence-oauth, **confluence** (product default) | OAuth (`confluence`) | Nango helper | resource-aware-get |
| `confluence-api` | Confluence API Token | confluence-api, confluence-basic | API Token (`confluence-basic`) | Nango helper | compatibility-read |
| `anthropic` | Anthropic | anthropic | provider-only | Nango helper | compatibility-read |
| `openai` | OpenAI | openai | provider-only | Nango helper | compatibility-read |
| `zoom` | Zoom | zoom | OAuth 2.0 | Nango helper | compatibility-read |
| `zoominfo` | ZoomInfo | zoominfo | OAuth 2.0 | Nango helper | compatibility-read |
| `zoho` | Zoho | zoho | OAuth 2.0 | Nango helper | compatibility-read |
| `zoho-crm`, `zoho-books`, `zoho-desk`, `zoho-calendar`, `zoho-inventory`, `zoho-mail`, `zoho-recruit`, `zoho-people`, `zoho-invoice` | Zoho CRM / Books / Desk / Calendar / Inventory / Mail / Recruit / People / Invoice | same as id | OAuth 2.0 | Nango helper | compatibility-read |
| `instagram` | Instagram Insights | instagram, instagram-analytics, instagram-insights | OAuth 2.0 | Nango helper | typed: 3 read |
| `tiktok-ads` | TikTok Ads Analytics | tiktok, tiktok-ads, tiktok-analytics | OAuth 2.0 | Nango helper | typed: 2 read |
| `tiktok-accounts` | TikTok Accounts | tiktok-accounts, tiktok-business-accounts | OAuth 2.0 | Nango helper | typed: 2 read |
| `tiktok-personal` | TikTok Personal | tiktok-personal, tiktok-login-kit | OAuth 2.0 | Nango helper | typed: 2 read |
| `outlook` | Outlook | outlook, microsoft-outlook, outlook-mail | OAuth 2.0 | Nango helper | typed: 4 read |
| `azure-blob-storage` | Azure Blob Storage | azure-blob-storage, azure-blob, azure-storage | OAuth 2.0 | Nango helper | typed: 2 read |

"provider-only" setup means Nango's Connect UI collects the credential directly (API key/PAT/access keys) and the gateway auto-creates the Nango integration if it is missing (`routes.ts:1782-1806`); "OAuth 2.0"/"custom" require the operator to configure the Nango integration (`<integrationEnv>` override, e.g. `Set RECEIPT_INTEGRATIONS_… if your Nango integration uses a different unique_key.` in 400 errors, `routes.ts:636-657`).

Per-provider runtime notes (from `docs/receipt-cli.md:176-196`, confirmed by `lima-receipt-connect-provider-aws.ts` and `receipt-connect-connectors.ts:197-271`): AWS → `aws` CLI with generated `credential_process` (profiles `receipt` / `receipt-<name>`); GCP → isolated `gcloud` config; Jira → pinned `jira` CLI with generated config; Kubernetes exec-credential helper exists in code (`kubectlExecCredentialFromNangoCredentials`) but no catalog entry uses `kubeconfig-exec`; everything else → Nango-backed credential helper. Raw provider secrets are never injected into agent environments.

---

## 11. Installer and distribution

**Public installer** (`https://raw.githubusercontent.com/kentronai/receipt-cli/main/install.sh`, fetched 2026-09-05; copy in `scratchpad/research/public-install.sh`):

- `RECEIPT_CLI_VERSION` default `v0.1.0-preview.6`; `RECEIPT_CLI_REPO` default `skishore23/receipt-cli`; `RECEIPT_CLI_BIN_DIR` default `~/.local/bin`; `RECEIPT_CLI_BIN` default `$RECEIPT_CLI_BIN_DIR/receipt`.
- Requires `curl`, `tar`, and `shasum` or `sha256sum`. Platforms: Darwin/Linux × arm64(aarch64)/x64(amd64); others → `Unsupported OS`/`Unsupported architecture`. No Windows, npm, or Homebrew.
- Downloads `receipt-<os>-<arch>.tar.gz` and `checksums.txt` from `https://github.com/<repo>/releases/download/<version>/`, verifies the SHA-256 line, extracts, `install -m 0755 receipt-<target> $RECEIPT_CLI_BIN`, prints `Installed receipt CLI at …` and, if the dir is not on PATH, `Add ~/.local/bin to PATH to run 'receipt' from any shell.`
- It does **not** export any gateway URL and does **not** install `receipt-claude-proxy` even if the tarball contains it (the preview.6 archives do not bundle it, `docs/receipt-real-workspaces-dev-handoff.md:255-258`). Re-running upgrades in place; `~/.receipt` is untouched.

**Release build** (`scripts/build-receipt-cli-release.sh`): for `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64` runs `bun build --compile --target=bun-<t> --define="RECEIPT_CLI_BUILD_VERSION='<ver>'" connect-cli.ts`, optionally copies `dist/receipt-claude-proxy/<platform>/receipt-claude-proxy` into the tarball as `receipt-claude-proxy-<platform>` (`RECEIPT_CLAUDE_PROXY_REQUIRED=1` to fail if missing), tars, and writes `checksums.txt`. Version = `RECEIPT_CLI_VERSION` or short git SHA.

**`scripts/install-receipt-cli.sh` is not the public installer.** It clones `skishore23/receipt-factory`, needs Git and Bun, runs `bun install --filter @receipt/app`, and writes a wrapper that executes `packages/receipt-app/src/cli.ts` — the operator CLI (which does have `login/logout/whoami`), not `connect-cli.ts`.

---

## 12. What in `docs/receipt-cli.md` is stale relative to HEAD

| Doc claim (line) | Code reality |
|---|---|
| "defaults to the configured SST Gateway URL … Set `RECEIPT_CONNECT_PUBLIC_GATEWAY_URL` or `RECEIPT_PUBLIC_BASE_URL` before using the production target" (52-54) and help "Uses the hosted Receipt gateway" (`connect-cli.ts:102-104`) | Correct only for the env part; there is no hosted default in the binary, so plain `receipt setup` fails without env or `--server-url`. |
| `receipt setup` "starts the guided onboarding flow for the selected workspace" (56-58) | `runSetup` only signs in, installs the observer, prints the catalog. Onboarding is `receipt connect`. |
| Connector list of 16 providers (58-62, 75-94) | Catalog has 62 connectors; `jira`/`confluence` resolve to the OAuth variants; `gcp` is the id (also `google`). |
| `receipt connect setup` "List supported connectors and connection status" (68-73) | Prints catalog, account, and observer state; no connection status. Status is `receipt connect status`. |
| "Connect multiple accounts … by giving each connection a stable name during onboarding" (151-154) | Public CLI sends no name; connections are always `default`. Named connections come from the web UI. |
| MCP section implies signed-in flow works after `receipt setup` (98-120) | True, but `receipt mcp config [codex|generic]` — any other client name silently gets the generic JSON; `install/status/remove` are Codex-only; `mcp --help` does not work. |
| Nothing about `receipt connect list/tools/call` needing `RECEIPT_CONNECT_GATEWAY_URL` + `RECEIPT_CONNECT_TOKEN` | Required on the public binary (§8.5). |
| Nothing about `connect status|<provider>|disconnect` re-prompting for sign-in | They always start a new device login (§8). |
| Error hints `run 'receipt login' first` (from shared services) | `receipt login` does not exist on the public binary; use `receipt setup`. |
| "Releases may also include … `receipt-claude-proxy`" and step 3 "the installer must install that binary" (12-14, 228-234) | Current `install.sh` installs only `receipt`. |
| "`receipt connect` does not require `OPENAI_API_KEY`" (64) | Correct. |
| Release-process section (198-248) | Matches `build-receipt-cli-release.sh`. |

The interactive menu bug (§8.1), the missing help for `tools|mcp|workspace`, the Codex-only MCP install, and the 12-hour token with no refresh are all documented as open issues in `docs/superpowers/plans/2026-09-05-mcp-gateway-connect-cli-fixes.md` and remain unfixed at HEAD.

---

## 13. Recommended first-run sequence that works with the shipped binary today

```bash
curl -fsSL https://raw.githubusercontent.com/kentronai/receipt-cli/main/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"
receipt --version                                   # receipt v0.1.0-preview.6
export RECEIPT_CONNECT_PUBLIC_GATEWAY_URL=https://app.kentron.ai   # or: receipt setup --server-url https://app.kentron.ai
receipt setup                                       # browser approval, writes ~/.receipt/session.json (0600)
receipt workspace current --json
receipt tools list                                  # aggregate, opaque tool names
receipt mcp config codex                            # preview TOML
receipt mcp install codex && receipt mcp status codex
receipt connect github                              # NOTE: opens a second browser sign-in, then Nango
receipt connect status
```
