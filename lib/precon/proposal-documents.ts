import { z } from "zod";
import type { EstimateCommercial } from "@/lib/financials/estimate-commercial";
import { estimateLineAmountCents } from "@/lib/financials/estimate-totals";
import { money } from "./format";

/**
 * Client-facing names. A deal's document is a proposal whether it asks for a
 * signature or for approval of a range; how it is priced is said inside it,
 * not by renaming it.
 */
export function proposalDocumentLabel(
  commercial: Pick<EstimateCommercial, "purpose" | "maturity">,
) {
  if (commercial.purpose === "preconstruction_agreement")
    return "Preconstruction services agreement";
  return "Proposal";
}

/** Copy content into a new document without inheriting the source's autosave identity. */
export function freshDocumentSeed<
  T extends {
    id?: string;
    status?: string;
    updated_at?: string;
    version?: number | null;
  },
>(source: T) {
  const copy = { ...source };
  delete copy.id;
  delete copy.status;
  delete copy.updated_at;
  delete copy.version;
  return copy;
}

// ---------------------------------------------------------------------------
// The deal proposal: what the builder writes around the price.
//
// The price itself is never edited here: lines, options and allowances come
// from the pricing worksheet. Everything else is a section the builder can
// leave on its default (null / absent) or edit; a null means "follow the
// template", so a template change reaches every deal that never edited it.
// ---------------------------------------------------------------------------

export const PROPOSAL_SECTIONS = [
  "cover",
  "scope",
  "price",
  "options",
  "allowances",
  "inclusions",
  "payments",
  "schedule",
  "terms",
  "signatures",
  "questions",
] as const;
export type ProposalSectionId = (typeof PROPOSAL_SECTIONS)[number];

export const PROPOSAL_SECTION_NAMES: Record<ProposalSectionId, string> = {
  cover: "Cover letter",
  scope: "Scope of work",
  price: "Price",
  options: "Options",
  allowances: "Allowances",
  inclusions: "Inclusions and exclusions",
  payments: "Payment schedule",
  schedule: "Schedule",
  terms: "Terms",
  signatures: "Signatures",
  questions: "Questions and comments",
};

/** How the client's document heads each section when the builder has not renamed it. */
export const PROPOSAL_DOCUMENT_HEADINGS: Record<ProposalSectionId, string> = {
  cover: "Letter",
  scope: "Scope of work",
  price: "Price",
  options: "Options",
  allowances: "Allowances",
  inclusions: "What's included",
  payments: "Payment schedule",
  schedule: "Schedule",
  terms: "Terms",
  signatures: "Signatures",
  questions: "Your questions",
};

/** A range is approved, not signed: it has no payments and nothing to sign. */
export const AGREEMENT_ONLY_SECTIONS: readonly ProposalSectionId[] = ["payments", "signatures"];

/**
 * Sections that cannot be turned off: the price is the document, signatures are
 * what make it one, and options and the client's questions appear whenever
 * there is something to show. They can still be moved and renamed.
 */
export const LOCKED_SECTIONS: readonly ProposalSectionId[] = ["price", "options", "signatures", "questions"];

/** A section the builder wrote themselves: "custom:" and a short id. */
const CUSTOM_SECTION_KEY = /^custom:[a-z0-9-]{1,40}$/;
export const proposalSectionKeySchema = z.union([z.enum(PROPOSAL_SECTIONS), z.string().regex(CUSTOM_SECTION_KEY)]);
/** A built-in section's id, or a custom section's "custom:…" key. */
export type ProposalSectionKey = string;

export function isBuiltInSection(key: string): key is ProposalSectionId {
  return (PROPOSAL_SECTIONS as readonly string[]).includes(key);
}

/** One section in the order the document reads: on or off, under its own heading if renamed. */
export const proposalLayoutEntrySchema = z.object({
  key: proposalSectionKeySchema,
  /** Null reads the section's standard name. */
  title: z.string().trim().max(120).nullable().default(null),
  on: z.boolean().default(true),
  /** A custom section's text; built-in sections write theirs elsewhere. */
  body: z.string().max(20000).default(""),
});
export type ProposalLayoutEntry = z.infer<typeof proposalLayoutEntrySchema>;
const layoutSchema = z.array(proposalLayoutEntrySchema).max(40);

/**
 * The layout as the document uses it: every built-in section exactly once (a
 * section Arc adds later joins at the end, on), custom sections where the
 * builder put them, and the locked sections always on.
 */
export function normalizeProposalLayout(layout: ProposalLayoutEntry[] | null | undefined): ProposalLayoutEntry[] {
  const seen = new Set<string>();
  const entries: ProposalLayoutEntry[] = [];
  for (const entry of layout ?? []) {
    if (seen.has(entry.key)) continue;
    seen.add(entry.key);
    entries.push(isBuiltInSection(entry.key) && LOCKED_SECTIONS.includes(entry.key) ? { ...entry, on: true } : entry);
  }
  for (const key of PROPOSAL_SECTIONS)
    if (!seen.has(key)) entries.push({ key, title: null, on: true, body: "" });
  return entries;
}

export function proposalSectionTitle(entry: Pick<ProposalLayoutEntry, "key" | "title">) {
  return entry.title?.trim() || (isBuiltInSection(entry.key) ? PROPOSAL_SECTION_NAMES[entry.key] : "Untitled section");
}

export const proposalPaymentSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().trim().min(1, "Name each payment.").max(120),
  when: z.string().trim().max(200).default(""),
  percent: z.number().finite().min(0).max(100),
});
export type ProposalPayment = z.infer<typeof proposalPaymentSchema>;

export const proposalSignerSchema = z.object({
  name: z.string().trim().min(1, "Enter the signer's name.").max(200),
  email: z.string().trim().email("Enter the signer's email.").max(320),
});
export type ProposalSigner = z.infer<typeof proposalSignerSchema>;

const listSchema = z.array(z.string().trim().min(1).max(500)).max(100);

export const dealProposalSchema = z.object({
  cover: z.string().max(20000).nullable().default(null),
  /** Paragraph per Pricing section, keyed by the section's name ("" for unsectioned lines). */
  scope: z.record(z.string().max(200), z.string().max(12000)).default({}),
  pricing_display: z.enum(["sections", "itemized", "lump_sum"]).default("sections"),
  allowance_policy: z.string().max(12000).nullable().default(null),
  inclusions: listSchema.nullable().default(null),
  exclusions: listSchema.nullable().default(null),
  /** What the builder decided about each exclusion a chosen bid carried. */
  suggestions: z.record(z.string().max(700), z.enum(["excluded", "covered"])).default({}),
  payments: z.array(proposalPaymentSchema).max(24).nullable().default(null),
  start_window: z.string().trim().max(120).default(""),
  duration_weeks: z.number().int().min(1).max(260).nullable().default(null),
  valid_days: z.number().int().min(1).max(365).default(30),
  terms: z.string().max(20000).nullable().default(null),
  /** Who signs beside the deal's client, such as a spouse or business partner, in signing order. */
  co_signers: z.array(proposalSignerSchema).max(3).default([]),
  /** "signature": a fixed price the client signs. "range": an estimate the client approves; nothing is signed. */
  price_mode: z.enum(["signature", "range"]).default("signature"),
  /** Which sections the document has, in what order, under what headings. Null follows the builder's default. */
  layout: layoutSchema.nullable().default(null),
});
export type DealProposal = z.infer<typeof dealProposalSchema>;
export const EMPTY_DEAL_PROPOSAL: DealProposal = dealProposalSchema.parse({});

/** What a builder saves once and every new deal starts from. */
export type ProposalDefaults = {
  cover: string;
  terms: string;
  allowance_policy: string;
  inclusions: string[];
  exclusions: string[];
  payments: Array<Omit<ProposalPayment, "id">>;
  layout: ProposalLayoutEntry[];
};

export const PROPOSAL_TEMPLATE_FIELDS = ["{client}", "{project}", "{builder}", "{sender}"] as const;

export const BUILT_IN_PROPOSAL_DEFAULTS: ProposalDefaults = {
  cover: [
    "Dear {client},",
    "",
    "Thank you for the chance to price {project}. This proposal sets out the work, the price and how we would run the job, priced from your plans and from bids by the trades who would do the work.",
    "",
    "Anything listed as an option is yours to decide on below. If anything is unclear, ask on that section and we will answer there.",
    "",
    "{sender}",
    "{builder}",
  ].join("\n"),
  terms: [
    "Changes to the work are made by written change order, priced before the work is done.",
    "We warrant our workmanship for one year from substantial completion. Manufacturer warranties pass through to you.",
    "Concealed conditions found once work begins are priced and approved by change order before we proceed.",
  ].join("\n"),
  allowance_policy:
    "Allowances are reconciled against your actual selections by change order. If a selection costs more or less, the difference is billed or credited with the same markup.",
  inclusions: [
    "All permits and inspections",
    "Daily cleanup and a final clean",
    "Dumpster and haul-off",
    "One-year workmanship warranty",
  ],
  exclusions: ["Furniture, window treatments and decor"],
  payments: [
    { name: "Deposit", when: "On signing", percent: 10 },
    { name: "Rough-ins pass inspection", when: "Framing, electrical and plumbing", percent: 30 },
    { name: "Substantial completion", when: "Punch list issued", percent: 50 },
    { name: "Final walk-through", when: "Punch list closed", percent: 10 },
  ],
  layout: normalizeProposalLayout([]),
};

/** Org settings keys that hold the saved defaults. Each is its own key so one save never overwrites another. */
export const PROPOSAL_DEFAULT_SETTING_KEYS = {
  cover: "estimate_intro_template",
  terms: "proposal_terms_template",
  allowance_policy: "proposal_allowance_policy",
  inclusions: "proposal_inclusions",
  exclusions: "proposal_exclusions",
  payments: "proposal_payment_schedule",
  layout: "proposal_sections",
} as const satisfies Record<keyof ProposalDefaults, string>;
export type ProposalDefaultField = keyof ProposalDefaults;

const savedPaymentsSchema = z.array(proposalPaymentSchema.omit({ id: true })).min(1).max(24);

/** Read the saved defaults from org settings; anything missing or malformed falls back to Arc's. */
export function proposalDefaultsFromSettings(settings: Record<string, unknown>): ProposalDefaults {
  const text = (key: string, fallback: string) => {
    const value = settings[key];
    return typeof value === "string" && value.trim() ? value : fallback;
  };
  const list = (key: string, fallback: string[]) => {
    const parsed = listSchema.safeParse(settings[key]);
    return parsed.success ? parsed.data : fallback;
  };
  const payments = savedPaymentsSchema.safeParse(settings[PROPOSAL_DEFAULT_SETTING_KEYS.payments]);
  const keys = PROPOSAL_DEFAULT_SETTING_KEYS;
  const builtIn = BUILT_IN_PROPOSAL_DEFAULTS;
  return {
    cover: text(keys.cover, builtIn.cover),
    terms: text(keys.terms, builtIn.terms),
    allowance_policy: text(keys.allowance_policy, builtIn.allowance_policy),
    inclusions: list(keys.inclusions, builtIn.inclusions),
    exclusions: list(keys.exclusions, builtIn.exclusions),
    payments: payments.success ? payments.data : builtIn.payments,
    layout: normalizeProposalLayout(layoutSchema.catch(builtIn.layout).parse(settings[keys.layout] ?? builtIn.layout)),
  };
}

export type ProposalNames = {
  /** The client first names as the letter addresses them: "Elena and David". */
  client: string;
  project: string;
  builder: string;
  sender: string;
};

/** Fill the template's fields with this deal's names. */
export function fillProposalTemplate(template: string, names: ProposalNames) {
  return template
    .replaceAll("{client}", names.client)
    .replaceAll("{project}", names.project)
    .replaceAll("{builder}", names.builder)
    .replaceAll("{sender}", names.sender);
}

/** Turn one deal's letter back into a template, so saving it as the default does not hard-code this client. */
export function proposalTemplateFromText(text: string, names: ProposalNames) {
  const fields = (Object.entries(names) as Array<[keyof ProposalNames, string]>)
    .filter(([, value]) => value.trim().length > 1)
    // The longest name first, so "Elena and David" is replaced before "Elena".
    .sort((a, b) => b[1].length - a[1].length);
  let template = text;
  for (const [field, value] of fields) template = template.split(value).join(`{${field}}`);
  return template;
}

/** "Elena", "Elena and David", "Elena, David and Ana". */
export function firstNames(names: string[]) {
  const first = names.map((name) => name.trim().split(/\s+/)[0]).filter(Boolean);
  if (first.length <= 1) return first[0] ?? "";
  return `${first.slice(0, -1).join(", ")} and ${first[first.length - 1]}`;
}

export type ProposalPriceLine = {
  section: string;
  description: string;
  notes: string;
  amount_cents: number;
  is_optional: boolean;
  is_allowance: boolean;
};

/** The document's lines as the proposal reads them: each with its section and sell price. */
export function proposalPriceLines(
  lines: Array<{
    item_type?: "line" | "group";
    description: string;
    quantity: number;
    unit_cost_cents: number;
    markup_pct?: number;
    notes?: string;
    is_optional?: boolean;
    is_allowance?: boolean;
  }>,
): ProposalPriceLine[] {
  let section = "";
  const result: ProposalPriceLine[] = [];
  for (const line of lines) {
    if (line.item_type === "group") {
      section = line.description;
      continue;
    }
    result.push({
      section,
      description: line.description,
      notes: line.notes ?? "",
      amount_cents: estimateLineAmountCents(line) ?? 0,
      is_optional: Boolean(line.is_optional),
      is_allowance: Boolean(line.is_allowance),
    });
  }
  return result;
}

/** One paragraph per section of the price, written from the notes on its lines. */
export function defaultScopeParagraphs(lines: ProposalPriceLine[]) {
  const sections = new Map<string, string[]>();
  for (const line of lines) {
    if (line.is_optional) continue;
    const notes = sections.get(line.section) ?? [];
    const note = line.notes.trim().replace(/\s+/g, " ");
    if (note) notes.push(/[.!?]$/.test(note) ? note : `${note}.`);
    sections.set(line.section, notes);
  }
  return [...sections].map(([section, notes]) => ({ section, text: notes.join(" ") }));
}

export type ExclusionSuggestion = { key: string; text: string; from: string };

/** Split a trade's free-text exclusions into one item per line or bullet. */
export function splitExclusions(text: string | null | undefined) {
  return (text ?? "")
    .split(/\r?\n|;|•/)
    .map((item) => item.replace(/^[\s\-*\d.)]+/, "").trim())
    .filter((item) => item.length > 2);
}

/**
 * What the chosen bids leave out, so the client hears it from the builder.
 * Each suggestion stays until the builder excludes it or says it is covered.
 */
export function exclusionSuggestions(
  bids: Array<{ submissionId: string; company: string | null; exclusions: string[] }>,
  proposal: Pick<DealProposal, "suggestions">,
  excluded: string[],
): ExclusionSuggestion[] {
  const seen = new Set(excluded.map((item) => item.toLowerCase()));
  const suggestions: ExclusionSuggestion[] = [];
  for (const bid of bids)
    for (const text of bid.exclusions) {
      const key = `${bid.submissionId}:${text.toLowerCase()}`.slice(0, 700);
      if (proposal.suggestions[key] || seen.has(text.toLowerCase())) continue;
      seen.add(text.toLowerCase());
      suggestions.push({ key, text, from: `${bid.company ?? "A trade"}'s bid` });
    }
  return suggestions;
}

/** Each payment's share of the price, in cents; the last absorbs rounding so a full schedule bills exactly the price. */
export function paymentAmounts(totalCents: number, payments: Array<{ percent: number }>) {
  const amounts = payments.map((payment) => Math.round((totalCents * payment.percent) / 100));
  if (amounts.length && paymentPercentTotal(payments) === 100)
    amounts[amounts.length - 1] += totalCents - amounts.reduce((sum, amount) => sum + amount, 0);
  return amounts;
}

export function paymentPercentTotal(payments: Array<{ percent: number }>) {
  return Math.round(payments.reduce((sum, payment) => sum + payment.percent, 0) * 100) / 100;
}

/** The schedule in a sentence, for the commercial terms every agreement carries. */
export function paymentTermsText(payments: Array<Omit<ProposalPayment, "id">>) {
  return payments
    .map((payment) => `${payment.name}, ${payment.percent}%${payment.when ? ` (${payment.when.toLowerCase()})` : ""}`)
    .join("; ")
    .concat(".");
}

export function addDays(day: Date, days: number) {
  const next = new Date(day);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

const proposalChangeSchema = z.object({ label: z.string(), text: z.string() });
export type ProposalChange = z.infer<typeof proposalChangeSchema>;

/**
 * The proposal as the client reads it: every default resolved, every section
 * filled. Each sent version keeps its own copy, so a later template change
 * never rewrites what a client was sent.
 */
export const proposalDocumentSchema = z.object({
  kind: z.enum(["budget", "agreement"]),
  cover: z.string(),
  scope: z.array(z.object({ section: z.string(), text: z.string(), lines: z.array(z.string()) })),
  allowances: z.array(z.object({ section: z.string(), description: z.string(), amount_cents: z.number().int() })),
  allowance_policy: z.string(),
  inclusions: z.array(z.string()),
  exclusions: z.array(z.string()),
  /** Empty on a budget. */
  payments: z.array(proposalPaymentSchema.omit({ id: true })),
  start_window: z.string(),
  duration_weeks: z.number().int().nullable(),
  valid_until: z.string(),
  terms: z.string(),
  /** Who signs, in order; empty on a budget. The builder countersigns after them. */
  signers: z.array(proposalSignerSchema),
  /** What changed since the version the client has, shown at the top of their page. */
  changes: z.array(proposalChangeSchema),
  /** The sections the document shows, in order, with their headings; custom ones carry their text. */
  sections: z
    .array(z.object({ key: z.string(), title: z.string(), body: z.string().default("") }))
    .default(() => PROPOSAL_SECTIONS.map((key) => ({ key, title: PROPOSAL_DOCUMENT_HEADINGS[key], body: "" }))),
});
export type ProposalDocument = z.infer<typeof proposalDocumentSchema>;

/** The proposal a sent document carries, or null for documents that predate proposals. */
export function estimateProposal(metadata: Record<string, unknown> | null | undefined): ProposalDocument | null {
  const parsed = proposalDocumentSchema.safeParse(metadata?.proposal);
  return parsed.success ? parsed.data : null;
}

/** A signature proposal is the construction agreement; a range is the budget it may follow. */
export function proposalKind(proposal: Pick<DealProposal, "price_mode">): "budget" | "agreement" {
  return proposal.price_mode === "range" ? "budget" : "agreement";
}

export function resolveProposalDocument(input: {
  proposal: DealProposal;
  defaults: ProposalDefaults;
  kind: "budget" | "agreement";
  lines: ProposalPriceLine[];
  names: ProposalNames;
  primarySigner: ProposalSigner | null;
  today: Date;
}): ProposalDocument {
  const { proposal, defaults, kind, lines } = input;
  const written = proposal.scope;
  const scope = defaultScopeParagraphs(lines).map((paragraph) => ({
    section: paragraph.section,
    text: written[paragraph.section] ?? paragraph.text,
    lines: lines
      .filter((line) => line.section === paragraph.section && !line.is_optional)
      .map((line) => line.description),
  }));
  const agreement = kind === "agreement";
  const sections = normalizeProposalLayout(proposal.layout ?? defaults.layout).filter(
    (entry) => entry.on && !(!agreement && isBuiltInSection(entry.key) && AGREEMENT_ONLY_SECTIONS.includes(entry.key)),
  );
  // A section the builder turned off says nothing: no payments to bill, no start to promise.
  const on = (key: ProposalSectionId) => sections.some((entry) => entry.key === key);
  return {
    kind,
    cover: on("cover") ? fillProposalTemplate(proposal.cover ?? defaults.cover, input.names) : "",
    scope: on("scope") ? scope : [],
    allowances: on("allowances")
      ? lines
          .filter((line) => line.is_allowance && !line.is_optional)
          .map((line) => ({ section: line.section, description: line.description, amount_cents: line.amount_cents }))
      : [],
    allowance_policy: on("allowances") ? proposal.allowance_policy ?? defaults.allowance_policy : "",
    inclusions: on("inclusions") ? proposal.inclusions ?? defaults.inclusions : [],
    exclusions: on("inclusions") ? proposal.exclusions ?? defaults.exclusions : [],
    payments: on("payments")
      ? (proposal.payments ?? defaults.payments).map(({ name, when, percent }) => ({ name, when, percent }))
      : [],
    start_window: on("schedule") ? proposal.start_window : "",
    duration_weeks: on("schedule") ? proposal.duration_weeks : null,
    valid_until: addDays(input.today, proposal.valid_days),
    terms: on("terms") ? fillProposalTemplate(proposal.terms ?? defaults.terms, input.names) : "",
    signers: agreement
      ? [input.primarySigner, ...proposal.co_signers].filter((signer): signer is ProposalSigner => Boolean(signer))
      : [],
    changes: [],
    sections: sections.map((entry) => ({
      key: entry.key,
      title: entry.title?.trim() || (isBuiltInSection(entry.key) ? PROPOSAL_DOCUMENT_HEADINGS[entry.key] : "Untitled section"),
      body: entry.body,
    })),
  };
}

/** The parts of a sent document a change summary compares. */
export type ProposalSnapshot = {
  kind: "budget" | "agreement";
  version: number;
  sent_at: string | null;
  total_cents: number;
  range: { low: number; high: number } | null;
  options: string[];
  exclusions: string[];
  payments: number;
  start_window: string;
  signers: string[];
};

/** What a sent document said, for comparing the next version against it. */
export function estimateProposalSnapshot(estimate: {
  version: number;
  sent_at: string | null;
  total_cents: number | null;
  metadata: Record<string, unknown> | null;
  items: Array<{ description: string; metadata: Record<string, unknown> | null }>;
}): ProposalSnapshot {
  const proposal = estimateProposal(estimate.metadata);
  const purpose = z
    .object({ precon: z.object({ purpose: z.string() }) })
    .safeParse(estimate.metadata);
  const range = z
    .object({ pricing_worksheet: z.object({ range: z.object({ low_cents: z.number(), high_cents: z.number() }) }) })
    .safeParse(estimate.metadata);
  const kind = purpose.success && purpose.data.precon.purpose === "budget" ? "budget" : "agreement";
  return {
    kind,
    version: estimate.version,
    sent_at: estimate.sent_at,
    total_cents: estimate.total_cents ?? 0,
    range:
      kind === "budget" && range.success
        ? { low: range.data.pricing_worksheet.range.low_cents, high: range.data.pricing_worksheet.range.high_cents }
        : null,
    options: estimate.items.filter((item) => item.metadata?.is_optional === true).map((item) => item.description),
    exclusions: proposal?.exclusions ?? [],
    payments: proposal?.payments.length ?? 0,
    start_window: proposal?.start_window ?? "",
    signers: proposal?.signers.map((signer) => signer.name) ?? [],
  };
}

/** What the client should know changed since the version they have. Nothing is listed when nothing was sent. */
export function proposalChanges(previous: ProposalSnapshot | null, next: ProposalSnapshot): ProposalChange[] {
  if (!previous) return [];
  const changes: ProposalChange[] = [];
  const range = (value: { low: number; high: number }) => `${money(value.low)}–${money(value.high)}`;
  if (next.kind === "agreement" && previous.kind === "budget")
    changes.push({
      label: "Price",
      text: `The price is firm at ${money(next.total_cents)}${
        previous.range && next.total_cents >= previous.range.low && next.total_cents <= previous.range.high
          ? `, inside the ${range(previous.range)} budget range`
          : previous.range
            ? `. The budget range was ${range(previous.range)}`
            : ""
      }.`,
    });
  else if (next.range && previous.range && (next.range.low !== previous.range.low || next.range.high !== previous.range.high))
    changes.push({ label: "Price", text: `The range is now ${range(next.range)}, from ${range(previous.range)}.` });
  else if (!next.range && next.total_cents !== previous.total_cents)
    changes.push({
      label: "Price",
      text: `The price is now ${money(next.total_cents)}, ${next.total_cents > previous.total_cents ? "up" : "down"} ${money(Math.abs(next.total_cents - previous.total_cents))}.`,
    });
  const added = next.options.filter((option) => !previous.options.includes(option));
  const removed = previous.options.filter((option) => !next.options.includes(option));
  if (added.length || removed.length)
    changes.push({
      label: "Options",
      text: [added.length && `Added ${listOf(added)}`, removed.length && `removed ${listOf(removed)}`]
        .filter(Boolean)
        .join("; ")
        .replace(/^r/, "R")
        .concat("."),
    });
  const excluded = next.exclusions.filter((item) => !previous.exclusions.includes(item));
  if (excluded.length) changes.push({ label: "Not included", text: `${listOf(excluded)}.`.replace(/^./, (c) => c.toUpperCase()) });
  const added_parts = [
    next.payments && !previous.payments && `a payment schedule (${next.payments} payments)`,
    next.start_window && next.start_window !== previous.start_window && `a start ${next.start_window}`,
    ...next.signers.filter((signer) => !previous.signers.includes(signer)).map((signer) => `${signer} as a signer`),
  ].filter((part): part is string => Boolean(part));
  if (added_parts.length) changes.push({ label: "New", text: `${listOf(added_parts).replace(/^./, (c) => c.toUpperCase())}.` });
  return changes;
}

function listOf(items: string[]) {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export type ProposalSectionTone = "auto" | "edited" | "needs" | "off";
export type ProposalSectionState = {
  key: ProposalSectionKey;
  /** The built-in section this is, or null for one the builder wrote. */
  builtIn: ProposalSectionId | null;
  name: string;
  tone: ProposalSectionTone;
  label: string;
  /** Turned off by the builder: kept in the list, left off the document. */
  hidden: boolean;
  /** Cannot be turned off. */
  locked: boolean;
  /** Belongs to a signed proposal only; a range leaves it out. */
  signatureOnly: boolean;
};

/** What each section says about itself, in document order: on its default, edited, waiting on the builder, or off. */
export function proposalSectionStates(input: {
  proposal: DealProposal;
  defaults: ProposalDefaults;
  document: ProposalDocument;
  priceLabel: string;
  optionCount: number;
  openSuggestions: number;
  unansweredComments: number;
  answered: number;
  clientName: string;
}): ProposalSectionState[] {
  const { proposal, document } = input;
  const agreement = document.kind === "agreement";
  const percent = paymentPercentTotal(proposal.payments ?? input.defaults.payments);
  const edited = (value: unknown, label = "Edited"): [ProposalSectionTone, string] | null =>
    value === null || value === undefined ? null : ["edited", label];
  const states: Record<ProposalSectionId, [ProposalSectionTone, string]> = {
    cover: edited(proposal.cover) ?? ["auto", "Filled in from your template"],
    scope: Object.keys(proposal.scope).length ? ["edited", "Edited"] : ["auto", "Written from the line notes on Pricing"],
    price: ["auto", `${input.priceLabel} · ${agreement ? "for signature" : "range, for approval"}`],
    options: ["auto", input.optionCount ? `${input.optionCount} for ${input.clientName} to choose` : "Shows when Pricing has options"],
    allowances: [
      "auto",
      document.allowances.length
        ? `${document.allowances.length} · ${money(document.allowances.reduce((sum, item) => sum + item.amount_cents, 0))}`
        : "None on Pricing",
    ],
    inclusions: input.openSuggestions
      ? ["needs", `${input.openSuggestions} exclusion${input.openSuggestions === 1 ? "" : "s"} from bids to review`]
      : [
          proposal.inclusions || proposal.exclusions ? "edited" : "auto",
          `${document.inclusions.length} included · ${document.exclusions.length} excluded`,
        ],
    payments:
      percent !== 100
        ? ["needs", `Adds to ${percent}%, needs 100%`]
        : [proposal.payments ? "edited" : "auto", `${document.payments.length} payments · becomes the draw schedule`],
    schedule: document.start_window
      ? ["edited", `Starts ${document.start_window}${document.duration_weeks ? `, about ${document.duration_weeks} weeks` : ""}`]
      : agreement
        ? ["needs", "Set a start window, or turn this section off"]
        : ["auto", "No start window yet"],
    terms: [proposal.terms === null ? "auto" : "edited", `Valid ${proposal.valid_days} days`],
    signatures: [
      "auto",
      document.signers.length ? `${firstNames(document.signers.map((signer) => signer.name))}, then you` : "Add the client's email",
    ],
    questions: input.unansweredComments
      ? ["needs", `${input.clientName} asked ${input.unansweredComments} question${input.unansweredComments === 1 ? "" : "s"}`]
      : ["auto", input.answered ? `${input.answered} answered` : "None yet"],
  };
  return normalizeProposalLayout(proposal.layout ?? input.defaults.layout).map((entry) => {
    const builtIn = isBuiltInSection(entry.key) ? entry.key : null;
    const signatureOnly = Boolean(builtIn && AGREEMENT_ONLY_SECTIONS.includes(builtIn));
    const base = { key: entry.key, builtIn, name: proposalSectionTitle(entry), hidden: !entry.on, locked: Boolean(builtIn && LOCKED_SECTIONS.includes(builtIn)), signatureOnly };
    if (!entry.on) return { ...base, tone: "off", label: "Off · not on the document" };
    if (signatureOnly && !agreement) return { ...base, tone: "off", label: "Only on a proposal for signature" };
    if (!builtIn)
      return entry.body.trim()
        ? { ...base, tone: "edited", label: entry.body.trim().split(/\s+/).slice(0, 8).join(" ") }
        : { ...base, tone: "needs", label: "Write this section, or remove it" };
    const [tone, label] = states[builtIn];
    return { ...base, tone, label };
  });
}

/** The sections still waiting on the builder before the document can go out. */
export function proposalNeeds(states: ProposalSectionState[]) {
  return states.filter((state) => state.tone === "needs");
}
