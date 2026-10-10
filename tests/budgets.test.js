"use strict"

/**
 * `lib/services/budgets.ts` — the budget baseline: the "Original" every later
 * variance is measured against. It is set once.
 */

const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire } = require("./support/modules")

const { lockBudgetBaseline } = freshRequire("lib/services/budgets.ts")

const PROJECT = id(1)
const BUDGET = id(2)
const LINE = id(3)

function harness({ locked = false, permissions = ["budget.write", "budget.read", "project.read"] } = {}) {
  return createServiceHarness({
    permissions,
    tables: {
      projects: [{ id: PROJECT, org_id: ORG, name: "Lot 12" }],
      budgets: [{
        id: BUDGET, org_id: ORG, project_id: PROJECT, version: 1,
        baseline_lines: locked ? [{ id: LINE, cost_code_id: null, description: "Slab", amount_cents: 500_000 }] : null,
        baseline_locked_at: locked ? "2026-09-01T00:00:00+00:00" : null,
        lines: [{ id: LINE, org_id: ORG, cost_code_id: null, description: "Slab", amount_cents: 650_000 }],
      }],
    },
  })
}

describe("lockBudgetBaseline", () => {
  test("the first lock freezes the budget's current lines as the Original", async () => {
    const service = harness()
    assert.deepEqual(await service.run(() => lockBudgetBaseline(PROJECT)), { success: true, line_count: 1 })
    assert.deepEqual(service.db.budgets[0].baseline_lines.map((line) => line.amount_cents), [650_000])
    assert.notEqual(service.db.budgets[0].baseline_locked_at, null)
    assert.deepEqual(service.events.map((event) => event.eventType), ["budget_baseline_locked"])
    assert.deepEqual(service.audits.map((entry) => entry.entityType), ["budget"])
  })

  test("a locked baseline cannot be locked again, so the original margin cannot be rewritten", async () => {
    const service = harness({ locked: true })
    await assert.rejects(service.run(() => lockBudgetBaseline(PROJECT)), /already locked/)
    assert.deepEqual(service.writes(), [])
    assert.deepEqual(service.db.budgets[0].baseline_lines.map((line) => line.amount_cents), [500_000])
  })

  test("two locks racing each other leave exactly one baseline", async () => {
    const service = harness()
    const outcomes = await Promise.allSettled([service.run(() => lockBudgetBaseline(PROJECT)), service.run(() => lockBudgetBaseline(PROJECT))])
    assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1)
    assert.equal(service.events.filter((event) => event.eventType === "budget_baseline_locked").length, 1)
  })

  test("a reader cannot lock a baseline", async () => {
    const service = harness({ permissions: ["budget.read", "project.read"] })
    await assert.rejects(service.run(() => lockBudgetBaseline(PROJECT)))
    assert.deepEqual(service.writes(), [])
  })
})
