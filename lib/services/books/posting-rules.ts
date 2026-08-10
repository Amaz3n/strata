import { SYSTEM_ACCOUNT_CODES } from "@/lib/services/books/chart-of-accounts"
import {
  assertBalancedJournalDraft,
  assertIntegerCents,
  buildPostingKey,
  type GlAccountType,
  type JournalEntryDraft,
  type JournalLineDraft,
} from "@/lib/services/books/types"

/**
 * Pure posting rules. No I/O, no Supabase, no clock — every input is supplied by
 * the caller so a rule can be replayed identically during re-projection and
 * asserted in tests without a database.
 *
 * Revenue model (contract postures): billings and earned revenue are kept apart.
 * An invoice credits `2350 Contract liabilities` — billing a customer is not
 * revenue. Revenue is recognized separately by `postRevenueRecognition`, which
 * debits `2350` and credits `4000 Construction revenue` for the period's earned
 * amount. The residual balance in `2350` per project is therefore
 * `billings − earned`: a credit balance is billings in excess (a liability), a
 * debit balance is costs in excess (a contract asset). Statements net the
 * position per project for presentation; no reclassification entry is posted.
 *
 * Closing-basis projects (production spec homes sold under a purchase agreement)
 * do not use percentage-of-completion — they recognize revenue at closing — so
 * the projector never asks for a recognition entry on them.
 */

type CommonPostingInput = {
  id: string
  date: string
  memo: string
  projectionVersion: number
  /** Economic revision of the source record; bumped when a posted source changes. */
  sourceVersion?: number
  policyVersion: number
  projectId?: string
  companyId?: string
}

function line(
  accountCode: string,
  amountCents: number,
  side: "debit" | "credit",
  input: Pick<CommonPostingInput, "projectId" | "companyId"> & { description?: string },
): JournalLineDraft {
  assertIntegerCents(amountCents, "Posting amount")
  if (amountCents <= 0) throw new Error("Posting amount must be positive")
  return {
    accountCode,
    debitCents: side === "debit" ? amountCents : 0,
    creditCents: side === "credit" ? amountCents : 0,
    projectId: input.projectId,
    companyId: input.companyId,
    description: input.description,
  }
}

/**
 * A journal line whose direction follows the sign of its amount.
 *
 * `side` is the direction a POSITIVE amount takes. A negative amount is the same
 * economics mirrored — a vendor credit against a bill, an expense credit, a
 * reversing labor correction — so it flips to the other side at its absolute
 * value. Negatives must never be dropped: `job_cost_entries` carries them signed
 * and the accounting importer creates them, so skipping one makes the subledger
 * fall while the GL stands still and the job-cost tie-out fails with no
 * projection failure to explain it.
 *
 * A zero amount is not a line at all and is omitted; `complete` still requires
 * two lines, so an entry cannot collapse to nothing.
 */
function signedLine(
  accountCode: string,
  amountCents: number,
  side: "debit" | "credit",
  input: Pick<CommonPostingInput, "projectId" | "companyId"> & { description?: string },
): JournalLineDraft | null {
  assertIntegerCents(amountCents, "Posting amount")
  if (amountCents === 0) return null
  const resolved = amountCents > 0 ? side : side === "debit" ? "credit" : "debit"
  return line(accountCode, Math.abs(amountCents), resolved, input)
}

function compactLines(lines: Array<JournalLineDraft | null>): JournalLineDraft[] {
  return lines.filter((item): item is JournalLineDraft => item !== null)
}

/**
 * A document total and the portion withheld from it, either of which may be
 * negative when the whole document is a credit.
 *
 * What is never valid: a zero document (nothing happened), a withheld amount
 * pointing the other way from the total, or one larger than the total.
 */
function assertSignedGross(grossCents: number, withheldCents: number, label: string) {
  assertIntegerCents(grossCents, `${label} gross`)
  assertIntegerCents(withheldCents, `${label} retainage`)
  if (grossCents === 0) throw new Error(`${label} gross must not be zero`)
  if (withheldCents === 0) return
  if (Math.sign(withheldCents) !== Math.sign(grossCents) || Math.abs(withheldCents) > Math.abs(grossCents)) {
    throw new Error(`${label} gross and retainage are invalid`)
  }
}

function complete(draft: JournalEntryDraft) {
  assertBalancedJournalDraft(draft)
  return draft
}

/**
 * Non-cash payment methods.
 *
 * Applying a vendor credit writes a `payments` row so the bill's balance moves,
 * but no money leaves the bank: the credit note is itself a negative bill that
 * already posted Dr AP / Cr cost, and the application only nets one AP balance
 * against another. Posting it as a disbursement invents cash that never moved
 * and guarantees the bank reconciliation can never tie.
 */
const NON_CASH_PAYMENT_METHODS = new Set(["credit"])

export type PaymentPostingClass =
  | { kind: "bill_payment" }
  | { kind: "invoice_payment" }
  | { kind: "credit_application" }
  | { kind: "unpostable"; reason: string }

/**
 * What a `payments` row means to the ledger.
 *
 * Every row is classified explicitly. A credit application is recognized and
 * deliberately produces no entry; a row that cannot be read at all is still
 * rejected out loud rather than quietly skipped, because a payment the projector
 * cannot classify is the one thing that silently breaks an AR or AP tie-out.
 */
export function classifyPaymentPosting(input: {
  method: string | null
  hasBill: boolean
  hasInvoice: boolean
  creditApplied: boolean
}): PaymentPostingClass {
  if (input.hasBill === input.hasInvoice) {
    return {
      kind: "unpostable",
      reason: input.hasBill
        ? "Payment is linked to both a vendor bill and an invoice and cannot be classified"
        : "Payment is linked to neither a vendor bill nor an invoice and cannot be posted",
    }
  }
  if (input.creditApplied || (input.method !== null && NON_CASH_PAYMENT_METHODS.has(input.method))) {
    return { kind: "credit_application" }
  }
  return { kind: input.hasBill ? "bill_payment" : "invoice_payment" }
}

/**
 * One vendor-bill cost line. Used when the projector derives job cost from the
 * `job_cost_entries` subledger, so GL job cost ties to the subledger by
 * construction instead of being reconciled after the fact.
 *
 * A negative gross is a vendor credit and posts as the exact mirror — Dr AP,
 * Cr job cost — because that is what the cost subledger already recorded.
 */
export function postVendorBillFromCostLines(input: CommonPostingInput & {
  grossCents: number
  retainageCents?: number
  costLines: Array<{ accountCode?: string; amountCents: number; projectId?: string; description?: string }>
}) {
  const retainageCents = input.retainageCents ?? 0
  assertSignedGross(input.grossCents, retainageCents, "Vendor bill")
  const costTotal = input.costLines.reduce((sum, item) => sum + item.amountCents, 0)
  if (costTotal !== input.grossCents) {
    throw new Error(`Vendor bill cost lines total ${costTotal} does not equal the bill gross ${input.grossCents}`)
  }
  const payableCents = input.grossCents - retainageCents
  const lines = compactLines([
    ...input.costLines.map((item) =>
      signedLine(item.accountCode ?? SYSTEM_ACCOUNT_CODES.jobCosts, item.amountCents, "debit", {
        projectId: item.projectId ?? input.projectId,
        companyId: input.companyId,
        description: item.description,
      }),
    ),
    signedLine(SYSTEM_ACCOUNT_CODES.accountsPayable, payableCents, "credit", input),
    signedLine(SYSTEM_ACCOUNT_CODES.retainagePayable, retainageCents, "credit", input),
  ])
  return complete({
    entryDate: input.date,
    entryKind: "operational",
    memo: input.memo,
    postingKey: buildPostingKey(`vendor_bill:${input.id}`, input),
    projectionVersion: input.projectionVersion,
    policyVersion: input.policyVersion,
    sourceType: "vendor_bill",
    sourceId: input.id,
    lines,
  })
}

export function postBillPayment(input: CommonPostingInput & {
  amountCents: number
  cashAccountCode?: string
  /** Processor and platform fees withheld from the disbursement. */
  feeCents?: number
  feeAccountCode?: string
  /** Discount taken for paying early: reduces cash without reducing the payable. */
  discountCents?: number
}) {
  const feeCents = input.feeCents ?? 0
  const discountCents = input.discountCents ?? 0
  assertIntegerCents(input.amountCents, "Bill payment amount")
  assertIntegerCents(feeCents, "Bill payment fee")
  assertIntegerCents(discountCents, "Bill payment discount")
  if (input.amountCents <= 0 || feeCents < 0 || discountCents < 0) {
    throw new Error("Bill payment amounts are invalid")
  }
  if (discountCents >= input.amountCents) throw new Error("An early-pay discount cannot equal or exceed the payment")
  const cashCents = input.amountCents - discountCents + feeCents
  const lines = [line(SYSTEM_ACCOUNT_CODES.accountsPayable, input.amountCents, "debit", input)]
  if (feeCents > 0) lines.push(line(input.feeAccountCode ?? SYSTEM_ACCOUNT_CODES.bankFees, feeCents, "debit", input))
  if (discountCents > 0) lines.push(line(SYSTEM_ACCOUNT_CODES.earlyPayDiscounts, discountCents, "credit", input))
  lines.push(line(input.cashAccountCode ?? SYSTEM_ACCOUNT_CODES.operatingCash, cashCents, "credit", input))
  return complete({
    entryDate: input.date,
    entryKind: "operational",
    memo: input.memo,
    postingKey: buildPostingKey(`bill_payment:${input.id}`, input),
    projectionVersion: input.projectionVersion,
    policyVersion: input.policyVersion,
    sourceType: "bill_payment",
    sourceId: input.id,
    lines,
  })
}

export function postCustomerInvoice(input: CommonPostingInput & {
  grossCents: number
  retainageCents?: number
  billingAccountCode?: string
}) {
  const retainageCents = input.retainageCents ?? 0
  assertSignedGross(input.grossCents, retainageCents, "Invoice")
  const receivableCents = input.grossCents - retainageCents
  const lines = compactLines([
    signedLine(SYSTEM_ACCOUNT_CODES.accountsReceivable, receivableCents, "debit", input),
    signedLine(SYSTEM_ACCOUNT_CODES.retainageReceivable, retainageCents, "debit", input),
    signedLine(input.billingAccountCode ?? SYSTEM_ACCOUNT_CODES.contractLiability, input.grossCents, "credit", input),
  ])
  return complete({
    entryDate: input.date,
    entryKind: "operational",
    memo: input.memo,
    postingKey: buildPostingKey(`invoice:${input.id}`, input),
    projectionVersion: input.projectionVersion,
    policyVersion: input.policyVersion,
    sourceType: "invoice",
    sourceId: input.id,
    lines,
  })
}

/**
 * Closing-basis revenue (production spec home sold under a purchase agreement).
 * There is no percentage-of-completion for these projects: the sale is the
 * recognition event, so the invoice books revenue directly.
 */
export function postClosingInvoice(input: CommonPostingInput & {
  grossCents: number
  revenueAccountCode?: string
}) {
  assertIntegerCents(input.grossCents, "Closing invoice gross")
  if (input.grossCents === 0) throw new Error("Closing invoice gross must not be zero")
  return complete({
    entryDate: input.date,
    entryKind: "operational",
    memo: input.memo,
    postingKey: buildPostingKey(`invoice:${input.id}`, input),
    projectionVersion: input.projectionVersion,
    policyVersion: input.policyVersion,
    sourceType: "invoice",
    sourceId: input.id,
    lines: compactLines([
      signedLine(SYSTEM_ACCOUNT_CODES.accountsReceivable, input.grossCents, "debit", input),
      signedLine(input.revenueAccountCode ?? SYSTEM_ACCOUNT_CODES.constructionRevenue, input.grossCents, "credit", input),
    ]),
  })
}

/**
 * A customer receipt.
 *
 * Processor and platform fees are withheld from the deposit before it reaches
 * the builder's account — `payments.net_cents` is recorded as gross minus both —
 * so cash is debited NET and the fee is booked as expense. Debiting cash for the
 * full receipt overstates the bank by every fee ever charged and makes the bank
 * reconciliation permanently unclosable.
 */
export function postInvoicePayment(input: CommonPostingInput & {
  amountCents: number
  cashAccountCode?: string
  /** Processor and platform fees netted out of the deposit. */
  feeCents?: number
  feeAccountCode?: string
}) {
  const feeCents = input.feeCents ?? 0
  assertIntegerCents(input.amountCents, "Customer payment amount")
  assertIntegerCents(feeCents, "Customer payment fee")
  if (input.amountCents <= 0 || feeCents < 0) throw new Error("Customer payment amounts are invalid")
  if (feeCents >= input.amountCents) throw new Error("A processor fee cannot equal or exceed the receipt")
  const lines = [line(input.cashAccountCode ?? SYSTEM_ACCOUNT_CODES.operatingCash, input.amountCents - feeCents, "debit", input)]
  if (feeCents > 0) lines.push(line(input.feeAccountCode ?? SYSTEM_ACCOUNT_CODES.bankFees, feeCents, "debit", input))
  lines.push(line(SYSTEM_ACCOUNT_CODES.accountsReceivable, input.amountCents, "credit", input))
  return complete({
    entryDate: input.date,
    entryKind: "operational",
    memo: input.memo,
    postingKey: buildPostingKey(`invoice_payment:${input.id}`, input),
    projectionVersion: input.projectionVersion,
    policyVersion: input.policyVersion,
    sourceType: "invoice_payment",
    sourceId: input.id,
    lines,
  })
}

/** A negative amount is an expense credit and posts as the mirror. */
export function postExpense(input: CommonPostingInput & {
  amountCents: number
  expenseAccountCode?: string
  /** Omit to book the expense against AP instead of cash (an unpaid, accrued expense). */
  paymentAccountCode?: string
  accrued?: boolean
}) {
  assertIntegerCents(input.amountCents, "Expense amount")
  if (input.amountCents === 0) throw new Error("An expense with no amount is not an accounting fact")
  const creditAccount = input.accrued
    ? SYSTEM_ACCOUNT_CODES.accountsPayable
    : input.paymentAccountCode ?? SYSTEM_ACCOUNT_CODES.operatingCash
  return complete({
    entryDate: input.date,
    entryKind: "operational",
    memo: input.memo,
    postingKey: buildPostingKey(`expense:${input.id}`, input),
    projectionVersion: input.projectionVersion,
    policyVersion: input.policyVersion,
    sourceType: "expense",
    sourceId: input.id,
    lines: compactLines([
      signedLine(input.expenseAccountCode ?? SYSTEM_ACCOUNT_CODES.otherExpense, input.amountCents, "debit", input),
      signedLine(creditAccount, input.amountCents, "credit", input),
    ]),
  })
}

/**
 * Retainage moving out of its holding account once it is released.
 * `payable` releases withheld sub retainage into AP; `receivable` moves owner
 * retainage into AR once it becomes billable.
 */
export function postRetainageRelease(input: CommonPostingInput & {
  amountCents: number
  side: "payable" | "receivable"
}) {
  assertIntegerCents(input.amountCents, "Retainage release")
  if (input.amountCents <= 0) throw new Error("Retainage release must be positive")
  const lines = input.side === "payable"
    ? [
        line(SYSTEM_ACCOUNT_CODES.retainagePayable, input.amountCents, "debit", input),
        line(SYSTEM_ACCOUNT_CODES.accountsPayable, input.amountCents, "credit", input),
      ]
    : [
        line(SYSTEM_ACCOUNT_CODES.accountsReceivable, input.amountCents, "debit", input),
        line(SYSTEM_ACCOUNT_CODES.retainageReceivable, input.amountCents, "credit", input),
      ]
  return complete({
    entryDate: input.date,
    entryKind: "operational",
    memo: input.memo,
    postingKey: buildPostingKey(`retainage_release_${input.side}:${input.id}`, input),
    projectionVersion: input.projectionVersion,
    policyVersion: input.policyVersion,
    sourceType: `retainage_release_${input.side}`,
    sourceId: input.id,
    lines,
  })
}

/**
 * An ACH return or chargeback reversing a settled payment.
 *
 * Without this the two sides drift permanently: Arc reopens the vendor bill (or
 * the invoice) while the ledger still shows money that came back.
 */
export function postPaymentReversal(input: CommonPostingInput & {
  amountCents: number
  side: "bill_payment" | "invoice_payment"
  cashAccountCode?: string
}) {
  assertIntegerCents(input.amountCents, "Payment reversal")
  if (input.amountCents <= 0) throw new Error("Payment reversal must be positive")
  const cash = input.cashAccountCode ?? SYSTEM_ACCOUNT_CODES.operatingCash
  const lines = input.side === "bill_payment"
    ? [
        line(cash, input.amountCents, "debit", input),
        line(SYSTEM_ACCOUNT_CODES.accountsPayable, input.amountCents, "credit", input),
      ]
    : [
        line(SYSTEM_ACCOUNT_CODES.accountsReceivable, input.amountCents, "debit", input),
        line(cash, input.amountCents, "credit", input),
      ]
  return complete({
    entryDate: input.date,
    entryKind: "operational",
    memo: input.memo,
    postingKey: buildPostingKey(`payment_reversal:${input.id}`, input),
    projectionVersion: input.projectionVersion,
    policyVersion: input.policyVersion,
    sourceType: "payment_reversal",
    sourceId: input.id,
    lines,
  })
}

/**
 * Field labor booked to a job from the time subledger. Without this, labor sits
 * in `job_cost_entries` and never reaches the GL, and the job-cost tie-out can
 * never balance. The credit is payroll clearing, which the payroll run relieves.
 * A negative entry is a labor correction and posts as the mirror, for the same
 * reason: the subledger already carries it signed.
 */
export function postLaborCost(input: CommonPostingInput & {
  amountCents: number
  costAccountCode?: string
}) {
  assertIntegerCents(input.amountCents, "Labor cost")
  if (input.amountCents === 0) throw new Error("A labor entry with no amount is not an accounting fact")
  return complete({
    entryDate: input.date,
    entryKind: "operational",
    memo: input.memo,
    postingKey: buildPostingKey(`labor_cost:${input.id}`, input),
    projectionVersion: input.projectionVersion,
    policyVersion: input.policyVersion,
    sourceType: "labor_cost",
    sourceId: input.id,
    lines: compactLines([
      signedLine(input.costAccountCode ?? SYSTEM_ACCOUNT_CODES.laborCosts, input.amountCents, "debit", input),
      signedLine(SYSTEM_ACCOUNT_CODES.payrollClearing, input.amountCents, "credit", input),
    ]),
  })
}

/**
 * Percentage-of-completion revenue for one project and one accounting period.
 *
 * `deltaCents` is the change in cumulative earned revenue since the last
 * recognized period — positive when the project earned revenue, negative when a
 * cost or contract revision pulled earned revenue back down. Debiting `2350`
 * draws down billings; a project billed less than it has earned drives `2350`
 * into a debit balance, which the balance sheet presents as a contract asset.
 */
export function postRevenueRecognition(input: CommonPostingInput & {
  deltaCents: number
  periodKey: string
}) {
  assertIntegerCents(input.deltaCents, "Revenue recognition delta")
  if (input.deltaCents === 0) throw new Error("A zero revenue-recognition delta does not require a journal entry")
  if (!input.projectId) throw new Error("Revenue recognition requires a project")
  const amountCents = Math.abs(input.deltaCents)
  const earning = input.deltaCents > 0
  return complete({
    entryDate: input.date,
    entryKind: "poc",
    memo: input.memo,
    postingKey: buildPostingKey(`revenue_recognition:${input.projectId}:${input.periodKey}`, input),
    projectionVersion: input.projectionVersion,
    policyVersion: input.policyVersion,
    sourceType: "revenue_recognition",
    sourceId: input.id,
    lines: earning
      ? [
          line(SYSTEM_ACCOUNT_CODES.contractLiability, amountCents, "debit", input),
          line(SYSTEM_ACCOUNT_CODES.constructionRevenue, amountCents, "credit", input),
        ]
      : [
          line(SYSTEM_ACCOUNT_CODES.constructionRevenue, amountCents, "debit", input),
          line(SYSTEM_ACCOUNT_CODES.contractLiability, amountCents, "credit", input),
        ],
  })
}

/**
 * Closes income and expense balances into retained earnings. The caller supplies
 * each account's `accountType` — inferring income from a `4xxx` code prefix would
 * misclassify any custom account whose code does not follow the seeded chart.
 */
export function postYearEndClose(input: CommonPostingInput & {
  incomeAccountBalances: Array<{ accountCode: string; accountType: GlAccountType; balanceCents: number }>
}) {
  const lines: JournalLineDraft[] = []
  let netIncomeCents = 0
  for (const account of input.incomeAccountBalances) {
    assertIntegerCents(account.balanceCents, `Year-end balance for ${account.accountCode}`)
    if (account.balanceCents === 0) continue
    if (account.accountType !== "income" && account.accountType !== "cogs" && account.accountType !== "expense") {
      throw new Error(`Account ${account.accountCode} is not a income-statement account and cannot be closed`)
    }
    const income = account.accountType === "income"
    netIncomeCents += income ? account.balanceCents : -account.balanceCents
    // `balanceCents` is normal-balance signed, so a contra balance arrives negative: an
    // income account carrying a debit balance (refunds exceeding revenue), or an expense
    // account carrying a credit balance (a vendor refund booked against the expense).
    // Closing it out reverses the direction — choosing by account type alone emits a
    // one-sided entry that `complete()` rejects, which made year-end close impossible in
    // any year holding one.
    const closeWithDebit = income ? account.balanceCents > 0 : account.balanceCents < 0
    lines.push(line(account.accountCode, Math.abs(account.balanceCents), closeWithDebit ? "debit" : "credit", input))
  }
  if (lines.length === 0) throw new Error("No income-statement balances remain to close")
  // A break-even year still has to zero its income statement; the account lines already
  // balance each other, so there is nothing left to move to retained earnings.
  if (netIncomeCents !== 0) {
    lines.push(line(SYSTEM_ACCOUNT_CODES.retainedEarnings, Math.abs(netIncomeCents), netIncomeCents > 0 ? "credit" : "debit", input))
  }
  return complete({
    entryDate: input.date,
    entryKind: "closing",
    memo: input.memo,
    postingKey: buildPostingKey(`year_end:${input.id}`, input),
    projectionVersion: input.projectionVersion,
    policyVersion: input.policyVersion,
    sourceType: "year_end_close",
    sourceId: input.id,
    lines,
  })
}
