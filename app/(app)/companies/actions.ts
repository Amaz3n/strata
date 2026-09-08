"use server"

import { revalidatePath } from "next/cache"

import { archiveCompany, createCompany, getCompany, getCompanyProjects, listCompanies, restoreCompany, saveCompanyAccountingVendorLink, updateCompany } from "@/lib/services/companies"
import { enrollCompanyInCompliance } from "@/lib/services/compliance-documents"
import { requireOrgContext } from "@/lib/services/context"
import { resolveAccountingTarget } from "@/lib/services/accounting-target"
import { getProvider } from "@/lib/integrations/accounting/registry"
import { ACCOUNTING_PROVIDERS } from "@/lib/integrations/accounting/catalog"
import { companyFiltersSchema, companyInputSchema, companyUpdateSchema } from "@/lib/validation/companies"
import { resolvePartyCapabilities } from "@/lib/directory/roles"
import { getPartyRoles } from "@/lib/services/party-roles"

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

/** The AP picker follows live vendor roles, not the legacy company_type bucket. */
export async function listVendorCompaniesAction() {
  const companies = await listCompanies()
  const roles = await getPartyRoles({ companyIds: companies.map((company) => company.id) })
  return companies.filter((company) => resolvePartyCapabilities(roles.get(company.id) ?? []).isVendor)
}

export async function createCompanyAction(input: unknown) {
  return run(async () => {
      const parsed = companyInputSchema.parse(input)
      const company = await createCompany({ input: parsed })
      revalidatePath("/directory")
      return company
  })
}

/**
 * Put a newly created trade partner on the org's compliance template.
 *
 * Separate from `createCompanyAction` on purpose: enrolling needs
 * `compliance.manage`, which a directory writer may not hold, and a company
 * that exists but is not being watched is a far better outcome than a create
 * that fails because the person adding a subcontractor cannot set requirements.
 * The form reports what happened either way.
 */
export async function enrollCompanyInComplianceAction(
  companyId: string,
): Promise<ActionResult<{ requirementCount: number; addedCount: number }>> {
  return run(async () => {
    const result = await enrollCompanyInCompliance({ companyId })
    revalidatePath(`/directory/${companyId}/compliance`)
    revalidatePath(`/directory/${companyId}`)
    revalidatePath("/directory")
    return result
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
