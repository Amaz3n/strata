"use server"

import { revalidatePath } from "next/cache"

import {
  importQboRecords,
  listImportableQboRecords,
  type QboImportEntityType,
  type QboImportListing,
  type QboImportResult,
} from "@/lib/services/qbo-import"

/** List QBO transactions with no Arc counterpart, optionally bounded by a lookback window. */
export async function listQboImportRecordsAction(params?: {
  sinceDate?: string | null
  types?: QboImportEntityType[]
}): Promise<QboImportListing> {
  return listImportableQboRecords({ sinceDate: params?.sinceDate, types: params?.types })
}

/** Import the selected QBO transactions into a project, creating pre-linked Arc records. */
export async function importQboRecordsAction(params: {
  projectId: string
  items: { qboId: string; entityType: QboImportEntityType }[]
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
