# Commercial Expansion — Master Gameplan

> **Audience:** an LLM executing agent. Read this file FIRST, fully, before opening any
> workstream doc. Every workstream doc in this folder assumes you have internalized the
> rules and context here. Do not skip to the code.

## 1. Mission

Arc today is built for residential/custom-home builders. We are expanding to serve
**commercial general contractors** (office/retail/industrial/multifamily GCs, roughly
$5–50M/yr revenue, typically running QuickBooks Online — NOT the Sage/Vista enterprise
tier). Later (NOT in these workstreams) we will expand to **production builders**
(Lennar-style: communities, lots, plan libraries). The product will have three postures:

| Tier key | Working name | Segment | Status |
|---|---|---|---|
| `residential` | Arc | Custom-home builders (current customers) | Live today |
| `commercial` | Arc Commercial | Commercial GCs | THIS gameplan set |
| `production` | Arc Production | Production/tract builders | Future — design for, don't build |

**Two-level posture model — this is load-bearing, get it right.** Many GCs do BOTH
residential and commercial work in one company; they buy Arc once. Therefore:

- **The PROJECT is the unit of posture.** `projects.property_type` (existing enum,
  residential/commercial) decides everything inside a project workbench: terminology
  (Client vs Owner), which modules appear in the project sidebar (meetings,
  transmittals, safety…), and billing-mode defaults at financial setup. A mixed org
  simply has projects of both types side by side.
- **The ORG tier (`orgs.product_tier`) is only (a) the default posture for new
  projects/prospects, (b) the vocabulary used on org-level surfaces (desks, org nav),
  and (c) the marketing/packaging segment.** Arc / Arc Commercial / Arc Production are
  how we position and onboard — NOT separate SKUs, NOT separate sign-ups, and NOT a
  capability gate.
- Neither level ever gates data access or blocks a route. Posture changes defaults and
  visibility, never semantics. Any module can be enabled on any project regardless of
  its type (visibility default ≠ availability).

One codebase, one schema. Workstream 01 builds the flag, the posture resolver
(`getProjectPosture()`), and the terminology helpers; every later workstream consumes
them.

**North-star pitch:** "Everything Procore does for a mid-size GC, plus real financials
and QBO sync, at a price that doesn't require a committee." We win on: unified job-cost +
billing + AP/AR (Procore needs an ERP), native e-sign (no DocuSign tax), tokenized
no-login collaboration, bid benchmarking, and AI (drawing OCR, receipt extraction).

## 2. What already exists (do NOT rebuild)

A deep audit (July 2026) found these are already commercial-grade — reuse them:

- **Buyout spine:** bid packages → ITB invites → sub bid portal (addenda ack gating,
  PIN, resubmission) → leveling → award → auto-created commitment with SOV lines →
  e-signed subcontract → buyout rollup. `lib/services/bids.ts`, `bid-portal.ts`,
  RPC `run_bid_award_conversion`.
- **Sub-side AIA billing:** `commitment_sov_lines` (scheduled_value_cents,
  previous_billed_cents, current_billed_cents, stored_materials_cents,
  retainage_held_cents, retainage_released_cents) + `vendor_bill_sov_allocations`.
  **This is the reference model for the owner-side SOV in workstream 02.**
- **RFIs:** `lib/services/rfis.ts` — atomic per-project numbering (`next_rfi_number` RPC
  via `lib/services/project-sequence.ts`), responses, portal responders without login,
  cost/schedule impact, `convertRfiToChangeOrder`.
- **Submittals:** `lib/services/submittals.ts` — revisions/supersede chain,
  `approved_as_noted`, spec_section, lead_time_days, sub portal upload.
- **Job cost:** `lib/services/budgets.ts` — cost-code budget, committed/actual/pending
  rollup, EAC/CTC/VAC (`budgets.ts:1034-1101`), variance alerts, budget locking triggers.
- **Reports:** `lib/services/reports/` — WIP over/under, profitability, forecast CTC,
  AP/AR aging, CO log, payments ledger, pay-application PDF, shared `csv.ts`.
- **Compliance holds:** `compliance-documents.ts`, `compliance.ts` — COI minimums,
  payment blocked on missing docs / missing lien waiver
  (`vendor-bills.ts` ~L699-720).
- **Lien waivers:** full matrix conditional/unconditional × progress/final
  (`lien-waivers.ts`, `invoice-lien-waivers.ts`).
- **Native e-sign:** `lib/services/envelopes.ts` + `app/(app)/signatures/actions.ts`
  (pdf-lib, envelopes, templates, bulk send). Covers proposal, estimate, change_order,
  subcontract, contract, lien_waiver source types.
- **Drawings:** versioned sets/revisions/sheets, OCR pipeline
  (`drawings-pipeline.ts`), markups, `drawing_pins` hyperlinking to
  task/rfi/punch_list/submittal/daily_log/observation/issue.
- **Warranty dispatch pattern:** `lib/services/warranty.ts` — assign to a
  `assigned_company_id`, auto-dispatch email to that company's contacts. **This is the
  reference pattern for punch ball-in-court in workstream 06.**
- **Portal infrastructure:** `portal_access_tokens` (per-capability booleans, PIN,
  account gate), `external_portal_accounts` (cross-token email+password identities),
  `lib/services/portal-access.ts`, `external-portal-auth.ts`.
- **Time tracking:** `time_entries` with OT/DT, approvals, T&M ticket flow
  (`tm-tickets.ts`, `cost-plus.ts`, `billing-rate-schedules.ts`).

## 3. Workstream index and dependency order

Execute in this order. Within a workstream, follow that doc's own phase order.

| # | Doc | Contents | Depends on |
|---|---|---|---|
| 01 | `01-product-tiers-terminology-csi.md` | `product_tier` flag, terminology layer (client→owner), commercial defaults, CSI MasterFormat cost-code seed, cost-type dimension | — |
| 02 | `02-owner-sov-progress-billing.md` | ✅ SHIPPED 2026-07-10 (code + migrations applied; manual QA acceptance + draw regression pending — see doc STATUS) — Prime-contract Schedule of Values, monthly pay applications, G702/G703 PDFs, stored materials, stepped retainage | 01 |
| 03 | `03-change-management-lifecycle.md` | ✅ CODE COMPLETE 2026-07-10 (migration + manual QA pending — see doc STATUS) — PCO→OCO state machine, cost-vs-price, sub-CO rollup into prime CO, RFI/source linkage | 01, 02 (contract sum feeds G702) |
| 04 | `04-external-collaborators-submittal-routing.md` | ✅ CODE COMPLETE 2026-07-10 (migrations applied to prod; manual QA pending — see doc STATUS) — External collaborator seats (architect/engineer/owner-rep), submittal review routing GC→architect, ball-in-court | 01 |
| 05 | `05-project-docs-suite.md` | ✅ CODE + MIGRATION COMPLETE 2026-07-10 (manual QA pending — see doc STATUS) — Meeting minutes, transmittals, formatted document numbering, PDF exports for RFIs/submittals/daily reports/punch | 01 (04 helps but not required) |
| 06 | `06-field-safety-quality-punch.md` | ✅ CODE COMPLETE, MIGRATIONS APPLIED 2026-07-10 (manual QA pending — see doc STATUS) — Safety module (inspections, incidents, toolbox talks, observations), quality checklists, punch ball-in-court to subs | 01 |
| 07 | `07-financial-controls.md` | ✅ CODE + MIGRATIONS COMPLETE 2026-07-11 (manual QA pending — see doc STATUS) — Budget transfers + contingency management, sub prequalification workflow, W-9/tax-ID/1099 | 01 |
| 08 | `08-daily-reports-schedule-commercial.md` | ✅ CODE COMPLETE 2026-07-11 (migration + manual QA pending — see doc STATUS) — Daily report delay/equipment/visitor/delivery sections, sub-authored logs, PDF, schedule dependency types + lag writable | 01, 05 (PDF helper) |
| 09 | `09-platform-deferred-and-production.md` | DEFERRED items (ERP abstraction, SSO, customer API, P6/MSP interchange) + Arc Production design constraints. Mostly documentation; small prep tasks only | — |

Tiering from the strategy review maps as: Tier 1 (dealbreakers) = 01–04.
Tier 2 (expected) = 05–08. Tier 3 (differentiators) are folded into the relevant docs
as clearly-marked "Differentiator" sections. 09 is consciously deferred.

## 4. Non-negotiable repo rules (recap + additions)

These come from `CLAUDE.md` at repo root — it is authoritative. Highlights the executor
must not violate, plus expansion-specific additions:

1. **Search first.** ~90 services, ~440 components. Before writing ANY helper, grep for
   it. Duplicating an existing capability is a defect.
2. **Services own business logic:** `requireOrgContext()` → `requirePermission()` →
   logic → `recordEvent()` + `recordAudit()` → mapped DTO. Actions and pages stay thin.
3. **Every query scoped by `org_id`.** No exceptions.
4. **Server actions return `{ success, error }`** (or the `ActionResult` pattern in
   `lib/action-result.ts` with `unwrapAction()` client-side — match whichever the
   nearest sibling uses). Never throw user-visible errors from actions.
5. **Zod-validate every action input** in `lib/validation/`.
6. **Migrations:** write SQL files to `supabase/migrations/` with timestamp prefixes
   (`YYYYMMDDHHMMSS_name.sql`). **NEVER apply a migration to the database yourself** —
   local env points at PRODUCTION Supabase. Write the file, then STOP and tell the human
   it needs `apply_migration` / `db push` approval. Design every migration to be
   backward-compatible (additive columns with defaults; no destructive changes).
7. **Design rules:** tokens only (globals.css oklch variables), radius 0, no gradients,
   no hero banners, shadcn/ui primitives from `components/ui/` only, dense tables over
   cards, tabular-nums for money. Every view ships empty/loading/error states + dark
   mode. Match sibling-page density exactly.
8. **One home per mutation:** project pages are workbenches (mutations live there); org
   pages are desks (read-mostly, rank/aggregate, deep-link). Never build an org view for
   symmetry.
9. **Leave no trash:** replacing something deletes the old thing in the same change. No
   `-v2` names, no commented-out code, no console.log.
10. **Verify with `pnpm lint`** (type-aware). Do NOT run `pnpm dev` or `pnpm build`.
    Financials changes: also run `pnpm test:financials`.
11. **Cron routes handle GET** (Vercel Cron sends GET). New public/webhook routes go in
    `PUBLIC_API_ROUTES` in `proxy.ts`.
12. **Money is integer cents** everywhere (`*_cents`). Percentages are numeric. Follow
    existing column naming exactly.
13. **Numbering:** any new per-project numbered entity uses the
    `lib/services/project-sequence.ts` pattern — a Postgres RPC
    `next_<entity>_number(project_id)` + unique constraint + retry helper
    (`insertWithProjectNumberRetry`). Copy the RFI implementation.
14. **PDFs:** use the existing pdf-lib stack. Look at
    `lib/services/reports/pay-application.ts` and `lib/pdfs/esign.ts` before writing any
    new PDF generator; follow their layout helpers and typography.
15. **Emails:** React email templates in `lib/emails/`, sent via
    `lib/services/mailer.ts` (`renderEmailTemplate`, `sendEmail`, `getOrgSenderEmail`).
    Copy `rfi-notification-email` structure.
16. **Permissions:** new permission keys are added to the catalog used by
    `TEAM_PERMISSION_OPTIONS` in `lib/services/team.ts` and enforced via
    `requirePermission()`. Follow the `<domain>.<verb>` naming (`budget.write`,
    `invoice.approve`).
17. **Posture awareness (new rule, from workstream 01):** posture-dependent behavior is
    controlled ONLY through the helpers built in workstream 01 —
    `getProjectPosture(project, org)` inside project scope, `getOrgProductTier()` on
    org-level surfaces, `terminology(posture)`, and the nav config. Never write
    `if (org.product_tier === 'commercial')` or `property_type === ...` inline in a
    component — always go through the helpers so mixed orgs work and Production can
    slot in later.
18. **Every new table ships complete, in the same migration:** org-scoped RLS
    policies (copy the policy block from a recent neighboring migration; all
    `auth.uid()` references MUST be written `(select auth.uid())` — bare `auth.uid()`
    re-introduces the RLS initplan performance problem fixed in July 2026), indexes
    on `(org_id, project_id)` for anything list-queried (plus FK-hot columns), and
    the repo's standard `updated_at` trigger where the table has `updated_at`.
    This applies to EVERY table in workstreams 02–08, not just the ones whose doc
    mentions RLS explicitly.
19. **Search index registration:** `lib/services/search-index.ts` maps the
    `entity_type` values passed to `recordAudit()` onto search entity types. Any new
    entity with a register/log view (pay applications, meetings, transmittals,
    inspections, incidents, observations, prequalifications, budget transfers) must
    be registered in that map in the same workstream, or it is invisible to global
    search. Follow the existing entries' shape.
20. **Email allowlist:** only notification types listed in `EMAIL_NOTIFICATION_TYPES`
    (`lib/types/notifications.ts`) ever send email — everything else is in-app only.
    Any new notification that must email (reviewer-step assignments, meeting
    distribution, incident alerts, punch dispatch) needs its type added to that
    allowlist deliberately, in the same change that introduces it. Do not assume
    wiring through the notification service is enough; that exact silent-no-send bug
    has happened before.
21. **Permission keys land in the RBAC catalog seed, not just the UI.** The
    catalog-as-code seed is the source of truth for roles/permissions (RBAC overhaul,
    2026). Every new key (`sov.write`, `payapp.write`, `submittal.route`,
    `meeting.write`, `transmittal.write`, `inspection.write`, `safety.write`,
    `budget.approve`, `prequal.review`) is added to the catalog seed AND to
    `TEAM_PERMISSION_OPTIONS`, with a deliberate decision about which existing roles
    receive it (e.g. `bookkeeper` gets `payapp.write`; field roles get
    `inspection.write`/`safety.write`). State the role mapping in the workstream's
    completion note.
22. **Cron registry mirror:** if a workstream adds or renames a cron route, update
    `CRON_JOBS` (ops heartbeat registry) to mirror `vercel.json`, or platform ops
    will flag the job as dead. (Currently only 07's compliance-autopilot extension
    touches an existing cron — verify its job name is already registered.)

## 5. How to execute a workstream (process contract)

For EACH workstream doc:

1. Read the doc fully. Read every file listed in its "Read these files first" section.
2. Re-verify schema claims against reality before writing migrations:
   use Supabase MCP `list_tables`/`execute_sql` (SELECT-only) or read
   `supabase/migrations/`. The gameplans were written against the July 2026 schema;
   if drift is found, adapt and note it.
3. Work phase by phase, in order. Each phase ends with `pnpm lint` clean.
4. Migrations: write the `.sql` file, then pause for human approval before assuming the
   table exists. You may continue writing service/UI code against the planned schema
   while waiting, but say clearly that the migration is pending.
5. After each phase, produce a short completion note: what shipped, files touched,
   migration files written (pending apply), anything deviating from the plan and why.
6. Do not start the next workstream until the current one's acceptance checklist passes.
7. If the doc conflicts with repo reality (file moved, pattern changed), repo reality
   wins; follow the *intent* of the doc and note the deviation.
8. When a doc says "copy the X pattern," open X and actually mirror its structure —
   file layout, naming, error handling — not just its idea.
9. **All acceptance testing runs against the dedicated internal QA org** (created as a
   workstream 01 deliverable — see 01 Phase A). There is no staging environment; local
   dev points at production Supabase. Never run acceptance scenarios in a real
   customer's org.
10. **Workstream 02 has an extra merge gate:** because it refactors the retainage
    negative-line block inside the live invoice path, it does not merge without a
    manual regression on an existing draw-billing project (create draw → invoice →
    retainage line → QBO fields intact) in addition to `pnpm test:financials`.

## 6. Terminology glossary (used across all docs)

- **Owner** — the party the GC bills. Residential posture calls this "Client."
- **Prime contract** — GC↔Owner contract (`contracts` table).
- **SOV** — Schedule of Values: the line-item breakdown of the contract sum that
  progress billing bills against.
- **Pay application (pay app)** — the monthly owner invoice package: G702
  (Application and Certificate for Payment, the cover/summary sheet) + G703
  (Continuation Sheet, the per-SOV-line detail). We generate "AIA-style" documents —
  do NOT reproduce AIA's copyrighted forms verbatim; same data, own layout, labeled
  "Application for Payment."
- **PCO** — Potential Change Order: a priced candidate change, not yet approved by owner.
- **OCO / Prime CO** — owner-approved change order that adjusts the contract sum.
- **CCO** — Commitment (subcontract) change order. Already exists:
  `commitment_change_orders`.
- **Ball-in-court (BIC)** — which party currently owes action on a document.
- **Retainage** — % withheld from each payment until completion. Exists both directions.
- **Stored materials** — materials purchased/delivered but not yet installed, billable
  on a pay app subject to backup.
- **CSI MasterFormat** — the standard commercial cost/spec taxonomy (Divisions 01–49).

## 7. Product-tier design constraints (so Production doesn't force a rewrite)

When making ANY schema or naming decision in these workstreams:

- Never bake "commercial" into a table or column name. It's `prime_sov_lines`, not
  `commercial_sov_lines`; `change_events`, not `commercial_pcos`.
- Posture changes defaults and visibility, never semantics. A residential project can
  turn on progress billing; a commercial project can use draws. A mixed org runs both
  kinds of projects under one subscription — nothing in these workstreams may assume
  an org is homogeneous.
- Keep the terminology map (01) as the single choke point for user-facing nouns, so
  Production can add its own (e.g., "Buyer" instead of "Owner", "Lot" context) by adding
  one map entry, not by another find-replace sweep.
- Anything keyed per-project today that Production would key per-lot/per-plan
  (schedules, budgets, selections) — do not add new hard project-level assumptions in
  shared helpers; keep entity IDs opaque and passed-in.

## 8. Master acceptance (the whole program is done when)

- **Posture works at both levels.** A commercial-POSTURE project (in any org) shows
  Owner language, progress billing as the default fixed-price mode, and the new
  modules (meetings, transmittals, safety) in its project sidebar. An org flipped to
  `commercial` TIER additionally gets: Owner vocabulary on org-level surfaces, new
  projects defaulting to commercial posture, and the CSI/template/W-9 seeds.
- **The mixed-org scenario passes:** one org holds a residential custom home and a
  commercial build side by side — each project workbench speaks its own language and
  shows its own modules, org desks aggregate both, one subscription, zero
  double-signup. Zero regressions for existing all-residential orgs (default tier).
- A commercial demo project can run the full monthly cycle end-to-end: budget with CSI
  codes → buyout via bid packages → subcontract with SOV → PCO priced from a CCO →
  owner approves OCO → monthly pay app with G703 lines, stored materials, retainage →
  release retainage at completion → WIP report reflects it all.
- A submittal can route sub → GC → architect (external seat, no full license) → returned
  approved-as-noted with a stamped PDF.
- Every RFI/submittal/daily report/punch list/meeting/transmittal prints to a clean PDF.
- `pnpm lint` and `pnpm test:financials` pass; every migration file is in
  `supabase/migrations/` and has been human-approved before apply.
