import "server-only"

import { createHash, randomBytes } from "node:crypto"
import { getProjectPosture, normalizeProductTier } from "@/lib/product-tier"
import { renderReportPdf } from "@/lib/pdfs/report"
import { reportToCsv, csvFilename } from "@/lib/reports/export-csv"
import { getReportDefinition, supportsFormat } from "@/lib/reports/registry"
import type { ReportContext, ReportFormat, ReportResult } from "@/lib/reports/types"
import { requireOrgContext, runWithServiceOrgContext } from "@/lib/services/context"
import { getOrgSenderEmail, renderStandardEmailLayout, sendEmail } from "@/lib/services/mailer"
import { getUserPermissions, requirePermission } from "@/lib/services/permissions"
import { recordReportRun } from "@/lib/services/report-runs"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { reportExportTokenSchema, reportScheduleSchema, savedReportConfigSchema } from "@/lib/validation/report-schedules"

type ConfigRow = {
  id: string; org_id: string; user_id: string; name: string; slug: string; scope: "org" | "project"
  project_id: string | null; division_id: string | null; community_id: string | null
  params: Record<string, string>; format: ReportFormat
}

export function nextScheduledRun(input: { cadence: "daily" | "weekly" | "monthly"; weekday?: number | null; month_day?: number | null; send_hour_utc: number }, from = new Date()) {
  const candidate = new Date(from)
  candidate.setUTCMinutes(0, 0, 0)
  candidate.setUTCHours(input.send_hour_utc)
  if (candidate <= from) candidate.setUTCDate(candidate.getUTCDate() + 1)
  if (input.cadence === "weekly") {
    const target = input.weekday ?? 1
    candidate.setUTCDate(candidate.getUTCDate() + ((target - candidate.getUTCDay() + 7) % 7))
  } else if (input.cadence === "monthly") {
    const day = input.month_day ?? 1
    candidate.setUTCDate(day)
    if (candidate <= from) candidate.setUTCMonth(candidate.getUTCMonth() + 1, day)
  }
  return candidate.toISOString()
}

export async function listSavedReportConfigs(orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requirePermission("report.read", context)
  const { data, error } = await context.supabase.from("saved_report_configs").select("*, schedules:report_schedules(*)").eq("org_id", context.orgId).eq("user_id", context.userId).order("updated_at", { ascending: false })
  if (error) throw new Error(`Failed to load saved reports: ${error.message}`)
  return data ?? []
}

export async function saveReportConfig(input: unknown, orgId?: string) {
  const parsed = savedReportConfigSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("report.read", context)
  const definition = getReportDefinition(parsed.slug)
  if (!definition || !definition.scopes.includes(parsed.scope) || !supportsFormat(definition, parsed.format)) throw new Error("Invalid report configuration.")
  const permissions = await getUserPermissions(context.userId, context.orgId)
  if (!permissions.includes("*") && !definition.permissions.some((key) => permissions.includes(key))) throw new Error("You do not have access to this report.")
  const { data, error } = await context.supabase.from("saved_report_configs").insert({ ...parsed, org_id: context.orgId, user_id: context.userId, project_id: parsed.project_id ?? null, division_id: parsed.division_id ?? null, community_id: parsed.community_id ?? null }).select("*").single()
  if (error) throw new Error(`Failed to save report: ${error.message}`)
  return data
}

export async function createReportSchedule(input: unknown, orgId?: string) {
  const parsed = reportScheduleSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("report.schedule", context)
  const { data: config } = await context.supabase.from("saved_report_configs").select("id").eq("org_id", context.orgId).eq("id", parsed.saved_config_id).maybeSingle()
  if (!config) throw new Error("Saved report not found.")
  const { data, error } = await context.supabase.from("report_schedules").insert({ ...parsed, org_id: context.orgId, created_by: context.userId, weekday: parsed.weekday ?? null, month_day: parsed.month_day ?? null, next_run_at: nextScheduledRun(parsed) }).select("*").single()
  if (error) throw new Error(`Failed to schedule report: ${error.message}`)
  return data
}

export async function createReportExportToken(input: unknown, orgId?: string) {
  const parsed = reportExportTokenSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("report.export.manage", context)
  const token = `arc_report_${randomBytes(30).toString("base64url")}`
  const { data, error } = await context.supabase.from("report_export_tokens").insert({ org_id: context.orgId, name: parsed.name, token_hash: createHash("sha256").update(token).digest("hex"), created_by: context.userId, expires_at: parsed.expires_at ?? null }).select("id,name,expires_at,created_at").single()
  if (error) throw new Error(`Failed to create export token: ${error.message}`)
  return { ...data, token }
}

async function buildReport(config: ConfigRow, actorId: string): Promise<{ definition: NonNullable<ReturnType<typeof getReportDefinition>>; context: ReportContext; result: ReportResult }> {
  const client = createServiceSupabaseClient()
  const [{ data: org }, permissions] = await Promise.all([
    client.from("orgs").select("product_tier").eq("id", config.org_id).single(),
    getUserPermissions(actorId, config.org_id),
  ])
  const definition = getReportDefinition(config.slug)
  if (!definition || !definition.scopes.includes(config.scope) || !supportsFormat(definition, config.format)) throw new Error("Saved report is no longer available.")
  if (!permissions.includes("*") && !definition.permissions.some((key) => permissions.includes(key))) throw new Error("Saved report owner no longer has permission.")
  let project: { name: string; property_type: string | null } | null = null
  if (config.project_id) {
    const result = await client.from("projects").select("name,property_type").eq("org_id", config.org_id).eq("id", config.project_id).maybeSingle()
    project = result.data
    if (!project) throw new Error("Saved report project no longer exists.")
  }
  const tier = normalizeProductTier(org?.product_tier)
  const context: ReportContext = { scope: config.scope, projectId: config.project_id ?? undefined, projectName: project?.name, divisionId: config.division_id ?? undefined, communityId: config.community_id ?? undefined, scopeLabel: project?.name ?? "Organization-wide", posture: getProjectPosture(project?.property_type, tier), params: config.params ?? {} }
  return runWithServiceOrgContext({ supabase: client, orgId: config.org_id, userId: actorId, productTier: tier }, async () => ({ definition, context, result: await definition.run(context) }))
}

export async function processDueReportSchedules(limit = 20) {
  const client = createServiceSupabaseClient()
  const now = new Date().toISOString()
  const { data, error } = await client.from("report_schedules").select("*, config:saved_report_configs(*)").eq("is_active", true).lte("next_run_at", now).order("next_run_at").limit(limit)
  if (error) throw new Error(`Failed to claim report schedules: ${error.message}`)
  const outcomes: Array<{ id: string; ok: boolean; error?: string }> = []
  for (const row of data ?? []) {
    const config = (Array.isArray(row.config) ? row.config[0] : row.config) as ConfigRow | null
    try {
      if (!config || !row.created_by) throw new Error("Schedule has no active owner.")
      const { definition, context, result } = await buildReport(config, row.created_by)
      const format = config.format
      let content: string
      let filename: string
      let contentType: string
      if (format === "pdf") {
        const pdf = await renderReportPdf({ title: definition.title, provenance: result.subtitle ?? context.scopeLabel, result, branding: { org_name: null, org_logo_url: null } })
        content = Buffer.from(pdf).toString("base64"); filename = csvFilename(definition.slug, result.subtitle).replace(/\.csv$/, ".pdf"); contentType = "application/pdf"
      } else if (format === "json") {
        content = Buffer.from(JSON.stringify({ slug: definition.slug, params: context.params, result }, null, 2)).toString("base64"); filename = `${definition.slug}.json`; contentType = "application/json"
      } else {
        content = Buffer.from(reportToCsv(result)).toString("base64"); filename = csvFilename(definition.slug, result.subtitle); contentType = "text/csv"
      }
      const html = renderStandardEmailLayout({ title: definition.title, messageHtml: `<p>Your scheduled report is attached.</p><p>${result.subtitle ?? context.scopeLabel}</p>`, showManageSettings: false })
      const sent = await sendEmail({ from: getOrgSenderEmail(), to: row.recipient_emails, subject: `Scheduled report: ${definition.title}`, html, attachments: [{ filename, content, contentType }] })
      if (!sent) throw new Error("Report email was not sent.")
      await runWithServiceOrgContext({ supabase: client, orgId: config.org_id, userId: row.created_by, productTier: normalizeProductTier(undefined) }, () => recordReportRun({ slug: definition.slug, context, title: definition.title, result, format, orgId: config.org_id }))
      await client.from("report_schedules").update({ last_run_at: now, next_run_at: nextScheduledRun(row, new Date()) }).eq("org_id", config.org_id).eq("id", row.id)
      outcomes.push({ id: row.id, ok: true })
    } catch (cause) {
      outcomes.push({ id: row.id, ok: false, error: cause instanceof Error ? cause.message : String(cause) })
    }
  }
  return outcomes
}

export async function resolveReportExportToken(rawToken: string) {
  const client = createServiceSupabaseClient()
  const hash = createHash("sha256").update(rawToken).digest("hex")
  const { data } = await client.from("report_export_tokens").select("*").eq("token_hash", hash).is("revoked_at", null).maybeSingle()
  if (!data || (data.expires_at && new Date(data.expires_at) <= new Date()) || !data.created_by) return null
  await client.from("report_export_tokens").update({ last_used_at: new Date().toISOString() }).eq("id", data.id).eq("org_id", data.org_id)
  return { orgId: data.org_id as string, actorId: data.created_by as string }
}

export async function runTokenReport(input: { orgId: string; actorId: string; slug: string; projectId?: string; params: Record<string, string>; format: ReportFormat }) {
  const config: ConfigRow = { id: "token", org_id: input.orgId, user_id: input.actorId, name: "API export", slug: input.slug, scope: input.projectId ? "project" : "org", project_id: input.projectId ?? null, division_id: null, community_id: null, params: input.params, format: input.format }
  return buildReport(config, input.actorId)
}
