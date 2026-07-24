import { NextRequest, NextResponse } from "next/server"

import { getProvider, isAccountingProviderKey } from "@/lib/integrations/accounting/registry"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { isAuthorizedCronRequest } from "@/lib/services/cron-auth"
import { logAccounting } from "@/lib/services/accounting-logger"
import { withCronRun } from "@/lib/services/job-runs"

const BATCH_SIZE = 10
const MAX_MANUAL_LOOKBACK_MINUTES = 24 * 60

function getManualLookbackMinutes(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get("lookback_minutes")
  if (!raw) return null
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return Math.min(Math.floor(parsed), MAX_MANUAL_LOOKBACK_MINUTES)
}

async function processAccountingCdc(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const supabase = createServiceSupabaseClient()
  const { data: connections, error } = await supabase
    .from("accounting_connections")
    .select("id, org_id, provider")
    .eq("status", "active")
    .order("last_inbound_poll_at", { ascending: true, nullsFirst: true })
    .limit(BATCH_SIZE)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  let scanned = 0
  let inserted = 0
  const lookbackMinutes = getManualLookbackMinutes(request)

  for (const connection of connections ?? []) {
    if (!connection.org_id || !isAccountingProviderKey(connection.provider)) continue
    const provider = getProvider(connection.provider)
    if (!provider.capabilities.supportsCDC || !provider.ingestChanges) continue

    try {
      const { error: leaseError } = await supabase
        .from("accounting_connections")
        .update({ last_inbound_poll_at: new Date().toISOString() })
        .eq("org_id", connection.org_id)
        .eq("id", connection.id)
      if (leaseError) throw new Error(`Unable to rotate CDC connection: ${leaseError.message}`)
      const result = await provider.ingestChanges({ connectionId: connection.id, lookbackMinutes })
      scanned += result.scanned
      inserted += result.inserted
    } catch (cdcError) {
      logAccounting("warn", "accounting_cdc_failed", {
        provider: connection.provider,
        orgId: connection.org_id,
        connectionId: connection.id,
        error: cdcError instanceof Error ? cdcError.message : String(cdcError),
      })
    }
  }

  return NextResponse.json({ connections: connections?.length ?? 0, scanned, inserted })
}

export const GET = withCronRun("accounting-process-changes", processAccountingCdc)
export const POST = GET

export const runtime = "nodejs"
