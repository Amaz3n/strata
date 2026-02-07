import type { SupabaseClient } from "@supabase/supabase-js"

import type { ChangeOrder, ChangeOrderLine, ChangeOrderTotals } from "@/lib/types"
import type { ChangeOrderInput, ChangeOrderLineInput } from "@/lib/validation/change-orders"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { recordAudit } from "@/lib/services/audit"
import { attachFileWithServiceRole } from "@/lib/services/file-links"

type ChangeOrderRow = {
  id: string
  org_id: string
  project_id: string
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
    description: line.description,
    quantity: line.quantity,
    unit: line.unit ?? "unit",
    unit_cost_cents: Math.round(line.unit_cost * 100),
    allowance_cents: Math.round((line.allowance ?? 0) * 100),
    taxable: line.taxable ?? true,
  }))
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
    created_at: row.created_at,
    updated_at: row.updated_at,
    metadata: metadata ?? undefined,
    lines,
    totals,
  }
}

async function fetchChangeOrder(
  supabase: SupabaseClient,
  { id, orgId, projectId }: { id: string; orgId?: string; projectId?: string },
) {
  let query = supabase
    .from("change_orders")
    .select(
      "id, org_id, project_id, title, description, status, reason, total_cents, approved_by, approved_at, summary, days_impact, requires_signature, client_visible, metadata, created_at, updated_at",
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
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  let query = supabase
    .from("change_orders")
    .select(
      "id, org_id, project_id, title, description, status, reason, total_cents, approved_by, approved_at, summary, days_impact, requires_signature, client_visible, metadata, created_at, updated_at",
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

  return (data ?? []).map((row) => mapChangeOrderRow(row as ChangeOrderRow))
}

export async function createChangeOrder({ input, orgId }: { input: ChangeOrderInput; orgId?: string }) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

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
      lines: normalizedLines,
      totals,
      tax_rate: input.tax_rate,
      markup_percent: input.markup_percent,
      created_by: userId,
    },
  }

  const { data, error } = await supabase
    .from("change_orders")
    .insert(payload)
    .select(
      "id, org_id, project_id, title, description, status, reason, total_cents, approved_by, approved_at, summary, days_impact, requires_signature, client_visible, metadata, created_at, updated_at",
    )
    .single()

  if (error || !data) {
    throw new Error(`Failed to create change order: ${error?.message}`)
  }

  const linePayload = normalizedLines.map((line, idx) => ({
    org_id: resolvedOrgId,
    change_order_id: data.id,
    cost_code_id: line.cost_code_id ?? null,
    description: line.description,
    quantity: line.quantity,
    unit: line.unit ?? "unit",
    unit_cost_cents: line.unit_cost_cents,
    sort_order: idx,
    metadata: {
      allowance_cents: line.allowance_cents ?? 0,
      taxable: line.taxable ?? true,
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

  const existing = await fetchChangeOrder(supabase, { id: changeOrderId, orgId: resolvedOrgId })
  if (!existing) {
    throw new Error("Change order not found")
  }

  const { data, error } = await supabase
    .from("change_orders")
    .update({
      client_visible: true,
      status: existing.status === "approved" ? existing.status : "pending",
      metadata: {
        ...(existing.metadata ?? {}),
        published_by: userId,
        published_at: new Date().toISOString(),
      },
    })
    .eq("org_id", resolvedOrgId)
    .eq("id", changeOrderId)
    .select(
      "id, org_id, project_id, title, description, status, reason, total_cents, approved_by, approved_at, summary, days_impact, requires_signature, client_visible, metadata, created_at, updated_at",
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

  if (needsApprovalTransition) {
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

export async function approveChangeOrder({
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

  const nowIso = new Date().toISOString()
  const { data, error } = await supabase
    .from("change_orders")
    .update({
      status: "approved",
      approved_at: nowIso,
      approved_by: userId,
      metadata: { ...(existing.metadata ?? {}), approved_by_user: userId },
    })
    .eq("org_id", resolvedOrgId)
    .eq("id", changeOrderId)
    .select(
      "id, org_id, project_id, title, description, status, reason, total_cents, approved_by, approved_at, summary, days_impact, requires_signature, client_visible, metadata, created_at, updated_at",
    )
    .single()

  if (error || !data) {
    throw new Error(`Failed to approve change order: ${error?.message}`)
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
    .select("id, total_cents, snapshot")
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
    .select("total_cents")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .eq("status", "approved")

  if (approvedError) {
    throw new Error(`Failed to load approved change orders: ${approvedError.message}`)
  }

  const approvedTotal = (approvedOrders ?? []).reduce((sum, row: any) => sum + (row.total_cents ?? 0), 0)
  const snapshot = contract.snapshot ?? {}
  const baseTotal = snapshot.base_total_cents ?? contract.total_cents ?? 0
  const revisedTotal = baseTotal + approvedTotal

  const { error: updateContractError } = await supabase
    .from("contracts")
    .update({
      total_cents: revisedTotal,
      snapshot: {
        ...snapshot,
        base_total_cents: snapshot.base_total_cents ?? baseTotal,
        approved_change_orders_cents: approvedTotal,
        revised_total_cents: revisedTotal,
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
