# Arc Books — Revenue Recognition Entry Set (for CPA review)

> **Status: reference — describes the code as it stands on 2026-08-07.** Every entry
> below was traced from `lib/services/books/posting-rules.ts` and
> `lib/services/books/revenue-recognition.ts`, not from design intent.
>
> **This document exists to be signed.** The Arc Books plan holds a standing STOP: no
> organization advances past `shadow` mode until a construction CPA has reviewed and
> signed off on this entry set. See §7.

---

## 1. What is being asked

Confirm that the journal entries in §4 are appropriate for a US construction company
reporting on the accrual basis, and mark up anything that is wrong, missing, or
presented incorrectly. §6 lists three questions where we already believe review is
needed — please do not treat that list as exhaustive.

**Scope of the first release:** accrual basis, single entity, USD. Payroll tax filing,
inventory, consolidation, and multi-currency are out of scope. Cash-basis statements are
a known gap (most small builders file cash-basis) and are tracked separately.

## 2. Two revenue bases, chosen per project

Arc decides the basis per **project**, not per company, because one company routinely
runs both.

| Basis | Applies to | Revenue is earned |
|---|---|---|
| `percentage_of_completion` | Custom homes and commercial contracts | Continuously, by cost-to-cost |
| `closing` | Production spec homes sold under a purchase agreement | Entirely at the sale |

The choke point is `resolveRevenueRecognitionBasis()`. A closing-basis project never
receives a percentage-of-completion entry.

## 3. Accounts used

| Code | Name | Type |
|---|---|---|
| 1000 | Operating cash | Asset |
| 1100 | Accounts receivable | Asset |
| 1110 | Retainage receivable | Asset |
| 1150 | Contract assets | Asset — **seeded, never posted (see §6b)** |
| 1160 | Work in progress | Asset — **seeded, never posted (see §6a)** |
| 2000 | Accounts payable | Liability |
| 2010 | Retainage payable | Liability |
| 2350 | Contract liabilities | Liability |
| 4000 | Construction revenue | Income |
| 5000 | Job costs | Cost of goods sold |
| 5030 | Labor costs | Cost of goods sold |

## 4. The entry set

### 4a. Cost is incurred — vendor bill
Bill gross $X with retainage $R withheld. Cost lines carry the project.

```
Dr  5000  Job costs                     X
    Cr  2000  Accounts payable                X − R
    Cr  2010  Retainage payable               R
```

Job cost is taken from the `job_cost_entries` subledger at **line** grain, not from the
bill header, so a bill split across projects posts to each.

### 4b. The customer is billed — invoice
Gross billing $B with retainage $R withheld. **Billing is not revenue.**

```
Dr  1100  Accounts receivable           B − R
Dr  1110  Retainage receivable          R
    Cr  2350  Contract liabilities            B
```

### 4c. Revenue is earned — percentage of completion
Run at period close for every percentage-of-completion project.

```
percent complete = cost to date ÷ total estimated cost
earned to date   = percent complete × contract value
delta            = earned to date − revenue already recognized to date
```

```
Dr  2350  Contract liabilities          delta
    Cr  4000  Construction revenue            delta
```

Recognition is **cumulative-to-date and posted incrementally**. A period that is
reopened and re-closed tops up rather than double-counting, and a run with nothing to
recognize posts nothing. If the delta is negative (an estimate revision reduces earned
revenue), the entry reverses: debit 4000, credit 2350.

After this entry, the 2350 balance for a project is `billings − earned`:
a **credit** balance is billings in excess of earned revenue; a **debit** balance is
costs and earnings in excess of billings. See §6b.

### 4d. Revenue is earned — closing basis
A production spec home books revenue at the sale, with no percentage-of-completion:

```
Dr  1100  Accounts receivable           B
    Cr  4000  Construction revenue            B
```

### 4e. Cash is collected
```
Dr  1000  Operating cash                amount
    Cr  1100  Accounts receivable             amount
```

### 4f. Vendor is paid (with optional fee and early-pay discount)
```
Dr  2000  Accounts payable              amount
Dr  6050  Bank fees                     fee        (if any)
    Cr  4910  Early payment discounts         discount   (if any)
    Cr  1000  Operating cash                  amount + fee − discount
```

### 4g. Retainage is released
```
AP side:   Dr 2010 Retainage payable      →  Cr 2000 Accounts payable
AR side:   Dr 1100 Accounts receivable    →  Cr 1110 Retainage receivable
```
A release is recognised by its source record, not by its shape: an AP release is a
`vendor_bills` row stamped `metadata.source = 'retainage_release'`, and an AR release is
the invoice named by `retainage.release_invoice_id`. Both are deliberately routed away
from the ordinary bill and invoice rules — see §6c for why that matters.

### 4h. Field labor
```
Dr  5030  Labor costs                   amount
    Cr  2200  Payroll clearing                amount
```

### 4i. Year-end close
Income and expense accounts close to 3100 Retained earnings, classified by
`account_type`, not by account-code prefix.

## 5. Worked example

Fixed-price contract **$1,000,000**. Total estimated cost **$800,000**. Retainage 10%.

**Month 1** — costs incurred $200,000; billed $300,000 gross, $30,000 retained.

```
Dr 5000  200,000   Cr 2000  200,000          (cost)
Dr 1100  270,000
Dr 1110   30,000   Cr 2350  300,000          (billing)
```
Percent complete = 200,000 ÷ 800,000 = **25%**. Earned = 25% × 1,000,000 = **250,000**.
Recognized before = 0, so delta = 250,000.
```
Dr 2350  250,000   Cr 4000  250,000          (revenue earned)
```

Result: revenue 250,000, cost of revenue 200,000, **gross profit 50,000** — exactly 25%
of the contract's 200,000 total expected margin. Account 2350 carries a **50,000 credit**
= billings in excess of earned revenue. Correct.

**Month 2** — costs to date $600,000; billed to date only $600,000 gross.

Percent complete = 75%. Earned to date = 750,000. Recognized before = 250,000, so
delta = 500,000.
```
Dr 2350  500,000   Cr 4000  500,000
```
Account 2350 now nets to a **150,000 debit** (600,000 billed − 750,000 earned) — costs
and earnings in excess of billings, an **asset sitting in a liability account**. This is
the substance of question §6b.

## 6. Open questions — we believe these need your judgment

### 6a. Costs expense directly to COGS; the WIP account is never used
Account **1160 Work in progress is seeded but nothing posts to it**. Job costs debit
5000 as incurred, and the billings-versus-earned difference is carried entirely in 2350.

We believe this is defensible under ASC 606 — the contract asset / contract liability
model replaced the older WIP-accumulation presentation — but it differs from what many
construction CPAs expect to see, and from how a WIP schedule is usually tied out.
**Should costs accumulate in 1160 and relieve to COGS as revenue is recognized, or is
direct-to-COGS with a 2350 contract position acceptable?**

### 6b. Contract assets and contract liabilities net into one account
The general ledger posts **both** positions to 2350. A project in costs-in-excess shows
as a debit in a liability account (see §5, month 2), and on the balance sheet, projects
in each direction net against each other across the company.

ASC 606-10-45 requires netting **within** a contract but separate presentation of
contract assets and contract liabilities **across** contracts. Account **1150 Contract
assets exists and is never posted to.** The monthly POC export splits the positions
correctly; the GL does not. **We believe the GL should reclassify debit-balance projects
to 1150 at period end. Please confirm the treatment and the timing.**

### 6c. Retainage release — fixed 2026-08-07, but the timing is your call
`postRetainageRelease` (§4g) previously had **no caller**, so retainage was withheld into
1110/2010 and never released out of them. Worse, both release records are ordinary
business documents: the AP release is a vendor bill with no lines, so it posted
`Dr 5000 Job costs` — expensing a second time money already expensed on the original
bill — and the AR release is an invoice, so it posted `Cr 2350`, crediting contract
liabilities again for work already billed. Cost and revenue were both double-counted.

Both are now classified and routed to `postRetainageRelease`. The remaining question is
timing: **the AR release currently posts when the release invoice is issued. Should it
instead post when that invoice is paid?** Issuing recognises a receivable that the
customer has not yet funded; paying defers the reclassification until cash arrives. We
have implemented "on issue" because it matches how the release invoice already drives
AR, but this is a judgment we would rather you make.

## 7. Sign-off

| | |
|---|---|
| Reviewed by | |
| Firm | |
| License / credential | |
| Date | |
| Entry set version | 2026-08-07 |
| Outcome | ☐ Approved as written  ☐ Approved with the changes noted below  ☐ Not approved |

Notes and required changes:

<br><br><br>

---

**Until this is signed, no organization may advance past `shadow` mode.** Record the
outcome here and in `docs/plans/arc-books-gameplan.md` C1.1.
