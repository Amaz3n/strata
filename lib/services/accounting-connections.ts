import { randomUUID } from "crypto"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireOrgContext } from "@/lib/services/context"
import { decryptToken, detectInvoiceNumberPattern, encryptToken, getQBOClientId, refreshAccessToken, revokeQBOToken } from "@/lib/integrations/accounting/qbo/auth"
import { recordEvent } from "@/lib/services/events"
import { logQBO } from "@/lib/services/accounting-logger"
import { hasExplicitQboSandboxSetting, isQboSandbox, qboApiBaseUrl, qboEnvironmentLabel } from "@/lib/integrations/accounting/qbo/config"

export type QBOConnectionStatus = "active" | "expired" | "disconnected" | "error"
const ACCESS_TOKEN_REFRESH_WINDOW_MS = 10 * 60 * 1000
const KEEPALIVE_REFRESH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000
const MAX_TRANSIENT_REFRESH_FAILURES = 3

type QBOConnectionTokenRow = {
  id: string
  org_id?: string | null
  external_account_id: string
  access_token: string
  refresh_token: string
  token_expires_at: string | null
  refresh_token_expires_at?: string | null
  refresh_failure_count?: number | null
  status?: QBOConnectionStatus
  client_id?: string | null
}

export interface QBOConnectionSettings {
  auto_sync: boolean
  sync_payments: boolean
  customer_sync_mode: "create_new" | "match_existing"
  default_income_account_id?: string
  default_expense_account_id?: string
  default_payment_account_id?: string
  default_credit_card_account_id?: string
  default_ap_account_id?: string
  project_mapping_mode?: "customer" | "sub_customer"
  invoice_number_sync?: boolean
  invoice_number_pattern?: "numeric" | "prefix" | "custom"
  invoice_number_prefix?: string | null
  last_known_invoice_number?: string | null
}

export interface QBOConnection {
  id: string
  org_id: string
  external_account_id: string
  external_account_name?: string
  status: QBOConnectionStatus
  connected_at: string
  last_sync_at?: string
  last_error?: string | null
  token_expires_at?: string
  refresh_token_expires_at?: string | null
  settings: QBOConnectionSettings
}

export interface AccountingConnectionDTO {
  id: string
  org_id: string
  provider: "qbo"
  label: string
  external_account_id: string
  external_account_name: string | null
  status: QBOConnectionStatus
  connected_at: string
  last_sync_at: string | null
  last_error: string | null
  token_expires_at: string | null
  refresh_token_expires_at: string | null
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
  const configuredClientId = getQBOClientId()

  // Only the OAuth app (client_id) that minted the tokens can refresh them.
  // If this runtime is configured with a different client_id (e.g. a dev box
  // pointed at the prod DB, or a credential rotation), do NOT call Intuit and do
  // NOT touch status — a mismatched environment must never expire a live
  // connection. Legacy rows with a null client_id are allowed through and get
  // stamped on the next successful refresh below.
  if (connection.client_id && configuredClientId && connection.client_id !== configuredClientId) {
    logQBO("warn", "token_refresh_skipped_client_mismatch", {
      orgId: options.orgIdForLogs ?? connection.org_id,
      connectionId: connection.id,
      source: options.source,
    })
    return null
  }

  const expiresAtMs = connection.token_expires_at ? new Date(connection.token_expires_at).getTime() : 0
  const shouldRefresh = options.force || !expiresAtMs || expiresAtMs - Date.now() < ACCESS_TOKEN_REFRESH_WINDOW_MS

  if (!shouldRefresh) {
    return { token: decryptToken(connection.access_token), realmId: connection.external_account_id }
  }

  const currentFailureCount = connection.refresh_failure_count ?? 0

  try {
    const newTokens = await refreshAccessToken(decryptToken(connection.refresh_token))
    const refreshTokenExpiresAt = computeRefreshTokenExpiresAt(newTokens.x_refresh_token_expires_in)
    const encryptedAccessToken = encryptToken(newTokens.access_token)
    const encryptedRefreshToken = encryptToken(newTokens.refresh_token)

    const { data: updatedRow, error: updateError } = await supabase
      .from("accounting_connections")
      .update({
        access_token: encryptedAccessToken,
        refresh_token: encryptedRefreshToken,
        token_expires_at: new Date(Date.now() + newTokens.expires_in * 1000).toISOString(),
        refresh_token_expires_at: refreshTokenExpiresAt,
        refresh_failure_count: 0,
        status: "active",
        last_error: null,
        credentials: {
          access_token: encryptedAccessToken,
          refresh_token: encryptedRefreshToken,
          ...(configuredClientId ? { client_id: configuredClientId } : {}),
        },
        // Stamp/backfill the owning client_id now that this app successfully refreshed.
        ...(configuredClientId ? { client_id: configuredClientId } : {}),
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
        .from("accounting_connections")
        .select("access_token, external_account_id, status")
        .eq("id", connection.id)
        .maybeSingle()

      if (latestError || !latest || latest.status !== "active") {
        return null
      }

      return { token: decryptToken(latest.access_token), realmId: latest.external_account_id }
    }

    return { token: newTokens.access_token, realmId: connection.external_account_id }
  } catch (error) {
    const invalidGrant = isInvalidGrantRefreshError(error)
    const nextFailureCount = currentFailureCount + 1
    const shouldExpire = invalidGrant || nextFailureCount >= MAX_TRANSIENT_REFRESH_FAILURES
    const errorMessage = String(error ?? "Token refresh failed").slice(0, 500)

    await supabase
      .from("accounting_connections")
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
      return { token: decryptToken(connection.access_token), realmId: connection.external_account_id }
    }

    return null
  }
}

export async function getQBOConnection(orgId?: string): Promise<QBOConnection | null> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("accounting_connections")
    .select(
      "id, org_id, external_account_id, external_account_name, status, connected_at, last_sync_at, last_error, token_expires_at, refresh_token_expires_at, settings",
    )
    .eq("org_id", resolvedOrgId)
    .eq("provider", "qbo")
    .eq("status", "active")
    .order("connected_at", { ascending: true })
    .limit(1)
    .maybeSingle()

  if (error || !data) return null
  return data as QBOConnection
}

export async function listAccountingConnections(orgId?: string): Promise<AccountingConnectionDTO[]> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  const { data, error } = await supabase
    .from("accounting_connections")
    .select("id,org_id,provider,label,external_account_id,external_account_name,status,connected_at,last_sync_at,last_error,token_expires_at,refresh_token_expires_at,settings")
    .eq("org_id", resolvedOrgId)
    .order("connected_at", { ascending: true })
  if (error) throw new Error(`Unable to load accounting connections: ${error.message}`)
  return (data ?? []) as AccountingConnectionDTO[]
}

export async function updateAccountingConnectionLabel(connectionId: string, label: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  const normalized = label.trim()
  if (!normalized) throw new Error("Connection label is required")
  const { data, error } = await supabase
    .from("accounting_connections")
    .update({ label: normalized })
    .eq("org_id", resolvedOrgId)
    .eq("id", connectionId)
    .select("id,label")
    .single()
  if (error) throw new Error(`Unable to update connection label: ${error.message}`)
  return data
}

export function getQBOEnvironmentInfo() {
  return {
    environment: qboEnvironmentLabel,
    isSandbox: isQboSandbox,
    apiBaseUrl: qboApiBaseUrl,
    hasExplicitSandboxSetting: hasExplicitQboSandboxSetting,
  }
}

export async function getQBOAccessToken(
  orgId: string,
  options?: { forceRefresh?: boolean; connectionId?: string },
): Promise<{ token: string; realmId: string } | null> {
  const supabase = createServiceSupabaseClient()
  let query = supabase
    .from("accounting_connections")
    .select("id, org_id, external_account_id, access_token, refresh_token, token_expires_at, refresh_token_expires_at, refresh_failure_count, client_id")
    .eq("org_id", orgId)
    .eq("provider", "qbo")
    .eq("status", "active")
  query = options?.connectionId ? query.eq("id", options.connectionId) : query.order("connected_at", { ascending: true }).limit(1)
  const { data: connection, error } = await query.maybeSingle()

  if (error || !connection) return null
  return refreshConnectionTokens(supabase, connection as QBOConnectionTokenRow, {
    force: options?.forceRefresh === true,
    orgIdForLogs: orgId,
    source: "auto",
  })
}

export async function getQBOAccessTokenForConnection(connectionId: string, options?: { forceRefresh?: boolean }) {
  const supabase = createServiceSupabaseClient()
  const { data: connection } = await supabase
    .from("accounting_connections")
    .select("org_id")
    .eq("id", connectionId)
    .eq("provider", "qbo")
    .maybeSingle()
  if (!connection?.org_id) return null
  return getQBOAccessToken(connection.org_id, { ...options, connectionId })
}

export async function refreshAccountingConnectionToken(connectionId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  const { data } = await supabase.from("accounting_connections").select("id,provider").eq("org_id", resolvedOrgId).eq("id", connectionId).maybeSingle()
  if (!data) throw new Error("Accounting connection not found")
  if (data.provider !== "qbo") throw new Error(`Token refresh is not supported for ${data.provider}`)
  const refreshed = await getQBOAccessTokenForConnection(connectionId, { forceRefresh: true })
  if (!refreshed) throw new Error("QuickBooks token refresh failed")
  return { refreshed: true }
}

export async function disconnectAccountingConnection(connectionId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const { data: connection } = await supabase
    .from("accounting_connections")
    .select("id,provider,refresh_token,external_account_id,label")
    .eq("org_id", resolvedOrgId)
    .eq("id", connectionId)
    .maybeSingle()
  if (!connection) throw new Error("Accounting connection not found")
  if (connection.provider === "qbo" && connection.refresh_token) {
    try { await revokeQBOToken(decryptToken(connection.refresh_token)) }
    catch (error) { logQBO("warn", "token_revoke_failed_on_disconnect", { orgId: resolvedOrgId, connectionId, error: String(error).slice(0, 500) }) }
  }
  const { error } = await supabase.from("accounting_connections")
    .update({ status: "disconnected", disconnected_at: new Date().toISOString() })
    .eq("org_id", resolvedOrgId).eq("id", connectionId)
  if (error) throw new Error(`Failed to disconnect accounting connection: ${error.message}`)
  await Promise.all([
    recordEvent({ orgId: resolvedOrgId, actorId: userId, eventType: "accounting_disconnected", entityType: "accounting_connection", entityId: connectionId, payload: { provider: connection.provider, label: connection.label }, channel: "integration" }),
    recordEvent({ orgId: resolvedOrgId, actorId: userId, eventType: "qbo_disconnected", entityType: "integration", entityId: resolvedOrgId, payload: { connection_id: connectionId }, channel: "integration" }),
  ])
}

export async function disconnectQBO(orgId?: string) {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data: connection } = await supabase
    .from("accounting_connections")
    .select("id")
    .eq("org_id", resolvedOrgId)
    .eq("provider", "qbo")
    .eq("status", "active")
    .order("connected_at", { ascending: true })
    .limit(1)
    .maybeSingle()

  if (connection?.id) return disconnectAccountingConnection(connection.id, resolvedOrgId)
}

export async function updateQBOSettings(settings: Partial<QBOConnectionSettings>, orgId?: string) {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data: current } = await supabase
    .from("accounting_connections")
    .select("id,settings")
    .eq("org_id", resolvedOrgId)
    .eq("status", "active")
    .eq("provider", "qbo")
    .order("connected_at", { ascending: true })
    .limit(1)
    .maybeSingle()

  if (!current) throw new Error("No active QBO connection")

  const nextSettings = { ...(current.settings as QBOConnectionSettings), ...settings }

  const { error } = await supabase
    .from("accounting_connections")
    .update({
      settings: nextSettings,
    })
    .eq("org_id", resolvedOrgId)
    .eq("status", "active")
    .eq("provider", "qbo")
    .eq("id", (current as { id?: string }).id ?? "")

  if (error) throw new Error(`Failed to update QBO settings: ${error.message}`)
}

export async function refreshQBOTokenNow(orgId?: string) {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  const service = createServiceSupabaseClient()

  const { data: connection, error } = await supabase
    .from("accounting_connections")
    .select("id, org_id, external_account_id, access_token, refresh_token, token_expires_at, refresh_token_expires_at, refresh_failure_count, client_id")
    .eq("org_id", resolvedOrgId)
    .eq("provider", "qbo")
    .eq("status", "active")
    .order("connected_at", { ascending: true })
    .limit(1)
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
      .from("accounting_connections")
      .select("id, status, token_expires_at, refresh_token_expires_at, refresh_failure_count, last_sync_at, last_error, external_account_name")
      .eq("org_id", resolvedOrgId)
      .eq("provider", "qbo")
      .eq("status", "active")
      .order("connected_at", { ascending: true })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("outbox")
      .select("id", { count: "exact", head: true })
      .eq("org_id", resolvedOrgId)
      .in("job_type", ["qbo_sync_invoice", "qbo_sync_payment", "qbo_sync_project_expense", "qbo_sync_vendor_bill", "qbo_sync_bill_payment"])
      .in("status", ["pending", "processing"]),
    supabase
      .from("outbox")
      .select("id, job_type, last_error, updated_at", { count: "exact" })
      .eq("org_id", resolvedOrgId)
      .in("job_type", ["qbo_sync_invoice", "qbo_sync_payment", "qbo_sync_project_expense", "qbo_sync_vendor_bill", "qbo_sync_bill_payment"])
      .eq("status", "failed")
      .order("updated_at", { ascending: false })
      .limit(5),
    supabase
      .from("accounting_sync_records")
      .select("id", { count: "exact", head: true })
      .eq("org_id", resolvedOrgId)
      .eq("entity_type", "invoice")
      .eq("status", "error"),
  ])

  return {
    connection: connectionResult.data
      ? {
          id: connectionResult.data.id,
          status: connectionResult.data.status,
          external_account_name: connectionResult.data.external_account_name,
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
  label?: string
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

  const { data, error } = await supabase
    .from("accounting_connections")
    .insert({
      org_id: input.orgId,
      provider: "qbo",
      label: input.label?.trim() || input.companyName?.trim() || "QuickBooks",
      external_account_id: input.realmId,
      client_id: getQBOClientId(),
      access_token: encryptToken(input.accessToken),
      refresh_token: encryptToken(input.refreshToken),
      token_expires_at: new Date(Date.now() + input.expiresInSeconds * 1000).toISOString(),
      refresh_token_expires_at: computeRefreshTokenExpiresAt(input.refreshTokenExpiresInSeconds),
      refresh_failure_count: 0,
      external_account_name: input.companyName,
      credentials: {
        access_token: encryptToken(input.accessToken),
        refresh_token: encryptToken(input.refreshToken),
        client_id: getQBOClientId(),
      },
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
    const connectionId = data?.id ?? randomUUID()
    await Promise.all([
      recordEvent({ orgId: input.orgId, eventType: "accounting_connected", entityType: "accounting_connection", entityId: connectionId, payload: { provider: "qbo", label: input.label ?? input.companyName ?? "QuickBooks" }, channel: "integration" }),
      recordEvent({ orgId: input.orgId, eventType: "qbo_connected", entityType: "integration", entityId: input.orgId, payload: { external_account_name: input.companyName, connection_id: connectionId }, channel: "integration" }),
    ])
  } catch (eventError) {
    console.error("Failed to record QBO connection event", eventError)
  }
}

export async function refreshQBOConnectionsDueForKeepalive(limit = 10) {
  const supabase = createServiceSupabaseClient()
  const keepaliveHorizonIso = new Date(Date.now() + KEEPALIVE_REFRESH_WINDOW_MS).toISOString()

  const { data: candidates, error } = await supabase
    .from("accounting_connections")
    .select("id, org_id, external_account_id, access_token, refresh_token, token_expires_at, refresh_token_expires_at, refresh_failure_count, client_id")
    .eq("status", "active")
    .eq("provider", "qbo")
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
