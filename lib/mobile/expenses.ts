import { getAccountingSyncStates } from "@/lib/services/accounting-sync-state"
import { z } from "zod"

import { MobileAPIError } from "@/lib/mobile/api"
import type { MobileOrgContext } from "@/lib/mobile/auth"
import type { MobileExpenseDTO, MobileReceiptScanDTO } from "@/lib/mobile/contracts"
import { OVERHEAD_CATEGORIES, expenseHome, expenseHomeLabel, suggestJobFromClock } from "@/lib/financials/overhead"
import { hasPermission } from "@/lib/services/permissions"
import { listProjects } from "@/lib/services/projects"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { uploadCostPlusFile } from "@/lib/services/cost-plus-files"
import { extractExpenseReceiptFromFile } from "@/lib/services/document-extraction"
import { createFilesDownloadUrl } from "@/lib/storage/files-storage"

const PAYMENT_METHODS = [
  "cash",
  "credit_card",
  "check",
  "ach",
  "company_card",
  "reimbursable_personal",
  "other",
] as const

/**
 * A capture on no job still files a receipt and a submitted expense the office
 * must approve (bill.approve), so the phone asks for the receipt-filing key crew
 * and foremen hold, not bill.write, which they do not. A member who cannot file
 * documents cannot capture.
 */
async function requireOrgExpenseCapture(context: MobileOrgContext) {
  if (context.isPlatformAdmin) return
  const allowed = await hasPermission("docs.upload", {
    supabase: context.serviceSupabase,
    orgId: context.orgId,
    userId: context.user.id,
  })
  if (!allowed) throw new MobileAPIError(403, "expenses_forbidden", "You do not have access to record expenses that are not on a job.")
}

async function requireProject(context: MobileOrgContext, projectId: string) {
  const project = (await listProjects(context.orgId, context.serviceContext)).find((item) => item.id === projectId)
  if (!project) throw new MobileAPIError(404, "project_not_found", "Project not found.")
  return project
}

const EXPENSE_SELECT =
  "id, project_id, overhead_category, vendor_name_text, description, expense_date, amount_cents, tax_cents, payment_method, status, receipt_file_id, created_at, receipt:files!project_expenses_receipt_file_id_fkey(id, file_name, storage_path)"

const LIST_CAP = 100

async function receiptUrl(context: MobileOrgContext, file: any): Promise<string | null> {
  if (!file?.storage_path) return null
  try {
    const signed = await createFilesDownloadUrl({
      supabase: context.serviceSupabase,
      orgId: context.orgId,
      path: file.storage_path,
      fileName: file.file_name ?? "receipt",
      expiresIn: 3_600,
    })
    return signed.downloadUrl
  } catch (error) {
    console.error("Mobile expense receipt URL failed", { fileId: file.id, error })
    return null
  }
}

function mapExpense(row: any, url: string | null, projectName: string | null): MobileExpenseDTO {
  const projectId: string | null = row.project_id ?? null
  const overheadCategory: string | null = row.overhead_category ?? null
  return {
    id: row.id,
    project_id: projectId,
    overhead_category: overheadCategory,
    home_label: expenseHomeLabel(expenseHome({ project_id: projectId, overhead_category: overheadCategory }), projectName),
    vendor_name: row.vendor_name_text ?? null,
    description: row.description ?? null,
    expense_date: row.expense_date ?? null,
    amount_cents: Number(row.amount_cents ?? 0),
    tax_cents: Number(row.tax_cents ?? 0),
    payment_method: row.payment_method ?? null,
    status: row.status ?? "submitted",
    receipt_url: url,
    created_at: row.created_at,
    accounting_sync_status: row.accounting_sync_status ?? null,
  }
}

async function mapExpenseRows(context: MobileOrgContext, rows: any[], projectNames: Map<string, string>) {
  const states = await getAccountingSyncStates(context.serviceSupabase, { orgId: context.orgId, entityType: "project_expense", entityIds: rows.map((row) => row.id) })
  return Promise.all(
    rows.map(async (row) => {
      const file = Array.isArray(row.receipt) ? row.receipt[0] : row.receipt
      return mapExpense({ ...row, accounting_sync_status: states.get(row.id)?.status ?? null }, await receiptUrl(context, file), projectNames.get(row.project_id) ?? null)
    }),
  )
}

export async function listMobileExpenses(context: MobileOrgContext, projectId: string): Promise<MobileExpenseDTO[]> {
  const project = await requireProject(context, projectId)
  const { data, error } = await context.serviceSupabase
    .from("project_expenses")
    .select(EXPENSE_SELECT)
    .eq("org_id", context.orgId)
    .eq("project_id", projectId)
    .order("expense_date", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(200)
  if (error) throw new MobileAPIError(500, "expenses_unavailable", "Expenses could not be loaded.")
  return mapExpenseRows(context, data ?? [], new Map([[project.id, project.name]]))
}

/** The caller's own recent expenses across jobs and unsorted, newest first. */
export async function listMyMobileExpenses(context: MobileOrgContext): Promise<MobileExpenseDTO[]> {
  const [projects, result] = await Promise.all([
    listProjects(context.orgId, context.serviceContext),
    context.serviceSupabase
      .from("project_expenses")
      .select(EXPENSE_SELECT)
      .eq("org_id", context.orgId)
      .eq("submitted_by_user_id", context.user.id)
      .order("created_at", { ascending: false })
      .limit(LIST_CAP),
  ])
  if (result.error) throw new MobileAPIError(500, "expenses_unavailable", "Expenses could not be loaded.")
  return mapExpenseRows(context, result.data ?? [], new Map(projects.map((project) => [project.id, project.name])))
}

const createSchema = z
  .object({
  client_id: z.string().uuid(),
  project_id: z.string().uuid().nullish(),
  overhead_category: z.enum(OVERHEAD_CATEGORIES).nullish(),
  expense_date: z.string().date(),
  amount_dollars: z.number().positive().max(10_000_000),
  tax_dollars: z.number().nonnegative().max(10_000_000).optional(),
  vendor_name: z.string().trim().max(250).optional(),
  payment_method: z.enum(PAYMENT_METHODS).optional(),
  description: z.string().trim().max(5_000).optional(),
  })
  .refine((value) => !(value.project_id && value.overhead_category), {
    message: "An expense belongs to a job or to overhead, not both.",
    path: ["overhead_category"],
  })

function dollarsToCents(value: number | undefined | null) {
  if (!value || !Number.isFinite(value)) return 0
  return Math.round(value * 100)
}

/**
 * One create path for every capture surface. A project-scoped route passes its
 * path `projectId`, which wins; the job-optional route passes null and the
 * payload decides: a job, an overhead category, or neither (unsorted, for the
 * office to place).
 */
export async function createMobileExpense(
  context: MobileOrgContext,
  scopedProjectId: string | null,
  formData: FormData,
): Promise<MobileExpenseDTO> {
  const rawPayload = formData.get("payload")
  let payload: unknown
  try {
    payload = JSON.parse(typeof rawPayload === "string" ? rawPayload : "{}")
  } catch {
    throw new MobileAPIError(422, "invalid_expense", "The expense could not be read.")
  }
  const parsed = createSchema.safeParse(payload)
  if (!parsed.success) {
    throw new MobileAPIError(422, "invalid_expense", "Some expense information is invalid.", {
      fields: parsed.error.issues.map((issue) => issue.path.join(".")).join(", "),
    })
  }

  const projectId = scopedProjectId ?? parsed.data.project_id ?? null
  const overheadCategory = projectId ? null : (parsed.data.overhead_category ?? null)
  const project = projectId ? await requireProject(context, projectId) : null
  if (!projectId) await requireOrgExpenseCapture(context)

  // Idempotency: a retry with the same client_id returns the already-saved row.
  const existing = await context.serviceSupabase
    .from("project_expenses")
    .select(EXPENSE_SELECT)
    .eq("org_id", context.orgId)
    .eq("id", parsed.data.client_id)
    .maybeSingle()
  if (existing.error) throw new MobileAPIError(500, "expenses_unavailable", "Expenses could not be loaded.")
  const saved = existing.data
  if (saved) {
    const names = new Map<string, string>()
    if (saved.project_id) {
      const owner = (await listProjects(context.orgId, context.serviceContext)).find((item) => item.id === saved.project_id)
      if (owner) names.set(owner.id, owner.name)
    }
    return (await mapExpenseRows(context, [saved], names))[0]
  }

  const receipt = formData.get("receipt")
  const receiptFileId =
    receipt instanceof File && receipt.size > 0
      ? await uploadCostPlusFile({ file: receipt, orgId: context.orgId, projectId, kind: "expense_receipt" })
      : null

  const { data, error } = await context.serviceSupabase
    .from("project_expenses")
    .insert({
      id: parsed.data.client_id,
      org_id: context.orgId,
      project_id: projectId,
      overhead_category: overheadCategory,
      vendor_name_text: parsed.data.vendor_name || null,
      expense_date: parsed.data.expense_date,
      description: parsed.data.description || null,
      amount_cents: dollarsToCents(parsed.data.amount_dollars),
      tax_cents: dollarsToCents(parsed.data.tax_dollars),
      payment_method: parsed.data.payment_method ?? null,
      receipt_file_id: receiptFileId,
      is_billable: projectId !== null,
      accounting_coding: { transaction_type: "purchase" },
      submitted_by_user_id: context.user.id,
      status: "submitted",
    })
    .select(EXPENSE_SELECT)
    .single()
  if (error || !data) throw new MobileAPIError(500, "expense_create_failed", "The expense could not be saved.")

  await Promise.all([
    recordAudit({ orgId: context.orgId, actorId: context.user.id, action: "insert", entityType: "project_expense", entityId: data.id, after: data }),
    recordEvent({
      orgId: context.orgId,
      eventType: "expense_submitted",
      entityType: "project_expense",
      entityId: data.id,
      payload: { project_id: projectId, overhead_category: overheadCategory, amount_cents: data.amount_cents },
    }),
  ])

  const file = Array.isArray(data.receipt) ? data.receipt[0] : data.receipt
  return mapExpense(data, await receiptUrl(context, file), project?.name ?? null)
}

/**
 * The job the caller was clocked into when the receipt was dated. With a
 * scanned date only that calendar day (UTC) counts and the time on the clock
 * decides; without one it is today, and a running session wins. The day is a
 * UTC day, so an evening receipt can fall on the neighbouring day's sessions.
 */
async function suggestJobForReceipt(context: MobileOrgContext, expenseDate: string | null) {
  const now = new Date()
  const day = expenseDate ?? now.toISOString().slice(0, 10)
  const dayStart = new Date(`${day}T00:00:00.000Z`)
  if (Number.isNaN(dayStart.getTime())) return { id: null, name: null }
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000)

  const [sessions, projects] = await Promise.all([
    context.serviceSupabase
      .from("time_clock_sessions")
      .select("project_id, started_at, ended_at")
      .eq("org_id", context.orgId)
      .eq("worker_user_id", context.user.id)
      .gte("started_at", dayStart.toISOString())
      .lt("started_at", dayEnd.toISOString())
      .limit(100),
    listProjects(context.orgId, context.serviceContext),
  ])
  if (sessions.error) return { id: null, name: null }

  const reachable = new Map(projects.map((project) => [project.id, project.name]))
  const suggested = suggestJobFromClock({
    at: expenseDate ? null : now.toISOString(),
    sessions: (sessions.data ?? [])
      .filter((row) => reachable.has(row.project_id))
      .map((row) => ({ projectId: row.project_id, startedAt: row.started_at, endedAt: row.ended_at ?? null })),
    now: now.toISOString(),
  })
  return { id: suggested, name: suggested ? (reachable.get(suggested) ?? null) : null }
}

/** Reads a receipt. With a `scopedProjectId` the job is already known; without one the clock suggests it. */
export async function scanMobileReceipt(
  context: MobileOrgContext,
  scopedProjectId: string | null,
  formData: FormData,
): Promise<MobileReceiptScanDTO> {
  if (scopedProjectId) await requireProject(context, scopedProjectId)
  else await requireOrgExpenseCapture(context)
  const receipt = formData.get("receipt")
  if (!(receipt instanceof File) || receipt.size === 0) {
    throw new MobileAPIError(422, "invalid_receipt", "Choose a receipt to scan.")
  }
  let result
  try {
    result = await extractExpenseReceiptFromFile(receipt, { orgId: context.orgId })
  } catch (error: any) {
    throw new MobileAPIError(422, "receipt_scan_failed", error?.message ?? "The receipt could not be scanned.")
  }
  const suggestion = scopedProjectId ? { id: null, name: null } : await suggestJobForReceipt(context, result.expenseDate)
  return {
    vendor_name: result.vendorName,
    expense_date: result.expenseDate,
    total_dollars: result.totalDollars,
    tax_dollars: result.taxDollars,
    payment_method: result.paymentMethod,
    description: result.description,
    confidence: result.confidence,
    notes: result.notes,
    suggested_project_id: suggestion.id,
    suggested_project_name: suggestion.name,
  }
}
