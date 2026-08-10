/**
 * Which sources an answer actually used.
 *
 * The harness used to attach the top N retrieval hits as "citations" regardless
 * of whether the model referenced any of them. That is not a citation, it is a
 * garnish: it looks like provenance while carrying none, and it is worse than
 * showing nothing because a reader trusts it.
 *
 * The model now marks the records it relies on inline as [S1], [S2, S3]. This
 * module reads those marks, and the harness cites only what was marked. Pure on
 * purpose — grounding is a claim about correctness, so it gets tested.
 */

/** `[S1]`, `[S12]`, `[S1, S3]`, `[S1,S2]` — one or more indexes in one bracket. */
const CITATION_MARKER = /\[\s*S\d+(?:\s*,\s*S?\d+)*\s*\]/gi

/**
 * 1-based source indexes the answer referenced, in first-appearance order.
 * Out-of-range indexes are dropped: a model citing [S9] against four sources is
 * describing something it was never shown.
 */
export function extractCitedSourceIndexes(answer: string, sourceCount: number): number[] {
  const seen = new Set<number>()
  const ordered: number[] = []

  for (const match of answer.matchAll(CITATION_MARKER)) {
    for (const rawIndex of match[0].matchAll(/\d+/g)) {
      const index = Number(rawIndex[0])
      if (!Number.isInteger(index) || index < 1 || index > sourceCount) continue
      if (seen.has(index)) continue
      seen.add(index)
      ordered.push(index)
    }
  }

  return ordered
}

/** Remove the markers for display; the citation list carries them instead. */
export function stripCitationMarkers(answer: string) {
  return answer
    .replace(CITATION_MARKER, "")
    // Markers usually trail a clause, so collapse the space they leave behind.
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .replace(/[ \t]+$/gm, "")
    .trim()
}

/** A money or quantity figure, the kind of claim that most needs a source. */
const NUMERIC_CLAIM = /(?:\$\s?\d|(?<![\w.])\d{1,3}(?:,\d{3})+(?![\w.])|(?<![\w.])\d+(?:\.\d+)?\s?%)/

export interface GroundingAssessment {
  citedIndexes: number[]
  /** The answer with markers removed. */
  displayAnswer: string
  /** Numbers asserted with nothing cited to back them. */
  hasUngroundedNumericClaim: boolean
}

export function assessGrounding({
  answer,
  sourceCount,
  hasToolEvidence,
}: {
  answer: string
  sourceCount: number
  /**
   * True when a tool returned figures this turn. Tool output is itself evidence,
   * so a number traceable to `finance_metric` is grounded even with no [S#].
   */
  hasToolEvidence: boolean
}): GroundingAssessment {
  const citedIndexes = extractCitedSourceIndexes(answer, sourceCount)
  const displayAnswer = stripCitationMarkers(answer)

  return {
    citedIndexes,
    displayAnswer,
    hasUngroundedNumericClaim:
      !hasToolEvidence && citedIndexes.length === 0 && NUMERIC_CLAIM.test(displayAnswer),
  }
}
