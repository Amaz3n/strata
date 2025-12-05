"use server"

import { revalidatePath } from "next/cache"

import { archiveCompany, createCompany, listCompanies, updateCompany } from "@/lib/services/companies"
import { companyFiltersSchema, companyInputSchema, companyUpdateSchema } from "@/lib/validation/companies"

export async function listCompaniesAction(filters?: unknown) {
  const parsed = companyFiltersSchema.parse(filters ?? undefined) ?? undefined
  return listCompanies(undefined, parsed)
}

export async function createCompanyAction(input: unknown) {
  const parsed = companyInputSchema.parse(input)
  const company = await createCompany({ input: parsed })
  revalidatePath("/companies")
  return company
}

export async function updateCompanyAction(companyId: string, input: unknown) {
  const parsed = companyUpdateSchema.parse(input)
  const company = await updateCompany({ companyId, input: parsed })
  revalidatePath("/companies")
  return company
}

export async function archiveCompanyAction(companyId: string) {
  await archiveCompany(companyId)
  revalidatePath("/companies")
  return true
}
