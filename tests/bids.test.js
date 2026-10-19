"use strict"

/**
 * `lib/services/bids.ts` — quote requests to trades: which job a package
 * belongs to, lining trades up and sending, addendum notices, and who may
 * touch a bid's sub-records (invites, links, submissions, leveling cells,
 * RFI answers). Access to every sub-record follows its package: a
 * division-scoped user is refused anything on a community or project outside
 * their divisions before a single write.
 */

const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness, replies, id, ORG } = require("./support/service")
const { freshRequire } = require("./support/modules")

// Bid links are HMAC'd with this secret; any value works for a test.
process.env.BID_PORTAL_SECRET ??= "test-bid-portal-secret"

const bids = freshRequire("lib/services/bids.ts")

const FOREIGN_ORG = id(1)
const PACKAGE = id(2)
const INVITE = id(3)
const SUBMISSION = id(4)
const ITEM = id(5)
const RFI = id(6)
const COMMUNITY = id(7)
const DIVISION = id(8)
const OTHER_DIVISION = id(9)
const PROJECT = id(10)
const PROSPECT = id(11)
const COMPANY = id(12)
const ADDENDUM = id(13)

const SEEN = "2026-10-01T12:00:00+00:00"
const FUTURE = new Date(Date.now() + 86_400_000).toISOString()
const PAST = new Date(Date.now() - 86_400_000).toISOString()

const MANAGER = ["project.manage", "bid.write", "org.member"]

function bidPackage(overrides = {}) {
  return {
    id: PACKAGE,
    org_id: ORG,
    project_id: null,
    prospect_id: PROSPECT,
    community_id: null,
    house_plan_id: null,
    award_target: "commitment",
    title: "Electrical",
    trade: "Electrical",
    mode: "quote",
    status: "draft",
    due_at: FUTURE,
    bond_required: false,
    created_at: SEEN,
    ...overrides,
  }
}

/** Trade `n` on the package, with the company PostgREST would embed. */
function invite(n, overrides = {}) {
  return {
    id: id(100 + n),
    org_id: ORG,
    bid_package_id: PACKAGE,
    company_id: id(200 + n),
    contact_id: null,
    invite_email: null,
    status: "draft",
    company: { id: id(200 + n), name: `Trade ${n}`, email: `trade${n}@example.test` },
    contact: null,
    ...overrides,
  }
}

function harness({ tables = {}, permissions = MANAGER, divisions, rpc } = {}) {
  const service = createServiceHarness({
    rpc,
    tables: {
      orgs: [{ id: ORG, name: "Builder", logo_url: null, slug: "builder" }],
      prospects: [{ id: PROSPECT, org_id: ORG, name: "Kitchen" }],
      projects: [],
      companies: [{ id: COMPANY, org_id: ORG, name: "Sparks LLC" }],
      bid_packages: [bidPackage()],
      bid_invites: [],
      bid_access_tokens: [],
      bid_scope_items: [],
      bid_addenda: [],
      outbox: [],
      ...tables,
    },
    permissions,
    divisions,
  })
  // The outbox's `status` column defaults to pending.
  service.tamper(
    "outbox",
    (result) => {
      for (const row of service.db.outbox) row.status ??= "pending"
      return result
    },
    { on: "insert" },
  )
  return service
}

const stored = (service, table, rowId) => service.db[table].find((row) => row.id === rowId)
const eventTypes = (service) => service.events.map((event) => event.eventType)

describe("a package has exactly one parent", () => {
  const create = (service, input) => service.run(() => bids.createBidPackage({ input: { title: "Cabinets", ...input } }))
  const linkedProject = { id: PROJECT, org_id: ORG, prospect_id: PROSPECT, name: "Kitchen" }

  test("a project package is owned by the project, never also by its prospect", async () => {
    const service = harness({ tables: { bid_packages: [], projects: [linkedProject] } })
    const created = await create(service, { project_id: PROJECT })
    assert.equal(created.project_id, PROJECT)
    assert.equal(created.prospect_id, null)
  })

  test("a prospect package moves onto the prospect's project once there is one", async () => {
    for (const [projects, expected] of [
      [[linkedProject], { project_id: PROJECT, prospect_id: null }],
      [[], { project_id: null, prospect_id: PROSPECT }],
    ]) {
      const service = harness({ tables: { bid_packages: [], projects } })
      const created = await create(service, { prospect_id: PROSPECT })
      assert.deepEqual({ project_id: created.project_id, prospect_id: created.prospect_id }, expected)
    }
  })

  test("a failed linked-project lookup creates nothing rather than guessing the parent", async () => {
    const service = harness({ tables: { bid_packages: [] } })
    service.tamper("projects", replies.error("lookup failed"))
    await assert.rejects(create(service, { prospect_id: PROSPECT }), /lookup failed/)
    assert.deepEqual(service.writes(), [])
  })

  test("a price-book package on a community outside the caller's divisions is refused", async () => {
    const service = harness({
      tables: { bid_packages: [], communities: [{ id: COMMUNITY, org_id: ORG, division_id: OTHER_DIVISION }] },
      divisions: [DIVISION],
    })
    await assert.rejects(
      create(service, { community_id: COMMUNITY, title: "Framing", award_target: "price_agreement" }),
      /outside your division access/,
    )
    assert.deepEqual(service.writes(), [])
  })
})

test("a deal's pricing decisions include its own packages and its linked project's", async () => {
  const packages = [
    bidPackage({ id: id(301), prospect_id: PROSPECT }),
    bidPackage({ id: id(302), prospect_id: null, project_id: PROJECT }),
    bidPackage({ id: id(303), prospect_id: id(399) }),
  ]
  const service = harness({
    tables: {
      projects: [{ id: PROJECT, org_id: ORG, prospect_id: PROSPECT }],
      bid_packages: packages,
      bid_pricing_decisions: packages.map((pkg, n) => ({
        id: id(310 + n),
        org_id: ORG,
        bid_package_id: pkg.id,
        bid_submission_id: id(320 + n),
        scope_revision: 1,
        superseded_at: null,
      })),
      bid_submissions: packages.map((_, n) => ({ id: id(320 + n), org_id: ORG, is_current: true, status: "submitted", total_cents: 100 })),
    },
  })
  const decisions = await service.run(() => bids.listProspectPricingDecisions(PROSPECT))
  assert.deepEqual(decisions.map((decision) => decision.bid_package_id).sort(), [id(301), id(302)])
})

describe("lining trades up and sending", () => {
  const bulk = (service, inviteInput) =>
    service.run(() =>
      bids.bulkCreateBidInvites({ input: { bid_package_id: PACKAGE, invites: [inviteInput], send_emails: true } }),
    )

  test("a draft package lines a trade up without minting a link or emailing", async () => {
    const service = harness()
    const result = await bulk(service, { company_id: COMPANY })

    assert.deepEqual(result.failed, [])
    assert.equal(result.created[0].status, "draft")
    assert.equal(result.emailsSent, 0)
    assert.deepEqual(service.db.bid_access_tokens, [])
    assert.deepEqual(service.db.outbox, [])
  })

  test("a trade invited to an issued package gets its link and email at once", async () => {
    const service = harness({ tables: { bid_packages: [bidPackage({ status: "open" })] } })
    const result = await bulk(service, { company_id: COMPANY, invite_email: "bids@sparks.test" })

    assert.equal(result.created[0].status, "sent")
    assert.equal(result.emailsSent, 1)
    assert.equal(service.db.bid_access_tokens.length, 1)
    assert.deepEqual(
      service.db.outbox.map((job) => [job.payload.kind, job.payload.to]),
      [["invite", "bids@sparks.test"]],
    )
  })

  test("an invite whose email could not be queued is not counted as emailed", async () => {
    const service = harness({ tables: { bid_packages: [bidPackage({ status: "open" })] } })
    service.tamper("outbox", replies.error("queue unavailable"), { on: "insert" })
    const result = await bulk(service, { company_id: COMPANY, invite_email: "bids@sparks.test" })
    assert.equal(result.emailsSent, 0)
  })

  test("a package that is not ready to send is refused and nothing changes", async () => {
    for (const [overrides, invites, message] of [
      [{ due_at: null }, [invite(1)], /due date in the future/],
      [{ due_at: PAST }, [invite(1)], /due date in the future/],
      [{ mode: "tender" }, [invite(1)], /at least one scope line/],
      [{}, [], /at least one trade/],
      [{ status: "open" }, [invite(1)], /Only a draft bid package/],
    ]) {
      const service = harness({ tables: { bid_packages: [bidPackage(overrides)], bid_invites: invites } })
      await assert.rejects(service.run(() => bids.sendBidPackage({ bidPackageId: PACKAGE })), message)
      assert.deepEqual(service.writes(), [], String(message))
    }
  })

  test("sending opens the package, links every lined-up trade and emails the ones with an address", async () => {
    const reachable = invite(1)
    const silent = invite(2, { company: { id: id(202), name: "Quiet Co" } })
    const service = harness({ tables: { bid_invites: [reachable, silent] } })

    const result = await service.run(() => bids.sendBidPackage({ bidPackageId: PACKAGE }))

    assert.equal(stored(service, "bid_packages", PACKAGE).status, "open")
    assert.equal(result.sent, 1)
    assert.deepEqual(result.failed, [
      { inviteId: silent.id, companyName: "Quiet Co", error: "No email on file — copy their link instead" },
    ])
    assert.deepEqual(service.db.outbox.map((job) => job.payload.to), ["trade1@example.test"])
    assert.equal(service.db.bid_access_tokens.length, 2, "both trades get a link")
    assert.ok(service.db.bid_access_tokens.every((token) => !token.revoked_at), "sending never revokes a link")
    assert.deepEqual(eventTypes(service).sort(), ["bid_invite_sent", "bid_invite_sent", "bid_package_status_changed"])

    await assert.rejects(service.run(() => bids.sendBidPackage({ bidPackageId: PACKAGE })), /Only a draft bid package/)
  })

  test("only a trade that was never sent the package can be removed", async () => {
    const sent = invite(1, { status: "sent" })
    const linedUp = invite(2)
    const service = harness({ tables: { bid_invites: [sent, linedUp] } })

    await assert.rejects(
      service.run(() => bids.removeBidInvite({ inviteId: sent.id })),
      /Only trades that haven't been sent the package can be removed/,
    )
    assert.deepEqual(service.writes(), [])

    await service.run(() => bids.removeBidInvite({ inviteId: linedUp.id }))
    assert.deepEqual(service.db.bid_invites.map((row) => row.id), [sent.id])
    assert.deepEqual(eventTypes(service), ["bid_invite_removed"])
  })
})

describe("addendum notices", () => {
  const FIRST = "first@example.test"
  const SECOND = "second@example.test"

  function noticeHarness(options = {}) {
    return harness({
      tables: {
        bid_packages: [bidPackage({ status: "open" })],
        bid_addenda: [{ id: ADDENDUM, org_id: ORG, bid_package_id: PACKAGE, number: 1, message: "Revised deadline" }],
        bid_invites: [invite(1, { status: "sent", invite_email: FIRST }), invite(2, { status: "sent", invite_email: SECOND })],
      },
      ...options,
    })
  }

  const retry = (service) => service.run(() => bids.retryBidAddendumNotifications({ addendumId: ADDENDUM }))

  test("a queue failure is reported per bidder, and a retry queues only the missing notice", async () => {
    const service = noticeHarness()
    let queueDown = true
    service.tamper(
      "outbox",
      (result, query) => {
        if (!queueDown || query.payload.payload.to !== SECOND) return result
        service.db.outbox = service.db.outbox.filter((job) => job.payload.to !== SECOND)
        return replies.error("queue unavailable")(result)
      },
      { on: "insert" },
    )

    const first = await retry(service)
    assert.deepEqual(first.queued, [FIRST])
    assert.deepEqual(first.failed.map((failure) => failure.recipient), [SECOND])

    queueDown = false
    const again = await retry(service)
    assert.deepEqual(again.queued, [SECOND])
    assert.deepEqual(again.alreadyQueued, [FIRST])
    assert.deepEqual(again.failed, [])

    assert.equal(service.db.outbox.length, 2)
    assert.equal(service.db.bid_addenda.length, 1, "a retry never issues a second notice")
    assert.ok(service.db.bid_access_tokens.every((token) => !token.revoked_at), "a retry never revokes a link")
  })

  test("a failed recipient lookup is reported, not mistaken for having no bidders", async () => {
    const service = noticeHarness()
    service.tamper("bid_invites", replies.error())
    const result = await retry(service)
    assert.equal(result.failed.length, 1)
    assert.deepEqual(result.queued, [])
    assert.deepEqual(service.db.outbox, [])
  })

  test("retrying notices needs project management or bid.write", async () => {
    const service = noticeHarness({ permissions: ["org.member"] })
    await assert.rejects(retry(service), /project\.manage|bid\.write/)
    assert.deepEqual(service.writes(), [])
  })
})

describe("access to a bid's sub-records follows its package", () => {
  /** Every sub-record of PACKAGE, on a community in `communityDivision`. */
  function scoped({ communityDivision = OTHER_DIVISION, pkg = {}, orgId = ORG, omit } = {}) {
    const tables = {
      communities: [{ id: COMMUNITY, org_id: ORG, division_id: communityDivision, name: "Oak Ridge" }],
      projects: [{ id: PROJECT, org_id: ORG, division_id: OTHER_DIVISION }],
      bid_packages: [bidPackage({ org_id: orgId, prospect_id: null, community_id: COMMUNITY, ...pkg })],
      bid_invites: [{ ...invite(0), id: INVITE, org_id: orgId, company_id: COMPANY, invite_email: "bids@sparks.test" }],
      bid_submissions: [{ id: SUBMISSION, org_id: orgId, bid_invite_id: INVITE }],
      bid_submission_items: [{ id: ITEM, org_id: orgId, bid_submission_id: SUBMISSION }],
      bid_access_tokens: [{ id: id(400), org_id: orgId, bid_invite_id: INVITE, revoked_at: null, paused_at: null }],
      rfis: [{ id: RFI, org_id: orgId, bid_package_id: PACKAGE }],
      rfi_responses: [{ id: id(401), org_id: orgId, rfi_id: RFI, body: "Use 12 gauge", created_at: SEEN }],
    }
    if (omit) tables[omit] = []
    return harness({ tables, divisions: [DIVISION] })
  }

  const operations = {
    "pause access": () => bids.pauseBidInviteAccess(INVITE),
    "resume access": () => bids.resumeBidInviteAccess(INVITE),
    "revoke access": () => bids.revokeBidInviteAccess(INVITE),
    "require an account": () => bids.setBidInviteRequireAccount({ inviteId: INVITE, requireAccount: true }),
    "mint a link": () => bids.generateBidInviteLink(INVITE),
    "resend an invite": () => bids.resendBidInvite({ inviteId: INVITE }),
    "invite trades": () =>
      bids.bulkCreateBidInvites({ input: { bid_package_id: PACKAGE, invites: [{ company_id: COMPANY }] } }),
    "level a bid": () => bids.updateBidSubmissionLeveling({ input: { bid_submission_id: SUBMISSION } }),
    "level a cell": () => bids.updateBidSubmissionItemLeveling({ input: { bid_submission_item_id: ITEM } }),
    "read RFI answers": () => bids.listBidPackageRfiResponses({ rfiId: RFI }),
  }

  test("every operation refuses a package on another division's community, before any write", async () => {
    for (const [name, operation] of Object.entries(operations)) {
      const service = scoped()
      await assert.rejects(service.run(operation), /outside your division access/, name)
      assert.deepEqual(service.writes(), [], name)
    }
  })

  test("every operation treats another org's bid records as not found", async () => {
    for (const [name, operation] of Object.entries(operations)) {
      const service = scoped({ orgId: FOREIGN_ORG, communityDivision: DIVISION })
      await assert.rejects(service.run(operation), /not found/i, name)
      assert.deepEqual(service.writes(), [], name)
    }
  })

  test("a community package in the caller's division is usable without any project", async () => {
    const service = scoped({ communityDivision: DIVISION })
    await service.run(operations["pause access"])
    assert.ok(service.db.bid_access_tokens[0].paused_at)

    const answers = await service.run(operations["read RFI answers"])
    assert.deepEqual(answers.map((answer) => answer.body), ["Use 12 gauge"])
  })

  test("a project package needs the project to be in the caller's divisions", async () => {
    const service = scoped({ pkg: { community_id: null, project_id: PROJECT } })
    await assert.rejects(service.run(operations["pause access"]), /outside your project access/)
    assert.deepEqual(service.writes(), [])
  })

  test("a broken chain from cell to package fails closed", async () => {
    for (const omit of ["bid_submission_items", "bid_submissions", "bid_invites", "bid_packages"]) {
      const service = scoped({ communityDivision: DIVISION, omit })
      await assert.rejects(service.run(operations["level a cell"]), /not found/i, omit)
      assert.deepEqual(service.writes(), [], omit)
    }
  })
})

describe("awarding a package to the price book", () => {
  const SCOPE_PACKAGE = bidPackage({ id: PACKAGE, prospect_id: null, community_id: COMMUNITY, award_target: "price_agreement", status: "open" })
  const award = (service, input) =>
    service.run(() => bids.awardBidSubmission({ input: { bid_submission_id: SUBMISSION, reviewed_scope: "Wall framing", reviewed_terms: "Net 30", ...input } }))

  function awardHarness(rpcCalls, permissions = [...MANAGER, "price_book.write"]) {
    return harness({
      permissions,
      tables: {
        bid_packages: [SCOPE_PACKAGE],
        directory_relationship_types: [{ id: id(600), org_id: ORG, key: "vendor", label: "Vendor", canonical_category: "vendor", applies_to: ["company"], sort_order: 1 }],
        party_roles: [{ id: id(601), org_id: ORG, company_id: COMPANY, contact_id: null, relationship_type_id: id(600), status: "active", since: "2020-01-01", until: null, source: "system", notes: null, relationship_type: { id: id(600), key: "vendor", label: "Vendor", canonical_category: "vendor", applies_to: ["company"], sort_order: 1 } }],
        communities: [{ id: COMMUNITY, org_id: ORG, division_id: DIVISION }],
        bid_invites: [invite(1, { id: INVITE, status: "submitted", company_id: COMPANY })],
        bid_submissions: [{ id: SUBMISSION, org_id: ORG, bid_invite_id: INVITE, total_cents: 100_000, currency: "USD", status: "submitted", is_current: true, valid_until: null, scope_revision: 1 }],
      },
      divisions: [DIVISION],
      rpc: { run_bid_award_price_agreements: (args) => { rpcCalls.push(args); return { data: { award_id: id(500), agreement_ids: [id(501)] }, error: null } } },
    })
  }

  test("a price-book award needs price_book.write as well as bid.write", async () => {
    const rpcCalls = []
    const buyer = awardHarness(rpcCalls, ["org.member", "bid.write"])
    await assert.rejects(award(buyer, { readiness_exception: "x" }), /price_book\.write/)
    assert.deepEqual(rpcCalls, [])
  })

  test("saving a live package's due date does not trip the scope guard when instructions are unchanged", async () => {
    const service = harness({ tables: { bid_packages: [bidPackage({ status: "open", instructions: null, scope: "Frame it", mode: "quote" })] } })
    const updated = await service.run(() => bids.updateBidPackage({ bidPackageId: PACKAGE, input: { due_at: "2027-01-05T17:00:00.000Z", instructions: null, scope: "Frame it", mode: "quote" } }))
    assert.equal(updated.due_at, "2027-01-05T17:00:00.000Z")
    await assert.rejects(service.run(() => bids.updateBidPackage({ bidPackageId: PACKAGE, input: { instructions: "New text" } })), /scope revision/)
  })

  test("the chosen effective date reaches the award and every bidder is told the result", async () => {
    const rpcCalls = []
    const service = awardHarness(rpcCalls)
    service.db.bid_invites.push(invite(2, { id: id(150), status: "submitted", company_id: id(250), company: { id: id(250), name: "Trade 2", email: "loser@example.test" } }))
    service.db.bid_invites[0].company = { id: COMPANY, name: "Winner", email: "winner@example.test" }

    await award(service, { effective_from: "2026-12-01", readiness_exception: "Insurance renewal pending" })

    assert.equal(rpcCalls[0].p_effective_from, "2026-12-01")
    assert.deepEqual(
      service.db.outbox.map((job) => [job.payload.kind, job.payload.outcome, job.payload.to]).sort(),
      [["award_notice", "not_selected", "loser@example.test"], ["award_notice", "winner", "winner@example.test"]],
    )
  })

  test("a buyer opens a community and plan package with no project, headed for the price book", async () => {
    const PLAN = id(700)
    const service = harness({
      tables: {
        bid_packages: [],
        communities: [{ id: COMMUNITY, org_id: ORG, division_id: DIVISION }],
        house_plans: [{ id: PLAN, org_id: ORG, division_id: DIVISION }],
      },
      divisions: [DIVISION],
    })
    const created = await service.run(() => bids.createBidPackage({ input: { title: "Framing", community_id: COMMUNITY, house_plan_id: PLAN } }))

    assert.equal(created.community_id, COMMUNITY)
    assert.equal(created.house_plan_id, PLAN)
    assert.equal(created.award_target, "price_agreement")
    assert.equal(created.project_id, null)
    assert.equal(created.prospect_id, null)
    assert.ok(eventTypes(service).includes("bid_package_created"))
  })

  test("an award without a reviewed scope and reviewed terms is refused before anything is read", async () => {
    const rpcCalls = []
    const service = awardHarness(rpcCalls)
    for (const missing of [{ reviewed_scope: " " }, { reviewed_terms: "" }]) {
      await assert.rejects(award(service, missing), /Review the subcontract/)
    }
    assert.deepEqual(rpcCalls, [])
    assert.deepEqual(service.writes(), [])
  })

  test("the reviewed scope and terms travel with the award into the price agreements", async () => {
    const rpcCalls = []
    const service = awardHarness(rpcCalls)
    const result = await award(service, { notes: "Rebid", readiness_exception: "Insurance renewal pending" })

    assert.deepEqual(result, { awardId: id(500), agreementIds: [id(501)], displacedAgreementIds: [] })
    assert.equal(rpcCalls.length, 1)
    assert.equal(rpcCalls[0].p_bid_submission_id, SUBMISSION)
    assert.match(rpcCalls[0].p_notes, /Reviewed scope: Wall framing/)
    assert.match(rpcCalls[0].p_notes, /Commercial terms: Net 30/)
    assert.deepEqual(eventTypes(service), ["bid_package.awarded_to_price_book"])
  })
})

describe("bid amounts stay within what the database stores", () => {
  const enter = (service, input) =>
    service.run(() => bids.createManualBidSubmission({ input: { bid_package_id: PACKAGE, company_id: COMPANY, ...input } }))

  test("a manual bid, a line or a leveling adjustment past $21,474,836.47 is refused in plain words before any write", async () => {
    for (const input of [
      { total_cents: 3_000_000_000 },
      { total_cents: 1_000, leveled_adjustment_cents: -3_000_000_000 },
      { total_cents: 1_000, line_items: [{ description: "Lump", amount_cents: 3_000_000_000 }] },
    ]) {
      const service = harness({ tables: { bid_submissions: [] } })
      await assert.rejects(enter(service, input), /cannot exceed \$21,474,836\.47/)
      assert.deepEqual(service.writes(), [])
    }
  })
})
