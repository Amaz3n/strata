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

export async function searchAction(query: string, filters?: any, options?: any) {
  if (!query.trim()) return []

  try {
    // Import the new search service
    const { searchAll } = await import("@/lib/services/search")

    // Use the enhanced search service
    const results = await searchAll(query, filters, {
      limit: options?.limit || 50,
      sortBy: 'relevance',
      ...options
    })

    // Transform results to match the old format for backward compatibility
    return results.map(result => ({
      id: result.id,
      type: result.type,
      title: result.title,
      subtitle: result.subtitle,
      description: result.description,
      href: result.href,
      project_id: result.project_id,
      project_name: result.project_name,
      created_at: result.created_at,
      updated_at: result.updated_at,
    }))
  } catch (error) {
    console.error("Search failed:", error)
    return []
  }
}
