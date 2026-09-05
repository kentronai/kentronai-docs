# Receipt — Authentication, Accounts, Organizations, Workspaces, Members, Roles, Admin

Research report for the public documentation site. Source of truth is the code in
`<receipt-repo>`. Every substantive claim is cited
`path:line`. All paths below are relative to the repo root unless shown as absolute.

Repo snapshot: branch `main`, commit `add21f9`, `package.json` version `1.2.0`.

---

## 0. Executive shape of the area

Receipt's identity layer is **Better Auth** (`better-auth ^1.5.2`, `@better-auth/core 1.5.2`,
`@better-auth/stripe ^1.5.4` — `apps/start/package.json:39-61`) mounted inside the TanStack Start
web app (`apps/start`) at `/api/auth/*` (`apps/start/src/routes/api/auth/$.tsx:5-11`). There is
exactly one `betterAuth(...)` call in the whole monorepo:
`apps/start/src/lib/backend/auth/services/auth.service.ts:446`.

Two tenancy concepts exist and they are **not** the same thing:

1. **Organization** — a Better Auth `organization` row. This is the billing tenant, the
   membership boundary, and what the sidebar switcher switches. Confusingly, most user-facing
   copy calls this a "workspace" (e.g. the auto-created org is named `"<Name>'s Workspace"` —
   `apps/start/src/lib/backend/auth/domain/default-organization.helpers.ts:21`), and billing
   strings say "workspace subscription" while operating on organizations.
2. **Receipt workspace** — a row in `receipt_workspace`, owned by
   `packages/receipt-app/src/services/receipt-workspaces.ts`. This is the *credential /
   authorization boundary* used by the MCP Gateway, Receipt Connect, and the CLI. Every
   organization gets a deterministic `Default` workspace plus a hidden "global scope" row.

A deployment runs in one of two modes, chosen at build time by `VITE_APP_INSTANCE_MODE`
(`apps/start/src/utils/app-feature-flags.ts:25-28`): `cloud` (default) or `self_hosted`. The
mode changes which auth methods exist at all.

The hosted product is at `https://app.kentron.ai`, but the shipped landing page and logo alt
text brand the product as **"beetle" / "beetle.run"** — see §11 (docs-vs-code).

---

## 1. Auth methods that actually exist

### 1.1 Configured in `betterAuth(...)`

| Method | Enabled when | Evidence |
|---|---|---|
| Email + password | Always (both modes) | `auth.service.ts:521-528` |
| Email OTP (verification + password reset) | **cloud only** (`!isSelfHosted`) | `auth.service.ts:539-563` |
| Google OAuth | **cloud only**, and only if `GOOGLE_CLIENT_ID` *and* `GOOGLE_CLIENT_SECRET` are both set | `auth.service.ts:90-91, 529-538` |
| Anonymous ("guest") sessions | **cloud only** | `auth.service.ts:727-756` |
| Two-factor (TOTP + backup codes) | Always registered | `auth.service.ts:765-778` |
| Multi-session (multiple devices) | Always, `maximumSessions: 10` | `auth.service.ts:758-764` |
| Organizations / invitations | Always | `auth.service.ts:565-720` |
| Stripe subscriptions | **cloud only**, and only if `STRIPE_SECRET_KEY` *and* `STRIPE_WEBHOOK_SECRET` are set | `auth.service.ts:127-128, 141-220` |

**There is no magic-link plugin and no passkey plugin.** The client only registers
`organizationClient`, `stripeClient`, `anonymousClient`, `multiSessionClient`,
`twoFactorClient`, `emailOTPClient` (`apps/start/src/lib/frontend/auth/auth-client.ts:29-50`).
A string `settings_security_login_methods_passkeys_title` = `"Passkeys"` exists in
`apps/start/messages/en.json` but there is no passkey plugin behind it.

### 1.2 What the sign-in UI actually renders (important)

The rendered sign-in/sign-up surface is **email + password only**. `SignInPage`
(`apps/start/src/components/auth/sign-in/sign-in-page.tsx:52-128`) renders `LoginHeader`,
`LoginForm`, `LegalLinks` and nothing else. `LoginForm`
(`apps/start/src/components/auth/sign-in/login-form.tsx:118-368`) has only Email, Password,
Confirm Password (sign-up), "Forgot your password?", the submit button, and the mode-toggle
footer. There is **no Google button and no "Continue as guest" button anywhere in the app**:

- `grep signIn.social` across `apps/start/src` returns **no** call sites.
- The strings `auth_sign_in_google` = `"Continue with Google"`, `auth_login_sign_in_google` =
  `"Sign in with Google"`, `auth_sign_in_guest` = `"Continue as guest"`,
  and the GitHub/Microsoft variants exist in `apps/start/messages/en.json` but are **unused**.

So: Google OAuth is reachable only by hitting the Better Auth endpoint directly (or via account
linking code that is also not wired to a button — see §5.2). **Docs must not promise a
"Sign in with Google" button.**

Anonymous sign-in is called from exactly one place: the Zero sync provider bootstrap
(`apps/start/src/lib/frontend/auth/use-auth.ts:48-52`, called from
`apps/start/src/integrations/zero/provider.tsx:120-136`) — it is automatic, not a user action.

---

## 2. Brand-new user: exact step sequence (cloud mode)

### 2.1 Landing page → sign-up

1. Visitor lands on `/` — `apps/start/src/routes/index.tsx:4-10` renders `LandingPage`.
   Navbar brand label is `"beetle.run"`; nav links are **Runtime** (`/#about`) and **Receipts**
   (`/#models`); the single CTA button reads **"Try beetle"** and links to `/auth/sign-up`
   (`apps/start/src/components/landing/landing-page.tsx:790-798`,
   `apps/start/src/components/layout/navbar.tsx:44-77`,
   `apps/start/src/components/layout/navbar-auth-buttons.tsx:33-52`).
   Hero H1: `"Audit-friendly agents that improve every run."`
   (`landing-page.tsx:960-965`). Additional "Try beetle" CTAs at `landing-page.tsx:991, 1859,
   1901, 1975`. **There is no "Sign in" link in the landing navbar.**
2. `/login` is a permanent redirect to `/auth/sign-in`, preserving `?redirect=`
   (`apps/start/src/routes/login.tsx:4-20`).
3. `/auth/sign-up` renders the same combined component in sign-up mode
   (`apps/start/src/routes/auth/sign-up/route.tsx:29-70`). If a session already exists and is
   not anonymous, the user is bounced straight to the redirect target (`route.tsx:44-46`).
   While the initial session query resolves it shows `"Preparing sign up"`
   (`route.tsx:55-57`).

### 2.2 The form

Header (sign-up mode): title `"Create Account"`, subtitle `"Create your account to continue"`
(`login-header.tsx:29-39`; strings `auth_login_header_sign_up`,
`auth_login_header_sign_up_subtitle`).
Fields: **Email** (`"Enter your email"`), **Password** (`"Create a password"`),
**Confirm Password** (`"Confirm your password"` is defined but the rendered placeholder is
`common_enter_new_password`, `login-form.tsx:246`).
Submit button: **"Create Account"** → shows **"Please wait..."** while in flight
(`login-form.tsx:302-309`).
Footer: `"Already have an account?"` + **"Sign in"** (`login-form.tsx:319-332`).
Legal line under the card: `"By signing up, you agree to our Terms, Acceptable Use, and Privacy
Policy."` linking `/legal/terms`, `/legal/acceptable-use`, `/legal/privacy`
(`legal-links.tsx:19-40`).

Client-side validation (`login-form.tsx:52-88`): email must match
`/^[^\s@]+@[^\s@]+\.[^\s@]+$/` (`auth-shared.ts:1`), password ≥ **8** chars
(`AUTH_PASSWORD_MIN_LENGTH = 8`, `auth-shared.ts:3`), passwords must match. Errors:
`"Please enter a valid email address"`, `"Password must be at least 8 characters"`,
`"Passwords do not match"`.
Email is lowercased+trimmed before submit (`auth-shared.ts:11-13`).
The display name is derived from the email local part — `ari.say@x.com` → `"Ari Say"`
(`auth-shared.ts:43-51`, used at `sign-in-page.logic.ts:466`).

Server-side: `minPasswordLength: 8`, `maxPasswordLength: 128`
(`auth.service.ts:523-524`).

### 2.3 What happens on submit (cloud)

`authClient.signUp.email({ name, email, password })`
(`sign-in-page.logic.ts:463-470`). Then:

- **If email OTP is active** (`!isSelfHosted && !isEmailVerificationOtpDisabled`), the UI moves
  to the verification step (`sign-in-page.logic.ts:483-486`). Screen: title
  `common_check_your_email`, description `"We sent you a code to verify your email."`,
  instruction `"Enter the code sent to {email}."`, submit `"Verify"`, resend link
  (`sign-in-page.tsx:66-86`). The OTP is **6 digits**, expires in **5 minutes**, allows **5**
  attempts, and is stored hashed (`auth.service.ts:550-553`; client-side countdown constant
  `OTP_EXPIRES_IN_SECONDS = 5 * 60`, `auth-shared.ts:6`). On success the app verifies the OTP
  and then signs the user in with the password it kept in memory
  (`sign-in-page.logic.ts:509-560`).
- **If OTP is disabled** (see §2.5), signup goes straight to the redirect target.

`requireEmailVerification` on the credential provider is
`!isSelfHosted && !isEmailVerificationOtpDisabled` (`auth.service.ts:525-526`), so in cloud
with OTP on, an unverified account cannot sign in — the sign-in path detects the
`EMAIL_NOT_VERIFIED` 403, sends a fresh OTP, and shows the same verification step
(`sign-in-page.logic.ts:376-405`, `isEmailNotVerifiedAuthError` at `:83-93`).

### 2.4 Immediately after the user row is created

Better Auth `databaseHooks.user.create.after` (`auth.service.ts:458-482`):

1. If `isEmailVerificationOtpDisabled`, the new user is force-marked email-verified
   (`auth.service.ts:460-462`).
2. Unless the user is anonymous (`shouldProvisionDefaultOrganization`,
   `default-organization.helpers.ts:6-10`), **an organization is auto-created**
   (`ensureDefaultOrganizationForUser`, `auth.service.ts:474-478`).
   - Name: `"<display name>'s Workspace"`, or from the email local part when the name is empty
     or literally `"human"` — `"ari.say@x.com"` → `"Ari Say's Workspace"`
     (`default-organization.helpers.ts:15-32`).
   - Slug: `slugify(name)` (max 40 chars) + `-` + first 8 chars of the user id
     (`auth.service.ts:133-139`, `default-organization.service.ts:30-36`).
   - Serialized by a Postgres transaction-scoped advisory lock keyed
     `auth-user-provision:<userId>` so concurrent hooks cannot double-create
     (`auth.service.ts:333-360`).
3. `afterCreateOrganization` then runs (`auth.service.ts:625-637`):
   - `ensureReceiptTenantDirectories({ organizationId, userId })`
   - `ensureOrganizationBillingBaseline(organizationId)` — writes `org_billing_account`,
     `org_subscription`, `org_entitlement_snapshot` (`default-organization.service.ts:84-291`).
     Cloud defaults: `plan_id = 'free'`, `seat_count = DEFAULT_FREE_SEAT_COUNT = 5`,
     `status = 'inactive'`. Self-hosted defaults: `plan_id = 'self_hosted'`,
     `seat_count = 100000`, `status = 'active'`
     (`default-organization.service.ts:96-107`, `SELF_HOSTED_DEFAULT_SEAT_COUNT` at `:28`).
   - **Platform signup credit**: on cloud only, `PLATFORM_SIGNUP_CREDIT_NANO_USD =
     5_000_000_000` nano-USD = **$5.00** is granted to the organization *owner* as a
     `signup_grant` ledger entry (`default-organization.service.ts:110-116, 128-186`;
     constant at `apps/start/src/lib/backend/billing/services/workspace-usage/shared.ts:19`;
     `nanoUsdToUsd` divides by 1e9 at `shared.ts:151-153`). A unique signup-grant index makes
     it **one credit per user**, not per organization
     (`default-organization.service.ts:167-169` comment).
   - `ensureMemberAccessRecord` — inserts `org_member_access` with `status = 'active'`
     (`default-organization.service.ts:296-334`).
   - `recomputeOrgEntitlementSnapshot`.
4. `databaseHooks.session.create.before` sets `activeOrganizationId` on the new session to the
   user's oldest membership (`auth.service.ts:484-509`,
   `findFirstOrganizationForUserEffect` orders `member` by `createdAt asc`,
   `default-organization.service.ts:38-51`).

**There is no Receipt "Default workspace" created at signup.** The deterministic Default
workspace row is created lazily, the first time any workspace-scoped code path runs for that
org+user (`ensureDefaultForActor`, `packages/receipt-app/src/services/receipt-workspaces.ts:608-636`,
called from `listReceiptWorkspaces` at `:934` and `requireReceiptWorkspaceMembership` at `:977`).

### 2.5 First usable screen

Default redirect target is `/chat` (`getRedirectTarget`,
`sign-in-page.logic.ts:24-27` — any non-relative `?redirect=` is discarded and falls back to
`/chat`). `/chat` itself re-checks: an unauthenticated or anonymous visitor is redirected to
`/auth/sign-in?redirect=<path>` (`apps/start/src/routes/(app)/_layout/chat/route.tsx:14-26`).

**There is no onboarding wizard in cloud mode.** `/setup` exists but immediately redirects to
`/chat` when `!isSelfHosted` (`apps/start/src/routes/setup/route.tsx:9-12`).

### 2.6 Full step list — brand-new cloud user

1. `https://app.kentron.ai/` → click **Try beetle**.
2. `/auth/sign-up` → enter Email, Password, Confirm Password → **Create Account**.
3. (If OTP enabled) "Check your email" → enter 6-digit code within 5 min → **Verify**.
   App auto-signs in.
4. Server auto-creates the organization `"<Name>'s Workspace"`, its billing baseline
   (Free, 5 seats), $5 platform credit, and makes it the active organization.
5. Landing screen: `/chat`.

### 2.7 Sign-in (returning user)

`/auth/sign-in` (or `/login`). Header: `"Welcome Back"` / `"Sign in to continue"`. Submit
button `"Sign in"`. Errors: `"Invalid credentials"`,
`"An unexpected error occurred. Please try again."`,
`"You entered too many incorrect codes. Request a new one to continue."` (code
`TOO_MANY_ATTEMPTS`, `sign-in-page.logic.ts:76-88`).
If the account has 2FA, sign-in returns a `twoFactorRedirect` flag and the UI shows the
**"Two-step verification"** step: `"Before continuing, enter the code from your authenticator
app."`, `"Enter the 6-digit code for {email}."`, submit **"Continue"**
(`sign-in-page.logic.ts:110-124, 424-427`, `sign-in-page.tsx:88-101`).

### 2.8 Password reset (cloud only)

"Forgot your password?" is rendered only when `!isSelfHosted`
(`sign-in-page.tsx:123`, `sign-in-page.logic.ts` `handleShowForgotPassword`). It is an
**email-OTP reset**, not a link: `authClient.emailOtp.requestPasswordReset` →
`authClient.emailOtp.resetPassword`
(`apps/start/src/components/auth/forgot-password/forgot-password.logic.ts:90, 134, 187`).
Strings: title `"Reset Password"`, `"Enter your email to receive a reset code."`,
button `"Send Code"`, then `"Create Your New Password"` / `"Update Password"`.
`revokeSessionsOnPasswordReset: true` (`auth.service.ts:527`).

---

## 3. `VITE_APP_INSTANCE_MODE`: cloud vs self_hosted

Resolved once at module load; anything other than the exact string `self_hosted` means `cloud`
(`apps/start/src/utils/app-feature-flags.ts:25-28`). It is a **Vite build-time** variable, so it
is baked into the browser bundle — changing it requires a rebuild.

| Behaviour | `cloud` | `self_hosted` |
|---|---|---|
| Email OTP plugin | registered | **not registered** (`auth.service.ts:539-563`) |
| `requireEmailVerification` | true (unless OTP disabled) | **false** (`auth.service.ts:525-526`) |
| Google / social auth | allowed if creds set | **blocked** — middleware throws `FORBIDDEN` / `SELF_HOSTED_SOCIAL_AUTH_DISABLED`, message `"Social auth is disabled for self-hosted instances."` (`auth.service.ts:230-262`) |
| Email verification & password recovery endpoints | allowed | **blocked** — `SELF_HOSTED_EMAIL_DELIVERY_DISABLED`, `"Email verification and password recovery are disabled for self-hosted instances."` (`auth.service.ts:238-268`) |
| Anonymous plugin | registered | **not registered** (`auth.service.ts:727-756`); `signInAnonymously()` also early-returns (`use-auth.ts:49`) |
| Stripe plugin + client | registered if keys set | **never** (`auth.service.ts:141-143`, `auth-client.ts:38-45`) |
| `/pricing` | full pricing UI | static card: **"Self-hosted instance"** / `"Cloud billing and plan upgrades are disabled in self-hosted mode. This deployment already runs with the self-hosted capability profile."` (`apps/start/src/routes/pricing/route.tsx:24-36`) |
| `changeEmail` | enabled | **disabled** (`auth.service.ts:517-519`) |
| `/setup` gating | redirects to `/chat` | serves the claim wizard (`routes/setup/route.tsx:9-22`) |
| `/auth/sign-up` | serves the form | **always redirects** — to `/auth/sign-in` if setup complete, else `/setup` (`routes/auth/sign-up/route.tsx:11-24`) |
| `/auth/sign-in` | serves the form | redirects to `/setup` when setup is incomplete (`routes/auth/sign-in/route.tsx:8-21`) |
| "Don't have an account? Create Account" footer | shown | **hidden** (`login-form.tsx:333-346`) |
| Default org plan / seats | `free` / 5 | `self_hosted` / 100000 (`default-organization.service.ts:96-104`) |
| Platform signup credit | $5.00 | **$0** (`default-organization.service.ts:112-115`) |
| Usage metering | enabled per plan | disabled (`buildDisabledUsagePolicy`, `workspace-usage/shared.ts:118-127, 162-179`) |
| Invitations | emailed | emailed **only if** a mail transport is configured; otherwise the invite dialog shows copyable signup links (`auth.service.ts:686-690`, `invite-members-dialog.logic.ts:137-143`) |
| Zero sync token | cookie-based possible | always uses an access token (`provider.tsx:85-90`) |

### 3.1 Skipping the signup OTP in cloud (development only)

`isEmailVerificationOtpDisabled` is true when instance mode is `cloud` **and** either
`VITE_DISABLE_EMAIL_VERIFICATION_OTP` is `true`/`1`, **or** the app is running under the Vite
dev server (`import.meta.env.DEV`) without `VITE_REQUIRE_SIGNUP_EMAIL_OTP=true|1`
(`app-feature-flags.ts:30-48`). When set, `sendVerificationOnSignUp` is false
(`auth.service.ts:92-94, 549`) and existing users are force-verified on session create
(`auth.service.ts:484-497`).
Supervisor script `scripts/start-all.mjs:114` reads `START_ALL_USE_SIGNUP_EMAIL_OTP=1` to opt
back in.
If a stale account was created while verification was required, the UI shows the long
developer-facing error `auth_error_local_unverified_stale_account`, which names
`bun run web:db:reset`, `START_ALL_USE_SIGNUP_EMAIL_OTP=1`, `VITE_REQUIRE_SIGNUP_EMAIL_OTP=1`
(`apps/start/messages/en.json`). **This message is developer-only; consider it a bug that it is
user-visible, and do not present it as normal product behaviour.**

### 3.2 Self-hosted first-run: `/setup`

Two-step wizard (`apps/start/src/components/auth/setup/setup-page.tsx:63-290`,
logic `setup-page.logic.ts`):

- **Step 1** — title `"Hello Human"`; subtitle `"Enter the setup token to claim this
  instance."` or, when `VITE_SELF_HOST_SOURCE=railway`, `"Thanks for self-hosting Receipt on
  Railway. Enter the setup token to claim this instance."`. Field **"Setup token"**,
  placeholder `"Paste the token here"`, help `"Use the token from your self-hosted setup."`
  (or the Railway variant). Button `common_continue`.
  The token may also arrive as `?setupToken=` / `?setup-token=` / `?token=`; it is read then
  stripped from the URL (`setup-page.logic.ts:57-91, 156-158`).
- **Step 2** — title `"Create your admin account"`, subtitle `"Finish setup by creating the
  first admin account."`. Fields **Name** (`"John Doe"`), **Email** (`"owner@example.com"`),
  **Password** (`"Create a password"`), **Confirm password**. Button **"Create account"**.
- Server: `verifySelfHostedSetupAccessAction` then `runSelfHostedSetupAction`
  (`apps/start/src/lib/frontend/self-host/instance.server.ts:170-243`). The latter takes a
  Postgres advisory lock (`self_hosted_setup_claim`), calls `auth.api.signUpEmail` with header
  `x-receipt-setup-token`, marks the instance claimed with
  `signupPolicy: 'invite_only'` and `publicAppLocked: true`, signs the admin in, and the client
  hard-navigates to `/chat` (`setup-page.logic.ts:229-231`).
- Setup errors: `"The setup token is invalid."`, `"The setup token is not configured yet."`,
  `"Self-hosted setup has already been completed."`, `"Setup is only available in self-hosted
  mode."`, `"Failed to finish setup."`, `"Password must be at least 8 characters long."`.

Self-hosted signup policy is stored on a singleton `instance_settings` row
(`apps/start/src/lib/backend/self-host/instance-settings.service.ts:37, 84-98`). Values:
`invite_only` (default), `shared_secret`, `open`
(`instance-settings.service.ts:5`). The pre-signup guard enforces them
(`auth.service.ts:270-329`):

| State | Result |
|---|---|
| Setup not complete, no/bad setup token | `401 SELF_HOSTED_SETUP_REQUIRED` — `"This self-hosted instance has not been claimed yet. Complete setup first."` |
| `signupPolicy = 'open'` | signup allowed |
| `signupPolicy = 'shared_secret'`, bad/missing secret | `403 SELF_HOSTED_SIGNUP_SECRET_INVALID` — `"A valid shared signup secret is required for this instance."` |
| `signupPolicy = 'invite_only'`, no pending invitation for that email | `403 SELF_HOSTED_INVITE_ONLY` — `"This self-hosted instance currently accepts invite-only signups."` |
| missing email | `400 SELF_HOSTED_SIGNUP_EMAIL_REQUIRED` — `"A valid email address is required to sign up."` |

Secrets and tokens are compared with `timingSafeEqual`; the shared secret is scrypt-hashed
(`instance-settings.service.ts:213-231, 325-366`). Pending invitations are matched
case-insensitively and must not be expired (`instance-settings.service.ts:307-328`).
`publicAppLocked` (default `true`) forces every `(app)` route to require a non-anonymous session
(`apps/start/src/routes/(app)/_layout/route.tsx:6-28`).

**There is no UI in the app to change `signup_policy` or `public_app_locked` after setup.**
`updateSelfHostedSignupPolicy` exists (`instance-settings.service.ts:274-305`) but no route or
server function calls it. Flag this as a gap; operators would have to update the row directly.

The setup snapshot also exposes a readiness checklist rendered from environment state
(`instance.server.ts:35-105`): required = **App URL** (`BETTER_AUTH_URL`), **Auth secret**
(`BETTER_AUTH_SECRET`), **Postgres** (`ZERO_UPSTREAM_DB` | `DATABASE_URL` |
`DATABASE_PUBLIC_URL`), **Redis** (`REDIS_URL`, or `disabled` when `VITE_DISABLE_REDIS`),
**Object storage**, **Setup token** (`SELF_HOSTED_SETUP_TOKEN`); optional = **Markdown worker**,
and **PostHog / Stripe billing / Auth email / Social sign-in** all reported as
`not_available_in_self_host`.

---

## 4. Organizations vs Receipt workspaces

### 4.1 Organizations

- Created automatically at signup (§2.4), or manually from the sidebar switcher.
- **Manual creation UI**: dialog **"Create organization"**, description `"Enter a name."`,
  field label **"Organization name"**, placeholder `"Acme"`, button **"Create"**
  (`apps/start/src/components/layout/sidebar/sidebar-organization-menu.tsx:630-655`).
  On submit the client generates a slug `organization-<base36 time>-<random>` and calls
  `authClient.organization.create`, then `setActive` (`sidebar-organization-menu.tsx:325-361`).
- **Limit: 10 organizations per user.** Enforced server-side by `organizationLimit: 10`
  (`auth.service.ts:571`) and mirrored client-side by `MAX_ORGANIZATIONS_PER_USER = 10`
  (`sidebar-organization-menu.tsx:100, 303-309`). Error string: `"You can create up to {max}
  organizations."`
- Anonymous users cannot create organizations
  (`allowUserToCreateOrganization: async (user) => !user.isAnonymous`, `auth.service.ts:566`).
- Switching: the sidebar menu lists **"Organizations"**, shows `"Loading organizations..."`,
  `"No organizations found"`, `"Switching..."`, and each row shows `"1 member"` /
  `"{count} members"` (`sidebar-organization-menu.tsx:516-588`; strings
  `layout_organization_menu_*`). Switching calls `authClient.organization.setActive` and
  refetches the session.
- A second organization switcher exists on `/pricing`
  (`apps/start/src/components/pricing/pricing-org-switcher.tsx`; labels
  **"Organization"**, `"Select organization"`, `"No organizations found"`,
  `"Loading organizations..."`, `"Switching..."`).
- The active organization lives on the **session row** (`session.activeOrganizationId`). If a
  session lands without one (race against provisioning), the Zero provider repairs it by
  listing organizations and calling `setActive` on the first
  (`apps/start/src/integrations/zero/provider.tsx:138-186`).

### 4.2 Receipt workspaces

Owned by `packages/receipt-app/src/services/receipt-workspaces.ts`. Roles are
`"owner" | "admin" | "member"` (`:13`).

- **Deterministic Default workspace**: id = `ws_` + md5(organizationId)
  (`receiptDefaultWorkspaceId`, `:133-137`). Row is inserted with
  `name = 'Default'`, `slug = 'default'`, `is_default = TRUE`
  (`ensureDefaultForActor`, `:608-624`). Membership is mirrored from Better Auth: the actor's
  `member.role` is copied, collapsing anything that is not owner/admin to `member`
  (`:626-636`), and re-upserted on every call so promotions/demotions self-heal
  (`DEFAULT_WORKSPACE_MEMBER_CONFLICT_SQL`, `:118-131`).
- **The Default workspace cannot be deleted**: `assertReceiptWorkspaceDeleteAllowed` throws
  409 `"the Default workspace cannot be deleted"`; any workspace with connections throws
  `"workspace connections must be removed before deleting the workspace"` (`:92-104`).
- **Hidden global scope**: id `ws_global_<md5(orgId)>`, slug
  `receipt-system-global-<md5(orgId)>` (`:149-162`). It backs *organization-wide* integrations
  (what chat uses when no workspace is selected) and is deliberately excluded from
  `listReceiptWorkspaces` so it never appears as a pickable workspace (`:928-968`).
- Workspace state is **event-sourced** into a receipt stream
  `organizations/<orgId>/workspaces/<workspaceId>` (`receiptWorkspaceStream`, `:164-165`) and
  projected into `receipt_workspace`, `receipt_workspace_member`,
  `receipt_workspace_invitation` (`projectWorkspaceStream`, `:638-720`). Event types:
  `workspace.declared`, `workspace.renamed`, `workspace.member.declared`,
  `workspace.member.revoked`, `workspace.member.invited`,
  `workspace.member.invitation.accepted`, `workspace.member.invitation.closed`,
  `workspace.deleted` (`:56-64`).
- **Effective role**: an organization owner/admin is treated as owner/admin in *every*
  workspace, regardless of the workspace member row
  (`receiptWorkspaceEffectiveRole`, `:573-579`).
- Mutation authority: workspace owner/admin, else fall back to organization owner/admin
  (`requireReceiptWorkspaceMutationAuthority`, `:1023-1032`;
  `requireReceiptOrganizationWorkspaceAdmin` throws 403
  `"organization owner or admin permission is required"`, `:1010-1021`).
- The list query also derives `shared` (someone else has access, pending invitation counts) and
  `hasTools` (any `org_connection_secret` row on the workspace) (`:890-968`).

**Workspaces UI**: `/organization/settings/workspaces`, page title **"Workspaces"**,
description `"Isolate connected accounts, action permissions, CLI sessions, and MCP tools
inside your organization."`, primary action **"New workspace"**, search
`"Search workspaces"` (`apps/start/src/components/organization/settings/workspaces/workspaces-page.tsx:239-269`).
Dialogs: **"Create workspace"**, **"Rename workspace"**, **"Delete workspace"** and a
type-the-name confirm step `"Confirm you are deleting {name}"`. Delete copy:
`"Delete {name}? This cannot be undone. Agents using this workspace will no longer be able to
use its credentials. Connections in other workspaces are not affected."` Field label
**"Workspace name"**, max length 80 (`workspaces-page.tsx:330-372`).
Create/rename/delete require organization owner/admin at the web layer
(`requireReceiptWorkspaceAdmin`, error `"Only organization owners and admins can manage
workspaces."`, `apps/start/src/lib/frontend/receipt-connect/receipt-connect.server.ts:772-782`,
used at `:865, 889, 902`).

### 4.3 Workspace-bound token — what it is and how it is minted

Two token layers, both HMAC-SHA256 JWTs signed with `RECEIPT_CONNECT_JWT_SECRET` (falling back
to `BETTER_AUTH_SECRET`) — `packages/receipt-app/src/services/receipt-connect-auth-token.ts:126-131`.

Claims (`receipt-connect-auth-token.ts:6-17`):
`iss: "receipt"`, `aud: "receipt-connect"`, `sub` = user id, optional `sid` = Better Auth
session id, `org_id`, **`ws_id`** (defaults to the org's deterministic Default workspace id when
omitted), `scp` (scopes), `iat`, `exp`, `jti`.
Scopes: `connect:read`, `connect:write`, `connect:credential`
(`receipt-connect-auth-token.ts:19-34`). Default TTL 12 h (`:24`), minimum 60 s (`:156`).

Minting sequence for the **web app**
(`apps/start/src/lib/frontend/receipt-connect/receipt-connect.server.ts:192-243`):

1. `requireReceiptConnectWebSession()` — requires a non-anonymous Better Auth session and an
   `activeOrganizationId`. Errors: `"Sign in before connecting an integration."` and
   `"Select a workspace before connecting an integration."` (`:177-189`).
2. Mint an **organization-scoped** token with scopes `['connect:read','connect:write']` and
   **TTL 10 minutes** (`RECEIPT_CONNECT_WEB_TOKEN_SCOPES` at `:38-41`, `issueReceiptConnectWebToken`
   at `:192-205`).
3. `POST {receiptConnectRuntimeUrl()}/connect/workspaces/<workspaceId>/token` with that token
   as the bearer (`:206-215`).
4. The runtime verifies `connect:read`, checks `requireReceiptWorkspaceMembership`, and issues
   a **workspace-bound** token carrying `ws_id = workspace.id` plus the caller's scopes
   (`packages/receipt-app/src/server/receipt-connect-routes.ts:976-998`).
5. The web layer rejects the response unless the returned `workspace.id` matches what it asked
   for (`:236-241`, error `"Receipt Connect returned invalid workspace authorization."`).

For the **CLI** the same JWT is obtained through a device-code flow at
`/api/receipt-connect/cli-login`
(`apps/start/src/routes/api/receipt-connect/cli-login/route.tsx`): CLI POSTs
`{action:"start_device"}`, the human opens the approval URL carrying only the short
`user_code`, approval requires an existing Better Auth session **and** an active organization,
then the CLI polls with the device code and receives the JWT over HTTPS
(`route.tsx:262-273` docstring). Constants: TTL 10 min, poll interval 2 s, rate limit 10 starts
per 60 s per client IP, max 3 concurrent (`route.tsx:12-16`). CLI scopes are
`connect:credential`, `connect:read`, `connect:write` (`route.tsx:17-21`). Approval pages:
`"Receipt Connect is approved"` / `"You can return to the terminal. This page can be closed."`;
`"Select a workspace first"` / `"Receipt Connect credentials are stored at the workspace level.
Open Receipt, select a workspace, then run the CLI command again."`;
`"This Receipt Connect code is invalid or expired."`; `"This Receipt Connect code was already
used. Run the CLI command again."` (`route.tsx:200-255`).

---

## 5. Members, invitations, roles, permissions

### 5.1 Roles

Receipt does **not** supply a custom `ac`/`roles` config to the organization plugin, so Better
Auth's default role set applies (`node_modules/better-auth/dist/plugins/organization/access/statement.mjs`):

| Role | organization | member | invitation | team | ac |
|---|---|---|---|---|---|
| `owner` | update, delete | create, update, delete | create, cancel | create, update, delete | full |
| `admin` | update | create, update, delete | create, cancel | create, update, delete | full |
| `member` | — | — | — | — | read |

The organization creator becomes `owner` (Better Auth default `creatorRole`,
`node_modules/better-auth/dist/plugins/organization/permission.mjs:5`).

Receipt's own admin predicate treats `owner` and `admin` identically, and tolerates
comma-separated roles:
```ts
export function isAdminRole(role: string): boolean {
  return role.split(',').map(v => v.trim().toLowerCase())
    .some(v => v === 'owner' || v === 'admin')
}
```
(`apps/start/src/lib/shared/auth/roles.ts:5-10`).

Client-side gate: `useCanManageOrganizationSettings()` calls
`authClient.organization.getActiveMemberRole` and fails **closed** while the role for a newly
selected organization resolves (`apps/start/src/lib/frontend/auth/use-auth.ts:77-114`).

Route gate: `canAccessOrganizationSettingsPath({ pathname, organizationRole })`
(`apps/start/src/routes/(app)/_layout/organization/settings/-organization-settings-access.ts:9-17`):

- no role → **false**
- path is an MCP-gateway path → **true for any role, including `member`**
- otherwise → `owner` or `admin` only

`isMcpGatewayPath` matches `/organization/settings/mcp-gateway*` **and**
`/organization/settings/workspaces*`
(`apps/start/src/components/mcp-gateway/mcp-gateway-nav.config.tsx:19-23`).
So a plain member can open **Workspaces** and the **MCP Gateway**, but not Members, Billing,
Usage, BYOK, Security, Policies, etc. Confirmed by
`-organization-settings-access.test.ts:5-42`.
The layout enforcing this also redirects `/` when there is no user, an anonymous user, or no
active organization, and shows `"Checking workspace access"` while resolving
(`.../organization/settings/route.tsx:17-40`).

Server-side gates:

- `isOrgAdmin({ headers, organizationId })` → `auth.api.hasPermission({ organization: ['update'] })`,
  i.e. owner or admin (`apps/start/src/lib/backend/auth/services/organization-member-role.service.ts:6-32`).
  Used by guardrails, org skills, policies, org knowledge, Slack install, Teams install, Stripe
  checkout, workspace mutations.
- `isOrgMember({ organizationId, userId })` → direct SQL existence check (`:34-50`).
- Stripe `authorizeReference` requires `isAdminRole(role)` for both list and mutate
  (`auth.service.ts:154-171`).

### 5.2 Members page — `/organization/settings/members`

Page title **"Members"**, description `"Manage organization members, pending invitations,
permissions, and access status."`
(`apps/start/src/components/organization/settings/members/members-page.tsx:317-321`).
Table columns: **User**, **Email**, **Role**, **Status**, plus a row action menu
(`members-page.tsx:189-260`). Filter placeholder `"Filter members..."`; empty state
`"No members or pending invitations found."`; loading `"Loading members and invitations..."`
(`members-page.tsx:331-345`).

Status badges (`members-page.logic.ts:17-27, 76-100`): `active`, `pending`, `restricted`.
Tooltips: `"Invitation has not been accepted yet."` for pending; the `org_member_access`
`reasonCode` (underscores replaced by spaces) or `"Access is restricted."` for restricted.

Row actions (`members-page.tsx:88-186`):
- **"Change role"** submenu → **Admin** / **Member** only (owner is not selectable;
  `SELECTABLE_ROLES`, `members-page.tsx:74-77`). Disabled for the last owner.
- **"Remove member"** (destructive), disabled for the last owner.
- **"Cancel invitation"** on pending rows.
- The current user's own row has the menu **disabled**.
Toasts: `"Role updated."`, `"Failed to update role."`, `"Member removed."`,
`"Failed to remove member."`, `"Invitation cancelled."`, `"Failed to cancel invitation."`
(`members-page.logic.ts:252-338`).

Pending invitations are merged into page 1 of the members table and de-duplicated against
active member emails (`members-page.logic.ts:104-129, 172-195`).

### 5.3 Invite dialog

Trigger button **"Invite members"** (`invite-members-dialog.tsx:26-30`). Dialog title
**"Invite member"**, description `"Send an invitation to join this organization."`,
submit **"Send invitation"** (`invite-members-dialog.tsx:56-62`). Field label
**"Email address"**, placeholder `"colleague@example.com"`, per-row role select
(**Member** / **Admin**, default `member`), and an **"Add another"** button
(`invite-members-dialog.tsx:64-108`, `invite-members-dialog.logic.ts:10-26`).
**Batch max: 10** (`INVITE_BATCH_MAX = 10`, `invite-members-dialog.logic.ts:9`).
Invites are sent **one API call per address**, sequentially
(`invite-members-dialog.logic.ts:117-149`).

Success strings: `"Invitation sent."` / `"{n} invitations sent."` (cloud), or
`"Invitation created. Copy the signup link below."` / `"{n} invitations created. Copy the
signup links below."` (self-hosted), with a panel `"Copy these signup links and share them
directly with teammates."` listing `<origin>/auth/sign-up?invitationId=<id>`
(`invite-members-dialog.logic.ts:137-179`, `invite-members-dialog.tsx:110-124`).
Failure string: `"{n} invited; {m} failed. {first error}"` or the first error alone; empty form
gives `"Enter at least one email address."`

`requireEmailVerificationOnInvitation` is on for cloud (unless OTP is disabled) and off for
self-hosted (`auth.service.ts:574-575`).

### 5.4 Invitation email

Sent by `sendInvitationEmail` (`auth.service.ts:676-720`). Link:
`${BETTER_AUTH_URL}/auth/accept-invitation/<invitationId>` (`auth.service.ts:699`).
Subject: `"You're invited to join {organizationName}"`; title `"You're invited to
{organizationName}"`; subtitle `"{inviterName} invited you to collaborate in
{organizationName}."`; body `"Open the invitation link below to accept and access your
workspace."`; CTA **"Accept invitation"**; plain-text fallback `"Open this link to accept:
{inviteLink}"`; labels **Inviter**, **Workspace** (`apps/start/messages/en.json`,
`auth_mail_invitation_*`). Inviter label falls back to name → email → `"A team member"`; the
organization label is the *workspace* name when the invitation is workspace-scoped
(`auth.service.ts:700-705`).
Transport is chosen by `AUTH_EMAIL_PROVIDER` (`resend` | `ses` | `smtp` | `disabled`), inferred
from `RESEND_API_KEY` / SES config when unset
(`apps/start/src/lib/backend/auth/services/auth-email.service.ts:69-87`).
On self-hosted with no transport configured, no email is sent at all and the copyable link is
the only path (`auth.service.ts:686-690`).

**Invitation expiry: 48 hours.** Receipt does not set `invitationExpiresIn`, so the Better Auth
default `3600 * 48` applies
(`node_modules/better-auth/dist/plugins/organization/adapter.mjs:547`).

### 5.5 Accepting an invitation

Route `/auth/accept-invitation/$id`
(`apps/start/src/routes/auth/accept-invitation/$id/route.tsx`).

- Signed-out visitor with an **organization** invitation → redirected to
  `/auth/sign-up?redirect=/chat&invitationId=<id>`
  (`accept-invitation-page.tsx:45-64`).
- Signed-out visitor with a **workspace-only** invitation (id starts with `wsinv_`) →
  redirected to `/auth/sign-in?redirect=/auth/accept-invitation/<id>` (same block;
  `isReceiptWorkspaceInvitationId` at `apps/start/src/components/auth/workspace-invitation.ts:22-24`).
- On the sign-up form, `?invitationId=` triggers a server lookup of the invited email
  (`getInvitationEmailForAuth`, `apps/start/src/lib/frontend/auth/invitation.functions.ts:24-36`).
  The email field is then **pre-filled and read-only**, with the hint
  `"This invitation is tied to this email address."`; entering a different address gives
  `"Use the email address that received the invitation to continue."`
  (`login-form.tsx:157-161`, `sign-in-page.logic.ts:207-219`).
- After authentication the app auto-accepts the invitation, calls
  `organization.setActive`, and navigates to the workspace overview if the invitation carried a
  `workspaceId`, otherwise `/chat` (`sign-in-page.logic.ts:236-292`).
- Card UI for a signed-in invitee: title **"Organization invitation"**, subtitle `"Review this
  invitation before joining the organization in Receipt."`, label `"You have been invited to
  join"`, `"Invited by {inviter}"`, buttons **"Join organization"** and **"Decline"**
  (`"Declining…"`). Success: **"Welcome aboard!"** / `"You have successfully joined the
  organization. Redirecting to your workspace…"` then a **3-second** delay before navigation
  (`accept-invitation-page.logic.ts:157-176`). Failure: `"Invalid invitation"`,
  `"Failed to load invitation"`, `"Failed to accept invitation"`, `"Failed to reject
  invitation"`.

### 5.6 Workspace-scoped invitations (`wsinv_`)

A second invitation kind exists for sharing one Receipt workspace with an **existing
organization member**. It is not a Better Auth `invitation` row; it is a signed, self-describing
token:
`wsinv_<base64url(JSON{version,organizationId,workspaceId,nonce,expiresAt})>.<HMAC-SHA256 base64url>`
signed with `BETTER_AUTH_SECRET`, **TTL 48 hours**
(`apps/start/src/lib/backend/auth/services/workspace-invitation-token.service.ts:3-45`).
Errors: `"Invalid workspace invitation."`, `"This workspace invitation has expired."`,
`"BETTER_AUTH_SECRET is required for workspace invitations."`
`prepareReceiptWorkspaceInvitationAction` returns `new_user` when the email is not already an
organization member (so the caller must invite them to the organization first), or
`already_has_access` (`receipt-connect.server.ts:966-1019`). Link form:
`${BETTER_AUTH_URL}/auth/accept-invitation/<token>`.

### 5.7 Seat limits and what happens when seats run out

- Better Auth `membershipLimit` is wired to the org's entitlement seat count
  (`auth.service.ts:572-573` → `getOrganizationSeatLimit`,
  `apps/start/src/lib/backend/billing/integrations/auth-billing-hooks.ts:63-71`).
- `beforeCreateInvitation` calls `assertInvitationCapacity`, which counts
  **active members + pending invitations + the new invite** against `seatCount`
  (floored at 1, defaulting to `DEFAULT_FREE_SEAT_COUNT = 5`)
  (`auth.service.ts:642-661`, `auth-billing-hooks.ts:73-105`).
- On overflow the invite fails with HTTP **403** and the message
  **`"Only {n} users can access this workspace."`** (singular `user` when n = 1)
  (`apps/start/src/lib/backend/billing/domain/seat-limit-message.ts:6-8`,
  `apps/start/src/lib/backend/billing/domain/api-errors.ts:11-18`). The invite dialog surfaces
  this per-address.
- Free-tier default seat count is **5** (`workspace-usage/shared.ts:20`) even though the plan
  catalog lists `includedSeats: 1` for Free — see §11.
- Over-limit organizations are flagged `is_over_seat_limit` on the entitlement snapshot
  (`default-organization.service.ts:239-241`). UI strings:
  `"Seat allocation" / "{activeMembers} of {seatCount} seats"`,
  `"Over seat limit"`, `"No paid seat assigned"`, and
  `"This member is outside the workspace's paid seat capacity. Upgrade seats or remove members
  to restore paid usage."`; on seat downsizing: `"You selected {selectedSeats} seats for
  {activeMembers} active members. Everyone keeps access until period end, and extra members
  will be auto-restricted after renewal."` (`apps/start/messages/en.json`, `org_billing_*`).
- Every membership/invitation lifecycle hook recomputes the entitlement snapshot
  (`auth.service.ts:638-675`).

---

## 6. Account settings — `/settings`

Guarded: signed-out or anonymous users are redirected to `/chat`; shows `"Loading settings"`
while resolving (`apps/start/src/routes/(app)/_layout/settings/route.tsx:9-23`).
Sub-nav (`.../settings/-settings-nav.ts:12-31`): section title **"Settings"**, description
`"Manage your account and preferences."`, items **Account** (`/settings`) and **Security**
(`/settings/security`).

### 6.1 Account (`/settings`)

Page title **"Account"**, description `"Manage your account details and avatar."`
(`apps/start/src/components/settings/account/account-page.tsx:64-65`). Sections:

- **Avatar** — `"This is your avatar. Click on the avatar to upload a custom image."`,
  help `"An avatar is optional but strongly recommended."`, success `"Avatar saved."`.
  Accepts JPG, PNG, WEBP, SVG; errors `"Please upload a JPG, PNG, WEBP, or SVG image."` and
  `"File exceeds limit of {maxSizeMb}MB."`
- **Display Name** — `"Please enter your full name, or a display name you are comfortable
  with."`, help `"Please use 32 characters at maximum."`, placeholder `"e.g. Ari Say"`,
  button **Save**, success `"Display name saved."`
- **Email** — `"This is your account email address."`, help `"Use a valid address you can
  access to complete secure verification."`, placeholder `"you@example.com"`. Success:
  `"Email change request submitted. Check your inbox to finish verification."` Errors:
  `"Email cannot be empty."`, `"Please enter a different email address."`,
  `"Unable to request email change."` **Email change is disabled entirely in self-hosted mode**
  (`auth.service.ts:517-519`).
- **Language** — `"Choose your preferred interface language."`, help `"You can change this at
  any time."`, error `"Unable to update language."` (backed by the `preferredLocale` additional
  user field, `auth.service.ts:511-516`; catalogs `en`, `es`, `he` in `apps/start/messages/`).

Sign-out strings exist (`"Logout"`, `"Sign out"`, `"Sign out from your current session on this
device."`, `"You can sign back in anytime using your account credentials."`, `"Unable to sign
out. Please try again."`) and the sidebar workspace menu renders the **Sign out** entry
(`sidebar-organization-menu.tsx:620`).

### 6.2 Security (`/settings/security`)

Page title **"Security"**, description `"Manage your account password and session security."`
(`apps/start/src/components/settings/security/security-page.tsx:66-70`). Three sections, in
order:

1. **Connected login methods** — `"Review connected sign-in providers and unlink methods you no
   longer use."` List with **Unlink** (`"Unlinking..."`). Provider labels rendered:
   `Email & password`, `Guest`, `Google`, `GitHub`, `GitLab`, `Bitbucket`, `Apple`,
   `Microsoft`, `Unknown provider`, plus a `Passkeys` row (`"0 passkeys registered"`).
   Guard: `"You must keep at least one login method connected."`
   (`connected-login-methods.logic.ts:169-172`). Success `"Login method unlinked."`
   **The "Connect"/"Add" action is implemented in the logic hook (`connectLoginProvider`,
   `connected-login-methods.logic.ts:217-260`) but is not wired to any button in
   `connected-login-methods.tsx`** — there is no way to link a social provider from the UI.
2. **Change password** / **Set password** — the form switches to "set" mode for accounts with no
   credential password (`"Set password"`, `"Add a password so you can sign in with email and
   password in addition to social login."`, help `"After setting a password, you can sign in
   with either social login or email and password."`). Normal mode: `"Change password"` /
   `"Enter your current password and choose a new one."`, fields **New password**,
   **Confirm new password**, **Current password** (the latter two reveal only once the new
   password field has content, `security-page.tsx:57-59`), button **"Update password"**, help
   `"You will be signed out from other sessions after changing your password."`
   Errors: `"Current password is incorrect."`, `"New password and confirmation do not match."`,
   `"New password must be different from your current password."`, `"Unable to update
   password."`
3. **Active sessions** — `"Review where your account is signed in and revoke sessions you do not
   recognize."` Shows device / `"Unknown device"`, `"IP address"` / `"Unknown"`. Button
   **"Revoke other sessions"** (danger), help `"Revoke old or unrecognized sessions to keep
   your account secure."` Empty states `"No active sessions were found."`,
   `"No other active sessions to revoke."` Success `"Session revoked."`,
   `"Other sessions revoked."`

**There is no 2FA enrollment UI.** The `twoFactor` plugin is configured server-side
(`auth.service.ts:765-778`), the sign-in flow can complete a TOTP challenge
(`sign-in-page.logic.ts:592-618`), and all the strings exist
(`settings_security_mfa_*`: `"Two-factor authentication"`, `"Set up authenticator"`,
`"Disable authenticator"`, `"Backup codes"`, `"Scan this QR code in your authenticator app…"`)
— but `grep twoFactor` across `apps/start/src/components` returns only the sign-in verify call.
So **users cannot turn 2FA on from the product today.** Flag this prominently; do not document
2FA setup as an available feature.

**There is no API-key page.** `grep` finds no personal API key surface under `/settings`.
"Keys" in the product means **BYOK provider keys**, which live at
`/organization/settings/byok` (org-scoped, owner/admin only) with description
`"Optional: use your organization's encrypted provider keys instead of platform credit (Bring
Your Own Key)."`

---

## 7. Organization settings — nav and the Security page

### 7.1 Nav labels (exact)

From `apps/start/src/routes/(app)/_layout/organization/settings/-organization-settings-nav.ts:145-302`.
Base path `/organization/settings`.

| Key | Label | Href | Where it appears |
|---|---|---|---|
| `organization-general` | **Organization** (`layout_organization_tooltip_name`) | `/organization/settings` (exact) | switcher menu only; description `"Manage organization-wide controls and preferences."` |
| `organization-mcp-gateway` | **MCP Gateway** | `/organization/settings/mcp-gateway` | route only (own rail area owns the icon) |
| `organization-integrations` | **Integrations** | `/organization/settings/integrations` | rail |
| `organization-workspaces` | **Workspaces** | `/organization/settings/workspaces` | switcher menu |
| `organization-byok` | **BYOK** | `/organization/settings/byok` | rail |
| `organization-knowledge-graph` | **Org Brain** | `/organization/settings/knowledge-graph` | rail |
| `organization-skills` | **Skills** | `/organization/settings/skills` | rail |
| `organization-guardrails` | **Guardrails** | `/organization/settings/guardrails` | rail |
| `organization-policies` | **Policies** | `/organization/settings/policies` | rail |
| `organization-usage` | **Usage** | `/organization/settings/usage` | rail, utility group |
| `organization-billing` | **Billing** | `/organization/settings/billing` | rail, utility group |
| `organization-analytics` | **Analytics & Insights** | `/organization/settings/analytics` | route only |
| `organization-members` | **Members** | `/organization/settings/members` | switcher menu |
| `organization-models` | **Models** | `/organization/settings/models` | route only |
| `organization-knowledge` | **Knowledge** | `/organization/settings/knowledge` | route only |
| `organization-security` | **Security** | `/organization/settings/security` | route only (reachable by URL, not linked) |

Additional routes that exist but carry no nav entry: `compliance-policy`
(**"Compliance & Policy"**), `provider-policy` (**"Provider policy"**), `tools`.
Nav section headings defined but only used by grouped panels: `"AI & Data"`,
`"Security & Access"` (`org_settings_nav_section_*`).

The workspace-switcher dropdown shows **Account** first, then the org-menu items above, but the
org items are only included when `canManageOrganizationSettings` is true
(`sidebar-organization-menu.tsx:56-64`).

MCP Gateway sub-nav inside a workspace: **All workspaces**, plus the workspace's own dashboard,
overview, connections, activity, settings
(`apps/start/src/components/mcp-gateway/mcp-gateway-nav.config.tsx:26-60+`,
route constants at `-organization-settings-nav.ts:72-98`).

### 7.2 Organization Security page — `/organization/settings/security`

Title **"Security"**, description `"Configure organization-level security and access
controls."` (`apps/start/src/components/organization/settings/security/security-page.tsx:20-23`).
If no organization is active, the route instead renders `"Switch to an organization to manage
organization-level security settings."` + `"Select an organization in the sidebar or switch
context to manage policies."` (`.../security/route.tsx:20-30`).

Three sections, **all placeholders**:

| Section | Description | Empty state | Button |
|---|---|---|---|
| **Domains** | `"Verify ownership of your email domain to enable Single Sign-On."` | `"You haven't added any verified domains yet."` | **Add domain** |
| **Single Sign-On** | `"Require all team members to authenticate via your identity provider."` | `"You haven't set up Single Sign-On yet."` | **Set up SSO** |
| **Directory Provisioning** | `"Automatically provision and deprovision accounts via your identity provider."` | `"You haven't set up a directory yet."` | **Set up directory** |

Every button is `buttonDisabled` and every action href is `'#'`
(`security-page.tsx:10-12, 33, 55, 76`). Default help text is
`"This feature will be available soon for self serve."` Related strings:
`"Organization security settings are coming soon."`,
`"This feature is only available via Add-on or Enterprise plan."`,
`"Your email domain must be verified to set up Single Sign-On."`

**Document SSO / SAML / SCIM as not implemented.** There is no SSO plugin in the Better Auth
config and no directory-sync code path.

---

## 8. Enterprise admin surface — `/singularity`

Location: `apps/start/src/routes/(ee)/singularity/**`, implementation
`apps/start/src/ee/singularity/**`. Licensed separately: `apps/start/src/ee/LICENSE.md` is
"The Receipt Enterprise License" (© 2025 The Unreal Compound SA de CV), production use requires
a written commercial agreement.

### 8.1 Who can access it

Access is granted **only when the caller's active organization id equals one specific hardcoded
organization id** (`isSingularityOrganizationId`,
`apps/start/src/ee/singularity/shared/singularity.ts:1-7`). It is not a role, not a flag, not an
env var — it is a single literal constant compiled into the app.

Server guard `requireSingularityAdminAuth`
(`apps/start/src/ee/singularity/backend/auth/singularity-auth.server.ts:20-58`), in order:

1. Signed-in and **not anonymous** → else `"You must be signed in to access Singularity."`
2. `session.activeOrganizationId` present → else `"Select the Singularity workspace before
   opening this page."`
3. Active organization **is** the Singularity organization → else `"This workspace does not have
   access to the Singularity."`
4. Still an actual member of it (`isOrgMember`) → else `"Your Singularity membership is no
   longer active."`

Route guard: `beforeLoad` calls `assertSingularityAccess()` and **redirects to `/` on any access
error** — never shows an error page (`routes/(ee)/singularity/_layout/route.tsx:7-16`, and the
same pattern on both child routes). The sidebar icon is hidden unless the active organization is
the Singularity org (`apps/start/src/components/layout/app-sidebar.tsx:131, 199`).

Nav: area title **"Singularity"**, rail label **"Admin"** (the config file itself notes
"Singularity" is an internal codename), description `"Enterprise admin control plane"`, shield
icon, single child item **"Organizations"**
(`apps/start/src/ee/singularity/components/singularity-nav.config.ts:10-31`).

### 8.2 What it shows

**`/singularity` — organization list** (`singularity-org-list-page.tsx`): a table of *every*
organization on the instance. Sortable columns **Organization**, **Plan**, **Status**, **Seats**;
badges **"Over limit"** and **"Quota sync"** (degraded); row action **"Open profile"**. Filter
`"Filter organizations..."` also matches the organization id even though the id column is
hidden (`singularity-org-list-page.tsx:53-62`). Page size 50. Empty states
`"No organizations found."` / `"No organizations match the current filter."`

**`/singularity/orgs/$organizationId` — organization profile**
(`singularity-org-detail-page.tsx`): page title **"Workspace summary"**. Metric tiles:
**Members**, **Pending invites**, **Seats** (`m/n`), **Plan**, **Billing**, **Usage cap**,
**AI spend this month**, **AI spend all time**, **Billing period**, **Subscription source**,
**Subscribed since** (`:832-892`). Buttons **"Copy slug"** and **"Copy org ID"**.
Below: a member/invitation table with **"Filter members..."**, a **Change role** submenu, and an
**"Invite member"** dialog (**"Email address"**, an **"Invite role"** select).
Side panel **"Plan Override"** — `"Configure manual subscriptions, usage caps, and feature access
for workspaces billed outside Stripe."` with **Current source**, **Current cap**, **Quota sync**
(`Healthy` / `Needs attention`), **Override notes**, and inputs **Override plan**,
**Billing interval**, **Override seats**, **Billing reference**, **Override reason**,
**Internal note**, **Feature access overrides**.

Server functions available (`apps/start/src/ee/singularity/frontend/singularity.functions.ts`):
`assertSingularityAccess`, `listSingularityOrganizations`,
`getSingularityOrganizationProfile`, `inviteSingularityOrganizationMember`,
`removeSingularityOrganizationMember`, `updateSingularityOrganizationMemberRole`,
`cancelSingularityInvitation`, `setSingularityOrganizationPlan`.
Validation: invite/update roles restricted to `admin` | `member`; plan override requires a
`billingInterval` for any non-free plan; `seatCount ≥ 1`;
`monthlyUsageLimitUsd` 0–1,000,000; `overrideReason` ≤ 500, `internalNote` ≤ 2000,
`billingReference` ≤ 255 chars (`singularity.functions.ts:20-58`).

**This surface is Kentron-operator tooling.** It should be described in public docs, if at all,
only as "an enterprise admin control plane exists in the `ee` tree under a commercial license" —
and the specific gating organization id must never be published.

---

## 9. Pricing, plans, and what is actually gated

### 9.1 Plan catalog (canonical, used by billing)

`apps/start/src/lib/shared/access-control/index.ts:89-146`:

| id | name | description | includedSeats | monthly USD | Stripe price env |
|---|---|---|---|---|---|
| `free` | **Free** | "Core workspace access for one member." | 1 | 0 | — |
| `plus` | **Plus** | "Expanded model access and workspace controls." | 1 | 8 | `STRIPE_PRICE_PLUS_MONTHLY` |
| `pro` | **Pro** | "Higher-capacity workspaces with advanced controls." | 1 | 50 | `STRIPE_PRICE_PRO_MONTHLY` |
| `scale` | **Scale** | "Operational scale with advanced identity and access controls." | 1 | 100 | `STRIPE_PRICE_SCALE_MONTHLY` |
| `enterprise` | **Enterprise** | "Custom contracts, provisioning, and security controls." | 1 | 0 (custom) | — |
| `self_hosted` | **Self-Hosted** | "Unlimited self-managed deployment with cloud-only controls disabled." | 100000 | 0 | — |

Stripe-managed plans are exactly `plus`, `pro`, `scale`
(`isStripeManagedWorkspacePlan`, `:193-201`); Enterprise and Self-Hosted are manual.
`self_hosted` is only a valid plan id when the instance is self-hosted (`:203-210`).

### 9.2 Marketing catalog (`/pricing` and landing)

`apps/start/src/lib/shared/pricing.ts` (separate from the billing catalog):

- **Free** $0/mo — `"Try Receipt with the essentials for everyday AI tasks."` — "A small
  monthly message allowance", "Core model access", "Community support". CTA **"Get started"**.
- **Plus** $8/mo — `"For people who want the full Receipt experience at personal scale."` —
  "Increase usage limits", "Full model access", "Unlimited chat history", "Team management",
  "BYOK", "Fine-grained organization policies", "ZDR". CTA **"Get started"**.
- **Pro** $50/mo (**Most Popular**) — `"For heavier workloads that need more capacity and
  faster support."` — "5x more monthly usage", "Priority support". CTA **"Get Pro"**.
- **Scale** $100/mo — `"For operators and larger teams that need headroom for broad
  adoption."` — "10x more monthly usage", "Built for larger team rollouts". CTA
  **"Get Scale"**.
- **Enterprise** custom — SSO, Directory Sync/SIEM/Audit logs, Usage Analytics, Uptime SLA,
  custom model catalog. CTA **"Contact Sales"** (href `'#'`).
- **On-Premise Deployment** custom — on-prem/private cloud, air-gapped, volume licensing,
  technical onboarding. CTA **"Get in Touch"** (href `'#'`).

Section heading **"Simple, Transparent Plans"**, summary `"Choose the plan that best fits your
needs. No hidden costs."` Badges **"Most Popular"**, **"Current"**. Period label `"mo"`.
Comparison table rows include Model access, Monthly limits, Chat history, File storage,
Team management, BYOK, Fine-grained organization policies, ZDR (AI providers), Usage Analytics,
SSO, Directory Sync, SIEM, Audit logs, Priority support, Technical onboarding, Deployment, and
two "(Coming soon)" rows: `"Memory & projects (Coming soon)"` and
`"Access on iOS, Android (Coming soon)"`.

### 9.3 Signed-out checkout flow

Clicking a paid plan while signed out opens the seat dialog; confirming navigates to
`/auth/sign-up?redirect=/pricing?checkoutPlan=<plan>&checkoutSeats=<n>&resumeCheckout=1`, and
after signup the pricing page auto-resumes the Stripe checkout
(`apps/start/src/components/pricing/pricing-page.tsx:144-183, 313-325`). The Free card links to
`/chat` for signed-in users on Free and is disabled for users on a paid plan (`:206-220`).
Search params are validated: `checkoutPlan ∈ {plus,pro,scale}`, `checkoutSeats` 1–500,
`resumeCheckout = '1'` (`routes/pricing/route.tsx:12-16`).
Non-admins see the plan buttons disabled plus `"Only workspace owners and admins can change
plans, seats, or billing details."`

### 9.4 What is actually gated today — **almost nothing**

This is the single most important correction a docs writer needs:

```ts
export function getPlanEffectiveFeatures(_planId) {            // :319
  return Object.fromEntries(WORKSPACE_FEATURE_IDS.map(f => [f, true]))
}
export function getFeatureAccessState(input) { ... allowed: true ... }  // :354-368
export function hasFeatureAccess(_feature, _context) { return true }    // :398-403
export function isFreeTierContext(_context) { return false }            // :405-407
export function getModelAccess(input) { ... visible: true, allowed: true } // :413-425
```
(`apps/start/src/lib/shared/access-control/index.ts`; the code comment at `:409-411` says
"The current no-paywall contract keeps every catalog model selectable.")

So the feature matrix (`ORG_FEATURE_MINIMUM_PLANS` at `:158-168`: `byok`/`providerPolicy`/
`compliancePolicy`/`toolPolicy` → Plus, `verifiedDomains` → Pro, `singleSignOn`/
`directoryProvisioning` → Enterprise; `RUNTIME_FEATURE_MINIMUM_PLANS` at `:175-181`:
`chat.fileUpload`/`chat.paidModels` → Plus) is **advisory metadata for UI copy only**. It
records the minimum plan for the upgrade CTA, but `allowed` is unconditionally `true`.

What *is* enforced:

- **Seat count** on invitations (§5.7).
- **Usage / platform credit**: a metered budget per plan cycle, plus the one-time $5 signup
  credit for cloud orgs (`workspace-usage/shared.ts:180-260`). Free-plan orgs are not
  usage-plan-eligible (`isUsagePlanEligible` excludes `free`, `shared.ts:159-161`), so free
  usage runs off the platform credit policy (`buildPlatformCreditUsagePolicy`, `:187-201`).
- **Role**, everywhere (owner/admin vs member).
- Rate limits on chat: `RATE_LIMIT_WINDOW_MS = 60_000`, `RATE_LIMIT_MAX_REQUESTS = 30`,
  `RESERVATION_TTL_MS = 15 min` (`shared.ts:14-18`).

Upgrade CTAs point at `/pricing`; Enterprise CTAs point at `'#'`
(`BILLING_SETTINGS_HREF` / `ENTERPRISE_CONTACT_HREF`, `access-control/index.ts:170-171`).
Denied-feature message template: `"This feature is available on the {Plan} plan and above."` /
`"This feature is available on the Enterprise plan. Contact us to enable it."` (`:309-317`) —
these are currently unreachable given `allowed: true`.

---

## 10. Sessions, cookies, and the `BETTER_AUTH_*` env vars

### 10.1 Session lifetime

`betterAuth(...)` has **no `session` block** (verified across
`auth.service.ts:446-793`), so Better Auth defaults apply
(`node_modules/better-auth/dist/context/create-context.mjs:142-146`):

- `expiresIn`: **7 days** (`3600 * 24 * 7`)
- `updateAge`: **1 day** (`1440 * 60`) — sliding refresh
- `freshAge`: **1 day** (`3600 * 24`)
- cookie cache: off

Related explicit settings:
- `multiSession maximumSessions: 10` (`auth.service.ts:763`)
- 2FA challenge cookie: **10 minutes** (`twoFactorCookieMaxAge: 10 * 60`, `:776`)
- "trust this device": **30 days** (`trustDeviceMaxAge: 30 * 24 * 60 * 60`, `:777`)
- Password reset revokes all sessions (`revokeSessionsOnPasswordReset: true`, `:527`)

The local dev-only shortcut route also uses a 7-day session and writes the cookie
`better-auth.session_token` (`apps/start/src/routes/api/dev/session-login/route.tsx:4-5, 205`);
that route is 404 unless `import.meta.env.DEV` **and** the host is `localhost`/`127.0.0.1`/`::1`
(`:32-34, 196-199`).

### 10.2 Cookies

`advanced` block (`auth.service.ts:781-789`):
- `useSecureCookies` — `BETTER_AUTH_USE_SECURE_COOKIES` accepts `true|1|false|0`; when unset it
  follows the **protocol of `BETTER_AUTH_URL`** (https ⇒ secure). The comment explains why:
  AWS bootstrap deployments behind an HTTP-only ALB would otherwise silently drop the session
  cookie and browser signup would look broken (`auth.service.ts:110-124`).
- `crossSubDomainCookies` — **always `{ enabled: true }`**; a `domain` is added only when
  `BETTER_AUTH_COOKIE_DOMAIN` is set. Note the enabled-without-domain default.

### 10.3 `BETTER_AUTH_*` env vars actually read by code

| Var | Read at | Behaviour |
|---|---|---|
| `BETTER_AUTH_SECRET` | `auth.service.ts:450` (`requireEnv`) | **Required** — process throws `Missing required environment variable BETTER_AUTH_SECRET.` Also signs: workspace invitation tokens (`workspace-invitation-token.service.ts:15-17`), the Zero self-hosted token (`zero-self-hosted-token.service.ts`), signed proxy file URLs (`upload.service.ts`), and is the fallback Receipt Connect JWT secret (`receipt-connect-auth-token.ts:126-131`). |
| `BETTER_AUTH_URL` | `auth.service.ts:96-108` | **Required** — throws `Missing BETTER_AUTH_URL. Configure apps/start/.env before starting auth.` Trailing slashes stripped. Must be an exact origin (no path/query/fragment/credentials) or `resolveTrustedOrigins` throws (`auth-trusted-origins.ts:46-68`). Also the base for invite links, CLI login origin, metadata, file proxy URLs. |
| `VITE_BETTER_AUTH_URL` | `auth-client.ts:16-25`, `auth-shared.ts:29` | Browser-side base URL; validated by `auth-client-base-url.ts` (must be absolute http/https; a retired CloudFront host is explicitly rejected). |
| `BETTER_AUTH_COOKIE_DOMAIN` | `auth.service.ts:783-788` | Optional; sets the cross-subdomain cookie domain. |
| `BETTER_AUTH_USE_SECURE_COOKIES` | `auth.service.ts:111-113` | Optional override, `true|1|false|0`. |
| `RECEIPT_LEGACY_PUBLIC_ORIGINS` | `auth.service.ts:452-455` → `auth-trusted-origins.ts:9-44` | Optional comma-separated extra trusted origins. Each must be **HTTPS**, an exact origin, no credentials, no wildcard hosts. Errors are prefixed `Invalid RECEIPT_LEGACY_PUBLIC_ORIGINS: …`. |

Other auth-adjacent vars actually read: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
(`auth.service.ts:90-91`); `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
(`auth.service.ts:127-128`); `STRIPE_PRICE_{PLUS,PRO,SCALE}_MONTHLY`
(`access-control/index.ts:212-234`); `SELF_HOSTED_SETUP_TOKEN`
(`instance-settings.service.ts:213-217`); `AUTH_EMAIL_PROVIDER`, `AUTH_EMAIL_FROM`,
`RESEND_API_KEY`, `RESEND_FROM_EMAIL`, `SES_FROM_EMAIL`, `SES_REGION`, `AWS_REGION`,
`SES_CONFIGURATION_SET`, `SST_RESOURCE_AuthEmail`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`,
`SMTP_USER`, `SMTP_PASS`, `SMTP_FROM_EMAIL`
(`auth-email.service.ts:21-104`); `RECEIPT_CONNECT_JWT_SECRET`
(`receipt-connect-auth-token.ts:127`); `VITE_APP_INSTANCE_MODE`, `VITE_SELF_HOST_SOURCE`,
`VITE_DISABLE_EMAIL_VERIFICATION_OTP`, `VITE_REQUIRE_SIGNUP_EMAIL_OTP`
(`app-feature-flags.ts`); `START_ALL_USE_SIGNUP_EMAIL_OTP` (`scripts/start-all.mjs:114`).

---

## 11. Where repo markdown / config disagrees with the code

1. **`apps/start/.env.example:47-48` still advertises `AUTH_DEV_EMAIL_OTP_TO_CONSOLE`** ("set to
   1 to print OTPs on the server console"). A repo-wide grep finds it in **no source file**.
   `LOCAL_SETUP.md:1064-1065` already records that it is unimplemented, but the example env file
   was never corrected. Do not document this variable.
2. **Free plan seat count: catalog says 1, enforcement says 5.**
   `access-control/index.ts:90-95` sets `includedSeats: 1` with the copy "Core workspace access
   for one member", while `DEFAULT_FREE_SEAT_COUNT = 5`
   (`workspace-usage/shared.ts:20`) is what is written to `org_subscription.seat_count` and what
   invitation capacity is checked against (`default-organization.service.ts:100-104`,
   `auth-billing-hooks.ts:73-105`).
3. **`README.md:33` claims "Team management via organizations, members, invitations, and
   role-based settings"** — true, but `README.md:55` ("Better Auth for auth, organizations,
   invitations, and roles") understates that email OTP, Google OAuth, anonymous sessions and
   Stripe are all cloud-only and that the sign-in UI ships email+password only.
4. **Landing page brands the product "beetle" / "beetle.run"** (`landing-page.tsx:790-793,
   1975-1985`, `navbar.tsx:42`) and the auth screen logo `alt` is `"beetle.run"`
   (`login-header.tsx:24-30`), while `betterAuth.appName` is `'Receipt'`
   (`auth.service.ts:447`), the 2FA issuer is `'Receipt'` (`:766`), user-facing copy says
   "Receipt" (e.g. `"Try Receipt with the essentials…"`, `"Review this invitation before joining
   the organization in Receipt."`), and the hosted product is at `app.kentron.ai`. Three names
   for one product; the docs need an explicit decision here.
5. **`apps/start/src/lib/shared/pricing.ts:59` doc comment says "Free, $7.99, $50, $100"** but
   the Plus `priceAmount` is `8`.
6. **`.env.self-host.example` omits `BETTER_AUTH_COOKIE_DOMAIN`, `BETTER_AUTH_USE_SECURE_COOKIES`
   and `RECEIPT_LEGACY_PUBLIC_ORIGINS`**, all of which the code reads and any real self-hosted
   deployment behind a domain will need.
7. **Marketing promises features the code does not gate or implement**: `/pricing` lists SSO,
   Directory Sync, SIEM, Audit logs, ZDR and Usage Analytics per plan, but
   `getFeatureAccessState` returns `allowed: true` for everything (§9.4) and the Organization
   Security page's Domains/SSO/Directory sections are disabled placeholders pointing at `'#'`
   (§7.2).
8. **`settings_security_login_methods_passkeys_title` ("Passkeys", "0 passkeys registered")**
   exists with no passkey plugin, and the Google/GitHub/Microsoft sign-in strings exist with no
   buttons. Copy that ships in the bundle but is unreachable.
9. **2FA**: fully configured server-side and fully string-ready in the UI catalog, but no
   enrollment surface exists (§6.2).
10. **`updateSelfHostedSignupPolicy`** is implemented but has no caller — self-hosted operators
    cannot change `signup_policy` / `public_app_locked` from the product after setup (§3.2).

---

## 12. Open questions a human must answer

1. **Brand.** Is the public product "Receipt", "Beetle / beetle.run", or "Kentron"? The code
   uses all three in user-visible places.
2. **Are Google OAuth, anonymous/guest sessions, and 2FA meant to be user-visible?** Each is
   configured but has no UI. Should docs describe them as roadmap, or omit them?
3. **Is the "no-paywall contract" (`allowed: true` everywhere) intentional and current?** If so,
   the pricing page's feature-by-plan matrix is aspirational and the docs must say what actually
   differs between plans (seats, usage budget, support).
4. **What is the Free plan's real seat allowance — 1 or 5?**
5. **What are the actual monthly usage limits per plan?** The code derives budgets from
   `monthlyPriceUsd` and `WORKSPACE_USAGE_*_TARGET_MARGIN_PERCENT` env vars
   (`workspace-usage/shared.ts:69-137`), which are deployment-specific. The "5x"/"10x" numbers on
   the pricing page are not derivable from the repo.
6. **Is `/singularity` ever exposed to customers**, or purely Kentron operations? The `ee`
   license implies it can be licensed to enterprises, but the gate is a hardcoded org id.
7. **How is a self-hosted operator expected to change the signup policy after setup?**
8. **Is the SSO/SAML/SCIM roadmap firm enough to document as "coming soon"?**
9. **Enterprise / On-Premise CTAs both point at `'#'`.** What is the real contact route?
10. **Is `/organization/settings/security` intentionally unlinked from every nav?** It is
    reachable only by typing the URL.
11. **What is the intended lifetime of the Better Auth session?** It is currently the library
    default (7 days) because no `session` block is configured — deliberate or an oversight?

---

## Suggested doc pages

| Slug | Title | Audience | Purpose |
|---|---|---|---|
| `getting-started/sign-up` | Create your account | user | Walk a new visitor from the landing page through sign-up, email verification, and the first chat screen, with the exact on-screen labels. |
| `platform/sign-in-and-recovery` | Signing in and recovering access | user | Explain email+password sign-in, the two-step verification prompt, and the OTP-based password reset. |
| `platform/organizations` | Organizations | user | Explain what an organization is, how it is auto-created, how to create and switch between up to ten, and what the switcher menu contains. |
| `platform/workspaces` | Workspaces | both | Explain Receipt workspaces as the credential boundary, the undeletable Default workspace, the hidden organization-wide scope, and creating/renaming/deleting workspaces. |
| `platform/members-and-roles` | Members, roles, and permissions | user | Document Owner/Admin/Member, exactly which settings each can reach, and the role-change and removal rules. |
| `platform/invitations` | Inviting people | user | Cover the invite dialog, the 10-per-batch limit, the 48-hour expiry, the invitation email, accepting/declining, and the self-hosted copy-link path. |
| `platform/seats-and-limits` | Seats and seat limits | both | Explain seat counting (members + pending invites), the exact over-limit error, and what happens to over-seat members. |
| `account/profile` | Account settings | user | Avatar, display name, email change (and why it is unavailable self-hosted), and interface language. |
| `account/security` | Account security | user | Connected login methods, changing or setting a password, and reviewing/revoking active sessions. |
| `organization/settings-overview` | Organization settings | user | Map every organization settings destination to its label, path, and required role. |
| `organization/security` | Organization security | user | State plainly that Domains, SSO, and Directory Provisioning are placeholders today. |
| `pricing/plans` | Plans and pricing | user | Free/Plus/Pro/Scale/Enterprise/On-Premise, the $5 signup credit, and what actually differs between plans. |
| `pricing/upgrade-flow` | Upgrading and billing | user | The seat dialog, Stripe checkout, the signed-out resume flow, proration/downgrade timing, and the admin-only restriction. |
| `self-hosting/first-run-setup` | Claiming a self-hosted instance | developer | The `/setup` two-step wizard, `SELF_HOSTED_SETUP_TOKEN`, and the readiness checklist. |
| `self-hosting/signup-policies` | Controlling who can sign up | developer | `invite_only` / `shared_secret` / `open`, `publicAppLocked`, and the exact refusal messages. |
| `self-hosting/cloud-vs-self-hosted` | Cloud vs self-hosted differences | both | The full behaviour table for `VITE_APP_INSTANCE_MODE`. |
| `reference/auth-environment-variables` | Auth environment variables | developer | Every `BETTER_AUTH_*`, email-provider, OAuth, Stripe and instance-mode variable the code reads, with required/optional and validation rules. |
| `developers/auth-architecture` | How authentication works | developer | Better Auth plugin set, the signup hooks (default organization, billing baseline, credit grant), session shape, and the guard middleware. |
| `developers/workspace-tokens` | Workspace-bound tokens | developer | The two-step JWT mint, claims, scopes, TTLs, and the CLI device-code login. |
| `developers/local-development-auth` | Local development sign-in | developer | Skipping the signup OTP in dev, the OTP env flags, and the localhost-only dev session-login route. |
