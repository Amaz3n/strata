/**
 * Line-level 2.5-way match: invoice lines against commitment (PO/subcontract)
 * lines. Pure math only — no IO — so the money logic is testable the same way
 * the other financial math in this directory is.
 *
 * Doctrine: a match assessment is a set of checkable claims for the human
 * approver. It never changes bill status and never blocks anything by itself.
 */

export type LineMatchKind = "exact" | "probable" | "unmatched"
export type LineMatchSource = "deterministic" | "ai"

export interface InvoiceLineForMatch {
  description: string
  quantity: number | null
  unit: string | null
  unitPriceCents: number | null
  amountCents: number
}

export interface CommitmentLineForMatch {
  id: string
  /** 1-based position in the commitment's sort order, for display ("PO line 4"). */
  lineNumber: number
  description: string
  quantity: number | null
  unit: string | null
  unitCostCents: number | null
  /** Effective line total: scheduled value, falling back to quantity x unit cost. */
  scheduledValueCents: number
  /** Amounts earlier bills' assessments already matched onto this line. */
  previouslyMatchedCents: number
}

export interface MatchedInvoiceLine {
  invoiceLine: InvoiceLineForMatch
  commitmentLineId: string | null
  commitmentLineNumber: number | null
  commitmentLineLabel: string | null
  matchKind: LineMatchKind
  source: LineMatchSource
  note: string | null
  overCommitmentLine: boolean
  /** Value left on the matched commitment line before this bill, when known. */
  commitmentLineRemainingCents: number | null
}

export interface LineMatchRollup {
  billTotalCents: number
  /** Other bills already recorded against this commitment. */
  billedToDateCents: number
  commitmentTotalCents: number
  approvedChangeOrdersCents: number
  revisedCommitmentCents: number
  /** Billed to date plus this bill. */
  projectedTotalCents: number
  /** How far the projected total exceeds the revised commitment (0 when it doesn't). */
  overCommitmentCents: number
  unmatchedCount: number
  overLineCount: number
}

export interface PayableLineMatchAssessment {
  version: 1
  fingerprint: string
  commitmentId: string
  matchedAt: string
  model: string | null
  lines: MatchedInvoiceLine[]
  rollup: LineMatchRollup
  notes: string[]
}

const STOPWORDS = new Set([
  "the", "and", "for", "of", "to", "a", "an", "per", "on", "at", "in", "with",
  "inc", "llc", "co", "by", "or", "from",
])

const AMBIGUITY_MARGIN = 0.12
const EXACT_TOKEN_FLOOR = 0.75
const EXACT_TOTAL_FLOOR = 0.7
const PROBABLE_FLOOR = 0.45
const CANDIDATE_FLOOR = 0.3
const MAX_AI_CANDIDATES = 5

export function normalizeMatchTokens(text: string): string[] {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9\s/#-]/g, " ")
        .split(/[\s/#-]+/)
        .map((token) => token.trim())
        .filter((token) => token.length > 1 && !STOPWORDS.has(token)),
    ),
  )
}

function tokenOverlapScore(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const setB = new Set(b)
  let shared = 0
  for (const token of a) if (setB.has(token)) shared += 1
  // Overlap against the smaller set: an invoice line that repeats a commitment
  // line's whole description plus an invoice number should still score high.
  return shared / Math.min(a.length, b.length)
}

function amountProximityScore(invoiceAmountCents: number, line: CommitmentLineForMatch): number {
  const invoice = Math.abs(invoiceAmountCents)
  if (invoice === 0) return 0
  const remaining = Math.max(0, line.scheduledValueCents - line.previouslyMatchedCents)
  const targets = [line.scheduledValueCents, remaining].filter((value) => value > 0)
  if (targets.length === 0) return 0
  let best = 0
  for (const target of targets) {
    const ratio = Math.min(invoice, target) / Math.max(invoice, target)
    if (ratio > best) best = ratio
  }
  // Only near amounts carry signal; a 40% ratio says nothing.
  return best >= 0.98 ? 1 : best >= 0.75 ? (best - 0.75) / 0.23 : 0
}

function unitPriceScore(invoiceLine: InvoiceLineForMatch, line: CommitmentLineForMatch): number {
  if (invoiceLine.unitPriceCents == null || line.unitCostCents == null) return 0
  if (invoiceLine.unitPriceCents <= 0 || line.unitCostCents <= 0) return 0
  return invoiceLine.unitPriceCents === line.unitCostCents ? 1 : 0
}

export function scoreLinePair(invoiceLine: InvoiceLineForMatch, line: CommitmentLineForMatch): number {
  const tokens = tokenOverlapScore(normalizeMatchTokens(invoiceLine.description), normalizeMatchTokens(line.description))
  return 0.6 * tokens + 0.25 * amountProximityScore(invoiceLine.amountCents, line) + 0.15 * unitPriceScore(invoiceLine, line)
}

export interface DeterministicLineDecision {
  invoiceLine: InvoiceLineForMatch
  /** Non-null when the deterministic pass reached a verdict. */
  resolution: MatchedInvoiceLine | null
  /** Non-null when the line needs an arbiter; the strongest candidates first. */
  candidates: CommitmentLineForMatch[] | null
}

/**
 * The deterministic pass. Every line either gets a verdict (exact, probable, or
 * unmatched) or is handed to the arbiter with a short candidate list. Many
 * invoice lines may map onto one commitment line — progress bills do that.
 */
export function matchInvoiceLinesDeterministic(
  invoiceLines: InvoiceLineForMatch[],
  commitmentLines: CommitmentLineForMatch[],
): DeterministicLineDecision[] {
  return invoiceLines.map((invoiceLine) => {
    if (commitmentLines.length === 0) {
      return { invoiceLine, resolution: unmatchedLine(invoiceLine, "The commitment has no lines to match against."), candidates: null }
    }
    const scored = commitmentLines
      .map((line) => ({ line, score: scoreLinePair(invoiceLine, line), tokens: tokenOverlapScore(normalizeMatchTokens(invoiceLine.description), normalizeMatchTokens(line.description)) }))
      .sort((left, right) => right.score - left.score)

    const best = scored[0]
    const second = scored[1]
    const margin = best.score - (second?.score ?? 0)

    if (best.score >= EXACT_TOTAL_FLOOR && best.tokens >= EXACT_TOKEN_FLOOR && (margin >= AMBIGUITY_MARGIN || !second)) {
      return { invoiceLine, resolution: resolvedLine(invoiceLine, best.line, "exact", "deterministic", null), candidates: null }
    }
    if (best.score >= PROBABLE_FLOOR && (margin >= AMBIGUITY_MARGIN || !second)) {
      return { invoiceLine, resolution: resolvedLine(invoiceLine, best.line, "probable", "deterministic", null), candidates: null }
    }
    if (best.score >= CANDIDATE_FLOOR) {
      const candidates = scored
        .filter((entry) => entry.score >= CANDIDATE_FLOOR)
        .slice(0, MAX_AI_CANDIDATES)
        .map((entry) => entry.line)
      return { invoiceLine, resolution: null, candidates }
    }
    return { invoiceLine, resolution: unmatchedLine(invoiceLine, "No matching commitment line."), candidates: null }
  })
}

export function resolvedLine(
  invoiceLine: InvoiceLineForMatch,
  line: CommitmentLineForMatch,
  matchKind: Exclude<LineMatchKind, "unmatched">,
  source: LineMatchSource,
  note: string | null,
): MatchedInvoiceLine {
  return {
    invoiceLine,
    commitmentLineId: line.id,
    commitmentLineNumber: line.lineNumber,
    commitmentLineLabel: line.description,
    matchKind,
    source,
    note,
    overCommitmentLine: false,
    commitmentLineRemainingCents: null,
  }
}

export function unmatchedLine(invoiceLine: InvoiceLineForMatch, note: string, source: LineMatchSource = "deterministic"): MatchedInvoiceLine {
  return {
    invoiceLine,
    commitmentLineId: null,
    commitmentLineNumber: null,
    commitmentLineLabel: null,
    matchKind: "unmatched",
    source,
    note,
    overCommitmentLine: false,
    commitmentLineRemainingCents: null,
  }
}

/**
 * Second pass once every line has a verdict: stamp remaining value and the
 * over-line flag, accounting for several invoice lines landing on the same
 * commitment line within this bill.
 */
export function applyCommitmentLineBudgets(
  lines: MatchedInvoiceLine[],
  commitmentLines: CommitmentLineForMatch[],
): MatchedInvoiceLine[] {
  const byId = new Map(commitmentLines.map((line) => [line.id, line]))
  const billedThisBill = new Map<string, number>()

  return lines.map((matched) => {
    if (!matched.commitmentLineId) return matched
    const line = byId.get(matched.commitmentLineId)
    if (!line) return matched
    // A commitment line with no value carries no budget to check against.
    if (line.scheduledValueCents <= 0) return matched

    const alreadyThisBill = billedThisBill.get(line.id) ?? 0
    const remainingBefore = line.scheduledValueCents - line.previouslyMatchedCents - alreadyThisBill
    billedThisBill.set(line.id, alreadyThisBill + matched.invoiceLine.amountCents)
    const over = matched.invoiceLine.amountCents > remainingBefore

    return {
      ...matched,
      commitmentLineRemainingCents: Math.max(0, remainingBefore),
      overCommitmentLine: over,
      note: over
        ? joinNotes(matched.note, `Bills ${formatCents(matched.invoiceLine.amountCents)} against ${formatCents(Math.max(0, remainingBefore))} remaining on this commitment line.`)
        : matched.note,
    }
  })
}

export function buildLineMatchRollup(input: {
  lines: MatchedInvoiceLine[]
  billTotalCents: number
  billedToDateCents: number
  commitmentTotalCents: number
  approvedChangeOrdersCents: number
}): LineMatchRollup {
  const revisedCommitmentCents = input.commitmentTotalCents + input.approvedChangeOrdersCents
  const projectedTotalCents = input.billedToDateCents + input.billTotalCents
  return {
    billTotalCents: input.billTotalCents,
    billedToDateCents: input.billedToDateCents,
    commitmentTotalCents: input.commitmentTotalCents,
    approvedChangeOrdersCents: input.approvedChangeOrdersCents,
    revisedCommitmentCents,
    projectedTotalCents,
    overCommitmentCents: revisedCommitmentCents > 0 ? Math.max(0, projectedTotalCents - revisedCommitmentCents) : 0,
    unmatchedCount: input.lines.filter((line) => line.matchKind === "unmatched").length,
    overLineCount: input.lines.filter((line) => line.overCommitmentLine).length,
  }
}

/**
 * Stable fingerprint of everything the match depends on, so an unchanged bill
 * is never re-matched. FNV-1a over a canonical JSON of the inputs.
 */
export function lineMatchFingerprint(input: {
  commitmentId: string
  billTotalCents: number
  billedToDateCents: number
  commitmentTotalCents: number
  approvedChangeOrdersCents: number
  invoiceLines: InvoiceLineForMatch[]
  commitmentLines: CommitmentLineForMatch[]
}): string {
  const canonical = JSON.stringify({
    v: 1,
    c: input.commitmentId,
    bt: input.billTotalCents,
    bd: input.billedToDateCents,
    ct: input.commitmentTotalCents,
    co: input.approvedChangeOrdersCents,
    il: input.invoiceLines.map((line) => [line.description, line.quantity, line.unit, line.unitPriceCents, line.amountCents]),
    cl: input.commitmentLines.map((line) => [line.id, line.description, line.quantity, line.unit, line.unitCostCents, line.scheduledValueCents, line.previouslyMatchedCents]),
  })
  let hash = 0x811c9dc5
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, "0")
}

/** Read a persisted assessment out of vendor_bills.metadata, defensively. */
export function readLineMatchAssessment(metadata: Record<string, unknown> | null | undefined): PayableLineMatchAssessment | null {
  const raw = metadata?.line_match
  if (!raw || typeof raw !== "object") return null
  const candidate = raw as Partial<PayableLineMatchAssessment>
  if (candidate.version !== 1 || typeof candidate.fingerprint !== "string" || typeof candidate.commitmentId !== "string") return null
  if (!Array.isArray(candidate.lines) || !candidate.rollup || typeof candidate.rollup !== "object") return null
  return candidate as PayableLineMatchAssessment
}

export function formatCents(cents: number): string {
  const dollars = Math.abs(cents) / 100
  const formatted = dollars.toLocaleString("en-US", {
    minimumFractionDigits: dollars % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })
  return `${cents < 0 ? "-" : ""}$${formatted}`
}

function joinNotes(existing: string | null, addition: string): string {
  return existing ? `${existing} ${addition}` : addition
}
