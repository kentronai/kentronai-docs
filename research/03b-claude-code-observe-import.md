# Claude Code observation & transcript import in Receipt

(Report from a research sub-agent; verified against code with file:line citations.)

## 1. CLI commands, flags, auth

### Two entrypoints, same engine

| Binary | Source file | Dispatch |
|---|---|---|
| Public CLI (`receipt`) | `packages/receipt-app/src/connect-cli.ts` | `connect-cli.ts:941` (`import`), `:945` (`observe`) |
| Developer/app CLI | `packages/receipt-app/src/cli/commands.ts` | `commands.ts:5337` (`import`), `:5340` (`observe`) |

Both call `runClaudenImport` in `packages/receipt-app/src/cli/clauden-import.ts:1669`.

### Sources

Exactly two, validated at `clauden-import.ts:28`: `"clauden" | "claude-code"`.
Error strings: `"import source is required. Supported sources: clauden, claude-code"`, `"Unknown import source '<x>'. Supported sources: clauden, claude-code"`.

`clauden` = the `receipt-claude-proxy`/`clauden` HTTP proxy's NDJSON event log. `claude-code` = raw Claude Code `.jsonl` transcripts from `~/.claude/projects`.

### Help text (verbatim, `cli/shared.ts:48-51`)
```
  receipt import clauden [--event-log ~/.claudeN/events.ndjson] [--mode metadata|full] [--json]
  receipt observe clauden [--event-log ~/.claudeN/events.ndjson] [--mode metadata|full] [--launch]
  receipt observe clauden install [--mode metadata|full]
  receipt observe clauden status
```
Full flag surface (`cli/shared.ts:81-83`):
```
  receipt import clauden [<path>] [--stream <stream>] [--project <name>] [--source-id <id>] [--mode metadata|full] [--max-lines <n>] [--follow] [--launch] [--proxy-bin <path>] [--poll-ms <n>] [--output-file <path>]
  receipt observe clauden [<path>] [--stream <stream>] [--project <name>] [--source-id <id>] [--mode metadata|full] [--launch] [--proxy-bin <path>] [--poll-ms <n>] [--output-file <path>]
  receipt observe clauden install|start|stop|status|uninstall [--mode metadata|full] [--event-log <path>] [--proxy-bin <path>] [--no-start] [--output-file <path>]
```
`claude-code` never appears in help text or docs; it is reachable only by typing it.

### Flags

| Flag | Where | Behaviour |
|---|---|---|
| `<path>` / `--event-log` / `--path` | `clauden-import.ts:1433-1438` | Explicit source file |
| `--mode metadata\|full` | `:1388-1392` | Default `metadata`; error `"--mode must be metadata or full"` |
| `--stream <stream>` | `:1717-1718` | Default `imports/${source}/${project}/${sourceId}` |
| `--project`, `--source-id` | `:1709-1716` | Stream segments (80-char cap) |
| `--import-id <id>` | `:1714` | Else `clauden_<base36 ts>_<sha8>` |
| `--max-lines <n>` | `:1788` | |
| `--follow`, `--poll-ms <n>` | `:1682-1685`, `:1697` | pollMs floored at 100ms, default 1000 |
| `--launch` / `--launch-proxy` | `:1686-1690` | Spawns companion; requires `--follow` or `observe` |
| `--proxy-bin` / `--clauden-bin` | `:525-527` | Companion binary override |
| `--batch-size <n>` | `:401-404` | Cloud batch, default 50, max 100 |
| `--local-only` / `--no-cloud` / `--no-upload` | `:1394-1400` | Suppress cloud upload |
| `--target <t>` | `:1407` | Named CLI session file |
| `--json`, `--output-file` | shared | |
| `--no-claude-launch` / `--no-launch` | `:573-578` | Passed through to companion |

Background service flags (`cli/clauden-service.ts:94-146`): `--receipt-bin`, `--no-start`, plus `--mode/--event-log/--proxy-bin/--poll-ms/--stream`.

### Companion binary resolution (`clauden-import.ts:522-542`)
Order: `--proxy-bin`, `--clauden-bin`, `$RECEIPT_CLAUDE_PROXY_BIN`, `$CLAUDEN_BIN`, `receipt-claude-proxy` and `clauden` next to argv[1], next to execPath, then `$PATH`. Failure: `"Unable to find the Claude observer companion binary. Install a Receipt CLI release that bundles receipt-claude-proxy, or pass --proxy-bin <path> / set RECEIPT_CLAUDE_PROXY_BIN."`

### Default source paths
- `clauden`: `~/.claudeN/events.ndjson`; legacy text log `~/.claudeN/clauden.log`.
- `claude-code`: scans `~/.claude/projects`, newest `*.jsonl` by mtime; stream project = parent dir name, sourceId = jsonl basename (session UUID).

### Background observer (`observe clauden install|start|stop|status|uninstall`)
`cli/clauden-service.ts`. Label `run.beetle.clauden-observer`. macOS → `~/Library/LaunchAgents/run.beetle.clauden-observer.plist`; Linux → `~/.config/systemd/user/beetle-clauden-observer.service`. Installed command: `<receiptBin> observe clauden --event-log <log> --mode <mode> --launch`. Logs → `<dataDir>/logs/clauden-observer.{out,err}.log`.
`observe claude-code install` is rejected: `"observe claude-code supports live file tailing only; use observe clauden install for proxy service install"`.

### Auth
Required only for cloud upload.
- Token: `~/.receipt/session.json`, mode 0600 (`services/receipt-cli-session.ts:41-44`). Override `RECEIPT_CLI_CONFIG_DIR` / `RECEIPT_CLI_SESSION_FILE`. Per-target files `session.<target>.json`.
- Session shape: `target, gatewayUrl, authUrl, token, userId, userEmail, organizationId, workspaceId, workspaceName, savedAt`.
- Obtained by `receipt setup` / `receipt login` via browser device flow at `apps/start/src/routes/api/receipt-connect/cli-login/route.tsx`. TTL 10 min, poll 2s, 10 starts/min/IP, 3 concurrent. Scopes: `connect:credential`, `connect:read`, `connect:write`.
- Upload: `authorization: Bearer <token>` to `<gatewayUrl>/api/receipt-ingest/receipts`.
- `receipt setup` auto-installs the observer; opt out with `--no-claude`, `--no-observer`, `--no-background`, `--skip-claude` (`connect-cli.ts:359-363`).

Env: `RECEIPT_CONNECT_PUBLIC_GATEWAY_URL`, `RECEIPT_CONNECT_GATEWAY_URL`, `RECEIPT_SERVICE_GATEWAY_URL`, `BETTER_AUTH_URL`, `VITE_BETTER_AUTH_URL`; `ZERO_UPSTREAM_DB` selects Postgres store over local file store.

## 2. What data is captured

Event types (`clauden-import.ts:30-81`): `import.batch.started`, `import.raw_object.captured`, `import.object.normalized`, `import.object.rejected`, `import.batch.completed`. `kind` is `claude_code_transcript` or `realtime_event_log`.

Each transcript line → two receipts (raw + normalized). Dedup key `${source}:${sourceId}:${objectId}:${event.type}`.

Normalized fields: `rawType`, `at`, `model`, `stream`, `status`, `sessionKey`, request/response bytes, `accountHash`, `rateLimit5h/7d`, `cooldownMs`, `method`, `path`, `cwd`, `gitBranch`, `entrypoint`, `userType`, `promptId`, `requestId`, `version`, `stopReason`, `error`, `timeline`.
`timeline`: `role` (user|assistant|system|tool_use|tool_result|attachment|metadata|error), `text`, `content`, `usage`, `toolUseResult`, `toolName`, `metadata` (incl. `lastPrompt`, `permissionMode`, `prUrl`, `durationMs`, ...).
Tokens: `usage` copied from `message.usage`; parsed in UI as input/output/cache tokens. No cost computation.

### Redaction — the doc claim does not hold
`SENSITIVE_KEYS` (24 keys) redaction is applied ONLY to the raw payload (`clauden-import.ts:1145-1148`); the normalized receipt carries `timeline.text`, `timeline.content`, `timeline.toolUseResult`, `metadata.lastPrompt` unredacted. Tests assert this (`clauden-import.test.ts:119-165`, `:220-263`). So in default `--mode metadata`, user prompts, assistant text, tool inputs (bash commands), tool results (stdout/stderr), `cwd`, `gitBranch` are all captured and uploaded.

### Ingest endpoint
`apps/start/src/routes/api/receipt-ingest/receipts/route.tsx`: requires Connect JWT with `connect:write`. Limits: 2 MiB body, 100 receipts/batch. Stream allowlist: `imports/clauden/`, `imports/claude-code/`. Tenant-scoped via `resolveReceiptTenantDataDir({ userId, organizationId })`.

Table `receipt_receipts` (`db/schema.ts:32-51`): `global_seq`, `stream`, `stream_seq`, `receipt_id`, `ts`, `prev_hash`, `hash`, `event_type`, `body_json`, `hints_json`.

## 3. UI: Sessions page
Route `/sessions` (`routes/(app)/_layout/sessions/route.tsx`), component `components/sessions/sessions-page.tsx`. Nav config: title `Sessions`, description `Imported agent logs and receipts`, `hideFromPrimaryNavigation: true` (not in sidebar; direct URL only).
Header: "Sessions" / "Find token waste, compliance risks, replay gaps, and reusable lessons from Claude activity."
Metrics: Sessions, Prompts, Replies, Issues, Evidence. Left rail "Agent sessions", search "Search sessions, tags, models", tag filters (source, project, model, needs-review, rate-limit, long-run, replay-ready). Modes: Checks, Replay, Lessons, Evidence. Detail: Prompts, Replies, Evidence, Project, Session, Model, Imports, Updated. Timeline labels: User, Claude, `<tool> call`, `<tool> result`, System, Attachment, Session metadata, Error. Usage line format "12.3k in · 4.5k out · 30k cache". Evidence rows expand to full receipt JSON.
Empty state: "No imported sessions yet" / "Waiting for Claude activity. Imported sessions will appear as replayable agent runs with reflections, lessons, and evidence."
Data: `GET /api/sessions/dashboard` (MAX_STREAMS 50), `POST /api/sessions/evidence` (limit 1–50, default 20).

## 4. Other agents
None. Only `clauden` and `claude-code` sources exist. Codex appears only as an outbound MCP client target (`receipt mcp config codex|generic`).

## 5. Docs vs code discrepancies
1. Privacy claim in `docs/api/cli.md:141-149` and `docs/receipt-cli.md:141-142` (metadata mode redacts prompts) is materially wrong for normalized receipts.
2. `claude-code` source entirely undocumented.
3. `docs/api/cli.md` describes import as local-only; it is cloud-first when a session exists.
4. `forceLocalStore: true` in connect-cli.ts is ineffective (cloud short-circuit happens first).
5. Dead branch in entity classifier (`clauden-import.ts:1057-1065`).
6. `docs/api/cli.md` flag list incomplete.
7. README/AGENTS.md never mention clauden/observe/Sessions.
8. Sessions page unreachable by navigation.
