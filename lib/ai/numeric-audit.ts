/**
 * Checking that every number in an answer came from a query.
 *
 * Arc's rule is that models narrate and code computes. The metric tools enforce
 * half of that — a question about open AR runs SQL — but nothing enforced the
 * other half: once the tool returns $482,190 across eleven invoices, there is
 * nothing stopping the model from writing "about $44,000 each" or "up 12% on
 * last month". Those numbers are arithmetic, they are frequently wrong, and they
 * are indistinguishable in the answer from the figure that came out of the
 * database.
 *
 * This module makes them distinguishable. Every figure a tool returned is
 * declared; every figure the narrative states is extracted; anything in the
 * second set that is not in the first is unsupported. Unsupported does not mean
 * false — the caller decides what to do — but a number nothing computed must
 * never reach a user looking like one that was.
 *
 * Pure, so the matching rules can be tested without a provider. Unit-tested in
 * tests/numeric-audit.test.js.
 */

/** A number some tool actually produced, with the label it was produced under. */
export interface SupportedFigure {
  value: number
  label: string
}

export interface NumericClaim {
  /** The number as written in the answer, e.g. "$482,190" or "12%". */
  text: string
  /** Parsed value. Money is in whole currency units, not cents. */
  value: number
  kind: "money" | "percent" | "count"
  /** Character offset in the narrative, so a caller can point at it. */
  index: number
}

/**
 * Numbers below this are ignored when they carry no unit.
 *
 * A bare "3" in "the 3 open RFIs" is almost always a count a tool returned, and
 * chasing every small integer produces a warning on every answer — which is the
 * fastest way to make a warning meaningless. Money and percentages are checked
 * at any magnitude.
 */
const BARE_NUMBER_FLOOR = 1000

/**
 * Relative slack when matching a claim to a figure.
 *
 * Models round, and rounding is legitimate narration: "$482,190" reported as
 * "about $482,000" is the same fact. Two significant figures of agreement is
 * enough to tell rounding from invention, and invention is rarely subtle — a
 * fabricated average is not within 1% of a real total.
 */
const MATCH_TOLERANCE = 0.01

/** Multipliers for abbreviated magnitudes the model writes in prose. */
const MAGNITUDE_SUFFIXES: Array<[RegExp, number]> = [
  [/^k$/i, 1_000],
  [/^m$/i, 1_000_000],
  [/^mm$/i, 1_000_000],
  [/^b$/i, 1_000_000_000],
]

/**
 * Numbers in prose: an optional currency mark, digits with separators, an
 * optional decimal, an optional magnitude letter, an optional percent sign.
 * Deliberately does not match numbers glued to letters (IDs like `A-101`,
 * `PO-4471`), which are labels rather than quantities.
 */
const NUMBER_PATTERN = /(?<![\w-])(\$)?(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s*(k|m|mm|b)?(%)?(?![\w-])/gi

function magnitudeFor(suffix: string | undefined): number {
  if (!suffix) return 1
  for (const [pattern, multiplier] of MAGNITUDE_SUFFIXES) {
    if (pattern.test(suffix)) return multiplier
  }
  return 1
}

export function extractNumericClaims(narrative: string): NumericClaim[] {
  const claims: NumericClaim[] = []
  NUMBER_PATTERN.lastIndex = 0

  let match: RegExpExecArray | null
  while ((match = NUMBER_PATTERN.exec(narrative)) !== null) {
    const [full, currency, digits, decimal, suffix, percent] = match
    const base = Number(`${digits.replace(/,/g, "")}${decimal ?? ""}`)
    if (!Number.isFinite(base)) continue

    const value = base * magnitudeFor(suffix)
    const kind: NumericClaim["kind"] = percent ? "percent" : currency ? "money" : "count"

    // A bare small number is almost certainly a count from a tool, or a year.
    if (kind === "count" && value < BARE_NUMBER_FLOOR) continue

    claims.push({ text: full.trim(), value, kind, index: match.index })
  }

  return claims
}

function matchesFigure(value: number, figure: number): boolean {
  if (figure === 0) return value === 0
  return Math.abs(value - figure) / Math.abs(figure) <= MATCH_TOLERANCE
}

export interface NumericAudit {
  claims: NumericClaim[]
  /** Claims that match something a tool returned. */
  supported: NumericClaim[]
  /** Claims nothing computed. The caller decides how loudly to say so. */
  unsupported: NumericClaim[]
}

/**
 * Audit a narrative against the figures the tools produced.
 *
 * Money figures are declared in whole currency units, because that is what the
 * model writes; converting from cents is the caller's job and belongs at the
 * edge where every other money formatting decision lives.
 *
 * With NO figures declared, nothing is audited rather than everything being
 * flagged: an answer built purely from retrieved documents legitimately quotes
 * numbers off those documents, and calling all of them fabricated would be both
 * wrong and useless.
 */
export function auditNumericClaims(
  narrative: string,
  figures: SupportedFigure[],
): NumericAudit {
  const claims = extractNumericClaims(narrative)
  if (figures.length === 0) {
    return { claims, supported: claims, unsupported: [] }
  }

  const values = figures.map((figure) => figure.value)
  const supported: NumericClaim[] = []
  const unsupported: NumericClaim[] = []

  for (const claim of claims) {
    // A percentage may also be stated as its decimal ratio (0.12 for 12%), and
    // money may be stated in either direction of a rounding.
    const candidates =
      claim.kind === "percent" ? [claim.value, claim.value / 100] : [claim.value]

    const isSupported = candidates.some((candidate) =>
      values.some((figure) => matchesFigure(candidate, figure)),
    )
    if (isSupported) supported.push(claim)
    else unsupported.push(claim)
  }

  return { claims, supported, unsupported }
}

/**
 * A sentence for the user when figures could not be traced to a query.
 *
 * Worded as provenance, not as an accusation: the number may well be right, and
 * telling someone their answer is wrong when it is merely unverified is its own
 * kind of wrong. Null when everything checked out.
 */
export function describeUnsupportedFigures(audit: NumericAudit): string | null {
  const count = audit.unsupported.length
  if (count === 0) return null

  const listed = audit.unsupported.slice(0, 4).map((claim) => claim.text)
  const extra = count - listed.length
  const tail = extra > 0 ? ` and ${extra} other figure${extra === 1 ? "" : "s"}` : ""
  const verb = count === 1 ? "was" : "were"
  const pronoun = count === 1 ? "it" : "them"

  return `${listed.join(", ")}${tail} ${verb} not returned by a query — check ${pronoun} against the source before relying on it.`
}
