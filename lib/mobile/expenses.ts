import { z } from "zod"

import { MobileAPIError } from "@/lib/mobile/api"
import type { MobileOrgContext } from "@/lib/mobile/auth"
import type { MobileExpenseDTO, MobileReceiptScanDTO } from "@/lib/mobile/contracts"
import { listProjects } from "@/lib/services/projects"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { uploadCostPlusFile } from "@/lib/services/cost-plus-files"
import { extractExpenseReceiptFromFile } from "@/lib/services/receipt-extraction"
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

async function requireProject(context: MobileOrgContext, projectId: string) {
  const project = (await listProjects(context.orgId, context.serviceContext)).find((item) => item.id === projectId)
  if (!project) throw new MobileAPIError(404, "project_not_found", "Project not found.")
  return project
}

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

function mapExpense(row: any, url: string | null): MobileExpenseDTO {
  return {
    id: row.id,
    project_id: row.project_id,
    vendor_name: row.vendor_name_text ?? null,
    description: row.description ?? null,
    expense_date: row.expense_date ?? null,
    amount_cents: Number(row.amount_cents ?? 0),
    tax_cents: Number(row.tax_cents ?? 0),
    payment_method: row.payment_method ?? null,
    status: row.status ?? "submitted",
    receipt_url: url,
    created_at: row.created_at,
  }
}

export async function listMobileExpenses(context: MobileOrgContext, projectId: string): Promise<MobileExpenseDTO[]> {
  await requireProject(context, projectId)
  const { data, error } = await context.serviceSupabase
    .from("project_expenses")
    .select(
      "id, project_id, vendor_name_text, description, expense_date, amount_cents, tax_cents, payment_method, status, receipt_file_id, created_at, " +
        "receipt:files!project_expenses_receipt_file_id_fkey(id, file_name, storage_path)",
    )
    .eq("org_id", context.orgId)
    .eq("project_id", projectId)
    .order("expense_date", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(200)
  if (error) throw new MobileAPIError(500, "expenses_unavailable", "Expenses could not be loaded.")

  return Promise.all(
    (data ?? []).map(async (row: any) => {
      const file = Array.isArray(row.receipt) ? row.receipt[0] : row.receipt
      return mapExpense(row, await receiptUrl(context, file))
    }),
  )
}

const createSchema = z.object({
  client_id: z.string().uuid(),
  expense_date: z.string().date(),
  amount_dollars: z.number().positive().max(10_000_000),
  tax_dollars: z.number().nonnegative().max(10_000_000).optional(),
  vendor_name: z.string().trim().max(250).optional(),
  payment_method: z.enum(PAYMENT_METHODS).optional(),
  description: z.string().trim().max(5_000).optional(),
})

function dollarsToCents(value: number | undefined | null) {
  if (!value || !Number.isFinite(value)) return 0
  return Math.round(value * 100)
}

export async function createMobileExpense(
  context: MobileOrgContext,
  projectId: string,
  formData: FormData,
): Promise<MobileExpenseDTO> {
  await requireProject(context, projectId)

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

  // Idempotency: a retry with the same client_id returns the already-saved row.
  const existing = await context.serviceSupabase
    .from("project_expenses")
    .select(
      "id, project_id, vendor_name_text, description, expense_date, amount_cents, tax_cents, payment_method, status, created_at, " +
        "receipt:files!project_expenses_receipt_file_id_fkey(id, file_name, storage_path)",
    )
    .eq("org_id", context.orgId)
    .eq("id", parsed.data.client_id)
    .maybeSingle()
  if (existing.data) {
    const row = existing.data as any
    const file = Array.isArray(row.receipt) ? row.receipt[0] : row.receipt
    return mapExpense(row, await receiptUrl(context, file))
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
      vendor_name_text: parsed.data.vendor_name || null,
      expense_date: parsed.data.expense_date,
      description: parsed.data.description || null,
      amount_cents: dollarsToCents(parsed.data.amount_dollars),
      tax_cents: dollarsToCents(parsed.data.tax_dollars),
      payment_method: parsed.data.payment_method ?? null,
      receipt_file_id: receiptFileId,
      is_billable: true,
      qbo_transaction_type: "purchase",
      submitted_by_user_id: context.user.id,
      status: "submitted",
    })
    .select(
      "id, project_id, vendor_name_text, description, expense_date, amount_cents, tax_cents, payment_method, status, receipt_file_id, created_at, " +
        "receipt:files!project_expenses_receipt_file_id_fkey(id, file_name, storage_path)",
    )
    .single()
  if (error || !data) throw new MobileAPIError(500, "expense_create_failed", "The expense could not be saved.")

  const created = data as any
  await Promise.all([
    recordAudit({ orgId: context.orgId, actorId: context.user.id, action: "insert", entityType: "project_expense", entityId: created.id, after: created }),
    recordEvent({ orgId: context.orgId, eventType: "expense_submitted", entityType: "project_expense", entityId: created.id, payload: { project_id: projectId, amount_cents: created.amount_cents } }),
  ])

  const file = Array.isArray(created.receipt) ? created.receipt[0] : created.receipt
  return mapExpense(created, await receiptUrl(context, file))
}

export async function scanMobileReceipt(
  context: MobileOrgContext,
  projectId: string,
  formData: FormData,
): Promise<MobileReceiptScanDTO> {
  await requireProject(context, projectId)
  const receipt = formData.get("receipt")
  if (!(receipt instanceof File) || receipt.size === 0) {
    throw new MobileAPIError(422, "invalid_receipt", "Choose a receipt to scan.")
  }
  try {
    const result = await extractExpenseReceiptFromFile(receipt, { orgId: context.orgId })
    return {
      vendor_name: result.vendorName,
      expense_date: result.expenseDate,
      total_dollars: result.totalDollars,
      tax_dollars: result.taxDollars,
      payment_method: result.paymentMethod,
      description: result.description,
      confidence: result.confidence,
      notes: result.notes,
    }
  } catch (error: any) {
    throw new MobileAPIError(422, "receipt_scan_failed", error?.message ?? "The receipt could not be scanned.")
  }
}
