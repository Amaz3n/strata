import { z } from "zod"
import { accountingCutoff } from "@/lib/services/books/subledger-settlements"

/** Operational snapshots describe when inputs were observed, not a reconstructed past. */
export function assertLiveSnapshotDate(asOf: string, today: string) {
  accountingCutoff(asOf)
  if (asOf !== today) throw new Error("Live WIP inputs can only be captured for today. Historical WIP requires dated inputs and review.")
}

export function requireRecognitionDate(periodEnd: string, today: string) {
  accountingCutoff(periodEnd)
  if (periodEnd > today) throw new Error("Cannot recognize revenue for a future period end")
}

export function exactPeriodPosition<T extends { asOf: string }>(position: T | undefined, periodEnd: string): T | null {
  return position?.asOf === periodEnd ? position : null
}

export type WipSnapshotEvidence = {
  projectId: string
  snapshotId: string
  inputsHash: string
  asOf: string
  earnedRevenueCents: number
  warnings: string[]
}

export function wipSnapshotEvidence(positions: Map<string, WipSnapshotEvidence>, projectIds: string[]): WipSnapshotEvidence[] {
  return [...new Set(projectIds)].sort().flatMap(projectId => {
    const position = positions.get(projectId)
    return position ? [{ projectId, snapshotId: position.snapshotId, inputsHash: position.inputsHash, asOf: position.asOf, earnedRevenueCents: position.earnedRevenueCents, warnings: [...position.warnings].sort() }] : []
  })
}

export function assertReviewedWipUnchanged(expected: WipSnapshotEvidence[], actual: WipSnapshotEvidence[]) {
  const normalize = (rows: WipSnapshotEvidence[]) => [...rows].sort((a, b) => a.projectId.localeCompare(b.projectId))
  if (JSON.stringify(normalize(expected)) !== JSON.stringify(normalize(actual))) throw new Error("WIP snapshot evidence changed after close review; rerun the checklist")
}

export const wipReviewSchema = z.object({
  reviewerId: z.string().uuid(), reviewedAt: z.string().datetime({ offset: true }), note: z.string().trim().min(10),
  snapshots: z.array(z.object({ projectId: z.string().uuid(), snapshotId: z.string().uuid(), inputsHash: z.string().min(1), asOf: z.string().date(), earnedRevenueCents: z.number().int().safe(), warnings: z.array(z.string()) })).min(1),
})
export function wipReviewMatches(review: unknown, current: WipSnapshotEvidence[]) {
  const parsed = wipReviewSchema.safeParse(review)
  if (!parsed.success) return false
  try { assertReviewedWipUnchanged(parsed.data.snapshots, current); return true } catch { return false }
}
