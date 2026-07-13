import { z } from "zod"

import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { requireAnyPermission, requirePermission } from "@/lib/services/permissions"

const inputSchema = z.object({
  id: z.string().uuid().optional(),
  projectId: z.string().uuid(),
  documentTypeId: z.string().uuid(),
  fileId: z.string().uuid(),
  effectiveDate: z.string().date().nullable().optional(),
  expiryDate: z.string().date().nullable().optional(),
  policyNumber: z.string().trim().max(120).nullable().optional(),
  carrierName: z.string().trim().max(200).nullable().optional(),
  coverageAmountCents: z.number().int().nonnegative().nullable().optional(),
})

export type ProjectOwnComplianceDocument = {
  id: string
  project_id: string
  document_type_id: string
  document_type_name: string
  file_id: string
  file_name: string
  status: "pending_review" | "approved" | "rejected" | "expired"
  effective_date: string | null
  expiry_date: string | null
  policy_number: string | null
  carrier_name: string | null
  coverage_amount_cents: number | null
}

function mapRow(row: any): ProjectOwnComplianceDocument {
  const expired = row.expiry_date && row.expiry_date < new Date().toISOString().slice(0, 10)
  return {
    id: row.id,
    project_id: row.project_id,
    document_type_id: row.document_type_id,
    document_type_name: row.compliance_document_types?.name ?? "Compliance document",
    file_id: row.file_id,
    file_name: row.files?.file_name ?? "File",
    status: expired ? "expired" : row.status,
    effective_date: row.effective_date ?? null,
    expiry_date: row.expiry_date ?? null,
    policy_number: row.policy_number ?? null,
    carrier_name: row.carrier_name ?? null,
    coverage_amount_cents: row.coverage_amount_cents == null ? null : Number(row.coverage_amount_cents),
  }
}

async function requireProject(supabase: any, orgId: string, projectId: string) {
  const { data, error } = await supabase.from("projects").select("id").eq("org_id", orgId).eq("id", projectId).maybeSingle()
  if (error || !data) throw new Error("Project not found")
}

/**
 * Compatibility for the legacy NOT NULL compliance_documents.company_id FK.
 * The metadata marker is deliberately internal and excluded from normal vendor flows.
 */
async function getOrCreateOrgSelfCompany(supabase: any, orgId: string) {
  const { data: existing, error } = await supabase
    .from("companies")
    .select("id")
    .eq("org_id", orgId)
    .contains("metadata", { system_role: "org_self" })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`Failed to find organization compliance subject: ${error.message}`)
  if (existing) return existing.id as string

  const { data: org } = await supabase.from("orgs").select("name").eq("id", orgId).single()
  const { data: created, error: createError } = await supabase
    .from("companies")
    .insert({
      org_id: orgId,
      name: `${org?.name ?? "Organization"} (internal compliance subject)`,
      company_type: "other",
      metadata: { system_role: "org_self", hidden_from_directory: true },
    })
    .select("id")
    .single()
  if (createError?.code === "23505") {
    const { data: raced } = await supabase.from("companies").select("id").eq("org_id", orgId).contains("metadata", { system_role: "org_self" }).single()
    if (raced) return raced.id as string
  }
  if (createError || !created) throw new Error(`Failed to create organization compliance subject: ${createError?.message}`)
  return created.id as string
}

export async function listProjectOwnComplianceDocuments(projectId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("org.member", { supabase, orgId: resolvedOrgId, userId })
  await requireProject(supabase, resolvedOrgId, projectId)
  const { data, error } = await supabase
    .from("compliance_documents")
    .select("*, compliance_document_types(name), files(id, file_name)")
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)
    .eq("subject", "org")
    .order("expiry_date", { ascending: true, nullsFirst: false })
  if (error) throw new Error(`Failed to load our compliance documents: ${error.message}`)
  return (data ?? []).map(mapRow)
}

export async function upsertProjectOwnComplianceDocument(raw: z.input<typeof inputSchema>, orgId?: string) {
  const input = inputSchema.parse(raw)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["org.admin", "billing.manage", "bill.write", "invoice.write"], { supabase, orgId: resolvedOrgId, userId })
  await requireProject(supabase, resolvedOrgId, input.projectId)
  const [documentTypeResult, fileResult] = await Promise.all([
    supabase.from("compliance_document_types").select("id").eq("org_id", resolvedOrgId).eq("id", input.documentTypeId).eq("is_active", true).maybeSingle(),
    supabase.from("files").select("id, project_id").eq("org_id", resolvedOrgId).eq("id", input.fileId).maybeSingle(),
  ])
  if (documentTypeResult.error || !documentTypeResult.data) throw new Error("Invalid compliance document type")
  if (fileResult.error || !fileResult.data || (fileResult.data.project_id && fileResult.data.project_id !== input.projectId)) {
    throw new Error("Invalid project file")
  }
  const companyId = await getOrCreateOrgSelfCompany(supabase, resolvedOrgId)
  const status = input.expiryDate && input.expiryDate < new Date().toISOString().slice(0, 10) ? "expired" : "approved"
  const payload = {
    org_id: resolvedOrgId,
    company_id: companyId,
    project_id: input.projectId,
    subject: "org",
    document_type_id: input.documentTypeId,
    file_id: input.fileId,
    effective_date: input.effectiveDate ?? null,
    expiry_date: input.expiryDate ?? null,
    policy_number: input.policyNumber || null,
    carrier_name: input.carrierName || null,
    coverage_amount_cents: input.coverageAmountCents ?? null,
    status,
    reviewed_by: userId,
    reviewed_at: new Date().toISOString(),
  }
  const query = input.id
    ? supabase.from("compliance_documents").update(payload).eq("id", input.id).eq("org_id", resolvedOrgId).eq("subject", "org")
    : supabase.from("compliance_documents").insert(payload)
  const { data, error } = await query.select("*, compliance_document_types(name), files(id, file_name)").single()
  if (error || !data) throw new Error(`Failed to save our compliance document: ${error?.message}`)

  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: input.id ? "update" : "insert", entityType: "compliance_document", entityId: data.id, after: payload, source: "financials.our_compliance" })
  await recordEvent({ orgId: resolvedOrgId, actorId: userId, eventType: "project_own_compliance_saved", entityType: "compliance_document", entityId: data.id, channel: "activity", payload: { project_id: input.projectId, status } }).catch(() => null)
  return mapRow(data)
}

export async function expireProjectOwnComplianceDocuments(supabase: any, orgId: string, today: string) {
  const { data, error } = await supabase
    .from("compliance_documents")
    .update({ status: "expired" })
    .eq("org_id", orgId)
    .eq("subject", "org")
    .eq("status", "approved")
    .lt("expiry_date", today)
    .select("id")
  if (error) throw new Error(`Failed to expire GC compliance documents: ${error.message}`)
  return data?.length ?? 0
}
