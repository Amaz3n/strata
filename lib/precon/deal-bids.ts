import { bidEligibilityReason } from "@/lib/bids/pricing";
import type { BidInvite, BidPackage, BidScopeItem, BidSubmission } from "@/lib/services/bids";
import { linesToBid, type QuoteRequestStatus } from "./deal-move";
import type { PricingRow, PricingWorksheet } from "./pricing-worksheet";

// The Bids tab's judgement, kept pure: which trades a deal has, where each
// stands, and how every bid lines up against the same scope.

/** A bid recorded from an email or a call: the whole price on the first line, the rest marked as inside it. */
export const LUMP_SUM_NOTE = "Included in vendor lump sum";

export type BidTradeStatus = "choose" | "late" | "draft" | "unassigned" | "out" | "chosen";

export type BidTrade = {
  /** The request's package id, or `code:<cost code>` / `unassigned` for lines not requested yet. */
  key: string;
  name: string;
  status: BidTradeStatus;
  label: string;
  packageId: string | null;
  costCodeId: string | null;
  rowIds: string[];
};

type TradeRequest = {
  pkg: Pick<BidPackage, "id" | "title" | "trade" | "status" | "due_at" | "cost_code_id" | "cost_code_name" | "scope_revision">;
  invites: Pick<BidInvite, "status">[];
  submissions: Pick<BidSubmission, "is_current" | "status" | "total_cents" | "valid_until" | "scope_revision">[];
};

const ORDER: Record<BidTradeStatus, number> = { choose: 0, late: 1, draft: 2, unassigned: 3, out: 4, chosen: 5 };

const shortDay = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/** The bids that can be chosen: current, submitted, priced, unexpired and against today's scope. */
export function liveBids<T extends TradeRequest["submissions"][number]>(submissions: T[], scopeRevision?: number, today?: string) {
  return submissions.filter((bid) => !bidEligibilityReason(bid, scopeRevision, today));
}

/** Where one request stands. Bids are ready to choose once the due date passes or half the bidders answered. */
export function requestStatus(request: TradeRequest, chosen: boolean, now: Date): Pick<BidTrade, "status" | "label"> {
  if (chosen || request.pkg.status === "awarded") return { status: "chosen", label: "Bid chosen" };
  const invited = request.invites.length;
  if (request.pkg.status === "draft" || !invited) return { status: "draft", label: "Not sent" };
  const live = liveBids(request.submissions, request.pkg.scope_revision, now.toISOString().slice(0, 10)).length;
  const due = request.pkg.due_at ? new Date(request.pkg.due_at) : null;
  const past = !!due && due < now;
  if (live && (past || live * 2 >= invited)) return { status: "choose", label: `${live} of ${invited} in · choose` };
  if (past && !live) return { status: "late", label: `Past due · no bids` };
  return { status: "out", label: `${live} of ${invited} in${due ? ` · due ${shortDay(due.toISOString())}` : ""}` };
}

/**
 * The deal's trades: every open request, then the lines marked for bids on
 * Pricing that no request covers yet, grouped by cost code. Lines without a
 * cost code wait together until someone says which trade prices them.
 */
export function bidTrades({
  worksheet,
  requests,
  statuses,
  costCodes,
  now,
}: {
  worksheet: PricingWorksheet;
  requests: TradeRequest[];
  statuses: QuoteRequestStatus[];
  costCodes: { id: string; name: string }[];
  now: Date;
}): BidTrade[] {
  const trades: BidTrade[] = requests.map((request) => {
    const linked = worksheet.requests.find((item) => item.package_id === request.pkg.id);
    return {
      key: request.pkg.id,
      name: request.pkg.trade || request.pkg.cost_code_name || request.pkg.title,
      packageId: request.pkg.id,
      costCodeId: request.pkg.cost_code_id ?? null,
      rowIds: linked?.row_ids ?? [],
      ...requestStatus(request, !!linked?.quote, now),
    };
  });
  const groups = new Map<string, PricingRow[]>();
  for (const row of linesToBid(worksheet, statuses)) {
    const key = row.cost_code_id && costCodes.some((code) => code.id === row.cost_code_id) ? `code:${row.cost_code_id}` : "unassigned";
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  for (const [key, rows] of groups) {
    const costCodeId = key === "unassigned" ? null : key.slice(5);
    trades.push({
      key,
      name: costCodeId ? (costCodes.find((code) => code.id === costCodeId)?.name ?? "Trade") : "Not grouped",
      packageId: null,
      costCodeId,
      rowIds: rows.map((row) => row.id),
      ...(costCodeId ? { status: "draft", label: "Not sent" } : { status: "unassigned", label: "Needs a trade" }),
    });
  }
  return trades.sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.name.localeCompare(b.name));
}

export type LevelCell =
  | { kind: "priced"; cents: number }
  | { kind: "gap"; reason: "excluded" | "no_bid" | "missing"; itemId: string | null; plug: number }
  | { kind: "in_lump" };

export type LeveledBid = {
  /** What the bidder's own lines add up to, accepted alternates included. */
  asBid: number;
  /** Your numbers for the lines they left out. */
  plugs: number;
  leveled: number;
  lump: boolean;
  cells: Record<string, LevelCell>;
};

/** A recorded lump sum: priced on the first line only, every line marked as inside it. */
export function isLumpSum(submission: Pick<BidSubmission, "items">) {
  const items = submission.items ?? [];
  return items.length > 0 && items.every((item) => item.response === "priced" && item.notes === LUMP_SUM_NOTE);
}

/**
 * One bid against the request's lines. A line the bidder excluded is filled
 * with your plug (your placeholder until you change it), so every bid covers
 * the same scope. Alternates count only when accepted; unit prices never add.
 */
export function levelBid(
  submission: Pick<BidSubmission, "items" | "total_cents">,
  scope: Pick<BidScopeItem, "id" | "item_type" | "budget_cents">[],
  acceptedAlternates: string[],
): LeveledBid {
  const lump = isLumpSum(submission);
  const cells: Record<string, LevelCell> = {};
  let asBid = lump ? (submission.total_cents ?? 0) : 0;
  let plugs = 0;
  for (const line of scope) {
    const item = submission.items?.find((entry) => entry.bid_scope_item_id === line.id);
    if (lump && item) {
      cells[line.id] = { kind: "in_lump" };
      continue;
    }
    const counts = line.item_type === "alternate" ? acceptedAlternates.includes(line.id) : line.item_type !== "unit_price";
    if (item?.response === "priced") {
      const cents = item.amount_cents ?? (item.unit_rate_cents ?? 0);
      cells[line.id] = { kind: "priced", cents };
      if (counts) asBid += cents;
      continue;
    }
    const plug = item?.gc_plug_cents ?? line.budget_cents ?? 0;
    cells[line.id] = {
      kind: "gap",
      reason: item?.response === "no_bid" ? "no_bid" : item ? "excluded" : "missing",
      itemId: item?.id ?? null,
      plug,
    };
    if (counts && line.item_type !== "unit_price") plugs += plug;
  }
  return { asBid, plugs, leveled: asBid + plugs, lump, cells };
}

/** Low, median and high of the leveled totals, and the bids far enough under the rest to read twice. */
export function bidSpread(totals: number[]) {
  const sorted = [...totals].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
  return {
    low: sorted[0],
    median,
    high: sorted[sorted.length - 1],
    // Three bids make a pattern; with fewer, "far below the rest" means nothing.
    isOutlier: (total: number) => sorted.length >= 3 && total < median * 0.82,
  };
}

/** Where one invited bidder stands, from the invitation and their current bid. */
export function bidderStatus(invite: Pick<BidInvite, "status" | "last_viewed_at">, hasBid: boolean) {
  if (hasBid || invite.status === "submitted") return { key: "in", label: "Bid in", tone: "text-success" } as const;
  if (invite.status === "declined") return { key: "declined", label: "Declined", tone: "text-muted-foreground" } as const;
  if (invite.status === "withdrawn") return { key: "declined", label: "Withdrew", tone: "text-muted-foreground" } as const;
  if (invite.status === "viewed" || invite.last_viewed_at) return { key: "opened", label: "Opened", tone: "text-chart-2" } as const;
  if (invite.status === "draft") return { key: "waiting", label: "Not sent", tone: "text-muted-foreground" } as const;
  return { key: "waiting", label: "Sent", tone: "text-muted-foreground" } as const;
}

// Which plan disciplines a trade prices from, by the words in its name. The
// floor plans (A) go to everyone, because every trade lays its work out on them.
const TRADE_DISCIPLINES: [RegExp, string[]][] = [
  [/electric|lighting|low.?voltage/i, ["E"]],
  [/plumb|gas|fire.?sprinkler/i, ["P", "FP"]],
  [/hvac|mechanical|heating|cooling|duct/i, ["M"]],
  [/framing|structural|steel|concrete|foundation/i, ["S"]],
  [/site|civil|excavat|grading/i, ["C"]],
  [/landscap|irrigation/i, ["L"]],
  [/cabinet|millwork|finish|tile|paint|drywall|interior|floor/i, ["I"]],
];

/** The sheets a new request starts with: the trade's own discipline plus the floor plans. The builder adjusts from there. */
export function suggestedSheetIds(sheets: { id: string; discipline: string | null; number: string }[], tradeName: string) {
  const disciplines = TRADE_DISCIPLINES.flatMap(([pattern, codes]) => (pattern.test(tradeName) ? codes : []));
  if (!disciplines.length) return [];
  return sheets
    .filter((sheet) => disciplines.includes(sheet.discipline ?? "") || (sheet.discipline === "A" && /^A-?1\d\d/i.test(sheet.number)))
    .map((sheet) => sheet.id);
}

const words = (text: string) => text.toLowerCase().split(/[^a-z]+/).filter((word) => word.length > 2);

/** Companies whose trade matches the request's, the ones who answer most often first. */
export function suggestedBidders<T extends { trade: string | null; invited: number; answered: number; name: string }>(bidders: T[], tradeName: string) {
  const wanted = words(tradeName).map((word) => word.slice(0, 5));
  return bidders
    .filter((bidder) => bidder.trade && words(bidder.trade).some((word) => wanted.some((stem) => word.startsWith(stem))))
    .sort((a, b) => b.answered - a.answered || b.invited - a.invited || a.name.localeCompare(b.name));
}
