"use strict"

/**
 * The Open-WIP cutover in `lib/services/imports.ts`: a platform operator commits
 * a house file whose budgets and open POs come from companion files staged for
 * the same cutover. The service claims the batch, re-reads everything a home is
 * built from, hands each house to the database as one payload, and reconciles
 * what was built against what the source files declared; a row the files cannot
 * build rolls the batch back, an interruption keeps its receipts and resumes.
 * Companion files are taken only from the same cutover, and for sample houses
 * only from the exact original batches and their committed receipts.
 *
 * The SQL steps (`claim_open_wip_commit`, `commit_open_wip_house`, ...) are
 * answered in memory by `withOpenWipRpc`; what they write is the database's to
 * prove, what the service sends them and when is proved here.
 */

const test = require("node:test")
const assert = require("node:assert/strict")

const { platformActor } = require("./support/platform")

const { withIlike } = require("./support/postgrest-extras")
const { replies, id, ORG, ACTOR } = require("./support/service")
const { freshRequire } = require("./support/modules")

const { commitImportBatch, stageImportBatch } = freshRequire("lib/services/imports.ts")

const DATE = "2026-10-02"
const TOKEN = id(99)
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
    plan_code: "ASTER",
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
function cutover({ houses = {}, rows = [budgetLine, openPo], batches = [], lot = {}, rpc = {} } = {}) {
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
      house_plan_versions: [{ id: PLAN_VERSION, org_id: ORG, status: "released" }],
      community_plan_availability: [{ id: id(31), org_id: ORG, community_id: COMMUNITY, house_plan_id: PLAN, is_available: true, elevation_id: null, effective_start: null, effective_end: null }],
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
  return withOpenWipRpc(withIlike(service), rpc)
}


/**
 * The cutover's SQL steps (claim, one house, finalize, rollback, release,
 * cancel), answered in memory and recorded in `service.calls`. `overrides`
 * replaces a step by name, e.g. to make one house raise.
 */
function withOpenWipRpc(service, overrides) {
  service.calls = []
  const steps = {
    // The SQL claim: a staged batch with every error fixed or skipped, or a failed one resuming.
    claim_open_wip_commit: ({ p_batch_id }) => {
      const claimed = service.db.import_batches.find((row) => row.id === p_batch_id)
      const open = (claimed.status === "staged" && claimed.error_count === 0) || claimed.status === "failed"
      return { data: open ? { token: TOKEN, attempt: 1, jobId: null, actorId: ACTOR } : null, error: null }
    },
    cancel_open_wip_commit_if_requested: () => ({ data: null, error: null }),
    commit_open_wip_house: ({ p_row_id }) => {
      service.db.import_rows.find((row) => row.id === p_row_id).status = "committed"
      return { data: null, error: null }
    },
    finalize_open_wip_commit: () => {
      Object.assign(houseBatch(service), { status: "committed", committed_count: 1 })
      return { data: { ...houseBatch(service), report: { actions: { created: 1 } } }, error: null }
    },
    rollback_open_wip_commit: () => ({ data: null, error: null }),
    release_open_wip_commit: () => ({ data: null, error: null }),
    ...overrides,
  }
  const rpc = service.client.rpc
  service.client.rpc = async (name, args) => {
    const step = steps[name]
    if (!step) return rpc(name, args)
    service.calls.push({ name, args })
    return step(args)
  }
  return service
}

const calls = (service, name) => service.calls.filter((call) => call.name === name).map((call) => call.args)

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



// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

test("a sold house is handed over as one home with its budget, PO, buyer, agreement and stage-anchored schedule", async () => {
  const service = cutover()
  const saved = await commit(service)

  const [claim] = calls(service, "claim_open_wip_commit")
  assert.equal(claim.p_batch_id, HOUSES)
  assert.equal(claim.p_actor_id, ACTOR)

  const [{ p_house: house, p_row_id, p_claim_token }] = calls(service, "commit_open_wip_house")
  assert.equal(p_row_id, HOUSE_ROW)
  assert.equal(p_claim_token, TOKEN)
  assert.equal(house.lot_id, LOT)
  assert.equal(house.name, "Cypress — Lot 12")
  assert.deepEqual(house.budget, { total_cents: 100000, lines: [{ cost_code_id: CODE, description: "Imported 03-100", amount_cents: 100000, sort_order: 0 }] })
  assert.deepEqual(house.purchase_orders.map((po) => [po.po_number, po.company_id, po.remaining_cents, po.original_cents]), [["PO-1", VENDOR, 20000, 50000]])
  assert.deepEqual(house.buyer, { name: "Dana Buyer", email: "dana@example.test" })
  assert.deepEqual(house.contract, {
    number: "WIP-CYP-12",
    title: "Imported purchase agreement — Lot 12",
    signed_at: "2026-09-01T00:00:00Z",
    total_cents: 45000000,
    effective_date: "2026-09-01",
  })
  // Framing is today's stage; the stage before it is done and the ones after follow the template's offsets.
  assert.deepEqual(house.schedule.map((item) => [item.name, item.status, item.start_date]), [
    ["Foundation", "completed", "2026-09-12"],
    ["Framing", "in_progress", DATE],
    ["Roof", "planned", "2026-10-12"],
  ])

  assert.deepEqual(calls(service, "finalize_open_wip_commit"), [
    { p_org_id: ORG, p_batch_id: HOUSES, p_claim_token: TOKEN, p_expected: [{ row_id: HOUSE_ROW, lot_number: "12", budget_cents: 100000, budget_lines: 1, purchase_orders: 1, po_cents: 20000 }] },
  ])
  assert.equal(saved.status, "committed")
  assert.equal(service.events.at(-1).eventType, "import_batch_committed")
  assert.deepEqual(calls(service, "rollback_open_wip_commit"), [])
})

test("a house the source files cannot build rolls the batch back and builds nothing", async () => {
  const parsedOf = (service) => service.db.import_rows.find((row) => row.id === HOUSE_ROW).parsed
  const cases = [
    ["a budget that does not foot", (s) => (parsedOf(s).budget_total_cents = 200000), /budget lines total does not match the house total/],
    ["a plan with no schedule template", (s) => delete parsedOf(s).schedule_template_id, /no schedule template/],
    ["a sold house with no buyer email", (s) => delete parsedOf(s).buyer_email, /needs a buyer email/],
    ["a stage the template does not have", (s) => (parsedOf(s).stage_task = "Plumbing"), /Plumbing was not found/],
    ["a plan version that is no longer released", (s) => (s.db.house_plan_versions[0].status = "draft"), /no longer has that released version/],
  ]
  for (const [name, change, refusal] of cases) {
    const service = cutover()
    change(service)
    await assert.rejects(commit(service), refusal, name)
    assert.deepEqual(calls(service, "commit_open_wip_house"), [], name)
    assert.deepEqual(calls(service, "finalize_open_wip_commit"), [], name)
    assert.equal(calls(service, "rollback_open_wip_commit").length, 1, name)
    assert.deepEqual(calls(service, "release_open_wip_commit"), [], name)
    assertNoDomainWrites(service, name)
  }
})

test("a house the database refuses rolls the batch back, so an incomplete home is never kept", async () => {
  const service = cutover({ rpc: { commit_open_wip_house: () => ({ data: null, error: { code: "P0001", message: "Lot was assigned during import" } }) } })
  await assert.rejects(commit(service), /Lot was assigned during import/)
  const [rollback] = calls(service, "rollback_open_wip_commit")
  assert.equal(rollback.p_claim_token, TOKEN)
  assert.match(rollback.p_error, /Lot was assigned during import/)
  assert.deepEqual(calls(service, "finalize_open_wip_commit"), [])
})

test("an interruption keeps the homes built so far and resumes from their receipts", async () => {
  const service = cutover({ rpc: { commit_open_wip_house: () => ({ data: null, error: { code: "08006", message: "connection dropped" } }) } })
  await assert.rejects(commit(service), /connection dropped.*resumes from its receipts/)
  assert.deepEqual(calls(service, "release_open_wip_commit").map((call) => call.p_fail), [false])
  assert.deepEqual(calls(service, "rollback_open_wip_commit"), [])
  assert.deepEqual(calls(service, "finalize_open_wip_commit"), [])
})

test("a resumed commit builds only the houses that have no receipt", async () => {
  const service = cutover()
  service.db.import_rows.find((row) => row.id === HOUSE_ROW).status = "committed"
  await commit(service)
  assert.deepEqual(calls(service, "commit_open_wip_house"), [])
  assert.equal(calls(service, "finalize_open_wip_commit").length, 1)
})

test("a lot that already has a home goes to the database to be adopted or refused, not rebuilt", async () => {
  const service = cutover({ lot: { project_id: id(40) } })
  await commit(service)
  const [{ p_house: house }] = calls(service, "commit_open_wip_house")
  assert.deepEqual(house, { lot_id: LOT, lot_number: "12", community_id: COMMUNITY })
})

test("an operator's cancellation stops the commit before the next home and keeps what is built", async () => {
  const cancelled = { at: "2026-10-02T10:00:00Z", requested_at: "2026-10-02T09:59:00Z", by: ACTOR, homes_built: 0, rows: 1, attempt: 1 }
  const service = cutover({ rpc: { cancel_open_wip_commit_if_requested: () => ({ data: cancelled, error: null }) } })
  await commit(service)
  assert.deepEqual(calls(service, "commit_open_wip_house"), [])
  assert.deepEqual(calls(service, "finalize_open_wip_commit"), [])
  assert.deepEqual(calls(service, "rollback_open_wip_commit"), [])
  assert.equal(service.events.at(-1).eventType, "import_batch_cancelled")
})

test("a batch that is already committed cannot be claimed again", async () => {
  const service = cutover({ houses: { status: "committed" } })
  await assert.rejects(commit(service), /must be staged/)
  assert.deepEqual(service.calls, [])
})

// ---------------------------------------------------------------------------
// Companions
// ---------------------------------------------------------------------------

test("a duplicated companion row stops the cutover before any home is built", async () => {
  const service = cutover({ rows: [budgetLine, { ...budgetLine, id: id(71), row_number: 2 }, openPo] })
  await assert.rejects(commit(service), /Duplicate Open-WIP companion row/)
  assert.deepEqual(calls(service, "commit_open_wip_house"), [])
  assert.deepEqual(calls(service, "finalize_open_wip_commit"), [])
})

test("companions match on the whole house identity, not a shared prefix", async () => {
  const blocked = { ...budgetLine, id: id(72), natural_key: "other", parsed: { ...budgetLine.parsed, block: "1", lot_number: "2", budget_cents: 999 } }
  const service = cutover({ rows: [budgetLine, openPo, blocked] })
  await commit(service)
  const [{ p_house: house }] = calls(service, "commit_open_wip_house")
  assert.equal(house.budget.total_cents, 100000)
})

test("budget and PO companions come only from the same cutover date and onboarding run", async () => {
  const service = cutover({ houses: { onboarding_run_id: OTHER } })
  for (const row of service.db.import_batches) if (row.id === BUDGETS || row.id === POS) row.onboarding_run_id = OTHER
  service.db.import_batches.push(batch(id(13), "budgets", { onboarding_run_id: id(14) }), batch(id(15), "budgets", { context: { as_of_date: "2026-10-01" } }))
  service.db.import_rows.push(
    { ...budgetLine, id: id(73), batch_id: id(13), natural_key: "elsewhere", parsed: { ...budgetLine.parsed, budget_cents: 5 } },
    { ...budgetLine, id: id(74), batch_id: id(15), natural_key: "earlier", parsed: { ...budgetLine.parsed, budget_cents: 7 } },
  )
  await commit(service)
  const [{ p_house: house }] = calls(service, "commit_open_wip_house")
  assert.equal(house.budget.total_cents, 100000)
  assert.equal(house.budget.lines.length, 1)
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

  const [{ p_expected }] = calls(service, "finalize_open_wip_commit")
  assert.deepEqual(p_expected.map((e) => [e.budget_cents, e.budget_lines, e.purchase_orders, e.po_cents]), [[100000, 1, 1, 20000]])
})

// ---------------------------------------------------------------------------
// Sample houses and staging
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
    assert.deepEqual(calls(committing, "commit_open_wip_house"), [], `commit: ${name}`)
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

