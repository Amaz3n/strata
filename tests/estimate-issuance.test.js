"use strict"

/**
 * `assertEstimateIssuable()` — the one gate for emailing, copying or replacing
 * a client document's link. Only the current unsigned document may go out; on
 * its FIRST issue the price must still rest on the current brief, files,
 * drawings and selected trade quotes. Once issued, the snapshot it sent can be
 * resent as-is however the pricing has moved since.
 */

const assert = require("node:assert/strict")
const { test } = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { stubModule, freshRequire } = require("./support/modules")

// The deal's selected quotes come from the bids service, which has its own suite.
let quotes = []
stubModule("@/lib/services/bids", { listProspectBidQuotes: async () => structuredClone(quotes) })

const { DEFAULT_ESTIMATE_COMMERCIAL } = require("@/lib/financials/estimate-commercial")
const { assertEstimateIssuable } = freshRequire("lib/services/estimate-issuance.ts")

const DOCUMENT = id(1)
const DEAL = id(2)
const PROJECT = id(3)
const FILE = id(4)
const QUOTE = id(5)
const DECISION = id(6)

function harness({ workspace = { brief: { pricing_revision: 2 }, version: 7 }, drawings = [], decisions = [] } = {}) {
  quotes = []
  return createServiceHarness({
    tables: {
      estimates: [{ id: DOCUMENT, org_id: ORG, project_id: PROJECT, prospect_id: DEAL, status: "draft" }],
      prospects: [{ id: DEAL, org_id: ORG, status: "pricing" }],
      projects: [{ id: PROJECT, org_id: ORG, prospect_id: DEAL, phase: "precon" }],
      precon_workspaces: [{ org_id: ORG, prospect_id: DEAL, ...workspace }],
      precon_decisions: decisions,
      files: [],
      drawing_revisions: drawings.map((drawing) => ({ org_id: ORG, project_id: PROJECT, status: "published", ...drawing })),
    },
    permissions: ["org.member", "project.manage", "project.read"],
  })
}

/** A budget priced on brief revision 2, never sent. */
function document({ precon = {}, ...overrides } = {}) {
  return {
    id: DOCUMENT,
    status: "draft",
    prospect_id: DEAL,
    is_current_version: true,
    total_cents: 100000,
    metadata: { precon: { ...DEFAULT_ESTIMATE_COMMERCIAL, purpose: "budget", brief_version: 2, ...precon } },
    items: [],
    ...overrides,
  }
}

const quoteItem = (normalized) => ({
  id: id(50),
  metadata: {
    source_bid_submission_id: QUOTE,
    bid_pricing_basis: { pricing_decision_id: DECISION, normalized_total_cents: normalized },
  },
})

const issue = (service, value) => service.run(() => assertEstimateIssuable(value))

test("a first issue is refused when the price no longer rests on current sources", async () => {
  await assert.rejects(issue(harness(), document({ precon: { brief_version: 1 } })), /Pricing basis changed/)
  await assert.rejects(
    issue(harness(), document({ precon: { governing_documents: [{ id: FILE, name: "Plans", version_id: "v1" }] } })),
    /unavailable/,
  )
  await assert.rejects(
    issue(
      harness({ drawings: [{ id: id(60), drawing_set_id: id(61), revision_label: "R2", created_at: "2026-10-01" }] }),
      document({ precon: { drawing_revisions: [] } }),
    ),
    /New drawing issuance/,
  )
  await assert.rejects(issue(harness(), document({ items: [quoteItem(123)] })), /trade quote changed/)
})

test("a first issue goes out when its quote and every reference are still current", async () => {
  const service = harness()
  quotes = [{ submission_id: QUOTE, pricing_decision_id: DECISION, normalized_total_cents: 123 }]
  await issue(service, document({ items: [quoteItem(123)] }))

  quotes = [{ submission_id: QUOTE, pricing_decision_id: DECISION, normalized_total_cents: 999 }]
  await assert.rejects(issue(service, document({ items: [quoteItem(123)] })), /trade quote changed/)
})

test("an issued snapshot can be resent after pricing moves; a signed or superseded one cannot", async () => {
  const service = harness({ workspace: { brief: { pricing_revision: 99 }, version: 99 } })
  await issue(service, document({ status: "sent", sent_at: "2026-10-01" }))

  for (const state of [{ status: "executed" }, { status: "client_signed" }, { is_current_version: false }]) {
    await assert.rejects(issue(service, document(state)), /current unsigned/, JSON.stringify(state))
  }
})

test("an agreement cannot go out while an open condition blocks it", async () => {
  const service = harness({
    decisions: [{ id: id(70), org_id: ORG, prospect_id: DEAL, status: "open", blocks_agreement: true }],
  })
  const agreement = document({
    precon: {
      purpose: "construction_agreement",
      pricing_basis: "Issued drawings revision 4",
      payment_terms: "Deposit and monthly progress",
    },
  })
  await assert.rejects(issue(service, agreement), /1 open agreement condition/)
})
