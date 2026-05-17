"use server"

import { createTimeEntryFromPortal } from "@/lib/services/cost-plus"
import { uploadCostPlusFile } from "@/lib/services/cost-plus-files"
import { validatePortalToken } from "@/lib/services/portal-access"

function moneyToCents(value: FormDataEntryValue | null) {
  const raw = String(value ?? "").replace(/[^\d.]/g, "")
  return raw ? Math.round(Number(raw) * 100) : 0
}

export async function submitPortalTimeAction(token: string, formData: FormData) {
  const portalToken = await validatePortalToken(token)
  if (!portalToken || portalToken.portal_type !== "sub" || !portalToken.company_id) {
    throw new Error("Invalid portal access")
  }
  const attachmentId = await uploadCostPlusFile({
    file: formData.get("attachment") as File | null,
    orgId: portalToken.org_id,
    projectId: portalToken.project_id,
    companyId: portalToken.company_id,
    kind: "time_attachment",
  })
  const attachedFileIds = attachmentId ? [attachmentId] : []
  const workerNames = formData.getAll("worker_name")
  const hours = formData.getAll("hours")
  const baseRates = formData.getAll("base_rate")
  const costCodeIds = formData.getAll("cost_code_id")
  const workDate = new Date(String(formData.get("work_date") || ""))
  const burdenMultiplier = Number(formData.get("burden_multiplier") || 1)
  const isBillable = formData.get("is_billable") === "on"
  const isOvertime = formData.get("is_overtime") === "on"
  const notes = String(formData.get("notes") || "") || null

  let created = 0
  for (let index = 0; index < workerNames.length; index += 1) {
    const workerName = String(workerNames[index] ?? "").trim()
    const rowHours = Number(hours[index] || 0)
    if (!workerName || rowHours <= 0) continue

    await createTimeEntryFromPortal({
      token,
      input: {
        projectId: "00000000-0000-0000-0000-000000000000",
        costCodeId: String(costCodeIds[index] || "") || null,
        workerName,
        workDate,
        hours: rowHours,
        baseRateCents: moneyToCents(baseRates[index] ?? null),
        burdenMultiplier,
        isBillable,
        isOvertime,
        notes,
        attachedFileIds,
      },
    })
    created += 1
  }

  if (created === 0) {
    throw new Error("Add at least one worker with hours")
  }
}
