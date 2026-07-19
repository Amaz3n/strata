require("../scripts/register-ts-node-test")
const assert = require("node:assert/strict")
const test = require("node:test")
const { parseVpoApprovalBands, requiredVpoApprovalPermission } = require("../lib/financials/vpo-approval-thresholds")

test("VPO approval bands include boundary values and use absolute totals", () => {
  const bands = parseVpoApprovalBands([{ up_to_cents: 100000, permission: "small" }, { up_to_cents: null, permission: "large" }])
  assert.equal(requiredVpoApprovalPermission({ totalCents: 100000, isBackcharge: false, bands }), "small")
  assert.equal(requiredVpoApprovalPermission({ totalCents: 100001, isBackcharge: false, bands }), "large")
  assert.equal(requiredVpoApprovalPermission({ totalCents: -99999, isBackcharge: false, bands }), "small")
  assert.equal(requiredVpoApprovalPermission({ totalCents: -1, isBackcharge: true, bands }), "vpo.approve_large")
})

test("invalid settings fall back to the safe default", () => {
  assert.equal(parseVpoApprovalBands(null)[0].permission, "vpo.approve")
  assert.equal(parseVpoApprovalBands([{ up_to_cents: 5, permission: "small" }])[1].permission, "vpo.approve_large")
})
