import type { DailyLog } from "@/lib/types"
import type { DailyLogInput } from "@/lib/validation/daily-logs"
import { recordEvent } from "@/lib/services/events"
import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"

function mapDailyLog(row: any): DailyLog {
  const weather = row.weather ?? {}
  const summary = row.summary ?? undefined
  const weatherText =
    typeof weather === "string"
      ? weather
      : [weather.conditions, weather.temperature, weather.notes].filter(Boolean).join(" • ")

  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id,
    date: row.log_date,
    weather: weatherText || undefined,
    notes: summary,
    created_by: row.created_by ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

export async function listDailyLogs(orgId?: string): Promise<DailyLog[]> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("daily_logs")
    .select("id, org_id, project_id, log_date, summary, weather, created_by, created_at, updated_at")
    .eq("org_id", resolvedOrgId)
    .order("log_date", { ascending: false })
    .limit(50)

  if (error) {
    throw new Error(`Failed to list daily logs: ${error.message}`)
  }

  return (data ?? []).map(mapDailyLog)
}

export async function createDailyLog({ input, orgId }: { input: DailyLogInput; orgId?: string }) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("daily_logs")
    .insert({
      org_id: resolvedOrgId,
      project_id: input.project_id,
      log_date: input.date,
      summary: input.summary,
      weather: input.weather,
      created_by: userId,
    })
    .select("id, org_id, project_id, log_date, summary, weather, created_by, created_at, updated_at")
    .single()

  if (error || !data) {
    throw new Error(`Failed to create daily log: ${error?.message}`)
  }

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "daily_log_created",
    entityType: "daily_log",
    entityId: data.id as string,
    payload: { project_id: input.project_id, summary: input.summary },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "daily_log",
    entityId: data.id as string,
    after: data,
  })

  return mapDailyLog(data)
}
