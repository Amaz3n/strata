require("../scripts/register-ts-node-test");
const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const {
  pricingRowSchema,
  EMPTY_PRICING_WORKSHEET,
  scopeSignature,
} = require("../lib/precon/pricing-worksheet");
const { dealMove, lineStatus, linesToBid, priceFirmness, FIRM_PRICE_SHARE } = require("../lib/precon/deal-move");
const { planChanges } = require("../lib/precon/plan-changes");

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
  worksheet: null,
  requests: [],
  proposal: null,
  agreement: null,
  openQuestions: 0,
  ...extra,
});

test("a new lead starts the price, then adds its first line", () => {
  const empty = dealMove(input({ status: "new", projectPhase: null }));
  assert.equal(empty.ball, "you");
  assert.equal(empty.stop, 0);
  assert.equal(empty.action.kind, "start_price");
  assert.equal(empty.label, "Start the price");

  const blank = dealMove(input({ worksheet: sheet([]) }));
  assert.equal(blank.stop, 1);
  assert.equal(blank.action.kind, "add_line");
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

test("a line marked for bids holds your number as a guess until a request carries its bid", () => {
  const framing = row("Framing", 4_000_000, { basis: "quote" });
  const drywall = row("Drywall", null, { basis: "quote" });
  const packageId = randomUUID();
  const worksheet = sheet([framing, drywall]);
  assert.deepEqual(lineStatus(framing, worksheet, []), { kind: "priced", firmness: "guess", cost: 4_000_000 });
  assert.equal(lineStatus(drywall, worksheet, []).kind, "to_bid");
  assert.deepEqual(linesToBid(worksheet, []).map((item) => item.id), [framing.id, drywall.id]);

  const requested = sheet([framing, drywall], { requests: [requestFor([framing, drywall], packageId)] });
  const live = [{ package_id: packageId, status: "open", invite_count: 2, response_count: 0, due_at: null }];
  assert.deepEqual(linesToBid(requested, live), []);
  assert.equal(linesToBid(requested, [{ ...live[0], status: "cancelled" }]).length, 2, "a cancelled request puts the lines back");

  const picked = sheet([framing, drywall], { requests: [requestFor([framing, drywall], packageId, quote(6_500_000))] });
  assert.deepEqual(lineStatus(framing, picked, live), { kind: "priced", firmness: "firm", cost: 6_500_000 });
});

test("lines going out for bids ask you to request them once everything else has a price", () => {
  const drywall = row("Drywall", null, { basis: "quote" });
  const paint = row("Paint", 900_000, { basis: "quote" });
  const move = dealMove(input({ worksheet: sheet([row("Demolition", 1_000_000), drywall, paint]) }));
  assert.equal(move.ball, "you");
  assert.deepEqual(move.action, { kind: "request_bids" });
  assert.equal(move.sentence, "2 lines go out for bids: Drywall and Paint.");

  const open = dealMove(input({ worksheet: sheet([row("Electrical", null), drywall]) }));
  assert.equal(open.action.kind, "price_line");
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

test("a proposal goes for signature by default, whatever its firmness; a range goes for approval", () => {
  const soft = dealMove(input({ worksheet: sheet([row("Framing", 8_000_000), measured("Roofing", 2_000_000)]) }));
  assert.deepEqual(soft.action, { kind: "send", document: "agreement" });
  assert.equal(soft.label, "Send for signature");
  assert.equal(soft.detail, "$100,000 fixed price, 20% firm.");

  const firm = dealMove(input({ worksheet: sheet([measured("Framing", 8_000_000), row("Paint", 1_000_000)]) }));
  assert.ok(1 - 1_000_000 / 9_000_000 >= FIRM_PRICE_SHARE);

  const range = dealMove(input({ worksheet: sheet([row("Framing", 8_000_000)]), priceMode: "range" }));
  assert.deepEqual(range.action, { kind: "send", document: "budget" });
  assert.equal(range.signable, false);
  assert.equal(range.label, "Send for approval");
  assert.match(range.detail, /^Dana approves \$[\d,]+–\$[\d,]+\. Nothing is signed\.$/);
});

test("open client questions go out with the proposal and are answered before signing", () => {
  const move = dealMove(input({ worksheet: sheet([measured("Framing", 8_000_000)]), openQuestions: 2 }));
  assert.deepEqual(move.action, { kind: "send", document: "agreement" });
  assert.match(move.detail, /Dana answers 2 questions on it before signing\./);
});

test("a sent document puts the ball with the client until it changes", () => {
  const sent = doc("budget", "sent");
  const move = dealMove(input({ worksheet: sheet([row("Framing", 8_000_000)]), proposal: sent }));
  assert.equal(move.ball, "client");
  assert.equal(move.stop, 2);
  assert.equal(move.sentence, "Dana hasn't opened the estimate yet.");
  assert.equal(move.detail, "Sent 9 days ago.");
  assert.deepEqual(move.action, { kind: "remind_client", documentId: sent.id });

  const opened = dealMove(input({ worksheet: sheet([row("Framing", 8_000_000)]), proposal: { ...sent, viewed_at: "2026-10-01T00:00:00Z" } }));
  assert.match(opened.sentence, /opened the estimate/);

  const edited = dealMove(input({ worksheet: sheet([row("Framing", 9_000_000)]), proposal: { ...sent, changed_since: true }, priceMode: "range" }));
  assert.equal(edited.ball, "you");
  assert.equal(edited.label, "Send updated estimate");
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

test("an approved estimate leads to a fixed price for signature", () => {
  const worksheet = sheet([row("Framing", 8_000_000), measured("Roofing", 1_000_000)]);
  const approved = doc("budget", "approved");
  const still = dealMove(input({ worksheet, proposal: approved, priceMode: "range" }));
  assert.deepEqual(still.action, { kind: "open_proposal", section: "price" });
  assert.equal(still.label, "Set a fixed price");
  const fixed = dealMove(input({ worksheet, proposal: approved }));
  assert.deepEqual(fixed.action, { kind: "send", document: "agreement" });
  assert.match(fixed.sentence, /approved the estimate/);
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

test("a deal's value sharpens from a stated budget to a range to a price", () => {
  const { dealValue, dealValueCents } = require("../lib/precon/deal-move");
  const value = (extra, budget = null) => {
    const move = dealMove(input(extra));
    return dealValue(move, { proposal: extra.proposal ?? null, agreement: extra.agreement ?? null }, budget);
  };
  const stated = value({ status: "new", projectPhase: null }, "500k_1m");
  assert.deepEqual(stated, { kind: "budget", label: "$500k–$1M" });
  assert.equal(dealValueCents(stated), 0);
  assert.equal(value({ status: "new", projectPhase: null }, "over_1m").label, "$1M+");
  assert.equal(value({ status: "new", projectPhase: null }, "under_100k").label, "Under $100k");
  assert.equal(value({ status: "new", projectPhase: null }, "$450k–$520k").label, "$450k–$520k");
  assert.equal(value({ status: "new", projectPhase: null }, "$1–2M").label, "$1M–$2M");
  assert.deepEqual(value({ status: "new", projectPhase: null }, "undecided"), { kind: "none" });
  assert.deepEqual(value({ status: "new", projectPhase: null }), { kind: "none" });

  const partial = value({ worksheet: sheet([row("Framing", 9_000_000), row("Roofing", null)]) });
  assert.equal(partial.kind, "priced_so_far");

  const soft = value({ worksheet: sheet([row("Framing", 9_000_000)]) });
  assert.equal(soft.kind, "range");
  assert.ok(soft.low <= 9_000_000 && soft.high > 9_000_000);
  assert.equal(dealValueCents(soft), Math.round((soft.low + soft.high) / 2));

  assert.deepEqual(value({ worksheet: sheet([measured("Framing", 9_000_000)]) }), { kind: "price", cents: 9_000_000, basis: "firm" });
  assert.deepEqual(
    value({ worksheet: sheet([measured("Framing", 9_000_000)]), agreement: doc("construction_agreement", "sent") }),
    { kind: "price", cents: 2_810_000_00, basis: "agreement" },
  );
});

test("a proposal section that needs the builder comes before the send", () => {
  const priced = sheet([measured("Framing", 1_000_000)]);
  const needs = [{ key: "schedule", name: "Schedule", label: "Set a start window" }];
  const move = dealMove(input({ worksheet: priced, proposalNeeds: needs }));
  assert.deepEqual(move.action, { kind: "open_proposal", section: "schedule" });
  assert.equal(move.sentence, "Schedule: set a start window.");
  assert.equal(move.signable, true, "what the proposal needs never changes how it is sent");
  assert.deepEqual(dealMove(input({ worksheet: priced, proposalNeeds: [] })).action, { kind: "send", document: "agreement" });
});

test("a client's unanswered question outranks reminding them", () => {
  const move = dealMove(input({ worksheet: sheet([measured("Framing", 1_000_000)]), agreement: doc("construction_agreement", "sent"), unansweredComments: 2 }));
  assert.deepEqual(move.action, { kind: "open_proposal", section: "questions" });
  assert.equal(move.sentence, "Dana asked 2 questions on the proposal.");
  assert.equal(move.ball, "you");
});

test("new plans: carried measurements are reviewed first, then changed quantities, before waiting on the client", () => {
  const priced = sheet([measured("Framing", 1_000_000)]);
  const sent = doc("construction_agreement", "sent");
  const review = dealMove(input({ worksheet: priced, agreement: sent, planChanges: { review: 2, changed: 1 } }));
  assert.deepEqual(review.action, { kind: "review_plan_measurements" });
  assert.equal(review.sentence, "New plans moved the measurements on 2 lines. Check they still sit right.");
  assert.equal(review.ball, "you");

  const changed = dealMove(input({ worksheet: priced, agreement: sent, planChanges: { review: 0, changed: 1 } }));
  assert.deepEqual(changed.action, { kind: "review_plan_quantities" });
  assert.equal(changed.sentence, "New plans changed the quantity on 1 measured line.");

  assert.equal(dealMove(input({ worksheet: priced, agreement: sent, planChanges: { review: 0, changed: 0 } })).ball, "client");
});

test("plan changes: unconfirmed measurements are under review, moved ones are changed unless the builder kept them", () => {
  const condition = () => randomUUID();
  const line = (description, takeoff, cost = 500) =>
    row(description, cost, { quantity: 100, metadata: { takeoff: { measured_quantity: 100, ...takeoff } } });
  const [a, b, c, d, e] = [condition(), condition(), condition(), condition(), condition()];
  const rows = [
    line("Carried", { condition_id: a }),
    line("Moved", { condition_id: b }),
    line("Same", { condition_id: c }),
    line("Kept", { condition_id: d, kept_quantity: 120 }),
    line("Detached", { condition_id: e, detached: true }),
    row("Typed", 500, { quantity: 10 }),
  ];
  const source = (condition_id, effective_quantity, pending_review_count = 0) => ({
    condition_id,
    effective_quantity,
    pending_review_count,
    unscaled_markup_count: 0,
  });
  const result = planChanges(rows, [source(a, 80, 3), source(b, 120), source(c, 100), source(d, 120), source(e, 140)]);
  assert.deepEqual(result.review, [{ rowId: rows[0].id, description: "Carried", count: 3 }]);
  assert.deepEqual(result.changed, [
    { rowId: rows[1].id, conditionId: b, description: "Moved", unit: rows[1].unit, from: 100, to: 120, deltaCents: 10_000 },
  ]);
  // A kept line speaks again once the plans move past what was kept.
  assert.equal(planChanges(rows, [source(d, 130)]).changed[0].rowId, rows[3].id);
});
