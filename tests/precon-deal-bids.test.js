require("../scripts/register-ts-node-test");
const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { pricingRowSchema, EMPTY_PRICING_WORKSHEET } = require("../lib/precon/pricing-worksheet");
const {
  LUMP_SUM_NOTE,
  bidSpread,
  bidTrades,
  levelBid,
  requestStatus,
  suggestedBidders,
  suggestedSheetIds,
} = require("../lib/precon/deal-bids");

const NOW = new Date("2026-10-18T12:00:00Z");
const ELECTRICAL = randomUUID();
const PLUMBING = randomUUID();
const codes = [
  { id: ELECTRICAL, name: "Electrical" },
  { id: PLUMBING, name: "Plumbing" },
];
const row = (description, extra = {}) =>
  pricingRowSchema.parse({ id: randomUUID(), description, unit_cost_cents: 100_00, basis: "quote", ...extra });
const bid = (overrides = {}) => ({ is_current: true, status: "submitted", total_cents: 1, valid_until: null, scope_revision: 1, ...overrides });
const request = ({ status = "open", due = "2026-10-25T17:00:00Z", invites = 4, bids = 0, id = randomUUID() } = {}) => ({
  pkg: { id, title: "Electrical", trade: "Electrical", status, due_at: due, cost_code_id: ELECTRICAL, cost_code_name: "Electrical", scope_revision: 1 },
  invites: Array.from({ length: invites }, () => ({ status: "sent" })),
  submissions: Array.from({ length: bids }, () => bid()),
});

test("lines marked for bids wait under their cost code's trade; lines without one wait together", () => {
  const panel = row("Panel upgrade", { cost_code_id: ELECTRICAL });
  const lights = row("Recessed lights", { cost_code_id: ELECTRICAL });
  const sink = row("Kitchen sink", { cost_code_id: PLUMBING });
  const mantel = row("Fireplace mantel");
  const guess = row("Framing", { basis: "estimate", cost_code_id: ELECTRICAL });
  const trades = bidTrades({
    worksheet: { ...EMPTY_PRICING_WORKSHEET, rows: [panel, lights, sink, mantel, guess] },
    requests: [],
    statuses: [],
    costCodes: codes,
    now: NOW,
  });
  assert.deepEqual(
    trades.map((trade) => [trade.name, trade.status, trade.rowIds.length]),
    [
      ["Electrical", "draft", 2],
      ["Plumbing", "draft", 1],
      ["Not grouped", "unassigned", 1],
    ],
  );
});

test("a request is ready to choose once half the bidders answered or the due date passed", () => {
  assert.deepEqual(requestStatus(request({ invites: 4, bids: 1 }), false, NOW), { status: "out", label: "1 of 4 in · due Oct 25" });
  assert.equal(requestStatus(request({ invites: 4, bids: 2 }), false, NOW).status, "choose");
  assert.equal(requestStatus(request({ due: "2026-10-17T17:00:00Z", invites: 10, bids: 1 }), false, NOW).status, "choose");
  assert.deepEqual(requestStatus(request({ due: "2026-10-17T17:00:00Z", bids: 0 }), false, NOW), { status: "late", label: "Past due · no bids" });
  assert.equal(requestStatus(request({ status: "draft", invites: 0 }), false, NOW).status, "draft");
  assert.equal(requestStatus(request({ bids: 1 }), true, NOW).status, "chosen");
});

test("an expired or superseded bid is not counted as in", () => {
  const stale = request({ invites: 2 });
  stale.submissions = [bid({ valid_until: "2026-10-01" }), bid({ is_current: false })];
  assert.equal(requestStatus(stale, false, NOW).label, "0 of 2 in · due Oct 25");
});

const scope = [
  { id: "base-1", item_type: "base", budget_cents: 12_000_00 },
  { id: "base-2", item_type: "base", budget_cents: 3_800_00 },
  { id: "alt-1", item_type: "alternate", budget_cents: 2_600_00 },
  { id: "unit-1", item_type: "unit_price", budget_cents: 175_00 },
];
const item = (scopeId, response, extra = {}) => ({ id: `${scopeId}-item`, bid_scope_item_id: scopeId, response, ...extra });

test("an excluded line is filled with your plug, your placeholder until you set one", () => {
  const submission = {
    total_cents: 12_800_00,
    items: [item("base-1", "priced", { amount_cents: 12_800_00 }), item("base-2", "excluded"), item("alt-1", "priced", { amount_cents: 2_400_00 }), item("unit-1", "priced", { unit_rate_cents: 160_00 })],
  };
  const plain = levelBid(submission, scope, []);
  assert.deepEqual([plain.asBid, plain.plugs, plain.leveled], [12_800_00, 3_800_00, 16_600_00]);
  assert.deepEqual(plain.cells["base-2"], { kind: "gap", reason: "excluded", itemId: "base-2-item", plug: 3_800_00 });
  assert.deepEqual(plain.cells["unit-1"], { kind: "priced", cents: 160_00 }, "a unit price shows but never adds");

  submission.items[1].gc_plug_cents = 4_500_00;
  assert.equal(levelBid(submission, scope, []).leveled, 17_300_00);
  assert.equal(levelBid(submission, scope, ["alt-1"]).leveled, 19_700_00, "an accepted alternate adds its price");
});

test("an accepted alternate the bidder left out is plugged like any other gap", () => {
  const submission = { total_cents: 15_000_00, items: [item("base-1", "priced", { amount_cents: 11_000_00 }), item("base-2", "priced", { amount_cents: 4_000_00 }), item("alt-1", "no_bid")] };
  assert.equal(levelBid(submission, scope, []).leveled, 15_000_00);
  assert.equal(levelBid(submission, scope, ["alt-1"]).leveled, 17_600_00);
});

test("a bid entered as a lump sum stays one number", () => {
  const lump = {
    total_cents: 23_900_00,
    items: scope.map((line, index) => item(line.id, "priced", { amount_cents: index ? 0 : 23_900_00, notes: LUMP_SUM_NOTE })),
  };
  const leveled = levelBid(lump, scope, ["alt-1"]);
  assert.equal(leveled.lump, true);
  assert.equal(leveled.leveled, 23_900_00);
  assert.deepEqual(leveled.cells["base-2"], { kind: "in_lump" });
});

test("a bid far under the median is flagged only once there are three to compare", () => {
  assert.equal(bidSpread([15_100_00, 24_700_00]).isOutlier(15_100_00), false);
  const spread = bidSpread([15_100_00, 23_700_00, 24_700_00, 27_000_00]);
  assert.deepEqual([spread.low, spread.median, spread.high], [15_100_00, 24_200_00, 27_000_00]);
  assert.equal(spread.isOutlier(15_100_00), true);
  assert.equal(spread.isOutlier(23_700_00), false);
});

test("a new request starts with its trade's sheets and the floor plans, and its trade's bidders", () => {
  const sheets = [
    { id: "a101", discipline: "A", number: "A-101" },
    { id: "a201", discipline: "A", number: "A-201" },
    { id: "e101", discipline: "E", number: "E-101" },
    { id: "p101", discipline: "P", number: "P-101" },
  ];
  assert.deepEqual(suggestedSheetIds(sheets, "Electrical"), ["a101", "e101"]);
  assert.deepEqual(suggestedSheetIds(sheets, "Fireplace surround"), []);

  const bidders = [
    { name: "Volt & Co", trade: "Electrical contractor", invited: 7, answered: 5 },
    { name: "Brightline", trade: "electrician", invited: 12, answered: 12 },
    { name: "Rivera Plumbing", trade: "Plumbing", invited: 3, answered: 3 },
    { name: "No trade", trade: null, invited: 0, answered: 0 },
  ];
  assert.deepEqual(suggestedBidders(bidders, "Electrical").map((bidder) => bidder.name), ["Brightline", "Volt & Co"]);
});
