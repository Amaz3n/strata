"use client";

import type { LucideIcon } from "lucide-react";
import {
  Activity,
  AlertTriangle,
  Wallet,
  ShieldAlert,
  Clock,
} from "lucide-react";

import type { PortfolioHealth } from "@/lib/services/dashboard";
import { cn } from "@/lib/utils";

type Status = "good" | "warn" | "critical" | "neutral";

type HealthCell = {
  id: string;
  label: string;
  value: string | number;
  status: Status;
  icon: LucideIcon;
  fill?: number;
  sub?: string;
  pulse?: boolean;
};

function formatCompact(cents: number): string {
  const dollars = cents / 100;
  if (dollars >= 1_000_000) return `$${(dollars / 1_000_000).toFixed(1)}M`;
  if (dollars >= 1_000) return `$${(dollars / 1_000).toFixed(0)}K`;
  return `$${Math.round(dollars)}`;
}

const valueText: Record<Status, string> = {
  good: "text-foreground",
  warn: "text-amber-700 dark:text-amber-300",
  critical: "text-rose-700 dark:text-rose-300",
  neutral: "text-foreground",
};

const iconText: Record<Status, string> = {
  good: "text-emerald-600 dark:text-emerald-400",
  warn: "text-amber-600 dark:text-amber-400",
  critical: "text-rose-600 dark:text-rose-400",
  neutral: "text-muted-foreground",
};

const accentBg: Record<Status, string> = {
  good: "bg-emerald-500",
  warn: "bg-amber-500",
  critical: "bg-rose-500",
  neutral: "bg-slate-400",
};

const cellSurface: Record<Status, string> = {
  good: "border-emerald-500/35 bg-gradient-to-br from-emerald-500/18 via-emerald-500/8 to-card",
  warn: "border-amber-500/40 bg-gradient-to-br from-amber-500/20 via-amber-500/9 to-card",
  critical:
    "border-rose-500/40 bg-gradient-to-br from-rose-500/20 via-rose-500/9 to-card",
  neutral:
    "border-slate-400/35 bg-gradient-to-br from-slate-400/16 via-slate-400/8 to-card",
};

export function PortfolioHealthStrip({ data }: { data: PortfolioHealth }) {
  const riskRatio =
    data.activeProjects > 0
      ? Math.min(data.projectsAtRisk / data.activeProjects, 1)
      : 0;

  const items: HealthCell[] = [
    {
      id: "active",
      label: "Live Projects",
      value: data.activeProjects,
      status: data.activeProjects > 0 ? "good" : "neutral",
      icon: Activity,
      pulse: data.activeProjects > 0,
      sub:
        data.projectsAtRisk > 0
          ? `${data.projectsAtRisk} need attention`
          : "All steady",
      fill: 1 - riskRatio,
    },
    {
      id: "risk",
      label: "At Risk",
      value: data.projectsAtRisk,
      status: data.projectsAtRisk > 0 ? "critical" : "good",
      icon: AlertTriangle,
      sub:
        data.activeProjects > 0
          ? `${Math.round(riskRatio * 100)}% of portfolio`
          : "—",
      fill: riskRatio,
    },
    {
      id: "exposure",
      label: "Cash Exposure",
      value: data.cashRiskCents > 0 ? formatCompact(data.cashRiskCents) : "$0",
      status:
        data.cashRiskCents > 500_000
          ? "warn"
          : data.cashRiskCents > 0
            ? "neutral"
            : "good",
      icon: Wallet,
      sub: `AR ${formatCompact(data.overdueARCents)} · Bills ${formatCompact(data.unpaidApprovedBillsCents)}`,
    },
    {
      id: "blockers",
      label: "Blockers",
      value: data.totalBlockers,
      status: data.totalBlockers > 0 ? "critical" : "good",
      icon: ShieldAlert,
      sub: data.totalBlockers > 0 ? "Critical-path threats" : "No blockers",
    },
    {
      id: "due",
      label: "Due in 7 Days",
      value: data.itemsDueNext7Days,
      status:
        data.itemsDueNext7Days > 10
          ? "warn"
          : data.itemsDueNext7Days > 0
            ? "neutral"
            : "good",
      icon: Clock,
      sub:
        data.itemsDueNext7Days > 0 ? "Across all projects" : "Clear week ahead",
    },
  ];

  return (
    <div className="grid gap-px bg-border/70 p-px sm:grid-cols-2 lg:grid-cols-5">
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <div
            key={item.id}
            className={cn(
              "group relative min-h-[100px] overflow-hidden border bg-card px-4 py-3 shadow-sm transition-colors hover:border-foreground/20",
              cellSurface[item.status],
            )}
          >
            <div className="mb-3 flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border/70 bg-background/70">
                  <Icon className={cn("h-3 w-3", iconText[item.status])} />
                </span>
                <span className="truncate text-[11px] font-medium text-muted-foreground">
                  {item.label}
                </span>
              </div>
              {item.pulse ? (
                <span className="relative mt-2 flex h-2 w-2 shrink-0">
                  <span
                    aria-hidden
                    className={cn(
                      "absolute inline-flex h-full w-full animate-ping rounded-full opacity-60",
                      accentBg[item.status],
                    )}
                  />
                  <span
                    aria-hidden
                    className={cn(
                      "relative inline-flex h-2 w-2 rounded-full",
                      accentBg[item.status],
                    )}
                  />
                </span>
              ) : null}
            </div>

            <div className="flex items-end justify-between gap-3">
              <span
                className={cn(
                  "text-2xl font-semibold leading-none tracking-tight tabular-nums",
                  valueText[item.status],
                )}
              >
                {item.value}
              </span>
              {typeof item.fill === "number" ? (
                <span className="text-xs font-medium tabular-nums text-muted-foreground">
                  {Math.round(item.fill * 100)}%
                </span>
              ) : null}
            </div>

            {typeof item.fill === "number" ? (
              <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-background/80">
                <div
                  className={cn(
                    "h-full rounded-full transition-all duration-500",
                    accentBg[item.status],
                  )}
                  style={{ width: `${Math.round(item.fill * 100)}%` }}
                />
              </div>
            ) : null}

            {item.sub ? (
              <p
                className={cn(
                  "mt-2 truncate text-[11px] leading-4 text-muted-foreground",
                  typeof item.fill === "number" ? "min-h-4" : "min-h-4",
                )}
              >
                {item.sub}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
