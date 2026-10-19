require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const { getNotificationHref } = require("@/lib/notifications/destinations")

test("a notification opens the workspace that owns its record, with that record selected", () => {
  for (const [entity_type, expected] of [
    ["invoice", "/projects/project/financials/billing?invoice=entity"],
    ["task", "/tasks?project=project&task=entity"],
    ["file", "/projects/project/documents?fileId=entity"],
    ["rfi", "/projects/project/rfis?rfi=entity"],
    ["submittal", "/projects/project/submittals?submittal=entity"],
    ["daily_log", "/projects/project/daily-logs?logId=entity"],
    ["drawing_sheet", "/projects/project/drawings"],
    ["change_order", "/projects/project/change-orders"],
  ]) {
    assert.equal(getNotificationHref({ project_id: "project", entity_id: "entity", entity_type }), expected, entity_type)
  }
  assert.equal(getNotificationHref({ project_id: "project", entity_type: "invoice" }), "/projects/project/financials/billing")
})

test("an explicit in-app destination is followed; an off-site one never is", () => {
  assert.equal(getNotificationHref({ href: "/payables/reconciliation?run=one" }), "/payables/reconciliation?run=one")
  for (const href of ["//external.test", "/\\external.test", "javascript:alert(1)", "https://external.test", "/\n/external.test"]) {
    assert.equal(getNotificationHref({ href }), null, JSON.stringify(href))
  }
  assert.equal(getNotificationHref(null), null)
  assert.equal(getNotificationHref({}), null)
})

test("record identifiers cannot inject path segments or query parameters", () => {
  assert.equal(
    getNotificationHref({ project_id: "one/two", entity_type: "rfi", entity_id: "a&b" }),
    "/projects/one%2Ftwo/rfis?rfi=a%26b",
  )
  assert.equal(
    getNotificationHref({ project_id: "project", entity_type: "daily_log", entity_id: "fallback", daily_log_id: "preferred" }),
    "/projects/project/daily-logs?logId=preferred",
  )
})
