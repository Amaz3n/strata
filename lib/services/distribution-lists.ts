import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"
import { recordAudit } from "@/lib/services/audit"

export type DistributionScope = "rfis" | "submittals" | "all"

export interface DistributionMember {
  id: string
  org_id: string
  project_id: string
  scope: DistributionScope
  contact_id?: string | null
  user_id?: string | null
  name?: string | null
  email?: string | null
  company_name?: string | null
  created_at: string
}

const MEMBER_SELECT = `
  id, org_id, project_id, scope, contact_id, user_id, created_at,
  contact:contacts(full_name, email, company:companies!contacts_primary_company_id_fkey(name)),
  app_user:app_users(full_name, email)
`

function mapMember(row: any): DistributionMember {
  const contact = Array.isArray(row.contact) ? row.contact[0] : row.contact
  const user = Array.isArray(row.app_user) ? row.app_user[0] : row.app_user
  const company = contact ? (Array.isArray(contact.company) ? contact.company[0] : contact.company) : null
  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id,
    scope: row.scope,
    contact_id: row.contact_id ?? null,
    user_id: row.user_id ?? null,
    name: contact?.full_name ?? user?.full_name ?? null,
    email: contact?.email ?? user?.email ?? null,
    company_name: company?.name ?? null,
    created_at: row.created_at,
  }
}

export async function listDistributionMembers(projectId: string, orgId?: string): Promise<DistributionMember[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("project.read", { supabase, orgId: resolvedOrgId, userId })

  const { data, error } = await supabase
    .from("project_distribution_members")
    .select(MEMBER_SELECT)
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)
    .order("created_at", { ascending: true })

  if (error) throw new Error(`Failed to load distribution list: ${error.message}`)
  return (data ?? []).map(mapMember)
}

export async function addDistributionMember({
  projectId,
  scope,
  contactId,
  userId: memberUserId,
  orgId,
}: {
  projectId: string
  scope: DistributionScope
  contactId?: string | null
  userId?: string | null
  orgId?: string
}): Promise<DistributionMember> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("project.settings.update", { supabase, orgId: resolvedOrgId, userId })

  if (!contactId && !memberUserId) {
    throw new Error("Pick a contact or a team member")
  }

  const { data, error } = await supabase
    .from("project_distribution_members")
    .insert({
      org_id: resolvedOrgId,
      project_id: projectId,
      scope,
      contact_id: contactId ?? null,
      user_id: memberUserId ?? null,
    })
    .select(MEMBER_SELECT)
    .single()

  if (error || !data) {
    if (error?.code === "23505") {
      throw new Error("Already on this distribution list")
    }
    throw new Error(`Failed to add distribution member: ${error?.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "project_distribution_member",
    entityId: data.id,
    after: { project_id: projectId, scope, contact_id: contactId ?? null, user_id: memberUserId ?? null },
  })

  return mapMember(data)
}

export async function removeDistributionMember({ memberId, orgId }: { memberId: string; orgId?: string }) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("project.settings.update", { supabase, orgId: resolvedOrgId, userId })

  const { error } = await supabase
    .from("project_distribution_members")
    .delete()
    .eq("id", memberId)
    .eq("org_id", resolvedOrgId)

  if (error) throw new Error(`Failed to remove distribution member: ${error.message}`)

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "delete",
    entityType: "project_distribution_member",
    entityId: memberId,
  })

  return { success: true }
}

export interface DistributionRecipient {
  email: string
  name?: string | null
  contactId?: string | null
  userId?: string | null
}

/**
 * Service-role fetch used by the RFI/submittal email senders: everyone copied
 * on this scope (scope members plus 'all' members), with a usable email.
 */
export async function fetchDistributionRecipients(
  orgId: string,
  projectId: string,
  scope: Exclude<DistributionScope, "all">,
): Promise<DistributionRecipient[]> {
  const serviceClient = createServiceSupabaseClient()
  const { data, error } = await serviceClient
    .from("project_distribution_members")
    .select(MEMBER_SELECT)
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .in("scope", [scope, "all"])

  if (error) {
    console.warn("Failed to load distribution recipients", error)
    return []
  }

  return (data ?? [])
    .map(mapMember)
    .filter((member) => !!member.email)
    .map((member) => ({
      email: member.email as string,
      name: member.name,
      contactId: member.contact_id ?? null,
      userId: member.user_id ?? null,
    }))
}
