"use strict"

/**
 * `lib/services/spec-dispositions.ts` — recording a finished home's completion
 * and selling a standing spec off through the ordinary agreement path.
 */

const assert = require("node:assert/strict")
const { describe, test } = require("node:test")

const { createServiceHarness, id, ORG, ACTOR } = require("./support/service")
const { freshRequire, stubModule } = require("./support/modules")

// Preparing the Books review has its own suite; here it is recorded.
const writeDowns = []
stubModule("@/lib/services/books/inventory", {
  proposeInventoryImpairment: async (request) => {
    writeDowns.push(request)
    return { id: WRITE_DOWN }
  },
})

const {
  cancelSpecDisposition,
  decideSpecDisposition,
  executeSpecDisposition,
  proposeSpecDisposition,
  proposeSpecDispositionWriteDown,
  recordSpecCompletion,
} = freshRequire("lib/services/spec-dispositions.ts")

const COMMUNITY = id(1)
const LOT = id(2)
const HOME = id(3)
const BUYER = id(4)
const DISPOSITION = id(5)
const WRITE_DOWN = id(6)
const AGREEMENT = id(7)
const DIRECTOR = id(8)
const RESERVATION = id(9)

const today = new Date().toISOString().slice(0, 10)

function harness({ permissions = ["sales.manage"], userId = ACTOR, disposition, impairments = [], contracts = [], reservations = [], project = {}, books = [] } = {}) {
  return createServiceHarness({
    permissions,
    userId,
    tables: {
      communities: [{ id: COMMUNITY, org_id: ORG }],
      lots: [{ id: LOT, org_id: ORG, community_id: COMMUNITY, project_id: HOME, status: "started", updated_at: "2026-10-01T00:00:00+00:00" }],
      projects: [{ id: HOME, org_id: ORG, completed_on: null, ...project }],
      project_financial_settings: books,
      sellable_lot_inventory: [{ lot_id: LOT, org_id: ORG, asking_price_cents: 410_000_00 }],
      lot_reservations: reservations,
      contracts,
      spec_price_proposals: [],
      spec_dispositions: disposition ? [{
        id: DISPOSITION, org_id: ORG, lot_id: LOT, project_id: HOME, community_id: COMMUNITY, kind: "bulk_sale",
        counterparty_contact_id: BUYER, counterparty_company_id: null, price_cents: 300_000_00, carrying_cents: 320_000_00,
        status: "approved", proposed_by: ACTOR, impairment_id: null, contract_id: null, ...disposition,
      }] : [],
      books_inventory_impairments: impairments,
      home_margin_baselines: [{ id: id(10), org_id: ORG, project_id: HOME, sale_price_cents: 405_000_00 }],
    },
  })
}

/** An agreement priced through the disposition: its snapshot names the disposition and its kind. */
const agreement = (patch = {}) => ({
  id: AGREEMENT, org_id: ORG, project_id: HOME, contract_type: "purchase_agreement", status: "draft", buyer_contact_id: BUYER, total_cents: 300_000_00,
  snapshot: { purchase_agreement: { incentive_ids: [], pricing: { totalCents: 300_000_00, incentives: [], disposition: { id: DISPOSITION, kind: "bulk_sale" },
    homeAdjustments: [{ kind: "disposition", sourceId: DISPOSITION, label: "Bulk sale price (approved disposition)", amountCents: -110_000_00 }], homeAdjustmentsCents: -110_000_00 } } },
  ...patch,
})

describe("recordSpecCompletion", () => {
  const record = (service, patch = {}) => service.run(() => recordSpecCompletion({ projectId: HOME, completedOn: "2026-09-01", ...patch }))

  test("a finished home outside Books gets the day it was completed", async () => {
    const service = harness()
    assert.deepEqual(await record(service), { projectId: HOME, completedOn: "2026-09-01" })
    assert.equal(service.db.projects[0].completed_on, "2026-09-01")
    assert.deepEqual(service.events.map((event) => event.eventType), ["spec_home.completion_recorded"])
  })

  test("a completion is never recorded for a day that has not arrived", async () => {
    const service = harness()
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
    await assert.rejects(record(service, { completedOn: tomorrow }), /cannot be in the future/)
    assert.deepEqual(service.writes(), [])
  })

  test("a date Books recorded is changed in Books, not here", async () => {
    const service = harness({ books: [{ org_id: ORG, project_id: HOME, books_inventory_completed_on: "2026-08-15" }] })
    await assert.rejects(record(service), /Books recorded this home complete/)
    assert.deepEqual(service.writes(), [])
  })

  test("changing a recorded date needs a reason", async () => {
    const service = harness({ project: { completed_on: "2026-08-20" } })
    await assert.rejects(record(service), /Say why/)
    await record(service, { reason: "The CO was reissued after the final walk" })
    assert.equal(service.db.projects[0].completed_on, "2026-09-01")
  })
})

describe("selling a spec off", () => {
  const propose = (service, patch = {}) =>
    service.run(() => proposeSpecDisposition({ lotId: LOT, kind: "investor_sale", counterpartyContactId: BUYER, counterpartyCompanyId: null, priceCents: 300_000_00, reason: "Standing 240 days after two price cuts", ...patch }))

  test("a proposal never names its own carrying cost: the database records what Books carries", async () => {
    const service = harness()
    // The database's insert trigger sets carrying_cents from Books (proven in spec-dispositions-db).
    service.tamper("spec_dispositions", (result) => ({ ...result, data: { ...result.data, carrying_cents: 320_000_00 } }), { on: "insert" })
    const result = await propose(service)
    assert.equal(result.status, "proposed")
    assert.equal(result.carryingCents, 320_000_00)
    const [insert] = service.writes().filter((write) => write.table === "spec_dispositions")
    assert.equal("carrying_cents" in insert.payload, false)
    assert.equal(service.db.spec_dispositions[0].proposed_by, ACTOR)
  })

  test("a reserved home is not sold off", async () => {
    const service = harness({ reservations: [{ id: RESERVATION, org_id: ORG, lot_id: LOT, status: "reserved", expires_at: null }] })
    await assert.rejects(propose(service), /reserved or under agreement/)
    assert.deepEqual(service.writes(), [])
  })

  test("the person who proposed a sale-off cannot approve it", async () => {
    const service = harness({ permissions: ["sales.disposition_approve"], disposition: { status: "proposed" } })
    await assert.rejects(service.run(() => decideSpecDisposition({ dispositionId: DISPOSITION, approve: true })), /someone other than/)
    assert.deepEqual(service.writes(), [])
  })

  test("a second person with the approval permission approves it", async () => {
    const service = harness({ userId: DIRECTOR, permissions: ["sales.disposition_approve", "sales.manage"], disposition: { status: "proposed" } })
    assert.deepEqual(await service.run(() => decideSpecDisposition({ dispositionId: DISPOSITION, approve: true })), { dispositionId: DISPOSITION, status: "approved" })
    assert.equal(service.db.spec_dispositions[0].decided_by, DIRECTOR)
  })

  test("a sale below Books cost is not carried out until its write-down is approved", async () => {
    for (const impairments of [[], [{ id: WRITE_DOWN, org_id: ORG, status: "proposed" }]]) {
      const service = harness({ disposition: { impairment_id: impairments[0]?.id ?? null }, impairments, contracts: [agreement()] })
      await assert.rejects(service.run(() => executeSpecDisposition({ dispositionId: DISPOSITION })), /below the home's cost in Books/)
      assert.deepEqual(service.writes(), [])
    }
    const approved = harness({ disposition: { impairment_id: WRITE_DOWN }, impairments: [{ id: WRITE_DOWN, org_id: ORG, status: "approved" }], contracts: [agreement()] })
    assert.equal((await approved.run(() => executeSpecDisposition({ dispositionId: DISPOSITION }))).status, "executed")
    assert.equal(approved.db.spec_dispositions[0].contract_id, AGREEMENT)
  })

  test("the sale is the agreement written to the disposition's buyer at the approved price", async () => {
    const otherBuyer = harness({ disposition: { carrying_cents: 0 }, contracts: [agreement({ buyer_contact_id: id(11) })] })
    await assert.rejects(otherBuyer.run(() => executeSpecDisposition({ dispositionId: DISPOSITION })), /buyer is not the disposition's buyer/)
    const otherPrice = harness({ disposition: { carrying_cents: 0 }, contracts: [agreement({ total_cents: 310_000_00 })] })
    await assert.rejects(otherPrice.run(() => executeSpecDisposition({ dispositionId: DISPOSITION })), /not the approved disposition price/)
    const none = harness({ disposition: { carrying_cents: 0 } })
    await assert.rejects(none.run(() => executeSpecDisposition({ dispositionId: DISPOSITION })), /Write the purchase agreement/)
    // A retail agreement that happens to match is not the sale-off: it never carried the disposition.
    const retail = harness({ disposition: { carrying_cents: 0 }, contracts: [agreement({ snapshot: { purchase_agreement: { pricing: { totalCents: 300_000_00, disposition: null } } } })] })
    await assert.rejects(retail.run(() => executeSpecDisposition({ dispositionId: DISPOSITION })), /not priced through this disposition/)
    assert.deepEqual(retail.writes(), [])
  })

  test("carrying a sale out leaves margin baselines, reservations and the agreement untouched", async () => {
    const reservation = { id: RESERVATION, org_id: ORG, lot_id: LOT, status: "reserved", contract_id: AGREEMENT, expires_at: null }
    const service = harness({ disposition: { carrying_cents: 0 }, contracts: [agreement()], reservations: [reservation] })
    await service.run(() => executeSpecDisposition({ dispositionId: DISPOSITION }))
    assert.deepEqual([...new Set(service.writes().map((write) => write.table))], ["spec_dispositions"])
    assert.equal(service.db.home_margin_baselines[0].sale_price_cents, 405_000_00)
    assert.deepEqual(service.db.lot_reservations, [reservation])
    assert.deepEqual(service.db.contracts, [agreement()])
  })

  test("a write-down is measured at the sale price and linked to the disposition", async () => {
    writeDowns.length = 0
    const service = harness({ disposition: {} })
    const result = await service.run(() => proposeSpecDispositionWriteDown({ dispositionId: DISPOSITION, costToCompleteCents: 0, costToSellCents: 9_000_00, evidenceUrl: "https://example.com/bpo.pdf", assumptions: "Investor offer and broker opinion of value" }))
    assert.deepEqual(result, { dispositionId: DISPOSITION, impairmentId: WRITE_DOWN })
    assert.equal(writeDowns[0].sellingPriceCents, 300_000_00)
    assert.equal(writeDowns[0].asOf, today)
    assert.equal(service.db.spec_dispositions[0].impairment_id, WRITE_DOWN)
  })

  test("a sale at or above cost needs no write-down", async () => {
    const service = harness({ disposition: { carrying_cents: 290_000_00 } })
    await assert.rejects(service.run(() => proposeSpecDispositionWriteDown({ dispositionId: DISPOSITION, costToCompleteCents: 0, costToSellCents: 0, evidenceUrl: "https://example.com/a", assumptions: "Nothing to write down" })), /no write-down is needed/)
  })

  test("a carried-out sale cannot be cancelled", async () => {
    const service = harness({ disposition: { status: "executed", contract_id: AGREEMENT } })
    await assert.rejects(service.run(() => cancelSpecDisposition({ dispositionId: DISPOSITION })), /not been carried out/)
  })
})
