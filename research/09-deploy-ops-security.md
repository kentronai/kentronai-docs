# Receipt — Deployment, Self-Hosting, Production Architecture, Operations, Security, Upgrades

Research report for the public Receipt documentation site.
Repo root: `<receipt-repo>` (Bun + Turborepo monorepo).
Every substantive claim below is cited `file:line`. Code is the source of truth; where repo
markdown disagrees with code, that is called out in **§9 Docs vs code**.

Anything Kentron-internal (account ids, named personal accounts, internal AWS profile names,
cutover checklists, employee-specific prod-debug flows) is quarantined in **§10 Internal only —
do not publish**.

---

## 1. Scope and primary sources

| Area | Authoritative files |
| --- | --- |
| AWS resource graph | `sst.config.ts` (1491 lines), `deploy/sst/config.ts`, `deploy/sst/service.ts`, `deploy/sst/single-host.ts` |
| Deploy driver + guards | `scripts/deploy-aws.mjs` (2554 lines), `scripts/preflight.mjs`, `scripts/require-local-factory-validation.mjs` |
| CodeBuild path | `deploy/codebuild/<deploy-project>.buildspec.yml`, `scripts/ensure-<deploy-project>-codebuild.mjs`, `scripts/start-<deploy-project>.mjs`, `scripts/build-beetle-images.mjs`, `scripts/beetle-release-manifest.mjs`, `scripts/beetle-image-services.mjs`, `scripts/resolve-opensandbox-worker-image.mjs`, `.github/workflows/deploy-factory.yml`, `.github/workflows/ci.yml` |
| Single-host ("Receipt Lite") path | `deploy/sst/single-host.ts`, `scripts/single-host-rollout.mjs`, `scripts/single-host-domain.mjs`, `scripts/factory-lite-power.mjs` |
| Images | `deploy/Dockerfile.receipt`, `.receipt-web`, `.receipt-slack`, `.receipt-teams`, `.nango`, `.opensandbox-worker`, `.receipt-zero-cache`, `.runtime-hotfix`, `deploy/receipt-entrypoint.sh`, `deploy/receipt-resonate-entrypoint.sh`, `deploy/zero-cache-entrypoint.sh` |
| Secrets | `deploy/aws-sst.env.example`, `deploy/factory.secrets.env.example`, `deploy/production.secrets.env.example`, `scripts/create-factory-secrets-file.mjs`, `scripts/load-factory-secrets.mjs` |
| Security | `SECURITY.md`, `scripts/apply-factory-security-baseline.mjs`, `packages/receipt-app/src/services/byok-crypto.ts`, `packages/receipt-app/src/services/receipt-connect-connections.ts`, `packages/receipt-app/src/services/receipt-connect-config.ts`, `apps/start/src/lib/backend/auth/services/auth.service.ts`, `apps/start/src/lib/backend/auth/services/auth-trusted-origins.ts`, `apps/start/scripts/zero-publication.ts` |
| Gates | `scripts/prod-readiness-gate.mjs`, `scripts/prod-aws-preflight.mjs`, `scripts/prod-domain-preflight.mjs`, `docs/prod-readiness-metrics.md` |
| Migrations | `apps/start/scripts/zero-migrate.ts`, `apps/start/scripts/zero-publication.ts`, `apps/start/zero/migrations/*` |
| Repo docs | `README.md`, `docs/deploy/aws-sst-onboarding.md`, `docs/deploy/neon-to-aws-zero-migration.md`, `docs/deploy/aws-coder-two-developer-runbook.md`, `docs/deploy/app-kentron-ai-cutover-todo.md`, `LOCAL_SETUP.md`, `docs/agent-fix-checklist.md`, `docs/receipt-connect-nango.md` |

Script→npm-script mapping is `package.json:11-99`; every command name used below resolves there.

---

## 2. Production architecture on AWS

### 2.1 SST app, stages, and protection

- SST app name is `receipt-factory` (`sst.config.ts:28`), home provider `aws` (`sst.config.ts:31`),
  region from `AWS_REGION`, default `us-east-1` (`sst.config.ts:34`, `deploy/sst/config.ts` consumers).
- Default stage when none is given is `factory` (`sst.config.ts:9`).
- Protected stages are `factory` and `production` (`sst.config.ts:23`). For those stages SST sets
  `removal: "retain"` and `protect: true` (`sst.config.ts:29-30`), so `sst remove` cannot destroy
  them. Escape hatch: `RECEIPT_ALLOW_PRODUCTION_REMOVE=1` on the `production` stage only
  (`sst.config.ts:24-25`).
- Local AWS profile routing is stage-scoped: `RECEIPT_AWS_PRODUCTION_PROFILE` for `production`,
  `RECEIPT_AWS_FACTORY_PROFILE` otherwise (`sst.config.ts:13-17`). If the deploy wrapper already
  exported temporary credentials from that profile it sets
  `RECEIPT_AWS_<STAGE>_PROFILE_EXPORTED_CREDENTIALS=1` and SST then omits `profile`
  (`sst.config.ts:21-22,35`), because the Pulumi AWS provider cannot parse AWS CLI v2
  login-session profiles.

**Stages that exist in code**

| Stage | Shape | Entry |
| --- | --- | --- |
| `factory` | Full multi-service ECS/Fargate stack | `sst.config.ts:425` onward |
| `production` | Same graph, protected, stricter guards | same |
| `factory-lite`, `single-host`, or any stage with `RECEIPT_AWS_SINGLE_HOST=1` | One EC2 host running Docker Compose | `deploy/sst/single-host.ts:7-8`, dispatched at `sst.config.ts:361-423` |

`scripts/deploy-aws.mjs` only accepts `factory` and `production` (`scripts/deploy-aws.mjs:12-22,406-415`).
The single-host stages must therefore be provisioned with SST directly (`sst deploy --stage factory-lite`)
— the repo's wrapper refuses that stage name. See **§9**.

### 2.2 Shared resources (created for every stage, before the stage split)

| SST logical name | Type | Notes |
| --- | --- | --- |
| `Network` | `sst.aws.Vpc` | `sst.config.ts:84` |
| `ZeroBackups` | `sst.aws.Bucket` | Litestream destination for the Zero replica (`sst.config.ts:86`) |
| `AppFiles` | `sst.aws.Bucket` | Versioned, CORS off, lifecycle expires `tmp/` after 30 days (`sst.config.ts:87-97`) |
| `Database` | `sst.aws.Postgres` | db `receipt`, user `receipt`, Postgres **17**; instance from `RECEIPT_DATABASE_INSTANCE` (default `t4g.large`), storage from `RECEIPT_DATABASE_STORAGE` (default `100 GB`) (`sst.config.ts:98-104`, `deploy/sst/config.ts:66-68`) |
| Parameter group transform | — | Forces `rds.logical_replication = 1` with `applyMethod: "pending-reboot"` (`sst.config.ts:105-124`). This is what makes Zero's logical replication possible; the first deploy or a parameter change may need a DB reboot. |
| ECR lifecycle on `sst-asset` | `aws.ecr.LifecyclePolicy` | Expires untagged layers after 7 days; keeps only the newest 8 tagged images for prefixes `Gateway, Runtime, RuntimeDriver, RuntimeWorker, Resonate, Slack, Teams, Integrations` (`sst.config.ts:1159-1193`, repo name `sst-asset` at `deploy/sst/config.ts:17`) |
| `AuthEmail` | `sst.aws.Email` | Created only when `AUTH_EMAIL_PROVIDER=ses` and a sender is configured (`sst.config.ts:239-248`) |

Database URL is composed as
`postgresql://<user>:<password>@<host>:<port>/<db>` (`sst.config.ts:147`) and every service gets
`ZERO_UPSTREAM_DB`, `DATABASE_URL`, and `RECEIPT_POSTGRES_SCHEMA=public` (`sst.config.ts:148-154`).

### 2.3 Full-stack (`factory` / `production`) resources

Created after the single-host early return (`sst.config.ts:425` onward):

| Resource | Type | Key facts |
| --- | --- | --- |
| `Cluster` | `sst.aws.Cluster` | ECS cluster in the VPC (`sst.config.ts:425`). Postdeploy validation finds it by ARN substring `receipt-factory-<stage>-ClusterCluster` (`scripts/deploy-aws.mjs:2447-2465`) |
| `Redis` | `sst.aws.Redis` | Instance from `RECEIPT_REDIS_INSTANCE`, default `t4g.small` (`sst.config.ts:426-429`, `deploy/sst/config.ts:69`). URL is built as `rediss://<user>:<pass>@host:port` — TLS (`sst.config.ts:434`) |
| `ReceiptData` | `sst.aws.Efs` | Shared runtime volume, `throughput: "bursting"`, lifecycle `transitionToIa: AFTER_30_DAYS` (`sst.config.ts:435-452`). Mounted at `/app/.receipt/data` by Resonate, Runtime and every runtime role service |
| `ZeroData` | `sst.aws.Efs` | Durable Zero replica volume, mounted at `/app/.zero` on the replication manager only (`sst.config.ts:453,543`) |
| `GatewayCdn` | `sst.aws.Cdn` (CloudFront) | Created unless `RECEIPT_AWS_ENABLE_CLOUDFRONT=0` (`deploy/sst/config.ts:58`, `sst.config.ts:965-1001`). Origin is the Gateway ALB, `http-only` to origin, `redirect-to-https` for viewers, TTLs all 0, forwards all headers/cookies/query. Comment string: `"Bootstrap HTTPS edge for the Receipt Factory gateway"` |

**Services** (all created through `createReceiptService(...)`, a thin wrapper over
`sst.aws.Service` — `deploy/sst/service.ts:6-10`; the wrapper exists so service defaults can be
centralized later, per `deploy/sst/README.md:10-12`):

| Logical name | Image | CPU / Mem | Scaling | Port / registry | Volumes | Role |
| --- | --- | --- | --- | --- | --- | --- |
| `Gateway` | `deploy/Dockerfile.receipt-web` | 1 vCPU / 2 GB | `RECEIPT_GATEWAY_{MIN,MAX}_TASKS`, default 1–2 | ALB `:3000`, internal web on `3001` | — | Public edge: TanStack Start app + reverse proxy for `/runtime`, `/zero`, `/integrations`, `/slack`, `/teams`, `/connect` (`sst.config.ts:890-962`) |
| `Runtime` | `deploy/Dockerfile.receipt` | 1 vCPU / **4 GB** | `RECEIPT_RUNTIME_{MIN,MAX}_TASKS`, default 1–2 | service discovery `:8787` | EFS `ReceiptData` | `RECEIPT_PROCESS_ROLE=api` only; HTTP/API role (`sst.config.ts:728-764`) |
| `RuntimeDriver` | same | 1 vCPU / 2 GB | `RECEIPT_RUNTIME_DRIVER_*`, default 1–1 | — | EFS | `RECEIPT_PROCESS_ROLE=driver` (`sst.config.ts:810-816`) |
| `RuntimeWorkerControl` | same | 1 vCPU / **8 GB** | `RECEIPT_RUNTIME_WORKER_CONTROL_*`, default 1–1 | — | EFS | `worker-control`; holds `ec2:StartInstances/StopInstances/Describe*` so it can wake the OpenSandbox host (`sst.config.ts:817-828`) |
| `RuntimeWorkerChat` | same | 1 vCPU / 2 GB | `RECEIPT_RUNTIME_WORKER_CHAT_*`, default 1–1 | — | EFS | `worker-chat` (`sst.config.ts:829-833`) |
| `RuntimeWorkerCodex` | same | 2 vCPU / **16 GB** | `RECEIPT_RUNTIME_WORKER_CODEX_*`, default 1–1 | — | EFS | `worker-codex`; also holds the EC2 start/stop permissions (`sst.config.ts:834-843`) |
| `Resonate` | `deploy/Dockerfile.receipt` with `command: ["/usr/local/bin/receipt-resonate-entrypoint.sh"]` | 0.5 vCPU / 1 GB | fixed `{min:1,max:1}` (singleton for workflow ordering) | `:8001` | EFS `ReceiptData` | Durable-execution server, Postgres schema `resonate_v09` (`sst.config.ts:484-506`) |
| `Integrations` | `deploy/Dockerfile.nango` | 0.5 vCPU / 1 GB | `RECEIPT_INTEGRATIONS_*`, default 1–2 | `:3003` (API) and `:3009` (Connect UI) | — | Self-hosted Nango (`sst.config.ts:508-533`) |
| `ZeroReplicationManager` | `rocicorp/zero:1.5.0` (override `ZERO_IMAGE`) | 2 vCPU / 4 GB | default | internal ALB `80 → 4849` | EFS `ZeroData` | Owns the durable SQLite replica + Litestream backup writer; `ZERO_NUM_SYNC_WORKERS=0` (`sst.config.ts:535-581`) |
| `ZeroViewSyncer` | same image | 2 vCPU / 4 GB | `RECEIPT_ZERO_VIEW_SYNCER_*`, default 1–2 | internal ALB `80 → 4848`, LB cookie stickiness 120 s | replica in `/tmp` | Serving replica; `ZERO_NUM_SYNC_WORKERS=1`, restores from the replication manager (`sst.config.ts:584-639`) |
| `Slack` | `deploy/Dockerfile.receipt-slack` | 0.25 vCPU / 0.5 GB | default | `:3000` | — | Slack app (`sst.config.ts:845-867`) |
| `Teams` | `deploy/Dockerfile.receipt-teams` | 0.25 vCPU / 0.5 GB | default | `:3000` | — | Microsoft Teams app (`sst.config.ts:869-888`) |

Scaling defaults come from `serviceScaling(name, fallbackMin, fallbackMax)`
(`deploy/sst/config.ts:85-95`): env `"<NAME>_MIN_TASKS"` / `"<NAME>_MAX_TASKS"`, plus fixed
`cpuUtilization: 60` and `memoryUtilization: 70` autoscaling targets.

Deployment policy for `Gateway`, `Runtime` and every runtime role service is
`deploymentMaximumPercent = 200`, `deploymentMinimumHealthyPercent = 0`
(`sst.config.ts:755-763,798-807,954-961`) so ECS may stop the old task before starting the new one —
deliberately chosen to fit inside a small Fargate vCPU quota.

### 2.4 Load balancer, domain and health

- With `RECEIPT_PUBLIC_DOMAIN` set, the Gateway ALB gets rules
  `80/http → redirect 443/https` and `443/https → forward 3000/http`, health check path `/health`
  (`sst.config.ts:454-472`).
- Without a domain: single rule `80/http → 3000/http`, same health path (`sst.config.ts:473-482`).
- If DNS is **not** in Route 53, set `RECEIPT_PUBLIC_DOMAIN_CERT_ARN`; SST then uses
  `{name, dns:false, cert}` (`sst.config.ts:456-461`, `deploy/sst/config.ts:57`).

Health endpoints in code:

| Service | Path | Source |
| --- | --- | --- |
| Web/Gateway | `GET/HEAD /health` → `{"ok":true}` | `apps/start/src/routes/health/route.tsx:6-19` |
| Runtime | `GET /healthz` (always 200, liveness) | `packages/receipt-app/src/server/bootstrap.ts:2718-2734` |
| Runtime | `GET /readyz` (200 or **503**) | `packages/receipt-app/src/server/bootstrap.ts:2736-2746` |
| Zero replication manager | `/keepalive` on 4849 | `sst.config.ts:554-579` |
| Zero view syncer | `/keepalive` on 4848 | `sst.config.ts:606-636` |
| Nango | `/integrations/health` through the gateway | `packages/receipt-core/src/service-graph.ts:116-127`; `docs/agent-fix-checklist.md:64-67` warns `/integrations-connect/` only proves the static UI |
| OpenSandbox controller | `/health` on 8080 | `deploy/sst/config.ts:12-14` |

ECS container health checks additionally curl `localhost:4849/keepalive` and `localhost:4848/keepalive`
with a 300-second start period and a 600-second `healthCheckGracePeriodSeconds`
(`sst.config.ts:554-579,606-636`).

### 2.5 The service graph (how services address each other)

`packages/receipt-core/src/service-graph.ts:78-192` is the single definition of route prefixes,
internal ports, exposure and health paths. It is the reason local and AWS behave identically.

| Service | Prefix | Default internal URL | Exposure | Health | Strips prefix |
| --- | --- | --- | --- | --- | --- |
| `web` | `/` | `http://127.0.0.1:3001` | public | `/health` | — |
| `runtime` | `/runtime` | `http://127.0.0.1:8787` | **private** | `/healthz` | yes |
| `connect` | `/connect` | runtime | public | `/readyz` | no |
| `zero` | `/zero` | `http://127.0.0.1:4848` | public | `/` | yes |
| `integrations` | `/integrations` | `http://127.0.0.1:3003` | public | `/health` | yes |
| `integrations-connect` | `/integrations-connect` | `http://127.0.0.1:3009` | public | `/` | yes |
| `slack` | `/slack` | `http://127.0.0.1:3010` | public | `/health` | yes |
| `teams` | `/teams` | `http://127.0.0.1:3011` | public | `/health` | yes |
| `resonate` | `/resonate` | `http://127.0.0.1:8001` | **private** | `/health` | yes |
| `computer` | `/computer` | `http://127.0.0.1:8080` | **private** | `/health` | yes |

Longest-prefix match wins (`service-graph.ts:194-212`). `private` services return **404 "Not found"**
to public requests unless the request host is loopback, or
`RECEIPT_SERVICE_GATEWAY_EXPOSURE=private`, or `RECEIPT_SERVICE_GATEWAY_ALLOW_PRIVATE=1`
(`apps/start/scripts/service-gateway.ts:208-222,1029-1041`). In AWS the Gateway runs with
`RECEIPT_SERVICE_GATEWAY_EXPOSURE=public` (`sst.config.ts:917`), so `/runtime`, `/resonate` and
`/computer` are not reachable from the internet.

The gateway also carves out shared-host root paths that must go to Nango rather than the app shell:
`/connect/session`, `/connect/telemetry`, `/integrations` (exact), and subtrees `/api-auth`,
`/auth/unauthenticated`, `/app-store-auth`, `/oauth`, `/oauth2`, `/providers`
(`apps/start/scripts/service-gateway.ts:51-64`), while `/auth`, `/auth/sign-in`, `/auth/sign-up`,
`/auth/accept-invitation` stay with the Receipt web app (`service-gateway.ts:40-49`). It rewrites
Nango Connect's root-relative `/assets/...` references under `/integrations-connect/assets`
(`service-gateway.ts:785-808`, asserted by the deploy smoke at `scripts/deploy-aws.mjs:2009-2015`).

### 2.6 OpenSandbox host (the "computer" execution backend)

Enabled by default; `RECEIPT_AWS_ENABLE_OPENSANDBOX=0` disables it (`deploy/sst/config.ts:59`).
`createOpenSandboxDockerHost(...)` (`sst.config.ts:1195-1491`) creates:

- SSM SecureString parameter `/receipt-factory/<stage>/opensandbox/api-key` (`sst.config.ts:1211-1215`).
- AMI lookup `al2023-ami-2023.*-x86_64`, x86_64, hvm (`deploy/sst/config.ts:10`, `sst.config.ts:1216-1233`).
- Security group allowing **all TCP ports** *only* from the ECS services' security group; egress open
  (`sst.config.ts:1235-1256`, ports from `deploy/sst/config.ts:9`).
- Instance role with `AmazonEC2ContainerRegistryReadOnly` + `AmazonSSMManagedInstanceCore` and a
  scoped `ssm:GetParameter` policy for just its API-key parameter (`sst.config.ts:1257-1284`).
- EC2 instance in a **public** subnet with a public IP, IMDSv2 required (`httpTokens: "required"`),
  gp3 root volume sized by `RECEIPT_OPENSANDBOX_ROOT_VOLUME_GB` (default 60), tags
  `Name=receipt-factory-opensandbox`, `Service=OpenSandbox`, `Stage=<stage>`
  (`sst.config.ts:1453-1483`). `userDataReplaceOnChange: false` is deliberate: the worker image ref
  is embedded in user data, and replacing the host on every deploy previously killed in-flight
  computer tasks with `OpenSandbox command unavailable: Unable to connect` (`sst.config.ts:1461-1468`).
- User data bootstrap installs docker/git/awscli/`amazon-ecr-credential-helper`, `uv`, then
  `uv tool install --force opensandbox-server==0.2.2`; pulls the worker image plus
  `opensandbox/execd:v1.0.16` and `opensandbox/egress:v1.0.12`; writes
  `/etc/opensandbox/sandbox.toml` and a `receipt-opensandbox-disk-guard` script; installs and starts
  `opensandbox.service`; then polls `http://127.0.0.1:8080/health` up to 120×2 s
  (`sst.config.ts:1288-1450`).
- Sandbox hardening in `sandbox.toml`: docker runtime, bridge networking,
  `drop_capabilities = ["AUDIT_WRITE","MKNOD","NET_ADMIN","NET_RAW","SYS_ADMIN","SYS_MODULE","SYS_PTRACE","SYS_TIME","SYS_TTY_CONFIG"]`,
  `no_new_privileges = true`, `pids_limit = 4096`, `allowed_host_paths = []`, sqlite store,
  DNS-mode egress proxy (`sst.config.ts:1373-1414`).
- Instance sizing default is `t3a.xlarge` in code (`deploy/sst/config.ts:60-61`) — see **§9** for the
  conflicting documented value.
- Lease caps: `OPEN_SANDBOX_GLOBAL_MAX_ACTIVE` (code default **3**) and
  `OPEN_SANDBOX_ORG_MAX_ACTIVE` (default 1, clamped to ≤ global) (`deploy/sst/config.ts:77-83`).
  Extra lease requests queue.
- Idle stop: `OPEN_SANDBOX_HOST_IDLE_STOP_MS` = 20 minutes, hard-coded (`deploy/sst/config.ts:15`).
  `OPEN_SANDBOX_AUTO_START` / `AUTO_STOP` are `true` when enabled, and
  `OPEN_SANDBOX_CLEANUP_ON_FINISH="task"` (`sst.config.ts:690-693`).
- When OpenSandbox is disabled the internal URL is the dead address `http://127.0.0.1:9`
  (`deploy/sst/config.ts:7`), and runtime env flips to `RECEIPT_FACTORY_EXECUTION_PATH=local`
  (`sst.config.ts:678-680`).

### 2.7 SST stack outputs

Full stack (`sst.config.ts:1003-1023`): `stage`, `gateway`, `gatewayHttps`, `runtime`,
`zeroReplicationManager`, `zeroReplicationManagerService`, `zero`, `integrations`, `slack`, `teams`,
`resonate`, `computer`, `computerInstance`, `computerRegion`, `computerGlobalMaxActive`,
`computerOrgMaxActive`, `computerWorkerImage`, `appFiles`, `database`.

Single-host (`deploy/sst/single-host.ts:372-396`) returns the same key set plus
`singleHostInstance`, `singleHostPublicUrl`, `singleHostPublicIp`, `singleHostEipAllocationId`,
`singleHostEipAssociationId`, with service values as sentinel strings like `single-host:runtime-api`.

Outputs are read back from `.sst/outputs.json` during postdeploy validation
(`scripts/deploy-aws.mjs:2536-2549`).

### 2.8 The single-host "Receipt Lite" stack

`deploy/sst/single-host.ts` builds a completely different topology for `factory-lite` /
`single-host`:

- **Requires** `RECEIPT_FACTORY_LITE_EIP_ALLOCATION_ID`; it throws otherwise with
  `"RECEIPT_FACTORY_LITE_EIP_ALLOCATION_ID is required for the single-host stage so the web image has a stable public base URL."`
  (`single-host.ts:29-37`). The EIP is associated to the instance (`single-host.ts:367-370`).
- One EC2 instance, `RECEIPT_FACTORY_LITE_INSTANCE_TYPE` default `t3a.xlarge`
  (`single-host.ts:10-11`), root volume `RECEIPT_FACTORY_LITE_ROOT_VOLUME_GB` default 100, floor 40
  (`single-host.ts:13-17`), tags `Name=receipt-factory-lite-single-host`, `Service=SingleHost`,
  `Stage=<stage>` (`single-host.ts:360-364`), IMDSv2 required with `httpPutResponseHopLimit: 2`
  (`single-host.ts:355-359`), `userDataReplaceOnChange: true` (`single-host.ts:349`) — i.e. changing
  the compose/env template **replaces the host**.
- Public security group: 80 and 443 open to `0.0.0.0/0` (`single-host.ts:107-140`); the instance also
  joins the VPC service security group so it can reach RDS.
- The whole environment file is stored as one SSM **SecureString**, tier `Advanced`, at
  `/receipt-factory/<stage>/single-host/env` (`single-host.ts:160-169`); the instance role can read
  exactly that parameter, read/write the two buckets, start/stop EC2, and `ses:SendEmail`
  /`ses:SendRawEmail` against identities in its own account only (`single-host.ts:171-215`).
- Bootstrap installs docker, docker-compose v2.29.7, ECR credential helper; pulls the env file to
  `/opt/receipt/env/receipt.env` (mode 0600); writes `/opt/receipt/docker-compose.yml` and
  `/opt/receipt/Caddyfile`; installs systemd unit `receipt-single-host.service` (oneshot
  `docker-compose up -d`) and a `receipt-runtime-health-watchdog` timer that restarts `runtime-api`
  whenever its container health is `unhealthy` (every 30 s) (`single-host.ts:222-339`).
- **Migrations run at bootstrap**: `docker-compose run --rm gateway bun run --cwd apps/start zero:migrate`
  (`single-host.ts:324`), then services start, then it polls `http://127.0.0.1:3000/health` 120×5 s
  (`single-host.ts:329-338`).
- Compose services (`single-host.ts:492-673`): `redis` (`redis:7-alpine`), `resonate`, `runtime-api`
  (health `curl http://127.0.0.1:8787/healthz`), `runtime-driver`, `runtime-worker-control`,
  `runtime-worker-chat`, `runtime-worker-codex`, `integrations`, `slack`, `teams`,
  `zero-view-syncer` (single Zero process, replica `/app/.zero/single-host-v4.db`), `gateway`
  (published only on `127.0.0.1:3000`), and `edge` (`caddy:2-alpine`, ports 80/443, automatic TLS).
- Caddyfile is minimal: `"<publicHost> { reverse_proxy gateway:3000 }"` (`single-host.ts:24-27`).
- Differences from the full stack: **no ElastiCache** (containerized Redis), **no EFS** (host
  directories `/opt/receipt/data`, `/opt/receipt/zero`), **no ALB/CloudFront** (Caddy terminates
  TLS), **one Zero process** instead of the replication-manager/view-syncer split, and
  `RECEIPT_FACTORY_EXECUTION_PATH` is `computer` in both branches (`single-host.ts:455`).

### 2.9 The two deploy paths, and when each applies

**Path A — CodeBuild + SST (infrastructure path).**
GitHub Actions `Deploy Factory` runs after a green `CI` run on `main`
(`.github/workflows/deploy-factory.yml:3-11`), assumes an OIDC role
(`secrets.RECEIPT_AWS_FACTORY_DEPLOY_ROLE_ARN`), `git archive`s HEAD to
`s3://<deploy-project>-source-<account>-<region>/sources/<sha>.zip`, then runs
`scripts/start-<deploy-project>.mjs --wait` (`.github/workflows/deploy-factory.yml:81-106`). CodeBuild
(`aws/codebuild/standard:7.0`, `BUILD_GENERAL1_LARGE`, privileged, 120-minute timeout —
`scripts/ensure-<deploy-project>-codebuild.mjs:413-441`) downloads the archive, pulls the stage secret
file from Secrets Manager, builds and pushes images, then runs `bun run deploy:aws --stage <stage>`
(`deploy/codebuild/<deploy-project>.buildspec.yml:55-166`). Use this for infrastructure changes, new
services, protected-stage releases, and first-time provisioning.

**Path B — single-host in-place rollout (Receipt Lite).**
`bun run single-host:rollout` sends one SSM `AWS-RunShellScript` command to the tagged EC2 host that
backs up `docker-compose.yml` and `env/receipt.env`, pulls the requested immutable ECR image refs,
rewrites only those `image:` lines, re-runs `zero:migrate` if the gateway image changed, recreates
containers, and health-checks everything (`scripts/single-host-rollout.mjs:104-222`). Images must
already exist in ECR; the usual producer is
`<deploy-project>:start -- --stage factory --images-only --services <list> --wait`
(`scripts/start-<deploy-project>.mjs:33-45,103-111`). This path skips CodeBuild-driven SST, EC2
replacement, and full image rebuilds (`scripts/single-host-rollout.mjs:646-647`).

The repo's own guidance (`docs/deploy/aws-sst-onboarding.md:7-27`, `docs/agent-fix-checklist.md:519-531`)
is: **Path B is the default for routine application fixes on the live host; Path A is for
infrastructure or protected-stage work and should not be the default.** The README does not mention
Path B at all (see **§9**).

---

## 3. Self-hosting guide (generally applicable)

### 3.1 Prerequisites

From `README.md:90-94` and enforced by `scripts/preflight.mjs`:

- Node.js pinned by `.node-version` (currently **24**) — `scripts/preflight.mjs:13,68-80`.
- Bun pinned by `package.json` `packageManager` (**bun@1.3.12**) — `scripts/preflight.mjs:12,47-66`;
  `./bunw` installs the repo-pinned Bun locally.
- Docker daemon reachable — checked only in `--deploy` mode via
  `docker version --format {{.Server.Version}}` with hint
  `"Start Docker before deploying; SST builds service images during deploy."`
  (`scripts/preflight.mjs:19-24`).
- AWS CLI v2 — `aws --version`, hint
  `"Install AWS CLI v2 and configure the factory deploy role/profile."` (`scripts/preflight.mjs:25-28`).
- A domain you control (or an ACM certificate ARN) and AWS credentials for SST.

`bun run deploy:preflight` = `bun scripts/preflight.mjs --deploy --native` (`package.json:25`).
Success line: `"[preflight] Environment is ready."`; failure prints
`"[preflight] Environment is not ready:"` followed by bullet points (`scripts/preflight.mjs:34-40`).

### 3.2 Environment variables (deploy-time, by name)

Template: `deploy/aws-sst.env.example`. "Copy values into your shell profile, direnv file, or CI
environment. Do not put access keys or secret material in this file." (`aws-sst.env.example:1-2`).

| Variable | Meaning | Default / notes |
| --- | --- | --- |
| `RECEIPT_AWS_FACTORY_ACCOUNT_ID` / `RECEIPT_AWS_PRODUCTION_ACCOUNT_ID` | 12-digit account the stage may deploy into. **Required** — deploy refuses without it | `scripts/deploy-aws.mjs:433-460` |
| `RECEIPT_AWS_FACTORY_PROFILE` / `RECEIPT_AWS_PRODUCTION_PROFILE` | Optional local AWS CLI profile routing | `sst.config.ts:13-17`, `scripts/deploy-aws.mjs:315-337` |
| `AWS_REGION` | Deploy region | default `us-east-1` |
| `SST_STAGE` | Stage name | default `factory` |
| `BEETLE_DEPLOY_STAGE` | Stage for the CodeBuild/image scripts | default follows `SST_STAGE` |
| `BEETLE_DEPLOY_PROJECT_NAME` | CodeBuild project override | default `<deploy-project>`, or `<deploy-project>-production` (`ensure-<deploy-project>-codebuild.mjs:15-18`) |
| `BEETLE_DEPLOY_SOURCE_BUCKET` | Source archive bucket override | default `<deploy-project>-source-<account>-<region>` (`ensure-<deploy-project>-codebuild.mjs:27-31`) |
| `BEETLE_DEPLOY_STAGE_SECRETS_NAME` | Secrets Manager id holding the stage secret file | default `<deploy-secrets-prefix>/factory-secrets-env` / `<deploy-secrets-prefix>/<stage>-secrets-env` (`ensure-<deploy-project>-codebuild.mjs:39-43`) |
| `BEETLE_RELEASE_BUCKET` | Release-manifest bucket | default `<deploy-project>-releases-<account>-<region>` |
| `RECEIPT_PUBLIC_DOMAIN` | Public hostname; SST configures the ALB domain | required unless `RECEIPT_PUBLIC_BASE_URL` is set |
| `RECEIPT_PUBLIC_DOMAIN_CERT_ARN` | ACM cert when DNS is not in Route 53 (uses `dns:false`) | `sst.config.ts:456-461` |
| `RECEIPT_PUBLIC_BASE_URL` | Canonical public origin baked into auth, Zero, Nango, Slack, Connect | validated; localhost and `*.cloudfront.net` are rejected (`deploy/sst/config.ts:127-141`, `scripts/deploy-aws.mjs:474-512`) |
| `AUTH_EMAIL_PROVIDER` | `disabled` \| `ses` \| `resend` \| `smtp` | `scripts/deploy-aws.mjs:750-764` |
| `AUTH_EMAIL_FROM`, `AUTH_EMAIL_SST_SENDER`, `AUTH_EMAIL_SST_DNS`, `AUTH_EMAIL_DMARC`, `SES_REGION`, `SES_CONFIGURATION_SET`, `RESEND_FROM_EMAIL`, `SMTP_HOST/PORT/SECURE/USER/PASS/FROM_EMAIL` | Auth-email wiring | `sst.config.ts:225-275` |
| `VITE_DISABLE_EMAIL_VERIFICATION_OTP` | `true` bypasses signup email verification; **must be `false` in production** | `scripts/deploy-aws.mjs:661-674` |
| `RECEIPT_AWS_ENABLE_OPENSANDBOX` | `0` disables computer execution | default enabled |
| `RECEIPT_OPENSANDBOX_INSTANCE_TYPE` | Sandbox host size | code default `t3a.xlarge` |
| `RECEIPT_OPENSANDBOX_ROOT_VOLUME_GB` | Sandbox host root disk | default 60 |
| `RECEIPT_OPENSANDBOX_WORKER_IMAGE_FORCE_BUILD`, `..._CACHE_SALT`, `..._TAG`, `..._REF` | Worker image reuse / refresh controls | `deploy/sst/config.ts:70-75`, `scripts/resolve-opensandbox-worker-image.mjs:22-33,90-105` |
| `OPEN_SANDBOX_GLOBAL_MAX_ACTIVE`, `OPEN_SANDBOX_ORG_MAX_ACTIVE`, `OPEN_SANDBOX_HOST_READY_TIMEOUT_MS` | Lease caps and host-ready timeout (min 30000 enforced postdeploy) | `deploy/sst/config.ts:64-83`, `scripts/deploy-aws.mjs:1144-1160` |
| `RECEIPT_AWS_OPENSANDBOX_STOP_AFTER_DEPLOY` | `1` leaves the sandbox host stopped after validation | `scripts/deploy-aws.mjs:34,1600-1602` |
| `RECEIPT_AWS_ENABLE_CLOUDFRONT` | `0` skips the CloudFront edge | `deploy/sst/config.ts:58` — **not in the env template** |
| `RECEIPT_DATABASE_INSTANCE`, `RECEIPT_DATABASE_STORAGE`, `RECEIPT_REDIS_INSTANCE` | RDS/ElastiCache sizing | defaults `t4g.large`, `100 GB`, `t4g.small` — **not in the env template** |
| `RECEIPT_<SERVICE>_MIN_TASKS` / `_MAX_TASKS` | Per-service ECS scaling | `deploy/sst/config.ts:85-95` |
| `RECEIPT_AWS_SERVICE_IMAGE_CACHE` | `1` re-enables SST's ECR build cache | `deploy/sst/config.ts:52` |
| `RECEIPT_FACTORY_CLOUDTRAIL_NAME`, `RECEIPT_FACTORY_ACCESS_ANALYZER_NAME`, `RECEIPT_FACTORY_CLOUDTRAIL_BUCKET`, `RECEIPT_FACTORY_BUDGET_EMAIL`, `RECEIPT_FACTORY_BUDGET_USD`, `RECEIPT_FACTORY_BUDGET_NAME` | Security-baseline settings | `scripts/apply-factory-security-baseline.mjs:5-12,199-207` |
| Single-host only: `RECEIPT_FACTORY_LITE_EIP_ALLOCATION_ID` (required), `RECEIPT_FACTORY_LITE_INSTANCE_TYPE`, `RECEIPT_FACTORY_LITE_ROOT_VOLUME_GB`, `RECEIPT_AWS_SINGLE_HOST` | | `deploy/sst/single-host.ts:7-37` |

Break-glass / override variables (each prints a warning; document any use):
`RECEIPT_AWS_ACCOUNT_GUARD=0`, `RECEIPT_ALLOW_IAM_USER_FACTORY=1`,
`RECEIPT_ALLOW_IAM_USER_PRODUCTION=1`, `RECEIPT_ALLOW_INSECURE_FACTORY_URL=1`,
`RECEIPT_SKIP_LOCAL_VALIDATION_GUARD=1`, `RECEIPT_SKIP_PREDEPLOY_BUILD=1`,
`RECEIPT_SKIP_NANGO_PREFLIGHT=1`, `RECEIPT_SKIP_SES_PRODUCTION_GUARD=1`,
`RECEIPT_PREDEPLOY_SOURCE_ONLY=1`, `RECEIPT_ALLOW_UNPUSHED_DEPLOY=1`,
`RECEIPT_SKIP_PRODUCTION_AWS_PREFLIGHT=1`, `RECEIPT_ALLOW_PRODUCTION_REMOVE=1`,
`RECEIPT_ALLOW_FACTORY_SECRET_NAME_FOR_PRODUCTION=1`
(`scripts/deploy-aws.mjs:55,250,256,462-470,492-501,535,589,599-613,1230`;
`scripts/start-<deploy-project>.mjs:277-288,336-359`; `sst.config.ts:24-25`;
`scripts/ensure-<deploy-project>-codebuild.mjs:44-52`).

### 3.3 SST secrets (by name and meaning)

Generated by `bun run factory:secrets:create` → `deploy/factory.secrets.env`
(`scripts/create-factory-secrets-file.mjs:12,27-98`), file mode **0600**, gitignored, created with
`wx` semantics so a concurrent run cannot clobber it; `--force` regenerates.

Required for a deploy (`scripts/load-factory-secrets.mjs:15-28`):

| Secret | What it protects | Generated value |
| --- | --- | --- |
| `BetterAuthSecret` | Better Auth signing secret (`BETTER_AUTH_SECRET`) | 48 random bytes, base64url |
| `ByokEncryptionKeyB64` | AES-256-GCM wrapping key for organization provider API keys | 32 random bytes, base64 |
| `ReceiptConnectJwtSecret` | HS256 secret for Receipt Connect JWTs shared by web + runtime | 48 bytes base64url |
| `ReceiptConnectionEncryptionKeyB64` | AES-256-GCM key for Receipt Connect connection references | 32 bytes base64 |
| `ReceiptDebugToken` | Bearer token for hosted debug endpoints | 48 bytes base64url; auto-backfilled if empty (`load-factory-secrets.mjs:187-212`) |
| `ReceiptDebugJwtSecret` | Signing secret for debug JWTs | same |
| `IntegrationSecretKey` | Nango **prod environment `secret_key`** (UUID v4). Not generatable — see below | left blank by default |
| `IntegrationWebhookSecret` | HMAC secret for Nango → Receipt webhooks | 48 bytes base64url |
| `ZeroAdminPassword` | Zero admin/analyzer password | 32 bytes base64url |
| `NangoEncryptionKey` | Nango's own at-rest encryption key | 32 bytes base64 |
| `NangoDashboardPassword` | Basic-auth password for the Nango dashboard (user is `receipt`, `sst.config.ts:529`) | 24 bytes base64url |
| `OpenSandboxApiKey` | API key for the sandbox controller; stored in SSM SecureString | 32 bytes base64url |

Optional (`scripts/load-factory-secrets.mjs:30-65`): `SlackClientId`, `SlackClientSecret`,
`SlackSigningSecret`, `SlackBotToken`, `TeamsClientId`, `TeamsClientSecret`, `TeamsTenantId`,
`ResendApiKey`, and the per-connector Nango OAuth app pairs
(`NangoJira*`, `NangoConfluence*`, `NangoNotion*`, `NangoZoho*`, `NangoGithub*`, `NangoHubspot*`,
`NangoAttio*`, `NangoAirtable*`, `NangoGoogleAds*`, `NangoGoogleAnalytics*`, `NangoYoutube*`,
`NangoTiktokAds*`, `NangoInstagram*`, `NangoMetaMarketingApi*`, `NangoZendesk*`, `NangoSlack*`).
Missing optional values print
`"Optional secret values are empty: <names>. Related integrations may not work."`
(`load-factory-secrets.mjs:86-89`).

`bun run factory:secrets:load` validates before uploading (`load-factory-secrets.mjs:164-185`):

- `IntegrationSecretKey` must match UUID v4, else
  `"IntegrationSecretKey must be the Nango prod environment secret_key UUID v4; do not use the generated placeholder or public_key."`
- `ByokEncryptionKeyB64`, `ReceiptConnectionEncryptionKeyB64`, `NangoEncryptionKey` must each match
  `/^[A-Za-z0-9+/]{43}=$/` (exactly 32 decoded bytes), else `"<name> must be a base64-encoded 32 byte key."`

It then runs `bunx sst secret load deploy/<stage>.secrets.env --stage <stage>`
(`load-factory-secrets.mjs:93-100`), after an account guard identical to the deploy guard
(`load-factory-secrets.mjs:104-148`).

**The Nango chicken-and-egg.** `IntegrationSecretKey` is the Nango environment API key, but Nango only
creates real environment keys after its database exists. The documented sequence
(`docs/deploy/aws-sst-onboarding.md:363-381`) is: first deploy → open
`$RECEIPT_PUBLIC_BASE_URL/integrations` → Environment Settings → API Keys → copy the **`prod`**
environment key (UUID form, not `public_key`) → put it in `deploy/<stage>.secrets.env` →
`factory:secrets:load` → deploy again. Production has an explicit bootstrap mode:
`bun run production:secrets:create -- --bootstrap-nango` writes a UUID-shaped placeholder plus
`NangoBootstrapIntegrationSecretKey=1` (`scripts/create-factory-secrets-file.mjs:13-17,36-48`), and
`bun run <deploy-project>:start -- --stage production --bootstrap-nango --wait` is the only production
start that skips the full preflight (`scripts/start-<deploy-project>.mjs:26-32,75-77,345-360`).
`bun run production:nango:promote-secret` replaces the placeholder afterwards (`package.json:42`).

### 3.4 Command sequence (fresh AWS self-host)

From `README.md:79-88` plus the code:

```bash
export RECEIPT_AWS_FACTORY_ACCOUNT_ID=<12-digit account id>
export RECEIPT_PUBLIC_DOMAIN=factory.example.com
./bunw run factory:security:baseline
./bunw run factory:secrets:create
./bunw run factory:secrets:load
./bunw run deploy:aws
```

Then, once Nango is up: copy its `prod` environment key into `deploy/factory.secrets.env`, re-run
`factory:secrets:load`, and re-run `deploy:aws`.

For a **CodeBuild-based** setup, additionally:

```bash
bun run <deploy-project>:ensure          # creates/updates project, buckets, role, stage secret
bun run <deploy-project>:start -- --wait # uploads the current commit and waits for the build
```

`<deploy-project>:ensure` (`scripts/ensure-<deploy-project>-codebuild.mjs:70-83`) creates the source and
release buckets (AES256 SSE + full public-access block, `:85-125`), syncs `deploy/<stage>.secrets.env`
into Secrets Manager (`:127-205`), optionally stores Docker Hub credentials as
`<deploy-secrets-prefix>/dockerhub` (`:240-280`), creates the CodeBuild service role (`:282-358`), and
creates/updates the project (`:360-448`). Its success output is:

```
[<deploy-project>] <stage> CodeBuild project ready: <project>
[<deploy-project>] Source bucket ready: s3://<bucket>
[<deploy-project>] Release bucket ready: s3://<bucket>
[<deploy-project>] <stage> secrets ready: <secret name>
```

`--skip-secret-sync` (or `BEETLE_DEPLOY_SKIP_STAGE_SECRET_SYNC=1`) refreshes everything **except**
the remote secret; it fails if the remote secret does not already exist
(`ensure-<deploy-project>-codebuild.mjs:59-63,128-143`).

### 3.5 Deploy guards, in execution order

`scripts/deploy-aws.mjs` runs (`:49-89`):

1. **Local Factory validation guard** (deploy only, `:255-302`). Requires a recent
   `.deploy-artifacts/validate-stack/<run>/` directory containing
   `openai-byok-preflight.json`, `factory-create.json`, `factory-investigate.json`, and
   `factory-aws-positive-direct-investigate.json`, no older than 6 h by default
   (`scripts/require-local-factory-validation.mjs:10-35,69-80`), with `factory-create.json`'s base
   hash equal to current `HEAD` (`:46-56`). Failure message:
   `"Real local Factory/AWS validation has not passed; SST deploy was not started."`
   In CodeBuild the guard is satisfied by a commit-scoped handoff
   (`RECEIPT_LOCAL_VALIDATION_GUARD_PASSED=1` + `RECEIPT_LOCAL_VALIDATION_COMMIT`), which must match
   `GIT_SHA` (`deploy-aws.mjs:277-302`, set by `start-<deploy-project>.mjs:96-97`).
2. **AWS profile resolution** (`:315-395`). Refuses when `AWS_PROFILE` disagrees with the stage
   profile: `"Use one profile for SST, the account guard, and postdeploy AWS CLI validation."`
   Exports temporary credentials from AWS CLI v2 login-session profiles and clears `AWS_PROFILE`.
3. **Account guard** (`:433-472`, skip with `RECEIPT_AWS_ACCOUNT_GUARD=0`). Requires
   `sts get-caller-identity`; requires the stage account env var to be set; refuses on account
   mismatch; refuses when the principal ARN contains `:user/` unless
   `RECEIPT_ALLOW_IAM_USER_<STAGE>=1`. Success line: `[aws-guard] <stage> -> account <id> (<arn>)`.
4. **Public base URL guard** (`:474-512`). Requires https (except `factory` with
   `RECEIPT_ALLOW_INSECURE_FACTORY_URL=1`), rejects localhost, and rejects any
   `*.cloudfront.net` origin: `"AWS deploys cannot use a CloudFront origin."`
5. **Auth-email guard** (`:651-748`). Production **must** have
   `VITE_DISABLE_EMAIL_VERIFICATION_OTP=false` and `AUTH_EMAIL_PROVIDER=ses`; SES production access
   and a verified identity are checked with `sesv2 get-account` / `get-email-identity`
   (`:1229-1291`).
6. **Nango secret preflight** (`:514-565`). `IntegrationSecretKey` must be a UUID v4; then it lists
   `GET <public>/integrations/integrations` with that bearer token. A 404 or curl failure is a
   warning (so the deploy can create/repair the gateway); any other non-2xx fails.
   Skip with `RECEIPT_SKIP_NANGO_PREFLIGHT=1`.
7. **Predeploy build** (`:588-643`). Runs `deploy:preflight` then `deploy:verify`
   (`bun run check:full` = lint + SST config tests + typecheck + tests + build, `package.json:26,50-51`).
   `RECEIPT_PREDEPLOY_SOURCE_ONLY=1` downgrades to `deploy:verify:source` (`check:fast`) and is
   allowed only on `factory` and only when all six prebuilt image refs are present
   (`:598-631`).

Then `sst <command> --stage <stage>` runs, and on success the **postdeploy** phase (`:82-89`):

1. `runDeployedZeroMigrations` (`:91-214`) — starts a one-off Fargate task from the **Gateway** task
   definition overriding the command to `["bun","run","--cwd","apps/start","zero:migrate"]`, waits for
   it to stop, and fails on a non-zero exit. Logs
   `[aws-guard] running deployed Zero/Better Auth migration task` and
   `[aws-guard] deployed Zero/Better Auth migrations completed`.
2. `waitForDeployedServicesStable` (`:1375-1413`) — `aws ecs wait services-stable` for Gateway,
   Runtime, RuntimeDriver, RuntimeWorkerControl, RuntimeWorkerChat, RuntimeWorkerCodex, Resonate,
   Integrations, ZeroReplicationManager, ZeroViewSyncer.
3. `waitForOpenSandboxController` (`:1454-1603`) — starts the instance if stopped, waits for
   `instance-status-ok`, waits for SSM `Online`, sends two SSM commands (reconcile the durable
   controller binary + disk guard; then a health probe requiring
   `curl 127.0.0.1:8080/health`, `systemctl is-active opensandbox.service`, and the worker image
   present in `docker image ls`), warns about duplicate tagged instances, and finally stops the
   instance again when `RECEIPT_AWS_OPENSANDBOX_STOP_AFTER_DEPLOY != 0`.
4. `validateDeployedTaskEnvironment` (`:793-1172`) — describes each ECS service's task definition and
   asserts a long required-variable contract per service, that the required services have
   `desiredCount ≥ 1` and `runningCount ≥ 1`, that no `RECEIPT_CONNECT_NANGO_*` aliases are present
   ("deployed services must use `RECEIPT_INTEGRATIONS_*`"), that public URLs are https and not
   localhost, that `RECEIPT_*_CALLBACK_URL` ends in `/receipt/callback`, that each service has the
   right `RECEIPT_PROCESS_ROLE`, that `RESONATE_URL` uses port 8001 and `RESONATE_POLL_URL` is unset,
   and Zero/auth-email contracts (below). Success:
   `[aws-guard] postdeploy task env validated for <services>`.
5. `validateDeployedZeroHealth` (`:1415-1452`) — `VITE_ZERO_CACHE_URL` must equal
   `<public base>/zero`, and `GET <public>/zero/` must return 2xx.
6. `ensureReceiptConnectNangoIntegrations` (`:1813-2086`) — see **§6.3**.

### 3.6 Domain setup

- Route 53–hosted DNS: set `RECEIPT_PUBLIC_DOMAIN`; SST provisions the ALB domain and certificate.
- External DNS: create/validate an ACM cert first and set `RECEIPT_PUBLIC_DOMAIN_CERT_ARN`; SST uses
  `dns:false` (`sst.config.ts:456-461`, `docs/deploy/aws-sst-onboarding.md:307-312`).
- Always set `RECEIPT_PUBLIC_BASE_URL` to the final public origin before deploying so Better Auth,
  Nango Connect, Slack and Receipt Connect agree (`README.md:105`).
- Non-mutating verification: `bun run receipt:prod:domain-preflight` checks DNS A/AAAA/CNAME/NS,
  HTTPS `/health` with certificate validation, the served certificate's subject/SAN coverage, the
  active AWS identity, the public Route 53 hosted zone, and ACM coverage
  (`scripts/prod-domain-preflight.mjs:291-308`). `--require-aws-domain` makes missing Route 53/ACM
  coverage fatal.
- **Single-host hostname change without redeploying**: `bun run single-host:domain` supports three
  modes — `dual` (both hosts serve), `redirect-browser` (GET/HEAD on the legacy host permanently
  redirect while non-browser methods still proxy), and `canonical-only`
  (`scripts/single-host-domain.mjs:108-118`). It rewrites ~20 public-origin env keys
  (`BETTER_AUTH_URL`, `VITE_BETTER_AUTH_URL`, `VITE_ZERO_CACHE_URL`, `RECEIPT_PUBLIC_BASE_URL`,
  `RECEIPT_SERVICE_GATEWAY_URL`, `RECEIPT_CONNECT_*`, `RECEIPT_INTEGRATIONS_PUBLIC_URL`,
  `NANGO_SERVER_URL`, `NANGO_PUBLIC_SERVER_URL`, `NANGO_PUBLIC_CONNECT_URL`,
  `RECEIPT_NANGO_OAUTH_CALLBACK_URL`, `NANGO_OAUTH_CALLBACK_URL`, `S3_PUBLIC_BASE_URL`,
  `RECEIPT_WEB_URL`, `RECEIPT_LEGACY_PUBLIC_ORIGINS`) — `single-host-domain.mjs:120-146`. It is
  transactional: it takes SHA-256 fingerprints of the current and next env files and refuses if the
  live file drifted from the stored SSM baseline ("live env differs from the stored SSM baseline;
  refusing cutover"), backs up env/compose/Caddyfile to
  `/opt/receipt/backups/domain-cutover-<operation id>`, validates the new compose and Caddyfile
  (`docker-compose config -q`, `caddy validate`), installs them, recreates the ten affected services,
  health-checks, and installs `rollback` traps on ERR/INT/TERM (`single-host-domain.mjs:171-265`).
  If persisting the new env back to SSM fails after a successful host change, it automatically
  re-runs the restore commands (`single-host-domain.mjs:455-468`). `--dry-run` prints the exact SSM
  command list.

### 3.7 Rollback

| Situation | Mechanism |
| --- | --- |
| Full SST stack | `sst rollback` (`README.md:111-115`); the wrapper also accepts `rollback` as a command (`scripts/deploy-aws.mjs:24-31`), which keeps the account guard active |
| Image-level rollback | Every deploy image is tagged with the immutable git SHA and pushed alongside `:latest`; ECR lifecycle keeps recent tagged images (`scripts/build-beetle-images.mjs:111-118,272-309`). Re-deploy by passing the older `RECEIPT_*_IMAGE_REF` values, or re-promote an older release manifest |
| Single-host rollout | Every rollout first copies `docker-compose.yml` and `env/receipt.env` to `*.before-rollout-<UTC timestamp>` on the host (`scripts/single-host-rollout.mjs:113-114`); recover by restoring those files and `docker-compose up -d` |
| Single-host domain cutover | Automatic rollback trap plus `buildDomainRestoreCommands` re-installing the backup directory (`scripts/single-host-domain.mjs:233-265,356-372`) |
| Database | `docs/deploy/neon-to-aws-zero-migration.md:579-601`: rollback is easy only before the new database accepts writes; afterwards the operational default is fix-forward |

---

## 4. Docker images

| Dockerfile | Base | Builds | Entrypoint / CMD | Ports |
| --- | --- | --- | --- | --- |
| `deploy/Dockerfile.receipt` | `public.ecr.aws/docker/library/node:24-trixie-slim` | The Receipt runtime. Installs awscli, bash, **bubblewrap**, curl, dumb-init, git, gh, iproute2, jq, lsof, openssh-client, procps, psmisc, python3, ripgrep, sqlite3, tar, unzip; Bun 1.3.12; `@openai/codex@0.130.0`; Resonate `0.9.5` renamed to `resonate-server`; `bun install --frozen-lockfile` from manifests first, then full source; then `git init` + one commit so Factory worktrees work in a container with no remote | `ENTRYPOINT ["/usr/bin/dumb-init","--","/usr/local/bin/receipt-entrypoint.sh"]` | 8787 |
| `deploy/Dockerfile.receipt-web` | `node:24-bookworm-slim`, two stages | Vite/Nitro build of `apps/start` (`i18n:compile` then `vite build`, `NODE_OPTIONS=--max-old-space-size=12288`), then a production stage with `bun install --production` and only `.output` + needed scripts/sources; symlinks `apps/start/node_modules/@/*` so the migration task can run TS directly | `CMD ["bun","apps/start/scripts/service-gateway.ts"]` | 3000 |
| `deploy/Dockerfile.receipt-slack` | `node:24-bookworm-slim` | Workspace install + `apps/slack/*.ts` + `receipt-app`/`receipt-core` sources | `CMD ["bun","apps/slack/server.ts"]` | 3000 |
| `deploy/Dockerfile.receipt-teams` | `node:24-bookworm-slim` | Same shape for `apps/teams` | `CMD ["bun","apps/teams/server.ts"]` | 3000 |
| `deploy/Dockerfile.nango` | `nangohq/nango-server:hosted-0.69.48` | Patches Nango's Knex migration runners to pass `disableTransactions: true` (fail-closed: the build errors unless ≥12 call sites and 10 named runner files are patched), then applies five vendored patches: records-migration transaction fix, dynamic MCP OAuth registration, retired Zendesk API-token provider retention, Google Calendar MCP provider, and Azure DevOps switched from BASIC to Entra ID OAuth2 | inherits Nango's | 3003, 3009 |
| `deploy/Dockerfile.opensandbox-worker` | stage 1 `oven/bun:1.3.12`, stage 2 `debian:13` | Compiles a **standalone** `receipt` CLI with `bun build --compile` from an isolated file set (Receipt Connect worker CLI only — no onboarding, observers, DB adapters, or full runtime), then runs `scripts/factory-computer-guest-setup.sh` in phases `base, providers, node, bun, browser, codex, template`, installs the compiled CLI at `/usr/local/bin/receipt`, and **fails the build** unless `receipt --help`, `receipt connect/tools/mcp/workspace --help`, `aws`, `gcloud`, `bq`, `gsutil`, `az`, `kubectl` (v1.34.x) and `gh` all work | `WORKDIR /workspace`, `ENTRYPOINT ["tail","-f","/dev/null"]` (the controller execs into it) | — |
| `deploy/Dockerfile.receipt-zero-cache` | `node:24-bookworm-slim` | Installs deps, rebuilds `@rocicorp/zero-sqlite3` native bindings, copies `deploy/zero-cache-entrypoint.sh` | `ENTRYPOINT ["/usr/local/bin/zero-cache-entrypoint.sh"]` | 10000 |
| `deploy/Dockerfile.runtime-hotfix` | `ARG BASE_IMAGE` | Overlays 11 named runtime source files onto an existing runtime image — a break-glass hotfix image, not part of the normal pipeline | inherits | — |

**Entrypoints**

- `deploy/receipt-entrypoint.sh` — creates `DATA_DIR`/`HOME`, then: with no args `exec bun run receipt:start`;
  with exactly one arg containing shell metacharacters it runs `bash -lc "$1"` (schedulers that pass a
  command as one string), otherwise `exec "$@"` (`receipt-entrypoint.sh:1-16`).
- `deploy/receipt-resonate-entrypoint.sh` — resolves the Postgres URL from
  `RESONATE_POSTGRES_URL` → `DATABASE_URL` → `ZERO_UPSTREAM_DB`; creates schema
  `RESONATE_POSTGRES_SCHEMA` (default `resonate_v09`, name validated against
  `^[A-Za-z_][A-Za-z0-9_]*$`); best-effort creates `idx_promises_branch_id` on
  `<schema>.promises (branch, id)` (a documented prod incident had a sequential scan pin RDS CPU at
  99% at ~579k rows / 1.1 GB); rewrites the URL with `options=-csearch_path=<schema>`; then
  `exec resonate-server serve --server-bind 0.0.0.0 --server-port 8001 --observability-metrics-port 9090 --tasks-retry-timeout 500 --storage-type postgres --storage-postgres-url …`.
  Without a Postgres URL it **refuses to start in production**
  (`"Resonate production startup requires RESONATE_POSTGRES_URL, DATABASE_URL, or ZERO_UPSTREAM_DB."`)
  and otherwise falls back to SQLite (`receipt-resonate-entrypoint.sh:1-110`).
- `deploy/zero-cache-entrypoint.sh` — sets `ZERO_PORT` from `PORT`, defaults the replica file and
  `ZERO_LOG_FORMAT=json`, upgrades legacy `sslmode` values (`prefer`/`require`/`verify-ca`) to
  `verify-full` unless `uselibpqcompat=true`, pins `options=-c search_path=public`, derives
  `ZERO_QUERY_URL`/`ZERO_MUTATE_URL` from `RECEIPT_WEB_BASE_URL`, briefly binds the public port for
  `ZERO_PORT_GUARD_MS` (default 15000) so schedulers do not latch onto the internal change-streamer
  port, then `exec bunx zero-cache` (`zero-cache-entrypoint.sh:1-78`).

---

## 5. Image build, tagging, and release manifests

`scripts/build-beetle-images.mjs` builds five service images
(`runtime`, `gateway`, `slack`, `teams`, `integrations` — `:37-83`) into
`<account>.dkr.ecr.<region>.amazonaws.com/receipt-factory/<stage>/<service>` and tags each with the
sanitized git SHA plus `:latest` (plus an optional immutable release tag under
`receipt-factory/releases/<service>:<release tag>`) (`:111-118,143-178`). The `runtime` image uses
`docker buildx` with a registry cache (`:buildcache`), the rest use plain `docker build` with
`--cache-from <latest>` and `BUILDKIT_INLINE_CACHE=1` (`:125-176`). Repositories are created on
demand with `scanOnPush=true` and a lifecycle policy that expires untagged layers after 7 days and
keeps 10 `latest`-prefixed images (`:251-310`). Production builds additionally require
`VITE_DISABLE_EMAIL_VERIFICATION_OTP=false` and a non-CloudFront public base URL (`:184-224`).

`scripts/resolve-opensandbox-worker-image.mjs` gives the sandbox worker image a **content-addressed
tag**: `worker-<first 32 hex of sha256 over the worker input files (+ optional cache salt)>`
(`:90-105`). If that tag already exists in ECR it is reused; `RECEIPT_OPENSANDBOX_WORKER_IMAGE_FORCE_BUILD=1`
or a new `RECEIPT_OPENSANDBOX_WORKER_IMAGE_CACHE_SALT` forces a rebuild (`:22-33,55-70`).

`scripts/beetle-release-manifest.mjs` writes/validates a `beetle.release` schemaVersion 1 document
containing `releaseTag`, a full 40-char `gitSha`, `gitRef`, `builtStage`, `sourceArchiveS3Uri`,
`createdAt`, and the six image refs (`RECEIPT_RUNTIME_IMAGE_REF`, `RECEIPT_GATEWAY_IMAGE_REF`,
`RECEIPT_SLACK_IMAGE_REF`, `RECEIPT_TEAMS_IMAGE_REF`, `RECEIPT_INTEGRATIONS_IMAGE_REF`,
`RECEIPT_OPENSANDBOX_WORKER_IMAGE_REF`) (`:5-45`). Validation **rejects mutable refs**: any value
matching `:latest` or containing `sst-asset:` fails with
`"Release manifest <NAME> must be immutable, not <value>."` (`:64-70`). Applying a manifest emits
`BEETLE_PROMOTE_RELEASE=1`, `BEETLE_RELEASE_TAG`, `BEETLE_DEPLOY_BUILD_IMAGES=0`,
`RECEIPT_SKIP_PREDEPLOY_BUILD=1`, and the six pinned refs (`:74-85`).

Production deploys **must** promote a manifest rather than rebuild:
`start-<deploy-project>.mjs:72-80` fails with
`"Production deploys must promote an immutable release. Pass --release-tag <tag> or --release-manifest-s3-uri <s3-uri>."`,
and the buildspec repeats the check (`<deploy-project>.buildspec.yml:99-103`).

Other launcher guards in `scripts/start-<deploy-project>.mjs`:

- Account guard (`:541-552`).
- **Pushed-HEAD guard** (`:277-333`): refuses a detached HEAD, fetches `origin/<ref>`, and requires
  `git merge-base --is-ancestor <sha> FETCH_HEAD`. The comment records the incident this prevents —
  production once ran an unpushed local commit that was later lost. Override:
  `RECEIPT_ALLOW_UNPUSHED_DEPLOY=1` / `--allow-unpushed`.
- Local validation guard, and for production the full `prod-aws-preflight` (`:335-360`).
- **Commit-bound buildspec override** (`:257-275`): the local
  `deploy/codebuild/<deploy-project>.buildspec.yml` must byte-match the committed version at the deploy
  SHA; it is uploaded to `s3://<bucket>/buildspecs/<sha>.yml` and passed as
  `--buildspec-override`. This lets routine operators start builds without permission to mutate the
  shared CodeBuild project or its IAM role.
- `--wait` streams CloudWatch log events and exits non-zero unless the build status is `SUCCEEDED`
  (`:362-423`).

---

## 6. Operations

### 6.1 Readiness and release gates

| Command | Script | Purpose |
| --- | --- | --- |
| `bun run receipt:prod:readiness` | `scripts/prod-readiness-gate.mjs` | Non-mutating baseline: Receipt CLI prod identity + hosted debug snapshot |
| `bun run receipt:prod:release-gate` | same, `--release` | Fail-closed release gate |
| `bun run receipt:prod:aws-preflight` | `scripts/prod-aws-preflight.mjs` | Non-mutating pre-deploy AWS/SST readiness |
| `bun run receipt:prod:domain-preflight` | `scripts/prod-domain-preflight.mjs` | DNS / certificate / Route 53 / ACM evidence |
| `bun run receipt:prod:auth-email-smoke` | `apps/start` `auth:email-smoke` | Live Better Auth email smoke |
| `bun run receipt:test:prod-orchestration` | `scripts/prod-orchestration-smoke.mjs` | Creates and validates a hosted objective |

**Release gate** (`prod-readiness-gate.mjs:672-812`) writes
`.deploy-artifacts/prod-readiness/<timestamp>/summary.json` with
`status: "production_ready"` or `"not_production_ready"` and a `failures` array. In `--release` mode it
requires an explicit `--web-url`/`RECEIPT_PROD_WEB_URL` (error text names
`https://app.kentron.ai` as the example origin), an HTTPS `/health` preflight, `receipt debug prod`
with zero error findings and zero stale-durable warnings by default, an AWS STS identity check, a
hosted orchestration smoke with Receipt Connect required, and hosted Zero analyzer probes. It also
asserts the Receipt CLI's saved target is `prod` and its gateway matches the URL under test
(`:686-700`). Zero probes run `bun run --cwd apps/start zero:analyze -- --zero-cache-url <web>/zero --query <q>`
for 13 standing projections plus 7 smoke-objective-scoped probes, and parse
`total synced rows: N` from the output (`:18-75,299-305,553-600,760-786`). Secret inputs
(`ZERO_ADMIN_PASSWORD`, `ZERO_COOKIE`/`ZERO_AUTH_TOKEN`/`ZERO_AUTH_JWT`) are read from env and are
**not** written to the summary (`:660-666`).

**AWS preflight** (`prod-aws-preflight.mjs:857-935`) is explicitly non-mutating ("It does not deploy,
create buckets, write secrets, or start CodeBuild") and checks seven areas —
`git`, `awsIdentity`, `localValidation`, `secrets`, `codeBuild`, `productionRuntime`, `authEmail` —
producing `status: "production_aws_ready" | "production_aws_not_ready"` plus a machine-readable
`nextActions` list with ids `free_local_disk`, `rerun_current_commit_validation`,
`resolve_production_principal`, `bootstrap_production_stack`, `promote_nango_prod_secret`,
`confirm_ses_sender_identity`, `appeal_ses_production_access`, `rerun_production_preflight`
(`:680-760`). Notable assertions: working tree clean, branch is `main`, local HEAD equals
`origin/main` (`:402-414`); production CodeBuild must not set `RECEIPT_SKIP_NANGO_PREFLIGHT` or
`RECEIPT_SKIP_PREDEPLOY_BUILD` "for release evidence" (`:555-563`); a factory-named stage secret is
rejected for production (`:545`); `IntegrationSecretKey` flagged as a bootstrap placeholder blocks
release (`:85`); command summaries are redacted before being written
(`redactSecretsManagerValueCommandSummary`, `redactCodeBuildProjectCommandSummary`,
`redactAwsRuntimeCommandSummary`, `:354-383`).

`docs/prod-readiness-metrics.md:57-77` is the published threshold table (CLI target, AWS predeploy,
auth-email smoke, HTTPS origin, domain/cert, hosted routes, debug findings = 0, stale durable
warnings = 0, orchestration, receipt replay, computer path, FE projection visibility, projection
parity, running/terminal tallies, AWS control plane, regenerate acceptance). Its "Current Release
Blockers" section is a dated internal status snapshot — see **§10**.

### 6.2 CI

`.github/workflows/ci.yml` runs on PRs and pushes to `main`: Postgres 17 service container, Bun
1.3.12, Node from `.node-version`, Bun + Turbo caches, `bun install --frozen-lockfile`,
`bun run toolchain:check`, `bun run --cwd apps/start i18n:compile`, `bun run check:fast`
(15-minute timeout, 45-minute job timeout). Deploy is a separate `workflow_run`-triggered workflow
gated on CI success and a GitHub `factory` environment (`.github/workflows/deploy-factory.yml:37-43`).

### 6.3 Nango integration provisioning

Postdeploy, `deploy-aws.mjs` runs `ensureReceiptConnectNangoIntegrations` (`:1813-2086`), which:

1. Runs `bun scripts/ensure-nango-webhook-config.mjs --apply --public-base-url <origin>` **inside a
   one-off Runtime task** (`:2088-2101`).
2. Runs `bun scripts/audit-nango-receipt-connections.mjs --fail-on-drift --grace-seconds 120`
   the same way (`:2103-2116`).
3. Lists `GET <origin>/integrations/integrations`, creates the `aws` → `aws-iam` integration if
   missing (`display_name: "AWS"`, `forward_webhooks: true`), and logs
   `[aws-guard] created Receipt Connect Nango integration aws -> aws-iam`.
4. Creates a Nango connect session, then a **Receipt** connect session at
   `POST <origin>/connect/nango/sessions` using a short-lived HS256 JWT it mints from
   `RECEIPT_CONNECT_JWT_SECRET` (`iss: receipt`, `aud: receipt-connect`, `scp: ["connect:write"]`,
   5-minute expiry — `:2243-2259`).
5. Posts a correctly HMAC-signed probe to `POST <origin>/connect/nango/webhook` with header
   `x-nango-hmac-sha256` and requires `{ok:true}` (`:1940-1961`).
6. Requires `GET <origin>/oauth/callback?receipt_deploy_probe=1` to contain the string
   `"Nango OAuth flow callback"` — proving the provider OAuth callback path reaches Nango rather than
   the app shell (`:1963-1975`).
7. Requires the connect link's `apiURL` query parameter to equal `<origin>/integrations` "to prevent
   browser links from pointing at private ECS service discovery names" (`:1987-1993`), loads the
   generated Connect page, and fails if it still contains root-relative `/assets/` references.
8. Exercises the browser-side paths through the public gateway: `/connect/session`, `/integrations`,
   and `/api-auth/basic/<aws integration key>` (`:2017-2083`).
   Success: `[aws-guard] Receipt Connect Nango aws integration validated`.

Operator commands (`package.json:43-46`):

```bash
bun run factory:integrations:check      # ensure-nango-integrations.mjs --from-aws --check
bun run factory:integrations:audit      # audit-receipt-integration-surfaces.mjs
bun run factory:integrations:ensure     # --from-aws --apply
bun run factory:integrations:reconcile  # --from-aws --apply --refresh-oauth --allow-missing-credentials
```

`scripts/ensure-nango-integrations.mjs:45-71` documents the direct forms, including
`--provider-only --apply` and `--only <comma-separated connector ids>`. Two behavioral rules to
document: `--apply` alone never rewrites existing credentials (`:378`), and adding scopes requires
`--refresh-oauth` **plus** re-authorizing every existing connection, because
"an issued OAuth grant does not gain scopes retroactively" (`:466`). The single-host rollout runs the
reconcile form inside the host after Nango is healthy (`single-host-rollout.mjs:196`).

### 6.4 Single-host rollout details

`bun run single-host:rollout -- --stage factory-lite --tag <git-sha> --services runtime,gateway`
(default services `runtime,gateway,integrations,teams`, `single-host-rollout.mjs:44`; allowed set is
`runtime, gateway, slack, teams, integrations`, `:586-596`). It:

- finds the instance by tags `Stage=<stage>`, `Service=SingleHost`, state `running`, failing if more
  than one matches (`:564-584`);
- backs up compose + env with a UTC timestamp;
- refreshes `OPEN_SANDBOX_API_KEY` (and optionally `OPENAI_API_KEY`) from SSM SecureString
  parameters, defaulting to `/receipt-factory/<stage>/opensandbox/api-key` and
  `/receipt-factory/<stage>/openai/api-key`; a missing OpenAI parameter preserves an already-installed
  non-empty value, and only `--allow-missing-openai-key` allows it to be absent entirely
  (`:106-123,446-485`);
- always sets `OPEN_SANDBOX_CLEANUP_ON_FINISH=task` ("The single-host path is a hosted deployment",
  `:68-71`);
- verifies a new sandbox worker image by running
  `docker run --rm --entrypoint /bin/sh <image> -lc 'test -x /usr/local/bin/receipt && receipt --help && receipt connect --help'`
  before adopting it (`:246-252`);
- rewrites only the matching compose `image:` lines with Python helpers that fail if the match count
  is not exactly one (`:254-309`);
- when the gateway image changes: `docker-compose run --rm gateway bun run --cwd apps/start zero:migrate`
  then `docker-compose up -d --force-recreate zero-view-syncer` — "unrelated Runtime or channel
  rollouts must not interrupt the durable serving replica" (`:177-185`);
- installs/refreshes the runtime health watchdog (`:311-408`);
- health-checks `/health`, `/integrations/health`, `/zero/`, Slack `/health`, Teams `/health`,
  `OPEN_SANDBOX_API_KEY` present in `runtime-worker-codex`, and (unless allowed missing)
  `OPENAI_API_KEY` present in gateway/worker-control/worker-codex (`:187-218`);
- prints `rollout-ok` on success; failure prints `[single-host-rollout] single-host rollout failed: <status> (<code>)`.

### 6.5 Power up / down of the lite stack

`bun run factory-lite:{status,down,up}` → `scripts/factory-lite-power.mjs`.

- Resource discovery is by exact tags: `Stage=<stage>` and `Service` in `{SingleHost, OpenSandbox}`
  for EC2 (duplicates are an error), and RDS instances matched by `Stage` or `sst:stage` tag
  (`:50-68,159-197`).
- `down` order: **OpenSandbox → SingleHost → RDS**; `up` order: **RDS → SingleHost**, with
  OpenSandbox intentionally left stopped for on-demand start (`:80-108`).
- Shutdown is refused while nonterminal jobs are visible: it runs
  `.receipt/bin/receipt debug prod --web-url <url> --json --output-file …` and throws
  `"Refusing shutdown: <n> nonterminal job(s) are visible."`; `--force` skips this only after manual
  inspection (`:203-225`).
- RDS control requires `rds:DescribeDBInstances`, `rds:ListTagsForResource`, `rds:StartDBInstance`,
  `rds:StopDBInstance`; otherwise pass `--skip-database`, which leaves RDS billing active
  (`:227-239`, `docs/deploy/aws-sst-onboarding.md:62-73`).
- `up` waits up to 15 minutes for public `/health` and `/integrations/health` to both return ok
  (`:274-287`), then prints status. After `down` it prints
  `"RDS automatically restarts after at most seven consecutive stopped days."` (`:321-323`).
- Flags: `--stage`, `--region`, `--profile`, `--database-id`, `--web-url`, `--skip-database`,
  `--force`, `--json` (`:326-339`).

### 6.6 Operational safety details worth documenting

- The OpenSandbox host runs a `receipt-opensandbox-disk-guard` before every controller start: if the
  root filesystem has < 5 GiB free it cleans the `uv` cache and prunes stopped containers/build
  cache/unused images, re-pulls the required images, and refuses to start below 1 GiB free rather
  than crash-loop (`sst.config.ts:1335-1370`, reconciled on every deploy at
  `scripts/deploy-aws.mjs:1511-1563`).
- EFS is deliberately `bursting` throughput; the config comment says to watch CloudWatch
  `BurstCreditBalance` / `PercentIOLimit` after deploy (`sst.config.ts:436-442`).
- Duplicate sandbox instances for a stage are reported as a warning, not a failure
  (`scripts/deploy-aws.mjs:1687-1708`).
- Postdeploy validation fails if it finds more than one ECS cluster matching the stage:
  "Delete or rename stale retained clusters before running postdeploy validation."
  (`scripts/deploy-aws.mjs:2458-2464`).

---

## 7. Security

### 7.1 `SECURITY.md` (verbatim substance)

`SECURITY.md` is 24 lines. It says: do **not** report security vulnerabilities through public GitHub
issues; report them through "your organization's designated security contact channel"; expect a
response within 24 hours and follow up through the same private channel if none arrives; and include
issue type (buffer overflow, SQL injection, XSS, …), full source paths, tag/branch/commit or direct
URL, any special configuration needed to reproduce, step-by-step reproduction, proof-of-concept or
exploit code if possible, and impact including how an attacker might exploit it. There is no named
email address or PGP key in the file — a public docs site should either keep the "designated security
contact channel" wording or have the maintainers supply a real address (**open question**).

### 7.2 Encryption at rest for BYOK provider keys

`packages/receipt-app/src/services/byok-crypto.ts`:

- Algorithm `aes-256-gcm`, 32-byte key, 12-byte random IV, `KEY_VERSION = 1` (`:3-6`).
- The key comes from `BYOK_ENCRYPTION_KEY_B64` and must decode to **exactly 32 bytes**; errors are
  `"Missing required environment variable BYOK_ENCRYPTION_KEY_B64."`,
  `"BYOK_ENCRYPTION_KEY_B64 must be valid base64."`,
  `"BYOK_ENCRYPTION_KEY_B64 must decode to exactly 32 bytes."` (`:36-55`).
- The doc comment states the threat model plainly: "Provider API keys are stored in the database, but
  the AES-GCM wrapping key must come from deployment config so a database-only leak is not enough to
  recover plaintext provider credentials." (`:31-35`).
- Ciphertext record shape: `{ciphertextB64, ivB64, authTagB64, keyVersion}` (`:10-15,57-74`).
- A non-reversible 12-hex-char SHA-256 prefix is stored as a key fingerprint
  (`byokProviderKeyFingerprint`, `:24-25`).
- **Key rotation caveat:** decryption hard-fails on any other key version
  (`"Unsupported BYOK key version: <n>"`, `:80-82`) and there is **no re-encryption/rotation routine
  anywhere in the repo** (grep for "rotat" in the BYOK and connection modules returns nothing).
  `LOCAL_SETUP.md:227` states the operational rule: **"Do not rotate after saving keys."** Rotating
  `BYOK_ENCRYPTION_KEY_B64` makes every stored provider key permanently undecryptable; the only
  recovery is for each organization to re-enter its keys. The same applies to
  `RECEIPT_CONNECTION_ENCRYPTION_KEY_B64` (`LOCAL_SETUP.md:228`).

### 7.3 Encryption at rest for Receipt Connect connection secrets

`packages/receipt-app/src/services/receipt-connect-connections.ts:123-125,334-400`:
`aes-256-gcm`, 12-byte IV, `CONNECTION_KEY_VERSION = 1`, key from
`RECEIPT_CONNECTION_ENCRYPTION_KEY_B64`, which must decode to exactly 32 bytes
(`receipt-connect-config.ts:114-128`). Version mismatch throws
`"Unsupported Receipt Connect connection key version: <n>"`.

### 7.4 What Receipt never stores

`docs/receipt-connect-nango.md:17-19,52-63`: Receipt stores **only encrypted integration connection
references** in `org_connection_secret` — the mapping
`organization_id + provider + name -> nangoIntegrationId + nangoConnectionId`. Raw provider
credentials stay in the integration provider (Nango), which owns OAuth/API-key authorization,
credential storage, and refresh state. Runtime, Codex and OpenSandbox receive **generated CLI config
plus a Receipt credential helper** — "not provider API keys or raw provider tokens". Receipt owns
user/workspace auth, Receipt Connect JWT issuance, the workspace-name → connection mapping, runtime
credential materialization, policy, receipts, durable execution, and audit
(`docs/receipt-connect-nango.md:40-51`).

This is reinforced at the replication layer: the Zero publication declares an **explicit column list**
for `org_connection_secret` (id, organization_id, workspace_id, provider, name, kind, status,
expires_at, last_validated_at, created_at, updated_at) so "encrypted Receipt Connect material and
internal ownership metadata" are never replicated to browsers even though status shares the table
(`apps/start/scripts/zero-migrate.ts:726-763`).

### 7.5 JWT secrets and gateway auth

- `RECEIPT_CONNECT_JWT_SECRET` — HS256 secret shared by the web app and runtime so
  `receipt connect` JWTs verify (`LOCAL_SETUP.md:229`); the deploy smoke mints one with
  `iss: receipt`, `aud: receipt-connect`, `scp: ["connect:write"]`, 5-minute lifetime
  (`scripts/deploy-aws.mjs:2243-2259`).
- `RECEIPT_INTEGRATIONS_WEBHOOK_SECRET` — HMAC-SHA256 over the raw webhook body, header
  `x-nango-hmac-sha256` (`scripts/deploy-aws.mjs:1946-1953`).
- `RECEIPT_DEBUG_TOKEN` / `RECEIPT_DEBUG_JWT_SECRET` — hosted diagnostics; required on every runtime
  role service by the postdeploy contract (`scripts/deploy-aws.mjs:819-820`).
- `ZERO_ADMIN_PASSWORD` — Zero admin/analyzer credential; the Zero analyzer additionally needs a
  production token or browser cookie (`docs/prod-readiness-metrics.md:227-230`).
- `OPEN_SANDBOX_API_KEY` — sandbox controller API key, delivered to the host only through an SSM
  SecureString the instance role may read (`sst.config.ts:1211-1284`).

### 7.6 Sessions, cookies, and origins

Better Auth configuration (`apps/start/src/lib/backend/auth/services/auth.service.ts:446-563`):
`appName: 'Receipt'`, `basePath: '/api/auth'`, secret from `BETTER_AUTH_SECRET` (required),
Postgres-backed session store, email+password with `minPasswordLength: 8`, `maxPasswordLength: 128`,
`revokeSessionsOnPasswordReset: true`, and email OTP (6 digits, 5-minute expiry, 5 attempts,
`storeOTP: 'hashed'`) on non-self-hosted builds. Sessions carry `activeOrganizationId`, resolved on
session create (`:481-503`). Organization plugin caps organizations per user at 10 and enforces
per-organization seat limits (`:565-576`).

Session cookies themselves are issued by Better Auth's defaults (host-only, `HttpOnly`, `SameSite`
per Better Auth) — the repo does not override cookie attributes, so a docs page should describe the
requirement rather than invent attributes: `BETTER_AUTH_URL` must be the exact public origin, and the
Zero services are configured to forward cookies (`ZERO_QUERY_FORWARD_COOKIES=true`,
`ZERO_MUTATE_FORWARD_COOKIES=true`) with a header allowlist limited to
`x-receipt-zero-token,authorization` (`sst.config.ts:597-603`).

Trusted origins are strictly validated (`auth-trusted-origins.ts:6-44`): the canonical
`BETTER_AUTH_URL` plus any `RECEIPT_LEGACY_PUBLIC_ORIGINS` entries, each of which must be an absolute
**HTTPS** origin with no credentials, no wildcard host, and no path/query/fragment.

The gateway hides private services from the internet (§2.5) and the ALB/CloudFront terminate TLS;
the single-host path uses Caddy with automatic HTTPS and publishes the gateway only on
`127.0.0.1:3000` (`deploy/sst/single-host.ts:644-673`).

### 7.7 Zero Data Retention (ZDR) and policy controls

ZDR is an **organization compliance policy**, not an infrastructure setting.
`apps/start/src/lib/shared/ai-catalog/compliance-map.ts:1-21` defines
`OrgComplianceFlags = { require_zdr?, require_org_provider_key? }` and
`isDeniedByComplianceFlags`, which denies any model whose catalog entry has
`zeroDataRetention !== true` when `require_zdr` is set. The flag is surfaced in organization settings
(`apps/start/src/components/organization/settings/model-policy/compliance-flags-section.tsx:27-40`,
message ids `org_compliance_flag_require_zdr_title/description/help`), enforced in tool gating
(`apps/start/src/lib/shared/chat/tool-policy.ts:90`), threaded into chat orchestration and wide
events as `zeroDataRetentionRequired`
(`apps/start/src/lib/backend/chat/services/chat-orchestrator.service.ts:395-396`,
`.../observability/wide-event.ts:89`), and confirmed in the BYOK dialog
(`byok-form.tsx:142-172`, message ids `org_byok_zdr_dialog_*`). `README.md:33` advertises it as
"ZDR (Zero Data Retention) compliance at provider level".

### 7.8 AWS security baseline script

`bun run factory:security:baseline` → `scripts/apply-factory-security-baseline.mjs`. It requires
`RECEIPT_AWS_FACTORY_ACCOUNT_ID`, verifies the active account matches, and refuses an IAM-user
principal unless `RECEIPT_ALLOW_IAM_USER_FACTORY=1` (`:22-38`). It then:

1. **Account-level S3 Block Public Access** — all four flags true (`:40-50`).
2. **GuardDuty** — enables the existing detector or creates one with
   `--finding-publishing-frequency FIFTEEN_MINUTES` (`:52-74`).
3. **IAM Access Analyzer** — account-scoped analyzer named
   `RECEIPT_FACTORY_ACCESS_ANALYZER_NAME` (default `receipt-factory-account`) (`:76-87`).
4. **CloudTrail** — multi-region trail with log-file validation named
   `RECEIPT_FACTORY_CLOUDTRAIL_NAME` (default `receipt-factory-management-events`), writing to a
   bucket defaulting to `receipt-factory-cloudtrail-<account>-<region>`. The bucket gets public-access
   block, versioning, AES256 default encryption, and a policy that allows only
   `cloudtrail.amazonaws.com` to `GetBucketAcl` and `PutObject` under
   `AWSLogs/<account>/*`, conditioned on `aws:SourceArn` equal to the trail ARN and
   `s3:x-amz-acl = bucket-owner-full-control` (`:89-197`). Logging is then started.
5. **Budget (optional)** — monthly COST budget named `RECEIPT_FACTORY_BUDGET_NAME`
   (default `receipt-factory-monthly`) for `RECEIPT_FACTORY_BUDGET_USD` (default 250) with an
   ACTUAL > 80% email notification. Skipped with the message
   `"Budget skipped. Set RECEIPT_FACTORY_BUDGET_EMAIL to create one."` (`:199-245`).

Final line: `"Factory AWS security baseline applied."` (`:20`).

The broader account model in `docs/deploy/aws-sst-onboarding.md:496-536` adds: root MFA and no
routine root use, no shared access keys, read-only by default for humans, short-session temporary
write access, break-glass admin use requiring a written follow-up note, offboarding steps (disable in
IdP/Identity Center, remove group assignments, revoke sessions, rotate shared emergency credentials,
audit CloudTrail), and a note to postpone organization-wide SCPs until there are multiple accounts.

### 7.9 Least-privilege notes in the infrastructure itself

- Runtime services get **no** IAM permissions except the two roles that manage the sandbox host
  (`sst.config.ts:695-718,751,827,842`), and the start/stop grant is deliberately `Resource: "*"`
  with a comment explaining that a narrower per-instance ARN broke in-flight workers during host
  replacement.
- The sandbox instance role gets only ECR read-only, SSM managed-instance core, and
  `ssm:GetParameter` on its own parameter (`sst.config.ts:1262-1284`).
- The single-host instance role is scoped to one SSM parameter, two buckets, EC2 start/stop, and
  `ses:SendEmail`/`SendRawEmail` on identities in its own account (`deploy/sst/single-host.ts:171-215`).
- The CodeBuild deploy role is **not** least-privilege: it includes a
  `Sid: "SstDeployBootstrap"` statement with `Action: "*"`, `Resource: "*"`
  (`scripts/ensure-<deploy-project>-codebuild.mjs:348-353`). A public docs page should state this
  honestly and recommend scoping it down for production self-hosts.
- Secrets are handled without exposing values in process arguments where it matters: the domain
  script writes the new env to a 0600 temp file and passes `--value file://…`
  (`scripts/single-host-domain.mjs:495-517`).

---

## 8. Upgrades and migration

### 8.1 Database migrations on deploy

`apps/start/scripts/zero-migrate.ts` is the single production migration runner. Its own header
(`:1-22`) lists the nine steps; the implementation confirms them:

1. Loads `ZERO_UPSTREAM_DB` (falling back to `DATABASE_URL` / `DATABASE_PUBLIC_URL`); missing → error
   `"No Postgres connection string found. Set ZERO_UPSTREAM_DB, DATABASE_URL, or DATABASE_PUBLIC_URL in deployment variables."`
   (`:1158-1162`).
2. Connects with `options: '-c search_path=public'` and takes `pg_advisory_lock(4123771)` so
   concurrent deploys cannot race (`:48,1165-1173`, released in `finally` at `:1242-1247`).
3. Normalizes legacy per-user-schema tables back into `public` (`moveUserSchemaObjectsToPublic`).
4. Runs **Better Auth migrations** so auth-owned tables (`user`, `session`, `account`,
   `verification`, `organization`, `member`, `invitation`, `twoFactor`) exist (`:50-59,1068-1100`).
5. Creates the ledger `zero_schema_migrations (filename PK, checksum, applied_at)` (`:1180-1186`).
6. Bootstraps `zero/migrations/schema.sql` when baseline tables (`instance_settings`,
   `org_ai_policy`, `org_provider_api_key`, `receipt_chat_context_projection`) are missing
   (`:1193-1225`).
7. Applies every `^\d+_.+\.sql$` file in lexical order (`:1187-1236`); there are currently **49
   timestamped migrations plus `schema.sql`** in `apps/start/zero/migrations/`.
8. Refreshes the `zero_data` publication (below).
9. Records filename + SHA-256 checksum and **fails if an already-applied file changed**:
   `"Migration <file> was already applied with a different checksum. Create a new migration file instead of editing old ones."`
   (`:1035-1037`). A small allowlist, `COMPATIBLE_REAPPLY_CHECKSUMS`, lets specific historical files
   be re-applied idempotently and advances the ledger without weakening the check (`:97-135`).

**Where it runs.** Full stack: a one-off Fargate task launched from the Gateway task definition after
`sst deploy` (`scripts/deploy-aws.mjs:91-214`). Single-host: at host bootstrap
(`deploy/sst/single-host.ts:324`) and again on every rollout that changes the gateway image
(`scripts/single-host-rollout.mjs:179`).

### 8.2 Zero migrations and publications

- `ZERO_APP_ID=receipt`, `ZERO_APP_PUBLICATIONS=zero_data` are pinned for every Zero process and
  re-asserted postdeploy (`sst.config.ts:155-163`, `scripts/deploy-aws.mjs:1298-1303`).
- The publication is **curated, not `FOR ALL TABLES`**. `apps/start/scripts/zero-publication.ts:5-21`
  lists the UI tables (`user`, `organization`, `member`, `invitation`, `org_ai_policy`,
  `org_connection_secret`, `receipt_workspace`, `receipt_workspace_member`, `attachments`,
  `org_billing_account`, `org_subscription`, `org_entitlement_snapshot`, `org_member_access`,
  `org_user_usage_summary`) plus `ZERO_DEFAULT_RECEIPT_PUBLICATION_TABLES`.
  `ZERO_PUBLICATION_EXTRA_TABLES` (comma-separated) is the supported opt-in for a new UI surface
  (`:46-51`). Raw receipt logs, memory embeddings, durable scheduler tables and eval/computer
  projections stay server-side (`zero-migrate.ts:786-793`).
- Table refs are schema-qualified: `receipt_*` projections use `RECEIPT_POSTGRES_SCHEMA`
  (default `public`), everything else is `public` — with explicit exceptions for
  `receipt_workspace`, `receipt_workspace_member`, `receipt_org_guardrail_group_projection`, and
  `receipt_org_policy_rule_projection`, which are app-owned public tables despite the prefix
  (`zero-publication.ts:29-75`).
- Refresh is `ALTER PUBLICATION zero_data SET TABLE …` when it exists, otherwise
  `CREATE PUBLICATION zero_data FOR TABLE …`, with per-table column lists where declared
  (`zero-migrate.ts:764-825`). Log lines:
  `Refreshing zero_data publication with <n> tables...` / `Creating zero_data publication with <n> tables...`
- **Replica generation.** `zeroReplicationManagerReplicaGeneration = "v4"`
  (`sst.config.ts:164-169`) controls both `ZERO_REPLICA_FILE`
  (`/app/.zero/replication-manager-v4.db`) and `ZERO_LITESTREAM_BACKUP_URL`
  (`s3://<ZeroBackups>/v4`). Bumping it is the documented recovery when a bad publication/schema
  change leaves the durable SQLite replica unable to apply the change log: Postgres remains
  authoritative and a new generation forces a fresh initial sync instead of restoring a poisoned
  EFS/Litestream copy. Postdeploy validation pins the exact expected values
  (`scripts/deploy-aws.mjs:1311-1322`).
- Upstream/topology constraints for a self-host (`docs/deploy/neon-to-aws-zero-migration.md:56-215`):
  Postgres 15+ with `rds.logical_replication=on` (requires a reboot after the parameter group
  change), `wal_level=logical`, enough `max_replication_slots` / `max_wal_senders`;
  `ZERO_UPSTREAM_DB` must be a **direct writer** connection (no PgBouncer, RDS Proxy, pooled URL,
  read replica, or Aurora reader endpoint) while `ZERO_CVR_DB` / `ZERO_CHANGE_DB` may be pooled;
  changing the upstream database invalidates the SQLite replica — delete
  `$ZERO_REPLICA_FILE` and `${ZERO_REPLICA_FILE}-*` before starting against the new upstream;
  inactive logical slots retain WAL, so watch `OldestReplicationSlotLag`,
  `OldestLogicalReplicationSlotLag`, `ReplicationSlotDiskUsage`, `TransactionLogsDiskUsage`,
  `TransactionLogsGeneration`, `FreeStorageSpace`. Zero uses Postgres event triggers where allowed;
  the manual fallback is
  `UPDATE receipt_0."shardConfig" SET "ddlDetection" = true;` then wrapping DDL with
  `SELECT receipt_0.update_schemas();` (verify the actual shard schema name first).

### 8.3 The shape of a data migration

A migration is a single timestamped, forward-only, **idempotent** SQL file in
`apps/start/zero/migrations/`, named `YYYYMMDD_snake_case_description.sql`
(regex `^\d+_.+\.sql$`, applied in lexical order). Conventions visible in
`apps/start/zero/migrations/20260903_add_org_activity_log.sql`:

- A leading comment block explaining *why* the table exists and why it is not modeled as receipts.
- `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` throughout.
- Columns commented inline; `metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb` for open-ended data;
  `created_at BIGINT` epoch millis.
- Indexes that match the exact read paths (org + created_at desc, org + workspace + created_at desc).

Rules a docs page should state: never edit an applied migration (the checksum guard will fail the
deploy); add a new file instead; if the new table must reach the browser, add it to
`ZERO_UI_PUBLICATION_TABLES` in `apps/start/scripts/zero-publication.ts` or pass
`ZERO_PUBLICATION_EXTRA_TABLES` — otherwise it stays server-side; and if a replicated table is added
to the Zero client schema, bump the versioned browser-storage namespace so existing IndexedDB
replicas rebuild (`docs/agent-fix-checklist.md:60-63`).

### 8.4 Upgrading the deployment

- **Application-only upgrade on the lite stack:** build the changed images
  (`<deploy-project>:start -- --stage factory --images-only --services <list> --wait`), then
  `single-host:rollout -- --stage factory-lite --tag <sha> --services <list>`.
- **Infrastructure upgrade:** merge to `main` → CI → CodeBuild → `deploy:aws`, or run
  `bun run deploy:aws` locally with the guards satisfied. Preview with
  `bun run receipt:factory:config` / `bun run receipt:prod:config`
  (`deploy-aws.mjs diff --stage <stage>`, `package.json:97-98`).
- **Production upgrade:** promote a release manifest; production never rebuilds images
  (§5).
- **Pinned versions to bump deliberately:** Bun `1.3.12` (`package.json:10`, all Dockerfiles), Node
  24 (`.node-version`), Postgres 17 (`sst.config.ts:102`), Zero `rocicorp/zero:1.5.0`
  (`sst.config.ts:421,537,586`), Nango `hosted-0.69.48` (`deploy/Dockerfile.nango:1`), Resonate
  `0.9.5` in the runtime image (`deploy/Dockerfile.receipt:5`), Codex `0.130.0`
  (`deploy/Dockerfile.receipt:3`), `opensandbox-server==0.2.2` with `execd v1.0.16` and
  `egress v1.0.12` (`sst.config.ts:1309,1332-1333`), docker-compose `v2.29.7` on the lite host
  (`deploy/sst/single-host.ts:236`).

---

## 9. Docs vs code disagreements (flag these before publishing)

1. **README omits the single-host / Receipt Lite path entirely.** `README.md:60-116` presents the
   multi-service SST deploy as *the* self-hosting path, while
   `docs/deploy/aws-sst-onboarding.md:7-27` and `docs/agent-fix-checklist.md:519-531` say the
   single-host `factory-lite` rollout is the **default** for routine live changes and that
   `deploy:aws`/`<deploy-project>:start` should be treated as infrastructure operations.
2. **README service list is stale.** It lists `receipt-zero-cache` (`README.md:72`), but the deployed
   Zero topology is two services, `ZeroReplicationManager` and `ZeroViewSyncer`
   (`sst.config.ts:535,584`). It also omits the Teams service (`sst.config.ts:869`) and the four
   dedicated runtime role services (`RuntimeDriver`, `RuntimeWorkerControl`, `RuntimeWorkerChat`,
   `RuntimeWorkerCodex`, `sst.config.ts:810-843`).
3. **OpenSandbox instance size.** `README.md:106` says "baseline `t3.large` host sizing are produced
   by `sst.config.ts`" and `deploy/aws-sst.env.example:55-57` also says `t3.large`, but the code
   default is `t3a.xlarge` (`deploy/sst/config.ts:60-61`) and `scripts/deploy-aws.mjs:242` prints
   `t3a.large` as the example. Three different values.
4. **Lease-cap defaults differ by surface.** Code default `OPEN_SANDBOX_GLOBAL_MAX_ACTIVE=3`
   (`deploy/sst/config.ts:78`); env template says `2` (`aws-sst.env.example:68`); the buildspec sets
   `2` (`<deploy-project>.buildspec.yml:15`); the CodeBuild project provisioner sets **`5`**
   (`scripts/ensure-<deploy-project>-codebuild.mjs:373`).
5. **`deploy:aws` cannot deploy the lite stage.** `scripts/deploy-aws.mjs:12-22,406-415` accepts only
   `factory` and `production`, yet `deploy/sst/single-host.ts:7-8` and the onboarding doc both treat
   `factory-lite` as a real stage. No repo script performs the initial `factory-lite` SST deploy;
   `single-host:rollout` only updates an already-provisioned host.
6. **Undocumented tuning variables.** `RECEIPT_AWS_ENABLE_CLOUDFRONT`, `RECEIPT_DATABASE_INSTANCE`,
   `RECEIPT_DATABASE_STORAGE`, `RECEIPT_REDIS_INSTANCE`, `RECEIPT_AWS_SERVICE_IMAGE_CACHE`, and all
   `RECEIPT_*_MIN_TASKS`/`_MAX_TASKS` variables exist in code (`deploy/sst/config.ts:52,58,66-95`)
   but appear in no env template.
7. **`deploy/Dockerfile.receipt-zero-cache` is unused by both deploy paths.** Both `sst.config.ts`
   and `deploy/sst/single-host.ts` default `ZERO_IMAGE` to `rocicorp/zero:1.5.0`. `LOCAL_SETUP.md:1069-1071`
   already flags it as "apparently orphaned"; nothing in the repo references the file.
8. **Resonate version floor.** `LOCAL_SETUP.md:1052-1055` claims `deploy/Dockerfile.receipt` pins
   `RESONATE_VERSION=0.9.5` below the enforced `>= 0.9.7` floor. Precisely: the floor is enforced by
   `scripts/start-resonate-runtime.mjs:255-276`, which **skips** the check when the binary basename is
   `resonate-server` — exactly what the Dockerfile renames it to
   (`deploy/Dockerfile.receipt:46-48`). So the container is not blocked, but the version gap between
   the container (0.9.5), `deploy/coder/template/build/Dockerfile` (0.9.8), and the SDK floor (0.9.7)
   is real and should be reconciled.
9. **`README.md:92` says "Node.js 24.x and npm"** while `scripts/preflight.mjs:13,68-80` derives the
   required Node major from `.node-version` and never checks npm.
10. **CloudFront is on by default but the README's caveats do not mention it**; `README.md:105`
    discusses only `RECEIPT_PUBLIC_BASE_URL`, while `guardPublicBaseUrl` explicitly rejects
    CloudFront origins as the public base URL (`scripts/deploy-aws.mjs:506-511`) even though SST
    creates a CloudFront distribution in front of the ALB.
11. **`docs/prod-readiness-metrics.md:104-165` is a dated status snapshot**, not documentation: it
    names a specific SES support case, a personal Gmail identity, a specific operator's Docker
    Desktop failure, and old commit SHAs. It must not be published as-is.
12. **`docs/deploy/app-kentron-ai-cutover-todo.md` is an internal, org-specific runbook** with live
    IPs, instance ids, CodeBuild run ids and image digests (`:30-45`). Not publishable.
13. `LOCAL_SETUP.md:1063-1073` also records: `.env.example` mislabels `AI_GATEWAY_API_KEY`/
    `ANTHROPIC_API_KEY` as required (the code reads `OPENAI_API_KEY`);
    `AUTH_DEV_EMAIL_OTP_TO_CONSOLE` is documented but unimplemented; `DEVELOPMENT.md`'s quick start
    omits `BYOK_ENCRYPTION_KEY_B64`; `apps/start/vite.config.ts` hardcodes a personal Tailscale
    hostname in `server.allowedHosts`. The last item is a real repo hygiene bug worth fixing before a
    public docs launch.

---

## 10. Internal only — must NOT be published

These are Kentron-internal operational details found while researching. They belong in an internal
runbook, never on a public docs site.

1. **Hardcoded AWS account id fallback.** A specific 12-digit AWS account id is hardcoded as the
   default in five places: `scripts/single-host-rollout.mjs:9`, `scripts/factory-lite-power.mjs:12`,
   `scripts/build-beetle-images.mjs:369`, `scripts/ensure-<deploy-project>-codebuild.mjs:539`,
   `scripts/start-<deploy-project>.mjs:537`, and as a literal value in
   `deploy/codebuild/<deploy-project>.buildspec.yml:13` and `:96`. Public docs must show
   `RECEIPT_AWS_FACTORY_ACCOUNT_ID=<your 12-digit account id>` instead, and the repo should ideally
   drop the fallback.
2. **Internal AWS profile names.** `beetle` and `<deploy-project-prod>` appear as concrete profile values
   throughout `deploy/aws-sst.env.example:11`, `docs/deploy/aws-sst-onboarding.md` (many),
   `docs/prod-readiness-metrics.md:29`, and are baked into two npm scripts as defaults:
   `receipt:aws:debug` and `receipt:aws:doctor` use `AWS_PROFILE=${AWS_PROFILE:-${RECEIPT_AGENT_AWS_PROFILE:-beetle}}`
   (`package.json:90-91`). `factory-lite-deploy` also appears as a profile name in
   `docs/receipt-real-workspaces-dev-handoff.md:467,494`.
3. **Employee-specific prod-debug flows.** `package.json:90-91` hardcodes
   `RECEIPT_PROD_WEB_URL=https://app.kentron.ai` together with the `beetle` profile;
   `scripts/factory-lite-power.mjs:42` and `:334` default the web URL to `https://app.kentron.ai`;
   `scripts/prod-readiness-gate.mjs:146,155` name it in error text. Generic docs should use a
   placeholder origin.
4. **Internal deploy identifiers.** Secrets Manager ids `<deploy-secrets-prefix>/factory-secrets-env`,
   `<deploy-secrets-prefix>/production-secrets-env`, `<deploy-secrets-prefix>/dockerhub`; CodeBuild projects
   `<deploy-project>`, `<deploy-project>-production`; IAM roles `BeetleDeployCodeBuildRole`,
   `BeetleProductionDeployCodeBuildRole`, `ReceiptFactoryDeployRole`; S3 buckets
   `<deploy-project>-source-<account>-<region>`, `<deploy-project>-production-source-…`,
   `<deploy-project>-releases-…` — publish these only as *patterns*, never with the real account id.
5. **The private git remote** `https://github.com/skishore23/receipt-factory.git` hardcoded in
   `deploy/codebuild/<deploy-project>.buildspec.yml:110`.
6. **`docs/deploy/app-kentron-ai-cutover-todo.md` in its entirety** — the `beetle.run` →
   `app.kentron.ai` cutover checklist, its owners table, and its "Live Execution Record" containing a
   real Elastic IP, EC2 instance id, CodeBuild run id, release SHA and image digests (`:30-45`).
7. **`docs/prod-readiness-metrics.md:104-165` "Current Release Blockers"** — an AWS SES support case
   number, a **named personal Gmail address** used as the only SES identity, an operator's Docker
   Desktop / disk-space failure with AppleEvent error code, and specific stale commit SHAs.
8. **`docs/deploy/aws-sst-onboarding.md` internal sections** — the Identity Center group names
   (`FactoryAdmins`, `FactoryDevelopers`, `FactoryReadOnly`, `FactoryBreakGlass`), the concrete
   `aws configure sso --profile beetle` commands, the "team password manager" reference, the exact
   account-model table, and every command block containing the real account id. The *shape* of the
   guidance (use Identity Center, groups not direct assignment, MFA, short sessions) is publishable;
   the specific names are not.
9. **`docs/deploy/aws-coder-two-developer-runbook.md` + `deploy/coder/*`** — a two-named-developer
   internal remote-workspace setup with fixed slots `dev1`/`dev2` and host sizing tuned to one
   internal EC2 box (`deploy/coder/README.md:20-32`). Publishable only if rewritten generically.
10. **`docs/agent-fix-checklist.md`** — a ~17k-line internal RCA log referencing production incidents,
    instance ids, and internal profile names. Individual lessons can be paraphrased into public docs;
    the file itself cannot be published.
11. **Break-glass overrides as a set.** They are code-visible and can be documented, but the docs
    should present them as "documented break-glass only" (which is exactly how the code's own warning
    strings phrase them) rather than as ordinary configuration.

---

## 11. Open questions for a human

1. `SECURITY.md` says to report through "your organization's designated security contact channel"
   with no address. What is the public reporting address / process for the open-source project?
2. Is there any supported rotation story for `BYOK_ENCRYPTION_KEY_B64` and
   `RECEIPT_CONNECTION_ENCRYPTION_KEY_B64`? Both crypto modules carry a `keyVersion` field and reject
   anything but version 1, but no re-encryption path exists. Should docs say "rotation is not
   supported; re-enter keys" or is a rotation tool planned?
3. `sst.aws.Redis` — does the deployed ElastiCache cluster run Redis OSS or Valkey? The README says
   "Redis/Valkey" (`README.md:56,77`) but `sst.config.ts:426-429` passes no `engine`, so this depends
   on the SST component default for the pinned SST version (`sst ^4.14.3`). Needs confirmation before
   the docs state an engine.
4. How is a **new** `factory-lite` / single-host stage provisioned the first time? `deploy:aws`
   rejects the stage, and no script wraps `sst deploy --stage factory-lite`. Is a bare
   `bunx sst deploy --stage factory-lite` the intended (undocumented) command?
5. `deploy/Dockerfile.receipt-zero-cache` and `deploy/Dockerfile.runtime-hotfix`: are these still
   supported, or should they be removed/marked internal-only in docs?
6. Is `RECEIPT_AWS_ENABLE_CLOUDFRONT=0` a supported self-hosting configuration (ALB-only), and what
   is the guidance when the ALB serves plain HTTP because no domain is configured?
7. `deploy/aws-sst.env.example` mentions `RESEND_FROM_EMAIL` and the SST secret `ResendApiKey` under
   "Receipt Lite can use Resend instead of SES" — is Resend a supported production auth-email
   provider for self-hosts, or factory/lite only? (`deploy-aws.mjs:661-674` forbids anything but SES
   on the `production` stage.)
8. What retention/backup policy applies to the `ZeroBackups` bucket and RDS automated backups? The
   code sets no bucket lifecycle on `ZeroBackups` and no explicit RDS backup retention.
9. Are the Qdrant vector store and the Cloudflare markdown-converter worker part of the supported AWS
   self-host topology? Neither appears in `sst.config.ts`; `VITE_ENABLE_EMBEDDING` is hardcoded
   `"false"` for hosted deploys (`sst.config.ts:311,906`).
10. The npm script `factory:security:baseline` is factory-only by name and reads
    `RECEIPT_AWS_FACTORY_ACCOUNT_ID` unconditionally (`apply-factory-security-baseline.mjs:6,23`).
    Should a production account run the same baseline, and if so how?

---

## Suggested doc pages

| Slug | Title | Audience | What the reader can do after reading |
| --- | --- | --- | --- |
| `deploy/architecture` | Production Architecture on AWS | both | Understand every SST resource and service, how requests route through the gateway service graph, and where state lives |
| `deploy/self-hosting` | Self-Hosting Receipt on AWS | developer | Run a complete first deploy: prerequisites, secrets, env vars, command sequence, and what each guard checks |
| `deploy/configuration-reference` | Deployment Configuration Reference | developer | Look up every deploy-time env var and SST secret by name, with defaults and meaning |
| `deploy/deployment-paths` | Two Deployment Paths: SST/CodeBuild vs Single-Host | developer | Choose the right path for a given change and run it end to end |
| `deploy/single-host` | Single-Host (Receipt Lite) Deployment | developer | Provision, roll out, change the domain of, and power-cycle the one-machine stack |
| `deploy/docker-images` | Docker Images and Entrypoints | developer | Know what each image contains, how it starts, and which pinned versions to bump |
| `deploy/domains-and-tls` | Domains, TLS, and Public Origins | both | Attach a custom domain in Route 53 or with an external ACM cert, and verify it with the domain preflight |
| `operations/health-and-monitoring` | Health Checks and Monitoring | developer | Find the right health endpoint per service and know which CloudWatch metrics matter |
| `operations/release-gates` | Release and Readiness Gates | developer | Run the AWS preflight, domain preflight, and fail-closed release gate, and read their JSON artifacts |
| `operations/integrations-provisioning` | Provisioning Integrations (Nango) | both | Obtain the Nango prod key, provision connectors, refresh OAuth scopes, and interpret failures |
| `operations/cost-controls` | Powering the Stack Up and Down | developer | Safely stop and start the lite stack and the sandbox host, with the IAM permissions required |
| `security/overview` | Security Overview | both | Understand encryption at rest, what Receipt never stores, session/origin handling, and reporting a vulnerability |
| `security/aws-baseline` | AWS Security Baseline | developer | Apply CloudTrail, GuardDuty, Access Analyzer, S3 BPA and budgets to a self-host account |
| `security/keys-and-rotation` | Encryption Keys and the Rotation Caveat | both | Generate the four 32-byte keys correctly and understand why BYOK/connection keys must not be rotated |
| `platform/compliance-and-zdr` | Compliance Controls and Zero Data Retention | user | Turn on `require_zdr` and org-key requirements and understand what they gate |
| `upgrades/migrations` | Database and Zero Migrations | developer | Write a migration, know when it runs on deploy, and add a table to the Zero publication |
| `upgrades/releases` | Image Tagging, Release Manifests, and Rollback | developer | Cut an immutable release, promote it to production, and roll back |
| `upgrades/postgres-and-zero` | Postgres Requirements and Upstream Migration | developer | Meet Zero's logical-replication requirements and move the upstream database safely |
