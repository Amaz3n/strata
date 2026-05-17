# Residential Financial System — "Worth Switching To" Gameplan

**Audience:** Custom-home builders, major remodelers, and design-build studios. Buildertrend / JobTread territory. Not commercial GCs (no AIA G702/G703 priority in this plan).

**Thesis:** The single highest-leverage move is making **cost-plus and T&M billing genuinely excellent**. Most "modern" construction tools half-ass it. Buildertrend dominates residential because its owner-invoice flow works. Beat that loop and the rest of the system can be merely good.

**Out of scope (this plan):** AIA G702/G703 pay applications, surety/bonding, prevailing wage, certified payroll, multi-currency. Listed at the end as future phases.

**Companion docs (read first):**
- `docs/financials-gameplan.md` — overall money loop and primitives already in place
- `docs/financial-features-gameplan.md` — Phase 1 ACH-first payments (in progress)
- `docs/combined-financials-mvp-plan.md` — combined MVP scope
- `docs/qbo-integration-gameplan.md` — QBO sync state

---

## 0) Conventions for the Implementing Agent

These are non-negotiable. Every new table, service, and action follows them.

### 0.1 File layout

```
supabase/migrations/<TIMESTAMP>_<feature>.sql        # one migration per feature
lib/services/<module>.ts                              # service layer (business logic)
lib/validation/<module>.ts                            # zod schemas (or co-located in service)
app/(app)/<route>/actions.ts                          # server actions (thin wrappers)
app/(app)/<route>/page.tsx                            # server component
components/<domain>/<component>.tsx                   # UI
lib/types.ts                                          # shared types (extend existing types)
```

### 0.2 Service signature template

```typescript
// lib/services/<module>.ts
import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { requirePermission } from "@/lib/services/permissions"

export async function createX(input: XInput, orgId?: string) {
  const parsed = xInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("project.manage", { supabase, orgId: resolvedOrgId, userId })

  // ... mutation, scoped by org_id

  await recordAudit({ orgId: resolvedOrgId, action: "insert", entityType: "x", entityId: data.id, after: data })
  await recordEvent({ orgId: resolvedOrgId, eventType: "x_created", entityType: "x", entityId: data.id, payload: {} })
  return mapX(data)
}
```

### 0.3 SQL conventions for every new table

```sql
create table if not exists <name> (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  -- domain columns
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists <name>_org_idx on <name>(org_id);
alter table <name> enable row level security;
create policy "<name>_access" on <name> for all using (auth.role() = 'service_role' or is_org_member(org_id));
create trigger <name>_set_updated_at before update on <name>
  for each row execute function public.tg_set_updated_at();
```

### 0.4 Money & data rules

- All money columns end in `_cents` and are `integer not null check (>= 0)` unless a negative is meaningful (variance, savings).
- Status columns are `text not null check (status in ('a','b','c'))`.
- All client-portal access is **token-based**, never user-based. Tokens hashed and time-bounded.
- All mutating server actions accept an idempotency key (header `x-idempotency-key` or `formData.get("idempotency_key")`) and the service layer dedupes via `idempotency_keys` table.
- Money never modifies a billed row in place. "Adjustments" are new rows that net.

### 0.5 LLM execution discipline

When implementing a phase:
1. Read the **Existing State** subsection first to avoid re-creating columns/tables.
2. Generate a migration file and apply it via Supabase MCP or the Supabase SQL editor. Do not assume `supabase push` is part of this workflow; local CLI diffing is optional only when the project is already configured for it.
3. Land schema, services, and tests **before** UI.
4. Each phase ends with a **Demo Script** that must pass end-to-end before marking the phase done.
5. Do not skip the audit/event calls. Activity feed and audit trail are product features, not nice-to-haves.

---

## 1) North Star UX (the demo a builder must see)

A custom-home builder, on a cost-plus contract, on a Friday afternoon:

1. Foreman opens phone, snaps three lumberyard receipts → routes to cost code 06-1000 (Rough Carpentry), tags one as non-billable (truck repair).
2. Foreman files a daily T&M ticket: 4 workers × 8 hrs each on cost code 09-2000, attaches a job-site photo, taps "Send to client for sign-off."
3. Client gets SMS, taps link, sees ticket + photo + hours, taps "Approve."
4. Approved sub bill from electrician ($12,300 against commitment) flows automatically into the billable cost ledger.
5. Builder clicks **Generate Invoice from Costs (last 14 days)** on the project Financials page. Preview shows costs grouped by cost code with markup applied per the contract's rules. Excludes truck repair. Includes an allowance overage line ($800 over the tile allowance).
6. Builder hits Send. Client receives invoice in portal. Client can tap any line and drill into the receipts/bills/tickets behind it.
7. GMP burn gauge on the Overview tab moves from 64% → 71%, projecting final at 4% under cap. Builder's share of savings shows live.
8. Client pays via ACH (one-tap). Conditional lien waiver for the electrician auto-generates. On payment clear, it flips to unconditional. QBO sync pushes the invoice and payment.

**If a builder can do that loop in under 10 minutes, they switch.** Everything in this plan exists to deliver that loop.

---

## 2) Existing State (so we don't re-do it)

Verified via repo grep on 2026-05-07. Already in repo:

| Capability | Where |
|---|---|
| `contracts.contract_type` enum w/ `cost_plus`, `time_materials` | `migrations/20251208004852_..._proposals_contracts.sql:59` |
| `contracts.markup_percent` column | same migration `:60` |
| Markup math at estimate/proposal/CO layers | `lib/services/{estimates,proposals,change-orders}.ts` |
| Budgets, cost codes, commitments, vendor bills, invoices | `migrations/20251130172153_financials_comm_custom.sql` |
| Allowances table | `migrations/20251208004852_...` |
| Stripe payments + payment links + reminders + late fees | `migrations/20251207221755_phase1_payments_scaffold_retry.sql` |
| QBO one-way push (invoice/bill/payment) | `lib/services/qbo-sync.ts` |
| Sub portal w/ commitment-aware bill submission | `app/s/[token]/submit-invoice/` |
| `receipts` table | `migrations/20251130172153_...` (Stripe-style payment receipts only — **NOT** expense receipts) |

Critical gaps identified (and addressed below):

1. **`contract_type` is cosmetic.** No service branches on it.
2. **`contracts.markup_percent` is stored but never read** by invoice generation.
3. **No T&M ticket entity, no time entries, no expense capture.**
4. **No "invoice from costs" generator.**
5. **No GMP fields, no savings split, no GMP burn UI.**
6. **No reimbursable / non-reimbursable classification on cost codes.**
7. **No client open-book drill-down.**
8. **No labor burden multiplier.**
9. **No CTC / EAC / job-cost forecast.**
10. **No project P&L / WIP report.**
11. **No portfolio dashboard; `/invoices` and `/payments` top-level are placeholders.**
12. **No COI/W-9/license vault on subs; no 1099 export.**
13. **No CO → budget revision distribution.**
14. **Retainage is event-row, not invoice-line.**
15. **QBO is one-way only.**

---

## 3) Phases at a Glance

**Strategic focus:** Arc should win first on the cost-plus money loop, not on breadth. Phases 1 and 2 are the "worth switching to" core: capture costs, prove what is billable, generate transparent invoices, and forecast where the job will finish. Phases 3 and 4 come after that core is trustworthy. Phase 5 is conditional and should be scoped only to integration work that removes real duplicate entry. Phase 6 is not a native mobile app track for now; keep capture flows PWA/mobile-web first.

| Phase | Theme | Effort | Strategic value |
|---|---|---|---|
| **1** | Cost-plus & T&M core (the centerpiece) | XL | Existential — this is the product |
| **2** | Job-cost depth: CTC, EAC, P&L, WIP | L | Makes Arc financially credible to owners/controllers |
| **3** | Portfolio & owner dashboards | M | The owner's morning view, after project-level math is trusted |
| **4** | Compliance & trust (COI/W-9/license, CO→budget, selected retainage work) | M/L | Removes operational objections after core financials work |
| **5** | QBO + bank feed, ROI-gated | M/L | Do only if it measurably kills duplicate entry |
| **6** | PWA capture polish, not native mobile | S/M | Improve adoption without starting a mobile-app program |
| **Later** | Commercial (AIA, certified payroll, prevailing wage) | XL | Out of scope for now |

Each phase below lists: **Schema → Services → Actions/Routes → UI → Acceptance → Telemetry → Risks**.

---

## 4) Phase 1 — Cost-Plus & T&M Core

This phase is the centerpiece. Do not skip steps; do not collapse the data model.

### 4.1 Mental model

Three **cost source streams** feed one **billable cost ledger** which produces **invoices**:

```
                      ┌──────────────────────┐
  vendor_bills ──────▶│                      │
  expenses     ──────▶│  billable_costs      │──▶ invoice generator ──▶ invoices
  time_entries ──────▶│  (unified ledger)    │
                      └──────────────────────┘
                              ▲
                              │
                       markup_rules + cost_code reimbursable flag
```

The ledger is the system of record for "what does the client owe us, and is it billable yet?"

### 4.2 Schema

**Migration:** `supabase/migrations/<TIMESTAMP>_costplus_core.sql`

#### 4.2.1 Cost code classification (extend existing)

```sql
alter table cost_codes add column if not exists is_reimbursable_default boolean not null default true;
alter table cost_codes add column if not exists default_markup_percent numeric;

create index if not exists cost_codes_category_idx on cost_codes (category);
```

**Why:**
- `is_reimbursable_default=false` → never appears on cost-plus invoice unless overridden per-line. Used for things like rework, builder overhead, internal transfers.
- The existing `category` field enables labor/material/sub/equipment reporting eventually, but do **not** add a strict check yet; current data already uses builder-specific category values.
- `default_markup_percent` overrides the contract default for that cost code (e.g., 0% on permits, 20% on labor, 10% on materials).

#### 4.2.2 Time entries

```sql
create table if not exists time_entries (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  cost_code_id uuid references cost_codes(id) on delete set null,
  worker_user_id uuid references app_users(id) on delete set null,    -- internal worker
  worker_company_id uuid references companies(id) on delete set null, -- 1099 sub
  worker_name text not null,                                          -- denormalized for history
  work_date date not null,
  hours numeric(6,2) not null check (hours > 0 and hours <= 24),
  base_rate_cents integer not null check (base_rate_cents >= 0),
  burden_multiplier numeric not null default 1.0 check (burden_multiplier >= 1.0),
  cost_cents integer generated always as (round(hours * base_rate_cents * burden_multiplier)::int) stored,
  is_billable boolean not null default true,
  is_overtime boolean not null default false,
  notes text,
  attached_file_ids uuid[] not null default '{}',                     -- photos, signed timesheets
  approved_by_pm_at timestamptz,
  approved_by_pm_user_id uuid references app_users(id),
  approved_by_client_at timestamptz,
  approval_token_hash text,                                            -- for client one-tap sign-off
  status text not null default 'draft' check (status in ('draft','submitted','pm_approved','client_approved','rejected','locked')),
  rejection_reason text,
  billable_cost_id uuid,        -- back-pointer set when invoiced (FK added after billable_costs)
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists time_entries_org_idx on time_entries (org_id);
create index if not exists time_entries_project_idx on time_entries (project_id);
create index if not exists time_entries_status_idx on time_entries (status);
create index if not exists time_entries_work_date_idx on time_entries (work_date);
alter table time_entries enable row level security;
create policy "time_entries_access" on time_entries for all using (auth.role() = 'service_role' or is_org_member(org_id));
create trigger time_entries_set_updated_at before update on time_entries
  for each row execute function public.tg_set_updated_at();
```

**Notes:**
- `worker_name` denormalized so that historical entries don't break if a user is deleted.
- `cost_cents` is generated; never set directly.
- `approval_token_hash` lets a client approve via SMS/email without auth (mirrors lien-waiver pattern).

#### 4.2.3 Project expenses (receipts)

We **cannot** reuse the existing `receipts` table — it's tied to Stripe `payments`. New table:

```sql
create table if not exists project_expenses (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  cost_code_id uuid references cost_codes(id) on delete set null,
  vendor_company_id uuid references companies(id) on delete set null,
  vendor_name_text text,                       -- if not in Companies (e.g., one-off lumberyard)
  expense_date date not null,
  description text,
  amount_cents integer not null check (amount_cents >= 0),
  tax_cents integer not null default 0 check (tax_cents >= 0),
  payment_method text check (payment_method in ('cash','credit_card','check','ach','company_card','reimbursable_personal','other')),
  receipt_file_id uuid references files(id) on delete set null,
  is_billable boolean not null default true,
  markup_percent_override numeric,             -- nullable; null = use rule chain
  submitted_by_user_id uuid references app_users(id),
  approved_by_pm_at timestamptz,
  approved_by_pm_user_id uuid references app_users(id),
  status text not null default 'draft' check (status in ('draft','submitted','approved','rejected','locked')),
  rejection_reason text,
  billable_cost_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists project_expenses_org_idx on project_expenses (org_id);
create index if not exists project_expenses_project_idx on project_expenses (project_id);
create index if not exists project_expenses_status_idx on project_expenses (status);
create index if not exists project_expenses_date_idx on project_expenses (expense_date);
alter table project_expenses enable row level security;
create policy "project_expenses_access" on project_expenses for all using (auth.role() = 'service_role' or is_org_member(org_id));
create trigger project_expenses_set_updated_at before update on project_expenses
  for each row execute function public.tg_set_updated_at();
```

#### 4.2.4 Markup rules

Hierarchical resolution: **line override → cost code default → contract default → org default → 0**.

```sql
create table if not exists markup_rules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  scope text not null check (scope in ('org','contract','cost_code')),
  contract_id uuid references contracts(id) on delete cascade,
  cost_code_id uuid references cost_codes(id) on delete cascade,
  markup_percent numeric not null check (markup_percent >= 0 and markup_percent <= 200),
  applies_to_category text, -- keep flexible until cost-code categories are normalized
  effective_from date,
  effective_to date,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Exactly one scope target
  constraint markup_rules_scope_target check (
    (scope = 'org'        and contract_id is null and cost_code_id is null) or
    (scope = 'contract'   and contract_id is not null and cost_code_id is null) or
    (scope = 'cost_code'  and cost_code_id is not null)
  )
);
create index if not exists markup_rules_org_idx on markup_rules (org_id);
create index if not exists markup_rules_contract_idx on markup_rules (contract_id);
create index if not exists markup_rules_cost_code_idx on markup_rules (cost_code_id);
alter table markup_rules enable row level security;
create policy "markup_rules_access" on markup_rules for all using (auth.role() = 'service_role' or is_org_member(org_id));
create trigger markup_rules_set_updated_at before update on markup_rules
  for each row execute function public.tg_set_updated_at();
```

#### 4.2.5 Billable cost ledger (the spine)

```sql
create table if not exists billable_costs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  cost_code_id uuid references cost_codes(id) on delete set null,
  source_type text not null check (source_type in ('vendor_bill_line','project_expense','time_entry','manual_adjustment','allowance_overage')),
  source_id uuid not null,
  source_company_id uuid references companies(id) on delete set null,
  occurred_on date not null,
  description text,
  cost_cents integer not null,                   -- can be negative for credits/adjustments
  markup_percent_resolved numeric not null,      -- snapshotted at billing time
  markup_cents integer not null,
  billable_cents integer generated always as (cost_cents + markup_cents) stored,
  is_billable boolean not null default true,
  invoice_id uuid references invoices(id) on delete set null,
  invoice_line_id uuid,                          -- FK added after invoice_lines pin
  billed_at timestamptz,
  status text not null default 'open' check (status in ('open','locked','billed','excluded','voided')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists billable_costs_org_idx on billable_costs (org_id);
create index if not exists billable_costs_project_idx on billable_costs (project_id);
create index if not exists billable_costs_status_idx on billable_costs (status);
create index if not exists billable_costs_invoice_idx on billable_costs (invoice_id);
create index if not exists billable_costs_source_idx on billable_costs (source_type, source_id);
create unique index if not exists billable_costs_source_uq on billable_costs (source_type, source_id) where status != 'voided';
alter table billable_costs enable row level security;
create policy "billable_costs_access" on billable_costs for all using (auth.role() = 'service_role' or is_org_member(org_id));
create trigger billable_costs_set_updated_at before update on billable_costs
  for each row execute function public.tg_set_updated_at();
```

**Status semantics:**
- `open` — eligible to be invoiced
- `locked` — picked up in a draft invoice; cannot be edited or double-claimed
- `billed` — invoice sent
- `excluded` — explicitly marked non-billable on this project
- `voided` — source deleted or reversed

**Source uniqueness:** `(source_type, source_id)` is unique except where `status='voided'`. Prevents double-creation when a sub bill is approved twice.

#### 4.2.6 GMP fields on contracts

```sql
alter table contracts add column if not exists gmp_cents integer;
alter table contracts add column if not exists savings_split_owner_pct numeric default 0 check (savings_split_owner_pct between 0 and 100);
alter table contracts add column if not exists savings_split_builder_pct numeric default 0 check (savings_split_builder_pct between 0 and 100);
alter table contracts add column if not exists labor_burden_multiplier numeric default 1.0 check (labor_burden_multiplier >= 1.0);
alter table contracts add column if not exists requires_client_cost_approval boolean not null default false;
alter table contracts add column if not exists open_book boolean not null default true;

-- Sanity: split percentages should sum ≤ 100 (anything missing flows to whichever side per contract)
alter table contracts add constraint if not exists contracts_savings_split_total_chk
  check (coalesce(savings_split_owner_pct,0) + coalesce(savings_split_builder_pct,0) <= 100);
```

#### 4.2.7 Late-binding FKs

```sql
alter table time_entries
  add constraint time_entries_billable_cost_fk
  foreign key (billable_cost_id) references billable_costs(id) on delete set null;

alter table project_expenses
  add constraint project_expenses_billable_cost_fk
  foreign key (billable_cost_id) references billable_costs(id) on delete set null;

alter table billable_costs
  add constraint billable_costs_invoice_line_fk
  foreign key (invoice_line_id) references invoice_lines(id) on delete set null;
```

#### 4.2.8 Triggers — auto-create billable_costs from sources

When a `vendor_bills` row transitions to `approved` and the project's contract is `cost_plus` or `time_materials`, create one `billable_costs` row per `bill_line`. Mirror for `project_expenses` (on `approved`) and `time_entries` (on `client_approved` if `requires_client_cost_approval` else on `pm_approved`).

Implement these as **service-layer side effects**, not SQL triggers, to keep idempotency, audit, and event recording centralized. See `propagateApprovalToLedger` below.

### 4.3 Services

Create `lib/services/cost-plus.ts` (and supporting modules). Public exports:

```typescript
// lib/services/cost-plus.ts

// Markup resolution (pure function, well-tested)
export async function resolveMarkupPercent(args: {
  supabase: SupabaseClient
  orgId: string
  contractId: string | null
  costCodeId: string | null
  costCodeCategory?: string | null
  occurredOn: Date
  lineOverride?: number | null
}): Promise<{ percent: number; source: 'line'|'cost_code'|'contract'|'org'|'default' }>

// Ledger writers (idempotent on (source_type, source_id))
export async function upsertBillableCostFromBillLine(args: {
  billLineId: string
  orgId?: string
}): Promise<BillableCost>

export async function upsertBillableCostFromExpense(args: {
  expenseId: string
  orgId?: string
}): Promise<BillableCost>

export async function upsertBillableCostFromTimeEntry(args: {
  timeEntryId: string
  orgId?: string
}): Promise<BillableCost>

// Approval propagation: called from existing approve/reject services as a hook.
export async function propagateApprovalToLedger(args: {
  source: 'vendor_bill' | 'project_expense' | 'time_entry'
  sourceId: string
  orgId?: string
}): Promise<void>

// Invoice generator (the centerpiece)
export interface GenerateInvoiceFromCostsInput {
  projectId: string
  dateRange: { from: Date; to: Date }
  costCodeIds?: string[]
  groupBy: 'cost_code' | 'detail'
  includeAllowanceVariances?: boolean
  dryRun?: boolean
}

export interface GenerateInvoiceFromCostsResult {
  invoiceId?: string                 // null if dryRun
  invoicePreview: InvoiceDraft
  costCount: number
  totalCostCents: number
  totalMarkupCents: number
  totalBillableCents: number
  excludedCount: number
  warnings: Array<{ code: string; message: string; billableCostId?: string }>
}

export async function generateInvoiceFromCosts(
  input: GenerateInvoiceFromCostsInput,
  orgId?: string,
): Promise<GenerateInvoiceFromCostsResult>

// GMP gauge
export interface GMPSnapshot {
  contractId: string
  gmpCents: number
  costToDateCents: number
  committedCents: number
  forecastFinalCostCents: number
  burnPercent: number
  projectedSavingsCents: number       // gmp - forecastFinal (can be negative = overrun)
  ownerSharePct: number
  builderSharePct: number
  ownerSavingsCents: number
  builderSavingsCents: number
}
export async function getGMPSnapshot(projectId: string, orgId?: string): Promise<GMPSnapshot | null>
```

**Implementation guardrails for `generateInvoiceFromCosts`:**

1. Open a transaction (or use SERIALIZABLE-equivalent via service-role + pessimistic flow).
2. Select all `billable_costs` where `project_id = ? and status = 'open' and is_billable = true and occurred_on between ? and ?`.
3. For each row, recompute `markup_percent_resolved` via `resolveMarkupPercent` (the stored value is a snapshot — recompute on bill).
4. **Lock** them: `update billable_costs set status='locked' where id = any($1)`.
5. Group per `groupBy` mode.
6. Build `invoices` + `invoice_lines` rows. Invoice number from existing sequencer.
7. Set `billable_costs.invoice_id`, `billable_costs.invoice_line_id`, `billable_costs.status='billed'`, `billable_costs.billed_at = now()`.
8. Emit `invoice_generated_from_costs` event with payload of cost IDs (for activity feed and audit).
9. If `dryRun`, perform steps 2–6 but rollback at the end.

**Idempotency:** require an idempotency key in the input; cache `(orgId, idempotencyKey) → invoiceId` so re-submission returns the same invoice.

**Concurrency:** the unique partial index on `billable_costs (source_type, source_id) where status != 'voided'` prevents double-source. The `status='locked'` write under a row-level lock prevents two concurrent invoice generations from claiming the same costs.

### 4.4 Service hook points (existing services to modify)

| Existing service | Modification |
|---|---|
| `lib/services/vendor-bills.ts::approveVendorBill` | After approve, call `propagateApprovalToLedger({ source: 'vendor_bill', sourceId })` if project contract is cost_plus / T&M |
| `lib/services/vendor-bills.ts::voidVendorBill` | Mark associated `billable_costs` rows `status='voided'` (only if `status='open'`; if `billed`, create a manual_adjustment credit row instead) |
| `lib/services/invoices.ts::createInvoice` | New optional `source: 'manual' \| 'from_costs'` field; default `manual` |
| `lib/services/contracts.ts` | Validate that markup-related fields are only settable when `contract_type in ('cost_plus','time_materials')` |
| `lib/services/cost-codes.ts` | Surface category, default_markup_percent, is_reimbursable_default in CRUD |

### 4.5 Server actions & routes

```
app/(app)/projects/[id]/financials/cost-plus/
  ├─ actions.ts                        # generateInvoiceFromCostsAction, etc.
  └─ page.tsx                          # OR: integrate as a sub-tab inside FinancialsTabs

app/(app)/projects/[id]/cost-inbox/
  ├─ actions.ts                        # approve pending time, expenses, coded vendor bills
  └─ page.tsx                          # PM review queue for costs before they become billable

app/(app)/projects/[id]/time/
  ├─ actions.ts                        # createTimeEntryAction, approveTimeEntryAction
  └─ page.tsx                          # PM time-entry review

app/(app)/projects/[id]/expenses/
  ├─ actions.ts
  └─ page.tsx

app/api/time-entries/approve/[token]/route.ts   # client one-tap approval (no auth)

app/(app)/settings/markup-rules/        # later hardening; defaults work in Phase 1
  ├─ actions.ts
  └─ page.tsx
```

**Sub-portal additions** (`app/s/[token]/`):
- New route: `app/s/[token]/time/` — sub-foreman files time entries against their commitment.
- New route: `app/s/[token]/expenses/` — sub uploads receipts (e.g., reimbursable rentals).

**Client-portal additions** (`app/p/[token]/`):
- New route: `app/p/[token]/cost-detail/[invoiceId]/` — open-book drilldown into the costs behind an invoice line. Gated on `contracts.open_book = true`.
- New route: `app/p/[token]/approvals/[token]/` — client one-tap approval of T&M tickets and weekly cost batches.

### 4.6 UI

#### 4.6.1 Project Financials → new "Cost Plus" tab

If `contract.contract_type in ('cost_plus','time_materials')`, the existing `FinancialsTabs` (`components/financials/financials-tabs.tsx`) gains a fifth tab: **Cost Plus**.

This tab contains:
1. **GMP gauge** (if `gmp_cents` set) — radial progress with: cost-to-date / forecast-final / GMP / projected savings split.
2. **Pending billable** — table of `billable_costs status='open'`, grouped by date range or cost code, with a "Generate invoice from selected" CTA.
3. **Time entries** — list with PM-approval bulk action.
4. **Expenses** — list with PM-approval bulk action.
5. **Allowances** — current allowance table + variance.
6. **Reimbursable settings shortcut** — quick edit of cost-code reimbursable flags for this project.

#### 4.6.1a Current Phase 1 implementation status (May 8, 2026)

Implemented:
- Project create/edit and project settings can mark a project contract as `cost_plus` or `time_materials`.
- Money sidebar exposes **Review Queue**, **Time**, and **Expenses** so the workflows are reachable.
- **Review Queue** gives PMs one action surface for submitted time, submitted/draft expenses, and pending vendor bills.
- Pending vendor bills can be approved from Review Queue only after they have bill-line coding; uncoded bills link back to Payables because approval without cost codes would not create useful ledger rows.
- Approved time entries, approved expenses, and approved coded vendor bill lines flow into `billable_costs`.
- Cost Plus tab shows ready-to-invoice ledger rows, GMP burn, date-window selection, grouping, preview, and invoice generation.
- Sub portal dashboard links directly to Invoice, Time, and Expense submission paths.
- Client portal invoice view supports open-book billable-cost detail for cost-plus invoices.
- Internal and sub portal expense forms accept receipt/photo uploads.
- Internal and sub portal time forms accept up to five crew lines per ticket plus a shared photo/signed-ticket attachment.
- Time review has a client approval-link copy action after PM approval.
- Settings has a Markup Rules page for org, contract, and cost-code defaults.

Still not operationally excellent:
- Receipt/photo upload is functional, but it is not yet camera-first with preview/thumbnails.
- Time entry supports five crew rows, but it still needs saved crews and reusable labor rates.
- Client approval links can be copied, but SMS/email delivery is not automated yet.
- Allowance overages can be included in invoice generation and are written to the billable-cost ledger as `allowance_overage` rows.
- The full demo script still needs to be run against pilot data.

#### 4.6.2 Generate Invoice modal

```
┌─ Generate Invoice from Costs ──────────────────────────────┐
│ Date range:  [Apr 23 → May 6]                              │
│ Cost codes:  [All] [Filter…]                               │
│ Group by:    (•) Cost Code   ( ) Detail (line per cost)    │
│ Include allowance overages: [✓]                            │
│                                                            │
│ ──────────────────────────────────────────────────         │
│ Preview (dry run)                                          │
│   06-1000 Rough Carpentry      $12,400 +15%   $14,260      │
│   09-2000 Drywall              $ 8,200 +15%   $ 9,430      │
│   16-0000 Electrical (sub)     $12,300 +10%   $13,530      │
│   Allowances - Tile overage    $   800 +15%   $   920      │
│   Excluded: 1 non-billable expense ($420 truck repair)     │
│ ──────────────────────────────────────────────────         │
│ Costs:    $33,700                                          │
│ Markup:   $ 4,440                                          │
│ Total:    $38,140                                          │
│                                                            │
│        [Cancel]   [Send to client for approval]   [Send]   │
└────────────────────────────────────────────────────────────┘
```

The "Send to client for approval" path (only if `contracts.requires_client_cost_approval`) creates a `cost_approval_batches` row (light table, optional in v1) and SMSes the client a tokenized URL. Approval moves all rows from `locked` → `client_approved`, then the invoice is generated.

#### 4.6.3 Mobile foreman flows

Build as PWA-friendly, mobile-web routes. Native mobile is not part of this plan:

- **Snap receipt:** camera → upload → vendor → cost code → amount → billable toggle → submit. Should take ≤15 seconds.
- **Daily T&M ticket:** project → date → workers + hours per cost code → photo → optional "send to client for sign-off."
- **Approval inbox:** PM gets push notification "12 receipts and 3 T&M tickets pending."

#### 4.6.4 Client-portal open-book

On the existing invoice view, when `contracts.open_book = true`:
- Each invoice line is expandable.
- Expansion shows the underlying `billable_costs` rows: date, vendor, description, cost, markup %, photo thumbnail, link to receipt PDF.
- Adds trust without leaking sub margins (we never expose commitment vs. bill spread).

### 4.7 Validation rules

- Cost-plus invoice cannot include any `billable_costs` row whose `cost_code.is_reimbursable_default = false` unless `expense.is_billable` was explicitly set true on that row.
- Cannot generate an invoice over a date range whose end is in the future.
- A T&M ticket whose `requires_client_cost_approval` contract requires client approval cannot enter the ledger until `status='client_approved'`.
- Markup rule scoped to `cost_code` requires the cost code's category to match `applies_to_category` if set.
- Voiding a vendor bill that has `billable_costs` already in `billed` status creates a `manual_adjustment` credit row, not an in-place void.

### 4.8 Telemetry

Emit events:
- `cost_ledger_row_created` (source_type, cost_cents, project_id)
- `time_entry_submitted`, `time_entry_pm_approved`, `time_entry_client_approved`
- `expense_submitted`, `expense_approved`
- `invoice_generated_from_costs` (cost_count, total_cents, group_by)
- `gmp_overrun_warning` (when `forecast_final > gmp`)

Metrics dashboard (Phase 3 implements UI):
- Median time from cost-occurrence to invoice generation
- % of cost-plus invoices generated automatically vs. manually
- % of T&M tickets client-approved within 48h

### 4.9 Acceptance / Demo Script

Land Phase 1 only when this entire script passes on a clean test org:

1. Create a project with a `cost_plus` contract: 15% markup, 10% on subcontracts, GMP $500k.
2. Seed cost codes with categories.
3. Foreman submits 5 time entries totaling 28 hrs across 3 cost codes; PM approves; client approves via tokenized link.
4. Foreman uploads 4 expenses; PM approves 3, rejects 1.
5. Approve a $12,300 sub bill against an existing commitment.
6. Open Cost Plus tab — verify ledger shows the expected `billable_costs` rows with correct markups resolved.
7. Click **Generate Invoice from Costs**, dry-run; preview matches expected math (verified against a hand-computed expected.json fixture).
8. Confirm; invoice is created; ledger rows flip to `billed`; `billable_costs.invoice_line_id` populated.
9. Open client portal; client drills into invoice line; sees receipts/photos/hours.
10. Client pays via ACH; payment posts; QBO push job runs; QBO invoice + payment created.
11. GMP gauge updates from 64% → 71%.
12. Void the sub bill (simulating an error); verify a credit `manual_adjustment` row is created (not an in-place delete) since it was already billed.
13. Run job-cost forecast (Phase 2 stub) — sanity-check actuals match ledger.

### 4.10 Risks / known traps

| Risk | Mitigation |
|---|---|
| Double-billing a cost (race between two invoice generations) | Unique `(source_type, source_id)` partial index + lock-during-generate |
| Markup snapshot drift (rule changes after bill, re-bill picks new rule) | Snapshot `markup_percent_resolved` on the ledger row at billing time, not at ledger insertion |
| Voiding a bill that's already billed | Treat as adjustment row, never delete or mutate billed history |
| Burdened-rate confusion (gross vs. burdened) | Always store base + multiplier separately; compute cost via generated column |
| Sub portal exposes one sub's costs to another | Token scoping is per company; ledger queries always filter by company on sub portal |
| Client sees vendor bill subtotals (margin leak) | Open-book drill shows cost as paid by builder, not commitment-vs-bill; never expose commitment lines |
| QBO sync of cost-plus invoices double-counts cost | Cost-plus invoices push as a single revenue line per cost code; do not push the underlying expenses to QBO from Arc (QBO ingests expenses via its own AP flow) |

---

## 5) Phase 2 — Job-Cost Depth: CTC, EAC, P&L, WIP

The controller's report. After Phase 1, the data is there; this phase computes and surfaces it.

### 5.1 Schema

Mostly views and a `project_progress` table for manual % complete entry per cost code:

```sql
create table if not exists project_cost_code_progress (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  project_id uuid not null references projects(id) on delete cascade,
  cost_code_id uuid not null references cost_codes(id) on delete cascade,
  percent_complete numeric not null check (percent_complete between 0 and 100),
  basis text not null default 'manual' check (basis in ('manual','cost_to_cost','schedule_linked')),
  schedule_item_id uuid references schedule_items(id) on delete set null,
  notes text,
  recorded_at timestamptz not null default now(),
  recorded_by_user_id uuid references app_users(id),
  metadata jsonb not null default '{}'::jsonb
);
create index if not exists project_cost_code_progress_project_idx on project_cost_code_progress (project_id, cost_code_id);
create unique index if not exists project_cost_code_progress_latest on project_cost_code_progress (project_id, cost_code_id, recorded_at desc);
alter table project_cost_code_progress enable row level security;
create policy "project_cost_code_progress_access" on project_cost_code_progress for all using (auth.role() = 'service_role' or is_org_member(org_id));
```

### 5.2 Services

```typescript
// lib/services/job-costing.ts
export interface CostCodeForecast {
  costCodeId: string
  budgetCents: number
  committedCents: number
  actualCents: number
  percentComplete: number       // 0-100
  costToCompleteCents: number   // CTC
  estimateAtCompletionCents: number  // EAC
  varianceCents: number         // EAC - budget
}
export async function getJobCostingForecast(projectId: string, orgId?: string): Promise<{
  byCostCode: CostCodeForecast[]
  totals: { budget: number; committed: number; actual: number; eac: number; variance: number }
}>

export async function getProjectPL(projectId: string, orgId?: string): Promise<{
  contractValueCents: number
  approvedChangeOrderTotalCents: number
  totalRevenueRecognizedCents: number     // earned (cost-to-cost or schedule-linked)
  totalRevenueBilledCents: number
  totalCostsActualCents: number
  totalCostsForecastCents: number          // EAC
  grossProfitForecastCents: number
  grossMarginForecastPct: number
}>

export async function getProjectWIP(projectId: string, orgId?: string): Promise<{
  earnedRevenueCents: number     // % complete × contract value (cost-to-cost basis)
  billedRevenueCents: number
  overUnderCents: number          // billed - earned (positive = overbilled)
  basis: 'cost_to_cost' | 'manual'
}>
```

EAC formula default: `actualCents + (budget - actualCents) × (1 - percentComplete/100)` (linear); offer `actual_to_date / percent_complete` as alternative.

### 5.3 UI

- Budget tab gains: % Complete (editable inline), CTC, EAC, EAC Variance columns.
- New report: **Project P&L** (gross margin forecast, side-by-side actual vs. budget by category).
- New report: **WIP Schedule** (single-project for now, portfolio in Phase 3).

### 5.4 Acceptance

- A project with mock data shows EAC = budget when % complete = 100% and actuals on track.
- WIP report accurately computes over-/under-billing.

---

## 6) Phase 3 — Portfolio & Owner Dashboards

### 6.1 Replace top-level placeholders

`/invoices` and `/payments` currently show "No project selected." Replace with multi-project dashboards.

```
app/(app)/financials/page.tsx                    # NEW top-level financials home
app/(app)/financials/receivables/page.tsx        # company-wide AR aging
app/(app)/financials/payables/page.tsx           # company-wide AP aging
app/(app)/financials/cash-flow/page.tsx          # 13-week cash forecast
app/(app)/financials/vendors/page.tsx            # vendor scorecard
```

### 6.2 Services

```typescript
// lib/services/portfolio-financials.ts
export async function getPortfolioARSnapshot(orgId?: string): Promise<{
  totalCents: number
  buckets: Array<{ label: '0-30'|'31-60'|'61-90'|'90+'; cents: number; count: number }>
  topOverdueProjects: Array<{ projectId: string; name: string; cents: number; daysPastDue: number }>
}>

export async function getPortfolioAPSnapshot(orgId?: string)
export async function getCashFlowForecast(orgId?: string, weeks?: number): Promise<Array<{
  weekStart: Date
  expectedInflowCents: number      // AR aging + scheduled draws
  expectedOutflowCents: number     // AP due + scheduled sub payments
  netCents: number
  cumulativeCents: number
}>>

export async function getVendorScorecard(orgId?: string): Promise<Array<{
  companyId: string
  name: string
  ytdSpendCents: number
  activeCommitments: number
  averageBillCycleDays: number
  lienWaiverComplianceRate: number
  expiredCOI: boolean
}>>
```

### 6.3 Owner's morning view

Single hero card: cash on hand (if Plaid connected — Phase 5), AR > 30 days, AP this week, projects > 90% budget, expiring COIs in 14 days.

---

## 7) Phase 4 — Compliance & Trust

### 7.1 Subcontractor compliance vault

```sql
create table if not exists company_compliance_documents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  company_id uuid not null references companies(id) on delete cascade,
  document_type text not null check (document_type in ('w9','coi_general_liability','coi_workers_comp','coi_auto','license','contract','other')),
  file_id uuid references files(id) on delete set null,
  carrier text,
  policy_number text,
  effective_date date,
  expiration_date date,
  amount_cents integer,
  status text not null default 'active' check (status in ('active','expired','superseded','revoked')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists company_compliance_documents_company_idx on company_compliance_documents (company_id);
create index if not exists company_compliance_documents_expiring_idx on company_compliance_documents (expiration_date) where status = 'active';
alter table company_compliance_documents enable row level security;
create policy "company_compliance_documents_access" on company_compliance_documents for all using (auth.role() = 'service_role' or is_org_member(org_id));
create trigger company_compliance_documents_set_updated_at before update on company_compliance_documents
  for each row execute function public.tg_set_updated_at();
```

### 7.2 Compliance gate on payment

Extend existing `compliance_rules` to support: `require_w9`, `require_coi_general_liability`, `require_coi_workers_comp`, `require_active_license`. Block payment if any required doc is `status != 'active'` or expired.

### 7.3 1099 export

`/financials/year-end-1099` page: generates per-vendor totals for the calendar year of `payments` paid to companies marked `is_1099_required=true`, outputs CSV in IRS format and 1099-NEC PDF per vendor.

### 7.4 CO → budget revision

Modify `lib/services/change-orders.ts::approveChangeOrder` to:
1. Insert a `budget_revisions` row (new table) capturing the distribution of CO amounts across cost codes.
2. Update `budgets.adjusted_total_cents` and write per-cost-code deltas.
3. Emit `budget_revised_from_co` event.

```sql
create table if not exists budget_revisions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  budget_id uuid not null references budgets(id) on delete cascade,
  source_type text not null check (source_type in ('change_order','manual')),
  source_id uuid,
  total_cents integer not null,
  reason text,
  created_at timestamptz not null default now(),
  created_by_user_id uuid references app_users(id)
);
create table if not exists budget_revision_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete cascade,
  budget_revision_id uuid not null references budget_revisions(id) on delete cascade,
  cost_code_id uuid not null references cost_codes(id) on delete cascade,
  delta_cents integer not null
);
```

### 7.5 Retainage refactor

Move retainage from event-row to **per-line withholding** on `invoice_lines`:

```sql
alter table invoice_lines add column if not exists retainage_percent numeric default 0 check (retainage_percent >= 0 and retainage_percent <= 100);
alter table invoice_lines add column if not exists retainage_cents integer default 0 check (retainage_cents >= 0);
```

Keep `retainage` table for historical release events (held → released), but compute current held balance from `sum(invoice_lines.retainage_cents) - sum(retainage.released_cents)` per project.

Add auto-release rule on substantial completion: when `projects.status = 'substantially_complete'`, surface a "Release Retainage" CTA that creates a single retainage-release invoice.

---

## 8) Phase 5 — QBO + Bank Feed, ROI-Gated

Do **not** treat this as an automatic full phase. Accounting integrations can consume months and create trust issues if they mutate financial records too broadly. Do Phase 5 only after Phase 1/2 are working in pilot usage and only if builders are still doing painful duplicate entry.

**Decision gate before starting Phase 5:**
- At least one pilot org is generating cost-plus invoices from Arc.
- The pilot can name the exact duplicate-entry pain: invoice status, payment posting, bill sync, chart-of-accounts coding, or bank reconciliation.
- The MVP integration can remove that pain without broad two-way writes.
- There is a rollback plan and a clear source-of-truth rule for every synced object.

### 8.1 Recommended QBO scope

Start narrow:

- Pull back QBO payment status for Arc-originated invoices.
- Pull back QBO invoice status if a user marks an Arc-originated invoice paid/void in QBO.
- Add Chart-of-Accounts mapping UI in settings.
- Keep Arc as source of truth for Arc-generated invoices.
- Avoid broad two-way bill mutation until AP workflows are mature.

Later, if the above proves valuable:

- Webhook listener: handle QBO `Invoice.Updated`, `Payment.Created`, selected `Bill.Updated`.
- On QBO `Payment.Created` for an Arc-originated invoice: create or update the corresponding `payments` row, recalc invoice balance, fire `invoice_paid` event.
- Sync errors dashboard with retry/ignore controls.

### 8.2 Plaid bank feed

- New tables: `bank_connections`, `bank_accounts`, `bank_transactions`.
- Auto-match bank transactions to `payments` (in or out) by amount + date proximity + counterparty.
- Reconciliation UI: "5 unmatched transactions this month."

This is useful only after Arc owns enough of the billing/payment workflow to make matching meaningful. Defer to a dedicated implementation doc when reached.

---

## 9) Phase 6 — PWA Capture Polish, Not Native Mobile

Do **not** start a native mobile app as part of this plan. The near-term goal is field adoption through excellent mobile-web/PWA flows that are fast enough for foremen and subs.

Upgrade the Phase 1 mobile-web flows with:

- Offline draft queue via IndexedDB.
- Background photo upload with retry.
- Camera-first receipt capture.
- Geo-stamping on T&M tickets when browser permissions allow it.
- Voice-to-text using browser/platform dictation affordances where available.
- Sub portal mobile UX parity.

Native iOS/Android is explicitly out of scope until there is strong evidence that PWA limits are blocking adoption.

---

## 10) Cross-Cutting Concerns

### 10.1 Permissions

Add to RBAC matrix (extend `lib/services/permissions.ts`):

| Permission | Description |
|---|---|
| `costplus.ledger.view` | See `billable_costs` |
| `costplus.invoice.generate` | Run `generateInvoiceFromCosts` |
| `costplus.expense.submit` | Submit expense (foreman+) |
| `costplus.expense.approve` | PM approve expense |
| `costplus.time.submit` | Submit time entry |
| `costplus.time.approve` | PM approve time entry |
| `costplus.markup_rules.manage` | Edit markup rules (org admin) |
| `compliance.document.manage` | Upload/edit compliance docs |
| `financials.portfolio.view` | See company-wide dashboards |

### 10.2 Idempotency

Every mutating server action under `app/(app)/projects/[id]/financials/` and the sub/client portals must accept an `idempotency_key`. Implement once, in a wrapper:

```typescript
// lib/services/idempotency.ts
export async function withIdempotency<T>(args: {
  orgId: string
  key: string
  scope: string
  fn: () => Promise<T>
}): Promise<T>
```

### 10.3 Audit & event coverage

Every state transition on `time_entries`, `project_expenses`, `billable_costs`, `markup_rules`, `contracts.gmp_*` writes both audit and event rows. Activity feed surfaces events; audit_log is admin-only history.

### 10.4 Testing

- **Unit:** `resolveMarkupPercent`, `getJobCostingForecast`, EAC math.
- **Integration:** `generateInvoiceFromCosts` against a real Supabase test database (Vitest + a per-test schema).
- **End-to-end:** the demo script in 4.9 runs as a Playwright test gate.
- **Property-based** for the ledger: never billed twice, never lose a billable cost, always reconcile to source totals. Use fast-check.

### 10.5 Money correctness checklist

- [ ] All money fields end in `_cents` and use `integer`.
- [ ] No `numeric` for money (only for percent / multiplier).
- [ ] All sums computed server-side.
- [ ] All rounding via `Math.round` at the cent boundary, never floor/ceil mid-calc.
- [ ] Markup math: `cost_cents * markup_percent / 100`, rounded once.
- [ ] No floating-point comparisons; always integer comparison after rounding.

### 10.6 Documentation deliverables per phase

- Runbook in `docs/runbooks/` for each new background job.
- A short builder-facing help doc in `docs/help/` for each new flow (cost-plus invoicing, time entry, expense capture).
- A migration note in `docs/migrations/` capturing schema deltas, rollback strategy, and data backfill.

---

## 11) Sequencing & Estimates

### 11.1 Must-win core

| Phase | Schema | Services | UI | Integrations | Total |
|---|---|---|---|---|---|
| 1. Cost-plus & T&M core | 5–7 days | 8–10 days | 10–14 days | 2–3 days | **5–7 weeks** |
| 2. Job-cost depth | 1–2 days | 4–5 days | 4–5 days | — | **2 weeks** |

**Core target:** ~7–9 weeks to make Arc credibly worth switching to for cost-plus residential builders.

Do not start Phase 3/4 until:
- The Phase 1 demo script passes end-to-end.
- Generated cost-plus invoices reconcile to source costs.
- Phase 2 forecast/WIP math is trusted on at least one realistic project.

### 11.2 Expansion after the core

| Phase | Schema | Services | UI | Integrations | Total |
|---|---|---|---|---|---|
| 3. Portfolio dashboards | 1 day | 3–4 days | 5–7 days | — | **2 weeks** |
| 4. Compliance + trust | 2–3 days | 4–5 days | 3–4 days | 0–1 day | **2 weeks** |

Phase 3 should surface exceptions and owner-level cash visibility, not just reports. Phase 4 should be selective: prioritize compliance vault/payment gates and CO→budget revisions before retainage refactors or 1099 exports.

### 11.3 Conditional / deferred

| Track | Recommendation | Estimate |
|---|---|---|
| QBO status/payment pullback | Worth doing if pilot users still duplicate invoice/payment status work | **1–2 weeks** |
| Full two-way QBO + Plaid | Defer until the exact duplicate-entry pain is proven | **3–4+ weeks** |
| PWA capture polish | Pull forward if field adoption is weak after Phase 1 | **1–2 weeks** |
| Native mobile app | Defer; not part of this plan | **TBD** |

The old "do all phases" estimate was ~16–20 weeks. The revised strategy is to spend ~7–9 weeks on the must-win core, then choose the next expansion based on pilot feedback rather than automatically building every integration.

---

## 12) Out of Scope (future doc)

- AIA G702 / G703 standard pay applications
- Schedule of Values (formal SOV table) with progress billing per line
- WIP for surety / banks (formal CFMA WIP)
- Certified payroll, Davis-Bacon, prevailing wage
- Multi-currency, multi-tax-jurisdiction
- Public REST API + webhooks for customer ERP integrations
- Real-time costing from labor punch clocks (vs. submitted time entries)
- Native iOS/Android mobile app

These are the commercial / mid-market features. They are reachable from this foundation but not part of the residential "worth switching" cut.

---

## 13) How to Implement (LLM execution checklist)

When starting Phase 1, an implementing agent should:

1. Done: Read sections 0, 2, 4 of this doc end-to-end.
2. Skipped: Branching/PR split skipped in local implementation; keep the final PR review extra careful.
3. Done: Generate the migration file, apply via Supabase MCP or manually in Supabase SQL editor; verify against schema. Do not assume `supabase push` is part of this workflow.
4. Done: Schema implemented and applied; CI/PR split still pending.
5. Done: Implement `lib/services/cost-plus.ts`; formal unit tests still pending.
6. Done: Modify hook points in `vendor-bills.ts`, `invoices.ts`.
7. Done: Build server actions and routes; curl/unit test coverage still pending.
8. Done: Build the new Cost Plus tab + Generate Invoice modal.
9. Done: Build sub-portal time/expense routes and dashboard links.
10. Done: Build client-portal open-book drilldown + tokenized approval route.
11. Done: Add operational Phase 1 pass: Review Queue, receipt/photo attachment, crew time rows, approval-link copy, Markup Rules settings.
12. Pending: Run the full demo script in 4.9 manually; record video.
13. Pending: Add Playwright e2e of demo script once the repo has Playwright configured.
14. Pending: Ship behind a feature flag (`COST_PLUS_ENABLED`) to one pilot org first.
15. Pending: Implement Phase 2 forecasting/WIP against the same pilot data.
16. Pending: Roll out Phase 1/2 to all orgs once ledger and forecast math are trusted.
17. Pending: Choose Phase 3 or Phase 4 next based on pilot objections.

Do not skip steps 4–5 (schema + service before UI). The product depends on the ledger being right; UI bugs are recoverable, ledger bugs are not.
