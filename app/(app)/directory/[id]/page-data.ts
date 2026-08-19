import { cache } from "react"

import { getCompany, getClientCompanyReceivables } from "@/lib/services/companies"
import { getCompanyComplianceStatus } from "@/lib/services/compliance-documents"
import { getDirectoryIntelligenceForCompanies } from "@/lib/services/directory-intelligence"
import { getCurrentUserPermissions } from "@/lib/services/permissions"
import { getLatestPrequalification } from "@/lib/services/prequalification"
import { getVendorAccountLedger } from "@/lib/services/vendor-account"
import { listCompanyPaymentReadiness } from "@/lib/services/vendor-payment-invitations"
import { requireOrgContext } from "@/lib/services/context"
import { getProjectCostCodesEnabled } from "@/lib/financials/cost-codes-enabled"

export type CompanyPosture = "vendor" | "client" | "other"

/**
 * Company types that are not an accounts-payable relationship. Everything else
 * is a vendor — including trade strings outside `companyTypeEnum` that imports
 * and older records left behind ("plumbing", "roofing", "vendor"). Matching on
 * an allowlist instead hid the transactions, commitments and compliance tabs
 * from companies that had bills and commitments against them. This mirrors
 * `ensureProjectVendorForCommitment`, which already treats an unrecognized type
 * as a subcontractor.
 */
const NON_VENDOR_COMPANY_TYPES: ReadonlySet<string> = new Set(["architect", "engineer"])

export function resolveCompanyPosture(companyType?: string | null): CompanyPosture {
  const type = (companyType ?? "").toLowerCase()
  if (type === "client") return "client"
  if (NON_VENDOR_COMPANY_TYPES.has(type)) return "other"
  return "vendor"
}

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

  const posture: CompanyPosture = resolveCompanyPosture(company.company_type)

  const permissions = permissionResult?.permissions ?? []
  const canEdit = permissions.includes("org.member") || permissions.includes("directory.write")

  return {
    company,
    posture,
    canEdit,
    canArchive: canEdit,
    // Deciding a prequalification is its own permission — editing the directory
    // record does not make someone an approver.
    canReviewPrequal: permissions.includes("prequal.review"),
  }
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

export const loadPrequalificationGlance = cache((companyId: string) =>
  getLatestPrequalification(companyId).catch(() => null),
)

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
