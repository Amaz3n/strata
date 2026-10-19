"use strict"

/**
 * `lib/services/precon-deals.ts` — which documents a deal shows as its current
 * budget and agreement, and whether the worksheet has moved since one was sent.
 */

const assert = require("node:assert/strict")
const { test } = require("node:test")

const { id } = require("./support/service")
const { freshRequire } = require("./support/modules")

const { pricingRowSchema, EMPTY_PRICING_WORKSHEET } = require("@/lib/precon/pricing-worksheet")
const { dealDocuments, worksheetFingerprint } = freshRequire("lib/services/precon-deals.ts")

const worksheet = {
  ...EMPTY_PRICING_WORKSHEET,
  rows: [pricingRowSchema.parse({ id: id(1), description: "Framing", unit_cost_cents: 800_000 })],
}

let sequence = 100
function document(purpose, overrides = {}) {
  sequence += 1
  return {
    id: id(sequence),
    prospect_id: id(2),
    status: "sent",
    version: 1,
    total_cents: 1_000_000,
    sent_at: "2026-09-30T12:00:00Z",
    viewed_at: null,
    responded_at: null,
    decision_note: null,
    client_signed_at: null,
    updated_at: "2026-09-30T12:00:00Z",
    purpose,
    fingerprint: worksheetFingerprint(worksheet),
    accepted_total: null,
    ...overrides,
  }
}

test("a document sent from the current worksheet is unchanged; any edit since marks it changed", () => {
  assert.equal(dealDocuments([document("budget")], worksheet).proposal.changed_since, false)
  assert.equal(dealDocuments([document("budget")], { ...worksheet, markup_percent: 20 }).proposal.changed_since, true)
})

test("a document with no worksheet fingerprint never claims to be stale", () => {
  assert.equal(dealDocuments([document("budget", { fingerprint: null })], worksheet).proposal.changed_since, false)
})

test("each purpose shows its newest document, and a legacy document counts as the agreement at its accepted total", () => {
  const older = document("budget", { updated_at: "2026-09-01T00:00:00Z" })
  const newer = document("budget", { updated_at: "2026-09-20T00:00:00Z", version: 2 })
  const legacy = document(null, { accepted_total: "1250000" })

  const { proposal, agreement } = dealDocuments([older, newer, legacy], worksheet)
  assert.equal(proposal.id, newer.id)
  assert.equal(agreement.id, legacy.id)
  assert.equal(agreement.total_cents, 1_250_000)
})
