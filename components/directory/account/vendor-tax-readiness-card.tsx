import Link from "next/link";

import type { VendorTaxReadinessSummary } from "@/lib/services/directory-intelligence";
import type { Company } from "@/lib/types";
import { Section, formatMoneyFromCents } from "@/components/companies/company-detail-ui";
import { cn } from "@/lib/utils";

/**
 * 1099 standing for one vendor.
 *
 * `VendorTaxReadinessSummary` — `requires_1099`, `w9_status`, and the paid total
 * that crosses the threshold — was loaded on both the layout and the overview,
 * and its only consumer was a string inside a tab dot. Nothing showed the TIN,
 * the entity type, or the amount that will land on a 1099 in January, which is
 * the one question a bookkeeper opens a vendor account in Q4 to answer.
 */

const W9_COPY: Record<
  VendorTaxReadinessSummary["w9_status"],
  { label: string; tone: "success" | "warning" | "destructive" | "muted"; detail: string }
> = {
  ready: { label: "On file", tone: "success", detail: "W-9 received and accepted." },
  missing: {
    label: "Missing",
    tone: "destructive",
    detail: "No W-9 on file. Payments may be held and the 1099 cannot be filed.",
  },
  pending_review: {
    label: "In review",
    tone: "warning",
    detail: "A W-9 was received and is waiting on review.",
  },
  rejected: {
    label: "Rejected",
    tone: "destructive",
    detail: "The submitted W-9 was rejected. Request a corrected form.",
  },
  not_required: {
    label: "Not required",
    tone: "muted",
    detail: "This vendor is not 1099-eligible.",
  },
};

function toneClass(tone: "success" | "warning" | "destructive" | "muted") {
  if (tone === "success") return "text-success";
  if (tone === "warning") return "text-warning";
  if (tone === "destructive") return "text-destructive";
  return "text-muted-foreground";
}

export function VendorTaxReadinessCard({
  company,
  taxReadiness,
  complianceHref,
  stagger,
}: {
  company: Company;
  taxReadiness: VendorTaxReadinessSummary | null;
  complianceHref: string;
  stagger?: number;
}) {
  const status = taxReadiness?.w9_status ?? (company.w9_received_at ? "ready" : "missing");
  const copy = W9_COPY[status];
  const requires1099 = taxReadiness?.requires_1099 ?? company.is_1099_eligible ?? false;
  const overThreshold =
    taxReadiness?.threshold_cents != null &&
    taxReadiness.paid_cents >= taxReadiness.threshold_cents;

  return (
    <Section title="Tax" stagger={stagger}>
      <div className="space-y-3 px-4 py-3 text-sm">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-muted-foreground">W-9</span>
          <span className={cn("font-medium", toneClass(copy.tone))}>{copy.label}</span>
        </div>
        <p className="text-xs text-muted-foreground">{copy.detail}</p>

        <div className="flex items-baseline justify-between gap-3">
          <span className="text-muted-foreground">1099 eligible</span>
          <span className="font-medium">{requires1099 ? "Yes" : "No"}</span>
        </div>

        {company.tax_entity_type ? (
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-muted-foreground">Entity type</span>
            <span className="font-medium">{company.tax_entity_type}</span>
          </div>
        ) : null}

        {company.tax_id_last4 ? (
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-muted-foreground">TIN</span>
            {/* Last four only — Arc never stores or shows the full number. */}
            <span className="font-medium tabular-nums">•••• {company.tax_id_last4}</span>
          </div>
        ) : null}

        {taxReadiness ? (
          <div className="border-t pt-3">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-muted-foreground">Paid in {taxReadiness.tax_year}</span>
              <span className="font-medium tabular-nums">
                {formatMoneyFromCents(taxReadiness.paid_cents)}
              </span>
            </div>
            {taxReadiness.threshold_cents != null ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {overThreshold
                  ? `Above the ${formatMoneyFromCents(taxReadiness.threshold_cents)} reporting threshold.`
                  : `Reporting threshold is ${formatMoneyFromCents(taxReadiness.threshold_cents)}.`}
              </p>
            ) : null}
          </div>
        ) : null}

        {status !== "ready" && requires1099 ? (
          <Link
            href={complianceHref}
            className="inline-block text-xs font-medium text-primary underline-offset-4 hover:underline"
          >
            Request a W-9
          </Link>
        ) : null}
      </div>
    </Section>
  );
}
