# KENTRON CORE, part 1: identity and tenancy, configuration, local development, deployment and self-hosting

Research report for the public documentation site. Repository: `Receipt` monorepo at git `c3c16be6` on `main` (root `package.json` version `1.2.0`). Every path below is relative to the repo root; every claim is verified against source at HEAD and cited `path:line`. The prior corpus (`doc/research/01`, `08`, `09`, written at `41baea75`) was used only as a map; its citations were re-checked and are corrected where they drifted.

Working-copy note: `LOCAL_SETUP.md` is cited at the repository root, its location at `c3c16be6`; during this research an uncommitted move to `docs/LOCAL_SETUP.md` appeared in the working tree (not made by this report's author). Citations follow HEAD.

Feature classification used throughout: **reachable** (implemented and linked from the UI/CLI), **hidden** (implemented, direct URL or API only), **stubbed** (UI or strings exist but nothing executes or enforces), **absent**.

---

## 1. Identity: the Better Auth configuration

There is exactly one `betterAuth(...)` call in the monorepo, `apps/start/src/lib/backend/auth/services/auth.service.ts:446`, mounted at `/api/auth/*` (`basePath: '/api/auth'`, `auth.service.ts:449`). Library versions: `better-auth ^1.5.2`, `@better-auth/core 1.5.2`, `@better-auth/stripe ^1.5.4`, `@better-auth/cli ^1.4.21` (`apps/start/package.json`). The same module is imported by the migration CLI so the runtime and the migrator share one configuration (`auth.service.ts:440-445` comment).

### 1.1 What is configured, and when

| Capability | Condition | Source |
|---|---|---|
| Email + password | Always. `minPasswordLength: 8`, `maxPasswordLength: 128`, `revokeSessionsOnPasswordReset: true` | `auth.service.ts:521-528` |
| `requireEmailVerification` | `!isSelfHosted && !isEmailVerificationOtpDisabled` | `auth.service.ts:525-526` |
| Email OTP plugin (verification, sign-in OTP, password reset) | **cloud only**; `overrideDefaultEmailVerification: true`, `sendVerificationOnSignUp` = `shouldSendSignupEmailOtp`, `otpLength: 6`, `expiresIn: 5 * 60`, `allowedAttempts: 5`, `storeOTP: 'hashed'` | `auth.service.ts:540-563`, `:89-92` |
| Google OAuth | cloud only and only when both `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set | `auth.service.ts:89-90, 529-538` |
| Organizations + invitations | Always. `organizationLimit: 10`; `membershipLimit` = entitlement seat count; `requireEmailVerificationOnInvitation` = `!isSelfHosted && !isEmailVerificationOtpDisabled`; invitation schema carries an additional `workspaceId` field | `auth.service.ts:565-576` |
| Stripe subscriptions | cloud only and only when `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are both set | `auth.service.ts:126-127, 140-219` |
| Anonymous ("guest") sessions | cloud only; `generateName: () => 'Human'`; on account link, app rows are reassigned to the new user under the provisioning lock | `auth.service.ts:727-756` |
| Multi-session | Always; `maximumSessions: 10` | `auth.service.ts:758-764` |
| Two-factor (TOTP + backup codes) | Always registered: issuer `Receipt`, 6 digits / 30 s, 10 backup codes of length 10 stored encrypted, 2FA cookie 10 min, trusted device 30 days | `auth.service.ts:765-778` |
| TanStack Start cookie bridge | Always | `auth.service.ts:779` |
| Test utilities | Only when `NODE_ENV=test` or `VITEST=true` | `auth.service.ts:128-129, 725` |

**Session TTL and refresh are not overridden.** The `betterAuth({...})` object at `auth.service.ts:446-793` contains no `session:` block, so Better Auth's library defaults apply (7-day expiry with daily refresh in Better Auth 1.x). The dev-only session route, which writes a session row directly, uses 7 days (`apps/start/src/routes/api/dev/session-login/route.tsx:5, 201`), consistent with that default. Concurrent sessions are capped at 10 per user by the multi-session plugin, not by a session setting.

### 1.2 Origin, cookies, trusted origins

- `BETTER_AUTH_URL` is required at module load; trailing slashes are stripped. Error: `Missing BETTER_AUTH_URL. Configure apps/start/.env before starting auth.` (`auth.service.ts:102-110`).
- `BETTER_AUTH_SECRET` is required at module load through `requireEnv`: `Missing required environment variable BETTER_AUTH_SECRET.` (`auth.service.ts:94-100, 450`).
- Secure cookies follow the scheme of `BETTER_AUTH_URL` unless `BETTER_AUTH_USE_SECURE_COOKIES` is `true`/`1` or `false`/`0`. The code comment explains why: an AWS bootstrap can sit behind an HTTP-only ALB before a certificate exists, and forcing `Secure` there makes sign-up appear broken (`auth.service.ts:112-125, 782`).
- `crossSubDomainCookies` is always enabled; `BETTER_AUTH_COOKIE_DOMAIN` sets the domain when present (`auth.service.ts:783-788`).
- Trusted origins = the canonical `BETTER_AUTH_URL` origin plus `RECEIPT_LEGACY_PUBLIC_ORIGINS` (comma list). Each legacy entry must be an absolute **HTTPS** origin with no credentials, no wildcard host, and no path/query/fragment; violations throw `Invalid RECEIPT_LEGACY_PUBLIC_ORIGINS: <reason>.` The canonical URL must itself be an exact HTTP or HTTPS origin (`auth-trusted-origins.ts:6-44, 46-67`; wired at `auth.service.ts:452-455`).

### 1.3 Instance mode: `VITE_APP_INSTANCE_MODE`

Resolved once at module load: exactly `self_hosted` selects self-hosted, anything else is `cloud` (`apps/start/src/utils/app-feature-flags.ts:25-28`). It is a Vite build-time variable, inlined into both browser and SSR bundles, so changing it requires a rebuild. Self-hosted differences are collected in section 10; the auth-relevant ones are:

- The email OTP plugin, Google, anonymous sessions, Stripe, and `changeEmail` are all disabled (`auth.service.ts:517-519, 529, 540, 727, 140`).
- A `before` hook, `selfHostedAuthGuard`, rejects social and email-delivery endpoints with `FORBIDDEN`: `SELF_HOSTED_SOCIAL_AUTH_DISABLED` / `"Social auth is disabled for self-hosted instances."` and `SELF_HOSTED_EMAIL_DELIVERY_DISABLED` / `"Email verification and password recovery are disabled for self-hosted instances."` (`auth.service.ts:226-270, 790-792`).

### 1.4 The signup-OTP switch

`isEmailVerificationOtpDisabled` is true when mode is `cloud` **and** either `VITE_DISABLE_EMAIL_VERIFICATION_OTP` is `true`/`1`, or the app runs under the Vite dev server (`import.meta.env.DEV`) without `VITE_REQUIRE_SIGNUP_EMAIL_OTP=true|1` (`app-feature-flags.ts:30-48`). When it is on: new users are force-marked verified after creation (`auth.service.ts:458-461`), existing users are normalized to verified when a session is created (`auth.service.ts:484-497`), and the signup OTP send is suppressed (`auth.service.ts:548`). `start:all` exports `VITE_DISABLE_EMAIL_VERIFICATION_OTP=1` into the production web build unless `START_ALL_USE_SIGNUP_EMAIL_OTP=1` (`scripts/start-all.mjs:114`). The hosted SST config defaults the same variable to `"true"` unless set (`sst.config.ts:224`), and the deploy guard requires it to be `false` on the `production` stage (section 9).

### 1.5 The dev-mode session route `/api/dev/session-login`

`apps/start/src/routes/api/dev/session-login/route.tsx`. **The only gate is `import.meta.env.DEV && hostname in {localhost, 127.0.0.1, ::1}`** (`route.tsx:30-32, 214-218`); it returns `404 {"error":"Not found"}` otherwise. Under the Vite dev server it finds a non-anonymous user by `?userId=`, `?email=`, or the most recently created user, reuses or creates a 7-day `session` row (backfilling `activeOrganizationId`), signs the token with HMAC-SHA256 over `BETTER_AUTH_SECRET`, sets `better-auth.session_token` (`HttpOnly; SameSite=Lax; Path=/`), and 302-redirects to `?redirect=` (relative paths only, default `/chat`) (`route.tsx:41-47, 57-79, 150-207, 219-240`). It is a local E2E convenience and must not be documented as a product feature; it is absent from production builds because `import.meta.env.DEV` is false there.

### 1.6 `/login` and root `/`

- `/login` is a permanent client redirect to `/auth/sign-in`, preserving `?redirect=` (`apps/start/src/routes/login.tsx:4-20`).
- **Root `/` at HEAD** (changed in `c3c16be6`): `beforeLoad` redirects to `/auth/sign-up` when `isSelfHosted`, otherwise calls a server function that reads the request `Host` header and only renders the marketing `LandingPage` when the hostname is `beetle.run` or `www.beetle.run`; every other host (including `localhost` and the hosted app domains) redirects to `/auth/sign-up` (`apps/start/src/routes/index.tsx:7-31`). The in-file comment states the reason: one build serves both the marketing site and the app, and there is no build-time flag separating them.

---

## 2. Sign-up and sign-in pages

Both routes render the same `SignInPage` component in different modes (`apps/start/src/routes/auth/sign-in/route.tsx:6-31`, `sign-up/route.tsx:9-64`). In self-hosted mode `/auth/sign-up` **always** redirects (to `/auth/sign-in` when setup is complete, else `/setup`), and `/auth/sign-in` redirects to `/setup` until setup completes (`sign-up/route.tsx:10-21`, `sign-in/route.tsx:7-20`). A signed-in non-anonymous user hitting `/auth/sign-up` is bounced to the redirect target; while the initial session resolves the page shows `"Preparing sign up"` (`sign-up/route.tsx:44-58`).

### 2.1 Fields and exact strings

Rendered fields are email, password, and (sign-up only) confirm password; there is **no Google button, no guest button, and no name field**. `grep signIn.social` over `apps/start/src` returns nothing, and `login-form.tsx` contains no Google reference. The strings `auth_sign_in_google` = `"Continue with Google"`, `auth_login_sign_in_google` = `"Sign in with Google"`, `auth_sign_in_guest` = `"Continue as guest"`, and the GitHub/Microsoft variants exist in `apps/start/messages/en.json` but are unused (classification: Google OAuth is **hidden**; the strings are **stubbed**).

Headers: sign-in `"Welcome Back"` / `"Sign in to continue"`; sign-up `"Create Account"` / `"Create your account to continue"` (`auth_login_header_*`). Submit: `"Sign in"` or `"Create Account"`, in flight `"Please wait..."` (`auth_login_submitting`). Footer toggles: `"Already have an account?"` + `"Sign in"`; the `"Don't have an account?"` footer is hidden in self-hosted mode (`login-form.tsx:351-353`). `"Forgot your password?"` (`auth_login_forgot_password`) is cloud-only.

Client validation (`apps/start/src/components/auth/auth-shared.ts:3, 6`; `login-form.tsx:66`): password at least `AUTH_PASSWORD_MIN_LENGTH = 8`; OTP countdown `OTP_EXPIRES_IN_SECONDS = 300`. Error strings: `"Please enter a valid email address"`, `"Password must be at least {count} characters"`, `"Passwords do not match"`, `"Invalid credentials"`, `"An unexpected error occurred. Please try again."`, `"Error creating account. Please try again."`, `"You entered too many incorrect codes. Request a new one to continue."`, `"That code is invalid or expired. Request a new one and try again."`, `"Your email is not yet verified. Enter the code we just sent you."`, `"We could not send the verification code. Try again in a few minutes."`, `"Your email is verified, but we could not sign you in automatically."` (`en.json`, `auth_error_*`).

Verification step: `"Check Your Email"`, `"Verification Code"`, `"Expires in {time}"`, `"The code expired. Request a new one."` (`common_check_your_email`, `auth_otp_*`). Two-step verification (only when the account already has TOTP enabled): `"Two-step verification"`, `"Before continuing, enter the code from your authenticator app."`, `"Enter the 6-digit code for {email}."`, button `"Continue"` (`auth_mfa_*`; verify call `sign-in-page.logic.ts:603`).

Password reset (cloud): `"Reset Password"`, `"Enter your email to receive a reset code."`, `"Send Code"`, `"We will update the password for {email}."`, `"Update Password"`, `"Enter the 6-digit code we sent you by email."` (`auth_forgot_password_*`, `auth_forgot_error_*`). It is an email-OTP reset (`emailOtp.requestPasswordReset` / `resetPassword`), not a link.

A developer-facing error, `auth_error_local_unverified_stale_account`, names `bun run web:db:reset`, `START_ALL_USE_SIGNUP_EMAIL_OTP=1` and `VITE_REQUIRE_SIGNUP_EMAIL_OTP=1`; it is rendered to end users when an account created under verification is used in a build that skips it. Do not document it as product behavior.

### 2.2 Redirect target

`getRedirectTarget` accepts only relative paths and falls back to `/chat` (`apps/start/src/components/auth/sign-in/sign-in-page.logic.ts:24-27`).

### 2.3 Invitation acceptance

Route `/auth/accept-invitation/$id` (`apps/start/src/routes/auth/accept-invitation/$id/route.tsx`). The sign-up route accepts `?invitationId=` (`sign-up/route.tsx:23-26`) and pre-fills the invited address: `"This invitation is tied to this email address."` / `"Use the email address that received the invitation to continue."` (`auth_invitation_tied_to_email`, `auth_invitation_use_invited_email`; used by `login-form.tsx` and `sign-in-page.logic.ts`). Card strings for a signed-in invitee: `"Organization invitation"`, `"Review this invitation before joining the organization in Receipt."`, `"You have been invited to join"`, `"Invited by {inviter}"`, `"Join organization"`, `"Decline"` / `"Declining…"`, success `"Welcome aboard!"` / `"You have successfully joined the organization. Redirecting to your workspace…"`, failures `"Invalid invitation"`, `"Failed to load invitation"`, `"Failed to accept invitation"`, `"Failed to reject invitation"` (`auth_invitation_*`). On accept the server hook also accepts any workspace-scoped invitation carried in the `workspaceId` field (`auth.service.ts:611-622`).

Invitation email link is `${BETTER_AUTH_URL}/auth/accept-invitation/<id>` (`auth.service.ts:699`). Subject `"You're invited to join {organizationName}"`, title `"You're invited to {organizationName}"`, subtitle `"{inviterName} invited you to collaborate in {organizationName}."`, body `"Open the invitation link below to accept and access your workspace."`, CTA `"Accept invitation"`, plain text `"Open this link to accept: {inviteLink}"`, labels `"Inviter"`, `"Workspace"` (`auth_mail_invitation_*`). The organization label becomes the workspace name when the invitation is workspace-scoped (`auth.service.ts:700-704`). Invitation expiry is Better Auth's default of 48 hours; Receipt sets no `invitationExpiresIn` (`node_modules/better-auth/dist/plugins/organization/adapter.mjs:547`).

### 2.4 Slack and Teams install claim pages

- `/auth/slack-install?claim=<43-char base64url>`: loads the claim server-side, redirects unauthenticated visitors to `/auth/sign-in?redirect=/auth/slack-install?claim=...` (`apps/start/src/routes/auth/slack-install/route.tsx:6-25`). Page strings: `"Connect Slack workspace"`, `"Select a workspace"`, `"Connecting…"`, `"Continue to Receipt"`, `"Return to Receipt"`, `"Only an organization owner or administrator can connect Slack."`, `"This Slack installation link has already been used."`, `"This Slack installation link has expired. Start again from Slack."`, `"This Slack installation link is invalid. Start again from Slack."`, `"Receipt could not finish the Slack connection. Please try again."` (`apps/start/src/components/auth/slack-install/slack-install-page.tsx`).
- `/auth/teams-install?claim=<32..4096 chars>`: same shape (`apps/start/src/routes/auth/teams-install/route.tsx:6-20`). Strings: `"Connect Microsoft Teams to Receipt"`, `"Connect Teams tenant"`, `"Link my Teams identity"`, `"Select a Receipt workspace"`, `"Microsoft Teams connected"`, `"Return to Teams and send your request again."`, `"This Teams link is invalid or expired."`, `"This Teams tenant is already connected elsewhere or the link is invalid."`, `"You do not have permission to connect this Teams identity."` (`teams-install-page.tsx`).

Both are **reachable** only from the respective chat app's install flow; the sidebar also carries a `Slack` install link (`app-sidebar.tsx`, `SLACK_INSTALL_HREF`).

---

## 3. Organizations

### 3.1 Automatic creation at signup

`databaseHooks.user.create.after` (`auth.service.ts:456-482`): unless the user is anonymous (`shouldProvisionDefaultOrganization`, `default-organization.helpers.ts:6-10`), `ensureDefaultOrganizationForUser` runs under a transaction-scoped advisory lock keyed `auth-user-provision:<userId>` (`auth.service.ts:339-366`).

- Name: `"<display name>'s Workspace"`, or, when the name is empty or literally `human`, the email local part with `.`/`_`/`-` turned into spaces and title-cased (`ari.say@x.com` becomes `Ari Say's Workspace`) (`default-organization.helpers.ts:15-33`).
- Slug: `slugify(name)` (lowercased, non-alphanumerics to `-`, max 40 chars) + `-` + first 8 chars of the user id (`default-organization.service.ts:30-36`, `auth.service.ts:132-138`).
- `afterCreateOrganization` (`auth.service.ts:577-588`) then creates the tenant directories, the billing baseline, the member-access row, and recomputes the entitlement snapshot.
- Billing baseline (`default-organization.service.ts:87-115`): cloud `plan_id='free'`, `seat_count=DEFAULT_FREE_SEAT_COUNT`, `status='inactive'`; self-hosted `plan_id='self_hosted'`, `seat_count=100000` (`SELF_HOSTED_DEFAULT_SEAT_COUNT`, `:28`), `status='active'`, usage policy disabled.
- Signup credit: cloud only, `PLATFORM_SIGNUP_CREDIT_NANO_USD = 5_000_000_000` (USD 5.00) granted as a `signup_grant` ledger row (`workspace-usage/shared.ts:19`; `default-organization.service.ts:112-115, 169-174`). Self-hosted gets 0.
- The new session's `activeOrganizationId` is set to the user's oldest membership (`auth.service.ts:498-508`; `findFirstOrganizationForUserEffect` orders `member` by `createdAt asc`, `default-organization.service.ts:38-52`).

### 3.2 Manual creation, limit, and the switcher

Sidebar dialog: title `"Create organization"`, description `"Enter a name."`, label `"Organization name"`, placeholder `"Acme"`, button `"Create"`; errors `"Name required."`, `"Create failed."`, `"Activation failed."`, `"Invalid response."`, `"You can create up to {max} organizations."` (`layout_organization_create_*`). `MAX_ORGANIZATIONS_PER_USER = 10` client-side (`sidebar-organization-menu.tsx:99, 302-305`) mirrors `organizationLimit: 10` server-side (`auth.service.ts:571`). Creation calls `authClient.organization.create` then `setActive` (`sidebar-organization-menu.tsx:325, 341`). Anonymous users cannot create organizations (`auth.service.ts:566`). Switcher strings: `"Organizations"`, `"Loading organizations..."`, `"No organizations found"`, `"Switching..."`, `"1 member"` / `"{count} members"`, and a `"Sign out"` entry (`sidebar-organization-menu.tsx:607`). When a workspace is selected, the trigger shows the active workspace name under the organization (`sidebar-organization-menu.tsx:496-499`). The `c3c16be6`-era commit `46652e84` removed the sidebar group tooltips (`sidebar-organization-menu.tsx`, `app-sidebar.tsx` diffs).

### 3.3 General settings (`/organization/settings`)

Title `"General"`, description `"Manage your organization's profile, name, and logo."`; sections **Logo** (`"This is your organization's logo. Click to upload a custom image."`, help `"A logo is optional but helps identify your organization."`, success `"Logo saved."`) and **Organization name** (`"The display name of your organization."`, placeholder `"e.g. Acme Inc."`, help `"Use 64 characters or fewer."`, success `"Organization name saved."`). The name input carries `maxLength: 64` (`org-general-page.tsx:60-70`); the logic trims and rejects empty names (`"Organization name cannot be empty."`) and uses `authClient.organization.update` for both name and logo (`org-general-page.logic.ts:74-135`). Other errors: `"No organization selected."`, `"You need to sign in and select an organization to edit."`, `"Unable to save organization name."` (`org_settings_general_*`). No server-side length check beyond Better Auth's own exists in the repo.

### 3.4 Members page (`/organization/settings/members`)

Title `"Members"`, description `"Manage organization members, pending invitations, permissions, and access status."`, filter `"Filter members..."`, empty `"No members or pending invitations found."`, loading `"Loading members and invitations..."` (`members-page.tsx:330-344`). Status tooltips: `"Invitation has not been accepted yet."`, `"Access is restricted."` (`members-page.tsx:244-246`). Row actions: `"Change role"` (Admin / Member only, `SELECTABLE_ROLES` at `members-page.tsx:75`), `"Remove member"`, `"Cancel invitation"`, `"View profile"` (`org_members_*`). Toasts: `"Role updated."`, `"Failed to update role."`, `"Member removed."`, `"Failed to remove member."`, `"Invitation cancelled."`, `"Failed to cancel invitation."` (`members-page.logic.ts:287-351`).

Invite dialog: trigger and title `"Invite member"`, description `"Send an invitation to join this organization."`, button `"Send invitation"`, placeholder `"colleague@example.com"`, role select placeholder `"Role"`, batch cap `INVITE_BATCH_MAX = 10` (`invite-members-dialog.tsx:60-62, 75, 88, 106`; `logic.ts:9`). Results: `"Invitation sent."` / `"Invitation created. Copy the signup link below."` (self-hosted without mail transport), `"Enter at least one email address."`, `"Failed to send invitations."` (`logic.ts:114, 154, 170-171`). Invites are sent one API call per address.

### 3.5 Roles

Receipt passes no custom access-control statement to the organization plugin, so Better Auth's `defaultRoles` apply (`node_modules/better-auth/dist/plugins/organization/access/statement.mjs`; consumed at `has-permission.mjs:9`): `owner` and `admin` can update the organization and manage members and invitations; `member` is read-only. Receipt's own `isAdminRole` treats `owner` and `admin` identically and tolerates comma-separated role strings (`apps/start/src/lib/shared/auth/roles.ts`). Stripe `authorizeReference` requires `isAdminRole` for both listing and mutating subscriptions (`auth.service.ts:155-171`). The client gate `useCanManageOrganizationSettings` fails closed while the role resolves (`use-auth.ts:77-114`).

### 3.6 Settings access rules

`canAccessOrganizationSettingsPath` (`apps/start/src/routes/(app)/_layout/organization/settings/-organization-settings-access.ts:9-17`): no role -> false; MCP Gateway or Workspaces paths -> any role; anything else -> `owner` or `admin`. So a plain member can open **Workspaces** and **MCP Gateway** but not Members, Billing, Usage, BYOK, Security, or Policies. The organization Security page (`/organization/settings/security`, "Domains", "Single Sign-On", "Directory Provisioning") is **stubbed**: every button is disabled and every href is `#`; there is no SSO plugin and no directory-sync code (prior corpus finding re-confirmed by the absence of any SSO plugin in `auth.service.ts:446-793`).

### 3.7 Seats and `RECEIPT_DEFAULT_FREE_SEAT_COUNT`

`DEFAULT_FREE_SEAT_COUNT` is now read from `RECEIPT_DEFAULT_FREE_SEAT_COUNT` (positive integer) and falls back to 5 (`workspace-usage/shared.ts:20-34`, added in `c3c16be6`). It feeds the billing baseline (`default-organization.service.ts:100-102`) and `assertInvitationCapacity`, which counts active members plus pending invitations plus the new invite against `max(1, subscription.seatCount ?? DEFAULT_FREE_SEAT_COUNT)` (`auth-billing-hooks.ts:79-92`). Better Auth's `membershipLimit` is wired to `getOrganizationSeatLimit` (`auth.service.ts:572-573`, `auth-billing-hooks.ts:64`). Overflow returns HTTP 403 with `"Only {n} users can access this workspace."` (singular `user` for 1) (`billing/domain/seat-limit-message.ts:6-8`). Every membership and invitation hook recomputes the entitlement snapshot, which stores `is_over_seat_limit` (`auth.service.ts:589-675`, `default-organization.service.ts:258, 290`). UI strings: `"Seat allocation"`, `"{activeMembers} of {seatCount} seats"`, `"You selected {selectedSeats} seats for {activeMembers} active members. Everyone keeps access until period end, and extra members will be auto-restricted after renewal."` (`org_billing_seat_*`). Note the discrepancy the docs must not paper over: the plan catalog says Free `includedSeats: 1` (`access-control/index.ts:99`) while the enforced default is 5.

### 3.8 User settings

`/settings` and `/settings/security` redirect signed-out or anonymous users to `/chat` and show `"Loading settings"` while resolving (`routes/(app)/_layout/settings/route.tsx:9-23`). Nav: `"Settings"` / `"Manage your account and preferences."`.

- **Account**: `"Account"` / `"Manage your account details and avatar."`; Avatar (`"This is your avatar. Click on the avatar to upload a custom image."`, `"An avatar is optional but strongly recommended."`, `"Avatar saved."`); Display Name (`"Please use 32 characters at maximum."`, placeholder `"e.g. Ari Say"`, `"Display name saved."`); Email (`"Use a valid address you can access to complete secure verification."`, `"Email change request submitted. Check your inbox to finish verification."`; disabled entirely in self-hosted, `auth.service.ts:517-519`); Language (`"Choose your preferred interface language."`, backed by the `preferredLocale` additional user field, `auth.service.ts:511-516`); Logout (`"Sign out from your current session on this device."`).
- **Security**: `"Security"` / `"Manage your account password and session security."`. Sections rendered: **Connected login methods** (`"Review connected sign-in providers and unlink methods you no longer use."`, `"You must keep at least one login method connected."`, `"Login method unlinked."`; a `Passkeys` row reading `"0 passkeys registered"` with no passkey plugin behind it), **Change password** / **Set password** (`"Enter your current password and choose a new one."`, `"You will be signed out from other sessions after changing your password."`, `"Current password is incorrect."`, `"New password must be different from your current password."`), **Active sessions** (`"Revoke other sessions"`, `"No other active sessions to revoke."`, `"Session revoked."`, `"Other sessions revoked."`) (`security-page.tsx:79, 99, 187`; strings `settings_security_*`).
- **Two-factor enrollment is absent from the UI.** `security-page.tsx` contains no MFA section (grep for `mfa`/`TwoFactor` returns nothing); the only `twoFactor` client call is `verifyTotp` during sign-in (`sign-in-page.logic.ts:603`). The `settings_security_mfa_*` strings (`"Two-factor authentication"`, `"Set up authenticator"`, `"Backup codes"`) are **stubbed**. The social `linkSocial` call exists in `connected-login-methods.logic.ts:234-241` but `connected-login-methods.tsx` exposes no Connect/Add action (grep for `connectLoginProvider|onConnect` returns nothing), so linking a social provider is **stubbed** too.

### 3.9 Admin surfaces

- `/api/admin-metrics` (`apps/start/src/routes/api/admin-metrics.tsx:23-51`): read-only aggregate metrics for a separate marketing-site console. Gate: a real (non-anonymous), email-verified Better Auth session whose email ends in `@kentron.ai`, optionally narrowed by the comma-separated `ADMIN_EMAIL_ALLOWLIST`, re-read on every request (`admin-access.server.ts:19, 33-52, 58-88`). Responses: 401 `"Sign in to continue."`, 403 `"This account does not have access to the admin console."`. Every read is logged with the viewer email. **Kentron-internal; do not publish as a self-hoster feature.**
- The `ee` "Singularity" control plane is gated on one hardcoded organization id (`apps/start/src/ee/singularity/shared/singularity.ts:3`); it is commercially licensed (`apps/start/src/ee/LICENSE.md`) and its gating id must never be published.

---

## 4. Workspaces as tenancy (brief)

Two tenancy concepts coexist. The Better Auth **organization** is the billing and membership boundary and what the sidebar switches. The **Receipt workspace** (`packages/receipt-app/src/services/receipt-workspaces.ts`) is the credential and tool boundary used by MCP Gateway, Receipt Connect, and the CLI. Every organization has a deterministic `Default` workspace (`ws_<md5(orgId)>`, created lazily by `ensureDefaultForActor`, cannot be deleted) plus a hidden global-scope row (`ws_global_<md5(orgId)>`) that backs organization-wide integrations and is excluded from lists. Roles are `owner | admin | member`; an organization owner/admin is treated as owner/admin in every workspace. The Workspaces page lives at `/organization/settings/workspaces` (`"Isolate connected accounts, action permissions, CLI sessions, and MCP tools inside your organization."`) and is reachable to any member. The active workspace is a per-organization `localStorage` key with an in-memory fallback (`apps/start/src/lib/frontend/receipt-connect/active-receipt-workspace.tsx:44-58`), and the sidebar organization trigger shows its name (`sidebar-organization-menu.tsx:496-499`). Since `41baea75`, the workspace list carries `createdBy` (resolved through a `LEFT JOIN "user"`, absent for the system-provisioned Default) and the member list merges **pending** invitations from both invitation paths (`receipt-workspaces.ts` diff: `createdBy`, `RECEIPT_WORKSPACE_CREATOR_JOIN_SQL`, `listReceiptWorkspaceAccessMembers`), with a new `cancelReceiptWorkspaceInvitationAction` (`receipt-connect.server.ts:925-945`).

---

## 5. Plans and billing

Plan ids: `free`, `plus` (USD 8), `pro` (USD 50), `scale` (USD 100), `enterprise`, `self_hosted` (`apps/start/src/lib/shared/access-control/index.ts:3-9, 94-155`). Only `plus`/`pro`/`scale` are Stripe-managed; their price ids come from `STRIPE_PRICE_PLUS_MONTHLY`, `STRIPE_PRICE_PRO_MONTHLY`, `STRIPE_PRICE_SCALE_MONTHLY` via `resolveStripePlanPriceId`, which throws `Missing required environment variable <KEY>` when unset (`:106-124, 240-255`). `self_hosted` is a valid plan id only in self-hosted mode (`:225-229`).

What is enforced: seat capacity on invitations (section 3.7); rate limits (`FREE_/PAID_CHAT_RATE_LIMIT_*`, `FREE_CHAT_ALLOWANCE_*`, `access-control/index.ts:34-39, 114-147`); metered platform credit through the usage policy (`WORKSPACE_USAGE_*` margins, `workspace-usage/shared.ts:73-90`); the USD 5 signup credit. What the catalog lists as feature gating (`ORG_FEATURE_MINIMUM_PLANS`: `byok`/`providerPolicy`/`compliancePolicy`/`toolPolicy` at `plus`, `verifiedDomains` at `pro`, `singleSignOn`/`directoryProvisioning` at `enterprise`, `access-control/index.ts:164-173`) resolves into the entitlement snapshot, but the features behind `verifiedDomains`, `singleSignOn`, and `directoryProvisioning` do not exist (section 3.6), so those rows are gating nothing. The pricing page `/pricing` accepts `checkoutPlan` (plus|pro|scale), `checkoutSeats` (1..500), `resumeCheckout` and renders the Stripe flow in cloud; in self-hosted it renders `"Self-hosted instance"` / `"Cloud billing and plan upgrades are disabled in self-hosted mode. This deployment already runs with the self-hosted capability profile."` (`routes/pricing/route.tsx:11-38`). Stripe checkout allows promotion codes (`auth.service.ts:211-217`).

---

## 6. Configuration: the environment variable reference

### 6.1 Where configuration lives and load order

There is no central schema. Values are read lazily per module, so most mistakes surface when the feature runs. Templates: `apps/start/.env.example` (cloud/dev) and `apps/start/.env.self-host.example` (self-hosted, referenced by no repo markdown). Loaders, all of which let a value already in the shell win:

| Loader | Files in order |
|---|---|
| `scripts/start-all.mjs:962-990` | `.env`, `.env.local`, `apps/start/.env`, `apps/start/.env.local`, `$START_ALL_ENV_FILE`, each of `$START_ALL_ENV_FILES`; `loadEnvFile` skips keys already set (`:987`) |
| `apps/start/scripts/dev-with-receipt.mjs` | the same four repo/app files |
| `scripts/validate-stack.sh` | the same four, then `$START_ALL_ENV_FILE`, `$VALIDATE_STACK_ENV_FILE`, `$START_ALL_ENV_FILES`, `$VALIDATE_STACK_ENV_FILES` |
| the repo `receipt` CLI (`packages/receipt-app/src/cli/env.ts`) | the same four, then `.deploy-artifacts/local-up/latest.env`, `$START_ALL_ENV_FILE`, `$RECEIPT_LOCAL_ENV_FILE`, `$VALIDATE_STACK_ENV_FILE`, plus the two `_FILES` lists; `RECEIPT_CLI_LOAD_LOCAL_ENV=0` skips them |
| `apps/start/scripts/db-reset.ts`, `zero-dev-reset.ts`, `zero-migrate.ts` | `apps/start/.env.local`, then `apps/start/.env` |
| `zero-cache` script | Bun's own `--env-file=.env --env-file=.env.local` (`apps/start/package.json:19`) |
| `scripts/local-up.sh` | **none**; it reads the shell and writes its own file (section 7.4) |

Import-time hard requirements: `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET` (`auth.service.ts:94-110, 450`), `ZERO_UPSTREAM_DB` for the app pool and for the runtime (`packages/receipt-app/src/config/runtime-env.ts:1-27`: `Receipt Postgres storage requires ZERO_UPSTREAM_DB.`). `ZERO_UPSTREAM_DB` is the single canonical database variable; the runtime accepts no alias (`runtime-env.ts:1-2`). Turbo runs in strict env mode: only `NODE_ENV`, `VITE_APP_INSTANCE_MODE`, `VITE_BETTER_AUTH_URL`, `VITE_SELF_HOST_SOURCE`, `VITE_ZERO_CACHE_URL`, `VITE_ENABLE_ORGANIZATION_PROVIDER_KEYS`, `VITE_DISABLE_REDIS` are cache-key `globalEnv` (`turbo.json:3-12`); everything else must be in `globalPassThroughEnv`.

Method for the tables below: `grep` for `process.env.X`, `process.env['X']`, `import.meta.env.X`, and the helper forms `readStringEnv('X')`, `readTrimmedEnv('X')`, `readEmailEnv('X')`, `readEnv(['X'])`, `envInt("X")`, `envString("X")`, `trimmedEnv(env,"X")`, plus bash `${X:-}` in `local-up.sh`, excluding tests. "Process" names which process reads it: **web** = `apps/start` server, **browser** = Vite-inlined `VITE_*`, **runtime** = `packages/receipt-app`, **slack**, **teams**, **start:all**, **local:up**, **dev** = `dev-with-receipt.mjs`, **role sup** = `scripts/start-resonate-runtime.mjs`, **deploy** = SST/deploy scripts. A dagger (†) marks variables that appear in `.env.example` or a deploy template but are read by no code.

### 6.2 Identity, sessions, email

| Variable | Process | Required | Default | Purpose / source |
|---|---|---|---|---|
| `BETTER_AUTH_SECRET` | web, runtime, slack(via runtime libs), local:up | yes | (local:up writes a placeholder dev secret, `local-up.sh:172`) | Better Auth signing secret; JWT fallback for Connect (`auth.service.ts:450`; `receipt-connect-auth-token.ts:133-134`) |
| `BETTER_AUTH_URL` | web, slack, teams, storage | yes | none | Canonical public auth origin (`auth.service.ts:102-110`); public base for S3 proxy URLs (`storage-config.ts:105-107`) |
| `VITE_BETTER_AUTH_URL` | browser | in practice | none | Client auth base URL; must equal `BETTER_AUTH_URL`'s origin |
| `BETTER_AUTH_COOKIE_DOMAIN` | web | no | none | Cross-subdomain cookie domain (`auth.service.ts:783-788`) |
| `BETTER_AUTH_USE_SECURE_COOKIES` | web | no | derived from scheme | `true/1` or `false/0` override (`auth.service.ts:112-125`) |
| `RECEIPT_LEGACY_PUBLIC_ORIGINS` | web | no | none | Extra trusted HTTPS origins (`auth-trusted-origins.ts`) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | web | no | none | Google OAuth (cloud only; no UI button) (`auth.service.ts:89-90`) |
| `SELF_HOSTED_SETUP_TOKEN` | web | self-hosted | none | First-admin claim token (`instance-settings.service.ts:47, 214-231`) |
| `ADMIN_EMAIL_ALLOWLIST` | web | no | none | Narrows `/api/admin-metrics` (`admin-access.server.ts:33-40`) |
| `RECEIPT_DEFAULT_FREE_SEAT_COUNT` | web | no | `5` | Free-plan seat ceiling (`workspace-usage/shared.ts:27-34`) |
| `AUTH_EMAIL_PROVIDER` | web, deploy | no | inferred: `resend` if `RESEND_API_KEY`, else `ses` if a SES/AUTH from-address or SST identity, else `disabled` | `disabled | resend | ses | smtp` (`auth-email.service.ts:66-86`) |
| `AUTH_EMAIL_FROM` | web, deploy | no | none | Generic from-address, fallback for all providers (`:37-40`) |
| `RESEND_API_KEY`, `RESEND_FROM_EMAIL` | web, deploy | when `resend` | none | Resend transport (`:32-38`) |
| `SES_REGION` (falls back to `AWS_REGION`), `SES_FROM_EMAIL`, `SES_CONFIGURATION_SET` | web, deploy | when `ses` | none | SESv2 client constructed only when provider is `ses` and a region exists (`:39-47`) |
| `SST_RESOURCE_AuthEmail` | web | no | none | SST-injected SES identity JSON (`:88-102`) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM_EMAIL` | web, deploy | when `smtp` | port `587`, secure `false` | Nodemailer; auth only when user and pass are both set (`:48-64`) |
| `AUTH_EMAIL_SST_SENDER`, `AUTH_EMAIL_SST_DNS`, `AUTH_EMAIL_DMARC` | deploy only | no | none | Consumed by `sst.config.ts`/`deploy/sst`, not by the app at runtime |
| `AUTH_DEV_EMAIL_OTP_TO_CONSOLE` † | none | | | In `.env.example:47-48`; implemented nowhere |
| `VITE_REQUIRE_SIGNUP_EMAIL_OTP` | browser+SSR | no | unset | `1/true` re-enables OTP under `bun run dev` (`app-feature-flags.ts:34-36`) |
| `VITE_DISABLE_EMAIL_VERIFICATION_OTP` | browser+SSR, deploy | no | unset (SST defaults `"true"`) | `1/true` at build time disables OTP in a production bundle (`app-feature-flags.ts:30-32`; `sst.config.ts:224`) |
| `START_ALL_USE_SIGNUP_EMAIL_OTP` | start:all | no | off | `1` keeps OTP in the supervised build (`start-all.mjs:114`) |

### 6.3 Database, Zero, replication

| Variable | Process | Required | Default | Purpose / source |
|---|---|---|---|---|
| `ZERO_UPSTREAM_DB` | web, runtime, slack, teams, all scripts | yes | none | The one Postgres URL. `sslmode=prefer|require|verify-ca` is rewritten to `verify-full` unless `uselibpqcompat=true` (`zero-upstream-pool.ts`) |
| `DATABASE_URL`, `DATABASE_PUBLIC_URL` | web (setup health, zero-migrate), runtime (Resonate entrypoint) | no | none | Accepted as fallbacks only by `zero-migrate.ts` and the setup health check (`instance.server.ts:39-42`); the app pool and runtime do not read them |
| `VITE_ZERO_CACHE_URL` | browser, dev, start:all | in practice | `http://localhost:4848` (`dev-with-receipt.mjs:48`) | Browser to zero-cache URL; also chosen for the access-token path when it is absolute (`provider.tsx:85-90`) |
| `ZERO_APP_ID`, `ZERO_APP_PUBLICATIONS` | zero-cache, start:all | no | `receipt`, `zero_data` (`apps/start/package.json:19`) | Zero namespace and publication list |
| `ZERO_QUERY_URL`, `ZERO_MUTATE_URL` | zero-cache | no | `http://127.0.0.1:<gatewayPort>/api/zero/{query,mutate}` under start:all | Transform endpoints |
| `ZERO_QUERY_FORWARD_COOKIES`, `ZERO_MUTATE_FORWARD_COOKIES` | zero-cache | no | `.env.example` sets `true` | Forward browser cookies |
| `ZERO_QUERY_ALLOWED_CLIENT_HEADERS`, `ZERO_MUTATE_ALLOWED_CLIENT_HEADERS` | zero-cache, start:all | no | `x-receipt-zero-token,authorization` | Needed for the analyzer bearer token |
| `ZERO_REPLICA_FILE` | zero-cache, app scripts | no | `apps/start/zero.db` | SQLite replica path |
| `ZERO_PUBLICATION_EXTRA_TABLES` | app scripts | no | none | Comma list appended to `zero_data` (`zero-publication.ts:44-51`) |
| `ZERO_AUTH_JWT`, `ZERO_AUTH_TOKEN`, `ZERO_COOKIE`, `ZERO_CACHE_URL`, `ZERO_ANALYZE_ORG_ID`, `ZERO_ANALYZE_USER_ID` | app scripts (`analyze-query.ts`) | no | none | Analyzer auth and scope |
| `RECEIPT_POSTGRES_SCHEMA` | runtime, web, app scripts, start:all, dev | no | `public` under supervisors; otherwise a derived per-data-dir schema | Runtime projection schema (`start-all.mjs:1020`; `dev-process-cleanup.mjs:14-15`) |
| `RECEIPT_POSTGRES_SCHEMA_MODE` | runtime, start:all | no | none | Alternative schema selector |
| `RECEIPT_POSTGRES_POOL_MAX`, `RECEIPT_LOCAL_POSTGRES_POOL_MAX`, `RECEIPT_POSTGRES_APPLICATION_NAME` | runtime, role sup | no | pool `2` in code, `1` from the role supervisor (`start-resonate-runtime.mjs:23-26`) | node-postgres tuning |
| `RECEIPT_POSTGRES_URL` | runtime | no | resolved from `ZERO_UPSTREAM_DB` | Internal resolved URL name (105 reads; do not document as user-set) |
| `RECEIPT_FORCE_SCHEMA_MIGRATION` | runtime, receipt-core | no | none | Forces durable-schema migration |
| `RECEIPT_POSTGRES_MIRROR_URL` † | none | | | In both templates; read by no code |
| `TEST_ZERO_UPSTREAM_DB`, `RECEIPT_TEST_POSTGRES_URL`, `RECEIPT_TEST_DATABASE_URL` | tests | no | none | Test-only |
| `PGURL`, `POSTGRES_URL` | app scripts | no | none | Aliases read only by an app script |

### 6.4 Encryption keys and Receipt Connect

| Variable | Process | Required | Default | Purpose / source |
|---|---|---|---|---|
| `BYOK_ENCRYPTION_KEY_B64` | web, runtime, start:all, local:up | in practice | none | AES-256-GCM wrapping key for `org_provider_api_key`. Must decode to exactly 32 bytes; errors `Missing required environment variable BYOK_ENCRYPTION_KEY_B64.`, `BYOK_ENCRYPTION_KEY_B64 must be valid base64.`, `BYOK_ENCRYPTION_KEY_B64 must decode to exactly 32 bytes.` (`byok-crypto.ts:36-55`) |
| `RECEIPT_CONNECTION_ENCRYPTION_KEY_B64` | runtime, receipt-core, start:all, local:up | in practice | falls back to `BYOK_ENCRYPTION_KEY_B64` under both supervisors (`local-up.sh:173`) | AES-256-GCM key for Connect credential bundles; must decode to 32 bytes (`receipt-connect-config.ts:117-124`) |
| `RECEIPT_CONNECT_JWT_SECRET` | web, runtime, receipt-core, local:up | in practice | falls back to `BETTER_AUTH_SECRET` (`receipt-connect-auth-token.ts:133-134`; `local-up.sh:172`) | HS256 secret for Connect JWTs (12 h default TTL, `:24`); error `RECEIPT_CONNECT_JWT_SECRET or BETTER_AUTH_SECRET is required` (`:150`) |
| `RECEIPT_CONNECT_PROD_URL`, `RECEIPT_CONNECT_DEV_URL`, `RECEIPT_CONNECT_PROD_GATEWAY_URL`, `RECEIPT_CONNECT_PROD_SERVER_URL`, `RECEIPT_CONNECT_URL`, `RECEIPT_CONNECT_PUBLIC_GATEWAY_URL`, `RECEIPT_CONNECT_PUBLIC_URL` | runtime/CLI, web | no | release binaries bake `https://app.kentron.ai` (`build-receipt-cli-release.sh:9`) | Named CLI targets and hosted origin overrides (`receipt-connect-command-proxy.ts:53-74, 591-597`) |
| `RECEIPT_CONNECT_LOCAL_SERVER_URL`, `RECEIPT_CONNECT_LOCAL_AUTH_URL` | runtime/CLI | no | `http://127.0.0.1:8787`, `http://127.0.0.1:3000` (`.env.example`) | The `local` target; auth URL also falls back to `RECEIPT_AUTH_URL`, `BETTER_AUTH_URL`, `VITE_BETTER_AUTH_URL` (`receipt-connect-command-proxy.ts:569-577`) |
| `RECEIPT_CONNECT_GATEWAY_URL`, `RECEIPT_CONNECT_SERVER_URL`, `RECEIPT_CONNECT_GATEWAY_HOSTPORT`, `RECEIPT_CONNECT_WORKER_GATEWAY_URL`, `RECEIPT_CONNECT_CONTROLLER_GATEWAY_URL`, `RECEIPT_CONNECT_ENFORCE_PUBLIC_WORKER_GATEWAY` | web, runtime, start:all, dev | no | dev sets gateway to the runtime port (`dev-with-receipt.mjs:33`); start:all derives the worker gateway (`start-all.mjs:80-83`) | Gateway resolution |
| `RECEIPT_CONNECT_TOKEN`, `RECEIPT_CONNECT_USER_ID`, `RECEIPT_CONNECT_ORGANIZATION_ID`, `RECEIPT_CONNECT_WORKSPACE_ID`, `RECEIPT_CONNECT_WORKSPACE_NAME` | runtime/CLI, local:up | no | local:up mints a 12 h token (`local-up.sh:251-359`) | Env identity; wins over a saved CLI session (`receipt-connect-agent-cli.ts:176-190`) |
| `RECEIPT_CONNECT_OPEN_BROWSER`, `RECEIPT_CONNECT_DEVICE_LOGIN_SECRET`, `RECEIPT_CONNECT_MANIFEST_RETRY_DELAY_MS`, `RECEIPT_CONNECT_DATADOG_CONFIG_DIR` | runtime/CLI | no | none | CLI behavior |
| `RECEIPT_CLI_CONFIG_DIR`, `RECEIPT_CLI_SESSION_FILE`, `RECEIPT_CLI_VERSION`, `RECEIPT_CLI_NO_FORCE_EXIT`, `RECEIPT_CLI_LOAD_LOCAL_ENV` | runtime/CLI | no | none | CLI state |

**Irreversible-rotation caveat.** Both crypto modules stamp `keyVersion = 1` and hard-fail on any other version (`byok-crypto.ts:6, 78-82`: `Unsupported BYOK key version: <n>`; `receipt-connect-connections.ts`: `Unsupported Receipt Connect connection key version: <n>`), and there is no re-encryption routine anywhere in the repo. Rotating `BYOK_ENCRYPTION_KEY_B64` or `RECEIPT_CONNECTION_ENCRYPTION_KEY_B64` makes every stored provider key or connection bundle permanently undecryptable; the only recovery is re-entry. `.env.example` states this for BYOK; the docs should state it for both keys.

### 6.5 Model access, chat, rate limits, billing, analytics (web)

| Variable | Process | Default | Purpose / source |
|---|---|---|---|
| `OPENAI_API_KEY` | web, runtime | none | Platform-credit fallback only (`model-gateway.service.ts`, `platform-openai-key.ts`, `factory-model-funding.ts`). Model access normally comes from organization BYOK rows. Not in either template. |
| `OPENAI_BASE_URL`, `OPENAI_API_BASE`, `MOCK_OPENAI_API_KEY` | runtime | mock key `mock-openai-key` when the base URL is loopback | Offline mock mode; loopback-only by design (`receipt-openai-env.ts:52-74`) |
| `OPENAI_MODEL`, `OPENAI_MAX_RETRIES`, `OPENAI_RETRY_BASE_MS`, `OPENAI_TIMEOUT_MS`, `OPENAI_STRUCTURED_TIMEOUT_MS`, `RECEIPT_STRUCTURED_TIMEOUT_MS`, `OPENAI_ORGANIZATION`, `OPENAI_ORG_ID`, `OPENAI_PROJECT` | runtime | model `gpt-5.4-mini` for the chat lane (`server/config.ts:83-86`) | OpenAI client tuning |
| `RECEIPT_FACTORY_CHAT_MODEL`, `RECEIPT_FACTORY_TASK_MODEL`, `RECEIPT_FACTORY_OBJECTIVE_SUPERVISOR_MODEL`, `RECEIPT_FACTORY_SUPERVISOR_MODEL`, `RECEIPT_FACTORY_PLATFORM_CODEX_MODEL`, `RECEIPT_FACTORY_PLATFORM_SUPERVISOR_MODEL` | runtime, web | see runtime report | Model selection |
| `CHAT_REQUIRE_BYOK` | web | `false` | Force workspace keys for every model call |
| `CHAT_TITLE_GENERATION_MODEL`, `CHAT_RECEIPT_RECAP_MODEL`, `RECEIPT_CHAT_CHAIN_TIMEOUT_MS`, `RECEIPT_APP_CHAT_PROFILE_ID`, `RECEIPT_FACTORY_CHAT_PROFILE_ID` | web | none | Chat tuning |
| `AI_GATEWAY_API_KEY` †, `ANTHROPIC_API_KEY` † | none in production paths | | `.env.example` labels them required; `ANTHROPIC_API_KEY` is read only in a test stub and `AI_GATEWAY_API_KEY` is only deleted from projected sandbox env |
| `FREE_CHAT_RATE_LIMIT_WINDOW_MS` / `_MAX_REQUESTS`, `PAID_CHAT_RATE_LIMIT_WINDOW_MS` / `_MAX_REQUESTS`, `FREE_CHAT_ALLOWANCE_WINDOW_MS` / `_MAX_REQUESTS` | web | `60000`/`10`, `60000`/`30`, `86400000`/`100` | Chat rate limits (`access-control/index.ts:34-39, 114-147`) |
| `ALLOW_USER_COST_DISPLAY` | web (SSR) | `false` | Expose AI cost to end users (`app-feature-flags.ts:57-60`) |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | web | none | Enables the Stripe plugin (cloud) |
| `STRIPE_PRICE_PLUS_MONTHLY`, `STRIPE_PRICE_PRO_MONTHLY`, `STRIPE_PRICE_SCALE_MONTHLY` | web | none | Read through `plan.stripePriceEnvKey` |
| `VITE_STRIPE_PUBLISHABLE_KEY` †, `STRIPE_PRODUCT_ENTERPRISE` † | none | | Template only |
| `WORKSPACE_USAGE_TARGET_MARGIN_PERCENT` and `WORKSPACE_USAGE_{PLUS,PRO,SCALE,ENTERPRISE}_TARGET_MARGIN_PERCENT` | web | none (throws `Missing <name>` when a paid policy is built) | Metered-credit margins (`workspace-usage/shared.ts:73-90`) |
| `POSTHOG_PROJECT_API_KEY`, `POSTHOG_HOST` | web + browser bootstrap | host `https://us.i.posthog.com`; key ignored in self-hosted | Error/analytics drain (`posthog-config.server.ts:15-27`) |
| `POSTHOG_PROJECT_ID`, `POSTHOG_PERSONAL_API_KEY` | web | none | Source-map upload; `getPostHogSourceMapConfig()` is not wired into the build (`.env.example` comment) |
| `RAILWAY_ENVIRONMENT_NAME`, `RAILWAY_GIT_COMMIT_SHA`, `GITHUB_SHA` | web | none | PostHog environment/release labels (`posthog-config.server.ts:20-25`) |
| `EFFECT_SERVICE_NAME`, `EFFECT_SERVICE_VERSION`, `EFFECT_MIN_LOG_LEVEL`, `EFFECT_LOG_FORMAT`, `EFFECT_OTLP_BASE_URL`, `EFFECT_OTLP_HEADERS_JSON` | web | `receipt`, `0.0.0`, `Warn`, `json` in production else `pretty`, none, none | Effect observability layer with optional OTLP export (`server-observability.layer.ts:5-7, 85-86`) |

### 6.6 Storage, uploads, markdown, Redis, vector store

| Variable | Process | Default | Purpose / source |
|---|---|---|---|
| `UPLOAD_STORAGE_PROVIDER` | web | `cloudflare_r2` | `cloudflare_r2|r2` or `s3|s3_compatible|railway_s3|railway`; other values throw `Unsupported UPLOAD_STORAGE_PROVIDER value: <x>. Use cloudflare_r2 or s3_compatible.` (`storage-config.ts:45-63`) |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_PUBLIC_BASE_URL` | web | none | All required for R2: `Cloudflare R2 upload requires env variables: missing ...` (`:69-100`) |
| `S3_ENDPOINT` (or `ENDPOINT`), `S3_ACCESS_KEY_ID` (or `ACCESS_KEY_ID`), `S3_SECRET_ACCESS_KEY` (or `SECRET_ACCESS_KEY`), `S3_BUCKET_NAME` (or `BUCKET`), `S3_REGION` (or `REGION`), `S3_PUBLIC_BASE_URL`, `S3_AUTH_MODE`, `S3_USE_IAM_ROLE` | web | region `auto`; public base `${BETTER_AUTH_URL}/api/files/object` (signed proxy) | S3-compatible; `S3_AUTH_MODE=aws_default` or `S3_USE_IAM_ROLE=1` uses the ambient AWS chain (`:115-160`) |
| `CF_MARKDOWN_WORKER_URL`, `CF_MARKDOWN_WORKER_TOKEN`, `CF_MARKDOWN_WORKER_TIMEOUT_MS`, `CF_MARKDOWN_MAX_CHARS` | web | `20000`, `120000` | File-to-markdown conversion through `workers/markdown-converter`; both URL and token must be set for the setup wizard to report the worker available (`instance-settings.service.ts:42-46`) |
| `REDIS_URL` | web, local:up | local:up writes `redis://localhost:<START_ALL_REDIS_PORT>` | Rate limiting and chat stream resume |
| `VITE_DISABLE_REDIS` | browser+SSR | `false` in code, `true` in `.env.example` | In-memory stream-resume fallback (`app-feature-flags.ts:62`) |
| `VITE_ENABLE_EMBEDDING` | browser+SSR, start:all | `true` in code, `.env.example` ships `true`, self-host template `false` | Embeddings and vector retrieval; start:all warns when `true` without `QDRANT_URL` (`start-all.mjs:143-147`) |
| `QDRANT_URL`, `QDRANT_API_KEY`, `QDRANT_COLLECTION_ATTACHMENTS`, `QDRANT_TIMEOUT_MS`, `QDRANT_UPSERT_BATCH_SIZE` | web | `attachment_chunks_v1`, `5000`, `128` | Vector store |
| `VITE_APP_INSTANCE_MODE`, `VITE_SELF_HOST_SOURCE`, `VITE_CHAT_OBJECTIVE_PUSH` | browser+SSR | `cloud`, `''`, `true` | Instance mode, distribution label (`railway` changes setup copy), objective push rendering (`app-feature-flags.ts:25-28, 51-67`) |
| `VITE_ENABLE_ORGANIZATION_PROVIDER_KEYS` † | none | | In `turbo.json` and CI; read by no application code |
| `ENABLE_EMBEDDING` † | none | | Declared in `vite-env.d.ts`; the code reads only the `VITE_` name |

### 6.7 Runtime, jobs, Resonate, OpenSandbox (`packages/receipt-app` and the role supervisor)

| Variable | Process | Default | Purpose / source |
|---|---|---|---|
| `PORT` | runtime, role sup, dev | `8787` (`server/config.ts:76`) | Runtime listen port |
| `RECEIPT_PORT` | role sup, dev | `PORT`, then `8787` (`start-resonate-runtime.mjs:16`) | Advertised port and callback base |
| `DATA_DIR`, `RECEIPT_DATA_DIR` | runtime, role sup, start:all, local:up | `<repo>/.receipt/data` | Runtime data root |
| `RECEIPT_PROCESS_ROLE` | runtime, role sup | unset (all roles locally) | `api | driver | worker-control | worker-chat | worker-codex` (`server/config.ts:69-72`; `start-resonate-runtime.mjs:70-101`) |
| `RECEIPT_PROCESS_INSTANCE`, `JOB_WORKER_ID`, `RECEIPT_WORKER_HOST_ID` | runtime, role sup | `worker_<role>_<n>_<host>` | Worker identity |
| `CONTROL_WORKER_PROCESSES`, `CHAT_WORKER_PROCESSES`, `CODEX_WORKER_PROCESSES` | role sup | `1`, `2`, `OPEN_SANDBOX_GLOBAL_MAX_ACTIVE` then `_ORG_` then `1` | Process fan-out |
| `RECEIPT_SERVER_WATCH` | role sup | unset; `receipt:dev` sets `api` | Watch mode per role |
| `RESONATE_URL`, `RESONATE_PORT`, `RESONATE_METRICS_PORT`, `RESONATE_BIND`, `RESONATE_BIN`, `RESONATE_DATA_DIR`, `RESONATE_START_SERVER`, `RESONATE_TOKEN`, `RESONATE_STARTUP_SETTLE_MS`, `RESONATE_QUEUE_FULL_REFRESH_MS`, `RESONATE_GROUP_{API,CHAT,CODEX,CONTROL,DRIVER}` | runtime, role sup | URL `http://127.0.0.1:8001`; broker auto-started when the URL is loopback on the configured port (`start-resonate-runtime.mjs:22, 40-54`) | Durable-promise broker |
| `RECEIPT_RESONATE_CALLBACK_URL`, `RECEIPT_EVENT_CALLBACK_URL` | runtime, role sup | `http://127.0.0.1:<receiptPort>/receipt/callback` | Callback target |
| `RECEIPT_RESONATE_*` (heartbeat, redrive, concurrency, stale), `RECEIPT_PROJECTION_*`, `RECEIPT_SERVING_PROJECTION_LOCK_*`, `RECEIPT_QUEUE_*`, `RECEIPT_OBJECTIVE_*`, `RECEIPT_DURABLE_*` | runtime | code defaults | Queue and projection tuning (covered in the runtime report) |
| `JOB_LEASE_MS`, `CHAT_JOB_CONCURRENCY`, `CODEX_JOB_CONCURRENCY`, `CODEX_JOB_LEASE_MS`, `ORCHESTRATION_JOB_CONCURRENCY`, `FACTORY_CONTROL_JOB_LEASE_MS`, `FACTORY_CONTROL_JOB_EXECUTION_TIMEOUT_MS` | runtime | code defaults | Lane tuning |
| `RECEIPT_CODEX_BIN`, `CODEX_HOME`, `CODEX_MODEL_PROVIDER`, `RECEIPT_CODEX_MODEL_PROVIDER`, `RECEIPT_CODEX_MODEL_PREFIX`, `RECEIPT_CODEX_OPENAI_BASE_URL`, `RECEIPT_CODEX_TIMEOUT_MS`, `RECEIPT_CODEX_STARTUP_TIMEOUT_MS`, `RECEIPT_CODEX_STALL_TIMEOUT_MS`, `RECEIPT_CLAUDE_PROXY_BIN`, `CLAUDEN_BIN` | runtime, role sup | bundled Codex.app binary if present else `codex` (`start-resonate-runtime.mjs:27-30`) | Agent executables |
| `RECEIPT_FACTORY_EXECUTION_PATH`, `RECEIPT_FACTORY_COMPUTER_PROVIDER`, `RECEIPT_FACTORY_COMPUTER_ENABLED` | runtime, web, start:all, local:up | `computer`, `opensandbox`, derived | The only execution path; local:up pins all three (`local-up.sh:216-219`) |
| `OPEN_SANDBOX_DOMAIN`, `OPEN_SANDBOX_PROTOCOL`, `OPEN_SANDBOX_IMAGE`, `OPEN_SANDBOX_TEMPLATE_VERSION`, `OPEN_SANDBOX_REMOTE_WORKSPACE_ROOT`, `OPEN_SANDBOX_READY_TIMEOUT_SECONDS`, `OPEN_SANDBOX_REQUEST_TIMEOUT_SECONDS`, `OPEN_SANDBOX_TIMEOUT_SECONDS`, `OPEN_SANDBOX_CPU`, `OPEN_SANDBOX_MEMORY`, `OPEN_SANDBOX_HOST_READY_TIMEOUT_MS`, `OPEN_SANDBOX_HOST_IDLE_STOP_MS` | runtime, web, start:all, local:up | `localhost:8080`, `http`, `receiptfactory/opensandbox-worker:local`, `receipt-factory-opensandbox-v1`, `/workspace/receipt-workspaces`, `120`, `120`, `3600`, `2`, `4Gi`, `180000` (supervisors export `240000`), `1200000` (`opensandbox-config-default-values.ts:1-12`) | Sandbox controller and sizing |
| `OPEN_SANDBOX_GLOBAL_MAX_ACTIVE`, `OPEN_SANDBOX_ORG_MAX_ACTIVE`, `OPEN_SANDBOX_ORG_<ORG_ID>_MAX_ACTIVE` | runtime, role sup, start:all, local:up, deploy | `1`/`1` locally; SST default global `3` (`deploy/sst/config.ts:77-83`) | Lease caps |
| `OPEN_SANDBOX_CLEANUP_ON_FINISH`, `OPEN_SANDBOX_USE_SERVER_PROXY`, `OPEN_SANDBOX_SECURE_ACCESS`, `OPEN_SANDBOX_API_KEY`, `OPENSANDBOX_INSECURE_SERVER`, `OPEN_SANDBOX_AUTO_START`, `OPEN_SANDBOX_AUTO_STOP`, `OPEN_SANDBOX_AWS_INSTANCE_ID`, `OPEN_SANDBOX_AWS_REGION` | runtime, start:all, deploy | start:all sets cleanup `task`, proxy/secure `false`, and `OPENSANDBOX_INSECURE_SERVER=YES` (local controller runs unauthenticated; keep it on loopback) | Controller lifecycle |
| `RECEIPT_OPENSANDBOX_WORKSPACE_SYNC_TIMEOUT_MS`, `RECEIPT_FACTORY_OPEN_SANDBOX_FAIL_ON_DEGRADED`, `RECEIPT_FACTORY_REMOTE_CODEX_STUB`, `RECEIPT_FACTORY_OBJECTIVE_SUPERVISOR_STUB`, `RECEIPT_FACTORY_VALIDATION_STUBS`, `RECEIPT_FACTORY_OBJECTIVE_WATCHDOG_*`, `RECEIPT_FACTORY_REPO_SLOT_CONCURRENCY`, `FACTORY_OBJECTIVE_AUDIT_SYSTEM_IMPROVEMENT`, `RECEIPT_FACTORY_CLOUD_CONTEXT_PROBE_TIMEOUT_MS` | runtime, dev | dev sets fail-on-degraded `false` (`dev-process-cleanup.mjs:16-17`) | Factory control-plane tuning |
| `RECEIPT_REPO_KEY`, `RECEIPT_REPO_ROOT`, `RECEIPT_TENANT_ROOT`, `RECEIPT_LOCAL_STACK`, `RECEIPT_FACTORY_SECRETS_FILE`, `RECEIPT_FACTORY_{OBJECTIVE,TASK,CANDIDATE}_ID`, `RECEIPT_CALLBACK_TOKEN` | runtime, web, wrapper | `receiptfactory` (`.receipt/bin/receipt:18`) | Repo identity and job context |
| `RECEIPT_INTEGRATIONS_PROVIDER`, `RECEIPT_INTEGRATIONS_URL`, `RECEIPT_INTEGRATIONS_SECRET_KEY`, `RECEIPT_INTEGRATIONS_WEBHOOK_SECRET`, `RECEIPT_INTEGRATIONS_PUBLIC_URL`, `RECEIPT_INTEGRATIONS_DATABASE_URL`, `RECEIPT_INTEGRATIONS_INTERNAL_URL`, `RECEIPT_INTEGRATIONS_CONNECT_INTERNAL_URL`, `RECEIPT_INTEGRATIONS_PROXY_HOST` | runtime, receipt-core, gateway, start:all, local:up | `nango`, `http://127.0.0.1:3003`, read from the Nango database (`start-all.mjs`), `receipt-local-webhook-secret` | Nango integration provider |
| `RECEIPT_NANGO_<PROVIDER>_INTEGRATION_ID` (aws, gcp, gcs, github, gitlab, jira x2, confluence x2, slack, notion, linear, sentry, datadog, vercel, terraform, cloudflare, azure-devops, zendesk, incident.io, google-analytics, google-ads, meta-marketing-api, youtube, airtable), `NANGO_AWS_INTEGRATION_ID`, `RECEIPT_NANGO_JIRA_SCOPES`, `RECEIPT_NANGO_CONFLUENCE_SCOPES` | runtime, deploy | none | Per-connector ids |
| `LOCAL_NANGO_DATABASE_URL`, `LOCAL_NANGO_ENCRYPTION_KEY`, `LOCAL_NANGO_DASHBOARD_USERNAME`, `LOCAL_NANGO_DASHBOARD_PASSWORD` | start:all, compose | derived; fixed dev key; `receipt`/`receipt` (`docker-compose.local.yml:28-33`) | Local Nango container |
| `RECEIPT_DEBUG_TOKEN`, `RECEIPT_DEBUG_JWT_SECRET`, `RECEIPT_PROD_DEBUG_TOKEN`, `RECEIPT_PROD_WEB_URL`, `RECEIPT_PROD_DEBUG_WEB_URL`, `RECEIPT_LOCAL_DEBUG_URL`, `RECEIPT_DEBUG_SNAPSHOT_STEP_TIMEOUT_MS`, `RECEIPT_DISABLE_SST_SECRET_LOOKUP`, `RECEIPT_SST_BIN` | runtime/CLI | none | Hosted debug endpoints (operator tooling) |
| `RECEIPT_SIMULATOR_UI_PORT`, `RECEIPT_FORCE_ASCII`, `NO_COLOR`, `TERM`, `RECEIPT_OPENAI_KEY_DEBUG_MODE`, `RECEIPT_RUN_POSTGRES_SCHEMA_BOOTSTRAP_TEST` | runtime/CLI | `4397` | Tooling |
| `AWS_REGION`, `AWS_DEFAULT_REGION`, `AWS_PROFILE`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_EC2_METADATA_DISABLED`, `AWS_PAGER`, `AWS_MAX_ATTEMPTS`, `AWS_RETRY_MODE`, `CLOUDSDK_CORE_DISABLE_PROMPTS`, `AZURE_CORE_ONLY_SHOW_ERRORS` | runtime | none | Set or read when materializing cloud CLI environments for sandboxes |
| `RECEIPT_BUN_BIN`, `BUN_BIN`, `BUN_INSTALL`, `RECEIPT_BUN_AUTO_INSTALL`, `RECEIPT_NPM_BIN` | wrapper, runtime | see `scripts/bun.mjs` | Toolchain resolution |

### 6.8 Service graph and gateway (web `service-gateway.ts`, `receipt-core/service-graph.ts`)

`RECEIPT_WEB_INTERNAL_URL`, `RECEIPT_RUNTIME_INTERNAL_URL`, `RECEIPT_ZERO_INTERNAL_URL`, `RECEIPT_INTEGRATIONS_INTERNAL_URL`, `RECEIPT_INTEGRATIONS_CONNECT_INTERNAL_URL`, `RECEIPT_SLACK_INTERNAL_URL`, `RECEIPT_TEAMS_INTERNAL_URL`, `RECEIPT_RESONATE_INTERNAL_URL`, `RECEIPT_COMPUTER_INTERNAL_URL`, `RECEIPT_OPENSANDBOX_INTERNAL_URL` (backend targets); `RECEIPT_SERVICE_GATEWAY_URL`, `RECEIPT_SERVICE_RUNTIME_URL`, `RECEIPT_PROXY_SERVER_URL`, `RECEIPT_SERVER_URL`, `RECEIPT_RUNTIME_URL`, `RECEIPT_APP_URL`, `RECEIPT_WEB_URL`, `RECEIPT_PUBLIC_BASE_URL` (origins); `RECEIPT_SERVICE_GATEWAY_EXPOSURE` (`public` in AWS, `sst.config.ts:917`), `RECEIPT_SERVICE_GATEWAY_ALLOW_PRIVATE`, `RECEIPT_BUN_IDLE_TIMEOUT_SECONDS`, `RECEIPT_WEB_INTERNAL_PORT`, `WEB_PORT`; `RECEIPT_DEV_BACKEND_URL`, `RECEIPT_CLOUD_BACKEND_URL`, `RECEIPT_DEV_AUTH_COOKIE`, `RECEIPT_DEV_AUTH_SESSION_LINE_FILE`, `RECEIPT_DEV_FRONTEND_URL`, `RECEIPT_DEV_ZERO_CACHE_URL` (the `dev:aws` remote-backend mode in `vite.config.ts` and `dev-aws-backend.mjs`). Prefixes are stable across local and AWS: `/runtime`, `/zero`, `/integrations`, `/integrations-connect`, `/connect`, `/slack`, `/teams`, `/resonate`, `/computer`; `/runtime`, `/resonate`, and `/computer` are private and answer 404 to non-loopback callers unless exposure is `private` or `ALLOW_PRIVATE=1`.

### 6.9 Slack and Teams apps

| Variable | Process | Purpose |
|---|---|---|
| `SLACK_SIGNING_SECRET`, `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_API_BASE_URL`, `SLACK_DEFAULT_PROFILE_ID`, `SLACK_PROGRESS_UPDATE_INTERVAL_MS`, `SLACK_MAX_PROGRESS_MESSAGES_PER_RUN`, `APP_URL`, `PORT`, `BETTER_AUTH_URL`, `RECEIPT_WEB_URL`, `ZERO_UPSTREAM_DB` | slack | Signature verification, OAuth install, tuning, public URL (`apps/slack/*.ts`) |
| `SLACK_OAUTH_STATE_SECRET` | receipt-core (`slack`) | OAuth state signing |
| `SLACK_BOT_TOKEN` †, `SLACK_PRIMARY_TEAM_ID` †, `SLACK_PRIMARY_RECEIPT_ORG_ID` †, `SLACK_ALLOWED_TEAM_IDS` † | none | In `.env.example` (and `SLACK_BOT_TOKEN` in deploy configs) but read by no code |
| `CLIENT_ID`, `CLIENT_SECRET`, `TENANT_ID`, `TEAMS_DEFAULT_PROFILE_ID`, `PORT`, `BETTER_AUTH_URL`, `RECEIPT_WEB_URL`, `ZERO_UPSTREAM_DB` | teams | Azure bot config (`apps/teams/*.ts`) |

### 6.10 Supervisor, dev, and tooling variables

`START_ALL_*` from `scripts/start-all.mjs`: `GATEWAY_PORT` (defaults to `WEB_PORT`, then 3000), `WEB_PORT` 3000, `WEB_INTERNAL_PORT` 3001, `ZERO_CACHE_PORT` 4848, `RECEIPT_PORT` 8787, `SLACK_PORT` 3010, `TEAMS_PORT` 3011, `REDIS_PORT` 6380, `INTEGRATIONS_PORT` 3003, `INTEGRATIONS_CONNECT_PORT` 3009, `RESONATE_PORT` 8001, `RESONATE_METRICS_PORT` 9090, `OPENSANDBOX_PORT` 8080, `POSTGRES_PORT` (derived from `ZERO_UPSTREAM_DB` when localhost, else 5432), `POSTGRES`, `LOCAL_INFRA`, `OPENSANDBOX`, `SLACK`, `TEAMS`, `MARKDOWN_WORKER`, `BUILD_WEB`, `USE_SIGNUP_EMAIL_OTP`, `WAIT_TIMEOUT_SECONDS` 120, `PUBLIC_HTTP_HOST` localhost, `PUBLIC_GATEWAY_URL`, `WORKER_GATEWAY_URL`, `ENV_FILE`, `ENV_FILES`, `LOG_ROOT`, `RECEIPT_POSTGRES_SCHEMA` public, `RECEIPT_SCHEMA_MIGRATION`, `RECEIPT_SCHEMA_TIMEOUT_SECONDS` 360, `ZERO_PUBLICATION_TIMEOUT_SECONDS` 120, `OPENSANDBOX_CONFIG_DIR`, `OPENSANDBOX_CONFIG`, `OPENSANDBOX_INIT_CONFIG`, `OPENSANDBOX_BUILD_IMAGE`, `INTEGRATIONS_DATABASE_NAME` receipt_integrations, `RESET_INTEGRATIONS`, `ENSURE_NANGO_INTEGRATIONS` (`start-all.mjs:11, 60-114, 228-232, 254, 307, 333, 394, 852, 860, 895, 1151`).

`LOCAL_UP_*` from `scripts/local-up.sh:6-30, 361-389`: `DB_RESET` (`auto|1|0`; else `Unsupported LOCAL_UP_DB_RESET='<x>'. Use auto, 1, or 0.`), `BUILD_WEB` 1, `ZERO_UPSTREAM_DB` (default `postgresql://receipt:receipt@localhost:5432/receipt`), `PROVIDER` opensandbox (alias `computer`; else `Unknown provider '<x>'. Use opensandbox.`), `LOG_ROOT`, `RESET_INTEGRATIONS`, and the marker `LOCAL_UP_RUNTIME_ENV_FILE=1`.

`dev` only: `PORT` 3000, `RECEIPT_PORT` 8787, `TANSTACK_DEVTOOLS_PORT` 42069, `START_DEV_POSTGRES` (`dev-with-receipt.mjs:48-59, 80-83`). Mock proxy: `RECEIPT_MOCK_LLM_PORT` 8789, `RECEIPT_MOCK_LLM_HOST`, `RECEIPT_MOCK_LLM_TEXT`, `RECEIPT_MOCK_LLM_SCRIPT`, `RECEIPT_MOCK_LLM_FAILURES`, `RECEIPT_MOCK_LLM_TIMEOUT_MS`. `VALIDATE_STACK_*`: listed in the script's help (`scripts/validate-stack.sh:2336-2375`).

### 6.11 Deploy-time variables (names only)

Read by `sst.config.ts`, `deploy/sst/*.ts`, `scripts/deploy-aws.mjs`, and the CodeBuild/rollout scripts: `RECEIPT_AWS_FACTORY_ACCOUNT_ID`, `RECEIPT_AWS_PRODUCTION_ACCOUNT_ID`, `RECEIPT_AWS_FACTORY_PROFILE`, `RECEIPT_AWS_PRODUCTION_PROFILE`, `AWS_REGION` (default `us-east-1`), `SST_STAGE` (default `factory`), `RECEIPT_PUBLIC_DOMAIN`, `RECEIPT_PUBLIC_DOMAIN_CERT_ARN`, `RECEIPT_PUBLIC_BASE_URL`, `RECEIPT_AWS_ENABLE_CLOUDFRONT`, `RECEIPT_AWS_ENABLE_OPENSANDBOX`, `RECEIPT_AWS_SERVICE_IMAGE_CACHE`, `RECEIPT_AWS_SINGLE_HOST`, `RECEIPT_DATABASE_INSTANCE` (`t4g.large`), `RECEIPT_DATABASE_STORAGE` (`100 GB`), `RECEIPT_REDIS_INSTANCE` (`t4g.small`), `RECEIPT_OPENSANDBOX_INSTANCE_TYPE` (`t3a.xlarge`), `RECEIPT_OPENSANDBOX_ROOT_VOLUME_GB` (60), `RECEIPT_OPENSANDBOX_WORKER_IMAGE_REF|TAG|FORCE_BUILD|CACHE_SALT`, `RECEIPT_{RUNTIME,GATEWAY,SLACK,TEAMS,INTEGRATIONS}_IMAGE_REF`, `ZERO_IMAGE` (`rocicorp/zero:1.5.0`), `RECEIPT_<SERVICE>_MIN_TASKS|MAX_TASKS`, `RECEIPT_FACTORY_LITE_EIP_ALLOCATION_ID` (required for single-host), `RECEIPT_FACTORY_LITE_INSTANCE_TYPE`, `RECEIPT_FACTORY_LITE_ROOT_VOLUME_GB`, `RECEIPT_AWS_OPENSANDBOX_STOP_AFTER_DEPLOY`, `BEETLE_DEPLOY_*` and `BEETLE_RELEASE_*` (CodeBuild project, buckets, secrets name, image services, release tag/manifest), `DOCKERHUB_USERNAME|TOKEN|ACCESS_TOKEN`, `GIT_SHA`, `CODEBUILD_BUILD_ID`, `RECEIPT_LOCAL_VALIDATION_GUARD_PASSED`, `RECEIPT_LOCAL_VALIDATION_COMMIT`, `RECEIPT_PRODUCTION_NANGO_BOOTSTRAP`, and the break-glass overrides `RECEIPT_AWS_ACCOUNT_GUARD=0`, `RECEIPT_ALLOW_IAM_USER_FACTORY`, `RECEIPT_ALLOW_INSECURE_FACTORY_URL`, `RECEIPT_SKIP_LOCAL_VALIDATION_GUARD`, `RECEIPT_SKIP_PREDEPLOY_BUILD`, `RECEIPT_SKIP_NANGO_PREFLIGHT`, `RECEIPT_SKIP_SES_PRODUCTION_GUARD`, `RECEIPT_PREDEPLOY_SOURCE_ONLY`, `RECEIPT_ALLOW_UNPUSHED_DEPLOY`, `RECEIPT_SKIP_PRODUCTION_AWS_PREFLIGHT`, `RECEIPT_ALLOW_PRODUCTION_REMOVE`, `RECEIPT_ALLOW_FACTORY_SECRET_NAME_FOR_PRODUCTION`. Security-baseline settings: `RECEIPT_FACTORY_CLOUDTRAIL_NAME`, `RECEIPT_FACTORY_ACCESS_ANALYZER_NAME`, `RECEIPT_FACTORY_CLOUDTRAIL_BUCKET`, `RECEIPT_FACTORY_BUDGET_EMAIL`, `RECEIPT_FACTORY_BUDGET_USD`, `RECEIPT_FACTORY_BUDGET_NAME`. `deploy/aws-sst.env.example` lists `RECEIPT_AWS_ENABLE_CLOUDFRONT`, the DB/Redis sizes, and the `_MIN/_MAX_TASKS` family nowhere; they are code-only.

### 6.12 Template-only or dead variables (summary)

`AUTH_DEV_EMAIL_OTP_TO_CONSOLE`, `RECEIPT_POSTGRES_MIRROR_URL`, `AI_GATEWAY_API_KEY`, `ANTHROPIC_API_KEY` (test stub only), `VITE_STRIPE_PUBLISHABLE_KEY`, `STRIPE_PRODUCT_ENTERPRISE`, `SLACK_BOT_TOKEN`, `SLACK_PRIMARY_TEAM_ID`, `SLACK_PRIMARY_RECEIPT_ORG_ID`, `SLACK_ALLOWED_TEAM_IDS`, `VITE_ENABLE_ORGANIZATION_PROVIDER_KEYS`, `ENABLE_EMBEDDING`, plus the upstream-template block in `turbo.json` `globalPassThroughEnv` (`WORKOS_*`, `AUTUMN_*`, `VALYU_API_KEY`, `SUPERMEMORY_API_KEY`, `KV_REST_API_*`, `NEXT_PUBLIC_*`, `DUB_API_KEY`, `ADMIN_EMAILS`, `XAI_API_KEY`, `MISTRAL_API_KEY`, `MOONSHOTAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`). Conversely, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `RECEIPT_DEFAULT_FREE_SEAT_COUNT`, `SELF_HOSTED_SETUP_TOKEN` (cloud template), `BETTER_AUTH_USE_SECURE_COOKIES`, `RECEIPT_LEGACY_PUBLIC_ORIGINS`, `ADMIN_EMAIL_ALLOWLIST`, all `EFFECT_*`, all `START_ALL_*`/`LOCAL_UP_*`/`VALIDATE_STACK_*`, and all `OPEN_SANDBOX_*` are read by code but absent from `.env.example`.

---

## 7. Local development

### 7.1 Prerequisites

| Tool | Pin / evidence |
|---|---|
| Node.js 24 | `.node-version` = `24`; `./bunw` is a Node script and `scripts/preflight.mjs` fails on a different major |
| npm | Used once to install the pinned Bun into `.bun/toolchains/`; required by `start-all.mjs:122` and `local-up.sh:81` |
| Bun exactly 1.3.12 | `.bun-version`, `package.json` `packageManager`; never run a bare `bun`, always `./bunw` (`AGENTS.md`) |
| Docker (daemon running) | Postgres (`docker-compose.postgres.yml`), Redis + Nango (`docker-compose.local.yml`), OpenSandbox guests; `start-all.mjs:124` (conditional), `local-up.sh:80` (always) |
| curl | `start-all.mjs:123` |
| git | `receipt doctor` treats missing `git` as blocking |
| `uv`/`uvx` | `start-all.mjs:125` when the OpenSandbox controller starts (`uvx opensandbox-server`) |
| `resonate` server binary >= 0.9.7 | Spawned by `scripts/start-resonate-runtime.mjs`; resolution order `RESONATE_BIN`, `resonate-server`, `resonate` on `PATH`; a basename of `resonate-server` skips the version check and forces the legacy flag set; the supervisor exits when the broker dies |
| `codex` | Factory agent runs only; `receipt doctor` reports it as blocking. Container image pins `0.130.0` (`deploy/Dockerfile.receipt:3`) |
| `gh`, `aws` | Warnings only in `doctor` |

`DEVELOPMENT.md:9-13` still lists only Node, npm, Bun-via-bunw, and Docker; `LOCAL_SETUP.md:24-25, 56-105` (new since `41baea75`, dated 2026-09-07) adds `uv`, `resonate`, and `codex` and is the accurate list.

### 7.2 The three run modes

| | `./bunw run dev` | `./bunw run start:all` | `./bunw run local:up` |
|---|---|---|---|
| Entry | `turbo run dev --filter=tanstack --ui tui` (`package.json:12`) -> `bun scripts/dev-with-receipt.mjs` (`apps/start/package.json:11`) | `bun ./scripts/start-all.mjs` (`package.json:19`) | `bash ./scripts/local-up.sh` (`package.json:21`), which `exec`s `start-all.mjs` (`local-up.sh:397-403`) |
| Web | Vite dev server with HMR on `PORT` | Production Nitro build behind the service gateway (`START_ALL_BUILD_WEB`) | same |
| Postgres | started unless `START_DEV_POSTGRES=0` (`dev-with-receipt.mjs:80-83`) | started unless `START_ALL_POSTGRES=0` | always (`local-up.sh:400`) |
| Zero cache, runtime (all roles), Resonate | yes; runtime `api` role under `bun --watch` (`receipt:dev` sets `RECEIPT_SERVER_WATCH=api`) | yes, no watch | yes |
| Redis, Nango, OpenSandbox controller, gateway, Slack, Teams | no | yes (Slack/Teams/OpenSandbox are optional children; `START_ALL_*=0` skips) | yes; provider forced to `opensandbox` |
| DB reset | no | no | conditional schema probe (`local-up.sh:144-159, 361-389`) |
| Env artifact | none | `.deploy-artifacts/local-up/latest.env` when run by local:up | `<run>/local.env` + `latest.env` symlink (`local-up.sh:161-232`) |
| Logs | inherited stdio | `.deploy-artifacts/start-all/<runId>/<service>.log` (`start-all.mjs:11`) | same |

`dev` needs a real terminal for the Turbo TUI; from a non-interactive shell run `./bunw run --cwd apps/start dev`. `dev` and `local:up` want the same ports and cannot run together. `dev` kills stale listeners that belong to this repo and errors on foreign ones: `Port <n> is already in use by a non-repo process; stop it or change the port.` (`dev-with-receipt.mjs:61-77`). `start:all` instead asserts every service port free on both `127.0.0.1` and `::1` (`start-all.mjs:129-141, 771-776`); Postgres, Redis, and Nango ports are deliberately not preflighted so containers can stay up between runs.

### 7.3 Port map

| Service | Default | Variable that moves it | Started by |
|---|---|---|---|
| PostgreSQL 16 (`wal_level=logical`) | 5432 | `START_ALL_POSTGRES_PORT` (shell, read by compose: `docker-compose.postgres.yml:21`) | all |
| Web (Vite dev) | 3000 | `PORT` (`dev-with-receipt.mjs:52`) | dev |
| Service gateway (public origin) | 3000 | `START_ALL_GATEWAY_PORT` else `START_ALL_WEB_PORT` | start:all, local:up |
| Web internal (Nitro) | 3001 | `START_ALL_WEB_INTERNAL_PORT` / `RECEIPT_WEB_INTERNAL_PORT` | start:all, local:up |
| Nango API / Connect UI | 3003 / 3009 | `START_ALL_INTEGRATIONS_PORT` / `START_ALL_INTEGRATIONS_CONNECT_PORT` | start:all, local:up |
| Slack / Teams apps | 3010 / 3011 | `START_ALL_SLACK_PORT` / `START_ALL_TEAMS_PORT` | start:all, local:up (optional) |
| Zero cache (+ change streamer) | 4848 (+4849) | `START_ALL_ZERO_CACHE_PORT` / `VITE_ZERO_CACHE_URL` | all |
| Redis | 6380 host (compose file alone defaults 6379, `docker-compose.local.yml:5`) | `START_ALL_REDIS_PORT` | start:all, local:up |
| OpenSandbox controller | 8080 | `START_ALL_OPENSANDBOX_PORT` / `OPEN_SANDBOX_DOMAIN` | start:all, local:up |
| Resonate broker / metrics | 8001 / 9090 | `START_ALL_RESONATE_PORT`, `RESONATE_PORT`, `RESONATE_URL` / `START_ALL_RESONATE_METRICS_PORT`, `RESONATE_METRICS_PORT` | all |
| Receipt runtime API | 8787 | `START_ALL_RECEIPT_PORT` / `RECEIPT_PORT` / `PORT` | all |
| Mock LLM proxy | 8789 | `RECEIPT_MOCK_LLM_PORT` | `llm:mock` |
| TanStack devtools | 42069 | `TANSTACK_DEVTOOLS_PORT` | dev |
| Factory simulator UI | 4397 | `RECEIPT_SIMULATOR_UI_PORT` | `receipt:simulate:ui` |

Moving the web port safely requires moving `START_ALL_WEB_PORT`, `START_ALL_PUBLIC_GATEWAY_URL`, `BETTER_AUTH_URL`, and `VITE_BETTER_AUTH_URL` together and rebuilding, because the browser bundle inlines the auth origin (LOCAL_SETUP.md `Port already in use`).

### 7.4 Env loading and the `set -a; source` rule for `local:up`

`scripts/local-up.sh` never reads `apps/start/.env.local`. It resolves every value from the shell with repo-default fallbacks (`local-up.sh:161-232`), writes `.deploy-artifacts/local-up/<ts>/local.env`, exports it line-by-line (`load_runtime_env_file`, `:234-249`, deliberately not `source`d so spaces in paths cannot execute), then `exec`s `start-all.mjs`, whose `loadEnvFile` skips any key already in the environment (`start-all.mjs:987`). So the exported fallbacks outrank `.env.local`. The working recipe (`LOCAL_SETUP.md:596-626`):

```
set -a; source apps/start/.env.local; set +a
export LOCAL_UP_ZERO_UPSTREAM_DB="$ZERO_UPSTREAM_DB"
export START_ALL_SLACK=0 START_ALL_TEAMS=0 START_ALL_WAIT_TIMEOUT_SECONDS=300   # optional
./bunw run local:up
```

Docker Compose has the same property: `docker-compose.postgres.yml:21` reads `${START_ALL_POSTGRES_PORT:-5432}` from the shell. `local-up.sh` also writes placeholder secrets when the shell lacks them (`BETTER_AUTH_SECRET`, `RECEIPT_CONNECT_JWT_SECRET` from it, `RECEIPT_CONNECTION_ENCRYPTION_KEY_B64` from `BYOK_ENCRYPTION_KEY_B64`; `:172-173`) and discovers an organization holding an OpenAI BYOK row to mint `RECEIPT_CONNECT_TOKEN` (`:251-359`, logging `Using local BYOK organization <org>`).

### 7.5 Database: i18n first, then reset or migrate

- `./bunw run --cwd apps/start i18n:compile` must precede `web:db:reset` because the Better Auth migrator imports `auth.server.ts`, which imports the compiled Paraglide bundle (`apps/start/package.json:9`; `db-reset.ts:103` spawns the migrator). `predev` and `prebuild` compile it automatically (`apps/start/package.json:10, 15`).
- `./bunw run web:db:reset` -> `apps/start` `db:reset` (`db-reset.ts`): **destructive**: `DROP PUBLICATION IF EXISTS zero_data`, `DROP TABLE ... CASCADE` for every public base table (`:47, 64`), `bunx @better-auth/cli migrate --yes --config src/lib/backend/auth/auth.server.ts`, then `zero-dev-reset.ts` (re-applies `zero/migrations/schema.sql` and timestamped migrations, recreates `zero_data`, deletes `zero.db*`). Error when unset: `ZERO_UPSTREAM_DB is not set. Set it in apps/start/.env or .env.local.` (`:75`).
- `./bunw run --cwd apps/start zero:migrate` (`zero-migrate.ts:1-22`): forward-only and production-safe: advisory lock `pg_advisory_lock` (`:1173`), Neon schema normalization, Better Auth migrations, migration ledger, `schema.sql` bootstrap on empty databases, timestamped files in lexical order, `zero_data` publication refresh, checksum record; an edited applied file fails with `Migration <file> was already applied with a different checksum. Create a new migration file instead of editing old ones.` (`:1036`).
- The additive first-run path used by `start:all` itself: Better Auth migrate, then the Receipt durable-schema pre-migration (`start-all.mjs:851-889`, skipped with `START_ALL_RECEIPT_SCHEMA_MIGRATION=0`), then `zero:migrate`, then an explicit publication refresh (`:891-928`). Order matters because the publication references runtime projection tables.
- The `zero_data` publication is curated, not `FOR ALL TABLES` (`apps/start/scripts/zero-publication.ts:5-21`); a Zero schema table missing from it silently breaks all client sync. Four `receipt_`-prefixed tables are app-owned public tables (`:27-40`).

### 7.6 `validate:stack`

`bash ./scripts/validate-stack.sh` (`package.json:23`); `--help` prints the option block at `validate-stack.sh:2336-2375` (`VALIDATE_STACK_START`, `_ENV_FILE(S)`, `_FACTORY_RUN`, `_AWS_NEGATIVE_RUN`, `_AWS_NEGATIVE_DIRECT_RUN`, `_AWS_POSITIVE_DIRECT_RUN`, `_AWS_IMPORT_PROFILE`, `_OPENAI_API_KEY`, `_AWS_POSITIVE_PREFLIGHT`, `_AWS_POSITIVE_GATEWAY_URL`, `_CODEX_MODE=real|stub`, `_MIN_FREE_DISK_MB` 8192, `_DISK_TARGET`, `_WAIT_PROGRESS_SECONDS`, `_CHAT_SMOKE`, `_NANGO_HEALTH`, `_CHAT_EMAIL/PASSWORD/MODEL`). It waits on `/health`, zero `/`, runtime `/healthz` and `/readyz`, records health JSON and page snapshots, seeds an isolated validation actor in schema `receipt_validate_stack`, runs `receipt doctor --json`, and optionally real Factory and AWS objectives; artifacts land under `.deploy-artifacts/validate-stack/<runId>/`. `VALIDATE_STACK_START=1` boots `start:all` first and additionally requires `npm`, `uvx`, Docker, and 8 GiB free disk.

### 7.7 The mock LLM proxy

`./bunw run llm:mock` -> `node ./scripts/mock-llm-proxy.mjs` (`package.json:20`). Boots with `Receipt mock LLM proxy listening on http://127.0.0.1:8789/v1` and `Use OPENAI_BASE_URL=http://127.0.0.1:8789/v1 MOCK_OPENAI_API_KEY=mock-key` (`mock-llm-proxy.mjs:517-518`). Implements `GET /health`, `POST /v1/responses` (SSE streaming, JSON-schema structured output, WebSocket upgrade), `POST /v1/embeddings` (deterministic 16-dim), fixture scripts (`RECEIPT_MOCK_LLM_SCRIPT`), and failure injection (`RECEIPT_MOCK_LLM_FAILURES=429,500,malformed,timeout`). The runtime accepts the dummy key only when `OPENAI_BASE_URL` resolves to `localhost`/`127.0.0.1`/`::1` (`receipt-openai-env.ts:52-74`); the printed `mock-key` and the code default `mock-openai-key` differ but any value works because the proxy ignores the bearer.

### 7.8 Stop semantics

There is no `local:down`. Ctrl-C in the supervisor terminal or `pkill -f 'bun \./scripts/start-all\.mjs'` (SIGTERM). `installCleanupHandlers` registers SIGINT/SIGTERM/exit handlers and `cleanup()` kills each child's process group (`start-all.mjs:1082-1090`). **Never `kill -9` the supervisor**: children are spawned `detached` (`start-all.mjs:662`), so SIGKILL leaves the whole tier alive under PID 1 with ports bound (RCA-209). Killing a non-optional child (runtime roles, Resonate, gateway, web) also tears the stack down through `supervise() -> fail() -> cleanup()`. Zero's `change-streamer.js` (Zero port + 1) can outlive shutdown; reap it with `pkill -f 'zero-cache/src/server/'` only after the supervisor is gone. `cleanup()` has no Docker calls, so containers stay up on purpose; stop them with `docker compose ... stop`, and never use `down -v` for a routine stop (it deletes the named volume `receipt_postgres_data` with every user, organization, receipt, and encrypted key). Nothing in `local:up` hot-reloads: the web tier is a prebuilt bundle and every server process runs without `--watch` (`LOCAL_SETUP.md:825-895`).

### 7.9 Troubleshooting table

| Symptom (exact) | Cause | Fix | Source |
|---|---|---|---|
| `Bun 1.3.12 is required and npm is unavailable for the repo-local bootstrap.` | `./bunw` needs npm to install the pinned Bun | install Node 24, or `RECEIPT_BUN_BIN=/path/to/bun-1.3.12 ./bunw install` | `scripts/bun.mjs` |
| `[preflight] Environment is not ready:` + `Node 24.x is required by .node-version ...` | wrong Node major | `nvm use` 24 | `scripts/preflight.mjs` |
| `Resonate CLI <detail> is not compatible with @resonatehq/sdk. Install Resonate >= 0.9.7 or set RESONATE_BIN ...` | old or missing broker; the supervisor exits when it dies | install >= 0.9.7 or set `RESONATE_BIN` | `start-resonate-runtime.mjs` |
| `Could not locate the bindings file` (zero-cache) | `@rocicorp/zero-sqlite3` built for another Node ABI | `start:all`/`local:up` rebuild it (`ensureZeroSqliteBinding`, `start-all.mjs:721`; `local-up.sh:90-117`); `dev` does not; manual `npm run install` in the package dir | `DEVELOPMENT.md:176-183` |
| `Missing required command: docker` / hung `docker info` | Docker Desktop never launched (Gatekeeper), full VM disk, or low host disk | open Docker once; `./bunw run local:release-disk-report` then `local:lima:prune` | `validate-stack.sh`, LOCAL_SETUP.md |
| `Port <n> is already in use on 127.0.0.1.` / `... on ::1.` | orphaned earlier stack or foreign process | SIGTERM the old supervisor, free or move the port (move auth URLs together) | `start-all.mjs:771-776` |
| Health checks answer but `local:up` will not start | previous supervisor was `kill -9`ed | `pkill -f 'bun \./scripts/start-all\.mjs'`, verify with `lsof -nP -iTCP -sTCP:LISTEN` | RCA-209 |
| Port 4849 stays bound after shutdown | detached Zero change-streamer | `pkill -f 'zero-cache/src/server/'` after stopping the supervisor | LOCAL_SETUP.md 6B |
| The UI loads but no data ever syncs | a table is missing from `zero_data`, or Postgres lacks `wal_level=logical` | `./bunw run --cwd apps/start zero:reset` (or `zero:migrate` on a live stack); use the bundled compose file | RCA-001, `AGENTS.md` |
| zero-cache exits after a schema reset | stale `apps/start/zero.db` replays `CREATE TABLE` | delete `zero.db*` (or `zero:reset`) | RCA-499 |
| `relation "<schema>.receipt_job_projection" does not exist` during `zero:migrate` | publication refresh ran before the runtime schema existed | run the Receipt pre-migration first, as `start-all.mjs` does | RCA-295 |
| `Missing required environment variable BETTER_AUTH_SECRET.` / `Missing BETTER_AUTH_URL. ...` / `Missing required environment variable ZERO_UPSTREAM_DB.` / `Receipt Postgres storage requires ZERO_UPSTREAM_DB.` | read at import time | set them in `apps/start/.env.local` | section 6.1 |
| Sign-in fails with CORS errors after changing the web port | `VITE_BETTER_AUTH_URL` baked with another origin | set `START_ALL_WEB_PORT`, `START_ALL_PUBLIC_GATEWAY_URL`, `BETTER_AUTH_URL`, `VITE_BETTER_AUTH_URL` to one origin and rebuild | RCA-253 |
| `local:up` ignores `apps/start/.env.local` | it reads the shell, not the file | `set -a; source apps/start/.env.local; set +a` first | section 7.4 |
| Type errors about `@/paraglide/messages.js` | generated i18n wiped by a build | `./bunw run --cwd apps/start i18n:compile`; do not run build and typecheck in parallel | LOCAL_SETUP.md |
| `ENOTEMPTY` running app tests | two Vitest runs racing on `pretest` i18n compile | never run two `--cwd apps/start test` commands concurrently | RCA-470 |
| `Platform-funded OpenAI access is unavailable: OPENAI_API_KEY is not configured.` / no model | no organization BYOK key yet | add a provider key in org settings, or use the mock proxy | section 7.7 |
| `Unsupported Factory computer provider '<x>'. OpenSandbox is the only supported provider.` | `RECEIPT_FACTORY_COMPUTER_PROVIDER` set to anything else | unset it; `start-all` warns `Ignoring unsupported Factory computer provider; using OpenSandbox.` | runtime execution policy |
| `OPEN_SANDBOX_IMAGE must reference a published image when Receipt workers use a public gateway.` | local-only image with a remote worker | set a published `OPEN_SANDBOX_IMAGE` or keep the gateway local | `opensandbox-config-env-runtime.ts` |
| `Remote OpenSandbox workers cannot use a private Receipt Connect gateway.` | controller disabled but worker gateway is loopback/private | set `RECEIPT_CONNECT_WORKER_GATEWAY_URL`, `START_ALL_WORKER_GATEWAY_URL`, `START_ALL_PUBLIC_HTTP_HOST`, or `RECEIPT_CONNECT_PUBLIC_GATEWAY_URL` | `start-all.mjs:148-165` |
| `Local Nango secret key was not found. Receipt Connect provider auth may fail.` | Nango's `prod` environment row not yet created | let Nango finish first boot and restart, or set `RECEIPT_INTEGRATIONS_SECRET_KEY` | `start-all.mjs` |
| `<service> exited unexpectedly. Check .deploy-artifacts/start-all/<runId>/<service>.log` | non-optional child died | read the log; Slack/Teams/OpenSandbox only warn `<name> exited; continuing with degraded local capabilities.` | `start-all.mjs` |
| `Timed out waiting for <label> at <url>. Check logs in <runDir>` | `START_ALL_WAIT_TIMEOUT_SECONDS` (120) elapsed; first Nango boot and image build are slow | `START_ALL_WAIT_TIMEOUT_SECONDS=300` | `start-all.mjs:113` |
| `validate:stack needs at least 8192 MiB free on <mount> ...` | free-disk floor | free disk or lower `VALIDATE_STACK_MIN_FREE_DISK_MB` | `validate-stack.sh` |

`docs/agent-fix-checklist.md` (21,286 lines, through `RCA-523`) is the internal incident log these entries paraphrase; cite it as engineering history, never republish it.

---

## 8. Deployment

### 8.1 Topologies in the repo

**A. SST multi-service on AWS (`factory` and `production` stages).** `sst.config.ts` (1,491 lines), app name `receipt-factory`, default stage `factory`, protected stages `factory` and `production` (`removal: "retain"`, `protect: true`; escape `RECEIPT_ALLOW_PRODUCTION_REMOVE=1` on production only) (`sst.config.ts:9-35`). Shared resources: `Network` VPC, `ZeroBackups` and `AppFiles` buckets, `Database` (RDS Postgres 17 with `rds.logical_replication=1` forced in the parameter group), optional `AuthEmail` SES identity when `AUTH_EMAIL_PROVIDER=ses` (`:84-104, 241`). Full-stack services, each built by `createReceiptService` (`deploy/sst/service.ts`): `Gateway` (`deploy/Dockerfile.receipt-web`, ALB `:3000`, `RECEIPT_SERVICE_GATEWAY_EXPOSURE=public`), `Runtime` (`deploy/Dockerfile.receipt`, `RECEIPT_PROCESS_ROLE=api`), `RuntimeDriver`, `RuntimeWorkerControl`, `RuntimeWorkerChat`, `RuntimeWorkerCodex` (same image, one role each), `Resonate` (same image, Resonate entrypoint, singleton), `Integrations` (`deploy/Dockerfile.nango`), `ZeroReplicationManager` and `ZeroViewSyncer` (`ZERO_IMAGE`, default `rocicorp/zero:1.5.0`), `Slack`, `Teams` (`sst.config.ts:425-453, 484-508, 535, 584, 728-745, 779-788, 845, 869, 890-892`). `Cluster`, `Redis` (ElastiCache), `ReceiptData` and `ZeroData` EFS volumes, and a `GatewayCdn` CloudFront edge unless `RECEIPT_AWS_ENABLE_CLOUDFRONT=0` (`:966-985`). The gateway bakes `VITE_APP_INSTANCE_MODE: "cloud"`, `VITE_ENABLE_EMBEDDING: "false"`, and the OTP flag (`:904-906`). An OpenSandbox EC2 host is created unless `RECEIPT_AWS_ENABLE_OPENSANDBOX=0`.

**B. Single-host "Receipt Lite" (`factory-lite`, `single-host`, or `RECEIPT_AWS_SINGLE_HOST=1`).** `deploy/sst/single-host.ts` (674 lines): one EC2 instance (`RECEIPT_FACTORY_LITE_INSTANCE_TYPE`, default `t3a.xlarge`; root volume `RECEIPT_FACTORY_LITE_ROOT_VOLUME_GB`), requires `RECEIPT_FACTORY_LITE_EIP_ALLOCATION_ID` (`:30-33`), stores the whole env file as one SSM SecureString (`:162`), writes a Docker Compose file and a Caddyfile, runs `zero:migrate` at bootstrap (`:324`), and polls `http://127.0.0.1:3000/health` (`:330`). Compose services: `redis:7-alpine`, `resonate`, `runtime-api` (healthcheck `/healthz`), `runtime-driver`, `runtime-worker-control`, `runtime-worker-chat`, `runtime-worker-codex`, `integrations`, `slack`, `teams`, a single `zero-view-syncer`, `gateway` (published on `127.0.0.1:3000` only), and `edge` (`caddy:2-alpine`, automatic TLS) (`:495-670`). `userDataReplaceOnChange: true` (`:349`) means a compose/env template change replaces the host. In-place application rollouts use `bun run single-host:rollout` (`scripts/single-host-rollout.mjs`: SSM command that backs up compose/env, pulls immutable ECR refs, rewrites `image:` lines, re-runs `zero:migrate` when the gateway image changed, recreates containers, health-checks; default services `runtime,gateway,integrations,teams`, `:44`). Power control: `factory-lite:{status,down,up}`.

**C. The CodeBuild path.** `.github/workflows/deploy-factory.yml` runs after a green `CI` on `main` (or manual dispatch), assumes an OIDC role, uploads a source archive, and starts a CodeBuild project through `scripts/start-beetle-deploy.mjs --wait` (`deploy-factory.yml:3-11, 24-43`). The buildspec (`deploy/codebuild/beetle-deploy.buildspec.yml`) builds and pushes images, then runs `bun run deploy:aws --stage <stage>`. Production must promote an immutable release manifest rather than rebuild.

`scripts/deploy-aws.mjs` accepts only `factory` and `production`; the lite stage has no wrapper for its first provisioning (an open question carried from the prior corpus).

### 8.2 The service gateway

`apps/start/scripts/service-gateway.ts` fronts every deployment (local `start:all`, Fargate `Gateway`, single-host `gateway`). Route prefixes and exposure come from `packages/receipt-core/src/service-graph.ts` (section 6.8). Private prefixes (`/runtime`, `/resonate`, `/computer`) 404 to public callers. The gateway carves out Nango's root paths (`/oauth`, `/api-auth`, `/providers`, ...) while keeping `/auth/*` with the app, and rewrites Nango Connect asset paths under `/integrations-connect/assets`.

### 8.3 Health endpoints

| Service | Path | Body | Source |
|---|---|---|---|
| Web / gateway | `GET` or `HEAD /health` | `{"ok":true}` | `apps/start/src/routes/health/route.tsx:6-19` |
| Runtime | `GET /healthz` (always 200) | `ok, ready, degraded, uptimeSec, dataDir, processRole, queue, postgres, codexBin, resonateUrl` | `packages/receipt-app/src/server/bootstrap.ts:2710-2725` |
| Runtime | `GET /readyz` (200 or **503**) | `ok, ready, degraded, uptimeSec, processRole, postgres` | `bootstrap.ts:2728-2737` |
| Zero | `GET /` (local), `/keepalive` (ECS) | | `start-all.mjs`, `sst.config.ts:567-622` |
| Nango | `/integrations/health` through the gateway | Nango JSON | service graph |
| OpenSandbox controller | `/health` on 8080 | | `deploy/sst/config.ts:14` |

Gate on `/readyz`, not `/healthz`: liveness answers before the runtime can serve.

### 8.4 Secrets bundle (names only)

Generated by `bun run factory:secrets:create` into `deploy/factory.secrets.env` (mode 0600, gitignored) and loaded with `bun run factory:secrets:load` (`deploy/factory.secrets.env.example`): required `BetterAuthSecret`, `ByokEncryptionKeyB64`, `ReceiptConnectJwtSecret`, `ReceiptConnectionEncryptionKeyB64`, `ReceiptDebugToken`, `ReceiptDebugJwtSecret`, `IntegrationSecretKey` (the Nango `prod` environment key, UUID v4, obtained after the first deploy), `IntegrationWebhookSecret`, `ZeroAdminPassword`, `NangoEncryptionKey`, `NangoDashboardPassword`, `OpenSandboxApiKey`; optional `SlackClientId`, `SlackClientSecret`, `SlackSigningSecret`, `SlackBotToken`, `TeamsClientId`, `TeamsClientSecret`, `TeamsTenantId`, `ResendApiKey`, and per-connector Nango OAuth pairs (`NangoJira*`, `NangoConfluence*`, `NangoNotion*`, `NangoZoho*`, `NangoGithub*`, `NangoAirtable*`, `NangoGoogleAds*`, `NangoGoogleAnalytics*`, `NangoYoutube*`, `NangoTiktokAds*`, `NangoInstagram*`, `NangoMetaMarketingApi*`, `NangoSlack*`). The loader validates that the three 32-byte keys are exactly 32 decoded bytes and that `IntegrationSecretKey` is a UUID v4.

### 8.5 Release manifest immutability guard

`scripts/beetle-release-manifest.mjs:67-68` rejects any image ref matching `:latest` or containing `sst-asset:` with `Release manifest <NAME> must be immutable, not <value>.` Production starts must pass `--release-tag` or `--release-manifest-s3-uri` (`scripts/start-beetle-deploy.mjs`), and the launcher refuses unpushed or detached HEADs unless `RECEIPT_ALLOW_UNPUSHED_DEPLOY=1`.

### 8.6 Migration ordering on deploy

Full stack: after `sst deploy`, `deploy-aws.mjs` starts a one-off Fargate task from the Gateway task definition running `bun run --cwd apps/start zero:migrate`, waits for it, then waits for all services to stabilize, validates each task definition's env contract, and provisions Nango integrations. Single-host: `zero:migrate` at bootstrap (`single-host.ts:324`) and on every rollout that changes the gateway image. Locally: Better Auth migrate -> Receipt durable-schema pre-migration -> `zero:migrate` -> publication refresh (`start-all.mjs:41-49, 851-928`). Rules: add a new timestamped file under `apps/start/zero/migrations/`; never edit an applied one; publication membership changes in the same migration as a table change; a replicated table added to the client schema needs the browser-storage namespace bumped.

### 8.7 Domain and TLS

Route 53: set `RECEIPT_PUBLIC_DOMAIN`; SST provisions the ALB listener `80 -> redirect 443` and `443 -> 3000` with health path `/health` (`sst.config.ts:464-479`). External DNS: create an ACM cert and set `RECEIPT_PUBLIC_DOMAIN_CERT_ARN` (`deploy/sst/config.ts:56-57`). Always set `RECEIPT_PUBLIC_BASE_URL` to the final HTTPS origin; `guardPublicBaseUrl` rejects localhost and `*.cloudfront.net` origins. Single-host: Caddy terminates TLS for the public host (`single-host.ts:221`); `bun run single-host:domain` performs a transactional hostname cutover with rollback. `bun run receipt:prod:domain-preflight` verifies DNS, certificate, and ACM coverage without mutating anything.

### 8.8 Email providers, object storage, Redis, vector store, markdown worker, Nango image, OpenSandbox controller

- **Email**: `AUTH_EMAIL_PROVIDER` = `disabled | resend | ses | smtp` (section 6.2). Production deploys require `ses` with a verified identity and `VITE_DISABLE_EMAIL_VERIFICATION_OTP=false` (`deploy-aws.mjs` auth-email guard; override `RECEIPT_SKIP_SES_PRODUCTION_GUARD=1`). Self-hosted instances can use SMTP; without any transport, invitations become copyable links (`auth.service.ts:695`).
- **Object storage**: `UPLOAD_STORAGE_PROVIDER` = `cloudflare_r2` or `s3_compatible` (section 6.6); the self-host template defaults to `s3_compatible`. Required for attachments and for the setup wizard's "Object storage" check (`instance.server.ts:73-77`).
- **Redis**: `REDIS_URL`; ElastiCache (`sst.aws.Redis`) in the full stack, `redis:7-alpine` on the lite host and locally; `VITE_DISABLE_REDIS=true` uses the in-memory fallback.
- **Vector store**: Qdrant through `QDRANT_URL`; hosted deploys hardcode `VITE_ENABLE_EMBEDDING: "false"` (`sst.config.ts:311, 906`), and no Qdrant resource exists in `sst.config.ts`.
- **Markdown worker**: `workers/markdown-converter` is a Cloudflare Worker exposing `POST /convert` (Workers AI); deploy with `bun run setup:markdown-worker` or `worker:deploy`, secret `INTERNAL_TOKEN`, then set `CF_MARKDOWN_WORKER_URL` and `CF_MARKDOWN_WORKER_TOKEN` (`workers/markdown-converter/README.md`). Optional; the setup wizard reports it as `optional_missing`.
- **Nango image**: `deploy/Dockerfile.nango` from `nangohq/nango-server:hosted-0.69.48` with vendored patches (Knex transaction fix, dynamic MCP OAuth, Zendesk, Google Calendar MCP, Azure DevOps Entra OAuth, and, new since `41baea75`, an Azure service-principal provider for Agent Registry discovery, `Dockerfile.nango:132-140`). Exposes 3003 and 3009.
- **OpenSandbox controller**: locally `uvx opensandbox-server` with `OPENSANDBOX_INSECURE_SERVER=YES` on loopback; on AWS an EC2 host bootstrapped by user data with `opensandbox-server==0.2.2`, an SSM-delivered `OPEN_SANDBOX_API_KEY`, idle stop after 20 minutes, and `OPEN_SANDBOX_CLEANUP_ON_FINISH=task`.

### 8.9 Self-hoster obligations versus Kentron-internal operations

A self-hoster must: pick a topology, set `RECEIPT_PUBLIC_DOMAIN`/`RECEIPT_PUBLIC_BASE_URL` and an account id, generate and load the secrets bundle, choose an email provider and storage provider, run the first deploy, obtain the Nango `prod` key and redeploy, and keep the two encryption keys stable. The following are Kentron-internal and must not be published: the AWS account id hardcoded as a fallback in `scripts/single-host-rollout.mjs:9` and sibling scripts (document `RECEIPT_AWS_FACTORY_ACCOUNT_ID=<your account id>` instead), the named AWS profiles in `package.json:90-91` and `deploy/aws-sst.env.example`, the CodeBuild project/secret/bucket names beyond their patterns, `docs/deploy/app-kentron-ai-cutover-todo.md`, `docs/prod-readiness-metrics.md` "Current Release Blockers", `docs/deploy/aws-coder-two-developer-runbook.md`, the `receipt:aws:*`/`receipt:prod:*` operator scripts, the `/api/admin-metrics` console, and `docs/agent-fix-checklist.md` as a whole. Also note the repo hygiene issue: a personal Tailscale hostname in `apps/start/vite.config.ts` `server.allowedHosts` and a personal GitHub repository as the default `RECEIPT_CLI_REPO_URL` in `scripts/install-receipt-cli.sh`.

---

## 9. Self-hosted mode

Build with `VITE_APP_INSTANCE_MODE=self_hosted` (template `apps/start/.env.self-host.example`, which also carries `SELF_HOSTED_SETUP_TOKEN`, `RECEIPT_REPO_KEY`, `VITE_ENABLE_EMBEDDING=false`, `ALLOW_USER_COST_DISPLAY=true`, `VITE_DISABLE_REDIS=false`, `UPLOAD_STORAGE_PROVIDER=s3_compatible`). CI builds in this mode (`ci.yml:22-23`, `VITE_SELF_HOST_SOURCE: render`).

### 9.1 The `/setup` wizard

`/setup` redirects to `/chat` in cloud, and to `/auth/sign-in` once setup is complete (`routes/setup/route.tsx:6-22`). Step 1: `"Hello Human"`, `"Enter the setup token to claim this instance."` (or the Railway variant `"Thanks for self-hosting Receipt on Railway. Enter the setup token to claim this instance."` when `VITE_SELF_HOST_SOURCE=railway`), field `"Setup token"`, placeholder `"Paste the token here"`, help `"Use the token from your self-hosted setup."` / `"Use the token you set when you deployed Receipt on Railway."`; the token may arrive as `?setupToken=`, `?setup-token=`, or `?token=` (`setup-page.logic.ts:58`). Step 2: `"Create your admin account"`, `"Finish setup by creating the first admin account."`, fields `Name` (`John Doe`), `Email` (`owner@example.com`), `Password` (`Create a password`), `Confirm password` (`Confirm your password`), button `"Create account"`. Errors: `"Setup token is required."`, `"The setup token is invalid."`, `"The setup token is not configured yet."`, `"Unable to verify the setup token."`, `"Self-hosted setup has already been completed."`, `"Setup is only available in self-hosted mode."`, `"Name is required."`, `"Enter a valid email address."`, `"Password must be at least {count} characters long."`, `"Failed to finish setup."`, `"Setup finished for {email}. Please sign in once more."` (`setup_*`).

Server side: `verifySelfHostedSetupToken` uses `timingSafeEqual` against `SELF_HOSTED_SETUP_TOKEN` (`instance-settings.service.ts:214-231`); `runSelfHostedSetupAction` takes the advisory lock `self_hosted_setup_claim`, calls `auth.api.signUpEmail` with header `x-receipt-setup-token`, and marks the instance claimed (`instance.server.ts:170-243`, `instance-settings.service.ts:40, 161, 235`). The setup snapshot renders a readiness checklist: required `App URL` (`BETTER_AUTH_URL`), `Auth secret`, `Postgres` (`ZERO_UPSTREAM_DB` or `DATABASE_URL`/`DATABASE_PUBLIC_URL`), `Redis` (or `disabled` when `VITE_DISABLE_REDIS`), `Object storage`, `Setup token`; optional `Markdown worker`; and `PostHog`, `Stripe billing`, `Auth email`, `Social sign-in` reported as `not_available_in_self_host` (`instance.server.ts:36-105`). The `Auth email` entry is misleading now that SMTP invitations work in self-hosted mode (`auth.service.ts:692-695` comment); flag it.

### 9.2 Signup policies

Stored on the singleton `instance_settings` row (`id='default'`), created with `signup_policy='invite_only'` and `public_app_locked=true` (`instance-settings.service.ts:5, 39, 87-100`). The pre-signup guard (`auth.service.ts:272-333`) enforces: unclaimed instance -> `401 SELF_HOSTED_SETUP_REQUIRED` `"This self-hosted instance has not been claimed yet. Complete setup first."`; `open` -> allowed; `shared_secret` -> header `x-receipt-signup-secret` or body `selfHostedSignupSecret` must verify against the scrypt hash (`:345-364`) else `403 SELF_HOSTED_SIGNUP_SECRET_INVALID` `"A valid shared signup secret is required for this instance."`; `invite_only` -> a pending, unexpired, case-insensitive invitation must exist else `403 SELF_HOSTED_INVITE_ONLY` `"This self-hosted instance currently accepts invite-only signups."`; missing email -> `400 SELF_HOSTED_SIGNUP_EMAIL_REQUIRED`. **`updateSelfHostedSignupPolicy` exists (`instance-settings.service.ts:281`) but has no caller** in `apps/start/src`; there is no UI or route to change the policy after setup (classification: absent). `publicAppLocked` makes every `(app)` route require a non-anonymous session (`routes/(app)/_layout/route.tsx:5-28`).

### 9.3 Behavior differences (consolidated)

| Behavior | cloud | self_hosted |
|---|---|---|
| Root `/` | landing page only on `beetle.run`; else `/auth/sign-up` | always `/auth/sign-up` (which then redirects to `/auth/sign-in` or `/setup`) |
| Email OTP, verification, password reset | on (unless OTP disabled) | off; endpoints blocked |
| Google, anonymous, Stripe, `changeEmail`, PostHog key | on when configured | off |
| Default plan / seats / credit | `free` / `RECEIPT_DEFAULT_FREE_SEAT_COUNT` (5) / USD 5 | `self_hosted` / 100000 / 0; usage metering disabled |
| `/pricing` | Stripe flow | static "Self-hosted instance" card |
| Invitations | emailed | emailed when a transport exists, else copyable `<origin>/auth/sign-up?invitationId=<id>` links |
| Zero auth | cookie or token | always access token (`provider.tsx:86`) |
| Sign-up footer | shown | hidden |

---

## 10. Health and observability

- `/health` (web), `/healthz` and `/readyz` (runtime), Zero `/` or `/keepalive`, Nango `/integrations/health`, controller `/health` (section 8.3).
- Logs: local per-service logs under `.deploy-artifacts/start-all/<runId>/`; runtime and web log JSON in production (`EFFECT_LOG_FORMAT` default `json` when `NODE_ENV=production`, `server-observability.layer.ts:44-52`).
- PostHog: `POSTHOG_PROJECT_API_KEY` (ignored in self-hosted), `POSTHOG_HOST` (default US cloud), release/environment from `RAILWAY_*`/`GITHUB_SHA`/`NODE_ENV`; a browser bootstrap (`components/app/posthog-client-bootstrap.tsx`) and a backend drain for chat wide-events (`lib/backend/chat/observability/*`). Source-map upload variables are inert.
- OTLP: the Effect observability layer exports logs/traces/metrics when `EFFECT_OTLP_BASE_URL` is set, with headers from `EFFECT_OTLP_HEADERS_JSON`, service name/version from `EFFECT_SERVICE_NAME`/`EFFECT_SERVICE_VERSION`, and minimum level `EFFECT_MIN_LOG_LEVEL` (default `Warn`) (`server-observability.layer.ts:5-7, 85-86, 136`). No `OTEL_*` variables are read anywhere in the repo; the runtime (`packages/receipt-app`) has no OTLP exporter of its own.
- Admin metrics: `/api/admin-metrics`, gated as in section 3.9.

---

## 11. How other components depend on Core

Shared services in Core and their consumers (input for the architecture diagram):

| Core service | Where it lives | Consumers |
|---|---|---|
| Auth and session resolution | `auth.service.ts`; `server-session.service.ts` `getSessionFromHeaders`; `server-effect/http/server-auth.ts` (`getServerAuthContext`, `requireUserAuth`) | Chat API (`routes/api/chat`), files, org, receipt-trail, receipt-connect, sessions, Slack/Teams claim functions, settings/billing/usage/tasks server functions (15 import sites across `apps/start/src`); the CLI device-login route (`routes/api/receipt-connect/cli-login`) |
| Zero sync auth | `routes/api/zero/{query,mutate,token}` via `requireZeroAppUserAuth` (cookie or `x-receipt-zero-token`/bearer) | Browser (Zero client), the Zero analyzer, `validate:stack` probes |
| Organization and workspace resolution | Better Auth `organization` plugin + `packages/receipt-app/src/services/receipt-workspaces.ts` (`requireReceiptWorkspaceMembership`, `receiptWorkspaceEffectiveRole`) | Web MCP Gateway and Workspaces pages, runtime Connect routes (`receipt-connect-routes.ts:76, 794, 1004`), Slack app (6 imports of `@receipt/app/receipt-workspaces`), CLI `workspace` commands |
| Receipt Connect JWT issuance and verification | `packages/receipt-app/src/services/receipt-connect-auth-token.ts` (HS256, `RECEIPT_CONNECT_JWT_SECRET` with `BETTER_AUTH_SECRET` fallback, 12 h) | Web `issueReceiptConnectWebToken`, CLI device login (scopes `connect:credential`, `connect:read`, `connect:write`, TTL 10 min, poll 2 s, 10 starts/60 s, 3 active, `cli-login/route.tsx:12-21`), runtime `verifyReceiptConnectJwt` (`receipt-connect-routes.ts:683`), Slack and Teams (`@receipt/app/receipt-connect-auth`), sandbox workers (`RECEIPT_CONNECT_TOKEN`) |
| Encryption keys | `byok-crypto.ts` (`BYOK_ENCRYPTION_KEY_B64`), `receipt-connect-config.ts` (`RECEIPT_CONNECTION_ENCRYPTION_KEY_B64`) | Web BYOK settings, runtime model funding, Connect connections, `receipt-core/service-graph.ts` contract checks |
| Model key resolution | `receipt-openai-env.ts` (`readOrgOpenAiByokApiKey`, loopback mock), `factory-model-funding.ts`, `platform-openai-key.ts`; web `model-gateway.service.ts` | Web chat, runtime Factory, Slack (`@receipt/app/receipt-openai-env`) |
| Receipt store | `packages/receipt-app/src/adapters/postgres.ts` `createPostgresReceiptStoreContext` over `ZERO_UPSTREAM_DB` and `RECEIPT_POSTGRES_SCHEMA` | Runtime, workspace projections, Slack thread receipts (`appendSlackThreadReceipt`), Teams thread flow |
| Job queue and durable execution | runtime queue with `receipt_job_projection` (`runtime-contracts.ts:495`), Resonate broker | Web chat dispatch, Slack/Teams (`chat-layer-routing`, `runtime-fetch-retry`), CLI Factory commands |
| Service graph | `receipt-core/service-graph.ts`, `apps/start/scripts/service-gateway.ts`, `@receipt/app/service-url` | Every process that addresses another (Slack/Teams import `service-url`), SST and single-host compose |
| Billing and entitlements | `auth-billing-hooks.ts`, `default-organization.service.ts`, `workspace-usage/*`, `platform-credit-settlement` | Members/invite UI, Stripe plugin hooks, Slack (`@receipt/app/platform-credit-settlement`), runtime funding |

Slack and Teams are thin: each resolves the Receipt user through an installation-claim link created on the web (`/auth/slack-install`, `/auth/teams-install`), then calls Core over the service graph with a Connect JWT (`apps/slack/server.ts:588`, `resolveSlackUser`; imports listed above).

---

## Changes since 41baea75

43 commits. In-scope behavioral changes, verified by diff:

1. **Root `/` redirect** (`c3c16be6`, `apps/start/src/routes/index.tsx`): self-hosted always redirects to `/auth/sign-up`; cloud renders the marketing page only when the request host is `beetle.run`/`www.beetle.run`, otherwise redirects to `/auth/sign-up`. Previously `/` rendered `LandingPage` unconditionally.
2. **`RECEIPT_DEFAULT_FREE_SEAT_COUNT`** (`c3c16be6`, `workspace-usage/shared.ts:20-34`): the free seat ceiling is now a deploy-time override (positive integer, default 5).
3. **Pending workspace invitations and creator attribution** (`c3c16be6`, `receipt-workspaces.ts`, `receipt-connect.server.ts`): workspace member lists merge pending Better Auth org invitations and workspace-only invitations with a `Pending` state; `cancelReceiptWorkspaceInvitationAction` added; workspace rows carry `createdBy`.
4. **Sidebar UI pass** (`46652e84`): group tooltips removed from `app-sidebar.tsx` and `sidebar-organization-menu.tsx`; a mobile table layout and a single tab strip elsewhere. No tenancy semantics changed.
5. **Public CLI onboarding** (`9b8b7574`, `3c52d87c`, `53f74bed`): the release build bakes the hosted origin (`RECEIPT_CLI_DEFAULT_PROD_GATEWAY_URL`, default `https://app.kentron.ai`), disables dotenv/bunfig autoload, and smoke-tests `receipt doctor --json` (`build-receipt-cli-release.sh:7-9, 56-80`); `receipt-connect-command-proxy.ts` gained `buildTimeProdGatewayUrl` and `sameNormalizedReceiptConnectUrl` (`:58-74, 374-396, 591-597`); the public binary gained `login`, `logout`, and read-only `doctor` (`connect-cli.ts:1136-1144`); `setup` refuses expired 12 h sessions and re-activates the chosen target (`receipt-cli-session.ts`: `activateReceiptCliSession`, `isReceiptCliSessionExpired`); `connect` subcommands use the saved session unless env identity is set; the "not signed in" hint names `receipt setup`. The prod-URL error now reads `... Set RECEIPT_CONNECT_PUBLIC_GATEWAY_URL=https://app.kentron.ai and re-run, or set RECEIPT_CONNECT_PROD_GATEWAY_URL, RECEIPT_CONNECT_PROD_URL, or RECEIPT_CONNECT_URL.` `docs/receipt-cli.md` documents `v0.1.0-preview.7` and the local-target variables.
6. **`.env.example`** (`a6a32fc7`): the Receipt Connect comment now says release binaries bake the hosted origin and points to LOCAL_SETUP.md for the local target.
7. **`apps/start/package.json`**: `check-types` now runs with `NODE_OPTIONS=--max-old-space-size=6144`.
8. **`LOCAL_SETUP.md`** (new, 1,275 lines, `48cdeca8` then `a6a32fc7`) and **`AGENTS.md`** (+46 lines about the code-review-graph MCP tools). LOCAL_SETUP.md is the most accurate local guide; its 6A-6C sections were executed on a real machine (with non-default ports).
9. **Nango image**: new Azure service-principal provider patch (`deploy/Dockerfile.nango:132-140`, `deploy/patches/nango-azure-service-principal.mjs`).
10. **Slack**: routing failures now post `CHAT_ROUTING_UNAVAILABLE_MESSAGE` and record a `slack.thread.routing_failed` receipt instead of launching an unscoped task (`apps/slack/server.ts:698-729`).

Not changed since `41baea75`: `auth.service.ts`, `app-feature-flags.ts`, the sign-in/sign-up/setup/accept-invitation components, `default-organization.service.ts`, `instance-settings.service.ts`, `scripts/start-all.mjs`, `scripts/local-up.sh`, `sst.config.ts`, `deploy/sst/*`, `scripts/deploy-aws.mjs`, `README.md`, `DEVELOPMENT.md`.

---

## Documentation implications

**Claim freely (supported):** email + password accounts with 8..128-character passwords; cloud email-OTP verification (6 digits, 5 minutes, 5 attempts) and OTP-based password reset; up to 10 concurrent sessions with revocation from Settings; organizations auto-created at signup, up to 10 per user, owner/admin/member roles; batched invitations (10 per dialog) with 48-hour expiry and seat capacity enforcement; a per-deployment free seat ceiling via `RECEIPT_DEFAULT_FREE_SEAT_COUNT`; a Default workspace per organization plus named workspaces reachable to every member; a self-hosted mode with a token-claimed first admin, invite-only default signup, SMTP invitations, and no Stripe; encrypted BYOK keys and Connect bundles with a stable-key requirement; three local run modes with the exact port map; health endpoints; two AWS topologies; forward-only checksummed migrations; immutable production releases.

**Do not claim:** a "Sign in with Google" button (hidden, no UI); two-factor authentication as a user-enrollable feature (stubbed); passkeys (stubbed string only); SSO, SAML, verified domains, SCIM (stubbed page); a UI to change the self-hosted signup policy (absent); console-printed dev OTPs (`AUTH_DEV_EMAIL_OTP_TO_CONSOLE` is dead); `AI_GATEWAY_API_KEY`/`ANTHROPIC_API_KEY` as required configuration; `OPENAI_API_KEY` as the way to enable chat (BYOK rows are); a `local:down` command; hot reload under `local:up`; a `seed:dummy-chats` script; Docker Compose for the whole product; Qdrant or the markdown worker as part of the AWS topology; key rotation.

**Marketing claims evaluated** (no explicit claim list was supplied; these are the claims made by `README.md`, the pricing catalog, and the landing copy):

| Claim | Status | Reason |
|---|---|---|
| "Better Auth for auth, organizations, invitations, and roles" (README) | supported | section 1, 3 |
| "Stripe + Resend for billing and email flows" (README) | partial | Stripe is cloud-only and requires both keys; email is provider-selectable (`resend|ses|smtp`) and production deploys require SES |
| "PostgreSQL + Redis for persistence and stream continuity" | supported | `REDIS_URL` for rate limits and stream resume; in-memory fallback exists |
| "Qdrant for vector search/RAG workflows" | partial | wired behind `VITE_ENABLE_EMBEDDING`, but hosted builds hardcode it off and no Qdrant is provisioned |
| "One-command deploy" of the listed services (README) | partial | the service list is stale (no `receipt-zero-cache` service; two Zero services, four runtime role services, Teams omitted); several guards and a Nango two-pass deploy are required |
| Free plan "Single-member workspace" / `includedSeats: 1` | unsupported | enforced default is 5 seats (overridable) |
| Plus/Pro/Scale features "SAML SSO", "Verified domains", "Directory provisioning" | unsupported | stubbed UI, no implementation |
| "Self-hosted ... Unlimited usage" | supported | usage policy disabled and 100000 seats in self-hosted mode |
| "ZDR (Zero Data Retention) compliance at provider level" | partial | an organization compliance flag that filters models by catalog metadata; not an infrastructure control (prior corpus 09 §7.7, unchanged) |
| Landing "Audit-friendly agents that improve every run" | n/a | product positioning, outside this report's scope |

**Suggested page split:** `accounts/sign-in-and-sign-up`, `accounts/security-and-sessions`, `organizations/overview-and-roles`, `organizations/members-and-invitations`, `organizations/seats-and-plans`, `workspaces/overview` (brief, link to part 2), `configure/environment-reference` (section 6 verbatim), `configure/keys-and-rotation`, `develop/prerequisites-and-bunw`, `develop/run-modes-and-ports`, `develop/database-and-zero-publication`, `develop/validate-stack-and-mock-llm`, `develop/troubleshooting`, `deploy/topologies`, `deploy/self-hosting-aws`, `deploy/single-host`, `deploy/domains-tls-email-storage`, `deploy/health-and-observability`, `self-host/setup-wizard-and-signup-policy`, `architecture/core-services` (section 11 as the diagram source).

---

## Open questions

1. What are the exact Better Auth session `expiresIn`/`updateAge` values in the pinned 1.5.2 build? Receipt sets none; the docs should quote the library default only after confirming it against the installed package.
2. Is a UI or CLI for `updateSelfHostedSignupPolicy` planned, or should the docs state that operators must update `instance_settings` directly?
3. Should the setup wizard's `Auth email: not_available_in_self_host` row be corrected now that SMTP invitations are delivered in self-hosted mode?
4. Is there any planned rotation tool for `BYOK_ENCRYPTION_KEY_B64` and `RECEIPT_CONNECTION_ENCRYPTION_KEY_B64`, or should the docs say "rotation is not supported; re-enter keys"?
5. Why does the Free plan catalog say `includedSeats: 1` while the enforced default is 5? Which number is the product intent?
6. Is Google OAuth intended to be reachable (a button is missing) or should the server config be documented as dormant?
7. Will the two-factor enrollment UI ship, given the plugin, strings, and sign-in challenge already exist?
8. Should `deploy/Dockerfile.receipt-zero-cache` and `deploy/Dockerfile.runtime-hotfix` be documented, marked internal, or removed?
9. How is a new `factory-lite` stage provisioned the first time, given `deploy:aws` rejects it?
10. Is `resonate` meant to be installed as `resonate` (version-checked) or `resonate-server` (unchecked, legacy flags)? The repo's own instruction and container image pick the unchecked name, and the container pins 0.9.5 below the 0.9.7 floor.
11. Which of the dead `.env.example` entries (Slack team mapping, `AUTH_DEV_EMAIL_OTP_TO_CONSOLE`, `RECEIPT_POSTGRES_MIRROR_URL`) are intended future work versus removable?
12. Does `apps/start/.env` need to exist for `zero-cache` (`bun --env-file=.env --env-file=.env.local`)? Nothing creates it.
13. What is the public security-reporting address? `SECURITY.md` names none.
14. Is Windows supported? `bunw.cmd` and PowerShell branches exist, but `local:up` is bash and process-group cleanup is POSIX-only.
