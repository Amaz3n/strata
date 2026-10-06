const assert = require("node:assert/strict")
const test = require("node:test")

const { createFakeSupabase } = require("./support/fake-supabase")
const { stubModule, freshRequire } = require("./support/modules")

const ORG = "00000000-0000-4000-8000-000000000201"
const OTHER_ORG = "00000000-0000-4000-8000-000000000202"
const USER = "00000000-0000-4000-8000-000000000203"
const NORTH = "00000000-0000-4000-8000-000000000204"
const SOUTH = "00000000-0000-4000-8000-000000000205"

/** What the signed-in member may do: their grants and their division assignment. */
const member = { permissions: [], scope: { assignedOnly: false, divisionIds: [] } }

stubModule("@/lib/supabase/server", {
  createServiceSupabaseClient: () => {
    throw new Error("community reads must use the caller's client")
  },
})
stubModule("@/lib/services/permissions", {
  requirePermission: async (permission) => {
    if (!member.permissions.includes(permission)) throw new Error(`Missing permission: ${permission}`)
  },
})
stubModule("@/lib/services/authorization", { getDivisionAccessForUser: async () => member.scope })

const { runWithServiceOrgContext } = freshRequire("lib/services/context.ts")
const { getCommunityIdentity } = freshRequire("lib/services/communities.ts")

function community(id, overrides = {}) {
  return {
    id,
    org_id: ORG,
    name: `Community ${id.slice(-3)}`,
    status: "active",
    planned_lot_count: 40,
    division_id: NORTH,
    archived_at: null,
    ...overrides,
  }
}

const NORTH_COMMUNITY = "00000000-0000-4000-8000-000000000301"
const SOUTH_COMMUNITY = "00000000-0000-4000-8000-000000000302"
const ARCHIVED_COMMUNITY = "00000000-0000-4000-8000-000000000303"
const FOREIGN_COMMUNITY = "00000000-0000-4000-8000-000000000304"

/** Reads one community's identity as the member, against a fresh database. */
function readIdentity(id) {
  const supabase = createFakeSupabase({
    communities: [
      community(NORTH_COMMUNITY),
      community(SOUTH_COMMUNITY, { division_id: SOUTH }),
      community(ARCHIVED_COMMUNITY, { archived_at: "2026-01-01T00:00:00Z" }),
      community(FOREIGN_COMMUNITY, { org_id: OTHER_ORG }),
    ],
  })
  return runWithServiceOrgContext(
    { supabase, orgId: ORG, userId: USER, productTier: "production" },
    () => getCommunityIdentity(id),
  )
}

test.beforeEach(() => {
  member.permissions = ["community.read"]
  member.scope = { assignedOnly: false, divisionIds: [] }
})

test("a community's identity is its name, status and planned lot count", async () => {
  assert.deepEqual(await readIdentity(NORTH_COMMUNITY), {
    id: NORTH_COMMUNITY,
    name: "Community 301",
    status: "active",
    plannedLotCount: 40,
  })
})

test("archived communities and another organization's communities are not found", async () => {
  await assert.rejects(readIdentity(ARCHIVED_COMMUNITY), /Community not found/)
  await assert.rejects(readIdentity(FOREIGN_COMMUNITY), /Community not found/)
})

test("a division-scoped member cannot read a community outside their divisions", async () => {
  member.scope = { assignedOnly: true, divisionIds: [NORTH] }

  assert.equal((await readIdentity(NORTH_COMMUNITY)).id, NORTH_COMMUNITY)
  await assert.rejects(readIdentity(SOUTH_COMMUNITY), /Community not found/)
})

test("a member assigned to no division sees no community at all", async () => {
  member.scope = { assignedOnly: true, divisionIds: [] }

  await assert.rejects(readIdentity(NORTH_COMMUNITY), /Community not found/)
})

test("a member without community access is refused", async () => {
  member.permissions = []

  await assert.rejects(readIdentity(NORTH_COMMUNITY), /Missing permission: community.read/)
})
