"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type {
  BidPackage,
  BidScopeItem,
  BidSubmission,
} from "@/lib/services/bids";
import { bidEligibilityReason } from "@/lib/bids/pricing";
import { computeSubmissionTotals } from "@/lib/bids/leveling";
import { money } from "@/lib/precon/format";

export function PricingBidComparison({
  pkg,
  scope,
  submissions,
  selectedId,
  onReview,
}: {
  pkg: BidPackage;
  scope: BidScopeItem[];
  submissions: BidSubmission[];
  selectedId?: string;
  onReview: (id: string) => void;
}) {
  const current = submissions.filter((bid) => bid.is_current);
  const row = (
    label: string,
    value: (bid: BidSubmission) => ReactNode,
    key = label,
  ) => (
    <tr key={key} className="border-b last:border-0">
      <th className="md:sticky md:left-0 md:z-10 w-32 min-w-32 md:w-44 md:min-w-44 bg-background px-4 py-3 text-left font-medium">
        {label}
      </th>
      {current.map((bid) => (
        <td
          key={bid.id}
          className="min-w-56 max-w-72 whitespace-pre-wrap break-words px-4 py-3 align-top"
        >
          {value(bid)}
        </td>
      ))}
    </tr>
  );
  return (
    <div role="region" aria-label="Bid comparison; scroll horizontally for more bidders" tabIndex={0} className="max-w-full overflow-x-auto border">
      <table className="w-full text-xs">
        <caption className="sr-only">Compare current bid submissions</caption>
        <thead>
          <tr className="border-b bg-muted/30">
            <th className="md:sticky md:left-0 md:z-10 bg-background px-4 py-3 text-left font-medium">
              Bid comparison
            </th>
            {current.map((bid) => (
              <th
                key={bid.id}
                className="min-w-56 max-w-72 px-4 py-3 text-left align-top font-medium"
              >
                <p className="break-words">
                  {bid.invite?.company?.name ??
                    bid.submitted_by_name ??
                    bid.invite?.invite_email ??
                    "Trade quote"}
                </p>
                <p className="mt-1 font-normal text-muted-foreground">
                  {selectedId === bid.id
                    ? "Used in estimate"
                    : `Submission ${bid.version}`}
                </p>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {row("Submitted price", (bid) =>
            bid.total_cents == null ? (
              "Not provided"
            ) : (
              <span className="text-sm font-medium tabular-nums">
                {money(bid.total_cents)}
              </span>
            ),
          )}
          {row("Comparison adjustments", (bid) => {
            const total = computeSubmissionTotals(bid, scope);
            return money(total.plugs + total.lump);
          })}
          {row("Adjusted comparison total", (bid) =>
            bid.total_cents == null
              ? "—"
              : money(computeSubmissionTotals(bid, scope).leveled),
          )}
          {scope.map((item) =>
            row(
              item.description,
              (bid) => {
                const response = bid.items?.find(
                  (entry) => entry.bid_scope_item_id === item.id,
                );
                if (!response) return "Not itemized";
                return (
                  <>
                    <span>
                      {response.response === "priced"
                        ? response.notes === "Included in vendor lump sum"
                          ? "Included in lump sum"
                          : money(response.amount_cents ?? 0)
                        : response.response.replaceAll("_", " ")}
                    </span>
                    {response.notes &&
                      response.notes !== "Included in vendor lump sum" && (
                        <p className="mt-1 text-muted-foreground">
                          {response.notes}
                        </p>
                      )}
                  </>
                );
              },
              item.id,
            ),
          )}
          {row("Exclusions", (bid) => bid.exclusions || "None stated")}
          {row("Clarifications", (bid) => bid.clarifications || "None stated")}
          {row("Lead time", (bid) =>
            bid.lead_time_days == null
              ? "Not provided"
              : `${bid.lead_time_days} days`,
          )}
          {row("Duration", (bid) =>
            bid.duration_days == null
              ? "Not provided"
              : `${bid.duration_days} days`,
          )}
          {row(
            "Available from",
            (bid) => bid.start_available_on?.slice(0, 10) || "Not provided",
          )}
          {row(
            "Valid until",
            (bid) => bid.valid_until?.slice(0, 10) || "Not provided",
          )}
          {row("Scope revision", (bid) => (
            <>
              <span>Revision {bid.scope_revision ?? 1}</span>
              <p className="mt-1 text-muted-foreground">
                {bidEligibilityReason(bid, pkg.scope_revision) ??
                  "Current scope"}
              </p>
            </>
          ))}
          {row("Review", (bid) => (
            <Button
              size="sm"
              variant="outline"
              onClick={() => onReview(bid.id)}
            >
              Review quote
            </Button>
          ))}
        </tbody>
      </table>
    </div>
  );
}
