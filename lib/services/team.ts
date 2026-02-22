import type { SupabaseClient } from "@supabase/supabase-js"

import { randomBytes } from "node:crypto"

import type { TeamMember, OrgRole, OrgRoleOption } from "@/lib/types"
import { inviteMemberSchema, memberStatusSchema, updateMemberRoleSchema, type InviteMemberInput } from "@/lib/validation/team"
import { requireOrgContext } from "@/lib/services/context"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { recordEvent } from "@/lib/services/events"
import { recordAudit } from "@/lib/services/audit"
import { sendInviteEmail } from "@/lib/services/mailer"
import { authorize, requireAuthorization } from "@/lib/services/authorization"

async function resolveRoleId(client: SupabaseClient, role: OrgRole) {
  const { data, error } = await client.from("roles").select("id").eq("scope", "org").eq("key", role).maybeSingle()
  if (error || !data?.id) {
    throw new Error(`Role ${role} not found`)
  }
  return data.id as string
}

function normalizeRoleLabel(label: string | null | undefined, roleKey: string) {
  const candidate = (label ?? "")
    .replace(/^org[\s_-]+/i, "")
    .trim()
  if (candidate) return candidate
  return roleKey
    .replace(/^org_/, "")
    .split("_")
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(" ")
}

function defaultRoleDescription(roleKey: string) {
  const descriptions: Record<string, string> = {
    org_owner: "Full account control, including organization settings, billing, and team role management.",
    org_office_admin: "Administrative control across projects and teams, including member management and business operations.",
    org_project_lead: "Execution-focused access for project delivery, field workflows, and day-to-day coordination.",
    org_viewer: "View-only access across shared data with no write or approval permissions.",
  }

  return descriptions[roleKey]
}

export async function listAssignableOrgRoles(orgId?: string): Promise<OrgRoleOption[]> {
  const { orgId: resolvedOrgId, userId, supabase } = await requireOrgContext(orgId)
  const adminDecision = await authorize({
    permission: "org.admin",
    userId,
    orgId: resolvedOrgId,
    supabase,
    logDecision: true,
    resourceType: "org",
    resourceId: resolvedOrgId,
  })

  if (!adminDecision.allowed) {
    await requireAuthorization({
      permission: "members.manage",
      userId,
      orgId: resolvedOrgId,
      supabase,
      logDecision: true,
      resourceType: "org",
      resourceId: resolvedOrgId,
    })
  }

  const serviceClient = createServiceSupabaseClient()
  const { data, error } = await serviceClient
    .from("roles")
    .select("key, label, description")
    .eq("scope", "org")
    .order("label", { ascending: true })

  if (error) {
    throw new Error(`Failed to load assignable org roles: ${error.message}`)
  }

  const allowedRoleKeys = new Set(["org_owner", "org_office_admin", "org_project_lead", "org_viewer"])
  const options = (data ?? [])
    .filter((row: any) => typeof row?.key === "string" && allowedRoleKeys.has(row.key))
    .map((row: any) => ({
      key: row.key as string,
      label: normalizeRoleLabel((row.label as string | null) ?? null, row.key as string),
      description: ((row.description as string | null) ?? undefined) ?? defaultRoleDescription(row.key as string),
    }))

  if (options.length > 0) {
    return Array.from(allowedRoleKeys)
      .map((key) => options.find((option) => option.key === key))
      .filter((option): option is OrgRoleOption => Boolean(option))
  }

  return [
    {
      key: "org_owner",
      label: "Owner",
      description: defaultRoleDescription("org_owner"),
    },
    {
      key: "org_office_admin",
      label: "Office Admin",
      description: defaultRoleDescription("org_office_admin"),
    },
    {
      key: "org_project_lead",
      label: "Project Lead",
      description: defaultRoleDescription("org_project_lead"),
    },
    {
      key: "org_viewer",
      label: "Viewer",
      description: defaultRoleDescription("org_viewer"),
    },
  ]
}

function getAuthRedirectBaseUrl() {
  const url =
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    process.env.APP_URL ||
    process.env.VERCEL_URL ||
    "http://localhost:3000"

  if (url.startsWith("http")) return url.replace(/\/$/, "")
  return `https://${url}`.replace(/\/$/, "")
}

function generateInviteToken() {
  return randomBytes(32).toString("base64url")
}

function getInviteLink(token: string) {
  const baseUrl = getAuthRedirectBaseUrl()
  return `${baseUrl}/auth/accept-invite?token=${token}`
}

// Token expires in 7 days
function getInviteTokenExpiry() {
  return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
}

async function mapProjectCounts(supabase: SupabaseClient, orgId: string) {
  const { data, error } = await supabase.from("project_members").select("user_id").eq("org_id", orgId)
  if (error) {
    console.error("Failed to load project membership counts", error)
    return {}
  }

  return (data ?? []).reduce<Record<string, number>>((acc, row) => {
    if (!row.user_id) return acc
    acc[row.user_id] = (acc[row.user_id] ?? 0) + 1
    return acc
  }, {})
}

async function mapMfaEnabledByUser(serviceClient: SupabaseClient, userIds: string[]) {
  if (userIds.length === 0) return {}
  const output: Record<string, boolean> = {}

  await Promise.all(
    userIds.map(async (memberUserId) => {
      const { data, error } = await serviceClient.auth.admin.mfa.listFactors({ userId: memberUserId })
      if (error) {
        console.error("Failed to load member MFA factors", { memberUserId, error })
        output[memberUserId] = false
        return
      }

      output[memberUserId] = (data.factors ?? []).some((factor) => factor.status === "verified")
    }),
  )

  return output
}

function generateTempPassword() {
  return randomBytes(12).toString("base64url").slice(0, 16)
}

function shouldBypassInviteRateLimit(message: string) {
  return process.env.NODE_ENV === "development" && /rate limit/i.test(message)
}

async function getOrgBrand(client: SupabaseClient, orgId: string) {
  const { data, error } = await client.from("orgs").select("name, logo_url").eq("id", orgId).maybeSingle()
  if (error) {
    console.error("Failed to load org brand", error)
    return { name: null, logoUrl: null }
  }
  return { name: data?.name ?? null, logoUrl: data?.logo_url ?? null }
}

async function createUserForInvite(client: SupabaseClient, email: string) {
  // Create user with a temporary password - they'll set their real password when accepting
  const tempPassword = generateTempPassword()
  const { data, error } = await client.auth.admin.createUser({
    email,
    password: tempPassword,
    email_confirm: true, // Skip email confirmation since we're handling invite flow ourselves
  })
  if (error) {
    // User might already exist
    if (error.message.includes("already been registered")) {
      const { data: existingUser } = await client
        .from("app_users")
        .select("id")
        .ilike("email", email)
        .maybeSingle()
      return { userId: existingUser?.id as string | undefined, isExisting: true }
    }
    throw new Error(error.message)
  }
  return { userId: data?.user?.id, isExisting: false }
}

function mapTeamMember(row: any, projectCounts: Record<string, number>, mfaEnabledByUser: Record<string, boolean>): TeamMember {
  const user = row.user || row.users
  const invitedBy = row.invited_by_user || row.invited_by
  const roleKey = row.role?.key ?? "org_project_lead"

  return {
    id: row.id,
    user: {
      id: user?.id,
      email: user?.email,
      full_name: user?.full_name ?? user?.email ?? "Unknown",
      avatar_url: user?.avatar_url ?? undefined,
    },
    role: roleKey,
    role_label: normalizeRoleLabel((row.role?.label as string | null) ?? null, roleKey),
    status: row.status ?? "invited",
    mfa_enabled: Boolean(user?.id ? mfaEnabledByUser[user.id] : false),
    project_count: projectCounts[user?.id] ?? 0,
    last_active_at: row.last_active_at ?? undefined,
    invited_by: invitedBy
      ? {
          id: invitedBy.id,
          email: invitedBy.email,
          full_name: invitedBy.full_name ?? invitedBy.email ?? "Unknown",
          avatar_url: invitedBy.avatar_url ?? undefined,
        }
      : undefined,
    created_at: row.created_at,
  }
}

export async function listTeamMembers(
  orgId?: string,
  options?: { includeProjectCounts?: boolean },
): Promise<TeamMember[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const memberDecision = await authorize({
    permission: "org.member",
    userId,
    orgId: resolvedOrgId,
    supabase,
    logDecision: true,
    resourceType: "org",
    resourceId: resolvedOrgId,
  })
  if (!memberDecision.allowed) {
    await requireAuthorization({
      permission: "org.read",
      userId,
      orgId: resolvedOrgId,
      supabase,
      logDecision: true,
      resourceType: "org",
      resourceId: resolvedOrgId,
    })
  }
  const serviceClient = createServiceSupabaseClient()
  const includeProjectCounts = options?.includeProjectCounts ?? true
  const projectCounts = includeProjectCounts ? await mapProjectCounts(serviceClient, resolvedOrgId) : {}

  const { data, error } = await serviceClient
    .from("memberships")
    .select(
      `
      id, org_id, user_id, role_id, status, last_active_at, created_at, invited_by,
      user:app_users!memberships_user_id_fkey(id, email, full_name, avatar_url),
      role:roles!memberships_role_id_fkey(key, label),
      invited_by_user:app_users!memberships_invited_by_fkey(id, email, full_name, avatar_url)
    `,
    )
    .eq("org_id", resolvedOrgId)
    .order("created_at", { ascending: true })

  if (error) {
    throw new Error(`Failed to list team members: ${error.message}`)
  }

  const userIds = (data ?? [])
    .map((row: any) => {
      const user = row.user || row.users
      return user?.id as string | undefined
    })
    .filter((id: string | undefined): id is string => Boolean(id))
  const mfaEnabledByUser = await mapMfaEnabledByUser(serviceClient, userIds)

  return (data ?? []).map((row) => mapTeamMember(row, projectCounts, mfaEnabledByUser))
}

export async function updateMemberProfile({
  userId: targetUserId,
  fullName,
  orgId,
}: {
  userId: string
  fullName: string
  orgId?: string
}) {
  const normalizedName = fullName.trim()
  if (!normalizedName) {
    throw new Error("Name is required")
  }

  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAuthorization({
    permission: "members.manage",
    userId,
    orgId: resolvedOrgId,
    supabase,
    logDecision: true,
    resourceType: "app_user",
    resourceId: targetUserId,
  })

  const serviceClient = createServiceSupabaseClient()

  const { data: membership, error: membershipError } = await serviceClient
    .from("memberships")
    .select("id, org_id, user_id")
    .eq("org_id", resolvedOrgId)
    .eq("user_id", targetUserId)
    .maybeSingle()

  if (membershipError || !membership) {
    throw new Error("Membership not found")
  }

  const { data: existingUser } = await serviceClient
    .from("app_users")
    .select("id, full_name, email, avatar_url")
    .eq("id", targetUserId)
    .maybeSingle()

  const { data, error } = await serviceClient
    .from("app_users")
    .update({ full_name: normalizedName })
    .eq("id", targetUserId)
    .select("id, full_name, email, avatar_url")
    .maybeSingle()

  if (error || !data) {
    throw new Error(`Failed to update member profile: ${error?.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "app_user",
    entityId: data.id as string,
    before: existingUser,
    after: data,
  })

  return data
}

export async function inviteTeamMember({
  input,
  orgId,
}: {
  input: InviteMemberInput
  orgId?: string
}): Promise<TeamMember & { tempPassword?: string }> {
  const parsed = inviteMemberSchema.parse(input)
  const { orgId: resolvedOrgId, userId, supabase } = await requireOrgContext(orgId)
  await requireAuthorization({
    permission: "members.manage",
    userId,
    orgId: resolvedOrgId,
    supabase,
    logDecision: true,
    resourceType: "org",
    resourceId: resolvedOrgId,
  })
  const serviceClient = createServiceSupabaseClient()

  const { data: existingUser } = await serviceClient
    .from("app_users")
    .select("id, email, full_name, avatar_url")
    .ilike("email", parsed.email)
    .maybeSingle()

  let targetUserId = existingUser?.id as string | undefined

  // Create user if they don't exist
  if (!targetUserId) {
    const result = await createUserForInvite(serviceClient, parsed.email)
    targetUserId = result.userId
  }

  if (!targetUserId) {
    throw new Error("Unable to resolve invited user id")
  }

  const { error: profileError } = await serviceClient
    .from("app_users")
    .upsert({
      id: targetUserId,
      email: parsed.email,
      full_name: existingUser?.full_name ?? null,
    })

  if (profileError) {
    console.error("Failed to create user profile for invite", profileError)
    throw new Error("Failed to create invited user profile")
  }

  const roleId = await resolveRoleId(serviceClient, parsed.role)

  // Generate invite token
  const inviteToken = generateInviteToken()
  const inviteTokenExpiresAt = getInviteTokenExpiry()

  const { data, error } = await serviceClient
    .from("memberships")
    .upsert({
      org_id: resolvedOrgId,
      user_id: targetUserId,
      role_id: roleId,
      status: "invited",
      invited_by: userId,
      invite_token: inviteToken,
      invite_token_expires_at: inviteTokenExpiresAt.toISOString(),
    })
    .select(
      `
      id, org_id, user_id, role_id, status, last_active_at, created_at, invited_by,
      user:app_users!memberships_user_id_fkey(id, email, full_name, avatar_url),
      role:roles!memberships_role_id_fkey(key, label),
      invited_by_user:app_users!memberships_invited_by_fkey(id, email, full_name, avatar_url)
    `,
    )
    .maybeSingle()

  if (error || !data) {
    throw new Error(`Failed to create membership: ${error?.message}`)
  }

  // Send invite email with our token-based link
  const orgBrand = await getOrgBrand(serviceClient, resolvedOrgId)
  const inviteLink = getInviteLink(inviteToken)
  const inviter = data.invited_by_user as { full_name?: string | null; email?: string | null } | null
  await sendInviteEmail({
    to: parsed.email,
    inviteLink,
    orgName: orgBrand.name,
    orgLogoUrl: orgBrand.logoUrl,
    inviterName: inviter?.full_name ?? null,
    inviterEmail: inviter?.email ?? null,
  })

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "team_member_invited",
    entityType: "membership",
    entityId: data.id as string,
    payload: { email: parsed.email, role: parsed.role },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "membership",
    entityId: data.id as string,
    after: data,
  })

  const projectCounts = await mapProjectCounts(serviceClient, resolvedOrgId)
  const selectedUser = Array.isArray((data as any).user) ? (data as any).user[0] : (data as any).user
  const mfaEnabledByUser = await mapMfaEnabledByUser(serviceClient, [selectedUser?.id].filter(Boolean))
  return mapTeamMember(data, projectCounts, mfaEnabledByUser)
}

export async function updateMemberRole({
  membershipId,
  role,
  orgId,
}: {
  membershipId: string
  role: OrgRole
  orgId?: string
}) {
  const parsed = updateMemberRoleSchema.parse({ role })
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAuthorization({
    permission: "org.admin",
    userId,
    orgId: resolvedOrgId,
    supabase,
    logDecision: true,
    resourceType: "membership",
    resourceId: membershipId,
  })
  const serviceClient = createServiceSupabaseClient()
  const roleId = await resolveRoleId(serviceClient, parsed.role)

  const { data: existing, error: fetchError } = await supabase
    .from("memberships")
    .select("id, org_id, user_id, role_id, status, created_at")
    .eq("org_id", resolvedOrgId)
    .eq("id", membershipId)
    .maybeSingle()

  if (fetchError || !existing) {
    throw new Error("Membership not found")
  }

  const { data, error } = await supabase
    .from("memberships")
    .update({ role_id: roleId })
    .eq("org_id", resolvedOrgId)
    .eq("id", membershipId)
    .select(
      `
      id, org_id, user_id, role_id, status, last_active_at, created_at, invited_by,
      user:app_users!memberships_user_id_fkey(id, email, full_name, avatar_url),
      role:roles!memberships_role_id_fkey(key, label)
    `,
    )
    .maybeSingle()

  if (error || !data) {
    throw new Error(`Failed to update member role: ${error?.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "membership",
    entityId: data.id as string,
    before: existing,
    after: data,
  })

  const projectCounts = await mapProjectCounts(supabase, resolvedOrgId)
  const selectedUser = Array.isArray((data as any).user) ? (data as any).user[0] : (data as any).user
  const mfaEnabledByUser = await mapMfaEnabledByUser(serviceClient, [selectedUser?.id].filter(Boolean))
  return mapTeamMember(data, projectCounts, mfaEnabledByUser)
}

async function updateMemberStatus(membershipId: string, status: "active" | "invited" | "suspended", orgId?: string) {
  memberStatusSchema.parse({ status })
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAuthorization({
    permission: "members.manage",
    userId,
    orgId: resolvedOrgId,
    supabase,
    logDecision: true,
    resourceType: "membership",
    resourceId: membershipId,
  })

  const { data: existing, error: fetchError } = await supabase
    .from("memberships")
    .select("id, org_id, user_id, role_id, status, created_at")
    .eq("org_id", resolvedOrgId)
    .eq("id", membershipId)
    .maybeSingle()

  if (fetchError || !existing) {
    throw new Error("Membership not found")
  }

  const { data, error } = await supabase
    .from("memberships")
    .update({ status })
    .eq("org_id", resolvedOrgId)
    .eq("id", membershipId)
    .select(
      `
      id, org_id, user_id, role_id, status, last_active_at, created_at, invited_by,
      user:app_users!memberships_user_id_fkey(id, email, full_name, avatar_url),
      role:roles!memberships_role_id_fkey(key, label)
    `,
    )
    .maybeSingle()

  if (error || !data) {
    throw new Error(`Failed to update member status: ${error?.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "membership",
    entityId: data.id as string,
    before: existing,
    after: data,
  })

  const projectCounts = await mapProjectCounts(supabase, resolvedOrgId)
  const selectedUser = Array.isArray((data as any).user) ? (data as any).user[0] : (data as any).user
  const mfaEnabledByUser = await mapMfaEnabledByUser(createServiceSupabaseClient(), [selectedUser?.id].filter(Boolean))
  return mapTeamMember(data, projectCounts, mfaEnabledByUser)
}

export function suspendMember(membershipId: string, orgId?: string) {
  return updateMemberStatus(membershipId, "suspended", orgId)
}

export function reactivateMember(membershipId: string, orgId?: string) {
  return updateMemberStatus(membershipId, "active", orgId)
}

export async function removeMember(membershipId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAuthorization({
    permission: "members.manage",
    userId,
    orgId: resolvedOrgId,
    supabase,
    logDecision: true,
    resourceType: "membership",
    resourceId: membershipId,
  })

  const { data: membership, error: fetchError } = await supabase
    .from("memberships")
    .select("id, org_id, user_id, role_id, status")
    .eq("org_id", resolvedOrgId)
    .eq("id", membershipId)
    .maybeSingle()

  if (fetchError || !membership) {
    throw new Error("Membership not found")
  }

  const { count: projectAssignments, error: projectError } = await supabase
    .from("project_members")
    .select("id", { count: "exact", head: true })
    .eq("org_id", resolvedOrgId)
    .eq("user_id", membership.user_id)

  if (projectError) {
    console.error("Failed to check project assignments", projectError)
  } else if ((projectAssignments ?? 0) > 0) {
    throw new Error("Cannot remove member with active project assignments")
  }

  const { error } = await supabase.from("memberships").delete().eq("org_id", resolvedOrgId).eq("id", membershipId)

  if (error) {
    throw new Error(`Failed to remove member: ${error.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "delete",
    entityType: "membership",
    entityId: membershipId,
    before: membership,
    after: null,
  })

  return true
}

export async function resendInvite(membershipId: string, orgId?: string) {
  const { orgId: resolvedOrgId, supabase, userId } = await requireOrgContext(orgId)
  await requireAuthorization({
    permission: "members.manage",
    userId,
    orgId: resolvedOrgId,
    supabase,
    logDecision: true,
    resourceType: "membership",
    resourceId: membershipId,
  })
  const serviceClient = createServiceSupabaseClient()

  const { data, error } = await serviceClient
    .from("memberships")
    .select("id, org_id, user_id, status, user:app_users(id, email)")
    .eq("org_id", resolvedOrgId)
    .eq("id", membershipId)
    .maybeSingle()

  if (error || !data) {
    throw new Error("Membership not found for resend")
  }

  const user = Array.isArray(data.user) ? data.user[0] : data.user
  const email = user?.email
  if (!email) {
    throw new Error("Membership user email missing")
  }

  // Get the current user's info (the person resending the invite)
  const { data: inviterData } = await serviceClient
    .from("app_users")
    .select("full_name, email")
    .eq("id", userId)
    .maybeSingle()

  // Generate new invite token
  const inviteToken = generateInviteToken()
  const inviteTokenExpiresAt = getInviteTokenExpiry()

  // Update membership with new token
  const { error: updateError } = await serviceClient
    .from("memberships")
    .update({
      invite_token: inviteToken,
      invite_token_expires_at: inviteTokenExpiresAt.toISOString(),
    })
    .eq("id", membershipId)

  if (updateError) {
    throw new Error(`Failed to generate new invite token: ${updateError.message}`)
  }

  const orgBrand = await getOrgBrand(serviceClient, resolvedOrgId)
  const inviteLink = getInviteLink(inviteToken)
  await sendInviteEmail({
    to: email,
    inviteLink,
    orgName: orgBrand.name,
    orgLogoUrl: orgBrand.logoUrl,
    inviterName: inviterData?.full_name ?? null,
    inviterEmail: inviterData?.email ?? null,
  })

  return true
}

export async function resetMemberMfa(membershipId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAuthorization({
    permission: "members.manage",
    userId,
    orgId: resolvedOrgId,
    supabase,
    logDecision: true,
    resourceType: "membership",
    resourceId: membershipId,
  })
  const serviceClient = createServiceSupabaseClient()

  const { data: membership, error: membershipError } = await serviceClient
    .from("memberships")
    .select("id, org_id, user_id")
    .eq("org_id", resolvedOrgId)
    .eq("id", membershipId)
    .maybeSingle()

  if (membershipError || !membership?.user_id) {
    throw new Error("Membership not found")
  }

  const { data: factorData, error: factorError } = await serviceClient.auth.admin.mfa.listFactors({
    userId: membership.user_id,
  })

  if (factorError) {
    throw new Error(`Failed to load MFA factors: ${factorError.message}`)
  }

  const factors = (factorData?.factors ?? []).filter((factor) => factor.status === "verified")
  if (factors.length === 0) {
    return { reset: false }
  }

  for (const factor of factors) {
    const { error: deleteError } = await serviceClient.auth.admin.mfa.deleteFactor({
      userId: membership.user_id,
      id: factor.id,
    })
    if (deleteError) {
      throw new Error(`Failed to reset MFA: ${deleteError.message}`)
    }
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "membership",
    entityId: membershipId,
    before: { mfa_factor_count: factors.length },
    after: { mfa_factor_count: 0 },
  })

  return { reset: true, deletedFactors: factors.length }
}

export async function getInviteDetailsByToken(token: string): Promise<{
  membershipId: string
  userId: string
  orgId: string
  orgName: string
  email: string
} | null> {
  const serviceClient = createServiceSupabaseClient()

  const { data, error } = await serviceClient
    .from("memberships")
    .select(`
      id, user_id, org_id, status, invite_token_expires_at,
      orgs!inner(name),
      user:app_users!memberships_user_id_fkey(email)
    `)
    .eq("invite_token", token)
    .eq("status", "invited")
    .maybeSingle()

  if (error || !data) {
    return null
  }

  // Check if token is expired
  if (data.invite_token_expires_at) {
    const expiresAt = new Date(data.invite_token_expires_at)
    if (expiresAt < new Date()) {
      return null
    }
  }

  const org = data.orgs as unknown as { name: string }
  const user = data.user as unknown as { email: string }

  return {
    membershipId: data.id,
    userId: data.user_id,
    orgId: data.org_id,
    orgName: org.name,
    email: user.email,
  }
}

export async function acceptInviteByToken(
  token: string,
  password: string,
  fullName: string
): Promise<{
  orgId: string
  orgName: string
} | null> {
  const serviceClient = createServiceSupabaseClient()

  // Get invite details
  const inviteDetails = await getInviteDetailsByToken(token)
  if (!inviteDetails) {
    return null
  }

  // Update user's password
  const { error: passwordError } = await serviceClient.auth.admin.updateUserById(
    inviteDetails.userId,
    { password }
  )

  if (passwordError) {
    throw new Error(`Failed to set password: ${passwordError.message}`)
  }

  // Update user profile with full name
  const { error: profileError } = await serviceClient
    .from("app_users")
    .update({ full_name: fullName })
    .eq("id", inviteDetails.userId)

  if (profileError) {
    console.error("Failed to update user profile", profileError)
  }

  // Activate membership and clear invite token
  const { error: membershipError } = await serviceClient
    .from("memberships")
    .update({
      status: "active",
      invite_token: null,
      invite_token_expires_at: null,
    })
    .eq("id", inviteDetails.membershipId)

  if (membershipError) {
    throw new Error(`Failed to activate membership: ${membershipError.message}`)
  }

  return {
    orgId: inviteDetails.orgId,
    orgName: inviteDetails.orgName,
  }
}
