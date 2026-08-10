/**
 * Checking a vision model's symbol proposals against the sheet's own linework.
 *
 * Arc's doctrine on floor plans is that the model proposes and the vectors
 * decide (`floorplan-vision.ts`). Symbol counting never got the same treatment,
 * and it is the place it matters most: a floor plan proposal that is slightly
 * wrong produces a wall in roughly the right place, while a symbol proposal that
 * is wrong produces a COUNT — a whole number that flows into an estimate and out
 * to a sub. Every hallucinated point is a fixture somebody prices.
 *
 * What this can prove and what it cannot is worth being exact about.
 *
 * It CANNOT confirm that the thing at a proposed point is the same symbol the
 * estimator clicked. That is what `symbol-match.ts` does geometrically, and if
 * that had worked on this sheet the vision fallback would never have run.
 *
 * It CAN confirm that there is drawn linework there at all, of roughly the
 * density the exemplar has. That kills the failure mode that actually occurs:
 * points landing on blank paper, inside a hatch field, or over a legend — a
 * model asked to find twenty things tends to find twenty things.
 *
 * When a sheet has no usable vectors — a scan, which is the case the vision
 * fallback exists for — verification does not run and says so. Silently
 * accepting everything and silently rejecting everything are both wrong; the
 * caller has to be able to tell the user which happened.
 *
 * Pure. Unit-tested in tests/symbol-verify.test.js.
 */

export interface NormPoint {
  x: number
  y: number
}

export interface ImageSize {
  width: number
  height: number
}

/**
 * Sheets below this segment count are treated as having no usable linework.
 * A scan yields a handful of stray vectors from stamps and borders; verifying
 * against those would reject every real symbol on the sheet.
 */
export const MIN_SEGMENTS_FOR_VERIFICATION = 200

/**
 * Share of the exemplar's local segment count a proposal must reach.
 *
 * Deliberately generous. The exemplar box is centred on a click, so it usually
 * catches a little more than the symbol (a lead line, a bit of wall); a real
 * match centred on the symbol itself legitimately carries less ink. The job here
 * is separating "there is a symbol here" from "there is nothing here", not
 * grading similarity.
 */
const MIN_SEGMENT_RATIO = 0.3

/** Same idea, on total drawn length, so a few long strokes cannot stand in. */
const MIN_LENGTH_RATIO = 0.2

/** Absolute floor: below this, a neighbourhood is blank whatever the exemplar had. */
const MIN_ABSOLUTE_SEGMENTS = 2

export interface LocalInk {
  segments: number
  /** Total drawn length inside the window, in image pixels. */
  lengthPx: number
}

/**
 * How much linework sits within `radiusPx` of a point.
 *
 * Segments arrive normalized 0..1 as `[x0, y0, x1, y1, ...]` — the same flat
 * layout `parseVectorsBin` produces — and are measured in image pixels, because
 * a radius in normalized units would mean something different on every sheet.
 * A segment counts when either endpoint is inside the window; a long wall
 * passing straight through contributes nothing, which is correct: a wall is not
 * evidence of a symbol.
 */
export function localInkAround(
  segments: Float32Array | number[],
  imageSize: ImageSize,
  point: NormPoint,
  radiusPx: number,
): LocalInk {
  const centreX = point.x * imageSize.width
  const centreY = point.y * imageSize.height
  let count = 0
  let lengthPx = 0

  for (let i = 0; i + 3 < segments.length; i += 4) {
    const x0 = segments[i] * imageSize.width
    const y0 = segments[i + 1] * imageSize.height
    const x1 = segments[i + 2] * imageSize.width
    const y1 = segments[i + 3] * imageSize.height

    const startInside = Math.abs(x0 - centreX) <= radiusPx && Math.abs(y0 - centreY) <= radiusPx
    const endInside = Math.abs(x1 - centreX) <= radiusPx && Math.abs(y1 - centreY) <= radiusPx
    if (!startInside && !endInside) continue

    count += 1
    lengthPx += Math.hypot(x1 - x0, y1 - y0)
  }

  return { segments: count, lengthPx }
}

export interface SymbolVerification {
  /** Proposals with linework under them, in input order. */
  supported: NormPoint[]
  /** Proposals discarded for landing on blank paper. */
  rejected: NormPoint[]
  /**
   * True when the sheet has too little vector linework to verify against — a
   * scan. Every proposal is returned as supported, and the caller must present
   * the count as unverified rather than as confirmed.
   */
  skipped: boolean
  /** The exemplar's own local ink, for logging why a threshold behaved as it did. */
  exemplarInk: LocalInk | null
}

/**
 * Keep the proposals the sheet's linework supports.
 *
 * The exemplar sets the bar rather than a fixed constant: a single-stroke
 * revision triangle and a forty-segment receptacle symbol have wildly different
 * densities, and any absolute threshold would be wrong for one of them.
 */
export function verifySymbolProposals(input: {
  proposals: NormPoint[]
  segments: Float32Array | number[]
  imageSize: ImageSize
  /** The point the estimator clicked. */
  exemplar: NormPoint
  /** Half-size of the exemplar window, image px — the caller's search radius. */
  radiusPx: number
}): SymbolVerification {
  const { proposals, segments, imageSize, exemplar, radiusPx } = input

  if (segments.length / 4 < MIN_SEGMENTS_FOR_VERIFICATION) {
    return { supported: [...proposals], rejected: [], skipped: true, exemplarInk: null }
  }

  const exemplarInk = localInkAround(segments, imageSize, exemplar, radiusPx)
  // An exemplar with no ink under it means the click missed, the vectors are
  // misregistered, or the symbol is raster. Verification would reject the whole
  // sheet on a premise we cannot trust, so it declines to run.
  if (exemplarInk.segments < MIN_ABSOLUTE_SEGMENTS) {
    return { supported: [...proposals], rejected: [], skipped: true, exemplarInk }
  }

  const minSegments = Math.max(
    MIN_ABSOLUTE_SEGMENTS,
    Math.floor(exemplarInk.segments * MIN_SEGMENT_RATIO),
  )
  const minLength = exemplarInk.lengthPx * MIN_LENGTH_RATIO

  const supported: NormPoint[] = []
  const rejected: NormPoint[] = []

  for (const proposal of proposals) {
    const ink = localInkAround(segments, imageSize, proposal, radiusPx)
    if (ink.segments >= minSegments && ink.lengthPx >= minLength) {
      supported.push(proposal)
    } else {
      rejected.push(proposal)
    }
  }

  return { supported, rejected, skipped: false, exemplarInk }
}
