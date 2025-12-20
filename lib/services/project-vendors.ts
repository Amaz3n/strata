import type { ProjectVendor } from "@/lib/types"
import type { ProjectVendorInput } from "@/lib/validation/project-vendors"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"

function mapProjectVendor(row: any): ProjectVendor {
  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id,
    company_id: row.company_id ?? undefined,
    contact_id: row.contact_id ?? undefined,
    role: row.role,
    scope: row.scope ?? undefined,
    status: row.status,
    notes: row.notes ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
    company: row.company,
    contact: row.contact,
  }
}

export async function listProjectVendors(projectId: string, orgId?: string): Promise<ProjectVendor[]> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("project_vendors")
    .select(
      `
      *,
      company:companies(id, name, company_type, phone, email),
      contact:contacts(id, full_name, email, phone, role)
    `,
    )
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)
    .order("role", { ascending: true })
    .order("created_at", { ascending: true })

  if (error) throw new Error(`Failed to list project vendors: ${error.message}`)
  return (data ?? []).map(mapProjectVendor)
}

export async function addProjectVendor({
  input,
  orgId,
}: {
  input: ProjectVendorInput
  orgId?: string
}): Promise<ProjectVendor> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("project_vendors")
    .insert({
      org_id: resolvedOrgId,
      project_id: input.project_id,
      company_id: input.company_id,
      contact_id: input.contact_id,
      role: input.role,
      scope: input.scope,
      notes: input.notes,
    })
    .select(
      `
      *,
      company:companies(id, name, company_type, phone, email),
      contact:contacts(id, full_name, email, phone, role)
    `,
    )
    .single()

  if (error) throw new Error(`Failed to add project vendor: ${error.message}`)

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "project_vendor_added",
    entityType: "project",
    entityId: input.project_id,
    payload: { role: input.role, company_id: input.company_id, contact_id: input.contact_id },
  })

  return mapProjectVendor(data)
}

export async function removeProjectVendor(vendorId: string, orgId?: string): Promise<void> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { error } = await supabase
    .from("project_vendors")
    .delete()
    .eq("id", vendorId)
    .eq("org_id", resolvedOrgId)

  if (error) throw new Error(`Failed to remove project vendor: ${error.message}`)
}

export async function updateProjectVendor({
  vendorId,
  updates,
  orgId,
}: {
  vendorId: string
  updates: Partial<Pick<ProjectVendorInput, "role" | "scope" | "notes">>
  orgId?: string
}): Promise<ProjectVendor> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("project_vendors")
    .update({
      ...updates,
      updated_at: new Date().toISOString(),
    })
    .eq("id", vendorId)
    .eq("org_id", resolvedOrgId)
    .select(
      `
      *,
      company:companies(id, name, company_type, phone, email),
      contact:contacts(id, full_name, email, phone, role)
    `,
    )
    .single()

  if (error) throw new Error(`Failed to update project vendor: ${error.message}`)
  return mapProjectVendor(data)
}
