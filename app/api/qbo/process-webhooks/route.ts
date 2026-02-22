import { NextRequest, NextResponse } from "next/server"

import type { QBOClient, QBOPaymentSnapshot } from "@/lib/integrations/accounting/qbo-api"
import { QBOClient as QBOClientFactory } from "@/lib/integrations/accounting/qbo-api"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { logQBO } from "@/lib/services/qbo-logger"

const CRON_SECRET = process.env.CRON_SECRET
const BATCH_SIZE = 50

type WebhookEventRow = {
  id: string
  event_id: string
  realm_id: string | null
  entity_name: string | null
  entity_qbo_id: string | null
  operation: string | null
}

type ActiveConnection = {
  id: string
  org_id: string
}

function isAuthorizedCronRequest(request: NextRequest) {
  const isDev = process.env.NODE_ENV !== "production"
  if (isDev) return true

  const authHeader = request.headers.get("authorization") ?? request.headers.get("Authorization")
  const bearer = typeof authHeader === "string" ? authHeader.trim() : ""
  const legacyHeader = request.headers.get("x-cron-secret")
  const isVercelCron = request.headers.get("x-vercel-cron") === "1"

  const secretOk =
    (!!CRON_SECRET && bearer === `Bearer ${CRON_SECRET}`) ||
    (!!CRON_SECRET && legacyHeader === CRON_SECRET)

  if (CRON_SECRET) return secretOk
  return isVercelCron
}

function toCents(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value * 100)
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return Math.round(parsed * 100)
  }
  return null
}

function normalizeDate(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toISOString().split("T")[0]
}

function isPastDue(dateIso: string | null) {
  if (!dateIso) return false
  const due = new Date(dateIso)
  if (Number.isNaN(due.getTime())) return false
  due.setHours(0, 0, 0, 0)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return due < today
}

function deriveInvoiceStatusFromQbo(params: {
  operation?: string | null
  totalCents: number | null
  balanceCents: number | null
  dueDate: string | null
}) {
  const operation = String(params.operation ?? "").toLowerCase()
  if (operation === "delete") return "void"

  const total = params.totalCents ?? 0
  const balance = params.balanceCents ?? total

  if (total > 0 && balance <= 0) return "paid"
  if (total > 0 && balance > 0 && balance < total) return "partial"
  if (balance > 0 && isPastDue(params.dueDate)) return "overdue"
  return "sent"
}

async function resolveLocalInvoiceIdByQboId(
  supabase: ReturnType<typeof createServiceSupabaseClient>,
  orgId: string,
  qboInvoiceId: string,
) {
  const { data: invoiceSync } = await supabase
    .from("qbo_sync_records")
    .select("entity_id")
    .eq("org_id", orgId)
    .eq("entity_type", "invoice")
    .eq("qbo_id", qboInvoiceId)
    .maybeSingle()

  if (invoiceSync?.entity_id) return invoiceSync.entity_id as string

  const { data: invoiceRow } = await supabase
    .from("invoices")
    .select("id")
    .eq("org_id", orgId)
    .eq("qbo_id", qboInvoiceId)
    .maybeSingle()

  return (invoiceRow?.id as string | undefined) ?? null
}

async function upsertInvoiceSyncRecord(params: {
  supabase: ReturnType<typeof createServiceSupabaseClient>
  orgId: string
  connectionId: string
  invoiceId: string
  qboInvoiceId: string
  qboSyncToken?: string | null
}) {
  const nowIso = new Date().toISOString()

  await params.supabase.from("qbo_sync_records").upsert(
    {
      org_id: params.orgId,
      connection_id: params.connectionId,
      entity_type: "invoice",
      entity_id: params.invoiceId,
      qbo_id: params.qboInvoiceId,
      qbo_sync_token: params.qboSyncToken ?? null,
      last_synced_at: nowIso,
      status: "synced",
      error_message: null,
    },
    { onConflict: "org_id,entity_type,entity_id" },
  )
}

async function reconcileInvoiceFromQbo(params: {
  supabase: ReturnType<typeof createServiceSupabaseClient>
  client: QBOClient
  orgId: string
  connectionId: string
  qboInvoiceId: string
  operation?: string | null
}) {
  const nowIso = new Date().toISOString()
  const invoiceId = await resolveLocalInvoiceIdByQboId(params.supabase, params.orgId, params.qboInvoiceId)
  if (!invoiceId) {
    return { reconciled: false as const, reason: "No local invoice mapping" }
  }

  const normalizedOp = String(params.operation ?? "").toLowerCase()
  if (normalizedOp === "delete") {
    const { error: updateError } = await params.supabase
      .from("invoices")
      .update({
        status: "void",
        balance_due_cents: 0,
        qbo_id: params.qboInvoiceId,
        qbo_sync_status: "synced",
        qbo_synced_at: nowIso,
      })
      .eq("org_id", params.orgId)
      .eq("id", invoiceId)

    if (updateError) {
      return { reconciled: false as const, reason: updateError.message }
    }

    await upsertInvoiceSyncRecord({
      supabase: params.supabase,
      orgId: params.orgId,
      connectionId: params.connectionId,
      invoiceId,
      qboInvoiceId: params.qboInvoiceId,
    })
    return { reconciled: true as const }
  }

  const qboInvoice = await params.client.getInvoiceById(params.qboInvoiceId)
  if (!qboInvoice) {
    return { reconciled: false as const, reason: "QBO invoice not found" }
  }

  const totalCents = toCents(qboInvoice.TotalAmt)
  const balanceCents = toCents(qboInvoice.Balance)
  const dueDate = normalizeDate(qboInvoice.DueDate)
  const issueDate = normalizeDate(qboInvoice.TxnDate)
  const nextStatus = deriveInvoiceStatusFromQbo({
    operation: params.operation,
    totalCents,
    balanceCents,
    dueDate,
  })

  const invoiceUpdate: Record<string, unknown> = {
    qbo_id: params.qboInvoiceId,
    qbo_sync_status: "synced",
    qbo_synced_at: nowIso,
    status: nextStatus,
  }

  if (typeof qboInvoice.DocNumber === "string" && qboInvoice.DocNumber.trim().length > 0) {
    invoiceUpdate.invoice_number = qboInvoice.DocNumber.trim()
  }
  if (issueDate) invoiceUpdate.issue_date = issueDate
  if (dueDate) invoiceUpdate.due_date = dueDate
  if (totalCents !== null) invoiceUpdate.total_cents = totalCents
  if (balanceCents !== null) invoiceUpdate.balance_due_cents = Math.max(balanceCents, 0)

  const { error: updateError } = await params.supabase
    .from("invoices")
    .update(invoiceUpdate)
    .eq("org_id", params.orgId)
    .eq("id", invoiceId)

  if (updateError) {
    return { reconciled: false as const, reason: updateError.message }
  }

  await upsertInvoiceSyncRecord({
    supabase: params.supabase,
    orgId: params.orgId,
    connectionId: params.connectionId,
    invoiceId,
    qboInvoiceId: params.qboInvoiceId,
    qboSyncToken: qboInvoice.SyncToken ?? null,
  })

  return { reconciled: true as const }
}

function extractLinkedInvoiceQboIds(payment: QBOPaymentSnapshot | null) {
  const invoiceQboIds = new Set<string>()
  for (const line of payment?.Line ?? []) {
    for (const linkedTxn of line.LinkedTxn ?? []) {
      if (String(linkedTxn.TxnType ?? "").toLowerCase() !== "invoice") continue
      if (!linkedTxn.TxnId) continue
      invoiceQboIds.add(String(linkedTxn.TxnId))
    }
  }
  return Array.from(invoiceQboIds)
}

export async function POST(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const supabase = createServiceSupabaseClient()
  const { data: events, error } = await supabase
    .from("qbo_webhook_events")
    .select("id, event_id, realm_id, entity_name, entity_qbo_id, operation")
    .eq("process_status", "pending")
    .order("received_at", { ascending: true })
    .limit(BATCH_SIZE)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const rows = (events ?? []) as WebhookEventRow[]
  if (rows.length === 0) {
    return NextResponse.json({ processed: 0, reconciled: 0 })
  }

  let reconciled = 0
  let processed = 0
  const clientsByOrgId = new Map<string, QBOClient | null>()

  for (const row of rows) {
    try {
      if (!row.realm_id || !row.entity_name || !row.entity_qbo_id) {
        await markEventProcessed(supabase, row.id, "ignored", "Missing webhook context")
        processed += 1
        continue
      }

      const { data: connection } = await supabase
        .from("qbo_connections")
        .select("id, org_id")
        .eq("realm_id", row.realm_id)
        .eq("status", "active")
        .maybeSingle()

      const typedConnection = connection as ActiveConnection | null
      if (!typedConnection?.org_id || !typedConnection?.id) {
        await markEventProcessed(supabase, row.id, "ignored", "No active org connection for realm")
        processed += 1
        continue
      }

      const entityName = row.entity_name.toLowerCase()
      const orgId = typedConnection.org_id
      let client = clientsByOrgId.get(orgId)
      if (client === undefined) {
        client = await QBOClientFactory.forOrg(orgId)
        clientsByOrgId.set(orgId, client)
      }

      if (!client) {
        await markEventProcessed(supabase, row.id, "error", "Unable to initialize QBO client")
        processed += 1
        continue
      }

      if (entityName === "invoice") {
        const result = await reconcileInvoiceFromQbo({
          supabase,
          client,
          orgId,
          connectionId: typedConnection.id,
          qboInvoiceId: row.entity_qbo_id,
          operation: row.operation,
        })

        if (result.reconciled) {
          reconciled += 1
          await markEventProcessed(supabase, row.id, "reconciled")
        } else {
          await markEventProcessed(supabase, row.id, "ignored", result.reason)
        }
      } else if (entityName === "payment") {
        const normalizedOperation = String(row.operation ?? "").toLowerCase()
        const payment = normalizedOperation === "delete" ? null : await client.getPaymentById(row.entity_qbo_id)
        let linkedInvoiceQboIds = extractLinkedInvoiceQboIds(payment)

        if (linkedInvoiceQboIds.length === 0) {
          const { data: paymentSync } = await supabase
            .from("qbo_sync_records")
            .select("entity_id")
            .eq("org_id", orgId)
            .eq("entity_type", "payment")
            .eq("qbo_id", row.entity_qbo_id)
            .maybeSingle()

          if (paymentSync?.entity_id) {
            const { data: paymentRow } = await supabase
              .from("payments")
              .select("invoice:invoices(qbo_id)")
              .eq("org_id", orgId)
              .eq("id", paymentSync.entity_id)
              .maybeSingle()
            const invoice = Array.isArray((paymentRow as any)?.invoice)
              ? (paymentRow as any).invoice[0]
              : (paymentRow as any)?.invoice
            if (typeof invoice?.qbo_id === "string" && invoice.qbo_id.length > 0) {
              linkedInvoiceQboIds = [invoice.qbo_id]
            }
          }
        }

        if (linkedInvoiceQboIds.length === 0) {
          await markEventProcessed(supabase, row.id, "ignored", "No linked invoice found for payment")
          processed += 1
          continue
        }

        let reconciledInvoices = 0
        for (const invoiceQboId of linkedInvoiceQboIds) {
          const result = await reconcileInvoiceFromQbo({
            supabase,
            client,
            orgId,
            connectionId: typedConnection.id,
            qboInvoiceId: invoiceQboId,
          })
          if (result.reconciled) reconciledInvoices += 1
        }

        await supabase
          .from("qbo_sync_records")
          .update({
            status: "synced",
            error_message: null,
            last_synced_at: new Date().toISOString(),
          })
          .eq("org_id", orgId)
          .eq("entity_type", "payment")
          .eq("qbo_id", row.entity_qbo_id)

        if (reconciledInvoices > 0) {
          reconciled += 1
          await markEventProcessed(supabase, row.id, "reconciled")
        } else {
          await markEventProcessed(supabase, row.id, "ignored", "Payment event had no local invoice to reconcile")
        }
      } else {
        await markEventProcessed(supabase, row.id, "ignored", `Entity ${row.entity_name} not handled`)
      }

      processed += 1
    } catch (eventError: any) {
      await markEventProcessed(supabase, row.id, "error", eventError?.message ?? "Webhook processing failed")
      processed += 1
    }
  }

  logQBO("info", "process_webhooks_complete", { processed, reconciled })
  return NextResponse.json({ processed, reconciled })
}

async function markEventProcessed(
  supabase: ReturnType<typeof createServiceSupabaseClient>,
  eventId: string,
  status: "reconciled" | "ignored" | "error",
  error?: string,
) {
  await supabase
    .from("qbo_webhook_events")
    .update({
      process_status: status,
      process_error: error ?? null,
      processed_at: new Date().toISOString(),
    })
    .eq("id", eventId)
}

export const runtime = "nodejs"
