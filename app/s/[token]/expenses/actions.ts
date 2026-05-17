"use server"

import { createProjectExpenseFromPortal } from "@/lib/services/cost-plus"
import { uploadCostPlusFile } from "@/lib/services/cost-plus-files"
import { validatePortalToken } from "@/lib/services/portal-access"

function moneyToCents(value: FormDataEntryValue | null) {
  const raw = String(value ?? "").replace(/[^\d.]/g, "")
  return raw ? Math.round(Number(raw) * 100) : 0
}

export async function submitPortalExpenseAction(token: string, formData: FormData) {
  const portalToken = await validatePortalToken(token)
  if (!portalToken || portalToken.portal_type !== "sub" || !portalToken.company_id) {
    throw new Error("Invalid portal access")
  }
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
      projectId: "00000000-0000-0000-0000-000000000000",
      costCodeId: String(formData.get("cost_code_id") || "") || null,
      vendorNameText: String(formData.get("vendor_name") || "") || null,
      expenseDate: new Date(String(formData.get("expense_date") || "")),
      description: String(formData.get("description") || "") || null,
      amountCents: moneyToCents(formData.get("amount")),
      taxCents: moneyToCents(formData.get("tax")),
      paymentMethod: (String(formData.get("payment_method") || "") || null) as any,
      receiptFileId,
      isBillable: formData.get("is_billable") === "on",
    },
  })
}
