"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { getStartBuildingReviewAction, startBuildingAction } from "@/app/(app)/pipeline/[dealId]/actions";
import { unwrapAction } from "@/lib/action-result";
import type { getProspectConversionReview } from "@/lib/services/precon-project-start";
import { money } from "@/lib/precon/format";

type Review = Awaited<ReturnType<typeof getProspectConversionReview>>;

/** Signing is the handoff. This only shows what the job will open with. */
export function StartBuildingDialog({
  open,
  onOpenChange,
  dealId,
  dealName,
  agreementId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  dealId: string;
  dealName: string;
  agreementId: string;
}) {
  const router = useRouter();
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  useEffect(() => {
    if (!open) return;
    setReview(null);
    setError(null);
    void getStartBuildingReviewAction(dealId).then((result) => {
      if (result.success) setReview(result.data);
      else setError(result.error ?? "Unable to load the signed agreement");
    });
  }, [open, dealId]);
  const rows: Array<[string, string]> = review
    ? [
        ["Contract", `${money(review.totalCents)} · ${review.billingModel === "fixed_price" ? "fixed price" : review.billingModel.replaceAll("_", " ")}`],
        ["Job budget", "Drafted at cost from the signed lines"],
        ["Billing", review.paymentTerms || "From the signed terms"],
        ["Allowances to track", review.allowances.length ? review.allowances.join(", ") : "None"],
        ...(review.conditions.length
          ? ([["Still open", review.conditions.map((condition) => condition.title).join(", ")]] as Array<[string, string]>)
          : []),
      ]
    : [];
  return (
    <Dialog open={open} onOpenChange={(value) => !pending && onOpenChange(value)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Start building {dealName}</DialogTitle>
          <DialogDescription>The job opens with everything below. There is nothing to fill in.</DialogDescription>
        </DialogHeader>
        <div aria-live="polite">
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          {!review && !error && (
            <div className="space-y-2" aria-busy="true">
              {[0, 1, 2, 3].map((key) => (
                <Skeleton key={key} className="h-9 w-full" />
              ))}
            </div>
          )}
          {review && (
            <dl className="divide-y border text-sm">
              {rows.map(([label, value]) => (
                <div key={label} className="grid grid-cols-[9rem_minmax(0,1fr)] gap-3 px-3 py-2">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="whitespace-pre-line">{value}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" disabled={pending} onClick={() => onOpenChange(false)}>
            Not yet
          </Button>
          <Button
            disabled={pending || !review}
            onClick={() =>
              startTransition(async () => {
                try {
                  const result = unwrapAction(await startBuildingAction(dealId, review?.agreementId ?? agreementId));
                  toast.success(`${dealName} is now a job`, {
                    description: result.budgetCreated ? "Its draft budget is ready to review." : undefined,
                  });
                  router.push(`/projects/${result.projectId}`);
                } catch (cause) {
                  toast.error(cause instanceof Error ? cause.message : "Unable to start the job");
                }
              })
            }
          >
            {pending ? "Starting…" : "Start building"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
