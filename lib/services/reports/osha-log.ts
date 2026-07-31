import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"

export async function getOshaLog(input: { year: number; projectId?: string; orgId?: string }) {
  const context = await requireOrgContext(input.orgId)
  await requirePermission("report.read", context)
  let query = context.supabase.from("safety_incidents").select("id,project_id,incident_number,occurred_at,employee_name,employee_job_title,location,description,date_of_death,days_away_from_work,days_job_transfer_restriction,osha_case_type,injury_illness_type,status,project:projects(name)").eq("org_id", context.orgId).eq("is_osha_recordable", true).gte("occurred_at", `${input.year}-01-01T00:00:00.000Z`).lt("occurred_at", `${input.year + 1}-01-01T00:00:00.000Z`).order("occurred_at")
  if (input.projectId) query = query.eq("project_id", input.projectId)
  const { data, error } = await query.limit(1000)
  if (error) throw new Error(`Failed to load OSHA log: ${error.message}`)
  const rows = data ?? []
  return {
    year: input.year,
    rows,
    summary: {
      total_cases: rows.length,
      deaths: rows.filter((row) => row.osha_case_type === "death").length,
      days_away_cases: rows.filter((row) => row.osha_case_type === "days_away").length,
      transfer_restriction_cases: rows.filter((row) => row.osha_case_type === "job_transfer_restriction").length,
      total_days_away: rows.reduce((sum, row) => sum + Number(row.days_away_from_work ?? 0), 0),
      total_restricted_days: rows.reduce((sum, row) => sum + Number(row.days_job_transfer_restriction ?? 0), 0),
    },
  }
}
