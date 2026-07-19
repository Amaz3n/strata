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
} from "@/lib/integrations/accounting/qbo/import"
import { listProjects } from "@/lib/services/projects"
import { requireOrgContext } from "@/lib/services/context"
import { requireAuthorization } from "@/lib/services/authorization"

export async function listQboImportConnectionsAction(): Promise<{ id: string; label: string; company: string | null }[]> {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requireAuthorization({ permission: "bill.read", userId, orgId, supabase, logDecision: true })
  const { data, error } = await supabase
    .from("accounting_connections")
    .select("id,label,external_account_name")
    .eq("org_id", orgId)
    .eq("provider", "qbo")
    .eq("status", "active")
    .order("connected_at")
  if (error) throw new Error(`Failed to load QuickBooks connections: ${error.message}`)
  return (data ?? []).map((row) => ({ id: row.id, label: row.label, company: row.external_account_name ?? null }))
}

/** List QBO transactions with no Arc counterpart, optionally bounded by a lookback window. */
export async function listQboImportRecordsAction(params?: {
  connectionId?: string
  sinceDate?: string | null
  types?: QboImportEntityType[]
}): Promise<QboImportListing> {
  try {
    if (!params?.connectionId) return { connected: false, records: [] }
    return await listImportableQboRecords({ connectionId: params.connectionId, sinceDate: params.sinceDate, types: params.types })
  } catch (error: any) {
    return {
      connected: true,
      records: [],
      loadErrors: [{ entityType: "invoice", message: error?.message ?? "Couldn't load QuickBooks records." }],
    }
  }
}

/** Full QBO customer/project list for the import sheet's project filter. */
export async function listQboCustomersForImportAction(connectionId?: string): Promise<QboImportCustomerListing> {
  try {
    if (!connectionId) return { connected: false, customers: [] }
    return await listQboCustomersForImport({ connectionId })
  } catch (error) {
    return { connected: true, customers: [] }
  }
}

/** Lightweight project list (id + name) for the per-line "allocate to project" picker. */
export async function listProjectsForImportAction(): Promise<{ id: string; name: string; costCodesEnabled: boolean }[]> {
  const projects = await listProjects()
  return projects.map((project) => ({
    id: project.id,
    name: project.name,
    costCodesEnabled: project.financial_settings?.cost_codes_enabled ?? true,
  }))
}

export async function listCostCodesForImportAction(): Promise<{ id: string; code: string | null; name: string | null }[]> {
  try {
    const { supabase, orgId } = await requireOrgContext()
    const { data, error } = await supabase
      .from("cost_codes")
      .select("id, code, name")
      .eq("org_id", orgId)
      .eq("is_active", true)
      .order("code", { ascending: true })
    if (error) throw new Error(`Failed to load cost codes: ${error.message}`)
    return (data ?? []).map((row) => ({
      id: row.id as string,
      code: (row.code as string | null) ?? null,
      name: (row.name as string | null) ?? null,
    }))
  } catch {
    return []
  }
}

/** Import the selected QBO transactions, each into its own destination project, creating pre-linked Arc records. */
export async function importQboRecordsAction(params: {
  connectionId: string
  items: {
    qboId: string
    entityType: QboImportEntityType
    projectId?: string
    allocations?: Record<string, string>
    costCodes?: Record<string, string>
  }[]
}): Promise<QboImportResult> {
  let result: QboImportResult
  try {
    result = await importQboRecords({ connectionId: params.connectionId, items: params.items })
  } catch (error: any) {
    return {
      imported: 0,
      skipped: 0,
      failed: params.items.length,
      errors: params.items.map((item) => ({
        qboId: item.qboId,
        entityType: item.entityType,
        message: error?.message ?? "Import failed",
      })),
    }
  }

  if (result.imported > 0) {
    // Revalidate every project that received a record (records can land in different projects).
    const projectIds = new Set(
      [
        ...(result.affectedProjectIds ?? []),
        ...params.items.map((item) => item.projectId).filter((id): id is string => Boolean(id)),
        ...params.items.flatMap((item) => Object.values(item.allocations ?? {})),
      ].filter((id): id is string => Boolean(id)),
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
  connectionId: string
  qboId: string
  entityType: "invoice" | "expense" | "bill"
  existingEntityId: string
}): Promise<{ linked: true } | { linked: false; error: string }> {
  let result: { linked: true }
  try {
    result = await linkExistingQboImportRecord(params)
  } catch (error: any) {
    return { linked: false, error: error?.message ?? "Couldn't link existing record" }
  }
  revalidatePath("/projects")
  revalidatePath("/invoices")
  return result
}
