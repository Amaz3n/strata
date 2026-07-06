import type { CommitmentSummary } from "@/lib/services/commitments";

/**
 * A commitment reads as "Open" until its balance is fully paid, regardless of
 * the stored lifecycle status. Paid / canceled commitments are "previous".
 */
export function commitmentStatusMeta(commitment: CommitmentSummary | null): {
  label: string;
  className: string;
  isPrevious: boolean;
} {
  const status = (commitment?.status ?? "").toLowerCase();
  const total = commitment?.total_cents ?? 0;
  const paid = commitment?.paid_cents ?? 0;

  if (status === "canceled") {
    return {
      label: "Canceled",
      className: "border-border text-muted-foreground",
      isPrevious: true,
    };
  }
  if (status === "draft") {
    return {
      label: "Draft",
      className: "border-border text-muted-foreground",
      isPrevious: false,
    };
  }
  if (total > 0 && paid >= total) {
    return {
      label: "Paid",
      className: "border-success/40 text-success",
      isPrevious: true,
    };
  }
  return {
    label: "Open",
    className: "border-primary/30 text-primary",
    isPrevious: false,
  };
}
