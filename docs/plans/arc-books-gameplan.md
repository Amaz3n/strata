# Arc Books Gameplan — Ledger of Record → Construction-Native GL

> **Status: ACTIVE PLAN — intent, not a description of the system.**
> Nothing in this document is guaranteed to exist. Never infer current app
> behavior from it. Source of truth is the code, `CLAUDE.md`, and the
> reference docs at the `docs/` top level.

**Status:** Implemented in code on 2026-08-01; foundation and workspace opt-in migrations applied to the linked Supabase project. CPA policy approval, sandbox validation, and staged authority-cutover gates remain required.
**Audience:** an LLM executor. Follow directives literally; STOP means stop and ask the
human. This is a multi-quarter arc — each phase must ship standalone value and each
phase gate is a human decision.
**Companions:** `docs/plans/fintech-gameplan.md` (rails and fees — Books consumes its
`payments`/`disbursements` data), `docs/plans/platform-foundations-gameplan.md` WS-T2
(temporal tables — Books' as-of queries ride it).

> Implementation note (2026-08-01): B1 through the corrected B5.8 roadmap are represented in the application, services, jobs, tests, and additive migrations. Plaid is the initial bank-feed provider behind a provider-neutral boundary. Arc Books is bundled but disabled by default, and an organization admin opts in from Settings → Accounting. Disabling it preserves every Books record and never disconnects or pauses QBO or a future accounting provider. B5.8 remains optional and organization-scoped: external-authoritative and Arc-authoritative outbound-mirror modes are both permanent supported postures. The first release is accrual-only; cash-basis statements, payroll processing, tax-return preparation/filing, inventory, multi-entity consolidation, and multi-currency remain outside the support boundary. “Implemented” does not waive the human gates in this document.

---

## 0. The end state (so every phase aims at the same target)

Every economic event in a builder's life is born in Arc — commitment signed, CO
approved, selection locked, draw funded, bill released, deposit taken — and each
carries its double-entry consequence the moment it happens. The general ledger becomes
a **derived artifact**: a projection computed from Arc's records, always current,
always reconciled by construction. Month-end close stops being an event. QBO shrinks
from "the truth" to "the tax mirror," and for small builders eventually to nothing.
Arc Books is part of the Arc subscription, but the workspace is explicitly opt-in.
The construction-specific moat: **WIP and
percentage-of-completion revenue recognition computed continuously from the schedule
and the ledger** — the thing generic GLs are worst at and Arc is uniquely positioned
to own, because no accounting product knows what a schedule is.

Discipline rule: each phase below must be commercially standalone. Continuous WIP
sells to a builder who never leaves QBO. Never build a phase that only pays off if a
later phase ships.

## 0.1 Ground truth (verified 2026-07-31 — rely on these facts)

- **Arc already has a subledger, not a GL.** Cost side: `job_cost_entries` (table;
  service `lib/services/job-cost-actuals.ts`; `source_type ∈ vendor_bill_line |
  project_expense | project_expense_line | time_entry | manual_adjustment`; `status ∈
  pending|approved|posted|voided`; posted via `propagateApprovalToLedger` on bill/
  expense approval). Revenue side: `invoices` + `payments` + `payment_allocations` +
  `draw_schedules` + `pay_applications` + `retainage`. There is NO account concept, NO
  journal concept, NO double-entry anywhere.
- **Accounting abstraction:** `lib/integrations/accounting/provider.ts` defines
  `AccountingProvider` (push invoice/payment/expense/vendor_bill/bill_payment;
  optional journal entry push — `supportsJournalEntryPush` capability flag exists).
  Registry has one provider: `qbo`. Sync ledger: `accounting_sync_records`
  (org/connection/entity_type/entity_id/external_id/status/pushable).
- **Coding:** `accounting_coding` jsonb on `vendor_bills` (neutral), built by
  `lib/services/accounting-coding.ts` (`buildAccountingCoding`,
  `accountingReference(coding, "expense_account"|"payment_account"|"ap_account"|
  "counterparty")`). Legacy `qbo_*` columns still coexist;
  `supabase/pending-migrations/20260719001624_drop_qbo_columns.sql` is staged and
  GATED — never touch it.
- **WIP report exists:** `lib/services/reports/wip-over-under.ts` — earned revenue =
  revised contract × (actual/EAC), over/under = billed − earned. Inputs: approved COs,
  billed invoices (`sent|partial|paid|overdue`), `getBudgetWithActuals` summary,
  project contract snapshot. This is the seed of continuous POC.
- **Exports exist:** `accounting-export.ts` — `createAccountingExport({ kind: 'ap' |
  'job_cost' | 'journal' , ...})`. A journal export shape already exists in embryo.
- **Reconciliation report exists** (memory: integrity checks live in the
  Reconciliation report; Trust Center is a redirect — never re-add it).
- **Events:** `recordEvent` writes `public.events` (app-authored, no DB triggers).
  `budget_snapshots` has `source ('manual'|'nightly')` with a nightly
  `forecast-snapshots` cron. `audit_log` is append-only, never pruned.
- **Cron/report plumbing:** `CRON_JOBS` in `lib/services/job-runs.ts` (23 entries,
  mirrored in `vercel.json` + `PUBLIC_API_ROUTES`); report catalog in
  `lib/reports/definitions/financial.ts`.

Doctrine: money integer cents; every query org-scoped; services own logic; migrations
are additive and released only through an explicitly authorized deployment; no `qbo_*`
columns ever again.

---

## Phase B1 — Zero-touch coding (kill the bookkeeping, keep QBO)

### What this is
Ramp's deepest lesson applied: the goal is not faster bookkeeping but *no*
bookkeeping. Every cost arrives pre-coded; a human touches a transaction only when
the system is unsure. Metric to move: **touches per transaction** (define: number of
human edit/approve interactions per posted cost row; instrument it first).

### Directives
1. **Instrument first.** Add a lightweight counter: when a user edits
   cost_code/budget_line/account coding on a bill, expense, or imported QBO record,
   `recordEvent("coding.touched", { entityType, entityId, field })`. One week of data
   before and after each sub-phase = the success measure. No schema needed (events
   table).
2. **Coding rules engine.** Extend `lib/services/accounting-rules.ts` (do NOT create
   a parallel service) with learned rules:
   `coding_rules` table — org_id, match kind (`vendor | vendor+memo_pattern |
   card_scope | email_sender`), match value, then coding (cost_code_id,
   budget_line_id nullable, accounting refs jsonb), confidence, hit_count,
   last_hit_at, created_from (`user_correction | import | seed`).
   Population is passive: every time a user codes or re-codes a payable/expense,
   upsert a rule keyed on the vendor (and memo pattern when the vendor is
   multi-category). Application: `createProjectVendorBill`,
   `processInboundBillEmail`, QBO import line-allocation, and receipt extraction all
   call `suggestCoding(orgId, { companyId, memo, source })` and pre-fill; rows
   arriving with ≥N hit_count rules auto-code silently and are marked
   `metadata.coding_source = 'rule'`.
3. **Confidence tiers, not magic:** auto-apply only when the rule has ≥3 hits and no
   contradicting correction in 90 days; otherwise pre-fill + flag. Every auto-coded
   row remains editable; an edit demotes the rule (decrement/hit reset). No LLM in
   the hot path for v1 — rules are exact-match and cheap; the classifier tier
   (platform-foundations WS-T4) can add fuzzy vendor matching later.
4. **Review-queue integration:** the financials review queue
   (`financials-review-queue`) gets a "coded automatically" chip and a one-click
   "looks right" bulk-approve for rule-coded rows, honoring existing
   `invoice_auto_approval_rules` precedent.

### Acceptance
Touches-per-transaction measurably down on the QA org fixture set; rule application
is idempotent and audited; `pnpm test:financials` gains rule-suggestion cases.

---

## Phase B2 — Continuous reconciliation (the close that never opens)

### What this is
The Reconciliation report run nightly per org with drift flagged the day it happens,
plus a "close readiness" surface. Books' credibility rests on Arc's subledger and QBO
never silently diverging.

### Directives
1. New cron `accounting-reconciliation` (nightly, off-peak): for each org with a
   healthy accounting connection, run the existing reconciliation report logic
   programmatically, persist a summary row (`reconciliation_runs`: org_id, run_date,
   checked_counts by entity, discrepancy_count, discrepancies jsonb capped at 200
   rows, status). Register in `CRON_JOBS` + `vercel.json` + `PUBLIC_API_ROUTES`;
   handler GET; `withCronRun` wrapper (copy `compliance-autopilot`'s route shape).
2. Drift notification: new discrepancies (vs. previous run) notify users holding the
   bookkeeper-ish permission (`financials.margin.read` holders is the wrong key —
   use `bill.approve` ∪ `invoice.write` holders; confirm against RBAC catalog).
   Email type MUST be added to `EMAIL_NOTIFICATION_TYPES` or it will silently not
   send.
3. **Month-end close checklist surface:** `financials/close` page (exists) gains a
   "Books" band: unreconciled discrepancies, unpushed approved entities
   (`accounting_sync_records` status ≠ synced), uncoded rows, unreleased waiver-held
   payments, retainage movements this period. Each row deep-links to its cure. This
   band is the productization of "the close is a checklist that's already green."

### Acceptance
A seeded discrepancy (edit an amount in the QA org's QBO sandbox) appears in the next
run's summary and notifies; zero-discrepancy runs are silent (no notification spam).

---

## Phase B3 — Continuous WIP / percentage-of-completion (the flagship)

### What this is
POC revenue recognition computed continuously — over/under-billings that move daily —
shipped as a report + desk band, requiring NO general ledger. This is the phase that
sells on its own to builders who never leave QBO, and it's the construction moat.

### Directives
1. **Promote WIP math to a service:** extract the earned-revenue computation from
   `reports/wip-over-under.ts` into `lib/services/poc.ts`:
   `computeProjectPoc(projectId) -> { contractCents, revisedContractCents,
   costToDateCents, eacCents, pctComplete, earnedRevenueCents, billedCents,
   overUnderCents, inputsHash }`. The report becomes a consumer. Guard rails already
   in the report (missing contract/budget/EAC issues) become typed warnings on the
   result.
2. **Daily POC snapshots:** extend the existing `forecast-snapshots` nightly cron to
   also persist per-project POC rows (`poc_snapshots`: org_id, project_id, as_of
   date, the computed fields, inputs_hash). Append-only. This gives the CFO the
   "earned revenue moved $84k this week, driver: Willow Creek EAC revision" story
   and provides the audit trail an outside CPA needs.
3. **Journal-entry EXPORT (not push) for POC:** monthly, generate the
   over/under-billing adjusting entries (debit/credit pairs: costs in excess /
   billings in excess) as a reviewable export via the existing
   `createAccountingExport({ kind: 'journal' })` machinery — CSV + a rendered PDF the
   CPA can book in QBO in one sitting. Do NOT auto-push journal entries in this
   phase even though `supportsJournalEntryPush` exists — trust is earned. STOP
   before ever enabling auto-push.
4. Surfaces: `/reports` keeps the WIP report (now snapshot-backed with trend);
   Home/control-tower gets an over/under aggregate band for orgs with contracts
   (posture-aware via the financial config choke point — production tract builders
   use spec/closing accounting, POC applies to contract postures; route the
   applicability decision through `getProjectFinancialFeatureConfig`, never inline).

### Acceptance
POC output ties to the current WIP report exactly on day one (same inputs, same
numbers — regression fixture); snapshots accumulate; journal export round-trips into
a QBO sandbox cleanly (manual QA note).

---

## Phase B4 — The journal projection (double-entry as a derived view)

### What this is
The structural heart: a chart of accounts + a journal, DERIVED from Arc's existing
records by deterministic posting rules — not a new write path. Arc's services keep
writing exactly what they write today; a projector maps those records to balanced
journal entries. If the projector is wrong, you fix it and re-project; source records
are never touched.

### Design (read carefully — this is the architecture decision)
- **Do NOT event-source.** Arc's records (bills, invoices, payments, COs, retainage,
  job cost entries) are already the facts. The projector reads FACTS → emits
  JOURNAL. Re-projection from scratch must always be possible (that's the
  correctness escape hatch and the migration path for rule changes).
- Schema:
  - `gl_accounts` — org_id, code, name, type (`asset|liability|equity|income|cogs|
    expense`), subtype (construction-aware: `wip|billings_in_excess|
    costs_in_excess|retainage_receivable|retainage_payable|customer_deposits|...`),
    is_system, parent_id, active. Seed a construction-native default chart per org
    (~60 accounts); orgs can rename/add but system accounts can't be deleted.
  - `journal_entries` — org_id, entry_date, source_type, source_id, memo,
    projection_version, posted_at; UNIQUE (org_id, source_type, source_id,
    projection_version).
  - `journal_lines` — entry_id, account_id, project_id nullable, debit_cents,
    credit_cents (exactly one nonzero), dimension jsonb. DB CHECK: per-entry sums
    equal (enforce via deferred constraint trigger or app-level assertion + nightly
    verifier — implement the nightly verifier regardless).
- **Posting rules** live in code (`lib/services/books/posting-rules.ts`), pure
  functions: `postVendorBill(bill, lines) -> JournalEntryDraft` etc. Rule coverage
  v1: vendor bill (WIP debit / AP credit, retainage split), bill payment (AP debit /
  cash credit), invoice (AR debit / billings credit), invoice payment, expense,
  retainage release, CO approval (contract adjustment memo-only), draw funding,
  early-pay discount (fintech WS-P4's `manual_adjustment` becomes a real posting),
  POC monthly adjustment (from B3).
- **Projector:** `projectJournal(orgId, { since })` — idempotent, driven off
  `events`/`updated_at` watermarks, run by cron + backfillable from zero.
  `projection_version` bumps when rules change; re-projection writes new version,
  verifier compares, old version dropped after review. Cash accounts stay thin in
  v1: one "Operating cash (per Arc)" account fed by payments/disbursements — full
  bank-feed reconciliation is B5.
- **Statements as queries:** trial balance, P&L (with job-cost detail by project),
  balance sheet — read-only report catalog entries computed from journal_lines. This
  is where a builder first *sees* Books.
- STOP gates: chart-of-accounts seed design and the posting-rule table above must be
  reviewed by the human (and ideally a construction CPA) BEFORE the migration is
  written. Do not guess at debits and credits — present the rule table for sign-off.

### Acceptance
Full re-projection of the QA org is deterministic (two runs byte-identical); trial
balance balances to zero; P&L job-cost total ties to `job_cost_entries` posted total;
AR/AP balances tie to the existing aging reports. These four tie-outs are the
non-negotiable definition of done.

---

## Phase B5 — Arc Books, the optional product workspace (QBO replacement for small builders)

### What this is
The bundled, optional workspace that can eventually let a small builder disconnect
QBO: bank feeds, the compliance tail (1099s exist; sales-tax export), CPA access, and
statements as the org's official books. An organization may instead remain
external-authoritative forever. Enabling the workspace never changes ledger authority,
and disabling it never changes external sync. Arc-authoritative organizations require
a controlled rollback or migration and cannot simply toggle their official ledger off.
Authority cutover remains gated on B4 running silently-correct in production for a full
quarter across multiple orgs.

### Scope directives (design-level; each item is its own workstream when the gate opens)
- **Bank feeds:** transaction import through Plaid behind Arc's provider-neutral
  banking boundary. Matching engine: bank txn ↔ journal cash lines
  (disbursements, payments, card settlements from fintech WS-P3 make most
  transactions pre-matched by construction). Unmatched → a review tray. This is
  where "Operating cash (per Arc)" becomes real reconciled cash.
- **The compliance tail:** vendor 1099 (report exists — becomes filing-grade),
  sales/use tax summary export by jurisdiction (report first, filing partner later),
  fiscal-year close (retained earnings roll — a posting rule, not a feature).
- **CPA seat:** read-only role scoped to Books surfaces + report exports + (later)
  MCP access. The pitch to the CPA is "your client's books are already reconciled;
  here's your login" — CPAs become a channel, not an obstacle.
- **Payroll: never build.** Embedded-payroll partner if demanded (construction
  payroll + certified payroll is its own industry).
- Migration UX: "Start Books on <date>" — opening balances entered once (guided from
  the QBO trial balance), history stays in QBO. Never attempt full historical
  migration.
- Settings → Accounting owns workspace enablement, fiscal policy, external connection
  posture, and the clear explanation of which system is authoritative. Authority
  cutover and any filing integrations remain human-gated decisions.

---

## Sequencing

| Phase | Gate to start | Standalone value |
|---|---|---|
| B1 zero-touch coding | none | fewer bookkeeping hours immediately |
| B2 continuous reconciliation | none (parallel with B1) | trust + "close in a day" |
| B3 continuous POC | B1/B2 helpful, not required | CFO/CPA flagship, sells alone |
| B4 journal projection | B3 shipped; human sign-off on posting rules | statements, CPA wow |
| B5 Arc Books workspace | B4 silent-correct for a quarter; human authority decision | optional QBO independence inside Arc |

Every phase: `pnpm lint && npx tsc --noEmit` clean, `pnpm test:financials` extended,
migrations additive and explicitly released, entity registration checklist for every new table,
empty/loading/error/dark on every surface, and no `qbo_*` columns EVER.
