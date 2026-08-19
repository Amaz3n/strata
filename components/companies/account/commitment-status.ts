import type { CommitmentSummary } from "@/lib/services/commitments";

/**
 * Lifecycle and billing progress are two different facts about a commitment,
 * and collapsing them into one chip is how a contract with unbilled change
 * order value ends up reading "Paid". The status chip reports the lifecycle;
 * `commitmentFlags` reports what the money is doing.
 */
export function commitmentLifecycleMeta(status?: string): {
  label: string;
  className: string;
} {
  switch ((status ?? "").toLowerCase()) {
    case "draft":
      return { label: "Draft", className: "border-border text-muted-foreground" };
    case "approved":
      return { label: "Approved", className: "border-primary/30 text-primary" };
    case "complete":
      return { label: "Complete", className: "border-success/40 text-success" };
    case "canceled":
      return { label: "Canceled", className: "border-border text-muted-foreground" };
    default:
      return { label: status ?? "—", className: "border-border text-muted-foreground" };
  }
}

export type CommitmentFlagTone = "destructive" | "warning" | "success" | "muted";

export interface CommitmentFlag {
  label: string;
  tone: CommitmentFlagTone;
}

const FLAG_TONE_CLASS: Record<CommitmentFlagTone, string> = {
  destructive: "text-destructive",
  warning: "text-warning",
  success: "text-success",
  muted: "text-muted-foreground",
};

export function commitmentFlagClass(tone: CommitmentFlagTone) {
  return FLAG_TONE_CLASS[tone];
}

/** A canceled commitment has no position worth reporting on. */
export function commitmentFlags(commitment: CommitmentSummary): CommitmentFlag[] {
  if (String(commitment.status).toLowerCase() === "canceled") return [];

  const flags: CommitmentFlag[] = [];
  const revised = commitment.revised_total_cents ?? 0;
  const billed = commitment.billed_cents ?? 0;
  const remaining = commitment.remaining_cents ?? 0;

  if (remaining < 0) {
    flags.push({ label: "Over-billed", tone: "destructive" });
  } else if (revised > 0 && remaining === 0) {
    flags.push({ label: "Fully billed", tone: "success" });
  }

  if (
    commitment.commitment_type === "subcontract" &&
    String(commitment.status).toLowerCase() === "approved" &&
    !commitment.executed_at
  ) {
    flags.push({ label: "Not executed", tone: "warning" });
  }

  if ((commitment.pending_billed_cents ?? 0) > 0) {
    flags.push({ label: "Bills awaiting approval", tone: "warning" });
  }

  if ((commitment.pending_change_orders_cents ?? 0) !== 0) {
    flags.push({ label: "Pending change orders", tone: "warning" });
  }

  if (billed === 0 && revised > 0 && String(commitment.status).toLowerCase() === "approved") {
    flags.push({ label: "Nothing billed yet", tone: "muted" });
  }

  return flags;
}

export const COMMITMENT_TYPE_LABEL: Record<string, string> = {
  subcontract: "Subcontract",
  purchase_order: "Purchase order",
};

export function commitmentTypeLabel(type?: string) {
  return COMMITMENT_TYPE_LABEL[type ?? ""] ?? "Commitment";
}

/** Short form for a dense register column. */
export function commitmentTypeShortLabel(type?: string) {
  return type === "purchase_order" ? "PO" : "Sub";
}
