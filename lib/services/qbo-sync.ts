import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { QBOClient, QBOError } from "@/lib/integrations/accounting/qbo-api"
import { enqueueOutboxJob } from "@/lib/services/outbox"
import { incrementInvoiceNumber, rememberQBOInvoiceNumberCursor } from "@/lib/services/invoice-numbers"
import { recordEvent } from "@/lib/services/events"
import { logQBO } from "@/lib/services/qbo-logger"
import { downloadFilesObject } from "@/lib/storage/files-storage"

interface InvoiceLineRow {
  description: string
  quantity: number
  unit_price_cents: number
  metadata?: Record<string, any> | null
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
  qbo_id?: string | null
  metadata?: Record<string, any> | null
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
): Promise<boolean> {
  const { data } = await supabase
    .from("qbo_sync_records")
    .select("pushable")
    .eq("org_id", orgId)
    .eq("entity_type", entityType)
    .eq("entity_id", entityId)
    .maybeSingle()
  return data?.pushable === false
}

export async function syncInvoiceToQBO(invoiceId: string, orgId: string) {
  const supabase = createServiceSupabaseClient()
  const client = await QBOClient.forOrg(orgId)

  if (!client) {
    await supabase.from("invoices").update({ qbo_sync_status: "skipped" }).eq("id", invoiceId)
    await markConnectionError(orgId, "No active QBO connection")
    return { success: false, error: "No active QBO connection" }
  }

  if (await isSyncPushBlocked(supabase, orgId, "invoice", invoiceId)) {
    await supabase.from("invoices").update({ qbo_sync_status: "skipped" }).eq("id", invoiceId).eq("org_id", orgId)
    return { success: true, skipped: true }
  }

  const { data: invoice, error } = await supabase
    .from("invoices")
    .select(
      "id, org_id, project_id, invoice_number, issue_date, due_date, total_cents, balance_due_cents, title, status, qbo_id, metadata, project:projects(qbo_class_id, qbo_class_name), invoice_lines (description, quantity, unit_price_cents, metadata)",
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

  const { data: connection } = await supabase
    .from("qbo_connections")
    .select("settings")
    .eq("org_id", orgId)
    .eq("status", "active")
    .maybeSingle()

  const invoiceIncomeAccountId = (typedInvoice.metadata as any)?.qbo_income_account_id
  const defaultIncomeAccountId =
    typeof invoiceIncomeAccountId === "string" && invoiceIncomeAccountId.trim().length > 0
      ? invoiceIncomeAccountId.trim()
      : ((connection?.settings as any)?.default_income_account_id as string | undefined)
  let existingSync: any = null
  let qboInvoice: any = null
  let invoiceIsUpdate = false

  try {
    existingSync = await supabase
      .from("qbo_sync_records")
      .select("qbo_id, qbo_sync_token")
      .eq("org_id", orgId)
      .eq("entity_type", "invoice")
      .eq("entity_id", invoiceId)
      .maybeSingle()

    const existingQboId = existingSync.data?.qbo_id ?? typedInvoice.qbo_id ?? null
    if (typedInvoice.status === "void") {
      if (!existingQboId) {
        await supabase
          .from("invoices")
          .update({ qbo_sync_status: "skipped" })
          .eq("org_id", orgId)
          .eq("id", invoiceId)
        return { success: true, skipped: true }
      }

      const latestInvoice = await client.getInvoiceById(existingQboId)
      if (!latestInvoice) {
        // The desired state is already true when the linked QBO invoice was
        // deleted. Keep its id as a tombstone so the import sheet cannot adopt
        // the same QBO identity again, and clear any prior sync error.
        await upsertSyncRecord({
          orgId,
          entityId: invoiceId,
          qboId: existingQboId,
          entityType: "invoice",
        })
        await supabase
          .from("invoices")
          .update({
            qbo_id: existingQboId,
            qbo_synced_at: new Date().toISOString(),
            qbo_sync_status: "synced",
          })
          .eq("org_id", orgId)
          .eq("id", invoiceId)
        await markConnectionHealthy(orgId)
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
        entityId: invoiceId,
        qboId: existingQboId,
        syncToken: voided.SyncToken,
        entityType: "invoice",
      })
      await supabase
        .from("invoices")
        .update({
          qbo_id: existingQboId,
          qbo_synced_at: new Date().toISOString(),
          qbo_sync_status: "synced",
        })
        .eq("org_id", orgId)
        .eq("id", invoiceId)
      await markConnectionHealthy(orgId)
      logQBO("info", "invoice_void_sync_success", { orgId, invoiceId, qboId: existingQboId })
      return { success: true, qbo_id: existingQboId }
    }

    const metadataQboCustomerId = (typedInvoice.metadata as any)?.qbo_customer_id
    const metadataQboCustomerName = (typedInvoice.metadata as any)?.qbo_customer_name
    const customer =
      typeof metadataQboCustomerId === "string" && metadataQboCustomerId.trim().length > 0
        ? { Id: metadataQboCustomerId.trim(), DisplayName: String(metadataQboCustomerName ?? resolveCustomerName(typedInvoice)) }
        : await client.getOrCreateCustomer(resolveCustomerName(typedInvoice))
    const serviceItemCache = new Map<string, { value: string; name: string }>()
    const resolveServiceItem = async (lineIncomeAccountId?: string | null) => {
      const normalizedLineAccount =
        typeof lineIncomeAccountId === "string" && lineIncomeAccountId.trim().length > 0
          ? lineIncomeAccountId.trim()
          : defaultIncomeAccountId
      const cacheKey = normalizedLineAccount ?? "__fallback__"
      const cached = serviceItemCache.get(cacheKey)
      if (cached) return cached
      const next = await client.getDefaultServiceItem(normalizedLineAccount)
      serviceItemCache.set(cacheKey, next)
      return next
    }

    // Note: we intentionally do NOT write this invoice's customer to the project's customer map. The
    // project default is owned by project settings (and the client-contact fallback in
    // getOrCreateProjectCustomer) so a one-off invoice can't silently re-point every future payable.

    const qboLines = await Promise.all(
      (typedInvoice.lines ?? []).map(async (line) => {
        const lineIncomeAccountId = (line.metadata as any)?.qbo_income_account_id
        const itemRef = await resolveServiceItem(lineIncomeAccountId)
        const classRef = resolveQBOClassRef(line.metadata, typedInvoice.project)
        return {
          DetailType: "SalesItemLineDetail" as const,
          Amount: (line.quantity * line.unit_price_cents) / 100,
          Description: line.description,
          SalesItemLineDetail: {
            ItemRef: itemRef,
            Qty: line.quantity,
            UnitPrice: line.unit_price_cents / 100,
            TaxCodeRef: {
              value: (line.metadata as any)?.taxable === false ? "NON" : "TAX",
            },
            ClassRef: classRef,
          },
        }
      }),
    )

    // Resolve a usable SyncToken before updating: invoices imported from QBO
    // (or with a token that drifted) carry a qbo_id but no cached token, which
    // would otherwise fail with "Invoice Id and SyncToken required for update".
    const invoiceTarget = await resolveQBOSyncTarget({
      client,
      entityType: "invoice",
      qboId: existingSync.data?.qbo_id ?? typedInvoice.qbo_id,
      cachedSyncToken: existingSync.data?.qbo_sync_token,
      logContext: { orgId, invoiceId },
    })
    invoiceIsUpdate = invoiceTarget.mode === "update"

    qboInvoice = {
      ...(invoiceTarget.mode === "update" ? { Id: invoiceTarget.id, SyncToken: invoiceTarget.syncToken } : {}),
      DocNumber: typedInvoice.invoice_number,
      TxnDate: typedInvoice.issue_date ?? new Date().toISOString().split("T")[0],
      DueDate: typedInvoice.due_date ?? undefined,
      CustomerRef: { value: customer.Id!, name: customer.DisplayName },
      Line: qboLines,
      PrivateNote: typedInvoice.title ?? undefined,
    }

    const result = invoiceIsUpdate
      ? await client.updateInvoice(qboInvoice as any)
      : await client.createInvoice(qboInvoice as any)

    await upsertSyncRecord({
      orgId,
      entityId: invoiceId,
      qboId: result.Id!,
      syncToken: result.SyncToken,
      entityType: "invoice",
    })

    await supabase
      .from("invoices")
      .update({
        qbo_id: result.Id,
        qbo_synced_at: new Date().toISOString(),
        qbo_sync_status: "synced",
      })
      .eq("id", invoiceId)

    await rememberQBOInvoiceNumberCursor(orgId, result.DocNumber ?? typedInvoice.invoice_number)
    await syncInvoicePdfAttachmentToQBO({
      client,
      supabase,
      orgId,
      invoiceId,
      qboInvoiceId: result.Id!,
    })
    await markConnectionHealthy(orgId)
    logQBO("info", "invoice_sync_success", { orgId, invoiceId, qboId: result.Id })

    return { success: true, qbo_id: result.Id }
  } catch (err: any) {
    if (err instanceof QBOError && isStaleObjectError(err) && existingSync.data?.qbo_id) {
      try {
        const latestInvoice = await client.getInvoiceById(existingSync.data.qbo_id)
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
          entityId: invoiceId,
          qboId: retryResult.Id!,
          syncToken: retryResult.SyncToken,
          entityType: "invoice",
        })

        await supabase
          .from("invoices")
          .update({
            qbo_id: retryResult.Id,
            qbo_synced_at: new Date().toISOString(),
            qbo_sync_status: "synced",
          })
          .eq("id", invoiceId)

        await rememberQBOInvoiceNumberCursor(orgId, retryResult.DocNumber ?? typedInvoice.invoice_number)
        await syncInvoicePdfAttachmentToQBO({
          client,
          supabase,
          orgId,
          invoiceId,
          qboInvoiceId: retryResult.Id!,
        })
        await markConnectionHealthy(orgId)
        logQBO("warn", "invoice_sync_stale_token_retried", {
          orgId,
          invoiceId,
          qboId: retryResult.Id,
        })

        return { success: true, qbo_id: retryResult.Id }
      } catch (retryError: any) {
        const retryErrorMessage = retryError instanceof QBOError ? retryError.message : retryError?.message ?? "Stale sync token retry failed"
        await supabase.from("invoices").update({ qbo_sync_status: "error" }).eq("id", invoiceId)
        await markSyncRecordError(orgId, "invoice", invoiceId, retryErrorMessage)
        await markConnectionError(orgId, retryErrorMessage)
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
        return { success: false, error: retryErrorMessage }
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
            qbo_sync_status: "pending",
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
          entityId: invoiceId,
          qboId: retryResult.Id!,
          syncToken: retryResult.SyncToken,
          entityType: "invoice",
        })

        await supabase
          .from("invoices")
          .update({
            qbo_id: retryResult.Id,
            qbo_synced_at: new Date().toISOString(),
            qbo_sync_status: "synced",
          })
          .eq("id", invoiceId)

        await rememberQBOInvoiceNumberCursor(orgId, retryResult.DocNumber ?? nextNumber)
        await syncInvoicePdfAttachmentToQBO({
          client,
          supabase,
          orgId,
          invoiceId,
          qboInvoiceId: retryResult.Id!,
        })
        await markConnectionHealthy(orgId)
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
        await supabase.from("invoices").update({ qbo_sync_status: "error" }).eq("id", invoiceId)
        await markSyncRecordError(orgId, "invoice", invoiceId, retryErrorMessage)
        await markConnectionError(orgId, retryErrorMessage)
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
        return { success: false, error: retryErrorMessage }
      }
    }

    const errorMessage = err instanceof QBOError ? err.message : String(err)
    await supabase.from("invoices").update({ qbo_sync_status: "error" }).eq("id", invoiceId)
    await markSyncRecordError(orgId, "invoice", invoiceId, errorMessage)
    await markConnectionError(orgId, errorMessage)
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
    return { success: false, error: errorMessage }
  }
}

export async function forceSyncInvoiceToQBO(invoiceId: string, orgId: string) {
  const supabase = createServiceSupabaseClient()
  await supabase.from("invoices").update({ qbo_sync_status: "pending" }).eq("id", invoiceId).eq("org_id", orgId)
  return syncInvoiceToQBO(invoiceId, orgId)
}

export async function syncPaymentToQBO(paymentId: string, orgId: string) {
  const supabase = createServiceSupabaseClient()
  const client = await QBOClient.forOrg(orgId)
  if (!client) {
    await markConnectionError(orgId, "No active QBO connection")
    return { success: false, error: "No active QBO connection" }
  }

  if (await isSyncPushBlocked(supabase, orgId, "payment", paymentId)) {
    return { success: true, skipped: true }
  }

  const { data: existingPaymentSync } = await supabase
    .from("qbo_sync_records")
    .select("qbo_id")
    .eq("org_id", orgId)
    .eq("entity_type", "payment")
    .eq("entity_id", paymentId)
    .maybeSingle()

  if (existingPaymentSync?.qbo_id) {
    return { success: true, qbo_id: existingPaymentSync.qbo_id }
  }

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
    
    const invoice = Array.isArray(payment.invoice) ? payment.invoice[0] : payment.invoice
    if (!invoice?.qbo_id) return { success: false, error: "Invoice not synced to QBO" }

    const { data: customerSync } = await supabase
      .from("qbo_sync_records")
      .select("qbo_id")
      .eq("org_id", orgId)
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
              entityId: invoice.project_id,
              qboId: cust.Id,
              entityType: "customer",
            })
          }
          return { value: cust.Id! }
        })()

    const qboPayment = await client.createPayment({
      CustomerRef: customerRef,
      TotalAmt: payment.amount_cents / 100,
      Line: [
        {
          Amount: payment.amount_cents / 100,
          LinkedTxn: [{ TxnId: invoice.qbo_id, TxnType: "Invoice" }],
        },
      ],
    })

    await upsertSyncRecord({
      orgId,
      entityId: paymentId,
      qboId: qboPayment.Id,
      entityType: "payment",
    })

    await markConnectionHealthy(orgId)
    logQBO("info", "payment_sync_success", { orgId, paymentId, qboId: qboPayment.Id })

    return { success: true, qbo_id: qboPayment.Id }
  } catch (error: any) {
    const message = error instanceof QBOError ? error.message : error?.message ?? String(error)
    await markSyncRecordError(orgId, "payment", paymentId, message)
    await markConnectionError(orgId, message)
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
    return { success: false, error: message }
  }
}

export async function syncProjectExpenseToQBO(expenseId: string, orgId: string) {
  const supabase = createServiceSupabaseClient()
  const client = await QBOClient.forOrg(orgId)

  if (!client) {
    await supabase.from("project_expenses").update({ qbo_sync_status: "skipped" }).eq("id", expenseId).eq("org_id", orgId)
    await markConnectionError(orgId, "No active QBO connection")
    return { success: false, error: "No active QBO connection" }
  }

  if (await isSyncPushBlocked(supabase, orgId, "project_expense", expenseId)) {
    await supabase.from("project_expenses").update({ qbo_sync_status: "skipped" }).eq("id", expenseId).eq("org_id", orgId)
    return { success: true, skipped: true }
  }

  const { data: expense, error } = await supabase
    .from("project_expenses")
    .select(
      `
      id, org_id, project_id, vendor_company_id, vendor_name_text, expense_date, description, amount_cents, tax_cents, payment_method, is_billable, receipt_file_id,
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

  const typedExpense = expense as ProjectExpenseForSync
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
    const vendor = typedExpense.qbo_vendor_id
      ? { Id: typedExpense.qbo_vendor_id, DisplayName: typedExpense.qbo_vendor_name ?? vendorName }
      : await client.getOrCreateVendor(vendorName)
    const customer = await getOrCreateProjectCustomer({ client, supabase, orgId, projectId: typedExpense.project_id, projectName: typedExpense.project?.name ?? null })
    const totalAmount = (Number(typedExpense.amount_cents ?? 0) + Number(typedExpense.tax_cents ?? 0)) / 100
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
      for (const pid of projectIds) {
        customerByProject.set(
          pid,
          pid === typedExpense.project_id
            ? customer
            : await getOrCreateProjectCustomer({ client, supabase, orgId, projectId: pid, projectName: projectInfoById.get(pid)?.name ?? null }),
        )
      }

      qboLines = (splitLines ?? []).map((line) => {
        const lineProjectId = line.project_id ?? typedExpense.project_id
        const lineCustomer = customerByProject.get(lineProjectId) ?? customer
        const lineProject = projectInfoById.get(lineProjectId) ?? typedExpense.project
        const lineClassRef = resolveQBOClassRef(
          { qbo_class_id: lineProject?.qbo_class_id, qbo_class_name: lineProject?.qbo_class_name },
          lineProject,
        )
        return {
          DetailType: "AccountBasedExpenseLineDetail",
          Amount: Number(line.amount_cents ?? 0) / 100,
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
      .from("qbo_sync_records")
      .select("qbo_id, qbo_sync_token")
      .eq("org_id", orgId)
      .eq("entity_type", "project_expense")
      .eq("entity_id", expenseId)
      .maybeSingle()

    const basePayload = {
      TxnDate: typedExpense.expense_date,
      PrivateNote: typedExpense.description ?? undefined,
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

    await markConnectionHealthy(orgId)
    logQBO("info", "project_expense_sync_success", { orgId, expenseId, qboId: result.Id, transactionType })
    return { success: true, qbo_id: result.Id }
  } catch (error: any) {
    const message = error instanceof QBOError ? error.message : error?.message ?? String(error)
    await supabase
      .from("project_expenses")
      .update({ qbo_sync_status: "error", qbo_sync_error: message.slice(0, 4000) })
      .eq("org_id", orgId)
      .eq("id", expenseId)
    await markSyncRecordError(orgId, "project_expense", expenseId, message)
    await markConnectionError(orgId, message)
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
    return { success: false, error: message }
  }
}

export async function syncVendorBillToQBO(billId: string, orgId: string) {
  const supabase = createServiceSupabaseClient()
  if (await isSyncPushBlocked(supabase, orgId, "vendor_credit", billId)) {
    return { success: true, skipped: true }
  }
  const client = await QBOClient.forOrg(orgId)

  if (!client) {
    await supabase.from("vendor_bills").update({ qbo_sync_status: "skipped" }).eq("id", billId).eq("org_id", orgId)
    await markConnectionError(orgId, "No active QBO connection")
    return { success: false, error: "No active QBO connection" }
  }

  if (await isSyncPushBlocked(supabase, orgId, "bill", billId)) {
    await supabase.from("vendor_bills").update({ qbo_sync_status: "skipped" }).eq("id", billId).eq("org_id", orgId)
    return { success: true, skipped: true }
  }

  const { data: bill, error } = await supabase
    .from("vendor_bills")
    .select(
      `
      id, org_id, project_id, commitment_id, company_id, bill_number, bill_date, due_date, total_cents, currency, file_id, metadata,
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

  const typedBill = bill as VendorBillForSync
  if ((typedBill.metadata as Record<string, any> | null)?.source === "vendor_credit") {
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
    const vendor = linkedVendorId
      ? { Id: linkedVendorId, DisplayName: linkedVendorName ?? vendorName }
      : await client.getOrCreateVendor(vendorName)
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
      const amount = ((line.unit_cost_cents ?? 0) * (line.quantity ?? 1)) / 100
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
          BillableStatus: billableToCustomer ? "Billable" : "NotBillable",
          ClassRef: classRef,
        },
      }
    })

    const { data: existingSync } = await supabase
      .from("qbo_sync_records")
      .select("qbo_id, qbo_sync_token")
      .eq("org_id", orgId)
      .eq("entity_type", "bill")
      .eq("entity_id", billId)
      .maybeSingle()
    const qboBill = {
      DocNumber: typedBill.bill_number ?? undefined,
      TxnDate: typedBill.bill_date ?? new Date().toISOString().slice(0, 10),
      DueDate: typedBill.due_date ?? undefined,
      VendorRef: { value: vendor.Id!, name: vendor.DisplayName },
      APAccountRef: typedBill.qbo_ap_account_id
        ? { value: typedBill.qbo_ap_account_id, name: typedBill.qbo_ap_account_name ?? undefined }
        : undefined,
      PrivateNote: typedBill.commitment?.title ?? undefined,
      Line: qboLines,
    }

    const result = await createOrUpdateQBOEntity({
      client,
      entityType: "bill",
      qboId: existingSync?.qbo_id ?? typedBill.qbo_id,
      cachedSyncToken: existingSync?.qbo_sync_token,
      payload: qboBill,
      create: (p) => client.createBill(p as any),
      update: (p) => client.updateBill(p as any),
      logContext: { orgId, billId },
    })

    await upsertSyncRecord({
      orgId,
      entityId: billId,
      qboId: result.Id!,
      syncToken: result.SyncToken,
      entityType: "bill",
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

    await syncVendorBillAttachmentToQBO({
      client,
      supabase,
      orgId,
      billId,
      qboBillId: result.Id!,
      fileId: typedBill.file_id ?? null,
      metadata: typedBill.metadata ?? {},
    })

    await markConnectionHealthy(orgId)
    logQBO("info", "vendor_bill_sync_success", { orgId, billId, qboId: result.Id })
    return { success: true, qbo_id: result.Id }
  } catch (error: any) {
    const message = error instanceof QBOError ? error.message : error?.message ?? String(error)
    await supabase
      .from("vendor_bills")
      .update({ qbo_sync_status: "error", qbo_sync_error: message.slice(0, 4000) })
      .eq("org_id", orgId)
      .eq("id", billId)
    await markSyncRecordError(orgId, "bill", billId, message)
    await markConnectionError(orgId, message)
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
    return { success: false, error: message }
  }
}

export async function syncBillPaymentToQBO(paymentId: string, orgId: string) {
  const supabase = createServiceSupabaseClient()
  const client = await QBOClient.forOrg(orgId)
  if (!client) {
    await markConnectionError(orgId, "No active QBO connection")
    return { success: false, error: "No active QBO connection" }
  }

  if (await isSyncPushBlocked(supabase, orgId, "bill_payment", paymentId)) {
    return { success: true, skipped: true }
  }

  const { data: existingSync } = await supabase
    .from("qbo_sync_records")
    .select("qbo_id")
    .eq("org_id", orgId)
    .eq("entity_type", "bill_payment")
    .eq("entity_id", paymentId)
    .maybeSingle()

  if (existingSync?.qbo_id) {
    return { success: true, qbo_id: existingSync.qbo_id }
  }

  const { data: payment, error } = await supabase
    .from("payments")
    .select("id, org_id, bill_id, amount_cents, method, reference, received_at, metadata, bill:vendor_bills(id, qbo_id, qbo_sync_status, metadata)")
    .eq("id", paymentId)
    .eq("org_id", orgId)
    .maybeSingle()

  if (error || !payment) return { success: false, error: error?.message ?? "Payment not found" }
  let bill = Array.isArray((payment as any).bill) ? (payment as any).bill[0] : (payment as any).bill
  if (!bill?.qbo_id) {
    const billId = (payment as any).bill_id as string | undefined
    if (!billId) return { success: false, error: "Payment is not linked to a vendor bill" }
    const billSync = await syncVendorBillToQBO(billId, orgId)
    if (!billSync.success) {
      return { success: false, error: billSync.error ?? "Bill is not linked to QuickBooks yet" }
    }
    const { data: refreshedBill } = await supabase
      .from("vendor_bills")
      .select("id, qbo_id, qbo_sync_status, metadata")
      .eq("org_id", orgId)
      .eq("id", billId)
      .maybeSingle()
    bill = refreshedBill
    if (!bill?.qbo_id) return { success: false, error: "Bill is not linked to QuickBooks yet" }
  }

  try {
    const qboBill = await client.getBillById(bill.qbo_id)
    const vendorRef = qboBill?.VendorRef
    if (!vendorRef?.value) {
      return { success: false, error: "QuickBooks bill is missing a vendor reference" }
    }

    const { data: connection } = await supabase
      .from("qbo_connections")
      .select("settings")
      .eq("org_id", orgId)
      .eq("status", "active")
      .maybeSingle()
    const paymentAccountId = (payment.metadata as any)?.qbo_payment_account_id ?? (connection?.settings as any)?.default_payment_account_id
    if (!paymentAccountId) {
      return { success: false, error: "Choose a default QuickBooks payment account before syncing bill payments" }
    }

    const qboPayment = await client.createBillPayment({
      VendorRef: vendorRef,
      PayType: "Check",
      TxnDate: payment.received_at ? new Date(payment.received_at).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10),
      TotalAmt: payment.amount_cents / 100,
      PrivateNote: payment.reference ?? undefined,
      CheckPayment: {
        BankAccountRef: { value: paymentAccountId },
      },
      Line: [
        {
          Amount: payment.amount_cents / 100,
          LinkedTxn: [{ TxnId: bill.qbo_id, TxnType: "Bill" }],
        },
      ],
    })

    await upsertSyncRecord({
      orgId,
      entityId: paymentId,
      qboId: qboPayment.Id,
      syncToken: qboPayment.SyncToken,
      entityType: "bill_payment",
    })
    await markConnectionHealthy(orgId)
    logQBO("info", "bill_payment_sync_success", { orgId, paymentId, qboId: qboPayment.Id })
    return { success: true, qbo_id: qboPayment.Id }
  } catch (error: any) {
    const message = error instanceof QBOError ? error.message : error?.message ?? String(error)
    await markSyncRecordError(orgId, "bill_payment", paymentId, message)
    await markConnectionError(orgId, message)
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
    return { success: false, error: message }
  }
}

export async function enqueueInvoiceSync(invoiceId: string, orgId: string) {
  const supabase = createServiceSupabaseClient()

  if (await isSyncPushBlocked(supabase, orgId, "invoice", invoiceId)) {
    await supabase.from("invoices").update({ qbo_sync_status: "skipped" }).eq("id", invoiceId).eq("org_id", orgId)
    return
  }

  const { data: connection } = await supabase
    .from("qbo_connections")
    .select("settings")
    .eq("org_id", orgId)
    .eq("status", "active")
    .maybeSingle()

  if (!connection?.settings?.auto_sync) {
    await supabase.from("invoices").update({ qbo_sync_status: "skipped" }).eq("id", invoiceId)
    return
  }

  await supabase.from("invoices").update({ qbo_sync_status: "pending" }).eq("id", invoiceId)

  await enqueueOutboxJob({
    orgId,
    jobType: "qbo_sync_invoice",
    payload: { invoice_id: invoiceId },
    dedupeByPayloadKeys: ["invoice_id"],
  })
}

export async function enqueuePaymentSync(paymentId: string, orgId: string) {
  const supabase = createServiceSupabaseClient()

  if (await isSyncPushBlocked(supabase, orgId, "payment", paymentId)) return

  const { data: connection } = await supabase
    .from("qbo_connections")
    .select("settings")
    .eq("org_id", orgId)
    .eq("status", "active")
    .maybeSingle()

  if (!connection?.settings?.sync_payments) {
    return
  }

  await enqueueOutboxJob({
    orgId,
    jobType: "qbo_sync_payment",
    payload: { payment_id: paymentId },
    dedupeByPayloadKeys: ["payment_id"],
  })
}

export async function enqueueProjectExpenseSync(expenseId: string, orgId: string) {
  const supabase = createServiceSupabaseClient()

  if (await isSyncPushBlocked(supabase, orgId, "project_expense", expenseId)) {
    await supabase.from("project_expenses").update({ qbo_sync_status: "skipped" }).eq("id", expenseId).eq("org_id", orgId)
    return
  }

  const { data: connection } = await supabase
    .from("qbo_connections")
    .select("settings")
    .eq("org_id", orgId)
    .eq("status", "active")
    .maybeSingle()

  if (!connection?.settings?.auto_sync) {
    await supabase.from("project_expenses").update({ qbo_sync_status: "skipped" }).eq("id", expenseId).eq("org_id", orgId)
    return
  }

  const { data: expense } = await supabase
    .from("project_expenses")
    .select("qbo_transaction_type, payment_method, qbo_expense_account_id, qbo_payment_account_id")
    .eq("id", expenseId)
    .eq("org_id", orgId)
    .maybeSingle()

  if (!expense?.qbo_expense_account_id) {
    await markProjectExpenseNeedsReview(orgId, expenseId, "Choose a QuickBooks account before syncing.")
    return
  }

  const transactionType = resolveProjectExpenseQBOTransactionType(expense as ProjectExpenseForSync)
  if (transactionType === "purchase" && !expense.qbo_payment_account_id) {
    await markProjectExpenseNeedsReview(orgId, expenseId, "Choose the QuickBooks bank or credit card account used for this paid expense.")
    return
  }

  await supabase.from("project_expenses").update({ qbo_sync_status: "pending", qbo_sync_error: null }).eq("id", expenseId).eq("org_id", orgId)

  await enqueueOutboxJob({
    orgId,
    jobType: "qbo_sync_project_expense",
    payload: { expense_id: expenseId },
    dedupeByPayloadKeys: ["expense_id"],
  })
}

export async function enqueueVendorBillSync(billId: string, orgId: string) {
  const supabase = createServiceSupabaseClient()

  if (await isSyncPushBlocked(supabase, orgId, "bill", billId)) {
    await supabase.from("vendor_bills").update({ qbo_sync_status: "skipped" }).eq("id", billId).eq("org_id", orgId)
    return
  }

  const { data: connection } = await supabase
    .from("qbo_connections")
    .select("settings")
    .eq("org_id", orgId)
    .eq("status", "active")
    .maybeSingle()

  if (!connection?.settings?.auto_sync) {
    await supabase.from("vendor_bills").update({ qbo_sync_status: "skipped" }).eq("id", billId).eq("org_id", orgId)
    return
  }

  const { data: bill } = await supabase
    .from("vendor_bills")
    .select("qbo_expense_account_id, bill_lines(metadata)")
    .eq("id", billId)
    .eq("org_id", orgId)
    .maybeSingle()

  if (!bill || !vendorBillHasQboExpenseCoding(bill as VendorBillForSync)) {
    await supabase
      .from("vendor_bills")
      .update({
        qbo_sync_status: "needs_review",
        qbo_sync_error: "Choose a QuickBooks expense/category account before syncing this payable.",
      })
      .eq("id", billId)
      .eq("org_id", orgId)
    return
  }

  await supabase.from("vendor_bills").update({ qbo_sync_status: "pending", qbo_sync_error: null }).eq("id", billId).eq("org_id", orgId)

  await enqueueOutboxJob({
    orgId,
    jobType: "qbo_sync_vendor_bill",
    payload: { bill_id: billId },
    dedupeByPayloadKeys: ["bill_id"],
  })
}

export async function enqueueBillPaymentSync(paymentId: string, orgId: string) {
  const supabase = createServiceSupabaseClient()

  if (await isSyncPushBlocked(supabase, orgId, "bill_payment", paymentId)) return

  const { data: connection } = await supabase
    .from("qbo_connections")
    .select("settings")
    .eq("org_id", orgId)
    .eq("status", "active")
    .maybeSingle()

  if (!connection?.settings?.sync_payments) return

  await enqueueOutboxJob({
    orgId,
    jobType: "qbo_sync_bill_payment",
    payload: { payment_id: paymentId },
    dedupeByPayloadKeys: ["payment_id"],
  })
}

export async function retryFailedQBOSyncJobs(orgId: string) {
  const supabase = createServiceSupabaseClient()
  let retriedInvoices = 0
  let retriedPayments = 0
  let retriedExpenses = 0
  let retriedVendorBills = 0

  const { data: failedInvoices } = await supabase
    .from("invoices")
    .select("id")
    .eq("org_id", orgId)
    .eq("qbo_sync_status", "error")
    .limit(50)

  for (const row of failedInvoices ?? []) {
    await enqueueInvoiceSync(row.id, orgId)
    retriedInvoices += 1
  }

  const { data: failedPayments } = await supabase
    .from("qbo_sync_records")
    .select("entity_id")
    .eq("org_id", orgId)
    .eq("entity_type", "payment")
    .eq("status", "error")
    .limit(50)

  for (const row of failedPayments ?? []) {
    if (!row.entity_id) continue
    await enqueuePaymentSync(row.entity_id, orgId)
    retriedPayments += 1
  }

  const { data: failedExpenses } = await supabase
    .from("project_expenses")
    .select("id")
    .eq("org_id", orgId)
    .in("qbo_sync_status", ["error", "needs_review"])
    .not("qbo_expense_account_id", "is", null)
    .limit(50)

  for (const row of failedExpenses ?? []) {
    await enqueueProjectExpenseSync(row.id, orgId)
    retriedExpenses += 1
  }

  const { data: failedVendorBills } = await supabase
    .from("vendor_bills")
    .select("id")
    .eq("org_id", orgId)
    .in("qbo_sync_status", ["error", "needs_review"])
    .not("qbo_expense_account_id", "is", null)
    .limit(50)

  for (const row of failedVendorBills ?? []) {
    await enqueueVendorBillSync(row.id, orgId)
    retriedVendorBills += 1
  }

  const { count: failedOutboxCount } = await supabase
    .from("outbox")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .in("job_type", ["qbo_sync_invoice", "qbo_sync_payment", "qbo_sync_project_expense", "qbo_sync_vendor_bill", "qbo_sync_bill_payment"])
    .eq("status", "failed")

  if ((failedOutboxCount ?? 0) > 0) {
    await supabase
      .from("outbox")
      .update({
        status: "pending",
        run_at: new Date().toISOString(),
      })
      .eq("org_id", orgId)
      .in("job_type", ["qbo_sync_invoice", "qbo_sync_payment", "qbo_sync_project_expense", "qbo_sync_vendor_bill", "qbo_sync_bill_payment"])
      .eq("status", "failed")
  }

  return {
    retried_invoices: retriedInvoices,
    retried_payments: retriedPayments,
    retried_expenses: retriedExpenses,
    retried_vendor_bills: retriedVendorBills,
    reopened_outbox_jobs: failedOutboxCount ?? 0,
  }
}

async function upsertSyncRecord(input: {
  orgId: string
  entityId: string
  qboId: string
  syncToken?: string
  entityType?: string
}) {
  const supabase = createServiceSupabaseClient()

  const { data: connection } = await supabase
    .from("qbo_connections")
    .select("id")
    .eq("org_id", input.orgId)
    .eq("status", "active")
    .single()

  if (!connection) return

  await supabase
    .from("qbo_sync_records")
    .upsert(
      {
        org_id: input.orgId,
        connection_id: connection.id,
        entity_type: input.entityType ?? "invoice",
        entity_id: input.entityId,
        qbo_id: input.qboId,
        qbo_sync_token: input.syncToken,
        last_synced_at: new Date().toISOString(),
        status: "synced",
        error_message: null,
      },
      { onConflict: "org_id,entity_type,entity_id" },
    )
}

async function markSyncRecordError(orgId: string, entityType: string, entityId: string, message: string) {
  const supabase = createServiceSupabaseClient()
  await supabase
    .from("qbo_sync_records")
    .update({
      status: "error",
      error_message: message.slice(0, 4000),
      last_synced_at: new Date().toISOString(),
    })
    .eq("org_id", orgId)
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

async function markConnectionHealthy(orgId: string) {
  const supabase = createServiceSupabaseClient()
  await supabase
    .from("qbo_connections")
    .update({
      last_sync_at: new Date().toISOString(),
      last_error: null,
    })
    .eq("org_id", orgId)
    .eq("status", "active")
}

async function markConnectionError(orgId: string, error: string) {
  const supabase = createServiceSupabaseClient()
  await supabase
    .from("qbo_connections")
    .update({
      last_error: error.slice(0, 4000),
    })
    .eq("org_id", orgId)
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
  projectId?: string | null
  projectName?: string | null
}) {
  if (!params.projectId) return null
  const { client, supabase, orgId, projectId } = params

  const { data: project } = await supabase
    .from("projects")
    .select("qbo_customer_id, qbo_customer_name, client_id")
    .eq("org_id", orgId)
    .eq("id", projectId)
    .maybeSingle()

  // 1. Explicit project default.
  if (project?.qbo_customer_id) {
    return { Id: project.qbo_customer_id, DisplayName: project.qbo_customer_name ?? params.projectName ?? "Customer" }
  }

  const persist = async (customer: { Id?: string; DisplayName?: string }) => {
    if (!customer?.Id) return
    await supabase
      .from("projects")
      .update({ qbo_customer_id: customer.Id, qbo_customer_name: customer.DisplayName ?? null })
      .eq("org_id", orgId)
      .eq("id", projectId)
    await upsertSyncRecord({ orgId, entityId: projectId, qboId: customer.Id, entityType: "customer" })
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

  // 3. Legacy mapping.
  const { data: existing } = await supabase
    .from("qbo_sync_records")
    .select("qbo_id")
    .eq("org_id", orgId)
    .eq("entity_type", "customer")
    .eq("entity_id", projectId)
    .maybeSingle()
  if (existing?.qbo_id) {
    return { Id: existing.qbo_id, DisplayName: params.projectName ?? "Project" }
  }

  // 4. Project name fallback.
  const displayName = params.projectName?.trim() || `Project ${projectId}`
  const customer = await client.getOrCreateCustomer(displayName)
  await persist(customer)
  return customer
}

function isDuplicateDocNumber(error: QBOError) {
  const detail = JSON.stringify(error.qboError ?? {}).toLowerCase()
  return detail.includes("docnumber") || detail.includes("duplicate") || detail.includes("already exists")
}

function isStaleObjectError(error: QBOError) {
  const detail = JSON.stringify(error.qboError ?? {}).toLowerCase()
  return error.faultCode === "5010" || detail.includes("stale object")
}

type QBOUpdatableEntityType = "purchase" | "bill" | "invoice"

function fetchQBOEntityById(
  client: QBOClient,
  entityType: QBOUpdatableEntityType,
  qboId: string,
): Promise<{ Id?: string; SyncToken?: string } | null> {
  switch (entityType) {
    case "purchase":
      return client.getPurchaseById(qboId)
    case "bill":
      return client.getBillById(qboId)
    case "invoice":
      return client.getInvoiceById(qboId) as Promise<{ Id?: string; SyncToken?: string } | null>
  }
}

/**
 * Decide whether a push should create or update a QuickBooks entity, always
 * returning a usable SyncToken for updates.
 *
 * QBO uses optimistic concurrency, so every update needs the record's current
 * SyncToken. Two situations leave us without a usable token:
 *   1. The record was imported FROM QuickBooks — it has a qbo_id but we never
 *      stored a SyncToken (the original "Id and SyncToken required" failure).
 *   2. The record was deleted in QuickBooks after we cached its id.
 * When the cached token is missing we fetch the live record to recover it; if
 * the record is gone we fall back to create so the entity can't get stuck.
 */
async function resolveQBOSyncTarget(params: {
  client: QBOClient
  entityType: QBOUpdatableEntityType
  qboId?: string | null
  cachedSyncToken?: string | null
  logContext?: Record<string, unknown>
}): Promise<{ mode: "create" } | { mode: "update"; id: string; syncToken: string }> {
  const qboId = params.qboId?.toString().trim() || undefined
  if (!qboId) return { mode: "create" }

  const cachedToken = params.cachedSyncToken?.toString().trim() || undefined
  if (cachedToken) return { mode: "update", id: qboId, syncToken: cachedToken }

  const latest = await fetchQBOEntityById(params.client, params.entityType, qboId)
  if (!latest) {
    // Record was deleted in QuickBooks; recreate it instead of erroring forever.
    logQBO("warn", "qbo_entity_recreated_after_delete", { entityType: params.entityType, qboId, ...params.logContext })
    return { mode: "create" }
  }
  if (!latest.SyncToken) {
    throw new Error(`Unable to resolve QuickBooks ${params.entityType} sync token`)
  }
  return { mode: "update", id: qboId, syncToken: latest.SyncToken }
}

/**
 * Create-or-update a QuickBooks entity with full SyncToken safety: resolves a
 * usable token up front (see {@link resolveQBOSyncTarget}) and, if the token
 * goes stale because the record was edited directly in QBO (fault 5010),
 * refreshes it and retries the update once.
 */
async function createOrUpdateQBOEntity<T extends Record<string, any>>(params: {
  client: QBOClient
  entityType: QBOUpdatableEntityType
  qboId?: string | null
  cachedSyncToken?: string | null
  payload: T
  create: (payload: T) => Promise<any>
  update: (payload: T & { Id: string; SyncToken: string }) => Promise<any>
  logContext?: Record<string, unknown>
}): Promise<any> {
  const target = await resolveQBOSyncTarget({
    client: params.client,
    entityType: params.entityType,
    qboId: params.qboId,
    cachedSyncToken: params.cachedSyncToken,
    logContext: params.logContext,
  })

  if (target.mode === "create") {
    return params.create(params.payload)
  }

  try {
    return await params.update({ ...params.payload, Id: target.id, SyncToken: target.syncToken })
  } catch (err) {
    if (err instanceof QBOError && isStaleObjectError(err)) {
      const latest = await fetchQBOEntityById(params.client, params.entityType, target.id)
      if (!latest?.SyncToken) {
        throw new Error(`Unable to refresh QuickBooks ${params.entityType} sync token`)
      }
      logQBO("warn", "qbo_entity_stale_token_retried", { entityType: params.entityType, qboId: target.id, ...params.logContext })
      return params.update({ ...params.payload, Id: target.id, SyncToken: latest.SyncToken })
    }
    throw err
  }
}
