"use server"

import { revalidatePath } from "next/cache"

import { archiveCompany, createCompany, getCompany, getCompanyProjects, listCompanies, restoreCompany, saveCompanyAccountingVendorLink, updateCompany } from "@/lib/services/companies"
import { requireOrgContext } from "@/lib/services/context"
import { resolveAccountingTarget } from "@/lib/services/accounting-target"
import { getProvider } from "@/lib/integrations/accounting/registry"
import { ACCOUNTING_PROVIDERS } from "@/lib/integrations/accounting/catalog"
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

import { actionError, type ActionResult } from "@/lib/action-result"
import { inviteCompanyToPaymentSetup, setCompanyPaymentAccessStatus } from "@/lib/services/vendor-payment-invitations"

async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { success: true, data: await fn() }
  } catch (error) {
    return actionError(error)
  }
}

export async function listCompaniesAction(filters?: unknown) {
      const parsed = companyFiltersSchema.parse(filters ?? undefined) ?? undefined
      return listCompanies(undefined, parsed)
}

export async function createCompanyAction(input: unknown) {
  return run(async () => {
      const parsed = companyInputSchema.parse(input)
      const company = await createCompany({ input: parsed })
      revalidatePath("/directory")
      return company
  })
}

export async function updateCompanyAction(companyId: string, input: unknown) {
  return run(async () => {
      const parsed = companyUpdateSchema.parse(input)
      const company = await updateCompany({ companyId, input: parsed })
      revalidatePath("/directory")
      revalidatePath(`/directory/${companyId}`)
      return company
  })
}

export async function archiveCompanyAction(companyId: string) {
  return run(async () => {
      await archiveCompany(companyId)
      revalidatePath("/directory")
      revalidatePath(`/directory/${companyId}`)
      return true
  })
}

export async function restoreCompanyAction(companyId: string) {
  return run(async () => {
      await restoreCompany(companyId)
      revalidatePath("/directory")
      revalidatePath(`/directory/${companyId}`)
      return true
  })
}

export async function inviteCompanyToPaymentSetupAction(companyId: string) {
  return run(async () => {
    const result = await inviteCompanyToPaymentSetup({ companyId })
    revalidatePath(`/directory/${companyId}`)
    revalidatePath("/payables")
    return result
  })
}

export async function setCompanyPaymentAccessStatusAction(
  companyId: string,
  status: "active" | "suspended" | "revoked",
) {
  return run(async () => {
    const result = await setCompanyPaymentAccessStatus({ companyId, status })
    revalidatePath(`/directory/${companyId}`)
    revalidatePath("/payables")
    revalidatePath("/payables/payment-runs")
    return result
  })
}

export async function getCompanyAction(companyId: string) {
      const company = await getCompany(companyId)
      const projects = await getCompanyProjects(companyId)
      return { company, projects }
}

export async function getCompanyAccountingVendorContextAction() {
      const { orgId } = await requireOrgContext()
      const target = await resolveAccountingTarget({ orgId })
      const provider = target ? getProvider(target.connection.provider) : null
      if (!target || !provider?.searchCounterparties) {
        return { enabled: false, providerName: null, canCreate: false, vendors: [] }
      }
      return {
        enabled: true,
        // The connected provider names itself; nothing downstream may assume QuickBooks.
        providerName:
          ACCOUNTING_PROVIDERS[target.connection.provider]?.name ?? target.connection.label,
        canCreate: Boolean(provider.createCounterparty),
        vendors: await provider.searchCounterparties({ connectionId: target.connection.id, role: "vendor", term: "" }).catch(() => []),
      }
}

export async function linkCompanyAccountingVendorAction(companyId: string, vendor: { id: string; name: string }) {
  return run(async () => {
      const { supabase, orgId } = await requireOrgContext()
      const target = await resolveAccountingTarget({ orgId })
      if (!target) throw new Error("No organization accounting connection is mapped")
      await saveCompanyAccountingVendorLink({ supabase, orgId, companyId, connectionId: target.connection.id, externalId: vendor.id, displayName: vendor.name })
      const company = await getCompany(companyId)
      revalidatePath("/directory")
      revalidatePath(`/directory/${companyId}`)
      return company
  })
}

export async function createAccountingVendorForCompanyAction(companyId: string) {
  return run(async () => {
      const { supabase, orgId } = await requireOrgContext()
      const [company, target] = await Promise.all([getCompany(companyId), resolveAccountingTarget({ orgId })])
      if (!target) throw new Error("No organization accounting connection is mapped")
      const provider = getProvider(target.connection.provider)
      if (!provider.createCounterparty) throw new Error(`${target.connection.label} cannot create vendors from Arc`)
      const vendor = await provider.createCounterparty({ connectionId: target.connection.id, role: "vendor", counterparty: {
        displayName: company.name,
        email: company.email,
        line1: company.address?.street1 ?? company.address?.formatted,
        city: company.address?.city,
        state: company.address?.state,
        postalCode: company.address?.postal_code,
      } })
      await saveCompanyAccountingVendorLink({ supabase, orgId, companyId, connectionId: target.connection.id, externalId: vendor.id, displayName: vendor.name ?? company.name })
      const updated = await getCompany(companyId)
      revalidatePath("/directory")
      revalidatePath(`/directory/${companyId}`)
      return updated
  })
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
  return run(async () => {
      const result = await setCompanyRequirements({ companyId, requirements })
      revalidatePath(`/directory/${companyId}/compliance`)
      return result
  })
}

export async function waiveCompanyRequirementAction(
  companyId: string,
  input: unknown
) {
  return run(async () => {
      const parsed = complianceRequirementWaiverInputSchema.parse(input)
      const result = await waiveCompanyRequirement({ companyId, input: parsed })
      revalidatePath(`/directory/${companyId}/compliance`)
      revalidatePath("/directory")
      return result
  })
}

export async function revokeCompanyRequirementWaiverAction(
  waiverId: string,
  input?: unknown
) {
  return run(async () => {
      const parsed = complianceRequirementWaiverRevokeSchema.parse(input ?? {})
      const result = await revokeCompanyRequirementWaiver({ waiverId, input: parsed })
      revalidatePath(`/directory/${result.company_id}/compliance`)
      revalidatePath("/directory")
      return result
  })
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
  return run(async () => {
      const result = await uploadComplianceDocument({ companyId, input, fileId })
      revalidatePath(`/directory/${companyId}/compliance`)
      return result
  })
}

export async function reviewComplianceDocumentAction(
  documentId: string,
  decision: unknown
) {
  return run(async () => {
      const parsed = complianceReviewDecisionSchema.parse(decision)
      const result = await reviewComplianceDocument({ documentId, decision: parsed })
      revalidatePath("/directory")
      return result
  })
}
