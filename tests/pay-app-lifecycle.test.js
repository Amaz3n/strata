require("../scripts/register-ts-node-test");

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  derivePayApplicationStage,
  readCertification,
  readReturns,
  readRevision,
  readSentToOwner,
  stageIsPosted,
  stageIsWaitingOnOwner,
  PAY_APPLICATION_STAGE_LABELS,
} = require("../lib/financials/pay-app-lifecycle");

const base = {
  status: "draft",
  revision: 0,
  sentToOwnerAt: null,
  certifiedAt: null,
  certificationRequired: false,
  invoiceStatus: null,
};

test("a draft that has been returned reads as returned, not as a fresh draft", () => {
  assert.equal(derivePayApplicationStage(base), "draft");
  assert.equal(derivePayApplicationStage({ ...base, revision: 1 }), "returned");
});

test("a posted application waits on the owner only once it has actually been sent", () => {
  const posted = { ...base, status: "invoiced", certificationRequired: true };
  assert.equal(derivePayApplicationStage(posted), "submitted");
  assert.equal(
    derivePayApplicationStage({ ...posted, sentToOwnerAt: "2026-09-03T12:00:00Z" }),
    "awaiting_certification",
  );
});

test("without a required certificate a posted application is billed as soon as its invoice issues", () => {
  const posted = { ...base, status: "invoiced", certificationRequired: false };
  assert.equal(derivePayApplicationStage(posted), "submitted");
  assert.equal(derivePayApplicationStage({ ...posted, invoiceStatus: "draft" }), "submitted");
  assert.equal(derivePayApplicationStage({ ...posted, invoiceStatus: "sent" }), "billed");
  assert.equal(derivePayApplicationStage({ ...posted, invoiceStatus: "overdue" }), "billed");
});

test("a certificate outranks the send, and paid and void outrank everything", () => {
  const certified = {
    ...base,
    status: "invoiced",
    certificationRequired: true,
    sentToOwnerAt: "2026-09-01T12:00:00Z",
    certifiedAt: "2026-09-02T12:00:00Z",
  };
  assert.equal(derivePayApplicationStage(certified), "certified");
  assert.equal(derivePayApplicationStage({ ...certified, status: "approved" }), "certified");
  assert.equal(derivePayApplicationStage({ ...certified, status: "paid" }), "paid");
  assert.equal(derivePayApplicationStage({ ...certified, status: "void" }), "void");
});

test("only drafts and returns are editable; everything else is posted", () => {
  assert.equal(stageIsPosted("draft"), false);
  assert.equal(stageIsPosted("returned"), false);
  assert.equal(stageIsPosted("void"), false);
  for (const stage of ["submitted", "awaiting_certification", "certified", "billed", "paid"]) {
    assert.equal(stageIsPosted(stage), true, `${stage} is posted`);
  }
  assert.equal(stageIsWaitingOnOwner("awaiting_certification"), true);
  assert.equal(stageIsWaitingOnOwner("submitted"), false);
});

test("every stage has a label, so no surface can invent a second vocabulary", () => {
  for (const stage of [
    "draft",
    "returned",
    "submitted",
    "awaiting_certification",
    "certified",
    "billed",
    "paid",
    "void",
  ]) {
    assert.equal(typeof PAY_APPLICATION_STAGE_LABELS[stage], "string");
    assert.ok(PAY_APPLICATION_STAGE_LABELS[stage].length > 0);
  }
});

test("malformed metadata never invents a certificate, a return or a revision", () => {
  assert.equal(readCertification(null), null);
  assert.equal(readCertification({ certification: "yes" }), null);
  assert.equal(readCertification({ certification: { certified_at: "2026-09-02T00:00:00Z" } }), null);
  assert.deepEqual(readReturns({ returns: "nope" }), []);
  assert.deepEqual(readReturns({ returns: [{ reason: "too high" }] }), []);
  assert.equal(readRevision({ revision: -2 }), 0);
  assert.equal(readRevision({ revision: "3" }), 3);
  assert.equal(readSentToOwner({ sent_to_owner: { recipients: ["a@b.com"] } }), null);
});

test("a well-formed certificate, return and send are read back whole", () => {
  const certification = readCertification({
    certification: {
      certified_at: "2026-09-02T12:00:00Z",
      signer_name: "Dana Reyes",
      signature_text: "Dana Reyes",
      certified_amount_cents: 125000,
      source: "portal",
      note: "Approved as applied for",
      portal_token_id: "token-1",
      contact_id: "contact-1",
    },
  });
  assert.equal(certification.signer_name, "Dana Reyes");
  assert.equal(certification.certified_amount_cents, 125000);
  assert.equal(certification.source, "portal");

  const returns = readReturns({
    returns: [{ reason: "Line 4 is ahead of the work", returned_at: "2026-09-01T12:00:00Z", source: "portal", revision: 0 }],
  });
  assert.equal(returns.length, 1);
  assert.equal(returns[0].reason, "Line 4 is ahead of the work");

  const sent = readSentToOwner({ sent_to_owner: { at: "2026-09-01T09:00:00Z", recipients: ["owner@example.com", 7] } });
  assert.deepEqual(sent, { at: "2026-09-01T09:00:00Z", recipients: ["owner@example.com"] });
});

test("submitting is blocked while the schedule of values does not foot to the contract sum", () => {
  const service = fs.readFileSync(path.join(__dirname, "../lib/services/pay-applications.ts"), "utf8");
  assert.match(service, /Balance the schedule of values before submitting/);
  assert.match(service, /sovState\.summary\.variance_cents !== 0/);
});

test("returning an application reverses the billing and keeps the number", () => {
  const service = fs.readFileSync(path.join(__dirname, "../lib/services/pay-applications.ts"), "utf8");
  // The SOV rollups reverse through the same RPC a void uses.
  assert.match(service, /rpc\("void_pay_application"/);
  // The invoice is voided and its unpaid conditional waiver goes with it.
  assert.match(service, /voidPendingInvoiceLienWaiversWithClient/);
  // The row goes back to draft as the next revision rather than a new number.
  assert.match(service, /revision: previousRevision \+ 1/);
  assert.match(service, /rpc\("return_pay_application_atomic"/);
});

test("submitting files the owner's documents without being able to unwind the posting", () => {
  const service = fs.readFileSync(path.join(__dirname, "../lib/services/pay-applications.ts"), "utf8");
  assert.match(service, /renderAndStorePayApplicationPdf/);
  assert.doesNotMatch(service, /createInvoiceLienWaiver\(/);
  assert.match(service, /assertInvoiceWaiverPacketReady/);
  assert.match(service, /pay_application\.pdf_failed/);
});
