import Link from "next/link";

import type { VendorAccountLedger, VendorAccountSummary } from "@/lib/services/vendor-account";
import { formatMoneyFromCents } from "@/components/companies/company-detail-ui";
import { cn } from "@/lib/utils";

/**
 * What this vendor account actually is, in money, above the register that
 * explains it.
 *
 * Every figure here was already computed on each ledger build and then thrown
 * away: the transactions tab never received `ledger.summary`, and the overview
 * read only aging and the last payment date. Retainage held, open credits and
 * paid-YTD — the three numbers a bookkeeper opens a vendor to find — were
 * calculated on every request and rendered nowhere.
 */

interface Metric {
  label: string;
  value: string;
  hint?: string;
  tone?: "default" | "warning" | "destructive" | "success";
  href?: string;
}

function toneClass(tone: Metric["tone"]) {
  if (tone === "destructive") return "text-destructive";
  if (tone === "warning") return "text-warning";
  if (tone === "success") return "text-success";
  return "text-foreground";
}

export function VendorAccountSummaryStrip({
  companyId,
  summary,
  accounting,
  books,
  truncated = false,
}: {
  companyId: string;
  summary: VendorAccountSummary;
  accounting?: VendorAccountLedger["accounting"];
  books?: VendorAccountLedger["books"];
  truncated?: boolean;
}) {
  // Without bill.read every money field reads zero, and a row of zeros would be
  // a false statement about the account rather than a withheld one.
  if (!summary.can_view_bills) {
    return (
      <div className="border-b bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
        Balances are hidden — viewing them needs permission to see bills.
      </div>
    );
  }

  const metrics: Metric[] = [
    {
      label: "Open",
      value: formatMoneyFromCents(summary.open_cents),
      hint:
        summary.open_bill_count > 0
          ? `${summary.open_bill_count} ${summary.open_bill_count === 1 ? "bill" : "bills"}`
          : "Nothing outstanding",
      href: summary.open_cents > 0 ? `/payables?q=${companyId}` : undefined,
    },
    {
      label: "Overdue",
      value: formatMoneyFromCents(summary.overdue_cents),
      hint:
        summary.overdue_bill_count > 0
          ? `${summary.overdue_bill_count} past due`
          : "On time",
      tone: summary.overdue_cents > 0 ? "destructive" : "default",
      href:
        summary.overdue_cents > 0
          ? `/directory/${companyId}/transactions?filter=overdue`
          : undefined,
    },
    {
      label: "Retainage held",
      value: formatMoneyFromCents(summary.retainage_held_cents),
      hint: summary.retainage_held_cents > 0 ? "Withheld to date" : "None withheld",
      tone: summary.retainage_held_cents > 0 ? "warning" : "default",
    },
    {
      label: "Open credits",
      value: formatMoneyFromCents(summary.credit_open_cents),
      hint: summary.credit_open_cents > 0 ? "Unapplied" : "None",
      tone: summary.credit_open_cents > 0 ? "success" : "default",
      href:
        summary.credit_open_cents > 0
          ? `/directory/${companyId}/transactions?kind=vendor_credit`
          : undefined,
    },
    {
      label: "Paid YTD",
      value: formatMoneyFromCents(summary.paid_ytd_cents),
      hint: summary.last_payment_date
        ? `Last ${new Date(summary.last_payment_date).toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
          })}`
        : "No payments yet",
    },
  ];

  return (
    <div className="border-b bg-background">
      <div className="grid grid-cols-2 divide-x divide-y sm:grid-cols-3 lg:grid-cols-5 lg:divide-y-0">
        {metrics.map((metric) => {
          const body = (
            <>
              <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {metric.label}
              </div>
              <div
                className={cn(
                  "mt-1 text-lg font-semibold tabular-nums",
                  toneClass(metric.tone),
                )}
              >
                {metric.value}
              </div>
              <div className="mt-0.5 truncate text-xs text-muted-foreground">{metric.hint}</div>
            </>
          );
          return metric.href ? (
            <Link
              key={metric.label}
              href={metric.href}
              className="block px-4 py-3 transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              {body}
            </Link>
          ) : (
            <div key={metric.label} className="px-4 py-3">
              {body}
            </div>
          );
        })}
      </div>

      {(truncated || books?.ledger_authority === "external" || accounting) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t px-4 py-2 text-xs text-muted-foreground">
          {books?.ledger_authority === "external" ? (
            <span>
              {/* A vendor whose books live elsewhere gave no indication of it, so
                  a balance that disagreed with the accounting system looked like
                  an Arc bug rather than a different source of truth. */}
              Books of record:{" "}
              <span className="font-medium text-foreground">
                {accounting?.provider_name ?? "external accounting"}
              </span>
              {accounting?.external_name ? ` · ${accounting.external_name}` : null}
            </span>
          ) : accounting ? (
            <span>
              Linked to {accounting.provider_name}
              {accounting.external_name ? ` · ${accounting.external_name}` : null}
              {accounting.last_synced_at
                ? ` · synced ${new Date(accounting.last_synced_at).toLocaleDateString()}`
                : null}
            </span>
          ) : null}
          {truncated ? (
            <span className="text-warning">
              Some sources hit their row cap — totals may undercount.
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
}
