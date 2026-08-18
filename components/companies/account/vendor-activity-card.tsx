import Link from "next/link";

import type { VendorAccountAging, VendorLedgerEntry } from "@/lib/services/vendor-account";
import { Button } from "@/components/ui/button";
import { EmptyState, Section, formatMoneyFromCents } from "@/components/companies/company-detail-ui";
import { VendorLedgerTable } from "@/components/companies/account/vendor-ledger-table";
import { cn } from "@/lib/utils";

const AGING_SEGMENTS: { key: keyof VendorAccountAging; label: string; className: string }[] = [
  { key: "current", label: "Current", className: "bg-chart-1" },
  { key: "1_30", label: "1–30", className: "bg-age-0" },
  { key: "31_60", label: "31–60", className: "bg-age-1" },
  { key: "61_90", label: "61–90", className: "bg-age-2" },
  { key: "90_plus", label: "90+", className: "bg-destructive" },
  { key: "no_due_date", label: "No due date", className: "bg-muted-foreground/40" },
];

/**
 * What is owed and how it got that way, as one unit: the aging of the open
 * balance reads directly above the transactions that produced it.
 */
export function VendorActivityCard({
  companyId,
  aging,
  entries,
  canViewBills,
  stagger = 1,
}: {
  companyId: string;
  aging: VendorAccountAging | null;
  entries: VendorLedgerEntry[];
  canViewBills: boolean;
  stagger?: number;
}) {
  const segments = aging
    ? AGING_SEGMENTS.filter((segment) => aging[segment.key] > 0)
    : [];
  const total = aging
    ? AGING_SEGMENTS.reduce((sum, segment) => sum + aging[segment.key], 0)
    : 0;

  return (
    <Section
      title="Activity"
      stagger={stagger}
      action={
        <Button asChild variant="ghost" size="sm" className="-mr-2 h-8">
          <Link href={`/directory/${companyId}/transactions`}>View all</Link>
        </Button>
      }
    >
      {canViewBills && aging ? (
        <div className="border-b px-4 py-3">
          {total > 0 ? (
            <>
              <div className="flex h-1.5 w-full overflow-hidden">
                {segments.map((segment) => (
                  <div
                    key={segment.key}
                    className={segment.className}
                    style={{ width: `${(aging[segment.key] / total) * 100}%` }}
                  />
                ))}
              </div>
              <div className="mt-2.5 flex flex-wrap gap-x-5 gap-y-1.5">
                {segments.map((segment) => (
                  <div key={segment.key} className="flex items-center gap-1.5 text-xs">
                    <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", segment.className)} />
                    <span className="text-muted-foreground">{segment.label}</span>
                    <span className="font-mono font-medium tabular-nums">
                      {formatMoneyFromCents(aging[segment.key])}
                    </span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              Nothing outstanding — this vendor is fully paid up.
            </p>
          )}
        </div>
      ) : null}

      {canViewBills ? (
        <VendorLedgerTable entries={entries} limit={12} showFilters={false} />
      ) : (
        <EmptyState>Transaction history requires payables access.</EmptyState>
      )}
    </Section>
  );
}
