import "server-only"

import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { persistGeneratedProjectPdf } from "@/lib/services/generated-project-pdfs"
import { requirePermission } from "@/lib/services/permissions"
import { insertWithProjectNumberRetry } from "@/lib/services/project-sequence"
import { toCsv } from "@/lib/services/reports/csv"
import { renderCertifiedPayrollPdf } from "@/lib/pdfs/certified-payroll"
import {
  certifiedPayrollLineUpdateSchema,
  createCertifiedPayrollSchema,
  wageClassificationInputSchema,
  wageDeterminationInputSchema,
  workerProfileInputSchema,
  type CertifiedPayrollLineUpdate,
  type CreateCertifiedPayrollInput,
  type WageClassificationInput,
  type WageDeterminationInput,
  type WorkerProfileInput,
} from "@/lib/validation/certified-payroll"

const APPROVED_TIME_STATUSES = ["pm_approved", "client_approved", "locked"]
const REPORT_SELECT = "id, org_id, project_id, payroll_number, week_ending, status, is_no_work, is_final, pdf_file_id, finalized_at, finalized_by, created_at, updated_at"
const LINE_SELECT = "id, org_id, report_id, worker_profile_id, classification_id, day_hours, st_rate_cents, ot_rate_cents, fringe_rate_cents, gross_this_project_cents, gross_all_projects_cents, deductions, net_pay_cents, created_at, updated_at"

export type WageDetermination = {
  id: string; org_id: string; project_id: string; determination_number: string; source: string | null
  effective_date: string | null; created_at: string; updated_at: string
}
export type WageClassification = {
  id: string; org_id: string; determination_id: string; classification: string
  base_rate_cents: number; fringe_rate_cents: number; created_at: string; updated_at: string
}
export type PayrollWorkerProfile = {
  id: string; org_id: string; user_id: string | null; display_name: string; address: string | null
  tax_id_last4: string | null; default_classification_id: string | null; fringe_paid_in_cash: boolean
  is_active: boolean; created_at: string; updated_at: string
}
export type PayrollDayHours = Record<string, { st: number; ot: number; dt: number }>
export type CertifiedPayrollLine = {
  id: string; org_id: string; report_id: string; worker_profile_id: string; classification_id: string | null
  day_hours: PayrollDayHours; st_rate_cents: number; ot_rate_cents: number; fringe_rate_cents: number
  gross_this_project_cents: number; gross_all_projects_cents: number | null
  deductions: Record<string, number> | null; net_pay_cents: number | null; created_at: string; updated_at: string
  worker: PayrollWorkerProfile; classification: WageClassification | null
}
export type CertifiedPayrollReport = {
  id: string; org_id: string; project_id: string; payroll_number: number; week_ending: string
  status: "draft" | "finalized"; is_no_work: boolean; is_final: boolean; pdf_file_id: string | null
  finalized_at: string | null; finalized_by: string | null; created_at: string; updated_at: string
}
export type CertifiedPayrollDetail = CertifiedPayrollReport & { lines: CertifiedPayrollLine[] }

function relationOne<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null
}

function normalizedName(value: string) {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, " ")
}

function weekStart(weekEnding: string) {
  const date = new Date(`${weekEnding}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() - 6)
  return date.toISOString().slice(0, 10)
}

function totals(dayHours: PayrollDayHours) {
  return Object.values(dayHours).reduce((sum, day) => ({
    st: sum.st + Number(day.st || 0),
    ot: sum.ot + Number(day.ot || 0),
    dt: sum.dt + Number(day.dt || 0),
  }), { st: 0, ot: 0, dt: 0 })
}

function snapshotMoney(dayHours: PayrollDayHours, classification: WageClassification) {
  const hours = totals(dayHours)
  const stRate = classification.base_rate_cents
  const otRate = Math.round(classification.base_rate_cents * 1.5)
  const dtRate = classification.base_rate_cents * 2
  const allHours = hours.st + hours.ot + hours.dt
  return {
    st_rate_cents: stRate,
    ot_rate_cents: otRate,
    fringe_rate_cents: classification.fringe_rate_cents,
    gross_this_project_cents: Math.round(
      hours.st * stRate + hours.ot * otRate + hours.dt * dtRate + allHours * classification.fringe_rate_cents,
    ),
  }
}

async function requirePayrollWrite(orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requirePermission("payroll.write", { supabase: context.supabase, orgId: context.orgId, userId: context.userId })
  return context
}

export async function listWageDeterminations(projectId: string, orgId?: string): Promise<WageDetermination[]> {
  const { supabase, orgId: resolvedOrgId } = await requirePayrollWrite(orgId)
  const { data, error } = await supabase.from("wage_determinations").select("*").eq("org_id", resolvedOrgId).eq("project_id", projectId).order("effective_date", { ascending: false, nullsFirst: false })
  if (error) throw new Error(`Failed to load wage determinations: ${error.message}`)
  return data ?? []
}

export async function listWageClassifications(projectId: string, orgId?: string): Promise<WageClassification[]> {
  const { supabase, orgId: resolvedOrgId } = await requirePayrollWrite(orgId)
  const { data, error } = await supabase.from("wage_classifications").select("*, wage_determinations!inner(project_id)").eq("org_id", resolvedOrgId).eq("wage_determinations.project_id", projectId).order("classification")
  if (error) throw new Error(`Failed to load wage classifications: ${error.message}`)
  return (data ?? []).map(({ wage_determinations: _determination, ...row }) => row as WageClassification)
}

export async function listPayrollWorkerProfiles(orgId?: string): Promise<PayrollWorkerProfile[]> {
  const { supabase, orgId: resolvedOrgId } = await requirePayrollWrite(orgId)
  const { data, error } = await supabase.from("payroll_worker_profiles").select("*").eq("org_id", resolvedOrgId).order("is_active", { ascending: false }).order("display_name")
  if (error) throw new Error(`Failed to load payroll workers: ${error.message}`)
  return data ?? []
}

export async function createWageDetermination(input: WageDeterminationInput, orgId?: string) {
  const parsed = wageDeterminationInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requirePayrollWrite(orgId)
  const { data, error } = await supabase.from("wage_determinations").insert({ org_id: resolvedOrgId, ...parsed }).select("*").single()
  if (error || !data) throw new Error(`Failed to create wage determination: ${error?.message}`)
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "insert", entityType: "wage_determination", entityId: data.id, after: data })
  return data as WageDetermination
}

export async function createWageClassification(input: WageClassificationInput, orgId?: string) {
  const parsed = wageClassificationInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requirePayrollWrite(orgId)
  const { data: determination } = await supabase.from("wage_determinations").select("id").eq("org_id", resolvedOrgId).eq("id", parsed.determination_id).maybeSingle()
  if (!determination) throw new Error("Wage determination not found")
  const { data, error } = await supabase.from("wage_classifications").insert({ org_id: resolvedOrgId, ...parsed }).select("*").single()
  if (error || !data) throw new Error(`Failed to create classification: ${error?.message}`)
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "insert", entityType: "wage_classification", entityId: data.id, after: data })
  return data as WageClassification
}

export async function savePayrollWorkerProfile(input: WorkerProfileInput, profileId?: string, orgId?: string) {
  const parsed = workerProfileInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requirePayrollWrite(orgId)
  const payload = { org_id: resolvedOrgId, ...parsed }
  const query = profileId
    ? supabase.from("payroll_worker_profiles").update(payload).eq("org_id", resolvedOrgId).eq("id", profileId)
    : supabase.from("payroll_worker_profiles").insert(payload)
  const { data, error } = await query.select("*").single()
  if (error || !data) throw new Error(`Failed to save payroll worker: ${error?.message}`)
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: profileId ? "update" : "insert", entityType: "payroll_worker_profile", entityId: data.id, after: data })
  return data as PayrollWorkerProfile
}

export async function listCertifiedPayrollReports(projectId: string, orgId?: string): Promise<CertifiedPayrollReport[]> {
  const { supabase, orgId: resolvedOrgId } = await requirePayrollWrite(orgId)
  const { data, error } = await supabase.from("certified_payroll_reports").select(REPORT_SELECT).eq("org_id", resolvedOrgId).eq("project_id", projectId).order("payroll_number", { ascending: false }).limit(250)
  if (error) throw new Error(`Failed to load certified payroll: ${error.message}`)
  return (data ?? []) as CertifiedPayrollReport[]
}

export async function getCertifiedPayrollReport(reportId: string, orgId?: string): Promise<CertifiedPayrollDetail> {
  const { supabase, orgId: resolvedOrgId } = await requirePayrollWrite(orgId)
  const [{ data: report, error }, { data: lines, error: linesError }] = await Promise.all([
    supabase.from("certified_payroll_reports").select(REPORT_SELECT).eq("org_id", resolvedOrgId).eq("id", reportId).single(),
    supabase.from("certified_payroll_lines").select(`${LINE_SELECT}, worker:payroll_worker_profiles(*), classification:wage_classifications(*)`).eq("org_id", resolvedOrgId).eq("report_id", reportId).order("created_at"),
  ])
  if (error || !report) throw new Error("Certified payroll report not found")
  if (linesError) throw new Error(`Failed to load payroll lines: ${linesError.message}`)
  const mappedLines = (lines ?? []).map((line) => ({
    ...line,
    worker: relationOne(line.worker),
    classification: relationOne(line.classification),
  }))
  return { ...report, lines: mappedLines } as CertifiedPayrollDetail
}

export async function createCertifiedPayrollReport(input: CreateCertifiedPayrollInput, orgId?: string): Promise<CertifiedPayrollDetail> {
  const parsed = createCertifiedPayrollSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requirePayrollWrite(orgId)
  const [{ data: project }, { data: existing }] = await Promise.all([
    supabase.from("projects").select("id, is_public_work").eq("org_id", resolvedOrgId).eq("id", parsed.project_id).maybeSingle(),
    supabase.from("certified_payroll_reports").select("id").eq("org_id", resolvedOrgId).eq("project_id", parsed.project_id).eq("week_ending", parsed.week_ending).maybeSingle(),
  ])
  if (!project?.is_public_work) throw new Error("Enable Public work / prevailing wage in project settings first")
  if (existing) return getCertifiedPayrollReport(existing.id, resolvedOrgId)

  const { data: report } = await insertWithProjectNumberRetry<CertifiedPayrollReport>({
    supabase, table: "certified_payroll_reports", numberColumn: "payroll_number",
    rpcName: "next_certified_payroll_number", conflictConstraint: "certified_payroll_reports_project_id_payroll_number_key",
    projectId: parsed.project_id, entityLabel: "certified payroll report", select: REPORT_SELECT,
    payload: { org_id: resolvedOrgId, project_id: parsed.project_id, week_ending: parsed.week_ending, is_no_work: parsed.is_no_work, is_final: parsed.is_final },
  })

  if (!parsed.is_no_work) {
    const [{ data: timeEntries, error: timeError }, classifications, profiles] = await Promise.all([
      supabase.from("time_entries").select("worker_user_id, worker_name, work_date, hours, is_overtime, is_double_time").eq("org_id", resolvedOrgId).eq("project_id", parsed.project_id).in("status", APPROVED_TIME_STATUSES).gte("work_date", weekStart(parsed.week_ending)).lte("work_date", parsed.week_ending).order("work_date"),
      listWageClassifications(parsed.project_id, resolvedOrgId),
      listPayrollWorkerProfiles(resolvedOrgId),
    ])
    if (timeError) throw new Error(`Failed to load approved time: ${timeError.message}`)
    if (!classifications.length && (timeEntries?.length ?? 0) > 0) throw new Error("Add at least one wage classification before drafting payroll")

    const profilesByUser = new Map(profiles.filter((profile) => profile.user_id).map((profile) => [profile.user_id as string, profile]))
    const profilesByName = new Map(profiles.filter((profile) => !profile.user_id).map((profile) => [normalizedName(profile.display_name), profile]))
    const groups = new Map<string, { userId: string | null; name: string; dayHours: PayrollDayHours }>()
    for (const entry of timeEntries ?? []) {
      const key = entry.worker_user_id ? `user:${entry.worker_user_id}` : `name:${normalizedName(entry.worker_name)}`
      const group = groups.get(key) ?? { userId: entry.worker_user_id ?? null, name: entry.worker_name, dayHours: {} as PayrollDayHours }
      const workDate = String(entry.work_date)
      const day = group.dayHours[workDate] ?? { st: 0, ot: 0, dt: 0 }
      const hours = Number(entry.hours)
      if (entry.is_double_time) day.dt += hours
      else if (entry.is_overtime) day.ot += hours
      else day.st += hours
      group.dayHours[workDate] = day
      groups.set(key, group)
    }

    const lines: Record<string, unknown>[] = []
    for (const group of groups.values()) {
      let profile = group.userId ? profilesByUser.get(group.userId) : profilesByName.get(normalizedName(group.name))
      if (!profile) {
        const { data: created, error: profileError } = await supabase.from("payroll_worker_profiles").insert({ org_id: resolvedOrgId, user_id: group.userId, display_name: group.name }).select("*").single()
        if (profileError || !created) throw new Error(`Failed to seed worker profile: ${profileError?.message}`)
        profile = created as PayrollWorkerProfile
      }
      const classification = classifications.find((item) => item.id === profile?.default_classification_id) ?? classifications[0]
      if (!profile || !classification) throw new Error(`Assign a classification to ${group.name}`)
      lines.push({ org_id: resolvedOrgId, report_id: report.id, worker_profile_id: profile.id, classification_id: classification.id, day_hours: group.dayHours, ...snapshotMoney(group.dayHours, classification) })
    }
    if (lines.length) {
      const { error: lineError } = await supabase.from("certified_payroll_lines").insert(lines)
      if (lineError) throw new Error(`Failed to create payroll lines: ${lineError.message}`)
    }
  }

  await Promise.all([
    recordEvent({ orgId: resolvedOrgId, actorId: userId, eventType: "certified_payroll_created", entityType: "certified_payroll_report", entityId: report.id, payload: { project_id: parsed.project_id, payroll_number: report.payroll_number, week_ending: parsed.week_ending } }),
    recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "insert", entityType: "certified_payroll_report", entityId: report.id, after: report }),
  ])
  return getCertifiedPayrollReport(report.id, resolvedOrgId)
}

export async function updateCertifiedPayrollLine(lineId: string, input: CertifiedPayrollLineUpdate, orgId?: string) {
  const parsed = certifiedPayrollLineUpdateSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requirePayrollWrite(orgId)
  const { data: existing } = await supabase.from("certified_payroll_lines").select(`${LINE_SELECT}, report:certified_payroll_reports(status)`).eq("org_id", resolvedOrgId).eq("id", lineId).single()
  const report = Array.isArray(existing?.report) ? existing.report[0] : existing?.report
  if (!existing || report?.status !== "draft") throw new Error("Finalized payroll reports are locked")
  const update: Record<string, unknown> = { ...parsed }
  if (parsed.classification_id) {
    const { data: classification } = await supabase.from("wage_classifications").select("*").eq("org_id", resolvedOrgId).eq("id", parsed.classification_id).single()
    if (!classification) throw new Error("Classification not found")
    Object.assign(update, snapshotMoney(existing.day_hours as PayrollDayHours, classification as WageClassification))
  }
  const { data, error } = await supabase.from("certified_payroll_lines").update(update).eq("org_id", resolvedOrgId).eq("id", lineId).select(LINE_SELECT).single()
  if (error || !data) throw new Error(`Failed to update payroll line: ${error?.message}`)
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "certified_payroll_line", entityId: lineId, before: existing, after: data })
  return data
}

export async function finalizeCertifiedPayroll(reportId: string, orgId?: string): Promise<CertifiedPayrollDetail> {
  const { supabase, orgId: resolvedOrgId, userId } = await requirePayrollWrite(orgId)
  const detail = await getCertifiedPayrollReport(reportId, resolvedOrgId)
  if (detail.status === "finalized") return detail
  const [{ data: project }, { data: org }] = await Promise.all([
    supabase.from("projects").select("name, location").eq("org_id", resolvedOrgId).eq("id", detail.project_id).single(),
    supabase.from("orgs").select("name, address").eq("id", resolvedOrgId).single(),
  ])
  const pdf = await renderCertifiedPayrollPdf({ report: detail, projectName: project?.name ?? "Project", contractorName: org?.name ?? "Contractor", contractorAddress: typeof org?.address === "string" ? org.address : null })
  const fileName = `certified-payroll-${String(detail.payroll_number).padStart(3, "0")}-${detail.week_ending}.pdf`
  const file = await persistGeneratedProjectPdf({ supabase, orgId: resolvedOrgId, projectId: detail.project_id, fileName, pdf, category: "other", folderPath: "Certified Payroll", description: `Certified payroll #${detail.payroll_number}, week ending ${detail.week_ending}` })
  const finalizedAt = new Date().toISOString()
  const { error } = await supabase.from("certified_payroll_reports").update({ status: "finalized", finalized_at: finalizedAt, finalized_by: userId, pdf_file_id: file.id }).eq("org_id", resolvedOrgId).eq("id", reportId).eq("status", "draft")
  if (error) throw new Error(`Failed to finalize certified payroll: ${error.message}`)
  await Promise.all([
    recordEvent({ orgId: resolvedOrgId, actorId: userId, eventType: "certified_payroll_finalized", entityType: "certified_payroll_report", entityId: reportId, payload: { project_id: detail.project_id, payroll_number: detail.payroll_number, pdf_file_id: file.id } }),
    recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "certified_payroll_report", entityId: reportId, before: detail, after: { ...detail, status: "finalized", finalized_at: finalizedAt, finalized_by: userId, pdf_file_id: file.id } }),
  ])
  return getCertifiedPayrollReport(reportId, resolvedOrgId)
}

export async function certifiedPayrollRegisterCsv(projectId: string, orgId?: string) {
  const reports = await listCertifiedPayrollReports(projectId, orgId)
  return toCsv(reports, [
    { key: "payroll_number", header: "Payroll #" }, { key: "week_ending", header: "Week ending" },
    { key: "status", header: "Status" }, { key: "is_no_work", header: "No work" }, { key: "is_final", header: "Final payroll" },
  ])
}
