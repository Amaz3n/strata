export type AccountingReference = { id: string; name: string | null }

export type AccountingCoding = {
  transaction_type?: string | null
  expense_account?: AccountingReference | null
  payment_account?: AccountingReference | null
  ap_account?: AccountingReference | null
  counterparty?: AccountingReference | null
  dimensions?: Record<string, AccountingReference | null>
  /** Temporary read compatibility for the original D1 backfill shape. */
  vendor?: AccountingReference | null
  /** Temporary read compatibility for the original D1 backfill shape. */
  class?: AccountingReference | null
}

function reference(id?: string | null, name?: string | null): AccountingReference | null {
  const normalized = id?.trim()
  return normalized ? { id: normalized, name: name?.trim() || null } : null
}

export function buildAccountingCoding(input: {
  transactionType?: string | null
  expenseAccountId?: string | null
  expenseAccountName?: string | null
  paymentAccountId?: string | null
  paymentAccountName?: string | null
  apAccountId?: string | null
  apAccountName?: string | null
  counterpartyId?: string | null
  counterpartyName?: string | null
  classId?: string | null
  className?: string | null
}): AccountingCoding {
  return {
    transaction_type: input.transactionType ?? null,
    expense_account: reference(input.expenseAccountId, input.expenseAccountName),
    payment_account: reference(input.paymentAccountId, input.paymentAccountName),
    ap_account: reference(input.apAccountId, input.apAccountName),
    counterparty: reference(input.counterpartyId, input.counterpartyName),
    dimensions: input.classId ? { class: reference(input.classId, input.className) } : {},
  }
}

export function accountingReference(coding: unknown, key: "expense_account" | "payment_account" | "ap_account" | "counterparty") {
  const typed = coding as AccountingCoding | null
  const value = key === "counterparty"
    ? typed?.counterparty ?? typed?.vendor
    : typed?.[key]
  return value && typeof value.id === "string" ? value : null
}

export function accountingDimension(coding: unknown, key: string) {
  const typed = coding as AccountingCoding | null
  const value = typed?.dimensions?.[key] ?? (key === "class" ? typed?.class : null)
  return value && typeof value.id === "string" ? value : null
}
