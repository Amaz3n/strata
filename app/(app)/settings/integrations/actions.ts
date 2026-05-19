'use server'

import { cookies } from "next/headers"

import { createQBOOAuthState, getQBOAuthUrl } from "@/lib/integrations/accounting/qbo-auth"
import { disconnectQBO, getQBOConnection, getQBODiagnostics, getQBOEnvironmentInfo, refreshQBOTokenNow, updateQBOSettings } from "@/lib/services/qbo-connection"
import {
  createStripeConnectedAccountDashboardLoginLink,
  createStripeConnectedAccountOnboardingLink,
  getStripeConnectedAccount,
  syncStripeConnectedAccount,
} from "@/lib/services/stripe-connected-accounts"
import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"
import { retryFailedQBOSyncJobs } from "@/lib/services/qbo-sync"
import { QBOClient } from "@/lib/integrations/accounting/qbo-api"

export async function connectQBOAction() {
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
}

export async function disconnectQBOAction() {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requirePermission("org.admin", { supabase, orgId, userId })
  await disconnectQBO(orgId)
  return { success: true }
}

export async function updateQBOSettingsAction(settings: Record<string, any>) {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requirePermission("org.admin", { supabase, orgId, userId })
  await updateQBOSettings(settings, orgId)
  return { success: true }
}

export async function getQBOConnectionAction() {
  return getQBOConnection()
}

export async function getQBOEnvironmentAction() {
  return getQBOEnvironmentInfo()
}

export async function getStripeConnectedAccountAction() {
  return getStripeConnectedAccount()
}

export async function createStripeConnectedAccountOnboardingLinkAction() {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requirePermission("org.admin", { supabase, orgId, userId })
  const link = await createStripeConnectedAccountOnboardingLink(orgId)
  return { url: link.url }
}

export async function refreshStripeConnectedAccountAction() {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requirePermission("org.admin", { supabase, orgId, userId })
  return syncStripeConnectedAccount(orgId)
}

export async function createStripeDashboardLoginLinkAction() {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requirePermission("org.admin", { supabase, orgId, userId })
  const link = await createStripeConnectedAccountDashboardLoginLink(orgId)
  return { url: link.url }
}

export async function getQBODiagnosticsAction() {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requirePermission("org.admin", { supabase, orgId, userId })
  return getQBODiagnostics(orgId)
}

export async function refreshQBOTokenAction() {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requirePermission("org.admin", { supabase, orgId, userId })
  return refreshQBOTokenNow(orgId)
}

export async function retryFailedQBOJobsAction() {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requirePermission("org.admin", { supabase, orgId, userId })
  return retryFailedQBOSyncJobs(orgId)
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
