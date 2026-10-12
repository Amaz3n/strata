import { z } from "zod"

import type { AffectedHomeState } from "@/lib/plans/plan-change-impact"
import type { ProductRevisionSet } from "@/lib/plans/product-revisions"

/**
 * Who an edit to an elevation or a catalog option reaches before it is saved.
 *
 * A definition edit saves at once and is seen by every home not yet sold. A
 * sold home is not moved by it: its agreement recorded the revision and price it
 * was sold at (`home_product_revisions`, stage `agreement`) and its release the
 * revision it was built from (stage `release`), and those records never change.
 * The impact list is how the person editing sees which homes those are.
 */

export const PRODUCT_CHANGE_ENTITIES = ["elevation", "option"] as const
export type ProductChangeEntity = (typeof PRODUCT_CHANGE_ENTITIES)[number]

export const productChangeImpactInputSchema = z.object({
  entity: z.enum(PRODUCT_CHANGE_ENTITIES),
  id: z.string().uuid(),
})
export type ProductChangeImpactInput = z.infer<typeof productChangeImpactInputSchema>

/** One list for one edit. Past this the list says it is cut off rather than reading every home in the org. */
export const PRODUCT_CHANGE_HOME_CAP = 1_000

export type ProductChangeHome = {
  /** The home's project, or the lot when nothing is built on it yet. */
  key: string
  lotId: string | null
  lotLabel: string | null
  communityName: string | null
  projectId: string | null
  projectName: string | null
  buyerName: string | null
  state: AffectedHomeState
  /** The revision its purchase agreement recorded; null when it recorded none of this item. */
  soldRevision: number | null
  /** The revision its start release recorded; null when it has not been released with this item. */
  releasedRevision: number | null
}

export type ProductChangeImpactSummary = {
  counts: Record<AffectedHomeState, number>
  /** Contracted and released homes: the ones a buyer has signed for. */
  soldCount: number
}

/**
 * The revision of an elevation or option a recorded set holds. Undefined when
 * the set does not hold it at all; null when it holds it without a known
 * revision (recorded before revisions were kept).
 */
export function recordedRevisionOf(set: ProductRevisionSet, entity: ProductChangeEntity, id: string): number | null | undefined {
  if (entity === "elevation") return set.elevation?.id === id ? set.elevation.revision : undefined
  const ref = set.options.find((option) => option.id === id)
  return ref ? ref.revision : undefined
}

export function summarizeProductChangeImpact(homes: readonly Pick<ProductChangeHome, "state">[]): ProductChangeImpactSummary {
  const counts: Record<AffectedHomeState, number> = { unsold: 0, spec: 0, contracted: 0, released: 0 }
  for (const home of homes) counts[home.state] += 1
  return { counts, soldCount: counts.contracted + counts.released }
}

const STATE_ORDER: Record<AffectedHomeState, number> = { released: 0, contracted: 1, spec: 2, unsold: 3 }

/** Sold homes first (they carry the promise), then by community and lot. */
export function orderProductChangeHomes<Home extends ProductChangeHome>(homes: readonly Home[]): Home[] {
  return [...homes].sort((a, b) =>
    STATE_ORDER[a.state] - STATE_ORDER[b.state]
    || (a.communityName ?? "").localeCompare(b.communityName ?? "")
    || (a.lotLabel ?? a.projectName ?? "").localeCompare(b.lotLabel ?? b.projectName ?? "", undefined, { numeric: true }))
}

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`
}

/** The confirm step's headline. */
export function productChangeHeadline(summary: ProductChangeImpactSummary, total: number): string {
  if (summary.soldCount > 0) return `This change reaches ${plural(summary.soldCount, "sold home")}`
  return `This change reaches ${plural(total, "home")}, none sold`
}

