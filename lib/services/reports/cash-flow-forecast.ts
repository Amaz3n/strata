import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"

function month(date: string | null | undefined) {
  return date && /^\d{4}-\d{2}/.test(date) ? date.slice(0, 7) : new Date().toISOString().slice(0, 7)
}

export async function getCashFlowForecast(input: { projectId?: string; divisionId?: string; communityId?: string; orgId?: string }) {
  const context = await requireOrgContext(input.orgId)
  await requirePermission("report.read", context)
  let projectsQuery = context.supabase.from("projects").select("id,name,start_date,end_date").eq("org_id", context.orgId).eq("phase", "delivery").in("status", ["active","planning","on_hold"])
  if (input.projectId) projectsQuery = projectsQuery.eq("id", input.projectId)
  if (input.divisionId) projectsQuery = projectsQuery.eq("division_id", input.divisionId)
  if (input.communityId) projectsQuery = projectsQuery.eq("community_id", input.communityId)
  const { data: projects, error: projectError } = await projectsQuery.limit(1000)
  if (projectError) throw new Error(`Failed to load cash-flow projects: ${projectError.message}`)
  const ids = (projects ?? []).map((project) => project.id)
  if (!ids.length) return { months: [], rows: [] }
  const [invoiceResult, billResult, commitmentResult] = await Promise.all([
    context.supabase.from("invoices").select("id,project_id,due_date,balance_due_cents,total_cents,status").eq("org_id", context.orgId).in("project_id", ids).not("status", "in", "(paid,void)"),
    context.supabase.from("vendor_bills").select("id,project_id,due_date,total_cents,paid_cents,status").eq("org_id", context.orgId).in("project_id", ids).in("status", ["approved","partial"]),
    context.supabase.from("commitments").select("id,project_id,total_cents,status,vendor_bills(total_cents)").eq("org_id", context.orgId).in("project_id", ids).in("status", ["approved","executed"]),
  ])
  if (invoiceResult.error || billResult.error || commitmentResult.error) throw new Error(`Failed to load cash flow: ${invoiceResult.error?.message ?? billResult.error?.message ?? commitmentResult.error?.message}`)
  const buckets = new Map<string, { inflow_cents: number; outflow_cents: number; committed_unbilled_cents: number }>()
  const bucket = (key: string) => { const value = buckets.get(key) ?? { inflow_cents: 0, outflow_cents: 0, committed_unbilled_cents: 0 }; buckets.set(key, value); return value }
  for (const invoice of invoiceResult.data ?? []) bucket(month(invoice.due_date)).inflow_cents += Number(invoice.balance_due_cents ?? invoice.total_cents ?? 0)
  for (const bill of billResult.data ?? []) bucket(month(bill.due_date)).outflow_cents += Math.max(0, Number(bill.total_cents ?? 0) - Number(bill.paid_cents ?? 0))
  const projectById = new Map((projects ?? []).map((project) => [project.id, project]))
  for (const commitment of commitmentResult.data ?? []) {
    const billed = (commitment.vendor_bills ?? []).reduce((sum, bill) => sum + Number(bill.total_cents ?? 0), 0)
    const unbilled = Math.max(0, Number(commitment.total_cents ?? 0) - billed)
    const project = projectById.get(commitment.project_id)
    bucket(month(project?.end_date)).committed_unbilled_cents += unbilled
  }
  const months = Array.from(buckets.keys()).sort()
  return { months, rows: months.map((key) => { const value = bucket(key); return { month: key, ...value, net_cents: value.inflow_cents - value.outflow_cents - value.committed_unbilled_cents } }) }
}
