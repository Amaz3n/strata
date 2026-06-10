"use server"

import { revalidatePath } from "next/cache"

import {
  importQboRecords,
  listImportableQboRecords,
  type QboImportEntityType,
  type QboImportListing,
  type QboImportResult,
} from "@/lib/services/qbo-import"
import { listProjects } from "@/lib/services/projects"

/** List QBO transactions with no Arc counterpart, optionally bounded by a lookback window. */
export async function listQboImportRecordsAction(params?: {
  sinceDate?: string | null
  types?: QboImportEntityType[]
}): Promise<QboImportListing> {
  return listImportableQboRecords({ sinceDate: params?.sinceDate, types: params?.types })
}

/** Lightweight project list (id + name) for the per-line "allocate to project" picker. */
export async function listProjectsForImportAction(): Promise<{ id: string; name: string }[]> {
  const projects = await listProjects()
  return projects.map((project) => ({ id: project.id, name: project.name }))
}

/** Import the selected QBO transactions into a project, creating pre-linked Arc records. */
export async function importQboRecordsAction(params: {
  projectId: string
  items: { qboId: string; entityType: QboImportEntityType; allocations?: Record<string, string> }[]
}): Promise<QboImportResult> {
  const result = await importQboRecords({ projectId: params.projectId, items: params.items })

  if (result.imported > 0) {
    revalidatePath(`/projects/${params.projectId}/financials`)
    revalidatePath(`/projects/${params.projectId}/financials/receivables`)
    revalidatePath(`/projects/${params.projectId}/financials/payables`)
    revalidatePath(`/projects/${params.projectId}/expenses`)
  }

  return result
}
