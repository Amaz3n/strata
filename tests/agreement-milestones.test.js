"use strict"

/**
 * What a sold home owes before it starts or closes (lib/sales/agreement-milestones.ts),
 * how the Sales desk ranks it (lib/sales/next-action.ts), and the signed
 * endpoint's front door (receiveMilestoneReport). Reconciliation itself is the
 * SQL function, covered in agreement-milestones-db.test.js.
 */

require("../scripts/register-ts-node-test")
const test = require("node:test")
const assert = require("node:assert/strict")

const milestones = require("../lib/sales/agreement-milestones")
const { nextActionFor, matchesDealFilter } = require("../lib/sales/next-action")
const { createFakeSupabase } = require("./support/fake-supabase")
const { stubModule, ORG } = require("./support/starts-harness")

const row = (overrides) => ({ id: "m1", title: "Loan approval issued", kind: "loan_approval", status: "open", requiredBefore: "closing", dueOn: "2026-10-20", evidenceRequired: true, evidenceFileId: null, reportedStatus: null, createdAt: "2026-10-01", dependsOn: [], ...overrides })

test("aging reads late, soon and scheduled from the due date, and nothing once resolved", () => {
  const today = "2026-10-12"
  assert.deepEqual(milestones.milestoneAging(row({ dueOn: "2026-10-08" }), today), { openDays: 11, overdueDays: 4, dueInDays: null, tone: "late" })
  assert.equal(milestones.milestoneAging(row({ dueOn: "2026-10-14" }), today).tone, "soon")
  assert.equal(milestones.milestoneAging(row({ dueOn: "2026-11-01" }), today).tone, "scheduled")
  assert.equal(milestones.milestoneAging(row({ dueOn: null }), today).tone, "scheduled")
  assert.equal(milestones.milestoneAging(row({ status: "satisfied" }), today).tone, "none")
})

test("a milestone is satisfied only after its prerequisites and with evidence when it needs it", () => {
  const all = [row({ id: "a", title: "Appraisal received" }), row({ id: "b", title: "Title commitment issued", status: "waived" })]
  const ctc = row({ id: "c", title: "Lender clear to close", dependsOn: ["a", "b"] })
  assert.equal(milestones.satisfyRefusal(ctc, all, "file"), "Resolve Appraisal received first; this milestone depends on it")
  all[0].status = "satisfied"
  assert.equal(milestones.satisfyRefusal(ctc, all, null), "Attach the evidence file from this home to satisfy it")
  assert.equal(milestones.satisfyRefusal(ctc, all, "file"), null)
  assert.equal(milestones.satisfyRefusal({ ...ctc, evidenceRequired: false }, all, null), null)
})

test("only open or failed milestones required before a gate hold it, failed first", () => {
  const rows = [
    row({ title: "Tracked", requiredBefore: null }),
    row({ title: "Appraisal", dueOn: "2026-10-30" }),
    row({ title: "Home sale", status: "failed", dueOn: null }),
    row({ title: "Waived", status: "waived" }),
    row({ title: "Start only", requiredBefore: "start" }),
  ]
  assert.deepEqual(milestones.gateBlockers(rows, "closing").map((item) => item.title), ["Home sale", "Appraisal"])
  assert.deepEqual(milestones.gateBlockers(rows, "start").map((item) => item.title), ["Start only"])
})

test("each reminder threshold is announced once, the tightest crossed first", () => {
  assert.equal(milestones.milestoneReminderThreshold("2026-10-30", "2026-10-12", {}), null)
  assert.equal(milestones.milestoneReminderThreshold("2026-10-17", "2026-10-12", {}), 7)
  assert.equal(milestones.milestoneReminderThreshold("2026-10-17", "2026-10-12", { reminded_7d_at: "x" }), null)
  assert.equal(milestones.milestoneReminderThreshold("2026-10-10", "2026-10-12", { reminded_7d_at: "x", reminded_1d_at: "x" }), 0)
  assert.equal(milestones.milestoneReminderThreshold("2026-10-10", "2026-10-12", { reminded_0d_at: "x" }), null)
})

const deal = (overrides) => ({ stage: "building", nextFollowUpAt: null, closingScheduledDate: "2026-12-01", projectId: "p1", contractStatus: "active", openGateCount: 0, createdAt: "2026-06-01", ...overrides })

test("on the Sales desk a late or failed milestone outranks the closing date it threatens", () => {
  const now = new Date("2026-10-12T15:00:00Z")
  const late = milestones.milestoneDeskSignal([row({ dueOn: "2026-10-08" }), row({ title: "Appraisal received", dueOn: "2026-10-25" })], "2026-10-12")
  assert.deepEqual(nextActionFor(deal({}), now, late), { label: "Chase Loan approval issued", detail: "4 days late", dueAt: "2026-10-08", tone: "overdue" })
  const failed = milestones.milestoneDeskSignal([row({ title: "Sale of buyer home", status: "failed" })], "2026-10-12")
  assert.equal(nextActionFor(deal({ stage: "closing" }), now, failed).label, "Sale of buyer home failed")
  const distant = milestones.milestoneDeskSignal([row({ dueOn: "2026-11-30" })], "2026-10-12")
  assert.equal(nextActionFor(deal({}), now, distant).label, "Closing")
  assert.equal(nextActionFor(deal({ stage: "working", nextFollowUpAt: "2026-10-20" }), now, late).label, "Follow up")
  assert.equal(matchesDealFilter(deal({}), "milestones_overdue", now, late), true)
  assert.equal(matchesDealFilter(deal({}), "milestones_overdue", now, distant), false)
  assert.equal(matchesDealFilter(deal({ stage: "closed" }), "milestones_overdue", now, late), false)
})

test("a routed lead nobody owns sits under Unassigned until someone takes it", () => {
  const now = new Date("2026-10-12T15:00:00Z")
  const lead = (overrides) => deal({ stage: "inquiry", projectId: null, prospectId: "lead-1", ownerUserId: null, ...overrides })
  assert.equal(matchesDealFilter(lead({}), "unassigned", now), true)
  assert.equal(matchesDealFilter(lead({ ownerUserId: "pat" }), "unassigned", now), false)
  assert.equal(matchesDealFilter(lead({ stage: "lost" }), "unassigned", now), false)
  assert.equal(matchesDealFilter(lead({ prospectId: null }), "unassigned", now), false, "an imported agreement has no lead to hand out")
})

test("an unknown feed or a bad signature learns nothing and the rejection is counted; the delivery id is signed", async () => {
  process.env.TOKEN_ENCRYPTION_KEY = "0".repeat(64)
  const { encryptIntegrationSecret } = require("../lib/integrations/secrets")
  const { signInboundPayload } = require("../lib/inbound/signature")
  const db = createFakeSupabase({
    agreement_milestone_sources: [{ id: ORG, org_id: ORG, public_id: `ams_${"a".repeat(24)}`, status: "active", signing_secret_encrypted: encryptIntegrationSecret("secret-1"), previous_secret_encrypted: null, previous_secret_expires_at: null, rejected_count: 0 }],
  }, {
    apply_agreement_milestone_report: async (args) => ({ data: { outcome: "refused", reason_code: "buyer_mismatch", delivery_id: ORG, milestone_id: null }, error: null, args }),
    record_agreement_milestone_rejection: async (args) => {
      const source = db.store.agreement_milestone_sources.find((row) => row.id === args.p_source_id)
      source.rejected_count += 1
      source.last_rejection_reason = args.p_reason
      return { data: null, error: null }
    },
  })
  stubModule("@/lib/supabase/server", { createServiceSupabaseClient: () => db })
  delete require.cache[require.resolve("../lib/services/agreement-milestones")]
  const { receiveMilestoneReport } = require("../lib/services/agreement-milestones")
  const now = new Date("2026-10-12T15:00:00Z"), timestamp = String(Math.floor(now.getTime() / 1000)), rawBody = JSON.stringify({ delivery_id: "d-1" })
  const input = { sourcePublicId: `ams_${"a".repeat(24)}`, deliveryId: "d-1", timestamp, rawBody, now }

  assert.equal((await receiveMilestoneReport({ ...input, sourcePublicId: `ams_${"b".repeat(24)}`, signature: signInboundPayload("secret-1", timestamp, rawBody) })).status, 401)
  assert.equal((await receiveMilestoneReport({ ...input, signature: signInboundPayload("wrong", timestamp, rawBody) })).status, 401)
  assert.equal(db.store.agreement_milestone_sources[0].rejected_count, 1)
  assert.equal(db.store.agreement_milestone_sources[0].last_rejection_reason, "bad_signature")

  const refused = await receiveMilestoneReport({ ...input, signature: signInboundPayload("secret-1", timestamp, rawBody) })
  assert.deepEqual(refused, { status: 422, body: { outcome: "refused", reason_code: "buyer_mismatch" } })

  // The delivery id is the signed body's: a captured report re-sent under a new header id is refused.
  const replayed = await receiveMilestoneReport({ ...input, deliveryId: "d-2", signature: signInboundPayload("secret-1", timestamp, rawBody) })
  assert.equal(replayed.status, 400)
  const unnamed = await receiveMilestoneReport({ ...input, rawBody: "{}", signature: signInboundPayload("secret-1", timestamp, "{}") })
  assert.equal(unnamed.status, 400)
})
