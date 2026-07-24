import { randomUUID } from "crypto"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireOrgContext } from "@/lib/services/context"
import { decryptToken, detectInvoiceNumberPattern, encryptToken, getQBOClientId, refreshAccessToken } from "@/lib/integrations/accounting/qbo/auth"
import { recordEvent } from "@/lib/services/events"
import { recordAudit } from "@/lib/services/audit"
import { logQBO } from "@/lib/services/accounting-logger"
import { ACCOUNTING_JOB_TYPES } from "@/lib/services/accounting-job-types"
import type { AccountingProviderKey } from "@/lib/integrations/accounting/provider"

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
  default_income_account_id?: string | null
  default_expense_account_id?: string | null
  default_payment_account_id?: string | null
  default_credit_card_account_id?: string | null
  default_ap_account_id?: string | null
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
  provider: AccountingProviderKey
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

export type AccountingConnectionSettingsUpdate = Partial<
  Pick<
    QBOConnectionSettings,
    | "auto_sync"
    | "sync_payments"
    | "customer_sync_mode"
    | "default_income_account_id"
    | "default_expense_account_id"
    | "default_payment_account_id"
    | "default_credit_card_account_id"
    | "default_ap_account_id"
    | "project_mapping_mode"
    | "invoice_number_sync"
  >
>

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

export async function getAccountingConnectionForOrg(
  connectionId: string,
  orgId?: string,
  options: { activeOnly?: boolean; provider?: AccountingProviderKey } = {},
): Promise<AccountingConnectionDTO | null> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  let query = supabase
    .from("accounting_connections")
    .select("id,org_id,provider,label,external_account_id,external_account_name,status,connected_at,last_sync_at,last_error,token_expires_at,refresh_token_expires_at,settings")
    .eq("org_id", resolvedOrgId)
    .eq("id", connectionId)
  if (options.activeOnly) query = query.eq("status", "active")
  if (options.provider) query = query.eq("provider", options.provider)
  const { data, error } = await query.maybeSingle()
  if (error) throw new Error(`Unable to load accounting connection: ${error.message}`)
  return (data as AccountingConnectionDTO | null) ?? null
}

export async function requireAccountingConnectionForOrg(
  connectionId: string,
  orgId?: string,
  options: { activeOnly?: boolean; provider?: AccountingProviderKey } = {},
): Promise<AccountingConnectionDTO> {
  const connection = await getAccountingConnectionForOrg(connectionId, orgId, options)
  if (!connection) throw new Error("Accounting connection not found for this organization")
  return connection
}

export async function updateAccountingConnectionSettings(
  connectionId: string,
  updates: AccountingConnectionSettingsUpdate,
  orgId?: string,
) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const connection = await requireAccountingConnectionForOrg(connectionId, resolvedOrgId)
  const before = connection.settings ?? {}
  const next = { ...before, ...updates }
  const { data, error } = await supabase
    .from("accounting_connections")
    .update({ settings: next })
    .eq("org_id", resolvedOrgId)
    .eq("id", connectionId)
    .select("id,settings")
    .single()
  if (error) throw new Error(`Unable to update accounting settings: ${error.message}`)
  await Promise.all([
    recordAudit({
      orgId: resolvedOrgId,
      actorId: userId,
      action: "update",
      entityType: "accounting_connection",
      entityId: connectionId,
      before: { settings: before },
      after: { settings: data.settings },
    }),
    recordEvent({
      orgId: resolvedOrgId,
      actorId: userId,
      eventType: "accounting_connection_settings_updated",
      entityType: "accounting_connection",
      entityId: connectionId,
      payload: { provider: connection.provider, keys: Object.keys(updates).sort() },
      channel: "integration",
    }),
  ])
  return data
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
    .select("id,provider,external_account_id,label")
    .eq("org_id", resolvedOrgId)
    .eq("id", connectionId)
    .maybeSingle()
  if (!connection) throw new Error("Accounting connection not found")
  const { error } = await supabase.from("accounting_connections")
    .update({ status: "disconnected", disconnected_at: new Date().toISOString() })
    .eq("org_id", resolvedOrgId).eq("id", connectionId)
  if (error) throw new Error(`Failed to disconnect accounting connection: ${error.message}`)
  await Promise.all([
    recordEvent({ orgId: resolvedOrgId, actorId: userId, eventType: "accounting_disconnected", entityType: "accounting_connection", entityId: connectionId, payload: { provider: connection.provider, label: connection.label }, channel: "integration" }),
    recordEvent({ orgId: resolvedOrgId, actorId: userId, eventType: "qbo_disconnected", entityType: "integration", entityId: resolvedOrgId, payload: { connection_id: connectionId }, channel: "integration" }),
  ])
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
