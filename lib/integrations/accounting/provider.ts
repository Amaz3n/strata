export type AccountingProviderKey = "qbo"

export type AccountingDimensionKind = "class" | "customer" | "location" | "department" | "entity"

export interface AccountingDimensionValue {
  id: string
  name: string
  fullyQualifiedName?: string
  email?: string | null
  accountType?: string
}

export type AccountingAccountKind = "income" | "expense" | "payment" | "ap"
export type AccountingCounterpartyRole = "customer" | "vendor"

export interface AccountingCounterpartyInput {
  displayName: string
  email?: string | null
  line1?: string | null
  city?: string | null
  state?: string | null
  postalCode?: string | null
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
  externalId: string | null
  externalVersion?: string | null
  docNumber?: string | null
  /** True when there was legitimately nothing to push (e.g. voiding an invoice that never reached the provider). */
  skipped?: boolean
  raw?: unknown
}

export interface AccountingProvider {
  readonly key: AccountingProviderKey
  readonly capabilities: AccountingCapabilities
  ensureHealthy(connectionId: string): Promise<{ ok: boolean; error?: string }>
  /** Refresh or otherwise re-validate provider credentials on demand. */
  refreshConnection?(connectionId: string): Promise<{ ok: boolean; error?: string }>
  /** Perform provider-owned credential keepalive for connections that are due. */
  keepAliveConnections?(limit: number): Promise<{ scanned: number; refreshed: number; failed: number }>
  /** Revoke provider-side credentials. Local lifecycle state is owned by the connection service. */
  disconnect(input: { orgId: string; connectionId: string }): Promise<void>
  pushInvoice(input: { orgId: string; connectionId: string; invoiceId: string; allowRecreateDeleted?: boolean }): Promise<PushResult>
  pushPayment(input: { orgId: string; connectionId: string; paymentId: string }): Promise<PushResult>
  pushExpense(input: { orgId: string; connectionId: string; expenseId: string }): Promise<PushResult>
  pushVendorBill(input: { orgId: string; connectionId: string; billId: string }): Promise<PushResult>
  pushVendorCredit?(input: { orgId: string; connectionId: string; creditId: string }): Promise<PushResult>
  pushBillPayment(input: { orgId: string; connectionId: string; paymentId: string }): Promise<PushResult>
  pushJournalEntry?(input: { orgId: string; connectionId: string; journalId: string }): Promise<PushResult>
  /**
   * Build the URL a user is sent to in order to authorize a new connection.
   * The returned state must round-trip through the provider's OAuth callback.
   */
  getConnectUrl?(input: { orgId: string }): Promise<{ url: string; state: string }>
  /**
   * Verify and persist an inbound webhook delivery into the provider's event queue.
   * Returns null when the request is not authentic (caller responds 401).
   */
  receiveWebhook?(input: { rawBody: string; headers: Record<string, string | null> }): Promise<{ received: number; inserted: number } | null>
  /** Poll the provider's change feed for one connection and enqueue changes. Requires capabilities.supportsCDC. */
  ingestChanges?(input: { connectionId: string; lookbackMinutes?: number | null }): Promise<{ scanned: number; inserted: number }>
  /** Drain the provider's inbound event queue, reconciling remote changes into Arc. */
  drainInboundEvents?(input: { limit: number }): Promise<{ processed: number; reconciled: number }>
  listDimensionValues(input: { connectionId: string; kind: AccountingDimensionKind }): Promise<AccountingDimensionValue[]>
  listAccounts(input: { connectionId: string; kind: AccountingAccountKind }): Promise<AccountingDimensionValue[]>
  searchCounterparties?(input: {
    connectionId: string
    role: AccountingCounterpartyRole
    term: string
  }): Promise<AccountingDimensionValue[]>
  createCounterparty?(input: {
    connectionId: string
    role: AccountingCounterpartyRole
    counterparty: AccountingCounterpartyInput
  }): Promise<AccountingDimensionValue>
  createAccount?(input: {
    connectionId: string
    kind: AccountingAccountKind
    name: string
  }): Promise<AccountingDimensionValue>
  getLastInvoiceNumber?(input: { connectionId: string }): Promise<string | null>
  uploadInvoiceAttachment?(input: {
    connectionId: string
    externalInvoiceId: string
    fileName: string
    contentType: string
    content: Buffer
    note?: string
  }): Promise<{ id: string }>
  resolveCounterparty(input: {
    connectionId: string
    role: "customer" | "vendor"
    companyId?: string
    displayName: string
    projectId?: string
  }): Promise<AccountingDimensionValue>
  reserveInvoiceNumber?(input: { connectionId: string; orgId: string }): Promise<{ reservedNumber: string; expiresAt: string }>
}
