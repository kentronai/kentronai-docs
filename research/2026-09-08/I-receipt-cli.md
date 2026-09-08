# Research I — The Receipt CLI, complete reference (validated at HEAD `c3c16be6`)

Repo: `~/Desktop/Development/kentron/Receipt` (branch `main`, HEAD `c3c16be6`, checked 2026-09-08). Paths below are repo-relative; `packages/receipt-app/src/` is abbreviated to `src/` after first mention. Every behavioural claim cites `path:line`. Nothing in either repository was modified.

## 0. Scope, sources, and what was executed

### 0.1 Three programs are named `receipt`

| Program | Entry file | Who runs it | Sign-in verbs | Documented here as |
|---|---|---|---|---|
| **Public binary** (what users install) | `src/connect-cli.ts` (1,251 lines; `scripts/build-receipt-cli-release.sh:10`) | anyone, via `install.sh` | `setup`, `login`, `logout` | sections 1–7 |
| **Developer CLI** (from a checkout) | `src/cli.ts` (59 lines) + `src/cli/commands.ts` (5,424 lines), launched by `.receipt/bin/receipt` | contributors with Bun and a checkout | `login`, `logout`, `whoami`, `setup` | section 8 |
| **Sandbox worker CLI** | `src/connect-worker-cli.ts` | Factory OpenSandbox workers only, env-token identity | none (`RECEIPT_CONNECT_TOKEN` only) | mentioned in 4.11 and 8 |

The public binary is compiled from `connect-cli.ts` alone; its imports (`src/connect-cli.ts:8-45`) are the connect command-proxy, agent CLI, MCP/tools CLI, workspace CLI, device-login client, session store, connector catalog, and the two Claude-observer modules (`src/cli/clauden-import.ts`, `src/cli/clauden-service.ts`). It does **not** import `src/cli/env.ts`, so no `.env` file is ever read by the public binary, and the release build additionally disables Bun's dotenv/bunfig autoload (`scripts/build-receipt-cli-release.sh:99-105`).

### 0.2 Sources read in full

`src/connect-cli.ts` and every module it imports (`services/receipt-connect-command-proxy.ts`, `receipt-connect-agent-cli.ts`, `receipt-mcp-cli.ts`, `receipt-workspace-cli.ts`, `receipt-connect-cli-login.ts`, `receipt-cli-session.ts`, `receipt-connect-connectors.ts`, `receipt-connect-integration-registry.ts`, `cli/clauden-import.ts`, `cli/clauden-service.ts`); the 63 connector manifests under `src/integrations/nango/`; `src/cli/doctor.ts`, `cli/env.ts`, `cli/shared.ts`, `cli.ts`, `connect-worker-cli.ts`; the server routes the CLI calls (`apps/start/src/routes/api/receipt-connect/cli-login/route.tsx`, `apps/start/src/routes/api/receipt-ingest/receipts/route.tsx`, `src/server/receipt-connect-routes.ts`) and the JWT/device-code constants; the tests `src/connect-cli.test.ts` and `src/cli/doctor.test.ts` plus the test names of the four service suites; both install/build scripts; `docs/receipt-cli.md`, `docs/ai-agent-receipt-cli.md`, `docs/receipt-cli-debug-report.md`; `dist/receipt-cli-release/v0.1.0-preview.7/`; the public `install.sh` and `README.md` fetched live from `kentronai/receipt-cli@main`; the prior research `04-public-cli.md`/`05-repo-cli-core.md` (map only); and the eight `doc/cli/*.mdx` pages.

### 0.3 What was executed (read-only)

The darwin-arm64 tarball from `dist/` was extracted into the scratchpad and the binary run with `env -i PATH=/usr/bin:/bin HOME=<scratch>` (an empty environment and an empty home). Commands run: `--version`, `-V`, `--help`, `help`, `-h`, `connect help`, `connect --help`, `doctor` (text and `--json`, for `prod`, `dev`, `local`, an unresolvable target, and an unreachable `--server-url`), every signed-out error path for `workspace`, `mcp`, `tools`, `connect list|tools|call`, `import`, `observe`, `connect relay`, `logout`, `login --no-login`, `setup --no-login --no-background` (text and JSON), `observe clauden status`, `observe clauden install --no-start`, and `observe clauden --mode bogus`. Their verbatim output is quoted in section 4. No sign-in was completed, nothing was installed, and no session file was written.

One invocation had an unintended side effect that is itself a finding: `receipt --help extra` did **not** print help. The parser stores `help="extra"` (a string), the help check requires `flags.help === true` (`src/connect-cli.ts:1231`), so the binary fell through to the interactive onboarding path and started a device login against `https://app.kentron.ai` (it printed `Starting Receipt Connect sign-in at https://app.kentron.ai...` and a one-time `XXXX-XXXX` code). No browser was opened (`RECEIPT_CONNECT_OPEN_BROWSER=0`), nothing was approved, the code expires server-side after 10 minutes (`route.tsx:12`), and the polling process was killed. See 4.0 for the parsing rule.

A `codesign -dv` of the extracted binary reports `Format=Mach-O thin (arm64)`, `flags=0x20002(adhoc,linker-signed)`, `Signature=adhoc` — the valid ad-hoc signature the release notes require (`docs/receipt-cli.md:250-255`).

### 0.4 Working-tree note

At research time `git status` shows `LOCAL_SETUP.md` deleted at the repo root and an untracked `docs/LOCAL_SETUP.md`; HEAD still tracks the file at the root and `apps/start/.env.example:163` refers to it as `LOCAL_SETUP.md`. This is an uncommitted local move by the operator, not something this research did. Citations below use the HEAD copy (`git show HEAD:LOCAL_SETUP.md`).

---

## 1. Distribution and install

### 1.1 The public repository and installer

Public distribution is the GitHub repository `kentronai/receipt-cli`, which contains only `install.sh`, `README.md`, and immutable releases (README: "This repository contains only the public installer and release artifacts for the connect-only CLI. The private Kentron AI application source is not published here."). The one-line install is:

```bash
curl -fsSL https://raw.githubusercontent.com/kentronai/receipt-cli/main/install.sh | bash
```

The installer fetched live on 2026-09-08 is byte-identical to `dist/receipt-cli-release/v0.1.0-preview.7/install.sh` (verified with `diff`), so the following is the behaviour of both. Line numbers refer to that file.

| Behaviour | Where | Detail |
|---|---|---|
| Shell | line 1-2 | `#!/usr/bin/env sh`, `set -eu` — POSIX sh; the README pipes it into `bash`, either works. |
| Variables | 4-7 | `RECEIPT_CLI_VERSION` (default **`v0.1.0-preview.7`**), `RECEIPT_CLI_REPO` (default `kentronai/receipt-cli`), `RECEIPT_CLI_BIN_DIR` (default `$HOME/.local/bin`), `RECEIPT_CLI_BIN` (default `$RECEIPT_CLI_BIN_DIR/receipt`). In a piped install these must be set on the shell that runs the script, i.e. `curl … \| RECEIPT_CLI_VERSION=<tag> bash`. |
| Required commands | 9-14, 71-73 | `curl`, `tar`, `awk`; and `shasum` or `sha256sum` (checked at 52-59). Missing → `Missing required command: <name>` on stderr, exit 1. |
| Platform detection | 16-39 | `uname -s`/`uname -m`: Darwin→`darwin`, Linux→`linux`; arm64/aarch64→`arm64`, x86_64/amd64→`x64`. Anything else → `Unsupported OS: <os>` or `Unsupported architecture: <arch>`, exit 1. No Windows build. |
| Download | 62-69, 77-80, 93-95 | `https://github.com/<repo>/releases/download/<version>/receipt-<os>-<arch>.tar.gz` and `checksums.txt`, fetched with `curl -fsSLO` into a `mktemp -d` directory that is removed on exit (82-86). Failure → `Download failed: <url>`, `  repo=<repo> version=<version>`, `  Check that this release and asset exist.` |
| Checksum verification | 41-60, 96 | Selects the line whose second field equals the asset name with `awk` (exact match; a missing entry is a hard error `checksums.txt has no entry for <file>`), then `shasum -a 256 -c -` or `sha256sum -c -`. A mismatch aborts (set -e). |
| Install | 88-91, 97-98 | Creates `dirname "$RECEIPT_CLI_BIN"`, `tar -xzf`, then `install -m 0755 receipt-<target> "$RECEIPT_CLI_BIN"`. Only the `receipt-<target>` file is installed; any other file in the archive (for example a `receipt-claude-proxy-<platform>` companion) is left in the temp dir and deleted. |
| Messages | 100-124 | `Installed receipt CLI at <path>`. If `bin_dir` is on `PATH`: `Run 'receipt --help' to get started.` Otherwise: `<bin_dir> is not on your PATH. Add it, then run 'receipt --help':` followed by a shell-specific hint — fish: `fish_add_path <bin_dir>`; zsh/bash/other: `echo 'export PATH="<bin_dir>:$PATH"' >> <~/.zshrc | ~/.bashrc | ~/.profile>` and `export PATH="<bin_dir>:$PATH"`. |
| Upgrade | 97 | Re-running overwrites the binary in place; `~/.receipt` is never touched. |

The public README (fetched live) also carries an upgrade note worth reproducing in docs: "If you installed an earlier build that was named `kentronai`, remove the stale binary after upgrading, and re-run `receipt mcp install codex` so the MCP entry points at the new path: `rm -f ~/.local/bin/kentronai`."

### 1.2 Release `v0.1.0-preview.7` — published and verified

The release exists on GitHub: `HEAD` requests for `…/releases/download/v0.1.0-preview.7/checksums.txt` and `receipt-darwin-arm64.tar.gz` both return `302` to the release-asset CDN, and the published `checksums.txt` is identical to `dist/receipt-cli-release/v0.1.0-preview.7/checksums.txt`. The public `install.sh` default is already `v0.1.0-preview.7` and the public README describes preview.7 ("Upgrading from `v0.1.0-preview.6`? That build could not sign in on a fresh machine…"). This supersedes three statements in the repo: `docs/receipt-cli.md:27-28` ("Until the installer default is bumped, install it explicitly with `RECEIPT_CLI_VERSION`"), `docs/receipt-cli-debug-report.md` "Remaining issues: The release is not yet published", and `RELEASE-HANDOFF.md` ("Files to upload…"). All three describe a state that no longer holds.

Tarball contents (`tar -tzvf` on all four): exactly one file each — `receipt-darwin-arm64` (62.8 MB), `receipt-darwin-x64` (69.9 MB), `receipt-linux-arm64` (81.8 MB), `receipt-linux-x64` (81.9 MB). **No `receipt-claude-proxy` companion is bundled in preview.7.**

### 1.3 What the binary is, and the version string

`bun build --compile --target=bun-<platform>` of `src/connect-cli.ts` with two defines: `RECEIPT_CLI_BUILD_VERSION='<version>'` and `RECEIPT_CLI_DEFAULT_PROD_GATEWAY_URL='<hosted url>'` (`scripts/build-receipt-cli-release.sh:101-109`). `receipt --version` / `-V` prints `receipt <version>` (`src/connect-cli.ts:1211-1214`); the version is the build-time constant when present, else the `RECEIPT_CLI_VERSION` env var, else `development` (`:49-52`). Observed: `receipt v0.1.0-preview.7`. Only accepted as the **sole** argument (`argv.length === 1`, `:1211`); `receipt --version --json` falls through to onboarding.

### 1.4 The `receipt-claude-proxy` companion

The Claude observer needs a separate executable. The CLI looks for it in this order (`src/cli/clauden-import.ts:522-541`): `--proxy-bin`, `--clauden-bin`, `$RECEIPT_CLAUDE_PROXY_BIN`, `$CLAUDEN_BIN`, then `receipt-claude-proxy` and `clauden` next to the CLI entrypoint (`dirname(process.argv[1])`), next to the executable, and finally on `PATH`. When none is executable: `Unable to find the Claude observer companion binary. Install a Receipt CLI release that bundles receipt-claude-proxy, or pass --proxy-bin <path> / set RECEIPT_CLAUDE_PROXY_BIN.` (`:543-554`). The release script copies `dist/receipt-claude-proxy/<platform>/receipt-claude-proxy` into the tarball as `receipt-claude-proxy-<platform>` when present, warns `warning: no Claude proxy companion for <platform>; continuing without it` otherwise, and fails only with `RECEIPT_CLAUDE_PROXY_REQUIRED=1` (`build-receipt-cli-release.sh:96, 115-125`). Two facts follow: preview.7 ships without it, and even a release that bundled it would not be installed by the current `install.sh` (1.1). `docs/receipt-cli.md:277-280` already records that the installer "must install that binary" as a to-do.

### 1.5 Not on npm

`docs/receipt-cli.md:16-18`: "Receipt CLI is not distributed through npm. The npm package named `receipt` is unrelated to this product; do not use `npm install receipt` or `npx receipt` to install or run this CLI." There is no Homebrew formula and no Windows build.

### 1.6 `scripts/install-receipt-cli.sh` is a different installer

The in-repo script installs the **developer** CLI: it needs `git` and Bun (`:42-43`, Bun resolved from `RECEIPT_BUN_BIN`, `BUN_BIN`, `PATH`, `BUN_INSTALL`, `~/.bun/bin/bun`), shallow-clones `RECEIPT_CLI_REPO_URL` (default `https://github.com/kentronai/Receipt.git`) into `~/.receipt/cli/receipt-factory`, runs `bun install --filter @receipt/app --frozen-lockfile --production` (`:60`), and writes a `~/.local/bin/receipt` wrapper that `exec`s `bun packages/receipt-app/src/cli.ts` (`:63-78`). Do not document it as the public install path.

### 1.7 Release process (user-facing summary)

Releases are manual (`docs/receipt-cli.md:237-240`: "A fix to `connect-cli.ts` reaches users only once a release built from it exists there and `install.sh` pins that tag; nothing in CI does this"). Steps: `RECEIPT_CLI_VERSION=vX.Y.Z scripts/build-receipt-cli-release.sh` builds four platform binaries with autoload disabled and the hosted origin baked in (`RECEIPT_CLI_DEFAULT_PROD_GATEWAY_URL`, default `https://app.kentron.ai`, `build-receipt-cli-release.sh:9`), smoke-tests the host-platform binary from a clean `HOME` (it must print `receipt <version>` and `receipt doctor --json` must contain `"gatewayUrl": "<hosted url>"`, `:57-81`; a `137` exit is called out as a macOS code-signature failure, `:62-67`), tars each binary, and writes `checksums.txt` (`:132-135`). The maintainer then uploads the five files to a GitHub release with the same tag and bumps the `RECEIPT_CLI_VERSION` default in the public `install.sh`. The output directory is `dist/receipt-cli-release/<version>/` (`:6`). `RELEASE-HANDOFF.md` records that preview.7 was built with Bun 1.4.2 because the repo-pinned 1.3.12 produced macOS binaries with a malformed ad-hoc signature.

---

## 2. Targets and URL resolution

All endpoint resolution is `resolveReceiptConnectEndpoint({ target?, serverUrl?, authUrl? })` in `src/services/receipt-connect-command-proxy.ts:545-630`, returning `{ name: "prod" | "dev" | "local" | "custom", serverUrl, authUrl }`. `serverUrl` is the Receipt Connect gateway (every `/connect/*` call, the MCP endpoint, and the ingest endpoint are built on it); `authUrl` is the web origin that hosts `/api/receipt-connect/cli-login`. Trailing slashes are stripped (`normalizeUrl`, `:372`).

### 2.1 Targets

`normalizeReceiptConnectTargetName` (`:534-543`): `prod`/`production` → `prod`; `dev`/`development`/`staging` → `dev`; `local`/`localhost` → `local`; anything else → undefined. No target → `prod` (`:551`). A target that is neither a name nor an `http(s)://` URL throws `receipt connect target must be prod, dev, local, or an http(s) URL` (`:552-554`). A URL positional, or any `--server-url`, produces `name: "custom"` with `authUrl` = `--auth-url` or the same URL (`:556-564`).

### 2.2 Precedence tables

**prod** — first non-empty wins; values whose host is `localhost`, `127.0.0.1` or `::1` are ignored for prod (`publicEnvString`, `:321-334`):

| Step | Source (`:583-612`) |
|---|---|
| 1 | `RECEIPT_CONNECT_PUBLIC_GATEWAY_URL`, `RECEIPT_CONNECT_WORKER_GATEWAY_URL`, `RECEIPT_CONNECT_PUBLIC_URL` |
| 2 | `RECEIPT_CONNECT_PROD_GATEWAY_URL`, `RECEIPT_CONNECT_PROD_SERVER_URL`, `RECEIPT_CONNECT_PROD_URL` |
| 3 (only when `--auth-url` is **not** given) | `RECEIPT_CONNECT_URL`, `RECEIPT_APP_URL` |
| 4 | `DEFAULT_RECEIPT_CONNECT_PROD_URL` = `RECEIPT_CONNECT_PUBLIC_GATEWAY_URL` or `RECEIPT_PUBLIC_BASE_URL` captured at module load (`:51-54`); if that is a local URL it is skipped |
| 5 | the **build-time constant** `RECEIPT_CLI_DEFAULT_PROD_GATEWAY_URL` (`buildTimeProdGatewayUrl`, `:56-73`) — `https://app.kentron.ai` in release builds, undefined when run from source |
| 6 | `.sst/outputs.json` (`gatewayHttps`, then `gateway`, then `url`), searched from `cwd` up to 8 parent directories, CloudFront hosts ignored (`:348-370`) |
| none | `receipt connect production URL is not configured yet. Set RECEIPT_CONNECT_PUBLIC_GATEWAY_URL=https://app.kentron.ai and re-run, or set RECEIPT_CONNECT_PROD_GATEWAY_URL, RECEIPT_CONNECT_PROD_URL, or RECEIPT_CONNECT_URL.` (`:614-616`) |

prod `authUrl` (`:623-628`): `--auth-url`, then `RECEIPT_CONNECT_PROD_AUTH_URL`, `RECEIPT_CONNECT_PROD_URL`, `RECEIPT_CONNECT_URL`, `RECEIPT_APP_URL`, else the resolved `serverUrl`. Note that the baked default never feeds `authUrl` directly; it is reached through the "else serverUrl" fallback, which is why the hosted app must serve both the web sign-in page and `/connect/*` on one origin. `doctor` on a clean machine confirms it does (`gateway … /health` 200, `sign-in … cli-login` 400).

**dev** (`:583-628` with the `DEV` prefix): `RECEIPT_CONNECT_DEV_GATEWAY_URL`, `RECEIPT_CONNECT_DEV_SERVER_URL`, `RECEIPT_CONNECT_DEV_URL`, then (without `--auth-url`) `RECEIPT_CONNECT_DEV_URL`, `RECEIPT_DEV_APP_URL`. There is no default: `receipt connect dev URL is not configured. Set RECEIPT_CONNECT_DEV_GATEWAY_URL or RECEIPT_CONNECT_DEV_URL.` (`:617`). authUrl: `--auth-url`, `RECEIPT_CONNECT_DEV_AUTH_URL`, `RECEIPT_CONNECT_DEV_URL`, `RECEIPT_DEV_APP_URL`, else serverUrl. Local hosts are **not** filtered for dev.

**local** (`:566-581`): serverUrl = `RECEIPT_CONNECT_LOCAL_SERVER_URL` → `RECEIPT_CONNECT_GATEWAY_URL` → `RECEIPT_PROXY_SERVER_URL` → `http://127.0.0.1:${RECEIPT_PORT || PORT || 8787}`; authUrl = `--auth-url` → `RECEIPT_CONNECT_LOCAL_AUTH_URL` → `RECEIPT_AUTH_URL` → `BETTER_AUTH_URL` → `VITE_BETTER_AUTH_URL` → `http://127.0.0.1:${WEB_PORT || 3000}`. Because the public binary loads no env files, `local` means `127.0.0.1:8787` / `127.0.0.1:3000` unless the variables are exported in the shell. Against this repository's own `start-all`/`local:up` stack that is wrong: `HEAD:LOCAL_SETUP.md:975-978` and `apps/start/.env.example:160-167` document `RECEIPT_CONNECT_LOCAL_SERVER_URL=http://127.0.0.1:8787` (runtime API or gateway) and `RECEIPT_CONNECT_LOCAL_AUTH_URL=http://localhost:3000` (the origin the browser uses, because the approval page needs the Better Auth cookie), with the ports adjusted to whatever the stack actually listens on.

**custom** (`:556-564`): `--server-url <url>` or a URL positional; `authUrl` = `--auth-url` or the same URL. `--server-url` beats `--target` when both are given.

### 2.3 The single URL normalizer

`sameNormalizedReceiptConnectUrl(left, right)` (`:374-395`, added in `53f74bed`) decides whether a saved session may be reused for a resolved gateway: both sides are parsed as URLs, `localhost` is rewritten to `127.0.0.1`, trailing slashes are dropped, and the strings compared; unparsable values fall back to a trailing-slash-insensitive string compare. It is used by `setup` (`src/connect-cli.ts:425`), the `connect` commands (`:850`), `doctor` (`:987`), and the agent commands (`src/services/receipt-connect-agent-cli.ts:186`). Scheme and port are significant: `http://localhost:8787` matches `http://127.0.0.1:8787/` but not `https://…` or another port.

### 2.4 Where `--server-url` and `--auth-url` are accepted

`setup`, `login`, `doctor` read `--target`, `--server-url`, `--auth-url` (`src/connect-cli.ts:407-418, 964-975`). The `connect` family reads `--server-url`/`--auth-url` plus a positional target word or URL (`:1163-1187`): after `status|disconnect|remove|revoke|<connector>` or `onboard|onboarding|start` the target is `args[1]`; otherwise the subcommand itself (`prod`, `dev`, `local`, or a URL) is the target. `tools` and `mcp` accept `--server-url` as a gateway override but derive identity from the session (4.9). `connect list|tools|call` accept `--server-url` and `--target`. `workspace` accepts only `--target`. `import`/`observe` accept `--target` to choose the upload session.

---

## 3. Sessions and auth

### 3.1 Files, permissions, contents

`src/services/receipt-cli-session.ts`:

| Item | Value | Line |
|---|---|---|
| Config dir | `$RECEIPT_CLI_CONFIG_DIR` or `~/.receipt` | 39-41 |
| Active session file | `$RECEIPT_CLI_SESSION_FILE` or `<configDir>/session.json` | 43-45 |
| Per-target file | `<configDir>/session.<target>.json` for `prod`, `dev`, `local`; a `custom` target (URL or `--server-url`) writes **no** per-target file; other names are lower-cased, non-`[a-z0-9._-]` replaced by `_`, capped at 64 chars. Suppressed entirely when `RECEIPT_CLI_SESSION_FILE` is set. | 47-65 |
| Directory mode | `0700` (`mkdir` recursive) | 150 |
| Write | `<path>.tmp` written with mode `0600`, then `rename`, then `chmod 0600` (atomic replace) | 146-157 |
| Written on login | both the active file and the per-target file | 159-174 |

On-disk shape (`:8-21`, normalized at `:70-100`): `kind: "receipt.cli-session"`, `schemaVersion: 1`, `target`, `gatewayUrl`, `authUrl`, **`token` (the bearer JWT, in plaintext)**, `userId?`, `userEmail?`, `organizationId`, `workspaceId?`, `workspaceName?`, `savedAt`. A file missing `gatewayUrl`, `token` or `organizationId`, or that fails to parse, reads as "no session" rather than an error (`:76-80`, `:30-37`); `authUrl` defaults to `gatewayUrl`, `target` to `custom`, `savedAt` to the epoch. The token is protected only by the `0600` mode — the file must never be copied, committed or pasted into a bug report; the test suite asserts the CLI never prints it (`src/connect-cli.test.ts:483, 727, 750`).

### 3.2 Reading, matching, activation

`readReceiptCliSession({ target? })` (`:126-144`): with a target, try `session.<target>.json` first, then `session.json` if its `target` normalizes to the same name. Requesting `custom` (or no target) matches whatever the active file holds (`:116-124`), so the URL comparator (2.3) is the real guard. `activateReceiptCliSession` (`:182-186`) copies a target session over `session.json` without touching other target files; `setup` calls it when it reuses a target session so that "the most recent `setup` decides which environment later commands talk to" (comment `:176-181`; `src/connect-cli.ts:428-432`; test `connect-cli.test.ts:541-570`).

### 3.3 Expiry

`isReceiptCliSessionExpired` decodes the JWT's second segment as base64url JSON and compares `exp * 1000` with now; tokens whose payload is unreadable or lacks `exp` are treated as live (`:188-221`; tests `receipt-cli-session.test.ts:197-249`). The signature is never checked client-side (comment `:210-214`). `receiptCliSessionExpiresAt` returns the ISO expiry or undefined. Used by `setup` (refuses reuse, `src/connect-cli.ts:426`), the `connect` family (`:851`), and `doctor` (reports `expired` and `expiresAt`, `:985, 1035, 1043`). There is no refresh: after the 12-hour lifetime (3.7) the next `setup`/`login`/`connect …` re-runs the browser login; `workspace`, `tools`, `mcp` do not check expiry and simply receive `unauthorized` from the gateway.

### 3.4 Session values exported into the process

`applyReceiptCliSessionEnvDefaults` (`:263-278`) sets, **only in the CLI's own process and only when unset**: `RECEIPT_CONNECT_GATEWAY_URL`, `RECEIPT_CONNECT_PUBLIC_GATEWAY_URL`, `RECEIPT_CONNECT_TOKEN`, `RECEIPT_CONNECT_ORGANIZATION_ID`, `RECEIPT_CONNECT_WORKSPACE_ID`, `RECEIPT_CONNECT_WORKSPACE_NAME`, `RECEIPT_CONNECT_USER_ID` (`:247-261`). Called by `setup`/`login` (`src/connect-cli.ts:432, 482`). Nothing is exported to the user's shell.

### 3.5 What `logout` deletes

`deleteReceiptCliSession({ target })` unlinks `session.json` and, when a target is given, `session.<target>.json`, ignoring `ENOENT` (`:223-245`). `receipt logout` reads the **active** session, deletes it and its own target file, and leaves every other `session.<other>.json` in place (`src/connect-cli.ts:907-917`; test `connect-cli.test.ts:486-499`). It does not revoke the JWT server-side.

### 3.6 The device login, from the CLI's point of view

Client: `loginReceiptConnectCli` in `src/services/receipt-connect-cli-login.ts:77-182`. Server: `apps/start/src/routes/api/receipt-connect/cli-login/route.tsx` (constants at `:12-21`).

1. The CLI prints `Starting Receipt Connect sign-in at <authUrl>...` and POSTs `{"action":"start_device"}` to `<authUrl>/api/receipt-connect/cli-login` with a 15 s timeout (`:16, 55-60, 87-88`). Network failure → `receipt connect device login request failed for <endpoint>: <message>` (`:61-66`).
2. Server (`route.tsx:304-343`): per-client rate limit keyed on `x-forwarded-for`/`cf-connecting-ip`/`x-real-ip` (`:102-113`) — at most **10 starts per 60 s** and **3 pending logins** per client, else `429 {"ok":false,"error":"rate_limited","retryAfter":60}`. Otherwise it stores HMAC hashes of a random device code and an 8-character user code `XXXX-XXXX` (alphabet `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, no I/O/0/1; `src/services/receipt-connect-device-login.ts:44-45, 92-95`) with a **10-minute TTL** (`route.tsx:12`) and answers `{ok, deviceCode, userCode, verificationUri, verificationUriComplete, expiresIn, interval: 2}`. The public origin is the first parseable of `RECEIPT_CONNECT_PUBLIC_GATEWAY_URL`, `RECEIPT_CONNECT_GATEWAY_URL`, `RECEIPT_SERVICE_GATEWAY_URL`, `BETTER_AUTH_URL`, `VITE_BETTER_AUTH_URL`, else `X-Forwarded-Host`/`Host` (`:50-88`). A missing field or non-2xx → `receipt connect device login failed to start: <error|http_NNN>` (`:97-103`); `http_404` means the `--auth-url` is not the web app.
3. The CLI prints (`:105-112`):
   ```
   Step 1 of 2: sign in to Receipt
     Open: <verificationUriComplete>
     Code: XXXX-XXXX
     Approve the CLI from the workspace that should own these connections.
   ```
   and opens the URL with `open` (macOS), `xdg-open` (Linux) or `cmd /c start` (Windows) unless `openBrowser === false` or `RECEIPT_CONNECT_OPEN_BROWSER=0` (`:18-32, 113`). The URL carries only the user code.
4. Browser `GET …?user_code=` (`route.tsx:195-258`): no Better Auth session or an anonymous user → `302` to `/auth/sign-in?redirect=<path>` (`:90-100, 209-211`); a session without an active organization → `409` page titled `Receipt Connect`, heading **`Select a workspace first`**, body `Receipt Connect credentials are stored at the workspace level. Open Receipt, select a workspace, then run the CLI command again.` (`:212-225`); unknown/expired → `404` `This Receipt Connect code is invalid or expired.` (`:202-205, 234-239`); already consumed → `409` `This Receipt Connect code was already used. Run the CLI command again.` (`:240-245`); approved → `200` heading **`Receipt Connect is approved`**, body `You can return to the terminal. This page can be closed.` (`:247-257`). Any handler error also redirects to sign-in (`:283-292`).
5. The CLI polls `{"action":"poll_device","deviceCode"}` every `interval` seconds (default 2, floor 1) for up to **10 minutes** (`:15, 115-124`). `428 authorization_pending` → keep polling (`:169-173`); `400 expired_token` → `receipt connect device login expired` (`:174-176`); other → `receipt connect device login failed: <error|http_NNN>` (`:177-179`); loop end → `receipt connect device login timed out` (`:181`). The server answers `503 receipt_connect_storage_unavailable` when its store fails (`route.tsx:387-399`) and `400 unsupported_action` for anything else (`:386`).
6. On success the server consumes the code once, releases the rate-limit slot, and mints the JWT (`route.tsx:364-383`); the CLI requires a non-empty `token` (`receipt connect device login returned an empty token`, `:127-130`) and `organizationId` (`receipt connect login did not return a workspace; select a Receipt workspace and try again`, `:131-139`), prints `Receipt sign-in approved.` (`:141`), and returns `{ token, userId?, userEmail?, organizationId, workspaceId?, workspaceName? }`.

The workspace is **always** the organization's deterministic Default workspace (`route.tsx:31-34, 365-366`: `receiptConnectCliDefaultWorkspace` → `{ id: receiptDefaultWorkspaceId(orgId), name: 'Default' }`). Nothing in the browser step lets the user pick another workspace; `receipt workspace use` does that afterwards (4.8).

### 3.7 The token

`issueReceiptConnectJwt` (`src/services/receipt-connect-auth-token.ts:140-175`): HS256; claims `iss: "receipt"`, `aud: "receipt-connect"`, `sub: <userId>`, `sid?`, `org_id`, `ws_id` (falls back to the Default workspace id), `scp`, `iat`, `exp`, `jti`. TTL is `DEFAULT_RECEIPT_CONNECT_JWT_TTL_SECONDS = 12 * 60 * 60` (`:24`), floored at 60 s (`:157`). CLI logins get all three scopes `connect:credential`, `connect:read`, `connect:write` (`route.tsx:17-21, 373`). The signing secret is server-side (`RECEIPT_CONNECT_JWT_SECRET` or `BETTER_AUTH_SECRET`, `:148-151`).


---

## 4. Command reference (public binary)

### 4.0 Dispatch order and the three argument parsers

`main()` (`src/connect-cli.ts:1209-1246`) tries handlers in a fixed order; the first that claims the argv wins:

1. `--version` / `-V` as the **only** argument (`:1211-1214`).
2. `runReceiptToolsCommand` — `argv[0] === "tools"` (`src/services/receipt-mcp-cli.ts:476`).
3. `runReceiptMcpCommand` — `argv[0] === "mcp"` (`:635`).
4. `runReceiptWorkspaceCommand` — `argv[0] === "workspace"` (`src/services/receipt-workspace-cli.ts:185`).
5. `runReceiptConnectAgentCommand` — after dropping a leading `connect`, `argv[0]` ∈ {`list`, `tools`, `call`} (`src/services/receipt-connect-agent-cli.ts:30, 134-137`). It receives the session reader and the hint `run 'receipt setup' or set RECEIPT_CONNECT_TOKEN` (`src/connect-cli.ts:1218-1225`).
6. `parseArgs` (`:1226`), then help: `args[0]` ∈ {`help`, `--help`, `-h`} or `flags.help === true` or `flags.h === true` → usage (`:1227-1236`).
7. `import` → `runImport`; `observe` → `runObserve` (`:1237-1244`).
8. Everything else → `runConnect` (`:1245`), which handles `setup`, `login`, `logout`, `doctor|check`, `relay`, connectors, `status`, `disconnect|remove|revoke`, and onboarding.

**Consequences.**

- `receipt tools --help`, `receipt mcp --help`, `receipt workspace --help` never print help: they are claimed before the help check. Signed out they fail with `receipt mcp: not signed in; run 'receipt setup' first` (also for `tools`) or `receipt workspace: not signed in; run 'receipt setup' first`; signed in, `mcp --help` runs `mcp status codex`, `tools --help` runs `tools list`, and `workspace --help` fails with `receipt workspace supports list, current, create, rename, use, and delete` (subcommand `--help` is taken literally, `receipt-workspace-cli.ts:187, 360-363`). Help is printed only by `receipt --help`, `receipt help`, `receipt -h`, `receipt connect help`, `receipt connect --help` (`:1128-1131`).
- The word `connect` is optional: `parseArgs` and the agent parser both drop a leading `connect` (`:140`; `agent-cli.ts:30`). `receipt status` ≡ `receipt connect status`, `receipt aws` ≡ `receipt connect aws`, and **bare `receipt` runs the interactive onboarding, which begins a browser sign-in** (`:1153-1155, 1188`).
- `--help <word>` is not help. `parseArgs` treats `--flag value` as a string flag unless the next token starts with `--` (`:169-181`); `receipt --help extra` therefore stores `help="extra"`, fails the `=== true` check, and starts onboarding (observed in 0.3). The same rule bites every boolean flag in this parser: `receipt connect --no-open status` sets `no-open="status"` and the browser still opens; put boolean flags last or use `--open=false` (`isFalseFlag` accepts `false`, `"0"`, `"false"`, `"no"`, `"off"`, `:230-239`).

**Parser A — `parseArgs` in `connect-cli.ts:138-185`** (used by `setup`, `login`, `logout`, `doctor`, `connect …` except `list|tools|call`, `import`, `observe`): `--key=value` and `--key value`; a `--key` at the end or before another `--…` token is `true`; a bare `--` pushes everything after it into positionals (`:146-149`); a repeated flag accumulates into an array and `asString` returns the **last** value (`:155-167, 187-191`); `-h` is a positional that the help check recognises; no other single-dash flags exist. `parseNumberFlag` returns undefined for a non-finite value (`:193-198`) — a bad `--timeout-ms` silently falls back to the default.

**Parser B — `parseMcpArgs` in `receipt-mcp-cli.ts:45-69`** (`tools`, `mcp`) and the agent parser in `receipt-connect-agent-cli.ts:25-54` (`connect list|tools|call`): `--key=value`, `--key value`, bare `--key` → `true`; no `--` terminator; a repeated flag overwrites (last wins); empty-string values are treated as absent (`stringFlag`, `mcp-cli.ts:71-77`).

**Parser C — `receipt workspace` (`receipt-workspace-cli.ts:187-203`)**: recognises exactly `--json` (bare, exact) and `--target <next>` (space form only; `--target=dev` is ignored). Every other `--…` token is skipped silently, **and the token after it becomes a positional**: `receipt workspace create --server-url X My Team` creates a workspace named `X My Team`.

Errors from any handler are printed as the bare message on stderr and set exit code 1 (`:1248-1251`). Status lines and results go to stdout.

### 4.1 `receipt` (no arguments)

Runs `runConnect([] , {})` → onboarding (4.11.1): resolves the `prod` endpoint, reuses a live saved session or starts a device login, lists connections, then prompts `What do you want to connect?`. On a non-TTY the menu picks the default (index 1, `AWS`) without asking (`promptChoice`, `:200-228`). A user who typed `receipt` expecting help gets a browser sign-in; this is by design at HEAD.

### 4.2 `receipt --help`, `receipt help`, `receipt -h`, `receipt connect help|--help`

Prints the usage text generated by `printUsage` (`:61-136`); the connector lines are generated from the catalog (`:62-67`). Captured verbatim from the binary (connector lines elided with `…`; the full list is in 4.12):

```
receipt connect - connect third-party resources through Nango-backed real CLIs

Usage:
  receipt setup
  receipt login [prod|dev|local|https://your-receipt.example.com]
  receipt logout
  receipt doctor [--json]
  receipt workspace current [--json]
  receipt workspace list [--json]
  receipt workspace create <name> [--json]
  receipt workspace rename [<workspace>] <name> [--json]
  receipt workspace use <workspace> [--json]
  receipt workspace delete <workspace> [--json]
  receipt tools list [<connection>]
  receipt tools describe <tool> [--connection <provider:name>]
  receipt tools call <tool> [--connection <provider:name>] --json '{...}'
  receipt mcp config [codex|generic] [--output <path>]
  receipt mcp install codex [--dry-run]
  receipt mcp status codex
  receipt mcp remove codex
  receipt connect
  receipt connect aws
  … (one line per connector id, 63 lines)
  receipt connect status
  receipt connect list [--json]
  receipt connect tools <connection>
  receipt connect call <connection> <tool> [--json '{...}']
  receipt connect call <connection> --path /resource [--query-json '{...}']
  receipt connect disconnect [--provider aws] [--name default]
  receipt connect setup [--json]
  receipt connect local
  receipt connect dev
  receipt connect https://your-receipt.example.com
  receipt import clauden [--event-log ~/.claudeN/events.ndjson] [--mode metadata|full]
  receipt observe clauden [--event-log ~/.claudeN/events.ndjson] [--mode metadata|full] [--launch]
  receipt observe clauden install [--mode metadata|full]
  receipt observe clauden status

What it does:
  1. Starts a guided CLI onboarding flow.
  2. Opens your browser to approve the CLI with your Receipt account.
  3. Saves an org-scoped Receipt Connect session for this machine.
  4. Lets you connect AWS, Google Cloud, … , Azure Blob Storage through Nango or supported CLI credential import.
  5. Shows only non-secret metadata before anything is stored.
  6. Stores org-scoped connection references or encrypted temporary credential-process bundles.
  7. Installs the local Claude observer in the background when bundled.

Default hosted endpoint:
  Release builds sign in to the hosted Receipt gateway. Set
  RECEIPT_CONNECT_PUBLIC_GATEWAY_URL or pass --server-url to target dev or a
  self-hosted deployment. 'receipt doctor' prints the resolved endpoint and the
  saved session state without signing in.

Examples:
  receipt setup
  receipt doctor
  receipt connect
  … (one `receipt connect <id>` line per connector, then the same status/list/tools/call/disconnect/setup/observe/import examples as above)
  receipt import clauden --event-log ~/.claudeN/events.ndjson --mode metadata
```

Notably absent from the help: the `claude-code` source, `observe clauden start|stop|uninstall`, `connect disconnect` aliases `remove|revoke`, `connect doctor|check`, every flag other than those shown, and `--target`. Exit 0; no network (test `connect-cli.test.ts:807-813`).

### 4.3 `receipt --version` / `receipt -V`

Prints `receipt <version>` and exits 0 (`:1211-1214`; test `:163-174`). Observed `receipt v0.1.0-preview.7`.

### 4.4 `receipt doctor` (aliases `receipt connect doctor`, `receipt connect check`)

`runDoctor` (`:960-1072`). Read-only: it never starts a device login (test `:701` asserts no POST) and never prints the token.

| Flag | Effect | Line |
|---|---|---|
| `--json` | JSON envelope instead of text | 961 |
| `--target prod\|dev\|local\|<url>` | environment to diagnose; a positional (`receipt doctor local`) is **ignored** — only the flag counts | 970 |
| `--server-url <url>`, `--auth-url <url>` | override (produces `custom`) | 971-972 |

Steps: resolve the endpoint (failure → `receipt doctor: <message>` / `{ok:false, error, nextSteps:[message]}` and exit 1, `:976-982`); read the session for that target; probe `GET <gateway>/health` and, if that is not 2xx, `GET <gateway>/healthz`, reporting whichever answered (`:989-995`; each probe is a manual-redirect fetch with a 10 s timeout, `:940-950`); probe `GET <authUrl>/api/receipt-connect/cli-login` — **any HTTP status counts as reachable** (`:996-997`); the hosted app answers `400` (`user_code is required`) and that is healthy. `ok` = gateway 2xx **and** auth reachable **and** (no session, or session not expired and its gateway matches the target) (`:1021`). Exit 1 when not ok (`:1071`).

Next-step strings (`:999-1020`):
- `Receipt gateway <serverUrl> did not answer a health check (<error | HTTP n>). Check RECEIPT_CONNECT_PUBLIC_GATEWAY_URL or --server-url.`
- `Receipt sign-in origin <authUrl> is unreachable (<error | no response>). Check --auth-url.`
- `Run 'receipt setup' to sign in.`
- `Saved session expired at <iso | an unknown time>; run 'receipt setup' to sign in again.`
- `Saved session targets <sessionGateway>, not <serverUrl>; run 'receipt setup' for this target.`

Text output observed on a clean machine (exit 0):

```
receipt doctor: ok
  target:   prod
  gateway:  https://app.kentron.ai (HTTP 200 at /health)
  sign-in:  https://app.kentron.ai (HTTP 400)
  mcp:      https://app.kentron.ai/connect/mcp
  session:  not signed in
Next steps:
  - Run 'receipt setup' to sign in.
```

With a session the line is `  session:  <email | userId | user> / workspace <name | Default> (<workspaceId | organizationId>)` followed by ` EXPIRED <iso>` or ` expires <iso>` (`:1061-1065`). The first line is `receipt doctor: ok` or `receipt doctor: attention needed` (`:1056`); an unreachable probe renders as `unreachable: <error>` (`:1054-1055`).

JSON shape observed (`:1023-1050`):

```json
{
  "ok": true,
  "target": "prod",
  "gatewayUrl": "https://app.kentron.ai",
  "authUrl": "https://app.kentron.ai",
  "mcpUrl": "https://app.kentron.ai/connect/mcp",
  "session": { "present": false, "sessionFile": "~/.receipt/session.json" },
  "gateway": { "url": "https://app.kentron.ai/health", "status": 200 },
  "auth": { "url": "https://app.kentron.ai/api/receipt-connect/cli-login", "status": 400 },
  "nextSteps": ["Run 'receipt setup' to sign in."]
}
```

With a session, `session` is `{present:true, target, gatewayUrl, expired, sessionFile, userEmail?, userId?, workspaceId?, workspaceName?, expiresAt?}` (`:925-938`). A probe that failed carries `{url, error}` instead of `status` (observed: `"error": "Unable to connect. Is the computer able to access the url?"` for a closed port, `"getaddrinfo ENOTFOUND example.invalid"` for a bad host). Observed for `--target dev` with no env: `receipt doctor: receipt connect dev URL is not configured. Set RECEIPT_CONNECT_DEV_GATEWAY_URL or RECEIPT_CONNECT_DEV_URL.` (exit 1); for `--target not-a-target`: `receipt doctor: receipt connect target must be prod, dev, local, or an http(s) URL` (exit 1).

`doctor` diagnoses the target you pass (default `prod`) while the active session may belong to another target; pass the same `--target` you signed in with to make the session check meaningful.

### 4.5 `receipt login [prod|dev|local|<url>]`

`runLogin` (`:884-905`) is `setupReceiptLogin` (4.7 step 1) without the connector summary or observer install. Target = the positional, else `--target` (`:888`).

| Flag | Effect |
|---|---|
| `--target`, `--server-url`, `--auth-url` | endpoint (2.4) |
| `--fresh-login` | ignore a saved session (`:423`) |
| `--no-open`, `--open=false`, env `RECEIPT_CONNECT_OPEN_BROWSER=0` | print the URL only (`:241-244`) |
| `--json` | envelope; suppresses the `Step 1 of 2` status lines (`:448-463`) |
| `--no-login`, `--skip-login`, `--local-only`, `--localOnly` | quirk: `login` honours the setup skip flags and prints `receipt login: skipped (disabled by setup flag)` (`:391-395, 896-899`; observed) |

Text output: `receipt login: signed in <email | userId | user> for workspace <name | Default> (<workspaceId | organizationId | unknown>)` (or `already signed in` when reused), then `receipt login: gateway <url>`, then `receipt login: saved <sessionFile>` (`:900-904`). JSON: `{ok:true, reused, target, gatewayUrl, userId, userEmail, organizationId, workspaceId, workspaceName, sessionFile, targetSessionFile}` (`:433-445, 483-495`); `targetSessionFile` is undefined for `custom`. Test: `connect-cli.test.ts:457-484` (`login <url> --json`, session written `0600`, token not printed). Errors: the device-login strings (3.6), or the target error.

### 4.6 `receipt logout`

`runLogout` (`:907-917`): no active session → `receipt logout: not signed in` (exit 0); otherwise deletes `session.json` and `session.<target>.json` and prints `receipt logout: signed out <email | userId | user> from <gatewayUrl>`. No flags are read. Other targets' files survive (3.5).

### 4.7 `receipt setup` (alias `receipt connect setup`)

`runSetup` (`:631-668`) = `setupReceiptLogin` (`:397-496`) + `setupClaudenObserver` (`:498-524`) + print. It does **not** onboard a provider; that is `receipt connect` (4.11).

| Flag | Type | Default | Effect (line) |
|---|---|---|---|
| `--target <prod\|dev\|local\|url>` | string | `prod` | endpoint (413) |
| `--server-url <url>` | string | — | custom gateway (414) |
| `--auth-url <url>` | string | — | web origin for sign-in (415) |
| `--fresh-login` | bool | off | never reuse the saved session (423) |
| `--no-login`, `--skip-login`, `--local-only`, `--localOnly` | bool | off | skip sign-in; `receiptAccount` = `{ok:true, skipped:true, reason:"disabled by setup flag"}` (391-406) |
| `--no-claude`, `--no-observer`, `--no-background`, `--skip-claude` | bool | off | skip the observer install (385-389, 501-507) |
| `--no-open`, `--open=false`, env `RECEIPT_CONNECT_OPEN_BROWSER=0` | bool | — | do not open a browser (241-244, 454) |
| `--json` | bool | off | JSON envelope; suppresses status lines (448, 634) |
| `--proxy-bin`, `--clauden-bin`, `--mode`, `--event-log`, `--path`, `--poll-ms`, `--stream`, `--receipt-bin`, `--no-start` | — | — | forwarded to the observer install (4.14) |

Session reuse rule (`:419-446`): the saved session for the target is reused — no browser — only when `--fresh-login` is absent **and** `sameNormalizedReceiptConnectUrl(saved.gatewayUrl, resolved.serverUrl)` **and** the token is not expired. On reuse the target session is promoted to the active `session.json` and the env defaults applied; the envelope carries `reused: true`. Otherwise it runs the device login, writes both files, applies env defaults, and returns `reused: false`. Tests: expired → re-login (`connect-cli.test.ts:501-520`); live → no network (`:522-539`); `--target prod` reuse promotes `session.prod.json` while leaving `session.local.json` intact (`:541-570`).

Observer step (`:498-524`): skipped with `reason` when a skip flag is set or the companion cannot be resolved (never an error); otherwise runs the `install` service action with `dataDir` = `$RECEIPT_DATA_DIR` or `~/.receipt/data` (`:356-360`), the default event log (4.14), and `receiptBin` = the running executable.

Text output (`:650-668`), observed with `--no-login --no-background`:

```
Receipt account: not connected (disabled by setup flag)
Receipt Connect connectors:
  aws: AWS via real 'aws' CLI
  gcp: Google Cloud via real 'gcloud' CLI
  google-ads: Google Ads via real 'nango' CLI
  … (63 lines)
Claude observer: not installed (disabled by setup flag)
```

After a real sign-in the first line is `Receipt account: connected to workspace <name | Default> (<workspaceId | organizationId | unknown>)`; with the companion present the last is `Claude observer: installed (<launchd|systemd> <serviceFile>)`; on a fresh install without the companion it is `Claude observer: not installed (Unable to find the Claude observer companion binary. Install a Receipt CLI release that bundles receipt-claude-proxy, or pass --proxy-bin <path> / set RECEIPT_CLAUDE_PROXY_BIN.)`. The connector list is the whole catalog, not what is connected.

JSON (`:634-648`): `{ ok: true, receiptAccount: {…as login…}, connectors: [<full catalog definitions, including each connector's typed tool manifests and input schemas>], claudeObserver: {…} }`. Observed: the `connectors` array is large (each `proxy-tools` connector embeds every tool's JSON schema).

### 4.8 `receipt workspace current|identity|list|create|rename|use|delete`

`runReceiptWorkspaceCommand` (`src/services/receipt-workspace-cli.ts:181-387`). Requires a saved session — no environment fallback: `receipt workspace: not signed in; run 'receipt setup' first` (`:207-211`; observed). Default subcommand `current` (`:187`). Flags: `--json`, `--target <name>` only (4.0, parser C). Every request is `<gatewayUrl>/connect/workspaces…` with `Authorization: Bearer <token>` and a 35 s timeout (`:78-105`); a non-2xx or `ok:false` reply surfaces the server's `error` string verbatim, else `Receipt workspace request returned HTTP <n>` (`:97-104`).

| Subcommand | Request | Text output |
|---|---|---|
| `current` (default), `identity` | `GET /connect/workspaces` | `<name> (<id>)` + ` [Default]` when default (`:373-376`) |
| `list` | `GET /connect/workspaces` | one row per workspace: `* <name> (<id>)` for the current one, `  <name> (<id>)` otherwise, `[Default]` suffix (`:377-382`) |
| `create <name…>` | `POST /connect/workspaces {name}` (words joined by spaces) | `<name> (<id>)` |
| `rename [<selector>] <name…>` | `PATCH /connect/workspaces/<id> {name}`; the first positional is a selector only when ≥ 2 positionals, else renames the current workspace (`:313-338`) | `<name> (<id>)` |
| `use <selector>` | `POST /connect/workspaces/<id>/token` → new JWT; session rewritten with the new `token`, `workspaceId`, `workspaceName` (`:284-312`) | `<name> (<id>)`; JSON adds `sessionFile`, `targetSessionFile` |
| `delete <selector>` | `DELETE /connect/workspaces/<id>` | `Deleted workspace <id>` (`:384`) |

Selectors match case-insensitively on id, slug or name (`:154-170`): `workspace '<x>' is ambiguous; use its id`, `workspace '<x>' was not found`. Client errors: `receipt workspace create requires a name`, `receipt workspace use requires a workspace id, slug, or name`, `receipt workspace rename requires a name`, `receipt workspace delete requires a workspace id, slug, or name`, `cannot delete the current workspace; switch to another workspace first` (`:348-352`), `receipt workspace supports list, current, create, rename, use, and delete` (`:360-363`), `refusing to persist a workspace from another organization` (`:144-148`), `Receipt workspace response is missing <key>` / `has invalid <key>` / `omitted the current workspace` / `switch response did not match the server current workspace` (`:35-61, 116-119, 245-249`).

Self-healing side effects of `current`/`list`/`identity` (`:220-265`; tests `receipt-workspace-cli.test.ts:72-155`): if the saved `workspaceId`/`workspaceName` drift from the server's current workspace the session file is rewritten (no new token); if the saved workspace no longer exists a token for the server's current workspace is minted and saved. `use` is the only user-initiated command that replaces the JWT (comment `:175-180`). JSON envelopes: `{ok:true, workspace}`, `{ok:true, currentWorkspaceId, workspaces}`, `{ok:true, deleted:true, workspaceId}`. Server-side strings (from the prior research, not re-verified in this pass beyond the route list): `unauthorized`, `workspace_membership_required`, `workspace not found`, `a workspace with this name already exists`, `organization owner or admin permission is required` (create), `the Default workspace cannot be deleted`.

Important scoping fact: the JWT carries `ws_id`, every `/connect/*` handler checks `hasCurrentWorkspaceMembership` (`src/server/receipt-connect-routes.ts:1077, 1442`), and `tools`/`mcp`/`connect` see only connections bound to that workspace. Provider connections created from the CLI always land in Default (4.11.2), so after `workspace use <other>` the `tools list` and `connect status` views can legitimately disagree.

### 4.9 `receipt tools list|describe|call`

`runReceiptToolsCommand` (`src/services/receipt-mcp-cli.ts:472-575`). Identity (`receiptMcpIdentity`, `:79-127`): the saved session (optionally `--target`) **first**; if none, the environment fallback `RECEIPT_CONNECT_GATEWAY_URL` or `RECEIPT_CONNECT_PUBLIC_GATEWAY_URL` + `RECEIPT_CONNECT_TOKEN` + `RECEIPT_CONNECT_ORGANIZATION_ID` (+ optional `RECEIPT_CONNECT_WORKSPACE_ID/NAME`), which is enabled for `tools` (`:483`) and for `mcp serve` only (`:645`). Neither → `receipt mcp: not signed in; run 'receipt setup' first` (the `receipt mcp:` prefix appears even for `tools`; observed). **Precedence differs from `connect list|tools|call`**: here the saved session beats the environment; there the environment beats the session (4.11.5).

`--server-url <url>` replaces only the gateway (`:123-126`); the saved session's token is still sent to it. There is no same-host guard on this path (contrast `agent-cli.ts:186`), so `receipt tools list --server-url https://<other-host>` would present the saved bearer token to that host. Documentation should say so.

| Flag | Effect |
|---|---|
| `--connection <id \| provider:name>` | narrow to one connection via `POST /connect/tools` / `POST /connect/call` instead of the aggregate MCP (`:479, 493-549`) |
| `--json '<object>'` | **tool arguments** for `call`, default `{}`; invalid → `--json must be a JSON object` (`:301-310, 536`). Output is always JSON regardless |
| `--target <name>` | session file selection |
| `--server-url <url>` | gateway override (see above) |
| `--output <path>`, `--output-file <path>` | write the envelope atomically (`.receipt-tmp-<pid>` then rename, mode `0600`, `:232-242`) and print `{ok:true, outputFile, bytes}` (`:563-573`) |

| Subcommand | Behaviour (`:490-552`) |
|---|---|
| `list [<connection>]` | no connection → JSON-RPC `tools/list` to `POST <gateway>/connect/mcp`; with one (positional or `--connection`) → `POST /connect/tools {connection}` |
| `describe <tool>` | lists (aggregate or narrowed) and returns `{ok:true, tool}` for the exact name; missing → `receipt tools describe requires a tool name`; absent → `Receipt tool '<name>' was not found` |
| `call <tool> [--json …]` | aggregate → JSON-RPC `tools/call {name, arguments}`; with `--connection` → `POST /connect/call {connection, tool, arguments}`; missing name → `receipt tools call requires a tool name` |
| other | `receipt tools supports list, describe, and call` |

Envelope (`:554-562`): `{ ok: true, ...result, workspace: { kind: "workspace", id, name, organizationId } }` or, for a legacy session without `workspaceId`, `{ kind: "organization-default", id: <orgId>, organizationId }` (`:200-212`). A provider-side failure on an aggregate call comes back as a normal MCP result with `isError` content, so `ok: true` means "the gateway answered", not "the provider succeeded". JSON-RPC errors throw with the server's `message` (`:450-458`); HTTP failures throw `unauthorized`, `workspace_membership_required`, `Receipt MCP returned HTTP <n>` (`:373-378`), or, for the narrowed `/connect/tools` and `/connect/call` routes since `48cdeca8`, the new 401/403 bodies: `Receipt could not authenticate this task. Its runtime access token must be renewed before retrying.` (code `receipt_connect_runtime_authentication_required`) and `Receipt could not authorize this task to use the connection. This is a task permission problem; reconnecting the account will not fix it.` (code `receipt_connect_execution_scope_missing`, `src/server/receipt-connect-routes.ts:701-722, 1115-1119, 1158-1162`).

Tool names in `tools list` are opaque aliases (`receipt_<provider>_<connection>_<tool>_<digest>`); the gateway's MCP `instructions` string is: `Receipt tools are reviewed operations scoped to the organization and workspace authenticated by the saved CLI session. Tool names from tools/list are opaque; use them exactly and never construct aliases. Read-only annotations are authoritative. Writes appear only when the token and connection policy allow them; do not bypass a missing tool. read-provider-resource is GET-only and accepts only a provider-relative path and query. Re-list tools after switching workspaces or reconnecting.` (`src/services/receipt-connect-mcp.ts:28`).

### 4.10 `receipt mcp config|install|status|remove|serve`

`runReceiptMcpCommand` (`receipt-mcp-cli.ts:631-778`). Default subcommand `status` (`:637`); client = second positional, else `--client`, else `codex` (`:638-639`); `--name` default `receipt` (`:640`). Identity is resolved **before** the subcommand runs, so `config`/`status`/`install`/`remove` require a saved session and only `serve` accepts the env fallback (`:642-646`; observed `receipt mcp config --client generic` → `receipt mcp: not signed in; run 'receipt setup' first`).

Launcher (`:159-182`): `--receipt-bin <path>` → `[<path>, "mcp", "serve"]`; when the running executable is `bun` → `[bun, <entrypoint>, "mcp", "serve"]`; otherwise `[<execPath>, "mcp", "serve"]` (the compiled binary's absolute path). Every generated config is checked by `assertTokenFreeClientConfig` (`:312-327`): it throws `refusing to install an MCP client config containing the Receipt session token` if the serialized config contains the token, and `refusing to install an MCP client config containing credential material` if it matches `/nango|provider.?secret|authorization.?bearer/i`.

**`config [codex|generic]`** (`:666-686`). Codex → TOML (`:186-198`):

```toml
[mcp_servers."receipt"]
command = "/abs/path/to/receipt"
args = ["mcp", "serve"]
```

Any other client name → the generic JSON verbatim (`:214-230`):

```json
{
  "kind": "receipt.mcp-client-config",
  "schemaVersion": 1,
  "name": "receipt",
  "transport": "stdio",
  "command": "/abs/path/to/receipt",
  "args": ["mcp", "serve"],
  "remote": { "url": "https://<gateway>/connect/mcp" },
  "workspace": { "kind": "workspace", "id": "<ws>", "name": "Default", "organizationId": "<org>" }
}
```

`remote.url` is `<gateway>` + `RECEIPT_MCP_PATH` (`/connect/mcp`, `:13, 126`) and is informational; the stdio bridge reads the `0600` session at start (comment `:577-581`). `--output`/`--output-file <path>` writes the content atomically at `0600` (whole-file replace, no merge) and prints `receipt mcp config: wrote <abs path>`; `--json` prints `{ok, client, config, content, output}`.

**`status [codex]`**: runs `codex mcp get <name> --json` (`:329-349`; invalid JSON → `codex mcp get returned invalid JSON`) and prints `{ok, client, name, installed, configPath, config, workspace, remote}` (`:709-714`). Non-codex → `receipt mcp install/status/remove currently supports codex; use 'receipt mcp config --client generic' for other clients` (`:688-692`).

**`install codex`** / **`remove codex`** (`:694-777`): config path = `$CODEX_HOME/config.toml` or `~/.codex/config.toml` (`:244-250`); a different `--client-config` → `Codex does not accept an arbitrary config path; expected <path>. Set CODEX_HOME before running Receipt if Codex uses another home.`; `--client-bin` (default `codex`); `--dry-run` prints `{ok, dryRun:true, action, client, name, configPath, command, launcher, workspace, remote}` and changes nothing. Refusals: symlink or non-regular file → `refusing to modify non-regular client config: <path>` (`:252-267`); already installed → `Codex MCP server '<name>' is already installed; remove it first`; `remove` when absent → `{ok:true, client, name, removed:false, installed:false, configPath}`. Otherwise: back up to `<config>.receipt-backup-<ISO timestamp with : and . replaced by ->` (`:269-275`), run `codex mcp add <name> -- <command> <args…>` or `codex mcp remove <name>`, and on a non-zero exit restore the backup and throw `codex mcp <install|remove> failed and the prior config was restored: <stderr | exit n>`; then re-run `codex mcp get` and restore on a post-condition failure: `codex did not report the installed Receipt MCP server; the prior config was restored` / `codex still reports the Receipt MCP server after removal; the prior config was restored`; a missing file afterwards → `codex did not create its expected config: <path>`. Success prints `{ok, client, name, installed, removed, configPath, backupPath, workspace, remote}`. Restart Codex afterwards, and again after `receipt workspace use` — the bridge reads the session only at start (`docs/receipt-cli.md:126-129`).

**`serve`** (`serveReceiptMcpStdio`, `:582-629`): one JSON-RPC message per stdin line → `POST <gateway>/connect/mcp` with `Authorization: Bearer <token>`, `Accept: application/json, text/event-stream`, forwarding and remembering `Mcp-Session-Id` (`:351-398`); responses (JSON or SSE `data:` lines) are written one per line; 35 s per request; failures become `{"jsonrpc":"2.0","id":<id>,"error":{"code":-32603,"message":…}}`, and notifications (no `id`) never get a response (`:611-627`). Unknown subcommand → `receipt mcp supports config, install, status, remove, and serve` (`:716-720`).


### 4.11 `receipt connect …`

`runConnect` (`src/connect-cli.ts:1123-1207`) handles everything the earlier dispatch stages did not claim. Order: `help` → `setup` → `login` → `logout` → `doctor|check` → `relay` → then the endpoint is resolved from the positional target (2.4) and `resolveConnectLogin` (`:842-882`) supplies identity.

**Identity for `status`, `disconnect|remove|revoke`, `<provider>` and onboarding**: the saved session for the resolved target is reused when `--fresh-login` is absent, its gateway matches (2.3), and it is not expired; otherwise a device login runs and the result is saved (`:846-881`; note this path does not promote the target session or export env defaults — only `setup`/`login` do). If the gateway answers **401** to a *saved* token, the CLI prints `Saved Receipt session was rejected by the gateway; signing in again.`, signs in once with `fresh-login`, and retries the command exactly once (`:1197-1206`; tests `connect-cli.test.ts:592-639`). A 401 on a freshly minted token is fatal. `RECEIPT_CONNECT_TOKEN` is **not** consulted by these five commands (contrast 4.11.5).

#### 4.11.1 `receipt connect` / `onboard` / `onboarding` / `start` / `prod` / `dev` / `local` / `<url>` — interactive onboarding

`commandConnectOnboarding` (`:751-793`). Prints:

```
Receipt Connect onboarding
Credentials are approved with your Receipt account and stored for the active workspace only.
The CLI will show account metadata, not secret values.
Signed in: <email | userId | unknown user>
Workspace: <name | Default> (<workspaceId | organizationId | unknown workspace>)
Current connections: none
```

(or `Current connections:` followed by `  <provider>:<name> <status> - account <accountId> / <principalArn> / expires <expiresAt>` lines, `:713-734`), then either uses `--provider <id>` or shows the menu `What do you want to connect?` with one numbered line per connector **label** plus `Show status only` (64 entries at HEAD), prompting `Choose [1]: ` (`:200-228, 771-783`). Non-TTY picks the default (AWS). `Show status only` or `status` returns. Otherwise the chosen label is lower-cased and looked up in the alias map (`:784-787`).

**The menu bug is still present at HEAD.** A numbered pick returns the display label, and only labels that happen to equal an alias resolve. Computed against the catalog: 25 labels work (`AWS, Gmail, Notion, LinkedIn, GitHub, HubSpot, Airtable, Apollo, Attio, Zendesk, GitLab, Slack, Linear, Datadog, Sentry, Cloudflare, Vercel, Incident.io, Azure, Anthropic, OpenAI, Zoom, ZoomInfo, Zoho, Outlook`) and 38 fail before any request with `unsupported Receipt Connect onboarding choice: <Label>` (`:792`): every Google product (`Google Cloud`, `Google Ads`, …, `Google Tasks`), `YouTube Analytics`, `Jira OAuth`, `Jira API Token`, `La Growth Machine`, `Gong (Oauth)`, `Stripe App`, `GitHub (App OAuth)`, `GitHub (Personal Access Token)`, `Meta Marketing API`, `Terraform Cloud`, `Azure DevOps`, `Confluence OAuth`, `Confluence API Token`, all nine `Zoho <Product>` labels, `Instagram Insights`, `TikTok Ads Analytics`, `TikTok Accounts`, `TikTok Personal`, `Azure Blob Storage`. Documentation should steer users to `receipt connect <id>` or `--provider <id>`.

#### 4.11.2 `receipt connect <connector-id-or-alias> [<target>]`

`commandConnectNangoProvider` (`:670-711`). `POST <gateway>/connect/nango/sessions` with `{provider[, endUserEmail]}` (`:676-685`); the reply's `connect_link`/`connectLink` is required (`Nango did not return a connect link.`, `:693`). Then `openReceiptConnectProviderStep` (`:600-629`) prints:

```
Step 2 of 2: authorize <provider>
  Open: <connectLink>
```

then either `  Browser auto-open is disabled; open the URL above to continue.` (auto-open off) or, on a TTY without `--yes`/`--auto-open`, pauses on `  Press Enter to open <provider> authorization...` before spawning the browser. Unless `--no-wait`, it prints `Waiting for <provider> authorization to complete...` and polls `GET /connect/connections` every 2 s until any connection for that provider has `status: "valid"` (`:321-339`) — an already-valid connection returns immediately — for `--timeout-ms` (default 600000). Endings: `receipt connect: <provider> connection '<name | default>' is ready for server jobs.`, `Timed out waiting for <provider> connection.`, or with `--no-wait` `After authorization completes, run 'receipt connect status' to verify the <provider> connection.`

| Flag | Default | Effect (line) |
|---|---|---|
| `--email <addr>` | — | sent as `endUserEmail` (681-683) |
| `--yes`, `--auto-open` | off | skip the Enter pause (615-619) |
| `--no-wait` | off | return after opening the link; `--wait=false` does **not** work because `flags.wait === false` can never be true (695) |
| `--timeout-ms <n>` | 600000 | polling budget; non-numeric silently reverts to default (706) |
| `--no-open` / `--open=false` | off | print link only |
| `--fresh-login` | off | re-run the browser sign-in first |
| positional target / `--server-url` / `--auth-url` | prod | endpoint (1163-1187) |

Server side (`src/server/receipt-connect-routes.ts:1750-1830`): needs `connect:write` plus workspace membership **and** mutation authority (`workspace_membership_required`, 403); Nango unconfigured → 503; unknown provider → `400 Unsupported connector. Use one of: <ids>, or any integration configured in Nango.`; provider-only connectors get their Nango integration auto-created. The CLI sends **no connection name**, so CLI-created connections are always `default`, and they always live in the organization's Default workspace (the login token's `ws_id`). Named connections (`aws.prod`) come from the web UI. Unknown provider word → `unsupported Receipt Connect provider. Use aws, gcp, google-ads, …, azure-blob-storage.` (`:1116-1120`).

#### 4.11.3 `receipt connect status [<target>]`

`GET /connect/connections` (server runs a best-effort Nango sync first, `routes.ts:1445-1448`). Output: `receipt connect status: no server-side connections configured` or `receipt connect status:` + `Current connections:` + one `  <provider>:<name> <status>[ - account <id> / <principalArn> / expires <iso>]` line each (`:713-749`). Errors: `unauthorized`, `workspace_membership_required`, `receipt_connect_storage_unavailable`, `HTTP <n>`.

#### 4.11.4 `receipt connect disconnect|remove|revoke [--provider <p>] [--name <n>]`

Defaults **`--provider aws --name default`** (`:800-801`) — bare `disconnect` targets the AWS connection. Finds the match in `/connect/connections`, then `DELETE /connect/connections/<id>` (needs `connect:write`, `routes.ts:1466-1470`). Prints `receipt connect disconnect: removed <provider>:<name>` or `receipt connect disconnect: no <provider>:<name> connection found` (`:806-817`).

#### 4.11.5 `receipt connect list|tools|call` — the agent surface

`runReceiptConnectAgentCommand` (`src/services/receipt-connect-agent-cli.ts:129-242`), shared with the sandbox worker CLI. Identity (`:175-199`): gateway = `--server-url`, else `RECEIPT_CONNECT_GATEWAY_URL`, else `RECEIPT_PROXY_SERVER_URL`; token = `RECEIPT_CONNECT_TOKEN`. **Only when no env token is set** does the public binary read the saved session (optionally `--target`), and it uses that session only if no gateway was given or the given gateway is the same host as the session's (`sameNormalizedReceiptConnectUrl`); a saved token is never sent elsewhere (tests `receipt-connect-agent-cli.test.ts:60-87`). Env identity therefore wins outright — including the trap that `RECEIPT_CONNECT_TOKEN` set **without** a gateway variable fails with `Receipt Connect gateway is unavailable; run 'receipt setup' or set RECEIPT_CONNECT_TOKEN` even when a session exists, because the session is consulted only when the token is missing (`:181`). Signed out with no env: the same gateway message (observed); env gateway without token: `Receipt Connect task token is unavailable; run 'receipt setup' or set RECEIPT_CONNECT_TOKEN`. There is no 401 retry on this path.

| Command | Request (`:205-241`) | Output |
|---|---|---|
| `list [--json]` | `GET /connect/agent/connections` — only `nango-reference` rows with `status: valid`, fields `id, provider, name, status` (`routes.ts:1069-1110`) | `Current connections:` + `  <provider>:<name> <status>` lines, or `Current connections: none`; `--json` → `{ok:true, connections}` |
| `tools <connection>` | `POST /connect/tools {connection}` | the gateway JSON (`{ok, connection, tools:[{name, description, access, inputSchema…}]}`) |
| `call <connection> <tool> [--json '{…}']` | `POST /connect/call {connection, tool, arguments}` (arguments default `{}`) | the gateway JSON |
| `call <connection> --path /x [--query-json '{…}'] [--headers-json '{…}'] [--method GET]` | `POST /connect/call {connection, method:"GET", path, query?, headers?}` | the provider JSON |

Client-side errors, all before any request (`:140-172`; observed): `receipt connect tools requires a connection id or provider:name` (also for `call` without a connection), `receipt connect call requires --path beginning with /` (missing tool and missing/invalid path), `receipt connect call is read-only and supports GET only`, `--json must contain valid JSON`, `--json must contain a JSON object` (same for `--query-json`, `--headers-json`). A non-2xx or `ok:false` reply throws the server's `error` string or `HTTP <n>` (`:100-104`; test `connect-cli.test.ts:431-453`); for `tools`/`call` a bad token now yields the two sentences quoted in 4.9.

`--json` is a boolean for `list` but the **argument payload** for `call <tool>` (`:152, 213`).

#### 4.11.6 `receipt connect relay`

Always fails: `receipt connect relay has been removed. Use \`receipt connect aws|gcp|…|azure-blob-storage\` to create Nango-backed connections.` (`:1074-1085`; observed).

### 4.12 The connector catalog (63 entries)

Built from `src/integrations/nango/catalog.json` (63 `providerSlugs`) and `slugs/<slug>/provider.json` (`receipt-connect-integration-registry.ts:77-95`). `normalizeReceiptConnectConnectorId` (`receipt-connect-connectors.ts:59-65`) is an exact lower-case lookup over every `aliases` entry plus the `productId` of a product's default auth mode (`registry.ts:101-111`): `jira` → `jira-oauth`, `confluence` → `confluence-oauth`, `tiktok` → `tiktok-ads`, `google` → `gcp`. Labels are not aliases. `CLI` is the real command a Factory runtime configures (`nango` = a Nango-backed credential helper); `setup` `provider-only` means Nango's Connect UI collects the credential and the gateway auto-creates the integration, `oauth2`/`custom` need an operator-configured Nango integration (`RECEIPT_NANGO_<ID>_INTEGRATION_ID`, server-side). Tool surface: `proxy-tools (r/w)` = typed tools in `receipt tools list`; `mcp` = provider-native MCP, reachable only via `--connection`; `atlassian-cloud-resource` = resource-aware GET; `-` = the single GET-only `read-provider-resource` tool (command-auth only for `aws`, `jira-api`).

| id | Label | Aliases | CLI | credentialMode | setup | tool surface |
|---|---|---|---|---|---|---|
| `aws` | AWS | aws, cloudwatch, ec2, ecs, eks, elb, iam, lambda, rds, s3, vpc | `aws` | aws-credential-process | provider-only | - |
| `gcp` | Google Cloud | gcp, gcloud, gcs, google, google-cloud, googlecloud, gsutil, bq, bigquery | `gcloud` | gcloud-config | oauth2 | proxy-tools (5 read/0 write) |
| `google-ads` | Google Ads | google-ads, googleads, adwords | `nango` | nango-credentials | oauth2 | - |
| `google-analytics` | Google Analytics | google-analytics, ga4 | `nango` | nango-credentials | oauth2 | proxy-tools (2/0) |
| `youtube` | YouTube Analytics | youtube, youtube-analytics | `nango` | nango-credentials | oauth2 | proxy-tools (2/0) |
| `google-docs` | Google Docs | google-docs, googledocs, gdocs | `nango` | nango-credentials | oauth2 | proxy-tools (2/0) |
| `google-mail` | Gmail | google-mail, gmail | `nango` | nango-credentials | oauth2 | proxy-tools (4/0) |
| `google-calendar` | Google Calendar | google-calendar, gcal, googlecalendar | `nango` | nango-credentials | oauth2 | - |
| `google-calendar-mcp` | Google Calendar (MCP) | google-calendar-mcp, gcal-mcp | `nango` | nango-credentials | oauth2 | mcp |
| `google-sheet` | Google Sheets | google-sheet, google-sheets, gsheets, googlesheets | `nango` | nango-credentials | oauth2 | - |
| `google-drive` | Google Drive | google-drive, gdrive, googledrive | `nango` | nango-credentials | oauth2 | proxy-tools (2/0) |
| `google-slides` | Google Slides | google-slides, gslides, googleslides | `nango` | nango-credentials | oauth2 | proxy-tools (2/0) |
| `google-chat` | Google Chat | google-chat, googlechat, gchat | `nango` | nango-credentials | oauth2 | proxy-tools (3/0) |
| `google-tasks` | Google Tasks | google-tasks, googletasks, gtasks | `nango` | nango-credentials | oauth2 | proxy-tools (3/0) |
| `jira-oauth` | Jira OAuth | jira-oauth, **jira** (product default) | `jira` | jira-config | oauth2 | atlassian-cloud-resource |
| `jira-api` | Jira API Token | jira-api, jira-basic | `jira` | jira-config | provider-only | - |
| `notion` | Notion | notion | `nango` | nango-credentials | oauth2 | - |
| `lagrowthmachine` | La Growth Machine | lagrowthmachine | `nango` | nango-credentials | provider-only | - |
| `linkedin` | LinkedIn | linkedin | `nango` | nango-credentials | oauth2 | - |
| `gong-oauth` | Gong (Oauth) | gong-oauth | `nango` | nango-credentials | oauth2 | - |
| `stripe-app` | Stripe App | stripe-app | `nango` | nango-credentials | oauth2 | - |
| `github` | GitHub | github, gh | `nango` | nango-credentials | oauth2 | - |
| `github-app-oauth` | GitHub (App OAuth) | github-app-oauth | `nango` | nango-credentials | custom | - |
| `github-pat` | GitHub (Personal Access Token) | github-pat | `nango` | nango-credentials | provider-only | - |
| `hubspot` | HubSpot | hubspot | `nango` | nango-credentials | oauth2 | - |
| `airtable` | Airtable | airtable, airtable-oauth | `nango` | nango-credentials | oauth2 | proxy-tools (4/0) |
| `meta-marketing-api` | Meta Marketing API | meta-marketing-api, meta-ads, facebook-ads, facebook-analytics | `nango` | nango-credentials | oauth2 | - |
| `apollo` | Apollo | apollo, apollo-api-key | `nango` | nango-credentials | provider-only | proxy-tools (1 read/3 write) |
| `attio` | Attio | attio | `nango` | nango-credentials | oauth2 | - |
| `zendesk` | Zendesk | zendesk, zendesk-oauth, zendesk-api-key | `nango` | nango-credentials | oauth2 | - |
| `gitlab` | GitLab | gitlab | `nango` | nango-credentials | provider-only | - |
| `slack` | Slack | slack | `nango` | nango-credentials | oauth2 | - |
| `linear` | Linear | linear | `nango` | nango-credentials | provider-only | mcp |
| `datadog` | Datadog | datadog, dd | `nango` | nango-credentials | provider-only | - |
| `sentry` | Sentry | sentry | `nango` | nango-credentials | provider-only | - |
| `cloudflare` | Cloudflare | cloudflare, cf | `nango` | nango-credentials | provider-only | - |
| `vercel` | Vercel | vercel | `nango` | nango-credentials | provider-only | - |
| `terraform` | Terraform Cloud | terraform, terraform-cloud, tfcloud, tfc | `nango` | nango-credentials | provider-only | - |
| `incident-io` | Incident.io | incident-io, incident.io, incidentio | `nango` | nango-credentials | provider-only | - |
| `azure-devops` | Azure DevOps | azure-devops, ado, azuredevops | `nango` | nango-credentials | oauth2 | - |
| `azure` | Azure | azure, azure-cloud, azure-resource-manager | `az` | nango-credentials | provider-only | proxy-tools (2/0) |
| `confluence-oauth` | Confluence OAuth | confluence-oauth, **confluence** (product default) | `nango` | nango-credentials | oauth2 | atlassian-cloud-resource |
| `confluence-api` | Confluence API Token | confluence-api, confluence-basic | `nango` | nango-credentials | provider-only | - |
| `anthropic` | Anthropic | anthropic | `nango` | nango-credentials | provider-only | - |
| `openai` | OpenAI | openai | `nango` | nango-credentials | provider-only | - |
| `zoom` | Zoom | zoom | `nango` | nango-credentials | oauth2 | - |
| `zoominfo` | ZoomInfo | zoominfo | `nango` | nango-credentials | oauth2 | - |
| `zoho` | Zoho | zoho | `nango` | nango-credentials | oauth2 | - |
| `zoho-crm`, `zoho-books`, `zoho-desk`, `zoho-calendar`, `zoho-inventory`, `zoho-mail`, `zoho-recruit`, `zoho-people`, `zoho-invoice` | Zoho CRM / Books / Desk / Calendar / Inventory / Mail / Recruit / People / Invoice | same as id | `nango` | nango-credentials | oauth2 | - |
| `instagram` | Instagram Insights | instagram, instagram-analytics, instagram-insights | `nango` | nango-credentials | oauth2 | proxy-tools (3/0) |
| `tiktok-ads` | TikTok Ads Analytics | tiktok, tiktok-ads, tiktok-analytics | `nango` | nango-credentials | oauth2 | proxy-tools (2/0) |
| `tiktok-accounts` | TikTok Accounts | tiktok-accounts, tiktok-business-accounts | `nango` | nango-credentials | oauth2 | proxy-tools (2/0) |
| `tiktok-personal` | TikTok Personal | tiktok-personal, tiktok-login-kit | `nango` | nango-credentials | oauth2 | proxy-tools (2/0) |
| `outlook` | Outlook | outlook, microsoft-outlook, outlook-mail | `nango` | nango-credentials | oauth2 | proxy-tools (4/0) |
| `azure-blob-storage` | Azure Blob Storage | azure-blob-storage, azure-blob, azure-storage | `nango` | nango-credentials | oauth2 | proxy-tools (2/0) |

The `azure` connector (`slugs/azure-service-principal/provider.json`) is the entry added since `41baea75`, taking the catalog from 62 to 63. The `setup --no-login` text output lists all 63 as `<id>: <label> via real '<command>' CLI`.

### 4.13 `receipt import clauden|claude-code [<path>]`

`runImport` (`src/connect-cli.ts:526-546`) → `runClaudenImport` (`src/cli/clauden-import.ts:1669-1872`) with `dataDir` = `$RECEIPT_DATA_DIR` or `~/.receipt/data`, `repoRoot` = cwd, `defaultProject` = `local`, and **`forceLocalStore: true`**. Source must be exactly `clauden` or `claude-code`; anything else, including a missing source, fails with `import source is required. Supported sources: clauden, claude-code` (`:531-535`; observed for `import bogus`). `claude-code` is fully implemented but appears in no help text.

Sources and default paths (`clauden-import.ts:190-196, 231-251, 1433-1452`): `clauden` reads the companion's NDJSON event log `~/.claudeN/events.ndjson` (or the legacy text log `~/.claudeN/clauden.log` when the resolved companion binary is named `clauden`); `claude-code` reads a raw Claude Code transcript, defaulting to the newest `.jsonl` under `~/.claude/projects/*/` by mtime (fallback `~/.claude/projects/latest.jsonl`).

| Flag | Default | Effect (line) |
|---|---|---|
| `<path>`, `--event-log`, `--path` | per source | file to read (1438) |
| `--mode metadata\|full` | `metadata` | else `--mode must be metadata or full` (1388-1392; observed) |
| `--stream <s>` | `imports/<source>/<project>/<sourceId>` | receipt stream (1717-1718) |
| `--project`, `--source-id` | derived (1700-1713; for `claude-code` the parent dir name and the `.jsonl` basename) | stream segments, sanitised to `[a-z0-9-]`, max 80 chars (492-495) |
| `--import-id` | `clauden_<base36 time>_<8 hex>` | run id (1714-1716) |
| `--max-lines <n>` | unlimited | stop after n lines (1790, 1795) |
| `--follow` | off (`observe` forces on) | keep tailing (1682-1685) |
| `--poll-ms <n>` | 1000 (floor 100) | tail interval (1699) |
| `--launch`, `--launch-proxy` | off | spawn the companion; requires follow: `--launch requires --follow or receipt observe clauden` (1686-1698) |
| `--proxy-bin`, `--clauden-bin`, `--port`, `--no-launch` | — | companion binary and args (522-582) |
| `--batch-size <n>` | 50 (max 100) | receipts per upload (401-404) |
| `--local-only`, `--no-cloud`, `--no-upload` (also camelCase) | off | never upload (1394-1400) |
| `--target <name>` | active session | which saved session to upload with (1406) |
| `--output-file <path>` | — | write the JSON result and print `{ok:true, outputFile, bytes}` (`connect-cli.ts:362-383`) — **plain `writeFile`, not atomic and not `0600`** |

Where receipts go (`:1172-1213, 1402-1408, 1719-1736`): **cloud whenever a saved session exists** — `storage: "cloud"`, receipts POSTed in batches to `<gatewayUrl>/api/receipt-ingest/receipts` with the session bearer token (`:320-321, 423-441`); otherwise the local file store `<dataDir>/receipt-import-store/streams/<url-encoded stream>.ndjson` plus `branches.json` — `storage: "local"`. Because the public binary passes `forceLocalStore: true`, the Postgres path (`ZERO_UPSTREAM_DB`) is **never** used from the public binary (`:1184-1187`); only the developer CLI can produce `storage: "postgres"`. The ingest endpoint (`apps/start/src/routes/api/receipt-ingest/receipts/route.tsx:10-16, 69-75`) requires `connect:write`, caps a request at 2 MiB and 100 receipts, and accepts only streams under `imports/clauden/` and `imports/claude-code/` (`unsupported_stream`: `Agent import ingestion requires streams under imports/clauden/ or imports/claude-code/.`), so a custom `--stream` outside those prefixes is rejected when uploading. Cloud uploads de-duplicate on the event id `<source>:<sourceId>:<objectId>:<eventType>` (`:406-418`).

Result JSON (`:106-120`): `{ok:true, source, importId, stream, sourcePath, mode, follow, storage, cloud?: {gatewayUrl, organizationId}, counts: {lines, captured, normalized, rejected, duplicateReceipts}}`. Each line yields two receipts, `import.raw_object.captured` and `import.object.normalized` (or `import.object.rejected`), bracketed by `import.batch.started` / `import.batch.completed` (`:30-81, 1083-1170`).

**Data-handling truth.** `--mode metadata` applies `redactClaudenPayload` — replacing the values of a fixed key list (`access_token, api_key, api-key, apikey, authorization, body, content, message, attachment, input, messages, output, prompt, result, refresh_token, request, response, signature, stderr, stdout, system, thinking, token`) with `[redacted:<key>]` — **to the raw captured payload only** (`:164-188, 679-692, 1145`). The normalized receipt is built from the *unredacted* parse (`normalizeClaudenEvent(parsed, …)`, `:1146`) and, for Claude Code transcripts, carries a `timeline` entry whose `text` is the prompt, the assistant reply, the tool-use command, or the tool output, plus `content`, `usage`, `toolUseResult`, `cwd`, `gitBranch`, and metadata such as `lastPrompt` (`:806-898, 881-891`). Metadata mode therefore still uploads prompt and output text in the normalized receipts; `full` additionally keeps the raw payload unredacted. `docs/receipt-cli.md:176-177` ("The observer defaults to metadata mode. Full prompt/response capture requires `--mode full`.") overstates the difference.

Imported runs appear in the web app at `/sessions` (component `apps/start/src/components/sessions/sessions-page.tsx`, empty state `No imported sessions yet` at `:436`); the area is `hideFromPrimaryNavigation: true` (`sessions-nav.config.tsx:20`), so it is reachable by direct URL only.

### 4.14 `receipt observe clauden|claude-code` and `observe clauden install|start|stop|status|uninstall`

`runObserve` (`src/connect-cli.ts:548-589`). Missing/unknown source → `observe source is required. Supported sources: clauden, claude-code`. Without a service action it is `import` with `forceFollow: true` (same flags as 4.13; `--launch` is legal here). A second positional in `install|start|stop|status|uninstall` (`clauden-service.ts:49-60`) selects the background-service action; for `claude-code` that is refused with `observe claude-code supports live file tailing only; use observe clauden install for proxy service install` (observed). `install` first resolves the companion binary and fails with the `Unable to find the Claude observer companion binary…` message when absent (`:565-567`; observed with `--no-start`).

Service (`src/cli/clauden-service.ts`): platform `launchd` on macOS, `systemd` on Linux, otherwise `Background Claude observation is currently supported on macOS and Linux.` (`:62-70`). Label `run.beetle.clauden-observer`, unit name `beetle-clauden-observer` (`:46-47`). Service file: `~/Library/LaunchAgents/run.beetle.clauden-observer.plist` or `~/.config/systemd/user/beetle-clauden-observer.service` (`:130-133`). The installed command is `<receiptBin> observe clauden --event-log <log> --mode <mode> --launch` plus `--proxy-bin`, `--poll-ms`, `--stream` when given (`:113-128`), with `RECEIPT_DATA_DIR=<dataDir>` in the environment; stdout/stderr go to `<dataDir>/logs/clauden-observer.out.log` and `.err.log` (`:160-172, 185-190`); launchd `RunAtLoad`/`KeepAlive` true, systemd `Restart=always`, `RestartSec=5`. Flags accepted by the service actions: `--mode`, `--event-log`/`--path`, `--proxy-bin`/`--clauden-bin`, `--poll-ms`, `--stream`, `--receipt-bin` (default the running executable), `--no-start` (`:94-146, 262`).

Actions (`:254-323`): `install` writes the file and (unless `--no-start`) `launchctl bootout`/`bootstrap gui/<uid>`/`kickstart -k`, or `systemctl --user daemon-reload`/`enable`/`restart`; `start` re-installs and starts (launchd) or `systemctl --user start`; `stop` → `bootout` / `systemctl --user stop`; `uninstall` → stop, remove the file, `daemon-reload`; `status` → `launchctl print gui/<uid>/<label>` / `systemctl --user is-active --quiet`. Result JSON (observed for `status`): `{ok:true, action, platform, label, serviceFile, dataDir, eventLog, mode, active?}`; `active` is omitted for `install --no-start`. Note the service and the `--launch` path stream **to the cloud store by default** whenever a session exists (4.13).

The companion launch (`clauden-import.ts:556-604`) runs `<binary> run --event-log <path> --receipt-mode <mode> [--port <n>] [--no-launch]` (legacy `clauden`: `run --verbose`) with `CLAUDEN_EVENT_LOG`, `RECEIPT_CLAUDEN_EVENT_LOG`, `RECEIPT_CLAUDEN_MODE` in its environment, and kills it when the import ends (`:1626-1630, 1832-1836`).

---

## 5. Environment variables read by the public binary

| Variable | Read by | Effect |
|---|---|---|
| `RECEIPT_CLI_CONFIG_DIR` | session store (`receipt-cli-session.ts:39-41`) | config directory (default `~/.receipt`) |
| `RECEIPT_CLI_SESSION_FILE` | `:43-45, 60` | exact active-session path; disables per-target files |
| `RECEIPT_CLI_VERSION` | `connect-cli.ts:52` | version string only when not a compiled build (release builds use the baked constant) |
| `RECEIPT_CONNECT_OPEN_BROWSER` | `connect-cli.ts:242`, `cli-login.ts:19` | `0` disables every browser launch |
| `RECEIPT_CONNECT_PUBLIC_GATEWAY_URL` | proxy `:52, 586`; session env export | prod gateway (highest precedence); also captured at module load |
| `RECEIPT_PUBLIC_BASE_URL` | proxy `:53` | module-load prod default |
| `RECEIPT_CONNECT_WORKER_GATEWAY_URL`, `RECEIPT_CONNECT_PUBLIC_URL` | proxy `:587-588` | prod gateway |
| `RECEIPT_CONNECT_PROD_GATEWAY_URL`, `RECEIPT_CONNECT_PROD_SERVER_URL`, `RECEIPT_CONNECT_PROD_URL`, `RECEIPT_CONNECT_URL`, `RECEIPT_APP_URL`, `RECEIPT_CONNECT_PROD_AUTH_URL` | proxy `:598-628` | prod gateway/auth (2.2) |
| `RECEIPT_CONNECT_DEV_GATEWAY_URL`, `RECEIPT_CONNECT_DEV_SERVER_URL`, `RECEIPT_CONNECT_DEV_URL`, `RECEIPT_DEV_APP_URL`, `RECEIPT_CONNECT_DEV_AUTH_URL` | proxy `:598-628` | dev gateway/auth |
| `RECEIPT_CONNECT_LOCAL_SERVER_URL`, `RECEIPT_CONNECT_GATEWAY_URL`, `RECEIPT_PROXY_SERVER_URL`, `RECEIPT_PORT`, `PORT` | proxy `:566-573` | local gateway |
| `RECEIPT_CONNECT_LOCAL_AUTH_URL`, `RECEIPT_AUTH_URL`, `BETTER_AUTH_URL`, `VITE_BETTER_AUTH_URL`, `WEB_PORT` | proxy `:575-578` | local auth origin |
| `RECEIPT_CONNECT_GATEWAY_URL` (again), `RECEIPT_PROXY_SERVER_URL` | agent CLI `:176-179` | gateway for `connect list\|tools\|call` |
| `RECEIPT_CONNECT_TOKEN` | agent CLI `:180`; mcp-cli `:89` | task token: wins for `connect list\|tools\|call`; fallback for `tools` / `mcp serve` |
| `RECEIPT_CONNECT_ORGANIZATION_ID`, `RECEIPT_CONNECT_WORKSPACE_ID`, `RECEIPT_CONNECT_WORKSPACE_NAME` | mcp-cli `:90-116` | env identity for `tools` / `mcp serve` (org id required) |
| `RECEIPT_CONNECT_USER_ID` | session env export only | set by `setup`/`login` in-process |
| `RECEIPT_DATA_DIR` | `connect-cli.ts:356-360`; service unit | local data dir for import/observe (default `~/.receipt/data`) |
| `CODEX_HOME` | mcp-cli `:244-250` | Codex config location |
| `RECEIPT_CLAUDE_PROXY_BIN`, `CLAUDEN_BIN` | clauden-import `:528-529` | companion override |
| `PATH` | clauden-import `:221-229` | companion lookup |
| `ZERO_UPSTREAM_DB` | clauden-import `:1186` | read but inert in the public binary (`forceLocalStore`) |
| `HOME` | Node `os.homedir()` | all `~` defaults |

Not read by the public binary: any `.env` file, `START_ALL_*`, `RECEIPT_CLI_LOAD_LOCAL_ENV`, `RECEIPT_CLI_NO_FORCE_EXIT` (those belong to `src/cli/env.ts` and `src/cli.ts`, section 8). Build-time only: `RECEIPT_CLI_BUILD_VERSION`, `RECEIPT_CLI_DEFAULT_PROD_GATEWAY_URL` (defines), and the build script's `RECEIPT_CLI_VERSION`, `RECEIPT_CLI_RELEASE_DIR`, `RECEIPT_CLAUDE_PROXY_DIR`, `RECEIPT_CLAUDE_PROXY_REQUIRED`. Installer only: `RECEIPT_CLI_VERSION`, `RECEIPT_CLI_REPO`, `RECEIPT_CLI_BIN_DIR`, `RECEIPT_CLI_BIN`. Set for the spawned companion: `CLAUDEN_EVENT_LOG`, `RECEIPT_CLAUDEN_EVENT_LOG`, `RECEIPT_CLAUDEN_MODE`.

---

## 6. Exit codes and output conventions

- **Exit codes.** `0` on success, including `logout` with no session and `login --no-login`. `1` whenever a handler throws (`main().catch`, `connect-cli.ts:1248-1251`) and for `doctor` when `ok` is false or the endpoint cannot be resolved (`:980, 1071`). No other codes exist. A device-login failure, a rate limit, a 401 that survives the single retry, and every validation error are all `1`.
- **Streams.** Results and status lines (`Starting Receipt Connect sign-in…`, `Step 1 of 2…`, `Saved Receipt session was rejected…`) go to **stdout** via `console.log`; only the final error message goes to stderr via `console.error`. `setup --json` and `login --json` suppress the status lines (`:457-462`), but `connect status|<provider>` with a fresh login still print them before their result. Scripts that parse stdout should use the `--json` forms and `doctor --json`.
- **`--json` has three meanings.** Output switch for `doctor`, `setup`, `login`, `workspace`, `connect list`, `mcp config`; the tool-argument payload for `tools call` and `connect call <tool>`; ignored by `import`/`observe`, which always emit JSON.
- **Envelopes.** `doctor` (4.4), `setup`/`login` (4.7/4.5), `workspace` (4.8), `tools` `{ok, …result, workspace}` (4.9), `mcp` (4.10), `connect list --json` `{ok, connections}`, `import`/`observe` (4.13).
- **`--output` / `--output-file`.** `tools` and `mcp config`: atomic write via `<path>.receipt-tmp-<pid>` + rename, mode `0600`, parent dirs created `0700` (`receipt-mcp-cli.ts:232-242`), and stdout gets `{ok:true, outputFile:<abs>, bytes}`. `import`/`observe`: plain `fs.writeFile` after `mkdir -p`, default umask, then the same pointer object (`connect-cli.ts:362-383`). `doctor`, `setup`, `login`, `workspace`, `connect …` have no output-file flag.
- **Never printed.** The session token (asserted by tests); `doctor` prints `expiresAt` but not the JWT. `whoami` does not exist on the public binary; `doctor` is the identity display.

---

## 7. Troubleshooting

| Message (verbatim) | Cause | Fix |
|---|---|---|
| `receipt: command not found` (shell) | `~/.local/bin` not on `PATH` | add the line the installer printed; `command -v receipt` shows which of several binaries wins |
| `Unsupported OS: <os>` / `Unsupported architecture: <arch>` | installer on Windows or a non-arm64/x64 CPU | no build exists; use macOS/Linux arm64/x64 |
| `Download failed: <url>` … `Check that this release and asset exist.` | wrong `RECEIPT_CLI_VERSION`/`RECEIPT_CLI_REPO`, or offline | check the tag exists under `kentronai/receipt-cli` releases |
| `checksums.txt has no entry for <file>` or a checksum mismatch | corrupted or mismatched asset | re-run; do not install by hand |
| `receipt connect production URL is not configured yet. Set RECEIPT_CONNECT_PUBLIC_GATEWAY_URL=https://app.kentron.ai and re-run, or set …` | running from a **source checkout** with no env and no `.sst/outputs.json`, or a pre-preview.7 binary | upgrade to preview.7, or export `RECEIPT_CONNECT_PUBLIC_GATEWAY_URL`, or pass `--server-url` |
| `receipt connect dev URL is not configured. Set RECEIPT_CONNECT_DEV_GATEWAY_URL or RECEIPT_CONNECT_DEV_URL.` | `--target dev` has no default | export one of those |
| `receipt connect target must be prod, dev, local, or an http(s) URL` | typo in target, or `receipt login <word>` | use a target name or a full URL |
| `receipt doctor: attention needed` + `Receipt gateway <url> did not answer a health check (…)` | wrong host, stack not running, port mismatch for `local` | fix `--server-url` / `RECEIPT_CONNECT_LOCAL_SERVER_URL`; for the repo's own stack use the 5xxx ports (`HEAD:LOCAL_SETUP.md:975-985`) |
| `Receipt sign-in origin <url> is unreachable (…)` | `--auth-url` / `RECEIPT_CONNECT_LOCAL_AUTH_URL` wrong | must be the origin the browser uses |
| `receipt connect device login failed to start: http_404` | `authUrl` is not the web app (for example a gateway that does not serve `/api/receipt-connect/cli-login`) | pass `--auth-url <web origin>` |
| `receipt connect device login failed to start: rate_limited` | more than 10 starts/min or 3 pending per client IP | wait 60 s |
| `receipt connect device login failed to start: receipt_connect_storage_unavailable` | server-side store down | retry later |
| `receipt connect device login expired` / `… timed out` | 10-minute code or 10-minute poll exceeded | run the command again and approve promptly |
| `receipt connect login did not return a workspace; select a Receipt workspace and try again` | the approving browser session has no active organization | the browser page also says `Select a workspace first`; pick one in the app and re-run |
| Browser page `This Receipt Connect code was already used. Run the CLI command again.` | approving twice | re-run the CLI for a new code |
| `receipt mcp: not signed in; run 'receipt setup' first` (also for `tools`) / `receipt workspace: not signed in; run 'receipt setup' first` | no saved session (or `--target` names one that does not exist) | `receipt setup`; `receipt tools --help`/`mcp --help`/`workspace --help` produce this too because they do not print help |
| `Receipt Connect gateway is unavailable; run 'receipt setup' or set RECEIPT_CONNECT_TOKEN` | `connect list\|tools\|call` with no session and no env, **or** `RECEIPT_CONNECT_TOKEN` set without `RECEIPT_CONNECT_GATEWAY_URL` | sign in, or set both env vars |
| `Receipt Connect task token is unavailable; run 'receipt setup' or set RECEIPT_CONNECT_TOKEN` | env gateway set but no token | set `RECEIPT_CONNECT_TOKEN` or unset the gateway so the session is used |
| `unauthorized` from `workspace`/`tools`/`mcp` | expired (12 h) or revoked token; these commands do not check `exp` | `receipt doctor` shows `EXPIRED`; run `receipt setup` (or `--fresh-login`) |
| `Saved Receipt session was rejected by the gateway; signing in again.` then success | 401 on a saved token during `connect status\|<provider>\|disconnect` | nothing; the CLI retried once |
| `Receipt could not authenticate this task. Its runtime access token must be renewed before retrying.` | 401 on `connect tools\|call` or `tools --connection` | re-run `receipt setup`; in a sandbox, mint a new task token |
| `Receipt could not authorize this task to use the connection. This is a task permission problem; reconnecting the account will not fix it.` | token lacks `connect:credential` (discovery-only token) | use a CLI login token or a task token with execution scope |
| `workspace_membership_required` | token's `ws_id` not a member of the workspace / no mutation authority | `receipt workspace use <ws>`; ask an admin |
| `Saved session targets <a>, not <b>; run 'receipt setup' for this target.` | `doctor --target X` while the session is for Y | run `doctor` with the target you signed in with, or `setup --target X` |
| `unsupported Receipt Connect onboarding choice: <Label>` | numbered menu pick of a multi-word label (4.11.1) | `receipt connect <id>` or `--provider <id>` |
| `unsupported Receipt Connect provider. Use aws, gcp, …` | unknown connector word (also a mistyped subcommand such as `statsu`) | see 4.12 |
| `Unsupported connector. Use one of: …, or any integration configured in Nango.` (400) | server does not know the id | same |
| `Receipt Connect Nango is not configured…` (503) | deployment lacks Nango | operator action |
| `Timed out waiting for <provider> connection.` | authorization not completed in `--timeout-ms` | finish in the browser, then `receipt connect status` |
| `receipt connect disconnect: no aws:default connection found` after `receipt connect disconnect` | defaults are `--provider aws --name default` | pass `--provider <p>` |
| `receipt connect relay has been removed. …` | legacy command | use `receipt connect <id>` |
| `--json must contain valid JSON` / `--json must contain a JSON object` / `--json must be a JSON object` | shell quoting, or an array | wrap in single quotes; pass an object |
| `receipt connect call is read-only and supports GET only` | `--method POST` etc. | use a named tool (`connect tools <conn>`) |
| `receipt connect call requires --path beginning with /` | no tool and no absolute `--path` | give a tool name or `--path /…` |
| `Codex MCP server 'receipt' is already installed; remove it first` | duplicate install | `receipt mcp remove codex` then install (also after upgrading the binary path) |
| `Codex does not accept an arbitrary config path; expected <path>. Set CODEX_HOME before running Receipt if Codex uses another home.` | `--client-config` differs | export `CODEX_HOME` |
| `refusing to modify non-regular client config: <path>` | `config.toml` is a symlink | replace it with a regular file |
| `codex mcp install failed and the prior config was restored: <stderr>` | `codex` missing or failing | install Codex; check `--client-bin` |
| `receipt mcp install/status/remove currently supports codex; use 'receipt mcp config --client generic' for other clients` | other client | paste the generic JSON by hand |
| `receipt tools list` prints no tools | no valid connection in the token's workspace, or only provider-native MCP connectors | `receipt workspace current`, `receipt connect status`, connect a provider; use `--connection` for `linear`/`google-calendar-mcp` |
| `Receipt tool '<name>' was not found` | name typed or constructed | copy it from `tools list` after re-listing |
| `import source is required. Supported sources: clauden, claude-code` / `observe source is required…` | missing or unknown source | `clauden` or `claude-code` |
| `Unable to find the Claude observer companion binary. …` | preview.7 ships no companion; installer never installs one | `--proxy-bin`/`RECEIPT_CLAUDE_PROXY_BIN`, or wait for a bundled release |
| `--launch requires --follow or receipt observe clauden` | `import … --launch` | use `observe` |
| `Background Claude observation is currently supported on macOS and Linux.` | other OS | run `observe` in the foreground |
| `unsupported_stream` from the ingest endpoint | custom `--stream` outside `imports/clauden/` / `imports/claude-code/` | keep the default stream or add `--local-only` |
| `--help` opened a browser | `receipt --help <word>` or bare `receipt` (4.0) | `receipt --help` alone; `Ctrl-C` cancels the poll; the code expires in 10 min |

**Production vs. local.** Hosted: nothing to configure; `receipt doctor` then `receipt setup`. Local stack from this repo: export `RECEIPT_CONNECT_LOCAL_SERVER_URL` (runtime API or gateway) and `RECEIPT_CONNECT_LOCAL_AUTH_URL` (the exact browser origin), then `receipt doctor --target local`, `receipt setup --target local`, `receipt connect local`; the most recent `setup` decides which target `workspace`/`tools`/`mcp` use, and `setup --target prod` (or plain `setup`) flips back (`docs/receipt-cli.md:196-212`; `HEAD:LOCAL_SETUP.md:975-985`).

**CI and sandboxes.** Export `RECEIPT_CONNECT_GATEWAY_URL` and `RECEIPT_CONNECT_TOKEN` (plus `RECEIPT_CONNECT_ORGANIZATION_ID` for `tools`/`mcp serve`); `connect list|tools|call` then never touch `~/.receipt`, and `tools`/`mcp serve` fall back to those variables when no session file exists. Use `RECEIPT_CLI_CONFIG_DIR` to isolate any session that does get written, and `RECEIPT_CONNECT_OPEN_BROWSER=0` so an accidental onboarding cannot spawn a browser. Gate health checks on `receipt doctor --json` exit codes.


---

## 8. Developer CLI (from source) — for a "Developer CLI (from source)" subsection

**How it is launched.** `.receipt/bin/receipt` is a POSIX `sh` wrapper: it resolves its own symlinks, `cd`s to the repo root two directories up, exports `RECEIPT_REPO_ROOT` and `RECEIPT_REPO_KEY` (default `receiptfactory`), resolves Bun from `RECEIPT_BUN_BIN`, `BUN_BIN`, `PATH`, `BUN_INSTALL/bin/bun`, `~/.bun/bin/bun` (else `receipt CLI requires Bun. Set RECEIPT_BUN_BIN or install Bun on PATH.`, exit 127), and `exec`s `bun packages/receipt-app/src/cli.ts "$@"`. `packages/receipt-app/package.json:6-8` maps the `receipt` bin to `./src/cli.ts`. `src/cli.ts:3-5` loads env files first (`loadReceiptCliEnv`, `src/cli/env.ts:148-188`: repo `.env`, `.env.local`, `apps/start/.env`, `apps/start/.env.local`, then `.deploy-artifacts/local-up/latest.env` unless `RECEIPT_CLI_LOAD_LOCAL_ENV=0`, plus `START_ALL_ENV_FILE`, `RECEIPT_LOCAL_ENV_FILE`, `VALIDATE_STACK_ENV_FILE`, `*_ENV_FILES`; exported shell values always win), then dispatches; with no command on a TTY it opens the Factory board (`:23-28`); errors print `error: <message>` (`:52-56`); `RECEIPT_CLI_NO_FORCE_EXIT=1` disables the forced exit (`:41-49`). There is **no `--version`** in this CLI.

**Prerequisites.** A git checkout, Bun (via `./bunw` or the wrapper's lookup), Postgres for most commands, `codex` for Factory runs; `receipt doctor` here is a *different* command from the public one — it probes `bun`, `git`, `gh`, `aws`, `codex` (overrides `RECEIPT_BUN_BIN`, `RECEIPT_GIT_BIN`, `RECEIPT_GH_BIN`, `RECEIPT_AWS_BIN`, `RECEIPT_CODEX_BIN`), the repo, `.receipt/config.json`, `gh auth status` and `aws sts get-caller-identity`, and treats a missing `bun`/`git`/`codex` or a non-repo as **blocking** (`src/cli/doctor.ts:258-436`; text lines `doctor: ok|blocked`, `provider auth: organization BYOK required`, `:438-465`).

**Top-level commands** (`src/cli/shared.ts:14-101` usage; dispatcher `src/cli/commands.ts:5299-5423`), one line each:

| Command | Purpose |
|---|---|
| `setup`, `login [prod\|dev\|local\|<url>]`, `logout`, `whoami` | sign in/out and print identity (`whoami` is developer-only) |
| `workspace`, `tools`, `mcp` | the shared services of section 4 (flags re-serialised, `commands.ts:5376-5401`) |
| `connect …` | public surface plus developer extras: `check\|doctor` (Nango health + signed webhook probe), `whoami`, `token\|jwt\|mint` (mint a Connect JWT from the server secret), `import-local-aws`, `import-local-github`, `nango` |
| `import clauden\|claude-code`, `observe …` | same engine, but may store to Postgres when `ZERO_UPSTREAM_DB` is set; unknown source → `Unknown import source '<x>'. Supported sources: clauden, claude-code` (`:5221`) |
| `doctor [--json] [--output-file] [--repo-root]` | environment/binary/auth check above |
| `debug local\|prod\|probe\|objective\|job-abort` | stack diagnostics and hosted debugging |
| `trace`, `replay`, `inspect`, `fork` | receipt-stream reads and branching |
| `dst` (alias `simulate`) | deterministic simulation reads |
| `eval run\|batch\|report\|inspect\|replay\|list-scenarios` | evaluation scenarios |
| `jobs list\|enqueue\|wait\|steer\|follow-up\|abort`, `abort <job>` | queue control |
| `memory …`, `sessions search\|read` | memory scopes and session search |
| `factory …` | the Factory subtree (`init\|run\|create\|compose\|watch\|inspect\|replay\|analyze\|…\|agent`) |
| `new`, `dev`, `run` | legacy agent-framework commands |
| `proxy` | removed; always throws |

**The `receipt factory agent` envelope.** Every `receipt factory agent <action>` (`board`, `inspect`, `output`, `investigate`, `context`, `start`, `create`, `steer`, `follow-up`, `react`, `resume`, `computer …`) returns one JSON object with `schema: "receipt-cli/factory-agent-envelope/1"`, `type: "factory.agent.envelope"`, `ok`, `command` (`factory.agent.<action>`), `mode` (`read` | `write`), `data`, `error` (`null` or `{code, message, hint, details?}`), `artifactRefs` (`[{kind:"artifact", ref, label?, bytes?, sha256?}]` — durable paths to prompt/stdout/stderr/result files), and `nextCommands` (safe continuations) (`src/factory-cli/commands/index.ts:1744-1773`; `skills/factory-agent-cli/SKILL.md:8, 43-53`). `--output-file <path>` writes the full envelope to disk and prints a small envelope whose `artifactRefs[0]` points at the file. Docs should tell agents to follow `artifactRefs` and `nextCommands` rather than scrape prose (`docs/ai-agent-receipt-cli.md:62-77`).

The sandbox worker CLI (`src/connect-worker-cli.ts`) exposes `workspace current|identity|list`, `tools`, `mcp config|serve`, and `connect list|tools|call` with identity only from `RECEIPT_CONNECT_GATEWAY_URL`/`RECEIPT_CONNECT_TOKEN`/`RECEIPT_CONNECT_ORGANIZATION_ID`; `workspace create|rename|use|delete` are refused (`The worker workspace is pinned by the objective token; …`). It is what `.receipt/bin/receipt` resolves to inside Factory task worktrees.

---

## Changes since 41baea75

Commits touching the CLI: `48cdeca8` (baked hosted default), `9b8b7574` (release hardening), `3c52d87c` (onboarding verbs and session-aware connect), `53f74bed` (URL normalizer, doctor tests), `a6a32fc7`/`21c2d6f0` (docs), plus the `azure` connector and the gateway 401/403 rewording that arrived with `c3c16be6`'s merge.

1. **Hosted default baked into release builds.** `buildTimeProdGatewayUrl()` reads the `RECEIPT_CLI_DEFAULT_PROD_GATEWAY_URL` define between the env chain and `.sst/outputs.json` (`proxy.ts:56-73, 591-597`); the prod error now suggests `RECEIPT_CONNECT_PUBLIC_GATEWAY_URL=https://app.kentron.ai`. The release script disables dotenv/bunfig autoload and smoke-tests from a clean `HOME`. Prior research §1's "P0" applies only to preview.6 and to source checkouts without env.
2. **New verbs** `login`, `logout`, `doctor` (`connect-cli.ts:884-1072`); `connect doctor|check` now run the read-only doctor, not `setup` (`:1144-1147`).
3. **Expiry-aware `setup`** (`:422-426`) plus `activateReceiptCliSession` so the last `setup` wins (`receipt-cli-session.ts:182-186`); expiry helpers at `:188-221`. `workspace`/`tools`/`mcp` still do not check `exp`.
4. **Session-aware `connect`**: `status|disconnect|<provider>|onboarding` reuse the saved session and retry once on 401 (`:842-882, 1188-1206`); `connect list|tools|call` read the session when no env token is set and never send it to a foreign host (`agent-cli.ts:181-190`). Prior research §8/§8.5 are obsolete.
5. **One URL comparator** `sameNormalizedReceiptConnectUrl` (`proxy.ts:374-395`) used by setup, connect, doctor, and the agent commands; `localhost` ≡ `127.0.0.1`.
6. **Hint strings** in `receipt-mcp-cli.ts:121` and `receipt-workspace-cli.ts:207-210` now say `run 'receipt setup' first` (were `receipt login`).
7. **Help text** gained the `login`/`logout`/`doctor` lines and the "Default hosted endpoint" paragraph (`:68-135`); `printConnectUsage` and `scripts/install-receipt-cli.sh` point at `kentronai` instead of the old personal fork.
8. **Catalog 62 → 63**: `azure` (`az` CLI, provider-only, two typed read tools). The onboarding menu is 64 entries.
9. **Gateway `/connect/tools` and `/connect/call`** answer 401/403 with the two explanatory sentences and codes in 4.9 instead of `unauthorized` (`receipt-connect-routes.ts:701-722`).
10. **Release state**: `v0.1.0-preview.7` is published, its checksums match `dist/`, the public `install.sh` defaults to it, and the public README is rewritten for it; `docs/receipt-cli.md:20-28` and the debug report's "Remaining issues" now lag reality.
11. **Docs added**: `docs/receipt-cli-debug-report.md`, RCA-523 in `docs/agent-fix-checklist.md`, `LOCAL_SETUP.md` (local variables), `apps/start/.env.example:160-167`, `skills/receipt-connect-cli-prod-debug/SKILL.md`.

Unchanged and still true from the prior research: the dispatch order and `--help` quirks, the boolean-flag swallowing, the onboarding-menu label bug, no `--name` for CLI connections (always `default`, always Default workspace), Codex-only `mcp install|status|remove`, `--wait=false` not working, the installer never installing the companion, the 12-hour token with no refresh, metadata mode not redacting normalized text, and `/sessions` hidden from navigation.

**Corrections to `doc/cli/*.mdx` (all otherwise verified against HEAD):**
- `overview.mdx`: add the `--help <word>` trap (it starts onboarding); note `receipt workspace --help` fails with the "supports list, current…" error when signed in.
- `install.mdx`: accurate; add that the preview.7 tarballs contain no companion at all (the note currently hedges "even when a release archive bundles one").
- `setup.mdx`: accurate. Optionally note `receipt login` also honours `--no-login`.
- `doctor.mdx`: `--target` also accepts an `http(s)` URL; a positional target is ignored.
- `connect.mdx`: the menu ends at `64. Show status only`, not 63; the 38 failing labels are enumerable (4.11.1); `connect tools|call` 401 bodies are now the two sentences in 4.9, not `unauthorized`; the "saved token only ever sent to its own gateway" guarantee is specific to `connect list|tools|call`.
- `tools-and-mcp.mdx`: identity is "saved session first, environment as fallback", not "either/or"; `--server-url` on `tools`/`mcp` sends the saved session token to the override host; `receipt tools --help` runs `tools list`.
- `workspaces.mdx`: an ignored flag's value becomes a positional (e.g. it can end up in a workspace name).
- `observe-claude-code.mdx`: the `Unknown import source 'codex'…` string belongs to the developer CLI; the public binary prints `import source is required. Supported sources: clauden, claude-code` for any unknown source. The `storage: "postgres"` path is unreachable from the public binary. `--output-file` on `import`/`observe` is not atomic/`0600` (only `tools`/`mcp config` are).

**Corrections to `doc/research/04` and `05`:** items 1–10 above; catalog count 63; installer defaults `kentronai/receipt-cli` and `v0.1.0-preview.7`; the in-repo installer clones `kentronai/Receipt`; `RELEASE-HANDOFF.md`'s "not yet published" is stale. `05`'s dispatch table and usage text still hold except the `run 'receipt login'` hints and the distribution URL.

---

## Documentation implications

**Suggested page split.** Keep the eight `cli/` pages and apply the corrections above; lead `overview` with the browser-opening traps (bare `receipt`, `--help <word>`), state in `install` that preview.7 has no companion, add the `--server-url` token caveat and precedence sentence to `tools-and-mcp`, and the failing-label list plus new 401/403 sentences to `connect`. Add a "Developer CLI (from source)" page from section 8 and an "Automation and CI" page from 4.11.5, 5, 6 and 7.

**What to claim / avoid.** Claim: single-binary install with checksum verification; hosted origin baked in; read-only `doctor`; 12-hour session with automatic re-login by `setup`; session-reusing `connect`; token-free MCP client configs with Codex install/backup/rollback; workspace switching with server-minted tokens; 63 connectors by id. Avoid: "private by default" for observation (metadata mode uploads prompt/output text in normalized receipts, and uploads are the default once signed in); named connections from the CLI; the observer being installed by `receipt setup` on a fresh preview.7 install; `--help` on `tools`/`mcp`/`workspace`; Windows or npm.

**Marketing / public-doc claims checked against code:**

| Claim (source) | Status | Reason |
|---|---|---|
| "The hosted Receipt origin (`https://app.kentron.ai`) is built into the binary, so there is nothing to configure for the hosted app." (README) | supported | `build-receipt-cli-release.sh:9, 107`; `proxy.ts:69-73`; clean-HOME `doctor` resolved it |
| "`receipt doctor` is read-only … never opens a browser and never prints your token." (README) | supported | `connect-cli.ts:955-1072`; tests `:701, 727, 750` |
| "The saved token lasts 12 hours. When it expires, `receipt setup` notices and signs you in again." (README) | supported | `auth-token.ts:24`; `connect-cli.ts:422-426`; test `:501-520` |
| "`receipt connect` commands reuse the session saved by `receipt setup`; they do not open a second browser sign-in." (README) | supported | `:842-855`; tests `:572-590` |
| "The generated configuration never contains your session token" (README) | supported | `receipt-mcp-cli.ts:312-327, 653-654, 671` |
| "The binary ignores any `.env` file in your working directory" (README) | supported | build flags `:101-105`; no env loader imported |
| "the installer verifies the SHA-256 of the asset before installing it" (README) | supported | `install.sh:41-60, 95-96` |
| "installs the Claude observer when a release bundles it" (README, `docs/receipt-cli.md:172-176`) | partial | code path exists (`:498-524`), but preview.7 bundles nothing and `install.sh` would not install a companion anyway |
| "A saved token is only ever sent to its own gateway" (debug report, commit `3c52d87c`) | partial | enforced for `connect list\|tools\|call` (`agent-cli.ts:186`); `tools`/`mcp --server-url` still send the session token to the override host (`mcp-cli.ts:123-126`) |
| "The observer defaults to metadata mode. Full prompt/response capture requires `--mode full`." (`docs/receipt-cli.md:176-177`) | partial | metadata redacts raw payload keys only; normalized `timeline.text` carries prompts/outputs (`clauden-import.ts:1145-1147, 881-891`) |
| "Connect multiple accounts for the same provider by giving each connection a stable name during onboarding." (`docs/receipt-cli.md:179-181`) | unsupported | the CLI sends no name (`:676-685`); connections are always `default` |
| "Receipt stores only encrypted org-scoped connection references." (README) | partial | the CLI never sees secrets and `/connect/agent/connections` returns only `nango-reference` rows (`routes.ts:1090-1092`); at-rest encryption is a server property not audited in this report |
| "Run `receipt --help` for the full list of supported providers." (README) | supported | `:62-67, 89`; observed |
| "Fixes fresh-install onboarding … works out of the box" (README, release notes) | supported for `doctor`; not exercised for sign-in | clean-HOME `--version` and `doctor` verified; no sign-in was performed |

---

## Open questions

1. Should `receipt tools`/`receipt mcp` apply the same same-host guard as the agent commands before sending the saved token to a `--server-url` override (`receipt-mcp-cli.ts:123-126`)? Today the guarantee is asymmetric.
2. `receipt --help <word>` and bare `receipt` both start a device login; is a help-first default (or requiring `receipt connect` explicitly for onboarding) acceptable for the next release? It would also stop scripts from accidentally consuming the 10-start rate limit.
3. Will a future release bundle `receipt-claude-proxy`, and will `install.sh` be taught to install it (`docs/receipt-cli.md:277-280`)? Until both happen, `receipt setup` always reports the observer as skipped on a fresh install.
4. Should the onboarding menu resolve by index into connector ids rather than by label (4.11.1)? The fix is one line but has not landed.
5. `RECEIPT_CONNECT_TOKEN` without `RECEIPT_CONNECT_GATEWAY_URL` defeats the saved session for `connect list|tools|call` (`agent-cli.ts:181-190`); is that intended, or should the session gateway fill in when only the token is present?
6. Metadata-mode redaction: is the intended contract "raw payload redacted, normalized text retained" (documented as such), or should the normalized `timeline` also be redacted in metadata mode?
7. `docs/receipt-cli.md:20-28` and `RELEASE-HANDOFF.md` describe an unpublished release; both should be updated now that preview.7 is live and the installer default is bumped.
8. `LOCAL_SETUP.md` is tracked at the root at HEAD but moved to `docs/LOCAL_SETUP.md` in the working tree; `apps/start/.env.example:163` and `docs/receipt-cli-debug-report.md` reference the root path. Which location is canonical?
9. The public README says "Connections created from the CLI are named `default` and live in the Default workspace" — is the plan to add `--name` and a workspace selector to `receipt connect <provider>`, or to keep the web UI as the only place for named/non-Default connections?
