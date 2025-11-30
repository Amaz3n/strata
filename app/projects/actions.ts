"use server"

import { revalidatePath } from "next/cache"

import { createProject, listProjects, updateProject, archiveProject } from "@/lib/services/projects"
import { projectInputSchema, projectUpdateSchema } from "@/lib/validation/projects"

export async function listProjectsAction() {
  return listProjects()
}

export async function createProjectAction(input: unknown) {
  const parsed = projectInputSchema.parse(input)
  const project = await createProject({ input: parsed })
  revalidatePath("/projects")
  revalidatePath("/")
  return project
}

export async function updateProjectAction(projectId: string, input: unknown) {
  const parsed = projectUpdateSchema.parse(input)
  const project = await updateProject({ projectId, input: parsed })
  revalidatePath("/projects")
  revalidatePath("/")
  return project
}

export async function archiveProjectAction(projectId: string) {
  const project = await archiveProject(projectId)
  revalidatePath("/projects")
  revalidatePath("/")
  return project
}
