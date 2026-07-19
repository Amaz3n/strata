'use server'

import { cookies } from "next/headers"

import { createQBOOAuthState, getQBOAuthUrl } from "@/lib/integrations/accounting/qbo/auth"
import { disconnectAccountingConnection, disconnectQBO, getQBOConnection, getQBODiagnostics, getQBOEnvironmentInfo, listAccountingConnections, refreshAccountingConnectionToken, refreshQBOTokenNow, updateAccountingConnectionLabel, updateQBOSettings } from "@/lib/services/accounting-connections"
import {
  createStripeConnectedAccountDashboardLoginLink,
  createStripeConnectedAccountOnboardingLink,
  getStripeConnectedAccount,
  syncStripeConnectedAccount,
} from "@/lib/services/stripe-connected-accounts"
import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"
import { retryFailedQBOSyncJobs } from "@/lib/services/accounting-sync"
import { QBOClient } from "@/lib/integrations/accounting/qbo/client"
import { accountingConnectionLabelSchema, accountingEntityMapSchema } from "@/lib/validation/accounting"
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

      const state = createQBOOAuthState(orgId)
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

      return { authUrl: getQBOAuthUrl(state), state }
  })
}

export async function disconnectQBOAction() {
  return run(async () => {
      const { supabase, orgId, userId } = await requireOrgContext()
      await requirePermission("org.admin", { supabase, orgId, userId })
      await disconnectQBO(orgId)
      return { success: true }
  })
}

export async function updateQBOSettingsAction(settings: Record<string, any>) {
  return run(async () => {
      const { supabase, orgId, userId } = await requireOrgContext()
      await requirePermission("org.admin", { supabase, orgId, userId })
      await updateQBOSettings(settings, orgId)
      return { success: true }
  })
}

export async function getQBOConnectionAction() {
      return getQBOConnection()
}

export async function listAccountingConnectionsAction() {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requirePermission("org.admin", { supabase, orgId, userId })
  return listAccountingConnections(orgId)
}

export async function disconnectAccountingConnectionAction(connectionId: string) {
  return run(async () => {
    const { supabase, orgId, userId } = await requireOrgContext()
    await requirePermission("org.admin", { supabase, orgId, userId })
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
    return refreshAccountingConnectionToken(connectionId, orgId)
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

export async function listAccountingDimensionValuesAction(connectionId: string, kind: "class" | "customer") {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requirePermission("accounting.entity_map.manage", { supabase, orgId, userId })
  const client = await QBOClient.forConnection(connectionId)
  if (!client) return []
  return kind === "class"
    ? (await client.listClasses()).map((row) => ({ id: row.id, name: row.name }))
    : (await client.listCustomers()).map((row) => ({ id: row.id, name: row.name }))
}

export async function createAccountingExportAction(input: { kind: AccountingExportKind; startDate: string; endDate: string; entityMapId?: string | null }) {
  return run(() => createAccountingExport(input))
}

export async function getQBOEnvironmentAction() {
      return getQBOEnvironmentInfo()
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

export async function getQBODiagnosticsAction() {
      const { supabase, orgId, userId } = await requireOrgContext()
      await requirePermission("org.admin", { supabase, orgId, userId })
      return getQBODiagnostics(orgId)
}

export async function refreshQBOTokenAction() {
  return run(async () => {
      const { supabase, orgId, userId } = await requireOrgContext()
      await requirePermission("org.admin", { supabase, orgId, userId })
      return refreshQBOTokenNow(orgId)
  })
}

export async function retryFailedQBOJobsAction() {
  return run(async () => {
      const { supabase, orgId, userId } = await requireOrgContext()
      await requirePermission("org.admin", { supabase, orgId, userId })
      return retryFailedQBOSyncJobs(orgId)
  })
}

export async function getQBOAccountingSetupAction() {
      const { orgId } = await requireOrgContext()
      const client = await QBOClient.forOrg(orgId)
      if (!client) {
        return {
          connected: false,
          incomeAccounts: [],
          expenseAccounts: [],
          paymentAccounts: [],
          apAccounts: [],
        }
      }

      const [incomeAccounts, expenseAccounts, paymentAccounts, apAccounts] = await Promise.all([
        client.listIncomeAccounts(),
        client.listExpenseAccounts(),
        client.listPaymentAccounts(),
        client.listAccountsPayableAccounts(),
      ])

      return {
        connected: true,
        incomeAccounts,
        expenseAccounts,
        paymentAccounts,
        apAccounts,
      }
}
