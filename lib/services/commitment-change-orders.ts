import type { SupabaseClient } from "@supabase/supabase-js"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireOrgContext } from "@/lib/services/context"
import { requireAuthorization } from "@/lib/services/authorization"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { createPrimeCoFromCommitmentCos, fetchChangeOrder, recomputeChangeOrderCost } from "@/lib/services/change-orders"
import {
  commitmentChangeOrderFromClientChangeOrderSchema,
  commitmentChangeOrderInputSchema,
  commitmentChangeOrderLinkSchema,
  commitmentChangeOrderUpdateSchema,
  type CommitmentChangeOrderFromClientChangeOrderInput,
  type CommitmentChangeOrderInput,
  type CommitmentChangeOrderLineInput,
  type CommitmentChangeOrderLinkInput,
  type CommitmentChangeOrderUpdateInput,
} from "@/lib/validation/commitment-change-orders"

export type CommitmentChangeOrderStatus = "draft" | "sent" | "approved" | "rejected" | "voided"

export interface CommitmentChangeOrderLine {
  id: string
  org_id: string
  commitment_change_order_id: string
  commitment_line_id?: string | null
  cost_code_id?: string | null
  budget_line_id?: string | null
  cost_code_code?: string
  cost_code_name?: string
  description: string
  quantity: number
  unit?: string | null
  unit_cost_cents: number
  amount_cents: number
  sort_order: number
  metadata?: Record<string, any>
}

export interface CommitmentChangeOrderSummary {
  id: string
  org_id: string
  project_id: string
  commitment_id: string
  commitment_title?: string
  company_id?: string | null
  company_name?: string
  title: string
  description?: string | null
  status: CommitmentChangeOrderStatus
  total_cents: number
  currency: string
  approved_at?: string | null
  approved_by?: string | null
  source_document_id?: string | null
  executed_file_id?: string | null
  signature_envelope_id?: string | null
  prime_change_order_id?: string | null
  metadata?: Record<string, any>
  created_at: string
  updated_at?: string | null
  lines: CommitmentChangeOrderLine[]
  source_change_order_id?: string | null
  source_change_order_title?: string | null
}

export interface ChangeOrderSubCostSignal {
  change_order_id: string
  has_linked_commitment_change_orders: boolean
  matching_commitments: Array<{
    id: string
    title: string
    company_id?: string | null
    company_name?: string | null
  }>
}

type ParentCommitmentRow = {
  id: string
  org_id: string
  project_id: string
  company_id?: string | null
  title: string
  status?: string | null
  company?: { id: string; name: string } | null
}

function calculateLineAmount(line: Pick<CommitmentChangeOrderLineInput, "quantity" | "unit_cost_cents">) {
  return Math.round((line.quantity ?? 1) * (line.unit_cost_cents ?? 0))
}

function mapLine(row: any): CommitmentChangeOrderLine {
  return {
    id: row.id,
    org_id: row.org_id,
    commitment_change_order_id: row.commitment_change_order_id,
    commitment_line_id: row.commitment_line_id ?? null,
    cost_code_id: row.cost_code_id ?? null,
    budget_line_id: row.budget_line_id ?? null,
    cost_code_code: row.cost_code?.code ?? undefined,
    cost_code_name: row.cost_code?.name ?? undefined,
    description: row.description,
    quantity: Number(row.quantity ?? 1),
    unit: row.unit ?? null,
    unit_cost_cents: row.unit_cost_cents ?? 0,
    amount_cents: row.amount_cents ?? Math.round(Number(row.quantity ?? 1) * (row.unit_cost_cents ?? 0)),
    sort_order: row.sort_order ?? 0,
    metadata: (row.metadata ?? {}) as Record<string, any>,
  }
}

function mapSummary(row: any, lines: CommitmentChangeOrderLine[] = []): CommitmentChangeOrderSummary {
  const metadata = (row.metadata ?? {}) as Record<string, any>
  const commitment = Array.isArray(row.commitment) ? row.commitment[0] : row.commitment
  const company = Array.isArray(row.company) ? row.company[0] : row.company
  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id,
    commitment_id: row.commitment_id,
    commitment_title: commitment?.title ?? row.commitment_title ?? undefined,
    company_id: row.company_id ?? null,
    company_name: company?.name ?? row.company_name ?? undefined,
    title: row.title,
    description: row.description ?? null,
    status: (row.status ?? "draft") as CommitmentChangeOrderStatus,
    total_cents: row.total_cents ?? 0,
    currency: row.currency ?? "usd",
    approved_at: row.approved_at ?? null,
    approved_by: row.approved_by ?? null,
    source_document_id: row.source_document_id ?? null,
    executed_file_id: row.executed_file_id ?? null,
    signature_envelope_id: row.signature_envelope_id ?? null,
    metadata,
    created_at: row.created_at,
    updated_at: row.updated_at ?? null,
    lines,
    prime_change_order_id: row.prime_change_order_id ?? null,
    source_change_order_id: row.prime_change_order_id ?? null,
  }
}

async function loadParentCommitment(
  supabase: SupabaseClient,
  orgId: string,
  commitmentId: string,
): Promise<ParentCommitmentRow> {
  const { data, error } = await supabase
    .from("commitments")
    .select("id, org_id, project_id, company_id, title, status, company:companies(id, name)")
    .eq("org_id", orgId)
    .eq("id", commitmentId)
    .maybeSingle()

  if (error || !data) {
    throw new Error(`Commitment not found: ${error?.message ?? "not found"}`)
  }

  return data as unknown as ParentCommitmentRow
}

async function loadRowsByIds(
  supabase: SupabaseClient,
  orgId: string,
  ids: string[],
): Promise<any[]> {
  const uniqueIds = Array.from(new Set(ids.filter(Boolean)))
  if (uniqueIds.length === 0) return []

  const { data, error } = await supabase
    .from("commitment_change_orders")
    .select(
      `
      id, org_id, project_id, commitment_id, company_id, title, description, status, total_cents, currency,
      approved_at, approved_by, source_document_id, executed_file_id, signature_envelope_id, prime_change_order_id, metadata, created_at, updated_at,
      commitment:commitments(id, title),
      company:companies(id, name)
    `,
    )
    .eq("org_id", orgId)
    .in("id", uniqueIds)

  if (error) {
    throw new Error(`Failed to load commitment change orders: ${error.message}`)
  }

  return data ?? []
}

async function loadLinesByChangeOrderId(
  supabase: SupabaseClient,
  orgId: string,
  ids: string[],
) {
  const uniqueIds = Array.from(new Set(ids.filter(Boolean)))
  const linesById = new Map<string, CommitmentChangeOrderLine[]>()
  if (uniqueIds.length === 0) return linesById

  const { data, error } = await supabase
    .from("commitment_change_order_lines")
    .select(
      `
      id, org_id, commitment_change_order_id, commitment_line_id, cost_code_id, budget_line_id,
      description, quantity, unit, unit_cost_cents, amount_cents, sort_order, metadata,
      cost_code:cost_codes(code, name)
    `,
    )
    .eq("org_id", orgId)
    .in("commitment_change_order_id", uniqueIds)
    .order("sort_order", { ascending: true })

  if (error) {
    throw new Error(`Failed to load commitment change order lines: ${error.message}`)
  }

  for (const row of data ?? []) {
    const changeOrderId = row.commitment_change_order_id as string
    const existing = linesById.get(changeOrderId) ?? []
    existing.push(mapLine(row))
    linesById.set(changeOrderId, existing)
  }

  return linesById
}

async function hydrate(rows: any[], supabase: SupabaseClient, orgId: string) {
  const linesById = await loadLinesByChangeOrderId(
    supabase,
    orgId,
    rows.map((row) => row.id),
  )
  const summaries = rows.map((row) => mapSummary(row, linesById.get(row.id) ?? []))

  const sourceIds = Array.from(
    new Set(summaries.map((summary) => summary.source_change_order_id).filter((id): id is string => Boolean(id))),
  )
  if (sourceIds.length === 0) return summaries

  const { data: sourceRows } = await supabase
    .from("change_orders")
    .select("id, title")
    .eq("org_id", orgId)
    .in("id", sourceIds)

  const sourceById = new Map((sourceRows ?? []).map((row) => [row.id as string, row.title as string]))
  return summaries.map((summary) => ({
    ...summary,
    source_change_order_title: summary.source_change_order_id
      ? sourceById.get(summary.source_change_order_id) ?? null
      : null,
  }))
}

async function loadSingle(
  supabase: SupabaseClient,
  orgId: string,
  id: string,
): Promise<CommitmentChangeOrderSummary | null> {
  const rows = await loadRowsByIds(supabase, orgId, [id])
  const summaries = await hydrate(rows, supabase, orgId)
  return summaries[0] ?? null
}

function linePayload(line: CommitmentChangeOrderLineInput, index: number, orgId: string, changeOrderId: string) {
  const quantity = line.quantity ?? 1
  const unitCostCents = line.unit_cost_cents ?? 0
  return {
    org_id: orgId,
    commitment_change_order_id: changeOrderId,
    commitment_line_id: line.commitment_line_id ?? null,
    cost_code_id: line.cost_code_id ?? null,
    budget_line_id: line.budget_line_id ?? null,
    description: line.description,
    quantity,
    unit: line.unit ?? "unit",
    unit_cost_cents: unitCostCents,
    amount_cents: calculateLineAmount({ quantity, unit_cost_cents: unitCostCents }),
    sort_order: line.sort_order ?? index,
    metadata: line.metadata ?? {},
  }
}

async function replaceLines({
  supabase,
  orgId,
  changeOrderId,
  lines,
}: {
  supabase: SupabaseClient
  orgId: string
  changeOrderId: string
  lines: CommitmentChangeOrderLineInput[]
}) {
  const { error: deleteError } = await supabase
    .from("commitment_change_order_lines")
    .delete()
    .eq("org_id", orgId)
    .eq("commitment_change_order_id", changeOrderId)

  if (deleteError) {
    throw new Error(`Failed to replace commitment change order lines: ${deleteError.message}`)
  }

  const payload = lines.map((line, index) => linePayload(line, index, orgId, changeOrderId))
  if (payload.length === 0) return 0

  const { error: insertError } = await supabase.from("commitment_change_order_lines").insert(payload)
  if (insertError) {
    throw new Error(`Failed to create commitment change order lines: ${insertError.message}`)
  }

  return payload.reduce((sum, line) => sum + line.amount_cents, 0)
}

export async function listCommitmentChangeOrders({
  commitmentId,
  projectId,
  orgId,
}: {
  commitmentId?: string
  projectId?: string
  orgId?: string
} = {}): Promise<CommitmentChangeOrderSummary[]> {
  if (!commitmentId && !projectId) return []

  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  if (commitmentId) {
    const commitment = await loadParentCommitment(supabase, resolvedOrgId, commitmentId)
    await requireAuthorization({
      permission: "commitment.read",
      userId,
      orgId: resolvedOrgId,
      projectId: commitment.project_id,
      supabase,
      logDecision: true,
      resourceType: "commitment",
      resourceId: commitmentId,
    })
  } else if (projectId) {
    await requireAuthorization({
      permission: "commitment.read",
      userId,
      orgId: resolvedOrgId,
      projectId,
      supabase,
      logDecision: true,
      resourceType: "project",
      resourceId: projectId,
    })
  }

  let query = supabase
    .from("commitment_change_orders")
    .select(
      `
      id, org_id, project_id, commitment_id, company_id, title, description, status, total_cents, currency,
      approved_at, approved_by, source_document_id, executed_file_id, signature_envelope_id, prime_change_order_id, metadata, created_at, updated_at,
      commitment:commitments(id, title),
      company:companies(id, name)
    `,
    )
    .eq("org_id", resolvedOrgId)
    .order("created_at", { ascending: false })

  if (commitmentId) query = query.eq("commitment_id", commitmentId)
  if (projectId) query = query.eq("project_id", projectId)

  const { data, error } = await query
  if (error) {
    throw new Error(`Failed to list commitment change orders: ${error.message}`)
  }

  return hydrate(data ?? [], supabase, resolvedOrgId)
}

export async function createCommitmentChangeOrder({
  input,
  orgId,
}: {
  input: CommitmentChangeOrderInput
  orgId?: string
}): Promise<CommitmentChangeOrderSummary> {
  const parsed = commitmentChangeOrderInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const commitment = await loadParentCommitment(supabase, resolvedOrgId, parsed.commitment_id)

  await requireAuthorization({
    permission: "commitment.write",
    userId,
    orgId: resolvedOrgId,
    projectId: commitment.project_id,
    supabase,
    logDecision: true,
    resourceType: "commitment",
    resourceId: parsed.commitment_id,
  })

  const totalCents = parsed.lines.reduce((sum, line) => sum + calculateLineAmount(line), 0)
  const { data, error } = await supabase
    .from("commitment_change_orders")
    .insert({
      org_id: resolvedOrgId,
      project_id: commitment.project_id,
      commitment_id: commitment.id,
      company_id: commitment.company_id ?? null,
      title: parsed.title,
      description: parsed.description ?? null,
      total_cents: totalCents,
      currency: "usd",
      metadata: parsed.metadata ?? {},
    })
    .select("id")
    .single()

  if (error || !data) {
    throw new Error(`Failed to create commitment change order: ${error?.message}`)
  }

  await replaceLines({
    supabase,
    orgId: resolvedOrgId,
    changeOrderId: data.id as string,
    lines: parsed.lines,
  })

  const created = await loadSingle(supabase, resolvedOrgId, data.id as string)
  if (!created) throw new Error("Failed to reload commitment change order")

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "commitment_change_order",
    entityId: created.id,
    after: created as any,
  })

  await recordEvent({
    orgId: resolvedOrgId,
    actorId: userId,
    eventType: "commitment_change_order_created",
    entityType: "commitment_change_order",
    entityId: created.id,
    payload: {
      project_id: created.project_id,
      commitment_id: created.commitment_id,
      total_cents: created.total_cents,
    },
  })

  return created
}

export async function updateCommitmentChangeOrder({
  commitmentChangeOrderId,
  input,
  orgId,
}: {
  commitmentChangeOrderId: string
  input: CommitmentChangeOrderUpdateInput
  orgId?: string
}): Promise<CommitmentChangeOrderSummary> {
  const parsed = commitmentChangeOrderUpdateSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const existing = await loadSingle(supabase, resolvedOrgId, commitmentChangeOrderId)
  if (!existing) throw new Error("Commitment change order not found")

  await requireAuthorization({
    permission: "commitment.write",
    userId,
    orgId: resolvedOrgId,
    projectId: existing.project_id,
    supabase,
    logDecision: true,
    resourceType: "commitment_change_order",
    resourceId: commitmentChangeOrderId,
  })

  if (existing.status !== "draft" && existing.status !== "sent") {
    throw new Error("Only draft or sent commitment change orders can be edited.")
  }

  const totalCents = parsed.lines
    ? await replaceLines({
        supabase,
        orgId: resolvedOrgId,
        changeOrderId: commitmentChangeOrderId,
        lines: parsed.lines,
      })
    : existing.total_cents

  const { error } = await supabase
    .from("commitment_change_orders")
    .update({
      title: parsed.title ?? existing.title,
      description: parsed.description ?? existing.description ?? null,
      total_cents: totalCents,
      metadata: parsed.metadata ? { ...(existing.metadata ?? {}), ...parsed.metadata } : existing.metadata ?? {},
      updated_at: new Date().toISOString(),
    })
    .eq("org_id", resolvedOrgId)
    .eq("id", commitmentChangeOrderId)

  if (error) {
    throw new Error(`Failed to update commitment change order: ${error.message}`)
  }

  const updated = await loadSingle(supabase, resolvedOrgId, commitmentChangeOrderId)
  if (!updated) throw new Error("Failed to reload commitment change order")

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "commitment_change_order",
    entityId: commitmentChangeOrderId,
    before: existing as any,
    after: updated as any,
  })

  return updated
}

export async function approveCommitmentChangeOrder({
  commitmentChangeOrderId,
  note,
  orgId,
}: {
  commitmentChangeOrderId: string
  note?: string | null
  orgId?: string
}): Promise<CommitmentChangeOrderSummary> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const existing = await loadSingle(supabase, resolvedOrgId, commitmentChangeOrderId)
  if (!existing) throw new Error("Commitment change order not found")

  await requireAuthorization({
    permission: "commitment.write",
    userId,
    orgId: resolvedOrgId,
    projectId: existing.project_id,
    supabase,
    logDecision: true,
    resourceType: "commitment_change_order",
    resourceId: commitmentChangeOrderId,
  })

  if (existing.status === "voided") {
    throw new Error("Voided commitment change orders cannot be approved.")
  }

  const nowIso = new Date().toISOString()
  const metadata = {
    ...(existing.metadata ?? {}),
    approved_note: note ?? (existing.metadata ?? {}).approved_note ?? null,
  }

  const { error } = await supabase
    .from("commitment_change_orders")
    .update({
      status: "approved",
      approved_at: existing.approved_at ?? nowIso,
      approved_by: existing.approved_by ?? userId,
      metadata,
      updated_at: nowIso,
    })
    .eq("org_id", resolvedOrgId)
    .eq("id", commitmentChangeOrderId)

  if (error) {
    throw new Error(`Failed to approve commitment change order: ${error.message}`)
  }

  const approved = await loadSingle(supabase, resolvedOrgId, commitmentChangeOrderId)
  if (!approved) throw new Error("Failed to reload commitment change order")

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "commitment_change_order",
    entityId: commitmentChangeOrderId,
    before: existing as any,
    after: approved as any,
  })

  await recordEvent({
    orgId: resolvedOrgId,
    actorId: userId,
    eventType: "commitment_change_order_approved",
    entityType: "commitment_change_order",
    entityId: commitmentChangeOrderId,
    payload: {
      project_id: approved.project_id,
      commitment_id: approved.commitment_id,
      total_cents: approved.total_cents,
    },
  })

  return approved
}

export async function voidCommitmentChangeOrder({
  commitmentChangeOrderId,
  reason,
  orgId,
}: {
  commitmentChangeOrderId: string
  reason?: string | null
  orgId?: string
}): Promise<CommitmentChangeOrderSummary> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const existing = await loadSingle(supabase, resolvedOrgId, commitmentChangeOrderId)
  if (!existing) throw new Error("Commitment change order not found")

  await requireAuthorization({
    permission: "commitment.write",
    userId,
    orgId: resolvedOrgId,
    projectId: existing.project_id,
    supabase,
    logDecision: true,
    resourceType: "commitment_change_order",
    resourceId: commitmentChangeOrderId,
  })

  if (existing.status === "voided") return existing

  const nowIso = new Date().toISOString()
  const { error } = await supabase
    .from("commitment_change_orders")
    .update({
      status: "voided",
      metadata: {
        ...(existing.metadata ?? {}),
        voided_at: nowIso,
        voided_by: userId,
        void_reason: reason ?? null,
      },
      updated_at: nowIso,
    })
    .eq("org_id", resolvedOrgId)
    .eq("id", commitmentChangeOrderId)

  if (error) {
    throw new Error(`Failed to void commitment change order: ${error.message}`)
  }

  const voided = await loadSingle(supabase, resolvedOrgId, commitmentChangeOrderId)
  if (!voided) throw new Error("Failed to reload commitment change order")

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "commitment_change_order",
    entityId: commitmentChangeOrderId,
    before: existing as any,
    after: voided as any,
  })

  return voided
}

export async function deleteCommitmentChangeOrder({
  commitmentChangeOrderId,
  orgId,
}: {
  commitmentChangeOrderId: string
  orgId?: string
}) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const existing = await loadSingle(supabase, resolvedOrgId, commitmentChangeOrderId)
  if (!existing) throw new Error("Commitment change order not found")

  await requireAuthorization({
    permission: "commitment.write",
    userId,
    orgId: resolvedOrgId,
    projectId: existing.project_id,
    supabase,
    logDecision: true,
    resourceType: "commitment_change_order",
    resourceId: commitmentChangeOrderId,
  })

  if (existing.status !== "draft" && existing.status !== "sent") {
    throw new Error("Only draft or sent commitment change orders can be deleted.")
  }

  const { error } = await supabase
    .from("commitment_change_orders")
    .delete()
    .eq("org_id", resolvedOrgId)
    .eq("id", commitmentChangeOrderId)

  if (error) {
    throw new Error(`Failed to delete commitment change order: ${error.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "delete",
    entityType: "commitment_change_order",
    entityId: commitmentChangeOrderId,
    before: existing as any,
  })
}

export async function markCommitmentChangeOrderExecutedFromEnvelope(input: {
  orgId: string
  commitmentChangeOrderId: string
  envelopeId: string
  documentId: string
  executedFileId: string
  signerName?: string | null
  signerEmail?: string | null
  signerIp?: string | null
}): Promise<CommitmentChangeOrderSummary> {
  const supabase = createServiceSupabaseClient()
  const existing = await loadSingle(supabase, input.orgId, input.commitmentChangeOrderId)
  if (!existing) {
    throw new Error("Commitment change order not found for executed e-signature")
  }

  const nowIso = new Date().toISOString()
  const metadata = {
    ...(existing.metadata ?? {}),
    executed_signature: {
      signer_name: input.signerName ?? null,
      signer_email: input.signerEmail ?? null,
      signer_ip: input.signerIp ?? null,
      executed_at: nowIso,
      envelope_id: input.envelopeId,
      document_id: input.documentId,
      executed_file_id: input.executedFileId,
    },
  }

  const { error } = await supabase
    .from("commitment_change_orders")
    .update({
      status: "approved",
      approved_at: existing.approved_at ?? nowIso,
      source_document_id: input.documentId,
      executed_file_id: input.executedFileId,
      signature_envelope_id: input.envelopeId,
      metadata,
      updated_at: nowIso,
    })
    .eq("org_id", input.orgId)
    .eq("id", input.commitmentChangeOrderId)

  if (error) {
    throw new Error(`Failed to mark commitment change order executed: ${error.message}`)
  }

  const updated = await loadSingle(supabase, input.orgId, input.commitmentChangeOrderId)
  if (!updated) throw new Error("Failed to reload executed commitment change order")

  await recordAudit({
    orgId: input.orgId,
    actorId: undefined,
    action: "update",
    entityType: "commitment_change_order",
    entityId: input.commitmentChangeOrderId,
    before: existing as any,
    after: updated as any,
  })

  await recordEvent({
    orgId: input.orgId,
    eventType: "commitment_change_order_executed",
    entityType: "commitment_change_order",
    entityId: input.commitmentChangeOrderId,
    payload: {
      project_id: existing.project_id,
      commitment_id: existing.commitment_id,
      envelope_id: input.envelopeId,
      document_id: input.documentId,
      executed_file_id: input.executedFileId,
      signer_email: input.signerEmail ?? null,
    },
  })

  return updated
}

export async function listCommitmentChangeOrdersForClientChangeOrder({
  changeOrderId,
  orgId,
}: {
  changeOrderId: string
  orgId?: string
}) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const changeOrder = await fetchChangeOrder(supabase, { id: changeOrderId, orgId: resolvedOrgId })
  if (!changeOrder) throw new Error("Change order not found")

  await requireAuthorization({
    permission: "change_order.read",
    userId,
    orgId: resolvedOrgId,
    projectId: changeOrder.project_id,
    supabase,
    logDecision: true,
    resourceType: "change_order",
    resourceId: changeOrderId,
  })

  const { data, error } = await supabase
    .from("commitment_change_orders")
    .select(
      `
      id, org_id, project_id, commitment_id, company_id, title, description, status, total_cents, currency,
      approved_at, approved_by, source_document_id, executed_file_id, signature_envelope_id, prime_change_order_id, metadata, created_at, updated_at,
      commitment:commitments(id, title),
      company:companies(id, name)
    `,
    )
    .eq("org_id", resolvedOrgId)
    .eq("project_id", changeOrder.project_id)
    .eq("prime_change_order_id", changeOrderId)
    .order("created_at", { ascending: false })

  if (error) {
    throw new Error(`Failed to load linked commitment change orders: ${error.message}`)
  }

  return hydrate(data ?? [], supabase, resolvedOrgId)
}

export const listCommitmentCosForPrimeCo = listCommitmentChangeOrdersForClientChangeOrder

export async function createCommitmentChangeOrderFromClientChangeOrder({
  input,
  orgId,
}: {
  input: CommitmentChangeOrderFromClientChangeOrderInput
  orgId?: string
}) {
  const parsed = commitmentChangeOrderFromClientChangeOrderSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const changeOrder = await fetchChangeOrder(supabase, { id: parsed.change_order_id, orgId: resolvedOrgId })
  if (!changeOrder) throw new Error("Change order not found")

  const commitment = await loadParentCommitment(supabase, resolvedOrgId, parsed.commitment_id)
  if (commitment.project_id !== changeOrder.project_id) {
    throw new Error("Commitment must belong to the same project as the change order.")
  }

  await requireAuthorization({
    permission: "change_order.read",
    userId,
    orgId: resolvedOrgId,
    projectId: changeOrder.project_id,
    supabase,
    logDecision: true,
    resourceType: "change_order",
    resourceId: parsed.change_order_id,
  })

  const title =
    parsed.title ??
    `Sub CO for ${changeOrder.co_number ? `CO #${changeOrder.co_number}` : changeOrder.title}`
  const lines =
    changeOrder.lines && changeOrder.lines.length > 0
      ? changeOrder.lines.map((line, index) => ({
          cost_code_id: line.cost_code_id ?? null,
          budget_line_id: line.budget_line_id ?? null,
          description: line.description,
          quantity: Number(line.quantity ?? 1),
          unit: line.unit ?? "unit",
          unit_cost_cents: line.unit_cost_cents ?? 0,
          sort_order: index,
          metadata: {
            source_change_order_line_id: line.id ?? null,
            source_allowance_cents: line.allowance_cents ?? 0,
            source_markup_stripped: true,
          },
        }))
      : [
          {
            description: changeOrder.title,
            quantity: 1,
            unit: "ls",
            unit_cost_cents: changeOrder.total_cents ?? 0,
            sort_order: 0,
            metadata: { source_markup_stripped: true },
          },
        ]

  const created = await createCommitmentChangeOrder({
    orgId: resolvedOrgId,
    input: {
      commitment_id: parsed.commitment_id,
      title,
      description: parsed.description ?? changeOrder.summary ?? changeOrder.description ?? null,
      metadata: {
        source_change_order_title: changeOrder.title,
        bridge_direction: "client_to_commitment",
      },
      lines,
    },
  })
  const { error: linkError } = await supabase
    .from("commitment_change_orders")
    .update({ prime_change_order_id: changeOrder.id })
    .eq("org_id", resolvedOrgId)
    .eq("id", created.id)
  if (linkError) throw new Error(`Failed to link commitment change order: ${linkError.message}`)
  return { ...created, prime_change_order_id: changeOrder.id, source_change_order_id: changeOrder.id }
}

export async function linkCommitmentChangeOrderToClientChangeOrder({
  input,
  orgId,
}: {
  input: CommitmentChangeOrderLinkInput
  orgId?: string
}) {
  const parsed = commitmentChangeOrderLinkSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const changeOrder = await fetchChangeOrder(supabase, { id: parsed.change_order_id, orgId: resolvedOrgId })
  const commitmentChangeOrder = await loadSingle(
    supabase,
    resolvedOrgId,
    parsed.commitment_change_order_id,
  )
  if (!changeOrder || !commitmentChangeOrder) {
    throw new Error("Change order or commitment change order not found")
  }
  if (changeOrder.project_id !== commitmentChangeOrder.project_id) {
    throw new Error("Both change orders must belong to the same project.")
  }

  await requireAuthorization({
    permission: "commitment.write",
    userId,
    orgId: resolvedOrgId,
    projectId: commitmentChangeOrder.project_id,
    supabase,
    logDecision: true,
    resourceType: "commitment_change_order",
    resourceId: parsed.commitment_change_order_id,
  })
  await requireAuthorization({
    permission: "change_order.write",
    userId,
    orgId: resolvedOrgId,
    projectId: changeOrder.project_id,
    supabase,
    logDecision: true,
    resourceType: "change_order",
    resourceId: parsed.change_order_id,
  })

  const metadata = {
    ...(commitmentChangeOrder.metadata ?? {}),
    source_change_order_title: changeOrder.title,
    linked_to_client_change_order_at: new Date().toISOString(),
    linked_to_client_change_order_by: userId,
  }

  const { error } = await supabase
    .from("commitment_change_orders")
    .update({ prime_change_order_id: changeOrder.id, metadata, updated_at: new Date().toISOString() })
    .eq("org_id", resolvedOrgId)
    .eq("id", parsed.commitment_change_order_id)

  if (error) {
    throw new Error(`Failed to link commitment change order: ${error.message}`)
  }

  const { data: existingLine, error: existingLineError } = await supabase
    .from("change_order_lines")
    .select("id")
    .eq("org_id", resolvedOrgId)
    .eq("change_order_id", changeOrder.id)
    .eq("commitment_change_order_id", commitmentChangeOrder.id)
    .maybeSingle()
  if (existingLineError) throw new Error(`Failed to check linked cost line: ${existingLineError.message}`)
  if (!existingLine) {
    const { error: lineError } = await supabase.from("change_order_lines").insert({
      org_id: resolvedOrgId,
      change_order_id: changeOrder.id,
      description: commitmentChangeOrder.title,
      quantity: 1,
      unit: "ls",
      unit_cost_cents: 0,
      internal_cost_cents: commitmentChangeOrder.total_cents,
      commitment_change_order_id: commitmentChangeOrder.id,
      sort_order: (changeOrder.lines?.length ?? 0),
      metadata: { taxable: true, linked_from_commitment_change_order: true },
    })
    if (lineError) throw new Error(`Failed to add commitment cost line: ${lineError.message}`)
  }
  await recomputeChangeOrderCost(changeOrder.id, resolvedOrgId)

  await recordEvent({
    orgId: resolvedOrgId,
    actorId: userId,
    eventType: "change_order_cost_linked",
    entityType: "change_order",
    entityId: changeOrder.id,
    payload: { project_id: changeOrder.project_id, commitment_change_order_id: commitmentChangeOrder.id },
  })

  const updated = await loadSingle(supabase, resolvedOrgId, parsed.commitment_change_order_id)
  if (!updated) throw new Error("Failed to reload linked commitment change order")
  return updated
}

export async function createClientChangeOrderFromCommitmentChangeOrder({
  commitmentChangeOrderId,
  orgId,
}: {
  commitmentChangeOrderId: string
  orgId?: string
}) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const commitmentChangeOrder = await loadSingle(supabase, resolvedOrgId, commitmentChangeOrderId)
  if (!commitmentChangeOrder) throw new Error("Commitment change order not found")

  await requireAuthorization({
    permission: "commitment.read",
    userId,
    orgId: resolvedOrgId,
    projectId: commitmentChangeOrder.project_id,
    supabase,
    logDecision: true,
    resourceType: "commitment_change_order",
    resourceId: commitmentChangeOrderId,
  })

  return createPrimeCoFromCommitmentCos({
    projectId: commitmentChangeOrder.project_id,
    commitmentChangeOrderIds: [commitmentChangeOrder.id],
    title: `Client CO for ${commitmentChangeOrder.title}`,
    description: commitmentChangeOrder.description,
    orgId: resolvedOrgId,
  })
}

export async function getChangeOrderSubCostSignal({
  changeOrderId,
  orgId,
}: {
  changeOrderId: string
  orgId?: string
}): Promise<ChangeOrderSubCostSignal> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const changeOrder = await fetchChangeOrder(supabase, { id: changeOrderId, orgId: resolvedOrgId })
  if (!changeOrder) throw new Error("Change order not found")

  await requireAuthorization({
    permission: "change_order.read",
    userId,
    orgId: resolvedOrgId,
    projectId: changeOrder.project_id,
    supabase,
    logDecision: true,
    resourceType: "change_order",
    resourceId: changeOrderId,
  })

  const linked = await listCommitmentChangeOrdersForClientChangeOrder({
    changeOrderId,
    orgId: resolvedOrgId,
  })

  const budgetLineIds = new Set(
    (changeOrder.lines ?? []).map((line) => line.budget_line_id).filter((id): id is string => Boolean(id)),
  )
  const costCodeIds = new Set(
    (changeOrder.lines ?? []).map((line) => line.cost_code_id).filter((id): id is string => Boolean(id)),
  )

  if (budgetLineIds.size === 0 && costCodeIds.size === 0) {
    return {
      change_order_id: changeOrderId,
      has_linked_commitment_change_orders: linked.length > 0,
      matching_commitments: [],
    }
  }

  const { data: commitments, error: commitmentsError } = await supabase
    .from("commitments")
    .select("id, title, company_id, company:companies(id, name)")
    .eq("org_id", resolvedOrgId)
    .eq("project_id", changeOrder.project_id)
    .neq("status", "canceled")

  if (commitmentsError) {
    throw new Error(`Failed to load commitments: ${commitmentsError.message}`)
  }

  const commitmentIds = (commitments ?? []).map((commitment) => commitment.id as string)
  if (commitmentIds.length === 0) {
    return {
      change_order_id: changeOrderId,
      has_linked_commitment_change_orders: linked.length > 0,
      matching_commitments: [],
    }
  }

  const { data: lines, error: linesError } = await supabase
    .from("commitment_lines")
    .select("commitment_id, cost_code_id, budget_line_id")
    .eq("org_id", resolvedOrgId)
    .in("commitment_id", commitmentIds)

  if (linesError) {
    throw new Error(`Failed to load commitment lines: ${linesError.message}`)
  }

  const matchingIds = new Set<string>()
  for (const line of lines ?? []) {
    if (
      (line.budget_line_id && budgetLineIds.has(line.budget_line_id as string)) ||
      (line.cost_code_id && costCodeIds.has(line.cost_code_id as string))
    ) {
      matchingIds.add(line.commitment_id as string)
    }
  }

  const matchingCommitments = (commitments ?? [])
    .filter((commitment) => matchingIds.has(commitment.id as string))
    .map((commitment) => {
      const company = Array.isArray(commitment.company) ? commitment.company[0] : commitment.company
      return {
        id: commitment.id as string,
        title: commitment.title as string,
        company_id: (commitment.company_id as string | null) ?? null,
        company_name: (company?.name as string | undefined) ?? null,
      }
    })

  return {
    change_order_id: changeOrderId,
    has_linked_commitment_change_orders: linked.length > 0,
    matching_commitments: matchingCommitments,
  }
}
