import {
  rowPricing,
  worksheetTotals,
  type PricingRow,
  type PricingWorksheet,
} from "./pricing-worksheet";
import { budgetBand, money } from "./format";
import type { ProposalSectionKey } from "./proposal-documents";
import type { ProspectStatus } from "@/lib/validation/prospects";

/**
 * The whole pipeline answers one question per deal: whose move is it, and what
 * is the one thing to do next. Everything here is derived from records; nothing
 * is stored, so a deal can never claim a stage its documents contradict.
 */

/**
 * Share of cost Arc calls a firm price. Below it, a fixed price for signature
 * is still the builder's call; Arc only says how much of it is a guess.
 */
export const FIRM_PRICE_SHARE = 0.75;

export type QuoteRequestStatus = {
  package_id: string;
  status: string;
  invite_count: number;
  response_count: number;
  due_at: string | null;
};

/** Firm = a trade's quote or a measured quantity. Allowance = a held number. Guess = your own unmeasured number. */
export type Firmness = "firm" | "allowance" | "guess";

export type LineStatus =
  | { kind: "priced"; firmness: Firmness; cost: number }
  | { kind: "included" }
  | { kind: "open" }
  | { kind: "to_bid" }
  | { kind: "request_draft"; packageId: string }
  | { kind: "awaiting_quotes"; packageId: string; invited: number; dueAt: string | null }
  | { kind: "quotes_in"; packageId: string; received: number };

export function isMeasured(row: PricingRow) {
  const takeoff = row.metadata.takeoff as { condition_id?: string; detached?: boolean } | undefined;
  return Boolean(takeoff?.condition_id && !takeoff.detached);
}

export function lineStatus(
  row: PricingRow,
  worksheet: PricingWorksheet,
  requests: QuoteRequestStatus[],
): LineStatus {
  const pricing = rowPricing(row, worksheet);
  if (pricing.covered) return { kind: "included" };
  if (pricing.cost !== null) {
    const firmness: Firmness =
      pricing.basis === "quote" || isMeasured(row)
        ? "firm"
        : pricing.basis === "allowance"
          ? "allowance"
          : "guess";
    return { kind: "priced", firmness, cost: pricing.cost };
  }
  const request = pricing.request;
  const status = request && requests.find((item) => item.package_id === request.package_id);
  if (!request || !status || status.status === "cancelled") return { kind: row.basis === "quote" ? "to_bid" : "open" };
  if (status.status === "draft" || status.invite_count === 0)
    return { kind: "request_draft", packageId: request.package_id };
  if (status.response_count > 0)
    return { kind: "quotes_in", packageId: request.package_id, received: status.response_count };
  return {
    kind: "awaiting_quotes",
    packageId: request.package_id,
    invited: status.invite_count,
    dueAt: status.due_at,
  };
}

/** Lines marked to go out for bids that no live request covers yet: the Bids tab's first job. */
export function linesToBid(worksheet: PricingWorksheet, requests: QuoteRequestStatus[]) {
  return worksheet.rows.filter((row) => {
    if (row.basis !== "quote") return false;
    const request = worksheet.requests.find((item) => item.row_ids.includes(row.id));
    const status = request && requests.find((item) => item.package_id === request.package_id);
    return !status || status.status === "cancelled";
  });
}

export type PriceFirmness = {
  firm: number;
  allowance: number;
  guess: number;
  cost: number;
  /** 0..1 share of priced cost that is firm. */
  firmShare: number;
  unpriced: number;
  total: number;
  range: { low: number; high: number };
  lines: Map<string, LineStatus>;
};

const RANGE_STEP = 50_000;

export function priceFirmness(
  worksheet: PricingWorksheet,
  requests: QuoteRequestStatus[],
): PriceFirmness {
  const lines = new Map<string, LineStatus>();
  const sums = { firm: 0, allowance: 0, guess: 0 };
  let unpriced = 0;
  for (const row of worksheet.rows) {
    const status = lineStatus(row, worksheet, requests);
    lines.set(row.id, status);
    if (status.kind === "priced") {
      if (!row.is_optional) sums[status.firmness] += status.cost;
    } else if (status.kind !== "included") unpriced++;
  }
  const totals = worksheetTotals(worksheet);
  const cost = sums.firm + sums.allowance + sums.guess;
  // Soft cost carries its share of markup, contingency and tax into the range.
  const sell = cost > 0 ? totals.total / cost : 1;
  const low = totals.total - sums.guess * sell * 0.1;
  const high = totals.total + sums.guess * sell * 0.2 + sums.allowance * sell * 0.05;
  return {
    ...sums,
    cost,
    firmShare: cost > 0 ? sums.firm / cost : 0,
    unpriced,
    total: totals.total,
    range: {
      low: Math.max(0, Math.floor(low / RANGE_STEP) * RANGE_STEP),
      high: Math.ceil(high / RANGE_STEP) * RANGE_STEP,
    },
    lines,
  };
}

export type DealDocument = {
  id: string;
  purpose: "budget" | "construction_agreement";
  status: string;
  version: number;
  total_cents: number;
  sent_at: string | null;
  viewed_at: string | null;
  responded_at: string | null;
  decision_note: string | null;
  /** The worksheet has moved since this version was prepared. */
  changed_since: boolean;
};

export type DealMoveInput = {
  now: Date;
  clientName: string | null;
  status: ProspectStatus;
  lostReason: string | null;
  projectPhase: "precon" | "delivery" | null;
  worksheet: PricingWorksheet | null;
  requests: QuoteRequestStatus[];
  proposal: DealDocument | null;
  agreement: DealDocument | null;
  openQuestions: number;
  /** How the proposal is priced: a fixed price to sign (the default) or a range to approve. */
  priceMode?: "signature" | "range";
  /** Proposal sections still waiting on the builder; the deal room knows them, the list does not. */
  proposalNeeds?: Array<{ key: ProposalSectionKey; name: string; label: string }>;
  /** Client comments on the document nobody has answered. */
  unansweredComments?: number;
  /** What new plans did to measured lines: measurements to confirm, then quantities that moved. */
  planChanges?: { review: number; changed: number };
};

export type DealBall = "you" | "trades" | "client" | "building" | "closed";

export type DealAction =
  | { kind: "start_price" }
  | { kind: "add_line" }
  | { kind: "price_line"; rowId: string }
  | { kind: "review_plan_measurements" }
  | { kind: "review_plan_quantities" }
  | { kind: "request_bids" }
  | { kind: "send_request"; rowId: string }
  | { kind: "review_quotes"; rowId: string }
  | { kind: "follow_up_trades"; rowId: string }
  | { kind: "open_proposal"; section: ProposalSectionKey }
  | { kind: "send"; document: "budget" | "agreement" }
  | { kind: "remind_client"; documentId: string }
  | { kind: "revise" }
  | { kind: "countersign"; documentId: string }
  | { kind: "start_building" }
  | { kind: "open_project" }
  | { kind: "reopen" };

/** The five places a deal can be. Order is the order work happens in. */
export const DEAL_STOPS = ["Talking", "Pricing", "With client", "Signed", "Building"] as const;

export type DealMove = {
  ball: DealBall;
  stop: number;
  sentence: string;
  action: DealAction | null;
  label: string | null;
  detail: string | null;
  /** Whether the next send asks for a signature rather than approval of a range. */
  signable: boolean;
  firmness: PriceFirmness | null;
};

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;
const list = (items: string[]) =>
  items.length <= 2
    ? items.join(" and ")
    : `${items.slice(0, 2).join(", ")} and ${items.length - 2} more`;
const days = (from: string, now: Date) =>
  Math.max(0, Math.floor((now.getTime() - new Date(from).getTime()) / 86_400_000));
const ago = (from: string, now: Date) => {
  const count = days(from, now);
  return count === 0 ? "today" : count === 1 ? "yesterday" : `${count} days ago`;
};
const firstName = (name: string | null) => name?.trim().split(/\s+/)[0] || null;
const kindOf = (document: DealDocument) =>
  document.purpose === "budget" ? "estimate" : "proposal";

function sentDocument(input: DealMoveInput) {
  // An agreement supersedes the budget it came from.
  return input.agreement && input.agreement.status !== "void"
    ? input.agreement
    : input.proposal;
}

export function dealMove(input: DealMoveInput): DealMove {
  const name = firstName(input.clientName);
  const client = name ?? "the client";
  const Client = name ?? "The client";
  const firmness = input.worksheet ? priceFirmness(input.worksheet, input.requests) : null;
  const signable = (input.priceMode ?? "signature") === "signature";
  const move = (
    ball: DealBall,
    stop: number,
    sentence: string,
    action: DealAction | null,
    label: string | null,
    detail: string | null = null,
  ): DealMove => ({ ball, stop, sentence, action, label, detail, signable, firmness });

  if (input.status === "lost")
    return move(
      "closed",
      0,
      `Lost${input.lostReason ? `: ${input.lostReason}` : ""}.`,
      { kind: "reopen" },
      "Reopen deal",
    );
  if (input.projectPhase === "delivery" || input.status === "won")
    return move("building", 4, "Signed and handed off to the job.", { kind: "open_project" }, "Open project");

  const document = sentDocument(input);
  if (document?.purpose === "construction_agreement") {
    if (["executed", "converted_to_project"].includes(document.status))
      return move(
        "you",
        3,
        `Signed by both sides at ${money(document.total_cents)}.`,
        { kind: "start_building" },
        "Start building",
        "Creates the job with its contract and budget.",
      );
    if (document.status === "client_signed")
      return move(
        "you",
        2,
        `${Client} signed. Countersign to make it a contract.`,
        { kind: "countersign", documentId: document.id },
        "Countersign",
      );
  }

  const comments = input.unansweredComments ?? 0;
  if (document && !document.changed_since && comments && ["sent", "approved", "changes_requested"].includes(document.status))
    return move(
      "you",
      2,
      `${Client} asked ${plural(comments, "question")} on the ${kindOf(document)}.`,
      { kind: "open_proposal", section: "questions" },
      comments === 1 ? "Answer it" : "Answer them",
      `${Client} sees your answer on the document.`,
    );

  const plans = input.planChanges;
  if (input.worksheet && plans?.review)
    return move(
      "you",
      1,
      `New plans moved the measurements on ${plural(plans.review, "line")}. Check they still sit right.`,
      { kind: "review_plan_measurements" },
      "Review measurements",
      "They count again once you confirm them on the new sheets.",
    );
  if (input.worksheet && plans?.changed)
    return move(
      "you",
      1,
      `New plans changed the quantity on ${plural(plans.changed, "measured line")}.`,
      { kind: "review_plan_quantities" },
      "Review quantities",
      "Nothing on the price changes until you choose.",
    );

  if (document?.status === "sent" && !document.changed_since) {
    const sentAt = document.sent_at ?? input.now.toISOString();
    return move(
      "client",
      2,
      document.viewed_at
        ? `${Client} opened the ${kindOf(document)} and hasn't answered yet.`
        : `${Client} hasn't opened the ${kindOf(document)} yet.`,
      { kind: "remind_client", documentId: document.id },
      `Remind ${name ?? "client"}`,
      `Sent ${ago(sentAt, input.now)}.`,
    );
  }

  if (
    document &&
    ["changes_requested", "rejected"].includes(document.status) &&
    !document.changed_since
  )
    return move(
      "you",
      1,
      document.status === "rejected"
        ? `${Client} declined the ${kindOf(document)}${document.decision_note ? `: “${document.decision_note}”` : "."}`
        : `${Client} asked for changes${document.decision_note ? `: “${document.decision_note}”` : "."}`,
      { kind: "revise" },
      "Revise the price",
      "Change the lines on Pricing, then send the new version.",
    );

  const worksheet = input.worksheet;
  if (worksheet && !worksheet.rows.length)
    return move("you", 1, "Add the first line of work.", { kind: "add_line" }, "Add a line");
  if (!worksheet)
    return move(
      "you",
      0,
      "Nothing is priced yet.",
      { kind: "start_price" },
      "Start the price",
      "From a template, the plans, a past deal or a blank sheet.",
    );

  const rows = (kind: LineStatus["kind"]) =>
    worksheet.rows.filter((row) => firmness?.lines.get(row.id)?.kind === kind);
  const open = rows("open");
  const toBid = linesToBid(worksheet, input.requests);
  const drafts = rows("request_draft");
  const quotesIn = rows("quotes_in");
  const awaiting = rows("awaiting_quotes");
  const approved = document?.purpose === "budget" && document.status === "approved";

  if (open.length)
    return move(
      "you",
      1,
      `${plural(open.length, "line needs", "lines need")} a price${awaiting.length ? `, ${awaiting.length} waiting on trades` : ""}.`,
      { kind: "price_line", rowId: open[0].id },
      `Price ${open[0].description}`,
    );
  if (toBid.length)
    return move(
      "you",
      1,
      `${plural(toBid.length, "line goes", "lines go")} out for bids: ${list(toBid.map((row) => row.description))}.`,
      { kind: "request_bids" },
      "Request bids",
      "Group what one trade prices into one request.",
    );
  if (drafts.length)
    return move(
      "you",
      1,
      `The bid request for ${drafts[0].description} hasn't gone out.`,
      { kind: "send_request", rowId: drafts[0].id },
      "Send bid request",
    );
  if (quotesIn.length)
    return move(
      "you",
      1,
      `Bids are in for ${list(quotesIn.map((row) => row.description))}. Pick one.`,
      { kind: "review_quotes", rowId: quotesIn[0].id },
      "Review bids",
    );
  if (awaiting.length) {
    const first = firmness?.lines.get(awaiting[0].id);
    const due = first?.kind === "awaiting_quotes" && first.dueAt ? first.dueAt : null;
    return move(
      "trades",
      1,
      `Waiting on bids for ${list(awaiting.map((row) => row.description))}.`,
      { kind: "follow_up_trades", rowId: awaiting[0].id },
      "Follow up with trades",
      due
        ? `Due ${new Date(due).toLocaleDateString("en-US", { month: "short", day: "numeric" })}. Everything else is priced.`
        : "Everything else is priced.",
    );
  }

  const share = Math.round((firmness?.firmShare ?? 0) * 100);
  const need = input.proposalNeeds?.[0];
  if (need)
    return move(
      "you",
      1,
      `${need.name}: ${need.label.charAt(0).toLowerCase()}${need.label.slice(1)}.`,
      { kind: "open_proposal", section: need.key },
      `Finish ${need.name.toLowerCase()}`,
      input.proposalNeeds && input.proposalNeeds.length > 1
        ? `${plural(input.proposalNeeds.length - 1, "more section")} after this, then it is ready to send.`
        : "Then it is ready to send.",
    );
  const questions = input.openQuestions
    ? ` ${Client} answers ${plural(input.openQuestions, "question")} on it before signing.`
    : "";
  if (signable)
    return move(
      "you",
      1,
      approved ? `${Client} approved the estimate. Send the proposal to sign.` : `Every line has a price. Ready for ${client} to sign.`,
      { kind: "send", document: "agreement" },
      "Send for signature",
      `${money(firmness?.total ?? 0)} fixed price, ${share}% firm.${questions}`,
    );
  const range = firmness?.range ?? { low: 0, high: 0 };
  if (approved)
    return move(
      "you",
      1,
      `${Client} approved ${money(range.low)}–${money(range.high)}. Set a fixed price to send it for signature.`,
      { kind: "open_proposal", section: "price" },
      "Set a fixed price",
    );
  return move(
    "you",
    1,
    `Every line has a price. ${share}% of it is firm.`,
    { kind: "send", document: "budget" },
    document?.purpose === "budget" && document.sent_at ? "Send updated estimate" : "Send for approval",
    `${Client} approves ${money(range.low)}–${money(range.high)}. Nothing is signed.`,
  );
}

/**
 * What a deal is worth, as precisely as its records allow: the budget the client
 * stated, then what is priced so far, then the range an estimate shows, then a price.
 */
export type DealValue =
  /** A single number, and what it rests on: the sent agreement, firm costs, or the last proposal. */
  | { kind: "price"; cents: number; basis: "agreement" | "firm" | "proposal" }
  | { kind: "range"; low: number; high: number }
  | { kind: "priced_so_far"; cents: number }
  | { kind: "budget"; label: string }
  | { kind: "none" };

export function dealValue(
  move: DealMove,
  documents: { proposal: DealDocument | null; agreement: DealDocument | null },
  statedBudget: string | null,
): DealValue {
  const { proposal, agreement } = documents;
  // The agreement's total is what the client was offered, whatever the worksheet says since.
  if (agreement && agreement.status !== "void" && agreement.total_cents > 0)
    return { kind: "price", cents: agreement.total_cents, basis: "agreement" };
  const firmness = move.firmness;
  if (firmness && firmness.cost > 0) {
    if (firmness.unpriced > 0) return { kind: "priced_so_far", cents: firmness.total };
    // How firm the cost is decides how the value reads, whichever way the builder sends it.
    if (firmness.firmShare >= FIRM_PRICE_SHARE) return { kind: "price", cents: firmness.total, basis: "firm" };
    return { kind: "range", low: firmness.range.low, high: firmness.range.high };
  }
  if (proposal && proposal.total_cents > 0) return { kind: "price", cents: proposal.total_cents, basis: "proposal" };
  // Before anything is priced, the band the client named is all there is to show.
  const band = budgetBand(statedBudget);
  if (band) return { kind: "budget", label: band };
  return { kind: "none" };
}

/** One number for totals: a range counts at its midpoint; a stated band is not money yet. */
export function dealValueCents(value: DealValue) {
  switch (value.kind) {
    case "range":
      return Math.round((value.low + value.high) / 2);
    case "budget":
    case "none":
      return 0;
    default:
      return value.cents;
  }
}
