/**
 * What a directory party is to this org.
 *
 * This replaces four overlapping classification systems that disagreed with
 * each other: `companies.company_type`, `contacts.contact_type`, the write-only
 * `relationship_type_id`, and `resolveCompanyPosture`'s "vendor = not architect
 * or engineer" inversion (which existed because the type column held trade
 * strings the enum never allowed).
 *
 * A party holds a SET of roles. Everything downstream — which account tabs
 * exist, which pickers include it, whether compliance watches it — is a
 * question about that set, never about a single column. Pure by design so the
 * money-adjacent decisions it feeds can be tested without a database.
 */

export const ROLE_CATEGORIES = ["vendor", "client", "design", "internal", "other"] as const
export type RoleCategory = (typeof ROLE_CATEGORIES)[number]

/**
 * One vocabulary read against the role's category. A role has exactly one state
 * at a time, so this is one column rather than four mostly-null ones:
 *   vendor → prospective | invited | active | inactive
 *   client → inquiry | qualified | under_contract | closed | inactive
 *   design | internal | other → active | inactive
 */
export const ROLE_STATUSES = [
  "prospective",
  "invited",
  "active",
  "inactive",
  "inquiry",
  "qualified",
  "under_contract",
  "closed",
] as const
export type RoleStatus = (typeof ROLE_STATUSES)[number]

export const ROLE_SOURCES = ["manual", "import", "promotion", "backfill", "system"] as const
export type RoleSource = (typeof ROLE_SOURCES)[number]

export type PartyKind = "company" | "contact"

export interface RelationshipType {
  id: string
  key: string
  label: string
  category: RoleCategory
  applies_to: PartyKind | "both"
  sort_order: number
}

export interface PartyRole {
  id: string
  relationship_type_id: string
  key: string
  label: string
  category: RoleCategory
  status: RoleStatus
  since: string
  until?: string
}

/**
 * Statuses that mean the relationship is over. `inactive` is the universal one;
 * `closed` ends a client relationship the same way (the home closed, the job is
 * done) without implying the party was dropped.
 *
 * `prospective`, `invited`, `inquiry`, `qualified` and `under_contract` are all
 * LIVE — they are stages on the way in, not exits. A vendor you have invited to
 * prequalify is a vendor you are watching.
 */
const ENDED_STATUSES: ReadonlySet<RoleStatus> = new Set<RoleStatus>(["inactive", "closed"])

/**
 * The single definition of "this role counts right now".
 *
 * There used to be three answers to this question that disagreed. TypeScript
 * honoured a future `until`; the `directory_entries` view tested `until is null`
 * and ignored `status` entirely; capabilities ignored `status` too. The result:
 * a vendor marked inactive kept its account tabs and stayed on the compliance
 * watch list, while a role scheduled to end vanished from the list but stayed
 * live everywhere else.
 *
 * `directory_role_is_live(status, until)` in SQL implements exactly this rule.
 * Both must move together — the list and the account page have to agree about
 * who is a vendor, because that decides who Arc will pay.
 */
export function isCurrentRole(role: PartyRole, now = new Date()): boolean {
  if (ENDED_STATUSES.has(role.status)) return false
  if (!role.until) return true
  return new Date(role.until).getTime() > now.getTime()
}

/** Statuses that read as "the relationship is over" — exported for the UI. */
export function isEndedStatus(status: RoleStatus): boolean {
  return ENDED_STATUSES.has(status)
}

export function currentRoles(roles: PartyRole[], now = new Date()): PartyRole[] {
  return roles.filter((role) => isCurrentRole(role, now))
}

export function hasRoleKey(roles: PartyRole[], key: string): boolean {
  return currentRoles(roles).some((role) => role.key === key)
}

export function hasRoleCategory(roles: PartyRole[], category: RoleCategory): boolean {
  return currentRoles(roles).some((role) => role.category === category)
}

/**
 * What a party's roles entitle it to across the app. Every surface that used to
 * branch on a type column asks this instead — which is what makes a company
 * that is both a subcontractor and a client show both sets of tabs, a case the
 * scalar type column could not express at all.
 */
export interface PartyCapabilities {
  /** An accounts-payable relationship: commitments, bills, compliance, prequal. */
  isVendor: boolean
  /** Money flows the other way: receivables, and eligible as a project client. */
  isClient: boolean
  /** Architect, engineer, consultant — reviewers, not payees. */
  isDesign: boolean
  /** Someone on the builder's own side listed in the directory. */
  isInternal: boolean
  /** In the sales pipeline but not yet under contract. */
  isProspect: boolean
  /** Under contract or closed on a home. */
  isBuyer: boolean
  /** Closed and now in the warranty relationship. */
  isHomeowner: boolean
  /** Compliance and prequalification apply to this party. */
  requiresCompliance: boolean
}

export function resolvePartyCapabilities(roles: PartyRole[]): PartyCapabilities {
  const current = currentRoles(roles)
  const isVendor = current.some((role) => role.category === "vendor")
  return {
    isVendor,
    isClient: current.some((role) => role.category === "client"),
    isDesign: current.some((role) => role.category === "design"),
    isInternal: current.some((role) => role.category === "internal"),
    isProspect: current.some((role) => role.key === "prospect"),
    isBuyer: current.some((role) => role.key === "buyer"),
    isHomeowner: current.some((role) => role.key === "homeowner"),
    // Compliance is a vendor obligation. A design consultant carries insurance
    // too, but Arc's compliance engine gates PAYMENT, and design parties are
    // not on the AP rail.
    requiresCompliance: isVendor,
  }
}


/**
 * Statuses that make sense for a role, given its category.
 *
 * `active` and `inactive` are universal — they mean "this relationship is
 * current" and "it is not", which is true of every category. The rest are
 * refinements: a vendor can be short of active (prospective, invited) and a
 * client moves along a funnel. A homeowner recorded directly in the directory
 * is simply active; forcing them through `inquiry` would be a lie about how
 * they got there.
 */
export function statusesForCategory(category: RoleCategory): RoleStatus[] {
  if (category === "vendor") return ["prospective", "invited", "active", "inactive"]
  if (category === "client") {
    return ["active", "inquiry", "qualified", "under_contract", "closed", "inactive"]
  }
  return ["active", "inactive"]
}

export function isStatusValidForCategory(status: RoleStatus, category: RoleCategory): boolean {
  return statusesForCategory(category).includes(status)
}

const STATUS_LABELS: Record<RoleStatus, string> = {
  prospective: "Prospective",
  invited: "Invited",
  active: "Active",
  inactive: "Inactive",
  inquiry: "Inquiry",
  qualified: "Qualified",
  under_contract: "Under contract",
  closed: "Closed",
}

export function roleStatusLabel(status: RoleStatus): string {
  return STATUS_LABELS[status]
}
