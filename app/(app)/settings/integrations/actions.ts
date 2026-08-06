'use server'

import { cookies } from "next/headers"

import { getProvider, isAccountingProviderKey } from "@/lib/integrations/accounting/registry"
import type { AccountingAccountKind, AccountingCapabilities, AccountingDimensionKind, AccountingProviderKey } from "@/lib/integrations/accounting/provider"
import { createFileAccountingConnection, disconnectAccountingConnection, listAccountingConnections, requireAccountingConnectionForOrg, updateAccountingConnectionLabel, updateAccountingConnectionSettings, type AccountingConnectionDTO } from "@/lib/services/accounting-connections"
import {
  createStripeConnectedAccountDashboardLoginLink,
  createStripeConnectedAccountOnboardingLink,
  getStripeConnectedAccount,
  syncStripeConnectedAccount,
} from "@/lib/services/stripe-connected-accounts"
import type { StripeConnectedAccount } from "@/lib/services/stripe-connected-accounts"
import { requireOrgContext } from "@/lib/services/context"
import { exportAccountingBatch, listAccountingBatches } from "@/lib/services/accounting-batches"
import { getAccountingSyncPosture, type AccountingSyncPosture } from "@/lib/services/accounting-sync"
import { getCurrentUserPermissions, requirePermission } from "@/lib/services/permissions"
import { accountingConnectionLabelSchema, accountingConnectionSettingsSchema, accountingEntityMapSchema } from "@/lib/validation/accounting"
import { upsertAccountingEntityMap } from "@/lib/services/accounting-target"
import { createAccountingExport, type AccountingExportKind } from "@/lib/services/accounting-export"

import { actionError, type ActionResult } from "@/lib/action-result"

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { success: true, data: await fn() }
  } catch (error) {
    return actionError(error)
  }
}

/** An accounting connection plus the capability flags that shape its settings UI. */
export type AccountingConnectionWithCapabilities = AccountingConnectionDTO & { capabilities: AccountingCapabilities }

export interface AccountingRoute {
  id: string
  scope: "org_default" | "division" | "community" | "project"
  connection_id: string
  division_id: string | null
  community_id: string | null
  project_id: string | null
  dimensions: Record<string, { id?: string; name?: string }> | null
  scopeName: string | null
}

export interface IntegrationsOverview {
  stripe: StripeConnectedAccount | null
  connections: AccountingConnectionWithCapabilities[]
  routes: AccountingRoute[]
  scopes: { divisions: { id: string; name: string }[]; communities: { id: string; name: string }[] }
  /** org.admin — connect, configure, and disconnect accounting and Stripe. */
  canManageConnections: boolean
  /** accounting.entity_map.manage — edit which connection a scope posts to. */
  canManageRouting: boolean
  /** What the sync is actually doing, beyond whether the connection is alive. */
  syncPosture: AccountingSyncPosture | null
}

type EntityMapJoin = { name: string } | { name: string }[] | null

function joinName(value: EntityMapJoin): string | null {
  const row = Array.isArray(value) ? value[0] : value
  return row?.name ?? null
}

/**
 * Everything the integrations settings tab renders, in one round trip. Reads are
 * permission-scoped rather than rejected so the tab can show a clear read-only
 * state instead of failing to load.
 */
export async function getIntegrationsOverviewAction(): Promise<ActionResult<IntegrationsOverview>> {
  return run(async () => {
    const { orgId } = await requireOrgContext()
    const permissionResult = await getCurrentUserPermissions()
    const permissions = permissionResult?.permissions ?? []
    const canManageConnections = permissions.includes("*") || permissions.includes("org.admin")
    const canManageRouting = canManageConnections || permissions.includes("accounting.entity_map.manage")

    const [stripe, connections, routes, scopes, syncPosture] = await Promise.all([
      getStripeConnectedAccount().catch(() => null),
      canManageConnections ? listAccountingConnections(orgId) : Promise.resolve([]),
      canManageRouting ? listRoutes(orgId) : Promise.resolve([]),
      canManageRouting ? listScopes(orgId) : Promise.resolve({ divisions: [], communities: [] }),
      // A backlog is not a connection problem, so it never showed up next to
      // "Synced 4 minutes ago" — which is exactly where someone looks for it.
      canManageConnections ? getAccountingSyncPosture(orgId).catch(() => null) : Promise.resolve(null),
    ])

    return {
      stripe,
      connections: connections.map((row) => ({ ...row, capabilities: getProvider(row.provider).capabilities })),
      routes,
      scopes,
      canManageConnections,
      canManageRouting,
      syncPosture,
    }
  })
}

async function listRoutes(orgId: string): Promise<AccountingRoute[]> {
  const { supabase } = await requireOrgContext(orgId)
  const { data, error } = await supabase
    .from("accounting_entity_map")
    .select("id,scope,connection_id,division_id,community_id,project_id,dimensions,division:divisions(name),community:communities(name),project:projects(name)")
    .eq("org_id", orgId)
    .order("scope")
  if (error) throw new Error(`Unable to load accounting routing: ${error.message}`)
  return (data ?? []).map((row) => ({
    id: row.id,
    scope: row.scope,
    connection_id: row.connection_id,
    division_id: row.division_id,
    community_id: row.community_id,
    project_id: row.project_id,
    dimensions: row.dimensions as AccountingRoute["dimensions"],
    scopeName: joinName(row.project) ?? joinName(row.community) ?? joinName(row.division),
  }))
}

async function listScopes(orgId: string) {
  const { supabase } = await requireOrgContext(orgId)
  const [{ data: divisions, error: divisionError }, { data: communities, error: communityError }] = await Promise.all([
    supabase.from("divisions").select("id,name").eq("org_id", orgId).is("archived_at", null).order("name"),
    supabase.from("communities").select("id,name").eq("org_id", orgId).is("archived_at", null).order("name"),
  ])
  if (divisionError || communityError) throw new Error(divisionError?.message ?? communityError?.message ?? "Unable to load accounting scopes")
  return { divisions: divisions ?? [], communities: communities ?? [] }
}

export async function connectAccountingProviderAction(providerKey: AccountingProviderKey) {
  return run(async () => {
    const { supabase, orgId, userId } = await requireOrgContext()
    await requirePermission("org.admin", { supabase, orgId, userId })

    const provider = getProvider(providerKey)
    if (!provider.getConnectUrl) throw new Error("This accounting provider does not support interactive connection")
    const { url, state } = await provider.getConnectUrl({ orgId })
    const cookieStore = await cookies()
    const secure = typeof process.env.VERCEL !== "undefined" || process.env.NODE_ENV === "production"
    if (typeof cookieStore.set === "function") {
      cookieStore.set({
        name: "qbo_oauth_state",
        value: state,
        httpOnly: true,
        sameSite: "lax",
        maxAge: 60 * 10,
        path: "/",
        secure,
      })
    }

    return { authUrl: url }
  })
}

/**
 * Create a batch-file connection. No redirect: there is nothing to authorize,
 * so this is a form rather than an OAuth handshake.
 */
export async function createFileAccountingConnectionAction(input: { label: string; batchFormat: string }) {
  return run(async () => {
    const { supabase, orgId, userId } = await requireOrgContext()
    await requirePermission("org.admin", { supabase, orgId, userId })
    return createFileAccountingConnection({ label: input.label, batchFormat: input.batchFormat, orgId })
  })
}

export async function listAccountingBatchesAction() {
  return run(() => listAccountingBatches())
}

/**
 * Render a batch and close it. Returns the bytes rather than a URL because the
 * file is generated on demand and never stored — there is nothing to link to.
 */
export async function exportAccountingBatchAction(batchId: string) {
  return run(() => exportAccountingBatch({ batchId }))
}

export async function disconnectAccountingConnectionAction(connectionId: string) {
  return run(async () => {
    const { supabase, orgId, userId } = await requireOrgContext()
    await requirePermission("org.admin", { supabase, orgId, userId })
    const connection = await requireAccountingConnectionForOrg(connectionId, orgId)
    await getProvider(connection.provider).disconnect({ orgId, connectionId })
    await disconnectAccountingConnection(connectionId, orgId)
    return { disconnected: true }
  })
}

export async function updateAccountingConnectionLabelAction(input: unknown) {
  return run(async () => {
    const parsed = accountingConnectionLabelSchema.parse(input)
    const { supabase, orgId, userId } = await requireOrgContext()
    await requirePermission("org.admin", { supabase, orgId, userId })
    return updateAccountingConnectionLabel(parsed.connectionId, parsed.label, orgId)
  })
}

export async function refreshAccountingConnectionAction(connectionId: string) {
  return run(async () => {
    const { supabase, orgId, userId } = await requireOrgContext()
    await requirePermission("org.admin", { supabase, orgId, userId })
    const connection = await requireAccountingConnectionForOrg(connectionId, orgId, { activeOnly: true })
    const provider = getProvider(connection.provider)
    const result = provider.refreshConnection
      ? await provider.refreshConnection(connectionId)
      : await provider.ensureHealthy(connectionId)
    if (!result.ok) throw new Error(result.error ?? "Accounting connection refresh failed")
    return { refreshed: true }
  })
}

export async function getAccountingConnectionConfigurationAction(connectionId: string) {
  return run(async () => {
    const { supabase, orgId, userId } = await requireOrgContext()
    await requirePermission("org.admin", { supabase, orgId, userId })
    const connection = await requireAccountingConnectionForOrg(connectionId, orgId)
    const provider = getProvider(connection.provider)
    const accountKinds: AccountingAccountKind[] = ["income", "expense", "payment", "ap"]
    const entries = await Promise.all(
      accountKinds.map(async (kind) => [kind, await provider.listAccounts({ connectionId, kind }).catch(() => [])] as const),
    )
    return {
      settings: connection.settings,
      accounts: Object.fromEntries(entries) as Record<AccountingAccountKind, Awaited<ReturnType<typeof provider.listAccounts>>>,
    }
  })
}

export async function updateAccountingConnectionSettingsAction(input: unknown) {
  return run(async () => {
    const parsed = accountingConnectionSettingsSchema.parse(input)
    const { supabase, orgId, userId } = await requireOrgContext()
    await requirePermission("org.admin", { supabase, orgId, userId })
    await requireAccountingConnectionForOrg(parsed.connectionId, orgId)
    return updateAccountingConnectionSettings(parsed.connectionId, parsed.settings, orgId)
  })
}

export async function upsertAccountingEntityMapAction(input: unknown) {
  return run(async () => upsertAccountingEntityMap(accountingEntityMapSchema.parse(input)))
}

export async function listAccountingDimensionValuesAction(connectionId: string, kind: AccountingDimensionKind) {
  return run(async () => {
    const { supabase, orgId, userId } = await requireOrgContext()
    await requirePermission("accounting.entity_map.manage", { supabase, orgId, userId })
    const { data: connection } = await supabase
      .from("accounting_connections")
      .select("provider")
      .eq("org_id", orgId)
      .eq("id", connectionId)
      .maybeSingle()
    if (!connection || !isAccountingProviderKey(connection.provider)) return []
    const provider = getProvider(connection.provider)
    if (!provider.capabilities.dimensions.includes(kind)) return []
    return provider.listDimensionValues({ connectionId, kind })
  })
}

export async function createAccountingExportAction(input: { kind: AccountingExportKind; startDate: string; endDate: string; entityMapId?: string | null }) {
  return run(() => createAccountingExport(input))
}

export async function createStripeConnectedAccountOnboardingLinkAction() {
  return run(async () => {
    const { supabase, orgId, userId } = await requireOrgContext()
    await requirePermission("org.admin", { supabase, orgId, userId })
    const link = await createStripeConnectedAccountOnboardingLink(orgId)
    return { url: link.url }
  })
}

export async function refreshStripeConnectedAccountAction() {
  return run(async () => {
    const { supabase, orgId, userId } = await requireOrgContext()
    await requirePermission("org.admin", { supabase, orgId, userId })
    return syncStripeConnectedAccount(orgId)
  })
}

export async function createStripeDashboardLoginLinkAction() {
  return run(async () => {
    const { supabase, orgId, userId } = await requireOrgContext()
    await requirePermission("org.admin", { supabase, orgId, userId })
    const link = await createStripeConnectedAccountDashboardLoginLink(orgId)
    return { url: link.url }
  })
}
