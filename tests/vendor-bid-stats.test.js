"use strict"

/**
 * A vendor's bid track record (`getVendorBidStats`, lib/services/bid-intelligence.ts):
 * invitations, responses, awards and change-order growth. Counted from every
 * page of history, only from work the viewer's divisions may see, and refused
 * outright when any part of that history cannot be read or does not add up.
 */

const assert = require("node:assert/strict")
const test = require("node:test")

const { createServiceHarness, replies, id, ORG } = require("./support/service")
const { supportPostgrestFilters } = require("./support/billing")
const { freshRequire } = require("./support/modules")

const { getVendorBidStats } = freshRequire("lib/services/bid-intelligence.ts")

const VENDOR = id(1)
const ASSIGNED = id(2)
const OTHER_DIVISION = id(3)

/**
 * One vendor's history. `count` invitations (alternately submitted and
 * declined) and as many approved change orders of `signedChange` cents on one
 * awarded commitment of `total` cents; a cancelled award is always present.
 */
function history({
  count = 1,
  distinctPackages = false,
  hidden = false,
  missingPackage = false,
  signedChange = 10,
  total = 100,
  production = false,
  missingAward = false,
} = {}) {
  const packageId = (n) => (distinctPackages ? `package-${n}` : "package")
  const tables = {
    bid_invites: Array.from({ length: count }, (_, n) => ({
      id: `invite-${String(n).padStart(5, "0")}`,
      org_id: ORG,
      company_id: VENDOR,
      bid_package_id: packageId(n),
      status: n % 2 ? "declined" : "submitted",
    })),
    bid_packages: missingPackage
      ? []
      : [...new Set(Array.from({ length: count }, (_, n) => packageId(n)))].map((packageKey) => ({
          id: packageKey,
          org_id: ORG,
          community_id: "community",
          house_plan_id: "plan",
          project_id: null,
        })),
    communities: [{ id: "community", org_id: ORG, division_id: hidden ? OTHER_DIVISION : ASSIGNED }],
    house_plans: [{ id: "plan", org_id: ORG, division_id: null }],
    projects: [{ id: "project", org_id: ORG, division_id: hidden ? OTHER_DIVISION : ASSIGNED }],
    commitments: [
      { id: "commitment", org_id: ORG, project_id: "project", company_id: VENDOR, total_cents: total, status: "approved", metadata: { source: "bid_award" } },
      { id: "canceled", org_id: ORG, project_id: "project", company_id: VENDOR, total_cents: 999, status: "canceled", metadata: { source: "bid_award" } },
    ],
    commitment_change_orders: Array.from({ length: count }, (_, n) => ({
      id: `co-${String(n).padStart(5, "0")}`,
      org_id: ORG,
      commitment_id: "commitment",
      total_cents: signedChange,
      status: "approved",
    })),
    vendor_price_agreements: [],
    bid_awards: [],
  }
  if (production) {
    // One award priced as 1,001 agreement rows, one rescinded award, and one
    // award on a package in a division the viewer cannot see.
    tables.vendor_price_agreements = [
      ...Array.from({ length: 1001 }, (_, n) => ({ id: `agreement-${String(n).padStart(5, "0")}`, org_id: ORG, company_id: VENDOR, source_bid_award_id: "award" })),
      { id: "rescinded-agreement", org_id: ORG, company_id: VENDOR, source_bid_award_id: "rescinded" },
      { id: "hidden-agreement", org_id: ORG, company_id: VENDOR, source_bid_award_id: "hidden-award" },
    ]
    tables.bid_awards = [
      { id: "award", org_id: ORG, bid_package_id: "package", rescinded_at: null },
      { id: "rescinded", org_id: ORG, bid_package_id: "package", rescinded_at: "2026-01-01" },
      { id: "hidden-award", org_id: ORG, bid_package_id: "hidden-package", rescinded_at: null },
    ].filter((row) => !missingAward || row.id !== "award")
    tables.bid_packages.push({ id: "hidden-package", org_id: ORG, project_id: null, community_id: "hidden-community", house_plan_id: null })
    tables.communities.push({ id: "hidden-community", org_id: ORG, division_id: OTHER_DIVISION })
  }
  return tables
}

function setup(tables, { permissions = ["bid.read"], scoped = true } = {}) {
  return supportPostgrestFilters(
    createServiceHarness({ permissions, divisions: scoped ? [ASSIGNED] : undefined, maxRows: 500, tables }),
  )
}

const statsFor = async (service, ids = [VENDOR]) => (await service.run(() => getVendorBidStats(ids))).get(VENDOR)

test("a vendor's history is refused without bid access, before any history is read", async () => {
  const service = setup(history(), { permissions: [] })
  await assert.rejects(service.run(() => getVendorBidStats([VENDOR])), /Missing permission: bid.read/)
  assert.equal(service.reads("bid_invites").length, 0)
})

test("activity outside the viewer's divisions is not counted", async () => {
  const service = setup(history({ hidden: true }))
  const stats = await statsFor(service)

  assert.equal(stats.invited_count, 0)
  assert.equal(stats.awarded_count, 0)
  assert.equal(stats.change_order_growth_pct, null)
  assert.equal(service.reads("commitment_change_orders").length, 0)
})

test("an organization-wide plan-only package is not counted for a division-limited viewer, but is for an unrestricted one", async () => {
  const planOnly = () => {
    const tables = history()
    tables.bid_packages = tables.bid_packages.map((row) => ({ ...row, community_id: null }))
    return tables
  }

  assert.equal((await statsFor(setup(planOnly()))).invited_count, 0)
  assert.equal((await statsFor(setup(planOnly(), { scoped: false }))).invited_count, 1)
})

test("counts and growth include every page and leave out cancelled awards", async () => {
  const service = setup(history({ count: 1001, distinctPackages: true }))
  const stats = await statsFor(service, [VENDOR, VENDOR])

  assert.equal(stats.invited_count, 1001)
  assert.equal(stats.submitted_count, 501)
  assert.equal(stats.declined_count, 500)
  assert.equal(stats.awarded_count, 1)
  // 1,001 change orders of 10 cents on a 100-cent award.
  assert.equal(stats.change_order_growth_pct, 10010)
})

test("history that cannot be read completely, or does not add up, refuses the whole answer", async () => {
  const tables = [
    "bid_invites",
    "commitments",
    "vendor_price_agreements",
    "bid_packages",
    "communities",
    "house_plans",
    "projects",
    "commitment_change_orders",
  ]
  for (const table of tables) {
    const service = setup(history())
    service.tamper(table, replies.error("offline"))
    await assert.rejects(statsFor(service), /offline/, table)
  }
  await assert.rejects(statsFor(setup(history({ missingPackage: true }))), /missing packages/)
  for (const total of [null, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(statsFor(setup(history({ total }))), /invalid monetary/, String(total))
  }
})

test("growth reports credits as negative, has no answer on a zero base, and malformed vendor ids are refused", async () => {
  assert.equal((await statsFor(setup(history({ signedChange: -10 })))).change_order_growth_pct, -10)
  assert.equal((await statsFor(setup(history({ total: 0 })))).change_order_growth_pct, null)

  const service = setup(history())
  await assert.rejects(service.run(() => getVendorBidStats(["bad"])))
  assert.equal(service.reads("bid_invites").length, 0)
})

test("production experience counts each visible, standing award once, not its agreement rows", async () => {
  const scoped = await statsFor(setup(history({ production: true })))
  assert.equal(scoped.production_awarded_count, 1)
  assert.equal(scoped.awarded_count, 1)

  const orgWide = await statsFor(setup(history({ production: true }), { scoped: false }))
  assert.equal(orgWide.production_awarded_count, 2)

  await assert.rejects(statsFor(setup(history({ production: true, missingAward: true }))), /missing awards/)
  const failing = setup(history({ production: true }))
  failing.tamper("bid_awards", replies.error("offline"))
  await assert.rejects(statsFor(failing), /offline/)
})
