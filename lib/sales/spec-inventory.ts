/**
 * Standing-inventory age for spec homes.
 *
 * The 60/90-day tiers a sales manager watches are tiers of *standing* inventory:
 * a finished house nobody has bought. A home still under construction is
 * pipeline, not stale stock, so it has no aging clock — measuring from the
 * ground-breaking date makes every in-progress spec look aged the moment it
 * starts, which is the opposite of the signal.
 *
 * The clock starts at a RECORDED completion fact — the date Books moved the home
 * into finished inventory (`books_inventory_completed_on`), or for a home Books
 * does not carry, the date sales recorded on it (`projects.completed_on`, see
 * `specCompletionDate`). `projects.end_date`
 * is the schedule's plan and is never read here: a home that is late would age
 * before it exists, and one that finished early would not age at all. A home
 * with no recorded completion, or one recorded for a day that has not arrived,
 * reports no age.
 */
export type SpecInventoryAge = {
  completedAt: string | null
  underConstruction: boolean
  agingDays: number
}

const DAY_MS = 86_400_000

export function specInventoryAge(
  project: { status?: string | null } | null | undefined,
  recordedCompletionOn: string | null | undefined,
  now: number = Date.now(),
): SpecInventoryAge {
  if (!project) return { completedAt: null, underConstruction: false, agingDays: 0 }
  const completedMs = recordedCompletionOn ? Date.parse(recordedCompletionOn) : Number.NaN
  if (Number.isNaN(completedMs) || completedMs > now) {
    // Completed on paper but never recorded: finished, with no date to age from.
    return { completedAt: null, underConstruction: project.status !== "completed", agingDays: 0 }
  }
  return {
    completedAt: recordedCompletionOn ?? null,
    underConstruction: false,
    agingDays: Math.floor((now - completedMs) / DAY_MS),
  }
}

/**
 * The completion date a spec ages from: the one Books recorded when it moved the
 * home into finished inventory, else the one sales recorded on the home itself
 * (`projects.completed_on`) for a home Books does not carry. Books wins when both
 * exist, because it is the date the ledger moved the cost on.
 */
export function specCompletionDate(booksCompletedOn: string | null | undefined, recordedCompletedOn: string | null | undefined) {
  return booksCompletedOn ?? recordedCompletedOn ?? null
}

/**
 * A home's own incentive, as last decided. It lapses on its expiry date and on
 * sale: once a purchase agreement has been written on the home after the
 * incentive was decided, that sale used it, and a resale after a cancellation
 * starts without it.
 */
export function specHomeIncentiveInForce(
  incentive: { cents: number; expiresOn: string | null; decidedAt: string } | null,
  { latestAgreementAt, today }: { latestAgreementAt: string | null; today: string },
): number {
  if (!incentive || incentive.cents <= 0) return 0
  if (incentive.expiresOn && incentive.expiresOn < today) return 0
  if (latestAgreementAt && Date.parse(latestAgreementAt) >= Date.parse(incentive.decidedAt)) return 0
  return incentive.cents
}

/**
 * Why an approved disposition cannot be carried out yet, or null when it can. A
 * sale below what the home carries in Books needs an approved write-down first,
 * read from the impairment review itself — never inferred from the price.
 */
export function specDispositionExecutionBlock({
  status,
  priceCents,
  carryingCents,
  impairmentStatus,
}: {
  status: string
  priceCents: number
  carryingCents: number
  impairmentStatus: "proposed" | "approved" | "rejected" | null
}): string | null {
  if (status !== "approved") return "Only an approved disposition can be carried out."
  if (priceCents >= carryingCents) return null
  if (impairmentStatus === null) return "The price is below the home's cost in Books. Propose a write-down before selling."
  if (impairmentStatus !== "approved") return "The price is below the home's cost in Books. The write-down must be approved before selling."
  return null
}
