const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness, replies, id, ORG, ACTOR } = require("./support/service")
const { freshRequire } = require("./support/modules")

const { CONDITION_COLORS } = require("@/lib/drawings/takeoff-palette")
const { TEMPLATE_LIST_CAP } = require("@/lib/validation/takeoff")
const { STALE_WRITE } = require("@/lib/services/takeoff")
const {
  applyConditionTemplates,
  createConditionTemplate,
  deleteConditionTemplate,
  listConditionTemplates,
  saveConditionsAsTemplates,
  updateConditionTemplate,
} = freshRequire("lib/services/takeoff-templates.ts")

const FOREIGN_ORG = id(1)
const PROJECT = id(2)
const PLAN = id(3)
const PLAN_VERSION = id(4)
const DIVISION = id(5)
const CODE = id(6)
const TEMPLATE = id(7)
const CREATOR = id(8)
const A = id(9)
const B = id(10)
const MISSING = id(99)

const SEEN = "2026-10-04T12:00:00.123456+00:00"
const LATER = "2026-10-04T13:00:00.654321+00:00"

const WRITER = ["takeoff.read", "takeoff.write", "project.read"]

function template(overrides = {}) {
  return {
    id: TEMPLATE,
    org_id: ORG,
    name: "LVP",
    uom: "sf",
    depth_in: null,
    height_ft: null,
    pitch_rise: null,
    tons_per_cy: null,
    cost_code_id: CODE,
    color: null,
    waste_pct: 8,
    unit_cost_cents: 12345,
    share_with_clients: true,
    notes: "Original template",
    group_name: "Finishes",
    sort_order: 4,
    created_by: CREATOR,
    created_at: SEEN,
    updated_at: SEEN,
    ...overrides,
  }
}

/** A measured condition on PROJECT, as the harvest reads it. */
function condition(conditionId, name, overrides = {}) {
  return {
    id: conditionId,
    org_id: ORG,
    project_id: PROJECT,
    house_plan_version_id: null,
    name,
    uom: "sf",
    depth_in: null,
    height_ft: "8.5",
    pitch_rise: null,
    tons_per_cy: null,
    cost_code_id: CODE,
    color: CONDITION_COLORS[0],
    waste_pct: "8",
    unit_cost_cents: 12345,
    share_with_clients: true,
    notes: "Original measured source",
    ...overrides,
  }
}

function harness({ permissions = WRITER, ...options } = {}) {
  return createServiceHarness({
    permissions,
    ...options,
    tables: {
      projects: [{ id: PROJECT, org_id: ORG, division_id: DIVISION }],
      house_plan_versions: [{ id: PLAN_VERSION, org_id: ORG, house_plan_id: PLAN }],
      house_plans: [{ id: PLAN, org_id: ORG, division_id: DIVISION }],
      cost_codes: [{ id: CODE, org_id: ORG, is_active: false }],
      takeoff_condition_templates: [],
      takeoff_conditions: [],
      ...options.tables,
    },
  })
}

function assertNothingWritten(service) {
  assert.deepEqual(service.writes(), [])
  assert.deepEqual(service.audits, [])
  assert.deepEqual(service.events, [])
}

const withCount = (count) => (result) => ({ ...result, count })

// ============================================================================
// listConditionTemplates
// ============================================================================

describe("listConditionTemplates", () => {
  const libraryRow = (n) =>
    template({
      id: id(1000 + n),
      name: `Template ${String(10000 - n).padStart(5, "0")}`,
      group_name: [null, "A", "B"][n % 3],
      sort_order: n % 4,
    })
  const library = (count) => ({
    takeoff_condition_templates: [
      ...Array.from({ length: count }, (_, n) => libraryRow(n)),
      template({ id: id(500), org_id: FOREIGN_ORG }),
    ],
  })

  test("the whole library is listed, including legacy rows past the creation cap", async () => {
    for (const count of [0, 500, 501, 713]) {
      const service = harness({ permissions: ["takeoff.read"], maxRows: 37, tables: library(count) })
      const rows = await service.run(() => listConditionTemplates())
      assert.equal(new Set(rows.map((row) => row.id)).size, count)
      assert.ok(rows.every((row) => row.org_id === ORG && row.unit_cost_cents === 12345))
      assert.deepEqual(service.writes(), [])
    }
  })

  test("templates are ordered by group with ungrouped last, then position, then name", async () => {
    const service = harness({ tables: library(60) })
    const rows = await service.run(() => listConditionTemplates())
    const groups = rows.map((row) => row.group_name)
    assert.deepEqual([...new Set(groups)], ["A", "B", null])
    for (let i = 1; i < rows.length; i += 1) {
      const [before, after] = [rows[i - 1], rows[i]]
      if (before.group_name !== after.group_name) continue
      assert.ok(
        before.sort_order < after.sort_order ||
          (before.sort_order === after.sort_order && before.name.localeCompare(after.name) <= 0),
      )
    }
  })

  test("a failed, empty-bodied, stalled or foreign page is an error, never a partial library", async () => {
    const laterPageFails = () => {
      let pages = 0
      return (result) => (++pages > 1 ? replies.error()(result) : result)
    }
    for (const tamper of [
      laterPageFails(),
      replies.missing(),
      replies.rows([libraryRow(0)]),
      replies.patch({ org_id: FOREIGN_ORG }),
    ]) {
      const service = harness({ maxRows: 37, tables: library(100) })
      service.tamper("takeoff_condition_templates", tamper)
      await assert.rejects(service.run(() => listConditionTemplates()), /Failed to load complete/)
    }
  })

  test("an actor without takeoff.read reads nothing", async () => {
    const service = harness({ permissions: [], tables: library(3) })
    await assert.rejects(service.run(() => listConditionTemplates()), /Missing permission: takeoff.read/)
    assert.deepEqual(service.reads("takeoff_condition_templates"), [])
  })

  test("a library at the read limit is listed; one past it is refused, not truncated", async () => {
    assert.equal((await harness({ tables: library(10000) }).run(() => listConditionTemplates())).length, 10000)
    await assert.rejects(harness({ tables: library(10001) }).run(() => listConditionTemplates()), /Validation limit exceeded/)
  })
})

// ============================================================================
// createConditionTemplate
// ============================================================================

describe("createConditionTemplate", () => {
  const input = { name: "Tile", uom: "sf", cost_code_id: CODE, unit_cost_cents: 23456 }
  const create = (service, value = input) => service.run(() => createConditionTemplate(value))

  test("an actor without takeoff.write reads and writes nothing", async () => {
    const service = harness({ permissions: ["takeoff.read"] })
    await assert.rejects(create(service), /Missing permission: takeoff.write/)
    assert.deepEqual(service.reads("takeoff_condition_templates"), [])
    assertNothingWritten(service)
  })

  test("a library size that cannot be verified stops the insert", async () => {
    const failedWithZero = (result) => ({ ...result, count: 0, error: { message: "Read unavailable" } })
    const counts = [null, undefined, -1, 0.5, "0", Number.MAX_SAFE_INTEGER + 1]
    for (const tamper of [...counts.map(withCount), failedWithZero]) {
      const service = harness()
      service.tamper("takeoff_condition_templates", tamper, { on: "select" })
      await assert.rejects(create(service), /Unable to verify the template library size/)
      assertNothingWritten(service)
    }
  })

  test("a full library takes no more templates", async () => {
    const service = harness()
    service.tamper("takeoff_condition_templates", withCount(TEMPLATE_LIST_CAP), { on: "select" })
    await assert.rejects(create(service), /at most 500 templates/)
    assertNothingWritten(service)
  })

  test("a cost code that is missing, foreign or unreadable is refused", async () => {
    const cases = [
      { tables: { cost_codes: [] } },
      { tables: { cost_codes: [{ id: CODE, org_id: FOREIGN_ORG }] } },
      { tamper: replies.error() },
      { tamper: replies.missing() },
    ]
    for (const { tamper, ...options } of cases) {
      const service = harness(options)
      if (tamper) service.tamper("cost_codes", tamper)
      await assert.rejects(create(service), /cost codes unavailable/)
      assertNothingWritten(service)
    }
  })

  test("a saved row that differs from the request is not reported as created", async () => {
    for (const change of [
      { org_id: FOREIGN_ORG },
      { name: "Changed by driver" },
      { unit_cost_cents: 1 },
      { cost_code_id: MISSING },
      { created_by: MISSING },
      { share_with_clients: false },
    ]) {
      const service = harness()
      service.tamper("takeoff_condition_templates", replies.patch(change), { on: "insert" })
      await assert.rejects(create(service, { ...input, share_with_clients: true }), /could not be confirmed/)
      assert.deepEqual(service.audits, [])
    }
  })

  test("a template is created in the actor's org at the end of the library, even on an inactive code", async () => {
    const service = harness({ tables: { takeoff_condition_templates: [template({ org_id: FOREIGN_ORG })] } })
    const saved = await create(service)
    assert.equal(saved.unit_cost_cents, 23456)
    assert.equal(saved.cost_code_id, CODE)
    assert.equal(saved.sort_order, 0)
    assert.equal(saved.org_id, ORG)
    assert.equal(saved.created_by, ACTOR)
    assert.equal(service.audits[0].actorId, ACTOR)
    assert.equal(service.audits[0].orgId, ORG)

    const next = harness({ tables: { takeoff_condition_templates: [template()] } })
    assert.equal((await create(next)).sort_order, 1)
  })
})

// ============================================================================
// updateConditionTemplate and deleteConditionTemplate
// ============================================================================

describe("updating and deleting a template", () => {
  const update = (service, changes = { notes: "Changed" }, seen) =>
    service.run(() => updateConditionTemplate(TEMPLATE, changes, undefined, seen))
  const remove = (service, seen) => service.run(() => deleteConditionTemplate(TEMPLATE, undefined, seen))
  const mutations = [
    ["update", (service, seen) => update(service, { notes: "Changed" }, seen)],
    ["delete", remove],
  ]
  const library = (overrides) => harness({ ...overrides, tables: { takeoff_condition_templates: [template()], ...overrides?.tables } })

  test("an invalid id or revision is refused before anything is read", async () => {
    for (const [templateId, seen] of [["invalid", undefined], [TEMPLATE, "not-a-date"], [TEMPLATE, 42]]) {
      for (const run of [
        (service) => service.run(() => updateConditionTemplate(templateId, {}, undefined, seen)),
        (service) => service.run(() => deleteConditionTemplate(templateId, undefined, seen)),
      ]) {
        const service = library()
        await assert.rejects(run(service))
        assert.deepEqual(service.queries, [])
      }
    }
  })

  for (const [name, mutate] of mutations) {
    test(`${name}: an actor without takeoff.write reads nothing`, async () => {
      const service = library({ permissions: ["takeoff.read"] })
      await assert.rejects(mutate(service), /Missing permission: takeoff.write/)
      assert.deepEqual(service.reads("takeoff_condition_templates"), [])
      assertNothingWritten(service)
    })

    test(`${name}: a failed read or a foreign row is never mutated`, async () => {
      const failed = library()
      failed.tamper("takeoff_condition_templates", replies.error(), { on: "select" })
      await assert.rejects(mutate(failed), /Failed to load/)
      assertNothingWritten(failed)

      const foreign = library()
      foreign.tamper("takeoff_condition_templates", replies.patch({ org_id: FOREIGN_ORG }), { on: "select" })
      await assert.rejects(mutate(foreign), /not found/)
      assertNothingWritten(foreign)
    })

    test(`${name}: a stale rendered revision is refused before anything changes`, async () => {
      const service = library()
      await assert.rejects(mutate(service, LATER), { message: STALE_WRITE })
      assertNothingWritten(service)
    })

    test(`${name}: a change saved by someone else after the read is refused, not overwritten`, async () => {
      for (const kind of ["changed", "removed"]) {
        const service = library()
        service.tamper("takeoff_condition_templates", (result) => {
          if (kind === "removed") service.db.takeoff_condition_templates.splice(0)
          else service.db.takeoff_condition_templates[0].updated_at = LATER
          return result
        }, { on: "select" })
        await assert.rejects(mutate(service), { message: STALE_WRITE })
        assert.deepEqual(service.audits, [])
        if (kind === "changed") assert.equal(service.db.takeoff_condition_templates[0].notes, "Original template")
      }
    })
  }

  test("update: a cost code that is missing, foreign or unreadable is refused", async () => {
    const cases = [
      { tables: { cost_codes: [] } },
      { tables: { cost_codes: [{ id: CODE, org_id: FOREIGN_ORG }] } },
      { tamper: replies.error() },
      { tamper: replies.missing() },
    ]
    for (const { tamper, ...options } of cases) {
      const service = library(options)
      if (tamper) service.tamper("cost_codes", tamper)
      await assert.rejects(update(service), /cost codes unavailable/)
      assertNothingWritten(service)
    }
  })

  test("update: a saved row that differs from the request is not reported", async () => {
    for (const change of [
      { org_id: FOREIGN_ORG },
      { name: "Changed by driver" },
      { unit_cost_cents: 1 },
      { cost_code_id: MISSING },
      { created_by: MISSING },
      { share_with_clients: false },
    ]) {
      const service = library()
      service.tamper("takeoff_condition_templates", replies.patch(change), { on: "update" })
      await assert.rejects(update(service), /could not be confirmed/)
      assert.deepEqual(service.audits, [])
    }
  })

  test("update: a price and group change keeps the creator and records what it replaced", async () => {
    const service = library()
    const saved = await update(service, { unit_cost_cents: 23456, group_name: " Tile " }, SEEN)
    assert.equal(saved.unit_cost_cents, 23456)
    assert.equal(saved.group_name, "Tile")
    assert.equal(saved.created_by, CREATOR)
    assert.notEqual(saved.updated_at, SEEN)
    assert.equal(service.audits[0].actorId, ACTOR)
    assert.equal(service.audits[0].before.unit_cost_cents, 12345)
  })

  test("update: a broken cost code reference can be cleared", async () => {
    const service = library({ tables: { cost_codes: [] } })
    assert.equal((await update(service, { cost_code_id: null })).cost_code_id, null)
  })

  test("delete: a removed row that is not the template that was read is not reported", async () => {
    for (const change of [{ id: MISSING }, { org_id: FOREIGN_ORG }, { updated_at: LATER }]) {
      const service = library()
      service.tamper("takeoff_condition_templates", replies.patch(change), { on: "delete" })
      await assert.rejects(remove(service), /could not be confirmed/)
      assert.deepEqual(service.audits, [])
    }
  })

  test("delete: the exact revision that was reviewed is removed and audited", async () => {
    const service = library()
    await remove(service, SEEN)
    assert.deepEqual(service.db.takeoff_condition_templates, [])
    assert.equal(service.audits.length, 1)
    assert.equal(service.audits[0].actorId, ACTOR)
    assert.equal(service.audits[0].before.updated_at, SEEN)
  })
})

// ============================================================================
// applyConditionTemplates
// ============================================================================

describe("applyConditionTemplates", () => {
  const input = { project_id: PROJECT, template_ids: [A, B] }
  const planInput = { house_plan_version_id: PLAN_VERSION, template_ids: [A] }
  const libraryRows = () => [
    template({ id: A, name: "LVP", color: "#000000" }),
    template({ id: B, name: "Tile", color: "#000000" }),
  ]
  const sibling = (n, overrides = {}) => ({
    id: id(100 + n),
    org_id: ORG,
    project_id: PROJECT,
    house_plan_version_id: null,
    name: `Existing ${n}`,
    color: "#FF0000",
    ...overrides,
  })
  const applying = ({ siblings = [], ...options } = {}) =>
    harness({
      ...options,
      tables: { takeoff_condition_templates: libraryRows(), takeoff_conditions: siblings, ...options.tables },
    })
  const apply = (service, value = input) => service.run(() => applyConditionTemplates(value))

  test("a repeated template is refused before anything is read", async () => {
    const service = applying()
    await assert.rejects(apply(service, { ...input, template_ids: [A, A] }), /only once/)
    assert.deepEqual(service.queries, [])
  })

  test("an actor without takeoff.write, or without the project, reads no templates", async () => {
    for (const options of [{ permissions: ["takeoff.read", "project.read"] }, { projects: [] }]) {
      const service = applying(options)
      await assert.rejects(apply(service), /Missing permission/)
      assert.deepEqual(service.reads("takeoff_condition_templates"), [])
      assertNothingWritten(service)
    }
  })

  test("a project outside the org cannot be reached through a template of this org", async () => {
    const service = applying()
    await assert.rejects(apply(service, { ...input, project_id: MISSING }), /Missing permission/)
    assertNothingWritten(service)
  })

  test("the selected templates must all be read, once each, from this org", async () => {
    const cases = [
      { tables: { takeoff_condition_templates: [template({ id: A })] } },
      { tables: { takeoff_condition_templates: [template({ id: A, org_id: FOREIGN_ORG }), template({ id: B })] } },
      { tamper: replies.missing() },
      { tamper: replies.error() },
      { tamper: replies.rows([template({ id: A }), template({ id: A })]) },
      { tamper: replies.rows([template({ id: A }), template({ id: MISSING })]) },
    ]
    for (const { tamper, ...options } of cases) {
      const service = applying(options)
      if (tamper) service.tamper("takeoff_condition_templates", tamper)
      await assert.rejects(apply(service), /templates/)
      assertNothingWritten(service)
    }
  })

  test("a template's cost code must still be available in this org", async () => {
    const cases = [
      { tables: { cost_codes: [] } },
      { tables: { cost_codes: [{ id: CODE, org_id: FOREIGN_ORG }] } },
      { tamper: replies.missing() },
      { tamper: replies.error() },
    ]
    for (const { tamper, ...options } of cases) {
      const service = applying(options)
      if (tamper) service.tamper("cost_codes", tamper)
      await assert.rejects(apply(service), /cost codes unavailable/)
      assertNothingWritten(service)
    }
  })

  test("existing conditions that cannot be verified are never treated as an empty takeoff", async () => {
    const cases = [
      ...[null, undefined, -1, 0.5, "0", 1].map((count) => ({ tamper: withCount(count) })),
      { tamper: replies.missing() },
      { tamper: replies.error() },
      { tamper: replies.rows([sibling(1, { org_id: FOREIGN_ORG })]) },
      { tamper: replies.rows([sibling(1, { project_id: MISSING })]) },
      { siblings: [sibling(1, { name: null })] },
      { siblings: [sibling(1, { color: null })] },
    ]
    for (const { tamper, ...options } of cases) {
      const service = applying(options)
      if (tamper) service.tamper("takeoff_conditions", tamper, { on: "select" })
      await assert.rejects(apply(service), /existing takeoff conditions/)
      assertNothingWritten(service)
    }
  })

  test("a plan destination needs the org's own version, its parent plan, and the actor's division", async () => {
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
      const service = applying(options)
      if (tamper) service.tamper(...tamper)
      await assert.rejects(apply(service, planInput), /unavailable/)
      assertNothingWritten(service)
    }
  })

  test("an insert reply that does not match what was requested emits no success", async () => {
    for (const reply of [
      replies.missing(),
      replies.rows([]),
      replies.rows([{ id: id(90), name: "LVP" }]),
      replies.rows([{ id: id(90), name: "LVP" }, { id: id(90), name: "Tile" }]),
      replies.rows([{ id: id(90), name: "LVP" }, { id: id(91), name: "Unknown" }]),
    ]) {
      const service = applying()
      service.tamper("takeoff_conditions", reply, { on: "insert" })
      await assert.rejects(apply(service), /could not be confirmed/)
      assert.deepEqual(service.audits, [])
      assert.deepEqual(service.events, [])
    }
  })

  test("applied conditions follow the caller's order, keep the library rate, and get their own colors", async () => {
    const service = applying({ siblings: [sibling(1)] })
    const result = await apply(service, { ...input, template_ids: [B, A] })
    assert.deepEqual(result, { created: 2, skipped: [], over_cap: [] })
    const added = service.db.takeoff_conditions.slice(1)
    assert.deepEqual(added.map((row) => row.name), ["Tile", "LVP"])
    assert.deepEqual(added.map((row) => row.sort_order), [1, 2])
    assert.equal(new Set(added.map((row) => row.color)).size, 2)
    assert.ok(added.every((row) => row.color !== "#000000" && row.color !== "#FF0000"))
    for (const row of added) {
      assert.equal(row.project_id, PROJECT)
      assert.equal(row.house_plan_version_id, null)
      assert.equal(row.org_id, ORG)
      assert.equal(row.created_by, ACTOR)
      assert.equal(row.unit_cost_cents, 12345)
      assert.equal(row.cost_code_id, CODE)
    }
    assert.equal(service.audits[0].actorId, ACTOR)
    assert.equal(service.events[0].entityId, PROJECT)
    assert.equal(service.events[0].payload.created, 2)
  })

  test("templates are applied to the exact plan version for an actor in its division", async () => {
    const service = applying({ divisions: [DIVISION] })
    assert.equal((await apply(service, planInput)).created, 1)
    assert.equal(service.db.takeoff_conditions[0].house_plan_version_id, PLAN_VERSION)
    assert.equal(service.db.takeoff_conditions[0].project_id, null)
  })

  test("an org-wide plan stays open to a division-restricted actor", async () => {
    const service = applying({ divisions: [], tables: { house_plans: [{ id: PLAN, org_id: ORG, division_id: null }] } })
    assert.equal((await apply(service, planInput)).created, 1)
  })

  test("names already in the takeoff are skipped and a full takeoff reports what did not fit", async () => {
    const siblings = Array.from({ length: 200 }, (_, n) => sibling(n, n === 0 ? { name: " lVp " } : {}))
    const service = applying({ siblings })
    assert.deepEqual(await apply(service), { created: 0, skipped: ["LVP"], over_cap: ["Tile"] })
    assert.deepEqual(service.writes("takeoff_conditions"), [])
    assert.deepEqual(service.events, [])
  })
})

// ============================================================================
// saveConditionsAsTemplates
// ============================================================================

describe("saveConditionsAsTemplates", () => {
  const input = { condition_ids: [A, B], group_name: " Finishes " }
  const harvesting = ({ conditions = [condition(A, "LVP"), condition(B, "Tile")], library = [], ...options } = {}) =>
    harness({ ...options, tables: { takeoff_conditions: conditions, takeoff_condition_templates: library, ...options.tables } })
  const harvest = (service, value = input) => service.run(() => saveConditionsAsTemplates(value))
  const fromPlan = (conditionId, name) => condition(conditionId, name, { project_id: null, house_plan_version_id: PLAN_VERSION })

  test("a repeated condition is refused before anything is read", async () => {
    const service = harvesting()
    await assert.rejects(harvest(service, { ...input, condition_ids: [A, A] }), /only once/)
    assert.deepEqual(service.queries, [])
  })

  test("an actor without takeoff.write reads no conditions", async () => {
    const service = harvesting({ permissions: ["takeoff.read", "project.read"] })
    await assert.rejects(harvest(service), /Missing permission: takeoff.write/)
    assert.deepEqual(service.reads("takeoff_conditions"), [])
    assertNothingWritten(service)
  })

  test("the selected conditions must all be read from this org, each with exactly one home", async () => {
    const cases = [
      { conditions: [condition(A, "LVP")] },
      { conditions: [condition(A, "LVP"), condition(B, "Tile", { org_id: FOREIGN_ORG })] },
      { tamper: replies.missing() },
      { tamper: replies.error() },
      { tamper: replies.rows([condition(A, "LVP"), condition(A, "LVP")]) },
      { tamper: replies.rows([condition(A, "LVP"), condition(MISSING, "Unexpected")]) },
      { conditions: [condition(A, "LVP", { project_id: null }), condition(B, "Tile")] },
      { conditions: [condition(A, "LVP", { house_plan_version_id: PLAN_VERSION }), condition(B, "Tile")] },
    ]
    for (const { tamper, ...options } of cases) {
      const service = harvesting(options)
      if (tamper) service.tamper("takeoff_conditions", tamper)
      await assert.rejects(harvest(service), /conditions|Selected/)
      assertNothingWritten(service)
    }
  })

  test("a condition on a project the actor cannot write is not harvested", async () => {
    const service = harvesting({ projects: [] })
    await assert.rejects(harvest(service), /Missing permission/)
    assertNothingWritten(service)
  })

  test("a plan condition needs the org's own plan and the actor's division", async () => {
    const cases = [
      { tables: { house_plan_versions: [] } },
      { tables: { house_plan_versions: [{ id: PLAN_VERSION, org_id: FOREIGN_ORG, house_plan_id: PLAN }] } },
      { tables: { house_plans: [] } },
      { tables: { house_plans: [{ id: PLAN, org_id: FOREIGN_ORG, division_id: DIVISION }] } },
      { tamper: replies.error() },
      { divisions: [MISSING] },
    ]
    for (const { tamper, ...options } of cases) {
      const service = harvesting({ ...options, conditions: [fromPlan(A, "LVP"), condition(B, "Tile")] })
      if (tamper) service.tamper("house_plan_versions", tamper)
      await assert.rejects(harvest(service), /unavailable/)
      assertNothingWritten(service)
    }
  })

  test("a copied cost code must still be in this org", async () => {
    const cases = [
      { tables: { cost_codes: [] } },
      { tables: { cost_codes: [{ id: CODE, org_id: FOREIGN_ORG }] } },
      { tamper: replies.missing() },
      { tamper: replies.error() },
    ]
    for (const { tamper, ...options } of cases) {
      const service = harvesting(options)
      if (tamper) service.tamper("cost_codes", tamper)
      await assert.rejects(harvest(service), /cost codes unavailable/)
      assertNothingWritten(service)
    }
  })

  test("a source condition with an invalid body is refused, not normalized into the library", async () => {
    for (const overrides of [
      { unit_cost_cents: 1.5 },
      { unit_cost_cents: -1 },
      { uom: "invalid" },
      { height_ft: "not-a-number" },
      { height_ft: true },
      { share_with_clients: "true" },
    ]) {
      const service = harvesting({ conditions: [condition(A, "LVP", overrides), condition(B, "Tile")] })
      await assert.rejects(harvest(service))
      assertNothingWritten(service)
    }
  })

  test("a library size or name list that cannot be verified stops the harvest", async () => {
    const cases = [
      ...[null, undefined, -1, 0.5, "0", Number.MAX_SAFE_INTEGER + 1].map((count) => ({
        tamper: withCount(count),
        message: /library size/,
      })),
      { tamper: (result) => ({ ...result, count: 0, error: { message: "Read unavailable" } }), message: /library size/ },
      ...[null, [], [{ name: null }], [{ name: " " }]].map((data) => ({
        tamper: (result) => ({ ...result, count: 1, data }),
        message: /library names/,
      })),
      { tamper: (result) => ({ ...result, count: 0, data: [{ name: "Other" }] }), message: /library names/ },
    ]
    for (const { tamper, message } of cases) {
      const service = harvesting()
      service.tamper("takeoff_condition_templates", tamper, { on: "select" })
      await assert.rejects(harvest(service), message)
      assertNothingWritten(service)
    }
  })

  test("an insert reply that does not match what was requested is not reported", async () => {
    const replyCases = [
      replies.missing(),
      replies.rows([]),
      replies.rows([{ id: id(90), name: "LVP" }]),
      replies.rows([{ id: id(90), name: "LVP" }, { id: id(90), name: "Tile" }]),
    ]
    const divergent = [
      { org_id: FOREIGN_ORG },
      { created_by: MISSING },
      { name: "Unknown" },
      { unit_cost_cents: 12346 },
      { cost_code_id: MISSING },
      { height_ft: 9 },
      { color: "#FF0000" },
      { share_with_clients: false },
      { sort_order: 99 },
      { notes: "Changed after source review" },
    ].map(replies.patch)
    for (const reply of [...replyCases, ...divergent]) {
      const service = harvesting()
      service.tamper("takeoff_condition_templates", reply, { on: "insert" })
      await assert.rejects(harvest(service), /could not be confirmed/)
      assert.deepEqual(service.audits, [])
    }
  })

  test("harvested templates follow the caller's order and keep numbers, cents and flags, without a color", async () => {
    const service = harvesting()
    assert.deepEqual(await harvest(service, { ...input, condition_ids: [B, A] }), { created: 2, skipped: [] })
    const added = service.db.takeoff_condition_templates
    assert.deepEqual(added.map((row) => row.name), ["Tile", "LVP"])
    assert.deepEqual(added.map((row) => row.sort_order), [0, 1])
    for (const row of added) {
      assert.equal(row.unit_cost_cents, 12345)
      assert.equal(row.height_ft, 8.5)
      assert.equal(row.waste_pct, 8)
      assert.equal(row.cost_code_id, CODE)
      assert.equal(row.share_with_clients, true)
      assert.equal(row.color, null)
      assert.equal(row.group_name, "Finishes")
      assert.equal(row.created_by, ACTOR)
      assert.equal(row.org_id, ORG)
    }
    assert.equal(service.audits.length, 1)
    assert.equal(service.audits[0].actorId, ACTOR)
  })

  test("project and plan conditions can be harvested together", async () => {
    const service = harvesting({ conditions: [fromPlan(A, "LVP"), condition(B, "Tile")], divisions: [DIVISION] })
    assert.deepEqual(await harvest(service), { created: 2, skipped: [] })
  })

  test("names already in the library are skipped, whatever their case or spacing", async () => {
    const service = harvesting({ library: [template({ name: " lVp " })] })
    assert.deepEqual(await harvest(service, { condition_ids: [A] }), { created: 0, skipped: ["LVP"] })
    assert.deepEqual(service.writes("takeoff_condition_templates"), [])
  })

  test("a full library, or a legacy one past the cap, takes nothing and reports the skip", async () => {
    for (const count of [TEMPLATE_LIST_CAP, TEMPLATE_LIST_CAP + 1]) {
      const library = Array.from({ length: count }, (_, n) => template({ id: id(1000 + n), name: `Template ${n}` }))
      const service = harvesting({ library })
      assert.deepEqual(await harvest(service, { condition_ids: [A] }), { created: 0, skipped: ["LVP"] })
      assert.deepEqual(service.writes("takeoff_condition_templates"), [])
    }
  })

  test("the largest selection, across 200 projects, is harvested whole", async () => {
    const projects = Array.from({ length: 200 }, (_, n) => ({ id: id(2000 + n), org_id: ORG, division_id: DIVISION }))
    const conditions = projects.map((project, n) => condition(id(3000 + n), `Condition ${n}`, { project_id: project.id }))
    const service = harvesting({ conditions, tables: { projects } })
    assert.equal((await harvest(service, { condition_ids: conditions.map((row) => row.id) })).created, 200)
  })
})
