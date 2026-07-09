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

import { unwrapAction, actionError, type ActionResult  } from "@/lib/action-result"

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { success: true, data: await fn() }
  } catch (error) {
    return actionError(error)
  }
}

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
  /** Set after the user confirms a possible-duplicate warning. */
  allowDuplicate?: boolean
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

export type ExpenseQueueFilter = "all" | "needs_review" | "ready" | "synced"

export interface ExpensePageInput {
  page?: number
  pageSize?: number
  search?: string
  queueFilter?: ExpenseQueueFilter
}

export type ReceiptExtractionResult =
  | { ok: true; data: ExtractedExpenseReceipt }
  | { ok: false; error: string }

function moneyToCents(value: number | undefined | null) {
  if (!value || !Number.isFinite(value)) return 0
  return Math.round(value * 100)
}

function escapePostgrestPattern(value: string) {
  return value.replace(/[%_]/g, "\\$&")
}

function normalizePostgrestSearchText(value: string) {
  return value.replace(/[(),]/g, " ").replace(/\s+/g, " ").trim()
}

function parseExpenseSearchCents(value: string) {
  const cleaned = value.replace(/[,$]/g, "").trim()
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return null
  return Math.abs(Math.round(Number(cleaned) * 100))
}

function parseExpenseSearchDate(value: string) {
  const trimmed = value.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed
  const slashMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/)
  if (!slashMatch) return null
  const [, month, day, year] = slashMatch
  const fullYear = year.length === 2 ? `20${year}` : year
  return `${fullYear}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`
}

function matchingExpenseStatuses(value: string) {
  const term = value.toLowerCase()
  return ["draft", "submitted", "approved", "rejected", "locked"].filter((status) =>
    status.replaceAll("_", " ").includes(term),
  )
}

function matchingExpensePaymentMethods(value: string) {
  const term = value.toLowerCase()
  const labels: Record<string, string[]> = {
    cash: ["cash"],
    credit_card: ["credit card", "card", "cc"],
    check: ["check", "cheque"],
    ach: ["ach", "bank transfer"],
    company_card: ["company card", "corporate card"],
    reimbursable_personal: ["reimbursable", "personal", "personal card"],
    other: ["other"],
  }
  return Object.entries(labels)
    .filter(([method, aliases]) => method.includes(term) || aliases.some((alias) => alias.includes(term)))
    .map(([method]) => method)
}

function matchingExpenseQboStatuses(value: string) {
  const term = value.toLowerCase()
  const labels: Record<string, string[]> = {
    pending: ["pending", "pending sync"],
    synced: ["synced", "quickbooks", "qbo"],
    error: ["error", "sync error"],
    needs_review: ["needs review", "requires review", "needs coding", "review"],
    skipped: ["skipped", "disabled"],
  }
  return Object.entries(labels)
    .filter(([status, aliases]) => status.includes(term) || aliases.some((alias) => alias.includes(term)))
    .map(([status]) => status)
}

function revalidate(projectId: string) {
  revalidatePath(`/projects/${projectId}/expenses`)
  revalidatePath(`/projects/${projectId}/cost-inbox`)
  revalidatePath(`/projects/${projectId}/financials`)
  revalidatePath(`/projects/${projectId}/financials/review`)
  revalidatePath(`/projects/${projectId}/financials/receivables`)
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
  return run(async () => {
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
        allowDuplicate: payload.allowDuplicate === true,
      })

      revalidate(projectId)

      const data = await listCostPlusTabData(projectId).catch(() => ({ expenses: [] as any[] }))
      return data.expenses ?? []
  })
}

export async function extractExpenseReceiptAction(_projectId: string, formData: FormData): Promise<ActionResult<ReceiptExtractionResult>> {
  return run(async () => {
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
  })
}

export async function listProjectExpensesAction(projectId: string) {
      const data = await listCostPlusTabData(projectId).catch(() => ({ expenses: [] as any[] }))
      return data.expenses ?? []
}

export async function listProjectExpensesPageAction(projectId: string, input: ExpensePageInput = {}) {
      const { supabase, orgId, userId } = await requireOrgContext()
      await requireAuthorization({
        permission: "invoice.read",
        userId,
        orgId,
        projectId,
        supabase,
        logDecision: true,
      })

      const pageSize = Math.min(Math.max(Math.trunc(input.pageSize ?? 50), 10), 100)
      const page = Math.max(Math.trunc(input.page ?? 1), 1)
      const from = (page - 1) * pageSize
      const to = from + pageSize - 1
      const search = input.search?.trim() ?? ""
      const queueFilter = input.queueFilter ?? "all"

      let query = supabase
        .from("project_expenses")
        .select("*, cost_code:cost_codes(code, name), vendor_company:companies(name)", { count: "exact" })
        .eq("org_id", orgId)
        .eq("project_id", projectId)

      if (search) {
        const searchText = normalizePostgrestSearchText(search)
        const escaped = escapePostgrestPattern(searchText)
        const hasTextSearch = searchText.length > 0
        const lowerSearch = search.toLowerCase()
        const searchFilters = hasTextSearch
          ? [
              `vendor_name_text.ilike.%${escaped}%`,
              `description.ilike.%${escaped}%`,
              `status.ilike.%${escaped}%`,
              `payment_method.ilike.%${escaped}%`,
              `qbo_id.ilike.%${escaped}%`,
              `qbo_sync_status.ilike.%${escaped}%`,
              `qbo_transaction_type.ilike.%${escaped}%`,
              `qbo_expense_account_name.ilike.%${escaped}%`,
              `qbo_expense_account_id.ilike.%${escaped}%`,
              `qbo_payment_account_name.ilike.%${escaped}%`,
              `qbo_payment_account_id.ilike.%${escaped}%`,
              `qbo_ap_account_name.ilike.%${escaped}%`,
              `qbo_ap_account_id.ilike.%${escaped}%`,
              `qbo_vendor_name.ilike.%${escaped}%`,
              `qbo_vendor_id.ilike.%${escaped}%`,
              `qbo_sync_error.ilike.%${escaped}%`,
            ]
          : []

        const cents = parseExpenseSearchCents(search)
        if (cents != null) {
          searchFilters.push(`amount_cents.eq.${cents}`, `tax_cents.eq.${cents}`)
        }

        const date = parseExpenseSearchDate(search)
        if (date) searchFilters.push(`expense_date.eq.${date}`)

        const statuses = matchingExpenseStatuses(search)
        if (statuses.length > 0) searchFilters.push(`status.in.(${statuses.join(",")})`)

        const paymentMethods = matchingExpensePaymentMethods(search)
        if (paymentMethods.length > 0) searchFilters.push(`payment_method.in.(${paymentMethods.join(",")})`)

        const qboStatuses = matchingExpenseQboStatuses(search)
        if (qboStatuses.length > 0) searchFilters.push(`qbo_sync_status.in.(${qboStatuses.join(",")})`)

        if (lowerSearch.includes("not billable") || lowerSearch.includes("non billable")) {
          searchFilters.push("is_billable.eq.false")
        } else if (lowerSearch.includes("billable")) {
          searchFilters.push("is_billable.eq.true")
        }
        const shouldMatchCredits = lowerSearch.includes("credit") || lowerSearch.includes("refund") || search.startsWith("-")

        const [matchingCostCodes, matchingCompanies, matchingReceipts, matchingLines, matchingCredits] = await Promise.all([
          hasTextSearch
            ? supabase
                .from("cost_codes")
                .select("id")
                .eq("org_id", orgId)
                .or(`code.ilike.%${escaped}%,name.ilike.%${escaped}%`)
                .limit(100)
            : Promise.resolve({ data: [] }),
          hasTextSearch
            ? supabase
                .from("companies")
                .select("id")
                .eq("org_id", orgId)
                .ilike("name", `%${escaped}%`)
                .limit(100)
            : Promise.resolve({ data: [] }),
          hasTextSearch
            ? supabase
                .from("files")
                .select("id")
                .eq("org_id", orgId)
                .ilike("file_name", `%${escaped}%`)
                .limit(100)
            : Promise.resolve({ data: [] }),
          hasTextSearch || cents != null
            ? supabase
                .from("project_expense_lines")
                .select("expense_id")
                .eq("org_id", orgId)
                .or(
                  [
                    ...(hasTextSearch
                      ? [
                          `description.ilike.%${escaped}%`,
                          `qbo_expense_account_name.ilike.%${escaped}%`,
                          `qbo_expense_account_id.ilike.%${escaped}%`,
                        ]
                      : []),
                    ...(cents != null ? [`amount_cents.eq.${cents}`] : []),
                  ].join(","),
                )
                .limit(500)
            : Promise.resolve({ data: [] }),
          shouldMatchCredits
            ? supabase
                .from("project_expenses")
                .select("id")
                .eq("org_id", orgId)
                .eq("project_id", projectId)
                .ilike("metadata->>source", "expense_credit%")
                .limit(500)
            : Promise.resolve({ data: [] }),
        ])

        const costCodeIds = (matchingCostCodes.data ?? []).map((row) => row.id).filter(Boolean)
        if (costCodeIds.length > 0) {
          searchFilters.push(`cost_code_id.in.(${costCodeIds.join(",")})`)
          const { data: matchingLineCostCodes } = await supabase
            .from("project_expense_lines")
            .select("expense_id")
            .eq("org_id", orgId)
            .in("cost_code_id", costCodeIds)
            .limit(500)
          const lineCostCodeExpenseIds = Array.from(new Set((matchingLineCostCodes ?? []).map((row) => row.expense_id).filter(Boolean)))
          if (lineCostCodeExpenseIds.length > 0) searchFilters.push(`id.in.(${lineCostCodeExpenseIds.join(",")})`)
        }
        const companyIds = (matchingCompanies.data ?? []).map((row) => row.id).filter(Boolean)
        if (companyIds.length > 0) searchFilters.push(`vendor_company_id.in.(${companyIds.join(",")})`)
        const receiptIds = (matchingReceipts.data ?? []).map((row) => row.id).filter(Boolean)
        if (receiptIds.length > 0) searchFilters.push(`receipt_file_id.in.(${receiptIds.join(",")})`)
        const lineExpenseIds = Array.from(new Set((matchingLines.data ?? []).map((row) => row.expense_id).filter(Boolean)))
        if (lineExpenseIds.length > 0) searchFilters.push(`id.in.(${lineExpenseIds.join(",")})`)
        const creditExpenseIds = (matchingCredits.data ?? []).map((row) => row.id).filter(Boolean)
        if (creditExpenseIds.length > 0) searchFilters.push(`id.in.(${creditExpenseIds.join(",")})`)

        if (searchFilters.length > 0) query = query.or(searchFilters.join(","))
      }

      if (queueFilter === "synced") {
        query = query.eq("qbo_sync_status", "synced")
      } else if (queueFilter === "needs_review") {
        query = query.or(
          [
            "qbo_sync_status.eq.needs_review",
            "qbo_sync_status.eq.error",
            "and(status.eq.approved,qbo_expense_account_id.is.null)",
            "and(status.eq.approved,qbo_payment_account_id.is.null)",
          ].join(","),
        )
      } else if (queueFilter === "ready") {
        query = query
          .eq("status", "approved")
          .or("qbo_sync_status.is.null,qbo_sync_status.neq.synced")
          .not("qbo_expense_account_id", "is", null)
          .not("qbo_payment_account_id", "is", null)
      }

      const { data, error, count } = await query
        .order("expense_date", { ascending: false })
        .order("created_at", { ascending: false })
        .range(from, to)
      if (error) throw new Error(`Failed to load expenses: ${error.message}`)

      const expenseRows = data ?? []
      const expenseIds = expenseRows.map((expense) => expense.id).filter(Boolean)
      const linesByExpense = new Map<string, any[]>()
      if (expenseIds.length > 0) {
        const { data: lineRows, error: lineError } = await supabase
          .from("project_expense_lines")
          .select("*, cost_code:cost_codes(code, name)")
          .eq("org_id", orgId)
          .in("expense_id", expenseIds)
          .order("sort_order", { ascending: true })
        if (lineError) throw new Error(`Failed to load expense lines: ${lineError.message}`)
        for (const line of lineRows ?? []) {
          const existing = linesByExpense.get(line.expense_id)
          if (existing) existing.push(line)
          else linesByExpense.set(line.expense_id, [line])
        }
      }

      const total = count ?? 0
      return {
        items: expenseRows.map((expense) => ({ ...expense, lines: linesByExpense.get(expense.id) ?? [] })),
        page,
        pageSize,
        total,
        pageCount: Math.max(1, Math.ceil(total / pageSize)),
      }
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
  return run(async () => {
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
        return await listProjectExpensesAction(projectId)
      }

      const { error } = await supabase
        .from("project_expenses")
        .update(updateData)
        .eq("org_id", orgId)
        .eq("project_id", projectId)
        .eq("id", expenseId)

      if (error) throw new Error(`Failed to update expense: ${error.message}`)
      revalidate(projectId)
      return await listProjectExpensesAction(projectId)
  })
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
  return run(async () => {
      await replaceProjectExpenseLines({ expenseId, lines })
      revalidate(projectId)
      return await listProjectExpensesAction(projectId)
  })
}

export async function updateProjectExpenseReceiptAction(projectId: string, expenseId: string, formData: FormData) {
  return run(async () => {
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
      return await listProjectExpensesAction(projectId)
  })
}

export async function approveProjectExpenseFormAction(projectId: string, expenseId: string) {
  return run(async () => {
      await approveProjectExpense(expenseId)
      revalidate(projectId)
  })
}

export async function rejectProjectExpenseFormAction(projectId: string, expenseId: string) {
  return run(async () => {
      await rejectProjectExpense(expenseId)
      revalidate(projectId)
  })
}

export interface UpdateExpenseWorkspaceInput {
  details: UpdateExpenseDetailsInput
  accounting: UpdateExpenseAccountingInput
  lines: ProjectExpenseLineInput[]
}

/**
 * Single save for the expense workspace: details + QuickBooks coding land in one
 * row update, then split lines are replaced. Replaces the previous three-action
 * sequence so a mid-sequence failure can no longer half-save the expense.
 */
export async function updateProjectExpenseWorkspaceAction(
  projectId: string,
  expenseId: string,
  input: UpdateExpenseWorkspaceInput,
) {
  return run(async () => {
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
        .select("id, qbo_transaction_type, qbo_expense_account_id, qbo_payment_account_id, qbo_ap_account_id, qbo_vendor_id, qbo_sync_status")
        .eq("org_id", orgId)
        .eq("project_id", projectId)
        .eq("id", expenseId)
        .maybeSingle()
      if (existingError || !existing) throw new Error("Expense not found")

      const { details, accounting } = input
      const updateData: Record<string, any> = {
        qbo_transaction_type: accounting.qboTransactionType ?? null,
        qbo_expense_account_id: accounting.qboExpenseAccountId || null,
        qbo_expense_account_name: accounting.qboExpenseAccountName || null,
        qbo_payment_account_id: accounting.qboPaymentAccountId || null,
        qbo_payment_account_name: accounting.qboPaymentAccountName || null,
        qbo_ap_account_id: accounting.qboApAccountId || null,
        qbo_ap_account_name: accounting.qboApAccountName || null,
        qbo_vendor_id: accounting.qboVendorId || null,
        qbo_vendor_name: accounting.qboVendorName || null,
      }
      if ("description" in details) updateData.description = details.description?.trim() || null
      if ("costCodeId" in details) updateData.cost_code_id = details.costCodeId || null
      if ("budgetLineId" in details) updateData.budget_line_id = details.budgetLineId || null
      if ("expenseDate" in details && details.expenseDate) updateData.expense_date = details.expenseDate
      if ("paymentMethod" in details) updateData.payment_method = details.paymentMethod || null

      const codingChanged =
        updateData.qbo_transaction_type !== existing.qbo_transaction_type ||
        updateData.qbo_expense_account_id !== existing.qbo_expense_account_id ||
        updateData.qbo_payment_account_id !== existing.qbo_payment_account_id ||
        updateData.qbo_ap_account_id !== existing.qbo_ap_account_id ||
        updateData.qbo_vendor_id !== existing.qbo_vendor_id
      if (codingChanged) {
        updateData.qbo_sync_error = null
        if (existing.qbo_sync_status === "synced") updateData.qbo_sync_status = "pending"
      }

      const { error } = await supabase
        .from("project_expenses")
        .update(updateData)
        .eq("org_id", orgId)
        .eq("project_id", projectId)
        .eq("id", expenseId)
      if (error) throw new Error(`Failed to save expense: ${error.message}`)

      await replaceProjectExpenseLines({ expenseId, lines: input.lines })

      revalidate(projectId)
      return await listProjectExpensesAction(projectId)
  })
}

export async function updateProjectExpenseAccountingAction(
  projectId: string,
  expenseId: string,
  input: UpdateExpenseAccountingInput,
) {
  return run(async () => {
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
  })
}

export async function syncProjectExpenseToQBOAction(projectId: string, expenseId: string) {
  return run(async () => {
      const { orgId } = await requireOrgContext()
      const result = await syncProjectExpenseToQBO(expenseId, orgId)
      if (!result.success) {
        throw new Error(result.error ?? "Unable to sync expense to QuickBooks")
      }
      revalidate(projectId)
      return result
  })
}
