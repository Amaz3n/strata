"use client";

import { useEffect, useState, useTransition } from "react";
import {
  listBidAddendaAction,
  listBidPackageActivityAction,
} from "@/app/(app)/bids/actions";
import {
  activityActor,
  activityLabel,
} from "@/components/bids/bid-workbench-helpers";
import { FileText, Mail, Check, Clock } from "lucide-react";
import type { BidActivityItem, BidAddendum } from "@/lib/services/bids";
import { retryPricingNoticeAction } from "@/app/(app)/pipeline/[dealId]/pricing-actions";
import { unwrapAction } from "@/lib/action-result";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

export function PricingBidActivity({ packageId, prospectId, editable = false }: { packageId: string; prospectId?: string; editable?: boolean }) {
  const [pending, startTransition] = useTransition();
  const [data, setData] = useState<{
    addenda: BidAddendum[];
    activity: BidActivityItem[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    Promise.all([
      listBidAddendaAction(packageId),
      listBidPackageActivityAction(packageId),
    ])
      .then(([addenda, activity]) => {
        if (active) {
          setData({ addenda, activity });
          setError(null);
        }
      })
      .catch(() => {
        if (active) setError("Unable to load request activity.");
      });
    return () => {
      active = false;
    };
  }, [packageId, attempt]);
  if (error)
    return (
      <p role="alert" className="text-sm">
        {error}{" "}
        <Button variant="link" onClick={() => setAttempt((value) => value + 1)}>
          Retry
        </Button>
      </p>
    );
  if (!data)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading activity…
      </p>
    );
  const entries = [
    ...data.addenda.map((item) => ({
      id: item.id,
      title: `Addendum ${item.number}${item.title ? ` · ${item.title}` : ""}`,
      detail: item.message ?? "",
      date: item.issued_at,
      kind: "addendum",
    })),
    ...data.activity
      .filter((item) => item.event_type !== "bid_addendum_created")
      .map((item) => ({
        id: item.id,
        title: activityLabel(item.event_type),
        detail: activityActor(item.payload) ?? "",
        date: item.created_at,
        kind: item.event_type,
      })),
  ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  if (!entries.length)
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        Activity will appear here as bidders respond and the request changes.
      </p>
    );
  return (
    <ol aria-label="Bid request timeline" className="pt-2">
      {entries.map((entry, index) => {
        const Icon =
          entry.kind === "addendum"
            ? FileText
            : entry.kind.includes("invite")
              ? Mail
              : entry.kind.includes("submission")
                ? Check
                : Clock;
        return (
          <li key={entry.id} className="relative flex gap-3 pb-7 last:pb-0">
            {index < entries.length - 1 && (
              <span
                aria-hidden
                className="absolute bottom-0 left-3 top-6 w-px bg-border"
              />
            )}
            <span className="relative flex size-6 shrink-0 items-center justify-center rounded-full border bg-background text-muted-foreground">
              <Icon className="size-3" />
            </span>
            <div className="min-w-0 flex-1 pt-0.5">
              <p className="text-sm font-medium">{entry.title}</p>
              <time
                dateTime={entry.date}
                className="mt-1 block text-xs text-muted-foreground"
              >
                {new Date(entry.date).toLocaleString(undefined, {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </time>
              {entry.kind === "addendum" && editable && prospectId && (
                <Button size="sm" variant="link" className="mt-1 h-auto px-0 text-xs" disabled={pending} onClick={() => startTransition(async () => {
                  try {
                    const result = unwrapAction(await retryPricingNoticeAction(prospectId, packageId, entry.id));
                    if (result.failed.length) toast.error(result.failed.map(item => `${item.recipient}: ${item.error}`).join("\n"));
                    else toast.success(`${result.queued.length} notifications queued; ${result.alreadyQueued.length} already queued or sent.`);
                  } catch (cause) { toast.error(cause instanceof Error ? cause.message : "Unable to retry notifications."); }
                })}>Retry missing bidder notifications</Button>
              )}
              {entry.detail && (
                <p className="mt-2 whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground">
                  {entry.detail}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
