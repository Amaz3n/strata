# Plan 006: Make cron auth fail closed and stop signing portal cookies with the service-role key

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 7e98e5de..HEAD -- lib/services/cron-auth.ts lib/services/portal-access.ts app/api/qbo/process-webhooks/route.ts app/api/qbo/process-outbox/route.ts app/api/qbo/process-cdc/route.ts app/api/jobs/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1 (small, but has a DEPLOY-BLOCKING config precondition — see Step 0)
- **Effort**: S
- **Risk**: LOW code risk / MED operational risk (mis-set env vars 401 the crons)
- **Depends on**: plans/001-verification-baseline.md (verification commands)
- **Category**: security
- **Planned at**: commit `7e98e5de`, 2026-07-07 (working tree carried
  uncommitted changes; excerpts reflect the working tree)

## Why this matters

Two auth fallbacks currently fail **open** instead of closed:

1. **Cron auth**: when `CRON_SECRET` is unset, every cron endpoint (late fees,
   recurring invoices, outbox email delivery, QBO sync jobs, drawings
   pipeline) accepts any request carrying the header `x-vercel-cron: 1`.
   Vercel strips that header from external traffic, so this is
   defense-in-depth today — but one env-var slip turns "auth" into "open",
   and the same fallback logic is copy-pasted inline into several QBO routes,
   so the copies can drift independently.
2. **Portal PIN cookies**: `getPortalAccessSecret()` falls back to HMAC-ing
   portal cookies with `SUPABASE_SERVICE_ROLE_KEY` — the credential that
   bypasses all RLS — if no dedicated portal secret is set. Overloading the
   most privileged secret as a cookie-signing key broadens its usage surface
   and silently couples portal security to it.

Both fixes are "require the dedicated secret; fail closed otherwise".

## Current state

- `lib/services/cron-auth.ts:1-15` (whole file):

```ts
import type { NextRequest } from "next/server"

export function isAuthorizedCronRequest(request: NextRequest) {
  if (process.env.NODE_ENV !== "production") return true

  const secret = process.env.CRON_SECRET
  const authHeader = request.headers.get("authorization")
  const legacyHeader = request.headers.get("x-cron-secret")
  const secretMatches =
    Boolean(secret) &&
    (authHeader?.trim() === `Bearer ${secret}` || legacyHeader === secret)

  if (secret) return secretMatches
  return request.headers.get("x-vercel-cron") === "1"   // ← fails open
}
```

- Files containing their own inline copy of the same pattern (grep
  `x-vercel-cron`): `app/api/qbo/process-webhooks/route.ts`,
  `app/api/qbo/process-outbox/route.ts`, `app/api/qbo/process-cdc/route.ts`,
  `app/api/jobs/follow-up-reminders/route.ts`,
  `app/api/jobs/drawings-pipeline/route.ts`,
  `app/api/jobs/weekly-executive-snapshot/route.ts`,
  `app/api/jobs/rbac-evidence/route.ts`. Some may already import
  `isAuthorizedCronRequest` and merely mention the header — classify each in
  Step 2. (`app/api/jobs/process-outbox/route.ts` already imports the shared
  helper.)

- `lib/services/portal-access.ts:37-47`:

```ts
function getPortalAccessSecret() {
  const secret =
    process.env.PORTAL_ACCESS_SECRET ??
    process.env.BID_PORTAL_SECRET ??
    process.env.DOCUMENT_SIGNING_SECRET ??
    process.env.SUPABASE_SERVICE_ROLE_KEY   // ← service-role key as HMAC key
  if (!secret) {
    throw new Error("Missing PORTAL_ACCESS_SECRET or another server-side portal secret")
  }
  return secret
}
```

  Used by `getPortalPinCookieName` / `signPortalPinCookie` in the same file.
  Consequence of removing the fallback: if production currently relies on the
  service-role fallback, existing portal PIN cookies are invalidated when a
  new secret is introduced — visitors re-enter their PIN once. That is
  acceptable; portal being DOWN because no secret is set at all is not, hence
  Step 0.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Typecheck | `pnpm typecheck` | exit 0 |
| Lint | `pnpm lint` | exit 0 |
| Tests | `pnpm test` | all pass |
| Env check | `vercel env ls` (or ask the operator) | `CRON_SECRET` and `PORTAL_ACCESS_SECRET` exist in production |

## Scope

**In scope** (the only files you should modify):
- `lib/services/cron-auth.ts`
- `lib/services/portal-access.ts` (the `getPortalAccessSecret` function only)
- The route files listed above that carry inline cron-auth copies (auth block
  only — nothing else in those routes)

**Out of scope** (do NOT touch):
- `proxy.ts` / PUBLIC_API_ROUTES — routes stay public; they self-authenticate.
- Any webhook signature verification (Stripe/Resend/Intuit) — separate
  mechanisms, already sound.
- `BID_PORTAL_SECRET` / `DOCUMENT_SIGNING_SECRET` usage elsewhere.
- Vercel env configuration itself — you verify it exists (Step 0); the
  operator sets it.

## Git workflow

- Branch: `advisor/006-auth-fail-closed`
- Commit per step; short imperative subjects matching `git log`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 0: Confirm the env precondition (GATE — do not skip)

Confirm `CRON_SECRET` is set in the production environment, and determine
whether any of `PORTAL_ACCESS_SECRET` / `BID_PORTAL_SECRET` /
`DOCUMENT_SIGNING_SECRET` is set. Use `vercel env ls` if available, otherwise
ask the operator. Do NOT print secret values anywhere — names and
presence/absence only.

- `CRON_SECRET` missing in prod → merging this plan would 401 every cron.
  STOP and report: the operator must set it first.
- No portal secret set in prod → the portal cookie path is live on the
  service-role fallback. STOP and report: the operator must set
  `PORTAL_ACCESS_SECRET` first (any long random value; do not generate and
  paste one into the plan or chat).

**Verify**: a written note of which env vars exist (names only).

### Step 1: Fail closed in `cron-auth.ts`

Replace the fallback:

```ts
export function isAuthorizedCronRequest(request: NextRequest) {
  if (process.env.NODE_ENV !== "production") return true

  const secret = process.env.CRON_SECRET
  if (!secret) return false   // fail closed: unset secret means no cron access

  const authHeader = request.headers.get("authorization")
  const legacyHeader = request.headers.get("x-cron-secret")
  return authHeader?.trim() === `Bearer ${secret}` || legacyHeader === secret
}
```

Note: Vercel Cron invokes with `Authorization: Bearer $CRON_SECRET` when
`CRON_SECRET` is set in the project — which Step 0 confirmed. The
`x-vercel-cron` header is no longer consulted.

**Verify**: `pnpm typecheck && pnpm lint` → exit 0;
`grep -n "x-vercel-cron" lib/services/cron-auth.ts` → no match.

### Step 2: Consolidate the inline copies

For each route file listed in Current state, look at its auth block:

- If it reimplements the secret-or-`x-vercel-cron` check inline, replace the
  block with `import { isAuthorizedCronRequest } from "@/lib/services/cron-auth"`
  and an early `401` return, exactly like
  `app/api/jobs/process-outbox/route.ts:460-462` does today. Delete the local
  helper (leave-no-trash rule).
- If it already uses the shared helper and merely mentions the header in a
  comment/log, leave it.

Keep each route's response shape unchanged (`{ error: "Unauthorized" }`, 401).

**Verify**: `grep -rln "x-vercel-cron" app/ lib/` → only files where the
string survives in comments (ideally none); every listed route imports
`isAuthorizedCronRequest`.

### Step 3: Require a dedicated portal secret

In `lib/services/portal-access.ts`, remove the
`?? process.env.SUPABASE_SERVICE_ROLE_KEY` arm from `getPortalAccessSecret()`.
Keep the other two fallbacks (they are dedicated signing secrets, acceptable),
and update the thrown error message to name `PORTAL_ACCESS_SECRET` as the
expected variable.

**Verify**: `grep -n "SUPABASE_SERVICE_ROLE_KEY" lib/services/portal-access.ts` → no match.

## Test plan

Add to the invariant-test file pattern (see
`tests/qbo-import-reliability.test.js` for the style; if
`tests/recurring-billing-invariants.test.js` from plan 004 exists, add a new
`tests/auth-invariants.test.js` alongside): assert
`lib/services/cron-auth.ts` source does NOT contain `x-vercel-cron`, and
`lib/services/portal-access.ts` does NOT contain `SUPABASE_SERVICE_ROLE_KEY`.
Wire into the `test` script from plan 001.

**Verify**: `pnpm test` → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] Step 0 env confirmation recorded (names only, no values)
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm test` exit 0
- [ ] `grep -rn "x-vercel-cron" lib/ app/` → no functional matches
- [ ] `grep -n "SUPABASE_SERVICE_ROLE_KEY" lib/services/portal-access.ts` → no match
- [ ] All cron routes authenticate via the shared `isAuthorizedCronRequest`
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Step 0 finds `CRON_SECRET` or a portal secret missing in production.
- Any route's inline auth check differs materially from the shared helper
  (extra headers, different secrets) — it may have a reason; report before
  unifying it.
- You find a NON-cron caller of `isAuthorizedCronRequest` whose behavior would
  change (grep its importers first).

## Maintenance notes

- Any new cron route MUST import `isAuthorizedCronRequest` — reviewers should
  reject inline reimplementations (this plan just deleted them all).
- If portal PIN complaints appear right after deploy, that is the expected
  one-time cookie invalidation from the signing-key change (users re-enter
  the PIN once).
- The service-role key should never appear outside Supabase client
  construction; a repo-wide grep for `SUPABASE_SERVICE_ROLE_KEY` outside
  `lib/supabase/` is a cheap periodic check.
- Rotation note: the service-role key was used as an HMAC key (low direct
  exposure — HMAC does not reveal the key). Rotating it is still good hygiene
  after this lands; that's a Supabase dashboard operation for the operator.
