const assert = require("node:assert/strict")
const { test } = require("node:test")

const { createServiceHarness, id, ORG, ACTOR } = require("./support/service")
const { freshRequire } = require("./support/modules")

const {
  billApprovalViolatesSeparation,
  billEnteredByUserId,
} = require("@/lib/financials/separation-of-duties")
const { refuseSelfApprovedBills } = freshRequire("lib/services/separation-of-duties.ts")
const { decidePaymentRun } = freshRequire("lib/services/payment-runs.ts")
const { approveBudgetTransfer } = freshRequire("lib/services/budget-transfers.ts")
const { approveCommitmentChangeOrder } = freshRequire("lib/services/commitment-change-orders.ts")

const APPROVER_ROLE = id(1)
const PROJECT = id(20)
const DIVISION = id(21)
const OTHER_DIVISION = id(22)
const OTHER_USER = id(30)
const OTHER_MEMBERSHIP = id(31)

const enteredBy = (userId) => (userId ? { submitted_by_user_id: userId } : {})
const bill = (n, userId) => ({ id: id(100 + n), project_id: PROJECT, metadata: enteredBy(userId) })

/** The other approver's membership, scoped to `divisions` when given. */
function otherApprover({ divisions } = {}) {
  return {
    membership: {
      id: OTHER_MEMBERSHIP,
      org_id: ORG,
      user_id: OTHER_USER,
      role_id: APPROVER_ROLE,
      status: "active",
      project_scope: "all",
      division_scope: divisions ? "assigned" : "all",
      role: { permissions: [{ permission_key: "bill.approve" }, { permission_key: "project.read" }] },
    },
    divisions: (divisions ?? []).map((division_id) => ({ membership_id: OTHER_MEMBERSHIP, division_id })),
  }
}

function org({ other } = {}) {
  const service = createServiceHarness({
    tables: {
      role_permissions: [{ role_id: APPROVER_ROLE, permission_key: "bill.approve" }],
      projects: [{ id: PROJECT, org_id: ORG, division_id: DIVISION }],
      authorization_audit_log: [],
    },
  })
  service.db.memberships[0].role_id = APPROVER_ROLE
  if (other) {
    service.db.memberships.push(other.membership)
    service.db.membership_divisions.push(...other.divisions)
  }
  return service
}

const refuse = (service, bills) =>
  service.run(() => refuseSelfApprovedBills({ orgId: ORG, userId: ACTOR, bills }))

/** The separation refusals written to the authorization log, by what they refused. */
const separationDenials = (service) =>
  service.db.authorization_audit_log
    .filter((row) => row.reason_code === "deny_separation_of_duties")
    .map((row) => ({ actor: row.actor_user_id, action: row.action_key, resource: row.resource_id, decision: row.decision, rule: row.context.rule }))

test("who entered a bill is its enterer or the person who uploaded its invoice, and only a real id counts", () => {
  assert.equal(billEnteredByUserId({ submitted_by_user_id: ACTOR }), ACTOR)
  assert.equal(billEnteredByUserId({ internal_upload: true, intake: { actor_id: ACTOR } }), ACTOR)
  for (const metadata of [
    null,
    undefined,
    {},
    { submitted_by_user_id: "" },
    { submitted_by_user_id: 7 },
    { intake: { actor_id: ACTOR } },
  ]) {
    assert.equal(billEnteredByUserId(metadata), null)
  }
})

test("separation only binds when someone else could approve", () => {
  const metadata = enteredBy(ACTOR)
  assert.equal(billApprovalViolatesSeparation({ metadata, approverUserId: ACTOR, anotherApproverExists: true }), true)
  assert.equal(billApprovalViolatesSeparation({ metadata, approverUserId: ACTOR, anotherApproverExists: false }), false)
  assert.equal(billApprovalViolatesSeparation({ metadata, approverUserId: OTHER_USER, anotherApproverExists: true }), false)
})

test("an approver who entered a bill is refused when another approver exists, and the attempt is audited", async () => {
  const service = org({ other: otherApprover() })
  const mine = bill(1, ACTOR)
  const theirs = bill(2, OTHER_USER)

  const refused = await refuse(service, [mine, theirs])

  assert.deepEqual([...refused], [mine.id])
  assert.deepEqual(separationDenials(service), [
    { actor: ACTOR, action: "bill.approve", resource: mine.id, decision: "deny", rule: "bill.enterer_cannot_approve" },
  ])
})

test("a one-person AP department can still approve its own bills", async () => {
  const service = org()

  const refused = await refuse(service, [bill(1, ACTOR)])

  assert.equal(refused.size, 0)
  assert.deepEqual(service.db.authorization_audit_log, [])
})

test("a suspended approver does not count as someone else", async () => {
  const service = org({ other: otherApprover() })
  service.db.memberships.find((row) => row.user_id === OTHER_USER).status = "suspended"

  assert.equal((await refuse(service, [bill(1, ACTOR)])).size, 0)
})

test("an approver who cannot reach the bill's project does not count as someone else", async () => {
  const outsideDivision = org({ other: otherApprover({ divisions: [OTHER_DIVISION] }) })
  assert.equal((await refuse(outsideDivision, [bill(1, ACTOR)])).size, 0)

  const insideDivision = org({ other: otherApprover({ divisions: [DIVISION] }) })
  assert.equal((await refuse(insideDivision, [bill(1, ACTOR)])).size, 1)
})

test("bills nobody keyed in internally are never refused", async () => {
  const service = org({ other: otherApprover() })

  assert.equal((await refuse(service, [bill(1, null)])).size, 0)
  assert.deepEqual(service.db.authorization_audit_log, [])
})

test("the preparer of a payment run cannot decide it, and the attempt is audited", async () => {
  const RUN = id(40)
  const HASH = "a".repeat(64)
  const service = createServiceHarness({
    permissions: ["payment.approve_run"],
    tables: {
      payment_runs: [{ id: RUN, org_id: ORG, requested_by: ACTOR, status: "pending_approval", control_snapshot: {}, content_hash: HASH }],
      payment_run_items: [],
      authorization_audit_log: [],
    },
  })

  await assert.rejects(
    service.run(() =>
      decidePaymentRun({ run_id: RUN, decision: "approved", content_hash: HASH }, ORG, {
        resolveStepUp: async () => new Date().toISOString(),
      }),
    ),
    /someone else has to approve it/,
  )

  assert.deepEqual(separationDenials(service), [
    { actor: ACTOR, action: "payment.approve_run", resource: RUN, decision: "deny", rule: "payment_run.preparer_cannot_approve" },
  ])
  assert.deepEqual(service.writes().filter((query) => query.table.startsWith("rpc:")), [])
})

test("the requester of a budget transfer cannot approve it, and the attempt is audited", async () => {
  const TRANSFER = id(50)
  const service = createServiceHarness({
    permissions: ["budget.approve", "project.read"],
    tables: {
      projects: [{ id: PROJECT, org_id: ORG, division_id: null }],
      budget_transfers: [
        { id: TRANSFER, org_id: ORG, project_id: PROJECT, transfer_number: 1, status: "pending_approval", requested_by: ACTOR, metadata: {}, lines: [] },
      ],
      authorization_audit_log: [],
    },
  })

  await assert.rejects(service.run(() => approveBudgetTransfer(TRANSFER)), /cannot approve their own/)

  assert.deepEqual(separationDenials(service), [
    { actor: ACTOR, action: "budget.approve", resource: TRANSFER, decision: "deny", rule: "budget_transfer.requester_cannot_approve" },
  ])
  assert.deepEqual(service.writes(), [])
})

test("the requester of a variance order cannot approve it, and the attempt is audited", async () => {
  const VPO = id(60)
  const service = createServiceHarness({
    permissions: ["project.read", "vpo.approve", "vpo.approve_large"],
    tables: {
      projects: [{ id: PROJECT, org_id: ORG }],
      commitment_change_orders: [
        { id: VPO, org_id: ORG, project_id: PROJECT, commitment_id: id(61), title: "VPO", status: "draft", total_cents: 25_000, reason_code_id: id(62), requested_by: ACTOR, metadata: {} },
      ],
      commitment_change_order_lines: [],
      commitments: [{ id: id(61), org_id: ORG, project_id: PROJECT, commitment_type: "purchase_order", status: "approved", title: "PO" }],
      authorization_audit_log: [],
    },
  })

  await assert.rejects(service.run(() => approveCommitmentChangeOrder({ commitmentChangeOrderId: VPO })), /someone other than/)

  assert.deepEqual(separationDenials(service), [
    { actor: ACTOR, action: "vpo.approve", resource: VPO, decision: "deny", rule: "variance_order.requester_cannot_approve" },
  ])
  assert.equal(service.db.commitment_change_orders[0].status, "draft")
})

const { updateCommitment, markCommitmentExecutedFromEnvelope } = freshRequire("lib/services/commitments.ts")
const { assertCommitmentExecutable } = freshRequire("lib/services/subcontract-execution.ts")

const COMMITMENT = id(70)

/** An org with a draft commitment created by `createdBy` (none for a generated one). */
function commitmentOrg({ createdBy, other } = {}) {
  const service = createServiceHarness({
    permissions: ["commitment.write", "commitment.approve", "project.read", "org.member"],
    tables: {
      role_permissions: [{ role_id: APPROVER_ROLE, permission_key: "commitment.approve" }],
      projects: [{ id: PROJECT, org_id: ORG, division_id: DIVISION }],
      commitments: [
        {
          id: COMMITMENT, org_id: ORG, project_id: PROJECT, company_id: id(71), commitment_type: "purchase_order",
          title: "PO", status: "draft", total_cents: 10_000, currency: "usd",
          metadata: createdBy ? { created_by_user_id: createdBy } : {},
        },
      ],
      commitment_lines: [],
      authorization_audit_log: [],
    },
  })
  service.db.memberships[0].role_id = APPROVER_ROLE
  if (other) {
    service.db.memberships.push(other.membership)
    service.db.membership_divisions.push(...other.divisions)
  }
  return service
}

const commitmentApprover = (options) => {
  const other = otherApprover(options)
  other.membership.role.permissions = [{ permission_key: "commitment.approve" }, { permission_key: "project.read" }]
  return other
}

const approveCommitment = (service) =>
  service.run(() => updateCommitment({ commitmentId: COMMITMENT, input: { status: "approved", prequal_override_note: "Known vendor" } }))

test("the creator of a commitment cannot approve it when another approver can reach it, and the attempt is audited", async () => {
  const service = commitmentOrg({ createdBy: ACTOR, other: commitmentApprover() })

  await assert.rejects(approveCommitment(service), /someone else has to approve it/)

  assert.deepEqual(separationDenials(service), [
    { actor: ACTOR, action: "commitment.approve", resource: COMMITMENT, decision: "deny", rule: "commitment.creator_cannot_approve" },
  ])
  assert.equal(service.db.commitments[0].status, "draft")
})

test("a one-person shop can approve the commitment it created", async () => {
  const service = commitmentOrg({ createdBy: ACTOR })

  await approveCommitment(service)

  assert.equal(service.db.commitments[0].status, "approved")
  assert.deepEqual(separationDenials(service), [])
})

test("a person can approve a commitment nobody created, such as a generated purchase order", async () => {
  const service = commitmentOrg({ other: commitmentApprover() })

  await approveCommitment(service)

  assert.equal(service.db.commitments[0].status, "approved")
})

test("an approver outside the commitment's division does not stop its creator approving it", async () => {
  const service = commitmentOrg({ createdBy: ACTOR, other: commitmentApprover({ divisions: [OTHER_DIVISION] }) })

  await approveCommitment(service)

  assert.equal(service.db.commitments[0].status, "approved")
})

test("a draft purchase order cannot skip approval by being moved to complete", async () => {
  const service = commitmentOrg({ createdBy: ACTOR, other: commitmentApprover() })

  await assert.rejects(
    service.run(() => updateCommitment({ commitmentId: COMMITMENT, input: { status: "complete" } })),
    /Approve it first/,
  )

  assert.equal(service.db.commitments[0].status, "draft")
  assert.deepEqual(separationDenials(service), [])
})

test("a commitment cannot be sent for signature until it is approved, so its creator cannot route around approval", async () => {
  const service = commitmentOrg({ createdBy: ACTOR, other: commitmentApprover() })
  const sendForSignature = () =>
    service.run(() =>
      assertCommitmentExecutable({ supabase: service.client, orgId: ORG, commitmentId: COMMITMENT, action: "sending the subcontract for signature" }),
    )

  await assert.rejects(sendForSignature(), /Approve this commitment before sending the subcontract for signature/)

  service.db.commitments[0].status = "approved"
  await sendForSignature()
})

test("a vendor's signature on a commitment that went back to draft records execution but approves nothing", async () => {
  const service = commitmentOrg({ createdBy: ACTOR, other: commitmentApprover() })

  await service.run(() =>
    markCommitmentExecutedFromEnvelope({ orgId: ORG, commitmentId: COMMITMENT, envelopeId: id(72), documentId: id(73), executedFileId: id(74), signerName: "Vendor" }),
  )

  assert.equal(service.db.commitments[0].status, "draft")
  assert.ok(service.db.commitments[0].executed_at)
})
