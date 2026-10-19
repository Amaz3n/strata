"use strict"

/**
 * The Open-WIP cutover in `lib/services/imports.ts`: a platform operator commits
 * a house file whose budgets and open POs come from companion files staged for
 * the same cutover. A home is published (its lot attached) only once every
 * record it needs exists; anything less is rolled back. Companion files are
 * taken only from the same cutover — and for sample houses, only from the
 * exact original batches and their committed receipts.
 *
 * Kept apart from `tests/imports.test.js` (importer access and paging) while
 * that suite is being rewritten; fold it in once both settle.
 */

const test = require("node:test")
const assert = require("node:assert/strict")

const { platformActor } = require("./support/platform")
const { withIlike } = require("./support/postgrest-extras")
const { replies, id, ORG, ACTOR } = require("./support/service")
const { freshRequire } = require("./support/modules")

const { commitImportBatch, stageImportBatch } = freshRequire("lib/services/imports.ts")

const DATE = "2026-10-02"
const OTHER = id(1)
const COMMUNITY = id(2)
const LOT = id(3)
const PLAN = id(4)
const PLAN_VERSION = id(5)
const ELEVATION = id(6)
const TEMPLATE = id(7)
const CODE = id(8)
const VENDOR = id(9)
const HOUSES = id(10)
const BUDGETS = id(11)
const POS = id(12)
const HOUSE_ROW = id(20)
const BUDGET_ROW = id(21)
const PO_ROW = id(22)

const ON_CUSTOMER = { platformOrgId: ORG }
const DOMAIN_TABLES = [
  "projects",
  "budgets",
  "budget_lines",
  "commitments",
  "commitment_lines",
  "schedule_items",
  "contacts",
  "contracts",
  "lots",
]

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function batch(batchId, fileKind, overrides = {}) {
  const { context, ...rest } = overrides
  return {
    id: batchId,
    org_id: ORG,
    importer: "open_wip",
    status: "committed",
    created_by: ACTOR,
    onboarding_run_id: null,
    row_count: 1,
    committed_count: 1,
    skipped_count: 0,
    error_count: 0,
    update_existing: false,
    report: {},
    created_at: "2026-10-02T00:00:00Z",
    context: { file_kind: fileKind, as_of_date: DATE, ...context },
    ...rest,
  }
}

/** A committed companion row, with the receipt `commitImportBatch` writes for it. */
function receipt(rowId, batchId, parsed, overrides = {}) {
  return {
    id: rowId,
    org_id: ORG,
    batch_id: batchId,
    row_number: 1,
    raw: {},
    parsed: { community: "Cypress", lot_number: "12", ...parsed },
    status: "committed",
    issues: [],
    natural_key: `source:${rowId}`,
    action: "created",
    target_entity_type: "open_wip",
    target_entity_id: rowId,
    ...overrides,
  }
}

const budgetLine = receipt(BUDGET_ROW, BUDGETS, { cost_code: "03-100", cost_code_id: CODE, budget_cents: 100000 })
const openPo = receipt(PO_ROW, POS, {
  po_number: "PO-1",
  company_id: VENDOR,
  cost_code_id: CODE,
  description: "Remaining framing",
  remaining_cents: 20000,
  original_cents: 50000,
})

/** Lot 12 in Cypress: sold, framing on the cutover date, a $1,000 budget and one open PO. */
const houseRow = {
  id: HOUSE_ROW,
  org_id: ORG,
  batch_id: HOUSES,
  row_number: 1,
  raw: {},
  status: "valid",
  issues: [],
  natural_key: "house:cypress:12",
  parsed: {
    community: "Cypress",
    community_id: COMMUNITY,
    lot_number: "12",
    budget_total_cents: 100000,
    house_plan_id: PLAN,
    house_plan_version_id: PLAN_VERSION,
    elevation_id: ELEVATION,
    schedule_template_id: TEMPLATE,
    stage_task: "Framing",
    stage_date: DATE,
    sold: true,
    buyer_name: "Dana Buyer",
    buyer_email: "dana@example.test",
    sale_price_cents: 45000000,
    sale_date: "2026-09-01",
  },
}

/**
 * A customer org with the cutover staged: the house file (HOUSES) and its
 * committed budget (BUDGETS) and PO (POS) companions. `houses` overrides the
 * house batch, e.g. to make it a sample with explicit companion IDs.
 */
function cutover({ houses = {}, rows = [budgetLine, openPo], batches = [], lot = {} } = {}) {
  const service = platformActor({
    platform: ["platform.support.read", "platform.support.write"],
    tables: {
      orgs: [{ id: ORG, product_tier: "production" }],
      communities: [{ id: COMMUNITY, org_id: ORG, name: "Cypress", code: "CYP", division_id: id(30) }],
      lots: [{ id: LOT, org_id: ORG, community_id: COMMUNITY, lot_number: "12", block: null, project_id: null, ...lot }],
      house_plans: [
        {
          id: PLAN,
          org_id: ORG,
          code: "ASTER",
          versions: [{ id: PLAN_VERSION, status: "released", version_number: 1, schedule_template_id: TEMPLATE }],
          elevations: [{ id: ELEVATION, code: "A" }],
        },
      ],
      cost_codes: [{ id: CODE, org_id: ORG, code: "03-100", parent_id: null }],
      schedule_templates: [
        {
          id: TEMPLATE,
          org_id: ORG,
          items: [
            { name: "Foundation", start_offset_days: 0 },
            { name: "Framing", start_offset_days: 20 },
            { name: "Roof", start_offset_days: 30 },
          ],
        },
      ],
      projects: [],
      contacts: [],
      import_batches: [
        batch(HOUSES, "houses", { status: "staged", committed_count: 0, ...houses }),
        batch(BUDGETS, "budgets"),
        batch(POS, "purchase_orders"),
        ...batches,
      ],
      import_rows: [houseRow, ...rows],
    },
  })
  return withIlike(service)
}

function makeSample(service) {
  for (const row of service.db.import_batches) {
    if (row.id === BUDGETS || row.id === POS) row.context.is_sample = true
  }
  return service
}

const commit = (service) => service.run(() => commitImportBatch(HOUSES, ON_CUSTOMER))

const stageSampleHouses = (service, context) =>
  service.run(() =>
    stageImportBatch(
      {
        importer: "open_wip",
        csvText: "community,lot_number,plan_code,elevation_code,stage_task,budget_total_cents\nCypress,12,ASTER,A,Framing,1000.00",
        context: { file_kind: "houses", as_of_date: DATE, ...context },
      },
      ON_CUSTOMER,
    ),
  )

const SAMPLE_CONTEXT = { is_sample: true, companion_batch_ids: { budgets: BUDGETS, purchase_orders: POS } }

const lot = (service) => service.db.lots.find((row) => row.id === LOT)
const houseBatch = (service) => service.db.import_batches.find((row) => row.id === HOUSES)

function assertNoDomainWrites(service, label) {
  for (const table of DOMAIN_TABLES) assert.deepEqual(service.writes(table), [], `${label}: ${table}`)
}

function assertNothingPublished(service, label) {
  assert.equal(lot(service).project_id, null, label)
  assert.deepEqual(service.db.projects, [], label)
  assert.equal(houseBatch(service).status, "failed", label)
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

test("a sold house becomes an active home with its budget, PO, buyer, agreement and stage-anchored schedule", async () => {
  const service = cutover()

  const committed = await commit(service)

  assert.equal(committed.status, "committed")
  assert.equal(committed.committed_count, 1)
  const [project] = service.db.projects
  assert.equal(lot(service).project_id, project.id)
  assert.equal(project.metadata.wip_cutover.row_id, HOUSE_ROW)

  const [budget] = service.db.budgets
  assert.deepEqual([budget.status, budget.total_cents], ["approved", 100000])
  assert.deepEqual(
    service.db.budget_lines.map((line) => [line.cost_code_id, line.amount_cents]),
    [[CODE, 100000]],
  )
  assert.deepEqual(
    service.db.commitments.map((po) => [po.company_id, po.total_cents, po.status]),
    [[VENDOR, 20000, "approved"]],
  )
  assert.equal(service.db.commitment_lines[0].unit_cost_cents, 20000)
  assert.deepEqual(
    service.db.schedule_items.map((item) => [item.name, item.status, item.start_date]),
    [
      ["Foundation", "completed", "2026-09-12"],
      ["Framing", "in_progress", "2026-10-02"],
      ["Roof", "planned", "2026-10-12"],
    ],
  )
  const [buyer] = service.db.contacts
  assert.equal(project.client_id, buyer.id)
  const [agreement] = service.db.contracts
  assert.deepEqual(
    [agreement.status, agreement.signed_at, agreement.total_cents],
    ["active", "2026-09-01T00:00:00Z", 45000000],
  )
})

test("a failure at any step removes the half-built home and leaves the lot unpublished", async () => {
  const failures = [
    ["budgets", "insert"],
    ["budget_lines", "insert"],
    ["commitment_lines", "insert"],
    ["schedule_templates", "select"],
    ["schedule_items", "insert"],
    ["contacts", "select"],
    ["contacts", "insert"],
    ["projects", "update"],
    ["contracts", "insert"],
  ]
  for (const [table, action] of failures) {
    const service = cutover()
    service.tamper(table, replies.error("injected failure"), { on: action })
    await assert.rejects(commit(service), undefined, `${table} ${action}`)
    assertNothingPublished(service, `${table} ${action}`)
  }
})

test("a batch that fails on a later house unpublishes the houses before it", async () => {
  const LOT_B = id(40)
  const secondBudget = receipt(id(41), BUDGETS, { lot_number: "13", cost_code: "03-100", cost_code_id: CODE, budget_cents: 100000 })
  const service = cutover({ rows: [budgetLine, openPo, secondBudget], lot: { status: "owned" } })
  service.db.lots.push({ id: LOT_B, org_id: ORG, community_id: COMMUNITY, lot_number: "13", block: null, project_id: OTHER })
  service.db.projects.push({ id: OTHER, org_id: ORG, metadata: {} })
  service.db.import_rows.push({ ...houseRow, id: id(42), row_number: 2, natural_key: "house:cypress:13", parsed: { ...houseRow.parsed, lot_number: "13", sold: false } })

  await assert.rejects(commit(service), /Lot 13 already has a project/)

  assert.equal(lot(service).project_id, null)
  assert.equal(lot(service).status, "owned")
  assert.deepEqual(service.db.projects.map((row) => row.id), [OTHER])
  assert.equal(houseBatch(service).status, "failed")
})

test("a lot taken while the home was being built is not overwritten", async () => {
  const service = cutover()
  // Someone else assigns the lot right after the cutover read it as free.
  service.tamper(
    "lots",
    (result) => {
      const seen = structuredClone(result)
      lot(service).project_id = OTHER
      return seen
    },
    { on: "select", times: 1 },
  )

  await assert.rejects(commit(service), /Lot was assigned during import/)
  assert.equal(lot(service).project_id, OTHER)
  assert.deepEqual(service.db.projects, [])
  assert.equal(houseBatch(service).status, "failed")
})

test("a lot that already has an unrelated home must be reconciled first", async () => {
  const service = cutover({ lot: { project_id: OTHER } })
  service.db.projects.push({ id: OTHER, org_id: ORG, metadata: {} })

  await assert.rejects(commit(service), /already has a project/)
  assert.deepEqual(service.writes("projects"), [])
  assert.equal(lot(service).project_id, OTHER)
})

test("budget and PO companions come only from the same cutover date and onboarding run", async () => {
  const decoy = (batchId, overrides) => [
    batch(batchId, "budgets", overrides),
    receipt(id(40 + Number(batchId.slice(-2))), batchId, { cost_code_id: CODE, budget_cents: 999 }),
  ]
  const [otherDate, otherDateRow] = decoy(id(50), { context: { as_of_date: "2026-10-01" } })
  const [otherRun, otherRunRow] = decoy(id(51), { onboarding_run_id: id(52) })
  const service = cutover({ batches: [otherDate, otherRun], rows: [budgetLine, openPo, otherDateRow, otherRunRow] })

  await commit(service)

  assert.equal(service.db.budgets[0].total_cents, 100000)
})

test("companions match on the whole house identity, not a shared prefix", async () => {
  const blockTwelve = receipt(id(60), BUDGETS, { block: "1", lot_number: "2", cost_code_id: CODE, budget_cents: 777 })
  const service = cutover({ rows: [budgetLine, openPo, { ...blockTwelve, natural_key: "community:1:2:budget" }] })
  service.db.import_batches.find((row) => row.id === BUDGETS).row_count = 2

  await commit(service)

  assert.equal(service.db.budgets[0].total_cents, 100000)
})

test("a duplicated companion row stops the cutover before any home is built", async () => {
  const service = cutover({ rows: [budgetLine, openPo, { ...budgetLine, id: id(61) }] })

  await assert.rejects(commit(service), /Duplicate Open-WIP companion row/)
  assertNoDomainWrites(service, "duplicate")
})

test("a failed companion lookup stops the cutover before any home is built", async () => {
  const service = cutover()
  service.tamper(
    "import_batches",
    (result, query) => (query.where.importer === "open_wip" ? replies.error()(result) : result),
    { on: "select" },
  )

  await assert.rejects(commit(service), /companion batches/)
  assertNoDomainWrites(service, "lookup failure")
})

test("a house file larger than one page commits every row exactly once", async () => {
  const rows = Array.from({ length: 1203 }, (_, i) => ({
    id: id(100_000 + i),
    org_id: ORG,
    batch_id: BUDGETS,
    row_number: i + 1,
    raw: {},
    parsed: {},
    status: "valid",
    issues: [],
    natural_key: `budget:${i}`,
  }))
  const service = cutover({ rows })
  Object.assign(service.db.import_batches.find((row) => row.id === BUDGETS), { status: "staged", committed_count: 0 })

  const committed = await service.run(() => commitImportBatch(BUDGETS, ON_CUSTOMER))

  assert.equal(committed.committed_count, 1203)
  assert.ok(service.db.import_rows.filter((row) => row.batch_id === BUDGETS).every((row) => row.status === "committed"))
})

// ---------------------------------------------------------------------------
// Sample houses: exact original companions only
// ---------------------------------------------------------------------------

test("sample houses use only their original committed companions, ignoring uncommitted rows of the same file", async () => {
  const service = makeSample(cutover())
  service.db.import_rows.push(
    ...["valid", "warning"].map((status, i) => ({ ...budgetLine, id: id(70 + i), row_number: i + 2, status, natural_key: `budget:${i}` })),
  )

  const staged = await stageSampleHouses(service, SAMPLE_CONTEXT)

  assert.equal(staged.status, "staged")
  assert.equal(staged.error_count, 0)
})

test("sample houses refuse companions outside the exact original source, at staging and at commit", async () => {
  const budgets = (service) => service.db.import_batches.find((row) => row.id === BUDGETS)
  const pos = (service) => service.db.import_batches.find((row) => row.id === POS)
  const budgetReceipt = (service) => service.db.import_rows.find((row) => row.id === BUDGET_ROW)
  const poReceipt = (service) => service.db.import_rows.find((row) => row.id === PO_ROW)
  const duplicateBudgetReceipt = (service, overrides) => {
    service.db.import_rows.push({ ...structuredClone(budgetReceipt(service)), ...overrides })
    Object.assign(budgets(service), { row_count: 2, committed_count: 2 })
  }

  const cases = [
    ["missing original IDs", { context: { is_sample: true } }],
    ["malformed original IDs", { context: { ...SAMPLE_CONTEXT, companion_batch_ids: { budgets: "invalid", purchase_orders: POS } } }],
    ["the same ID twice", { context: { ...SAMPLE_CONTEXT, companion_batch_ids: { budgets: BUDGETS, purchase_orders: BUDGETS } } }],
    ["swapped kinds", { context: { ...SAMPLE_CONTEXT, companion_batch_ids: { budgets: POS, purchase_orders: BUDGETS } } }],
    ["partial commit counters", { change: (s) => (budgets(s).committed_count = 0) }],
    ["skipped source rows", { change: (s) => (budgets(s).skipped_count = 1) }],
    ["failed source rows", { change: (s) => (pos(s).error_count = 1) }],
    ["missing batch", { change: (s) => s.db.import_batches.splice(s.db.import_batches.indexOf(budgets(s)), 1) }],
    ["another org", { change: (s) => (budgets(s).org_id = OTHER) }],
    ["another creator", { change: (s) => (budgets(s).created_by = OTHER) }],
    ["another importer", { change: (s) => (budgets(s).importer = "cost_codes") }],
    ["another date", { change: (s) => (budgets(s).context.as_of_date = "2026-10-01") }],
    ["another onboarding run", { change: (s) => (budgets(s).onboarding_run_id = OTHER) }],
    ["a non-sample budget", { change: (s) => (budgets(s).context.is_sample = false) }],
    ["a staged budget", { change: (s) => (budgets(s).status = "staged") }],
    ["a failed PO file", { change: (s) => (pos(s).status = "failed") }],
    ["a missing PO receipt", { change: (s) => s.db.import_rows.splice(s.db.import_rows.indexOf(poReceipt(s)), 1) }],
    ["a missing budget receipt", { change: (s) => s.db.import_rows.splice(s.db.import_rows.indexOf(budgetReceipt(s)), 1) }],
    ["an uncommitted PO receipt", { change: (s) => (poReceipt(s).status = "valid") }],
    ["a foreign receipt", { change: (s) => (poReceipt(s).org_id = OTHER) }],
    ["a receipt moved to another batch", { change: (s) => (budgetReceipt(s).batch_id = OTHER) }],
    ["a receipt for another target type", { change: (s) => (budgetReceipt(s).target_entity_type = "projects") }],
    ["a replaced receipt target", { change: (s) => (poReceipt(s).target_entity_id = OTHER) }],
    ["a receipt that did not create", { change: (s) => (poReceipt(s).action = "updated") }],
    ["an invalid receipt row number", { change: (s) => (poReceipt(s).row_number = 0) }],
    ["a duplicated receipt", { change: (s) => duplicateBudgetReceipt(s, {}) }],
    ["a duplicated receipt row number", { change: (s) => duplicateBudgetReceipt(s, { id: id(80), target_entity_id: id(80) }) }],
  ]

  for (const [name, { context = SAMPLE_CONTEXT, change = () => {} }] of cases) {
    const error = /receipt/.test(name) ? /companion receipts/ : /companion batch|Invalid uuid/
    const staging = makeSample(cutover())
    change(staging)
    await assert.rejects(stageSampleHouses(staging, context), error, `stage: ${name}`)
    assertNoDomainWrites(staging, `stage: ${name}`)

    const committing = makeSample(cutover({ houses: { context } }))
    change(committing)
    await assert.rejects(commit(committing), error, `commit: ${name}`)
    assertNoDomainWrites(committing, `commit: ${name}`)
    assert.equal(houseBatch(committing).status, "failed", `commit: ${name}`)
  }
})

// ---------------------------------------------------------------------------
// Required facts: refused at staging, and never published at commit
// ---------------------------------------------------------------------------

const stageHouses = (service, { context = {}, budget = "1000.00" } = {}) =>
  service.run(() =>
    stageImportBatch(
      {
        importer: "open_wip",
        csvText: `community,lot_number,plan_code,elevation_code,stage_task,budget_total_cents\nCypress,12,ASTER,A,Framing,${budget}`,
        context: { file_kind: "houses", as_of_date: DATE, ...context },
      },
      ON_CUSTOMER,
    ),
  )

const stagedRows = (service, batchId) => service.db.import_rows.filter((row) => row.batch_id === batchId)

test("a house whose cutover facts are missing, from another date, or do not foot is flagged at staging and never built", async () => {
  const cases = [
    ["no as-of date", { context: { as_of_date: undefined } }, "missing_as_of_date", /all errors fixed/],
    ["a budget snapshot from another date", { context: { as_of_date: "2026-10-03" } }, "missing_budget_file", /all errors fixed/],
    ["a house total that the budget snapshot does not equal", { budget: "2000.00" }, "budget_total_mismatch", /all errors fixed/],
  ]
  for (const [name, options, code, refusal] of cases) {
    const service = cutover()
    const staged = await stageHouses(service, options)

    const rows = stagedRows(service, staged.id)
    assert.equal(rows.length, 1, name)
    assert.ok(rows.every((row) => row.issues.some((issue) => issue.code === code && issue.level === "error")), name)

    await assert.rejects(service.run(() => commitImportBatch(staged.id, ON_CUSTOMER)), refusal, name)
    assertNoDomainWrites(service, name)
    assert.equal(lot(service).project_id, null, name)
    assert.equal(service.db.import_batches.find((batch) => batch.id === staged.id).status, "staged", name)
  }
})

test("a house is built only when its budget foots to the declared total at commit as well", async () => {
  const service = cutover()
  service.db.import_rows.find((row) => row.id === HOUSE_ROW).parsed.budget_total_cents = 200000
  await assert.rejects(commit(service), /budget lines total does not match the house total/)
  assertNothingPublished(service, "budget does not foot")
  assertNoDomainWrites(service, "budget does not foot")
})

test("every record of a cut-over home carries the cutover that made it", async () => {
  const service = cutover()
  await commit(service)

  const [project] = service.db.projects
  assert.deepEqual(project.metadata.wip_cutover, { as_of_date: DATE, batch_id: HOUSES, row_id: HOUSE_ROW })
  assert.equal(project.metadata.imported_open_wip, true)
  assert.deepEqual(service.db.budgets.map((row) => [row.project_id, row.metadata.imported_open_wip, row.metadata.as_of_date]), [[project.id, true, DATE]])
  assert.deepEqual(service.db.commitments.map((row) => [row.project_id, row.metadata.imported_open_wip, row.metadata.as_of_date, row.metadata.original_cents, row.contract_number]), [[project.id, true, DATE, 50000, "PO-1"]])
  assert.deepEqual(service.db.contracts.map((row) => [row.project_id, row.snapshot.imported_open_wip, row.snapshot.as_of_date]), [[project.id, true, DATE]])
  assert.ok(service.db.schedule_items.every((row) => row.project_id === project.id && row.metadata.imported_open_wip === true))
})

test("a house's budget lines and POs are found behind more than one page of other houses' companion rows", async () => {
  const others = (batchId, count) =>
    Array.from({ length: count }, (_, i) => ({
      ...budgetLine,
      id: id(200_000 + (batchId === BUDGETS ? 0 : 100_000) + i),
      batch_id: batchId,
      row_number: i + 1,
      parsed: { community: "Cypress", lot_number: `9${i}`, cost_code_id: CODE, budget_cents: 1, po_number: `PO-${i}`, company_id: VENDOR, remaining_cents: 1, original_cents: 1 },
      natural_key: `other:${batchId}:${i}`,
    }))
  const ours = (row, rowNumber) => ({ ...row, row_number: rowNumber })
  const service = cutover({ rows: [...others(BUDGETS, 1_203), ours(budgetLine, 1_204), ...others(POS, 1_203), ours(openPo, 1_204)] })
  for (const row of service.db.import_batches) if (row.id === BUDGETS || row.id === POS) row.row_count = 1_204

  await commit(service)

  assert.equal(service.db.budgets[0].total_cents, 100000)
  assert.deepEqual(service.db.commitments.map((po) => [po.contract_number, po.total_cents]), [["PO-1", 20000]])
})

test("the same house twice in one file is flagged on both rows and the batch cannot be committed", async () => {
  const service = cutover()
  const staged = await service.run(() =>
    stageImportBatch(
      {
        importer: "open_wip",
        csvText: "community,lot_number,plan_code,elevation_code,stage_task,budget_total_cents\nCypress,12,ASTER,A,Framing,1000.00\nCypress,12,ASTER,A,Framing,1000.00",
        context: { file_kind: "houses", as_of_date: DATE },
      },
      ON_CUSTOMER,
    ),
  )

  assert.equal(staged.error_count, 2)
  assert.ok(stagedRows(service, staged.id).every((row) => row.status === "error" && row.issues.some((issue) => issue.code === "duplicate_natural_key")))
  await assert.rejects(service.run(() => commitImportBatch(staged.id, ON_CUSTOMER)), /errors fixed or explicitly skipped/)
  assertNoDomainWrites(service, "duplicate house")
})

test("a house flagged by its companions is staged as an error, not as valid", async () => {
  const cases = [
    ["a house total that the budget snapshot does not equal", { budget: "2000.00" }],
    ["a budget snapshot from another date", { context: { as_of_date: "2026-10-03" } }],
    ["no as-of date", { context: { as_of_date: undefined } }],
  ]
  for (const [name, options] of cases) {
    const service = cutover()
    const staged = await stageHouses(service, options)

    assert.equal(staged.error_count, 1, name)
    assert.equal(staged.valid_count, 0, name)
    assert.deepEqual(stagedRows(service, staged.id).map((row) => row.status), ["error"], name)
  }
})

// ---------------------------------------------------------------------------
// Provenance that cannot be silently dropped: stage schedule and buyer
// ---------------------------------------------------------------------------

const stageSoldHouse = (service, { template = true, buyerEmail = "dana@example.test" } = {}) => {
  if (!template) service.db.house_plans[0].versions[0].schedule_template_id = null
  return service.run(() =>
    stageImportBatch(
      {
        importer: "open_wip",
        csvText: `community,lot_number,plan_code,elevation_code,stage_task,budget_total_cents,sold,buyer_name,buyer_email\nCypress,12,ASTER,A,Framing,1000.00,yes,Dana Buyer,${buyerEmail}`,
        context: { file_kind: "houses", as_of_date: DATE },
      },
      ON_CUSTOMER,
    ),
  )
}

test("a house on a plan with no schedule template, or a sold house with no buyer email, is an error at staging and cannot be committed", async () => {
  const cases = [
    ["a plan with no schedule template", { template: false }, "missing_schedule_template"],
    ["a sold house with no buyer email", { buyerEmail: "" }, "missing_buyer"],
  ]
  for (const [name, options, code] of cases) {
    const service = cutover()
    const staged = await stageSoldHouse(service, options)

    assert.equal(staged.error_count, 1, name)
    const [row] = stagedRows(service, staged.id)
    assert.equal(row.status, "error", name)
    assert.ok(row.issues.some((issue) => issue.code === code && issue.level === "error"), name)
    await assert.rejects(service.run(() => commitImportBatch(staged.id, ON_CUSTOMER)), /errors fixed or explicitly skipped/, name)
    assertNoDomainWrites(service, name)
    assert.equal(lot(service).project_id, null, name)
  }
})

test("a house with a template and a buyer email stages clean", async () => {
  const service = cutover()
  const staged = await stageSoldHouse(service)
  assert.equal(staged.error_count, 0)
})

test("a commit that reaches a house without a schedule template or buyer fails and leaves nothing published", async () => {
  const noTemplate = cutover()
  delete noTemplate.db.import_rows.find((row) => row.id === HOUSE_ROW).parsed.schedule_template_id
  await assert.rejects(commit(noTemplate), /no schedule template/)
  assertNothingPublished(noTemplate, "no template")

  const noBuyer = cutover()
  delete noBuyer.db.import_rows.find((row) => row.id === HOUSE_ROW).parsed.buyer_email
  await assert.rejects(commit(noBuyer), /needs a buyer email/)
  assertNothingPublished(noBuyer, "no buyer")
})

test("a buyer email with wildcard characters matches only that contact", async () => {
  const service = cutover()
  service.db.contacts.push({ id: id(90), org_id: ORG, email: "dXna_buyer@example.test", full_name: "Someone Else" })
  service.db.import_rows.find((row) => row.id === HOUSE_ROW).parsed.buyer_email = "d_na_buyer@example.test"

  await commit(service)

  const [project] = service.db.projects
  assert.notEqual(project.client_id, id(90))
  assert.equal(service.db.contacts.length, 2)
})
