"use strict"

/**
 * `lib/services/precon-project-start.ts` — signing is the handoff. Starting
 * the job is authorized against the deal's own project (resolved with the
 * service client, so a hidden project cannot pass for "none") and pinned to it
 * when the database activates the job; `startBuilding()` then drafts the job
 * budget from the cost side of the signed lines.
 */

const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness, replies, id, ORG, ACTOR } = require("./support/service")
const { stubModule, freshRequire } = require("./support/modules")

// The budget service has its own suite; here it records the draft it is handed.
let drafted = []
stubModule("@/lib/services/budgets", {
  createBudget: async (input) => {
    drafted.push(structuredClone(input))
  },
})

const { startBuilding, startProspectProject } = freshRequire("lib/services/precon-project-start.ts")

const DEAL = id(1)
const PROJECT = id(2)
const OTHER_PROJECT = id(3)
const AGREEMENT = id(4)

/** A signed $100k agreement: framing, a tile allowance, an unaccepted hot tub, 5% builder contingency. */
function agreement({ contingency = "builder_reserve" } = {}) {
  return {
    id: AGREEMENT,
    org_id: ORG,
    subtotal_cents: 100_000_00,
    metadata: {
      contingency_percent: 5,
      precon: {
        purpose: "construction_agreement",
        contingency_treatment: contingency,
        allowance_policy: "Reconciled by change order",
      },
    },
    items: [
      { id: "group", item_type: "group", description: "Interior", sort_order: 0 },
      { id: "framing", item_type: "line", description: "Framing", quantity: 1, unit_cost_cents: 60_000_00, sort_order: 1, cost_code_id: null, metadata: {} },
      { id: "tile", item_type: "line", description: "Tile", quantity: 1, unit_cost_cents: 40_000_00, sort_order: 2, cost_code_id: null, metadata: { is_allowance: true } },
      { id: "hot-tub", item_type: "line", description: "Hot tub", quantity: 1, unit_cost_cents: 9_000_00, sort_order: 3, cost_code_id: null, metadata: { is_optional: true } },
    ],
  }
}

function harness({ project = true, permissions = ["project.manage"], projects, budgets = [], estimate = agreement() } = {}) {
  drafted = []
  return createServiceHarness({
    tables: {
      prospects: [{ id: DEAL, org_id: ORG }],
      projects: project ? [{ id: PROJECT, org_id: ORG, prospect_id: DEAL }] : [],
      budgets,
      estimates: [estimate],
    },
    permissions,
    projects,
    rpc: { start_prospect_project: () => ({ data: { projectId: PROJECT, alreadyStarted: false }, error: null }) },
  })
}

const starts = (service) => service.queries.filter((query) => query.table === "rpc:start_prospect_project")

describe("startProspectProject", () => {
  test("the start is authorized on the deal's project and pinned to it", async () => {
    const service = harness()
    await service.run(() => startProspectProject(DEAL))
    assert.deepEqual(starts(service).map((query) => query.payload), [
      {
        p_org_id: ORG,
        p_prospect_id: DEAL,
        p_actor_id: ACTOR,
        p_expected_project_id: PROJECT,
        p_property_type: "residential",
      },
    ])
  })

  test("an unlinked deal starts with no expected project", async () => {
    const service = harness({ project: false })
    await service.run(() => startProspectProject(DEAL))
    assert.equal(starts(service)[0].payload.p_expected_project_id, null)
  })

  test("a missing deal, a hidden project or a failed lookup never reaches the start", async () => {
    const missing = harness()
    missing.db.prospects = []
    const hidden = harness({ projects: [OTHER_PROJECT] })
    const failed = harness()
    failed.tamper("projects", replies.error("lookup failed"))

    for (const [service, message] of [
      [missing, /Prospect not found/],
      [hidden, /Missing permission: project\.manage/],
      [failed, /lookup failed/],
    ]) {
      await assert.rejects(service.run(() => startProspectProject(DEAL)), message)
      assert.deepEqual(starts(service), [])
    }
  })
})

describe("startBuilding", () => {
  test("starting the job drafts its budget from the signed lines at cost", async () => {
    const service = harness()
    const result = await service.run(() => startBuilding(DEAL, AGREEMENT))

    assert.equal(starts(service)[0].payload.p_expected_agreement_id, AGREEMENT)
    assert.equal(result.budgetCreated, true)
    assert.equal(drafted.length, 1)
    const [budget] = drafted
    assert.equal(budget.status, "draft")
    assert.equal(budget.project_id, PROJECT)
    assert.deepEqual(
      budget.lines.map((line) => [line.description, line.amount_cents]),
      [
        ["Framing", 60_000_00],
        ["Tile", 40_000_00],
        ["Builder contingency reserve", 5_000_00],
      ],
    )
    assert.equal(budget.lines[0].metadata.section_title, "Interior")
    assert.equal(budget.lines[1].metadata.is_allowance, true)
    assert.equal(budget.lines[1].metadata.allowance_policy, "Reconciled by change order")
  })

  test("a job that already has a budget keeps it", async () => {
    const service = harness({ budgets: [{ id: id(9), org_id: ORG, project_id: PROJECT }] })
    const result = await service.run(() => startBuilding(DEAL, AGREEMENT))
    assert.equal(result.budgetCreated, false)
    assert.deepEqual(drafted, [])
  })

  test("contingency already in the price is not budgeted again", async () => {
    const service = harness({ estimate: agreement({ contingency: "included_in_price" }) })
    await service.run(() => startBuilding(DEAL, AGREEMENT))
    assert.deepEqual(drafted[0].lines.map((line) => line.description), ["Framing", "Tile"])
  })
})
