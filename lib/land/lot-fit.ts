import type { LotDimensions, Setbacks } from "@/lib/land/lot-dimensions"

/**
 * Does the house fit the lot?
 *
 * One answer for every path that puts a plan on a lot: pinning a spec plan,
 * instantiation, pricing a purchase agreement, the start package's plan gate
 * (re-derived at release) and both importers. It is judged from four rules:
 *
 * - **Dimensions and setbacks.** The plan's footprint must fit the buildable
 *   envelope: lot width less both side setbacks (the corner-side setback on a
 *   corner lot's street side), lot depth less the front and rear setbacks. A
 *   lot's own setback wins over its community's, one key at a time.
 * - **Orientation.** A lot that only takes one garage handing (`lots.swing`)
 *   refuses the other, and an elevation that is not swing-applicable is built
 *   only in the handing its plan is drawn in.
 * - **Allowed elevations.** A lot under architectural control lists the
 *   elevations it takes; a lot with no list takes any.
 * - **Irregular lots.** A rectangle check means nothing on an irregular lot,
 *   so a footprint there is a violation until someone has checked the plot plan
 *   and recorded that, with the evidence, as an override.
 *
 * Missing data is `unknown`, not a violation, and does not block: most lots
 * and plans in production today carry no measurements, and refusing every one
 * of them would stop the business rather than protect it. Missing setbacks are
 * read as zero, so a house wider than the raw lot is still refused. The answer
 * says what is missing so the gap is visible instead of passing silently.
 *
 * Pure: the service (`lib/services/lot-fit.ts`) loads the inputs and decides
 * whether a recorded override covers what is found here.
 */

export const MIN_FIT_OVERRIDE_REASON_LENGTH = 10

export type LotSwing = "left" | "right" | "either"
export type Handing = "left" | "right"

export const LOT_FIT_VIOLATION_CODES = [
  "footprint_too_wide",
  "footprint_too_deep",
  "swing_not_applicable",
  "swing_forbidden_by_lot",
  "elevation_not_allowed",
  "irregular_lot_unverified",
] as const

export type LotFitViolationCode = (typeof LOT_FIT_VIOLATION_CODES)[number]

export interface LotFitViolation {
  code: LotFitViolationCode
  message: string
  expected: string | null
  actual: string | null
}

export type LotFitMissing = "lot_width" | "lot_depth" | "plan_footprint" | "setbacks" | "plan_handing"

export type LotFitStatus = "fits" | "violations" | "unknown"

export interface LotFitEvaluation {
  status: LotFitStatus
  violations: LotFitViolation[]
  missing: LotFitMissing[]
  /** The envelope the footprint was measured against, when the lot is measured. */
  buildable: { widthFt: number | null; depthFt: number | null }
  /** The handing the home would be built in, once anything settles it. */
  swing: Handing | null
}

export interface LotFitInput {
  lot: {
    dimensions: LotDimensions
    /** What the lot takes: one handing, or either. */
    swing: LotSwing
    /** Elevations the lot is restricted to; empty means any. */
    allowedElevationIds: readonly string[]
  }
  communitySetbacks: Setbacks
  plan: {
    footprintWidthFt: number | null
    footprintDepthFt: number | null
    drawnSwing: Handing | null
  }
  elevation: { id: string; swingApplicable: boolean } | null
  /** The handing being chosen, or null when the configuration leaves it to the lot. */
  swing: Handing | null
}

const LOT_FIT_MISSING_LABELS: Record<LotFitMissing, string> = {
  lot_width: "lot width",
  lot_depth: "lot depth",
  plan_footprint: "plan footprint",
  setbacks: "setbacks",
  plan_handing: "the plan's drawn handing",
}

export function describeMissingFitData(missing: readonly LotFitMissing[]): string {
  return missing.map((entry) => LOT_FIT_MISSING_LABELS[entry]).join(", ")
}

function feet(value: number) {
  return `${Number(value.toFixed(2))} ft`
}

function setback(lot: Setbacks, community: Setbacks, key: keyof Setbacks) {
  return lot[key] ?? community[key]
}

/** A footprint equal to the envelope fits; float noise from feet-and-inches entry does not refuse it. */
const TOLERANCE_FT = 1e-6

export function evaluateLotFit(input: LotFitInput): LotFitEvaluation {
  const violations: LotFitViolation[] = []
  const missing = new Set<LotFitMissing>()
  const { lot, plan, elevation } = input
  const dimensions = lot.dimensions

  // Orientation.
  const fixedHanding = elevation && !elevation.swingApplicable ? plan.drawnSwing : null
  const swing = input.swing ?? (lot.swing === "either" ? null : lot.swing) ?? fixedHanding
  if (elevation && !elevation.swingApplicable) {
    if (!plan.drawnSwing) {
      if (swing) missing.add("plan_handing")
    } else if (swing && swing !== plan.drawnSwing) {
      violations.push({
        code: "swing_not_applicable",
        message: `This elevation is built only as drawn, with a ${plan.drawnSwing} garage; it cannot be flipped to ${swing}.`,
        expected: plan.drawnSwing,
        actual: swing,
      })
    }
  }
  if (lot.swing !== "either" && swing && swing !== lot.swing) {
    violations.push({
      code: "swing_forbidden_by_lot",
      message: `This lot takes only a ${lot.swing} garage; the home is configured ${swing}.`,
      expected: lot.swing,
      actual: swing,
    })
  }

  // Architectural control.
  if (lot.allowedElevationIds.length > 0 && !(elevation && lot.allowedElevationIds.includes(elevation.id))) {
    violations.push({
      code: "elevation_not_allowed",
      message: elevation
        ? "This elevation is not one the lot's architectural control allows."
        : "This lot allows only specific elevations; choose one of them.",
      expected: `${lot.allowedElevationIds.length} allowed`,
      actual: elevation?.id ?? null,
    })
  }

  // Dimensions and setbacks.
  const hasFootprint = plan.footprintWidthFt != null || plan.footprintDepthFt != null
  if (plan.footprintWidthFt == null || plan.footprintDepthFt == null) missing.add("plan_footprint")
  let buildable: LotFitEvaluation["buildable"] = { widthFt: null, depthFt: null }
  if (dimensions.irregular) {
    if (hasFootprint) {
      violations.push({
        code: "irregular_lot_unverified",
        message: "This lot is irregular, so a rectangle check cannot prove the footprint fits. Check the plot plan and record it.",
        expected: "plot plan reviewed",
        actual: "irregular lot",
      })
    }
  } else {
    const front = setback(dimensions, input.communitySetbacks, "frontSetbackFt")
    const rear = setback(dimensions, input.communitySetbacks, "rearSetbackFt")
    const side = setback(dimensions, input.communitySetbacks, "sideSetbackFt")
    const cornerSide = setback(dimensions, input.communitySetbacks, "cornerSideSetbackFt")
    const streetSide = dimensions.corner ? (cornerSide ?? side) : side
    if (front == null || rear == null || side == null || streetSide == null) missing.add("setbacks")

    if (dimensions.widthFt == null) missing.add("lot_width")
    if (dimensions.depthFt == null) missing.add("lot_depth")
    buildable = {
      widthFt: dimensions.widthFt == null ? null : dimensions.widthFt - (side ?? 0) - (streetSide ?? 0),
      depthFt: dimensions.depthFt == null ? null : dimensions.depthFt - (front ?? 0) - (rear ?? 0),
    }
    if (plan.footprintWidthFt != null && buildable.widthFt != null && plan.footprintWidthFt > buildable.widthFt + TOLERANCE_FT) {
      violations.push({
        code: "footprint_too_wide",
        message: `The plan is ${feet(plan.footprintWidthFt)} wide; the lot builds ${feet(Math.max(buildable.widthFt, 0))} between its side setbacks.`,
        expected: `≤ ${feet(Math.max(buildable.widthFt, 0))}`,
        actual: feet(plan.footprintWidthFt),
      })
    }
    if (plan.footprintDepthFt != null && buildable.depthFt != null && plan.footprintDepthFt > buildable.depthFt + TOLERANCE_FT) {
      violations.push({
        code: "footprint_too_deep",
        message: `The plan is ${feet(plan.footprintDepthFt)} deep; the lot builds ${feet(Math.max(buildable.depthFt, 0))} between its front and rear setbacks.`,
        expected: `≤ ${feet(Math.max(buildable.depthFt, 0))}`,
        actual: feet(plan.footprintDepthFt),
      })
    }
  }

  const missingList = [...missing]
  return {
    status: violations.length > 0 ? "violations" : missingList.length > 0 ? "unknown" : "fits",
    violations,
    missing: missingList,
    buildable,
    swing,
  }
}

/** What a recorded override speaks for. */
export interface LotFitOverrideScope {
  housePlanId: string
  elevationId: string | null
  swing: Handing | null
  violationCodes: readonly LotFitViolationCode[]
}

/**
 * An override covers a configuration only when it was recorded for that exact
 * plan, elevation and handing, and against every violation found now. Change
 * the elevation, flip the garage, or let a dimension edit add a violation, and
 * the old exception no longer speaks for it.
 */
export function overrideCoversFit(
  override: LotFitOverrideScope,
  current: { housePlanId: string; elevationId: string | null; swing: Handing | null; violations: readonly LotFitViolation[] },
): boolean {
  return (
    override.housePlanId === current.housePlanId &&
    override.elevationId === current.elevationId &&
    override.swing === current.swing &&
    current.violations.every((violation) => override.violationCodes.includes(violation.code))
  )
}

export function lotFitRefusal(violations: readonly LotFitViolation[]): string {
  return `This home does not fit the lot: ${violations.map((violation) => violation.message).join(" ")} Change the configuration, or record a fit override with evidence.`
}
