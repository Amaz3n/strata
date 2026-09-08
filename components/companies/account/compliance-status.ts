import type {
  ComplianceDocumentKind,
  ComplianceRequirementStatus,
} from "@/lib/types";

/**
 * How a requirement row reports itself.
 *
 * The rule for the whole tab: a satisfied requirement says its name and nothing
 * else. Every other word on a row is there because something needs doing, so a
 * builder can run down the list and stop only where the colour changes. What the
 * certificate says — carrier, policy number, limits — is on the certificate; it
 * is not what anyone scanning this list is deciding about.
 */
export interface ComplianceRowSignal {
  /** The state mark at the head of the row. */
  dotClassName: string;
  /** The exception, or null when the requirement is simply met. */
  note: string | null;
  noteClassName: string;
  /** What a screen reader hears in place of the colour. */
  srLabel: string;
}

function formatDay(value?: string | null): string {
  if (!value) return "";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** "in 9 days" / "today" / "12 days ago", for a date the reader must act on. */
function relativeDays(days: number): string {
  if (days === 0) return "today";
  if (days > 0) return `in ${days} ${days === 1 ? "day" : "days"}`;
  const past = Math.abs(days);
  return `${past} ${past === 1 ? "day" : "days"} ago`;
}

export function complianceRowSignal(item: ComplianceRequirementStatus): ComplianceRowSignal {
  const { state, document, days_until_expiry: days, deficiency, requirement } = item;
  const renewal = item.pending_replacement;

  switch (state) {
    case "met":
      // Deliberately silent — unless a renewal is sitting in the queue behind a
      // certificate that is still good, which is the one thing a satisfied row
      // has to say. Reviewing it is real work, and nothing else reports it.
      return renewal
        ? {
            dotClassName: "bg-success",
            note: "Renewal waiting on your review",
            noteClassName: "text-primary",
            srLabel: "On file, renewal waiting on review",
          }
        : {
            dotClassName: "bg-success",
            note: null,
            noteClassName: "",
            srLabel: "On file",
          };

    case "expiring":
      return renewal
        ? {
            dotClassName: "bg-primary",
            note: "Renewal waiting on your review",
            noteClassName: "text-primary",
            srLabel: "Expiring soon, renewal waiting on review",
          }
        : {
            dotClassName: "bg-warning",
            note: document?.expiry_date
              ? `Expires ${formatDay(document.expiry_date)}${days !== null ? ` · ${relativeDays(days)}` : ""}`
              : "Expiring soon",
            noteClassName: "text-warning",
            srLabel: "Expiring soon",
          };

    case "expired":
      return {
        dotClassName: "bg-destructive",
        note: document?.expiry_date ? `Expired ${formatDay(document.expiry_date)}` : "Expired",
        noteClassName: "text-destructive",
        srLabel: "Expired",
      };

    case "deficient":
      // The one case where the document's own facts matter: it is on file and
      // still does not clear the bar, so the row has to say which bar.
      return {
        dotClassName: "bg-warning",
        note: deficiency?.message ?? "Does not meet the requirement",
        noteClassName: "text-warning",
        srLabel: "Does not meet the requirement",
      };

    case "rejected":
      return {
        dotClassName: "bg-destructive",
        note: document?.rejection_reason
          ? `Sent back — ${document.rejection_reason}`
          : "Sent back to the vendor",
        noteClassName: "text-destructive",
        srLabel: "Sent back",
      };

    case "pending":
      return {
        dotClassName: "bg-primary",
        note: "Waiting on your review",
        noteClassName: "text-primary",
        srLabel: "Waiting on review",
      };

    case "waived":
      return {
        dotClassName: "border border-border bg-transparent",
        note: requirement.waiver?.expires_at
          ? `Waived until ${formatDay(requirement.waiver.expires_at)}`
          : "Waived",
        noteClassName: "text-muted-foreground",
        srLabel: "Waived",
      };

    case "missing":
    default:
      return {
        dotClassName: "border border-destructive/50 bg-transparent",
        note: "Not on file",
        noteClassName: "text-muted-foreground",
        srLabel: "Not on file",
      };
  }
}

/** Which group a requirement is filed under on the tab. */
export function complianceKindLabel(kind: ComplianceDocumentKind): string {
  switch (kind) {
    case "insurance":
      return "Insurance";
    case "tax":
      return "Tax";
    case "license":
      return "Licenses";
    case "safety":
      return "Safety";
    default:
      return "Other";
  }
}

/** Groups render in this order regardless of how types were created. */
export const COMPLIANCE_KIND_ORDER: ComplianceDocumentKind[] = [
  "insurance",
  "tax",
  "license",
  "safety",
  "other",
];

/**
 * The one-line verdict at the top of the tab. Deliberately says whether money is
 * stopped rather than how many documents are outstanding — a builder reading
 * this wants to know if their sub can be paid.
 */
export function complianceHeadline(summary: {
  isCompliant: boolean;
  missing: number;
  expired: number;
  deficient: number;
  /** Documents waiting on a decision, renewals behind a current one included. */
  awaitingReview: number;
  expiring: number;
}): { label: string; className: string } {
  if (!summary.isCompliant) {
    return { label: "Not compliant", className: "border-destructive/40 text-destructive" };
  }
  if (summary.awaitingReview > 0) {
    return { label: "Awaiting review", className: "border-primary/30 text-primary" };
  }
  if (summary.expiring > 0) {
    return { label: "Expiring soon", className: "border-warning/40 text-warning" };
  }
  return { label: "Compliant", className: "border-success/40 text-success" };
}
