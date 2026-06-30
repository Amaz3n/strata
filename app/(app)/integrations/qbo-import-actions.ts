"use server"

import { revalidatePath } from "next/cache"

import {
  importQboRecords,
  linkExistingQboImportRecord,
  listImportableQboRecords,
  listQboCustomersForImport,
  type QboImportCustomerListing,
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

/** Full QBO customer/project list for the import sheet's project filter. */
export async function listQboCustomersForImportAction(): Promise<QboImportCustomerListing> {
  return listQboCustomersForImport()
}

/** Lightweight project list (id + name) for the per-line "allocate to project" picker. */
export async function listProjectsForImportAction(): Promise<{ id: string; name: string }[]> {
  const projects = await listProjects()
  return projects.map((project) => ({ id: project.id, name: project.name }))
}

/** Import the selected QBO transactions, each into its own destination project, creating pre-linked Arc records. */
export async function importQboRecordsAction(params: {
  items: { qboId: string; entityType: QboImportEntityType; projectId?: string; allocations?: Record<string, string> }[]
}): Promise<QboImportResult> {
  const result = await importQboRecords({ items: params.items })

  if (result.imported > 0) {
    // Revalidate every project that received a record (records can land in different projects).
    const projectIds = new Set(
      params.items.map((item) => item.projectId).filter((id): id is string => Boolean(id)),
    )
    for (const projectId of projectIds) {
      revalidatePath(`/projects/${projectId}/financials`)
      revalidatePath(`/projects/${projectId}/financials/receivables`)
      revalidatePath(`/projects/${projectId}/financials/payables`)
      revalidatePath(`/projects/${projectId}/expenses`)
    }
  }

  return result
}

export async function linkExistingQboImportRecordAction(params: {
  qboId: string
  entityType: "invoice" | "expense" | "bill"
  existingEntityId: string
}): Promise<{ linked: true }> {
  const result = await linkExistingQboImportRecord(params)
  revalidatePath("/projects")
  revalidatePath("/invoices")
  return result
}
