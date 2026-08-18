import { randomUUID } from "crypto";

import { createServiceSupabaseClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/lib/services/context";
import {
  getProvider,
  isAccountingProviderKey,
} from "@/lib/integrations/accounting/registry";
import { recordEvent } from "@/lib/services/events";
import { recordAudit } from "@/lib/services/audit";
import { logAccounting } from "@/lib/services/accounting-logger";
import { ACCOUNTING_JOB_TYPES } from "@/lib/services/accounting-job-types";
import type { AccountingProviderKey } from "@/lib/integrations/accounting/provider";
import {
  BATCH_FORMATS,
  isAccountingBatchFormat,
} from "@/lib/integrations/accounting/file/formats";

export type QBOConnectionStatus =
  | "active"
  | "expired"
  | "disconnected"
  | "error";

export interface QBOConnectionSettings {
  auto_sync: boolean;
  /** Independent invoice circuit breaker; defaults on for existing connections. */
  sync_invoices?: boolean;
  sync_payments: boolean;
  customer_sync_mode: "create_new" | "match_existing";
  default_income_account_id?: string | null;
  default_invoice_item?: { id: string; name?: string | null } | null;
  invoice_item_mappings?: Record<string, { id: string; name?: string | null }>;
  default_expense_account_id?: string | null;
  default_payment_account_id?: string | null;
  default_credit_card_account_id?: string | null;
  default_ap_account_id?: string | null;
  project_mapping_mode?: "customer" | "sub_customer";
  invoice_number_sync?: boolean;
  invoice_number_pattern?: "numeric" | "prefix" | "custom";
  invoice_number_prefix?: string | null;
  last_known_invoice_number?: string | null;
}

export interface QBOConnection {
  id: string;
  org_id: string;
  external_account_id: string;
  external_account_name?: string;
  status: QBOConnectionStatus;
  connected_at: string;
  last_sync_at?: string;
  last_error?: string | null;
  token_expires_at?: string;
  refresh_token_expires_at?: string | null;
  settings: QBOConnectionSettings;
}

export interface AccountingConnectionDTO {
  id: string;
  org_id: string;
  provider: AccountingProviderKey;
  label: string;
  external_account_id: string;
  external_account_name: string | null;
  status: QBOConnectionStatus;
  connected_at: string;
  last_sync_at: string | null;
  last_error: string | null;
  token_expires_at: string | null;
  refresh_token_expires_at: string | null;
  settings: QBOConnectionSettings;
}

export type AccountingConnectionSettingsUpdate = Partial<
  Pick<
    QBOConnectionSettings,
    | "auto_sync"
    | "sync_invoices"
    | "sync_payments"
    | "customer_sync_mode"
    | "default_income_account_id"
    | "default_invoice_item"
    | "invoice_item_mappings"
    | "default_expense_account_id"
    | "default_payment_account_id"
    | "default_credit_card_account_id"
    | "default_ap_account_id"
    | "project_mapping_mode"
    | "invoice_number_sync"
  >
>;

export async function listAccountingConnections(
  orgId?: string,
): Promise<AccountingConnectionDTO[]> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId);
  const { data, error } = await supabase
    .from("accounting_connections")
    .select(
      "id,org_id,provider,label,external_account_id,external_account_name,status,connected_at,last_sync_at,last_error,token_expires_at,refresh_token_expires_at,settings",
    )
    .eq("org_id", resolvedOrgId)
    .order("connected_at", { ascending: true });
  if (error)
    throw new Error(`Unable to load accounting connections: ${error.message}`);
  return (data ?? []) as AccountingConnectionDTO[];
}

export async function getAccountingConnectionForOrg(
  connectionId: string,
  orgId?: string,
  options: { activeOnly?: boolean; provider?: AccountingProviderKey } = {},
): Promise<AccountingConnectionDTO | null> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId);
  let query = supabase
    .from("accounting_connections")
    .select(
      "id,org_id,provider,label,external_account_id,external_account_name,status,connected_at,last_sync_at,last_error,token_expires_at,refresh_token_expires_at,settings",
    )
    .eq("org_id", resolvedOrgId)
    .eq("id", connectionId);
  if (options.activeOnly) query = query.eq("status", "active");
  if (options.provider) query = query.eq("provider", options.provider);
  const { data, error } = await query.maybeSingle();
  if (error)
    throw new Error(`Unable to load accounting connection: ${error.message}`);
  return (data as AccountingConnectionDTO | null) ?? null;
}

export async function requireAccountingConnectionForOrg(
  connectionId: string,
  orgId?: string,
  options: { activeOnly?: boolean; provider?: AccountingProviderKey } = {},
): Promise<AccountingConnectionDTO> {
  const connection = await getAccountingConnectionForOrg(
    connectionId,
    orgId,
    options,
  );
  if (!connection)
    throw new Error("Accounting connection not found for this organization");
  return connection;
}

export async function updateAccountingConnectionSettings(
  connectionId: string,
  updates: AccountingConnectionSettingsUpdate,
  orgId?: string,
) {
  const {
    supabase,
    orgId: resolvedOrgId,
    userId,
  } = await requireOrgContext(orgId);
  const connection = await requireAccountingConnectionForOrg(
    connectionId,
    resolvedOrgId,
  );
  const before = connection.settings ?? {};
  const next = { ...before, ...updates };
  const { data, error } = await supabase
    .from("accounting_connections")
    .update({ settings: next })
    .eq("org_id", resolvedOrgId)
    .eq("id", connectionId)
    .select("id,settings")
    .single();
  if (error)
    throw new Error(`Unable to update accounting settings: ${error.message}`);
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
      payload: {
        provider: connection.provider,
        keys: Object.keys(updates).sort(),
      },
      channel: "integration",
    }),
  ]);
  return data;
}

export async function updateAccountingConnectionLabel(
  connectionId: string,
  label: string,
  orgId?: string,
) {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId);
  const normalized = label.trim();
  if (!normalized) throw new Error("Connection label is required");
  const { data, error } = await supabase
    .from("accounting_connections")
    .update({ label: normalized })
    .eq("org_id", resolvedOrgId)
    .eq("id", connectionId)
    .select("id,label")
    .single();
  if (error)
    throw new Error(`Unable to update connection label: ${error.message}`);
  return data;
}

/**
 * Re-validate a connection's credentials, whoever holds them.
 *
 * Dispatches through the registry rather than assuming QuickBooks.
 * `AccountingProvider.refreshConnection` has existed since the interface was
 * written; this layer threw `Token refresh is not supported for <provider>` at
 * every other provider anyway, which is the shape of "adding a provider means
 * rewriting the connections service".
 *
 * A provider with no credentials to refresh (the file provider) is not an
 * error — there is simply nothing to do.
 */
export async function refreshAccountingConnectionToken(
  connectionId: string,
  orgId?: string,
) {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId);
  const { data } = await supabase
    .from("accounting_connections")
    .select("id,provider,label")
    .eq("org_id", resolvedOrgId)
    .eq("id", connectionId)
    .maybeSingle();
  if (!data) throw new Error("Accounting connection not found");
  if (!isAccountingProviderKey(data.provider))
    throw new Error(`Unknown accounting provider ${data.provider}`);

  const provider = getProvider(data.provider);
  if (!provider.refreshConnection)
    return { refreshed: false as const, reason: "not_applicable" as const };

  const result = await provider.refreshConnection(connectionId);
  if (!result.ok)
    throw new Error(
      result.error ??
        `${data.label ?? data.provider} credential refresh failed`,
    );
  return { refreshed: true as const };
}

export async function disconnectAccountingConnection(
  connectionId: string,
  orgId?: string,
) {
  const {
    supabase,
    orgId: resolvedOrgId,
    userId,
  } = await requireOrgContext(orgId);
  const { data: connection } = await supabase
    .from("accounting_connections")
    .select("id,provider,external_account_id,label")
    .eq("org_id", resolvedOrgId)
    .eq("id", connectionId)
    .maybeSingle();
  if (!connection) throw new Error("Accounting connection not found");

  // Revoke at the provider BEFORE dropping local status. Both adapters have
  // implemented `disconnect` since the interface was written and this layer
  // never called it, so "disconnected" in Arc left a live credential at the
  // provider — a security defect, not just an untidy one. Local lifecycle state
  // is still owned here, so a revoke that fails does not strand the row.
  if (isAccountingProviderKey(connection.provider)) {
    try {
      await getProvider(connection.provider).disconnect({
        orgId: resolvedOrgId,
        connectionId,
      });
    } catch (revokeError) {
      logAccounting("warn", "provider_revoke_failed_on_disconnect", {
        provider: connection.provider,
        orgId: resolvedOrgId,
        connectionId,
        error:
          revokeError instanceof Error
            ? revokeError.message
            : String(revokeError),
      });
    }
  }

  const { error } = await supabase
    .from("accounting_connections")
    .update({
      status: "disconnected",
      disconnected_at: new Date().toISOString(),
    })
    .eq("org_id", resolvedOrgId)
    .eq("id", connectionId);
  if (error)
    throw new Error(
      `Failed to disconnect accounting connection: ${error.message}`,
    );
  const { error: mappingError, count: removedMappings } = await supabase
    .from("accounting_entity_map")
    .delete({ count: "exact" })
    .eq("org_id", resolvedOrgId)
    .eq("connection_id", connectionId);
  if (mappingError)
    throw new Error(
      `Connection was revoked but its routing mappings could not be removed: ${mappingError.message}`,
    );
  await recordEvent({
    orgId: resolvedOrgId,
    actorId: userId,
    eventType: "accounting_disconnected",
    entityType: "accounting_connection",
    entityId: connectionId,
    payload: {
      provider: connection.provider,
      label: connection.label,
      removed_routing_mappings: removedMappings ?? 0,
    },
    channel: "integration",
  });
}

/**
 * Create a connection to a target Arc cannot authenticate against.
 *
 * A batch-file target has no OAuth handshake and no credentials — it is pure
 * configuration, so it is created directly rather than through a redirect. That
 * is why `connectFlow` exists in the catalog: offering this provider in the
 * OAuth menu would be a button that can only fail.
 */
export async function createFileAccountingConnection(input: {
  label: string;
  batchFormat: string;
  orgId?: string;
}) {
  const { orgId, userId } = await requireOrgContext(input.orgId);
  const label = input.label.trim();
  if (label.length < 1 || label.length > 120)
    throw new Error("Give this connection a name between 1 and 120 characters");
  if (!isAccountingBatchFormat(input.batchFormat))
    throw new Error("Choose a supported batch format");

  const supabase = createServiceSupabaseClient();
  const { data, error } = await supabase
    .from("accounting_connections")
    .insert({
      org_id: orgId,
      provider: "file",
      label,
      // No remote company file to point at. The format is the only identity this
      // connection has, and it has to be unique-ish and non-null.
      external_account_id: `file:${input.batchFormat}:${randomUUID().slice(0, 8)}`,
      external_account_name: BATCH_FORMATS[input.batchFormat].label,
      auth_scheme: "none",
      status: "active",
      settings: {
        batch_format: input.batchFormat,
        auto_sync: true,
        sync_payments: true,
      },
      connected_by: userId,
    })
    .select("id,label")
    .single();
  if (error || !data)
    throw new Error(
      `Unable to create the batch export connection: ${error?.message}`,
    );

  await Promise.all([
    recordAudit({
      orgId,
      actorId: userId,
      action: "insert",
      entityType: "accounting_connection",
      entityId: data.id,
      after: { provider: "file", label, batch_format: input.batchFormat },
    }),
    recordEvent({
      orgId,
      actorId: userId,
      eventType: "accounting_connected",
      entityType: "accounting_connection",
      entityId: data.id,
      payload: { provider: "file", label },
      channel: "integration",
    }),
  ]);
  return { id: data.id, label: data.label };
}
