/**
 * What the assistant is allowed to read on behalf of the person asking.
 *
 * Arc has two independent access layers and the assistant was only obeying one
 * of them. RLS enforces TENANCY — every row is `org_id`-scoped, so retrieval can
 * never cross into another customer's data, and that part was always sound. The
 * permission catalog enforces CAPABILITY — whether this particular member may
 * see invoices, budgets, or payables at all — and nothing in the AI search path
 * consulted it.
 *
 * The gap is not theoretical. A superintendent with no `invoice.read` sees no
 * invoices anywhere in the UI, and could ask the assistant "what is our open
 * AR?" and be told. The answer would be correctly scoped to their org and
 * completely outside their clearance.
 *
 * The rule here is deliberately conservative: an entity type is gated only where
 * the catalog has a read permission that unambiguously governs it. Everything
 * else keeps the behaviour it has today — visible to any org member — because
 * over-gating breaks a PM who legitimately sees a record in the UI and then
 * cannot find it in search, which is the kind of failure people route around by
 * asking for more permissions than they need.
 *
 * Pure, so the map can be tested without a session. Unit-tested in
 * tests/search-visibility.test.js.
 */

import type { SearchEntityType } from "@/lib/services/search-config"

/** Granted when a user holds every permission (platform/owner roles). */
export const WILDCARD_PERMISSION = "*"

/**
 * Entity type → the permission that governs reading it.
 *
 * Every key here exists in the RBAC catalog (`TEAM_PERMISSION_OPTIONS` in
 * `lib/services/team.ts`, seeded by the catalog-as-code migration). A type
 * absent from this map is ungated on purpose, not by oversight.
 */
export const SEARCH_TYPE_PERMISSION: Partial<Record<SearchEntityType, string>> = {
  // Financials
  invoice: "invoice.read",
  budget: "budget.read",
  budget_transfer: "budget.read",
  commitment: "commitment.read",
  commitment_change_order: "commitment.read",
  payable: "bill.read",
  change_event: "change_events.read",
  warranty_request: "warranty.read",
  warranty_backcharge: "warranty.read",

  // Preconstruction and business development
  bid_package: "bid.read",
  proposal: "proposal.read",
  prospect: "pipeline.read",

  // Production
  community: "community.read",
  lot: "community.read",
  house_plan: "plan.read",
  selection_option: "selections.read",
  price_agreement: "price_book.read",
  start_package: "start.read",
  closing: "sales.read",

  // Field and correspondence
  safety_incident: "safety.read",
  project_email: "correspondence.read",
}

export function permissionForSearchType(type: SearchEntityType): string | null {
  return SEARCH_TYPE_PERMISSION[type] ?? null
}

/**
 * Does this permission set allow reading this entity type?
 *
 * The wildcard is honoured because that is how the permission service reports an
 * owner or platform role; treating it as a literal permission key would lock
 * those roles out of everything.
 */
export function canReadSearchType(type: SearchEntityType, granted: Set<string>): boolean {
  if (granted.has(WILDCARD_PERMISSION)) return true
  const required = permissionForSearchType(type)
  return required === null || granted.has(required)
}

/**
 * Narrow a requested set of entity types to the ones this user may read.
 *
 * Applied BEFORE retrieval runs, so a blocked type is never queried, never
 * embedded in the prompt, and never available for the model to summarise. Doing
 * it afterwards would mean the blocked rows had already been in the model's
 * context, which is exactly the thing being prevented.
 */
export function visibleSearchEntityTypes(
  requested: SearchEntityType[],
  granted: Set<string>,
): SearchEntityType[] {
  return requested.filter((type) => canReadSearchType(type, granted))
}

export interface VisibilityFilterResult<T> {
  visible: T[]
  /** Entity types that were dropped, deduped — for telling the user why. */
  blockedTypes: string[]
}

/**
 * Drop results the user may not read.
 *
 * A second line of defence rather than the primary one: retrieval paths that
 * cannot be pre-filtered (a lexical index returning mixed types, a tool that
 * resolves related records) still pass through here. Blocked types are reported
 * so the answer can say "some records were excluded" instead of silently
 * presenting a partial picture as a complete one.
 */
export function filterResultsByPermission<T extends { type: string }>(
  results: T[],
  granted: Set<string>,
): VisibilityFilterResult<T> {
  if (granted.has(WILDCARD_PERMISSION)) return { visible: results, blockedTypes: [] }

  const visible: T[] = []
  const blocked = new Set<string>()

  for (const result of results) {
    if (canReadSearchType(result.type as SearchEntityType, granted)) {
      visible.push(result)
    } else {
      blocked.add(result.type)
    }
  }

  return { visible, blockedTypes: [...blocked].sort() }
}

/**
 * A line for the user when their clearance narrowed the answer.
 *
 * Said out loud because the alternative is worse: an assistant that quietly
 * answers "you have no overdue invoices" to someone who simply cannot see
 * invoices has told them something false.
 */
export function describeBlockedTypes(blockedTypes: string[]): string | null {
  if (blockedTypes.length === 0) return null
  const readable = blockedTypes.map((type) => type.replace(/_/g, " ")).join(", ")
  return `Some records were left out of this answer because your role cannot view them: ${readable}.`
}
