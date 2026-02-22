import { randomUUID } from "crypto"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireOrgContext } from "@/lib/services/context"
import { decryptToken, detectInvoiceNumberPattern, encryptToken, refreshAccessToken } from "@/lib/integrations/accounting/qbo-auth"
import { recordEvent } from "@/lib/services/events"
import { logQBO } from "@/lib/services/qbo-logger"

export type QBOConnectionStatus = "active" | "expired" | "disconnected" | "error"
const ACCESS_TOKEN_REFRESH_WINDOW_MS = 10 * 60 * 1000
const KEEPALIVE_REFRESH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000
const MAX_TRANSIENT_REFRESH_FAILURES = 3

type QBOConnectionTokenRow = {
  id: string
  org_id?: string | null
  realm_id: string
  access_token: string
  refresh_token: string
  token_expires_at: string | null
  refresh_token_expires_at?: string | null
  refresh_failure_count?: number | null
  status?: QBOConnectionStatus
}

export interface QBOConnectionSettings {
  auto_sync: boolean
  sync_payments: boolean
  customer_sync_mode: "create_new" | "match_existing"
  default_income_account_id?: string
  invoice_number_sync?: boolean
  invoice_number_pattern?: "numeric" | "prefix" | "custom"
  invoice_number_prefix?: string | null
  last_known_invoice_number?: string | null
}

export interface QBOConnection {
  id: string
  org_id: string
  realm_id: string
  company_name?: string
  status: QBOConnectionStatus
  connected_at: string
  last_sync_at?: string
  last_error?: string | null
  token_expires_at?: string
  refresh_token_expires_at?: string | null
  settings: QBOConnectionSettings
}

function computeRefreshTokenExpiresAt(expiresInSeconds?: number): string | null {
  if (!expiresInSeconds || !Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) {
    return null
  }
  return new Date(Date.now() + expiresInSeconds * 1000).toISOString()
}

function isInvalidGrantRefreshError(error: unknown): boolean {
  const message = String(error ?? "").toLowerCase()
  return (
    message.includes("invalid_grant") ||
    message.includes("invalid refresh token") ||
    message.includes("token revoked") ||
    message.includes("token has expired") ||
    message.includes("revoked")
  )
}

async function refreshConnectionTokens(
  supabase: ReturnType<typeof createServiceSupabaseClient>,
  connection: QBOConnectionTokenRow,
  options: { force: boolean; orgIdForLogs?: string | null; source: "auto" | "manual" | "keepalive" },
): Promise<{ token: string; realmId: string } | null> {
  const expiresAtMs = connection.token_expires_at ? new Date(connection.token_expires_at).getTime() : 0
  const shouldRefresh = options.force || !expiresAtMs || expiresAtMs - Date.now() < ACCESS_TOKEN_REFRESH_WINDOW_MS

  if (!shouldRefresh) {
    return { token: decryptToken(connection.access_token), realmId: connection.realm_id }
  }

  const currentFailureCount = connection.refresh_failure_count ?? 0

  try {
    const newTokens = await refreshAccessToken(decryptToken(connection.refresh_token))
    const refreshTokenExpiresAt = computeRefreshTokenExpiresAt(newTokens.x_refresh_token_expires_in)
    const encryptedAccessToken = encryptToken(newTokens.access_token)
    const encryptedRefreshToken = encryptToken(newTokens.refresh_token)

    const { data: updatedRow, error: updateError } = await supabase
      .from("qbo_connections")
      .update({
        access_token: encryptedAccessToken,
        refresh_token: encryptedRefreshToken,
        token_expires_at: new Date(Date.now() + newTokens.expires_in * 1000).toISOString(),
        refresh_token_expires_at: refreshTokenExpiresAt,
        refresh_failure_count: 0,
        status: "active",
        last_error: null,
      })
      .eq("id", connection.id)
      .eq("status", "active")
      .eq("refresh_token", connection.refresh_token)
      .select("id")
      .maybeSingle()

    if (updateError) {
      throw new Error(updateError.message)
    }

    if (!updatedRow) {
      const { data: latest, error: latestError } = await supabase
        .from("qbo_connections")
        .select("access_token, realm_id, status")
        .eq("id", connection.id)
        .maybeSingle()

      if (latestError || !latest || latest.status !== "active") {
        return null
      }

      return { token: decryptToken(latest.access_token), realmId: latest.realm_id }
    }

    return { token: newTokens.access_token, realmId: connection.realm_id }
  } catch (error) {
    const invalidGrant = isInvalidGrantRefreshError(error)
    const nextFailureCount = currentFailureCount + 1
    const shouldExpire = invalidGrant || nextFailureCount >= MAX_TRANSIENT_REFRESH_FAILURES
    const errorMessage = String(error ?? "Token refresh failed").slice(0, 500)

    await supabase
      .from("qbo_connections")
      .update({
        status: shouldExpire ? "expired" : "active",
        refresh_failure_count: nextFailureCount,
        last_error: errorMessage,
      })
      .eq("id", connection.id)
      .eq("status", "active")

    logQBO(shouldExpire ? "error" : "warn", "token_refresh_failed", {
      orgId: options.orgIdForLogs ?? connection.org_id,
      connectionId: connection.id,
      source: options.source,
      invalidGrant,
      failureCount: nextFailureCount,
      error: errorMessage,
    })

    if (!options.force && Number.isFinite(expiresAtMs) && expiresAtMs > Date.now() + 60 * 1000) {
      return { token: decryptToken(connection.access_token), realmId: connection.realm_id }
    }

    return null
  }
}

export async function getQBOConnection(orgId?: string): Promise<QBOConnection | null> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("qbo_connections")
    .select(
      "id, org_id, realm_id, company_name, status, connected_at, last_sync_at, last_error, token_expires_at, refresh_token_expires_at, settings",
    )
    .eq("org_id", resolvedOrgId)
    .eq("status", "active")
    .maybeSingle()

  if (error || !data) return null
  return data as QBOConnection
}

export async function getQBOAccessToken(
  orgId: string,
): Promise<{ token: string; realmId: string } | null> {
  const supabase = createServiceSupabaseClient()

  const { data: connection, error } = await supabase
    .from("qbo_connections")
    .select("id, org_id, realm_id, access_token, refresh_token, token_expires_at, refresh_token_expires_at, refresh_failure_count")
    .eq("org_id", orgId)
    .eq("status", "active")
    .single()

  if (error || !connection) return null
  return refreshConnectionTokens(supabase, connection as QBOConnectionTokenRow, {
    force: false,
    orgIdForLogs: orgId,
    source: "auto",
  })
}

export async function disconnectQBO(orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const { error } = await supabase
    .from("qbo_connections")
    .update({
      status: "disconnected",
      disconnected_at: new Date().toISOString(),
    })
    .eq("org_id", resolvedOrgId)
    .eq("status", "active")

  if (error) throw new Error(`Failed to disconnect QBO: ${error.message}`)

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "qbo_disconnected",
    entityType: "integration",
    entityId: resolvedOrgId,
    payload: { disconnected_by: userId },
  })
}

export async function updateQBOSettings(settings: Partial<QBOConnectionSettings>, orgId?: string) {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data: current } = await supabase
    .from("qbo_connections")
    .select("settings")
    .eq("org_id", resolvedOrgId)
    .eq("status", "active")
    .single()

  if (!current) throw new Error("No active QBO connection")

  const nextSettings = { ...(current.settings as QBOConnectionSettings), ...settings }

  const { error } = await supabase
    .from("qbo_connections")
    .update({
      settings: nextSettings,
    })
    .eq("org_id", resolvedOrgId)
    .eq("status", "active")

  if (error) throw new Error(`Failed to update QBO settings: ${error.message}`)
}

export async function refreshQBOTokenNow(orgId?: string) {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  const service = createServiceSupabaseClient()

  const { data: connection, error } = await supabase
    .from("qbo_connections")
    .select("id, org_id, realm_id, access_token, refresh_token, token_expires_at, refresh_token_expires_at, refresh_failure_count")
    .eq("org_id", resolvedOrgId)
    .eq("status", "active")
    .maybeSingle()

  if (error || !connection) {
    throw new Error("No active QBO connection")
  }

  const refreshed = await refreshConnectionTokens(service, connection as QBOConnectionTokenRow, {
    force: true,
    orgIdForLogs: resolvedOrgId,
    source: "manual",
  })

  if (refreshed) {
    logQBO("info", "token_refresh_manual_success", { orgId: resolvedOrgId, connectionId: connection.id })
    return { success: true }
  }

  throw new Error("Manual token refresh failed")
}

export async function getQBODiagnostics(orgId?: string) {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const [connectionResult, pendingOutboxResult, failedOutboxResult, failedInvoicesResult] = await Promise.all([
    supabase
      .from("qbo_connections")
      .select("id, status, token_expires_at, refresh_token_expires_at, refresh_failure_count, last_sync_at, last_error, company_name")
      .eq("org_id", resolvedOrgId)
      .eq("status", "active")
      .maybeSingle(),
    supabase
      .from("outbox")
      .select("id", { count: "exact", head: true })
      .eq("org_id", resolvedOrgId)
      .in("job_type", ["qbo_sync_invoice", "qbo_sync_payment"])
      .in("status", ["pending", "processing"]),
    supabase
      .from("outbox")
      .select("id, job_type, last_error, updated_at", { count: "exact" })
      .eq("org_id", resolvedOrgId)
      .in("job_type", ["qbo_sync_invoice", "qbo_sync_payment"])
      .eq("status", "failed")
      .order("updated_at", { ascending: false })
      .limit(5),
    supabase
      .from("invoices")
      .select("id", { count: "exact", head: true })
      .eq("org_id", resolvedOrgId)
      .eq("qbo_sync_status", "error"),
  ])

  return {
    connection: connectionResult.data
      ? {
          id: connectionResult.data.id,
          status: connectionResult.data.status,
          company_name: connectionResult.data.company_name,
          token_expires_at: connectionResult.data.token_expires_at,
          refresh_token_expires_at: connectionResult.data.refresh_token_expires_at,
          refresh_failure_count: connectionResult.data.refresh_failure_count,
          last_sync_at: connectionResult.data.last_sync_at,
          last_error: connectionResult.data.last_error,
        }
      : null,
    outbox: {
      pending_or_processing: pendingOutboxResult.count ?? 0,
      failed: failedOutboxResult.count ?? 0,
      recent_failures: (failedOutboxResult.data ?? []).map((row) => ({
        job_type: row.job_type,
        last_error: row.last_error,
        updated_at: row.updated_at,
      })),
    },
    invoices: {
      failed_sync_count: failedInvoicesResult.count ?? 0,
    },
  }
}

export async function upsertQBOConnection(input: {
  orgId: string
  realmId: string
  accessToken: string
  refreshToken: string
  expiresInSeconds: number
  refreshTokenExpiresInSeconds?: number
  connectedBy?: string
  companyName?: string
}) {
  const supabase = createServiceSupabaseClient()
  let settings: {
    invoice_number_pattern: "numeric" | "prefix" | "custom"
    invoice_number_prefix: string | null
    last_known_invoice_number: string | null
  } = {
    invoice_number_pattern: "numeric",
    invoice_number_prefix: null,
    last_known_invoice_number: null,
  }

  try {
    settings = await detectInvoiceNumberPattern(input.accessToken, input.realmId)
  } catch (err) {
    console.warn("Unable to detect QBO invoice pattern, defaulting to numeric", err)
  }

  // Deactivate any existing connections for this org
  await supabase
    .from("qbo_connections")
    .update({ status: "disconnected", disconnected_at: new Date().toISOString() })
    .eq("org_id", input.orgId)
    .eq("status", "active")

  const { data, error } = await supabase
    .from("qbo_connections")
    .insert({
      org_id: input.orgId,
      realm_id: input.realmId,
      access_token: encryptToken(input.accessToken),
      refresh_token: encryptToken(input.refreshToken),
      token_expires_at: new Date(Date.now() + input.expiresInSeconds * 1000).toISOString(),
      refresh_token_expires_at: computeRefreshTokenExpiresAt(input.refreshTokenExpiresInSeconds),
      refresh_failure_count: 0,
      company_name: input.companyName,
      connected_by: input.connectedBy ?? null,
      status: "active",
      settings: {
        auto_sync: true,
        sync_payments: true,
        customer_sync_mode: "create_new",
        invoice_number_sync: true,
        invoice_number_pattern: settings.invoice_number_pattern,
        invoice_number_prefix: settings.invoice_number_prefix,
        last_known_invoice_number: settings.last_known_invoice_number,
      },
    })
    .select("id")
    .single()

  if (error) {
    throw new Error(`Failed to save QBO connection: ${error.message}`)
  }

  try {
    await recordEvent({
      orgId: input.orgId,
      eventType: "qbo_connected",
      entityType: "integration",
      entityId: input.orgId,
      payload: {
        company_name: input.companyName,
        connection_id: data?.id ?? randomUUID(),
      },
      channel: "integration",
    })
  } catch (eventError) {
    console.error("Failed to record QBO connection event", eventError)
  }
}

export async function refreshQBOConnectionsDueForKeepalive(limit = 10) {
  const supabase = createServiceSupabaseClient()
  const keepaliveHorizonIso = new Date(Date.now() + KEEPALIVE_REFRESH_WINDOW_MS).toISOString()

  const { data: candidates, error } = await supabase
    .from("qbo_connections")
    .select("id, org_id, realm_id, access_token, refresh_token, token_expires_at, refresh_token_expires_at, refresh_failure_count")
    .eq("status", "active")
    .order("updated_at", { ascending: true })
    .limit(Math.max(limit * 5, 25))

  if (error || !candidates?.length) {
    return { scanned: 0, refreshed: 0, failed: 0 }
  }

  const due = (candidates as QBOConnectionTokenRow[]).filter((connection) => {
    if (!connection.refresh_token_expires_at) return true
    const expiresAt = Date.parse(connection.refresh_token_expires_at)
    if (!Number.isFinite(expiresAt)) return true
    return expiresAt <= Date.parse(keepaliveHorizonIso)
  })

  const selected = due.slice(0, limit)
  let refreshed = 0
  let failed = 0

  for (const connection of selected) {
    const result = await refreshConnectionTokens(supabase, connection, {
      force: true,
      orgIdForLogs: connection.org_id,
      source: "keepalive",
    })
    if (result) {
      refreshed += 1
    } else {
      failed += 1
    }
  }

  return { scanned: selected.length, refreshed, failed }
}
