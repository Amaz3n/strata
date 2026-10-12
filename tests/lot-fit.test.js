"use strict"

/**
 * Does the house fit the lot: the rule (`lib/land/lot-fit.ts`) and the service
 * that loads its inputs and decides whether a recorded override covers what it
 * finds (`lib/services/lot-fit.ts`).
 */

const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness, id, ORG, ACTOR } = require("./support/service")
const { freshRequire } = require("./support/modules")

const { evaluateLotFit, overrideCoversFit } = freshRequire("lib/land/lot-fit.ts")
const { getLotFit, recordLotFitOverride, revokeLotFitOverride, setCommunitySetbacks } = freshRequire("lib/services/lot-fit.ts")

function fitInput(overrides = {}) {
  return {
    lot: { dimensions: { widthFt: 50, depthFt: 120, sideSetbackFt: 5, frontSetbackFt: 25, rearSetbackFt: 20 }, swing: "either", allowedElevationIds: [], ...overrides.lot },
    communitySetbacks: overrides.communitySetbacks ?? {},
    plan: { footprintWidthFt: 40, footprintDepthFt: 70, drawnSwing: "left", ...overrides.plan },
    elevation: overrides.elevation === undefined ? { id: "elev-a", swingApplicable: true } : overrides.elevation,
    swing: overrides.swing ?? null,
  }
}

const codes = (evaluation) => evaluation.violations.map((violation) => violation.code)

describe("evaluateLotFit", () => {
  test("a footprint inside the setbacks fits, including one exactly as wide as the envelope", () => {
    assert.equal(evaluateLotFit(fitInput()).status, "fits")
    const exact = evaluateLotFit(fitInput({ plan: { footprintWidthFt: 40, footprintDepthFt: 75 } }))
    assert.equal(exact.status, "fits")
    assert.deepEqual(exact.buildable, { widthFt: 40, depthFt: 75 })
  })

  test("a footprint wider or deeper than the buildable envelope is refused, and says by how much", () => {
    const evaluation = evaluateLotFit(fitInput({ plan: { footprintWidthFt: 42, footprintDepthFt: 80 } }))
    assert.equal(evaluation.status, "violations")
    assert.deepEqual(codes(evaluation), ["footprint_too_wide", "footprint_too_deep"])
    assert.match(evaluation.violations[0].message, /42 ft wide; the lot builds 40 ft/)
  })

  test("a lot's own setback wins over the community's, one key at a time, and a corner lot takes the corner-side setback", () => {
    const fromCommunity = fitInput({ lot: { dimensions: { widthFt: 50, depthFt: 120 } }, communitySetbacks: { sideSetbackFt: 6, frontSetbackFt: 25, rearSetbackFt: 20 } })
    assert.deepEqual(evaluateLotFit(fromCommunity).buildable, { widthFt: 38, depthFt: 75 })
    assert.deepEqual(codes(evaluateLotFit(fromCommunity)), ["footprint_too_wide"])

    const ownSide = fitInput({ lot: { dimensions: { widthFt: 50, depthFt: 120, sideSetbackFt: 5 } }, communitySetbacks: { sideSetbackFt: 6, frontSetbackFt: 25, rearSetbackFt: 20 } })
    assert.equal(evaluateLotFit(ownSide).status, "fits")

    const corner = fitInput({ lot: { dimensions: { widthFt: 50, depthFt: 120, corner: true } }, communitySetbacks: { sideSetbackFt: 5, cornerSideSetbackFt: 10, frontSetbackFt: 25, rearSetbackFt: 20 } })
    assert.deepEqual(evaluateLotFit(corner).buildable, { widthFt: 35, depthFt: 75 })
    assert.deepEqual(codes(evaluateLotFit(corner)), ["footprint_too_wide"])
  })

  test("a lot that takes one garage handing refuses the other, and a fixed elevation is built only as drawn", () => {
    assert.deepEqual(codes(evaluateLotFit(fitInput({ lot: { swing: "left" }, swing: "right" }))), ["swing_forbidden_by_lot"])
    assert.equal(evaluateLotFit(fitInput({ lot: { swing: "left" } })).swing, "left")

    const fixed = { id: "elev-a", swingApplicable: false }
    assert.deepEqual(codes(evaluateLotFit(fitInput({ elevation: fixed, swing: "right" }))), ["swing_not_applicable"])
    // A lot that takes only the other handing cannot hold an elevation that cannot be flipped.
    assert.deepEqual(codes(evaluateLotFit(fitInput({ elevation: fixed, lot: { swing: "right" } }))), ["swing_not_applicable"])
    assert.equal(evaluateLotFit(fitInput({ elevation: fixed })).swing, "left")
  })

  test("a lot under architectural control takes only the elevations it lists", () => {
    const controlled = { allowedElevationIds: ["elev-b"] }
    assert.deepEqual(codes(evaluateLotFit(fitInput({ lot: controlled }))), ["elevation_not_allowed"])
    assert.deepEqual(codes(evaluateLotFit(fitInput({ lot: controlled, elevation: null }))), ["elevation_not_allowed"])
    assert.equal(evaluateLotFit(fitInput({ lot: controlled, elevation: { id: "elev-b", swingApplicable: true } })).status, "fits")
  })

  test("an irregular lot cannot be proved by a rectangle, so a footprint there needs the plot plan on record", () => {
    const evaluation = evaluateLotFit(fitInput({ lot: { dimensions: { widthFt: 200, depthFt: 200, irregular: true } } }))
    assert.deepEqual(codes(evaluation), ["irregular_lot_unverified"])
  })

  test("missing measurements make the answer unknown rather than a refusal, and say what is missing", () => {
    const unmeasured = evaluateLotFit(fitInput({ lot: { dimensions: {} } }))
    assert.equal(unmeasured.status, "unknown")
    assert.deepEqual(unmeasured.missing, ["setbacks", "lot_width", "lot_depth"])

    const noFootprint = evaluateLotFit(fitInput({ plan: { footprintWidthFt: null, footprintDepthFt: null } }))
    assert.equal(noFootprint.status, "unknown")
    assert.deepEqual(noFootprint.missing, ["plan_footprint"])

    // Unknown setbacks are read as zero: a house wider than the raw lot is still refused.
    const tooWideAnyway = evaluateLotFit(fitInput({ lot: { dimensions: { widthFt: 30 } } }))
    assert.deepEqual(codes(tooWideAnyway), ["footprint_too_wide"])
  })

  test("an override covers only its plan, elevation and handing, and only the violations it was recorded against", () => {
    const violations = evaluateLotFit(fitInput({ plan: { footprintWidthFt: 42 } })).violations
    const scope = { housePlanId: "plan", elevationId: "elev-a", swing: "left", violationCodes: ["footprint_too_wide"] }
    const current = { housePlanId: "plan", elevationId: "elev-a", swing: "left", violations }
    assert.equal(overrideCoversFit(scope, current), true)
    assert.equal(overrideCoversFit(scope, { ...current, elevationId: "elev-b" }), false)
    assert.equal(overrideCoversFit(scope, { ...current, swing: "right" }), false)
    const deeperToo = evaluateLotFit(fitInput({ plan: { footprintWidthFt: 42, footprintDepthFt: 90 } })).violations
    assert.equal(overrideCoversFit(scope, { ...current, violations: deeperToo }), false)
  })
})

describe("lot fit service", () => {
  const COMMUNITY = id(1)
  const LOT = id(2)
  const PLAN = id(3)
  const ELEVATION = id(4)
  const OTHER_ELEVATION = id(5)
  const EVIDENCE = id(6)

  function harness({ permissions = ["community.read", "lot.fit_override", "community.write"], lot = {}, overrides = [], files = [{ id: EVIDENCE, org_id: ORG }] } = {}) {
    return createServiceHarness({
      permissions,
      tables: {
        communities: [{ id: COMMUNITY, org_id: ORG, name: "Oak", division_id: null, setbacks: { side_setback_ft: 5, front_setback_ft: 25, rear_setback_ft: 20 } }],
        lots: [{
          id: LOT, org_id: ORG, community_id: COMMUNITY, dimensions: { width_ft: 50, depth_ft: 120 }, swing: "left",
          house_plan_id: PLAN, house_plan_elevation_id: ELEVATION, ...lot,
        }],
        house_plans: [{ id: PLAN, org_id: ORG, footprint_width_ft: 42, footprint_depth_ft: 60, drawn_swing: "left" }],
        house_plan_elevations: [
          { id: ELEVATION, org_id: ORG, house_plan_id: PLAN, swing_applicable: true },
          { id: OTHER_ELEVATION, org_id: ORG, house_plan_id: PLAN, swing_applicable: true },
        ],
        lot_allowed_elevations: [],
        lot_fit_overrides: overrides,
        files,
      },
    })
  }

  const override = (extra = {}) => ({
    id: id(70), org_id: ORG, lot_id: LOT, house_plan_id: PLAN, house_plan_elevation_id: ELEVATION, swing: "left",
    violations: [{ code: "footprint_too_wide", message: "", expected: null, actual: null }],
    reason: "County granted a side-yard variance", evidence_file_id: EVIDENCE, approved_by: ACTOR,
    approved_at: "2026-10-01T00:00:00Z", revoked_at: null, ...extra,
  })

  test("a pinned home that does not fit is refused with the reason in words", async () => {
    const verdict = await harness().run(() => getLotFit(LOT))
    assert.equal(verdict.evaluation.status, "violations")
    assert.equal(verdict.override, null)
    assert.match(verdict.refusal, /42 ft wide; the lot builds 40 ft/)
  })

  test("a matching override lets it stand; a different elevation or handing is not covered", async () => {
    const covered = await harness({ overrides: [override()] }).run(() => getLotFit(LOT))
    assert.equal(covered.refusal, null)
    assert.equal(covered.override.reason, "County granted a side-yard variance")

    const otherElevation = await harness({ overrides: [override()] }).run(() => getLotFit(LOT, { elevationId: OTHER_ELEVATION }))
    assert.ok(otherElevation.refusal)
    const flipped = await harness({ lot: { swing: "either" }, overrides: [override()] }).run(() => getLotFit(LOT, { swing: "right" }))
    assert.ok(flipped.refusal)
    const revoked = await harness({ overrides: [override({ revoked_at: "2026-10-02T00:00:00Z", revoked_by: ACTOR })] }).run(() => getLotFit(LOT))
    assert.ok(revoked.refusal)
  })

  test("a lot with no measurements does not block", async () => {
    const verdict = await harness({ lot: { dimensions: {} } }).run(() => getLotFit(LOT))
    assert.equal(verdict.evaluation.status, "unknown")
    assert.equal(verdict.refusal, null)
  })

  test("recording an override takes the permission, a reason and evidence on file, and records what it covers", async () => {
    const input = { lotId: LOT, housePlanId: PLAN, elevationId: ELEVATION, swing: null, reason: "County granted a side-yard variance", evidenceFileId: EVIDENCE }

    const seller = harness({ permissions: ["community.read"] })
    await assert.rejects(seller.run(() => recordLotFitOverride(input)), /Missing permission/)
    const noEvidence = harness({ files: [] })
    await assert.rejects(noEvidence.run(() => recordLotFitOverride(input)), /evidence file was not found/)
    await assert.rejects(harness().run(() => recordLotFitOverride({ ...input, reason: "ok" })), /Say why/)
    await assert.rejects(harness({ lot: { dimensions: {} } }).run(() => recordLotFitOverride(input)), /nothing to override/)
    assert.deepEqual([...seller.writes(), ...noEvidence.writes("lot_fit_overrides").filter((query) => query.action === "insert")], [])

    const service = harness()
    const recorded = await service.run(() => recordLotFitOverride(input))
    assert.deepEqual([recorded.swing, recorded.violationCodes], ["left", ["footprint_too_wide"]])
    assert.equal(service.db.lot_fit_overrides.filter((row) => !row.revoked_at).length, 1)
    assert.deepEqual(service.events.map((event) => event.eventType), ["lot.fit_overridden"])
    assert.equal((await service.run(() => getLotFit(LOT))).refusal, null)

    await service.run(() => revokeLotFitOverride(recorded.id))
    assert.ok((await service.run(() => getLotFit(LOT))).refusal)
    assert.equal(service.events.at(-1).eventType, "lot.fit_override_revoked")
  })

  test("tightening a community's setbacks flags the pinned homes that stop fitting and unpins nothing", async () => {
    const service = harness({ lot: { dimensions: { width_ft: 52, depth_ft: 120 } } })
    assert.equal((await service.run(() => getLotFit(LOT))).refusal, null)
    const result = await service.run(() => setCommunitySetbacks(COMMUNITY, { sideSetbackFt: 6, frontSetbackFt: 25, rearSetbackFt: 20 }))
    assert.equal(result.homesNoLongerFitting, 1)
    assert.equal(service.db.lots[0].house_plan_id, PLAN)
    assert.deepEqual(service.events.map((event) => event.eventType), ["lot.fit_violated", "community.setbacks_changed"])
  })
})
