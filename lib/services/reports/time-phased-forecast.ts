import { distributeForecastAcrossMonths, type ForecastCurve } from "@/lib/financials/forecasting"
import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"
import { getForecastReport } from "@/lib/services/reports/forecast-ctc"

export async function getTimePhasedForecast(input: { projectId: string; curve?: ForecastCurve; orgId?: string }) {
  const context = await requireOrgContext(input.orgId)
  await requirePermission("report.read", context)
  const { data: project } = await context.supabase.from("projects").select("id,name,start_date,end_date").eq("org_id", context.orgId).eq("id", input.projectId).maybeSingle()
  if (!project) throw new Error("Project not found")
  const start = project.start_date ?? new Date().toISOString().slice(0, 10)
  const end = project.end_date ?? new Date(Date.now() + 180 * 86_400_000).toISOString().slice(0, 10)
  const forecast = await getForecastReport({ projectId: input.projectId, orgId: context.orgId })
  const rows = forecast.rows.map((row, index) => ({
    key: row.cost_code_id ?? `uncoded-${index}`,
    cost_code: row.cost_code_code ?? "Uncoded",
    name: row.cost_code_name ?? "Uncoded cost",
    ctc_cents: row.estimate_remaining_cents,
    months: distributeForecastAcrossMonths({ start, end, amount_cents: row.estimate_remaining_cents, curve: input.curve ?? "linear" }),
  }))
  const months = Array.from(new Set(rows.flatMap((row) => Object.keys(row.months)))).sort()
  return { project, start, end, months, rows }
}
