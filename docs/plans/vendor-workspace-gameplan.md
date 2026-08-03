# Vendor Workspace Gameplan — builder-scoped external access

> **Status: ACTIVE PLAN — intent, not a description of the system.**
> Nothing in this document is guaranteed to exist. Never infer current app
> behavior from it. Source of truth is the code, `CLAUDE.md`, and the reference
> docs at the `docs/` top level.

**Status:** NOT STARTED (code). Written 2026-08-02, on branch `docs/cleanup`.
**Migration APPLIED to production 2026-08-03** —
`supabase/migrations/20260803001216_vendor_workspace_access.sql`, recorded as
version `20260803001216`. The schema gate is cleared; WS-1 onward may proceed.
Verified post-apply: 2 relationships created, 2/2 grants linked and
project-stamped, `portal_access_tokens.project_id` nullable, the
`portal_access_tokens_scope_present` check, RLS, and the `updated_at` trigger
all in place.
**Audience:** an LLM executor.

**Supersedes Phase 6 of [`external-access-gameplan.md`](external-access-gameplan.md).**
That phase is paused and its premise is wrong; this replaces it. Phases 1–5 of
that document shipped 2026-08-02 and are **not** re-opened here — the person-model,
the cascading revoke, the unified gate, the claimed-account lock, the single auth
form, and the project share-sheet roster all stand.

---

## 0. Why Phase 6 could not work

Phase 6 assumed "a bid invite is a person on a project, pre-award" and planned to
mint `portal_access_tokens` rows for bid invites. Production says otherwise
(re-verified 2026-08-02, unchanged since the pause):

| | count |
|---|---|
| `bid_packages` total / **with no `project_id`** | 8 / **2** |
| `bid_invites` total / **with no `contact_id`** | 14 / **10** |
| `bid_access_tokens` | 33 |
| `portal_access_tokens` | 29 |
| `external_identities` / grants / **bid grants** | 2 / 2 / **0** |

`portal_access_tokens.project_id` is `NOT NULL` and `/s/[token]` requires a
project *and* a company, so a prospect-stage bid **physically cannot** mint a
portal token. A quarter of bid packages are pre-*project*, not merely pre-award.

**The real finding is one level up: the unit of external access is wrong.**
A `portal_access_tokens` row is `(person, project, portal_type)`. The real-world
relationship is `(person, builder)`. Every awkward thing in the current model is
downstream of that mismatch:

- A vendor on six projects is six access rows, six sets of ~30 `can_*` booleans,
  six revokes. There is no row that says "this vendor works with us".
- A bid is a **relationship event, not a project event**. It has nowhere to live.
- `external_identity_grants` has no project scope of its own; scope exists only
  by joining through the token. That is precisely how the org-wide revoke bug
  (Phase 1, WS-1.2) became possible, and the fix there is a workaround for the
  missing column, not a resolution.
- `listProjectAccessRoster` keys rows on `token_id`
  ([portal-access.ts](../../lib/services/portal-access.ts)). The UI says
  "people"; the row identity is still the token. Harmless today, diagnostic.

Phase 6's own pause note listed three ways forward. **Option 2 — the
builder-scoped vendor portal — is the correct architecture**, not one of three
equals. Option 1 (nullable `project_id` alone) and option 3 (project-backed bids
only) are patches on the wrong unit; option 3 additionally leaves two bid portals
standing, which `CLAUDE.md` forbids.

## 0.1 The model to build toward

> **A person has a relationship with a builder. Projects and bids are what that
> relationship gives them access to.**

- `external_org_relationships` is the parent: one row per `(identity, org)`.
- `external_identity_grants` hangs off it and carries **its own** `project_id`
  (nullable) or `bid_package_id` (nullable) — scope stops being a join.
- `portal_access_tokens` stays the **delivery and bootstrap** mechanism, plus the
  home of genuinely link-shaped one-offs (`scoped_rfi_id`,
  `scoped_change_event_rfq_id`, `scoped_submittal_revision_id`). Its
  `project_id` becomes nullable so a bid-scoped record can exist.
- One vendor workspace per builder: **Projects, Bids, Payments**. The switcher
  already renders exactly this shape (org groups → items) — today that is a
  read-time illusion over per-project tokens; this makes it the real thing.

**Tokens are not being deleted, and accounts are not being made mandatory.**
The audience split is deliberate:

| Audience | Primary door | Why |
|---|---|---|
| Vendors, bidders, reviewers | **Account** | Repeat players, multi-project, often multi-builder; they touch money (payment setup, invoices, bids). Bearer URLs forwarded around a sub's office are the wrong credential class for that. |
| Clients / owners / buyers | **Token**, account optional | One project, consumption-heavy, done in a year. Forcing account creation to view selections and a draw schedule is friction with no payoff. |

Phase 3 of the previous plan already inverted the semantics for anyone who
claims: the token becomes a pointer to a sign-in. What has not flipped is the
builder-side and the data model. That is this plan.

## 0.2 Standing constraints

- **Local dev points at production Supabase.** Reads are fine. Never run a
  destructive statement, seed, or "test" mutation.
- **Never apply a migration.** The one this plan needs is already written and
  waiting; if you conclude another is required, write the `.sql`, STOP, and say
  so. Keep writing service/UI code against the planned schema meanwhile.
- Services own the logic: `requireOrgContext()` → `requirePermission()` → logic →
  `recordEvent()` + `recordAudit()` → mapped DTO. Actions return
  `{ success, error }` / `ActionResult`.
- Every query scoped by `org_id`.
- Acceptance testing runs in the QA org. There is no staging.
- There is effectively **no installed base** (29 portal tokens, 2 identities, 0
  bid grants). Be aggressive, delete freely, write no compatibility shims. Any
  workstream that starts proposing a staged data cutover is over-engineering.

---

## WS-1 — Relationship service layer (no UI)

Land the parent row and make grants use their own scope. Nothing user-visible.

**WS-1.1 — `lib/services/external-relationships.ts`.** New service owning
`external_org_relationships`: `ensureRelationship({ orgId, identityId, companyId })`,
`getRelationship`, `listRelationshipsForIdentity`, and the status transitions
(`pause` / `resume` / `revoke`). The status rules from Phase 1 carry over
verbatim and now apply one level up: **revoking a relationship cascades to every
grant under it**, and `ensureRelationship` must never resurrect a `revoked` or
`paused` row (the WS-1.3 lesson — `upsertGrant` clearing `revoked_at` is what
let a revoked person restore their own access).

**WS-1.2 — Point `upsertGrant` at the relationship.** In
[`external-portal-auth.ts`](../../lib/services/external-portal-auth.ts), every
grant write resolves (or creates) the relationship first and stamps
`relationship_id`, plus `project_id` / `bid_package_id` directly.

**WS-1.3 — Simplify the project-scoped mutations.**
`setExternalPortalAccountStatus` currently selects token ids for
`(org_id, project_id)` then updates grants `.in("portal_access_token_id", ids)`.
With `grants.project_id` this becomes a direct predicate. Delete the subquery;
do not leave both paths.

**Acceptance:** `pnpm test:auth` passes; revoke-in-project-A still does not touch
project B; a revoked relationship cannot be reactivated by signing in.

## WS-2 — Project-optional bid access

**WS-2.1 — Audit every `portal_access_tokens` consumer for null `project_id`
BEFORE anything writes one.** This is the load-bearing step and it is not
optional. Grep every `.project_id` read on that table — `validatePortalToken`,
`assertPortalActionAccess`, `loadSubPortalData`, the roster, the reviewer and
client portals, `app/api/portal/**`. Each either handles null or explicitly
rejects a bid-scoped record. Write the audit result into this file as a list
before writing code.

**WS-2.2 — Bid invites mint `portal_access_tokens`.** Using
`scoped_bid_invite_id` (added by `20260802140000`, unused until now) and
`project_id` null when the package has none. Kills `hashBidToken`, the
`bid_access_token_id` FK, and the `/b` gate.

**WS-2.3 — The pure-email invite is the majority case.** 10 of 14 invites have
no `contact_id`. Auto-create the contact (and company where absent) at
invite-send time — a builder inviting a bidder is forming a vendor relationship
and the records should exist. Without a contact there is no bound email, so the
Phase 3 claimed-account lock falls back to the weaker grant-existence signal;
creating the contact is what keeps that lock strong. **Check what the bids
system already creates before adding anything.**

## WS-3 — The vendor workspace

**WS-3.1 — Route shape.** One workspace per `(vendor, builder)` with Projects,
Bids and Payments sections. Reuse `PortalShell` and `resolvePortalGate`; every
section is a real route so notification emails can deep-link (never a
client-side tab switcher — `CLAUDE.md`).

**WS-3.2 — Bids section.** Re-mount the bid portal v2 components (shipped
2026-07-18 — **reuse, do not rebuild**), listing every live invite for that
relationship, project-backed or not. A project-less bid is now simply an item
here; the original problem dissolves rather than being special-cased.

**WS-3.3 — `/b/[token]` becomes a redirect** for links in the wild: resolve the
bid token → its replacement portal token → 307. Leave no parallel
implementation. Mark `bid_access_tokens` deprecated in
`docs/database-overview.md`.

**WS-3.4 — Fix the switcher's fallback.** `ExternalWorkspaceSwitcher` now
prefix-matches and deliberately shows no current item when nothing matches
(because `/b`'s hrefs share no prefix with `/b/<token>`). Once `/b` redirects
into the workspace this dead case disappears — delete the comment with it.

## WS-4 — Permission presets

Six projects × ~30 booleans per vendor is unadministrable and nobody will ever
audit it. The UI already thinks in presets (`standard` / `read_only` / `custom`
in [`invite-access-options.tsx`](../../components/sharing/invite-access-options.tsx));
the schema should too: a preset key on the grant plus a sparse override map,
replacing the boolean columns.

**Needs its own migration — write it, STOP, do not fold it into WS-1's.** It is
a wide mechanical change across every `can_*` reader and deserves to land alone,
after the access model is stable.

## WS-5 — Magic-link sign-in for externals

Phase 2's acceptance criterion was "a sub recovers unaided, on a phone, in under
a minute". A six-digit email code makes most of the password apparatus
vestigial for this audience. Field subs on phones do not want passwords.

Reuse the rate-limit substrate (`auth_rate_limits`) and the direct mailer
pattern; **do not** route through `EMAIL_NOTIFICATION_TYPES` (that allowlist
governs opt-in notifications to internal users — see Phase 2's environment
notes). Keep the non-disclosure contract: the response must be byte-identical
whether or not the email exists. **Needs a migration** for the code storage —
write it, STOP.

---

## Sequencing

```
migration 20260803001216        ← APPLIED 2026-08-03, gate cleared
WS-1  Relationship service      ← no UI, ship alone
WS-2  Project-optional bids     ← WS-2.1 audit before any write
WS-3  Vendor workspace          ← absorbs /b
WS-4  Permission presets        ← own migration, after the model is stable
WS-5  Magic-link sign-in        ← own migration, independent of WS-1..4
```

WS-5 may run in parallel with anything. WS-1 → WS-2 → WS-3 may not.

## Already done, do not redo

Landed 2026-08-02 alongside this plan:

- Share sheet flipped person-first: `PortalLinkCreator` (878 lines, "create a
  link" verb, email-vs-link as a top-level peer choice) is **deleted**, replaced
  by [`project-invite-form.tsx`](../../components/sharing/project-invite-form.tsx)
  (searchable person picker → what they reach → send) and
  [`invite-access-options.tsx`](../../components/sharing/invite-access-options.tsx).
- **Bug fixed:** `sendPortalInviteAction` silently discarded expiry, PIN and
  permissions — the email path never passed them through. It now accepts them,
  and applies them to a reused access record rather than dropping them.
- Org-wide [`external-access-directory.tsx`](../../components/sharing/external-access-directory.tsx)
  in Settings → External access: what one person can reach, and revoke-everywhere.
- Posture terminology in the roster and invite form (was hardcoded "Homeowner").
- `ExternalWorkspaceSwitcher` prefix-matching (exact matching mislabelled the
  current project on every sub-page).

Retracted after checking: `/b` does **not** double-count portal access. It is a
single-page portal, so recording there is once per visit, exactly like `/s` at
its root.
