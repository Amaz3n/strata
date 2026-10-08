# Arc Books — 1099-NEC

How Arc decides what each vendor was paid in a tax year and how a paying company
hands a reviewed 1099-NEC package to its filing partner. Arc does not transmit to
the IRS.

## What counts (`lib/services/reports/vendor-1099.ts`)

- Cash actually paid to a 1099-eligible vendor in the year, by the payment's own
  date: bill payments (an allocation and its payment count once) and approved
  expenses with a vendor. A bill marked paid without dated payment evidence counts
  nothing and blocks filing until the evidence is restored.
- Card and credit applications are excluded (`vendor-tax-payment-rules.ts`): the
  card network reports card payments.
- A refund reduces the year it happens in; a December payment refunded in January
  stays in December's year.
- The threshold comes from `tax_policy_versions` for that tax year (2025 $600, 2026
  $2,000, as cited there), never from code.
- Reportable vendors are blocked, with the reason, without a W-9, a taxpayer ID in
  Vault, a passing verification, or when backup withholding applies.
- Each company files its own: the paying company is the owner of the posted cash
  line (see `books-entities.md`).

## The package (`lib/services/books/vendor-1099-packages.ts`)

1. **Prepare** (`books.tax`): freezes, for one paying company and year, every payee
   at or over the threshold with name, address, last four of the taxpayer ID, TIN
   type and amount. Refused, listing every reason, while any reportable payee is
   blocked or the company's own taxpayer ID or address is missing.
2. **Approve** (`books.tax`, a different member): only while the current payments
   still produce the same package; otherwise withdraw and prepare again.
3. **Filing file** (`/api/books/1099-packages/:id/filing`, `books.tax`, no-store):
   "Arc 1099-NEC import, version 1" CSV built per request, with full taxpayer IDs
   read from Vault for that download only. Each ID must still end in the frozen last
   four; the file is checked against the format and the approved totals before it
   leaves, and every download is in the audit log. Nobody else can read a full ID.
4. **Submission and outcome**: record the partner and its reference (submitted),
   then accepted or rejected; a rejected package can be submitted again.
5. **Correction**: a new package naming the live one; approving it supersedes the
   original, which keeps its approval, submission and outcome.

Until something is recorded as submitted, a package reads approved, not filed, so a
partner outage never looks like a filing.
