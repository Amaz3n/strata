import { z } from "zod"
import type { SupabaseClient } from "@supabase/supabase-js"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireOrgContext } from "@/lib/services/context"
import { purchasingQueueFiltersSchema, purchasingQueueProjectSelect, resolvePurchasingQueueReadScope, type PurchasingQueueFilters } from "@/lib/services/purchasing-queue-scope"
import { authorize, requireAuthorization } from "@/lib/services/authorization"
import { recordAudit } from "@/lib/services/audit"
import { refuseSeparationOfDuties } from "@/lib/services/separation-of-duties"
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
import { parseVpoApprovalBands, requiredVpoApprovalPermission, vpoApprovalBlockReason, vpoEvidenceBlockReason } from "@/lib/financials/vpo-approval-thresholds"
import { DEFAULT_VPO_EVIDENCE_REQUIRED_OVER_CENTS } from "@/lib/services/purchasing-settings"

export type CommitmentChangeOrderStatus = "draft" | "sent" | "approved" | "rejected" | "voided"

/** A change order still awaiting a decision: editable, approvable, rejectable. */
const PENDING_STATUSES: readonly CommitmentChangeOrderStatus[] = ["draft", "sent"]

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
  reason_code_id?: string | null
  reason_code?: string | null
  reason_label?: string | null
  origin?: "field_mobile" | "office" | "design_studio_co" | "trade_portal" | null
  requested_by?: string | null
  photo_file_ids: string[]
  /** Cost evidence (quote, invoice, receipt); required to approve a large order or any back-charge. */
  evidence_file_ids: string[]
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
  updated_at: string
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
  commitment_type?: "subcontract" | "purchase_order" | string | null
  company?: { id: string; name: string } | null
}

function calculateLineAmount(line: Pick<CommitmentChangeOrderLineInput, "quantity" | "unit_cost_cents">) {
  return Math.round((line.quantity ?? 1) * (line.unit_cost_cents ?? 0))
}

/**
 * Files named on a variance order (field photos, cost evidence) must be live
 * files of this org and this home. Without the check an id from another org
 * would ride along on the order and be dereferenced by whatever renders it.
 */
export async function assertProjectFiles(client: SupabaseClient, orgId: string, projectId: string, fileIds: readonly string[], label: string) {
  const ids = [...new Set(fileIds)]
  if (ids.length === 0) return
  const { data, error } = await client.from("files").select("id").eq("org_id", orgId).eq("project_id", projectId).is("archived_at", null).in("id", ids).limit(ids.length + 1)
  if (error) throw new Error(`Unable to verify ${label}: ${error.message}`)
  if (!data || ids.some((id) => !data.some((row) => row.id === id))) throw new Error(`${label[0].toUpperCase()}${label.slice(1)} must be available and belong to this home.`)
}

/**
 * The cost code, budget line and commitment line a change order line names must be this organization's, the
 * order's home's and the order's commitment's. The database refuses the same, so a bad reference never
 * becomes a bill line and a cost posting on someone else's budget; this says which one is wrong.
 */
async function assertLineReferences(
  client: SupabaseClient,
  orgId: string,
  target: { projectId: string; commitmentId: string },
  lines: readonly CommitmentChangeOrderLineInput[],
) {
  const idsOf = (pick: (line: CommitmentChangeOrderLineInput) => string | null | undefined) =>
    [...new Set(lines.map(pick).filter((id): id is string => Boolean(id)))]
  const costCodeIds = idsOf((line) => line.cost_code_id)
  const budgetLineIds = idsOf((line) => line.budget_line_id)
  const commitmentLineIds = idsOf((line) => line.commitment_line_id)
  const [costCodes, budgetLines, commitmentLines] = await Promise.all([
    costCodeIds.length === 0 ? null : client.from("cost_codes").select("id").eq("org_id", orgId).in("id", costCodeIds),
    budgetLineIds.length === 0 ? null : client.from("budget_lines").select("id, budget:budgets!inner(project_id)").eq("org_id", orgId).in("id", budgetLineIds),
    commitmentLineIds.length === 0 ? null : client.from("commitment_lines").select("id").eq("org_id", orgId).eq("commitment_id", target.commitmentId).in("id", commitmentLineIds),
  ])
  for (const result of [costCodes, budgetLines, commitmentLines]) {
    if (result?.error) throw new Error(`Unable to verify the change order lines: ${result.error.message}`)
  }
  if (costCodeIds.some((id) => !costCodes?.data?.some((row) => row.id === id))) throw new Error("A line's cost code was not found in this organization.")
  const budgetOf = (row: { budget: unknown }) => (Array.isArray(row.budget) ? row.budget[0] : row.budget)
  const homeBudgetLineIds = new Set(
    (budgetLines?.data ?? []).filter((row) => (budgetOf(row) as { project_id?: string } | null | undefined)?.project_id === target.projectId).map((row) => row.id as string),
  )
  if (budgetLineIds.some((id) => !homeBudgetLineIds.has(id))) throw new Error("A line's budget line does not belong to this home.")
  if (commitmentLineIds.some((id) => !commitmentLines?.data?.some((row) => row.id === id))) throw new Error("A line's purchase order line does not belong to this order.")
}

/** A variance order is raised and approved on an issued purchase order, never a draft, a canceled or a finished one. */
function assertIssuedPurchaseOrder(commitment: Pick<ParentCommitmentRow, "commitment_type" | "status">) {
  if (commitment.commitment_type === "purchase_order" && commitment.status !== "approved") {
    throw new Error(`Variance orders are raised on issued purchase orders; this one is ${commitment.status ?? "not issued"}.`)
  }
}

/**
 * The permission a decision on this order needs: its band, or `vpo.approve_large`
 * for a back-charge. Rejecting asks the same question as approving, so a
 * small-band approver cannot kill an order they could not approve.
 */
async function decisionPermission(client: SupabaseClient, orgId: string, order: CommitmentChangeOrderSummary) {
  if (!order.reason_code_id) return { permission: "commitment.write", isBackcharge: false, evidenceOverCents: null as number | null }
  const [{ data: settings }, { data: reason }] = await Promise.all([
    client.from("purchasing_settings").select("vpo_approval_thresholds,vpo_evidence_required_over_cents").eq("org_id", orgId).maybeSingle(),
    client.from("variance_reason_codes").select("is_backcharge").eq("org_id", orgId).eq("id", order.reason_code_id).maybeSingle(),
  ])
  const isBackcharge = reason?.is_backcharge === true
  return {
    permission: requiredVpoApprovalPermission({
      totalCents: order.total_cents,
      isBackcharge,
      bands: parseVpoApprovalBands(settings?.vpo_approval_thresholds),
    }),
    isBackcharge,
    evidenceOverCents: settings && "vpo_evidence_required_over_cents" in settings
      ? numberOrNull(settings.vpo_evidence_required_over_cents)
      : DEFAULT_VPO_EVIDENCE_REQUIRED_OVER_CENTS,
  }
}

function numberOrNull(value: unknown) {
  return typeof value === "number" ? value : null
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
    reason_code_id: row.reason_code_id ?? null,
    reason_code: row.reason?.code ?? null,
    reason_label: row.reason?.label ?? null,
    origin: row.origin ?? null,
    requested_by: row.requested_by ?? null,
    photo_file_ids: Array.isArray(row.photo_file_ids) ? row.photo_file_ids : [],
    evidence_file_ids: Array.isArray(row.evidence_file_ids) ? row.evidence_file_ids : [],
    total_cents: row.total_cents ?? 0,
    currency: row.currency ?? "usd",
    approved_at: row.approved_at ?? null,
    approved_by: row.approved_by ?? null,
    source_document_id: row.source_document_id ?? null,
    executed_file_id: row.executed_file_id ?? null,
    signature_envelope_id: row.signature_envelope_id ?? null,
    metadata,
    created_at: row.created_at,
    updated_at: row.updated_at,
    lines,
    prime_change_order_id: row.prime_change_order_id ?? null,
    source_change_order_id: row.prime_change_order_id ?? null,
  }
}

/**
 * Purchasing works houses it is not a team member of, so RLS on commitments hides
 * them from the caller. This read only feeds the authorization check that follows
 * at every call site; it is scoped by org_id.
 */
async function loadParentCommitment(
  orgId: string,
  commitmentId: string,
): Promise<ParentCommitmentRow> {
  const { data, error } = await createServiceSupabaseClient()
    .from("commitments")
    .select("id, org_id, project_id, company_id, commitment_type, title, status, company:companies(id, name)")
    .eq("org_id", orgId)
    .eq("id", commitmentId)
    .maybeSingle()

  if (error || !data) {
    throw new Error(`Commitment not found: ${error?.message ?? "not found"}`)
  }

  const company = Array.isArray(data.company) ? data.company[0] : data.company
  return { ...data, company: company ?? null }
}

/**
 * The purchase order or subcontract an order sits on, with the home it is raised against checked: an order
 * is authorized against its own project, so one that names a project other than its commitment's is refused
 * before anything is written on its behalf.
 */
async function loadOrderCommitment(orgId: string, order: Pick<CommitmentChangeOrderSummary, "commitment_id" | "project_id">) {
  const commitment = await loadParentCommitment(orgId, order.commitment_id)
  if (commitment.project_id !== order.project_id) throw new Error("This change order is not on its commitment's home.")
  return commitment
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
      approved_at, approved_by, source_document_id, executed_file_id, signature_envelope_id, prime_change_order_id, reason_code_id, origin, requested_by, photo_file_ids, evidence_file_ids, metadata, created_at, updated_at,
      commitment:commitments(id, title),
      company:companies(id, name), reason:variance_reason_codes(code, label)
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

function linePayload(line: CommitmentChangeOrderLineInput, index: number, orgId: string, changeOrderId: string | null) {
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
    const commitment = await loadParentCommitment(resolvedOrgId, commitmentId)
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
      approved_at, approved_by, source_document_id, executed_file_id, signature_envelope_id, prime_change_order_id, reason_code_id, origin, requested_by, photo_file_ids, evidence_file_ids, metadata, created_at, updated_at,
      commitment:commitments(id, title),
      company:companies(id, name), reason:variance_reason_codes(code, label)
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

export async function listVarianceOrders(filters: PurchasingQueueFilters & {
  status?: CommitmentChangeOrderStatus | "pending"
  reasonCodeId?: string
  origin?: CommitmentChangeOrderSummary["origin"]
  orgId?: string
} = {}) {
  const parsed = purchasingQueueFiltersSchema.extend({
    status: z.enum(["draft", "sent", "approved", "rejected", "voided", "pending"]).optional(),
    reasonCodeId: z.string().uuid().optional(),
    origin: z.enum(["field_mobile", "office", "design_studio_co", "trade_portal"]).nullish(),
  }).parse(filters)
  const context = await requireOrgContext(filters.orgId)
  const { supabase, orgId: resolvedOrgId, userId } = context
  await requireAuthorization({ permission: "price_book.read", userId, orgId: resolvedOrgId, supabase, logDecision: true })
  const scope = await resolvePurchasingQueueReadScope(context, parsed.divisionId)
  if (scope.divisionIds?.length === 0) return { items: [], count: 0, page: parsed.page, pageSize: parsed.pageSize }
  // Authorized and scoped above, and every scope below is an explicit predicate. The member client's
  // division backstop would hide a home whose project has no division even when its lot is in the lens.
  const reader = createServiceSupabaseClient()
  const from = (parsed.page - 1) * parsed.pageSize
  const columns: string = `
    id, org_id, project_id, commitment_id, company_id, title, description, status, total_cents, currency,
    approved_at, approved_by, source_document_id, executed_file_id, signature_envelope_id,
    prime_change_order_id, reason_code_id, origin, requested_by, photo_file_ids, evidence_file_ids, metadata, created_at, updated_at,
    commitment:commitments!inner(id, title), company:companies(id, name), reason:variance_reason_codes(code, label)
  `
  const select: string = `${columns}, ${purchasingQueueProjectSelect("", scope, parsed.communityId)}`
  const orders = (count: boolean) => {
    let query = reader.from("commitment_change_orders").select(select, count ? { count: "exact" } : undefined).eq("org_id", resolvedOrgId).eq("project.org_id", resolvedOrgId).eq("commitment.commitment_type", "purchase_order")
    if (parsed.status === "pending") query = query.in("status", ["draft", "sent"])
    else if (parsed.status) query = query.eq("status", parsed.status)
    if (parsed.reasonCodeId) query = query.eq("reason_code_id", parsed.reasonCodeId)
    if (parsed.origin) query = query.eq("origin", parsed.origin)
    if (parsed.projectId) query = query.eq("project_id", parsed.projectId)
    if (parsed.communityId) query = query.eq("project.lot.community_id", parsed.communityId).eq("project.lot.org_id", resolvedOrgId).eq("project.lot.community.org_id", resolvedOrgId)
    if (scope.projectMembershipRequired) query = query.eq("project.access.org_id", resolvedOrgId).eq("project.access.user_id", userId).eq("project.access.status", "active")
    return query
  }

  if (scope.divisionIds) {
    // The division lens (a home's division is its lot's, falling back to the project's) resolves in SQL, so a
    // division of any size pages the same way: the function returns this page's ids and the lens's exact count.
    const { data: page, error: pageError } = await reader.rpc("list_variance_order_page", {
      p_org_id: resolvedOrgId,
      p_division_ids: scope.divisionIds,
      p_statuses: parsed.status === "pending" ? ["draft", "sent"] : parsed.status ? [parsed.status] : null,
      p_reason_code_id: parsed.reasonCodeId ?? null,
      p_origin: parsed.origin ?? null,
      p_project_id: parsed.projectId ?? null,
      p_community_id: parsed.communityId ?? null,
      p_member_user_id: scope.projectMembershipRequired ? userId : null,
      p_limit: parsed.pageSize,
      p_offset: from,
    })
    const rows = z.array(z.object({ id: z.string().uuid(), total_count: z.coerce.number() })).safeParse(page)
    if (pageError || !rows.success) throw new Error(`Failed to list variance orders: ${pageError?.message ?? "unexpected response"}`)
    const ids = rows.data.map((row) => row.id)
    if (ids.length === 0) return { items: [], count: 0, page: parsed.page, pageSize: parsed.pageSize }
    const { data, error } = await orders(false).in("id", ids).returns<{ id: string }[]>()
    if (error) throw new Error(`Failed to list variance orders: ${error.message}`)
    const byId = new Map((data ?? []).map((row) => [row.id, row]))
    const ordered = ids.map((id) => byId.get(id)).filter((row) => row !== undefined)
    return { items: await hydrate(ordered, reader, resolvedOrgId), count: rows.data[0].total_count, page: parsed.page, pageSize: parsed.pageSize }
  }

  const { data, error, count } = await orders(true).order("created_at", { ascending: false }).order("id", { ascending: false })
    .range(from, from + parsed.pageSize - 1)
  if (error) throw new Error(`Failed to list variance orders: ${error.message}`)
  return { items: await hydrate(data ?? [], reader, resolvedOrgId), count: count ?? 0, page: parsed.page, pageSize: parsed.pageSize }
}

export async function rejectVarianceOrder({
  commitmentChangeOrderId,
  reason,
  orgId,
}: { commitmentChangeOrderId: string; reason: string; orgId?: string }) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const existing = await loadSingle(createServiceSupabaseClient(), resolvedOrgId, commitmentChangeOrderId)
  if (!existing?.reason_code_id) throw new Error("Variance order not found")
  await loadOrderCommitment(resolvedOrgId, existing)
  const { permission } = await decisionPermission(supabase, resolvedOrgId, existing)
  await requireAuthorization({
    permission, userId, orgId: resolvedOrgId, projectId: existing.project_id,
    supabase, logDecision: true, resourceType: "commitment_change_order", resourceId: commitmentChangeOrderId,
  })
  if (!reason.trim()) throw new Error("A rejection reason is required.")
  if (!PENDING_STATUSES.includes(existing.status)) throw new Error("Only a pending variance order can be rejected.")
  // Conditional on the status read above: an approval that lands first wins,
  // and this rejection reports it instead of overwriting an approved VPO.
  const { data: rejectedRows, error } = await createServiceSupabaseClient().from("commitment_change_orders").update({
    status: "rejected", metadata: { ...(existing.metadata ?? {}), rejection_reason: reason.trim(), rejected_by: userId },
  }).eq("org_id", resolvedOrgId).eq("id", commitmentChangeOrderId).eq("status", existing.status).select("id")
  if (error) throw new Error(`Failed to reject variance order: ${error.message}`)
  if (!rejectedRows?.length) throw new Error("This variance order changed while you were reviewing it. Reload and try again.")
  const rejected = await loadSingle(createServiceSupabaseClient(), resolvedOrgId, commitmentChangeOrderId)
  if (!rejected) throw new Error("Rejected variance order could not be reloaded")
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "commitment_change_order", entityId: commitmentChangeOrderId, before: { ...existing }, after: { ...rejected } })
  await recordEvent({ orgId: resolvedOrgId, actorId: userId, eventType: "vpo.rejected", entityType: "commitment_change_order", entityId: commitmentChangeOrderId, payload: { project_id: rejected.project_id } })
  return rejected
}

export async function createCommitmentChangeOrder({
  input,
  orgId,
}: {
  input: CommitmentChangeOrderInput
  orgId?: string
}): Promise<CommitmentChangeOrderSummary> {
  const parsed = commitmentChangeOrderInputSchema.parse(input)
  const { supabase: callerClient, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const commitment = await loadParentCommitment(resolvedOrgId, parsed.commitment_id)

  await requireAuthorization({
    permission: parsed.reason_code_id ? "vpo.request" : "commitment.write",
    userId,
    orgId: resolvedOrgId,
    projectId: commitment.project_id,
    supabase: callerClient,
    logDecision: true,
    resourceType: "commitment",
    resourceId: parsed.commitment_id,
  })

  // Authorized above against the house. The change order rows are guarded by house-team RLS,
  // which a purchasing manager working the whole division is not on.
  const supabase = createServiceSupabaseClient()
  await Promise.all([
    assertProjectFiles(supabase, resolvedOrgId, commitment.project_id, parsed.photo_file_ids, "field photos"),
    assertProjectFiles(supabase, resolvedOrgId, commitment.project_id, parsed.evidence_file_ids, "cost evidence"),
  ])

  const totalCents = parsed.lines.reduce((sum, line) => sum + calculateLineAmount(line), 0)
  if (parsed.reason_code_id && commitment.commitment_type !== "purchase_order") {
    throw new Error("Variance orders can only be created against purchase orders.")
  }
  // Every change to a purchase order is a variance order: it carries a reason and is decided under the variance controls.
  if (commitment.commitment_type === "purchase_order" && !parsed.reason_code_id) {
    throw new Error("A variance reason is required for purchase-order changes.")
  }
  assertIssuedPurchaseOrder(commitment)
  if (parsed.reason_code_id) {
    const { data: reason, error: reasonError } = await supabase.from("variance_reason_codes")
      .select("is_backcharge").eq("org_id", resolvedOrgId).eq("id", parsed.reason_code_id).maybeSingle()
    if (reasonError || !reason) throw new Error("Variance reason not found.")
    if (reason.is_backcharge && totalCents >= 0) throw new Error("Trade back-charges must have a negative total.")
  }
  await assertLineReferences(supabase, resolvedOrgId, { projectId: commitment.project_id, commitmentId: commitment.id }, parsed.lines)
  // Header and lines are written in one transaction: a failing line leaves no order behind.
  const { data: createdId, error } = await supabase.rpc("create_commitment_change_order", {
    p_org_id: resolvedOrgId,
    p_header: {
      commitment_id: commitment.id,
      title: parsed.title,
      description: parsed.description ?? null,
      reason_code_id: parsed.reason_code_id ?? null,
      origin: parsed.origin ?? (parsed.reason_code_id ? "office" : null),
      // The requester is whoever is signed in — never a field the client sends,
      // or separation of duties (requester ≠ approver) is one form field away.
      requested_by: parsed.reason_code_id ? userId : null,
      photo_file_ids: parsed.photo_file_ids,
      evidence_file_ids: parsed.evidence_file_ids,
      metadata: parsed.metadata ?? {},
    },
    p_lines: parsed.lines.map((line, index) => linePayload(line, index, resolvedOrgId, null)),
  })
  const changeOrderId = z.string().uuid().safeParse(createdId)
  if (error || !changeOrderId.success) {
    throw new Error(`Failed to create commitment change order: ${error?.message ?? "no order was returned"}`)
  }

  const created = await loadSingle(createServiceSupabaseClient(), resolvedOrgId, changeOrderId.data)
  if (!created) throw new Error("Failed to reload commitment change order")

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "commitment_change_order",
    entityId: created.id,
    after: { ...created },
  })

  await recordEvent({
    orgId: resolvedOrgId,
    actorId: userId,
    eventType: parsed.reason_code_id ? "vpo.requested" : "commitment_change_order_created",
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
  const existing = await loadSingle(createServiceSupabaseClient(), resolvedOrgId, commitmentChangeOrderId)
  if (!existing) throw new Error("Commitment change order not found")
  await loadOrderCommitment(resolvedOrgId, existing)

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

  if (!PENDING_STATUSES.includes(existing.status)) {
    throw new Error("Only draft or sent commitment change orders can be edited.")
  }
  // The reason decides the approval band (and whether a back-charge must be a
  // credit), so a requested VPO keeps the reason it was requested under.
  if (parsed.reason_code_id !== undefined && parsed.reason_code_id !== existing.reason_code_id) {
    throw new Error("A variance reason cannot be changed after the request. Void it and raise a new one.")
  }
  // A variance order raised by an executed change order carries the cost the
  // buyer signed for; purchasing may re-price it, but only with a reason, and
  // it stays tied to its change order and purchase order.
  const systemRaised = existing.origin === "design_studio_co"
  if (parsed.origin !== undefined && parsed.origin !== existing.origin && (systemRaised || parsed.origin === "design_studio_co")) {
    throw new Error("A variance order raised by a change order keeps its origin.")
  }
  if (systemRaised && parsed.lines && !parsed.reprice_reason) {
    throw new Error("Say why this variance order's price changed: it was raised from the buyer's signed change order.")
  }
  // Variance orders are written by the service only (the database refuses a member's own client),
  // and every order is authorized above against its home.
  const writer = createServiceSupabaseClient()
  await Promise.all([
    parsed.photo_file_ids ? assertProjectFiles(writer, resolvedOrgId, existing.project_id, parsed.photo_file_ids, "field photos") : null,
    parsed.evidence_file_ids ? assertProjectFiles(writer, resolvedOrgId, existing.project_id, parsed.evidence_file_ids, "cost evidence") : null,
  ])
  if (parsed.lines) await assertLineReferences(writer, resolvedOrgId, { projectId: existing.project_id, commitmentId: existing.commitment_id }, parsed.lines)
  if (parsed.lines && existing.reason_code_id) {
    const { data: reason, error: reasonError } = await supabase.from("variance_reason_codes")
      .select("is_backcharge").eq("org_id", resolvedOrgId).eq("id", existing.reason_code_id).maybeSingle()
    if (reasonError || !reason) throw new Error("Variance reason not found.")
    const nextTotal = parsed.lines.reduce((sum, line) => sum + calculateLineAmount(line), 0)
    if (reason.is_backcharge && nextTotal >= 0) throw new Error("Trade back-charges must have a negative total.")
  }

  const linePayloads = parsed.lines?.map((line, index) => linePayload(line, index, resolvedOrgId, commitmentChangeOrderId))
  const totalCents = linePayloads ? linePayloads.reduce((sum, line) => sum + line.amount_cents, 0) : existing.total_cents

  const baseMetadata = parsed.metadata ? { ...(existing.metadata ?? {}), ...parsed.metadata } : existing.metadata ?? {}
  const repriced = systemRaised && parsed.lines && parsed.reprice_reason
    ? {
        repricings: [
          ...(Array.isArray(baseMetadata.repricings) ? baseMetadata.repricings : []),
          { at: new Date().toISOString(), by: userId, reason: parsed.reprice_reason, from_cents: existing.total_cents, to_cents: totalCents },
        ],
      }
    : {}
  // Lines, total and fields change in one locked step that refuses anything but a draft or sent order
  // and an order edited since it was read, so an edit can never land on an order approved meanwhile.
  const { error } = await writer.rpc("revise_commitment_change_order", {
    p_org_id: resolvedOrgId,
    p_id: commitmentChangeOrderId,
    p_expected_updated_at: existing.updated_at,
    p_patch: {
      title: parsed.title ?? existing.title,
      description: parsed.description ?? existing.description ?? null,
      origin: parsed.origin === undefined ? existing.origin : parsed.origin,
      photo_file_ids: parsed.photo_file_ids ?? existing.photo_file_ids,
      evidence_file_ids: parsed.evidence_file_ids ?? existing.evidence_file_ids,
      metadata: { ...baseMetadata, ...repriced },
    },
    p_lines: linePayloads ?? null,
  })

  if (error) {
    throw new Error(`Failed to update commitment change order: ${error.message}`)
  }

  const updated = await loadSingle(createServiceSupabaseClient(), resolvedOrgId, commitmentChangeOrderId)
  if (!updated) throw new Error("Failed to reload commitment change order")

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "commitment_change_order",
    entityId: commitmentChangeOrderId,
    before: { ...existing },
    after: { ...updated },
  })

  return updated
}

/**
 * Adds cost evidence to a pending variance order. Whoever may request or decide a variance order may
 * attach evidence to it; this changes nothing else on the order, and a decided order is a record.
 */
export async function attachVarianceOrderEvidence({ commitmentChangeOrderId, fileIds, orgId }: {
  commitmentChangeOrderId: string
  fileIds: string[]
  orgId?: string
}): Promise<CommitmentChangeOrderSummary> {
  const ids = z.array(z.string().uuid()).min(1).max(20).parse(fileIds)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const reader = createServiceSupabaseClient()
  const existing = await loadSingle(reader, resolvedOrgId, commitmentChangeOrderId)
  if (!existing?.reason_code_id) throw new Error("Variance order not found")
  await loadOrderCommitment(resolvedOrgId, existing)
  const asker = { userId, orgId: resolvedOrgId, projectId: existing.project_id, supabase, resourceType: "commitment_change_order", resourceId: commitmentChangeOrderId }
  const requester = await authorize({ ...asker, permission: "vpo.request" })
  if (!requester.allowed) await requireAuthorization({ ...asker, permission: "vpo.approve", logDecision: true })
  if (!PENDING_STATUSES.includes(existing.status)) throw new Error("Evidence is attached before a variance order is decided.")
  const evidence = [...new Set([...existing.evidence_file_ids, ...ids])]
  if (evidence.length > 20) throw new Error("A variance order carries at most 20 evidence files.")
  await assertProjectFiles(reader, resolvedOrgId, existing.project_id, evidence, "cost evidence")
  const { error } = await reader.rpc("revise_commitment_change_order", {
    p_org_id: resolvedOrgId, p_id: commitmentChangeOrderId, p_expected_updated_at: existing.updated_at,
    p_patch: { evidence_file_ids: evidence }, p_lines: null,
  })
  if (error) throw new Error(`Failed to attach evidence: ${error.message}`)
  const updated = await loadSingle(reader, resolvedOrgId, commitmentChangeOrderId)
  if (!updated) throw new Error("Failed to reload commitment change order")
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "commitment_change_order", entityId: commitmentChangeOrderId, before: { ...existing }, after: { ...updated } })
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
  const existing = await loadSingle(createServiceSupabaseClient(), resolvedOrgId, commitmentChangeOrderId)
  if (!existing) throw new Error("Commitment change order not found")
  const commitment = await loadOrderCommitment(resolvedOrgId, existing)
  // A change to a purchase order is approved as a variance order, with its reason: that is what puts it
  // under the band, the evidence rule and the requester/approver split.
  if (commitment.commitment_type === "purchase_order" && !existing.reason_code_id) {
    throw new Error("A purchase-order change without a variance reason cannot be approved. Void it and raise a variance order.")
  }
  assertIssuedPurchaseOrder(commitment)

  const approval = { status: existing.status, isVariance: Boolean(existing.reason_code_id), approverId: userId }
  const blocked = vpoApprovalBlockReason({ ...approval, requestedBy: null })
  if (blocked) throw new Error(blocked)
  if (!PENDING_STATUSES.includes(existing.status)) throw new Error("This change order is already approved.")
  // With the status settled, a remaining block is the requester approving
  // their own variance order: refused and audited.
  const selfApproval = vpoApprovalBlockReason({ ...approval, requestedBy: existing.requested_by })
  if (selfApproval) {
    await refuseSeparationOfDuties({
      orgId: resolvedOrgId,
      userId,
      actionKey: "vpo.approve",
      resourceType: "commitment_change_order",
      resourceId: commitmentChangeOrderId,
      projectId: existing.project_id,
      rule: "variance_order.requester_cannot_approve",
      message: selfApproval,
    })
  }

  const { permission: approvalPermission, isBackcharge, evidenceOverCents } = await decisionPermission(supabase, resolvedOrgId, existing)
  await requireAuthorization({
    permission: approvalPermission,
    userId,
    orgId: resolvedOrgId,
    projectId: existing.project_id,
    supabase,
    logDecision: true,
    resourceType: "commitment_change_order",
    resourceId: commitmentChangeOrderId,
  })

  const service = createServiceSupabaseClient()
  if (existing.reason_code_id) {
    const evidenceBlock = vpoEvidenceBlockReason({
      totalCents: existing.total_cents,
      isBackcharge,
      evidenceOverCents,
      evidenceCount: existing.evidence_file_ids.length,
    })
    if (evidenceBlock) throw new Error(evidenceBlock)
    // Evidence on file is checked again at the decision: it must still be the home's own live files.
    await assertProjectFiles(service, resolvedOrgId, existing.project_id, existing.evidence_file_ids, "cost evidence")
  }

  const nowIso = new Date().toISOString()
  const metadata = {
    ...(existing.metadata ?? {}),
    approved_note: note ?? (existing.metadata ?? {}).approved_note ?? null,
  }

  // Conditional on the status, total and revision the band and the evidence were checked against:
  // a concurrent reject, void, line edit or evidence replacement makes this update miss instead of
  // approving something nobody reviewed.
  const { data: approvedRows, error } = await service
    .from("commitment_change_orders")
    .update({
      status: "approved",
      approved_at: nowIso,
      approved_by: userId,
      metadata,
      updated_at: nowIso,
    })
    .eq("org_id", resolvedOrgId)
    .eq("id", commitmentChangeOrderId)
    .eq("status", existing.status)
    .eq("total_cents", existing.total_cents)
    .eq("updated_at", existing.updated_at)
    .select("id")

  if (error) {
    throw new Error(`Failed to approve commitment change order: ${error.message}`)
  }
  if (!approvedRows?.length) {
    throw new Error("This change order changed while you were reviewing it. Reload and try again.")
  }

  const approved = await loadSingle(createServiceSupabaseClient(), resolvedOrgId, commitmentChangeOrderId)
  if (!approved) throw new Error("Failed to reload commitment change order")

  await recordEvent({
    orgId: resolvedOrgId,
    actorId: userId,
    eventType: existing.reason_code_id ? "vpo.approved" : "commitment_change_order_approved",
    entityType: "commitment_change_order",
    entityId: commitmentChangeOrderId,
    payload: {
      project_id: approved.project_id,
      commitment_id: approved.commitment_id,
      total_cents: approved.total_cents,
    },
  })

  // Last, so a pending audit row cannot also cost the approval its event.
  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "commitment_change_order",
    entityId: commitmentChangeOrderId,
    before: { ...existing },
    after: { ...approved },
    critical: true,
  })

  return approved
}

export async function voidCommitmentChangeOrder({
  commitmentChangeOrderId,
  reason,
  orgId,
}: {
  commitmentChangeOrderId: string
  reason: string
  orgId?: string
}): Promise<CommitmentChangeOrderSummary> {
  const note = reason?.trim() ?? ""
  if (note.length < 5) throw new Error("Say why this change order is being voided.")
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  const reader = createServiceSupabaseClient()
  const existing = await loadSingle(reader, resolvedOrgId, commitmentChangeOrderId)
  if (!existing) throw new Error("Commitment change order not found")
  await loadOrderCommitment(resolvedOrgId, existing)

  // Voiding takes an order out of (or puts a credit back into) what the purchase order authorizes, so a
  // variance order needs the permission its amount needs to approve, exactly like a decision.
  const { permission } = await decisionPermission(supabase, resolvedOrgId, existing)
  await requireAuthorization({
    permission,
    userId,
    orgId: resolvedOrgId,
    projectId: existing.project_id,
    supabase,
    logDecision: true,
    resourceType: "commitment_change_order",
    resourceId: commitmentChangeOrderId,
  })

  if (existing.status === "voided") return existing
  if (existing.status === "rejected") throw new Error("A rejected change order is already closed.")

  // One locked step, serialized with completion approval: it refuses an order a completion claims or a bill
  // bills, and a void that would leave the purchase order billed past what it authorizes. A decision that
  // lands first wins.
  const { error } = await reader.rpc("void_commitment_change_order", {
    p_org_id: resolvedOrgId, p_id: commitmentChangeOrderId, p_actor_id: userId, p_reason: note, p_expected_status: existing.status,
  })
  if (error) throw new Error(error.message)

  const voided = await loadSingle(reader, resolvedOrgId, commitmentChangeOrderId)
  if (!voided) throw new Error("Failed to reload commitment change order")

  await recordEvent({
    orgId: resolvedOrgId,
    actorId: userId,
    eventType: existing.reason_code_id ? "vpo.voided" : "commitment_change_order_voided",
    entityType: "commitment_change_order",
    entityId: commitmentChangeOrderId,
    payload: { project_id: voided.project_id, commitment_id: voided.commitment_id, total_cents: voided.total_cents },
  })
  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "commitment_change_order",
    entityId: commitmentChangeOrderId,
    before: { ...existing },
    after: { ...voided },
    critical: true,
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
  const existing = await loadSingle(createServiceSupabaseClient(), resolvedOrgId, commitmentChangeOrderId)
  if (!existing) throw new Error("Commitment change order not found")
  await loadOrderCommitment(resolvedOrgId, existing)

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
  if (existing.origin === "design_studio_co") {
    throw new Error("A variance order raised by a change order is kept with it. Void it instead.")
  }

  const { error } = await createServiceSupabaseClient()
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
    before: { ...existing },
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
  // A rejected or voided order is closed: a late signature is not a decision.
  if (!PENDING_STATUSES.includes(existing.status) && existing.status !== "approved") return existing
  const commitment = await loadOrderCommitment(input.orgId, existing)
  // A signature approves only a plain subcontract change order. A purchase-order change is approved by a
  // named approver under the variance controls (band, evidence, separation of duties), so for it the
  // signature is recorded as evidence and the status is left alone.
  const approvesBySignature = PENDING_STATUSES.includes(existing.status) && commitment.commitment_type !== "purchase_order" && !existing.reason_code_id

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

  // Conditional on the status read above, so a decision that lands first is never overwritten.
  const { data: recorded, error } = await supabase
    .from("commitment_change_orders")
    .update({
      ...(approvesBySignature ? { status: "approved", approved_at: existing.approved_at ?? nowIso, updated_at: nowIso } : {}),
      source_document_id: input.documentId,
      executed_file_id: input.executedFileId,
      signature_envelope_id: input.envelopeId,
      metadata,
    })
    .eq("org_id", input.orgId)
    .eq("id", input.commitmentChangeOrderId)
    .eq("status", existing.status)
    .select("id")

  if (error) {
    throw new Error(`Failed to mark commitment change order executed: ${error.message}`)
  }
  if (!recorded?.length) return existing

  const updated = await loadSingle(supabase, input.orgId, input.commitmentChangeOrderId)
  if (!updated) throw new Error("Failed to reload executed commitment change order")

  await recordAudit({
    orgId: input.orgId,
    actorId: undefined,
    action: "update",
    entityType: "commitment_change_order",
    entityId: input.commitmentChangeOrderId,
    before: { ...existing },
    after: { ...updated },
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
      approved_at, approved_by, source_document_id, executed_file_id, signature_envelope_id, prime_change_order_id, reason_code_id, origin, requested_by, photo_file_ids, evidence_file_ids, metadata, created_at, updated_at,
      commitment:commitments(id, title),
      company:companies(id, name), reason:variance_reason_codes(code, label)
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

  const commitment = await loadParentCommitment(resolvedOrgId, parsed.commitment_id)
  if (commitment.project_id !== changeOrder.project_id) {
    throw new Error("Commitment must belong to the same project as the change order.")
  }
  if (commitment.commitment_type === "purchase_order") {
    throw new Error("A purchase order's change is raised as a variance order from Purchasing, with a reason. Pick a subcontract here.")
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
      photo_file_ids: [],
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
  await loadOrderCommitment(resolvedOrgId, commitmentChangeOrder)

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

  // The link is the member's to make, but a decided order's metadata is a record the database keeps.
  const { error } = await createServiceSupabaseClient()
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

  const updated = await loadSingle(createServiceSupabaseClient(), resolvedOrgId, parsed.commitment_change_order_id)
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
  const commitmentChangeOrder = await loadSingle(createServiceSupabaseClient(), resolvedOrgId, commitmentChangeOrderId)
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
