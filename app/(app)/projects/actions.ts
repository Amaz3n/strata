"use server"

import { revalidatePath } from "next/cache"

import { createProject, listProjects, updateProject, archiveProject, deleteProject } from "@/lib/services/projects"
import { projectInputSchema, projectUpdateSchema } from "@/lib/validation/projects"
import { requireOrgContext } from "@/lib/services/context"
import { QBOClient, type QBOClassOption } from "@/lib/integrations/accounting/qbo-api"
import type { Contact } from "@/lib/types"

export async function listProjectsAction() {
  const context = await requireOrgContext()
  return listProjects(undefined, context)
}

export async function listProjectClientContactsAction(): Promise<Contact[]> {
  const { supabase, orgId } = await requireOrgContext()

  const { data, error } = await supabase
    .from("contacts")
    .select("id, org_id, full_name, email, phone, role, contact_type, primary_company_id, created_at, updated_at")
    .eq("org_id", orgId)
    .in("contact_type", ["client", "consultant", "vendor"])
    .order("full_name", { ascending: true })

  if (error) {
    throw new Error(`Failed to list client contacts: ${error.message}`)
  }

  return (data ?? []) as Contact[]
}

export async function listProjectQboClassesAction(): Promise<QBOClassOption[]> {
  const { orgId } = await requireOrgContext()
  const client = await QBOClient.forOrg(orgId)
  if (!client) return []
  return client.listClasses().catch(() => [])
}

// Typeahead for the project settings "QuickBooks customer" picker. QBO is the source of truth, so we
// query it live by DisplayName. Returns connected=false when QBO isn't linked.
export async function searchProjectQboCustomersAction(term: string) {
  const { orgId } = await requireOrgContext()
  const client = await QBOClient.forOrg(orgId).catch(() => null)
  if (!client) return { connected: false, customers: [] as Awaited<ReturnType<QBOClient["searchCustomers"]>> }
  try {
    const customers = await client.searchCustomers(term)
    return { connected: true, customers }
  } catch (error) {
    console.warn("QBO customer search failed", error)
    return { connected: true, customers: [] as Awaited<ReturnType<QBOClient["searchCustomers"]>> }
  }
}

// Read-only preview of which QBO customer this project's costs will attribute to, mirroring the sync
// resolution (explicit default → client contact → project name) WITHOUT creating anything in QBO.
// Used by the payables nudge so the user sees the consequence before syncing.
export async function getProjectAccountingCustomerPreviewAction(
  projectId: string,
): Promise<{ hasDefault: boolean; customerName: string | null }> {
  const { supabase, orgId } = await requireOrgContext()
  const { data: project } = await supabase
    .from("projects")
    .select("qbo_customer_id, qbo_customer_name, client_id, name")
    .eq("org_id", orgId)
    .eq("id", projectId)
    .maybeSingle()
  if (!project) return { hasDefault: false, customerName: null }
  if (project.qbo_customer_id) {
    return { hasDefault: true, customerName: project.qbo_customer_name ?? null }
  }
  let customerName: string | null = null
  if (project.client_id) {
    const { data: contact } = await supabase
      .from("contacts")
      .select("full_name")
      .eq("org_id", orgId)
      .eq("id", project.client_id)
      .maybeSingle()
    customerName = contact?.full_name?.trim() || null
  }
  return { hasDefault: false, customerName: customerName ?? project.name ?? null }
}

// Create a customer directly in QuickBooks from project settings (with optional mailing address), so
// new customers are born in the source of truth. Returns the new customer to set as the project default.
export async function createProjectQboCustomerAction(input: {
  name: string
  email?: string | null
  line1?: string | null
  city?: string | null
  state?: string | null
  postalCode?: string | null
}) {
  const { orgId } = await requireOrgContext()
  const name = input.name?.trim()
  if (!name) throw new Error("Customer name is required")
  const client = await QBOClient.forOrg(orgId)
  if (!client) throw new Error("QuickBooks is not connected")
  return client.createCustomerOption({
    name,
    email: input.email ?? null,
    line1: input.line1 ?? null,
    city: input.city ?? null,
    state: input.state ?? null,
    postalCode: input.postalCode ?? null,
  })
}

export async function createProjectAction(input: unknown) {
  const parsed = projectInputSchema.parse(input)
  const context = await requireOrgContext()
  const project = await createProject({ input: parsed, context })
  revalidatePath("/projects")
  revalidatePath("/")
  return project
}

export async function updateProjectAction(projectId: string, input: unknown) {
  const parsed = projectUpdateSchema.parse(input)
  const context = await requireOrgContext()
  const project = await updateProject({ projectId, input: parsed, context })
  revalidatePath("/projects")
  revalidatePath("/")
  return project
}

export async function archiveProjectAction(projectId: string) {
  const context = await requireOrgContext()
  const project = await archiveProject(projectId, undefined, context)
  revalidatePath("/projects")
  revalidatePath("/")
  return project
}

export async function deleteProjectAction(projectId: string) {
  const context = await requireOrgContext()
  await deleteProject(projectId, undefined, context)
  revalidatePath("/projects")
  revalidatePath("/")
}
