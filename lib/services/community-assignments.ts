import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { requirePermission } from "@/lib/services/permissions"
import {
  communityAssignmentInputSchema,
  type CommunityAssignmentInput,
  type CommunityAssignmentRole,
} from "@/lib/validation/communities"

export const COMMUNITY_ASSIGNMENT_ROLE_LABELS: Record<CommunityAssignmentRole, string> = {
  sales: "Sales consultant",
  superintendent: "Superintendent",
  closing: "Closing coordinator",
  warranty: "Warranty",
  land: "Land manager",
}

export interface CommunityAssignmentDTO {
  id: string
  communityId: string
  userId: string
  role: CommunityAssignmentRole
  name: string
  email: string | null
}

type AssignmentRow = {
  id: string
  community_id: string
  user_id: string
  role: CommunityAssignmentRole
}

async function resolveMemberNames(
  supabase: Awaited<ReturnType<typeof requireOrgContext>>["supabase"],
  userIds: string[],
) {
  if (userIds.length === 0) return new Map<string, { name: string; email: string | null }>()
  const { data, error } = await supabase
    .from("app_users")
    .select("id, full_name, email")
    .in("id", userIds)
  if (error) throw new Error(`Failed to load assigned members: ${error.message}`)
  return new Map(
    (data ?? []).map((row) => [
      row.id as string,
      { name: (row.full_name as string | null) ?? (row.email as string | null) ?? "Unknown", email: (row.email as string | null) ?? null },
    ]),
  )
}

export async function listCommunityAssignments(
  communityId: string,
  orgId?: string,
): Promise<CommunityAssignmentDTO[]> {
  const context = await requireOrgContext(orgId)
  await requirePermission("community.read", context)
  const { data, error } = await context.supabase
    .from("community_assignments")
    .select("id, community_id, user_id, role")
    .eq("org_id", context.orgId)
    .eq("community_id", communityId)
    .limit(200)
  if (error) throw new Error(`Failed to load community team: ${error.message}`)
  const rows = (data ?? []) as AssignmentRow[]
  const names = await resolveMemberNames(context.supabase, [...new Set(rows.map((row) => row.user_id))])
  return rows
    .map((row) => ({
      id: row.id,
      communityId: row.community_id,
      userId: row.user_id,
      role: row.role,
      name: names.get(row.user_id)?.name ?? "Unknown",
      email: names.get(row.user_id)?.email ?? null,
    }))
    .sort((a, b) => a.role.localeCompare(b.role) || a.name.localeCompare(b.name))
}

/**
 * Communities the signed-in user is personally assigned to. Defaults the ambient
 * community lens — a consultant who sits one model home opens Arc already scoped.
 */
export async function listMyCommunityIds(orgId?: string): Promise<string[]> {
  const context = await requireOrgContext(orgId)
  const { data, error } = await context.supabase
    .from("community_assignments")
    .select("community_id")
    .eq("org_id", context.orgId)
    .eq("user_id", context.userId)
    .limit(100)
  if (error) throw new Error(`Failed to resolve assigned communities: ${error.message}`)
  return [...new Set((data ?? []).map((row) => row.community_id as string))]
}

export async function assignCommunityMember(
  input: CommunityAssignmentInput,
  orgId?: string,
): Promise<CommunityAssignmentDTO> {
  const parsed = communityAssignmentInputSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("community.write", context)

  const { data: member, error: memberError } = await context.supabase
    .from("memberships")
    .select("user_id")
    .eq("org_id", context.orgId)
    .eq("user_id", parsed.userId)
    .eq("status", "active")
    .maybeSingle()
  if (memberError) throw new Error(`Failed to verify membership: ${memberError.message}`)
  if (!member) throw new Error("That person is not an active member of this organization.")

  const { data: community, error: communityError } = await context.supabase
    .from("communities")
    .select("id, name")
    .eq("org_id", context.orgId)
    .eq("id", parsed.communityId)
    .is("archived_at", null)
    .maybeSingle()
  if (communityError || !community) throw new Error("Community not found")

  const { data, error } = await context.supabase
    .from("community_assignments")
    .upsert(
      {
        org_id: context.orgId,
        community_id: parsed.communityId,
        user_id: parsed.userId,
        role: parsed.role,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "community_id,user_id,role" },
    )
    .select("id, community_id, user_id, role")
    .single()
  if (error) throw new Error(`Failed to assign member: ${error.message}`)

  await Promise.all([
    recordEvent({
      orgId: context.orgId,
      actorId: context.userId,
      eventType: "community_assignment.created",
      entityType: "community_assignment",
      entityId: data.id,
      payload: { community_id: parsed.communityId, role: parsed.role },
    }),
    recordAudit({
      orgId: context.orgId,
      actorId: context.userId,
      action: "insert",
      entityType: "community_assignment",
      entityId: data.id,
      after: data,
    }),
  ])

  const names = await resolveMemberNames(context.supabase, [parsed.userId])
  const row = data as AssignmentRow
  return {
    id: row.id,
    communityId: row.community_id,
    userId: row.user_id,
    role: row.role,
    name: names.get(row.user_id)?.name ?? "Unknown",
    email: names.get(row.user_id)?.email ?? null,
  }
}

export async function removeCommunityAssignment(id: string, orgId?: string): Promise<void> {
  const context = await requireOrgContext(orgId)
  await requirePermission("community.write", context)
  const { data: before, error: beforeError } = await context.supabase
    .from("community_assignments")
    .select("*")
    .eq("org_id", context.orgId)
    .eq("id", id)
    .maybeSingle()
  if (beforeError || !before) throw new Error("Assignment not found")
  const { error } = await context.supabase
    .from("community_assignments")
    .delete()
    .eq("org_id", context.orgId)
    .eq("id", id)
  if (error) throw new Error(`Failed to remove assignment: ${error.message}`)
  await Promise.all([
    recordEvent({
      orgId: context.orgId,
      actorId: context.userId,
      eventType: "community_assignment.removed",
      entityType: "community_assignment",
      entityId: id,
      payload: { community_id: before.community_id, role: before.role },
    }),
    recordAudit({
      orgId: context.orgId,
      actorId: context.userId,
      action: "delete",
      entityType: "community_assignment",
      entityId: id,
      before,
    }),
  ])
}
