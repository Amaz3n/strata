const assert = require("node:assert/strict")
const fs = require("node:fs")
const test = require("node:test")
const ts = require("typescript")
function load(path, dependencies = {}) {
  const exports = {}
  const source = ts.transpileModule(fs.readFileSync(path, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText
  new Function("exports", "require", source)(exports, name => dependencies[name])
  return exports
}
const { getNotificationHref } = load("lib/notifications/destinations.ts", {
  "@/lib/financials/invoice-destinations": load("lib/financials/invoice-destinations.ts"),
})
test("notifications target the canonical workspace and selected entity without compatibility redirects", () => {
  for (const [entity_type, expected] of [
    ["invoice", "/projects/project/financials/billing?invoice=entity"],
    ["task", "/tasks?project=project&task=entity"],
    ["file", "/projects/project/documents?fileId=entity"],
    ["rfi", "/projects/project/rfis?rfi=entity"],
    ["submittal", "/projects/project/submittals?submittal=entity"],
    ["daily_log", "/projects/project/daily-logs?logId=entity"],
    ["drawing_sheet", "/projects/project/drawings"],
    ["change_order", "/projects/project/change-orders"],
  ]) assert.equal(getNotificationHref({ project_id: "project", entity_id: "entity", entity_type }), expected)
  assert.equal(getNotificationHref({ project_id: "project", entity_type: "invoice" }), "/projects/project/financials/billing")
})
test("org-level explicit destinations work, while unsafe external destinations cannot become router pushes", () => {
  assert.equal(getNotificationHref({ href: "/payables/reconciliation?run=one" }), "/payables/reconciliation?run=one")
  for (const href of ["//external.test", "/\\external.test", "javascript:alert(1)", "https://external.test", "/\n/external.test"]) {
    assert.equal(getNotificationHref({ href }), null)
  }
  assert.equal(getNotificationHref(null), null)
  assert.equal(getNotificationHref({}), null)
})
test("notification entity identifiers cannot inject path segments or query parameters", () => {
  assert.equal(getNotificationHref({ project_id: "one/two", entity_type: "rfi", entity_id: "a&b" }), "/projects/one%2Ftwo/rfis?rfi=a%26b")
  assert.equal(getNotificationHref({ project_id: "project", entity_type: "daily_log", entity_id: "fallback", daily_log_id: "preferred" }), "/projects/project/daily-logs?logId=preferred")
})
