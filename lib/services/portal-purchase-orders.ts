import { claimedCompletionChangeOrderIds, claimedCompletionLineIds, hasWholeOrderClaim, type CompletionCoverage } from "@/lib/services/po-completions"
import { loadPoIssueViews, type PoIssueView } from "@/lib/services/po-acknowledgments"
import { PO_ISSUED_STATUSES } from "@/lib/purchasing/po-lock"
import { resolvePayOnPo } from "@/lib/services/purchasing-settings"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import type { PortalAccessToken } from "@/lib/types"

/** One page of a vendor's purchase orders; past it the portal says how many it left out. */
export const PORTAL_PURCHASE_ORDER_CAP = 100

export type PortalPurchaseOrder = {
  id: string
  projectId: string
  projectName: string
  title: string
  status: string
  totalCents: number
  contractNumber: string | null
  scope: string | null
  lines: Array<{ id: string; description: string; quantity: number; unit: string | null; scheduledValueCents: number; claimed: boolean }>
  changes: Array<{ id: string; title: string; status: string; totalCents: number; reasonLabel: string | null; claimed: boolean }>
  completions: Array<{ id: string; status: string; reportedAt: string; amountCents: number | null; rejectedReason: string | null; vendorBill: { status: string; paidCents: number; totalCents: number } | null }>
  /** False once every line is claimed by a live completion — a rejected one is not. */
  hasReportableScope: boolean
  /** The version the vendor is held to and its answer; null for an order issued before versions existed. */
  issue: PoIssueView | null
}

function firstRelation(value: unknown) {
  const row = Array.isArray(value) ? value[0] : value
  return row && typeof row === "object" ? row as Record<string, unknown> : null
}

/**
 * The vendor's issued purchase orders, with the version each is held to. A link
 * for one home lists that home's orders; a vendor-account link lists every
 * home's, newest first, capped and counted. Visibility does not depend on
 * pay-on-PO: that setting only decides whether completion can be reported.
 */
export async function listPortalPurchaseOrders(access: PortalAccessToken): Promise<{
  orders: PortalPurchaseOrder[]
  total: number
  limit: number
  canReportCompletion: boolean
}> {
  if (!access.company_id || access.permissions.can_view_purchase_orders !== true) throw new Error("Access denied")
  const service = createServiceSupabaseClient()
  let query = service.from("commitments").select(`
    id,project_id,title,status,total_cents,contract_number,scope,created_at,
    project:projects(name),
    lines:commitment_lines(id,description,quantity,unit,unit_cost_cents,scheduled_value_cents,sort_order),
    changes:commitment_change_orders(id,title,status,total_cents,reason:variance_reason_codes(label)),
    completions:po_completions(id,status,reported_at,rejected_reason,amount_cents,commitment_line_ids,change_order_ids,vendor_bill:vendor_bills(status,paid_cents,total_cents))
  `, { count: "exact" }).eq("org_id", access.org_id).eq("company_id", access.company_id)
    .eq("commitment_type", "purchase_order")// Drafts were never sent and cancelled orders no longer bind anyone, so neither reaches the portal.
    .in("status", [...PO_ISSUED_STATUSES])
  if (access.project_id) query = query.eq("project_id", access.project_id)
  const [{ data, error, count }, canReportCompletion] = await Promise.all([
    query.order("created_at", { ascending: false }).order("id").range(0, PORTAL_PURCHASE_ORDER_CAP - 1),
    // Completion is reported against one home, so only a home's link can report it.
    access.project_id && access.permissions.can_report_po_completion === true
      ? resolvePayOnPo(service, access.org_id).then((setting) => setting.enabled)
      : false,
  ])
  if (error) throw new Error(`Failed to load portal purchase orders: ${error.message}`)
  const rows = data ?? []
  const issues = await loadPoIssueViews(access.org_id, rows.map((row) => String(row.id)))
  const orders = rows.map((row): PortalPurchaseOrder => {
    const rawCompletions: CompletionCoverage[] = (row.completions ?? []).map((completion: Record<string, unknown>) => ({
      id: String(completion.id), status: String(completion.status),
      commitment_line_ids: Array.isArray(completion.commitment_line_ids) ? completion.commitment_line_ids.map(String) : null,
      change_order_ids: Array.isArray(completion.change_order_ids) ? completion.change_order_ids.map(String) : null,
    }))
    const claimedChangeIds = claimedCompletionChangeOrderIds(rawCompletions)
    const claimedLineIds = claimedCompletionLineIds(rawCompletions)
    const wholeOrderClaimed = hasWholeOrderClaim(rawCompletions)
    const lines = (row.lines ?? [])
      .slice()
      .sort((a: Record<string, number>, b: Record<string, number>) => Number(a.sort_order ?? 0) - Number(b.sort_order ?? 0))
      .map((line: Record<string, unknown>) => ({
        id: String(line.id), description: String(line.description ?? ""),
        quantity: Number(line.quantity ?? 0), unit: typeof line.unit === "string" ? line.unit : null,
        scheduledValueCents: Number(line.scheduled_value_cents ?? 0),
        claimed: wholeOrderClaimed || claimedLineIds.has(String(line.id)),
      }))
    return {
      id: String(row.id), projectId: String(row.project_id),
      projectName: typeof firstRelation(row.project)?.name === "string" ? String(firstRelation(row.project)?.name) : "Home",
      title: String(row.title ?? "Purchase order"), status: String(row.status),
      totalCents: Number(row.total_cents ?? 0),
      contractNumber: typeof row.contract_number === "string" ? row.contract_number : null,
      scope: typeof row.scope === "string" ? row.scope : null,
      lines,
      // A trade sees the revisions it is held to: approved VPOs, not drafts
      // or requests still under review.
      changes: (row.changes ?? []).filter((change: Record<string, unknown>) => change.status === "approved").map((change: Record<string, unknown>) => ({
        id: String(change.id), title: String(change.title ?? ""), status: String(change.status),
        totalCents: Number(change.total_cents ?? 0),
        reasonLabel: typeof firstRelation(change.reason)?.label === "string" ? String(firstRelation(change.reason)?.label) : null,
        claimed: claimedChangeIds.has(String(change.id)),
      })),
      completions: (row.completions ?? [])
        .map((completion: Record<string, unknown>) => {
          const bill = firstRelation(completion.vendor_bill)
          return {
            id: String(completion.id), status: String(completion.status),
            reportedAt: String(completion.reported_at),
            amountCents: typeof completion.amount_cents === "number" ? completion.amount_cents : null,
            rejectedReason: typeof completion.rejected_reason === "string" ? completion.rejected_reason : null,
            vendorBill: bill ? { status: String(bill.status), paidCents: Number(bill.paid_cents ?? 0), totalCents: Number(bill.total_cents ?? 0) } : null,
          }
        })
        .sort((a: { reportedAt: string }, b: { reportedAt: string }) => b.reportedAt.localeCompare(a.reportedAt)),
      hasReportableScope: lines.some((line) => !line.claimed) || (row.changes ?? []).some((change: Record<string, unknown>) => change.status === "approved" && !claimedChangeIds.has(String(change.id))),
      issue: issues.get(String(row.id)) ?? null,
    }
  })
  return { orders, total: count ?? orders.length, limit: PORTAL_PURCHASE_ORDER_CAP, canReportCompletion }
}
