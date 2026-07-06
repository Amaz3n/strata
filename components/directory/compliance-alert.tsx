"use client";

import { useMemo, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  AlertTriangle,
  ChevronRight,
  Shield,
  ShieldCheck,
} from "@/components/icons";
import type { Company, ComplianceStatusSummary } from "@/lib/types";

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
  company: Company,
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

export function ComplianceAlert({
  companies,
  complianceStatusByCompanyId,
}: {
  companies: Company[];
  complianceStatusByCompanyId: Record<string, ComplianceStatusSummary>;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const watchItems = useMemo(
    () =>
      companies
        .filter(
          (company) =>
            company.company_type === "subcontractor" ||
            company.company_type === "supplier",
        )
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

  if (watchItems.length === 0) return null;

  // Urgent = anything missing, expired, or a live deficiency (needs chasing now).
  const urgentCount = watchItems.filter(
    (item) =>
      item.missingCount > 0 ||
      item.expiredCount > 0 ||
      item.deficiencyCount > 0,
  ).length;

  const vendorNoun = watchItems.length === 1 ? "vendor" : "vendors";

  const openCompany = (companyId: string) => {
    setOpen(false);
    router.push(`/companies/${companyId}?tab=compliance`);
  };

  return (
    <>
      <div className="shrink-0 border-b border-warning/30 bg-warning/10 px-4 py-2.5">
        <div className="flex items-center gap-3">
          <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
          <div className="min-w-0 flex-1 text-sm">
            <span className="font-medium text-foreground">
              {watchItems.length} {vendorNoun} need
              {watchItems.length === 1 ? "s" : ""} compliance attention
            </span>
            {urgentCount > 0 ? (
              <span className="text-muted-foreground">
                {" · "}
                {urgentCount} urgent
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

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          mobileFullscreen
          className="sm:max-w-lg sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] shadow-2xl flex flex-col fast-sheet-animation"
          style={
            {
              animationDuration: "150ms",
              transitionDuration: "150ms",
            } as CSSProperties
          }
        >
          <div className="flex-1 overflow-y-auto px-4">
            <div className="pt-6 pb-4">
              <SheetTitle className="flex items-center gap-2 text-lg font-semibold leading-none tracking-tight">
                <Shield className="h-4 w-4 text-warning" />
                Compliance review
              </SheetTitle>
              <SheetDescription className="mt-1.5 text-sm text-muted-foreground">
                Subcontractors and suppliers with missing, expired, or expiring
                documents. Ranked by urgency.
              </SheetDescription>
            </div>

            <div className="space-y-2 pb-4">
              {watchItems.map((item) => (
                <button
                  key={item.companyId}
                  type="button"
                  onClick={() => openCompany(item.companyId)}
                  className="flex w-full items-center gap-3 rounded-lg border bg-card px-3 py-3 text-left transition-colors hover:bg-muted/50"
                >
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="truncate font-medium">
                      {item.companyName}
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {item.missingCount > 0 ? (
                        <Badge variant="destructive">
                          {item.missingCount} missing
                        </Badge>
                      ) : null}
                      {item.expiredCount > 0 ? (
                        <Badge variant="destructive">
                          {item.expiredCount} expired
                        </Badge>
                      ) : null}
                      {item.deficiencyCount > 0 ? (
                        <Badge variant="destructive">
                          {item.deficiencyCount} updates needed
                        </Badge>
                      ) : null}
                      {item.pendingCount > 0 ? (
                        <Badge variant="secondary">
                          {item.pendingCount} pending review
                        </Badge>
                      ) : null}
                      {item.expiringSoonCount > 0 ? (
                        <Badge variant="outline">
                          {item.expiringSoonCount} expiring soon
                        </Badge>
                      ) : null}
                    </div>
                  </div>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                </button>
              ))}
            </div>
          </div>

          <div className="flex-shrink-0 border-t bg-background p-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <ShieldCheck className="h-3.5 w-3.5" />
              Open a vendor to upload documents or waive requirements.
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
