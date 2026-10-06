# Arc Books — bank and card reconciliation

How cash and card accounts tie to their statements in Arc Books. Traced from
`lib/services/books/bank-reconciliation.ts`, `deposit-batches.ts`,
`opening-balances.ts` and the statement SQL; proven by the golden scenarios
BANK-01 and RACE-01 and the `bank-statement` browser journey
(`scripts/books-acceptance/`). Where this document and the code disagree, the
code wins — fix this document.

## The proof each statement must pass

A statement (`bank_reconciliations`) closes only when, for its account:

1. **Statement continuity** — its start is the day after the previous closed
   statement's end, and its beginning balance equals that statement's ending
   balance.
2. **Statement arithmetic** — beginning balance + included statement activity =
   ending balance.
3. **Every included statement line is owned** — fully matched to book lines on
   the account's ledger control account.
4. **Bank to book** — ending balance + outstanding book items = ledger balance
   of the control account through statement end. Card accounts (liabilities) use
   the same equations with the sign reversed.

Closing freezes the proof (items, statement lines, offsets) as evidence with a
digest over its economic content; an unchanged reclose reproduces the digest.
A closed statement's lines and matches cannot change. Statements reopen newest
first and never while an overlapping accounting period is closed; reopening
keeps the prior evidence in `evidence_history`.

## Outstanding items

`books_bank_outstanding_lines()` is the only definition, used by both the
statement close and the preview: posted book lines on the control account dated
through statement end that the bank has not fully cleared, excluding

- the opening position — except **cutover outstanding items** (below), and
- lines cleared by a **book offset** dated through statement end.

The statement screen lists outstanding items by date, memo and amount.

## Owning statement lines

| Statement line | How it is owned |
|---|---|
| Check or ACH paying a bill | Matched to the payment's credit to cash (the payment's funding account is chosen when it is recorded) |
| Deposit of customer receipts | A deposit batch: Dr bank / Cr 1010 undeposited funds, matched automatically |
| Processor payout net of fees | A deposit batch with its fee: Dr bank (net) + Dr 6050 (fee) / Cr 1010 (receipts) |
| Bank fee, card purchase, owner capital, supplier refund, payroll tax | Categorized to an account (Dr/Cr the category, Cr/Dr the bank), matched automatically; job costs need a project |
| Transfer between accounts, card repayment | Categorized on one side to the other account's control account, matched on the other side as a transfer |
| Payroll net pay paid as several direct deposits | Each deposit matched for its part of one net-pay line |

A line nobody has owned stays in **Banking → For review** with vendor,
category and project choices and a Post action.

## Cutover outstanding items

Checks and deposits the bank had not cleared at cutover are imported in the
opening balance batch as their own lines on the bank control account
(`details.bank_opening_role = "outstanding_item"`, with the check or deposit
`reference` and its original `document_date`, on or before cutover). They sit
inside the single opening entry next to the statement-balance line; the first
statements clear exactly those items. The statement-balance line can never be
matched to the bank.

## Voided checks and other cancelling entries

A check that is voided before the bank sees it, a cutover check later voided,
or any entry reversed by another leaves two book lines that cancel. **Clear as
offsetting entries** (statement screen) records a reviewed offset: the
selected lines must belong to the account, be unmatched, not already offset,
net to exactly zero, and fall after the last closed statement. Offset lines can
never be matched to the bank, and the offset is part of the closed evidence.

A voided payment keeps its own posting and its reversal posts beside it, so cash
nets to zero and the bill is owed again. A payment marked `refunded` has been
fully reversed by its reversal rows; it still counts as posted.
