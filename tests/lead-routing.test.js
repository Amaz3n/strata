require("../scripts/register-ts-node-test")

/**
 * `lib/sales/lead-routing.ts` — who a new website lead belongs to.
 */

const assert = require("node:assert/strict")
const test = require("node:test")

const { routeLead } = require("../lib/sales/lead-routing.ts")

const COMMUNITY = "community-1"
const PAT = "pat"
const SAM = "sam"
const OSC = "osc"
const FALLBACK = "fallback"

function route(overrides = {}) {
  return routeLead({
    lead: { sourceId: "website", communityId: COMMUNITY, divisionId: "gulf", utmSource: "google", utmCampaign: "spring", ...overrides.lead },
    rules: [],
    communityAssignees: [
      { userId: PAT, lastAssignedAt: "2026-10-10T12:00:00Z" },
      { userId: SAM, lastAssignedAt: "2026-10-01T12:00:00Z" },
    ],
    divisionDefaultUserId: FALLBACK,
    sourceDefaultUserId: null,
    eligibleUserIds: new Set([PAT, SAM, OSC, FALLBACK]),
    ...overrides,
  })
}

function rule(overrides) {
  return { id: "r1", name: "Zillow to the OSC", priority: 100, createdAt: "2026-09-01T00:00:00Z", isActive: true, sourceId: null, communityId: null, divisionId: null, utmSource: null, utmCampaign: null, assignedUserId: OSC, ...overrides }
}

test("the community's consultant who least recently got a lead takes the next one", () => {
  assert.equal(route().ownerUserId, SAM)
  assert.equal(route().outcome, "community_assignee")
  const neverAssigned = route({ communityAssignees: [{ userId: PAT, lastAssignedAt: "2026-10-10T12:00:00Z" }, { userId: SAM, lastAssignedAt: null }] })
  assert.equal(neverAssigned.ownerUserId, SAM)
})

test("a matching rule wins over the rotation, and a rule that does not match is ignored", () => {
  assert.deepEqual(
    [route({ rules: [rule({ utmSource: "Zillow" })], lead: { utmSource: "zillow" } }).ownerUserId, route({ rules: [rule({ utmSource: "Zillow" })] }).ownerUserId],
    [OSC, SAM],
  )
  const ordered = route({ rules: [rule({ id: "late", priority: 200, assignedUserId: PAT, utmCampaign: "spring" }), rule({ utmCampaign: "SPRING" })] })
  assert.equal(ordered.ownerUserId, OSC, "lower priority first")
  assert.equal(route({ rules: [rule({ utmCampaign: "spring", isActive: false })] }).ownerUserId, SAM)
})

test("someone who cannot take the lead is skipped, and the reason says so", () => {
  const decision = route({ eligibleUserIds: new Set([PAT, FALLBACK]) })
  assert.equal(decision.ownerUserId, PAT)
  assert.match(decision.reason, /1 candidate skipped/)
})

test("with no consultant the division's fallback, then the source's default, then nobody", () => {
  assert.deepEqual(
    [route({ communityAssignees: [] }).outcome, route({ communityAssignees: [] }).ownerUserId],
    ["division_default", FALLBACK],
  )
  const sourceDefault = route({ communityAssignees: [], divisionDefaultUserId: null, sourceDefaultUserId: OSC })
  assert.deepEqual([sourceDefault.outcome, sourceDefault.ownerUserId], ["source_default", OSC])
  const nobody = route({ communityAssignees: [], divisionDefaultUserId: FALLBACK, eligibleUserIds: new Set() })
  assert.deepEqual([nobody.outcome, nobody.ownerUserId], ["unrouted", null])
  assert.equal(route({ lead: { communityId: null } }).outcome, "division_default", "a lead with no community skips the rotation")
})

test("the rotation hands filing every eligible consultant in turn order, so it can re-take the turn under a lock", () => {
  assert.deepEqual(route().rotation, [SAM, PAT])
  assert.deepEqual(route({ eligibleUserIds: new Set([PAT, FALLBACK]) }).rotation, [PAT])
  assert.deepEqual(route({ rules: [rule({})] }).rotation, [], "a rule's owner is not a turn")
  assert.deepEqual(route({ communityAssignees: [] }).rotation, [])
})
