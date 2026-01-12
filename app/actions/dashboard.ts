"use server"

import { getDashboardSnapshot } from "@/lib/services/dashboard"
import { createFileRecord, listFiles } from "@/lib/services/files"
import { fileInputSchema } from "@/lib/validation/files"
import { listProjects } from "@/lib/services/projects"
import { listTasks } from "@/lib/services/tasks"
import { getOrgActivity } from "@/lib/services/events"
import { revalidatePath } from "next/cache"

export async function getDashboardSnapshotAction() {
  return getDashboardSnapshot()
}

export async function getOrgActivityAction(limit = 15) {
  return getOrgActivity(limit)
}

export async function listFilesAction() {
  return listFiles()
}

export async function createFileRecordAction(input: unknown) {
  const parsed = fileInputSchema.parse(input)
  const file = await createFileRecord(parsed)
  revalidatePath("/")
  return file
}

export async function searchAction(query: string) {
  if (!query.trim()) return []

  try {
    // Fetch data from all services
    const [projects, tasks, files] = await Promise.all([
      listProjects(),
      listTasks(),
      listFiles(),
    ])

    const results = []

    // Add projects
    projects.forEach(project => {
      if (
        project.name.toLowerCase().includes(query.toLowerCase()) ||
        project.address?.toLowerCase().includes(query.toLowerCase())
      ) {
        results.push({
          id: project.id,
          type: "project",
          title: project.name,
          subtitle: `${project.status.charAt(0).toUpperCase() + project.status.slice(1)}${project.address ? ` • ${project.address}` : ""}`,
          href: `/projects/${project.id}`,
        })
      }
    })

    // Add tasks
    tasks.forEach(task => {
      if (
        task.title.toLowerCase().includes(query.toLowerCase()) ||
        task.description?.toLowerCase().includes(query.toLowerCase())
      ) {
        const project = projects.find(p => p.id === task.project_id)
        const priority = task.priority.charAt(0).toUpperCase() + task.priority.slice(1)
        results.push({
          id: task.id,
          type: "task",
          title: task.title,
          subtitle: `${project?.name || "Unknown Project"} • ${priority} Priority`,
          href: `/tasks/${task.id}`,
        })
      }
    })

    // Add files
    files.forEach(file => {
      if (file.file_name.toLowerCase().includes(query.toLowerCase())) {
        const project = projects.find(p => p.id === file.project_id)
        const sizeFormatted = file.size_bytes
          ? `${(file.size_bytes / (1024 * 1024)).toFixed(1)} MB`
          : "Unknown size"
        results.push({
          id: file.id,
          type: "file",
          title: file.file_name,
          subtitle: `${project?.name || "Unknown Project"} • ${sizeFormatted}`,
          href: `/files/${file.id}`,
        })
      }
    })

    // Limit results to prevent UI overload
    return results.slice(0, 20)
  } catch (error) {
    console.error("Search failed:", error)
    return []
  }
}
