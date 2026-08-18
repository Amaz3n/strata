import { cache } from "react"

import { getCompany, getClientCompanyReceivables } from "@/lib/services/companies"
import { getCompanyComplianceStatus } from "@/lib/services/compliance-documents"
import { getDirectoryIntelligenceForCompanies } from "@/lib/services/directory-intelligence"
import { getCurrentUserPermissions } from "@/lib/services/permissions"
import { getVendorAccountLedger } from "@/lib/services/vendor-account"
import { listCompanyPaymentReadiness } from "@/lib/services/vendor-payment-invitations"
import { requireOrgContext } from "@/lib/services/context"
import { getProjectCostCodesEnabled } from "@/lib/financials/cost-codes-enabled"

export type CompanyPosture = "vendor" | "client" | "other"

/**
 * Request-deduped loads shared by the account layout and its tab pages.
 * The layout and the active tab both call these in the same server render;
 * `cache()` collapses them to one query each.
 */
export const loadCompanyAccount = cache(async (companyId: string) => {
  const [company, permissionResult] = await Promise.all([
    getCompany(companyId),
    getCurrentUserPermissions(),
  ])

  const posture: CompanyPosture =
    company.company_type === "client"
      ? "client"
      : company.company_type === "subcontractor" || company.company_type === "supplier"
        ? "vendor"
        : "other"

  const permissions = permissionResult?.permissions ?? []
  const canEdit = permissions.includes("org.member") || permissions.includes("directory.write")

  return { company, posture, canEdit, canArchive: canEdit }
})

export const loadVendorLedger = cache((companyId: string) => getVendorAccountLedger(companyId))

export const loadPaymentReadiness = cache(async (companyId: string) => {
  const readiness = await listCompanyPaymentReadiness([companyId]).catch(() => null)
  return readiness?.get(companyId) ?? null
})

/** Per-project cost-code settings for the projects on one page of the register. */
export async function loadCostCodesEnabledForProjects(projectIds: string[]) {
  if (projectIds.length === 0) return {}
  const { supabase, orgId } = await requireOrgContext()
  const entries = await Promise.all(
    projectIds.map(async (projectId) => {
      const enabled = await getProjectCostCodesEnabled(supabase, orgId, projectId).catch(() => true)
      return [projectId, enabled] as const
    }),
  )
  return Object.fromEntries(entries)
}

export const loadComplianceStatus = cache((companyId: string) =>
  getCompanyComplianceStatus(companyId).catch(() => null),
)

export const loadClientReceivables = cache((companyId: string) =>
  getClientCompanyReceivables(companyId).catch(() => null),
)

export const loadVendorIntelligence = cache(async (companyId: string) => {
  try {
    const intelligence = await getDirectoryIntelligenceForCompanies([companyId])
    return {
      scorecard: intelligence.scorecardsByCompanyId[companyId] ?? null,
      taxReadiness: intelligence.taxReadinessByCompanyId[companyId] ?? null,
    }
  } catch {
    return { scorecard: null, taxReadiness: null }
  }
})
