import { randomUUID } from "crypto"

import {
  decryptToken,
  detectInvoiceNumberPattern,
  encryptToken,
  getQBOClientId,
  refreshAccessToken,
} from "@/lib/integrations/accounting/qbo/auth"
import { logQBO } from "@/lib/services/accounting-logger"
import type { QBOConnectionStatus } from "@/lib/services/accounting-connections"
import { recordEvent } from "@/lib/services/events"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

/**
 * QuickBooks connection and credential machinery.
 *
 * This lives under the adapter, not in `lib/services/accounting-connections.ts`,
 * for two reasons. It is provider-specific by nature — OAuth token rotation,
 * realm ids, invoice-number pattern detection — and keeping it in the neutral
 * service is what made that service hardcode `provider = "qbo"` in eight places.
 *
 * It also breaks an import cycle. The neutral service now dispatches through the
 * provider registry, and the registry eagerly imports this adapter; with the
 * token functions still in the service, `keepAliveConnections` would have bound
 * `undefined` at module-evaluation time depending on which side loaded first.
 */

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

  const { data: priorConnections, error: priorError } = await supabase
    .from("accounting_connections")
    .select("id,status,label,settings")
    .eq("org_id", input.orgId)
    .eq("provider", "qbo")
    .eq("external_account_id", input.realmId)
    .order("connected_at", { ascending: false })

  if (priorError) {
    throw new Error(`Failed to inspect existing QBO connection: ${priorError.message}`)
  }

  const existingConnection =
    priorConnections?.find((connection) => connection.status === "active") ??
    priorConnections?.[0] ??
    null
  const existingSettings =
    (existingConnection?.settings as Record<string, unknown> | null) ?? {}
  const connectionPayload = {
    org_id: input.orgId,
    provider: "qbo",
    label: input.label?.trim() || existingConnection?.label || input.companyName?.trim() || "QuickBooks",
    external_account_id: input.realmId,
    client_id: getQBOClientId(),
    access_token: encryptToken(input.accessToken),
    refresh_token: encryptToken(input.refreshToken),
    token_expires_at: new Date(Date.now() + input.expiresInSeconds * 1000).toISOString(),
    refresh_token_expires_at: computeRefreshTokenExpiresAt(input.refreshTokenExpiresInSeconds),
    refresh_failure_count: 0,
    external_account_name: input.companyName,
    connected_by: input.connectedBy ?? null,
    connected_at: new Date().toISOString(),
    disconnected_at: null,
    last_error: null,
    status: "active",
    settings: {
      auto_sync: true,
      sync_payments: true,
      customer_sync_mode: "create_new",
      invoice_number_sync: true,
      ...existingSettings,
      invoice_number_pattern: settings.invoice_number_pattern,
      invoice_number_prefix: settings.invoice_number_prefix,
      last_known_invoice_number: settings.last_known_invoice_number,
    },
  }

  const saveQuery = existingConnection
    ? supabase
        .from("accounting_connections")
        .update(connectionPayload)
        .eq("id", existingConnection.id)
        .eq("org_id", input.orgId)
    : supabase.from("accounting_connections").insert(connectionPayload)
  const { data, error } = await saveQuery
    .select("id")
    .single()

  if (error) {
    throw new Error(`Failed to save QBO connection: ${error.message}`)
  }

  try {
    const connectionId = data?.id ?? randomUUID()
    // One event per fact. `qbo_connected`/`qbo_disconnected` were emitted
    // alongside the neutral pair, so every connect wrote two rows saying the
    // same thing and any future provider would have had to invent its own.
    await recordEvent({
      orgId: input.orgId,
      eventType: "accounting_connected",
      entityType: "accounting_connection",
      entityId: connectionId,
      payload: {
        provider: "qbo",
        label: input.label ?? input.companyName ?? "QuickBooks",
        external_account_name: input.companyName ?? null,
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
