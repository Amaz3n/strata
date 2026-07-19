export type AccountingProviderKey = "qbo"

export type AccountingDimensionKind = "class" | "customer" | "location" | "department" | "entity"

export interface AccountingDimensionValue {
  id: string
  name: string | null
}

export interface AccountingCapabilities {
  supportsClasses: boolean
  supportsLocations: boolean
  supportsDepartments: boolean
  supportsSubCustomers: boolean
  supportsInvoiceNumberReservation: boolean
  supportsInvoiceDocNumberSync: boolean
  supportsCDC: boolean
  supportsWebhooks: boolean
  supportsAttachments: boolean
  supportsJournalEntryPush: boolean
  supportsVendorCredits: boolean
  updateConcurrency: "sync_token" | "etag" | "none"
  dimensions: AccountingDimensionKind[]
}

export interface AccountingConnection {
  id: string
  orgId: string
  provider: AccountingProviderKey
  label: string
  externalAccountId: string
  externalAccountName: string | null
  status: "active" | "expired" | "disconnected" | "error"
  settings: Record<string, unknown>
  connectedAt: string
  lastSyncAt: string | null
  lastError: string | null
}

export interface AccountingTarget {
  connection: AccountingConnection
  dimensions: Partial<Record<AccountingDimensionKind, AccountingDimensionValue>>
  resolvedFrom: "project" | "community" | "division" | "org_default"
  healthy: boolean
}

export interface PushResult {
  externalId: string
  externalVersion?: string | null
  docNumber?: string | null
  raw?: unknown
}

export interface PullChange {
  entityName: string
  externalId: string
  operation: "create" | "update" | "delete" | "void"
  payload: unknown
  updatedAt: string
}

export interface AccountingProvider {
  readonly key: AccountingProviderKey
  readonly capabilities: AccountingCapabilities
  ensureHealthy(connectionId: string): Promise<{ ok: boolean; error?: string }>
  disconnect(connectionId: string): Promise<void>
  pushInvoice(input: { orgId: string; invoiceId: string; allowRecreateDeleted?: boolean }): Promise<PushResult>
  pushPayment(input: { orgId: string; paymentId: string }): Promise<PushResult>
  pushExpense(input: { orgId: string; expenseId: string }): Promise<PushResult>
  pushVendorBill(input: { orgId: string; billId: string }): Promise<PushResult>
  pushBillPayment(input: { orgId: string; paymentId: string }): Promise<PushResult>
  pushJournalEntry?(input: { orgId: string; journalId: string }): Promise<PushResult>
  pullChanges?(input: { connectionId: string; cursor: string | null }): Promise<{ changes: PullChange[]; nextCursor: string }>
  verifyWebhook?(input: { rawBody: string; headers: Record<string, string | null> }): Promise<PullChange[] | null>
  listDimensionValues(input: { connectionId: string; kind: AccountingDimensionKind }): Promise<AccountingDimensionValue[]>
  listAccounts(input: { connectionId: string; kind: "income" | "expense" | "payment" | "ap" }): Promise<AccountingDimensionValue[]>
  resolveCounterparty(input: {
    connectionId: string
    role: "customer" | "vendor"
    companyId?: string
    displayName: string
    projectId?: string
  }): Promise<AccountingDimensionValue>
  reserveInvoiceNumber?(input: { connectionId: string; orgId: string }): Promise<{ reservedNumber: string; expiresAt: string }>
}
