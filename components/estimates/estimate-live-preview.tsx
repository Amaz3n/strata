"use client";

import { proposalDocumentLabel } from "@/lib/precon/proposal-documents";
import type { EstimateInput } from "@/lib/validation/estimates";
import {
  QuoteDocumentView,
  type QuoteViewLine,
} from "@/components/portal/quote-document-view";
import {
  DocumentPreviewPane,
  ScaledDocument,
} from "@/components/document-editor/document-editor-layout";
import {
  normalizeEstimateCommercial,
  normalizeCommercialEstimateLines,
  calculateCommercialEstimateTotals,
  estimateDocumentTerms,
  estimateBuilderFeeCents,
} from "@/lib/financials/estimate-commercial";
import { estimateLineAmountCents } from "@/lib/financials/estimate-totals";
import { cn } from "@/lib/utils";

export type EstimatePreviewBranding = {
  name?: string | null;
  logoUrl?: string | null;
  address?: string | null;
  estimateAccentColor?: string | null;
  estimateFont?: string | null;
  estimateTermsTemplate?: string | null;
};

export function EstimateLivePreview({
  input,
  branding,
  range,
  questions,
  className,
}: {
  input: EstimateInput;
  branding?: EstimatePreviewBranding;
  /** A budget shows its range in place of a total. */
  range?: { lowCents: number; highCents: number } | null;
  questions?: Array<{ id: string; question: string; answer?: string | null }>;
  className?: string;
}) {
  const commercial = normalizeEstimateCommercial({ precon: input.precon });
  const normalized = normalizeCommercialEstimateLines(input.lines, commercial);
  const totals = calculateCommercialEstimateTotals(
    normalized,
    input.tax_rate ?? 0,
    input.contingency_percent ?? 0,
    commercial,
  );
  const metadata = { precon: commercial, terms: input.terms };
  const lines: QuoteViewLine[] = normalized.map((line, index) => ({
    id: String(index),
    kind: line.item_type === "group" ? "section" : "item",
    description: line.description,
    quantity: line.quantity,
    unit: line.unit,
    unit_cost_cents: Math.round(
      line.unit_cost_cents * (1 + (line.markup_pct ?? 0) / 100),
    ),
    amount_cents: estimateLineAmountCents(line),
    is_optional: line.is_optional,
    option_group: line.option_group,
    notes: line.notes,
    badges: line.is_allowance ? ["Allowance"] : undefined,
  }));
  const fee = estimateBuilderFeeCents(metadata);
  if (fee)
    lines.push({
      id: "builder-fee",
      kind: "item",
      description: "Fixed builder fee",
      quantity: 1,
      unit_cost_cents: fee,
      amount_cents: fee,
    });
  return (
    <DocumentPreviewPane className={cn("flex", className)} aria-label="Live proposal preview">
      <ScaledDocument>
        <QuoteDocumentView
          printLayout
          orgName={branding?.name}
          orgLogoUrl={branding?.logoUrl}
          orgAddress={branding?.address}
          accentColor={branding?.estimateAccentColor}
          fontFamily={branding?.estimateFont}
          documentLabel={proposalDocumentLabel(commercial)}
          title={input.title}
          recipientName={input.recipient_name}
          recipientEmail={input.recipient_email}
          intro={input.intro}
          summary={input.summary}
          validUntil={input.valid_until}
          pricingDisplay={input.pricing_display}
          inclusions={input.inclusions}
          exclusions={input.exclusions}
          terms={estimateDocumentTerms(
            metadata,
            branding?.estimateTermsTemplate,
          )}
          lines={lines}
          totalCents={totals.total}
          totalRange={range}
          questions={questions}
          taxCents={totals.tax}
          contingencyCents={totals.contingency}
          contingencyPercent={input.contingency_percent}
        />
      </ScaledDocument>
    </DocumentPreviewPane>
  );
}
