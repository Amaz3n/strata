"use server"

import { createTimeEntryFromPortal } from "@/lib/services/cost-plus"
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

export async function submitPortalTimeAction(token: string, formData: FormData) {
  const portalToken = await assertPortalActionAccess(token, {
    portalType: "sub",
    requireCompany: true,
    permission: "can_submit_time",
  })
  if (!portalToken.company_id) {
    throw new Error("Invalid portal access")
  }

  const workerNames = formData.getAll("worker_name")
  const hours = formData.getAll("hours")
  const baseRates = formData.getAll("base_rate")
  const costCodeIds = formData.getAll("cost_code_id")
  const workDate = parseDateEntry(formData.get("work_date"), "Work date")
  const burdenMultiplier = Number(formData.get("burden_multiplier") || 1)
  const isBillable = formData.get("is_billable") === "on"
  const isOvertime = formData.get("is_overtime") === "on"
  const isDoubleTime = formData.get("is_double_time") === "on"
  const otMultiplier = Number(formData.get("ot_multiplier") || 1.5)
  const dtMultiplier = Number(formData.get("dt_multiplier") || 2)
  const notes = String(formData.get("notes") || "") || null

  if (!Number.isFinite(burdenMultiplier) || burdenMultiplier <= 0) {
    throw new Error("Burden multiplier is invalid")
  }

  const entries = []
  for (let index = 0; index < workerNames.length; index += 1) {
    const workerName = String(workerNames[index] ?? "").trim()
    const rowHours = Number(hours[index] || 0)
    if (!workerName || rowHours <= 0) continue
    if (!Number.isFinite(rowHours) || rowHours > 24) {
      throw new Error(`Hours are invalid for ${workerName}`)
    }

    entries.push({
      projectId: portalToken.project_id,
      costCodeId: String(costCodeIds[index] || "") || null,
      workerName,
      workDate,
      hours: rowHours,
      baseRateCents: moneyToCents(baseRates[index] ?? null),
      burdenMultiplier,
      isBillable,
      isOvertime,
      isDoubleTime,
      otMultiplier,
      dtMultiplier,
      notes,
    })
  }

  if (entries.length === 0) {
    throw new Error("Add at least one worker with hours")
  }

  const attachmentId = await uploadCostPlusFile({
    file: formData.get("attachment") as File | null,
    orgId: portalToken.org_id,
    projectId: portalToken.project_id,
    companyId: portalToken.company_id,
    kind: "time_attachment",
  })
  const attachedFileIds = attachmentId ? [attachmentId] : []

  await Promise.all(
    entries.map((entry) =>
      createTimeEntryFromPortal({
        token,
        input: {
          ...entry,
          attachedFileIds,
        },
      }),
    ),
  )
}
