const assert = require("node:assert/strict")
const { beforeEach, test } = require("node:test")

const { createServiceHarness, id } = require("./support/service")
const { freshRequire, stubModule } = require("./support/modules")
const { mobileContext, status } = require("./support/mobile")

const RUN = id(1)

// The payment-run service (its own suite) and the step-up policy. The service
// calls `resolveStepUp` before it records an approval, as the desk's does.
const world = { runs: [], decided: [], stepUpFresh: false, tokens: [] }
stubModule("lib/services/payment-runs.ts", {
  listPaymentRuns: async () => structuredClone(world.runs),
  async decidePaymentRun(input, orgId, options) {
    await options.resolveStepUp()
    world.decided.push({ input, orgId })
    return { status: "approved", release: { kind: "released" } }
  },
})
stubModule("lib/services/payment-step-up.ts", {
  async requireRecentMobilePaymentStepUp(token) {
    world.tokens.push(token)
    if (!world.stepUpFresh) throw new Error("Confirm it's you before releasing money")
  },
})

const { decideMobilePaymentRun, listMobilePaymentRuns } = freshRequire("lib/mobile/payment-runs.ts")

const run = (overrides = {}) => ({
  id: RUN,
  status: "pending_approval",
  can_approve: true,
  total_debit_cents: 150_000,
  payment_count: 2,
  currency: "usd",
  requested_at: "2026-10-05T00:00:00Z",
  scheduled_for: null,
  content_hash: "hash-1",
  approvals: [{ decision: "approved" }, { decision: "rejected" }],
  required_approvals: 2,
  items: [{ billNumber: "B-1", vendorName: "Framing Co", projectName: "Lot 12", vendorAmountCents: 150_000, stage: "awaiting_approval" }],
  ...overrides,
})

function harness() {
  const service = createServiceHarness()
  service.context = mobileContext(service)
  return service
}

beforeEach(() => {
  world.runs = [run(), run({ id: id(2), can_approve: false }), run({ id: id(3), status: "approved" })]
  world.decided.length = 0
  world.tokens.length = 0
  world.stepUpFresh = false
})

test("the phone lists only runs awaiting this person's approval, with the desk's disbursement stage", async () => {
  const service = harness()

  const runs = await service.run(() => listMobilePaymentRuns(service.context))

  assert.deepEqual(runs.map((entry) => entry.id), [RUN])
  assert.equal(runs[0].approvals_recorded, 1)
  assert.equal(runs[0].approvals_required, 2)
  assert.deepEqual(runs[0].bills[0], {
    bill_number: "B-1",
    vendor_name: "Framing Co",
    project_name: "Lot 12",
    amount_cents: 150_000,
    stage: "awaiting_approval",
  })
})

test("releasing money needs a recent step-up on the bearer token", async () => {
  const service = harness()
  const body = { decision: "approved", content_hash: "hash-1" }

  await assert.rejects(
    service.run(() => decideMobilePaymentRun(service.context, RUN, body)),
    (error) => error.status === 422 && /Confirm it's you/.test(error.message),
  )
  assert.deepEqual(world.decided, [])

  world.stepUpFresh = true
  const decision = await service.run(() => decideMobilePaymentRun(service.context, RUN, body))
  assert.equal(decision.status, "approved")
  assert.deepEqual(world.tokens, [service.context.token, service.context.token])
  assert.equal(world.decided[0].input.content_hash, "hash-1")
})

test("a decision without the content hash reviewed, or for a malformed run, is refused", async () => {
  const service = harness()
  await assert.rejects(service.run(() => decideMobilePaymentRun(service.context, RUN, { decision: "approved" })), status(400))
  await assert.rejects(
    service.run(() => decideMobilePaymentRun(service.context, "run-1", { decision: "approved", content_hash: "h" })),
    status(400),
  )
  assert.deepEqual(world.tokens, [])
})
