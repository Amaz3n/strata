"use client";

import Link from "next/link";

import type { WatchlistProject } from "@/lib/services/dashboard";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

const signalStyles: Record<"warn" | "critical" | "ok", string> = {
  ok: "border-muted bg-muted text-muted-foreground",
  warn: "border-chart-4/35 bg-chart-4/15 text-foreground",
  critical: "border-destructive/35 bg-destructive/15 text-foreground",
};

export function Watchlist({ projects }: { projects: WatchlistProject[] }) {
  const criticalCount = projects.filter((project) =>
    project.signals.some((signal) => signal.status === "critical"),
  ).length;
  const warningCount = projects.filter(
    (project) =>
      !project.signals.some((signal) => signal.status === "critical") &&
      project.signals.some((signal) => signal.status === "warn"),
  ).length;
  const topRisk = projects.reduce(
    (max, project) => Math.max(max, project.riskScore),
    0,
  );

  return (
    <section className="border-b border-border/70 bg-card">
      <header className="border-b border-border/70 bg-gradient-to-r from-destructive/10 via-card to-chart-4/10 px-4 py-4 sm:px-6">
        <div className="flex items-end justify-between gap-3">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
              Active Radar
            </p>
            <h2 className="text-lg font-semibold tracking-tight">Watchlist</h2>
          </div>
          <Badge variant="outline" className="bg-background/70">
            {projects.length} flagged
          </Badge>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2">
          <div className="rounded-md border border-border/70 bg-background/70 px-3 py-2">
            <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Critical
            </p>
            <p className="text-lg font-semibold tabular-nums text-destructive">
              {criticalCount}
            </p>
          </div>
          <div className="rounded-md border border-border/70 bg-background/70 px-3 py-2">
            <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Warning
            </p>
            <p className="text-lg font-semibold tabular-nums">{warningCount}</p>
          </div>
          <div className="rounded-md border border-border/70 bg-background/70 px-3 py-2">
            <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              Top risk
            </p>
            <p className="text-lg font-semibold tabular-nums">{topRisk}</p>
          </div>
        </div>
      </header>

      <div className="px-4 py-3 sm:px-6">
        <Table>
          <TableHeader className="bg-muted/35">
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-[72px] text-muted-foreground">
                Rank
              </TableHead>
              <TableHead className="text-muted-foreground">Project</TableHead>
              <TableHead className="w-[96px] text-right text-muted-foreground">
                Risk
              </TableHead>
              <TableHead className="w-[220px] text-right text-muted-foreground">
                Signals
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {projects.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={4}
                  className="h-24 text-center text-muted-foreground"
                >
                  All projects steady
                </TableCell>
              </TableRow>
            ) : (
              projects.map((project, index) => {
                const hasCritical = project.signals.some(
                  (signal) => signal.status === "critical",
                );
                const activeSignals = project.signals.filter(
                  (signal) => signal.status !== "ok",
                );

                return (
                  <TableRow
                    key={project.id}
                    className={cn(
                      "group border-border/60",
                      hasCritical
                        ? "bg-destructive/[0.035] hover:bg-destructive/[0.075]"
                        : "hover:bg-accent/35",
                    )}
                  >
                    <TableCell className="relative text-muted-foreground tabular-nums">
                      <span
                        aria-hidden
                        className={cn(
                          "absolute inset-y-2 left-0 w-1 rounded-r-full",
                          hasCritical ? "bg-destructive" : "bg-chart-4",
                        )}
                      />
                      {String(index + 1).padStart(2, "0")}
                    </TableCell>
                    <TableCell className="min-w-0">
                      <Link
                        href={`/projects/${project.id}`}
                        className="block min-w-0 hover:underline"
                      >
                        <span className="block truncate font-medium">
                          {project.name}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {hasCritical
                            ? "Critical signal present"
                            : "Needs monitoring"}
                        </span>
                      </Link>
                    </TableCell>
                    <TableCell
                      className={cn(
                        "text-right font-semibold tabular-nums",
                        hasCritical
                          ? "text-destructive"
                          : "text-muted-foreground",
                      )}
                    >
                      {project.riskScore}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        {activeSignals.map((signal) => (
                          <Badge
                            key={signal.key}
                            variant="outline"
                            className={cn(
                              "font-medium uppercase",
                              signalStyles[signal.status],
                            )}
                          >
                            {signal.key}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}
