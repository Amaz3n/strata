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

/**
 * What one WIP position is about: a project, or one contract of a project that
 * has more than one in force (B04.1). Never inferred from row order.
 */
export type WipScope = { projectId: string; contractId: string | null }

export function wipScopeKey(scope: WipScope) {
  return scope.contractId ? `${scope.projectId}:${scope.contractId}` : scope.projectId
}

export type WipSnapshotEvidence = {
  projectId: string
  contractId: string | null
  snapshotId: string
  inputsHash: string
  asOf: string
  earnedRevenueCents: number
  warnings: string[]
}

function normalizeEvidence(row: WipSnapshotEvidence): WipSnapshotEvidence {
  return { projectId: row.projectId, contractId: row.contractId ?? null, snapshotId: row.snapshotId, inputsHash: row.inputsHash, asOf: row.asOf, earnedRevenueCents: row.earnedRevenueCents, warnings: [...row.warnings].sort() }
}

export function wipSnapshotEvidence(positions: Map<string, WipSnapshotEvidence>, scopes: WipScope[]): WipSnapshotEvidence[] {
  const keys = [...new Map(scopes.map(scope => [wipScopeKey(scope), scope])).values()].sort((a, b) => wipScopeKey(a).localeCompare(wipScopeKey(b)))
  return keys.flatMap(scope => {
    const position = positions.get(wipScopeKey(scope))
    return position ? [normalizeEvidence({ ...position, projectId: scope.projectId, contractId: scope.contractId })] : []
  })
}

export function assertReviewedWipUnchanged(expected: WipSnapshotEvidence[], actual: WipSnapshotEvidence[]) {
  const normalize = (rows: WipSnapshotEvidence[]) => rows.map(normalizeEvidence).sort((a, b) => wipScopeKey(a).localeCompare(wipScopeKey(b)))
  if (JSON.stringify(normalize(expected)) !== JSON.stringify(normalize(actual))) throw new Error("WIP snapshot evidence changed after close review; rerun the checklist")
}

export const wipReviewSchema = z.object({
  reviewerId: z.string().uuid(), reviewedAt: z.string().datetime({ offset: true }), note: z.string().trim().min(10),
  // Reviews saved before contract scopes existed are project-scoped.
  snapshots: z.array(z.object({ projectId: z.string().uuid(), contractId: z.string().uuid().nullable().default(null), snapshotId: z.string().uuid(), inputsHash: z.string().min(1), asOf: z.string().date(), earnedRevenueCents: z.number().int().safe(), warnings: z.array(z.string()) })).min(1),
})
export function wipReviewMatches(review: unknown, current: WipSnapshotEvidence[]) {
  const parsed = wipReviewSchema.safeParse(review)
  if (!parsed.success) return false
  try { assertReviewedWipUnchanged(parsed.data.snapshots, current); return true } catch { return false }
}
