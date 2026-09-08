# Arc Books — From 4/10 to 10/10

> **Status: ACTIVE PLAN — intent, not a description of the system.**
> Nothing in this document is guaranteed to exist. Never infer current app
> behavior from it. Source of truth is the code, `CLAUDE.md`, and the reference
> docs at the `docs/` top level.

**Written:** 2026-09-03, from a code and production audit (see §0.1).
**Audience:** an LLM executor. Follow directives literally. **STOP** means stop and
ask the human; every phase gate is a human decision. Every directive is written to
be executed by an agent that starts with zero conversation context.
**Supersedes:** `docs/plans/arc-books-gameplan.md` phases B–C are shipped and
recorded there as history. Its still-open items (B5.8, C3.4, C5) are absorbed into
Phases K and L below. When this plan ships, delete both files.
**Companions:** `docs/books-revenue-recognition.md` (CPA package — Phase F extends
it), `docs/plans/arc-books-sole-ledger-release.md` (activation gates — Phase D
executes them), `docs/plans/fintech-gameplan.md` (rails; Books consumes `payments`),
`docs/plans/migration-ledger-reconciliation.md` (Phase D.6 runs it).

---

## 0. Where we are, and what 10 means

### 0.0 Score today (measured 2026-09-03)

| Posture | Score | Why |
|---|---|---|
| Residential custom | 4 | Fixed-price flow is right; cost-plus revenue, cash accounts, payroll clearing, tax gaps block a switch. |
| Commercial GC | 5 | Retainage, pay apps, POC, WIP are the strongest parts; loss provisions, contract-asset reclass, dimensions, operational proof missing. |
| Production | 2 | No inventory or land model. Job cost expenses as incurred on closing-basis projects. |
| Overall | 4 | Foundation 8, entry set 6, operational proof 2. |

### 0.1 Ground truth (verified 2026-09-03 — rely on these facts)

**Code.** 46 modules, ~16k lines in `lib/services/books/`. Posting rules are pure in
`posting-rules.ts`; `fact-drafts.ts` is the one fact→draft mapping; `projector.ts`
enumerates 13 source types (`PROJECTED_SOURCE_TYPES`); `period-close.ts` runs ~20
checks then `recognizeRevenueForPeriod` then snapshots statements; `statements.ts`
computes P&L / balance sheet / trial balance / cash flow / cash basis live from
posted lines; `rebuild.ts` is the nightly drill; `verifier.ts` runs 11 tie-outs.
Chart template in `chart-of-accounts.ts` (43 accounts, `SYSTEM_ACCOUNT_CODES`).
`journal_lines` carry `project_id`, `company_id`, and an **unused** `dimensions`
jsonb. UI: `app/(app)/books/*` (10 sections), `app/(app)/books/books-client.tsx`
(2,231 lines, switches on section), `components/books/*` (15 files).
Tests: `tests/arc-books.test.js` — 87 pass. pgTAP: `supabase/tests/books_*.test.sql`
— **never run against the applied production train** (no pgTAP in prod, no local
Docker at the time).

**Production.** 6 orgs. 2 have Books enabled, both `shadow` / `external` authority:
`Strata Construction LLC` (residential, real customer, 72 posted entries) and
`Arc QA — Commercial` (QA org). **Zero** `accounting_periods`, **zero**
`poc_snapshots`, **zero** `bank_accounts` / `bank_transactions` /
`bank_feed_connections`, zero opening-balance batches, zero cutover runs, zero
debt/fixed-asset/tax-jurisdiction rows. Strata's ledger: 2350 Contract liabilities
≈ $5,996,205.67 credit, 4000 Construction revenue $0.00, 1010 Undeposited funds
≈ $3,545,675.00 debit (nothing has ever cleared to bank), 2250 Sales tax payable
≈ $183,333.33 credit. Every disbursement in the whole database credits `1000`.

**The nightly rebuild drill fails on the QA org** (22 of 24 runs `failed`). Its
`differences` hold six `missing_journal` findings — every one a fact that was
**superseded** by a later revision and whose entry is correctly `reversed` — plus
one `journal_divergence` where `payment_reversal` (invoice side) was posted to
`1000` and the rule now says `1010`. Both are in Phase D.

**Open reconciliation findings** are accumulating unread: Strata 11 (incl. 4
`connection_unhealthy`, 3 tie-out failures), QA 8, Patagonia 23.

**Migration ledger** does not match the repository (see
`migration-ledger-reconciliation.md`). Among the 11 genuinely unapplied files,
`20260829120000_billing_lifecycle_and_command_permissions` still lets `saved`
invoices exist, which the projector excludes — six live invoices carry it.

**Doctrine unchanged:** money is integer cents; every query org-scoped; services own
logic; migrations additive, written to `supabase/migrations/`, **never applied by the
executor**; no `qbo_*` columns ever; no posture baked into a table or service name
(`housing_inventory`, not `production_inventory`); posture routes only through
`getProjectPosture()` / `resolveRevenueRecognitionBasis()`.

### 0.2 What 10/10 means (the acceptance for the whole plan)

A builder in each posture runs their company on Arc Books as the **official** ledger,
with the external system disconnected or reduced to a monthly summary mirror, and:

1. Their construction CPA has signed the entry set for their posture (F, G).
2. Twelve consecutive monthly closes completed inside Arc, each with every blocking
   gate green and the rebuild drill green the morning after (D).
3. Every bank and card account reconciles to the statement inside Arc with no
   manual recategorization of ordinary payments (E).
4. Payroll clearing reaches zero every pay period (E.3).
5. Revenue is right for every billing model they use, losses are provided for, and
   the balance sheet presents contract assets and liabilities separately (F).
6. A production org's balance sheet carries land, lots, development, housing
   inventory, finished specs, and warranty reserve, and each closing relieves the
   right cost (G).
7. Statements come by project, community, division, and cost type; the P&L drills
   to the source document; cash basis and 1099s are filing-grade through a partner
   (I, J).
8. The workspace has ≤ 6 sections, one health view, and every view ships empty,
   loading, error, and dark (K).
9. QuickBooks is one adapter behind the provider interface with no `qbo_*` columns
   left, and the file tier serves the desktop/Sage/Foundation long tail (L).

Score mapping: D alone → 6. D+E+F → 8 residential/commercial. D+E+F+G → 8
production. I+J+K → 9. L and twelve closes on a real org → 10.

---

## Reading the directives

Each directive has **What / Where / How / Accept / Tests**, and some have **STOP**.
"Accept" is the acceptance test the executor must actually run, not a hope. Any
directive that needs a migration writes it and STOPs; code may continue against the
planned schema, stated plainly. Every phase ends with `pnpm lint && npx tsc --noEmit`
silent (tsc needs `NODE_OPTIONS=--max-old-space-size=8192`) and `pnpm test:financials`.

## Definition of done — applies to EVERY directive

A directive is done only when every box below is ticked **with evidence** (a
command output, a row read back, a screenshot path, a test name). Ticking a box
without evidence is the failure mode this section exists to stop. Copy this list
under the directive in this file when you start it, tick as you go, and leave it
there struck through when done.

```
- [ ] Searched first: no existing service/helper/component already does this
      (`grep` result named in the record).
- [ ] Exemplar mirrored: file layout, naming, error handling copied from the
      nearest sibling (exemplar path named).
- [ ] Business logic lives in `lib/services/books/*`; pages and actions stay thin;
      money rules are PURE (no I/O) and sit beside `posting-rules.ts` or
      `*-rules.ts`.
- [ ] Every query org-scoped; every paged read totally ordered
      (`.order(col).order("id")`); no unbounded select on a Books table.
- [ ] Money is integer cents end to end; `assertIntegerCents` on every rule input.
- [ ] New posting rule: balanced by `complete()`, posting key through
      `buildPostingKey`, source type added to `PROJECTED_SOURCE_TYPES`, economic
      keys added to `ECONOMIC_KEYS_BY_SOURCE`, retirement handled, and a golden
      posting test in `tests/arc-books.test.js`.
- [ ] Changed posting rule: `CURRENT_PROJECTION_VERSION` bumped, changelog entry
      written, re-projection run on every Books org (D.2 mechanism), rebuild
      drill `passed` afterwards (run id recorded).
- [ ] Migration (if any): written to `supabase/migrations/YYYYMMDDHHMMSS_name.sql`,
      additive, RLS policies with `(select auth.uid())`, indexes on `(org_id, …)`
      and every FK, `updated_at` trigger, RBAC catalog seed if a permission is
      new, **STOPped and not applied by the executor** (STOP recorded).
- [ ] New entity: registration checklist in `CLAUDE.md` complete (RLS, RBAC,
      search index, events, email allowlist, cron registry as applicable).
- [ ] Mutation: `requireOrgContext` → `requirePermission` → logic →
      `recordEvent` + `recordAudit` → `{ success, error }` / `ActionResult`.
- [ ] Zod-validated action input in `lib/validation/`.
- [ ] Close gate (if any): code added to `TIE_OUT_ITEM_CATEGORIES` pairing test
      passes; cure `href` points at the surface that fixes it; capped scans
      report `scan_capped`.
- [ ] UI (if any): empty, loading (skeleton), error, and dark mode present and
      viewed in a browser (screenshot paths recorded); tokens only; no new file
      added to the lint grandfather list; truncation visible when a cap hits.
- [ ] Tests: the directive's named test(s) exist and pass; `pnpm test:financials`
      passes; pgTAP added when a DB function or constraint changed.
- [ ] `pnpm lint` silent and `npx tsc --noEmit` clean (both outputs recorded).
- [ ] The **Accept** line of the directive was executed literally and its
      observed result written under the directive (numbers, not adjectives).
- [ ] Anything this directive obsoleted is DELETED in the same change (old
      route, component, helper, flag, doc paragraph) — list what was removed.
- [ ] Docs: reference docs updated if behavior changed (`docs/` top level,
      `CLAUDE.md` deep-dive bullet if it is a sharp edge); this plan's directive
      struck through with date and a one-line "what was built and why".
```

Phase exit checklists below are in addition to this list, not instead of it. A
phase is complete when every directive is struck through **and** every box in its
exit checklist is ticked with evidence.

---

# Phase D — Operate what exists: one real close

**Standalone value:** the ledger is proven on a real org, the CPA can sign, and the
release gates close. Nothing below D is credible until D is green.

### D.1 — The rebuild drill must skip superseded facts
**What.** `lib/services/books/rebuild.ts` filters retired facts
(`isRetiredFactKind`) but not superseded ones, so a correctly reversed-and-replaced
fact reads as `missing_journal` every night.
**Where.** `rebuild.ts` (page loop at ~line 55), `accounting_facts.supersedes_fact_id`.
**How.** Before drafting, load the set of fact ids that appear as
`supersedes_fact_id` on any later fact for the org (paged, ordered, org-scoped).
Skip those facts the same way retired facts are skipped, counting them in a new
`superseded_fact_count` on `ledger_rebuild_runs` (**migration**: add the column,
additive). Do not change the `journal_entries.status = 'posted'` filter — a
superseded fact's entry is `reversed` by design.
**Accept.** The QA org's next `books-maintenance` run records `passed` with
`superseded_fact_count = 6`. Run it via `/api/jobs/books-maintenance` (GET) or
`runLedgerRebuildAction`. Read the row; do not trust a green cron.
**Tests.** `tests/arc-books.test.js`: "the rebuild drill treats a superseded fact as
answered, not missing" — feed a fact chain (v1 superseded by v2) and assert zero
differences.

### D.2 — Bump the projection version for the reversal-rule change
**What.** `postPaymentReversal` moved the invoice-side cash account from `1000` to
`1010` after entries were posted under projection v1. The rebuild drill correctly
reports a divergence. The fix is the mechanism the schema was built for.
**Where.** `accounting_policies` (approved version drives `resolveProjectionVersion`
in `projector.ts`), `posting-rules.ts`.
**How.** Add `lib/services/books/projection-versions.ts` exporting
`CURRENT_PROJECTION_VERSION = 2` and a changelog array
`{ version, date, summary }`. `resolveProjectionVersion` must refuse to run when the
org's approved policy version is below `CURRENT_PROJECTION_VERSION` unless a
re-projection has been run for it: add `reprojectOrg(orgId, toVersion)` in
`projector.ts` that reverses every posted entry under the old version and reposts
under the new one in one pass (idempotent on posting key; use the existing
supersede/reverse machinery). Approve policy v2 for both shadow orgs through a
new `approveProjectionVersionAction` (books.manage).
**Accept.** QA org: rebuild `passed`; Strata: rebuild `passed`; every posted entry
carries `projection_version = 2`; trial balance before and after re-projection is
identical to the cent except the one `1000`→`1010` line.
**Tests.** "changing a posting rule bumps the projection version and re-projection
reproduces the ledger under it".
**STOP** before running `reprojectOrg` on Strata (a customer org, shadow mode, no
external effect — but a human watches).

### D.3 — POC snapshots are captured automatically
**What.** `poc_snapshots` has zero rows in production. `recognizeRevenueForPeriod`
answers a historical period only from snapshots; the close gate `poc_snapshots`
blocks without them. `captureProjectPocSnapshot` (`lib/services/poc.ts`) exists;
find its callers and confirm nothing captures on a schedule.
**Where.** `app/api/jobs/books-maintenance/route.ts`, `lib/services/poc.ts`,
`period-close.ts` (`poc_snapshots` check).
**How.** `books-maintenance` captures a snapshot for every POC project in every
Books-enabled org on the **last calendar day of each month** (UTC), and on demand
from the close page ("Capture period-end position") when the period end is today or
in the future. A snapshot for a period end in the past must never be fabricated from
live data — that is the defect the service already refuses. Surface "no snapshot at
period end" on the close page with the cure ("reopen the period end date" is not a
cure; the cure is to close on time or import a WIP schedule as of that date via
opening balances).
**Accept.** After the next month end, `poc_snapshots` holds one row per POC project
per Books org; the close checklist `poc_snapshots` gate passes.
**Tests.** Pure: "month-end snapshot capture selects exactly the last day".

### D.4 — Close one real month on Strata in shadow mode
**What.** No period has ever been closed. Do it on the real org, in shadow, where it
has no external effect.
**Where.** `/books/close`, `createAccountingPeriodAction`, `runCloseChecklistAction`,
`closeAccountingPeriodAction`.
**How.** Write `docs/plans/arc-books-first-close-runbook.md` (temporary, delete when
D closes) with the exact click path and the expected value of every gate. Execute
it for the most recent completed month. For every red gate, decide: cure in data
(customer coding), cure in code (this plan), or accept difference through
`resolveReconciliationItemAction` with a written reason. Record the outcome table
in the runbook. **Expect** `accounting_drift` to be red on `connection_unhealthy`
findings — see K.4 for why that gate is wrong for Arc-authoritative orgs; for D.4,
accept them with a reason.
**Accept.** One `accounting_periods` row `closed` for Strata with `close_digest`
set; `financial_statement_snapshots` row present; revenue recognition posted
(`journal_entries.source_type = 'revenue_recognition'` rows exist); trial balance
balances; the next morning's rebuild drill is `passed`.
**STOP** before `closeAccountingPeriodAction` on Strata.

### D.5 — Extend and send the CPA package
**What.** `docs/books-revenue-recognition.md` is unsigned. Extend it before sending
so it is signed once.
**How.** Add sections for: cash-basis conversion (C4.3), cost-plus / T&M / GMP
recognition (F.1 design, written as proposed entries), loss provision (F.2),
contract-asset reclass (F.3, as the proposed answer to §6b), and the production
inventory entry set (G.3, as proposed). Mark each as "implemented" or "proposed"
truthfully. Send.
**Accept.** A signed §7, or a marked-up package with required changes recorded as
directives in F/G.
**STOP:** the signature is the human's to obtain.

### D.6 — Close the release gates in `arc-books-sole-ledger-release.md`
**What.** The mandatory activation gates were never run.
**How.**
1. Run `supabase/scripts/repair-migration-ledger.sql` and apply the 11 pending
   migrations with the CLI, per `migration-ledger-reconciliation.md`. **STOP** at
   each apply.
2. Spin up an isolated database (Supabase branch or local Docker), replay the full
   migration train, run every pgTAP suite in `supabase/tests/`. Fix what fails.
   Record results in the release doc.
3. Run `get_advisors` (security + performance) and clear every finding on a Books
   table or RPC.
4. Seed a representative builder in the QA org and exercise: invoice → receipt →
   grouped bank deposit; bill → approval → payment → bank match; deposit →
   application → refund; loan; fixed asset lifecycle; use tax; maker-checker journal;
   close/reopen; year-end. Extend `scripts/seed-books-qa-org.js`.
5. Create a complete export, restore it into an isolated org, verify checksums, run
   the rebuild drill, confirm Vault identities readable.
6. Confirm `CRON_SECRET`, Plaid webhook verification, backups/PITR, incident owner.
**Accept.** Every gate in the release doc has a dated, named evidence line.

### D.7 — Definition-of-done sweep on every Books view
**What.** `app/(app)/books/` has `error.tsx` and no `loading.tsx`; empty states
exist in 3 of 16 components; dark mode and real rendering were reviewed once, on
statements and journals only.
**How.** Add `loading.tsx` per section with a skeleton matching the real layout. Add
an empty state to every list (journal entries, chart, bank register, registers,
deposits, tax register, proposals, recurring templates). Review every section in a
browser in light and dark with the QA org seeded (D.6.4), and with an empty org.
Fix what is wrong. Record a screenshot manifest in the runbook.
**Accept.** A reviewer opens every section in both themes with data and without and
finds nothing broken. `pnpm lint:tokens` adds no new grandfathered file.

**Phase D gate:** one real close, drill green, CPA package sent, release gates
evidenced. Score → 6.

### Phase D exit checklist
```
- [ ] `ledger_rebuild_runs` latest row is `passed` for EVERY Books-enabled org
      (org ids + run ids recorded), and has been `passed` on 7 consecutive
      nightly runs.
- [ ] Every posted `journal_entries` row in every Books org carries
      `projection_version = CURRENT_PROJECTION_VERSION` (count query recorded).
- [ ] `poc_snapshots` holds one row per POC project per Books org for the most
      recent month end (count query recorded).
- [ ] One `accounting_periods` row `closed` on Strata with `close_digest`,
      a `financial_statement_snapshots` row, and ≥1 `revenue_recognition` entry
      (ids recorded); trial balance debits = credits; balance sheet difference 0.
- [ ] Every red gate from the first close has a recorded disposition
      (cured-in-data / cured-in-code with directive id / accepted with reason).
- [ ] `docs/books-revenue-recognition.md` extended (cash basis, F.1, F.2, F.3,
      G.0) and SENT; §7 signed OR mark-ups recorded as directives.
- [ ] Migration ledger repaired: `pnpm db:ledger:check` passes against
      production; the 11 pending migrations applied via CLI (each STOP recorded).
- [ ] Full migration train replayed on an isolated DB; every `supabase/tests/*.sql`
      pgTAP suite passes (output recorded).
- [ ] `get_advisors` security + performance: zero findings on Books tables/RPCs.
- [ ] QA org seeded through the full D.6.4 lifecycle; every step's resulting
      entries listed with amounts.
- [ ] Export → restore into isolated org → checksum verify → rebuild drill
      `passed` → Vault identity readable (evidence for each).
- [ ] `CRON_SECRET` set; Plaid webhook verification proven with one real webhook;
      backups/PITR confirmed; incident owner named in the release doc.
- [ ] Every Books section has `loading.tsx`, an empty state, error boundary,
      and was screenshotted in light + dark with data and empty (manifest path).
- [ ] `tests/arc-books.test.js` count increased by ≥3 (D.1, D.2, D.3 tests named).
- [ ] `docs/plans/arc-books-first-close-runbook.md` deleted, its outcome table
      folded into `arc-books-sole-ledger-release.md`.
```

---

# Phase E — Cash and payroll truth

**Standalone value:** the bank reconciliation works without recategorizing ordinary
payments, and payroll clearing reaches zero. These are the two things a bookkeeper
tests in the first hour.

### E.1 — Disbursements credit the bank account that paid
**What.** Every bill payment, expense, fee, and reversal credits `1000`. Bank accounts
map to their own GL accounts (`bank_accounts.gl_account_id`) but the projector never
looks at where money came from.
**Where.** `projector.ts` (payment, fee, expense, reversal candidates), `fact-drafts.ts`
(`ECONOMIC_KEYS_BY_SOURCE`, drafts), `posting-rules.ts` (`cashAccountCode` inputs
already exist), `payment_runs.funding_source_id` → `org_funding_sources`,
`payments`, `project_expenses.payment_method`.
**How.**
1. **Migration**: `org_funding_sources.bank_account_id uuid references bank_accounts`
   (nullable, additive); `project_expenses.bank_account_id uuid` (nullable);
   `payments.bank_account_id uuid` (nullable) for manual/external payments.
   Indexes on each. STOP.
2. The Settings → Vendor payments rail setup and manual-payment forms select the
   bank account; the bank account picker reuses `components/books/*` account
   selectors. When a funding source has no bank account, the payment posts to the
   org's **default operating account** (new `books_settings.default_cash_account_id`,
   defaulting to the `1000` account) and the close gate `clearing_accounts` names it.
3. Resolve the cash GL code at fact time (the bank account's `gl_accounts.code`) and
   add `cash_account_code` to the economic key allowlist for `bill_payment`,
   `ap_fee_charge`, `expense`, `payment_reversal`, and `invoice_payment` (deposits
   still land in `1010` unless the receipt is a direct bank credit).
4. Bank feed matching (`bank-match-rules.ts`) already restricts to the account's
   GL; nothing to change there.
**Accept.** Seed two bank accounts in the QA org, pay one run from each; the cash
credits land on two different GL accounts; each bank tray shows only its own lines.
**Tests.** "a disbursement credits the account that funded it, and an unmapped
funding source falls back to the default operating account and is flagged".

### E.2 — Card spend is a liability, not cash
**What.** A company-card expense credits cash. It should credit `2100` (or the card's
own liability account) and the card statement payment relieves it.
**Where.** `project_expenses.payment_method` (text column, exists; verify its value
set in `lib/validation/` before matching on `card`), `vendor_bills.payment_method`,
`bank_accounts` with `subtype = 'credit_card'` (already supported by the feed),
`postExpense` / `postExpenseFromCostLines` (`paymentAccountCode`).
**How.** When `payment_method = 'card'`, the payment account is the selected card
account's GL (E.1's `bank_account_id`), else `2100`. A bank-tray categorization of
the card payment posts Dr card liability / Cr operating cash (the tray already posts
Dr category / Cr bank; make "pay down a liability account" a first-class category
with the liability account as the debit).
**Accept.** Card expense → `2100` credit; card payment from the feed → `2100` debit /
bank credit; the card's own reconciliation closes at zero.
**Tests.** Golden postings for both entries.

### E.3 — Payroll clearing has an exit
**What.** `postLaborCost` credits `2200 Payroll clearing` from burdened time entries.
Nothing relieves 2200 except an ad-hoc bank categorization; there is no true-up.
**Where.** New `lib/services/books/payroll-journals.ts`; `posting-rules.ts`;
`books_settings`; `components/books/`.
**How.**
1. **Migration**: `payroll_journals (org_id, pay_period_start, pay_period_end,
   paid_on, source ('csv'|'manual'|provider key), gross_wages_cents,
   employer_taxes_cents, benefits_cents, net_pay_cents, status, imported_by,
   journal_entry_id, metadata)` + `payroll_journal_lines (payroll_journal_id,
   project_id null, kind ('wages'|'employer_tax'|'benefit'|'workers_comp'|'net_pay'|
   'withholding'), amount_cents, gl_account_id)`. RLS, indexes, updated_at trigger,
   RBAC key `books.payroll` (granted to org_admin, org_accountant, bookkeeper).
   STOP.
2. Posting rule `postPayrollJournal`: Dr 6070 Payroll expense (overhead portion) and
   Dr 5030 Direct labor (project-coded portion) / Dr employer tax & benefits
   accounts; Cr 2200 for the amount already accrued from time entries for the pay
   period (relief); Cr net pay to the bank account (E.1); Cr withholding liabilities
   (new 2210 Payroll liabilities, system account). The **true-up** is the difference
   between accrued labor (sum of `labor_cost` facts in the period) and actual
   wages+burden: post it to 5030/6070 so 2200 nets to zero per pay period.
3. Import: CSV/TSV first (Gusto, ADP, Paychex, QuickBooks Payroll all export a
   journal summary); provider adapters are Phase L scope, not here.
4. Close gate: `payroll_clearing` — 2200 balance at period end must be zero, or
   the period's payroll journal is missing. Blocking.
**Accept.** QA org: time entries accrue to 2200; a payroll journal import relieves
it to exactly zero with the true-up visible as its own line.
**Tests.** "payroll clearing relief nets the accrual to zero and books the burden
true-up where the labor was coded".

### E.4 — Bank feeds exercised end to end on a real account
**What.** Plaid code is production-shaped and has never seen a transaction.
**How.** Connect a real (or Plaid sandbox with production-like data) account on the
QA org through `createPlaidLinkTokenAction`; run `bank-feed-sync`; drive the tray:
confident bulk match, manual match, categorize-and-learn, exclude, statement close.
Also import a real bank CSV through `manual-bank-import.tsx`. Fix what breaks.
Verify the webhook path with a Plaid `TRANSACTIONS` webhook.
**Accept.** ≥ 200 real transactions ingested; ≥ 90% matched or categorized by rule
after two weeks; one bank reconciliation closed at zero difference.

### E.5 — Undeposited funds clears on settlement automatically
**What.** Strata holds ~$3.5M in `1010` because nothing has ever moved it to bank.
**Where.** `deposit-batches.ts`, `bank-reconciliation.ts`, `payment-payouts.ts`
(Arc Pay payouts know their settlement).
**How.** When an Arc Pay payout settles, create the deposit batch and post Dr bank
/ Cr 1010 automatically (source `payout_settlement`, a new projected source type
with its own economic key allowlist). For checks and external receipts, the bank
tray offers "deposit of undeposited funds" that groups receipts to the bank credit.
**Accept.** After E.4, Strata's `1010` balance equals only receipts not yet at the
bank; close gate `clearing_accounts` passes.

**Phase E gate:** a full bank cycle and a full payroll cycle reconcile in Arc with no
manual GL recategorization. Score → 7.

### Phase E exit checklist
```
- [ ] Migrations written + STOPped: `org_funding_sources.bank_account_id`,
      `project_expenses.bank_account_id`, `payments.bank_account_id`,
      `books_settings.default_cash_account_id`, `payroll_journals` +
      `payroll_journal_lines`, RBAC key `books.payroll` (file names recorded).
- [ ] QA org has ≥2 bank accounts + 1 card account, each mapped to its own GL
      account; a payment run from each lands on its own GL (entry ids recorded).
- [ ] Zero `1000` credits from a payment whose funding source names another
      bank account (query recorded); unmapped funding sources appear in the
      `clearing_accounts` close gate evidence.
- [ ] Card expense → `2100`/card GL credit; card payment from feed → `2100`
      debit; the card account's reconciliation closes with `difference_cents = 0`.
- [ ] One pay period: `labor_cost` accruals to 2200, payroll journal imported
      from a real provider CSV, 2200 balance at period end = 0, true-up line
      visible on the entry (amounts recorded).
- [ ] Close gate `payroll_clearing` exists, blocks when 2200 ≠ 0, and pairs in
      `TIE_OUT_ITEM_CATEGORIES`.
- [ ] Plaid: ≥200 real/sandbox transactions ingested, ≥90% matched or
      rule-categorized after two weeks (tray counts recorded), one bank
      reconciliation `closed` at zero, one manual CSV import succeeded.
- [ ] Arc Pay payout settlement auto-creates the deposit batch and posts
      Dr bank / Cr 1010 (`payout_settlement` source type registered, retirement
      handled, golden test named).
- [ ] Strata's `1010` balance equals receipts not yet at the bank (list of
      remaining receipts recorded); `clearing_accounts` gate passes.
- [ ] Bank match rules, cash-flow allocation, and cash-basis conversion still
      pass every existing test after the cash-account change.
```

---

# Phase F — Revenue model completeness

**Standalone value:** revenue is right for every contract type Arc supports, losses
are provided for, and the balance sheet presents by GAAP. This is what the CPA signs.

### F.1 — Cost-plus, T&M, and GMP recognize revenue
**What.** Recognition is cost-to-cost against contract value only. A cost-plus
project with no contract value is skipped (`missing_contract_value`) and stays in
`2350` forever. Most custom-home builders are cost-plus.
**Where.** `lib/financials/poc-rules.ts`, `lib/financials/poc-inputs.ts`,
`lib/financials/billing-model.ts` (`cost_plus_percent`, `cost_plus_fixed_fee`,
`cost_plus_gmp`, `time_and_materials`), `revenue-basis.ts`, `revenue-recognition.ts`.
**How.** Extend `RevenueRecognitionBasis` to
`percentage_of_completion | cost_plus | time_and_materials | closing`, resolved
from the project's billing model through the one choke point
`resolveRevenueRecognitionBasis()`. Earned revenue:
- `cost_plus_percent`: cost to date × (1 + fee %).
- `cost_plus_fixed_fee`: cost to date + fee × (cost to date ÷ EAC), fee capped.
- `cost_plus_gmp`: as cost-plus, capped at GMP; above GMP the excess is a loss (F.2).
- `time_and_materials`: billable time and materials at contract rates
  (`job_cost_entries.is_billable`), earned when incurred.
Keep the math pure in `poc-rules.ts` next to POC and test it. Recognition still
posts Dr 2350 / Cr 4000 as today; the basis changes only the earned figure. The WIP
report (`reports/wip-over-under.ts`) uses the same function so the schedule and the
ledger cannot disagree.
**Accept.** QA org: one project per basis; each recognizes the hand-computed
amount; the WIP report's earned column equals the ledger's 4000 by project.
**Tests.** One golden case per basis; "the WIP schedule and the ledger use one
earned-revenue function".

### F.2 — Anticipated losses are provided for
**What.** When EAC exceeds contract value (or GMP), GAAP requires the full expected
loss immediately. Nothing computes it.
**How.** Add system accounts `2360 Provision for contract losses` (liability) and
`5090 Provision for losses on contracts` (cogs). At recognition, for each project
where `EAC − contract > 0`, post the change in the required provision
(`postLossProvision`, cumulative-to-date like recognition, negative deltas reverse).
Report it on the WIP schedule as its own column.
**Accept.** A project revised into a loss provides the full loss in the period of
revision; a later favorable revision releases it.
**Tests.** Golden case; reversal case; a project returning to profit clears to zero.

### F.3 — Contract assets reclassify at period end
**What.** Costs-in-excess sits as a debit inside `2350`. ASC 606-10-45 requires
separate presentation across contracts. `1150` is seeded and never posted.
**How.** At close, after recognition, for each project with a debit balance in 2350
post `Dr 1150 / Cr 2350` for that balance, dated period end, `entry_kind = 'poc'`,
and an **auto-reversing** entry on the first day of the next period (the schema's
reversal machinery). Balance sheet shows 1150 and 2350 as separate lines. This is
the proposed answer to §6b of the CPA package; implement behind the signature or as
the package's default if the CPA marks it approved.
**Accept.** Balance sheet at a close shows contract assets and liabilities
separately; the sum equals the net position on the WIP schedule.
**STOP** if the CPA rejects the treatment.

### F.4 — Retainage release timing is a policy
**What.** AR retainage release posts on issue; the CPA package asks whether it should
post on payment.
**How.** `accounting_policies` gains `retainage_release_timing ('issue'|'payment')`;
the projector reads it. Default per the CPA's answer.
**Accept.** Both timings reproduce the QA lifecycle correctly.

### F.5 — Revenue basis is visible and editable on the project
**What.** The basis is inferred; a PM cannot see or override it.
**How.** Project financial settings (billing setup step in the project sheet) show
the resolved basis with the reason, and allow an override
(`project_financial_settings.revenue_recognition_basis`, nullable) that only
`books.manage` may set. The financials tab shows **earned revenue** and
**recognized to date** beside billed-to-date.
**Accept.** A PM sees earned vs billed on the project; an accountant can override
the basis with an audit reason.

**Phase F gate:** CPA-signed entry set for residential and commercial. Score → 8 for
those postures.

### Phase F exit checklist
```
- [ ] `RevenueRecognitionBasis` has exactly
      `percentage_of_completion | cost_plus | time_and_materials | closing` and
      ONE resolver (`resolveRevenueRecognitionBasis`); grep shows no inline
      billing-model branching in Books (grep output recorded).
- [ ] Earned-revenue math is pure in `poc-rules.ts`, imported by BOTH
      `revenue-recognition.ts` and `reports/wip-over-under.ts`; a test asserts
      the two cannot diverge.
- [ ] QA org: one project per basis; recognized amount equals the hand-computed
      figure in the test AND in the ledger (project ids + amounts recorded).
- [ ] Zero projects skipped with `missing_contract_value` on a cost-plus or T&M
      basis (recognition result recorded).
- [ ] Loss provision: accounts 2360/5090 seeded (system, subtypes in the CHECK
      and `GL_ACCOUNT_SUBTYPES`, three-declaration test extended); a revised
      loss project provides the full loss; a favorable revision releases it;
      WIP schedule shows the provision column.
- [ ] Contract-asset reclass posts at close and auto-reverses on day one of the
      next period; balance sheet shows 1150 and 2350 separately; their net
      equals the WIP schedule's net over/under to the cent (numbers recorded).
- [ ] `accounting_policies.retainage_release_timing` exists; both values
      reproduce the QA lifecycle; default matches the CPA's answer (cited).
- [ ] Project financials tab shows basis, earned, recognized-to-date, billed;
      override requires `books.manage` and writes an audit row.
- [ ] CPA package §7 signed for the residential and commercial entry sets, or
      every mark-up converted into a struck-through directive here.
- [ ] Every F posting rule change ran under a bumped projection version;
      rebuild drill `passed` on every Books org afterwards.
```

---

# Phase G — Production posture: the inventory model

**Standalone value:** a production builder's balance sheet and closings are right.
Without G, production is disqualified regardless of everything else.

**Design (agree before building — STOP at G.0):** closing-basis projects capitalize
cost into inventory and relieve it at closing. Land and development are inventory.
This is the standard homebuilder model (ASC 970). Names are domain names, never
posture names.

### G.0 — Entry set for CPA review (write first)
Write §8 of `docs/books-revenue-recognition.md`: the production entry set below,
with a worked example (one community, ten lots, one closing). STOP and send with D.5
if not yet sent.

Accounts (system, seeded by `initializeArcBooks`, added by migration to existing
charts):
```
1300 Land and lots                 asset   subtype land_inventory
1310 Land development              asset   subtype development_inventory
1320 Housing inventory (WIP)       asset   subtype housing_inventory
1330 Finished homes                asset   subtype finished_homes_inventory
1340 Model homes                   asset   subtype model_homes
1350 Capitalized interest          asset   subtype capitalized_interest   (policy-gated)
2600 Warranty reserve              liab    subtype warranty_reserve
2610 Accrued commissions           liab    subtype accrued_commissions
4010 Home sales revenue            income  subtype home_sales_revenue
4020 Lot premiums and options      income  subtype option_revenue
5100 Cost of homes sold            cogs    subtype cost_of_homes_sold
5110 Lot cost of sales             cogs    subtype lot_cost_of_sales
5120 Warranty provision            cogs    subtype warranty_provision
5130 Sales commissions             expense subtype commissions
```
Entries:
```
Lot takedown / acquisition       Dr 1300            Cr 2000 / cash
Development cost (community)     Dr 1310            Cr 2000
Job cost on closing-basis lot    Dr 1320 (lot)      Cr 2000 / 2010 / 2200
Home complete (spec)             Dr 1330  Cr 1320   (optional; policy)
Closing — revenue                Dr 1100 / cash     Cr 4010, 4020, 2250
Closing — cost relief            Dr 5100  Cr 1320/1330  (house cost)
                                 Dr 5110  Cr 1300       (lot basis)
                                 Dr 5110  Cr 1310       (allocated development)
Closing — warranty reserve       Dr 5120  Cr 2600       (policy % of revenue or per-unit)
Closing — commissions            Dr 5130  Cr 2610
Warranty work performed          Dr 2600  Cr 2000       (not 5050, when reserve exists)
```

### G.1 — Chart, subtypes, and close subtypes
**Migration** adds the subtypes to the `gl_accounts.subtype` CHECK and the accounts
to `CONSTRUCTION_CHART_TEMPLATE` / `GL_ACCOUNT_SUBTYPES` (the test binding the three
declarations together must be extended). Seed into existing orgs' charts via
`initializeArcBooks` idempotently. STOP.

### G.2 — Closing-basis job cost capitalizes
**Where.** `fact-drafts.ts` (vendor bill, expense, labor drafts), `posting-rules.ts`.
**How.** The vendor-bill/expense/labor fact payload already carries `project_id`;
add `revenue_basis` to their economic keys (it is already on `invoice`). When the
basis is `closing`, cost lines debit `1320` (with the lot's project as dimension)
instead of `5000`-family accounts; the line's chosen GL account, if COGS, is
recorded in `dimensions.cost_account_code` so relief at closing can post to the
right COGS sub-account. Land and development bills: `vendor_bills` and
`project_expenses` have **no community scope today** (verified 2026-09-03; a
community has no project, and `vendor_bills.project_id` only becomes optional with
the still-pending `20260827121000_project_optional_vendor_bills`). **Migration**:
add nullable `community_id` (and `community_phase_id`) to both tables with
indexes and a check that a bill carries a project or a community, never neither;
the payable workspace offers the community picker when no project is chosen. A
community-coded bill debits `1310`. A lot takedown (`lot_takedowns`:
`price_per_lot_cents × lot_count`, `seller_company_id`) posts `Dr 1300 / Cr 2000`
on its `actual_date` and sets each lot's `lots.cost_basis_cents`; the takedown
deposit (`deposit_cents`) posts to `1200 Prepaid` until applied.
**Accept.** A closing-basis project's costs never touch `5xxx` before closing; the
job-cost subledger still ties (the tie-out compares subledger to `1320`+`5100` for
those projects — extend `verifier.ts` `job_cost_control` to route by basis).
**Tests.** Golden postings; tie-out routing by basis.

### G.3 — The closing entry set posts from `closings`
**Where.** `lib/services/closings.ts`, `closings` table (`status`, `actual_date`,
`settlement`, `closing_invoice_id`), new projected source `closing`.
**How.** When a closing reaches its closed status, project one `closing` fact with:
sale price split (base, premium, options from the purchase agreement), house cost
(sum of the lot project's capitalized cost), lot basis, allocated development cost
(G.4), warranty reserve (policy), commissions (policy or from the closing record).
`postHomeClosing` emits the entries in G.0 as one balanced journal. The existing
`postClosingInvoice` (revenue on the closing invoice) is **replaced** by this rule
for closing-basis projects — do not keep both.
**Accept.** One QA closing produces the full entry set; gross margin on the P&L
equals the closing statement's margin; inventory for that lot goes to zero.
**Tests.** "a closing relieves house, lot, and development cost and books warranty
and commissions in one entry".

### G.4 — Development cost allocation across lots
**How.** `accounting_policies` gains `development_allocation_method
('lot_count'|'lot_sqft'|'lot_frontage'|'relative_sales_value')`. Allocation is pure,
largest-remainder to the cent (copy `lib/services/books/…` use-tax allocation
pattern), computed per community at closing time over the lots not yet closed.
Re-allocation on a revised development budget is a cumulative-to-date delta like
recognition.
**Accept.** Sum of allocated development over all lots equals the community's 1310
to the cent; re-allocation after a budget revision moves only the delta.

### G.5 — Capitalized interest (policy-gated)
**How.** Off by default. When on, interest from the debt register on construction
loans attributed to a community (new `books_debt_instruments.community_id`) posts
Dr 1350 / Cr 6060 for the qualifying period and relieves at closing pro rata. Keep
simple: average accumulated expenditures × rate, monthly. STOP before enabling for
any org.

### G.6 — Warranty reserve consumption
**How.** Warranty service costs (`warranty-operations.ts` backcharges and vendor
bills coded to warranty) debit `2600` when a reserve exists for the community,
else `5050`. Close gate `warranty_reserve_control`: reserve balance ties to the
reserve schedule (units closed × policy − consumed).
**Accept.** Reserve ties; a warranty bill reduces the reserve, not the P&L.

### G.7 — Community and division dimensions on the ledger
**What.** `journal_lines.dimensions` is unused. Production needs community P&L and
balance sheet by community; commercial needs division.
**How.** At draft time, every line with a `project_id` gets
`dimensions.community_id` and `dimensions.division_id` from the project (and
`lot_id` when present). Statements gain `groupBy: 'project'|'community'|'division'`.
Land/development entries carry `community_id` directly. Add
`journal_lines (org_id, (dimensions->>'community_id'))` and division indexes.
**Accept.** Community P&L for the QA community equals the sum of its lot P&Ls plus
unallocated community cost.

### G.8 — Inventory tie-outs and the spec aging report
**How.** `verifier.ts` gains `land_inventory_control` (1300 ties to open lots'
basis), `development_inventory_control` (1310 ties to development budget actuals),
`housing_inventory_control` (1320+1330 ties to job-cost on unclosed closing-basis
projects). `reports/spec-inventory-aging` (exists) gains a carrying-value column
from 1320/1330 by lot. All three blocking at close for orgs with any
closing-basis project.

**Phase G gate:** a production QA community runs takedown → development → starts →
closings through two month-ends with every inventory tie-out green, and the CPA
signs §8. Score → 8 production.

### Phase G exit checklist
```
- [ ] G.0 entry set written as §8 of the CPA package with a worked example;
      STOP recorded; agreement or mark-ups recorded before G.2 began.
- [ ] Chart migration written + STOPped: 13 accounts, subtypes added to the
      CHECK, `GL_ACCOUNT_SUBTYPES`, and the template; three-declaration test
      extended; `initializeArcBooks` seeds them idempotently into existing
      charts (before/after `gl_accounts` count per org recorded).
- [ ] Community scoping migration written + STOPped: `community_id` +
      `community_phase_id` on `vendor_bills` and `project_expenses`, the
      project-or-community check, indexes; payable workspace offers the
      community picker only when no project is chosen (screenshot).
- [ ] Closing-basis job cost: zero `5xxx` lines dated before a project's
      closing on any closing-basis project in the QA org (query recorded);
      `job_cost_control` tie-out routes by basis and passes.
- [ ] Lot takedown posts Dr 1300 / Cr 2000 and sets `lots.cost_basis_cents`;
      takedown deposit sits in 1200 until applied (entry ids recorded).
- [ ] One QA closing produces the full G.0 entry set as ONE balanced journal;
      P&L gross margin for that lot equals the closing statement margin to the
      cent; the lot's 1320/1330 balance is 0 afterwards (numbers recorded).
- [ ] `postClosingInvoice` is DELETED (grep shows no caller, no definition).
- [ ] Development allocation: pure, largest-remainder; Σ allocated over all lots
      = community 1310 to the cent; a budget revision moves only the delta
      (test named, QA numbers recorded).
- [ ] Capitalized interest off by default; enabling it is `books.manage` +
      STOP; when on, monthly entry and closing relief are tested.
- [ ] Warranty bills debit 2600 when a reserve exists, else 5050;
      `warranty_reserve_control` ties (units closed × policy − consumed).
- [ ] Every job-cost line carries `dimensions.community_id`, `division_id`,
      and `lot_id` where the project has them (null-count query recorded);
      indexes on the jsonb keys exist; statements accept
      `groupBy: project|community|division`.
- [ ] Community P&L = Σ lot P&Ls + unallocated community cost (numbers recorded).
- [ ] `land_inventory_control`, `development_inventory_control`,
      `housing_inventory_control` exist, block at close for orgs with any
      closing-basis project, and pair in `TIE_OUT_ITEM_CATEGORIES`.
- [ ] Spec inventory aging report shows carrying value from 1320/1330 by lot
      and ties to the balance sheet.
- [ ] Two consecutive month-end closes on the production QA community with all
      inventory tie-outs green (period ids recorded).
- [ ] No table, column, service, or account name contains a posture word
      (`production_`, `commercial_`, `residential_`) — grep recorded.
```

---

# Phase H — Commercial posture completeness

### H.1 — Bonded WIP schedule
The surety format: contract, revised contract, est. cost, cost to date, % complete,
earned, billed, over/under, backlog, est. gross profit, and the loss provision (F.2)
column, for all open contracts plus contracts closed in the period. Add as a report
in the catalog with PDF; it reads the same functions as the ledger (F.1).

### H.2 — Equipment cost allocation
Owned-equipment internal charges: `equipment_rates` (org, equipment, rate per hour/
day) and equipment time on daily logs/time entries post Dr 5040 (project) /
Cr 6900-family equipment cost recovery (overhead contra). Only if the equipment
module exists — verify with `list_tables`; otherwise record as deferred with the
reason.

### H.3 — Retainage variability and joint checks
Pay apps with variable retainage (10% to 50% complete, 5% after; retainage on stored
materials) must post the actual withheld amount; verify `retainage.ts` handles it
and that `1110` ties. Joint-check payments (paid to sub and supplier jointly) post as
one AP relief with two payee dimensions; ensure the 1099 report attributes correctly.

### H.4 — Division dimension everywhere commercial reports
Statements by division (G.7), close checklist filterable by division for
division-scoped accountants (`division scope is the enforcement layer` per CLAUDE.md).

**Phase H gate:** a commercial QA org produces a bonded WIP schedule that ties to the
ledger to the cent.

### Phase H exit checklist
```
- [ ] Bonded WIP schedule in the report catalog with PDF; every column derives
      from the F.1 earned function and the ledger; totals tie to 4000, 2350,
      1150, 2360 to the cent (numbers recorded); backlog column present.
- [ ] Equipment: either `equipment_rates` + internal charge posting shipped
      with tests, OR a recorded deferral naming the missing module.
- [ ] Variable retainage pay app (10% → 5% after 50%, retainage on stored
      materials) posts the actual withheld amount; `1110` ties (test named).
- [ ] Joint-check payment relieves AP once, carries both payees in
      `dimensions`, and the 1099 report attributes the sub only.
- [ ] Division-scoped accountant sees only their division's close items and
      statements; a cross-division read is refused (auth test named).
```

---

# Phase I — Statements and reporting

### I.1 — Cost of revenue by cost type, automatically
`cost_codes.cost_type` (enum `public.cost_type` — verify values with `list_tables`)
maps to `5010/5020/5030/5040/5050` by a pure `costAccountForCostType()`; a line's
explicit GL pick still wins. Backfill by re-projection under a new projection
version (D.2 mechanism). P&L shows the split by default.

### I.2 — Comparatives
Prior period, prior year, and budget columns on P&L (overhead budgets from
`books_overhead_budgets` for non-project accounts; project budgets for job cost by
project). Variance column with color reporting state.

### I.3 — Group-by on every statement
Project, community, division (G.7). Balance sheet by community for production.

### I.4 — Drill to cost code
`dimensions.cost_code_id` on job-cost lines at draft time; the account register
groups by cost code and links to the job-cost detail report.

### I.5 — Statement snapshots as first-class documents
`financial_statement_snapshots` gets a viewer (as-of, immutable, PDF) and a
"compare to live" diff so a reopened period shows exactly what moved.

### I.6 — One health view
Bank reconciliation status, reconciliation spine findings, verifier tie-outs, and
the rebuild drill render in **one** list on `/books` overview, each row with cure
link and accept-difference. The four current surfaces are deleted.

### Phase I exit checklist
```
- [ ] `costAccountForCostType()` is pure, tested for every `public.cost_type`
      value (enum values recorded from `list_tables`); explicit line pick wins.
- [ ] Re-projection under a bumped version backfilled COGS split on every
      Books org; rebuild `passed`; P&L shows 5010–5050 by default (screenshot).
- [ ] P&L offers prior period, prior year, and budget columns with variance;
      overhead budget reads `books_overhead_budgets`, job budget reads project
      budgets; a test asserts variance = actual − budget per row.
- [ ] Every statement accepts `groupBy` project | community | division;
      balance sheet by community renders for the production QA org.
- [ ] Job-cost lines carry `dimensions.cost_code_id`; account register groups
      by cost code and links to job-cost detail (screenshot).
- [ ] Snapshot viewer: immutable as-of statements, PDF, and "compare to live"
      diff for a reopened period (screenshot of a non-empty diff).
- [ ] `/books` overview shows ONE findings list uniting bank reconciliation,
      spine, verifier, and rebuild; the four old surfaces are deleted (grep for
      their component names returns nothing).
- [ ] Every statement path still pages with a total order and caps visibly.
```

---

# Phase J — Tax and compliance to filing grade

### J.1 — 1099 filing partner
**STOP:** vendor decision (Tax1099, Track1099, Avalara 1099). Then: an adapter under
`lib/integrations/tax/` that reads Vault TINs through the service-only RPC and
files NEC/MISC; `vendor-1099.ts` becomes the pre-file review; filing evidence lands
in `books_tax_filings`. Never store a TIN outside Vault.

### J.2 — Sales and use tax filing workflow
Jurisdiction summary → return draft per jurisdiction → filed evidence →
`Dr 2250 / Cr cash` on payment (E.1 account). For builders in states that tax
contractors' materials rather than customers (Florida is the current customer base:
verify Strata's $183k in 2250 is real), the use-tax accrual is the primary path;
make the invoice-side tax opt-in per org.

### J.3 — Cash basis to filing grade
With the CPA: §448 eligibility note, book-to-tax depreciation (J.4), and the
AP/expense split (the one stated simplification) resolved by tagging payables
`overhead` vs `job` at coding time so cash paid splits without apportioning.

### J.4 — Tax depreciation
Fixed-asset register gains a tax method (MACRS tables, §179, bonus) alongside book
straight-line; year-end package exports both schedules.

### J.5 — Year-end package
One action produces: signed statements, trial balance, GL detail, AR/AP aging,
WIP schedule, cash-basis statement, fixed-asset and debt schedules, 1099 summary,
sales/use tax summary, and the export manifest, as one PDF bundle plus CSVs.

### Phase J exit checklist
```
- [ ] Filing-partner decision recorded (vendor, date, who decided); adapter
      lives under `lib/integrations/tax/`; TINs read only through the
      service-only Vault RPC (grep shows no TIN outside Vault paths).
- [ ] One test-mode 1099-NEC filed end to end; evidence row in
      `books_tax_filings`; `vendor-1099.ts` is the pre-file review and blocks
      vendors with missing W-9/TIN.
- [ ] Sales/use tax: jurisdiction summary → return draft → filed evidence →
      Dr 2250 / Cr bank on payment; invoice-side tax is opt-in per org;
      Strata's 2250 balance explained (real vs data error) and recorded.
- [ ] Cash basis: AP/expense split by `overhead|job` tag removes the stated
      simplification; §448 note and CPA review recorded in the package.
- [ ] Fixed assets carry book AND tax methods; year-end exports both schedules;
      MACRS table test passes for at least 5-, 7-, and 27.5-year classes.
- [ ] Year-end package is ONE action producing every listed artifact with a
      checksum manifest; restored bundle verifies (evidence recorded).
```

---

# Phase K — Product surface

### K.1 — Six sections
`Overview` (health, I.6) · `Transactions` (bank tray + registers + deposits) ·
`Ledger` (journals, proposals, recurring, chart) · `Close` (periods, checklist,
WIP capture) · `Reports` (statements, snapshots, exports, accountant package, tax)
· `Setup` (opening balances, greenfield, cutover, mappings, policies, overhead
budget). Redirects from old routes; old files deleted.

### K.2 — Split `books-client.tsx`
One client component per section under `components/books/`; the section page
loads only its own data (`getBooksWorkspace(section)` already scopes — enforce it).

### K.3 — Close gate policy
`accounting_drift` splits: findings about **Arc's own ledger** (tie-outs, drift
between subledger and GL) block; findings about the **external system** block only
when `external_sync_posture = 'outbound_mirror'` and the period's mirror failed.
`connection_unhealthy` never blocks an Arc-authoritative close. `sync_backlog`
same rule.

### K.4 — `shadow` vs `parallel`
Decide (B5.8): keep both, differentiated — `shadow` posts and reports; `parallel`
additionally requires the monthly comparison and enables the mirror. Encode the
difference in `module.ts` capabilities and the UI, or collapse the enum by
migration. STOP for the decision.

### K.5 — Remove
`mirrorJournalEntry` (uncalled); `books_settings.reporting_basis` CHECK if it stays
accrual-only (or widen it when J.3 lands); the raw `/books/cutover` and
`/books/opening-balances` sections after K.1; any dead export.

### Phase K exit checklist
```
- [ ] Exactly six routes under `app/(app)/books/` (ls recorded); every old
      route redirects; old page files deleted.
- [ ] `books-client.tsx` no longer exists; each section is its own component
      under `components/books/` and loads only its own data (network trace or
      loader signature recorded).
- [ ] Close gate policy: `connection_unhealthy` and `sync_backlog` never block
      an Arc-authoritative close; mirror failure blocks only in
      `outbound_mirror` posture (test named; matrix of posture × finding →
      blocking recorded).
- [ ] `shadow` vs `parallel` decision recorded (STOP), and either the
      capabilities differ in `module.ts` + UI, or the enum is collapsed by a
      written-and-STOPped migration.
- [ ] `mirrorJournalEntry` deleted; grep for it returns nothing.
- [ ] `pnpm lint`, `npx tsc --noEmit`, and every Books test pass after the
      restructure; every section re-screenshotted light + dark, with data and
      empty.
- [ ] A bookkeeper (or the human acting as one) completes a month close from
      `/books` using only the six sections, without instructions (session
      notes recorded).
```

---

# Phase L — Provider layer and the first official org

### L.1 — Finish entity mapping as a layer (C3.4)
16 files still reference `qbo_id`. Dual-read against `accounting_sync_records` +
`accounting_account_mappings`, prove parity on Patagonia (the org with the live QBO
connection), then release `pending-migrations/20260719001624_drop_qbo_columns.sql`.
**STOP** before the release — destructive.

### L.2 — File tier
`lib/integrations/accounting/file/` gains formats for QuickBooks Desktop (IIF),
Sage 100 Contractor, Sage 300 CRE, Foundation: AP batch, job-cost batch, monthly
summary journal. Mirror target for Arc-authoritative orgs whose CPA uses desktop.

### L.3 — Payroll provider adapters
Gusto and ADP journal pulls into E.3's `payroll_journals`. Adapter-only work if E.3
was built right.

### L.4 — Second live accounting adapter
Sage Intacct, when a commercial customer asks. Adapter-only, per C3 acceptance.

### L.5 — The first official org
Run the parallel → cutover route from the release doc on the first volunteer org:
three clean comparison closes spanning a quarter, independent approval, cutover,
mirror. Twelve consecutive closes after that is 10/10.

### Phase L exit checklist
```
- [ ] `grep -rl qbo_id lib app components` returns 0 files; dual-read parity
      proven on Patagonia (record counts matched, date recorded) BEFORE the
      drop; `pending-migrations/20260719001624_drop_qbo_columns.sql` released
      by the human (STOP recorded) and applied via CLI.
- [ ] File tier: IIF, Sage 100 Contractor, Sage 300 CRE, Foundation writers
      each have a golden-file test; one closed period mirrored to each format
      and opened in the target product or validated against its import spec.
- [ ] Gusto and ADP adapters fill `payroll_journals` with no change to
      `payroll-journals.ts` (diff recorded); one real pay period imported.
- [ ] Sage Intacct adapter (if a customer asked): shipped as adapter code
      only — zero diff in connections service, outbox, logger, or UI.
- [ ] First org: three approved comparison closes spanning ≥ 90 calendar days
      (`cutover-rules` gate), independent approval row, `complete_books_cutover`
      run, `books_settings.ledger_authority = 'arc'`, external posture set;
      period-summary mirror or disconnection evidenced.
- [ ] Twelve consecutive monthly closes on that org, every blocking gate green,
      rebuild drill `passed` the morning after each (period ids recorded).
```

---

## Plan completion checklist (maps to §0.2)

The plan is done when every line below is ticked with evidence. This is the 10/10.

```
- [ ] 1. CPA signature on the entry set for residential, commercial, AND
      production (§7 and §8 of `docs/books-revenue-recognition.md`).
- [ ] 2. Twelve consecutive closes on an official-ledger org (L.5 checklist).
- [ ] 3. Every bank and card account on that org reconciled monthly at zero
      difference with no manual recategorization of ordinary payments
      (recategorization count per month recorded).
- [ ] 4. Payroll clearing = 0 at every pay-period end on that org.
- [ ] 5. Every billing model in use recognizes correctly; loss provision and
      contract-asset reclass live; balance sheet presents 1150 and 2350
      separately.
- [ ] 6. A production org (QA or real) carries 1300/1310/1320/1330/2600 with
      all inventory tie-outs green across two closes and ≥ 1 real closing.
- [ ] 7. Statements by project, community, division, and cost type; drill to
      source; cash basis and 1099 filing-grade via partner.
- [ ] 8. ≤ 6 sections, one health view, every view has empty/loading/error/dark.
- [ ] 9. Zero `qbo_*` columns; file tier shipped; provider registry holds
      `qbo`, `file`, and any second live adapter as adapter-only code.
- [ ] 10. This file and `arc-books-gameplan.md` deleted; anything durable
      folded into `docs/` reference docs and `CLAUDE.md`.
```

---

## Sequencing

| Phase | Gate to start | Standalone value | Score after |
|---|---|---|---|
| **D** Operate | none | a proven ledger, signed entry set, release gates evidenced | 6 |
| **E** Cash & payroll | D.1–D.3 | bank rec and payroll clearing work | 7 |
| **F** Revenue | D.5 sent | right revenue for every billing model | 8 (res/com) |
| **G** Production | G.0 agreed + F.1 | production balance sheet is real | 8 (prod) |
| **H** Commercial | F | bonded WIP, equipment | 8.5 (com) |
| **I** Reporting | E, F (G for community) | statements a controller wants | 9 |
| **J** Tax | vendor decision | filing-grade | 9 |
| **K** Surface | I.6 | a workspace a bookkeeper accepts | 9 |
| **L** Providers | K | independence from QBO, long tail | 10 with L.5 |

D → E → F run in order. G may run in parallel with F once G.0 is agreed. H, I, J, K
are parallelizable after F. L.1 can start any time; L.5 is last.

Recommended delegation per the global model policy: pure posting rules, statements,
and anything user-facing on fable/opus; bulk backfills, format writers (L.2), and
seed scripts on gpt-5.5 with review; **no delegated agent ever runs SQL against
production** — every migration and every production job run stays in the main
session with the human watching.

## ▶ If you are picking this up fresh, start here

1. Read §0.1. Then run `node --test tests/arc-books.test.js` and query
   `ledger_rebuild_runs` for the QA org (read-only). If the drill is still failing
   on `missing_journal`, D.1 has not been done.
2. Do D.1 → D.2 → D.3 in that order. Each is small and each unblocks the next.
3. Do not touch F, G, or J before D.5's package has been sent — the CPA should
   review one document, once.
4. Every directive that writes a migration STOPs. Every directive that runs a job
   or a close on Strata STOPs. Read-only production queries need no permission.
5. When a phase is complete, strike its directives through here with the date and
   a one-line "what was built and why", the way `arc-books-gameplan.md` did — the
   record is what stops the next executor from re-deriving it.
6. **Checklists are the contract.** Copy the universal definition-of-done under
   each directive when you start it and tick boxes only with evidence pasted
   beside them (a query result, a run id, a test name, a screenshot path). Tick
   the phase exit checklist the same way. An unticked box means the phase is
   not done, whatever the prose above it says. Never tick a box you did not
   verify in this session.

## Positioning note

The race is not QuickBooks' feature list. The race is the thing no generic ledger can
do: a GL derived from the schedule, the draw, the retainage split, the lot, and the
closing, reconciled by construction. Phases F and G are that thesis made real for
every posture. Everything else here exists so a bookkeeper will trust it enough to
turn the other system off.
