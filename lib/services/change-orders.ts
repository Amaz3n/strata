import type { SupabaseClient } from "@supabase/supabase-js"

import type { ChangeOrder, ChangeOrderLine, ChangeOrderTotals } from "@/lib/types"
import type { ChangeOrderInput, ChangeOrderLineInput } from "@/lib/validation/change-orders"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { recordAudit } from "@/lib/services/audit"
import { attachFileWithServiceRole } from "@/lib/services/file-links"
import { calculateGmpDeltaCents, normalizeGmpImpact } from "@/lib/services/gmp-control"
import { requireAuthorization } from "@/lib/services/authorization"
import { getOrgSenderEmail, renderStandardEmailLayout, sendEmail } from "@/lib/services/mailer"

type ChangeOrderRow = {
  id: string
  org_id: string
  project_id: string
  co_number?: number | null
  title: string
  description?: string | null
  status: string
  reason?: string | null
  total_cents?: number | null
  approved_by?: string | null
  approved_at?: string | null
  summary?: string | null
  days_impact?: number | null
  requires_signature?: boolean | null
  client_visible?: boolean | null
  metadata?: Record<string, any> | null
  created_at?: string
  updated_at?: string
}

function normalizeLines(lines: ChangeOrderLineInput[]): ChangeOrderLine[] {
  return lines.map((line) => ({
    cost_code_id: line.cost_code_id ?? null,
    budget_line_id: line.budget_line_id ?? null,
    description: line.description,
    quantity: line.quantity,
    unit: line.unit ?? "unit",
    unit_cost_cents: Math.round(line.unit_cost * 100),
    allowance_cents: Math.round((line.allowance ?? 0) * 100),
    taxable: line.taxable ?? true,
    gmp_classification: line.gmp_classification ?? "inside_gmp",
    gmp_impact: line.gmp_impact ?? "none",
  }))
}

function calculateLineBudgetRevisionCents(line: ChangeOrderLine) {
  return Math.round((line.quantity ?? 1) * (line.unit_cost_cents ?? 0) + (line.allowance_cents ?? 0))
}

function escapeEmailHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;")
}

function calculateTotals(lines: ChangeOrderLineInput[], taxRate = 0, markupPercent = 0): ChangeOrderTotals {
  const normalized = normalizeLines(lines)

  const subtotal_cents = normalized.reduce((sum, line) => {
    const lineSubtotal = Math.round(line.quantity * line.unit_cost_cents + (line.allowance_cents ?? 0))
    return sum + lineSubtotal
  }, 0)

  const taxableBase = normalized.reduce((sum, line) => {
    const lineSubtotal = Math.round(line.quantity * line.unit_cost_cents + (line.allowance_cents ?? 0))
    return line.taxable === false ? sum : sum + lineSubtotal
  }, 0)

  const tax_cents = Math.round(taxableBase * (taxRate / 100))
  const markup_cents = Math.round(subtotal_cents * (markupPercent / 100))
  const allowance_cents = normalized.reduce((sum, line) => sum + (line.allowance_cents ?? 0), 0)

  return {
    subtotal_cents,
    tax_cents,
    markup_cents,
    allowance_cents,
    total_cents: subtotal_cents + tax_cents + markup_cents,
    tax_rate: taxRate,
    markup_percent: markupPercent,
  }
}

function buildApprovedChangeOrderFinancialMetadata(changeOrder: ChangeOrder, actorId?: string | null) {
  const lines = changeOrder.lines ?? []
  if (lines.length === 0) {
    return {
      budget_revision_cents: changeOrder.total_cents ?? 0,
      allowance_draw_cents: 0,
      inside_gmp_cents: 0,
      outside_gmp_cents: 0,
      gmp_delta_cents: 0,
      gmp_impact: "none",
      budget_distributions: [],
      billing_status: "tracking_only",
      posting_skipped_reason: "No budget-coded line items were provided.",
      posted_at: new Date().toISOString(),
      posted_by: actorId ?? null,
    }
  }

  const uncodedLines = lines.filter((line) => !line.cost_code_id && !line.budget_line_id)
  if (uncodedLines.length > 0) {
    return {
      budget_revision_cents: changeOrder.total_cents ?? lines.reduce((sum, line) => sum + calculateLineBudgetRevisionCents(line), 0),
      allowance_draw_cents: lines.reduce((sum, line) => sum + (line.allowance_cents ?? 0), 0),
      inside_gmp_cents: 0,
      outside_gmp_cents: 0,
      gmp_delta_cents: 0,
      gmp_impact: "none",
      budget_distributions: [],
      billing_status: "tracking_only",
      posting_skipped_reason: "Budget posting skipped because one or more lines are not assigned to a cost code or budget line.",
      posted_at: new Date().toISOString(),
      posted_by: actorId ?? null,
    }
  }

  const budgetDistributions = lines.map((line, index) => {
    const budgetRevisionCents = calculateLineBudgetRevisionCents(line)
    const gmpImpact = normalizeGmpImpact(line.gmp_impact)
    const gmpDeltaCents = calculateGmpDeltaCents(budgetRevisionCents, gmpImpact)
    return {
      cost_code_id: line.cost_code_id,
      budget_line_id: line.budget_line_id,
      description: line.description,
      budget_revision_cents: budgetRevisionCents,
      allowance_draw_cents: line.allowance_cents ?? 0,
      gmp_classification: line.gmp_classification ?? "inside_gmp",
      gmp_impact: gmpImpact,
      gmp_delta_cents: gmpDeltaCents,
      source_line_index: index,
    }
  })

  const budgetRevisionCents = budgetDistributions.reduce((sum, line) => sum + line.budget_revision_cents, 0)
  const allowanceDrawCents = budgetDistributions.reduce((sum, line) => sum + line.allowance_draw_cents, 0)
  const insideGmpCents = budgetDistributions
    .filter((line) => line.gmp_classification !== "outside_gmp")
    .reduce((sum, line) => sum + line.budget_revision_cents, 0)
  const outsideGmpCents = budgetDistributions
    .filter((line) => line.gmp_classification === "outside_gmp")
    .reduce((sum, line) => sum + line.budget_revision_cents, 0)
  const gmpDeltaCents = budgetDistributions.reduce((sum, line) => sum + line.gmp_delta_cents, 0)

  return {
    budget_revision_cents: budgetRevisionCents,
    allowance_draw_cents: allowanceDrawCents,
    inside_gmp_cents: insideGmpCents,
    outside_gmp_cents: outsideGmpCents,
    gmp_delta_cents: gmpDeltaCents,
    gmp_impact: gmpDeltaCents > 0 ? "increase_gmp" : gmpDeltaCents < 0 ? "decrease_gmp" : outsideGmpCents > 0 ? "outside_gmp" : "none",
    budget_distributions: budgetDistributions,
    billing_status: "ready_to_bill",
    posted_at: new Date().toISOString(),
    posted_by: actorId ?? null,
  }
}

function hasBudgetDistributions(financialImpact: ReturnType<typeof buildApprovedChangeOrderFinancialMetadata>) {
  return financialImpact.budget_distributions.length > 0
}

async function postBudgetRevisionForChangeOrder({
  supabase,
  changeOrder,
  actorId,
}: {
  supabase: SupabaseClient
  changeOrder: ChangeOrder
  actorId?: string | null
}) {
  const financialImpact = buildApprovedChangeOrderFinancialMetadata(changeOrder, actorId)
  const { data: revision, error: revisionError } = await supabase
    .from("budget_revisions")
    .upsert(
      {
        org_id: changeOrder.org_id,
        project_id: changeOrder.project_id,
        change_order_id: changeOrder.id,
        revision_type: "change_order",
        status: "posted",
        title: changeOrder.title,
        total_cents: financialImpact.budget_revision_cents,
        posted_by: actorId ?? null,
        posted_at: financialImpact.posted_at,
        metadata: {
          allowance_draw_cents: financialImpact.allowance_draw_cents,
          billing_status: financialImpact.billing_status,
          inside_gmp_cents: financialImpact.inside_gmp_cents,
          outside_gmp_cents: financialImpact.outside_gmp_cents,
          gmp_delta_cents: financialImpact.gmp_delta_cents,
          gmp_impact: financialImpact.gmp_impact,
        },
      },
      { onConflict: "org_id,change_order_id" },
    )
    .select("id")
    .single()

  if (revisionError || !revision) {
    throw new Error(`Failed to post budget revision: ${revisionError?.message}`)
  }

  const { error: deleteLinesError } = await supabase
    .from("budget_revision_lines")
    .delete()
    .eq("org_id", changeOrder.org_id)
    .eq("budget_revision_id", revision.id)

  if (deleteLinesError) {
    throw new Error(`Failed to refresh budget revision lines: ${deleteLinesError.message}`)
  }

  const lineRows = financialImpact.budget_distributions.map((line, index) => ({
    org_id: changeOrder.org_id,
    budget_revision_id: revision.id,
    cost_code_id: line.cost_code_id ?? null,
    budget_line_id: line.budget_line_id ?? null,
    description: line.description,
    amount_cents: line.budget_revision_cents,
    allowance_draw_cents: line.allowance_draw_cents,
    gmp_classification: line.gmp_classification,
    gmp_impact: line.gmp_impact,
    gmp_delta_cents: line.gmp_delta_cents,
    sort_order: index,
    metadata: {
      source_line_index: line.source_line_index,
      budget_line_id: line.budget_line_id ?? null,
      gmp_classification: line.gmp_classification,
      gmp_impact: line.gmp_impact,
      gmp_delta_cents: line.gmp_delta_cents,
    },
  }))

  if (lineRows.length > 0) {
    const { error: insertLinesError } = await supabase.from("budget_revision_lines").insert(lineRows)
    if (insertLinesError) {
      throw new Error(`Failed to post budget revision lines: ${insertLinesError.message}`)
    }
  }

  return { revisionId: revision.id, financialImpact }
}

function mapChangeOrderRow(row: ChangeOrderRow): ChangeOrder {
  const metadata = row.metadata ?? {}
  const lines = (metadata.lines as ChangeOrderLine[] | undefined) ?? []
  const totalsFromMetadata = (metadata.totals as ChangeOrderTotals | undefined) ?? undefined

  const totals: ChangeOrderTotals | undefined =
    totalsFromMetadata ??
    (row.total_cents != null
      ? {
          subtotal_cents: row.total_cents,
          tax_cents: 0,
          markup_cents: 0,
          allowance_cents: 0,
          total_cents: row.total_cents,
          tax_rate: metadata.tax_rate,
          markup_percent: metadata.markup_percent,
        }
      : undefined)

  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id,
    co_number: row.co_number ?? undefined,
    title: row.title,
    description: row.description ?? undefined,
    status: row.status,
    reason: row.reason ?? undefined,
    total_cents: row.total_cents ?? totals?.total_cents,
    approved_by: row.approved_by ?? undefined,
    approved_at: row.approved_at ?? undefined,
    summary: row.summary ?? undefined,
    days_impact: row.days_impact ?? undefined,
    client_visible: row.client_visible ?? undefined,
    requires_signature: row.requires_signature ?? undefined,
    esign_status: (metadata.esign_status as ChangeOrder["esign_status"] | undefined) ?? undefined,
    esign_document_id: (metadata.esign_document_id as string | undefined) ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
    metadata: metadata ?? undefined,
    lines,
    totals,
  }
}

export async function fetchChangeOrder(
  supabase: SupabaseClient,
  { id, orgId, projectId }: { id: string; orgId?: string; projectId?: string },
) {
  let query = supabase
    .from("change_orders")
    .select(
      "id, org_id, project_id, co_number, title, description, status, reason, total_cents, approved_by, approved_at, summary, days_impact, requires_signature, client_visible, metadata, created_at, updated_at",
    )
    .eq("id", id)

  if (orgId) {
    query = query.eq("org_id", orgId)
  }

  if (projectId) {
    query = query.eq("project_id", projectId)
  }

  const { data, error } = await query.maybeSingle()

  if (error) throw new Error(`Failed to load change order: ${error.message}`)
  return data ? mapChangeOrderRow(data as ChangeOrderRow) : null
}

export async function listChangeOrders({
  orgId,
  projectId,
}: {
  orgId?: string
  projectId?: string
} = {}): Promise<ChangeOrder[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAuthorization({
    permission: "change_order.read",
    userId,
    orgId: resolvedOrgId,
    supabase,
    logDecision: true,
    resourceType: projectId ? "project" : "org",
    resourceId: projectId ?? resolvedOrgId,
  })

  let query = supabase
    .from("change_orders")
    .select(
      "id, org_id, project_id, co_number, title, description, status, reason, total_cents, approved_by, approved_at, summary, days_impact, requires_signature, client_visible, metadata, created_at, updated_at",
    )
    .eq("org_id", resolvedOrgId)
    .order("created_at", { ascending: false })

  if (projectId) {
    query = query.eq("project_id", projectId)
  }

  const { data, error } = await query
  if (error) {
    throw new Error(`Failed to list change orders: ${error.message}`)
  }

  const rows = (data ?? []) as ChangeOrderRow[]
  const changeOrders = rows.map((row) => mapChangeOrderRow(row))
  const projectIds = Array.from(new Set(changeOrders.map((row) => row.project_id).filter(Boolean)))

  if (projectIds.length === 0) {
    return changeOrders
  }

  const { data: linkedInvoices, error: linkedInvoicesError } = await supabase
    .from("invoices")
    .select("id, invoice_number, status, metadata, created_at")
    .eq("org_id", resolvedOrgId)
    .in("project_id", projectIds)
    .not("metadata->>source_change_order_id", "is", null)
    .order("created_at", { ascending: false })

  if (linkedInvoicesError) {
    throw new Error(`Failed to load linked change order invoices: ${linkedInvoicesError.message}`)
  }

  const invoiceByChangeOrderId = new Map<string, ChangeOrder["linked_invoice"]>()
  for (const invoice of linkedInvoices ?? []) {
    const changeOrderId = invoice.metadata?.source_change_order_id
    if (typeof changeOrderId !== "string" || invoiceByChangeOrderId.has(changeOrderId)) continue
    invoiceByChangeOrderId.set(changeOrderId, {
      id: invoice.id as string,
      invoice_number: invoice.invoice_number as string | number | null,
      status: invoice.status as string | null,
    })
  }

  const { data: documents, error: documentsError } = await supabase
    .from("documents")
    .select("id, status, source_entity_id, metadata, created_at")
    .eq("org_id", resolvedOrgId)
    .eq("document_type", "change_order")
    .in("project_id", projectIds)
    .order("created_at", { ascending: false })

  if (documentsError) {
    throw new Error(`Failed to load change order signature status: ${documentsError.message}`)
  }

  const statusPriority: Record<string, number> = {
    expired: 1,
    voided: 2,
    draft: 3,
    sent: 4,
    signed: 5,
  }
  const documentByChangeOrderId = new Map<string, { id: string; status: ChangeOrder["esign_status"]; created_at?: string | null }>()

  for (const document of documents ?? []) {
    const changeOrderId = (document.source_entity_id as string | null) ?? (document.metadata?.change_order_id as string | undefined)
    if (!changeOrderId) continue

    const status = (document.status ?? "draft") as ChangeOrder["esign_status"]
    const current = documentByChangeOrderId.get(changeOrderId)
    const nextPriority = statusPriority[status ?? ""] ?? 0
    const currentPriority = statusPriority[current?.status ?? ""] ?? 0
    const isNewer =
      new Date(document.created_at ?? 0).getTime() > new Date(current?.created_at ?? 0).getTime()

    if (!current || nextPriority > currentPriority || (nextPriority === currentPriority && isNewer)) {
      documentByChangeOrderId.set(changeOrderId, {
        id: document.id as string,
        status,
        created_at: document.created_at as string | null,
      })
    }
  }

  return changeOrders.map((changeOrder) => {
    const linkedDocument = documentByChangeOrderId.get(changeOrder.id)
    return {
      ...changeOrder,
      esign_status: linkedDocument?.status ?? "not_prepared",
      esign_document_id: linkedDocument?.id ?? null,
      linked_invoice: invoiceByChangeOrderId.get(changeOrder.id) ?? null,
    }
  })
}

export async function createChangeOrder({ input, orgId }: { input: ChangeOrderInput; orgId?: string }) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAuthorization({
    permission: "change_order.write",
    userId,
    orgId: resolvedOrgId,
    projectId: input.project_id,
    supabase,
    logDecision: true,
    resourceType: "project",
    resourceId: input.project_id,
  })

  const normalizedLines = normalizeLines(input.lines)
  const totals = calculateTotals(input.lines, input.tax_rate, input.markup_percent)
  const status = input.client_visible ? "pending" : input.status ?? "draft"

  const payload = {
    org_id: resolvedOrgId,
    project_id: input.project_id,
    title: input.title,
    description: input.description ?? null,
    status,
    total_cents: totals.total_cents,
    summary: input.summary,
    days_impact: input.days_impact ?? null,
    requires_signature: input.requires_signature ?? true,
    client_visible: input.client_visible ?? false,
    metadata: {
      execution_method: "native_portal",
      worksheet_source: "arc_native",
      lines: normalizedLines,
      totals,
      tax_rate: input.tax_rate,
      markup_percent: input.markup_percent,
      intro: input.intro ?? null,
      terms: input.terms ?? null,
      display: {
        pricing: input.pricing_display ?? "itemized",
      },
      created_by: userId,
    },
  }

  const { data, error } = await supabase
    .from("change_orders")
    .insert(payload)
    .select(
      "id, org_id, project_id, co_number, title, description, status, reason, total_cents, approved_by, approved_at, summary, days_impact, requires_signature, client_visible, metadata, created_at, updated_at",
    )
    .single()

  if (error || !data) {
    throw new Error(`Failed to create change order: ${error?.message}`)
  }

  const linePayload = normalizedLines.map((line, idx) => ({
    org_id: resolvedOrgId,
    change_order_id: data.id,
    cost_code_id: line.cost_code_id ?? null,
    budget_line_id: line.budget_line_id ?? null,
    description: line.description,
    quantity: line.quantity,
    unit: line.unit ?? "unit",
    unit_cost_cents: line.unit_cost_cents,
    gmp_classification: line.gmp_classification ?? "inside_gmp",
    gmp_impact: line.gmp_impact ?? "none",
    gmp_delta_cents: calculateGmpDeltaCents(calculateLineBudgetRevisionCents(line), normalizeGmpImpact(line.gmp_impact)),
    sort_order: idx,
    metadata: {
      allowance_cents: line.allowance_cents ?? 0,
      allowance_draw_cents: line.allowance_cents ?? 0,
      budget_revision_cents: calculateLineBudgetRevisionCents(line),
      financial_impact_type: line.allowance_cents && line.allowance_cents > 0 ? "allowance_plus_budget_revision" : "budget_revision",
      taxable: line.taxable ?? true,
      gmp_classification: line.gmp_classification ?? "inside_gmp",
      gmp_impact: line.gmp_impact ?? "none",
      gmp_delta_cents: calculateGmpDeltaCents(calculateLineBudgetRevisionCents(line), normalizeGmpImpact(line.gmp_impact)),
    },
  }))

  if (linePayload.length > 0) {
    const { error: lineError } = await supabase.from("change_order_lines").insert(linePayload)
    if (lineError) {
      throw new Error(`Failed to create change order lines: ${lineError.message}`)
    }
  }

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "change_order_created",
    entityType: "change_order",
    entityId: data.id,
    payload: { title: input.title, project_id: input.project_id, total_cents: totals.total_cents },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "change_order",
    entityId: data.id,
    after: { ...payload, lines: linePayload },
  })

  return mapChangeOrderRow(data as ChangeOrderRow)
}

export async function publishChangeOrder(changeOrderId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAuthorization({
    permission: "change_order.write",
    userId,
    orgId: resolvedOrgId,
    supabase,
    logDecision: true,
    resourceType: "change_order",
    resourceId: changeOrderId,
  })

  const existing = await fetchChangeOrder(supabase, { id: changeOrderId, orgId: resolvedOrgId })
  if (!existing) {
    throw new Error("Change order not found")
  }

  const nowIso = new Date().toISOString()
  const resolvingChangeRequest =
    existing.status === "requested_changes" ||
    existing.metadata?.portal_change_request_active === true

  const { data, error } = await supabase
    .from("change_orders")
    .update({
      client_visible: true,
      status: existing.status === "approved" ? existing.status : "pending",
      metadata: {
        ...(existing.metadata ?? {}),
        published_by: userId,
        published_at: nowIso,
        portal_change_request_active: resolvingChangeRequest ? false : existing.metadata?.portal_change_request_active ?? false,
        portal_change_request_resolved_at: resolvingChangeRequest
          ? nowIso
          : existing.metadata?.portal_change_request_resolved_at ?? null,
        portal_change_request_resolved_by: resolvingChangeRequest
          ? userId
          : existing.metadata?.portal_change_request_resolved_by ?? null,
        portal_change_request_resolved_via: resolvingChangeRequest
          ? "resend_to_client"
          : existing.metadata?.portal_change_request_resolved_via ?? null,
      },
    })
    .eq("org_id", resolvedOrgId)
    .eq("id", changeOrderId)
    .select(
      "id, org_id, project_id, co_number, title, description, status, reason, total_cents, approved_by, approved_at, summary, days_impact, requires_signature, client_visible, metadata, created_at, updated_at",
    )
    .single()

  if (error || !data) {
    throw new Error(`Failed to publish change order: ${error?.message}`)
  }

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "change_order_published",
    entityType: "change_order",
    entityId: data.id,
    payload: { project_id: data.project_id, status: data.status },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "change_order",
    entityId: data.id,
    before: existing as unknown as Record<string, unknown>,
    after: data as unknown as Record<string, unknown>,
  })

  return mapChangeOrderRow(data as ChangeOrderRow)
}

export async function getChangeOrderForPortal(changeOrderId: string, orgId: string, projectId: string) {
  const supabase = createServiceSupabaseClient()
  return fetchChangeOrder(supabase, { id: changeOrderId, orgId, projectId })
}

export async function approveChangeOrderFromEnvelopeExecution(input: {
  orgId: string
  changeOrderId: string
  envelopeId?: string | null
  documentId: string
  executedFileId: string
  signerName?: string | null
  signerEmail?: string | null
  signerIp?: string | null
}) {
  const supabase = createServiceSupabaseClient()

  const existing = await fetchChangeOrder(supabase, { id: input.changeOrderId, orgId: input.orgId }).catch(() => null)
  if (!existing) throw new Error("Change order not found")

  const priorEnvelopeId = existing.metadata?.approved_envelope_id ?? null
  if (
    existing.status === "approved" &&
    existing.metadata?.approved_via_envelope &&
    priorEnvelopeId &&
    input.envelopeId &&
    priorEnvelopeId === input.envelopeId
  ) {
    return { success: true, idempotent: true }
  }

  const nowIso = new Date().toISOString()
  const financialImpact = buildApprovedChangeOrderFinancialMetadata(existing, null)
  const metadataPatch = {
    ...(existing.metadata ?? {}),
    approved_via_envelope: true,
    approved_envelope_id: input.envelopeId ?? null,
    approved_document_id: input.documentId,
    approved_executed_file_id: input.executedFileId,
    approved_signer_name: input.signerName ?? null,
    approved_signer_email: input.signerEmail ?? null,
    approved_signer_ip: input.signerIp ?? null,
    approved_at: existing.approved_at ?? nowIso,
    financial_impact: {
      ...(existing.metadata?.financial_impact ?? {}),
      ...financialImpact,
      posted_at: nowIso,
    },
  }

  const needsApprovalTransition = existing.status !== "approved"

  if (needsApprovalTransition) {
    const { error: approvalError } = await supabase.from("approvals").insert({
      org_id: existing.org_id,
      entity_type: "change_order",
      entity_id: input.changeOrderId,
      approver_id: null,
      status: "approved",
      decision_at: nowIso,
      decision_notes: "Approved via e-sign envelope execution",
      payload: {
        source: "envelope_execution",
        envelope_id: input.envelopeId ?? null,
        document_id: input.documentId,
        executed_file_id: input.executedFileId,
        signer_name: input.signerName ?? null,
        signer_email: input.signerEmail ?? null,
      },
      signature_data: null,
      signature_ip: input.signerIp ?? null,
      signed_at: nowIso,
    })

    if (approvalError) {
      throw new Error(`Failed to record envelope approval: ${approvalError.message}`)
    }
  }

  const updatePayload: Record<string, any> = {
    metadata: metadataPatch,
  }

  if (needsApprovalTransition) {
    updatePayload.status = "approved"
    updatePayload.approved_at = nowIso
    updatePayload.approved_by = null
  }

  const { error: updateError } = await supabase
    .from("change_orders")
    .update(updatePayload)
    .eq("org_id", input.orgId)
    .eq("id", input.changeOrderId)

  if (updateError) {
    throw new Error(`Failed to update change order from envelope execution: ${updateError.message}`)
  }

  await attachFileWithServiceRole({
    orgId: existing.org_id,
    fileId: input.executedFileId,
    projectId: existing.project_id,
    entityType: "change_order",
    entityId: input.changeOrderId,
    linkRole: "executed_change_order",
    createdBy: null,
  })

  if (needsApprovalTransition && hasBudgetDistributions(financialImpact)) {
    await postBudgetRevisionForChangeOrder({
      supabase,
      changeOrder: {
        ...existing,
        status: "approved",
        approved_at: existing.approved_at ?? nowIso,
        metadata: metadataPatch,
      },
      actorId: null,
    })
    await applyChangeOrderFinancialImpact({
      supabase,
      orgId: existing.org_id,
      projectId: existing.project_id,
    })
  } else if (needsApprovalTransition) {
    await applyChangeOrderFinancialImpact({
      supabase,
      orgId: existing.org_id,
      projectId: existing.project_id,
    })
  }

  await recordEvent({
    orgId: existing.org_id,
    eventType: needsApprovalTransition ? "change_order_approved" : "change_order_approval_synced",
    entityType: "change_order",
    entityId: input.changeOrderId,
    payload: {
      source: "envelope_execution",
      envelope_id: input.envelopeId ?? null,
      document_id: input.documentId,
      executed_file_id: input.executedFileId,
      signer_name: input.signerName ?? null,
      signer_email: input.signerEmail ?? null,
      transitioned: needsApprovalTransition,
    },
  })

  return { success: true, idempotent: false }
}

export async function approveChangeOrderFromPortalSignature(input: {
  orgId: string
  projectId: string
  changeOrderId: string
  portalTokenId?: string | null
  contactId?: string | null
  signerName: string
  signerEmail?: string | null
  signatureText?: string | null
  signatureImage: string
  signerIp?: string | null
}) {
  const supabase = createServiceSupabaseClient()

  const existing = await fetchChangeOrder(supabase, {
    id: input.changeOrderId,
    orgId: input.orgId,
    projectId: input.projectId,
  }).catch(() => null)
  if (!existing) throw new Error("Change order not found")

  if (existing.status === "approved" && existing.metadata?.approved_via_portal_signature) {
    return { success: true, idempotent: true }
  }

  const nowIso = new Date().toISOString()
  const financialImpact = buildApprovedChangeOrderFinancialMetadata(existing, null)
  const signatureData = {
    signer_name: input.signerName,
    signer_email: input.signerEmail ?? null,
    signature_text: input.signatureText ?? input.signerName,
    signature_image: input.signatureImage,
    signed_at: nowIso,
    signer_ip: input.signerIp ?? null,
    contact_id: input.contactId ?? null,
    portal_token_id: input.portalTokenId ?? null,
  }

  const metadataPatch = {
    ...(existing.metadata ?? {}),
    approval_method: "portal_native_signature",
    approved_via_portal_signature: true,
    approved_signer_name: input.signerName,
    approved_signer_email: input.signerEmail ?? null,
    approved_signer_ip: input.signerIp ?? null,
    approved_at: existing.approved_at ?? nowIso,
    signature_data: {
      ...((existing.metadata?.signature_data as Record<string, any> | undefined) ?? {}),
      client: signatureData,
    },
    financial_impact: {
      ...(existing.metadata?.financial_impact ?? {}),
      ...financialImpact,
      posted_at: nowIso,
    },
  }

  const needsApprovalTransition = existing.status !== "approved"

  if (needsApprovalTransition) {
    const { error: approvalError } = await supabase.from("approvals").insert({
      org_id: existing.org_id,
      entity_type: "change_order",
      entity_id: input.changeOrderId,
      approver_id: null,
      status: "approved",
      decision_at: nowIso,
      decision_notes: "Approved via client portal signature",
      payload: {
        source: "portal_native_signature",
        signer_name: input.signerName,
        signer_email: input.signerEmail ?? null,
        portal_token_id: input.portalTokenId ?? null,
        contact_id: input.contactId ?? null,
      },
      signature_data: JSON.stringify(signatureData),
      signature_ip: input.signerIp ?? null,
      signed_at: nowIso,
    })

    if (approvalError) {
      throw new Error(`Failed to record portal approval: ${approvalError.message}`)
    }
  }

  const updatePayload: Record<string, any> = {
    metadata: metadataPatch,
  }

  if (needsApprovalTransition) {
    updatePayload.status = "approved"
    updatePayload.approved_at = nowIso
    updatePayload.approved_by = null
  }

  const { error: updateError } = await supabase
    .from("change_orders")
    .update(updatePayload)
    .eq("org_id", input.orgId)
    .eq("project_id", input.projectId)
    .eq("id", input.changeOrderId)

  if (updateError) {
    throw new Error(`Failed to approve change order: ${updateError.message}`)
  }

  if (needsApprovalTransition && hasBudgetDistributions(financialImpact)) {
    await postBudgetRevisionForChangeOrder({
      supabase,
      changeOrder: {
        ...existing,
        status: "approved",
        approved_at: existing.approved_at ?? nowIso,
        metadata: metadataPatch,
      },
      actorId: null,
    })
  }

  if (needsApprovalTransition) {
    await applyChangeOrderFinancialImpact({
      supabase,
      orgId: existing.org_id,
      projectId: existing.project_id,
    })
  }

  await recordEvent({
    orgId: existing.org_id,
    eventType: "change_order_approved",
    entityType: "change_order",
    entityId: input.changeOrderId,
    payload: {
      source: "portal_native_signature",
      project_id: existing.project_id,
      signer_name: input.signerName,
      signer_email: input.signerEmail ?? null,
      transitioned: needsApprovalTransition,
    },
  })

  if (needsApprovalTransition && typeof existing.metadata?.published_by === "string") {
    try {
      const [builderResult, orgResult, projectResult] = await Promise.all([
        supabase
          .from("app_users")
          .select("email, full_name")
          .eq("id", existing.metadata.published_by)
          .maybeSingle(),
        supabase
          .from("orgs")
          .select("name, logo_url, slug")
          .eq("id", existing.org_id)
          .maybeSingle(),
        supabase
          .from("projects")
          .select("name")
          .eq("id", existing.project_id)
          .maybeSingle(),
      ])
      const builderEmail = builderResult.data?.email
      if (builderEmail) {
        const appUrl = (process.env.NEXT_PUBLIC_APP_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "")).replace(/\/$/, "")
        const total = ((existing.total_cents ?? 0) / 100).toLocaleString("en-US", {
          style: "currency",
          currency: "USD",
        })
        const html = renderStandardEmailLayout({
          title: "Change order approved",
          orgName: orgResult.data?.name ?? "Arc",
          orgLogoUrl: orgResult.data?.logo_url ?? null,
          buttonText: "Open change orders",
          buttonUrl: appUrl ? `${appUrl}/change-orders` : undefined,
          messageHtml: `
            <p style="margin: 0 0 12px 0;">${escapeEmailHtml(input.signerName)} approved and signed "${escapeEmailHtml(existing.title)}".</p>
            <table border="0" cellpadding="0" cellspacing="0" width="100%" style="border: 1px solid #e5e5e5; border-collapse: collapse; margin: 18px 0;">
              <tr>
                <td style="padding: 12px 14px; color: #666666; font-size: 12px; width: 34%;">Project</td>
                <td style="padding: 12px 14px; color: #111111; font-size: 13px;">${escapeEmailHtml(projectResult.data?.name ?? "Project")}</td>
              </tr>
              <tr>
                <td style="padding: 12px 14px; color: #666666; font-size: 12px; border-top: 1px solid #eeeeee;">Total change</td>
                <td style="padding: 12px 14px; color: #111111; font-size: 13px; font-weight: 700; border-top: 1px solid #eeeeee;">${escapeEmailHtml(total)}</td>
              </tr>
              <tr>
                <td style="padding: 12px 14px; color: #666666; font-size: 12px; border-top: 1px solid #eeeeee;">Signer</td>
                <td style="padding: 12px 14px; color: #111111; font-size: 13px; border-top: 1px solid #eeeeee;">${escapeEmailHtml(input.signerEmail ? `${input.signerName} <${input.signerEmail}>` : input.signerName)}</td>
              </tr>
            </table>
            <p style="margin: 0;">You can now prepare the client invoice from the change order.</p>
          `,
        })
        await sendEmail({
          to: [builderEmail],
          subject: `Approved: ${existing.title}`,
          html,
          from: getOrgSenderEmail(orgResult.data?.slug ?? null, orgResult.data?.name ?? null),
        })
      }
    } catch (error) {
      console.error("[change-orders] Failed to send approval notification email:", error)
    }
  }

  return { success: true, idempotent: false }
}

export async function approveChangeOrder({
  changeOrderId,
  orgId,
}: {
  changeOrderId: string
  orgId?: string
}) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAuthorization({
    permission: "change_order.approve",
    userId,
    orgId: resolvedOrgId,
    supabase,
    logDecision: true,
    resourceType: "change_order",
    resourceId: changeOrderId,
  })

  const existing = await fetchChangeOrder(supabase, { id: changeOrderId, orgId: resolvedOrgId })
  if (!existing) {
    throw new Error("Change order not found")
  }

  const nowIso = new Date().toISOString()
  const financialImpact = buildApprovedChangeOrderFinancialMetadata(existing, userId)
  const { data, error } = await supabase
    .from("change_orders")
    .update({
      status: "approved",
      approved_at: nowIso,
      approved_by: userId,
      metadata: {
        ...(existing.metadata ?? {}),
        approval_method: "manual_offline",
        approved_by_user: userId,
        financial_impact: {
          ...(existing.metadata?.financial_impact ?? {}),
          ...financialImpact,
          posted_at: nowIso,
        },
      },
    })
    .eq("org_id", resolvedOrgId)
    .eq("id", changeOrderId)
    .select(
      "id, org_id, project_id, co_number, title, description, status, reason, total_cents, approved_by, approved_at, summary, days_impact, requires_signature, client_visible, metadata, created_at, updated_at",
    )
    .single()

  if (error || !data) {
    throw new Error(`Failed to approve change order: ${error?.message}`)
  }

  if (hasBudgetDistributions(financialImpact)) {
    await postBudgetRevisionForChangeOrder({
      supabase,
      changeOrder: {
        ...mapChangeOrderRow(data as ChangeOrderRow),
        metadata: data.metadata as any,
      },
      actorId: userId,
    })
  }

  await applyChangeOrderFinancialImpact({
    supabase,
    orgId: resolvedOrgId,
    projectId: data.project_id,
  })

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "change_order_approved",
    entityType: "change_order",
    entityId: data.id,
    payload: { project_id: data.project_id },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "change_order",
    entityId: data.id,
    after: data,
  })

  return mapChangeOrderRow(data as ChangeOrderRow)
}

/**
 * Void (reverse) an approved change order. Approved change orders cannot be
 * edited or deleted — they've altered the contract value, GMP, budget, and draw
 * schedule. Voiding is the safe way to back one out: it flips the status to
 * `cancelled`, reverses every financial posting, and preserves the record + an
 * audit trail rather than destroying it.
 *
 * Reversal mechanics:
 * - Contract total / revised GMP / pending draw amounts are recomputed by
 *   `applyChangeOrderFinancialImpact`, which sums only `approved` change orders.
 *   The just-voided CO is now `cancelled`, so it drops out automatically.
 * - The posted budget revision (if any) is marked `voided`; budget and GMP
 *   consumers only count `posted` revisions, so its impact disappears.
 *
 * Guarded: if a non-void invoice is still linked, the change has been billed to
 * the client. We refuse to void until that invoice is voided or unlinked, so the
 * contract value and outstanding receivables never disagree.
 */
export async function voidChangeOrder({
  changeOrderId,
  reason,
  orgId,
}: {
  changeOrderId: string
  reason?: string | null
  orgId?: string
}) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const existing = await fetchChangeOrder(supabase, { id: changeOrderId, orgId: resolvedOrgId })
  if (!existing) {
    throw new Error("Change order not found")
  }

  await requireAuthorization({
    permission: "change_order.approve",
    userId,
    orgId: resolvedOrgId,
    projectId: existing.project_id,
    supabase,
    logDecision: true,
    resourceType: "change_order",
    resourceId: changeOrderId,
  })

  if (existing.status === "cancelled") {
    throw new Error("This change order is already voided.")
  }

  if (existing.status !== "approved") {
    throw new Error("Only approved change orders can be voided. Edit or delete unapproved change orders instead.")
  }

  const { data: linkedInvoices, error: linkedInvoicesError } = await supabase
    .from("invoices")
    .select("id, invoice_number")
    .eq("org_id", resolvedOrgId)
    .eq("metadata->>source_change_order_id", changeOrderId)
    .neq("status", "void")

  if (linkedInvoicesError) {
    throw new Error(`Failed to check linked invoices: ${linkedInvoicesError.message}`)
  }

  if (linkedInvoices && linkedInvoices.length > 0) {
    const labels = linkedInvoices.map((invoice) => `#${invoice.invoice_number}`).join(", ")
    throw new Error(
      `This change order has been billed (invoice ${labels}). Void or unlink the invoice before voiding the change order.`,
    )
  }

  const nowIso = new Date().toISOString()

  const { data, error } = await supabase
    .from("change_orders")
    .update({
      status: "cancelled",
      metadata: {
        ...(existing.metadata ?? {}),
        voided_at: nowIso,
        voided_by: userId,
        void_reason: reason ?? null,
        financial_impact: {
          ...(existing.metadata?.financial_impact ?? {}),
          reversed_at: nowIso,
        },
      },
    })
    .eq("org_id", resolvedOrgId)
    .eq("id", changeOrderId)
    .select(
      "id, org_id, project_id, co_number, title, description, status, reason, total_cents, approved_by, approved_at, summary, days_impact, requires_signature, client_visible, metadata, created_at, updated_at",
    )
    .single()

  if (error || !data) {
    throw new Error(`Failed to void change order: ${error?.message}`)
  }

  // Reverse the posted budget revision, if one was created at approval time.
  // Budget/GMP consumers only count revisions with status "posted", so flipping
  // it to "voided" removes its impact while keeping the record.
  const { data: revisions, error: revisionsError } = await supabase
    .from("budget_revisions")
    .select("id, metadata")
    .eq("org_id", resolvedOrgId)
    .eq("change_order_id", changeOrderId)
    .eq("status", "posted")

  if (revisionsError) {
    throw new Error(`Failed to load budget revision: ${revisionsError.message}`)
  }

  for (const revision of revisions ?? []) {
    const { error: voidRevisionError } = await supabase
      .from("budget_revisions")
      .update({
        status: "voided",
        metadata: {
          ...((revision.metadata as Record<string, any> | null) ?? {}),
          voided_at: nowIso,
          voided_by: userId,
        },
      })
      .eq("id", revision.id)
      .eq("org_id", resolvedOrgId)

    if (voidRevisionError) {
      throw new Error(`Failed to reverse budget revision: ${voidRevisionError.message}`)
    }
  }

  // Recompute contract total, revised GMP, and pending draw amounts from the
  // change orders that remain approved (the voided one no longer qualifies).
  await applyChangeOrderFinancialImpact({
    supabase,
    orgId: resolvedOrgId,
    projectId: data.project_id,
  })

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "change_order_voided",
    entityType: "change_order",
    entityId: data.id,
    payload: { project_id: data.project_id, reason: reason ?? null },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "change_order",
    entityId: data.id,
    before: existing as any,
    after: data,
    source: "change_order.void",
  })

  return mapChangeOrderRow(data as ChangeOrderRow)
}

async function applyChangeOrderFinancialImpact({
  supabase,
  orgId,
  projectId,
}: {
  supabase: SupabaseClient
  orgId: string
  projectId: string
}) {
  const { data: contract, error: contractError } = await supabase
    .from("contracts")
    .select("id, total_cents, gmp_cents, snapshot")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (contractError) {
    throw new Error(`Failed to load contract: ${contractError.message}`)
  }
  if (!contract) return

  const { data: approvedOrders, error: approvedError } = await supabase
    .from("change_orders")
    .select("total_cents, metadata")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .eq("status", "approved")

  if (approvedError) {
    throw new Error(`Failed to load approved change orders: ${approvedError.message}`)
  }

  const approvedTotal = (approvedOrders ?? []).reduce((sum, row: any) => sum + (row.total_cents ?? 0), 0)
  const approvedGmpDelta = (approvedOrders ?? []).reduce(
    (sum, row: any) => sum + (row.metadata?.financial_impact?.gmp_delta_cents ?? 0),
    0,
  )
  const snapshot = contract.snapshot ?? {}
  const baseTotal = snapshot.base_total_cents ?? contract.total_cents ?? 0
  const revisedTotal = baseTotal + approvedTotal
  const baseGmp = snapshot.base_gmp_cents ?? contract.gmp_cents ?? 0
  const revisedGmp = Math.max(0, baseGmp + approvedGmpDelta)

  const { error: updateContractError } = await supabase
    .from("contracts")
    .update({
      total_cents: revisedTotal,
      snapshot: {
        ...snapshot,
        base_total_cents: snapshot.base_total_cents ?? baseTotal,
        approved_change_orders_cents: approvedTotal,
        revised_total_cents: revisedTotal,
        base_gmp_cents: snapshot.base_gmp_cents ?? baseGmp,
        approved_gmp_change_orders_cents: approvedGmpDelta,
        revised_gmp_cents: revisedGmp,
      },
    })
    .eq("id", contract.id)
    .eq("org_id", orgId)

  if (updateContractError) {
    throw new Error(`Failed to update contract totals: ${updateContractError.message}`)
  }

  const { data: draws, error: drawsError } = await supabase
    .from("draw_schedules")
    .select("id, percent_of_contract, status")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .eq("status", "pending")

  if (drawsError) {
    throw new Error(`Failed to load draw schedules: ${drawsError.message}`)
  }

  const updates = (draws ?? [])
    .filter((draw: any) => draw.percent_of_contract != null)
    .map((draw: any) => ({
      id: draw.id,
      amount_cents: Math.round(revisedTotal * Number(draw.percent_of_contract) / 100),
    }))

  for (const update of updates) {
    const { error: drawUpdateError } = await supabase
      .from("draw_schedules")
      .update({ amount_cents: update.amount_cents })
      .eq("id", update.id)
      .eq("org_id", orgId)

    if (drawUpdateError) {
      throw new Error(`Failed to update draw schedule amounts: ${drawUpdateError.message}`)
    }
  }
}

/**
 * Link an already-existing invoice to a change order. Used when an invoice was
 * created (or imported from QBO) before the change order, and the builder wants
 * the two tied together — e.g. backfilling a project that started pre-Arc. This
 * is the reverse of billing a change order from the invoice composer, which
 * derives a fresh invoice from the CO.
 *
 * Unlike draws, change_orders has no invoice_id column: the link lives entirely
 * in the invoice's metadata (source_change_order_id). Linking here stamps that
 * metadata, which is also what the composer reads to hide already-billed COs.
 * Any CO status (including draft) may be linked.
 */
export async function linkInvoiceToChangeOrder({
  changeOrderId,
  invoiceId,
  orgId,
}: {
  changeOrderId: string
  invoiceId: string
  orgId?: string
}) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const changeOrder = await fetchChangeOrder(supabase, { id: changeOrderId, orgId: resolvedOrgId })
  if (!changeOrder) {
    throw new Error("Change order not found")
  }

  if (changeOrder.status !== "approved") {
    throw new Error("Approve this change order before linking an invoice.")
  }

  await requireAuthorization({
    permission: "change_order.write",
    userId,
    orgId: resolvedOrgId,
    projectId: changeOrder.project_id,
    supabase,
    logDecision: true,
    resourceType: "change_order",
    resourceId: changeOrderId,
  })

  const { data: invoice, error: invoiceError } = await supabase
    .from("invoices")
    .select("id, project_id, status, total_cents, invoice_number, metadata")
    .eq("id", invoiceId)
    .eq("org_id", resolvedOrgId)
    .maybeSingle()

  if (invoiceError) {
    throw new Error(`Failed to load invoice: ${invoiceError.message}`)
  }

  if (!invoice) {
    throw new Error("Invoice not found")
  }

  if (invoice.project_id !== changeOrder.project_id) {
    throw new Error("That invoice belongs to a different project.")
  }

  if (String(invoice.status).toLowerCase() === "void") {
    throw new Error("Voided invoices cannot be linked to a change order.")
  }

  const metadata = (invoice.metadata ?? {}) as Record<string, any>
  const existingSourceType = typeof metadata.source_type === "string" ? metadata.source_type : null
  const existingSourceChangeOrderId =
    typeof metadata.source_change_order_id === "string" ? metadata.source_change_order_id : null
  const existingSourceDrawId = typeof metadata.source_draw_id === "string" ? metadata.source_draw_id : null

  if (existingSourceChangeOrderId && existingSourceChangeOrderId !== changeOrderId) {
    throw new Error("This invoice is already linked to another change order.")
  }

  if (existingSourceDrawId) {
    throw new Error("This invoice is already linked to a draw. Unlink it first.")
  }

  if (
    existingSourceType &&
    existingSourceType !== "manual" &&
    existingSourceType !== "qbo" &&
    existingSourceType !== "change_order"
  ) {
    throw new Error(
      `This invoice was generated from a ${existingSourceType.replace(/_/g, " ")} and can't be linked to a change order.`,
    )
  }

  const nowIso = new Date().toISOString()
  const nextMetadata = {
    ...metadata,
    source_type: "change_order",
    source_change_order_id: changeOrder.id,
    change_order_id: changeOrder.id,
    change_order_title: changeOrder.title,
    change_order_total_cents: changeOrder.total_cents ?? null,
    change_order_status: changeOrder.status,
    change_order_approved_at: changeOrder.approved_at ?? null,
    change_order_linked_at: nowIso,
    change_order_linked_manually: true,
  }

  const { error: invoiceUpdateError } = await supabase
    .from("invoices")
    .update({ metadata: nextMetadata })
    .eq("id", invoice.id)
    .eq("org_id", resolvedOrgId)

  if (invoiceUpdateError) {
    throw new Error(`Failed to link invoice to change order: ${invoiceUpdateError.message}`)
  }

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "change_order_invoice_linked",
    entityType: "change_order",
    entityId: changeOrder.id,
    payload: { invoice_id: invoice.id, invoice_number: invoice.invoice_number },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "change_order",
    entityId: changeOrder.id,
    before: { invoice_id: null },
    after: { invoice_id: invoice.id },
    source: "change_order.link_invoice",
  })

  return { changeOrderId: changeOrder.id, invoice_id: invoice.id }
}

/**
 * Reverse a manual change order↔invoice link, stripping the change order source
 * metadata from the invoice. The invoice itself is preserved.
 */
export async function unlinkInvoiceFromChangeOrder({
  changeOrderId,
  invoiceId,
  orgId,
}: {
  changeOrderId: string
  invoiceId: string
  orgId?: string
}) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const changeOrder = await fetchChangeOrder(supabase, { id: changeOrderId, orgId: resolvedOrgId })
  if (!changeOrder) {
    throw new Error("Change order not found")
  }

  await requireAuthorization({
    permission: "change_order.write",
    userId,
    orgId: resolvedOrgId,
    projectId: changeOrder.project_id,
    supabase,
    logDecision: true,
    resourceType: "change_order",
    resourceId: changeOrderId,
  })

  const { data: invoice, error: invoiceError } = await supabase
    .from("invoices")
    .select("id, metadata")
    .eq("org_id", resolvedOrgId)
    .eq("id", invoiceId)
    .eq("project_id", changeOrder.project_id)
    .eq("metadata->>source_change_order_id", changeOrderId)
    .neq("status", "void")
    .maybeSingle()

  if (invoiceError) {
    throw new Error(`Failed to load linked invoice: ${invoiceError.message}`)
  }

  if (!invoice) {
    throw new Error("This change order has no linked invoice.")
  }

  const metadata = (invoice.metadata ?? {}) as Record<string, any>
  const {
    source_change_order_id: _sourceChangeOrderId,
    change_order_id: _changeOrderId,
    change_order_title: _changeOrderTitle,
    change_order_total_cents: _changeOrderTotalCents,
    change_order_status: _changeOrderStatus,
    change_order_approved_at: _changeOrderApprovedAt,
    change_order_linked_at: _changeOrderLinkedAt,
    change_order_linked_manually: _changeOrderLinkedManually,
    ...rest
  } = metadata
  const nextMetadata = {
    ...rest,
    source_type: metadata.source_type === "change_order" ? "manual" : metadata.source_type,
  }

  const { error: invoiceUpdateError } = await supabase
    .from("invoices")
    .update({ metadata: nextMetadata })
    .eq("id", invoice.id)
    .eq("org_id", resolvedOrgId)

  if (invoiceUpdateError) {
    throw new Error(`Failed to unlink invoice: ${invoiceUpdateError.message}`)
  }

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "change_order_invoice_unlinked",
    entityType: "change_order",
    entityId: changeOrder.id,
    payload: { invoice_id: invoice.id },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "change_order",
    entityId: changeOrder.id,
    before: { invoice_id: invoice.id },
    after: { invoice_id: null },
    source: "change_order.unlink_invoice",
  })

  return { changeOrderId: changeOrder.id, invoice_id: invoice.id }
}

/**
 * The invoices currently linked to a change order (via metadata), if any.
 * Returns the invoice id + a few display fields for the detail sheet.
 */
export async function getChangeOrderLinkedInvoices({
  changeOrderId,
  orgId,
}: {
  changeOrderId: string
  orgId?: string
}) {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data: invoices, error } = await supabase
    .from("invoices")
    .select("id, invoice_number, title, status, total_cents, balance_due_cents, issue_date")
    .eq("org_id", resolvedOrgId)
    .eq("metadata->>source_change_order_id", changeOrderId)
    .neq("status", "void")

  if (error) {
    throw new Error(`Failed to load linked invoices: ${error.message}`)
  }

  return invoices ?? []
}

export async function updateChangeOrder({
  changeOrderId,
  input,
  orgId,
}: {
  changeOrderId: string
  input: ChangeOrderInput
  orgId?: string
}) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const existing = await fetchChangeOrder(supabase, { id: changeOrderId, orgId: resolvedOrgId })
  if (!existing) {
    throw new Error("Change order not found")
  }

  await requireAuthorization({
    permission: "change_order.write",
    userId,
    orgId: resolvedOrgId,
    projectId: existing.project_id,
    supabase,
    logDecision: true,
    resourceType: "change_order",
    resourceId: changeOrderId,
  })

  if (existing.status === "approved") {
    throw new Error("Approved change orders cannot be edited.")
  }

  const normalizedLines = normalizeLines(input.lines)
  const totals = calculateTotals(input.lines, input.tax_rate, input.markup_percent)
  const nowIso = new Date().toISOString()
  const activeChangeRequest =
    existing.status === "requested_changes" ||
    existing.metadata?.portal_change_request_active === true
  const status = activeChangeRequest ? "requested_changes" : input.client_visible ? "pending" : input.status ?? "draft"

  const payload = {
    title: input.title,
    description: input.description ?? null,
    status,
    total_cents: totals.total_cents,
    summary: input.summary,
    days_impact: input.days_impact ?? null,
    requires_signature: input.requires_signature ?? true,
    client_visible: input.client_visible ?? false,
    metadata: {
      ...(existing.metadata ?? {}),
      lines: normalizedLines,
      totals,
      tax_rate: input.tax_rate,
      markup_percent: input.markup_percent,
      intro: input.intro ?? null,
      terms: input.terms ?? null,
      display: {
        ...((existing.metadata?.display as Record<string, any> | undefined) ?? {}),
        pricing: input.pricing_display ?? "itemized",
      },
      updated_by: userId,
      portal_change_request_addressed_at: activeChangeRequest ? nowIso : existing.metadata?.portal_change_request_addressed_at ?? null,
      portal_change_request_addressed_by: activeChangeRequest ? userId : existing.metadata?.portal_change_request_addressed_by ?? null,
    },
  }

  const { data, error } = await supabase
    .from("change_orders")
    .update(payload)
    .eq("org_id", resolvedOrgId)
    .eq("id", changeOrderId)
    .select(
      "id, org_id, project_id, co_number, title, description, status, reason, total_cents, approved_by, approved_at, summary, days_impact, requires_signature, client_visible, metadata, created_at, updated_at",
    )
    .single()

  if (error || !data) {
    throw new Error(`Failed to update change order: ${error?.message}`)
  }

  // delete old lines and insert new ones
  const { error: deleteError } = await supabase
    .from("change_order_lines")
    .delete()
    .eq("org_id", resolvedOrgId)
    .eq("change_order_id", changeOrderId)

  if (deleteError) {
    throw new Error(`Failed to delete change order lines: ${deleteError.message}`)
  }

  const linePayload = normalizedLines.map((line, idx) => ({
    org_id: resolvedOrgId,
    change_order_id: data.id,
    cost_code_id: line.cost_code_id ?? null,
    description: line.description,
    quantity: line.quantity,
    unit: line.unit ?? "unit",
    unit_cost_cents: line.unit_cost_cents,
    gmp_classification: line.gmp_classification ?? "inside_gmp",
    gmp_impact: line.gmp_impact ?? "none",
    gmp_delta_cents: calculateGmpDeltaCents(calculateLineBudgetRevisionCents(line), normalizeGmpImpact(line.gmp_impact)),
    sort_order: idx,
    metadata: {
      allowance_cents: line.allowance_cents ?? 0,
      allowance_draw_cents: line.allowance_cents ?? 0,
      budget_revision_cents: calculateLineBudgetRevisionCents(line),
      financial_impact_type: line.allowance_cents && line.allowance_cents > 0 ? "allowance_plus_budget_revision" : "budget_revision",
      taxable: line.taxable ?? true,
      gmp_classification: line.gmp_classification ?? "inside_gmp",
      gmp_impact: line.gmp_impact ?? "none",
      gmp_delta_cents: calculateGmpDeltaCents(calculateLineBudgetRevisionCents(line), normalizeGmpImpact(line.gmp_impact)),
    },
  }))

  if (linePayload.length > 0) {
    const { error: lineError } = await supabase.from("change_order_lines").insert(linePayload)
    if (lineError) {
      throw new Error(`Failed to update change order lines: ${lineError.message}`)
    }
  }

  // Update linked invoice details if any exists, keeping sync
  const { data: invoices, error: invoicesError } = await supabase
    .from("invoices")
    .select("id, metadata")
    .eq("org_id", resolvedOrgId)
    .eq("project_id", data.project_id)
    .eq("metadata->>source_change_order_id", changeOrderId)
    .neq("status", "void")

  if (!invoicesError && invoices && invoices.length > 0) {
    for (const invoice of invoices) {
      const metadata = (invoice.metadata ?? {}) as Record<string, any>
      const nextMetadata = {
        ...metadata,
        change_order_title: data.title,
        change_order_total_cents: data.total_cents,
        change_order_status: data.status,
      }
      await supabase
        .from("invoices")
        .update({ metadata: nextMetadata })
        .eq("org_id", resolvedOrgId)
        .eq("id", invoice.id)
    }
  }

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "change_order_updated",
    entityType: "change_order",
    entityId: data.id,
    payload: { title: input.title, project_id: data.project_id, total_cents: totals.total_cents },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "change_order",
    entityId: data.id,
    before: existing as any,
    after: { ...data, lines: linePayload } as any,
  })

  return mapChangeOrderRow(data as ChangeOrderRow)
}

export async function deleteChangeOrder({
  changeOrderId,
  orgId,
}: {
  changeOrderId: string
  orgId?: string
}) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const existing = await fetchChangeOrder(supabase, { id: changeOrderId, orgId: resolvedOrgId })
  if (!existing) {
    throw new Error("Change order not found")
  }

  await requireAuthorization({
    permission: "change_order.write",
    userId,
    orgId: resolvedOrgId,
    projectId: existing.project_id,
    supabase,
    logDecision: true,
    resourceType: "change_order",
    resourceId: changeOrderId,
  })

  if (existing.status === "approved") {
    throw new Error("Approved change orders cannot be deleted.")
  }

  if (existing.esign_status === "sent" || existing.esign_status === "signed") {
    throw new Error("Change orders with active or executed e-signatures cannot be deleted.")
  }

  // Unlink invoices if any
  const { data: invoices, error: invoicesError } = await supabase
    .from("invoices")
    .select("id, metadata")
    .eq("org_id", resolvedOrgId)
    .eq("project_id", existing.project_id)
    .eq("metadata->>source_change_order_id", changeOrderId)
    .neq("status", "void")

  if (!invoicesError && invoices && invoices.length > 0) {
    for (const invoice of invoices) {
      const metadata = (invoice.metadata ?? {}) as Record<string, any>
      const {
        source_change_order_id: _sourceChangeOrderId,
        change_order_id: _changeOrderId,
        change_order_title: _changeOrderTitle,
        change_order_total_cents: _changeOrderTotalCents,
        change_order_status: _changeOrderStatus,
        change_order_approved_at: _changeOrderApprovedAt,
        change_order_linked_at: _changeOrderLinkedAt,
        change_order_linked_manually: _changeOrderLinkedManually,
        ...rest
      } = metadata
      const nextMetadata = {
        ...rest,
        source_type: metadata.source_type === "change_order" ? "manual" : metadata.source_type,
      }
      await supabase
        .from("invoices")
        .update({ metadata: nextMetadata })
        .eq("org_id", resolvedOrgId)
        .eq("id", invoice.id)
    }
  }

  // Clean up change_order_lines
  const { error: lineError } = await supabase
    .from("change_order_lines")
    .delete()
    .eq("org_id", resolvedOrgId)
    .eq("change_order_id", changeOrderId)

  if (lineError) {
    throw new Error(`Failed to delete change order lines: ${lineError.message}`)
  }

  // Delete change order
  const { error: deleteError } = await supabase
    .from("change_orders")
    .delete()
    .eq("org_id", resolvedOrgId)
    .eq("id", changeOrderId)

  if (deleteError) {
    throw new Error(`Failed to delete change order: ${deleteError.message}`)
  }

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "change_order_deleted",
    entityType: "change_order",
    entityId: changeOrderId,
    payload: { title: existing.title, project_id: existing.project_id },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "delete",
    entityType: "change_order",
    entityId: changeOrderId,
    before: existing as any,
  })

  return existing
}
