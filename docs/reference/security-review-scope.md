# Security review scope (Arc Production release)

What an independent security review of the Arc Production release covers, the
threat model it tests against, and the internal checklist Arc completes before
the reviewer starts. Arc does not perform the independent review. The owner
commissions it and records its sign-off on EP14-10. Every claim below names the
code or golden scenario that proves it, so a reviewer can start from evidence
rather than from prose.

## In scope

One Next.js deployment (`app/`, `proxy.ts`), one Supabase project (Postgres with
RLS, Storage, Auth), and the background workers that Vercel Cron starts
(`CRON_JOBS` in `lib/services/job-runs.ts`). The release adds production posture
(communities, lots, starts, purchasing, sales agreements, warranty) to an
application that already serves residential and commercial builders. The review
covers the whole tenant boundary, not only the new tables, because a mixed
organization holds every posture's data under one `org_id`.

Out of scope for this release (they stay off and are said to be off): live
payment execution (`FINTECH_PAYMENTS_*`), the mobile web, and the iOS API's new
production endpoints (deferred). The Plaid and Stripe webhooks stay in scope,
since they are live today.

## Assets

| Asset | Where it lives | Why it matters |
|---|---|---|
| Tenant data | Every `public` table, keyed by `org_id` | One builder must never read or change another's |
| Money records | Commitments, bills, invoices, payments, the Books ledger, deposits | Changing a total or a status moves real money or misstates the books |
| Signed agreements and their evidence | `documents`, e-sign envelopes, `imported_agreement_evidence` (hash of the stored PDF) | Contract evidence for closings and disputes |
| Buyer and homeowner personal data | `contacts`, the directory, warranty requests | Names, phones, emails, addresses |
| Files | Supabase Storage buckets behind `files` rows; previews | Plans, contracts, photos, receipts |
| Credentials | Service-role key, cron secret, provider tokens (QuickBooks, Plaid, Stripe, Resend) | Each one bypasses some boundary by design |

## Trust boundaries and threat model

Each boundary lists who attacks it, what they try, the control, and the
evidence. "Member" means a signed-in user of the organization holding a JWT the
browser can replay against the Data API directly, without going through the app.

### 1. Tenant isolation (organization, division, community)

- **Attacker:** a member of organization A, or a member of A who is limited to
  some divisions.
- **Tries to:** read or write rows of organization B, or of a division they are
  not assigned to, through the services or straight through the Data API.
- **Controls:**
  - Every table has `org_id` and org-scoped RLS (`is_org_member`).
  - Division scope is a set of RESTRICTIVE policies on top (`division_scope`).
  - Services call `requireOrgContext()` → `requirePermission()` before doing
    anything.
  - Community assignment is a convenience only and never enforces anything.
- **Evidence:**
  - SEC-01 `division-wall-holds`, `division-move-keeps-history`,
    `limited-member-cannot-move-a-community-out`.
  - ROLE-01 `division-and-org-walls-hold-for-mutations`: a division manager and
    another organization's owner are refused 11 desk mutations, and no row is
    written to the foreign org.

### 2. Member authority (role and permission)

- **Attacker:** a member whose role lacks a key, or whose key was removed while
  their session was still open.
- **Tries to:** perform another desk's mutation, through a server action or by
  writing the table directly.
- **Controls:**
  - The permission catalog is code (`lib/permission-catalog.ts` and its seed
    migration).
  - `has_org_permission()` resolves role, grant and deny overrides, and MFA on
    every call, so nothing is cached in the session.
  - The member write fences make every table a desk writes either read-only to
    members, or writable only with that desk's key (below).
- **Evidence:**
  - ROLE-01 `desk-mutations-follow-the-role-catalog`: 8 roles × 11 mutations
    against the catalog.
  - ROLE-01 `stale-role-is-refused-mid-session`: a role change and deny
    overrides take effect on the next call, through the service (refused for the
    named missing key) and through the Data API (the same direct write allowed
    before the change is refused after it).
  - ROLE-01 `data-api-writes-are-fenced`: every refusal is a 42501 or a write
    that reaches no row; any other database error fails the cell.
  - SEC-01 `invites-cannot-escalate`, `departure-cancels-queued-authority`.

### 3. Separation of duties on money

- **Attacker:** one person acting alone.
- **Tries to:** create and approve their own purchase order, bill or
  commission, or certify their own work.
- **Controls:** the approval gates in the services
  (`assertCommitmentApprovalSeparated`, the bill-approval separation rules) and
  the refusal log (`reference/audit-trail.md`).
- **Evidence:**
  - ROLE-01 `creator-cannot-approve-own-purchase-order`.
  - SEC-01 `enterer-cannot-approve-own-bill`.
  - VPO-01; SALE-01 (commissions); WARR-01 (the person who completed a visit
    cannot verify it).

### 4. Portals and tokens (buyers, trades, bidders, invoice payers)

- **Attacker:**
  - anyone holding a forwarded or leaked link;
  - a trade whose access was paused or revoked;
  - a holder who has already claimed an account.
- **Tries to:**
  - read another project's or another trade's records;
  - keep using a revoked link;
  - see prices on scope shared without them.
- **Controls:**
  - `resolvePortalGate()` runs token → account → PIN in that order.
  - One status governs both the token and the identity grant
    (`revokePortalToken` / `pausePortalToken` cascade).
  - A claimed identity turns the token into a pointer to sign-in.
  - `max_access_count` is counted only at the portal root.
  - Trade portals show only shared sheets, their own scope, and options without
    prices.
- **Evidence:** FIELD-01 (a trade portal refuses paused or revoked links and
  shows only its own released scope), TRADE-01, BID-01.

### 5. Storage

- **Attacker:** a member or portal holder who guesses or replays a storage path,
  or who uploads a file disguised as another type.
- **Controls:**
  - Every file has a `files` row scoped to `org_id`.
  - Portal downloads go through `/api/portal/files/:token/:fileId`, which checks
    the token first.
  - Previews come from the preview ladder; a HEIC original is never rendered.
  - Orphaned storage objects are reconciled.
- **Evidence:** FIELD-01 `orphan-storage-reconciliation`. It is BLOCKED on the
  acceptance stack until the stack has a storage key file (`--storage-env`).
  This is a known gap the reviewer should test by hand.

### 6. Payments and provider webhooks

- **Attacker:** someone who forges a webhook call, replays one, or races two
  settlements.
- **Controls:**
  - Stripe and Plaid webhooks verify the provider's signature.
  - Provider receipts are idempotent (`qbo_webhook_provider_receipts` and the
    payment receipts).
  - Settlement and refunds run as locked single statements.
  - Live payment execution stays off.
- **Evidence:**
  - RACE-02: concurrent settlement, two releases refund once, intercompany lot
    sale, two conversions of one hold.
  - RACE-03: concurrent PO approvals and variance approvals, two agreements and
    two signatures, cancellation against signature.

### 7. Imports

- **Attacker:** a member with import rights, or one without import rights who
  tries to change import state directly.
- **Tries to:**
  - commit a batch twice;
  - forge a batch's receipts or verification hash;
  - delete homes someone has already used.
- **Controls:**
  - The Open-WIP cutover is a durable claimed job with one receipt per home.
  - Members cannot write import state.
  - Agreement evidence carries a server-computed hash and is immutable once
    reviewed (`20261019100000`, `20261019200000` and their review fixes).
- **Evidence:** CUTOVER-01, WARR-01 (installed-base import).

### 8. Job queue and scheduled workers

- **Attacker:** a member who inserts into `outbox` from the browser, or an
  outsider who calls a cron route.
- **Controls:**
  - Members may queue only the job types a signed-in request queues
    (`20261020210000_outbox_member_job_types`). Without this, a browser-written
    `release_payment_run` would execute as the run's preparer.
  - Claims are fair across organizations, and bulk mutations have hourly
    per-org budgets.
  - Cron routes check `isAuthorizedCronRequest` (`lib/services/cron-auth.ts`, which fails closed without `CRON_SECRET`) even though they sit in
    `PUBLIC_API_ROUTES`.
- **Evidence:** OPS-01, SCALE-01.

### 9. Audit integrity

- **Controls:** audit rows are append-only; a mutation whose audit is lost never
  reports a clean success; exports are sealed.
- **Evidence:** SEC-01 `lost-audit-is-never-a-clean-success`,
  `audit-evidence-is-append-only`, `audit-export-is-complete-scoped-and-sealed`.

## Member write fences

The Data API is reachable with a member's own JWT, so a service-only rule that a
table does not enforce is not a rule. These migrations close the gaps the golden
scenarios found. Each one is RESTRICTIVE, so it only ever removes rights.
`service_role` (the services after their checks) is unaffected.

| Migration | Tables | A member may write only with |
|---|---|---|
| `20261003048000_starts_release_and_purchasing_fences` | Starts release and purchasing tables | The service path |
| `20261014130000_release_resume_and_fences` | Release-keyed budgets, schedule items and inspections | The service path (unique release keys) |
| `20261015100000_bid_and_price_book_fences` | Bid packages and price agreements | The service path |
| `20261012010000_selection_writes_revision_fence` | Selections | The revision-checked path |
| `20261018150000_warranty_member_write_fence` | Requests, visits, backcharges (read-only to members) | The service path |
| `20261020210000_outbox_member_job_types` | `outbox` | A listed member job type, pending, fresh |
| `20261021200000_production_member_write_fences`, narrowed by `20261021210000_member_write_fence_narrowing` | `communities`, `lots`, `commitments`, `commitment_lines` | Communities: `community.write`. Lots: `lot.write` or `community.write`. Orders and their lines: `commitment.write` on the org role or on the member's project role for that home |

ROLE-01 found these gaps. Before the fences, any member could rename a
community, add a lot or change a lot's status, and a superintendent seated on a
home could insert a purchase order or change its total. The first fence left
`commitment_lines` open, so a seated superintendent without `commitment.write`
could still change or add lines on a draft order, and approval re-totals the
order from its lines; it also admitted `lot.write` on communities and
`plan.release`/`closing.manage` on lots, which let those roles change any lot
column (premium, cost basis, lot number). The review migration closes all three:
lines take the order's key, the offering override and the close-lot step are
written by their services after their own permission checks, and the lot fence is
`lot.write` or `community.write` only. SUPPLY-01 and ROLE-01 assert both line
refusals. The lock on an approved order is still enforced by its own trigger,
which the services meet (SUPPLY-01 `serviceLineEdit`).

Reads: commitments and their lines are also readable to org-level
`commitment.read` holders (purchasing works every home in its divisions), still
bounded by the RESTRICTIVE `division_scope` policies.

## Internal pre-review checklist

Arc completes this list and attaches the evidence before the reviewer starts.

- [ ] SEC-01 passes on the release commit (`~/.arc-acceptance/bin/run.sh <tag> SEC-01`).
- [ ] ROLE-01 passes on the release commit. Its expected file
      (`scripts/books-acceptance/expected/ROLE-01.json`) is reviewed against
      `docs/production-org-playbook.md`: who may do what on each desk.
- [ ] RACE-02 and RACE-03 pass (money concurrency).
- [ ] FIELD-01, TRADE-01 and BID-01 pass (portals); the storage subcase passes
      with `--storage-env`, or is tested by hand.
- [ ] CUTOVER-01, OPS-01 and SCALE-01 pass (imports and the queue).
- [ ] `pnpm test:auth` passes (permission catalog, authorization policy).
- [ ] Every table added since the last review has org-scoped RLS, with
      `(select auth.uid())` written in that form. Check with Supabase advisors
      on the acceptance stack, and list exceptions.
- [ ] Every new `security definer` function sets `search_path = ''` and grants
      execute only to the roles that call it (no `public`, no `anon` unless it
      is a portal entry point that checks a token).
- [ ] Every route in `PUBLIC_API_ROUTES` checks its own secret, signature or
      token. List each route with the check it performs.
- [ ] Every schema-dependent flag in `lib/schema-flags.ts` is either off or has
      its migrations applied (`schemaFlagEnabled` refuses otherwise).
- [ ] No credentials in the repository; the secret names in
      `books-operations.md` (Secrets) are current.
- [ ] The production activation manifest (`production-activation.md`) is
      approved, so the reviewer tests the schema production will actually run.

## What the reviewer receives

- This document, `reference/audit-trail.md`, `production-org-playbook.md` and
  `production-activation.md`.
- Read access to the repository at the release commit.
- An acceptance stack seeded with the production builder (two orgs, every role)
  and its `browser-users.json`.
- Never production credentials or customer data.
