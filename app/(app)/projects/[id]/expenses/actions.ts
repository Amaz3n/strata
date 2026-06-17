"use server"

import { revalidatePath } from "next/cache"

import { requireOrgContext } from "@/lib/services/context"
import { listProjects } from "@/lib/services/projects"
import { getProjectFinancialSettings } from "@/lib/services/project-financial-setup"
import { uploadCostPlusFile } from "@/lib/services/cost-plus-files"
import { extractExpenseReceiptFromFile, type ExtractedExpenseReceipt } from "@/lib/services/receipt-extraction"
import {
  approveProjectExpense,
  createProjectExpense,
  listCostPlusTabData,
  rejectProjectExpense,
  replaceProjectExpenseLines,
  type ProjectExpenseLineInput,
} from "@/lib/services/cost-plus"
import { QBOClient } from "@/lib/integrations/accounting/qbo-api"
import { syncProjectExpenseToQBO } from "@/lib/services/qbo-sync"
import { requireAuthorization } from "@/lib/services/authorization"

export interface CreateMyExpenseInput {
  expenseDate: string
  amountDollars: number
  taxDollars?: number
  vendorName?: string | null
  paymentMethod?: "cash" | "credit_card" | "check" | "ach" | "company_card" | "reimbursable_personal" | "other" | null
  qboTransactionType?: "purchase" | null
  qboExpenseAccountId?: string | null
  qboExpenseAccountName?: string | null
  qboPaymentAccountId?: string | null
  qboPaymentAccountName?: string | null
  qboApAccountId?: string | null
  qboApAccountName?: string | null
  qboVendorId?: string | null
  qboVendorName?: string | null
  createQboVendor?: boolean
  notes?: string | null
}

export interface UpdateExpenseAccountingInput {
  qboTransactionType?: "purchase" | "bill" | null
  qboExpenseAccountId?: string | null
  qboExpenseAccountName?: string | null
  qboPaymentAccountId?: string | null
  qboPaymentAccountName?: string | null
  qboApAccountId?: string | null
  qboApAccountName?: string | null
  qboVendorId?: string | null
  qboVendorName?: string | null
}

export interface UpdateExpenseDetailsInput {
  description?: string | null
  costCodeId?: string | null
  budgetLineId?: string | null
  expenseDate?: string | null
  paymentMethod?: string | null
}

export type ReceiptExtractionResult =
  | { ok: true; data: ExtractedExpenseReceipt }
  | { ok: false; error: string }

function moneyToCents(value: number | undefined | null) {
  if (!value || !Number.isFinite(value)) return 0
  return Math.round(value * 100)
}

function revalidate(projectId: string) {
  revalidatePath(`/projects/${projectId}/expenses`)
  revalidatePath(`/projects/${projectId}/cost-inbox`)
  revalidatePath(`/projects/${projectId}/financials`)
}

/** Latest budget's lines for a project — used as the cost bucket picker when cost codes are off. */
async function loadProjectBudgetLines(
  supabase: Awaited<ReturnType<typeof requireOrgContext>>["supabase"],
  orgId: string,
  projectId: string,
): Promise<{ id: string; description: string | null; amount_cents: number | null }[]> {
  const { data: budget } = await supabase
    .from("budgets")
    .select("id")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!budget) return []
  const { data: lines } = await supabase
    .from("budget_lines")
    .select("id, description, amount_cents, sort_order")
    .eq("org_id", orgId)
    .eq("budget_id", budget.id)
    .order("sort_order", { ascending: true })
  return (lines ?? []).map((line) => ({
    id: line.id as string,
    description: (line.description as string | null) ?? null,
    amount_cents: (line.amount_cents as number | null) ?? null,
  }))
}

export async function createMyExpenseAction(projectId: string, formData: FormData) {
  const { orgId } = await requireOrgContext()
  const payload = JSON.parse(String(formData.get("payload") ?? "{}")) as CreateMyExpenseInput

  if (!payload.amountDollars || payload.amountDollars <= 0) {
    throw new Error("Enter the receipt total")
  }
  if (!payload.expenseDate) {
    throw new Error("Pick the receipt date")
  }

  let qboVendorId = payload.qboVendorId?.trim() || null
  let qboVendorName = payload.qboVendorName?.trim() || null
  const vendorName = payload.vendorName?.trim() || null

  if (payload.createQboVendor && vendorName) {
    const client = await QBOClient.forOrg(orgId)
    if (!client) {
      throw new Error("Connect QuickBooks before adding a new QBO vendor")
    }
    const vendor = await client.getOrCreateVendor(vendorName)
    qboVendorId = vendor.Id ? String(vendor.Id) : null
    qboVendorName = vendor.DisplayName
  }

  const receiptFileId = await uploadCostPlusFile({
    file: formData.get("receipt") as File | null,
    orgId,
    projectId,
    kind: "expense_receipt",
  })

  await createProjectExpense({
    projectId,
    expenseDate: new Date(payload.expenseDate),
    amountCents: moneyToCents(payload.amountDollars),
    taxCents: moneyToCents(payload.taxDollars),
    vendorNameText: vendorName,
    paymentMethod: payload.paymentMethod ?? null,
    qboTransactionType: "purchase",
    qboExpenseAccountId: payload.qboExpenseAccountId ?? null,
    qboExpenseAccountName: payload.qboExpenseAccountName ?? null,
    qboPaymentAccountId: payload.qboPaymentAccountId ?? null,
    qboPaymentAccountName: payload.qboPaymentAccountName ?? null,
    qboApAccountId: null,
    qboApAccountName: null,
    qboVendorId,
    qboVendorName,
    description: payload.notes?.trim() || null,
    receiptFileId,
    isBillable: true,
  })

  revalidate(projectId)

  const data = await listCostPlusTabData(projectId).catch(() => ({ expenses: [] as any[] }))
  return data.expenses ?? []
}

export async function extractExpenseReceiptAction(_projectId: string, formData: FormData): Promise<ReceiptExtractionResult> {
  try {
    const { orgId } = await requireOrgContext()
    const receipt = formData.get("receipt")
    if (!(receipt instanceof File)) {
      return { ok: false, error: "Choose a receipt to scan" }
    }

    const data = await extractExpenseReceiptFromFile(receipt, { orgId })
    return { ok: true, data }
  } catch (error: any) {
    console.warn("[ReceiptExtraction] Scan failed", error)
    return { ok: false, error: error?.message ?? "Could not scan receipt" }
  }
}

export async function listProjectExpensesAction(projectId: string) {
  const data = await listCostPlusTabData(projectId).catch(() => ({ expenses: [] as any[] }))
  return data.expenses ?? []
}

export async function getExpenseAccountingContextAction(projectId?: string) {
  const { supabase, orgId } = await requireOrgContext()
  const { data: connection } = await supabase
    .from("qbo_connections")
    .select("settings")
    .eq("org_id", orgId)
    .eq("status", "active")
    .maybeSingle()
  const settings = (connection?.settings as Record<string, any> | null) ?? {}
  const projectSettings = projectId ? await getProjectFinancialSettings({ supabase, orgId, projectId }).catch(() => null) : null
  const costCodesEnabled = projectSettings?.cost_codes_enabled ?? true
  const { data: costCodes } = costCodesEnabled
    ? await supabase
        .from("cost_codes")
        .select("id, code, name, division, category")
        .eq("org_id", orgId)
        .eq("is_active", true)
        .order("code")
    : { data: [] }
  // Cost-codes-off projects bucket costs by budget line instead — offer those as the picker.
  const budgetLines = !costCodesEnabled && projectId
    ? await loadProjectBudgetLines(supabase, orgId, projectId)
    : []
  const client = await QBOClient.forOrg(orgId)
  if (!client) {
    return {
      qboConnected: false,
      expenseAccounts: [],
      paymentAccounts: [],
      apAccounts: [],
      vendors: [],
      costCodes: costCodesEnabled ? costCodes ?? [] : [],
      budgetLines,
      costCodesEnabled,
      defaults: {},
      warning: null,
    }
  }

  try {
    const [expenseAccounts, paymentAccounts, apAccounts, vendors] = await Promise.all([
      client.listExpenseAccounts(),
      client.listPaymentAccounts(),
      client.listAccountsPayableAccounts(),
      client.listVendors(),
    ])

    return {
      qboConnected: true,
      expenseAccounts,
      paymentAccounts,
      apAccounts,
      vendors,
      costCodes: costCodesEnabled ? costCodes ?? [] : [],
      budgetLines,
      costCodesEnabled,
      defaults: {
        expenseAccountId: typeof settings.default_expense_account_id === "string" ? settings.default_expense_account_id : "",
        paymentAccountId: typeof settings.default_payment_account_id === "string" ? settings.default_payment_account_id : "",
        creditCardAccountId: typeof settings.default_credit_card_account_id === "string" ? settings.default_credit_card_account_id : "",
        apAccountId: typeof settings.default_ap_account_id === "string" ? settings.default_ap_account_id : "",
      },
      warning: expenseAccounts.length === 0 ? "QuickBooks returned no expense accounts." : null,
    }
  } catch (error: any) {
    return {
      qboConnected: true,
      expenseAccounts: [],
      paymentAccounts: [],
      apAccounts: [],
      vendors: [],
      costCodes: costCodesEnabled ? costCodes ?? [] : [],
      budgetLines,
      costCodesEnabled,
      defaults: {},
      warning: error?.message ?? "Unable to load QuickBooks accounting categories.",
    }
  }
}

export async function updateProjectExpenseDetailsAction(
  projectId: string,
  expenseId: string,
  input: UpdateExpenseDetailsInput,
) {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requireAuthorization({
    permission: "bill.write",
    userId,
    orgId,
    projectId,
    supabase,
    logDecision: true,
    resourceType: "project_expense",
    resourceId: expenseId,
  })

  const updateData: Record<string, any> = {}
  if ("description" in input) updateData.description = input.description?.trim() || null
  if ("costCodeId" in input) updateData.cost_code_id = input.costCodeId || null
  if ("budgetLineId" in input) updateData.budget_line_id = input.budgetLineId || null
  if ("expenseDate" in input && input.expenseDate) updateData.expense_date = input.expenseDate
  if ("paymentMethod" in input) updateData.payment_method = input.paymentMethod || null

  if (Object.keys(updateData).length === 0) {
    return listProjectExpensesAction(projectId)
  }

  const { error } = await supabase
    .from("project_expenses")
    .update(updateData)
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .eq("id", expenseId)

  if (error) throw new Error(`Failed to update expense: ${error.message}`)
  revalidate(projectId)
  return listProjectExpensesAction(projectId)
}

export async function listExpenseProjectsAction(): Promise<{ id: string; name: string }[]> {
  const projects = await listProjects()
  return projects.map((project) => ({ id: project.id, name: project.name }))
}

export async function updateProjectExpenseLinesAction(
  projectId: string,
  expenseId: string,
  lines: ProjectExpenseLineInput[],
) {
  await replaceProjectExpenseLines({ expenseId, lines })
  revalidate(projectId)
  return listProjectExpensesAction(projectId)
}

export async function updateProjectExpenseReceiptAction(projectId: string, expenseId: string, formData: FormData) {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requireAuthorization({
    permission: "bill.write",
    userId,
    orgId,
    projectId,
    supabase,
    logDecision: true,
    resourceType: "project_expense",
    resourceId: expenseId,
  })

  const file = formData.get("receipt")
  // When a file is present we upload + set it; otherwise this clears the receipt.
  const receiptFileId =
    file instanceof File && file.size > 0
      ? await uploadCostPlusFile({ file, orgId, projectId, kind: "expense_receipt" })
      : null

  const { error } = await supabase
    .from("project_expenses")
    .update({ receipt_file_id: receiptFileId })
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .eq("id", expenseId)

  if (error) throw new Error(`Failed to update receipt: ${error.message}`)

  revalidate(projectId)
  return listProjectExpensesAction(projectId)
}

export async function approveProjectExpenseFormAction(projectId: string, expenseId: string) {
  await approveProjectExpense(expenseId)
  revalidate(projectId)
}

export async function rejectProjectExpenseFormAction(projectId: string, expenseId: string) {
  await rejectProjectExpense(expenseId)
  revalidate(projectId)
}

export async function updateProjectExpenseAccountingAction(
  projectId: string,
  expenseId: string,
  input: UpdateExpenseAccountingInput,
) {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requireAuthorization({
    permission: "bill.write",
    userId,
    orgId,
    projectId,
    supabase,
    logDecision: true,
    resourceType: "project_expense",
    resourceId: expenseId,
  })

  const { data: existing, error: existingError } = await supabase
    .from("project_expenses")
    .select("id, project_id, qbo_transaction_type, qbo_expense_account_id, qbo_payment_account_id, qbo_ap_account_id, qbo_vendor_id, qbo_sync_status")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .eq("id", expenseId)
    .maybeSingle()

  if (existingError || !existing) {
    throw new Error("Expense not found")
  }

  const normalized = {
    qbo_transaction_type: input.qboTransactionType ?? null,
    qbo_expense_account_id: input.qboExpenseAccountId || null,
    qbo_expense_account_name: input.qboExpenseAccountName || null,
    qbo_payment_account_id: input.qboPaymentAccountId || null,
    qbo_payment_account_name: input.qboPaymentAccountName || null,
    qbo_ap_account_id: input.qboApAccountId || null,
    qbo_ap_account_name: input.qboApAccountName || null,
    qbo_vendor_id: input.qboVendorId || null,
    qbo_vendor_name: input.qboVendorName || null,
  }

  const changed =
    normalized.qbo_transaction_type !== existing.qbo_transaction_type ||
    normalized.qbo_expense_account_id !== existing.qbo_expense_account_id ||
    normalized.qbo_payment_account_id !== existing.qbo_payment_account_id ||
    normalized.qbo_ap_account_id !== existing.qbo_ap_account_id ||
    normalized.qbo_vendor_id !== existing.qbo_vendor_id

  const updateData: Record<string, any> = { ...normalized }
  if (changed && existing.qbo_sync_status === "synced") {
    updateData.qbo_sync_status = "pending"
  }
  if (changed) {
    updateData.qbo_sync_error = null
  }

  const { error } = await supabase
    .from("project_expenses")
    .update(updateData)
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .eq("id", expenseId)

  if (error) {
    throw new Error(`Failed to update QuickBooks coding: ${error.message}`)
  }

  revalidate(projectId)
  const data = await listCostPlusTabData(projectId).catch(() => ({ expenses: [] as any[] }))
  return data.expenses ?? []
}

export async function syncProjectExpenseToQBOAction(projectId: string, expenseId: string) {
  const { orgId } = await requireOrgContext()
  const result = await syncProjectExpenseToQBO(expenseId, orgId)
  if (!result.success) {
    throw new Error(result.error ?? "Unable to sync expense to QuickBooks")
  }
  revalidate(projectId)
  return result
}
