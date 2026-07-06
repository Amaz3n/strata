# Financials Trust & Billing Modes Refactor — Gameplan

**Status:** Approved direction; Phases 0-6 implemented locally; Phase 0, Phase 1, Phase 2, Phase 3, and Phase 5 migrations applied to Supabase via MCP; Phase 6 required no migration
**Scope:** Billing-mode correctness fixes, data-model hardening, mode-specific features (cost plus, GMP, fixed fee, T&M), and the workflow surfaces that tie them together.
**Companion plan:** `docs/navigation-scopes-refactor-gameplan.md` (nav/IA refactor). The two can run in parallel EXCEPT: the Financials Summary page (Phase 4.1 here) is referenced by the nav plan — build it here first, or stub the route.

---

## Context primer (read before touching code)

Arc supports five project billing models, resolved by `lib/financials/billing-model.ts` → `getProjectFinancialFeatureConfig()`:

- `fixed_price` — bills via draw schedules; lands on Receivables; no cost inbox.
- `cost_plus_percent` — costs (vendor bill lines, expenses, time) flow into the `billable_costs` ledger with a resolved markup %, get invoiced from the Review inbox.
- `cost_plus_fixed_fee` — costs bill at cost; a separate fee schedule (`lib/services/fee-billing.ts`) bills the fixed fee by percent-complete.
- `cost_plus_gmp` — cost-plus with a guaranteed max; GMP tracking in `lib/services/gmp-control.ts`.
- `time_and_materials` — Phase 5 now bills time from T&M rate schedules/overrides, supports OT/DT billing math, and adds signed field tickets before approved-cost invoicing.

Key files:
- `lib/services/cost-plus.ts` (2,118 lines) — ledger writes, markup resolution, time/expense CRUD + approvals, invoice generation (`generateInvoiceFromCosts`), GMP snapshot (legacy).
- `lib/services/approved-cost-invoicing.ts` — wraps the atomic RPC `create_invoice_from_billable_costs_atomic` (migrations `20260603190000_reconcile_approved_cost_invoice_rpc.sql`, `20260603200000_...`).
- `lib/services/project-financial-setup.ts` — setup wizard save + status checks; writes BOTH `project_financial_settings` and the active `contracts` row.
- `lib/services/billing-periods.ts` + `lib/financials/billing-period-rules.ts` — period lock model.
- `lib/services/fee-billing.ts`, `lib/services/gmp-control.ts`, `lib/services/retainage.ts`, `lib/services/job-cost-actuals.ts`.
- `lib/services/financials-review-queue.ts` — feeds the Review inbox (`components/cost-inbox/review-queue-table.tsx`).
- `components/financials/receivables-tab.tsx` — invoices/fee/draws/retainage sub-tabs.

Service-layer conventions (from CLAUDE.md): `requireOrgContext()`, `requirePermission()`/`requireAuthorization()`, `recordEvent()`, `recordAudit()`, org_id scoping on every query, server actions in `actions.ts`. Money is integer cents everywhere. Run `pnpm lint` after changes; do NOT run `pnpm dev` or `pnpm build`. Migrations: write SQL in `supabase/migrations/`, push with `npx supabase db push` only when instructed (local dev points at PROD Supabase — be careful).

---

## Phase 0 — Correctness fixes (completed locally)

These are billing-integrity bugs. Each fix needs a test where a test harness exists (see `lib/services/approved-cost-invoice-preview.test.ts`, `invoice-balance.test.ts` for patterns).

**Completion note:** 0.1-0.11 are implemented in code with migration `supabase/migrations/20260703191000_financials_phase0_correctness.sql`. Migration has been applied to the Supabase `Arc` project (`gzlfiskfkvqgpzqldnwk`) via MCP as remote migration `20260704042107_financials_phase0_correctness`.

### 0.1 Markup overrides are dropped at invoice time (completed)
**Bug:** `generateInvoiceFromCosts` (`lib/services/cost-plus.ts` ~line 1930) re-resolves markup for every open cost via `resolveMarkupPercent()` WITHOUT the `lineOverride` param. Ledger rows created from an expense with `markup_percent_override` (source `"line"`) get the contract/org markup re-applied on the invoice.
**Fix:** Do not re-resolve markup for rows whose stored `metadata.markup_source === "line"` — use the stored `markup_percent_resolved`/`markup_cents`. For all other rows, keep the refresh but batch it (see 1.2). Add a regression test: expense with 0% override → ledger → invoice preview shows 0% markup.

### 0.2 No retainage on approved-cost invoices (completed)
**Bug:** Retainage lines are only added in `createInvoice`'s source-context path (`lib/services/invoices.ts` ~255–345). The approved-cost RPC has zero retainage logic, but the setup wizard collects `retainage_percent` for every model.
**Fix:** In `createApprovedCostInvoiceFromPreview` (or inside the RPC — prefer the RPC to keep atomicity): when the active contract has `retainage_percent > 0`, append a system-generated negative line `Retainage held (N%)` computed on the gross billable subtotal, matching the exact line shape `applySourceDerivedBillingLines` produces (unit `"retainage"`), and insert the `retainage` table record (mirror `applyRetainageToInvoice` in `lib/services/retainage.ts`). Update the invoice totals accordingly. Same treatment for fee invoices in `createProjectFeeInvoice` IF the contract terms say fee is retained (make this a contract snapshot flag `retain_fee: boolean`, default false).

### 0.3 Overtime multiplier is ignored (completed)
**Bug:** `calculateTimeEntryCostCents` (`lib/services/job-cost-actuals.ts:41`) is `hours × base_rate × burden`; `is_overtime` is stored but never used.
**Fix:** Add `ot_multiplier` numeric column to `time_entries` (default 1.5), applied when `is_overtime` is true: `hours × base_rate × burden × (is_overtime ? ot_multiplier : 1)`. Surface the multiplier in `components/time/time-entry-form.tsx` when OT is toggled. Recompute nothing retroactively — only new/edited entries.

### 0.4 Allowance overage stops billing after first invoice (completed)
**Bug:** `ensureAllowanceOverageBillableCosts` (`lib/services/cost-plus.ts` ~336–421) `continue`s when a non-open ledger row exists for the allowance, so overage growth after the first billing is never billed.
**Fix:** Track billed-to-date overage per allowance (sum of non-voided `allowance_overage` rows for that `source_id`). If current overage > billed-to-date, insert a NEW row for the delta with `source_id` = `${allowance.id}` + a sequence discriminator in metadata (the unique index on source_type+source_id must allow this — check the constraint; if it's unique, use `metadata.sequence` and a composite source_id like `${allowance.id}:2`). Description: `Allowance overage (additional): {name}`.

### 0.5 Time entry rate edits don't re-post the ledger (completed)
**Bug:** `updateTimeEntry` (`cost-plus.ts` ~969) allows changing `base_rate_cents`/`burden_multiplier` on approved entries; the existing `billable_costs` and `job_cost_entries` rows are not re-posted (expenses got this right via `resyncApprovedExpenseLedger`).
**Fix:** If the entry status is `pm_approved`/`client_approved` and any of rate/burden/cost-code/isBillable change: (a) if the ledger row is billed (invoice_id set) → reject the edit with the same message pattern used in `replaceProjectExpenseLines` ("already billed on an invoice"); (b) otherwise void the old `billable_costs` + job-cost rows and re-post (reuse the void→repost pattern from `resyncApprovedExpenseLedger`).

### 0.6 GMP cap is advisory, not enforced (completed)
**Fix:** In `generateInvoiceFromCosts`, when the billing model is `cost_plus_gmp`: compute revised GMP + already-billed inside-GMP total (from `getProjectGmpControlSummary`), and if this invoice would push cumulative billing past revised GMP, throw with the overage amount unless the caller passes `overrideGmpCap: true` (add to `generateInvoiceFromCostsInputSchema`). The Review inbox invoice-preview dialog must show the cap warning and an explicit "bill anyway" checkbox that sets the flag; record `gmp_cap_overridden: true` in invoice metadata + an event.

### 0.7 Billing period overlap unguarded (completed)
**Fix:** Migration: add an exclusion constraint on `project_billing_periods` (`org_id`, `project_id`, daterange(period_start, period_end, '[]') with `&&`) using btree_gist. In `createProjectBillingPeriod`, pre-check and return a friendly error naming the overlapping period.

### 0.8 Review inbox silently truncates at 50 (completed)
**Bug:** `listCostPlusTabData` (`cost-plus.ts` ~1599) limits time entries and expenses to 50.
**Fix:** For the review queue path, remove the limit for items in reviewable statuses (`submitted`, `pm_approved` for time; `draft`, `submitted` for expenses) — those sets are naturally bounded. Keep a limit only for historical/settled rows. If total reviewable rows exceed 200, paginate the table (`review-queue-table.tsx`) rather than dropping rows, and always render a total count.

### 0.9 One approval gate, many doors (server-side enforcement) (completed)
**Bug:** The inbox blocks approval on missing rate / cost code / proof, but those are UI annotations. `approveTimeEntry`, `approveProjectExpense`, and the vendor-bill approve action enforce none of it — approving from the Time page (`components/time/time-entries-client.tsx:215`), the expense workspace, or payables bypasses every gate.
**Fix:** Move the eligibility rules into the services (they already know `project_financial_settings`):
- `approveTimeEntry`: reject if `base_rate_cents <= 0`; if `cost_codes_enabled` and no cost code; if `proof_required` and no attachments.
- `approveProjectExpense`: reject if not submitted; if `cost_codes_enabled` and no cost code; if `proof_required` and no receipt.
- Vendor bill approval (find in `lib/services/vendor-bills.ts`): reject if `cost_codes_enabled` and any line uncoded.
Error messages must match the inbox's blocking-reason strings (`lib/services/financials-review-queue.ts` ~84–127) so the UX is coherent. Then extract those strings to a shared module (`lib/financials/approval-gates.ts`) consumed by both the services and the review queue annotator.

### 0.10 Deduplicate GMP computation (completed)
**Fix:** Delete `getGMPSnapshot` from `cost-plus.ts` (~2051) and its `GMPSnapshot` type; every consumer (search for `getGMPSnapshot` and `gmpSnapshot` — includes `listCostPlusTabData`) switches to `getProjectGmpControlSummary` from `gmp-control.ts`. Keep `recordProjectGmpSnapshot` (the daily persistence) as is.

### 0.11 Trivia (completed)
- `approveTimeEntry` dead ternary (`cost-plus.ts` ~1019): `requires_client_cost_approval ? "pm_approved" : "pm_approved"` — resolve the intent: when client approval is required the entry should stay `pm_approved` and NOT propagate to ledger (the code below already gates propagation) — simplify to a constant with a comment, or implement the intended distinct status if one exists in the DB enum.

**Phase 0 acceptance:** completed locally. `./node_modules/.bin/eslint .` passed; `node --test tests/financials-phase0.test.js tests/qbo-import-reliability.test.js` passed. `./node_modules/.bin/tsc --noEmit` is blocked by an unrelated existing `lib/services/project-close-readiness.ts` type error, and `tests/financials-regression.test.js` is blocked by missing module `../lib/financials/portfolio-control`.

---

## Phase 1 — Data model & performance hardening

**Completion note:** 1.1-1.4 are implemented in code. Migration `supabase/migrations/20260704033339_financials_phase1_data_model_hardening.sql` has been applied to the Supabase `Arc` project (`gzlfiskfkvqgpzqldnwk`) via MCP as remote migration `20260704033339_financials_phase1_data_model_hardening`.

**Applied/verified:**
- `contracts.fixed_fee_cents` and `contracts.parent_contract_id` were added, with the fixed-fee check constraint, parent-contract FK, and supporting indexes verified in Supabase.
- Fixed fee now reads/writes through `contracts.fixed_fee_cents`; legacy `contract.snapshot.fixed_fee_cents` / `project_financial_settings.metadata.fixed_fee_cents` remain fallback/backfill sources.
- `project_financial_settings.billing_model` is the authoritative model for normal reads/writes. New setup/project-settings writes no longer store `billing_model` in `contract.snapshot`; `resolveProjectBillingModel` keeps legacy fallbacks.
- `billing_model_contract_mismatch` setup blocking was removed. Legacy mismatch inspection/repair lives in `scripts/repair-financial-billing-model-mismatches.sql`.
- Material contract-term changes after protected billing activity create a new active contract with `parent_contract_id` and mark the previous contract `superseded`; both setup wizard and project settings flows use this path.
- `resolveMarkupPercentsBatch()` now batches invoice-time markup refresh in `generateInvoiceFromCosts`; `resolveMarkupPercent()` remains as the single-row wrapper.
- `propagateApprovalToLedger` batches independent vendor-bill / split-expense line posting where safe.
- `getProjectFeeBillingSummary` is now a pure read: when no schedule exists it computes a synthetic summary from contract terms; fee schedule rows materialize only on first fee progress update or fee invoice creation.

**Verification:** `pnpm lint` passed; `node --test tests/financials-phase0.test.js tests/qbo-import-reliability.test.js` passed; `git diff --check` passed. `./node_modules/.bin/tsc --noEmit` is still blocked by the known unrelated `lib/services/project-close-readiness.ts:460` `due_date` type mismatch. Supabase verification found one active `cost_plus_fixed_fee` project, but both legacy fixed-fee fields were `null`, so no value was available to backfill.

### 1.1 Single source of truth for billing configuration
Today the billing model lives in three places: `project_financial_settings.billing_model`, `contracts.contract_type`, `contract.snapshot.billing_model` — with a runtime mismatch detector (`billing_model_contract_mismatch` in `project-financial-setup.ts`). Fixed fee lives in two JSONB blobs.

**Direction:**
- `project_financial_settings` becomes authoritative for the MODEL; the contract stores commercial TERMS (amounts, percentages, retainage, splits).
- Promote `fixed_fee_cents` to a real column on `contracts`. Migration backfills from `snapshot.fixed_fee_cents` / `settings.metadata.fixed_fee_cents`.
- `resolveProjectBillingModel` (`lib/financials/billing-model.ts`) keeps its fallback chain for legacy rows but new writes never rely on snapshot.
- `saveProjectFinancialSetup` stops writing `billing_model` into `contract.snapshot`.
- Remove the mismatch issue code once the wizard can no longer produce a mismatch (keep a data-repair script for existing rows).

### 1.2 Contract amendments instead of in-place mutation
`saveProjectFinancialSetup` currently UPDATEs the active contract in place — changing GMP/markup/model mid-project silently rewrites terms under existing invoices.

**Direction:** When the saved terms differ materially (model change, GMP change, markup change, retainage change) AND the project has any non-draft invoice or non-voided billable cost: set the existing contract `status = 'superseded'`, insert a new active contract with `parent_contract_id`, and record the delta in the audit. Cosmetic edits (title) stay in-place. `getActiveContract` already filters `status = 'active'` so reads are unaffected. Add `parent_contract_id` column via migration.

### 1.3 Batch the markup resolution N+1
`resolveMarkupPercent` runs up to 5 queries per cost; `generateInvoiceFromCosts` calls it per row.

**Direction:** New `resolveMarkupPercentsBatch({ supabase, orgId, contractId, costs })`: load ALL markup_rules for the org + the contract row + involved cost_codes in 3 queries, then resolve each cost in memory with identical precedence (line override → cost_code.default_markup_percent → cost_code rule → contract rule → contract.markup_percent → org rule → 0, honoring effective_from/to and applies_to_category). Keep single-row `resolveMarkupPercent` as a wrapper. Also batch the per-line loops in `propagateApprovalToLedger` (collect line ids, then bulk operations where possible).

### 1.4 Read paths must not write
`getProjectFeeBillingSummary` calls `syncContractFeeSchedule` (upsert) on every receivables render. **Direction:** compute the summary from contract terms when no schedule row exists (pure read); materialize the schedule row only on first WRITE action (progress update or fee invoice). Delete the sync-on-read.

---

## Phase 2 — Invoice presentation: fee as a first-class concept (completed)

**Completion note:** Phase 2 is implemented in code. Migrations `supabase/migrations/20260703210000_financials_phase2_fee_presentation.sql` and `supabase/migrations/20260704044500_financials_phase2_rpc_grants.sql` have been applied to the Supabase `Arc` project (`gzlfiskfkvqgpzqldnwk`) via MCP as remote migrations `20260704043955_financials_phase2_fee_presentation` and `20260704044358_financials_phase2_rpc_grants`.

**Applied/verified:**
- `contracts.fee_presentation` was added with default `"embedded"`, a check constraint for `"embedded" | "separate_total" | "separate_by_code"`, and a column comment verified in Supabase.
- Approved-cost invoice creation now validates first-class fee lines inside the atomic RPC, including cost-only reimbursable lines, separate markup fee lines, optional earned fixed-fee lines, gross totals, and retainage.
- The invoice RPC grants were hardened after advisor review: `anon` no longer has execute privilege, while `authenticated` and `service_role` retain execute for the app path.
- Fee presentation flows are wired through project financial setup, contract reads/writes, invoice draft generation, Review invoice preview, invoice/PDF/portal rendering, and QBO sync mapping.

Cost-plus contracts almost always require the fee stated separately from costs. Today `buildInvoiceDraft` (`cost-plus.ts` ~1787) folds markup into each line.

- Add `fee_presentation` to contract terms: `"embedded" | "separate_total" | "separate_by_code"`. Default `"embedded"` (current behavior) for existing projects; wizard default for NEW cost-plus projects = `"separate_total"`.
- `buildInvoiceDraft`: for `separate_total`, lines carry cost only (`billable_cents = cost_cents`) plus one system line `Builder's fee` = sum of markup; for `separate_by_code`, one fee line per cost-code group. `billable_cost_ids` mapping and RPC line-writing must keep the cost↔line links for open-book detail (`listOpenBookCostDetailsForInvoice`).
- For `cost_plus_fixed_fee`: extend the Review inbox invoice-preview dialog with an optional "Include earned fee: $X" checkbox (from `getProjectFeeBillingSummary().billable_fee_cents`) that appends the fee line and records the fee billing allocation exactly as `createProjectFeeInvoice` does — one owner invoice, not two flows. Reuse the allocation logic; do not fork it.
- Invoice PDF, portal view (`app/i/[token]`, client portal), and QBO sync mapping must render/map the fee line (unit `"fee"`, taxable false).

---

## Phase 3 — GMP: from banner to control

**Completion note:** Phase 3 is implemented locally. Migration `supabase/migrations/20260704120000_financials_phase3_gmp_control.sql` adds `contracts.contingency_cents` plus the signed `gmp_contingency_entries` ledger. It has been applied to the Supabase `Arc` project (`gzlfiskfkvqgpzqldnwk`) via MCP as remote migration `20260704145025_financials_phase3_gmp_control`.

1. **Contingency ledger.** New table `gmp_contingency_entries` (org_id, project_id, contract_id, amount_cents signed, reason, approved_by, created_at, metadata). Contract terms gain `contingency_cents`. `getProjectGmpControlSummary` reports contingency remaining = contingency − drawdowns; drawdowns require `invoice.write` and record audit + event.
2. **Savings closeout settlement.** New service `settleGmpSavings(projectId)`: allowed only when project status is completed/closeout; computes final savings from the control summary; creates either an owner credit memo or a builder savings-share invoice line per the split; marks the contract snapshot `savings_settled_at`. Surface in the project closeout flow (`app/(app)/projects/[id]/closeout`).
3. **GMP view.** Replace the one-line banner in `receivables-tab.tsx` with a GMP section on the Financials Summary page (Phase 4.1): burn bar (inside-GMP EAC vs revised GMP), contingency remaining, savings forecast + split, trend sparkline from `project_gmp_snapshots` (data already recorded daily, never charted). Follow the `dataviz` skill before writing chart code.

---

## Phase 4 — Workflow surfaces (completed)

**Completion note:** Phase 4 is implemented locally. Financials now lands on the all-mode Summary page; cost-driven projects have the Close & Bill workflow; Review replaces the user-facing inbox surface with aging, ready-to-bill summary, generate CTA, and deep links from Time/Expenses. No Supabase migration was required for this phase.

### 4.1 Financials Summary page (new landing, all modes) (completed)
Route: `app/(app)/projects/[id]/financials/summary/page.tsx`. Becomes the Financials group landing for EVERY billing model (the nav plan repoints `getFinancialLandingUrl` here).
Content (server component, one loader in `page-data.ts`):
- Header: billing-mode badge (links to setup sheet), setup-status banner (existing component).
- Stat row: contract value + approved COs → revised; billed to date; paid; outstanding; retainage held; unbilled ledger total (cost-driven modes); margin vs budget.
- Mode-specific hero: fixed_price → draw progress strip (next due draw CTA); cost_plus_gmp → the Phase 3 GMP section; cost_plus_* / T&M → ready-to-bill total + unbilled aging buckets (0–30/31–60/61+) with CTA into Review; fixed_fee → fee earned/billed bar.
- Recent invoices/payments list (compact, links into Receivables).

### 4.2 Period Close & Bill page (completed)
Route: `app/(app)/projects/[id]/financials/close/page.tsx` (cost-driven modes only; hide via feature config).
A stepper bound to the selected billing period: (1) items still in review (count, link to Review filtered), (2) costs ready to bill $X + late costs carried in, (3) fee to include (fixed-fee), (4) GMP cap check, (5) generate invoice(s) + backup package (`generateInvoiceBackupPackage` in `owner-billing-packages.ts`), (6) close period. Each step is a link/action into existing machinery — this page orchestrates, it does not duplicate. Fold `BillingAutopilotPanel` findings in as checklist annotations and remove the standalone panel from `receivables-tab.tsx`.

### 4.3 Review inbox polish (completed)
- Rename user-facing "Inbox" → "Review" everywhere in this surface (nav rename happens in the nav plan).
- Persistent summary bar: "Ready to bill: $X · oldest unbilled cost N days" with Generate CTA (currently hidden until selection).
- Add an age column/badge for open costs (days since `occurred_on`).
- Remove the duplicate generate-from-costs entry: `InvoicesClient` prop `enableApprovedCostsSource` → always false/removed; Receivables links to Review instead.
- Remove approve/reject from `components/time/time-entries-client.tsx` and the expense workspace; replace with status badges + "Review in Financials" deep links. (Server-side gates from 0.9 are the safety net; this is the UX half.)

---

## Phase 5 — Real T&M (largest net-new; last)

**Progress:** Implemented and applied. Dedicated field-ticket spec: `docs/tm-field-tickets-phase5-spec.md`. Migration `supabase/migrations/20260704170000_financials_phase5_real_tm.sql` has been applied to the Supabase `Arc` project (`gzlfiskfkvqgpzqldnwk`) via MCP as remote migration `20260704162855_financials_phase5_real_tm`.

1. **Rate schedules — completed.**
   - Added `billing_rate_schedules`, `billing_rates`, and `billing_rate_overrides`.
   - Added `contracts.rate_schedule_id` and wired T&M setup/project contract snapshots to preserve the assigned schedule.
   - Added `/settings/billing-rates` for schedule creation/archive, rate entry, T&M project assignment, and project-specific overrides.
   - Schedule assignment uses the amendment-aware contract saver, so schedule changes are tracked as material contract terms when protected billing activity exists.

2. **T&M billing math — completed.**
   - T&M time entries now resolve billable value from project override → schedule person → schedule labor role → membership `labor_bill_rate_cents` fallback.
   - `cost_cents` remains loaded job cost; `billable_cents` is bill rate × quantity × OT/DT multiplier; `markup_cents` is derived from billable minus cost.
   - Materials/expenses can resolve material markup from T&M project overrides or schedule material rates, falling back to existing cost-plus markup rules when no T&M match exists.
   - Invoice generation preserves stored T&M rate snapshots instead of re-resolving those rows back to cost-plus percentage markup.
   - Time entry validation/forms/actions now support double time (`is_double_time`, `dt_multiplier`) and enforce OT/DT exclusivity.

3. **T&M field tickets — completed.**
   - Added `tm_tickets` and `tm_ticket_items` with draft → submitted → client_signed → billed/voided workflow.
   - Added project route `/projects/[id]/financials/tm-tickets` for creating tickets from approved open time/expense ledger rows, sending signature links, invoicing signed tickets, and voiding unbilled tickets.
   - Added public `/t/[token]` signing route with one-time token hash, expiration check, signer name/email/IP/user-agent capture, audit/event logging, and token clearing after signature.
   - Signed tickets generate invoices through the existing approved-cost invoice flow using the ticket's exact `billable_cost_ids`, then link invoice metadata and mark the ticket billed.

**Verification:** `pnpm lint`, `./node_modules/.bin/tsc --noEmit --pretty false`, `git diff --check`, and `node --test tests/financials-phase0.test.js` passed after Phase 5. The broader financial regression command is currently blocked by an unrelated missing module, `../lib/financials/portfolio-control`, referenced only by `tests/financials-regression.test.js`.

---

## Phase 6 — Reporting ante (parallel-friendly)

**Completion note:** Phase 6 is implemented locally. The existing draw-schedule G702/G703 PDF renderer now has the requested report service layer at `lib/services/reports/pay-application.ts`, and the draw action delegates to it. Org/project WIP over-under reporting lives in `lib/services/reports/wip-over-under.ts`, with JSON/CSV APIs plus org `/billing`, org `/reports`, and project `/projects/[id]/reports/wip` surfaces. No Supabase migration was required.

1. **AIA-style G702/G703 export — completed.**
   - Draw-schedule pay applications render with the existing `@react-pdf/renderer` PDF at `lib/pdfs/pay-application.tsx`.
   - Data assembly now lives in `lib/services/reports/pay-application.ts`; `generateDrawPayApplicationAction` delegates to that service.
   - The service builds G702-style summary totals and a G703-style continuation sheet from draw/SOV rows, retainage, previous-billed math, approved COs, owner/contractor/project context, and linked invoice number when present.
   - Contract math now treats active contract totals as revised totals and infers original contract sum from approved COs unless an explicit original/base contract snapshot exists, avoiding double-counted COs.

2. **Org WIP / over-under billing report — completed.**
   - Added `lib/services/reports/wip-over-under.ts` with org and project report loaders.
   - WIP math uses revised contract value, approved CO totals, actual cost and EAC from `getBudgetWithActuals`, earned revenue from cost-to-cost percent complete, billed-to-date from non-draft owner invoices, and over/under billing as billed minus earned.
   - Added JSON/CSV APIs at `/api/reports/wip` and `/api/projects/[id]/reports/wip`.
   - Added UI surfaces at `/billing`, `/reports`, and `/projects/[id]/reports/wip`, plus workspace/project navigation links.
   - Org-level WIP excludes projects marked `excluded_from_reporting`; single-project reports still include their own project.

**Verification:** `git diff --check`, `./node_modules/.bin/eslint .`, and `./node_modules/.bin/tsc --noEmit` passed after Phase 6. `pnpm lint` did not reach ESLint because pnpm attempted a non-interactive `node_modules` purge; the project-local ESLint binary was used instead. No Supabase migration was required.

---

## Sequencing summary

| Order | Phase | Risk | Depends on |
|---|---|---|---|
| 1 | Phase 0 (0.1–0.11) - completed locally | Low, high value | — |
| 2 | Phase 1 | Medium (migrations) | 0 |
| 3 | Phase 2 - completed | Medium | 0.1, 1.3 |
| 4 | Phase 4.1, 4.3 - completed | Low | 0.9, 0.10 |
| 5 | Phase 3 | Medium | 0.6, 0.10 |
| 6 | Phase 4.2 - completed | Low | 4.1, 2 |
| 7 | Phase 6 - completed | Low | — (parallel any time) |
| 8 | Phase 5 | High (new domain) | 0, 1 |

**Global acceptance:** every mutation keeps the recordEvent/recordAudit conventions; all new queries org_id-scoped; `pnpm lint` clean; no `pnpm dev`/`pnpm build`; migrations written to `supabase/migrations/` and pushed only with explicit user approval (remote DB is production).
