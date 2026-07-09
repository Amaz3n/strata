# Workstream 03 — Change Management Lifecycle (PCO → OCO, Cost vs Price)

> Prereq: 00 master, 01 (tier/terminology), 02 (SOV exists so approved COs can append
> SOV lines). Commercial change management is a pipeline with two sides of the ledger:
> what the change COSTS the GC (sub CCOs + self-perform + markup) and what the GC
> PRICES it to the owner. Arc today has a flat `change_orders` table (free-text status,
> single header markup) with only a soft metadata link to commitment COs.

## Goal

1. A **PCO → OCO state machine** on the existing `change_orders` table (no new prime-CO
   table — extend, don't fork).
2. **Cost-vs-price modeling**: CO lines carry internal cost AND owner price; price can
   be derived from linked commitment COs + markup.
3. **First-class linkage**: prime CO ↔ commitment COs (costed rollup) and prime CO ↔
   source RFI (structured, replacing metadata-only links).
4. Approved prime COs **post to the SOV** (workstream 02's `applyChangeOrderToSov`) and
   feed the G702 CO summary.
5. A **Change Events log** view: every potential change (from RFI, field, owner
   request) visible in one pipeline with statuses and exposure totals.

## Non-goals

- No separate "change event" table — the PCO *is* the change event (statuses cover the
  pre-pricing stage). Revisit only if usage demands it.
- No bulletin/CO-package grouping (defer).
- Commitment CO internals stay as-is except for the new linkage columns.

## Read these files first

- `lib/services/change-orders.ts` (~2,059 lines) — especially `calculateTotals`
  (~L86-110), billing_status logic (~L125-219: `tracking_only` vs `ready_to_bill`),
  budget_revision posting on approval, e-sign metadata.
- `lib/services/commitment-change-orders.ts` (~1,138 lines) — status flow,
  `metadata.source_change_order_id` soft link (you will replace with a real column).
- `lib/services/rfis.ts` — `convertRfiToChangeOrder` (~L765) writes
  `change_orders.metadata.source_rfi_id`; you will migrate this to a column.
- `change_orders` verified columns: status (text), co_number (integer), contract_id,
  total_cents, days_impact, client_visible, requires_signature, metadata, approved_by/at,
  rejected_at. `change_order_lines`: cost_code_id, budget_line_id, quantity, unit,
  unit_cost_cents, gmp_* fields, metadata.
- Workstream 02's `applyChangeOrderToSov` contract.
- The CO UI: grep `components/` for change-order composer/detail sheet (project
  financials area) — read the full composer before editing.

## Data model

**Migration — `<ts>_change_lifecycle.sql`:**

```sql
-- 1. Structured lifecycle. Existing rows: map current free-text status
--    ('draft' stays draft; 'approved' -> approved; 'rejected' -> rejected;
--    anything else -> draft). Write the UPDATE in this migration.
alter table public.change_orders
  add column if not exists lifecycle text not null default 'draft'
    check (lifecycle in
      ('draft',            -- being scoped, not priced
       'pricing',          -- collecting sub pricing / estimating cost
       'proposed',         -- priced, sent to owner (this is the PCO stage)
       'approved',         -- owner approved => OCO; contract sum changes
       'rejected',
       'void')),
  add column if not exists source_rfi_id uuid references public.rfis(id),
  add column if not exists proposed_at timestamptz,
  add column if not exists owner_response_due date,
  add column if not exists cost_total_cents integer,        -- internal cost rollup
  add column if not exists markup_mode text not null default 'percent'
    check (markup_mode in ('percent','manual'));            -- price = cost*(1+pct) or hand-set

-- 2. Two-sided lines: existing unit_cost_cents remains the OWNER PRICE basis
--    (it already drives total_cents/billing). Add internal cost per line.
alter table public.change_order_lines
  add column if not exists internal_cost_cents integer,
  add column if not exists commitment_change_order_id uuid
    references public.commitment_change_orders(id);

-- 3. Hard link CCO -> prime CO (replaces metadata.source_change_order_id).
alter table public.commitment_change_orders
  add column if not exists prime_change_order_id uuid
    references public.change_orders(id);

-- 4. Backfill both soft links into the new columns (metadata.source_change_order_id
--    on commitment_change_orders; metadata.source_rfi_id on change_orders).
--    Write the UPDATE ... FROM jsonb extraction here. Keep metadata keys in place
--    (read-compat) but stop writing them in code.
```

Naming note: keep the noun "Change Order" in UI for both tiers; commercial tier shows
lifecycle chips ("PCO" chip when lifecycle in draft/pricing/proposed, "CO #" once
approved). Terminology map (01) can add `pcoLabel` if the UI needs the word.

## Service layer changes (`change-orders.ts`)

- **Lifecycle transitions** as explicit functions with guards (follow the RFI service's
  send/close/reopen style):
  - `startPricing(coId)` draft→pricing.
  - `proposeChangeOrder(coId)` pricing|draft→proposed. Requires total_cents > 0 or an
    explicit zero-dollar flag; stamps proposed_at; optionally sends to owner via the
    existing client-visible + e-sign path (`requires_signature` already exists —
    reuse; the send-to-owner mechanics already exist for approvals, find and reuse).
  - `approveChangeOrder` — existing approval logic gains: lifecycle→approved, then
    (a) posts budget revision (already exists), (b) calls
    `applyChangeOrderToSov(coId)` when the project's billing basis is `progress`,
    (c) recomputes contract sum consumers (G702 reads approved COs — no extra work if
    it queries live).
  - `rejectChangeOrder`, `voidChangeOrder` (void only from draft/pricing/proposed).
  - Keep legacy `status` column in sync (write both) until UI fully reads lifecycle,
    then plan a follow-up to drop `status` (note it, don't do it in this workstream).
- **Cost rollup:** `recomputeChangeOrderCost(coId)` — cost_total_cents =
  Σ line.internal_cost_cents where set, else Σ linked CCO totals per line, else null.
  When markup_mode = 'percent', owner price lines can be auto-derived:
  `deriveOwnerPriceFromCost(coId, markupPercent)` sets each line's
  unit_cost_cents/quantity to cost*(1+pct) (respect existing `calculateTotals` tax
  handling). When 'manual', price lines are edited freely and the UI shows
  margin = price − cost.
- **Create-from-CCO:** `createPrimeCoFromCommitmentCos(projectId, ccoIds[], opts)` —
  new prime CO in `pricing` with one line per CCO (description = CCO title,
  internal_cost_cents = CCO total, commitment_change_order_id set), then
  `deriveOwnerPriceFromCost` with the org/project default markup. Also backlink each
  CCO's `prime_change_order_id`.
- **Create-from-RFI:** update `convertRfiToChangeOrder` to write `source_rfi_id`
  column, land in lifecycle `draft`, and copy the RFI's cost_impact_cents into
  internal_cost_cents (impact is an estimate of cost, not price).
- **Exposure accounting:** new read model `getChangeExposure(projectId)` — totals by
  lifecycle stage: pending cost exposure (draft+pricing+proposed cost_total), proposed
  price awaiting owner, approved additions/deductions. Consumed by the Change Events
  view and by budget EAC: extend the budget rollup's `pending_cost_cents` to include
  unapproved CO cost exposure per cost code (additive field; do not silently change
  the existing pending definition — add `pending_change_cost_cents`).

`commitment-change-orders.ts`: write the new `prime_change_order_id` column instead of
metadata; expose `listCommitmentCosForPrimeCo(coId)`.

## UI

- **CO composer/detail** (project financials): lifecycle chip + transition buttons per
  state; two-column money summary Cost | Price | Margin; per-line internal cost input
  and CCO link picker (searchable list of the project's commitment COs not yet linked);
  "Derive price from cost @ N%" action. Owner-facing views (portal, PDF, invoice)
  NEVER show cost/margin — audit every render path for the new fields.
- **Change Events view:** new sub-tab in project financials (or extend the existing CO
  tab header) listing all COs grouped by lifecycle with exposure totals strip
  (Pending cost / Proposed to owner / Approved Δcontract). Dense table, deep-links to
  composer. This is the PM's weekly meeting view.
- **RFI detail:** linked-CO panel already exists (`getRfiLinkedChangeOrder`) — make it
  read the new column.
- **Portal:** owner sees proposed COs (existing `client_visible` + approval flow).
  Ensure a `proposed` CO with `requires_signature` follows the existing portal CO
  approval path unchanged.

## G702 integration (with workstream 02)

`pay-applications.ts` submit computes `change_order_sum_cents` = Σ approved prime CO
totals (additions and deductions separately for the PDF's CO summary box:
deduction = negative total). Confirm sign conventions: Arc CO totals can be negative
already (verify; if not, allow negative line quantities — check `calculateTotals`).

## Permissions / events / validation

- Reuse existing CO permission keys (grep how CO approve is gated today). Add
  `change_order.propose` only if approve/write don't split cleanly.
- Events: `change_order.proposed`, `change_order.approved` (exists? verify —
  `change_order_published/approved` appear in events.ts), `change_order.cost_linked`.
- Zod: extend `lib/validation/` CO schemas with lifecycle enum, internal_cost_cents,
  markup_mode; validate lifecycle transitions server-side (never trust the client's
  target state).

## Phases

1. Migration + lifecycle transitions + status/lifecycle dual-write + backfills.
2. Cost side: line internal cost, CCO linkage, rollup, create-from-CCO,
   create-from-RFI column migration. Unit tests for cost/price/margin math (pure
   helpers in `lib/financials/`, test like `invoice-balance.test.ts`).
3. Composer UI (cost column, lifecycle controls, derive-price).
4. Change Events view + exposure read model + budget pending-exposure field.
5. SOV/G702 hooks (calls into workstream 02) + portal path verification.

## Acceptance checklist

- [ ] RFI with $5k cost impact → converts to CO draft with internal cost $5k, no price.
- [ ] Link two CCOs ($3k + $2k) to a CO, derive price at 15% → price $5,750, margin
      shown internally, owner portal/PDF show price only.
- [ ] Propose → owner approves via portal signature → lifecycle approved, budget
      revision posted, SOV gains the CO line, next pay app's G702 CO summary shows it.
- [ ] Deduction CO (negative) flows through totals, SOV, and G702 correctly.
- [ ] Change Events view totals reconcile with the CO list.
- [ ] Legacy residential CO flow (draft→approved without lifecycle UI) still works;
      existing rows backfilled sanely.
- [ ] `pnpm lint` + `pnpm test:financials` pass.
