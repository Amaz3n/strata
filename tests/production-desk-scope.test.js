const assert = require("node:assert/strict")
const { test } = require("node:test")

const { createServiceHarness, id } = require("./support/service")
const { freshRequire, stubModule } = require("./support/modules")

const OWN_DIVISION = id(10)
const OWN_COMMUNITY = id(20)
const FOREIGN_COMMUNITY = id(21)

stubModule("@/lib/services/desk-context", {
  getAmbientDeskContext: async () => ({
    divisionId: OWN_DIVISION,
    communityId: undefined,
    pinnableCommunities: [{ id: OWN_COMMUNITY, name: "Maple Ridge", divisionId: OWN_DIVISION, assigned: true }],
  }),
})
stubModule("@/lib/services/reporting-scope", {
  getCommunityProjectIds: async () => [id(30)],
  getDivisionProjectIds: async () => [id(30), id(31)],
  getReportingExcludedProjectIds: async () => [],
})

const { resolveProductionDeskScope } = freshRequire("lib/services/production-desk-scope.ts")

test("a community the caller may not pin empties the desk instead of widening it to the division", async () => {
  const service = createServiceHarness()

  const refused = await service.run(() => resolveProductionDeskScope({ communityId: FOREIGN_COMMUNITY }))
  assert.deepEqual(refused.projectIds, [])
  assert.equal(refused.refused, true)

  const own = await service.run(() => resolveProductionDeskScope({ communityId: OWN_COMMUNITY }))
  assert.deepEqual(own.projectIds, [id(30)])
  assert.equal(own.refused, false)
})
