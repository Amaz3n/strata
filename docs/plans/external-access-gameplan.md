# External Access Gameplan — Accounts, Tokens, and the Share Sheet

> **Status: ACTIVE PLAN — intent, not a description of the system.**
> Nothing in this document is guaranteed to exist. Never infer current app
> behavior from it. Source of truth is the code, `CLAUDE.md`, and the
> reference docs at the `docs/` top level.

**Status:** READY TO EXECUTE. Phases are sequenced and gated; do not reorder.
Written 2026-08-02 against `main` @ `aa020a3e`.
**Audience:** an LLM executor.

**Scope:** the external (non-employee) access model — `external_identities`,
`external_identity_grants`, `portal_access_tokens`, the portal gate, the auth
surfaces, and the project share sheet. Does NOT touch internal `app_users` auth.

The original token-only design was described in `arc-portal-gameplan.md`,
`sub-portal-redesign.md`, and `client-portal-redesign.md`. Those were history, not
contracts, and have been deleted — recover from git history before commit `d88dd8d4`
if ever needed. This doc supersedes their access-control decisions.

---

## 0. The problem

A token and an account grant are **two independent access paths with two independent
kill switches, and neither one is complete.**

`portal_access_tokens` is a bearer credential: whoever holds the URL is in.
`external_identity_grants` is an account grant that hangs off that token. Nothing
keeps their lifecycles in sync, and no surface shows a builder that both exist. The
consequences, all verified below: revoking a claimed account usually does nothing;
when it does work it silently hits every project in the org; a revoked person can
restore their own grant by signing in; and an already-claimed sub reopening their
link is offered a "Save my access" button for the account they already have.

**The fix is one idea:** the unit of external access is **a person on a project**.
`portal_access_tokens` is already exactly that row — one per
`(project_id, contact_id/company_id, portal_type)`. The token string is a *delivery
mechanism stored on that row*, not the thing itself. Everything below follows from
treating it that way.

## 0.1 Ground truth (verified 2026-08-02)

**Production volumes** — via Supabase MCP, read-only:

| | count |
|---|---|
| `portal_access_tokens` total / live | 29 / 29 |
| …with `require_account = true` | 2 |
| …scoped one-off (RFI/RFQ/submittal) | 0 |
| `external_identities` | 2 |
| `external_identity_grants` (all active, all portal) | 2 |

**There is effectively no installed base.** No backfill, no compatibility shim, no
staged cutover is warranted. Be aggressive; delete freely. Any phase below that
starts proposing a migration path for existing data is over-engineering — re-read
this table.

**Schema facts that shape the work:**
- `portal_access_tokens` carries `project_id`, `contact_id`, `company_id`,
  `portal_type`, ~30 `can_*` permission booleans, `expires_at`, `paused_at`,
  `revoked_at`, `access_count` / `max_access_count`, `pin_*`, `require_account`,
  and `token_hash` / `token_encrypted`.
- `external_identity_grants` has `org_id`, `identity_id`,
  `portal_access_token_id`, `bid_access_token_id`, `status`, `paused_at`,
  `revoked_at`. **It has no `project_id`** — project scope only exists by joining
  through the token. This is why the revoke bug in §1 happened.
- `external_identities.email` is `citext`. Identity is global across builders by
  design; grants are what scope it to an org.
- `portal_access_tokens` also carries `scoped_rfi_id`,
  `scoped_change_event_rfq_id`, `scoped_submittal_revision_id` — ephemeral
  machine-generated links from `lib/services/rfi-forward.ts` and
  `lib/services/change-events.ts`. Zero exist today, but the code paths are live.
  **These are not people-with-project-access and must never appear in the share
  sheet roster.** `listPortalTokens` ([portal-access.ts:322](../lib/services/portal-access.ts))
  does not currently filter them.

**Verified bugs (all three are real, all three ship in Phase 1):**

1. **Revoking a claimed account usually does nothing.**
   `setExternalPortalAccountStatus` ([external-portal-auth.ts:979](../lib/services/external-portal-auth.ts))
   kills the grant. `revokePortalToken` ([portal-access.ts:252](../lib/services/portal-access.ts))
   kills the token. Neither touches the other. With `require_account = false` (the
   default — 27 of 29 live tokens), killing the grant leaves the token path fully
   open: the revoked sub opens the same URL and walks in.

2. **When it does work, the blast radius is org-wide.**
   `listProjectExternalPortalAccounts` filters by `token.project_id`
   ([:954](../lib/services/external-portal-auth.ts)), but
   `setExternalPortalAccountStatus` filters only `org_id` + `identity_id`
   ([:1001](../lib/services/external-portal-auth.ts)) — no project filter. The
   "Claimed accounts" list in a project's share sheet is project-scoped on read and
   org-wide on write. Revoking a vendor from one house removes them from every
   project in the org, with no warning.

3. **Revocation is self-healing for the revoked party.**
   `upsertGrant` ([:499](../lib/services/external-portal-auth.ts)) unconditionally
   writes `status: "active", paused_at: null, revoked_at: null` on conflict. A
   revoked person who signs in through the account gate reactivates their own grant.

**Dead code confirmed (zero importers anywhere in the repo):**
- `components/sharing/access-token-generator.tsx` — 267 lines
- `components/sharing/portal-invite-panel.tsx` — 318 lines
- Password reset: `issueExternalIdentityPasswordReset` ([:857](../lib/services/external-portal-auth.ts))
  and `completeExternalIdentityPasswordReset` ([:879](../lib/services/external-portal-auth.ts)) — written, never called.
- Email verification: `issueExternalIdentityVerification` ([:809](../lib/services/external-portal-auth.ts))
  and `confirmExternalIdentityVerification` ([:827](../lib/services/external-portal-auth.ts)) — written, never called.
  `email_verified_at` is never read by any gate.
- Props declared and never passed: `hasExistingAccount`, `defaultMode` on
  `PortalAccountGate` ([portal-account-gate.tsx:24](../components/portal/account/portal-account-gate.tsx)).

**Environment facts:**
- `proxy.ts:5` matches `PUBLIC_ROUTES` with `startsWith`, and `/access` is already
  in the list — **new `/access/*` pages need no proxy change.** Verify anyway
  before assuming; do not add `/api` routes without the `PUBLIC_API_ROUTES` entry.
- Transactional external email goes through the **direct mailer**, the pattern at
  `app/(auth)/auth/actions.ts:418` (`sendPasswordResetEmail` from
  `lib/services/mailer.ts`). It does **not** go through the notification service,
  so it needs **no `EMAIL_NOTIFICATION_TYPES` entry**. Adding one would be wrong —
  that allowlist governs opt-in notifications to internal users.
- `lib/emails/password-reset-email.tsx` exists for internal users. Read it and
  follow its structure for the external variant; do not reuse it directly (the copy
  and the link target differ).

## 0.2 The model to build toward

**Owner decision 2026-08-02 — unify the doors, not the identity stores.** One
sign-in / forgot-password / reset surface at `/auth/*` for builders and externals
alike (Phases 2 and 4 complete this). But `external_identities` stays a separate
table from Supabase auth, deliberately: every RLS policy and `requireOrgContext()`
assumes `auth.uid()` = org member, so an external session that physically cannot
satisfy those policies is a security boundary by construction — merging would
require every policy to correctly *exclude* vendors. It also cleanly models the
person who is both (org member for builder A, sub for builder B). Do not propose
merging the stores; unification happens at the surfaces.

`/access` survives only as a ~30-line router — the one stable, token-free URL for
externals (bookmark target, email links, post-reset landing): redirect to the
right portal, or render the zero-workspaces dead-end. Nothing else.

Known edge, deferred to Phase 4 polish: `signInAction` tries Supabase first and
falls through to external only on failure
([auth/actions.ts:74-84](../app/(auth)/auth/actions.ts)). A dual-account person
(same email + password in both worlds) always lands in the builder app and cannot
reach their vendor portals through the front door. Fix shape: on internal success,
also check for external grants and offer the choice. Do not let this block
anything.

> **A person has access to a project. The link is how they got in.**

- The access record is the `portal_access_tokens` row. Stop calling it a link in
  any user-facing string.
- It has at most one live delivery token (reissuable) and at most one identity
  grant (created on claim, or up front when inviting a known account).
- **One status governs both.** Pause pauses both. Revoke revokes both. Expiry
  expires both.
- Once a person is on the account path, *link* limits stop applying to them —
  specifically `max_access_count`, see WS-3.

---

## Phase 1 — Revocation correctness (no UI, ship alone)

These are live security bugs. They are independent of every design decision below
and must land first. No schema change.

**WS-1.1 — Make revoke/pause/resume cascade.**
In `lib/services/portal-access.ts`, `revokePortalToken` / `pausePortalToken` /
`resumePortalToken` must apply the same transition to every
`external_identity_grants` row where `portal_access_token_id = tokenId`. Do it in
the service, not a DB trigger — the audit/event trail belongs in the service layer
per CLAUDE.md.

**WS-1.2 — Project-scope the account status mutation.**
`setExternalPortalAccountStatus` must accept a `projectId` and only touch grants
whose token belongs to that project. Grants have no `project_id`, so: select token
ids for `(org_id, project_id)`, then update grants `.in("portal_access_token_id", ids)`.
Keep an explicit org-wide variant only if a caller needs it — right now none does,
so **do not build one speculatively.** Update
`setExternalPortalAccountStatusAction` ([sharing/actions.ts:131](../app/(app)/sharing/actions.ts))
and its Zod schema to require `projectId`.

**WS-1.3 — Stop grant resurrection.**
`upsertGrant` must not clear `revoked_at`. On conflict, if the existing grant is
`revoked`, leave it revoked and have the caller
(`authenticateExternalPortalAccountWithToken`) throw a clear message — "Your access
to this project was removed by the builder." A `paused` grant behaves the same way.
Only an `active` grant is refreshed.

**WS-1.4 — Cascade the token status into the workspace query.**
`getExternalPortalWorkspaceContext`'s `tokenIsLive` ([:708](../lib/services/external-portal-auth.ts))
already drops revoked/paused/expired tokens, so WS-1.1 makes revoked access vanish
from `/access` correctly. Verify this by test rather than assuming.

**Acceptance:**
- Revoke a claimed account → the token URL 404s AND the item disappears from
  `/access` for that identity.
- Revoke in project A → the same identity's access to project B is untouched.
- A revoked identity signing in via a still-valid token gets the explicit error and
  **no reactivated grant row**.
- `pnpm lint && npx tsc --noEmit` clean; `pnpm test:auth` passes.

---

## Phase 2 — Password reset and email verification (blocker for Phase 3)

Phase 3 makes a forgotten password a total lockout. This must exist first. Do not
start Phase 3 until this is merged.

**Owner decision 2026-08-02: one reset door, not a parallel external flow.** The
unified sign-in already routes external identities
([auth/actions.ts:80-84](../app/(auth)/auth/actions.ts)) — reset follows the same
fork, on the same `/auth/forgot-password` page. Verified broken today:
`requestPasswordResetAction` only calls `serviceClient.auth.admin.generateLink`
([:386](../app/(auth)/auth/actions.ts)), which errors for any email that is not a
Supabase auth user — an external vendor requesting a reset gets the generic
success message and **no email is ever sent**.

**WS-2.1 — Fork `requestPasswordResetAction`.** When `generateLink` finds no auth
user, call `issueExternalIdentityPasswordReset` (already written, never called).
If it returns a token, send `lib/emails/external-password-reset-email.tsx` (new,
follow `lib/emails/` conventions) via the direct mailer. **The action's response
message must be byte-identical across all three outcomes** — internal user,
external identity, nobody — preserving the non-disclosure contract documented at
[:857](../lib/services/external-portal-auth.ts). `enforceAuthRateLimit` is already
applied inside the service; do not double-limit.

**WS-2.2 — Completion branch.** `/auth/reset` verifies a Supabase `token_hash`;
external reset carries its own raw token (hashed against `reset_token_hash`). Same
page, distinguished by query param, posting to
`completeExternalIdentityPasswordReset` for the external branch. On success, route
externals to `/auth/signin`. All external auth surfaces link "Forgot password?" to
`/auth/forgot-password` — there is exactly one door.

**WS-2.3 — Email verification: decide, then act.** The two verification functions
are dead and `email_verified_at` gates nothing. Either wire it (send on claim, and
decide what unverified blocks) or **delete all four symbols and the columns' usage**.
Do not leave it half-built a second time. Recommendation: wire the send on claim and
surface verification state to the builder in the share sheet roster, but do **not**
make it a hard gate — an unverified sub still needs to see their PO today.

**Acceptance:** a sub who forgets their password recovers unaided, on a phone, in
under a minute. Reset revokes every existing session for that identity (the service
already does this at [:916](../lib/services/external-portal-auth.ts)) — confirm the
user is told that.

---

## Phase 3 — Claimed accounts lock the link

**The rule:** if the invited person has an Arc account, the token stops being
sufficient — it becomes a pointer to a sign-in. If they don't, the link works
exactly as it does today. This is the behavior change the owner asked for.

**WS-3.1 — The lock signal.** In `resolvePortalGate` ([lib/portal/gate.tsx](../lib/portal/gate.tsx)),
before the existing `require_account` branch, resolve **"is this access claimed?"**:

- If the token has a bound contact email → does an `external_identities` row exist
  for that email? (`authenticateExternalPortalAccountWithToken` already enforces the
  email binding at [:544](../lib/services/external-portal-auth.ts), so contact email
  ↔ identity is 1:1 for these tokens.)
- Else → does any non-revoked grant exist for this token?

Claimed ⇒ require a session, exactly as `require_account = true` does today.
`require_account` remains an independent builder-set override for the *unclaimed*
case, and its existing behavior is unchanged.

> **Deliberate reversal, called out for review.** This discloses "this email has an
> Arc account" to whoever holds a live token bound to that email. The current code
> deliberately refuses to report that ([:297](../lib/services/external-portal-auth.ts)).
> The trade was accepted: the holder already has the portal, so the disclosure is
> not actionable, and keying on per-token grants instead would be defeated by the
> builder simply reissuing a link. **Keep the enumeration protection on every path
> that is not gated behind a valid token** — in particular do not add an
> "is this email registered?" endpoint.

**WS-3.2 — Auto-grant a matching signed-in identity.** If a session exists and its
email matches the token's bound email but no grant exists for *this* token, create
the grant and let them through. Without this, every reissued link re-prompts
someone who is already signed in. Respect WS-1.3: never auto-create over a revoked
grant.

**WS-3.3 — Subsume the PIN.** [gate.tsx:86](../lib/portal/gate.tsx) runs the PIN
gate after the account gate. A verified identity is strictly stronger proof than a
shared PIN; requiring both is friction with no security gain. Skip the PIN when the
account gate passed. PIN remains for the link-only path.

**WS-3.4 — Fix the "Save my access" tell.** With WS-3.1, an unclaimed person is the
only one who ever sees `PortalClaimAccount`, so the reported bug disappears by
construction. Confirm this rather than patching the header separately.

**Acceptance:**
- Claimed sub, fresh browser, existing link → sign-in wall, not the portal.
- Unclaimed sub, same link → straight into the portal, unchanged from today.
- Claimed sub with a live session → straight in, no prompt.
- Builder reissues the link to a claimed sub → still a sign-in wall (this is the
  case per-token grants would have missed).
- `pnpm test:auth` passes.

---

## Phase 4 — One external auth surface

Three components hand-roll the same email/name/password form:
[PortalAccountGate](../components/portal/account/portal-account-gate.tsx),
[ExternalAccessLogin](../components/portal/account/external-access-login.tsx),
[PortalClaimAccount](../components/portal/shell/portal-claim-account.tsx).

**WS-4.1 — Extract one `<ExternalAuthForm>`.** The surfaces differ only in chrome
and copy. Sheet/page/dialog chrome stays at the call site. Note: WS-4.6 deletes
`ExternalAccessLogin` outright, so this consolidation is two forms
(`PortalAccountGate`, `PortalClaimAccount`) → one, not three.

**WS-4.2 — Delete the `mode` parameter.** The service already branches on whether
the identity exists ([:557](../lib/services/external-portal-auth.ts) vs
[:577](../lib/services/external-portal-auth.ts)); `mode` only gates one error
string. After Phase 3 the gate knows claimed-ness server-side and renders the right
copy directly. Removing it deletes the claim/login toggle, `showModeToggle`, and the
dead `hasExistingAccount` / `defaultMode` props. Merge
`signInExternalPortalAccountAction` into the same action with `token: null`.

**WS-4.3 — Fold the bid portal into the shared gate.**
[app/b/[token]/page.tsx:56-65](<../app/b/[token]/page.tsx>) re-implements the account
gate inline — precisely the drift `resolvePortalGate` was built to end
([gate.tsx:29](../lib/portal/gate.tsx)). It will otherwise miss Phase 3 entirely.
This is the *minimal* fix so `/b` behaves correctly until Phase 6 absorbs it —
do not invest in `/b` beyond gate correctness, and leave the `/b/grant_${grantId}`
href scheme ([:766](../lib/services/external-portal-auth.ts)) alone; Phase 6
deletes it.

**WS-4.4 — Copy sweep.** Any remaining string that says "claim first, then return"
or treats the link as the primary door is stale under the new model. The primary
door for account holders is `/auth/signin`.

**WS-4.6 — Kill the `/access` hub UI (owner decision 2026-08-02).** The workspace
hub page duplicates the in-portal `ExternalWorkspaceSwitcher` as a full page, in
the hero-gradient style the design standard rejects. `/access` becomes a router:

- Session with ≥1 live workspace item → redirect to the most-recently-accessed
  portal href (the workspace context already builds live hrefs — this is a lookup,
  not new machinery). The in-portal switcher is the only chooser.
- Session with zero live items → a small honest dead-end state ("no active
  workspaces — ask the builder for a new invite"). This is the only UI left at
  `/access`.
- No session → redirect to `/auth/signin`. The unified sign-in already routes
  externals, so **delete `components/portal/account/external-access-login.tsx`
  entirely** — its only consumer is this page.

The vendor-payment-profile card currently on the hub moves into the portal account
menu; it already deep-links to `/s/…/payments`. `getVendorPaymentPortalContext`
keeps its caller — move it, don't orphan it. `/access` stays in `PUBLIC_ROUTES`
(it is the sign-in redirect target and the post-sign-in landing).

**WS-4.5 — Dead CSS.** `--primary` is `oklch` ([app/globals.css:53](../app/globals.css)),
so `hsl(var(--primary)/0.12)` is invalid CSS and the declaration is dropped. Three
"designed" gradients have never rendered a pixel:
[portal-account-gate.tsx:89](../components/portal/account/portal-account-gate.tsx),
[external-access-login.tsx:49](../components/portal/account/external-access-login.tsx),
and [access/page.tsx:69](<../app/access/page.tsx>) (`var(--color-primary)/0.12`, same
problem). Portals are the expressive zone so gradients are permitted — either make
them work with `color-mix()` or delete them, but do not leave dead declarations.
Also `rounded-lg` at [portal-account-gate.tsx:130](../components/portal/account/portal-account-gate.tsx)
against the radius-0 rule.

---

## Phase 5 — Redesign the share sheet around people

Current sheet: a 878-line creator whose primary verb is "create a link", plus two
accordions ("Active links", "Claimed accounts") that are two views of the same
person. Owner's direction: **redesign it freely.**

**WS-5.1 — One roster, not two accordions.** Replace both accordions in
[project-overview-actions.tsx:351-410](../components/projects/overview/project-overview-actions.tsx)
with a single list of **people with access to this project**. Each row: name,
company, email; what they can reach (client / sub for company X / reviewer); how
they get in as a *badge* — `Arc account` vs `Link only`, **not** as a category; and
state (active / paused / revoked / expired / never opened). Dense table, siblings'
type scale, `tabular-nums` where numeric — see `docs/design.md`.

**Filter out scoped one-off tokens** (`scoped_rfi_id`,
`scoped_change_event_rfq_id`, `scoped_submittal_revision_id`) — machine-generated
links are not people. `listPortalTokens` needs the filter (§0.1).

**WS-5.2 — One revoke.** A row's Revoke means "this person loses access to this
project," whichever mechanism they used. Phase 1 already made the service do this
correctly; here it becomes a single visible action. Keep **Pause** as the prominent
action with Revoke behind it, and put Revoke behind a confirm that names the person
and states that reissuing means a new link and a fresh claim. It is genuinely
destructive and has no undo.

**WS-5.3 — Invite an existing Arc account.** Add a source to the invite flow:
people who already hold a live grant **with this org**. "Add someone you've worked
with", showing which projects they're already on. Inviting one creates the access
record and pre-creates the grant, so they sign in rather than claim.

> **Scope the lookup to the current org.** Identities are global; a free-text search
> over `external_identities` would let any builder probe whether an arbitrary email
> has an Arc account — a cross-tenant disclosure, and the same concern §0.1 and
> WS-3.1 are careful about. Suggest only identities with an existing grant in this
> org. For a brand-new email, the builder neither knows nor needs to: send the
> invite and let the Phase 3 gate resolve sign-in vs. claim at open time.

**WS-5.4 — Split the creator.** `portal-link-creator.tsx` (878 lines) holds
portal-type, share-method, candidate-source, permission-preset, expiry, and PIN
state in one component. Split person-selection from access-options. Reuse
`PermissionToggles` (its only current consumer is this file).

**WS-5.5 — Delete dead code, in this change.**
- `components/sharing/access-token-generator.tsx` (267 lines, zero importers)
- `components/sharing/portal-invite-panel.tsx` (318 lines, zero importers)

**WS-5.6 — Design debt in the sheet.** `rounded-xl` / `rounded-lg` / `rounded-none`
at [project-overview-actions.tsx:325](../components/projects/overview/project-overview-actions.tsx),
:340, :351, :394 against the radius-0 rule; a decorative `bg-primary/10` icon chip
at :325 (color is state, never decoration).

**WS-5.7 — Un-grandfather `portal-account-list.tsx`.** It was added to the
`.eslintrc.js` exemption list at line 144 the same day it was written, and uses raw
`emerald` / `amber` / `rose` palette classes where `success` / `warning` /
`destructive` tokens exist. CLAUDE.md: the list is for the 132 legacy files and you
never add to it. If the roster rewrite absorbs this component, delete the file and
the `.eslintrc.js` line together; otherwise fix the classes and delete the line.
Also drop `access-token-list.tsx` (line 143) and `portal-link-creator.tsx`
(line 145) from that list if WS-5.1/5.4 leave them clean.

**Acceptance:**
- Empty, loading, error, and dark-mode states all ship (`docs/design.md`).
- A 40-vendor project renders without a scroll trap; the roster has a visible cap or
  pagination from day one.
- `pnpm lint` silent, `npx tsc --noEmit` clean, `pnpm test:auth` passes.
- `pnpm lint:tokens` shows a net *decrease* in warnings.

---

## Phase 6 — One vendor portal: absorb bids (owner decision 2026-08-02)

**The rule: a bidder is a vendor.** The `/b` portal exists only because bid access
grew its own token table. An Arc-account vendor invited to bid should not be
bounced to a second portal with a second chrome for the same builder relationship.

Under the §0.2 model a bid invite is *a person on a project, pre-award*: a
`portal_access_tokens` row (`portal_type: "sub"`) whose permissions are bid-scoped.
Same portal, a **Bids** nav item, everything else empty until they win work —
which is the correct experience for a bid-only vendor, not a degraded one.

**WS-6.1 — Token unification.** Bid invites mint `portal_access_tokens` rows
instead of `bid_access_tokens` (add `scoped_bid_invite_id`, following the existing
`scoped_*` column pattern — this needs a migration: write it, STOP for approval).
Kills, in one stroke: `hashBidToken`, the `bid_access_token_id` FK on
`external_identity_grants`, the `/b` gate, and the `/b/grant_${grantId}` href hack
(which exists only because bid tokens are not addressable like portal tokens).

**WS-6.2 — `/s/[token]/bids`.** Re-mount the bid portal v2 components (shipped
2026-07-18 — reuse, do not rebuild) as a section of the sub portal, listing every
live bid invite for that token's company on that project.

**WS-6.3 — The pure-email-invite edge.** `bid_invites.contact_id` and company are
optional, but the sub portal hard-requires `company_id` (`requireCompany: true` in
[app/s/[token]/layout.tsx](<../app/s/[token]/layout.tsx>)). Decision: **auto-create
the company/contact rows at invite-send time** — a builder inviting a bidder is
forming a vendor relationship and the records should exist — rather than relaxing
`requireCompany`. Check what the bids system already creates before adding
anything.

**WS-6.4 — `/b/[token]` becomes a redirect** for links already in the wild
(resolve the bid token → its replacement portal token → 307). Leave no parallel
implementation. `bid_access_tokens` reads stay until the redirect window closes;
mark the table deprecated in `docs/database-overview.md`.

Phase 6 deliberately comes last: it benefits from one gate (P3), one auth form
(P4), and one roster (P5) rather than blocking them. Production has few live bid
tokens (§0.1 counts grants, not bid tokens — count them before starting).

---

## Sequencing and gates

```
Phase 1  Revocation correctness      ← ship alone, no UI
Phase 2  Password reset via /auth    ← HARD GATE for Phase 3
Phase 3  Claimed accounts lock       ← the behavior change
Phase 4  Auth unification + /access teardown
Phase 5  Share sheet redesign
Phase 6  Bid portal absorbed into vendor portal
```

Phases 4 and 5 may interleave; 1 → 2 → 3 may not; 6 comes last.

## Standing constraints

- **Local dev points at production Supabase.** Reads are fine. Never run a
  destructive statement, seed, or "test" mutation.
- **Never apply a migration.** No phase here is expected to need one — if you
  conclude otherwise, write the `.sql` into `supabase/migrations/`, STOP, and tell
  the human it needs approval. Keep writing service/UI code against the planned
  schema meanwhile, and say clearly that the migration is pending.
- Services own the logic: `requireOrgContext()` → `requirePermission()` → logic →
  `recordEvent()` + `recordAudit()` → mapped DTO. Actions return
  `{ success, error }` / `ActionResult`.
- Every query scoped by `org_id`.
- Acceptance testing runs in the QA org. There is no staging.
