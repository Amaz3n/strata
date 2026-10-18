"use strict"

/**
 * The commitment service: an order is totalled from its lines in whole cents
 * (each line rounded half up, then summed), a purchase order is completed by its
 * completion report and not by an edit, a signed copy does not issue a draft,
 * and the one-step create never leaves an unlabeled draft behind.
 */

const assert = require("node:assert/strict")
const { test } = require("node:test")

const { createServiceHarness, id, ORG } = require("./support/service")
const { freshRequire } = require("./support/modules")

const { updateCommitment, executeCommitment, createCommitmentWithLine } = freshRequire("lib/services/commitments.ts")

const PROJECT = id(20)
const COMMITMENT = id(70)

function org({ status = "draft", type = "purchase_order", lines = [], permissions = ["commitment.write", "commitment.approve", "project.read", "org.member"] } = {}) {
  return createServiceHarness({
    permissions,
    tables: {
      projects: [{ id: PROJECT, org_id: ORG, division_id: null }],
      commitments: [{
        id: COMMITMENT, org_id: ORG, project_id: PROJECT, company_id: id(71), commitment_type: type,
        title: "PO", status, total_cents: 10_000, currency: "usd", metadata: {},
      }],
      commitment_lines: lines.map((line, index) => ({ id: id(80 + index), org_id: ORG, commitment_id: COMMITMENT, ...line })),
      authorization_audit_log: [],
    },
  })
}

test("approving an order with decimal quantities totals each line to a whole cent and writes an integer", async () => {
  const service = org({ lines: [
    { quantity: 12.5, unit_cost_cents: 4567 },
    { quantity: 1234.56, unit_cost_cents: 187 },
  ] })
  await service.run(() => updateCommitment({ commitmentId: COMMITMENT, input: { status: "approved", prequal_override_note: "Known vendor" } }))
  const stored = service.db.commitments[0].total_cents
  assert.equal(stored, 57_088 + 230_863)
  assert.ok(Number.isInteger(stored))
})

test("an approved purchase order is not completed or reopened by editing its status", async () => {
  const approved = org({ status: "approved" })
  await assert.rejects(approved.run(() => updateCommitment({ commitmentId: COMMITMENT, input: { status: "complete" } })), /completion report/)
  assert.equal(approved.db.commitments[0].status, "approved")
  const complete = org({ status: "complete" })
  await assert.rejects(complete.run(() => updateCommitment({ commitmentId: COMMITMENT, input: { status: "approved" } })), /completion report/)
  assert.equal(complete.db.commitments[0].status, "complete")
})

test("recording a signed copy does not issue a draft purchase order", async () => {
  const service = org()
  await assert.rejects(
    service.run(() => executeCommitment({ commitmentId: COMMITMENT, input: { executed_file_id: id(90), executed_at: "2026-10-01" } })),
    /Approve this purchase order first/,
  )
  assert.equal(service.db.commitments[0].status, "draft")
})

test("create-and-approve by someone who cannot approve writes nothing", async () => {
  const service = org({ permissions: ["commitment.write", "project.read", "org.member"] })
  const before = service.db.commitments.length
  await assert.rejects(service.run(() => createCommitmentWithLine({
    input: { project_id: PROJECT, company_id: id(71), commitment_type: "subcontract", title: "Framing", total_cents: 5_000, status: "approved", prequal_override_note: "ok" },
    line: { description: "Framing", quantity: 1, unit: "LS", unit_cost_cents: 5_000 },
  })))
  assert.equal(service.db.commitments.length, before, "no draft was left behind")
  assert.equal(service.db.commitment_lines.length, 0)
})
