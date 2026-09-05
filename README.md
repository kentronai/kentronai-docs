# Kentron docs

The source for the Kentron documentation site at **[docs.kentron.ai](https://docs.kentron.ai)**. It is a
[Mintlify](https://mintlify.com) site: every page is an MDX file in this repository, and the whole
navigation is declared in [`docs.json`](docs.json).

The site documents **Receipt**, the AI chat platform that runs on the Kentron platform — for the people
who use it, the developers who build on it, and the operators who self-host it.

## What is in here

48 pages across six tabs. Each tab is a directory, and the file layout mirrors the URL: `guides/getting-help.mdx`
is served at `/guides/getting-help`.

| Tab | Directory | What it covers |
| --- | --- | --- |
| **Guides** | `introduction.mdx`, `getting-started/`, `guides/` | What Receipt is, your account and first chat, connecting an app, background runs, receipts and replay, then day-to-day work: files, conversations, errors and limits, monitoring runs, Slack, and getting help. |
| **Platform** | `platform/` | Organizations and workspaces, members and roles, model policy and bring-your-own-key, guardrails, org skills and knowledge, usage and billing, integrations, connection scopes, tool permissions, the MCP gateway, and data handling. |
| **CLI** | `cli/` | The released `receipt` binary that end users install: install, setup, workspaces, connect, tools and MCP, and observing Claude Code. |
| **Developers** | `develop/` | Platform architecture, receipts and streams, jobs and durable execution, the runtime API, and the TypeScript SDK. |
| **Self-hosting** | `self-hosting/` | Running Receipt yourself: the constraints to read first, configuration, database and migrations, the integrations provider, and deploying. |
| **Working from source** | `repo/` | Running the Receipt monorepo locally, the fuller in-repo CLI, Factory, authoring agents, and testing and simulation. |

Two `receipt` command surfaces exist and the docs keep them apart on purpose: the **CLI** tab is the public
binary an end user installs, and **Working from source** covers the in-repo CLI that needs Bun and the monorepo.

Supporting files, none of which are published:

| Path | Purpose |
| --- | --- |
| `docs.json` | Site config: theme, colors, logo, navigation, navbar, footer, redirects. The single source of truth for what appears in the sidebar. |
| `scripts/check-docs.mjs` | Zero-dependency validation harness (see below). |
| `docs/` | The plan and design spec the site was built from. |
| `research/` | Source-of-truth research notes, written from the Receipt codebase, that the pages were drafted from. |
| `.mintignore` | Keeps `docs/`, `research/`, `scripts/`, `README.md`, and `*.draft.mdx` out of the build — not published, not indexed, not reachable by URL. |
| `logo/`, `favicon.svg` | Brand assets referenced from `docs.json`. |

## Running it locally

**Prerequisites:** Node.js 18 or newer (this project is developed on Node 24) and npm.

```bash
# 1. Install the Mintlify CLI, once, globally
npm i -g mint

# 2. From the repository root — the directory holding docs.json
mint dev
```

The preview is served at <http://localhost:3000> and hot-reloads as you edit. Pass `--port` if 3000 is taken:

```bash
mint dev --port 3333
```

Other useful commands:

```bash
mint update          # upgrade the CLI to the latest version
mint broken-links    # scan every page for internal links that do not resolve
```

> If `mint dev` renders a page differently from production, upgrade first — the CLI must be current to match the
> deployed renderer. The older `mintlify` npm package is superseded by `mint`; uninstall it with
> `npm uninstall -g mintlify` if it is still on your machine.

### Validate before you commit

```bash
node scripts/check-docs.mjs            # construction mode
node scripts/check-docs.mjs --complete # release mode: every nav entry must have a file
```

The harness needs no dependencies and enforces five things:

1. **Navigation** — no page is listed twice in `docs.json`.
2. **No orphans** — every content file is referenced in the navigation, and (with `--complete`) every navigation
   entry has a file behind it.
3. **Frontmatter** — every page has a frontmatter block with a non-empty `title`.
4. **Internal links** — every `/absolute` link resolves to a real page or a declared redirect.
5. **Publication safety** — no cloud account numbers, IAM ARNs, instance ids, public IP addresses, personal home
   directory paths, private hostnames, internal deploy resource names, or named individuals. This site is public;
   this check is what keeps internal identifiers off it.

A green run prints `OK  48 pages, 48 navigation entries, complete`.

### Adding a page

1. Create the `.mdx` file in the right tab's directory, with frontmatter:

   ```mdx
   ---
   title: "Your page title"
   description: "One sentence describing the page."
   ---
   ```

2. Add its slug — the path without the extension, e.g. `guides/your-page` — to the correct group in `docs.json`.
   A file that is not in the navigation fails the orphan check.
3. Run `node scripts/check-docs.mjs --complete` and `mint dev` to confirm it builds and reads correctly.

If you move or rename a page, add a `redirects` entry in `docs.json` from the old slug to the new one so existing
links keep working.

## Deploying changes

Deployment is Git-driven. Mintlify's GitHub App watches `kentronai/kentronai-docs` and rebuilds the site whenever
the production branch changes — there is no build step to run and no artifact to upload.

**The normal flow:**

```bash
git checkout -b docs/your-change
# edit pages, update docs.json if navigation changed
node scripts/check-docs.mjs --complete   # must pass
mint dev                                 # eyeball the pages you touched
git add -A
git commit -m "Describe the documentation change"
git push -u origin docs/your-change
```

Open a pull request against `main`. The Mintlify GitHub App comments on the PR with a **preview deployment** URL —
a unique, non-configurable URL for that branch — so reviewers see the rendered pages before anything ships. Merging
to `main` triggers the production deployment; it typically completes in a minute or two, after which the change is
live at `docs.kentron.ai`.

Pushing straight to `main` also deploys, and skips the preview. Use a branch for anything beyond a typo.

**Verifying and troubleshooting a deploy:**

- The **Mintlify dashboard** (`dashboard.mintlify.com`) shows deployment history, build logs, and the status of the
  GitHub connection. A failed build is reported there and in the PR check, not in this repository.
- A page you added that does not appear on the live site is almost always missing from `docs.json` navigation, or
  matched by a `.mintignore` pattern.
- Pull requests **from forks** do not get preview deployments — the GitHub App cannot read forks. Push the branch to
  this repository instead.
- The custom domain applies only to production. Preview URLs are always Mintlify-hosted.

**First-time or restored setup** (only if the repository is not already connected): in the Mintlify dashboard, install
the GitHub App on the `kentronai` organization, grant it access to `kentronai-docs`, set the production branch to
`main`, and enable preview deployments for pull requests. The custom domain is configured under the dashboard's
domain settings, which issue the TXT and CNAME records to add at the DNS provider.

## Conventions

- **Receipt-only scope.** The site documents Receipt on Kentron. Internal runbooks, account identifiers, and
  employee-specific flows do not belong here.
- **Code is the source of truth.** Do not document a command, flag, or limit that has not been verified against the
  Receipt codebase — prose in other repositories goes stale.
- **No orphans.** Every file is reachable from `docs.json`; drafts live in `*.draft.mdx`, which is ignored by the build.
