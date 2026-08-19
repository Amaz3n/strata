import type { PrequalificationStatus } from "@/lib/services/prequalification";

/**
 * One chip reports where a package sits in the lifecycle. Expiry is deliberately
 * not folded in here — a prequalification that lapses is moved to `expired` by
 * the nightly job, and a chip that quietly disagreed with the stored status is
 * how a vendor ends up looking approved on one screen and lapsed on another.
 */
export function prequalificationStatusMeta(status?: PrequalificationStatus | null): {
  label: string;
  className: string;
} {
  switch (status) {
    case "requested":
      return { label: "Requested", className: "border-warning/40 text-warning" };
    case "submitted":
    case "under_review":
      return { label: "In review", className: "border-primary/30 text-primary" };
    case "approved":
      return { label: "Approved", className: "border-success/40 text-success" };
    case "approved_with_limits":
      return { label: "Approved with limits", className: "border-success/40 text-success" };
    case "declined":
      return { label: "Declined", className: "border-destructive/40 text-destructive" };
    case "expired":
      return { label: "Expired", className: "border-destructive/40 text-destructive" };
    case "waived":
      return { label: "Waived", className: "border-border text-muted-foreground" };
    default:
      return { label: "Not requested", className: "border-border text-muted-foreground" };
  }
}

/**
 * A package is decidable for as long as it is open. Builders routinely approve
 * from paper before the vendor gets to the portal, so `requested` counts too.
 */
export function isPrequalificationReviewable(status?: PrequalificationStatus | null): boolean {
  return status === "requested" || status === "submitted" || status === "under_review";
}

/** Days until expiry, negative once lapsed. Null when nothing is on the clock. */
export function daysUntil(dateKey?: string | null): number | null {
  if (!dateKey) return null;
  const target = new Date(`${dateKey}T00:00:00Z`).getTime();
  if (Number.isNaN(target)) return null;
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((target - todayUtc) / 86_400_000);
}

export function expiryTone(days: number | null): string {
  if (days === null) return "text-muted-foreground";
  if (days < 0) return "text-destructive";
  if (days <= 30) return "text-warning";
  return "text-foreground";
}
