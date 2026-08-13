# Arc Books Gameplan — Ledger of Record → Construction-Native GL

> **Status: ACTIVE PLAN — intent, not a description of the system.**
> Nothing in this document is guaranteed to exist. Never infer current app
> behavior from it. Source of truth is the code, `CLAUDE.md`, and the
> reference docs at the `docs/` top level.

**Status:** Phases B1–B5 are represented in code (2026-08-01). A full audit on
2026-08-07 found the scaffold broadly built and the **posting core incorrect**.

**C1 is COMPLETE (2026-08-07)** — revenue recognition, re-projection, the fact-hash
trap, payment classification, watermarking, the missing posting rules, the WIP
account, and the nightly tie-out verifier all shipped; migration
`20260807120000_books_c1_correctness_core.sql` applied. **C2 is PARTIAL** — see the
phase body for what landed and what remains. Arc Books must still not leave shadow
mode until the CPA sign-off in C1.1 clears and C2 closes.
**Audience:** an LLM executor. Follow directives literally; STOP means stop and ask
the human. Each phase gate is a human decision.
**Companions:** `docs/plans/fintech-gameplan.md` (rails and fees — Books consumes its
`payments`/`disbursements` data), `docs/plans/platform-foundations-gameplan.md` WS-T2
(temporal tables — Books' as-of queries ride it).

## 2026-08-12 release-hardening implementation record

The architectural review was validated against the live code rather than accepted
as a checklist. Its core diagnosis was correct. The following defects are now
implemented in application code and covered by the financial regression suite:

- reversals are one atomic, idempotent database operation and set the original to
  `reversed`; posted entries cannot acquire lines after posting;
- close and operational posting serialize on the accounting-period row;
- projection uses a watermark per source family, detects lifecycle exits on
  incremental passes, lets full passes detect deletions, and re-reads after a fact
  insertion race;
- fact hashes use economic-field allowlists, child cost/release edits touch their
  parent cursor, and only Arc Books GL mappings can override a posting account;
- direct-paid project expenses post from job-cost lines, preserving project and
  account grain, and project overrides are restricted to COGS accounts;
- payment creation and provider/fee detail persistence share one transaction;
- shadow-to-parallel promotion is governed and attested; the closed-period external
  summary mirror now has an operator-facing caller;
- Books pages use section-scoped loaders, exact cents, dollar inputs, permission-
  gated controls, searchable account selectors, validated trial-balance paste,
  explicit audit reasons, visible tax limitations, statement export/print paths,
  construction-report links, a capped/disclosed job-cost detail report, and visible
  truncation for bank queues/registers;
- Books-off payables use the ledger-authority resolver; disconnecting an accounting
  connection removes its orphan entity routes; caller-less policy/mirror/fact code
  was removed.

Database invariants were staged in
`20260812120755_books_release_hardening.sql` and applied to production through
Supabase MCP with explicit authorization on 2026-08-12 ET. Atomic reversal,
serialized close, child cursor triggers, and atomic payment-detail writes are now
present in the production schema; organization activation still requires the
release runbook gates.

### 2026-08-12 sole-ledger completion record

The implementation has now moved beyond release hardening into the operational
surface required to replace a generic accounting GL for the supported customer
profile. See
[`arc-books-sole-ledger-release.md`](./arc-books-sole-ledger-release.md) for the
release boundary, operator flow, verification evidence, migration order, and
production activation gates.

Implemented after the architectural review:

- manual bank-account creation and CSV/TSV/OFX statement ingestion, GL mapping,
  deduplication, revision history, and a settlement-aware 1010 clearing flow;
- a governed external-chart mapping screen, parser-driven trial-balance
  comparisons, shadow-to-parallel promotion, closed-period mirrors, and a
  least-privilege independent reviewer role;
- customer-deposit receipt, application, refund, availability validation, and a
  blocking liability-control tie-out;
- debt and fixed-asset registers with atomic journal/event posting, depreciation,
  disposal, and blocking GL control tie-outs;
- tax jurisdictions on receivables/payables, purchase use-tax accrual allocated
  deterministically through job cost, filing evidence, and 1099 readiness;
- complete taxpayer IDs stored and rotated only in Supabase Vault, with ordinary
  tables, UI, reports, exports, events, and audit records limited to last-four and
  verification state;
- maker-checker adjusting journals, pending-proposal close blocking, greenfield
  sole-ledger launch, close checks for missing depreciation/tax jurisdiction, and
  complete operational export manifests;
- exact-cents daily-driver surfaces for WIP, aging, job cost, statements,
  registers, deposits, tax, bank review, and period close.

The original paragraph above names only the first staged migration and is retained
as the historical release-hardening record. The complete applied migration train,
including the post-apply advisor and privilege hardening migrations, is listed in
the sole-ledger release document. Application was performed only after the user
provided the required explicit production authorization.

> **Reading order:** Part I and the detailed C-sections preserve the chronological
> audit record, so some inline status labels describe what was true on 2026-08-08.
> The 2026-08-12 completion record above and the sole-ledger release document are
> authoritative for current release status and remaining activation gates.

---

## 0. The end state (unchanged — every phase aims here)

Every economic event in a builder's life is born in Arc — commitment signed, CO
approved, selection locked, draw funded, bill released, deposit taken — and each
carries its double-entry consequence the moment it happens. The general ledger is a
**derived artifact**: a projection computed from Arc's records, always current,
always reconciled by construction. Month-end close stops being an event.

The construction moat: **WIP and percentage-of-completion revenue recognition
computed continuously from the schedule and the ledger** — the thing generic GLs are
worst at, because no accounting product knows what a schedule is.

**Two permanent postures, one codebase:**
- **External-authoritative** — the classic integration. An external accounting system
  owns the ledger forever. Arc feeds it. This is the default and is never deprecated.
- **Arc-authoritative** — Arc Books owns the ledger; the external system becomes a
  tax mirror or is disconnected entirely. Opt-in, human-gated, reversible only
  through controlled rollback.

Discipline rule: each phase must be commercially standalone. Never build a phase that
only pays off if a later phase ships.

Support boundary for the first release: accrual-only, single-entity, USD. Payroll,
tax filing, inventory, consolidation, and multi-currency stay out of scope.
**Exception under review — see C4.3: cash-basis statements are being promoted to a
launch requirement for the Arc-authoritative posture.**

---

## 0.1 Ground truth (verified 2026-08-07 — rely on these facts)

**What is real:**
- **33 Books tables** exist behind `supabase/migrations/20260801143926_books_accounting_foundation.sql`
  plus the opt-in migrations. RLS is select-only for `authenticated` on every Books
  table; all writes route through service-role server actions.
- **The journal is written by exactly one function** — the `security definer` RPC
  `post_books_journal_entry`, revoked from `public`/`anon`/`authenticated`. No service
  inserts journal rows directly.
- **Entry balance is enforced by a deferred DB trigger** (`books_assert_journal_balanced`)
  plus an app-level assertion, and posted entries are immutable
  (`books_guard_posted_journal`).
- **Posting rules are pure** (`lib/services/books/posting-rules.ts`, no I/O).
- **Statements compute live from posted journal lines** (`lib/services/books/statements.ts`)
  and are registered in the report catalog.
- **Plaid bank feeds are production-shaped**: cursor-based `/transactions/sync`,
  ES256 webhook verification with body hash + iat window, pending→posted transitions,
  a scoring match engine against journal cash lines.
- **Cutover governance is the strongest work in the codebase**: service-role-only
  `complete_books_cutover` / `rollback_books_cutover` RPCs, digest-invalidated dual
  approval, self-approval blocked by unique constraint, 14-day rollback window voided
  by any period close, credential hard-revocation after the deadline.
- **The accounting provider interface is genuinely neutral**
  (`lib/integrations/accounting/provider.ts`): capability flags rather than provider
  checks, `updateConcurrency: sync_token | etag | none`, a `dimensions` list, optional
  methods for provider-specific capability. Dispatch is registry-driven
  (`lib/services/accounting-sync.ts:135`). Registry holds `qbo` and `file`.
- **`accounting_account_mappings`** is a real per-connection GL↔external account map.

**Resolved by C1 (2026-08-07) — do NOT re-report these as defects:**
- Revenue recognition exists. An invoice credits `2350 Contract liabilities`;
  `lib/services/books/revenue-recognition.ts` debits `2350` / credits `4000` for
  earned revenue, cumulative-to-date, and runs at period close. Closing-basis
  projects book revenue at the sale via `postClosingInvoice`.
- Re-projection works. `projectionVersion` and `sourceVersion` are both embedded in
  every posting key via `buildPostingKey`.
- The fact hash covers economic fields only (`hashableFactPayload`). A revision
  supersedes the fact, reverses the prior entry, and reposts on the same pass.
- GL job cost derives from `job_cost_entries` through `bill_lines`, at line grain
  with line-level project attribution. Field labor posts via `postLaborCost`.
- Payment fees reach the P&L (and no longer double-count `fee_cents` against the
  processor/platform split); ACH returns post via `postPaymentReversal`.
- The nightly verifier `lib/services/books/verifier.ts` runs all four tie-outs,
  including GL ↔ `job_cost_entries`, which previously existed nowhere.
- The legacy journal export and the sixth cost derivation in `accounting-export.ts`
  are deleted; the job-cost export reads the subledger.
- Both Books migrations are APPLIED to the linked project. `journal_entries` and
  `accounting_facts` were empty at the time of the C1 fix, so no historical ledger
  data was ever produced under the old rules.

**Still open (the C2–C4 backlog):**
- ~~**Two double-entry systems coexist.**~~ **RESOLVED 2026-08-07 (C2.1.2, Option B).**
  `payment_ledger_*` is a rails-operations subledger, deliberately outside the GL and
  reconciled to it by the spine. It is not a second general ledger, and feeding it to
  the projector would double-post every rail payment.
- **Redundant projections of the same money facts** remain: `budget_snapshots`,
  `poc_snapshots`, `payment_ledger_entries`, and the inline WIP math in
  `components/financials/budget-tab.tsx:1039` (a third POC copy).
- **`mirrorJournalEntry` has zero callers.** The Arc-authoritative tax-mirror posture
  has no engine, and its grain is wrong (per-transaction, should be monthly summary).
- **Authority gates fail open**: `lib/services/accounting-sync.ts:19-26` and
  `lib/integrations/accounting/qbo/reconcile.ts:776-785,934-940` re-enable external
  push/inbound on a transient settings-read error.
- **Five reconcilers, no spine** (C2.3). The nightly Books reconciliation still
  compares no amounts.
- **Statements have no workspace surface, no drill-down, no project dimension on the
  P&L, and no cash basis** (C4).
- **✅ RESOLVED 2026-08-08 — a failed posting stranded its fact forever, and the nightly
  reconciliation had never completed for any org with a connection.** Two defects found by
  actually running the jobs; neither needed a migration.
  - **The watermark stranded facts.** `resolveWatermark` derives the incremental cursor
    from `accounting_facts.occurred_at`, but the projector writes the fact *before* it
    posts the journal. When posting failed, the fact survived (the table is append-only,
    so it cannot be cleaned up), the watermark advanced past it, and the ten-minute run
    never looked at it again — 10 of 11 facts were permanently invisible with no journal
    entry. `projectJournal` has always supported a full pass, and the module docstring
    calls it "the nightly repair sweep", but **nothing ever passed `full`** — the same
    shape as C1 directive 8, where `runLedgerTieOuts` had one caller despite a docstring
    claiming it ran nightly. `books-maintenance` (daily 05:15 UTC) now runs
    `runBooksProjection({ full: true })`, and `books-projection` accepts `?full=1` as the
    operator lever for a backfill. Posting is idempotent on the posting key, so a full
    pass costs nothing when the ledger is already whole.
  - **`accounting_sync_records.updated_at` does not exist.** `books/reconciliation.ts`
    selected it, so PostgREST rejected the query and failed the entire org's
    reconciliation before a single tie-out ran — every night, for every org with an
    accounting connection. The same query also paged with `range()` and **no `ORDER BY`**,
    despite the C2.3 note claiming "paged with deterministic ordering"; it now orders by
    `(created_at, id)` so the sort is total. Staleness reports `queued_at` and
    `last_synced_at`, the columns that actually exist.

    Fixing this brought the customer org's nightly reconciliation back from the dead: its
    first successful run surfaced 24 open items (15 unreconciled sync records, 3 stale
    connections, 2 unhealthy connections, 2 sync errors, 2 budget/actual mismatches) that
    had been accumulating unseen.
- **✅ RESOLVED 2026-08-08 (migration APPLIED) — the journal balance trigger had made
  posting impossible since the schema was written.**
  `20260808170000_books_balance_trigger_row_type_fix.sql`. Until it was applied, the
  §0.1 claim that the balance trigger "enforces" entry balance was false: it enforced
  nothing, because it never ran to completion.

  `books_assert_journal_balanced` is shared by the `journal_entries_balanced` and
  `journal_lines_balanced` constraint triggers and chose its entry id with a CASE
  *expression* (`... else coalesce(new.entry_id, old.entry_id) end`). SQL CASE
  short-circuits at execution, but PL/pgSQL prepares the whole expression first and every
  field reference must resolve against the actual row type — and a `journal_entries` row
  has no `entry_id`. Every insert therefore raised `record "new" has no field "entry_id"`,
  and since the trigger is `deferrable initially deferred` it failed at COMMIT and took
  the transaction with it. **No journal entry has ever been posted in any org.**

  It hid behind the same green cron as the retainage blocker: no org had
  `workspace_enabled`, so the projector never reached the posting RPC, and
  `journal_entries` being empty read as "nothing has happened yet" rather than "nothing
  can happen". Both C1's "balance is enforced by a deferred DB trigger" claim in §0.1 and
  the acceptance tie-outs were asserting against a path that had never executed.

  The fix is control flow instead of an expression, so the untaken branch is never
  prepared — which is what the sibling `books_guard_posted_journal` already does thirty
  lines above the defect, and what `books_validate_child_org` does across its eight
  tables. It is the *only* `:= case` across row types in the Books migrations; every other
  shared trigger function was already written correctly. Guarded by
  `tests/arc-books.test.js` → *"the journal balance guard resolves its entry id with
  control flow, not a CASE expression"*, which checks the newest defining migration rather
  than every file mentioning the name.
- **✅ RESOLVED 2026-08-08 — `saved` invoices were in the AR subledger but never reached
  the GL. Three definitions of AR are now one.** Found while seeding the QA org; the
  decision was to adopt the projector's set everywhere, and
  `lib/financials/ledger-status.ts` is now its only home (`BILLED_INVOICE_STATUSES`,
  `PAYABLE_VENDOR_BILL_STATUSES`). Verified against live QA data: AR subledger fell from
  $318,700.00 to the correct $100,000.00 and held retainage from $26,300.00 to $5,000.00,
  with all five subledger totals now matching the hand-computed ledger exactly. The
  original finding, kept because the shape of it explains the fix:
  `invoices_status_check` allows
  `draft | saved | sent | partial | paid | overdue | void`, and the three readers disagree:
  - `projector.ts:156` posts **only** `sent | partial | paid | overdue`.
  - `verifier.ts:92` (the `ar_control` subledger) excludes **only** `draft` and `void` —
    so it counts `saved`.
  - `reports/ar-aging.ts:59` excludes **only** `void` — so it counts `draft` *and* `saved`.

  A `saved` invoice therefore inflates the AR subledger and the aging report while
  contributing nothing to `1100`, so `ar_control` fails permanently for any org holding
  one. The same root cause hits `retainage_receivable_control`: retainage rows attached to
  `saved` invoices count as held while their invoice never posts to `1110`. On the QA org
  that is **$218,700.00 of phantom AR and $21,300.00 of phantom retainage** across four
  WS02 fixtures. AP is unaffected — `ap-aging.ts` has no status filter at all, but
  `verifier.ts` and the projector both use `approved | partial | paid`, so they agree.

  The code says `saved` is **pre-issuance**: `invoices.ts:2259` moves `draft|saved → sent`
  on send, `:1408`/`:1791`/`:1980` treat `draft` and `saved` as the editable/deletable
  pair, and `reports/project-profitability.ts:135` already excludes all three of
  `draft, saved, void`. On that reading the projector is right and the verifier is wrong.

  **What shipped.** `lib/financials/ledger-status.ts` owns both sets; `poc-inputs.ts` no
  longer declares `BILLED_INVOICE_STATUSES` (it moved, it was not copied). Fifteen
  hand-written copies across fourteen files now import it. Behaviour changed in four
  places:
  - `verifier.ts` `ar_control` sums the projector's set instead of "not draft/void".
  - `verifier.ts` held retainage joins its invoice — `invoices!invoice_id!inner`, and the
    FK hint is **required**, because `retainage` has two foreign keys to `invoices`
    (`invoice_id` and `release_invoice_id`) and PostgREST refuses the embed as ambiguous
    without it. The cutoff is now the invoice's `issue_date`, matching the date the GL
    dates that 1110 debit, rather than `held_at`.
  - `reports/ar-aging.ts` no longer ages `draft` and `saved` invoices as money owed.
  - `reports/ap-aging.ts` had **no status filter at all** and was aging `rejected` bills —
    which will never be paid — as payables. It now uses the payable set.

  Pinned by `tests/arc-books.test.js` → *"AR and AP have one status definition, and it is
  the one the GL posts from"*, which also asserts no module on the ledger seam re-declares
  either set.

  **Still true and still open:** C1's fourth acceptance criterion says AR/AP must "tie to
  the aging reports", but `verifier.ts` does not query them — it recomputes its own sums.
  The *status* halves now agree, so the tie-out passes, but the money arithmetic still
  differs on purpose: `ap_control` subtracts retainage (2010 holds it separately) while
  AP aging reports `total − paid` including retainage. Decide whether that is a real
  divergence or two legitimately different questions before recording C2.3's "one
  definition per tie-out" as fully met.

**✅ RESOLVED 2026-08-07 (C2.2.6 — retainage has one home).** The `retainage` table is
now the authoritative source for AR retainage, read through the single resolver
`loadInvoiceRetainageCents` (`lib/services/retainage.ts`). The projector, verifier, and
period-close no longer reference the phantom column; all five previously-fatal queries
now return HTTP 200 against the live schema. **No migration was required** — the table
proved complete: the only three invoices carrying `metadata.retainage_amount_cents`
without a `retainage` row are all `status = 'void'` (stale metadata on dead invoices,
which every Books query already excludes), and for every *live* invoice with a negative
retainage line the table amount matches it exactly, with zero discrepancies.

Two correctness defects were fixed alongside the missing column, both from the same
root cause — **AR and AP store retainage in opposite directions**:
- `postCustomerInvoice` expects a GROSS billing and splits it into AR + 1110, but was
  being fed `invoices.total_cents`, which is already NET (the hold is a negative invoice
  line). `fact-drafts.ts` now rebuilds gross as `total_cents + retainage_cents`. Left
  uncorrected this understated AR and under-credited 2350 by the retainage on every
  invoice. `vendor_bills.total_cents` **is** gross, so the AP path was already right and
  is unchanged.
- `verifier.ts` and `period-close.ts` computed `balance_due_cents - retainage_cents`,
  subtracting a deduction already baked into the balance. AR control now sums
  `balance_due_cents` directly; AP still subtracts, correctly.

Locked in by `tests/arc-books.test.js` ("an invoice total is net, a vendor bill total is
gross"). Still open from the original finding: there is no `retainage_control` tie-out
for accounts 1110/2010, and `postRetainageRelease` still has no caller — fold both into
C2.3.

**Original blocker, for context — `invoices.retainage_cents` DID NOT EXIST.**
Three Books code paths select it:
`books/verifier.ts:80` (the `ar_control` tie-out), `books/period-close.ts:101` (a
*blocking* close check), and `books/projector.ts:150` (the invoice fact source, whose
payload feeds `postCustomerInvoice` via `fact-drafts.ts:104`). No migration ever adds
the column; `information_schema` confirms `invoices` has no `%retain%` column at all.
`collectPages` throws on the PostgREST error rather than swallowing it, so **the
projector cannot project a single invoice, the nightly AR/AP tie-out cannot run, and
period close cannot complete.**

This is currently masked: **zero orgs have `workspace_enabled`**, so the projector
iterates an empty org list and the `books-projection` cron reports `success` every ten
minutes while doing no work. That green cron is why the defect went unnoticed.
Production holds 153 projectable invoices, so the failure fires on the first org to
enable Books.

Consequently **C1's acceptance criteria were never executed against data** — "AR/AP
balances tie to the aging reports" and "full re-projection of the QA org is
deterministic" cannot have passed. Treat C1 as code-complete but *unverified*, not
proven.

This is not a typo to patch: AR retainage has no single home, and the three candidates
already disagree in production — the `retainage` table (11 rows, $298,300 held),
`invoices.metadata.retainage_amount_cents` (25 invoices), and negative
`invoice_lines.unit = 'retainage'` rows (9 lines). Picking the authoritative one **is**
C2.2.6, which is therefore a prerequisite for Books working at all, not a cleanup item.
A second question must be answered with it: whether `balance_due_cents` already nets
the retainage line, because `verifier.ts:89` subtracts `retainage_cents` from it again
and would double-count the deduction if so. AP is unaffected —
`vendor_bills.retainage_cents` is a real column ($96,250) and does post to 2010.

**Open human gate (C1.1):** the revenue-recognition entry set still wants
construction-CPA sign-off before any organization advances past `shadow`. **The review
package is written and ready to send: `docs/books-revenue-recognition.md`.** It traces
the full contract lifecycle from the posting rules, works a percentage-of-completion
example end to end, and puts three questions in front of the reviewer — direct-to-COGS
versus WIP accumulation (1160 is seeded but never posted), contract assets and
liabilities netting into 2350 rather than splitting to 1150 under ASC 606-10-45, and the
timing of AR retainage release. Only the signature is outstanding; it is not something
engineering can supply.

Doctrine unchanged: money integer cents; every query org-scoped; services own logic;
migrations additive and released only through explicit authorization; no `qbo_*`
columns ever again.

---

# PART I — Shipped phases: status and remediation

## Phase B1 — Zero-touch coding — **COMPLETE 2026-08-08**

**Built:** `coding_rules` table with the planned match kinds, confidence, hit/correction
counts and a `nulls not distinct` unique key; pure `selectCodingSuggestion` in
`lib/services/accounting-rules.ts` with I/O in `lib/services/books/coding-rules.ts`;
all four call sites wired (`createProjectVendorBill`, `processInboundBillEmail`, QBO
import line allocation, receipt extraction) stamping `coding_source = 'rule'`; the
full-screen invoice-first payable creation workspace with vision extraction, learned-
rules-before-LLM, an org-vocabulary-constrained classifier, visible magic markers with
confidence and rationale, and draft quick capture.

### Remediation directives
1. ~~**Make the metric real.**~~ **DONE 2026-08-08.** `recordCodingTouch` now takes a
   list of `changes` and **drops fields whose value did not move**, so a touch means "a
   human changed a coding value" rather than "a human saved something" — the distinction
   the acceptance criterion rests on. It carries real field names, previous values, and
   the `coding_source` / `coding_rule_id` that produced the value being overridden.
   Project expenses are instrumented (both the details and workspace actions); they were
   the largest uninstrumented surface, and the metric could not be read as a *rate*
   while it only ever saw vendor bills. `getCodingAutomationStats`
   (`books/coding-rules.ts`) is the readout — counts only, every query `head: true` —
   surfaced on the org payables desk as `N touches/payable · N% auto-coded` over a
   30-day window, staying silent below 5 payables so the rate can't be read off noise.
   *Note the QBO-import surface is deliberately not instrumented: an importer applying a
   rule is not a human touch, and counting it would inflate the denominator with records
   nobody looked at.*
2. ~~**Let rules recover.**~~ **DONE 2026-08-08.** `correction_count === 0` is gone from
   the auto-apply test. Demotion is now `nextCodingRuleCounts` (pure): a correction
   **resets the hit streak** so the rule must re-earn its three confirmations, while
   `correction_count` survives as a lifetime counter that damps confidence. Combined
   with the (now reachable) 90-day cooldown, that is "demotion inside a rolling window".
   `last_hit_at` / `last_corrected_at` no longer erase each other — that mutual nulling
   was what made the cooldown unreachable even without the `correction_count` gate,
   since one hit wiped the correction timestamp holding the rule down. `created_from` is
   set once, at insert.
3. ~~**Fix over-eager correction detection.**~~ **DONE 2026-08-08.** `learnCodingRule`
   now takes `appliedRuleId` and derives the verdict itself through the pure
   `isCodingCorrection`, comparing the final coding values against what that rule
   proposed. Passing `corrected` as a hand-computed boolean is what let "the user opened
   a rule-coded payable and changed its due date" read as "the user contradicted the
   rule". A record coded by a *different* rule, or by hand, is a fresh lesson rather than
   a verdict.
4. ~~**Learn from multi-line payables.**~~ **ALREADY RESOLVED — verified 2026-08-08.**
   `buildCodingLesson` teaches a split bill its split (weights in basis points) and a
   uniformly-coded bill its code; the gate is
   `explicitLines.length === 1 || lesson.costCodeId || lesson.budgetLineId || lesson.lineSplits`.
   Landed with the payable creation workspace, after this directive was written.
5. ~~**Ship the review-queue integration.**~~ **DONE 2026-08-08.** `coding_rule_id` now
   rides on `VendorBillSummary` (`coding_source` / `coding_confidence` already did), so
   the review queue can tell a rule-coded row from a hand-coded one. The queue shows an
   **Auto-coded** chip with confidence, and the bulk bar gained the rule-aware sweep:
   with nothing selected it offers *"N auto-coded and ready → Select all"*, and with a
   selection it reports how many of them are auto-coded. *The payable detail workspace
   chip already existed* (`CodingProvenance` in `payables-workspace.tsx`) and was left
   alone.
6. ~~**Close the draft leak.**~~ **DONE 2026-08-08** for the queue: it now filters
   `status === "pending" && !bill.is_draft`, matching the org desk. The second half —
   guarding `evaluateAndAutoApproveVendorBill` — was **already resolved**:
   `invoice-auto-approval.ts:44` refuses drafts, sender-unverified, and
   needs-review payables outright, which is a stronger guard than a call-site condition.
7. ~~**Audit rule mutations.**~~ **DONE 2026-08-08.** `learnCodingRule` emits
   `coding.rule_learned` / `coding.rule_corrected` and a `coding_rule` audit row with
   before/after counts, and the select-then-insert race is closed by upserting on the
   natural key `(org_id, match_kind, company_id, match_value, memo_pattern)` — the
   `nulls not distinct` unique already there.
8. ~~Decide the dead enum members.~~ **DONE 2026-08-08 — all four dropped, migration
   APPLIED with human authorization** (`20260808150000_coding_rule_enum_cleanup.sql`;
   both narrowed constraints verified in `pg_constraint` afterwards).
   `coding_rules` held **zero rows in production**, so there was nothing to migrate and
   no compatibility window to keep — the migration still guards on that rather than
   assuming it, raising rather than half-applying if a retired value ever appeared.
   `match_kind` is now `vendor | vendor_memo`; `created_from` is now
   `user_correction` outright.
   The rejected option, recorded so it is not re-litigated: `card_scope` and
   `email_sender` were never implemented and were *unreachable* even if hand-inserted —
   `suggestCodingForService` filtered selection down to the two live kinds. Of the two,
   only `email_sender` is a plausible future feature (the sender is already in
   `payables-email-ingest.ts`), but `suggestCoding` takes no sender argument, so it is
   new plumbing plus a learn path — a feature, not a cleanup, and it returns with its own
   migration. `import` / `seed` describe a rule seeder and an importer-that-learns,
   neither of which exists; directive 2 made them deader still by writing
   `created_from` once and always as `user_correction`.
   That `.in("match_kind", …)` selection filter became a tautology once the constraint
   narrowed, and is deleted. The migration, the Zod schema, and the TS union are held
   together by `tests/arc-books.test.js` → *"coding rules declare only the match kinds
   and provenance that exist"* — three declarations of one enum is exactly how these
   survived a year describing a feature nobody built.

---

## Phase B2 — Continuous reconciliation — **COMPLETE 2026-08-08**

**Built:** cron `accounting-reconciliation` (nightly 04:45 UTC) correctly registered in
`CRON_JOBS` + `vercel.json` + `PUBLIC_API_ROUTES`, GET, `withCronRun`;
`accounting_reconciliation_runs` + a normalized `accounting_reconciliation_items` child
table (better than the planned capped jsonb — resolvable and queryable); drift
notification gated to genuinely new items, with the email type correctly registered in
`EMAIL_NOTIFICATION_TYPES`; an org-level Books close checklist at `/books/close`.

### Remediation directives
1. ~~**Stop duplicating the reconciliation report.**~~ **DONE 2026-08-07 by C2.3** — the
   spine compares amounts and runs the project integrity checks (with their cure
   deep-links) through the same implementation the report page uses. Original defect:
   the cron checked only connection
   health, non-synced sync records, and draft journals — it compared **no amounts**. It
   was a queue-drain monitor, not a reconciliation. The project-scoped integrity
   checks in `lib/services/reports/reconciliation.ts` (including `retainage_mismatch`)
   never reached `accounting_reconciliation_items`, and that report's cure-deep-link
   machinery went unused.
2. ~~**Fix the new-vs-prior diff.**~~ **DONE 2026-08-07 by C2.3** — the prior-run lookup
   now requires a successful run, and prior items are paged with deterministic ordering.
   Original defect: it selected the most recent prior run regardless of
   status, so a failed run re-notified every open discrepancy the next night; and
   `priorItems` was capped at 200 with no ordering, making the key set nondeterministic
   above that. Select the last *successful* run and page the full item set.
3. ~~**Add per-day idempotency**~~ **DONE 2026-08-07 by C2.3** — the spine reuses the
   day's run, backed by a unique index on `(org_id, run_date)` (applied). Original
   defect: no unique key, so a
   re-invoked cron inserted a second row and then diffed against itself, suppressing real
   notifications.
4. ~~**Finish the close band.**~~ **DONE 2026-08-08.** The band now runs 14 checks. The
   three that were missing are real queries, not placeholder rows: `sync_backlog`
   (approved records still unpushed — closing a period while the mirror is behind leaves
   two ledgers disagreeing about a period nobody can reopen without an audit trail),
   `waiver_holds`, and `retainage_movement`. The last two are warnings rather than
   blockers: movement is normal, *unnoticed* movement is not.
   **Every failing row now deep-links to its cure**, carried in `evidence.href` — no
   migration, since this is presentation riding on evidence that was already collected
   and then rendered as plain text. The unbounded exception scans are capped and record
   `scan_capped`, so a truncated pass can never read as a clean one.
   **On the "two homes" concern: there is only one.** `/books/close` is the accounting
   period close; `components/financials/period-close-workflow.tsx` closes project
   *billing* periods, which is a different concept with a different table. Nothing to
   delete.
5. ~~Add a manual "Run now" action and the seeded-discrepancy test.~~ **DONE 2026-08-08.**
   `runReconciliationNow` (`books.reconcile`-gated) reuses the day's run exactly as the
   cron does, surfaced as *Re-run reconciliation* on the close period — curing a
   discrepancy should not mean waiting for 04:45 UTC to see the checklist go green.
   Tests cover the seeded discrepancy (a one-cent subledger disagreement turns a control
   red and clears when cured, with zero tolerance asserted) and the close band's shape.
6. ~~Notification polish.~~ **DONE 2026-08-08**, and the defect was two-layered. Adding
   the missing `accounting_reconciliation_drift` case to `buildNotificationFromEvent`
   fixes the raw lowercase title, but the link would still have gone nowhere:
   `getNotificationHref` returned null without a `project_id`, so **no org-level
   notification could deep-link at all**. The resolver now honors an explicit
   `payload.href` first, which every org-scoped notification can now use.

---

## Phase B3 — Continuous WIP / POC — **COMPLETE 2026-08-08**

**Built:** `computeProjectPoc` in `lib/financials/poc-rules.ts` re-exported through
`lib/services/poc.ts`, with an integer-cents assertion and warnings; `poc_snapshots`
append-only with an immutability trigger and a unique key including `inputs_hash`;
capture wired into the nightly `forecast-snapshots` cron; a monthly over/under journal
**export** (`books-poc-journal`, CSV + PDF) that correctly does **not** auto-push.

### Remediation directives
1. ~~**STOP — production-posture orgs cannot close a period.**~~ **FIXED 2026-08-07.**
   POC applicability now routes through `resolveRevenueRecognitionBasis`
   (`lib/financials/billing-model.ts`) via `loadProjectRevenueBases`; the close
   checklist only demands a snapshot from percentage-of-completion projects. Original
   defect, for context:
   `lib/services/books/period-close.ts:96-97,118,139` makes a POC snapshot a *blocking*
   close check for every active project with no posture filter. A production tract
   builder on spec/closing accounting is permanently blocked. Route POC applicability
   through `getProjectFinancialFeatureConfig` — the choke point exists precisely to
   prevent this. Fix before any production org enables Books.
2. ~~**Collapse the three POC computations into one.**~~ **DONE 2026-08-08.** What is
   shared is `lib/financials/poc-inputs.ts` — the *decision* of how raw rows become
   inputs — rather than one resolver function. That was deliberate: the snapshot
   resolves one project at a time while the WIP report batches its change-order and
   invoice rollups across a whole org, and forcing the report through a per-project
   resolver would have turned an N-project report into 4N round trips on exactly the
   200-project org CLAUDE.md calls the design case. Each caller keeps its query shape;
   neither keeps its own rules.
   **Two genuine divergences had to be settled, not just deduplicated:**
   - *Original contract* — the snapshot reported `max(0, revised − COs)` and the report
     `inferred > 0 ? inferred : revised`. The report's rule won: reporting a $0 original
     contract beside a $120k revised one is a lie, and `missing_contract_value` already
     fires when the revised total is itself missing.
   - *Billed to date* — the report fell back to the budget summary's
     `total_invoiced_cents` whenever a project had no billed invoices. That number is
     built from cost-coded invoice **lines** (`unit_price × quantity`), a different
     quantity than what the customer was billed. The fallback is deleted; billed is
     invoices in the billed statuses and nothing else.
   The third copy in `budget-tab.tsx` is gone: the budget page now resolves the position
   server-side through `getProjectPocPosition` and passes it down. It had *both* wrong
   definitions — line-derived billing and a contract read without the revised-total
   snapshot — so it could contradict the WIP report on screen for the same project.
3. ~~**Ship the surfaces.**~~ **DONE 2026-08-08.** `asOf` is real: a past date reads the
   latest `poc_snapshots` at or before it, today computes live, and the report says
   which via `basis`. Projects with no snapshot at that date are named in
   `projects_without_snapshot` rather than silently answered with today's position —
   that is what "accepted and ignored" was doing, on a financial statement.
   **This also changes period close**, which snapshots the WIP report at `period_end`:
   a period closed after its end date now freezes the position as of period end rather
   than as of the day someone happened to run the close. That is the correct behaviour
   and the close checklist already blocks on POC snapshots existing through period end.
   The control-tower over/under band is built (`control-tower-wip.tsx`), reading
   snapshots rather than the report — one indexed query instead of a budget load per
   project, with an honest `asOf` instead of a number pretending to be live.
   Under-billing leads because it is the actionable half.
4. ~~**Write the real regression fixture.**~~ **DONE 2026-08-08.** The WIP arithmetic as
   it stood before extraction is written out independently in the test and compared
   against the shared rule across eight cases — zero EAC, zero contract, overrun past
   100%, deductive change order, odd-cent rounding, forecast loss, untouched job. That
   is what "same inputs, same numbers" asked for; one hand-picked assertion is not.
5. ~~Fix naming and units drift.~~ **DONE 2026-08-08.** `percentComplete` is now
   `completionRatio`, because it always was a 0–1 ratio; the `poc_snapshots.percent_complete`
   column keeps its name (it shipped) and the code comment says what it holds. Warnings
   are a `ProjectPocWarning` union, and `missing_budget` reaches the result through
   `computeProjectPoc(input, { extraWarnings })` — which also puts it in `inputsHash`,
   since a POC computed without a budget is not the same fact as one computed with it.
6. ~~Route the POC export through `SYSTEM_ACCOUNT_CODES`.~~ **ALREADY DONE** — verified
   2026-08-08 in `accounting-export.ts` (landed with C2.1.3).
7. ~~Reconsider gating `poc_snapshots` reads on `books.read`.~~ **RESOLVED 2026-08-08 —
   no migration needed.** The `books.read` grant is RLS on the `authenticated` role;
   snapshot-backed WIP reads through the service client from a service that has already
   proven `budget.read` + `invoice.read`, which is the right permission for this report.
   The snapshot table is an implementation detail of it. Standalone WIP works for orgs
   that never enable Books.

---

## Phase B4 — The journal projection — **CORRECTED BY C1 (2026-08-07)**

**Built:** the schema, the pure posting-rule module, the locked-down posting RPC, the
balance trigger, the chart seed, the statements, and cron registration.

**Not built or wrong:** revenue recognition, re-projection, watermarking, the nightly
balance verifier, the job-cost tie-out, five posting rules, and the WIP account. All
remediation for this phase is Phase **C1** — it is not a backlog, it is a blocker.

**Standing STOP (still in force):** no organization advances past `shadow` mode until
the C1.1 construction-CPA sign-off on the revenue-recognition entry set exists. C1's
code acceptance
criteria pass.

---

## Phase B5 — Arc Books workspace — **SHIPPED; governance is exemplary**

**Built:** opt-in defaulting off with existing orgs force-disabled; a Settings →
Accounting panel exposing authority posture honestly; `books_settings` with
`ledger_authority` / `arc_ledger_mode` / `external_sync_posture` cross-constrained at
the DB; disable that preserves every record, never touches the external connection, and
is blocked outright for Arc-authoritative orgs (app **and** DB CHECK); Plaid feeds and a
matching engine; nine workspace routes; dual-approved immutable opening balances;
period close with blocking gates; the accountant package; the full cutover state machine
with controlled rollback.

### Remediation directives
1. ~~**Close the fail-open authority gates.**~~ **DONE 2026-08-08.** The three copies of
   the authority read are now one resolver, `lib/services/books/authority.ts`, and it
   fails **closed** — an unreadable `books_settings` row throws instead of resolving to
   `"external"`. A *missing* row still resolves to `"external"`, which is correct: an org
   that never enabled Books genuinely is external-authoritative.
   - `processAccountingPush` and `voidBillPaymentInAccounting` propagate the throw. Both
     inline "sync now" server actions wrap it in `run(...)`, so the user sees the error;
     the outbox worker retries.
   - `enqueueAccountingPush` deliberately tolerates the error and queues anyway.
     Queueing writes nothing externally and the processor re-checks the gate, so the
     durable gate is the one at push time and a transient blip never fails the user
     mutation that triggered the enqueue.
   - Both QBO inbound gates (CDC ingest, webhook drain) route through the resolver. The
     drain marks the single event `error` so it retries on the backoff rather than
     aborting the whole drain.
   - Guarded by `tests/arc-books.test.js` → *"the ledger authority gate has one
     implementation and fails closed"*, which also asserts no other module queries
     `books_settings` directly — that is how the three copies drifted into three
     different failure behaviours in the first place.
2. **Wire the mirror** — `mirrorJournalEntry` has no callers. See **C3.4**; the grain is
   wrong as well as unwired.
3. ~~**Warn before demoting.**~~ **DONE 2026-08-08 — standing is preserved, not warned
   about.** The disable path no longer writes `arc_ledger_mode: "disabled"`; it writes
   `workspace_enabled: false` only, so a `parallel` org that disables and re-enables is
   still `parallel`. This is safe because every consumer of the mode already pairs it
   with `workspace_enabled` (projector, rebuild drills, revenue recognition) — with one
   exception that had to be fixed in the same change: the cutover `parallel_mode`
   prerequisite read the mode alone, and would have let a switched-off workspace satisfy
   a prerequisite it stopped earning the day it was turned off. **No migration needed** —
   `books_settings_authority_mode_check` never tied the mode to `workspace_enabled`.
4. **Reconcile the CPA seat with the plan.** `org_accountant` holds `books.adjust`,
   `books.reconcile`, `books.close`, `books.export`, `books.tax` — the plan said
   read-only. **Investigated 2026-08-08; needs a human decision plus a migration, so
   nothing was changed.** Findings:
   - The re-scope looks *right* for the seat as described: `org_accountant` is the
     engaged CPA/controller who posts adjustments and closes periods. It is not
     `books.manage`, `books.reopen`, or `books.cutover`, so it cannot touch opening
     balances, reopen a closed period, or change ledger authority. That is a coherent
     line.
   - **The read-only variant does not exist.** The Books permission seed grants
     `books.*` to `org_owner`/`org_admin`, `org_office_admin`/`org_bookkeeper`, and
     `org_accountant`. No other role holds `books.read` — `org_viewer` included. A CPA
     who should review statements but never post has no seat at all; today the only
     options are full accountant or no Books access.
   - **To close it:** seed a read-only Books reviewer role (`books.read` + `report.read`)
     in a catalog-as-code migration, then add it to `ASSIGNABLE_ORG_ROLE_KEYS` and the
     description map in `lib/services/team.ts`. Adding an org role changes the member
     picker for every customer, so this is a product decision, not a cleanup.
5. ~~Harden cron auth.~~ **DONE 2026-08-08.** `isAuthorizedCronRequest`
   (`lib/services/cron-auth.ts`) now fails **closed** in production: without
   `CRON_SECRET` the request is denied, and the `x-vercel-cron` fallback is gone
   entirely — that header is attacker-settable on a public route and authenticated
   nothing. Outside production the secret is honored when configured and the gate is open
   when it is not, so a local `curl` against a job route still works.
   **⚠️ Deployment requirement: `CRON_SECRET` must be set in Vercel before this
   deploys, or every cron 401s.** Vercel sends it as `Authorization: Bearer $CRON_SECRET`
   automatically once the environment variable exists.
   Fifteen routes had drifted into nine hand-rolled copies of this gate — four of them
   *shadowing* the shared function's own name while trusting the forgeable header. All
   fifteen now import the one helper (182 lines deleted), and
   `tests/authorization-policy.test.js` guards both halves: behavioural tests for the
   gate itself, and a sweep asserting no `app/api/**/route.ts` reads `CRON_SECRET` or
   `x-vercel-cron` on its own.
6. ~~Guard `closeFiscalYearToRetainedEarnings`~~ **DONE 2026-08-07** — it now refuses
   when a posted `year_end_close` entry already exists for the period, rather than
   relying on posting-key idempotency. Original concern: guard against a second
   year-end entry after a
   period reopen — it relies solely on posting-key idempotency.
7. ~~Encode or explicitly waive the cutover gate.~~ **DONE 2026-08-08 — duration
   encoded, cross-org explicitly waived.** A new `quarter_of_silent_correctness`
   prerequisite measures the calendar the compared accounting periods actually cover, not
   how many runs a bookkeeper approved in an afternoon: three approved runs could
   previously all land inside one week, because nothing looked at what they covered.
   Math is pure and tested in `lib/services/books/cutover-rules.ts` — note the inclusive
   day count, because subtraction alone makes a calendar Q1 measure 89 days and would
   block a cutover that had earned it.
   The cross-org condition is **deliberately not encoded**: it is a platform readiness
   judgement about Arc, not a property of the org in front of the cutover screen, and
   encoding it per-org would make the first org's cutover unreachable forever. It stays a
   human gate on the cutover approval.
   Note the new prerequisite key changes the cutover `digest`, which invalidates any
   existing approval — that is the intended governance behaviour, and there are no
   cutover runs in production today.
8. `arc_ledger_mode` has four values but `shadow` and `parallel` are behaviorally
   identical in the projection path. Either differentiate them or collapse the enum.
   **Scoped 2026-08-08, not started.** Collapsing needs a migration (the check
   constraint). Differentiating is the more useful direction and is real work: the
   natural semantics are that `parallel` — and only `parallel` — requires a comparison
   run per period and surfaces its drift, which is what the cutover gate already assumes
   when it demands three approved zero-variance runs. That belongs with the reconciliation
   spine, not with a rename.

---

# PART II — New work

## Phase C1 — Correctness core — **COMPLETE (2026-08-07)**

> **⛔ Read the `invoices.retainage_cents` blocker in §0.1 first.** "Verified" below
> means lint, types, and unit tests — **not** the four data tie-outs in the Acceptance
> section, which cannot have run: the projector throws on its first invoice page. C1 is
> code-complete and unverified against data.
>
> **All nine directives below are implemented**: `pnpm lint` silent,
> `npx tsc --noEmit` clean, `pnpm test:financials` 317/317, `pnpm test:land` 23/23.
> Migration `20260807120000_books_c1_correctness_core.sql` is applied. The directives
> are kept as the record of what was built and why — read them to understand the
> posting model, not as work to do.
>
> **The one thing still outstanding from this phase is the human gate in directive 1:**
> a construction CPA has not yet signed off on the revenue-recognition entry set. The
> model implemented is the "preferred" option below. No organization advances past
> `shadow` until that sign-off exists.
>
> Key files: `books/posting-rules.ts` (pure rules), `books/fact-drafts.ts` (the single
> fact→draft function shared by projector and rebuild drill), `books/projector.ts`,
> `books/revenue-recognition.ts`, `books/revenue-basis.ts` (posture choke point),
> `books/verifier.ts` (tie-outs).

### What this was
The projector had to produce a ledger that is *right*. Every item here was a
correctness defect, not an enhancement.

### Directives
1. **Recognize revenue.** Decide the model with the human and a construction CPA, then
   implement one:
   - *Preferred:* the projector calls the POC rule on a schedule so revenue is earned
     continuously — invoice posts AR against `2350`, and the periodic POC entry moves
     `2350` → `4000` for earned revenue. This is the construction-correct model and the
     moat.
   - *Interim:* credit revenue directly on invoice and let POC adjust.
   Whichever ships, `postPocAdjustment` must acquire a real caller.
   **STOP: present the revenue-recognition entry set for sign-off before writing it.**
2. **Restore re-projection.** Include `projection_version` in `posting_key`, stop
   hardcoding `1`, and implement the plan's flow: bump version → re-project → verifier
   compares old vs new → drop the old version after review. Without this, every future
   posting-rule fix requires manual reversal of every affected entry.
3. **Fix the fact-hash trap.** Hash only the economically meaningful fields — exclude
   `status`, `updated_at`, and other lifecycle columns. A bill moving
   `approved → partial → paid` must not fail projection. Then wire a real repair path:
   the drift branch must reverse and repost, not throw forever and re-notify every ten
   minutes.
4. **Fix payment classification.** `projector.ts:105` treats any payment lacking both
   `bill_id` and `invoice_id` as a customer payment, fabricating AR credits from fee
   collections and settlements. Classify explicitly and reject the unclassifiable.
5. **Watermark and paginate the projector.** `since` is discarded (`void since`) and
   queries are unpaginated, so every run rescans every record for every org and silently
   truncates at PostgREST's row cap — records past the cap never project and nothing
   reports it. This is both a scale cliff and a silent-correctness cliff.
6. **Add the missing posting rules:** retainage release, CO approval, draw funding,
   early-pay discount (the fintech `manual_adjustment` becomes a real posting), and the
   POC adjustment wiring from directive 1.
   **Status 2026-08-07 — a rule with no caller does nothing, so this was audited by
   caller count, not by existence:**
   - *Retainage release* — **wired**, and it was hiding a double-count. Both release
     records are ordinary business documents (an AP release is a lineless `vendor_bills`
     row, an AR release is an `invoices` row), so they posted as new cost and new
     billing: `Dr 5000` for money already expensed on the original bill, `Cr 2350` for
     work already billed, and 2010/1110 never relieved. The projector now classifies
     both by source record and routes them to `postRetainageRelease`.
   - *Early-pay discount* — wired; `postBillPayment` credits `4910`.
   - *POC adjustment* — shipped as `postRevenueRecognition`; the old `postPocAdjustment`
     name no longer exists.
   - *Draw funding* — **correctly unwired; closed 2026-08-07.** `postDrawFunding` posts
     `Dr 1000 cash / Cr 2400 current debt`, which is a **construction loan** draw — a
     financing event. Arc's `draw_schedules` is a different thing entirely: an owner
     billing milestone that carries an `invoice_id` and reaches the ledger as an invoice
     (`Dr 1100 / Cr 2350`), with revenue following through percentage-of-completion.
     There is **no loan or lender table in the schema**, so this rule has no fact source
     and wiring it to `draw_schedules` would book owner billings as loan proceeds. It
     belongs with the financing entries below, awaiting the manual-JE surface.
   - *CO approval* — no rule exists. Change orders alter contract value, which feeds
     percentage-of-completion through the POC inputs rather than through a journal
     entry, so this may be correctly absent. Confirm with the C1.1 reviewer.
   - Also unwired and awaiting the manual-JE surface (C4.2), which is their only
     plausible caller: `postCustomerDeposit`, `postLoanPayment`, `postOwnerActivity`.
   - `postVendorBill` (the header-derived variant C2.2.1 superseded) is **deleted** — a
     parallel posting rule that bypasses the cost subledger is the most dangerous kind
     of dead code to leave callable.
7. **Add the WIP account and constrain the chart.** There is no `wip` subtype and no WIP
   account — vendor bills expense straight to COGS, so the percentage-of-completion moat
   has no balance-sheet home. Seed it, expand the chart toward the planned ~60 accounts,
   and replace free-text `subtype` with a constrained enum. Stop classifying income vs.
   expense by account-code string prefix in `postYearEndClose` — the account creator lets
   users violate it.
8. **Build the nightly verifier the plan required.** Per-entry balance (already trigger-
   enforced), trial balance sums to zero, and the tie-outs from C2.2 — run nightly, not
   only at close, and for **all** orgs. Today `runLedgerRebuildDrillForOrg` validates
   facts against facts (a projector that misread the source rebuilds to itself and passes
   forever) and skips shadow-mode orgs, i.e. every org.
9. **Retire the second write path.** Cron-driven recurring postings manufacture journal
   entries with no fact backing and would not survive a re-projection from zero. Give
   them facts or move them behind the projector. Manual adjusting journals are legitimate
   but are invisible to the rebuild drill — the drill iterates facts and can only report
   `missing_journal`, never `unexpected_journal`. Make it bidirectional.

### Acceptance — three of four proven; the fourth is blocked on QA data

The four tie-outs: full re-projection is deterministic (two runs byte-identical); trial
balance sums to zero; P&L job-cost total ties to `job_cost_entries`; AR/AP balances tie
to the aging reports.

**Status 2026-08-07.** Three are properties of the projection itself and are now proven
without a database by `tests/arc-books.test.js` → *"C1 acceptance: a full contract
lifecycle projects deterministically and balances"*. It drafts a nine-fact lifecycle
(bill with retainage → payment → AP retainage release → invoice with retainage →
receipt → AR retainage release → expense → labor → ACH return) and asserts byte-identical
re-projection, debits equal to credits across the whole set, GL job cost equal to the
cost lines fed in, and that **no operational fact ever books revenue directly** — 4000 is
reached only through percentage-of-completion.

**The fourth (AR/AP tie to the aging reports) cannot run yet, and the blocker is data,
not code.** Acceptance must run in the dedicated QA org, and **`Arc QA — Commercial`
holds no financial data at all**: 5 projects, zero bills, invoices, payments, or
job-cost entries. Enabling Books there today would project an empty ledger and every
tie-out would pass at 0 = 0 — a vacuous green, which is worse than a red. The orgs that
*do* hold data (`Patagonia Development LLC`, `Strata Construction LLC`) are customer
orgs, and CLAUDE.md forbids running acceptance scenarios in one.

**✅ QA ORG SEEDED 2026-08-08 — `scripts/seed-books-qa-org.js`.** 28 rows on
`Arc QA — Commercial Office Buildout`: a $4.25M prime contract, two vendor bills carrying
retainage (one paid and released, one still held), an AP retainage-release bill, three
invoices (one partly paid and partly ACH-returned with its retainage released, one pure
release invoice, one still holding retainage), a customer payment, a vendor payment, a
project expense, and field labor. Retainage is deliberately left **both held and released
on each side**, so `retainage_receivable_control` and `retainage_payable_control` compare
non-zero numbers rather than passing vacuously at 0 = 0.

The script is dry-run by default, requires `--commit` to write, re-reads the org name
before touching anything, carries a customer-org deny-list, is idempotent (re-running
inserts nothing), and supports `--rollback`. Every row is tagged
`metadata.seed_key = 'books-acceptance-v1'`. Verified: 28 rows in the QA org, **zero rows
in any other org**. It seeds source records only — it never writes `books_settings` or
`gl_accounts`, because enabling must go through the product:
`setBooksWorkspaceEnabled` also calls `initializeArcBooks`, which seeds the chart of
accounts, and a hand-written `books_settings` row would leave the org with no accounts
and fail every posting.

Source-level subledger totals verified against the hand-computed ledger: AP open
$46,000.00, AP retainage held $4,000.00, job cost $147,300.00, AR retainage held
$5,000.00, AR open $100,000.00 — all exact.

### ✅ ACCEPTANCE MET 2026-08-08 — all seven tie-outs green against real data

`20260808170000_books_balance_trigger_row_type_fix.sql` is **APPLIED**. Books is enabled
in `shadow` on `Arc QA — Commercial`, 11 facts are posted as 11 balanced journal entries,
and the nightly reconciliation records `status: passed`, `discrepancy_count: 0`,
`books_enabled: true`, `failed_checks: []`.

The posted ledger matches the position hand-computed from `posting-rules.ts` *before the
seed was written*, to the cent:

| Account | Ledger | Subledger | Tie-out |
|---|---|---|---|
| 1000 Operating cash | $2,500.00 Dr | — | — |
| 1100 Accounts receivable | $100,000.00 Dr | $100,000.00 | `ar_control` ✅ |
| 1110 Retainage receivable | $5,000.00 Dr | $5,000.00 | `retainage_receivable_control` ✅ |
| 2000 Accounts payable | $46,000.00 Cr | $46,000.00 | `ap_control` ✅ |
| 2010 Retainage payable | $4,000.00 Cr | $4,000.00 | `retainage_payable_control` ✅ |
| 2200 Payroll clearing | $4,800.00 Cr | — | — |
| 2350 Contract liabilities | $200,000.00 Cr | — | — |
| 5000 Job costs | $142,500.00 Dr | | |
| 5030 Direct labor | $4,800.00 Dr | | |
| **GL job cost (COGS w/ project)** | **$147,300.00** | **$147,300.00** | `job_cost_control` ✅ |
| **Trial balance** | **0** | | `trial_balance` ✅ |

`balance_sheet` ✅ follows from the trial balance: assets $107,500.00 = liabilities
$254,800.00 + equity −$147,300.00.

**None of the seven is vacuous** — every one compares a non-zero number on both sides,
which is exactly what seeding retainage both held *and* released on each side was for.
`4000 Construction revenue` is correctly absent: no operational fact books revenue
directly, and percentage-of-completion recognition runs at period close.

**C1's fourth acceptance criterion is closed.** All four tie-outs are now proven — three
by test, the fourth against data.

---

## Phase C2 — Unification (one accounting layer)

### What this is
One place where an economic event becomes debits and credits; everything else is a fact
source feeding it or a projection consuming it. Today there are five or six. This phase
is what turns "a GL exists" into "one accounting layer."

> **Landed 2026-08-07:** legacy journal export deleted (kind removed from
> `AccountingExportKind` and from the integrations panel); the job-cost export now
> reads `job_cost_entries` instead of recomputing a sixth cost derivation; the POC
> journal export resolves accounts from the chart rather than hardcoded strings;
> GL job cost derives from the subledger through `bill_lines` (C2.2.1, done in C1);
> payment fees reach the P&L and no longer double-count `fee_cents` against the
> processor/platform split; ACH returns and chargebacks post through a new
> `payment_reversal` rule.
>
> **Landed 2026-08-07 (C2.2.2 — the QBO import subledger bypass):** the importer no
> longer writes `job_cost_entries` itself. `lib/services/job-cost-actuals.ts` posting
> functions now accept an explicit Supabase client (`JobCostPostingContext`) so
> service-role callers can reach them, and `qbo/import.ts` routes through
> `postJobCostEntriesForProjectExpense` / `postJobCostActualsForVendorBill`. Imported
> costs therefore carry GMP classification, `budget_line_id`, and billable linkage for
> the first time. Two latent defects fell out of the consolidation and are also fixed:
> a split expense no longer leaves its pre-split *header* entry posted (it was
> double-counting against the budget in the in-app path, which the importer had gotten
> right), and the expense credit-sign rule moved from the QBO adapter into
> `lib/financials/job-cost-calculations.ts`, so editing an imported credit in Arc no
> longer flips it back to a positive cost. `qboImportedExpenseCostCents` is deleted.
>
> **Still open:** the full `payment_ledger_*` → `gl_accounts` mapping (C2.1.2 — the
> concrete outcomes of fees and returns in the P&L are now met without it, so this
> is a consolidation decision rather than a correctness gap); the dead
> `pending`/`approved` lifecycle states (C2.2.4); moving `propagateApprovalToLedger`
> out of `cost-plus.ts` (C2.2.5); retainage's three homes (C2.2.6); and the single
> reconciliation spine (C2.3).

### C2.1 — One posting engine — **COMPLETE**
1. ~~**Delete the legacy journal export.**~~ **DONE** — `AccountingExportKind` is now
   `"ap" | "job_cost"`; the kind is gone from the service and the integrations panel.
   Original defect: `createAccountingExport({ kind: 'journal' })`
   built double-entry rows from hardcoded English account names, dropped retainage
   entirely, and contradicted `posting-rules.ts`.
2. ~~**Fold the fintech payment ledger into the GL.**~~ **DECIDED AND DONE 2026-08-07 —
   Option B: the rails subledger stays out of the GL.**

   `payments` / `payment_reversals` are the single fact source for Arc Books.
   `payment_ledger_*` is now explicitly a rails-operations subledger with a module
   header stating so, and the reconciliation spine ties the two together via
   `rails_payment_missing_from_books` and `rails_payment_amount_mismatch` — every
   settled disbursement must have a matching `payments` row of the same amount. A guard
   test asserts `projector.ts`, `fact-drafts.ts`, and `posting-rules.ts` never reference
   `payment_ledger_*`, because re-introducing that is cheap to do by accident and
   expensive to discover.

   On the Arc-vs-builder question: `ach_return_loss` carrying the builder's `org_id` is
   **deliberate, not a defect** — `enforceReturnLossCeiling`
   (`payment-provider-events.ts:243`) needs the per-org total to decide whose rail to
   disable. Option B is what keeps it out of the builder's books: the loss lives in the
   rails subledger, which does not feed the projector. No separation work is needed.

   The investigation that produced this decision follows, because the rejected option
   is the intuitive one and will be proposed again otherwise.

   The original "preferred resolution" was to have the projector consume
   `payment_ledger_entries` as facts. **That option is now known to be wrong: it would
   double-post every rail payment.** `record_ap_payment_atomic`
   (`20260731221030_fintech_payment_foundation.sql:1387`) already inserts a `payments`
   row with `status = 'succeeded'`, the `bill_id`, and populated
   `processor_fee_cents` / `platform_fee_cents` / `fee_cents`. The projector consumes
   exactly that (`projector.ts`, statuses `succeeded|completed|paid`) and posts AP↓/cash↓
   via `postBillPayment` plus the fee expense. Meanwhile the payment ledger records the
   same economics across `postDisbursementSubmittedLedger` + `postDisbursementPaidLedger`
   (which net to vendor payable debit / org cash credit — the identical entry) and
   `postApFeeAccrualLedger`. Consuming both posts every rail payment twice.

   The premise behind the original preference has also expired: C1 fixed fees and
   returns through `payments` / `payment_reversals`, so the payment ledger no longer
   carries any economics the GL lacks. Its only unique contribution is
   clearing-account *timing* granularity (`ach_clearing` between debit and payout).

   The account map that Option A would have needed, kept as the record of what was
   *not* built: `org_cash`→1000, `vendor_payable`→2000,
   `processor_fee_expense`/`platform_fee_expense`→6050, `ach_return_loss`→6900, with
   `ach_clearing`, `payout_clearing`, and `arc_fees_payable` requiring new accounts.
   Option B needs none of it — no chart expansion, no mapping table, no second posting
   path.
3. ~~Route the POC journal export through the same account resolution.~~ **DONE** —
   `accounting-export.ts` resolves through `SYSTEM_ACCOUNT_CODES`, per B3 directive 6.

### C2.2 — One cost subledger, one derivation — **COMPLETE**
1. ~~**Derive GL job cost from `job_cost_entries`, not from bill headers.**~~ **DONE in
   C1.** Original defect: the projector
   currently reads header `total_cents` and header `project_id`; the subledger sums lines
   with line-level project attribution. Any bill with tax, freight, rounding, or a
   multi-project split diverges permanently and silently. Inverting this makes the
   GL↔job-cost tie-out true *by construction*.
2. ~~**Close the subledger bypass.**~~ **DONE 2026-08-07** — the importer calls the
   subledger service; see the landed note at the top of this phase. Original defect, for
   context: `lib/integrations/accounting/qbo/import.ts:1248-1362` was a hand-copied
   duplicate of `upsertJobCostEntry` that had already drifted — no GMP classification (so
   imported costs misclassified in GMP control), no `budget_line_id` (so they never
   bucketed by budget line), no billable linkage.
3. ~~**Delete the sixth cost derivation.**~~ **DONE** — the `job_cost` export reads
   `job_cost_entries`. Original defect: it recomputed cost from
   `project_expenses` + `bill_lines`, so it could not match the budget page.
4. ~~**Resolve the dead lifecycle.**~~ **DONE 2026-08-07, migration applied.**
   Both dead enums are dropped rather than implemented, because production
   had zero rows in either: `gmp-control.ts` now filters `"posted"` like every other
   reader, `JobCostSourceType` and the new `JobCostEntryStatus` are narrowed, and the
   two `Exclude<…, "manual_adjustment">` no-ops are gone. `manual_adjustment` and
   `allowance_overage` stay on `billable_costs` where they belong — they are
   billing-side corrections on cost-plus contracts whose underlying spend already
   posted its own entry, so `reports/reconciliation.ts` excluding them is *correct* and
   is now documented as intentional rather than reading as suppression.
   **`supabase/migrations/20260807180000_job_cost_lifecycle_cleanup.sql` was APPLIED
   2026-08-07** with human authorization; both tightened constraints verified in
   `pg_constraint` afterwards.
5. ~~Move `propagateApprovalToLedger` out of `cost-plus.ts`.~~ **RESOLVED 2026-08-07 —
   no move; the premise was dissolved by C2.2.2.** When this directive was written the
   function hand-rolled job-cost work. It no longer does: its job-cost side is now a
   single delegating call to `job-cost-actuals.ts`, and the remaining body is
   billable-cost orchestration (`upsertBillableCostFromBillLine` / `...FromExpense` /
   `...FromExpenseLine`, `getProjectCostContract`, `isCostPlusContract`) plus variance
   scanning — all cost-plus's own domain, all defined in `cost-plus.ts`. Moving it into
   the subledger service would make the cost subledger depend on cost-plus billing, an
   inversion; moving it to a new module would create a cycle, since `cost-plus.ts`
   calls it back at four sites. It is now correctly placed. Original directive, for
   context: move it into the subledger
   service that owns the table.
6. ~~Pick one home for retainage.~~ **DONE 2026-08-07** for the AR side — the `retainage`
   table is authoritative, read through `loadInvoiceRetainageCents`; see the resolved
   note in §0.1. Two pieces remain and belong to C2.3: `checkRetainageMismatch` still
   reconciles only the `retainage` table against invoice *lifecycle state* (never an
   amount, never the GL), and there is no `retainage_control` tie-out for accounts
   1110/2010. `postRetainageRelease` also still has no caller, so releases never reach
   the GL — the three release paths (`release_project_retainage_atomic`,
   `release_prime_sov_retainage`, `ap-retainage.ts`) all mutate subledger rows only.

### C2.3 — One reconciliation spine — **COMPLETE 2026-08-07**

> Built in two slices. Slice 2 (below the first note) lists what the finished spine
> covers and what was deliberately left out; read both before changing it.

> **Slice 1 — the org-keyed spine with real amounts.**
> `books/reconciliation.ts` is rewritten: `runOrgReconciliation(orgId)` replaces
> `runAccountingReconciliation(orgId, connectionId)`, the nightly sweep iterates orgs
> (any org with an active connection **or** `books.workspace_enabled`) instead of
> connections, and the five ledger tie-outs now run inside it — **completing C1
> directive 8, which was never actually wired**: `runLedgerTieOuts` had exactly one
> caller, the human-triggered period close, despite a docstring claiming it ran
> nightly. Tie-out failures persist as items populating `local_amount_cents` /
> `external_amount_cents` / `difference_cents`, three columns that had never been
> written by anything. All three B2 diff defects are fixed: the prior-run lookup now
> requires a *successful* run, prior items and sync records are paged with
> deterministic ordering instead of silently capped at 200, and a run is reused
> per org per day (backed by
> `20260807190000_reconciliation_run_daily_idempotency.sql`, **APPLIED 2026-08-07** and
> verified in `pg_indexes`).
>
> Period close now consumes the tie-outs for `ar_control` and `ap_control` instead of
> recomputing them against hardcoded `"1100"`/`"2000"` literals — that duplicate
> definition is gone, along with the now-dead invoice query, and clearing accounts
> resolve through `SYSTEM_ACCOUNT_CODES`. **Close-blocking semantics are deliberately
> unchanged:** the catch-all `accounting_drift` gate excludes `TIE_OUT_ITEM_CATEGORIES`
> so the dedicated control checks remain the single place a tie-out failure blocks a
> close. Widening what blocks a close is a governance decision, not a side effect.
>
> **Slice 2 landed 2026-08-07 — C2.3 is COMPLETE.** The spine now also runs:
> - **The eight project integrity checks**, via a new
>   `runProjectReconciliationChecks(ctx, projectId)` extracted from
>   `reports/reconciliation.ts`. The report page keeps its `invoice.read` authorization
>   and calls the same function — **one implementation, two callers**, which is what
>   "one reconciler" actually means. Each persisted item keeps the exception's `href`,
>   so a nightly finding still deep-links to the screen that cures it. These run for
>   *every* org: they reconcile operational records against each other and need no GL.
>   Bounded at `PROJECT_CHECK_CAP = 200` projects, with `projects_skipped` recorded in
>   `checked_counts` so a truncated pass can never read as a clean one.
> - **Bank coverage** — active bank accounts with no closed reconciliation, and posted
>   unmatched transactions.
> - **Two new tie-outs**, `retainage_receivable_control` (1110 vs `retainage` still held)
>   and `retainage_payable_control` (2010 vs unreleased `vendor_bills` retainage).
>   Those accounts were posted to by the invoice and vendor-bill rules but verified by
>   nothing, so retainage could drift indefinitely unnoticed. Seven tie-outs now.
>
> `tests/arc-books.test.js` guards the coupling: every tie-out code must have a matching
> `TIE_OUT_ITEM_CATEGORIES` entry and vice versa, so adding a tie-out cannot silently
> widen what blocks a close.
>
> **Deliberately NOT folded in, with reasons:**
> - `books/comparison.ts` (Arc ↔ external trial balance) needs externally supplied rows
>   that nothing produces. Running it nightly requires a provider-side trial-balance
>   fetch, which is **C3** work (`AccountingProvider` has no such capability yet). It
>   stays human-triggered until then.
> - `closeBankReconciliation` throws on a non-zero difference instead of recording it.
>   That is *correct* for the close action — an unbalanced reconciliation should not be
>   closeable — so the spine reports unreconciled accounts and unmatched transactions
>   rather than changing that behaviour.
> - `payment-reconciliation.ts` reconciles provider settlement against the rails
>   subledger and owns its own tables. It belongs to the fintech money layer, and
>   folding it in is gated on the **C2.1.2** decision about whether the payment ledger
>   becomes a fact source.
> - `qbo/reconcile.ts` repairs inbound records rather than reporting discrepancies;
>   `invoice-reconcile.ts` is document-scoped arithmetic; the rebuild drill is a
>   determinism check; `ops-watchdog` is liveness. None are reconciliation reporting.

> **Design constraints established 2026-08-07 — read before building.**
>
> 1. **The spine must be keyed on the ORG, not the connection.** `runNightlyAccountingReconciliation`
>    (`books/reconciliation.ts:175`) iterates `accounting_connections` where
>    `status = 'active'`, so an org with no external accounting connection is never
>    reconciled at all. Today that is **5 of 6 orgs**. The failure mode is exactly
>    backwards: an Arc-authoritative org may have no external connection by design, so
>    the posture where Arc owns the ledger currently gets the *least* verification.
>    `accounting_reconciliation_runs.connection_id` is already nullable, so this needs no
>    migration — connection-health items simply become one category among many, scoped to
>    a connection when one exists.
> 2. **`runAccountingReconciliation` compares no amounts.** It checks connection health,
>    staleness, non-synced sync records, and draft journals — a queue-drain monitor, not a
>    reconciliation. Every real tie-out has to be brought in; nothing can be reused from it
>    except the run/item plumbing.
> 3. **Fix the diff defects while collapsing** (B2 directives 2–3, all confirmed by
>    reading): the prior-run lookup at `:56-64` selects the latest run *regardless of
>    status*, so one failed run re-notifies every open item the next night; `priorItems` at
>    `:126` is capped at 200 **with no ordering**, making the comparison key set
>    nondeterministic above that; sync records at `:55` truncate at 200 silently; and there
>    is no unique on `(org_id, connection_id, run_date)`, so a re-invoked cron inserts a
>    second row and diffs against itself.

Collapse five reconcilers that never cross the seams that matter into a single nightly
tie-out engine writing `accounting_reconciliation_items`:
- per-entry balance, trial balance zero (from C1.8)
- **GL ↔ `job_cost_entries`** — the tie-out that exists nowhere today
- GL ↔ AR/AP aging, using **one** definition (the aging reports — `period-close.ts`
  currently blocks on hand-rolled subledger sums while importing the real reports only
  for snapshots, so two definitions can disagree silently)
- GL ↔ bank (from the Plaid match engine)
- Arc ↔ external trial balance for external-authoritative orgs, via the comparison
  machinery — which today requires externally supplied rows that nothing produces
- the project-scoped integrity checks from `reports/reconciliation.ts`, folded in as
  categories with their existing cure deep-links

The close checklist, drift notifications, and the cutover comparison all become
consumers of this one spine. No new reconciler is added outside it.

### Acceptance
One nightly job produces every discrepancy in the product. Removing any other
reconciler changes no user-visible output.

**Met, with one caveat.** The spine is the only producer of `accounting_reconciliation_items`
and every check now runs through one implementation. The clause *"the GL↔job-cost tie-out
is green on the QA org, and deliberately breaking a bill's line/header sum turns it red"*
is **not** demonstrated, for the same reason C1's fourth tie-out is not: the QA org holds
no financial data. See the C1 Acceptance section.

---

## Phase C3 — Finish the provider-neutral system — **historical status; C3.4 remains second-provider scope**

### What this is
The interface is genuinely neutral; everything outward from it is not. Adding a second
provider today means rewriting the connections service and building bespoke inbound. The
abstraction is a well-shaped promise until a second provider proves it.

### Directives
1. ~~**Neutralize the connection lifecycle.**~~ **DONE 2026-08-08.** The neutral service
   now contains **zero** `"qbo"` literals (was eight). `refreshAccountingConnectionToken`
   dispatches through the registry to `provider.refreshConnection` instead of throwing
   `Token refresh is not supported for <provider>` at everything else.
   **A security defect fell out of this:** `disconnectAccountingConnection` never called
   `provider.disconnect`, even though both adapters have implemented it since the
   interface was written — so "disconnected" in Arc left a live credential at the
   provider. It now revokes provider-side first, and a failed revoke is logged rather
   than allowed to strand the local row.
   The QBO token machinery moved to `lib/integrations/accounting/qbo/connections.ts`.
   That was not tidying: the registry eagerly imports the QBO adapter, so once the
   neutral service dispatched through the registry there was a genuine cycle, and the
   adapter's top-level `keepAliveConnections: refreshQBOConnectionsDueForKeepalive`
   binding would have resolved to `undefined` depending on which module loaded first.
   `getQBOConnection` had no callers anywhere and is deleted.
2. ~~**Route inbound through capabilities.**~~ **ALREADY DONE — verified 2026-08-08.**
   `app/api/accounting/process-changes` iterates connections, checks
   `capabilities.supportsCDC`, and calls `provider.ingestChanges`;
   `process-inbound` drains through `listProviders()`. The QBO adapter binds
   `receiveWebhook`, `ingestChanges` and `drainInboundEvents`. The `app/api/qbo/*`
   routes are 307 compatibility shims, not a second implementation.
3. ~~**Retire the QBO vocabulary.**~~ **DONE 2026-08-08** for everything that changes
   behavior. `qbo_connected`/`qbo_disconnected` are no longer emitted — every connect
   wrote two event rows saying the same thing, and a second provider would have had to
   invent its own pair. A new **`supportsImport` capability** replaces the import
   sheet's `provider?.key === "qbo"` check (a batch/file target can be written to but
   never read from), threaded through the queue DTO. The
   `synced: [..., "quickbooks", "qbo"]` search alias is gone: typing a brand name
   matched the synced filter while typing the name of any *other* connected system did
   not.
   **Still cosmetic and open:** the `qbo_sync_*` legacy outbox job-type names (kept
   deliberately — `ACCOUNTING_JOB_TYPES` already includes them so in-flight jobs
   enqueued under the old names still drain) and `logQBO`'s `provider: "qbo"` stamping
   inside the adapter, which is correct where it sits.
4. **Complete entity mapping as a layer.** **NOT STARTED — this is the whole remaining
   body of C3.** Re-measured 2026-08-08: **21 files, 168 `qbo_id` references** (the
   original "61 files / 184 refs" counted `qbo_*` columns generally). Complete the
   dual-read against `accounting_sync_records` + `accounting_account_mappings`, then —
   and only then — release the gated
   `supabase/pending-migrations/20260719001624_drop_qbo_columns.sql`. **Never touch that
   file until the dual-read is proven**, and releasing it is a destructive cutover that
   is a human decision regardless. This is what makes CLAUDE.md's "entity mapping is a
   layer, not columns" true.
5. ~~**Build the outbound mirror engine.**~~ **DONE 2026-08-08.**
   `mirrorPeriodSummary` (`books/external-mirror.ts`) mirrors one **closed** period as a
   single journal at account grain, through a new `pushSummaryJournal` capability on the
   provider interface. Only closed periods are mirrorable: mirroring an open period
   publishes a number that is still moving, and the external entry is not re-derived
   once posted. Idempotency is an `accounting_sync_records` row under
   `entity_type = "period_summary"`, so re-running is a no-op rather than a second entry.
   The netting and mapping are pure and tested (`books/mirror-rules.ts`): each account
   nets to a single debit-or-credit line, net-zero accounts are dropped, and lines are
   ordered by account code so a re-run is byte-identical.
   **It fails as a whole rather than per line.** An unmapped account with activity
   aborts the mirror and names the accounts to map — dropping it silently would publish
   an unbalanced journal that corrupts the CPA's trial balance instead of telling
   anyone the mapping is incomplete.
   `mirrorJournalEntry` (per-transaction) is retained but is still uncalled; it is the
   wrong grain for the mirror and should be deleted if nothing claims it by C5.

### Acceptance
A second provider ships as adapter code only — no changes to the connections service,
outbox, logger, or UI. An Arc-authoritative org's external system shows a clean monthly
summary a CPA can file from.

---

## Phase C4 — Arc Books product completeness

### What this is
What stands between "a correct ledger exists" and "a builder can run their company on
it." Sequenced *after* C1 — drill-down into a P&L showing zero revenue only makes a
wrong number more inspectable.

### C4.1 — Statements as a workspace surface — **BUILT; authenticated production QA remains an activation gate**

`/books/statements` is a real section: `components/books/books-statements.tsx` plus the
drill-down in `components/books/account-activity-sheet.tsx`, fed by
`lib/services/books/statement-detail.ts`.

1. ~~**Drill-down.**~~ **DONE.** Every account row on the P&L, balance sheet and trial
   balance opens its register, and each entry links to the bill, invoice or expense that
   caused it. Source links resolve through `SEARCH_CONFIGS[…].hrefTemplate` — the registry
   global search and notifications already deep-link with — rather than a second copy of
   the routes. Entries with no navigable source (labor, revenue recognition, year-end
   close, manual journals) render as plain text instead of a dead link.
2. ~~**Project dimension on the P&L.**~~ **DONE.** `buildProfitAndLoss` returns a
   per-account project split and a `byProject` summary; the surface has a By account /
   By project toggle, and an account row expands to its split where each sub-row drills
   down scoped to that project. Journal lines already carried `project_id`, so this is a
   second grouping over rows already loaded — no extra ledger read.
3. **Comparative periods — half done.** The P&L carries a prior-year column for whatever
   period is selected, and the picker offers this month / last month / QTD / YTD / last
   year. *Month vs. prior month as a distinct side-by-side comparison is not built* — the
   comparison column is always the prior year.
4. ~~**Account register.**~~ **DONE**, and it is the same service as the drill-down: a
   register is that list without a statement row to have arrived from. Written once,
   capped at 500 entries with the cap surfaced when it truncates.
5. ~~**Fix `buildCashFlowStatement`.**~~ **DONE.** It no longer assigns an entry's whole
   cash movement to its single largest non-cash counterpart. Allocation is pure and tested
   in `lib/services/books/cash-flow-rules.ts` (the `mirror-rules` / `cutover-rules`
   doctrine): split by weight across every counterpart, integer cents, remainder to the
   largest share so it always sums to exactly the movement. Verified against the QA
   ledger — net change in cash equals the actual movement in the cash accounts.

**Notes for whoever picks this up:**
- Statements are fetched on demand by `loadStatementsAction`, deliberately *not* added to
  `getBooksWorkspace`, which every other Books section already pays for on every page view.
  `read()` in `books/actions.ts` is the read-only twin of `run()`: it skips
  `revalidatePath`, because changing a period mutates nothing.
- The drill-down queries **entries first** with `lines:journal_lines!inner`. Not a style
  choice: `journal_lines` has no date, PostgREST orders a parent only by its own columns,
  and ordering a line query by an embedded `entry_date` is silently not the sort you asked
  for — which would make the 500-row cap slice an arbitrary page and the running balance
  meaningless.
- **⚠️ Unverified in a browser.** Types, lint and tests are clean and the route compiles
  (it 307s to signin when unauthenticated), but neither browser tool could reach an
  authenticated session, so nobody has actually looked at this yet. Empty, loading, error
  and truncated states are all written; **dark mode and real rendering still need eyes.**

### C4.2 — Manual journal entry and recurring postings UI — **BUILT 2026-08-08**

`components/books/books-journals.tsx` replaces the `/books/ledger` section, which
previously held a "Recent journal" list and a textarea asking a bookkeeper to hand-write
**JSON with integer cents**. Three panes:

- **Entries** — the audit view. Filters entries by where they came from
  (Hand-posted / Derived / Closing & reversals), expands to the lines, and shows who
  posted each one. This answers C1 directive 9's open question: hand-authored adjustments
  were legitimate but indistinguishable from projected entries except by reading
  `posting_key` prefixes. `isManual` draws the line at `adjusting | opening` — the kinds
  with no fact behind them. On the QA org the Hand-posted filter correctly returns zero:
  every one of the 11 entries came from the projector.
- **New entry** — the editor. Account pickers, dollars not cents, add/remove lines, an
  optional reversing date, and the **balance asserted while typing** rather than on
  submit. `useDraftProblem` surfaces exactly one reason it cannot post, in the order a
  person hits them, and the button stays disabled until there is none.
- **Recurring** — the manager. `createRecurringPostingTemplate` had **zero callers**
  since it was written; it now has a create form, a list showing schedule, next run and
  auto-post-vs-approval, and pause/resume via `setRecurringTemplateStatus`. Deleting is
  deliberately not offered: a template that has already posted is part of the ledger's
  history, and `completed` records that it stopped without pretending it never ran.

New services in `books/bookkeeping.ts`: `listJournalEntries`, `listRecurringPostingTemplates`,
`setRecurringTemplateStatus`. Types are exported and consumed by the client rather than
restated, so a shape change is a type error instead of a wrong render.

**`parseMoneyToCents` (`lib/financials/money-input.ts`) is pure and tested, and it does
not multiply by 100.** `1.005 * 100` is `100.49999999999999` in binary float, so
`Math.round` silently loses a cent at exactly the boundaries money lands on; it parses the
decimal string instead. Unreadable input returns `null`, never `0` — reading `"1.2.3"` as
a deliberate blank is how a wrong number reaches a ledger with nobody told. Separators are
stripped without validating placement, which is deliberate and noted in the test.

**⚠️ Unverified in a browser**, same as C4.1: types, lint and tests are clean and the
route compiles, but no authenticated session was reachable. Dark mode and real rendering
still need eyes.

### C4.2 — original directive, for context
Both services exist (`books.adjust`-gated with auto-reversal; recurring templates) and
**neither has a surface**. No bookkeeper will accept a ledger they cannot post an
adjusting entry into. Ship the JE editor (with the balance assertion surfaced live), the
recurring-template manager, and an audit view of entries by source.

### C4.3 — Cash-basis statements — **BUILT 2026-08-08; the STOP was resolved as "build it now"**

The human answered the sequencing question by asking for it, so accrual-only is no longer
the shape of the first release. Two surfaces: a **Cash basis** tab on `/books/statements`
and a `books-cash-basis` report in the catalog (CSV/PDF export and run history for free —
handing it to an accountant at year end is the entire use case).

**The conversion is derived from Arc's own posting rules, not approximated.** An invoice
debits AR + retainage receivable and credits contract liabilities; recognition later moves
contract liabilities into revenue. So over any period:

    gross billings = ΔAR + ΔRetainageReceivable + cash collected
    gross billings = revenue + ΔContractLiabilities
    ⇒ cash collected = revenue + ΔContractLiabilities + ΔCustomerDeposits
                       − ΔAR − ΔRetainageReceivable

and on the cost side, since a bill debits cost and credits AP + retainage payable while
field labor credits payroll clearing:

    cash paid = cost incurred − ΔAP − ΔRetainagePayable − ΔPayrollClearing

Both are exact identities for this posting model. **Verified against the QA ledger before
the code was written**: derived receipts $95,000.00 and payments $92,500.00 match the cash
that actually moved, and cash-basis net income $2,500.00 equals the change in the cash
accounts. Note this is the case where accrual and cash diverge hardest — accrual net income
for the same period is a $147,300.00 loss, because percentage-of-completion recognition has
not run.

Math is pure in `lib/services/books/cash-basis-rules.ts`; movements are read off the period's
own journal lines in `buildCashBasisStatement`, so there is no second ledger read and the
conversion cannot disagree with the accrual figures shown beside it.

**Presented as a reconciliation, not a number.** Every adjustment is a named line, and a
test asserts the lines actually reconcile accrual to cash — a cash-basis statement a CPA
cannot tie back to the accrual one is one they will not sign.

**The one simplification, stated on screen and in the code:** cost of revenue and operating
expenses convert together, because `2000 Accounts payable` is shared and the ledger does not
record which payable belongs to which. Splitting would mean apportioning AP by a ratio
nobody posted. Net income is unaffected.

**Still open, and it is not engineering's to close:** this is report-grade, not filing-grade.
It restates what is in the ledger and says nothing about tax elections, depreciation
schedules or method eligibility. **It wants the same construction-CPA review as C1.1** —
add it to that package rather than sending a second one.

### C4.3 — original directive, for context
The first release is scoped accrual-only, which is correct for WIP and POC. But most
small builders **file taxes cash-basis**. If Arc owns the ledger and cannot produce a
cash-basis P&L at year-end, the org cannot actually leave its old system — this sits
directly on the critical path of the small-builder thesis. **STOP: human decision —
launch requirement for the Arc-authoritative posture, or fast-follow?** Accrual-only
remains fine for shadow/parallel and for external-authoritative orgs.

### C4.4 — Bank feed completion — **COMPLETE 2026-08-08**

2. ~~**A real unmatched review tray.**~~ **DONE.** `components/books/bank-review-tray.tsx`
   leads the `/books/transactions` section; the register below is now read-only, showing
   the whole feed with a matched/needs-match badge instead of per-row action buttons.
   The tray loads every unmatched transaction **with its suggestion already scored**, so
   it can say "9 with a confident suggestion → Match 9 confident" rather than making
   someone open them one at a time. Runners-up ride along in the same payload, so picking
   a different line costs no round trip. Bulk confirm is deliberately **sequential**: each
   confirmation consumes a journal line and two transactions can be offered the same one.
3. ~~**Surface "bank account not mapped to a GL account" honestly.**~~ **DONE.** The old
   path returned `[]` for an unmapped account — indistinguishable from "we looked and
   found nothing" — and its one caller then told the user *"No posted ledger line matches
   this amount within ten days"* when nothing had been queried at all. The tray now names
   the unmapped accounts in a banner linking to Banking, and marks the affected rows.
1. ~~**Bank rules / auto-categorization.**~~ **DONE. Migration
   `20260808180000_books_bank_rules.sql` APPLIED 2026-08-08 with human authorization**
   (verified afterwards: 19 columns, RLS on with one `books.reconcile` policy, five
   indexes, the `updated_at` trigger, six checks, and the natural key confirmed to reject
   a duplicate even with a null `bank_account_id`).

   Rules are **learned from the categorization, not authored up front** — nobody writes
   bank rules before seeing the transactions. `categorizeBankTransaction` does three
   things together, and they only make sense together: posts the entry the transaction
   implies (debit the category / credit the bank for an outflow, reverse for an inflow),
   matches the transaction to the cash line it just created, and teaches the rule. Posting
   without matching leaves it in the tray forever; matching without posting matches
   against nothing.

   Selection is pure in `books/bank-rule-matching.ts` and prefers specificity over
   popularity: exact merchant over description substring, account-bound over any-account,
   direction-bound over any-direction, longer match value, then confidence. Auto-apply
   uses **B1's `CODING_RULE_AUTO_APPLY_HITS`**, not a second threshold, and learning runs
   through **B1's `nextCodingRuleCounts`** — so a rule earns and loses trust identically on
   both rails.

   The tray posts through `confirmBankMatch` rather than inserting a match directly: that
   function refuses unposted transactions and refuses confirmations exceeding the
   transaction amount, and re-implementing the insert would have skipped both guards.

**Structural cleanups that came with it:**
- `rankBankMatches` and `scoreBankMatch` moved to `lib/services/books/bank-match-rules.ts`,
  pure and no longer behind `server-only`. Bank reconciliation is a matching problem, and
  the matching rule could not be tested at all while it lived in a service module. Now
  tested: direction (an outflow can only be a credit to cash), exact amount, the ten-day
  window, lines already confirmed elsewhere, and rank order.
- `suggestBankMatches` and `matchBestBankTransactionAction` are **deleted**. The tray
  supersedes both, and keeping a second matching path would have been the fork this
  codebase keeps paying for.

**⚠️ The tray is unexercised: no org in the database has a bank account or a single bank
transaction.** Query shapes are verified and the empty state is what renders today, but
nothing has run against real feed data.

#### The C4.4.1 decision — bank rules do NOT belong in `coding_rules` (agreed 2026-08-08)

The directive says to reuse the B1 coding-rules engine "rather than fork". The **engine**
is reused: `nextCodingRuleCounts` and `CODING_RULE_AUTO_APPLY_HITS` are the curve and
threshold B1 spent a whole directive getting right, and bank rules call both unchanged.
The **table** is not, for three reasons found by reading it:

- *Different target.* A coding rule answers "which cost code does this vendor's bill
  belong to" (`cost_code_id` / `budget_line_id`); a bank rule answers "which GL account
  does this bank line hit" (`gl_account_id`).
- *Different match input.* `selectCodingSuggestion` filters on `company_id` first and
  falls back to a vendor name. A bank transaction has no company — it has free text a bank
  wrote. That selector cannot serve bank rules without being rewritten around a different
  key.
- *The enum was just narrowed on purpose.* Migration `20260808150000` cut `match_kind` to
  `vendor | vendor_memo` and recorded that a new kind "returns with its own migration"
  because it is a feature, not a cleanup. Adding `description_contains` back into that
  enum re-creates exactly the drift B1.8 removed.

The migration therefore creates `bank_rules` with its own enum and a `gl_account_id`
target, scoped by `books.reconcile` (no new RBAC key — same job, automated).

**One structural note for whoever touches this next:** `bank-rules.ts` needs
`confirmBankMatch` from `bank-reconciliation.ts`, and the review tray in
`bank-reconciliation.ts` needs the rules to suggest a category — a real import cycle.
It is broken by the leaf `books/bank-rules-data.ts`, which owns `loadBankRuleCandidates`
and depends on neither. Books has paid for a cycle like this once already (C3.1, where a
top-level adapter binding resolved to `undefined` depending on load order); do not
re-introduce it by moving that loader back.

### C4.4 — original directive, for context
1. **Bank rules / auto-categorization** — the Plaid feed is half a product without them,
   and the B1 coding-rules engine is the obvious substrate to reuse rather than fork.
2. **A real unmatched review tray** — unmatched transactions are currently an inline
   register filter.
3. Surface "bank account not mapped to a GL account" honestly — `suggestBankMatches`
   returns `[]` when `gl_account_id` is null, so a misconfigured account looks identical
   to one with no matches.

### C4.5 — The compliance tail — **historical analysis; all three implemented by 2026-08-12**

The original analysis below is retained to document why full TIN storage and typed
tax inputs were initially deferred. The current implementation resolves both:
service-only Vault functions store/rotate complete TINs while the product retains
only last-four, and typed jurisdictions plus payable use-tax inputs feed the tax
register, job-cost ledger, customer billing, and close gates.

3. ~~**Guided "Start Books on `<date>`".**~~ **DONE.**
   `components/books/opening-balances-wizard.tsx` replaces a textarea that wanted
   hand-written JSON with integer cents. Paste the trial balance out of the system you are
   leaving; Arc reads it, auto-maps each line to a GL account by code then by name, leaves
   anything it cannot match for a human, and asserts the balance live before the batch can
   be validated. The existing dual-approval flow (owner + CPA, then post) is unchanged.
   **The "your history stays in your old system" explainer is at the top of the surface**,
   where the anxiety actually is, not in the docs.
   Parsing is pure and tested in `lib/financials/trial-balance-import.ts` — an unreadable
   amount is a reported problem, never a silent zero, because opening the books on a wrong
   number that happens to balance is the failure mode here. The comma case earned a comment:
   a CSV separates cells with commas while the export writes `125,000.00` inside one, so
   splitting on every comma halves the balance. Caught by the test, not by review.

**Items 1 and 2 were investigated and deliberately not built. Both would have produced
convincing machinery with no inputs.**

1. **1099 filing-grade — needs a vendor decision, and the directive already offers it
   ("or pick a filing partner").** The report is in better shape than the directive
   suggests: it excludes card and third-party-network payments correctly, which is the
   1099-K boundary most implementations get wrong, and it already tracks W-9 status, TIN
   verification, backup withholding and per-vendor blocking reasons.
   **The blocker is architectural and deliberate: Arc never stores a full TIN.**
   `tax_identity_refs` holds `vault_provider` / `vault_reference` / `tin_last4` — the full
   number lives in a vault, and the table has zero rows. You cannot file a 1099 without the
   full TIN, so "filing-grade" means either starting to store TINs (a serious liability
   change) or a filing partner who already holds them. The vault design points at the
   partner. **This is a product/vendor decision, not an implementation.**
2. **Sales/use tax — the field is not the problem.** `metadata.tax_jurisdiction` is **read
   in exactly one place and written nowhere in the codebase**; zero invoices in production
   carry it. Typing it would produce a typed column that is still always empty, because
   nothing *collects* a jurisdiction at invoicing. And use tax is uncomputable in
   principle, not just in practice: `vendor_bills` has **no tax column at all**, so there is
   no record of tax charged on a purchase to self-assess against. Only 4 invoices in the
   entire database carry any tax.
   Building `tax_jurisdictions` + typed FKs + use-tax self-assessment now would be a
   speculative subsystem with no demand signal and no inputs. Instead
   `buildSalesUseTaxSummary` now **reports its own limitations as findings** — how many
   invoices carry no jurisdiction and why, and that use tax is absent because the data does
   not exist — so an accountant reading the package cannot mistake it for a return.
   **Build it when a customer actually charges sales tax**, and build the collection point
   (a jurisdiction on the invoice, a tax amount on the bill) before the reporting.

### C4.5 — original directive, for context
1. **1099** is report-grade; make it filing-grade (or pick a filing partner).
2. **Sales/use tax**: jurisdiction lives in untyped invoice `metadata` and silently
   buckets everything to "Unassigned"; use tax (self-assessed purchases) is not computed
   at all. Make jurisdiction a typed, enforced field before this is credible.
3. **Guided "Start Books on `<date>`"** — opening balances work, but as a generic
   file/line import. Build the guided flow from an external trial balance, with the
   "history stays in your old system" explainer at that surface. Never attempt full
   historical migration.

### C4.6 — Definition-of-done sweep — **code-complete; real-data browser QA is an activation gate**
Empty states are sparse (five in a 1,500-line client; the journal list, chart of
accounts, and bank transaction register have none). CLAUDE.md requires empty, loading,
error, and dark on every view — Books does not currently clear its own bar.

---

## Phase C5 — Second and third providers

Strategy: **Arc Books eats the long tail.** Live adapters exist only for organizations
too big or too unwilling to switch. That population concentrates in three products.

| Tier | Provider | Rationale |
|---|---|---|
| Live (shipped) | **QuickBooks Online** | Most residential, small commercial, small production. |
| Live — next | **Sage Intacct** | Highest-value second adapter: modern API, journal-entry push (so it doubles as a mirror target), dimensions map onto the existing `class/location/department` model, and it is where the commercial ($5–50M GC) segment is migrating. This is the adapter that proves C3. |
| Live — third | **NetSuite** | The production-builder endgame at 100+ closings/yr. Heavier lift (SuiteTalk, multi-entity). Gate on real production-tier pipeline demand. |
| File/batch tier — **no live adapter, ever** | **QuickBooks Desktop/Enterprise, Sage 100 Contractor, Sage 300 CRE, Foundation** | No practical cloud APIs (QBD's Web Connector is a maintenance tarpit; the others are on-prem). Serve them through the already-registered `file` provider: AP batches, job-cost batches, and monthly summary journals in each system's import format. ~20% of the effort of a live adapter for a large share of commercial and production orgs. These firms stay on their ERP for certified payroll and union reporting — which Arc correctly refuses to build — so file-tier is the *right* relationship, not a compromise. |
| Optional | **Xero** | Low US construction share; trivially close to the interface (`etag` concurrency already modeled) and supports journal push. Worth doing only as a fast abstraction-proving exercise or for international ambitions. |
| Never | MarkSystems, NEWSTAR, BRIX, Viewpoint Vista/Spectrum, CMiC | Homebuilder ERPs are competitors; enterprise ERPs are above Arc's segment. |

Directive: **build the file/batch tier before the second live adapter.** It is cheaper,
it unlocks more orgs, and it is the universal mirror target that lets any org go
Arc-authoritative regardless of what their CPA uses.

---

## Sequencing

## ▶ If you are picking this up fresh, start here

> ### Session handoff — 2026-08-08
>
> **Tree state:** `pnpm lint` silent, `npx tsc --noEmit` clean, `pnpm test:financials`
> 380/380, `test:auth` 107/107, `test:land` 23/23. Nothing is half-finished.
>
> **One migration was APPLIED this session** with explicit human authorization, verified
> in `pg_constraint` afterwards: `20260808150000_coding_rule_enum_cleanup.sql` (B1.8).
> `coding_rules` was empty in production, so it carried no data risk.
>
> **New files:** `lib/services/books/authority.ts` (the one ledger-authority resolver)
> and `lib/services/books/cutover-rules.ts` (pure cutover gate math). Note
> `lib/services/books/fact-drafts.ts` and `verifier.ts` are still untracked from earlier
> C1 work.
>
> **B1, B2 and B3 are all COMPLETE as of this session.** Read the struck-through
> directives for what was built and why rather than re-deriving any of it. New pure
> modules worth knowing about: `lib/services/accounting-rules.ts`
> (`nextCodingRuleCounts`, `isCodingCorrection`) and `lib/financials/poc-inputs.ts` (the
> one definition of every percentage-of-completion input, shared by the snapshot, the
> WIP report, and the budget page).
>
> **Two behaviour changes worth knowing before you touch these areas:**
> 1. **Period close now freezes the WIP statement as of `period_end`**, not as of the
>    day the close is run — `asOf` on the WIP report used to be accepted and ignored.
> 2. **Billed-to-date has one definition now** (invoices in the billed statuses). The
>    WIP report's old fallback to the budget summary's line-derived
>    `total_invoiced_cents` is gone, so a project with no billed invoices now correctly
>    reads 0 rather than a different quantity.
>
> **⚠️ Before this branch deploys: set `CRON_SECRET` in Vercel.** Cron auth now fails
> closed in production (B5.5), so without it every cron route 401s. Vercel sends it as
> `Authorization: Bearer $CRON_SECRET` automatically once the env var exists.
>
> **C1 and C2 are code-complete.** Do not re-derive their defects — the directives are
> struck through with what was found and why. Two C1 items remain open and neither is
> engineering's to close alone: the CPA signature, and the fourth acceptance tie-out
> (blocked on the QA org having no financial data, not on code). **The user has chosen to
> skip both for now and keep implementing.** Skipping them blocks nothing except
> `shadow` → `parallel`, which the standing STOP already gates.
>
> **B5 is now mostly closed: 1, 3, 5, 6, 7 are done** — read the struck-through
> directives for what was built and why rather than re-deriving them. **B5.2 is C3.4's
> work** (the mirror engine), not B5's.
>
> **Two B5 items remain, and both are blocked on a human, not on engineering:**
>
> 1. **B5.4, the read-only CPA seat.** Investigated and written up in the directive. The
>    short version: `org_accountant`'s posting scope looks correct, but there is no
>    read-only Books seat at all — no role outside the five that hold `books.*` has even
>    `books.read`, `org_viewer` included. Closing it means seeding a new org role in a
>    catalog-as-code migration, which changes the member picker for every customer. That
>    is a product decision.
> 2. **B5.8, `shadow` vs `parallel`.** Scoped in the directive. Collapsing the enum needs
>    a migration; differentiating is the better direction and belongs with the
>    reconciliation spine.
>
> **C3 directives 1, 2, 3 and 5 are DONE; only 4 remains** — and 4 is the whole
> remaining body of the phase: the `qbo_*` column dual-read across **21 files / 168
> `qbo_id` references**, ending in the release of the gated
> `pending-migrations/20260719001624_drop_qbo_columns.sql`. That release is a
> destructive cutover and a human decision; the dual-read that has to precede it is not.
> Two new files worth knowing: `lib/integrations/accounting/qbo/connections.ts` (QBO
> token machinery, moved out of the neutral service to break a real import cycle) and
> `lib/services/books/mirror-rules.ts` (pure period-summary netting).
>
> **Next after that: C4**, whose highest-value item is C4.1's drill-down — P&L line →
> journal entries → source document.
>
> ### Session handoff — 2026-08-08 (later)
>
> **The QA org is seeded.** `scripts/seed-books-qa-org.js` put 28 rows on
> `Arc QA — Commercial Office Buildout` — the full contract lifecycle, retainage both held
> and released on each side. Dry-run by default, `--commit` to write, `--rollback` to
> remove, idempotent, guarded by an org-name re-read plus a customer deny-list. See the C1
> Acceptance section. `pnpm lint` silent, `npx tsc --noEmit` clean, `tests/arc-books.test.js`
> 39/39.
>
> **Seeding surfaced a real defect, and it is now fixed.** `saved` invoices sat in the AR
> subledger and the aging report while never posting to 1100 — three definitions of AR,
> four of AP. All of them now import `lib/financials/ledger-status.ts`, which is the only
> declaration. See §0.1 for what changed and the one question left open (AP aging's
> retainage arithmetic). **Read that entry before touching AR/AP filters again.**
>
> **Arc Books has posted its first real ledger, and all seven tie-outs are green** — see
> the acceptance table in the C1 Acceptance section. **C1 is now fully accepted**; the only
> thing still outstanding from that phase is the C1.1 CPA signature, which gates
> `shadow → parallel` and nothing else.
>
> Getting there took four defects, and **three of them were invisible until the jobs
> actually ran against data**: the `saved`-invoice AR definition, the journal balance
> trigger, the stranding watermark, and the reconciliation's non-existent `updated_at`
> column. Every one was masked by something reporting success — a green cron, an empty
> table, a passing test suite over a path that never executed.
>
> **Do not read an empty table or a green cron as "nothing has happened yet" again.**
> Run the job, read the rows, compare the numbers to one you computed independently.
>
> **C4.1 and C4.2 are built** — `/books/statements` (statements, drill-down, project
> dimension, fixed cash flow) and `/books/ledger` (entry editor, recurring manager, audit
> view). Both are **unverified in a browser**: no authenticated session was reachable from
> either browser tool, so dark mode and real rendering still need eyes before either is
> called done.
>
> **C4.3 is built too** — cash basis on the statements surface and in the report catalog.
> The STOP is resolved: it shipped as a launch requirement rather than a fast-follow. It
> wants CPA review, which should be folded into the C1.1 package rather than sent separately.
>
> **C4.1 through C4.4 are COMPLETE.** Migration `20260808180000_books_bank_rules.sql` is
> applied; `bank_rules` is a separate table from `coding_rules` by decision, sharing the
> learning engine but not the schema — read the C4.4.1 note before changing it.
>
> **Statements, journals and cash basis were reviewed in a browser 2026-08-08 and look
> right.** The bank review tray and categorization were **not, and cannot be yet** — no org
> in the database has a bank account or a single transaction, so only the empty state has
> ever rendered. Query shapes, the natural key and the pure rules are verified against the
> live table; the flow is not. **Exercise it the first time a Plaid account is connected.**
>
> **C4.5 is done as far as engineering can take it.** The guided "Start Books on a date"
> flow shipped. 1099 filing-grade and sales/use tax were investigated and deliberately not
> built — read the C4.5 entry before picking either up, because both look like coding tasks
> and neither is:
> - **1099** is blocked on Arc never storing a full TIN (deliberate — `tax_identity_refs`
>   is a vault reference). Filing needs a partner, which is a vendor decision.
> - **Sales/use tax** has no collection point: the jurisdiction field is written by nothing,
>   and `vendor_bills` has no tax column, so use tax has no input at all. Four taxed
>   invoices exist in the whole database.
>
> **Next: C4.6, the definition-of-done sweep** — empty/loading/error/dark on every Books
> view. Note the new C4 surfaces were written with all four states, so the sweep is mostly
> about the older sections.
>
> **Three decisions are queued for the human:** the 1099 filing partner, whether cash basis
> joins the C1.1 CPA package, and B5.4 (the read-only CPA seat) which has been open since
> 2026-08-08.
>
> **C4 is otherwise unblocked and has data to build against.** C4.1's drill-down and the
> project dimension on the P&L now have a real ledger to render once Books is enabled.
>
> **Two items are parked on a human decision, both needing a migration:** B5.4 (the
> read-only CPA seat) and B5.8 (`shadow` vs `parallel`).

1. **C1 and C2 are code-complete (2026-08-07).** Two things remain, and neither is
   engineering's to finish alone:
   - **C1.1 — construction-CPA sign-off.** The review package is written and ready to
     send: `docs/books-revenue-recognition.md`. Only the signature is outstanding.
   - **The fourth acceptance tie-out** (AR/AP vs the aging reports) is blocked on the QA
     org holding no financial data. See the C1 Acceptance section. The other three are
     proven by test.
2. **Then the rest of C2 — definitions before the spine.** The original ordering put
   C2.3 first; that is wrong. C2.3's whole job is to encode *one* definition per
   tie-out, so the items that decide those definitions must land first, while
   `journal_entries` and `accounting_facts` are still empty and every change is free:
   - ~~**C2.2.4 the dead lifecycle**~~ — **DONE 2026-08-07**, migration applied.
   - ~~**C2.3 the reconciliation spine**~~ — **DONE 2026-08-07**, both slices; see the
     phase body for what it covers and what was deliberately left out.
   - ~~**C2.2.5**~~ — **RESOLVED 2026-08-07 as "no move"**; see C2.2 directive 5.
   - ~~**C2.1.2**~~ — **DECIDED 2026-08-07 as Option B**: the rails subledger stays out
     of the GL, reconciled by the spine. **C2 is complete.**
3. ~~**Then B5 remediation.**~~ **Directives 1, 3, 5, 6, 7 DONE 2026-08-08.** Only 4
   (the read-only CPA seat — needs a migration and a product decision) and 8 (`shadow`
   vs `parallel`) remain, plus 2 which is C3.4's work.
4. ~~**Then B1/B2/B3 remediation.**~~ **ALL COMPLETE 2026-08-08.** B1's last directive
   landed behind an applied migration; B2 and B3 needed none.
5. **Then C3, C4.** C5 is explicitly deferred pending a provider decision from the
   human.
6. **Always:** `pnpm lint && npx tsc --noEmit` (tsc needs
   `NODE_OPTIONS=--max-old-space-size=8192` on this repo) plus `pnpm test:financials`.

| Phase | Gate to start | Standalone value |
|---|---|---|
| ~~**C1 correctness core**~~ | **code DONE 2026-08-07; acceptance tie-outs still unrun** | a ledger that is right; CPA sign-off still gates shadow → parallel |
| ~~**C2 unification**~~ | **COMPLETE 2026-08-07** | one accounting layer; tie-outs true by construction |
| ~~B1 remediation~~ | **COMPLETE 2026-08-08** | zero-touch coding is measurable and rules recover |
| ~~B2/B3 remediation~~ | **COMPLETE 2026-08-08** | real reconciliation; one POC computation, snapshot-backed WIP |
| C3 provider-neutral completion | **1/2/3/5 DONE 2026-08-08; 4 (dual-read) open** | a second provider becomes adapter-only work |
| C4 Books completeness | C1; C4.1 needs C2.2 for the project dimension | a builder can run their company on Arc |
| C5 file tier | C3.5 (mirror grain) | huge coverage of commercial/production at low cost |
| C5 Intacct | C3 complete | the $5–50M GC market |
| C5 NetSuite | demand signal | production-tier retention |
| B5 authority cutover | C1 + C2 + C4.3 decision; a quarter silent-correct across multiple orgs; human decision | optional independence from external accounting |

Every phase: `pnpm lint && npx tsc --noEmit` clean, `pnpm test:financials` extended,
migrations additive and explicitly released, entity registration checklist for every new
table, empty/loading/error/dark on every surface, and no `qbo_*` columns EVER.

## Positioning note (carry into every phase)

Do not measure Arc Books against QuickBooks' feature surface — that race is unwinnable
and it is the wrong race. QBO's weakness is that it knows nothing about construction: it
cannot tie a ledger to a schedule, a draw, a retainage split, or a WIP position. Arc's
winning position is this plan's original thesis made real — a GL *derived* from
operations, always reconciled by construction, with POC and WIP no generic ledger can
compute. Every unification directive above serves that: one posting engine, one
subledger, one reconciliation spine is what makes "the close is already green" a
property of the architecture rather than a marketing line.
