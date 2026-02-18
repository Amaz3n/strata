'use server'

import { randomUUID } from "crypto"
import { cookies } from "next/headers"

import { getQBOAuthUrl } from "@/lib/integrations/accounting/qbo-auth"
import { disconnectQBO, getQBOConnection, getQBODiagnostics, refreshQBOTokenNow, updateQBOSettings } from "@/lib/services/qbo-connection"
import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"
import { retryFailedQBOSyncJobs } from "@/lib/services/qbo-sync"

export async function connectQBOAction() {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requirePermission("org.admin", { supabase, orgId, userId })

  const state = `${orgId}:${randomUUID()}`
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
