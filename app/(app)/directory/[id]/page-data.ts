import { cache } from "react"

import { resolvePartyCapabilities, type PartyCapabilities, type PartyRole } from "@/lib/directory/roles"
import { canEditDirectory } from "@/lib/directory/permissions"
import { nullIfNotFound } from "@/lib/not-found-error"
import { getCompany, getClientCompanyReceivables } from "@/lib/services/companies"
import { getContact, getContactAssignments } from "@/lib/services/contacts"
import { getCompanyComplianceStatus } from "@/lib/services/compliance-documents"
import { getDirectoryIntelligenceForCompanies } from "@/lib/services/directory-intelligence"
import { getFinancialPartyReceivables } from "@/lib/services/financial-parties"
import { getPartyRoles } from "@/lib/services/party-roles"
import { getCurrentUserPermissions } from "@/lib/services/permissions"
import { getLatestPrequalification } from "@/lib/services/prequalification"
import { getVendorAccountLedger } from "@/lib/services/vendor-account"
import { listCompanyPaymentReadiness } from "@/lib/services/vendor-payment-invitations"
import { requireOrgContext } from "@/lib/services/context"
import { getProjectsCostCodesEnabled } from "@/lib/financials/cost-codes-enabled"

export interface DirectoryPartyPermissions {
  canEdit: boolean
  canArchive: boolean
  /** Deciding a prequalification is its own permission — editing the directory
   *  record does not make someone an approver. */
  canReviewPrequal: boolean
}

export type DirectoryParty =
  | ({
      kind: "company"
      company: Awaited<ReturnType<typeof getCompany>>
      roles: PartyRole[]
      capabilities: PartyCapabilities
    } & DirectoryPartyPermissions)
  | ({
      kind: "contact"
      contact: Awaited<ReturnType<typeof getContact>>
      roles: PartyRole[]
      capabilities: PartyCapabilities
    } & DirectoryPartyPermissions)

/**
 * Resolve one directory id to whichever kind of party it is.
 *
 * The account route used to be company-only, so a contact id 404'd here and
 * people lived at a separate `/contacts/[id]` page outside this shell. Ids are
 * uuids across both tables, so the route can serve either: try the company,
 * fall back to the contact. `cache()` collapses the layout's call and the
 * active tab's call to one round of queries.
 */
export const loadDirectoryParty = cache(async (partyId: string): Promise<DirectoryParty | null> => {
  // An id is either a company or a contact, and asking both tables at once
  // costs one round trip instead of three. Roles come back in the same pass
  // keyed by party id, so whichever table hit can read its own set.
  //
  // `nullIfNotFound` only swallows a genuine absence — a failed lookup still
  // throws, so a database problem reaches the error boundary instead of
  // rendering as "this vendor does not exist".
  const [company, contact, permissionResult, roleMap] = await Promise.all([
    nullIfNotFound(getCompany(partyId)),
    nullIfNotFound(getContact(partyId)),
    getCurrentUserPermissions(),
    getPartyRoles({ companyIds: [partyId], contactIds: [partyId] }),
  ])

  const permissions = permissionResult?.permissions ?? []
  const canEdit = canEditDirectory(permissions)
  const access: DirectoryPartyPermissions = {
    canEdit,
    canArchive: canEdit,
    canReviewPrequal: permissions.includes("prequal.review"),
  }

  const roles = roleMap.get(partyId) ?? []
  const capabilities = resolvePartyCapabilities(roles)

  if (company) {
    return { kind: "company", company, roles, capabilities, ...access }
  }
  if (contact) {
    return { kind: "contact", contact, roles, capabilities, ...access }
  }
  return null
})

/**
 * The company-shaped tabs (transactions, commitments, compliance,
 * prequalification) all need the same guard: this id is a company, and it is a
 * vendor. Returns null when it is not, so the page can redirect to the overview.
 */
export async function loadVendorCompany(partyId: string) {
  const party = await loadDirectoryParty(partyId)
  if (!party || party.kind !== "company" || !party.capabilities.isVendor) return null
  return party
}

export const loadVendorLedger = cache((companyId: string) => getVendorAccountLedger(companyId))

/** Per-project cost-code settings for the projects on one page of the register. */
export async function loadCostCodesEnabledForProjects(projectIds: string[]) {
  if (projectIds.length === 0) return {}
  const { supabase, orgId } = await requireOrgContext()
  return getProjectsCostCodesEnabled(supabase, orgId, projectIds).catch(() => ({}))
}

export const loadPaymentReadiness = cache(async (companyId: string) => {
  const readiness = await listCompanyPaymentReadiness([companyId]).catch(() => null)
  return readiness?.get(companyId) ?? null
})

export const loadPrequalificationGlance = cache((companyId: string) =>
  getLatestPrequalification(companyId).catch(() => null),
)

/**
 * Deliberately un-caught. This used to swallow every failure to `null`, and the
 * compliance tab turned `null` into `notFound()` — so a transient database
 * error told the user the vendor did not exist. Compliance decides whether Arc
 * releases payment; when it cannot be read, that has to surface as an error.
 */
export const loadComplianceStatus = cache((companyId: string) =>
  getCompanyComplianceStatus(companyId),
)

export const loadClientReceivables = cache((companyId: string) =>
  getClientCompanyReceivables(companyId).catch(() => null),
)

export const loadContactAssignments = cache((contactId: string) =>
  getContactAssignments(contactId).catch(() => ({
    schedule: [],
    tasks: [],
    limit: 0,
    scheduleTruncated: false,
    tasksTruncated: false,
  })),
)

export const loadContactReceivables = cache((contactId: string) =>
  getFinancialPartyReceivables({ partyType: "contact", partyId: contactId }).catch(() => null),
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
