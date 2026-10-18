/**
 * Which desk a lead is worked from. A lead for a community is a production
 * buyer and belongs to Sales. A lead with no community is a custom-home or
 * commercial prospect and belongs to the Pipeline, when the org has one; an org
 * that only builds in communities works everything from Sales.
 *
 * `customBuildNavigation` comes from `shouldShowCustomBuildNavigation()` — the
 * posture choke point — so a mixed org gets both desks without anyone branching
 * on its tier.
 */
export type LeadDesk = "sales" | "pipeline"

export function leadDesk(lead: { communityId: string | null }, org: { customBuildNavigation: boolean }): LeadDesk {
  if (lead.communityId) return "sales"
  return org.customBuildNavigation ? "pipeline" : "sales"
}

/** Where a filed lead opens. */
export function leadDealHref(lead: { communityId: string | null; prospectId: string }, org: { customBuildNavigation: boolean }): string {
  return leadDesk(lead, org) === "sales"
    ? `/sales/${encodeURIComponent(`p:${lead.prospectId}`)}`
    : `/pipeline/${lead.prospectId}`
}
