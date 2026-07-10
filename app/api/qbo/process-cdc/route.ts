import { createHash } from "crypto"
import { NextRequest, NextResponse } from "next/server"

import { QBOClient } from "@/lib/integrations/accounting/qbo-api"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { logQBO } from "@/lib/services/qbo-logger"
import { withCronRun } from "@/lib/services/job-runs"

const CRON_SECRET = process.env.CRON_SECRET
const CDC_ENTITIES = ["Invoice", "Payment", "Purchase", "Bill", "BillPayment"]
const BATCH_SIZE = 10
const CDC_OVERLAP_MINUTES = 5
const MAX_MANUAL_LOOKBACK_MINUTES = 24 * 60

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

function getChangedRows(payload: any) {
  const response = payload?.CDCResponse?.[0]?.QueryResponse ?? []
  const rows: Array<{ entityName: string; id: string; lastUpdated: string }> = []
  for (const queryResponse of response) {
    for (const entityName of CDC_ENTITIES) {
      const entities = queryResponse?.[entityName]
      if (!Array.isArray(entities)) continue
      for (const entity of entities) {
        if (!entity?.Id) continue
        rows.push({
          entityName,
          id: String(entity.Id),
          lastUpdated: String(entity.MetaData?.LastUpdatedTime ?? new Date().toISOString()),
        })
      }
    }
  }
  return rows
}

function getManualLookbackMinutes(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get("lookback_minutes")
  if (!raw) return null
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return Math.min(Math.floor(parsed), MAX_MANUAL_LOOKBACK_MINUTES)
}

async function processQBOCdc(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const supabase = createServiceSupabaseClient()
  const { data: connections, error } = await supabase
    .from("qbo_connections")
    .select("id, org_id, realm_id, settings")
    .eq("status", "active")
    .limit(BATCH_SIZE)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  let scanned = 0
  let inserted = 0
  const nowIso = new Date().toISOString()
  const manualLookbackMinutes = getManualLookbackMinutes(request)

  for (const connection of connections ?? []) {
    const orgId = connection.org_id as string | null
    if (!orgId) continue

    const settings = (connection.settings as Record<string, any> | null) ?? {}
    const cursor =
      manualLookbackMinutes !== null
        ? Date.now() - manualLookbackMinutes * 60 * 1000
        : typeof settings.qbo_cdc_last_synced_at === "string"
        ? new Date(settings.qbo_cdc_last_synced_at).getTime()
        : Date.now() - 24 * 60 * 60 * 1000
    const changedSince = new Date(cursor - CDC_OVERLAP_MINUTES * 60 * 1000).toISOString()

    try {
      const client = await QBOClient.forOrg(orgId)
      if (!client) continue
      const payload = await client.changeDataCapture(CDC_ENTITIES, changedSince)
      const rows = getChangedRows(payload)
      scanned += rows.length

      for (const row of rows) {
        const eventId = `cdc:${connection.realm_id}:${row.entityName}:${row.id}:${row.lastUpdated}`
        const payloadHash = createHash("sha256").update(eventId).digest("hex")
        const { error: insertError } = await supabase.from("qbo_webhook_events").upsert({
          event_id: eventId,
          payload_hash: payloadHash,
          realm_id: connection.realm_id,
          entity_name: row.entityName,
          entity_qbo_id: row.id,
          operation: "cdc",
          last_updated: new Date(row.lastUpdated).toISOString(),
          received_at: nowIso,
          process_status: "pending",
          process_error: null,
          processed_at: null,
        }, {
          onConflict: "event_id",
        })
        if (!insertError) inserted += 1
      }

      await supabase
        .from("qbo_connections")
        .update({
          settings: {
            ...settings,
            qbo_cdc_last_synced_at: nowIso,
          },
        })
        .eq("id", connection.id)
    } catch (cdcError: any) {
      logQBO("warn", "qbo_cdc_failed", {
        orgId,
        connectionId: connection.id,
        error: cdcError?.message ?? String(cdcError),
      })
    }
  }

  return NextResponse.json({ connections: connections?.length ?? 0, scanned, inserted })
}

export const GET = withCronRun("qbo-process-cdc", processQBOCdc)
export const POST = GET

export const runtime = "nodejs"
