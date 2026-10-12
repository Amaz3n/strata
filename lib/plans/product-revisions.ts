import { z } from "zod"

/**
 * The product a home was priced or released against, as revisions: the plan
 * version (released versions are immutable, so the number is the identity of
 * its takeoff and template bundle), the elevation's revision and each catalog
 * option's and package's revision. Recorded once per home and stage
 * (`home_product_revisions`); compared with today's revisions to say what
 * changed since.
 */

const revisionRefSchema = z.object({
  id: z.string(),
  revision: z.number().int().positive().nullable(),
  /** The revision was not recorded when the item was chosen (a selection older than that record); this is its revision when the set was captured. */
  inferred: z.literal(true).optional(),
})

export const productRevisionSetSchema = z.object({
  planVersion: z.object({ id: z.string(), number: z.number().int().positive().nullable() }).nullable(),
  elevation: z.object({ id: z.string(), code: z.string().nullable(), revision: z.number().int().positive().nullable() }).nullable(),
  options: z.array(revisionRefSchema),
  packages: z.array(revisionRefSchema),
})

/** How many revisions of one definition a history view lists, newest first. */
export const REVISION_HISTORY_CAP = 50

export type RevisionRef = z.infer<typeof revisionRefSchema>
export type ProductRevisionSet = z.infer<typeof productRevisionSetSchema>

function normalizeRefs(refs: readonly RevisionRef[]): RevisionRef[] {
  const byId = new Map<string, RevisionRef>()
  for (const ref of refs) {
    const seen = byId.get(ref.id)
    // One home cannot hold two revisions of one option; the newer is the one it holds.
    if (!seen || (ref.revision ?? 0) > (seen.revision ?? 0)) byId.set(ref.id, ref.inferred ? { id: ref.id, revision: ref.revision, inferred: true } : { id: ref.id, revision: ref.revision })
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
}

/** One canonical set: options and packages de-duplicated and ordered by id, so equal sets serialize equally. */
export function buildRevisionSet(input: {
  planVersion: ProductRevisionSet["planVersion"]
  elevation: ProductRevisionSet["elevation"]
  options: readonly RevisionRef[]
  packages: readonly RevisionRef[]
}): ProductRevisionSet {
  return {
    planVersion: input.planVersion ? { id: input.planVersion.id, number: input.planVersion.number } : null,
    elevation: input.elevation ? { id: input.elevation.id, code: input.elevation.code, revision: input.elevation.revision } : null,
    options: normalizeRefs(input.options),
    packages: normalizeRefs(input.packages),
  }
}

export type RevisionChangeKind = "plan_version" | "elevation" | "option" | "package"

export type RevisionChange = {
  kind: RevisionChangeKind
  id: string
  change: "changed" | "added" | "removed"
  from: number | null
  to: number | null
}

function diffRefs(kind: "option" | "package", recorded: readonly RevisionRef[], current: readonly RevisionRef[]): RevisionChange[] {
  const now = new Map(current.map((ref) => [ref.id, ref]))
  const then = new Map(recorded.map((ref) => [ref.id, ref]))
  const changes: RevisionChange[] = []
  for (const ref of recorded) {
    const later = now.get(ref.id)
    if (!later) changes.push({ kind, id: ref.id, change: "removed", from: ref.revision, to: null })
    else if (later.revision !== ref.revision) changes.push({ kind, id: ref.id, change: "changed", from: ref.revision, to: later.revision })
  }
  for (const ref of current) {
    if (!then.has(ref.id)) changes.push({ kind, id: ref.id, change: "added", from: null, to: ref.revision })
  }
  return changes
}

/**
 * What differs between a recorded set and another (usually today's). A
 * different plan version or elevation is a change of that slot; options and
 * packages are matched by id. Empty means the home still matches its record.
 */
export function diffRevisionSets(recorded: ProductRevisionSet, current: ProductRevisionSet): RevisionChange[] {
  const changes: RevisionChange[] = []
  const a = recorded.planVersion
  const b = current.planVersion
  if (a?.id !== b?.id || a?.number !== b?.number) {
    changes.push({ kind: "plan_version", id: b?.id ?? a?.id ?? "", change: !a ? "added" : !b ? "removed" : "changed", from: a?.number ?? null, to: b?.number ?? null })
  }
  const e = recorded.elevation
  const f = current.elevation
  if (e?.id !== f?.id || e?.revision !== f?.revision) {
    changes.push({ kind: "elevation", id: f?.id ?? e?.id ?? "", change: !e ? "added" : !f ? "removed" : "changed", from: e?.revision ?? null, to: f?.revision ?? null })
  }
  return [...changes, ...diffRefs("option", recorded.options, current.options), ...diffRefs("package", recorded.packages, current.packages)]
}

const CHANGE_SUBJECTS: Record<RevisionChangeKind, string> = { plan_version: "Plan version", elevation: "Elevation", option: "Option", package: "Package" }

/** One change as a builder reads it: "Elevation r1 → r2", "Plan v3 → v4", "Option no longer in the catalog". */
export function describeRevisionChange(change: RevisionChange): string {
  const subject = CHANGE_SUBJECTS[change.kind]
  if (change.change === "removed") return `${subject} no longer in the catalog`
  if (change.change === "added") return `${subject} added at r${change.to ?? "—"}`
  if (change.kind === "plan_version") return `Plan v${change.from ?? "—"} → v${change.to ?? "—"}`
  return `${subject} r${change.from ?? "—"} → r${change.to ?? "—"}`
}

/**
 * The revision an entity stood at, at a moment: the newest revision recorded
 * at or before it. Null when the entity had no revision yet.
 */
export function revisionAsOf(history: ReadonlyArray<{ entityId: string; revision: number; createdAt: string }>, entityId: string, at: string): number | null {
  const cutoff = Date.parse(at)
  let found: number | null = null
  for (const row of history) {
    if (row.entityId !== entityId || Date.parse(row.createdAt) > cutoff) continue
    if (found === null || row.revision > found) found = row.revision
  }
  return found
}

const releasedElevationsSchema = z.object({
  elevations: z.array(z.object({ code: z.string(), revision: z.number().int().positive() })),
})

/**
 * The elevations a released plan version recorded at release, "A r1 · B r2".
 * Null for a draft, or a version released before releases recorded them.
 */
export function describeReleasedElevations(bundleSnapshot: unknown): string | null {
  const parsed = releasedElevationsSchema.safeParse(bundleSnapshot)
  if (!parsed.success || parsed.data.elevations.length === 0) return null
  return parsed.data.elevations.map((elevation) => `${elevation.code} r${elevation.revision}`).join(" · ")
}

/** "Plan v3 · elevation B r2 · 4 options" — the sentence a home's record reads as. */
export function describeRevisionSet(set: ProductRevisionSet): string {
  const items = set.options.length + set.packages.length
  return [
    `plan v${set.planVersion?.number ?? "—"}`,
    set.elevation ? `elevation ${set.elevation.code ?? "—"} r${set.elevation.revision ?? "—"}` : "base elevation",
    `${items} option${items === 1 ? "" : "s"}`,
  ].join(" · ")
}
