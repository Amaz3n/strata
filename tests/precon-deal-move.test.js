require("../scripts/register-ts-node-test");
const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const {
  pricingRowSchema,
  EMPTY_PRICING_WORKSHEET,
  scopeSignature,
} = require("../lib/precon/pricing-worksheet");
const { dealMove, lineStatus, priceFirmness, SIGNATURE_FIRMNESS } = require("../lib/precon/deal-move");

const NOW = new Date("2026-10-03T12:00:00Z");
const row = (description, cost, extra = {}) =>
  pricingRowSchema.parse({ id: randomUUID(), description, unit_cost_cents: cost, ...extra });
const measured = (description, cost) =>
  row(description, cost, { metadata: { takeoff: { condition_id: randomUUID(), measured_quantity: 1 } } });
const sheet = (rows, extra = {}) => ({ ...EMPTY_PRICING_WORKSHEET, rows, ...extra });
const quote = (cents) => ({
  submission_id: randomUUID(),
  pricing_decision_id: randomUUID(),
  company_name: "Brightline Electric",
  normalized_total_cents: cents,
  total_cents: cents,
  submission_version: 1,
  scope_revision: 1,
  valid_until: null,
  accepted_alternate_ids: [],
  gaps: [],
});
const requestFor = (rows, packageId, selected = null) => ({
  package_id: packageId,
  row_ids: rows.map((item) => item.id),
  scope_signature: scopeSignature(rows),
  quote: selected,
});
const doc = (purpose, status, extra = {}) => ({
  id: randomUUID(),
  purpose,
  status,
  version: 1,
  total_cents: 2_810_000_00,
  sent_at: "2026-09-24T12:00:00Z",
  viewed_at: null,
  responded_at: null,
  decision_note: null,
  changed_since: false,
  ...extra,
});
const input = (extra = {}) => ({
  now: NOW,
  clientName: "Dana Smith",
  status: "pricing",
  lostReason: null,
  projectPhase: "precon",
  scope: "",
  worksheet: null,
  requests: [],
  proposal: null,
  agreement: null,
  openQuestions: 0,
  ...extra,
});

test("a new lead asks what the client wants built, then turns notes into lines", () => {
  const empty = dealMove(input({ status: "new", projectPhase: null }));
  assert.equal(empty.ball, "you");
  assert.equal(empty.stop, 0);
  assert.equal(empty.action.kind, "describe");
  assert.match(empty.sentence, /what Dana wants built/);

  const noted = dealMove(input({ status: "contacted", scope: "Gut the bathroom\nNew tub" }));
  assert.equal(noted.action.kind, "start_pricing");
  assert.equal(noted.label, "Start pricing");
});

test("a deal without a client name still reads as a sentence", () => {
  const move = dealMove(input({ clientName: null }));
  assert.match(move.sentence, /^Write down what the client wants built/);
});

test("firmness weighs cost: quotes and measurements are firm, allowances held, own numbers guesses", () => {
  const electrical = row("Electrical", null);
  const worksheet = sheet(
    [row("Demolition", 1_240_000), measured("Roofing", 2_170_000), row("Windows", 2_200_000, { basis: "allowance" }), electrical],
    { requests: [requestFor([electrical], randomUUID(), quote(1_000_000))] },
  );
  const firmness = priceFirmness(worksheet, []);
  assert.equal(firmness.firm, 2_170_000 + 1_000_000);
  assert.equal(firmness.allowance, 2_200_000);
  assert.equal(firmness.guess, 1_240_000);
  assert.equal(firmness.unpriced, 0);
  assert.ok(firmness.range.low <= firmness.total && firmness.total <= firmness.range.high);
  assert.equal(firmness.range.low % 50_000, 0);
});

test("optional add-ons never move firmness", () => {
  const firmness = priceFirmness(sheet([measured("Framing", 1_000_000), row("Hot tub", 9_000_000, { is_optional: true })]), []);
  assert.equal(firmness.firmShare, 1);
});

test("a quote request is a draft, then waiting on trades, then quotes to pick", () => {
  const plumbing = row("Plumbing", null);
  const packageId = randomUUID();
  const worksheet = sheet([plumbing], { requests: [requestFor([plumbing], packageId)] });
  const status = (state) => lineStatus(plumbing, worksheet, [{ package_id: packageId, due_at: "2026-10-09", ...state }]).kind;
  assert.equal(status({ status: "draft", invite_count: 0, response_count: 0 }), "request_draft");
  assert.equal(status({ status: "open", invite_count: 3, response_count: 0 }), "awaiting_quotes");
  assert.equal(status({ status: "open", invite_count: 3, response_count: 2 }), "quotes_in");
  assert.equal(status({ status: "cancelled", invite_count: 3, response_count: 0 }), "open");
});

test("open lines are your move before anything waiting on trades", () => {
  const plumbing = row("Plumbing", null);
  const electrical = row("Electrical", null);
  const packageId = randomUUID();
  const move = dealMove(input({
    worksheet: sheet([row("Demolition", 1_000_000), plumbing, electrical], { requests: [requestFor([plumbing], packageId)] }),
    requests: [{ package_id: packageId, status: "open", invite_count: 3, response_count: 0, due_at: null }],
  }));
  assert.equal(move.ball, "you");
  assert.deepEqual(move.action, { kind: "price_line", rowId: electrical.id });
  assert.equal(move.sentence, "1 line needs a price, 1 waiting on trades.");
  assert.equal(move.label, "Price Electrical");
});

test("when only quotes are outstanding, the ball is with the trades", () => {
  const plumbing = row("Plumbing", null);
  const packageId = randomUUID();
  const move = dealMove(input({
    worksheet: sheet([row("Demolition", 1_000_000), plumbing], { requests: [requestFor([plumbing], packageId)] }),
    requests: [{ package_id: packageId, status: "open", invite_count: 3, response_count: 0, due_at: "2026-10-09T17:00:00Z" }],
  }));
  assert.equal(move.ball, "trades");
  assert.equal(move.action.kind, "follow_up_trades");
  assert.match(move.detail, /^Due Oct 9/);
});

test("quotes that arrived put the ball back with you", () => {
  const plumbing = row("Plumbing", null);
  const packageId = randomUUID();
  const move = dealMove(input({
    worksheet: sheet([plumbing], { requests: [requestFor([plumbing], packageId)] }),
    requests: [{ package_id: packageId, status: "open", invite_count: 3, response_count: 2, due_at: null }],
  }));
  assert.equal(move.ball, "you");
  assert.deepEqual(move.action, { kind: "review_quotes", rowId: plumbing.id });
});

test("a soft price is sent as a budget range; a firm one for signature", () => {
  const soft = dealMove(input({ worksheet: sheet([row("Framing", 8_000_000), measured("Roofing", 2_000_000)]) }));
  assert.deepEqual(soft.action, { kind: "send", document: "budget" });
  assert.equal(soft.signable, false);
  assert.match(soft.detail, /^Dana sees \$[\d,]+–\$[\d,]+\. Firm up \$80,000 of guesses/);

  const firm = dealMove(input({ worksheet: sheet([measured("Framing", 8_000_000), row("Paint", 1_000_000)]) }));
  assert.ok(1 - 1_000_000 / 9_000_000 >= SIGNATURE_FIRMNESS);
  assert.deepEqual(firm.action, { kind: "send", document: "agreement" });
  assert.equal(firm.label, "Send for signature");
});

test("open client questions hold a firm price at budget", () => {
  const move = dealMove(input({ worksheet: sheet([measured("Framing", 8_000_000)]), openQuestions: 2 }));
  assert.equal(move.signable, false);
  assert.match(move.detail, /Answer 2 open questions to send for signature/);
});

test("a sent document puts the ball with the client until it changes", () => {
  const sent = doc("budget", "sent");
  const move = dealMove(input({ worksheet: sheet([row("Framing", 8_000_000)]), proposal: sent }));
  assert.equal(move.ball, "client");
  assert.equal(move.stop, 2);
  assert.equal(move.sentence, "Dana hasn't opened the budget yet.");
  assert.equal(move.detail, "Sent 9 days ago.");
  assert.deepEqual(move.action, { kind: "remind_client", documentId: sent.id });

  const opened = dealMove(input({ worksheet: sheet([row("Framing", 8_000_000)]), proposal: { ...sent, viewed_at: "2026-10-01T00:00:00Z" } }));
  assert.match(opened.sentence, /opened the budget/);

  const edited = dealMove(input({ worksheet: sheet([row("Framing", 9_000_000)]), proposal: { ...sent, changed_since: true } }));
  assert.equal(edited.ball, "you");
  assert.equal(edited.label, "Send updated budget");
});

test("requested changes come back to you with the client's words", () => {
  const move = dealMove(input({
    worksheet: sheet([row("Island top", 980_000)]),
    agreement: doc("construction_agreement", "changes_requested", { decision_note: "Quartz instead of marble?" }),
  }));
  assert.equal(move.ball, "you");
  assert.equal(move.action.kind, "revise");
  assert.equal(move.sentence, "Dana asked for changes: “Quartz instead of marble?”");
});

test("an approved budget asks you to firm up the softest line", () => {
  const framing = row("Framing", 8_000_000);
  const move = dealMove(input({ worksheet: sheet([framing, measured("Roofing", 1_000_000)]), proposal: doc("budget", "approved") }));
  assert.deepEqual(move.action, { kind: "firm_up", rowId: framing.id });
  assert.match(move.sentence, /approved the budget/);
});

test("signatures lead to countersigning, then starting the job", () => {
  const agreement = doc("construction_agreement", "client_signed");
  assert.deepEqual(dealMove(input({ agreement })).action, { kind: "countersign", documentId: agreement.id });
  const executed = dealMove(input({ agreement: { ...agreement, status: "executed" } }));
  assert.equal(executed.stop, 3);
  assert.equal(executed.action.kind, "start_building");
  assert.match(executed.sentence, /^Signed by both sides at \$2,810,000/);
});

test("won and lost deals leave the active lanes", () => {
  const building = dealMove(input({ status: "won", projectPhase: "delivery" }));
  assert.equal(building.ball, "building");
  assert.equal(building.stop, 4);
  const lost = dealMove(input({ status: "lost", lostReason: "Went with another builder" }));
  assert.equal(lost.ball, "closed");
  assert.equal(lost.sentence, "Lost: Went with another builder.");
  assert.equal(lost.action.kind, "reopen");
});
