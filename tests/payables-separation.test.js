const assert = require("node:assert/strict")
const { test } = require("node:test")

const { createServiceHarness, id, ORG, ACTOR } = require("./support/service")
const { freshRequire } = require("./support/modules")

const {
  billApprovalViolatesSeparation,
  billEnteredByUserId,
} = require("@/lib/financials/payable-separation")
const { refuseSelfApprovedBills } = freshRequire("lib/services/payable-separation.ts")

const APPROVER_ROLE = id(1)
const PROJECT = id(20)
const OTHER_USER = id(30)

const enteredBy = (userId) => (userId ? { submitted_by_user_id: userId } : {})
const bill = (n, userId) => ({ id: id(100 + n), project_id: PROJECT, metadata: enteredBy(userId) })

function org({ otherApprover }) {
  const service = createServiceHarness({
    tables: {
      role_permissions: [{ role_id: APPROVER_ROLE, permission_key: "bill.approve" }],
      authorization_audit_log: [],
    },
  })
  service.db.memberships[0].role_id = APPROVER_ROLE
  if (otherApprover) {
    service.db.memberships.push({ id: id(2), org_id: ORG, user_id: OTHER_USER, role_id: APPROVER_ROLE, status: "active" })
  }
  return service
}

const refuse = (service, bills) =>
  service.run(() => refuseSelfApprovedBills({ orgId: ORG, userId: ACTOR, bills }))

test("who entered a bill is read from its metadata, and only a real id counts", () => {
  assert.equal(billEnteredByUserId({ submitted_by_user_id: ACTOR }), ACTOR)
  for (const metadata of [null, undefined, {}, { submitted_by_user_id: "" }, { submitted_by_user_id: 7 }]) {
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
  const service = org({ otherApprover: true })
  const mine = bill(1, ACTOR)
  const theirs = bill(2, OTHER_USER)

  const refused = await refuse(service, [mine, theirs])

  assert.deepEqual([...refused], [mine.id])
  assert.equal(service.db.authorization_audit_log.length, 1)
  assert.deepEqual(
    {
      actor: service.db.authorization_audit_log[0].actor_user_id,
      resource: service.db.authorization_audit_log[0].resource_id,
      decision: service.db.authorization_audit_log[0].decision,
      reason: service.db.authorization_audit_log[0].reason_code,
      action: service.db.authorization_audit_log[0].action_key,
    },
    { actor: ACTOR, resource: mine.id, decision: "deny", reason: "deny_separation_of_duties", action: "bill.approve" },
  )
})

test("a one-person AP department can still approve its own bills", async () => {
  const service = org({ otherApprover: false })

  const refused = await refuse(service, [bill(1, ACTOR)])

  assert.equal(refused.size, 0)
  assert.deepEqual(service.db.authorization_audit_log, [])
})

test("a suspended approver does not count as someone else", async () => {
  const service = org({ otherApprover: true })
  service.db.memberships.find((row) => row.user_id === OTHER_USER).status = "suspended"

  assert.equal((await refuse(service, [bill(1, ACTOR)])).size, 0)
})

test("bills nobody keyed in internally are never refused", async () => {
  const service = org({ otherApprover: true })

  assert.equal((await refuse(service, [bill(1, null)])).size, 0)
  assert.deepEqual(service.db.authorization_audit_log, [])
})
