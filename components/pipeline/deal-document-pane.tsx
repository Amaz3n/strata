"use client";

import { ArrowUpRight } from "lucide-react";
import { EstimateLivePreview, type EstimatePreviewBranding } from "@/components/estimates/estimate-live-preview";
import { worksheetEstimateLines, type PricingWorksheet } from "@/lib/precon/pricing-worksheet";
import type { DealDocument } from "@/lib/precon/deal-move";
import type { ProposalDocument, ProposalSectionKey } from "@/lib/precon/proposal-documents";
import type { EstimateInput } from "@/lib/validation/estimates";
import type { DealQuestion } from "./deal-questions";
import type { DealClient } from "./deal-client-sheet";
import { cn } from "@/lib/utils";

const shortDate = (value: string) =>
  new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/**
 * What the client sees, rendered from the work as it changes: a fixed price to
 * sign or an estimated range to approve, as the builder chose on the proposal.
 * The pane keeps its height and the document scrolls inside it.
 */
export function DealDocumentPane({
  className,
  dealName,
  client,
  worksheet,
  signable,
  range,
  documents,
  questions,
  branding,
  proposal,
  pricingDisplay,
  selectedSection,
  onSelectSection,
  sectionFlags,
}: {
  className?: string;
  dealName: string;
  client: DealClient;
  worksheet: PricingWorksheet | null;
  signable: boolean;
  range: { low: number; high: number } | null;
  documents: { proposal: DealDocument | null; agreement: DealDocument | null };
  questions: DealQuestion[];
  branding?: EstimatePreviewBranding;
  /** The sections written around the price; the document the client gets. */
  proposal: ProposalDocument;
  pricingDisplay: "sections" | "itemized" | "lump_sum";
  selectedSection?: ProposalSectionKey | null;
  onSelectSection?: (id: ProposalSectionKey) => void;
  sectionFlags?: Record<ProposalSectionKey, string>;
}) {
  const who = client.name.split(" ")[0] || "The client";
  const current =
    documents.agreement && documents.agreement.status !== "draft" ? documents.agreement : documents.proposal;
  const issued = current && current.status !== "draft" ? current : null;
  const showing: "budget" | "construction_agreement" =
    issued && !issued.changed_since ? issued.purpose : signable ? "construction_agreement" : "budget";

  const status = (() => {
    if (!issued) return "Not sent. Updates as you price.";
    if (["executed", "converted_to_project"].includes(issued.status)) return "Signed by both sides";
    if (issued.status === "client_signed") return `${who} signed. Waiting on your signature.`;
    if (issued.changed_since)
      return `${who} has v${issued.version}. Your changes go out as v${issued.version + 1}.`;
    return `Proposal v${issued.version} · sent ${issued.sent_at ? shortDate(issued.sent_at) : ""}${issued.viewed_at ? " · opened" : " · not opened"}`;
  })();

  const input: EstimateInput | null =
    worksheet && worksheet.rows.length
      ? {
          title: dealName,
          recipient_name: client.name || null,
          recipient_email: client.email || null,
          pricing_display: pricingDisplay,
          valid_until: proposal.valid_until,
          tax_rate: worksheet.tax_rate,
          markup_percent: worksheet.markup_percent,
          contingency_percent: worksheet.contingency_percent,
          precon: {
            purpose: showing,
            maturity: showing === "budget" ? "conceptual" : "construction_ready",
            pricing_basis: "",
            billing_model: "fixed_price",
            fixed_fee_cents: 0,
            gmp_cents: 0,
            retainage_percent: 0,
            payment_terms: "",
            allowance_policy: "",
            contingency_treatment: "included_in_price",
          },
          lines: worksheetEstimateLines(worksheet).map((line) => ({
            ...line,
            metadata: { ...line.metadata, notes: line.notes },
          })),
        }
      : null;

  return (
    <aside
      aria-label={`What ${who} sees`}
      className={cn("flex min-h-0 flex-col border-l bg-muted/40", className)}
    >
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-5 py-2.5">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">What {who} sees</p>
        <p className="text-xs text-muted-foreground">{status}</p>
        {current && (
          <a
            href={`/estimates/${current.id}/export`}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            PDF
            <ArrowUpRight className="size-3" />
          </a>
        )}
      </div>
      {input ? (
        <EstimateLivePreview
          className="min-h-0 lg:w-full lg:max-w-none lg:flex-1 lg:border-l-0"
          input={input}
          branding={branding}
          range={showing === "budget" && range ? { lowCents: range.low, highCents: range.high } : null}
          questions={questions.map((item) => ({
            id: item.id,
            question: item.title,
            answer: item.status === "open" ? null : item.resolution,
          }))}
          proposal={proposal}
          selectedSection={selectedSection}
          onSelectSection={onSelectSection}
          sectionFlags={sectionFlags}
        />
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center p-8">
          <div className="max-w-xs text-center">
            <p className="text-sm font-medium">{dealName}</p>
            <p className="mt-1.5 text-sm text-muted-foreground">
              The document builds itself as you price. Nothing goes to {who === "The client" ? "the client" : who} until you send it.
            </p>
          </div>
        </div>
      )}
    </aside>
  );
}
