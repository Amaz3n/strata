"use strict"

const test = require("node:test")
const assert = require("node:assert/strict")

const { createServiceHarness, replies, id, ORG } = require("./support/service")
const { freshRequire } = require("./support/modules")

const { getBudgetTemplate, listBudgetTemplates } = freshRequire("lib/services/budget-templates.ts")

const FIRST = id(1)
const SECOND = id(2)
const FOREIGN_ORG = id(3)
const UNLISTED = id(4)

/**
 * Two templates with 900 and 800 lines; line i is worth i + 1 cents. Plus a
 * foreign-org line on FIRST and a line on a template nobody asked for.
 */
function library(options = {}) {
  const lines = Array.from({ length: 1700 }, (_, i) => ({
    id: id(100 + i),
    org_id: ORG,
    budget_template_id: i < 900 ? FIRST : SECOND,
    sort_order: 1700 - i,
    description: `Line ${i}`,
    amount_cents: i + 1,
    cost_code_id: null,
    quantity: null,
    unit_cost_cents: null,
  }))
  lines.push({ id: id(5000), org_id: FOREIGN_ORG, budget_template_id: FIRST, sort_order: 0, amount_cents: 99999999 })
  lines.push({ id: id(5001), org_id: ORG, budget_template_id: UNLISTED, sort_order: 0, amount_cents: 99999999 })
  return createServiceHarness({
    tables: {
      budget_templates: [
        { id: FIRST, org_id: ORG, name: "Template 0", is_active: true },
        { id: SECOND, org_id: ORG, name: "Template 1", is_active: true },
      ],
      budget_template_lines: lines,
    },
    permissions: ["budget.read"],
    ...options,
  })
}

const sumTo = (n) => (n * (n + 1)) / 2

test("template totals include every line across short pages and nothing foreign", async () => {
  for (const maxRows of [100, 37]) {
    const templates = await library({ maxRows }).run(() => listBudgetTemplates())

    assert.deepEqual(
      templates.map((template) => [template.line_count, template.total_cents]),
      [
        [900, sumTo(900)],
        [800, sumTo(1700) - sumTo(900)],
      ],
      `maxRows ${maxRows}`,
    )
    const ids = templates.flatMap((template) => template.lines.map((line) => line.id))
    assert.equal(new Set(ids).size, 1700)
  }
})

test("one template's detail is complete and limited to that template", async () => {
  const detail = await library({ maxRows: 100 }).run(() => getBudgetTemplate(FIRST))
  assert.equal(detail.line_count, 900)
  assert.equal(detail.total_cents, sumTo(900))
})

test("a failed or empty later page fails the read instead of producing partial totals", async () => {
  const failLater = () => {
    let pages = 0
    return (result) => (++pages > 2 ? replies.error("later page unavailable")(result) : result)
  }
  for (const change of [failLater(), replies.missing()]) {
    const service = library({ maxRows: 100 })
    service.tamper("budget_template_lines", change)
    await assert.rejects(service.run(() => listBudgetTemplates()), /Failed to load complete budget template lines/)
  }
})
