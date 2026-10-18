require("../scripts/register-ts-node-test");
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { randomUUID } = require("node:crypto");
const { pricingRowSchema, EMPTY_PRICING_WORKSHEET } = require("../lib/precon/pricing-worksheet");

const original = Module._load;
Module._load = function (request, ...args) {
  if (request === "server-only") return {};
  return original.call(this, request, ...args);
};
let dealDocuments, worksheetFingerprint;
try {
  ({ dealDocuments, worksheetFingerprint } = require("../lib/services/precon-deals"));
} finally {
  Module._load = original;
}

const worksheet = {
  ...EMPTY_PRICING_WORKSHEET,
  rows: [pricingRowSchema.parse({ id: randomUUID(), description: "Framing", unit_cost_cents: 800_000 })],
};
const row = (purpose, extra = {}) => ({
  id: randomUUID(),
  prospect_id: "deal",
  status: "sent",
  version: 1,
  total_cents: 1_000_000,
  sent_at: "2026-09-30T12:00:00Z",
  viewed_at: null,
  responded_at: null,
  decision_note: null,
  client_signed_at: null,
  updated_at: "2026-09-30T12:00:00Z",
  purpose,
  fingerprint: worksheetFingerprint(worksheet),
  accepted_total: null,
  ...extra,
});

test("a document sent from the current worksheet is unchanged; any edit marks it changed", () => {
  const { proposal } = dealDocuments([row("budget")], worksheet);
  assert.equal(proposal.changed_since, false);
  const edited = { ...worksheet, markup_percent: 20 };
  assert.equal(dealDocuments([row("budget")], edited).proposal.changed_since, true);
});

test("documents without a worksheet fingerprint never claim to be stale", () => {
  assert.equal(dealDocuments([row("budget", { fingerprint: null })], worksheet).proposal.changed_since, false);
});

test("each purpose resolves to its newest current document; legacy documents count as agreements", () => {
  const older = row("budget", { updated_at: "2026-09-01T00:00:00Z" });
  const newer = row("budget", { updated_at: "2026-09-20T00:00:00Z", version: 2 });
  const legacy = row(null, { accepted_total: "1250000" });
  const { proposal, agreement } = dealDocuments([older, newer, legacy], worksheet);
  assert.equal(proposal.id, newer.id);
  assert.equal(agreement.id, legacy.id);
  assert.equal(agreement.total_cents, 1_250_000);
});
