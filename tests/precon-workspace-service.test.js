"use strict"

/**
 * `lib/services/precon-workspace.ts` — a deal's precon records: which project
 * it is priced on, its brief, and its open questions and conditions. (The
 * pure brief and decision rules live in `lib/precon/workspace.ts`, tested in
 * precon-workspace.test.js.) A deal linked to a project is authorized against
 * that project, resolved with the service client so a hidden project never
 * passes for "unlinked"; open blockers hold the agreement and the start.
 */

const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness, replies, id, ORG, ACTOR } = require("./support/service")
const { freshRequire } = require("./support/modules")

const { EMPTY_PRECON_BRIEF } = require("@/lib/precon/workspace")
const { assertPreconDecisionGate, getPreconProjectId, getPreconWorkspace, savePreconDecision } = freshRequire(
  "lib/services/precon-workspace.ts",
)

const DEAL = id(1)
const PROJECT = id(2)
const OTHER_PROJECT = id(3)

const READER = ["org.read", "project.read"]
const WRITER = ["org.member", "project.read", "project.manage"]

function harness({ status = "pricing", project = {}, permissions = WRITER, projects, workspaces = [], decisions = [] } = {}) {
  return createServiceHarness({
    tables: {
      prospects: [
        { id: DEAL, org_id: ORG, status, notes: "Unsaved intake scope", budget_range: "over_1m", timeline_preference: "asap" },
      ],
      projects: project ? [{ id: PROJECT, org_id: ORG, prospect_id: DEAL, phase: "precon", ...project }] : [],
      precon_workspaces: workspaces,
      precon_decisions: decisions,
    },
    permissions,
    projects,
  })
}

describe("getPreconProjectId", () => {
  const resolve = (service, dealId = DEAL) => service.run(() => getPreconProjectId(dealId))

  test("a reader resolves the deal's project; an unlinked deal has none", async () => {
    assert.equal(await resolve(harness({ permissions: READER })), PROJECT)
    assert.equal(await resolve(harness({ permissions: READER, project: null })), null)
  })

  test("a caller without org access is refused before the deal is read", async () => {
    const service = harness({ permissions: ["project.read"] })
    await assert.rejects(resolve(service))
    assert.deepEqual(service.reads("prospects"), [])
  })

  test("a linked project the caller cannot read is refused, never treated as unlinked", async () => {
    await assert.rejects(resolve(harness({ permissions: ["org.read"] })), /project\.read/)
    await assert.rejects(resolve(harness({ permissions: READER, projects: [OTHER_PROJECT] })), /project\.read/)
  })

  test("a missing deal, a failed project lookup or a malformed id resolves nothing", async () => {
    const missing = harness()
    missing.db.prospects = []
    await assert.rejects(resolve(missing), /Prospect not found/)

    const failed = harness()
    failed.tamper("projects", replies.error("Database unavailable"))
    await assert.rejects(resolve(failed), /Database unavailable/)

    const malformed = harness()
    await assert.rejects(resolve(malformed, "invalid"))
    assert.deepEqual(malformed.queries, [])
  })
})

describe("getPreconWorkspace", () => {
  test("a deal with no saved brief reads empty, never the unsaved intake, and writes nothing", async () => {
    const service = harness()
    const workspace = await service.run(() => getPreconWorkspace(DEAL))
    assert.equal(workspace.version, 0)
    assert.equal(workspace.brief.scope, "")
    assert.equal(workspace.brief.target_budget_cents, null)
    assert.equal(workspace.brief.target_start, null)
    assert.deepEqual(service.writes(), [])
  })

  test("a brief saved before newer fields existed reads with their defaults", async () => {
    const legacy = { ...EMPTY_PRECON_BRIEF, scope: "Saved scope" }
    delete legacy.pricing_path
    delete legacy.direct_agreement_reason
    const service = harness({ workspaces: [{ org_id: ORG, prospect_id: DEAL, version: 2, brief: legacy }] })

    const workspace = await service.run(() => getPreconWorkspace(DEAL))
    assert.equal(workspace.version, 2)
    assert.equal(workspace.brief.scope, "Saved scope")
    assert.equal(workspace.brief.pricing_path, "budget_review")
    assert.equal(workspace.brief.direct_agreement_reason, "")
    assert.deepEqual(service.writes(), [])
  })
})

describe("savePreconDecision", () => {
  const question = {
    title: "Owner finish selection",
    kind: "client_decision",
    owner_user_id: null,
    due_date: null,
    cost_impact_cents: null,
  }
  const save = (service, input, decisionId, version) =>
    service.run(() => savePreconDecision(DEAL, input, decisionId, version))

  test("a resolution records who resolved it, and a stale edit cannot overwrite it", async () => {
    const service = harness()
    const { id: decisionId } = await save(service, question)
    await save(service, { ...question, status: "resolved", resolution: "Owner confirmed finish A" }, decisionId, 1)
    await assert.rejects(save(service, question, decisionId, 1), /changed while you were editing/)

    const [stored] = service.db.precon_decisions
    assert.equal(stored.status, "resolved")
    assert.equal(stored.resolution, "Owner confirmed finish A")
    assert.equal(stored.resolved_by, ACTOR)
  })

  test("lost, won and delivered deals take no new decisions", async () => {
    for (const [status, phase, message] of [
      ["lost", "precon", /Reopen/],
      ["won", "precon", /delivery/],
      ["pricing", "delivery", /delivery/],
    ]) {
      const service = harness({ status, project: { phase } })
      await assert.rejects(save(service, question), message, `${status} / ${phase}`)
      assert.deepEqual(service.writes(), [])
    }
  })

  test("deciding on a linked deal needs project.manage on its project", async () => {
    const service = harness({ permissions: ["org.member", "project.read"] })
    await assert.rejects(save(service, question), /project\.manage/)
    assert.deepEqual(service.writes(), [])
  })
})

describe("assertPreconDecisionGate", () => {
  const blocker = (n, overrides) => ({ id: id(100 + n), org_id: ORG, prospect_id: DEAL, status: "open", ...overrides })

  test("open blockers hold the agreement and the start until resolved", async () => {
    const service = harness({
      decisions: [
        blocker(1, { blocks_agreement: true }),
        blocker(2, { blocks_agreement: true, blocks_start: true }),
        blocker(3, { blocks_agreement: true, status: "resolved" }),
        // A client's question goes out with the proposal; signing waits on its answer instead.
        blocker(4, { blocks_agreement: true, kind: "client_decision" }),
      ],
    })
    await assert.rejects(service.run(() => assertPreconDecisionGate(DEAL, "agreement")), /2 open agreement conditions/)
    await assert.rejects(service.run(() => assertPreconDecisionGate(DEAL, "start")), /1 open start condition/)

    service.db.precon_decisions = []
    await service.run(() => assertPreconDecisionGate(DEAL, "agreement"))
  })
})
