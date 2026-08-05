import type { AccountingAccountKind, AccountingDimensionKind, AccountingProviderKey } from "@/lib/integrations/accounting/provider"

export interface AccountingProviderMeta {
  key: AccountingProviderKey
  name: string
  /** One line describing what connecting this provider does for the org. */
  summary: string
  /** Null when the provider has no brand mark of its own to show. */
  logoUrl: string | null
  /**
   * How a connection to this provider comes into existence.
   *
   * `oauth` providers are self-serve: the user authorizes and Arc stores tokens.
   * `configured` providers have no remote system to log into — they are pure
   * setup — and cannot be created through the OAuth flow. Listing one in the
   * "Add connection" menu would offer a button that can only fail, so the menu
   * filters on this rather than on the provider list.
   */
  connectFlow: "oauth" | "configured"
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
    connectFlow: "oauth",
  },
  file: {
    key: "file",
    name: "Batch file export",
    summary: "Accrue AP batches for Sage 300 CRE, Foundation, or Viewpoint Vista to import.",
    logoUrl: null,
    connectFlow: "configured",
  },
}

export const ACCOUNTING_PROVIDER_KEYS = Object.keys(ACCOUNTING_PROVIDERS) as AccountingProviderKey[]

/** Providers a user can add themselves today. See `connectFlow`. */
export const CONNECTABLE_ACCOUNTING_PROVIDER_KEYS = ACCOUNTING_PROVIDER_KEYS.filter(
  (key) => ACCOUNTING_PROVIDERS[key].connectFlow === "oauth",
)

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
