import { readClosedSettlementEvidence } from "@/lib/financials/closing-settlement-evidence"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { assertClosingReadiness, authorizeClosingProject } from "@/lib/services/closing-readiness"
import { provisionWarrantyAtClosingForService } from "@/lib/services/books/warranty-accounting"
import { transitionInventoryForService } from "@/lib/services/books/inventory"
import { receivablesWriter } from "@/lib/services/receivables-writer"
import { randomUUID } from "crypto"
import { booksDigest } from "@/lib/services/books/hash"
import { readAllRows } from "@/lib/land/paging"

import type { SupabaseClient } from "@supabase/supabase-js"

import {
  buildClosingInvoiceLines,
  buildPurchaseAgreementSettlement,
  closingInvoiceLinesTotalCents,
  parseSettlementAdjustments,
  pendingSettlementWrites,
  type PurchaseAgreementPricing,
  type SettlementAdjustment,
  type SettlementDeposit,
} from "@/lib/financials/purchase-agreement-pricing"
import { SETTLEMENT_STATEMENT_LINK_ROLE } from "@/lib/invoices/attachment-roles"
import { uploadFilesObject } from "@/lib/storage/files-storage"
import { recordAudit } from "@/lib/services/audit"
import { applyCustomerDepositWithContext } from "@/lib/services/books/customer-deposits"
import { projectJournal } from "@/lib/services/books/projector"
import {
  authorize,
  getDivisionAccessForUser,
  getDivisionScopedProjectIds,
  requireAuthorization,
} from "@/lib/services/authorization"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { attachFile } from "@/lib/services/file-links"
import { createInitialVersion } from "@/lib/services/file-versions"
import { createFileRecord } from "@/lib/services/files"
import { createInvoice } from "@/lib/services/invoices"
import { recordPayment } from "@/lib/services/payments"
import { requirePermission } from "@/lib/services/permissions"
import { enqueueOutboxJob } from "@/lib/services/outbox"
import { scheduleClosingSchema, settleClosingSchema, updateClosingChecklistItemSchema, upsertClosingAdjustmentSchema } from "@/lib/validation/closings"

const DEFAULT_CHECKLIST = [
  { title: "Purchase agreement executed", gate: true },
  { title: "Earnest money received", gate: true },
  { title: "Final inspection / certificate of occupancy", gate: true },
  { title: "Blue-tape walk complete", gate: true },
  { title: "Open punch items cleared", gate: true },
  { title: "Homeowner orientation complete", gate: true },
  { title: "Final settlement statement reconciled", gate: true },
  { title: "Warranty package delivered", gate: false },
  { title: "HOA and closing documents delivered", gate: false },
]

function relationOne<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null
}

// Preview timestamps are not economic evidence. Canonical JSON also matches
// persisted JSONB when optional fields are omitted during serialization.
function settlementEvidenceDigest(value: Record<string, unknown>) {
  const { builtAt: _builtAt, ...evidence } = value
  return booksDigest(evidence)
}

async function ensureClosingChecklist(closingId: string, orgId: string, seed = true) {
  const context = await requireOrgContext(orgId)
  const { data: existing, error } = await context.supabase.from("closing_checklist_items").select("*").eq("org_id", orgId).eq("closing_id", closingId).order("sort_order")
  if (error) throw new Error(`Failed to load closing checklist: ${error.message}`)
  if ((existing ?? []).length || !seed) return existing ?? []
  const { data, error: insertError } = await context.supabase.from("closing_checklist_items").insert(DEFAULT_CHECKLIST.map((item, index) => ({ org_id: orgId, closing_id: closingId, title: item.title, is_gate: item.gate, status: "open", sort_order: index, created_by: context.userId }))).select("*")
  if (insertError) throw new Error(`Failed to seed closing checklist: ${insertError.message}`)
  return data ?? []
}

export async function buildSettlement(closingId: string, orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.read", context)
  const { data: closing, error } = await context.supabase.from("closings").select("id, project_id, status, metadata, settlement").eq("org_id", context.orgId).eq("id", closingId).maybeSingle()
  if (error || !closing) throw new Error("Closing not found")
  await requireAuthorization({ permission: "sales.read", orgId: context.orgId, userId: context.userId,
    projectId: closing.project_id, supabase: context.supabase, resourceType: "closing", resourceId: closing.id, logDecision: true })
  if (closing.status === "closed") return readClosedSettlementEvidence(closing.settlement)
  const [contractResult, changes, depositInvoices] = await Promise.all([
    context.supabase.from("contracts").select("id,number,total_cents,snapshot,signed_at,metadata").eq("org_id", context.orgId).eq("project_id", closing.project_id).eq("contract_type", "purchase_agreement").eq("status", "active").order("id").limit(2),
    readAllRows((from, to) => context.supabase.from("change_orders").select("id,title,total_cents,metadata").eq("org_id", context.orgId).eq("project_id", closing.project_id).eq("status", "approved").order("id").range(from, to), { cap: 10001, label: "Unable to read approved closing changes" }),
    readAllRows((from, to) => context.supabase.from("invoices").select("id,title,status,metadata").eq("org_id", context.orgId).eq("project_id", closing.project_id).contains("metadata", { invoice_kind: "earnest_deposit" }).order("id").range(from, to), { cap: 10001, label: "Unable to read earnest deposit invoices" }),
  ])
  if (contractResult.error) throw new Error(`Unable to verify settlement agreement: ${contractResult.error.message}`)
  if (contractResult.data?.length !== 1) throw new Error("Exactly one active purchase agreement is required for settlement")
  const contract = contractResult.data[0]
  if (changes.truncated || depositInvoices.truncated) throw new Error("Settlement source records exceed the supported limit; reconcile them before closing")
  const changeOrders = changes.rows
  const invoices = depositInvoices.rows
  const deposits: SettlementDeposit[] = []
  const labels = new Map(invoices.map(invoice => [invoice.id, invoice.title ?? "Earnest deposit"]))
  for (let offset = 0; offset < invoices.length; offset += 100) {
    const payments = await readAllRows((from, to) => context.supabase.from("payments").select("id,invoice_id,amount_cents,created_at")
      .eq("org_id", context.orgId).in("invoice_id", invoices.slice(offset, offset + 100).map(invoice => invoice.id))
      .eq("status", "succeeded").order("id").range(from, to), { cap: 10001, label: "Unable to read settlement deposits" })
    if (payments.truncated || deposits.length + payments.rows.length > 10000) throw new Error("Settlement deposits exceed the supported limit; reconcile them before closing")
    for (const payment of payments.rows) {
      const amountCents = Number(payment.amount_cents)
      if (!Number.isSafeInteger(amountCents) || amountCents < 0 || payment.amount_cents === null) throw new Error("Settlement deposit amount is invalid")
      deposits.push({ invoiceId: payment.invoice_id, paymentId: payment.id, label: labels.get(payment.invoice_id) ?? "Earnest deposit", amountCents, receivedAt: payment.created_at })
    }
  }
  if (contract.total_cents === null || !Number.isSafeInteger(Number(contract.total_cents))) throw new Error("Settlement agreement amount is invalid")
  if (changeOrders.some(row => row.total_cents === null || !Number.isSafeInteger(Number(row.total_cents)))) throw new Error("Approved closing change amount is invalid")
  const settlement = buildPurchaseAgreementSettlement({
    agreementTotalCents: Number(contract.total_cents ?? 0),
    approvedChangeOrders: (changeOrders ?? []).map((row: any) => ({ id: row.id, totalCents: Number(row.total_cents ?? 0) })),
    adjustments: parseSettlementAdjustments((closing.metadata as Record<string, unknown> | null)?.adjustments),
    deposits,
  })
  // A preview is computed evidence. Persist it only through the settlement owner.
  return { ...settlement, contractId: contract.id, agreement: { id: contract.id, number: contract.number ?? null, signed_at: contract.signed_at ?? null },
    agreementEvidenceDigest: booksDigest({ kind: "closing-agreement-v1", id: contract.id, totalCents: contract.total_cents, snapshot: contract.snapshot, signedAt: contract.signed_at, metadata: contract.metadata }),
    pricing: (contract.snapshot as any)?.purchase_agreement?.pricing as PurchaseAgreementPricing | undefined, changeOrders }
}

export async function getClosing(projectId: string, orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.read", context)
  await requireAuthorization({ permission: "sales.read", orgId: context.orgId, userId: context.userId,
    projectId, supabase: context.supabase, resourceType: "project", resourceId: projectId, logDecision: true })
  const { data: closing, error } = await context.supabase.from("closings").select("*, project:projects(name, client:contacts(full_name, email)), lot:lots(lot_number, status, address, plan:house_plans(name)), community:communities(name)").eq("org_id", context.orgId).eq("project_id", projectId).neq("status", "cancelled").maybeSingle()
  if (error) throw new Error(`Failed to load closing: ${error.message}`)
  if (!closing) return null
  const [checklist, settlementPreview, agreementResult, managementAccess, paymentAccess] = await Promise.all([
    ensureClosingChecklist(closing.id, context.orgId, false),
    buildSettlement(closing.id, context.orgId),
    closing.status === "closed" ? Promise.resolve({ data: null }) :
    context.supabase.from("contracts").select("id, number, title, status, total_cents, signed_at, snapshot").eq("org_id", context.orgId).eq("project_id", projectId).eq("contract_type", "purchase_agreement").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    authorize({ permission: "closing.manage", orgId: context.orgId, userId: context.userId, projectId, supabase: context.supabase }),
    authorize({ permission: "payment.release", orgId: context.orgId, userId: context.userId, projectId, supabase: context.supabase }),
  ])
  if ("error" in agreementResult && agreementResult.error) throw new Error(`Failed to read closing agreement: ${agreementResult.error.message}`)
  return { closing, checklist, settlementPreview, canManageClosing: managementAccess.allowed,
    canSettleClosing: managementAccess.allowed && paymentAccess.allowed,
    canRecoverCompletion: managementAccess.allowed, agreement: closing.status === "closed" ? settlementPreview.agreement : agreementResult.data ?? null }
}

export async function listClosings(opts: { communityId?: string; divisionId?: string; status?: string; from?: string; to?: string; limit?: number } = {}, orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.read", context)
  const authorizedProjectIds = await getDivisionScopedProjectIds({
    orgId: context.orgId,
    userId: context.userId,
    supabase: context.supabase,
  })
  let scopedProjectIds = authorizedProjectIds
  if (opts.divisionId) {
    let projectQuery = context.supabase
      .from("projects")
      .select("id")
      .eq("org_id", context.orgId)
      .eq("division_id", opts.divisionId)
      .limit(1000)
    if (authorizedProjectIds !== null) {
      projectQuery = projectQuery.in(
        "id",
        authorizedProjectIds.length
          ? authorizedProjectIds
          : ["00000000-0000-0000-0000-000000000000"],
      )
    }
    const { data: projects, error: projectError } = await projectQuery
    if (projectError) throw new Error(`Failed to scope closings: ${projectError.message}`)
    scopedProjectIds = (projects ?? []).map((project) => project.id)
  }
  let query = context.supabase.from("closings").select("*, project:projects(name, division_id, client:contacts(full_name, email)), lot:lots(lot_number), community:communities(name)", { count: "exact" }).eq("org_id", context.orgId)
  if (scopedProjectIds !== null) {
    query = query.in(
      "project_id",
      scopedProjectIds.length
        ? scopedProjectIds
        : ["00000000-0000-0000-0000-000000000000"],
    )
  }
  if (opts.communityId) query = query.eq("community_id", opts.communityId)
  if (opts.status) query = query.eq("status", opts.status)
  if (opts.from) query = query.gte("scheduled_date", opts.from)
  if (opts.to) query = query.lte("scheduled_date", opts.to)
  const { data, error, count } = await query.order("scheduled_date", { ascending: true, nullsFirst: false }).limit(Math.min(opts.limit ?? 250, 500))
  if (error) throw new Error(`Failed to list closings: ${error.message}`)
  return { closings: data ?? [], total: count ?? 0 }
}

async function loadEditableClosing(context: { supabase: SupabaseClient; orgId: string; userId: string }, closingId: string) {
  const { data, error } = await context.supabase.from("closings").select("*").eq("org_id", context.orgId).eq("id", closingId).maybeSingle()
  if (error) throw new Error(`Unable to read closing: ${error.message}`)
  if (!data) throw new Error("Closing not found")
  await authorizeClosingProject({ ...context, closingId: data.id, projectId: data.project_id })
  if (["closed", "cancelled"].includes(data.status)) throw new Error("Closed or cancelled closing evidence cannot be changed")
  return data
}

export async function scheduleClosing(input: unknown, orgId?: string) {
  const parsed = scheduleClosingSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("closing.manage", context)
  const before = await loadEditableClosing(context, parsed.closingId)
  if (!before || !["projected", "scheduled"].includes(before.status)) throw new Error("Projected closing not found")
  // Prepare through the existing authorized management action, never a page read.
  await ensureClosingChecklist(before.id, context.orgId)
  const { data, error } = await context.supabase.from("closings").update({ status: "scheduled", scheduled_date: parsed.scheduledDate }).eq("org_id", context.orgId).eq("id", before.id).eq("project_id", before.project_id).eq("status", before.status).select("*").single()
  if (error || !data) throw new Error(`Failed to schedule closing: ${error?.message}`)
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "closing_scheduled", entityType: "closing", entityId: data.id, payload: { scheduled_date: parsed.scheduledDate, project_id: data.project_id } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "closing", entityId: data.id, before, after: data }),
  ])
  return data
}

export async function updateClosingChecklistItem(input: unknown, orgId?: string) {
  const parsed = updateClosingChecklistItemSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("closing.manage", context)
  const { data: before, error: readError } = await context.supabase.from("closing_checklist_items").select("*").eq("org_id", context.orgId).eq("id", parsed.itemId).maybeSingle()
  if (readError) throw new Error(`Unable to read closing checklist item: ${readError.message}`)
  if (!before) throw new Error("Closing checklist item not found")
  const closing = await loadEditableClosing(context, before.closing_id)
  const fileId = parsed.fileId === undefined ? before.file_id : parsed.fileId
  if (fileId) {
    const file = await context.supabase.from("files").select("id").eq("org_id", context.orgId).eq("project_id", closing.project_id).eq("id", fileId).is("archived_at", null).maybeSingle()
    if (file.error) throw new Error(`Unable to verify closing evidence file: ${file.error.message}`)
    if (!file.data) throw new Error("Closing evidence file must belong to this home and remain available")
  }
  if (parsed.status === "waived" && !parsed.notes?.trim()) throw new Error("A reason is required to waive a closing gate")
  const { data, error } = await context.supabase.from("closing_checklist_items").update({ status: parsed.status, file_id: fileId, notes: parsed.notes === undefined ? before.notes : parsed.notes, completed_at: parsed.status !== "open" ? new Date().toISOString() : null, completed_by: parsed.status !== "open" ? context.userId : null }).eq("org_id", context.orgId).eq("id", parsed.itemId).eq("closing_id", closing.id).select("*").single()
  if (error || !data) throw new Error(`Failed to update closing checklist: ${error?.message}`)
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "closing_checklist_item", entityId: data.id, before, after: data })
  return data
}

/**
 * Records what the settlement table adds beyond the agreement — seller-paid
 * closing costs, lender or repair credits, tax and HOA prorations. Without
 * these the "final price" is only ever the contract, and no real closing
 * settles at the contract number.
 */
export async function upsertClosingAdjustment(input: unknown, orgId?: string) {
  const parsed = upsertClosingAdjustmentSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("closing.manage", context)
  const closing = await loadEditableClosing(context, parsed.closingId)
  const existing = parseSettlementAdjustments((closing.metadata as Record<string, unknown> | null)?.adjustments)
  const adjustment: SettlementAdjustment = { id: parsed.id ?? randomUUID(), label: parsed.label, kind: parsed.kind, amountCents: parsed.amountCents }
  const next = existing.some((row) => row.id === adjustment.id)
    ? existing.map((row) => (row.id === adjustment.id ? adjustment : row))
    : [...existing, adjustment]
  await writeClosingAdjustments(context, closing, next, parsed.id ? "update" : "insert", adjustment)
  return adjustment
}

export async function removeClosingAdjustment(input: { closingId: string; adjustmentId: string }, orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requirePermission("closing.manage", context)
  const closing = await loadEditableClosing(context, input.closingId)
  const existing = parseSettlementAdjustments((closing.metadata as Record<string, unknown> | null)?.adjustments)
  const removed = existing.find((row) => row.id === input.adjustmentId)
  if (!removed) throw new Error("Settlement adjustment not found")
  await writeClosingAdjustments(context, closing, existing.filter((row) => row.id !== input.adjustmentId), "delete", removed)
}

async function writeClosingAdjustments(
  context: { supabase: SupabaseClient; orgId: string; userId: string },
  closing: { id: string; project_id: string; status: string; metadata: unknown },
  adjustments: SettlementAdjustment[],
  action: "insert" | "update" | "delete",
  changed: SettlementAdjustment,
) {
  const metadata = { ...((closing.metadata ?? {}) as Record<string, unknown>), adjustments }
  const { data, error } = await context.supabase.from("closings").update({ metadata }).eq("org_id", context.orgId).eq("id", closing.id)
    .eq("project_id", closing.project_id).eq("status", closing.status).eq("metadata", JSON.stringify(closing.metadata ?? {})).select("id").single()
  if (error || !data) throw new Error(`Settlement adjustment changed concurrently or could not be saved: ${error?.message ?? "Retry after refreshing"}`)
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "closing_adjustment_recorded", entityType: "closing", entityId: closing.id, payload: { action, kind: changed.kind, amount_cents: changed.amountCents, label: changed.label } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: action === "delete" ? "delete" : action, entityType: "closing_adjustment", entityId: changed.id, after: action === "delete" ? undefined : changed, before: action === "delete" ? changed : undefined }),
  ])
}

export async function markClearedToClose(closingId: string, orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requirePermission("closing.manage", context)
  const { data: closing } = await context.supabase.from("closings").select("*").eq("org_id", context.orgId).eq("id", closingId).maybeSingle()
  if (!closing || closing.status !== "scheduled") throw new Error("Scheduled closing not found")
  await authorizeClosingProject({ ...context, closingId: closing.id, projectId: closing.project_id })
  await ensureClosingChecklist(closing.id, context.orgId)
  await assertClosingReadiness({ ...context, closingId: closing.id, projectId: closing.project_id })
  const { data, error } = await context.supabase.from("closings").update({ status: "cleared_to_close" }).eq("org_id", context.orgId).eq("id", closing.id).eq("status", "scheduled").select("*").single()
  if (error || !data) throw new Error(`Failed to clear closing: ${error?.message}`)
  await recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "closing_cleared", entityType: "closing", entityId: data.id, payload: { project_id: data.project_id } })
  return data
}

/**
 * Files the statement the buyer signs at the closing table against the closing
 * invoice, so the document the settlement produced is retrievable from the
 * money it settled.
 *
 * Settlement has already applied deposits, recorded cash and closed the lot by
 * the time this runs. None of that may be rolled back because a PDF failed to
 * render. Surface failure so the coordinator can retry completion using the
 * recorded settlement without recording funds again.
 */
async function persistSettlementStatement(
  context: { supabase: SupabaseClient; orgId: string; userId: string },
  closing: { id: string; project_id: string; metadata: unknown },
  invoiceId: string,
) {
  try {
    const priorId = (closing.metadata as Record<string, unknown> | null)?.settlement_statement_file_id
    if (typeof priorId === "string") {
      const [file, link] = await Promise.all([
        context.supabase.from("files").select("id").eq("org_id", context.orgId).eq("project_id", closing.project_id).eq("id", priorId).is("archived_at", null).maybeSingle(),
        context.supabase.from("file_links").select("id").eq("org_id", context.orgId).eq("project_id", closing.project_id).eq("file_id", priorId).eq("entity_type", "invoice").eq("entity_id", invoiceId).eq("link_role", SETTLEMENT_STATEMENT_LINK_ROLE).maybeSingle(),
      ])
      if (file.error || link.error) throw new Error("Unable to verify the recorded settlement statement")
      if (!file.data || !link.data) throw new Error("Recorded settlement statement is unavailable; reconcile its original file and invoice attachment")
      return
    }
    // Imported at call time: the report reads back through `getClosing`, and a
    // static import would make this module and the report circular.
    const { generateSettlementStatementPdf } = await import("@/lib/services/reports/settlement-statement")
    const { fileName, pdf } = await generateSettlementStatementPdf(closing.project_id, context.orgId)
    const storagePath = `${context.orgId}/${closing.project_id}/closings/${Date.now()}_${fileName}`
    await uploadFilesObject({ supabase: context.supabase, orgId: context.orgId, path: storagePath, bytes: pdf, contentType: "application/pdf", upsert: false })
    const fileRecord = await createFileRecord({
      project_id: closing.project_id,
      file_name: fileName,
      storage_path: storagePath,
      mime_type: "application/pdf",
      size_bytes: pdf.length,
      visibility: "private",
      category: "financials",
      folder_path: "Financials/Closings",
      description: "Settlement statement",
      source: "generated",
      share_with_clients: true,
      share_with_subs: false,
    }, context.orgId)
    await createInitialVersion({ fileId: fileRecord.id, storagePath, fileName, mimeType: "application/pdf", sizeBytes: pdf.length }, context.orgId)
    await attachFile({ file_id: fileRecord.id, entity_type: "invoice", entity_id: invoiceId, project_id: closing.project_id, link_role: SETTLEMENT_STATEMENT_LINK_ROLE }, context.orgId)
    const metadata = { ...((closing.metadata ?? {}) as Record<string, unknown>), settlement_statement_file_id: fileRecord.id }
    const { error } = await context.supabase.from("closings").update({ metadata }).eq("org_id", context.orgId).eq("id", closing.id)
    if (error) throw new Error(error.message)
  } catch (error) {
    console.error("[closings] Failed to file the settlement statement", { closingId: closing.id, error })
    await recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "closing_statement_failed", entityType: "closing", entityId: closing.id, payload: { closing_invoice_id: invoiceId, message: error instanceof Error ? error.message : "Unknown error" } }).catch(() => {})
    throw new Error(`Closing is recorded; retry completion after resolving the statement: ${error instanceof Error ? error.message : "Unknown error"}`)
  }
}

/** Resume home handoff after the monetary closing has already committed. */
export async function recoverClosingCompletion(projectId: string, closingId: string, orgId?: string) {
  const context = await requireOrgContext(orgId)
  await authorizeClosingProject({ ...context, projectId, closingId })
  const { data: closing, error } = await context.supabase.from("closings").select("*").eq("org_id", context.orgId).eq("project_id", projectId).eq("id", closingId).eq("status", "closed").single()
  if (error || !closing) throw new Error("Recorded closing not found")
  const settlement = readClosedSettlementEvidence(closing.settlement)
  if (!closing.closing_invoice_id || !closing.actual_date) throw new Error("Recorded closing invoice or date is missing; reconcile closing evidence")
  const invoice = await context.supabase.from("invoices").select("id,total_cents,metadata").eq("org_id", context.orgId).eq("project_id", projectId).eq("id", closing.closing_invoice_id).single()
  const invoiceMetadata = invoice.data?.metadata as Record<string, unknown> | null
  const invoiceSettlement = invoiceMetadata?.settlement
  if (invoice.error || !invoice.data || invoice.data.total_cents !== settlement.finalPriceCents || invoiceMetadata?.source_closing_id !== closing.id ||
      !invoiceSettlement || typeof invoiceSettlement !== "object" || settlementEvidenceDigest(invoiceSettlement as Record<string, unknown>) !== settlementEvidenceDigest(settlement)) {
    throw new Error("Recorded closing invoice does not reconcile with the settlement")
  }
  if (closing.lot_id) {
    const lot = await context.supabase.from("lots").update({ status: "closed" }).eq("org_id", context.orgId).eq("project_id", projectId).eq("id", closing.lot_id).select("id").single()
    if (lot.error || !lot.data) throw new Error(`Closing is recorded; retry completion after resolving the lot: ${lot.error?.message ?? "Lot is missing or belongs to another home"}`)
  }
  const warranty = await enqueueOutboxJob({ orgId: context.orgId, jobType: "warranty_enroll_coverage", payload: { project_id: projectId, effective_date: closing.actual_date, source: "closing" }, dedupeByPayloadKeys: ["project_id", "effective_date", "source"] })
  if (!warranty.enqueued && warranty.reason !== "duplicate") throw new Error("Closing is recorded; warranty enrollment could not be queued. Retry completion.")
  await persistSettlementStatement(context, closing, closing.closing_invoice_id)
  return { closingId: closing.id, lotClosed: Boolean(closing.lot_id), warrantyQueued: true, statementFiled: true }
}

export async function settleClosing(input: unknown, orgId?: string) {
  const parsed = settleClosingSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("closing.manage", context)
  await requirePermission("payment.release", context)
  const { data: closing } = await context.supabase.from("closings").select("*, project:projects(name, client_id, client:contacts(full_name, email)), lot:lots(lot_number, house_plan_id, plan:house_plans(name))").eq("org_id", context.orgId).eq("id", parsed.closingId).maybeSingle()
  if (!closing) throw new Error("Closing not found")
  if (closing.status === "closed") {
    if (closing.actual_date !== parsed.actualDate) throw new Error("Retry must use the recorded closing date")
    await recoverClosingCompletion(closing.project_id, closing.id, context.orgId)
    return getClosing(closing.project_id, context.orgId)
  }
  if (closing.status !== "cleared_to_close") throw new Error("Closing must be cleared to close")
  await assertClosingReadiness({ ...context, closingId: closing.id, projectId: closing.project_id })
  await requireAuthorization({ permission: "payment.release", orgId: context.orgId, userId: context.userId,
    projectId: closing.project_id, supabase: context.supabase, resourceType: "closing", resourceId: closing.id, logDecision: true })
  const settlement = await buildSettlement(closing.id, context.orgId)
  if (settlement.balanceDueCents < 0) throw new Error("Deposits exceed the final purchase price; resolve the overpayment before closing")
  const pricing = settlement.pricing
  if (!pricing) throw new Error("Purchase agreement pricing snapshot is missing")
  const project = relationOne(closing.project) as any
  const lot = relationOne(closing.lot) as any
  const plan = relationOne(lot?.plan) as any
  const invoiceLines = buildClosingInvoiceLines({ pricing, lotLabel: lot?.lot_number ?? "—", planLabel: plan?.name ?? "Home", approvedChangeOrders: (settlement.changeOrders ?? []).map((row: any) => ({ id: row.id, title: row.title, totalCents: Number(row.total_cents ?? 0), number: row.metadata?.number ?? null })), adjustments: settlement.adjustments })
  // The billed lines are built from the agreement's pricing snapshot while the
  // settlement is built from the contract total. If those two ever disagree the
  // home would be billed an amount nobody authorized, so refuse to settle
  // rather than issue a wrong invoice.
  const linesTotalCents = closingInvoiceLinesTotalCents(invoiceLines)
  if (linesTotalCents !== settlement.finalPriceCents) {
    throw new Error(`Closing invoice lines total ${linesTotalCents} but the settlement final price is ${settlement.finalPriceCents}. Re-sync the purchase agreement pricing snapshot before settling.`)
  }
  // Deposit application is keyed on the customer both invoices name. Catch a
  // missing buyer here rather than letting the atomic apply reject with
  // "a customer deposit can only be applied to that customer's invoice".
  if (settlement.depositsApplied.length > 0 && !project?.client_id) {
    throw new Error("This home has no buyer on file, so collected deposits cannot be applied at settlement. Restore the buyer on the project first.")
  }
  // Settlement can fail partway (deposit application, payment, status write).
  // Reuse this closing's invoice on retry instead of stranding the first one.
  const { data: priorInvoice, error: priorInvoiceError } = await context.supabase.from("invoices").select("id,metadata").eq("org_id", context.orgId).eq("project_id", closing.project_id).contains("metadata", { invoice_kind: "closing", source_closing_id: closing.id }).maybeSingle()
  if (priorInvoiceError) throw new Error(`Unable to verify prior closing invoice: ${priorInvoiceError.message}`)
  if (priorInvoice) {
    const saved = (priorInvoice.metadata as Record<string, unknown> | null)?.settlement
    if (!saved || typeof saved !== "object" || Array.isArray(saved) || settlementEvidenceDigest(saved as Record<string, unknown>) !== settlementEvidenceDigest(settlement)) {
      throw new Error("Existing closing invoice settlement evidence differs or is missing; reconcile the recorded invoice before retrying")
    }
  }
  const invoice = priorInvoice ?? await createInvoice({ input: {
    project_id: closing.project_id, invoice_number: `CLOSE-${Date.now().toString().slice(-9)}`, title: `Closing — ${project?.name ?? "Home"}`,
    issue: true, issue_date: parsed.actualDate, due_date: parsed.actualDate, tax_rate: 0,
    customer_id: project?.client_id ?? null, customer_name: project?.client?.full_name ?? null, sent_to_emails: project?.client?.email ? [project.client.email] : undefined,
    lines: invoiceLines.map((line) => ({ description: line.description, quantity: 1, unit: "closing", unit_cost: line.amountCents / 100, taxable: false })),
    metadata: { invoice_kind: "closing", source_closing_id: closing.id, settlement },
  }, orgId: context.orgId, context, authorizationPermission: "closing.manage", sendAuthorizationPermission: "closing.manage" })
  const { data: issuedInvoice, error: issuedError } = await context.supabase.from("invoices").select("total_cents").eq("org_id", context.orgId).eq("id", invoice.id).single()
  if (issuedError || !issuedInvoice) throw new Error(`Failed to verify the closing invoice: ${issuedError?.message}`)
  if (Number(issuedInvoice.total_cents) !== settlement.finalPriceCents) {
    throw new Error(`Closing invoice ${invoice.id} totals ${issuedInvoice.total_cents} cents but the final price is ${settlement.finalPriceCents} cents.`)
  }
  // Relieve each earnest-deposit liability by applying the collected payment to
  // this invoice. Without this the deposit stays on the balance sheet forever
  // and revenue posts short by the deposit. Skip any that a previous attempt
  // already applied so a resumed settlement cannot double-apply.
  const { data: existingPayments, error: existingPaymentsError } = await context.supabase.from("payments").select("id, provider_payment_id, metadata").eq("org_id", context.orgId).eq("invoice_id", invoice.id).in("status", ["succeeded", "completed"])
  if (existingPaymentsError) throw new Error(`Failed to read closing invoice payments: ${existingPaymentsError.message}`)
  const balanceProviderPaymentId = `closing:${closing.id}`
  const pending = pendingSettlementWrites({
    deposits: settlement.depositsApplied,
    balanceDueCents: settlement.balanceDueCents,
    balanceProviderPaymentId,
    existingPayments: (existingPayments ?? []).map((payment) => ({ provider_payment_id: payment.provider_payment_id, metadata: payment.metadata as Record<string, unknown> | null })),
  })
  for (const deposit of pending.depositsToApply) {
    await applyCustomerDepositWithContext(context, { depositPaymentId: deposit.paymentId, targetInvoiceId: invoice.id, amountCents: deposit.amountCents, appliedAt: `${parsed.actualDate}T12:00:00Z` })
  }
  for (const deposit of settlement.depositsApplied) {
    const { data: depositInvoice } = await context.supabase.from("invoices").select("metadata").eq("org_id", context.orgId).eq("id", deposit.invoiceId).maybeSingle()
    await receivablesWriter().from("invoices").update({ metadata: { ...(depositInvoice?.metadata ?? {}), settled_into_closing_id: closing.id } }).eq("org_id", context.orgId).eq("id", deposit.invoiceId)
  }
  if (pending.recordBalance) {
    await recordPayment({ invoice_id: invoice.id, amount_cents: settlement.balanceDueCents, fee_cents: 0, currency: "usd", method: parsed.paymentMethod, received_at: `${parsed.actualDate}T12:00:00Z`, provider: "manual", provider_payment_id: balanceProviderPaymentId, reference: parsed.paymentReference, status: "succeeded", metadata: { source_closing_id: closing.id } }, context.orgId)
  }
  const { data: closingPayments, error: closingPaymentsError } = await context.supabase.from("payments")
    .select("id").eq("org_id",context.orgId).eq("invoice_id",invoice.id).gt("amount_cents",0).in("status",["succeeded","completed","paid"])
  if (closingPaymentsError) throw new Error(`Failed to verify closing receipts: ${closingPaymentsError.message}`)
  const sourceIds = [...(settlement.finalPriceCents !== 0 ? [invoice.id] : []), ...(closingPayments ?? []).map(row => row.id)]
  const sourceKeys = [`invoice:${invoice.id}`, ...(closingPayments ?? []).flatMap(row => [`invoice_payment:${row.id}`, `customer_deposit_application:${row.id}`])]
  const postingMetadata = { ...(closing.metadata ?? {}), books_posting_status: "pending", books_posting_error: null }
  const { error: pendingError } = await context.supabase.from("closings").update({ closing_invoice_id: invoice.id, settlement, metadata: postingMetadata }).eq("org_id",context.orgId).eq("id",closing.id)
  if (pendingError) throw new Error(`Failed to save pending settlement: ${pendingError.message}`)
  let projection: Awaited<ReturnType<typeof projectJournal>>
  try { projection = await projectJournal(context.orgId, { sourceKeys }) } catch (postingError) {
    const message = postingError instanceof Error ? postingError.message : "Books posting failed"
    const { error: failedError } = await context.supabase.from("closings").update({ metadata: { ...postingMetadata, books_posting_status: "failed", books_posting_error: message } }).eq("org_id", context.orgId).eq("id", closing.id)
    if (failedError) throw new Error(`${message}; retry state could not be saved: ${failedError.message}`)
    throw new Error(`Closing funds are recorded; retry settlement to finish Books posting: ${message}`)
  }
  const { data: booksSettings, error: booksError } = await createServiceSupabaseClient().from("books_settings").select("workspace_enabled,arc_ledger_mode").eq("org_id",context.orgId).maybeSingle()
  if (booksError) throw new Error(`Failed to verify Books posture: ${booksError.message}`)
  if (booksSettings?.workspace_enabled && booksSettings.arc_ledger_mode !== "disabled") {
    const { data: entries, error: entryError } = await createServiceSupabaseClient().from("journal_entries").select("source_id")
      .eq("org_id",context.orgId).eq("status","posted").in("source_id",sourceIds)
    const postedIds = new Set((entries ?? []).map(row => row.source_id))
    const missing = sourceIds.filter(id => !postedIds.has(id))
    if (entryError || projection.failures.length || missing.length) {
      const message = entryError?.message ?? (projection.failures.map(row => row.error).join("; ") || `Missing posting for ${missing.length} closing sources`)
      const { error: failedError } = await context.supabase.from("closings").update({ metadata: { ...postingMetadata, books_posting_status:"failed", books_posting_error:message } }).eq("org_id",context.orgId).eq("id",closing.id)
      if (failedError) throw new Error(`Posting failed and retry state could not be saved: ${failedError.message}`)
      throw new Error(`Closing funds are recorded; retry settlement to finish Books posting: ${message}`)
    }
  }

  const now = new Date().toISOString()
  try {
    if (booksSettings?.workspace_enabled && booksSettings.arc_ledger_mode !== "disabled") {
    await transitionInventoryForService({ orgId: context.orgId, projectId: closing.project_id, transition: "sale_relief", date: parsed.actualDate,
      evidenceUrl: `${(process.env.NEXT_PUBLIC_APP_URL || "https://arcnaples.com").replace(/\/$/, "")}/projects/${closing.project_id}/closing`, actorId: context.userId })
    await provisionWarrantyAtClosingForService(context.orgId, closing.project_id, parsed.actualDate, context.userId)
    }
  } catch (inventoryError) {
    const message = inventoryError instanceof Error ? inventoryError.message : "Inventory cost relief failed"
    const { error: failedError } = await context.supabase.from("closings").update({ metadata: { ...postingMetadata, books_posting_status: "failed", books_posting_error: message } }).eq("org_id", context.orgId).eq("id", closing.id)
    if (failedError) throw new Error(`${message}; failed to save posting state: ${failedError.message}`)
    throw new Error(`Closing funds are recorded; retry settlement after resolving inventory: ${message}`)
  }
  try {
    await assertClosingReadiness({ ...context, closingId: closing.id, projectId: closing.project_id })
    const currentSettlement = await buildSettlement(closing.id, context.orgId)
    if (settlementEvidenceDigest(currentSettlement) !== settlementEvidenceDigest(settlement)) throw new Error("Settlement terms or deposit evidence changed; reconcile the recorded funds before closing")
  }
  catch (readinessError) { throw new Error(`Closing funds are recorded; resolve readiness and retry settlement: ${readinessError instanceof Error ? readinessError.message : "Readiness unavailable"}`) }
  const { data: updated, error } = await context.supabase.from("closings").update({ status: "closed", actual_date: parsed.actualDate, settlement, metadata: { ...postingMetadata, books_posting_status: booksSettings?.workspace_enabled && booksSettings.arc_ledger_mode !== "disabled" ? "posted" : "not_enabled" }, closing_invoice_id: invoice.id, updated_at: now }).eq("org_id", context.orgId).eq("id", closing.id).eq("status", "cleared_to_close").select("*").single()
  if (error || !updated) throw new Error(`Failed to settle closing: ${error?.message}`)
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "closing_settled", entityType: "closing", entityId: closing.id, payload: { final_price_cents: settlement.finalPriceCents, community_id: closing.community_id, closing_invoice_id: invoice.id } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "closing", entityId: closing.id, before: closing, after: updated }),
  ])
  await recoverClosingCompletion(closing.project_id, closing.id, context.orgId)
  return getClosing(closing.project_id, context.orgId)
}

export async function cancelClosing(input: { closingId: string; reason: string }, orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requirePermission("closing.manage", context)
  if (!input.reason.trim() || input.reason.length > 2000) throw new Error("A cancellation reason is required (maximum 2000 characters)")
  const before = await loadEditableClosing(context, input.closingId)
  const { data, error } = await context.supabase.from("closings").update({ status: "cancelled", cancel_reason: input.reason.trim() }).eq("org_id", context.orgId)
    .eq("id", before.id).eq("project_id", before.project_id).eq("status", before.status).select("*").single()
  if (error || !data) throw new Error("Closing could not be cancelled")
  await recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "closing_cancelled", entityType: "closing", entityId: data.id, payload: { reason: input.reason } })
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "closing", entityId: data.id, before, after: data })
}

export interface BacklogReportRow {
  community_id: string
  community_name: string
  division_id: string | null
  lead_units: number
  spec_units: number
  hold_units: number
  reserved_units: number
  backlog_units: number
  backlog_value_cents: number
  scheduled_30d_units: number
  closed_units_ytd: number
  closed_value_ytd_cents: number
  avg_days_agreement_to_close: number | null
  cancellation_count: number
  cancellation_rate: number
  incentive_spend_cents: number
  incentive_percent_of_price: number
}

export async function getBacklogReport(opts: { divisionId?: string } = {}, orgId?: string): Promise<BacklogReportRow[]> {
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.read", context)
  const access = await getDivisionAccessForUser({
    orgId: context.orgId,
    userId: context.userId,
  })
  if (opts.divisionId && access.assignedOnly && !access.divisionIds.includes(opts.divisionId)) {
    return []
  }
  const { data, error } = await context.supabase.rpc("get_sales_backlog_report", { p_org_id: context.orgId, p_division_id: opts.divisionId ?? null })
  if (error) throw new Error(`Failed to load backlog report: ${error.message}`)
  return access.assignedOnly
    ? (data ?? []).filter((row: BacklogReportRow) => row.division_id && access.divisionIds.includes(row.division_id))
    : data ?? []
}
