/**
 * Sheet-to-sheet callout link extraction.
 *
 * Construction sets are a web of cross-references: a plan flags a wall section
 * as `5/A-501` ("detail 5 on sheet A-501"), a note says "SEE STRUCTURAL S2.1".
 * This module turns a sheet's positioned text runs (`text-runs.json`, see
 * `./text-runs.ts`) into clickable regions that jump to the referenced sheet.
 *
 * PRECISION OVER RECALL — a wrong jump is worse than a missing one. Every rule
 * below leans conservative:
 *
 * - Bare sheet-number tokens ("A-501" on its own) are emitted ONLY when they
 *   match a sheet that actually exists on the project. Drawings are covered in
 *   sheet-number-shaped text (grid bubbles, door tags, beam sizes, keynotes);
 *   the known-sheet set is the precision lever that separates "A-501" the
 *   reference from "A101" the door tag on a project with no such sheet.
 * - Detail-bubble pairs (`5/A-501`) carry strong structural evidence — a
 *   detail token and a sheet token joined by a slash — so they are emitted
 *   even when the target is not (yet) a known sheet, at reduced confidence.
 *   They only become clickable once the target sheet exists, because
 *   resolution to a sheet id happens at read time (`resolveCalloutLinks`).
 * - The sheet token must start with 1–3 discipline letters and contain digits.
 *   Sets numbered "1", "2.1" without a letter prefix never match; on a
 *   drawing, bare numbers are dimensions, not references.
 * - Fractions and dates never match: the sheet side of a slash pair requires a
 *   letter prefix, so `1/2"`, `5/8` and `5/8/2026` all fail structurally.
 * - The sheet's OWN number is excluded. Title blocks and revision tables
 *   repeat it on every sheet; linking a sheet to itself is always garbage.
 * - Known sheet numbers that collide after normalization (say "A2.1" and
 *   "A-21" both normalize to "A21") are treated as ambiguous and dropped
 *   entirely — a link that might jump to the wrong one of two sheets is worse
 *   than no link.
 * - Per-run and per-sheet caps bound legend paragraphs and index sheets. An
 *   index sheet legitimately references every sheet in the set (each row is a
 *   useful link), so it is capped and flagged `truncated`, not suppressed.
 *
 * Pure and I/O-free: no imports beyond the TextRun type, fully unit-testable.
 */

import type { TextRun } from "./text-runs"

/** Bump to re-extract every sheet's links when the algorithm changes. */
export const CALLOUT_LINKS_ALGO = "callout-links-v1"

/**
 * Hard cap on links stored per sheet. Index sheets on a 900-sheet commercial
 * set would otherwise store thousands of rows of JSONB on one version.
 */
export const MAX_CALLOUT_LINKS_PER_SHEET = 200

/**
 * Cap per text run. A note line can legitimately reference a handful of
 * sheets ("SEE A-501, A-502 AND A-503"); a run with dozens of matches is a
 * legend paragraph whose links would be noise.
 */
const MAX_LINKS_PER_RUN = 8

export interface CalloutLink {
  /** Normalized bbox of the text that references another sheet. */
  x: number
  y: number
  w: number
  h: number
  /** The sheet number as printed, e.g. "A-501". */
  targetSheetNumber: string
  /** Optional detail/section number, e.g. the "5" in 5/A-501. */
  detail?: string
  /** How the match was made — for debugging and for tuning thresholds later. */
  kind: "detail_bubble" | "sheet_reference"
  confidence: number
}

export interface CalloutExtractionResult {
  links: CalloutLink[]
  /** True when the per-sheet cap dropped candidates. */
  truncated: boolean
}

/** A CalloutLink whose printed target resolved to a real project sheet. */
export interface ResolvedCalloutLink extends CalloutLink {
  targetSheetId: string
}

/** Shape stored under `extracted_metadata.callout_links`. */
export interface StoredCalloutLinks {
  algo: string
  links: CalloutLink[]
  truncated: boolean
  computed_at?: string
}

const CONFIDENCE = {
  /** Slash pair AND the target exists on the project. */
  detailBubbleKnown: 0.95,
  /** Slash pair alone — becomes clickable if the target sheet ever exists. */
  detailBubbleUnknown: 0.5,
  /** Bare token printed exactly as the known sheet number. */
  bareExact: 0.8,
  /** Bare token that only matches after aggressive normalization. */
  bareNormalized: 0.65,
} as const

/**
 * A sheet number token: 1–3 discipline letters, optional separator, digits,
 * optional decimal/dash suffix and trailing revision letter. Covers A-501,
 * A501, S2.1, M-101, FP-1, A5.01B. Deliberately does NOT allow spaces inside
 * the token — "PLAN A 3" must not read as sheet A-3; normalization handles
 * spacing differences on the KNOWN side instead.
 */
const SHEET_PART = "[A-Za-z]{1,3}[-.]?\\d{1,4}(?:[.-]\\d{1,3})?[A-Za-z]?"

/** A detail/section token: 1–3 digits with optional letter, or one letter. */
const DETAIL_PART = "(?:\\d{1,3}[A-Za-z]?|[A-Za-z])"

/**
 * `5/A-501` — detail first. Lookarounds forbid alphanumeric (or code-joining
 * punctuation) neighbours so "W8/A-501" and "1 1/2" never partially match.
 */
const DETAIL_SLASH_SHEET = new RegExp(
  `(?<![A-Za-z0-9/.-])(${DETAIL_PART})\\s*/\\s*(${SHEET_PART})(?![A-Za-z0-9/])`,
  "g",
)

/** `A-501/5` — sheet first. */
const SHEET_SLASH_DETAIL = new RegExp(
  `(?<![A-Za-z0-9/.-])(${SHEET_PART})\\s*/\\s*(${DETAIL_PART})(?![A-Za-z0-9/])`,
  "g",
)

/** A bare sheet token, not glued to surrounding codes or a slash pair. */
const BARE_SHEET = new RegExp(
  `(?<![A-Za-z0-9/.-])(${SHEET_PART})(?![A-Za-z0-9/-])`,
  "g",
)

/**
 * Collapse a sheet number for comparison: case, spaces, hyphens, periods,
 * underscores and slashes all go, so `A501`, `A-501`, `a 501` and `A.501`
 * meet at "A501". Display always uses the number AS PRINTED; this form is
 * only ever a map key.
 */
export function normalizeSheetNumber(raw: string): string {
  return raw.toUpperCase().replace(/[\s._/-]+/g, "")
}

interface IndexEntry<T> {
  number: string
  value: T
}

/**
 * normalized number -> entry, with `null` marking an ambiguous key (two
 * DIFFERENT printed numbers collapsing to one normalized form). Ambiguous
 * keys are dropped by both extraction and resolution: guessing between two
 * real sheets is exactly the wrong jump this module exists to avoid.
 * (project, sheet_number) is unique in the schema, so identical printed
 * numbers cannot occur; identical inputs defensively keep the first entry.
 */
function buildSheetNumberIndex<T>(
  entries: Iterable<IndexEntry<T>>,
): Map<string, IndexEntry<T> | null> {
  const index = new Map<string, IndexEntry<T> | null>()
  for (const entry of entries) {
    const number = typeof entry.number === "string" ? entry.number.trim() : ""
    if (!number) continue
    const key = normalizeSheetNumber(number)
    if (!key) continue
    const existing = index.get(key)
    if (existing === undefined) {
      index.set(key, { number, value: entry.value })
    } else if (existing !== null && existing.number.toUpperCase() !== number.toUpperCase()) {
      index.set(key, null)
    }
  }
  return index
}

/** Case/whitespace-insensitive equality WITHOUT separator collapsing. */
function printedMatchesExactly(printed: string, known: string): boolean {
  const strip = (value: string) => value.toUpperCase().replace(/\s+/g, "")
  return strip(printed) === strip(known)
}

const round5 = (value: number) => Math.round(value * 1e5) / 1e5

/**
 * Bbox for a character span inside a run, by proportional slicing. Drawing
 * text is close enough to monospace that this lands the click target on the
 * token rather than the whole note line ("REFER TO A-501 FOR DETAILS").
 */
function sliceRunBbox(
  run: TextRun,
  start: number,
  end: number,
): { x: number; y: number; w: number; h: number } {
  const length = Math.max(1, run.text.length)
  return {
    x: round5(run.x + run.w * (start / length)),
    y: round5(run.y),
    w: round5(run.w * ((end - start) / length)),
    h: round5(run.h),
  }
}

interface Span {
  start: number
  end: number
}

function overlaps(spans: Span[], start: number, end: number): boolean {
  return spans.some((span) => start < span.end && end > span.start)
}

/** True when a printed sheet token is structurally strong enough to trust
 * WITHOUT the known-sheet gate: an explicit separator or 2+ digits. "A-5",
 * "A5.1" and "A501" qualify; "C2" could just as easily be a wall type. */
function sheetTokenIsStrong(printed: string): boolean {
  if (/[-.]/.test(printed)) return true
  return (printed.match(/\d/g) ?? []).length >= 2
}

export function extractCalloutLinks(input: {
  runs: TextRun[]
  /** Sheet numbers that exist on the project, as stored. */
  knownSheetNumbers: Iterable<string>
  /** This sheet's own number — its self-references are never links. */
  ownSheetNumber?: string | null
  /** Override for tests; defaults to MAX_CALLOUT_LINKS_PER_SHEET. */
  maxLinks?: number
}): CalloutExtractionResult {
  const maxLinks = input.maxLinks ?? MAX_CALLOUT_LINKS_PER_SHEET
  const known = buildSheetNumberIndex(
    Array.from(input.knownSheetNumbers, (number) => ({ number, value: number })),
  )
  const ownKey = input.ownSheetNumber ? normalizeSheetNumber(input.ownSheetNumber) : ""

  const candidates: CalloutLink[] = []
  const seen = new Set<string>()

  const push = (link: CalloutLink): boolean => {
    // Exact-duplicate bboxes happen when overlapping text layers repeat a
    // token; each DISTINCT position stays (twenty A-501 bubbles on a plan are
    // twenty click targets), identical ones collapse.
    const key = [
      link.kind,
      normalizeSheetNumber(link.targetSheetNumber),
      link.detail ?? "",
      link.x,
      link.y,
      link.w,
      link.h,
    ].join("|")
    if (seen.has(key)) return false
    seen.add(key)
    candidates.push(link)
    return true
  }

  for (const run of input.runs) {
    const text = run.text
    if (!text) continue
    const consumed: Span[] = []
    let runCount = 0

    const scanDetailBubbles = (regex: RegExp, sheetGroup: 1 | 2) => {
      for (const match of text.matchAll(regex)) {
        if (runCount >= MAX_LINKS_PER_RUN) return
        const start = match.index ?? 0
        const end = start + match[0].length
        if (overlaps(consumed, start, end)) continue
        const sheetPrinted = match[sheetGroup]
        const detailPrinted = match[sheetGroup === 1 ? 2 : 1]
        // Either way, this span can never also be a bare reference.
        consumed.push({ start, end })

        const key = normalizeSheetNumber(sheetPrinted)
        if (!key || key === ownKey) continue
        const entry = known.get(key)
        if (entry === null) continue // ambiguous — see buildSheetNumberIndex
        if (entry === undefined) {
          // Unknown target: kept on slash-pair syntax alone, but only when
          // both halves pull their weight — a digit-bearing detail and a
          // strong sheet token. "5/C2" stays out; "5/A-501" gets stored and
          // resolves the day A-501 is uploaded.
          if (!/\d/.test(detailPrinted)) continue
          if (!sheetTokenIsStrong(sheetPrinted)) continue
        }
        if (
          push({
            ...sliceRunBbox(run, start, end),
            targetSheetNumber: sheetPrinted,
            detail: detailPrinted,
            kind: "detail_bubble",
            confidence: entry ? CONFIDENCE.detailBubbleKnown : CONFIDENCE.detailBubbleUnknown,
          })
        ) {
          runCount += 1
        }
      }
    }

    scanDetailBubbles(DETAIL_SLASH_SHEET, 2)
    scanDetailBubbles(SHEET_SLASH_DETAIL, 1)

    for (const match of text.matchAll(BARE_SHEET)) {
      if (runCount >= MAX_LINKS_PER_RUN) break
      const start = match.index ?? 0
      const end = start + match[0].length
      if (overlaps(consumed, start, end)) continue
      const printed = match[1]
      const key = normalizeSheetNumber(printed)
      if (!key || key === ownKey) continue
      const entry = known.get(key)
      // Bare tokens NEVER link to unknown or ambiguous sheets — this gate is
      // what keeps door tags and grid marks from becoming jumps to nowhere.
      if (!entry) continue
      if (
        push({
          ...sliceRunBbox(run, start, end),
          targetSheetNumber: printed,
          kind: "sheet_reference",
          confidence: printedMatchesExactly(printed, entry.number)
            ? CONFIDENCE.bareExact
            : CONFIDENCE.bareNormalized,
        })
      ) {
        runCount += 1
      }
    }
  }

  if (candidates.length <= maxLinks) {
    return { links: candidates, truncated: false }
  }

  // Over the cap: keep the highest-confidence links (detail bubbles beat bare
  // index rows), then restore reading order so output stays deterministic.
  const ranked = candidates
    .map((link, index) => ({ link, index }))
    .sort((a, b) => b.link.confidence - a.link.confidence || a.index - b.index)
    .slice(0, maxLinks)
    .sort((a, b) => a.index - b.index)
  return { links: ranked.map((entry) => entry.link), truncated: true }
}

/**
 * Resolve printed target numbers against the project's CURRENT sheets.
 *
 * Resolution is deliberately late: links store the number as printed, so a
 * sheet uploaded after extraction, or renumbered since, resolves correctly
 * with no re-extraction pass. Unresolved and ambiguous targets are filtered
 * out — the viewer only ever receives links it can actually navigate — and a
 * link that now points at the sheet it sits on (renumbering can cause this)
 * is dropped as a self-reference.
 */
export function resolveCalloutLinks(
  links: CalloutLink[],
  projectSheets: Array<{ id: string; sheetNumber: string }>,
  ownSheetId?: string | null,
): ResolvedCalloutLink[] {
  const index = buildSheetNumberIndex(
    projectSheets.map((sheet) => ({ number: sheet.sheetNumber, value: sheet.id })),
  )
  const resolved: ResolvedCalloutLink[] = []
  for (const link of links) {
    const entry = index.get(normalizeSheetNumber(link.targetSheetNumber))
    if (!entry) continue
    if (ownSheetId && entry.value === ownSheetId) continue
    resolved.push({ ...link, targetSheetId: entry.value })
  }
  return resolved
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

/**
 * Parse the `extracted_metadata.callout_links` blob. Returns null — never
 * throws — on anything malformed: a sheet without parseable links is a sheet
 * without jump targets, not an error.
 */
export function parseStoredCalloutLinks(value: unknown): StoredCalloutLinks | null {
  if (!value || typeof value !== "object") return null
  const stored = value as Partial<StoredCalloutLinks>
  if (typeof stored.algo !== "string" || !Array.isArray(stored.links)) return null

  const links: CalloutLink[] = []
  for (const raw of stored.links) {
    if (!raw || typeof raw !== "object") continue
    const link = raw as Partial<CalloutLink>
    if (typeof link.targetSheetNumber !== "string" || !link.targetSheetNumber.trim()) continue
    if (link.kind !== "detail_bubble" && link.kind !== "sheet_reference") continue
    if (!isFiniteNumber(link.x) || !isFiniteNumber(link.y)) continue
    if (!isFiniteNumber(link.w) || !isFiniteNumber(link.h)) continue
    if (!isFiniteNumber(link.confidence) || link.confidence < 0 || link.confidence > 1) continue
    links.push({
      x: link.x,
      y: link.y,
      w: link.w,
      h: link.h,
      targetSheetNumber: link.targetSheetNumber,
      ...(typeof link.detail === "string" && link.detail ? { detail: link.detail } : {}),
      kind: link.kind,
      confidence: link.confidence,
    })
    if (links.length >= MAX_CALLOUT_LINKS_PER_SHEET) break
  }

  return {
    algo: stored.algo,
    links,
    truncated: stored.truncated === true,
    ...(typeof stored.computed_at === "string" ? { computed_at: stored.computed_at } : {}),
  }
}
