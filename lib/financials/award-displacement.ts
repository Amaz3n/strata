import type { PriceAgreementCandidate } from "@/lib/financials/price-resolution"

/**
 * Which standing prices a price-book award replaces, and when each one ends.
 * `run_bid_award_price_agreements` applies this rule in SQL; a test binds the
 * two, because the award sheet shows the buyer this list before they commit.
 */
export type AwardScope = {
  costCodeId: string
  communityId: string | null
  housePlanId: string | null
}

function dayBefore(date: string) {
  const day = new Date(`${date}T00:00:00Z`)
  day.setUTCDate(day.getUTCDate() - 1)
  return day.toISOString().slice(0, 10)
}

export function displacedByAward(
  candidates: PriceAgreementCandidate[],
  scope: AwardScope,
  effectiveFrom: string,
): Array<{ agreement: PriceAgreementCandidate; endsOn: string }> {
  return candidates
    .filter((candidate) => candidate.status === "active"
      && candidate.cost_code_id === scope.costCodeId
      && (candidate.cost_type ?? null) === null
      && (candidate.division_id ?? null) === null
      && (candidate.community_id ?? null) === scope.communityId
      && (candidate.house_plan_id ?? null) === scope.housePlanId
      && (candidate.house_plan_version_id ?? null) === null
      && candidate.effective_from <= effectiveFrom
      && (candidate.effective_to == null || candidate.effective_to >= effectiveFrom))
    .map((agreement) => ({
      agreement,
      endsOn: agreement.effective_from < effectiveFrom ? dayBefore(effectiveFrom) : agreement.effective_from,
    }))
}
