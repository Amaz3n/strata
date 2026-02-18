import { NextRequest, NextResponse } from "next/server"

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

export async function POST(request: NextRequest) {
  const auth = request.headers.get("x-cron-secret")
  if (!CRON_SECRET || auth !== CRON_SECRET) {
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

  for (const row of rows) {
    try {
      if (!row.realm_id || !row.entity_name || !row.entity_qbo_id) {
        await markEventProcessed(supabase, row.id, "ignored", "Missing webhook context")
        processed += 1
        continue
      }

      const { data: connection } = await supabase
        .from("qbo_connections")
        .select("org_id")
        .eq("realm_id", row.realm_id)
        .eq("status", "active")
        .maybeSingle()

      if (!connection?.org_id) {
        await markEventProcessed(supabase, row.id, "ignored", "No active org connection for realm")
        processed += 1
        continue
      }

      const entityName = row.entity_name.toLowerCase()
      const orgId = connection.org_id as string

      if (entityName === "invoice") {
        const { data: invoiceSync } = await supabase
          .from("qbo_sync_records")
          .select("entity_id")
          .eq("org_id", orgId)
          .eq("entity_type", "invoice")
          .eq("qbo_id", row.entity_qbo_id)
          .maybeSingle()

        if (invoiceSync?.entity_id) {
          await supabase
            .from("invoices")
            .update({
              qbo_id: row.entity_qbo_id,
              qbo_sync_status: "synced",
              qbo_synced_at: new Date().toISOString(),
            })
            .eq("org_id", orgId)
            .eq("id", invoiceSync.entity_id)

          await supabase
            .from("qbo_sync_records")
            .update({
              status: "synced",
              error_message: null,
              last_synced_at: new Date().toISOString(),
            })
            .eq("org_id", orgId)
            .eq("entity_type", "invoice")
            .eq("entity_id", invoiceSync.entity_id)

          reconciled += 1
          await markEventProcessed(supabase, row.id, "reconciled")
        } else {
          await markEventProcessed(supabase, row.id, "ignored", "No local invoice sync record")
        }
      } else if (entityName === "payment") {
        const { data: paymentSync } = await supabase
          .from("qbo_sync_records")
          .select("entity_id")
          .eq("org_id", orgId)
          .eq("entity_type", "payment")
          .eq("qbo_id", row.entity_qbo_id)
          .maybeSingle()

        if (paymentSync?.entity_id) {
          await supabase
            .from("qbo_sync_records")
            .update({
              status: "synced",
              error_message: null,
              last_synced_at: new Date().toISOString(),
            })
            .eq("org_id", orgId)
            .eq("entity_type", "payment")
            .eq("entity_id", paymentSync.entity_id)

          reconciled += 1
          await markEventProcessed(supabase, row.id, "reconciled")
        } else {
          await markEventProcessed(supabase, row.id, "ignored", "No local payment sync record")
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
