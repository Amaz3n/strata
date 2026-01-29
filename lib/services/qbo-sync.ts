import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { QBOClient, QBOError } from "@/lib/integrations/accounting/qbo-api"
import { enqueueOutboxJob } from "@/lib/services/outbox"
import { incrementInvoiceNumber } from "@/lib/services/invoice-numbers"
import { recordEvent } from "@/lib/services/events"

interface InvoiceLineRow {
  description: string
  quantity: number
  unit_price_cents: number
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
    return { success: false, error: "No active QBO connection" }
  }

  const { data: invoice, error } = await supabase
    .from("invoices")
    .select(
      "id, org_id, project_id, invoice_number, issue_date, due_date, total_cents, balance_due_cents, title, status, metadata, invoice_lines (description, quantity, unit_price_cents)",
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

  let existingSync: any = null
  let qboInvoice: any = null

  try {
    const customer = await client.getOrCreateCustomer(resolveCustomerName(typedInvoice))
    const defaultItem = await client.getDefaultServiceItem()

    existingSync = await supabase
      .from("qbo_sync_records")
      .select("qbo_id, qbo_sync_token")
      .eq("org_id", orgId)
      .eq("entity_type", "invoice")
      .eq("entity_id", invoiceId)
      .maybeSingle()

    qboInvoice = {
      Id: existingSync.data?.qbo_id,
      SyncToken: existingSync.data?.qbo_sync_token,
      DocNumber: typedInvoice.invoice_number,
      TxnDate: typedInvoice.issue_date ?? new Date().toISOString().split("T")[0],
      DueDate: typedInvoice.due_date ?? undefined,
      CustomerRef: { value: customer.Id!, name: customer.DisplayName },
      Line: (typedInvoice.lines ?? []).map((line) => ({
        DetailType: "SalesItemLineDetail" as const,
        Amount: (line.quantity * line.unit_price_cents) / 100,
        Description: line.description,
        SalesItemLineDetail: {
          ItemRef: defaultItem,
          Qty: line.quantity,
          UnitPrice: line.unit_price_cents / 100,
        },
      })),
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
        await supabase.from("invoices").update({ qbo_sync_status: "error" }).eq("id", invoiceId)
        return { success: false, error: retryError?.message ?? "DocNumber conflict" }
      }
    }

    const errorMessage = err instanceof QBOError ? err.message : String(err)
    await supabase.from("invoices").update({ qbo_sync_status: "error" }).eq("id", invoiceId)
    return { success: false, error: errorMessage }
  }
}

export async function syncPaymentToQBO(paymentId: string, orgId: string) {
  const supabase = createServiceSupabaseClient()
  const client = await QBOClient.forOrg(orgId)
  if (!client) return { success: false, error: "No active QBO connection" }

  const { data: payment, error } = await supabase
    .from("payments")
    .select(
      "id, org_id, invoice_id, amount_cents, provider, method, metadata, invoice:invoices(qbo_id, org_id, project_id)",
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
        const cust = await client.getOrCreateCustomer("Customer")
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

  return { success: true, qbo_id: qboPayment.Id }
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
  })
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
      },
      { onConflict: "org_id,entity_type,entity_id" },
    )
}

function resolveCustomerName(invoice: InvoiceForSync) {
  const title = invoice.title?.trim()
  if (title) return title
  return "Customer"
}

function isDuplicateDocNumber(error: QBOError) {
  const detail = JSON.stringify(error.qboError ?? {}).toLowerCase()
  return detail.includes("docnumber") || detail.includes("duplicate") || detail.includes("already exists")
}
