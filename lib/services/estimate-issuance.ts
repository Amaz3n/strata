import "server-only";
import type { Estimate, EstimateItem } from "@/lib/types";
import { canIssueEstimate, estimateCommercialIssues, normalizeEstimateCommercial } from "@/lib/financials/estimate-commercial";
import { pricingBasisChanges, type PricingDrawingReference } from "@/lib/precon/pricing-basis";
import { pricingBriefVersion } from "@/lib/precon/brief-revision";
import { authorizeEstimateDocumentWrite } from "./estimate-document-authorization";
import { assertPreconDecisionGate } from "./precon-workspace";

/** One gate for email, copy-link, and explicit link replacement. Issued snapshots remain resendable. */
type IssuableEstimate = Pick<Estimate, "id" | "status" | "is_current_version" | "client_signed_at" | "executed_at" | "metadata" | "total_cents" | "prospect_id" | "sent_at"> & {
  items?: Pick<EstimateItem, "id" | "metadata">[];
};

export async function assertEstimateIssuable(estimate: IssuableEstimate, orgId?: string) {
  const context = await authorizeEstimateDocumentWrite(estimate.id, orgId);
  if (!canIssueEstimate(estimate)) throw new Error("Only the current unsigned document can be issued.");
  const commercial = normalizeEstimateCommercial(estimate.metadata);
  if (estimate.metadata?.precon) {
    const issues = estimateCommercialIssues(commercial, {
      totalCents: estimate.total_cents ?? 0,
      hasAllowances: estimate.items?.some((item) => item.metadata?.is_allowance),
    });
    if (issues.length) throw new Error(issues.join(" "));
  }
  if (estimate.prospect_id && commercial.purpose === "construction_agreement") {
    await assertPreconDecisionGate(estimate.prospect_id, "agreement");
  }
  if (!estimate.sent_at && estimate.prospect_id && commercial.purpose !== "preconstruction_agreement") {
    const { service, projectId } = context;
    const fileIds = (commercial.governing_documents ?? []).map((file) => file.id);
    // These are authoritative reference checks after project authorization, not a permission-filtered UI list.
    const [brief, files, drawings] = await Promise.all([
      service.from("precon_workspaces").select("brief,version").eq("org_id", context.orgId).eq("prospect_id", estimate.prospect_id).maybeSingle(),
      fileIds.length ? service.from("files").select("id,file_name,current_version_id").eq("org_id", context.orgId)
        .eq("project_id", projectId ?? "00000000-0000-0000-0000-000000000000").is("archived_at", null).in("id", fileIds) : Promise.resolve({ data: [], error: null }),
      projectId && commercial.drawing_revisions ? service.from("drawing_revisions").select("id,drawing_set_id,revision_label")
        .eq("org_id", context.orgId).eq("project_id", projectId).eq("status", "published").order("created_at", { ascending: false }).limit(1001) : Promise.resolve({ data: [], error: null }),
    ]);
    if (brief.error || files.error || drawings.error || (drawings.data?.length ?? 0) > 1000) throw new Error("Unable to verify current pricing references. Try again before issuing.");
    const latest = new Map<string, PricingDrawingReference>();
    for (const drawing of drawings.data ?? []) if (!latest.has(drawing.drawing_set_id)) latest.set(drawing.drawing_set_id, drawing);
    const quoteItems = (estimate.items ?? []).filter((item) => item.metadata?.source_bid_submission_id);
    if (quoteItems.length) {
      const { listProspectBidQuotes } = await import("./bids");
      const quotes = await listProspectBidQuotes(estimate.prospect_id);
      for (const item of quoteItems) {
        const basis = item.metadata?.bid_pricing_basis;
        const current = quotes.find((quote) => quote.submission_id === item.metadata?.source_bid_submission_id && quote.pricing_decision_id === basis?.pricing_decision_id);
        if (!current || (basis?.normalized_total_cents != null && current.normalized_total_cents !== basis.normalized_total_cents)) {
          throw new Error("A selected trade quote changed. Review pricing and revise this draft before issuing.");
        }
      }
    }
    const changes = pricingBasisChanges(commercial, {
      files: (files.data ?? []).map((file) => ({ id: file.id, name: file.file_name, version_id: file.current_version_id ?? null })),
      drawings: commercial.drawing_revisions ? [...latest.values()] : null,
    }, pricingBriefVersion(brief.data?.brief ?? {}, brief.data?.version ?? 0));
    if (changes.length) throw new Error(`Review the changed pricing basis before issuing. ${changes.join(" ")}`);
  }
  return context;
}
