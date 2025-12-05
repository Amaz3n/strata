import type { SupabaseClient } from "@supabase/supabase-js"

import type { TeamMember, OrgRole } from "@/lib/types"
import { inviteMemberSchema, memberStatusSchema, updateMemberRoleSchema, type InviteMemberInput } from "@/lib/validation/team"
import { requireOrgContext } from "@/lib/services/context"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { recordEvent } from "@/lib/services/events"
import { recordAudit } from "@/lib/services/audit"

async function resolveRoleId(client: SupabaseClient, role: OrgRole) {
  const { data, error } = await client.from("roles").select("id").eq("scope", "org").eq("key", role).maybeSingle()
  if (error || !data?.id) {
    throw new Error(`Role ${role} not found`)
  }
  return data.id as string
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
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  const projectCounts = await mapProjectCounts(supabase, resolvedOrgId)

  const { data, error } = await supabase
    .from("memberships")
    .select(
      `
      id, org_id, user_id, role_id, status, last_active_at, created_at, invited_by,
      user:app_users!inner(id, email, full_name, avatar_url),
      role:roles!inner(key, label),
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

export async function inviteTeamMember({ input, orgId }: { input: InviteMemberInput; orgId?: string }): Promise<TeamMember> {
  const parsed = inviteMemberSchema.parse(input)
  const { orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const serviceClient = createServiceSupabaseClient()

  const { data: existingUser } = await serviceClient
    .from("app_users")
    .select("id, email, full_name, avatar_url")
    .ilike("email", parsed.email)
    .maybeSingle()

  let targetUserId = existingUser?.id as string | undefined

  if (!targetUserId) {
    const { data: inviteData, error: inviteError } = await serviceClient.auth.admin.inviteUserByEmail(parsed.email)
    if (inviteError) {
      throw new Error(`Failed to send invite: ${inviteError.message}`)
    }
    targetUserId = inviteData?.user?.id
  }

  if (!targetUserId) {
    throw new Error("Unable to resolve invited user id")
  }

  const roleId = await resolveRoleId(serviceClient, parsed.role)

  const { data, error } = await serviceClient
    .from("memberships")
    .upsert({
      org_id: resolvedOrgId,
      user_id: targetUserId,
      role_id: roleId,
      status: "invited",
      invited_by: userId,
    })
    .select(
      `
      id, org_id, user_id, role_id, status, last_active_at, created_at, invited_by,
      user:app_users(id, email, full_name, avatar_url),
      role:roles(key, label),
      invited_by_user:app_users(id, email, full_name, avatar_url)
    `,
    )
    .maybeSingle()

  if (error || !data) {
    throw new Error(`Failed to create membership: ${error?.message}`)
  }

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
      user:app_users(id, email, full_name, avatar_url),
      role:roles(key, label)
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
      user:app_users(id, email, full_name, avatar_url),
      role:roles(key, label)
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
  const { orgId: resolvedOrgId } = await requireOrgContext(orgId)
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

  const email = data.user?.email
  if (!email) {
    throw new Error("Membership user email missing")
  }

  const { error: inviteError } = await serviceClient.auth.admin.inviteUserByEmail(email)
  if (inviteError) {
    throw new Error(`Failed to resend invite: ${inviteError.message}`)
  }

  return true
}
