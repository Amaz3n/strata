"use strict"

/**
 * `lib/services/bid-intelligence.ts` — the comparisons a buyer reads before an
 * award: how the bids on one package sit around their median, and how the
 * org's past awards on a cost code landed against budget. Both are money read
 * across many rows, so both must read every page, refuse a partial answer, and
 * never let a division-scoped user see an award or a bid outside their scope.
 */

const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness, replies, id, ORG } = require("./support/service")
const { freshRequire } = require("./support/modules")

const { getCostCodeBidHistory, getPackageIntelligence } = freshRequire("lib/services/bid-intelligence.ts")

const PACKAGE = id(1)
const PROJECT = id(2)
const COST_CODE = id(4)
const COMMUNITY = id(5)
const DIVISION = id(6)
const OTHER_DIVISION = id(7)

const READER = ["bid.read", "org.member"]

/** Answers a paged read from `rows` by the query's range, as PostgREST would. */
const paged = (rows) => (result, query) => {
  const [from, to] = query.rangeValue ?? [0, rows.length - 1]
  return { ...result, data: structuredClone(rows.slice(from, to + 1)) }
}

describe("getPackageIntelligence", () => {
  function submission(n, total, submittedAt = "2026-01-01T00:00:00Z") {
    return {
      id: id(1000 + n),
      org_id: ORG,
      total_cents: total,
      submitted_at: submittedAt,
      is_current: true,
      status: "submitted",
      invite: { bid_package_id: PACKAGE },
    }
  }

  function harness({ submissions = [], addenda = [], permissions = READER, divisions } = {}) {
    return createServiceHarness({
      tables: {
        bid_packages: [{ id: PACKAGE, org_id: ORG, project_id: PROJECT, title: "Framing", mode: "simple", status: "open" }],
        projects: [{ id: PROJECT, org_id: ORG, phase: "delivery", division_id: OTHER_DIVISION }],
        bid_submissions: submissions,
        bid_addenda: addenda.map((issuedAt) => ({ org_id: ORG, bid_package_id: PACKAGE, issued_at: issuedAt })),
      },
      permissions,
      divisions,
    })
  }

  const read = (service) => service.run(() => getPackageIntelligence(PACKAGE))

  test("no comparison data is read for a caller who cannot see bids or the package", async () => {
    for (const [options, message] of [
      [{ permissions: ["org.member"] }, /bid\.read/],
      [{ divisions: [DIVISION] }, /outside your project access/],
    ]) {
      const service = harness(options)
      await assert.rejects(read(service), message)
      assert.deepEqual(service.reads("bid_submissions"), [])
    }
  })

  test("every page counts: the median of 1,000 bids is the mean of the two middle bids", async () => {
    const submissions = Array.from({ length: 1000 }, (_, n) => submission(n, n < 500 ? 100 : 300))
    const result = await read(harness({ submissions, addenda: ["2026-01-02T00:00:00Z"] }))

    assert.equal(result.sample_size, 1000)
    assert.equal(result.median_cents, 200)
    assert.equal(result.spread_pct, 200)
    const high = result.signals.find((signal) => signal.total_cents === 300)
    const low = result.signals.find((signal) => signal.total_cents === 100)
    assert.equal(high.deviation_from_median_pct, 50)
    assert.equal(low.is_low_outlier, true)
    assert.equal(low.is_stale_vs_addenda, true, "submitted before the latest addendum")
  })

  test("bids on another package, superseded bids and unpriced bids are not compared", async () => {
    const result = await read(
      harness({
        submissions: [
          submission(1, 100),
          { ...submission(2, 900), invite: { bid_package_id: id(99) } },
          { ...submission(3, 900), is_current: false },
          { ...submission(4, 900), status: "withdrawn" },
          { ...submission(5, null) },
        ],
      }),
    )
    assert.equal(result.sample_size, 1)
    assert.equal(result.median_cents, 100)
  })

  test("a package with no bids has no median", async () => {
    const result = await read(harness())
    assert.equal(result.median_cents, null)
    assert.deepEqual(result.signals, [])
  })

  test("a partial read, an addenda failure or a bid total that is not cents fails the comparison", async () => {
    const partial = harness({ submissions: Array.from({ length: 501 }, (_, n) => submission(n, 100)) })
    partial.tamper("bid_submissions", (result, query) =>
      query.rangeValue?.[0] > 0 ? replies.error("offline")(result) : result,
    )
    await assert.rejects(read(partial), /offline/)

    const addenda = harness()
    addenda.tamper("bid_addenda", replies.error("offline"))
    await assert.rejects(read(addenda), /offline/)

    for (const total of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(read(harness({ submissions: [submission(1, total)] })), /invalid/, String(total))
    }
  })
})

describe("getCostCodeBidHistory", () => {
  /** An award on its own project, with a commitment and a budget line behind it. */
  function award(n, { pkg = {} } = {}) {
    return {
      id: id(2000 + n),
      awarded_commitment_id: id(3000 + n),
      package: {
        id: id(4000 + n),
        project_id: id(5000 + n),
        community_id: null,
        community: null,
        house_plan_id: null,
        plan: null,
        budget_line_id: id(6000 + n),
        ...pkg,
      },
    }
  }

  /**
   * `count` awards on COST_CODE; commitments alternate 100 / 300 cents against
   * a 200-cent budget line. The award list is the embedded join PostgREST
   * resolves (packages, communities, plans), so it is answered page by page.
   */
  function harness({ count = 2, awards, permissions = READER, divisions, projectDivision = DIVISION } = {}) {
    const list = awards ?? Array.from({ length: count }, (_, n) => award(n))
    const service = createServiceHarness({
      tables: {
        bid_awards: [],
        projects: list.map((row) => ({ id: row.package.project_id, org_id: ORG, division_id: projectDivision })),
        commitments: list.map((row, n) => ({ id: row.awarded_commitment_id, org_id: ORG, total_cents: n % 2 ? 300 : 100 })),
        budget_lines: list.map((row) => ({ id: row.package.budget_line_id, org_id: ORG, amount_cents: 200 })),
      },
      permissions,
      divisions,
      // PostgREST's response cap: an id list over one batch would come back short.
      maxRows: 100,
    })
    service.tamper("bid_awards", paged(list))
    return service
  }

  const read = (service) => service.run(() => getCostCodeBidHistory(COST_CODE))

  test("every award is read and amounts are batched under the response cap", async () => {
    const result = await read(harness({ count: 1002 }))
    assert.deepEqual(result, {
      cost_code_id: COST_CODE,
      award_count: 1002,
      median_bid_to_budget_pct: 100,
      min_award_cents: 100,
      max_award_cents: 300,
    })
  })

  test("a caller without bid.read is refused before any history is read", async () => {
    const service = harness({ permissions: ["org.member"] })
    await assert.rejects(read(service), /bid\.read/)
    assert.deepEqual(service.reads("bid_awards"), [])
  })

  test("a division-scoped caller with no divisions sees no history and reads none", async () => {
    const service = harness({ divisions: [] })
    assert.equal((await read(service)).award_count, 0)
    assert.deepEqual(service.reads("bid_awards"), [])
  })

  test("awards whose project or community is outside the caller's divisions are excluded before amounts are read", async () => {
    for (const options of [
      { divisions: [DIVISION], projectDivision: OTHER_DIVISION },
      { divisions: [DIVISION], awards: [award(0, { pkg: { project_id: null, community_id: COMMUNITY, community: null } })] },
    ]) {
      const service = harness(options)
      assert.equal((await read(service)).award_count, 0)
      assert.deepEqual([...service.reads("commitments"), ...service.reads("budget_lines")], [])
    }
  })

  test("awards on visible projects count for a division-scoped caller", async () => {
    assert.equal((await read(harness({ divisions: [DIVISION] }))).award_count, 2)
  })

  test("a failed read or a missing referenced amount fails instead of reporting less history", async () => {
    for (const table of ["bid_awards", "projects", "commitments", "budget_lines"]) {
      const service = harness()
      service.tamper(table, replies.error("offline"))
      await assert.rejects(read(service), /offline/, table)
    }
    const missing = harness()
    missing.db.commitments.pop()
    await assert.rejects(read(missing), /missing amounts/)
  })
})
