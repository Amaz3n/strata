"use server"

import { revalidatePath } from "next/cache"

import { createProject, listProjects, updateProject, archiveProject, deleteProject } from "@/lib/services/projects"
import { projectInputSchema, projectUpdateSchema } from "@/lib/validation/projects"
import { requireOrgContext } from "@/lib/services/context"
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
