export type AccountingImportEntityType =
  | "invoice"
  | "expense"
  | "expense_credit"
  | "bill"
  | "vendor_credit"
  | "payment"
  | "bill_payment"
  | "journal_entry"
  | "client_deposit"
export interface AccountingImportCostRef {
  type: "account" | "item"
  id: string
  name: string | null
}
export interface AccountingImportLine {
  lineId: string
  description: string
  amountCents: number
  customerId: string | null
  customerName: string | null
  costRef: AccountingImportCostRef | null
  suggestedCostCodeId: string | null
  suggestedProjectId: string | null
}
export interface AccountingImportLinkedDoc {
  externalId: string
  docLabel: string | null
  amountCents: number
  projectName: string | null
  inArc: boolean
}
export interface AccountingImportRecord {
  externalId: string
  entityType: AccountingImportEntityType
  docNumber: string | null
  counterparty: string | null
  date: string | null
  amountCents: number
  balanceCents: number | null
  hasLinks: boolean
  linkedEntityType?: "invoice" | "bill"
  linkedExternalIds?: string[]
  appliedVendorCreditExternalIds?: string[]
  dependencyStatus?: "already_in_arc" | "available_to_import" | "missing" | null
  dependencyMessage?: string | null
  possibleMatch?: string | null
  customerId?: string | null
  customerName?: string | null
  suggestedProjectId?: string | null
  customers?: { id: string; name: string | null }[]
  lines?: AccountingImportLine[]
  linkedDocs?: AccountingImportLinkedDoc[]
  possibleMatchId?: string | null
  possibleMatchEntityType?: "invoice" | "project_expense" | "bill" | null
}
export interface AccountingImportListing {
  connected: boolean
  records: AccountingImportRecord[]
  alreadyImportedCounts?: Partial<Record<AccountingImportEntityType, number>>
  loadErrors?: { entityType: AccountingImportEntityType; message: string }[]
}
export interface AccountingImportResult {
  imported: number
  skipped: number
  failed: number
  errors: { externalId: string; entityType: AccountingImportEntityType; message: string }[]
  affectedProjectIds?: string[]
}
export interface AccountingImportItem {
  externalId: string
  entityType: AccountingImportEntityType
  projectId?: string
  allocations?: Record<string, string>
  costCodes?: Record<string, string>
}
export interface AccountingImportCustomerListing {
  connected: boolean
  customers: { id: string; name: string; isProject: boolean }[]
}
export interface AccountingImportPreviewInput {
  orgId: string
  connectionId: string
  sinceDate?: string | null
  types?: AccountingImportEntityType[]
}
export interface AccountingImportApplyInput {
  orgId: string
  connectionId: string
  items: AccountingImportItem[]
}
export interface AccountingImportLinkInput {
  orgId: string
  connectionId: string
  externalId: string
  entityType: "invoice" | "expense" | "bill"
  existingEntityId: string
}
