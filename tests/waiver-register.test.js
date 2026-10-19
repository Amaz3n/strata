const assert = require("node:assert/strict")
const test = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire } = require("./support/modules")

const { getProjectWaiverRegister, WAIVER_REGISTER_BILL_CAP } = freshRequire("lib/services/waiver-register.ts")

const PROJECT = id(1)
const VENDOR = id(2)
const COMMITMENT = id(3)
const FOREIGN_ORG = id(4)
const PERIOD = "2026-08-31"

/** An approved $100 bill with $10 retainage, work through `PERIOD`, nothing paid. */
function bill(n, overrides = {}) {
  return {
    id: id(10_000 + n),
    org_id: ORG,
    project_id: PROJECT,
    company_id: VENDOR,
    commitment_id: COMMITMENT,
    bill_number: `B-${n}`,
    total_cents: 10_000,
    paid_cents: 0,
    retainage_cents: 1_000,
    status: "approved",
    metadata: { billing_period_end: PERIOD },
    ...overrides,
  }
}

/** A signed, reviewed and accepted conditional progress waiver for `billId`. */
function acceptedWaiver(billId) {
  return {
    id: id(20_000),
    org_id: ORG,
    project_id: PROJECT,
    bill_id: billId,
    waiver_type: "conditional_progress",
    status: "signed",
    amount_cents: 9_000,
    through_date: PERIOD,
    signed_file_id: id(30_000),
    signed_at: "2026-09-02T00:00:00Z",
    metadata: { review: { status: "accepted" } },
    created_at: "2026-09-02T00:00:00Z",
  }
}

function harness({ bills = [bill(0)], waivers = [], requirements = [], commitments = [], permissions } = {}) {
  return createServiceHarness({
    permissions: permissions ?? ["bill.read", "project.read"],
    tables: {
      orgs: [{ id: ORG, compliance_rules: { require_lien_waiver: true } }],
      projects: [{ id: PROJECT, org_id: ORG, name: "Lot 12", require_subtier_waivers: true }],
      vendor_bills: bills,
      companies: [{ id: VENDOR, org_id: ORG, name: "Trade" }],
      commitments,
      lien_waivers: waivers,
      subtier_waiver_requirements: requirements,
    },
  })
}

const register = (service, ...args) => service.run(() => getProjectWaiverRegister(PROJECT, ...args))

test("a member without bill access reads no financial records", async () => {
  const service = harness({ permissions: ["project.read"] })

  await assert.rejects(register(service), /Missing permission: bill.read/)
  for (const table of ["vendor_bills", "lien_waivers", "subtier_waiver_requirements", "companies"]) {
    assert.deepEqual(service.reads(table), [], table)
  }
})

test("another organization's bills on the same project id never appear", async () => {
  const service = harness({ bills: [bill(0), bill(1, { org_id: FOREIGN_ORG })] })

  const result = await register(service)

  assert.deepEqual(
    result.entries.map((entry) => entry.bill.id),
    [bill(0).id],
  )
})

test("a bill marked received by hand stays held until accepted signed evidence covers it", async () => {
  const marked = harness({ bills: [bill(0, { lien_waiver_status: "received" })] })
  const [held] = (await register(marked)).entries
  assert.equal(held.coverage.heldCents, 9_000)
  assert.equal(held.coverage.status, "Missing")

  const covered = harness({ bills: [bill(0)], waivers: [acceptedWaiver(bill(0).id)] })
  const [released] = (await register(covered)).entries
  assert.equal(released.coverage.heldCents, 0)
  assert.equal(released.coverage.status, "Accepted")
  assert.match(released.waivers[0].documentHref, new RegExp(id(30_000)))
})

test("totals cover every filtered bill while the page shows only its slice", async () => {
  const count = 6 * WAIVER_REGISTER_BILL_CAP + 1
  const service = harness({ bills: Array.from({ length: count }, (_, n) => bill(n)) })

  const page = await register(service, "", undefined, { page: 7, status: "outstanding" })
  assert.equal(page.total, count)
  assert.equal(page.pages, 7)
  assert.equal(page.entries.length, 1)
  assert.equal(page.totals.heldCents, count * 9_000)
  assert.equal(page.totals.billsHeld, count)

  const exported = await register(service, "", undefined, { exportAll: true })
  assert.equal(exported.entries.length, count)
})

test("lower-tier claimants without a matching bill stay visible", async () => {
  const service = harness({
    requirements: [
      {
        id: id(40_000),
        org_id: ORG,
        project_id: PROJECT,
        commitment_id: id(41_000),
        period_end: "2026-09-30",
        claimant_company_name: "Supply",
        waiver_type: "conditional_progress",
        amount_cents: 5_000,
        is_active: true,
      },
    ],
  })

  const result = await register(service)

  assert.equal(result.unbilledTotal, 1)
  assert.equal(result.unbilledClaimants[0].claimant_company_name, "Supply")
  assert.equal(result.unbilledClaimants[0].received, false)
})

test("a bill without a vendor is named from its commitment", async () => {
  const service = harness({
    bills: [bill(0, { company_id: null })],
    commitments: [{ id: COMMITMENT, org_id: ORG, project_id: PROJECT, company_id: VENDOR }],
  })

  const [entry] = (await register(service)).entries

  assert.equal(entry.companyName, "Trade")
})

test("the period filter reads the work-through date, never the due date", async () => {
  const service = harness({ bills: [bill(0, { due_date: "2026-09-30" })] })

  assert.equal((await register(service)).total, 1)
  assert.equal((await register(service, "2026-09-30")).total, 0)
  assert.equal((await register(service, PERIOD)).total, 1)
})
