import type { SupabaseClient } from "@supabase/supabase-js"

import { randomBytes } from "node:crypto"

import type { TeamMember, OrgRole } from "@/lib/types"
import { inviteMemberSchema, memberStatusSchema, updateMemberRoleSchema, type InviteMemberInput } from "@/lib/validation/team"
import { requireOrgContext } from "@/lib/services/context"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { recordEvent } from "@/lib/services/events"
import { recordAudit } from "@/lib/services/audit"
import { sendInviteEmail } from "@/lib/services/mailer"
import { requireAnyPermission, requirePermission } from "@/lib/services/permissions"

async function resolveRoleId(client: SupabaseClient, role: OrgRole) {
  const { data, error } = await client.from("roles").select("id").eq("scope", "org").eq("key", role).maybeSingle()
  if (error || !data?.id) {
    throw new Error(`Role ${role} not found`)
  }
  return data.id as string
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

function generateTempPassword() {
  return randomBytes(12).toString("base64url").slice(0, 16)
}

function shouldBypassInviteRateLimit(message: string) {
  return process.env.NODE_ENV === "development" && /rate limit/i.test(message)
}

async function getOrgName(client: SupabaseClient, orgId: string) {
  const { data, error } = await client.from("orgs").select("name").eq("id", orgId).maybeSingle()
  if (error) {
    console.error("Failed to load org name", error)
    return null
  }
  return data?.name ?? null
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

function mapTeamMember(row: any, projectCounts: Record<string, number>): TeamMember {
  const user = row.user || row.users
  const invitedBy = row.invited_by_user || row.invited_by
  const roleKey = row.role?.key ?? "staff"

  return {
    id: row.id,
    user: {
      id: user?.id,
      email: user?.email,
      full_name: user?.full_name ?? user?.email ?? "Unknown",
      avatar_url: user?.avatar_url ?? undefined,
    },
    role: roleKey,
    status: row.status ?? "invited",
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

export async function listTeamMembers(orgId?: string): Promise<TeamMember[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["org.member", "org.read"], { supabase, orgId: resolvedOrgId, userId })
  const projectCounts = await mapProjectCounts(supabase, resolvedOrgId)

  const { data, error } = await supabase
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

  return (data ?? []).map((row) => mapTeamMember(row, projectCounts))
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
  await requirePermission("members.manage", { supabase, orgId: resolvedOrgId, userId })
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
  const orgName = await getOrgName(serviceClient, resolvedOrgId)
  const inviteLink = getInviteLink(inviteToken)
  await sendInviteEmail({
    to: parsed.email,
    inviteLink,
    orgName,
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
  return mapTeamMember(data, projectCounts)
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
  await requirePermission("org.admin", { supabase, orgId: resolvedOrgId, userId })
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
  return mapTeamMember(data, projectCounts)
}

async function updateMemberStatus(membershipId: string, status: "active" | "invited" | "suspended", orgId?: string) {
  memberStatusSchema.parse({ status })
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("members.manage", { supabase, orgId: resolvedOrgId, userId })

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
  return mapTeamMember(data, projectCounts)
}

export function suspendMember(membershipId: string, orgId?: string) {
  return updateMemberStatus(membershipId, "suspended", orgId)
}

export function reactivateMember(membershipId: string, orgId?: string) {
  return updateMemberStatus(membershipId, "active", orgId)
}

export async function removeMember(membershipId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("members.manage", { supabase, orgId: resolvedOrgId, userId })

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
  await requirePermission("members.manage", { supabase, orgId: resolvedOrgId, userId })
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

  const orgName = await getOrgName(serviceClient, resolvedOrgId)
  const inviteLink = getInviteLink(inviteToken)
  await sendInviteEmail({
    to: email,
    inviteLink,
    orgName,
  })

  return true
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

