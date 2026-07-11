import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

export interface PortalDailyLogSubmission {
  id: string
  date: string
  narrative?: string
  company: string
  trade?: string
  workers: number
  hours?: number
  created_at: string
  photo_file_id?: string
}

export async function listPortalDailyLogSubmissions({ orgId, projectId, companyId }: { orgId: string; projectId: string; companyId: string }): Promise<PortalDailyLogSubmission[]> {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("daily_logs")
    .select("id, log_date, summary, created_at, daily_report_id, manpower:daily_reports(daily_report_manpower(company, trade, workers, hours, portal_company_id)), photos:files(id)")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .eq("portal_company_id", companyId)
    .order("log_date", { ascending: false })
    .limit(31)
  if (error) throw new Error(`Failed to load daily logs: ${error.message}`)
  return (data ?? []).map((row: any) => {
    const manpowerRows = row.manpower?.daily_report_manpower ?? []
    const manpower = manpowerRows.find((item: any) => item.portal_company_id === companyId) ?? manpowerRows[0]
    return { id: row.id, date: row.log_date, narrative: row.summary ?? undefined, company: manpower?.company ?? "Subcontractor", trade: manpower?.trade ?? undefined, workers: manpower?.workers ?? 0, hours: manpower?.hours == null ? undefined : Number(manpower.hours), created_at: row.created_at, photo_file_id: row.photos?.[0]?.id }
  })
}

export async function createPortalDailyLogSubmission({ orgId, projectId, companyId, portalTokenId, companyName, date, narrative, trade, workers, hours }: { orgId: string; projectId: string; companyId: string; portalTokenId: string; companyName: string; date: string; narrative?: string; trade?: string; workers: number; hours?: number }): Promise<PortalDailyLogSubmission> {
  const supabase = createServiceSupabaseClient()
  const { data: existing } = await supabase.from("daily_reports").select("id, status").eq("org_id", orgId).eq("project_id", projectId).eq("report_date", date).maybeSingle()
  if (existing?.status === "submitted") throw new Error("The GC has already submitted and locked this day's report")
  let reportId = existing?.id as string | undefined
  if (!reportId) {
    const { data: created, error } = await supabase.from("daily_reports").insert({ org_id: orgId, project_id: projectId, report_date: date, status: "draft", created_via_portal: true, portal_company_id: companyId }).select("id").single()
    if (error || !created) {
      const { data: raced } = await supabase.from("daily_reports").select("id, status").eq("org_id", orgId).eq("project_id", projectId).eq("report_date", date).single()
      if (!raced || raced.status === "submitted") throw new Error("Unable to open this day's report")
      reportId = raced.id
    } else reportId = created.id
  }

  const { data: log, error: logError } = await supabase.from("daily_logs").insert({ org_id: orgId, project_id: projectId, log_date: date, summary: narrative?.trim() || null, daily_report_id: reportId, created_via_portal: true, portal_company_id: companyId }).select("id, created_at").single()
  if (logError || !log) throw new Error(`Failed to submit daily log: ${logError?.message}`)
  const { error: manpowerError } = await supabase.from("daily_report_manpower").insert({ org_id: orgId, project_id: projectId, daily_report_id: reportId, company: companyName, trade: trade?.trim() || null, workers, hours: hours ?? null, portal_company_id: companyId })
  if (manpowerError) throw new Error(`Failed to submit manpower: ${manpowerError.message}`)

  await recordEvent({ orgId, eventType: "daily_report.sub_submitted", entityType: "daily_log", entityId: log.id, payload: { project_id: projectId, daily_report_id: reportId, company_id: companyId, portal_token_id: portalTokenId } })
  await recordAudit({ orgId, action: "insert", entityType: "daily_log", entityId: log.id, after: { project_id: projectId, daily_report_id: reportId, company_id: companyId }, source: "sub_portal" })
  return { id: log.id, date, narrative: narrative?.trim() || undefined, company: companyName, trade: trade?.trim() || undefined, workers, hours, created_at: log.created_at }
}

export async function attachPortalDailyLogPhoto({ orgId, projectId, companyId, dailyLogId, fileId }: { orgId: string; projectId: string; companyId: string; dailyLogId: string; fileId: string }) {
  const supabase = createServiceSupabaseClient()
  const { error } = await supabase.from("files").update({ daily_log_id: dailyLogId, metadata: { uploaded_via_portal: true, company_id: companyId, daily_log_id: dailyLogId } }).eq("org_id", orgId).eq("project_id", projectId).eq("id", fileId)
  if (error) throw new Error(`Failed to attach daily-log photo: ${error.message}`)
}
