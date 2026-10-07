# Arc Books — period close, year end and reopen

How an accounting period closes, what the close posts, how a fiscal year
transfers its earnings to retained earnings, and the rules for reopening.
Traced from `lib/services/books/period-close.ts` and the bank statement SQL;
proven end to end by the golden scenarios CLOSE-01, YEAR-01, BANK-01 and
RACE-01 (`scripts/books-acceptance/`). Where this document and the code
disagree, the code wins — fix this document.

## Close sequence

`closeAccountingPeriod(periodId)` runs as one recoverable attempt:

1. **Freeze.** `begin_books_period_close` moves the period to `reviewing`. A
   second close of the same period refuses ("close is already running"). While
   `reviewing`, the posting guard refuses every operational journal dated in
   the period; only close-owned entries (revenue recognition, expected-loss
   provision, year-end close) may post.
2. **Checklist.** `runBooksCloseChecklist` runs before anything is posted. Any
   blocking failure ends the attempt with `Close blocked: <labels>` and the
   period returns to its prior status. Blocking gates include unposted drafts,
   unreviewed manual journal proposals, unreconciled bank and card accounts,
   unmatched statement lines, open reconciliation findings (including sources
   blocked by a closed period), WIP not reviewed through period end or reviewed
   before a later cost, control tie-outs (job cost, AR, AP, customer deposits,
   debt, fixed assets) and unsupported clearing balances (1010, 2200, 2220,
   2230). Coding exceptions block only when an external provider is synced.
3. **Close-owned entries.** Percentage-of-completion revenue through period end,
   expected contract losses, and — for fiscal period 12 or 13 — the year-end
   transfer below.
4. **Statements.** Trial balance, P&L, balance sheet, cash flow, general ledger,
   AR/AP aging and WIP are built as of period end and saved to
   `financial_statement_snapshots` (immutable; identical content is stored once).
5. **Lock.** One update sets `status = 'closed'`, the `close_digest` over the
   checklist and statements, and `close_snapshot_ids` — the exact saved
   statements this close stands on.

If any step after the freeze fails, `cancel_books_period_close` restores the
prior status and the period keeps no digest. Close-owned entries already
posted by the failed attempt are recomputed as deltas on retry, so the retry
finishes with exactly the books a clean close would.

If the process itself stops after the freeze (a deploy, a timeout, a crash),
nothing runs the cancel. The freeze records `close_started_at`,
`close_started_by` and `close_prior_status`; a period still `reviewing` 30
minutes after its freeze is an **abandoned close**. The next close resumes it —
checks run again first — and the close screen says so and offers **Resume
close**. Until then the period stays frozen: operational postings remain
refused, and a second close inside the 30 minutes refuses as already running.

## Year-end transfer

`closeFiscalYearToRetainedEarnings` runs inside the close of the final fiscal
period (it is refused once that period is closed). It reads every income,
cost-of-sales and expense account from the fiscal year start through period
end, **including earlier year-end entries**, and posts one closing entry
(`source_type = 'year_end_close'`, `entry_kind = 'closing'`) dated the fiscal
year end:

| Account balance (normal-balance signed) | Line |
|---|---|
| Income, credit balance | Dr the income account |
| Income, debit balance (refunds exceed revenue) | Cr the income account |
| Cost of sales / expense, debit balance | Cr the account |
| Cost of sales / expense, credit balance | Dr the account |
| Net income ≠ 0 | Cr 3100 retained earnings (Dr for a loss) |

- Balance-sheet accounts — owner contributions (3010) and distributions (3020)
  included — are never closed.
- A break-even year still clears its income-statement accounts and posts no
  3100 line; a year with no income-statement balances posts nothing.
- The P&L excludes closing entries, so a closed year still reports its
  earnings; the balance sheet reports later years' unclosed earnings as current
  earnings.
- Fiscal years are named for the calendar year in which they start
  (`books_settings.fiscal_year_start_month`).

## Reopen

`reopenAccountingPeriod` requires a substantive reason and is recorded as an
event carrying the prior digest.

- **Periods reopen newest first.** A period cannot reopen while any later
  period is closed. This keeps every later close's saved statements truthful
  and guarantees a correction inside a closed fiscal year flows through the year
  end: the year end must be reopened, and its reclose posts only the residual
  change (a correction of 700 posts a 700 delta to 3100; an unchanged reclose
  posts nothing). The close screen shows this guidance instead of a reopen
  button on an earlier period.
- A reclose takes a new digest and replaces `close_snapshot_ids`; earlier
  statement sets remain for history.
- Bank statements follow the same rule: a statement cannot reopen while a later
  statement of the same account is closed, nor while an overlapping accounting
  period is closed. Reopening archives the frozen evidence in
  `evidence_history`; an unchanged reclose reproduces the same proof digest.

## Sources dated into a closed period

A document dated into a closed period (for example a bill approved after its
month closed) is not re-dated and does not post. The projector records a
`projection_blocked_by_closed_period` finding with a link back to the source,
the source's posting status reads **blocked**, the previously posted money is
left untouched, and the finding blocks later closes until the period is
reopened (or the source is corrected). Reprojecting after the reopen posts the
source on its own date and resolves exactly that finding.

## Operating notes

- Undeposited funds and payroll clearing balances carried past month end need a
  clearing-support review (amount, expected settlement date, explanation and an
  `https` evidence link per balance) before close.
- Every project not sold at closing is percentage-of-completion and needs its
  WIP position prepared and reviewed through period end; a cost approved after
  the review blocks close until WIP is re-reviewed.

## Subledgers as of a past date

- **One dated population.** AR and AP aging and the AR/AP tie-outs share the
  rules in `subledger-settlements.ts`: a document counts from its own date,
  receipts, payments, reversals and credits from theirs. A voided invoice, or a
  bill returned to pending, counts until the ledger removed it
  (`loadLedgerRemovalDates`): on its own date when its month was still open, so
  it reads as never issued; otherwise on the reversal date. Documents that never
  posted fall back to their recorded void time.
- **Closed months stay closed.** Returning a bill to pending, or voiding or
  revising an invoice, whose posting sits in a closed month is refused with the
  cure: reopen that month, or record a vendor credit or credit memo in an open
  month (`assertNotPostedInClosedPeriod`). Aging for a closed month's end is the
  aging saved at close (heading "as closed"); the close saves it across every
  project, including those excluded from reporting, because the ledger holds them.
- **Restatement.** Reopening records the reason; reclosing saves new reports and
  keeps the earlier close's saved reports, so both versions and why the month
  reopened stay on record.
- **Opening items.** Open invoices and bills at cutover come over as the
  documents they are: their own number, date and customer or vendor. A missing
  due date stays missing ("no due date" in aging). An opening batch missing any
  of this is refused with every fix listed at once, and cutover blockers read as
  fixes rather than codes.
