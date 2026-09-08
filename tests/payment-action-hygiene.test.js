const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

const root = path.resolve(__dirname, "..")
const actionFiles = [
  "app/(app)/payables/actions.ts",
  "app/(app)/payables/approval-signals-actions.ts",
  "app/(app)/payables/payment-runs/actions.ts",
  "app/(app)/payables/reconciliation/actions.ts",
  "app/(app)/payments/actions.ts",
  "app/(app)/projects/[id]/payables/actions.ts",
  "app/(app)/settings/payment-actions.ts",
]

test("every payables money-action file has structured errors and an authorization-owning service boundary", () => {
  for (const relative of actionFiles) {
    const source = fs.readFileSync(path.join(root, relative), "utf8")
    assert.match(source, /ActionResult|actionError|return run\(/, `${relative} must return structured action results`)
    const exports = source.split(/(?=export async function )/).slice(1)
    for (const body of exports) {
      const name = body.match(/^export async function\s+([A-Za-z0-9_]+)/)?.[1] ?? "unknown"
      assert.match(body, /requirePermission|requireAuthorization|requireOrgContext|return run\(|return [A-Za-z][A-Za-z0-9_]*\(|await [A-Za-z][A-Za-z0-9_]*\(/, `${relative}:${name} must authorize directly or call a service that does`)
    }
  }
})

test("the vendor-company link mutation lives behind bill.write in the service", () => {
  const action = fs.readFileSync(path.join(root, "app/(app)/projects/[id]/payables/actions.ts"), "utf8")
  const service = fs.readFileSync(path.join(root, "lib/services/vendor-bills.ts"), "utf8")
  assert.match(action, /ensureVendorBillCompany/)
  assert.doesNotMatch(action.slice(action.indexOf("ensureProjectVendorCompanyForPayableAction"), action.indexOf("listProjectCommitmentsForPayablesAction")), /from\("vendor_bills"\)/)
  assert.match(service.slice(service.indexOf("ensureVendorBillCompany")), /permission: "bill\.write"/)
  assert.match(service.slice(service.indexOf("ensureVendorBillCompany")), /recordAudit/)
})
