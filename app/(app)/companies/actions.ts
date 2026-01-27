"use server"

import { revalidatePath } from "next/cache"

import { archiveCompany, createCompany, getCompany, getCompanyProjects, listCompanies, updateCompany } from "@/lib/services/companies"
import {
  getCompanyComplianceStatus,
  getCompanyRequirements,
  listComplianceDocumentTypes,
  listComplianceDocuments,
  reviewComplianceDocument,
  setCompanyRequirements,
  uploadComplianceDocument,
} from "@/lib/services/compliance-documents"
import { companyFiltersSchema, companyInputSchema, companyUpdateSchema } from "@/lib/validation/companies"
import {
  complianceDocumentFiltersSchema,
  complianceReviewDecisionSchema,
  type ComplianceRequirementInput,
  type ComplianceDocumentUploadInput,
} from "@/lib/validation/compliance-documents"

export async function listCompaniesAction(filters?: unknown) {
  const parsed = companyFiltersSchema.parse(filters ?? undefined) ?? undefined
  return listCompanies(undefined, parsed)
}

export async function createCompanyAction(input: unknown) {
  const parsed = companyInputSchema.parse(input)
  const company = await createCompany({ input: parsed })
  revalidatePath("/companies")
  revalidatePath("/directory")
  return company
}

export async function updateCompanyAction(companyId: string, input: unknown) {
  const parsed = companyUpdateSchema.parse(input)
  const company = await updateCompany({ companyId, input: parsed })
  revalidatePath("/companies")
  revalidatePath(`/companies/${companyId}`)
  revalidatePath("/directory")
  return company
}

export async function archiveCompanyAction(companyId: string) {
  await archiveCompany(companyId)
  revalidatePath("/companies")
  revalidatePath(`/companies/${companyId}`)
  revalidatePath("/directory")
  return true
}

export async function getCompanyAction(companyId: string) {
  const company = await getCompany(companyId)
  const projects = await getCompanyProjects(companyId)
  return { company, projects }
}

// Compliance Document Actions

export async function listComplianceDocumentTypesAction() {
  return listComplianceDocumentTypes()
}

export async function getCompanyComplianceStatusAction(companyId: string) {
  return getCompanyComplianceStatus(companyId)
}

export async function getCompanyRequirementsAction(companyId: string) {
  return getCompanyRequirements(companyId)
}

export async function setCompanyRequirementsAction(
  companyId: string,
  requirements: ComplianceRequirementInput[]
) {
  const result = await setCompanyRequirements({ companyId, requirements })
  revalidatePath(`/companies/${companyId}`)
  return result
}

export async function listComplianceDocumentsAction(filters?: unknown) {
  const parsed = complianceDocumentFiltersSchema.parse(filters ?? {}) ?? undefined
  return listComplianceDocuments(parsed)
}

export async function uploadComplianceDocumentAction({
  companyId,
  input,
  fileId,
}: {
  companyId: string
  input: ComplianceDocumentUploadInput
  fileId: string
}) {
  const result = await uploadComplianceDocument({ companyId, input, fileId })
  revalidatePath(`/companies/${companyId}`)
  return result
}

export async function reviewComplianceDocumentAction(
  documentId: string,
  decision: unknown
) {
  const parsed = complianceReviewDecisionSchema.parse(decision)
  const result = await reviewComplianceDocument({ documentId, decision: parsed })
  revalidatePath(`/companies`)
  return result
}




