# Workstream 07 — Financial Controls: Budget Transfers, Contingency, Prequalification, Vendor Tax

> Prereq: 00 master, 01. Independent of 02–06. Three unrelated-but-small financial
> control gaps: (A) budget can't move between lines without a CO, (B) prequalification
> is a boolean, (C) vendors have no tax identity (W-9/1099).

## Part A — Budget transfers + contingency

### Context

`budget_revisions.revision_type` defaults `'change_order'` and that's the only kind
posted today; there is no way to move buyout savings into contingency or rebalance
lines. Contingency exists only as `contracts.contingency_cents` and GMP-specific
`gmp_contingency_entries`.

### Read first

- `lib/services/budgets.ts` — revision posting path (find where CO approval posts
  `budget_revisions` + `budget_revision_lines`), lock triggers, rollup aggregation,
  the Simple/Detailed budget tab client.
- `gmp-control.ts` — contingency drawdown mechanics to mirror (not to reuse — GMP is
  its own world).

### Changes

**Migration — `<ts>_budget_transfers.sql`:**

```sql
-- widen revision_type; verify current CHECK/enum mechanism first and extend it:
-- allowed: 'change_order','transfer','adjustment'
create table public.budget_transfers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  project_id uuid not null references public.projects(id),
  transfer_number integer not null,
  reason text not null,
  status text not null default 'draft'
    check (status in ('draft','pending_approval','approved','rejected','void')),
  requested_by uuid,
  approved_by uuid,
  approved_at timestamptz,
  budget_revision_id uuid,       -- set when posted
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, transfer_number)
);

create table public.budget_transfer_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  transfer_id uuid not null references public.budget_transfers(id) on delete cascade,
  budget_line_id uuid not null references public.budget_lines(id),
  amount_cents integer not null   -- signed; sum over transfer must equal 0
);
```

**Service (`budgets.ts` or new `budget-transfers.ts` — new file, budgets.ts is already
1,400 lines):**
- Create/edit draft; validation: Σ amounts = 0, ≥2 lines, no line driven below its
  billed/committed floor (warn vs block: block below actual+committed unless
  `allow_override` with reason).
- Approval: `budget.write` creates, approval requires the approve-level permission
  (mirror how draw/invoice approval keys split; add `budget.approve` to the catalog if
  no fit). Approving posts a `budget_revisions` row (`revision_type: 'transfer'`) with
  matching `budget_revision_lines` — SAME posting helper the CO path uses so all
  rollups/snapshots stay consistent.
- Contingency: no new table — a budget line flagged as contingency:
  `budget_lines.metadata.is_contingency: true` set via UI toggle (and the CSI seed's
  Division 01 "Contingency" code). Budget tab shows a contingency summary strip
  (original, transfers in/out, drawn %, remaining) computed from revision history of
  flagged lines. Transfers to/from contingency are the drawdown mechanism.

**UI:** Budget tab gains a Transfers affordance: transfer log (number, date, reason,
from→to summary, status) + create sheet (pick lines, signed amounts, live zero-sum
check). Approval action inline. Show transfer history on line detail/hover like CO
revisions show today (find how revisions render in the budget tab first).

## Part B — Subcontractor prequalification

### Context

`companies.prequalified` is a manual boolean+timestamp. Commercial GCs need a prequal
package: questionnaire, financials, safety history, bonding, limits, expiration. The
compliance-documents engine (`compliance-documents.ts`, requirements with expirations
and minimums) is the substrate — prequal = structured data + docs + review + expiry.

### Read first

- `lib/services/companies.ts` (prequalified handling ~L83, L508-522),
  `compliance-documents.ts`, `compliance.ts`, `compliance-autopilot.ts`,
  `components/settings/compliance-settings.tsx`.
- Sub portal compliance tab (`app/s/[token]` Compliance) — subs will fill prequal the
  same way they upload COIs.

### Changes

**Migration — `<ts>_prequalification.sql`:**

```sql
create table public.prequalifications (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  company_id uuid not null references public.companies(id),
  status text not null default 'requested'
    check (status in ('requested','submitted','under_review','approved',
                      'approved_with_limits','declined','expired')),
  requested_at timestamptz not null default now(),
  submitted_at timestamptz,
  reviewed_by uuid,
  reviewed_at timestamptz,
  expires_at date,
  single_project_limit_cents bigint,
  aggregate_limit_cents bigint,
  emr numeric,                        -- experience modification rate
  bonding_single_cents bigint,
  bonding_aggregate_cents bigint,
  years_in_business integer,
  annual_revenue_cents bigint,
  largest_project_cents bigint,
  trades text[],                       -- CSI divisions they claim
  references_data jsonb not null default '[]'::jsonb,
  questionnaire jsonb not null default '{}'::jsonb,  -- flexible Q&A payload
  review_notes text,
  portal_token_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

Keep `companies.prequalified/prequalified_at` as the denormalized read (service
maintains them from the latest prequal's status: approved* and unexpired → true).

**Service `lib/services/prequalification.ts`:**
- `requestPrequalification(companyId)` → row + sub-portal link (extend the sub portal
  with a Prequal section: form for the structured fields + questionnaire + required
  doc uploads reusing compliance-documents requirements tagged `prequal`).
- Submit (from portal) → under_review + notify requester.
- Review: approve / approve-with-limits (sets limit fields) / decline; sets
  expires_at (default +1 year, org-configurable).
- Expiry: extend `compliance-autopilot.ts`'s existing sweep (it already handles doc
  expirations) to flip expired prequals and notify.
- **Enforcement hooks (soft):** bid invite creation and commitment approval check
  prequal status + limits (commitment total vs single_project_limit) and surface a
  WARNING (not a block) with an override note — commercial GCs want visibility first;
  blocking is an org setting (`compliance_rules` jsonb gains
  `block_commitment_on_prequal: bool`, default false; follow how
  `block_payment_on_missing_docs` is enforced in `vendor-bills.ts` ~L699 for the
  pattern).

**UI:** Company detail page (`components/companies/company-detail-page.tsx`) gains a
Prequalification card (status, limits, EMR, expiry, request/review actions). Directory
list: prequal status column + filter. Trades: while here, migrate the freeform
`metadata.trade` display to also show `prequalifications.trades` CSI divisions when
present (full trade-taxonomy overhaul is out of scope; the prequal `trades[]` starts
the structured data).

## Part C — Vendor tax identity (W-9 / 1099)

### Context

No tax_id/W-9/1099 anywhere. Year-end 1099 prep is a bookkeeper job Arc should feed
even if filing happens elsewhere (QBO handles filing; Arc must hold the data and the
W-9 doc).

### Changes

**Migration — `<ts>_vendor_tax.sql`:**

```sql
alter table public.companies
  add column if not exists tax_id_last4 text,          -- display only; never full TIN
  add column if not exists tax_id_encrypted text,      -- if full storage needed, use pgsodium/vault; else omit
  add column if not exists tax_entity_type text
    check (tax_entity_type in ('individual','sole_prop','partnership',
                               'c_corp','s_corp','llc','exempt')),
  add column if not exists is_1099_eligible boolean,
  add column if not exists w9_file_id uuid,
  add column if not exists w9_received_at timestamptz;
```

**Decision point for the executor:** storing full TINs requires encryption at rest
beyond RLS. Default plan: store ONLY last4 + the W-9 document file (the doc holds the
full number; file access is already audited via `file_access_events`). Skip
`tax_id_encrypted` unless the human asks for full-TIN storage. Note this in the
completion report.

- Compliance requirement: add "W-9" to the default requirement seeds
  (`getDefaultComplianceRequirements`) for commercial-tier orgs; sub portal compliance
  upload already handles doc collection — map the W-9 doc type to `w9_file_id` +
  `w9_received_at` on receipt.
- `is_1099_eligible` derivation suggestion in UI (eligible when entity type not in
  c_corp/s_corp/exempt) — suggestion only, bookkeeper confirms.
- **1099 summary report:** `lib/services/reports/vendor-1099.ts` — calendar-year cash
  payments per 1099-eligible vendor (from `payments`/`payment_allocations` on bills +
  paid expenses; CASH basis — payment date, not bill date), columns: vendor, TIN
  last4, entity type, W-9 on file, total paid, flag ≥ $600. CSV export via `csv.ts`.
  Surface under the org Reports area beside AP aging.
- QBO: vendors sync already exists (`qbo_vendor_id`); do NOT push tax data to QBO in
  this workstream (QBO vendor tax fields are finicky) — report-only.

## Permissions / events

- `budget.approve` (transfers), `prequal.review`, and vendor-tax editing rides
  existing company-edit permission.
- Events: `budget_transfer.approved`, `prequalification.approved/declined/expired`,
  `company.w9_received`.

## Phases

1. Budget transfers + contingency strip (finish with unit tests on the zero-sum +
   floor validation math).
2. Vendor tax fields + W-9 requirement + 1099 report (small, ship fast).
3. Prequalification (schema → service → portal form → review UI → autopilot expiry →
   soft enforcement hooks).

## Acceptance checklist

- [ ] Transfer $10k from "09 29 00 Gypsum" to Contingency: zero-sum enforced, approval
      required, budget rollup + snapshots reflect it, EAC unchanged, contingency strip
      shows the inflow; transfer below committed floor is blocked without override.
- [ ] `pnpm test:financials` covers transfer validation math.
- [ ] Prequal: request → sub fills form + uploads docs via portal → review →
      approve-with-limits ($2M single) → commitment for $3M shows the warning →
      expiry sweep flips status after expires_at.
- [ ] W-9 uploaded via sub portal lands on the company; 1099 report shows the vendor
      with correct cash-basis total and CSV-exports.
- [ ] `pnpm lint` clean.
