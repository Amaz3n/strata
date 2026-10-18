const assert = require("node:assert/strict")
const { test } = require("node:test")

const { createServiceHarness, id } = require("./support/service")
const { freshRequire, stubModule } = require("./support/modules")

const OWN_DIVISION = id(10)
const OWN_COMMUNITY = id(20)
const FOREIGN_COMMUNITY = id(21)

const ownCommunity = { id: OWN_COMMUNITY, name: "Maple Ridge", divisionId: OWN_DIVISION, assigned: true }
// The lens the signed-in user is standing in: a cookie or assignment default.
let ambientCommunityId

stubModule("@/lib/services/desk-context", {
  getAmbientDeskContext: async () => ({
    divisionId: OWN_DIVISION,
    communityId: ambientCommunityId,
    communities: [ownCommunity],
    pinnableCommunities: [ownCommunity],
  }),
})
stubModule("@/lib/services/reporting-scope", {
  getCommunityProjectIds: async () => [id(30)],
  getDivisionProjectIds: async () => [id(30), id(31)],
  getReportingExcludedProjectIds: async () => [],
})

const { resolveProductionDeskScope } = freshRequire("lib/services/production-desk-scope.ts")
const { getStartsDesk } = freshRequire("lib/services/starts-desk.ts")

test("a community the caller may not pin empties the desk instead of widening it to the division", async () => {
  const service = createServiceHarness()

  const refused = await service.run(() => resolveProductionDeskScope({ communityId: FOREIGN_COMMUNITY }))
  assert.deepEqual(refused.projectIds, [])
  assert.equal(refused.refused, true)

  const own = await service.run(() => resolveProductionDeskScope({ communityId: OWN_COMMUNITY }))
  assert.deepEqual(own.projectIds, [id(30)])
  assert.equal(own.refused, false)
})

test("an ambient lens the caller may not pin is refused, and an authorized one narrows to its community", async () => {
  const service = createServiceHarness()

  ambientCommunityId = FOREIGN_COMMUNITY
  const stale = await service.run(() => resolveProductionDeskScope({}))
  assert.equal(stale.refused, true)
  assert.deepEqual(stale.projectIds, [])

  ambientCommunityId = OWN_COMMUNITY
  const narrowed = await service.run(() => resolveProductionDeskScope({}))
  assert.equal(narrowed.refused, false)
  assert.equal(narrowed.communityId, OWN_COMMUNITY)
  assert.deepEqual(narrowed.projectIds, [id(30)])

  ambientCommunityId = undefined
  const open = await service.run(() => resolveProductionDeskScope({}))
  assert.deepEqual(open.projectIds, [id(30), id(31)])
})

test("the starts desk draws nothing for a refused scope", async () => {
  const service = createServiceHarness({ permissions: ["start.write"] })
  ambientCommunityId = undefined
  const scope = await service.run(() => resolveProductionDeskScope({ communityId: FOREIGN_COMMUNITY }))
  const desk = await service.run(() => getStartsDesk({ communityId: scope.communityId, divisionId: scope.divisionId, refused: scope.refused }))
  assert.deepEqual(desk.weeks, [])
  assert.deepEqual(desk.packages, [])
  assert.deepEqual(desk.candidates, [])
})
