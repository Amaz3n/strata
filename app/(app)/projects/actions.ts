"use server"

import { revalidatePath } from "next/cache"

import { createProject, listProjects, updateProject, archiveProject } from "@/lib/services/projects"
import { projectInputSchema, projectUpdateSchema } from "@/lib/validation/projects"
import { requireOrgContext } from "@/lib/services/context"

export async function listProjectsAction() {
  const context = await requireOrgContext()
  return listProjects(undefined, context)
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
