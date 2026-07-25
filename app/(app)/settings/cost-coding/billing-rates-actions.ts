"use server"

import { revalidatePath } from "next/cache"

import { requirePermissionGuard } from "@/lib/auth/guards"
import {
  archiveBillingRateSchedule,
  assignBillingRateScheduleToProject,
  createBillingRate,
  createBillingRateOverride,
  createBillingRateSchedule,
  deleteBillingRate,
  deleteBillingRateOverride,
  listBillingRateOverrides,
  listBillingRateSchedules,
  type BillingRateKind,
  type BillingRateUnit,
} from "@/lib/services/billing-rate-schedules"
import { requireOrgContext } from "@/lib/services/context"
import { listCostCodes } from "@/lib/services/cost-codes"
import { listTeamMembers } from "@/lib/services/team"

import { actionError, type ActionResult } from "@/lib/action-result"

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { success: true, data: await fn() }
  } catch (error) {
    return actionError(error)
  }
}

const NONE = "__none__"

export async function listBillingRateSchedulesAction() {
      await requirePermissionGuard("org.member")
      return listBillingRateSchedules()
}

export async function listBillingRateOverridesAction() {
      await requirePermissionGuard("org.member")
      return listBillingRateOverrides()
}

export async function listBillingRateOptionsAction() {
      await requirePermissionGuard("org.member")
      const { supabase, orgId } = await requireOrgContext()
      const [costCodes, teamMembers, contractsResult] = await Promise.all([
        listCostCodes(undefined, false),
        listTeamMembers(undefined, { includeProjectCounts: false }),
        supabase
          .from("contracts")
          .select("id, project_id, title, number, rate_schedule_id, project:projects(id, name)")
          .eq("org_id", orgId)
          .eq("status", "active")
          .eq("contract_type", "time_materials")
          .order("created_at", { ascending: false }),
      ])

      if (contractsResult.error) {
        throw new Error(`Failed to load T&M contracts: ${contractsResult.error.message}`)
      }

      return {
        costCodes,
        teamMembers,
        contracts: contractsResult.data ?? [],
      }
}

export async function createBillingRateScheduleFormAction(formData: FormData) {
  return run(async () => {
      await requirePermissionGuard("org.admin")
      await createBillingRateSchedule({
        name: String(formData.get("name") || ""),
        description: nullableString(formData.get("description")),
        status: (String(formData.get("status") || "active") as "draft" | "active" | "archived"),
      })
      revalidateBillingRates()
  })
}

export async function archiveBillingRateScheduleFormAction(scheduleId: string) {
  return run(async () => {
      await requirePermissionGuard("org.admin")
      await archiveBillingRateSchedule(scheduleId)
      revalidateBillingRates()
  })
}

export async function assignBillingRateScheduleFormAction(formData: FormData) {
  return run(async () => {
      await requirePermissionGuard("org.admin")
      await assignBillingRateScheduleToProject({
        projectId: requiredString(formData.get("project_id"), "Choose a T&M project."),
        rateScheduleId: nullableString(formData.get("rate_schedule_id")),
      })
      revalidateBillingRates()
  })
}

export async function createBillingRateFormAction(formData: FormData) {
  return run(async () => {
      await requirePermissionGuard("org.admin")
      await createBillingRate({
        scheduleId: requiredString(formData.get("schedule_id"), "Choose a schedule."),
        ...rateInputFromForm(formData),
      })
      revalidateBillingRates()
  })
}

export async function deleteBillingRateFormAction(rateId: string) {
  return run(async () => {
      await requirePermissionGuard("org.admin")
      await deleteBillingRate(rateId)
      revalidateBillingRates()
  })
}

export async function createBillingRateOverrideFormAction(formData: FormData) {
  return run(async () => {
      await requirePermissionGuard("org.admin")
      const { projectId, contractId } = parseProjectContract(formData.get("project_contract"))
      await createBillingRateOverride({
        projectId,
        contractId,
        scheduleId: nullableString(formData.get("schedule_id")),
        ...rateInputFromForm(formData),
      })
      revalidateBillingRates()
  })
}

export async function deleteBillingRateOverrideFormAction(overrideId: string) {
  return run(async () => {
      await requirePermissionGuard("org.admin")
      await deleteBillingRateOverride(overrideId)
      revalidateBillingRates()
  })
}

function revalidateBillingRates() {
  revalidatePath("/settings/billing-rates")
}

function nullableString(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim()
  return text && text !== NONE ? text : null
}

function requiredString(value: FormDataEntryValue | null, message: string) {
  const text = nullableString(value)
  if (!text) throw new Error(message)
  return text
}

function nullableNumber(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim()
  if (!text) return null
  const number = Number(text)
  return Number.isFinite(number) ? number : null
}

function nullableDate(value: FormDataEntryValue | null) {
  const text = nullableString(value)
  return text ? new Date(text) : null
}

function centsFromDollars(value: FormDataEntryValue | null) {
  const number = nullableNumber(value)
  return number == null ? null : Math.round(number * 100)
}

function rateInputFromForm(formData: FormData) {
  return {
    kind: String(formData.get("kind") || "labor_role") as BillingRateKind,
    roleName: nullableString(formData.get("role_name")),
    userId: nullableString(formData.get("user_id")),
    equipmentName: nullableString(formData.get("equipment_name")),
    costCodeId: nullableString(formData.get("cost_code_id")),
    rateCents: centsFromDollars(formData.get("rate_amount")),
    markupPercent: nullableNumber(formData.get("markup_percent")),
    otMultiplier: nullableNumber(formData.get("ot_multiplier")) ?? 1.5,
    dtMultiplier: nullableNumber(formData.get("dt_multiplier")) ?? 2,
    unit: String(formData.get("unit") || "hour") as BillingRateUnit,
    effectiveFrom: nullableDate(formData.get("effective_from")),
    effectiveTo: nullableDate(formData.get("effective_to")),
  }
}

function parseProjectContract(value: FormDataEntryValue | null) {
  const raw = requiredString(value, "Choose a T&M project.")
  const [projectId, contractId] = raw.split(":")
  if (!projectId) throw new Error("Choose a T&M project.")
  return {
    projectId,
    contractId: contractId || null,
  }
}
