import {
  buildClosingInvoiceLines,
  buildPurchaseAgreementSettlement,
  type PurchaseAgreementPricing,
  type SettlementDeposit,
} from "@/lib/financials/purchase-agreement-pricing"
import { recordAudit } from "@/lib/services/audit"
import {
  getDivisionAccessForUser,
  getDivisionScopedProjectIds,
} from "@/lib/services/authorization"
import { hasExecutedPurchaseAgreement } from "@/lib/services/community-sales"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { createInvoice } from "@/lib/services/invoices"
import { recordPayment } from "@/lib/services/payments"
import { requirePermission } from "@/lib/services/permissions"
import { enqueueOutboxJob } from "@/lib/services/outbox"
import { scheduleClosingSchema, settleClosingSchema, updateClosingChecklistItemSchema } from "@/lib/validation/closings"

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

function invoiceUnitCostFromCents(amountCents: number) {
  return Math.abs(amountCents) > 100_000 ? amountCents : amountCents / 100
}

function relationOne<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null
}

async function ensureClosingChecklist(closingId: string, orgId: string) {
  const context = await requireOrgContext(orgId)
  const { data: existing, error } = await context.supabase.from("closing_checklist_items").select("*").eq("org_id", orgId).eq("closing_id", closingId).order("sort_order")
  if (error) throw new Error(`Failed to load closing checklist: ${error.message}`)
  if ((existing ?? []).length) return existing ?? []
  const { data, error: insertError } = await context.supabase.from("closing_checklist_items").insert(DEFAULT_CHECKLIST.map((item, index) => ({ org_id: orgId, closing_id: closingId, title: item.title, is_gate: item.gate, status: "open", sort_order: index, created_by: context.userId }))).select("*")
  if (insertError) throw new Error(`Failed to seed closing checklist: ${insertError.message}`)
  return data ?? []
}

export async function buildSettlement(closingId: string, orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.read", context)
  const { data: closing, error } = await context.supabase.from("closings").select("id, project_id, status").eq("org_id", context.orgId).eq("id", closingId).maybeSingle()
  if (error || !closing) throw new Error("Closing not found")
  const [{ data: contract }, { data: changeOrders }, { data: invoices }] = await Promise.all([
    context.supabase.from("contracts").select("id, total_cents, snapshot").eq("org_id", context.orgId).eq("project_id", closing.project_id).eq("contract_type", "purchase_agreement").eq("status", "active").order("signed_at", { ascending: false }).limit(1).maybeSingle(),
    context.supabase.from("change_orders").select("id, title, total_cents, metadata").eq("org_id", context.orgId).eq("project_id", closing.project_id).eq("status", "approved"),
    context.supabase.from("invoices").select("id, title, status, metadata, payments(id, amount_cents, status, created_at)").eq("org_id", context.orgId).eq("project_id", closing.project_id).contains("metadata", { invoice_kind: "earnest_deposit" }),
  ])
  if (!contract) throw new Error("An executed purchase agreement is required")
  const deposits: SettlementDeposit[] = []
  for (const invoice of invoices ?? []) {
    for (const payment of (invoice as any).payments ?? []) {
      if (payment.status !== "succeeded") continue
      deposits.push({ invoiceId: invoice.id, paymentId: payment.id, label: invoice.title ?? "Earnest deposit", amountCents: Number(payment.amount_cents), receivedAt: payment.created_at })
    }
  }
  const settlement = buildPurchaseAgreementSettlement({
    agreementTotalCents: Number(contract.total_cents ?? 0),
    approvedChangeOrders: (changeOrders ?? []).map((row: any) => ({ id: row.id, totalCents: Number(row.total_cents ?? 0) })),
    deposits,
  })
  if (closing.status !== "closed") {
    const { error: updateError } = await context.supabase.from("closings").update({ settlement }).eq("org_id", context.orgId).eq("id", closing.id)
    if (updateError) throw new Error(`Failed to save settlement preview: ${updateError.message}`)
  }
  return { ...settlement, contractId: contract.id, pricing: (contract.snapshot as any)?.purchase_agreement?.pricing as PurchaseAgreementPricing | undefined, changeOrders: changeOrders ?? [] }
}

export async function getClosing(projectId: string, orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.read", context)
  const authorizedProjectIds = await getDivisionScopedProjectIds({
    orgId: context.orgId,
    userId: context.userId,
    supabase: context.supabase,
  })
  if (authorizedProjectIds !== null && !authorizedProjectIds.includes(projectId)) return null
  const { data: closing, error } = await context.supabase.from("closings").select("*, project:projects(name, client:contacts(full_name, email)), lot:lots(lot_number, status), community:communities(name)").eq("org_id", context.orgId).eq("project_id", projectId).neq("status", "cancelled").maybeSingle()
  if (error) throw new Error(`Failed to load closing: ${error.message}`)
  if (!closing) return null
  const [checklist, settlementPreview, agreementResult] = await Promise.all([
    ensureClosingChecklist(closing.id, context.orgId),
    buildSettlement(closing.id, context.orgId),
    context.supabase.from("contracts").select("id, number, title, status, total_cents, signed_at, snapshot").eq("org_id", context.orgId).eq("project_id", projectId).eq("contract_type", "purchase_agreement").order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ])
  return { closing, checklist, settlementPreview, agreement: agreementResult.data ?? null }
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

export async function scheduleClosing(input: unknown, orgId?: string) {
  const parsed = scheduleClosingSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("closing.manage", context)
  const { data: before } = await context.supabase.from("closings").select("*").eq("org_id", context.orgId).eq("id", parsed.closingId).maybeSingle()
  if (!before || !["projected", "scheduled"].includes(before.status)) throw new Error("Projected closing not found")
  const { data, error } = await context.supabase.from("closings").update({ status: "scheduled", scheduled_date: parsed.scheduledDate }).eq("org_id", context.orgId).eq("id", before.id).select("*").single()
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
  const { data: before } = await context.supabase.from("closing_checklist_items").select("*").eq("org_id", context.orgId).eq("id", parsed.itemId).maybeSingle()
  if (!before) throw new Error("Closing checklist item not found")
  if (parsed.status === "waived" && !parsed.notes?.trim()) throw new Error("A reason is required to waive a closing gate")
  const { data, error } = await context.supabase.from("closing_checklist_items").update({ status: parsed.status, file_id: parsed.fileId ?? before.file_id, notes: parsed.notes ?? before.notes, completed_at: parsed.status !== "open" ? new Date().toISOString() : null, completed_by: parsed.status !== "open" ? context.userId : null }).eq("org_id", context.orgId).eq("id", parsed.itemId).select("*").single()
  if (error || !data) throw new Error(`Failed to update closing checklist: ${error?.message}`)
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "closing_checklist_item", entityId: data.id, before, after: data })
  return data
}

export async function markClearedToClose(closingId: string, orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requirePermission("closing.manage", context)
  const { data: closing } = await context.supabase.from("closings").select("*").eq("org_id", context.orgId).eq("id", closingId).maybeSingle()
  if (!closing || closing.status !== "scheduled") throw new Error("Scheduled closing not found")
  const checklist = await ensureClosingChecklist(closing.id, context.orgId)
  const openGate = checklist.find((item: any) => item.is_gate && !["complete", "waived"].includes(item.status))
  if (openGate) throw new Error(`Complete or waive the closing gate: ${openGate.title}`)
  if (!await hasExecutedPurchaseAgreement(closing.project_id, context.orgId)) throw new Error("An executed purchase agreement is required")
  const { count, error: punchError } = await context.supabase.from("punch_items").select("id", { count: "exact", head: true }).eq("org_id", context.orgId).eq("project_id", closing.project_id).not("status", "in", "(completed,closed)")
  if (punchError && !punchError.message.includes("punch_items")) throw new Error(`Failed to verify punch list: ${punchError.message}`)
  if ((count ?? 0) > 0) throw new Error("Open punch items must be cleared before closing")
  const { data, error } = await context.supabase.from("closings").update({ status: "cleared_to_close" }).eq("org_id", context.orgId).eq("id", closing.id).select("*").single()
  if (error || !data) throw new Error(`Failed to clear closing: ${error?.message}`)
  await recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "closing_cleared", entityType: "closing", entityId: data.id, payload: { project_id: data.project_id } })
  return data
}

export async function settleClosing(input: unknown, orgId?: string) {
  const parsed = settleClosingSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("closing.manage", context)
  await requirePermission("payment.release", context)
  const { data: closing } = await context.supabase.from("closings").select("*, project:projects(name, client_id, client:contacts(full_name, email)), lot:lots(lot_number, house_plan_id, plan:house_plans(name))").eq("org_id", context.orgId).eq("id", parsed.closingId).maybeSingle()
  if (!closing) throw new Error("Closing not found")
  if (closing.status === "closed") return getClosing(closing.project_id, context.orgId)
  if (closing.status !== "cleared_to_close") throw new Error("Closing must be cleared to close")
  const settlement = await buildSettlement(closing.id, context.orgId)
  if (settlement.balanceDueCents < 0) throw new Error("Deposits exceed the final purchase price; resolve the overpayment before closing")
  const pricing = settlement.pricing
  if (!pricing) throw new Error("Purchase agreement pricing snapshot is missing")
  const project = relationOne(closing.project) as any
  const lot = relationOne(closing.lot) as any
  const plan = relationOne(lot?.plan) as any
  const invoiceLines = buildClosingInvoiceLines({ pricing, lotLabel: lot?.lot_number ?? "—", planLabel: plan?.name ?? "Home", approvedChangeOrders: (settlement.changeOrders ?? []).map((row: any) => ({ id: row.id, title: row.title, totalCents: Number(row.total_cents ?? 0), number: row.metadata?.number ?? null })), deposits: settlement.depositsApplied })
  const invoice = await createInvoice({ input: {
    project_id: closing.project_id, invoice_number: `CLOSE-${Date.now().toString().slice(-9)}`, title: `Closing — ${project?.name ?? "Home"}`,
    status: "sent", issue_date: parsed.actualDate, due_date: parsed.actualDate, client_visible: true, tax_rate: 0,
    customer_id: project?.client_id ?? null, customer_name: project?.client?.full_name ?? null, sent_to_emails: project?.client?.email ? [project.client.email] : undefined,
    lines: invoiceLines.map((line) => ({ description: line.description, quantity: 1, unit: "closing", unit_cost: invoiceUnitCostFromCents(line.amountCents), taxable: false })),
    metadata: { invoice_kind: "closing", source_closing_id: closing.id, settlement },
  }, orgId: context.orgId, context, authorizationPermission: "closing.manage", sendAuthorizationPermission: "closing.manage" })
  if (settlement.balanceDueCents > 0) {
    await recordPayment({ invoice_id: invoice.id, amount_cents: settlement.balanceDueCents, fee_cents: 0, currency: "usd", method: parsed.paymentMethod, provider: "manual", provider_payment_id: `closing:${closing.id}`, reference: parsed.paymentReference, status: "succeeded", metadata: { source_closing_id: closing.id } }, context.orgId)
  }
  for (const deposit of settlement.depositsApplied) {
    const { data: depositInvoice } = await context.supabase.from("invoices").select("metadata").eq("org_id", context.orgId).eq("id", deposit.invoiceId).maybeSingle()
    await context.supabase.from("invoices").update({ metadata: { ...(depositInvoice?.metadata ?? {}), settled_into_closing_id: closing.id } }).eq("org_id", context.orgId).eq("id", deposit.invoiceId)
  }
  const now = new Date().toISOString()
  const { data: updated, error } = await context.supabase.from("closings").update({ status: "closed", actual_date: parsed.actualDate, settlement, closing_invoice_id: invoice.id, updated_at: now }).eq("org_id", context.orgId).eq("id", closing.id).select("*").single()
  if (error || !updated) throw new Error(`Failed to settle closing: ${error?.message}`)
  await context.supabase.from("lots").update({ status: "closed" }).eq("org_id", context.orgId).eq("id", closing.lot_id)
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "closing_settled", entityType: "closing", entityId: closing.id, payload: { final_price_cents: settlement.finalPriceCents, community_id: closing.community_id, closing_invoice_id: invoice.id } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "closing", entityId: closing.id, before: closing, after: updated }),
    enqueueOutboxJob({ orgId: context.orgId, jobType: "warranty_enroll_coverage", payload: { project_id: closing.project_id, effective_date: parsed.actualDate }, dedupeByPayloadKeys: ["project_id"] }),
  ])
  return getClosing(closing.project_id, context.orgId)
}

export async function cancelClosing(input: { closingId: string; reason: string }, orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requirePermission("closing.manage", context)
  const { data, error } = await context.supabase.from("closings").update({ status: "cancelled", cancel_reason: input.reason }).eq("org_id", context.orgId).eq("id", input.closingId).neq("status", "closed").select("*").maybeSingle()
  if (error || !data) throw new Error("Closing could not be cancelled")
  await recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "closing_cancelled", entityType: "closing", entityId: data.id, payload: { reason: input.reason } })
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
