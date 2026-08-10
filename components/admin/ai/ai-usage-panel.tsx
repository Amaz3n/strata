"use client"

import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { AiUsageBucket, AiUsageReport } from "@/lib/services/ai/usage-reporting"

import { compact, money } from "./format"

/**
 * What the AI did, and what it cost.
 *
 * The unpriced count stays prominent everywhere: a model with no recorded rate
 * contributes nothing to a total, so a panel that hid that would read as "AI is
 * cheap" when it means "we do not know".
 */

export function AiUsagePanel({ usage }: { usage: AiUsageReport }) {
  if (usage.totals.calls === 0) {
    return (
      <div className="py-16 text-center">
        <p className="text-sm font-medium">No AI calls in the last {usage.windowDays} days</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Usage appears here as soon as a scan, search or drawing job runs.
        </p>
      </div>
    )
  }

  const peakCalls = Math.max(...usage.daily.map((point) => point.calls), 1)
  const peakCost = Math.max(...usage.daily.map((point) => point.costUsd), 0.0001)

  return (
    <div className="space-y-6 py-4">
      {usage.truncated ? (
        <div className="mx-4 border border-warning/40 bg-warning/5 px-3 py-2">
          <p className="text-xs text-warning">
            Only the most recent 50,000 calls were scanned — every total below understates the window.
          </p>
        </div>
      ) : null}

      <section className="space-y-2 px-4">
        <div className="flex items-baseline justify-between">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Daily</h3>
          <span className="text-[11px] text-muted-foreground">
            bar height = calls · fill = spend · {money(peakCost)} peak day
          </span>
        </div>
        <div className="flex h-24 items-end gap-px border-b">
          {usage.daily.map((point) => (
            <Tooltip key={point.date}>
              <TooltipTrigger asChild>
                <div
                  className="relative flex-1 cursor-default bg-muted transition-colors hover:bg-accent"
                  style={{ height: `${Math.max(4, (point.calls / peakCalls) * 100)}%` }}
                >
                  <div
                    className="absolute inset-x-0 bottom-0 bg-chart-1"
                    style={{ height: `${Math.min(100, (point.costUsd / peakCost) * 100)}%` }}
                  />
                  {point.errors > 0 ? (
                    <div className="absolute inset-x-0 top-0 h-0.5 bg-destructive" />
                  ) : null}
                </div>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs">
                <span className="font-medium">{point.date}</span> · {compact(point.calls)} calls ·{" "}
                {money(point.costUsd)}
                {point.errors > 0 ? ` · ${point.errors} errors` : ""}
              </TooltipContent>
            </Tooltip>
          ))}
        </div>
      </section>

      <div className="grid gap-6 px-4 lg:grid-cols-2">
        <BucketList title="By feature" buckets={usage.byFeature} />
        <BucketList title="By tier" buckets={usage.byTier} />
        <BucketList title="By model" buckets={usage.byModel} />
        <BucketList title="By organization" buckets={usage.byOrg} />
      </div>

      {usage.recentErrors.length > 0 ? (
        <section className="space-y-2 px-4">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Recent failures
          </h3>
          <div className="divide-y border">
            {usage.recentErrors.map((entry, index) => (
              <div
                key={`${entry.createdAt}-${index}`}
                className="flex items-center justify-between gap-3 px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm">{entry.feature}</p>
                  <p className="truncate font-mono text-[11px] text-muted-foreground">
                    {entry.model} · {entry.tier}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-[11px] text-muted-foreground">
                    {new Date(entry.createdAt).toLocaleString()}
                  </span>
                  <Badge variant="outline" className="rounded-none text-destructive">
                    {entry.errorKind ?? "error"}
                  </Badge>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  )
}

/** Ranked share, so the row that owns the spend is obvious without reading numbers. */
function BucketList({ title, buckets }: { title: string; buckets: AiUsageBucket[] }) {
  if (buckets.length === 0) return null

  const ranked = [...buckets].sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls).slice(0, 8)
  const peak = Math.max(...ranked.map((bucket) => bucket.costUsd), 0.0001)

  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
        {buckets.length > ranked.length ? (
          <span className="text-[11px] text-muted-foreground">
            top {ranked.length} of {buckets.length}
          </span>
        ) : null}
      </div>
      <div className="divide-y border">
        {ranked.map((bucket) => (
          <div key={bucket.key} className="relative px-3 py-2">
            <div
              className="absolute inset-y-0 left-0 bg-muted"
              style={{ width: `${Math.max(1, (bucket.costUsd / peak) * 100)}%` }}
              aria-hidden
            />
            <div className="relative flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm">{bucket.label}</p>
                <p className="text-[11px] text-muted-foreground">
                  {compact(bucket.calls)} calls · p95 {(bucket.p95LatencyMs / 1000).toFixed(1)}s
                  {bucket.errors > 0 ? (
                    <span className="text-destructive"> · {bucket.errors} errors</span>
                  ) : null}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p className={cn("text-sm tabular-nums", bucket.unpricedCalls > 0 && "text-warning")}>
                  {money(bucket.costUsd)}
                </p>
                {bucket.unpricedCalls > 0 ? (
                  <p className="text-[11px] text-warning">+{compact(bucket.unpricedCalls)} unpriced</p>
                ) : null}
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
