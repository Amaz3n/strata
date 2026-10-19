require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const { createServiceHarness, replies, id, ORG, ACTOR } = require("./support/service")
const { platformActor, dataQueries } = require("./support/platform")
const { freshRequire, stubModule } = require("./support/modules")

stubModule("next/cache", { ...require("next/cache"), revalidatePath: () => {} })

const { importNavigationSchema } = require("@/lib/validation/import-navigation")
const imports = freshRequire("lib/services/imports.ts")
const actions = freshRequire("app/(app)/settings/imports/actions.ts")

const FOREIGN_ORG = id(1)
const BATCH = id(2)
const FOREIGN_BATCH = id(3)
const ROW = id(4)
const COST_BATCH = id(5)

// --- fixtures -----------------------------------------------------------------

/** 60 plan-library batches, all created in the same instant, plus one foreign one. */
const HISTORY = [
  ...Array.from({ length: 60 }, (_, index) => ({
    id: id(1000 + index),
    org_id: ORG,
    importer: "plan_library",
    status: "staged",
    created_at: "2026-10-04T12:00:00Z",
  })),
  { id: FOREIGN_BATCH, org_id: FOREIGN_ORG, importer: "plan_library", status: "staged", created_at: "2026-10-04T12:00:00Z" },
]
const LARGE = HISTORY[0].id

/** 10,000 staged rows on LARGE; every 1,999th is an error (5 errors). */
const LARGE_ROWS = [
  ...Array.from({ length: 10000 }, (_, index) => ({
    id: id(100000 + index),
    org_id: ORG,
    batch_id: LARGE,
    row_number: index + 1,
    status: (index + 1) % 1999 === 0 ? "error" : "valid",
    parsed: {},
    issues: [],
  })),
  // Another org's row filed under the same batch id must never be counted.
  { id: id(200000), org_id: FOREIGN_ORG, batch_id: LARGE, row_number: 10001, status: "error", parsed: {} },
]

/** A small plan-library batch with one row, for permission cases. */
const SMALL = {
  import_batches: [
    { id: BATCH, org_id: ORG, importer: "plan_library", status: "staged", error_count: 0, created_at: "2026-10-04T12:00:00Z" },
    { id: FOREIGN_BATCH, org_id: FOREIGN_ORG, importer: "plan_library", status: "staged", created_at: "2026-10-04T12:00:00Z" },
  ],
  import_rows: [{ id: ROW, org_id: ORG, batch_id: BATCH, row_number: 1, status: "valid", parsed: { plan_code: "PL1" }, issues: [] }],
}

function tenant(permissions, tables = SMALL, options = {}) {
  return createServiceHarness({ permissions, tables, ...options })
}

function large(options = {}) {
  return createServiceHarness({
    permissions: ["import.manage", "plan.write"],
    tables: { import_batches: HISTORY, import_rows: LARGE_ROWS },
    ...options,
  })
}

const DESTINATIONS = [
  ["plan_library", "plan.write"],
  ["option_catalog", "selections.catalog.manage"],
  ["price_book", "price_book.write"],
  ["communities_lots", "community.write"],
  ["communities_lots", "lot.write"],
  ["team", "members.manage"],
]

// --- tenant access: import.manage AND the destination's own permission --------

test("an importer's history needs import.manage plus that destination's permission, and shows only this org", async () => {
  // The org's product tier is never consulted: a mixed org imports every kind.
  for (const [importer, permission] of DESTINATIONS) {
    const service = tenant(["import.manage", permission])
    const result = await service.run(() => imports.listImportBatches({ importer }))
    const expected = importer === "plan_library" ? [BATCH] : []
    assert.deepEqual(result.batches.map((batch) => batch.id), expected, `${importer} via ${permission}`)
  }
})

test("a purchasing member without price_book.write cannot reach the price book importer", async () => {
  const service = tenant(["import.manage", "commitment.write"])
  await assert.rejects(service.run(() => imports.listImportBatches({ importer: "price_book" })), /price_book\.write/)
  assert.deepEqual(service.reads("import_batches"), [])
})

test("import.manage alone opens no destination's data", async () => {
  for (const [importer] of DESTINATIONS) {
    const service = tenant(["import.manage"])
    await assert.rejects(service.run(() => imports.listImportBatches({ importer })), /Missing permission/, importer)
    assert.deepEqual(service.reads("import_batches"), [], importer)
  }
  const preview = tenant(["import.manage"])
  await assert.rejects(preview.run(() => imports.getImportMappingProfile("plan_library", ["plan_code"])), /plan\.write/)
  assert.deepEqual(preview.reads("import_mapping_profiles"), [])
})

test("a destination permission does not replace import.manage", async () => {
  const service = tenant(["plan.write"])
  await assert.rejects(service.run(() => imports.listImportBatches({ importer: "plan_library" })), /import\.manage/)
  await assert.rejects(
    service.run(() => imports.stageImportBatch({ importer: "plan_library", csvText: "plan_code,plan_name\nPL1,Home" })),
    /import\.manage/,
  )
  assert.deepEqual(dataQueries(service), [])
})

test("the warranty homes import runs on warranty.manage alone, and every other importer still needs import.manage", async () => {
  const warranty = tenant(["warranty.manage"])
  const history = await warranty.run(() => imports.listImportBatches({ importer: "warranty_homes" }, { expectedImporter: "warranty_homes" }))
  assert.deepEqual(history.batches, [])
  const manager = tenant(["warranty.manage", "price_book.write"])
  await assert.rejects(manager.run(() => imports.listImportBatches({ importer: "price_book" }, { expectedImporter: "price_book" })), /import\.manage/)
  await assert.rejects(manager.run(() => imports.stageImportBatch({ importer: "price_book", csvText: "sku,price\nA,1" }, { expectedImporter: "price_book" })), /import\.manage/)
  assert.deepEqual(dataQueries(manager), [])
  const noWarranty = tenant(["import.manage"])
  await assert.rejects(noWarranty.run(() => imports.listImportBatches({ importer: "warranty_homes" }, { expectedImporter: "warranty_homes" })), /warranty\.manage/)
})

test("a tenant wildcard cannot reach the platform-only Open WIP importer", async () => {
  const service = tenant(["*"])
  await assert.rejects(service.run(() => imports.listImportBatches({ importer: "open_wip" })), /restricted to the platform/)
  assert.deepEqual(dataQueries(service), [])
})

test("a batch opened under another importer is refused before its rows are read or changed", async () => {
  const wrongImporter = { expectedImporter: "option_catalog" }
  for (const [name, call] of [
    ["getImportBatch", () => imports.getImportBatch(BATCH, {}, wrongImporter)],
    ["patchImportRow", () => imports.patchImportRow({ batchId: BATCH, rowId: ROW, patch: {} }, wrongImporter)],
    ["setImportUpdateExisting", () => imports.setImportUpdateExisting(BATCH, true, wrongImporter)],
    ["discardImportBatch", () => imports.discardImportBatch(BATCH, wrongImporter)],
    ["commitImportBatch", () => imports.commitImportBatch(BATCH, wrongImporter)],
  ]) {
    const service = tenant(["import.manage", "plan.write", "selections.catalog.manage"])
    await assert.rejects(service.run(call), /does not belong to this importer/, name)
    assert.deepEqual(service.reads("import_rows"), [], name)
    assert.deepEqual(service.writes(), [], name)
  }

  const matching = tenant(["import.manage", "plan.write"])
  const detail = await matching.run(() => imports.getImportBatch(BATCH, {}, { expectedImporter: "plan_library" }))
  assert.equal(detail.batch.id, BATCH)
})

test("the settings actions bind each change to the importer the page was opened for", async () => {
  const input = { importer: "option_catalog", batchId: BATCH }
  for (const [name, value] of [
    ["patchOrgImportRowAction", { ...input, rowId: ROW, patch: {} }],
    ["setOrgImportUpdateExistingAction", { ...input, updateExisting: true }],
    ["commitOrgImportAction", input],
    ["discardOrgImportAction", input],
  ]) {
    const service = tenant(["import.manage", "plan.write", "selections.catalog.manage"])
    const result = await service.run(() => actions[name](value))
    assert.equal(result.success, false, name)
    assert.match(result.error, /does not belong to this importer/, name)
    assert.deepEqual(service.writes(), [], name)
  }

  const service = tenant(["import.manage", "plan.write"])
  const result = await service.run(() => actions.setOrgImportUpdateExistingAction({ importer: "plan_library", batchId: BATCH, updateExisting: true }))
  assert.equal(result.success, true)
  assert.equal(service.db.import_batches[0].update_existing, true)
})

// --- platform onboarding: support.read inspects, support.write changes ---------

const CUSTOMER = {
  orgs: [
    { id: ORG, name: "Builder", product_tier: "production" },
    { id: FOREIGN_ORG, name: "Other builder", product_tier: "production" },
  ],
  import_batches: [{ id: COST_BATCH, org_id: ORG, importer: "cost_codes", status: "staged", row_count: 1, error_count: 0 }],
  import_rows: [{ id: ROW, org_id: ORG, batch_id: COST_BATCH, row_number: 1, parsed: { code: "1000", name: "Example" }, status: "valid", issues: [] }],
}

test("a read-only platform operator inspects a customer's batches but cannot change them", async () => {
  const onCustomer = { platformOrgId: ORG }
  const reader = platformActor({ platform: ["platform.support.read"], tables: CUSTOMER })
  assert.deepEqual((await reader.run(() => imports.listImportBatches({}, onCustomer))).batches.map((batch) => batch.id), [COST_BATCH])
  const detail = await reader.run(() => imports.getImportBatch(COST_BATCH, {}, onCustomer))
  assert.deepEqual(detail.rows.map((row) => row.id), [ROW])
  assert.equal(await reader.run(() => imports.getImportMappingProfile("cost_codes", ["code", "name"], onCustomer)), null)

  const otherCustomer = { platformOrgId: FOREIGN_ORG }
  assert.deepEqual((await reader.run(() => imports.listImportBatches({}, otherCustomer))).batches, [])
  await assert.rejects(reader.run(() => imports.getImportBatch(COST_BATCH, {}, otherCustomer)), /Import batch not found/)

  for (const [name, call] of [
    ["stageImportBatch", () => imports.stageImportBatch({ importer: "cost_codes", csvText: "code,name\n1000,Example" }, onCustomer)],
    ["patchImportRow", () => imports.patchImportRow({ batchId: COST_BATCH, rowId: ROW, patch: { name: "Changed" } }, onCustomer)],
    ["setImportUpdateExisting", () => imports.setImportUpdateExisting(COST_BATCH, true, onCustomer)],
    ["discardImportBatch", () => imports.discardImportBatch(COST_BATCH, onCustomer)],
    ["commitImportBatch", () => imports.commitImportBatch(COST_BATCH, onCustomer)],
  ]) {
    const service = platformActor({ platform: ["platform.support.read"], tables: CUSTOMER })
    await assert.rejects(service.run(call), /platform\.support\.write/, name)
    assert.deepEqual(dataQueries(service), [], name)
  }
})

test("a permitted operator stages into the named customer org, as themselves, without publishing", async () => {
  const operator = platformActor({ platform: ["platform.support.read", "platform.support.write"], tables: CUSTOMER })
  const batch = await operator.run(() =>
    imports.stageImportBatch({ importer: "cost_codes", csvText: "code,name\n2000,New scope" }, { platformOrgId: ORG }),
  )
  assert.equal(batch.status, "staged")
  assert.equal(batch.error_count, 0)
  const stored = operator.db.import_batches.find((row) => row.id === batch.id)
  assert.equal(stored.org_id, ORG)
  assert.equal(stored.created_by, ACTOR)
  assert.equal(operator.db.cost_codes?.length ?? 0, 0, "staging never publishes domain records")
  assert.ok(operator.events.some((event) => event.orgId === ORG && event.actorId === ACTOR))
})

// --- paging: every row reachable, nothing silently missing ---------------------

test("row pages reach all 10,000 rows of a batch exactly once, and none from another org", async () => {
  const service = large()
  const seen = new Set()
  for (let page = 1; page <= 20; page++) {
    const result = await service.run(() => imports.getImportBatch(LARGE, { page, limit: 500 }, { expectedImporter: "plan_library" }))
    assert.equal(result.total, 10000)
    assert.equal(result.rows.length, 500)
    for (const row of result.rows) {
      assert.ok(!seen.has(row.id), row.id)
      seen.add(row.id)
    }
  }
  assert.equal(seen.size, 10000)
})

test("a status filter pages through every matching row with the filtered total", async () => {
  const service = large()
  const numbers = []
  for (let page = 1; page <= 3; page++) {
    const result = await service.run(() => imports.getImportBatch(LARGE, { page, limit: 2, status: "error" }))
    assert.equal(result.total, 5)
    numbers.push(...result.rows.map((row) => row.row_number))
  }
  assert.deepEqual(numbers, [1999, 3998, 5997, 7996, 9995])
})

test("history pages keep a stable order when batches share a timestamp", async () => {
  const service = large()
  const ids = []
  for (let page = 1; page <= 3; page++) {
    const result = await service.run(() => imports.listImportBatches({ importer: "plan_library", page, limit: 25 }))
    assert.equal(result.total, 60)
    ids.push(...result.batches.map((batch) => batch.id))
  }
  assert.deepEqual(ids, HISTORY.slice(0, 60).map((batch) => batch.id).reverse())
})

test("a missing count or a short page is an error, never an empty or partial queue", async () => {
  for (const table of ["import_batches", "import_rows"]) {
    const service = large()
    service.tamper(table, (result, query) => (query.countMode ? { ...result, count: null } : result))
    const read = table === "import_batches" ? () => imports.listImportBatches() : () => imports.getImportBatch(LARGE)
    await assert.rejects(service.run(read), /unavailable/, table)
  }
  const capped = large({ maxRows: 100 })
  await assert.rejects(capped.run(() => imports.getImportBatch(LARGE, { limit: 500 })), /page is incomplete/)
})

test("an invalid page number is refused", async () => {
  for (const page of [NaN, 0, -1, 1.5, Infinity, 100001]) {
    await assert.rejects(large().run(() => imports.listImportBatches({ page })), String(page))
  }
})

test("page and status links are normalized independently", () => {
  assert.deepEqual(importNavigationSchema.parse({ batchPage: "-1", rowPage: "Infinity", rowStatus: "foreign" }), {
    batchPage: 1,
    rowPage: 1,
    rowStatus: "all",
  })
  assert.deepEqual(importNavigationSchema.parse({ batchPage: "3", rowPage: "20", rowStatus: "error" }), {
    batchPage: 3,
    rowPage: 20,
    rowStatus: "error",
  })
})

// --- recounting after a row edit ----------------------------------------------

/** Skip the first row of LARGE, which recounts the whole batch. */
function skipFirstRow(service) {
  return service.run(() => imports.patchImportRow({ batchId: LARGE, rowId: LARGE_ROWS[0].id, patch: {}, skip: true }))
}
const largeBatch = (service) => service.db.import_batches.find((batch) => batch.id === LARGE)

test("a recount covers all 10,000 rows through the normal 1,000-row transport cap", async () => {
  const service = large({ maxRows: 1000 })
  await skipFirstRow(service)
  const batch = largeBatch(service)
  assert.deepEqual(
    [batch.row_count, batch.error_count, batch.skipped_count, batch.valid_count],
    [10000, 5, 1, 9994],
  )
})

test("a recount never overwrites counts with an incomplete or failed read", async () => {
  const original = { row_count: 10000, error_count: 5 }
  const cases = [
    ["a smaller transport cap", large({ maxRows: 100 }), /membership is incomplete/],
    ["an unavailable page", large(), /unavailable/],
  ]
  // The recount's paged reads answer with neither rows nor an error.
  cases[1][1].tamper("import_rows", (result, query) => (query.rangeValue ? replies.missing()(result) : result))
  for (const [name, service, error] of cases) {
    Object.assign(largeBatch(service), original)
    await assert.rejects(skipFirstRow(service), error, name)
    assert.deepEqual([largeBatch(service).row_count, largeBatch(service).error_count], [10000, 5], name)
  }
})

test("a recount does not touch a batch that started committing mid-edit", async () => {
  const service = large()
  const batch = Object.assign(largeBatch(service), { status: "committing", row_count: 10000 })
  // The edit saw the batch while it was still staged; the commit claimed it before the recount saved.
  service.tamper("import_batches", replies.rows({ ...batch, status: "staged" }), { on: "select", times: 1 })
  await assert.rejects(skipFirstRow(service), /Failed to save import counts/)
  assert.equal(largeBatch(service).status, "committing")
  assert.equal(largeBatch(service).row_count, 10000)
})

test("validation finds a reference past the API's row cap instead of rejecting the row", async () => {
  const existing = Array.from({ length: 1500 }, (_, index) => ({
    id: id(300000 + index),
    org_id: ORG,
    code: `C${String(index).padStart(4, "0")}`,
    parent_id: null,
  }))
  const service = tenant(["import.manage"], { import_batches: [], import_rows: [], cost_codes: existing }, { maxRows: 1000 })

  const batch = await service.run(() =>
    imports.stageImportBatch({ importer: "cost_codes", csvText: "code,name,parent_code\n9000,New scope,C1499" }),
  )

  assert.equal(batch.error_count, 0)
})

test("a failed staging run marks only this org's batch as failed", async () => {
  const service = tenant(["import.manage"], { import_batches: [], import_rows: [], cost_codes: [] })
  service.tamper("cost_codes", replies.error("connection lost"))
  const updates = []
  service.tamper("import_batches", (result, query) => {
    updates.push({ ...query.where })
    return result
  }, { on: "update" })

  await assert.rejects(
    service.run(() => imports.stageImportBatch({ importer: "cost_codes", csvText: "code,name\n9000,New scope" })),
    /connection lost/,
  )
  assert.equal(service.db.import_batches[0].status, "failed")
  assert.deepEqual(updates, [{ org_id: ORG, id: service.db.import_batches[0].id }])
})

test("committing takeoff updates writes only this org's line", async () => {
  const PLAN = id(7001)
  const VERSION = id(7002)
  const COST_CODE = id(7003)
  const LINE = id(7004)
  const TAKEOFF_BATCH = id(7005)
  const service = createServiceHarness({
    permissions: ["import.manage", "plan.write"],
    tables: {
      import_batches: [{
        id: TAKEOFF_BATCH, org_id: ORG, importer: "plan_library", status: "staged", error_count: 0,
        update_existing: true, context: { file_kind: "takeoffs" }, created_at: "2026-10-04T12:00:00Z",
      }],
      import_rows: [{
        id: ROW, org_id: ORG, batch_id: TAKEOFF_BATCH, row_number: 1, status: "valid", issues: [],
        parsed: { plan_code: "PL1", cost_code: "03-100", description: "Slab", quantity: 4, uom: "cy", unit_cost_cents: 1000 },
      }],
      house_plans: [{ id: PLAN, org_id: ORG, code: "PL1", versions: [{ id: VERSION, status: "draft", version_number: 1 }], elevations: [] }],
      cost_codes: [{ id: COST_CODE, org_id: ORG, code: "03-100", cost_type: "material" }],
      house_plan_takeoff_lines: [{ id: LINE, org_id: ORG, house_plan_version_id: VERSION, cost_code_id: COST_CODE, description: "Slab", elevation_id: null, quantity: 1 }],
    },
  })
  const updateScopes = []
  service.tamper("house_plan_takeoff_lines", (result, query) => {
    updateScopes.push({ ...query.where })
    return result
  }, { on: "update" })

  await service.run(() => imports.commitImportBatch(TAKEOFF_BATCH))

  assert.deepEqual(updateScopes, [{ org_id: ORG, id: LINE }])
})

test("a division-limited buyer's price book commit refuses org-wide and other-division rows before any write", async () => {
  const PRICE_BATCH = id(7101)
  const GULF = id(7102)
  const ATLANTIC = id(7103)
  const GULF_COMMUNITY = id(7104)
  const ATLANTIC_COMMUNITY = id(7105)
  const COST_CODE = id(7106)
  const VENDOR = id(7107)
  const row = (number, parsed) => ({
    id: id(7200 + number), org_id: ORG, batch_id: PRICE_BATCH, row_number: number, status: "valid", issues: [],
    parsed: { company_id: VENDOR, cost_code_id: COST_CODE, uom: "sf", unit_price_cents: 250, ...parsed },
  })
  const commit = (rows) => {
    const service = createServiceHarness({
      permissions: ["import.manage", "price_book.write"],
      divisions: [GULF],
      tables: {
        import_batches: [{ id: PRICE_BATCH, org_id: ORG, importer: "price_book", status: "staged", error_count: 0, created_at: "2026-10-04T12:00:00Z" }],
        import_rows: rows,
        communities: [
          { id: GULF_COMMUNITY, org_id: ORG, division_id: GULF },
          { id: ATLANTIC_COMMUNITY, org_id: ORG, division_id: ATLANTIC },
        ],
      },
    })
    return { service, run: () => service.run(() => imports.commitImportBatch(PRICE_BATCH)) }
  }

  for (const [label, parsed] of [
    ["an org-wide row", {}],
    ["another division's row", { division_id: ATLANTIC }],
    ["another division's community", { community_id: ATLANTIC_COMMUNITY }],
  ]) {
    const { service, run } = commit([row(1, { community_id: GULF_COMMUNITY }), row(2, parsed)])
    await assert.rejects(run(), /Rows 2 are outside your divisions/, label)
    assert.deepEqual(service.writes("vendor_price_agreements"), [], label)
    assert.deepEqual(service.writes("companies"), [], label)
  }

  const own = commit([row(1, { community_id: GULF_COMMUNITY }), row(2, { division_id: GULF })])
  await own.run()
  assert.equal(own.service.writes("vendor_price_agreements").length, 2)
})
