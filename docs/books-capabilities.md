# Arc Books: policy and capabilities

What Arc Books does for the first subscribing builder, and what it does not.
Each row points to the reference doc that holds its entries and rules, the
screen where the work happens, and the golden scenarios that prove it
(`scripts/books-acceptance/`). The acceptance state is the tracker's
(`advisor-plans/013-arc-books-completion-checklist.json`) as of 2026-10-08;
"verified" means proven end to end on the isolated acceptance stack, not yet in
production with a customer.

## Accounting policy

- **One ledger.** Every Books posting is a balanced journal entry on one
  double-entry ledger, built from source documents by the projector
  (`books-posting.md`). Posted entries are never edited or deleted; corrections
  are reversals and new entries.
- **Who keeps the books.** Each organization has one ledger authority
  (`getFinancialAccountingMode()`): `official` (Arc keeps the books), `parallel`
  or `shadow` (a connected provider keeps them and Arc runs beside it), or
  `external` (Arc only syncs). The first client starts in `parallel`; promotion
  needs reconciled banks, a current connection and a passing ledger proof.
- **Basis.** Accrual, with a reviewed cash-basis view built from the same ledger
  (`books-cash-report-policy.json`); the cash view never posts.
- **Construction revenue.** Each job earns by its dated, reviewed revenue policy:
  fixed price, time and materials and cost-plus jobs over time by cost to cost; a
  home sold under a purchase agreement at closing; a standalone service when
  invoiced. Expected losses are recognized in full when foreseen
  (`books-revenue-recognition.md`).
- **Inventory.** Owned land per lot at its basis, homes under construction in
  1160 and completed homes in 1170 per job; cost reaches jobs only through
  documents or reviewed allocations (`books-entities.md`, `books-period-close.md`).
- **Companies.** A legal entity is a segment of the one ledger; every line names
  its company, cross-company entries carry intercompany legs, and consolidation
  eliminates them (`books-entities.md`).
- **Close.** Months close with blocking gates and saved statements; year-end
  moves earnings to retained earnings; reopening keeps the earlier close on
  record (`books-period-close.md`).
- **Taxes.** Arc classifies 1099 payments and prepares a reviewed package and
  import file; a filing partner files them (`books-1099.md`). Arc records the
  sales and use tax entered on invoices and bills per company; it does not
  compute rates or file returns. Payroll taxes are the payroll provider's.

## Capabilities

| Capability | Entries and rules | Where | Scenarios | State |
|---|---|---|---|---|
| Month and year-end close, gates, reopen | `books-period-close.md` | `/books/close` | CLOSE-01, YEAR-01, RACE-01 | Verified |
| Customer invoices, credits, write-offs, voids, retainage, collections | `books-revenue-recognition.md` | each project's billing | BILL-01 | Verified |
| Opening an existing builder: open items, banks, assets, loans, land and homes | `books-period-close.md` (opening) | `/books/opening-balances`, `/books/cutover` | HIST-01, MIG-01 | Verified |
| Starting a new company with no history | `books-period-close.md` | `/books/cutover` | GREEN-01 | Verified |
| Contract revenue: WIP, percentage of completion, losses | `books-revenue-recognition.md` | `/books/close` (WIP review), `/books/revenue-policies` | WIP-01, LOSS-01, REV-01 | Verified |
| Spec homes, land, development allocation, closings, warranty | `books-revenue-recognition.md` | `/books/inventory`, closings | HOME-01 | Verified |
| Overhead, insurance and equipment cost allocations | `books-revenue-recognition.md` | `/books/cost-allocations` | INTERCO-01, HOME-01 | Verified |
| Statements, comparisons and reporting tags | `books-dimensions.md` | `/books/statements` | DIM-01 | Verified |
| Bank and card reconciliation, imported statements | `books-bank-reconciliation.md` | `/books/banking` | BANK-01 | Verified; live bank feeds wait on Plaid sandbox access |
| Cash-basis P&L and tax workpaper | `books-cash-report-policy.json` | `/reports/books-cash-profit-loss`, `/reports/books-tax-workpaper` | CASH-01 | Verified; attachments wait on file storage |
| 1099 classification and filing package | `books-1099.md` | `/books/taxes` | TAX-01, AUTH-01 | Verified; handoff waits on a filing partner |
| Multiple companies, intercompany, consolidation | `books-entities.md` | `/books/entities` | ENTITY-01, INTERCO-01, CONSOL-01 | Verified |
| Posting health, ledger proof and repair | `books-posting.md` | each document's posting status | STATUS-01, CAP-01, RESTORE-01 | Verified |
| Archive and restore | `books-restore.md` | `/books/exports` | RESTORE-01 | Verified; bounded memory and stored documents remain (STORE-01) |
| Who can do what | the RBAC catalog | every Books surface | AUTH-01 | Verified |
| Payroll | — | the builder's payroll provider | PAY-01, PAY-02 | Not in the first release: summaries post as journals to the payroll pool and move to jobs by allocation |

## Not supported in the first release

Payroll run inside Arc, independent per-company close, minority interests,
companies with different charts or fiscal years, group membership that changes
during the year, multi-currency, tax rate calculation and tax filing.
