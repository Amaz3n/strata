# Workstream 02 — Owner-Side SOV Progress Billing (AIA-style Pay Applications)

> Prereq: 00 master + workstream 01 shipped. This is the single most important
> workstream: commercial GCs bill owners monthly against a Schedule of Values. Arc
> currently only offers milestone/bank-draw billing (residential) or cost-plus.

## STATUS — implemented 2026-07-10 (phases 1–5 + wire-up; phase 6 e-sign stretch NOT built)

**Code-complete and migrations applied to prod** (`prime_sov`, `stepped_retainage`,
`progress_billing_permissions`, `pay_application_rpcs`). `pnpm lint` clean;
`pnpm test:financials` 45/45 incl. new `tests/pay-app-math.test.js`.

Key landing points:
- Data: `prime_sov_lines` / `pay_applications` / `pay_application_lines`;
  `project_financial_settings.fixed_price_billing_basis` ('draws'|'progress');
  `contracts.retainage_schedule` + `stored_materials_retainage_percent`.
- Services: `lib/services/prime-sov.ts` (incl. `applyChangeOrderToSov` ready for WS03),
  `lib/services/pay-applications.ts`, pure math in `lib/financials/pay-app-math.ts`.
- Atomicity via RPCs `post_pay_application` / `void_pay_application` /
  `release_prime_sov_retainage` (run_bid_award_conversion pattern).
- Invoicing: new `source_type: "pay_application"`; the retainage negative-line block
  now accepts a precomputed amount + label — draw output is byte-identical.
- UI: Receivables sub-tabs "Schedule of Values" + "Pay Applications";
  `PrimeRetainagePanel` on the Retainage tab; stepped-retainage + draws-vs-progress
  choice in financial setup (both project sheets).
- PDF: ONE combined Application for Payment + Continuation Sheet document.
- Permissions: `sov.write`/`payapp.write` → org_owner, org_admin, org_office_admin,
  org_bookkeeper, pm (verified in prod). Search index registered (`pay_application`).

Deviations from this doc (repo reality won):
1. PDFs use `@react-pdf/renderer` (not pdf-lib) following `lib/pdfs/pay-application.tsx`,
   and render one combined document since `pdf_file_id` is a single pointer.
2. The rollout flag lives at `/admin/features` (`feature_flags` table, key
   `progress_billing_enabled`, default OFF), not `/platform`.
3. The billing-periods table is `project_billing_periods`, not `billing_periods`
   as written in the Migration 1 DDL below.
4. Pay-app math tests are node-test style in `tests/` (wired into `test:financials`),
   not bun-style, so the acceptance command actually runs them.

Follow-ups: delete `progress_billing_enabled` flag after prod validation
(leave-no-trash); phase 6 e-sign stretch unbuilt.

## Goal

A fourth owner-billing basis, **`progress`** (SOV progress billing), for fixed-price
prime contracts:

1. A prime-contract **Schedule of Values** (`prime_sov_lines`) — mirror of the existing
   `commitment_sov_lines`, which is the proven model in this codebase.
2. Monthly **pay applications**: enter % complete / this-period amounts / stored
   materials per SOV line → generates an invoice + immutable pay-app snapshot.
3. **G702/G703-style PDFs** ("Application for Payment" + "Continuation Sheet") — same
   data as AIA forms, own layout (do not clone AIA's copyrighted form).
4. **Stepped retainage** (e.g., 10% until 50% complete, then 5%) and line-level
   retainage handling on owner billing.
5. Retainage release flow that works with the existing `retainage` table.

## Non-goals

- Do not touch draw billing, cost-plus, fee, or T&M paths — additive new mode only.
- No owner-side approval/certification workflow inside the pay app (architect
  certification is a signature on the PDF; e-sign integration is a stretch goal, last
  phase).
- No changes to sub-side SOV (`commitment_sov_lines`) beyond reading it for reference.

## Read these files first

- `lib/financials/billing-model.ts` — `OwnerBillingBasis = draws | costs |
  costs_plus_fee | time_materials`; you are adding `progress`.
- `supabase/migrations/` — find the migration creating `commitment_sov_lines` and
  `vendor_bill_sov_allocations`; your new tables mirror them.
- `lib/services/invoices.ts` (~2,264 lines) — invoice creation, the system-generated
  negative "Retainage held" line (~L381-443), `client_visible`, numbering
  (`invoice-numbers.ts`), send/view/token flow.
- `lib/services/draws.ts` — how a billing artifact converts to an invoice; copy its
  conversion discipline, not its milestone semantics.
- `lib/services/retainage.ts` + `retainage` table (columns: contract_id, invoice_id,
  amount_cents, status held/released/invoiced/paid, release_invoice_id).
- `lib/services/reports/pay-application.ts` — existing draw-based pay-app PDF; you will
  supersede it for progress-billing projects but keep it for draw projects.
- `lib/services/billing-periods.ts` + `invoices.billing_period_id` (exists!) — pay apps
  should attach to billing periods.
- `lib/services/contracts.ts`, `contracts` table (verified columns:
  contract_type ∈ fixed/cost_plus/time_materials, retainage_percent,
  retainage_release_trigger, retainage_applies_to_fee, contingency_cents,
  parent_contract_id).
- `app/(app)/projects/[id]/financials/` receivables/billing tabs (memory: "Receivables
  billing workbench" — tabs morph by billing mode; draws tab appears for fixed-price).
- `lib/services/budget-from-estimate.ts` (pattern for "generate lines from another
  entity" — used for SOV-from-budget/estimate import).

## Data model

**Migration 1 — `<ts>_prime_sov.sql`:**

```sql
create table public.prime_sov_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  project_id uuid not null references public.projects(id),
  contract_id uuid not null references public.contracts(id),
  line_number integer not null,
  description text not null,
  cost_code_id uuid references public.cost_codes(id),
  budget_line_id uuid references public.budget_lines(id),
  scheduled_value_cents integer not null default 0,
  -- rollups maintained by service on each pay-app posting:
  previous_billed_cents integer not null default 0,
  stored_materials_cents integer not null default 0,   -- currently stored, not yet installed
  retainage_held_cents integer not null default 0,
  retainage_released_cents integer not null default 0,
  retainage_percent_override numeric,                   -- null = use contract schedule
  sort_order integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (contract_id, line_number)
);

create table public.pay_applications (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  project_id uuid not null references public.projects(id),
  contract_id uuid not null references public.contracts(id),
  application_number integer not null,
  period_start date,
  period_end date not null,
  billing_period_id uuid references public.billing_periods(id),
  status text not null default 'draft'
    check (status in ('draft','submitted','approved','invoiced','paid','void')),
  invoice_id uuid references public.invoices(id),
  -- G702 summary fields, snapshotted at submit time:
  original_contract_sum_cents integer not null default 0,
  change_order_sum_cents integer not null default 0,
  contract_sum_to_date_cents integer not null default 0,
  total_completed_stored_cents integer not null default 0,
  retainage_cents integer not null default 0,
  total_earned_less_retainage_cents integer not null default 0,
  previous_certificates_cents integer not null default 0,
  current_payment_due_cents integer not null default 0,
  balance_to_finish_cents integer not null default 0,
  submitted_at timestamptz,
  approved_at timestamptz,
  pdf_file_id uuid references public.files(id),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (contract_id, application_number)
);

create table public.pay_application_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  pay_application_id uuid not null references public.pay_applications(id) on delete cascade,
  prime_sov_line_id uuid not null references public.prime_sov_lines(id),
  -- the G703 columns for THIS period:
  scheduled_value_cents integer not null,
  previous_billed_cents integer not null,        -- from prior apps (work + stored installed)
  this_period_cents integer not null default 0,  -- work completed this period
  stored_materials_cents integer not null default 0, -- presently stored (not in prev or this period)
  percent_complete numeric not null default 0,       -- (prev + this) / scheduled
  balance_to_finish_cents integer not null,
  retainage_cents integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  unique (pay_application_id, prime_sov_line_id)
);
```

**Migration 2 — `<ts>_stepped_retainage.sql`:**

```sql
-- JSON schedule: [{"until_percent_complete": 50, "retainage_percent": 10},
--                 {"until_percent_complete": 100, "retainage_percent": 5}]
alter table public.contracts
  add column if not exists retainage_schedule jsonb,
  add column if not exists stored_materials_retainage_percent numeric;
```

Add RLS policies matching the pattern of `commitment_sov_lines`' migration (org-scoped;
copy verbatim from that migration's policy block, adjusting table names). Add the
standard `updated_at` trigger if the repo uses one (check neighboring migrations).

## Service layer

New file `lib/services/prime-sov.ts` (SOV CRUD) and new file
`lib/services/pay-applications.ts` (pay-app lifecycle). Both follow the canonical shape
(`requireOrgContext` → `requirePermission` → logic → `recordEvent`/`recordAudit` → DTO).

**prime-sov.ts:**
- `listPrimeSovLines(projectId)` — with computed rollups: total scheduled must equal
  contract sum; expose `variance_cents` when it doesn't (UI shows a reconcile warning).
- `upsertPrimeSovLines(projectId, lines[])` — bulk editor semantics (the SOV is edited
  as a grid). Renumber `line_number` sequentially on save. Block edits to
  `scheduled_value_cents` of a line already billed against UNLESS the change comes from
  a CO posting (flag via internal option, see workstream 03).
- `importSovFromBudget(projectId)` / `importSovFromEstimate(projectId)` — generate lines
  from budget_lines (grouped by cost code) or the executed estimate. Copy the mechanics
  of `budget-from-estimate.ts`. **Cost-codes-off orgs:** budgets can run in
  lines-as-buckets mode with no cost codes (see memory/budget-cost-codes-off-mode) —
  when budget lines have no cost_code_id, fall back to one SOV line per budget line
  (description = budget line name, cost_code_id null). Do not assume every budget
  groups by cost code.
- On prime CO approval (workstream 03 will call this): `applyChangeOrderToSov(coId)` —
  appends new SOV line(s) from the CO lines (one line per CO or per CO line — per CO
  line when lines have distinct cost codes; else single line titled "CO #N — <title>").

**pay-applications.ts:**
- `createPayApplication(projectId, {periodEnd})` — application_number =
  max+1 per contract; seeds `pay_application_lines` from current SOV state
  (previous_billed from SOV rollups, this_period 0). Status draft.
- `updatePayApplicationLines(payAppId, entries[])` — accepts either
  `this_period_cents` or `percent_complete` per line (UI lets the PM type either; when
  percent is entered, this_period = round(scheduled*pct) − previous). Validates:
  prev + this + stored ≤ scheduled per line (allow override flag for overbilling with a
  warning, some GCs front-load — store `metadata.overbilled: true`).
- Retainage computation per line: rate = line override ?? rate from
  `contracts.retainage_schedule` step matching the LINE's percent_complete ??
  `contracts.retainage_percent`. Stored materials use
  `stored_materials_retainage_percent ?? same rate`. Sum to app-level
  `retainage_cents`.
- `submitPayApplication(payAppId)` — freezes lines, computes all G702 summary fields:
  - original_contract_sum = contract total at execution;
  - change_order_sum = sum of approved prime COs (workstream 03; until then, read
    approved `change_orders.total_cents` for the project);
  - total_completed_stored = Σ(prev + this + stored);
  - previous_certificates = Σ prior apps' current_payment_due;
  - current_payment_due = total_earned_less_retainage − previous_certificates.
  Generates the invoice (next bullet) and posts SOV rollups
  (`previous_billed_cents += this_period`, `stored_materials_cents` set to new stored
  value, `retainage_held_cents += retainage`). All in one transaction — use an RPC if
  the multi-table update can't be made safe from the service (mirror how
  `run_bid_award_conversion` was done as SQL for atomicity).
- **Invoice generation:** create an `invoices` row via the existing invoice service
  internals (do NOT reimplement numbering/tokens/QBO fields): one invoice line per SOV
  line with activity this period (description = SOV description, amount = this_period +
  stored delta), plus the standard system retainage negative line so the existing
  `retainage` table mirror keeps working (reuse the exact mechanism at
  `invoices.ts:381-443`, passing the pay-app's computed retainage instead of flat
  contract %— refactor that block into a helper accepting an amount). Set
  `invoices.metadata.source_pay_application_id`. QBO sync then works for free.
- `voidPayApplication` (only latest, only if invoice unpaid → voids invoice, reverses
  SOV rollups), `markApproved` (records owner approval date; optional).
- `releaseRetainage(projectId, {amountCents | full})` — creates a release pay app
  (application with a single retainage-release line) → release invoice; updates
  `prime_sov_lines.retainage_released_cents` and `retainage` rows (status released →
  invoiced). Follow the existing release-invoice conventions in `retainage.ts`.

**billing-model.ts:** add `"progress"` to `OwnerBillingBasis`; fixed-price projects
choose draws vs progress at financial setup (`project-financial-setup.ts` — add the
choice; commercial-POSTURE projects default to progress per workstream 01's
`getProjectPosture` — key off the project, not the org, so mixed orgs get the right
default per job).

**Rollout kill-switch:** gate the `progress` option's *visibility* in financial setup
behind a platform-level flag (copy the `ai_search_enabled` per-org flag pattern —
platform admin toggles it at `/platform`), default ON only for the QA org until a
full monthly cycle has been run end-to-end there. This is a visibility gate for
rollout safety, not a capability gate — the service layer works regardless, and the
flag is deleted (per repo leave-no-trash rules) once progress billing is validated
in production. Note the deletion as follow-up in the completion note.

## PDFs

New `lib/services/reports/pay-application-g702.ts` (or extend the reports folder
convention): two documents from one pay app —
- **Application for Payment** (G702-equivalent): header (project, owner, contractor,
  application #, period, contract date), the 9-line summary computation, retainage
  breakdown (completed work vs stored materials), CO summary table (additions/deductions
  from workstream 03 data when available), signature blocks (Contractor;
  Architect's Certificate section with certified-amount blank).
- **Continuation Sheet** (G703-equivalent): the per-line table (Item, Description,
  Scheduled Value, From Previous Application, This Period, Materials Presently Stored,
  Total Completed & Stored, %, Balance to Finish, Retainage). Multi-page with repeated
  header row and page totals + grand total.
Store output via the files service, set `pay_applications.pdf_file_id`. Use pdf-lib
following `pay-application.ts`'s helpers. Money right-aligned tabular; no color.

## UI

Project financials → Receivables area (the billing workbench whose tabs morph by
billing mode — see memory/receivables-billing-workbench):
- New **Schedule of Values** sub-tab (visible when basis = progress): dense editable
  grid (line #, description, cost code, scheduled value, billed-to-date, %, retainage
  held), import-from-budget/estimate buttons, contract-sum reconciliation banner when
  Σ ≠ contract sum. Exemplar for the grid: budget Detailed inline-edit table.
- New **Pay Applications** sub-tab: list (App #, period, status, completed+stored,
  retainage, payment due) → detail sheet/page with the G703-style entry grid
  (type % or $ this period, stored materials column), summary panel computing G702
  fields live, actions: Save draft / Submit & generate invoice / Download PDF / Void.
- Retainage: extend the existing retainage UI on receivables to show held-by-line and
  the Release action for progress projects.
- Empty/loading/error states + dark mode, density matching the financials siblings.

## Permissions, events, validation

- Reuse existing keys where sensible: `invoice.create`/`invoice.approve` for pay-app
  submit; add `sov.write` and `payapp.write` only if the financial permission catalog
  in `team.ts` doesn't already have a natural fit (check `draw.approve` — mirror how
  draws are gated).
- Events: `pay_application.submitted`, `pay_application.invoiced`,
  `retainage.released`. Audit on every mutation.
- Zod schemas in `lib/validation/pay-applications.ts` (+ sov). Cents are ints ≥ 0;
  percent 0–100 with 2dp.

## Phases

1. Migrations + `prime-sov.ts` CRUD + SOV tab with import-from-budget. (Lint clean.)
2. `pay-applications.ts` lifecycle + invoice generation + retainage math +
   `test` coverage: **add unit tests** for the retainage-step and G702 summary math in
   the same style as `invoice-balance.test.ts` (pure functions in
   `lib/financials/pay-app-math.ts` so they're testable without DB).
3. Pay Applications UI (list + entry grid + summary).
4. PDFs.
5. Retainage release flow + stepped retainage settings UI on the contract editor.
6. (Stretch) e-sign the pay app: envelope with source_entity_type `pay_application`
   sent to owner/architect. Only if phases 1–5 are done and clean.

## Acceptance checklist

> Status 2026-07-10: code paths for every item below are implemented; the unchecked
> items are the MANUAL QA runs in the QA org (enable the `progress_billing_enabled`
> flag for it first). The draw regression is the hard merge gate.

- [ ] Fixed-price commercial project set to progress billing: build a 10-line SOV from
      budget, reconcile to contract sum.
- [ ] App #1: bill 3 lines partially + stored materials on 1 line → invoice created
      with correct retainage negative line; QBO sync fields populated like any invoice.
- [ ] App #2: previous columns roll forward correctly; overbilling warning fires when
      prev+this > scheduled.
- [ ] Stepped retainage: line crossing 50% at the configured schedule bills at the
      reduced rate for the this-period amount.
- [ ] Both PDFs render multi-page correctly and total to the app summary.
- [ ] Void app #2 → SOV rollups and retainage reversed.
- [ ] Release retainage → release invoice, `retainage` rows updated, WIP report
      (`wip-over-under.ts`) shows billed-to-date including pay apps (verify it reads
      from invoices — it should pick this up automatically; if it special-cases draws,
      extend it).
- [ ] Draws projects: completely unchanged. **Manual regression required before
      merge** (master rule — this workstream touches the live invoice retainage
      path): on an existing draw-billing project in the QA org, create a draw →
      generate its invoice → verify the retainage negative line, totals, and QBO
      sync fields are byte-identical to pre-change behavior.
- [x] `pnpm lint` + `pnpm test:financials` (including new pay-app-math tests) pass.
