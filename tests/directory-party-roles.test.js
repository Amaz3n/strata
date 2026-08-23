require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")
const {
  currentRoles,
  hasRoleCategory,
  hasRoleKey,
  isCurrentRole,
  isStatusValidForCategory,
  resolvePartyCapabilities,
  roleStatusLabel,
  statusesForCategory,
} = require("../lib/directory/roles")

function role(overrides = {}) {
  return {
    id: overrides.id ?? "role-1",
    relationship_type_id: "type-1",
    key: overrides.key ?? "subcontractor",
    label: overrides.label ?? "Subcontractor",
    category: overrides.category ?? "vendor",
    status: overrides.status ?? "active",
    since: overrides.since ?? "2026-01-01T00:00:00.000Z",
    until: overrides.until,
  }
}

// ── The case the old single type column could not express ──────────────────

test("a party can hold vendor and client roles at once", () => {
  const capabilities = resolvePartyCapabilities([
    role({ id: "a", key: "subcontractor", category: "vendor" }),
    role({ id: "b", key: "client", category: "client", label: "Client" }),
  ])
  assert.equal(capabilities.isVendor, true)
  assert.equal(capabilities.isClient, true)
  // The framing sub who buys a spec home gets BOTH sets of account tabs.
  assert.equal(capabilities.requiresCompliance, true)
})

test("a party with no roles gets no capabilities rather than a permissive default", () => {
  const capabilities = resolvePartyCapabilities([])
  assert.equal(capabilities.isVendor, false)
  assert.equal(capabilities.isClient, false)
  assert.equal(capabilities.requiresCompliance, false)
})

test("design parties are not on the AP rail, so compliance does not apply", () => {
  const capabilities = resolvePartyCapabilities([
    role({ key: "architect", category: "design", label: "Architect" }),
  ])
  assert.equal(capabilities.isDesign, true)
  assert.equal(capabilities.isVendor, false)
  assert.equal(capabilities.requiresCompliance, false)
})

// ── Ended roles are history, not current fact ──────────────────────────────

test("a role that ended in the past stops granting capabilities but survives as history", () => {
  const ended = role({ until: "2026-02-01T00:00:00.000Z" })
  const now = new Date("2026-06-01T00:00:00.000Z")
  assert.equal(isCurrentRole(ended, now), false)
  assert.equal(currentRoles([ended], now).length, 0)
  assert.equal(resolvePartyCapabilities([ended]).isVendor, false)
})

test("a role whose end is still in the future is current", () => {
  const ending = role({ until: "2026-12-31T00:00:00.000Z" })
  const now = new Date("2026-06-01T00:00:00.000Z")
  assert.equal(isCurrentRole(ending, now), true)
  assert.equal(resolvePartyCapabilities([ending]).isVendor, true)
})

// ── Status is the other half of liveness ───────────────────────────────────
// These three used to pass while the app disagreed with itself: TypeScript read
// `until` only, the directory_entries view read `until is null` only, and both
// ignored `status`. An inactive vendor kept its account tabs and stayed on the
// compliance watch list.

test("an inactive role is not current even with no end date", () => {
  const inactive = role({ status: "inactive" })
  assert.equal(isCurrentRole(inactive), false)
  assert.equal(currentRoles([inactive]).length, 0)
  assert.equal(resolvePartyCapabilities([inactive]).isVendor, false)
  assert.equal(resolvePartyCapabilities([inactive]).requiresCompliance, false)
})

test("a closed client role is not current", () => {
  const closed = role({ key: "client", category: "client", status: "closed" })
  assert.equal(isCurrentRole(closed), false)
  assert.equal(resolvePartyCapabilities([closed]).isClient, false)
})

test("stages on the way in stay live", () => {
  // Prospective and invited vendors are being courted, not dropped: they belong
  // on the compliance watch list before the first bill, not after it.
  for (const status of ["prospective", "invited"]) {
    assert.equal(isCurrentRole(role({ status })), true, status)
    assert.equal(resolvePartyCapabilities([role({ status })]).isVendor, true, status)
  }
  for (const status of ["inquiry", "qualified", "under_contract"]) {
    const clientRole = role({ key: "client", category: "client", status })
    assert.equal(isCurrentRole(clientRole), true, status)
    assert.equal(resolvePartyCapabilities([clientRole]).isClient, true, status)
  }
})

test("one live role is enough when another has gone inactive", () => {
  const capabilities = resolvePartyCapabilities([
    role({ id: "a", key: "subcontractor", category: "vendor", status: "inactive" }),
    role({ id: "b", key: "supplier", category: "vendor", status: "active" }),
  ])
  assert.equal(capabilities.isVendor, true)
})

test("role lookups ignore ended roles", () => {
  const roles = [
    role({ id: "a", key: "subcontractor", until: "2020-01-01T00:00:00.000Z" }),
    role({ id: "b", key: "client", category: "client" }),
  ]
  assert.equal(hasRoleKey(roles, "subcontractor"), false)
  assert.equal(hasRoleKey(roles, "client"), true)
  assert.equal(hasRoleCategory(roles, "vendor"), false)
  assert.equal(hasRoleCategory(roles, "client"), true)
})

// ── Lifecycle vocabulary ──────────────────────────────────────────────────

test("active and inactive are valid for every category", () => {
  for (const category of ["vendor", "client", "design", "internal", "other"]) {
    assert.equal(isStatusValidForCategory("active", category), true, category)
    assert.equal(isStatusValidForCategory("inactive", category), true, category)
  }
})

test("funnel states belong to their own category and nowhere else", () => {
  assert.equal(isStatusValidForCategory("under_contract", "client"), true)
  assert.equal(isStatusValidForCategory("under_contract", "vendor"), false)
  assert.equal(isStatusValidForCategory("invited", "vendor"), true)
  assert.equal(isStatusValidForCategory("invited", "client"), false)
  assert.equal(isStatusValidForCategory("inquiry", "design"), false)
})

test("a homeowner recorded directly is simply active, not forced through inquiry", () => {
  // Regression: the client vocabulary originally had no `active`, so adding an
  // existing homeowner to the directory was impossible without claiming they
  // arrived as a new lead.
  assert.ok(statusesForCategory("client").includes("active"))
})

test("every status has a label", () => {
  for (const category of ["vendor", "client", "other"]) {
    for (const status of statusesForCategory(category)) {
      assert.equal(typeof roleStatusLabel(status), "string")
      assert.ok(roleStatusLabel(status).length > 0)
    }
  }
})

test("prospect and buyer are distinguished by role key, not by status alone", () => {
  const prospect = resolvePartyCapabilities([
    role({ key: "prospect", category: "client", label: "Prospect", status: "inquiry" }),
  ])
  const buyer = resolvePartyCapabilities([
    role({ key: "buyer", category: "client", label: "Buyer", status: "under_contract" }),
  ])
  assert.equal(prospect.isProspect, true)
  assert.equal(prospect.isBuyer, false)
  assert.equal(buyer.isBuyer, true)
  assert.equal(buyer.isProspect, false)
  // Both are clients; the same role filter surfaces either one.
  assert.equal(prospect.isClient, true)
  assert.equal(buyer.isClient, true)
})
