"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

export interface CompanyTab {
  label: string;
  href: string;
  exact?: boolean;
  /** Renders a state dot on the tab whose contents need action. */
  attention?: "warning" | "destructive";
  /** Read by screen readers in place of the dot. */
  attentionLabel?: string;
}

export function CompanyTabNav({ tabs }: { tabs: CompanyTab[] }) {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Company sections"
      className="flex gap-4 overflow-x-auto px-4 sm:px-6"
    >
      {tabs.map((tab) => {
        const active = tab.exact
          ? pathname === tab.href
          : pathname === tab.href || pathname.startsWith(`${tab.href}/`);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "-mb-px flex shrink-0 items-center gap-1.5 border-b-2 py-2.5 text-sm transition-colors",
              active
                ? "border-foreground font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
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
          </Link>
        );
      })}
    </nav>
  );
}
