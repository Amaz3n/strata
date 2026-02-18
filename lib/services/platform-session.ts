import "server-only"

import { cookies } from "next/headers"

import { requireAuth } from "@/lib/auth/context"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

const PLATFORM_CONTEXT_ORG_COOKIE = "platform_context_org_id"
const PLATFORM_CONTEXT_REASON_COOKIE = "platform_context_reason"
const PLATFORM_CONTEXT_STARTED_AT_COOKIE = "platform_context_started_at"

const IMPERSONATION_SESSION_COOKIE = "impersonation_session_id"
const IMPERSONATION_TARGET_COOKIE = "impersonation_target_user_id"
const IMPERSONATION_REASON_COOKIE = "impersonation_reason"
const IMPERSONATION_EXPIRES_AT_COOKIE = "impersonation_expires_at"
const IMPERSONATION_STARTED_AT_COOKIE = "impersonation_started_at"

const ONE_HOUR_SECONDS = 60 * 60

interface CookieWriteOptions {
  maxAge?: number
}

function decodeValue(value?: string | null) {
  if (!value) return null
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

async function setSessionCookie(name: string, value: string, options: CookieWriteOptions = {}) {
  const store = await cookies()
  store.set({
    name,
    value,
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    maxAge: options.maxAge ?? ONE_HOUR_SECONDS,
  })
}

async function setOrgCookie(orgId: string) {
  const store = await cookies()
  store.set({
    name: "org_id",
    value: orgId,
    path: "/",
    httpOnly: false,
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 30,
  })
}

async function clearSessionCookie(name: string) {
  const store = await cookies()
  store.set({
    name,
    value: "",
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    maxAge: 0,
  })
}

async function writeAuditLog(params: {
  actorUserId: string
  orgId?: string | null
  actionKey: string
  decision?: "allow" | "deny"
  reasonCode?: string | null
  impersonationSessionId?: string | null
  context?: Record<string, unknown>
}) {
  try {
    const supabase = createServiceSupabaseClient()
    await supabase.from("authorization_audit_log").insert({
      actor_user_id: params.actorUserId,
      org_id: params.orgId ?? null,
      action_key: params.actionKey,
      decision: params.decision ?? "allow",
      reason_code: params.reasonCode ?? null,
      impersonation_session_id: params.impersonationSessionId ?? null,
      context: params.context ?? {},
    })
  } catch (error) {
    console.error("Failed to write platform session audit log", error)
  }
}

export async function setPlatformOrgContext(orgId: string, reason?: string | null) {
  const { user } = await requireAuth()
  const nowIso = new Date().toISOString()
  const encodedReason = encodeURIComponent((reason ?? "").trim())

  await setOrgCookie(orgId)
  await setSessionCookie(PLATFORM_CONTEXT_ORG_COOKIE, orgId, { maxAge: 60 * 60 * 24 * 30 })
  await setSessionCookie(PLATFORM_CONTEXT_REASON_COOKIE, encodedReason, { maxAge: 60 * 60 * 24 * 30 })
  await setSessionCookie(PLATFORM_CONTEXT_STARTED_AT_COOKIE, nowIso, { maxAge: 60 * 60 * 24 * 30 })

  await writeAuditLog({
    actorUserId: user.id,
    orgId,
    actionKey: "platform.org.access",
    reasonCode: "allow_permission",
    context: {
      reason: (reason ?? "").trim() || null,
      started_at: nowIso,
    },
  })
}

export async function clearPlatformOrgContext() {
  const { user } = await requireAuth()
  const store = await cookies()
  const currentOrgId = store.get(PLATFORM_CONTEXT_ORG_COOKIE)?.value ?? null

  await clearSessionCookie(PLATFORM_CONTEXT_ORG_COOKIE)
  await clearSessionCookie(PLATFORM_CONTEXT_REASON_COOKIE)
  await clearSessionCookie(PLATFORM_CONTEXT_STARTED_AT_COOKIE)
  await clearSessionCookie("org_id")

  await writeAuditLog({
    actorUserId: user.id,
    orgId: currentOrgId,
    actionKey: "platform.org.access",
    reasonCode: "context_exited",
    context: {
      exited: true,
    },
  })
}

export async function findUserByEmail(email: string) {
  const supabase = createServiceSupabaseClient()
  const normalizedEmail = email.trim().toLowerCase()
  if (!normalizedEmail) return null

  const { data, error } = await supabase
    .from("app_users")
    .select("id, email, full_name")
    .ilike("email", normalizedEmail)
    .maybeSingle()

  if (error) {
    throw new Error(`Unable to resolve user by email: ${error.message}`)
  }

  return data
}

export async function startImpersonationSession(input: {
  targetUserId: string
  orgId?: string | null
  reason: string
  expiresInMinutes?: number
}) {
  const { user } = await requireAuth()
  const supabase = createServiceSupabaseClient()

  const expiresInMinutes = Math.min(Math.max(input.expiresInMinutes ?? 60, 5), 240)
  const now = new Date()
  const expiresAt = new Date(now.getTime() + expiresInMinutes * 60 * 1000)

  const { data, error } = await supabase
    .from("impersonation_sessions")
    .insert({
      actor_user_id: user.id,
      target_user_id: input.targetUserId,
      org_id: input.orgId ?? null,
      reason: input.reason.trim(),
      expires_at: expiresAt.toISOString(),
      metadata: {
        started_from: "platform_console",
      },
    })
    .select("id")
    .single()

  if (error || !data) {
    throw new Error(error?.message ?? "Unable to start impersonation session")
  }

  await setSessionCookie(IMPERSONATION_SESSION_COOKIE, data.id, { maxAge: expiresInMinutes * 60 })
  await setSessionCookie(IMPERSONATION_TARGET_COOKIE, input.targetUserId, { maxAge: expiresInMinutes * 60 })
  await setSessionCookie(IMPERSONATION_REASON_COOKIE, encodeURIComponent(input.reason.trim()), {
    maxAge: expiresInMinutes * 60,
  })
  await setSessionCookie(IMPERSONATION_STARTED_AT_COOKIE, now.toISOString(), { maxAge: expiresInMinutes * 60 })
  await setSessionCookie(IMPERSONATION_EXPIRES_AT_COOKIE, expiresAt.toISOString(), { maxAge: expiresInMinutes * 60 })

  if (input.orgId) {
    await setOrgCookie(input.orgId)
    await setSessionCookie(PLATFORM_CONTEXT_ORG_COOKIE, input.orgId, { maxAge: 60 * 60 * 24 * 30 })
    await setSessionCookie(PLATFORM_CONTEXT_STARTED_AT_COOKIE, now.toISOString(), { maxAge: 60 * 60 * 24 * 30 })
  }

  await writeAuditLog({
    actorUserId: user.id,
    orgId: input.orgId ?? null,
    actionKey: "impersonation.start",
    reasonCode: "allow_permission",
    impersonationSessionId: data.id,
    context: {
      target_user_id: input.targetUserId,
      reason: input.reason.trim(),
      expires_at: expiresAt.toISOString(),
    },
  })

  return data.id
}

export async function endImpersonationSession() {
  const { user } = await requireAuth()
  const store = await cookies()
  const sessionId = store.get(IMPERSONATION_SESSION_COOKIE)?.value

  if (sessionId) {
    const supabase = createServiceSupabaseClient()
    const nowIso = new Date().toISOString()
    await supabase
      .from("impersonation_sessions")
      .update({
        status: "ended",
        ended_at: nowIso,
      })
      .eq("id", sessionId)
      .eq("actor_user_id", user.id)
      .eq("status", "active")

    await writeAuditLog({
      actorUserId: user.id,
      actionKey: "impersonation.end",
      reasonCode: "allow_permission",
      impersonationSessionId: sessionId,
      context: {
        ended_at: nowIso,
      },
    })
  }

  await clearSessionCookie(IMPERSONATION_SESSION_COOKIE)
  await clearSessionCookie(IMPERSONATION_TARGET_COOKIE)
  await clearSessionCookie(IMPERSONATION_REASON_COOKIE)
  await clearSessionCookie(IMPERSONATION_EXPIRES_AT_COOKIE)
  await clearSessionCookie(IMPERSONATION_STARTED_AT_COOKIE)
}

export interface PlatformSessionState {
  platformContext: {
    active: boolean
    orgId?: string | null
    orgName?: string | null
    reason?: string | null
    startedAt?: string | null
  }
  impersonation: {
    active: boolean
    sessionId?: string | null
    targetUserId?: string | null
    targetName?: string | null
    targetEmail?: string | null
    reason?: string | null
    startedAt?: string | null
    expiresAt?: string | null
    orgId?: string | null
    orgName?: string | null
  }
}

export async function getPlatformSessionState(): Promise<PlatformSessionState> {
  const store = await cookies()
  const supabase = createServiceSupabaseClient()

  const contextOrgId = store.get(PLATFORM_CONTEXT_ORG_COOKIE)?.value ?? null
  const contextReason = decodeValue(store.get(PLATFORM_CONTEXT_REASON_COOKIE)?.value) ?? null
  const contextStartedAt = store.get(PLATFORM_CONTEXT_STARTED_AT_COOKIE)?.value ?? null

  const impersonationSessionId = store.get(IMPERSONATION_SESSION_COOKIE)?.value ?? null
  const impersonationTargetUserId = store.get(IMPERSONATION_TARGET_COOKIE)?.value ?? null
  const impersonationReason = decodeValue(store.get(IMPERSONATION_REASON_COOKIE)?.value) ?? null
  const impersonationStartedAt = store.get(IMPERSONATION_STARTED_AT_COOKIE)?.value ?? null
  const impersonationExpiresAt = store.get(IMPERSONATION_EXPIRES_AT_COOKIE)?.value ?? null

  const orgIds = [contextOrgId].filter(Boolean) as string[]
  let impersonationOrgId: string | null = null
  if (impersonationSessionId) {
    const { data } = await supabase
      .from("impersonation_sessions")
      .select("org_id")
      .eq("id", impersonationSessionId)
      .maybeSingle()
    impersonationOrgId = (data?.org_id as string | null | undefined) ?? null
    if (impersonationOrgId) orgIds.push(impersonationOrgId)
  }

  const uniqueOrgIds = Array.from(new Set(orgIds))
  const orgNameById = new Map<string, string>()
  if (uniqueOrgIds.length > 0) {
    const { data } = await supabase
      .from("orgs")
      .select("id, name")
      .in("id", uniqueOrgIds)
    for (const row of data ?? []) {
      orgNameById.set(row.id as string, row.name as string)
    }
  }

  let targetName: string | null = null
  let targetEmail: string | null = null
  if (impersonationTargetUserId) {
    const { data } = await supabase
      .from("app_users")
      .select("full_name, email")
      .eq("id", impersonationTargetUserId)
      .maybeSingle()
    targetName = (data?.full_name as string | null | undefined) ?? null
    targetEmail = (data?.email as string | null | undefined) ?? null
  }

  return {
    platformContext: {
      active: Boolean(contextOrgId),
      orgId: contextOrgId,
      orgName: contextOrgId ? orgNameById.get(contextOrgId) ?? null : null,
      reason: contextReason,
      startedAt: contextStartedAt,
    },
    impersonation: {
      active: Boolean(impersonationSessionId),
      sessionId: impersonationSessionId,
      targetUserId: impersonationTargetUserId,
      targetName,
      targetEmail,
      reason: impersonationReason,
      startedAt: impersonationStartedAt,
      expiresAt: impersonationExpiresAt,
      orgId: impersonationOrgId,
      orgName: impersonationOrgId ? orgNameById.get(impersonationOrgId) ?? null : null,
    },
  }
}
