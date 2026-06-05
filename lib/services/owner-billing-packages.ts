import { createHash } from "crypto"
import type { SupabaseClient } from "@supabase/supabase-js"

import type { Invoice } from "@/lib/types"
import { requireAuthorization } from "@/lib/services/authorization"
import { requireOrgContext } from "@/lib/services/context"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { listOpenBookCostDetailsForInvoice } from "@/lib/services/cost-plus"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

export type OwnerBillingPackageStatus = "draft" | "generated" | "shared" | "downloaded" | "accepted" | "voided"
export type CostApprovalBatchStatus = "draft" | "ready" | "pending" | "sent" | "approved" | "rejected" | "expired" | "voided"

export interface CostApprovalBatch {
  id: string
  org_id: string
  project_id: string
  billing_period_id?: string | null
  invoice_id?: string | null
  name: string
  status: CostApprovalBatchStatus
  billable_cost_ids: string[]
  time_entry_ids: string[]
  total_cost_cents: number
  total_markup_cents: number
  total_billable_cents: number
  requested_at?: string | null
  due_at?: string | null
  approved_at?: string | null
  rejected_at?: string | null
  rejection_reason?: string | null
  approved_by_name?: string | null
  approved_by_email?: string | null
  portal_token_id?: string | null
  snapshot: Record<string, any>
  metadata: Record<string, any>
  created_at?: string
  updated_at?: string
}

export interface InvoiceBackupPackage {
  id: string
  org_id: string
  project_id: string
  invoice_id: string
  approval_batch_id?: string | null
  billing_period_id?: string | null
  name: string
  status: OwnerBillingPackageStatus
  manifest: Record<string, any>
  manifest_hash?: string | null
  invoice_file_id?: string | null
  package_file_id?: string | null
  proof_file_ids: string[]
  generated_at?: string | null
  shared_at?: string | null
  downloaded_at?: string | null
  accepted_at?: string | null
  portal_token_id?: string | null
  metadata: Record<string, any>
  approval_batch?: CostApprovalBatch | null
  created_at?: string
  updated_at?: string
}

export interface OwnerBillingPackageSummary {
  invoice_id: string
  package_id: string
  approval_batch_id?: string | null
  status: OwnerBillingPackageStatus
  batch_status?: CostApprovalBatchStatus | null
  name: string
  manifest_hash?: string | null
  proof_count: number
  cost_count: number
  generated_at?: string | null
  shared_at?: string | null
  downloaded_at?: string | null
  total_billable_cents: number
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`).join(",")}}`
}

function hashManifest(manifest: Record<string, any>) {
  return createHash("sha256").update(stableStringify(manifest)).digest("hex")
}

function uniq(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))))
}

function mapBatch(row: any): CostApprovalBatch {
  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id,
    billing_period_id: row.billing_period_id ?? null,
    invoice_id: row.invoice_id ?? null,
    name: row.name,
    status: row.status,
    billable_cost_ids: Array.isArray(row.billable_cost_ids) ? row.billable_cost_ids : [],
    time_entry_ids: Array.isArray(row.time_entry_ids) ? row.time_entry_ids : [],
    total_cost_cents: Number(row.total_cost_cents ?? 0),
    total_markup_cents: Number(row.total_markup_cents ?? 0),
    total_billable_cents: Number(row.total_billable_cents ?? 0),
    requested_at: row.requested_at ?? null,
    due_at: row.due_at ?? null,
    approved_at: row.approved_at ?? null,
    rejected_at: row.rejected_at ?? null,
    rejection_reason: row.rejection_reason ?? null,
    approved_by_name: row.approved_by_name ?? null,
    approved_by_email: row.approved_by_email ?? null,
    portal_token_id: row.portal_token_id ?? null,
    snapshot: row.snapshot ?? {},
    metadata: row.metadata ?? {},
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function mapPackage(row: any): InvoiceBackupPackage {
  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id,
    invoice_id: row.invoice_id,
    approval_batch_id: row.approval_batch_id ?? null,
    billing_period_id: row.billing_period_id ?? null,
    name: row.name,
    status: row.status,
    manifest: row.manifest ?? {},
    manifest_hash: row.manifest_hash ?? null,
    invoice_file_id: row.invoice_file_id ?? null,
    package_file_id: row.package_file_id ?? null,
    proof_file_ids: Array.isArray(row.proof_file_ids) ? row.proof_file_ids : [],
    generated_at: row.generated_at ?? null,
    shared_at: row.shared_at ?? null,
    downloaded_at: row.downloaded_at ?? null,
    accepted_at: row.accepted_at ?? null,
    portal_token_id: row.portal_token_id ?? null,
    metadata: row.metadata ?? {},
    approval_batch: row.approval_batch ? mapBatch(Array.isArray(row.approval_batch) ? row.approval_batch[0] : row.approval_batch) : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

export function summarizeOwnerBillingPackage(row: InvoiceBackupPackage): OwnerBillingPackageSummary {
  return {
    invoice_id: row.invoice_id,
    package_id: row.id,
    approval_batch_id: row.approval_batch_id,
    status: row.status,
    batch_status: row.approval_batch?.status ?? null,
    name: row.name,
    manifest_hash: row.manifest_hash,
    proof_count: row.proof_file_ids.length,
    cost_count: Array.isArray(row.manifest?.costs) ? row.manifest.costs.length : 0,
    generated_at: row.generated_at,
    shared_at: row.shared_at,
    downloaded_at: row.downloaded_at,
    total_billable_cents: Number(row.manifest?.totals?.billable_cents ?? row.approval_batch?.total_billable_cents ?? 0),
  }
}

async function requireInvoicePackagePermission(args: {
  supabase: SupabaseClient
  orgId: string
  userId: string
  projectId: string
  permission: "invoice.read" | "invoice.write" | "invoice.send"
  resourceId?: string
}) {
  await requireAuthorization({
    permission: args.permission,
    userId: args.userId,
    orgId: args.orgId,
    projectId: args.projectId,
    supabase: args.supabase,
    logDecision: true,
    resourceType: "owner_billing_package",
    resourceId: args.resourceId,
  })
}

async function loadInvoiceForPackage(args: {
  supabase: SupabaseClient
  orgId: string
  projectId: string
  invoiceId: string
}) {
  const { data, error } = await args.supabase
    .from("invoices")
    .select(
      "id, org_id, project_id, file_id, billing_period_id, token, invoice_number, title, status, issue_date, due_date, notes, client_visible, subtotal_cents, tax_cents, total_cents, balance_due_cents, metadata, created_at, updated_at, viewed_at, sent_at, sent_to_emails, invoice_lines(id, cost_code_id, description, quantity, unit, unit_price_cents, metadata, sort_order)",
    )
    .eq("org_id", args.orgId)
    .eq("project_id", args.projectId)
    .eq("id", args.invoiceId)
    .maybeSingle()

  if (error) throw new Error(`Failed to load invoice for backup package: ${error.message}`)
  if (!data) throw new Error("Invoice not found")
  return data as any
}

async function loadFilesById(args: { supabase: SupabaseClient; orgId: string; fileIds: string[] }) {
  if (args.fileIds.length === 0) return []
  const { data, error } = await args.supabase
    .from("files")
    .select("id, file_name, storage_path, mime_type, size_bytes, category, folder_path, share_with_clients, created_at")
    .eq("org_id", args.orgId)
    .in("id", args.fileIds)

  if (error) throw new Error(`Failed to load backup files: ${error.message}`)
  return data ?? []
}

async function buildPackageManifest({
  supabase,
  orgId,
  projectId,
  invoice,
}: {
  supabase: SupabaseClient
  orgId: string
  projectId: string
  invoice: any
}) {
  const costs = await listOpenBookCostDetailsForInvoice({ invoiceId: invoice.id, orgId, projectId })
  const invoiceMetadata = invoice.metadata ?? {}
  const invoiceFileId = invoice.file_id ?? invoiceMetadata.latest_pdf_file_id ?? null
  const proofFileIds = uniq(costs.map((cost: any) => cost.proof_file_id))
  const fileIds = uniq([invoiceFileId, ...proofFileIds])
  const files = await loadFilesById({ supabase, orgId, fileIds })
  const fileById = new Map(files.map((file: any) => [file.id, file]))

  const lineRows = Array.isArray(invoice.invoice_lines) ? invoice.invoice_lines : []
  const lines = lineRows
    .sort((a: any, b: any) => Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0))
    .map((line: any) => ({
      id: line.id,
      cost_code_id: line.cost_code_id ?? null,
      description: line.description,
      quantity: Number(line.quantity ?? 1),
      unit: line.unit ?? null,
      unit_price_cents: Number(line.unit_price_cents ?? 0),
      amount_cents: Math.round(Number(line.quantity ?? 1) * Number(line.unit_price_cents ?? 0)),
      billable_cost_ids: Array.isArray(line.metadata?.billable_cost_ids) ? line.metadata.billable_cost_ids : [],
    }))

  const costRows = costs.map((cost: any) => ({
    id: cost.id,
    source_type: cost.source_type,
    source_id: cost.source_id,
    source_company_id: cost.source_company_id ?? null,
    source_company_name: cost.source_company_name ?? null,
    source_status: cost.source_status ?? null,
    occurred_on: cost.occurred_on,
    description: cost.description ?? null,
    cost_code_id: cost.cost_code_id ?? null,
    cost_code_code: cost.cost_code_code ?? cost.cost_code?.code ?? null,
    cost_code_name: cost.cost_code_name ?? cost.cost_code?.name ?? null,
    cost_cents: Number(cost.cost_cents ?? 0),
    markup_percent_resolved: Number(cost.markup_percent_resolved ?? 0),
    markup_cents: Number(cost.markup_cents ?? 0),
    billable_cents: Number(cost.billable_cents ?? 0),
    proof_file_id: cost.proof_file_id ?? null,
  }))

  const totals = {
    invoice_subtotal_cents: Number(invoice.subtotal_cents ?? invoiceMetadata?.totals?.subtotal_cents ?? 0),
    invoice_tax_cents: Number(invoice.tax_cents ?? invoiceMetadata?.totals?.tax_cents ?? 0),
    invoice_total_cents: Number(invoice.total_cents ?? invoiceMetadata?.totals?.total_cents ?? 0),
    invoice_balance_due_cents: Number(invoice.balance_due_cents ?? invoiceMetadata?.totals?.balance_due_cents ?? invoice.total_cents ?? 0),
    cost_cents: costRows.reduce((sum, cost) => sum + cost.cost_cents, 0),
    markup_cents: costRows.reduce((sum, cost) => sum + cost.markup_cents, 0),
    billable_cents: costRows.reduce((sum, cost) => sum + cost.billable_cents, 0),
  }

  const manifest = {
    manifest_version: 1,
    generated_at: new Date().toISOString(),
    invoice: {
      id: invoice.id,
      invoice_number: invoice.invoice_number,
      title: invoice.title,
      status: invoice.status,
      issue_date: invoice.issue_date ?? null,
      due_date: invoice.due_date ?? null,
      billing_period_id: invoice.billing_period_id ?? invoiceMetadata.billing_period_id ?? null,
      file_id: invoiceFileId,
      client_visible: invoice.client_visible ?? false,
    },
    totals,
    lines,
    costs: costRows,
    files: files.map((file: any) => ({
      id: file.id,
      file_name: file.file_name,
      mime_type: file.mime_type ?? null,
      size_bytes: file.size_bytes ?? null,
      category: file.category ?? null,
      folder_path: file.folder_path ?? null,
      share_with_clients: file.share_with_clients ?? false,
      role: file.id === invoiceFileId ? "invoice_pdf" : "cost_proof",
      created_at: file.created_at ?? null,
    })),
    proof: {
      required: Boolean(invoiceMetadata.proof_required),
      proof_file_ids: proofFileIds,
      missing_cost_ids: costRows.filter((cost) => !cost.proof_file_id).map((cost) => cost.id),
    },
    controls: {
      source: "arc_phase_5_owner_billing_package",
      package_artifact_status: "manifest_only",
    },
  }

  return {
    manifest,
    manifestHash: hashManifest(manifest),
    invoiceFileId,
    proofFileIds,
    filesById: fileById,
    totals,
    costIds: costRows.map((cost) => cost.id),
  }
}

export async function listProjectOwnerBillingPackageSummaries(projectId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireInvoicePackagePermission({
    supabase,
    orgId: resolvedOrgId,
    userId,
    projectId,
    permission: "invoice.read",
  })

  const { data, error } = await supabase
    .from("invoice_backup_packages")
    .select("*, approval_batch:cost_approval_batches(*)")
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)
    .neq("status", "voided")
    .order("created_at", { ascending: false })

  if (error) throw new Error(`Failed to load owner billing packages: ${error.message}`)
  return (data ?? []).map(mapPackage).map(summarizeOwnerBillingPackage)
}

export async function generateInvoiceBackupPackage(input: { projectId: string; invoiceId: string }, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireInvoicePackagePermission({
    supabase,
    orgId: resolvedOrgId,
    userId,
    projectId: input.projectId,
    permission: "invoice.write",
    resourceId: input.invoiceId,
  })

  const invoice = await loadInvoiceForPackage({
    supabase,
    orgId: resolvedOrgId,
    projectId: input.projectId,
    invoiceId: input.invoiceId,
  })
  const built = await buildPackageManifest({
    supabase,
    orgId: resolvedOrgId,
    projectId: input.projectId,
    invoice,
  })
  const packageName = `Backup package ${invoice.invoice_number ?? invoice.id}`
  const batchName = `Owner approval ${invoice.invoice_number ?? invoice.id}`
  const now = new Date().toISOString()

  const { data: existingBatchRows, error: existingBatchError } = await supabase
    .from("cost_approval_batches")
    .select("*")
    .eq("org_id", resolvedOrgId)
    .eq("project_id", input.projectId)
    .eq("invoice_id", input.invoiceId)
    .neq("status", "voided")
    .order("created_at", { ascending: false })
    .limit(1)

  if (existingBatchError) throw new Error(`Failed to load owner approval batch: ${existingBatchError.message}`)
  const existingBatch = existingBatchRows?.[0] ?? null
  const batchPayload = {
    org_id: resolvedOrgId,
    project_id: input.projectId,
    invoice_id: input.invoiceId,
    billing_period_id: invoice.billing_period_id ?? invoice.metadata?.billing_period_id ?? null,
    name: batchName,
    status: existingBatch?.status === "approved" ? "approved" : "ready",
    billable_cost_ids: built.costIds,
    total_cost_cents: built.totals.cost_cents,
    total_markup_cents: built.totals.markup_cents,
    total_billable_cents: built.totals.billable_cents,
    requested_at: existingBatch?.requested_at ?? now,
    snapshot: built.manifest,
    metadata: {
      ...(existingBatch?.metadata ?? {}),
      manifest_hash: built.manifestHash,
      proof_file_count: built.proofFileIds.length,
      generated_at: now,
    },
    created_by: existingBatch?.created_by ?? userId,
    updated_by: userId,
  }

  const batchResult = existingBatch
    ? await supabase.from("cost_approval_batches").update(batchPayload).eq("id", existingBatch.id).select("*").single()
    : await supabase.from("cost_approval_batches").insert(batchPayload).select("*").single()

  if (batchResult.error || !batchResult.data) {
    throw new Error(`Failed to save owner approval batch: ${batchResult.error?.message}`)
  }
  const batch = mapBatch(batchResult.data)

  const { data: existingPackageRows, error: existingPackageError } = await supabase
    .from("invoice_backup_packages")
    .select("*")
    .eq("org_id", resolvedOrgId)
    .eq("invoice_id", input.invoiceId)
    .neq("status", "voided")
    .order("created_at", { ascending: false })
    .limit(1)

  if (existingPackageError) throw new Error(`Failed to load backup package: ${existingPackageError.message}`)
  const existingPackage = existingPackageRows?.[0] ?? null
  const packagePayload = {
    org_id: resolvedOrgId,
    project_id: input.projectId,
    invoice_id: input.invoiceId,
    approval_batch_id: batch.id,
    billing_period_id: invoice.billing_period_id ?? invoice.metadata?.billing_period_id ?? null,
    name: packageName,
    status: existingPackage?.status === "shared" || existingPackage?.status === "downloaded" ? existingPackage.status : "generated",
    manifest: built.manifest,
    manifest_hash: built.manifestHash,
    invoice_file_id: built.invoiceFileId,
    package_file_id: existingPackage?.package_file_id ?? null,
    proof_file_ids: built.proofFileIds,
    generated_at: now,
    generated_by: userId,
    portal_token_id: existingPackage?.portal_token_id ?? null,
    metadata: {
      ...(existingPackage?.metadata ?? {}),
      manifest_only: true,
      file_count: built.manifest.files.length,
      cost_count: built.costIds.length,
    },
    created_by: existingPackage?.created_by ?? userId,
    updated_by: userId,
  }

  const packageResult = existingPackage
    ? await supabase.from("invoice_backup_packages").update(packagePayload).eq("id", existingPackage.id).select("*, approval_batch:cost_approval_batches(*)").single()
    : await supabase.from("invoice_backup_packages").insert(packagePayload).select("*, approval_batch:cost_approval_batches(*)").single()

  if (packageResult.error || !packageResult.data) {
    throw new Error(`Failed to save backup package: ${packageResult.error?.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: existingPackage ? "update" : "insert",
    entityType: "invoice_backup_package",
    entityId: packageResult.data.id,
    after: packageResult.data,
  })
  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "invoice_backup_package_generated",
    entityType: "invoice_backup_package",
    entityId: packageResult.data.id,
    payload: {
      project_id: input.projectId,
      invoice_id: input.invoiceId,
      approval_batch_id: batch.id,
      manifest_hash: built.manifestHash,
      cost_count: built.costIds.length,
      proof_file_count: built.proofFileIds.length,
    },
  })

  return mapPackage(packageResult.data)
}

export async function shareInvoiceBackupPackage(input: { projectId: string; packageId: string }, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const { data: existing, error: existingError } = await supabase
    .from("invoice_backup_packages")
    .select("*")
    .eq("org_id", resolvedOrgId)
    .eq("project_id", input.projectId)
    .eq("id", input.packageId)
    .maybeSingle()

  if (existingError) throw new Error(`Failed to load backup package: ${existingError.message}`)
  if (!existing) throw new Error("Backup package not found")

  await requireInvoicePackagePermission({
    supabase,
    orgId: resolvedOrgId,
    userId,
    projectId: input.projectId,
    permission: "invoice.send",
    resourceId: input.packageId,
  })

  const now = new Date().toISOString()
  const { data: invoice, error: invoiceError } = await supabase
    .from("invoices")
    .select("id, metadata, token, client_visible")
    .eq("org_id", resolvedOrgId)
    .eq("project_id", input.projectId)
    .eq("id", existing.invoice_id)
    .maybeSingle()

  if (invoiceError || !invoice) throw new Error(`Failed to load invoice for sharing: ${invoiceError?.message ?? "not found"}`)

  const { ensureInvoiceToken } = await import("@/lib/services/invoices")
  await ensureInvoiceToken(existing.invoice_id, resolvedOrgId)
  const { error: invoiceUpdateError } = await supabase
    .from("invoices")
    .update({
      client_visible: true,
      metadata: {
        ...(invoice.metadata ?? {}),
        owner_backup_package_id: existing.id,
        owner_backup_package_shared_at: now,
      },
    })
    .eq("org_id", resolvedOrgId)
    .eq("id", existing.invoice_id)

  if (invoiceUpdateError) throw new Error(`Failed to expose invoice for portal backup: ${invoiceUpdateError.message}`)

  if (existing.approval_batch_id) {
    const { error: batchError } = await supabase
      .from("cost_approval_batches")
      .update({ status: "sent", requested_at: now, updated_by: userId })
      .eq("org_id", resolvedOrgId)
      .eq("id", existing.approval_batch_id)

    if (batchError) throw new Error(`Failed to mark owner approval batch sent: ${batchError.message}`)
  }

  const { data, error } = await supabase
    .from("invoice_backup_packages")
    .update({ status: "shared", shared_at: now, shared_by: userId, updated_by: userId })
    .eq("org_id", resolvedOrgId)
    .eq("id", input.packageId)
    .select("*, approval_batch:cost_approval_batches(*)")
    .single()

  if (error || !data) throw new Error(`Failed to share backup package: ${error?.message}`)

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "invoice_backup_package_shared",
    entityType: "invoice_backup_package",
    entityId: input.packageId,
    payload: { project_id: input.projectId, invoice_id: existing.invoice_id },
    channel: "notification",
  })

  return mapPackage(data)
}

export async function listSharedInvoiceBackupPackagesForPortal(args: {
  orgId: string
  projectId: string
  invoiceId: string
}) {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("invoice_backup_packages")
    .select("*, approval_batch:cost_approval_batches(*)")
    .eq("org_id", args.orgId)
    .eq("project_id", args.projectId)
    .eq("invoice_id", args.invoiceId)
    .in("status", ["shared", "downloaded", "accepted"])
    .order("shared_at", { ascending: false })

  if (error) throw new Error(`Failed to load shared backup packages: ${error.message}`)
  return (data ?? []).map(mapPackage)
}

export async function getSharedBackupPackageManifestForPortal(args: {
  orgId: string
  projectId: string
  invoiceId: string
  packageId: string
  portalTokenId?: string | null
}) {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("invoice_backup_packages")
    .select("*, approval_batch:cost_approval_batches(*)")
    .eq("org_id", args.orgId)
    .eq("project_id", args.projectId)
    .eq("invoice_id", args.invoiceId)
    .eq("id", args.packageId)
    .in("status", ["shared", "downloaded", "accepted"])
    .maybeSingle()

  if (error) throw new Error(`Failed to load backup package: ${error.message}`)
  if (!data) return null

  const now = new Date().toISOString()
  const downloadedAt = data.downloaded_at ?? now
  const status = data.status === "shared" ? "downloaded" : data.status
  await supabase
    .from("invoice_backup_packages")
    .update({
      status,
      downloaded_at: downloadedAt,
      portal_token_id: args.portalTokenId ?? data.portal_token_id ?? null,
    })
    .eq("org_id", args.orgId)
    .eq("id", args.packageId)

  if (data.package_file_id) {
    await supabase.from("file_access_events").insert({
      org_id: args.orgId,
      file_id: data.package_file_id,
      portal_token_id: args.portalTokenId ?? null,
      action: "download",
      metadata: {
        entity_type: "invoice_backup_package",
        entity_id: args.packageId,
        invoice_id: args.invoiceId,
      },
    })
  }

  return mapPackage({
    ...data,
    status,
    downloaded_at: downloadedAt,
    portal_token_id: args.portalTokenId ?? data.portal_token_id ?? null,
  })
}
