/**
 * Is this drawing set internally consistent?
 *
 * A construction set is a graph that claims to be complete. Sheets point at each
 * other by number — "5/A-501", "SEE S-201" — and specifications point at trades
 * that ought to have sheets. When a package is issued in a hurry, the claim
 * quietly stops being true: a callout survives a sheet that was pulled, a detail
 * sheet is referenced but never sent, a division is specified with nothing drawn
 * for it. Nobody finds out until a foreman is standing in the field looking for
 * A-514.
 *
 * Every check here is DETERMINISTIC. That is not an accident or a limitation —
 * it is the correct design. The callout graph is already extracted, the sheet
 * list is already known, and "does A-514 exist in this set" is a set-membership
 * test. Asking a model would make a reliable answer unreliable and cost money to
 * do it. The AI in drawings belongs where reading is genuinely required: title
 * blocks, symbols, what changed between two issues.
 *
 * Pure. Unit-tested in tests/set-coherence.test.js.
 */

/** Bump when the checks change so a stored report can be told apart. */
export const SET_COHERENCE_ALGO = "set-coherence-v1"

export interface CoherenceSheet {
  id: string
  sheetNumber: string
  discipline: string | null
  sheetTitle: string | null
}

export interface CoherenceCallout {
  /** Sheet the reference is printed on. */
  fromSheetNumber: string
  /** Sheet number as printed in the callout. */
  targetSheetNumber: string
}

/** Spec sections, for the drawings-versus-specs coverage check. */
export interface CoherenceSpecSection {
  division: string | null
  sectionNumber: string
  title: string | null
}

export type CoherenceFindingKind =
  | "missing_sheet"
  | "sequence_gap"
  | "orphan_sheet"
  | "uncovered_division"

export type CoherenceSeverity = "high" | "medium" | "low"

export interface CoherenceFinding {
  kind: CoherenceFindingKind
  severity: CoherenceSeverity
  /** The sheet number, or division code, the finding is about. */
  subject: string
  message: string
  /** Sheet numbers involved — who references a missing sheet, for instance. */
  relatedSheets: string[]
}

/**
 * Normalize a printed sheet number for comparison.
 *
 * Matches the callout extractor's own rule: separators and case vary freely
 * between the title block and the body of a drawing ("A-501" in a callout,
 * "A501" in the title block), and treating those as different sheets would make
 * every set look broken.
 */
export function normalizeSheetKey(value: string): string {
  return value.trim().toUpperCase().replace(/[\s._-]/g, "")
}

/**
 * Sheet numbers that reference the whole set by nature and must never be
 * reported as orphans: nothing points AT a cover sheet, and that is correct.
 */
const INDEX_SHEET_PATTERNS = [/^G/i, /^T/i, /^CS/i, /^A0/i, /^0/]

function looksLikeIndexSheet(sheetNumber: string): boolean {
  const key = normalizeSheetKey(sheetNumber)
  return INDEX_SHEET_PATTERNS.some((pattern) => pattern.test(key))
}

/** Split a sheet number into its discipline prefix and numeric position. */
export function parseSheetNumber(
  sheetNumber: string,
): { prefix: string; major: number; minor: number | null } | null {
  const match = normalizeSheetKey(sheetNumber).match(/^([A-Z]{1,3})(\d{1,4})(?:(\d{1,3}))?$/)
  if (!match) return null
  return {
    prefix: match[1],
    major: Number(match[2]),
    minor: match[3] ? Number(match[3]) : null,
  }
}

/**
 * Callouts pointing at sheets the set does not contain.
 *
 * The highest-value check in the file and the cheapest: the field WILL go
 * looking for these. Severity rises with how many different sheets reference the
 * missing one — a target three sheets point at is not a typo.
 */
export function findMissingSheets(
  sheets: CoherenceSheet[],
  callouts: CoherenceCallout[],
): CoherenceFinding[] {
  const known = new Set(sheets.map((sheet) => normalizeSheetKey(sheet.sheetNumber)))
  const referencedBy = new Map<string, { printed: string; from: Set<string> }>()

  for (const callout of callouts) {
    const key = normalizeSheetKey(callout.targetSheetNumber)
    if (!key || known.has(key)) continue
    const entry = referencedBy.get(key) ?? { printed: callout.targetSheetNumber, from: new Set() }
    entry.from.add(callout.fromSheetNumber)
    referencedBy.set(key, entry)
  }

  return [...referencedBy.entries()]
    .map(([, entry]) => {
      const from = [...entry.from].sort()
      return {
        kind: "missing_sheet" as const,
        // One reference could be a typo in the drawing; several is a sheet that
        // did not make it into the package.
        severity: (from.length >= 2 ? "high" : "medium") as CoherenceSeverity,
        subject: entry.printed,
        message:
          from.length === 1
            ? `${entry.printed} is referenced on ${from[0]} but is not in this set.`
            : `${entry.printed} is referenced on ${from.length} sheets but is not in this set.`,
        relatedSheets: from,
      }
    })
    .sort((a, b) => b.relatedSheets.length - a.relatedSheets.length)
}

/**
 * Gaps in a discipline's numbering.
 *
 * Only reported inside a run that is otherwise contiguous, and only for gaps of
 * one or two: architects skip numbers deliberately all the time (A-101 then
 * A-201 is a new series, not a hole), and a checker that cries wolf about those
 * is a checker people turn off.
 */
export function findSequenceGaps(sheets: CoherenceSheet[]): CoherenceFinding[] {
  const byPrefix = new Map<string, number[]>()

  for (const sheet of sheets) {
    const parsed = parseSheetNumber(sheet.sheetNumber)
    if (!parsed || parsed.minor !== null) continue
    const list = byPrefix.get(parsed.prefix) ?? []
    list.push(parsed.major)
    byPrefix.set(parsed.prefix, list)
  }

  const findings: CoherenceFinding[] = []

  for (const [prefix, numbers] of byPrefix) {
    const sorted = [...new Set(numbers)].sort((a, b) => a - b)
    // A series with one or two sheets tells you nothing about its numbering.
    if (sorted.length < 3) continue

    for (let index = 1; index < sorted.length; index++) {
      const gap = sorted[index] - sorted[index - 1]
      if (gap < 2 || gap > 3) continue
      // Series boundaries (100 → 200) are intentional, never a gap.
      if (Math.floor(sorted[index] / 100) !== Math.floor(sorted[index - 1] / 100)) continue

      const missing: string[] = []
      for (let value = sorted[index - 1] + 1; value < sorted[index]; value++) {
        missing.push(`${prefix}-${value}`)
      }
      findings.push({
        kind: "sequence_gap",
        severity: "low",
        subject: missing.join(", "),
        message: `${prefix} numbering skips ${missing.join(" and ")}. Confirm ${
          missing.length === 1 ? "it was" : "they were"
        } not meant to be issued.`,
        relatedSheets: [`${prefix}-${sorted[index - 1]}`, `${prefix}-${sorted[index]}`],
      })
    }
  }

  return findings
}

/**
 * Detail sheets nothing points at.
 *
 * A detail sheet exists to be called out from a plan. One that nothing
 * references is either unused work or — much more often — a plan whose callout
 * did not survive a revision. Cover sheets, index sheets and general-notes
 * sheets are exempt by nature.
 */
export function findOrphanSheets(
  sheets: CoherenceSheet[],
  callouts: CoherenceCallout[],
): CoherenceFinding[] {
  const referenced = new Set(callouts.map((callout) => normalizeSheetKey(callout.targetSheetNumber)))

  return sheets
    .filter((sheet) => {
      if (looksLikeIndexSheet(sheet.sheetNumber)) return false
      const parsed = parseSheetNumber(sheet.sheetNumber)
      // Only the detail series (500+ by convention) is expected to be called
      // out; a plan sheet standing on its own is completely normal.
      if (!parsed || parsed.major < 500) return false
      return !referenced.has(normalizeSheetKey(sheet.sheetNumber))
    })
    .map((sheet) => ({
      kind: "orphan_sheet" as const,
      severity: "low" as CoherenceSeverity,
      subject: sheet.sheetNumber,
      message: `${sheet.sheetNumber}${
        sheet.sheetTitle ? ` (${sheet.sheetTitle})` : ""
      } is not called out from any sheet in this set.`,
      relatedSheets: [],
    }))
}

/**
 * CSI divisions that are specified but have no drawings.
 *
 * The mapping between a CSI division and a drawing discipline is genuinely
 * loose, so this is deliberately conservative: only the handful of divisions
 * with an unambiguous discipline are checked, and the finding is worded as a
 * question rather than a defect. A division specified with nothing drawn is
 * usually fine (Division 01 is contractual); the cases below are the ones where
 * it usually is not.
 */
const DIVISION_DISCIPLINE: Record<string, { discipline: string; label: string }> = {
  "03": { discipline: "S", label: "Concrete" },
  "05": { discipline: "S", label: "Metals" },
  "21": { discipline: "FP", label: "Fire suppression" },
  "22": { discipline: "P", label: "Plumbing" },
  "23": { discipline: "M", label: "HVAC" },
  "26": { discipline: "E", label: "Electrical" },
  "31": { discipline: "C", label: "Earthwork" },
  "32": { discipline: "L", label: "Exterior improvements" },
}

export function findUncoveredDivisions(
  sheets: CoherenceSheet[],
  specSections: CoherenceSpecSection[],
): CoherenceFinding[] {
  const disciplines = new Set(
    sheets
      .map((sheet) => sheet.discipline ?? parseSheetNumber(sheet.sheetNumber)?.prefix ?? null)
      .filter((value): value is string => Boolean(value))
      .map((value) => value.toUpperCase()),
  )

  const seen = new Set<string>()
  const findings: CoherenceFinding[] = []

  for (const section of specSections) {
    const division = (section.division ?? section.sectionNumber.slice(0, 2)).padStart(2, "0")
    const mapping = DIVISION_DISCIPLINE[division]
    if (!mapping || seen.has(division)) continue
    if (disciplines.has(mapping.discipline)) continue
    seen.add(division)

    findings.push({
      kind: "uncovered_division",
      severity: "medium",
      subject: `Division ${division}`,
      message: `Division ${division} (${mapping.label}) is specified, but this set has no ${mapping.discipline} sheets.`,
      relatedSheets: [],
    })
  }

  return findings
}

const SEVERITY_ORDER: Record<CoherenceSeverity, number> = { high: 0, medium: 1, low: 2 }
const KIND_ORDER: Record<CoherenceFindingKind, number> = {
  missing_sheet: 0,
  uncovered_division: 1,
  orphan_sheet: 2,
  sequence_gap: 3,
}

export interface SetCoherenceReport {
  algo: string
  findings: CoherenceFinding[]
  /** Findings that would send someone looking for a sheet that is not there. */
  missingSheets: number
  sheetsChecked: number
  calloutsChecked: number
}

export function analyzeSetCoherence(input: {
  sheets: CoherenceSheet[]
  callouts: CoherenceCallout[]
  specSections?: CoherenceSpecSection[]
}): SetCoherenceReport {
  const findings = [
    ...findMissingSheets(input.sheets, input.callouts),
    ...findUncoveredDivisions(input.sheets, input.specSections ?? []),
    ...findOrphanSheets(input.sheets, input.callouts),
    ...findSequenceGaps(input.sheets),
  ].sort((a, b) => {
    const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
    if (bySeverity !== 0) return bySeverity
    return KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
  })

  return {
    algo: SET_COHERENCE_ALGO,
    findings,
    missingSheets: findings.filter((finding) => finding.kind === "missing_sheet").length,
    sheetsChecked: input.sheets.length,
    calloutsChecked: input.callouts.length,
  }
}
