"use server"

import { revalidatePath } from "next/cache"

import { requirePermissionGuard } from "@/lib/auth/guards"
import { createCostCode, listCostCodes, seedCSICostCodes, seedNAHBCostCodes, setCostCodeActive, updateCostCode } from "@/lib/services/cost-codes"
import type { CostType } from "@/lib/cost-types"

import { actionError, type ActionResult } from "@/lib/action-result"

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { success: true, data: await fn() }
  } catch (error) {
    return actionError(error)
  }
}

export async function listCostCodesAction(includeInactive = false) {
      await requirePermissionGuard("org.read")
      return listCostCodes(undefined, includeInactive)
}

export async function createCostCodeAction(input: {
  code: string
  name: string
  parent_id?: string | null
  division?: string | null
  category?: string | null
  unit?: string | null
  is_reimbursable_default?: boolean
  default_markup_percent?: number | null
  cost_type?: CostType | null
}) {
  return run(async () => {
      await requirePermissionGuard("org.admin")
      const result = await createCostCode({
        code: input.code.trim(),
        name: input.name.trim(),
        parent_id: input.parent_id ?? undefined,
        division: input.division?.trim() || undefined,
        category: input.category?.trim() || undefined,
        unit: input.unit?.trim() || undefined,
        is_reimbursable_default: input.is_reimbursable_default,
        default_markup_percent: input.default_markup_percent,
        standard: "custom",
        cost_type: input.cost_type,
      })
      revalidatePath("/settings")
      revalidatePath("/settings/cost-codes")
      return result
  })
}

export async function updateCostCodeAction(input: {
  id: string
  code: string
  name: string
  parent_id?: string | null
  division?: string | null
  category?: string | null
  unit?: string | null
  is_reimbursable_default?: boolean
  default_markup_percent?: number | null
  is_active?: boolean
  cost_type?: CostType | null
}) {
  return run(async () => {
      await requirePermissionGuard("org.admin")
      const result = await updateCostCode({
        id: input.id,
        code: input.code.trim(),
        name: input.name.trim(),
        parent_id: input.parent_id ?? null,
        division: input.division?.trim() || null,
        category: input.category?.trim() || null,
        unit: input.unit?.trim() || null,
        is_reimbursable_default: input.is_reimbursable_default,
        default_markup_percent: input.default_markup_percent,
        is_active: input.is_active,
        cost_type: input.cost_type,
      })
      revalidatePath("/settings")
      revalidatePath("/settings/cost-codes")
      return result
  })
}

export async function setCostCodeActiveAction(id: string, isActive: boolean) {
  return run(async () => {
      await requirePermissionGuard("org.admin")
      const result = await setCostCodeActive(id, isActive)
      revalidatePath("/settings")
      revalidatePath("/settings/cost-codes")
      return result
  })
}

export async function seedCostCodesAction(standard: "nahb" | "csi" = "nahb") {
  return run(async () => {
      await requirePermissionGuard("org.admin")
      if (standard === "csi") {
        await seedCSICostCodes()
      } else {
        await seedNAHBCostCodes()
      }
      revalidatePath("/settings")
      revalidatePath("/settings/cost-codes")
  })
}
