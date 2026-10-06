import { z } from "zod";
import { calculateEstimateTotals } from "@/lib/financials/estimate-totals";
import type { EstimateInput } from "@/lib/validation/estimates";
import type { ProspectBidQuote } from "@/lib/services/bids";

const cents = z.number().int().min(-2_000_000_000).max(2_000_000_000);
export const pricingRowSchema = z.object({
  id: z.string().uuid(),
  description: z
    .string()
    .trim()
    .min(1, "Give each scope item a name.")
    .max(1000),
  section: z.string().trim().max(200).default(""),
  quantity: z.number().finite().min(0).max(1_000_000).default(1),
  unit: z.string().max(30).default("ls"),
  unit_cost_cents: cents.nullable().default(null),
  basis: z.enum(["estimate", "allowance", "quote"]).default("estimate"),
  source: z.string().max(500).default(""),
  notes: z.string().max(12000).default(""),
  cost_code_id: z.string().uuid().nullable().default(null),
  markup_pct: z.number().finite().min(0).max(1000).nullable().default(null),
  is_optional: z.boolean().default(false),
  option_group: z.string().max(80).default(""),
  // Preserve takeoff provenance and historical alternate treatment on imported lines.
  metadata: z.record(z.unknown()).default({}),
});
const quoteSchema = z.object({
  submission_id: z.string().uuid(),
  pricing_decision_id: z.string().uuid(),
  company_name: z.string().nullable(),
  normalized_total_cents: cents,
  total_cents: cents,
  submission_version: z.number().int(),
  scope_revision: z.number().int(),
  valid_until: z.string().nullable(),
  accepted_alternate_ids: z.array(z.string()),
  gaps: z.array(
    z.object({
      scope_item_id: z.string(),
      description: z.string(),
      amount_cents: cents,
      disposition: z.enum([
        "unresolved",
        "allowance",
        "self_perform",
        "other_package",
        "owner_exclusion",
      ]),
      owner: z.string(),
      note: z.string(),
    }),
  ),
});
export const pricingRequestSchema = z.object({
  package_id: z.string().uuid(),
  row_ids: z.array(z.string().uuid()).min(1).max(200),
  scope_signature: z.string().max(200_000),
  quote: quoteSchema.nullable().default(null),
});
export const pricingWorksheetSchema = z
  .object({
    rows: z.array(pricingRowSchema).max(500),
    requests: z.array(pricingRequestSchema).max(200).default([]),
    markup_percent: z.number().finite().min(0).max(1000).default(0),
    contingency_percent: z.number().finite().min(0).max(100).default(0),
    tax_rate: z.number().finite().min(0).max(100).default(0),
    source_estimate_id: z.string().uuid().nullable().default(null),
  })
  .superRefine((value, ctx) => {
    const ids = new Set(value.rows.map((row) => row.id));
    if (ids.size !== value.rows.length)
      ctx.addIssue({
        code: "custom",
        message: "Scope items must have unique identifiers.",
      });
    const linked = new Set<string>();
    const packages = new Set<string>();
    for (const request of value.requests) {
      if (packages.has(request.package_id))
        ctx.addIssue({
          code: "custom",
          message: "Link each quote request only once.",
        });
      packages.add(request.package_id);
      for (const id of request.row_ids) {
        if (!ids.has(id) || linked.has(id))
          ctx.addIssue({
            code: "custom",
            message:
              "Each scope item can belong to one quote request. Unlink its current request first.",
          });
        linked.add(id);
      }
      const rows = value.rows.filter((row) => request.row_ids.includes(row.id));
      if (
        new Set(rows.map((row) => row.is_optional)).size > 1 ||
        rows.some((row) => row.option_group)
      )
        ctx.addIssue({
          code: "custom",
          message: "Request base scope and optional alternatives separately.",
        });
      if (
        request.quote &&
        new Set(rows.map((row) => row.markup_pct ?? value.markup_percent))
          .size > 1
      )
        ctx.addIssue({
          code: "custom",
          message:
            "Use the same markup for scope covered by one lump-sum quote.",
        });
    }
  });
export type PricingRow = z.infer<typeof pricingRowSchema>;
export type PricingRequest = z.infer<typeof pricingRequestSchema>;
export type PricingWorksheet = z.infer<typeof pricingWorksheetSchema>;
export const EMPTY_PRICING_WORKSHEET: PricingWorksheet = {
  rows: [],
  requests: [],
  markup_percent: 0,
  contingency_percent: 0,
  tax_rate: 0,
  source_estimate_id: null,
};

export function scopeSignature(rows: PricingRow[]) {
  return JSON.stringify(
    rows
      .map(({ id, description, quantity, unit, notes }) => ({
        id,
        description,
        quantity,
        unit,
        notes,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  );
}

export function requestScopeChanged(
  request: PricingRequest,
  rows: PricingRow[],
) {
  return (
    scopeSignature(rows.filter((row) => request.row_ids.includes(row.id))) !==
    request.scope_signature
  );
}

export function rowPricing(row: PricingRow, worksheet: PricingWorksheet) {
  const request = worksheet.requests.find((item) =>
    item.row_ids.includes(row.id),
  );
  const covered = !!request?.quote && request.row_ids[0] !== row.id;
  const cost = request?.quote
    ? covered
      ? 0
      : request.quote.normalized_total_cents
    : row.unit_cost_cents === null
      ? null
      : Math.round(row.quantity * row.unit_cost_cents);
  return {
    request,
    covered,
    cost,
    source: request?.quote?.company_name ?? row.source,
    basis: request?.quote ? "quote" : row.basis,
  };
}

/** One vendor lump sum is carried once, with all covered scope in its description. */
export function worksheetEstimateLines(
  worksheet: PricingWorksheet,
): EstimateInput["lines"] {
  const lines: EstimateInput["lines"] = [];
  let section = "";
  for (const row of worksheet.rows) {
    const { request, covered } = rowPricing(row, worksheet);
    if (covered) continue;
    if (row.section && row.section !== section) {
      lines.push({
        item_type: "group",
        description: row.section,
        quantity: 1,
        unit_cost_cents: 0,
      });
    }
    section = row.section;
    const quote = request?.quote;
    const coveredRows = quote
      ? request.row_ids.map(
          (id) => worksheet.rows.find((item) => item.id === id)!,
        )
      : [row];
    lines.push({
      item_type: "line",
      description: coveredRows.map((item) => item.description).join(" · "),
      quantity: quote ? 1 : row.quantity,
      unit: quote ? "ls" : row.unit,
      unit_cost_cents:
        quote?.normalized_total_cents ?? row.unit_cost_cents ?? 0,
      markup_pct: row.markup_pct ?? worksheet.markup_percent,
      cost_code_id: row.cost_code_id ?? undefined,
      is_optional: row.is_optional,
      is_allowance: !quote && row.basis === "allowance",
      option_group: row.option_group || undefined,
      notes: coveredRows
        .map((item) => item.notes)
        .filter(Boolean)
        .join("\n"),
      source_bid_submission_id:
        quote?.submission_id ??
        (typeof row.metadata.source_bid_submission_id === "string"
          ? row.metadata.source_bid_submission_id
          : undefined),
      metadata: {
        ...row.metadata,
        worksheet_row_ids: coveredRows.map((item) => item.id),
        pricing_source: quote?.company_name ?? row.source,
        ...(quote
          ? {
              bid_pricing_basis: {
                pricing_decision_id: quote.pricing_decision_id,
                submission_version: quote.submission_version,
                vendor_total_cents: quote.total_cents,
                normalized_total_cents: quote.normalized_total_cents,
                scope_revision: quote.scope_revision,
                accepted_alternate_ids: quote.accepted_alternate_ids,
                gaps: quote.gaps,
              },
            }
          : {}),
      },
    });
  }
  return lines;
}

export function worksheetTotals(worksheet: PricingWorksheet) {
  const lines = worksheetEstimateLines(worksheet);
  const totals = calculateEstimateTotals(
    lines,
    worksheet.tax_rate,
    worksheet.contingency_percent,
  );
  const cost = worksheet.rows.reduce(
    (sum, row) =>
      sum + (row.is_optional ? 0 : (rowPricing(row, worksheet).cost ?? 0)),
    0,
  );
  return {
    ...totals,
    cost,
    markup: totals.subtotal - cost,
    unpriced: worksheet.rows.filter(
      (row) => rowPricing(row, worksheet).cost === null,
    ).length,
  };
}

export function worksheetQuoteIssues(
  worksheet: PricingWorksheet,
  quotes: ProspectBidQuote[],
) {
  const importedIssues = worksheet.rows.flatMap((row) => {
    const submissionId = row.metadata.source_bid_submission_id;
    if (
      !submissionId ||
      worksheet.requests.some(
        (request) => request.row_ids.includes(row.id) && request.quote,
      )
    )
      return [];
    const decisionId = (
      row.metadata.bid_pricing_basis as
        | { pricing_decision_id?: string }
        | undefined
    )?.pricing_decision_id;
    return quotes.some(
      (quote) =>
        quote.submission_id === submissionId &&
        quote.pricing_decision_id === decisionId,
    )
      ? []
      : [
          `${row.description}: the imported quote is no longer current. Request a new quote or enter your own cost.`,
        ];
  });
  return [
    ...importedIssues,
    ...worksheet.requests.flatMap((request) => {
      if (!request.quote) return [];
      const title =
        worksheet.rows.find((row) => row.id === request.row_ids[0])
          ?.description ?? "Scope";
      if (requestScopeChanged(request, worksheet.rows))
        return [
          `${title}: the scope changed after requesting quotes. Review or remove the selected quote.`,
        ];
      if (
        !quotes.some(
          (quote) =>
            quote.bid_package_id === request.package_id &&
            quote.pricing_decision_id === request.quote!.pricing_decision_id &&
            quote.normalized_total_cents ===
              request.quote!.normalized_total_cents,
        )
      )
        return [
          `${title}: the selected quote changed or is no longer current. Review its pricing.`,
        ];
      return [];
    }),
  ];
}
