require("../scripts/register-ts-node-test")
const assert = require("node:assert/strict")
const test = require("node:test")
const { parseVpoApprovalBands, requiredVpoApprovalPermission, vpoEvidenceBlockReason } = require("../lib/financials/vpo-approval-thresholds")
const { purchasingSettingsUpdateSchema, varianceReasonCodeSchema } = require("../lib/validation/purchasing-settings")

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

test("cost evidence is required from the org threshold up, and always for a back-charge", () => {
  const order = { totalCents: 100_000, isBackcharge: false, evidenceOverCents: 100_000, evidenceCount: 0 }
  assert.match(vpoEvidenceBlockReason(order), /cost evidence/)
  assert.equal(vpoEvidenceBlockReason({ ...order, totalCents: 99_999 }), null)
  assert.match(vpoEvidenceBlockReason({ ...order, totalCents: -250_000 }), /cost evidence/)
  assert.equal(vpoEvidenceBlockReason({ ...order, evidenceCount: 1 }), null)
  assert.equal(vpoEvidenceBlockReason({ ...order, evidenceOverCents: null }), null)
  assert.match(vpoEvidenceBlockReason({ ...order, totalCents: -100, isBackcharge: true, evidenceOverCents: null }), /back-charge/i)
  assert.match(vpoEvidenceBlockReason({ ...order, totalCents: 1, evidenceOverCents: 0 }), /cost evidence/)
})

test("an approval band can only name an approval permission, ascending, with the open band last", () => {
  const band = (up_to_cents, permission) => ({ up_to_cents, permission })
  const parse = (bands) => purchasingSettingsUpdateSchema.safeParse({ vpo_approval_thresholds: bands })
  assert.equal(parse([band(100_000, "vpo.approve"), band(null, "vpo.approve_large")]).success, true)
  assert.equal(parse([band(100_000, "commitment.read"), band(null, "vpo.approve_large")]).success, false)
  assert.equal(parse([band(500_000, "vpo.approve"), band(100_000, "vpo.approve"), band(null, "vpo.approve_large")]).success, false)
  assert.equal(parse([band(100_000, "vpo.approve")]).success, false)
  assert.equal(parse([band(null, "vpo.approve"), band(100_000, "vpo.approve_large")]).success, false)
  assert.equal(purchasingSettingsUpdateSchema.safeParse({ expiring_agreement_lead_days: 0 }).success, false)
  assert.equal(purchasingSettingsUpdateSchema.safeParse({ vpo_evidence_required_over_cents: null }).success, true)
})

test("a variance reason code is a short snake_case key", () => {
  assert.equal(varianceReasonCodeSchema.safeParse({ code: "storm_damage", label: "Storm damage" }).success, true)
  assert.equal(varianceReasonCodeSchema.safeParse({ code: "Storm Damage", label: "Storm damage" }).success, false)
})
