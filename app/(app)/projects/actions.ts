"use server"

import { revalidatePath } from "next/cache"

import { createProject, listProjects, updateProject, archiveProject, deleteProject } from "@/lib/services/projects"
import { getProjectScheduleSummaries, listScheduleItemsByProject } from "@/lib/services/schedule"
import { projectInputSchema, projectUpdateSchema } from "@/lib/validation/projects"
import { requireOrgContext } from "@/lib/services/context"
import { resolveAccountingTarget } from "@/lib/services/accounting-target"
import { requireAccountingConnectionForOrg } from "@/lib/services/accounting-connections"
import { getProvider } from "@/lib/integrations/accounting/registry"
import type { Contact, ProjectScheduleSummary, ScheduleItem } from "@/lib/types"

import { actionError, type ActionResult } from "@/lib/action-result"

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { success: true, data: await fn() }
  } catch (error) {
    return actionError(error)
  }
}

export async function listProjectsAction() {
      const context = await requireOrgContext()
      return listProjects(undefined, context)
}

export async function listProjectScheduleSummariesAction(): Promise<Record<string, ProjectScheduleSummary>> {
      return getProjectScheduleSummaries()
}

export async function getProjectScheduleItemsAction(projectId: string): Promise<ScheduleItem[]> {
      return listScheduleItemsByProject(projectId)
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

async function projectAccountingProvider(orgId: string, connectionId?: string | null) {
  if (connectionId) {
    const connection = await requireAccountingConnectionForOrg(connectionId, orgId, { activeOnly: true })
    return { connectionId: connection.id, provider: getProvider(connection.provider) }
  }
  const target = await resolveAccountingTarget({ orgId })
  return target ? { connectionId: target.connection.id, provider: getProvider(target.connection.provider) } : null
}

export async function listProjectQboClassesAction(connectionId?: string | null) {
      const { orgId } = await requireOrgContext()
      const accounting = await projectAccountingProvider(orgId, connectionId)
      if (!accounting || !accounting.provider.capabilities.dimensions.includes("class")) return []
      return accounting.provider.listDimensionValues({ connectionId: accounting.connectionId, kind: "class" }).catch(() => [])
}

// Typeahead for the project settings "QuickBooks customer" picker. QBO is the source of truth, so we
// query it live by DisplayName. Returns connected=false when QBO isn't linked.
export async function searchProjectQboCustomersAction(term: string, connectionId?: string | null) {
      const { orgId } = await requireOrgContext()
      const accounting = await projectAccountingProvider(orgId, connectionId).catch(() => null)
      if (!accounting?.provider.searchCounterparties) return { connected: false, customers: [] }
      try {
        const customers = await accounting.provider.searchCounterparties({ connectionId: accounting.connectionId, role: "customer", term })
        return { connected: true, customers }
      } catch (error) {
        console.warn("Accounting customer search failed", error)
        return { connected: true, customers: [] }
      }
}

// Read-only preview of which QBO customer this project's costs will attribute to, mirroring the sync
// resolution (explicit default → client contact → project name) WITHOUT creating anything in QBO.
// Used by the payables nudge so the user sees the consequence before syncing.
export async function getProjectAccountingCustomerPreviewAction(
  projectId: string,
): Promise<{ hasDefault: boolean; customerName: string | null }> {
      const { supabase, orgId } = await requireOrgContext()
      const target = await resolveAccountingTarget({ orgId, projectId })
      const { data: project } = await supabase
        .from("projects")
        .select("client_id, name")
        .eq("org_id", orgId)
        .eq("id", projectId)
        .maybeSingle()
      if (!project) return { hasDefault: false, customerName: null }
      if (target?.dimensions.customer?.id) {
        return { hasDefault: true, customerName: target.dimensions.customer.name ?? null }
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
  connectionId?: string | null
  name: string
  email?: string | null
  line1?: string | null
  city?: string | null
  state?: string | null
  postalCode?: string | null
}) {
  return run(async () => {
      const { orgId } = await requireOrgContext()
      const name = input.name?.trim()
      if (!name) throw new Error("Customer name is required")
      const accounting = await projectAccountingProvider(orgId, input.connectionId)
      if (!accounting?.provider.createCounterparty) throw new Error("The mapped accounting provider cannot create customers")
      return accounting.provider.createCounterparty({ connectionId: accounting.connectionId, role: "customer", counterparty: {
        displayName: name,
        email: input.email ?? null,
        line1: input.line1 ?? null,
        city: input.city ?? null,
        state: input.state ?? null,
        postalCode: input.postalCode ?? null,
      } })
  })
}

export async function createProjectAction(input: unknown) {
  return run(async () => {
      const parsed = projectInputSchema.parse(input)
      const context = await requireOrgContext()
      const project = await createProject({ input: parsed, context })
      revalidatePath("/projects")
      revalidatePath("/")
      return project
  })
}

export async function updateProjectAction(projectId: string, input: unknown) {
  return run(async () => {
      const parsed = projectUpdateSchema.parse(input)
      const context = await requireOrgContext()
      const project = await updateProject({ projectId, input: parsed, context })
      revalidatePath("/projects")
      revalidatePath("/")
      return project
  })
}

export async function archiveProjectAction(projectId: string) {
  return run(async () => {
      const context = await requireOrgContext()
      const project = await archiveProject(projectId, undefined, context)
      revalidatePath("/projects")
      revalidatePath("/")
      return project
  })
}

export async function deleteProjectAction(projectId: string) {
  return run(async () => {
      const context = await requireOrgContext()
      await deleteProject(projectId, undefined, context)
      revalidatePath("/projects")
      revalidatePath("/")
  })
}
