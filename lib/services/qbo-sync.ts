import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { QBOClient, QBOError } from "@/lib/integrations/accounting/qbo-api"
import { enqueueOutboxJob } from "@/lib/services/outbox"
import { incrementInvoiceNumber } from "@/lib/services/invoice-numbers"
import { recordEvent } from "@/lib/services/events"
import { logQBO } from "@/lib/services/qbo-logger"

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
  metadata?: Record<string, any> | null
  lines: InvoiceLineRow[]
}

export async function syncInvoiceToQBO(invoiceId: string, orgId: string) {
  const supabase = createServiceSupabaseClient()
  const client = await QBOClient.forOrg(orgId)

  if (!client) {
    await supabase.from("invoices").update({ qbo_sync_status: "skipped" }).eq("id", invoiceId)
    await markConnectionError(orgId, "No active QBO connection")
    return { success: false, error: "No active QBO connection" }
  }

  const { data: invoice, error } = await supabase
    .from("invoices")
    .select(
      "id, org_id, project_id, invoice_number, issue_date, due_date, total_cents, balance_due_cents, title, status, metadata, invoice_lines (description, quantity, unit_price_cents, metadata)",
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

  try {
    const customer = await client.getOrCreateCustomer(resolveCustomerName(typedInvoice))
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

    existingSync = await supabase
      .from("qbo_sync_records")
      .select("qbo_id, qbo_sync_token")
      .eq("org_id", orgId)
      .eq("entity_type", "invoice")
      .eq("entity_id", invoiceId)
      .maybeSingle()

    if (typedInvoice.project_id && customer.Id) {
      await upsertSyncRecord({
        orgId,
        entityId: typedInvoice.project_id,
        qboId: customer.Id,
        entityType: "customer",
      })
    }

    const qboLines = await Promise.all(
      (typedInvoice.lines ?? []).map(async (line) => {
        const lineIncomeAccountId = (line.metadata as any)?.qbo_income_account_id
        const itemRef = await resolveServiceItem(lineIncomeAccountId)
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
          },
        }
      }),
    )

    qboInvoice = {
      Id: existingSync.data?.qbo_id,
      SyncToken: existingSync.data?.qbo_sync_token,
      DocNumber: typedInvoice.invoice_number,
      TxnDate: typedInvoice.issue_date ?? new Date().toISOString().split("T")[0],
      DueDate: typedInvoice.due_date ?? undefined,
      CustomerRef: { value: customer.Id!, name: customer.DisplayName },
      Line: qboLines,
      PrivateNote: typedInvoice.title ?? undefined,
    }

    const result = existingSync.data?.qbo_id
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

    await markConnectionHealthy(orgId)
    logQBO("info", "invoice_sync_success", { orgId, invoiceId, qboId: result.Id })

    return { success: true, qbo_id: result.Id }
  } catch (err: any) {
    if (err instanceof QBOError && isDuplicateDocNumber(err)) {
      try {
        const lastNumber = await client.getLastInvoiceNumber()
        const nextNumber = incrementInvoiceNumber(lastNumber, null)

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

        const retryResult = existingSync.data?.qbo_id
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
    })
    return { success: false, error: message }
  }
}

export async function enqueueInvoiceSync(invoiceId: string, orgId: string) {
  const supabase = createServiceSupabaseClient()

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

export async function retryFailedQBOSyncJobs(orgId: string) {
  const supabase = createServiceSupabaseClient()
  let retriedInvoices = 0
  let retriedPayments = 0

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

  const { count: failedOutboxCount } = await supabase
    .from("outbox")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .in("job_type", ["qbo_sync_invoice", "qbo_sync_payment"])
    .eq("status", "failed")

  if ((failedOutboxCount ?? 0) > 0) {
    await supabase
      .from("outbox")
      .update({
        status: "pending",
        run_at: new Date().toISOString(),
      })
      .eq("org_id", orgId)
      .in("job_type", ["qbo_sync_invoice", "qbo_sync_payment"])
      .eq("status", "failed")
  }

  return {
    retried_invoices: retriedInvoices,
    retried_payments: retriedPayments,
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

function isDuplicateDocNumber(error: QBOError) {
  const detail = JSON.stringify(error.qboError ?? {}).toLowerCase()
  return detail.includes("docnumber") || detail.includes("duplicate") || detail.includes("already exists")
}
