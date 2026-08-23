import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { QBOClient, QBOError } from "@/lib/integrations/accounting/qbo/client"
import { enqueueOutboxJob } from "@/lib/services/outbox"
import { incrementInvoiceNumber, rememberAccountingInvoiceNumberCursor } from "@/lib/services/invoice-numbers"
import { recordEvent } from "@/lib/services/events"
import { logQBO } from "@/lib/services/accounting-logger"
import { downloadFilesObject } from "@/lib/storage/files-storage"
import type { AccountingProvider, PushResult } from "@/lib/integrations/accounting/provider"
import { getQBOAccessTokenForConnection, refreshQBOConnectionsDueForKeepalive } from "@/lib/integrations/accounting/qbo/connections"
import { resolveAccountingTarget } from "@/lib/services/accounting-target"
import {
  createOrUpdateQBOEntity,
  findAlreadyCreatedQBOTransaction,
  isStaleObjectError,
  QBO_DELETED_REVIEW_MESSAGE,
  resolveQBOSyncTarget,
  withArcTransactionMarker,
} from "@/lib/integrations/accounting/qbo/sync-safety"
import { createQBOOAuthState, decryptToken, getQBOAuthUrl, revokeQBOToken } from "@/lib/integrations/accounting/qbo/auth"
import { drainQboInboundEvents, forceReconcileFromQbo, ingestQboCdcChanges, receiveQboWebhook } from "@/lib/integrations/accounting/qbo/reconcile"
import { accountingDimension, accountingReference, type AccountingCoding } from "@/lib/services/accounting-coding"
import { stampLocalFingerprint } from "@/lib/integrations/accounting/local-change"
import { resolveAccountingExternalId } from "@/lib/services/accounting-sync-state"
import { persistAccountingInvoiceLineLinks } from "@/lib/services/accounting-invoice-line-links"

export { createOrUpdateQBOEntity, resolveQBOSyncTarget } from "@/lib/integrations/accounting/qbo/sync-safety"

async function disconnectQboProviderConnection(input: { orgId: string; connectionId: string }) {
  const supabase = createServiceSupabaseClient()
  const { data: connection, error } = await supabase
    .from("accounting_connections")
    .select("refresh_token")
    .eq("org_id", input.orgId)
    .eq("id", input.connectionId)
    .eq("provider", "qbo")
    .maybeSingle()
  if (error || !connection?.refresh_token) return
  try {
    await revokeQBOToken(decryptToken(connection.refresh_token))
  } catch (revokeError) {
    logQBO("warn", "token_revoke_failed_on_disconnect", {
      orgId: input.orgId,
      connectionId: input.connectionId,
      error: revokeError instanceof Error ? revokeError.message : String(revokeError),
    })
  }
}

interface InvoiceLineRow {
  id: string
  description: string
  quantity: number
  unit?: string | null
  unit_price_cents: number
  metadata?: Record<string, any> | null
  accounting_coding?: AccountingCoding | null
}

type ConfiguredInvoiceItem = { id: string; name?: string | null }

export class QBOInvoiceItemResolutionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "QBOInvoiceItemResolutionError"
  }
}

function configuredInvoiceItem(value: unknown): ConfiguredInvoiceItem | null {
  if (!value || typeof value !== "object") return null
  const candidate = value as { id?: unknown; name?: unknown }
  if (typeof candidate.id !== "string" || candidate.id.trim().length === 0) return null
  return {
    id: candidate.id.trim(),
    name: typeof candidate.name === "string" ? candidate.name : null,
  }
}

interface InvoiceForSync {
  id: string
  org_id: string
  project_id?: string | null
  invoice_number: string
  issue_date?: string | null
  due_date?: string | null
  total_cents?: number | null
  balance_due_cents?: number | null
  title?: string | null
  status?: string | null
  metadata?: Record<string, any> | null
  accounting_coding?: AccountingCoding | null
  lines: InvoiceLineRow[]
  project?: { qbo_class_id?: string | null; qbo_class_name?: string | null } | null
}

interface ProjectExpenseForSync {
  id: string
  org_id: string
  project_id: string
  vendor_company_id?: string | null
  vendor_name_text?: string | null
  expense_date: string
  description?: string | null
  amount_cents: number
  tax_cents?: number | null
  payment_method?: string | null
  is_billable?: boolean | null
  qbo_transaction_type?: "purchase" | "bill" | null
  qbo_expense_account_id?: string | null
  qbo_expense_account_name?: string | null
  qbo_payment_account_id?: string | null
  qbo_payment_account_name?: string | null
  qbo_ap_account_id?: string | null
  qbo_ap_account_name?: string | null
  qbo_vendor_id?: string | null
  qbo_vendor_name?: string | null
  qbo_class_id?: string | null
  qbo_class_name?: string | null
  qbo_id?: string | null
  receipt_file_id?: string | null
  metadata?: Record<string, any> | null
  accounting_coding?: AccountingCoding | null
  project?: { name?: string | null; qbo_class_id?: string | null; qbo_class_name?: string | null } | null
  vendor_company?: { name?: string | null } | null
}

interface VendorBillForSync {
  id: string
  org_id: string
  project_id: string
  commitment_id?: string | null
  company_id?: string | null
  bill_number?: string | null
  bill_date?: string | null
  due_date?: string | null
  total_cents?: number | null
  currency?: string | null
  file_id?: string | null
  metadata?: Record<string, any> | null
  accounting_coding?: AccountingCoding | null
  qbo_id?: string | null
  qbo_expense_account_id?: string | null
  qbo_expense_account_name?: string | null
  qbo_ap_account_id?: string | null
  qbo_ap_account_name?: string | null
  qbo_vendor_id?: string | null
  qbo_vendor_name?: string | null
  qbo_class_id?: string | null
  qbo_class_name?: string | null
  project?: { name?: string | null; qbo_class_id?: string | null; qbo_class_name?: string | null } | null
  commitment?: {
    title?: string | null
    company?: {
      id?: string | null
      name?: string | null
      qbo_vendor_id?: string | null
      qbo_vendor_name?: string | null
    } | null
  } | null
  company?: {
    id?: string | null
    name?: string | null
    qbo_vendor_id?: string | null
    qbo_vendor_name?: string | null
  } | null
  bill_lines?: Array<{
    id?: string | null
    project_id?: string | null
    description?: string | null
    quantity?: number | null
    unit_cost_cents?: number | null
    metadata?: Record<string, any> | null
    project?: { name?: string | null; qbo_class_id?: string | null; qbo_class_name?: string | null } | null
  }>
}

function isCostDrivenBillingModel(billingModel?: string | null) {
  return (
    billingModel === "cost_plus_percent" ||
    billingModel === "cost_plus_fixed_fee" ||
    billingModel === "cost_plus_gmp" ||
    billingModel === "time_and_materials"
  )
}

function vendorBillHasQboExpenseCoding(bill: Pick<VendorBillForSync, "qbo_expense_account_id" | "bill_lines">) {
  if (bill.qbo_expense_account_id) return true
  const lines = bill.bill_lines ?? []
  if (lines.length === 0) return false
  return lines.every((line) => {
    const metadata = (line.metadata as Record<string, any> | null) ?? {}
    return typeof metadata.qbo_expense_account_id === "string" && metadata.qbo_expense_account_id.trim().length > 0
  })
}

type SyncRecordEntityType = "invoice" | "payment" | "project_expense" | "bill" | "vendor_credit" | "bill_payment"

/**
 * Inbound-only ("shadow") records — e.g. expenses projected from a QBO journal entry, or one QBO
 * payment split into several Arc payments — are linked with `pushable = false`. They exist in Arc for
 * balance accuracy and visibility, but must never originate an outbound change: pushing them back
 * would create duplicates or overwrite the single QBO transaction they share. This is the single
 * guard that keeps the two-way sync trustworthy as we adopt more 1:many / non-native QBO types.
 */
async function isSyncPushBlocked(
  supabase: ReturnType<typeof createServiceSupabaseClient>,
  orgId: string,
  entityType: SyncRecordEntityType,
  entityId: string,
  connectionId?: string | null,
): Promise<boolean> {
  const resolvedConnectionId = await resolveHealthConnectionId(orgId, connectionId)
  if (!resolvedConnectionId) return false
  const { data } = await supabase
    .from("accounting_sync_records")
    .select("pushable")
    .eq("org_id", orgId)
    .eq("connection_id", resolvedConnectionId)
    .eq("entity_type", entityType)
    .eq("entity_id", entityId)
    .maybeSingle()
  return data?.pushable === false
}

async function getQBOConnectionSettings(orgId: string, connectionId?: string | null) {
  const supabase = createServiceSupabaseClient()
  let query = supabase.from("accounting_connections").select("id,settings").eq("org_id", orgId).eq("provider", "qbo").eq("status", "active")
  query = connectionId ? query.eq("id", connectionId) : query.order("connected_at", { ascending: true }).limit(1)
  const { data } = await query.maybeSingle()
  return data
}

async function resolveQboVendorForConnection(input: {
  client: QBOClient
  supabase: ReturnType<typeof createServiceSupabaseClient>
  orgId: string
  connectionId?: string | null
  companyId?: string | null
  displayName: string
  legacyId?: string | null
  legacyName?: string | null
}) {
  if (input.connectionId && input.companyId) {
    const { data: link } = await input.supabase.from("accounting_counterparty_links")
      .select("external_id,external_name,metadata").eq("org_id", input.orgId).eq("connection_id", input.connectionId)
      .eq("role", "vendor").eq("entity_type", "company").eq("entity_id", input.companyId).maybeSingle()
    if (link?.external_id) return { Id: link.external_id, DisplayName: link.external_name ?? (link.metadata as { display_name?: string } | null)?.display_name ?? input.displayName }
  } else if (input.legacyId) {
    return { Id: input.legacyId, DisplayName: input.legacyName ?? input.displayName }
  }
  const vendor = await input.client.getOrCreateVendor(input.displayName)
  if (vendor.Id && input.connectionId && input.companyId) {
    const now = new Date().toISOString()
    const { error: linkError } = await input.supabase.from("accounting_counterparty_links").upsert({
      org_id: input.orgId, connection_id: input.connectionId, provider: "qbo", role: "vendor", entity_type: "company",
      entity_id: input.companyId, external_id: vendor.Id, external_version: vendor.SyncToken ?? null,
      external_name: vendor.DisplayName ?? input.displayName, status: "synced", last_synced_at: now,
      error_message: null, metadata: { display_name: vendor.DisplayName ?? input.displayName },
    }, { onConflict: "org_id,connection_id,role,entity_type,entity_id" })
    if (linkError) throw new Error(`Unable to persist vendor accounting link: ${linkError.message}`)

  }
  return vendor
}

export async function syncInvoiceToQBO(invoiceId: string, orgId: string, options?: { allowRecreateDeleted?: boolean; connectionId?: string }) {
  const supabase = createServiceSupabaseClient()
  const client = options?.connectionId ? await QBOClient.forConnection(options.connectionId) : await QBOClient.forOrg(orgId)

  if (!client) {
    await markConnectionError(orgId, "No active QBO connection", options?.connectionId)
    return { success: false, error: "No active QBO connection" }
  }

  const resolvedConnectionId = await resolveHealthConnectionId(orgId, options?.connectionId)
  if (!resolvedConnectionId) {
    return { success: false, error: "No active QBO connection" }
  }

  if (await isSyncPushBlocked(supabase, orgId, "invoice", invoiceId, resolvedConnectionId)) {
    return { success: true, skipped: true }
  }

  const { data: invoice, error } = await supabase
    .from("invoices")
    .select(
      "id, org_id, project_id, invoice_number, issue_date, due_date, total_cents, balance_due_cents, title, status, metadata, invoice_lines (id, description, quantity, unit, unit_price_cents, metadata)",
    )
    .eq("id", invoiceId)
    .eq("org_id", orgId)
    .single()

  if (error || !invoice) {
    return { success: false, error: error?.message ?? "Invoice not found" }
  }

  const typedInvoice = {
    ...invoice,
    lines: (invoice as any).invoice_lines ?? [],
  } as InvoiceForSync
  const accountingTarget = await resolveAccountingTarget({ orgId, projectId: typedInvoice.project_id ?? null })
  const projectClass = accountingTarget?.dimensions.class
    ? { qbo_class_id: accountingTarget.dimensions.class.id, qbo_class_name: accountingTarget.dimensions.class.name }
    : null

  const connection = await getQBOConnectionSettings(orgId, resolvedConnectionId)
  const connectionSettings = ((connection?.settings as Record<string, unknown> | null) ?? {})

  if (connectionSettings.sync_invoices === false) {
    return { success: true, skipped: true }
  }

  // QBO-originated invoices remain inbound-owned unless a deliberate adoption
  // flow marks them as outbound. This prevents an Arc edit from overwriting the
  // accountant's source transaction.
  if (
    (typedInvoice.metadata as Record<string, unknown> | null)?.imported_from_qbo === true &&
    (typedInvoice.metadata as Record<string, unknown> | null)?.accounting_push_adopted !== true
  ) {
    return { success: true, skipped: true }
  }

  const invoiceIncomeAccountId = (typedInvoice.metadata as any)?.qbo_income_account_id
  const defaultIncomeAccountId =
    typeof invoiceIncomeAccountId === "string" && invoiceIncomeAccountId.trim().length > 0
      ? invoiceIncomeAccountId.trim()
      : (connectionSettings.default_income_account_id as string | undefined)
  let existingSync: any = null
  let qboInvoice: any = null
  let invoiceIsUpdate = false
  let persistResolvedLineLinks: ((remoteInvoice: any) => Promise<void>) | null = null

  try {
    existingSync = await supabase
      .from("accounting_sync_records")
      .select("external_id, external_version")
      .eq("org_id", orgId)
      .eq("connection_id", resolvedConnectionId)
      .eq("entity_type", "invoice")
      .eq("entity_id", invoiceId)
      .maybeSingle()

    const existingQboId = existingSync.data?.external_id || null
    if (typedInvoice.status === "void") {
      if (!existingQboId) {
        return { success: true, skipped: true }
      }

      const latestInvoice = await client.getInvoiceById(existingQboId)
      if (!latestInvoice) {
        // The desired state is already true when the linked QBO invoice was
        // deleted. Keep its id as a tombstone so the import sheet cannot adopt
        // the same QBO identity again, and clear any prior sync error.
        await upsertSyncRecord({
          orgId,
          connectionId: options?.connectionId,
          entityId: invoiceId,
          qboId: existingQboId,
          entityType: "invoice",
        })
        await markConnectionHealthy(orgId, options?.connectionId)
        logQBO("info", "invoice_void_sync_already_deleted", { orgId, invoiceId, qboId: existingQboId })
        return { success: true, qbo_id: existingQboId, already_deleted: true }
      }
      if (!latestInvoice.SyncToken) {
        throw new Error("Unable to load the QuickBooks invoice before voiding it.")
      }
      const voided = await client.voidInvoice({
        Id: existingQboId,
        SyncToken: latestInvoice.SyncToken,
      })
      await upsertSyncRecord({
        orgId,
        connectionId: options?.connectionId,
        entityId: invoiceId,
        qboId: existingQboId,
        syncToken: voided.SyncToken,
        entityType: "invoice",
      })
      await markConnectionHealthy(orgId, options?.connectionId)
      logQBO("info", "invoice_void_sync_success", { orgId, invoiceId, qboId: existingQboId })
      return { success: true, qbo_id: existingQboId }
    }

    const accountingCustomerRef = (typedInvoice.metadata as any)?.accounting_customer_ref
    const metadataQboCustomerId = typeof accountingCustomerRef === "object" ? accountingCustomerRef?.id : accountingCustomerRef ?? (typedInvoice.metadata as any)?.qbo_customer_id
    const metadataQboCustomerName = typeof accountingCustomerRef === "object" ? accountingCustomerRef?.name : (typedInvoice.metadata as any)?.qbo_customer_name
    const mappedCustomer = accountingTarget?.dimensions.customer
    const customer =
      typeof metadataQboCustomerId === "string" && metadataQboCustomerId.trim().length > 0
        ? { Id: metadataQboCustomerId.trim(), DisplayName: String(metadataQboCustomerName ?? resolveCustomerName(typedInvoice)) }
        : mappedCustomer?.id
          ? { Id: mappedCustomer.id, DisplayName: mappedCustomer.name ?? resolveCustomerName(typedInvoice) }
        : await client.getOrCreateCustomer(resolveCustomerName(typedInvoice))
    const { data: savedLineLinks, error: savedLineLinksError } = await supabase
      .from("accounting_invoice_line_links")
      .select("invoice_line_id,external_item_id,external_item_name")
      .eq("org_id", orgId)
      .eq("connection_id", resolvedConnectionId)
      .eq("invoice_id", invoiceId)
    if (savedLineLinksError) throw new Error(`Unable to load accounting invoice-line links: ${savedLineLinksError.message}`)
    const savedItemByLineId = new Map(
      (savedLineLinks ?? []).map((link) => [
        link.invoice_line_id,
        { id: String(link.external_item_id), name: link.external_item_name ? String(link.external_item_name) : null },
      ]),
    )
    const configuredMappings =
      connectionSettings.invoice_item_mappings && typeof connectionSettings.invoice_item_mappings === "object"
        ? (connectionSettings.invoice_item_mappings as Record<string, unknown>)
        : {}
    const defaultInvoiceItem = configuredInvoiceItem(connectionSettings.default_invoice_item)
    const itemCache = new Map<string, Awaited<ReturnType<QBOClient["getInvoiceItemById"]>>>()
    let activeInvoiceItemsPromise: ReturnType<QBOClient["listInvoiceItems"]> | null = null
    const resolveInvoiceItem = async (line: InvoiceLineRow) => {
      const normalizedLineAccount =
        typeof (line.metadata as any)?.qbo_income_account_id === "string" && (line.metadata as any).qbo_income_account_id.trim().length > 0
          ? (line.metadata as any).qbo_income_account_id.trim()
          : defaultIncomeAccountId
      const metadataItem = configuredInvoiceItem({
        id: (line.metadata as any)?.qbo_item_id,
        name: (line.metadata as any)?.qbo_item_name,
      })
      const savedItem = savedItemByLineId.get(line.id) ?? null
      const mappedItem = normalizedLineAccount ? configuredInvoiceItem(configuredMappings[normalizedLineAccount]) : null
      let candidate = metadataItem ?? savedItem ?? mappedItem ?? defaultInvoiceItem
      // A unique existing item already wired to this income account is safe to
      // adopt automatically. Ambiguous or missing matches still require setup.
      if (!candidate && normalizedLineAccount) {
        activeInvoiceItemsPromise ??= client.listInvoiceItems()
        const accountMatches = (await activeInvoiceItemsPromise).filter(
          (item) => item.incomeAccountId === normalizedLineAccount,
        )
        if (accountMatches.length === 1) {
          candidate = { id: accountMatches[0]!.id, name: accountMatches[0]!.name }
        }
      }
      if (!candidate) {
        throw new QBOInvoiceItemResolutionError(
          `Invoice line “${line.description || line.id}” has no QuickBooks Product/Service. Map income account ${normalizedLineAccount ?? "(none)"} to an existing item, or choose a default invoice item in Accounting settings.`,
        )
      }
      let item = itemCache.get(candidate.id)
      if (item === undefined) {
        item = await client.getInvoiceItemById(candidate.id)
        itemCache.set(candidate.id, item)
      }
      if (!item) {
        throw new QBOInvoiceItemResolutionError(
          `QuickBooks Product/Service ${candidate.name ?? candidate.id} no longer exists. Choose a replacement in Accounting settings.`,
        )
      }
      if (!item.active) {
        throw new QBOInvoiceItemResolutionError(
          `QuickBooks Product/Service ${item.name} is inactive. Choose an active replacement in Accounting settings.`,
        )
      }
      return item
    }

    // Note: we intentionally do NOT write this invoice's customer to the project's customer map. The
    // project default is owned by project settings (and the client-contact fallback in
    // getOrCreateProjectCustomer) so a one-off invoice can't silently re-point every future payable.

    const resolvedLineItems = await Promise.all((typedInvoice.lines ?? []).map(resolveInvoiceItem))
    const qboLines = (typedInvoice.lines ?? []).map((line, index) => {
        const item = resolvedLineItems[index]!
        const classRef = resolveQBOClassRef(line.metadata, projectClass)
        return {
          DetailType: "SalesItemLineDetail" as const,
          Amount: centsToAmount(line.quantity * line.unit_price_cents),
          Description: line.description,
          SalesItemLineDetail: {
            ItemRef: { value: item.id, name: item.name },
            Qty: line.quantity,
            UnitPrice: centsToAmount(line.unit_price_cents),
            // "TAX"/"NON" only exist in US non-AST company files; Canadian/UK/AU
            // realms and Automated-Sales-Tax files need their own codes, set via
            // connection settings until a picker exists.
            TaxCodeRef: {
              value:
                (line.metadata as any)?.taxable === false
                  ? ((connectionSettings.exempt_tax_code as string | undefined) ?? "NON")
                  : ((connectionSettings.taxable_tax_code as string | undefined) ?? "TAX"),
            },
            ClassRef: classRef,
          },
        }
      })

    // Invoice-level discount syncs as a QBO discount line so QBO's computed total matches Arc's.
    const invoiceDiscountCents = Number(
      ((typedInvoice.metadata as Record<string, any> | null)?.totals as Record<string, any> | undefined)?.discount_cents ?? 0,
    )
    if (invoiceDiscountCents > 0) {
      qboLines.push({
        DetailType: "DiscountLineDetail",
        Amount: centsToAmount(invoiceDiscountCents),
        DiscountLineDetail: { PercentBased: false },
      } as any)
    }

    // Resolve a usable SyncToken before updating: invoices imported from QBO
    // (or with a token that drifted) carry a qbo_id but no cached token, which
    // would otherwise fail with "Invoice Id and SyncToken required for update".
    let invoiceTarget = await resolveQBOSyncTarget({
      client,
      entityType: "invoice",
      qboId: existingSync.data?.external_id,
      cachedSyncToken: existingSync.data?.external_version,
      logContext: { orgId, invoiceId },
      allowRecreateDeleted: options?.allowRecreateDeleted === true,
    })
    if (invoiceTarget.mode === "create") {
      const claimed = await claimSyncCreate({
        orgId,
        connectionId: connection?.id ?? null,
        entityType: "invoice",
        entityId: invoiceId,
      })
      if (!claimed) {
        return { success: true, skipped: true, pending: true }
      }
      // A sync record with no external id is evidence of a prior create whose
      // response was lost — look for our own marker before creating a SECOND
      // invoice in the customer's books.
      if (existingSync.data) {
        const adoptedInvoiceId = await findAlreadyCreatedQBOTransaction({
          client,
          entity: "Invoice",
          entityType: "invoice",
          entityId: invoiceId,
          logContext: { orgId },
        })
        if (adoptedInvoiceId) {
          const adopted = await client.getInvoiceById(adoptedInvoiceId)
          if (adopted?.SyncToken) {
            invoiceTarget = { mode: "update", id: adoptedInvoiceId, syncToken: adopted.SyncToken }
          }
        }
      }
    }
    invoiceIsUpdate = invoiceTarget.mode === "update"

    qboInvoice = {
      // Sparse update: QBO clears any field absent from a full update, so a
      // non-sparse payload wiped SalesTermRef, CustomerMemo, BillEmail, custom
      // fields and tax overrides the accountant set on the live invoice. The
      // fields Arc owns are all present below and still replace.
      ...(invoiceTarget.mode === "update" ? { Id: invoiceTarget.id, SyncToken: invoiceTarget.syncToken, sparse: true } : {}),
      DocNumber: typedInvoice.invoice_number,
      TxnDate: typedInvoice.issue_date ?? new Date().toISOString().split("T")[0],
      DueDate: typedInvoice.due_date ?? undefined,
      CustomerRef: { value: customer.Id!, name: customer.DisplayName },
      Line: qboLines,
      PrivateNote: withArcTransactionMarker(typedInvoice.title, "invoice", invoiceId),
    }

    persistResolvedLineLinks = async (remoteInvoice: any) => {
      const remoteSalesLines = (remoteInvoice?.Line ?? []).filter(
        (line: any) => line?.DetailType === "SalesItemLineDetail",
      )
      await persistAccountingInvoiceLineLinks({
        supabase,
        orgId,
        connectionId: resolvedConnectionId,
        provider: "qbo",
        invoiceId,
        externalInvoiceId: String(remoteInvoice.Id),
        lines: (typedInvoice.lines ?? []).map((line, index) => {
          const item = resolvedLineItems[index]!
          const remoteLine = remoteSalesLines[index]
          return {
            invoiceLineId: line.id,
            externalLineId: remoteLine?.Id ? String(remoteLine.Id) : null,
            externalItemId: item.id,
            externalItemName: item.name,
            externalIncomeAccountId: item.incomeAccountId,
            externalIncomeAccountName: item.incomeAccountName,
          }
        }),
      })
    }

    const result = invoiceIsUpdate
      ? await client.updateInvoice(qboInvoice as any)
      : await client.createInvoice(qboInvoice as any)

    await upsertSyncRecord({
      orgId,
      connectionId: options?.connectionId,
      entityId: invoiceId,
      qboId: result.Id!,
      syncToken: result.SyncToken,
      entityType: "invoice",
    })
    await persistResolvedLineLinks(result)

    await rememberAccountingInvoiceNumberCursor(options?.connectionId ?? "", orgId, result.DocNumber ?? typedInvoice.invoice_number)
    await syncInvoicePdfAttachmentToQBO({
      client,
      supabase,
      orgId,
      invoiceId,
      qboInvoiceId: result.Id!,
    })
    await markConnectionHealthy(orgId, options?.connectionId)
    warnOnInvoiceTotalDivergence(orgId, invoiceId, typedInvoice.total_cents, result)
    logQBO("info", "invoice_sync_success", { orgId, invoiceId, qboId: result.Id })

    return { success: true, qbo_id: result.Id }
  } catch (err: any) {
    if (err instanceof QBOError && isStaleObjectError(err) && existingSync?.data?.external_id) {
      try {
        const latestInvoice = await client.getInvoiceById(existingSync.data.external_id)
        if (!latestInvoice?.SyncToken) {
          throw new Error("Unable to refresh QuickBooks invoice sync token")
        }

        const retryInvoice = {
          ...qboInvoice,
          SyncToken: latestInvoice.SyncToken,
        }
        const retryResult = await client.updateInvoice(retryInvoice as any)

        await upsertSyncRecord({
          orgId,
          connectionId: options?.connectionId,
          entityId: invoiceId,
          qboId: retryResult.Id!,
          syncToken: retryResult.SyncToken,
          entityType: "invoice",
        })
        if (persistResolvedLineLinks) await persistResolvedLineLinks(retryResult)

        await rememberAccountingInvoiceNumberCursor(options?.connectionId ?? "", orgId, retryResult.DocNumber ?? typedInvoice.invoice_number)
        await syncInvoicePdfAttachmentToQBO({
          client,
          supabase,
          orgId,
          invoiceId,
          qboInvoiceId: retryResult.Id!,
        })
        await markConnectionHealthy(orgId, options?.connectionId)
        logQBO("warn", "invoice_sync_stale_token_retried", {
          orgId,
          invoiceId,
          qboId: retryResult.Id,
        })

        return { success: true, qbo_id: retryResult.Id }
      } catch (retryError: any) {
        const retryErrorMessage = retryError instanceof QBOError ? retryError.message : retryError?.message ?? "Stale sync token retry failed"
        await markSyncRecordError(orgId, "invoice", invoiceId, retryErrorMessage, options?.connectionId)
        await markConnectionErrorIfConnectionLevel(orgId, retryError, retryErrorMessage, options?.connectionId)
        logQBO("error", "invoice_sync_stale_token_retry_failed", {
          orgId,
          invoiceId,
          error: retryErrorMessage,
          qbo_status: retryError instanceof QBOError ? retryError.status : undefined,
          qbo_fault_type: retryError instanceof QBOError ? retryError.faultType : undefined,
          qbo_fault_code: retryError instanceof QBOError ? retryError.faultCode : undefined,
          qbo_fault_detail: retryError instanceof QBOError ? retryError.faultDetail : undefined,
          intuit_tid: retryError instanceof QBOError ? retryError.intuitTid : undefined,
        })
        return { success: false, error: retryErrorMessage, ...qboFaultFields(retryError) }
      }
    }

    if (err instanceof QBOError && isDuplicateDocNumber(err)) {
      try {
        const lastNumber = await client.getLastInvoiceNumber()
        const nextNumber = incrementInvoiceNumber(lastNumber, (connection?.settings as any) ?? null)

        await supabase
          .from("invoices")
          .update({
            invoice_number: nextNumber,
            metadata: {
              ...(typedInvoice.metadata ?? {}),
              invoice_number_changed: true,
              invoice_number_previous: typedInvoice.invoice_number,
            },
          })
          .eq("id", invoiceId)

        const retryInvoice = {
          ...qboInvoice,
          DocNumber: nextNumber,
        }

        const retryResult = invoiceIsUpdate
          ? await client.updateInvoice(retryInvoice as any)
          : await client.createInvoice(retryInvoice as any)

        await upsertSyncRecord({
          orgId,
          connectionId: options?.connectionId,
          entityId: invoiceId,
          qboId: retryResult.Id!,
          syncToken: retryResult.SyncToken,
          entityType: "invoice",
        })

        await rememberAccountingInvoiceNumberCursor(options?.connectionId ?? "", orgId, retryResult.DocNumber ?? nextNumber)
        await syncInvoicePdfAttachmentToQBO({
          client,
          supabase,
          orgId,
          invoiceId,
          qboInvoiceId: retryResult.Id!,
        })
        await markConnectionHealthy(orgId, options?.connectionId)
        logQBO("warn", "invoice_sync_docnumber_adjusted", {
          orgId,
          invoiceId,
          previousNumber: typedInvoice.invoice_number,
          nextNumber,
          qboId: retryResult.Id,
        })

        await recordEvent({
          orgId,
          eventType: "invoice_number_changed",
          entityType: "invoice",
          entityId: invoiceId,
          payload: {
            previous_number: typedInvoice.invoice_number,
            new_number: nextNumber,
            reason: "docnumber_conflict",
          },
          channel: "notification",
        })

        return { success: true, qbo_id: retryResult.Id }
      } catch (retryError: any) {
        const retryErrorMessage = retryError instanceof QBOError ? retryError.message : retryError?.message ?? "DocNumber conflict"
        await markSyncRecordError(orgId, "invoice", invoiceId, retryErrorMessage, options?.connectionId)
        await markConnectionErrorIfConnectionLevel(orgId, retryError, retryErrorMessage, options?.connectionId)
        logQBO("error", "invoice_sync_docnumber_retry_failed", {
          orgId,
          invoiceId,
          error: retryErrorMessage,
          qbo_status: retryError instanceof QBOError ? retryError.status : undefined,
          qbo_fault_type: retryError instanceof QBOError ? retryError.faultType : undefined,
          qbo_fault_code: retryError instanceof QBOError ? retryError.faultCode : undefined,
          qbo_fault_detail: retryError instanceof QBOError ? retryError.faultDetail : undefined,
          intuit_tid: retryError instanceof QBOError ? retryError.intuitTid : undefined,
        })
        return { success: false, error: retryErrorMessage, ...qboFaultFields(retryError) }
      }
    }

    const errorMessage = err instanceof QBOError ? err.message : String(err)
    if (errorMessage === QBO_DELETED_REVIEW_MESSAGE) {
      await markSyncRecordNeedsReview(orgId, "invoice", invoiceId, errorMessage, options?.connectionId)
      return { success: false, error: errorMessage, ...qboFaultFields(err) }
    }
    await markSyncRecordError(orgId, "invoice", invoiceId, errorMessage, options?.connectionId)
    await markConnectionErrorIfConnectionLevel(orgId, err, errorMessage, options?.connectionId)
    logQBO("error", "invoice_sync_failed", {
      orgId,
      invoiceId,
      error: errorMessage,
      qbo_status: err instanceof QBOError ? err.status : undefined,
      qbo_fault_type: err instanceof QBOError ? err.faultType : undefined,
      qbo_fault_code: err instanceof QBOError ? err.faultCode : undefined,
      qbo_fault_detail: err instanceof QBOError ? err.faultDetail : undefined,
      intuit_tid: err instanceof QBOError ? err.intuitTid : undefined,
    })
    return { success: false, error: errorMessage, ...qboFaultFields(err) }
  }
}

export async function syncPaymentToQBO(paymentId: string, orgId: string, options?: { connectionId?: string }) {
  const supabase = createServiceSupabaseClient()
  const client = options?.connectionId ? await QBOClient.forConnection(options.connectionId) : await QBOClient.forOrg(orgId)
  if (!client) {
    await markConnectionError(orgId, "No active QBO connection", options?.connectionId)
    return { success: false, error: "No active QBO connection" }
  }

  const resolvedConnectionId = await resolveHealthConnectionId(orgId, options?.connectionId)
  if (!resolvedConnectionId) {
    return { success: false, error: "No active QBO connection" }
  }

  if (await isSyncPushBlocked(supabase, orgId, "payment", paymentId, resolvedConnectionId)) {
    return { success: true, skipped: true }
  }

  const { data: existingPaymentSync } = await supabase
    .from("accounting_sync_records")
    .select("qbo_id:external_id")
    .eq("org_id", orgId)
    .eq("connection_id", resolvedConnectionId)
    .eq("entity_type", "payment")
    .eq("entity_id", paymentId)
    .maybeSingle()

  if (existingPaymentSync?.qbo_id) {
    return { success: true, qbo_id: existingPaymentSync.qbo_id }
  }
  // A sync record with no external id is the fingerprint of an attempt that ran
  // and did not get to write its result down — the case where QuickBooks may
  // already hold the payment. See `findAlreadyCreatedQBOTransaction`.
  const paymentRetryAfterUnknownOutcome = existingPaymentSync != null

  try {
    const { data: payment, error } = await supabase
      .from("payments")
      .select(
        "id, org_id, invoice_id, amount_cents, provider, method, metadata, invoice:invoices(qbo_id, org_id, project_id, title, metadata)",
      )
      .eq("id", paymentId)
      .eq("org_id", orgId)
      .single()

    if (error || !payment) return { success: false, error: error?.message ?? "Payment not found" }

    // Internal settlement rows (deposit application, Arc Books credits) move no
    // new cash — pushing them would double-count the deposit that was already
    // received and pushed as its own payment.
    if (payment.provider === "arc_books" || payment.method === "credit") {
      logQBO("info", "payment_sync_skipped_internal_settlement", { orgId, paymentId, provider: payment.provider, method: payment.method })
      return { success: true, skipped: true }
    }

    const invoice = Array.isArray(payment.invoice) ? payment.invoice[0] : payment.invoice
    // C3.4 dual-read: the sync ledger owns this link now, the column is only the
    // fallback for entities the backfill has not reached.
    const invoiceExternalId = payment.invoice_id
      ? await resolveAccountingExternalId(supabase, {
          orgId,
          connectionId: resolvedConnectionId,
          entityType: "invoice",
          entityId: payment.invoice_id,
          legacyExternalId: invoice?.qbo_id ?? null,
        })
      : null
    if (!invoiceExternalId) {
      const message = "Invoice not synced to QBO"
      await markSyncRecordError(orgId, "payment", paymentId, message, options?.connectionId)
      if (payment.invoice_id) {
        await enqueueOutboxJob({
          orgId,
          jobType: "accounting_push_invoice",
          payload: { invoice_id: payment.invoice_id },
          dedupeByPayloadKeys: ["invoice_id"],
        })
      }
      return { success: false, error: message }
    }

    const claimed = await claimSyncCreate({
      orgId,
      connectionId: resolvedConnectionId,
      entityType: "payment",
      entityId: paymentId,
    })
    if (!claimed) {
      return { success: true, skipped: true, pending: true }
    }

    const { data: customerSync } = await supabase
      .from("accounting_sync_records")
      .select("qbo_id:external_id")
      .eq("org_id", orgId)
      .eq("connection_id", resolvedConnectionId)
      .eq("entity_type", "customer")
      .eq("entity_id", invoice.project_id)
      .maybeSingle()

    const customerRef = customerSync?.qbo_id
      ? { value: customerSync.qbo_id }
      : await (async () => {
          const derivedName =
            (invoice as any)?.metadata?.customer_name ??
            (invoice as any)?.title ??
            "Customer"
          const cust = await client.getOrCreateCustomer(String(derivedName))
          if (invoice.project_id && cust.Id) {
            await upsertSyncRecord({
              orgId,
              connectionId: resolvedConnectionId,
              entityId: invoice.project_id,
              qboId: cust.Id,
              entityType: "customer",
            })
          }
          return { value: cust.Id! }
        })()

    const adoptedPaymentId = paymentRetryAfterUnknownOutcome
      ? await findAlreadyCreatedQBOTransaction({
          client,
          entity: "Payment",
          entityType: "payment",
          entityId: paymentId,
          logContext: { orgId },
        })
      : null

    const qboPayment = adoptedPaymentId
      ? { Id: adoptedPaymentId }
      : await client.createPayment({
          CustomerRef: customerRef,
          TotalAmt: centsToAmount(payment.amount_cents),
          PrivateNote: withArcTransactionMarker(null, "payment", paymentId),
          Line: [
            {
              Amount: centsToAmount(payment.amount_cents),
              LinkedTxn: [{ TxnId: invoiceExternalId, TxnType: "Invoice" }],
            },
          ],
        })

    await upsertSyncRecord({
      orgId,
      connectionId: resolvedConnectionId,
      entityId: paymentId,
      qboId: qboPayment.Id,
      entityType: "payment",
    })

    await markConnectionHealthy(orgId, options?.connectionId)
    logQBO("info", "payment_sync_success", { orgId, paymentId, qboId: qboPayment.Id })

    return { success: true, qbo_id: qboPayment.Id }
  } catch (error: any) {
    const message = error instanceof QBOError ? error.message : error?.message ?? String(error)
    await markSyncRecordError(orgId, "payment", paymentId, message, options?.connectionId)
    await markConnectionErrorIfConnectionLevel(orgId, error, message, options?.connectionId)
    logQBO("error", "payment_sync_failed", {
      orgId,
      paymentId,
      error: message,
      qbo_status: error instanceof QBOError ? error.status : undefined,
      qbo_fault_type: error instanceof QBOError ? error.faultType : undefined,
      qbo_fault_code: error instanceof QBOError ? error.faultCode : undefined,
      qbo_fault_detail: error instanceof QBOError ? error.faultDetail : undefined,
      intuit_tid: error instanceof QBOError ? error.intuitTid : undefined,
    })
    return { success: false, error: message, ...qboFaultFields(error) }
  }
}

export async function syncProjectExpenseToQBO(expenseId: string, orgId: string, options?: { connectionId?: string }) {
  const supabase = createServiceSupabaseClient()
  const client = options?.connectionId ? await QBOClient.forConnection(options.connectionId) : await QBOClient.forOrg(orgId)

  if (!client) {
    await supabase.from("project_expenses").update({ qbo_sync_status: "skipped" }).eq("id", expenseId).eq("org_id", orgId)
    await markConnectionError(orgId, "No active QBO connection", options?.connectionId)
    return { success: false, error: "No active QBO connection" }
  }

  const resolvedConnectionId = await resolveHealthConnectionId(orgId, options?.connectionId)
  if (!resolvedConnectionId) {
    return { success: false, error: "No active QBO connection" }
  }

  if (await isSyncPushBlocked(supabase, orgId, "project_expense", expenseId, resolvedConnectionId)) {
    await supabase.from("project_expenses").update({ qbo_sync_status: "skipped" }).eq("id", expenseId).eq("org_id", orgId)
    return { success: true, skipped: true }
  }

  const { data: expense, error } = await supabase
    .from("project_expenses")
    .select(
      `
      id, org_id, project_id, vendor_company_id, vendor_name_text, expense_date, description, amount_cents, tax_cents, payment_method, is_billable, receipt_file_id,
      accounting_coding,
      qbo_transaction_type, qbo_expense_account_id, qbo_expense_account_name, qbo_payment_account_id, qbo_payment_account_name,
      qbo_ap_account_id, qbo_ap_account_name, qbo_vendor_id, qbo_vendor_name, qbo_class_id, qbo_class_name, qbo_id, metadata,
      project:projects(name, qbo_class_id, qbo_class_name),
      vendor_company:companies(name)
    `,
    )
    .eq("id", expenseId)
    .eq("org_id", orgId)
    .maybeSingle()

  if (error || !expense) {
    return { success: false, error: error?.message ?? "Expense not found" }
  }

  const rawExpense = expense as ProjectExpenseForSync
  const expenseAccount = accountingReference(rawExpense.accounting_coding, "expense_account")
  const paymentAccount = accountingReference(rawExpense.accounting_coding, "payment_account")
  const apAccount = accountingReference(rawExpense.accounting_coding, "ap_account")
  const counterparty = accountingReference(rawExpense.accounting_coding, "counterparty")
  const classDimension = accountingDimension(rawExpense.accounting_coding, "class")
  const typedExpense: ProjectExpenseForSync = {
    ...rawExpense,
    qbo_transaction_type: (rawExpense.accounting_coding?.transaction_type as "purchase" | "bill" | null | undefined) ?? rawExpense.qbo_transaction_type,
    qbo_expense_account_id: expenseAccount?.id ?? rawExpense.qbo_expense_account_id,
    qbo_expense_account_name: expenseAccount?.name ?? rawExpense.qbo_expense_account_name,
    qbo_payment_account_id: paymentAccount?.id ?? rawExpense.qbo_payment_account_id,
    qbo_payment_account_name: paymentAccount?.name ?? rawExpense.qbo_payment_account_name,
    qbo_ap_account_id: apAccount?.id ?? rawExpense.qbo_ap_account_id,
    qbo_ap_account_name: apAccount?.name ?? rawExpense.qbo_ap_account_name,
    qbo_vendor_id: counterparty?.id ?? rawExpense.qbo_vendor_id,
    qbo_vendor_name: counterparty?.name ?? rawExpense.qbo_vendor_name,
    qbo_class_id: classDimension?.id ?? rawExpense.qbo_class_id,
    qbo_class_name: classDimension?.name ?? rawExpense.qbo_class_name,
  }
  if (!typedExpense.qbo_expense_account_id) {
    await markProjectExpenseNeedsReview(orgId, expenseId, "Choose a QuickBooks account before syncing.")
    return { success: false, error: "Missing QuickBooks expense account" }
  }

  const transactionType = resolveProjectExpenseQBOTransactionType(typedExpense)
  if (transactionType === "purchase" && !typedExpense.qbo_payment_account_id) {
    await markProjectExpenseNeedsReview(orgId, expenseId, "Choose the QuickBooks bank or credit card account used for this paid expense.")
    return { success: false, error: "Missing QuickBooks payment account" }
  }

  try {
    const vendorName = resolveExpenseVendorName(typedExpense)
    const vendor = await resolveQboVendorForConnection({ client, supabase, orgId, connectionId: resolvedConnectionId, companyId: typedExpense.vendor_company_id, displayName: vendorName, legacyId: typedExpense.qbo_vendor_id, legacyName: typedExpense.qbo_vendor_name })
    const customer = await getOrCreateProjectCustomer({ client, supabase, orgId, connectionId: resolvedConnectionId, projectId: typedExpense.project_id, projectName: typedExpense.project?.name ?? null })
    const totalAmount = centsToAmount(Number(typedExpense.amount_cents ?? 0) + Number(typedExpense.tax_cents ?? 0))
    const lineDescription = typedExpense.description?.trim() || vendorName
    const billableStatus = typedExpense.is_billable === false ? "NotBillable" : "Billable"
    const parentClassRef = resolveQBOClassRef(
      {
        ...((typedExpense.metadata as Record<string, any> | null) ?? {}),
        qbo_class_id: typedExpense.qbo_class_id,
        qbo_class_name: typedExpense.qbo_class_name,
      },
      typedExpense.project,
    )

    // When the expense is split, emit one QBO expense line per allocation, resolving
    // the customer/class per the line's project so cross-project splits land correctly.
    const { data: splitLines } = await supabase
      .from("project_expense_lines")
      .select("id, project_id, cost_code_id, description, amount_cents, qbo_expense_account_id, qbo_expense_account_name")
      .eq("org_id", orgId)
      .eq("expense_id", expenseId)
      .order("sort_order", { ascending: true })

    let qboLines: any[]
    if ((splitLines ?? []).length > 0) {
      const projectIds = Array.from(
        new Set((splitLines ?? []).map((line) => line.project_id ?? typedExpense.project_id).filter(Boolean) as string[]),
      )
      const { data: projectInfos } = await supabase
        .from("projects")
        .select("id, name, qbo_class_id, qbo_class_name")
        .eq("org_id", orgId)
        .in("id", projectIds)
      const projectInfoById = new Map((projectInfos ?? []).map((p) => [p.id, p]))
      const customerByProject = new Map<string, Awaited<ReturnType<typeof getOrCreateProjectCustomer>>>()
      // Class routing lives in the entity map now; projects.qbo_class_* is only
      // written by pre-cutover data, so it is the fallback rather than the source.
      const classByProject = new Map<string, { value: string; name?: string } | undefined>()
      for (const pid of projectIds) {
        customerByProject.set(
          pid,
          pid === typedExpense.project_id
            ? customer
            : await getOrCreateProjectCustomer({ client, supabase, orgId, connectionId: resolvedConnectionId, projectId: pid, projectName: projectInfoById.get(pid)?.name ?? null }),
        )
        const lineTarget = await resolveAccountingTarget({ orgId, projectId: pid })
        const mappedClass = lineTarget?.dimensions.class
        classByProject.set(pid, mappedClass?.id ? { value: mappedClass.id, name: mappedClass.name ?? undefined } : undefined)
      }

      qboLines = (splitLines ?? []).map((line) => {
        const lineProjectId = line.project_id ?? typedExpense.project_id
        const lineCustomer = customerByProject.get(lineProjectId) ?? customer
        const lineProject = projectInfoById.get(lineProjectId) ?? typedExpense.project
        const lineClassRef =
          classByProject.get(lineProjectId) ??
          resolveQBOClassRef(
            { qbo_class_id: lineProject?.qbo_class_id, qbo_class_name: lineProject?.qbo_class_name },
            lineProject,
          )
        return {
          DetailType: "AccountBasedExpenseLineDetail",
          Amount: centsToAmount(Number(line.amount_cents ?? 0)),
          Description: line.description?.trim() || lineDescription,
          AccountBasedExpenseLineDetail: {
            AccountRef: {
              value: line.qbo_expense_account_id || typedExpense.qbo_expense_account_id,
              name: line.qbo_expense_account_name ?? typedExpense.qbo_expense_account_name ?? undefined,
            },
            CustomerRef: lineCustomer?.Id ? { value: lineCustomer.Id, name: lineCustomer.DisplayName } : undefined,
            BillableStatus: billableStatus,
            ClassRef: lineClassRef ?? parentClassRef,
          },
        }
      })
    } else {
      qboLines = [
        {
          DetailType: "AccountBasedExpenseLineDetail",
          Amount: totalAmount,
          Description: lineDescription,
          AccountBasedExpenseLineDetail: {
            AccountRef: {
              value: typedExpense.qbo_expense_account_id,
              name: typedExpense.qbo_expense_account_name ?? undefined,
            },
            CustomerRef: customer?.Id ? { value: customer.Id, name: customer.DisplayName } : undefined,
            BillableStatus: billableStatus,
            ClassRef: parentClassRef,
          },
        },
      ]
    }

    const { data: existingSync } = await supabase
      .from("accounting_sync_records")
      .select("qbo_id:external_id, qbo_sync_token:external_version")
      .eq("org_id", orgId)
      .eq("connection_id", resolvedConnectionId)
      .eq("entity_type", "project_expense")
      .eq("entity_id", expenseId)
      .maybeSingle()

    const basePayload = {
      TxnDate: typedExpense.expense_date,
      PrivateNote: withArcTransactionMarker(typedExpense.description, "project_expense", expenseId),
      Line: qboLines,
      ...(transactionType === "bill"
        ? {
            VendorRef: { value: vendor.Id!, name: vendor.DisplayName },
            APAccountRef: typedExpense.qbo_ap_account_id
              ? { value: typedExpense.qbo_ap_account_id, name: typedExpense.qbo_ap_account_name ?? undefined }
              : undefined,
          }
        : {
            EntityRef: { type: "Vendor", value: vendor.Id!, name: vendor.DisplayName },
            AccountRef: { value: typedExpense.qbo_payment_account_id!, name: typedExpense.qbo_payment_account_name ?? undefined },
            PaymentType: resolvePurchasePaymentType(typedExpense.payment_method),
          }),
    }

    const result = await createOrUpdateQBOEntity({
      client,
      entityType: transactionType === "bill" ? "bill" : "purchase",
      qboId: existingSync?.qbo_id ?? typedExpense.qbo_id,
      cachedSyncToken: existingSync?.qbo_sync_token,
      payload: basePayload,
      create: (p) => (transactionType === "bill" ? client.createBill(p) : client.createPurchase(p)),
      update: (p) => (transactionType === "bill" ? client.updateBill(p) : client.updatePurchase(p)),
      logContext: { orgId, expenseId, transactionType },
    })

    await upsertSyncRecord({
      orgId,
      connectionId: resolvedConnectionId,
      entityId: expenseId,
      qboId: result.Id!,
      syncToken: result.SyncToken,
      entityType: "project_expense",
    })

    await supabase
      .from("project_expenses")
      .update({
        qbo_id: result.Id,
        qbo_synced_at: new Date().toISOString(),
        qbo_sync_status: "synced",
        qbo_transaction_type: transactionType,
        qbo_vendor_id: vendor.Id,
        qbo_vendor_name: vendor.DisplayName,
        qbo_sync_error: null,
      })
      .eq("org_id", orgId)
      .eq("id", expenseId)

    await syncProjectExpenseReceiptAttachmentToQBO({
      client,
      supabase,
      orgId,
      expenseId,
      qboEntityId: result.Id!,
      qboEntityType: transactionType === "bill" ? "Bill" : "Purchase",
      receiptFileId: typedExpense.receipt_file_id ?? null,
      metadata: typedExpense.metadata ?? {},
    })

    await markConnectionHealthy(orgId, options?.connectionId)
    logQBO("info", "project_expense_sync_success", { orgId, expenseId, qboId: result.Id, transactionType })
    return { success: true, qbo_id: result.Id }
  } catch (error: any) {
    const message = error instanceof QBOError ? error.message : error?.message ?? String(error)
    await supabase
      .from("project_expenses")
      .update({ qbo_sync_status: "error", qbo_sync_error: message.slice(0, 4000) })
      .eq("org_id", orgId)
      .eq("id", expenseId)
    await markSyncRecordError(orgId, "project_expense", expenseId, message, options?.connectionId)
    await markConnectionErrorIfConnectionLevel(orgId, error, message, options?.connectionId)
    logQBO("error", "project_expense_sync_failed", {
      orgId,
      expenseId,
      error: message,
      qbo_status: error instanceof QBOError ? error.status : undefined,
      qbo_fault_type: error instanceof QBOError ? error.faultType : undefined,
      qbo_fault_code: error instanceof QBOError ? error.faultCode : undefined,
      qbo_fault_detail: error instanceof QBOError ? error.faultDetail : undefined,
      intuit_tid: error instanceof QBOError ? error.intuitTid : undefined,
    })
    return { success: false, error: message, ...qboFaultFields(error) }
  }
}

export async function syncVendorBillToQBO(billId: string, orgId: string, options?: { connectionId?: string }) {
  const supabase = createServiceSupabaseClient()
  const client = options?.connectionId ? await QBOClient.forConnection(options.connectionId) : await QBOClient.forOrg(orgId)

  if (!client) {
    await supabase.from("vendor_bills").update({ qbo_sync_status: "skipped" }).eq("id", billId).eq("org_id", orgId)
    await markConnectionError(orgId, "No active QBO connection", options?.connectionId)
    return { success: false, error: "No active QBO connection" }
  }

  const resolvedConnectionId = await resolveHealthConnectionId(orgId, options?.connectionId)
  if (!resolvedConnectionId) {
    return { success: false, error: "No active QBO connection" }
  }

  const { data: bill, error } = await supabase
    .from("vendor_bills")
    .select(
      `
      id, org_id, project_id, commitment_id, company_id, bill_number, bill_date, due_date, total_cents, currency, file_id, metadata, accounting_coding,
      qbo_id, qbo_expense_account_id, qbo_expense_account_name, qbo_ap_account_id, qbo_ap_account_name, qbo_vendor_id, qbo_vendor_name, qbo_class_id, qbo_class_name,
      project:projects(name, qbo_class_id, qbo_class_name),
      company:companies!vendor_bills_company_id_fkey(id, name, qbo_vendor_id, qbo_vendor_name),
      commitment:commitments(title, company:companies(id, name, qbo_vendor_id, qbo_vendor_name)),
      bill_lines(id, project_id, description, quantity, unit_cost_cents, metadata, project:projects(id, name, qbo_class_id, qbo_class_name))
    `,
    )
    .eq("id", billId)
    .eq("org_id", orgId)
    .maybeSingle()

  if (error || !bill) {
    return { success: false, error: error?.message ?? "Vendor bill not found" }
  }

  const rawBill = bill as VendorBillForSync
  const billExpenseAccount = accountingReference(rawBill.accounting_coding, "expense_account")
  const billApAccount = accountingReference(rawBill.accounting_coding, "ap_account")
  const billCounterparty = accountingReference(rawBill.accounting_coding, "counterparty")
  const billClass = accountingDimension(rawBill.accounting_coding, "class")
  const typedBill: VendorBillForSync = {
    ...rawBill,
    qbo_expense_account_id: billExpenseAccount?.id ?? rawBill.qbo_expense_account_id,
    qbo_expense_account_name: billExpenseAccount?.name ?? rawBill.qbo_expense_account_name,
    qbo_ap_account_id: billApAccount?.id ?? rawBill.qbo_ap_account_id,
    qbo_ap_account_name: billApAccount?.name ?? rawBill.qbo_ap_account_name,
    qbo_vendor_id: billCounterparty?.id ?? rawBill.qbo_vendor_id,
    qbo_vendor_name: billCounterparty?.name ?? rawBill.qbo_vendor_name,
    qbo_class_id: billClass?.id ?? rawBill.qbo_class_id,
    qbo_class_name: billClass?.name ?? rawBill.qbo_class_name,
  }
  const isVendorCredit = (typedBill.metadata as Record<string, any> | null)?.source === "vendor_credit"
  const syncEntityType = isVendorCredit ? "vendor_credit" : "bill"
  if (await isSyncPushBlocked(supabase, orgId, syncEntityType, billId, resolvedConnectionId)) {
    await supabase.from("vendor_bills").update({ qbo_sync_status: "skipped" }).eq("id", billId).eq("org_id", orgId)
    return { success: true, skipped: true }
  }
  if (!vendorBillHasQboExpenseCoding(typedBill)) {
    await markVendorBillNeedsReview(orgId, billId, "Choose a QuickBooks expense/category account before syncing this payable.")
    return { success: false, error: "Missing QuickBooks expense account" }
  }

  try {
    const vendorName = resolveVendorBillVendorName(typedBill)
    const billCompany = typedBill.company ?? typedBill.commitment?.company ?? null
    const linkedVendorId = billCompany?.qbo_vendor_id ?? typedBill.qbo_vendor_id ?? null
    const linkedVendorName = billCompany?.qbo_vendor_name ?? typedBill.qbo_vendor_name ?? null
    const vendor = await resolveQboVendorForConnection({ client, supabase, orgId, connectionId: resolvedConnectionId, companyId: typedBill.company_id ?? typedBill.commitment?.company?.id, displayName: vendorName, legacyId: linkedVendorId, legacyName: linkedVendorName })
    const sourceLines =
      typedBill.bill_lines && typedBill.bill_lines.length > 0
        ? typedBill.bill_lines
        : [
            {
              description: typedBill.bill_number ? `Bill ${typedBill.bill_number}` : typedBill.commitment?.title ?? "Vendor bill",
              quantity: 1,
              unit_cost_cents: typedBill.total_cents ?? 0,
              metadata: {},
              project_id: typedBill.project_id,
              project: typedBill.project ?? null,
            },
          ]

    // A bill's lines may be allocated to different projects. Resolve (and persist) a QBO
    // customer per distinct project so each line is job-costed to the right customer —
    // producing one QBO bill with multiple lines and a single payment, mirroring QBO.
    const projectInfoById = new Map<string, { name?: string | null; qbo_class_id?: string | null; qbo_class_name?: string | null }>()
    projectInfoById.set(typedBill.project_id, typedBill.project ?? {})
    for (const line of sourceLines) {
      const pid = line.project_id ?? typedBill.project_id
      if (pid && line.project) projectInfoById.set(pid, line.project)
    }
    const customerByProject = new Map<string, { Id?: string; DisplayName?: string } | null>()
    const sourceProjectIds = Array.from(new Set(sourceLines.map((line) => line.project_id ?? typedBill.project_id).filter(Boolean)))
    for (const pid of sourceProjectIds) {
      if (!pid || customerByProject.has(pid)) continue
      customerByProject.set(
        pid,
        await getOrCreateProjectCustomer({
          client,
          supabase,
          orgId,
          connectionId: resolvedConnectionId,
          projectId: pid,
          projectName: projectInfoById.get(pid)?.name ?? null,
        }),
      )
    }
    const { data: projectSettings, error: projectSettingsError } = await supabase
      .from("project_financial_settings")
      .select("project_id, billing_model")
      .eq("org_id", orgId)
      .in("project_id", sourceProjectIds)
    if (projectSettingsError) {
      throw new Error(`Failed to load project billing settings: ${projectSettingsError.message}`)
    }
    const billingModelByProject = new Map(
      (projectSettings ?? []).map((settings) => [settings.project_id, settings.billing_model]),
    )

    const qboLines = sourceLines.map((line) => {
      const amount = Math.abs(centsToAmount((line.unit_cost_cents ?? 0) * (line.quantity ?? 1)))
      const metadata = (line.metadata as Record<string, any> | null) ?? {}
      const lineProjectId = line.project_id ?? typedBill.project_id
      const billableToCustomer =
        isCostDrivenBillingModel(billingModelByProject.get(lineProjectId)) &&
        metadata.billable_to_customer === true
      const lineCustomer = lineProjectId ? customerByProject.get(lineProjectId) : null
      const lineProject = (lineProjectId ? projectInfoById.get(lineProjectId) : null) ?? typedBill.project
      const lineAccountId =
        typeof metadata.qbo_expense_account_id === "string" && metadata.qbo_expense_account_id
          ? metadata.qbo_expense_account_id
          : typedBill.qbo_expense_account_id ?? ""
      const lineAccountName =
        typeof metadata.qbo_expense_account_name === "string" && metadata.qbo_expense_account_name
          ? metadata.qbo_expense_account_name
          : typedBill.qbo_expense_account_name ?? undefined
      const classRef = resolveQBOClassRef(
        {
          ...metadata,
          qbo_class_id: metadata.qbo_class_id ?? lineProject?.qbo_class_id ?? typedBill.qbo_class_id,
          qbo_class_name: metadata.qbo_class_name ?? lineProject?.qbo_class_name ?? typedBill.qbo_class_name,
        },
        lineProject,
      )

      return {
        DetailType: "AccountBasedExpenseLineDetail",
        Amount: amount,
        Description: line.description ?? typedBill.commitment?.title ?? "Vendor bill",
        AccountBasedExpenseLineDetail: {
          AccountRef: {
            value: lineAccountId,
            name: lineAccountName,
          },
          CustomerRef: lineCustomer?.Id
            ? {
                value: lineCustomer.Id,
                name: lineCustomer.DisplayName,
              }
            : undefined,
          BillableStatus: !isVendorCredit && billableToCustomer ? "Billable" : "NotBillable",
          ClassRef: classRef,
        },
      }
    })

    const { data: existingSync } = await supabase
      .from("accounting_sync_records")
      .select("qbo_id:external_id, qbo_sync_token:external_version")
      .eq("org_id", orgId)
      .eq("connection_id", resolvedConnectionId)
      .eq("entity_type", syncEntityType)
      .eq("entity_id", billId)
      .maybeSingle()
    const qboBill = {
      DocNumber: typedBill.bill_number ?? undefined,
      TxnDate: typedBill.bill_date ?? new Date().toISOString().slice(0, 10),
      ...(!isVendorCredit ? { DueDate: typedBill.due_date ?? undefined } : {}),
      VendorRef: { value: vendor.Id!, name: vendor.DisplayName },
      APAccountRef: typedBill.qbo_ap_account_id
        ? { value: typedBill.qbo_ap_account_id, name: typedBill.qbo_ap_account_name ?? undefined }
        : undefined,
      PrivateNote: withArcTransactionMarker(typedBill.commitment?.title, "vendor_bill", billId),
      Line: qboLines,
    }

    const result = await createOrUpdateQBOEntity({
      client,
      entityType: isVendorCredit ? "vendor_credit" : "bill",
      qboId: existingSync?.qbo_id ?? typedBill.qbo_id,
      cachedSyncToken: existingSync?.qbo_sync_token,
      payload: qboBill,
      create: (p) => isVendorCredit ? client.createVendorCredit(p as any) : client.createBill(p as any),
      update: (p) => isVendorCredit ? client.updateVendorCredit(p as any) : client.updateBill(p as any),
      logContext: { orgId, billId },
    })

    await upsertSyncRecord({
      orgId,
      connectionId: resolvedConnectionId,
      entityId: billId,
      qboId: result.Id!,
      syncToken: result.SyncToken,
      entityType: syncEntityType,
    })

    await supabase
      .from("vendor_bills")
      .update({
        qbo_id: result.Id,
        qbo_synced_at: new Date().toISOString(),
        qbo_sync_status: "synced",
        qbo_vendor_id: vendor.Id,
        qbo_vendor_name: vendor.DisplayName,
        qbo_sync_error: null,
      })
      .eq("org_id", orgId)
      .eq("id", billId)

    if (billCompany?.id && vendor.Id) {
      await supabase
        .from("companies")
        .update({
          qbo_vendor_id: vendor.Id,
          qbo_vendor_name: vendor.DisplayName,
          qbo_vendor_synced_at: new Date().toISOString(),
          qbo_vendor_sync_status: billCompany.qbo_vendor_id ? "linked" : "created",
        })
        .eq("org_id", orgId)
        .eq("id", billCompany.id)
    }

    if (!isVendorCredit) {
      await syncVendorBillAttachmentToQBO({
        client,
        supabase,
        orgId,
        billId,
        qboBillId: result.Id!,
        fileId: typedBill.file_id ?? null,
        metadata: typedBill.metadata ?? {},
      })
    }

    await markConnectionHealthy(orgId, options?.connectionId)
    logQBO("info", "vendor_bill_sync_success", { orgId, billId, qboId: result.Id })
    return { success: true, qbo_id: result.Id }
  } catch (error: any) {
    const message = error instanceof QBOError ? error.message : error?.message ?? String(error)
    await supabase
      .from("vendor_bills")
      .update({ qbo_sync_status: "error", qbo_sync_error: message.slice(0, 4000) })
      .eq("org_id", orgId)
      .eq("id", billId)
    const entityType = (typedBill.metadata as Record<string, any> | null)?.source === "vendor_credit" ? "vendor_credit" : "bill"
    await markSyncRecordError(orgId, entityType, billId, message, options?.connectionId)
    await markConnectionErrorIfConnectionLevel(orgId, error, message, options?.connectionId)
    logQBO("error", "vendor_bill_sync_failed", {
      orgId,
      billId,
      error: message,
      qbo_status: error instanceof QBOError ? error.status : undefined,
      qbo_fault_type: error instanceof QBOError ? error.faultType : undefined,
      qbo_fault_code: error instanceof QBOError ? error.faultCode : undefined,
      qbo_fault_detail: error instanceof QBOError ? error.faultDetail : undefined,
      intuit_tid: error instanceof QBOError ? error.intuitTid : undefined,
    })
    return { success: false, error: message, ...qboFaultFields(error) }
  }
}

export async function syncBillPaymentToQBO(paymentId: string, orgId: string, options?: { connectionId?: string }) {
  const supabase = createServiceSupabaseClient()
  const client = options?.connectionId ? await QBOClient.forConnection(options.connectionId) : await QBOClient.forOrg(orgId)
  if (!client) {
    await markConnectionError(orgId, "No active QBO connection", options?.connectionId)
    return { success: false, error: "No active QBO connection" }
  }

  const resolvedConnectionId = await resolveHealthConnectionId(orgId, options?.connectionId)
  if (!resolvedConnectionId) {
    return { success: false, error: "No active QBO connection" }
  }

  if (await isSyncPushBlocked(supabase, orgId, "bill_payment", paymentId, resolvedConnectionId)) {
    return { success: true, skipped: true }
  }

  const { data: existingSync } = await supabase
    .from("accounting_sync_records")
    .select("qbo_id:external_id")
    .eq("org_id", orgId)
    .eq("connection_id", resolvedConnectionId)
    .eq("entity_type", "bill_payment")
    .eq("entity_id", paymentId)
    .maybeSingle()

  if (existingSync?.qbo_id) {
    return { success: true, qbo_id: existingSync.qbo_id }
  }
  // See the same guard in syncPaymentToQBO: a record with no external id means a
  // prior attempt's outcome is unknown, and QuickBooks may already hold this.
  const billPaymentRetryAfterUnknownOutcome = existingSync != null

  const { data: payment, error } = await supabase
    .from("payments")
    .select("id, org_id, bill_id, amount_cents, method, reference, received_at, metadata, bill:vendor_bills(id, qbo_id, qbo_sync_status, metadata)")
    .eq("id", paymentId)
    .eq("org_id", orgId)
    .maybeSingle()

  if (error || !payment) return { success: false, error: error?.message ?? "Payment not found" }
  let bill = Array.isArray((payment as any).bill) ? (payment as any).bill[0] : (payment as any).bill
  const billId = (payment as any).bill_id as string | undefined
  if (!billId) return { success: false, error: "Payment is not linked to a vendor bill" }
  // C3.4 dual-read: the sync ledger owns this link, the column is the fallback.
  let billExternalId = await resolveAccountingExternalId(supabase, {
    orgId,
    connectionId: resolvedConnectionId,
    entityType: "bill",
    entityId: billId,
    legacyExternalId: bill?.qbo_id ?? null,
  })
  if (!billExternalId) {
    const billSync = await syncVendorBillToQBO(billId, orgId, { connectionId: resolvedConnectionId })
    if (!billSync.success) {
      const syncError = "error" in billSync ? billSync.error : null
      return { success: false, error: syncError ?? "Bill is not linked to QuickBooks yet" }
    }
    const { data: refreshedBill } = await supabase
      .from("vendor_bills")
      .select("id, qbo_id, qbo_sync_status, metadata")
      .eq("org_id", orgId)
      .eq("id", billId)
      .maybeSingle()
    bill = refreshedBill
    billExternalId = await resolveAccountingExternalId(supabase, {
      orgId,
      connectionId: resolvedConnectionId,
      entityType: "bill",
      entityId: billId,
      legacyExternalId: bill?.qbo_id ?? null,
    })
    if (!billExternalId) return { success: false, error: "Bill is not linked to QuickBooks yet" }
  }

  try {
    const qboBill = await client.getBillById(billExternalId)
    const vendorRef = qboBill?.VendorRef
    if (!vendorRef?.value) {
      return { success: false, error: "QuickBooks bill is missing a vendor reference" }
    }

    const connection = await getQBOConnectionSettings(orgId, resolvedConnectionId)
    const paymentAccountId = (payment.metadata as any)?.qbo_payment_account_id ?? (connection?.settings as any)?.default_payment_account_id
    if (!paymentAccountId) {
      return { success: false, error: "Choose a default QuickBooks payment account before syncing bill payments" }
    }

    // Record the rail the money actually moved on. Everything used to post as a
    // check, so an auditor reviewing a year of electronic vendor payments saw a
    // year of checks. QuickBooks has no ACH PayType — the electronic equivalent
    // is CreditCard against the funding account — so anything not a literal
    // check maps there rather than misreporting the instrument.
    const isCheck = String(payment.method ?? "check") === "check"
    const payType = isCheck ? "Check" : "CreditCard"
    const adoptedBillPaymentId = billPaymentRetryAfterUnknownOutcome
      ? await findAlreadyCreatedQBOTransaction({
          client,
          entity: "BillPayment",
          entityType: "bill_payment",
          entityId: paymentId,
          logContext: { orgId },
        })
      : null

    const qboPayment = adoptedBillPaymentId
      ? { Id: adoptedBillPaymentId, SyncToken: undefined }
      : await client.createBillPayment({
          VendorRef: vendorRef,
          PayType: payType,
          TxnDate: payment.received_at ? new Date(payment.received_at).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10),
          TotalAmt: centsToAmount(payment.amount_cents),
          PrivateNote: withArcTransactionMarker(payment.reference, "bill_payment", paymentId),
          ...(isCheck
            ? { CheckPayment: { BankAccountRef: { value: paymentAccountId } } }
            : { CreditCardPayment: { CCAccountRef: { value: paymentAccountId } } }),
          Line: [
            {
              Amount: centsToAmount(payment.amount_cents),
              LinkedTxn: [{ TxnId: billExternalId, TxnType: "Bill" }],
            },
          ],
        })

    await upsertSyncRecord({
      orgId,
      connectionId: resolvedConnectionId,
      entityId: paymentId,
      qboId: qboPayment.Id,
      syncToken: qboPayment.SyncToken,
      entityType: "bill_payment",
    })
    await markConnectionHealthy(orgId, options?.connectionId)
    logQBO("info", "bill_payment_sync_success", { orgId, paymentId, qboId: qboPayment.Id })
    return { success: true, qbo_id: qboPayment.Id }
  } catch (error: any) {
    const message = error instanceof QBOError ? error.message : error?.message ?? String(error)
    await markSyncRecordError(orgId, "bill_payment", paymentId, message, options?.connectionId)
    await markConnectionErrorIfConnectionLevel(orgId, error, message, options?.connectionId)
    logQBO("error", "bill_payment_sync_failed", {
      orgId,
      paymentId,
      error: message,
      qbo_status: error instanceof QBOError ? error.status : undefined,
      qbo_fault_type: error instanceof QBOError ? error.faultType : undefined,
      qbo_fault_code: error instanceof QBOError ? error.faultCode : undefined,
      qbo_fault_detail: error instanceof QBOError ? error.faultDetail : undefined,
      intuit_tid: error instanceof QBOError ? error.intuitTid : undefined,
    })
    return { success: false, error: message, ...qboFaultFields(error) }
  }
}

/**
 * Reverse a bill payment in QuickBooks after an ACH return.
 *
 * Arc reopens the vendor bill when money comes back; without this the books
 * diverge permanently — QuickBooks keeps a payment for funds the bank pulled
 * back, and the bill shows paid there and open here forever.
 *
 * Deleting is how QuickBooks reverses a BillPayment (there is no void for this
 * entity), and it restores the linked bill's open balance, which is exactly the
 * state a return leaves Arc in.
 */
export async function voidBillPaymentInQBO(
  paymentId: string,
  orgId: string,
  reason: string,
  options?: { connectionId?: string },
) {
  const supabase = createServiceSupabaseClient()
  const resolvedConnectionId = await resolveHealthConnectionId(orgId, options?.connectionId)
  if (!resolvedConnectionId) return { success: false, error: "No active QBO connection" }
  const client = await QBOClient.forConnection(resolvedConnectionId)
  if (!client) return { success: false, error: "No active QBO connection" }

  const { data: record } = await supabase
    .from("accounting_sync_records")
    .select("external_id")
    .eq("org_id", orgId)
    .eq("connection_id", resolvedConnectionId)
    .eq("entity_type", "bill_payment")
    .eq("entity_id", paymentId)
    .maybeSingle()
  // Nothing was ever pushed, so there is nothing to reverse. Not an error — a
  // return can land on a payment whose sync never succeeded.
  if (!record?.external_id) return { success: true, skipped: true }

  try {
    // SyncToken has to come from QuickBooks, never from a cached copy: an edit
    // made in QuickBooks since the push would make a stale token fail.
    const existing = await client.getBillPaymentById(record.external_id)
    if (!existing) {
      await supabase.from("accounting_sync_records").delete().eq("org_id", orgId).eq("connection_id", resolvedConnectionId).eq("entity_type", "bill_payment").eq("entity_id", paymentId)
      return { success: true, skipped: true }
    }
    await client.deleteBillPayment({ Id: existing.Id, SyncToken: existing.SyncToken })
    await supabase
      .from("accounting_sync_records")
      .delete()
      .eq("org_id", orgId)
      .eq("connection_id", resolvedConnectionId)
      .eq("entity_type", "bill_payment")
      .eq("entity_id", paymentId)
    await markConnectionHealthy(orgId, options?.connectionId)
    logQBO("info", "bill_payment_void_success", { orgId, paymentId, qboId: record.external_id, reason })
    return { success: true, qbo_id: record.external_id }
  } catch (error: any) {
    const message = error instanceof QBOError ? error.message : error?.message ?? String(error)
    await markSyncRecordError(orgId, "bill_payment", paymentId, message, options?.connectionId)
    await markConnectionErrorIfConnectionLevel(orgId, error, message, options?.connectionId)
    logQBO("error", "bill_payment_void_failed", { orgId, paymentId, error: message })
    return { success: false, error: message, ...qboFaultFields(error) }
  }
}

async function upsertSyncRecord(input: {
  orgId: string
  connectionId?: string | null
  entityId: string
  qboId: string
  syncToken?: string
  entityType?: string
}) {
  const supabase = createServiceSupabaseClient()

  let connectionId = input.connectionId ?? null
  if (!connectionId) {
    const { data: connection } = await supabase.from("accounting_connections").select("id").eq("org_id", input.orgId).eq("provider", "qbo").eq("status", "active").order("connected_at", { ascending: true }).limit(1).maybeSingle()
    connectionId = connection?.id ?? null
  }
  if (!connectionId) return

  const entityType = input.entityType ?? "invoice"
  await supabase
    .from("accounting_sync_records")
    .upsert(
      {
        org_id: input.orgId,
        connection_id: connectionId,
        provider: "qbo",
        entity_type: entityType,
        entity_id: input.entityId,
        external_id: input.qboId,
        external_version: input.syncToken,
        last_synced_at: new Date().toISOString(),
        status: "synced",
        error_message: null,
      },
      { onConflict: "org_id,connection_id,entity_type,entity_id" },
    )

  // What we just sent is now what QuickBooks holds, so this is the baseline a
  // later inbound reconcile measures "did a person change Arc since?" against.
  // Safe to run before the entity's own `qbo_*` bookkeeping update: the sync
  // write never touches a fingerprinted field.
  await stampLocalFingerprint({
    supabase,
    orgId: input.orgId,
    connectionId,
    entityType,
    entityId: input.entityId,
  })
}

async function claimSyncCreate(input: {
  orgId: string
  connectionId: string | null
  entityType: string
  entityId: string
}) {
  const supabase = createServiceSupabaseClient()
  let connectionId = input.connectionId
  if (!connectionId) {
    // Provider-filtered like every other resolver in this file: an org can hold
    // an active file connection alongside QBO, and an unfiltered maybeSingle()
    // errors on two rows — which skipped every create for that org.
    const { data: connection } = await supabase
      .from("accounting_connections")
      .select("id")
      .eq("org_id", input.orgId)
      .eq("provider", "qbo")
      .eq("status", "active")
      .order("connected_at", { ascending: true })
      .limit(1)
      .maybeSingle()
    connectionId = connection?.id ?? null
  }
  if (!connectionId) return false

  const { data, error } = await supabase.rpc("accounting_claim_sync_create", {
    p_org_id: input.orgId,
    p_connection_id: connectionId,
    p_entity_type: input.entityType,
    p_entity_id: input.entityId,
  })
  if (error) {
    logQBO("warn", "qbo_sync_claim_failed", {
      orgId: input.orgId,
      entityType: input.entityType,
      entityId: input.entityId,
      error: error.message,
    })
    return false
  }
  return data === true
}

async function markSyncRecordError(orgId: string, entityType: string, entityId: string, message: string, connectionId?: string | null) {
  const supabase = createServiceSupabaseClient()
  const resolvedConnectionId = await resolveHealthConnectionId(orgId, connectionId)
  if (!resolvedConnectionId) return

  const { data: existing } = await supabase
    .from("accounting_sync_records")
    .select("id, qbo_id:external_id")
    .eq("org_id", orgId)
    .eq("connection_id", resolvedConnectionId)
    .eq("entity_type", entityType)
    .eq("entity_id", entityId)
    .maybeSingle()

  if (existing?.id) {
    await supabase
      .from("accounting_sync_records")
      .update({
        status: "error",
        error_message: message.slice(0, 4000),
        last_synced_at: new Date().toISOString(),
      })
      .eq("id", existing.id)
    return
  }

  await supabase.from("accounting_sync_records").insert({
    org_id: orgId,
    connection_id: resolvedConnectionId,
    entity_type: entityType,
    entity_id: entityId,
    provider: "qbo",
    external_id: "",
    status: "error",
    error_message: message.slice(0, 4000),
    last_synced_at: new Date().toISOString(),
  })
}

async function markSyncRecordNeedsReview(orgId: string, entityType: string, entityId: string, message: string, connectionId?: string | null) {
  await markSyncRecordError(orgId, entityType, entityId, message, connectionId)
  const resolvedConnectionId = await resolveHealthConnectionId(orgId, connectionId)
  if (!resolvedConnectionId) return
  const supabase = createServiceSupabaseClient()
  await supabase
    .from("accounting_sync_records")
    .update({ status: "needs_review", error_message: message.slice(0, 4000) })
    .eq("org_id", orgId)
    .eq("connection_id", resolvedConnectionId)
    .eq("entity_type", entityType)
    .eq("entity_id", entityId)
}

async function syncInvoicePdfAttachmentToQBO(params: {
  client: QBOClient
  supabase: ReturnType<typeof createServiceSupabaseClient>
  orgId: string
  invoiceId: string
  qboInvoiceId: string
}) {
  const { data: invoice } = await params.supabase
    .from("invoices")
    .select("project_id, invoice_number, metadata")
    .eq("org_id", params.orgId)
    .eq("id", params.invoiceId)
    .maybeSingle()

  const metadata = (invoice?.metadata as Record<string, any> | null) ?? {}
  const latestPdfFileId = typeof metadata.latest_pdf_file_id === "string" ? metadata.latest_pdf_file_id : null
  const syncedPdfFileId = typeof metadata.qbo_pdf_synced_file_id === "string" ? metadata.qbo_pdf_synced_file_id : null
  const syncedQboInvoiceId = typeof metadata.qbo_pdf_synced_invoice_id === "string" ? metadata.qbo_pdf_synced_invoice_id : null

  if (!latestPdfFileId) return
  if (syncedPdfFileId === latestPdfFileId && syncedQboInvoiceId === params.qboInvoiceId) return

  const { data: file } = await params.supabase
    .from("files")
    .select("id, storage_path, file_name, mime_type")
    .eq("org_id", params.orgId)
    .eq("id", latestPdfFileId)
    .maybeSingle()

  if (!file?.storage_path || !file?.file_name) return

  try {
    const bytes = await downloadFilesObject({
      supabase: params.supabase,
      orgId: params.orgId,
      path: file.storage_path,
    })

    const attachment = await params.client.uploadAttachmentForInvoice({
      invoiceId: params.qboInvoiceId,
      fileName: file.file_name,
      contentType: file.mime_type ?? "application/pdf",
      content: bytes,
      note: `Arc invoice PDF ${invoice?.invoice_number ?? params.invoiceId}`,
    })

    await params.supabase
      .from("invoices")
      .update({
        metadata: {
          ...metadata,
          qbo_pdf_attachment_id: attachment.id,
          qbo_pdf_attached_at: new Date().toISOString(),
          qbo_pdf_synced_file_id: latestPdfFileId,
          qbo_pdf_synced_invoice_id: params.qboInvoiceId,
        },
      })
      .eq("org_id", params.orgId)
      .eq("id", params.invoiceId)
  } catch (error: any) {
    logQBO("warn", "invoice_pdf_attachment_sync_failed", {
      orgId: params.orgId,
      invoiceId: params.invoiceId,
      qboInvoiceId: params.qboInvoiceId,
      fileId: latestPdfFileId,
      error: error?.message ?? String(error),
    })
  }
}

async function syncProjectExpenseReceiptAttachmentToQBO(params: {
  client: QBOClient
  supabase: ReturnType<typeof createServiceSupabaseClient>
  orgId: string
  expenseId: string
  qboEntityId: string
  qboEntityType: "Purchase" | "Bill"
  receiptFileId?: string | null
  metadata: Record<string, any>
}) {
  if (!params.receiptFileId) return

  const syncedFileId = typeof params.metadata.qbo_receipt_synced_file_id === "string" ? params.metadata.qbo_receipt_synced_file_id : null
  const syncedQboId = typeof params.metadata.qbo_receipt_synced_entity_id === "string" ? params.metadata.qbo_receipt_synced_entity_id : null
  if (syncedFileId === params.receiptFileId && syncedQboId === params.qboEntityId) return

  const { data: file } = await params.supabase
    .from("files")
    .select("id, storage_path, file_name, mime_type")
    .eq("org_id", params.orgId)
    .eq("id", params.receiptFileId)
    .maybeSingle()

  if (!file?.storage_path || !file?.file_name) {
    throw new Error("Receipt file was not found for QBO attachment upload")
  }

  try {
    const bytes = await downloadFilesObject({
      supabase: params.supabase,
      orgId: params.orgId,
      path: file.storage_path,
    })

    const attachment = await params.client.uploadAttachmentForEntity({
      entityType: params.qboEntityType,
      entityId: params.qboEntityId,
      fileName: file.file_name,
      contentType: file.mime_type ?? "application/octet-stream",
      content: bytes,
      note: `Arc expense receipt ${params.expenseId}`,
    })

    await params.supabase
      .from("project_expenses")
      .update({
        metadata: {
          ...params.metadata,
          qbo_receipt_attachment_id: attachment.id,
          qbo_receipt_attached_at: new Date().toISOString(),
          qbo_receipt_synced_file_id: params.receiptFileId,
          qbo_receipt_synced_entity_id: params.qboEntityId,
          qbo_receipt_synced_entity_type: params.qboEntityType,
        },
      })
      .eq("org_id", params.orgId)
      .eq("id", params.expenseId)
  } catch (error: any) {
    logQBO("warn", "project_expense_receipt_attachment_sync_failed", {
      orgId: params.orgId,
      expenseId: params.expenseId,
      qboEntityId: params.qboEntityId,
      qboEntityType: params.qboEntityType,
      fileId: params.receiptFileId,
      error: error?.message ?? String(error),
    })
    throw error
  }
}

async function syncVendorBillAttachmentToQBO(params: {
  client: QBOClient
  supabase: ReturnType<typeof createServiceSupabaseClient>
  orgId: string
  billId: string
  qboBillId: string
  fileId?: string | null
  metadata: Record<string, any>
}) {
  if (!params.fileId) return

  const syncedFileId = typeof params.metadata.qbo_bill_synced_file_id === "string" ? params.metadata.qbo_bill_synced_file_id : null
  const syncedQboId = typeof params.metadata.qbo_bill_synced_entity_id === "string" ? params.metadata.qbo_bill_synced_entity_id : null
  if (syncedFileId === params.fileId && syncedQboId === params.qboBillId) return

  const { data: file } = await params.supabase
    .from("files")
    .select("id, storage_path, file_name, mime_type")
    .eq("org_id", params.orgId)
    .eq("id", params.fileId)
    .maybeSingle()

  if (!file?.storage_path || !file?.file_name) {
    throw new Error("Bill file was not found for QBO attachment upload")
  }

  try {
    const bytes = await downloadFilesObject({
      supabase: params.supabase,
      orgId: params.orgId,
      path: file.storage_path,
    })

    const attachment = await params.client.uploadAttachmentForEntity({
      entityType: "Bill",
      entityId: params.qboBillId,
      fileName: file.file_name,
      contentType: file.mime_type ?? "application/octet-stream",
      content: bytes,
      note: `Arc vendor bill ${params.billId}`,
    })

    await params.supabase
      .from("vendor_bills")
      .update({
        metadata: {
          ...params.metadata,
          qbo_bill_attachment_id: attachment.id,
          qbo_bill_attached_at: new Date().toISOString(),
          qbo_bill_synced_file_id: params.fileId,
          qbo_bill_synced_entity_id: params.qboBillId,
        },
      })
      .eq("org_id", params.orgId)
      .eq("id", params.billId)
  } catch (error: any) {
    logQBO("warn", "vendor_bill_attachment_sync_failed", {
      orgId: params.orgId,
      billId: params.billId,
      qboBillId: params.qboBillId,
      fileId: params.fileId,
      error: error?.message ?? String(error),
    })
    throw error
  }
}

async function resolveHealthConnectionId(orgId: string, connectionId?: string | null) {
  if (connectionId) return connectionId
  const supabase = createServiceSupabaseClient()
  const { data } = await supabase.from("accounting_connections").select("id").eq("org_id", orgId).eq("provider", "qbo").eq("status", "active").order("connected_at", { ascending: true }).limit(1).maybeSingle()
  return data?.id ?? null
}

async function markConnectionHealthy(orgId: string, connectionId?: string | null) {
  const supabase = createServiceSupabaseClient()
  const resolvedConnectionId = await resolveHealthConnectionId(orgId, connectionId)
  if (!resolvedConnectionId) return
  await supabase
    .from("accounting_connections")
    .update({
      last_sync_at: new Date().toISOString(),
      last_error: null,
    })
    .eq("org_id", orgId)
    .eq("id", resolvedConnectionId)
    .eq("status", "active")
}

/**
 * Connection health must only react to failures of the connection itself (auth,
 * permissions, rate limits, Intuit outages, network). A validation fault on one
 * entity — a deleted account ref, a bad amount — is that entity's problem and is
 * already surfaced on its own qbo_sync_status; it must not flip the whole org's
 * QBO connection into an error state.
 */
async function markConnectionErrorIfConnectionLevel(orgId: string, error: unknown, message: string, connectionId?: string | null) {
  // Only QBOErrors can indict the connection. A Supabase or application error
  // says nothing about QuickBooks, and writing it onto the connection row is
  // exactly the misattribution this function exists to prevent.
  if (!(error instanceof QBOError)) return
  const connectionLevel = error.isAuthError || error.isPermissionError || error.isRateLimit || error.status >= 500
  if (!connectionLevel) return
  await markConnectionError(orgId, message, connectionId)
}

async function markConnectionError(orgId: string, error: string, connectionId?: string | null) {
  const supabase = createServiceSupabaseClient()
  const resolvedConnectionId = await resolveHealthConnectionId(orgId, connectionId)
  if (!resolvedConnectionId) return
  await supabase
    .from("accounting_connections")
    .update({
      last_error: error.slice(0, 4000),
    })
    .eq("org_id", orgId)
    .eq("id", resolvedConnectionId)
    .eq("status", "active")
}

async function markProjectExpenseNeedsReview(orgId: string, expenseId: string, message: string) {
  const supabase = createServiceSupabaseClient()
  await supabase
    .from("project_expenses")
    .update({
      qbo_sync_status: "needs_review",
      qbo_sync_error: message.slice(0, 4000),
    })
    .eq("org_id", orgId)
    .eq("id", expenseId)
}

async function markVendorBillNeedsReview(orgId: string, billId: string, message: string) {
  const supabase = createServiceSupabaseClient()
  await supabase
    .from("vendor_bills")
    .update({
      qbo_sync_status: "needs_review",
      qbo_sync_error: message.slice(0, 4000),
    })
    .eq("org_id", orgId)
    .eq("id", billId)
}

function resolveCustomerName(invoice: InvoiceForSync) {
  const metadataName = (invoice.metadata as any)?.customer_name
  if (metadataName && String(metadataName).trim()) {
    return String(metadataName).trim()
  }
  const customerEmail = (invoice.metadata as any)?.customer_email
  if (customerEmail && String(customerEmail).trim()) {
    return String(customerEmail).trim()
  }
  const projectName = (invoice.metadata as any)?.project_name
  if (projectName && String(projectName).trim()) {
    return String(projectName).trim()
  }
  const title = invoice.title?.trim()
  if (title) return title
  return `Customer ${invoice.invoice_number}`
}

function resolveQBOClassRef(
  metadata?: Record<string, any> | null,
  project?: { qbo_class_id?: string | null; qbo_class_name?: string | null } | null,
): { value: string; name?: string } | undefined {
  const metadataClassId =
    typeof metadata?.qbo_class_id === "string" && metadata.qbo_class_id.trim().length > 0
      ? metadata.qbo_class_id.trim()
      : null
  const metadataClassName =
    typeof metadata?.qbo_class_name === "string" && metadata.qbo_class_name.trim().length > 0
      ? metadata.qbo_class_name.trim()
      : undefined
  if (metadataClassId) return { value: metadataClassId, name: metadataClassName }

  const projectClassId =
    typeof project?.qbo_class_id === "string" && project.qbo_class_id.trim().length > 0
      ? project.qbo_class_id.trim()
      : null
  if (!projectClassId) return undefined

  const projectClassName =
    typeof project?.qbo_class_name === "string" && project.qbo_class_name.trim().length > 0
      ? project.qbo_class_name.trim()
      : undefined
  return { value: projectClassId, name: projectClassName }
}

function resolveExpenseVendorName(expense: ProjectExpenseForSync) {
  const companyName = expense.vendor_company?.name
  if (companyName && companyName.trim()) return companyName.trim()
  if (expense.vendor_name_text && expense.vendor_name_text.trim()) return expense.vendor_name_text.trim()
  if (expense.description && expense.description.trim()) return expense.description.trim()
  return "Unknown Vendor"
}

function resolveVendorBillVendorName(bill: VendorBillForSync) {
  const directCompanyName = bill.company?.name
  if (directCompanyName && directCompanyName.trim()) return directCompanyName.trim()
  const companyName = bill.commitment?.company?.name
  if (companyName && companyName.trim()) return companyName.trim()
  const metadataVendor = (bill.metadata as any)?.vendor_name
  if (metadataVendor && String(metadataVendor).trim()) return String(metadataVendor).trim()
  const title = bill.commitment?.title
  if (title && title.trim()) return title.trim()
  return "Unknown Vendor"
}

function resolveProjectExpenseQBOTransactionType(expense: ProjectExpenseForSync): "purchase" | "bill" {
  if (expense.qbo_transaction_type === "purchase" || expense.qbo_transaction_type === "bill") {
    return expense.qbo_transaction_type
  }

  const method = String(expense.payment_method ?? "").toLowerCase()
  if (method === "reimbursable_personal") return "bill"
  return "purchase"
}

function resolvePurchasePaymentType(paymentMethod?: string | null) {
  const method = String(paymentMethod ?? "").toLowerCase()
  if (method === "credit_card" || method === "company_card") return "CreditCard"
  if (method === "check") return "Check"
  return "Cash"
}

// Resolves the QBO customer that project costs (payables/expenses) are attributed to, in priority order:
//   1. the project's explicit default (set in project settings) — the source of truth;
//   2. the project's current client contact — find/create the matching QBO customer and lock it in
//      (this self-corrects stale "first sync wins" maps);
//   3. a legacy qbo_sync_records map from before the explicit field existed;
//   4. the project name as a last resort.
// Whatever is resolved in 2–4 is persisted back onto the project so it becomes sticky and visible.
async function getOrCreateProjectCustomer(params: {
  client: QBOClient
  supabase: ReturnType<typeof createServiceSupabaseClient>
  orgId: string
  connectionId?: string | null
  projectId?: string | null
  projectName?: string | null
}) {
  if (!params.projectId) return null
  const { client, supabase, orgId, projectId } = params

  const target = await resolveAccountingTarget({ orgId, projectId })
  const mappedCustomer = target?.dimensions.customer
  if (mappedCustomer?.id) {
    return { Id: mappedCustomer.id, DisplayName: mappedCustomer.name ?? params.projectName ?? "Customer" }
  }

  const { data: project } = await supabase
    .from("projects")
    .select("client_id")
    .eq("org_id", orgId)
    .eq("id", projectId)
    .maybeSingle()

  const persist = async (customer: { Id?: string; DisplayName?: string }) => {
    if (!customer?.Id) return
    const connectionId = params.connectionId ?? target?.connection.id
    if (!connectionId) throw new Error("No accounting connection is mapped to this project")
    const { data: existingMap } = await supabase.from("accounting_entity_map").select("id,dimensions").eq("org_id", orgId).eq("project_id", projectId).maybeSingle()
    const dimensions = { ...((existingMap?.dimensions as Record<string, unknown> | null) ?? {}), customer: { id: customer.Id, name: customer.DisplayName ?? null } }
    const mapQuery = existingMap?.id
      ? supabase.from("accounting_entity_map").update({ connection_id: connectionId, dimensions }).eq("id", existingMap.id)
      : supabase.from("accounting_entity_map").insert({ org_id: orgId, project_id: projectId, connection_id: connectionId, dimensions })
    const { error } = await mapQuery
    if (error) throw new Error(`Unable to persist project accounting customer: ${error.message}`)
    const now = new Date().toISOString()
    const { error: linkError } = await supabase.from("accounting_counterparty_links").upsert({
      org_id: orgId,
      connection_id: connectionId,
      provider: "qbo",
      role: "customer",
      entity_type: "project",
      entity_id: projectId,
      external_id: customer.Id,
      external_name: customer.DisplayName ?? null,
      status: "synced",
      error_message: null,
      last_synced_at: now,
      metadata: { display_name: customer.DisplayName ?? null },
    }, { onConflict: "org_id,connection_id,role,entity_type,entity_id" })
    if (linkError) throw new Error(`Unable to persist project accounting customer link: ${linkError.message}`)
    await upsertSyncRecord({ orgId, connectionId, entityId: projectId, qboId: customer.Id, entityType: "customer" })
  }

  // 2. Current client contact.
  if (project?.client_id) {
    const { data: contact } = await supabase
      .from("contacts")
      .select("full_name")
      .eq("org_id", orgId)
      .eq("id", project.client_id)
      .maybeSingle()
    const contactName = contact?.full_name?.trim()
    if (contactName) {
      const customer = await client.getOrCreateCustomer(contactName)
      await persist(customer)
      return customer
    }
  }

  // 3. Existing provider-scoped counterparty mapping.
  const { data: existing } = await supabase
    .from("accounting_counterparty_links")
    .select("qbo_id:external_id,external_name")
    .eq("org_id", orgId)
    .eq("connection_id", params.connectionId ?? target?.connection.id ?? "")
    .eq("role", "customer")
    .eq("entity_type", "project")
    .eq("entity_id", projectId)
    .maybeSingle()
  if (existing?.qbo_id) {
    return { Id: existing.qbo_id, DisplayName: existing.external_name ?? params.projectName ?? "Project" }
  }

  // 4. Project name fallback.
  const displayName = params.projectName?.trim() || `Project ${projectId}`
  const customer = await client.getOrCreateCustomer(displayName)
  await persist(customer)
  return customer
}

/**
 * Integer cents → QBO decimal dollars. Rounded first so float arithmetic can
 * never emit 100.00000000000001 — QBO rounds on its side, which is how Arc and
 * QuickBooks used to disagree by a cent with nothing checking.
 */
function centsToAmount(cents: number) {
  return Math.round(cents) / 100
}

/**
 * Compare what QuickBooks computed against what Arc believes after a push.
 * QBO recomputes tax and rounding on its side, so the two CAN drift by cents —
 * and nothing used to look. A warn (not a failure) because the push itself
 * succeeded; the reconciliation digest is where a persistent gap gets escalated.
 */
function warnOnInvoiceTotalDivergence(orgId: string, invoiceId: string, arcTotalCents: number | null | undefined, remoteInvoice: unknown) {
  const remoteTotal = (remoteInvoice as { TotalAmt?: number | string | null } | null)?.TotalAmt
  if (arcTotalCents == null || remoteTotal == null) return
  const remoteCents = Math.round(Number(remoteTotal) * 100)
  if (!Number.isFinite(remoteCents) || remoteCents === Number(arcTotalCents)) return
  logQBO("warn", "invoice_total_divergence", {
    orgId,
    invoiceId,
    arc_total_cents: Number(arcTotalCents),
    qbo_total_cents: remoteCents,
  })
}

/**
 * Fault metadata for a failed sync result, so the outbox's permanent-failure
 * classifier receives real codes instead of matching on message substrings.
 */
function qboFaultFields(error: unknown) {
  return error instanceof QBOError
    ? { errorStatus: error.status ?? null, errorFaultCode: error.faultCode ?? null, errorFaultDetail: error.faultDetail ?? null }
    : {}
}

function isDuplicateDocNumber(error: QBOError) {
  // Fault 6140 is QBO's duplicate-DocNumber validation error. Matching on it
  // exactly matters: this predicate gates a path that RENUMBERS the customer's
  // invoice, and the old substring match ("docnumber"/"duplicate") also fired
  // on unrelated faults that merely named the field.
  if (error.faultCode === "6140") return true
  const detail = `${error.faultDetail ?? ""} ${error.message ?? ""}`.toLowerCase()
  return detail.includes("duplicate document number")
}

function requirePushResult(result: { success: boolean; qbo_id?: string; error?: string; skipped?: boolean; pending?: boolean; errorStatus?: number | null; errorFaultCode?: string | null; errorFaultDetail?: string | null }): PushResult {
  // A lost create-claim race is not done — another attempt holds the lease, and
  // this job must run again after it lapses. Reporting it as a plain skip made
  // the outbox mark the job completed, which dropped the push forever.
  if (result.success && result.pending) return { externalId: null, skipped: true, deferred: true }
  // A successful skip (e.g. voiding an invoice that never reached QBO) is not a failure;
  // throwing here would turn it into a retrying outbox job.
  if (result.success && result.skipped) return { externalId: result.qbo_id ?? null, skipped: true }
  if (!result.success || !result.qbo_id) {
    // Carry the QBO fault through so the outbox's permanent-failure classifier
    // sees real status/fault codes instead of null.
    const error = new Error(result.error ?? "QuickBooks sync failed") as Error & { status?: number | null; faultCode?: string | null; faultDetail?: string | null }
    error.status = result.errorStatus ?? null
    error.faultCode = result.errorFaultCode ?? null
    error.faultDetail = result.errorFaultDetail ?? null
    throw error
  }
  return { externalId: result.qbo_id }
}

async function requireQboClient(connectionId: string) {
  const client = await QBOClient.forConnection(connectionId)
  if (!client) throw new Error("QuickBooks connection is unavailable")
  return client
}

/**
 * Post one summarized journal for a closed period.
 *
 * The lines arrive already mapped to QuickBooks accounts — the mirror engine
 * owns the netting and the mapping, this owns the transport. Idempotency rides
 * on `accounting_sync_records` under `entity_type = "period_summary"`, which the
 * engine writes; `reference` goes into the memo so the entry is identifiable in
 * QuickBooks by a human looking for it.
 */
async function pushSummaryJournalToQbo(input: {
  orgId: string
  connectionId: string
  reference: string
  date: string
  memo: string
  lines: Array<{ externalAccountId: string; externalAccountName: string | null; debitCents: number; creditCents: number; description: string }>
}): Promise<PushResult> {
  if (input.lines.length < 2) throw new Error("A summarized journal needs at least two lines")
  const qboLines = input.lines.map((line) => ({
    Amount: centsToAmount(line.debitCents || line.creditCents),
    Description: line.description,
    DetailType: "JournalEntryLineDetail",
    JournalEntryLineDetail: {
      PostingType: line.debitCents > 0 ? "Debit" : "Credit",
      AccountRef: { value: line.externalAccountId, name: line.externalAccountName ?? undefined },
    },
  }))
  const client = await requireQboClient(input.connectionId)
  // The mirror engine's sync-record pre-check cannot see a create whose
  // response was lost, and a re-posted period doubles a whole month — so look
  // for our own marker before posting, exactly like the payment path.
  const adoptedId = await findAlreadyCreatedQBOTransaction({
    client,
    entity: "JournalEntry",
    entityType: "period_summary",
    entityId: input.reference,
    logContext: { orgId: input.orgId, connectionId: input.connectionId },
  })
  if (adoptedId) return { externalId: adoptedId, raw: null }
  const created = await client.createJournalEntry({
    TxnDate: input.date,
    PrivateNote: withArcTransactionMarker(`${input.memo} [${input.reference}]`, "period_summary", input.reference),
    Line: qboLines,
  })
  if (!created?.Id) throw new Error("QuickBooks did not return the mirrored summary id")
  return { externalId: String(created.Id), externalVersion: created.SyncToken ? String(created.SyncToken) : null, raw: created }
}

async function pushBooksJournalToQbo(input: { orgId: string; connectionId: string; journalId: string }): Promise<PushResult> {
  const supabase = createServiceSupabaseClient()
  const { data: existing } = await supabase.from("accounting_sync_records").select("external_id, external_version, status").eq("org_id", input.orgId).eq("connection_id", input.connectionId).eq("entity_type", "journal_entry").eq("entity_id", input.journalId).maybeSingle()
  if (existing?.status === "synced" && existing.external_id) return { externalId: existing.external_id, externalVersion: existing.external_version, skipped: true }
  const { data: journal, error } = await supabase.from("journal_entries")
    .select("id, entry_date, memo, status")
    .eq("org_id", input.orgId)
    .eq("id", input.journalId)
    .eq("status", "posted")
    .single()
  if (error || !journal) throw new Error(`Unable to load mapped Arc journal: ${error?.message ?? "not found"}`)
  const { data: linesData, error: linesError } = await supabase.from("journal_lines").select("line_no, debit_cents, credit_cents, description, account_id").eq("org_id", input.orgId).eq("entry_id", input.journalId).order("line_no")
  if (linesError) throw new Error(`Unable to load Arc journal lines: ${linesError.message}`)
  const lines = linesData ?? []
  if (lines.length < 2) throw new Error("Journal entry has no mapped lines")
  const accountIds = Array.from(new Set(lines.map((line) => line.account_id)))
  const { data: mappingsData, error: mappingsError } = await supabase.from("accounting_account_mappings").select("gl_account_id, external_account_id, external_account_name").eq("org_id", input.orgId).eq("connection_id", input.connectionId).in("gl_account_id", accountIds)
  if (mappingsError) throw new Error(`Unable to load QuickBooks account mappings: ${mappingsError.message}`)
  const mappingByAccount = new Map((mappingsData ?? []).map((mapping) => [mapping.gl_account_id, mapping]))
  const qboLines = lines.map((line) => {
    const mapping = mappingByAccount.get(line.account_id)
    if (!mapping) throw new Error(`Journal account ${line.account_id} is not mapped to QuickBooks`)
    const debit = Number(line.debit_cents ?? 0)
    const credit = Number(line.credit_cents ?? 0)
    return {
      Amount: centsToAmount(debit || credit),
      Description: line.description ?? undefined,
      DetailType: "JournalEntryLineDetail",
      JournalEntryLineDetail: {
        PostingType: debit > 0 ? "Debit" : "Credit",
        AccountRef: { value: mapping.external_account_id, name: mapping.external_account_name ?? undefined },
      },
    }
  })
  const client = await requireQboClient(input.connectionId)
  const created = await client.createJournalEntry({ TxnDate: journal.entry_date, PrivateNote: withArcTransactionMarker(`Arc mirror · ${journal.memo}`, "journal_entry", input.journalId), Line: qboLines })
  if (!created?.Id) throw new Error("QuickBooks did not return the mirrored journal id")
  await upsertSyncRecord({ orgId: input.orgId, connectionId: input.connectionId, entityId: input.journalId, qboId: String(created.Id), syncToken: created.SyncToken ? String(created.SyncToken) : undefined, entityType: "journal_entry" })
  return { externalId: String(created.Id), externalVersion: created.SyncToken ? String(created.SyncToken) : null, raw: created }
}

export const qboProvider: AccountingProvider = {
  key: "qbo",
  capabilities: {
    supportsSubCustomers: true,
    supportsInvoiceDocNumberSync: true,
    supportsImport: true,
    supportsCDC: true,
    supportsAttachments: true,
    supportsJournalEntryPush: true,
    supportsVendorCredits: true,
    supportsBillPaymentVoid: true,
    dimensions: ["class", "customer"],
  },
  async ensureHealthy(connectionId) {
    const auth = await getQBOAccessTokenForConnection(connectionId)
    return auth ? { ok: true } : { ok: false, error: "Unable to load or refresh QuickBooks credentials" }
  },
  async refreshConnection(connectionId) {
    const auth = await getQBOAccessTokenForConnection(connectionId, { forceRefresh: true })
    return auth ? { ok: true } : { ok: false, error: "QuickBooks token refresh failed" }
  },
  keepAliveConnections: refreshQBOConnectionsDueForKeepalive,
  disconnect: disconnectQboProviderConnection,
  async pushInvoice(input) {
    return requirePushResult(await syncInvoiceToQBO(input.invoiceId, input.orgId, { allowRecreateDeleted: input.allowRecreateDeleted, connectionId: input.connectionId }))
  },
  async pushPayment(input) {
    return requirePushResult(await syncPaymentToQBO(input.paymentId, input.orgId, { connectionId: input.connectionId }))
  },
  async pushExpense(input) {
    return requirePushResult(await syncProjectExpenseToQBO(input.expenseId, input.orgId, { connectionId: input.connectionId }))
  },
  async pushVendorBill(input) {
    return requirePushResult(await syncVendorBillToQBO(input.billId, input.orgId, { connectionId: input.connectionId }))
  },
  async pushVendorCredit(input) {
    return requirePushResult(await syncVendorBillToQBO(input.creditId, input.orgId, { connectionId: input.connectionId }))
  },
  async pushBillPayment(input) {
    return requirePushResult(await syncBillPaymentToQBO(input.paymentId, input.orgId, { connectionId: input.connectionId }))
  },
  async voidBillPayment(input) {
    return requirePushResult(await voidBillPaymentInQBO(input.paymentId, input.orgId, input.reason, { connectionId: input.connectionId }))
  },
  pushJournalEntry: pushBooksJournalToQbo,
  pushSummaryJournal: pushSummaryJournalToQbo,
  resolveConflictTakeRemote: forceReconcileFromQbo,
  async listDimensionValues(input) {
    const client = await requireQboClient(input.connectionId)
    if (input.kind === "class") return (await client.listClasses()).map((item) => ({ id: item.id, name: item.name }))
    if (input.kind === "customer") return (await client.listCustomers()).map((item) => ({ id: item.id, name: item.name }))
    return []
  },
  async listAccounts(input) {
    const client = await requireQboClient(input.connectionId)
    const rows = input.kind === "income" ? await client.listIncomeAccounts()
      : input.kind === "expense" ? await client.listExpenseAccounts()
      : input.kind === "payment" ? await client.listPaymentAccounts()
      : await client.listAccountsPayableAccounts()
    return rows.map((item) => ({ id: item.id, name: item.name, fullyQualifiedName: item.fullyQualifiedName ?? undefined, accountType: (item as { accountType?: string }).accountType }))
  },
  async listAllAccounts(input) {
    const client = await requireQboClient(input.connectionId)
    return (await client.listAllAccounts()).map((item) => ({
      id: item.id,
      name: item.name,
      fullyQualifiedName: item.fullyQualifiedName,
      accountType: item.accountType,
    }))
  },
  async searchCounterparties(input) {
    const client = await requireQboClient(input.connectionId)
    const rows = input.role === "customer"
      ? await client.searchCustomers(input.term)
      : (await client.listVendors()).filter((vendor) => {
          const needle = input.term.trim().toLowerCase()
          return !needle || vendor.name.toLowerCase().includes(needle)
        }).slice(0, 25)
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      fullyQualifiedName: (row as { fullyQualifiedName?: string | null }).fullyQualifiedName ?? undefined,
      email: (row as { email?: string | null }).email ?? null,
    }))
  },
  async createCounterparty(input) {
    const client = await requireQboClient(input.connectionId)
    const details = input.counterparty
    const row = input.role === "customer"
      ? await client.createCustomerOption({
          name: details.displayName,
          email: details.email,
          line1: details.line1,
          city: details.city,
          state: details.state,
          postalCode: details.postalCode,
        })
      : await client.createVendorOption({
          name: details.displayName,
          email: details.email,
          line1: details.line1,
          city: details.city,
          state: details.state,
          postalCode: details.postalCode,
        })
    return { id: row.id, name: row.name }
  },
  async createAccount(input) {
    if (input.kind !== "income") throw new Error("QuickBooks only supports income-account creation from Arc")
    const client = await requireQboClient(input.connectionId)
    const row = await client.createIncomeAccount(input.name)
    return { id: row.id, name: row.name, fullyQualifiedName: row.fullyQualifiedName ?? undefined }
  },
  async getLastInvoiceNumber(input) {
    const client = await requireQboClient(input.connectionId)
    return client.getLastInvoiceNumber()
  },
  async uploadInvoiceAttachment(input) {
    const client = await requireQboClient(input.connectionId)
    return client.uploadAttachmentForInvoice({
      invoiceId: input.externalInvoiceId,
      fileName: input.fileName,
      contentType: input.contentType,
      content: input.content,
      note: input.note,
    })
  },
  async resolveCounterparty(input) {
    const client = await requireQboClient(input.connectionId)
    const row = input.role === "vendor"
      ? await client.getOrCreateVendor(input.displayName)
      : await client.getOrCreateCustomer(input.displayName)
    if (!row.Id) throw new Error(`QuickBooks ${input.role} did not return an id`)
    return { id: row.Id, name: row.DisplayName }
  },
  async getConnectUrl(input) {
    const state = createQBOOAuthState(input.orgId)
    return { url: getQBOAuthUrl(state), state }
  },
  receiveWebhook: receiveQboWebhook,
  ingestChanges: ingestQboCdcChanges,
  drainInboundEvents: drainQboInboundEvents,
}
