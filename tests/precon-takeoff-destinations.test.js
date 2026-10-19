const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")
const test = require("node:test")

const { createFakeSupabase } = require("./support/fake-supabase")
const { stubModule, freshRequire } = require("./support/modules")

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const ORG = id(1)
const ACTOR = id(2)
const PROJECT = id(3)
const PROSPECT = id(4)
const CONDITION = id(5)
const ESTIMATE = id(6)
const SHEET = id(7)

// RBAC has its own suite; a configured superadmin inside an open support grant
// keeps it out of the way here (staff hold no org rights without a grant).
process.env.SUPERADMIN_IDS = ACTOR

const PERMISSIONS = ["takeoff.read", "takeoff.write", "estimate.write", "project.read", "org.read", "org.member"]

let db
let worksheet

// The deal's pricing worksheet is stored by the precon services; this is that
// store, with its optimistic version check.
stubModule("@/lib/services/precon-workspace", {
  getPreconWorkspace: async () => ({
    available: true,
    pricing: structuredClone(worksheet.pricing),
    version: worksheet.version,
  }),
})
stubModule("@/lib/services/precon-pricing", {
  savePricingWorksheet: async (prospectId, value, expectedVersion) => {
    assert.equal(prospectId, PROSPECT)
    if (expectedVersion !== worksheet.version) throw new Error("Pricing changed in another session")
    worksheet.pricing = structuredClone(value)
    worksheet.version += 1
  },
})
stubModule("@/lib/services/audit", { recordAudit: async () => {} })
stubModule("@/lib/services/events", { recordEvent: async () => {} })

const { runWithServiceOrgContext } = require("@/lib/services/context")
const { runWithServiceSupabaseClient } = require("@/lib/supabase/service-client-context")
const { EMPTY_PRICING_WORKSHEET, pricingRowSchema } = require("@/lib/precon/pricing-worksheet")
const { listSyncTargets } = freshRequire("lib/services/takeoff-destinations.ts")
const { previewConditionSync, syncConditions } = freshRequire("lib/services/takeoff.ts")

function estimate(overrides = {}) {
  return {
    id: ESTIMATE,
    org_id: ORG,
    project_id: null,
    prospect_id: PROSPECT,
    title: "Kitchen estimate",
    status: "draft",
    is_current_version: true,
    metadata: {},
    ...overrides,
  }
}

function seed({ phase = "precon", estimates = [estimate()] } = {}) {
  const tables = {
    permissions: PERMISSIONS.map((key) => ({ key })),
    platform_access_grants: [
      { id: id(9), org_id: ORG, operator_user_id: ACTOR, ended_at: null, expires_at: "2999-01-01T00:00:00Z" },
    ],
    projects: [
      { id: PROJECT, org_id: ORG, division_id: null, phase, prospect_id: PROSPECT, project_module_overrides: [] },
    ],
    estimates,
    estimate_items: [],
    takeoff_conditions: [
      {
        id: CONDITION,
        org_id: ORG,
        project_id: PROJECT,
        house_plan_version_id: null,
        name: "Flooring",
        uom: "sf",
        depth_in: null,
        height_ft: null,
        pitch_rise: null,
        tons_per_cy: null,
        waste_pct: 10,
        unit_cost_cents: 200,
        color: "#336699",
        cost_code_id: null,
        notes: null,
        sort_order: 0,
        share_with_clients: false,
        created_by: null,
        created_at: "2026-10-01T00:00:00Z",
        updated_at: "2026-10-01T00:00:00Z",
      },
    ],
    // One 100 sf area on a current sheet of this project.
    drawing_markups: [
      {
        id: id(8),
        org_id: ORG,
        condition_id: CONDITION,
        quantity: 100,
        uom: "sf",
        data: { type: "area", points: [[0, 0], [10, 0], [10, 10]] },
        sheet_version_id: null,
        drawing_sheet_id: SHEET,
        is_private: false,
        created_by: null,
        drawing_sheets: { id: SHEET, org_id: ORG, project_id: PROJECT, sheet_number: "A1", sheet_title: null, current_revision_id: null },
      },
    ],
  }
  db = createFakeSupabase(tables, {}, { uuidIds: true })
  worksheet = { pricing: { ...EMPTY_PRICING_WORKSHEET, rows: [], requests: [] }, version: 0 }
}

/** Run a service as the actor, inside this org, against the fake database. */
function asActor(work) {
  const context = { supabase: db, orgId: ORG, userId: ACTOR, productTier: "residential" }
  return runWithServiceSupabaseClient(db, () => runWithServiceOrgContext(context, work))
}

function failReads(table, message) {
  const from = db.from.bind(db)
  db.from = (name) => {
    const query = from(name)
    if (name === table) query.run = () => ({ data: null, error: { message } })
    return query
  }
}

const toEstimate = { destination: "estimate", target_id: ESTIMATE, condition_ids: [CONDITION] }
const toWorksheet = { destination: "pricing_worksheet", target_id: PROSPECT, condition_ids: [CONDITION] }

test.beforeEach(() => seed())

test("a precon project offers the deal's worksheet and its estimates, never another deal's", async () => {
  db.store.estimates.push(estimate({ id: randomUUID(), prospect_id: randomUUID() }))
  const targets = await asActor(() => listSyncTargets(PROJECT))
  assert.deepEqual(
    targets.map((target) => [target.destination, target.id, target.writable]),
    [
      ["pricing_worksheet", PROSPECT, true],
      ["estimate", ESTIMATE, true],
    ],
  )
})

test("agreements are not destinations and sent, signed or superseded estimates are read-only", async () => {
  seed({
    estimates: [
      estimate({ metadata: { precon: { purpose: "preconstruction_agreement" } } }),
      ...["sent", "approved", "client_signed", "executed", "converted_to_project"].map((status) =>
        estimate({ id: randomUUID(), status }),
      ),
      estimate({ id: randomUUID(), is_current_version: false }),
    ],
  })
  const targets = await asActor(() => listSyncTargets(PROJECT))
  const estimates = targets.filter((target) => target.destination === "estimate")
  assert.equal(estimates.length, 6)
  assert.ok(estimates.every((target) => !target.writable))
})

test("a delivery project offers only its own estimates", async () => {
  const projectEstimate = randomUUID()
  seed({ phase: "delivery", estimates: [estimate({ id: projectEstimate, project_id: PROJECT }), estimate()] })
  const targets = await asActor(() => listSyncTargets(PROJECT))
  assert.deepEqual(targets.map((target) => target.id), [projectEstimate])
})

test("a failed estimate read is an error, not an empty list", async () => {
  failReads("estimates", "connection failed")
  await assert.rejects(asActor(() => listSyncTargets(PROJECT)), /Unable to load estimates/)
})

for (const operation of [previewConditionSync, syncConditions]) {
  test(`${operation.name} refuses a destination outside this workspace`, async () => {
    await assert.rejects(asActor(() => operation({ ...toEstimate, target_id: randomUUID() })), /does not belong/)
    assert.deepEqual(db.store.estimate_items, [])
  })

  test(`${operation.name} refuses a sent estimate`, async () => {
    db.store.estimates[0].status = "sent"
    await assert.rejects(asActor(() => operation(toEstimate)), /new draft version/)
    assert.deepEqual(db.store.estimate_items, [])
  })

  test(`${operation.name} refuses when any requested condition is missing`, async () => {
    const input = { ...toEstimate, condition_ids: [CONDITION, randomUUID()] }
    await assert.rejects(asActor(() => operation(input)), /conditions are unavailable/)
  })
}

test("syncing to an estimate writes the wasted quantity, its price and provenance once", async () => {
  db.store.estimates[0].metadata = { markup_percent: 20 }

  const [preview] = await asActor(() => previewConditionSync(toEstimate))
  assert.equal(preview.action, "create")
  assert.equal(preview.next_quantity, 110)
  assert.deepEqual(db.store.estimate_items, [])

  assert.equal((await asActor(() => syncConditions(toEstimate))).created, 1)
  const [line] = db.store.estimate_items
  assert.equal(line.estimate_id, ESTIMATE)
  assert.equal(line.quantity, 110)
  assert.equal(line.unit_cost_cents, 200)
  assert.equal(line.markup_pct, 20)
  assert.equal(line.metadata.takeoff.condition_id, CONDITION)
  assert.equal(db.store.estimates[0].total_cents, 26400)

  assert.equal((await asActor(() => syncConditions(toEstimate))).unchanged, 1)
  assert.equal(db.store.estimate_items.length, 1)
})

test("re-syncing a worksheet row updates its quantity but keeps an edited rate", async () => {
  assert.equal((await asActor(() => syncConditions(toWorksheet))).created, 1)
  assert.equal(worksheet.pricing.rows[0].unit_cost_cents, 200)
  assert.equal((await asActor(() => syncConditions(toWorksheet))).unchanged, 1)

  worksheet.pricing.rows[0].unit_cost_cents = 500
  db.store.takeoff_conditions[0].waste_pct = 20
  assert.equal((await asActor(() => syncConditions(toWorksheet))).updated, 1)
  assert.equal(worksheet.pricing.rows.length, 1)
  assert.equal(worksheet.pricing.rows[0].quantity, 120)
  assert.equal(worksheet.pricing.rows[0].unit_cost_cents, 500)
})

test("a worksheet row priced by a selected quote keeps its quantity; the new measurement is evidence", async () => {
  await asActor(() => syncConditions(toWorksheet))
  worksheet.pricing.requests = [{ row_ids: [worksheet.pricing.rows[0].id], quote: { normalized_total_cents: 60000 } }]
  db.store.takeoff_conditions[0].waste_pct = 30

  assert.equal((await asActor(() => syncConditions(toWorksheet))).updated, 1)
  const [row] = worksheet.pricing.rows
  assert.equal(row.quantity, 110)
  assert.equal(row.metadata.takeoff.evidence_only, true)
  assert.equal(row.metadata.takeoff.measured_quantity, 130)
})

test("mapping a condition onto an existing worksheet row updates that row only after review", async () => {
  const rowId = randomUUID()
  worksheet.pricing.rows = [
    pricingRowSchema.parse({ id: rowId, description: "Existing flooring", quantity: 77, unit: "sf", unit_cost_cents: 550 }),
  ]
  const mapped = { ...toWorksheet, line_mappings: { [CONDITION]: rowId } }

  const [preview] = await asActor(() => previewConditionSync(mapped))
  assert.equal(preview.action, "update")
  assert.equal(preview.current_quantity, 77)

  await assert.rejects(asActor(() => syncConditions({ ...mapped, reviewed_quantities: { [CONDITION]: 1 } })), /changed after review/)
  await assert.rejects(asActor(() => syncConditions({ ...mapped, reviewed_line_quantities: { [CONDITION]: 12 } })), /changed after review/)
  await assert.rejects(asActor(() => syncConditions({ ...mapped, line_mappings: { [CONDITION]: randomUUID() } })), /no longer available/)

  assert.equal((await asActor(() => syncConditions({ ...mapped, reviewed_quantities: { [CONDITION]: 110 } }))).updated, 1)
  const [row] = worksheet.pricing.rows
  assert.equal(row.id, rowId)
  assert.equal(row.quantity, 110)
  assert.equal(row.unit_cost_cents, 550)
  assert.equal(row.metadata.takeoff_source.condition_id, CONDITION)

  row.metadata.takeoff_source.condition_id = randomUUID()
  await assert.rejects(asActor(() => syncConditions(mapped)), /another measurement source/)
})

test("a lump-sum worksheet row loses its rate when measured, and a unit mismatch is refused", async () => {
  const rowId = randomUUID()
  worksheet.pricing.rows = [
    pricingRowSchema.parse({ id: rowId, description: "Allowance", quantity: 1, unit: "ls", unit_cost_cents: 50000 }),
  ]
  const mapped = { ...toWorksheet, line_mappings: { [CONDITION]: rowId } }

  assert.equal((await asActor(() => previewConditionSync(mapped)))[0].reprice_required, true)
  await asActor(() => syncConditions(mapped))
  assert.equal(worksheet.pricing.rows[0].quantity, 110)
  assert.equal(worksheet.pricing.rows[0].unit_cost_cents, null)

  worksheet.pricing.rows[0].unit = "lf"
  await assert.rejects(asActor(() => syncConditions(mapped)), /unit does not match/)
})
