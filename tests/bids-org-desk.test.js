const assert = require("node:assert/strict")
const { test } = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire } = require("./support/modules")

// `listOrgBidPackages` from lib/services/bids.ts — the org Bids desk.
// Belongs in tests/bids.test.js; kept apart while that suite is being rewritten.
const { listOrgBidPackages } = freshRequire("lib/services/bids.ts")

const DIVISION = id(1)
const OTHER_DIVISION = id(2)
const ALLOWED_PROJECT = id(3)
const OTHER_PROJECT = id(4)
const VISIBLE = id(5)
const ORG_WIDE = id(6)

const bidPackage = (packageId, projectId, dueAt) => ({
  id: packageId,
  org_id: ORG,
  project_id: projectId,
  name: `Package ${dueAt}`,
  status: "open",
  due_at: new Date(Date.UTC(2026, 0, 1, 0, dueAt)).toISOString(),
})

test("a division-scoped desk finds its packages behind 600 out-of-scope ones", async () => {
  const service = createServiceHarness({
    permissions: ["org.read"],
    divisions: [DIVISION],
    // PostgREST caps each response; scoping after the read would see only the 600.
    maxRows: 500,
    tables: {
      projects: [
        { id: ALLOWED_PROJECT, org_id: ORG, division_id: DIVISION, name: "Visible project" },
        { id: OTHER_PROJECT, org_id: ORG, division_id: OTHER_DIVISION, name: "Hidden project" },
      ],
      communities: [],
      bid_packages: [
        ...Array.from({ length: 600 }, (_, n) => bidPackage(id(1000 + n), OTHER_PROJECT, n)),
        bidPackage(VISIBLE, ALLOWED_PROJECT, 900),
        bidPackage(ORG_WIDE, null, 901),
      ],
    },
  })

  for (const divisionId of [DIVISION, undefined]) {
    const packages = await service.run(() => listOrgBidPackages(undefined, divisionId))
    assert.deepEqual(packages.map((row) => row.id), [VISIBLE, ORG_WIDE])
  }
})
