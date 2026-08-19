require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const { commitmentExecutionSchema } = require("../lib/validation/commitments")
const {
  bucketCommitmentChangeOrderRows,
  buildCommitmentRegister,
  composeCommitmentPosition,
  emptyCommitmentBillRollup,
  emptyCommitmentChangeOrderTotals,
  isCommitmentAwaitingExecution,
  matchesCommitmentRegisterFlag,
  summarizeCommitmentBillRows,
} = require("../lib/financials/commitment-position")

const bill = (overrides = {}) => ({
  commitment_id: "c1",
  status: "approved",
  total_cents: 100_00,
  paid_cents: 0,
  retainage_cents: 0,
  metadata: {},
  ...overrides,
})

/** Compose a register row from raw rows the way the service does. */
const position = (commitment, bills = [], changeOrders = []) => {
  const billRollups = summarizeCommitmentBillRows(bills)
  const coTotals = bucketCommitmentChangeOrderRows(changeOrders)
  const id = commitment.id ?? "c1"
  return composeCommitmentPosition(
    commitment,
    billRollups.get(id) ?? emptyCommitmentBillRollup(),
    coTotals.get(id) ?? emptyCommitmentChangeOrderTotals(),
  )
}

const row = (overrides = {}) =>
  position(
    {
      id: "c1",
      project_id: "p1",
      project_name: "Lot 12",
      status: "approved",
      commitment_type: "subcontract",
      total_cents: 100_00,
      ...overrides,
    },
    overrides.bills ?? [],
    overrides.changeOrders ?? [],
  )

test("a draft payable is not yet a claim on the contract", () => {
  const rollups = summarizeCommitmentBillRows([
    bill({ metadata: { creation_state: "draft" } }),
    bill({ total_cents: 40_00 }),
  ])
  assert.equal(rollups.get("c1").billed, 40_00)
  assert.equal(rollups.get("c1").billCount, 1)
})

test("a rejected bill never drew the contract down", () => {
  const rollups = summarizeCommitmentBillRows([
    bill({ status: "rejected", total_cents: 90_00 }),
    bill({ total_cents: 10_00 }),
  ])
  assert.equal(rollups.get("c1").billed, 10_00)
})

test("billed spans submitted bills while approved billed stays books-true", () => {
  const rollups = summarizeCommitmentBillRows([
    bill({ status: "approved", total_cents: 60_00 }),
    bill({ status: "pending", total_cents: 25_00 }),
  ])
  const composed = position({ total_cents: 100_00 }, [
    bill({ status: "approved", total_cents: 60_00 }),
    bill({ status: "pending", total_cents: 25_00 }),
  ])
  assert.equal(rollups.get("c1").billed, 85_00)
  assert.equal(rollups.get("c1").approvedBilled, 60_00)
  assert.equal(composed.pending_billed_cents, 25_00)
  assert.equal(composed.remaining_cents, 15_00)
})

test("vendor credits net the claim down without paying the contract", () => {
  const composed = position({ total_cents: 100_00 }, [
    bill({ total_cents: 80_00, paid_cents: 80_00, retainage_cents: 8_00 }),
    bill({
      total_cents: -30_00,
      paid_cents: -30_00,
      retainage_cents: 5_00,
      metadata: { source: "vendor_credit" },
    }),
  ])
  assert.equal(composed.billed_cents, 50_00)
  assert.equal(composed.paid_cents, 80_00)
  assert.equal(composed.retainage_held_cents, 8_00, "credit retainage is not held on the contract")
  assert.equal(composed.bill_count, 1)
  assert.equal(composed.remaining_cents, 50_00)
})

test("retainage is only held once a bill is booked", () => {
  const composed = position({ total_cents: 100_00 }, [
    bill({ status: "pending", total_cents: 50_00, retainage_cents: 5_00 }),
  ])
  assert.equal(composed.retainage_held_cents, 0)
})

test("approved change orders revise the total, pending ones stay exposure", () => {
  const composed = position({ total_cents: 100_00 }, [], [
    { commitment_id: "c1", status: "approved", total_cents: 20_00 },
    { commitment_id: "c1", status: "sent", total_cents: 15_00 },
    { commitment_id: "c1", status: "draft", total_cents: 5_00 },
    { commitment_id: "c1", status: "voided", total_cents: 99_00 },
    { commitment_id: "c1", status: "rejected", total_cents: 77_00 },
  ])
  assert.equal(composed.approved_change_orders_cents, 20_00)
  assert.equal(composed.pending_change_orders_cents, 20_00)
  assert.equal(composed.revised_total_cents, 120_00)
})

test("remaining is signed so over-billing is visible", () => {
  const composed = position({ total_cents: 100_00 }, [bill({ total_cents: 130_00 })])
  assert.equal(composed.remaining_cents, -30_00)
  assert.ok(matchesCommitmentRegisterFlag(composed, "over_billed"))
})

test("a commitment billed to its revised total is not over-billed", () => {
  const composed = position(
    { total_cents: 100_00 },
    [bill({ total_cents: 120_00 })],
    [{ commitment_id: "c1", status: "approved", total_cents: 20_00 }],
  )
  assert.equal(composed.remaining_cents, 0)
  assert.equal(matchesCommitmentRegisterFlag(composed, "over_billed"), false)
})

test("only approved unsigned subcontracts await execution", () => {
  assert.ok(isCommitmentAwaitingExecution({ commitment_type: "subcontract", status: "approved" }))
  assert.equal(
    isCommitmentAwaitingExecution({ commitment_type: "purchase_order", status: "approved" }),
    false,
    "purchase orders are issued without signature",
  )
  assert.equal(
    isCommitmentAwaitingExecution({ commitment_type: "subcontract", status: "draft" }),
    false,
  )
  assert.equal(
    isCommitmentAwaitingExecution({
      commitment_type: "subcontract",
      status: "approved",
      executed_at: "2026-07-01",
    }),
    false,
  )
})

test("register rollup totals only the filtered rows", () => {
  const rows = [
    row({ id: "c1", project_id: "p1", total_cents: 100_00 }),
    row({ id: "c2", project_id: "p2", project_name: "Lot 13", total_cents: 250_00 }),
  ]
  const all = buildCommitmentRegister(rows)
  assert.equal(all.rollup.committed_cents, 350_00)
  assert.equal(all.rollup.commitment_count, 2)

  const scoped = buildCommitmentRegister(rows, { projectId: "p2" })
  assert.equal(scoped.rollup.committed_cents, 250_00)
  assert.equal(scoped.rows.length, 1)
})

test("exception counts span the whole register even while filtered", () => {
  const rows = [
    row({ id: "c1", bills: [bill({ commitment_id: "c1", total_cents: 130_00 })] }),
    row({ id: "c2", project_id: "p2", executed_at: "2026-07-01" }),
  ]
  const filtered = buildCommitmentRegister(rows, { projectId: "p2" })
  assert.equal(filtered.rows.length, 1)
  assert.equal(filtered.exceptions.over_billed, 1, "the chip must not vanish under a filter")
  assert.equal(filtered.exceptions.awaiting_execution, 1)
})

test("facets come from the unfiltered set and statuses keep lifecycle order", () => {
  const register = buildCommitmentRegister([
    row({ id: "c1", status: "complete" }),
    row({ id: "c2", status: "draft", project_id: "p2", project_name: "Alpha" }),
    row({ id: "c3", status: "approved", commitment_type: "purchase_order" }),
  ])
  assert.deepEqual(register.facets.statuses, ["draft", "approved", "complete"])
  assert.deepEqual(register.facets.types, ["purchase_order", "subcontract"])
  assert.deepEqual(
    register.facets.projects.map((project) => project.name),
    ["Alpha", "Lot 12"],
    "projects are name-sorted",
  )
})

test("paging clamps out-of-range pages instead of returning nothing", () => {
  const rows = Array.from({ length: 5 }, (_, index) => row({ id: `c${index}` }))
  const register = buildCommitmentRegister(rows, { page: 99, pageSize: 2 })
  assert.equal(register.pagination.pageCount, 3)
  assert.equal(register.pagination.page, 3)
  assert.equal(register.rows.length, 1)

  const empty = buildCommitmentRegister([], { page: 4 })
  assert.equal(empty.pagination.page, 1)
  assert.equal(empty.pagination.pageCount, 1)
  assert.equal(empty.rows.length, 0)
})

test("type and status filters combine", () => {
  const rows = [
    row({ id: "c1", commitment_type: "purchase_order", status: "approved" }),
    row({ id: "c2", commitment_type: "purchase_order", status: "draft" }),
    row({ id: "c3", commitment_type: "subcontract", status: "approved" }),
  ]
  const register = buildCommitmentRegister(rows, {
    types: ["purchase_order"],
    statuses: ["approved"],
  })
  assert.deepEqual(
    register.rows.map((entry) => entry.id),
    ["c1"],
  )
})

test("recording execution requires the signed agreement", () => {
  const withoutFile = commitmentExecutionSchema.safeParse({ executed_at: "2026-07-01" })
  assert.equal(withoutFile.success, false)

  const withFile = commitmentExecutionSchema.safeParse({
    executed_file_id: "6f1b8f1e-6a1e-4a1e-8a1e-6a1e4a1e8a1e",
    executed_at: "2026-07-01",
  })
  assert.ok(withFile.success)
})

test("an agreement cannot be executed in the future or on a malformed date", () => {
  const fileId = "6f1b8f1e-6a1e-4a1e-8a1e-6a1e4a1e8a1e"
  const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

  assert.equal(
    commitmentExecutionSchema.safeParse({ executed_file_id: fileId, executed_at: future }).success,
    false,
  )
  assert.equal(
    commitmentExecutionSchema.safeParse({ executed_file_id: fileId, executed_at: "07/01/2026" })
      .success,
    false,
  )
  assert.equal(
    commitmentExecutionSchema.safeParse({ executed_file_id: fileId, executed_at: "2026-13-45" })
      .success,
    false,
    "a well-shaped but impossible date is still rejected",
  )
  assert.ok(
    commitmentExecutionSchema.safeParse({
      executed_file_id: fileId,
      executed_at: new Date().toISOString().slice(0, 10),
      note: "Original in the Naples office file cabinet.",
    }).success,
  )
})

test("bills against other commitments never leak into a position", () => {
  const rollups = summarizeCommitmentBillRows([
    bill({ commitment_id: "c1", total_cents: 10_00 }),
    bill({ commitment_id: "c2", total_cents: 90_00 }),
    bill({ commitment_id: null, total_cents: 70_00 }),
  ])
  assert.equal(rollups.get("c1").billed, 10_00)
  assert.equal(rollups.get("c2").billed, 90_00)
  assert.equal(rollups.size, 2)
})
