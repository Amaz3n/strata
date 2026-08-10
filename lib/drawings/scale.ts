/**
 * Reading a sheet's scale off the sheet itself.
 *
 * Two independent methods, both working from the PDF text layer that the
 * drawings pipeline already extracts:
 *
 *   1. STATED SCALE — the title block says `SCALE: 1/4" = 1'-0"`. Cheap,
 *      present on most architectural sheets, and wrong exactly as often as the
 *      title block is (details drawn at another scale, "SCALE: AS NOTED").
 *
 *   2. DIMENSION CHAIN — the printed dimension strings along an elevation are
 *      laid end to end, each centred on the segment it labels. For two
 *      neighbours measuring `a` and `b` feet whose text centres sit `d` page
 *      units apart, the implied scale is `((a + b) / 2) / d`. Three or more
 *      neighbours agreeing to within a percent is strong evidence, and unlike
 *      the title block it is measured against the geometry actually drawn.
 *
 * Neither is ever applied automatically — both produce a proposal a human
 * confirms. A wrong scale does not fail loudly; it silently multiplies every
 * quantity on the sheet.
 *
 * Pure and client-safe: no PDF library, no I/O.
 */

import { parseFeetInches } from "@/lib/validation/drawings"

// ---------------------------------------------------------------------------
// Stated scale
// ---------------------------------------------------------------------------

export interface StatedScale {
  /** Real-world feet represented by one inch of paper. */
  feetPerPaperInch: number
  /** The matched text, verbatim, for the confirm bar. */
  raw: string
}

/**
 * `1/4" = 1'-0"` and friends → feet per paper inch.
 *
 * Handles the four families that actually appear on construction documents:
 *   fractional architectural  `1/4" = 1'-0"`, `3/16"=1'0"`
 *   whole-inch architectural  `1" = 1'-0"`, `1 1/2" = 1'-0"`
 *   civil / site              `1" = 20'`, `1"=100'`
 *   ratio                     `1:48`, `1/48`
 *
 * Returns null for anything unparseable, and deliberately for `NTS` /
 * `AS NOTED` — a sheet that says it has no single scale must not get one.
 */
export function parseStatedScale(raw: string): StatedScale | null {
  const text = normalizeScaleText(raw)
  if (!text) return null

  // An explicit disclaimer outranks any number elsewhere in the same string.
  if (/\b(nts|not to scale|as noted|varies)\b/.test(text)) return null

  const equation = text.match(
    /(\d+(?:\s+\d+\/\d+)?(?:\/\d+)?(?:\.\d+)?)\s*"\s*=\s*([0-9'"\-\s/.]+)/,
  )
  if (equation) {
    const paperInches = parseMixedNumber(equation[1])
    const realFeet = parseFeetInches(equation[2].trim())
    if (paperInches && realFeet && paperInches > 0) {
      return { feetPerPaperInch: realFeet / paperInches, raw: raw.trim() }
    }
  }

  // Ratio form: 1 unit of paper = N units of the world.
  //
  // COLON ONLY, deliberately. `1/48` is indistinguishable from the fractions
  // that fill a drawing's notes — `1/2" GYP. BD.`, `#5 BARS ... 1 1/2"` — and
  // accepting the slash form made a gypsum-board callout parse as a 1:2 scale
  // and silently calibrate the sheet 8x wrong. No title block writes `1/48`
  // where `1:48` would not do.
  const ratio = text.match(/(?:^|[\s:=(])1\s*:\s*(\d{1,5})(?:$|[\s)."',])/)
  if (ratio) {
    const denominator = Number.parseInt(ratio[1], 10)
    // Real drawing scales run roughly 1:8 (3/2"=1'-0") to 1:2400 (1"=200').
    // Anything outside that is a ratio about something else — a mix design,
    // a slope, a reinforcing spec.
    if (Number.isFinite(denominator) && denominator >= 8 && denominator <= 2400) {
      return { feetPerPaperInch: denominator / 12, raw: raw.trim() }
    }
  }

  return null
}

function normalizeScaleText(raw: string): string {
  return (
    raw
      .toLowerCase()
      // Escaped rather than literal: title blocks are full of typographic
      // quotes, and a copy-paste that flattens the glyph would silently turn
      // this normalization into a no-op.
      .replace(/[“”″]/g, '"')
      .replace(/[‘’′]/g, "'")
      .replace(/\s+/g, " ")
      .trim()
  )
}

/** `1`, `1.5`, `1 1/2`, `3/16` → decimal. */
function parseMixedNumber(raw: string): number | null {
  const text = raw.trim()
  const mixed = text.match(/^(\d+)\s+(\d+)\/(\d+)$/)
  if (mixed) {
    const denominator = Number(mixed[3])
    if (denominator === 0) return null
    return Number(mixed[1]) + Number(mixed[2]) / denominator
  }
  const fraction = text.match(/^(\d+)\/(\d+)$/)
  if (fraction) {
    const denominator = Number(fraction[2])
    if (denominator === 0) return null
    return Number(fraction[1]) / denominator
  }
  const decimal = Number(text)
  return Number.isFinite(decimal) && decimal > 0 ? decimal : null
}

/** A `SCALE:` label longer than this is prose, not a title-block field. */
const LABEL_MAX_LENGTH = 40
/** Extracted text lines this far from a label still count as its value. */
const LABEL_PROXIMITY = 2

/**
 * Find a page's stated scale, using proximity to a `SCALE` label.
 *
 * Real title blocks split the label from the value across two text runs, in
 * either order:
 *
 *     [283] "SCALE:"          [13] "3/4\"=1'-0\""
 *     [284] "1/4\"=1'-0\""     [14] "SCALE:"
 *
 * so the search looks both directions. Proximity is what makes this safe:
 * scanning the whole sheet for anything that parses will find `1/2" GYP. BD.`
 * in a wall assembly note long before it finds the title block, and a wrong
 * scale does not fail loudly — it multiplies every quantity on the sheet.
 *
 * Two refusals, both deliberate:
 *   - a `SCALE: NTS / AS NOTED / VARIES` label suppresses everything;
 *   - so does a sheet whose labeled scales disagree with each other, which is
 *     a multi-scale detail sheet wearing a single-scale disguise.
 *
 * Text order comes from the PDF's content stream, which is usually but not
 * always visual order — hence a window rather than strict adjacency.
 */
export function findStatedScale(lines: string[]): StatedScale | null {
  const labelIndices: number[] = []

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (!/\bscale\b/i.test(line)) continue
    // "DO NOT SCALE STRUCTURAL DRAWINGS" is prose that happens to contain the
    // word; a title-block field is short.
    if (line.length > LABEL_MAX_LENGTH) continue
    if (/\b(nts|n\.t\.s\.|not to scale|as noted|varies)\b/i.test(line)) return null
    labelIndices.push(index)
  }

  const near: StatedScale[] = []
  const far: StatedScale[] = []

  for (let index = 0; index < lines.length; index++) {
    const parsed = parseStatedScale(lines[index])
    if (!parsed) continue
    const anchored = labelIndices.some(
      (labelIndex) => Math.abs(labelIndex - index) <= LABEL_PROXIMITY,
    )
    if (anchored) near.push(parsed)
    else far.push(parsed)
  }

  const anchored = distinctScale(near)
  if (anchored !== undefined) return anchored

  // No label anywhere: accept a bare scale only when the sheet says one thing.
  // Several different bare scales means detail callouts, not a sheet scale.
  if (labelIndices.length === 0) {
    const only = distinctScale(far)
    if (only !== undefined) return only
  }

  return null
}

/**
 * The single scale a group agrees on. `undefined` means "no usable answer" —
 * either nothing parsed, or the group disagrees and guessing between them is
 * how a sheet ends up calibrated to a detail instead of the plan.
 */
function distinctScale(candidates: StatedScale[]): StatedScale | null | undefined {
  if (candidates.length === 0) return undefined
  const first = candidates[0]
  const allAgree = candidates.every(
    (candidate) => Math.abs(candidate.feetPerPaperInch - first.feetPerPaperInch) < 1e-9,
  )
  return allAgree ? first : null
}

/**
 * Feet per rendered-image pixel, from a paper scale and the render DPI. This
 * is the number `drawing_sheet_versions.extracted_metadata.calibration` holds.
 */
export function feetPerImagePxFromPaperScale(
  feetPerPaperInch: number,
  renderDpi: number,
): number | null {
  if (!(feetPerPaperInch > 0) || !(renderDpi > 0)) return null
  return feetPerPaperInch / renderDpi
}

// ---------------------------------------------------------------------------
// Dimension-chain cross-check
// ---------------------------------------------------------------------------

export interface DimensionToken {
  /** The printed text, e.g. `24'-6"`. */
  text: string
  /** Centre of the text's bounding box, in any consistent unit. */
  x: number
  y: number
}

/** Bounding box of a text line, in page units. */
export interface TextBox {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** `24'-6"`, `12'`, `8"` — the shapes a printed dimension takes. */
const DIMENSION_PATTERN = /\d+(?:\.\d+)?\s*['’′](?:\s*-?\s*\d+(?:\.\d+)?\s*["”″]?)?/g

/**
 * Pull dimension strings out of one extracted text line.
 *
 * A PDF text line usually holds exactly one dimension, but a whole chain can
 * arrive as a single run. Splitting by character offset across the line's
 * bounding box recovers per-dimension positions accurately enough for the
 * cross-check, which only cares about the distance between centres.
 */
export function extractDimensionTokens(text: string, bbox: TextBox): DimensionToken[] {
  if (!text || bbox.x1 <= bbox.x0) return []

  const matches = Array.from(text.matchAll(DIMENSION_PATTERN))
  if (matches.length === 0) return []

  const midY = (bbox.y0 + bbox.y1) / 2
  if (matches.length === 1) {
    return [{ text: matches[0][0], x: (bbox.x0 + bbox.x1) / 2, y: midY }]
  }

  const width = bbox.x1 - bbox.x0
  return matches.map((match) => {
    const start = match.index ?? 0
    const centreChar = start + match[0].length / 2
    return {
      text: match[0],
      x: bbox.x0 + (centreChar / text.length) * width,
      y: midY,
    }
  })
}

export interface DimensionCheckResult {
  /** Real feet per unit of the input coordinates. */
  feetPerUnit: number
  /** How many neighbour pairs agreed. */
  sampleCount: number
  /** Spread across the agreeing pairs, as a percentage of the median. */
  spreadPct: number
  /** Chain orientation, for diagnostics. */
  axis: "horizontal" | "vertical"
}

/** Two tokens are on the same chain if their off-axis centres are this close. */
const CHAIN_TOLERANCE_UNITS = 6
/** Pairs disagreeing with the median by more than this are dropped. */
const OUTLIER_TOLERANCE = 0.05
/** The chain must agree at least this tightly to be worth proposing. */
const MAX_ACCEPTED_SPREAD_PCT = 1.5
/** Minimum agreeing pairs. Two can agree by luck; three is a pattern. */
const MIN_SAMPLES = 3

/**
 * Estimate scale from chains of printed dimension strings.
 *
 * Returns the tightest-agreeing chain on the page, or null when nothing on the
 * sheet corroborates itself. Deliberately conservative: on this evidence the
 * answer is either trustworthy enough to offer or absent.
 */
export function crossCheckDimensionChains(
  tokens: DimensionToken[],
  options?: { minSamples?: number },
): DimensionCheckResult | null {
  const minSamples = Math.max(2, options?.minSamples ?? MIN_SAMPLES)
  const parsed = tokens
    .map((token) => ({ ...token, feet: parseFeetInches(token.text) }))
    .filter((token): token is DimensionToken & { feet: number } => {
      // Sub-foot and implausibly long strings are not dimension chains: the
      // former are usually part numbers, the latter site distances at a
      // different scale from the building.
      return token.feet !== null && token.feet >= 1 && token.feet <= 500
    })

  if (parsed.length < minSamples + 1) return null

  const candidates = [
    evaluateChains(parsed, "horizontal", minSamples),
    evaluateChains(parsed, "vertical", minSamples),
  ].filter((result): result is DimensionCheckResult => result !== null)

  if (candidates.length === 0) return null

  // More agreeing samples beats a marginally tighter spread — a 12-pair chain
  // at 0.8% is better evidence than a 3-pair chain at 0.2%.
  return candidates.sort(
    (a, b) => b.sampleCount - a.sampleCount || a.spreadPct - b.spreadPct,
  )[0]
}

function evaluateChains(
  tokens: Array<DimensionToken & { feet: number }>,
  axis: "horizontal" | "vertical",
  minSamples: number,
): DimensionCheckResult | null {
  // Horizontal chains share a y; vertical chains share an x.
  const groupKey = (token: DimensionToken) => (axis === "horizontal" ? token.y : token.x)
  const alongAxis = (token: DimensionToken) => (axis === "horizontal" ? token.x : token.y)

  const sorted = [...tokens].sort((a, b) => groupKey(a) - groupKey(b))
  const chains: Array<Array<DimensionToken & { feet: number }>> = []
  let current: Array<DimensionToken & { feet: number }> = []

  for (const token of sorted) {
    if (current.length === 0) {
      current = [token]
      continue
    }
    if (Math.abs(groupKey(token) - groupKey(current[0])) <= CHAIN_TOLERANCE_UNITS) {
      current.push(token)
    } else {
      if (current.length >= minSamples + 1) chains.push(current)
      current = [token]
    }
  }
  if (current.length >= minSamples + 1) chains.push(current)

  let best: DimensionCheckResult | null = null

  for (const chain of chains) {
    const ordered = [...chain].sort((a, b) => alongAxis(a) - alongAxis(b))
    const ratios: number[] = []

    for (let i = 1; i < ordered.length; i++) {
      const previous = ordered[i - 1]
      const token = ordered[i]
      const gap = alongAxis(token) - alongAxis(previous)
      if (gap <= 0) continue
      // Neighbouring dimension strings are each centred on their own segment,
      // so the distance between their centres spans half of each.
      ratios.push((previous.feet + token.feet) / 2 / gap)
    }

    if (ratios.length < minSamples) continue

    const kept = rejectOutliers(ratios)
    if (kept.length < minSamples) continue

    const sortedKept = [...kept].sort((a, b) => a - b)
    const median = sortedKept[Math.floor(sortedKept.length / 2)]
    if (!(median > 0)) continue

    const spreadPct = ((sortedKept[sortedKept.length - 1] - sortedKept[0]) / median) * 100
    if (spreadPct > MAX_ACCEPTED_SPREAD_PCT) continue

    const candidate: DimensionCheckResult = {
      feetPerUnit: median,
      sampleCount: kept.length,
      spreadPct: Math.round(spreadPct * 100) / 100,
      axis,
    }
    if (!best || candidate.sampleCount > best.sampleCount || candidate.spreadPct < best.spreadPct) {
      best = candidate
    }
  }

  return best
}

// ---------------------------------------------------------------------------
// Local scale disagreement — the multi-scale sheet
// ---------------------------------------------------------------------------

/**
 * A real sheet is rarely at one scale. A 1/4" floor plan shares the page with
 * 1/2" wall sections and 3" details, and the sheet calibration only describes
 * the plan. Measure inside a detail and the answer is silently wrong by a factor
 * of two to twelve — a error nobody catches by reading a total, and one that
 * ends in a material order.
 *
 * This compares the printed dimensions INSIDE a region against the scale the
 * sheet is calibrated at. It is advisory and one-directional: it only ever says
 * "the dimensions here disagree with the sheet", never silently re-scales.
 */
export interface LocalScaleDisagreement {
  /** Feet per unit implied by the dimensions printed inside the region. */
  localFeetPerUnit: number
  /** What the sheet is calibrated at. */
  sheetFeetPerUnit: number
  /** localFeetPerUnit / sheetFeetPerUnit — 2 means everything here reads double. */
  ratio: number
  sampleCount: number
}

/** Under this the two agree; drafting and text placement are not that precise. */
const LOCAL_SCALE_TOLERANCE = 0.08
/** A local chain gets a lower bar than a whole-sheet one — a detail has fewer strings. */
const LOCAL_MIN_SAMPLES = 2
/** The region is grown by this share of its size before collecting tokens. */
const LOCAL_REGION_PADDING = 0.25

/**
 * Returns the disagreement, or null when the region's own dimensions either
 * agree with the sheet or are too sparse to say anything. Null is the common
 * answer and means "no reason to doubt this measurement".
 */
export function detectLocalScaleDisagreement(input: {
  tokens: DimensionToken[]
  region: TextBox
  sheetFeetPerUnit: number
}): LocalScaleDisagreement | null {
  const { tokens, region, sheetFeetPerUnit } = input
  if (!(sheetFeetPerUnit > 0)) return null

  const padX = Math.max((region.x1 - region.x0) * LOCAL_REGION_PADDING, 1)
  const padY = Math.max((region.y1 - region.y0) * LOCAL_REGION_PADDING, 1)
  const inside = tokens.filter(
    (token) =>
      token.x >= region.x0 - padX &&
      token.x <= region.x1 + padX &&
      token.y >= region.y0 - padY &&
      token.y <= region.y1 + padY,
  )

  const local = crossCheckDimensionChains(inside, { minSamples: LOCAL_MIN_SAMPLES })
  if (!local) return null

  const ratio = local.feetPerUnit / sheetFeetPerUnit
  if (Math.abs(ratio - 1) <= LOCAL_SCALE_TOLERANCE) return null

  return {
    localFeetPerUnit: local.feetPerUnit,
    sheetFeetPerUnit,
    ratio,
    sampleCount: local.sampleCount,
  }
}

/**
 * Drop ratios far from the median. One mislabelled string ("TYP", an overall
 * dimension spanning the whole chain) would otherwise blow up the spread and
 * throw away an otherwise good chain.
 */
function rejectOutliers(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  if (!(median > 0)) return []
  return values.filter((value) => Math.abs(value - median) / median <= OUTLIER_TOLERANCE)
}

// ---------------------------------------------------------------------------
// Proposal assembly
// ---------------------------------------------------------------------------

export interface CalibrationProposal {
  feet_per_image_px: number
  method: "title_block" | "dimension_check"
  raw: string | null
  sample_count?: number
  spread_pct?: number
}

/**
 * Pick the scale to offer. The dimension check wins whenever it fired: it is
 * measured against the drawn geometry, while the title block is a claim.
 *
 * `imagePxPerPageUnit` converts the coordinate space the dimension tokens were
 * measured in (PDF points) into rendered-image pixels.
 */
export function buildCalibrationProposal(input: {
  stated: StatedScale | null
  dimensionCheck: DimensionCheckResult | null
  renderDpi: number
  imagePxPerPageUnit: number
}): CalibrationProposal | null {
  const { stated, dimensionCheck, renderDpi, imagePxPerPageUnit } = input

  if (dimensionCheck && imagePxPerPageUnit > 0) {
    const feetPerImagePx = dimensionCheck.feetPerUnit / imagePxPerPageUnit
    if (feetPerImagePx > 0 && Number.isFinite(feetPerImagePx)) {
      return {
        feet_per_image_px: feetPerImagePx,
        method: "dimension_check",
        raw: stated?.raw ?? null,
        sample_count: dimensionCheck.sampleCount,
        spread_pct: dimensionCheck.spreadPct,
      }
    }
  }

  if (stated) {
    const feetPerImagePx = feetPerImagePxFromPaperScale(stated.feetPerPaperInch, renderDpi)
    if (feetPerImagePx) {
      return { feet_per_image_px: feetPerImagePx, method: "title_block", raw: stated.raw }
    }
  }

  return null
}
