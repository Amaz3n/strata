import "server-only"

import { cookies } from "next/headers"
import { z } from "zod"

import { requireAuth } from "@/lib/auth/context"
import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { requireAnyPermission } from "@/lib/services/permissions"
import { requireAnyPlatformPermission } from "@/lib/services/platform-access"
import { createServerSupabaseClient, createServiceSupabaseClient } from "@/lib/supabase/server"
import {
  enterPlatformOrgSchema,
  platformAccessReasonSchema,
  revokePlatformAccessGrantSchema,
  type EnterPlatformOrgInput,
  type RevokePlatformAccessGrantInput,
} from "@/lib/validation/platform-access"

// Which organization the operator entered. A hint for the session control only:
// authority comes from the grant row, re-read on every request.
const PLATFORM_CONTEXT_ORG_COOKIE = "platform_context_org_id"

const IMPERSONATION_SESSION_COOKIE = "impersonation_session_id"

const ONE_HOUR_SECONDS = 60 * 60
const SUPPORT_ACCESS_HISTORY_DAYS = 90
const SUPPORT_ACCESS_HISTORY_LIMIT = 50

interface CookieWriteOptions {
  maxAge?: number
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
  resourceId?: string | null
  context?: Record<string, unknown>
}) {
  const { error } = await createServiceSupabaseClient()
    .from("authorization_audit_log")
    .insert({
      actor_user_id: params.actorUserId,
      org_id: params.orgId ?? null,
      action_key: params.actionKey,
      decision: params.decision ?? "allow",
      reason_code: params.reasonCode ?? null,
      impersonation_session_id: params.impersonationSessionId ?? null,
      resource_type: params.resourceId ? "platform_access_grant" : null,
      resource_id: params.resourceId ?? null,
      context: params.context ?? {},
    })
  if (error) throw new Error(`Unable to record platform access: ${error.message}`)
}

export interface PlatformAccessGrant {
  id: string
  orgId: string
  operatorUserId: string
  operatorEmail: string
  reason: string
  impersonationSessionId: string | null
  grantedAt: string
  expiresAt: string
  endedAt: string | null
}

const grantRowsSchema = z.array(
  z.object({
    id: z.string(),
    org_id: z.string(),
    operator_user_id: z.string(),
    operator_email: z.string(),
    reason: z.string(),
    impersonation_session_id: z.string().nullable(),
    granted_at: z.string(),
    expires_at: z.string(),
    ended_at: z.string().nullable(),
  }),
)

type PlatformAccessGrantRow = z.infer<typeof grantRowsSchema>[number]

const GRANT_COLUMNS =
  "id, org_id, operator_user_id, operator_email, reason, impersonation_session_id, granted_at, expires_at, ended_at"

function mapGrant(row: PlatformAccessGrantRow): PlatformAccessGrant {
  return {
    id: row.id,
    orgId: row.org_id,
    operatorUserId: row.operator_user_id,
    operatorEmail: row.operator_email,
    reason: row.reason,
    impersonationSessionId: row.impersonation_session_id,
    grantedAt: row.granted_at,
    expiresAt: row.expires_at,
    endedAt: row.ended_at,
  }
}

/**
 * Open a support-access grant. The grant row and its audit row are written in
 * one transaction by the database, and its times come from the database clock,
 * so access that exists is access that was logged and bounded. A failure here
 * is a failure to enter: nothing else is written.
 */
async function openPlatformAccessGrant(input: {
  orgId: string
  operatorUserId: string
  operatorEmail: string | null | undefined
  reason: string
  minutes: number
  impersonationSessionId?: string | null
}): Promise<PlatformAccessGrant> {
  if (!input.operatorEmail) throw new Error("Your account needs an email address to access an organization.")
  const { data, error } = await createServiceSupabaseClient()
    .rpc("open_platform_access_grant", {
      p_org_id: input.orgId,
      p_operator_user_id: input.operatorUserId,
      p_operator_email: input.operatorEmail,
      p_reason: input.reason,
      p_minutes: input.minutes,
      p_impersonation_session_id: input.impersonationSessionId ?? null,
    })
  if (error) throw new Error(`Unable to open support access: ${error.message}`)
  return mapGrant(grantRowsSchema.element.parse(data))
}

/** Open, unexpired grants of one operator, evaluated against the database clock. */
async function listActiveGrantsForOperator(operatorUserId: string, orgId?: string | null) {
  const { data, error } = await createServiceSupabaseClient()
    .rpc("active_platform_access_grants", { p_operator_user_id: operatorUserId, p_org_id: orgId ?? null })
  if (error) throw new Error(`Unable to load support access: ${error.message}`)
  return grantRowsSchema.parse(data ?? []).map(mapGrant)
}

/** The organizations this operator may currently enter without a new grant. */
export async function listActivePlatformAccessGrants(): Promise<PlatformAccessGrant[]> {
  const { user } = await requireAuth()
  return listActiveGrantsForOperator(user.id)
}

/**
 * Enter a customer's organization as Arc support. Requires a reason and a
 * duration (at most eight hours); the operator has the organization's
 * owner-level view only while the grant this opens is open and unexpired.
 */
export async function setPlatformOrgContext(input: EnterPlatformOrgInput): Promise<PlatformAccessGrant> {
  const { orgId, reason, durationMinutes } = enterPlatformOrgSchema.parse(input)
  const user = await requireAnyPlatformPermission(["platform.org.access"])

  const grant = await openPlatformAccessGrant({
    orgId,
    operatorUserId: user.id,
    operatorEmail: user.email,
    reason,
    minutes: durationMinutes,
  })

  await setOrgCookie(orgId)
  await setSessionCookie(PLATFORM_CONTEXT_ORG_COOKIE, orgId, { maxAge: durationMinutes * 60 })
  return grant
}

/** End the operator's support access to the organization they are in. */
export async function clearPlatformOrgContext() {
  const { user } = await requireAuth()
  const store = await cookies()
  const currentOrgId = store.get(PLATFORM_CONTEXT_ORG_COOKIE)?.value ?? store.get("org_id")?.value ?? null

  if (currentOrgId) {
    const { data, error } = await createServiceSupabaseClient()
      .from("platform_access_grants")
      .update({ ended_at: new Date().toISOString(), ended_by: user.id })
      .eq("org_id", currentOrgId)
      .eq("operator_user_id", user.id)
      .is("ended_at", null)
      .select("id")
    if (error) throw new Error(`Unable to end support access: ${error.message}`)

    await writeAuditLog({
      actorUserId: user.id,
      orgId: currentOrgId,
      actionKey: "platform.org.access",
      reasonCode: "grant_ended",
      context: { grant_ids: (data ?? []).map((row) => row.id as string) },
    })
  }

  await clearSessionCookie(PLATFORM_CONTEXT_ORG_COOKIE)
  await clearSessionCookie("org_id")
}

export interface OrgSupportAccessHistory {
  grants: PlatformAccessGrant[]
  /** More grants exist in the window than were returned. */
  truncated: boolean
}

/**
 * Arc support's access to the current organization over the last 90 days, for
 * the customer's administrators. Read with the member's own session so the
 * table's row-level security decides who may see it.
 */
export async function listOrgSupportAccess(): Promise<OrgSupportAccessHistory> {
  const context = await requireOrgContext(undefined, { allowLocked: true })
  const since = new Date(Date.now() - SUPPORT_ACCESS_HISTORY_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const supabase = await createServerSupabaseClient()
  const { data, error } = await supabase
    .from("platform_access_grants")
    .select(GRANT_COLUMNS)
    .eq("org_id", context.orgId)
    .gte("granted_at", since)
    .order("granted_at", { ascending: false })
    .limit(SUPPORT_ACCESS_HISTORY_LIMIT + 1)
    .returns<PlatformAccessGrantRow[]>()
  if (error) throw new Error(`Unable to load support access: ${error.message}`)
  const rows = data ?? []
  return {
    grants: rows.slice(0, SUPPORT_ACCESS_HISTORY_LIMIT).map(mapGrant),
    truncated: rows.length > SUPPORT_ACCESS_HISTORY_LIMIT,
  }
}

/** A customer administrator ends Arc support's access to their organization. */
export async function revokePlatformAccessGrant(input: RevokePlatformAccessGrantInput): Promise<PlatformAccessGrant> {
  const { grantId } = revokePlatformAccessGrantSchema.parse(input)
  const context = await requireOrgContext()
  await requireAnyPermission(["members.manage", "org.admin"], {
    userId: context.userId,
    orgId: context.orgId,
    supabase: context.supabase,
  })

  const { data, error } = await createServiceSupabaseClient()
    .from("platform_access_grants")
    .update({ ended_at: new Date().toISOString(), ended_by: context.userId })
    .eq("id", grantId)
    .eq("org_id", context.orgId)
    .is("ended_at", null)
    .select(GRANT_COLUMNS)
    .maybeSingle<PlatformAccessGrantRow>()
  if (error) throw new Error(`Unable to end support access: ${error.message}`)
  if (!data) throw new Error("This support access has already ended.")
  const grant = mapGrant(data)

  await writeAuditLog({
    actorUserId: context.userId,
    orgId: context.orgId,
    actionKey: "platform.org.access",
    reasonCode: "grant_revoked_by_org",
    resourceId: grant.id,
    context: { operator_user_id: grant.operatorUserId },
  })
  await recordAudit({
    orgId: context.orgId,
    actorId: context.userId,
    action: "update",
    entityType: "platform_access_grant",
    entityId: grant.id,
    after: data,
  })
  await recordEvent({
    orgId: context.orgId,
    actorId: context.userId,
    eventType: "platform_access_revoked",
    entityType: "platform_access_grant",
    entityId: grant.id,
    payload: { operator_email: grant.operatorEmail },
  })

  return grant
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

/**
 * Start an impersonation session. When it names an organization it also opens
 * the support-access grant for that organization with the session's expiry, so
 * the session's end is the end of access, not just of a label.
 */
export async function startImpersonationSession(input: {
  targetUserId: string
  orgId?: string | null
  reason: string
  expiresInMinutes?: number
}) {
  const reason = platformAccessReasonSchema.parse(input.reason)
  const user = await requireAnyPlatformPermission(["impersonation.start"])
  const supabase = createServiceSupabaseClient()

  const expiresInMinutes = Math.min(Math.max(input.expiresInMinutes ?? 60, 5), 240)
  const expiresAt = new Date(Date.now() + expiresInMinutes * 60 * 1000)

  const { data, error } = await supabase
    .from("impersonation_sessions")
    .insert({
      actor_user_id: user.id,
      target_user_id: input.targetUserId,
      org_id: input.orgId ?? null,
      reason,
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

  if (input.orgId) {
    try {
      await openPlatformAccessGrant({
        orgId: input.orgId,
        operatorUserId: user.id,
        operatorEmail: user.email,
        reason,
        minutes: expiresInMinutes,
        impersonationSessionId: data.id,
      })
    } catch (grantError) {
      await supabase
        .from("impersonation_sessions")
        .update({ status: "revoked", ended_at: new Date().toISOString() })
        .eq("id", data.id)
      throw grantError
    }
  }

  await writeAuditLog({
    actorUserId: user.id,
    orgId: input.orgId ?? null,
    actionKey: "impersonation.start",
    reasonCode: "allow_permission",
    impersonationSessionId: data.id,
    context: {
      target_user_id: input.targetUserId,
      reason,
      expires_at: expiresAt.toISOString(),
    },
  })

  await setSessionCookie(IMPERSONATION_SESSION_COOKIE, data.id, { maxAge: expiresInMinutes * 60 })
  if (input.orgId) {
    await setOrgCookie(input.orgId)
    await setSessionCookie(PLATFORM_CONTEXT_ORG_COOKIE, input.orgId, { maxAge: expiresInMinutes * 60 })
  }

  return data.id
}

export async function endImpersonationSession() {
  const { user } = await requireAuth()
  const store = await cookies()
  const sessionId = store.get(IMPERSONATION_SESSION_COOKIE)?.value

  if (sessionId) {
    const supabase = createServiceSupabaseClient()
    const nowIso = new Date().toISOString()
    const [sessionResult, grantResult] = await Promise.all([
      supabase
        .from("impersonation_sessions")
        .update({ status: "ended", ended_at: nowIso })
        .eq("id", sessionId)
        .eq("actor_user_id", user.id)
        .eq("status", "active"),
      supabase
        .from("platform_access_grants")
        .update({ ended_at: nowIso, ended_by: user.id })
        .eq("impersonation_session_id", sessionId)
        .eq("operator_user_id", user.id)
        .is("ended_at", null),
    ])
    const endError = sessionResult.error ?? grantResult.error
    if (endError) throw new Error(`Unable to end impersonation: ${endError.message}`)

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
  await clearSessionCookie(PLATFORM_CONTEXT_ORG_COOKIE)
}

export interface PlatformSessionState {
  platformContext: {
    active: boolean
    orgId?: string | null
    orgName?: string | null
    reason?: string | null
    startedAt?: string | null
    expiresAt?: string | null
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

const NO_SESSION: PlatformSessionState = {
  platformContext: { active: false },
  impersonation: { active: false },
}

/**
 * The operator's elevated session, as the database says it stands now. The
 * cookies only say where to look: an expired or ended grant or impersonation
 * session reads as inactive even while its cookie lingers.
 */
export async function getPlatformSessionState(): Promise<PlatformSessionState> {
  const store = await cookies()
  const contextOrgId = store.get(PLATFORM_CONTEXT_ORG_COOKIE)?.value ?? null
  const impersonationSessionId = store.get(IMPERSONATION_SESSION_COOKIE)?.value ?? null
  if (!contextOrgId && !impersonationSessionId) return NO_SESSION

  const { user } = await requireAuth()
  const supabase = createServiceSupabaseClient()

  const [grants, sessionResult] = await Promise.all([
    contextOrgId ? listActiveGrantsForOperator(user.id, contextOrgId) : Promise.resolve([]),
    impersonationSessionId
      ? supabase
          .from("impersonation_sessions")
          .select("id, org_id, target_user_id, reason, started_at, expires_at")
          .eq("id", impersonationSessionId)
          .eq("actor_user_id", user.id)
          .eq("status", "active")
          // Postgres' clock ("now" is a timestamptz literal): this renders inside
          // the app chrome's private cache, which cannot read a JS clock.
          .gt("expires_at", "now")
          .maybeSingle()
      : Promise.resolve(null),
  ])
  if (sessionResult?.error) throw new Error(`Unable to load impersonation: ${sessionResult.error.message}`)

  const grant = grants[0] ?? null
  const session = sessionResult?.data ?? null
  const impersonationOrgId = (session?.org_id as string | null | undefined) ?? null
  const targetUserId = (session?.target_user_id as string | undefined) ?? null
  const orgIds = Array.from(new Set([grant?.orgId, impersonationOrgId].filter((value): value is string => Boolean(value))))

  const [orgsResult, targetResult] = await Promise.all([
    orgIds.length > 0 ? supabase.from("orgs").select("id, name").in("id", orgIds) : Promise.resolve(null),
    targetUserId
      ? supabase.from("app_users").select("full_name, email").eq("id", targetUserId).maybeSingle()
      : Promise.resolve(null),
  ])
  const orgNameById = new Map<string, string>()
  for (const row of orgsResult?.data ?? []) {
    orgNameById.set(row.id as string, row.name as string)
  }

  return {
    platformContext: grant
      ? {
          active: true,
          orgId: grant.orgId,
          orgName: orgNameById.get(grant.orgId) ?? null,
          reason: grant.reason,
          startedAt: grant.grantedAt,
          expiresAt: grant.expiresAt,
        }
      : { active: false },
    impersonation: session
      ? {
          active: true,
          sessionId: session.id as string,
          targetUserId,
          targetName: (targetResult?.data?.full_name as string | null | undefined) ?? null,
          targetEmail: (targetResult?.data?.email as string | null | undefined) ?? null,
          reason: (session.reason as string | null | undefined) ?? null,
          startedAt: (session.started_at as string | null | undefined) ?? null,
          expiresAt: (session.expires_at as string | null | undefined) ?? null,
          orgId: impersonationOrgId,
          orgName: impersonationOrgId ? orgNameById.get(impersonationOrgId) ?? null : null,
        }
      : { active: false },
  }
}
