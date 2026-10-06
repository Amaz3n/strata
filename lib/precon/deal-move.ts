import {
  rowPricing,
  worksheetTotals,
  type PricingRow,
  type PricingWorksheet,
} from "./pricing-worksheet";
import { money } from "./format";
import type { ProspectStatus } from "@/lib/validation/prospects";

/**
 * The whole pipeline answers one question per deal: whose move is it, and what
 * is the one thing to do next. Everything here is derived from records; nothing
 * is stored, so a deal can never claim a stage its documents contradict.
 */

/** Share of cost that must be firm before Arc offers a signature instead of a budget. */
export const SIGNATURE_FIRMNESS = 0.75;

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
  if (!request || !status || status.status === "cancelled") return { kind: "open" };
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
  scope: string;
  worksheet: PricingWorksheet | null;
  requests: QuoteRequestStatus[];
  proposal: DealDocument | null;
  agreement: DealDocument | null;
  openQuestions: number;
};

export type DealBall = "you" | "trades" | "client" | "building" | "closed";

export type DealAction =
  | { kind: "describe" }
  | { kind: "start_pricing" }
  | { kind: "add_line" }
  | { kind: "price_line"; rowId: string }
  | { kind: "send_request"; rowId: string }
  | { kind: "review_quotes"; rowId: string }
  | { kind: "follow_up_trades"; rowId: string }
  | { kind: "firm_up"; rowId: string }
  | { kind: "answer_questions" }
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
  /** Whether the next send would be a signable agreement rather than a budget. */
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
  document.purpose === "budget" ? "budget" : "agreement";

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
  const signable = Boolean(
    firmness &&
      input.worksheet?.rows.length &&
      firmness.unpriced === 0 &&
      firmness.firmShare >= SIGNATURE_FIRMNESS &&
      input.openQuestions === 0,
  );
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
      "Change the lines below, then send the new version.",
    );

  const worksheet = input.worksheet;
  if (worksheet && !worksheet.rows.length)
    return move("you", 1, "Add the first line of work.", { kind: "add_line" }, "Add a line");
  if (!worksheet) {
    if (!input.scope.trim())
      return move(
        "you",
        0,
        `Write down what ${client} wants built.`,
        { kind: "describe" },
        "Start pricing",
        "One idea per line. Each line becomes something to price.",
      );
    return move(
      "you",
      0,
      "Turn your notes into lines to price.",
      { kind: "start_pricing" },
      "Start pricing",
      "Each line of your notes becomes a line to price.",
    );
  }

  const rows = (kind: LineStatus["kind"]) =>
    worksheet.rows.filter((row) => firmness?.lines.get(row.id)?.kind === kind);
  const open = rows("open");
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
  if (drafts.length)
    return move(
      "you",
      1,
      `The quote request for ${drafts[0].description} hasn't gone out.`,
      { kind: "send_request", rowId: drafts[0].id },
      "Send quote request",
    );
  if (quotesIn.length)
    return move(
      "you",
      1,
      `Quotes are in for ${list(quotesIn.map((row) => row.description))}. Pick one.`,
      { kind: "review_quotes", rowId: quotesIn[0].id },
      "Review quotes",
    );
  if (awaiting.length) {
    const first = firmness?.lines.get(awaiting[0].id);
    const due = first?.kind === "awaiting_quotes" && first.dueAt ? first.dueAt : null;
    return move(
      "trades",
      1,
      `Waiting on quotes for ${list(awaiting.map((row) => row.description))}.`,
      { kind: "follow_up_trades", rowId: awaiting[0].id },
      "Follow up with trades",
      due
        ? `Due ${new Date(due).toLocaleDateString("en-US", { month: "short", day: "numeric" })}. Everything else is priced.`
        : "Everything else is priced.",
    );
  }

  const share = Math.round((firmness?.firmShare ?? 0) * 100);
  if (signable)
    return move(
      "you",
      1,
      approved
        ? `${Client} approved the budget, and the price is now ${share}% firm.`
        : `The price is ${share}% firm. Ready for ${client} to sign.`,
      { kind: "send", document: "agreement" },
      "Send for signature",
      `${money(firmness?.total ?? 0)} fixed price, with your terms.`,
    );

  const soft = (firmness?.guess ?? 0) + (firmness?.allowance ?? 0);
  const blocker =
    (firmness?.firmShare ?? 0) < SIGNATURE_FIRMNESS
      ? `Firm up ${money(soft)} of guesses and allowances`
      : `Answer ${plural(input.openQuestions, "open question")}`;
  if (approved) {
    const guess = worksheet.rows.find((row) => {
      const status = firmness?.lines.get(row.id);
      return status?.kind === "priced" && status.firmness !== "firm";
    });
    return move(
      "you",
      1,
      `${Client} approved the budget. Firm it up to send for signature.`,
      guess && (firmness?.firmShare ?? 0) < SIGNATURE_FIRMNESS
        ? { kind: "firm_up", rowId: guess.id }
        : { kind: "answer_questions" },
      guess && (firmness?.firmShare ?? 0) < SIGNATURE_FIRMNESS
        ? `Firm up ${guess.description}`
        : "Answer open questions",
      `${blocker} to send for signature.`,
    );
  }
  const range = firmness?.range ?? { low: 0, high: 0 };
  return move(
    "you",
    1,
    `Every line has a price. ${share}% of it is firm.`,
    { kind: "send", document: "budget" },
    document?.purpose === "budget" && document.sent_at ? "Send updated budget" : "Send budget",
    `${Client} sees ${money(range.low)}–${money(range.high)}. ${blocker} to send for signature.`,
  );
}
