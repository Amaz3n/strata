require("../scripts/register-ts-node-test");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  bidPackageMove,
  rankBids,
  subcontractStage,
  tradeState,
} = require("../lib/bids/package-move");
const { computeSubmissionTotals } = require("../lib/bids/leveling");

const NOW = new Date("2026-10-07T12:00:00Z");
const FUTURE = "2026-10-10T18:00:00Z";
const PAST = "2026-10-06T18:00:00Z";

const base = {
  status: "draft",
  dueAt: FUTURE,
  mode: "tender",
  awardTarget: "commitment",
  canAward: true,
  scopeLineCount: 6,
  budgetCents: 18_000_000,
  trades: [],
  bids: [],
  award: null,
  now: NOW,
};
const trades = (...states) => states.map((state) => ({ state }));
const bid = (companyName, asBidCents, leveledCents = asBidCents, unpluggedLines = 0) => ({
  submissionId: companyName.toLowerCase(),
  companyName,
  asBidCents,
  leveledCents,
  unpluggedLines,
});

test("a tender with no scope asks for scope before trades", () => {
  const move = bidPackageMove({ ...base, scopeLineCount: 0 });
  assert.equal(move.stage, "setup");
  assert.equal(move.primary.kind, "add_scope");
});

test("a quote package needs no scope lines to line up trades", () => {
  const move = bidPackageMove({ ...base, mode: "quote", scopeLineCount: 0 });
  assert.equal(move.primary.kind, "add_trades");
  assert.equal(move.lead, "Ready for trades.");
});

test("lined-up trades without a future due date ask for one before sending", () => {
  for (const dueAt of [null, PAST]) {
    const move = bidPackageMove({ ...base, dueAt, trades: trades("lined_up", "lined_up") });
    assert.equal(move.primary.kind, "set_due_date");
  }
});

test("a ready draft offers to send to exactly the lined-up trades", () => {
  const move = bidPackageMove({ ...base, trades: trades("lined_up", "lined_up", "lined_up") });
  assert.equal(move.primary.kind, "send");
  assert.equal(move.primary.label, "Send to 3 trades");
  assert.match(move.lead, /3 trades lined up/);
});

test("while bidding, quiet trades are the move; closing early needs two prices", () => {
  const open = { ...base, status: "open" };
  let move = bidPackageMove({ ...open, trades: trades("priced", "opened", "sent", "declined") });
  assert.equal(move.stage, "bidding");
  assert.equal(move.lead, "1 of 4 trades has priced.");
  assert.equal(move.primary.kind, "nudge");
  assert.equal(move.primary.label, "Nudge 2");
  assert.equal(move.secondary, null);

  move = bidPackageMove({ ...open, trades: trades("priced", "priced", "sent") });
  assert.equal(move.secondary.kind, "close_bidding");

  move = bidPackageMove({ ...open, trades: trades("priced", "declined") });
  assert.equal(move.primary.kind, "close_bidding");
});

test("past the due date an open package is leveling even if nobody closed it", () => {
  const move = bidPackageMove({
    ...base,
    status: "open",
    dueAt: PAST,
    trades: trades("priced", "no_response"),
    bids: [bid("Coastal Electric", 17_620_000)],
  });
  assert.equal(move.stage, "leveling");
  assert.equal(move.primary.kind, "award");
  assert.equal(move.primary.submissionId, "coastal electric");
});

test("the low bid is the leveled low, and the page says when paper disagrees", () => {
  const move = bidPackageMove({
    ...base,
    status: "closed",
    trades: trades("priced", "priced", "priced"),
    bids: [
      bid("Meridian", 18_935_000),
      bid("Brightline", 16_310_000, 17_760_000),
      bid("Coastal", 17_620_000),
    ],
  });
  assert.equal(move.lead, "Coastal is low at $176,200, 2.1% under budget.");
  assert.match(move.detail, /Brightline is lower on paper/);
  assert.equal(move.primary.label, "Award Coastal");
});

test("an excluded line with no plug is called out as understating the total", () => {
  const move = bidPackageMove({
    ...base,
    status: "closed",
    bids: [bid("Brightline", 16_310_000, 16_310_000, 1), bid("Coastal", 17_620_000)],
  });
  assert.match(move.detail, /Brightline has excluded lines with no plug/);
});

test("a precon project levels and prices but cannot award", () => {
  const move = bidPackageMove({ ...base, status: "closed", canAward: false, bids: [bid("Coastal", 100)] });
  assert.equal(move.primary.kind, "use_quote");
});

test("nothing usable after the deadline offers to extend or reopen", () => {
  assert.equal(bidPackageMove({ ...base, status: "open", dueAt: PAST }).primary.kind, "set_due_date");
  const closed = bidPackageMove({ ...base, status: "closed", trades: trades("stale") });
  assert.equal(closed.primary.kind, "reopen");
  assert.match(closed.detail, /1 bid needs a refreshed price/);
});

test("after award, the subcontract drives the move until it is signed", () => {
  const awarded = (stage) =>
    bidPackageMove({
      ...base,
      status: "awarded",
      award: {
        companyName: "Coastal",
        totalCents: 17_620_000,
        subcontract: { stage, number: "SC-014", sentAt: "2026-10-05T12:00:00Z", executedAt: null },
      },
    });
  assert.equal(awarded("draft").primary.kind, "review_subcontract");
  assert.equal(awarded("approved").primary.kind, "send_subcontract");
  assert.equal(awarded("out_for_signature").primary, null);
  assert.match(awarded("out_for_signature").detail, /out for signature since 2 days ago/);
  assert.equal(awarded("executed").lead, "Coastal is under contract for $176,200.");
  assert.equal(awarded("executed").secondary.kind, "view_subcontract");
});

test("a price-book award has no subcontract to chase", () => {
  const move = bidPackageMove({
    ...base,
    status: "awarded",
    awardTarget: "price_agreement",
    award: { companyName: "Coastal", totalCents: 100, subcontract: null },
  });
  assert.equal(move.primary, null);
  assert.match(move.detail, /price book/);
});

test("cancelled packages offer only a restore", () => {
  assert.equal(bidPackageMove({ ...base, status: "cancelled" }).primary.kind, "restore");
});

test("trade state follows the invite, then the bid, then the award", () => {
  const ctx = { packageStage: "bidding", scopeRevision: 2, today: "2026-10-07" };
  const current = { status: "submitted", is_current: true, total_cents: 100, scope_revision: 2 };
  assert.equal(tradeState({ ...ctx, inviteStatus: "draft", submission: null }), "lined_up");
  assert.equal(tradeState({ ...ctx, inviteStatus: "sent", submission: null }), "sent");
  assert.equal(tradeState({ ...ctx, inviteStatus: "viewed", submission: null }), "opened");
  assert.equal(tradeState({ ...ctx, inviteStatus: "declined", submission: null }), "declined");
  assert.equal(tradeState({ ...ctx, inviteStatus: "submitted", submission: current }), "priced");
  assert.equal(tradeState({ ...ctx, inviteStatus: "submitted", submission: { ...current, scope_revision: 1 } }), "stale");
  assert.equal(tradeState({ ...ctx, inviteStatus: "sent", submission: null, packageStage: "leveling" }), "no_response");
  assert.equal(tradeState({ ...ctx, packageStage: "awarded", inviteStatus: "submitted", submission: { ...current, is_awarded: true } }), "awarded");
  assert.equal(tradeState({ ...ctx, packageStage: "awarded", inviteStatus: "submitted", submission: current }), "not_selected");
});

test("subcontract stage reads the commitment first, then its envelope", () => {
  assert.equal(subcontractStage({ status: "draft", executed_at: null }, null), "draft");
  assert.equal(subcontractStage({ status: "approved", executed_at: null }, null), "approved");
  assert.equal(subcontractStage({ status: "approved", executed_at: null }, { status: "sent" }), "out_for_signature");
  assert.equal(subcontractStage({ status: "approved", executed_at: null }, { status: "partially_signed" }), "partially_signed");
  assert.equal(subcontractStage({ status: "approved", executed_at: "2026-10-01" }, { status: "sent" }), "executed");
  assert.equal(subcontractStage({ status: "canceled", executed_at: null }, null), "canceled");
});

test("ranking ties break on the as-bid number", () => {
  const ranked = rankBids([bid("B", 200, 100), bid("A", 100, 100)]);
  assert.deepEqual(ranked.map((entry) => entry.companyName), ["A", "B"]);
});

test("leveled totals add plugs for excluded base lines and ignore alternates", () => {
  const scope = [
    { id: "s1", item_type: "base" },
    { id: "s2", item_type: "base" },
    { id: "a1", item_type: "alternate" },
  ];
  const totals = computeSubmissionTotals(
    {
      total_cents: 1000,
      leveled_adjustment_cents: 50,
      items: [
        { bid_scope_item_id: "s1", response: "priced", amount_cents: 1000 },
        { bid_scope_item_id: "s2", response: "excluded", gc_plug_cents: 300 },
        { bid_scope_item_id: "a1", response: "priced", amount_cents: 999 },
      ],
    },
    scope,
  );
  assert.deepEqual(totals, { base: 1000, plugs: 300, lump: 50, leveled: 1350 });
});
