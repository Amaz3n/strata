"use server"

import { createProjectExpenseFromPortal } from "@/lib/services/cost-plus"
import { uploadCostPlusFile } from "@/lib/services/cost-plus-files"
import { assertPortalActionAccess } from "@/lib/services/portal-access"

function moneyToCents(value: FormDataEntryValue | null) {
  const raw = String(value ?? "").replace(/[^\d.]/g, "")
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0
}

function parseDateEntry(value: FormDataEntryValue | null, label: string) {
  const raw = String(value ?? "")
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new Error(`${label} is required`)
  }
  const parsed = new Date(`${raw}T00:00:00`)
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${label} is invalid`)
  }
  return parsed
}

export async function submitPortalExpenseAction(token: string, formData: FormData) {
  const portalToken = await assertPortalActionAccess(token, {
    portalType: "sub",
    requireCompany: true,
    permission: "can_submit_expenses",
  })
  if (!portalToken.company_id) {
    throw new Error("Invalid portal access")
  }

  const amountCents = moneyToCents(formData.get("amount"))
  if (amountCents <= 0) {
    throw new Error("Expense amount must be greater than zero")
  }
  const expenseDate = parseDateEntry(formData.get("expense_date"), "Expense date")

  const receiptFileId = await uploadCostPlusFile({
    file: formData.get("receipt") as File | null,
    orgId: portalToken.org_id,
    projectId: portalToken.project_id,
    companyId: portalToken.company_id,
    kind: "expense_receipt",
  })

  await createProjectExpenseFromPortal({
    token,
    input: {
      projectId: portalToken.project_id,
      costCodeId: String(formData.get("cost_code_id") || "") || null,
      vendorNameText: String(formData.get("vendor_name") || "") || null,
      expenseDate,
      description: String(formData.get("description") || "") || null,
      amountCents,
      taxCents: moneyToCents(formData.get("tax")),
      paymentMethod: (String(formData.get("payment_method") || "") || null) as any,
      receiptFileId,
      isBillable: formData.get("is_billable") === "on",
      allowDuplicate: false,
    },
  })
}
