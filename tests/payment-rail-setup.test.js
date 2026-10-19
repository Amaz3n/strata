"use strict"

/**
 * Payment settings (lib/services/payment-rail-setup.ts): who may see the
 * payment rail, who may change it, and who may approve a change to the bank
 * account money is paid from. Managing the rail and approving funding changes
 * are separate duties, and nobody approves their own change.
 *
 * The approver roster is its own service and is replaced here.
 */

const assert = require("node:assert/strict")
const test = require("node:test")

const { createServiceHarness, id, ORG, ACTOR } = require("./support/service")
const { freshRequire, stubModule } = require("./support/modules")

let candidateReads = 0
stubModule("@/lib/services/payment-approvers", {
  getPaymentApprovalRouting: async () => ({ approvers: [], viewerUserId: ACTOR }),
  listPaymentApproverCandidates: async () => {
    candidateReads += 1
    return [{ userId: id(9), name: "Approver", email: null }]
  },
})

const {
  createOrgFundingSetup,
  decidePaymentControlChange,
  getPaymentRailSettings,
  updatePaymentRailPolicy,
} = freshRequire("lib/services/payment-rail-setup.ts")

const OWN_CHANGE = id(4)
const COLLEAGUE_CHANGE = id(5)
const SETTINGS_TABLES = ["payment_rail_policies", "org_funding_sources", "payment_control_change_requests"]

function setup(permissions) {
  candidateReads = 0
  return createServiceHarness({
    permissions,
    tables: {
      payment_rail_policies: [{ org_id: ORG, enabled: true, approval_mode: "dual" }],
      org_funding_sources: [
        {
          id: id(3),
          org_id: ORG,
          provider: "stripe",
          bank_name: "Example bank",
          last4: "1234",
          status: "active",
          verification_status: "verified",
          provider_payment_method_id: "private-provider-reference",
        },
      ],
      payment_control_change_requests: [
        [OWN_CHANGE, ACTOR],
        [COLLEAGUE_CHANGE, id(9)],
      ].map(([changeId, requester]) => ({
        id: changeId,
        org_id: ORG,
        kind: "org_funding_source",
        requested_by_user_id: requester,
        status: "pending_approval",
        required_approvals: 2,
        proposed_masked_details: { bank_name: "Example bank", last4: "1234", private_detail: "Do not return" },
      })),
      payment_control_change_approvals: [],
    },
  })
}

const touchedSettings = (service) => SETTINGS_TABLES.some((table) => service.reads(table).length > 0)

test("payment settings show masked details, and each duty only where it is granted", async () => {
  const cases = [
    ["payment.release", { canManage: false, canApprove: false, canManageAutoApproval: false }],
    ["payment.approve_run", { canManage: false, canApprove: true, canManageAutoApproval: false }],
    ["payment.manage_rail", { canManage: true, canApprove: false, canManageAutoApproval: false }],
    ["*", { canManage: true, canApprove: true, canManageAutoApproval: true }],
  ]
  for (const [permission, duties] of cases) {
    const service = setup([permission])
    const settings = await service.run(() => getPaymentRailSettings())

    assert.deepEqual(
      { canManage: settings.canManage, canApprove: settings.canApprove, canManageAutoApproval: settings.canManageAutoApproval },
      duties,
      permission,
    )
    assert.equal(candidateReads > 0, duties.canManage, `${permission}: only a rail manager sees approver candidates`)
    assert.equal(settings.fundingSources[0].last4, "1234")
    const exposed = JSON.stringify(settings)
    assert.ok(!exposed.includes("private-provider-reference"), permission)
    assert.ok(!exposed.includes("Do not return"), permission)
  }
})

test("nobody can approve their own funding change", async () => {
  const service = setup(["payment.approve_run"])
  const settings = await service.run(() => getPaymentRailSettings())
  const canDecide = Object.fromEntries(settings.controlChanges.map((change) => [change.id, change.canDecide]))
  assert.deepEqual(canDecide, { [OWN_CHANGE]: false, [COLLEAGUE_CHANGE]: true })
})

test("people without a payment duty cannot read payment settings at all", async () => {
  for (const permissions of [[], ["org.member"], ["bill.approve"]]) {
    const service = setup(permissions)
    await assert.rejects(service.run(() => getPaymentRailSettings()), /Missing permission/, permissions.join() || "none")
    assert.equal(touchedSettings(service), false)
  }
})

test("an approver cannot change the policy or start a funding setup", async () => {
  const service = setup(["payment.approve_run"])
  await assert.rejects(service.run(() => updatePaymentRailPolicy({ enabled: false })), /Missing permission: payment.manage_rail/)
  await assert.rejects(service.run(() => createOrgFundingSetup()), /Missing permission: payment.manage_rail/)
  assert.equal(touchedSettings(service), false)
  assert.deepEqual(service.writes(), [])
})

test("a rail manager cannot approve a funding change", async () => {
  const service = setup(["payment.manage_rail"])
  await assert.rejects(
    service.run(() => decidePaymentControlChange({ changeRequestId: COLLEAGUE_CHANGE, decision: "approved" })),
    /Missing permission: payment.approve_run/,
  )
  assert.equal(service.queries.some((query) => query.table.startsWith("rpc:")), false)
  assert.deepEqual(service.writes(), [])
})
