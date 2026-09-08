# Kentron docs

The source for the Kentron documentation site at **[docs.kentron.ai](https://docs.kentron.ai)**. It is a
[Mintlify](https://mintlify.com) site: every page is an MDX file in this repository, and the whole
navigation is declared in [`docs.json`](docs.json).

The site documents the Kentron platform in seven product sections, one per navigation tab. Each tab is a
directory and the file layout mirrors the URL: `mcp-gateway/quickstart.mdx` is served at `/mcp-gateway/quickstart`.

| Tab | Directory | What it covers |
| --- | --- | --- |
| **Receipt AI Co-Worker** | `introduction.mdx`, `co-worker/` | What Kentron is, then the chat product: first chat, background runs, replay, skills in chat, conversations, files, monitoring, Slack, Teams, how it works, objectives and tasks, errors and limits. |
| **MCP Gateway** | `mcp-gateway/` | Workspaces, connecting apps, Receipt Connect, connection scopes, tools and permissions, the aggregate MCP server, gateway activity, the security model, troubleshooting. |
| **LLM Gateway** | `llm-gateway/` | The Model Gateway: models and providers, bring your own key, model and compliance policy, usage and spend, configuration. |
| **Kentron Catalog** | `catalog/` | Agent Registry, the connector catalog, organization skills, writing a skill, Org Brain and Knowledge. |
| **Kentron Guard** | `guard/` | What is enforced and what is configurable only: guardrails, policies, access control, receipts as audit trail, data handling and security. |
| **Kentron Core** | `core/` | Accounts, organizations, members, billing; architecture, receipts, jobs, the Factory engine; runtime API, SDK, authoring agents; configuration; local development, self-hosting, database, integrations provider, deploying, health; getting help. |
| **Receipt CLI** | `cli/`, `cli/from-source/` | The released `receipt` binary (install, quickstart, sign-in, doctor, workspaces, connect, tools and MCP, Claude Code observation, command reference, environment, troubleshooting) and the in-repo developer CLI. |

Two `receipt` command surfaces exist and the docs keep them apart on purpose: the **Receipt CLI** tab documents
the public binary an end user installs, and its **Developer CLI (from source)** group covers the in-repo CLI that
needs Bun and the monorepo.

Supporting files, none of which are published:

| Path | Purpose |
| --- | --- |
| `docs.json` | Site config: theme, colors, logo, navigation, navbar, footer, redirects. The single source of truth for what appears in the sidebar. |
| `images/<section>/` | Product screenshots referenced from pages. Captured from the live application and sanitized before capture; no real names, emails, IPs, account or instance ids. |
| `scripts/check-docs.mjs` | Zero-dependency validation harness (see below). |
| `docs/` | The design specs and implementation plans the site was built from. |
| `research/` | Source-of-truth research notes written from the Receipt codebase (`research/2026-09-08/` is the corpus behind the seven-section site, with per-report fact-check files). |
| `.mintignore` | Keeps `docs/`, `research/`, `scripts/`, `README.md`, and `*.draft.mdx` out of the build. |
| `logo/`, `favicon.svg` | Brand assets referenced from `docs.json`. |

## Running it locally

**Prerequisites:** Node.js 18 or newer and npm.

```bash
# 1. Install the Mintlify CLI, once, globally
npm i -g mint

# 2. From the repository root, the directory holding docs.json
mint dev
```

The preview is served at <http://localhost:3000> and hot-reloads as you edit. Pass `--port` if 3000 is taken.

Other useful commands:

```bash
mint update          # upgrade the CLI to the latest version
mint broken-links    # scan every page for internal links that do not resolve
```

### Validate before you commit

```bash
node scripts/check-docs.mjs            # construction mode
node scripts/check-docs.mjs --complete # release mode: every nav entry must have a file
```

The harness needs no dependencies and enforces seven things:

1. **Navigation**: no page is listed twice in `docs.json`.
2. **No orphans**: every content file is referenced in the navigation, and (with `--complete`) every navigation
   entry has a file behind it.
3. **Frontmatter**: every page has a frontmatter block with a non-empty `title`.
4. **Internal links**: every `/absolute` link resolves to a real page or a declared redirect.
5. **Images**: every `/images/...` reference resolves to a file on disk.
6. **Publication safety in text**: no cloud account numbers, IAM ARNs, instance ids, public IP addresses, personal
   home directory paths, private hostnames, internal deploy resource names, the legacy marketing domain in either
   spelling, or named individuals. This site is public; this check is what keeps internal identifiers off it.
7. **Publication safety in screenshots**: every file under `images/` is listed in `images/REVIEWED.txt`. The text
   rules cannot see inside a PNG, and screenshots are captured from a live signed-in session, so a new image fails
   the build until a person has opened it and signed it off.

A green run prints `OK  81 pages, 81 navigation entries, complete`.

### Adding a page

1. Create the `.mdx` file in the right tab's directory, with frontmatter:

   ```mdx
   ---
   title: "Your page title"
   description: "One sentence describing the page."
   ---
   ```

2. Add its slug, the path without the extension, to the correct group in `docs.json`.
   A file that is not in the navigation fails the orphan check.
3. End the page with a `Next step:` link to the page that follows it in the navigation.
4. Run `node scripts/check-docs.mjs --complete` and `mint dev` to confirm it builds and reads correctly.

If you move or rename a page, add a `redirects` entry in `docs.json` from the old slug to the new one so existing
links keep working.

### Adding a screenshot

Put the PNG under `images/<section>/`, then embed it:

```mdx
<Frame caption="What the reader is looking at and what to notice.">
  <img src="/images/<section>/<name>.png" alt="A sentence describing the screen." />
</Frame>
```

Screenshots must not show real names, email addresses, IP addresses, cloud account or instance identifiers, or
internal resource names. Replace them in the page before you capture, rather than editing the PNG afterwards.

Then open the image, confirm it is clean, and add its path to `images/REVIEWED.txt`. The validator fails until you
do, because that list is the only place a human confirms what a screenshot actually shows.

## Deploying changes

Deployment is Git-driven. Mintlify's GitHub App watches the repository and rebuilds the site whenever the
production branch changes.

```bash
git checkout -b docs/your-change
# edit pages, update docs.json if navigation changed
node scripts/check-docs.mjs --complete   # must pass
mint dev                                 # eyeball the pages you touched
git add -A
git commit -m "Describe the documentation change"
git push -u origin docs/your-change
```

Open a pull request against `main`. The Mintlify GitHub App comments on the PR with a preview deployment URL so
reviewers see the rendered pages before anything ships. Merging to `main` triggers the production deployment.

- The **Mintlify dashboard** (`dashboard.mintlify.com`) shows deployment history, build logs, and the status of the
  GitHub connection.
- A page you added that does not appear on the live site is almost always missing from `docs.json` navigation, or
  matched by a `.mintignore` pattern.
- Pull requests from forks do not get preview deployments. Push the branch to this repository instead.

## Conventions

- **Code is the source of truth.** Do not document a command, flag, limit, or behaviour that has not been verified
  against the Receipt codebase; the research notes under `research/` record where each claim comes from.
- **Say what runs.** A feature that exists in the interface but is not enforced or not executable gets a status
  callout at the top of its page; it is never described as working.
- **No orphans.** Every file is reachable from `docs.json`; drafts live in `*.draft.mdx`, which is ignored by the build.
