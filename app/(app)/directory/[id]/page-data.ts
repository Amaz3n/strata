import { cache } from "react"
import { cacheLife, cacheTag } from "next/cache"

import { resolvePartyCapabilities, type PartyCapabilities, type PartyRole } from "@/lib/directory/roles"
import { canEditDirectory } from "@/lib/directory/permissions"
import { nullIfNotFound } from "@/lib/not-found-error"
import { getCompany, getClientCompanyReceivables } from "@/lib/services/companies"
import { getContact, getContactAssignments } from "@/lib/services/contacts"
import { getCompanyComplianceStatus } from "@/lib/services/compliance-documents"
import { getDirectoryIntelligenceForCompanies } from "@/lib/services/directory-intelligence"
import { getDirectoryEntry, type DirectoryRoleState } from "@/lib/services/directory"
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

export interface DirectoryPartyHeader {
  kind: "company" | "contact"
  id: string
  name: string
  email?: string
  detail?: string
  primaryCompanyName?: string
  roles: DirectoryRoleState[]
  capabilities: PartyCapabilities
  canEdit: boolean
  canArchive: boolean
  canReviewPrequal: boolean
}

/**
 * Company tabs are a small, bounded set of hot destinations. A one-minute
 * browser-private freshness window lets their runtime prefetches cross the
 * authenticated database reads and arrive before the click, without putting
 * financial or access data in a shared server cache. Directory mutations use
 * revalidatePath, so writes still clear these entries immediately.
 */
export function registerDirectoryTabCache(partyId: string, tab: string) {
  cacheLife({ stale: 60, revalidate: 30, expire: 300 })
  cacheTag(`directory-party:${partyId}`, `directory-party:${partyId}:${tab}`)
}

/**
 * A single view lookup is enough to paint the useful account identity.
 *
 * Cached per browser session rather than per request, which is what lets the
 * account header arrive *with* the click instead of after it. The header hangs
 * off `params`, so it can never be part of a route's static shell; runtime
 * prefetching resolves it at link-prefetch time instead, and only reaches a
 * cached function whose `stale` is at least 30 seconds.
 *
 * `"use cache: private"` because this reads the session through
 * `requireOrgContext()` and `getCurrentUserPermissions()`. The result lives in
 * that one browser's memory, never on the server, and never survives a reload —
 * the same trade the app chrome already makes. The staleness is chrome: the
 * `canEdit` flags here only decide whether a control is drawn, and every
 * mutation behind those controls re-checks permissions server-side. Directory
 * mutations call `revalidatePath`, which invalidates the client cache outright,
 * so an edit is visible immediately rather than at the end of this window.
 */
export async function loadDirectoryPartyHeader(
  partyId: string,
): Promise<DirectoryPartyHeader | null> {
  "use cache: private"
  // stale ≥ 30s is the runtime-prefetching threshold; 5 minutes keeps a warmed
  // account warm across a normal back-and-forth through the directory.
  cacheLife({ stale: 300, revalidate: 60, expire: 3600 })
  cacheTag(`directory-party:${partyId}`)

  const [entry, permissionResult] = await Promise.all([
    getDirectoryEntry(partyId),
    getCurrentUserPermissions(),
  ])
  if (!entry) return null

  const permissions = permissionResult?.permissions ?? []
  const canEdit = canEditDirectory(permissions)
  const categories = new Set(entry.role_categories)
  const keys = new Set(entry.role_keys)
  const isVendor = categories.has("vendor")
  return {
    kind: entry.kind,
    id: entry.id,
    name: entry.name,
    email: entry.email,
    detail: entry.detail,
    primaryCompanyName: entry.primary_company_name,
    roles: entry.roles,
    capabilities: {
      isVendor,
      isClient: categories.has("client"),
      isDesign: categories.has("design"),
      isInternal: categories.has("internal"),
      isProspect: keys.has("prospect"),
      isBuyer: keys.has("buyer"),
      isHomeowner: keys.has("homeowner"),
      requiresCompliance: isVendor,
    },
    canEdit,
    canArchive: canEdit,
    canReviewPrequal: permissions.includes("prequal.review"),
  }
}

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

/** Compact guard for vendor tabs that only need identity and permissions. */
export async function loadVendorCompanyHeader(partyId: string) {
  const party = await loadDirectoryPartyHeader(partyId)
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
