import { NextRequest, NextResponse } from "next/server"
import { accountingDeliveryDeadline, withAccountingDeadline } from "@/lib/services/accounting-delivery"

import { getProvider, isAccountingProviderKey, listProviders } from "@/lib/integrations/accounting/registry"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { isAuthorizedCronRequest } from "@/lib/services/cron-auth"
import { logAccounting } from "@/lib/services/accounting-logger"
import { withAccountingWorkerCron } from "@/lib/services/accounting-worker"

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

  const deadline = Math.min(Date.now() + 85_000, accountingDeliveryDeadline() ?? Infinity)
  if (Date.now() >= deadline) return NextResponse.json({ connections: 0, scanned: 0, inserted: 0, failedConnections: 0, attempted: 0, deferred: 0, budgetExhausted: true, errorWriteFailures: 0 }, { status: 207 })
  const supabase = createServiceSupabaseClient()
  const { data: connections, error } = await supabase
    .from("accounting_connections")
    .select("id, org_id, provider")
    .eq("status", "active")
    .in("provider", listProviders().filter(provider => provider.capabilities.supportsCDC && provider.ingestChanges).map(provider => provider.key))
    .order("last_inbound_poll_at", { ascending: true, nullsFirst: true })
    .limit(BATCH_SIZE)
    .abortSignal(AbortSignal.timeout(Math.max(1, Math.min(10_000, deadline - Date.now()))))

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  let scanned = 0
  let inserted = 0
  let failedConnections = 0
  let attempted = 0
  let deferred = 0
  let errorWriteFailures = 0
  let recoveryRequired = 0
  let recoveryDeferred = 0
  const recoveryRuns: Array<{ connectionId: string; runId: string | null; reasons: string[]; currentScanComplete: boolean }> = []
  const lookbackMinutes = getManualLookbackMinutes(request)

  for (const connection of connections ?? []) {
    if (!connection.org_id || !isAccountingProviderKey(connection.provider)) continue
    const provider = getProvider(connection.provider)
    const ingestChanges = provider.ingestChanges
    if (!provider.capabilities.supportsCDC || !ingestChanges) continue

    if (Date.now() >= deadline) { deferred += 1; continue }
    attempted += 1
    const connectionDeadline = Math.min(deadline, Date.now() + 10_000)
    try {
      const { error: leaseError } = await supabase
        .from("accounting_connections")
        .update({ last_inbound_poll_at: new Date().toISOString() })
        .eq("org_id", connection.org_id)
        .eq("id", connection.id)
        .abortSignal(AbortSignal.timeout(Math.max(1, connectionDeadline - Date.now())))
      if (leaseError) throw new Error(`Unable to rotate CDC connection: ${leaseError.message}`)
      const result = await withAccountingDeadline(connectionDeadline, () => ingestChanges.call(provider, { connectionId: connection.id, lookbackMinutes }))
      scanned += result.scanned
      inserted += result.inserted
      if (result.recoveryRequired) recoveryRequired += 1
      if (result.deferred) recoveryDeferred += 1
      if (result.recoveryRequired || result.deferred) recoveryRuns.push({ connectionId: connection.id, runId: result.runId ?? null, reasons: result.recoveryReasons ?? [], currentScanComplete: result.currentScanComplete ?? false })
    } catch (cdcError) {
      // A per-connection failure must be VISIBLE, not just a warn log: one
      // org's change feed being down for a month while job_runs stayed green
      // is exactly the failure this loop used to hide. The 207 below makes
      // the run record as failed, and the connection row carries the reason.
      failedConnections += 1
      const message = cdcError instanceof Error ? cdcError.message : String(cdcError)
      logAccounting("warn", "accounting_cdc_failed", {
        provider: connection.provider,
        orgId: connection.org_id,
        connectionId: connection.id,
        error: message,
      })
      if (Date.now() >= deadline) {
        errorWriteFailures += 1
        logAccounting("error", "accounting_cdc_error_write_deferred", { connectionId: connection.id, reason: "deadline" })
        continue
      }
      const { error: writeError } = await supabase
        .from("accounting_connections")
        .update({ last_error: `Change-feed poll failed: ${message}`.slice(0, 4000) })
        .eq("org_id", connection.org_id)
        .eq("id", connection.id)
        .abortSignal(AbortSignal.timeout(Math.max(1, Math.min(5_000, deadline - Date.now()))))
      if (writeError) {
        errorWriteFailures += 1
        logAccounting("error", "accounting_cdc_error_write_failed", { connectionId: connection.id, error: writeError.message })
      }
    }
  }

  return NextResponse.json(
    { connections: connections?.length ?? 0, scanned, inserted, failedConnections, attempted, deferred, budgetExhausted: deferred > 0 || Date.now() >= deadline, errorWriteFailures, recoveryRequired, recoveryDeferred, recoveryRuns },
    { status: failedConnections > 0 || deferred > 0 || recoveryRequired > 0 || recoveryDeferred > 0 || Date.now() >= deadline ? 207 : 200 },
  )
}

export const GET = withAccountingWorkerCron("accounting-process-changes", processAccountingCdc)
export const POST = GET
