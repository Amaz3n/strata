'use server'

import { cookies } from "next/headers"

import { getProvider, isAccountingProviderKey } from "@/lib/integrations/accounting/registry"
import type { AccountingAccountKind, AccountingDimensionKind } from "@/lib/integrations/accounting/provider"
import { disconnectAccountingConnection, listAccountingConnections, requireAccountingConnectionForOrg, updateAccountingConnectionLabel, updateAccountingConnectionSettings } from "@/lib/services/accounting-connections"
import {
  createStripeConnectedAccountDashboardLoginLink,
  createStripeConnectedAccountOnboardingLink,
  getStripeConnectedAccount,
  syncStripeConnectedAccount,
} from "@/lib/services/stripe-connected-accounts"
import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"
import { retryFailedAccountingSyncJobs } from "@/lib/services/accounting-sync"
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

export async function connectQBOAction() {
  return run(async () => {
      const { supabase, orgId, userId } = await requireOrgContext()
      await requirePermission("org.admin", { supabase, orgId, userId })

      const provider = getProvider("qbo")
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

      return { authUrl: url, state }
  })
}

export async function listAccountingConnectionsAction() {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requirePermission("org.admin", { supabase, orgId, userId })
  const rows = await listAccountingConnections(orgId)
  return rows.map((row) => ({ ...row, capabilities: getProvider(row.provider).capabilities }))
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
    capabilities: provider.capabilities,
    accounts: Object.fromEntries(entries) as Record<AccountingAccountKind, Awaited<ReturnType<typeof provider.listAccounts>>>,
  }
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

export async function listAccountingEntityMapsAction() {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requirePermission("accounting.entity_map.manage", { supabase, orgId, userId })
  const { data, error } = await supabase.from("accounting_entity_map")
    .select("id,scope,connection_id,division_id,community_id,project_id,dimensions,division:divisions(name),community:communities(name),project:projects(name)")
    .eq("org_id", orgId).order("scope")
  if (error) throw new Error(`Unable to load accounting entity map: ${error.message}`)
  return data ?? []
}

export async function listAccountingScopeOptionsAction() {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requirePermission("accounting.entity_map.manage", { supabase, orgId, userId })
  const [{ data: divisions, error: divisionError }, { data: communities, error: communityError }] = await Promise.all([
    supabase.from("divisions").select("id,name").eq("org_id", orgId).is("archived_at", null).order("name"),
    supabase.from("communities").select("id,name").eq("org_id", orgId).is("archived_at", null).order("name"),
  ])
  if (divisionError || communityError) throw new Error(divisionError?.message ?? communityError?.message ?? "Unable to load accounting scopes")
  return { divisions: divisions ?? [], communities: communities ?? [] }
}

export async function upsertAccountingEntityMapAction(input: unknown) {
  return run(async () => upsertAccountingEntityMap(accountingEntityMapSchema.parse(input)))
}

export async function listAccountingDimensionValuesAction(connectionId: string, kind: AccountingDimensionKind) {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requirePermission("accounting.entity_map.manage", { supabase, orgId, userId })
  const { data: connection } = await supabase
    .from("accounting_connections")
    .select("provider")
    .eq("org_id", orgId)
    .eq("id", connectionId)
    .maybeSingle()
  if (!connection || !isAccountingProviderKey(connection.provider)) return []
  try {
    const provider = getProvider(connection.provider)
    if (!provider.capabilities.dimensions.includes(kind)) return []
    return await provider.listDimensionValues({ connectionId, kind })
  } catch {
    return []
  }
}

export async function createAccountingExportAction(input: { kind: AccountingExportKind; startDate: string; endDate: string; entityMapId?: string | null }) {
  return run(() => createAccountingExport(input))
}

export async function getStripeConnectedAccountAction() {
      return getStripeConnectedAccount()
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
