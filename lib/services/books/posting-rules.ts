import { SYSTEM_ACCOUNT_CODES } from "@/lib/services/books/chart-of-accounts"
import {
  assertBalancedJournalDraft,
  assertIntegerCents,
  type JournalEntryDraft,
  type JournalLineDraft,
} from "@/lib/services/books/types"

type CommonPostingInput = {
  id: string
  date: string
  memo: string
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

function complete(draft: JournalEntryDraft) {
  assertBalancedJournalDraft(draft)
  return draft
}

export function postVendorBill(input: CommonPostingInput & {
  grossCents: number
  retainageCents?: number
  costAccountCode?: string
}) {
  const retainageCents = input.retainageCents ?? 0
  assertIntegerCents(input.grossCents, "Vendor bill gross")
  assertIntegerCents(retainageCents, "Vendor bill retainage")
  if (input.grossCents <= 0 || retainageCents < 0 || retainageCents > input.grossCents) {
    throw new Error("Vendor bill gross and retainage are invalid")
  }
  const payableCents = input.grossCents - retainageCents
  const lines = [
    line(input.costAccountCode ?? SYSTEM_ACCOUNT_CODES.jobCosts, input.grossCents, "debit", input),
  ]
  if (payableCents > 0) lines.push(line(SYSTEM_ACCOUNT_CODES.accountsPayable, payableCents, "credit", input))
  if (retainageCents > 0) lines.push(line(SYSTEM_ACCOUNT_CODES.retainagePayable, retainageCents, "credit", input))
  return complete({
    entryDate: input.date,
    entryKind: "operational",
    memo: input.memo,
    postingKey: `vendor_bill:${input.id}`,
    policyVersion: input.policyVersion,
    sourceType: "vendor_bill",
    sourceId: input.id,
    lines,
  })
}

export function postBillPayment(input: CommonPostingInput & {
  amountCents: number
  cashAccountCode?: string
}) {
  return complete({
    entryDate: input.date,
    entryKind: "operational",
    memo: input.memo,
    postingKey: `bill_payment:${input.id}`,
    policyVersion: input.policyVersion,
    sourceType: "bill_payment",
    sourceId: input.id,
    lines: [
      line(SYSTEM_ACCOUNT_CODES.accountsPayable, input.amountCents, "debit", input),
      line(input.cashAccountCode ?? SYSTEM_ACCOUNT_CODES.operatingCash, input.amountCents, "credit", input),
    ],
  })
}

export function postCustomerInvoice(input: CommonPostingInput & {
  grossCents: number
  retainageCents?: number
  revenueAccountCode?: string
}) {
  const retainageCents = input.retainageCents ?? 0
  assertIntegerCents(input.grossCents, "Invoice gross")
  assertIntegerCents(retainageCents, "Invoice retainage")
  if (input.grossCents <= 0 || retainageCents < 0 || retainageCents > input.grossCents) {
    throw new Error("Invoice gross and retainage are invalid")
  }
  const receivableCents = input.grossCents - retainageCents
  const lines: JournalLineDraft[] = []
  if (receivableCents > 0) lines.push(line(SYSTEM_ACCOUNT_CODES.accountsReceivable, receivableCents, "debit", input))
  if (retainageCents > 0) lines.push(line(SYSTEM_ACCOUNT_CODES.retainageReceivable, retainageCents, "debit", input))
  lines.push(line(input.revenueAccountCode ?? SYSTEM_ACCOUNT_CODES.contractLiability, input.grossCents, "credit", input))
  return complete({
    entryDate: input.date,
    entryKind: "operational",
    memo: input.memo,
    postingKey: `invoice:${input.id}`,
    policyVersion: input.policyVersion,
    sourceType: "invoice",
    sourceId: input.id,
    lines,
  })
}

export function postInvoicePayment(input: CommonPostingInput & {
  amountCents: number
  cashAccountCode?: string
}) {
  return complete({
    entryDate: input.date,
    entryKind: "operational",
    memo: input.memo,
    postingKey: `invoice_payment:${input.id}`,
    policyVersion: input.policyVersion,
    sourceType: "invoice_payment",
    sourceId: input.id,
    lines: [
      line(input.cashAccountCode ?? SYSTEM_ACCOUNT_CODES.operatingCash, input.amountCents, "debit", input),
      line(SYSTEM_ACCOUNT_CODES.accountsReceivable, input.amountCents, "credit", input),
    ],
  })
}

export function postExpense(input: CommonPostingInput & {
  amountCents: number
  expenseAccountCode?: string
  paymentAccountCode?: string
}) {
  return complete({
    entryDate: input.date,
    entryKind: "operational",
    memo: input.memo,
    postingKey: `expense:${input.id}`,
    policyVersion: input.policyVersion,
    sourceType: "expense",
    sourceId: input.id,
    lines: [
      line(input.expenseAccountCode ?? SYSTEM_ACCOUNT_CODES.otherExpense, input.amountCents, "debit", input),
      line(input.paymentAccountCode ?? SYSTEM_ACCOUNT_CODES.operatingCash, input.amountCents, "credit", input),
    ],
  })
}

export function postCustomerDeposit(input: CommonPostingInput & {
  amountCents: number
  cashAccountCode?: string
}) {
  return complete({
    entryDate: input.date,
    entryKind: "operational",
    memo: input.memo,
    postingKey: `customer_deposit:${input.id}`,
    policyVersion: input.policyVersion,
    sourceType: "customer_deposit",
    sourceId: input.id,
    lines: [
      line(input.cashAccountCode ?? SYSTEM_ACCOUNT_CODES.operatingCash, input.amountCents, "debit", input),
      line(SYSTEM_ACCOUNT_CODES.customerDeposits, input.amountCents, "credit", input),
    ],
  })
}

export function postLoanPayment(input: CommonPostingInput & {
  principalCents: number
  interestCents: number
  debtAccountCode?: string
  cashAccountCode?: string
}) {
  assertIntegerCents(input.principalCents, "Loan principal")
  assertIntegerCents(input.interestCents, "Loan interest")
  if (input.principalCents < 0 || input.interestCents < 0 || input.principalCents + input.interestCents <= 0) {
    throw new Error("Loan payment amounts are invalid")
  }
  const lines: JournalLineDraft[] = []
  if (input.principalCents > 0) lines.push(line(input.debtAccountCode ?? SYSTEM_ACCOUNT_CODES.longTermDebt, input.principalCents, "debit", input))
  if (input.interestCents > 0) lines.push(line(SYSTEM_ACCOUNT_CODES.interestExpense, input.interestCents, "debit", input))
  lines.push(line(input.cashAccountCode ?? SYSTEM_ACCOUNT_CODES.operatingCash, input.principalCents + input.interestCents, "credit", input))
  return complete({
    entryDate: input.date,
    entryKind: "operational",
    memo: input.memo,
    postingKey: `loan_payment:${input.id}`,
    policyVersion: input.policyVersion,
    sourceType: "loan_payment",
    sourceId: input.id,
    lines,
  })
}

export function postPocAdjustment(input: CommonPostingInput & {
  adjustmentCents: number
}) {
  assertIntegerCents(input.adjustmentCents, "POC adjustment")
  if (input.adjustmentCents === 0) throw new Error("A zero POC adjustment does not require a journal entry")
  const amountCents = Math.abs(input.adjustmentCents)
  const increasing = input.adjustmentCents > 0
  return complete({
    entryDate: input.date,
    entryKind: "poc",
    memo: input.memo,
    postingKey: `poc:${input.id}`,
    policyVersion: input.policyVersion,
    sourceType: "poc_adjustment",
    sourceId: input.id,
    lines: increasing
      ? [
          line(SYSTEM_ACCOUNT_CODES.contractAsset, amountCents, "debit", input),
          line(SYSTEM_ACCOUNT_CODES.constructionRevenue, amountCents, "credit", input),
        ]
      : [
          line(SYSTEM_ACCOUNT_CODES.constructionRevenue, amountCents, "debit", input),
          line(SYSTEM_ACCOUNT_CODES.contractAsset, amountCents, "credit", input),
        ],
  })
}

export function postOwnerActivity(input: CommonPostingInput & {
  amountCents: number
  activity: "contribution" | "distribution"
  cashAccountCode?: string
}) {
  const cash = input.cashAccountCode ?? SYSTEM_ACCOUNT_CODES.operatingCash
  const contribution = input.activity === "contribution"
  return complete({
    entryDate: input.date,
    entryKind: "operational",
    memo: input.memo,
    postingKey: `owner_${input.activity}:${input.id}`,
    policyVersion: input.policyVersion,
    sourceType: `owner_${input.activity}`,
    sourceId: input.id,
    lines: contribution
      ? [line(cash, input.amountCents, "debit", input), line(SYSTEM_ACCOUNT_CODES.ownerContributions, input.amountCents, "credit", input)]
      : [line(SYSTEM_ACCOUNT_CODES.ownerDistributions, input.amountCents, "debit", input), line(cash, input.amountCents, "credit", input)],
  })
}

export function postYearEndClose(input: CommonPostingInput & {
  incomeAccountBalances: Array<{ accountCode: string; balanceCents: number }>
}) {
  const lines: JournalLineDraft[] = []
  let netIncomeCents = 0
  for (const account of input.incomeAccountBalances) {
    assertIntegerCents(account.balanceCents, `Year-end balance for ${account.accountCode}`)
    if (account.balanceCents === 0) continue
    const income = account.accountCode.startsWith("4")
    netIncomeCents += income ? account.balanceCents : -account.balanceCents
    lines.push(line(account.accountCode, Math.abs(account.balanceCents), income ? "debit" : "credit", input))
  }
  if (netIncomeCents === 0) throw new Error("No net income remains to close")
  lines.push(line(SYSTEM_ACCOUNT_CODES.retainedEarnings, Math.abs(netIncomeCents), netIncomeCents > 0 ? "credit" : "debit", input))
  return complete({
    entryDate: input.date,
    entryKind: "closing",
    memo: input.memo,
    postingKey: `year_end:${input.id}`,
    policyVersion: input.policyVersion,
    sourceType: "year_end_close",
    sourceId: input.id,
    lines,
  })
}
