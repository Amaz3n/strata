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

### Revenue policies are records (B11.1)

Which method a job earns under is a dated record in `books_revenue_policies`,
read through `loadRevenuePolicyResolver()` (`lib/services/books/revenue-basis.ts`)
and `policyInForce()` (`lib/financials/revenue-policy.ts`), never the billing
settings as they are today:

- **Billing method and recognition method are separate.** Fixed price, time and
  materials, and all three cost-plus models earn over time (cost to cost); a home
  sold under a purchase agreement earns at closing; an invoice with no project (a
  standalone service) earns when invoiced (`DEFAULT_REVENUE_METHOD`).
- **Inferred, then recorded.** The first time a job posts, Arc records the method
  its billing settings imply as an `inferred` policy "from the start". From then
  on the record decides; changing the billing settings later is flagged on
  Books → Revenue policies ("billing settings now say …") and changes nothing.
- **Governed change.** A different method is proposed (books.manage) with an
  effective date and rationale, and approved by someone else (books.close).
  Documents dated before the effective date keep the policy they were posted
  under, and a change dated into a closed month must confirm that month's method
  (reopen it otherwise). Policies are never edited or deleted; an approved one is
  recorded on each document it governs (`revenue_policy_id`).
- **Precedence on a date:** an approved policy for the contract, then for the
  project, then the inferred baseline for the contract, then for the project.
- **Contracts that earn differently** on one job (a construction contract and a
  lot sale) are allowed only when each contract's policy is approved; until then
  their documents are findings with that cure. Each invoice then earns under the
  policy of the contract it bills, and only over-time contracts have WIP.
- **Superseded contracts stay reconstructible**: the recorded policy outlives the
  contract. A job with no record whose only evidence for a date is a superseded
  contract is a finding until a policy is attributed and approved.
- The close reports jobs still on an unreviewed inferred policy (non-blocking).

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

#### Per contract (B04.1)

A project with **two or more primary contracts in force** at a period end has one
WIP position per contract, never one netted position for the job: one contract's
profit must not hide another's loss. Each contract's position uses only its own
costs, billings and estimate:

- **Costs** belong to a contract when their cost code is on that contract's
  schedule of values and no other's. A cost code on several contracts' schedules,
  or on none, belongs to a contract only through a reviewed split
  (`books_wip_cost_allocations`, append-only, shares in basis points; cents are
  divided by cumulative rounding so the shares add back exactly).
- **Billings** belong to the contract the invoice bills (its pay application,
  draw, or a one-time assignment).
- Anything without an owner blocks preparing the contracts it could belong to,
  with the cure named; other contracts and projects are unaffected.

Recognition, the 2350 debit and the expected-loss provision carry `contract_id`,
the posting key names the contract, and the loss reserve is computed and held per
contract. A project with one contract (or none) keeps one project position,
unchanged. "In force" means signed (not draft or superseded), not an amendment of
another contract, and effective by the period end — never the first row returned.
Revenue a project recognized before it had a second contract belongs to no
contract; recognition then refuses rather than counting it twice.

**Presentation.** Invoices and credit memos on a job with several contracts carry
the contract they bill, so every 2350 line of that job names its contract. The
balance sheet nets 2350 within each contract only and presents debit nets as
1150 contract assets and credit nets as 2350 contract liabilities; the ledger
itself keeps one 2350 control account. The WIP schedule has a row per contract
with billings in excess (liability) and costs in excess (asset) as separate
columns, and its totals are the balance sheet's contract assets and liabilities,
the revenue in 4000 and the loss reserve in 2360. The schedule saved at close is
the one the report shows for that date. The WIP review shows who approved, when
and why, and which positions changed since.

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
