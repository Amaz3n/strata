"use server"

import { revalidatePath } from "next/cache"

import { requirePermissionGuard } from "@/lib/auth/guards"
import { createCostCode, importCostCodes, listCostCodes, seedNAHBCostCodes, setCostCodeActive, updateCostCode } from "@/lib/services/cost-codes"

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
}) {
  await requirePermissionGuard("org.admin")
  const result = await createCostCode({
    code: input.code.trim(),
    name: input.name.trim(),
    parent_id: input.parent_id ?? undefined,
    division: input.division?.trim() || undefined,
    category: input.category?.trim() || undefined,
    unit: input.unit?.trim() || undefined,
    standard: "custom",
  })
  revalidatePath("/settings")
  revalidatePath("/settings/cost-codes")
  return result
}

export async function updateCostCodeAction(input: {
  id: string
  code: string
  name: string
  parent_id?: string | null
  division?: string | null
  category?: string | null
  unit?: string | null
  is_active?: boolean
}) {
  await requirePermissionGuard("org.admin")
  const result = await updateCostCode({
    id: input.id,
    code: input.code.trim(),
    name: input.name.trim(),
    parent_id: input.parent_id ?? null,
    division: input.division?.trim() || null,
    category: input.category?.trim() || null,
    unit: input.unit?.trim() || null,
    is_active: input.is_active,
  })
  revalidatePath("/settings")
  revalidatePath("/settings/cost-codes")
  return result
}

export async function setCostCodeActiveAction(id: string, isActive: boolean) {
  await requirePermissionGuard("org.admin")
  const result = await setCostCodeActive(id, isActive)
  revalidatePath("/settings")
  revalidatePath("/settings/cost-codes")
  return result
}

export async function seedCostCodesAction() {
  await requirePermissionGuard("org.admin")
  await seedNAHBCostCodes()
  revalidatePath("/settings")
  revalidatePath("/settings/cost-codes")
}

export async function importCostCodesAction(csv: string) {
  await requirePermissionGuard("org.admin")
  if (!csv || csv.trim().length === 0) {
    throw new Error("CSV content is required")
  }

  const lines = csv
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  const rows = lines.map((line, idx) => {
    const [code, name, division, category] = line.split(",").map((v) => v.trim())
    if (!code || !name) {
      throw new Error(`Row ${idx + 1} must include code and name`)
    }
    return { code, name, division: division || undefined, category: category || undefined }
  })

  if (rows.length === 0) {
    throw new Error("No rows found in CSV")
  }

  const result = await importCostCodes(rows)
  revalidatePath("/settings")
  revalidatePath("/settings/cost-codes")
  return result
}



