"use server"

import { revalidatePath } from "next/cache"

import { archiveCompany, createCompany, getCompany, getCompanyProjects, listCompanies, restoreCompany, updateCompany } from "@/lib/services/companies"
import { requireOrgContext } from "@/lib/services/context"
import { QBOClient } from "@/lib/integrations/accounting/qbo-api"
import {
  getCompanyComplianceStatus,
  getCompanyRequirements,
  listComplianceDocumentTypes,
  listComplianceDocuments,
  revokeCompanyRequirementWaiver,
  reviewComplianceDocument,
  setCompanyRequirements,
  uploadComplianceDocument,
  waiveCompanyRequirement,
} from "@/lib/services/compliance-documents"
import { companyFiltersSchema, companyInputSchema, companyUpdateSchema } from "@/lib/validation/companies"
import {
  complianceDocumentFiltersSchema,
  complianceRequirementWaiverInputSchema,
  complianceRequirementWaiverRevokeSchema,
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

export async function restoreCompanyAction(companyId: string) {
  await restoreCompany(companyId)
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

export async function getCompanyQboVendorContextAction() {
  const { orgId } = await requireOrgContext()
  const client = await QBOClient.forOrg(orgId)
  if (!client) {
    return { enabled: false, vendors: [] }
  }
  return {
    enabled: true,
    vendors: await client.listVendors().catch(() => []),
  }
}

export async function linkCompanyQboVendorAction(companyId: string, vendor: { id: string; name: string }) {
  const company = await updateCompany({
    companyId,
    input: {
      qbo_vendor_id: vendor.id,
      qbo_vendor_name: vendor.name,
      qbo_vendor_synced_at: new Date().toISOString(),
      qbo_vendor_sync_status: "linked",
    },
  })
  revalidatePath("/companies")
  revalidatePath(`/companies/${companyId}`)
  revalidatePath("/directory")
  return company
}

export async function createQboVendorForCompanyAction(companyId: string) {
  const { orgId } = await requireOrgContext()
  const [company, client] = await Promise.all([getCompany(companyId), QBOClient.forOrg(orgId)])
  if (!client) {
    throw new Error("QuickBooks is not connected")
  }
  const vendor = await client.createVendorOption({
    name: company.name,
    email: company.email,
    line1: company.address?.street1 ?? company.address?.formatted,
    city: company.address?.city,
    state: company.address?.state,
    postalCode: company.address?.postal_code,
  })
  const updated = await updateCompany({
    companyId,
    input: {
      qbo_vendor_id: vendor.id,
      qbo_vendor_name: vendor.name,
      qbo_vendor_synced_at: new Date().toISOString(),
      qbo_vendor_sync_status: "created",
    },
  })
  revalidatePath("/companies")
  revalidatePath(`/companies/${companyId}`)
  revalidatePath("/directory")
  return updated
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

export async function waiveCompanyRequirementAction(
  companyId: string,
  input: unknown
) {
  const parsed = complianceRequirementWaiverInputSchema.parse(input)
  const result = await waiveCompanyRequirement({ companyId, input: parsed })
  revalidatePath(`/companies/${companyId}`)
  revalidatePath("/companies")
  return result
}

export async function revokeCompanyRequirementWaiverAction(
  waiverId: string,
  input?: unknown
) {
  const parsed = complianceRequirementWaiverRevokeSchema.parse(input ?? {})
  const result = await revokeCompanyRequirementWaiver({ waiverId, input: parsed })
  revalidatePath(`/companies/${result.company_id}`)
  revalidatePath("/companies")
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

