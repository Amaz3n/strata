"use strict"

/**
 * `lib/services/precon-pricing.ts` — the deal's pricing worksheet and the
 * quote requests and client documents made from it. The worksheet saves
 * under one optimistic version; quote requests and quotes must belong to THIS
 * deal; a selected quote's cost is always the canonical pricing decision,
 * never a number from the browser; and each client document is an immutable
 * snapshot of one worksheet version.
 */

const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { stubModule, freshRequire } = require("./support/modules")

process.env.BID_PORTAL_SECRET ??= "test-bid-portal-secret"

// A deal's selected quotes are read through the bids service, whose own suite
// covers how they are derived; here they are whatever the test selects.
let selectedQuotes = []
const bids = freshRequire("lib/services/bids.ts")
stubModule("@/lib/services/bids", { ...bids, listProspectBidQuotes: async () => structuredClone(selectedQuotes) })

const { EMPTY_PRECON_BRIEF } = require("@/lib/precon/workspace")
const { EMPTY_PRICING_WORKSHEET, pricingRowSchema, scopeSignature } = require("@/lib/precon/pricing-worksheet")
const {
  prepareDealDocument,
  savePricingRequestDetails,
  savePricingWorksheet,
  sendPricingRequest,
} = freshRequire("lib/services/precon-pricing.ts")

const DEAL = id(1)
const PROJECT = id(2)
const PACKAGE = id(3)
const FILE = id(4)
const COMPANY = id(5)
const CONTACT = id(6)
const OTHER = id(7)

const PERMISSIONS = [
  "org.member",
  "org.read",
  "project.read",
  "project.manage",
  "bid.write",
  "docs.read",
  "docs.upload",
]

let rowSequence = 100
const row = (overrides = {}) =>
  pricingRowSchema.parse({ id: id((rowSequence += 1)), description: "Scope", unit_cost_cents: 100000, ...overrides })

function bidPackage(overrides = {}) {
  return {
    id: PACKAGE,
    org_id: ORG,
    project_id: null,
    prospect_id: DEAL,
    title: "Electrical",
    mode: "quote",
    status: "draft",
    instructions: null,
    due_at: null,
    scope_revision: 1,
    created_at: "2026-10-01T00:00:00Z",
    ...overrides,
  }
}

function harness({ status = "pricing", workspace = null, packages = [], permissions = PERMISSIONS } = {}) {
  selectedQuotes = []
  const service = createServiceHarness({
    tables: {
      orgs: [{ id: ORG, name: "Builder" }],
      prospects: [{ id: DEAL, org_id: ORG, name: "Kitchen", status }],
      projects: [{ id: PROJECT, org_id: ORG, prospect_id: DEAL, phase: "precon", name: "Kitchen" }],
      precon_workspaces: workspace ? [{ org_id: ORG, prospect_id: DEAL, ...workspace }] : [],
      precon_decisions: [],
      bid_packages: packages,
      bid_invites: [],
      bid_addenda: [],
      bid_access_tokens: [],
      bid_scope_revisions: [],
      outbox: [],
      companies: [{ id: COMPANY, org_id: ORG, name: "Sparks LLC" }],
      contacts: [{ id: CONTACT, org_id: ORG, full_name: "Sam Sparks" }],
      files: [{ id: FILE, org_id: ORG, project_id: PROJECT, file_name: "Plans.pdf", archived_at: null }],
      file_links: [],
      estimates: [],
      estimate_items: [],
    },
    permissions,
    rpc: {
      // As the migration does: snapshot, bump the revision, and reopen as a draft.
      begin_bid_scope_revision: ({ p_package_id }, store) => {
        const pkg = store.bid_packages.find((item) => item.id === p_package_id)
        pkg.scope_revision += 1
        pkg.status = "draft"
        store.bid_scope_revisions.push({ bid_package_id: p_package_id, revision: pkg.scope_revision - 1 })
        return { data: pkg.scope_revision, error: null }
      },
    },
  })
  // These deals send their price as a range for approval; signing is covered with the portal.
  service.tamper(
    "precon_workspaces",
    (result) => {
      for (const workspace of service.db.precon_workspaces) workspace.proposal ??= { price_mode: "range" }
      return result
    },
    { on: "insert" },
  )
  // Column defaults the database applies on insert.
  service.tamper(
    "estimates",
    (result) => {
      for (const estimate of service.db.estimates) estimate.is_current_version ??= true
      return result
    },
    { on: "insert" },
  )
  service.tamper(
    "outbox",
    (result) => {
      for (const job of service.db.outbox) job.status ??= "pending"
      return result
    },
    { on: "insert" },
  )
  return service
}

const stored = (service) => service.db.precon_workspaces[0]
const save = (service, worksheet, version) => service.run(() => savePricingWorksheet(DEAL, worksheet, version))
const prepare = (service, version) =>
  service.run(() => prepareDealDocument(DEAL, "budget", { title: "Estimate" }, version, 0))

describe("savePricingWorksheet", () => {
  test("a caller who cannot manage the deal's project, or a lost deal, writes nothing", async () => {
    const worksheet = { ...EMPTY_PRICING_WORKSHEET, rows: [row()] }

    const forbidden = harness({ permissions: PERMISSIONS.filter((key) => key !== "project.manage") })
    await assert.rejects(save(forbidden, worksheet, 0), /project\.manage/)
    assert.deepEqual(forbidden.writes(), [])

    const lost = harness({ status: "lost" })
    await assert.rejects(save(lost, worksheet, 0), /Reopen/)
    assert.deepEqual(lost.writes(), [])
  })

  test("two saves from the same version: one lands, the other is told to merge, and job details survive", async () => {
    const service = harness({
      workspace: { version: 3, brief: { ...EMPTY_PRECON_BRIEF, scope: "Keep this scope", pricing_revision: 2 } },
    })
    const worksheet = { ...EMPTY_PRICING_WORKSHEET, rows: [row()] }
    const results = await Promise.allSettled([save(service, worksheet, 3), save(service, worksheet, 3)])

    assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"])
    assert.match(results.find((result) => result.status === "rejected").reason.message, /another session/)
    assert.equal(stored(service).version, 4)
    assert.equal(stored(service).brief.scope, "Keep this scope")
    assert.equal(stored(service).brief.pricing_revision, 2, "a worksheet save is not a scope revision")
  })

  test("a quote request on another deal or project cannot be linked, even inside the org", async () => {
    const service = harness({ packages: [bidPackage({ prospect_id: OTHER, project_id: OTHER })] })
    const item = row()
    const worksheet = {
      ...EMPTY_PRICING_WORKSHEET,
      rows: [item],
      requests: [{ package_id: PACKAGE, row_ids: [item.id], scope_signature: scopeSignature([item]), quote: null }],
    }
    await assert.rejects(save(service, worksheet, 0), /does not belong/)
    assert.deepEqual(service.writes(), [])
  })

  test("a selected quote's cost is the canonical pricing decision, not the browser's number", async () => {
    const service = harness({ packages: [bidPackage({ prospect_id: null, project_id: PROJECT })] })
    const item = row()
    const quote = {
      bid_package_id: PACKAGE,
      submission_id: id(20),
      pricing_decision_id: id(21),
      company_name: "Trade",
      normalized_total_cents: 150000,
      total_cents: 150000,
      submission_version: 1,
      scope_revision: 1,
      valid_until: null,
      accepted_alternate_ids: [],
      gaps: [],
    }
    selectedQuotes = [quote]
    const worksheet = {
      ...EMPTY_PRICING_WORKSHEET,
      rows: [item],
      requests: [
        {
          package_id: PACKAGE,
          row_ids: [item.id],
          scope_signature: scopeSignature([item]),
          quote: { ...quote, normalized_total_cents: 1 },
        },
      ],
    }
    const saved = await save(service, worksheet, 0)
    assert.equal(saved.worksheet.requests[0].quote.normalized_total_cents, 150000)

    // The quote is withdrawn: the worksheet may keep it as a working number…
    selectedQuotes = []
    await save(service, saved.worksheet, 1)
    // …but no client document may be priced on it.
    await assert.rejects(prepare(service, 2), /no longer current/)
    assert.deepEqual(service.db.estimates, [])
  })

  test("a request keeps the scope signature it was quoted against when its rows are edited", async () => {
    const service = harness({ packages: [bidPackage()] })
    const item = row()
    const original = scopeSignature([item])
    const first = await save(
      service,
      {
        ...EMPTY_PRICING_WORKSHEET,
        rows: [item],
        requests: [{ package_id: PACKAGE, row_ids: [item.id], scope_signature: "client-supplied", quote: null }],
      },
      0,
    )
    assert.equal(first.worksheet.requests[0].scope_signature, original)

    first.worksheet.rows[0].description = "Expanded scope"
    first.worksheet.requests[0].scope_signature = scopeSignature(first.worksheet.rows)
    const second = await save(service, first.worksheet, 1)
    assert.equal(second.worksheet.requests[0].scope_signature, original)
  })
})

describe("prepareDealDocument", () => {
  const itemsOf = (service, estimate) =>
    service.db.estimate_items.filter((item) => item.estimate_id === estimate.id).map((item) => item.unit_cost_cents)

  test("each document is a snapshot of one priced worksheet version; own prices need no bids", async () => {
    const service = harness()
    const item = row({ unit_cost_cents: null })
    const worksheet = { ...EMPTY_PRICING_WORKSHEET, rows: [item] }

    await save(service, worksheet, 0)
    await assert.rejects(prepare(service, 1), /Price each scope item/)

    item.unit_cost_cents = 150000
    await save(service, worksheet, 1)
    await assert.rejects(prepare(service, 1), /latest worksheet/)

    const budget = await prepare(service, 2)
    assert.equal(budget.metadata.precon.purpose, "budget")
    assert.deepEqual(itemsOf(service, budget), [150000])
    assert.equal((await prepare(service, 2)).id, budget.id, "a retry returns the same draft")

    item.unit_cost_cents = 200000
    await save(service, worksheet, 2)
    const revision = await prepare(service, 3)
    assert.equal(revision.version, 2)
    assert.equal(revision.supersedes_estimate_id, budget.id)
    assert.deepEqual(itemsOf(service, revision), [200000])
    assert.deepEqual(itemsOf(service, budget), [150000], "the earlier snapshot is untouched")
    assert.equal(service.db.estimates.find((estimate) => estimate.id === budget.id).is_current_version, false)
  })
})

describe("quote requests", () => {
  const details = (overrides = {}) => ({
    title: "Electrical",
    due_at: null,
    due_tz: "America/New_York",
    instructions: "Use plans",
    file_ids: [],
    ...overrides,
  })
  const saveDetails = (service, input) => service.run(() => savePricingRequestDetails(DEAL, PACKAGE, input))
  const packageRow = (service) => service.db.bid_packages[0]

  test("a draft request saves its exact deadline and shares workspace files without inviting anyone", async () => {
    const service = harness({ packages: [bidPackage()] })
    const due = "2026-10-01T18:30:00.000Z"
    await saveDetails(service, details({ due_at: due, instructions: "Price the complete scope", file_ids: [FILE] }))

    assert.equal(packageRow(service).due_at, due)
    assert.equal(packageRow(service).due_tz, "America/New_York")
    assert.equal(packageRow(service).instructions, "Price the complete scope")
    assert.deepEqual(
      service.db.file_links.map((link) => [link.file_id, link.entity_type, link.entity_id]),
      [[FILE, "bid_package", PACKAGE]],
    )
    assert.deepEqual(service.db.bid_invites, [])
  })

  test("only files from the deal's own workspace can be shared, checked before anything changes", async () => {
    const service = harness({ packages: [bidPackage()] })
    await assert.rejects(saveDetails(service, details({ file_ids: [OTHER] })), /workspace only/)
    assert.deepEqual(service.writes(), [])
  })

  test("an issued request saves with unchanged instructions and no revision", async () => {
    const service = harness({ packages: [bidPackage({ status: "open", instructions: "Use plans" })] })
    assert.equal(await saveDetails(service, details({ title: "Plumbing" })), null)
    assert.equal(packageRow(service).title, "Plumbing")
    assert.equal(packageRow(service).scope_revision, 1)
    assert.deepEqual(service.db.bid_addenda, [])
  })

  test("changing an issued request's instructions requires notifying bidders, then revises and notifies", async () => {
    const service = harness({ packages: [bidPackage({ status: "open", instructions: "Old instructions" })] })
    const input = details({ title: "Plumbing", instructions: "New instructions", file_ids: [FILE] })

    await assert.rejects(saveDetails(service, input), /notify bidders/)
    assert.deepEqual(service.writes(), [])

    await saveDetails(service, { ...input, notify_bidders: true })
    assert.equal(packageRow(service).scope_revision, 2)
    assert.equal(packageRow(service).status, "open", "the revised request stays issued")
    assert.equal(packageRow(service).instructions, "New instructions")
    const [notice] = service.db.bid_addenda
    assert.match(notice.message, /New instructions/)
    assert.match(notice.message, /Plans\.pdf/)
  })

  test("other edits to an issued request notify bidders without a scope revision", async () => {
    const service = harness({ packages: [bidPackage({ status: "open", instructions: "Use plans" })] })
    await saveDetails(service, details({ title: "Updated bid name", notify_bidders: true }))
    assert.equal(packageRow(service).scope_revision, 1)
    assert.match(service.db.bid_addenda[0].message, /Updated bid name/)
  })

  test("sending invites the chosen contact at the chosen address; a closed request refuses", async () => {
    const service = harness({ packages: [bidPackage()] })
    const invite = { company_id: COMPANY, contact_id: CONTACT, invite_email: "bidder@example.com" }
    await service.run(() => sendPricingRequest(DEAL, PACKAGE, [invite]))

    assert.equal(packageRow(service).status, "open")
    assert.deepEqual(
      service.db.bid_invites.map(({ company_id, contact_id, invite_email }) => ({ company_id, contact_id, invite_email })),
      [invite],
    )
    assert.deepEqual(service.db.outbox.map((job) => job.payload.to), ["bidder@example.com"])

    packageRow(service).status = "closed"
    await assert.rejects(service.run(() => sendPricingRequest(DEAL, PACKAGE, [invite])), /closed/)
    assert.equal(service.db.bid_invites.length, 1)
  })
})
