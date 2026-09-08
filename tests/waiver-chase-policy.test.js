require("../scripts/register-ts-node-test");

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  maxWaiverChaseAttempts,
  planWaiverChase,
  readLastWaiverChase,
  waiverChaseKind,
} = require("../lib/payments/waiver-chase-policy");

const NOW = "2026-09-20T12:00:00.000Z";

function facts(overrides = {}) {
  return {
    billId: "bill-1",
    projectId: "project-1",
    waiverRequired: true,
    waiverReceived: false,
    paidInFull: false,
    paidAt: null,
    hasUnconditional: false,
    hasVendorEmail: true,
    lastChase: null,
    ...overrides,
  };
}

function daysAgo(days) {
  return new Date(Date.parse(NOW) - days * 86_400_000).toISOString();
}

test("nothing is chased when nothing is owed", () => {
  assert.equal(waiverChaseKind(facts({ waiverRequired: false })), null);
  assert.equal(waiverChaseKind(facts({ projectId: null })), null);
  // Received and unpaid: the release document is in hand and no other is due yet.
  assert.equal(waiverChaseKind(facts({ waiverReceived: true })), null);
  // Received, paid, and the unconditional waiver is already on file.
  assert.equal(
    waiverChaseKind(facts({ waiverReceived: true, paidInFull: true, hasUnconditional: true })),
    null,
  );
});

test("the releasing waiver is chased before the record-keeping one", () => {
  assert.equal(waiverChaseKind(facts()), "signature");
  // A payable that got paid without its waiver is a gap in the record, so the
  // signature chase keeps going rather than switching to the unconditional ask.
  assert.equal(waiverChaseKind(facts({ paidInFull: true, paidAt: daysAgo(5) })), "signature");
  assert.equal(
    waiverChaseKind(facts({ waiverReceived: true, paidInFull: true, paidAt: daysAgo(5) })),
    "unconditional",
  );
});

test("a vendor with no email is never chased", () => {
  assert.equal(planWaiverChase(facts({ hasVendorEmail: false }), NOW), null);
});

test("the first signature chase goes out at once, then backs off", () => {
  const first = planWaiverChase(facts(), NOW);
  assert.deepEqual(first, { billId: "bill-1", projectId: "project-1", kind: "signature", attempt: 1 });

  // Asked yesterday: the three-day wait has not passed.
  assert.equal(
    planWaiverChase(facts({ lastChase: { kind: "signature", at: daysAgo(1), attempt: 1 } }), NOW),
    null,
  );
  const second = planWaiverChase(
    facts({ lastChase: { kind: "signature", at: daysAgo(3), attempt: 1 } }),
    NOW,
  );
  assert.equal(second.attempt, 2);
  assert.equal(second.kind, "signature");
});

test("chasing stops after the last attempt instead of nagging forever", () => {
  const attempts = maxWaiverChaseAttempts("signature");
  assert.equal(
    planWaiverChase(
      facts({ lastChase: { kind: "signature", at: daysAgo(90), attempt: attempts } }),
      NOW,
    ),
    null,
  );
  assert.equal(maxWaiverChaseAttempts("unconditional") < attempts, true);
});

test("the unconditional waiver is asked for after payment, not the moment it clears", () => {
  const paidToday = facts({ waiverReceived: true, paidInFull: true, paidAt: daysAgo(0) });
  assert.equal(planWaiverChase(paidToday, NOW), null);

  const paidLastWeek = facts({ waiverReceived: true, paidInFull: true, paidAt: daysAgo(7) });
  const plan = planWaiverChase(paidLastWeek, NOW);
  assert.equal(plan.kind, "unconditional");
  assert.equal(plan.attempt, 1);
});

test("a signature chase does not spend the unconditional chase's attempts", () => {
  const plan = planWaiverChase(
    facts({
      waiverReceived: true,
      paidInFull: true,
      paidAt: daysAgo(30),
      lastChase: { kind: "signature", at: daysAgo(20), attempt: 4 },
    }),
    NOW,
  );
  assert.equal(plan.kind, "unconditional");
  assert.equal(plan.attempt, 1);
});

test("malformed chase metadata reads as never chased rather than as an error", () => {
  assert.equal(readLastWaiverChase(null), null);
  assert.equal(readLastWaiverChase({ waiver_chase: "yesterday" }), null);
  assert.equal(readLastWaiverChase({ waiver_chase: { kind: "signature" } }), null);
  assert.equal(readLastWaiverChase({ waiver_chase: { kind: "other", at: NOW, attempt: 1 } }), null);
  assert.deepEqual(readLastWaiverChase({ waiver_chase: { kind: "signature", at: NOW, attempt: 2 } }), {
    kind: "signature",
    at: NOW,
    attempt: 2,
  });
});

test("the sweep asks the policy rather than deciding for itself, and is bounded", () => {
  const sweep = fs.readFileSync(path.join(__dirname, "../lib/services/waiver-chase.ts"), "utf8");
  assert.match(sweep, /planWaiverChase\(facts, nowIso\)/);
  assert.match(sweep, /BILL_SCAN_LIMIT/);
  assert.match(sweep, /CHASE_HORIZON_DAYS/);
  // One live chase per payable, so a slow run cannot mail a vendor twice.
  assert.match(sweep, /dedupeByPayloadKeys: \["bill_id"\]/);
  // One org's bad data must not stop the rest.
  assert.match(sweep, /org sweep failed/);
});

test("the chase runs daily from the job that already chases payment documents", () => {
  const cron = fs.readFileSync(path.join(__dirname, "../app/api/jobs/compliance-autopilot/route.ts"), "utf8");
  assert.match(cron, /sweepWaiverChases/);
  const outbox = fs.readFileSync(path.join(__dirname, "../app/api/jobs/process-outbox/route.ts"), "utf8");
  assert.match(outbox, /waiver_kind === "unconditional"/);
});

test("the sub portal uses individual prepared-document invitations, not a generic signature form", () => {
 const portal=fs.readFileSync(path.join(__dirname,"../app/s/[token]/waivers/[billId]/page.tsx"),"utf8")
 assert.doesNotMatch(portal,/signVendorBillWaiverPortalAction|signature_text/)
 assert.match(portal,/individual signing invitation/)
})
