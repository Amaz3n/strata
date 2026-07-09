require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
  decideAuthorization,
  wouldStrandOrgWithoutAdmin,
} = require("../lib/services/authorization-policy")

// Sensible defaults for an org-scoped check by an active member.
function decide(overrides = {}) {
  return decideAuthorization({
    permission: "invoice.read",
    hasProjectScope: false,
    hasResolvedOrg: true,
    permissionSet: [],
    orgPermissionSet: [],
    deniedPermissions: [],
    hasProjectMembership: false,
    hasOrgMembership: true,
    assignedOnly: false,
    ...overrides,
  })
}

test("grants a permission the role holds", () => {
  const d = decide({ permission: "invoice.read", permissionSet: ["invoice.read", "docs.read"] })
  assert.equal(d.allowed, true)
  assert.equal(d.reasonCode, "allow_permission")
})

test("denies a permission the role lacks", () => {
  const d = decide({ permission: "payment.release", permissionSet: ["invoice.read"] })
  assert.equal(d.allowed, false)
  assert.equal(d.reasonCode, "deny_missing_permission")
})

test("wildcard '*' grants everything", () => {
  const d = decide({ permission: "anything.at.all", permissionSet: ["*"] })
  assert.equal(d.allowed, true)
})

test("explicit deny override beats a grant of the same key", () => {
  const d = decide({
    permission: "budget.write",
    permissionSet: ["budget.write"],
    deniedPermissions: ["budget.write"],
  })
  assert.equal(d.allowed, false)
})

test("deny override is not defeated by a wildcard", () => {
  const d = decide({
    permission: "payment.release",
    permissionSet: ["*", "payment.release"],
    deniedPermissions: ["payment.release"],
  })
  assert.equal(d.allowed, false)
})

test("separation of duties: bookkeeper can write bills but not release payment", () => {
  const bookkeeper = ["bill.read", "bill.write", "invoice.read", "invoice.write", "report.read"]
  assert.equal(decide({ permission: "bill.write", permissionSet: bookkeeper }).allowed, true)
  assert.equal(decide({ permission: "payment.release", permissionSet: bookkeeper }).allowed, false)
  assert.equal(decide({ permission: "bill.approve", permissionSet: bookkeeper }).allowed, false)
})

// --- project scoping ---------------------------------------------------------

test("project-scoped check is blocked for a non-member without all-project access", () => {
  const d = decide({
    permission: "schedule.edit",
    hasProjectScope: true,
    hasProjectMembership: false,
    permissionSet: ["schedule.edit"],
    orgPermissionSet: ["schedule.edit"],
  })
  assert.equal(d.allowed, false)
  assert.equal(d.reasonCode, "deny_no_project_membership")
})

test("project-scoped check passes for an explicit project member", () => {
  const d = decide({
    permission: "schedule.edit",
    hasProjectScope: true,
    hasProjectMembership: true,
    permissionSet: ["schedule.edit"],
    orgPermissionSet: [],
  })
  assert.equal(d.allowed, true)
})

test("org-level project.read grants all-project access when scope is 'all'", () => {
  const d = decide({
    permission: "schedule.read",
    hasProjectScope: true,
    hasProjectMembership: false,
    assignedOnly: false,
    permissionSet: ["schedule.read", "project.read"],
    orgPermissionSet: ["schedule.read", "project.read"],
  })
  assert.equal(d.allowed, true)
})

test("assigned-only member is blocked from projects they don't belong to, even with project.read", () => {
  const d = decide({
    permission: "schedule.read",
    hasProjectScope: true,
    hasProjectMembership: false,
    assignedOnly: true,
    permissionSet: ["schedule.read", "project.read", "project.manage"],
    orgPermissionSet: ["schedule.read", "project.read", "project.manage"],
  })
  assert.equal(d.allowed, false)
  assert.equal(d.reasonCode, "deny_no_project_membership")
})

test("assigned-only member reaches projects they DO belong to", () => {
  const d = decide({
    permission: "schedule.read",
    hasProjectScope: true,
    hasProjectMembership: true,
    assignedOnly: true,
    permissionSet: ["schedule.read", "project.read"],
    orgPermissionSet: ["schedule.read", "project.read"],
  })
  assert.equal(d.allowed, true)
})

test("assigned-only does NOT restrict full admins (org.admin keeps all-project access)", () => {
  const d = decide({
    permission: "schedule.read",
    hasProjectScope: true,
    hasProjectMembership: false,
    assignedOnly: true,
    permissionSet: ["schedule.read", "org.admin"],
    orgPermissionSet: ["schedule.read", "org.admin"],
  })
  assert.equal(d.allowed, true)
})

test("assigned-only does NOT restrict wildcard/superadmin access", () => {
  const d = decide({
    permission: "schedule.read",
    hasProjectScope: true,
    hasProjectMembership: false,
    assignedOnly: true,
    permissionSet: ["*"],
    orgPermissionSet: ["*"],
  })
  assert.equal(d.allowed, true)
})

test("non-member of the org gets deny_no_org_membership", () => {
  const d = decide({
    permission: "invoice.read",
    hasOrgMembership: false,
    permissionSet: [],
  })
  assert.equal(d.allowed, false)
  assert.equal(d.reasonCode, "deny_no_org_membership")
})

// --- last-admin guard --------------------------------------------------------

test("last admin cannot be demoted", () => {
  assert.equal(
    wouldStrandOrgWithoutAdmin({ adminMembershipIds: ["m1"], membershipId: "m1", staysAdmin: false }),
    true,
  )
})

test("demoting an admin is fine when another admin remains", () => {
  assert.equal(
    wouldStrandOrgWithoutAdmin({ adminMembershipIds: ["m1", "m2"], membershipId: "m1", staysAdmin: false }),
    false,
  )
})

test("keeping the admin role is always fine", () => {
  assert.equal(
    wouldStrandOrgWithoutAdmin({ adminMembershipIds: ["m1"], membershipId: "m1", staysAdmin: true }),
    false,
  )
})

test("changing a non-admin never strands the org", () => {
  assert.equal(
    wouldStrandOrgWithoutAdmin({ adminMembershipIds: ["m1"], membershipId: "m2", staysAdmin: false }),
    false,
  )
})
