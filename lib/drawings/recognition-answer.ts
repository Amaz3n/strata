import type { AreaRecognitionRequest } from './area-engine'
import type { z } from 'zod'
import type { visualInterpretationSchema } from './area-semantics'

type Answer = z.infer<typeof visualInterpretationSchema>

export function isWallSpanOnlyRequest(request: AreaRecognitionRequest): boolean {
  return request.catalogue.length === 0 && !!request.wallHypotheses?.length
}

/** A span is an independent target. Partial, duplicated or invented IDs do
 * not finish the task or become a reusable classification cache entry. */
export function accountsForWallSpans(request: AreaRecognitionRequest, answer: Answer): boolean {
  const expected = request.wallHypotheses?.map(h => h.binding.id) ?? []
  if (!expected.length) return true
  const received = answer.wallHypotheses?.map(h => h.hypothesisId) ?? []
  return new Set(expected).size === expected.length &&
    received.length === expected.length && new Set(received).size === received.length &&
    received.every(id => expected.includes(id))
}

/** Legacy primitive adapters can still supply path roles alone. Span-only
 * requests have no authority to classify parents or propose door thresholds. */
export function usableRecognitionAnswer(request: AreaRecognitionRequest, answer: Answer): boolean {
  return isWallSpanOnlyRequest(request)
    ? accountsForWallSpans(request, answer) && answer.elements.length === 0 && answer.openings.length === 0
    : answer.elements.length > 0 || answer.openings.length > 0
}
