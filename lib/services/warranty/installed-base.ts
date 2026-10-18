import { z } from "zod"
import { addCalendarMonths, type WarrantyCoverageTerm } from "@/lib/services/warranty/domain"

/** The terms a closed-home row can state in months, by the key the default programs use. */
const EXPLICIT_TERMS = [
  { column: "workmanship_months", key: "workmanship", label: "Workmanship & materials", is_structural: false },
  { column: "systems_months", key: "systems", label: "Major systems", is_structural: false },
  { column: "structural_months", key: "structural", label: "Structural", is_structural: true },
] as const

export interface InstalledHomeTermInput {
  /** The named program's terms, or null when the row names no program. */
  programTerms: readonly WarrantyCoverageTerm[] | null
  explicit: Partial<Record<(typeof EXPLICIT_TERMS)[number]["column"], number | null>>
}

/**
 * The terms a home was sold with. A named program supplies its terms; months
 * stated on the row replace the program's term of that key (or add it). A row
 * that names no program and states months carries exactly those terms and
 * nothing the org's current default happens to include.
 */
export function resolveInstalledHomeTerms(input: InstalledHomeTermInput): { terms: WarrantyCoverageTerm[] } | { error: string } {
  const terms = new Map<string, WarrantyCoverageTerm>((input.programTerms ?? []).map(term => [term.key, term]))
  for (const spec of EXPLICIT_TERMS) {
    const months = input.explicit[spec.column]
    if (months == null) continue
    if (!Number.isInteger(months) || months < 1 || months > 1200) return { error: `${spec.label} must be 1 to 1200 months` }
    const existing = terms.get(spec.key)
    terms.set(spec.key, existing ? { ...existing, duration_months: months } : { key: spec.key, label: spec.label, duration_months: months, is_structural: spec.is_structural, description: null })
  }
  if (terms.size === 0) return { error: "Name the warranty program or give the term months the home was sold with" }
  return { terms: [...terms.values()] }
}

export const installedHomeTermsSchema = z.array(z.object({ key: z.string().min(1), label: z.string().min(1), duration_months: z.number().int().min(1).max(1200), is_structural: z.boolean(), description: z.string().nullable() })).min(1).max(1000)

export interface CoverageRow {
  projectId: string
  effectiveDate: string
  terms: ReadonlyArray<{ key: string; duration_months: number; expires_on: string }>
}

export interface ClosedHomeRow {
  projectId: string
  lotId: string | null
  /** The lot's identity as staging reads it: community, then lot and block with case and spacing folded. */
  lotKey?: string
  closedOn: string
  coverage: readonly CoverageRow[]
}

export type CoverageExceptionKind = "uncovered" | "duplicate_lot" | "covered_twice" | "date_mismatch" | "term_mismatch"

export interface CoverageException {
  kind: CoverageExceptionKind
  projectId: string
  detail: string
}

/** Closed homes that no live coverage reaches, that two reach, or whose dates disagree with closing plus term. */
export function classifyCoverage(homes: readonly ClosedHomeRow[], asOf: string) {
  const exceptions: CoverageException[] = []
  const lotCoverage = new Map<string, string[]>()
  let covered = 0, active = 0, expired = 0
  for (const home of homes) {
    if (home.coverage.length === 0) { exceptions.push({ kind: "uncovered", projectId: home.projectId, detail: `Closed ${home.closedOn} with no warranty coverage` }); continue }
    covered += 1
    if (home.coverage.length > 1) exceptions.push({ kind: "covered_twice", projectId: home.projectId, detail: `${home.coverage.length} live coverages` })
    if (home.lotId) lotCoverage.set(home.lotId, [...(lotCoverage.get(home.lotId) ?? []), home.projectId])
    const [live] = home.coverage
    if (live.effectiveDate !== home.closedOn) exceptions.push({ kind: "date_mismatch", projectId: home.projectId, detail: `Coverage starts ${live.effectiveDate}, closing was ${home.closedOn}` })
    const wrong = live.terms.filter(term => term.expires_on !== addCalendarMonths(home.closedOn, term.duration_months)).map(term => term.key)
    if (wrong.length > 0) exceptions.push({ kind: "term_mismatch", projectId: home.projectId, detail: `${wrong.join(", ")} do not end closing plus term` })
    if (live.terms.some(term => term.expires_on >= asOf)) active += 1
    else expired += 1
  }
  const byKey = new Map<string, Map<string, string[]>>()
  for (const home of homes) {
    if (!home.lotKey || !home.lotId) continue
    const lots = byKey.get(home.lotKey) ?? new Map<string, string[]>()
    lots.set(home.lotId, [...(lots.get(home.lotId) ?? []), home.projectId])
    byKey.set(home.lotKey, lots)
  }
  for (const lots of byKey.values()) {
    if (lots.size > 1) for (const projects of lots.values()) for (const projectId of projects) exceptions.push({ kind: "duplicate_lot", projectId, detail: `${lots.size} lots share this lot number once case and spacing are ignored` })
  }
  for (const [lotId, projects] of lotCoverage) {
    if (projects.length > 1) for (const projectId of projects) exceptions.push({ kind: "covered_twice", projectId, detail: `Lot ${lotId} is covered through ${projects.length} homes` })
  }
  return { homes: homes.length, covered, active, expired, exceptions }
}
