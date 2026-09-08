"use client";

import { useEffect, useMemo, useState, useTransition, type CSSProperties } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import { AlertTriangle, ChevronRight } from "@/components/icons";
import { StatusChip, formatMoneyFromCents } from "@/components/companies/company-detail-ui";
import {
  ComplianceReviewDialog,
  factsToInput,
  type ReviewValues,
} from "@/components/companies/account/compliance-dialogs";
import { reviewComplianceDocumentAction } from "@/app/(app)/directory/[id]/compliance/actions";
import { useToast } from "@/hooks/use-toast";
import { unwrapAction } from "@/lib/action-result";
import type { ComplianceStatusSummary } from "@/lib/types";
import type {
  ComplianceReviewQueue,
  PendingComplianceReview,
} from "@/lib/services/compliance-documents";

type ComplianceWatchItem = {
  companyId: string;
  companyName: string;
  missingCount: number;
  expiredCount: number;
  deficiencyCount: number;
  pendingCount: number;
  expiringSoonCount: number;
  score: number;
};

function scoreComplianceIssue(status: ComplianceStatusSummary): number {
  return (
    status.missing.length * 100 +
    status.expired.length * 80 +
    status.deficiencies.length * 70 +
    status.pending_review.length * 30 +
    status.expiring_soon.length * 10
  );
}

function toWatchItem(
  company: { id: string; name: string },
  status: ComplianceStatusSummary,
): ComplianceWatchItem {
  return {
    companyId: company.id,
    companyName: company.name,
    missingCount: status.missing.length,
    expiredCount: status.expired.length,
    deficiencyCount: status.deficiencies.length,
    pendingCount: status.pending_review.length,
    expiringSoonCount: status.expiring_soon.length,
    score: scoreComplianceIssue(status),
  };
}

/**
 * The directory's standing compliance warning, and the list behind it.
 *
 * Deep-linkable as `?compliance=pending`, which is where Control Tower sends
 * someone who clicked the review count — a number on a dashboard has to land on
 * the work it counted.
 */
export function ComplianceAlert({
  reviewQueue,
  companies,
  complianceStatusByCompanyId,
  watchTruncated = false,
  watchTotal = 0,
  statusUnavailable = false,
  vendorNoun = "vendor",
  vendorNounPlural = "vendors",
}: {
  /**
   * Every compliance document waiting on a decision, org-wide, ranked by the
   * money its review would release. This is the work itself; the watch list
   * below it is the vendors who owe something. The service that ranks these has
   * existed and been tested since the compliance hardening pass and had no
   * caller at all — reviewing meant opening vendors one at a time and guessing
   * which one was costing the most.
   */
  reviewQueue: ComplianceReviewQueue | null;
  /** Vendor-role companies on the watch list. Narrowed to what the banner
   *  shows, so the directory page no longer loads full company records — and
   *  the vendor test is now the party's role, not a guess from company_type. */
  companies: Array<{ id: string; name: string }>;
  complianceStatusByCompanyId: Record<string, ComplianceStatusSummary>;
  /** True when more vendors exist than the watch query returned. A truncated
   *  banner must never read as an all-clear. */
  watchTruncated?: boolean;
  watchTotal?: number;
  /** The status read failed. An empty result then means "unknown", not "clear",
   *  and this banner is what stops the page reporting a false all-clear. */
  statusUnavailable?: boolean;
  /** Tier vocabulary: a commercial GC chases trade partners, not "vendors". */
  vendorNoun?: string;
  vendorNounPlural?: string;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  // Deciding happens here rather than on the vendor's tab: the queue exists so
  // somebody can work through a stack of certificates, and sending them to a
  // different page per document is what made that a stack in the first place.
  const [reviewTarget, setReviewTarget] = useState<PendingComplianceReview | null>(null);

  const submitReview = (values: ReviewValues) =>
    startTransition(async () => {
      if (!reviewTarget) return;
      try {
        unwrapAction(
          await reviewComplianceDocumentAction(reviewTarget.document.id, {
            decision: values.decision,
            notes: values.notes || undefined,
            rejection_reason: values.rejection_reason || undefined,
            corrections: factsToInput(values.facts),
          }),
        );
        toast({
          title: values.decision === "approved" ? "Document approved" : "Sent back to the vendor",
          description:
            values.decision === "approved"
              ? `${reviewTarget.companyName} can be paid for anything this was holding.`
              : `${reviewTarget.companyName} has been emailed the reason.`,
        });
        setReviewTarget(null);
        router.refresh();
      } catch (error) {
        toast({ title: "Something went wrong", description: (error as Error).message });
      }
    });

  const deepLinked = searchParams.get("compliance") === "pending";
  useEffect(() => {
    if (deepLinked) setOpen(true);
  }, [deepLinked]);

  const watchItems = useMemo(
    () =>
      companies
        .map((company) => {
          const status = complianceStatusByCompanyId[company.id];
          if (!status) return null;
          const hasAlert =
            status.missing.length > 0 ||
            status.expired.length > 0 ||
            status.deficiencies.length > 0 ||
            status.pending_review.length > 0 ||
            status.expiring_soon.length > 0;
          if (!hasAlert) return null;
          return toWatchItem(company, status);
        })
        .filter((item): item is ComplianceWatchItem => Boolean(item))
        .sort((a, b) => b.score - a.score),
    [companies, complianceStatusByCompanyId],
  );

  // Unknown is not the same as compliant. When the status read failed, say so
  // instead of rendering nothing — this banner's silence is what a reader takes
  // as an all-clear, and an all-clear is what releases payment.
  if (statusUnavailable) {
    return (
      <div className="shrink-0 border-b border-warning/30 bg-warning/10 px-4 py-2.5">
        <div className="flex items-center gap-3 text-sm">
          <AlertTriangle className="size-4 shrink-0 text-warning" />
          <span className="min-w-0 flex-1">
            <span className="font-medium">Compliance status is unavailable.</span>
            <span className="text-muted-foreground">
              {" "}
              Reload to try again — treat everyone as unverified until it loads.
            </span>
          </span>
        </div>
      </div>
    );
  }

  if (watchItems.length === 0 && (reviewQueue?.totalPending ?? 0) === 0) return null;

  // Urgent = anything missing, expired, or a live deficiency (needs chasing now).
  const urgentCount = watchItems.filter(
    (item) =>
      item.missingCount > 0 ||
      item.expiredCount > 0 ||
      item.deficiencyCount > 0,
  ).length;
  // The queue is the authority on review work; it counts documents org-wide,
  // not only the vendors this page happened to load.
  const awaitingReview = reviewQueue?.totalPending ?? 0;

  const watchNoun = watchItems.length === 1 ? vendorNoun : vendorNounPlural;

  const openCompany = (companyId: string) => {
    setOpen(false);
    router.push(`/directory/${companyId}/compliance`);
  };

  const closeSheet = (next: boolean) => {
    setOpen(next);
    // Clear only the deep-link marker. Replacing the whole URL threw away the
    // search, filters and page the reader had set.
    if (!next && deepLinked) {
      const params = new URLSearchParams(searchParams.toString());
      params.delete("compliance");
      const query = params.toString();
      router.replace(query ? `/directory?${query}` : "/directory");
    }
  };

  return (
    <>
      <div className="shrink-0 border-b border-warning/30 bg-warning/10 px-4 py-2.5">
        <div className="flex items-center gap-3">
          <AlertTriangle className="size-4 shrink-0 text-warning" />
          <div className="min-w-0 flex-1 text-sm">
            <span className="font-medium">
              {watchItems.length} {watchNoun} need
              {watchItems.length === 1 ? "s" : ""} compliance attention
            </span>
            {urgentCount > 0 ? (
              <span className="text-muted-foreground"> · {urgentCount} urgent</span>
            ) : null}
            {awaitingReview > 0 ? (
              <span className="text-muted-foreground">
                {" "}
                · {awaitingReview} awaiting your review
              </span>
            ) : null}
            {watchTruncated ? (
              <span className="text-muted-foreground">
                {" "}
                · checked the first {companies.length} of {watchTotal} {vendorNounPlural}
              </span>
            ) : null}
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 shrink-0"
            onClick={() => setOpen(true)}
          >
            Review
          </Button>
        </div>
      </div>

      <Sheet open={open} onOpenChange={closeSheet}>
        <SheetContent
          side="right"
          mobileFullscreen
          className="flex flex-col sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] sm:max-w-lg fast-sheet-animation"
          style={
            {
              animationDuration: "150ms",
              transitionDuration: "150ms",
            } as CSSProperties
          }
        >
          <div className="border-b bg-muted/40 px-4 py-3">
            <SheetTitle className="text-sm font-semibold">Compliance attention</SheetTitle>
            <SheetDescription className="mt-0.5 text-xs">
              Documents waiting on you first, ranked by the money they release.
            </SheetDescription>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {reviewQueue && reviewQueue.items.length > 0 ? (
              <section>
                <div className="microlabel flex items-center justify-between border-b bg-muted/20 px-4 py-1.5">
                  <span>Waiting on your review</span>
                  {reviewQueue.heldCents > 0 ? (
                    <span className="tabular-nums normal-case tracking-normal">
                      {formatMoneyFromCents(reviewQueue.heldCents)}
                      {reviewQueue.heldCentsTruncated ? "+" : ""} held
                    </span>
                  ) : null}
                </div>
                <div className="divide-y">
                  {reviewQueue.items.map((item) => (
                    <div
                      key={item.document.id}
                      className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/40"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">{item.companyName}</div>
                        <div className="mt-0.5 truncate text-xs text-muted-foreground">
                          {item.document.document_type?.name ?? "Document"}
                          {item.submittedViaPortal ? " · sent by the vendor" : ""}
                        </div>
                        {item.blocksPayment ? (
                          <div className="mt-1 text-xs tabular-nums text-destructive">
                            {formatMoneyFromCents(item.heldCents)} held
                          </div>
                        ) : null}
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="h-7 shrink-0"
                        disabled={pending}
                        onClick={() => setReviewTarget(item)}
                      >
                        Review
                      </Button>
                    </div>
                  ))}
                </div>
                {reviewQueue.truncated ? (
                  <p className="border-b px-4 py-2 text-xs text-muted-foreground">
                    Showing {reviewQueue.items.length} of {reviewQueue.totalPending}. Decide these
                    and the rest will appear.
                  </p>
                ) : null}
              </section>
            ) : null}

            {watchItems.length > 0 ? (
              <div className="microlabel border-b bg-muted/20 px-4 py-1.5">
                Vendors with something outstanding
              </div>
            ) : null}
            <div className="divide-y">
            {watchItems.map((item) => (
              <button
                key={item.companyId}
                type="button"
                onClick={() => openCompany(item.companyId)}
                className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/40"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{item.companyName}</div>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {item.missingCount > 0 ? (
                      <StatusChip
                        label={`${item.missingCount} missing`}
                        className="border-destructive/40 text-destructive"
                      />
                    ) : null}
                    {item.expiredCount > 0 ? (
                      <StatusChip
                        label={`${item.expiredCount} expired`}
                        className="border-destructive/40 text-destructive"
                      />
                    ) : null}
                    {item.deficiencyCount > 0 ? (
                      <StatusChip
                        label={`${item.deficiencyCount} short`}
                        className="border-warning/40 text-warning"
                      />
                    ) : null}
                    {item.pendingCount > 0 ? (
                      <StatusChip
                        label={`${item.pendingCount} to review`}
                        className="border-primary/30 text-primary"
                      />
                    ) : null}
                    {item.expiringSoonCount > 0 ? (
                      <StatusChip
                        label={`${item.expiringSoonCount} expiring`}
                        className="border-warning/40 text-warning"
                      />
                    ) : null}
                  </div>
                </div>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
              </button>
            ))}
            </div>
          </div>

          <div className="shrink-0 border-t bg-muted/40 px-4 py-2.5 text-xs text-muted-foreground">
            Opening a vendor shows what is outstanding and lets you chase, review, or waive it.
          </div>
        </SheetContent>
      </Sheet>

      <ComplianceReviewDialog
        open={reviewTarget !== null}
        onOpenChange={(next) => !next && setReviewTarget(null)}
        document={reviewTarget?.document ?? null}
        documentType={reviewTarget?.document.document_type}
        onSubmit={submitReview}
        busy={pending}
      />
    </>
  );
}
