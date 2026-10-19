"use strict"

/**
 * lib/services/vendor-bills.ts — linking a payable to an Arc vendor
 * (`ensureVendorBillCompany`). The directory itself (`getCompany`,
 * `createCompany`) is its own service and is replaced here.
 */

const assert = require("node:assert/strict")
const test = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { supportPostgrestFilters } = require("./support/billing")
const { freshRequire, stubModule } = require("./support/modules")

stubModule("@/lib/services/companies", {
  getCompany: async (companyId) => ({ id: companyId }),
  createCompany: async () => {
    throw new Error("unexpected company creation")
  },
  saveCompanyAccountingVendorLink: async () => {},
})

const { ensureVendorBillCompany, createProjectVendorCredit } = freshRequire("lib/services/vendor-bills.ts")

const PROJECT = id(1)
const BILL = id(2)
const ACME = id(3)

function setup(permissions) {
  return supportPostgrestFilters(
    createServiceHarness({
      permissions,
      tables: {
        projects: [{ id: PROJECT, org_id: ORG }],
        vendor_bills: [
          { id: BILL, org_id: ORG, project_id: PROJECT, company_id: null, metadata: { vendor_name: "acme concrete" }, accounting_coding: null },
        ],
        companies: [{ id: ACME, org_id: ORG, name: "Acme Concrete", metadata: {} }],
      },
    }),
  )
}

const link = (service) => service.run(() => ensureVendorBillCompany({ projectId: PROJECT, billId: BILL }))

test("a payable is linked to the existing vendor of the same name, and the change is audited", async () => {
  const service = setup(["bill.write", "project.read"])
  const company = await link(service)

  assert.equal(company.id, ACME)
  assert.equal(service.db.vendor_bills[0].company_id, ACME)
  assert.deepEqual(
    service.audits.map((audit) => [audit.entityType, audit.before, audit.after]),
    [["vendor_bill", { company_id: null }, { company_id: ACME }]],
  )
})

test("linking a vendor needs bill write access", async () => {
  const service = setup(["bill.read", "project.read"])
  await assert.rejects(link(service), /Missing permission: bill.write/)
  assert.deepEqual(service.writes(), [])
  assert.equal(service.db.vendor_bills[0].company_id, null)
})

const credit = (service, extra = {}) => service.run(() => createProjectVendorCredit({
  projectId: PROJECT, companyId: ACME, billNumber: "WB-1", billDate: "2026-10-01", description: "Backcharge",
  lines: [{ description: "Callback", amount_cents: -100 }], ...extra,
}))

test("a vendor credit needs bill.approve unless the warranty backcharge authority is named", async () => {
  const writer = setup(["bill.write", "project.read"])
  await assert.rejects(credit(writer), /Missing permission: bill.approve/)
  await assert.rejects(credit(writer, { approvalAuthority: "warranty.backcharge" }), /Missing permission: warranty.backcharge/)
  assert.deepEqual(writer.writes(), [])

  // bill.approve does not stand in for the named authority, and the named authority still needs bill.write.
  await assert.rejects(credit(setup(["bill.write", "bill.approve", "project.read"]), { approvalAuthority: "warranty.backcharge" }), /Missing permission: warranty.backcharge/)
  await assert.rejects(credit(setup(["warranty.backcharge", "project.read"]), { approvalAuthority: "warranty.backcharge" }), /Missing permission: bill.write/)
})

test("a warranty manager passes the credit's approval gate on warranty.backcharge alone", async () => {
  const service = setup(["bill.write", "warranty.backcharge", "project.read"])
  // The harness has no vendor, so the credit stops right after authorization, before any write.
  await assert.rejects(credit(service, { approvalAuthority: "warranty.backcharge", companyId: id(99) }), /Arc vendor not found/)
  assert.deepEqual(service.writes(), [])
})
