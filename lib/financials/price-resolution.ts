export type PriceAgreementCandidate = {
  id: string
  company_id: string
  cost_code_id: string
  cost_type?: string | null
  division_id?: string | null
  community_id?: string | null
  house_plan_id?: string | null
  house_plan_version_id?: string | null
  pricing_kind: "unit" | "lump_sum"
  uom?: string | null
  unit_cost_cents?: number | null
  lump_sum_cents?: number | null
  scope_of_work?: string | null
  effective_from: string
  effective_to?: string | null
  status: "draft" | "active" | "expired" | "superseded" | "void" | string
}

export type PriceResolutionInput = {
  costCodeId: string
  costType?: string | null
  uom?: string | null
  quantity: number
  housePlanId?: string | null
  housePlanVersionId?: string | null
  communityId?: string | null
  divisionId?: string | null
  asOfDate: string
}

export type ResolvedPrice = {
  agreementId: string
  companyId: string
  pricingKind: "unit" | "lump_sum"
  unitCostCents?: number
  lumpSumCents?: number
  scopeOfWork?: string
}

export type PriceResolutionExceptionReason =
  | "no_agreement"
  | "expired_agreement"
  | "ambiguous_agreement"
  | "uom_mismatch"

export type PriceResolutionResult =
  | { resolved: ResolvedPrice; exception?: never }
  | { resolved?: never; exception: { reason: PriceResolutionExceptionReason; candidates: string[] } }

function sameOptionalScope(candidate: string | null | undefined, actual: string | null | undefined) {
  return candidate == null || candidate === actual
}

function isScopeCompatible(candidate: PriceAgreementCandidate, input: PriceResolutionInput) {
  return candidate.cost_code_id === input.costCodeId
    && sameOptionalScope(candidate.division_id, input.divisionId)
    && sameOptionalScope(candidate.community_id, input.communityId)
    && sameOptionalScope(candidate.house_plan_id, input.housePlanId)
    && sameOptionalScope(candidate.house_plan_version_id, input.housePlanVersionId)
    && (candidate.cost_type == null || input.costType == null || candidate.cost_type === input.costType)
}

function isEffective(candidate: PriceAgreementCandidate, asOfDate: string) {
  return candidate.status === "active"
    && candidate.effective_from <= asOfDate
    && (candidate.effective_to == null || candidate.effective_to >= asOfDate)
}

function specificity(candidate: PriceAgreementCandidate) {
  const primary = candidate.community_id != null && candidate.house_plan_id != null
    ? 4
    : candidate.house_plan_id != null
      ? 3
      : candidate.community_id != null
        ? 2
        : 1
  return [
    primary,
    candidate.division_id != null ? 1 : 0,
    candidate.house_plan_version_id != null ? 1 : 0,
    candidate.cost_type != null ? 1 : 0,
  ] as const
}

function compareSpecificity(a: PriceAgreementCandidate, b: PriceAgreementCandidate) {
  const left = specificity(a)
  const right = specificity(b)
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return right[index] - left[index]
  }
  return b.effective_from.localeCompare(a.effective_from)
}

function sameRankAndDate(a: PriceAgreementCandidate, b: PriceAgreementCandidate) {
  const left = specificity(a)
  const right = specificity(b)
  return left.every((value, index) => value === right[index])
    && a.effective_from === b.effective_from
}

export function resolvePriceForLinePure(
  input: PriceResolutionInput,
  candidates: PriceAgreementCandidate[],
): PriceResolutionResult {
  const scopeMatches = candidates.filter((candidate) => isScopeCompatible(candidate, input))
  const effective = scopeMatches.filter((candidate) => isEffective(candidate, input.asOfDate)).sort(compareSpecificity)

  if (effective.length === 0) {
    const hasDatedMatch = scopeMatches.some((candidate) =>
      candidate.status === "active" || candidate.status === "expired")
    return {
      exception: {
        reason: hasDatedMatch ? "expired_agreement" : "no_agreement",
        candidates: scopeMatches.map((candidate) => candidate.id),
      },
    }
  }

  const winner = effective[0]
  const tied = effective.filter((candidate) => sameRankAndDate(candidate, winner))
  if (tied.length > 1) {
    return {
      exception: {
        reason: "ambiguous_agreement",
        candidates: tied.map((candidate) => candidate.id).sort(),
      },
    }
  }

  if (winner.pricing_kind === "unit" && winner.uom?.trim().toLowerCase() !== input.uom?.trim().toLowerCase()) {
    return { exception: { reason: "uom_mismatch", candidates: [winner.id] } }
  }

  return {
    resolved: {
      agreementId: winner.id,
      companyId: winner.company_id,
      pricingKind: winner.pricing_kind,
      unitCostCents: winner.unit_cost_cents ?? undefined,
      lumpSumCents: winner.lump_sum_cents ?? undefined,
      scopeOfWork: winner.scope_of_work ?? undefined,
    },
  }
}

export function resolvedPriceTotal(input: PriceResolutionInput, resolved: ResolvedPrice) {
  return resolved.pricingKind === "lump_sum"
    ? Math.round(resolved.lumpSumCents ?? 0)
    : Math.round(input.quantity * (resolved.unitCostCents ?? 0))
}
