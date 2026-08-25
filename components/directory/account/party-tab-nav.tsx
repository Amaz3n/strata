"use client";

import { Suspense, use } from "react";

import { cn } from "@/lib/utils";
import type { DirectoryVendorHeaderSignals } from "@/lib/directory/vendor-data";
import {
  OptimisticLink,
  useOptimisticPathname,
} from "@/lib/navigation/optimistic-pathname";

export interface PartyTab {
  label: string;
  href: string;
  exact?: boolean;
  /** Renders a state dot on the tab whose contents need action. */
  attention?: "warning" | "destructive";
  /** Read by screen readers in place of the dot. */
  attentionLabel?: string;
}

function DeferredTabAttention({
  tab,
  signals,
}: {
  tab: PartyTab;
  signals: Promise<DirectoryVendorHeaderSignals>;
}) {
  const value = use(signals);
  let attention: PartyTab["attention"];
  let label: string | undefined;

  if (tab.label === "Transactions" && value.overdueCents > 0) {
    attention = "destructive";
    label = `${value.overdueBillCount} overdue`;
  } else if (tab.label === "Prequalification") {
    if (
      value.prequalificationStatus === "submitted" ||
      value.prequalificationStatus === "under_review"
    ) {
      attention = "destructive";
      label = "Awaiting your review";
    } else if (value.prequalificationStatus === "expired") {
      attention = "warning";
      label = "Expired";
    }
  } else if (tab.label === "Compliance") {
    const severe = value.complianceMissing > 0 || value.complianceExpired > 0;
    if (value.complianceReady === false || value.w9NeedsAction) {
      attention = severe ? "destructive" : "warning";
      label = [
        value.complianceMissing > 0 ? `${value.complianceMissing} missing` : null,
        value.complianceExpired > 0 ? `${value.complianceExpired} expired` : null,
        value.complianceExpiringSoon > 0
          ? `${value.complianceExpiringSoon} expiring`
          : null,
        value.w9NeedsAction ? `W-9 ${value.w9Status}` : null,
      ]
        .filter(Boolean)
        .join(", ");
    }
  }

  if (!attention) return null;
  return (
    <>
      <span
        aria-hidden
        className={cn(
          "h-1.5 w-1.5 shrink-0 rounded-full",
          attention === "destructive" ? "bg-destructive" : "bg-warning",
        )}
      />
      <span className="sr-only">{label ?? "Needs attention"}</span>
    </>
  );
}

export function PartyTabNav({
  tabs,
  vendorSignals,
}: {
  tabs: PartyTab[];
  vendorSignals?: Promise<DirectoryVendorHeaderSignals>;
}) {
  // The provider publishes the destination on the click frame. The real
  // pathname only changes after the server result commits, which made the old
  // tab remain selected throughout the very wait this navigation is meant to
  // hide. Ignore search/hash state because it does not change the active tab.
  const pathname = useOptimisticPathname().split(/[?#]/, 1)[0] ?? "";

  return (
    <nav
      aria-label="Account sections"
      className="flex min-w-0 gap-0.5 overflow-x-auto px-3 py-1.5 [scrollbar-width:none] sm:px-5 [&::-webkit-scrollbar]:hidden"
    >
      {tabs.map((tab) => {
        const active = tab.exact
          ? pathname === tab.href
          : pathname === tab.href || pathname.startsWith(`${tab.href}/`);
        return (
          <OptimisticLink
            key={tab.href}
            href={tab.href}
            /*
              Full prefetch, from viewport entry, not on hover: the App Shell
              alone leaves every tab's `params`-dependent content to resolve
              after the click, which is what put a skeleton in front of each
              switch. There are at most eight of these and they are the single
              hottest path on the account, so they are worth resolving ahead of
              a pointer that has not arrived yet — a keyboard or touch user gets
              no hover to warm on.
            */
            prefetch
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex h-8 shrink-0 items-center gap-1.5 border px-2.5 text-xs font-medium outline-none transition-[background-color,border-color,color,box-shadow] focus-visible:ring-1 focus-visible:ring-ring",
              active
                ? "border-foreground bg-foreground text-background shadow-[0_1px_0_rgba(0,0,0,0.08)]"
                : "border-transparent text-muted-foreground hover:border-border/70 hover:bg-background/80 hover:text-foreground",
            )}
          >
            {tab.label}
            {tab.attention ? (
              <>
                <span
                  aria-hidden
                  className={cn(
                    "h-1.5 w-1.5 shrink-0 rounded-full",
                    tab.attention === "destructive" ? "bg-destructive" : "bg-warning",
                  )}
                />
                <span className="sr-only">{tab.attentionLabel ?? "Needs attention"}</span>
              </>
            ) : null}
            {vendorSignals ? (
              <Suspense fallback={null}>
                <DeferredTabAttention tab={tab} signals={vendorSignals} />
              </Suspense>
            ) : null}
          </OptimisticLink>
        );
      })}
    </nav>
  );
}
