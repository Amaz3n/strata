require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const {
  decideAuthorization,
  intersectProjectReadScopes,
  wouldStrandOrgWithoutAdmin,
} = require("@/lib/services/authorization-policy")

/** An org-scoped check by an active member, with `overrides` applied. */
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

test("a role grants exactly the keys it holds", () => {
  const granted = decide({ permission: "invoice.read", permissionSet: ["invoice.read", "docs.read"] })
  assert.equal(granted.allowed, true)
  assert.equal(granted.reasonCode, "allow_permission")

  const missing = decide({ permission: "payment.release", permissionSet: ["invoice.read"] })
  assert.equal(missing.allowed, false)
  assert.equal(missing.reasonCode, "deny_missing_permission")

  assert.equal(decide({ permission: "anything.at.all", permissionSet: ["*"] }).allowed, true)
})

test("an explicit deny override beats a grant and a wildcard", () => {
  for (const permissionSet of [["budget.write"], ["*", "budget.write"]]) {
    const decision = decide({ permission: "budget.write", permissionSet, deniedPermissions: ["budget.write"] })
    assert.equal(decision.allowed, false, permissionSet.join(","))
  }
})

test("separation of duties: a bookkeeper writes bills but cannot approve them or release payment", () => {
  const bookkeeper = ["bill.read", "bill.write", "invoice.read", "invoice.write", "report.read"]
  for (const [permission, allowed] of [
    ["bill.write", true],
    ["bill.approve", false],
    ["payment.release", false],
  ]) {
    assert.equal(decide({ permission, permissionSet: bookkeeper }).allowed, allowed, permission)
  }
})

test("a project-scoped check needs project membership or unrestricted project access", () => {
  const cases = [
    // [name, overrides, allowed]
    ["non-member, no project.read", { permissionSet: ["schedule.edit"], orgPermissionSet: ["schedule.edit"] }, false],
    ["explicit project member", { hasProjectMembership: true, permissionSet: ["schedule.edit"] }, true],
    [
      "org project.read with all-project scope",
      { permissionSet: ["schedule.edit", "project.read"], orgPermissionSet: ["schedule.edit", "project.read"] },
      true,
    ],
    [
      "assigned-only non-member, even with project.read and project.manage",
      {
        assignedOnly: true,
        permissionSet: ["schedule.edit", "project.read", "project.manage"],
        orgPermissionSet: ["schedule.edit", "project.read", "project.manage"],
      },
      false,
    ],
    [
      "assigned-only member of the project",
      {
        assignedOnly: true,
        hasProjectMembership: true,
        permissionSet: ["schedule.edit", "project.read"],
        orgPermissionSet: ["schedule.edit", "project.read"],
      },
      true,
    ],
    [
      "assigned-only org admin",
      { assignedOnly: true, permissionSet: ["schedule.edit", "org.admin"], orgPermissionSet: ["schedule.edit", "org.admin"] },
      true,
    ],
    ["assigned-only wildcard", { assignedOnly: true, permissionSet: ["*"], orgPermissionSet: ["*"] }, true],
  ]
  for (const [name, overrides, allowed] of cases) {
    const decision = decide({ permission: "schedule.edit", hasProjectScope: true, ...overrides })
    assert.equal(decision.allowed, allowed, name)
    if (!allowed) assert.equal(decision.reasonCode, "deny_no_project_membership", name)
  }
})

test("someone who is not a member of the org is refused as such", () => {
  const decision = decide({ hasOrgMembership: false })
  assert.equal(decision.allowed, false)
  assert.equal(decision.reasonCode, "deny_no_org_membership")
})

test("the last admin cannot be demoted", () => {
  for (const [input, strands] of [
    [{ adminMembershipIds: ["m1"], membershipId: "m1", staysAdmin: false }, true],
    [{ adminMembershipIds: ["m1", "m2"], membershipId: "m1", staysAdmin: false }, false],
    [{ adminMembershipIds: ["m1"], membershipId: "m1", staysAdmin: true }, false],
    [{ adminMembershipIds: ["m1"], membershipId: "m2", staysAdmin: false }, false],
  ]) {
    assert.equal(wouldStrandOrgWithoutAdmin(input), strands, JSON.stringify(input))
  }
})

test("division-scoped reads never widen membership authorization", () => {
  assert.deepEqual(intersectProjectReadScopes(["home-a", "home-b"], ["home-b", "home-c"]), ["home-b"])
  assert.deepEqual(intersectProjectReadScopes([], ["home-a"]), [])
  assert.deepEqual(intersectProjectReadScopes(["home-a"], null), ["home-a"])
  assert.deepEqual(intersectProjectReadScopes(null, ["home-b"]), ["home-b"])
  assert.equal(intersectProjectReadScopes(null, null), null)
})

test("a purchasing manager holding the baseline reads reaches projects it is not a member of", () => {
  const purchasing = ["org.member", "org.read", "project.read", "price_book.read", "po.generate"]
  const projectCheck = (overrides = {}) =>
    decide({ permission: "price_book.read", hasProjectScope: true, permissionSet: purchasing, orgPermissionSet: purchasing, ...overrides })

  assert.equal(projectCheck().allowed, true)
  // The pre-fix role: purchasing keys only, no project.read, so a non-member project check denied.
  const before = ["price_book.read", "po.generate"]
  const denied = projectCheck({ permissionSet: before, orgPermissionSet: before })
  assert.equal(denied.allowed, false)
  assert.equal(denied.reasonCode, "deny_no_project_membership")
})

// ── The workspace surface bounds every decision (service tier) ───────────────
// A trade company holding a builder permission through its role still cannot use
// it; a builder org holding the same key can. Real authorization service over the
// in-memory database: the surface is read from org_settings, as in production.
const { createServiceHarness, id, ORG, ACTOR } = require("./support/service")
const { freshRequire } = require("./support/modules")

const authorization = freshRequire("lib/services/authorization.ts")
const SURFACE_PROJECT = id(77)
const TRADE_SETTINGS = [{ org_id: ORG, settings: { business_profile: { kind: "trade", specialty: "Electrical" } } }]

const surfaceOrg = ({ trade, permissions = ["sales.read", "invoice.read"] }) =>
  createServiceHarness({
    permissions,
    tables: {
      org_settings: trade ? TRADE_SETTINGS : [],
      projects: [{ id: SURFACE_PROJECT, org_id: ORG, division_id: null }],
    },
  })

test("authorize refuses a trade company a builder permission its role holds, and says why", async () => {
  const trade = surfaceOrg({ trade: true })
  const refused = await trade.run(() => authorization.authorize({ permission: "sales.read", userId: ACTOR, orgId: ORG }))
  assert.equal(refused.allowed, false)
  assert.equal(refused.reasonCode, "deny_workspace_surface")
  assert.equal(refused.surfaceRefusal, "Sales isn't part of Arc Trade.")

  const kept = await trade.run(() => authorization.authorize({ permission: "invoice.read", userId: ACTOR, orgId: ORG }))
  assert.equal(kept.allowed, true)

  const builder = surfaceOrg({ trade: false })
  const open = await builder.run(() => authorization.authorize({ permission: "sales.read", userId: ACTOR, orgId: ORG }))
  assert.equal(open.allowed, true)
})

test("a trade company's effective permissions drop the builder keys, and a wildcard survives", async () => {
  const trade = surfaceOrg({ trade: true, permissions: ["sales.read", "po.read", "invoice.read", "schedule.read"] })
  const held = await trade.run(() => authorization.getEffectiveOrgPermissions(ORG, ACTOR))
  assert.deepEqual([...held].sort(), ["invoice.read", "schedule.read"])

  const builder = surfaceOrg({ trade: false, permissions: ["sales.read", "invoice.read"] })
  assert.deepEqual([...(await builder.run(() => authorization.getEffectiveOrgPermissions(ORG, ACTOR)))].sort(), ["invoice.read", "sales.read"])

  const admin = surfaceOrg({ trade: true, permissions: ["*"] })
  assert.deepEqual(await admin.run(() => authorization.getEffectiveOrgPermissions(ORG, ACTOR)), ["*"])
})

test("authorizeMany refuses every project for a builder permission on a trade surface and answers a builder normally", async () => {
  const trade = surfaceOrg({ trade: true, permissions: ["sales.read", "project.read"] })
  const refused = await trade.run(() => authorization.authorizeMany({ permission: "sales.read", userId: ACTOR, orgId: ORG, projectIds: [SURFACE_PROJECT] }))
  assert.equal(refused.get(SURFACE_PROJECT), false)

  const builder = surfaceOrg({ trade: false, permissions: ["sales.read", "project.read"] })
  const open = await builder.run(() => authorization.authorizeMany({ permission: "sales.read", userId: ACTOR, orgId: ORG, projectIds: [SURFACE_PROJECT] }))
  assert.equal(open.get(SURFACE_PROJECT), true)
})
