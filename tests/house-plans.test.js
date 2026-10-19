const assert = require("node:assert/strict")
const { test } = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire } = require("./support/modules")

const { getPlanLadder } = freshRequire("lib/services/house-plans.ts")

const COMMUNITY = id(1)
const LAST_PLAN = id(10519)
const RELEASED = id(2)

const plan = (n) => ({
  id: id(10000 + n),
  org_id: ORG,
  code: String(n).padStart(4, "0"),
  name: `Plan ${n}`,
  status: "active",
  division_id: null,
  cover_file_id: null,
})

test("the plan ladder covers a 520-plan library, aggregates included", async () => {
  const service = createServiceHarness({
    permissions: ["plan.read"],
    tables: {
      house_plans: Array.from({ length: 520 }, (_, n) => plan(n)),
      // The last plan sits on the second page of the library read.
      house_plan_versions: [
        { id: RELEASED, org_id: ORG, house_plan_id: LAST_PLAN, version_number: 3, status: "released" },
      ],
      community_plan_availability: [
        { org_id: ORG, house_plan_id: LAST_PLAN, community_id: COMMUNITY, base_price_cents: 45000000, is_available: true },
      ],
    },
  })

  const ladder = await service.run(() => getPlanLadder())

  assert.equal(ladder.rungs.length, 520)
  assert.equal(new Set(ladder.rungs.map((rung) => rung.id)).size, 520)
  const last = ladder.rungs.at(-1)
  assert.equal(last.id, LAST_PLAN)
  assert.equal(last.released_version_number, 3)
  assert.equal(last.base_price_min_cents, 45000000)
  assert.deepEqual(last.community_ids, [COMMUNITY])
})
