"use server"

import { revalidatePath } from "next/cache"

import { requirePermissionGuard } from "@/lib/auth/guards"
import { importCostCodes, listCostCodes, seedNAHBCostCodes } from "@/lib/services/cost-codes"

export async function listCostCodesAction() {
  await requirePermissionGuard("org.read")
  return listCostCodes()
}

export async function seedCostCodesAction() {
  await requirePermissionGuard("org.admin")
  await seedNAHBCostCodes()
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
  revalidatePath("/settings/cost-codes")
  return result
}


