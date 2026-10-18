const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness, replies, id, ORG, ACTOR } = require("./support/service")
const { stubModule, freshRequire } = require("./support/modules")

// A deal's pricing worksheet lives in the precon services; this is that store.
let worksheet = { available: true, pricing: null }
stubModule("@/lib/services/precon-workspace", {
  getPreconWorkspace: async () => structuredClone(worksheet),
})

const { CONDITION_COLORS } = require("@/lib/drawings/takeoff-palette")
const {
  STALE_WRITE,
  assertMarkupsInScope,
  assignMarkupsToCondition,
  createTakeoffCondition,
  deleteTakeoffCondition,
  getConditionLandingSheet,
  getConditionRollup,
  listTakeoffConditions,
  updateTakeoffCondition,
} = freshRequire("lib/services/takeoff.ts")

const FOREIGN_ORG = id(1)
const PROJECT = id(2)
const OTHER_PROJECT = id(3)
const PLAN = id(4)
const PLAN_VERSION = id(5)
const DIVISION = id(6)
const CODE = id(7)
const CONDITION = id(8)
const CREATOR = id(9)
const SHEET = id(10)
const OTHER_SHEET = id(11)
const REVISION = id(12)
const PROSPECT = id(13)
const ESTIMATE = id(14)
const MISSING = id(99)

const SEEN = "2026-10-04T12:00:00.123456+00:00"
const LATER = "2026-10-04T13:00:00.654321+00:00"

const READER = ["takeoff.read", "project.read"]
const WRITER = [...READER, "takeoff.write"]

const SQUARE = [[0.1, 0.1], [0.5, 0.1], [0.5, 0.5], [0.1, 0.5]]

function condition(overrides = {}) {
  return {
    id: CONDITION,
    org_id: ORG,
    project_id: PROJECT,
    house_plan_version_id: null,
    name: "Wall",
    uom: "sf",
    depth_in: null,
    height_ft: null,
    pitch_rise: null,
    tons_per_cy: null,
    cost_code_id: CODE,
    color: CONDITION_COLORS[0],
    waste_pct: 8,
    unit_cost_cents: 12345,
    share_with_clients: true,
    notes: "Original",
    sort_order: 4,
    created_by: CREATOR,
    created_at: SEEN,
    updated_at: SEEN,
    ...overrides,
  }
}

/** The plan-library twin of `condition()`. */
const planCondition = (overrides = {}) =>
  condition({ project_id: null, house_plan_version_id: PLAN_VERSION, ...overrides })

/**
 * A 10.25 sf area on `drawing_sheet_id` (SHEET by default), assigned to
 * CONDITION, on the sheet's current revision, with the embedded sheet, version
 * and revision rows the member reader selects. `project` moves the sheet.
 */
function member(n, overrides = {}) {
  const sheet = overrides.drawing_sheet_id ?? SHEET
  const project = overrides.project ?? PROJECT
  const version = {
    id: id(5000 + Number(sheet.slice(-4))),
    org_id: ORG,
    drawing_sheet_id: sheet,
    drawing_revision_id: REVISION,
    drawing_revisions: { id: REVISION, org_id: ORG, project_id: project },
  }
  const row = {
    id: id(1000 + n),
    org_id: ORG,
    condition_id: CONDITION,
    quantity: "10.25",
    uom: "sf",
    data: { type: "area", points: SQUARE, style: {} },
    sheet_version_id: version.id,
    drawing_sheet_id: sheet,
    is_private: false,
    created_by: ACTOR,
    drawing_sheets: {
      id: sheet,
      org_id: ORG,
      project_id: project,
      sheet_number: "A-101",
      sheet_title: null,
      current_revision_id: REVISION,
    },
    drawing_sheet_versions: version,
    ...overrides,
  }
  delete row.project
  return row
}

function costCode(overrides = {}) {
  return {
    id: CODE,
    org_id: ORG,
    code: "09.10",
    name: "Original finish",
    unit: "sf",
    default_unit_cost_cents: "430",
    is_active: false,
    ...overrides,
  }
}

function tables(overrides = {}) {
  return {
    projects: [
      { id: PROJECT, org_id: ORG, division_id: DIVISION, prospect_id: null },
      { id: OTHER_PROJECT, org_id: ORG, division_id: DIVISION, prospect_id: null },
    ],
    house_plan_versions: [{ id: PLAN_VERSION, org_id: ORG, house_plan_id: PLAN }],
    house_plans: [{ id: PLAN, org_id: ORG, division_id: DIVISION }],
    lots: [{ id: id(20), org_id: ORG, house_plan_id: PLAN, project_id: PROJECT }],
    cost_codes: [costCode()],
    takeoff_conditions: [condition()],
    drawing_markups: [],
    ...overrides,
  }
}

function harness({ permissions = WRITER, ...options } = {}) {
  return createServiceHarness({ permissions, ...options, tables: tables(options.tables) })
}

/** A business-table read error or refusal must leave nothing written or audited. */
function assertNothingWritten(service) {
  assert.deepEqual(service.writes(), [])
  assert.deepEqual(service.audits, [])
  assert.deepEqual(service.events, [])
}

// ============================================================================
// listTakeoffConditions
// ============================================================================

describe("listTakeoffConditions", () => {
  test("a malformed or ambiguous scope is refused before anything is read", async () => {
    for (const filters of [
      { project_id: "bad" },
      {},
      { project_id: PROJECT, house_plan_version_id: PLAN_VERSION },
    ]) {
      const service = harness()
      await assert.rejects(service.run(() => listTakeoffConditions(filters)))
      assert.deepEqual(service.reads("takeoff_conditions"), [])
    }
  })

  test("a project member lists the project's conditions with stored numerics parsed", async () => {
    const service = harness({
      permissions: ["takeoff.read"],
      projects: [PROJECT],
      tables: { takeoff_conditions: [condition({ waste_pct: "5.75" })] },
    })
    const rows = await service.run(() => listTakeoffConditions({ project_id: PROJECT }))
    assert.deepEqual(rows.map((row) => [row.id, row.waste_pct]), [[CONDITION, 5.75]])
  })

  test("an actor without access to the project reads nothing", async () => {
    const service = harness({ projects: [OTHER_PROJECT] })
    await assert.rejects(service.run(() => listTakeoffConditions({ project_id: PROJECT })), /Missing permission/)
    assert.deepEqual(service.reads("takeoff_conditions"), [])
  })

  test("every condition is returned however short the database's pages are", async () => {
    for (const count of [0, 201, 713]) {
      const rows = Array.from({ length: count }, (_, i) => condition({ id: id(10000 + i) }))
      const service = harness({ maxRows: 37, tables: { takeoff_conditions: rows } })
      const listed = await service.run(() => listTakeoffConditions({ project_id: PROJECT }))
      assert.equal(new Set(listed.map((row) => row.id)).size, count)
    }
  })

  test("more conditions than the read limit is an explicit refusal, not a truncated list", async () => {
    const rows = Array.from({ length: 10001 }, (_, i) => condition({ id: id(10000 + i) }))
    const service = harness({ tables: { takeoff_conditions: rows } })
    await assert.rejects(service.run(() => listTakeoffConditions({ project_id: PROJECT })), /Validation limit/)
  })

  test("a failed, empty-bodied, stalled or foreign page is an error, never an empty list", async () => {
    for (const reply of [
      replies.missing(),
      replies.error(),
      replies.rows([condition()]),
      replies.rows([condition({ org_id: FOREIGN_ORG })]),
    ]) {
      const service = harness()
      service.tamper("takeoff_conditions", reply)
      await assert.rejects(service.run(() => listTakeoffConditions({ project_id: PROJECT })))
    }
  })

  test("a stored row with an invalid header, factor, rate or waste is refused", async () => {
    for (const patch of [
      { project_id: OTHER_PROJECT },
      { house_plan_version_id: PLAN_VERSION },
      { name: " " },
      { color: "bad" },
      { created_by: "bad" },
      { created_at: "bad" },
      { updated_at: "bad" },
      { sort_order: 0.5 },
      { share_with_clients: "false" },
      { notes: undefined },
      { uom: "bad" },
      { depth_in: 0 },
      { height_ft: Infinity },
      { waste_pct: null },
      { waste_pct: "bad" },
      { waste_pct: 101 },
      { unit_cost_cents: 1.5 },
      { unit_cost_cents: -1 },
      { unit_cost_cents: Infinity },
    ]) {
      const service = harness()
      service.tamper("takeoff_conditions", replies.patch(patch), { times: 1 })
      await assert.rejects(service.run(() => listTakeoffConditions({ project_id: PROJECT })), undefined, JSON.stringify(patch))
    }
  })

  test("legacy rows the create form would now refuse stay readable", async () => {
    const longName = "Original ".repeat(50)
    const service = harness({
      tables: {
        takeoff_conditions: [
          condition({ name: longName, uom: "cy", depth_in: "6", unit_cost_cents: "420" }),
          condition({ id: id(30), height_ft: 300 }),
        ],
      },
    })
    const [cubic, tall] = await service.run(() => listTakeoffConditions({ project_id: PROJECT }))
    assert.equal(cubic.name, longName)
    assert.equal(cubic.depth_in, 6)
    assert.equal(cubic.unit_cost_cents, 420)
    assert.equal(tall.height_ft, 300)
  })

  test("conditions are ordered by position, then creation instant to the microsecond, then id", async () => {
    const earlier = "2026-10-04T12:00:00.123455Z"
    const service = harness({
      tables: {
        takeoff_conditions: [
          condition({ id: id(31), sort_order: 1 }),
          condition({ id: id(32), sort_order: 0 }),
          condition({ id: id(33), sort_order: 0, created_at: earlier }),
          condition({ id: id(30), sort_order: 0 }),
        ],
      },
    })
    const rows = await service.run(() => listTakeoffConditions({ project_id: PROJECT }))
    assert.deepEqual(rows.map((row) => row.id), [id(33), id(30), id(32), id(31)])
  })

  test("a plan library is listed under the org permission and the plan's division", async () => {
    const service = harness({
      divisions: [DIVISION],
      tables: { takeoff_conditions: [planCondition()] },
    })
    const rows = await service.run(() => listTakeoffConditions({ house_plan_version_id: PLAN_VERSION }))
    assert.equal(rows.length, 1)
  })

  test("a plan outside the actor's reach, or one that cannot be verified, is refused before any condition read", async () => {
    const cases = [
      { permissions: ["project.read"] },
      { divisions: [MISSING] },
      { tamper: ["house_plan_versions", replies.missing()] },
      { tamper: ["house_plans", replies.missing()] },
      { tamper: ["house_plan_versions", replies.rows({ id: PLAN_VERSION, org_id: FOREIGN_ORG, house_plan_id: PLAN })] },
      { tamper: ["house_plans", replies.rows({ id: PLAN, org_id: FOREIGN_ORG, division_id: DIVISION })] },
    ]
    for (const { tamper, ...options } of cases) {
      const service = harness({ ...options, tables: { takeoff_conditions: [planCondition()] } })
      if (tamper) service.tamper(...tamper)
      await assert.rejects(service.run(() => listTakeoffConditions({ house_plan_version_id: PLAN_VERSION })))
      assert.deepEqual(service.reads("takeoff_conditions"), [])
    }
  })
})

// ============================================================================
// createTakeoffCondition
// ============================================================================

describe("createTakeoffCondition", () => {
  const input = {
    project_id: PROJECT,
    name: "Tile",
    uom: "sf",
    cost_code_id: CODE,
    unit_cost_cents: 12345,
    height_ft: 9,
    waste_pct: 8,
    share_with_clients: true,
    notes: "Reviewed measured item",
  }
  const planInput = { ...input, project_id: null, house_plan_version_id: PLAN_VERSION }
  const sibling = (index, overrides = {}) =>
    condition({ id: id(100 + index), color: CONDITION_COLORS[index % CONDITION_COLORS.length], ...overrides })

  test("an invalid home is refused before anything is read", async () => {
    const service = harness()
    await assert.rejects(service.run(() => createTakeoffCondition({ ...input, project_id: "invalid" })))
    assert.deepEqual(service.queries, [])
  })

  test("an actor without takeoff.write creates nothing", async () => {
    const service = harness({ permissions: READER, tables: { takeoff_conditions: [] } })
    await assert.rejects(service.run(() => createTakeoffCondition(input)), /Missing permission: takeoff.write/)
    assert.deepEqual(service.reads("takeoff_conditions"), [])
    assertNothingWritten(service)
  })

  test("a project outside the actor's reach, or outside the org, is refused before placement is read", async () => {
    for (const [options, projectId] of [[{ projects: [OTHER_PROJECT] }, PROJECT], [{}, MISSING]]) {
      const service = harness({ ...options, tables: { takeoff_conditions: [] } })
      await assert.rejects(service.run(() => createTakeoffCondition({ ...input, project_id: projectId })), /Missing permission/)
      assert.deepEqual(service.reads("takeoff_conditions"), [])
      assertNothingWritten(service)
    }
  })

  test("a plan condition needs the org's own plan version, its parent plan, and the actor's division", async () => {
    const cases = [
      { tables: { house_plan_versions: [] } },
      { tables: { house_plan_versions: [{ id: PLAN_VERSION, org_id: FOREIGN_ORG, house_plan_id: PLAN }] } },
      { tables: { house_plans: [] } },
      { tables: { house_plans: [{ id: PLAN, org_id: FOREIGN_ORG, division_id: DIVISION }] } },
      { tamper: ["house_plan_versions", replies.error()] },
      { tamper: ["house_plans", replies.error()] },
      { divisions: [MISSING] },
    ]
    for (const { tamper, ...options } of cases) {
      const service = harness({ ...options, tables: { takeoff_conditions: [], ...options.tables } })
      if (tamper) service.tamper(...tamper)
      await assert.rejects(service.run(() => createTakeoffCondition(planInput)), /unavailable/)
      assertNothingWritten(service)
    }
  })

  test("a cost code that is missing, foreign or unreadable is refused", async () => {
    const cases = [
      { tables: { cost_codes: [] } },
      { tables: { cost_codes: [costCode({ org_id: FOREIGN_ORG })] } },
      { tamper: ["cost_codes", replies.error()] },
      { tamper: ["cost_codes", replies.missing()] },
    ]
    for (const { tamper, ...options } of cases) {
      const service = harness({ ...options, tables: { takeoff_conditions: [], ...options.tables } })
      if (tamper) service.tamper(...tamper)
      await assert.rejects(service.run(() => createTakeoffCondition(input)), /cost codes unavailable/)
      assertNothingWritten(service)
    }
  })

  test("placement that cannot be verified never defaults to the first slot", async () => {
    const withCount = (count) => (result) => ({ ...result, count })
    const cases = [
      ...[null, undefined, -1, 0.5, "0", 1].map((count) => ({ tamper: withCount(count) })),
      { tamper: replies.missing() },
      { tamper: replies.error() },
      { siblings: [sibling(1, { color: "invalid" })] },
      { tamper: (result) => ({ ...result, data: [sibling(1, { org_id: FOREIGN_ORG })], count: 1 }) },
      { tamper: (result) => ({ ...result, data: [sibling(1, { project_id: MISSING })], count: 1 }) },
      { tamper: (result) => ({ ...result, data: [sibling(1), sibling(1)], count: 2 }) },
    ]
    for (const { tamper, siblings = [] } of cases) {
      const service = harness({ tables: { takeoff_conditions: siblings } })
      if (tamper) service.tamper("takeoff_conditions", tamper, { on: "select" })
      await assert.rejects(service.run(() => createTakeoffCondition(input)), /takeoff placement/)
      assertNothingWritten(service)
    }
  })

  test("a saved row that differs from what was requested is not reported as created", async () => {
    for (const change of [
      { org_id: FOREIGN_ORG },
      { project_id: MISSING },
      { house_plan_version_id: PLAN_VERSION },
      { name: "Changed" },
      { unit_cost_cents: 1 },
      { cost_code_id: MISSING },
      { created_by: MISSING },
      { height_ft: 10 },
      { share_with_clients: false },
      { sort_order: 99 },
      { color: "#000000" },
    ]) {
      const service = harness({ tables: { takeoff_conditions: [] } })
      service.tamper("takeoff_conditions", replies.patch(change), { on: "insert" })
      await assert.rejects(service.run(() => createTakeoffCondition(input)), /could not be confirmed/)
      assert.deepEqual(service.audits, [])
      assert.deepEqual(service.events, [])
    }
  })

  test("an insert that returns no row is a failure, not a phantom creation", async () => {
    const service = harness({ tables: { takeoff_conditions: [] } })
    service.tamper("takeoff_conditions", replies.missing(), { on: "insert" })
    await assert.rejects(service.run(() => createTakeoffCondition(input)), /Failed to create/)
    assert.deepEqual(service.audits, [])
    assert.deepEqual(service.events, [])
  })

  test("a new condition keeps its integer rate and factors, and is attributed to the actor", async () => {
    const service = harness({ tables: { takeoff_conditions: [] } })
    const saved = await service.run(() => createTakeoffCondition(input))
    assert.equal(saved.unit_cost_cents, 12345)
    assert.equal(saved.height_ft, 9)
    assert.equal(saved.cost_code_id, CODE)
    assert.equal(saved.org_id, ORG)
    assert.equal(saved.project_id, PROJECT)
    assert.equal(saved.house_plan_version_id, null)
    assert.equal(saved.created_by, ACTOR)
    assert.equal(saved.sort_order, 0)
    assert.equal(saved.color, CONDITION_COLORS[0])
    assert.equal(service.audits[0].actorId, ACTOR)
    assert.equal(service.events[0].entityId, saved.id)
  })

  test("a new condition takes the next position and the next free palette color", async () => {
    const service = harness({ tables: { takeoff_conditions: [sibling(0)] } })
    const saved = await service.run(() => createTakeoffCondition(input))
    assert.equal(saved.sort_order, 1)
    assert.equal(saved.color, CONDITION_COLORS[1])
  })

  test("an explicit color is kept, and a full palette wraps to the first color", async () => {
    const siblings = CONDITION_COLORS.map((_, index) => sibling(index))
    const chosen = harness({ tables: { takeoff_conditions: siblings } })
    const kept = await chosen.run(() => createTakeoffCondition({ ...input, color: CONDITION_COLORS[0] }))
    assert.equal(kept.color, CONDITION_COLORS[0])
    const wrapped = harness({ tables: { takeoff_conditions: siblings } })
    assert.equal((await wrapped.run(() => createTakeoffCondition(input))).color, CONDITION_COLORS[0])
  })

  test("a scope at or over 200 conditions takes no more", async () => {
    for (const count of [200, 250]) {
      const siblings = Array.from({ length: count }, (_, index) => sibling(index))
      const service = harness({ tables: { takeoff_conditions: siblings } })
      await assert.rejects(service.run(() => createTakeoffCondition(input)), /at most 200/)
      assertNothingWritten(service)
    }
  })

  test("a plan condition is created on the exact version for an actor in its division", async () => {
    const service = harness({ divisions: [DIVISION], tables: { takeoff_conditions: [] } })
    const saved = await service.run(() => createTakeoffCondition(planInput))
    assert.equal(saved.project_id, null)
    assert.equal(saved.house_plan_version_id, PLAN_VERSION)
  })

  test("an org-wide plan stays open to a division-restricted actor", async () => {
    const service = harness({
      divisions: [],
      tables: { takeoff_conditions: [], house_plans: [{ id: PLAN, org_id: ORG, division_id: null }] },
    })
    const saved = await service.run(() => createTakeoffCondition(planInput))
    assert.equal(saved.house_plan_version_id, PLAN_VERSION)
  })
})

// ============================================================================
// updateTakeoffCondition
// ============================================================================

describe("updateTakeoffCondition", () => {
  const update = (service, changes, seen) =>
    service.run(() => updateTakeoffCondition(CONDITION, changes, undefined, seen))

  /** The condition another session saves between our read and our write. */
  function raceAfterRead(service, kind) {
    service.tamper("takeoff_conditions", (result) => {
      if (kind === "removed") service.db.takeoff_conditions.splice(0)
      else service.db.takeoff_conditions[0].updated_at = LATER
      return result
    }, { on: "select", times: 1 })
  }

  test("an invalid id, revision or change is refused before anything is read", async () => {
    for (const [conditionId, seen, changes] of [
      ["invalid", undefined, {}],
      [CONDITION, "invalid", {}],
      [CONDITION, 42, {}],
      [CONDITION, undefined, { unit_cost_cents: 1.5 }],
    ]) {
      const service = harness()
      await assert.rejects(service.run(() => updateTakeoffCondition(conditionId, changes, undefined, seen)))
      assert.deepEqual(service.queries, [])
    }
  })

  test("a condition the actor cannot reach, or that cannot be verified, is not updated", async () => {
    const cases = [
      { permissions: READER },
      { tamper: replies.error() },
      { tables: { takeoff_conditions: [] } },
      { tamper: replies.missing() },
      { tamper: replies.patch({ org_id: FOREIGN_ORG }) },
      { tamper: replies.patch({ id: MISSING }) },
      { tables: { takeoff_conditions: [condition({ updated_at: null })] } },
      { tables: { takeoff_conditions: [condition({ updated_at: "invalid" })] } },
      { projects: [OTHER_PROJECT] },
      { tables: { takeoff_conditions: [condition({ project_id: MISSING })] } },
      { tables: { takeoff_conditions: [condition({ project_id: null })] } },
      { tables: { takeoff_conditions: [condition({ house_plan_version_id: PLAN_VERSION })] } },
    ]
    for (const { tamper, ...options } of cases) {
      const service = harness(options)
      if (tamper) service.tamper("takeoff_conditions", tamper, { on: "select" })
      await assert.rejects(update(service, { notes: "Changed" }), undefined, JSON.stringify(options))
      assertNothingWritten(service)
    }
  })

  test("a stale rendered revision is refused, even for an empty change", async () => {
    const service = harness()
    await assert.rejects(update(service, {}, LATER), { message: STALE_WRITE })
    assertNothingWritten(service)
  })

  test("a change saved by someone else between read and write is refused, not overwritten", async () => {
    for (const kind of ["changed", "removed"]) {
      for (const seen of [undefined, SEEN]) {
        const service = harness()
        raceAfterRead(service, kind)
        await assert.rejects(update(service, { notes: "Changed" }, seen), { message: STALE_WRITE })
        assert.deepEqual(service.audits, [])
        if (kind === "changed") assert.equal(service.db.takeoff_conditions[0].notes, "Original")
      }
    }
  })

  test("a stored cost code that is missing, foreign or unreadable blocks the update", async () => {
    const cases = [
      { tables: { cost_codes: [] } },
      { tables: { cost_codes: [costCode({ org_id: FOREIGN_ORG })] } },
      { tamper: replies.error() },
      { tamper: replies.missing() },
    ]
    for (const { tamper, ...options } of cases) {
      const service = harness(options)
      if (tamper) service.tamper("cost_codes", tamper)
      await assert.rejects(update(service, { notes: "Changed" }), /cost codes unavailable/)
      assertNothingWritten(service)
    }
  })

  test("a broken cost code reference can be cleared but not replaced with another bad one", async () => {
    const service = harness({ tables: { cost_codes: [] } })
    await assert.rejects(update(service, { cost_code_id: MISSING }), /cost codes unavailable/)
    assertNothingWritten(service)
    assert.equal((await update(service, { cost_code_id: null })).cost_code_id, null)
  })

  test("a unit-changing factor is refused when the member count cannot be verified", async () => {
    const withCount = (count) => (result) => ({ ...result, count })
    for (const tamper of [...[null, undefined, -1, 0.5, "0"].map(withCount), replies.error()]) {
      const service = harness()
      service.tamper("drawing_markups", tamper)
      await assert.rejects(update(service, { height_ft: 9 }), /verify condition measurements/)
      assertNothingWritten(service)
    }
  })

  test("a wall height cannot be set while measurements depend on the current unit", async () => {
    const service = harness({ tables: { drawing_markups: [{ id: id(40), org_id: ORG, condition_id: CONDITION }] } })
    await assert.rejects(update(service, { height_ft: 9 }), /Release its 1 measurement first/)
    assertNothingWritten(service)
  })

  test("with no members a wall height can be set, and a price change never counts members", async () => {
    const empty = harness()
    assert.equal((await update(empty, { height_ft: 9 })).height_ft, 9)
    const priced = harness()
    priced.tamper("drawing_markups", replies.error())
    assert.equal((await update(priced, { unit_cost_cents: 23456 })).unit_cost_cents, 23456)
    assert.deepEqual(priced.reads("drawing_markups"), [])
  })

  test("factor rules are checked against the stored unit", async () => {
    const service = harness({ tables: { takeoff_conditions: [condition({ uom: "cy", depth_in: 6 })] } })
    await assert.rejects(update(service, { depth_in: null }), /needs a depth/)
    assertNothingWritten(service)
  })

  test("a saved row that differs from the requested change is not reported, repainted or audited", async () => {
    for (const change of [
      { id: MISSING },
      { org_id: FOREIGN_ORG },
      { project_id: MISSING },
      { house_plan_version_id: PLAN_VERSION },
      { name: "Different" },
      { uom: "ea" },
      { unit_cost_cents: 1 },
      { cost_code_id: MISSING },
      { color: CONDITION_COLORS[2] },
      { share_with_clients: false },
      { notes: "Different" },
      { sort_order: 99 },
      { created_by: ACTOR },
      { created_at: LATER },
      { updated_at: "invalid" },
    ]) {
      const service = harness()
      service.tamper("takeoff_conditions", replies.patch(change), { on: "update" })
      await assert.rejects(update(service, { color: CONDITION_COLORS[1] }), /could not be confirmed/)
      assert.deepEqual(service.audits, [])
      assert.deepEqual(service.writes("rpc:repaint_condition_markups"), [])
    }
  })

  test("a failed or empty update reply is not reported, repainted or audited", async () => {
    for (const reply of [replies.missing(), replies.error()]) {
      const service = harness()
      service.tamper("takeoff_conditions", reply, { on: "update" })
      await assert.rejects(update(service, { color: CONDITION_COLORS[1] }))
      assert.deepEqual(service.audits, [])
      assert.deepEqual(service.writes("rpc:repaint_condition_markups"), [])
    }
  })

  test("a new color repaints the condition's measurements and keeps the original creator", async () => {
    const service = harness({
      tables: { drawing_markups: [{ id: id(40), org_id: ORG, condition_id: CONDITION, data: { color: CONDITION_COLORS[0] } }] },
      rpc: {
        repaint_condition_markups: ({ p_org_id, p_condition_id, p_color }, store) => {
          for (const markup of store.drawing_markups) {
            if (markup.org_id === p_org_id && markup.condition_id === p_condition_id) markup.data.color = p_color
          }
          return { data: null, error: null }
        },
      },
    })
    const saved = await update(service, { color: CONDITION_COLORS[1], unit_cost_cents: 23456 }, SEEN)
    assert.equal(saved.created_by, CREATOR)
    assert.equal(saved.unit_cost_cents, 23456)
    assert.notEqual(saved.updated_at, SEEN)
    assert.equal(service.db.drawing_markups[0].data.color, CONDITION_COLORS[1])
    assert.equal(service.audits[0].actorId, ACTOR)
  })

  test("a failed repaint surfaces and is not audited", async () => {
    const service = harness({
      rpc: { repaint_condition_markups: () => ({ data: null, error: { message: "Repaint unavailable" } }) },
    })
    await assert.rejects(update(service, { color: CONDITION_COLORS[1] }), /Repaint unavailable/)
    assert.deepEqual(service.audits, [])
  })

  test.todo("a failed repaint rolls the color change back") // owner: takeoff — update and repaint are not one transaction

  test("a plan condition is updated only through the org's own plan and the actor's division", async () => {
    const cases = [
      { tables: { house_plan_versions: [] } },
      { tables: { house_plans: [{ id: PLAN, org_id: FOREIGN_ORG, division_id: DIVISION }] } },
      { divisions: [MISSING] },
    ]
    for (const options of cases) {
      const service = harness({ ...options, tables: { takeoff_conditions: [planCondition()], ...options.tables } })
      await assert.rejects(update(service, { notes: "Changed" }), /unavailable/)
      assertNothingWritten(service)
    }
  })

  test("an actor in the plan's division, or on an org-wide plan, can update it", async () => {
    for (const division of [DIVISION, null]) {
      const service = harness({
        divisions: [DIVISION],
        tables: { takeoff_conditions: [planCondition()], house_plans: [{ id: PLAN, org_id: ORG, division_id: division }] },
      })
      assert.equal((await update(service, { notes: "Changed" })).house_plan_version_id, PLAN_VERSION)
    }
  })

  test("an empty change is still access-checked but writes and audits nothing", async () => {
    const service = harness()
    assert.equal((await update(service, {})).updated_at, SEEN)
    assertNothingWritten(service)
    const denied = harness({ projects: [OTHER_PROJECT] })
    await assert.rejects(update(denied, {}), /Missing permission/)
  })
})

// ============================================================================
// deleteTakeoffCondition
// ============================================================================

describe("deleteTakeoffCondition", () => {
  const remove = (service, seen) => service.run(() => deleteTakeoffCondition(CONDITION, undefined, seen))
  const detachReturning = (data, error = null) => ({ detach_takeoff_condition_lines: () => ({ data, error }) })
  const released = (n, overrides = {}) => ({ id: id(300 + n), org_id: ORG, condition_id: CONDITION, ...overrides })

  function deleting({ detached = 2, ...options } = {}) {
    return harness({ rpc: detachReturning(detached), ...options })
  }

  test("an invalid id or revision is refused before anything is read", async () => {
    for (const [conditionId, seen] of [["invalid", undefined], [CONDITION, "invalid"], [CONDITION, 42]]) {
      const service = deleting()
      await assert.rejects(service.run(() => deleteTakeoffCondition(conditionId, undefined, seen)))
      assert.deepEqual(service.queries, [])
    }
  })

  test("a condition the actor cannot reach, or that cannot be verified, is not touched", async () => {
    const cases = [
      { permissions: READER },
      { tamper: replies.error() },
      { tables: { takeoff_conditions: [] } },
      { tamper: replies.missing() },
      { tamper: replies.patch({ org_id: FOREIGN_ORG }) },
      { tamper: replies.patch({ id: MISSING }) },
      { tables: { takeoff_conditions: [condition({ updated_at: null })] } },
      { tables: { takeoff_conditions: [condition({ updated_at: "invalid" })] } },
      { projects: [OTHER_PROJECT] },
      { tables: { takeoff_conditions: [condition({ project_id: MISSING })] } },
      { tables: { takeoff_conditions: [condition({ project_id: null })] } },
      { tables: { takeoff_conditions: [condition({ house_plan_version_id: PLAN_VERSION })] } },
    ]
    for (const { tamper, ...options } of cases) {
      const service = deleting(options)
      if (tamper) service.tamper("takeoff_conditions", tamper, { on: "select" })
      await assert.rejects(remove(service), undefined, JSON.stringify(options))
      assertNothingWritten(service)
    }
  })

  test("a stale confirmation is refused before anything changes", async () => {
    const service = deleting()
    await assert.rejects(remove(service, LATER), { message: STALE_WRITE })
    assertNothingWritten(service)
  })

  test("an unconfirmed number of detached lines stops the delete before measurements are released", async () => {
    for (const count of [null, undefined, -1, 0.5, "0", NaN, Infinity]) {
      const service = harness({ rpc: detachReturning(count) })
      await assert.rejects(remove(service), /Detached condition lines could not be confirmed/)
      assert.deepEqual(service.writes("drawing_markups"), [])
      assert.deepEqual(service.writes("takeoff_conditions"), [])
      assert.deepEqual(service.audits, [])
    }
  })

  test("a failed detach stops the delete before measurements are released", async () => {
    const service = harness({ rpc: detachReturning(null, { message: "Detach unavailable" }) })
    await assert.rejects(remove(service), /Detach unavailable/)
    assert.deepEqual(service.writes("drawing_markups"), [])
    assert.deepEqual(service.audits, [])
  })

  test("an unconfirmed release keeps the condition", async () => {
    const releasedRow = { id: id(300), org_id: ORG, condition_id: null }
    const withCount = (count) => (result) => ({ ...result, count })
    for (const tamper of [
      replies.missing(),
      replies.rows([releasedRow, releasedRow]),
      replies.rows([{ ...releasedRow, id: "" }]),
      replies.rows([{ ...releasedRow, org_id: FOREIGN_ORG }]),
      replies.rows([{ ...releasedRow, condition_id: CONDITION }]),
      ...[null, undefined, -1, 0.5, "0", NaN, Infinity, 1].map(withCount),
    ]) {
      const service = deleting()
      service.tamper("drawing_markups", tamper, { on: "update" })
      await assert.rejects(remove(service), /Released condition measurements could not be confirmed/)
      assert.deepEqual(service.writes("takeoff_conditions"), [])
      assert.deepEqual(service.audits, [])
    }
  })

  test("a failed release keeps the condition", async () => {
    const service = deleting()
    service.tamper("drawing_markups", replies.error("Release unavailable"), { on: "update" })
    await assert.rejects(remove(service), /Release unavailable/)
    assert.deepEqual(service.writes("takeoff_conditions"), [])
    assert.deepEqual(service.audits, [])
  })

  test("a reply that lists fewer released measurements than the release touched is refused", async () => {
    const markups = Array.from({ length: 1500 }, (_, n) => released(n))
    const service = deleting({ tables: { drawing_markups: markups } })
    service.tamper("drawing_markups", (result) => ({ ...result, data: result.data.slice(0, 37) }), { on: "update" })
    await assert.rejects(remove(service), /Released condition measurements could not be confirmed/)
    assert.deepEqual(service.writes("takeoff_conditions"), [])
    assert.deepEqual(service.audits, [])
  })

  test("a condition saved by someone else after it was read is not deleted", async () => {
    for (const kind of ["changed", "removed"]) {
      for (const seen of [undefined, SEEN]) {
        const service = deleting({ tables: { drawing_markups: [released(0)] } })
        service.tamper("drawing_markups", (result) => {
          if (kind === "removed") service.db.takeoff_conditions.splice(0)
          else service.db.takeoff_conditions[0].updated_at = LATER
          return result
        }, { on: "update" })
        await assert.rejects(remove(service, seen), { message: STALE_WRITE })
        assert.deepEqual(service.audits, [])
        if (kind === "changed") assert.equal(service.db.takeoff_conditions[0].updated_at, LATER)
      }
    }
  })

  test.todo("a delete refused at the last step leaves members assigned") // owner: takeoff — release and delete are not one transaction

  test("a removed row that is not the condition that was read is not reported as deleted", async () => {
    for (const change of [{ id: MISSING }, { org_id: FOREIGN_ORG }, { updated_at: LATER }]) {
      const service = deleting()
      service.tamper("takeoff_conditions", replies.patch(change), { on: "delete" })
      await assert.rejects(remove(service), /Deleted takeoff condition could not be confirmed/)
      assert.deepEqual(service.audits, [])
    }
  })

  test("a missing or failed final delete is not audited", async () => {
    for (const reply of [replies.missing(), replies.error()]) {
      const service = deleting()
      service.tamper("takeoff_conditions", reply, { on: "delete" })
      await assert.rejects(remove(service))
      assert.deepEqual(service.audits, [])
    }
  })

  test("a condition with nothing to release or detach reports true zeros", async () => {
    const service = deleting({ detached: 0 })
    assert.deepEqual(await remove(service, SEEN), { released_markups: 0, detached_lines: 0 })
    assert.deepEqual(service.db.takeoff_conditions, [])
    assert.equal(service.audits[0].actorId, ACTOR)
    assert.equal(service.audits[0].before.updated_at, SEEN)
  })

  test("only the org's own members are released, and their geometry stays on the sheet", async () => {
    const service = deleting({
      tables: {
        drawing_markups: [
          released(0, { data: { points: [1, 2] } }),
          released(1, { org_id: FOREIGN_ORG }),
          released(2, { condition_id: MISSING }),
        ],
      },
    })
    assert.deepEqual(await remove(service), { released_markups: 1, detached_lines: 2 })
    const [own, foreign, other] = service.db.drawing_markups
    assert.equal(own.condition_id, null)
    assert.deepEqual(own.data, { points: [1, 2] })
    assert.equal(foreign.condition_id, CONDITION)
    assert.equal(other.condition_id, MISSING)
  })

  test("a large release reports every member it released", async () => {
    const markups = Array.from({ length: 1500 }, (_, n) => released(n))
    const service = deleting({ tables: { drawing_markups: markups } })
    assert.equal((await remove(service)).released_markups, 1500)
  })

  test("a plan condition is deleted only through the org's own plan and the actor's division", async () => {
    const cases = [
      { tables: { house_plan_versions: [] } },
      { tables: { house_plans: [{ id: PLAN, org_id: FOREIGN_ORG, division_id: DIVISION }] } },
      { divisions: [MISSING] },
    ]
    for (const options of cases) {
      const service = deleting({ ...options, tables: { takeoff_conditions: [planCondition()], ...options.tables } })
      await assert.rejects(remove(service), /unavailable/)
      assertNothingWritten(service)
    }
  })

  test("an actor in the plan's division, or on an org-wide plan, can delete it", async () => {
    for (const division of [DIVISION, null]) {
      const service = deleting({
        divisions: [DIVISION],
        tables: { takeoff_conditions: [planCondition()], house_plans: [{ id: PLAN, org_id: ORG, division_id: division }] },
      })
      await remove(service)
      assert.equal(service.audits[0].before.house_plan_version_id, PLAN_VERSION)
    }
  })
})

// ============================================================================
// assignMarkupsToCondition
// ============================================================================

describe("assignMarkupsToCondition", () => {
  const MARKUP = id(50)
  const markup = (overrides = {}) => ({
    id: MARKUP,
    org_id: ORG,
    drawing_sheet_id: SHEET,
    uom: "sf",
    condition_id: null,
    drawing_sheets: { id: SHEET, org_id: ORG, project_id: PROJECT },
    ...overrides,
  })
  const input = { condition_id: CONDITION, markup_ids: [MARKUP] }
  const assign = (service, value = input) => service.run(() => assignMarkupsToCondition(value))

  function assigning({ markups = [markup()], conditions = [condition()], ...options } = {}) {
    return harness({ ...options, tables: { drawing_markups: markups, takeoff_conditions: conditions, ...options.tables } })
  }

  test("an invalid or repeated selection is refused before anything is read", async () => {
    for (const value of [
      { ...input, condition_id: "invalid" },
      { ...input, markup_ids: ["invalid"] },
      { ...input, markup_ids: [] },
      { ...input, markup_ids: [MARKUP, MARKUP] },
      { ...input, markup_ids: Array.from({ length: 501 }, (_, i) => id(1000 + i)) },
    ]) {
      const service = assigning()
      await assert.rejects(assign(service, value))
      assert.deepEqual(service.queries, [])
    }
  })

  test("an actor without takeoff.write reads no measurements", async () => {
    const service = assigning({ permissions: READER })
    await assert.rejects(assign(service), /Missing permission: takeoff.write/)
    assert.deepEqual(service.reads("drawing_markups"), [])
    assertNothingWritten(service)
  })

  test("a selection that cannot be read whole and in-org is refused, assigning or unassigning", async () => {
    const cases = [
      { markups: [] },
      { tamper: replies.error() },
      { tamper: replies.missing() },
      { tamper: replies.rows([]) },
      { tamper: replies.rows([markup(), markup()]) },
      { tamper: replies.rows([markup({ id: MISSING })]) },
      { tamper: replies.rows([markup({ org_id: FOREIGN_ORG })]) },
    ]
    for (const { tamper, ...options } of cases) {
      for (const conditionId of [CONDITION, null]) {
        const service = assigning(options)
        if (tamper) service.tamper("drawing_markups", tamper, { on: "select" })
        await assert.rejects(assign(service, { ...input, condition_id: conditionId }), /Selected condition measurements unavailable/)
        assertNothingWritten(service)
      }
    }
  })

  test("one selected id that does not exist is not silently skipped", async () => {
    const service = assigning()
    await assert.rejects(assign(service, { ...input, markup_ids: [MARKUP, id(51)] }), /Selected condition measurements unavailable/)
    assertNothingWritten(service)
  })

  test("each measurement must sit on exactly one of the org's sheets in a real project", async () => {
    const sheet = { id: SHEET, org_id: ORG, project_id: PROJECT }
    for (const drawing_sheets of [
      null,
      [],
      [sheet, sheet],
      { ...sheet, id: MISSING },
      { ...sheet, org_id: FOREIGN_ORG },
      { ...sheet, project_id: null },
      { ...sheet, project_id: "invalid" },
    ]) {
      const service = assigning({ markups: [markup({ drawing_sheets })] })
      await assert.rejects(assign(service))
      assertNothingWritten(service)
    }
  })

  test("a destination condition the actor cannot reach, or that cannot be verified, is refused", async () => {
    const cases = [
      { conditions: [] },
      { tamper: replies.error() },
      { tamper: replies.missing() },
      { tamper: replies.patch({ id: MISSING }) },
      { tamper: replies.patch({ org_id: FOREIGN_ORG }) },
      { projects: [OTHER_PROJECT] },
      { conditions: [condition({ project_id: null })] },
      { conditions: [condition({ house_plan_version_id: PLAN_VERSION })] },
    ]
    for (const { tamper, ...options } of cases) {
      const service = assigning(options)
      if (tamper) service.tamper("takeoff_conditions", tamper)
      await assert.rejects(assign(service))
      assertNothingWritten(service)
    }
  })

  test("a project condition cannot claim a sheet from another project, even one the actor can edit", async () => {
    const service = assigning({
      markups: [markup({ drawing_sheets: { id: SHEET, org_id: ORG, project_id: OTHER_PROJECT } })],
    })
    await assert.rejects(assign(service), /cannot measure sheets from another project/)
    assertNothingWritten(service)
  })

  test("a wall-height condition only takes linear measurements, and says why", async () => {
    const refused = assigning({ conditions: [condition({ height_ft: 9 })] })
    await assert.rejects(assign(refused), /reports SF, measured as LF/)
    assertNothingWritten(refused)
    const accepted = assigning({ conditions: [condition({ height_ft: 9 })], markups: [markup({ uom: "lf" })] })
    assert.equal(await assign(accepted), 1)
  })

  test("a cubic-yard condition without a depth takes no measurements", async () => {
    const service = assigning({ conditions: [condition({ uom: "cy", depth_in: null })] })
    await assert.rejects(assign(service), /needs a depth/)
    assertNothingWritten(service)
  })

  test("a stored condition with an invalid unit or factor takes no measurements", async () => {
    for (const overrides of [{ uom: null }, { uom: "invalid" }, { height_ft: "invalid" }]) {
      const service = assigning({
        conditions: [condition(overrides)],
        markups: [markup({ uom: overrides.uom === null ? null : "sf" })],
      })
      await assert.rejects(assign(service))
      assertNothingWritten(service)
    }
  })

  test("a plan condition needs its own plan, the actor's division, and a lot built on the plan", async () => {
    const cases = [
      { tables: { house_plan_versions: [] } },
      { tables: { house_plans: [{ id: PLAN, org_id: FOREIGN_ORG, division_id: DIVISION }] } },
      { divisions: [MISSING] },
      { tables: { lots: [] } },
    ]
    for (const options of cases) {
      const service = assigning({ ...options, conditions: [planCondition()] })
      await assert.rejects(assign(service))
      assertNothingWritten(service)
    }
  })

  test("a plan condition also needs write access to the project its sheet belongs to", async () => {
    const service = assigning({ conditions: [planCondition()], projects: [OTHER_PROJECT] })
    await assert.rejects(assign(service), /Missing permission/)
    assertNothingWritten(service)
  })

  test("a plan condition borrows a sheet from a house built on its plan", async () => {
    const service = assigning({ conditions: [planCondition()], divisions: [DIVISION] })
    assert.equal(await assign(service), 1)
    assert.equal(service.db.drawing_markups[0].condition_id, CONDITION)
  })

  test("unassigning still needs write access to every project the measurements sit on", async () => {
    const other = markup({
      id: id(51),
      drawing_sheet_id: OTHER_SHEET,
      drawing_sheets: { id: OTHER_SHEET, org_id: ORG, project_id: OTHER_PROJECT },
    })
    const unassign = { condition_id: null, markup_ids: [MARKUP, other.id] }

    const denied = assigning({ markups: [markup(), other], projects: [PROJECT] })
    await assert.rejects(assign(denied, unassign), /Missing permission/)
    assertNothingWritten(denied)

    const allowed = assigning({ markups: [markup(), other] })
    assert.equal(await assign(allowed, unassign), 2)
  })

  test("a saved member that is not what was requested is not reported", async () => {
    for (const change of [
      { id: MISSING },
      { org_id: FOREIGN_ORG },
      { condition_id: null },
      { drawing_sheet_id: MISSING },
      { uom: "lf" },
    ]) {
      const service = assigning()
      service.tamper("drawing_markups", replies.patch(change), { on: "update" })
      await assert.rejects(assign(service), /Saved condition measurements could not be confirmed/)
      assert.deepEqual(service.audits, [])
    }
  })

  test("a missing, partial or failed save is not reported as a count", async () => {
    for (const reply of [replies.missing(), replies.rows([]), replies.rows([markup(), markup()]), replies.error()]) {
      const service = assigning()
      service.tamper("drawing_markups", reply, { on: "update" })
      await assert.rejects(assign(service))
      assert.deepEqual(service.audits, [])
    }
  })

  test("assigning moves only the selected measurements and keeps their geometry", async () => {
    const service = assigning({
      markups: [markup({ data: { points: [1, 2] }, quantity: 12 }), markup({ id: id(51) })],
    })
    assert.equal(await assign(service), 1)
    const [selected, untouched] = service.db.drawing_markups
    assert.equal(selected.condition_id, CONDITION)
    assert.deepEqual(selected.data, { points: [1, 2] })
    assert.equal(selected.quantity, 12)
    assert.equal(untouched.condition_id, null)
    assert.equal(service.audits[0].actorId, ACTOR)
  })

  test("unassigning repairs a non-measuring membership without reading the old condition", async () => {
    const service = assigning({ markups: [markup({ uom: null, condition_id: CONDITION })], conditions: [] })
    assert.equal(await assign(service, { ...input, condition_id: null }), 1)
    assert.deepEqual(service.reads("takeoff_conditions"), [])
  })

  test("500 measurements are assigned in one write", async () => {
    const markups = Array.from({ length: 500 }, (_, i) => markup({ id: id(1000 + i) }))
    const service = assigning({ markups })
    assert.equal(await assign(service, { condition_id: CONDITION, markup_ids: markups.map((row) => row.id) }), 500)
    assert.equal(service.writes("drawing_markups").length, 1)
  })
})

// ============================================================================
// assertMarkupsInScope
// ============================================================================

describe("assertMarkupsInScope", () => {
  const projectHome = { project_id: PROJECT, house_plan_version_id: null, name: "Wall" }
  const planHome = { project_id: null, house_plan_version_id: PLAN_VERSION, name: "Plan wall" }
  const onSheet = (project = PROJECT) => ({ drawing_sheets: { project_id: project } })
  const check = (service, home, markups) => assertMarkupsInScope(service.client, ORG, home, markups)
  const lot = (n, overrides = {}) => ({ id: id(20 + n), org_id: ORG, house_plan_id: PLAN, project_id: PROJECT, ...overrides })

  test("measurements without exactly one sheet in a real project are refused unread", async () => {
    for (const markups of [
      [],
      [{}],
      [{ drawing_sheets: null }],
      [{ drawing_sheets: [] }],
      [{ drawing_sheets: [{ project_id: PROJECT }, { project_id: PROJECT }] }],
      [{ drawing_sheets: 1 }],
      [{ drawing_sheets: {} }],
      [{ drawing_sheets: { project_id: null } }],
      [{ drawing_sheets: { project_id: 42 } }],
      [{ drawing_sheets: { project_id: "bad" } }],
      [onSheet(), {}],
    ]) {
      const service = harness()
      await assert.rejects(check(service, projectHome, markups))
      assert.deepEqual(service.queries, [])
    }
  })

  test("a condition needs exactly one valid home", async () => {
    for (const home of [
      { ...projectHome, project_id: null },
      { ...projectHome, house_plan_version_id: PLAN_VERSION },
      { ...projectHome, project_id: "invalid" },
    ]) {
      const service = harness()
      await assert.rejects(check(service, home, [onSheet()]))
      assert.deepEqual(service.queries, [])
    }
  })

  test("a project condition accepts its own project's sheets in either embedded shape", async () => {
    const service = harness()
    await check(service, projectHome, [onSheet(), { drawing_sheets: [{ project_id: PROJECT }] }])
    assert.deepEqual(service.queries, [])
  })

  test("one sheet from another project fails the whole set", async () => {
    const service = harness()
    await assert.rejects(check(service, projectHome, [onSheet(), onSheet(OTHER_PROJECT)]), /cannot measure sheets from another project/)
  })

  test("a plan condition's version must be the org's own and name its plan", async () => {
    const cases = [
      { tables: { house_plan_versions: [] } },
      { tables: { house_plan_versions: [{ id: PLAN_VERSION, org_id: FOREIGN_ORG, house_plan_id: PLAN }] } },
      { tamper: replies.error() },
      { tamper: replies.missing() },
      { tamper: replies.rows({ id: MISSING, house_plan_id: PLAN }) },
      { tamper: replies.rows({ id: PLAN_VERSION, house_plan_id: null }) },
    ]
    for (const { tamper, ...options } of cases) {
      const service = harness(options)
      if (tamper) service.tamper("house_plan_versions", tamper)
      await assert.rejects(check(service, planHome, [onSheet()]), /plan version not found/)
      assert.deepEqual(service.reads("lots"), [])
    }
  })

  test("the lots proving a house was built on the plan must be the org's own and match", async () => {
    for (const tamper of [
      replies.error(),
      replies.missing(),
      replies.rows([lot(0, { org_id: FOREIGN_ORG })]),
      replies.rows([lot(0, { house_plan_id: MISSING })]),
      replies.rows([lot(0, { project_id: OTHER_PROJECT })]),
      replies.rows([lot(0, { id: "" })]),
      replies.rows([lot(0), lot(0)]),
    ]) {
      const service = harness()
      service.tamper("lots", tamper)
      await assert.rejects(check(service, planHome, [onSheet()]), /lots unavailable/)
    }
  })

  test("a plan condition cannot borrow a sheet from a project not built on the plan", async () => {
    const service = harness()
    await assert.rejects(check(service, planHome, [onSheet(), onSheet(OTHER_PROJECT)]), /built on its plan/)
  })

  test("a plan condition borrows sheets from every house built on the plan", async () => {
    const service = harness({
      tables: { lots: [lot(0), lot(1, { project_id: OTHER_PROJECT }), lot(2)] },
    })
    await check(service, planHome, [onSheet(), { drawing_sheets: [{ project_id: OTHER_PROJECT }] }])
  })
})

// ============================================================================
// getConditionRollup — rates, members and sync state
// ============================================================================

describe("getConditionRollup", () => {
  const rollup = (service, history = false, filters = { project_id: PROJECT }) =>
    service.run(() => getConditionRollup(filters, undefined, history))

  /** A rollup-ready condition: 10% waste, priced from its cost code. */
  const priced = (overrides = {}) => condition({ waste_pct: 10, unit_cost_cents: null, ...overrides })

  function rolling({ conditions = [priced()], members = [member(0, { quantity: 100 })], ...options } = {}) {
    worksheet = options.worksheet ?? { available: true, pricing: null }
    return harness({
      permissions: READER,
      ...options,
      tables: { takeoff_conditions: conditions, drawing_markups: members, ...options.tables },
    })
  }

  describe("rates", () => {
    test("a condition without a rate or code reads no codes and prices nothing", async () => {
      const service = rolling({ conditions: [priced({ cost_code_id: null })] })
      const [row] = await rollup(service)
      assert.equal(row.effective_unit_cost_cents, null)
      assert.equal(row.extended_cents, null)
      assert.deepEqual(service.reads("cost_codes"), [])
    })

    test("an inactive historical code still prices the condition from its decimal rate", async () => {
      const service = rolling()
      const [row] = await rollup(service)
      assert.equal(row.effective_quantity, 110)
      assert.equal(row.effective_unit_cost_cents, 430)
      assert.equal(row.extended_cents, 47300)
      assert.equal(row.rate_source, "cost_code")
      assert.equal(row.cost_code.name, "Original finish")
      assert.deepEqual(service.writes(), [])
    })

    test("every referenced code is read whatever the page size", async () => {
      const count = 201
      const conditions = Array.from({ length: count }, (_, i) => priced({ id: id(10000 + i), cost_code_id: id(20000 + i) }))
      const codes = conditions.map((row) => costCode({ id: row.cost_code_id }))
      const service = rolling({ conditions, members: [], maxRows: 37, tables: { cost_codes: codes } })
      const rows = await rollup(service)
      assert.ok(rows.every((row) => row.effective_unit_cost_cents === 430))
    })

    test("rate evidence that is unreadable, foreign or incomplete is refused", async () => {
      const cases = [
        { tamper: replies.missing() },
        { tamper: replies.error() },
        { tamper: replies.rows([costCode()]) },
        { tamper: replies.rows([costCode({ org_id: FOREIGN_ORG })]) },
        { tamper: replies.rows([costCode({ id: MISSING })]) },
        { tables: { cost_codes: [] } },
      ]
      for (const { tamper, ...options } of cases) {
        const service = rolling(options)
        if (tamper) service.tamper("cost_codes", tamper)
        await assert.rejects(rollup(service))
      }
    })

    test("a malformed stored rate is refused", async () => {
      for (const patch of [
        { code: null },
        { name: null },
        { unit: undefined },
        { unit: 17 },
        { default_unit_cost_cents: undefined },
        { default_unit_cost_cents: "bad" },
        { default_unit_cost_cents: Infinity },
        { default_unit_cost_cents: NaN },
        { default_unit_cost_cents: -1 },
        { default_unit_cost_cents: 1.5 },
        { default_unit_cost_cents: Number.MAX_SAFE_INTEGER + 1 },
      ]) {
        const service = rolling()
        service.tamper("cost_codes", replies.patch(patch), { times: 1 })
        await assert.rejects(rollup(service), undefined, JSON.stringify(patch))
      }
    })

    test("a pinned rate wins, but the referenced code must still be readable", async () => {
      for (const pinned of [0, 1000]) {
        const [row] = await rollup(rolling({ conditions: [priced({ unit_cost_cents: pinned })] }))
        assert.equal(row.effective_unit_cost_cents, pinned)
        assert.equal(row.rate_source, "pinned")
        await assert.rejects(rollup(rolling({ conditions: [priced({ unit_cost_cents: pinned })], tables: { cost_codes: [] } })))
      }
    })

    test("a code with no default or a zero default prices as unpriced or zero", async () => {
      for (const rate of [null, 0]) {
        const service = rolling({ tables: { cost_codes: [costCode({ unit: null, default_unit_cost_cents: rate })] } })
        const [row] = await rollup(service)
        assert.equal(row.effective_unit_cost_cents, rate)
        assert.equal(row.extended_cents, rate === null ? null : 0)
      }
    })

    test("a code shared by two conditions is read as if it were referenced once", async () => {
      const single = rolling()
      await rollup(single)
      const shared = rolling({
        conditions: [priced(), priced({ id: id(30) })],
        members: [member(0, { quantity: 100 }), member(1, { quantity: 100, condition_id: id(30) })],
      })
      assert.equal((await rollup(shared)).length, 2)
      assert.equal(shared.reads("cost_codes").length, single.reads("cost_codes").length)
    })

    test("a total that cannot be represented safely is refused", async () => {
      for (const options of [
        { members: [member(0, { quantity: Number.MAX_VALUE })] },
        { tables: { cost_codes: [costCode({ default_unit_cost_cents: Number.MAX_SAFE_INTEGER })] } },
        { conditions: [priced({ unit_cost_cents: -1 })] },
      ]) {
        await assert.rejects(rollup(rolling(options)))
      }
    })
  })

  describe("members", () => {
    test("1500 members are all counted, whatever the page size, with decimal quantities", async () => {
      const members = Array.from({ length: 1500 }, (_, n) => member(n))
      const service = rolling({ conditions: [priced({ unit_cost_cents: 100, waste_pct: 0 })], members, maxRows: 37 })
      const [row] = await rollup(service)
      assert.equal(row.markup_count, 1500)
      assert.equal(row.effective_quantity, 15375)
      assert.equal(row.extended_cents, 1537500)
    })

    test("members of 201 conditions are all counted", async () => {
      const conditions = Array.from({ length: 201 }, (_, i) => priced({ id: id(10000 + i) }))
      const members = conditions.map((row, n) => member(n, { condition_id: row.id }))
      const rows = await rollup(rolling({ conditions, members }))
      assert.ok(rows.every((row) => row.markup_count === 1))
    })

    test("a condition with no members rolls up to zero", async () => {
      const [row] = await rollup(rolling({ members: [] }))
      assert.equal(row.markup_count, 0)
      assert.equal(row.effective_quantity, 0)
    })

    test("a member page that is unreadable, stalled or foreign is refused", async () => {
      for (const tamper of [
        replies.missing(),
        replies.error(),
        replies.rows([member(0)]),
        replies.rows([member(0, { org_id: FOREIGN_ORG })]),
        replies.rows([member(0, { condition_id: MISSING })]),
      ]) {
        const service = rolling()
        service.tamper("drawing_markups", tamper)
        await assert.rejects(rollup(service))
      }
    })

    test("a member with a malformed quantity, unit, geometry or ancestry is refused", async () => {
      const base = member(0)
      for (const patch of [
        { quantity: true },
        { quantity: "" },
        { quantity: Infinity },
        { quantity: NaN },
        { quantity: undefined },
        { uom: "lf" },
        { uom: null },
        { drawing_sheets: null },
        { drawing_sheets: [base.drawing_sheets, base.drawing_sheets] },
        { drawing_sheets: { ...base.drawing_sheets, org_id: FOREIGN_ORG } },
        { drawing_sheet_id: MISSING },
        { sheet_version_id: MISSING },
        { drawing_sheet_versions: null },
        { drawing_sheet_versions: { ...base.drawing_sheet_versions, org_id: FOREIGN_ORG } },
        { drawing_sheet_versions: { ...base.drawing_sheet_versions, drawing_revisions: null } },
        {
          drawing_sheet_versions: {
            ...base.drawing_sheet_versions,
            drawing_revisions: { id: REVISION, org_id: ORG, project_id: MISSING },
          },
        },
        { data: { type: "text", points: [[0.1, 0.1]], style: {} } },
        { data: { ...base.data, points: [[Infinity, 0], [1, 1]] } },
        { data: { ...base.data, style: { deduction: "true" } } },
        { data: { ...base.data, style: { reanchor: { state: "invalid" } } } },
      ]) {
        const service = rolling()
        service.tamper("drawing_markups", replies.patch(patch), { times: 1 })
        await assert.rejects(rollup(service), undefined, JSON.stringify(patch))
      }
    })

    test("another creator's private measurement blocks pricing instead of leaving a partial total", async () => {
      const own = rolling({ members: [member(0, { is_private: true })] })
      assert.equal((await rollup(own))[0].markup_count, 1)
      const hidden = rolling({ members: [member(0), member(1, { is_private: true, created_by: MISSING })] })
      await assert.rejects(rollup(hidden), /private measurements/)
    })

    test("members need read access to their sheet's project, and that project must be the condition's", async () => {
      await assert.rejects(rollup(rolling({ projects: [PROJECT], members: [member(0, { project: OTHER_PROJECT })] })), /Missing permission/)
      await assert.rejects(rollup(rolling({ members: [member(0, { project: OTHER_PROJECT })] })), /another project/)
    })

    test("an unversioned legacy member without a scale counts as current but unscaled", async () => {
      const legacy = member(0, { sheet_version_id: null, drawing_sheet_versions: null, quantity: null, uom: null })
      const [row] = await rollup(rolling({ members: [legacy] }))
      assert.equal(row.unscaled_markup_count, 1)
      assert.equal(row.stale_markup_count, 0)
    })

    test("review, stale, unscaled and deduction members are classified from their stored evidence", async () => {
      const review = {
        state: "needs_review",
        from_version_id: id(60),
        to_version_id: null,
        reason: "not_attempted",
        queued_at: SEEN,
      }
      const stale = member(3)
      stale.drawing_sheets.current_revision_id = id(61)
      const pending = member(2)
      pending.data = { ...pending.data, style: { reanchor: { ...review, to_version_id: pending.sheet_version_id } } }
      const members = [
        member(0),
        member(1, { quantity: "-2", data: { type: "area", points: SQUARE, style: { deduction: true } } }),
        pending,
        stale,
        member(4, { quantity: null }),
      ]
      const [row] = await rollup(rolling({ conditions: [priced({ waste_pct: 0 })], members }))
      assert.equal(row.measured_quantity, 8.25)
      assert.equal(row.pending_review_count, 1)
      assert.equal(row.stale_markup_count, 1)
      assert.equal(row.unscaled_markup_count, 1)
      assert.equal(row.deduction_count, 1)
    })

    test("embedded sheet, version and revision rows may arrive as one-element arrays", async () => {
      const row = member(0)
      row.drawing_sheets = [row.drawing_sheets]
      row.drawing_sheet_versions.drawing_revisions = [row.drawing_sheet_versions.drawing_revisions]
      row.drawing_sheet_versions = [row.drawing_sheet_versions]
      const [result] = await rollup(rolling({ members: [row] }))
      assert.equal(result.stale_markup_count, 0)
      assert.equal(result.markup_count, 1)
    })

    test("a plan condition counts members on a house built on its plan, and only there", async () => {
      const filters = { house_plan_version_id: PLAN_VERSION }
      const conditions = [priced({ project_id: null, house_plan_version_id: PLAN_VERSION })]
      assert.equal((await rollup(rolling({ conditions }), false, filters))[0].markup_count, 1)
      await assert.rejects(rollup(rolling({ conditions, tables: { lots: [] } }), false, filters), /built on its plan/)
    })

    test("an orphaned measurement on the current revision blocks pricing; on an old revision it is stale", async () => {
      const orphaned = member(0)
      orphaned.data.style.reanchor = {
        state: "orphaned",
        from_version_id: orphaned.sheet_version_id,
        to_version_id: null,
        reason: "no_successor",
        queued_at: SEEN,
      }
      await assert.rejects(rollup(rolling({ members: [orphaned] })), /Orphaned/)
      orphaned.drawing_sheets.current_revision_id = MISSING
      assert.equal((await rollup(rolling({ members: [orphaned] })))[0].stale_markup_count, 1)
    })
  })

  describe("sync state", () => {
    const SOURCES = [
      { destination: "change_order", table: "change_order_lines", target: "change_order_id" },
      { destination: "estimate", table: "estimate_items", target: "estimate_id" },
      { destination: "bid_scope", table: "bid_scope_items", target: "bid_package_id" },
      { destination: "plan_takeoff", table: "house_plan_takeoff_lines", target: "house_plan_version_id" },
    ]
    const [, ESTIMATES, BIDS] = SOURCES

    /** A destination line last synced from CONDITION at 10.5. */
    function line(n, { source = ESTIMATES, takeoff = {}, ...overrides } = {}) {
      return {
        id: id(3000 + n),
        org_id: ORG,
        [source.target]: ESTIMATE,
        quantity: "10.5",
        metadata: {
          takeoff: { condition_id: CONDITION, measured_quantity: "10.5", synced_at: "2026-10-04T10:00:00.000001Z", ...takeoff },
        },
        ...overrides,
      }
    }

    const syncing = (lines, options = {}) => rolling({ ...options, tables: { estimate_items: [], ...lines, ...options.tables } })
    const latest = async (service) => (await rollup(service))[0].sync

    test("a project with no conditions reads no destination lines", async () => {
      const service = syncing({}, { conditions: [] })
      assert.deepEqual(await rollup(service), [])
      assert.deepEqual(service.reads("estimate_items"), [])
    })

    test("every destination is read to the end, and the latest line wins", async () => {
      for (const source of SOURCES) {
        const lines = Array.from({ length: 1500 }, (_, n) =>
          line(n, { source, takeoff: { synced_at: n === 1499 ? "2026-10-04T11:00:00Z" : "2026-10-04T10:00:00Z" } }),
        )
        const sync = await latest(syncing({ [source.table]: lines }, { maxRows: 37 }))
        assert.equal(sync.line_id, id(3000 + 1499))
        assert.equal(sync.destination, source.destination)
      }
    })

    test("lines for 201 conditions are all found", async () => {
      const conditions = Array.from({ length: 201 }, (_, i) => priced({ id: id(10000 + i) }))
      const lines = conditions.map((row, n) => line(n, { takeoff: { condition_id: row.id } }))
      const rows = await rollup(syncing({ estimate_items: lines }, { conditions, members: [] }))
      assert.ok(rows.every((row) => row.sync !== null))
    })

    test("a destination page that is unreadable, stalled, foreign or about another condition is refused", async () => {
      for (const tamper of [
        replies.missing(),
        replies.error(),
        replies.rows([line(0)]),
        replies.rows([line(0, { org_id: FOREIGN_ORG })]),
        replies.rows([line(0, { org_id: undefined })]),
        replies.rows([line(0, { takeoff: { condition_id: MISSING } })]),
      ]) {
        const service = syncing({ estimate_items: [line(0)] })
        service.tamper("estimate_items", tamper)
        await assert.rejects(rollup(service))
      }
    })

    test("a destination line with a malformed quantity, id or target is refused", async () => {
      for (const patch of [
        { quantity: null },
        { quantity: undefined },
        { quantity: "" },
        { quantity: true },
        { quantity: Infinity },
        { quantity: NaN },
        { estimate_id: "bad" },
        { id: "bad" },
        { metadata: null },
      ]) {
        const service = syncing({ estimate_items: [line(0)] })
        service.tamper("estimate_items", replies.patch(patch), { times: 1 })
        await assert.rejects(rollup(service), undefined, JSON.stringify(patch))
      }
    })

    test("malformed sync provenance is refused", async () => {
      for (const takeoff of [
        { measured_quantity: null },
        { measured_quantity: undefined },
        { measured_quantity: "" },
        { measured_quantity: false },
        { measured_quantity: Infinity },
        { measured_quantity: -1 },
        { synced_at: "bad" },
        { synced_at: 123 },
        { detached: "false" },
        { evidence_only: "false" },
      ]) {
        const service = syncing({ estimate_items: [line(0)] })
        service.tamper("estimate_items", replies.rows([line(0, { takeoff })]), { times: 1 })
        await assert.rejects(rollup(service), undefined, JSON.stringify(takeoff))
      }
    })

    test("an older malformed line is refused even though it would not win", async () => {
      const older = line(1, { quantity: "bad", takeoff: { synced_at: "2020-01-01T00:00:00Z" } })
      await assert.rejects(rollup(syncing({ estimate_items: [line(0), older] })))
    })

    test("the latest line is chosen by actual instant, not by the text of its offset", async () => {
      const sync = await latest(syncing({
        estimate_items: [
          line(0, { takeoff: { synced_at: "2026-10-04T12:00:00.000001+03:00" } }),
          line(1, { takeoff: { synced_at: "2026-10-04T09:00:00.000002Z" } }),
        ],
      }))
      assert.equal(sync.line_id, id(3001))
    })

    test("lines synced at the same instant resolve the same way every time", async () => {
      const sync = await latest(syncing({ estimate_items: [line(0)], bid_scope_items: [line(1, { source: BIDS })] }))
      assert.equal(sync.destination, "bid_scope")
    })

    test("an undated legacy line is kept, and a dated line beats it", async () => {
      const undated = line(0, { takeoff: { synced_at: undefined, measured_quantity: 0 } })
      assert.equal((await latest(syncing({ estimate_items: [undated] }))).synced_at, null)
      assert.equal((await latest(syncing({ estimate_items: [undated, line(1)] }))).line_id, id(3001))
    })

    test("a zero sync, a hand edit and a detached line are reported as such", async () => {
      const edited = line(0, { quantity: -1, takeoff: { measured_quantity: 0, detached: true } })
      const sync = await latest(syncing({ estimate_items: [edited] }))
      assert.equal(sync.synced_quantity, 0)
      assert.equal(sync.hand_edited, true)
      assert.equal(sync.detached, true)
    })

    describe("the deal's pricing worksheet", () => {
      const dealProject = { id: PROJECT, org_id: ORG, division_id: DIVISION, prospect_id: PROSPECT }

      test("a project whose deal cannot be read is refused rather than shown as never synced", async () => {
        const cases = [
          { tables: { projects: [{ id: PROJECT, org_id: ORG, division_id: DIVISION }] } },
          { tamper: replies.error() },
          { tamper: replies.rows({ id: PROJECT, org_id: FOREIGN_ORG, prospect_id: PROSPECT }) },
          { worksheet: { available: false, pricing: null } },
        ]
        for (const { tamper, ...options } of cases) {
          const service = syncing({ projects: [dealProject] }, options)
          // Only the deal lookup, not the authorization read of the same table.
          if (tamper) service.tamper("projects", (result, query) => (query.cardinality ? tamper(result) : result))
          await assert.rejects(rollup(service), undefined, JSON.stringify(options))
        }
      })

      test("a worksheet row is a hand edit unless it only records the measurement as evidence", async () => {
        for (const evidenceOnly of [false, true]) {
          const row = line(0, { quantity: 99, takeoff: { evidence_only: evidenceOnly } })
          const service = syncing({ projects: [dealProject] }, { worksheet: { available: true, pricing: { rows: [row] } } })
          const sync = await latest(service)
          assert.equal(sync.destination, "pricing_worksheet")
          assert.equal(sync.target_id, PROSPECT)
          assert.equal(sync.hand_edited, !evidenceOnly)
        }
      })

      test("the same worksheet row twice is refused", async () => {
        const row = line(0)
        const service = syncing({ projects: [dealProject] }, { worksheet: { available: true, pricing: { rows: [row, row] } } })
        await assert.rejects(rollup(service))
      })
    })

    test("the full history keeps every line while the badge shows the latest", async () => {
      const lines = Array.from({ length: 1500 }, (_, n) => line(n, { estimate_id: id(20000 + n) }))
      const [row] = await rollup(syncing({ estimate_items: lines }), true)
      assert.equal(row.sync_history.length, 1500)
      assert.equal(new Set(row.sync_history.map((entry) => entry.target_id)).size, 1500)
    })

    test("each retained line reports its own drift, so an older estimate survives a newer bid", async () => {
      const newer = line(1, { source: BIDS, quantity: 15, takeoff: { measured_quantity: 15, synced_at: "2026-10-04T13:00:00Z" } })
      const service = syncing(
        { estimate_items: [line(0)], bid_scope_items: [newer] },
        { conditions: [priced({ waste_pct: 0 })], members: [member(0, { quantity: 15 })] },
      )
      const [row] = await rollup(service, true)
      assert.equal(row.sync.destination, "bid_scope")
      assert.equal(row.sync.quantity_changed, false)
      assert.equal(row.sync_history.length, 2)
      assert.equal(row.sync_history.find((entry) => entry.destination === "estimate").quantity_changed, true)
      assert.equal(row.extended_cents, 6450)
    })

    test("a condition never synced has no badge and an empty history", async () => {
      const [row] = await rollup(syncing({}), true)
      assert.equal(row.sync, null)
      assert.deepEqual(row.sync_history, [])
    })

    test("the ordinary rollup leaves the history out but agrees on the badge and the price", async () => {
      const lines = { estimate_items: [line(0)] }
      const [normal] = await rollup(syncing(lines))
      const [full] = await rollup(syncing(lines), true)
      assert.equal(Object.hasOwn(normal, "sync_history"), false)
      assert.deepEqual(normal.sync, full.sync)
      assert.equal(normal.extended_cents, full.extended_cents)
      assert.equal(full.sync_history.length, 1)
    })
  })
})

// ============================================================================
// getConditionLandingSheet
// ============================================================================

describe("getConditionLandingSheet", () => {
  const land = (service, conditionId = CONDITION) => service.run(() => getConditionLandingSheet(conditionId))
  const landing = ({ members = [member(0)], conditions = [condition({ waste_pct: "0" })], ...options } = {}) =>
    harness({
      permissions: READER,
      ...options,
      tables: { takeoff_conditions: conditions, drawing_markups: members, ...options.tables },
    })
  /** `row`, carried by a revision and waiting for review. */
  const pending = (row) => {
    const reanchor = {
      state: "needs_review",
      from_version_id: MISSING,
      to_version_id: row.sheet_version_id,
      reason: "not_attempted",
      queued_at: SEEN,
    }
    row.data.style = { reanchor }
    return row
  }

  test("an invalid id is refused before anything is read", async () => {
    const service = landing()
    await assert.rejects(land(service, "bad"))
    assert.deepEqual(service.queries, [])
  })

  test("the sheet carrying the most of the condition wins, counted across every member", async () => {
    const members = Array.from({ length: 1500 }, (_, n) =>
      member(n, n < 1000 ? { quantity: 1 } : { quantity: 5, drawing_sheet_id: OTHER_SHEET }),
    )
    const service = landing({ members, maxRows: 37 })
    assert.deepEqual(await land(service), { drawing_sheet_id: OTHER_SHEET })
    assert.deepEqual(service.writes(), [])
  })

  test("no current measurements is a successful null", async () => {
    const stale = member(0)
    stale.drawing_sheets.current_revision_id = MISSING
    for (const members of [[], [stale]]) assert.equal(await land(landing({ members })), null)
  })

  test("deductions reduce a sheet's total rather than adding to it", async () => {
    const members = [
      member(0, { quantity: 100 }),
      member(1, { quantity: -90, data: { type: "area", points: SQUARE, style: { deduction: true, parent_area_id: id(1000) } } }),
      member(2, { quantity: 50, drawing_sheet_id: OTHER_SHEET }),
    ]
    assert.deepEqual(await land(landing({ members })), { drawing_sheet_id: OTHER_SHEET })
  })

  test("equal sheets resolve to the lower sheet id", async () => {
    const members = [member(0, { drawing_sheet_id: OTHER_SHEET }), member(1)]
    assert.deepEqual(await land(landing({ members })), { drawing_sheet_id: SHEET })
  })

  test("confirmed current evidence beats larger pending-review and stale evidence", async () => {
    const stale = member(2, { quantity: 20000, drawing_sheet_id: id(21) })
    stale.drawing_sheets.current_revision_id = MISSING
    const members = [member(0), pending(member(1, { quantity: 10000, drawing_sheet_id: OTHER_SHEET })), stale]
    assert.deepEqual(await land(landing({ members })), { drawing_sheet_id: SHEET })
  })

  test("measurements awaiting review, unscaled or unversioned still give a sheet to land on", async () => {
    for (const row of [
      pending(member(0)),
      member(0, { quantity: null, uom: null }),
      member(0, { sheet_version_id: null, drawing_sheet_versions: null }),
      member(0, { is_private: true }),
    ]) {
      assert.deepEqual(await land(landing({ members: [row] })), { drawing_sheet_id: SHEET })
    }
  })

  test("member evidence that is unreadable, stalled, foreign or for another condition is refused", async () => {
    for (const tamper of [
      replies.missing(),
      replies.error(),
      replies.rows([member(0)]),
      replies.rows([member(0, { org_id: FOREIGN_ORG })]),
      replies.rows([member(0, { condition_id: MISSING })]),
    ]) {
      const service = landing()
      service.tamper("drawing_markups", tamper)
      await assert.rejects(land(service))
    }
  })

  test("an invalid member, or another creator's private one, is refused", async () => {
    for (const patch of [
      { quantity: true },
      { quantity: "" },
      { quantity: undefined },
      { uom: "lf" },
      { drawing_sheets: null },
      { drawing_sheet_versions: null },
      { is_private: true, created_by: MISSING },
      { is_private: true, created_by: null },
    ]) {
      const service = landing()
      service.tamper("drawing_markups", replies.patch(patch), { times: 1 })
      await assert.rejects(land(service), undefined, JSON.stringify(patch))
    }
  })

  test("a condition that is out of reach, gone, or changed while landing is refused", async () => {
    let checks = 0
    const revokeOnThirdCheck = (result) => (++checks >= 3 ? { ...result, data: [] } : result)
    const changeOnSecondRead = (patch) => {
      let reads = 0
      return (result) => (++reads > 1 ? replies.patch(patch)(result) : result)
    }
    const cases = [
      { projects: [OTHER_PROJECT] },
      { tamper: ["memberships", revokeOnThirdCheck] },
      { tamper: ["takeoff_conditions", changeOnSecondRead({ project_id: OTHER_PROJECT })] },
      { tamper: ["takeoff_conditions", changeOnSecondRead({ updated_at: LATER })] },
      { tamper: ["takeoff_conditions", changeOnSecondRead({ height_ft: 300 })] },
      { conditions: [] },
    ]
    for (const { tamper, ...options } of cases) {
      const service = landing(options)
      if (tamper) service.tamper(...tamper)
      await assert.rejects(land(service))
    }
  })

  test("a total too large to compare is refused instead of picking a sheet at random", async () => {
    const members = [member(0, { quantity: Number.MAX_VALUE }), member(1, { quantity: Number.MAX_VALUE })]
    await assert.rejects(land(landing({ members })), /precision/)
  })

  test("a plan condition lands on a house built on its plan, within the actor's reach", async () => {
    const conditions = [planCondition({ waste_pct: "0" })]
    assert.deepEqual(await land(landing({ conditions })), { drawing_sheet_id: SHEET })
    await assert.rejects(land(landing({ conditions, permissions: ["project.read"] })))
    await assert.rejects(land(landing({ conditions, divisions: [MISSING] })))
  })
})
