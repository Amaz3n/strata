import type { AccountingAccountKind, AccountingDimensionKind, AccountingProviderKey } from "@/lib/integrations/accounting/provider"

export interface AccountingProviderMeta {
  key: AccountingProviderKey
  name: string
  /** One line describing what connecting this provider does for the org. */
  summary: string
  logoUrl: string
}

/**
 * Presentation metadata for accounting providers, safe to import from client
 * components (the registry pulls in server-only adapters). Keyed by
 * AccountingProviderKey so adding a provider fails the build until the
 * integrations UI knows how to render it.
 */
export const ACCOUNTING_PROVIDERS: Record<AccountingProviderKey, AccountingProviderMeta> = {
  qbo: {
    key: "qbo",
    name: "QuickBooks Online",
    summary: "Push invoices, payments, bills, and expenses to a QuickBooks company file.",
    logoUrl: "/qbo.svg",
  },
}

export const ACCOUNTING_PROVIDER_KEYS = Object.keys(ACCOUNTING_PROVIDERS) as AccountingProviderKey[]

export const DIMENSION_LABELS: Record<AccountingDimensionKind, string> = {
  class: "Class",
  customer: "Customer",
  location: "Location",
  department: "Department",
  entity: "Entity",
}

export const ACCOUNT_KIND_LABELS: Record<AccountingAccountKind, string> = {
  income: "Income",
  expense: "Expense",
  payment: "Deposit to",
  ap: "Accounts payable",
}
