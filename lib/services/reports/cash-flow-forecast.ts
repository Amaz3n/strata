import { BILLED_INVOICE_STATUSES, PAYABLE_VENDOR_BILL_STATUSES } from "@/lib/financials/ledger-status"
import { payableOutstandingCents } from "@/lib/financials/payables-rules"
import { readAllRowsById } from "@/lib/land/paging"
import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"
import { resolveVisibleProjectIds } from "@/lib/services/projects"

function month(date: string | null | undefined) {
  return date && /^\d{4}-\d{2}/.test(date) ? date.slice(0, 7) : new Date().toISOString().slice(0, 7)
}

/** One ID-keyed `.in()` list per request; a long list does not fit in a PostgREST URL. */
const PROJECT_CHUNK = 100
/** A scope past this many rows fails loudly rather than forecasting from part of it. */
const FORECAST_ROW_CAP = 50_000

type ForecastProject = { id: string; name: string; start_date: string | null; end_date: string | null }
type ForecastInvoice = { id: string; project_id: string; due_date: string | null; balance_due_cents: number | null; total_cents: number | null }
type ForecastBill = { id: string; project_id: string; due_date: string | null; total_cents: number | null; paid_cents: number | null; retainage_cents: number | null }
type ForecastCommitment = { id: string; project_id: string; total_cents: number | null; vendor_bills: Array<{ total_cents: number | null }> | null }

function chunks(ids: string[]) {
  const out: string[][] = []
  for (let index = 0; index < ids.length; index += PROJECT_CHUNK) out.push(ids.slice(index, index + PROJECT_CHUNK))
  return out
}

/**
 * Cash in and out for every delivery project the caller can open. The caller's
 * division and project-membership scope always applies; a `divisionId`,
 * `communityId` or `projectId` lens only narrows it. Every set is read to the
 * end — a forecast summed from the first page is not smaller, it is wrong.
 */
export async function getCashFlowForecast(input: { projectId?: string; divisionId?: string; communityId?: string; orgId?: string }) {
  const context = await requireOrgContext(input.orgId)
  const { supabase, orgId, userId } = context
  await requirePermission("report.read", context)
  const visibleProjectIds = await resolveVisibleProjectIds({ supabase, orgId, userId, includePrecon: false })
  if (visibleProjectIds?.length === 0) return { months: [], rows: [] }
  const projects = await readAllRowsById<ForecastProject>((afterId, limit) => {
    let query = supabase.from("projects").select("id,name,start_date,end_date").eq("org_id", orgId).eq("phase", "delivery").in("status", ["active","planning","on_hold"])
    if (visibleProjectIds) query = query.in("id", visibleProjectIds)
    if (input.projectId) query = query.eq("id", input.projectId)
    if (input.divisionId) query = query.eq("division_id", input.divisionId)
    if (input.communityId) query = query.eq("community_id", input.communityId)
    if (afterId) query = query.gt("id", afterId)
    return query.order("id").limit(limit).returns<ForecastProject[]>()
  }, { cap: FORECAST_ROW_CAP, label: "Failed to load cash-flow projects", pageSize: 1000 })
  const ids = projects.map((project) => project.id)
  if (!ids.length) return { months: [], rows: [] }
  const readPerChunk = async <Row extends { id: string }>(label: string, read: (projectIds: string[], afterId: string | null, limit: number) => PromiseLike<{ data: Row[] | null; error: { message: string } | null }>) =>
    (await Promise.all(chunks(ids).map((projectIds) => readAllRowsById<Row>((afterId, limit) => read(projectIds, afterId, limit), { cap: FORECAST_ROW_CAP, label, pageSize: 1000 })))).flat()
  const [invoices, bills, commitments] = await Promise.all([
    // Forecast cash IN from real receivables only. Excluding `paid` and `void`
    // left `draft` and `saved` in, so an invoice nobody had sent — and might
    // never send — was projected as money arriving on its due date.
    readPerChunk<ForecastInvoice>("Failed to load cash-flow receivables", (projectIds, afterId, limit) => {
      let query = supabase.from("invoices").select("id,project_id,due_date,balance_due_cents,total_cents").eq("org_id", orgId).in("project_id", projectIds).in("status", [...BILLED_INVOICE_STATUSES])
      if (afterId) query = query.gt("id", afterId)
      return query.order("id").limit(limit).returns<ForecastInvoice[]>()
    }),
    readPerChunk<ForecastBill>("Failed to load cash-flow payables", (projectIds, afterId, limit) => {
      let query = supabase.from("vendor_bills").select("id,project_id,due_date,total_cents,paid_cents,retainage_cents").eq("org_id", orgId).in("project_id", projectIds).in("status", [...PAYABLE_VENDOR_BILL_STATUSES])
      if (afterId) query = query.gt("id", afterId)
      return query.order("id").limit(limit).returns<ForecastBill[]>()
    }),
    readPerChunk<ForecastCommitment>("Failed to load cash-flow commitments", (projectIds, afterId, limit) => {
      let query = supabase.from("commitments").select("id,project_id,total_cents,vendor_bills(total_cents)").eq("org_id", orgId).in("project_id", projectIds).in("status", ["approved","executed"])
      if (afterId) query = query.gt("id", afterId)
      return query.order("id").limit(limit).returns<ForecastCommitment[]>()
    }),
  ])
  const buckets = new Map<string, { inflow_cents: number; outflow_cents: number; committed_unbilled_cents: number }>()
  const bucket = (key: string) => { const value = buckets.get(key) ?? { inflow_cents: 0, outflow_cents: 0, committed_unbilled_cents: 0 }; buckets.set(key, value); return value }
  for (const invoice of invoices) bucket(month(invoice.due_date)).inflow_cents += Math.max(0, Number(invoice.balance_due_cents ?? invoice.total_cents ?? 0))
  // Held retainage is not due on the bill's due date — `payableOutstandingCents`
  // is the one rule that knows to leave it out.
  for (const bill of bills) bucket(month(bill.due_date)).outflow_cents += payableOutstandingCents({ total_cents: Number(bill.total_cents ?? 0), paid_cents: Number(bill.paid_cents ?? 0), retainage_cents: Number(bill.retainage_cents ?? 0) })
  const projectById = new Map(projects.map((project) => [project.id, project]))
  for (const commitment of commitments) {
    const billed = (commitment.vendor_bills ?? []).reduce((sum, bill) => sum + Number(bill.total_cents ?? 0), 0)
    const unbilled = Math.max(0, Number(commitment.total_cents ?? 0) - billed)
    const project = projectById.get(commitment.project_id)
    bucket(month(project?.end_date)).committed_unbilled_cents += unbilled
  }
  const months = Array.from(buckets.keys()).sort()
  return { months, rows: months.map((key) => { const value = bucket(key); return { month: key, ...value, net_cents: value.inflow_cents - value.outflow_cents - value.committed_unbilled_cents } }) }
}
