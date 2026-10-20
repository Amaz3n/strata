import { z } from "zod";

import { calculateEstimateTotals, estimateLineAmountCents } from "@/lib/financials/estimate-totals";
import { formatLostReason, isDeclineReasonCode, parseLostReason } from "@/lib/sales/lost-reasons";
import { tradeJobBillingDefaults, type TradeJobInput } from "@/lib/trade/workspace";

/**
 * A trade's quote: labor, material and equipment priced line by line, saved as
 * an estimate so versions, the review link and acceptance are the estimate's.
 * Everything here is pure; the service owns reads and writes.
 */

export const QUOTE_LINE_KINDS = ["labor", "material", "equipment", "other"] as const;
export type QuoteLineKind = (typeof QUOTE_LINE_KINDS)[number];

export const QUOTE_LINE_KIND_LABELS: Record<QuoteLineKind, string> = {
  labor: "Labor",
  material: "Material",
  equipment: "Equipment",
  other: "Other",
};

const isQuoteLineKind = (value: unknown): value is QuoteLineKind =>
  QUOTE_LINE_KINDS.some((kind) => kind === value);

export const quoteLineSchema = z.object({
  kind: z.enum(QUOTE_LINE_KINDS),
  /** Lines sharing a section print under one heading; blank prints first, unheaded. */
  section: z.string().trim().max(80).default(""),
  description: z.string().trim().min(1, "Describe every line.").max(500),
  /** Hours for labor, a count or length for everything else. */
  quantity: z.number().min(0).max(1_000_000),
  unit: z.string().trim().max(20).default(""),
  /** The rate (labor) or unit cost (everything else), before markup. */
  unit_price_cents: z.number().int().min(0).max(100_000_000),
  markup_percent: z.number().min(0).max(500).default(0),
  /** An add-on the customer may accept; it stays out of the quoted total. */
  optional: z.boolean().default(false),
  /** The rate schedule row a labor or equipment rate came from. */
  rate_id: z.string().uuid().nullable().default(null),
});
export type QuoteLine = z.infer<typeof quoteLineSchema>;

export const tradeQuoteSchema = z.object({
  title: z.string().trim().min(2, "Name the quote.").max(200),
  lines: z.array(quoteLineSchema).min(1, "Add at least one line.").max(300),
  tax_rate: z.number().min(0).max(25).default(0),
  valid_until: z.string().date().nullable().default(null),
  scope: z.string().trim().max(4000).default(""),
  exclusions: z.string().trim().max(4000).default(""),
  terms: z.string().trim().max(4000).default(""),
});
export type TradeQuoteInput = z.infer<typeof tradeQuoteSchema>;

export function quoteLineAmountCents(line: Pick<QuoteLine, "quantity" | "unit_price_cents" | "markup_percent">) {
  return (
    estimateLineAmountCents({
      quantity: line.quantity,
      unit_cost_cents: line.unit_price_cents,
      markup_pct: line.markup_percent,
    }) ?? 0
  );
}

export type QuoteTotals = {
  byKind: Record<QuoteLineKind, number>;
  optional: number;
  subtotal: number;
  tax: number;
  total: number;
};

/** The same arithmetic the estimate stores, so the form, the document and the portal agree. */
export function quoteTotals(lines: QuoteLine[], taxRate: number): QuoteTotals {
  const byKind: Record<QuoteLineKind, number> = { labor: 0, material: 0, equipment: 0, other: 0 };
  let optional = 0;
  for (const line of lines) {
    const amount = quoteLineAmountCents(line);
    if (line.optional) optional += amount;
    else byKind[line.kind] += amount;
  }
  const totals = calculateEstimateTotals(
    lines.map((line) => ({
      quantity: line.quantity,
      unit_cost_cents: line.unit_price_cents,
      markup_pct: line.markup_percent,
      is_optional: line.optional,
    })),
    taxRate,
  );
  return { byKind, optional, subtotal: totals.subtotal, tax: totals.tax, total: totals.total };
}

export type QuoteEstimateLine = {
  item_type: "line" | "group";
  description: string;
  quantity: number;
  unit?: string;
  unit_cost_cents: number;
  markup_pct: number;
  is_optional?: boolean;
  sort_order: number;
  metadata?: Record<string, unknown>;
};

/** Sections become the estimate's group rows, in the order the quote first uses them. */
export function quoteEstimateLines(lines: QuoteLine[]): QuoteEstimateLine[] {
  const sections: string[] = [];
  for (const line of lines) if (!sections.includes(line.section)) sections.push(line.section);
  sections.sort((a, b) => (a === "" ? -1 : b === "" ? 1 : 0));
  return sections
    .flatMap((section) => [
    ...(section
      ? [{ item_type: "group" as const, description: section, quantity: 0, unit_cost_cents: 0, markup_pct: 0 }]
      : []),
    ...lines
      .filter((line) => line.section === section)
      .map((line) => ({
        item_type: "line" as const,
        description: line.description,
        quantity: line.quantity,
        unit: line.unit || undefined,
        unit_cost_cents: line.unit_price_cents,
        markup_pct: line.markup_percent,
        is_optional: line.optional || undefined,
        metadata: { quote_kind: line.kind, ...(line.rate_id ? { rate_id: line.rate_id } : {}) },
      })),
    ])
    .map((line, index) => ({ ...line, sort_order: index }));
}

export type StoredEstimateItem = {
  item_type: string | null;
  description: string | null;
  quantity: number | string | null;
  unit: string | null;
  unit_cost_cents: number | null;
  markup_pct: number | string | null;
  sort_order: number | null;
  metadata: Record<string, unknown> | null;
};

const rateId = z.string().uuid().nullable().catch(null);

/** Reads a saved quote back into editable lines; a line without a kind is "other". */
export function quoteLinesFromEstimate(items: StoredEstimateItem[]): QuoteLine[] {
  let section = "";
  return [...items]
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    .flatMap((item) => {
      if (item.item_type === "group") {
        section = item.description?.trim() ?? "";
        return [];
      }
      const kind = item.metadata?.quote_kind;
      return [
        {
          kind: isQuoteLineKind(kind) ? kind : "other",
          section,
          description: item.description ?? "",
          quantity: Number(item.quantity ?? 0),
          unit: item.unit ?? "",
          unit_price_cents: item.unit_cost_cents ?? 0,
          markup_percent: Number(item.markup_pct ?? 0),
          optional: item.metadata?.is_optional === true,
          rate_id: rateId.parse(item.metadata?.rate_id ?? null),
        },
      ];
    });
}

// ── Stages ──────────────────────────────────────────────────────────────────

export const QUOTE_STAGES = [
  { key: "invited", label: "Invited" },
  { key: "quoting", label: "Quoting" },
  { key: "sent", label: "Sent" },
  { key: "won", label: "Won" },
  { key: "lost", label: "Lost" },
] as const;
export type QuoteStage = (typeof QUOTE_STAGES)[number]["key"];

/** Estimate statuses that mean the customer said yes. */
const ACCEPTED = new Set(["approved", "client_signed", "executed", "converted_to_project"]);

export type QuoteDocumentFacts = {
  status: string;
  sentAt: string | null;
  totalCents: number;
  /** What the customer accepted, add-ons included; null until they do. */
  acceptedTotalCents: number | null;
};

export type OpportunityFacts = {
  status: string;
  lostReason: string | null;
  dueAt: string | null;
  followUpAt: string | null;
  /** The current version of the latest quote, if there is one. */
  quote: QuoteDocumentFacts | null;
  jobId: string | null;
};

export type QuoteAction =
  | "build_quote"
  | "finish_quote"
  | "follow_up"
  | "revise"
  | "start_job"
  | "open_job"
  | "reopen";

export type QuoteMove = {
  stage: QuoteStage;
  /** The stage's word, or "Declined" for a lost deal the company turned down. */
  label: string;
  sentence: string;
  action: QuoteAction | null;
  /** Late = past due or an overdue follow-up; soon = due within two days. */
  tone: "late" | "soon" | "none";
  valueCents: number;
};

const DAY = 86_400_000;

function startOfUtcDay(at: Date) {
  return Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
}

/** Whole calendar days from today to the date (negative when past). */
export function daysUntil(at: string, now: Date) {
  return Math.round((startOfUtcDay(new Date(at)) - startOfUtcDay(now)) / DAY);
}

export function dueSentence(dueAt: string, now: Date) {
  const days = daysUntil(dueAt, now);
  if (days < -1) return `Price was due ${-days} days ago`;
  if (days === -1) return "Price was due yesterday";
  if (days === 0) return "Price is due today";
  if (days === 1) return "Price is due tomorrow";
  return `Price is due in ${days} days`;
}

function dueTone(at: string | null, now: Date): QuoteMove["tone"] {
  if (!at) return "none";
  const days = daysUntil(at, now);
  return days < 0 ? "late" : days <= 2 ? "soon" : "none";
}

/**
 * The one place a quote's stage, sentence and next action are decided. Nothing
 * is stored: the stage follows the opportunity and its current quote, so it can
 * never claim a step its documents contradict.
 */
export function quoteMove(facts: OpportunityFacts, now: Date): QuoteMove {
  const quote = facts.quote;
  const quoted = quote?.totalCents ?? 0;
  if (facts.status === "lost") {
    const declined = isDeclineReasonCode(parseLostReason(facts.lostReason).code);
    return {
      stage: "lost",
      label: declined ? "Declined" : "Lost",
      sentence: formatLostReason(facts.lostReason) ?? (declined ? "Declined" : "Lost"),
      action: "reopen",
      tone: "none",
      valueCents: quoted,
    };
  }
  if (facts.jobId)
    return {
      stage: "won",
      label: "Won",
      sentence: "Job started",
      action: "open_job",
      tone: "none",
      valueCents: quote?.acceptedTotalCents ?? quoted,
    };
  if (quote && ACCEPTED.has(quote.status))
    return {
      stage: "won",
      label: "Won",
      sentence: "Accepted. Start the job",
      action: "start_job",
      tone: "none",
      valueCents: quote.acceptedTotalCents ?? quoted,
    };
  if (facts.status === "won")
    return { stage: "won", label: "Won", sentence: "Won", action: null, tone: "none", valueCents: quoted };
  if (quote && quote.sentAt && quote.status !== "draft") {
    if (quote.status === "changes_requested")
      return { stage: "sent", label: "Sent", sentence: "Customer asked for changes", action: "revise", tone: "soon", valueCents: quoted };
    if (quote.status === "rejected")
      return { stage: "sent", label: "Sent", sentence: "Customer turned the quote down", action: "revise", tone: "soon", valueCents: quoted };
    if (!facts.followUpAt)
      return { stage: "sent", label: "Sent", sentence: "Sent. Set a follow-up", action: "follow_up", tone: "none", valueCents: quoted };
    const days = daysUntil(facts.followUpAt, now);
    return {
      stage: "sent",
      label: "Sent",
      sentence: days < 0 ? "Follow-up is overdue" : days === 0 ? "Follow up today" : `Follow up in ${days} day${days === 1 ? "" : "s"}`,
      action: "follow_up",
      tone: days < 0 ? "late" : days === 0 ? "soon" : "none",
      valueCents: quoted,
    };
  }
  if (quote)
    return {
      stage: "quoting",
      label: "Quoting",
      sentence: facts.dueAt ? dueSentence(facts.dueAt, now) : "Finish and send the quote",
      action: "finish_quote",
      tone: dueTone(facts.dueAt, now),
      valueCents: quoted,
    };
  return {
    stage: "invited",
    label: "Invited",
    sentence: facts.dueAt ? dueSentence(facts.dueAt, now) : "Build the quote",
    action: "build_quote",
    tone: dueTone(facts.dueAt, now),
    valueCents: 0,
  };
}

export type QuoteFunnel = Record<QuoteStage, { count: number; valueCents: number }>;

export function quoteFunnel(moves: QuoteMove[]): QuoteFunnel {
  const funnel = Object.fromEntries(QUOTE_STAGES.map((stage) => [stage.key, { count: 0, valueCents: 0 }])) as QuoteFunnel;
  for (const move of moves) {
    funnel[move.stage].count += 1;
    funnel[move.stage].valueCents += move.valueCents;
  }
  return funnel;
}

/** Open work first by its due date, undated after; closed deals last, newest first. */
export function compareOpportunities(
  a: { move: QuoteMove; dueAt: string | null; updatedAt: string },
  b: { move: QuoteMove; dueAt: string | null; updatedAt: string },
) {
  const closed = (row: typeof a) => row.move.stage === "won" || row.move.stage === "lost";
  if (closed(a) !== closed(b)) return closed(a) ? 1 : -1;
  if (closed(a)) return b.updatedAt.localeCompare(a.updatedAt);
  if (a.dueAt && b.dueAt && a.dueAt !== b.dueAt) return a.dueAt.localeCompare(b.dueAt);
  if (a.dueAt !== b.dueAt) return a.dueAt ? -1 : 1;
  return b.updatedAt.localeCompare(a.updatedAt);
}

/**
 * The job an accepted quote starts: the customer, the address, the scope and the
 * accepted price carry over; billing follows who the customer is, and the
 * office confirms it when starting the job.
 */
export function quoteJobDraft(input: {
  name: string;
  clientId: string | null;
  address: string;
  scope: string;
  customerIsCompany: boolean;
  acceptedTotalCents: number;
  propertyType: TradeJobInput["property_type"];
}): TradeJobInput {
  const customerKind = input.customerIsCompany ? "company" : "homeowner";
  return {
    name: input.name,
    ...(input.clientId ? { client_id: input.clientId } : {}),
    address: input.address,
    description: input.scope,
    property_type: input.propertyType,
    customer_kind: customerKind,
    ...tradeJobBillingDefaults(customerKind),
    review_before_send: false,
    total_contract_value_cents: input.acceptedTotalCents,
  };
}
