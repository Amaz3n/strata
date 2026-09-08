import type { AccountingImportApplyInput, AccountingImportPreviewInput, AccountingImportListing, AccountingImportResult, AccountingImportCustomerListing, AccountingImportLinkInput } from "@/lib/integrations/accounting/import"
export type AccountingProviderKey = "qbo" | "file"

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
  supportsSubCustomers: boolean
  supportsInvoiceDocNumberSync: boolean
  supportsCDC: boolean
  /**
   * Whether the provider can be READ from to pull existing records into Arc.
   * A batch/file target can be written to but never queried, so this is what
   * the import surface gates on — the UI used to compare the provider key,
   * which is the check a second adapter has to go edit.
   */
  supportsImport: boolean
  supportsAttachments: boolean
  supportsJournalEntryPush: boolean
  supportsVendorCredits: boolean
  /** Whether a posted bill payment can be reversed when an ACH return lands. */
  supportsBillPaymentVoid: boolean
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
  /**
   * True when the push could not run THIS attempt but must run later — e.g. a
   * concurrent attempt holds the create claim. Unlike `skipped`, the caller
   * must re-schedule the job; marking it completed loses the push forever.
   */
  deferred?: boolean
  raw?: unknown
}

export interface AccountingInboundQueueItem {
  id: string; connectionId: string; provider: string; entityName: string; externalId: string;
  operation: string; error: string | null; receivedAt: string; processedAt: string | null
}

export interface AccountingProvider {
  validateSettings?(settings: Record<string, unknown>): Record<string, unknown>

  previewImport?(input: AccountingImportPreviewInput): Promise<AccountingImportListing>
  applyImport?(input: AccountingImportApplyInput): Promise<AccountingImportResult>
  listImportCustomers?(input: { orgId: string; connectionId: string }): Promise<AccountingImportCustomerListing>
  linkExistingImportRecord?(input: AccountingImportLinkInput): Promise<{ linked: true }>

  listInboundEvents?(input: { orgId: string; limit: number }): Promise<AccountingInboundQueueItem[]>
  retryInboundEvent?(input: { orgId: string; eventId: string }): Promise<{ success: boolean; error: string | null }>

  /** Provider-owned transport/validation classification; shared workers never inspect provider fault codes. */
  classifyError?(error: unknown): { retryable: boolean; reason: string; message: string }
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
  /**
   * Reverse a previously pushed bill payment after an ACH return or reversal.
   *
   * Without this the two ledgers diverge permanently: Arc reopens the vendor
   * bill and the accounting system keeps a payment for money that came back.
   * Optional because not every target can void a posted payment — a batch-file
   * provider emits a reversing entry instead — so callers must check
   * `capabilities.supportsBillPaymentVoid` and surface an exception when it is
   * unsupported rather than silently leaving the books wrong.
   */
  voidBillPayment?(input: { orgId: string; connectionId: string; paymentId: string; reason: string }): Promise<PushResult>
  pushJournalEntry?(input: { orgId: string; connectionId: string; journalId: string }): Promise<PushResult>
  /**
   * Push ONE summarized journal per period, at account grain.
   *
   * This is the mirror's real shape. Pushing per source transaction turns the
   * external system into an unreadable dump of Arc's operational history, which
   * is the opposite of what a CPA filing from it needs: a monthly summary they
   * can tie to a trial balance. The lines are already mapped to external
   * accounts by the caller, so this is transport only.
   */
  pushSummaryJournal?(input: {
    orgId: string
    connectionId: string
    /** Stable key for idempotency — the same period must never post twice. */
    reference: string
    date: string
    memo: string
    lines: Array<{
      externalAccountId: string
      externalAccountName: string | null
      debitCents: number
      creditCents: number
      description: string
    }>
  }): Promise<PushResult>
  /**
   * Build the URL a user is sent to in order to authorize a new connection.
   * The returned state must round-trip through the provider's OAuth callback.
   */
  getConnectUrl?(input: { orgId: string; userId: string; connectionId?: string; expectedAccountId?: string }): Promise<{ url: string; state: string }>
  /**
   * Verify and persist an inbound webhook delivery into the provider's event queue.
   * Returns null when the request is not authentic (caller responds 401).
   */
  receiveWebhook?(input: { rawBody: string; headers: Record<string, string | null> }): Promise<{ received: number; inserted: number } | null>
  /** Poll the provider's change feed for one connection and enqueue changes. Requires capabilities.supportsCDC. */
  ingestChanges?(input: { connectionId: string; lookbackMinutes?: number | null }): Promise<{ scanned: number; inserted: number }>
  /** Drain the provider's inbound event queue, reconciling remote changes into Arc. */
  drainInboundEvents?(input: { limit: number }): Promise<{ processed: number; reconciled: number; ignored?: number; errored?: number }>
  /**
   * Resolve a both-sides conflict by taking the provider's copy: re-apply the
   * remote record over Arc's with the conflict guard released. Only offered on
   * rows already flagged needs_review/conflict.
   */
  resolveConflictTakeRemote?(input: {
    orgId: string
    connectionId: string
    entityType: "invoice" | "project_expense" | "bill"
    externalId: string
  }): Promise<{ reconciled: boolean; reason?: string }>
  listDimensionValues(input: { connectionId: string; kind: AccountingDimensionKind }): Promise<AccountingDimensionValue[]>
  listAccounts(input: { connectionId: string; kind: AccountingAccountKind }): Promise<AccountingDimensionValue[]>
  /** Complete active chart used by Books cutover and outbound-mirror mapping. */
  listAllAccounts?(input: { connectionId: string }): Promise<AccountingDimensionValue[]>
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
}
